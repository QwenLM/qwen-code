/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Content } from '@google/genai';
import {
  appendPermissionContext,
  getPermissionContextSnapshot,
} from '../core/permission-context.js';

const {
  mockDebugLogger,
  mockAddDaemonRequestAttribute,
  statFault,
  projectionReads,
} = vi.hoisted(() => ({
  mockDebugLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  mockAddDaemonRequestAttribute: vi.fn(),
  statFault: {
    zeroInode: false,
    failNextWith: null as null | string,
    pauseNext: null as null | Promise<void>,
    pathCalls: new Map<string, number>(),
    failOnCall: null as null | { path: string; call: number; code: string },
    beforeCall: null as null | {
      path: string;
      call: number;
      action: () => Promise<void>;
    },
  },
  projectionReads: {
    count: 0,
    pause: null as null | Promise<void>,
    titleInfo: null as null | { title?: string; source?: 'auto' | 'manual' },
  },
}));

vi.mock(
  '../managed-runtime/managed-session-message-projection.js',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('../managed-runtime/managed-session-message-projection.js')
      >();
    return {
      ...actual,
      readManagedSessionRecordsAndTitle: async (
        options: Parameters<typeof actual.readManagedSessionRecordsAndTitle>[0],
      ) => {
        projectionReads.count++;
        if (projectionReads.pause) {
          const pause = projectionReads.pause;
          projectionReads.pause = null;
          await pause;
        }
        const result = await actual.readManagedSessionRecordsAndTitle(options);
        return projectionReads.titleInfo
          ? { ...result, titleInfo: projectionReads.titleInfo }
          : result;
      },
    };
  },
);

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
      const target = String(args[0]);
      const calls = (statFault.pathCalls.get(target) ?? 0) + 1;
      statFault.pathCalls.set(target, calls);
      if (
        statFault.beforeCall &&
        statFault.beforeCall.path === target &&
        statFault.beforeCall.call === calls
      ) {
        const { action } = statFault.beforeCall;
        statFault.beforeCall = null;
        await action();
      }
      if (statFault.pauseNext) {
        const pause = statFault.pauseNext;
        statFault.pauseNext = null;
        await pause;
      }
      if (statFault.failNextWith) {
        const code = statFault.failNextWith;
        statFault.failNextWith = null;
        const error = new Error(
          `injected stat failure ${code}`,
        ) as NodeJS.ErrnoException;
        error.code = code;
        throw error;
      }
      if (
        statFault.failOnCall &&
        statFault.failOnCall.path === target &&
        statFault.failOnCall.call === calls
      ) {
        const code = statFault.failOnCall.code;
        statFault.failOnCall = null;
        const error = new Error(
          `injected stat failure ${code}`,
        ) as NodeJS.ErrnoException;
        error.code = code;
        throw error;
      }
      const result = await actual.stat(...args);
      if (statFault.zeroInode) {
        Object.defineProperty(result, 'ino', { value: 0 });
      }
      return result;
    },
  };
});

