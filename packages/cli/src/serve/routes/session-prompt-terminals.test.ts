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
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionService, type ChatRecord } from '@qwen-code/qwen-code-core';
import {
  appendPromptLedgerRecord,
  readPromptLedgerRecords,
} from '@qwen-code/acp-bridge/promptLedger';
import {
  SessionNotFoundError,
  type AcpSessionBridge,
} from '../acp-session-bridge.js';
import {
  createWorkspaceRegistry,
  type WorkspaceRuntime,
} from '../workspace-registry.js';

const archiveMocks = vi.hoisted(() => ({
  assertSessionLoadable: vi.fn(),
}));

vi.mock('../server/session-archive.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../server/session-archive.js')>()),
  assertSessionLoadable: archiveMocks.assertSessionLoadable,
}));

import { registerSessionRoutes } from './session.js';

const tmpRoot = mkdtempSync(path.join(tmpdir(), 'session-prompt-terminals-'));
afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

interface Fixture {
  workspaceDir: string;
  sessionService: SessionService;
  sessionId: string;
  ledgerPath: string;
  runtime: WorkspaceRuntime;
}

function makeFixture(
  loadOverrides: { attached?: boolean; hasActivePrompt?: boolean } = {},
): Fixture {
  const workspaceDir = path.join(tmpRoot, randomUUID());
  mkdirSync(workspaceDir, { recursive: true });
  const runtimeBaseDir = path.join(tmpRoot, randomUUID());
  const sessionService = new SessionService(workspaceDir, {
    runtimeBaseDir,
  });
  const sessionId = randomUUID();
  const ledgerPath = sessionService.getPromptLedgerPath(sessionId);
  const bridge = bridgeWithColdLoad(sessionId, workspaceDir, loadOverrides);
  return {
    workspaceDir,
    sessionService,
    sessionId,
    ledgerPath,
    runtime: {
      workspaceId: randomUUID(),
      workspaceCwd: workspaceDir,
      sessionRuntimeBaseDir: runtimeBaseDir,
      primary: true,
      trusted: true,
      bridge,
    } as WorkspaceRuntime,
  };
}

function writeTranscript(fixture: Fixture, records: readonly ChatRecord[]) {
  const transcriptPath = path.join(
    path.dirname(fixture.ledgerPath),
    `${fixture.sessionId}.jsonl`,
  );
  mkdirSync(path.dirname(transcriptPath), { recursive: true });
  writeFileSync(
    transcriptPath,
    records.map((record) => JSON.stringify(record)).join('\n') + '\n',
    'utf8',
  );
}

function chatRecord(
  fixture: Fixture,
  uuid: string,
  parentUuid: string | null,
  text: string,
): ChatRecord {
  const isModel = uuid.startsWith('a');
  return {
    uuid,
    parentUuid,
    sessionId: fixture.sessionId,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, 0)).toISOString(),
    type: isModel ? 'assistant' : 'user',
    provenance: isModel ? 'assistant_output' : 'real_user',
    cwd: fixture.workspaceDir,
    version: '1.0.0',
    message: {
      role: isModel ? 'model' : 'user',
      parts: [{ text }],
    },
  };
}

function bridgeWithColdLoad(
  sessionId: string,
  workspaceCwd: string,
  loadOverrides: { attached?: boolean; hasActivePrompt?: boolean },
): AcpSessionBridge {
  const restored = {
    sessionId,
    attached: loadOverrides.attached ?? false,
    hasActivePrompt: loadOverrides.hasActivePrompt ?? false,
    currentCwd: workspaceCwd,
  };
  return {
    loadSession: vi.fn(async () => restored),
    resumeSession: vi.fn(async () => restored),
    getSessionSummary: vi.fn((requestedId: string) => {
      throw new SessionNotFoundError(requestedId);
    }),
  } as unknown as AcpSessionBridge;
}

