/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import express, { type Response } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionService } from '@qwen-code/qwen-code-core';
import { parseLineTolerantWithIntegrity } from '@qwen-code/qwen-code-core/utils/jsonl-utils.js';
import {
  appendPromptLedgerRecord,
  type PromptLedgerRecord,
} from '@qwen-code/acp-bridge/promptLedger';
import {
  SessionArchivingError,
  SessionNotFoundError,
  type AcpSessionBridge,
} from '../acp-session-bridge.js';
import { DaemonDrainingError } from '../server/session-archive.js';
import { RequestedSessionIdAdmissionError } from '../session-id-admission.js';
import {
  createWorkspaceRegistry,
  type WorkspaceRuntime,
} from '../workspace-registry.js';
import type { WorkspaceFileSystemFactory } from '../fs/index.js';

const restoreMocks = vi.hoisted(() => ({
  restoreSessionCore: vi.fn(),
}));

vi.mock('../server/session-restore.js', () => ({
  restoreSessionCore: restoreMocks.restoreSessionCore,
}));

import { registerSessionRoutes } from './session.js';

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

interface Fixture {
  runtime: WorkspaceRuntime;
  bridge: AcpSessionBridge;
  app: express.Express;
  registry: ReturnType<typeof createWorkspaceRegistry>;
  sessionService: SessionService;
  sessionId: string;
  lockDepth: () => number;
  runSharedMany: ReturnType<typeof vi.fn>;
  seed(
    records: readonly PromptLedgerRecord[],
    sessionId?: string,
    sourceType?: string,
  ): void;
}

function makeFixture(trusted = true, primary = true): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), 'restart-recovery-continue-'));
  roots.push(root);
  const workspaceDir = path.join(root, 'workspace');
  const runtimeBaseDir = path.join(root, 'runtime');
  mkdirSync(workspaceDir, { recursive: true });
  const sessionId = randomUUID();
  const sessionService = new SessionService(workspaceDir, { runtimeBaseDir });
  const bridge = {
    getSessionSummary: vi.fn(() => {
      throw new SessionNotFoundError(sessionId);
    }),
    getSessionContextStatus: vi.fn(async () => ({
      sessionId,
      recovery: { kind: 'interrupted_prompt' as const, canContinue: true },
      state: {},
    })),
    detachClient: vi.fn(async () => {}),
    continueSession: vi.fn(async () => ({
      accepted: true,
      interruption: 'interrupted_prompt' as const,
      promptId: 'prompt-1',
    })),
  } as unknown as AcpSessionBridge;
  const runtime = {
    workspaceId: randomUUID(),
    workspaceCwd: workspaceDir,
    sessionRuntimeBaseDir: runtimeBaseDir,
    primary,
    trusted,
    bridge,
    routeFileSystemFactory: {
      forRequest: vi.fn(),
      assertCanWrite: vi.fn(),
    } as WorkspaceFileSystemFactory,
  } as WorkspaceRuntime;
  let lockDepth = 0;
  const runSharedMany = vi.fn(
    async (_sessionIds: string[], fn: () => Promise<unknown>) => {
      lockDepth += 1;
      try {
        return await fn();
      } finally {
        lockDepth -= 1;
      }
    },
  );
  const app = express();
  const registry = createWorkspaceRegistry(
    primary
      ? [runtime]
      : [
          {
            ...runtime,
            workspaceId: randomUUID(),
            workspaceCwd: path.join(root, 'primary'),
            primary: true,
          },
          runtime,
        ],
  );
  app.use(express.json());
  registerSessionRoutes(app, {
    boundWorkspace: workspaceDir,
    bridge,
    workspaceRegistry: registry,
    archiveCoordinator: {
      runSharedMany,
    } as unknown as Parameters<
      typeof registerSessionRoutes
    >[1]['archiveCoordinator'],
    mutate: () => (_req, _res, next) => next(),
    sendBridgeError: (res: Response, err: unknown) => {
      res.status(500).json({
        error: 'test bridge error',
        detail:
          err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      });
    },
    sessionShellCommandEnabled: true,
    languageCodes: ['en'],
  });
  return {
    runtime,
    bridge,
    app,
    registry,
    sessionService,
    sessionId,
    lockDepth: () => lockDepth,
    runSharedMany,
    seed(records, seedSessionId = sessionId, sourceType) {
      const ledgerPath = sessionService.getPromptLedgerPath(seedSessionId);
      mkdirSync(path.dirname(ledgerPath), { recursive: true });
      if (sourceType !== undefined) {
        writeFileSync(
          path.join(path.dirname(ledgerPath), `${seedSessionId}.jsonl`),
          `${JSON.stringify({
            uuid: 'source-1',
            parentUuid: null,
            sessionId: seedSessionId,
            timestamp: new Date().toISOString(),
            type: 'system',
            subtype: 'session_source',
            systemPayload: { sourceType },
            cwd: workspaceDir,
            version: '1.0.0',
          })}\n`,
          'utf8',
        );
      }
      writeFileSync(
        path.join(path.dirname(ledgerPath), `${seedSessionId}.jsonl`),
        `${JSON.stringify({
          uuid: 'user-1',
          parentUuid: null,
          sessionId: seedSessionId,
          timestamp: new Date().toISOString(),
          type: 'user',
          provenance: 'real_user',
          cwd: workspaceDir,
          version: '1.0.0',
          message: { role: 'user', parts: [{ text: 'continue' }] },
        })}\n`,
        { encoding: 'utf8', flag: 'a' },
      );
      for (const record of records) {
        appendPromptLedgerRecord(ledgerPath, record);
      }
    },
  };
}