import {
  appendAutoMemorySnapshot,
  getAutoMemorySnapshot,
} from '../memory/request-context.js';
import { Storage } from '../config/storage.js';
import { localManagedSessionKey } from '../utils/sessionStorageUtils.js';
import { LocalJsonlManagedSessionJournalStore } from '../managed-runtime/local-jsonl-managed-session-journal-store.js';
import {
  LocalManagedSessionAuthority,
  readManagedSessionLog,
} from '../managed-runtime/managed-session-authority.js';
import { LocalManagedSessionResourceStore } from '../managed-runtime/managed-session-resources.js';
import {
  assertManagedSessionDurableRef,
  managedSessionReaderFacingBody,
} from '../managed-runtime/managed-session-records.js';
import { ManagedSessionMessageProjection } from '../managed-runtime/managed-session-message-projection.js';
import type { Config } from '../config/config.js';
import { CompressionStatus } from '../core/turn.js';
import { detectTurnInterruption } from '../core/turn-interruption.js';
import {
  isApiHistoryDirectoryContext,
  markApiHistoryDirectoryContext,
} from '../utils/api-history-metadata.js';
import {
  SessionSourceService,
  type SessionSourcesSnapshot,
} from './session-sources.js';
import {
  ChatRecordingService,
  type ChatRecord,
} from './chatRecordingService.js';
import {
  buildSessionHistoryFromConversation,
  getApiHistoryPromptId,
} from './session-api-history.js';
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
  getSessionTranscriptBuildSemaphoreStatsForTest,
  getSessionTranscriptIndexCacheStatsForTest,
  InvalidSessionTranscriptCursorError,
  InvalidSessionTranscriptTurnAnchorError,
  isReplayTurnStartType,
  SESSION_TRANSCRIPT_MAX_ALL_REPLAY_BYTES,
  SESSION_TRANSCRIPT_MAX_INDEX_BYTES,
  SESSION_TRANSCRIPT_MAX_INDEX_ESTIMATE_BYTES,
  SESSION_TRANSCRIPT_MAX_LINE_BYTES,
  SESSION_TRANSCRIPT_MAX_LIMIT,
  resetSessionTranscriptIndexCacheForTest,
  setSessionTranscriptAvailableHeapBudgetForTest,
  setSessionTranscriptCooperativeReadBudgetForTest,
  setSessionTranscriptExpandedPageBytesForTest,
  setSessionTranscriptMaxAllReplayBytesForTest,
  setSessionTranscriptMaxConcurrentBuildsForTest,
  setSessionTranscriptMaxIndexEstimateBytesForTest,
  setSessionTranscriptMaxLineBytesForTest,
  setSessionTranscriptIndexBuildCompleteHookForTest,
  setSessionTranscriptIndexBuildModeHookForTest,
  setSessionTranscriptIndexCacheMaxBytesForTest,
  setSessionTranscriptIndexCacheOversizedMaxBytesForTest,
  setSessionTranscriptPromptTimeScanModeHookForTest,
  setSessionTranscriptSelectedLineReadHookForTest,
  SessionTranscriptCursorCodec,
  SessionTranscriptPageTooLargeError,
  SessionTranscriptSnapshotUnavailableError,
  SessionTranscriptTooLargeError,
  SessionTranscriptReader,
  type PromptTimeScanModeEvent,
  type SelectiveSessionRestoreOptions,
  type SessionTranscriptCursorState,
  type SessionTranscriptReadPageOptions,
  type SessionTranscriptRecordPage,
  type TranscriptIndexBuildModeEvent,
} from './session-transcript-reader.js';
import { sessionPromptTimeSidecarPath } from './session-prompt-time-sidecar.js';
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
    statFault.failNextWith = null;
    statFault.pauseNext = null;
    statFault.pathCalls.clear();
    statFault.failOnCall = null;
    statFault.beforeCall = null;
    projectionReads.pause = null;
    projectionReads.titleInfo = null;
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

  async function writeLargeTranscript(sizeBytes: number): Promise<{
    filePath: string;
    recordCount: number;
  }> {
    const lines: ChatRecord[] = [];
    let parent: string | null = null;
    let writtenBytes = 0;
    for (let i = 0; writtenBytes < sizeBytes; i++) {
      const uuid = `oversized-${i}`;
      const current = record(uuid, parent, 'x'.repeat(96 * 1024));
      lines.push(current);
      writtenBytes += Buffer.byteLength(JSON.stringify(current)) + 1;
      parent = uuid;
    }
    return {
      filePath: await writeRecords(lines),
      recordCount: lines.length,
    };
  }

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

  /** A Managed log with these records committed; the caller closes the authority. */
  async function openManagedFixture(
    texts: Array<{ uuid: string; parent: string | null; text: string }>,
  ) {
    const file = await writeRawTranscript('');
    const sessionKey = localManagedSessionKey(workspaceDir, sessionId);
    const store = LocalManagedSessionResourceStore.create({
      runtimeBaseDir: runtimeDir,
      sessionKey,
    });
    const lease = await LocalManagedSessionAuthority.acquireWriter({
      runtimeBaseDir: runtimeDir,
      sessionId,
      transcriptPath: file,
    });
    const reference = {
      resourceId: 'test-ref',
      kind: 'test',
      schemaVersion: 1,
      byteLength: 4,
      digest: 'e'.repeat(64),
    };
    const authority = await LocalManagedSessionAuthority.open({
      journal: LocalJsonlManagedSessionJournalStore.fromLease(
        lease,
        sessionKey,
      ),
      sessionKey,
      cwd: workspaceDir,
      version: 'test',
      resources: store,
      create: {
        definitionRef: reference,
        rootSnapshotRef: reference,
        createdBy: 'daemon',
      },
    });
    const projection = new ManagedSessionMessageProjection(authority, store);
    const commit = (uuid: string, parent: string | null, text: string) =>
      projection.commit(
        {
          operation: 'commitMessage',
          commandId: uuid,
          sessionKey,
          contentDigest: 'e'.repeat(64),
        },
        { record: record(uuid, parent, text) },
        { class: 'trusted_entry' },
      );
    for (const item of texts) await commit(item.uuid, item.parent, item.text);
    return { file, authority, commit, store, sessionKey };
  }

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
      expect(
        custom?.runtime.apiHistory.map(({ role, parts }) => ({ role, parts })),
      ).toEqual([answer.message, user.message]);
      expect(custom?.runtime.apiHistory.map(getApiHistoryPromptId)).toEqual([
        undefined,
        'legacy-record:u1',
      ]);
      expect(detectTurnInterruption(custom!.runtime.apiHistory).kind).toBe(
        'interrupted_prompt',
      );
    },
  );

  describe('last user prompt timestamp', () => {
    it('uses the effective main branch and ignores later non-user activity', async () => {
      const [u1, a1, u2, a2] = chain(...TWO_TURNS);
      const inactive = record('u-inactive', a1.uuid, 'discarded branch');
      const notification = {
        ...record('u-notice', a2.uuid, 'notice'),
        subtype: 'notification',
        provenance: 'system',
      } as ChatRecord;
      const cron = {
        ...record('u-cron', notification.uuid, 'cron'),
        subtype: 'cron',
      } as ChatRecord;
      const goal = {
        ...record('u-goal', cron.uuid, 'goal'),
        provenance: 'goal_runtime',
      } as ChatRecord;
      await writeRecords([u1, a1, u2, inactive, a2, notification, cron, goal]);
      expect(
        await new SessionTranscriptReader(workspaceDir).getLastUserPromptAt(
          sessionId,
        ),
      ).toBe(u2.timestamp);
    });

    it('includes attachment-only, realtime and persisted human mid-turn input', async () => {
      const u1 = record('u1', null, '');
      u1.message = {
        role: 'user',
        parts: [{ inlineData: { mimeType: 'image/png', data: 'AA==' } }],
      };
      const reader = new SessionTranscriptReader(workspaceDir);
      const file = await writeRecords([u1]);
      expect(await reader.getLastUserPromptAt(sessionId)).toBe(u1.timestamp);
      const realtime = {
        ...record('u-voice', u1.uuid, 'voice'),
        subtype: 'realtime_message',
      } as ChatRecord;
      await appendRecords(file, realtime);
      resetSessionTranscriptIndexCacheForTest();
      expect(await reader.getLastUserPromptAt(sessionId)).toBe(
        realtime.timestamp,
      );
      const midTurn = {
        ...record('u-mid', realtime.uuid, 'human follow-up'),
        subtype: 'mid_turn_user_message',
      } as ChatRecord;
      await appendRecords(file, midTurn);
      resetSessionTranscriptIndexCacheForTest();
      expect(await reader.getLastUserPromptAt(sessionId)).toBe(
        midTurn.timestamp,
      );
    });

    it('includes human agent mentions but excludes messages from external agents', async () => {
      const humanMention = {
        ...record('u-human-mention', null, 'question for the agent'),
        subtype: 'agent_mention',
      } as ChatRecord;
      const externalMention = {
        ...record('u-external-mention', humanMention.uuid, 'agent message'),
        subtype: 'agent_mention',
        provenance: 'external_agent',
      } as ChatRecord;
      await writeRecords([humanMention, externalMention]);
      expect(
        await new SessionTranscriptReader(workspaceDir).getLastUserPromptAt(
          sessionId,
        ),
      ).toBe(humanMention.timestamp);
    });

    it('omits inherited, sidechain, attributed-agent and invalid questions without a fallback', async () => {
      const inheritedQuestion = inherited(
        record('u1', null, 'parent question'),
      );
      const sidechain = {
        ...record('u-side', inheritedQuestion.uuid, 'side'),
        isSidechain: true,
      };
      const agent = {
        ...record('u-agent', sidechain.uuid, 'agent'),
        agentId: 'worker',
      };
      const invalid = {
        ...record('u-invalid', agent.uuid, 'bad clock'),
        timestamp: 'invalid',
      };
      await writeRecords([inheritedQuestion, sidechain, agent, invalid]);
      expect(
        await new SessionTranscriptReader(workspaceDir).getLastUserPromptAt(
          sessionId,
        ),
      ).toBeUndefined();
    });

    it('accepts legacy questions and preserves valid future source timestamps', async () => {
      const legacy = {
        ...record('u1', null, 'legacy'),
        provenance: undefined,
        timestamp: '2099-01-01T00:00:00.000Z',
      };
      await writeRecords([legacy]);
      expect(
        await new SessionTranscriptReader(workspaceDir).getLastUserPromptAt(
          sessionId,
        ),
      ).toBe(legacy.timestamp);
    });

    it('retains a full question index beyond 512 rows and reads warm scalars without filesystem work', async () => {
      const first = record('u1', null, 'first');
      const file = await writeRecords([first]);
      const reader = new SessionTranscriptReader(workspaceDir);
      expect(await reader.getLastUserPromptAt(sessionId)).toBe(first.timestamp);
      const stat = await fs.stat(file);
      const statSpy = vi.spyOn(fs, 'stat').mockResolvedValue(stat);
      for (let i = 0; i < 600; i++)
        await reader.setLastUserPromptAt(
          `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
          first.timestamp,
        );
      statSpy.mockClear();
      expect(
        await reader.getLastUserPromptAt(sessionId, 'active', {
          preferCache: true,
        }),
      ).toBe(first.timestamp);
      for (let i = 0; i < 600; i++)
        expect(
          await reader.getLastUserPromptAt(
            `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
            'active',
            {
              preferCache: true,
            },
          ),
        ).toBe(first.timestamp);
      expect(statSpy).not.toHaveBeenCalled();
      statSpy.mockRestore();
      const next = record('u2', first.uuid, 'new question');
      await appendRecords(file, next);
      await reader.setLastUserPromptAt(sessionId, next.timestamp);
      expect(
        await reader.getLastUserPromptAt(sessionId, 'active', {
          preferCache: true,
        }),
      ).toBe(next.timestamp);
    });

    it('keeps a notified question when scope eviction overlaps cold initialization', async () => {
      const first = record('u1', null, 'first');
      const next = record('u2', first.uuid, 'new question');
      const file = await writeRecords([first]);
      const reader = newReader();
      setSessionTranscriptIndexBuildCompleteHookForTest(async (builtPath) => {
        if (builtPath !== file) return;
        setSessionTranscriptIndexBuildCompleteHookForTest(() => {});
        for (let i = 0; i < 64; i++) {
          await new SessionTranscriptReader(
            path.join(runtimeDir, `other-${i}`),
            undefined,
            runtimeDir,
          )
            .getLastUserPromptAt(sessionId)
            .catch(() => undefined);
        }
        await appendRecords(file, next);
        await reader.setLastUserPromptAt(sessionId, next.timestamp);
      });
      expect(await reader.getLastUserPromptAt(sessionId)).toBe(next.timestamp);
    });

    it('refreshes archived metadata after unarchive, another question and rearchive', async () => {
      const first = record('u1', null, 'first');
      const next = record('u2', first.uuid, 'new question');
      const file = await writeRecords([first]);
      const service = svc();
      const reader = newReader();
      expect((await service.archiveSessions([sessionId])).errors).toEqual([]);
      expect(
        await reader.getLastUserPromptAt(sessionId, 'archived', {
          preferCache: true,
        }),
      ).toBe(first.timestamp);
      expect((await service.unarchiveSessions([sessionId])).errors).toEqual([]);
      await appendRecords(file, next);
      await service.setLastUserPromptAt(sessionId, next.timestamp);
      expect((await service.archiveSessions([sessionId])).errors).toEqual([]);
      expect(
        await reader.getLastUserPromptAt(sessionId, 'archived', {
          preferCache: true,
        }),
      ).toBe(next.timestamp);
      expect((await service.removeSessions([sessionId])).errors).toEqual([]);
      await writeRecords([first]);
      expect(
        await reader.getLastUserPromptAt(sessionId, 'active', {
          preferCache: true,
        }),
      ).toBe(first.timestamp);
    });

    it('keeps hot metadata across assistant appends and updates persisted human input without scanning', async () => {
      const first = record('u1', null, 'first');
      const file = await writeRecords([first]);
      const reader = new SessionTranscriptReader(workspaceDir);
      const builds = countBuilds(file);
      expect(await reader.getLastUserPromptAt(sessionId)).toBe(first.timestamp);
      clearSessionTranscriptIndexCacheEntriesForTest();
      expect(await reader.getLastUserPromptAt(sessionId)).toBe(first.timestamp);
      expect(builds.count).toBe(1);
      const assistant = record('a1', first.uuid, 'assistant output');
      assistant.type = 'assistant';
      await appendRecords(file, assistant);
      expect(await reader.getLastUserPromptAt(sessionId)).toBe(first.timestamp);
      expect(builds.count).toBe(1);
      const next = record('u2', assistant.uuid, 'second');
      await appendRecords(file, next);
      await reader.setLastUserPromptAt(sessionId, next.timestamp);
      expect(await reader.getLastUserPromptAt(sessionId)).toBe(next.timestamp);
      expect(builds.count).toBe(1);
      await reader.setLastUserPromptAt(sessionId, undefined);
      expect(await reader.getLastUserPromptAt(sessionId)).toBe(next.timestamp);
      expect(builds.count).toBe(2);
    });

    it('keeps a newer notified question when cold initialization completes later', async () => {
      const first = record('u1', null, 'first');
      const next = record('u2', first.uuid, 'new persisted question');
      const file = await writeRecords([first]);
      const reader = new SessionTranscriptReader(workspaceDir);
      setSessionTranscriptIndexBuildCompleteHookForTest(async () => {
        setSessionTranscriptIndexBuildCompleteHookForTest(() => {});
        await appendRecords(file, next);
        await reader.setLastUserPromptAt(sessionId, next.timestamp);
      });
      expect(await reader.getLastUserPromptAt(sessionId)).toBe(next.timestamp);
      expect(await reader.getLastUserPromptAt(sessionId)).toBe(next.timestamp);
    });

    it('recovers instead of retaining an old time after a notified update fails', async () => {
      const first = record('u1', null, 'first');
      const next = record('u2', first.uuid, 'persisted next question');
      const file = await writeRecords([first]);
      const reader = new SessionTranscriptReader(workspaceDir);
      const builds = countBuilds(file);
      expect(await reader.getLastUserPromptAt(sessionId)).toBe(first.timestamp);
      await appendRecords(file, next);
      const stat = vi
        .spyOn(fs, 'stat')
        .mockRejectedValueOnce(
          Object.assign(new Error('too many open files'), { code: 'EMFILE' }),
        );
      await expect(
        reader.setLastUserPromptAt(sessionId, next.timestamp),
      ).rejects.toThrow('too many open files');
      stat.mockRestore();
      expect(await reader.getLastUserPromptAt(sessionId)).toBe(next.timestamp);
      expect(builds.count).toBe(2);
    });

    it('holds a warm page larger than the dense index cache and shares concurrent reads', async () => {
      const reader = new SessionTranscriptReader(workspaceDir);
      const ids = Array.from(
        { length: 100 },
        (_, index) =>
          `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      );
      for (const id of ids)
        await writeRecords([record('u1', null, 'history', id)], id);
      let builds = 0;
      setSessionTranscriptIndexBuildCompleteHookForTest(() => {
        builds++;
      });
      await Promise.all([
        reader.getLastUserPromptAt(ids[0]!),
        reader.getLastUserPromptAt(ids[0]!),
      ]);
      expect(builds).toBe(1);
      for (const id of ids) await reader.getLastUserPromptAt(id);
      expect(builds).toBe(100);
      for (const id of ids) await reader.getLastUserPromptAt(id);
      expect(builds).toBe(100);
    });

    it('omits changed snapshots with unverifiable identity without rescanning', async () => {
      statFault.zeroInode = true;
      const first = record('u1', null, 'first');
      const file = await writeRecords([first]);
      const reader = new SessionTranscriptReader(workspaceDir);
      const builds = countBuilds(file);
      expect(await reader.getLastUserPromptAt(sessionId)).toBe(first.timestamp);
      const replacement = record('u2', null, 'a longer replacement question');
      await fs.rename(file, `${file}.old`);
      await writeRecords([replacement]);
      expect(await reader.getLastUserPromptAt(sessionId)).toBeUndefined();
      expect(builds.count).toBe(1);
      await reader.setLastUserPromptAt(sessionId, replacement.timestamp);
      expect(await reader.getLastUserPromptAt(sessionId)).toBe(
        replacement.timestamp,
      );
      expect(builds.count).toBe(1);
    });

    it('keeps active and archived histories separate', async () => {
      const active = record('u1', null, 'active');
      const file = await writeRecords([active]);
      const archive = path.join(path.dirname(file), 'archive');
      await fs.mkdir(archive);
      const archived = record('u-archive', null, 'archived');
      await fs.writeFile(
        path.join(archive, `${sessionId}.jsonl`),
        jsonLine(archived),
      );
      const reader = new SessionTranscriptReader(workspaceDir);
      expect(await reader.getLastUserPromptAt(sessionId)).toBe(
        active.timestamp,
      );
      expect(await reader.getLastUserPromptAt(sessionId, 'archived')).toBe(
        archived.timestamp,
      );
    });

    it('rejects numeric and invalid-calendar timestamps instead of normalizing them', async () => {
      const file = await writeRecords([
        {
          ...record('u1', null, 'invalid day'),
          timestamp: '2026-02-30T00:00:00.000Z',
        },
      ]);
      const reader = new SessionTranscriptReader(workspaceDir);
      expect(await reader.getLastUserPromptAt(sessionId)).toBeUndefined();
      await fs.writeFile(
        file,
        jsonLine({ ...record('u2', null, 'numeric'), timestamp: '123' }),
      );
      expect(await reader.getLastUserPromptAt(sessionId)).toBeUndefined();
      // The previous read warmed the cache; without a reset the longer payload
      // would be served from that cached undefined without parsing.
      resetSessionTranscriptIndexCacheForTest();
      await writeRawTranscript(
        jsonLine({ ...record('u3', null, 'numeric value'), timestamp: 123 }),
      );
      const builds = countBuilds(file);
      expect(await reader.getLastUserPromptAt(sessionId)).toBeUndefined();
      expect(builds.count).toBe(1);
    });

    it('serves a frozen prefix while appending and rejects replacement during the read', async () => {
      const first = record('u1', null, 'first');
      const file = await writeRecords([first]);
      const next = record('u2', first.uuid, 'next');
      setSessionTranscriptIndexBuildCompleteHookForTest(async () => {
        setSessionTranscriptIndexBuildCompleteHookForTest(() => {});
        await appendRecords(file, next);
      });
      const reader = new SessionTranscriptReader(workspaceDir);
      expect(await reader.getLastUserPromptAt(sessionId)).toBe(first.timestamp);
      await reader.setLastUserPromptAt(sessionId, next.timestamp);
      expect(await reader.getLastUserPromptAt(sessionId)).toBe(next.timestamp);
      resetSessionTranscriptIndexCacheForTest();
      setSessionTranscriptIndexBuildCompleteHookForTest(async () => {
        setSessionTranscriptIndexBuildCompleteHookForTest(() => {});
        await fs.rename(file, `${file}.old`);
        await fs.writeFile(file, jsonLine(first));
      });
      await expect(
        reader.getLastUserPromptAt(sessionId),
      ).rejects.toBeInstanceOf(Unavailable);
    });

    it('applies service project ownership before exposing a timestamp', async () => {
      await writeRecords([
        {
          ...record('u1', null, 'foreign'),
          cwd: path.join(runtimeDir, 'foreign-workspace'),
        },
      ]);
      expect(
        await new SessionService(workspaceDir).getLastUserPromptAt(sessionId),
      ).toBeUndefined();
    });

    it('rejects a cached foreign snapshot on the warm service read without scanning', async () => {
      const foreign = {
        ...record('u1', null, 'foreign'),
        cwd: path.join(runtimeDir, 'foreign-workspace'),
      };
      const file = await writeRecords([foreign]);
      const builds = countBuilds(file);
      expect(
        await new SessionTranscriptReader(workspaceDir).getLastUserPromptAt(
          sessionId,
        ),
      ).toBe(foreign.timestamp);
      expect(builds.count).toBe(1);

      const stat = vi.spyOn(fs, 'stat');
      expect(
        await new SessionService(workspaceDir).getLastUserPromptAt(
          sessionId,
          'active',
          { preferCache: true },
        ),
      ).toBeUndefined();
      expect(stat).not.toHaveBeenCalled();
      expect(builds.count).toBe(1);
    });

    it.each([false, true])(
      'binds ownership to the timestamp snapshot after a path replacement (warm cache: %s)',
      async (warmCache) => {
        const owned = record('u-owned', null, 'owned question');
        const foreign = {
          ...record('u-foreign', null, 'foreign question'),
          cwd: path.join(runtimeDir, 'foreign-workspace'),
        };
        const file = await writeRecords([foreign]);
        const builds = countBuilds(file);
        if (warmCache) {
          expect(
            await new SessionTranscriptReader(workspaceDir).getLastUserPromptAt(
              sessionId,
            ),
          ).toBe(foreign.timestamp);
        }
        await fs.rename(file, `${file}.foreign`);
        await writeRecords([owned]);
        const original = SessionTranscriptReader.prototype.getLastUserPromptAt;
        const read = vi
          .spyOn(SessionTranscriptReader.prototype, 'getLastUserPromptAt')
          .mockImplementationOnce(async function (
            this: SessionTranscriptReader,
            ...args: Parameters<SessionTranscriptReader['getLastUserPromptAt']>
          ) {
            await fs.rename(file, `${file}.owned`);
            await fs.rename(`${file}.foreign`, file);
            return original.apply(this, args);
          });
        try {
          expect(
            await new SessionService(workspaceDir).getLastUserPromptAt(
              sessionId,
            ),
          ).toBeUndefined();
          expect(builds.count).toBe(1);
        } finally {
          read.mockRestore();
        }
      },
    );

    it('omits unavailable metadata above the canonical index limit without scanning', async () => {
      const file = await writeRecords([record('u1', null, 'large history')]);
      await fs.truncate(file, SESSION_TRANSCRIPT_MAX_INDEX_BYTES + 1);
      const builds = countBuilds(file);
      expect(
        await new SessionTranscriptReader(workspaceDir).getLastUserPromptAt(
          sessionId,
        ),
      ).toBeUndefined();
      expect(builds.count).toBe(0);
    });

    it('projects only committed Managed questions', async () => {
      const file = await writeRawTranscript('');
      const sessionKey = localManagedSessionKey(workspaceDir, sessionId);
      const store = LocalManagedSessionResourceStore.create({
        runtimeBaseDir: runtimeDir,
        sessionKey,
      });
      const lease = await LocalManagedSessionAuthority.acquireWriter({
        runtimeBaseDir: runtimeDir,
        sessionId,
        transcriptPath: file,
      });
      const reference = {
        resourceId: 'test-ref',
        kind: 'test',
        schemaVersion: 1,
        byteLength: 4,
        digest: 'e'.repeat(64),
      };
      const authority = await LocalManagedSessionAuthority.open({
        journal: LocalJsonlManagedSessionJournalStore.fromLease(
          lease,
          sessionKey,
        ),
        sessionKey,
        cwd: workspaceDir,
        version: 'test',
        resources: store,
        create: {
          definitionRef: reference,
          rootSnapshotRef: reference,
          createdBy: 'daemon',
        },
      });
      const projection = new ManagedSessionMessageProjection(authority, store);
      const first = record('u1', null, 'committed');
      const last = record('u2', first.uuid, 'not committed in snapshot');
      try {
        for (const item of [first, last])
          await projection.commit(
            {
              operation: 'commitMessage',
              commandId: item.uuid,
              sessionKey,
              contentDigest: 'e'.repeat(64),
            },
            { record: item },
            { class: 'trusted_entry' },
          );
      } finally {
        await authority.close();
      }
      const lines = (await fs.readFile(file, 'utf8')).trimEnd().split('\n');
      expect(JSON.parse(lines.at(-1)!).subtype).toBe(
        'managed_session_commit_v1',
      );
      await fs.writeFile(file, lines.slice(0, -1).join('\n') + '\n');
      const reader = new SessionTranscriptReader(workspaceDir);
      expect(await reader.getLastUserPromptAt(sessionId)).toBe(first.timestamp);
      expect(
        await reader.readTurnHooksPage(sessionId, 'legacy-record:u1'),
      ).toMatchObject({
        coverage: 'unsupported',
        summary: null,
        totalExecutions: 0,
        executions: [],
      });
      const archive = path.join(path.dirname(file), 'archive');
      await fs.mkdir(archive);
      await fs.copyFile(file, path.join(archive, `${sessionId}.jsonl`));
      expect(await reader.getLastUserPromptAt(sessionId, 'archived')).toBe(
        first.timestamp,
      );
    });
  });

  it.each(['user', 'mid-turn'] as const)(
    'keeps directory context non-interrupting after saving and reloading a checkpoint (%s)',
    async (inputKind) => {
      const config = {
        storage: new Storage(workspaceDir),
        getSessionId: () => sessionId,
        getProjectRoot: () => workspaceDir,
        getCliVersion: () => 'test',
        getModel: () => 'test',
        getAuthType: () => undefined,
        getApprovalMode: () => ApprovalMode.DEFAULT,
        getResumedSessionData: () => undefined,
      } as unknown as Config;
      const recorder = new ChatRecordingService(config, undefined, false);
      const history = [
        userText('review'),
        modelText('done'),
        markApiHistoryDirectoryContext(userText('Directory changed.')),
        markApiHistoryDirectoryContext(userText('Directory structure.')),
      ];
      const wireHistory = JSON.parse(JSON.stringify(history));
      recorder.recordChatCompression({
        info: {
          compressionStatus: CompressionStatus.COMPRESSED,
          originalTokenCount: 100,
          newTokenCount: 50,
        },
        compressedHistory: history,
      });
      await recorder.flush();

      const service = svc();
      const loaded = await service.loadSession(sessionId);
      const checkpoint = loaded!.conversation.messages.find(
        (entry) => entry.subtype === 'chat_compression',
      );
      expect(checkpoint?.systemPayload).toMatchObject({
        compressedHistory: wireHistory,
        directoryContextIndices: [2, 3],
      });
      const projection = await service.readRestoreProjection(sessionId, NONE);
      const restored = buildSessionHistoryFromConversation(
        loaded!.conversation,
      );
      for (const apiHistory of [
        restored.apiHistory,
        projection!.runtime.apiHistory,
      ]) {
        expect(JSON.stringify(apiHistory)).toBe(JSON.stringify(wireHistory));
        expect(apiHistory.map(isApiHistoryDirectoryContext)).toEqual([
          false,
          false,
          true,
          true,
        ]);
        expect(detectTurnInterruption(apiHistory).kind).toBe('none');
      }

      if (inputKind === 'user') {
        recorder.recordUserMessage([{ text: 'Unanswered real input' }]);
      } else {
        recorder.recordMidTurnUserMessage(
          [{ text: 'Unanswered real input' }],
          'Unanswered real input',
        );
      }
      await recorder.flush();
      const next = await service.readRestoreProjection(sessionId, NONE);
      expect(detectTurnInterruption(next!.runtime.apiHistory)).toMatchObject({
        kind: 'interrupted_prompt',
        parts: expect.arrayContaining([{ text: 'Unanswered real input' }]),
      });
    },
  );

  it.each(['memory', 'permissions', 'combined'] as const)(
    'round-trips %s snapshot positions and markers through recording and compression',
    async (kind) => {
      const config = {
        storage: new Storage(workspaceDir),
        getSessionId: () => sessionId,
        getProjectRoot: () => workspaceDir,
        getCliVersion: () => 'test',
        getModel: () => 'test',
        getAuthType: () => undefined,
        getApprovalMode: () => ApprovalMode.DEFAULT,
        getResumedSessionData: () => undefined,
      } as unknown as Config;
      const recorder = new ChatRecordingService(config, undefined, false);
      const getSnapshot =
        kind === 'memory'
          ? getAutoMemorySnapshot
          : (contents: Content[], value: string) =>
              getPermissionContextSnapshot(
                contents,
                value === 'catalog B'
                  ? ApprovalMode.AUTO
                  : ApprovalMode.DEFAULT,
              );
      const appendSnapshot =
        kind === 'memory' ? appendAutoMemorySnapshot : appendPermissionContext;
      const recordSnapshot =
        kind === 'memory'
          ? recorder.recordMemoryCatalogSnapshot.bind(recorder)
          : recorder.recordPermissionContextSnapshot.bind(recorder);
      const snapshot = getSnapshot([], 'catalog A')!;
      const user = userText(snapshot.text!);
      user.parts![0].partMetadata = { source: 'quoted-user-text' };
      const history = [user];
      recorder.recordUserMessage(user.parts!);
      appendSnapshot(history, snapshot);
      recordSnapshot(snapshot);
      if (kind === 'combined') {
        const memory = getAutoMemorySnapshot(history, 'catalog')!;
        appendAutoMemorySnapshot(history, memory);
        recorder.recordMemoryCatalogSnapshot(memory);
      }
      // Retry records the snapshot again without another user record.
      recordSnapshot(snapshot);
      recorder.recordAssistantTurn({
        model: 'test',
        message: [{ text: 'answer' }],
      });
      history.push(modelText('answer'));
      await recorder.flush();
      const service = svc();
      const assertRestore = async () => {
        const loaded = await service.loadSession(sessionId);
        const restored = buildApiHistoryFromConversation(loaded!.conversation);
        expect(restored.map(({ role, parts }) => ({ role, parts }))).toEqual(
          history,
        );
        expect(
          (
            await service.readRestoreProjection(sessionId, NONE)
          )?.runtime.apiHistory.map(({ role, parts }) => ({ role, parts })),
        ).toEqual(history);
        expect(getSnapshot(restored, 'catalog A')).toBeUndefined();
        const userRecords = loaded!.conversation.messages.filter(
          (record) => record.type === 'user',
        );
        expect(userRecords).toHaveLength(1);
        expect(userRecords[0].message).toEqual(user);
      };
      await assertRestore();
      for (const catalog of ['catalog B', 'catalog A']) {
        const changed = getSnapshot(history, catalog)!;
        appendSnapshot(history, changed);
        recordSnapshot(changed);
      }
      await recorder.flush();
      await assertRestore();
      recorder.recordChatCompression({
        info: {
          originalTokenCount: 100,
          newTokenCount: 50,
          compressionStatus: CompressionStatus.COMPRESSED,
        },
        compressedHistory: history,
      });
      recordSnapshot(snapshot);
      await recorder.flush();
      await assertRestore();
      history.splice(0, history.length, userText('summary'), modelText('ack'));
      recorder.recordChatCompression({
        info: {
          originalTokenCount: 100,
          newTokenCount: 50,
          compressionStatus: CompressionStatus.COMPRESSED,
        },
        compressedHistory: history,
      });
      const reseeded = getSnapshot(history, 'catalog A')!;
      expect(reseeded).toEqual(snapshot);
      appendSnapshot(history, reseeded);
      recordSnapshot(reseeded);
      await recorder.flush();
      await assertRestore();
    },
  );

  it('round-trips a recorded Goal turn end through selective restore, fork, and rewind', async () => {
    const config = {
      storage: new Storage(workspaceDir),
      getSessionId: () => sessionId,
      getProjectRoot: () => workspaceDir,
      getCliVersion: () => 'test',
      getModel: () => 'test',
      getAuthType: () => undefined,
      getApprovalMode: () => ApprovalMode.DEFAULT,
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
        daemonPromptId: 'daemon-prompt-3',
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
      sys('request-start', 'telemetry', 'ui_telemetry', {
        uiEvent: {
          'event.name': 'request_lifecycle',
          v: 1,
          kind: 'request',
          phase: 'started',
          executionId: 'execution',
          sessionId,
          promptId: `${sessionId}########3`,
          model: 'model',
          startedAt: 10,
        },
      }),
      sys('tool-start', 'request-start', 'ui_telemetry', {
        uiEvent: {
          'event.name': 'tool_lifecycle',
          v: 1,
          kind: 'tool',
          phase: 'started',
          executionId: 'tool-execution',
          sessionId,
          callId: 'call',
          toolName: 'shell',
          startedAt: 12,
          executionStatus: 'running',
        },
      }),
      sys('attribution', 'tool-start', 'attribution_snapshot', {
        snapshot: attributionSnapshot,
      }),
      sys('files', 'attribution', 'file_history_snapshot', {
        snapshots: [
          {
            promptId: `${sessionId}########12`,
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
    expect(turnState.initialTurn).toBe(12);
    expect(runtime?.recording.turnParentUuids).toEqual(
      turnState.turnParentUuids,
    );
    expect(runtime?.recording.turnPromptIds).toEqual([`${sessionId}########3`]);
    expect(runtime?.recording.turnDaemonPromptIds).toEqual(['daemon-prompt-3']);
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

  it('skips lifecycle ui_telemetry records during selected-record reads', async () => {
    expect(SESSION_TRANSCRIPT_MAX_INDEX_BYTES).toBe(1024 * 1024 * 1024);

    const apiResponseEvent = {
      'event.name': 'qwen-code.api_response',
      'event.timestamp': T0,
      model: 'qwen3-coder',
      status_code: 200,
      duration_ms: 100,
      input_token_count: 10,
      output_token_count: 20,
      cached_content_token_count: 0,
      thoughts_token_count: 0,
      tool_token_count: 0,
      total_token_count: 30,
    };
    const requestLifecycle = sys('req-life', 'u1', 'ui_telemetry', {
      uiEvent: {
        'event.name': 'request_lifecycle',
        v: 1,
        kind: 'request',
        phase: 'started',
        executionId: 'exec-1',
        sessionId,
        promptId: `${sessionId}########1`,
        model: 'model',
        startedAt: 10,
      },
    });
    const toolLifecycle = sys('tool-life', 'req-life', 'ui_telemetry', {
      uiEvent: {
        'event.name': 'tool_lifecycle',
        v: 1,
        kind: 'tool',
        phase: 'started',
        executionId: 'tool-1',
        sessionId,
        callId: 'call-1',
        toolName: 'shell',
        startedAt: 12,
        executionStatus: 'running',
      },
    });
    const hookLifecycle = sys('hook-life', 'tool-life', 'ui_telemetry', {
      uiEvent: {
        'event.name': 'hook_lifecycle',
        v: 1,
        kind: 'hook',
        phase: 'started',
        executionId: 'hook-1',
        sessionId,
        startedAt: 13,
      },
    });
    const keptTelemetry = sys('kept-telemetry', 'hook-life', 'ui_telemetry', {
      uiEvent: apiResponseEvent,
    });
    const lines = [
      record('u1', null, 'hello'),
      requestLifecycle,
      toolLifecycle,
      hookLifecycle,
      keptTelemetry,
      record('a1', 'kept-telemetry', 'world'),
    ];
    const filePath = await writeRecords(lines);

    const fileContent = await fs.readFile(filePath, 'utf8');
    const offsetOf = (uuid: string) => {
      const idx = fileContent.indexOf(`"uuid":"${uuid}"`);
      expect(idx).toBeGreaterThan(-1);
      return fileContent.lastIndexOf('\n', idx) + 1;
    };
    const lifecycleOffsets = new Set([
      offsetOf('req-life'),
      offsetOf('tool-life'),
      offsetOf('hook-life'),
    ]);
    const keptTelemetryOffset = offsetOf('kept-telemetry');

    const readOffsets = new Set<number>();
    setSessionTranscriptSelectedLineReadHookForTest((offset) => {
      readOffsets.add(offset);
    });

    const projection = await newReader().readRestoreProjection(sessionId, {
      replay: { kind: 'none' },
    });

    expect(projection?.runtime.uiTelemetryEvents).toEqual([apiResponseEvent]);
    expect(readOffsets.has(keptTelemetryOffset)).toBe(true);
    for (const offset of lifecycleOffsets) {
      expect(readOffsets.has(offset)).toBe(false);
    }
  });

  it('opens a real transcript above the former 256 MiB limit', async () => {
    const { filePath } = await writeLargeTranscript(
      256 * 1024 * 1024 + 256 * 1024,
    );
    expect((await fs.stat(filePath)).size).toBeGreaterThan(256 * 1024 * 1024);

    const reader = newReader();
    const page = await reader.readPage(sessionId, { limit: 20 });
    expect(page.records).toHaveLength(20);
    const restore = await reader.readRestoreProjection(sessionId, {
      replay: { kind: 'recent', limit: 20, hideInheritedHistory: false },
    });
    expect(restore?.replay?.records.length).toBe(20);
    expect(restore?.replay?.hasMore).toBe(true);
    // Restore records are replay updates, not a one-to-one projection of
    // the twenty records in the page above. The last page converts tool
    // results and metadata into additional update records.
    expect(restore?.replay?.records.length).toBeGreaterThan(0);
  });

  it('replays more than 128 MiB when the caller asks for the unbounded default', async () => {
    const { filePath, recordCount } = await writeLargeTranscript(
      136 * 1024 * 1024,
    );
    expect((await fs.stat(filePath)).size).toBeGreaterThan(128 * 1024 * 1024);
    const restore = await newReader().readRestoreProjection(sessionId, {
      replay: { kind: 'all', hideInheritedHistory: false },
    });
    expect(restore?.replay?.records.length).toBe(recordCount);

    setSessionTranscriptMaxAllReplayBytesForTest(128 * 1024 * 1024);
    await expect(
      newReader().readRestoreProjection(sessionId, {
        replay: { kind: 'all', hideInheritedHistory: false },
      }),
    ).rejects.toThrow(SessionTranscriptTooLargeError);
  });

  it('rejects an oversized unterminated cross-chunk line before reaching the full-line guard', async () => {
    const filePath = await writeRecords([
      record('u1', null, 'hello'),
      record('a1', 'u1', 'z'.repeat(192 * 1024)),
    ]);
    await fs.truncate(filePath, (await fs.stat(filePath)).size - 1);
    setSessionTranscriptMaxLineBytesForTest(64 * 1024);

    let caught: unknown;
    try {
      await newReader().readPage(sessionId, { limit: 20 });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SessionTranscriptPageTooLargeError);
    const err = caught as SessionTranscriptPageTooLargeError;
    expect(err.pageBytes).toBeGreaterThan(64 * 1024);
    expect(err.pageBytes).toBeLessThan(128 * 1024);
  });

  it('rejects a dense transcript during streaming index build when the index estimate exceeds the build budget', async () => {
    expect(SESSION_TRANSCRIPT_MAX_INDEX_ESTIMATE_BYTES).toBe(512 * 1024 * 1024);

    const lines: ChatRecord[] = [];
    let parent: string | null = null;
    for (let i = 0; i < 40; i += 1) {
      const uuid = `dense-${i}`;
      lines.push(record(uuid, parent, `m${i}`));
      parent = uuid;
    }
    const filePath = await writeRecords(lines);
    const stat = await fs.stat(filePath);
    expect(stat.size).toBeLessThan(SESSION_TRANSCRIPT_MAX_INDEX_BYTES);

    // Reject inside the streaming pass, before all 40 records have been
    // scanned, rather than merely rejecting the completed index afterwards.
    setSessionTranscriptMaxIndexEstimateBytesForTest(12 * 1024);
    let scannedLines = 0;
    setSessionTranscriptCooperativeReadBudgetForTest(1, 0, () => {
      scannedLines += 1;
    });

    let caught: unknown;
    try {
      await newReader().readPage(sessionId, { limit: 10 });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SessionTranscriptTooLargeError);
    const err = caught as SessionTranscriptTooLargeError;
    expect(err.snapshotSize).toBe(stat.size);
    expect(err.maxBytes).toBe(12 * 1024);
    expect(err.dimension).toBe('index');
    expect(err.measuredBytes).toBeGreaterThan(12 * 1024);
    expect(scannedLines).toBeLessThan(lines.length);

    await expect(
      newReader().readRestoreProjection(sessionId, {
        replay: { kind: 'none' },
      }),
    ).rejects.toThrow(SessionTranscriptTooLargeError);
    expect(getSessionTranscriptIndexCacheStatsForTest().entries).toBe(0);
  });

  it('rejects a dense transcript without exhausting a constrained process heap', async () => {
    const readerUrl = pathToFileURL(
      path.resolve('dist/src/services/session-transcript-reader.js'),
    ).href;
    const { createWriteStream } = await import('node:fs');
    const runtime = await fs.mkdtemp(path.join(os.tmpdir(), 'heap-guard-'));
    try {
      const workspace = path.join(runtime, 'workspace');
      await fs.mkdir(workspace, { recursive: true });
      const denseSessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      const chats = path.join(
        runtime,
        'projects',
        workspace.replace(/[^a-zA-Z0-9]/g, '-'),
        'chats',
      );
      await fs.mkdir(chats, { recursive: true });
      const target = path.join(chats, denseSessionId + '.jsonl');
      const out = createWriteStream(target);
      let parent: string | null = null;
      const payload = 'dense-payload-' + 'x'.repeat(240);
      for (let i = 0; i < 260000; i++) {
        const uuid = 'dense-' + String(i).padStart(7, '0');
        const rec = {
          uuid,
          parentUuid: parent,
          sessionId: denseSessionId,
          timestamp: '2026-11-22T00:00:00.000Z',
          type: i % 2 === 0 ? 'user' : 'assistant',
          cwd: workspace,
          version: '0.28.3',
          message: {
            role: i % 2 === 0 ? 'user' : 'model',
            parts: [{ text: payload }],
          },
        };
        if (!out.write(JSON.stringify(rec) + '\n')) {
          await new Promise<void>((resolve) => out.once('drain', resolve));
        }
        parent = uuid;
      }
      await new Promise<void>((resolve, reject) =>
        out.end((error: Error | null) => (error ? reject(error) : resolve())),
      );
      const fileSize = (await fs.stat(target)).size;
      const probe = `
        import { SessionTranscriptReader } from ${JSON.stringify(readerUrl)};
        let memorySamples = 0;
        const readMemory = process.memoryUsage.bind(process);
        process.memoryUsage = () => { memorySamples += 1; return readMemory(); };
        try {
          await new SessionTranscriptReader(${JSON.stringify(workspace)}, undefined, ${JSON.stringify(runtime)}).readPage(${JSON.stringify(denseSessionId)}, { limit: 10 });
          console.log(JSON.stringify({ result: 'served' }));
        } catch (error) {
          console.log(JSON.stringify({ result: 'rejected', name: error.name, message: error.message, dimension: error.dimension, maxBytes: error.maxBytes, snapshotSize: error.snapshotSize, retryable: error.retryable, memorySamples }));
        }
      `;
      const cleanEnv = { ...process.env };
      for (const name of Object.keys(cleanEnv)) {
        if (name.startsWith('QWEN_')) delete cleanEnv[name];
      }
      delete cleanEnv['NODE_OPTIONS'];
      const child = spawnSync(
        process.execPath,
        ['--max-old-space-size=256', '--input-type=module', '-e', probe],
        { encoding: 'utf8', env: cleanEnv, maxBuffer: 2 * 1024 * 1024 },
      );
      if (child.status !== 0) {
        throw new Error(
          `Memory guard probe failed (${child.status}/${child.signal}): ${child.stderr}`,
        );
      }
      const outcome = JSON.parse(child.stdout.trim()) as {
        result: string;
        name?: string;
        dimension?: string;
        maxBytes?: number;
        snapshotSize?: number;
        retryable?: boolean;
        memorySamples?: number;
      };
      expect(outcome).toMatchObject({
        result: 'rejected',
        name: 'SessionTranscriptTooLargeError',
        dimension: 'index',
      });
      expect(outcome.maxBytes).toBeLessThan(512 * 1024 * 1024);
      expect(outcome.memorySamples).toBeGreaterThan(0);
      expect(outcome.memorySamples).toBeLessThan(260_000 / 10);
      expect(outcome.snapshotSize).toBe(fileSize);
    } finally {
      await fs.rm(runtime, { recursive: true, force: true });
    }
  });

  it('re-queries prompt time when the effective heap budget is available again', async () => {
    const records = longTurn(400, () => 'answer');
    await writeRecords(records);
    const expectedPromptTime = records[0]?.timestamp;
    setSessionTranscriptAvailableHeapBudgetForTest(64 * 1024);
    const reader = newReader();
    try {
      await expect(reader.getLastUserPromptAt(sessionId)).rejects.toMatchObject(
        {
          dimension: 'index',
          retryable: true,
        },
      );
    } finally {
      setSessionTranscriptAvailableHeapBudgetForTest(undefined);
    }

    expect(await reader.getLastUserPromptAt(sessionId)).toBe(
      expectedPromptTime,
    );
  });

  it('keeps structural estimate overflows terminal even when a heap budget cap is active', async () => {
    const oversizedUuid = 'u-' + 'a'.repeat(8 * 1024);
    await writeRecords([record(oversizedUuid, null, 'hello')]);
    setSessionTranscriptMaxIndexEstimateBytesForTest(8 * 1024);
    setSessionTranscriptAvailableHeapBudgetForTest(6 * 1024);
    try {
      let caught: unknown;
      try {
        await newReader().readPage(sessionId, { limit: 10 });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(SessionTranscriptTooLargeError);
      const err = caught as SessionTranscriptTooLargeError;
      expect(err.dimension).toBe('index');
      expect(err.measuredBytes).toBeGreaterThan(8 * 1024);
      expect(err.retryable).toBeUndefined();
    } finally {
      setSessionTranscriptMaxIndexEstimateBytesForTest(undefined);
      setSessionTranscriptAvailableHeapBudgetForTest(undefined);
    }
  });

  it('keeps final structural estimate overflows terminal even when a heap budget cap is active', async () => {
    const records: ChatRecord[] = [];
    let parent: string | null = null;
    for (let i = 0; i < 6; i += 1) {
      const uuid = `${i % 2 === 0 ? 'u' : 'a'}-final-${i}-` + 'b'.repeat(2048);
      records.push(record(uuid, parent, i % 2 === 0 ? 'prompt' : 'reply'));
      parent = uuid;
    }
    await writeRecords(records);
    // Freeze heapUsed so cold-heap noise cannot trip maxHeapGrowthBytes first;
    // loop structural estimate stays under 140 KiB, while final estimate adds
    // runtimeUuids/replayUuids/navigationTurns (~199 KiB) and crosses 150 KiB.
    const fixedUsage = process.memoryUsage();
    const memSpy = vi.spyOn(process, 'memoryUsage').mockReturnValue(fixedUsage);
    setSessionTranscriptMaxIndexEstimateBytesForTest(150 * 1024);
    setSessionTranscriptAvailableHeapBudgetForTest(140 * 1024);
    try {
      let caught: unknown;
      try {
        await newReader().readPage(sessionId, { limit: 10 });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(SessionTranscriptTooLargeError);
      const err = caught as SessionTranscriptTooLargeError;
      expect(err.dimension).toBe('index');
      expect(err.measuredBytes).toBeGreaterThan(150 * 1024);
      expect(err.retryable).toBeUndefined();
    } finally {
      memSpy.mockRestore();
      setSessionTranscriptMaxIndexEstimateBytesForTest(undefined);
      setSessionTranscriptAvailableHeapBudgetForTest(undefined);
    }
  });

  it('marks heap-limited structural rejections retryable when live heap occupancy is elevated', async () => {
    const records = longTurn(400, () => 'answer');
    await writeRecords(records);
    const { getHeapStatistics } = await import('node:v8');
    const heapLimit = getHeapStatistics().heap_size_limit;
    const original = process.memoryUsage.bind(process);
    const spy = vi.spyOn(process, 'memoryUsage').mockImplementation(() => {
      const usage = original();
      return { ...usage, heapUsed: Math.max(0, heapLimit - 32 * 1024) };
    });
    try {
      await expect(
        newReader().readPage(sessionId, { limit: 10 }),
      ).rejects.toMatchObject({
        dimension: 'index',
        retryable: true,
      });
    } finally {
      spy.mockRestore();
    }
  });

  it('keeps heap-limited structural rejections terminal on an idle reduced-heap process', async () => {
    const readerUrl = pathToFileURL(
      path.resolve('dist/src/services/session-transcript-reader.js'),
    ).href;
    const { createWriteStream } = await import('node:fs');
    const runtime = await fs.mkdtemp(path.join(os.tmpdir(), 'heap-idle-512-'));
    try {
      const workspace = path.join(runtime, 'workspace');
      await fs.mkdir(workspace, { recursive: true });
      const denseSessionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
      const chats = path.join(
        runtime,
        'projects',
        workspace.replace(/[^a-zA-Z0-9]/g, '-'),
        'chats',
      );
      await fs.mkdir(chats, { recursive: true });
      const target = path.join(chats, denseSessionId + '.jsonl');
      const out = createWriteStream(target);
      let parent: string | null = null;
      for (let i = 0; i < 420000; i += 1) {
        const uuid = 'idle-' + String(i).padStart(7, '0');
        const rec = {
          uuid,
          parentUuid: parent,
          sessionId: denseSessionId,
          timestamp: '2026-11-24T00:00:00.000Z',
          type: i % 2 === 0 ? 'user' : 'assistant',
          cwd: workspace,
          version: '0.28.3',
          message: {
            role: i % 2 === 0 ? 'user' : 'model',
            parts: [{ text: 't' }],
          },
        };
        if (!out.write(JSON.stringify(rec) + '\n')) {
          await new Promise<void>((resolve) => out.once('drain', resolve));
        }
        parent = uuid;
      }
      await new Promise<void>((resolve, reject) =>
        out.end((error: Error | null) => (error ? reject(error) : resolve())),
      );
      const probe = `
        import { SessionTranscriptReader } from ${JSON.stringify(readerUrl)};
        try {
          await new SessionTranscriptReader(${JSON.stringify(workspace)}, undefined, ${JSON.stringify(runtime)}).readPage(${JSON.stringify(denseSessionId)}, { limit: 10 });
          console.log(JSON.stringify({ result: 'served' }));
        } catch (error) {
          console.log(JSON.stringify({ result: 'rejected', name: error.name, dimension: error.dimension, retryable: error.retryable, maxBytes: error.maxBytes }));
        }
      `;
      const cleanEnv = { ...process.env };
      for (const name of Object.keys(cleanEnv)) {
        if (name.startsWith('QWEN_')) delete cleanEnv[name];
      }
      delete cleanEnv['NODE_OPTIONS'];
      const child = spawnSync(
        process.execPath,
        ['--max-old-space-size=512', '--input-type=module', '-e', probe],
        { encoding: 'utf8', env: cleanEnv, maxBuffer: 2 * 1024 * 1024 },
      );
      if (child.status !== 0) {
        throw new Error(
          `Idle 512 MiB probe failed (${child.status}/${child.signal}): ${child.stderr}`,
        );
      }
      const outcome = JSON.parse(child.stdout.trim()) as {
        result: string;
        name?: string;
        dimension?: string;
        retryable?: boolean;
        maxBytes?: number;
      };
      expect(outcome).toMatchObject({
        result: 'rejected',
        name: 'SessionTranscriptTooLargeError',
        dimension: 'index',
      });
      expect(outcome.retryable).toBeUndefined();
      expect(outcome.maxBytes).toBeLessThan(512 * 1024 * 1024);
    } finally {
      await fs.rm(runtime, { recursive: true, force: true });
    }
  });

  it('marks a mid-scan heap spike retryable and does not poison the prompt cache', async () => {
    const records = longTurn(4, () => 'answer');
    await writeRecords(records);
    const expectedPromptTime = records[0]?.timestamp;
    setSessionTranscriptAvailableHeapBudgetForTest(64 * 1024);
    const baseline = process.memoryUsage();
    let calls = 0;
    const spy = vi.spyOn(process, 'memoryUsage').mockImplementation(() => {
      calls += 1;
      // Call 1 is buildHeapUsedStart; call 2 is the first in-loop sample at
      // sequence 1 and must trip the mid-scan guard; call 3 (final check)
      // returns to baseline so only the loop guard can reject this fixture.
      return calls === 2
        ? { ...baseline, heapUsed: baseline.heapUsed + 128 * 1024 }
        : baseline;
    });
    const reader = newReader();
    try {
      await expect(reader.getLastUserPromptAt(sessionId)).rejects.toMatchObject(
        {
          dimension: 'index',
          retryable: true,
        },
      );
      expect(calls).toBe(2);
    } finally {
      spy.mockRestore();
      setSessionTranscriptAvailableHeapBudgetForTest(undefined);
    }

    expect(await reader.getLastUserPromptAt(sessionId)).toBe(
      expectedPromptTime,
    );
  });

  it('marks a final heap-growth spike retryable and does not poison the prompt cache', async () => {
    const records = longTurn(4, () => 'answer');
    await writeRecords(records);
    const expectedPromptTime = records[0]?.timestamp;
    setSessionTranscriptAvailableHeapBudgetForTest(64 * 1024);
    const baseline = process.memoryUsage();
    let calls = 0;
    const spy = vi.spyOn(process, 'memoryUsage').mockImplementation(() => {
      calls += 1;
      // Calls 1 (buildHeapUsedStart) and 2 (sequence 1 loop sample) stay at
      // baseline; call 3 (finalHeapGrowth after the scan loop) spikes above 64 KiB.
      return calls <= 2
        ? baseline
        : { ...baseline, heapUsed: baseline.heapUsed + 128 * 1024 };
    });
    const reader = newReader();
    try {
      await expect(reader.getLastUserPromptAt(sessionId)).rejects.toMatchObject(
        {
          dimension: 'index',
          retryable: true,
        },
      );
      expect(calls).toBe(3);
    } finally {
      spy.mockRestore();
      setSessionTranscriptAvailableHeapBudgetForTest(undefined);
    }

    expect(await reader.getLastUserPromptAt(sessionId)).toBe(
      expectedPromptTime,
    );
  });

  it('rejects a single oversized transcript line before buffering it whole', async () => {
    expect(SESSION_TRANSCRIPT_MAX_LINE_BYTES).toBe(32 * 1024 * 1024);

    await writeRecords([
      record('u-ok', null, 'small'),
      record('a-huge', 'u-ok', 'x'.repeat(16 * 1024)),
    ]);

    setSessionTranscriptMaxLineBytesForTest(4 * 1024);

    let caught: unknown;
    try {
      await newReader().readPage(sessionId, { limit: 10 });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SessionTranscriptPageTooLargeError);
    const err = caught as SessionTranscriptPageTooLargeError;
    expect(err.maxBytes).toBe(4 * 1024);
    expect(err.pageBytes).toBeGreaterThan(4 * 1024);
  });

  it('rejects replay.kind=all in readRestoreProjection before reading any record body when total replay bytes exceed the budget', async () => {
    expect(SESSION_TRANSCRIPT_MAX_ALL_REPLAY_BYTES).toBe(256 * 1024 * 1024);

    const lines: ChatRecord[] = [];
    let parent: string | null = null;
    for (let i = 0; i < 6; i += 1) {
      const uuid = `body-${i}`;
      lines.push(record(uuid, parent, 'b'.repeat(12 * 1024)));
      parent = uuid;
    }
    const filePath = await writeRecords(lines);
    const stat = await fs.stat(filePath);

    setSessionTranscriptMaxAllReplayBytesForTest(32 * 1024);
    let selectedReads = 0;
    setSessionTranscriptSelectedLineReadHookForTest(() => {
      selectedReads += 1;
    });

    let caught: unknown;
    try {
      await newReader().readRestoreProjection(sessionId, {
        replay: { kind: 'all', hideInheritedHistory: false },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SessionTranscriptTooLargeError);
    const err = caught as SessionTranscriptTooLargeError;
    expect(err.dimension).toBe('replay');
    expect(err.snapshotSize).toBe(stat.size);
    expect(err.maxBytes).toBe(32 * 1024);
    expect(err.measuredBytes).toBeGreaterThan(32 * 1024);
    expect(selectedReads).toBe(0);
  });

  it('serves a terse transcript uncached when its index exceeds the cache-class budget but stays within the build ceiling', async () => {
    const lines: ChatRecord[] = [];
    let parent: string | null = null;
    for (let i = 0; i < 40; i += 1) {
      const uuid = `terse-${i}`;
      lines.push(record(uuid, parent, `m${i}`));
      parent = uuid;
    }
    await writeRecords(lines);

    // Cache-class budget refuses admission (~12 KiB < ~55 KiB), while the
    // decoupled hard build budget stays at its 512 MiB default.
    setSessionTranscriptIndexCacheOversizedMaxBytesForTest(12 * 1024);
    setSessionTranscriptIndexCacheMaxBytesForTest(4 * 1024);

    const page = await newReader().readPage(sessionId, { limit: 10 });
    expect(page.records).toHaveLength(10);
    expect(getSessionTranscriptIndexCacheStatsForTest().entries).toBe(0);
  });

  it.each(['index', 'page'])(
    'memoizes over-budget getLastUserPromptAt outcomes so repeated list reads do not rebuild (%s)',
    async (budgetKind) => {
      const lines: ChatRecord[] = [];
      let parent: string | null = null;
      for (let i = 0; i < 40; i += 1) {
        const uuid = `prompt-dense-${i}`;
        lines.push(
          record(uuid, parent, i === 39 ? 'x'.repeat(8 * 1024) : `m${i}`),
        );
        parent = uuid;
      }
      await writeRecords(lines);

      if (budgetKind === 'index') {
        setSessionTranscriptMaxIndexEstimateBytesForTest(16 * 1024);
      } else {
        setSessionTranscriptMaxLineBytesForTest(4 * 1024);
      }
      let yieldCount = 0;
      setSessionTranscriptCooperativeReadBudgetForTest(1, 0, () => {
        yieldCount += 1;
      });

      const reader = newReader();
      expect(await reader.getLastUserPromptAt(sessionId)).toBeUndefined();
      const afterFirst = yieldCount;

      expect(await reader.getLastUserPromptAt(sessionId)).toBeUndefined();
      expect(yieldCount).toBe(afterFirst);
    },
  );

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

  it('selects the last valid workflow mode on the active branch independently of replay', async () => {
    await writeRecords([
      sys('mode-off', null, 'session_workflow_mode', { enabled: false }),
      record('u1', 'mode-off', 'first'),
      record('a1', 'u1', 'answer'),
      sys('mode-abandoned', 'a1', 'session_workflow_mode', { enabled: true }),
      record('u2', 'mode-abandoned', 'abandoned'),
      record('a2', 'u2', 'abandoned answer'),
      sys('rewind', 'a1', 'rewind', { truncatedCount: 1 }),
      sys('mode-invalid', 'rewind', 'session_workflow_mode', {
        enabled: 'true',
      }),
      record('u3', 'mode-invalid', 'active'),
      record('a3', 'u3', 'active answer'),
    ]);
    const projection = await coldProjection();
    expect(projection?.runtime.recording.sessionWorkflowMode).toEqual({
      enabled: false,
    });
    expect(JSON.stringify(projection?.runtime.apiHistory)).not.toContain(
      'enabled',
    );
    const loaded = await svc().loadSession(sessionId);
    expect(
      loaded?.conversation.messages.map((record) => record.uuid),
    ).not.toContain('mode-abandoned');
  });

  it('retains mode metadata on a selected historical fork, not the source tip', async () => {
    await writeRecords([
      sys('mode-off', null, 'session_workflow_mode', { enabled: false }),
      record('u1', 'mode-off', 'first'),
      record('a1', 'u1', 'answer'),
      sys('checkpoint', 'a1', 'branch_checkpoint', {
        v: 1,
        startExclusiveRecordUuid: null,
        assistantRecordUuid: 'a1',
      }),
      sys('mode-on', 'checkpoint', 'session_workflow_mode', { enabled: true }),
      record('u2', 'mode-on', 'second'),
      record('a2', 'u2', 'answer'),
    ]);
    const service = svc();
    expect(
      (await coldProjection())?.runtime.recording.sessionWorkflowMode,
    ).toEqual({ enabled: true });
    await service.forkSession(sessionId, otherSessionId, {
      atRecordId: 'checkpoint',
    });
    const fork = await service.readRestoreProjection(otherSessionId, NONE);
    expect(fork?.runtime.recording.sessionWorkflowMode).toEqual({
      enabled: false,
    });
    expect(
      (await coldProjection())?.runtime.recording.sessionWorkflowMode,
    ).toEqual({ enabled: true });
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

  it('preserves prompt snapshots through load and fork without changing restored state or model input', async () => {
    const messages = chain(...TWO_TURNS);
    const executionContext = {
      modelId: 'recorded-prompt-model',
      authType: 'openai',
      approvalMode: ApprovalMode.YOLO,
    };
    messages[2].executionContext = executionContext;
    await writeRecords(messages);
    const service = svc();
    const loaded = await service.loadSession(sessionId);
    expect(loaded?.conversation.messages[0].executionContext).toBeUndefined();
    expect(loaded?.conversation.messages[2].executionContext).toEqual(
      executionContext,
    );
    const restored = await service.readRestoreProjection(sessionId, NONE);
    expect(
      restored?.runtime.apiHistory.map(({ role, parts }) => ({ role, parts })),
    ).toEqual(messages.map((message) => message.message));
    expect(restored?.runtime.recording.sessionModel).toBeUndefined();
    expect(restored?.runtime.recording.sessionApprovalMode).toBeUndefined();

    await service.forkSession(sessionId, otherSessionId);
    const fork = await service.loadSession(otherSessionId);
    expect(fork?.conversation.messages[0].executionContext).toBeUndefined();
    expect(fork?.conversation.messages[2].executionContext).toEqual(
      executionContext,
    );
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

  it('advertises branch points on the restore replay pages', async () => {
    await writeRecords([
      ...chain('prompt', 'answer'),
      branchCheckpoint('checkpoint-1'),
    ]);
    const reader = newReader();
    const restored = await reader.readRestoreProjection(sessionId, all(false));
    expect(uuids(restored?.replay?.records)).toContain('a1');
    expect(restored?.replay?.branchPointsByAssistantUuid).toEqual({
      a1: 'checkpoint-1',
    });

    const live = await reader.readLiveRestoreProjection(sessionId, all(false));
    expect(live?.replay?.branchPointsByAssistantUuid).toEqual({
      a1: 'checkpoint-1',
    });
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

    expect(
      projection?.runtime.apiHistory.map(({ role, parts }) => ({
        role,
        parts,
      })),
    ).toEqual([first.message, second.message]);
    expect(projection?.runtime.apiHistory.map(getApiHistoryPromptId)).toEqual([
      'legacy-record:u1',
      undefined,
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
    setSessionTranscriptIndexCacheOversizedMaxBytesForTest(1);
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
    const { filePath, reader, state } = await firstPage('hello', 'reply');
    const warmCache = getSessionTranscriptIndexCacheStatsForTest();
    expect(warmCache.entries).toBe(1);
    setSessionTranscriptIndexCacheMaxBytesForTest(warmCache.byteSize + 1);

    const large = (i: number) => `large transcript ${i}`;
    await writeRecords(
      linear('large-', 0, 19, null, large, otherSessionId),
      otherSessionId,
    );
    await reader.readPage(otherSessionId, { limit: 1 });
    // The oversized index is retained in its own budget class; the warm
    // shared entry keeps its place and its bytes.
    const afterOversizedRead = getSessionTranscriptIndexCacheStatsForTest();
    expect(afterOversizedRead.entries).toBe(2);
    expect(afterOversizedRead.byteSize).toBeGreaterThan(warmCache.byteSize);

    const builds = countBuilds(filePath);
    const second = await readAfter(reader, state, { limit: 1 });
    expect(uuids(second.records)).toEqual(['a1']);
    expect(builds.count).toBe(0);
  });

  it('retains an index above the shared byte budget and serves repeats without rebuilding (#17889)', async () => {
    const filePath = await writeRecords(chain('hello', 'reply'));
    setSessionTranscriptIndexCacheMaxBytesForTest(1);
    const builds = countBuilds(filePath);
    const reader = newReader();
    const first = await reader.readPage(sessionId, { limit: 1 });
    expect(builds.count).toBe(1);
    const cached = getSessionTranscriptIndexCacheStatsForTest();
    expect(cached.entries).toBe(1);
    expect(cached.byteSize).toBeGreaterThan(1);

    const repeat = await reader.readPage(sessionId, { limit: 1 });
    const continuation = await readAfter(reader, first.nextCursorState!, {
      limit: 1,
    });
    expect(builds.count).toBe(1);
    expect(uuids(repeat.records)).toEqual(uuids(first.records));
    expect(uuids(continuation.records)).toEqual(['a1']);
  });

  it('refuses a second oversized index that does not fit the oversized budget', async () => {
    setSessionTranscriptIndexCacheMaxBytesForTest(1);
    const reader = newReader();
    await writeRecords(chain('hello', 'reply'));
    await reader.readPage(sessionId, { limit: 1 });
    const firstBytes = getSessionTranscriptIndexCacheStatsForTest().byteSize;

    const secondPath = await writeRecords(
      linear(
        'large-',
        0,
        19,
        null,
        (i) => `large transcript ${i}`,
        otherSessionId,
      ),
      otherSessionId,
    );
    // Learn the second index's estimate under the default oversized budget,
    // then cap the class so each index fits alone but not together.
    await reader.readPage(otherSessionId, { limit: 1 });
    const secondBytes =
      getSessionTranscriptIndexCacheStatsForTest().byteSize - firstBytes;
    expect(secondBytes).toBeGreaterThan(firstBytes);
    clearSessionTranscriptIndexCacheEntriesForTest();
    setSessionTranscriptIndexCacheOversizedMaxBytesForTest(secondBytes + 1);

    const builds = countBuilds(secondPath);
    await reader.readPage(sessionId, { limit: 1 });
    await reader.readPage(otherSessionId, { limit: 1 });
    await reader.readPage(otherSessionId, { limit: 1 });
    expect(builds.count).toBe(2);
    expect(getSessionTranscriptIndexCacheStatsForTest()).toEqual({
      entries: 1,
      byteSize: firstBytes,
    });
  });

  it('prunes oversized indexes by their own budget without touching shared ones', async () => {
    const reader = newReader();
    await writeRecords(chain('hello', 'reply'));
    await reader.readPage(sessionId, { limit: 1 });
    const firstBytes = getSessionTranscriptIndexCacheStatsForTest().byteSize;
    setSessionTranscriptIndexCacheMaxBytesForTest(firstBytes);

    await writeRecords(
      linear(
        'large-',
        0,
        19,
        null,
        (i) => `large transcript ${i}`,
        otherSessionId,
      ),
      otherSessionId,
    );
    await reader.readPage(otherSessionId, { limit: 1 });
    const both = getSessionTranscriptIndexCacheStatsForTest();
    expect(both.entries).toBe(2);
    const secondBytes = both.byteSize - firstBytes;
    expect(secondBytes).toBeGreaterThan(firstBytes);

    setSessionTranscriptIndexCacheOversizedMaxBytesForTest(1);
    expect(getSessionTranscriptIndexCacheStatsForTest()).toEqual({
      entries: 1,
      byteSize: firstBytes,
    });
  });

  it('invalidates a retained oversized index when the transcript is appended', async () => {
    const filePath = await writeRecords(chain('hello', 'reply'));
    setSessionTranscriptIndexCacheMaxBytesForTest(1);
    const builds = countBuilds(filePath);
    const reader = newReader();
    await reader.readPage(sessionId, { limit: 1 });
    await appendRecords(filePath, record('u2', 'a1', 'next prompt'));
    const page = await reader.readPage(sessionId, { limit: 500 });
    expect(builds.count).toBe(2);
    expect(uuids(page.records)).toEqual(['u1', 'a1', 'u2']);
  });

  it('accounts admission against the entry class, not total bytes, with both classes warm', async () => {
    const reader = newReader();
    const thirdSessionId = '730e8400-e29b-41d4-a716-446655440000';
    const large = (i: number) => `large transcript ${i}`;
    await writeRecords(chain('hello', 'reply'));
    await reader.readPage(sessionId, { limit: 1 });
    const sharedBytes = getSessionTranscriptIndexCacheStatsForTest().byteSize;
    await writeRecords(
      linear('large-', 0, 19, null, large, otherSessionId),
      otherSessionId,
    );
    await reader.readPage(otherSessionId, { limit: 1 });
    const secondLargePath = await writeRecords(
      linear('large-', 0, 19, null, large, thirdSessionId),
      thirdSessionId,
    );
    await reader.readPage(thirdSessionId, { limit: 1 });
    const warm = getSessionTranscriptIndexCacheStatsForTest();
    expect(warm.entries).toBe(3);

    // Each class fits its own entries exactly; the total exceeds the
    // oversized budget, so total-byte accounting would refuse the re-read.
    clearSessionTranscriptIndexCacheEntriesForTest();
    setSessionTranscriptIndexCacheMaxBytesForTest(sharedBytes);
    setSessionTranscriptIndexCacheOversizedMaxBytesForTest(
      warm.byteSize - sharedBytes,
    );
    await reader.readPage(sessionId, { limit: 1 });
    await reader.readPage(otherSessionId, { limit: 1 });
    const builds = countBuilds(secondLargePath);
    await reader.readPage(thirdSessionId, { limit: 1 });
    await reader.readPage(thirdSessionId, { limit: 1 });
    expect(builds.count).toBe(1);
    expect(getSessionTranscriptIndexCacheStatsForTest()).toEqual(warm);
  });

  it('offers a restore-built oversized index to the cache for later pages (#17889)', async () => {
    const filePath = await writeRecords(chain('hello', 'reply'));
    setSessionTranscriptIndexCacheMaxBytesForTest(1);
    const reader = newReader();
    await expect(
      reader.readRestoreProjection(sessionId, NONE),
    ).resolves.toBeDefined();
    const cached = getSessionTranscriptIndexCacheStatsForTest();
    expect(cached.entries).toBe(1);
    expect(cached.byteSize).toBeGreaterThan(1);
    const builds = countBuilds(filePath);
    await reader.readPage(sessionId, { limit: 1 });
    expect(builds.count).toBe(0);
  });

  it.each([
    ['oversized', true],
    ['shared', false],
  ] as const)(
    'rejects a frozen cursor after an equal-size in-place rewrite (%s class)',
    async (_label, forceOversized) => {
      const filePath = await writeRecords(chain('hello', 'reply', 'third'));
      if (forceOversized) setSessionTranscriptIndexCacheMaxBytesForTest(1);
      const reader = newReader();
      const first = await reader.readPage(sessionId, { limit: 1 });
      const state = first.nextCursorState!;
      const raw = await fs.readFile(filePath, 'utf8');
      const rewritten = raw
        .replace('"text":"reply"', '"text":"REPLY"')
        .replace('"uuid":"u2"', '"uuid":"x2"');
      expect(Buffer.byteLength(rewritten, 'utf8')).toBe(
        Buffer.byteLength(raw, 'utf8'),
      );
      await fs.writeFile(filePath, rewritten, 'utf8');
      const stats = await fs.stat(filePath);
      await fs.utimes(filePath, stats.atime, new Date(stats.mtimeMs + 1000));
      await expect(
        readAfter(reader, state, { limit: 1 }),
      ).rejects.toMatchObject({
        name: 'SessionTranscriptSnapshotUnavailableError',
      });
    },
  );

  it.each([
    ['oversized', true],
    ['shared', false],
  ] as const)(
    'rejects a frozen snapshot anchor after an equal-size in-place rewrite (%s class)',
    async (_label, forceOversized) => {
      const filePath = await writeRecords(chain('hello', 'reply', 'third'));
      if (forceOversized) setSessionTranscriptIndexCacheMaxBytesForTest(1);
      const reader = newReader();
      const { snapshot } = await reader.readTurnIndexPage(sessionId);
      await reader.readPage(sessionId, { limit: 1 });
      const raw = await fs.readFile(filePath, 'utf8');
      // Text-only equal-length edit: uuids and the leaf stay intact, so only
      // the mtime guard can fail this closed.
      const rewritten = raw.replace('"text":"reply"', '"text":"REPLY"');
      expect(Buffer.byteLength(rewritten, 'utf8')).toBe(
        Buffer.byteLength(raw, 'utf8'),
      );
      await fs.writeFile(filePath, rewritten, 'utf8');
      const stats = await fs.stat(filePath);
      await fs.utimes(filePath, stats.atime, new Date(stats.mtimeMs + 1000));
      await expect(
        reader.readPage(sessionId, { snapshot, atRecordId: 'u1' }),
      ).rejects.toMatchObject({
        name: 'SessionTranscriptSnapshotUnavailableError',
      });
    },
  );

  it('makes room for a newer snapshot of the same file when the class budget is full', async () => {
    setSessionTranscriptIndexCacheMaxBytesForTest(1);
    const reader = newReader();
    const filePath = await writeRecords(
      linear('large-', 0, 19, null, (i) => `large transcript ${i}`),
    );
    const first = await reader.readPage(sessionId, { limit: 1 });
    const oldState = first.nextCursorState!;
    const oldBytes = getSessionTranscriptIndexCacheStatsForTest().byteSize;
    await appendRecords(filePath, record('u21', 'large-19', 'appended'));
    // Calibrate the new snapshot's estimate under the default budget, then
    // tighten the class so one snapshot fits but two do not.
    await reader.readPage(sessionId, { limit: 1 });
    const newBytes =
      getSessionTranscriptIndexCacheStatsForTest().byteSize - oldBytes;
    expect(newBytes).toBeGreaterThan(0);
    clearSessionTranscriptIndexCacheEntriesForTest();
    setSessionTranscriptIndexCacheOversizedMaxBytesForTest(newBytes + 1);
    await readAfter(reader, oldState, { limit: 1 });

    const builds = countBuilds(filePath);
    const newFirst = await reader.readPage(sessionId, { limit: 1 });
    expect(builds.count).toBe(1);
    await reader.readPage(sessionId, { limit: 1 });
    const continuation = await readAfter(reader, newFirst.nextCursorState!, {
      limit: 1,
    });
    expect(builds.count).toBe(1);
    expect(uuids(continuation.records)).toEqual(['large-1']);
    expect(getSessionTranscriptIndexCacheStatsForTest().byteSize).toBe(
      newBytes,
    );
    // The superseded frozen cursor still reads its original prefix; its
    // index may rebuild, but the page contract holds.
    const oldPage = await readAfter(reader, oldState, { limit: 1 });
    expect(uuids(oldPage.records)).toEqual(['large-1']);
  });

  it('accounts a retained Managed projection against the index budget class', async () => {
    const bigText = 'x'.repeat(256 * 1024);
    const { authority } = await openManagedFixture([
      { uuid: 'u1', parent: null, text: 'short prompt' },
      { uuid: 'a1', parent: 'u1', text: 'short reply' },
      { uuid: 'u2', parent: 'a1', text: bigText },
    ]);
    await authority.close();

    const reader = newReader();
    // readTurnHooksPage caches the physical index without projecting the
    // Managed log (it reports unsupported), so the calibration below measures
    // the physical hints alone.
    await reader.readTurnHooksPage(sessionId, 'legacy-record:u1');
    const physicalBytes = getSessionTranscriptIndexCacheStatsForTest().byteSize;
    expect(physicalBytes).toBeGreaterThan(0);
    setSessionTranscriptIndexCacheMaxBytesForTest(1);
    // Room for the physical index but not for the decoded message bodies.
    setSessionTranscriptIndexCacheOversizedMaxBytesForTest(
      physicalBytes + 1024,
    );
    projectionReads.count = 0;
    await reader.readPage(sessionId, { limit: 3 });
    expect(projectionReads.count).toBe(1);
    expect(getSessionTranscriptIndexCacheStatsForTest().byteSize).toBe(
      physicalBytes,
    );
    const tightPage = await reader.readPage(sessionId, { limit: 3 });
    expect(uuids(tightPage.records)).toEqual(['u1', 'a1', 'u2']);
    // The bodies do not fit the class budget, so the projection is not
    // retained and the next page projects the log again.
    expect(projectionReads.count).toBe(2);

    clearSessionTranscriptIndexCacheEntriesForTest();
    setSessionTranscriptIndexCacheOversizedMaxBytesForTest(256 * 1024 * 1024);
    projectionReads.count = 0;
    await reader.readPage(sessionId, { limit: 3 });
    expect(projectionReads.count).toBe(1);
    expect(
      getSessionTranscriptIndexCacheStatsForTest().byteSize,
    ).toBeGreaterThan(physicalBytes + bigText.length);
    await reader.readPage(sessionId, { limit: 3 });
    expect(projectionReads.count).toBe(1);
  });

  it('evicts an equal-size rewrite orphan to admit the live snapshot when the class is full', async () => {
    setSessionTranscriptIndexCacheMaxBytesForTest(1);
    const reader = newReader();
    const filePath = await writeRecords(
      linear('large-', 0, 19, null, (i) => `large transcript ${i}`),
    );
    await reader.readPage(sessionId, { limit: 1 });
    const oldBytes = getSessionTranscriptIndexCacheStatsForTest().byteSize;
    setSessionTranscriptIndexCacheOversizedMaxBytesForTest(oldBytes + 1);
    const raw = await fs.readFile(filePath, 'utf8');
    const rewritten = raw.replace(
      '"text":"large transcript 5"',
      '"text":"LARGE transcript 5"',
    );
    expect(Buffer.byteLength(rewritten, 'utf8')).toBe(
      Buffer.byteLength(raw, 'utf8'),
    );
    await fs.writeFile(filePath, rewritten, 'utf8');
    const stats = await fs.stat(filePath);
    await fs.utimes(filePath, stats.atime, new Date(stats.mtimeMs + 1000));
    const builds = countBuilds(filePath);
    await reader.readPage(sessionId, { limit: 1 });
    await reader.readPage(sessionId, { limit: 1 });
    expect(builds.count).toBe(1);
    expect(getSessionTranscriptIndexCacheStatsForTest().byteSize).toBe(
      oldBytes,
    );
  });

  it('does not let a stale equal-size build evict the live newer entry', async () => {
    setSessionTranscriptIndexCacheMaxBytesForTest(1);
    const reader = newReader();
    const filePath = await writeRecords(
      linear('large-', 0, 19, null, (i) => `large transcript ${i}`),
    );
    let releaseBuild: (() => void) | undefined;
    const buildBlocked = new Promise<void>((resolve) => {
      releaseBuild = resolve;
    });
    let firstBuild = true;
    setSessionTranscriptIndexBuildCompleteHookForTest(async (builtPath) => {
      if (builtPath === filePath && firstBuild) {
        firstBuild = false;
        await buildBlocked;
      }
    });
    const staleRead = reader.readPage(sessionId, { limit: 1 });
    await vi.waitFor(() => expect(firstBuild).toBe(false));
    const raw = await fs.readFile(filePath, 'utf8');
    const rewritten = raw.replace(
      '"text":"large transcript 5"',
      '"text":"LARGE transcript 5"',
    );
    expect(Buffer.byteLength(rewritten, 'utf8')).toBe(
      Buffer.byteLength(raw, 'utf8'),
    );
    await fs.writeFile(filePath, rewritten, 'utf8');
    const stats = await fs.stat(filePath);
    await fs.utimes(filePath, stats.atime, new Date(stats.mtimeMs + 1000));
    await reader.readPage(sessionId, { limit: 1 });
    const liveBytes = getSessionTranscriptIndexCacheStatsForTest().byteSize;
    setSessionTranscriptIndexCacheOversizedMaxBytesForTest(liveBytes);
    releaseBuild!();
    // The stale build fails closed instead of serving its torn snapshot,
    // and it must not evict the live newer entry on its way out.
    await expect(staleRead).rejects.toMatchObject({
      name: 'SessionTranscriptSnapshotUnavailableError',
    });
    expect(getSessionTranscriptIndexCacheStatsForTest().byteSize).toBe(
      liveBytes,
    );
    const builds = countBuilds(filePath);
    await reader.readPage(sessionId, { limit: 1 });
    expect(builds.count).toBe(0);
  });

  it.each(['resident', 'entry-cleared', 'over-cap'] as const)(
    'fails every sharer of a rebuild closed when the frozen snapshot is rewritten under it (%s)',
    async (condition) => {
      if (condition === 'over-cap') {
        setSessionTranscriptIndexCacheMaxBytesForTest(1);
        setSessionTranscriptIndexCacheOversizedMaxBytesForTest(1);
      }
      const filePath = await writeRecords(chain('hello', 'reply', 'third'));
      const reader = newReader();
      const first = await reader.readPage(sessionId, { limit: 1 });
      const state = first.nextCursorState!;
      clearSessionTranscriptIndexCacheEntriesForTest();
      let releaseBuild: (() => void) | undefined;
      const buildBlocked = new Promise<void>((resolve) => {
        releaseBuild = resolve;
      });
      let firstBuild = true;
      setSessionTranscriptIndexBuildCompleteHookForTest(async (builtPath) => {
        if (builtPath === filePath && firstBuild) {
          firstBuild = false;
          await buildBlocked;
        }
      });
      const initiator = readAfter(reader, state, { limit: 1 });
      await vi.waitFor(() => expect(firstBuild).toBe(false));
      // A second request with the same frozen cursor shares the pending build.
      const waiter = readAfter(reader, state, { limit: 1 });
      // Mark both promises handled before releasing the build so no
      // rejection window is left unhandled; the assertions follow below.
      void initiator.catch(() => {});
      void waiter.catch(() => {});
      // Wait until the waiter has actually taken the pending-hit path; on a
      // loaded runner its stat can lag, and clearing before it shares would
      // let it start a second build against the not-yet-rewritten file.
      await vi.waitFor(() =>
        expect(
          mockDebugLogger.debug.mock.calls.some((call) =>
            String(call[0]).includes('index cache pending hit'),
          ),
        ).toBe(true),
      );
      if (condition === 'entry-cleared') {
        // The placeholder loses its cache slot mid-build (via the test clear
        // seam; count-cap eviction of in-flight placeholders is prevented by
        // design). The completion must still verify for every sharer instead
        // of serving the torn build uncached.
        clearSessionTranscriptIndexCacheEntriesForTest();
      }
      const raw = await fs.readFile(filePath, 'utf8');
      const rewritten = raw.replace('"text":"reply"', '"text":"REPLY"');
      expect(Buffer.byteLength(rewritten, 'utf8')).toBe(
        Buffer.byteLength(raw, 'utf8'),
      );
      await fs.writeFile(filePath, rewritten, 'utf8');
      const stats = await fs.stat(filePath);
      await fs.utimes(filePath, stats.atime, new Date(stats.mtimeMs + 1000));
      releaseBuild!();
      await expect(initiator).rejects.toMatchObject({
        name: 'SessionTranscriptSnapshotUnavailableError',
      });
      await expect(waiter).rejects.toMatchObject({
        name: 'SessionTranscriptSnapshotUnavailableError',
      });
    },
  );

  it('retains an in-flight build placeholder under count pressure and admits its completion', async () => {
    const filePath = await writeRecords(chain('hello', 'reply', 'third'));
    const reader = newReader();
    let releaseBuild: (() => void) | undefined;
    const buildBlocked = new Promise<void>((resolve) => {
      releaseBuild = resolve;
    });
    let firstBuild = true;
    setSessionTranscriptIndexBuildCompleteHookForTest(async (builtPath) => {
      if (builtPath === filePath && firstBuild) {
        firstBuild = false;
        await buildBlocked;
      }
    });
    const pendingRead = reader.readPage(sessionId, { limit: 1 });
    await vi.waitFor(() => expect(firstBuild).toBe(false));
    // Admit more distinct sessions than the count cap while the build is
    // awaited: the placeholder must survive the LRU prune (it holds no
    // bytes and its build is still in flight).
    for (let i = 0; i < 33; i++) {
      const sid = `770e8400-e29b-41d4-a716-${String(i).padStart(12, '0')}`;
      await writeRecords(
        linear('f-', 0, 1, null, () => 'filler', sid),
        sid,
      );
      await reader.readPage(sid, { limit: 1 });
    }
    expect(getSessionTranscriptIndexCacheStatsForTest().entries).toBe(32);
    releaseBuild!();
    await pendingRead;
    const builds = countBuilds(filePath);
    await reader.readPage(sessionId, { limit: 1 });
    // The completion admitted the index instead of returning it uncached.
    expect(builds.count).toBe(0);
  });

  it('moves a completing placeholder to the MRU tail instead of self-evicting it', async () => {
    const filePath = await writeRecords(chain('hello', 'reply', 'third'));
    const secondSessionId = '880e8400-e29b-41d4-a716-446655440000';
    const secondPath = await writeRecords(
      linear('s-', 0, 1, null, () => 'second', secondSessionId),
      secondSessionId,
    );
    const reader = newReader();
    const releases = new Map<string, () => void>();
    const started = new Map<string, boolean>();
    const blockFor = (target: string) => {
      const blocked = new Promise<void>((resolve) => {
        releases.set(target, resolve);
      });
      return blocked;
    };
    const targetBlocked = blockFor(filePath);
    const secondBlocked = blockFor(secondPath);
    setSessionTranscriptIndexBuildCompleteHookForTest(async (builtPath) => {
      if (started.has(builtPath)) return;
      if (builtPath === filePath) {
        started.set(builtPath, true);
        await targetBlocked;
      } else if (builtPath === secondPath) {
        started.set(builtPath, true);
        await secondBlocked;
      }
    });
    const pendingRead = reader.readPage(sessionId, { limit: 1 });
    await vi.waitFor(() => expect(started.has(filePath)).toBe(true));
    for (let i = 0; i < 33; i++) {
      const sid = `770e8400-e29b-41d4-a716-${String(i).padStart(12, '0')}`;
      await writeRecords(
        linear('f-', 0, 1, null, () => 'filler', sid),
        sid,
      );
      await reader.readPage(sid, { limit: 1 });
    }
    // A second in-flight placeholder pushes the map past the count cap, so
    // the completion's prune must evict a value entry — and the completing
    // key, still at its placeholder insertion position without a delete
    // before set, would be the first value the prune sees.
    const pendingSecond = reader.readPage(secondSessionId, { limit: 1 });
    await vi.waitFor(() => expect(started.has(secondPath)).toBe(true));
    expect(getSessionTranscriptIndexCacheStatsForTest().entries).toBe(33);
    releases.get(filePath)!();
    await pendingRead;
    expect(getSessionTranscriptIndexCacheStatsForTest().entries).toBe(32);
    const builds = countBuilds(filePath);
    await reader.readPage(sessionId, { limit: 1 });
    // The completion survived its own prune.
    expect(builds.count).toBe(0);
    // The next unrelated admission evicts the true LRU value, not the
    // freshly completed entry.
    const lateSid = '990e8400-e29b-41d4-a716-446655440000';
    await writeRecords(
      linear('late-', 0, 1, null, () => 'late', lateSid),
      lateSid,
    );
    await reader.readPage(lateSid, { limit: 1 });
    await reader.readPage(sessionId, { limit: 1 });
    expect(builds.count).toBe(0);
    releases.get(secondPath)!();
    await pendingSecond;
  });

  it('evicts a same-mtime smaller prefix to admit the live snapshot when the class is full', async () => {
    setSessionTranscriptIndexCacheMaxBytesForTest(1);
    const reader = newReader();
    const filePath = await writeRecords(
      linear('large-', 0, 19, null, (i) => `large transcript ${i}`),
    );
    // Pin a whole-millisecond mtime and restore it after the append, so the
    // equal-mtime/smaller-size arm (a same-millisecond append) is the only
    // one that can reclaim the old prefix.
    await pinMtime(filePath);
    const first = await reader.readPage(sessionId, { limit: 1 });
    const oldState = first.nextCursorState!;
    const oldBytes = getSessionTranscriptIndexCacheStatsForTest().byteSize;
    const frozen = await fs.stat(filePath);
    await appendRecords(filePath, record('u21', 'large-19', 'appended'));
    await fs.utimes(filePath, frozen.atime, frozen.mtime);
    // Fits the grown snapshot alone, but not it plus the old prefix.
    setSessionTranscriptIndexCacheOversizedMaxBytesForTest(oldBytes + 2048);
    const builds = countBuilds(filePath);
    await reader.readPage(sessionId, { limit: 1 });
    await reader.readPage(sessionId, { limit: 1 });
    expect(builds.count).toBe(1);
    expect(getSessionTranscriptIndexCacheStatsForTest().entries).toBe(1);
    // The superseded frozen prefix still reads its original content.
    const oldPage = await readAfter(reader, oldState, { limit: 1 });
    expect(uuids(oldPage.records)).toEqual(['large-1']);
  });

  it('evicts a shorter prefix by length when an append restored an older mtime', async () => {
    setSessionTranscriptIndexCacheMaxBytesForTest(1);
    const reader = newReader();
    const filePath = await writeRecords(
      linear('large-', 0, 19, null, (i) => `large transcript ${i}`),
    );
    const first = await reader.readPage(sessionId, { limit: 1 });
    const oldState = first.nextCursorState!;
    const oldBytes = getSessionTranscriptIndexCacheStatsForTest().byteSize;
    const frozen = await fs.stat(filePath);
    await appendRecords(filePath, record('u21', 'large-19', 'appended'));
    // An in-place sync that appends and then restores an older source
    // timestamp: the live snapshot's mtime is older than the prefix's.
    await fs.utimes(filePath, frozen.atime, new Date(frozen.mtimeMs - 60000));
    // Fits the grown snapshot alone, but not it plus the old prefix.
    setSessionTranscriptIndexCacheOversizedMaxBytesForTest(oldBytes + 2048);
    const builds = countBuilds(filePath);
    await reader.readPage(sessionId, { limit: 1 });
    await reader.readPage(sessionId, { limit: 1 });
    // Length decides supersession, not mtime order: the live snapshot
    // reclaims the shorter prefix and repeats hit.
    expect(builds.count).toBe(1);
    expect(getSessionTranscriptIndexCacheStatsForTest().entries).toBe(1);
    // The superseded frozen prefix rebuilds on demand (the second build),
    // and its admission must not evict the live index even though the
    // live mtime is older: the following live read still hits.
    const oldPage = await readAfter(reader, oldState, { limit: 1 });
    expect(uuids(oldPage.records)).toEqual(['large-1']);
    await reader.readPage(sessionId, { limit: 1 });
    expect(builds.count).toBe(2);
    expect(getSessionTranscriptIndexCacheStatsForTest().entries).toBe(1);
  });

  it('does not let a frozen-prefix admission reclaim the live newer index', async () => {
    setSessionTranscriptIndexCacheMaxBytesForTest(1);
    const reader = newReader();
    const large = (i: number) => `large transcript ${i}`;
    const filePath = await writeRecords(linear('large-', 0, 19, null, large));
    const first = await reader.readPage(sessionId, { limit: 1 });
    const oldState = first.nextCursorState!;
    const frozenBytes = getSessionTranscriptIndexCacheStatsForTest().byteSize;
    await appendRecords(filePath, record('u21', 'large-19', 'appended'));
    await reader.readPage(sessionId, { limit: 1 });
    const liveBytes =
      getSessionTranscriptIndexCacheStatsForTest().byteSize - frozenBytes;
    await writeRecords(
      linear('other-', 0, 19, null, large, otherSessionId),
      otherSessionId,
    );
    await reader.readPage(otherSessionId, { limit: 1 });
    const fillerBytes =
      getSessionTranscriptIndexCacheStatsForTest().byteSize -
      frozenBytes -
      liveBytes;
    // Tighten so the class holds live + filler exactly; the LRU prune drops
    // the frozen prefix, whose rebuild must not reclaim the live index.
    setSessionTranscriptIndexCacheOversizedMaxBytesForTest(
      liveBytes + fillerBytes,
    );
    const builds = countBuilds(filePath);
    // The frozen prefix rebuilds, but its admission must not reclaim the
    // live newer index (which is newer in time, though larger in size).
    const oldPage = await readAfter(reader, oldState, { limit: 1 });
    expect(uuids(oldPage.records)).toEqual(['large-1']);
    expect(builds.count).toBe(1);
    expect(getSessionTranscriptIndexCacheStatsForTest().byteSize).toBe(
      liveBytes + fillerBytes,
    );
    await reader.readPage(sessionId, { limit: 1 });
    expect(builds.count).toBe(1);
  });

  it('admits a shared build whose snapshot was only appended under it', async () => {
    const filePath = await writeRecords(chain('hello', 'reply', 'third'));
    const reader = newReader();
    const first = await reader.readPage(sessionId, { limit: 1 });
    const state = first.nextCursorState!;
    clearSessionTranscriptIndexCacheEntriesForTest();
    let releaseBuild: (() => void) | undefined;
    const buildBlocked = new Promise<void>((resolve) => {
      releaseBuild = resolve;
    });
    let firstBuild = true;
    setSessionTranscriptIndexBuildCompleteHookForTest(async (builtPath) => {
      if (builtPath === filePath && firstBuild) {
        firstBuild = false;
        await buildBlocked;
      }
    });
    const initiator = readAfter(reader, state, { limit: 1 });
    await vi.waitFor(() => expect(firstBuild).toBe(false));
    const waiter = readAfter(reader, state, { limit: 1 });
    // A pure append under the build: allowAppend keeps the frozen prefix
    // valid, so both sharers resolve and the index is admitted.
    await appendRecords(filePath, record('u3', 'u2', 'appended'));
    releaseBuild!();
    const [initPage, waitPage] = await Promise.all([initiator, waiter]);
    expect(uuids(initPage.records)).toEqual(['a1']);
    expect(uuids(waitPage.records)).toEqual(['a1']);
    expect(getSessionTranscriptIndexCacheStatsForTest().entries).toBe(1);
    const builds = countBuilds(filePath);
    await readAfter(reader, state, { limit: 1 });
    expect(builds.count).toBe(0);
  });

  it('serves a built page uncached when the admission stat fails transiently', async () => {
    const filePath = await writeRecords(chain('hello', 'reply'));
    const reader = newReader();
    setSessionTranscriptIndexBuildCompleteHookForTest((builtPath) => {
      if (builtPath === filePath) statFault.failNextWith = 'EACCES';
    });
    const page = await reader.readPage(sessionId, { limit: 1 });
    expect(uuids(page.records)).toEqual(['u1']);
    expect(getSessionTranscriptIndexCacheStatsForTest().entries).toBe(0);
  });

  it('runs the reclaim branch without a second stat that can fail uncaught', async () => {
    setSessionTranscriptIndexCacheMaxBytesForTest(1);
    const reader = newReader();
    const filePath = await writeRecords(
      linear('large-', 0, 19, null, (i) => `large transcript ${i}`),
    );
    await reader.readPage(sessionId, { limit: 1 });
    const targetBytes = getSessionTranscriptIndexCacheStatsForTest().byteSize;
    clearSessionTranscriptIndexCacheEntriesForTest();
    await writeRecords(
      linear(
        'filler-',
        0,
        19,
        null,
        (i) => `filler transcript ${i}`,
        otherSessionId,
      ),
      otherSessionId,
    );
    await reader.readPage(otherSessionId, { limit: 1 });
    const fillerBytes = getSessionTranscriptIndexCacheStatsForTest().byteSize;
    // The class holds the filler but not filler + target, so admission
    // enters the reclaim branch and refuses (no superseded same-file
    // entry). The third stat on this path would be a second admission
    // stat after readPage's and the re-verification's; the synchronous
    // tail never issues it, so the injected fault must not fire.
    setSessionTranscriptIndexCacheOversizedMaxBytesForTest(
      fillerBytes + targetBytes - 1,
    );
    statFault.pathCalls.delete(filePath);
    statFault.failOnCall = { path: filePath, call: 3, code: 'EIO' };
    const page = await reader.readPage(sessionId, { limit: 1 });
    expect(uuids(page.records)).toEqual(['large-0']);
    expect(getSessionTranscriptIndexCacheStatsForTest().entries).toBe(1);
    expect(
      mockDebugLogger.debug.mock.calls.some((call) =>
        String(call[0]).includes('index cache skipped byte-budget admission'),
      ),
    ).toBe(true);
  });

  it('serves frozen sharers the frozen snapshot when a rewrite lands after the re-verification', async () => {
    const reader = newReader();
    const filePath = await writeRecords(
      linear('large-', 0, 19, null, (i) => `large transcript ${i}`),
    );
    const warm = await reader.readPage(sessionId, { limit: 1 });
    const state = warm.nextCursorState!;
    const oldBytes = getSessionTranscriptIndexCacheStatsForTest().byteSize;
    await writeRecords(
      linear(
        'filler-',
        0,
        19,
        null,
        (i) => `filler transcript ${i}`,
        otherSessionId,
      ),
      otherSessionId,
    );
    await reader.readPage(otherSessionId, { limit: 1 });
    const fillerBytes =
      getSessionTranscriptIndexCacheStatsForTest().byteSize - oldBytes;
    clearSessionTranscriptIndexCacheEntriesForTest();
    await reader.readPage(otherSessionId, { limit: 1 });
    // The filler occupies the class so the stale completion enters the
    // reclaim branch; a second admission stat there would suspend after
    // the re-verification already passed.
    setSessionTranscriptIndexCacheMaxBytesForTest(1);
    setSessionTranscriptIndexCacheOversizedMaxBytesForTest(
      fillerBytes + oldBytes - 1,
    );
    let releaseBuild: (() => void) | undefined;
    const buildBlocked = new Promise<void>((resolve) => {
      releaseBuild = resolve;
    });
    let firstBuild = true;
    let newerBuilds = 0;
    setSessionTranscriptIndexBuildCompleteHookForTest(async (builtPath) => {
      if (builtPath !== filePath) return;
      if (firstBuild) {
        firstBuild = false;
        await buildBlocked;
        return;
      }
      newerBuilds++;
    });
    const initiator = readAfter(reader, state, { limit: 6 });
    await vi.waitFor(() => expect(firstBuild).toBe(false));
    const waiter = readAfter(reader, state, { limit: 6 });
    void initiator.catch(() => {});
    void waiter.catch(() => {});
    await vi.waitFor(() =>
      expect(
        mockDebugLogger.debug.mock.calls.some((call) =>
          String(call[0]).includes('index cache pending hit'),
        ),
      ).toBe(true),
    );
    // The second stat on this path after the reset would be a reclaim
    // stat issued after the re-verification already passed. Before it
    // runs, rewrite the file equal-size at an advanced mtime and read the
    // newer snapshot, exactly the reviewer's interleaving. The
    // synchronous tail never issues that stat, so the rewrite can only
    // land before the re-verification (which fails every sharer closed)
    // or after the admission (the documented live-body residual).
    statFault.pathCalls.delete(filePath);
    statFault.beforeCall = {
      path: filePath,
      call: 2,
      action: async () => {
        const raw = await fs.readFile(filePath, 'utf8');
        const rewritten = raw.replace(
          '"text":"large transcript 5"',
          '"text":"LARGE transcript 5"',
        );
        expect(Buffer.byteLength(rewritten, 'utf8')).toBe(
          Buffer.byteLength(raw, 'utf8'),
        );
        await fs.writeFile(filePath, rewritten, 'utf8');
        await fs.utimes(filePath, new Date(), new Date(Date.now() + 60000));
        await reader.readPage(sessionId, { limit: 1 });
        await reader.readPage(sessionId, { limit: 1 });
      },
    };
    releaseBuild!();
    const [initPage, waitPage] = await Promise.all([initiator, waiter]);
    statFault.beforeCall = null;
    // The frozen pages serve the frozen snapshot, and the newer snapshot
    // was never built under the stale completion.
    expect(uuids(initPage.records)).toEqual([
      'large-1',
      'large-2',
      'large-3',
      'large-4',
      'large-5',
      'large-6',
    ]);
    expect(initPage.records[4]!.message?.parts?.[0]).toMatchObject({
      text: 'large transcript 5',
    });
    expect(uuids(waitPage.records)).toEqual(uuids(initPage.records));
    expect(newerBuilds).toBe(0);
    // The refusal keeps the filler; the frozen build returns uncached.
    expect(getSessionTranscriptIndexCacheStatsForTest()).toEqual({
      entries: 1,
      byteSize: fillerBytes,
    });
  });

  it('evicts an equal-size replacement orphan at a new inode to admit the live snapshot', async () => {
    setSessionTranscriptIndexCacheMaxBytesForTest(1);
    const reader = newReader();
    const filePath = await writeRecords(
      linear('large-', 0, 19, null, (i) => `large transcript ${i}`),
    );
    // Whole-millisecond mtime: utimes rounds sub-ms precision, which would
    // let the mtime arm see the replacement and mask the identity arm.
    await pinMtime(filePath);
    await reader.readPage(sessionId, { limit: 1 });
    const oldBytes = getSessionTranscriptIndexCacheStatsForTest().byteSize;
    const frozen = await fs.stat(filePath);
    // Same-size replacement at a new inode with the mtime pinned to the
    // frozen value: only the identity arm of the orphan predicate sees it.
    const raw = await fs.readFile(filePath, 'utf8');
    const replaced = raw.replace(
      '"text":"large transcript 5"',
      '"text":"LARGE transcript 5"',
    );
    expect(Buffer.byteLength(replaced, 'utf8')).toBe(
      Buffer.byteLength(raw, 'utf8'),
    );
    const tempPath = `${filePath}.replacement`;
    await fs.writeFile(tempPath, replaced, 'utf8');
    await fs.utimes(tempPath, frozen.atime, frozen.mtime);
    await fs.rename(tempPath, filePath);
    setSessionTranscriptIndexCacheOversizedMaxBytesForTest(oldBytes + 1);
    const builds = countBuilds(filePath);
    await reader.readPage(sessionId, { limit: 1 });
    await reader.readPage(sessionId, { limit: 1 });
    expect(builds.count).toBe(1);
    expect(getSessionTranscriptIndexCacheStatsForTest()).toEqual({
      entries: 1,
      byteSize: oldBytes,
    });
  });

  it('evicts a truncated longer prefix to admit the live snapshot when the class is full', async () => {
    setSessionTranscriptIndexCacheMaxBytesForTest(1);
    const reader = newReader();
    const filePath = await writeRecords(
      linear('large-', 0, 19, null, (i) => `large transcript ${i}`),
    );
    // Pin the mtime and restore it after the truncation: a same-millisecond
    // truncation keeps the mtime on fast filesystems, so the reclaim must
    // come from the current-file-length clause, not temporal order.
    await pinMtime(filePath);
    await reader.readPage(sessionId, { limit: 1 });
    const oldBytes = getSessionTranscriptIndexCacheStatsForTest().byteSize;
    const frozen = await fs.stat(filePath);
    const raw = await fs.readFile(filePath, 'utf8');
    const lines = raw.trimEnd().split('\n');
    await fs.writeFile(filePath, lines.slice(0, 10).join('\n') + '\n');
    await fs.utimes(filePath, frozen.atime, frozen.mtime);
    setSessionTranscriptIndexCacheOversizedMaxBytesForTest(oldBytes + 1);
    const builds = countBuilds(filePath);
    await reader.readPage(sessionId, { limit: 1 });
    await reader.readPage(sessionId, { limit: 1 });
    expect(builds.count).toBe(1);
    const after = getSessionTranscriptIndexCacheStatsForTest();
    expect(after.entries).toBe(1);
    expect(after.byteSize).toBeLessThan(oldBytes);
  });

  it('evicts a truncated longer prefix at advanced mtime to admit the live snapshot', async () => {
    setSessionTranscriptIndexCacheMaxBytesForTest(1);
    const reader = newReader();
    const filePath = await writeRecords(
      linear('large-', 0, 19, null, (i) => `large transcript ${i}`),
    );
    await pinMtime(filePath);
    await reader.readPage(sessionId, { limit: 1 });
    const oldBytes = getSessionTranscriptIndexCacheStatsForTest().byteSize;
    const frozen = await fs.stat(filePath);
    const raw = await fs.readFile(filePath, 'utf8');
    const lines = raw.trimEnd().split('\n');
    await fs.writeFile(filePath, lines.slice(0, 10).join('\n') + '\n');
    await fs.utimes(filePath, frozen.atime, new Date(frozen.mtimeMs + 60000));
    setSessionTranscriptIndexCacheOversizedMaxBytesForTest(oldBytes + 1);
    const builds = countBuilds(filePath);
    await reader.readPage(sessionId, { limit: 1 });
    await reader.readPage(sessionId, { limit: 1 });
    expect(builds.count).toBe(1);
    expect(getSessionTranscriptIndexCacheStatsForTest().entries).toBe(1);
  });

  it('evicts a backup replacement that restored an older mtime', async () => {
    setSessionTranscriptIndexCacheMaxBytesForTest(1);
    const reader = newReader();
    const filePath = await writeRecords(
      linear('large-', 0, 19, null, (i) => `large transcript ${i}`),
    );
    await pinMtime(filePath);
    await reader.readPage(sessionId, { limit: 1 });
    const oldBytes = getSessionTranscriptIndexCacheStatsForTest().byteSize;
    const frozen = await fs.stat(filePath);
    // Grown replacement at a new inode whose backup mtime is older than
    // the original: neither temporal order nor the size/mtime clauses can
    // see it (the entry is smaller than the current file and older-mtime
    // comparisons point the wrong way); only the identity clause can.
    const raw = await fs.readFile(filePath, 'utf8');
    const grown =
      raw +
      JSON.stringify(record('u21', 'large-19', 'replacement extra')) +
      '\n';
    const tempPath = `${filePath}.replacement`;
    await fs.writeFile(tempPath, grown, 'utf8');
    await fs.utimes(tempPath, frozen.atime, new Date(frozen.mtimeMs - 60000));
    await fs.rename(tempPath, filePath);
    setSessionTranscriptIndexCacheOversizedMaxBytesForTest(oldBytes + 2048);
    const builds = countBuilds(filePath);
    await reader.readPage(sessionId, { limit: 1 });
    await reader.readPage(sessionId, { limit: 1 });
    expect(builds.count).toBe(1);
    expect(getSessionTranscriptIndexCacheStatsForTest().entries).toBe(1);
  });

  it('evicts an equal-size rewrite whose mtime moved backwards', async () => {
    setSessionTranscriptIndexCacheMaxBytesForTest(1);
    const reader = newReader();
    const filePath = await writeRecords(
      linear('large-', 0, 19, null, (i) => `large transcript ${i}`),
    );
    await pinMtime(filePath);
    await reader.readPage(sessionId, { limit: 1 });
    const oldBytes = getSessionTranscriptIndexCacheStatsForTest().byteSize;
    const frozen = await fs.stat(filePath);
    const raw = await fs.readFile(filePath, 'utf8');
    const replaced = raw.replace(
      '"text":"large transcript 5"',
      '"text":"LARGE transcript 5"',
    );
    await fs.writeFile(filePath, replaced, 'utf8');
    await fs.utimes(filePath, frozen.atime, new Date(frozen.mtimeMs - 60000));
    setSessionTranscriptIndexCacheOversizedMaxBytesForTest(oldBytes + 1);
    const builds = countBuilds(filePath);
    await reader.readPage(sessionId, { limit: 1 });
    await reader.readPage(sessionId, { limit: 1 });
    expect(builds.count).toBe(1);
    expect(getSessionTranscriptIndexCacheStatsForTest().entries).toBe(1);
  });

  it('evicts a superseded shared-class prefix of the same file', async () => {
    const reader = newReader();
    const filePath = await writeRecords(
      linear('large-', 0, 19, null, (i) => `large transcript ${i}`),
    );
    const first = await reader.readPage(sessionId, { limit: 1 });
    const oldState = first.nextCursorState!;
    const v1Bytes = getSessionTranscriptIndexCacheStatsForTest().byteSize;
    await appendRecords(filePath, record('u21', 'large-19', 'appended'));
    await reader.readPage(sessionId, { limit: 1 });
    const v2Bytes =
      getSessionTranscriptIndexCacheStatsForTest().byteSize - v1Bytes;
    expect(v2Bytes).toBeGreaterThan(v1Bytes);
    clearSessionTranscriptIndexCacheEntriesForTest();
    // Both snapshots stay shared-class; together they exceed the budget.
    setSessionTranscriptIndexCacheMaxBytesForTest(v2Bytes + 1);
    await readAfter(reader, oldState, { limit: 1 });
    const builds = countBuilds(filePath);
    await reader.readPage(sessionId, { limit: 1 });
    await reader.readPage(sessionId, { limit: 1 });
    expect(builds.count).toBe(1);
    expect(getSessionTranscriptIndexCacheStatsForTest().byteSize).toBe(v2Bytes);
  });

  it('does not evict a shared prefix of the same file when admitting an oversized snapshot', async () => {
    const reader = newReader();
    const filePath = await writeRecords(chain('hello', 'reply'));
    const first = await reader.readPage(sessionId, { limit: 1 });
    const oldState = first.nextCursorState!;
    const sharedBytes = getSessionTranscriptIndexCacheStatsForTest().byteSize;
    await writeRecords(
      linear(
        'large-',
        0,
        19,
        null,
        (i) => `large transcript ${i}`,
        otherSessionId,
      ),
      otherSessionId,
    );
    await reader.readPage(otherSessionId, { limit: 1 });
    const largeBytes =
      getSessionTranscriptIndexCacheStatsForTest().byteSize - sharedBytes;
    await appendRecords(
      filePath,
      ...linear('grow-', 0, 19, 'a1', (i) => `grown ${i}`),
    );
    // Calibrate under the default budget: the grown small-file index must fit
    // the oversized cap alone (so admission reaches the class-total eviction
    // branch, not the single-entry cap) while the other file's index fills it.
    await reader.readPage(sessionId, { limit: 1 });
    const newBytes =
      getSessionTranscriptIndexCacheStatsForTest().byteSize -
      sharedBytes -
      largeBytes;
    expect(newBytes).toBeGreaterThan(0);
    expect(newBytes).toBeGreaterThan(largeBytes);
    clearSessionTranscriptIndexCacheEntriesForTest();
    setSessionTranscriptIndexCacheMaxBytesForTest(sharedBytes);
    setSessionTranscriptIndexCacheOversizedMaxBytesForTest(newBytes + 1);
    await readAfter(reader, oldState, { limit: 1 });
    await reader.readPage(otherSessionId, { limit: 1 });
    expect(getSessionTranscriptIndexCacheStatsForTest().byteSize).toBe(
      sharedBytes + largeBytes,
    );
    const builds = countBuilds(filePath);
    await reader.readPage(sessionId, { limit: 1 });
    expect(builds.count).toBe(1);
    expect(getSessionTranscriptIndexCacheStatsForTest().byteSize).toBe(
      sharedBytes + largeBytes,
    );
    const oldPage = await readAfter(reader, oldState, { limit: 1 });
    expect(uuids(oldPage.records)).toEqual(['a1']);
  });

  it('evicts a superseded prefix when a restore-built index is offered under a full class budget', async () => {
    setSessionTranscriptIndexCacheMaxBytesForTest(1);
    const reader = newReader();
    const filePath = await writeRecords(
      linear('large-', 0, 19, null, (i) => `large transcript ${i}`),
    );
    const first = await reader.readPage(sessionId, { limit: 1 });
    const oldState = first.nextCursorState!;
    const oldBytes = getSessionTranscriptIndexCacheStatsForTest().byteSize;
    await appendRecords(filePath, record('u21', 'large-19', 'appended'));
    await reader.readPage(sessionId, { limit: 1 });
    const newBytes =
      getSessionTranscriptIndexCacheStatsForTest().byteSize - oldBytes;
    clearSessionTranscriptIndexCacheEntriesForTest();
    setSessionTranscriptIndexCacheOversizedMaxBytesForTest(newBytes + 1);
    await readAfter(reader, oldState, { limit: 1 });
    const builds = countBuilds(filePath);
    await expect(
      reader.readRestoreProjection(sessionId, NONE),
    ).resolves.toBeDefined();
    await reader.readPage(sessionId, { limit: 1 });
    expect(builds.count).toBe(1);
    expect(getSessionTranscriptIndexCacheStatsForTest().byteSize).toBe(
      newBytes,
    );
  });

  it.each([
    ['oversized', true],
    ['shared', false],
  ] as const)(
    'keeps a superseded prefix cached when the newer snapshot cannot fit even after reclaiming it (%s class)',
    async (_label, forceOversized) => {
      const reader = newReader();
      const large = (i: number) => `large transcript ${i}`;
      const filePath = await writeRecords(linear('large-', 0, 19, null, large));
      const first = await reader.readPage(sessionId, { limit: 1 });
      const oldState = first.nextCursorState!;
      const oldBytes = getSessionTranscriptIndexCacheStatsForTest().byteSize;
      await writeRecords(
        linear('other-', 0, 19, null, large, otherSessionId),
        otherSessionId,
      );
      await reader.readPage(otherSessionId, { limit: 1 });
      const otherBytes =
        getSessionTranscriptIndexCacheStatsForTest().byteSize - oldBytes;
      await appendRecords(filePath, record('u21', 'large-19', 'appended'));
      // Calibrate the grown estimate under the default budget: it exceeds
      // the old prefix, so the class budget that fits old+other exactly
      // cannot admit the new snapshot even after reclaiming the old one.
      await reader.readPage(sessionId, { limit: 1 });
      const newBytes =
        getSessionTranscriptIndexCacheStatsForTest().byteSize -
        oldBytes -
        otherBytes;
      expect(newBytes).toBeGreaterThan(oldBytes);
      clearSessionTranscriptIndexCacheEntriesForTest();
      if (forceOversized) {
        setSessionTranscriptIndexCacheMaxBytesForTest(1);
        setSessionTranscriptIndexCacheOversizedMaxBytesForTest(
          oldBytes + otherBytes,
        );
      } else {
        setSessionTranscriptIndexCacheMaxBytesForTest(oldBytes + otherBytes);
      }
      await readAfter(reader, oldState, { limit: 1 });
      await reader.readPage(otherSessionId, { limit: 1 });
      expect(getSessionTranscriptIndexCacheStatsForTest().byteSize).toBe(
        oldBytes + otherBytes,
      );
      const builds = countBuilds(filePath);
      await reader.readPage(sessionId, { limit: 1 });
      expect(builds.count).toBe(1);
      // The refusal must not evict the superseded prefix: its frozen cursor
      // still reads the original prefix without a rebuild.
      expect(getSessionTranscriptIndexCacheStatsForTest().byteSize).toBe(
        oldBytes + otherBytes,
      );
      const oldPage = await readAfter(reader, oldState, { limit: 1 });
      expect(builds.count).toBe(1);
      expect(uuids(oldPage.records)).toEqual(['large-1']);
    },
  );

  it('evicts a superseded shared-class prefix when a restore-built index is offered under a full shared budget', async () => {
    const reader = newReader();
    const filePath = await writeRecords(
      linear('large-', 0, 19, null, (i) => `large transcript ${i}`),
    );
    const first = await reader.readPage(sessionId, { limit: 1 });
    const oldState = first.nextCursorState!;
    const oldBytes = getSessionTranscriptIndexCacheStatsForTest().byteSize;
    await appendRecords(filePath, record('u21', 'large-19', 'appended'));
    await reader.readPage(sessionId, { limit: 1 });
    const newBytes =
      getSessionTranscriptIndexCacheStatsForTest().byteSize - oldBytes;
    expect(newBytes).toBeGreaterThan(oldBytes);
    clearSessionTranscriptIndexCacheEntriesForTest();
    // Both snapshots stay shared-class; together they exceed the budget.
    setSessionTranscriptIndexCacheMaxBytesForTest(newBytes + 1);
    await readAfter(reader, oldState, { limit: 1 });
    const builds = countBuilds(filePath);
    await expect(
      reader.readRestoreProjection(sessionId, NONE),
    ).resolves.toBeDefined();
    await reader.readPage(sessionId, { limit: 1 });
    expect(builds.count).toBe(1);
    expect(getSessionTranscriptIndexCacheStatsForTest().byteSize).toBe(
      newBytes,
    );
  });

  it('keeps a superseded prefix cached when a restore offer cannot fit even after reclaiming it', async () => {
    setSessionTranscriptIndexCacheMaxBytesForTest(1);
    const reader = newReader();
    const large = (i: number) => `large transcript ${i}`;
    const filePath = await writeRecords(linear('large-', 0, 19, null, large));
    const first = await reader.readPage(sessionId, { limit: 1 });
    const oldState = first.nextCursorState!;
    const oldBytes = getSessionTranscriptIndexCacheStatsForTest().byteSize;
    await writeRecords(
      linear('other-', 0, 19, null, large, otherSessionId),
      otherSessionId,
    );
    await reader.readPage(otherSessionId, { limit: 1 });
    const otherBytes =
      getSessionTranscriptIndexCacheStatsForTest().byteSize - oldBytes;
    await appendRecords(filePath, record('u21', 'large-19', 'appended'));
    await reader.readPage(sessionId, { limit: 1 });
    const newBytes =
      getSessionTranscriptIndexCacheStatsForTest().byteSize -
      oldBytes -
      otherBytes;
    expect(newBytes).toBeGreaterThan(oldBytes);
    clearSessionTranscriptIndexCacheEntriesForTest();
    setSessionTranscriptIndexCacheOversizedMaxBytesForTest(
      oldBytes + otherBytes,
    );
    await readAfter(reader, oldState, { limit: 1 });
    await reader.readPage(otherSessionId, { limit: 1 });
    const builds = countBuilds(filePath);
    await expect(
      reader.readRestoreProjection(sessionId, NONE),
    ).resolves.toBeDefined();
    // The offer builds the new index once but must not evict the old prefix
    // it cannot replace.
    expect(builds.count).toBe(1);
    expect(getSessionTranscriptIndexCacheStatsForTest().byteSize).toBe(
      oldBytes + otherBytes,
    );
    await readAfter(reader, oldState, { limit: 1 });
    expect(builds.count).toBe(1);
  });

  it.each(['shared', 'oversized'] as const)(
    'offers a newer snapshot into a full count cap by reclaiming the superseded entry (%s class)',
    async (klass) => {
      if (klass === 'oversized') {
        setSessionTranscriptIndexCacheMaxBytesForTest(1);
      }
      const reader = newReader();
      const filePath = await writeRecords(chain('hello', 'reply'));
      await reader.readPage(sessionId, { limit: 1 });
      // Fill the global 32-entry count cap (the byte budget stays roomy).
      for (let i = 0; i < 31; i++) {
        const sid = `770e8400-e29b-41d4-a716-${String(i).padStart(12, '0')}`;
        await writeRecords(
          linear('f-', 0, 1, null, () => 'filler', sid),
          sid,
        );
        await reader.readPage(sid, { limit: 1 });
      }
      expect(getSessionTranscriptIndexCacheStatsForTest().entries).toBe(32);
      await appendRecords(filePath, record('u2', 'a1', 'appended'));
      const builds = countBuilds(filePath);
      await expect(
        reader.readRestoreProjection(sessionId, NONE),
      ).resolves.toBeDefined();
      // The offer reclaimed the superseded slot instead of overflowing the
      // cap (the offer door does not run the count prune itself).
      expect(getSessionTranscriptIndexCacheStatsForTest().entries).toBe(32);
      // The next page hits the offered index.
      await reader.readPage(sessionId, { limit: 1 });
      expect(builds.count).toBe(1);
    },
  );

  it('offers into a full count cap by reclaiming a superseded entry in the other class', async () => {
    const reader = newReader();
    const large = (i: number) => `large transcript ${i}`;
    const filePath = await writeRecords(linear('large-', 0, 1999, null, large));
    const oldRaw = await fs.readFile(filePath, 'utf8');
    await reader.readPage(sessionId, { limit: 1 });
    const oldBytes = getSessionTranscriptIndexCacheStatsForTest().byteSize;
    // Truncate to half the records: the new estimate is shared-class once
    // the shared budget is tightened below the old oversized estimate.
    const lines = oldRaw.trimEnd().split('\n');
    const newRaw = lines.slice(0, 1000).join('\n') + '\n';
    await fs.writeFile(filePath, newRaw);
    await reader.readPage(sessionId, { limit: 1 });
    const newBytes =
      getSessionTranscriptIndexCacheStatsForTest().byteSize - oldBytes;
    // 31 one-record fillers, all shared-class. Calibrate the filler
    // estimate from a single read: reading all 31 here would push the map
    // past the count cap and LRU-evict the old/new entries being measured.
    const fillerSids: string[] = [];
    for (let i = 0; i < 31; i++) {
      fillerSids.push(`770e8400-e29b-41d4-a716-${String(i).padStart(12, '0')}`);
    }
    const beforeFiller = getSessionTranscriptIndexCacheStatsForTest().byteSize;
    await writeRecords(
      linear('f-', 0, 0, null, () => 'filler', fillerSids[0]),
      fillerSids[0],
    );
    await reader.readPage(fillerSids[0], { limit: 1 });
    const fillerBytes =
      getSessionTranscriptIndexCacheStatsForTest().byteSize - beforeFiller;
    const fillersTotal = fillerBytes * 31;
    clearSessionTranscriptIndexCacheEntriesForTest();
    // Shared budget fits the new index plus the fillers exactly, and stays
    // below the old estimate so the old prefix is oversized-class.
    setSessionTranscriptIndexCacheMaxBytesForTest(newBytes + fillersTotal);
    expect(oldBytes).toBeGreaterThan(newBytes + fillersTotal);
    // Re-cache the old (oversized) prefix, then fill the count cap.
    await fs.writeFile(filePath, oldRaw);
    await reader.readPage(sessionId, { limit: 1 });
    for (const sid of fillerSids) {
      await writeRecords(
        linear('f-', 0, 0, null, () => 'filler', sid),
        sid,
      );
      await reader.readPage(sid, { limit: 1 });
    }
    expect(getSessionTranscriptIndexCacheStatsForTest().entries).toBe(32);
    // Truncate again and offer the new shared-class snapshot: the count
    // slot must come from the superseded oversized entry (other class).
    await fs.writeFile(filePath, newRaw);
    const builds = countBuilds(filePath);
    await expect(
      reader.readRestoreProjection(sessionId, NONE),
    ).resolves.toBeDefined();
    expect(getSessionTranscriptIndexCacheStatsForTest().entries).toBe(32);
    await reader.readPage(sessionId, { limit: 1 });
    expect(builds.count).toBe(1);
  });

  it('accounts a restore-offered Managed projection against the index budget class', async () => {
    const bigText = 'x'.repeat(256 * 1024);
    const { authority } = await openManagedFixture([
      { uuid: 'u1', parent: null, text: 'short prompt' },
      { uuid: 'a1', parent: 'u1', text: 'short reply' },
      { uuid: 'u2', parent: 'a1', text: bigText },
    ]);
    await authority.close();

    const reader = newReader();
    await reader.readTurnHooksPage(sessionId, 'legacy-record:u1');
    const physicalBytes = getSessionTranscriptIndexCacheStatsForTest().byteSize;
    expect(physicalBytes).toBeGreaterThan(0);
    setSessionTranscriptIndexCacheMaxBytesForTest(1);
    setSessionTranscriptIndexCacheOversizedMaxBytesForTest(
      physicalBytes + 1024,
    );
    // Clear so the restore offer does not early-return on an existing key.
    clearSessionTranscriptIndexCacheEntriesForTest();
    projectionReads.count = 0;
    await expect(
      reader.readRestoreProjection(sessionId, NONE),
    ).resolves.toBeDefined();
    expect(projectionReads.count).toBe(1);
    expect(getSessionTranscriptIndexCacheStatsForTest().byteSize).toBe(
      physicalBytes,
    );
    await reader.readPage(sessionId, { limit: 3 });
    expect(projectionReads.count).toBe(2);

    clearSessionTranscriptIndexCacheEntriesForTest();
    setSessionTranscriptIndexCacheOversizedMaxBytesForTest(256 * 1024 * 1024);
    projectionReads.count = 0;
    await expect(
      reader.readRestoreProjection(sessionId, NONE),
    ).resolves.toBeDefined();
    expect(projectionReads.count).toBe(1);
    expect(
      getSessionTranscriptIndexCacheStatsForTest().byteSize,
    ).toBeGreaterThan(physicalBytes + bigText.length);
    await reader.readPage(sessionId, { limit: 3 });
    expect(projectionReads.count).toBe(1);
  });

  it('rejects Managed replay.kind=all when projected bodies exceed the replay budget', async () => {
    const { authority } = await openManagedFixture([
      { uuid: 'u1', parent: null, text: 'prompt' },
      { uuid: 'a1', parent: 'u1', text: 'x'.repeat(4096) },
    ]);
    await authority.close();

    setSessionTranscriptMaxAllReplayBytesForTest(1);
    try {
      await expect(
        newReader().readRestoreProjection(sessionId, all(false)),
      ).rejects.toMatchObject({ dimension: 'replay' });
      await expect(
        newReader().readLiveRestoreProjection(sessionId, all(false)),
      ).rejects.toMatchObject({ dimension: 'replay' });
    } finally {
      setSessionTranscriptMaxAllReplayBytesForTest(undefined);
    }
  });

  it('stops Managed all-replay before reading a body past the byte budget', async () => {
    const first = record('u1', null, 'a'.repeat(2048));
    const second = record('a1', 'u1', 'b'.repeat(2048));
    const third = record('u2', 'a1', 'c'.repeat(2048));
    const { file, authority, store, sessionKey } = await openManagedFixture([
      { uuid: first.uuid, parent: null, text: 'a'.repeat(2048) },
      { uuid: second.uuid, parent: first.uuid, text: 'b'.repeat(2048) },
      { uuid: third.uuid, parent: second.uuid, text: 'c'.repeat(2048) },
    ]);
    await authority.close();
    const scan = await readManagedSessionLog({
      transcriptPath: file,
      runtimeBaseDir: runtimeDir,
      sessionKey,
    });
    const bodies = scan.events
      .map((event) => managedSessionReaderFacingBody(event))
      .filter((body) => body !== undefined);
    expect(bodies).toHaveLength(3);
    const thirdRef = assertManagedSessionDurableRef(
      bodies[2]!.ref,
      'third body ref',
    );
    await fs.unlink(
      path.join(store.sessionRoot, thirdRef.kind, thirdRef.resourceId),
    );
    const firstBytes = Buffer.byteLength(JSON.stringify(first), 'utf8');
    setSessionTranscriptMaxAllReplayBytesForTest(firstBytes + 1);
    try {
      // If maxBodyBytes is not wired for replay.kind=all, projection reaches
      // the now-missing third body and surfaces snapshot-unavailable instead.
      await expect(
        newReader().readRestoreProjection(sessionId, all(false)),
      ).rejects.toMatchObject({ dimension: 'replay' });
    } finally {
      setSessionTranscriptMaxAllReplayBytesForTest(undefined);
    }
  });

  it('retains a projection that moves its entry from the shared into the oversized class', async () => {
    const bigText = 'x'.repeat(256 * 1024);
    const { authority } = await openManagedFixture([
      { uuid: 'u1', parent: null, text: 'short prompt' },
      { uuid: 'a1', parent: 'u1', text: 'short reply' },
      { uuid: 'u2', parent: 'a1', text: bigText },
    ]);
    await authority.close();

    const reader = newReader();
    await reader.readTurnHooksPage(sessionId, 'legacy-record:u1');
    const physicalBytes = getSessionTranscriptIndexCacheStatsForTest().byteSize;
    expect(physicalBytes).toBeGreaterThan(0);
    // The physical index fits the shared budget; the decoded bodies push
    // the combined entry past it while the oversized class has room. The
    // class must follow the post-add total, or every page re-projects.
    setSessionTranscriptIndexCacheMaxBytesForTest(physicalBytes + 1024);
    clearSessionTranscriptIndexCacheEntriesForTest();
    projectionReads.count = 0;
    await reader.readPage(sessionId, { limit: 3 });
    expect(projectionReads.count).toBe(1);
    const accounted = getSessionTranscriptIndexCacheStatsForTest().byteSize;
    expect(accounted).toBeGreaterThan(physicalBytes + bigText.length);
    expect(accounted).toBeGreaterThan(physicalBytes + 1024);
    await reader.readPage(sessionId, { limit: 3 });
    expect(projectionReads.count).toBe(1);

    // The restore-offer door accounts the same crossing.
    clearSessionTranscriptIndexCacheEntriesForTest();
    projectionReads.count = 0;
    await expect(
      reader.readRestoreProjection(sessionId, NONE),
    ).resolves.toBeDefined();
    expect(projectionReads.count).toBe(1);
    expect(getSessionTranscriptIndexCacheStatsForTest().byteSize).toBe(
      accounted,
    );
    await reader.readPage(sessionId, { limit: 3 });
    expect(projectionReads.count).toBe(1);
  });

  it('accounts projections decoded by concurrent pages against the class budget', async () => {
    const bigText = 'x'.repeat(256 * 1024);
    const { file, authority } = await openManagedFixture([
      { uuid: 'u1', parent: null, text: 'short prompt' },
      { uuid: 'a1', parent: 'u1', text: 'short reply' },
      { uuid: 'u2', parent: 'a1', text: bigText },
    ]);
    try {
      const reader = newReader();
      await reader.readTurnHooksPage(sessionId, 'legacy-record:u1');
      const physicalBytes =
        getSessionTranscriptIndexCacheStatsForTest().byteSize;
      expect(physicalBytes).toBeGreaterThan(0);
      setSessionTranscriptIndexCacheMaxBytesForTest(1);
      setSessionTranscriptIndexCacheOversizedMaxBytesForTest(
        physicalBytes + 1024,
      );
      clearSessionTranscriptIndexCacheEntriesForTest();
      // Pause the admission stat so a second page shares the pending build
      // and can attach its projection before the index is admitted.
      let releaseVerify: (() => void) | undefined;
      const verifyBlocked = new Promise<void>((resolve) => {
        releaseVerify = resolve;
      });
      let armed = true;
      setSessionTranscriptIndexBuildCompleteHookForTest((builtPath) => {
        if (builtPath === file && armed) {
          armed = false;
          statFault.pauseNext = verifyBlocked;
        }
      });
      projectionReads.count = 0;
      const first = reader.readPage(sessionId, { limit: 3 });
      await vi.waitFor(() => expect(armed).toBe(false));
      const second = reader.readPage(sessionId, { limit: 3 });
      releaseVerify!();
      await Promise.all([first, second]);
      // The bodies do not fit the class budget: the entry stays at the
      // physical estimate and the next page must re-decode them.
      expect(getSessionTranscriptIndexCacheStatsForTest().byteSize).toBe(
        physicalBytes,
      );
      expect(projectionReads.count).toBe(2);
      await reader.readPage(sessionId, { limit: 3 });
      expect(projectionReads.count).toBe(3);
      expect(getSessionTranscriptIndexCacheStatsForTest().byteSize).toBe(
        physicalBytes,
      );
    } finally {
      await authority.close();
    }
  });

  it('reclaims a superseded projection when a newer snapshot crosses into the oversized class', async () => {
    const bigText = 'x'.repeat(256 * 1024);
    const { authority, commit } = await openManagedFixture([
      { uuid: 'u1', parent: null, text: 'short prompt' },
      { uuid: 'a1', parent: 'u1', text: 'short reply' },
      { uuid: 'u2', parent: 'a1', text: bigText },
    ]);
    try {
      const reader = newReader();
      await reader.readTurnHooksPage(sessionId, 'legacy-record:u1');
      const physicalBytes =
        getSessionTranscriptIndexCacheStatsForTest().byteSize;
      expect(physicalBytes).toBeLessThan(32 * 1024);
      setSessionTranscriptIndexCacheMaxBytesForTest(32 * 1024);
      setSessionTranscriptIndexCacheOversizedMaxBytesForTest(700 * 1024);
      clearSessionTranscriptIndexCacheEntriesForTest();
      projectionReads.count = 0;
      await reader.readPage(sessionId, { limit: 3 });
      const oldTotal = getSessionTranscriptIndexCacheStatsForTest().byteSize;
      expect(oldTotal).toBeGreaterThan(32 * 1024);
      expect(oldTotal).toBeLessThan(700 * 1024);
      await reader.readPage(sessionId, { limit: 3 });
      expect(projectionReads.count).toBe(1);
      // Append a short message: the new physical index fits the shared
      // class, but its projection crosses into the oversized class the old
      // snapshot holds; the crossing must reclaim the superseded entry.
      await commit('a2', 'u2', 'short appended reply');
      await reader.readPage(sessionId, { limit: 4 });
      const newTotal = getSessionTranscriptIndexCacheStatsForTest().byteSize;
      expect(newTotal).toBeGreaterThan(oldTotal);
      expect(getSessionTranscriptIndexCacheStatsForTest().entries).toBe(1);
      const readsAfterNew = projectionReads.count;
      await reader.readPage(sessionId, { limit: 4 });
      expect(projectionReads.count).toBe(readsAfterNew);
      expect(getSessionTranscriptIndexCacheStatsForTest().byteSize).toBe(
        newTotal,
      );
    } finally {
      await authority.close();
    }
  });

  it('does not let a frozen projection retention evict the live newer index', async () => {
    const bigText = 'x'.repeat(256 * 1024);
    const { file, authority, commit } = await openManagedFixture([
      { uuid: 'u1', parent: null, text: 'short prompt' },
      { uuid: 'a1', parent: 'u1', text: 'short reply' },
      { uuid: 'u2', parent: 'a1', text: bigText },
    ]);
    try {
      const reader = newReader();
      await reader.readTurnHooksPage(sessionId, 'legacy-record:u1');
      const physicalBytes =
        getSessionTranscriptIndexCacheStatsForTest().byteSize;
      // Cache the old physical index without its projection: the bodies
      // do not fit the tightened class, so retention is refused.
      setSessionTranscriptIndexCacheMaxBytesForTest(1);
      setSessionTranscriptIndexCacheOversizedMaxBytesForTest(
        physicalBytes + 1024,
      );
      clearSessionTranscriptIndexCacheEntriesForTest();
      const first = await reader.readPage(sessionId, { limit: 1 });
      const oldState = first.nextCursorState!;
      expect(getSessionTranscriptIndexCacheStatsForTest().byteSize).toBe(
        physicalBytes,
      );
      setSessionTranscriptIndexCacheMaxBytesForTest(64 * 1024 * 1024);
      setSessionTranscriptIndexCacheOversizedMaxBytesForTest(256 * 1024 * 1024);
      // Append and cache the live snapshot with its projection retained.
      await commit('a2', 'u2', 'short appended reply');
      await reader.readPage(sessionId, { limit: 1 });
      const liveTotal =
        getSessionTranscriptIndexCacheStatsForTest().byteSize - physicalBytes;
      expect(getSessionTranscriptIndexCacheStatsForTest().entries).toBe(2);
      // Room for the old physical index plus the live entry exactly; the
      // frozen projection on top does not fit.
      setSessionTranscriptIndexCacheMaxBytesForTest(physicalBytes + liveTotal);
      setSessionTranscriptIndexCacheOversizedMaxBytesForTest(1);
      const builds = countBuilds(file);
      projectionReads.count = 0;
      await readAfter(reader, oldState, { limit: 1 });
      // Retention is refused without evicting the live newer index.
      expect(getSessionTranscriptIndexCacheStatsForTest().entries).toBe(2);
      expect(getSessionTranscriptIndexCacheStatsForTest().byteSize).toBe(
        physicalBytes + liveTotal,
      );
      await reader.readPage(sessionId, { limit: 1 });
      expect(builds.count).toBe(0);
      // The projection was not retained: the next frozen read re-decodes.
      expect(projectionReads.count).toBe(1);
      await readAfter(reader, oldState, { limit: 1 });
      expect(projectionReads.count).toBe(2);
    } finally {
      await authority.close();
    }
  });

  it('does not let frozen projection retention evict the live index after an mtime-regressing append', async () => {
    const bigText = 'x'.repeat(256 * 1024);
    const { file, authority, commit } = await openManagedFixture([
      { uuid: 'u1', parent: null, text: 'short prompt' },
      { uuid: 'a1', parent: 'u1', text: 'short reply' },
      { uuid: 'u2', parent: 'a1', text: bigText },
    ]);
    let closed = false;
    try {
      const reader = newReader();
      await reader.readTurnHooksPage(sessionId, 'legacy-record:u1');
      const physicalBytes =
        getSessionTranscriptIndexCacheStatsForTest().byteSize;
      setSessionTranscriptIndexCacheMaxBytesForTest(1);
      setSessionTranscriptIndexCacheOversizedMaxBytesForTest(
        physicalBytes + 1024,
      );
      clearSessionTranscriptIndexCacheEntriesForTest();
      const first = await reader.readPage(sessionId, { limit: 1 });
      const oldState = first.nextCursorState!;
      setSessionTranscriptIndexCacheMaxBytesForTest(64 * 1024 * 1024);
      setSessionTranscriptIndexCacheOversizedMaxBytesForTest(256 * 1024 * 1024);
      // Append, then restore an older source timestamp (in-place sync):
      // the live snapshot's mtime is older than the frozen prefix's.
      const frozen = await fs.stat(file);
      await commit('a2', 'u2', 'short appended reply');
      // Close the writer before restoring the timestamp: the lease seals
      // against the transcript state its own commits produced.
      await authority.close();
      closed = true;
      await fs.utimes(file, frozen.atime, new Date(frozen.mtimeMs - 60000));
      await reader.readPage(sessionId, { limit: 1 });
      const liveTotal =
        getSessionTranscriptIndexCacheStatsForTest().byteSize - physicalBytes;
      expect(getSessionTranscriptIndexCacheStatsForTest().entries).toBe(2);
      setSessionTranscriptIndexCacheMaxBytesForTest(physicalBytes + liveTotal);
      setSessionTranscriptIndexCacheOversizedMaxBytesForTest(1);
      const builds = countBuilds(file);
      projectionReads.count = 0;
      await readAfter(reader, oldState, { limit: 1 });
      // Length, not mtime order: the longer live index is protected even
      // though its mtime is older than the frozen snapshot's.
      expect(getSessionTranscriptIndexCacheStatsForTest().entries).toBe(2);
      expect(getSessionTranscriptIndexCacheStatsForTest().byteSize).toBe(
        physicalBytes + liveTotal,
      );
      await reader.readPage(sessionId, { limit: 1 });
      expect(builds.count).toBe(0);
      expect(projectionReads.count).toBe(1);
    } finally {
      if (!closed) await authority.close();
    }
  });

  it('does not let a frozen projection retention evict a replaced live index at a new inode', async () => {
    const bigText = 'x'.repeat(256 * 1024);
    const { file, authority, commit } = await openManagedFixture([
      { uuid: 'u1', parent: null, text: 'short prompt' },
      { uuid: 'a1', parent: 'u1', text: 'short reply' },
      { uuid: 'u2', parent: 'a1', text: bigText },
    ]);
    let closed = false;
    try {
      const reader = newReader();
      await reader.readTurnHooksPage(sessionId, 'legacy-record:u1');
      const physicalBytes =
        getSessionTranscriptIndexCacheStatsForTest().byteSize;
      setSessionTranscriptIndexCacheMaxBytesForTest(1);
      setSessionTranscriptIndexCacheOversizedMaxBytesForTest(
        physicalBytes + 1024,
      );
      clearSessionTranscriptIndexCacheEntriesForTest();
      const first = await reader.readPage(sessionId, { limit: 1 });
      const oldState = first.nextCursorState!;
      setSessionTranscriptIndexCacheMaxBytesForTest(64 * 1024 * 1024);
      setSessionTranscriptIndexCacheOversizedMaxBytesForTest(256 * 1024 * 1024);
      // Pause the frozen projection decode; while it is suspended, grow
      // the transcript and replace it at a new inode, then cache the live
      // snapshot. The decode's accounting must not treat the frozen
      // identity as the current file state.
      let releaseDecode: (() => void) | undefined;
      const decodeBlocked = new Promise<void>((resolve) => {
        releaseDecode = resolve;
      });
      projectionReads.pause = decodeBlocked;
      projectionReads.count = 0;
      const frozenRead = readAfter(reader, oldState, { limit: 1 });
      await vi.waitFor(() => expect(projectionReads.count).toBe(1));
      await commit('a2', 'u2', 'short appended reply');
      // Close the writer before the replacement: the lease seals against
      // the transcript state its own commits produced.
      await authority.close();
      closed = true;
      const raw = await fs.readFile(file, 'utf8');
      const temp = `${file}.replacement`;
      await fs.writeFile(temp, raw, 'utf8');
      await fs.rename(temp, file);
      await reader.readPage(sessionId, { limit: 1 });
      const liveTotal =
        getSessionTranscriptIndexCacheStatsForTest().byteSize - physicalBytes;
      expect(getSessionTranscriptIndexCacheStatsForTest().entries).toBe(2);
      setSessionTranscriptIndexCacheMaxBytesForTest(physicalBytes + liveTotal);
      setSessionTranscriptIndexCacheOversizedMaxBytesForTest(1);
      const builds = countBuilds(file);
      releaseDecode!();
      await frozenRead;
      // The live index at the new inode survives the refused retention.
      expect(getSessionTranscriptIndexCacheStatsForTest().entries).toBe(2);
      expect(getSessionTranscriptIndexCacheStatsForTest().byteSize).toBe(
        physicalBytes + liveTotal,
      );
      await reader.readPage(sessionId, { limit: 1 });
      expect(builds.count).toBe(0);
    } finally {
      if (!closed) await authority.close();
    }
  });

  it('does not let frozen projection retention evict a shorter replacement live index', async () => {
    const bigText = 'x'.repeat(256 * 1024);
    // The big body sits in the SECOND record: dropping the last record's
    // wrapper pair keeps it in the replacement, and the dropped record's
    // projection bytes are dwarfed by the replacement's physical index,
    // so the frozen growth stays in the shared class and the reclaim
    // branch examines the live entry.
    const { file, authority } = await openManagedFixture([
      { uuid: 'u1', parent: null, text: 'short prompt' },
      { uuid: 'a1', parent: 'u1', text: bigText },
      ...Array.from({ length: 18 }, (_, i) => ({
        uuid: `u${i + 2}`,
        parent: i ? `u${i + 1}` : 'a1',
        text: `filler ${i}`,
      })),
    ]);
    let closed = false;
    try {
      const reader = newReader();
      await reader.readTurnHooksPage(sessionId, 'legacy-record:u1');
      const physicalBytes =
        getSessionTranscriptIndexCacheStatsForTest().byteSize;
      setSessionTranscriptIndexCacheMaxBytesForTest(1);
      setSessionTranscriptIndexCacheOversizedMaxBytesForTest(
        physicalBytes + 1024,
      );
      clearSessionTranscriptIndexCacheEntriesForTest();
      const first = await reader.readPage(sessionId, { limit: 1 });
      const oldState = first.nextCursorState!;
      setSessionTranscriptIndexCacheMaxBytesForTest(64 * 1024 * 1024);
      setSessionTranscriptIndexCacheOversizedMaxBytesForTest(256 * 1024 * 1024);
      await authority.close();
      closed = true;
      // Pause the frozen projection decode; while it is suspended, replace
      // the transcript at a new inode with a SHORTER prefix and cache the
      // live snapshot. The foreign-identity entry is shorter than the
      // frozen snapshot, but it may be the live index: retention must
      // protect it, not reclaim it by length.
      let releaseDecode: (() => void) | undefined;
      const decodeBlocked = new Promise<void>((resolve) => {
        releaseDecode = resolve;
      });
      projectionReads.pause = decodeBlocked;
      projectionReads.count = 0;
      const frozenRead = readAfter(reader, oldState, { limit: 1 });
      await vi.waitFor(() => expect(projectionReads.count).toBe(1));
      const raw = await fs.readFile(file, 'utf8');
      const lines = raw.trimEnd().split('\n');
      // Drop the last record's event+commit wrapper pair: a shorter,
      // still-valid managed log at a new inode.
      const short = lines.slice(0, lines.length - 2).join('\n') + '\n';
      const temp = `${file}.replacement`;
      await fs.writeFile(temp, short, 'utf8');
      await fs.rename(temp, file);
      await reader.readPage(sessionId, { limit: 1 });
      const liveTotal =
        getSessionTranscriptIndexCacheStatsForTest().byteSize - physicalBytes;
      expect(getSessionTranscriptIndexCacheStatsForTest().entries).toBe(2);
      setSessionTranscriptIndexCacheMaxBytesForTest(physicalBytes + liveTotal);
      setSessionTranscriptIndexCacheOversizedMaxBytesForTest(1);
      const builds = countBuilds(file);
      releaseDecode!();
      // The frozen page still serves from the cached old index; the
      // retention accounting ran against the replacement's live entry.
      await frozenRead;
      // The shorter live index at the new inode survives the refusal.
      expect(getSessionTranscriptIndexCacheStatsForTest().entries).toBe(2);
      expect(getSessionTranscriptIndexCacheStatsForTest().byteSize).toBe(
        physicalBytes + liveTotal,
      );
      await reader.readPage(sessionId, { limit: 1 });
      expect(builds.count).toBe(0);
    } finally {
      if (!closed) await authority.close();
    }
  });

  it.each([false, true])(
    'does not let frozen projection retention evict the current index after an in-place truncation (statFault=%s)',
    async (statFaultArm) => {
      const bigText = 'x'.repeat(256 * 1024);
      const { file, authority } = await openManagedFixture([
        { uuid: 'u1', parent: null, text: 'short prompt' },
        { uuid: 'a1', parent: 'u1', text: bigText },
        ...Array.from({ length: 18 }, (_, i) => ({
          uuid: `u${i + 2}`,
          parent: i ? `u${i + 1}` : 'a1',
          text: `filler ${i}`,
        })),
      ]);
      let closed = false;
      try {
        const reader = newReader();
        await reader.readTurnHooksPage(sessionId, 'legacy-record:u1');
        const physicalBytes =
          getSessionTranscriptIndexCacheStatsForTest().byteSize;
        setSessionTranscriptIndexCacheMaxBytesForTest(1);
        setSessionTranscriptIndexCacheOversizedMaxBytesForTest(
          physicalBytes + 1024,
        );
        clearSessionTranscriptIndexCacheEntriesForTest();
        const first = await reader.readPage(sessionId, { limit: 1 });
        const oldState = first.nextCursorState!;
        setSessionTranscriptIndexCacheMaxBytesForTest(64 * 1024 * 1024);
        setSessionTranscriptIndexCacheOversizedMaxBytesForTest(
          256 * 1024 * 1024,
        );
        await authority.close();
        closed = true;
        let releaseDecode: (() => void) | undefined;
        const decodeBlocked = new Promise<void>((resolve) => {
          releaseDecode = resolve;
        });
        projectionReads.pause = decodeBlocked;
        projectionReads.count = 0;
        const frozenRead = readAfter(reader, oldState, { limit: 1 });
        await vi.waitFor(() => expect(projectionReads.count).toBe(1));
        // Truncate the last record's wrapper pair IN PLACE (same inode):
        // the current full index is shorter than the frozen snapshot at
        // the same identity — the live index, not a historical prefix.
        const raw = await fs.readFile(file, 'utf8');
        const lines = raw.trimEnd().split('\n');
        const kept = lines.slice(0, lines.length - 2).join('\n') + '\n';
        await fs.truncate(file, Buffer.byteLength(kept));
        await reader.readPage(sessionId, { limit: 1 });
        const liveTotal =
          getSessionTranscriptIndexCacheStatsForTest().byteSize - physicalBytes;
        expect(getSessionTranscriptIndexCacheStatsForTest().entries).toBe(2);
        setSessionTranscriptIndexCacheMaxBytesForTest(
          physicalBytes + liveTotal,
        );
        setSessionTranscriptIndexCacheOversizedMaxBytesForTest(1);
        const builds = countBuilds(file);
        if (statFaultArm) {
          // The next stat is the frozen reclaim context's: a transient
          // failure must refuse retention, not reclaim blind.
          statFault.failNextWith = 'EIO';
        }
        releaseDecode!();
        await frozenRead;
        // The current index survives the refused retention.
        expect(getSessionTranscriptIndexCacheStatsForTest().entries).toBe(2);
        expect(getSessionTranscriptIndexCacheStatsForTest().byteSize).toBe(
          physicalBytes + liveTotal,
        );
        await reader.readPage(sessionId, { limit: 1 });
        expect(builds.count).toBe(0);
        // The frozen cursor now lies beyond the truncated file: the door
        // guard rejects it (the first frozen read passed its guard before
        // the truncation, which is why its retention accounting ran).
        await expect(
          readAfter(reader, oldState, { limit: 1 }),
        ).rejects.toMatchObject({
          name: 'SessionTranscriptSnapshotUnavailableError',
        });
      } finally {
        if (!closed) await authority.close();
      }
    },
  );

  it('preserves customTitle and titleSource on restore when projection body retention is refused (R12-1)', async () => {
    const bigText = 'x'.repeat(256 * 1024);
    const { authority } = await openManagedFixture([
      { uuid: 'u1', parent: null, text: 'short prompt' },
      { uuid: 'a1', parent: 'u1', text: bigText },
    ]);
    try {
      const reader = newReader();
      await reader.readTurnHooksPage(sessionId, 'legacy-record:u1');
      const physicalBytes =
        getSessionTranscriptIndexCacheStatsForTest().byteSize;
      clearSessionTranscriptIndexCacheEntriesForTest();
      // Room for the physical index only: the decoded bodies do not fit
      // either class, so accountManagedProjection refuses body retention and
      // deletes the bodies from managedProjections.
      setSessionTranscriptIndexCacheMaxBytesForTest(physicalBytes + 1024);
      setSessionTranscriptIndexCacheOversizedMaxBytesForTest(1);
      projectionReads.titleInfo = {
        title: 'User-Named Session',
        source: 'manual',
      };
      projectionReads.count = 0;

      type Restored = NonNullable<
        Awaited<ReturnType<SessionTranscriptReader['readRestoreProjection']>>
      >;
      const spy = vi.spyOn(
        reader as unknown as {
          readManagedRestoreProjection: (
            ...args: unknown[]
          ) => Promise<Restored>;
        },
        'readManagedRestoreProjection',
      );
      const first = await reader.readRestoreProjection(sessionId, NONE);
      expect(first?.runtime.recording).toMatchObject({
        customTitle: 'User-Named Session',
        titleSource: 'manual',
      });
      // offerFreshIndexToCache admitted the physical index and refused the
      // oversized bodies.
      expect(getSessionTranscriptIndexCacheStatsForTest().byteSize).toBe(
        physicalBytes,
      );
      expect(projectionReads.count).toBe(1);
      const cachedIndex = spy.mock.calls[0]?.[1];
      expect(cachedIndex).toBeDefined();

      // Re-run against the cache-resident index instance (the exact R12-1
      // trace: readManagedRecords -> accountManagedProjection deletes from
      // managedProjections before readManagedRestoreProjection reads titleInfo).
      const second = await (
        reader as unknown as {
          readManagedRestoreProjection: (
            sid: string,
            idx: unknown,
            opts: SelectiveSessionRestoreOptions,
            readOpts: Record<string, never>,
          ) => Promise<Restored>;
        }
      ).readManagedRestoreProjection(
        sessionId,
        cachedIndex,
        { replay: { kind: 'all', hideInheritedHistory: false } },
        {},
      );
      expect(second.runtime.recording).toMatchObject({
        customTitle: 'User-Named Session',
        titleSource: 'manual',
      });
      expect(second.replay?.records).toHaveLength(2);
      expect(projectionReads.count).toBe(2);
    } finally {
      await authority.close();
    }
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

  describe('prompt-time sidecar, lightweight scan, concurrency gate, abort, and incremental index (#17889)', () => {
    it('uses lightweight scan (zero full index builds) on cold prompt read and hits sidecar_exact after restart', async () => {
      const u1 = record('u1', null, 'hello');
      const a1 = record('a1', u1.uuid, 'reply');
      const file = await writeRecords([u1, a1]);
      const sidecarPath = sessionPromptTimeSidecarPath(
        path.dirname(file),
        sessionId,
      );

      const indexBuilds: TranscriptIndexBuildModeEvent[] = [];
      const promptScans: PromptTimeScanModeEvent[] = [];
      setSessionTranscriptIndexBuildModeHookForTest((e) => indexBuilds.push(e));
      setSessionTranscriptPromptTimeScanModeHookForTest((e) =>
        promptScans.push(e),
      );

      const reader = newReader();
      expect(await reader.getLastUserPromptAt(sessionId)).toBe(u1.timestamp);
      expect(indexBuilds).toEqual([]);
      expect(promptScans).toEqual([
        expect.objectContaining({
          filePath: file,
          mode: 'lightweight_scan',
          startOffset: 0,
        }),
      ]);
      expect(getSessionTranscriptIndexCacheStatsForTest().entries).toBe(0);
      await expect(fs.stat(sidecarPath)).resolves.toBeDefined();

      // Simulate daemon restart by clearing all in-memory caches while keeping disk sidecar.
      resetSessionTranscriptIndexCacheForTest();
      const postRestartBuilds: TranscriptIndexBuildModeEvent[] = [];
      const postRestartScans: PromptTimeScanModeEvent[] = [];
      let hookCalls = 0;
      setSessionTranscriptIndexBuildModeHookForTest((e) =>
        postRestartBuilds.push(e),
      );
      setSessionTranscriptPromptTimeScanModeHookForTest((e) =>
        postRestartScans.push(e),
      );
      setSessionTranscriptIndexBuildCompleteHookForTest(() => {
        hookCalls += 1;
      });

      expect(await newReader().getLastUserPromptAt(sessionId)).toBe(
        u1.timestamp,
      );
      expect(postRestartBuilds).toEqual([]);
      expect(hookCalls).toBe(0);
      expect(postRestartScans).toEqual([
        expect.objectContaining({
          filePath: file,
          mode: 'sidecar_exact',
        }),
      ]);
    });

    it('tail-extends from the persisted sidecar offset on linear appends and falls back cleanly on rewind or corrupt sidecar', async () => {
      const u1 = record('u1', null, 'first question');
      const a1 = record('a1', u1.uuid, 'first answer');
      const file = await writeRecords([u1, a1]);
      const prefixSize1 = (await fs.stat(file)).size;

      expect(await newReader().getLastUserPromptAt(sessionId)).toBe(
        u1.timestamp,
      );

      // Append an assistant turn and clear memory caches -> must scan ONLY from prefixSize1.
      const a2 = record('a2', a1.uuid, 'follow-up assistant note');
      await appendRecords(file, a2);
      const prefixSize2 = (await fs.stat(file)).size;
      resetSessionTranscriptIndexCacheForTest();
      const scans1: PromptTimeScanModeEvent[] = [];
      setSessionTranscriptPromptTimeScanModeHookForTest((e) => scans1.push(e));

      expect(await newReader().getLastUserPromptAt(sessionId)).toBe(
        u1.timestamp,
      );
      expect(scans1).toEqual([
        {
          filePath: file,
          mode: 'sidecar_tail',
          startOffset: prefixSize1,
          snapshotSize: prefixSize2,
        },
      ]);

      // Append a new user prompt and clear memory caches -> must tail-extend from prefixSize2 and return u2.
      const u2 = record('u2', a2.uuid, 'second question');
      await appendRecords(file, u2);
      const prefixSize3 = (await fs.stat(file)).size;
      resetSessionTranscriptIndexCacheForTest();
      const scans2: PromptTimeScanModeEvent[] = [];
      setSessionTranscriptPromptTimeScanModeHookForTest((e) => scans2.push(e));

      expect(await newReader().getLastUserPromptAt(sessionId)).toBe(
        u2.timestamp,
      );
      expect(scans2).toEqual([
        {
          filePath: file,
          mode: 'sidecar_tail',
          startOffset: prefixSize2,
          snapshotSize: prefixSize3,
        },
      ]);

      // Append a non-linear rewind jumping back to a1 (dropping u2 from active chain) -> must fall back to lightweight_scan and return u1.
      const r1: ChatRecord = {
        ...record('r1', a1.uuid, 'rewound'),
        type: 'system',
        subtype: 'rewind',
      };
      await appendRecords(file, r1);
      resetSessionTranscriptIndexCacheForTest();
      const scans3: PromptTimeScanModeEvent[] = [];
      setSessionTranscriptPromptTimeScanModeHookForTest((e) => scans3.push(e));

      expect(await newReader().getLastUserPromptAt(sessionId)).toBe(
        u1.timestamp,
      );
      expect(scans3).toEqual([
        expect.objectContaining({
          filePath: file,
          mode: 'lightweight_scan',
          startOffset: 0,
        }),
      ]);

      // Corrupt sidecar must fail closed to lightweight_scan.
      const sidecarPath = sessionPromptTimeSidecarPath(
        path.dirname(file),
        sessionId,
      );
      await fs.writeFile(sidecarPath, '{corrupt', 'utf8');
      resetSessionTranscriptIndexCacheForTest();
      const scans4: PromptTimeScanModeEvent[] = [];
      setSessionTranscriptPromptTimeScanModeHookForTest((e) => scans4.push(e));

      expect(await newReader().getLastUserPromptAt(sessionId)).toBe(
        u1.timestamp,
      );
      expect(scans4).toEqual([
        expect.objectContaining({
          filePath: file,
          mode: 'lightweight_scan',
          startOffset: 0,
        }),
      ]);

      // In-place rewrite with different prefix + extra newline on the same inode must fail tailHex check and fall back to lightweight_scan.
      const prevSize = (await fs.stat(file)).size;
      const rewritten = {
        ...record('u-rewritten', null, 'rewritten prompt'),
        timestamp: '2026-09-01T00:00:00.000Z',
      };
      const rewrittenLine = `${JSON.stringify(rewritten)}\n`;
      // Pad with spaces before the newline at prevSize - 1 so byte prevSize - 1 is STILL '\n', then append another blank line.
      const paddedPrefix =
        rewrittenLine.length < prevSize
          ? `${rewrittenLine}${' '.repeat(prevSize - rewrittenLine.length - 1)}\n`
          : rewrittenLine;
      await fs.writeFile(file, `${paddedPrefix}\n`, 'utf8');
      resetSessionTranscriptIndexCacheForTest();
      const scans5: PromptTimeScanModeEvent[] = [];
      setSessionTranscriptPromptTimeScanModeHookForTest((e) => scans5.push(e));

      expect(await newReader().getLastUserPromptAt(sessionId)).toBe(
        rewritten.timestamp,
      );
      expect(scans5).toEqual([
        expect.objectContaining({
          filePath: file,
          mode: 'lightweight_scan',
          startOffset: 0,
        }),
      ]);

      // Duplicate UUID aliasing an earlier non-leaf prefix record (dupdemo / adv-c5)
      // must be caught by prefixUuidBloom and fall back to lightweight_scan,
      // returning the first-wins original timestamp rather than the duplicate's.
      const p1 = {
        ...record('dup-u1', null, 'original prompt'),
        timestamp: '2026-01-01T00:00:00.000Z',
      };
      const p2 = {
        ...record('dup-a1', p1.uuid, 'assistant reply'),
        type: 'assistant' as const,
        timestamp: '2026-01-01T00:00:01.000Z',
      };
      const pNonConv: ChatRecord = {
        ...record('dup-meta', p2.uuid, ''),
        type: 'system',
        subtype: 'generated_ui_state',
        message: undefined,
        timestamp: '2026-01-01T00:00:02.000Z',
      };
      await writeRecords([p1, p2, pNonConv]);
      resetSessionTranscriptIndexCacheForTest();
      expect(await newReader().getLastUserPromptAt(sessionId)).toBe(
        p1.timestamp,
      );

      const p3 = {
        ...record('dup-u2', p2.uuid, 'intermediate prompt'),
        timestamp: '2026-01-01T00:00:03.000Z',
      };
      const dupOfPrefix = {
        ...record(p1.uuid, p3.uuid, 'forged duplicate of prefix u1'),
        timestamp: '2026-01-01T00:00:10.000Z',
      };
      await appendRecords(file, p3, dupOfPrefix);
      resetSessionTranscriptIndexCacheForTest();
      const scansPrefixDup: PromptTimeScanModeEvent[] = [];
      setSessionTranscriptPromptTimeScanModeHookForTest((e) =>
        scansPrefixDup.push(e),
      );
      expect(await newReader().getLastUserPromptAt(sessionId)).toBe(
        p1.timestamp,
      );
      expect(scansPrefixDup).toEqual([
        expect.objectContaining({
          filePath: file,
          mode: 'lightweight_scan',
          startOffset: 0,
        }),
      ]);

      // Duplicate UUID aliasing an earlier non-conversation prefix record must also fall back.
      await writeRecords([p1, p2, pNonConv]);
      resetSessionTranscriptIndexCacheForTest();
      expect(await newReader().getLastUserPromptAt(sessionId)).toBe(
        p1.timestamp,
      );
      const dupOfNonConv = {
        ...record(pNonConv.uuid, p2.uuid, 'forged duplicate of non-conv'),
        timestamp: '2026-01-01T00:00:20.000Z',
      };
      await appendRecords(file, dupOfNonConv);
      resetSessionTranscriptIndexCacheForTest();
      const scansNonConvDup: PromptTimeScanModeEvent[] = [];
      setSessionTranscriptPromptTimeScanModeHookForTest((e) =>
        scansNonConvDup.push(e),
      );
      expect(await newReader().getLastUserPromptAt(sessionId)).toBeUndefined();
      expect(scansNonConvDup).toEqual([
        expect.objectContaining({
          filePath: file,
          mode: 'lightweight_scan',
          startOffset: 0,
        }),
      ]);

      // Within-tail duplicate UUID (two records in the appended tail sharing a uuid)
      // must also be rejected by the Bloom guard and fall back to lightweight_scan.
      await writeRecords([p1, p2]);
      resetSessionTranscriptIndexCacheForTest();
      expect(await newReader().getLastUserPromptAt(sessionId)).toBe(
        p1.timestamp,
      );
      const tailFirst = {
        ...record('dup-tail', p2.uuid, 'first tail prompt'),
        timestamp: '2026-01-01T00:01:00.000Z',
      };
      const tailSecond = {
        ...record('dup-tail', tailFirst.uuid, 'duplicate tail prompt'),
        timestamp: '2026-01-01T00:02:00.000Z',
      };
      await appendRecords(file, tailFirst, tailSecond);
      resetSessionTranscriptIndexCacheForTest();
      const scansTailDup: PromptTimeScanModeEvent[] = [];
      setSessionTranscriptPromptTimeScanModeHookForTest((e) =>
        scansTailDup.push(e),
      );
      expect(await newReader().getLastUserPromptAt(sessionId)).toBe(
        tailFirst.timestamp,
      );
      expect(scansTailDup).toEqual([
        expect.objectContaining({
          filePath: file,
          mode: 'lightweight_scan',
          startOffset: 0,
        }),
      ]);

      // A sidecar without prefixUuidBloom (e.g. from an older writer or saturated filter)
      // must fall back to lightweight_scan on append and heal prefixUuidBloom.
      await writeRecords([p1, p2]);
      resetSessionTranscriptIndexCacheForTest();
      expect(await newReader().getLastUserPromptAt(sessionId)).toBe(
        p1.timestamp,
      );
      const rawSidecar = JSON.parse(await fs.readFile(sidecarPath, 'utf8'));
      delete rawSidecar.prefixUuidBloom;
      await fs.writeFile(sidecarPath, JSON.stringify(rawSidecar), 'utf8');
      const p4 = {
        ...record(
          'u-after-missing-bloom',
          p2.uuid,
          'prompt after legacy sidecar',
        ),
        timestamp: '2026-01-01T00:03:00.000Z',
      };
      await appendRecords(file, p4);
      resetSessionTranscriptIndexCacheForTest();
      const scansNoBloom: PromptTimeScanModeEvent[] = [];
      setSessionTranscriptPromptTimeScanModeHookForTest((e) =>
        scansNoBloom.push(e),
      );
      expect(await newReader().getLastUserPromptAt(sessionId)).toBe(
        p4.timestamp,
      );
      expect(scansNoBloom).toEqual([
        expect.objectContaining({
          filePath: file,
          mode: 'lightweight_scan',
          startOffset: 0,
        }),
      ]);
      const healedSidecar = JSON.parse(await fs.readFile(sidecarPath, 'utf8'));
      expect(healedSidecar.prefixUuidBloom).toBeDefined();
    });

    it('never writes a prompt-time sidecar when allowSidecarWrite is false or transcript belongs to a foreign workspace', async () => {
      const u1 = record('u1', null, 'hello');
      const file = await writeRecords([u1]);
      const sidecarPath = sessionPromptTimeSidecarPath(
        path.dirname(file),
        sessionId,
      );

      expect(
        await newReader().getLastUserPromptAt(sessionId, 'active', {
          allowSidecarWrite: false,
        }),
      ).toBe(u1.timestamp);
      await expect(fs.stat(sidecarPath)).rejects.toMatchObject({
        code: 'ENOENT',
      });

      resetSessionTranscriptIndexCacheForTest();
      const foreign = { ...record('u2', null, 'foreign'), cwd: '/other/repo' };
      await writeRecords([foreign]);
      expect(await newReader().getLastUserPromptAt(sessionId)).toBe(
        foreign.timestamp,
      );
      await expect(fs.stat(sidecarPath)).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });

    it('aborts an in-flight cold prompt scan early when the sole waiter aborts, and isolates concurrent sharers', async () => {
      const records = longTurn(20, () => 'payload '.repeat(64));
      await writeRecords(records);

      // Case 1: sole waiter aborts on the first cooperative yield.
      const soleAbort = new AbortController();
      let soleYields = 0;
      setSessionTranscriptCooperativeReadBudgetForTest(1, 0, () => {
        soleYields += 1;
        if (soleYields === 1) {
          soleAbort.abort(new DOMException('client gone', 'AbortError'));
        }
      });

      await expect(
        newReader().getLastUserPromptAt(sessionId, 'active', {
          signal: soleAbort.signal,
        }),
      ).rejects.toMatchObject({ name: 'AbortError' });
      expect(soleYields).toBe(1);

      // A subsequent read recovers cleanly after the aborted slot is cleaned up.
      setSessionTranscriptCooperativeReadBudgetForTest(2 * 1024 * 1024, 10_000);
      expect(await newReader().getLastUserPromptAt(sessionId)).toBe(
        records[0]!.timestamp,
      );

      // Case 2: two concurrent waiters share one cold scan; aborting waiter A keeps the scan alive for waiter B.
      resetSessionTranscriptIndexCacheForTest();
      const sidecarPath = sessionPromptTimeSidecarPath(
        path.dirname(newReader().getSessionFilePath(sessionId)),
        sessionId,
      );
      await fs.rm(sidecarPath, { force: true });

      const waiterA = new AbortController();
      const waiterB = new AbortController();
      let sharedYields = 0;
      setSessionTranscriptCooperativeReadBudgetForTest(1, 0, () => {
        sharedYields += 1;
        if (sharedYields === 1) {
          waiterA.abort(new DOMException('waiter A cancelled', 'AbortError'));
        }
      });

      const reader = newReader();
      const [resA, resB] = await Promise.allSettled([
        reader.getLastUserPromptAt(sessionId, 'active', {
          signal: waiterA.signal,
        }),
        reader.getLastUserPromptAt(sessionId, 'active', {
          signal: waiterB.signal,
        }),
      ]);
      expect(resA.status).toBe('rejected');
      expect(resB).toEqual({
        status: 'fulfilled',
        value: records[0]!.timestamp,
      });
    });

    it('bounds process-wide concurrent cold builds across workspaces and drops aborted queued waiters immediately', async () => {
      setSessionTranscriptMaxConcurrentBuildsForTest(2);

      const sessions: Array<{
        workspace: string;
        sid: string;
        timestamp: string;
      }> = [];
      for (let i = 0; i < 6; i += 1) {
        const ws = path.join(runtimeDir, `ws-gate-${i}`);
        const sid = `11111111-1111-4111-8111-11111111110${i}`;
        const r = new SessionTranscriptReader(ws);
        const filePath = r.getSessionFilePath(sid);
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        const rec1 = {
          ...record(`u-${i}-1`, null, `prompt ${i}`),
          sessionId: sid,
          cwd: ws,
        };
        const rec2 = {
          ...record(`a-${i}-1`, rec1.uuid, `reply ${i}`),
          sessionId: sid,
          cwd: ws,
        };
        await fs.writeFile(
          filePath,
          `${JSON.stringify(rec1)}\n${JSON.stringify(rec2)}\n`,
          'utf8',
        );
        sessions.push({ workspace: ws, sid, timestamp: rec1.timestamp });
      }

      const scannedFiles = new Set<string>();
      setSessionTranscriptPromptTimeScanModeHookForTest((e) => {
        scannedFiles.add(e.filePath);
      });

      let maxActive = 0;
      let maxQueued = 0;
      const queuedAbort = new AbortController();
      let abortedQueued = false;
      setSessionTranscriptCooperativeReadBudgetForTest(1, 0, () => {
        const stats = getSessionTranscriptBuildSemaphoreStatsForTest();
        maxActive = Math.max(maxActive, stats.active);
        maxQueued = Math.max(maxQueued, stats.queued);
        if (!abortedQueued && stats.queued > 0) {
          abortedQueued = true;
          queuedAbort.abort(new DOMException('queued abort', 'AbortError'));
        }
      });

      const promises = sessions.map((s, idx) =>
        new SessionTranscriptReader(s.workspace).getLastUserPromptAt(
          s.sid,
          'active',
          idx === 5 ? { signal: queuedAbort.signal } : {},
        ),
      );
      const results = await Promise.allSettled(promises);

      expect(abortedQueued).toBe(true);
      expect(maxActive).toBeLessThanOrEqual(2);
      expect(maxActive).toBe(2);
      expect(maxQueued).toBeGreaterThanOrEqual(1);
      expect(getSessionTranscriptBuildSemaphoreStatsForTest()).toEqual({
        active: 0,
        queued: 0,
      });
      for (let i = 0; i < 5; i += 1) {
        expect(results[i]).toEqual({
          status: 'fulfilled',
          value: sessions[i]!.timestamp,
        });
      }
      expect(results[5]!.status).toBe('rejected');
      expect(
        scannedFiles.has(
          new SessionTranscriptReader(
            sessions[5]!.workspace,
          ).getSessionFilePath(sessions[5]!.sid),
        ),
      ).toBe(false);
    });

    it('extends cached TranscriptIndex incrementally on append with full-rebuild parity, preserving frozen base cursors and handling rewinds + fragments', async () => {
      const u1 = record('u1', null, 'turn one');
      const a1 = record('a1', u1.uuid, 'answer one');
      const u2 = record('u2', a1.uuid, 'turn two');
      const a2 = record('a2', u2.uuid, 'answer two');
      const cp1 = {
        ...record('cp1', a2.uuid, ''),
        type: 'system' as const,
        subtype: 'branch_checkpoint',
        message: undefined,
        systemPayload: {
          v: 1,
          startExclusiveRecordUuid: a1.uuid,
          assistantRecordUuid: a2.uuid,
        },
      } as ChatRecord;
      const file = await writeRecords([u1, a1, u2, a2, cp1]);
      const size1 = (await fs.stat(file)).size;

      const buildEvents: TranscriptIndexBuildModeEvent[] = [];
      setSessionTranscriptIndexBuildModeHookForTest((e) => buildEvents.push(e));

      const reader = newReader();
      const page1 = await reader.readPage(sessionId, { limit: 2 });
      expect(buildEvents).toEqual([
        {
          filePath: file,
          mode: 'full',
          startOffset: 0,
          snapshotSize: size1,
        },
      ]);
      const frozenTurnIndex1 = await reader.readTurnIndexPage(sessionId);
      expect(frozenTurnIndex1.turns.map((t) => t.turnId)).toEqual(['u1', 'u2']);

      // 1. Linear append with a new turn + branch checkpoint -> must extend incrementally from size1.
      const u3 = record('u3', cp1.uuid, 'turn three');
      const a3 = record('a3', u3.uuid, 'answer three');
      await appendRecords(file, u3, a3);
      const size2 = (await fs.stat(file)).size;

      const page2 = await reader.readPage(sessionId, { limit: 10 });
      expect(buildEvents.at(-1)).toEqual({
        filePath: file,
        mode: 'incremental',
        startOffset: size1,
        snapshotSize: size2,
      });

      // Frozen cursor from S1 must still page S1 cleanly without bleeding into S2 (baseIndex was never mutated).
      const frozenNext = await readAfter(reader, page1.nextCursorState!, {
        limit: 10,
      });
      expect(frozenNext.records.map((r) => r.uuid)).toEqual([
        'u2',
        'a2',
        'cp1',
      ]);

      // 2. Append a rewind branching back to a1 (dropping u2/u3) + a new turn u4 + a fragment of u1.
      const u1Frag = {
        ...record('u1', null, ' extra fragment'),
        timestamp: '2026-01-01T00:05:00.000Z',
      };
      const r1: ChatRecord = {
        ...record('r1', a1.uuid, ''),
        type: 'system',
        subtype: 'rewind',
        message: undefined,
      };
      const u4 = record('u4', r1.uuid, 'turn four after rewind');
      const a4 = record('a4', u4.uuid, 'answer four');
      await appendRecords(file, u1Frag, r1, u4, a4);
      const size3 = (await fs.stat(file)).size;

      const incPage3 = await reader.readPage(sessionId, { limit: 10 });
      const incTurns3 = await reader.readTurnIndexPage(sessionId);
      expect(buildEvents.at(-1)).toEqual({
        filePath: file,
        mode: 'incremental',
        startOffset: size2,
        snapshotSize: size3,
      });
      // Stale navigationOrdinal for rewound turn u2 must be cleared in the incremental index.
      await expect(
        reader.readPage(sessionId, {
          snapshot: incTurns3.snapshot,
          atRecordId: 'u2',
          limit: 2,
        }),
      ).rejects.toBeInstanceOf(InvalidSessionTranscriptTurnAnchorError);
      // Frozen S1 snapshot must still recognize u2 (proving S1 baseIndex was untouched).
      const frozenStillHasU2 = await reader.readPage(sessionId, {
        snapshot: frozenTurnIndex1.snapshot,
        atRecordId: 'u2',
        limit: 2,
      });
      expect(frozenStillHasU2.records.map((r) => r.uuid)).toContain('u2');

      // Compare incremental result against a fresh cold full rebuild field-for-field.
      clearSessionTranscriptIndexCacheEntriesForTest();
      const fullPage3 = await reader.readPage(sessionId, { limit: 10 });
      const fullTurns3 = await reader.readTurnIndexPage(sessionId);
      expect(buildEvents.at(-1)).toEqual({
        filePath: file,
        mode: 'full',
        startOffset: 0,
        snapshotSize: size3,
      });
      expect(incPage3.records).toEqual(fullPage3.records);
      expect(incPage3.branchPointsByAssistantUuid).toEqual(
        fullPage3.branchPointsByAssistantUuid,
      );
      expect(incTurns3.turns).toEqual(fullTurns3.turns);
      expect(page2.records.map((r) => r.uuid)).toEqual([
        'u1',
        'a1',
        'u2',
        'a2',
        'cp1',
        'u3',
        'a3',
      ]);
    });

    it('falls back from incremental extension to full build when prefix bytes are rewritten in place longer on the same inode', async () => {
      const u1 = record('u1', null, 'original turn');
      const file = await writeRecords([u1]);
      const buildEvents: TranscriptIndexBuildModeEvent[] = [];
      setSessionTranscriptIndexBuildModeHookForTest((e) => buildEvents.push(e));

      const reader = newReader();
      await reader.readPage(sessionId, { limit: 10 });
      expect(buildEvents.at(-1)?.mode).toBe('full');

      // Overwrite the SAME file in place (same inode) with different content that is strictly longer.
      const uNew1 = record('u-new-1', null, 'rewritten turn one');
      const uNew2 = record('u-new-2', uNew1.uuid, 'rewritten turn two');
      await fs.writeFile(
        file,
        `${JSON.stringify(uNew1)}\n${JSON.stringify(uNew2)}\n`,
        'utf8',
      );

      const page = await reader.readPage(sessionId, { limit: 10 });
      expect(buildEvents.at(-1)?.mode).toBe('full');
      expect(buildEvents.at(-1)?.startOffset).toBe(0);
      expect(page.records.map((r) => r.uuid)).toEqual(['u-new-1', 'u-new-2']);
    });

    it('maintains prompt-time sidecar through ChatRecordingService write, rewind, archive, unarchive, and removal', async () => {
      const config = {
        storage: new Storage(workspaceDir),
        getTargetDir: () => workspaceDir,
        getSessionId: () => sessionId,
        getProjectRoot: () => workspaceDir,
        getCliVersion: () => 'test',
        getModel: () => 'test',
        getAuthType: () => undefined,
        getApprovalMode: () => ApprovalMode.DEFAULT,
        getResumedSessionData: () => undefined,
      } as unknown as Config;
      const recorder = new ChatRecordingService(config, undefined, false);
      recorder.recordUserMessage([{ text: 'recorded prompt' }]);
      await recorder.flush();

      const activeFile = newReader().getSessionFilePath(sessionId, 'active');
      const activeSidecar = sessionPromptTimeSidecarPath(
        path.dirname(activeFile),
        sessionId,
      );
      await expect(fs.stat(activeSidecar)).resolves.toBeDefined();

      // Cold reader immediately hits sidecar_exact without scanning JSONL.
      resetSessionTranscriptIndexCacheForTest();
      const scans: PromptTimeScanModeEvent[] = [];
      setSessionTranscriptPromptTimeScanModeHookForTest((e) => scans.push(e));
      const ts = await newReader().getLastUserPromptAt(sessionId);
      expect(ts).toBeDefined();
      expect(scans).toEqual([
        expect.objectContaining({
          filePath: activeFile,
          mode: 'sidecar_exact',
        }),
      ]);

      // Rewind removes the sidecar so readers recompute from the active branch.
      recorder.recordAssistantTurn({
        model: 'test',
        message: [{ text: 'answer' }],
      });
      await recorder.flush();
      recorder.rewindRecording(1, { truncatedCount: 1 });
      await recorder.flush();
      await expect(fs.stat(activeSidecar)).rejects.toMatchObject({
        code: 'ENOENT',
      });

      // Recording another prompt writes a fresh sidecar.
      recorder.recordUserMessage([{ text: 'after rewind prompt' }]);
      await recorder.flush();
      await expect(fs.stat(activeSidecar)).resolves.toBeDefined();
      resetSessionTranscriptIndexCacheForTest();
      const postRewindTs = await newReader().getLastUserPromptAt(sessionId);
      expect(postRewindTs).toBeDefined();

      // Archive moves the sidecar into archive/ so archived reads also hit sidecar_exact.
      const service = svc();
      expect((await service.archiveSessions([sessionId])).errors).toEqual([]);
      const archivedFile = newReader().getSessionFilePath(
        sessionId,
        'archived',
      );
      const archivedSidecar = sessionPromptTimeSidecarPath(
        path.dirname(archivedFile),
        sessionId,
      );
      await expect(fs.stat(activeSidecar)).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await expect(fs.stat(archivedSidecar)).resolves.toBeDefined();

      resetSessionTranscriptIndexCacheForTest();
      const archivedScans: PromptTimeScanModeEvent[] = [];
      setSessionTranscriptPromptTimeScanModeHookForTest((e) =>
        archivedScans.push(e),
      );
      expect(await newReader().getLastUserPromptAt(sessionId, 'archived')).toBe(
        postRewindTs,
      );
      expect(archivedScans).toEqual([
        expect.objectContaining({
          filePath: archivedFile,
          mode: 'sidecar_exact',
        }),
      ]);

      // Unarchive moves the sidecar back to active/, and removeSessions cleans it up.
      expect((await service.unarchiveSessions([sessionId])).errors).toEqual([]);
      await expect(fs.stat(activeSidecar)).resolves.toBeDefined();
      await expect(fs.stat(archivedSidecar)).rejects.toMatchObject({
        code: 'ENOENT',
      });
      expect((await service.removeSessions([sessionId])).errors).toEqual([]);
      await expect(fs.stat(activeSidecar)).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });

    it('cancels queued readPage and readTurnIndexPage waiters immediately before the active build completes and isolates shared page builds', async () => {
      setSessionTranscriptMaxConcurrentBuildsForTest(1);

      const makeWs = async (idx: number, count: number) => {
        const ws = path.join(runtimeDir, `ws-page-abort-${idx}`);
        const sid = `22222222-2222-4222-8222-22222222220${idx}`;
        const reader = new SessionTranscriptReader(ws);
        const filePath = reader.getSessionFilePath(sid);
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        const recs = longTurn(count, () => `payload-${idx} `.repeat(48)).map(
          (r) => ({ ...r, sessionId: sid, cwd: ws }),
        );
        await fs.writeFile(
          filePath,
          `${recs.map((r) => JSON.stringify(r)).join('\n')}\n`,
          'utf8',
        );
        return { ws, sid, reader, filePath, recs };
      };

      const s1 = await makeWs(1, 20);
      const s2 = await makeWs(2, 6);
      const s3 = await makeWs(3, 6);

      const builtFiles: string[] = [];
      setSessionTranscriptIndexBuildModeHookForTest((e) =>
        builtFiles.push(e.filePath),
      );

      let firstCompleted = false;
      let queuedPageRejectedWhileFirstRunning = false;
      let queuedTurnRejectedWhileFirstRunning = false;
      const queuedPageAbort = new AbortController();
      const queuedTurnAbort = new AbortController();
      let abortedQueued = false;

      setSessionTranscriptCooperativeReadBudgetForTest(1, 0, () => {
        const stats = getSessionTranscriptBuildSemaphoreStatsForTest();
        if (!abortedQueued && stats.active === 1 && stats.queued === 2) {
          abortedQueued = true;
          queuedPageAbort.abort(new DOMException('page aborted', 'AbortError'));
          queuedTurnAbort.abort(new DOMException('turn aborted', 'AbortError'));
        }
      });

      const p1 = s1.reader.readPage(s1.sid, { limit: 5 }).then((res) => {
        firstCompleted = true;
        return res;
      });
      const p2 = s2.reader
        .readPage(s2.sid, { limit: 5, signal: queuedPageAbort.signal })
        .catch((err) => {
          queuedPageRejectedWhileFirstRunning = !firstCompleted;
          throw err;
        });
      const p3 = s3.reader
        .readTurnIndexPage(s3.sid, {
          limit: 5,
          signal: queuedTurnAbort.signal,
        })
        .catch((err) => {
          queuedTurnRejectedWhileFirstRunning = !firstCompleted;
          throw err;
        });

      const [r1, r2, r3] = await Promise.allSettled([p1, p2, p3]);
      expect(abortedQueued).toBe(true);
      expect(r1.status).toBe('fulfilled');
      expect(r2.status).toBe('rejected');
      expect(r3.status).toBe('rejected');
      expect(queuedPageRejectedWhileFirstRunning).toBe(true);
      expect(queuedTurnRejectedWhileFirstRunning).toBe(true);
      expect(builtFiles).toEqual([s1.filePath]);
      expect(getSessionTranscriptBuildSemaphoreStatsForTest()).toEqual({
        active: 0,
        queued: 0,
      });

      // In-flight sole abort stops readPage early and cleans cache; two sharers isolate cancellation.
      resetSessionTranscriptIndexCacheForTest();
      const soleAbort = new AbortController();
      let soleYields = 0;
      setSessionTranscriptCooperativeReadBudgetForTest(1, 0, () => {
        soleYields += 1;
        if (soleYields === 1) {
          soleAbort.abort(new DOMException('sole page gone', 'AbortError'));
        }
      });
      await expect(
        s1.reader.readPage(s1.sid, { limit: 5, signal: soleAbort.signal }),
      ).rejects.toMatchObject({ name: 'AbortError' });
      expect(soleYields).toBe(1);
      expect(getSessionTranscriptIndexCacheStatsForTest().entries).toBe(0);

      const waiterA = new AbortController();
      const waiterB = new AbortController();
      let sharedYields = 0;
      setSessionTranscriptCooperativeReadBudgetForTest(1, 0, () => {
        sharedYields += 1;
        if (sharedYields === 1) {
          waiterA.abort(new DOMException('sharer A gone', 'AbortError'));
        }
      });
      const [resA, resB] = await Promise.allSettled([
        s1.reader.readPage(s1.sid, { limit: 5, signal: waiterA.signal }),
        s1.reader.readPage(s1.sid, { limit: 5, signal: waiterB.signal }),
      ]);
      expect(resA.status).toBe('rejected');
      expect(resB.status).toBe('fulfilled');
      if (resB.status === 'fulfilled') {
        expect(resB.value.records.length).toBe(5);
      }
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