function makeApp(fixture: Fixture) {
  const app = express();
  app.use(express.json());
  const registry = createWorkspaceRegistry([fixture.runtime]);
  registerSessionRoutes(app, {
    boundWorkspace: fixture.workspaceDir,
    bridge: fixture.runtime.bridge,
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
  return app;
}

describe('POST /session/:id/load prompt terminals', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    archiveMocks.assertSessionLoadable.mockResolvedValue('active');
  });

  it('reconciles a dangling prompt and returns promptTerminals', async () => {
    const fixture = makeFixture();
    writeTranscript(fixture, [
      chatRecord(fixture, 'u1', null, 'question'),
      chatRecord(fixture, 'a1', 'u1', 'answer'),
    ]);
    appendPromptLedgerRecord(fixture.ledgerPath, {
      v: 1,
      promptId: 'p-route-1',
      state: 'in_flight',
      at: 1,
    });
    const app = makeApp(fixture);

    const res = await request(app)
      .post(`/session/${fixture.sessionId}/load`)
      .send({});

    if (res.status !== 200) {
      throw new Error(`load failed: ${JSON.stringify(res.body)}`);
    }
    expect(res.body.promptTerminals).toEqual([
      {
        v: 1,
        promptId: 'p-route-1',
        terminal: 'completed',
        stopReason: 'reconstructed_from_transcript',
        at: expect.any(Number),
      },
    ]);
    // The verdict is persisted, so a later load sees it without redoing work.
    expect(readPromptLedgerRecords(fixture.ledgerPath)).toHaveLength(2);
  });

  it('omits the field when the session has no ledger', async () => {
    const fixture = makeFixture();
    writeTranscript(fixture, [
      chatRecord(fixture, 'u1', null, 'question'),
      chatRecord(fixture, 'a1', 'u1', 'answer'),
    ]);
    const app = makeApp(fixture);

    const res = await request(app)
      .post(`/session/${fixture.sessionId}/load`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.promptTerminals).toBeUndefined();
  });

  it('does not reconcile an attached load', async () => {
    const fixture = makeFixture({ attached: true });
    writeTranscript(fixture, [
      chatRecord(fixture, 'u1', null, 'question'),
      chatRecord(fixture, 'a1', 'u1', 'answer'),
    ]);
    appendPromptLedgerRecord(fixture.ledgerPath, {
      v: 1,
      promptId: 'p-live-1',
      state: 'in_flight',
      at: 1,
    });
    const app = makeApp(fixture);

    const res = await request(app)
      .post(`/session/${fixture.sessionId}/load`)
      .send({});

    expect(res.status).toBe(200);
    // Still dangling, no terminal to report, and no reconciliation ran.
    expect(res.body.promptTerminals).toBeUndefined();
    expect(readPromptLedgerRecords(fixture.ledgerPath)).toHaveLength(1);
  });

  it('does not reconcile a load while a prompt is active', async () => {
    const fixture = makeFixture({ hasActivePrompt: true });
    writeTranscript(fixture, [
      chatRecord(fixture, 'u1', null, 'question'),
      chatRecord(fixture, 'a1', 'u1', 'answer'),
    ]);
    appendPromptLedgerRecord(fixture.ledgerPath, {
      v: 1,
      promptId: 'p-active-1',
      state: 'in_flight',
      at: 1,
    });
    const app = makeApp(fixture);

    const res = await request(app)
      .post(`/session/${fixture.sessionId}/load`)
      .send({});

    expect(res.status).toBe(200);
    // The live entry owns the prompt's terminal; the ledger stays untouched.
    expect(res.body.promptTerminals).toBeUndefined();
    expect(readPromptLedgerRecords(fixture.ledgerPath)).toHaveLength(1);
  });

  it('keeps the resume response free of promptTerminals and appends nothing', async () => {
    const fixture = makeFixture();
    writeTranscript(fixture, [
      chatRecord(fixture, 'u1', null, 'question'),
      chatRecord(fixture, 'a1', 'u1', 'answer'),
    ]);
    appendPromptLedgerRecord(fixture.ledgerPath, {
      v: 1,
      promptId: 'p-resume-1',
      state: 'in_flight',
      at: 1,
    });
    const app = makeApp(fixture);

    const res = await request(app)
      .post(`/session/${fixture.sessionId}/resume`)
      .send({});

    expect(res.status).toBe(200);
    // Resume keeps its exact pre-existing response shape: no
    // promptTerminals field and no reconciliation append.
    expect(res.body.promptTerminals).toBeUndefined();
    expect(readPromptLedgerRecords(fixture.ledgerPath)).toHaveLength(1);
  });
});