function inFlight(promptId: string, at: number): PromptLedgerRecord {
  return { v: 1, promptId, state: 'in_flight', at };
}

function terminal(
  promptId: string,
  at: number,
  outcome: 'completed' | 'interrupted',
  code?: string,
): PromptLedgerRecord {
  return {
    v: 1,
    promptId,
    terminal: outcome,
    ...(code === undefined ? {} : { code }),
    at,
  };
}

function requestBody(fixture: Fixture, confirmToolTurn = false) {
  return {
    sessions: [
      {
        workspace: fixture.runtime.workspaceId,
        sessionId: fixture.sessionId,
      },
    ],
    ...(confirmToolTurn ? { confirmToolTurn: true } : {}),
  };
}

describe('POST /sessions/recovery/continue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    restoreMocks.restoreSessionCore.mockResolvedValue({
      kind: 'restored',
      session: { sessionId: 'restored', clientId: 'batch-client' },
    });
  });

  it('cold-loads and continues an interrupted prompt', async () => {
    const fixture = makeFixture();
    fixture.seed([inFlight('p1', Date.now())]);

    const response = await request(fixture.app)
      .post('/sessions/recovery/continue')
      .send(requestBody(fixture));

    expect(response.status).toBe(200);
    expect(response.body.results).toEqual([
      {
        workspace: fixture.runtime.workspaceId,
        sessionId: fixture.sessionId,
        status: 'accepted',
        kind: 'interrupted_prompt',
        promptId: 'prompt-1',
      },
    ]);
    expect(restoreMocks.restoreSessionCore).toHaveBeenCalledOnce();
    expect(fixture.bridge.detachClient).toHaveBeenCalledWith(
      'restored',
      'batch-client',
    );
    expect(
      vi.mocked(fixture.bridge.detachClient).mock.invocationCallOrder[0]!,
    ).toBeGreaterThan(
      vi.mocked(fixture.bridge.continueSession).mock.invocationCallOrder[0]!,
    );
    expect(fixture.bridge.continueSession).toHaveBeenCalledWith(
      fixture.sessionId,
      {
        promptId: expect.any(String),
        expectedInterruption: 'interrupted_prompt',
        assertCanContinue: expect.any(Function),
        assertCanDispatch: expect.any(Function),
        requireDispatchAck: true,
      },
    );
  });

  it('holds the archive shared lock while continuing', async () => {
    const fixture = makeFixture();
    fixture.seed([inFlight('p1', Date.now())]);
    const depths = { restore: [] as number[], continue: [] as number[] };
    restoreMocks.restoreSessionCore.mockImplementationOnce(async () => {
      depths.restore.push(fixture.lockDepth());
      return {
        kind: 'restored',
        session: { sessionId: 'restored', clientId: 'batch-client' },
      };
    });
    vi.mocked(fixture.bridge.continueSession).mockImplementationOnce(
      async () => {
        depths.continue.push(fixture.lockDepth());
        return {
          accepted: true,
          interruption: 'interrupted_prompt',
          promptId: 'prompt-1',
        };
      },
    );

    const response = await request(fixture.app)
      .post('/sessions/recovery/continue')
      .send(requestBody(fixture));

    expect(response.status).toBe(200);
    expect(response.body.results[0]).toEqual({
      workspace: fixture.runtime.workspaceId,
      sessionId: fixture.sessionId,
      status: 'accepted',
      kind: 'interrupted_prompt',
      promptId: 'prompt-1',
    });
    expect(fixture.runSharedMany).toHaveBeenCalledWith(
      [fixture.sessionId],
      expect.any(Function),
    );
    expect(restoreMocks.restoreSessionCore).toHaveBeenCalledOnce();
    expect(fixture.bridge.continueSession).toHaveBeenCalledOnce();
    expect(depths).toEqual({ restore: [1], continue: [1] });
    expect(fixture.lockDepth()).toBe(0);
  });

  it.each([
    ['daemon_draining', new DaemonDrainingError()],
    ['session_archiving', new SessionArchivingError('session-1')],
    [
      'session_workspace_conflict',
      new RequestedSessionIdAdmissionError(
        'session_workspace_conflict',
        'session-1',
        'Session belongs to another workspace',
      ),
    ],
  ])('returns the transient conflict code %s', async (code, error) => {
    const fixture = makeFixture();
    fixture.seed([inFlight('p1', Date.now())]);
    fixture.runSharedMany.mockRejectedValueOnce(error);

    const response = await request(fixture.app)
      .post('/sessions/recovery/continue')
      .send(requestBody(fixture));

    expect(response.status).toBe(200);
    expect(response.body.results[0]).toMatchObject({
      status: 'error',
      code,
    });
  });

  it('does not load an already live session with a persisted ordinary source', async () => {
    const fixture = makeFixture();
    fixture.seed([inFlight('p1', Date.now())], undefined, 'channel');
    await expect(
      fixture.sessionService.getSessionListItem(fixture.sessionId),
    ).resolves.toMatchObject({ sourceType: 'channel' });
    vi.mocked(fixture.bridge.getSessionSummary).mockReturnValue({
      sessionId: fixture.sessionId,
      sourceType: 'channel',
    } as ReturnType<AcpSessionBridge['getSessionSummary']>);

    const response = await request(fixture.app)
      .post('/sessions/recovery/continue')
      .send(requestBody(fixture));

    expect(response.status).toBe(200);
    expect(response.body.results[0].status).toBe('accepted');
    expect(fixture.bridge.getSessionSummary).toHaveBeenCalledOnce();
    expect(restoreMocks.restoreSessionCore).not.toHaveBeenCalled();
  });

  it('still restores a cold session with a persisted ordinary source', async () => {
    const fixture = makeFixture();
    fixture.seed([inFlight('p1', Date.now())], undefined, 'channel');

    const response = await request(fixture.app)
      .post('/sessions/recovery/continue')
      .send(requestBody(fixture));

    expect(response.body.results[0].status).toBe('accepted');
    expect(restoreMocks.restoreSessionCore).toHaveBeenCalledOnce();
  });

  it('requires confirmation before continuing a tool turn', async () => {
    const fixture = makeFixture();
    fixture.seed([inFlight('p1', Date.now())]);
    vi.mocked(fixture.bridge.getSessionContextStatus).mockResolvedValue({
      sessionId: fixture.sessionId,
      v: 1,
      workspaceCwd: fixture.runtime.workspaceCwd,
      recovery: { kind: 'interrupted_turn', canContinue: true },
      state: {},
    });

    const withoutConfirmation = await request(fixture.app)
      .post('/sessions/recovery/continue')
      .send(requestBody(fixture));
    expect(withoutConfirmation.body.results[0]).toMatchObject({
      status: 'confirmation_required',
      kind: 'interrupted_turn',
      code: 'tool_turn',
    });
    expect(fixture.bridge.continueSession).not.toHaveBeenCalled();
    expect(fixture.bridge.detachClient).toHaveBeenCalledWith(
      'restored',
      'batch-client',
    );

    vi.mocked(fixture.bridge.continueSession).mockResolvedValueOnce({
      accepted: true,
      interruption: 'interrupted_turn',
      promptId: 'confirmed-tool-turn',
    });
    const withConfirmation = await request(fixture.app)
      .post('/sessions/recovery/continue')
      .send(requestBody(fixture, true));
    expect(withConfirmation.body.results[0]).toMatchObject({
      status: 'accepted',
      kind: 'interrupted_turn',
      promptId: 'confirmed-tool-turn',
    });
    expect(fixture.bridge.continueSession).toHaveBeenCalledWith(
      fixture.sessionId,
      {
        promptId: expect.any(String),
        expectedInterruption: 'interrupted_turn',
        assertCanContinue: expect.any(Function),
        assertCanDispatch: expect.any(Function),
        requireDispatchAck: true,
      },
    );
  });

  it('does not bypass confirmation when the interruption becomes a tool turn', async () => {
    const fixture = makeFixture();
    fixture.seed([inFlight('p1', Date.now())]);
    vi.mocked(fixture.bridge.continueSession).mockImplementationOnce(
      async (_sessionId, context) => {
        if (context?.expectedInterruption === 'interrupted_prompt') {
          return {
            accepted: false,
            interruption: 'interrupted_turn',
            reason: 'interruption_mismatch',
          };
        }
        return { accepted: true, interruption: 'interrupted_turn' };
      },
    );

    const response = await request(fixture.app)
      .post('/sessions/recovery/continue')
      .send(requestBody(fixture));

    expect(response.body.results[0]).toMatchObject({
      status: 'confirmation_required',
      code: 'tool_turn',
      kind: 'interrupted_turn',
    });
    expect(fixture.bridge.continueSession).toHaveBeenCalledWith(
      fixture.sessionId,
      {
        promptId: expect.any(String),
        expectedInterruption: 'interrupted_prompt',
        assertCanContinue: expect.any(Function),
        assertCanDispatch: expect.any(Function),
        requireDispatchAck: true,
      },
    );
  });

  it('refuses a continuation when the generation closes during its status read', async () => {
    const fixture = makeFixture();
    fixture.seed([inFlight('p1', Date.now())]);
    let releaseStatus: () => void = () => {};
    const statusEntered = new Promise<void>((resolve) => {
      vi.mocked(fixture.bridge.getSessionContextStatus).mockImplementationOnce(
        async () => {
          resolve();
          await new Promise<void>((release) => {
            releaseStatus = release;
          });
          return {
            sessionId: fixture.sessionId,
            v: 1,
            workspaceCwd: fixture.runtime.workspaceCwd,
            recovery: { kind: 'interrupted_prompt', canContinue: true },
            state: {},
          };
        },
      );
    });
    vi.mocked(fixture.bridge.continueSession).mockImplementationOnce(
      async (_sessionId, context) => {
        context?.assertCanContinue?.();
        return {
          accepted: true,
          interruption: 'interrupted_prompt',
          promptId: 'should-not-admit',
        };
      },
    );
    const pending = request(fixture.app)
      .post('/sessions/recovery/continue')
      .send(requestBody(fixture))
      .then((response) => response);
    await statusEntered;
    const entry = fixture.registry.getEntryByWorkspaceId(
      fixture.runtime.workspaceId,
    );
    expect(entry).toBeDefined();
    fixture.registry.beginReplacement(entry!, 'test');
    fixture.registry.activateReplacement(
      entry!,
      { ...fixture.runtime, generationGuard: undefined },
      'test',
    );
    releaseStatus();

    const response = await pending;
    expect(response.body.results[0]).toMatchObject({
      status: 'error',
      code: 'workspace_runtime_unavailable',
    });
  });

  it('does not reinterpret an ordinary bridge veto as tool-turn confirmation', async () => {
    const fixture = makeFixture();
    fixture.seed([inFlight('p1', Date.now())]);
    vi.mocked(fixture.bridge.continueSession).mockResolvedValueOnce({
      accepted: false,
      interruption: 'interrupted_turn',
    });

    const response = await request(fixture.app)
      .post('/sessions/recovery/continue')
      .send(requestBody(fixture));

    expect(response.body.results[0]).toMatchObject({
      status: 'rejected',
      interruption: 'interrupted_turn',
    });
  });

  it('rejects an indeterminate persisted source without restoring it', async () => {
    const fixture = makeFixture();
    fixture.seed([inFlight('p1', Date.now())], undefined, 'agent');
    const transcriptPath = path.join(
      path.dirname(
        fixture.sessionService.getPromptLedgerPath(fixture.sessionId),
      ),
      `${fixture.sessionId}.jsonl`,
    );
    writeFileSync(transcriptPath, '{torn-json\n', {
      encoding: 'utf8',
      flag: 'a',
    });
    await expect(
      fixture.sessionService.readCreationMetadataIfReadable(
        fixture.sessionId,
        'active',
      ),
    ).resolves.toBeUndefined();

    const response = await request(fixture.app)
      .post('/sessions/recovery/continue')
      .send(requestBody(fixture));

    expect(response.body.results[0]).toMatchObject({
      status: 'not_continuable',
      code: 'metadata_unreadable',
    });
    expect(restoreMocks.restoreSessionCore).not.toHaveBeenCalled();
    expect(fixture.bridge.continueSession).not.toHaveBeenCalled();
  });

  it('rejects a runtime that begins draining before continuation admission', async () => {
    const fixture = makeFixture(true, false);
    fixture.seed([inFlight('p1', Date.now())]);
    let releaseStatus: () => void = () => {};
    const statusEntered = new Promise<void>((resolve) => {
      vi.mocked(fixture.bridge.getSessionContextStatus).mockImplementationOnce(
        async () => {
          resolve();
          await new Promise<void>((release) => {
            releaseStatus = release;
          });
          return {
            sessionId: fixture.sessionId,
            v: 1,
            workspaceCwd: fixture.runtime.workspaceCwd,
            recovery: { kind: 'interrupted_prompt', canContinue: true },
            state: {},
          };
        },
      );
    });
    vi.mocked(fixture.bridge.continueSession).mockImplementationOnce(
      async (_sessionId, context) => {
        context?.assertCanContinue?.();
        context?.assertCanDispatch?.();
        return { accepted: true, interruption: 'interrupted_prompt' };
      },
    );
    const pending = request(fixture.app)
      .post('/sessions/recovery/continue')
      .send(requestBody(fixture))
      .then((response) => response);
    await statusEntered;
    expect(fixture.registry.beginDrain(fixture.runtime)).toBe(true);
    releaseStatus();

    const response = await pending;
    expect(response.body.results[0]).toMatchObject({
      status: 'error',
      code: 'workspace_runtime_unavailable',
    });
  });

  it('rechecks the runtime after asynchronous source inspection', async () => {
    const fixture = makeFixture();
    fixture.seed([inFlight('p1', Date.now())]);
    let releaseMetadata: () => void = () => {};
    const metadataEntered = new Promise<void>((resolve) => {
      vi.spyOn(
        SessionService.prototype,
        'readCreationMetadataIfReadable',
      ).mockImplementationOnce(async () => {
        resolve();
        await new Promise<void>((release) => {
          releaseMetadata = release;
        });
        return { sourceType: 'agent' };
      });
    });
    const pending = request(fixture.app)
      .post('/sessions/recovery/continue')
      .send(requestBody(fixture))
      .then((response) => response);
    await metadataEntered;
    const entry = fixture.registry.getEntryByWorkspaceId(
      fixture.runtime.workspaceId,
    );
    fixture.registry.beginReplacement(entry!, 'changed');
    releaseMetadata();

    const response = await pending;
    expect(response.body.results[0]).toMatchObject({
      status: 'error',
      code: 'workspace_runtime_unavailable',
    });
    expect(fixture.bridge.continueSession).not.toHaveBeenCalled();
  });

  it('prefers a known hidden source over unreadable persisted metadata', async () => {
    const fixture = makeFixture();
    fixture.seed([inFlight('p1', Date.now())], undefined, 'agent');
    writeFileSync(
      path.join(
        path.dirname(
          fixture.sessionService.getPromptLedgerPath(fixture.sessionId),
        ),
        `${fixture.sessionId}.jsonl`,
      ),
      '{torn-json\n',
      { encoding: 'utf8', flag: 'a' },
    );
    vi.mocked(fixture.bridge.getSessionSummary).mockReturnValue({
      sessionId: fixture.sessionId,
      sourceType: 'agent',
    } as ReturnType<AcpSessionBridge['getSessionSummary']>);

    const response = await request(fixture.app)
      .post('/sessions/recovery/continue')
      .send(requestBody(fixture));

    expect(response.body.results[0]).toMatchObject({
      status: 'not_continuable',
      code: 'hidden_session',
    });
    expect(restoreMocks.restoreSessionCore).not.toHaveBeenCalled();
  });

  it('refuses a session taken over by a hidden agent before admission', async () => {
    const fixture = makeFixture();
    fixture.seed([inFlight('p1', Date.now())], undefined, 'channel');
    const summary = vi.mocked(fixture.bridge.getSessionSummary);
    summary.mockReturnValue({
      sessionId: fixture.sessionId,
      sourceType: 'channel',
    } as ReturnType<AcpSessionBridge['getSessionSummary']>);
    let releaseStatus: () => void = () => {};
    const statusEntered = new Promise<void>((resolve) => {
      vi.mocked(fixture.bridge.getSessionContextStatus).mockImplementationOnce(
        async () => {
          resolve();
          await new Promise<void>((release) => {
            releaseStatus = release;
          });
          return {
            sessionId: fixture.sessionId,
            v: 1,
            workspaceCwd: fixture.runtime.workspaceCwd,
            recovery: { kind: 'interrupted_prompt', canContinue: true },
            state: {},
          };
        },
      );
    });
    vi.mocked(fixture.bridge.continueSession).mockImplementationOnce(
      async (_sessionId, context) => {
        context?.assertCanContinue?.();
        return { accepted: true, interruption: 'interrupted_prompt' };
      },
    );
    const pending = request(fixture.app)
      .post('/sessions/recovery/continue')
      .send(requestBody(fixture))
      .then((response) => response);
    await statusEntered;
    summary.mockReturnValue({
      sessionId: fixture.sessionId,
      sourceType: 'agent',
    } as ReturnType<AcpSessionBridge['getSessionSummary']>);
    releaseStatus();

    const response = await pending;
    expect(response.body.results[0]).toMatchObject({
      status: 'not_continuable',
      code: 'hidden_session',
    });
  });

  it('rechecks source at the dispatch fence, not only its initial inspection', async () => {
    const fixture = makeFixture();
    fixture.seed([inFlight('p1', Date.now())], undefined, 'channel');
    const summary = vi.mocked(fixture.bridge.getSessionSummary);
    summary.mockReturnValue({
      sessionId: fixture.sessionId,
      sourceType: 'channel',
    } as ReturnType<AcpSessionBridge['getSessionSummary']>);
    vi.mocked(fixture.bridge.continueSession).mockImplementationOnce(
      async (_sessionId, context) => {
        context?.assertCanContinue?.();
        summary.mockReturnValue({
          sessionId: fixture.sessionId,
          sourceType: 'agent',
        } as ReturnType<AcpSessionBridge['getSessionSummary']>);
        context?.assertCanDispatch?.();
        return { accepted: true, interruption: 'interrupted_prompt' };
      },
    );

    const response = await request(fixture.app)
      .post('/sessions/recovery/continue')
      .send(requestBody(fixture));

    expect(response.body.results[0]).toMatchObject({
      status: 'not_continuable',
      code: 'hidden_session',
    });
  });

  it('continues a source-less session with canonical glued tail records', async () => {
    const fixture = makeFixture();
    fixture.seed([inFlight('p1', Date.now())]);
    const transcriptPath = path.join(
      path.dirname(
        fixture.sessionService.getPromptLedgerPath(fixture.sessionId),
      ),
      `${fixture.sessionId}.jsonl`,
    );
    const serialized = [0, 1].map((index) =>
      JSON.stringify({
        uuid: `canonical-glued-${index}`,
        parentUuid: null,
        sessionId: fixture.sessionId,
        timestamp: new Date().toISOString(),
        type: 'user',
        cwd: fixture.runtime.workspaceCwd,
        version: '1.0.0',
        message: {
          role: 'user',
          parts: [{ text: `canonical glued history ${index}` }],
        },
      }),
    );
    const gluedLine = serialized.join('');
    const parsed = parseLineTolerantWithIntegrity(gluedLine, transcriptPath);
    expect(parsed.complete).toBe(true);
    expect(parsed.records).toHaveLength(2);
    writeFileSync(transcriptPath, `${gluedLine}\n`, {
      encoding: 'utf8',
      flag: 'a',
    });

    const response = await request(fixture.app)
      .post('/sessions/recovery/continue')
      .send(requestBody(fixture));

    expect(response.body.results).toEqual([
      {
        workspace: fixture.runtime.workspaceId,
        sessionId: fixture.sessionId,
        status: 'accepted',
        kind: 'interrupted_prompt',
        promptId: 'prompt-1',
      },
    ]);
    expect(restoreMocks.restoreSessionCore).toHaveBeenCalledOnce();
    expect(fixture.bridge.continueSession).toHaveBeenCalledOnce();
    expect(fixture.bridge.detachClient).toHaveBeenCalledWith(
      'restored',
      'batch-client',
    );
  });

  it('refuses a torn source record beyond the metadata head', async () => {
    const fixture = makeFixture();
    fixture.seed([inFlight('p1', Date.now())]);
    const transcriptPath = path.join(
      path.dirname(
        fixture.sessionService.getPromptLedgerPath(fixture.sessionId),
      ),
      `${fixture.sessionId}.jsonl`,
    );
    const history = Array.from({ length: 9 }, (_, index) =>
      JSON.stringify({
        uuid: `history-${index}`,
        parentUuid: null,
        sessionId: fixture.sessionId,
        timestamp: new Date().toISOString(),
        type: 'user',
        cwd: fixture.runtime.workspaceCwd,
        version: '1.0.0',
        message: { role: 'user', parts: [{ text: 'history' }] },
      }),
    ).join('\n');
    writeFileSync(
      transcriptPath,
      `${history}\n{"type":"system","subtype":"session_source","systemPayload":{"sourceType":"agent"\n`,
      { encoding: 'utf8', flag: 'a' },
    );

    const response = await request(fixture.app)
      .post('/sessions/recovery/continue')
      .send(requestBody(fixture));

    expect(response.body.results[0]).toMatchObject({
      status: 'not_continuable',
      code: 'metadata_unreadable',
    });
    expect(restoreMocks.restoreSessionCore).not.toHaveBeenCalled();
    expect(fixture.bridge.continueSession).not.toHaveBeenCalled();
  });

  it('refuses a session whose source record is torn before its subtype', async () => {
    const fixture = makeFixture();
    fixture.seed([inFlight('p1', Date.now())]);
    const transcriptPath = path.join(
      path.dirname(
        fixture.sessionService.getPromptLedgerPath(fixture.sessionId),
      ),
      `${fixture.sessionId}.jsonl`,
    );
    const history = Array.from({ length: 9 }, (_, index) =>
      JSON.stringify({
        uuid: `history-${index}`,
        parentUuid: null,
        sessionId: fixture.sessionId,
        timestamp: new Date().toISOString(),
        type: 'user',
        cwd: fixture.runtime.workspaceCwd,
        version: '1.0.0',
        message: { role: 'user', parts: [{ text: 'history' }] },
      }),
    ).join('\n');
    writeFileSync(
      transcriptPath,
      `${history}\n{"type":"system","subtype":"se`,
      {
        encoding: 'utf8',
        flag: 'a',
      },
    );

    const response = await request(fixture.app)
      .post('/sessions/recovery/continue')
      .send(requestBody(fixture));

    expect(response.body.results[0]).toMatchObject({
      status: 'not_continuable',
      code: 'metadata_unreadable',
    });
    expect(restoreMocks.restoreSessionCore).not.toHaveBeenCalled();
    expect(fixture.bridge.continueSession).not.toHaveBeenCalled();
  });

  it('refuses a session when a torn record spans the whole tail window', async () => {
    const fixture = makeFixture();
    fixture.seed([inFlight('p1', Date.now())]);
    const transcriptPath = path.join(
      path.dirname(
        fixture.sessionService.getPromptLedgerPath(fixture.sessionId),
      ),
      `${fixture.sessionId}.jsonl`,
    );
    const history = Array.from({ length: 12 }, (_, index) =>
      JSON.stringify({
        uuid: `history-${index}`,
        parentUuid: null,
        sessionId: fixture.sessionId,
        timestamp: new Date().toISOString(),
        type: 'user',
        cwd: fixture.runtime.workspaceCwd,
        version: '1.0.0',
        message: { role: 'user', parts: [{ text: 'history' }] },
      }),
    ).join('\n');
    const tornTail = '{"type":"system","subtype":"se' + 'x'.repeat(70 * 1024);
    expect(Buffer.byteLength(tornTail)).toBeGreaterThan(64 * 1024);
    writeFileSync(transcriptPath, `${history}\n${tornTail}`, {
      encoding: 'utf8',
      flag: 'a',
    });

    const response = await request(fixture.app)
      .post('/sessions/recovery/continue')
      .send(requestBody(fixture));

    expect(response.body.results[0]).toMatchObject({
      status: 'not_continuable',
      code: 'metadata_unreadable',
    });
    expect(restoreMocks.restoreSessionCore).not.toHaveBeenCalled();
    expect(fixture.bridge.continueSession).not.toHaveBeenCalled();
  });

  it('rejects a generation that becomes stale at the dispatch fence', async () => {
    const fixture = makeFixture();
    fixture.seed([inFlight('p1', Date.now())]);
    vi.mocked(fixture.bridge.getSessionSummary).mockReturnValue({
      sessionId: fixture.sessionId,
      sourceType: 'channel',
    } as ReturnType<AcpSessionBridge['getSessionSummary']>);
    vi.mocked(fixture.bridge.continueSession).mockImplementationOnce(
      async (_sessionId, context) => {
        context?.assertCanContinue?.();
        const entry = fixture.registry.getEntryByWorkspaceId(
          fixture.runtime.workspaceId,
        );
        fixture.registry.beginReplacement(entry!, 'dispatch-closed');
        context?.assertCanDispatch?.();
        return { accepted: true, interruption: 'interrupted_prompt' };
      },
    );

    const response = await request(fixture.app)
      .post('/sessions/recovery/continue')
      .send(requestBody(fixture));

    expect(response.body.results[0]).toMatchObject({
      status: 'error',
      code: 'workspace_runtime_unavailable',
    });
  });

  it('requires confirmation when the cancellation reason is unknown', async () => {
    const fixture = makeFixture();
    fixture.seed([inFlight('p1', Date.now())]);
    vi.mocked(fixture.bridge.getSessionContextStatus).mockResolvedValue({
      sessionId: fixture.sessionId,
      v: 1,
      workspaceCwd: fixture.runtime.workspaceCwd,
      recovery: {
        kind: 'interrupted_prompt',
        canContinue: true,
        cancellationConfirmationId: 'confirm-1',
      },
      state: {},
    });

    const response = await request(fixture.app)
      .post('/sessions/recovery/continue')
      .send(requestBody(fixture, true));

    expect(response.body.results[0]).toMatchObject({
      status: 'confirmation_required',
      code: 'cancellation_confirmation',
    });
    expect(fixture.bridge.continueSession).not.toHaveBeenCalled();
    expect(fixture.bridge.detachClient).toHaveBeenCalledWith(
      'restored',
      'batch-client',
    );
  });

  it.each(['agent', 'agent-host'])(
    'refuses to continue a hidden %s session',
    async (sourceType) => {
      const fixture = makeFixture();
      fixture.seed([inFlight('p1', Date.now())], undefined, sourceType);

      const response = await request(fixture.app)
        .post('/sessions/recovery/continue')
        .send(requestBody(fixture));

      expect(response.body.results[0]).toMatchObject({
        status: 'not_continuable',
        code: 'hidden_session',
      });
      expect(restoreMocks.restoreSessionCore).not.toHaveBeenCalled();
      expect(fixture.bridge.continueSession).not.toHaveBeenCalled();
    },
  );

  it('refuses a live hidden session without restoring it', async () => {
    const fixture = makeFixture();
    fixture.seed([inFlight('p1', Date.now())]);
    vi.mocked(fixture.bridge.getSessionSummary).mockReturnValue({
      sessionId: fixture.sessionId,
      sourceType: 'agent',
    } as ReturnType<AcpSessionBridge['getSessionSummary']>);

    const response = await request(fixture.app)
      .post('/sessions/recovery/continue')
      .send(requestBody(fixture));

    expect(response.body.results[0]).toMatchObject({
      status: 'not_continuable',
      code: 'hidden_session',
    });
    expect(restoreMocks.restoreSessionCore).not.toHaveBeenCalled();
    expect(fixture.bridge.continueSession).not.toHaveBeenCalled();
  });

  it('refuses a live hidden source even when persisted metadata is ordinary', async () => {
    const fixture = makeFixture();
    fixture.seed([inFlight('p1', Date.now())], undefined, 'default');
    vi.mocked(fixture.bridge.getSessionSummary).mockReturnValue({
      sessionId: fixture.sessionId,
      sourceType: 'agent',
    } as ReturnType<AcpSessionBridge['getSessionSummary']>);

    const response = await request(fixture.app)
      .post('/sessions/recovery/continue')
      .send(requestBody(fixture));

    expect(response.body.results[0]).toMatchObject({
      status: 'not_continuable',
      code: 'hidden_session',
    });
    expect(restoreMocks.restoreSessionCore).not.toHaveBeenCalled();
    expect(fixture.bridge.continueSession).not.toHaveBeenCalled();
  });

  it.each(['agent', 'agent-host'])(
    'refuses a %s source visible only after cold restore',
    async (sourceType) => {
      const fixture = makeFixture();
      fixture.seed([inFlight('p1', Date.now())]);
      restoreMocks.restoreSessionCore.mockResolvedValueOnce({
        kind: 'restored',
        session: {
          sessionId: 'restored',
          clientId: 'batch-client',
          sourceType,
        },
      });

      const response = await request(fixture.app)
        .post('/sessions/recovery/continue')
        .send(requestBody(fixture));

      expect(response.body.results[0]).toMatchObject({
        status: 'not_continuable',
        code: 'hidden_session',
      });
      expect(fixture.bridge.continueSession).not.toHaveBeenCalled();
      expect(fixture.bridge.detachClient).toHaveBeenCalledWith(
        'restored',
        'batch-client',
      );
    },
  );

  it('refuses degraded history and an active turn', async () => {
    const fixture = makeFixture();
    fixture.seed([inFlight('p1', Date.now())]);
    vi.mocked(fixture.bridge.getSessionContextStatus).mockResolvedValue({
      sessionId: fixture.sessionId,
      v: 1,
      workspaceCwd: fixture.runtime.workspaceCwd,
      recovery: { kind: 'degraded_history', canContinue: false },
      state: {},
    });

    const response = await request(fixture.app)
      .post('/sessions/recovery/continue')
      .send(requestBody(fixture));

    expect(response.body.results[0]).toMatchObject({
      status: 'not_continuable',
      kind: 'degraded_history',
    });
    expect(fixture.bridge.continueSession).not.toHaveBeenCalled();
    expect(fixture.bridge.detachClient).toHaveBeenCalledWith(
      'restored',
      'batch-client',
    );
  });

  it('reports a continuation the bridge refuses to admit', async () => {
    const fixture = makeFixture();
    fixture.seed([inFlight('p1', Date.now())]);
    vi.mocked(fixture.bridge.continueSession).mockResolvedValueOnce({
      accepted: false,
      interruption: 'none',
    });

    const response = await request(fixture.app)
      .post('/sessions/recovery/continue')
      .send(requestBody(fixture));

    expect(response.body.results[0]).toMatchObject({
      status: 'rejected',
      kind: 'interrupted_prompt',
      interruption: 'none',
    });
  });

  it.each([
    { label: 'missing', records: [] as const, code: 'no_evidence' },
    {
      label: 'settled',
      records: [
        inFlight('p1', Date.now() - 1000),
        terminal('p1', Date.now(), 'completed'),
      ],
      code: 'already_moved',
    },
  ])(
    'keeps the ledger result for a $label hidden session',
    async ({ records, code }) => {
      const fixture = makeFixture();
      fixture.seed(records, undefined, 'agent');

      const response = await request(fixture.app)
        .post('/sessions/recovery/continue')
        .send(requestBody(fixture));

      expect(response.body.results[0]).toMatchObject({
        status: 'not_continuable',
        code,
      });
      expect(restoreMocks.restoreSessionCore).not.toHaveBeenCalled();
      expect(fixture.bridge.continueSession).not.toHaveBeenCalled();
    },
  );

  it('does not load a session that already settled', async () => {
    const fixture = makeFixture();
    fixture.seed([
      inFlight('p1', Date.now() - 1000),
      terminal('p1', Date.now(), 'completed'),
    ]);

    const response = await request(fixture.app)
      .post('/sessions/recovery/continue')
      .send(requestBody(fixture));

    expect(response.body.results[0]).toMatchObject({
      status: 'not_continuable',
      code: 'already_moved',
    });
    expect(restoreMocks.restoreSessionCore).not.toHaveBeenCalled();
    expect(fixture.bridge.continueSession).not.toHaveBeenCalled();
  });

  it('rejects a non-persisted session id before reading a ledger', async () => {
    const fixture = makeFixture();
    const response = await request(fixture.app)
      .post('/sessions/recovery/continue')
      .send({
        sessions: [
          { workspace: fixture.runtime.workspaceId, sessionId: '../../escape' },
        ],
      });

    expect(response.body.results[0]).toMatchObject({
      status: 'not_continuable',
      code: 'invalid_session_id',
    });
    expect(restoreMocks.restoreSessionCore).not.toHaveBeenCalled();
    expect(fixture.bridge.getSessionSummary).not.toHaveBeenCalled();
  });

  it('does not load a session with no ledger evidence', async () => {
    const fixture = makeFixture();
    const response = await request(fixture.app)
      .post('/sessions/recovery/continue')
      .send(requestBody(fixture));

    expect(response.body.results[0]).toMatchObject({
      status: 'not_continuable',
      code: 'no_evidence',
    });
    expect(restoreMocks.restoreSessionCore).not.toHaveBeenCalled();
  });

  it('reports an unknown workspace without touching another runtime', async () => {
    const fixture = makeFixture();
    fixture.seed([inFlight('p1', Date.now())]);

    const response = await request(fixture.app)
      .post('/sessions/recovery/continue')
      .send({
        sessions: [
          { workspace: '/no/such/workspace', sessionId: fixture.sessionId },
        ],
      });

    expect(response.body.results[0]).toMatchObject({
      workspace: '/no/such/workspace',
      status: 'error',
      code: 'workspace_not_found',
    });
    expect(fixture.bridge.continueSession).not.toHaveBeenCalled();
  });

  it('rejects an untrusted workspace', async () => {
    const fixture = makeFixture(false);
    fixture.seed([inFlight('p1', Date.now())]);

    const response = await request(fixture.app)
      .post('/sessions/recovery/continue')
      .send(requestBody(fixture));

    expect(response.body.results[0]).toMatchObject({
      status: 'error',
      code: 'untrusted_workspace',
    });
    expect(restoreMocks.restoreSessionCore).not.toHaveBeenCalled();
  });

  it('keeps processing after one session fails', async () => {
    const fixture = makeFixture();
    const failed = randomUUID();
    const continued = randomUUID();
    fixture.seed([inFlight('p1', Date.now())], failed);
    fixture.seed([inFlight('p1', Date.now())], continued);
    restoreMocks.restoreSessionCore
      .mockRejectedValueOnce(new Error('load failed'))
      .mockResolvedValueOnce({
        kind: 'restored',
        session: { sessionId: continued, clientId: 'batch-client' },
      });

    const response = await request(fixture.app)
      .post('/sessions/recovery/continue')
      .send({
        sessions: [
          { workspace: fixture.runtime.workspaceId, sessionId: failed },
          { workspace: fixture.runtime.workspaceId, sessionId: continued },
        ],
      });

    expect(response.body.results).toHaveLength(2);
    expect(response.body.results[0]).toMatchObject({
      sessionId: failed,
      status: 'error',
      code: 'continue_failed',
    });
    expect(response.body.results[1]).toMatchObject({
      sessionId: continued,
      status: 'accepted',
    });
    expect(fixture.bridge.detachClient).toHaveBeenCalledWith(
      continued,
      'batch-client',
    );
  });

  it('reports a load failure per session', async () => {
    const fixture = makeFixture();
    fixture.seed([inFlight('p1', Date.now())]);
    restoreMocks.restoreSessionCore.mockRejectedValueOnce(
      new Error('load failed'),
    );

    const response = await request(fixture.app)
      .post('/sessions/recovery/continue')
      .send(requestBody(fixture));

    expect(response.body.results[0]).toMatchObject({
      status: 'error',
      code: 'continue_failed',
    });
    expect(fixture.bridge.continueSession).not.toHaveBeenCalled();
  });

  it('reports a session that vanished after load', async () => {
    const fixture = makeFixture();
    fixture.seed([inFlight('p1', Date.now())]);
    vi.mocked(fixture.bridge.getSessionSummary).mockReturnValue({
      sessionId: fixture.sessionId,
    } as ReturnType<AcpSessionBridge['getSessionSummary']>);
    vi.mocked(fixture.bridge.getSessionContextStatus).mockRejectedValueOnce(
      Object.assign(new Error('gone'), { code: 'session_not_found' }),
    );

    const response = await request(fixture.app)
      .post('/sessions/recovery/continue')
      .send(requestBody(fixture));

    expect(response.body.results[0]).toMatchObject({
      status: 'error',
      code: 'session_not_found',
    });
  });

  it('rejects an over-limit batch and an invalid body', async () => {
    const fixture = makeFixture();
    const sessions = Array.from({ length: 11 }, () => ({
      workspace: fixture.runtime.workspaceId,
      sessionId: randomUUID(),
    }));
    for (const body of [
      { sessions },
      { sessions: [] },
      { sessions: [{ workspace: '', sessionId: 'x' }] },
      { sessions: requestBody(fixture).sessions, extra: true },
    ]) {
      const response = await request(fixture.app)
        .post('/sessions/recovery/continue')
        .send(body);
      expect(response.status).toBe(400);
      expect(response.body.code).toBe(
        'invalid_restart_recovery_continue_request',
      );
    }
  });
});
