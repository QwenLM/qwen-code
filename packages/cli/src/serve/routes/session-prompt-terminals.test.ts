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

  it.each(['load', 'resume'] as const)(
    'validates summary modes on %s before restore',
    async (action) => {
      const fixture = makeFixture();
      const app = makeApp(fixture);
      for (const field of ['compactedReplayMode', 'liveReplayMode'] as const) {
        const response = await request(app)
          .post(`/session/${fixture.sessionId}/${action}`)
          .send({ [field]: 'invalid' });
        expect(response.status).toBe(400);
        expect(response.body.code).toBe(
          field === 'compactedReplayMode'
            ? 'invalid_compacted_replay_mode'
            : 'invalid_live_replay_mode',
        );
      }
      expect(fixture.runtime.bridge.loadSession).not.toHaveBeenCalled();
      expect(fixture.runtime.bridge.resumeSession).not.toHaveBeenCalled();
    },
  );

  it.each(['load', 'resume'] as const)(
    'forwards load-only summary fields only on load: %s',
    async (action) => {
      const fixture = makeFixture();
      writeTranscript(fixture, [chatRecord(fixture, 'u1', null, 'question')]);
      const response = await request(makeApp(fixture))
        .post(`/session/${fixture.sessionId}/${action}`)
        .send({
          historyPageSize: 200,
          liveReplayMode: 'summary',
          compactedReplayMode: 'summary',
        });
      expect(response.status).toBe(200);
      const restore = vi.mocked(
        action === 'load'
          ? fixture.runtime.bridge.loadSession
          : fixture.runtime.bridge.resumeSession,
      );
      const params = restore.mock.calls[0]?.[0];
      if (action === 'load')
        expect(params).toMatchObject({
          historyPageSize: 200,
          liveReplayMode: 'summary',
          compactedReplayMode: 'summary',
        });
      else {
        expect(params).not.toHaveProperty('historyPageSize');
        expect(params).not.toHaveProperty('liveReplayMode');
        expect(params).not.toHaveProperty('compactedReplayMode');
      }
    },
  );

  it.each(['prompt', 'mid-turn-message'] as const)(
    'rejects invalid eventDetailMode on %s',
    async (route) => {
      const fixture = makeFixture();
      vi.mocked(fixture.runtime.bridge.getSessionSummary).mockReturnValue({
        sessionId: fixture.sessionId,
      } as ReturnType<AcpSessionBridge['getSessionSummary']>);
      const response = await request(makeApp(fixture))
        .post(`/session/${fixture.sessionId}/${route}`)
        .send({
          prompt: [{ type: 'text', text: 'hello' }],
          message: 'hello',
          eventDetailMode: 'invalid',
        });
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('invalid_event_detail_mode');
    },
  );

  it.each(['full', 'summary'] as const)(
    'forwards prompt eventDetailMode to the owner: %s',
    async (eventDetailMode) => {
      const fixture = makeFixture();
      const bridge = fixture.runtime.bridge;
      vi.mocked(bridge.getSessionSummary).mockReturnValue({
        sessionId: fixture.sessionId,
      } as ReturnType<AcpSessionBridge['getSessionSummary']>);
      bridge.getSessionLastEventId = vi.fn(() => 0);
      bridge.getSessionEventEpoch = vi.fn(() => 'epoch');
      bridge.sendPrompt = vi.fn(async () => ({
        stopReason: 'end_turn' as const,
      }));
      const prompt = [{ type: 'text', text: 'hello' }];
      const response = await request(makeApp(fixture))
        .post(`/session/${fixture.sessionId}/prompt`)
        .send({ prompt, eventDetailMode });
      expect(response.status).toBe(202);
      expect(bridge.sendPrompt).toHaveBeenCalledWith(
        fixture.sessionId,
        { sessionId: fixture.sessionId, prompt, eventDetailMode },
        expect.any(AbortSignal),
        expect.objectContaining({ promptId: response.body.promptId }),
      );
    },
  );

  it('forwards mid-turn summary to the owner without changing idle rejection', async () => {
    const fixture = makeFixture();
    vi.mocked(fixture.runtime.bridge.getSessionSummary).mockReturnValue({
      sessionId: fixture.sessionId,
    } as ReturnType<AcpSessionBridge['getSessionSummary']>);
    fixture.runtime.bridge.enqueueMidTurnMessage = vi.fn(() => ({
      accepted: false,
      reason: 'session_idle' as const,
    }));
    const response = await request(makeApp(fixture))
      .post(`/session/${fixture.sessionId}/mid-turn-message`)
      .send({ message: 'hello', messageId: 'mid', eventDetailMode: 'summary' });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ accepted: false, reason: 'session_idle' });
    expect(fixture.runtime.bridge.enqueueMidTurnMessage).toHaveBeenCalledWith(
      fixture.sessionId,
      'hello',
      undefined,
      'mid',
      { rejectIfIdle: true, eventDetailMode: 'summary' },
    );
  });

  it.each([false, true])(
    'rejects invalid transcript summary mode (qualified=%s)',
    async (qualified) => {
      const fixture = makeFixture();
      const prefix = qualified
        ? `/workspaces/${encodeURIComponent(fixture.workspaceDir)}`
        : '';
      const response = await request(makeApp(fixture))
        .get(`${prefix}/session/${fixture.sessionId}/transcript`)
        .query({ compactedReplayMode: 'invalid' });
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('invalid_compacted_replay_mode');
    },
  );

  it.each([false, true])(
    'projects transcript summary without changing pagination (qualified=%s)',
    async (qualified) => {
      const fixture = makeFixture();
      const usage = {
        rounds: 1,
        totalDurationMs: 200,
        totalToolCalls: 1,
        successfulToolCalls: 1,
        failedToolCalls: 0,
        successRate: 100,
        thoughtTokens: 0,
        toolUsage: [],
        inputTokens: 100,
        outputTokens: 20,
        cachedTokens: 40,
        totalTokens: 120,
      };
      const output = {
        type: 'task_execution' as const,
        status: 'completed' as const,
        subagentName: 'reviewer',
        taskDescription: 'review',
        tokenCount: 20,
        result: 'agent answer',
        taskPrompt: 'nested prompt',
        toolCalls: [
          {
            callId: 'child-1',
            name: 'nested tool',
            status: 'success' as const,
          },
        ],
        executionSummary: usage,
      };
      writeTranscript(fixture, [
        chatRecord(fixture, 'u1', null, 'question'),
        {
          ...chatRecord(fixture, 'a1', 'u1', ''),
          message: {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'agent-1',
                  name: 'agent',
                  args: { prompt: 'nested prompt' },
                },
              },
            ],
          },
        },
        {
          ...chatRecord(fixture, 'r1', 'a1', ''),
          type: 'tool_result',
          toolCallResult: {
            callId: 'agent-1',
            status: 'success',
            resultDisplay: output,
          },
          message: {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: 'agent-1',
                  name: 'agent',
                  response: { output: 'agent answer' },
                },
              },
            ],
          },
        },
        chatRecord(fixture, 'a2', 'r1', 'main answer'),
      ]);
      fixture.runtime.bridge.getSessionTranscriptPage = vi.fn(async () => ({
        v: 1 as const,
        sessionId: fixture.sessionId,
        hasMore: true,
        nextCursor: 'next-page',
        targetRecordId: 'r1',
        hasOlder: true,
        events: [
          {
            v: 1 as const,
            type: 'session_update',
            data: {
              update: {
                sessionUpdate: 'tool_call_update',
                toolCallId: 'agent-1',
                status: 'completed',
                rawOutput: output,
              },
            },
          },
          {
            v: 1 as const,
            type: 'session_update',
            data: {
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: '' },
                _meta: { parentToolCallId: 'agent-1', usage },
              },
            },
          },
        ],
      }));
      const prefix = qualified
        ? `/workspaces/${encodeURIComponent(fixture.workspaceDir)}`
        : '';
      const app = makeApp(fixture);
      const fetchPage = (mode: string) =>
        request(app)
          .get(`${prefix}/session/${fixture.sessionId}/transcript`)
          .query({ compactedReplayMode: mode, limit: 200 });
      const full = await fetchPage('full');
      const summary = await fetchPage('summary');
      expect(full.status).toBe(200);
      expect(summary.status).toBe(200);
      const { events: fullEvents, ...fullPage } = full.body;
      const { events: summaryEvents, ...summaryPage } = summary.body;
      expect(summaryPage).toEqual(fullPage);
      expect(JSON.stringify(fullEvents)).toContain('parentToolCallId');
      expect(JSON.stringify(fullEvents)).toContain('nested tool');
      expect(JSON.stringify(summaryEvents)).not.toContain('parentToolCallId');
      expect(JSON.stringify(summaryEvents)).not.toContain('nested tool');
      expect(JSON.stringify(summaryEvents)).not.toContain('nested prompt');
      expect(JSON.stringify(summaryEvents)).toContain('agent answer');
      const completed = expect.objectContaining({
        rawOutput: expect.objectContaining({
          tokenCount: 20,
          executionSummary: usage,
        }),
      });
      expect(summaryEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            data: qualified
              ? completed
              : expect.objectContaining({ update: completed }),
          }),
        ]),
      );
    },
  );

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
