/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import express, { type Request, type Response } from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionService, type ChatRecord } from '@qwen-code/qwen-code-core';
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
  primaryRuntime?: WorkspaceRuntime;
  primaryBridge?: AcpSessionBridge;
  app: express.Express;
  registry: ReturnType<typeof createWorkspaceRegistry>;
  sessionService: SessionService;
  seed(
    sessionId: string,
    records: readonly PromptLedgerRecord[],
    cwd?: string,
    recordSessionId?: string,
    sourceType?: string,
  ): void;
}

function makeFixture(trusted = true, primary = true): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), 'session-restart-recovery-'));
  roots.push(root);
  const workspaceDir = path.join(root, 'workspace');
  const runtimeBaseDir = path.join(root, 'runtime');
  mkdirSync(workspaceDir, { recursive: true });
  const runtime = {
    workspaceId: randomUUID(),
    workspaceCwd: workspaceDir,
    sessionRuntimeBaseDir: runtimeBaseDir,
    primary,
    trusted,
    bridge: {
      getSessionSummary: vi.fn(() => {
        throw new SessionNotFoundError('cold');
      }),
    } as unknown as AcpSessionBridge,
    routeFileSystemFactory: {
      forRequest: vi.fn(),
      assertCanWrite: vi.fn(),
    } as WorkspaceFileSystemFactory,
  } as WorkspaceRuntime;
  const sessionService = new SessionService(workspaceDir, { runtimeBaseDir });
  const app = express();
  const primaryBridge = {
    getSessionSummary: vi.fn(() => ({
      sourceType: 'channel',
      hasActivePrompt: false,
      pendingPromptCount: 0,
    })),
  } as unknown as AcpSessionBridge;
  const primaryRuntime = {
    ...runtime,
    workspaceId: randomUUID(),
    workspaceCwd: path.join(root, 'primary'),
    primary: true as const,
    bridge: primaryBridge,
  };
  const registry = createWorkspaceRegistry(
    primary ? [runtime] : [primaryRuntime, runtime],
  );
  app.use(express.json());
  registerSessionRoutes(app, {
    boundWorkspace: workspaceDir,
    bridge: runtime.bridge,
    workspaceRegistry: registry,
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
    ...(primary ? {} : { primaryRuntime, primaryBridge }),
    app,
    registry,
    sessionService,
    seed(
      sessionId,
      records,
      cwd = workspaceDir,
      recordSessionId = sessionId,
      sourceType,
    ) {
      const transcriptPath = path.join(
        path.dirname(sessionService.getPromptLedgerPath(sessionId)),
        `${sessionId}.jsonl`,
      );
      mkdirSync(path.dirname(transcriptPath), { recursive: true });
      if (sourceType !== undefined) {
        writeFileSync(
          transcriptPath,
          `${JSON.stringify({
            uuid: 'source-1',
            parentUuid: null,
            sessionId,
            timestamp: new Date().toISOString(),
            type: 'system',
            subtype: 'session_source',
            systemPayload: { sourceType },
            cwd,
            version: '1.0.0',
          })}\n`,
          'utf8',
        );
      }
      const record: ChatRecord = {
        uuid: 'u1',
        parentUuid: null,
        sessionId: recordSessionId,
        timestamp: new Date().toISOString(),
        type: 'user',
        provenance: 'real_user',
        cwd,
        version: '1.0.0',
        message: { role: 'user', parts: [{ text: 'hello' }] },
      };
      writeFileSync(transcriptPath, `${JSON.stringify(record)}\n`, {
        encoding: 'utf8',
        flag: 'a',
      });
      const ledgerPath = sessionService.getPromptLedgerPath(sessionId);
      for (const ledgerRecord of records) {
        appendPromptLedgerRecord(ledgerPath, ledgerRecord);
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
  outcome: 'completed' | 'error' | 'interrupted',
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

describe('POST /sessions/recovery', () => {
  it.each(['agent', 'agent-host'])(
    'omits hidden %s sessions but retains an ordinary session',
    async (sourceType) => {
      const sessionListItemSpy = vi.spyOn(
        SessionService.prototype,
        'getSessionListItem',
      );
      const fixture = makeFixture();
      const ordinary = randomUUID();
      fixture.seed(
        ordinary,
        [inFlight('p1', Date.now() - 1)],
        undefined,
        undefined,
        'channel',
      );
      fixture.seed(
        randomUUID(),
        [inFlight('p1', Date.now())],
        undefined,
        undefined,
        sourceType,
      );

      const response = await request(fixture.app)
        .post('/sessions/recovery')
        .send({ workspaces: [fixture.runtime.workspaceId] });

      expect(response.status).toBe(200);
      expect(
        response.body.workspaces[0].items.map(
          (item: { sessionId: string }) => item.sessionId,
        ),
      ).toEqual([ordinary]);
      expect(sessionListItemSpy).not.toHaveBeenCalled();
    },
  );

  it('checks the live source independently of the persisted source', async () => {
    const fixture = makeFixture();
    const ordinary = randomUUID();
    const hidden = randomUUID();
    fixture.seed(
      ordinary,
      [inFlight('p1', Date.now() - 1)],
      undefined,
      undefined,
      'default',
    );
    fixture.seed(
      hidden,
      [inFlight('p1', Date.now())],
      undefined,
      undefined,
      'default',
    );
    vi.mocked(fixture.runtime.bridge.getSessionSummary).mockImplementation(
      (sessionId) =>
        ({
          sessionId,
          sourceType: sessionId === hidden ? 'agent' : 'channel',
          hasActivePrompt: false,
          pendingPromptCount: 0,
        }) as ReturnType<AcpSessionBridge['getSessionSummary']>,
    );

    const response = await request(fixture.app)
      .post('/sessions/recovery')
      .send({ workspaces: [fixture.runtime.workspaceId] });

    expect(response.body.workspaces[0].items).toEqual([
      expect.objectContaining({ sessionId: ordinary }),
    ]);
  });

  it('omits a session when the persisted source is indeterminate', async () => {
    const fixture = makeFixture();
    const hidden = randomUUID();
    fixture.seed(
      hidden,
      [inFlight('p1', Date.now())],
      undefined,
      undefined,
      'agent',
    );
    writeFileSync(
      path.join(
        path.dirname(fixture.sessionService.getPromptLedgerPath(hidden)),
        `${hidden}.jsonl`,
      ),
      '{torn-json\n',
      { encoding: 'utf8', flag: 'a' },
    );

    const response = await request(fixture.app)
      .post('/sessions/recovery')
      .send({ workspaces: [fixture.runtime.workspaceId] });

    expect(response.body.workspaces[0].items).toEqual([]);
  });

  it('omits a session with a torn source record after the metadata head', async () => {
    const fixture = makeFixture();
    const hidden = randomUUID();
    fixture.seed(hidden, [inFlight('p1', Date.now())]);
    const transcriptPath = path.join(
      path.dirname(fixture.sessionService.getPromptLedgerPath(hidden)),
      `${hidden}.jsonl`,
    );
    const history = Array.from({ length: 9 }, (_, index) =>
      JSON.stringify({
        uuid: `history-${index}`,
        parentUuid: null,
        sessionId: hidden,
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
      .post('/sessions/recovery')
      .send({ workspaces: [fixture.runtime.workspaceId] });

    expect(response.body.workspaces[0].items).toEqual([]);
  });

  it('omits a session whose source record is torn before its subtype', async () => {
    const fixture = makeFixture();
    const hidden = randomUUID();
    fixture.seed(hidden, [inFlight('p1', Date.now())]);
    const transcriptPath = path.join(
      path.dirname(fixture.sessionService.getPromptLedgerPath(hidden)),
      `${hidden}.jsonl`,
    );
    const history = Array.from({ length: 9 }, (_, index) =>
      JSON.stringify({
        uuid: `history-${index}`,
        parentUuid: null,
        sessionId: hidden,
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
      .post('/sessions/recovery')
      .send({ workspaces: [fixture.runtime.workspaceId] });

    expect(response.body.workspaces[0].items).toEqual([]);
  });

  it('omits a session when a torn record spans the whole tail window', async () => {
    const fixture = makeFixture();
    const hidden = randomUUID();
    fixture.seed(hidden, [inFlight('p1', Date.now())]);
    const transcriptPath = path.join(
      path.dirname(fixture.sessionService.getPromptLedgerPath(hidden)),
      `${hidden}.jsonl`,
    );
    const history = Array.from({ length: 12 }, (_, index) =>
      JSON.stringify({
        uuid: `history-${index}`,
        parentUuid: null,
        sessionId: hidden,
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
      .post('/sessions/recovery')
      .send({ workspaces: [fixture.runtime.workspaceId] });

    expect(response.body.workspaces[0].items).toEqual([]);
  });

  it('reads source metadata only for recovery candidates', async () => {
    const metadataRead = vi.spyOn(
      SessionService.prototype,
      'readCreationMetadataIfReadable',
    );
    const fixture = makeFixture();
    const now = Date.now();
    const ordinary = randomUUID();
    const hidden = randomUUID();
    const settled = randomUUID();
    fixture.seed(
      ordinary,
      [inFlight('p1', now - 2)],
      undefined,
      undefined,
      'channel',
    );
    fixture.seed(
      hidden,
      [inFlight('p1', now - 1)],
      undefined,
      undefined,
      'agent',
    );
    fixture.seed(settled, [
      inFlight('p1', now - 4),
      terminal('p1', now - 3, 'completed'),
    ]);

    const response = await request(fixture.app)
      .post('/sessions/recovery')
      .send({ workspaces: [fixture.runtime.workspaceId] });

    expect(response.body.workspaces[0].items).toEqual([
      expect.objectContaining({ sessionId: ordinary }),
    ]);
    const inspected = metadataRead.mock.calls.map(([sessionId]) => sessionId);
    expect(inspected.sort()).toEqual([ordinary, hidden].sort());
  });

  it('filters hidden candidates before the visible cap with bounded concurrency', async () => {
    const originalRead =
      SessionService.prototype.readCreationMetadataIfReadable;
    let active = 0;
    let maxActive = 0;
    vi.spyOn(
      SessionService.prototype,
      'readCreationMetadataIfReadable',
    ).mockImplementation(async (...args) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        await new Promise<void>((resolve) => setImmediate(resolve));
        return await originalRead.apply(fixture.sessionService, args);
      } finally {
        active -= 1;
      }
    });
    const fixture = makeFixture();
    const now = Date.now();
    for (let index = 0; index < 200; index += 1) {
      fixture.seed(
        randomUUID(),
        [inFlight('p1', now + index)],
        undefined,
        undefined,
        'agent',
      );
    }
    const ordinary = randomUUID();
    fixture.seed(
      ordinary,
      [inFlight('p1', now - 1)],
      undefined,
      undefined,
      'channel',
    );

    const response = await request(fixture.app)
      .post('/sessions/recovery')
      .send({ workspaces: [fixture.runtime.workspaceId] });

    expect(response.body.workspaces[0].items).toEqual([
      {
        sessionId: ordinary,
        interruption: 'in_flight',
        lastActivityAt: new Date(now - 1).toISOString(),
      },
    ]);
    expect(response.body.workspaces[0].truncated).toBe(false);
    expect(maxActive).toBeGreaterThan(1);
    expect(maxActive).toBeLessThanOrEqual(4);
  });

  it('truncates only after filtering visible candidates', async () => {
    const fixture = makeFixture();
    const now = Date.now();
    const sessionIds = Array.from({ length: 201 }, () => randomUUID());
    for (const [index, sessionId] of sessionIds.entries()) {
      fixture.seed(
        sessionId,
        [inFlight('p1', now + index)],
        undefined,
        undefined,
        'channel',
      );
    }

    const response = await request(fixture.app)
      .post('/sessions/recovery')
      .send({ workspaces: [fixture.runtime.workspaceId] });

    expect(response.body.workspaces[0].items).toHaveLength(200);
    expect(response.body.workspaces[0].truncated).toBe(true);

    rmSync(fixture.sessionService.getPromptLedgerPath(sessionIds[0]!), {
      force: true,
    });
    const atCap = await request(fixture.app)
      .post('/sessions/recovery')
      .send({ workspaces: [fixture.runtime.workspaceId] });
    expect(atCap.body.workspaces[0].items).toHaveLength(200);
    expect(atCap.body.workspaces[0].truncated).toBe(false);
  });

  it('stops further metadata batches after the client disconnects', async () => {
    const fixture = makeFixture();
    for (let index = 0; index < 6; index += 1) {
      fixture.seed(randomUUID(), [inFlight('p1', Date.now())]);
    }
    let release: () => void = () => {};
    const firstBatch = new Promise<void>((resolve) => {
      release = resolve;
    });
    const metadataRead = vi
      .spyOn(SessionService.prototype, 'readCreationMetadataIfReadable')
      .mockImplementation(async () => {
        await firstBatch;
        return { sourceType: 'channel' };
      });
    const server = fixture.app.listen(0);
    const closed = new Promise<void>((resolve) => {
      server.once('request', (_req: Request, res: Response) => {
        res.once('close', () => resolve());
      });
    });
    const pending = request(server)
      .post('/sessions/recovery')
      .send({ workspaces: [fixture.runtime.workspaceId] });
    pending.end(() => {});
    try {
      await vi.waitFor(() => expect(metadataRead).toHaveBeenCalledTimes(4));
      pending.abort();
      await closed;
      release();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(metadataRead).toHaveBeenCalledTimes(4);
    } finally {
      release();
      pending.abort();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it('lists only sessions whose newest prompt is interrupted', async () => {
    const fixture = makeFixture();
    const now = Date.now();
    const crashed = randomUUID();
    const shutdown = randomUUID();
    const settled = randomUUID();
    fixture.seed(crashed, [inFlight('p1', now - 2000)]);
    fixture.seed(shutdown, [
      inFlight('p1', now - 3000),
      terminal('p1', now - 1000, 'error', 'daemon_shutdown'),
    ]);
    fixture.seed(settled, [
      inFlight('p1', now - 4000),
      terminal('p1', now - 500, 'completed'),
    ]);

    const response = await request(fixture.app)
      .post('/sessions/recovery')
      .send({ workspaces: [fixture.runtime.workspaceId] });

    expect(response.status).toBe(200);
    const member = response.body.workspaces[0];
    expect(member).toMatchObject({
      workspace: fixture.runtime.workspaceId,
      workspaceId: fixture.runtime.workspaceId,
      cwd: fixture.runtime.workspaceCwd,
      v: 1,
      truncated: false,
    });
    expect(
      member.items.map((item: { sessionId: string }) => item.sessionId),
    ).toEqual([shutdown, crashed]);
    expect(
      member.items.map((item: { interruption: string }) => item.interruption),
    ).toEqual(['daemon_shutdown', 'in_flight']);
  });

  it('omits a session whose live prompt is still running', async () => {
    const fixture = makeFixture();
    fixture.seed(randomUUID(), [inFlight('p1', Date.now())]);
    Object.assign(fixture.runtime.bridge, {
      getSessionSummary: (() => ({
        hasActivePrompt: true,
      })) as unknown as AcpSessionBridge['getSessionSummary'],
    });

    const response = await request(fixture.app)
      .post('/sessions/recovery')
      .send({ workspaces: [fixture.runtime.workspaceId] });

    expect(response.status).toBe(200);
    expect(response.body.workspaces[0].items).toEqual([]);
  });

  it('drops a transcript whose record id is not a persisted session id', async () => {
    const fixture = makeFixture();
    const fileId = randomUUID();
    const invalidRecordId = 'not-a-persisted-session-id';
    fixture.seed(
      fileId,
      [inFlight('p1', Date.now())],
      undefined,
      invalidRecordId,
    );
    appendPromptLedgerRecord(
      fixture.sessionService.getPromptLedgerPath(invalidRecordId),
      inFlight('p1', Date.now()),
    );

    const response = await request(fixture.app)
      .post('/sessions/recovery')
      .send({ workspaces: [fixture.runtime.workspaceId] });

    expect(response.status).toBe(200);
    expect(response.body.workspaces[0].items).toEqual([]);
  });

  it('omits sessions moved to the archive', async () => {
    const fixture = makeFixture();
    const archived = randomUUID();
    fixture.seed(archived, [inFlight('p1', Date.now())]);
    await fixture.sessionService.archiveSessions([archived]);

    const response = await request(fixture.app)
      .post('/sessions/recovery')
      .send({ workspaces: [fixture.runtime.workspaceId] });

    expect(response.status).toBe(200);
    expect(response.body.workspaces[0].items).toEqual([]);
  });

  it('accepts an absolute workspace path', async () => {
    const fixture = makeFixture();
    fixture.seed(randomUUID(), [inFlight('p1', Date.now())]);

    const response = await request(fixture.app)
      .post('/sessions/recovery')
      .send({ workspaces: [fixture.runtime.workspaceCwd] });

    expect(response.status).toBe(200);
    expect(response.body.workspaces[0].items).toHaveLength(1);
  });

  it('honours the requested window', async () => {
    const fixture = makeFixture();
    const day = 24 * 60 * 60 * 1000;
    fixture.seed(randomUUID(), [inFlight('p1', Date.now() - 2 * day)]);

    const withinDefault = await request(fixture.app)
      .post('/sessions/recovery')
      .send({ workspaces: [fixture.runtime.workspaceId] });
    expect(withinDefault.body.workspaces[0].items).toEqual([]);

    const withinThreeDays = await request(fixture.app)
      .post('/sessions/recovery')
      .send({
        workspaces: [fixture.runtime.workspaceId],
        sinceMs: 3 * day,
      });
    expect(withinThreeDays.body.workspaces[0].items).toHaveLength(1);
  });

  it('clamps the requested window to 30 days', async () => {
    const fixture = makeFixture();
    const day = 24 * 60 * 60 * 1000;
    fixture.seed(randomUUID(), [inFlight('p1', Date.now() - 40 * day)]);

    const response = await request(fixture.app)
      .post('/sessions/recovery')
      .send({
        workspaces: [fixture.runtime.workspaceId],
        sinceMs: 60 * day,
      });

    expect(response.status).toBe(200);
    expect(response.body.workspaces[0].items).toEqual([]);
  });

  it('reports an unknown workspace as a member error', async () => {
    const fixture = makeFixture();
    const response = await request(fixture.app)
      .post('/sessions/recovery')
      .send({ workspaces: ['/no/such/workspace'] });

    expect(response.status).toBe(200);
    expect(response.body.workspaces[0]).toMatchObject({
      workspace: '/no/such/workspace',
      error: { code: 'workspace_not_found', status: 404 },
    });
  });

  it('never reads recoveries from a healthy primary for an unavailable secondary', async () => {
    const fixture = makeFixture(true, false);
    const primaryRuntime = fixture.primaryRuntime!;
    const primaryBridge = fixture.primaryBridge!;
    const primaryService = new SessionService(primaryRuntime.workspaceCwd, {
      runtimeBaseDir: fixture.runtime.sessionRuntimeBaseDir,
    });
    const primarySession = randomUUID();
    const ledgerDirectory = path.dirname(
      primaryService.getPromptLedgerPath(primarySession),
    );
    mkdirSync(ledgerDirectory, { recursive: true });
    writeFileSync(
      path.join(ledgerDirectory, `${primarySession}.jsonl`),
      `${JSON.stringify({
        uuid: 'user-1',
        parentUuid: null,
        sessionId: primarySession,
        timestamp: new Date().toISOString(),
        type: 'user',
        cwd: primaryRuntime.workspaceCwd,
        version: '1.0.0',
        message: { role: 'user', parts: [{ text: 'primary' }] },
      })}\n`,
      'utf8',
    );
    appendPromptLedgerRecord(
      primaryService.getPromptLedgerPath(primarySession),
      inFlight('p1', Date.now()),
    );
    const entry = fixture.registry.getEntryByWorkspaceId(
      fixture.runtime.workspaceId,
    );
    entry!.current!.guard.close();

    const response = await request(fixture.app)
      .post('/sessions/recovery')
      .send({ workspaces: [fixture.runtime.workspaceId] });

    expect(response.body.workspaces[0]).toMatchObject({
      workspace: fixture.runtime.workspaceId,
      error: { code: 'workspace_runtime_unavailable', status: 503 },
    });
    expect(primaryBridge.getSessionSummary).not.toHaveBeenCalled();
  });

  it('reports an unavailable runtime without falling back to primary', async () => {
    const fixture = makeFixture();
    const entry = fixture.registry.getEntryByWorkspaceId(
      fixture.runtime.workspaceId,
    );
    expect(entry?.current).toBeDefined();
    entry!.current!.guard.close();

    const response = await request(fixture.app)
      .post('/sessions/recovery')
      .send({ workspaces: [fixture.runtime.workspaceId] });

    expect(response.body.workspaces[0]).toMatchObject({
      workspace: fixture.runtime.workspaceId,
      error: { code: 'workspace_runtime_unavailable', status: 503 },
    });
  });

  it('rejects an untrusted workspace', async () => {
    const fixture = makeFixture(false);
    const response = await request(fixture.app)
      .post('/sessions/recovery')
      .send({ workspaces: [fixture.runtime.workspaceId] });

    expect(response.status).toBe(200);
    expect(response.body.workspaces[0]).toMatchObject({
      workspace: fixture.runtime.workspaceId,
      error: { code: 'untrusted_workspace', status: 403 },
    });
  });

  it('reports a member read failure as restart_recovery_failed', async () => {
    const fixture = makeFixture();
    vi.spyOn(
      SessionService.prototype,
      'listAllProjectSessionIds',
    ).mockRejectedValueOnce(new Error('storage read failed'));

    const response = await request(fixture.app)
      .post('/sessions/recovery')
      .send({ workspaces: [fixture.runtime.workspaceId] });

    expect(response.status).toBe(200);
    expect(response.body.workspaces[0]).toMatchObject({
      workspace: fixture.runtime.workspaceId,
      error: { code: 'restart_recovery_failed', status: 500 },
    });
  });

  it('rejects an over-limit workspace batch', async () => {
    const fixture = makeFixture();
    const response = await request(fixture.app)
      .post('/sessions/recovery')
      .send({
        workspaces: Array.from(
          { length: 21 },
          () => fixture.runtime.workspaceId,
        ),
      });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('invalid_restart_recovery_batch_request');
  });

  it('rejects an invalid batch body', async () => {
    const fixture = makeFixture();
    for (const body of [
      {},
      { workspaces: [] },
      { workspaces: [fixture.runtime.workspaceId], sinceMs: 0 },
      { workspaces: [fixture.runtime.workspaceId], extra: true },
    ]) {
      const response = await request(fixture.app)
        .post('/sessions/recovery')
        .send(body);
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('invalid_restart_recovery_batch_request');
    }
  });
});
