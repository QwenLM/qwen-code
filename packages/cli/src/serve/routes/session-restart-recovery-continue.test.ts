/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import express, { type Response } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionService } from '@qwen-code/qwen-code-core';
import {
  appendPromptLedgerRecord,
  type PromptLedgerRecord,
} from '@qwen-code/acp-bridge/promptLedger';
import {
  SessionNotFoundError,
  type AcpSessionBridge,
} from '../acp-session-bridge.js';
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
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

interface Fixture {
  runtime: WorkspaceRuntime;
  bridge: AcpSessionBridge;
  app: express.Express;
  sessionId: string;
  seed(records: readonly PromptLedgerRecord[]): void;
}

function makeFixture(trusted = true): Fixture {
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
    primary: true,
    trusted,
    bridge,
    routeFileSystemFactory: {
      forRequest: vi.fn(),
      assertCanWrite: vi.fn(),
    } as WorkspaceFileSystemFactory,
  } as WorkspaceRuntime;
  const app = express();
  app.use(express.json());
  registerSessionRoutes(app, {
    boundWorkspace: workspaceDir,
    bridge,
    workspaceRegistry: createWorkspaceRegistry([runtime]),
    archiveCoordinator: {
      runSharedMany: async (_sessionIds, fn) => await fn(),
    } as Parameters<typeof registerSessionRoutes>[1]['archiveCoordinator'],
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
    sessionId,
    seed(records) {
      const ledgerPath = sessionService.getPromptLedgerPath(sessionId);
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
      session: { sessionId: 'restored' },
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
    expect(fixture.bridge.continueSession).toHaveBeenCalledWith(
      fixture.sessionId,
      { promptId: expect.any(String) },
    );
  });

  it('does not load an already live session', async () => {
    const fixture = makeFixture();
    fixture.seed([inFlight('p1', Date.now())]);
    vi.mocked(fixture.bridge.getSessionSummary).mockReturnValue({
      sessionId: fixture.sessionId,
    } as ReturnType<AcpSessionBridge['getSessionSummary']>);

    const response = await request(fixture.app)
      .post('/sessions/recovery/continue')
      .send(requestBody(fixture));

    expect(response.status).toBe(200);
    expect(response.body.results[0].status).toBe('accepted');
    expect(restoreMocks.restoreSessionCore).not.toHaveBeenCalled();
  });

  it('requires confirmation before continuing a tool turn', async () => {
    const fixture = makeFixture();
    fixture.seed([inFlight('p1', Date.now())]);
    vi.mocked(fixture.bridge.getSessionContextStatus).mockResolvedValue({
      sessionId: fixture.sessionId,
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

    const withConfirmation = await request(fixture.app)
      .post('/sessions/recovery/continue')
      .send(requestBody(fixture, true));
    expect(withConfirmation.body.results[0].status).toBe('accepted');
    expect(fixture.bridge.continueSession).toHaveBeenCalledOnce();
  });

  it('requires confirmation when the cancellation reason is unknown', async () => {
    const fixture = makeFixture();
    fixture.seed([inFlight('p1', Date.now())]);
    vi.mocked(fixture.bridge.getSessionContextStatus).mockResolvedValue({
      sessionId: fixture.sessionId,
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
  });

  it('refuses degraded history and an active turn', async () => {
    const fixture = makeFixture();
    fixture.seed([inFlight('p1', Date.now())]);
    vi.mocked(fixture.bridge.getSessionContextStatus).mockResolvedValue({
      sessionId: fixture.sessionId,
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
    fixture.seed([inFlight('p1', Date.now())]);
    const missing = randomUUID();
    restoreMocks.restoreSessionCore
      .mockResolvedValueOnce({
        kind: 'restored',
        session: { sessionId: fixture.sessionId },
      })
      .mockRejectedValueOnce(new Error('load failed'));

    const response = await request(fixture.app)
      .post('/sessions/recovery/continue')
      .send({
        sessions: [
          { workspace: fixture.runtime.workspaceId, sessionId: missing },
          {
            workspace: fixture.runtime.workspaceId,
            sessionId: fixture.sessionId,
          },
        ],
      });

    expect(response.body.results).toHaveLength(2);
    expect(response.body.results[0]).toMatchObject({
      sessionId: missing,
      status: 'not_continuable',
      code: 'no_evidence',
    });
    expect(response.body.results[1].status).toBe('accepted');
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
