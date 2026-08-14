/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockDebugLogger, mockAddDaemonRequestAttribute } = vi.hoisted(() => ({
  mockDebugLogger: {
    debug: vi.fn(),
    warn: vi.fn(),
  },
  mockAddDaemonRequestAttribute: vi.fn(),
}));

const { statFault } = vi.hoisted(() => ({
  statFault: { zeroInode: false },
}));

vi.mock('../utils/debugLogger.js', () => ({
  createDebugLogger: () => mockDebugLogger,
}));

vi.mock('../telemetry/daemon-tracing.js', () => ({
  addDaemonRequestAttribute: mockAddDaemonRequestAttribute,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    stat: async (...args: Parameters<typeof actual.stat>) => {
      const result = await actual.stat(...args);
      if (statFault.zeroInode) {
        Object.defineProperty(result, 'ino', { value: 0 });
      }
      return result;
    },
  };
});

import { Storage } from '../config/storage.js';
import type { ChatRecord } from './chatRecordingService.js';
import {
  buildApiHistoryFromConversation,
  getResumeTokenCounts,
  SessionService,
} from './sessionService.js';
import { collectSessionTurnState } from './session-turn-state.js';
import { recoverGoalFromRecords } from '../goals/goal-persistence.js';
import type { GoalStateRecordPayloadV2 } from '../goals/goal-protocol.js';
import { buildGoalEvidenceCheckpointWindow } from '../goals/goal-evidence.js';
import {
  SESSION_ARTIFACT_PERSISTENCE_VERSION,
  stableSessionArtifactId,
} from './session-artifact-persistence.js';
import {
  clearSessionTranscriptIndexCacheEntriesForTest,
  encodeSessionTranscriptCursor,
  getSessionTranscriptIndexCacheStatsForTest,
  InvalidSessionTranscriptCursorError,
  isReplayTurnStartType,
  SESSION_TRANSCRIPT_MAX_INDEX_BYTES,
  SESSION_TRANSCRIPT_MAX_LIMIT,
  resetSessionTranscriptIndexCacheForTest,
  setSessionTranscriptCooperativeReadBudgetForTest,
  setSessionTranscriptExpandedPageBytesForTest,
  setSessionTranscriptIndexBuildCompleteHookForTest,
  setSessionTranscriptIndexCacheMaxBytesForTest,
  setSessionTranscriptSelectedLineReadHookForTest,
  SessionTranscriptCursorCodec,
  SessionTranscriptSnapshotUnavailableError,
  SessionTranscriptReader,
} from './session-transcript-reader.js';

