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
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionService, type ChatRecord } from '@qwen-code/qwen-code-core';
import {
  appendPromptLedgerRecord,
  type PromptLedgerRecord,
} from '@qwen-code/acp-bridge/promptLedger';
import type { AcpSessionBridge } from '../acp-session-bridge.js';
import {
  createWorkspaceRegistry,
  type WorkspaceRuntime,
} from '../workspace-registry.js';
import type { WorkspaceFileSystemFactory } from '../fs/index.js';
import { registerSessionRoutes } from './session.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

interface Fixture {
  runtime: WorkspaceRuntime;
  app: express.Express;
  seed(
    sessionId: string,
    records: readonly PromptLedgerRecord[],
    cwd?: string,
  ): void;
}

function makeFixture(trusted = true): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), 'session-restart-recovery-'));
  roots.push(root);
  const workspaceDir = path.join(root, 'workspace');
  const runtimeBaseDir = path.join(root, 'runtime');
  mkdirSync(workspaceDir, { recursive: true });
  const runtime = {
    workspaceId: randomUUID(),
    workspaceCwd: workspaceDir,
    sessionRuntimeBaseDir: runtimeBaseDir,
    primary: true,
    trusted,
    bridge: {} as AcpSessionBridge,
    routeFileSystemFactory: {
      forRequest: vi.fn(),
      assertCanWrite: vi.fn(),
    } as WorkspaceFileSystemFactory,
  } as WorkspaceRuntime;
  const sessionService = new SessionService(workspaceDir, { runtimeBaseDir });
  const app = express();
  app.use(express.json());
  registerSessionRoutes(app, {
    boundWorkspace: workspaceDir,
    bridge: runtime.bridge,
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
    app,
    seed(sessionId, records, cwd = workspaceDir) {
      const transcriptPath = path.join(
        path.dirname(sessionService.getPromptLedgerPath(sessionId)),
        `${sessionId}.jsonl`,
      );
      mkdirSync(path.dirname(transcriptPath), { recursive: true });
      const record: ChatRecord = {
        uuid: 'u1',
        parentUuid: null,
        sessionId,
        timestamp: new Date().toISOString(),
        type: 'user',
        provenance: 'real_user',
        cwd,
        version: '1.0.0',
        message: { role: 'user', parts: [{ text: 'hello' }] },
      };
      writeFileSync(transcriptPath, `${JSON.stringify(record)}\n`, 'utf8');
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

describe('POST /sessions/recovery', () => {
  it('lists only sessions whose newest prompt is interrupted', async () => {
    const fixture = makeFixture();
    const now = Date.now();
    const crashed = randomUUID();
    const shutdown = randomUUID();
    const settled = randomUUID();
    fixture.seed(crashed, [inFlight('p1', now - 2000)]);
    fixture.seed(shutdown, [
      inFlight('p1', now - 3000),
      terminal('p1', now - 1000, 'interrupted', 'daemon_shutdown'),
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
