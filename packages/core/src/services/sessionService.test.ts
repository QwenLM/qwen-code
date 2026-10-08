/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content } from '@google/genai';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  saveArtifactSnapshot,
  readArtifactSnapshot,
  deleteArtifactSnapshot,
} from '../tools/artifact/artifact-snapshots.js';
import {
  commitUsageBeforeTranscriptDeletion,
  prepareUsageBeforeTranscriptDeletion,
  type PreparedUsageBeforeTranscriptDeletion,
} from './usageHistoryService.js';
import path from 'node:path';
import { Readable } from 'node:stream';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type MockInstance,
  vi,
} from 'vitest';
import { getProjectHash } from '../utils/paths.js';
import { readRuntimeStatus } from '../utils/runtimeStatus.js';
import {
  SessionService,
  SessionTranscriptDurabilityError,
  buildApiHistoryFromConversation,
  computeUniqueBranchTitle,
  getApiHistoryPromptId,
  normalizeDerivedBranchTitle,
  getResumePromptTokenCount,
  getResumeTokenCounts,
  type ArchiveSessionsOptions,
  type ConversationRecord,
  type SessionLocation,
  type UnarchiveSessionsOptions,
} from './sessionService.js';
import {
  SESSION_TRANSCRIPT_MAX_INDEX_BYTES,
  SessionTranscriptTooLargeError,
} from './session-transcript-reader.js';
import {
  SESSION_ARTIFACT_PERSISTENCE_VERSION,
  stableSessionArtifactId,
} from './session-artifact-persistence.js';
import { SessionOrganizationService } from './session-organization-service.js';
import { SessionTranscriptChangedError } from './session-writer-lease.js';
import { CompressionStatus } from '../core/turn.js';
import type { ChatRecord } from './chatRecordingService.js';
import * as jsonl from '../utils/jsonl-utils.js';
import { moveSessionPrSidecar } from './session-pr-service.js';
import { SessionWriterLostError } from './session-writer-lease.js';
import {
  content,
  fnCall,
  fnResponse,
  modelText,
  userText,
} from '../test-utils/model-fixtures.js';

vi.mock('./usageHistoryService.js', () => ({
  prepareUsageBeforeTranscriptDeletion: vi.fn().mockResolvedValue({
    usagePath: '/usage.jsonl',
    record: { sessionId: 'salvage-session' },
  }),
  commitUsageBeforeTranscriptDeletion: vi.fn().mockReturnValue(true),
}));
vi.mock('node:path');
vi.mock('../utils/paths.js');
vi.mock('../utils/runtimeStatus.js');
vi.mock('../utils/jsonl-utils.js');
// The archive-transition move runs real filesystem locks this mocked-fs suite
// cannot host; its semantics (rename, split-pair merge, lock coverage) are
// pinned in session-pr-service.test.ts.
vi.mock('./session-pr-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./session-pr-service.js')>()),
  moveSessionPrSidecar: vi.fn().mockResolvedValue(undefined),
}));

type Line = Record<string, unknown>;

const dirents = (...names: string[]) =>
  names as unknown as Array<fs.Dirent<Buffer>>;
const errno = (message: string, code: string) =>
  Object.assign(new Error(message), { code }) as NodeJS.ErrnoException;
const enoent = () => errno('ENOENT', 'ENOENT');

// Real-disk transcript lines: `ts(n)` is n seconds after 2026-04-22T00:00Z.
const ts = (seconds: number) =>
  new Date(
    Date.parse('2026-04-22T00:00:00.000Z') + seconds * 1000,
  ).toISOString();
const msgLine = (
  sessionId: string,
  uuid: string,
  parentUuid: string | null,
  type: 'user' | 'assistant',
  seconds: number,
  text: string,
  extra: Line = {},
): Line => ({
  uuid,
  parentUuid,
  sessionId,
  type,
  timestamp: ts(seconds),
  cwd: process.cwd(),
  version: 'test',
  message: { role: type === 'user' ? 'user' : 'model', parts: [{ text }] },
  ...extra,
});
const sysLine = (
  sessionId: string,
  uuid: string,
  parentUuid: string | null,
  subtype: string,
  seconds: number,
  systemPayload: unknown,
  extra: Line = {},
): Line => ({
  uuid,
  parentUuid,
  sessionId,
  type: 'system',
  subtype,
  timestamp: ts(seconds),
  cwd: process.cwd(),
  version: 'test',
  systemPayload,
  ...extra,
});
const writeJsonl = (file: string, lines: unknown[]) =>
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
const readJsonl = (file: string) =>
  fs
    .readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));

// `goal: null` plus a `clearedGoal` of ids only is what `/goal clear` persists:
// the record has no objective anywhere on it.
const goalPayload = (objective: string | null) => ({
  v: 2,
  cause: objective === null ? 'clear' : 'create',
  snapshot: {
    v: 2,
    activity: 'idle',
    goal:
      objective === null
        ? null
        : {
            goalId: 'goal-1',
            revision: 1,
            objective,
            status: 'active',
            evidenceCursor: { recordId: null },
            turnCount: 0,
            activeTimeMs: 0,
            tokensUsed: 0,
            createdAt: 1,
            updatedAt: 1,
          },
    ...(objective === null
      ? { clearedGoal: { goalId: 'goal-1', revision: 1, updatedAt: 1 } }
      : {}),
  },
});
// Pre-v2 sessions carry no `goal_state` line: their Goal lives in a `/goal`
// slash-command result. Shape mirrors goal-persistence.test.ts.
const legacyGoalPayload = (
  condition: string,
  kind: 'checking' | 'aborted' = 'checking',
) => ({
  phase: 'result',
  rawCommand: kind === 'checking' ? `/goal ${condition}` : '/goal',
  outputHistoryItems: [
    {
      type: 'goal_status',
      kind,
      condition,
      ...(kind === 'checking' ? { iterations: 1, setAt: 42 } : {}),
    },
  ],
});

const artifactPayload = (
  sessionId: string,
  sequence: number,
  recordedAt: string,
  changes: unknown[],
) => ({
  v: SESSION_ARTIFACT_PERSISTENCE_VERSION,
  sessionId,
  sequence,
  recordedAt,
  changes,
});
const linkCreated = (id: string, title: string, url: string, at: string) => ({
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
});
const linkRemoved = (artifactId: string) => ({
  action: 'removed',
  artifactId,
  reason: 'explicit',
});
/** A `file_history_snapshot` payload: one snapshot backing up `files` (name → backup). */
const snapshotPayload = (
  promptId: string,
  timestamp: string,
  files: Record<string, string>,
  backupTime = timestamp,
  version = 1,
) => ({
  snapshots: [
    {
      promptId,
      timestamp,
      trackedFileBackups: Object.fromEntries(
        Object.entries(files).map(([name, backupFileName]) => [
          name,
          { backupFileName, version, backupTime },
        ]),
      ),
    },
  ],
});