describe('SessionTranscriptReader', () => {
  let runtimeDir: string;
  let workspaceDir: string;
  const sessionId = '550e8400-e29b-41d4-a716-446655440000';

  beforeEach(async () => {
    vi.clearAllMocks();
    runtimeDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-transcript-reader-'),
    );
    workspaceDir = path.join(runtimeDir, 'workspace');
    await fs.mkdir(workspaceDir, { recursive: true });
    Storage.setRuntimeBaseDir(runtimeDir, workspaceDir);
  });

  afterEach(async () => {
    statFault.zeroInode = false;
    resetSessionTranscriptIndexCacheForTest();
    Storage.setRuntimeBaseDir(null);
    await fs.rm(runtimeDir, { recursive: true, force: true });
  });

  async function writeRecords(
    records: ChatRecord[],
    targetSessionId = sessionId,
  ): Promise<string> {
    const chatsDir = path.join(
      new Storage(workspaceDir).getProjectDir(),
      'chats',
    );
    await fs.mkdir(chatsDir, { recursive: true });
    const filePath = path.join(chatsDir, `${targetSessionId}.jsonl`);
    await fs.writeFile(
      filePath,
      records.map((record) => JSON.stringify(record)).join('\n') + '\n',
      'utf8',
    );
    return filePath;
  }

  async function writeRawTranscript(content: string): Promise<string> {
    const chatsDir = path.join(
      new Storage(workspaceDir).getProjectDir(),
      'chats',
    );
    await fs.mkdir(chatsDir, { recursive: true });
    const filePath = path.join(chatsDir, `${sessionId}.jsonl`);
    await fs.writeFile(filePath, content, 'utf8');
    return filePath;
  }

  // Monotonic, always-valid ISO 8601 timestamps in call order. Deriving the
  // seconds field from `text.length` produced invalid values (e.g. `00:00:013`)
  // once a record's text reached 10+ chars; a base + per-record offset keeps
  // every timestamp valid and strictly increasing regardless of count.
  const RECORD_BASE_MS = Date.UTC(2026, 0, 1, 0, 0, 0);
  let recordSeq = 0;
  function record(
    uuid: string,
    parentUuid: string | null,
    text: string,
    targetSessionId = sessionId,
  ): ChatRecord {
    return {
      uuid,
      parentUuid,
      sessionId: targetSessionId,
      timestamp: new Date(RECORD_BASE_MS + recordSeq++ * 1000).toISOString(),
      type: uuid.startsWith('a') ? 'assistant' : 'user',
      cwd: workspaceDir,
      version: '1.0.0',
      message: {
        role: uuid.startsWith('a') ? 'model' : 'user',
        parts: [{ text }],
      },
    };
  }

  function toolCallRecord(
    uuid: string,
    parentUuid: string,
    callId: string,
  ): ChatRecord {
    return {
      ...record(uuid, parentUuid, ''),
      message: {
        role: 'model',
        parts: [
          { functionCall: { name: 'run_shell_command', id: callId, args: {} } },
        ],
      },
    };
  }

  function toolResultRecord(
    uuid: string,
    parentUuid: string,
    callId: string,
  ): ChatRecord {
    return {
      ...record(uuid, parentUuid, ''),
      type: 'tool_result',
      message: {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: 'run_shell_command',
              id: callId,
              response: { output: 'ok' },
            },
          },
        ],
      },
      toolCallResult: { callId, status: 'success' },
    };
  }

  function encodeCursor(
    state: Parameters<typeof encodeSessionTranscriptCursor>[0],
  ): string {
    return encodeSessionTranscriptCursor(state, workspaceDir);
  }

  it('rejects an empty transcript snapshot', async () => {
    await writeRawTranscript('');

    await expect(
      new SessionTranscriptReader(workspaceDir).readPage(sessionId),
    ).rejects.toBeInstanceOf(SessionTranscriptSnapshotUnavailableError);
  });

  it('returns a single-record transcript without a continuation cursor', async () => {
    const filePath = await writeRecords([record('u1', null, 'only record')]);

    const page = await new SessionTranscriptReader(workspaceDir).readPage(
      sessionId,
    );

    expect(page.records.map((item) => item.uuid)).toEqual(['u1']);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursorState).toBeUndefined();
    // Required SessionTranscriptRecordPage fields (the strict-ISO checks also
    // guard against invalid timestamps from the record() helper).
    expect(page.sessionId).toBe(sessionId);
    expect(page.filePath).toBe(filePath);
    const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
    expect(page.startTime).toMatch(ISO_8601);
    expect(page.lastUpdated).toMatch(ISO_8601);
  });

  it('retains content with an invalid record timestamp', async () => {
    const invalidTimestamp = record('u1', null, 'kept content');
    invalidTimestamp.timestamp = 'not-a-date';
    await writeRecords([invalidTimestamp]);

    const page = await new SessionTranscriptReader(workspaceDir).readPage(
      sessionId,
    );

    expect(page.records).toHaveLength(1);
    expect(page.records[0]).toMatchObject({ uuid: 'u1' });
    expect(page.records[0]?.timestamp).toBeUndefined();
    expect(Number.isFinite(new Date(page.startTime).getTime())).toBe(true);
  });

  it('does not select a trailing artifact record as the active leaf', async () => {
    const root = record('u1', null, 'conversation');
    const artifact: ChatRecord = {
      ...record('artifact', 'u1', 'side channel'),
      type: 'system',
      subtype: 'session_artifact_event',
      message: undefined,
    };
    await writeRecords([root, artifact]);

    const page = await new SessionTranscriptReader(workspaceDir).readPage(
      sessionId,
    );

    expect(page.records.map((item) => item.uuid)).toEqual(['u1']);
  });

  it.each([0, -1, NaN, Infinity, SESSION_TRANSCRIPT_MAX_LIMIT + 1, 1.5])(
    'rejects invalid page limit %s',
    async (limit) => {
      await expect(
        new SessionTranscriptReader(workspaceDir).readPage(sessionId, {
          limit,
        }),
      ).rejects.toBeInstanceOf(RangeError);
    },
  );

  it.each([0, -1, 1.5])(
    'rejects invalid page byte limit %s',
    async (maxBytes) => {
      await expect(
        new SessionTranscriptReader(workspaceDir).readPage(sessionId, {
          maxBytes,
        }),
      ).rejects.toBeInstanceOf(RangeError);
    },
  );

  it('stops at a record boundary when the page byte budget is reached', async () => {
    const records = [
      record('u1', null, 'first'),
      record('a1', 'u1', 'second'),
      record('u2', 'a1', 'third'),
    ];
    await writeRecords(records);
    const firstTwoBytes =
      Buffer.byteLength(JSON.stringify(records[0])) +
      Buffer.byteLength(JSON.stringify(records[1]));
    const reader = new SessionTranscriptReader(workspaceDir);

    const first = await reader.readPage(sessionId, {
      limit: 3,
      maxBytes: firstTwoBytes,
    });
    const second = await reader.readPage(sessionId, {
      cursor: encodeCursor(first.nextCursorState!),
      limit: 3,
      maxBytes: firstTwoBytes,
    });

    expect(first.records.map((item) => item.uuid)).toEqual(['u1', 'a1']);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursorState?.position).toBe(2);
    expect(second.records.map((item) => item.uuid)).toEqual(['u2']);
    expect(second.hasMore).toBe(false);
  });

  it('returns a single aggregate record that exceeds the page byte budget', async () => {
    const first = record('u1', null, 'first');
    const second = record('u1', null, 'second fragment');
    await writeRecords([first, second, record('a1', 'u1', 'reply')]);
    const aggregateBytes =
      Buffer.byteLength(JSON.stringify(first)) +
      Buffer.byteLength(JSON.stringify(second));

    const page = await new SessionTranscriptReader(workspaceDir).readPage(
      sessionId,
      {
        limit: 1,
        maxBytes: aggregateBytes - 1,
      },
    );

    // An indivisible record rides over budget rather than dead-ending the page.
    expect(page.records.map((item) => item.uuid)).toEqual(['u1']);
    expect(page.hasMore).toBe(true);
  });

  it('pages only the active parentUuid chain and skips abandoned branches', async () => {
    await writeRecords([
      record('u1', null, 'root'),
      record('a1', 'u1', 'old assistant'),
      record('u2-old', 'a1', 'abandoned'),
      record('a2-old', 'u2-old', 'abandoned reply'),
      record('u2-new', 'a1', 'active'),
      record('a2-new', 'u2-new', 'active reply'),
    ]);

    const reader = new SessionTranscriptReader(workspaceDir);
    const first = await reader.readPage(sessionId, { limit: 2 });
    expect(first.nextCursorState).toBeDefined();
    const second = await reader.readPage(sessionId, {
      cursor: encodeCursor(first.nextCursorState!),
      limit: 2,
    });

    expect(first.records.map((r) => r.uuid)).toEqual(['u1', 'a1']);
    expect(first.hasMore).toBe(true);
    expect(second.records.map((r) => r.uuid)).toEqual(['u2-new', 'a2-new']);
    expect(second.hasMore).toBe(false);
    expect(second.nextCursorState).toBeUndefined();
  });

  it('pages backward before an exclusive active record boundary', async () => {
    await writeRecords([
      record('u1', null, 'first prompt'),
      record('a1', 'u1', 'first answer'),
      record('u2', 'a1', 'second prompt'),
      record('a2', 'u2', 'second answer'),
      record('u3', 'a2', 'third prompt'),
      record('a3', 'u3', 'third answer'),
    ]);

    const reader = new SessionTranscriptReader(workspaceDir);
    const first = await reader.readPage(sessionId, {
      beforeRecordId: 'u3',
      limit: 2,
    });
    const second = await reader.readPage(sessionId, {
      beforeRecordId: first.records[0]!.uuid,
      limit: 2,
    });

    expect(first.records.map((item) => item.uuid)).toEqual(['u2', 'a2']);
    expect(first.direction).toBe('backward');
    expect(first.hasMore).toBe(true);
    expect(first.nextCursorState).toMatchObject({
      position: 2,
      direction: 'backward',
    });
    expect(second.records.map((item) => item.uuid)).toEqual(['u1', 'a1']);
    expect(second.hasMore).toBe(false);
  });

  it('starts backward paging at the persisted tail', async () => {
    await writeRecords([
      record('u1', null, 'first prompt'),
      record('a1', 'u1', 'first answer'),
      record('u2', 'a1', 'second prompt'),
      record('a2', 'u2', 'second answer'),
    ]);

    const reader = new SessionTranscriptReader(workspaceDir);
    const page = await reader.readPage(sessionId, {
      direction: 'backward',
      limit: 2,
    });

    expect(page.records.map((item) => item.uuid)).toEqual(['u2', 'a2']);
    expect(page.direction).toBe('backward');
    expect(page.hasMore).toBe(true);
    expect(page.nextCursorState).toMatchObject({
      position: 2,
      direction: 'backward',
    });
  });

  it('seeds backward replay from the latest authoritative Goal state', async () => {
    const goalState: ChatRecord = {
      ...record('goal-state', null, 'ignored'),
      type: 'system',
      subtype: 'goal_state',
      message: undefined,
      systemPayload: {
        v: 2,
        cause: 'create',
        snapshot: {
          v: 2,
          activity: 'idle',
          goal: {
            goalId: 'goal-1',
            revision: 1,
            objective: 'ship backward replay',
            status: 'active',
            evidenceCursor: { recordId: null },
            turnCount: 0,
            activeTimeMs: 0,
            createdAt: 1,
            updatedAt: 1,
          },
        },
      },
    };
    const clearState: ChatRecord = {
      ...record('goal-clear', 'u2', 'ignored'),
      type: 'system',
      subtype: 'goal_state',
      message: undefined,
      systemPayload: {
        v: 2,
        cause: 'clear',
        snapshot: { v: 2, activity: 'idle', goal: null },
      },
    };
    await writeRecords([
      goalState,
      record('u1', 'goal-state', 'first prompt'),
      record('a1', 'u1', 'first answer'),
      record('u2', 'a1', 'second prompt'),
      clearState,
      record('a2', 'goal-clear', 'second answer'),
      record('u3', 'a2', 'third prompt'),
    ]);

    const page = await new SessionTranscriptReader(workspaceDir).readPage(
      sessionId,
      { beforeRecordId: 'u3', limit: 2 },
    );

    expect(page.records.map((item) => item.uuid)).toEqual([
      'u2',
      'goal-clear',
      'a2',
    ]);
    expect(page.replay).toMatchObject({
      goalState: {
        v: 2,
        activity: 'idle',
        goal: { objective: 'ship backward replay' },
      },
      goalCause: 'create',
    });
  });

  it('does not revive older Goal state when the latest state is malformed', async () => {
    const validGoalState: ChatRecord = {
      ...record('goal-state', null, 'ignored'),
      type: 'system',
      subtype: 'goal_state',
      message: undefined,
      systemPayload: {
        v: 2,
        cause: 'create',
        snapshot: {
          v: 2,
          activity: 'idle',
          goal: {
            goalId: 'goal-1',
            revision: 1,
            objective: 'do not revive me',
            status: 'active',
            evidenceCursor: { recordId: null },
            turnCount: 0,
            activeTimeMs: 0,
            createdAt: 1,
            updatedAt: 1,
          },
        },
      },
    };
    const malformedGoalState: ChatRecord = {
      ...record('goal-invalid', 'a1', 'ignored'),
      type: 'system',
      subtype: 'goal_state',
      message: undefined,
      systemPayload: {
        v: 2,
        cause: 'clear',
        // Truthy but invalid: the parser only accepts `activity === 'idle'`,
        // so a `running` snapshot must be rejected. A falsy `null` here would
        // pass even with the validation deleted, leaving the guard untested.
        snapshot: {
          v: 2,
          activity: 'running',
          goal: {
            goalId: 'goal-1',
            revision: 1,
            objective: 'do not revive me',
            status: 'active',
            evidenceCursor: { recordId: null },
            turnCount: 0,
            activeTimeMs: 0,
            createdAt: 1,
            updatedAt: 1,
          },
        },
      } as unknown as ChatRecord['systemPayload'],
    };
    await writeRecords([
      validGoalState,
      record('u1', 'goal-state', 'first prompt'),
      record('a1', 'u1', 'first answer'),
      malformedGoalState,
      record('u2', 'goal-invalid', 'second prompt'),
      record('a2', 'u2', 'second answer'),
      record('u3', 'a2', 'third prompt'),
    ]);

    const page = await new SessionTranscriptReader(workspaceDir).readPage(
      sessionId,
      { beforeRecordId: 'u3', limit: 2 },
    );

    expect(page.records.map((item) => item.uuid)).toEqual(['u2', 'a2']);
    expect(page.replay).toBeUndefined();
  });

  it('includes leading session metadata with the first backward page', async () => {
    const sessionSource = {
      ...record('source', null, 'session source'),
      type: 'system' as const,
      subtype: 'session_source' as const,
    };
    await writeRecords([
      sessionSource,
      record('u1', 'source', 'first prompt'),
      record('a1', 'u1', 'first answer'),
    ]);

    const page = await new SessionTranscriptReader(workspaceDir).readPage(
      sessionId,
      { direction: 'backward', limit: 100 },
    );

    expect(page.records.map((item) => item.uuid)).toEqual([
      'source',
      'u1',
      'a1',
    ]);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursorState).toBeUndefined();
  });

  it('does not page into inherited side-task context', async () => {
    const inheritedUser = {
      ...record('parent-u1', 'source', 'parent prompt'),
      forkedFrom: {
        sessionId: 'parent-session',
        messageUuid: 'parent-u1',
      },
    };
    const inheritedAssistant = {
      ...record('parent-a1', 'parent-u1', 'parent answer'),
      forkedFrom: {
        sessionId: 'parent-session',
        messageUuid: 'parent-a1',
      },
    };
    const sessionSource = {
      ...record('source', null, 'session source'),
      type: 'system' as const,
      subtype: 'session_source' as const,
      systemPayload: {
        sourceType: 'side_task',
        sourceId: 'parent-session',
      },
    };
    await writeRecords([
      sessionSource,
      inheritedUser,
      inheritedAssistant,
      record('side-u1', 'parent-a1', 'side prompt'),
      record('side-a1', 'side-u1', 'side answer'),
    ]);

    const page = await new SessionTranscriptReader(workspaceDir).readPage(
      sessionId,
      { direction: 'backward', limit: 100 },
    );

    expect(page.records.map((item) => item.uuid)).toEqual([
      'source',
      'side-u1',
      'side-a1',
    ]);
    expect(page.hasMore).toBe(false);
  });

  it('derives the side-task boundary from the active chain', async () => {
    const sessionSource = {
      ...record('source', null, 'session source'),
      type: 'system' as const,
      subtype: 'session_source' as const,
      systemPayload: {
        sourceType: 'side_task',
        sourceId: 'parent-session',
      },
    };
    const inheritedUser = {
      ...record('parent-u1', 'source', 'parent prompt'),
      forkedFrom: {
        sessionId: 'parent-session',
        messageUuid: 'parent-u1',
      },
    };
    const deadBranchSource = {
      ...record('dead-source', 'parent-u1', 'dead source'),
      type: 'system' as const,
      subtype: 'session_source' as const,
      systemPayload: {
        sourceType: 'side_task',
        sourceId: 'abandoned-parent',
      },
    };
    await writeRecords([
      sessionSource,
      inheritedUser,
      record('side-u1', 'parent-u1', 'side prompt'),
      deadBranchSource,
      record('side-a1', 'side-u1', 'side answer'),
    ]);

    const page = await new SessionTranscriptReader(workspaceDir).readPage(
      sessionId,
      { direction: 'backward', limit: 100 },
    );

    expect(page.records.map((item) => item.uuid)).toEqual([
      'source',
      'side-u1',
      'side-a1',
    ]);
  });

  it('derives a fragmented session source from the first fragment', async () => {
    const source: ChatRecord = {
      ...record('source', null, ''),
      type: 'system',
      subtype: 'session_source',
      message: undefined,
      systemPayload: { sourceType: 'daemon' },
    };
    const conflictingFragment: ChatRecord = {
      ...source,
      systemPayload: { sourceType: 'side_task', sourceId: 'parent-session' },
    };
    const inherited = {
      ...record('parent-u1', 'source', 'parent prompt'),
      forkedFrom: {
        sessionId: 'parent-session',
        messageUuid: 'parent-u1',
      },
    };
    await writeRecords([
      source,
      conflictingFragment,
      inherited,
      record('u1', 'parent-u1', 'current prompt'),
    ]);

    const page = await new SessionTranscriptReader(workspaceDir).readPage(
      sessionId,
    );

    expect(page.records.map(({ uuid }) => uuid)).toEqual([
      'source',
      'parent-u1',
      'u1',
    ]);
  });

  it('builds a cold runtime projection with full-loader parity', async () => {
    const source: ChatRecord = {
      ...record('source', null, 'source'),
      type: 'system',
      subtype: 'session_source',
      message: undefined,
      systemPayload: { sourceType: 'daemon', sourceId: 'restore-test' },
    };
    const firstUser = record('u1', 'source', 'first prompt') as ChatRecord & {
      promptId: string;
    };
    firstUser.promptId = `${sessionId}########3`;
    const firstAssistant: ChatRecord = {
      ...record('a1', 'u1', 'first answer'),
      usageMetadata: {
        promptTokenCount: 30,
        candidatesTokenCount: 4,
        totalTokenCount: 34,
      },
    };
    const compression: ChatRecord = {
      ...record('compression', 'a1', ''),
      type: 'system',
      subtype: 'chat_compression',
      message: undefined,
      systemPayload: {
        compressedHistory: [
          { role: 'user', parts: [{ text: 'compressed prompt' }] },
          { role: 'model', parts: [{ text: 'compressed answer' }] },
        ],
        info: { newTokenCount: 20, newTokenCountIsEstimated: false },
      } as ChatRecord['systemPayload'],
    };
    const uiEvent = { prompt_id: `${sessionId}########7`, duration_ms: 12 };
    const telemetry: ChatRecord = {
      ...record('telemetry', 'compression', ''),
      type: 'system',
      subtype: 'ui_telemetry',
      message: undefined,
      systemPayload: { uiEvent } as ChatRecord['systemPayload'],
    };
    const attributionSnapshot = { v: 1, commits: [] };
    const attribution: ChatRecord = {
      ...record('attribution', 'telemetry', ''),
      type: 'system',
      subtype: 'attribution_snapshot',
      message: undefined,
      systemPayload: {
        snapshot: attributionSnapshot,
      } as unknown as ChatRecord['systemPayload'],
    };
    const fileHistory: ChatRecord = {
      ...record('files', 'attribution', ''),
      type: 'system',
      subtype: 'file_history_snapshot',
      message: undefined,
      systemPayload: {
        snapshots: [
          {
            promptId: `${sessionId}########3`,
            timestamp: '2026-01-01T00:00:00.000Z',
            trackedFileBackups: {},
          },
        ],
      },
    };
    const goalPayload: GoalStateRecordPayloadV2 = {
      v: 2,
      cause: 'create',
      snapshot: {
        v: 2,
        activity: 'idle',
        goal: {
          goalId: 'goal-1',
          revision: 1,
          objective: 'finish the restore',
          status: 'active',
          evidenceCursor: { recordId: 'goal' },
          turnCount: 1,
          activeTimeMs: 0,
          createdAt: 1,
          updatedAt: 1,
        },
      },
    };
    const goal: ChatRecord = {
      ...record('goal', 'files', ''),
      type: 'system',
      subtype: 'goal_state',
      message: undefined,
      systemPayload: goalPayload,
    };
    const notification: ChatRecord = {
      ...record('notification', 'goal', 'background result'),
      subtype: 'notification',
      systemPayload: {
        backgroundTask: { taskId: 'task-1' },
      } as ChatRecord['systemPayload'],
    };
    const artifactId = stableSessionArtifactId(
      sessionId,
      'url:https://example.com/report',
    );
    const artifact: ChatRecord = {
      ...record('artifact', 'notification', ''),
      type: 'system',
      subtype: 'session_artifact_event',
      message: undefined,
      systemPayload: {
        v: SESSION_ARTIFACT_PERSISTENCE_VERSION,
        sessionId,
        sequence: 1,
        recordedAt: '2026-01-01T00:00:01.000Z',
        changes: [
          {
            action: 'created',
            artifactId,
            artifact: {
              id: artifactId,
              kind: 'link',
              storage: 'external_url',
              source: 'client',
              status: 'available',
              title: 'Report',
              url: 'https://example.com/report',
              retention: 'restorable',
              clientRetained: true,
              createdAt: '2026-01-01T00:00:01.000Z',
              updatedAt: '2026-01-01T00:00:01.000Z',
              persistedAt: '2026-01-01T00:00:01.000Z',
            },
          },
        ],
      },
    };
    const secondAssistant = record('a2', 'notification', 'after compression');
    const title: ChatRecord = {
      ...record('title', 'a2', ''),
      type: 'system',
      subtype: 'custom_title',
      message: undefined,
      systemPayload: { customTitle: 'Restored', titleSource: 'manual' },
    };
    await writeRecords([
      source,
      firstUser,
      firstAssistant,
      compression,
      telemetry,
      attribution,
      fileHistory,
      goal,
      notification,
      artifact,
      secondAssistant,
      title,
    ]);

    const service = new SessionService(workspaceDir, {
      runtimeBaseDir: runtimeDir,
    });
    const [loaded, projection] = await Promise.all([
      service.loadSession(sessionId),
      service.readRestoreProjection(sessionId, {
        replay: { kind: 'none' },
      }),
    ]);

    expect(loaded).toBeDefined();
    expect(projection).toBeDefined();
    expect(projection?.replay).toBeUndefined();
    expect(projection?.runtime.apiHistory).toEqual(
      buildApiHistoryFromConversation(loaded!.conversation),
    );
    expect(projection?.runtime.resumeTokenCounts).toEqual(
      getResumeTokenCounts(loaded!.conversation),
    );
    expect(projection?.runtime.fileHistorySnapshots).toEqual(
      loaded?.fileHistorySnapshots,
    );
    expect(projection?.runtime.artifactSnapshot).toEqual(
      loaded?.artifactSnapshot,
    );
    expect(projection?.runtime.recording.lastCompletedUuid).toBe(
      loaded?.lastCompletedUuid,
    );
    const expectedTurnState = collectSessionTurnState(
      loaded!.conversation.messages,
      sessionId,
    );
    expect(projection?.runtime.recording.turnParentUuids).toEqual(
      expectedTurnState.turnParentUuids,
    );
    expect(projection?.runtime.initialTurn).toBe(expectedTurnState.initialTurn);
    expect(projection?.runtime.backgroundNotificationTaskIds).toEqual(
      expectedTurnState.backgroundNotificationTaskIds,
    );
    expect(projection?.runtime.uiTelemetryEvents).toEqual([uiEvent]);
    expect(projection?.runtime.attributionSnapshot).toEqual(
      attributionSnapshot,
    );
    expect(projection?.runtime.recording).toMatchObject({
      customTitle: 'Restored',
      titleSource: 'manual',
      sourceType: 'daemon',
      sourceId: 'restore-test',
    });
    expect(recoverGoalFromRecords(projection!.runtime.goalRecords)).toEqual(
      recoverGoalFromRecords(loaded!.conversation.messages),
    );
    expect(mockAddDaemonRequestAttribute).toHaveBeenCalledWith(
      'qwen-code.daemon.session_restore.transcript_index_ms',
      expect.any(Number),
    );
    expect(mockAddDaemonRequestAttribute).toHaveBeenCalledWith(
      'qwen-code.daemon.session_restore.resume_state_select_ms',
      expect.any(Number),
    );
    expect(mockAddDaemonRequestAttribute).toHaveBeenCalledWith(
      'qwen-code.daemon.session_restore.selected_record_read_ms',
      expect.any(Number),
    );
    for (const attribute of [
      'transcript_bytes',
      'records_indexed',
      'active_records',
      'selected_records',
      'selected_bytes',
      'replay_records',
      'replay_bytes',
    ]) {
      expect(mockAddDaemonRequestAttribute).toHaveBeenCalledWith(
        `qwen-code.daemon.session_restore.${attribute}`,
        expect.any(Number),
      );
    }
    expect(mockAddDaemonRequestAttribute).toHaveBeenCalledWith(
      'qwen-code.daemon.session_restore.index_cache_state',
      'fresh',
    );
    expect(mockAddDaemonRequestAttribute).toHaveBeenCalledWith(
      'qwen-code.daemon.session_restore.replay_mode',
      'none',
    );
    expect(mockAddDaemonRequestAttribute).toHaveBeenCalledWith(
      'qwen-code.daemon.session_restore.compression_selected',
      expect.any(Boolean),
    );
  });

  it('uses the bounded persisted-title picker instead of the full active chain', async () => {
    const largeText = 'x'.repeat(70 * 1024);
    const title: ChatRecord = {
      ...record('title', 'u1', ''),
      type: 'system',
      subtype: 'custom_title',
      message: undefined,
      systemPayload: { customTitle: 'Middle title', titleSource: 'manual' },
    };
    await writeRecords([
      record('u1', null, largeText),
      title,
      record('a1', 'title', largeText),
    ]);

    const service = new SessionService(workspaceDir, {
      runtimeBaseDir: runtimeDir,
    });
    const projection = await service.readRestoreProjection(sessionId, {
      replay: { kind: 'none' },
    });

    expect(service.getSessionTitleInfo(sessionId)).toEqual({});
    expect(projection?.runtime.recording.customTitle).toBeUndefined();
    expect(projection?.runtime.recording.titleSource).toBeUndefined();
  });

  it('matches full-loader artifact selection across an abandoned branch', async () => {
    const activeArtifactId = stableSessionArtifactId(
      sessionId,
      'url:https://example.com/active',
    );
    const abandonedArtifactId = stableSessionArtifactId(
      sessionId,
      'url:https://example.com/abandoned',
    );
    const artifactRecord = (
      uuid: string,
      parentUuid: string,
      sequence: number,
      artifactId: string,
      url: string,
    ): ChatRecord => ({
      ...record(uuid, parentUuid, ''),
      type: 'system',
      subtype: 'session_artifact_event',
      message: undefined,
      systemPayload: {
        v: SESSION_ARTIFACT_PERSISTENCE_VERSION,
        sessionId,
        sequence,
        recordedAt: `2026-01-01T00:00:0${sequence}.000Z`,
        changes: [
          {
            action: 'created',
            artifactId,
            artifact: {
              id: artifactId,
              kind: 'link',
              storage: 'external_url',
              source: 'client',
              status: 'available',
              title: url,
              url,
              retention: 'restorable',
              clientRetained: true,
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z',
              persistedAt: '2026-01-01T00:00:00.000Z',
            },
          },
        ],
      },
    });
    await writeRecords([
      record('u1', null, 'prompt'),
      record('a1', 'u1', 'answer'),
      record('abandoned', 'a1', 'dead branch'),
      artifactRecord(
        'abandoned-artifact',
        'abandoned',
        2,
        abandonedArtifactId,
        'https://example.com/abandoned',
      ),
      artifactRecord(
        'active-artifact',
        'a1',
        1,
        activeArtifactId,
        'https://example.com/active',
      ),
      record('u2', 'a1', 'next prompt'),
      record('a2', 'u2', 'next answer'),
    ]);

    const service = new SessionService(workspaceDir, {
      runtimeBaseDir: runtimeDir,
    });
    const [loaded, projection] = await Promise.all([
      service.loadSession(sessionId),
      service.readRestoreProjection(sessionId, {
        replay: { kind: 'none' },
      }),
    ]);

    expect(projection?.runtime.artifactSnapshot).toEqual(
      loaded?.artifactSnapshot,
    );
    expect(
      projection?.runtime.artifactSnapshot?.artifacts.map(({ id }) => id),
    ).toEqual([activeArtifactId]);
  });

  it('uses a leading artifact record as the restore start time', async () => {
    const leadingTimestamp = '2025-12-31T23:59:59.000Z';
    const artifactId = stableSessionArtifactId(
      sessionId,
      'url:https://example.com/leading',
    );
    const leadingArtifact: ChatRecord = {
      ...record('leading-artifact', null, ''),
      timestamp: leadingTimestamp,
      type: 'system',
      subtype: 'session_artifact_event',
      message: undefined,
      systemPayload: {
        v: SESSION_ARTIFACT_PERSISTENCE_VERSION,
        sessionId,
        sequence: 1,
        recordedAt: leadingTimestamp,
        changes: [
          {
            action: 'created',
            artifactId,
            artifact: {
              id: artifactId,
              kind: 'link',
              storage: 'external_url',
              source: 'client',
              status: 'available',
              title: 'Leading artifact',
              url: 'https://example.com/leading',
              retention: 'restorable',
              clientRetained: true,
              createdAt: leadingTimestamp,
              updatedAt: leadingTimestamp,
              persistedAt: leadingTimestamp,
            },
          },
        ],
      },
    };
    await writeRecords([leadingArtifact, record('u1', null, 'prompt')]);

    const service = new SessionService(workspaceDir, {
      runtimeBaseDir: runtimeDir,
    });
    const [loaded, projection] = await Promise.all([
      service.loadSession(sessionId),
      service.readRestoreProjection(sessionId, {
        replay: { kind: 'none' },
      }),
    ]);

    expect(projection?.startTime).toBe(loaded?.conversation.startTime);
    expect(projection?.startTime).toBe(leadingTimestamp);
  });

  it('preserves physical active-fragment markers for artifact selection', async () => {
    const artifactId = stableSessionArtifactId(
      sessionId,
      'url:https://example.com/fragmented',
    );
    const artifact: ChatRecord = {
      ...record('artifact', 'u1', ''),
      type: 'system',
      subtype: 'session_artifact_event',
      message: undefined,
      systemPayload: {
        v: SESSION_ARTIFACT_PERSISTENCE_VERSION,
        sessionId,
        sequence: 1,
        recordedAt: '2026-01-01T00:00:01.000Z',
        changes: [
          {
            action: 'created',
            artifactId,
            artifact: {
              id: artifactId,
              kind: 'link',
              storage: 'external_url',
              source: 'client',
              status: 'available',
              title: 'Fragmented',
              url: 'https://example.com/fragmented',
              retention: 'restorable',
              clientRetained: true,
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z',
              persistedAt: '2026-01-01T00:00:00.000Z',
            },
          },
        ],
      },
    };
    await writeRecords([
      record('u1', null, 'first fragment'),
      artifact,
      record('u1', null, 'second fragment'),
      record('dead', null, 'abandoned blocker'),
      record('u1', null, 'final fragment'),
    ]);

    const service = new SessionService(workspaceDir, {
      runtimeBaseDir: runtimeDir,
    });
    const [loaded, projection] = await Promise.all([
      service.loadSession(sessionId),
      service.readRestoreProjection(sessionId, {
        replay: { kind: 'none' },
      }),
    ]);

    expect(projection?.runtime.artifactSnapshot).toEqual(
      loaded?.artifactSnapshot,
    );
    expect(
      projection?.runtime.artifactSnapshot?.artifacts.map(({ id }) => id),
    ).toEqual([artifactId]);
  });

  it('selects recent restore replay with an older Goal bootstrap', async () => {
    const goalPayload: GoalStateRecordPayloadV2 = {
      v: 2,
      cause: 'create',
      snapshot: {
        v: 2,
        activity: 'idle',
        goal: {
          goalId: 'goal-1',
          revision: 1,
          objective: 'continue',
          status: 'active',
          evidenceCursor: { recordId: 'goal' },
          turnCount: 1,
          activeTimeMs: 0,
          createdAt: 1,
          updatedAt: 1,
        },
      },
    };
    await writeRecords([
      record('u1', null, 'one'),
      record('a1', 'u1', 'one answer'),
      {
        ...record('goal', 'a1', ''),
        type: 'system',
        subtype: 'goal_state',
        message: undefined,
        systemPayload: goalPayload,
      },
      record('u2', 'goal', 'two'),
      record('a2', 'u2', 'two answer'),
      record('u3', 'a2', 'three'),
      record('a3', 'u3', 'three answer'),
    ]);

    const projection = await new SessionTranscriptReader(
      workspaceDir,
    ).readRestoreProjection(sessionId, {
      replay: {
        kind: 'recent',
        limit: 2,
        hideInheritedHistory: false,
      },
    });

    expect(projection?.replay).toMatchObject({
      records: [
        expect.objectContaining({ uuid: 'u3' }),
        expect.objectContaining({ uuid: 'a3' }),
      ],
      hasMore: true,
      anchorRecordId: 'u3',
      replay: {
        goalState: goalPayload.snapshot,
        goalCause: goalPayload.cause,
      },
    });
  });

  it('applies inherited-history filtering only to replay', async () => {
    const inheritedUser = {
      ...record('u1', null, 'inherited prompt'),
      forkedFrom: { sessionId: 'parent', messageUuid: 'u1' },
    };
    const inheritedAssistant = {
      ...record('a1', 'u1', 'inherited answer'),
      forkedFrom: { sessionId: 'parent', messageUuid: 'a1' },
    };
    const inheritedGoal: ChatRecord = {
      ...record('goal', 'a1', ''),
      type: 'system',
      subtype: 'slash_command',
      message: undefined,
      forkedFrom: { sessionId: 'parent', messageUuid: 'goal' },
      systemPayload: {
        rawCommand: '/goal inherited goal',
        phase: 'result',
        outputHistoryItems: [
          {
            type: 'goal_status',
            kind: 'set',
            condition: 'inherited goal',
          },
        ],
      },
    };
    await writeRecords([
      inheritedUser,
      inheritedAssistant,
      inheritedGoal,
      record('u2', 'goal', 'branch prompt'),
      record('a2', 'u2', 'branch answer'),
    ]);
    const reader = new SessionTranscriptReader(workspaceDir);

    const visible = await reader.readRestoreProjection(sessionId, {
      replay: { kind: 'all', hideInheritedHistory: false },
    });
    const hidden = await reader.readRestoreProjection(sessionId, {
      replay: { kind: 'all', hideInheritedHistory: true },
    });

    expect(visible?.replay?.records.map((item) => item.uuid)).toEqual([
      'u1',
      'a1',
      'goal',
      'u2',
      'a2',
    ]);
    expect(hidden?.replay?.records.map((item) => item.uuid)).toEqual([
      'u2',
      'a2',
    ]);
    expect(hidden?.runtime.apiHistory).toEqual(visible?.runtime.apiHistory);
    expect(visible?.runtime.goalRecoverySourceUuid).toBe('goal');
    expect(hidden?.runtime.goalRecoverySourceUuid).toBe('goal');
    expect(hidden?.replay?.goalRecoverySourceUuid).toBeUndefined();
    expect(hidden?.runtime.goalRecords).toEqual([
      expect.objectContaining({ uuid: 'goal' }),
    ]);

    const hiddenLive = await reader.readLiveRestoreProjection(sessionId, {
      replay: { kind: 'all', hideInheritedHistory: true },
    });
    expect(hiddenLive?.replay?.records.map((item) => item.uuid)).toEqual([
      'u2',
      'a2',
    ]);
    expect(hiddenLive?.goalRecoverySourceUuid).toBeUndefined();
    expect(hiddenLive?.goalRecords).toBeUndefined();
  });

  it('selects Goal bootstrap precedence from filtered visible history', async () => {
    const visibleGoal: ChatRecord = {
      ...record('visible-goal', null, ''),
      type: 'system',
      subtype: 'slash_command',
      message: undefined,
      systemPayload: {
        rawCommand: '/goal visible goal',
        phase: 'result',
        outputHistoryItems: [
          { type: 'goal_status', kind: 'set', condition: 'visible goal' },
        ],
      },
    };
    const hiddenGoal: ChatRecord = {
      ...record('hidden-goal', 'visible-goal', ''),
      type: 'system',
      subtype: 'slash_command',
      message: undefined,
      forkedFrom: { sessionId: 'parent', messageUuid: 'hidden-goal' },
      systemPayload: {
        rawCommand: '/goal hidden goal',
        phase: 'result',
        outputHistoryItems: [
          { type: 'goal_status', kind: 'set', condition: 'hidden goal' },
        ],
      },
    };
    await writeRecords([
      record('u0', null, 'older prompt'),
      record('a0', 'u0', 'older answer'),
      { ...visibleGoal, parentUuid: 'a0' },
      hiddenGoal,
      record('u1', 'hidden-goal', 'branch prompt'),
      record('a1', 'u1', 'branch answer'),
      record('u2', 'a1', 'latest prompt'),
      record('a2', 'u2', 'latest answer'),
    ]);
    const reader = new SessionTranscriptReader(workspaceDir);
    const options = {
      replay: {
        kind: 'recent' as const,
        limit: 2,
        hideInheritedHistory: true,
      },
    };

    const cold = await reader.readRestoreProjection(sessionId, options);
    const live = await reader.readLiveRestoreProjection(sessionId, options);

    expect(cold?.replay?.records.map((record) => record.uuid)).toEqual([
      'u2',
      'a2',
    ]);
    expect(cold?.runtime.goalRecoverySourceUuid).toBe('hidden-goal');
    expect(cold?.replay?.goalRecoverySourceUuid).toBe('visible-goal');
    expect(cold?.replay?.goalBootstrapRecords).toEqual([
      expect.objectContaining({ uuid: 'visible-goal' }),
    ]);
    expect(live?.goalRecoverySourceUuid).toBe('visible-goal');
    expect(live?.goalRecords?.map((record) => record.uuid)).toEqual([
      'visible-goal',
    ]);
  });

  it('uses the aggregated final usage metadata when selecting resume tokens', async () => {
    const earlier = record('a1', 'u1', 'earlier answer');
    earlier.usageMetadata = {
      promptTokenCount: 20,
      candidatesTokenCount: 3,
    };
    const latest = record('a2', 'u2', 'latest answer');
    latest.usageMetadata = {
      promptTokenCount: 10,
      candidatesTokenCount: 2,
    };
    const latestFragment = record('a2', 'u2', 'latest tail');
    latestFragment.usageMetadata = {
      promptTokenCount: 0,
      totalTokenCount: 0,
      candidatesTokenCount: 0,
    };
    await writeRecords([
      record('u1', null, 'first'),
      earlier,
      record('u2', 'a1', 'second'),
      latest,
      latestFragment,
    ]);

    const service = new SessionService(workspaceDir, {
      runtimeBaseDir: runtimeDir,
    });
    const [loaded, projection] = await Promise.all([
      service.loadSession(sessionId),
      service.readRestoreProjection(sessionId, {
        replay: { kind: 'none' },
      }),
    ]);

    expect(projection?.runtime.resumeTokenCounts).toEqual(
      getResumeTokenCounts(loaded!.conversation),
    );
    expect(projection?.runtime.resumeTokenCounts).toMatchObject({
      promptTokenCount: 20,
    });
  });

  it('ignores a later non-snapshot attribution record like the full loader', async () => {
    const snapshot = {
      type: 'attribution-snapshot' as const,
      version: 1,
      surface: 'cli',
      fileStates: {},
      promptCount: 2,
      promptCountAtLastCommit: 1,
    };
    const valid: ChatRecord = {
      ...record('attribution', 'u1', ''),
      type: 'system',
      subtype: 'attribution_snapshot',
      message: undefined,
      systemPayload: { snapshot },
    };
    const malformed: ChatRecord = {
      ...record('malformed-attribution', 'attribution', ''),
      type: 'system',
      subtype: 'attribution_snapshot',
      message: undefined,
      systemPayload: {
        ignored: true,
      } as unknown as ChatRecord['systemPayload'],
    };
    await writeRecords([
      record('u1', null, 'prompt'),
      valid,
      malformed,
      record('a1', 'malformed-attribution', 'answer'),
    ]);

    const projection = await new SessionTranscriptReader(
      workspaceDir,
    ).readRestoreProjection(sessionId, { replay: { kind: 'none' } });

    expect(projection?.runtime.attributionSnapshot).toEqual(snapshot);
  });

  it('rejects a cold projection when the frozen transcript changes', async () => {
    const filePath = await writeRecords([record('u1', null, 'one')]);
    let appended = false;
    setSessionTranscriptIndexBuildCompleteHookForTest(async (builtPath) => {
      if (builtPath !== filePath || appended) return;
      appended = true;
      await fs.appendFile(
        filePath,
        `${JSON.stringify(record('a1', 'u1', 'late'))}\n`,
        'utf8',
      );
    });

    await expect(
      new SessionTranscriptReader(workspaceDir).readRestoreProjection(
        sessionId,
        { replay: { kind: 'none' } },
      ),
    ).rejects.toBeInstanceOf(SessionTranscriptSnapshotUnavailableError);
    expect(getSessionTranscriptIndexCacheStatsForTest()).toEqual({
      entries: 0,
      byteSize: 0,
    });
  });

  it('reports a removed frozen transcript as snapshot-unavailable', async () => {
    const filePath = await writeRecords([record('u1', null, 'one')]);
    setSessionTranscriptIndexBuildCompleteHookForTest(async (builtPath) => {
      if (builtPath === filePath) await fs.unlink(filePath);
    });

    await expect(
      new SessionTranscriptReader(workspaceDir).readRestoreProjection(
        sessionId,
        { replay: { kind: 'none' } },
      ),
    ).rejects.toBeInstanceOf(SessionTranscriptSnapshotUnavailableError);
    expect(getSessionTranscriptIndexCacheStatsForTest()).toEqual({
      entries: 0,
      byteSize: 0,
    });
  });

  it('rejects an invalid recent projection before scanning', async () => {
    const filePath = await writeRecords([record('u1', null, 'one')]);
    let buildCount = 0;
    setSessionTranscriptIndexBuildCompleteHookForTest((builtPath) => {
      if (builtPath === filePath) buildCount++;
    });

    await expect(
      new SessionTranscriptReader(workspaceDir).readRestoreProjection(
        sessionId,
        {
          replay: {
            kind: 'recent',
            limit: 0,
            hideInheritedHistory: false,
          },
        },
      ),
    ).rejects.toBeInstanceOf(RangeError);
    expect(buildCount).toBe(0);
  });

  it('returns no cold projection for empty sessions and rejects foreign ones', async () => {
    await writeRawTranscript('');
    const reader = new SessionTranscriptReader(workspaceDir);
    await expect(
      reader.readRestoreProjection(sessionId, {
        replay: { kind: 'none' },
      }),
    ).resolves.toBeUndefined();

    await writeRawTranscript('{not-json}\n');
    await expect(
      reader.readRestoreProjection(sessionId, {
        replay: { kind: 'none' },
      }),
    ).resolves.toBeUndefined();

    await writeRecords([record('u1', null, 'foreign')]);
    await expect(
      reader.readRestoreProjection(
        sessionId,
        { replay: { kind: 'none' } },
        { validateFirstRecord: () => false },
      ),
    ).rejects.toBeInstanceOf(SessionTranscriptSnapshotUnavailableError);

    await expect(
      reader.readLiveRestoreProjection(
        sessionId,
        { replay: { kind: 'none' } },
        { validateFirstRecord: () => false },
      ),
    ).rejects.toBeInstanceOf(SessionTranscriptSnapshotUnavailableError);
  });

  it('fails closed when a cold restore transcript is missing', async () => {
    await expect(
      new SessionTranscriptReader(workspaceDir).readRestoreProjection(
        sessionId,
        { replay: { kind: 'none' } },
      ),
    ).rejects.toBeInstanceOf(SessionTranscriptSnapshotUnavailableError);
  });

  it('preserves the real leaf for a metadata-only session', async () => {
    const source: ChatRecord = {
      ...record('source', null, ''),
      type: 'system',
      subtype: 'session_source',
      message: undefined,
      systemPayload: { sourceType: 'daemon', sourceId: 'metadata-only' },
    };
    await writeRecords([source]);

    const projection = await new SessionTranscriptReader(
      workspaceDir,
    ).readRestoreProjection(sessionId, { replay: { kind: 'none' } });

    expect(projection?.runtime.apiHistory).toEqual([]);
    expect(projection?.runtime.recording).toMatchObject({
      lastCompletedUuid: 'source',
      sourceType: 'daemon',
      sourceId: 'metadata-only',
    });
  });

  it('preserves malformed compression failure behavior', async () => {
    await writeRecords([
      record('u1', null, 'prompt'),
      {
        ...record('compression', 'u1', ''),
        type: 'system',
        subtype: 'chat_compression',
        message: undefined,
        systemPayload: {
          compressedHistory: { malformed: true },
        } as unknown as ChatRecord['systemPayload'],
      },
      record('a1', 'compression', 'answer'),
    ]);
    const loaded = await new SessionService(workspaceDir, {
      runtimeBaseDir: runtimeDir,
    }).loadSession(sessionId);
    expect(() => buildApiHistoryFromConversation(loaded!.conversation)).toThrow(
      TypeError,
    );

    await expect(
      new SessionTranscriptReader(workspaceDir).readRestoreProjection(
        sessionId,
        { replay: { kind: 'none' } },
      ),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it('normalizes Goal candidates without changing recovery precedence', async () => {
    const validGoal: GoalStateRecordPayloadV2 = {
      v: 2,
      cause: 'create',
      snapshot: {
        v: 2,
        activity: 'idle',
        goal: {
          goalId: 'goal-1',
          revision: 1,
          objective: 'keep the valid v2 state',
          status: 'active',
          evidenceCursor: { recordId: 'u1' },
          turnCount: 0,
          activeTimeMs: 0,
          createdAt: 1,
          updatedAt: 1,
        },
      },
    };
    const legacy: ChatRecord = {
      ...record('legacy', 'u1', ''),
      type: 'system',
      subtype: 'slash_command',
      message: undefined,
      systemPayload: {
        phase: 'result',
        rawCommand: '/goal legacy',
        outputHistoryItems: [
          { type: 'message', text: 'discard me' },
          { type: 'goal_status', kind: 'set', condition: 'legacy goal' },
        ],
      },
    };
    const valid: ChatRecord = {
      ...record('valid-goal', 'legacy', ''),
      type: 'system',
      subtype: 'goal_state',
      message: undefined,
      systemPayload: validGoal,
    };
    const malformed: ChatRecord = {
      ...record('malformed-goal', 'valid-goal', ''),
      type: 'system',
      subtype: 'goal_state',
      message: undefined,
      systemPayload: {
        v: 2,
        cause: 'create',
        snapshot: null,
      } as unknown as ChatRecord['systemPayload'],
    };
    await writeRecords([
      record('u1', null, 'prompt'),
      legacy,
      valid,
      malformed,
      record('a1', 'malformed-goal', 'answer'),
    ]);

    const projection = await new SessionTranscriptReader(
      workspaceDir,
    ).readRestoreProjection(sessionId, { replay: { kind: 'none' } });

    expect(recoverGoalFromRecords(projection!.runtime.goalRecords)).toEqual({
      kind: 'v2',
      payload: validGoal,
    });
    expect(projection?.runtime.goalRecoverySourceUuid).toBe('valid-goal');
    expect(projection?.runtime.goalRecords).toEqual([
      expect.objectContaining({
        uuid: 'legacy',
        systemPayload: {
          phase: 'result',
          outputHistoryItems: [
            { type: 'goal_status', kind: 'set', condition: 'legacy goal' },
          ],
        },
      }),
      expect.objectContaining({ uuid: 'valid-goal', systemPayload: validGoal }),
      expect.objectContaining({ uuid: 'malformed-goal', systemPayload: null }),
    ]);
  });

  it('dispatches a pre-read malformed Goal record to other consumers once', async () => {
    const malformedGoal: ChatRecord = {
      ...record('a-goal', 'u1', 'model payload'),
      subtype: 'goal_state',
      systemPayload: {
        malformed: true,
      } as unknown as ChatRecord['systemPayload'],
    };
    await writeRecords([record('u1', null, 'prompt'), malformedGoal]);

    const service = new SessionService(workspaceDir, {
      runtimeBaseDir: runtimeDir,
    });
    const [loaded, projection] = await Promise.all([
      service.loadSession(sessionId),
      service.readRestoreProjection(sessionId, {
        replay: { kind: 'none' },
      }),
    ]);

    expect(projection?.runtime.apiHistory).toEqual(
      buildApiHistoryFromConversation(loaded!.conversation),
    );
    expect(projection?.runtime.apiHistory).toHaveLength(2);
    expect(recoverGoalFromRecords(projection!.runtime.goalRecords)).toEqual({
      kind: 'unsupported',
      reason: expect.stringContaining('a-goal'),
    });
  });

  it('reads a narrow live projection without cold runtime state', async () => {
    const artifactId = stableSessionArtifactId(
      sessionId,
      'url:https://example.com/live',
    );
    await writeRecords([
      record('u1', null, 'one'),
      {
        ...record('artifact', 'u1', ''),
        type: 'system',
        subtype: 'session_artifact_event',
        message: undefined,
        systemPayload: {
          v: SESSION_ARTIFACT_PERSISTENCE_VERSION,
          sessionId,
          sequence: 1,
          recordedAt: '2026-01-01T00:00:01.000Z',
          changes: [
            {
              action: 'created',
              artifactId,
              artifact: {
                id: artifactId,
                kind: 'link',
                storage: 'external_url',
                source: 'client',
                status: 'available',
                title: 'Live',
                url: 'https://example.com/live',
                retention: 'restorable',
                clientRetained: true,
                createdAt: '2026-01-01T00:00:01.000Z',
                updatedAt: '2026-01-01T00:00:01.000Z',
                persistedAt: '2026-01-01T00:00:01.000Z',
              },
            },
          ],
        },
      },
      record('a1', 'u1', 'one answer'),
      record('u2', 'a1', 'two'),
      record('a2', 'u2', 'two answer'),
    ]);
    const reader = new SessionTranscriptReader(workspaceDir);

    const liveLoad = await reader.readLiveRestoreProjection(sessionId, {
      replay: {
        kind: 'recent',
        limit: 2,
        hideInheritedHistory: false,
      },
    });
    const liveResume = await reader.readLiveRestoreProjection(sessionId, {
      replay: { kind: 'none' },
    });

    expect(liveLoad?.replay?.records.map((item) => item.uuid)).toEqual([
      'u2',
      'a2',
    ]);
    expect(liveLoad?.artifactSnapshot?.artifacts).toHaveLength(1);
    expect(liveResume?.replay).toBeUndefined();
    expect(liveResume?.artifactSnapshot).toEqual(liveLoad?.artifactSnapshot);
    expect(liveResume).not.toHaveProperty('runtime');
    expect(mockAddDaemonRequestAttribute).toHaveBeenCalledWith(
      'qwen-code.daemon.session_restore.index_cache_state',
      'miss',
    );
    expect(mockAddDaemonRequestAttribute).toHaveBeenCalledWith(
      'qwen-code.daemon.session_restore.index_cache_state',
      'hit',
    );
  });

  it('retains the determining legacy Goal candidate for a recent live page', async () => {
    const legacyGoal: ChatRecord = {
      ...record('goal', null, ''),
      type: 'system',
      subtype: 'slash_command',
      message: undefined,
      systemPayload: {
        rawCommand: '/goal keep the live goal visible',
        phase: 'result',
        outputHistoryItems: [
          {
            type: 'goal_status',
            kind: 'set',
            condition: 'keep the live goal visible',
            iterations: 0,
          },
        ],
      },
    };
    await writeRecords([
      legacyGoal,
      record('u1', 'goal', 'one'),
      record('a1', 'u1', 'one answer'),
      record('u2', 'a1', 'two'),
      record('a2', 'u2', 'two answer'),
    ]);

    const projection = await new SessionTranscriptReader(
      workspaceDir,
    ).readLiveRestoreProjection(sessionId, {
      replay: {
        kind: 'recent',
        limit: 2,
        hideInheritedHistory: false,
      },
    });

    expect(projection?.replay?.records.map((item) => item.uuid)).toEqual([
      'u2',
      'a2',
    ]);
    expect(projection?.goalRecoverySourceUuid).toBe('goal');
    expect(projection?.goalRecords).toEqual([
      expect.objectContaining({ uuid: 'goal', subtype: 'slash_command' }),
    ]);
  });

  it('projects a pending Goal checkpoint window without a full-loader fallback', async () => {
    const permit = { goalId: 'goal-1', revision: 1, turnId: 'turn-1' };
    const cursor: ChatRecord = {
      ...record('cursor', null, ''),
      type: 'system',
      subtype: 'goal_runtime',
      message: undefined,
    };
    const evidence = Array.from({ length: 80 }, (_, index) => ({
      ...record(
        `a-evidence-${index}`,
        index === 0 ? 'cursor' : `a-evidence-${index - 1}`,
        `evidence ${index}`,
      ),
      provenance: 'assistant_output' as const,
      goalContext: permit,
    }));
    const fragmentedEvidence: ChatRecord = {
      ...evidence[0]!,
      message: { role: 'model', parts: [{ text: 'fragment tail' }] },
    };
    const compression: ChatRecord = {
      ...record('compression', evidence.at(-1)!.uuid, ''),
      type: 'system',
      subtype: 'chat_compression',
      message: undefined,
      systemPayload: {
        compressedHistory: [
          { role: 'user', parts: [{ text: 'summary' }] },
          { role: 'model', parts: [{ text: 'summary result' }] },
        ],
      } as ChatRecord['systemPayload'],
    };
    const goalPayload: GoalStateRecordPayloadV2 = {
      v: 2,
      cause: 'turn_finished',
      snapshot: {
        v: 2,
        activity: 'idle',
        goal: {
          goalId: permit.goalId,
          revision: permit.revision,
          objective: 'verify the result',
          status: 'active',
          evidenceCursor: { recordId: 'cursor' },
          turnCount: 1,
          activeTimeMs: 0,
          createdAt: 1,
          updatedAt: 2,
        },
      },
      checkpointPending: {
        permit,
        recordUuid: evidence.at(-1)!.uuid,
      },
    };
    const goalState: ChatRecord = {
      ...record('goal-state', 'compression', ''),
      type: 'system',
      subtype: 'goal_state',
      message: undefined,
      systemPayload: goalPayload,
    };
    const filePath = await writeRecords([
      cursor,
      evidence[0]!,
      fragmentedEvidence,
      ...evidence.slice(1),
      compression,
      goalState,
    ]);
    let buildCount = 0;
    setSessionTranscriptIndexBuildCompleteHookForTest((builtPath) => {
      if (builtPath === filePath) buildCount++;
    });

    const service = new SessionService(workspaceDir, {
      runtimeBaseDir: runtimeDir,
    });
    const [loaded, projection] = await Promise.all([
      service.loadSession(sessionId),
      service.readRestoreProjection(sessionId, {
        replay: { kind: 'none' },
      }),
    ]);
    const expected = buildGoalEvidenceCheckpointWindow({
      records: loaded!.conversation.messages,
      goal: goalPayload.snapshot.goal!,
      permit,
    });

    expect(projection?.runtime.goalCheckpointWindow).toEqual(expected);
    expect(projection?.runtime.goalCheckpointWindow).toMatchObject({
      shouldCheckpoint: true,
      truncated: false,
    });
    expect(projection?.runtime.goalCheckpointWindow?.evidence).toHaveLength(80);
    expect(projection?.runtime.goalCheckpointWindow?.evidence[0]?.content).toBe(
      'evidence 0\nfragment tail',
    );
    expect(buildCount).toBe(1);
  });

  it('defers unavailable pending Goal evidence to runtime recovery', async () => {
    const permit = { goalId: 'goal-1', revision: 1, turnId: 'turn-1' };
    const evidence = {
      ...record('evidence', null, 'result'),
      provenance: 'assistant_output' as const,
      goalContext: permit,
    };
    const goalState: ChatRecord = {
      ...record('goal-state', 'evidence', ''),
      type: 'system',
      subtype: 'goal_state',
      message: undefined,
      systemPayload: {
        v: 2,
        cause: 'turn_finished',
        snapshot: {
          v: 2,
          activity: 'idle',
          goal: {
            goalId: permit.goalId,
            revision: permit.revision,
            objective: 'verify the result',
            status: 'active',
            evidenceCursor: { recordId: 'missing-cursor' },
            turnCount: 1,
            activeTimeMs: 0,
            createdAt: 1,
            updatedAt: 2,
          },
        },
        checkpointPending: { permit, recordUuid: evidence.uuid },
      } satisfies GoalStateRecordPayloadV2,
    };
    await writeRecords([evidence, goalState]);

    const projection = await new SessionTranscriptReader(
      workspaceDir,
    ).readRestoreProjection(sessionId, { replay: { kind: 'none' } });

    expect(projection?.runtime.goalCheckpointWindow).toBeUndefined();
    expect(projection?.runtime.goalRecords).toHaveLength(1);
    expect(projection?.runtime.goalRecords[0]?.uuid).toBe('goal-state');
  });

  it('keeps backward pages within a normal user turn boundary', async () => {
    const toolCall = record('a-tool', 'u1', 'call tool');
    const toolResult = {
      ...record('t1', 'a-tool', 'tool result'),
      type: 'tool_result' as const,
    };
    await writeRecords([
      record('u1', null, 'first prompt'),
      toolCall,
      toolResult,
      record('a1', 't1', 'first answer'),
      record('u2', 'a1', 'second prompt'),
      record('a2', 'u2', 'second answer'),
    ]);

    const page = await new SessionTranscriptReader(workspaceDir).readPage(
      sessionId,
      { beforeRecordId: 'u2', limit: 4 },
    );

    expect(page.records.map((item) => item.uuid)).toEqual([
      'u1',
      'a-tool',
      't1',
      'a1',
    ]);
  });

  it('keeps a long user turn complete when it exceeds the record limit', async () => {
    const toolCall = record('a-tool', 'u1', 'call tool');
    const toolResult = {
      ...record('t1', 'a-tool', 'tool result'),
      type: 'tool_result' as const,
    };
    await writeRecords([
      record('u1', null, 'prompt'),
      toolCall,
      toolResult,
      record('a-final', 't1', 'final answer'),
      record('u2', 'a-final', 'next prompt'),
    ]);

    const page = await new SessionTranscriptReader(workspaceDir).readPage(
      sessionId,
      { beforeRecordId: 'u2', limit: 2 },
    );

    expect(page.records.map((item) => item.uuid)).toEqual([
      'u1',
      'a-tool',
      't1',
      'a-final',
    ]);
    expect(page.hasMore).toBe(false);
  });

  it('returns a backward turn that exceeds maxBytes after alignment', async () => {
    const prompt = record('u1', null, 'prompt');
    const toolCall = record('a-tool', 'u1', 'call tool');
    const toolResult = {
      ...record('t1', 'a-tool', 'tool result'),
      type: 'tool_result' as const,
    };
    const finalAnswer = record('a-final', 't1', 'final answer');
    const turnRecords = [prompt, toolCall, toolResult, finalAnswer];
    await writeRecords([
      ...turnRecords,
      record('u2', 'a-final', 'next prompt'),
    ]);
    const turnBytes = turnRecords.reduce(
      (total, item) => total + Buffer.byteLength(JSON.stringify(item)),
      0,
    );

    const page = await new SessionTranscriptReader(workspaceDir).readPage(
      sessionId,
      {
        beforeRecordId: 'u2',
        limit: 2,
        // The turn exceeds the soft budget, but it still fits one extra
        // budget (2 * maxBytes), so alignment admits it whole.
        maxBytes: Math.ceil(turnBytes / 2),
      },
    );

    expect(page.records.map((item) => item.uuid)).toEqual([
      'u1',
      'a-tool',
      't1',
      'a-final',
    ]);
    expect(page.hasMore).toBe(false);
  });

  it('rejects a backward boundary outside the active chain', async () => {
    await writeRecords([
      record('u1', null, 'root'),
      record('a1', 'u1', 'answer'),
    ]);

    await expect(
      new SessionTranscriptReader(workspaceDir).readPage(sessionId, {
        beforeRecordId: 'missing',
      }),
    ).rejects.toBeInstanceOf(InvalidSessionTranscriptCursorError);
  });

  it('continues a frozen snapshot after new records are appended', async () => {
    const filePath = await writeRecords([
      record('u1', null, 'root'),
      record('a1', 'u1', 'assistant'),
      record('u2', 'a1', 'second'),
    ]);

    const reader = new SessionTranscriptReader(workspaceDir);
    const first = await reader.readPage(sessionId, { limit: 2 });
    await fs.appendFile(
      filePath,
      JSON.stringify(record('a2', 'u2', 'late append')) + '\n',
      'utf8',
    );

    const second = await reader.readPage(sessionId, {
      cursor: encodeCursor(first.nextCursorState!),
      limit: 2,
    });

    expect(second.records.map((r) => r.uuid)).toEqual(['u2']);
    expect(second.hasMore).toBe(false);
  });

  it('rejects cursors from another session before touching transcript files', async () => {
    await writeRecords([
      record('u1', null, 'root'),
      record('a1', 'u1', 'assistant'),
    ]);

    const reader = new SessionTranscriptReader(workspaceDir);
    const first = await reader.readPage(sessionId, { limit: 1 });
    const otherSessionId = '660e8400-e29b-41d4-a716-446655440000';

    await expect(
      reader.readPage(otherSessionId, {
        cursor: encodeCursor(first.nextCursorState!),
      }),
    ).rejects.toBeInstanceOf(InvalidSessionTranscriptCursorError);
  });

  it('rejects malformed and unsupported-version cursors', async () => {
    const reader = new SessionTranscriptReader(workspaceDir);
    await expect(
      reader.readPage(sessionId, { cursor: 'not-a-cursor' }),
    ).rejects.toBeInstanceOf(InvalidSessionTranscriptCursorError);

    await writeRecords([
      record('u1', null, 'root'),
      record('a1', 'u1', 'assistant'),
    ]);
    const first = await reader.readPage(sessionId, { limit: 1 });
    const wrongVersion = encodeCursor({
      ...first.nextCursorState!,
      v: 99 as 1,
    });

    await expect(
      reader.readPage(sessionId, { cursor: wrongVersion }),
    ).rejects.toBeInstanceOf(InvalidSessionTranscriptCursorError);
  });

  it('rejects a cursor after the frozen snapshot is truncated', async () => {
    const filePath = await writeRecords([
      record('u1', null, 'root'),
      record('a1', 'u1', 'assistant'),
      record('u2', 'a1', 'second'),
    ]);

    const reader = new SessionTranscriptReader(workspaceDir);
    const first = await reader.readPage(sessionId, { limit: 1 });
    await fs.truncate(filePath, 1);

    await expect(
      reader.readPage(sessionId, {
        cursor: encodeCursor(first.nextCursorState!),
      }),
    ).rejects.toBeInstanceOf(SessionTranscriptSnapshotUnavailableError);
  });

  it('rejects a cursor when the frozen file identity no longer matches', async () => {
    await writeRecords([
      record('u1', null, 'root'),
      record('a1', 'u1', 'assistant'),
      record('u2', 'a1', 'second'),
    ]);

    const reader = new SessionTranscriptReader(workspaceDir);
    const first = await reader.readPage(sessionId, { limit: 1 });

    await expect(
      reader.readPage(sessionId, {
        cursor: encodeCursor({
          ...first.nextCursorState!,
          fileIdentity: { dev: 999_999, ino: 999_999 },
        }),
      }),
    ).rejects.toBeInstanceOf(SessionTranscriptSnapshotUnavailableError);
  });

  it('paginates when the filesystem reports inode zero', async () => {
    await writeRecords([
      record('u1', null, 'root'),
      record('a1', 'u1', 'assistant'),
      record('u2', 'a1', 'second'),
    ]);
    statFault.zeroInode = true;

    const reader = new SessionTranscriptReader(workspaceDir);
    const first = await reader.readPage(sessionId, { limit: 1 });
    expect(first.records.map((item) => item.uuid)).toEqual(['u1']);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursorState!.fileIdentity.ino).toBe(0);

    const second = await reader.readPage(sessionId, {
      cursor: encodeCursor(first.nextCursorState!),
    });
    expect(second.records.map((item) => item.uuid)).toEqual(['a1', 'u2']);
  });

  it('rejects a cursor whose frozen inode no longer matches the file', async () => {
    await writeRecords([
      record('u1', null, 'root'),
      record('a1', 'u1', 'assistant'),
      record('u2', 'a1', 'second'),
    ]);

    const reader = new SessionTranscriptReader(workspaceDir);
    const first = await reader.readPage(sessionId, { limit: 1 });

    await expect(
      reader.readPage(sessionId, {
        cursor: encodeCursor({
          ...first.nextCursorState!,
          fileIdentity: {
            ...first.nextCursorState!.fileIdentity,
            ino: 0,
          },
        }),
      }),
    ).rejects.toBeInstanceOf(SessionTranscriptSnapshotUnavailableError);
  });

  it('accepts a file identity whose inode exceeds 2^53 (Windows file index)', async () => {
    await writeRecords([
      record('u1', null, 'root'),
      record('a1', 'u1', 'assistant'),
    ]);

    const reader = new SessionTranscriptReader(workspaceDir);
    const first = await reader.readPage(sessionId, { limit: 1 });
    // Windows derives Stats.ino from a 64-bit file index that exceeds 2^53, so
    // a safe-integer gate would reject every cursor there. The large inode must
    // survive shape validation and reach the identity match (which then fails
    // against the real file), rather than being rejected as a non-safe integer.
    const bigIno = 2 ** 53 + 2;
    expect(Number.isSafeInteger(bigIno)).toBe(false);

    await expect(
      reader.readPage(sessionId, {
        cursor: encodeCursor({
          ...first.nextCursorState!,
          fileIdentity: { dev: 1, ino: bigIno },
        }),
      }),
    ).rejects.toBeInstanceOf(SessionTranscriptSnapshotUnavailableError);
  });

  it('still rejects a non-safe-integer byte offset in a cursor', async () => {
    await writeRecords([
      record('u1', null, 'root'),
      record('a1', 'u1', 'assistant'),
    ]);

    const reader = new SessionTranscriptReader(workspaceDir);
    const first = await reader.readPage(sessionId, { limit: 1 });
    // snapshotSize/position are arithmetic operands and stay safe-integer even
    // though dev/ino were relaxed for Windows.
    const unsafeOffset = 2 ** 53 + 2;
    expect(Number.isSafeInteger(unsafeOffset)).toBe(false);

    await expect(
      reader.readPage(sessionId, {
        cursor: encodeCursor({
          ...first.nextCursorState!,
          snapshotSize: unsafeOffset,
        }),
      }),
    ).rejects.toBeInstanceOf(InvalidSessionTranscriptCursorError);
  });

  it('rejects cursors whose position is past the active chain', async () => {
    await writeRecords([
      record('u1', null, 'root'),
      record('a1', 'u1', 'assistant'),
      record('u2', 'a1', 'second'),
    ]);

    const reader = new SessionTranscriptReader(workspaceDir);
    const first = await reader.readPage(sessionId, { limit: 1 });

    await expect(
      reader.readPage(sessionId, {
        cursor: encodeCursor({
          ...first.nextCursorState!,
          position: 999,
        }),
      }),
    ).rejects.toBeInstanceOf(InvalidSessionTranscriptCursorError);
  });

  it('terminates cyclic parentUuid chains without looping', async () => {
    await writeRecords([
      record('u1', 'a1', 'root'),
      record('a1', 'u1', 'assistant'),
    ]);

    const reader = new SessionTranscriptReader(workspaceDir);
    const page = await reader.readPage(sessionId, { limit: 10 });

    expect(page.records.map((r) => r.uuid)).toEqual(['u1', 'a1']);
    expect(page.hasMore).toBe(false);
  });

  it('aggregates multiple physical records for the same active uuid', async () => {
    await writeRecords([
      record('u1', null, 'hello'),
      record('u1', null, ' world'),
      record('a1', 'u1', 'reply'),
    ]);

    const reader = new SessionTranscriptReader(workspaceDir);
    const page = await reader.readPage(sessionId, { limit: 1 });

    expect(page.records).toHaveLength(1);
    expect(page.records[0]?.uuid).toBe('u1');
    expect(page.records[0]?.message?.parts).toEqual([
      { text: 'hello' },
      { text: ' world' },
    ]);
    expect(page.hasMore).toBe(true);
  });

  it('marks missing parentUuid gaps without paging phantom uuids', async () => {
    await writeRecords([
      record('u2', 'missing-a1', 'tail'),
      record('a2', 'u2', 'tail reply'),
    ]);

    const reader = new SessionTranscriptReader(workspaceDir);
    const first = await reader.readPage(sessionId, { limit: 1 });

    expect(first.records.map((r) => r.uuid)).toEqual(['u2']);
    expect(first.gaps).toEqual([
      { childUuid: 'u2', missingParentUuid: 'missing-a1' },
    ]);
    expect(first.hasMore).toBe(true);

    const second = await reader.readPage(sessionId, {
      cursor: encodeCursor(first.nextCursorState!),
      limit: 1,
    });
    expect(second.records.map((r) => r.uuid)).toEqual(['a2']);
    expect(second.gaps).toEqual([
      { childUuid: 'u2', missingParentUuid: 'missing-a1' },
    ]);
    expect(second.hasMore).toBe(false);
  });

  it('keeps cursors valid after the in-memory key cache is reset', async () => {
    await writeRecords([
      record('u1', null, 'hello'),
      record('a1', 'u1', 'reply'),
      record('u2', 'a1', 'next'),
    ]);

    const firstReader = new SessionTranscriptReader(workspaceDir);
    const first = await firstReader.readPage(sessionId, { limit: 1 });
    const cursor = encodeCursor(first.nextCursorState!);

    resetSessionTranscriptIndexCacheForTest();

    const secondReader = new SessionTranscriptReader(workspaceDir);
    const second = await secondReader.readPage(sessionId, {
      cursor,
      limit: 1,
    });

    expect(second.records.map((r) => r.uuid)).toEqual(['a1']);
    expect(second.hasMore).toBe(true);
  });

  it('uses an injected in-memory codec without creating a cursor key file', async () => {
    await writeRecords([
      record('u1', null, 'hello'),
      record('a1', 'u1', 'reply'),
    ]);
    const key = Buffer.alloc(32, 7);
    const codec = new SessionTranscriptCursorCodec(key);
    key.fill(9);
    const sameOriginalKey = new SessionTranscriptCursorCodec(
      Buffer.alloc(32, 7),
    );
    const reader = new SessionTranscriptReader(workspaceDir, codec);
    const first = await reader.readPage(sessionId, { limit: 1 });
    const cursor = codec.encode(first.nextCursorState!);
    expect(sameOriginalKey.decode(cursor).sessionId).toBe(sessionId);
    const second = await reader.readPage(sessionId, { cursor, limit: 1 });

    expect(second.records.map((item) => item.uuid)).toEqual(['a1']);
    await expect(
      fs.stat(
        path.join(
          new Storage(workspaceDir).getProjectDir(),
          'session-transcript-cursor-key',
        ),
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects in-memory cursors signed with another key or tampered', () => {
    const first = new SessionTranscriptCursorCodec(Buffer.alloc(32, 1));
    const second = new SessionTranscriptCursorCodec(Buffer.alloc(32, 2));
    const cursor = first.encode({
      v: 1,
      sessionId,
      fileIdentity: { dev: 1, ino: 2 },
      snapshotSize: 3,
      position: 1,
      leafUuid: 'leaf',
      startTime: 'start',
      lastUpdated: 'end',
    });

    expect(() => second.decode(cursor)).toThrow(
      InvalidSessionTranscriptCursorError,
    );
    expect(() => first.decode(`${cursor.slice(0, -1)}A`)).toThrow(
      InvalidSessionTranscriptCursorError,
    );
  });

  it('rejects an invalid in-memory cursor key length', () => {
    expect(() => new SessionTranscriptCursorCodec(Buffer.alloc(31))).toThrow(
      /must be 32 bytes/,
    );
  });

  it('warns and replaces a corrupt persisted cursor signing key', async () => {
    const projectDir = new Storage(workspaceDir).getProjectDir();
    const keyPath = path.join(projectDir, 'session-transcript-cursor-key');
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(keyPath, 'corrupt-key\n', 'utf8');
    await writeRecords([
      record('u1', null, 'root'),
      record('a1', 'u1', 'assistant'),
    ]);

    const page = await new SessionTranscriptReader(workspaceDir).readPage(
      sessionId,
      {
        limit: 1,
      },
    );
    encodeCursor(page.nextCursorState!);

    expect(mockDebugLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('invalid cursor signing key'),
    );
    const replacement = Buffer.from(
      (await fs.readFile(keyPath, 'utf8')).trim(),
      'base64url',
    );
    expect(replacement).toHaveLength(32);
  });

  it('rejects cursors signed for another workspace', async () => {
    await writeRecords([
      record('u1', null, 'hello'),
      record('a1', 'u1', 'reply'),
      record('u2', 'a1', 'next'),
    ]);
    const reader = new SessionTranscriptReader(workspaceDir);
    const first = await reader.readPage(sessionId, { limit: 1 });
    const cursor = encodeCursor(first.nextCursorState!);
    const otherWorkspaceDir = path.join(runtimeDir, 'other-workspace');
    await fs.mkdir(otherWorkspaceDir, { recursive: true });
    const otherReader = new SessionTranscriptReader(otherWorkspaceDir);

    await expect(
      otherReader.readPage(sessionId, { cursor }),
    ).rejects.toBeInstanceOf(InvalidSessionTranscriptCursorError);
  });

  it('does not duplicate same-uuid fragments parsed from one glued JSONL line', async () => {
    const first = record('u1', null, 'hello');
    const second = record('u1', null, ' world');
    await writeRawTranscript(
      `${JSON.stringify(first)}${JSON.stringify(second)}\n` +
        `${JSON.stringify(record('a1', 'u1', 'reply'))}\n`,
    );

    const reader = new SessionTranscriptReader(workspaceDir);
    const page = await reader.readPage(sessionId, { limit: 1 });

    expect(page.records).toHaveLength(1);
    expect(page.records[0]?.message?.parts).toEqual([
      { text: 'hello' },
      { text: ' world' },
    ]);
  });

  it('counts glued-line fragments conservatively against the byte budget', async () => {
    const first = record('u1', null, 'hello');
    const second = record('u1', null, ' world');
    const gluedLine = `${JSON.stringify(first)}${JSON.stringify(second)}`;
    await writeRawTranscript(
      `${gluedLine}\n${JSON.stringify(record('a1', 'u1', 'reply'))}\n`,
    );

    const page = await new SessionTranscriptReader(workspaceDir).readPage(
      sessionId,
      { limit: 2, maxBytes: Buffer.byteLength(gluedLine) * 2 },
    );

    // Conservative per-fragment counting spends the whole budget on the glued
    // aggregate, so the next record must wait for the following page.
    expect(page.records.map((item) => item.uuid)).toEqual(['u1']);
    expect(page.hasMore).toBe(true);
  });

  it('skips non-ChatRecord JSON lines while indexing', async () => {
    await writeRawTranscript(
      `${JSON.stringify({ event: 'metadata' })}\n${JSON.stringify(
        record('u1', null, 'hello'),
      )}\n`,
    );

    const page = await new SessionTranscriptReader(workspaceDir).readPage(
      sessionId,
    );

    expect(page.records.map((item) => item.uuid)).toEqual(['u1']);
  });

  it('raises snapshot-unavailable when a same-size in-place rewrite reuses a cached segment', async () => {
    const initial = `${JSON.stringify(record('u1', null, 'hello'))}\n`;
    const filePath = await writeRawTranscript(initial);
    const fixed = new Date('2026-02-02T02:02:02.000Z');
    await fs.utimes(filePath, fixed, fixed);
    const reader = new SessionTranscriptReader(workspaceDir);

    await expect(reader.readPage(sessionId)).resolves.toMatchObject({
      records: [expect.objectContaining({ uuid: 'u1' })],
    });

    // Keep the byte length and (forced) mtime so the cached index is reused,
    // but change the uuid so the recorded offset now parses to a different
    // record. The reader must surface 409, not silently drop the record.
    await fs.writeFile(
      filePath,
      initial.replace('"uuid":"u1"', '"uuid":"x1"'),
      'utf8',
    );
    await fs.utimes(filePath, fixed, fixed);

    await expect(reader.readPage(sessionId)).rejects.toBeInstanceOf(
      SessionTranscriptSnapshotUnavailableError,
    );
  });

  it('does not repeatedly copy pending bytes for one large record', async () => {
    const largeRecord = record('u1', null, 'x'.repeat(512 * 1024));
    const filePath = await writeRawTranscript(
      `${JSON.stringify(largeRecord)}\n`,
    );
    const snapshotSize = (await fs.stat(filePath)).size;
    const originalConcat = Buffer.concat;
    let copiedBytes = 0;
    const concatSpy = vi
      .spyOn(Buffer, 'concat')
      .mockImplementation((list, totalLength) => {
        copiedBytes += list.reduce((sum, buffer) => sum + buffer.length, 0);
        return originalConcat(list, totalLength);
      });

    try {
      const reader = new SessionTranscriptReader(workspaceDir);
      const page = await reader.readPage(sessionId);

      expect(page.records.map((r) => r.uuid)).toEqual(['u1']);
      expect(copiedBytes).toBeLessThan(snapshotSize * 2);
    } finally {
      concatSpy.mockRestore();
    }
  });

  it('yields cooperatively after complete scan lines and selected records', async () => {
    const yielded: number[] = [];
    let readSettled = false;
    let siblingRanBeforeSettlement = false;
    let siblingScheduled = false;
    setSessionTranscriptCooperativeReadBudgetForTest(
      1,
      Number.POSITIVE_INFINITY,
      () => {
        yielded.push(yielded.length + 1);
        if (siblingScheduled) return;
        siblingScheduled = true;
        setImmediate(() => {
          siblingRanBeforeSettlement = !readSettled;
        });
      },
    );
    await writeRecords([
      record('u1', null, 'first'),
      record('a1', 'u1', 'second'),
      record('u2', 'a1', 'third'),
    ]);

    const page = await new SessionTranscriptReader(workspaceDir)
      .readPage(sessionId)
      .finally(() => {
        readSettled = true;
      });

    expect(page.records.map((item) => item.uuid)).toEqual(['u1', 'a1', 'u2']);
    expect(yielded.length).toBeGreaterThanOrEqual(6);
    expect(siblingRanBeforeSettlement).toBe(true);
  });

  it('reuses one glued physical line across projection pre-read and dispatch', async () => {
    const first = record('u1', null, 'first');
    const second = record('a1', 'u1', 'second');
    const gluedLine = `${JSON.stringify(first)}${JSON.stringify(second)}`;
    await writeRawTranscript(`${gluedLine}\n`);
    const selectedReads: Array<{ offset: number; length: number }> = [];
    setSessionTranscriptSelectedLineReadHookForTest((offset, length) => {
      selectedReads.push({ offset, length });
    });

    const projection = await new SessionTranscriptReader(
      workspaceDir,
    ).readRestoreProjection(sessionId, { replay: { kind: 'none' } });

    expect(projection?.runtime.apiHistory).toEqual([
      first.message,
      second.message,
    ]);
    expect(selectedReads).toEqual([
      { offset: 0, length: Buffer.byteLength(gluedLine) },
    ]);
  });

  it('rejects oversized snapshots before indexing', async () => {
    const filePath = await writeRecords([record('u1', null, 'hello')]);
    await fs.truncate(filePath, SESSION_TRANSCRIPT_MAX_INDEX_BYTES + 1);

    const reader = new SessionTranscriptReader(workspaceDir);
    await expect(reader.readPage(sessionId)).rejects.toMatchObject({
      name: 'SessionTranscriptTooLargeError',
      sessionId,
      snapshotSize: SESSION_TRANSCRIPT_MAX_INDEX_BYTES + 1,
      maxBytes: SESSION_TRANSCRIPT_MAX_INDEX_BYTES,
    });
  });

  it('shares an oversized in-flight index without retaining its completion', async () => {
    const filePath = await writeRecords([
      record('u1', null, 'hello'),
      record('a1', 'u1', 'reply'),
    ]);
    setSessionTranscriptIndexCacheMaxBytesForTest(1);
    let buildCount = 0;
    setSessionTranscriptIndexBuildCompleteHookForTest((builtPath) => {
      if (builtPath === filePath) buildCount++;
    });
    const reader = new SessionTranscriptReader(workspaceDir);

    const [first, second] = await Promise.all([
      reader.readPage(sessionId),
      reader.readPage(sessionId),
    ]);

    expect(buildCount).toBe(1);
    expect(first.records).toEqual(second.records);
    expect(getSessionTranscriptIndexCacheStatsForTest()).toEqual({
      entries: 0,
      byteSize: 0,
    });
  });

  it('does not evict cached indexes when a new index exceeds the byte budget alone', async () => {
    await writeRecords([
      record('u1', null, 'hello'),
      record('a1', 'u1', 'reply'),
    ]);
    const reader = new SessionTranscriptReader(workspaceDir);
    const first = await reader.readPage(sessionId, { limit: 1 });
    const warmCache = getSessionTranscriptIndexCacheStatsForTest();
    expect(warmCache.entries).toBe(1);
    setSessionTranscriptIndexCacheMaxBytesForTest(warmCache.byteSize + 1);

    const largeSessionId = '660e8400-e29b-41d4-a716-446655440000';
    const largeRecords: ChatRecord[] = [];
    let parentUuid: string | null = null;
    for (let i = 0; i < 20; i++) {
      const uuid = `large-${i}`;
      largeRecords.push(
        record(uuid, parentUuid, `large transcript ${i}`, largeSessionId),
      );
      parentUuid = uuid;
    }
    await writeRecords(largeRecords, largeSessionId);

    await reader.readPage(largeSessionId, { limit: 1 });
    const afterOversizedRead = getSessionTranscriptIndexCacheStatsForTest();
    expect(afterOversizedRead.entries).toBe(1);
    expect(afterOversizedRead.byteSize).toBe(warmCache.byteSize);

    const second = await reader.readPage(sessionId, {
      cursor: encodeCursor(first.nextCursorState!),
      limit: 1,
    });
    expect(second.records.map((r) => r.uuid)).toEqual(['a1']);
  });

  it('accounts for retained projection hints in the cache byte estimate', async () => {
    const reader = new SessionTranscriptReader(workspaceDir);
    const makeHintRecords = (
      targetSessionId: string,
      suffix: string,
    ): ChatRecord[] => {
      const goalContext = {
        goalId: `goal-${suffix}`,
        revision: 1,
        turnId: `turn-${suffix}`,
      };
      return [
        {
          ...record('notification', null, 'notice', targetSessionId),
          subtype: 'notification',
          goalContext,
          systemPayload: {
            displayText: 'notice',
            backgroundTask: {
              taskId: `task-${suffix}`,
              status: 'completed',
              kind: 'agent',
            },
          },
        },
        {
          ...record('assistant', 'notification', 'result', targetSessionId),
          provenance: 'assistant_output',
          goalContext,
        },
      ];
    };
    const shortSessionId = '710e8400-e29b-41d4-a716-446655440000';
    await writeRecords(
      makeHintRecords(shortSessionId, 'short'),
      shortSessionId,
    );
    await reader.readPage(shortSessionId);
    const shortEstimate = getSessionTranscriptIndexCacheStatsForTest().byteSize;

    clearSessionTranscriptIndexCacheEntriesForTest();
    const longSessionId = '720e8400-e29b-41d4-a716-446655440000';
    const longSuffix = 'x'.repeat(8 * 1024);
    await writeRecords(
      makeHintRecords(longSessionId, longSuffix),
      longSessionId,
    );
    await reader.readPage(longSessionId);
    const longEstimate = getSessionTranscriptIndexCacheStatsForTest().byteSize;

    expect(longEstimate - shortEstimate).toBeGreaterThan(80 * 1024);
  });

  it('does not let an evicted pending build overwrite a newer cache entry', async () => {
    const initial = `${JSON.stringify(record('u1', null, 'hello'))}\n`;
    const filePath = await writeRawTranscript(initial);
    const fixed = new Date('2026-02-02T02:02:02.000Z');
    await fs.utimes(filePath, fixed, fixed);

    let buildCount = 0;
    let releaseFirstBuild: (() => void) | undefined;
    const firstBuildBlocked = new Promise<void>((resolve) => {
      releaseFirstBuild = resolve;
    });
    setSessionTranscriptIndexBuildCompleteHookForTest(async (builtPath) => {
      if (builtPath !== filePath || buildCount++ !== 0) return;
      await firstBuildBlocked;
    });

    const reader = new SessionTranscriptReader(workspaceDir);
    const staleRead = reader.readPage(sessionId);
    await vi.waitFor(() => expect(buildCount).toBe(1));

    clearSessionTranscriptIndexCacheEntriesForTest();
    await fs.writeFile(
      filePath,
      initial.replace('"uuid":"u1"', '"uuid":"x1"'),
      'utf8',
    );
    await fs.utimes(filePath, fixed, fixed);

    await expect(reader.readPage(sessionId)).resolves.toMatchObject({
      records: [expect.objectContaining({ uuid: 'x1' })],
    });

    releaseFirstBuild?.();
    await expect(staleRead).rejects.toBeInstanceOf(
      SessionTranscriptSnapshotUnavailableError,
    );
    await expect(reader.readPage(sessionId)).resolves.toMatchObject({
      records: [expect.objectContaining({ uuid: 'x1' })],
    });
  });

  it('does not let a fresh cold projection replace a cached pending build', async () => {
    const filePath = await writeRecords([
      record('u1', null, 'hello'),
      record('a1', 'u1', 'reply'),
    ]);
    let buildCount = 0;
    let releaseCachedBuild: (() => void) | undefined;
    const cachedBuildBlocked = new Promise<void>((resolve) => {
      releaseCachedBuild = resolve;
    });
    setSessionTranscriptIndexBuildCompleteHookForTest(async (builtPath) => {
      if (builtPath !== filePath) return;
      buildCount++;
      if (buildCount === 1) await cachedBuildBlocked;
    });

    const reader = new SessionTranscriptReader(workspaceDir);
    const cachedRead = reader.readPage(sessionId);
    await vi.waitFor(() => expect(buildCount).toBe(1));

    await expect(
      reader.readRestoreProjection(sessionId, { replay: { kind: 'none' } }),
    ).resolves.toBeDefined();
    expect(buildCount).toBe(2);
    expect(getSessionTranscriptIndexCacheStatsForTest()).toEqual({
      entries: 1,
      byteSize: 0,
    });

    releaseCachedBuild?.();
    await expect(cachedRead).resolves.toMatchObject({
      records: [
        expect.objectContaining({ uuid: 'u1' }),
        expect.objectContaining({ uuid: 'a1' }),
      ],
    });
    expect(
      getSessionTranscriptIndexCacheStatsForTest().byteSize,
    ).toBeGreaterThan(0);
  });

  it('evicts the least-recently-used index after 32 cached sessions', async () => {
    const reader = new SessionTranscriptReader(workspaceDir);
    for (let index = 0; index < 33; index++) {
      const targetSessionId = `00000000-0000-0000-0000-${index
        .toString(16)
        .padStart(12, '0')}`;
      await writeRecords(
        [record(`u${index}`, null, `record ${index}`, targetSessionId)],
        targetSessionId,
      );
      await reader.readPage(targetSessionId);
    }

    expect(getSessionTranscriptIndexCacheStatsForTest().entries).toBe(32);
  });

  it('rejects path-like session ids before building a transcript path', async () => {
    const reader = new SessionTranscriptReader(workspaceDir);

    await expect(reader.readPage('../escape')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('returns ENOENT for a valid session id without a transcript file', async () => {
    const reader = new SessionTranscriptReader(workspaceDir);

    await expect(reader.readPage(sessionId)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('rejects selected records from a different session', async () => {
    const foreignSessionId = '660e8400-e29b-41d4-a716-446655440000';
    await writeRecords([
      record('u1', null, 'local'),
      record('a1', 'u1', 'foreign', foreignSessionId),
    ]);

    await expect(
      new SessionTranscriptReader(workspaceDir).readPage(sessionId),
    ).rejects.toBeInstanceOf(SessionTranscriptSnapshotUnavailableError);
  });

  it('rejects foreign dead-branch metadata even when no consumer selects it', async () => {
    const foreignSessionId = '660e8400-e29b-41d4-a716-446655440000';
    const foreignMetadata: ChatRecord = {
      ...record('metadata', 'u1', '', foreignSessionId),
      type: 'system',
      subtype: 'rewind',
      message: undefined,
      systemPayload: { truncatedCount: 1 },
    };
    await writeRecords([
      record('u1', null, 'local'),
      record('a1', 'u1', 'local reply'),
      foreignMetadata,
      record('u2', 'a1', 'next local prompt'),
      record('a2', 'u2', 'next local reply'),
    ]);

    await expect(
      new SessionTranscriptReader(workspaceDir).readRestoreProjection(
        sessionId,
        { replay: { kind: 'none' } },
      ),
    ).rejects.toBeInstanceOf(SessionTranscriptSnapshotUnavailableError);
  });

  it('rejects tampered cursor snapshots before cache lookup', async () => {
    await writeRecords([
      record('u1', null, 'hello'),
      record('a1', 'u1', 'reply'),
      record('u2', 'a1', 'next'),
    ]);
    const reader = new SessionTranscriptReader(workspaceDir);
    const first = await reader.readPage(sessionId, { limit: 1 });
    const decoded = JSON.parse(
      Buffer.from(encodeCursor(first.nextCursorState!), 'base64url').toString(
        'utf8',
      ),
    ) as Record<string, unknown>;
    const tampered = Buffer.from(
      JSON.stringify({
        ...decoded,
        snapshotSize: 1,
      }),
      'utf8',
    ).toString('base64url');

    await expect(
      reader.readPage(sessionId, { cursor: tampered }),
    ).rejects.toBeInstanceOf(InvalidSessionTranscriptCursorError);
  });

  // Regression: an in-place rewrite that keeps the inode AND byte length must
  // not be masked by the index cache (cache key includes the file mtime).
  it('reflects an in-place same-size rewrite once the mtime advances', async () => {
    const mk = (uuid: string, parentUuid: string | null): ChatRecord => ({
      uuid,
      parentUuid,
      sessionId,
      timestamp: '2026-01-01T00:00:01.000Z',
      type: 'user',
      cwd: workspaceDir,
      version: '1.0.0',
      message: { role: 'user', parts: [{ text: 'hello world' }] },
    });
    const filePath = await writeRecords([
      mk('11111111', null),
      mk('22222222', '11111111'),
    ]);
    const reader = new SessionTranscriptReader(workspaceDir);
    expect(
      (await reader.readPage(sessionId, { limit: 100 })).records.map(
        (r) => r.uuid,
      ),
    ).toEqual(['11111111', '22222222']);

    // Same inode, identical byte length (8-char uuids), new content + mtime.
    await fs.writeFile(
      filePath,
      [mk('33333333', null), mk('44444444', '33333333')]
        .map((r) => JSON.stringify(r))
        .join('\n') + '\n',
      'utf8',
    );
    const later = new Date(Date.now() + 60_000);
    await fs.utimes(filePath, later, later);

    expect(
      (await reader.readPage(sessionId, { limit: 100 })).records.map(
        (r) => r.uuid,
      ),
    ).toEqual(['33333333', '44444444']);
  });

  describe('boundary and turn-start edge cases', () => {
    it('makes exact turn-boundary cuts when limit aligns perfectly', async () => {
      await writeRecords([
        record('u1', null, 'first prompt'),
        record('a1', 'u1', 'first answer'),
        record('u2', 'a1', 'second prompt'),
        record('a2', 'u2', 'second answer'),
      ]);

      const reader = new SessionTranscriptReader(workspaceDir);
      const first = await reader.readPage(sessionId, {
        beforeRecordId: 'u2',
        limit: 2,
      });

      expect(first.records.map((item) => item.uuid)).toEqual(['u1', 'a1']);
      expect(first.hasMore).toBe(false);
      expect(first.nextCursorState).toBeUndefined();
    });

    it('discovers backward boundary when beforeRecordId is an assistant record', async () => {
      await writeRecords([
        record('u1', null, 'first prompt'),
        record('a1', 'u1', 'first answer'),
        record('u2', 'a1', 'second prompt'),
        record('a2', 'u2', 'second answer'),
      ]);

      const reader = new SessionTranscriptReader(workspaceDir);
      const page = await reader.readPage(sessionId, {
        beforeRecordId: 'a2',
        limit: 2,
      });

      expect(page.records.map((item) => item.uuid)).toEqual(['u2']);
      expect(page.direction).toBe('backward');
      expect(page.hasMore).toBe(true);
    });

    it('pages backward through records without a normal user turn start', async () => {
      await writeRecords([
        record('a1', null, 'orphan assistant reply'),
        record('u1', 'a1', 'second prompt'),
        record('a2', 'u1', 'second answer'),
      ]);

      const reader = new SessionTranscriptReader(workspaceDir);
      const page = await reader.readPage(sessionId, {
        beforeRecordId: 'u1',
        limit: 5,
      });

      expect(page.records.map((item) => item.uuid)).toEqual(['a1']);
      expect(page.hasMore).toBe(false);
    });

    it('bounds backward pages inside a single long turn and still chains to the start', async () => {
      // One prompt followed by a single long in-flight turn (the concurrent
      // /review shape): the only turn start sits at the file head, so the
      // turn-alignment walk must NOT expand every backward page to the whole
      // transcript — pages stay bounded near the tail and chaining still
      // reaches the turn start.
      const records: ChatRecord[] = [record('u1', null, 'prompt')];
      for (let i = 1; i <= 300; i++) {
        records.push(
          record(`a${i}`, i === 1 ? 'u1' : `a${i - 1}`, `step ${i}`),
        );
      }
      await writeRecords(records);

      const reader = new SessionTranscriptReader(workspaceDir);
      const first = await reader.readPage(sessionId, {
        direction: 'backward',
        limit: 50,
      });

      // No turn boundary is reachable, so the page stays the requested
      // window (`limit` records, not `2 * limit`).
      expect(first.records.length).toBe(50);
      expect(first.records.at(-1)?.uuid).toBe('a300');
      expect(first.records.at(0)?.uuid).toBe('a251');
      expect(first.hasMore).toBe(true);

      // Chain backward with beforeRecordId anchors (the client's pagination
      // shape) until the turn start surfaces.
      const seen = new Set(first.records.map((item) => item.uuid));
      let boundary: string | undefined = first.records.at(0)?.uuid;
      let pages = 1;
      while (boundary !== undefined) {
        const next = await reader.readPage(sessionId, {
          beforeRecordId: boundary,
          limit: 50,
        });
        pages += 1;
        expect(next.records.length).toBeLessThanOrEqual(100);
        for (const item of next.records) seen.add(item.uuid);
        boundary = next.hasMore ? next.records.at(0)?.uuid : undefined;
        expect(pages).toBeLessThan(20);
      }
      expect(seen.size).toBe(301);
      expect(seen.has('u1')).toBe(true);
    });

    it('bounds backward turn expansion under a byte budget in a single long turn', async () => {
      const records: ChatRecord[] = [record('u1', null, 'prompt')];
      for (let i = 1; i <= 150; i++) {
        records.push(
          record(`a${i}`, i === 1 ? 'u1' : `a${i - 1}`, `x`.repeat(2000)),
        );
      }
      await writeRecords(records);

      const reader = new SessionTranscriptReader(workspaceDir);
      const page = await reader.readPage(sessionId, {
        direction: 'backward',
        limit: 50,
        maxBytes: 5000,
      });

      // The byte budget stops selection two records from the tail; the
      // turn-alignment walk must not drag the page back toward the file
      // head once alignment proves unreachable within the expansion budget.
      expect(page.records.map((item) => item.uuid)).toEqual(['a149', 'a150']);
      expect(page.hasMore).toBe(true);
    });

    it('caps turn-alignment expansion at the hard byte ceiling', async () => {
      // A byte-heavy turn whose start sits within the expansion window
      // below the selection. The caller's maxBytes is above half the
      // (test-only) ceiling, so the expansion budget is the ceiling itself
      // rather than 2 * maxBytes: the ~56 KB turn fits 2 * maxBytes
      // (64 KB) but not the 48 KB ceiling, so alignment must keep the
      // bounded selection. A mutant that dropped the ceiling clamp (or
      // ignored the override) would admit the whole turn and fail the u1
      // assertion below.
      setSessionTranscriptExpandedPageBytesForTest(48 * 1024);
      const records: ChatRecord[] = [record('u1', null, 'prompt')];
      for (let i = 1; i <= 20; i++) {
        records.push(
          record(`a${i}`, i === 1 ? 'u1' : `a${i - 1}`, 'x'.repeat(2560)),
        );
      }
      await writeRecords(records);

      const maxBytes = 32 * 1024;
      const reader = new SessionTranscriptReader(workspaceDir);
      const page = await reader.readPage(sessionId, {
        direction: 'backward',
        limit: 50,
        maxBytes,
      });

      // The soft budget admits a handful of records from the tail; the
      // ~56 KB turn exceeds the 48 KB ceiling clamp, so the bounded
      // selection stands instead of the whole turn.
      expect(page.records.length).toBeLessThan(20);
      expect(page.records.at(-1)?.uuid).toBe('a20');
      expect(page.records.some((item) => item.uuid === 'u1')).toBe(false);
      expect(page.hasMore).toBe(true);
      expect(
        mockDebugLogger.debug.mock.calls.some(
          (args) =>
            String(args[0]).includes('backward turn expansion skipped') &&
            String(args[0]).includes('reason=byte-budget'),
        ),
      ).toBe(true);

      // Chaining still reaches the turn start: once the remaining turn
      // fits the expansion budget, alignment admits it whole.
      const seen = new Set(page.records.map((item) => item.uuid));
      let boundary: string | undefined = page.records.at(0)?.uuid;
      let pages = 1;
      while (boundary !== undefined) {
        const next = await reader.readPage(sessionId, {
          beforeRecordId: boundary,
          limit: 50,
          maxBytes,
        });
        pages += 1;
        for (const item of next.records) seen.add(item.uuid);
        boundary = next.hasMore ? next.records.at(0)?.uuid : undefined;
        expect(pages).toBeLessThan(40);
      }
      expect(seen.size).toBe(records.length);
      expect(seen.has('u1')).toBe(true);
    });

    it('keeps chained backward pages within a bounded multiple of the byte budget', async () => {
      // Turn-alignment expansion is capped at a bounded multiple of the
      // caller's maxBytes, not at the hard ceiling: with the nominal route
      // budget a chained page must not balloon straight to the ceiling.
      // The ceiling clamp itself is exercised by the test above.
      const records: ChatRecord[] = [record('u1', null, 'prompt')];
      for (let i = 1; i <= 60; i++) {
        records.push(
          record(`a${i}`, i === 1 ? 'u1' : `a${i - 1}`, 'x'.repeat(3 * 1024)),
        );
      }
      await writeRecords(records);

      const maxBytes = 16 * 1024;
      const reader = new SessionTranscriptReader(workspaceDir);
      let boundary: string | undefined;
      let pages = 0;
      do {
        const page = await reader.readPage(sessionId, {
          ...(boundary === undefined
            ? { direction: 'backward' as const }
            : { beforeRecordId: boundary }),
          limit: 50,
          maxBytes,
        });
        pages += 1;
        expect(page.records.length).toBeGreaterThan(0);
        // Selection respects maxBytes and alignment may add at most one
        // extra budget on top — never the whole ceiling.
        const pageBytes = page.records.reduce(
          (total, item) => total + Buffer.byteLength(JSON.stringify(item)),
          0,
        );
        expect(pageBytes).toBeLessThanOrEqual(2 * maxBytes + 4 * 1024);
        boundary = page.hasMore ? page.records.at(0)?.uuid : undefined;
        expect(pages).toBeLessThan(40);
      } while (boundary !== undefined);
    });

    it('walks past mid-turn user records to the owning call', async () => {
      // notification, cron and goal_runtime records are persisted mid-turn
      // as user-role records. They are not turn boundaries and own no tool
      // results, so pair extension must pass through them exactly like
      // realtime records instead of starting the page on an orphan result.
      const subtypes = ['notification', 'cron', 'goal_runtime'] as const;
      for (let variant = 0; variant < subtypes.length; variant++) {
        const subtype = subtypes[variant]!;
        const targetSessionId = `550e8400-e29b-41d4-a716-44665544000${variant}`;
        const records: ChatRecord[] = [record('u1', null, 'prompt')];
        records.push(record('af0', 'u1', 'filler'));
        records.push(toolCallRecord('ac1', 'af0', 'call-1'));
        records.push(toolResultRecord('ar0', 'ac1', 'call-1'));
        records.push({
          ...record('usyn', 'ar0', 'interjection'),
          subtype,
        });
        records.push(toolResultRecord('ar1', 'usyn', 'call-1'));
        records.push(record('af1', 'ar1', 'filler'));
        // A distinct session per variant: rewriting one file in place can
        // keep the inode and byte length, which the index cache keys on.
        await writeRecords(
          records.map((item) => ({ ...item, sessionId: targetSessionId })),
          targetSessionId,
        );

        const page = await new SessionTranscriptReader(workspaceDir).readPage(
          targetSessionId,
          { direction: 'backward', limit: 3 },
        );

        expect(page.records.map((item) => item.uuid)).toEqual([
          'ac1',
          'ar0',
          'usyn',
          'ar1',
          'af1',
        ]);
        expect(page.records.at(0)?.type).not.toBe('tool_result');
      }
    });

    it('extends to the owning call when one tool_result exceeds the byte budget', async () => {
      // A tool_result larger than 2 * maxBytes is force-taken by the
      // always-take-one-record rule; the pair-extension budget must count
      // only the records the extension adds, or the oversized result it is
      // joining would fail the check by construction and the page would
      // start on an orphan result (replaying the successful call as
      // failed "result missing").
      const records: ChatRecord[] = [record('u1', null, 'prompt')];
      records.push(toolCallRecord('ac1', 'u1', 'call-1'));
      records.push({
        ...toolResultRecord('ar1', 'ac1', 'call-1'),
        message: {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'run_shell_command',
                id: 'call-1',
                response: { output: 'x'.repeat(3 * 1024 * 1024) },
              },
            },
          ],
        },
      });
      await writeRecords(records);

      const page = await new SessionTranscriptReader(workspaceDir).readPage(
        sessionId,
        { direction: 'backward', limit: 50, maxBytes: 1024 * 1024 },
      );

      expect(page.records.map((item) => item.uuid)).toEqual(['ac1', 'ar1']);
      expect(page.records.at(0)?.type).toBe('assistant');
      expect(page.hasMore).toBe(true);
    });

    it('keeps the pair together when the owning call exceeds the expansion budget', async () => {
      // The owner assistant record can itself exceed the expansion byte
      // budget (e.g. one write_file call carrying a large file body). Pair
      // extension exempts the force-joined owner the way the selection loop
      // exempts its forced first record, instead of failing the byte check
      // by construction and splitting the pair — which would replay the
      // successful call as failed ("result missing") on the older page.
      const records: ChatRecord[] = [record('u1', null, 'prompt')];
      records.push({
        ...toolCallRecord('ac1', 'u1', 'call-1'),
        message: {
          role: 'model',
          parts: [
            {
              functionCall: {
                name: 'write_file',
                id: 'call-1',
                args: { content: 'x'.repeat(40 * 1024) },
              },
            },
          ],
        },
      });
      records.push(toolResultRecord('ar1', 'ac1', 'call-1'));
      await writeRecords(records);

      const page = await new SessionTranscriptReader(workspaceDir).readPage(
        sessionId,
        { direction: 'backward', limit: 50, maxBytes: 16 * 1024 },
      );

      expect(page.records.map((item) => item.uuid)).toEqual(['ac1', 'ar1']);
      expect(page.records.at(0)?.type).toBe('assistant');
      expect(page.hasMore).toBe(true);
    });

    it('does not expand a backward page when no tool pair is split', async () => {
      // Pair extension exists to keep tool call/result pairs on one page.
      // When the selection holds no orphaned tool_result, walking further
      // down gains nothing — even though system records are not page
      // starts — and only inflates the page past `limit`.
      const records: ChatRecord[] = [record('u0', null, 'prompt')];
      let parent = 'u0';
      for (let i = 0; i < 10; i++) {
        records.push(record(`a${i}`, parent, `step ${i}`));
        parent = `a${i}`;
      }
      records.push({
        ...record('sys1', 'a9', 'goal state'),
        type: 'system',
        subtype: 'goal_state',
        message: undefined,
      });
      records.push(record('a10', 'sys1', 'step 10'));
      records.push(record('a11', 'a10', 'step 11'));
      await writeRecords(records);

      const page = await new SessionTranscriptReader(workspaceDir).readPage(
        sessionId,
        { direction: 'backward', limit: 3 },
      );

      expect(page.records.map((item) => item.uuid)).toEqual([
        'sys1',
        'a10',
        'a11',
      ]);
      expect(page.hasMore).toBe(true);
    });

    it('does not walk past an anchored realtime record without a pair', async () => {
      // Turn alignment may legitimately anchor a page on a realtime user
      // record. With no orphaned tool_result in the selection the pair
      // walk must not refuse that anchor and drag the page back to an
      // earlier assistant, burning the whole expansion window.
      const records: ChatRecord[] = [];
      for (let i = 0; i < 10; i++) {
        records.push(
          record(`af${i}`, i === 0 ? null : `af${i - 1}`, `filler ${i}`),
        );
      }
      let parent = 'af9';
      for (let i = 0; i < 3; i++) {
        records.push({
          ...record(`urt${i}`, parent, `user speech ${i}`),
          subtype: 'realtime_message',
        });
        records.push({
          ...record(`art${i}`, `urt${i}`, `assistant speech ${i}`),
          subtype: 'realtime_message',
        });
        parent = `art${i}`;
      }
      await writeRecords(records);

      const page = await new SessionTranscriptReader(workspaceDir).readPage(
        sessionId,
        { direction: 'backward', limit: 4 },
      );

      expect(page.records.map((item) => item.uuid)).toEqual([
        'urt1',
        'art1',
        'urt2',
        'art2',
      ]);
      expect(page.hasMore).toBe(true);
    });

    it('bounds the leading prefix absorbed before the first turn', async () => {
      // Sessions can persist a long run of system records ahead of the
      // first turn. Aligning to the first turn must not absorb an
      // arbitrarily long leading prefix: worst case a page holds
      // 3 * limit records.
      const records: ChatRecord[] = [];
      for (let i = 0; i < 200; i++) {
        records.push({
          ...record(`sys${i}`, i === 0 ? null : `sys${i - 1}`, `event ${i}`),
          type: 'system',
          subtype: 'ui_telemetry',
          message: undefined,
        });
      }
      records.push(record('u1', 'sys199', 'prompt'));
      let parent = 'u1';
      for (let i = 1; i <= 5; i++) {
        records.push(record(`a${i}`, parent, `step ${i}`));
        parent = `a${i}`;
      }
      await writeRecords(records);

      const reader = new SessionTranscriptReader(workspaceDir);
      const first = await reader.readPage(sessionId, {
        direction: 'backward',
        limit: 10,
      });

      expect(first.records.map((item) => item.uuid)).toEqual([
        'u1',
        'a1',
        'a2',
        'a3',
        'a4',
        'a5',
      ]);
      expect(first.hasMore).toBe(true);
      expect(
        mockDebugLogger.debug.mock.calls.some(
          (args) =>
            String(args[0]).includes('backward turn expansion skipped') &&
            String(args[0]).includes('reason=record-budget'),
        ),
      ).toBe(true);

      // Chaining still covers the whole leading prefix.
      const seen = new Set(first.records.map((item) => item.uuid));
      let boundary: string | undefined = first.records.at(0)?.uuid;
      let pages = 1;
      while (boundary !== undefined) {
        const next = await reader.readPage(sessionId, {
          beforeRecordId: boundary,
          limit: 10,
        });
        pages += 1;
        for (const item of next.records) seen.add(item.uuid);
        boundary = next.hasMore ? next.records.at(0)?.uuid : undefined;
        expect(pages).toBeLessThan(40);
      }
      expect(seen.size).toBe(records.length);
    });

    it('keeps tool call/result pairs on the same backward page', async () => {
      // A single long turn of assistant tool calls and persisted results.
      // Call 30 has two results (a parallel batch) so backward page
      // boundaries land mid-run on tool_result records. Backward replay
      // finalizes each page independently, so a boundary between a call and
      // its result would render the completed call as failed on the older
      // page and the result as an orphan block on the newer one.
      const records: ChatRecord[] = [record('u1', null, 'prompt')];
      const resultsByCall = new Map<string, string[]>();
      let parent = 'u1';
      for (let i = 1; i <= 120; i++) {
        const callUuid = `ac${i}`;
        const callId = `call-${i}`;
        records.push(toolCallRecord(callUuid, parent, callId));
        const resultUuids: string[] = [];
        let resultParent = callUuid;
        for (let r = 0; r < (i === 30 ? 2 : 1); r++) {
          const resultUuid = i === 30 ? `ar30-${r}` : `ar${i}`;
          records.push(toolResultRecord(resultUuid, resultParent, callId));
          resultUuids.push(resultUuid);
          resultParent = resultUuid;
        }
        resultsByCall.set(callUuid, resultUuids);
        parent = resultUuids[resultUuids.length - 1]!;
      }
      await writeRecords(records);

      const reader = new SessionTranscriptReader(workspaceDir);
      const pages: ChatRecord[][] = [];
      let page = await reader.readPage(sessionId, {
        direction: 'backward',
        limit: 50,
      });
      for (;;) {
        pages.push(page.records);
        expect(page.records.length).toBeGreaterThan(0);
        if (!page.hasMore) break;
        const boundary = page.records.at(0)?.uuid;
        expect(boundary).toBeDefined();
        page = await reader.readPage(sessionId, {
          beforeRecordId: boundary,
          limit: 50,
        });
        expect(pages.length).toBeLessThan(20);
      }

      let sawMidTurnCallStart = false;
      for (const pageRecords of pages) {
        // A page starting at a tool_result would replay that result without
        // its call.
        expect(pageRecords.at(0)?.type).not.toBe('tool_result');
        const uuids = new Set(pageRecords.map((item) => item.uuid));
        for (const item of pageRecords) {
          if (item.type === 'tool_result') {
            expect(item.parentUuid).not.toBeNull();
            expect(uuids.has(item.parentUuid!)).toBe(true);
          }
          const results = resultsByCall.get(item.uuid);
          if (results) {
            for (const resultUuid of results) {
              expect(uuids.has(resultUuid)).toBe(true);
            }
            if (pageRecords.at(0)?.uuid === item.uuid) {
              sawMidTurnCallStart = true;
            }
          }
        }
        // Symmetric end invariant: the page must not end on a call whose
        // results live on the newer page (without a byte budget the pair
        // extension always succeeds, so no accepted mid-pair edge exists).
        const lastResults = resultsByCall.get(pageRecords.at(-1)?.uuid ?? '');
        if (lastResults) {
          for (const resultUuid of lastResults) {
            expect(uuids.has(resultUuid)).toBe(true);
          }
        }
      }
      // The chain really exercised mid-turn page starts, not just
      // turn-aligned pages.
      expect(sawMidTurnCallStart).toBe(true);

      const flat = pages.flat();
      expect(flat.length).toBe(records.length);
      expect(new Set(flat.map((item) => item.uuid)).size).toBe(records.length);
      expect(flat.some((item) => item.uuid === 'u1')).toBe(true);
    });

    it('extends a byte-limited backward page to the owning tool call', async () => {
      const records: ChatRecord[] = [record('u1', null, 'prompt')];
      let parent = 'u1';
      for (let i = 1; i <= 3; i++) {
        records.push(toolCallRecord(`ac${i}`, parent, `call-${i}`));
        records.push(toolResultRecord(`ar${i}`, `ac${i}`, `call-${i}`));
        parent = `ar${i}`;
      }
      await writeRecords(records);

      // Budget admits only the trailing tool_result; the page must still
      // extend to the owning call rather than split the pair.
      const resultBytes = Buffer.byteLength(JSON.stringify(records.at(-1)));
      const page = await new SessionTranscriptReader(workspaceDir).readPage(
        sessionId,
        {
          direction: 'backward',
          limit: 2,
          maxBytes: resultBytes,
        },
      );

      expect(page.records.map((item) => item.uuid)).toEqual(['ac3', 'ar3']);
      expect(page.hasMore).toBe(true);
    });

    it('extends the page to an owning call several records below the selection', async () => {
      // One call owning a tool_result run long enough that the natural
      // selection starts mid-run: the page must extend through the whole
      // result run to the owning call instead of starting mid-pair on a
      // tool_result.
      const records: ChatRecord[] = [record('u1', null, 'prompt')];
      records.push(toolCallRecord('ac1', 'u1', 'call-1'));
      let parent = 'ac1';
      for (let i = 0; i < 5; i++) {
        records.push(toolResultRecord(`ar${i}`, parent, 'call-1'));
        parent = `ar${i}`;
      }
      await writeRecords(records);

      // limit 3 lands the natural selection start on the third result
      // (ar2); the owning call sits exactly three records below it, at the
      // edge of the one-window pair-extension budget.
      const page = await new SessionTranscriptReader(workspaceDir).readPage(
        sessionId,
        { direction: 'backward', limit: 3 },
      );

      expect(page.records.map((item) => item.uuid)).toEqual([
        'ac1',
        'ar0',
        'ar1',
        'ar2',
        'ar3',
        'ar4',
      ]);
      expect(page.records.at(0)?.type).not.toBe('tool_result');
      expect(page.hasMore).toBe(true);
    });

    it('walks past interleaved realtime records to the owning call', async () => {
      // Realtime conversation records persist at wall-clock time and can
      // land between a call and its results. They own no tool results, so
      // pair extension must pass through them instead of splitting the
      // pair at the interjection.
      const records: ChatRecord[] = [record('u1', null, 'prompt')];
      records.push(record('af0', 'u1', 'filler'));
      records.push(toolCallRecord('ac1', 'af0', 'call-1'));
      records.push(toolResultRecord('ar0', 'ac1', 'call-1'));
      records.push({
        ...record('a-live', 'ar0', 'live interjection'),
        subtype: 'realtime_message',
      });
      records.push(toolResultRecord('ar1', 'a-live', 'call-1'));
      records.push(record('af1', 'ar1', 'filler'));
      await writeRecords(records);

      // limit 3 lands the natural selection start on the realtime record;
      // the owning call sits three records below it, at the edge of the
      // one-window pair-extension budget.
      const page = await new SessionTranscriptReader(workspaceDir).readPage(
        sessionId,
        { direction: 'backward', limit: 3 },
      );

      expect(page.records.map((item) => item.uuid)).toEqual([
        'ac1',
        'ar0',
        'a-live',
        'ar1',
        'af1',
      ]);
      expect(page.records.at(0)?.type).not.toBe('tool_result');
      expect(page.hasMore).toBe(true);
    });

    it('caps pair extension at the byte budget for a large result batch', async () => {
      // A long single turn whose tail holds a parallel batch of large
      // tool_result records owned by one call. The byte budget stops the
      // selection mid-batch; pair extension toward the owner would absorb
      // the rest of the batch and balloon the page far past the budget
      // (toward the route's hard response cap), so the bounded selection
      // must stand and chaining continues from the mid-batch anchor.
      const records: ChatRecord[] = [record('u1', null, 'prompt')];
      let parent = 'u1';
      for (let i = 1; i <= 150; i++) {
        records.push(record(`af${i}`, parent, `step ${i}`));
        parent = `af${i}`;
      }
      records.push(toolCallRecord('ac1', parent, 'call-1'));
      parent = 'ac1';
      for (let i = 0; i < 50; i++) {
        const resultUuid = `ar${i}`;
        records.push({
          ...toolResultRecord(resultUuid, parent, 'call-1'),
          message: {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  name: 'run_shell_command',
                  id: 'call-1',
                  response: { output: 'x'.repeat(4000) },
                },
              },
            ],
          },
        });
        parent = resultUuid;
      }
      await writeRecords(records);

      const reader = new SessionTranscriptReader(workspaceDir);
      const page = await reader.readPage(sessionId, {
        direction: 'backward',
        limit: 100,
        maxBytes: 10000,
      });

      // The budget admits two large results; the 49-record extension to the
      // owning call does not fit one extra budget, so the page stays at the
      // bounded selection (a mid-batch boundary) instead of 51 records.
      expect(page.records.map((item) => item.uuid)).toEqual(['ar48', 'ar49']);
      expect(page.hasMore).toBe(true);
      expect(
        mockDebugLogger.debug.mock.calls.some(
          (args) =>
            String(args[0]).includes('backward pair extension skipped') &&
            String(args[0]).includes('reason=byte-budget'),
        ),
      ).toBe(true);

      // Chaining continues from the mid-batch anchor under the same byte
      // budget: every page stays bounded, chaining terminates, and the full
      // record set is covered exactly once.
      const seen = new Set(page.records.map((item) => item.uuid));
      let boundary: string | undefined = page.records.at(0)?.uuid;
      let pages = 1;
      while (boundary !== undefined) {
        const next = await reader.readPage(sessionId, {
          beforeRecordId: boundary,
          limit: 100,
          maxBytes: 10000,
        });
        pages += 1;
        expect(next.records.length).toBeGreaterThan(0);
        expect(next.records.length).toBeLessThanOrEqual(200);
        for (const item of next.records) seen.add(item.uuid);
        boundary = next.hasMore ? next.records.at(0)?.uuid : undefined;
        expect(pages).toBeLessThan(40);
      }
      expect(seen.size).toBe(records.length);
      expect(seen.has('u1')).toBe(true);
    });

    it('caps pair extension for a long tool_result run', async () => {
      // One assistant record owning a long contiguous tool_result run (a
      // persisted parallel batch): the walk toward the owning call must
      // stay bounded instead of absorbing the whole run, and chaining must
      // still reach the owner and the turn start.
      const records: ChatRecord[] = [record('u1', null, 'prompt')];
      records.push(toolCallRecord('ac1', 'u1', 'call-1'));
      let parent = 'ac1';
      for (let i = 0; i < 400; i++) {
        const resultUuid = `ar${i}`;
        records.push(toolResultRecord(resultUuid, parent, 'call-1'));
        parent = resultUuid;
      }
      await writeRecords(records);

      const reader = new SessionTranscriptReader(workspaceDir);
      const first = await reader.readPage(sessionId, {
        direction: 'backward',
        limit: 50,
      });

      expect(first.records.length).toBeLessThanOrEqual(100);
      // The owner lies below the expansion budget, so the bounded selection
      // stands and the page starts mid-run on a tool_result record.
      expect(first.records.at(0)?.type).toBe('tool_result');
      expect(first.records.at(-1)?.uuid).toBe('ar399');
      expect(first.hasMore).toBe(true);
      expect(
        mockDebugLogger.debug.mock.calls.some(
          (args) =>
            String(args[0]).includes('backward pair extension skipped') &&
            String(args[0]).includes('reason=record-budget'),
        ),
      ).toBe(true);

      const seen = new Set(first.records.map((item) => item.uuid));
      let boundary: string | undefined = first.records.at(0)?.uuid;
      let pages = 1;
      while (boundary !== undefined) {
        const next = await reader.readPage(sessionId, {
          beforeRecordId: boundary,
          limit: 50,
        });
        pages += 1;
        // Contract bound: requested window + one alignment window + one
        // pair-extension window (the page absorbing the owning call).
        expect(next.records.length).toBeLessThanOrEqual(150);
        for (const item of next.records) seen.add(item.uuid);
        boundary = next.hasMore ? next.records.at(0)?.uuid : undefined;
        expect(pages).toBeLessThan(20);
      }
      expect(seen.size).toBe(records.length);
      expect(seen.has('ac1')).toBe(true);
      expect(seen.has('u1')).toBe(true);
    });

    it('keeps a byte-limited page bounded against a long tool_result run', async () => {
      const records: ChatRecord[] = [record('u1', null, 'prompt')];
      records.push(toolCallRecord('ac1', 'u1', 'call-1'));
      let parent = 'ac1';
      for (let i = 0; i < 400; i++) {
        const resultUuid = `ar${i}`;
        records.push(toolResultRecord(resultUuid, parent, 'call-1'));
        parent = resultUuid;
      }
      await writeRecords(records);

      const page = await new SessionTranscriptReader(workspaceDir).readPage(
        sessionId,
        { direction: 'backward', limit: 50, maxBytes: 5000 },
      );

      // The budget admits only a few records; pair extension must not drag
      // the page back through the 400-record run toward the owning call.
      expect(page.records.length).toBeGreaterThan(0);
      expect(page.records.length).toBeLessThanOrEqual(100);
      expect(page.records.at(0)?.type).toBe('tool_result');
      expect(page.records.at(-1)?.uuid).toBe('ar399');
      expect(page.hasMore).toBe(true);
    });
  });
});

describe('isReplayTurnStartType', () => {
  it('treats only non-mid-turn user records as turn starts', () => {
    expect(isReplayTurnStartType('user', undefined)).toBe(true);
    expect(isReplayTurnStartType('user', 'slash_command')).toBe(true);
    expect(isReplayTurnStartType('user', 'realtime_message')).toBe(true);
    expect(isReplayTurnStartType('user', 'mid_turn_user_message')).toBe(false);
    expect(isReplayTurnStartType('user', 'notification')).toBe(false);
    expect(isReplayTurnStartType('user', 'cron')).toBe(false);
    expect(isReplayTurnStartType('user', 'goal_runtime')).toBe(false);
    expect(isReplayTurnStartType('assistant', undefined)).toBe(false);
    expect(isReplayTurnStartType(undefined, undefined)).toBe(false);
  });
});
