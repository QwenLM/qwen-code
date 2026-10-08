/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockDebugLogger, mockAddDaemonRequestAttribute, statFault } =
  vi.hoisted(() => ({
    mockDebugLogger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
    mockAddDaemonRequestAttribute: vi.fn(),
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
    open: vi.fn(actual.open),
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
import type { Config } from '../config/config.js';
import { CompressionStatus } from '../core/turn.js';
import { detectTurnInterruption } from '../core/turn-interruption.js';
import {
  SessionSourceService,
  type SessionSourcesSnapshot,
} from './session-sources.js';
import {
  ChatRecordingService,
  type ChatRecord,
} from './chatRecordingService.js';
import { buildSessionHistoryFromConversation } from './session-api-history.js';
import { ApprovalMode } from '../config/approval-mode.js';
import {
  buildApiHistoryFromConversation,
  getResumeTokenCounts,
  SessionService,
} from './sessionService.js';
import { collectSessionTurnState } from './session-turn-state.js';
import { recoverGoalFromRecords } from '../goals/goal-persistence.js';
import type { GoalStateRecordPayloadV2 } from '../goals/goal-protocol.js';
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
  type SelectiveSessionRestoreOptions,
  type SessionTranscriptCursorState,
  type SessionTranscriptReadPageOptions,
  type SessionTranscriptRecordPage,
} from './session-transcript-reader.js';
import {
  content,
  fnCall,
  fnResponse,
  modelText,
  userText,
} from '../test-utils/model-fixtures.js';

const BadCursor = InvalidSessionTranscriptCursorError;
const Unavailable = SessionTranscriptSnapshotUnavailableError;
const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-01-01T00:00:01.000Z';

function rejectsWith(
  promise: Promise<unknown>,
  error: abstract new (...args: never[]) => unknown,
) {
  return expect(promise).rejects.toBeInstanceOf(error);
}

/** A v2 goal_state payload with the given objective, as the runtime journals it. */
function goalStatePayload(
  objective: string,
  recordId: string | null = 'cursor',
  goalId = `goal-${objective.replace(/\W+/g, '-')}`,
  turnCount = 0,
): GoalStateRecordPayloadV2 {
  return {
    v: 2,
    cause: 'create',
    snapshot: {
      v: 2,
      activity: 'idle',
      goal: {
        goalId,
        revision: 1,
        objective,
        status: 'active',
        evidenceCursor: { recordId },
        turnCount,
        activeTimeMs: 0,
        tokensUsed: 0,
        createdAt: 1,
        updatedAt: 1,
      },
    },
  };
}

const uuids = (records?: ReadonlyArray<{ uuid: string }>) =>
  records?.map((item) => item.uuid);

/** Total JSON byte length of the given records, as the reader counts them. */
const jsonBytes = (...items: unknown[]) =>
  items.reduce<number>(
    (total, item) => total + Buffer.byteLength(JSON.stringify(item)),
    0,
  );

/** One JSONL line holding the given records glued together. */
const jsonLine = (...items: unknown[]) =>
  items.map((item) => JSON.stringify(item)).join('') + '\n';

/** Rewrites a base64url JSON token's fields without re-signing it. */
const forgeToken = (
  token: string,
  patch: (decoded: Record<string, unknown>) => Record<string, unknown>,
) =>
  Buffer.from(
    JSON.stringify(
      patch(JSON.parse(Buffer.from(token, 'base64url').toString('utf8'))),
    ),
    'utf8',
  ).toString('base64url');

const controlContext = (text: string) =>
  `<qwen:user-prompt-submit-context>\n${text}\n</qwen:user-prompt-submit-context>`;

const TWO_TURNS = [
  'first prompt',
  'first answer',
  'second prompt',
  'second answer',
];

describe('SessionTranscriptReader', () => {
  let runtimeDir: string;
  let workspaceDir: string;
  const sessionId = '550e8400-e29b-41d4-a716-446655440000';
  const otherSessionId = '660e8400-e29b-41d4-a716-446655440000';
  const NONE = { replay: { kind: 'none' } } as const;
  const BACK = { direction: 'backward' } as const;
  const all = (hideInheritedHistory: boolean) => ({
    replay: { kind: 'all' as const, hideInheritedHistory },
  });
  const recent = (limit = 2, hideInheritedHistory = false) => ({
    replay: { kind: 'recent' as const, limit, hideInheritedHistory },
  });

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

  async function writeRawTranscript(
    text: string,
    targetSessionId = sessionId,
  ): Promise<string> {
    const chatsDir = path.join(
      new Storage(workspaceDir).getProjectDir(),
      'chats',
    );
    await fs.mkdir(chatsDir, { recursive: true });
    const filePath = path.join(chatsDir, `${targetSessionId}.jsonl`);
    await fs.writeFile(filePath, text, 'utf8');
    return filePath;
  }

  const writeRecords = (records: ChatRecord[], targetSessionId = sessionId) =>
    writeRawTranscript(
      records.map((item) => jsonLine(item)).join(''),
      targetSessionId,
    );

  const appendRecords = (filePath: string, ...records: ChatRecord[]) =>
    fs.appendFile(filePath, records.map((item) => jsonLine(item)).join(''));

  // Monotonic, always-valid ISO 8601 timestamps in call order. Deriving the
  // seconds from `text.length` produced invalid values (`00:00:013`) once a
  // text reached 10+ chars; base + per-record offset stays valid at any count.
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
      provenance: uuid.startsWith('a') ? 'assistant_output' : 'real_user',
      cwd: workspaceDir,
      version: '1.0.0',
      message: {
        role: uuid.startsWith('a') ? 'model' : 'user',
        parts: [{ text }],
      },
    };
  }

  /** u1, a1, u2, a2, ... each the child of the one before, with these texts. */
  function chain(...texts: string[]): ChatRecord[] {
    const id = (i: number) => `${i % 2 ? 'a' : 'u'}${Math.floor(i / 2) + 1}`;
    return texts.map((text, i) => record(id(i), i ? id(i - 1) : null, text));
  }

  /** `${prefix}${from..to}`, each the child of the one before; the first's parent is `parentUuid`. */
  function linear(
    prefix: string,
    from: number,
    to: number,
    parentUuid: string | null,
    text: (i: number) => string,
    targetSessionId = sessionId,
  ): ChatRecord[] {
    const records: ChatRecord[] = [];
    for (let i = from; i <= to; i++) {
      const parent = i === from ? parentUuid : `${prefix}${i - 1}`;
      records.push(record(`${prefix}${i}`, parent, text(i), targetSessionId));
    }
    return records;
  }

  /** One prompt followed by a single long turn of `count` assistant records. */
  const longTurn = (count: number, text: (i: number) => string) => [
    record('u1', null, 'prompt'),
    ...linear('a', 1, count, 'u1', text),
  ];

  /** A system record: `record()` with type `system` and no message. */
  function sys(
    uuid: string,
    parentUuid: string | null,
    subtype: string,
    systemPayload?: unknown,
    extra: Partial<ChatRecord> = {},
  ): ChatRecord {
    return {
      ...record(uuid, parentUuid, ''),
      type: 'system',
      subtype,
      message: undefined,
      ...extra,
      ...(systemPayload !== undefined ? { systemPayload } : {}),
    } as ChatRecord;
  }

  /** `record()` (message kept) tagged with a subtype and optional payload. */
  const sub = (
    uuid: string,
    parentUuid: string | null,
    text: string,
    subtype: string,
    systemPayload?: unknown,
  ) =>
    ({
      ...record(uuid, parentUuid, text),
      subtype,
      ...(systemPayload !== undefined ? { systemPayload } : {}),
    }) as ChatRecord;

  /** A `session_source` record that, unlike `sys()`, keeps its message. */
  const sourceRecord = (
    uuid: string,
    parentUuid: string | null,
    text: string,
    systemPayload?: unknown,
  ) =>
    ({
      ...sub(uuid, parentUuid, text, 'session_source', systemPayload),
      type: 'system',
    }) as ChatRecord;

  /** Marks a record as inherited from a parent session under the same uuid. */
  const inherited = (
    item: ChatRecord,
    parentSessionId = 'parent-session',
  ): ChatRecord => ({
    ...item,
    forkedFrom: { sessionId: parentSessionId, messageUuid: item.uuid },
  });

  const branchCheckpoint = (uuid: string) =>
    sys(uuid, 'a1', 'branch_checkpoint', {
      v: 1,
      startExclusiveRecordUuid: null,
      assistantRecordUuid: 'a1',
    });

  const compressedTurn = () => ({
    compressedHistory: [
      userText('compressed prompt'),
      modelText('compressed answer'),
    ],
    info: { newTokenCount: 20, newTokenCountIsEstimated: false },
  });

  const artifactId = (url: string) =>
    stableSessionArtifactId(sessionId, `url:${url}`);

  /** A one-change `session_artifact_event` payload creating a link artifact. */
  function artifactEvent(
    url: string,
    title: string,
    recordedAt = T1,
    at = recordedAt,
    sequence = 1,
  ) {
    const id = artifactId(url);
    return {
      v: SESSION_ARTIFACT_PERSISTENCE_VERSION,
      sessionId,
      sequence,
      recordedAt,
      changes: [
        {
          action: 'created',
          artifactId: id,
          artifact: {
            id,
            kind: 'link',
            storage: 'external_url',
            source: 'client',
            status: 'available',
            title,
            url,
            retention: 'restorable',
            clientRetained: true,
            createdAt: at,
            updatedAt: at,
            persistedAt: at,
          },
        },
      ],
    };
  }

  function toolCallRecord(
    uuid: string,
    parentUuid: string,
    callId: string,
    name = 'run_shell_command',
    args: Record<string, unknown> = {},
  ): ChatRecord {
    return {
      ...record(uuid, parentUuid, ''),
      message: {
        role: 'model',
        parts: [{ functionCall: { name, id: callId, args } }],
      },
    };
  }

  function toolResultRecord(
    uuid: string,
    parentUuid: string,
    callId: string,
    output = 'ok',
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
              response: { output },
            },
          },
        ],
      },
      toolCallResult: { callId, status: 'success' },
    };
  }

  /** ar0..ar{count-1}: a contiguous tool_result run for call-1 under `parent`. */
  const resultRun = (count: number, parent: string, output?: string) =>
    Array.from({ length: count }, (_, i) =>
      toolResultRecord(`ar${i}`, i ? `ar${i - 1}` : parent, 'call-1', output),
    );

  /** A prompt and one call (ac1) owning a run of `count` results. */
  const callWithResults = (count: number) => [
    record('u1', null, 'prompt'),
    toolCallRecord('ac1', 'u1', 'call-1'),
    ...resultRun(count, 'ac1'),
  ];

  /** A prompt, a tool call (a-tool), its result (t1), and a final answer. */
  const toolTurn = (prompt: string, answerUuid: string, answer: string) => [
    record('u1', null, prompt),
    record('a-tool', 'u1', 'call tool'),
    { ...record('t1', 'a-tool', 'tool result'), type: 'tool_result' as const },
    record(answerUuid, 't1', answer),
  ];

  function encodeCursor(state: SessionTranscriptCursorState): string {
    return encodeSessionTranscriptCursor(state, workspaceDir);
  }

  const svc = () =>
    new SessionService(workspaceDir, { runtimeBaseDir: runtimeDir });
  const newReader = () => new SessionTranscriptReader(workspaceDir);
  const readPage = (options?: SessionTranscriptReadPageOptions) =>
    newReader().readPage(sessionId, options);
  const readAfter = (
    reader: SessionTranscriptReader,
    state: SessionTranscriptCursorState,
    options: SessionTranscriptReadPageOptions = {},
  ) => reader.readPage(sessionId, { ...options, cursor: encodeCursor(state) });
  const coldProjection = (options: SelectiveSessionRestoreOptions = NONE) =>
    newReader().readRestoreProjection(sessionId, options);
  const turnIndex = (options?: { limit?: number }) =>
    newReader().readTurnIndexPage(sessionId, options);
  const loadAndRestore = (service = svc()) =>
    Promise.all([
      service.loadSession(sessionId),
      service.readRestoreProjection(sessionId, NONE),
    ]);

  /** The cold runtime state and the live projection, read in that order. */
  async function restoredAndLive(service: SessionService) {
    const restored = await service.readRestoreProjection(sessionId, NONE);
    const live = await service.readLiveRestoreProjection(sessionId, NONE);
    return [restored?.runtime, live] as const;
  }

  function expectSourcesUnavailable(
    ...states: Array<
      { sourcesUnavailable?: boolean; sourcesSnapshot?: unknown } | undefined
    >
  ) {
    for (const state of states) {
      expect(state?.sourcesUnavailable).toBe(true);
      expect(state?.sourcesSnapshot).toBeUndefined();
    }
  }

  const sourceService = (persist: (snapshot: SessionSourcesSnapshot) => void) =>
    new SessionSourceService({
      sessionId,
      workspaceCwd: () => workspaceDir,
      load: async () => ({}),
      persist: async (snapshot) => {
        persist(snapshot);
      },
    });

  function expectPage(
    page: SessionTranscriptRecordPage,
    ids: string[],
    hasMore: boolean,
  ) {
    expect(uuids(page.records)).toEqual(ids);
    expect(page.hasMore).toBe(hasMore);
  }

  /** Writes a chain of these texts and reads its first one-record page. */
  async function firstPage(...texts: string[]) {
    const filePath = await writeRecords(chain(...texts));
    const reader = newReader();
    const first = await reader.readPage(sessionId, { limit: 1 });
    return { filePath, reader, first, state: first.nextCursorState! };
  }

  /**
   * Follows `beforeRecordId` anchors (the client's pagination shape) from
   * `page` until no older page remains, asserting the page count stays under
   * `maxPages`. Returns every uuid seen, `page` included.
   */
  async function chainBackward(
    reader: SessionTranscriptReader,
    page: SessionTranscriptRecordPage,
    options: SessionTranscriptReadPageOptions,
    maxPages: number,
    check?: (next: SessionTranscriptRecordPage) => void,
  ): Promise<Set<string>> {
    const seen = new Set(uuids(page.records));
    let boundary = page.records.at(0)?.uuid;
    for (let pages = 2; boundary !== undefined; pages++) {
      const next = await reader.readPage(sessionId, {
        beforeRecordId: boundary,
        ...options,
      });
      check?.(next);
      for (const item of next.records) seen.add(item.uuid);
      boundary = next.hasMore ? next.records.at(0)?.uuid : undefined;
      expect(pages).toBeLessThan(maxPages);
    }
    return seen;
  }

  const expectSkipLogged = (step: string, reason: string) =>
    expect(
      mockDebugLogger.debug.mock.calls.some(
        (args) =>
          String(args[0]).includes(`backward ${step} skipped`) &&
          String(args[0]).includes(`reason=${reason}`),
      ),
    ).toBe(true);

  const expectEmptyCache = () =>
    expect(getSessionTranscriptIndexCacheStatsForTest()).toEqual({
      entries: 0,
      byteSize: 0,
    });

  const expectRestoreAttribute = (name: string, value: unknown) =>
    expect(mockAddDaemonRequestAttribute).toHaveBeenCalledWith(
      `qwen-code.daemon.session_restore.${name}`,
      value,
    );

  function countBuilds(filePath: string) {
    const builds = { count: 0 };
    setSessionTranscriptIndexBuildCompleteHookForTest((builtPath) => {
      if (builtPath === filePath) builds.count++;
    });
    return builds;
  }

  const pinMtime = (filePath: string) => {
    const fixed = new Date('2026-02-02T02:02:02.000Z');
    return fs.utimes(filePath, fixed, fixed);
  };

  /** Same inode, byte length and (pinned) mtime, but u1 renamed to x1. */
  async function renameU1InPlace(filePath: string, initial: string) {
    await fs.writeFile(
      filePath,
      initial.replace('"uuid":"u1"', '"uuid":"x1"'),
      'utf8',
    );
    await pinMtime(filePath);
  }

  const cursorKeyPath = () =>
    path.join(
      new Storage(workspaceDir).getProjectDir(),
      'session-transcript-cursor-key',
    );

  it.each([false, true])(
    'restores completed slash commands consistently with compression=%s',
    async (compressed) => {
      const answer = record('a1', null, 'previous answer');
      const prefix: ChatRecord = compressed
        ? {
            ...answer,
            type: 'system',
            subtype: 'chat_compression',
            message: undefined,
            systemPayload: {
              info: {
                originalTokenCount: 100,
                newTokenCount: 50,
                compressionStatus: CompressionStatus.COMPRESSED,
              },
              compressedHistory: [answer.message!],
            },
          }
        : answer;
      const user = record('u1', 'a1', '/docs');
      const output = sys('output', 'u1', 'slash_command', {
        phase: 'result',
        rawCommand: '/docs',
        outputHistoryItems: [{ type: 'assistant', text: 'Documentation URL' }],
      });
      await writeRecords([prefix, user, output]);
      const service = svc();
      const loaded = await service.loadSession(sessionId);
      const history = buildApiHistoryFromConversation(loaded!.conversation);
      expect(history).toEqual([answer.message]);
      expect(detectTurnInterruption(history).kind).toBe('none');
      for (const options of [NONE, all(false)]) {
        const projection = await service.readRestoreProjection(
          sessionId,
          options,
        );
        expect(projection?.runtime.apiHistory).toEqual(history);
        if (options.replay.kind === 'all') {
          expect(projection?.replay?.records).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ uuid: 'u1', message: user.message }),
              expect.objectContaining({
                uuid: 'output',
                systemPayload: output.systemPayload,
              }),
            ]),
          );
        }
      }

      const invocation: ChatRecord = {
        ...output,
        uuid: 'invocation',
        systemPayload: {
          phase: 'invocation',
          rawCommand: '/docs',
          sentToModel: true,
        },
      };
      await writeRecords([
        prefix,
        user,
        invocation,
        { ...output, parentUuid: 'invocation' },
      ]);
      const custom = await service.readRestoreProjection(sessionId, NONE);
      expect(custom?.runtime.apiHistory).toEqual([
        answer.message,
        user.message,
      ]);
      expect(detectTurnInterruption(custom!.runtime.apiHistory).kind).toBe(
        'interrupted_prompt',
      );
    },
  );

  it('round-trips a recorded Goal turn end through selective restore, fork, and rewind', async () => {
    const config = {
      storage: new Storage(workspaceDir),
      getSessionId: () => sessionId,
      getProjectRoot: () => workspaceDir,
      getCliVersion: () => 'test',
      getResumedSessionData: () => undefined,
    } as unknown as Config;
    const recorder = new ChatRecordingService(config, undefined, false);
    const goalTurn = async (prompt: string, turnId: string, id: string) => {
      const goalContext = { goalId: 'goal', revision: 1, turnId };
      recorder.recordUserMessage([{ text: prompt }]);
      recorder.recordAssistantTurn({
        model: 'test',
        goalContext,
        message: [fnCall('update_goal', undefined, id)],
      });
      recorder.recordToolResult(
        [fnResponse('update_goal', { readyForVerification: true }, id)],
        undefined,
        { goalContext, provenance: 'goal_runtime' },
      );
      await recorder.recordGoalTurnEnd(id, goalContext);
    };
    await goalTurn('complete the Goal', 'turn', 'finish');
    const service = svc();
    const restore = (id = sessionId) => service.readRestoreProjection(id, NONE);
    const loaded = await service.loadSession(sessionId);
    const legacy = buildSessionHistoryFromConversation(loaded!.conversation);
    const projection = await restore();
    expect(projection?.runtime.completedToolCallIds).toEqual(['finish']);
    expect(projection?.runtime.apiHistory).toEqual(legacy.apiHistory);
    expect(legacy.completedToolCallIds).toEqual(['finish']);
    expect(legacy.apiHistory).toHaveLength(3);
    expect(legacy.apiHistory.at(-1)?.parts?.[0]?.functionResponse?.id).toBe(
      'finish',
    );

    await goalTurn('another Goal turn', 'second-turn', 'finish-2');
    const forkId = '660e8400-e29b-41d4-a716-446655440001';
    await service.forkSession(sessionId, forkId);
    const fork = await restore(forkId);
    expect(fork?.runtime.completedToolCallIds).toEqual(['finish', 'finish-2']);

    recorder.recordMidTurnUserMessage(
      [{ text: 'next request' }],
      'next request',
    );
    await recorder.flush();
    const next = await restore();
    expect(next?.runtime.completedToolCallIds).toEqual(['finish', 'finish-2']);
    expect(next?.runtime.apiHistory).toHaveLength(7);
    expect(next?.runtime.apiHistory.at(-1)).toEqual(userText('next request'));

    recorder.rewindRecording(1, { truncatedCount: 4 });
    await recorder.flush();
    const earlier = await restore();
    expect(earlier?.runtime.completedToolCallIds).toEqual(['finish']);
    expect(earlier?.runtime.apiHistory).toEqual(legacy.apiHistory);

    recorder.rewindRecording(0, { truncatedCount: 3 });
    await recorder.flush();
    const rewound = await restore();
    expect(rewound?.runtime.completedToolCallIds).toBeUndefined();
    expect(rewound?.runtime.apiHistory).toEqual([]);
  });

  it('restores the latest session sources across rewind and compression without changing model history', async () => {
    const persisted: SessionSourcesSnapshot[] = [];
    const sources = sourceService((snapshot) => persisted.push(snapshot));
    const added = await sources.upsert({
      title: 'Requirements',
      locator: { type: 'workspace_file', workspacePath: 'requirements.md' },
    });
    await sources.remove(added.source.id);
    await writeRecords([
      ...chain('original prompt', 'answer'),
      sys('sources-0', 'a1', 'session_sources_snapshot', persisted[0]!),
      sys('sources-1', 'a1', 'session_sources_snapshot', persisted[1]!),
      sys('rewind', null, 'rewind', { truncatedCount: 2 }),
      record('u2', 'rewind', 'replacement prompt'),
      sys('compression', 'u2', 'chat_compression', {
        info: {
          originalTokenCount: 100,
          newTokenCount: 10,
          compressionStatus: CompressionStatus.COMPRESSED,
        },
        compressedHistory: [userText('summary')],
      }),
    ]);
    const service = svc();
    const loaded = await service.loadSession(sessionId);
    const [restored, live] = await restoredAndLive(service);
    for (const state of [loaded, restored, live])
      expect(state?.sourcesSnapshot).toEqual({
        version: 1,
        revision: 2,
        sources: [],
      });
    expect(buildApiHistoryFromConversation(loaded!.conversation)).toEqual(
      restored?.apiHistory,
    );
    expect(JSON.stringify(restored?.apiHistory)).not.toContain('Requirements');
    expect(loaded?.lastCompletedUuid).toBe('compression');
  });

  it('reads source metadata before the first conversation turn and never treats read failures as an empty list', async () => {
    const metadata = sys('sources-only', null, 'session_sources_snapshot', {
      version: 1,
      revision: 1,
      sources: [],
    });
    const filePath = await writeRecords([metadata]);
    const service = svc();
    expect(await service.readSessionSources(sessionId)).toEqual({
      sourcesSnapshot: metadata.systemPayload,
    });
    await appendRecords(filePath, record('first-turn', null, 'prompt'));
    const [restored, live] = await restoredAndLive(service);
    expect(restored?.sourcesSnapshot).toEqual(metadata.systemPayload);
    expect(live?.sourcesSnapshot).toEqual(metadata.systemPayload);
    await fs.unlink(filePath);
    await fs.mkdir(filePath);
    await expect(service.readSessionSources(sessionId)).resolves.toEqual({
      sourcesUnavailable: true,
    });
  });

  it('marks source projections unavailable after an identity-invalid physical record', async () => {
    const filePath = await writeRecords([
      record('u1', null, 'prompt'),
      sys('sources', 'u1', 'session_sources_snapshot', {
        version: 1,
        revision: 1,
        sources: [],
      }),
    ]);
    await fs.appendFile(
      filePath,
      jsonLine({
        type: 'system',
        subtype: 'session_sources_snapshot',
        sessionId,
        cwd: workspaceDir,
        systemPayload: { version: 1, revision: 2, sources: [] },
      }),
    );
    const service = svc();
    expectSourcesUnavailable(...(await restoredAndLive(service)));
    expect(
      uuids((await service.loadSession(sessionId))?.conversation.messages),
    ).toEqual(['u1']);
  });

  it('never resurrects an earlier source list after a truncated last snapshot', async () => {
    let snapshot: SessionSourcesSnapshot = {
      version: 1,
      revision: 0,
      sources: [],
    };
    await sourceService((next) => (snapshot = next)).upsert({
      title: 'Old reference',
      locator: { type: 'url', url: 'https://example.com/removed' },
    });
    const filePath = await writeRecords([
      ...chain('prompt', 'answer'),
      sys('source-1', 'a1', 'session_sources_snapshot', snapshot),
    ]);
    await fs.appendFile(
      filePath,
      '{"type":"system","subtype":"session_sources_snapshot","systemPayload":{"version":1,"revision":2,"sources":',
    );
    const service = svc();
    const strict = await service.readSessionSources(sessionId);
    const loaded = await service.loadSession(sessionId);
    expectSourcesUnavailable(
      strict,
      loaded,
      ...(await restoredAndLive(service)),
    );
    expect(uuids(loaded?.conversation.messages)).toEqual(['u1', 'a1']);
  });

  it('keeps conversation loading available when the last source snapshot is unsupported', async () => {
    await writeRecords([
      ...chain('prompt', 'answer'),
      sys('sources', 'a1', 'session_sources_snapshot', {
        version: 9,
        revision: 2,
        sources: [],
      }),
    ]);
    const service = svc();
    const loaded = await service.loadSession(sessionId);
    expectSourcesUnavailable(loaded, ...(await restoredAndLive(service)));
    expect(uuids(loaded?.conversation.messages)).toEqual(['u1', 'a1']);
  });

  it('rejects an empty transcript snapshot', async () => {
    await writeRawTranscript('');
    await rejectsWith(readPage(), Unavailable);
  });

  it('returns a single-record transcript without a continuation cursor', async () => {
    const filePath = await writeRecords([record('u1', null, 'only record')]);
    const page = await readPage();
    expectPage(page, ['u1'], false);
    expect(page.nextCursorState).toBeUndefined();
    // Required page fields; the strict-ISO checks also guard against invalid
    // timestamps from the record() helper.
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
    const page = await readPage();
    expect(page.records).toHaveLength(1);
    expect(page.records[0]).toMatchObject({ uuid: 'u1' });
    expect(page.records[0]?.timestamp).toBeUndefined();
    expect(Number.isFinite(new Date(page.startTime).getTime())).toBe(true);
  });

  it('does not select a trailing artifact record as the active leaf', async () => {
    await writeRecords([
      record('u1', null, 'conversation'),
      sys('artifact', 'u1', 'session_artifact_event'),
    ]);
    expect(uuids((await readPage()).records)).toEqual(['u1']);
  });

  it.each([0, -1, NaN, Infinity, SESSION_TRANSCRIPT_MAX_LIMIT + 1, 1.5])(
    'rejects invalid page limit %s',
    async (limit) => {
      await rejectsWith(readPage({ limit }), RangeError);
    },
  );

  it.each([0, -1, 1.5])(
    'rejects invalid page byte limit %s',
    async (maxBytes) => {
      await rejectsWith(readPage({ maxBytes }), RangeError);
    },
  );

  it('stops at a record boundary when the page byte budget is reached', async () => {
    const records = chain('first', 'second', 'third');
    await writeRecords(records);
    const options = { limit: 3, maxBytes: jsonBytes(records[0], records[1]) };
    const reader = newReader();
    const first = await reader.readPage(sessionId, options);
    const second = await readAfter(reader, first.nextCursorState!, options);
    expectPage(first, ['u1', 'a1'], true);
    expect(first.nextCursorState?.position).toBe(2);
    expectPage(second, ['u2'], false);
  });

  it('returns a single aggregate record that exceeds the page byte budget', async () => {
    const first = record('u1', null, 'first');
    const second = record('u1', null, 'second fragment');
    await writeRecords([first, second, record('a1', 'u1', 'reply')]);
    const page = await readPage({
      limit: 1,
      maxBytes: jsonBytes(first, second) - 1,
    });
    // An indivisible record rides over budget rather than dead-ending the page.
    expectPage(page, ['u1'], true);
  });

  it('pages only the active parentUuid chain and skips abandoned branches', async () => {
    await writeRecords([
      ...chain('root', 'old assistant'),
      record('u2-old', 'a1', 'abandoned'),
      record('a2-old', 'u2-old', 'abandoned reply'),
      record('u2-new', 'a1', 'active'),
      record('a2-new', 'u2-new', 'active reply'),
    ]);
    const reader = newReader();
    const first = await reader.readPage(sessionId, { limit: 2 });
    expect(first.nextCursorState).toBeDefined();
    const second = await readAfter(reader, first.nextCursorState!, {
      limit: 2,
    });
    expectPage(first, ['u1', 'a1'], true);
    expectPage(second, ['u2-new', 'a2-new'], false);
    expect(second.nextCursorState).toBeUndefined();
  });

  it('pages backward before an exclusive active record boundary', async () => {
    await writeRecords(chain(...TWO_TURNS, 'third prompt', 'third answer'));
    const reader = newReader();
    const first = await reader.readPage(sessionId, {
      beforeRecordId: 'u3',
      limit: 2,
    });
    const second = await reader.readPage(sessionId, {
      beforeRecordId: first.records[0]!.uuid,
      limit: 2,
    });
    expect(uuids(first.records)).toEqual(['u2', 'a2']);
    expect(first.direction).toBe('backward');
    expect(first.hasMore).toBe(true);
    expect(first.nextCursorState).toMatchObject({
      position: 2,
      direction: 'backward',
    });
    expectPage(second, ['u1', 'a1'], false);
  });

  it('starts backward paging at the persisted tail', async () => {
    await writeRecords(chain(...TWO_TURNS));
    const page = await readPage({ ...BACK, limit: 2 });
    expect(uuids(page.records)).toEqual(['u2', 'a2']);
    expect(page.direction).toBe('backward');
    expect(page.hasMore).toBe(true);
    expect(page.nextCursorState).toMatchObject({
      position: 2,
      direction: 'backward',
    });
  });

  it('seeds backward replay from the latest authoritative Goal state', async () => {
    await writeRecords([
      sys(
        'goal-state',
        null,
        'goal_state',
        goalStatePayload('ship backward replay', null, 'goal-1'),
      ),
      record('u1', 'goal-state', 'first prompt'),
      record('a1', 'u1', 'first answer'),
      record('u2', 'a1', 'second prompt'),
      sys('goal-clear', 'u2', 'goal_state', {
        v: 2,
        cause: 'clear',
        snapshot: { v: 2, activity: 'idle', goal: null },
      }),
      record('a2', 'goal-clear', 'second answer'),
      record('u3', 'a2', 'third prompt'),
    ]);
    const page = await readPage({ beforeRecordId: 'u3', limit: 2 });
    expect(uuids(page.records)).toEqual(['u2', 'goal-clear', 'a2']);
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
    const valid = goalStatePayload('do not revive me', null, 'goal-1');
    await writeRecords([
      sys('goal-state', null, 'goal_state', valid),
      record('u1', 'goal-state', 'first prompt'),
      record('a1', 'u1', 'first answer'),
      sys('goal-invalid', 'a1', 'goal_state', {
        ...valid,
        cause: 'clear',
        // Truthy but invalid: the parser accepts only `activity === 'idle'`.
        // A falsy `null` would pass even with the validation deleted.
        snapshot: { ...valid.snapshot, activity: 'running' },
      }),
      record('u2', 'goal-invalid', 'second prompt'),
      record('a2', 'u2', 'second answer'),
      record('u3', 'a2', 'third prompt'),
    ]);
    const page = await readPage({ beforeRecordId: 'u3', limit: 2 });
    expect(uuids(page.records)).toEqual(['u2', 'a2']);
    expect(page.replay).toBeUndefined();
  });

  it('includes leading session metadata with the first backward page', async () => {
    await writeRecords([
      sourceRecord('source', null, 'session source'),
      record('u1', 'source', 'first prompt'),
      record('a1', 'u1', 'first answer'),
    ]);
    const page = await readPage({ ...BACK, limit: 100 });
    expectPage(page, ['source', 'u1', 'a1'], false);
    expect(page.nextCursorState).toBeUndefined();
  });

  it('does not page into inherited side-task context', async () => {
    await writeRecords([
      sourceRecord('source', null, 'session source', {
        sourceType: 'side_task',
        sourceId: 'parent-session',
      }),
      inherited(record('parent-u1', 'source', 'parent prompt')),
      inherited(record('parent-a1', 'parent-u1', 'parent answer')),
      record('side-u1', 'parent-a1', 'side prompt'),
      record('side-a1', 'side-u1', 'side answer'),
    ]);
    const page = await readPage({ ...BACK, limit: 100 });
    expectPage(page, ['source', 'side-u1', 'side-a1'], false);
  });

  it('derives the side-task boundary from the active chain', async () => {
    await writeRecords([
      sourceRecord('source', null, 'session source', {
        sourceType: 'side_task',
        sourceId: 'parent-session',
      }),
      inherited(record('parent-u1', 'source', 'parent prompt')),
      record('side-u1', 'parent-u1', 'side prompt'),
      sourceRecord('dead-source', 'parent-u1', 'dead source', {
        sourceType: 'side_task',
        sourceId: 'abandoned-parent',
      }),
      record('side-a1', 'side-u1', 'side answer'),
    ]);
    const page = await readPage({ ...BACK, limit: 100 });
    expect(uuids(page.records)).toEqual(['source', 'side-u1', 'side-a1']);
  });

  it('derives a fragmented session source from the first fragment', async () => {
    const source = sys('source', null, 'session_source', {
      sourceType: 'daemon',
    });
    await writeRecords([
      source,
      {
        ...source,
        systemPayload: { sourceType: 'side_task', sourceId: 'parent-session' },
      },
      inherited(record('parent-u1', 'source', 'parent prompt')),
      record('u1', 'parent-u1', 'current prompt'),
    ]);
    const page = await readPage();
    expect(uuids(page.records)).toEqual(['source', 'parent-u1', 'u1']);
  });

  it('builds a cold runtime projection with full-loader parity', async () => {
    const uiEvent = { prompt_id: `${sessionId}########7`, duration_ms: 12 };
    const attributionSnapshot = { v: 1, commits: [] };
    await writeRecords([
      sys('source', null, 'session_source', {
        sourceType: 'daemon',
        sourceId: 'restore-test',
      }),
      {
        ...record('u1', 'source', 'first prompt'),
        promptId: `${sessionId}########3`,
      } as ChatRecord,
      {
        ...record('a1', 'u1', 'first answer'),
        usageMetadata: {
          promptTokenCount: 30,
          candidatesTokenCount: 4,
          totalTokenCount: 34,
        },
      },
      sys('compression', 'a1', 'chat_compression', compressedTurn()),
      sys('telemetry', 'compression', 'ui_telemetry', { uiEvent }),
      sys('attribution', 'telemetry', 'attribution_snapshot', {
        snapshot: attributionSnapshot,
      }),
      sys('files', 'attribution', 'file_history_snapshot', {
        snapshots: [
          {
            promptId: `${sessionId}########3`,
            timestamp: T0,
            trackedFileBackups: {},
          },
        ],
      }),
      sys(
        'goal',
        'files',
        'goal_state',
        goalStatePayload('finish the restore', 'goal', 'goal-1', 1),
      ),
      sub('notification', 'goal', 'background result', 'notification', {
        backgroundTask: { taskId: 'task-1' },
      }),
      sys(
        'artifact',
        'notification',
        'session_artifact_event',
        artifactEvent('https://example.com/report', 'Report'),
      ),
      record('a2', 'notification', 'after compression'),
      sys('title', 'a2', 'custom_title', {
        customTitle: 'Restored',
        titleSource: 'manual',
      }),
    ]);

    const [loaded, projection] = await loadAndRestore();

    expect(loaded).toBeDefined();
    expect(projection).toBeDefined();
    expect(projection?.replay).toBeUndefined();
    const runtime = projection?.runtime;
    expect(runtime?.apiHistory).toEqual(
      buildApiHistoryFromConversation(loaded!.conversation),
    );
    expect(runtime?.resumeTokenCounts).toEqual(
      getResumeTokenCounts(loaded!.conversation),
    );
    expect(runtime?.fileHistorySnapshots).toEqual(loaded?.fileHistorySnapshots);
    expect(runtime?.artifactSnapshot).toEqual(loaded?.artifactSnapshot);
    expect(runtime?.recording.lastCompletedUuid).toBe(
      loaded?.lastCompletedUuid,
    );
    const turnState = collectSessionTurnState(
      loaded!.conversation.messages,
      sessionId,
    );
    expect(runtime?.recording.turnParentUuids).toEqual(
      turnState.turnParentUuids,
    );
    expect(runtime?.initialTurn).toBe(turnState.initialTurn);
    expect(runtime?.backgroundNotificationTaskIds).toEqual(
      turnState.backgroundNotificationTaskIds,
    );
    expect(runtime?.uiTelemetryEvents).toEqual([uiEvent]);
    expect(runtime?.attributionSnapshot).toEqual(attributionSnapshot);
    expect(runtime?.recording).toMatchObject({
      customTitle: 'Restored',
      titleSource: 'manual',
      sourceType: 'daemon',
      sourceId: 'restore-test',
    });
    expect(recoverGoalFromRecords(runtime!.goalRecords)).toEqual(
      recoverGoalFromRecords(loaded!.conversation.messages),
    );
    for (const name of [
      'transcript_index_ms',
      'resume_state_select_ms',
      'selected_record_read_ms',
      'transcript_bytes',
      'records_indexed',
      'active_records',
      'selected_records',
      'selected_bytes',
      'replay_records',
      'replay_bytes',
    ]) {
      expectRestoreAttribute(name, expect.any(Number));
    }
    expectRestoreAttribute('index_cache_state', 'fresh');
    expectRestoreAttribute('replay_mode', 'none');
    expectRestoreAttribute('compression_selected', expect.any(Boolean));
  });

  it('uses the bounded persisted-title picker instead of the full active chain', async () => {
    const largeText = 'x'.repeat(70 * 1024);
    await writeRecords([
      record('u1', null, largeText),
      sys('title', 'u1', 'custom_title', {
        customTitle: 'Middle title',
        titleSource: 'manual',
      }),
      record('a1', 'title', largeText),
    ]);
    const service = svc();
    const projection = await service.readRestoreProjection(sessionId, NONE);
    expect(service.getSessionTitleInfo(sessionId)).toEqual({});
    expect(projection?.runtime.recording.customTitle).toBeUndefined();
    expect(projection?.runtime.recording.titleSource).toBeUndefined();
  });

  async function expectArtifactParity(url: string) {
    const [loaded, projection] = await loadAndRestore();
    expect(projection?.runtime.artifactSnapshot).toEqual(
      loaded?.artifactSnapshot,
    );
    expect(
      projection?.runtime.artifactSnapshot?.artifacts.map(({ id }) => id),
    ).toEqual([artifactId(url)]);
  }

  it('matches full-loader artifact selection across an abandoned branch', async () => {
    const artifactAt = (
      uuid: string,
      parentUuid: string,
      sequence: number,
      url: string,
    ) =>
      sys(
        uuid,
        parentUuid,
        'session_artifact_event',
        artifactEvent(
          url,
          url,
          `2026-01-01T00:00:0${sequence}.000Z`,
          T0,
          sequence,
        ),
      );
    await writeRecords([
      ...chain('prompt', 'answer'),
      record('abandoned', 'a1', 'dead branch'),
      artifactAt(
        'abandoned-artifact',
        'abandoned',
        2,
        'https://example.com/abandoned',
      ),
      artifactAt('active-artifact', 'a1', 1, 'https://example.com/active'),
      record('u2', 'a1', 'next prompt'),
      record('a2', 'u2', 'next answer'),
    ]);
    await expectArtifactParity('https://example.com/active');
  });

  it('uses a leading artifact record as the restore start time', async () => {
    const leadingTimestamp = '2025-12-31T23:59:59.000Z';
    await writeRecords([
      sys(
        'leading-artifact',
        null,
        'session_artifact_event',
        artifactEvent(
          'https://example.com/leading',
          'Leading artifact',
          leadingTimestamp,
        ),
        { timestamp: leadingTimestamp },
      ),
      record('u1', null, 'prompt'),
    ]);
    const [loaded, projection] = await loadAndRestore();
    expect(projection?.startTime).toBe(loaded?.conversation.startTime);
    expect(projection?.startTime).toBe(leadingTimestamp);
  });

  it('preserves physical active-fragment markers for artifact selection', async () => {
    const url = 'https://example.com/fragmented';
    await writeRecords([
      record('u1', null, 'first fragment'),
      sys(
        'artifact',
        'u1',
        'session_artifact_event',
        artifactEvent(url, 'Fragmented', T1, T0),
      ),
      record('u1', null, 'second fragment'),
      record('dead', null, 'abandoned blocker'),
      record('u1', null, 'final fragment'),
    ]);
    await expectArtifactParity(url);
  });

  it('selects recent restore replay with an older Goal bootstrap', async () => {
    const goalPayload = goalStatePayload('continue', 'goal', 'goal-1', 1);
    await writeRecords([
      ...chain('one', 'one answer'),
      sys('goal', 'a1', 'goal_state', goalPayload),
      record('u2', 'goal', 'two'),
      record('a2', 'u2', 'two answer'),
      record('u3', 'a2', 'three'),
      record('a3', 'u3', 'three answer'),
    ]);
    const projection = await coldProjection(recent());
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
    await writeRecords([
      inherited(record('u1', null, 'inherited prompt'), 'parent'),
      inherited(record('a1', 'u1', 'inherited answer'), 'parent'),
      inherited(
        sys('goal', 'a1', 'goal_state', goalStatePayload('inherited goal')),
        'parent',
      ),
      record('u2', 'goal', 'branch prompt'),
      record('a2', 'u2', 'branch answer'),
    ]);
    const reader = newReader();
    const visible = await reader.readRestoreProjection(sessionId, all(false));
    const hidden = await reader.readRestoreProjection(sessionId, all(true));

    expect(uuids(visible?.replay?.records)).toEqual([
      'u1',
      'a1',
      'goal',
      'u2',
      'a2',
    ]);
    expect(uuids(hidden?.replay?.records)).toEqual(['u2', 'a2']);
    expect(hidden?.runtime.apiHistory).toEqual(visible?.runtime.apiHistory);
    expect(visible?.runtime.goalRecoverySourceUuid).toBe('goal');
    expect(hidden?.runtime.goalRecoverySourceUuid).toBe('goal');
    expect(hidden?.replay?.goalRecoverySourceUuid).toBeUndefined();
    expect(hidden?.runtime.goalRecords).toEqual([
      expect.objectContaining({ uuid: 'goal' }),
    ]);

    const hiddenLive = await reader.readLiveRestoreProjection(
      sessionId,
      all(true),
    );
    expect(uuids(hiddenLive?.replay?.records)).toEqual(['u2', 'a2']);
    expect(hiddenLive?.goalRecoverySourceUuid).toBeUndefined();
    expect(hiddenLive?.goalRecords).toBeUndefined();
  });

  it('selects Goal bootstrap precedence from filtered visible history', async () => {
    await writeRecords([
      record('u0', null, 'older prompt'),
      record('a0', 'u0', 'older answer'),
      sys('visible-goal', 'a0', 'goal_state', goalStatePayload('visible goal')),
      inherited(
        sys(
          'hidden-goal',
          'visible-goal',
          'goal_state',
          goalStatePayload('hidden goal'),
        ),
        'parent',
      ),
      record('u1', 'hidden-goal', 'branch prompt'),
      record('a1', 'u1', 'branch answer'),
      record('u2', 'a1', 'latest prompt'),
      record('a2', 'u2', 'latest answer'),
    ]);
    const reader = newReader();
    const cold = await reader.readRestoreProjection(sessionId, recent(2, true));
    const live = await reader.readLiveRestoreProjection(
      sessionId,
      recent(2, true),
    );

    expect(uuids(cold?.replay?.records)).toEqual(['u2', 'a2']);
    expect(cold?.runtime.goalRecoverySourceUuid).toBe('hidden-goal');
    expect(cold?.replay?.goalRecoverySourceUuid).toBe('visible-goal');
    expect(cold?.replay?.goalBootstrapRecords).toEqual([
      expect.objectContaining({ uuid: 'visible-goal' }),
    ]);
    expect(live?.goalRecoverySourceUuid).toBe('visible-goal');
    expect(uuids(live?.goalRecords)).toEqual(['visible-goal']);
  });

  it('uses the aggregated final usage metadata when selecting resume tokens', async () => {
    await writeRecords([
      record('u1', null, 'first'),
      {
        ...record('a1', 'u1', 'earlier answer'),
        usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 3 },
      },
      record('u2', 'a1', 'second'),
      {
        ...record('a2', 'u2', 'latest answer'),
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 },
      },
      {
        ...record('a2', 'u2', 'latest tail'),
        usageMetadata: {
          promptTokenCount: 0,
          totalTokenCount: 0,
          candidatesTokenCount: 0,
        },
      },
    ]);
    const [loaded, projection] = await loadAndRestore();
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
    await writeRecords([
      record('u1', null, 'prompt'),
      sys('attribution', 'u1', 'attribution_snapshot', { snapshot }),
      sys('malformed-attribution', 'attribution', 'attribution_snapshot', {
        ignored: true,
      }),
      record('a1', 'malformed-attribution', 'answer'),
    ]);
    const projection = await coldProjection();
    expect(projection?.runtime.attributionSnapshot).toEqual(snapshot);
  });

  it('rejects a cold projection when the frozen transcript changes', async () => {
    const filePath = await writeRecords([record('u1', null, 'one')]);
    let appended = false;
    setSessionTranscriptIndexBuildCompleteHookForTest(async (builtPath) => {
      if (builtPath !== filePath || appended) return;
      appended = true;
      await appendRecords(filePath, record('a1', 'u1', 'late'));
    });
    await rejectsWith(coldProjection(), Unavailable);
    expectEmptyCache();
  });

  it('reports a removed frozen transcript as snapshot-unavailable', async () => {
    const filePath = await writeRecords([record('u1', null, 'one')]);
    setSessionTranscriptIndexBuildCompleteHookForTest(async (builtPath) => {
      if (builtPath === filePath) await fs.unlink(filePath);
    });
    await rejectsWith(coldProjection(), Unavailable);
    expectEmptyCache();
  });

  it('rejects an invalid recent projection before scanning', async () => {
    const builds = countBuilds(await writeRecords([record('u1', null, 'one')]));
    await rejectsWith(coldProjection(recent(0)), RangeError);
    expect(builds.count).toBe(0);
  });

  it('returns no cold projection for empty sessions and rejects foreign ones', async () => {
    await writeRawTranscript('');
    const reader = newReader();
    await expect(
      reader.readRestoreProjection(sessionId, NONE),
    ).resolves.toBeUndefined();

    await writeRawTranscript('{not-json}\n');
    await expect(
      reader.readRestoreProjection(sessionId, NONE),
    ).resolves.toBeUndefined();

    await writeRecords([record('u1', null, 'foreign')]);
    const foreign = { validateFirstRecord: () => false };
    await rejectsWith(
      reader.readRestoreProjection(sessionId, NONE, foreign),
      Unavailable,
    );
    await rejectsWith(
      reader.readLiveRestoreProjection(sessionId, NONE, foreign),
      Unavailable,
    );
  });

  it('fails closed when a cold restore transcript is missing', async () => {
    await rejectsWith(coldProjection(), Unavailable);
  });

  it('preserves the real leaf for a metadata-only session', async () => {
    await writeRecords([
      sys('source', null, 'session_source', {
        sourceType: 'daemon',
        sourceId: 'metadata-only',
      }),
    ]);
    const projection = await coldProjection();
    expect(projection?.runtime.apiHistory).toEqual([]);
    expect(projection?.runtime.recording).toMatchObject({
      lastCompletedUuid: 'source',
      sourceType: 'daemon',
      sourceId: 'metadata-only',
    });
  });

  it('restores the last session_model payload', async () => {
    await writeRecords([
      sys('model-1', null, 'session_model', {
        modelId: 'old-model',
        authType: 'openai',
      }),
      sys('model-2', 'model-1', 'session_model', {
        modelId: 'qwen3-coder-plus',
        authType: 'openai',
        baseUrl: 'https://example.test/v1',
      }),
      record('u1', 'model-2', 'prompt'),
      { ...record('a1', 'u1', 'answer'), model: 'other-turn-model' },
    ]);
    const recording = (await coldProjection())?.runtime.recording;
    expect(recording?.sessionModel).toEqual({
      modelId: 'qwen3-coder-plus',
      authType: 'openai',
      baseUrl: 'https://example.test/v1',
    });
    expect(recording?.lastAssistantModel).toBe('other-turn-model');
  });

  it('restores the last valid session approval state independently of replay', async () => {
    const yolo: ChatRecord = {
      ...record('approval-1', null, ''),
      type: 'system',
      subtype: 'session_approval_mode',
      message: undefined,
      systemPayload: { mode: ApprovalMode.YOLO },
    };
    const invalid = {
      ...record('approval-3', 'approval-2', ''),
      type: 'system' as const,
      subtype: 'session_approval_mode',
      message: undefined,
      systemPayload: {
        mode: ApprovalMode.PLAN,
        prePlanMode: ApprovalMode.PLAN,
      },
    };
    const autoWithIgnoredPredecessor = {
      ...record('approval-2', 'approval-1', ''),
      type: 'system' as const,
      subtype: 'session_approval_mode',
      message: undefined,
      systemPayload: {
        mode: ApprovalMode.AUTO,
        prePlanMode: 'not-a-mode',
      },
    };
    await writeRecords([
      yolo,
      autoWithIgnoredPredecessor as unknown as ChatRecord,
      invalid as unknown as ChatRecord,
    ]);

    const projection = await new SessionTranscriptReader(
      workspaceDir,
    ).readRestoreProjection(sessionId, { replay: { kind: 'none' } });

    expect(projection?.runtime.recording.sessionApprovalMode).toEqual({
      mode: ApprovalMode.AUTO,
    });
  });

  it('defaults a legacy Plan approval record predecessor to default', async () => {
    await writeRecords([
      {
        ...record('approval-1', null, ''),
        type: 'system',
        subtype: 'session_approval_mode',
        message: undefined,
        systemPayload: { mode: ApprovalMode.PLAN },
      },
    ]);

    const projection = await new SessionTranscriptReader(
      workspaceDir,
    ).readRestoreProjection(sessionId, { replay: { kind: 'none' } });

    expect(projection?.runtime.recording.sessionApprovalMode).toEqual({
      mode: ApprovalMode.PLAN,
      prePlanMode: ApprovalMode.DEFAULT,
    });
  });

  it('keeps the last valid Plan execution mode when the tail is invalid', async () => {
    await writeRecords([
      {
        ...record('approval-1', null, ''),
        type: 'system',
        subtype: 'session_approval_mode',
        message: undefined,
        systemPayload: {
          mode: ApprovalMode.PLAN,
          prePlanMode: ApprovalMode.YOLO,
          planExecutionMode: ApprovalMode.AUTO_EDIT,
        },
      },
      {
        ...record('approval-2', 'approval-1', ''),
        type: 'system',
        subtype: 'session_approval_mode',
        message: undefined,
        systemPayload: {
          mode: ApprovalMode.PLAN,
          prePlanMode: ApprovalMode.YOLO,
          planExecutionMode: ApprovalMode.PLAN,
        },
      } as ChatRecord,
    ]);

    const projection = await new SessionTranscriptReader(
      workspaceDir,
    ).readRestoreProjection(sessionId, { replay: { kind: 'none' } });

    expect(projection?.runtime.recording.sessionApprovalMode).toEqual({
      mode: ApprovalMode.PLAN,
      prePlanMode: ApprovalMode.YOLO,
      planExecutionMode: ApprovalMode.AUTO_EDIT,
    });
  });

  it('selects approval state from the active branch after rewind', async () => {
    const approval = (
      uuid: string,
      parentUuid: string | null,
      mode: ApprovalMode,
    ): ChatRecord => ({
      ...record(uuid, parentUuid, ''),
      type: 'system',
      subtype: 'session_approval_mode',
      message: undefined,
      systemPayload: { mode },
    });
    await writeRecords([
      approval('approval-default', null, ApprovalMode.DEFAULT),
      record('u1', 'approval-default', 'first'),
      record('a1', 'u1', 'answer'),
      approval('approval-abandoned', 'a1', ApprovalMode.YOLO),
      record('u2', 'approval-abandoned', 'abandoned'),
      record('a2', 'u2', 'abandoned answer'),
      {
        ...record('rewind', 'a1', ''),
        type: 'system',
        subtype: 'rewind',
        message: undefined,
        systemPayload: { truncatedCount: 1 },
      },
      approval('approval-active', 'rewind', ApprovalMode.AUTO),
      record('u3', 'approval-active', 'active'),
      record('a3', 'u3', 'active answer'),
    ]);

    const projection = await new SessionTranscriptReader(
      workspaceDir,
    ).readRestoreProjection(sessionId, { replay: { kind: 'none' } });

    expect(projection?.runtime.recording.sessionApprovalMode).toEqual({
      mode: ApprovalMode.AUTO,
    });
  });

  it('captures lastAssistantModel when no session_model record exists', async () => {
    await writeRecords([
      record('u1', null, 'prompt'),
      { ...record('a1', 'u1', 'answer'), model: 'session-a-model' },
    ]);
    const recording = (await coldProjection())?.runtime.recording;
    expect(recording?.sessionModel).toBeUndefined();
    expect(recording?.lastAssistantModel).toBe('session-a-model');
  });

  it('captures lastAssistantModel on resume when a trailing compression excludes the last assistant record', async () => {
    await writeRecords([
      record('u1', null, 'prompt'),
      { ...record('a1', 'u1', 'answer'), model: 'session-a-model' },
      sys('compression', 'a1', 'chat_compression', compressedTurn()),
    ]);
    const recording = (await coldProjection())?.runtime.recording;
    expect(recording?.sessionModel).toBeUndefined();
    expect(recording?.lastAssistantModel).toBe('session-a-model');
  });

  it('keeps the last valid session_model when a trailing payload is unusable', async () => {
    await writeRecords([
      sys('model-1', null, 'session_model', {
        modelId: 'qwen3-coder-plus',
        authType: 'openai',
      }),
      sys('model-2', 'model-1', 'session_model', {
        modelId: 42,
        authType: 'openai',
      }),
    ]);
    expect((await coldProjection())?.runtime.recording.sessionModel).toEqual({
      modelId: 'qwen3-coder-plus',
      authType: 'openai',
    });
  });

  it('drops a session_model payload that is not a usable string pair', async () => {
    await writeRecords([
      sys('model-1', null, 'session_model', {
        modelId: 42,
        authType: 'openai',
      }),
    ]);
    expect(
      (await coldProjection())?.runtime.recording.sessionModel,
    ).toBeUndefined();
  });

  it('preserves malformed compression failure behavior', async () => {
    await writeRecords([
      record('u1', null, 'prompt'),
      sys('compression', 'u1', 'chat_compression', {
        compressedHistory: { malformed: true },
      }),
      record('a1', 'compression', 'answer'),
    ]);
    const loaded = await svc().loadSession(sessionId);
    expect(() => buildApiHistoryFromConversation(loaded!.conversation)).toThrow(
      TypeError,
    );
    await rejectsWith(coldProjection(), TypeError);
  });

  it('normalizes Goal candidates without changing recovery precedence', async () => {
    const validGoal = goalStatePayload(
      'keep the valid v2 state',
      'u1',
      'goal-1',
    );
    await writeRecords([
      record('u1', null, 'prompt'),
      // A goal_status card from a build before #7895 is history, not a
      // recovery candidate: it is neither normalized nor carried.
      sys('legacy', 'u1', 'slash_command', {
        phase: 'result',
        rawCommand: '/goal legacy',
        outputHistoryItems: [
          { type: 'message', text: 'discard me' },
          { type: 'goal_status', kind: 'set', condition: 'legacy goal' },
        ],
      }),
      sys('valid-goal', 'legacy', 'goal_state', validGoal),
      sys('malformed-goal', 'valid-goal', 'goal_state', {
        v: 2,
        cause: 'create',
        snapshot: null,
      }),
      record('a1', 'malformed-goal', 'answer'),
    ]);
    const projection = await coldProjection();
    expect(recoverGoalFromRecords(projection!.runtime.goalRecords)).toEqual({
      kind: 'v2',
      payload: validGoal,
    });
    expect(projection?.runtime.goalRecoverySourceUuid).toBe('valid-goal');
    expect(projection?.runtime.goalRecords).toEqual([
      expect.objectContaining({ uuid: 'valid-goal', systemPayload: validGoal }),
      expect.objectContaining({ uuid: 'malformed-goal', systemPayload: null }),
    ]);
  });

  it('dispatches a pre-read malformed Goal record to other consumers once', async () => {
    await writeRecords([
      record('u1', null, 'prompt'),
      sub('a-goal', 'u1', 'model payload', 'goal_state', { malformed: true }),
    ]);
    const [loaded, projection] = await loadAndRestore();
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
    await writeRecords([
      record('u1', null, 'one'),
      sys(
        'artifact',
        'u1',
        'session_artifact_event',
        artifactEvent('https://example.com/live', 'Live'),
      ),
      record('a1', 'u1', 'one answer'),
      record('u2', 'a1', 'two'),
      record('a2', 'u2', 'two answer'),
    ]);
    const reader = newReader();
    const liveLoad = await reader.readLiveRestoreProjection(
      sessionId,
      recent(),
    );
    const liveResume = await reader.readLiveRestoreProjection(sessionId, NONE);

    expect(uuids(liveLoad?.replay?.records)).toEqual(['u2', 'a2']);
    expect(liveLoad?.artifactSnapshot?.artifacts).toHaveLength(1);
    expect(liveResume?.replay).toBeUndefined();
    expect(liveResume?.artifactSnapshot).toEqual(liveLoad?.artifactSnapshot);
    expect(liveResume).not.toHaveProperty('runtime');
    expectRestoreAttribute('index_cache_state', 'miss');
    expectRestoreAttribute('index_cache_state', 'hit');
  });

  it('keeps backward pages within a normal user turn boundary', async () => {
    await writeRecords([
      ...toolTurn('first prompt', 'a1', 'first answer'),
      record('u2', 'a1', 'second prompt'),
      record('a2', 'u2', 'second answer'),
    ]);
    const page = await readPage({ beforeRecordId: 'u2', limit: 4 });
    expect(uuids(page.records)).toEqual(['u1', 'a-tool', 't1', 'a1']);
  });

  it('projects validated branch points for Assistant records in the page', async () => {
    await writeRecords([
      ...chain('prompt', 'answer'),
      branchCheckpoint('checkpoint-1'),
    ]);
    const page = await readPage({ ...BACK, limit: 2 });
    expect(uuids(page.records)).toContain('a1');
    expect(page.branchPointsByAssistantUuid).toEqual({ a1: 'checkpoint-1' });
    expect(vi.mocked(fs.open)).toHaveBeenCalledTimes(1);
  });

  it('does not advertise a checkpoint shadowed by an earlier duplicate record', async () => {
    await writeRecords([
      ...chain('prompt', 'answer'),
      { ...record('dup', 'a1', 'ordinary duplicate'), type: 'assistant' },
      branchCheckpoint('dup'),
    ]);
    expect((await readPage()).branchPointsByAssistantUuid).toBeUndefined();
  });

  it('does not advertise a checkpoint merged into a subtype-less first duplicate', async () => {
    await writeRecords([
      ...chain('prompt', 'answer'),
      { ...record('dup', 'a1', ''), type: 'system', message: undefined },
      branchCheckpoint('dup'),
    ]);
    expect((await readPage()).branchPointsByAssistantUuid).toBeUndefined();
  });

  it('reports a branch point whose checkpoint falls on a later page', async () => {
    await writeRecords([
      ...chain('prompt', 'answer'),
      branchCheckpoint('checkpoint-1'),
      record('u2', 'checkpoint-1', 'next prompt'),
      record('a2', 'u2', 'next answer'),
    ]);
    const page = await readPage({ limit: 2 });
    expect(uuids(page.records)).toEqual(['u1', 'a1']);
    expect(page.branchPointsByAssistantUuid).toEqual({ a1: 'checkpoint-1' });
  });

  it('keeps a long user turn complete when it exceeds the record limit', async () => {
    await writeRecords([
      ...toolTurn('prompt', 'a-final', 'final answer'),
      record('u2', 'a-final', 'next prompt'),
    ]);
    const page = await readPage({ beforeRecordId: 'u2', limit: 2 });
    expectPage(page, ['u1', 'a-tool', 't1', 'a-final'], false);
  });

  it('returns a backward turn that exceeds maxBytes after alignment', async () => {
    const turnRecords = toolTurn('prompt', 'a-final', 'final answer');
    await writeRecords([
      ...turnRecords,
      record('u2', 'a-final', 'next prompt'),
    ]);
    const page = await readPage({
      beforeRecordId: 'u2',
      limit: 2,
      // The turn exceeds the soft budget, but it still fits one extra
      // budget (2 * maxBytes), so alignment admits it whole.
      maxBytes: Math.ceil(jsonBytes(...turnRecords) / 2),
    });
    expectPage(page, ['u1', 'a-tool', 't1', 'a-final'], false);
  });

  it('rejects a backward boundary outside the active chain', async () => {
    await writeRecords(chain('root', 'answer'));
    await rejectsWith(readPage({ beforeRecordId: 'missing' }), BadCursor);
  });

  it('continues a frozen snapshot after new records are appended', async () => {
    const filePath = await writeRecords(chain('root', 'assistant', 'second'));
    const reader = newReader();
    const first = await reader.readPage(sessionId, { limit: 2 });
    await appendRecords(filePath, record('a2', 'u2', 'late append'));
    const second = await readAfter(reader, first.nextCursorState!, {
      limit: 2,
    });
    expectPage(second, ['u2'], false);
  });

  it('rejects cursors from another session before touching transcript files', async () => {
    const { reader, state } = await firstPage('root', 'assistant');
    await rejectsWith(
      reader.readPage(otherSessionId, { cursor: encodeCursor(state) }),
      BadCursor,
    );
  });

  it('rejects malformed and unsupported-version cursors', async () => {
    await rejectsWith(readPage({ cursor: 'not-a-cursor' }), BadCursor);
    const { reader, state } = await firstPage('root', 'assistant');
    await rejectsWith(readAfter(reader, { ...state, v: 99 as 1 }), BadCursor);
  });

  it('rejects a cursor after the frozen snapshot is truncated', async () => {
    const { filePath, reader, state } = await firstPage(
      'root',
      'assistant',
      'second',
    );
    await fs.truncate(filePath, 1);
    await rejectsWith(readAfter(reader, state), Unavailable);
  });

  it('rejects a cursor when the frozen file identity no longer matches', async () => {
    const { reader, state } = await firstPage('root', 'assistant', 'second');
    const fileIdentity = { dev: 999_999, ino: 999_999 };
    await rejectsWith(
      readAfter(reader, { ...state, fileIdentity }),
      Unavailable,
    );
  });

  it('paginates when the filesystem reports inode zero', async () => {
    statFault.zeroInode = true;
    const { reader, first, state } = await firstPage(
      'root',
      'assistant',
      'second',
    );
    expectPage(first, ['u1'], true);
    expect(state.fileIdentity.ino).toBe(0);
    const second = await readAfter(reader, state);
    expect(uuids(second.records)).toEqual(['a1', 'u2']);
  });

  it('rejects a cursor whose frozen inode no longer matches the file', async () => {
    const { reader, state } = await firstPage('root', 'assistant', 'second');
    const fileIdentity = { ...state.fileIdentity, ino: 0 };
    await rejectsWith(
      readAfter(reader, { ...state, fileIdentity }),
      Unavailable,
    );
  });

  it('accepts a file identity whose inode exceeds 2^53 (Windows file index)', async () => {
    const { reader, state } = await firstPage('root', 'assistant');
    // Windows derives Stats.ino from a 64-bit file index above 2^53, so a
    // safe-integer gate would reject every cursor there. The large inode must
    // pass shape validation and reach (and fail) the real identity match.
    const bigIno = 2 ** 53 + 2;
    expect(Number.isSafeInteger(bigIno)).toBe(false);
    const fileIdentity = { dev: 1, ino: bigIno };
    await rejectsWith(
      readAfter(reader, { ...state, fileIdentity }),
      Unavailable,
    );
  });

  it('still rejects a non-safe-integer byte offset in a cursor', async () => {
    const { reader, state } = await firstPage('root', 'assistant');
    // snapshotSize/position are arithmetic operands and stay safe-integer even
    // though dev/ino were relaxed for Windows.
    const unsafeOffset = 2 ** 53 + 2;
    expect(Number.isSafeInteger(unsafeOffset)).toBe(false);
    await rejectsWith(
      readAfter(reader, { ...state, snapshotSize: unsafeOffset }),
      BadCursor,
    );
  });

  it('rejects cursors whose position is past the active chain', async () => {
    const { reader, state } = await firstPage('root', 'assistant', 'second');
    await rejectsWith(
      readAfter(reader, { ...state, position: 999 }),
      BadCursor,
    );
  });

  it('terminates cyclic parentUuid chains without looping', async () => {
    await writeRecords([
      record('u1', 'a1', 'root'),
      record('a1', 'u1', 'assistant'),
    ]);
    const page = await readPage({ limit: 10 });
    expectPage(page, ['u1', 'a1'], false);
  });

  it('aggregates multiple physical records for the same active uuid', async () => {
    await writeRecords([
      record('u1', null, 'hello'),
      record('u1', null, ' world'),
      record('a1', 'u1', 'reply'),
    ]);
    const page = await readPage({ limit: 1 });
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
    const gaps = [{ childUuid: 'u2', missingParentUuid: 'missing-a1' }];
    const reader = newReader();
    const first = await reader.readPage(sessionId, { limit: 1 });
    expect(uuids(first.records)).toEqual(['u2']);
    expect(first.gaps).toEqual(gaps);
    expect(first.hasMore).toBe(true);

    const second = await readAfter(reader, first.nextCursorState!, {
      limit: 1,
    });
    expect(uuids(second.records)).toEqual(['a2']);
    expect(second.gaps).toEqual(gaps);
    expect(second.hasMore).toBe(false);
  });

  it('keeps cursors valid after the in-memory key cache is reset', async () => {
    const { state } = await firstPage('hello', 'reply', 'next');
    const cursor = encodeCursor(state);
    resetSessionTranscriptIndexCacheForTest();
    const second = await readPage({ cursor, limit: 1 });
    expectPage(second, ['a1'], true);
  });

  it('uses an injected in-memory codec without creating a cursor key file', async () => {
    await writeRecords(chain('hello', 'reply'));
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

    expect(uuids(second.records)).toEqual(['a1']);
    await expect(fs.stat(cursorKeyPath())).rejects.toMatchObject({
      code: 'ENOENT',
    });
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
    expect(() => second.decode(cursor)).toThrow(BadCursor);
    expect(() => first.decode(`${cursor.slice(0, -1)}A`)).toThrow(BadCursor);
  });

  it('rejects an invalid in-memory cursor key length', () => {
    expect(() => new SessionTranscriptCursorCodec(Buffer.alloc(31))).toThrow(
      /must be 32 bytes/,
    );
  });

  it('warns and replaces a corrupt persisted cursor signing key', async () => {
    const keyPath = cursorKeyPath();
    await fs.mkdir(path.dirname(keyPath), { recursive: true });
    await fs.writeFile(keyPath, 'corrupt-key\n', 'utf8');
    encodeCursor((await firstPage('root', 'assistant')).state);

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
    const cursor = encodeCursor(
      (await firstPage('hello', 'reply', 'next')).state,
    );
    const otherWorkspaceDir = path.join(runtimeDir, 'other-workspace');
    await fs.mkdir(otherWorkspaceDir, { recursive: true });
    await rejectsWith(
      new SessionTranscriptReader(otherWorkspaceDir).readPage(sessionId, {
        cursor,
      }),
      BadCursor,
    );
  });

  it('does not duplicate same-uuid fragments parsed from one glued JSONL line', async () => {
    await writeRawTranscript(
      jsonLine(record('u1', null, 'hello'), record('u1', null, ' world')) +
        jsonLine(record('a1', 'u1', 'reply')),
    );
    const page = await readPage({ limit: 1 });
    expect(page.records).toHaveLength(1);
    expect(page.records[0]?.message?.parts).toEqual([
      { text: 'hello' },
      { text: ' world' },
    ]);
  });

  it('counts glued-line fragments conservatively against the byte budget', async () => {
    const first = record('u1', null, 'hello');
    const second = record('u1', null, ' world');
    await writeRawTranscript(
      jsonLine(first, second) + jsonLine(record('a1', 'u1', 'reply')),
    );
    const page = await readPage({
      limit: 2,
      maxBytes: jsonBytes(first, second) * 2,
    });
    // Conservative per-fragment counting spends the whole budget on the glued
    // aggregate, so the next record must wait for the following page.
    expectPage(page, ['u1'], true);
  });

  it('skips non-ChatRecord JSON lines while indexing', async () => {
    await writeRawTranscript(
      jsonLine({ event: 'metadata' }) + jsonLine(record('u1', null, 'hello')),
    );
    expect(uuids((await readPage()).records)).toEqual(['u1']);
  });

  it('raises snapshot-unavailable when a same-size in-place rewrite reuses a cached segment', async () => {
    const initial = jsonLine(record('u1', null, 'hello'));
    const filePath = await writeRawTranscript(initial);
    await pinMtime(filePath);
    const reader = newReader();
    await expect(reader.readPage(sessionId)).resolves.toMatchObject({
      records: [expect.objectContaining({ uuid: 'u1' })],
    });

    // Byte length and (pinned) mtime keep the cached index, but the recorded
    // offset now parses to a different uuid: surface 409, never drop it.
    await renameU1InPlace(filePath, initial);
    await rejectsWith(reader.readPage(sessionId), Unavailable);
  });

  it('does not repeatedly copy pending bytes for one large record', async () => {
    const largeRecord = record('u1', null, 'x'.repeat(512 * 1024));
    const filePath = await writeRawTranscript(jsonLine(largeRecord));
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
      const page = await readPage();
      expect(uuids(page.records)).toEqual(['u1']);
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
    await writeRecords(chain('first', 'second', 'third'));

    const page = await readPage().finally(() => {
      readSettled = true;
    });

    expect(uuids(page.records)).toEqual(['u1', 'a1', 'u2']);
    expect(yielded.length).toBeGreaterThanOrEqual(6);
    expect(siblingRanBeforeSettlement).toBe(true);
  });

  it('reuses one glued physical line across projection pre-read and dispatch', async () => {
    const first = record('u1', null, 'first');
    const second = record('a1', 'u1', 'second');
    await writeRawTranscript(jsonLine(first, second));
    const selectedReads: Array<{ offset: number; length: number }> = [];
    setSessionTranscriptSelectedLineReadHookForTest((offset, length) => {
      selectedReads.push({ offset, length });
    });

    const projection = await coldProjection();

    expect(projection?.runtime.apiHistory).toEqual([
      first.message,
      second.message,
    ]);
    expect(selectedReads).toEqual([
      { offset: 0, length: jsonBytes(first, second) },
    ]);
  });

  it('rejects oversized snapshots before indexing', async () => {
    const filePath = await writeRecords([record('u1', null, 'hello')]);
    await fs.truncate(filePath, SESSION_TRANSCRIPT_MAX_INDEX_BYTES + 1);
    await expect(readPage()).rejects.toMatchObject({
      name: 'SessionTranscriptTooLargeError',
      sessionId,
      snapshotSize: SESSION_TRANSCRIPT_MAX_INDEX_BYTES + 1,
      maxBytes: SESSION_TRANSCRIPT_MAX_INDEX_BYTES,
    });
  });

  it('shares an oversized in-flight index without retaining its completion', async () => {
    const filePath = await writeRecords(chain('hello', 'reply'));
    setSessionTranscriptIndexCacheMaxBytesForTest(1);
    const builds = countBuilds(filePath);
    const reader = newReader();
    const [first, second] = await Promise.all([
      reader.readPage(sessionId),
      reader.readPage(sessionId),
    ]);
    expect(builds.count).toBe(1);
    expect(first.records).toEqual(second.records);
    expectEmptyCache();
  });

  it('does not evict cached indexes when a new index exceeds the byte budget alone', async () => {
    const { reader, state } = await firstPage('hello', 'reply');
    const warmCache = getSessionTranscriptIndexCacheStatsForTest();
    expect(warmCache.entries).toBe(1);
    setSessionTranscriptIndexCacheMaxBytesForTest(warmCache.byteSize + 1);

    const large = (i: number) => `large transcript ${i}`;
    await writeRecords(
      linear('large-', 0, 19, null, large, otherSessionId),
      otherSessionId,
    );
    await reader.readPage(otherSessionId, { limit: 1 });
    const afterOversizedRead = getSessionTranscriptIndexCacheStatsForTest();
    expect(afterOversizedRead.entries).toBe(1);
    expect(afterOversizedRead.byteSize).toBe(warmCache.byteSize);

    const second = await readAfter(reader, state, { limit: 1 });
    expect(uuids(second.records)).toEqual(['a1']);
  });

  it('accounts for retained projection hints in the cache byte estimate', async () => {
    const reader = newReader();
    const estimateFor = async (targetSessionId: string, suffix: string) => {
      const goalContext = {
        goalId: `goal-${suffix}`,
        revision: 1,
        turnId: `turn-${suffix}`,
      };
      const notice = record('notification', null, 'notice', targetSessionId);
      const result = record(
        'assistant',
        'notification',
        'result',
        targetSessionId,
      );
      await writeRecords(
        [
          {
            ...notice,
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
          { ...result, provenance: 'assistant_output', goalContext },
        ],
        targetSessionId,
      );
      await reader.readPage(targetSessionId);
      return getSessionTranscriptIndexCacheStatsForTest().byteSize;
    };
    const shortEstimate = await estimateFor(
      '710e8400-e29b-41d4-a716-446655440000',
      'short',
    );
    clearSessionTranscriptIndexCacheEntriesForTest();
    const longEstimate = await estimateFor(
      '720e8400-e29b-41d4-a716-446655440000',
      'x'.repeat(8 * 1024),
    );

    // Background task ids are retained per record and counted; the Goal
    // context is not (its evidence hint only pre-built the removed checkpoint
    // windows), so an 8 KB goal id and turn id must not grow the cache.
    const growth = longEstimate - shortEstimate;
    expect(growth).toBeGreaterThan(8 * 1024);
    expect(growth).toBeLessThan(40 * 1024);
  });

  it('does not let an evicted pending build overwrite a newer cache entry', async () => {
    const initial = jsonLine(record('u1', null, 'hello'));
    const filePath = await writeRawTranscript(initial);
    await pinMtime(filePath);

    let buildCount = 0;
    let releaseFirstBuild: (() => void) | undefined;
    const firstBuildBlocked = new Promise<void>((resolve) => {
      releaseFirstBuild = resolve;
    });
    setSessionTranscriptIndexBuildCompleteHookForTest(async (builtPath) => {
      if (builtPath !== filePath || buildCount++ !== 0) return;
      await firstBuildBlocked;
    });

    const reader = newReader();
    const staleRead = reader.readPage(sessionId);
    await vi.waitFor(() => expect(buildCount).toBe(1));

    clearSessionTranscriptIndexCacheEntriesForTest();
    await renameU1InPlace(filePath, initial);
    const readsX1 = () =>
      expect(reader.readPage(sessionId)).resolves.toMatchObject({
        records: [expect.objectContaining({ uuid: 'x1' })],
      });
    await readsX1();

    releaseFirstBuild?.();
    await rejectsWith(staleRead, Unavailable);
    await readsX1();
  });

  it('does not let a fresh cold projection replace a cached pending build', async () => {
    const filePath = await writeRecords(chain('hello', 'reply'));
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

    const reader = newReader();
    const cachedRead = reader.readPage(sessionId);
    await vi.waitFor(() => expect(buildCount).toBe(1));

    await expect(
      reader.readRestoreProjection(sessionId, NONE),
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
    const reader = newReader();
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
    await expect(newReader().readPage('../escape')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('returns ENOENT for a valid session id without a transcript file', async () => {
    await expect(readPage()).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects selected records from a different session', async () => {
    await writeRecords([
      record('u1', null, 'local'),
      record('a1', 'u1', 'foreign', otherSessionId),
    ]);
    await rejectsWith(readPage(), Unavailable);
  });

  it('rejects foreign dead-branch metadata even when no consumer selects it', async () => {
    await writeRecords([
      ...chain('local', 'local reply'),
      sys(
        'metadata',
        'u1',
        'rewind',
        { truncatedCount: 1 },
        { sessionId: otherSessionId },
      ),
      record('u2', 'a1', 'next local prompt'),
      record('a2', 'u2', 'next local reply'),
    ]);
    await rejectsWith(coldProjection(), Unavailable);
  });

  it('rejects tampered cursor snapshots before cache lookup', async () => {
    const { reader, state } = await firstPage('hello', 'reply', 'next');
    const tampered = forgeToken(encodeCursor(state), (decoded) => ({
      ...decoded,
      snapshotSize: 1,
    }));
    await rejectsWith(
      reader.readPage(sessionId, { cursor: tampered }),
      BadCursor,
    );
  });

  // Regression: an in-place rewrite that keeps the inode AND byte length must
  // not be masked by the index cache (cache key includes the file mtime).
  it('reflects an in-place same-size rewrite once the mtime advances', async () => {
    const mk = (uuid: string, parentUuid: string | null): ChatRecord => ({
      uuid,
      parentUuid,
      sessionId,
      timestamp: T1,
      type: 'user',
      cwd: workspaceDir,
      version: '1.0.0',
      message: userText('hello world'),
    });
    const filePath = await writeRecords([
      mk('11111111', null),
      mk('22222222', '11111111'),
    ]);
    const reader = newReader();
    const readAll = async () =>
      uuids((await reader.readPage(sessionId, { limit: 100 })).records);
    expect(await readAll()).toEqual(['11111111', '22222222']);

    // Same inode, identical byte length (8-char uuids), new content + mtime.
    await fs.writeFile(
      filePath,
      [mk('33333333', null), mk('44444444', '33333333')]
        .map((item) => jsonLine(item))
        .join(''),
      'utf8',
    );
    const later = new Date(Date.now() + 60_000);
    await fs.utimes(filePath, later, later);
    expect(await readAll()).toEqual(['33333333', '44444444']);
  });

  describe('boundary and turn-start edge cases', () => {
    it('makes exact turn-boundary cuts when limit aligns perfectly', async () => {
      await writeRecords(chain(...TWO_TURNS));
      const first = await readPage({ beforeRecordId: 'u2', limit: 2 });
      expectPage(first, ['u1', 'a1'], false);
      expect(first.nextCursorState).toBeUndefined();
    });

    it('discovers backward boundary when beforeRecordId is an assistant record', async () => {
      await writeRecords(chain(...TWO_TURNS));
      const page = await readPage({ beforeRecordId: 'a2', limit: 2 });
      expect(uuids(page.records)).toEqual(['u2']);
      expect(page.direction).toBe('backward');
      expect(page.hasMore).toBe(true);
    });

    it('pages backward through records without a normal user turn start', async () => {
      await writeRecords([
        record('a1', null, 'orphan assistant reply'),
        record('u1', 'a1', 'second prompt'),
        record('a2', 'u1', 'second answer'),
      ]);
      const page = await readPage({ beforeRecordId: 'u1', limit: 5 });
      expectPage(page, ['a1'], false);
    });

    it('bounds backward pages inside a single long turn and still chains to the start', async () => {
      // One prompt then one long in-flight turn (the concurrent /review
      // shape): the only turn start is the file head, so alignment must NOT
      // expand every backward page to the whole transcript.
      await writeRecords(longTurn(300, (i) => `step ${i}`));
      const reader = newReader();
      const first = await reader.readPage(sessionId, { ...BACK, limit: 50 });

      // No turn boundary is reachable, so the page stays the requested
      // window (`limit` records, not `2 * limit`).
      expect(first.records.length).toBe(50);
      expect(first.records.at(-1)?.uuid).toBe('a300');
      expect(first.records.at(0)?.uuid).toBe('a251');
      expect(first.hasMore).toBe(true);

      const seen = await chainBackward(
        reader,
        first,
        { limit: 50 },
        20,
        (next) => expect(next.records.length).toBeLessThanOrEqual(100),
      );
      expect(seen.size).toBe(301);
      expect(seen.has('u1')).toBe(true);
    });

    it('bounds backward turn expansion under a byte budget in a single long turn', async () => {
      await writeRecords(longTurn(150, () => `x`.repeat(2000)));
      const page = await readPage({ ...BACK, limit: 50, maxBytes: 5000 });
      // Budget stops selection two records from the tail; alignment must
      // not drag the page headward once unreachable in the expansion budget.
      expectPage(page, ['a149', 'a150'], true);
    });

    it('caps turn-alignment expansion at the hard byte ceiling', async () => {
      // maxBytes exceeds half the (test-only) ceiling, so the expansion
      // budget is the ceiling, not 2 * maxBytes: the ~56 KB turn fits 64 KB
      // but not 48 KB, so alignment keeps the bounded selection. Dropping the
      // clamp (or ignoring the override) would admit the whole turn (fails u1).
      setSessionTranscriptExpandedPageBytesForTest(48 * 1024);
      const records = longTurn(20, () => 'x'.repeat(2560));
      await writeRecords(records);
      const maxBytes = 32 * 1024;
      const reader = newReader();
      const page = await reader.readPage(sessionId, {
        ...BACK,
        limit: 50,
        maxBytes,
      });

      expect(page.records.length).toBeLessThan(20);
      expect(page.records.at(-1)?.uuid).toBe('a20');
      expect(page.records.some((item) => item.uuid === 'u1')).toBe(false);
      expect(page.hasMore).toBe(true);
      expectSkipLogged('turn expansion', 'byte-budget');

      // Chaining still reaches the turn start: once the remaining turn fits
      // the expansion budget, alignment admits it whole.
      const seen = await chainBackward(
        reader,
        page,
        { limit: 50, maxBytes },
        40,
      );
      expect(seen.size).toBe(records.length);
      expect(seen.has('u1')).toBe(true);
    });

    it('keeps chained backward pages within a bounded multiple of the byte budget', async () => {
      // Expansion is capped at a bounded multiple of maxBytes, not at the
      // hard ceiling: with the nominal route budget a chained page must not
      // balloon straight to the ceiling (the clamp is tested above).
      await writeRecords(longTurn(60, () => 'x'.repeat(3 * 1024)));
      const maxBytes = 16 * 1024;
      const reader = newReader();
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
        // Selection respects maxBytes; alignment adds at most one budget.
        const pageBytes = jsonBytes(...page.records);
        expect(pageBytes).toBeLessThanOrEqual(2 * maxBytes + 4 * 1024);
        boundary = page.hasMore ? page.records.at(0)?.uuid : undefined;
        expect(pages).toBeLessThan(40);
      } while (boundary !== undefined);
    });

    /** A call whose results straddle one interjecting record. */
    const splitPair = (uuid: string, text: string, subtype: string) => [
      record('u1', null, 'prompt'),
      record('af0', 'u1', 'filler'),
      toolCallRecord('ac1', 'af0', 'call-1'),
      toolResultRecord('ar0', 'ac1', 'call-1'),
      sub(uuid, 'ar0', text, subtype),
      toolResultRecord('ar1', uuid, 'call-1'),
      record('af1', 'ar1', 'filler'),
    ];

    it('walks past mid-turn user records to the owning call', async () => {
      // notification, cron and goal_runtime records persist mid-turn as
      // user-role records that start no turn and own no results, so pair
      // extension must pass through them like realtime records instead of
      // starting the page on an orphan result.
      const subtypes = ['notification', 'cron', 'goal_runtime'] as const;
      for (const [variant, subtype] of subtypes.entries()) {
        const targetSessionId = `550e8400-e29b-41d4-a716-44665544000${variant}`;
        const records = splitPair('usyn', 'interjection', subtype);
        // A distinct session per variant: rewriting one file in place can
        // keep the inode and byte length, which the index cache keys on.
        await writeRecords(
          records.map((item) => ({ ...item, sessionId: targetSessionId })),
          targetSessionId,
        );

        const page = await newReader().readPage(targetSessionId, {
          ...BACK,
          limit: 3,
        });

        expect(uuids(page.records)).toEqual([
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
      // A tool_result over 2 * maxBytes is force-taken (always-take-one
      // rule). Pair extension must budget only the records it adds, or that
      // result fails the check by construction and the page starts on an
      // orphan (replaying the successful call as failed "result missing").
      await writeRecords([
        record('u1', null, 'prompt'),
        toolCallRecord('ac1', 'u1', 'call-1'),
        toolResultRecord('ar1', 'ac1', 'call-1', 'x'.repeat(3 * 1024 * 1024)),
      ]);
      const page = await readPage({
        ...BACK,
        limit: 50,
        maxBytes: 1024 * 1024,
      });
      expect(uuids(page.records)).toEqual(['ac1', 'ar1']);
      expect(page.records.at(0)?.type).toBe('assistant');
      expect(page.hasMore).toBe(true);
    });

    it('keeps the pair together when the owning call exceeds the expansion budget', async () => {
      // The owner can itself exceed the expansion budget (one write_file call
      // with a large body). Pair extension exempts the force-joined owner as
      // the selection loop exempts its forced first record, instead of
      // splitting the pair and replaying the call as failed ("result missing").
      await writeRecords([
        record('u1', null, 'prompt'),
        toolCallRecord('ac1', 'u1', 'call-1', 'write_file', {
          content: 'x'.repeat(40 * 1024),
        }),
        toolResultRecord('ar1', 'ac1', 'call-1'),
      ]);
      const page = await readPage({ ...BACK, limit: 50, maxBytes: 16 * 1024 });
      expect(uuids(page.records)).toEqual(['ac1', 'ar1']);
      expect(page.records.at(0)?.type).toBe('assistant');
      expect(page.hasMore).toBe(true);
    });

    it('does not expand a backward page when no tool pair is split', async () => {
      // With no orphaned tool_result in the selection, walking further down to
      // keep a call/result pair gains nothing (even though system records are
      // not page starts) and only inflates the page past `limit`.
      await writeRecords([
        record('u0', null, 'prompt'),
        ...linear('a', 0, 9, 'u0', (i) => `step ${i}`),
        sys('sys1', 'a9', 'goal_state'),
        record('a10', 'sys1', 'step 10'),
        record('a11', 'a10', 'step 11'),
      ]);
      const page = await readPage({ ...BACK, limit: 3 });
      expectPage(page, ['sys1', 'a10', 'a11'], true);
    });

    it('does not walk past an anchored realtime record without a pair', async () => {
      // Alignment may legitimately anchor a page on a realtime user record.
      // With no orphaned tool_result the pair walk must not refuse it and
      // drag the page back to an earlier assistant, burning the window.
      const records = linear('af', 0, 9, null, (i) => `filler ${i}`);
      for (let i = 0; i < 3; i++) {
        const parent = i ? `art${i - 1}` : 'af9';
        records.push(
          sub(`urt${i}`, parent, `user speech ${i}`, 'realtime_message'),
          sub(
            `art${i}`,
            `urt${i}`,
            `assistant speech ${i}`,
            'realtime_message',
          ),
        );
      }
      await writeRecords(records);
      const page = await readPage({ ...BACK, limit: 4 });
      expectPage(page, ['urt1', 'art1', 'urt2', 'art2'], true);
    });

    it('bounds the leading prefix absorbed before the first turn', async () => {
      // Sessions can persist a long run of system records ahead of the first
      // turn. Aligning to the first turn must not absorb an arbitrarily long
      // leading prefix: worst case a page holds 3 * limit records.
      const records = [
        ...Array.from({ length: 200 }, (_, i) =>
          sys(`sys${i}`, i === 0 ? null : `sys${i - 1}`, 'ui_telemetry'),
        ),
        record('u1', 'sys199', 'prompt'),
        ...linear('a', 1, 5, 'u1', (i) => `step ${i}`),
      ];
      await writeRecords(records);
      const reader = newReader();
      const first = await reader.readPage(sessionId, { ...BACK, limit: 10 });

      expect(uuids(first.records)).toEqual([
        'u1',
        'a1',
        'a2',
        'a3',
        'a4',
        'a5',
      ]);
      expect(first.hasMore).toBe(true);
      expectSkipLogged('turn expansion', 'record-budget');

      // Chaining still covers the whole leading prefix.
      const seen = await chainBackward(reader, first, { limit: 10 }, 40);
      expect(seen.size).toBe(records.length);
    });

    it('keeps tool call/result pairs on the same backward page', async () => {
      // One long turn of tool calls and results; call 30 has two (parallel
      // batch), so page boundaries land mid-run on tool_result records.
      // Pages finalize independently, so a split pair would render the call
      // as failed on the older page and the result as an orphan on the newer.
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

      const reader = newReader();
      const pages: ChatRecord[][] = [];
      let page = await reader.readPage(sessionId, { ...BACK, limit: 50 });
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
        // A page starting at a tool_result would replay it without its call.
        expect(pageRecords.at(0)?.type).not.toBe('tool_result');
        const pageUuids = new Set(uuids(pageRecords));
        for (const item of pageRecords) {
          if (item.type === 'tool_result') {
            expect(item.parentUuid).not.toBeNull();
            expect(pageUuids.has(item.parentUuid!)).toBe(true);
          }
          const results = resultsByCall.get(item.uuid);
          if (results) {
            for (const resultUuid of results) {
              expect(pageUuids.has(resultUuid)).toBe(true);
            }
            if (pageRecords.at(0)?.uuid === item.uuid) {
              sawMidTurnCallStart = true;
            }
          }
        }
        // Symmetric end invariant: no page ends on a call whose results live
        // on the newer page (without a byte budget pair extension always
        // succeeds, so no accepted mid-pair edge exists).
        const lastResults = resultsByCall.get(pageRecords.at(-1)?.uuid ?? '');
        if (lastResults) {
          for (const resultUuid of lastResults) {
            expect(pageUuids.has(resultUuid)).toBe(true);
          }
        }
      }
      // The chain really exercised mid-turn page starts, not only
      // turn-aligned pages.
      expect(sawMidTurnCallStart).toBe(true);

      const flat = pages.flat();
      expect(flat.length).toBe(records.length);
      expect(new Set(uuids(flat)).size).toBe(records.length);
      expect(flat.some((item) => item.uuid === 'u1')).toBe(true);
    });

    it('extends a byte-limited backward page to the owning tool call', async () => {
      const records: ChatRecord[] = [record('u1', null, 'prompt')];
      for (let i = 1; i <= 3; i++) {
        records.push(
          toolCallRecord(`ac${i}`, i === 1 ? 'u1' : `ar${i - 1}`, `call-${i}`),
          toolResultRecord(`ar${i}`, `ac${i}`, `call-${i}`),
        );
      }
      await writeRecords(records);
      // Budget admits only the trailing tool_result; the page must still
      // extend to the owning call rather than split the pair.
      const page = await readPage({
        ...BACK,
        limit: 2,
        maxBytes: jsonBytes(records.at(-1)),
      });
      expectPage(page, ['ac3', 'ar3'], true);
    });

    it('extends the page to an owning call several records below the selection', async () => {
      // A result run long enough that the natural selection starts mid-run: the
      // page must extend through the run to the owning call. limit 3 lands the
      // natural start on ar2; the owner sits exactly three records below, at
      // the edge of the one-window pair-extension budget.
      await writeRecords(callWithResults(5));
      const page = await readPage({ ...BACK, limit: 3 });
      expect(uuids(page.records)).toEqual([
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
      // Realtime records persist at wall-clock time and can land between a
      // call and its results; owning none, pair extension must pass through.
      // limit 3 lands the natural start on the realtime record; the owner
      // sits three records below, at the one-window pair-extension edge.
      await writeRecords(
        splitPair('a-live', 'live interjection', 'realtime_message'),
      );
      const page = await readPage({ ...BACK, limit: 3 });
      expect(uuids(page.records)).toEqual([
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
      // A long turn ending in a parallel batch of large results owned by one
      // call. The budget stops selection mid-batch; extending to the owner
      // would balloon the page toward the route's hard response cap, so the
      // bounded selection stands and chaining continues mid-batch.
      const records = [
        record('u1', null, 'prompt'),
        ...linear('af', 1, 150, 'u1', (i) => `step ${i}`),
        toolCallRecord('ac1', 'af150', 'call-1'),
        ...resultRun(50, 'ac1', 'x'.repeat(4000)),
      ];
      await writeRecords(records);
      const options = { limit: 100, maxBytes: 10000 };
      const reader = newReader();
      const page = await reader.readPage(sessionId, { ...BACK, ...options });

      // The budget admits two large results; the 49-record extension to the
      // owning call does not fit one extra budget, so the page stays at the
      // bounded (mid-batch) selection instead of 51 records.
      expectPage(page, ['ar48', 'ar49'], true);
      expectSkipLogged('pair extension', 'byte-budget');

      // Under the same budget every chained page stays bounded, chaining
      // terminates, and the full record set is covered exactly once.
      const seen = await chainBackward(reader, page, options, 40, (next) => {
        expect(next.records.length).toBeGreaterThan(0);
        expect(next.records.length).toBeLessThanOrEqual(200);
      });
      expect(seen.size).toBe(records.length);
      expect(seen.has('u1')).toBe(true);
    });

    it('caps pair extension for a long tool_result run', async () => {
      // One call owning a long result run (a persisted parallel batch): the
      // walk toward the owner must stay bounded instead of absorbing the
      // run, and chaining must still reach the owner and the turn start.
      const records = callWithResults(400);
      await writeRecords(records);
      const reader = newReader();
      const first = await reader.readPage(sessionId, { ...BACK, limit: 50 });

      expect(first.records.length).toBeLessThanOrEqual(100);
      // The owner lies below the expansion budget, so the bounded selection
      // stands and the page starts mid-run on a tool_result record.
      expect(first.records.at(0)?.type).toBe('tool_result');
      expect(first.records.at(-1)?.uuid).toBe('ar399');
      expect(first.hasMore).toBe(true);
      expectSkipLogged('pair extension', 'record-budget');

      // Contract bound per page: requested window + one alignment window +
      // one pair-extension window (the page absorbing the owning call).
      const seen = await chainBackward(
        reader,
        first,
        { limit: 50 },
        20,
        (next) => expect(next.records.length).toBeLessThanOrEqual(150),
      );
      expect(seen.size).toBe(records.length);
      expect(seen.has('ac1')).toBe(true);
      expect(seen.has('u1')).toBe(true);
    });

    it('keeps a byte-limited page bounded against a long tool_result run', async () => {
      await writeRecords(callWithResults(400));
      const page = await readPage({ ...BACK, limit: 50, maxBytes: 5000 });
      // The budget admits only a few records; pair extension must not drag
      // the page back through the 400-record run toward the owning call.
      expect(page.records.length).toBeGreaterThan(0);
      expect(page.records.length).toBeLessThanOrEqual(100);
      expect(page.records.at(0)?.type).toBe('tool_result');
      expect(page.records.at(-1)?.uuid).toBe('ar399');
      expect(page.hasMore).toBe(true);
    });
  });

  describe('turn navigation', () => {
    const turnResult = (uuid: string, parentUuid: string, promptId: string) =>
      sys(uuid, parentUuid, 'turn_result', {
        promptId,
        state: 'completed',
        endedAt: RECORD_BASE_MS,
      });

    /** A tool call (a1), a scheduled turn (uc1) inside it, and the result. */
    const scheduledInsideCall = (callParent: string) => [
      toolCallRecord('a1', callParent, 'call-1'),
      sub('uc1', 'a1', 'model schedule payload', 'cron', {
        displayText: 'Scheduled review',
      }),
      toolResultRecord('r1', 'uc1', 'call-1'),
    ];

    /** Writes `records` and reads the page anchored at `atRecordId`. */
    async function anchorPage(
      records: ChatRecord[],
      atRecordId: string,
      options: SessionTranscriptReadPageOptions,
    ) {
      await writeRecords(records);
      const reader = newReader();
      const index = await reader.readTurnIndexPage(sessionId);
      const page = await reader.readPage(sessionId, {
        atRecordId,
        snapshot: index.snapshot,
        ...options,
      });
      return { reader, page };
    }

    it('exposes the admitted prompt identity before a turn result is recorded', async () => {
      await writeRecords([
        {
          ...record('u1', null, 'same prompt'),
          daemonPromptId: 'active-prompt',
        },
      ]);
      const page = await turnIndex({ limit: 10 });
      expect(page.turns).toHaveLength(1);
      expect(page.turns[0]).toMatchObject({
        turnId: 'u1',
        promptId: 'active-prompt',
      });
    });

    it('builds stable sparse pages and projects only public previews', async () => {
      const attachmentToken = '@attachment:///file-1';
      await writeRecords([
        {
          ...record('u1', null, 'model-facing prompt'),
          systemPayload: {
            displayText: `Visible prompt\n\n${attachmentToken}`,
            hookContext: 'private hook context',
            attachmentReferences: [
              { type: 'resource', attachmentId: 'file-1' },
            ],
          },
        } as ChatRecord,
        sub('ur1', 'u1', 'spoken update', 'realtime_message'),
        sub('art1', 'ur1', 'realtime reply', 'realtime_message'),
        {
          ...record('a1', 'art1', ''),
          message: {
            role: 'model',
            parts: [
              null,
              { text: 'private reasoning', thought: true },
              fnCall('run_shell_command', { command: 'secret' }, 'call-1'),
              { text: 'Public answer' },
            ],
          },
        } as unknown as ChatRecord,
        turnResult('tr1', 'a1', 'prompt-1'),
        sub('ug1', 'tr1', 'private goal runtime', 'goal_runtime'),
        sub('um1', 'ug1', 'steering message', 'mid_turn_user_message'),
        sub('un1', 'um1', 'background notice', 'notification'),
        sub('uc1', 'un1', 'model schedule payload', 'cron', {
          displayText: 'Scheduled review',
        }),
        record('a2', 'uc1', 'Scheduled result'),
        turnResult('tr2', 'a2', 'prompt-2'),
        { ...record('u2', 'tr2', ''), message: content('user') },
        {
          ...record('u3', 'u2', ''),
          message: content('user', {
            inlineData: { mimeType: 'image/png', data: 'AA==' },
          }),
        },
      ]);

      const reader = newReader();
      const tail = await reader.readTurnIndexPage(sessionId, { limit: 2 });

      expect(tail.totalTurns).toBe(4);
      expect(tail.start).toBe(2);
      expect(tail.turns).toEqual([
        expect.objectContaining({
          ordinal: 2,
          turnId: 'uc1',
          kind: 'scheduled',
          promptId: 'prompt-2',
          label: 'Scheduled review',
          detail: 'Scheduled result',
        }),
        expect.objectContaining({
          ordinal: 3,
          turnId: 'u3',
          kind: 'prompt',
          label: 'Prompt',
        }),
      ]);

      const head = await reader.readTurnIndexPage(sessionId, {
        snapshot: tail.snapshot,
        start: 0,
        limit: 2,
      });
      expect(head.turns).toEqual([
        expect.objectContaining({
          ordinal: 0,
          turnId: 'u1',
          kind: 'prompt',
          promptId: 'prompt-1',
          label: 'Visible prompt',
          detail: 'Public answer',
        }),
        expect.objectContaining({
          ordinal: 1,
          turnId: 'ur1',
          kind: 'realtime',
          label: 'spoken update',
          detail: 'realtime reply',
        }),
      ]);
      expect(JSON.stringify(head.turns)).not.toContain('secret');
      expect(JSON.stringify(head.turns)).not.toContain('private');
      expect(JSON.stringify(head.turns)).not.toContain(attachmentToken);
      expect(head.turns[1]).not.toHaveProperty('promptId');
    });

    it('keeps snapshots stable after append and a cold-cache rebuild', async () => {
      const filePath = await writeRecords(
        chain('first', 'answer one', 'second', 'answer two'),
      );
      const reader = newReader();
      const { snapshot } = await reader.readTurnIndexPage(sessionId);
      await appendRecords(filePath, record('u3', 'a2', 'third'));
      resetSessionTranscriptIndexCacheForTest();

      const frozen = await reader.readTurnIndexPage(sessionId, {
        snapshot,
        start: 0,
      });
      const latest = await reader.readTurnIndexPage(sessionId);
      expect(frozen.totalTurns).toBe(2);
      expect(latest.totalTurns).toBe(3);

      const anchored = await reader.readPage(sessionId, {
        atRecordId: 'u2',
        snapshot,
        limit: 2,
      });
      expect(uuids(anchored.records)).toEqual(['u2', 'a2']);
      expect(anchored.targetRecordId).toBe('u2');
      expect(anchored.hasOlder).toBe(true);
      expect(anchored.hasMore).toBe(false);

      await expect(
        reader.readPage(sessionId, { atRecordId: 'a1', snapshot }),
      ).rejects.toMatchObject({
        name: 'InvalidSessionTranscriptTurnAnchorError',
      });
      await rejectsWith(
        reader.readPage(sessionId, { atRecordId: 'u1' }),
        BadCursor,
      );
    });

    it('continues forward from an anchored page inside the frozen snapshot', async () => {
      const { reader, page: anchored } = await anchorPage(
        chain(
          'first',
          'answer one',
          'second',
          'answer two',
          'third',
          'answer three',
        ),
        'u2',
        { limit: 2 },
      );
      expectPage(anchored, ['u2', 'a2'], true);
      expect(anchored.nextCursorState).toBeDefined();

      const continued = await readAfter(reader, anchored.nextCursorState!, {
        limit: 2,
      });
      expectPage(continued, ['u3', 'a3'], false);
    });

    it('rejects conflicting snapshot-bound transcript anchors', async () => {
      await writeRecords(chain('first', 'answer one', 'second'));
      const reader = newReader();
      const { snapshot } = await reader.readTurnIndexPage(sessionId);
      const first = await reader.readPage(sessionId, { limit: 1 });
      const cursor = encodeCursor(first.nextCursorState!);
      const read = (options: SessionTranscriptReadPageOptions) =>
        rejectsWith(reader.readPage(sessionId, options), BadCursor);

      await read({ cursor, atRecordId: 'u2', snapshot });
      await read({ atRecordId: 'u2', beforeRecordId: 'u1', snapshot });
      await read({ snapshot });
    });

    it('rejects snapshots minted for another session', async () => {
      await writeRecords(chain('first', 'answer one'));
      const reader = newReader();
      const { snapshot } = await reader.readTurnIndexPage(sessionId);
      const otherId = '550e8400-e29b-41d4-a716-446655440001';
      await writeRecords(
        [
          record('other-u1', null, 'other first'),
          record('other-a1', 'other-u1', 'other answer'),
        ],
        otherId,
      );

      await rejectsWith(
        reader.readTurnIndexPage(otherId, { snapshot, start: 0 }),
        BadCursor,
      );
      await rejectsWith(
        reader.readPage(otherId, { atRecordId: 'other-u1', snapshot }),
        BadCursor,
      );
    });

    it('expands an anchored scheduled turn to a safe replay boundary', async () => {
      const { page: anchored } = await anchorPage(
        [record('u1', null, 'first prompt'), ...scheduledInsideCall('u1')],
        'uc1',
        { limit: 2 },
      );
      expect(uuids(anchored.records)).toEqual(['a1', 'uc1', 'r1']);
      expect(anchored.targetRecordId).toBe('uc1');
      expect(anchored.hasOlder).toBe(true);
    });

    it('keeps an anchored page bounded when safe expansion exceeds its budget', async () => {
      setSessionTranscriptExpandedPageBytesForTest(1);
      const { page: anchored } = await anchorPage(
        [record('u1', null, 'first prompt'), ...scheduledInsideCall('u1')],
        'uc1',
        { limit: 2, maxBytes: 1024 },
      );
      expect(uuids(anchored.records)).toEqual(['uc1', 'r1']);
      expect(anchored.targetRecordId).toBe('uc1');
      expect(anchored.hasOlder).toBe(true);
    });

    it('reports no older records when boundary expansion reaches file head', async () => {
      const { page: anchored } = await anchorPage(
        scheduledInsideCall('u0'),
        'uc1',
        { limit: 1 },
      );
      expect(uuids(anchored.records)).toEqual(['a1', 'uc1']);
      expect(anchored.hasOlder).toBe(false);
    });

    it('supports an empty frozen snapshot and rejects tampering', async () => {
      await writeRawTranscript('');
      const reader = newReader();
      const page = await reader.readTurnIndexPage(sessionId);
      const readIndex = (options: { snapshot?: string; start?: number }) =>
        rejectsWith(reader.readTurnIndexPage(sessionId, options), BadCursor);

      expect(page).toMatchObject({ totalTurns: 0, start: 0, turns: [] });
      const tampered = `${page.snapshot[0] === 'A' ? 'B' : 'A'}${page.snapshot.slice(1)}`;
      await readIndex({ snapshot: tampered });
      const forged = forgeToken(page.snapshot, (decoded) => ({
        ...decoded,
        snapshotSize: (decoded['snapshotSize'] as number) + 1,
      }));
      await readIndex({ snapshot: forged });
      await readIndex({ start: 0 });
      await readIndex({ snapshot: page.snapshot, start: 1 });
    });

    it('rejects a frozen turn-index snapshot after its leaf is replaced', async () => {
      const filePath = await writeRecords(chain('first', 'answer one'));
      const reader = newReader();
      const { snapshot } = await reader.readTurnIndexPage(sessionId);
      const original = await fs.readFile(filePath, 'utf8');
      await fs.writeFile(
        filePath,
        original.replace('"uuid":"a1"', '"uuid":"a2"'),
        'utf8',
      );
      resetSessionTranscriptIndexCacheForTest();
      await rejectsWith(
        reader.readTurnIndexPage(sessionId, { snapshot, start: 0 }),
        Unavailable,
      );
    });

    it('caps navigation labels and details by Unicode code points', async () => {
      await writeRecords(chain('🧭'.repeat(200), '🧩'.repeat(300)));
      const turn = (await turnIndex()).turns[0]!;
      expect(Array.from(turn.label)).toHaveLength(160);
      expect(turn.label.endsWith('…')).toBe(true);
      expect(Array.from(turn.detail ?? '')).toHaveLength(240);
      expect(turn.detail?.endsWith('…')).toBe(true);
    });

    it('does not turn a fragmented control-only user record into navigation', async () => {
      await writeRecords([
        { ...record('u1', null, ''), message: content('user') },
        {
          ...record('u1', null, ''),
          message: userText(controlContext('private')),
        },
        record('u2', 'u1', 'visible prompt'),
      ]);
      const page = await turnIndex();
      expect(page.totalTurns).toBe(1);
      expect(page.turns).toEqual([
        expect.objectContaining({ turnId: 'u2', label: 'visible prompt' }),
      ]);
    });

    it('omits control-context parts from a mixed visible label', async () => {
      await writeRecords([
        {
          ...record('u1', null, ''),
          message: content(
            'user',
            { text: controlContext('private context') },
            { text: 'visible prompt' },
          ),
        },
      ]);
      const page = await turnIndex();
      expect(page.turns).toEqual([
        expect.objectContaining({ turnId: 'u1', label: 'visible prompt' }),
      ]);
      expect(JSON.stringify(page.turns)).not.toContain('private context');
    });

    it('does not use control-only display text as navigation', async () => {
      const context = controlContext('private context');
      await writeRecords([
        {
          ...record('u1', null, context),
          systemPayload: { displayText: context },
        },
        sub('u2', 'u1', context, 'cron', { displayText: context }),
      ] as ChatRecord[]);
      expect((await turnIndex()).turns).toEqual([]);
    });

    it('omits generated attachment tokens without display metadata', async () => {
      const token = '@attachment:///file-1';
      await writeRecords([
        {
          ...record('u1', null, token),
          systemPayload: {
            attachmentReferences: [
              {
                type: 'resource',
                attachmentId: 'file-1',
                mimeType: 'text/plain',
                size: 10,
              },
            ],
          },
        } as ChatRecord,
      ]);
      const page = await turnIndex();
      expect(page.turns).toEqual([
        expect.objectContaining({ turnId: 'u1', label: 'Prompt' }),
      ]);
      expect(JSON.stringify(page.turns)).not.toContain(token);
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