describe('SessionService', () => {
  let sessionService: SessionService;

  let readdirSyncSpy: MockInstance<typeof fs.readdirSync>;
  let statSyncSpy: MockInstance<typeof fs.statSync>;
  let statPromiseSpy: MockInstance<typeof fs.promises.stat>;
  let unlinkSyncSpy: MockInstance<typeof fs.unlinkSync>;
  let existsSyncSpy: MockInstance<typeof fs.existsSync>;
  let mkdirSyncSpy: MockInstance<typeof fs.mkdirSync>;
  let renameSyncSpy: MockInstance<typeof fs.renameSync>;
  let rmSyncSpy: MockInstance<typeof fs.rmSync>;

  beforeEach(() => {
    vi.mocked(getProjectHash).mockReturnValue('test-project-hash');
    vi.mocked(path.join).mockImplementation((...args) => args.join('/'));
    vi.mocked(path.dirname).mockImplementation((p) => {
      const parts = p.split('/');
      parts.pop();
      return parts.join('/');
    });

    sessionService = new SessionService('/test/project/root');
    // Module mocks are not reset by restoreAllMocks; clear the salvage spy
    // so per-test call/order assertions never read stale invocations.
    vi.mocked(prepareUsageBeforeTranscriptDeletion)
      .mockReset()
      .mockResolvedValue({
        usagePath: '/usage.jsonl',
        record: { sessionId: 'salvage-session' },
      } as PreparedUsageBeforeTranscriptDeletion);
    vi.mocked(commitUsageBeforeTranscriptDeletion)
      .mockReset()
      .mockReturnValue(true);

    readdirSyncSpy = vi.spyOn(fs, 'readdirSync').mockReturnValue([]);
    statSyncSpy = vi.spyOn(fs, 'statSync').mockImplementation(
      () =>
        ({
          mtimeMs: Date.now(),
          isFile: () => true,
        }) as fs.Stats,
    );
    statPromiseSpy = vi
      .spyOn(fs.promises, 'stat')
      .mockImplementation(async () =>
        Promise.resolve({
          mtimeMs: Date.now(),
          isFile: () => true,
        } as fs.Stats),
      );
    unlinkSyncSpy = vi
      .spyOn(fs, 'unlinkSync')
      .mockImplementation(() => undefined);
    existsSyncSpy = vi.spyOn(fs, 'existsSync');
    mkdirSyncSpy = vi.spyOn(fs, 'mkdirSync');
    renameSyncSpy = vi
      .spyOn(fs, 'renameSync')
      .mockImplementation(() => undefined);
    rmSyncSpy = vi.spyOn(fs, 'rmSync').mockImplementation(() => undefined);

    // `parseLineTolerant` defaults to a no-op so line-streaming paths (e.g.
    // countSessionMessages, readLastRecordUuid) do not crash on the automock's
    // `undefined`; tests needing recovery semantics override it.
    vi.mocked(jsonl.read).mockResolvedValue([]);
    vi.mocked(jsonl.readLines).mockResolvedValue([]);
    vi.mocked(jsonl.readLinesWithIntegrity).mockImplementation(
      async (filePath, count, options) => ({
        records: await jsonl.readLines(filePath, count, options),
        complete: true,
      }),
    );
    vi.mocked(jsonl.parseLineTolerant).mockReturnValue([]);
    vi.mocked(readRuntimeStatus).mockResolvedValue(null);

    type MaintenanceInternals = {
      getSessionFilePath: SessionService['getSessionFilePath'];
      resolveMaintainableSessionSnapshot: SessionService['resolveMaintainableSessionSnapshot'];
      assertMaintainableSessionUnchanged: SessionService['assertMaintainableSessionUnchanged'];
    };
    const maintenancePrototype =
      SessionService.prototype as unknown as MaintenanceInternals;
    vi.spyOn(
      maintenancePrototype,
      'resolveMaintainableSessionSnapshot',
    ).mockImplementation(async function (
      this: MaintenanceInternals,
      sessionId,
    ) {
      const service = this as unknown as SessionService;
      const location = await service.getSessionLocation(sessionId);
      const states =
        location === 'conflict'
          ? (['active', 'archived'] as const)
          : location === undefined
            ? []
            : [location];
      return {
        location,
        identities: states.map((state, index) => ({
          state,
          filePath: this.getSessionFilePath(sessionId, state),
          dev: 1,
          ino: index + 1,
          size: 1,
          mtimeMs: 1,
          ctimeMs: 1,
        })),
      };
    });
    vi.spyOn(
      maintenancePrototype,
      'assertMaintainableSessionUnchanged',
    ).mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const sessionIdA = '550e8400-e29b-41d4-a716-446655440000';
  const sessionIdB = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
  const sessionIdC = '6ba7b811-9dad-11d1-80b4-00c04fd430c8';

  const recordA1: ChatRecord = {
    uuid: 'a1',
    parentUuid: null,
    sessionId: sessionIdA,
    timestamp: '2024-01-01T00:00:00Z',
    type: 'user',
    message: { role: 'user', parts: [{ text: 'hello session a' }] },
    cwd: '/test/project/root',
    version: '1.0.0',
    gitBranch: 'main',
  };

  const recordB1: ChatRecord = {
    uuid: 'b1',
    parentUuid: null,
    sessionId: sessionIdB,
    timestamp: '2024-01-02T00:00:00Z',
    type: 'user',
    message: { role: 'user', parts: [{ text: 'hi session b' }] },
    cwd: '/test/project/root',
    version: '1.0.0',
    gitBranch: 'feature',
  };

  const recordB2: ChatRecord = {
    uuid: 'b2',
    parentUuid: 'b1',
    sessionId: sessionIdB,
    timestamp: '2024-01-02T02:00:00Z',
    type: 'assistant',
    message: { role: 'model', parts: [{ text: 'hey back' }] },
    cwd: '/test/project/root',
    version: '1.0.0',
  };

  const foreignHead: ChatRecord = { ...recordA1, cwd: '/different/project' };
  const migratedHead: ChatRecord = { ...recordA1, cwd: '/old/project' };
  /** A system record on `base`'s session carrying no message. */
  const sideRecord = (
    base: ChatRecord,
    uuid: string,
    parentUuid: string | null,
    subtype: string,
    systemPayload: unknown,
  ) =>
    ({
      ...base,
      uuid,
      parentUuid,
      type: 'system',
      subtype,
      message: undefined,
      systemPayload,
    }) as ChatRecord;
  const goalStateRecord = (objective: string | null) =>
    sideRecord(recordA1, 'a1', null, 'goal_state', goalPayload(objective));
  const legacyGoalRecord = (condition: string) =>
    sideRecord(
      recordA1,
      'a1',
      null,
      'slash_command',
      legacyGoalPayload(condition),
    );

  const stubStat = (extra: Partial<fs.Stats> = {}) =>
    statSyncSpy.mockReturnValue({
      mtimeMs: Date.now(),
      isFile: () => true,
      ...extra,
    } as fs.Stats);
  /** Only `state`'s copy of each transcript head is readable; the other is ENOENT. */
  const onlyIn = (
    state: 'active' | 'archived',
    head: (filePath: string) => ChatRecord[] = () => [recordA1],
  ) =>
    vi.mocked(jsonl.readLines).mockImplementation(async (filePath: string) => {
      if (filePath.includes('/chats/archive/') !== (state === 'archived')) {
        throw enoent();
      }
      return head(filePath);
    });
  /** statSync reports `mtimes[id]` for files naming `id`, else `fallback`. */
  const byMtime = (mtimes: Record<string, number>, fallback: number) =>
    statSyncSpy.mockImplementation((filePath: fs.PathLike) => {
      const id = Object.keys(mtimes).find((key) =>
        filePath.toString().includes(key),
      );
      return {
        mtimeMs: id ? mtimes[id] : fallback,
        isFile: () => true,
      } as fs.Stats;
    });
  const headsById = (filePath: string) =>
    filePath.includes(sessionIdA)
      ? [recordA1]
      : filePath.includes(sessionIdB)
        ? [recordB1]
        : [];
  /** Active A and B transcripts, B modified more recently. */
  const newestB = () => {
    const now = Date.now();
    readdirSyncSpy.mockReturnValue(
      dirents(`${sessionIdA}.jsonl`, `${sessionIdB}.jsonl`),
    );
    byMtime({ [sessionIdB]: now }, now - 10000);
    vi.mocked(jsonl.readLines).mockImplementation(async (filePath) =>
      headsById(filePath),
    );
  };
  const otherProject = () =>
    vi
      .mocked(getProjectHash)
      .mockImplementation((cwd: string) =>
        cwd === '/test/project/root'
          ? 'test-project-hash'
          : 'other-project-hash',
      );
  /** Runtime status claiming the session now runs in `workDir`. */
  const migrated = (sessionId = sessionIdA, workDir = '/test/project/root') =>
    vi.mocked(readRuntimeStatus).mockResolvedValue({
      schemaVersion: 1,
      pid: 123,
      sessionId,
      workDir,
      hostname: 'host',
      startedAt: 1,
      qwenVersion: null,
    });
  const withWarnings = (root = '/test/project/root', options = {}) => {
    const warnings: string[] = [];
    const service = new SessionService(root, {
      ...options,
      onWarning: (message: string) => warnings.push(message),
    });
    return { service, warnings };
  };
  const existsFor = (...suffixes: string[]) =>
    existsSyncSpy.mockImplementation((filePath: fs.PathLike) =>
      suffixes.some((suffix) => filePath.toString().endsWith(suffix)),
    );
  const inChats = (ext = '.jsonl') =>
    expect.stringContaining(`/chats/${sessionIdA}${ext}`);
  const inArchive = (ext = '.jsonl') =>
    expect.stringContaining(`/chats/archive/${sessionIdA}${ext}`);
  /** Rejects with the reason of a later 'abort'; never settles without one. */
  const untilAborted = (signal: AbortSignal | undefined) =>
    new Promise<void>((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(signal.reason), {
        once: true,
      });
    });
  /** A mutation fence that passes once, then reports the generation closed. */
  const closesAfterFirst = () =>
    vi
      .fn()
      .mockImplementationOnce(() => undefined)
      .mockImplementation(() => {
        throw new Error('generation changed');
      });

  /** Session ids for the real-disk describes; each case has its own tmp dir. */
  const realDiskIds = [
    '11111111-1111-1111-1111-111111111111',
    '22222222-2222-2222-2222-222222222222',
    '33333333-3333-3333-3333-333333333333',
  ] as const;
  type RealDisk = {
    realTmpDir: string;
    realPath: typeof import('node:path');
    service: SessionService;
    cwd: string;
  };
  // Real-disk describes restore the path/paths/jsonl implementations the file
  // mocks replace and run in a fresh tmp runtime dir. 'fork' also restores
  // basename, parseLineTolerant, renameSync and QWEN_HOME; 'write' restores
  // writeLineSync and renameSync (a real retitle-then-move).
  const useRealDisk = (
    prefix: string,
    set: (disk: RealDisk) => void,
    mode?: 'fork' | 'write',
  ) => {
    let tmp = '';
    let originalQwenHome: string | undefined;
    let disk: RealDisk;
    beforeEach(async () => {
      const realOs = await import('node:os');
      const realPath =
        await vi.importActual<typeof import('node:path')>('node:path');
      const actualPaths =
        await vi.importActual<typeof import('../utils/paths.js')>(
          '../utils/paths.js',
        );
      const actualJsonl = await vi.importActual<
        typeof import('../utils/jsonl-utils.js')
      >('../utils/jsonl-utils.js');
      // Storage.resolveRuntimeBaseDir uses isAbsolute/resolve; automocked, they
      // return undefined and fall back to `~/.qwen`, outside the tmp sandbox.
      const pathFns = ['join', 'dirname', 'isAbsolute', 'resolve'] as const;
      for (const name of mode === 'fork'
        ? [...pathFns, 'basename' as const]
        : pathFns) {
        vi.mocked(path[name]).mockImplementation(realPath[name] as never);
      }
      vi.mocked(getProjectHash).mockImplementation(actualPaths.getProjectHash);
      // Storage.getProjectDir calls sanitizeCwd via a non-spied namespace
      // import; restore it module-globally so getChatsDir() is a real path.
      const mockedPaths = (await import('../utils/paths.js')) as unknown as {
        sanitizeCwd: (cwd: string) => string;
      };
      mockedPaths.sanitizeCwd = actualPaths.sanitizeCwd;
      vi.mocked(jsonl.read).mockImplementation(actualJsonl.read);
      vi.mocked(jsonl.readLines).mockImplementation(actualJsonl.readLines);
      if (mode === 'fork') {
        vi.mocked(jsonl.parseLineTolerant).mockImplementation(
          actualJsonl.parseLineTolerant,
        );
      }
      if (mode === 'write') {
        vi.mocked(jsonl.writeLineSync).mockImplementation(
          actualJsonl.writeLineSync,
        );
      }
      for (const spy of [
        readdirSyncSpy,
        statSyncSpy,
        statPromiseSpy,
        unlinkSyncSpy,
        rmSyncSpy,
        ...(mode ? [renameSyncSpy] : []),
      ]) {
        spy.mockRestore();
      }
      tmp = fs.mkdtempSync(realPath.join(realOs.tmpdir(), prefix));
      if (mode === 'fork') {
        originalQwenHome = process.env['QWEN_HOME'];
        process.env['QWEN_HOME'] = tmp;
      }
      process.env['QWEN_RUNTIME_DIR'] = tmp;
      const cwd = process.cwd();
      disk = {
        realTmpDir: tmp,
        realPath,
        service: new SessionService(cwd),
        cwd,
      };
      set(disk);
    });
    afterEach(() => {
      delete process.env['QWEN_RUNTIME_DIR'];
      if (mode === 'fork') {
        if (originalQwenHome === undefined) delete process.env['QWEN_HOME'];
        else process.env['QWEN_HOME'] = originalQwenHome;
      }
      try {
        fs.rmSync(tmp, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    });
    return {
      /** Writes a transcript (records or raw text) under chats/ or chats/archive/. */
      write: (
        sessionId: string,
        content: Line[] | string,
        state: 'active' | 'archived' = 'active',
      ) => {
        const { realPath, service } = disk;
        const dir = realPath.join(
          service['storage'].getProjectDir(),
          'chats',
          ...(state === 'archived' ? ['archive'] : []),
        );
        fs.mkdirSync(dir, { recursive: true });
        const file = realPath.join(dir, `${sessionId}.jsonl`);
        if (typeof content === 'string') fs.writeFileSync(file, content);
        else writeJsonl(file, content);
        return file;
      },
    };
  };
  /** A u1 'hello' prompt followed by a manual custom_title record (u2). */
  const titledLines = (
    sessionId: string,
    title: string,
    cwd = process.cwd(),
  ) => [
    msgLine(sessionId, 'u1', null, 'user', 0, 'hello', { cwd }),
    sysLine(
      sessionId,
      'u2',
      'u1',
      'custom_title',
      1,
      { customTitle: title, titleSource: 'manual' },
      { cwd },
    ),
  ];

  describe('listSessions', () => {
    /** One active transcript (sessionIdA) whose head holds `records`. */
    const listOne = (...records: ChatRecord[]) => {
      readdirSyncSpy.mockReturnValue(dirents(`${sessionIdA}.jsonl`));
      stubStat();
      vi.mocked(jsonl.readLines).mockResolvedValue(records);
      return sessionService.listSessions();
    };
    const manyFiles = () =>
      readdirSyncSpy.mockReturnValue(
        dirents(
          ...Array.from(
            { length: 129 },
            (_, index) => `${index.toString(16).padStart(32, '0')}.jsonl`,
          ),
        ),
      );
    // path.join is mocked to join with '/', so match '/' rather than path.sep
    // (still the real host separator under the automock).
    const chatsListing = (active: string[], archived: string[] = []) =>
      readdirSyncSpy.mockImplementation((dir: fs.PathLike) =>
        dirents(...(dir.toString().endsWith('/archive') ? archived : active)),
      );
    const listIds = (...ids: string[]) =>
      readdirSyncSpy.mockReturnValue(
        dirents(...ids.map((id) => `${id}.jsonl`)),
      );
    const countsOf = (active: number, archived: number, truncated = false) => ({
      active,
      archived,
      total: active + archived,
      truncated,
    });

    it('should return empty list when no sessions exist', async () => {
      readdirSyncSpy.mockReturnValue([]);

      const result = await sessionService.listSessions();

      expect(result.items).toHaveLength(0);
      expect(result.hasMore).toBe(false);
      expect(result.nextCursor).toBeUndefined();
    });

    it('yields after 128 directory entries and stops statting after cancellation', async () => {
      manyFiles();
      const controller = new AbortController();
      const reason = errno('catalog request disconnected', 'ENOENT');
      setImmediate(() => controller.abort(reason));

      await expect(
        sessionService.listSessions({ signal: controller.signal }),
      ).rejects.toBe(reason);
      expect(statSyncSpy).toHaveBeenCalledTimes(128);
      expect(jsonl.readLines).not.toHaveBeenCalled();
    });

    it('does not yield during directory enumeration without a signal', async () => {
      manyFiles();
      const setImmediateSpy = vi.spyOn(globalThis, 'setImmediate');

      await sessionService.listSessions({ size: 0 });

      expect(statSyncSpy).toHaveBeenCalledTimes(129);
      expect(setImmediateSpy).not.toHaveBeenCalled();
    });

    it('passes cancellation to the per-file JSONL read', async () => {
      readdirSyncSpy.mockReturnValue(dirents(`${sessionIdA}.jsonl`));
      const controller = new AbortController();
      const reason = new Error('cancelled during session JSONL read');
      let readSignal: AbortSignal | undefined;
      vi.mocked(jsonl.readLines).mockImplementation(
        async (_filePath, _count, options) => {
          readSignal = options?.signal;
          await untilAborted(readSignal);
          return [];
        },
      );

      const result = sessionService.listSessions({
        signal: controller.signal,
      });
      await vi.waitFor(() => expect(readSignal).toBe(controller.signal));
      controller.abort(reason);

      await expect(result).rejects.toBe(reason);
      expect(jsonl.readLines).toHaveBeenCalledWith(
        expect.stringContaining(`${sessionIdA}.jsonl`),
        expect.any(Number),
        { signal: controller.signal },
      );
    });

    it('passes cancellation through migrated-session membership reads', async () => {
      readdirSyncSpy.mockReturnValue(dirents(`${sessionIdA}.jsonl`));
      vi.mocked(jsonl.readLines).mockResolvedValue([migratedHead]);
      otherProject();
      migrated();
      const controller = new AbortController();

      await sessionService.listSessions({ signal: controller.signal });

      expect(readRuntimeStatus).toHaveBeenCalledWith(expect.any(String), {
        signal: controller.signal,
      });
    });

    it('should return empty list when chats directory does not exist', async () => {
      readdirSyncSpy.mockImplementation(() => {
        throw enoent();
      });

      const result = await sessionService.listSessions();

      expect(result.items).toHaveLength(0);
      expect(result.hasMore).toBe(false);
    });

    it('should list sessions sorted by mtime descending', async () => {
      newestB();

      const result = await sessionService.listSessions();

      expect(result.items).toHaveLength(2);
      expect(result.items[0].sessionId).toBe(sessionIdB);
      expect(result.items[1].sessionId).toBe(sessionIdA);
    });

    it('should ignore archive directory when listing active sessions', async () => {
      readdirSyncSpy.mockReturnValue(dirents(`${sessionIdA}.jsonl`, 'archive'));
      stubStat();
      vi.mocked(jsonl.readLines).mockResolvedValue([recordA1]);

      const result = await sessionService.listSessions();

      expect(result.items.map((item) => item.sessionId)).toEqual([sessionIdA]);
      expect(result.items[0].isArchived).toBe(false);
      expect(jsonl.readLines).toHaveBeenCalledTimes(1);
      expect(vi.mocked(jsonl.readLines).mock.calls[0][0]).not.toContain(
        '/archive/',
      );
    });

    it('should list archived sessions from archive directory only', async () => {
      chatsListing([`${sessionIdA}.jsonl`], [`${sessionIdB}.jsonl`]);
      stubStat();
      vi.mocked(jsonl.readLines).mockResolvedValue([recordB1]);

      const result = await sessionService.listSessions({
        archiveState: 'archived',
      });

      expect(result.items.map((item) => item.sessionId)).toEqual([sessionIdB]);
      expect(result.items[0].isArchived).toBe(true);
      expect(vi.mocked(jsonl.readLines).mock.calls[0][0]).toContain(
        '/chats/archive/',
      );
    });

    it('getSessionInfoCounts aggregates active and archived membership', async () => {
      chatsListing(
        [`${sessionIdA}.jsonl`, 'archive', 'not-a-session.txt'],
        [`${sessionIdB}.jsonl`],
      );
      vi.mocked(jsonl.readLines).mockImplementation(async (filePath) =>
        headsById(filePath),
      );

      const result = await sessionService.getSessionInfoCounts();

      expect(result).toEqual(countsOf(1, 1));
      // Membership scan only needs the first record — never a deep read.
      for (const [, lineLimit] of vi.mocked(jsonl.readLines).mock.calls) {
        expect(lineLimit).toBe(1);
      }
    });

    it('getSessionInfoCounts excludes sessions from other projects', async () => {
      chatsListing([`${sessionIdA}.jsonl`]);
      vi.mocked(jsonl.readLines).mockResolvedValue([foreignHead]);
      otherProject();

      await expect(sessionService.getSessionInfoCounts()).resolves.toEqual(
        countsOf(0, 0),
      );
    });

    it('getSessionInfoCounts returns zeros when chats dirs are missing', async () => {
      readdirSyncSpy.mockImplementation(() => {
        throw enoent();
      });

      await expect(sessionService.getSessionInfoCounts()).resolves.toEqual(
        countsOf(0, 0),
      );
    });

    it('marks counts truncated when a candidate session cannot be read', async () => {
      chatsListing([`${sessionIdA}.jsonl`, `${sessionIdB}.jsonl`]);
      vi.mocked(jsonl.readLines).mockImplementation(
        async (filePath: string) => {
          if (filePath.includes(sessionIdA)) return [recordA1];
          throw new Error('unreadable');
        },
      );

      await expect(sessionService.getSessionInfoCounts()).resolves.toEqual(
        countsOf(1, 0, true),
      );
    });

    it('should extract prompt text from first record', async () => {
      const result = await listOne(recordA1);

      expect(result.items[0].prompt).toBe('hello session a');
      expect(result.items[0].gitBranch).toBe('main');
    });

    it('should use recorded display text for the session list prompt', async () => {
      const result = await listOne({
        ...recordA1,
        message: userText('internal channel instructions\n\nhello'),
        systemPayload: { displayText: 'hello', hookContext: '' },
      });

      expect(result.items[0].prompt).toBe('hello');
    });

    const emptyDisplay: ChatRecord = {
      ...recordA1,
      message: userText('internal channel instructions'),
      systemPayload: { displayText: '', hookContext: '' },
    };
    const laterPrompt: ChatRecord = {
      ...recordA1,
      uuid: 'later-user',
      message: userText('later prompt'),
    };

    it('should keep an intentionally empty display prompt empty', async () => {
      expect((await listOne(emptyDisplay)).items[0].prompt).toBe('');
    });

    it('should use a later prompt after an empty display prompt', async () => {
      const result = await listOne(emptyDisplay, laterPrompt);

      expect(result.items[0].prompt).toBe('later prompt');
    });

    it('should skip internal user-subtype records after an empty projection', async () => {
      const result = await listOne(
        { ...recordA1, systemPayload: { displayText: '', hookContext: '' } },
        {
          ...recordA1,
          uuid: 'cron',
          subtype: 'cron',
          message: userText('internal cron prompt'),
        },
        laterPrompt,
      );

      expect(result.items[0].prompt).toBe('later prompt');
    });

    it('should expose the Goal objective for sessions without a prompt', async () => {
      const result = await listOne(
        goalStateRecord('Ship the requested change'),
      );

      expect(result.items[0].prompt).toBe('');
      expect(result.items[0].goalObjective).toBe('Ship the requested change');
    });

    it('should recover a legacy Goal objective from the records', async () => {
      // A pre-v2 transcript has no `goal_state` line for the file scan to
      // match, so this mapping alone keeps it out of `(empty prompt)`.
      const result = await listOne(legacyGoalRecord('Ship the legacy change'));

      expect(result.items[0].goalObjective).toBe('Ship the legacy change');
    });

    it('should not label a session that already has a prompt', async () => {
      // Without this guard the objective also enters the picker's search
      // haystack, so stale goal text starts matching unrelated queries.
      const result = await listOne(
        recordA1,
        goalStateRecord('Ship the requested change'),
      );

      expect(result.items[0].prompt).not.toBe('');
      expect(result.items[0].goalObjective).toBeUndefined();
    });

    it('should not label a session that already has a custom title', async () => {
      type TitleReader = {
        readSessionTitleInfoFromFile: (filePath: string) => {
          title?: string;
          source?: string;
        };
      };
      vi.spyOn(
        sessionService as unknown as TitleReader,
        'readSessionTitleInfoFromFile',
      ).mockReturnValue({ title: 'Renamed session' });

      const result = await listOne(
        goalStateRecord('Ship the requested change'),
      );

      expect(result.items[0].goalObjective).toBeUndefined();
    });

    it('should not label a session whose Goal was cleared', async () => {
      const result = await listOne(
        goalStateRecord('Write the release notes'),
        goalStateRecord(null),
      );

      expect(result.items[0].goalObjective).toBeUndefined();
    });

    it('should NOT populate messageCount during listing', async () => {
      // Listing must skip the full-file readline counting needs: counts are
      // lazy (`countSessionMessages`, when a UI such as a preview shows them).
      // Pinned against re-adding the per-file scan that dominated /resume.
      const result = await listOne(recordA1);

      expect(result.items).toHaveLength(1);
      expect(result.items[0].messageCount).toBeUndefined();
    });

    it('should truncate long prompts', async () => {
      const result = await listOne({
        ...recordA1,
        message: userText('A'.repeat(300)),
      });

      expect(result.items[0].prompt.length).toBe(203); // 200 + '...'
      expect(result.items[0].prompt.endsWith('...')).toBe(true);
    });

    it('should truncate long prompts on code-point boundaries', async () => {
      const result = await listOne({
        ...recordA1,
        message: userText('😀'.repeat(300)),
      });

      expect(Array.from(result.items[0].prompt)).toHaveLength(203);
      expect(result.items[0].prompt).toBe(`${'😀'.repeat(200)}...`);
    });

    it('should paginate with size parameter', async () => {
      const now = Date.now();
      listIds(sessionIdA, sessionIdB, sessionIdC);
      byMtime({ [sessionIdB]: now - 1000, [sessionIdA]: now - 2000 }, now);
      vi.mocked(jsonl.readLines).mockImplementation(async (filePath) =>
        filePath.includes(sessionIdC)
          ? [{ ...recordA1, sessionId: sessionIdC }]
          : headsById(filePath),
      );

      const result = await sessionService.listSessions({ size: 2 });

      expect(result.items).toHaveLength(2);
      expect(result.items[0].sessionId).toBe(sessionIdC); // newest
      expect(result.items[1].sessionId).toBe(sessionIdB);
      expect(result.hasMore).toBe(true);
      expect(result.nextCursor).toBeDefined();
    });

    it('should paginate with cursor parameter', async () => {
      const now = Date.now();
      const cursorMtime = now - 1000;
      listIds(sessionIdA, sessionIdB, sessionIdC);
      byMtime({ [sessionIdB]: cursorMtime, [sessionIdA]: now - 2000 }, now);
      vi.mocked(jsonl.readLines).mockResolvedValue([recordA1]);

      // Items older than the cursor
      const result = await sessionService.listSessions({ cursor: cursorMtime });

      expect(result.items).toHaveLength(1);
      expect(result.items[0].sessionId).toBe(sessionIdA);
      expect(result.hasMore).toBe(false);
    });

    it('should skip files from different projects', async () => {
      otherProject();

      expect((await listOne(foreignHead)).items).toHaveLength(0);
    });

    it('should list a migrated session when runtime status matches this project', async () => {
      migrated();
      otherProject();

      const result = await listOne(migratedHead);

      expect(result.items).toHaveLength(1);
      expect(result.items[0].sessionId).toBe(sessionIdA);
    });

    it('should skip files that do not match session file pattern', async () => {
      readdirSyncSpy.mockReturnValue(
        dirents(
          `${sessionIdA}.jsonl`, // valid
          'not-a-uuid.jsonl', // invalid pattern
          'readme.txt', // not jsonl
          '.hidden.jsonl', // hidden file
        ),
      );
      stubStat();
      vi.mocked(jsonl.readLines).mockResolvedValue([recordA1]);

      const result = await sessionService.listSessions();

      expect(result.items).toHaveLength(1);
      expect(result.items[0].sessionId).toBe(sessionIdA);
    });
  });

  describe('loadSession', () => {
    const load = (records: ChatRecord[], sessionId = sessionIdB) => {
      stubStat();
      vi.mocked(jsonl.read).mockResolvedValue(records);
      return sessionService.loadSession(sessionId);
    };
    const loadArchivedB = () =>
      sessionService.loadArchivedSession(sessionIdB, {
        maxBytes: SESSION_TRANSCRIPT_MAX_INDEX_BYTES,
      });
    const uuidsOf = (loaded: Awaited<ReturnType<typeof load>>) =>
      loaded?.conversation.messages.map((record) => record.uuid);
    /** A B-session artifact side record linking to a slug of `title`. */
    const linkRecord = (
      uuid: string,
      parentUuid: string,
      title: string,
      base = recordB1,
    ) => {
      const slug = title.toLowerCase().replace(/ /g, '-');
      const url = `https://example.com/${slug}`;
      const artifactId = stableSessionArtifactId(sessionIdB, `url:${url}`);
      const record = sideRecord(
        base,
        uuid,
        parentUuid,
        'session_artifact_event',
        artifactPayload(sessionIdB, 1, '2026-07-06T00:00:00.000Z', [
          linkCreated(artifactId, title, url, '2026-07-06T00:00:00.000Z'),
        ]),
      );
      return { artifactId, record };
    };
    // `a.txt` snapshots for prompt p1 taken at 2026-06-13T00:0<minute>:00Z,
    // backed up one second later: as persisted, and as loadSession restores.
    const june = (minute: number, second: number) =>
      `2026-06-13T00:0${minute}:0${second}.000Z`;
    const snapshotRecord = (
      uuid: string,
      parentUuid: string,
      minute: number,
      backupFileName: string,
      version = 1,
    ) =>
      sideRecord(
        recordB1,
        uuid,
        parentUuid,
        'file_history_snapshot',
        snapshotPayload(
          'p1',
          june(minute, 0),
          { 'a.txt': backupFileName },
          june(minute, 1),
          version,
        ),
      );
    const restored = (minute: number, backupFileName: string, version = 1) => [
      {
        promptId: 'p1',
        timestamp: new Date(june(minute, 0)),
        trackedFileBackups: {
          'a.txt': {
            backupFileName,
            version,
            backupTime: new Date(june(minute, 1)),
            failed: undefined,
          },
        },
      },
    ];

    it('should load a session by id and reconstruct history', async () => {
      const loaded = await load([recordB1, recordB2]);

      expect(loaded?.conversation.sessionId).toBe(sessionIdB);
      expect(loaded?.conversation.messages).toHaveLength(2);
      expect(loaded?.conversation.messages[0].uuid).toBe('b1');
      expect(loaded?.conversation.messages[1].uuid).toBe('b2');
      expect(loaded?.lastCompletedUuid).toBe('b2');
    });

    it('reads archived sessions only through the explicit read-only method', async () => {
      stubStat();
      vi.mocked(jsonl.read).mockResolvedValue([recordB1, recordB2]);

      const loaded = await loadArchivedB();

      expect(loaded?.conversation.messages).toHaveLength(2);
      expect(vi.mocked(jsonl.read)).toHaveBeenCalledWith(
        expect.stringContaining(`/chats/archive/${sessionIdB}.jsonl`),
        { onIncompleteRead: expect.any(Function) },
      );
      expect(statSyncSpy).toHaveBeenCalledTimes(1);
    });

    it('accepts an archived session exactly at the requested size limit', async () => {
      stubStat({ size: SESSION_TRANSCRIPT_MAX_INDEX_BYTES });
      vi.mocked(jsonl.read).mockResolvedValue([recordB1, recordB2]);

      await expect(loadArchivedB()).resolves.toBeDefined();
    });

    it('rejects an archived session above the requested size limit', async () => {
      const snapshotSize = SESSION_TRANSCRIPT_MAX_INDEX_BYTES + 1;
      stubStat({ size: snapshotSize });

      await expect(loadArchivedB()).rejects.toEqual(
        new SessionTranscriptTooLargeError(
          sessionIdB,
          snapshotSize,
          SESSION_TRANSCRIPT_MAX_INDEX_BYTES,
        ),
      );
      expect(vi.mocked(jsonl.read)).not.toHaveBeenCalled();
    });

    it('rejects invalid archived session ids before accessing storage', async () => {
      await expect(
        sessionService.loadArchivedSession('../outside', {
          maxBytes: SESSION_TRANSCRIPT_MAX_INDEX_BYTES,
        }),
      ).resolves.toBeUndefined();
      expect(statSyncSpy).not.toHaveBeenCalled();
      expect(vi.mocked(jsonl.read)).not.toHaveBeenCalled();
    });

    it('returns undefined when the archived file is missing at the size check', async () => {
      statSyncSpy.mockImplementationOnce(() => {
        throw errno('missing', 'ENOENT');
      });

      await expect(loadArchivedB()).resolves.toBeUndefined();
      expect(vi.mocked(jsonl.read)).not.toHaveBeenCalled();
    });

    it('loads artifact side records attached to the active branch', async () => {
      const { artifactId, record } = linkRecord('artifact-1', 'b1', 'Report');

      const loaded = await load([recordB1, record, recordB2]);

      expect(uuidsOf(loaded)).toEqual(['b1', 'b2']);
      expect(loaded?.artifactSnapshot?.artifacts).toEqual([
        expect.objectContaining({ id: artifactId, title: 'Report' }),
      ]);
    });

    it('loads artifact side records after a tail-neutral title reanchor', async () => {
      const titleRecord = sideRecord(
        recordB1,
        'title-reanchor',
        'b1',
        'custom_title',
        {
          customTitle: 'Reanchored title',
          titleSource: 'auto',
        },
      );
      const { artifactId, record } = linkRecord(
        'artifact-after-title',
        'b1',
        'Reanchored report',
      );

      const loaded = await load([recordB1, titleRecord, record, recordB2]);

      expect(uuidsOf(loaded)).toEqual(['b1', 'b2']);
      expect(loaded?.artifactSnapshot?.artifacts).toEqual([
        expect.objectContaining({ id: artifactId, title: 'Reanchored report' }),
      ]);
    });

    it('loads chained artifact side records attached to the active branch', async () => {
      const { artifactId, record } = linkRecord(
        'artifact-create',
        'b1',
        'Chained report',
      );
      const removeRecord = sideRecord(
        recordB1,
        'artifact-remove',
        'artifact-create',
        'session_artifact_event',
        artifactPayload(sessionIdB, 2, '2026-07-06T00:00:01.000Z', [
          linkRemoved(artifactId),
        ]),
      );

      const loaded = await load([recordB1, record, removeRecord, recordB2]);

      expect(uuidsOf(loaded)).toEqual(['b1', 'b2']);
      expect(loaded?.artifactSnapshot?.artifacts).toEqual([]);
      expect(loaded?.artifactSnapshot?.tombstonedIds).toContain(artifactId);
    });

    it('does not load artifact side records from abandoned branches', async () => {
      const { record } = linkRecord(
        'artifact-abandoned',
        'b1',
        'Abandoned report',
      );
      const abandonedChild: ChatRecord = {
        ...recordB2,
        uuid: 'abandoned-child',
        parentUuid: 'b1',
      };

      const loaded = await load([recordB1, record, abandonedChild, recordB2]);

      expect(uuidsOf(loaded)).toEqual(['b1', 'b2']);
      expect(loaded?.artifactSnapshot).toBeUndefined();
    });

    it('does not treat trailing artifact side records as the conversation leaf', async () => {
      const { artifactId, record } = linkRecord(
        'artifact-tail',
        'b2',
        'Trailing report',
        recordB2,
      );

      const loaded = await load([recordB1, recordB2, record]);

      expect(uuidsOf(loaded)).toEqual(['b1', 'b2']);
      expect(loaded?.lastCompletedUuid).toBe('b2');
      expect(loaded?.artifactSnapshot?.artifacts).toEqual([
        expect.objectContaining({ id: artifactId, title: 'Trailing report' }),
      ]);
    });

    it('keeps the latest file history snapshot for a prompt id', async () => {
      const loaded = await load([
        recordB1,
        snapshotRecord('s1', 'b1', 0, 'old-backup'),
        snapshotRecord('s2', 's1', 1, 'updated-backup', 2),
      ]);

      expect(loaded?.fileHistorySnapshots).toEqual(
        restored(1, 'updated-backup', 2),
      );
    });

    it('ignores file history snapshots on a rewound inactive branch', async () => {
      const loaded = await load([
        recordB1,
        snapshotRecord('stale-snapshot', 'b1', 0, 'stale-backup'),
        sideRecord(recordB1, 'rewind', 'b1', 'rewind', { truncatedCount: 1 }),
        snapshotRecord(
          'surviving-snapshot',
          'rewind',
          1,
          'surviving-backup',
          2,
        ),
      ]);

      expect(loaded?.fileHistorySnapshots).toEqual(
        restored(1, 'surviving-backup', 2),
      );
    });

    it('leaves file history snapshots undefined when none are recorded', async () => {
      const loaded = await load([recordB1, recordB2]);

      expect(loaded?.fileHistorySnapshots).toBeUndefined();
    });

    it('skips malformed file history snapshot records and keeps later valid ones', async () => {
      const loaded = await load([
        recordB1,
        sideRecord(recordB1, 'bad-snapshot', 'b1', 'file_history_snapshot', {
          snapshots: [{ promptId: 'bad', timestamp: 'not-enough-fields' }],
        }),
        snapshotRecord('good-snapshot', 'bad-snapshot', 0, 'backup-a'),
      ]);

      expect(loaded?.fileHistorySnapshots).toEqual(restored(0, 'backup-a'));
    });

    it('should return undefined when session file is empty', async () => {
      vi.mocked(jsonl.read).mockResolvedValue([]);

      expect(await sessionService.loadSession('nonexistent')).toBeUndefined();
    });

    it('should return undefined when session belongs to different project', async () => {
      otherProject();

      expect(await load([foreignHead], sessionIdA)).toBeUndefined();
    });

    it('should load a migrated session when runtime status matches this project', async () => {
      migrated();
      otherProject();

      const loaded = await load([migratedHead], sessionIdA);

      expect(loaded?.conversation.sessionId).toBe(sessionIdA);
      expect(loaded?.conversation.projectHash).toBe('test-project-hash');
    });

    /** A 'test'-session record at 00:0<minute>:00 (`fields` may override). */
    const testRecord = (
      uuid: string,
      parentUuid: string | null,
      minute: number,
      fields: Partial<ChatRecord>,
    ): ChatRecord => ({
      uuid,
      parentUuid,
      sessionId: 'test',
      timestamp: `2024-01-01T00:0${minute}:00Z`,
      type: 'user',
      cwd: '/test/project/root',
      version: '1.0.0',
      ...fields,
    });

    it('should reconstruct tree-structured history correctly', async () => {
      const loaded = await load(
        [
          testRecord('r1', null, 0, { message: userText('First') }),
          testRecord('r2', 'r1', 1, {
            type: 'assistant',
            message: modelText('Second'),
          }),
          testRecord('r3', 'r2', 2, { message: userText('Third') }),
        ],
        'test',
      );

      expect(loaded?.conversation.messages).toHaveLength(3);
      expect(loaded?.conversation.messages.map((m) => m.uuid)).toEqual([
        'r1',
        'r2',
        'r3',
      ]);
    });

    it('should aggregate multiple records with same uuid', async () => {
      const loaded = await load(
        [
          testRecord('u1', null, 0, { message: userText('Hello') }),
          testRecord('a1', 'u1', 1, {
            type: 'assistant',
            message: {
              role: 'model',
              parts: [{ thought: true, text: 'Thinking...' }],
            },
          }),
          testRecord('a1', 'u1', 1, {
            type: 'assistant',
            timestamp: '2024-01-01T00:01:01Z',
            usageMetadata: {
              promptTokenCount: 10,
              candidatesTokenCount: 20,
              cachedContentTokenCount: 0,
              totalTokenCount: 30,
            },
          }),
          testRecord('a1', 'u1', 1, {
            type: 'assistant',
            timestamp: '2024-01-01T00:01:02Z',
            message: modelText('Response'),
            model: 'gemini-pro',
          }),
        ],
        'test',
      );

      expect(loaded?.conversation.messages).toHaveLength(2);

      const assistantMsg = loaded?.conversation.messages[1];
      expect(assistantMsg?.uuid).toBe('a1');
      expect(assistantMsg?.message?.parts).toHaveLength(2);
      expect(assistantMsg?.usageMetadata?.totalTokenCount).toBe(30);
      expect(assistantMsg?.model).toBe('gemini-pro');
    });
  });

  describe('removeSession', () => {
    const lifecycleParent = { device: 7, inode: 9, inodeVerifiable: true };
    const dirStats = (ino = 9) =>
      ({ dev: 7, ino, isDirectory: () => true }) as fs.Stats;
    /** fs.promises.open yields a directory handle whose stat is `stats`. */
    const openDir = (
      stats: fs.Stats,
      sync: () => Promise<void> = vi.fn(async () => undefined),
      close = vi.fn(async () => undefined),
    ) => ({
      open: vi.spyOn(fs.promises, 'open').mockResolvedValue({
        stat: vi.fn(async () => stats),
        sync,
        close,
      } as unknown as fs.promises.FileHandle),
      sync,
      close,
    });
    const syncFails = (error: Error) =>
      vi.fn(async () => Promise.reject(error));
    const removeActiveForLifecycle = () =>
      sessionService.removeSessionTranscriptForLifecycle(
        sessionIdA,
        'active',
        lifecycleParent,
      );
    const activeTranscriptOnly = () => {
      onlyIn('active');
      existsSyncSpy.mockReturnValue(true);
    };
    const expectHistoryRemoved = () =>
      expect(rmSyncSpy).toHaveBeenCalledWith(
        expect.stringContaining(`file-history/${sessionIdA}`),
        { recursive: true, force: true },
      );
    const cleanupForLifecycle = () =>
      sessionService.cleanupRemovedSessionStateForLifecycle(sessionIdA);
    const spyOrganizationRemove = () =>
      vi.spyOn(SessionOrganizationService.prototype, 'removeSession');
    const removeA = (
      options?: Parameters<SessionService['removeSession']>[1],
    ) => sessionService.removeSession(sessionIdA, options);

    it('should remove session file', async () => {
      vi.mocked(jsonl.readLines).mockResolvedValue([recordA1]);

      expect(await removeA()).toBe(true);
      expect(unlinkSyncSpy).toHaveBeenCalled();
      // #7384: the usage salvage must see the transcript BEFORE it is
      // unlinked, or the summary is unrecoverable.
      const salvage = vi.mocked(prepareUsageBeforeTranscriptDeletion);
      expect(salvage).toHaveBeenCalledWith(
        expect.stringContaining(`${sessionIdA}.jsonl`),
      );
      expect(salvage.mock.invocationCallOrder[0]!).toBeLessThan(
        unlinkSyncSpy.mock.invocationCallOrder[0]!,
      );
      expect(
        vi.mocked(commitUsageBeforeTranscriptDeletion).mock
          .invocationCallOrder[0]!,
      ).toBeGreaterThan(unlinkSyncSpy.mock.invocationCallOrder[0]!);
      expectHistoryRemoved();
    });

    it('still deletes the session when the usage salvage fails', async () => {
      // Contract: the salvage must never block deletion.
      vi.mocked(prepareUsageBeforeTranscriptDeletion).mockRejectedValueOnce(
        new Error('salvage exploded'),
      );
      vi.mocked(jsonl.readLines).mockResolvedValue([recordA1]);

      await expect(removeA()).resolves.toBe(true);
      expect(unlinkSyncSpy).toHaveBeenCalled();
    });

    it('does not commit usage when a mutation fence rejects deletion', async () => {
      vi.mocked(jsonl.readLines).mockResolvedValue([recordA1]);
      const rejected = new Error('generation changed');

      await expect(
        removeA({
          assertCanMutate: () => {
            throw rejected;
          },
        }),
      ).rejects.toBe(rejected);

      expect(prepareUsageBeforeTranscriptDeletion).toHaveBeenCalled();
      expect(commitUsageBeforeTranscriptDeletion).not.toHaveBeenCalled();
      expect(unlinkSyncSpy).not.toHaveBeenCalled();
    });

    it('finishes committed deletion cleanup after the generation closes', async () => {
      vi.mocked(jsonl.readLines).mockResolvedValue([recordA1]);
      const assertCanMutate = closesAfterFirst();
      const assertCleanupOwned = vi.fn();
      const removeOrganizationSpy = spyOrganizationRemove().mockImplementation(
        async (_sessionId, options) => {
          options?.assertCanCommit?.();
        },
      );

      await expect(
        removeA({ assertCanMutate, assertCleanupOwned }),
      ).resolves.toBe(true);

      expect(assertCanMutate).toHaveBeenCalledOnce();
      expect(assertCleanupOwned).toHaveBeenCalledTimes(7);
      expect(removeOrganizationSpy).toHaveBeenCalledWith(sessionIdA, {
        assertCanCommit: assertCleanupOwned,
      });
      expectHistoryRemoved();
    });

    it('stops committed deletion cleanup after writer ownership is lost', async () => {
      vi.mocked(jsonl.readLines).mockResolvedValue([recordA1]);
      const ownershipLost = new Error('writer ownership lost');

      await expect(
        removeA({
          assertCanMutate: vi.fn(),
          assertCleanupOwned: () => {
            throw ownershipLost;
          },
        }),
      ).rejects.toBe(ownershipLost);

      expect(unlinkSyncSpy).toHaveBeenCalledTimes(2);
      expect(rmSyncSpy).not.toHaveBeenCalled();
    });

    it('does not commit usage when transcript deletion fails', async () => {
      vi.mocked(jsonl.readLines).mockResolvedValue([recordA1]);
      const unlinkError = errno('permission denied', 'EACCES');
      unlinkSyncSpy.mockImplementationOnce(() => {
        throw unlinkError;
      });

      await expect(removeA()).rejects.toBe(unlinkError);

      expect(prepareUsageBeforeTranscriptDeletion).toHaveBeenCalled();
      expect(commitUsageBeforeTranscriptDeletion).not.toHaveBeenCalled();
    });

    it('commits usage when a later transcript deletion fails', async () => {
      vi.mocked(jsonl.readLines).mockResolvedValue([recordA1]);
      existsFor(`/chats/archive/${sessionIdA}.jsonl`);
      const unlinkError = errno('permission denied', 'EACCES');
      unlinkSyncSpy
        .mockImplementationOnce(() => undefined)
        .mockImplementationOnce(() => {
          throw unlinkError;
        });

      await expect(removeA()).rejects.toBe(unlinkError);

      expect(unlinkSyncSpy).toHaveBeenCalledTimes(2);
      expect(commitUsageBeforeTranscriptDeletion).toHaveBeenCalledTimes(1);
      const commitOrder = vi.mocked(commitUsageBeforeTranscriptDeletion).mock
        .invocationCallOrder[0]!;
      const unlinkOrder = unlinkSyncSpy.mock.invocationCallOrder;
      expect(commitOrder).toBeGreaterThan(unlinkOrder[0]!);
      expect(commitOrder).toBeLessThan(unlinkOrder[1]!);
    });

    it('should clear session organization when removing a session', async () => {
      const { service, warnings } = withWarnings();
      sessionService = service;
      const removeOrganizationSpy = spyOrganizationRemove().mockImplementation(
        function (this: { onWarning?: (message: string) => void }) {
          this.onWarning?.('sidecar warning');
          return Promise.resolve();
        },
      );
      vi.mocked(jsonl.readLines).mockResolvedValue([recordA1]);

      expect(await removeA()).toBe(true);
      expect(removeOrganizationSpy).toHaveBeenCalledWith(sessionIdA);
      expect(warnings).toEqual(['sidecar warning']);
    });

    it('should return false when session does not exist', async () => {
      vi.mocked(jsonl.readLines).mockResolvedValue([]);

      const result = await sessionService.removeSession(
        '00000000-0000-0000-0000-000000000000',
      );

      expect(result).toBe(false);
      expect(unlinkSyncSpy).not.toHaveBeenCalled();
    });

    it('should return false for session from different project', async () => {
      vi.mocked(jsonl.readLines).mockResolvedValue([foreignHead]);
      otherProject();

      expect(await removeA()).toBe(false);
      expect(unlinkSyncSpy).not.toHaveBeenCalled();
    });

    it('should remove a migrated session when runtime status matches this project', async () => {
      vi.mocked(jsonl.readLines).mockResolvedValue([migratedHead]);
      migrated();
      otherProject();

      expect(await removeA()).toBe(true);
      expect(unlinkSyncSpy).toHaveBeenCalled();
    });

    it('should handle file not found error', async () => {
      vi.mocked(jsonl.readLines).mockRejectedValue(enoent());

      const result = await sessionService.removeSession(
        '00000000-0000-0000-0000-000000000000',
      );

      expect(result).toBe(false);
    });

    it.each([
      [
        'should remove archived session files and both worktree sidecars',
        '.worktree.json',
      ],
      [
        'should remove pr sidecars in both states when removing a session',
        '.pr.json',
      ],
      [
        'should remove prompt ledger sidecars in both archive states',
        '.ledger.jsonl',
      ],
    ])('%s', async (_title, ext) => {
      onlyIn('archived');
      existsFor(`${sessionIdA}${ext}`);

      expect(await removeA()).toBe(true);
      expect(unlinkSyncSpy).toHaveBeenCalledWith(inArchive());
      expect(unlinkSyncSpy).toHaveBeenCalledWith(inChats(ext));
      expect(unlinkSyncSpy).toHaveBeenCalledWith(inArchive(ext));
    });

    it('should remove both JSONL files when active and archived copies conflict', async () => {
      vi.mocked(jsonl.readLines).mockResolvedValue([recordA1]);
      existsFor(`/chats/archive/${sessionIdA}.jsonl`);

      expect(await removeA()).toBe(true);
      expect(unlinkSyncSpy).toHaveBeenCalledWith(inChats());
      expect(unlinkSyncSpy).toHaveBeenCalledWith(inArchive());
      // #7425 review follow-up: salvage the archived copy's usage too — with a
      // telemetry-less fresh active copy it holds the session's only history.
      // Pinned so dropping the "redundant-looking" archived salvage fails.
      expect(
        vi.mocked(prepareUsageBeforeTranscriptDeletion),
      ).toHaveBeenCalledWith(inArchive());
    });

    it('can commit only the active transcript for lifecycle deletion', async () => {
      activeTranscriptOnly();
      const removeOrganizationSpy = spyOrganizationRemove();
      statPromiseSpy.mockResolvedValue(dirStats());
      const { open, sync, close } = openDir(dirStats());

      expect(await removeActiveForLifecycle()).toBe(true);
      expect(unlinkSyncSpy).toHaveBeenCalledTimes(1);
      expect(unlinkSyncSpy).toHaveBeenCalledWith(inChats());
      expect(commitUsageBeforeTranscriptDeletion).toHaveBeenCalledOnce();
      expect(rmSyncSpy).not.toHaveBeenCalled();
      expect(removeOrganizationSpy).not.toHaveBeenCalled();
      expect(open).toHaveBeenCalledWith(
        expect.stringContaining('/chats'),
        expect.any(Number),
      );
      expect(sync).toHaveBeenCalledOnce();
      expect(close).toHaveBeenCalledOnce();
    });

    it('surfaces transcript parent sync failure after lifecycle unlink', async () => {
      activeTranscriptOnly();
      const syncError = errno('sync failed', 'EIO');
      statPromiseSpy.mockResolvedValue(dirStats());
      openDir(dirStats(), syncFails(syncError));

      await expect(removeActiveForLifecycle()).rejects.toMatchObject({
        name: 'SessionTranscriptDurabilityError',
        cause: syncError,
      } satisfies Partial<SessionTranscriptDurabilityError>);

      expect(unlinkSyncSpy).toHaveBeenCalledWith(inChats());
    });

    it('rejects lifecycle durability when the transcript parent is replaced after unlink', async () => {
      activeTranscriptOnly();
      statPromiseSpy
        .mockResolvedValueOnce(dirStats())
        .mockResolvedValueOnce(dirStats())
        .mockResolvedValueOnce(dirStats(10));
      openDir(dirStats());

      await expect(removeActiveForLifecycle()).rejects.toBeInstanceOf(
        SessionTranscriptDurabilityError,
      );

      expect(unlinkSyncSpy).toHaveBeenCalledOnce();
    });

    it('rejects recovery confirmation for a replacement transcript parent', async () => {
      statPromiseSpy.mockResolvedValue(dirStats(10));
      const { sync } = openDir(dirStats(10));

      await expect(
        sessionService.confirmSessionTranscriptDeletionForLifecycle(
          'active',
          lifecycleParent,
        ),
      ).rejects.toBeInstanceOf(SessionTranscriptDurabilityError);

      expect(sync).not.toHaveBeenCalled();
    });

    it('does not hide lifecycle directory I/O failures on Windows', async () => {
      activeTranscriptOnly();
      vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
      statPromiseSpy.mockResolvedValue(dirStats());
      const syncError = errno('sync failed', 'EIO');
      openDir(dirStats(), syncFails(syncError));

      await expect(removeActiveForLifecycle()).rejects.toMatchObject({
        cause: syncError,
      });
    });

    it('rejects lifecycle deletion when active and archived transcripts conflict', async () => {
      vi.mocked(jsonl.readLines).mockResolvedValue([recordA1]);

      await expect(removeActiveForLifecycle()).rejects.toBeInstanceOf(
        SessionTranscriptChangedError,
      );

      expect(prepareUsageBeforeTranscriptDeletion).not.toHaveBeenCalled();
      expect(unlinkSyncSpy).not.toHaveBeenCalled();
    });

    it('rejects lifecycle deletion when the transcript moved states', async () => {
      onlyIn('archived');

      await expect(removeActiveForLifecycle()).rejects.toBeInstanceOf(
        SessionTranscriptChangedError,
      );

      expect(unlinkSyncSpy).not.toHaveBeenCalled();
    });

    it('cleans sidecars after the transcript is already absent', async () => {
      existsFor(
        `${sessionIdA}.worktree.json`,
        `${sessionIdA}.pr.json`,
        `${sessionIdA}.ledger.jsonl`,
      );
      const removeOrganizationSpy = spyOrganizationRemove().mockResolvedValue();

      await sessionService.cleanupRemovedSessionState(sessionIdA);

      for (const sidecar of ['.worktree.json', '.pr.json', '.ledger.jsonl']) {
        expect(unlinkSyncSpy).toHaveBeenCalledWith(
          expect.stringContaining(`${sessionIdA}${sidecar}`),
        );
      }
      expectHistoryRemoved();
      expect(removeOrganizationSpy).toHaveBeenCalledWith(sessionIdA);
    });

    it('durably confirms lifecycle sidecar cleanup before returning', async () => {
      statPromiseSpy.mockResolvedValue(dirStats());
      const { open, sync, close } = openDir(dirStats());
      spyOrganizationRemove().mockResolvedValue();

      await cleanupForLifecycle();

      expect(open).toHaveBeenCalledTimes(4);
      expect(sync).toHaveBeenCalledTimes(4);
      expect(close).toHaveBeenCalledTimes(4);
    });

    it('rejects a replacement sidecar parent before lifecycle cleanup', async () => {
      for (let i = 0; i < 4; i++)
        statPromiseSpy.mockResolvedValueOnce(dirStats());
      statPromiseSpy.mockResolvedValueOnce(dirStats(10));
      openDir(dirStats());
      const removeOrganization = spyOrganizationRemove();

      await expect(cleanupForLifecycle()).rejects.toThrow(
        'Session transcript parent directory changed.',
      );

      expect(unlinkSyncSpy).not.toHaveBeenCalled();
      expect(rmSyncSpy).not.toHaveBeenCalled();
      expect(removeOrganization).not.toHaveBeenCalled();
    });

    it('rejects a vanished sidecar parent after opening it', async () => {
      const vanished = enoent();
      statPromiseSpy.mockRejectedValueOnce(vanished);
      const { close } = openDir(dirStats());
      const removeOrganization = spyOrganizationRemove();

      await expect(cleanupForLifecycle()).rejects.toBe(vanished);

      expect(close).toHaveBeenCalledOnce();
      expect(unlinkSyncSpy).not.toHaveBeenCalled();
      expect(rmSyncSpy).not.toHaveBeenCalled();
      expect(removeOrganization).not.toHaveBeenCalled();
    });

    it('surfaces lifecycle sidecar cleanup failures for retry', async () => {
      const cleanupError = new Error('organization cleanup failed');
      spyOrganizationRemove().mockRejectedValue(cleanupError);

      await expect(
        sessionService.cleanupRemovedSessionState(sessionIdA),
      ).rejects.toBe(cleanupError);
    });
  });

  // archive/unarchiveSessions mirror each other: `mirror(kind)` names the
  // move's paths and runs it on sessionIdA; the cases run once per direction.
  type MoveKind = 'archive' | 'unarchive';
  const mirror = (kind: MoveKind) => {
    const toArchive = kind === 'archive';
    return {
      from: toArchive ? inChats : inArchive,
      to: toArchive ? inArchive : inChats,
      /** Only the source state's copy of `ext` exists. */
      existsAtSource: (ext: string) =>
        existsFor(`/chats/${toArchive ? '' : 'archive/'}${sessionIdA}${ext}`),
      seed: () => onlyIn(toArchive ? 'active' : 'archived'),
      run: async (
        options?: Record<string, unknown>,
        service = sessionService,
      ) => {
        const result = toArchive
          ? await service.archiveSessions(
              [sessionIdA],
              options as ArchiveSessionsOptions | undefined,
            )
          : await service.unarchiveSessions(
              [sessionIdA],
              options as UnarchiveSessionsOptions | undefined,
            );
        // Read only the key this direction must return, as the original
        // per-direction tests did: a wrong-direction key must fail.
        const moved = (result as unknown as Record<string, unknown>)[
          toArchive ? 'archived' : 'unarchived'
        ];
        return { ...result, moved };
      },
    };
  };
  /** mirror(kind) with sessionIdA (and `ext`, if given) in the source state. */
  const seeded = (kind: MoveKind, ext?: string) => {
    const m = mirror(kind);
    m.seed();
    if (ext) m.existsAtSource(ext);
    return m;
  };
  const failSidecarRename = (ext: string, message: string) =>
    renameSyncSpy.mockImplementation((sourcePath) => {
      if (sourcePath.toString().endsWith(ext)) throw new Error(message);
      return undefined;
    });
  const mirrored = {
    movesPrSidecar: async (kind: MoveKind) => {
      const m = seeded(kind);

      const result = await m.run();

      expect(result.moved).toEqual([sessionIdA]);
      expect(result.errors).toEqual([]);
      // The move runs through the locked service function: the session
      // child's shell binder may hold a pending write on either half.
      expect(moveSessionPrSidecar).toHaveBeenCalledWith(
        m.from('.pr.json'),
        m.to('.pr.json'),
        undefined,
      );
    },
    warnsOnPrSidecarFailure: async (kind: MoveKind) => {
      const m = seeded(kind);
      vi.mocked(moveSessionPrSidecar).mockRejectedValueOnce(
        new Error('pr move failed'),
      );
      const { service, warnings } = withWarnings();

      const result = await m.run(undefined, service);

      expect(result.moved).toEqual([sessionIdA]);
      expect(result.errors).toEqual([]);
      expect(
        warnings.some((message) =>
          message.includes('failed to move pr sidecar'),
        ),
      ).toBe(true);
    },
    movesKnownLocation: async (kind: MoveKind) => {
      const m = seeded(kind);

      const result = await m.run({
        knownLocation: kind === 'archive' ? 'active' : 'archived',
      });

      expect(result.moved).toEqual([sessionIdA]);
      expect(result.errors).toEqual([]);
      expect(renameSyncSpy).toHaveBeenCalledWith(m.from(), m.to());
    },
    rejectedConflictRepairCommitsNothing: async (kind: MoveKind) => {
      vi.mocked(jsonl.readLines).mockResolvedValue([recordA1]);

      const result = await mirror(kind).run({
        resolveConflicts: true,
        assertCanMutate: () => {
          throw new Error('generation changed');
        },
      });

      expect(result.errors).toHaveLength(1);
      expect(prepareUsageBeforeTranscriptDeletion).not.toHaveBeenCalled();
      expect(commitUsageBeforeTranscriptDeletion).not.toHaveBeenCalled();
      expect(unlinkSyncSpy).not.toHaveBeenCalled();
    },
    conflictRepairSkipsFinalUsage: async (kind: MoveKind) => {
      vi.mocked(jsonl.readLines).mockResolvedValue([recordA1]);

      const result = await mirror(kind).run({ resolveConflicts: true });

      expect(result).toMatchObject({
        moved: [sessionIdA],
        resolvedConflicts: [sessionIdA],
        errors: [],
      });
      expect(prepareUsageBeforeTranscriptDeletion).not.toHaveBeenCalled();
      expect(commitUsageBeforeTranscriptDeletion).not.toHaveBeenCalled();
    },
    finishesConflictCleanup: async (kind: MoveKind) => {
      vi.mocked(jsonl.readLines).mockResolvedValue([recordA1]);
      const assertCanMutate = closesAfterFirst();
      const assertCleanupOwned = vi.fn();

      const result = await mirror(kind).run({
        resolveConflicts: true,
        assertCanMutate,
        assertCleanupOwned,
      });

      expect(result).toMatchObject({
        moved: [sessionIdA],
        resolvedConflicts: [sessionIdA],
        errors: [],
      });
      expect(assertCanMutate).toHaveBeenCalledOnce();
      expect(assertCleanupOwned).toHaveBeenCalledTimes(3);
    },
    warnsOnWorktreeSidecarFailure: async (kind: MoveKind) => {
      const m = seeded(kind, '.worktree.json');
      const { service, warnings } = withWarnings();
      failSidecarRename('.worktree.json', 'sidecar move failed');

      const result = await m.run(undefined, service);

      expect(result.moved).toEqual([sessionIdA]);
      expect(result.errors).toEqual([]);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(
        `${kind}Sessions: failed to move worktree sidecar for ${sessionIdA}`,
      );
      expect(renameSyncSpy).toHaveBeenCalledWith(m.from(), m.to());
      expect(renameSyncSpy).toHaveBeenCalledWith(
        m.from('.worktree.json'),
        m.to('.worktree.json'),
      );
    },
    finishesSidecarsAfterGenerationCloses: async (kind: MoveKind) => {
      const m = seeded(kind, '.worktree.json');
      const assertCanMutate = closesAfterFirst();
      const assertCleanupOwned = vi.fn();

      const result = await m.run({ assertCanMutate, assertCleanupOwned });

      expect(result.moved).toEqual([sessionIdA]);
      expect(result.errors).toEqual([]);
      expect(assertCanMutate).toHaveBeenCalledOnce();
      expect(assertCleanupOwned).toHaveBeenCalled();
      expect(renameSyncSpy).toHaveBeenCalledWith(m.from(), m.to());
      expect(renameSyncSpy).toHaveBeenCalledWith(
        m.from('.worktree.json'),
        m.to('.worktree.json'),
      );
    },
    stopsSidecarCleanupWhenOwnershipLost: async (kind: MoveKind) => {
      const m = seeded(kind, '.worktree.json');
      const ownershipLost = new Error('writer ownership lost');

      const result = await m.run({
        assertCanMutate: vi.fn(),
        assertCleanupOwned: () => {
          throw ownershipLost;
        },
      });

      expect(result.errors[0]?.error).toBe(ownershipLost);
      expect(renameSyncSpy).toHaveBeenCalledWith(m.from(), m.to());
      expect(renameSyncSpy).not.toHaveBeenCalledWith(
        m.from('.worktree.json'),
        expect.anything(),
      );
    },
    movesPromptLedger: async (kind: MoveKind) => {
      const m = seeded(kind, '.ledger.jsonl');

      const result = await m.run();

      expect(result.moved).toEqual([sessionIdA]);
      expect(result.errors).toEqual([]);
      expect(renameSyncSpy).toHaveBeenCalledWith(
        m.from('.ledger.jsonl'),
        m.to('.ledger.jsonl'),
      );
    },
    keepsSidecarWhenTranscriptMoveFails: async (
      kind: MoveKind,
      code: string,
      description: string,
    ) => {
      const m = seeded(kind, '.worktree.json');
      const [src, dst] = [
        `/chats/${sessionIdA}.jsonl`,
        `/chats/archive/${sessionIdA}.jsonl`,
      ];
      const [from, to] = kind === 'archive' ? [src, dst] : [dst, src];
      const jsonlError = errno(
        `${code}: ${description}, rename '/tmp/runtime${from}' -> '/tmp/runtime${to}'`,
        code,
      );
      renameSyncSpy.mockImplementation((sourcePath) => {
        const source = sourcePath.toString();
        if (
          source.endsWith('.jsonl') &&
          (kind === 'archive' || source.includes('/chats/archive/'))
        ) {
          throw jsonlError;
        }
        return undefined;
      });

      const result = await m.run();

      expect(result.moved).toEqual([]);
      expect(result.errors[0]?.sessionId).toBe(sessionIdA);
      expect(result.errors[0]?.error.message).toBe(
        `Failed to ${kind} session file: ${code}`,
      );
      expect(result.errors[0]?.error.message).not.toContain('/tmp/runtime');
      expect(renameSyncSpy).toHaveBeenCalledWith(m.from(), m.to());
      expect(renameSyncSpy).not.toHaveBeenCalledWith(
        m.from('.worktree.json'),
        m.to('.worktree.json'),
      );
    },
    rejectsConflict: async (kind: MoveKind) => {
      vi.mocked(jsonl.readLines).mockResolvedValue([recordA1]);

      const result = await mirror(kind).run();

      expect(result.moved).toEqual([]);
      expect(result.errors[0]?.sessionId).toBe(sessionIdA);
      expect(result.errors[0]?.error.message).toMatch(/conflict/i);
      expect(renameSyncSpy).not.toHaveBeenCalled();
    },
  };

  describe('archiveSessions', () => {
    beforeEach(() => {
      mkdirSyncSpy.mockImplementation(() => undefined);
    });
    const archive = mirror('archive');

    it('should move active sessions into the archive directory', async () => {
      archive.seed();
      const result = await sessionService.archiveSessions([sessionIdA]);

      expect(result.archived).toEqual([sessionIdA]);
      expect(result.alreadyArchived).toEqual([]);
      expect(result.notFound).toEqual([]);
      expect(result.errors).toEqual([]);
      expect(mkdirSyncSpy).toHaveBeenCalledWith(
        expect.stringContaining('/chats/archive'),
        { recursive: true },
      );
      expect(renameSyncSpy).toHaveBeenCalledWith(inChats(), inArchive());
    });

    it('should move the pr sidecar into the archive directory', () =>
      mirrored.movesPrSidecar('archive'));

    it('should warn but still archive when the pr sidecar move fails', () =>
      mirrored.warnsOnPrSidecarFailure('archive'));

    const bothPrSidecarsExist = () => {
      archive.seed();
      existsFor(
        `/chats/${sessionIdA}.pr.json`,
        `/chats/archive/${sessionIdA}.pr.json`,
      );
    };

    it('passes cleanup ownership to an asynchronous pr-sidecar commit', async () => {
      bothPrSidecarsExist();
      const assertCanMutate = vi.fn();
      const assertCleanupOwned = vi.fn();

      const result = await archive.run({ assertCanMutate, assertCleanupOwned });

      expect(result.errors).toEqual([]);
      expect(assertCanMutate).toHaveBeenCalledOnce();
      // The locked sidecar move carries the cleanup-ownership fence so an
      // asynchronous commit cannot land after ownership was lost.
      expect(moveSessionPrSidecar).toHaveBeenCalledWith(
        inChats('.pr.json'),
        inArchive('.pr.json'),
        assertCleanupOwned,
      );
    });

    it('does not swallow writer ownership loss during a pr-sidecar commit', async () => {
      bothPrSidecarsExist();
      // The locked move runs the ownership fence inside the lock; a loss
      // surfaces as its rejection and must not be downgraded to a warning.
      const ownershipLost = new SessionWriterLostError();
      vi.mocked(moveSessionPrSidecar).mockRejectedValueOnce(ownershipLost);
      const assertCleanupOwned = vi.fn();

      const result = await archive.run({
        assertCanMutate: vi.fn(),
        assertCleanupOwned,
      });

      expect(result.errors[0]?.error).toBe(ownershipLost);
      expect(moveSessionPrSidecar).toHaveBeenCalledWith(
        inChats('.pr.json'),
        inArchive('.pr.json'),
        assertCleanupOwned,
      );
    });

    it('should archive JSONL and warn when archiving worktree sidecar fails', () =>
      mirrored.warnsOnWorktreeSidecarFailure('archive'));

    it('finishes moving active sidecars after the generation closes', () =>
      mirrored.finishesSidecarsAfterGenerationCloses('archive'));

    it('stops archive sidecar cleanup after writer ownership is lost', () =>
      mirrored.stopsSidecarCleanupWhenOwnershipLost('archive'));

    it('should move the prompt ledger alongside the archived session', () =>
      mirrored.movesPromptLedger('archive'));

    it('should warn but still archive when the prompt ledger move fails', async () => {
      seeded('archive', '.ledger.jsonl');
      const { service, warnings } = withWarnings();
      failSidecarRename('.ledger.jsonl', 'ledger move failed');

      const result = await service.archiveSessions([sessionIdA]);

      expect(result.archived).toEqual([sessionIdA]);
      expect(result.errors).toEqual([]);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(
        `archiveSessions: failed to move prompt ledger for ${sessionIdA}`,
      );
      // The warning carries the full paths so the split pair is debuggable.
      expect(warnings[0]).toContain(`/chats/${sessionIdA}.ledger.jsonl`);
      expect(warnings[0]).toContain(
        `/chats/archive/${sessionIdA}.ledger.jsonl`,
      );
    });

    const sourceLedger = '{"v":1,"promptId":"p1","state":"in_flight","at":1}\n';

    it('should merge the prompt ledger into an existing destination instead of wedging', async () => {
      archive.seed();
      vi.spyOn(fs, 'readFileSync').mockReturnValue(sourceLedger);
      const appendFileSyncSpy = vi
        .spyOn(fs, 'appendFileSync')
        .mockImplementation(() => undefined);
      // Both ledgers exist (e.g. a partially completed earlier archive
      // cycle): the merge path must run.
      existsFor(`${sessionIdA}.ledger.jsonl`);

      const result = await sessionService.archiveSessions([sessionIdA]);

      expect(result.archived).toEqual([sessionIdA]);
      expect(result.errors).toEqual([]);
      // Source records append to the destination (append-only, order kept),
      // the source sidecar is unlinked, and the ledger is never renamed.
      expect(appendFileSyncSpy).toHaveBeenCalledWith(
        inArchive('.ledger.jsonl'),
        expect.stringContaining('"promptId":"p1"'),
        'utf8',
      );
      expect(unlinkSyncSpy).toHaveBeenCalledWith(inChats('.ledger.jsonl'));
      expect(renameSyncSpy).not.toHaveBeenCalledWith(
        expect.stringContaining(`${sessionIdA}.ledger.jsonl`),
        expect.anything(),
      );
    });

    it('does not append a prompt ledger after writer ownership is lost', async () => {
      archive.seed();
      const originalDestination =
        '{"v":1,"promptId":"p0","state":"committed","at":0}\n';
      let destinationLedger = originalDestination;
      let sourceExists = true;
      vi.spyOn(fs, 'readFileSync').mockReturnValue(sourceLedger);
      vi.spyOn(fs, 'appendFileSync').mockImplementation(
        (_filePath, contents) => {
          destinationLedger += contents.toString();
        },
      );
      unlinkSyncSpy.mockImplementation((filePath) => {
        if (filePath.toString().endsWith(`/chats/${sessionIdA}.ledger.jsonl`)) {
          sourceExists = false;
        }
      });
      existsFor(`${sessionIdA}.ledger.jsonl`);
      const ownershipLost = new SessionWriterLostError();
      const assertCleanupOwned = vi
        .fn()
        .mockImplementationOnce(() => undefined)
        .mockImplementationOnce(() => undefined)
        .mockImplementation(() => {
          throw ownershipLost;
        });

      const result = await archive.run({
        assertCanMutate: vi.fn(),
        assertCleanupOwned,
      });

      expect(result.errors[0]?.error).toBe(ownershipLost);
      expect(destinationLedger).toBe(originalDestination);
      expect(sourceExists).toBe(true);
      expect(assertCleanupOwned).toHaveBeenCalledTimes(3);
    });

    it('should not move worktree sidecar when archiving JSONL fails', () =>
      mirrored.keepsSidecarWhenTranscriptMoveFails(
        'archive',
        'EACCES',
        'permission denied',
      ));

    it('should archive known active sessions', () =>
      mirrored.movesKnownLocation('archive'));

    it('should report already archived sessions without moving them', async () => {
      onlyIn('archived');

      const result = await sessionService.archiveSessions([sessionIdA]);

      expect(result.archived).toEqual([]);
      expect(result.alreadyArchived).toEqual([sessionIdA]);
      expect(renameSyncSpy).not.toHaveBeenCalled();
    });

    it('should report active and archived duplicate ids as errors', () =>
      mirrored.rejectsConflict('archive'));

    it('does not commit usage when conflict repair is rejected', () =>
      mirrored.rejectedConflictRepairCommitsNothing('archive'));

    it('does not persist a final usage snapshot during conflict repair', () =>
      mirrored.conflictRepairSkipsFinalUsage('archive'));

    it('finishes archive conflict cleanup after the generation closes', () =>
      mirrored.finishesConflictCleanup('archive'));
  });

  describe('unarchiveSessions', () => {
    beforeEach(() => {
      mkdirSyncSpy.mockImplementation(() => undefined);
    });

    it('should move archived sessions back to the active directory', async () => {
      onlyIn('archived');

      const result = await sessionService.unarchiveSessions([sessionIdA]);

      expect(result.unarchived).toEqual([sessionIdA]);
      expect(result.alreadyActive).toEqual([]);
      expect(result.notFound).toEqual([]);
      expect(result.errors).toEqual([]);
      expect(renameSyncSpy).toHaveBeenCalledWith(inArchive(), inChats());
    });

    it('should move the pr sidecar back to the active directory', () =>
      mirrored.movesPrSidecar('unarchive'));

    it('should warn but still unarchive when the pr sidecar move fails', () =>
      mirrored.warnsOnPrSidecarFailure('unarchive'));

    it('should unarchive known archived sessions', () =>
      mirrored.movesKnownLocation('unarchive'));

    it('does not commit usage when conflict repair is rejected', () =>
      mirrored.rejectedConflictRepairCommitsNothing('unarchive'));

    it('does not persist a final usage snapshot for the retained active copy', () =>
      mirrored.conflictRepairSkipsFinalUsage('unarchive'));

    it('finishes unarchive conflict cleanup after the generation closes', () =>
      mirrored.finishesConflictCleanup('unarchive'));

    it('should recreate active chats directory before moving archived sessions', async () => {
      onlyIn('archived');

      const result = await sessionService.unarchiveSessions([sessionIdA]);

      expect(result.unarchived).toEqual([sessionIdA]);
      expect(mkdirSyncSpy).toHaveBeenCalledWith(
        expect.stringMatching(/\/chats$/),
        { recursive: true },
      );
      expect(renameSyncSpy).toHaveBeenCalledWith(inArchive(), inChats());
    });

    const expectUnmoved = (
      result: Awaited<ReturnType<SessionService['unarchiveSessions']>>,
      alreadyActive: string[],
      notFound: string[],
    ) => {
      expect(result.unarchived).toEqual([]);
      expect(result.alreadyActive).toEqual(alreadyActive);
      expect(result.notFound).toEqual(notFound);
      expect(result.errors).toEqual([]);
      expect(renameSyncSpy).not.toHaveBeenCalled();
    };

    it('should report not found when neither active nor archived file exists', async () => {
      vi.mocked(jsonl.readLines).mockImplementation(async () => {
        throw enoent();
      });

      expectUnmoved(
        await sessionService.unarchiveSessions([sessionIdA]),
        [],
        [sessionIdA],
      );
    });

    it('should report already active sessions without moving them', async () => {
      onlyIn('active');

      expectUnmoved(
        await sessionService.unarchiveSessions([sessionIdA]),
        [sessionIdA],
        [],
      );
    });

    it('should unarchive JSONL and warn when worktree sidecar move fails', () =>
      mirrored.warnsOnWorktreeSidecarFailure('unarchive'));

    it('finishes moving archived sidecars after the generation closes', () =>
      mirrored.finishesSidecarsAfterGenerationCloses('unarchive'));

    it('stops unarchive sidecar cleanup after writer ownership is lost', () =>
      mirrored.stopsSidecarCleanupWhenOwnershipLost('unarchive'));

    it('should move the prompt ledger back to the active directory when unarchiving', () =>
      mirrored.movesPromptLedger('unarchive'));

    it('should not move worktree sidecar when unarchiving JSONL fails', () =>
      mirrored.keepsSidecarWhenTranscriptMoveFails(
        'unarchive',
        'ENOSPC',
        'no space left on device',
      ));

    it('should reject unarchive when active and archived files both exist', () =>
      mirrored.rejectsConflict('unarchive'));
  });

  describe('removeSessions', () => {
    it('should remove multiple sessions and report each outcome', async () => {
      const removeOrganizationsSpy = vi
        .spyOn(SessionOrganizationService.prototype, 'removeSessions')
        .mockResolvedValue();
      // A and B belong to this project; C never has a backing record.
      onlyIn('active', headsById);

      const result = await sessionService.removeSessions([
        sessionIdA,
        sessionIdB,
        sessionIdC,
      ]);

      expect(result.removed).toEqual([sessionIdA, sessionIdB]);
      expect(result.notFound).toEqual([sessionIdC]);
      expect(result.errors).toEqual([]);
      expect(unlinkSyncSpy).toHaveBeenCalledTimes(2);
      expect(removeOrganizationsSpy).toHaveBeenCalledTimes(1);
      expect(removeOrganizationsSpy).toHaveBeenCalledWith([
        sessionIdA,
        sessionIdB,
      ]);
    });

    it('should de-duplicate input ids', async () => {
      onlyIn('active');

      const result = await sessionService.removeSessions([
        sessionIdA,
        sessionIdA,
        sessionIdA,
      ]);

      expect(result.removed).toEqual([sessionIdA]);
      expect(result.notFound).toEqual([]);
      expect(unlinkSyncSpy).toHaveBeenCalledTimes(1);
    });

    it('should keep going when one removal fails', async () => {
      onlyIn('active', headsById);
      const failure = new Error('boom');
      unlinkSyncSpy.mockImplementation((p: fs.PathLike) => {
        if (p.toString().includes(sessionIdA)) {
          throw failure;
        }
      });

      const result = await sessionService.removeSessions([
        sessionIdA,
        sessionIdB,
      ]);

      expect(result.removed).toEqual([sessionIdB]);
      expect(result.notFound).toEqual([]);
      expect(result.errors).toEqual([
        { sessionId: sessionIdA, error: failure },
      ]);
    });

    it('should return empty results when given an empty list', async () => {
      const result = await sessionService.removeSessions([]);

      expect(result.removed).toEqual([]);
      expect(result.notFound).toEqual([]);
      expect(result.errors).toEqual([]);
      expect(unlinkSyncSpy).not.toHaveBeenCalled();
    });
  });

  describe('countSessionMessages', () => {
    // The lazy counter replacing listSessions' per-file readline scan. Pinned:
    // it counts what it promises, skips disk on bad input, returns 0 on any
    // read failure (the picker treats 0 as "unknown", so nothing may throw),
    // and scopes to the project (the first-record cwd check delete/rename use).
    const stubCreateReadStream = (
      lines: string[],
    ): MockInstance<typeof fs.createReadStream> =>
      vi
        .spyOn(fs, 'createReadStream')
        .mockImplementation(
          () => Readable.from([lines.join('\n')]) as unknown as fs.ReadStream,
        );
    const countA = () => sessionService.countSessionMessages(sessionIdA);

    it('should count unique user/assistant uuids and ignore other record types', async () => {
      // Project scoping reads the first record before the count stream.
      vi.mocked(jsonl.readLines).mockResolvedValue([recordA1]);
      // countSessionMessagesFromPath routes each line through
      // parseLineTolerant, whose default mock is a no-op: decode for real.
      vi.mocked(jsonl.parseLineTolerant).mockImplementation((line) => {
        try {
          const parsed = JSON.parse(line);
          return Array.isArray(parsed) ? parsed : [parsed];
        } catch {
          return [];
        }
      });
      const createReadStreamSpy = stubCreateReadStream([
        // Two user records sharing a uuid — counted once
        JSON.stringify({ uuid: 'u1', type: 'user' }),
        JSON.stringify({ uuid: 'u1', type: 'user' }),
        JSON.stringify({ uuid: 'a1', type: 'assistant' }),
        // System / summary records aren't messages
        JSON.stringify({ uuid: 's1', type: 'system' }),
        JSON.stringify({ uuid: 'sum1', type: 'summary' }),
        // Empty and malformed lines must not throw
        '',
        '   ',
        'not-json',
        JSON.stringify({ uuid: 'u2', type: 'user' }),
      ]);

      expect(await countA()).toBe(3); // u1, a1, u2
      expect(createReadStreamSpy).toHaveBeenCalledTimes(1);
    });

    it('should return 0 for invalid sessionId without touching the filesystem', async () => {
      const createReadStreamSpy = vi.spyOn(fs, 'createReadStream');

      expect(await sessionService.countSessionMessages('not-a-uuid')).toBe(0);
      expect(createReadStreamSpy).not.toHaveBeenCalled();
    });

    it('should return 0 when the session file is missing (ENOENT)', async () => {
      // The first-record read fires before the count stream, so ENOENT
      // surfaces there as a thrown readLines error.
      vi.mocked(jsonl.readLines).mockRejectedValue(enoent());

      expect(await countA()).toBe(0);
    });

    it('should return 0 when the session belongs to a different project', async () => {
      // A valid id can sit in the shared chats dir with a first-record cwd from
      // another project; lazy-count callers must not bypass project scoping.
      vi.mocked(jsonl.readLines).mockResolvedValue([foreignHead]);
      otherProject();
      const createReadStreamSpy = vi.spyOn(fs, 'createReadStream');

      expect(await countA()).toBe(0);
      // The project check short-circuits before the streaming pass.
      expect(createReadStreamSpy).not.toHaveBeenCalled();
    });

    it('should count a migrated session when runtime status matches this project', async () => {
      vi.mocked(jsonl.readLines).mockResolvedValue([migratedHead]);
      migrated();
      otherProject();
      vi.mocked(jsonl.parseLineTolerant).mockImplementation((line) => [
        JSON.parse(line),
      ]);
      const createReadStreamSpy = stubCreateReadStream([
        JSON.stringify({ uuid: 'u1', type: 'user' }),
        JSON.stringify({ uuid: 'a1', type: 'assistant' }),
      ]);

      expect(await countA()).toBe(2);
      expect(createReadStreamSpy).toHaveBeenCalledTimes(1);
    });

    it('should return 0 when the session file has no records (empty file)', async () => {
      vi.mocked(jsonl.readLines).mockResolvedValue([]);
      const createReadStreamSpy = vi.spyOn(fs, 'createReadStream');

      expect(await countA()).toBe(0);
      expect(createReadStreamSpy).not.toHaveBeenCalled();
    });
  });

  describe('getSessionLocation', () => {
    it('should report conflict when active and archived files both exist', async () => {
      vi.mocked(jsonl.readLines).mockResolvedValue([recordA1]);

      await expect(sessionService.getSessionLocation(sessionIdA)).resolves.toBe(
        'conflict',
      );
    });

    it('should warn when reading a session head fails', async () => {
      const { service, warnings } = withWarnings();
      const error = new Error('malformed JSON');
      vi.mocked(jsonl.readLines).mockRejectedValue(error);

      await expect(service.getSessionLocation(sessionIdA)).rejects.toThrow(
        error,
      );
      expect(warnings).toHaveLength(2);
      for (const warning of warnings) {
        expect(warning).toContain('readProjectSessionHead: failed to read');
        expect(warning).toContain(`${sessionIdA}.jsonl`);
        expect(warning).toContain('malformed JSON');
      }
    });
  });

  describe('findSessionIdIgnoringCase', () => {
    let readdirSpy: MockInstance<typeof fs.promises.readdir>;
    const upper = sessionIdA.toUpperCase();
    const mixed = sessionIdA.replace('e29b', 'E29b');

    beforeEach(() => {
      readdirSpy = vi
        .spyOn(fs.promises, 'readdir')
        .mockResolvedValue([] as never);
    });

    /** One active, then one archived directory listing of these ids. */
    const listing = (active: string[], archived: string[] = []) =>
      readdirSpy
        .mockResolvedValueOnce(active.map((id) => `${id}.jsonl`) as never)
        .mockResolvedValueOnce(archived.map((id) => `${id}.jsonl`) as never);
    const locate = (location: (id: string) => SessionLocation) =>
      vi
        .spyOn(sessionService, 'getSessionLocation')
        .mockImplementation(async (id) => location(id));
    /** Every spelling except the requested one reads as active. */
    const twinsReadable = () =>
      locate((id) => (id === sessionIdA ? undefined : 'active'));
    const find = () => sessionService.findSessionIdIgnoringCase(sessionIdA);
    const expectCaseConflict = (fields: Record<string, unknown>) =>
      expect(find()).rejects.toMatchObject({
        name: 'SessionIdCaseConflictError',
        sessionId: sessionIdA,
        ...fields,
      });
    const inode = (ino: number) =>
      ({ dev: 1, ino, isFile: () => true }) as fs.Stats;

    it('finds a legacy mixed-case transcript', async () => {
      listing([upper]);
      locate((id) => (id === upper ? 'active' : undefined));

      await expect(find()).resolves.toBe(upper);
    });

    it('returns the single authoritative spelling after scanning both states', async () => {
      listing([], [upper]);
      locate((id) => (id === upper ? 'archived' : undefined));

      await expect(find()).resolves.toBe(upper);
    });

    it('rejects case-only duplicate spellings instead of choosing by enumeration order', async () => {
      listing([upper, mixed]);
      // Both twins are readable while the requested spelling resolves
      // nothing — a true conflict.
      const getLocation = twinsReadable();

      await expectCaseConflict({
        candidateSessionId: undefined,
        message: `Multiple persisted sessions match "${sessionIdA}" by case.`,
      });
      expect(getLocation).toHaveBeenCalledTimes(2);
    });

    it('rejects case-only duplicates whose heads are all unreadable as occupying the id', async () => {
      // Neither on-disk spelling is the requested one, so minting the request
      // beside them would add a third case-variant of the same id.
      listing([upper, mixed]);
      // Neither head recovers records, but both files persist on disk.
      locate(() => undefined);
      existsSyncSpy.mockReturnValue(true);

      await expectCaseConflict({
        candidateSessionId: undefined,
        reason: 'unreadable_transcript',
      });
    });

    it('rejects one spelling that exists in both active and archive state', async () => {
      readdirSpy.mockResolvedValue([`${sessionIdA}.jsonl`] as never);
      const getLocation = locate(() => 'conflict');

      await expectCaseConflict({
        candidateSessionId: sessionIdA,
        message: `Session "${sessionIdA}" is persisted in both active and archived states.`,
      });
      expect(getLocation).toHaveBeenCalledTimes(1);
    });

    it('rejects a present-but-unreadable single candidate as occupying the id', async () => {
      listing([upper]);
      // The head recovers no records (torn/empty/foreign), but the file
      // still occupies the id — admission must not mint a case-only twin.
      locate(() => undefined);
      existsSyncSpy.mockReturnValue(true);

      await expectCaseConflict({
        candidateSessionId: upper,
        reason: 'unreadable_transcript',
        message: `Session "${upper}" is persisted but its transcript head is unreadable.`,
      });
    });

    it('returns the sole readable spelling when a case twin is unreadable', async () => {
      listing([sessionIdA, upper]);
      locate((id) => (id === upper ? 'active' : undefined));

      await expect(find()).resolves.toBe(upper);
    });

    it('returns a twin spelling when one of its two state copies is unreadable', async () => {
      readdirSpy.mockResolvedValue([`${upper}.jsonl`] as never);
      // getSessionLocation counts only readable copies, so one garbage
      // twin still resolves to the surviving state.
      locate((id) => (id === upper ? 'active' : undefined));

      await expect(find()).resolves.toBe(upper);
    });

    it('returns undefined when the matching transcript disappears during resolution', async () => {
      // The candidate must differ in case from the request, otherwise the
      // self-escape short-circuits and the race loop below it never runs.
      listing([upper]);
      locate(() => undefined);
      existsSyncSpy.mockReturnValue(false);

      await expect(find()).resolves.toBeUndefined();
    });

    it('lets an unreadable case twin keep occupying the id', async () => {
      // Both files are unreadable. The requested spelling's own file is a
      // twin of nothing, but the *other* spelling still occupies the id:
      // minting the request beside it would make both unrestorable.
      listing([sessionIdA, upper]);
      locate(() => undefined);
      existsSyncSpy.mockReturnValue(true);

      await expectCaseConflict({ reason: 'unreadable_transcript' });
    });

    it('reports the requested spelling absent when only its own file survives', async () => {
      // The twin raced away between enumeration and the presence check, so
      // only the request's own unreadable file is left to occupy the id.
      listing([sessionIdA, upper]);
      locate(() => undefined);
      existsSyncSpy.mockImplementation((filePath: fs.PathLike) =>
        String(filePath).includes(`${sessionIdA}.jsonl`),
      );

      await expect(find()).resolves.toBeUndefined();
      expect(existsSyncSpy).toHaveBeenCalledWith(
        expect.stringContaining(`${upper}.jsonl`),
      );
    });

    it('reports the requested spelling absent when its own transcript head is unreadable', async () => {
      // A run that crashed before its first record leaves a 0-byte transcript
      // under the requested spelling: a case-only twin of nothing, so the id
      // stays reusable — `getSessionLocation` already reports it nonexistent.
      listing([sessionIdA]);
      locate(() => undefined);
      existsSyncSpy.mockReturnValue(true);

      await expect(find()).resolves.toBeUndefined();
    });

    it('ignores persisted names getSessionLocation cannot classify', async () => {
      // Agent-suffixed ids are admitted by the CLI and written under the raw
      // session id, but SESSION_FILE_PATTERN excludes them — enumerating them
      // here would report a healthy transcript as occupied-but-unreadable.
      const agentSessionId = `${sessionIdA}-agent-foo`;
      listing([agentSessionId]);
      const getLocation = vi.spyOn(sessionService, 'getSessionLocation');
      existsSyncSpy.mockReturnValue(true);

      await expect(
        sessionService.findSessionIdIgnoringCase(agentSessionId),
      ).resolves.toBeUndefined();
      expect(getLocation).not.toHaveBeenCalled();
    });

    it('collapses case-variant spellings that alias one physical transcript', async () => {
      // On a case-insensitive filesystem both spellings open the same file,
      // so each reports a readable location though only one copy exists.
      listing([upper], [mixed]);
      twinsReadable();
      statSyncSpy.mockReturnValue(inode(42));

      await expect(find()).resolves.toBe(upper);
    });

    it('still rejects two readable spellings backed by distinct files', async () => {
      listing([upper, mixed]);
      twinsReadable();
      statSyncSpy.mockImplementation((filePath: fs.PathLike) =>
        inode(String(filePath).includes(upper) ? 43 : 42),
      );

      await expectCaseConflict({ candidateSessionId: undefined });
    });

    it('reports a conflict rather than collapsing when the filesystem exposes no inode', async () => {
      // FAT/exFAT and some SMB mounts report ino 0 for every file, so `dev:ino`
      // cannot prove the spellings alias one transcript: they stay a conflict.
      listing([mixed], [upper]);
      twinsReadable();
      statSyncSpy.mockReturnValue(inode(0));

      await expectCaseConflict({});
    });

    it('propagates an I/O failure instead of reporting it as a case conflict', async () => {
      // A transient EACCES/EMFILE says nothing about aliasing; laundering it
      // into `session_conflict` would report a retryable blip as permanent.
      listing([mixed], [upper]);
      twinsReadable();
      statSyncSpy.mockImplementation(() => {
        throw errno('permission denied', 'EACCES');
      });

      await expect(find()).rejects.toMatchObject({ code: 'EACCES' });
    });

    it('ignores a candidate whose transcript vanishes mid-resolution', async () => {
      // The mixed-case entry races away, so only the uppercase spelling is
      // left to back the readable state and it resolves without a conflict.
      listing([mixed], [upper]);
      locate((id) =>
        id === upper ? 'archived' : id === sessionIdA ? undefined : 'active',
      );
      statSyncSpy.mockImplementation((filePath: fs.PathLike) => {
        if (String(filePath).includes(`${mixed}.jsonl`)) {
          throw errno('gone', 'ENOENT');
        }
        return inode(7);
      });

      await expect(find()).resolves.toBe(upper);
    });
  });

  describe('loadLastSession', () => {
    it('should return the most recent session (same as getLatestSession)', async () => {
      newestB();
      vi.mocked(jsonl.read).mockResolvedValue([recordB1, recordB2]);

      const latest = await sessionService.loadLastSession();

      expect(latest?.conversation.sessionId).toBe(sessionIdB);
    });

    it('should return undefined when no sessions exist', async () => {
      readdirSyncSpy.mockReturnValue([]);

      expect(await sessionService.loadLastSession()).toBeUndefined();
    });
  });

  describe('sessionExists', () => {
    it('should return true for existing session', async () => {
      vi.mocked(jsonl.readLines).mockResolvedValue([recordA1]);

      expect(await sessionService.sessionExists(sessionIdA)).toBe(true);
    });

    it('should return false for non-existing session', async () => {
      vi.mocked(jsonl.readLines).mockResolvedValue([]);

      const exists = await sessionService.sessionExists(
        '00000000-0000-0000-0000-000000000000',
      );

      expect(exists).toBe(false);
    });

    it('does not convert cancellation into a missing session', async () => {
      const controller = new AbortController();
      const reason = new Error('existence check cancelled');
      vi.mocked(jsonl.readLines).mockImplementation(
        async (_filePath, _count, options) => {
          controller.abort(reason);
          options?.signal?.throwIfAborted();
          return [];
        },
      );

      await expect(
        sessionService.sessionExists(sessionIdA, {
          signal: controller.signal,
        }),
      ).rejects.toBe(reason);
      expect(jsonl.readLines).toHaveBeenCalledWith(expect.any(String), 1, {
        signal: controller.signal,
      });
    });

    it('observes cancellation after the project-membership await', async () => {
      vi.mocked(jsonl.readLines).mockResolvedValue([recordA1]);
      const controller = new AbortController();
      const reason = new Error('cancelled after membership resolved');

      const exists = sessionService.sessionExists(sessionIdA, {
        signal: controller.signal,
      });
      queueMicrotask(() => controller.abort(reason));

      await expect(exists).rejects.toBe(reason);
    });

    it('passes cancellation to migrated-session runtime status reads', async () => {
      vi.mocked(jsonl.readLines).mockResolvedValue([migratedHead]);
      otherProject();
      const controller = new AbortController();
      const reason = new Error('cancelled during runtime status read');
      let runtimeStatusSignal: AbortSignal | undefined;
      vi.mocked(readRuntimeStatus).mockImplementation(
        async (_filePath, options) => {
          runtimeStatusSignal = options?.signal;
          await untilAborted(runtimeStatusSignal);
          return null;
        },
      );

      const exists = sessionService.sessionExists(sessionIdA, {
        signal: controller.signal,
      });
      await vi.waitFor(() =>
        expect(runtimeStatusSignal).toBe(controller.signal),
      );
      controller.abort(reason);

      await expect(exists).rejects.toBe(reason);
      expect(readRuntimeStatus).toHaveBeenCalledWith(expect.any(String), {
        signal: controller.signal,
      });
    });

    it('should return false for session from different project', async () => {
      vi.mocked(jsonl.readLines).mockResolvedValue([foreignHead]);
      otherProject();

      expect(await sessionService.sessionExists(sessionIdA)).toBe(false);
    });

    it('should return true for a migrated session when runtime status matches this project', async () => {
      vi.mocked(jsonl.readLines).mockResolvedValue([migratedHead]);
      migrated();
      otherProject();

      expect(await sessionService.sessionExists(sessionIdA)).toBe(true);
    });

    it('should keep default existence checks active-only', async () => {
      onlyIn('archived');

      await expect(sessionService.sessionExists(sessionIdA)).resolves.toBe(
        false,
      );
      await expect(
        sessionService.sessionExistsInAnyState(sessionIdA),
      ).resolves.toBe(true);
    });

    it('should treat unreadable active or archived files as existing for any-state checks', async () => {
      vi.mocked(jsonl.readLines).mockImplementation(
        async (filePath: string) => {
          if (filePath.includes('/chats/archive/')) {
            throw new Error('malformed jsonl');
          }
          throw enoent();
        },
      );

      await expect(
        sessionService.sessionExistsInAnyState(sessionIdA),
      ).resolves.toBe(true);
    });
  });

  /** A conversation on sessionIdA built from `messages`. */
  const conversationOf = (
    messages: ChatRecord[],
    lastUpdated = '2024-01-01T00:00:00Z',
  ): ConversationRecord => ({
    sessionId: sessionIdA,
    projectHash: 'test-project-hash',
    startTime: '2024-01-01T00:00:00Z',
    lastUpdated,
    messages,
  });
  const compressionPayload = (
    originalTokenCount: number,
    newTokenCount: number,
    compressedHistory: Content[],
    info: Record<string, unknown> = {},
  ) => ({
    info: {
      originalTokenCount,
      newTokenCount,
      ...info,
      compressionStatus: CompressionStatus.COMPRESSED,
    },
    compressedHistory,
  });

  describe('getResumePromptTokenCount', () => {
    const baseRecord: ChatRecord = {
      uuid: 'r1',
      parentUuid: null,
      sessionId: sessionIdA,
      timestamp: '2024-01-01T00:00:00Z',
      type: 'user',
      cwd: '/test/project/root',
      version: '1.0.0',
    };
    const compressionRecord: ChatRecord = {
      ...baseRecord,
      uuid: 'comp',
      type: 'system',
      subtype: 'chat_compression',
      systemPayload: compressionPayload(1000, 300, [], {
        newTokenCountIsEstimated: true,
      }),
    };

    it.each([
      [
        'should return latest assistant usage without scanning further back',
        { totalTokenCount: 450 },
        450,
        { promptTokenCount: 450, outputTokenCount: 0, isEstimated: false },
      ],
      [
        'should prefer promptTokenCount over totalTokenCount when both are present',
        { promptTokenCount: 200, totalTokenCount: 450 },
        200,
        { promptTokenCount: 200, outputTokenCount: 250, isEstimated: false },
      ],
      [
        'should restore disjoint candidate and thought output tokens when total is unavailable',
        {
          promptTokenCount: 200,
          candidatesTokenCount: 40,
          thoughtsTokenCount: 60,
        },
        undefined,
        { promptTokenCount: 200, outputTokenCount: 100, isEstimated: false },
      ],
      [
        'should fall back to compression when latest assistant has zero usage',
        { totalTokenCount: 0, promptTokenCount: 0 },
        300,
        { promptTokenCount: 300, outputTokenCount: 0, isEstimated: true },
      ],
    ] as const)('%s', (_title, usageMetadata, promptCount, counts) => {
      const conversation = conversationOf([
        compressionRecord,
        {
          ...baseRecord,
          uuid: 'a1',
          parentUuid: 'comp',
          type: 'assistant',
          usageMetadata,
        },
      ]);
      if (promptCount !== undefined) {
        expect(getResumePromptTokenCount(conversation)).toBe(promptCount);
      }
      expect(getResumeTokenCounts(conversation)).toEqual(counts);
    });

    it.each([
      [
        'conservatively treats legacy compression checkpoints as estimated',
        {},
        true,
      ],
      [
        'restores an explicit authoritative compression-checkpoint provenance',
        { newTokenCountIsEstimated: false },
        false,
      ],
    ] as const)('%s', (_title, info, isEstimated) => {
      const checkpoint: ChatRecord = {
        ...compressionRecord,
        systemPayload: compressionPayload(1000, 300, [], info),
      };

      expect(getResumeTokenCounts(conversationOf([checkpoint]))).toEqual({
        promptTokenCount: 300,
        outputTokenCount: 0,
        isEstimated,
      });
    });
  });

  describe('buildApiHistoryFromConversation', () => {
    /** A sessionIdA record (cwd /test/project/root, version 1.0.0). */
    const recordAt = (
      uuid: string,
      parentUuid: string | null,
      timestamp: string,
      type: ChatRecord['type'],
      fields: Partial<ChatRecord>,
    ): ChatRecord => ({
      uuid,
      parentUuid,
      sessionId: sessionIdA,
      timestamp,
      type,
      cwd: '/test/project/root',
      version: '1.0.0',
      ...fields,
    });
    const midTurn = (
      uuid: string,
      parentUuid: string,
      timestamp: string,
      text: string,
      fields: Partial<ChatRecord> = {},
    ) =>
      recordAt(uuid, parentUuid, timestamp, 'user', {
        subtype: 'mid_turn_user_message',
        message: userText(
          `\n[User message received during tool execution]: ${text}`,
        ),
        ...fields,
      });
    const compressionAt = (compressedHistory: Content[]) =>
      recordAt('c1', 'b2', '2024-01-02T03:00:00Z', 'system', {
        subtype: 'chat_compression',
        gitBranch: 'main',
        systemPayload: compressionPayload(100, 50, compressedHistory),
      });
    /** The tool result's parts followed by the mid-turn message's parts. */
    const merged = (toolResult: ChatRecord, midTurnMessage: ChatRecord) => ({
      role: 'user',
      parts: [...toolResult.message!.parts!, ...midTurnMessage.message!.parts!],
    });
    const historyOf = (...args: Parameters<typeof conversationOf>) =>
      buildApiHistoryFromConversation(conversationOf(...args));
    const withThought = () =>
      conversationOf(
        [
          recordA1,
          recordAt('t1', 'a1', '2024-01-01T01:00:00Z', 'assistant', {
            message: {
              role: 'model',
              parts: [
                { text: 'reasoning step', thought: true },
                { text: 'final answer' },
              ],
            },
          }),
        ],
        '2024-01-01T01:00:00Z',
      );

    it('should return linear messages when no compression checkpoint exists', () => {
      const identifiedUser: ChatRecord = {
        ...recordA1,
        promptId: 'prompt-1',
      };
      const assistantA1: ChatRecord = {
        ...recordB2,
        sessionId: sessionIdA,
        parentUuid: identifiedUser.uuid,
      };

      const history = historyOf([identifiedUser, assistantA1]);

      expect(
        history.map((content) => ({
          role: content.role,
          parts: content.parts,
        })),
      ).toEqual([
        {
          role: identifiedUser.message!.role,
          parts: identifiedUser.message!.parts,
        },
        {
          role: assistantA1.message!.role,
          parts: assistantA1.message!.parts,
        },
      ]);
      expect(getApiHistoryPromptId(history[0]!)).toBe('prompt-1');
      expect(JSON.stringify(history[0])).not.toContain('prompt-1');
    });

    it('keeps Realtime dialogue out of backend model history', () => {
      const realtimeUser: ChatRecord = {
        ...recordA1,
        uuid: 'realtime-user',
        subtype: 'realtime_message',
        message: userText('voice question'),
      };
      const realtimeAssistant: ChatRecord = {
        ...recordB2,
        uuid: 'realtime-assistant',
        parentUuid: realtimeUser.uuid,
        sessionId: sessionIdA,
        subtype: 'realtime_message',
        message: modelText('voice answer'),
      };
      const backendUser: ChatRecord = {
        ...recordA1,
        uuid: 'backend-user',
        parentUuid: realtimeAssistant.uuid,
        message: userText('backend task'),
      };

      expect(historyOf([realtimeUser, realtimeAssistant, backendUser])).toEqual(
        [backendUser.message],
      );
    });

    it('does not deep-clone stored messages when rebuilding resume API history', () => {
      const largePayload = {
        output: 'x'.repeat(128 * 1024),
        nested: { keep: true },
      };
      const toolResult = recordAt(
        'large-tool-result',
        recordA1.uuid,
        '2024-01-01T00:02:00Z',
        'tool_result',
        {
          message: content(
            'user',
            fnResponse('read_file', largePayload, 'call-1'),
          ),
        },
      );
      const structuredCloneSpy = vi
        .spyOn(globalThis, 'structuredClone')
        .mockImplementation(() => {
          throw new Error('unexpected deep clone');
        });

      const history = historyOf([recordA1, toolResult], '2024-01-01T00:02:00Z');

      expect(structuredCloneSpy).not.toHaveBeenCalled();
      expect(history).toEqual([recordA1.message, toolResult.message]);
      expect(history[1]).not.toBe(toolResult.message);
      expect(history[1].parts).not.toBe(toolResult.message!.parts);
      const response = history[1].parts![0] as {
        functionResponse: { response: typeof largePayload };
      };
      expect(response.functionResponse.response).toBe(largePayload);
    });

    it('merges mid-turn user messages into the preceding tool result on resume', () => {
      const assistantWithToolCall = recordAt(
        'a2',
        recordA1.uuid,
        '2024-01-01T00:01:00Z',
        'assistant',
        {
          message: content(
            'model',
            fnCall('read_file', { path: 'foo.txt' }, 'call-1'),
          ),
        },
      );
      const toolResult = recordAt(
        'a3',
        'a2',
        '2024-01-01T00:02:00Z',
        'tool_result',
        {
          message: content(
            'user',
            fnResponse('read_file', { output: 'contents' }, 'call-1'),
          ),
        },
      );
      const midTurnUserMessage = midTurn(
        'a4',
        'a3',
        '2024-01-01T00:03:00Z',
        'save the logs',
      );

      const history = historyOf(
        [recordA1, assistantWithToolCall, toolResult, midTurnUserMessage],
        '2024-01-01T00:03:00Z',
      );

      expect(history).toEqual([
        recordA1.message,
        assistantWithToolCall.message,
        merged(toolResult, midTurnUserMessage),
      ]);
    });

    it('should use compressedHistory snapshot and append subsequent records after compression', () => {
      const compressionRecord = compressionAt([
        userText('summary'),
        modelText('Got it. Thanks for the additional context!'),
        recordB2.message!,
      ]);
      const postCompressionRecord = recordAt(
        'c2',
        'c1',
        '2024-01-02T04:00:00Z',
        'user',
        {
          message: userText('new question'),
          gitBranch: 'main',
        },
      );

      const history = historyOf(
        [recordA1, recordB2, compressionRecord, postCompressionRecord],
        '2024-01-02T04:00:00Z',
      );

      expect(history).toEqual([
        userText('summary'),
        modelText('Got it. Thanks for the additional context!'),
        recordB2.message,
        postCompressionRecord.message,
      ]);
    });

    it('merges post-compression mid-turn user messages into preceding tool results', () => {
      const compressionRecord = compressionAt([
        userText('summary'),
        modelText('continue'),
      ]);
      const toolResult = recordAt(
        'c2',
        'c1',
        '2024-01-02T04:00:00Z',
        'tool_result',
        {
          message: content(
            'user',
            fnResponse('shell', { output: 'ok' }, 'call-1'),
          ),
          gitBranch: 'main',
        },
      );
      const midTurnUserMessage = midTurn(
        'c3',
        'c2',
        '2024-01-02T04:01:00Z',
        'stop after this',
        {
          gitBranch: 'main',
        },
      );

      const history = historyOf(
        [recordA1, recordB2, compressionRecord, toolResult, midTurnUserMessage],
        '2024-01-02T04:01:00Z',
      );

      expect(history).toEqual([
        userText('summary'),
        modelText('continue'),
        merged(toolResult, midTurnUserMessage),
      ]);
    });

    it('should preserve thought parts by default (stripThoughtsFromHistory=false)', () => {
      const history = buildApiHistoryFromConversation(withThought());

      expect(history).toHaveLength(2);
      expect(history[1].parts).toEqual([
        { text: 'reasoning step', thought: true },
        { text: 'final answer' },
      ]);
    });

    it('should strip thought parts when stripThoughtsFromHistory=true', () => {
      const history = buildApiHistoryFromConversation(withThought(), {
        stripThoughtsFromHistory: true,
      });

      expect(history).toHaveLength(2);
      expect(history[1].parts).toEqual([{ text: 'final answer' }]);
    });

    it('should preserve thought parts in compressed history by default', () => {
      const compressionRecord = compressionAt([
        userText('summary'),
        {
          role: 'model',
          parts: [
            { text: 'deep thinking', thought: true },
            { text: 'final answer' },
          ],
        },
      ]);

      const history = historyOf(
        [recordA1, recordB2, compressionRecord],
        '2024-01-02T03:00:00Z',
      );

      // compressedHistory holds 2 entries (user, model) with thought parts
      // intact, and no messages follow the compression record.
      expect(history).toHaveLength(2);
      expect(history[1].parts).toEqual([
        { text: 'deep thinking', thought: true },
        { text: 'final answer' },
      ]);
    });
  });

  describe('forkSession', () => {
    // forkSession does real disk I/O through `jsonl.read` and `fs.*`, so the
    // fork reads and writes tmp files with the real implementations restored.
    let realTmpDir: string;
    let realPath: RealDisk['realPath'];
    let service: SessionService;
    let cwd: string;
    useRealDisk(
      'fork-session-',
      (disk) => ({ realTmpDir, realPath, service, cwd } = disk),
      'fork',
    );

    const chatsDir = () =>
      realPath.join(service['storage'].getProjectDir(), 'chats');
    const transcriptPath = (sessionId: string) =>
      realPath.join(chatsDir(), `${sessionId}.jsonl`);
    const backupDir = (sessionId: string) =>
      realPath.join(realTmpDir, 'file-history', sessionId);
    // Cases fork oldId into newId (newId into nestedId) from oldId seeds.
    const [oldId, newId, nestedId] = realDiskIds;
    const fork = (options?: Parameters<SessionService['forkSession']>[2]) =>
      service.forkSession(oldId, newId, options);
    type OnOld<F> = F extends (sessionId: string, ...rest: infer R) => Line
      ? R
      : never;
    const msg = (...args: OnOld<typeof msgLine>) => msgLine(oldId, ...args);
    const sys = (...args: OnOld<typeof sysLine>) => sysLine(oldId, ...args);
    /** Writes `files` (name → content) into oldId's backup dir. */
    const seedBackups = (files: Record<string, string>) => {
      const dir = backupDir(oldId);
      fs.mkdirSync(dir, { recursive: true });
      for (const [name, text] of Object.entries(files)) {
        fs.writeFileSync(realPath.join(dir, name), text);
      }
      return dir;
    };
    /** oldId's transcript: u1 user 'hello', u2 assistant 'hi', then `extra`. */
    const seedSession = (extra: Line[] = [], sessionCwd = cwd) => {
      fs.mkdirSync(chatsDir(), { recursive: true });
      const file = transcriptPath(oldId);
      const lines = [
        msg('u1', null, 'user', 0, 'hello', {
          provenance: 'real_user',
          cwd: sessionCwd,
        }),
        msg('u2', 'u1', 'assistant', 1, 'hi', {
          provenance: 'assistant_output',
          cwd: sessionCwd,
        }),
      ];
      writeJsonl(file, [...lines, ...extra]);
      return { file, lines };
    };
    const checkpointLine = (
      uuid: string,
      parentUuid: string,
      seconds: number,
      startExclusiveRecordUuid: string | null,
      payload: Line = {},
    ) =>
      sys(uuid, parentUuid, 'branch_checkpoint', seconds, {
        v: 1,
        startExclusiveRecordUuid,
        assistantRecordUuid: 'u2',
        ...payload,
      });
    const snapshotLine = (
      uuid: string,
      parentUuid: string,
      files: Record<string, string>,
      promptId = `${oldId}########0`,
    ) =>
      sys(
        uuid,
        parentUuid,
        'file_history_snapshot',
        2,
        snapshotPayload(promptId, ts(0), files),
      );
    /** The u2-parented snapshot backing up `backupNames` as file-<i>.txt. */
    const backupSnapshotLine = (backupNames: string[]) =>
      snapshotLine(
        'snapshot-branch',
        'u2',
        Object.fromEntries(
          backupNames.map((name, i) => [`file-${i}.txt`, name]),
        ),
      );
    /** An artifact event creating the `url` link artifact at `seconds`. */
    const linkLine = (
      uuid: string,
      parentUuid: string,
      seconds: number,
      title: string,
      url: string,
    ) =>
      sys(
        uuid,
        parentUuid,
        'session_artifact_event',
        seconds,
        artifactPayload(oldId, 1, ts(seconds), [
          linkCreated(
            stableSessionArtifactId(oldId, `url:${url}`),
            title,
            url,
            ts(seconds),
          ),
        ]),
      );
    const isTmpOf = (newId: string) => (name: string) =>
      name.startsWith(`.${newId}.`) && name.endsWith('.tmp');

    it('rewrites sessionId, rebuilds parentUuid, and stamps forkedFrom on every record', async () => {
      const { file: srcPath } = seedSession();

      const result = await fork();
      expect(result.copiedCount).toBe(2);
      expect(result.filePath).toContain(`${newId}.jsonl`);

      const written = readJsonl(result.filePath);
      expect(written).toHaveLength(2);
      expect(written[0]).toMatchObject({
        uuid: 'u1',
        parentUuid: null,
        sessionId: newId,
        forkedFrom: { sessionId: oldId, messageUuid: 'u1' },
      });
      expect(written[1]).toMatchObject({
        uuid: 'u2',
        parentUuid: 'u1', // rebuilt in write order
        sessionId: newId,
        forkedFrom: { sessionId: oldId, messageUuid: 'u2' },
      });
      expect(fs.existsSync(srcPath)).toBe(true);
      const srcLines = readJsonl(srcPath);
      expect(srcLines.every((r) => r.sessionId === oldId)).toBe(true);
      expect(srcLines.every((r) => !r.forkedFrom)).toBe(true);
    });

    it('copies the selected branch approval state into a fork', async () => {
      const { file, lines } = seedSession();
      lines[1]!['parentUuid'] = 'approval-yolo';
      fs.writeFileSync(
        file,
        [
          lines[0],
          {
            uuid: 'approval-yolo',
            parentUuid: 'u1',
            sessionId: oldId,
            type: 'system',
            subtype: 'session_approval_mode',
            timestamp: '2026-04-22T00:00:00.500Z',
            cwd,
            version: 'test',
            systemPayload: { mode: 'yolo' },
          },
          lines[1],
        ]
          .map((record) => JSON.stringify(record))
          .join('\n') + '\n',
      );

      const result = await service.forkSession(oldId, newId);
      const written = fs
        .readFileSync(result.filePath, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));

      expect(written).toContainEqual(
        expect.objectContaining({
          sessionId: newId,
          subtype: 'session_approval_mode',
          systemPayload: { mode: 'yolo' },
        }),
      );
    });

    it('copies approval state at a historical fork checkpoint', async () => {
      const { file, lines } = seedSession();
      lines[1]!['parentUuid'] = 'approval-default';
      const checkpoint = {
        uuid: 'checkpoint-approval',
        parentUuid: 'u2',
        sessionId: oldId,
        type: 'system',
        subtype: 'branch_checkpoint',
        timestamp: '2026-04-22T00:00:01.500Z',
        cwd,
        version: 'test',
        systemPayload: {
          v: 1,
          startExclusiveRecordUuid: null,
          assistantRecordUuid: 'u2',
          promptId: `${oldId}########0`,
        },
      };
      fs.writeFileSync(
        file,
        [
          lines[0],
          {
            uuid: 'approval-default',
            parentUuid: 'u1',
            sessionId: oldId,
            type: 'system',
            subtype: 'session_approval_mode',
            timestamp: '2026-04-22T00:00:00.500Z',
            cwd,
            version: 'test',
            systemPayload: { mode: 'default' },
          },
          lines[1],
          checkpoint,
          {
            uuid: 'approval-yolo',
            parentUuid: 'checkpoint-approval',
            sessionId: oldId,
            type: 'system',
            subtype: 'session_approval_mode',
            timestamp: '2026-04-22T00:00:02.000Z',
            cwd,
            version: 'test',
            systemPayload: { mode: 'yolo' },
          },
          {
            uuid: 'u3',
            parentUuid: 'approval-yolo',
            sessionId: oldId,
            type: 'user',
            timestamp: '2026-04-22T00:00:03.000Z',
            cwd,
            version: 'test',
            message: { role: 'user', parts: [{ text: 'later' }] },
          },
        ]
          .map((record) => JSON.stringify(record))
          .join('\n') + '\n',
      );

      const result = await service.forkSession(oldId, newId, {
        atRecordId: 'checkpoint-approval',
      });
      const written = fs
        .readFileSync(result.filePath, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      const approvalRecords = written.filter(
        (record) => record.subtype === 'session_approval_mode',
      );

      expect(approvalRecords).toHaveLength(1);
      expect(approvalRecords[0].systemPayload).toEqual({ mode: 'default' });
    });

    it('remaps persisted telemetry prompt ids into the fork', async () => {
      seedSession([
        sys('telemetry-1', 'u2', 'ui_telemetry', 2, {
          uiEvent: {
            'event.name': 'api_response',
            prompt_id: `${oldId}#Explore#0`,
          },
        }),
      ]);

      const result = await fork();
      const telemetry = readJsonl(result.filePath).find(
        (record) => record.subtype === 'ui_telemetry',
      );

      expect(telemetry.systemPayload.uiEvent.prompt_id).toBe(
        `${newId}#Explore#0`,
      );
    });

    it('remaps record and chat_compression promptIds into the fork', async () => {
      // Forked ids must remain visible to the new session's seed.
      const { file, lines } = seedSession();
      writeJsonl(file, [
        { ...lines[0], promptId: `${oldId}########0` },
        lines[1],
        sys(
          'compression-1',
          'u2',
          'chat_compression',
          2,
          {
            info: {
              originalTokenCount: 100,
              newTokenCount: 40,
              compressionStatus: 'compressed',
            },
            compressedHistory: [{ role: 'user', parts: [{ text: 'summary' }] }],
            promptIds: [`${oldId}########0`, null],
          },
          { cwd },
        ),
      ]);

      const written = readJsonl((await fork()).filePath);

      const copiedUser = written.find((record) => record.uuid === 'u1');
      expect(copiedUser.promptId).toBe(`${newId}########0`);
      const copiedCompression = written.find(
        (record) => record.subtype === 'chat_compression',
      );
      expect(copiedCompression.systemPayload.promptIds).toEqual([
        `${newId}########0`,
        null,
      ]);
    });

    it('does not copy source turn_result identities into a fork', async () => {
      seedSession([
        sys('turn-result-1', 'u2', 'turn_result', 2, {
          promptId: 'source-prompt-id',
          state: 'completed',
          endedAt: 2000,
        }),
        sys(
          'artifact-after-turn-result',
          'turn-result-1',
          'session_artifact_event',
          3,
          artifactPayload(oldId, 1, ts(3), []),
        ),
      ]);

      const result = await fork();
      const written = readJsonl(result.filePath);

      expect(written).toHaveLength(3);
      expect(written.some((record) => record.subtype === 'turn_result')).toBe(
        false,
      );
      expect(
        written.find((record) => record.uuid === 'artifact-after-turn-result'),
      ).toMatchObject({ parentUuid: 'u2' });
    });

    it('writes source metadata and drops the inherited title for sourced forks', async () => {
      seedSession([
        sys('title-1', 'u2', 'custom_title', 2, {
          customTitle: 'Parent title',
          titleSource: 'manual',
        }),
      ]);

      const result = await fork({
        source: { sourceType: 'side_task', sourceId: oldId },
      });
      const written = readJsonl(result.filePath);

      expect(written[0]).toMatchObject({
        parentUuid: null,
        sessionId: newId,
        type: 'system',
        subtype: 'session_source',
        cwd,
        version: 'test',
        systemPayload: { sourceType: 'side_task', sourceId: oldId },
      });
      expect(written.some((record) => record.subtype === 'custom_title')).toBe(
        false,
      );
      expect(written[1]).toMatchObject({
        parentUuid: written[0].uuid,
        forkedFrom: { sessionId: oldId, messageUuid: 'u1' },
      });
    });

    it('forks from a validated historical Assistant checkpoint', async () => {
      const { file } = seedSession([
        checkpointLine('checkpoint-1', 'u2', 2, null, {
          promptId: `${oldId}########0`,
        }),
        msg('u3', 'checkpoint-1', 'user', 3, 'later'),
        msg('u4', 'u3', 'assistant', 4, 'later answer'),
      ]);

      const result = await fork({
        atRecordId: 'checkpoint-1',
        title: 'Historical branch',
      });
      const written = readJsonl(result.filePath);

      expect(written.map((record) => record.uuid)).toEqual([
        'u1',
        'u2',
        'checkpoint-1',
        expect.any(String),
      ]);
      expect(written[2].systemPayload).not.toHaveProperty('promptId');
      expect(written.at(-1)).toMatchObject({
        subtype: 'custom_title',
        systemPayload: { customTitle: 'Historical branch' },
      });
      expect(
        fs
          .readFileSync(file, 'utf8')
          .split('\n')
          .some((line) => line.includes('later answer')),
      ).toBe(true);
    });

    it('keeps a checkpoint valid when its creation-metadata boundary is filtered', async () => {
      const { file, lines } = seedSession();
      const creationRecord = sys(
        'creation-metadata',
        null,
        'session_source',
        0,
        { sourceType: 'web-shell' },
      );
      lines[0]!['parentUuid'] = 'creation-metadata';
      const checkpoint = checkpointLine(
        'checkpoint-after-creation',
        'u2',
        2,
        'creation-metadata',
      );
      writeJsonl(file, [creationRecord, ...lines, checkpoint]);

      const first = await fork({ atRecordId: 'checkpoint-after-creation' });
      const written = readJsonl(first.filePath);
      expect(
        written.some((record) => record.uuid === 'creation-metadata'),
      ).toBe(false);
      expect(
        written.find((record) => record.uuid === 'checkpoint-after-creation')
          ?.systemPayload,
      ).toMatchObject({ startExclusiveRecordUuid: null });
      await expect(
        service.forkSession(newId, nestedId, {
          atRecordId: 'checkpoint-after-creation',
        }),
      ).resolves.toMatchObject({ copiedCount: 3 });
    });

    it('remaps a checkpoint boundary from a filtered custom_title to its predecessor', async () => {
      const asked = { provenance: 'real_user' };
      const answered = { provenance: 'assistant_output' };
      fs.mkdirSync(chatsDir(), { recursive: true });
      writeJsonl(transcriptPath(oldId), [
        msg('u1', null, 'user', 0, 'first question', asked),
        msg('a1', 'u1', 'assistant', 1, 'first answer', answered),
        sys('title-1', 'a1', 'custom_title', 1.5, {
          customTitle: 'Renamed',
          titleSource: 'manual',
        }),
        msg('u2', 'title-1', 'user', 2, 'second question', asked),
        msg('a2', 'u2', 'assistant', 3, 'second answer', answered),
        checkpointLine('checkpoint-2', 'a2', 3.5, 'title-1', {
          assistantRecordUuid: 'a2',
        }),
      ]);

      const result = await fork({
        atRecordId: 'checkpoint-2',
        source: { sourceType: 'side_task' },
      });
      const written = readJsonl(result.filePath);
      expect(written.some((r) => r.subtype === 'custom_title')).toBe(false);
      const forkedCheckpoint = written.find((r) => r.uuid === 'checkpoint-2');
      expect(forkedCheckpoint?.systemPayload).toMatchObject({
        startExclusiveRecordUuid: 'a1',
      });
      await expect(
        service.forkSession(newId, nestedId, { atRecordId: 'checkpoint-2' }),
      ).resolves.toBeDefined();
    });

    it('forks from a checkpoint whose line is duplicated in the transcript', async () => {
      const checkpoint = checkpointLine('checkpoint-dup', 'u2', 2, null);
      seedSession([
        checkpoint,
        checkpoint,
        msg('u3', 'checkpoint-dup', 'user', 3, 'later'),
      ]);

      const result = await fork({ atRecordId: 'checkpoint-dup' });

      expect(result.copiedCount).toBe(3);
      expect(readJsonl(result.filePath).map((record) => record.uuid)).toEqual([
        'u1',
        'u2',
        'checkpoint-dup',
      ]);
    });

    it('rejects a checkpoint that is no longer on the active chain', async () => {
      seedSession([
        checkpointLine('inactive-checkpoint', 'u2', 2, null),
        msg('active-sibling', 'u2', 'user', 3, 'active sibling'),
      ]);

      await expect(
        fork({ atRecordId: 'inactive-checkpoint' }),
      ).rejects.toMatchObject({ name: 'BranchPointInvalidError' });
      expect(fs.existsSync(transcriptPath(newId))).toBe(false);
    });

    async function seedSavedPage() {
      const { file } = seedSession();
      const page = await saveArtifactSnapshot(
        'original page',
        'Page',
        'https://example.com',
        oldId,
        realTmpDir,
      );
      const id = stableSessionArtifactId(oldId, `managed:${page.managedId}`);
      const recordedAt = ts(2);
      fs.appendFileSync(
        file,
        JSON.stringify(
          sys('saved-page', 'u2', 'session_artifact_event', 2, {
            v: 2,
            sessionId: oldId,
            sequence: 1,
            recordedAt,
            changes: [
              {
                action: 'created',
                artifactId: id,
                artifact: {
                  ...page,
                  id,
                  source: 'tool',
                  toolName: 'artifact',
                  status: 'available',
                  retention: 'restorable',
                  clientRetained: false,
                  createdAt: recordedAt,
                  updatedAt: recordedAt,
                },
              },
            ],
          }),
        ) + '\n',
      );
      return page;
    }
    const snapshotOf = (page: Parameters<typeof readArtifactSnapshot>[0]) =>
      readArtifactSnapshot(page, realTmpDir);
    const referencesOf = (page: { url?: string }) =>
      realPath.join(realPath.dirname(fileURLToPath(page.url!)), 'references');

    it('retains an unloaded fork snapshot until its final session is deleted', async () => {
      const page = await seedSavedPage();
      await fork();
      process.env['QWEN_RUNTIME_DIR'] = realPath.join(
        realTmpDir,
        'other-runtime',
      );
      await expect(service.removeSession(oldId)).resolves.toBe(true);
      await expect(snapshotOf(page)).resolves.toBe('original page');
      const loaded = await service.loadSession(newId);
      expect(loaded?.artifactSnapshot?.artifacts).toHaveLength(1);
      expect(loaded?.artifactSnapshot?.artifacts[0]).toMatchObject({
        url: page.url,
        managedId: page.managedId,
      });
      await expect(service.removeSession(newId)).resolves.toBe(true);
      await expect(
        fs.promises.stat(realPath.dirname(fileURLToPath(page.url!))),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it.each([false, true])(
      'isolates relocated and replacement same-ID sessions, destination deleted first: %s',
      async (destinationFirst) => {
        const movedPage = await seedSavedPage();
        const movedCwd = realPath.join(realTmpDir, 'moved-workspace');
        fs.mkdirSync(movedCwd);
        const destination = new SessionService(movedCwd, {
          runtimeBaseDir: realTmpDir,
        });
        const sourceFile = transcriptPath(oldId);
        const destinationDir = realPath.join(
          destination['storage'].getProjectDir(),
          'chats',
        );
        fs.mkdirSync(destinationDir, { recursive: true });
        writeJsonl(
          realPath.join(destinationDir, `${oldId}.jsonl`),
          readJsonl(sourceFile).map((record) => ({ ...record, cwd: movedCwd })),
        );
        fs.unlinkSync(sourceFile);
        const replacementPage = await seedSavedPage();
        const [first, second] = destinationFirst
          ? [
              { service: destination, page: movedPage },
              { service, page: replacementPage },
            ]
          : [
              { service, page: replacementPage },
              { service: destination, page: movedPage },
            ];
        await expect(first.service.removeSession(oldId)).resolves.toBe(true);
        await expect(snapshotOf(first.page)).rejects.toThrow();
        await expect(snapshotOf(second.page)).resolves.toBe('original page');
        await expect(second.service.removeSession(oldId)).resolves.toBe(true);
        await expect(snapshotOf(second.page)).rejects.toThrow();
      },
    );

    it.each(['file', 'directory', 'references'])(
      'forks the conversation while preserving a saved-page record with missing %s',
      async (missing) => {
        const page = await seedSavedPage();
        const file = fileURLToPath(page.url!);
        await fs.promises.rm(
          missing === 'file'
            ? file
            : missing === 'directory'
              ? realPath.dirname(file)
              : referencesOf(page),
          { recursive: true },
        );
        const { service: forkService, warnings } = withWarnings(cwd, {
          runtimeBaseDir: realTmpDir,
        });

        await forkService.forkSession(oldId, newId);

        const forked = await forkService.loadSession(newId);
        expect(
          forked?.conversation.messages.map((record) => record.uuid),
        ).toEqual(['u1', 'u2']);
        expect(forked?.artifactSnapshot?.artifacts).toEqual([
          expect.objectContaining({
            id: stableSessionArtifactId(newId, `managed:${page.managedId}`),
            url: page.url,
            managedId: page.managedId,
            metadata: page.metadata,
            createdAt: '2026-04-22T00:00:02.000Z',
          }),
        ]);
        expect(warnings).toEqual([
          expect.stringContaining('missing snapshot storage'),
        ]);
        expect(
          (await forkService.loadSession(oldId))?.conversation.messages,
        ).toHaveLength(2);
      },
    );

    it('does not commit a fork when snapshot ownership bookkeeping fails', async () => {
      const references = referencesOf(await seedSavedPage());
      await fs.promises.rm(references, { recursive: true });
      await fs.promises.writeFile(references, 'not a directory');
      await expect(fork()).rejects.toMatchObject({ code: 'ENOTDIR' });
      await expect(
        fs.promises.stat(transcriptPath(newId)),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('rolls back only the failed fork operation snapshot reference', async () => {
      const page = await seedSavedPage();
      const link = vi
        .spyOn(fs.promises, 'link')
        .mockRejectedValue(errno('target won by another fork', 'EEXIST'));
      try {
        await expect(fork()).rejects.toThrow('Target session already exists');
      } finally {
        link.mockRestore();
      }
      const references = referencesOf(page);
      expect(await fs.promises.readdir(references)).toHaveLength(1);
      await expect(snapshotOf(page)).resolves.toBe('original page');
      await deleteArtifactSnapshot(page, realTmpDir, oldId);
      await expect(fs.promises.stat(references)).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });

    it('does not resurrect artifacts removed by later side records when forking', async () => {
      const { file, lines } = seedSession();
      const url = 'https://example.com/forked-then-removed';
      const oldArtifactId = stableSessionArtifactId(oldId, `url:${url}`);
      const forkedArtifactId = stableSessionArtifactId(newId, `url:${url}`);
      writeJsonl(file, [
        lines[0],
        linkLine('artifact-create', 'u1', 0.5, 'Forked artifact', url),
        sys(
          'artifact-remove',
          'u1',
          'session_artifact_event',
          0.75,
          artifactPayload(oldId, 2, ts(0.75), [linkRemoved(oldArtifactId)]),
        ),
        lines[1],
      ]);

      const result = await fork();
      const loaded = await service.loadSession(newId);
      const forkedRemovePayload = readJsonl(result.filePath).find(
        (record) => record.uuid === 'artifact-remove',
      )?.systemPayload;

      expect(result.copiedCount).toBe(4);
      expect(loaded?.artifactSnapshot?.artifacts).toEqual([]);
      expect(loaded?.artifactSnapshot?.tombstonedIds).toContain(
        forkedArtifactId,
      );
      expect(forkedRemovePayload).toMatchObject({
        changes: [linkRemoved(forkedArtifactId)],
      });
    });

    it('preserves file history snapshots on the forked session', async () => {
      seedSession([snapshotLine('snapshot-1', 'u2', { 'a.txt': 'backup-a' })]);
      seedBackups({ 'backup-a': 'content' });

      await fork();
      const loaded = await service.loadSession(newId);

      expect(loaded?.fileHistorySnapshots).toHaveLength(1);
      expect(loaded?.fileHistorySnapshots?.[0]?.promptId).toBe(
        `${newId}########0`,
      );
    });

    it.runIf(process.platform !== 'win32')(
      'preserves file-history backup modes on the forked session',
      async () => {
        seedSession([backupSnapshotLine(['backup-mode'])]);
        const sourceBackupDir = seedBackups({
          'backup-mode': 'content',
        });
        fs.chmodSync(realPath.join(sourceBackupDir, 'backup-mode'), 0o755);

        await fork();

        expect(
          fs.statSync(realPath.join(backupDir(newId), 'backup-mode')).mode &
            0o777,
        ).toBe(0o755);
      },
    );

    it('publishes only backups referenced by the bounded transcript', async () => {
      // The turn's snapshot precedes the checkpoint on the active chain (the
      // recorder appends it first) and a LATER snapshot follows it; that backup
      // must not leak: truncate the transcript before selecting backups.
      seedSession([
        snapshotLine('snapshot-before', 'u2', {
          'file-0.txt': 'backup-a',
        }),
        checkpointLine('checkpoint-bounded', 'snapshot-before', 3, null),
        {
          ...snapshotLine(
            'snapshot-after',
            'checkpoint-bounded',
            { 'file-0.txt': 'later-backup' },
            `${oldId}########1`,
          ),
          timestamp: ts(4),
        },
      ]);
      seedBackups({
        'backup-a': 'kept',
        'later-backup': 'created after the checkpoint',
        'unreferenced-backup': 'not copied',
      });

      await fork({ atRecordId: 'checkpoint-bounded' });

      expect(fs.readdirSync(backupDir(newId))).toEqual(['backup-a']);
    });

    it('retains pre-checkpoint artifacts without leaking later ones', async () => {
      seedSession([
        linkLine(
          'artifact-early',
          'u2',
          2.5,
          'Early artifact',
          'https://example.com/before-checkpoint',
        ),
        checkpointLine('checkpoint-artifact', 'u2', 3, null),
        linkLine(
          'artifact-late',
          'checkpoint-artifact',
          4,
          'Late artifact',
          'https://example.com/after-checkpoint',
        ),
      ]);

      const result = await fork({ atRecordId: 'checkpoint-artifact' });

      const loaded = await service.loadSession(newId);
      expect(loaded?.artifactSnapshot?.artifacts).toEqual([
        expect.objectContaining({
          id: stableSessionArtifactId(
            newId,
            'url:https://example.com/before-checkpoint',
          ),
          title: 'Early artifact',
        }),
      ]);
      const forkedRaw = fs.readFileSync(result.filePath, 'utf8');
      expect(forkedRaw).toContain('artifact-early');
      expect(forkedRaw).toContain('Early artifact');
      expect(forkedRaw).not.toContain('artifact-late');
      expect(forkedRaw).not.toContain('Late artifact');
    });

    it('omits a missing file-history backup without failing the fork', async () => {
      const warned = withWarnings(cwd);
      service = warned.service;
      seedSession([backupSnapshotLine(['backup-present', 'backup-missing'])]);
      seedBackups({ 'backup-present': 'copied first' });

      await expect(fork()).resolves.toMatchObject({
        filePath: transcriptPath(newId),
      });

      expect(fs.existsSync(transcriptPath(newId))).toBe(true);
      expect(fs.readdirSync(backupDir(newId))).toEqual(['backup-present']);
      expect(warned.warnings).toEqual([
        expect.stringContaining(
          'omitted missing file-history backup backup-missing',
        ),
      ]);
    });

    it('omits dot file-history backup names instead of failing the fork', async () => {
      seedSession([backupSnapshotLine(['.', '..', 'backup-ok'])]);
      seedBackups({ 'backup-ok': 'content' });

      await expect(fork()).resolves.toBeDefined();

      expect(fs.readdirSync(backupDir(newId))).toEqual(['backup-ok']);
    });

    it('leaves no visible target after an existing backup cannot be copied', async () => {
      seedSession([
        backupSnapshotLine(['backup-present', 'backup-copy-fails']),
      ]);
      seedBackups({
        'backup-present': 'copied first',
        'backup-copy-fails': 'cannot copy',
      });
      const realOpen = fs.promises.open;
      const openSpy = vi
        .spyOn(fs.promises, 'open')
        .mockImplementation(async (filePath, flags, mode) => {
          if (
            String(filePath).endsWith('backup-copy-fails') &&
            flags === 'wx'
          ) {
            throw new Error('backup copy failed');
          }
          return realOpen(filePath, flags, mode);
        });

      try {
        await expect(fork()).rejects.toThrow('backup copy failed');
      } finally {
        openSpy.mockRestore();
      }

      expect(fs.existsSync(transcriptPath(newId))).toBe(false);
      expect(fs.existsSync(backupDir(newId))).toBe(false);
      expect(
        fs
          .readdirSync(realPath.join(realTmpDir, 'file-history'))
          .some((name) => name.includes(newId)),
      ).toBe(false);
    });

    it('does not follow a file-history backup symlink', async () => {
      const warned = withWarnings(cwd);
      service = warned.service;
      seedSession([backupSnapshotLine(['backup-symlink'])]);
      const sourceBackupDir = seedBackups({});
      const outside = realPath.join(realTmpDir, 'outside-backup');
      fs.writeFileSync(outside, 'outside content');
      fs.symlinkSync(outside, realPath.join(sourceBackupDir, 'backup-symlink'));

      await expect(fork()).resolves.toBeDefined();

      expect(fs.existsSync(backupDir(newId))).toBe(false);
      expect(warned.warnings).toEqual([
        expect.stringContaining(
          'omitted missing file-history backup backup-symlink',
        ),
      ]);
    });

    it('preserves a backup target that appears immediately before publication', async () => {
      seedSession([backupSnapshotLine(['backup-collision'])]);
      seedBackups({ 'backup-collision': 'source content' });
      const targetBackupDir = backupDir(newId);
      const realRename = fs.promises.rename;
      const renameSpy = vi
        .spyOn(fs.promises, 'rename')
        .mockImplementation(async (source, target) => {
          if (String(target) === targetBackupDir) {
            fs.mkdirSync(targetBackupDir, { recursive: true });
            fs.writeFileSync(
              realPath.join(targetBackupDir, 'foreign-sentinel'),
              'foreign content',
            );
            throw errno('backup target appeared', 'EEXIST');
          }
          return realRename(source, target);
        });

      try {
        await expect(fork()).rejects.toMatchObject({ code: 'EEXIST' });
      } finally {
        renameSpy.mockRestore();
      }

      expect(fs.existsSync(transcriptPath(newId))).toBe(false);
      expect(
        fs.readFileSync(
          realPath.join(targetBackupDir, 'foreign-sentinel'),
          'utf8',
        ),
      ).toBe('foreign content');
      expect(fs.readdirSync(chatsDir()).some(isTmpOf(newId))).toBe(false);
      expect(
        fs
          .readdirSync(realPath.join(realTmpDir, 'file-history'))
          .some(isTmpOf(newId)),
      ).toBe(false);
    });

    it('removes copied file-history backups when deleting a fork', async () => {
      const sourceBackupDir = seedBackups({ 'backup-a': 'content' });
      seedSession([snapshotLine('snapshot-1', 'u2', { 'a.txt': 'backup-a' })]);

      await fork();
      expect(fs.existsSync(realPath.join(backupDir(newId), 'backup-a'))).toBe(
        true,
      );

      await expect(service.removeSession(newId)).resolves.toBe(true);
      expect(fs.existsSync(backupDir(newId))).toBe(false);
      expect(fs.existsSync(sourceBackupDir)).toBe(true);
    });

    it('forks only the active branch after rewind', async () => {
      fs.mkdirSync(chatsDir(), { recursive: true });
      writeJsonl(transcriptPath(oldId), [
        msg('u1', null, 'user', 0, 'first'),
        msg('u2', 'u1', 'assistant', 1, 'first reply'),
        msg('u3', 'u2', 'user', 2, 'second'),
        msg('u4', 'u3', 'assistant', 3, 'second reply'),
        sys('rewind-1', 'u2', 'rewind', 4, {
          targetTurnIndex: 1,
          truncatedCount: 2,
        }),
      ]);

      const result = await fork();
      const loaded = await service.loadSession(newId);

      expect(result.copiedCount).toBe(3);
      expect(
        loaded?.conversation.messages.flatMap(
          (message) => message.message?.parts?.map((part) => part.text) ?? [],
        ),
      ).toEqual(['first', 'first reply']);
    });

    it('throws when the source session does not exist', async () => {
      await expect(fork()).rejects.toThrow();
    });

    it('throws when the target session file already exists', async () => {
      seedSession();
      fs.writeFileSync(transcriptPath(newId), 'x');

      await expect(fork()).rejects.toThrow(/already exists/);
    });

    it.each(['ENOTSUP', 'EPERM', 'EXDEV'] as const)(
      'falls back to rename when transcript hard links fail with %s',
      async (causeCode) => {
        seedSession();
        const targetPath = transcriptPath(newId);
        const realLink = fs.promises.link;
        const linkSpy = vi
          .spyOn(fs.promises, 'link')
          .mockImplementation(async (source, target) => {
            if (target === targetPath) {
              throw errno('hard links are unsupported', causeCode);
            }
            return realLink(source, target);
          });

        try {
          await expect(fork()).resolves.toMatchObject({ filePath: targetPath });
        } finally {
          linkSpy.mockRestore();
        }

        expect(fs.existsSync(targetPath)).toBe(true);
        expect(await service.loadSession(newId)).toBeDefined();
      },
    );

    it('removes published backups when transcript publication fails', async () => {
      seedSession([backupSnapshotLine(['backup-orphan'])]);
      seedBackups({ 'backup-orphan': 'backup content' });
      const targetTranscript = transcriptPath(newId);
      const realRename = fs.promises.rename;
      const renameError = errno('rename failed', 'EIO');
      const linkSpy = vi
        .spyOn(fs.promises, 'link')
        .mockRejectedValue(errno('link failed', 'EIO'));
      const renameSpy = vi
        .spyOn(fs.promises, 'rename')
        .mockImplementation(async (source, target) => {
          if (String(target) === targetTranscript) throw renameError;
          return realRename(source, target);
        });

      try {
        await expect(fork()).rejects.toBe(renameError);
      } finally {
        linkSpy.mockRestore();
        renameSpy.mockRestore();
      }

      expect(fs.existsSync(targetTranscript)).toBe(false);
      expect(fs.existsSync(backupDir(newId))).toBe(false);
    });

    it('removes a partially written target when fork creation fails', async () => {
      seedSession();
      const dir = chatsDir();
      // Fail AFTER a partial write lands on disk so the cleanup path is the
      // thing under test (an open-time failure would leave nothing to clean).
      const realOpen = fs.promises.open;
      const openSpy = vi
        .spyOn(fs.promises, 'open')
        .mockImplementation(async (...args) => {
          const handle = await realOpen(...args);
          if (!String(args[0]).startsWith(realPath.join(dir, `.${newId}.`))) {
            return handle;
          }
          Object.defineProperty(handle, 'writeFile', {
            value: async () => {
              await handle.write('partial', null, 'utf8');
              throw new Error('disk full');
            },
          });
          return handle;
        });

      try {
        await expect(fork()).rejects.toThrow('disk full');
      } finally {
        openSpy.mockRestore();
      }
      expect(fs.existsSync(transcriptPath(newId))).toBe(false);
      expect(
        fs.readdirSync(dir).some((name) => name.startsWith(`.${newId}.`)),
      ).toBe(false);
    });

    it.skipIf(process.platform === 'win32')(
      'preserves a committed titled session when final directory fsync fails',
      async () => {
        const warned = withWarnings(cwd);
        service = warned.service;
        seedSession();
        const dir = chatsDir();
        const targetPath = transcriptPath(newId);
        const realOpen = fs.promises.open;
        const openSpy = vi
          .spyOn(fs.promises, 'open')
          .mockImplementation(async (filePath, flags, mode) => {
            if (
              filePath === dir &&
              flags === 'r' &&
              fs.existsSync(targetPath)
            ) {
              throw new Error('directory fsync failed');
            }
            return realOpen(filePath, flags, mode);
          });

        try {
          await expect(
            fork({ title: 'Durable branch' }),
          ).resolves.toMatchObject({ filePath: targetPath });
        } finally {
          openSpy.mockRestore();
        }

        expect(fs.existsSync(targetPath)).toBe(true);
        expect(service.getSessionTitle(newId)).toBe('Durable branch');
        expect(warned.warnings).toEqual([
          expect.stringContaining(`branch committed session=${newId}`),
        ]);
      },
    );

    it('throws when the source session belongs to a different project', async () => {
      // Defensive guard: a file in this project's chats dir can carry a record
      // whose cwd hashes elsewhere (manual move, corrupted state); fork must
      // refuse rather than silently cross project boundaries.
      fs.mkdirSync(chatsDir(), { recursive: true });
      writeJsonl(transcriptPath(oldId), [
        msg('u1', null, 'user', 0, 'hi', {
          cwd: '/some/other/project',
        }),
      ]);

      await expect(fork()).rejects.toThrow(
        /does not belong to current project/,
      );
    });

    it('forks a migrated session when runtime status matches this project', async () => {
      seedSession([], realPath.join(realTmpDir, 'old-project'));
      migrated(oldId, cwd);

      const result = await fork();

      expect(result.copiedCount).toBe(2);
      expect(fs.existsSync(result.filePath)).toBe(true);
      expect(readJsonl(result.filePath).every((r) => r.cwd === cwd)).toBe(true);
      await expect(service.loadSession(newId)).resolves.toBeDefined();
    });

    it('rejects invalid sessionId patterns before touching disk', async () => {
      await expect(service.forkSession('bogus', newId)).rejects.toThrow(
        /Invalid source sessionId/,
      );
      await expect(service.forkSession(oldId, 'bogus')).rejects.toThrow(
        /Invalid new sessionId/,
      );
    });

    it('drops creation metadata so the fork inherits no lineage or source', async () => {
      // A fork is a fresh top-level session, not a sub-session: copying the
      // source's parent_session record would make it report the original's
      // parent as its own. The creation records sit on the active branch
      // (u1 -> parent_session -> session_source -> u2) and would be copied.
      fs.mkdirSync(chatsDir(), { recursive: true });
      writeJsonl(transcriptPath(oldId), [
        msg('u1', null, 'user', 0, 'hello'),
        sys('up', 'u1', 'parent_session', 0.5, {
          parentSessionId: 'P',
        }),
        sys('us', 'up', 'session_source', 0.75, {
          sourceType: 'scheduled_task',
          sourceId: 'task-123',
        }),
        linkLine(
          'artifact-after-source',
          'us',
          0.8,
          'Retained artifact',
          'https://example.com/after-source-metadata',
        ),
        msg('u2', 'us', 'assistant', 1, 'hi'),
      ]);

      const result = await fork();

      const written = readJsonl(result.filePath);
      for (const subtype of ['parent_session', 'session_source']) {
        expect(
          written.some((r) => r.type === 'system' && r.subtype === subtype),
        ).toBe(false);
      }

      // The source keeps its lineage; the fork carries none of it.
      expect(await service.readParentSessionId(oldId)).toBe('P');
      expect(await service.readParentSessionId(newId)).toBeUndefined();
      expect(await service.readCreationMetadata(oldId)).toMatchObject({
        sourceType: 'scheduled_task',
        sourceId: 'task-123',
      });
      expect(await service.readCreationMetadata(newId)).toEqual({});
      await expect(service.loadSession(newId)).resolves.toMatchObject({
        artifactSnapshot: {
          artifacts: [expect.objectContaining({ title: 'Retained artifact' })],
        },
      });
    });
  });

  describe('findSessionTitlesByPrefix', () => {
    // Real disk like forkSession: readSessionTitleInfoFromFile reads the file
    // tail for the custom_title record, which mocks would defeat.
    let service: SessionService;
    let cwd: string;
    const disk = useRealDisk(
      'find-titles-prefix-',
      (d) => ({ service, cwd } = d),
    );
    const [id1, id2, id3] = realDiskIds;
    const seedTitled = (
      sessionId: string,
      title: string,
      state: 'active' | 'archived' = 'active',
      sessionCwd = cwd,
    ) =>
      disk.write(sessionId, titledLines(sessionId, title, sessionCwd), state);
    const titlesFor = (prefix: string) =>
      service.findSessionTitlesByPrefix(prefix);

    it('returns titles whose custom_title starts with the prefix (case-insensitive)', async () => {
      seedTitled(id1, 'my-branch(1)');
      seedTitled(id2, 'My-Branch(2)');
      seedTitled(id3, 'unrelated session');

      const titles = await titlesFor('my-branch(');

      expect(new Set(titles)).toEqual(
        new Set(['my-branch(1)', 'My-Branch(2)']),
      );
      await expect(service.getSessionDisplayName(id1)).resolves.toBe(
        'my-branch(1)',
      );
    });

    it('also returns titles from archived sessions, so unarchiving cannot surface a duplicate', async () => {
      seedTitled(id1, 'my-branch(1)');
      seedTitled(id2, 'my-branch(2)', 'archived');

      const titles = await titlesFor('my-branch(');

      expect(new Set(titles)).toEqual(
        new Set(['my-branch(1)', 'my-branch(2)']),
      );
    });

    it('deduplicates a title held by the same session in both active and archived state', async () => {
      // An interrupted move can leave one file in chats/ and chats/archive/
      // (getSessionLocation 'conflict'); both scans must not report it twice.
      seedTitled(id1, 'my-branch(1)', 'active');
      seedTitled(id1, 'my-branch(1)', 'archived');

      expect(await titlesFor('my-branch(')).toEqual(['my-branch(1)']);
    });

    it('skips archived sessions from other projects (collisions stay project-scoped)', async () => {
      seedTitled(id1, 'shared(1)', 'archived');
      seedTitled(id2, 'shared(2)', 'archived', '/some/other/project');

      expect(await titlesFor('shared(')).toEqual(['shared(1)']);
    });

    it('computeUniqueBranchTitle skips a suffix already taken by an archived session', async () => {
      seedTitled(id1, 'my-branch(1)', 'archived');

      const title = await computeUniqueBranchTitle('my-branch', service);

      expect(title).toBe('my-branch(2)');
    });

    it('returns empty when chats directory does not exist', async () => {
      expect(await titlesFor('anything')).toEqual([]);
    });

    it('skips sessions from other projects (collisions are project-scoped)', async () => {
      seedTitled(id1, 'shared(1)');
      // Same chats dir (sessions are stored under projectHash anyway), but
      // the record's cwd belongs to another project → must be skipped.
      seedTitled(id2, 'shared(2)', 'active', '/some/other/project');

      expect(await titlesFor('shared(')).toEqual(['shared(1)']);
      await expect(service.getSessionDisplayName(id2)).resolves.toBeUndefined();
    });

    it('returns undefined for an empty session file', async () => {
      disk.write(id1, '');

      await expect(service.getSessionDisplayName(id1)).resolves.toBe(undefined);
    });

    it('returns undefined for missing sessions and invalid ids', async () => {
      await expect(
        service.getSessionDisplayName('44444444-4444-4444-8444-444444444444'),
      ).resolves.toBeUndefined();
      await expect(
        service.getSessionDisplayName('not-a-session'),
      ).resolves.toBeUndefined();
    });

    it('uses the picker prompt when a session has no custom title', async () => {
      const prompt = '创建 MR 描述生成 Skill(1)';
      const file = disk.write(id1, [
        msgLine(id1, 'u1', null, 'user', 0, prompt),
      ]);

      expect(await titlesFor('创建 MR 描述生成 Skill(')).toEqual([prompt]);
      expect(
        vi
          .mocked(jsonl.readLines)
          .mock.calls.filter(([filePath]) => filePath === file),
      ).toEqual([[file, 10]]);
      await expect(service.getSessionDisplayName(id1)).resolves.toBe(prompt);
    });

    it('uses the picker prompt for an archived session with no custom title', async () => {
      disk.write(
        id1,
        [msgLine(id1, 'u1', null, 'user', 0, 'archived-prompt(1)')],
        'archived',
      );

      expect(await titlesFor('archived-prompt(')).toEqual([
        'archived-prompt(1)',
      ]);
    });
  });

  describe('unarchiveSessions title collision', () => {
    // Real disk again: the actual retitle-then-move needs a real renameSync
    // and writeLineSync, which the read-only real-disk setup leaves mocked.
    let service: SessionService;
    const disk = useRealDisk(
      'unarchive-title-collision-',
      (d) => ({ service } = d),
      'write',
    );
    const [activeId, archivedId, loneId] = realDiskIds;
    const seedTitled = (
      sessionId: string,
      title: string,
      state: 'active' | 'archived',
    ) => disk.write(sessionId, titledLines(sessionId, title), state);

    it('retitles an archived session before unarchiving it into a title an active session already holds', async () => {
      seedTitled(activeId, 'my-branch(1)', 'active');
      seedTitled(archivedId, 'my-branch(1)', 'archived');

      const result = await service.unarchiveSessions([archivedId]);

      expect(result.unarchived).toEqual([archivedId]);
      expect(result.errors).toEqual([]);
      await expect(service.getSessionDisplayName(activeId)).resolves.toBe(
        'my-branch(1)',
      );
      await expect(service.getSessionDisplayName(archivedId)).resolves.toBe(
        'my-branch(2)',
      );
    });

    it('leaves the title untouched when unarchiving does not collide', async () => {
      seedTitled(loneId, 'unrelated-branch', 'archived');

      const result = await service.unarchiveSessions([loneId]);

      expect(result.unarchived).toEqual([loneId]);
      await expect(service.getSessionDisplayName(loneId)).resolves.toBe(
        'unrelated-branch',
      );
    });
  });

  describe('computeUniqueBranchTitle', () => {
    it('uses the first available numeric suffix', async () => {
      const service = {
        findSessionTitlesByPrefix: vi
          .fn()
          .mockResolvedValue([
            '创建 MR 描述生成 Skill(1)',
            '创建 MR 描述生成 Skill(2)',
            '创建 MR 描述生成 Skill(4)',
          ]),
      } as unknown as SessionService;

      await expect(
        computeUniqueBranchTitle('创建 MR 描述生成 Skill', service),
      ).resolves.toBe('创建 MR 描述生成 Skill(3)');
      expect(service.findSessionTitlesByPrefix).toHaveBeenCalledWith(
        '创建 MR 描述生成 Skill(',
      );
    });

    it.each([
      ['Source session (Branch)', 'Source session'],
      ['Source session (Branch 2)', 'Source session'],
      ['Source session(2)', 'Source session'],
      ['Sprint (2)', 'Sprint (2)'],
      ['(Branch)', undefined],
      ['(Branch 2)', undefined],
    ])('normalizes derived branch title %s', (title, expected) => {
      expect(normalizeDerivedBranchTitle(title)).toBe(expected);
    });
  });

  describe('listSessions worktree membership', () => {
    const worktreeSessionId = '7ca8c920-e29b-41d4-a716-446655440001';
    const listFromWorktree = (worktreeCwd: string) => {
      (path as unknown as Record<string, unknown>)['sep'] = '/';
      readdirSyncSpy.mockReturnValue(dirents(`${worktreeSessionId}.jsonl`));
      vi.mocked(jsonl.readLines).mockResolvedValue([
        { ...recordA1, sessionId: worktreeSessionId, cwd: worktreeCwd },
      ]);
    };

    it('includes a session whose transcript cwd is a worktree under this project', async () => {
      listFromWorktree('/test/project/root/.qwen/worktrees/my-task');
      // The worktree cwd hashes differently from the repo root, so the first
      // getProjectHash(recordCwd) check fails and marker inference runs.
      vi.mocked(getProjectHash).mockImplementation((p: string) =>
        p === '/test/project/root' ? 'test-project-hash' : 'worktree-hash',
      );

      const result = await sessionService.listSessions();

      expect(result.items).toHaveLength(1);
      expect(result.items[0].sessionId).toBe(worktreeSessionId);
    });

    it('excludes a session whose worktree belongs to a different project', async () => {
      listFromWorktree('/other/repo/.qwen/worktrees/my-task');
      vi.mocked(getProjectHash).mockImplementation((p: string) =>
        p.startsWith('/other/repo') ? 'other-hash' : 'test-project-hash',
      );

      const result = await sessionService.listSessions();

      expect(result.items).toHaveLength(0);
    });
  });

  describe('listSessions parentSessionId round-trip', () => {
    // Real disk like findSessionTitlesByPrefix: readParentSessionIdFromFile's
    // synchronous tail/head scan can't run on the mocked jsonl.readLines.
    let service: SessionService;
    let cwd: string;
    const disk = useRealDisk(
      'parent-session-id-',
      (d) => ({ service, cwd } = d),
    );

    // Every case writes one transcript in its own tmp dir, so the id is shared.
    const sessionId = '21111111-1111-4111-8111-111111111111';
    const write = (content: Line[] | string) => disk.write(sessionId, content);
    const userLine = (text: string) =>
      msgLine(sessionId, 'u1', null, 'user', 0, text);
    const parentSessionLine = (parentSessionId: string) =>
      sysLine(sessionId, 'u2', 'u1', 'parent_session', 1, { parentSessionId });
    const sessionSourceLine = () =>
      sysLine(sessionId, 'u3', 'u2', 'session_source', 2, {
        sourceType: 'scheduled_task',
        sourceId: 'task-123',
      });
    const goalStateLine = (objective: string | null, uuid = 'g1') =>
      sysLine(sessionId, uuid, null, 'goal_state', 3, goalPayload(objective));
    const legacyGoalLine = (
      condition: string,
      kind: 'checking' | 'aborted' = 'checking',
      uuid = 'legacy-goal',
    ) =>
      sysLine(
        sessionId,
        uuid,
        null,
        'slash_command',
        3,
        legacyGoalPayload(condition, kind),
      );
    const noteLine = (uuid: string, text: string) =>
      sysLine(sessionId, uuid, null, 'note', 4, { text });
    const fillerLines = (bytes: number) =>
      Array.from({ length: Math.ceil(bytes / 400) }, (_, i) =>
        noteLine(`f${i}`, 'x'.repeat(350)),
      );
    const listed = async () =>
      (await service.listSessions()).items.find(
        (item) => item.sessionId === sessionId,
      );
    const creation = { sourceType: 'scheduled_task', sourceId: 'task-123' };
    /** Truncated transcripts: restore the real integrity-checked reads. */
    const expectTornPrefix = async (file: string) => {
      const actualJsonl = await vi.importActual<
        typeof import('../utils/jsonl-utils.js')
      >('../utils/jsonl-utils.js');
      vi.mocked(jsonl._recoverObjectsFromLine).mockImplementation(
        actualJsonl._recoverObjectsFromLine,
      );
      vi.mocked(jsonl.readLinesWithIntegrity).mockImplementation(
        actualJsonl.readLinesWithIntegrity,
      );
      await expect(
        jsonl.readLinesWithIntegrity(file, 10),
      ).resolves.toMatchObject({ complete: false });
    };
    const expectUnlabelled = async () => {
      expect((await listed())?.goalObjective).toBeUndefined();
      await expect(
        service.getSessionListItem(sessionId),
      ).resolves.toMatchObject({ goalObjective: undefined });
    };

    /** A one-prompt transcript for `id`, tagged with `sourceType` if given. */
    const sourced = (id: string, text: string, sourceType?: string) => [
      msgLine(id, 'u1', null, 'user', 0, text),
      ...(sourceType
        ? [sysLine(id, 'u3', 'u2', 'session_source', 2, { sourceType })]
        : []),
    ];
    const visibleId = '00000000-0000-4000-8000-000000000001';
    const hiddenId = '00000000-0000-4000-8000-000000000002';

    it('excludes a source before applying the page size', async () => {
      // A second excluded source (a mesh agent's body session) must be dropped
      // by the same list option, not just the one name it was built for.
      const sessions: Array<[string, string, string?]> = [
        [visibleId, 'visible'],
        [hiddenId, 'hidden', 'agent-host'],
        ['00000000-0000-4000-8000-000000000003', 'hidden agent', 'agent'],
      ];
      sessions.forEach(([id, text, sourceType], i) => {
        const file = disk.write(id, sourced(id, text, sourceType));
        fs.utimesSync(file, new Date(i + 1), new Date(i + 1));
      });

      await expect(
        service.listSessions({
          size: 1,
          excludeSourceTypes: ['agent-host', 'agent'],
        }),
      ).resolves.toMatchObject({
        items: [{ sessionId: visibleId }],
        hasMore: false,
        nextCursor: undefined,
      });
    });

    it('excludes the source from active and archived counts', async () => {
      disk.write(visibleId, sourced(visibleId, 'visible'));
      disk.write(
        hiddenId,
        sourced(hiddenId, 'hidden', 'agent-host'),
        'archived',
      );

      await expect(
        service.getSessionInfoCounts({ excludeSourceTypes: ['agent-host'] }),
      ).resolves.toEqual({
        active: 1,
        archived: 0,
        total: 1,
        truncated: false,
      });
    });

    // Short complete fixtures answer from parsed records before the scan runs.
    // The long and truncated fixtures below drive the real tail-window scan
    // and pin the production marker (`"subtype":"goal_state"`) and field name.
    it('labels a prompt-less session with its Goal objective', async () => {
      write([goalStateLine('Ship the requested change')]);

      expect(await listed()).toMatchObject({
        prompt: '',
        goalObjective: 'Ship the requested change',
      });
    });

    it('recovers a legacy Goal from a complete record prefix', async () => {
      write([legacyGoalLine('😀'.repeat(250))]);

      expect((await listed())?.goalObjective).toBe(`${'😀'.repeat(200)}...`);
    });

    it('reads the Goal record through the file scan, not the parsed records', async () => {
      // The goal_state record sits past the ten-line parsed prefix, so only the
      // tail-window scan can answer; this pins its marker and field name.
      write([...fillerLines(6 * 1024), goalStateLine('😀'.repeat(250))]);

      expect((await listed())?.goalObjective).toBe(`${'😀'.repeat(200)}...`);
    });

    it('does not resurrect an objective the user cleared', async () => {
      // The clear record carries `goal: null` and no objective at all, so a
      // "last objective on any goal_state line" read would answer with the
      // create record's objective instead.
      write([
        goalStateLine('Write the release notes'),
        goalStateLine(null, 'g2'),
      ]);

      await expectUnlabelled();
    });

    it.each([
      ['short', ''],
      ['larger than the tail window', 'x'.repeat(70 * 1024)],
      ['ending at a colon', null],
    ])(
      'does not resurrect a clear glued after a %s torn record',
      async (_name, tornContent) => {
        const create = JSON.stringify(goalStateLine('Write the release notes'));
        const clear = JSON.stringify(goalStateLine(null, 'g2'));
        const torn =
          tornContent === null
            ? '{"type":"system","subtype":"note","systemPayload":'
            : JSON.stringify(noteLine('torn', tornContent)).slice(0, -3);
        await expectTornPrefix(write(`${create}${torn}${clear}\n`));

        await expectUnlabelled();
      },
    );

    it('ignores a nested Goal marker in a non-Goal record', async () => {
      write([
        ...fillerLines(9 * 400).slice(0, 9),
        msgLine(sessionId, 'nested-marker', null, 'assistant', 5, '', {
          message: content(
            'model',
            fnCall('persist', {
              type: 'system',
              subtype: 'goal_state',
              objective: 'injected',
            }),
          ),
        }),
      ]);

      await expectUnlabelled();
    });

    it.each([
      ['first array element', false],
      ['comma-positioned array element', true],
    ])(
      'does not label a session from a payload-bearing Goal in a torn %s',
      async (_name, withPrefix) => {
        const clear = goalStateLine(null);
        const nestedGoal = goalStateLine('injected', 'nested-goal');
        const containing = JSON.stringify({
          type: 'assistant',
          parts: [
            ...(withPrefix ? [{ type: 'text', text: 'before' }] : []),
            nestedGoal,
          ],
        });
        const nestedJson = JSON.stringify(nestedGoal);
        const torn = containing.slice(
          0,
          containing.indexOf(nestedJson) + nestedJson.length,
        );
        await expectTornPrefix(write(`${JSON.stringify(clear)}\n${torn}\n`));

        await expectUnlabelled();
      },
    );

    it('does not resurrect a legacy Goal cleared past the record window', async () => {
      const objective = 'Ship the legacy change';
      write([
        legacyGoalLine(objective),
        ...fillerLines(6 * 1024),
        legacyGoalLine(objective, 'aborted', 'legacy-clear'),
      ]);

      await expectUnlabelled();
    });

    it('reads the clear record when it sits at the end of a long transcript', async () => {
      write([
        goalStateLine('Write the migration guide'),
        ...fillerLines(200 * 1024),
        goalStateLine(null, 'g2'),
      ]);

      expect((await listed())?.goalObjective).toBeUndefined();
    });

    it('labels nothing when the Goal records fell out of the tail window', async () => {
      // The clear record sits past both the ten-line parsed prefix and the tail
      // window, so only the stale create record at the head is reachable.
      write([
        goalStateLine('Write the migration guide'),
        ...fillerLines(8 * 1024),
        goalStateLine(null, 'g2'),
        ...fillerLines(200 * 1024),
      ]);

      expect((await listed())?.goalObjective).toBeUndefined();
    });

    it('uses complete parsed records when a few large records exceed the tail window', async () => {
      write([
        goalStateLine('Ship the requested change'),
        ...['n1', 'n2', 'n3'].map((uuid) =>
          noteLine(uuid, 'x'.repeat(30 * 1024)),
        ),
      ]);

      expect((await listed())?.goalObjective).toBe('Ship the requested change');
      await expect(
        service.getSessionListItem(sessionId),
      ).resolves.toMatchObject({ goalObjective: 'Ship the requested change' });
    });

    it('exposes the Goal objective through the single-session read path', async () => {
      write([goalStateLine('Ship the requested change')]);

      await expect(
        service.getSessionListItem(sessionId),
      ).resolves.toMatchObject({ goalObjective: 'Ship the requested change' });
    });

    it('leaves the single-session read path unlabelled when a prompt exists', async () => {
      write([
        userLine('a real prompt'),
        goalStateLine('Ship the requested change'),
      ]);

      const item = await service.getSessionListItem(sessionId);
      expect(item?.prompt).toBe('a real prompt');
      expect(item?.goalObjective).toBeUndefined();
    });

    it('rehydrates parentSessionId from a parent_session record', async () => {
      write([userLine('hello'), parentSessionLine('parent-abc')]);

      const item = await listed();
      expect(item).toBeDefined();
      expect(item?.parentSessionId).toBe('parent-abc');
    });

    it('rehydrates source metadata for lists and direct restore lookup', async () => {
      write([
        userLine('hello'),
        parentSessionLine('parent-abc'),
        sessionSourceLine(),
      ]);

      expect(await listed()).toMatchObject({
        parentSessionId: 'parent-abc',
        ...creation,
      });
      expect(await service.readCreationMetadata(sessionId)).toEqual({
        parentSessionId: 'parent-abc',
        ...creation,
      });
    });

    it('rehydrates source metadata appended after the head scan window', async () => {
      write([
        userLine('hello'),
        ...Array.from({ length: 11 }, (_, i) => ({
          ...userLine(`filler-${i}`),
          uuid: `filler-${i}`,
        })),
        sessionSourceLine(),
      ]);

      expect(await listed()).toMatchObject(creation);
      expect(await service.readCreationMetadata(sessionId)).toMatchObject(
        creation,
      );
    });

    it('reads one exact persisted summary without paging the catalog', async () => {
      write([userLine('exact prompt'), sessionSourceLine()]);

      await expect(
        service.getSessionListItem(sessionId),
      ).resolves.toMatchObject({
        sessionId,
        cwd,
        startTime: '2026-04-22T00:00:00.000Z',
        prompt: 'exact prompt',
        ...creation,
        isArchived: false,
      });
    });

    it('keeps the first immutable source record', async () => {
      write([
        userLine('hello'),
        sessionSourceLine(),
        {
          ...sessionSourceLine(),
          uuid: 'u4',
          systemPayload: { sourceType: 'api', sourceId: 'request-456' },
        },
      ]);

      expect(await service.readCreationMetadata(sessionId)).toMatchObject(
        creation,
      );
    });

    it('leaves parentSessionId undefined when no parent_session record exists', async () => {
      write([userLine('hello')]);

      const item = await listed();
      expect(item).toBeDefined();
      expect(item?.parentSessionId).toBeUndefined();
    });

    it('reads a parent_session record near the head past the tail window', async () => {
      // Written once near the file start, the parent_session record is pushed
      // out of the 64KB tail window by bulk records; the head scan finds it.
      write([
        userLine('hello'),
        parentSessionLine('parent-head'),
        // 30 * ~4KB comfortably exceeds the 64KB tail window.
        ...Array.from({ length: 30 }, (_, i) =>
          msgLine(
            sessionId,
            `bulk-${i}`,
            i === 0 ? 'u2' : `bulk-${i - 1}`,
            'user',
            60,
            'x'.repeat(4000),
          ),
        ),
      ]);

      const item = await listed();
      expect(item).toBeDefined();
      expect(item?.parentSessionId).toBe('parent-head');
    });

    it('readParentSessionId returns the parentSessionId for a session with a parent_session record', async () => {
      write([userLine('hello'), parentSessionLine('parent-xyz')]);

      expect(await service.readParentSessionId(sessionId)).toBe('parent-xyz');
    });

    it('readParentSessionId returns undefined for a session without a parent_session record', async () => {
      write([userLine('hello')]);

      expect(await service.readParentSessionId(sessionId)).toBeUndefined();
    });

    it('readParentSessionId returns undefined for a nonexistent session', async () => {
      expect(await service.readParentSessionId(sessionId)).toBeUndefined();
    });
  });
});
