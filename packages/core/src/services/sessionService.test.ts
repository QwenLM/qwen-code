/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
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
import {
  readRuntimeStatus,
  readRuntimeStatusClaims,
} from '../utils/runtimeStatus.js';
import {
  SessionService,
  SessionTranscriptDurabilityError,
  buildApiHistoryFromConversation,
  computeUniqueBranchTitle,
  normalizeDerivedBranchTitle,
  getResumePromptTokenCount,
  getResumeTokenCounts,
  type ConversationRecord,
} from './sessionService.js';
import {
  SESSION_TRANSCRIPT_MAX_INDEX_BYTES,
  SessionTranscriptReader,
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
import { Storage } from '../config/storage.js';
import { readSessionPrs, writeSessionPrs } from './session-pr-service.js';
import { SessionWriterLostError } from './session-writer-lease.js';

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
// Keep the real merge logic; only the sidecar I/O is controlled per test.
vi.mock('./session-pr-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./session-pr-service.js')>()),
  readSessionPrs: vi.fn(),
  writeSessionPrs: vi.fn(),
}));

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

    // Mock jsonl-utils. `parseLineTolerant` defaults to a no-op so any code
    // path that streams lines through it (e.g. countSessionMessages,
    // readLastRecordUuid) does not crash on the auto-mocked `undefined`
    // return; tests that need recovery semantics override this explicitly.
    vi.mocked(jsonl.read).mockResolvedValue([]);
    vi.mocked(jsonl.readLines).mockResolvedValue([]);
    vi.mocked(jsonl.parseLineTolerant).mockReturnValue([]);
    vi.mocked(readRuntimeStatus).mockResolvedValue(null);
    vi.mocked(readRuntimeStatusClaims).mockImplementation(
      async (chatsDir, sessionId, options) => {
        const statusPath = path.join(chatsDir, `${sessionId}.runtime.json`);
        const status = await readRuntimeStatus(statusPath, options);
        return {
          statuses: status ? [status] : [],
          incomplete: false,
        };
      },
    );

    type MaintenanceInternals = {
      getSessionFilePath: (
        sessionId: string,
        state: 'active' | 'archived',
      ) => string;
      resolveMaintainableSessionSnapshot: (sessionId: string) => Promise<{
        location: 'active' | 'archived' | 'conflict' | undefined;
        identities: Array<{
          state: 'active' | 'archived';
          filePath: string;
          dev: number;
          ino: number;
          size: number;
          mtimeMs: number;
          ctimeMs: number;
        }>;
      }>;
      assertMaintainableSessionUnchanged: () => void;
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

  // Test session IDs (UUID-like format)
  const sessionIdA = '550e8400-e29b-41d4-a716-446655440000';
  const sessionIdB = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
  const sessionIdC = '6ba7b811-9dad-11d1-80b4-00c04fd430c8';

  // Test records
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

  describe('listSessions', () => {
    it('should return empty list when no sessions exist', async () => {
      readdirSyncSpy.mockReturnValue([]);

      const result = await sessionService.listSessions();

      expect(result.items).toHaveLength(0);
      expect(result.hasMore).toBe(false);
      expect(result.nextCursor).toBeUndefined();
    });

    it('yields after 128 directory entries and stops statting after cancellation', async () => {
      const fileNames = Array.from(
        { length: 129 },
        (_, index) => `${index.toString(16).padStart(32, '0')}.jsonl`,
      );
      readdirSyncSpy.mockReturnValue(
        fileNames as unknown as Array<fs.Dirent<Buffer>>,
      );
      const controller = new AbortController();
      const reason = Object.assign(new Error('catalog request disconnected'), {
        code: 'ENOENT',
      });
      setImmediate(() => controller.abort(reason));

      await expect(
        sessionService.listSessions({ signal: controller.signal }),
      ).rejects.toBe(reason);
      expect(statSyncSpy).toHaveBeenCalledTimes(128);
      expect(jsonl.readLines).not.toHaveBeenCalled();
    });

    it('does not yield during directory enumeration without a signal', async () => {
      const fileNames = Array.from(
        { length: 129 },
        (_, index) => `${index.toString(16).padStart(32, '0')}.jsonl`,
      );
      readdirSyncSpy.mockReturnValue(
        fileNames as unknown as Array<fs.Dirent<Buffer>>,
      );
      const setImmediateSpy = vi.spyOn(globalThis, 'setImmediate');

      await sessionService.listSessions({ size: 0 });

      expect(statSyncSpy).toHaveBeenCalledTimes(129);
      expect(setImmediateSpy).not.toHaveBeenCalled();
    });

    it('passes cancellation to the per-file JSONL read', async () => {
      readdirSyncSpy.mockReturnValue([
        `${sessionIdA}.jsonl`,
      ] as unknown as Array<fs.Dirent<Buffer>>);
      const controller = new AbortController();
      const reason = new Error('cancelled during session JSONL read');
      let readSignal: AbortSignal | undefined;
      vi.mocked(jsonl.readLines).mockImplementation(
        async (_filePath, _count, options) => {
          readSignal = options?.signal;
          await new Promise<void>((_resolve, reject) => {
            readSignal?.addEventListener(
              'abort',
              () => reject(readSignal?.reason),
              { once: true },
            );
          });
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
      readdirSyncSpy.mockReturnValue([
        `${sessionIdA}.jsonl`,
      ] as unknown as Array<fs.Dirent<Buffer>>);
      const migratedRecord = { ...recordA1, cwd: '/old/project' };
      vi.mocked(jsonl.readLines).mockResolvedValue([migratedRecord]);
      vi.mocked(getProjectHash).mockImplementation((cwd: string) =>
        cwd === '/test/project/root'
          ? 'test-project-hash'
          : 'other-project-hash',
      );
      vi.mocked(readRuntimeStatusClaims).mockResolvedValue({
        statuses: [
          {
            schemaVersion: 1,
            pid: 123,
            sessionId: sessionIdA,
            workDir: '/test/project/root',
            hostname: 'host',
            startedAt: 1,
            qwenVersion: null,
          },
        ],
        incomplete: false,
      });
      const controller = new AbortController();

      await sessionService.listSessions({ signal: controller.signal });

      expect(readRuntimeStatusClaims).toHaveBeenCalledWith(
        expect.any(String),
        sessionIdA,
        { signal: controller.signal },
      );
    });

    it('should return empty list when chats directory does not exist', async () => {
      const error = new Error('ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      readdirSyncSpy.mockImplementation(() => {
        throw error;
      });

      const result = await sessionService.listSessions();

      expect(result.items).toHaveLength(0);
      expect(result.hasMore).toBe(false);
    });

    it('should list sessions sorted by mtime descending', async () => {
      const now = Date.now();

      readdirSyncSpy.mockReturnValue([
        `${sessionIdA}.jsonl`,
        `${sessionIdB}.jsonl`,
      ] as unknown as Array<fs.Dirent<Buffer>>);

      statSyncSpy.mockImplementation((filePath: fs.PathLike) => {
        const path = filePath.toString();
        return {
          mtimeMs: path.includes(sessionIdB) ? now : now - 10000,
          isFile: () => true,
        } as fs.Stats;
      });

      vi.mocked(jsonl.readLines).mockImplementation(
        async (filePath: string) => {
          if (filePath.includes(sessionIdA)) {
            return [recordA1];
          }
          return [recordB1];
        },
      );

      const result = await sessionService.listSessions();

      expect(result.items).toHaveLength(2);
      // sessionIdB should be first (more recent mtime)
      expect(result.items[0].sessionId).toBe(sessionIdB);
      expect(result.items[1].sessionId).toBe(sessionIdA);
    });

    it('should ignore archive directory when listing active sessions', async () => {
      readdirSyncSpy.mockReturnValue([
        `${sessionIdA}.jsonl`,
        'archive',
      ] as unknown as Array<fs.Dirent<Buffer>>);
      statSyncSpy.mockReturnValue({
        mtimeMs: Date.now(),
        isFile: () => true,
      } as fs.Stats);
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
      readdirSyncSpy.mockImplementation((dir: fs.PathLike) => {
        // path.join is mocked above to join with '/', so production paths
        // always use '/' here regardless of host platform — match that, not
        // path.sep (which stays the real host separator under the automock).
        if (dir.toString().endsWith('/chats/archive')) {
          return [`${sessionIdB}.jsonl`] as unknown as Array<fs.Dirent<Buffer>>;
        }
        return [`${sessionIdA}.jsonl`] as unknown as Array<fs.Dirent<Buffer>>;
      });
      statSyncSpy.mockReturnValue({
        mtimeMs: Date.now(),
        isFile: () => true,
      } as fs.Stats);
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
      readdirSyncSpy.mockImplementation((dir: fs.PathLike) => {
        if (dir.toString().endsWith('/archive')) {
          return [`${sessionIdB}.jsonl`] as unknown as Array<fs.Dirent<Buffer>>;
        }
        return [
          `${sessionIdA}.jsonl`,
          'archive',
          'not-a-session.txt',
        ] as unknown as Array<fs.Dirent<Buffer>>;
      });
      vi.mocked(jsonl.readLines).mockImplementation(
        async (filePath: string) => {
          if (filePath.includes(sessionIdA)) return [recordA1];
          if (filePath.includes(sessionIdB)) return [recordB1];
          return [];
        },
      );

      const result = await sessionService.getSessionInfoCounts();

      expect(result).toEqual({
        active: 1,
        archived: 1,
        total: 2,
        truncated: false,
      });
      // Membership scan only needs the first record — never a deep read.
      for (const [, lineLimit] of vi.mocked(jsonl.readLines).mock.calls) {
        expect(lineLimit).toBe(1);
      }
    });

    it('getSessionInfoCounts excludes sessions from other projects', async () => {
      readdirSyncSpy.mockImplementation((dir: fs.PathLike) =>
        dir.toString().endsWith('/archive')
          ? ([] as unknown as Array<fs.Dirent<Buffer>>)
          : ([`${sessionIdA}.jsonl`] as unknown as Array<fs.Dirent<Buffer>>),
      );
      vi.mocked(jsonl.readLines).mockResolvedValue([
        { ...recordA1, cwd: '/different/project' },
      ]);
      vi.mocked(getProjectHash).mockImplementation((cwd: string) =>
        cwd === '/test/project/root'
          ? 'test-project-hash'
          : 'other-project-hash',
      );

      await expect(sessionService.getSessionInfoCounts()).resolves.toEqual({
        active: 0,
        archived: 0,
        total: 0,
        truncated: false,
      });
    });

    it('getSessionInfoCounts returns zeros when chats dirs are missing', async () => {
      const error = new Error('ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      readdirSyncSpy.mockImplementation(() => {
        throw error;
      });

      await expect(sessionService.getSessionInfoCounts()).resolves.toEqual({
        active: 0,
        archived: 0,
        total: 0,
        truncated: false,
      });
    });

    it('marks counts truncated when a candidate session cannot be read', async () => {
      readdirSyncSpy.mockImplementation((dir: fs.PathLike) =>
        dir.toString().endsWith('/archive')
          ? ([] as unknown as Array<fs.Dirent<Buffer>>)
          : ([`${sessionIdA}.jsonl`, `${sessionIdB}.jsonl`] as unknown as Array<
              fs.Dirent<Buffer>
            >),
      );
      vi.mocked(jsonl.readLines).mockImplementation(
        async (filePath: string) => {
          if (filePath.includes(sessionIdA)) return [recordA1];
          throw new Error('unreadable');
        },
      );

      await expect(sessionService.getSessionInfoCounts()).resolves.toEqual({
        active: 1,
        archived: 0,
        total: 1,
        truncated: true,
      });
    });

    it('should extract prompt text from first record', async () => {
      const now = Date.now();

      readdirSyncSpy.mockReturnValue([
        `${sessionIdA}.jsonl`,
      ] as unknown as Array<fs.Dirent<Buffer>>);

      statSyncSpy.mockReturnValue({
        mtimeMs: now,
        isFile: () => true,
      } as fs.Stats);

      vi.mocked(jsonl.readLines).mockResolvedValue([recordA1]);

      const result = await sessionService.listSessions();

      expect(result.items[0].prompt).toBe('hello session a');
      expect(result.items[0].gitBranch).toBe('main');
    });

    it('should use recorded display text for the session list prompt', async () => {
      readdirSyncSpy.mockReturnValue([
        `${sessionIdA}.jsonl`,
      ] as unknown as Array<fs.Dirent<Buffer>>);
      statSyncSpy.mockReturnValue({
        mtimeMs: Date.now(),
        isFile: () => true,
      } as fs.Stats);
      vi.mocked(jsonl.readLines).mockResolvedValue([
        {
          ...recordA1,
          message: {
            role: 'user',
            parts: [{ text: 'internal channel instructions\n\nhello' }],
          },
          systemPayload: { displayText: 'hello', hookContext: '' },
        },
      ]);

      const result = await sessionService.listSessions();

      expect(result.items[0].prompt).toBe('hello');
    });

    it('should keep an intentionally empty display prompt empty', async () => {
      readdirSyncSpy.mockReturnValue([
        `${sessionIdA}.jsonl`,
      ] as unknown as Array<fs.Dirent<Buffer>>);
      statSyncSpy.mockReturnValue({
        mtimeMs: Date.now(),
        isFile: () => true,
      } as fs.Stats);
      vi.mocked(jsonl.readLines).mockResolvedValue([
        {
          ...recordA1,
          message: {
            role: 'user',
            parts: [{ text: 'internal channel instructions' }],
          },
          systemPayload: { displayText: '', hookContext: '' },
        },
      ]);

      const result = await sessionService.listSessions();

      expect(result.items[0].prompt).toBe('');
    });

    it('should use a later prompt after an empty display prompt', async () => {
      readdirSyncSpy.mockReturnValue([
        `${sessionIdA}.jsonl`,
      ] as unknown as Array<fs.Dirent<Buffer>>);
      statSyncSpy.mockReturnValue({
        mtimeMs: Date.now(),
        isFile: () => true,
      } as fs.Stats);
      vi.mocked(jsonl.readLines).mockResolvedValue([
        {
          ...recordA1,
          message: {
            role: 'user',
            parts: [{ text: 'internal channel instructions' }],
          },
          systemPayload: { displayText: '', hookContext: '' },
        },
        {
          ...recordA1,
          uuid: 'later-user',
          message: { role: 'user', parts: [{ text: 'later prompt' }] },
        },
      ]);

      const result = await sessionService.listSessions();

      expect(result.items[0].prompt).toBe('later prompt');
    });

    it('should skip internal user-subtype records after an empty projection', async () => {
      readdirSyncSpy.mockReturnValue([
        `${sessionIdA}.jsonl`,
      ] as unknown as Array<fs.Dirent<Buffer>>);
      statSyncSpy.mockReturnValue({
        mtimeMs: Date.now(),
        isFile: () => true,
      } as fs.Stats);
      vi.mocked(jsonl.readLines).mockResolvedValue([
        {
          ...recordA1,
          systemPayload: { displayText: '', hookContext: '' },
        },
        {
          ...recordA1,
          uuid: 'cron',
          subtype: 'cron',
          message: { role: 'user', parts: [{ text: 'internal cron prompt' }] },
        },
        {
          ...recordA1,
          uuid: 'later-user',
          message: { role: 'user', parts: [{ text: 'later prompt' }] },
        },
      ]);

      const result = await sessionService.listSessions();

      expect(result.items[0].prompt).toBe('later prompt');
    });

    it('should NOT populate messageCount during listing', async () => {
      // Listing must avoid the full-file readline that counting requires
      // — message counts are now lazy and provided by
      // `countSessionMessages(sessionId)` only when a UI surface (e.g.
      // a session preview) is about to display them. Pinning this
      // contract here so future refactors can't quietly re-introduce
      // the per-file scan that used to dominate /resume open time.
      readdirSyncSpy.mockReturnValue([
        `${sessionIdA}.jsonl`,
      ] as unknown as Array<fs.Dirent<Buffer>>);
      statSyncSpy.mockReturnValue({
        mtimeMs: Date.now(),
        isFile: () => true,
      } as fs.Stats);
      vi.mocked(jsonl.readLines).mockResolvedValue([recordA1]);

      const result = await sessionService.listSessions();

      expect(result.items).toHaveLength(1);
      expect(result.items[0].messageCount).toBeUndefined();
    });

    it('should truncate long prompts', async () => {
      const longPrompt = 'A'.repeat(300);
      const recordWithLongPrompt: ChatRecord = {
        ...recordA1,
        message: { role: 'user', parts: [{ text: longPrompt }] },
      };

      readdirSyncSpy.mockReturnValue([
        `${sessionIdA}.jsonl`,
      ] as unknown as Array<fs.Dirent<Buffer>>);
      statSyncSpy.mockReturnValue({
        mtimeMs: Date.now(),
        isFile: () => true,
      } as fs.Stats);
      vi.mocked(jsonl.readLines).mockResolvedValue([recordWithLongPrompt]);

      const result = await sessionService.listSessions();

      expect(result.items[0].prompt.length).toBe(203); // 200 + '...'
      expect(result.items[0].prompt.endsWith('...')).toBe(true);
    });

    it('should truncate long prompts on code-point boundaries', async () => {
      const longPrompt = '😀'.repeat(300);
      readdirSyncSpy.mockReturnValue([
        `${sessionIdA}.jsonl`,
      ] as unknown as Array<fs.Dirent<Buffer>>);
      statSyncSpy.mockReturnValue({
        mtimeMs: Date.now(),
        isFile: () => true,
      } as fs.Stats);
      vi.mocked(jsonl.readLines).mockResolvedValue([
        {
          ...recordA1,
          message: { role: 'user', parts: [{ text: longPrompt }] },
        },
      ]);

      const result = await sessionService.listSessions();

      expect(Array.from(result.items[0].prompt)).toHaveLength(203);
      expect(result.items[0].prompt).toBe(`${'😀'.repeat(200)}...`);
    });

    it('should paginate with size parameter', async () => {
      const now = Date.now();

      readdirSyncSpy.mockReturnValue([
        `${sessionIdA}.jsonl`,
        `${sessionIdB}.jsonl`,
        `${sessionIdC}.jsonl`,
      ] as unknown as Array<fs.Dirent<Buffer>>);

      statSyncSpy.mockImplementation((filePath: fs.PathLike) => {
        const path = filePath.toString();
        let mtime = now;
        if (path.includes(sessionIdB)) mtime = now - 1000;
        if (path.includes(sessionIdA)) mtime = now - 2000;
        return {
          mtimeMs: mtime,
          isFile: () => true,
        } as fs.Stats;
      });

      vi.mocked(jsonl.readLines).mockImplementation(
        async (filePath: string) => {
          if (filePath.includes(sessionIdC)) {
            return [{ ...recordA1, sessionId: sessionIdC }];
          }
          if (filePath.includes(sessionIdB)) {
            return [recordB1];
          }
          return [recordA1];
        },
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
      const oldMtime = now - 2000;
      const cursorMtime = now - 1000;

      readdirSyncSpy.mockReturnValue([
        `${sessionIdA}.jsonl`,
        `${sessionIdB}.jsonl`,
        `${sessionIdC}.jsonl`,
      ] as unknown as Array<fs.Dirent<Buffer>>);

      statSyncSpy.mockImplementation((filePath: fs.PathLike) => {
        const path = filePath.toString();
        let mtime = now;
        if (path.includes(sessionIdB)) mtime = cursorMtime;
        if (path.includes(sessionIdA)) mtime = oldMtime;
        return {
          mtimeMs: mtime,
          isFile: () => true,
        } as fs.Stats;
      });

      vi.mocked(jsonl.readLines).mockResolvedValue([recordA1]);

      // Get items older than cursor (cursorMtime)
      const result = await sessionService.listSessions({ cursor: cursorMtime });

      expect(result.items).toHaveLength(1);
      expect(result.items[0].sessionId).toBe(sessionIdA);
      expect(result.hasMore).toBe(false);
    });

    it('should skip files from different projects', async () => {
      readdirSyncSpy.mockReturnValue([
        `${sessionIdA}.jsonl`,
      ] as unknown as Array<fs.Dirent<Buffer>>);
      statSyncSpy.mockReturnValue({
        mtimeMs: Date.now(),
        isFile: () => true,
      } as fs.Stats);

      // This record is from a different cwd (different project)
      const differentProjectRecord: ChatRecord = {
        ...recordA1,
        cwd: '/different/project',
      };
      vi.mocked(jsonl.readLines).mockResolvedValue([differentProjectRecord]);
      vi.mocked(getProjectHash).mockImplementation((cwd: string) =>
        cwd === '/test/project/root'
          ? 'test-project-hash'
          : 'other-project-hash',
      );

      const result = await sessionService.listSessions();

      expect(result.items).toHaveLength(0);
    });

    it('should list a migrated session when runtime status matches this project', async () => {
      readdirSyncSpy.mockReturnValue([
        `${sessionIdA}.jsonl`,
      ] as unknown as Array<fs.Dirent<Buffer>>);
      statSyncSpy.mockReturnValue({
        mtimeMs: Date.now(),
        isFile: () => true,
      } as fs.Stats);

      const migratedRecord: ChatRecord = {
        ...recordA1,
        cwd: '/old/project',
      };
      vi.mocked(jsonl.readLines).mockResolvedValue([migratedRecord]);
      vi.mocked(readRuntimeStatusClaims).mockResolvedValue({
        statuses: [
          {
            schemaVersion: 1,
            pid: 123,
            sessionId: sessionIdA,
            workDir: '/test/project/root',
            hostname: 'host',
            startedAt: 1,
            qwenVersion: null,
          },
        ],
        incomplete: false,
      });
      vi.mocked(getProjectHash).mockImplementation((cwd: string) =>
        cwd === '/test/project/root'
          ? 'test-project-hash'
          : 'other-project-hash',
      );

      const result = await sessionService.listSessions();

      expect(result.items).toHaveLength(1);
      expect(result.items[0].sessionId).toBe(sessionIdA);
    });

    it('should skip files that do not match session file pattern', async () => {
      readdirSyncSpy.mockReturnValue([
        `${sessionIdA}.jsonl`, // valid
        'not-a-uuid.jsonl', // invalid pattern
        'readme.txt', // not jsonl
        '.hidden.jsonl', // hidden file
      ] as unknown as Array<fs.Dirent<Buffer>>);
      statSyncSpy.mockReturnValue({
        mtimeMs: Date.now(),
        isFile: () => true,
      } as fs.Stats);

      vi.mocked(jsonl.readLines).mockResolvedValue([recordA1]);

      const result = await sessionService.listSessions();

      // Only the valid UUID pattern file should be processed
      expect(result.items).toHaveLength(1);
      expect(result.items[0].sessionId).toBe(sessionIdA);
    });
  });

  describe('loadSession', () => {
    it('claims the project entry before reading an active transcript', async () => {
      const callOrder: string[] = [];
      vi.spyOn(
        Storage.prototype,
        'runWithProjectDirReadClaim',
      ).mockImplementation(async (operation) => {
        callOrder.push('claim');
        return operation();
      });
      vi.mocked(jsonl.read).mockImplementation(async () => {
        callOrder.push('read');
        return [recordB1, recordB2];
      });

      await sessionService.loadSession(sessionIdB);

      expect(callOrder).toEqual(['claim', 'read']);
    });

    it('claims the project entry before restore projection reads', async () => {
      const callOrder: string[] = [];
      vi.spyOn(
        Storage.prototype,
        'runWithProjectDirReadClaim',
      ).mockImplementation(async (operation) => {
        callOrder.push('claim');
        return operation();
      });
      vi.spyOn(
        SessionTranscriptReader.prototype,
        'readRestoreProjection',
      ).mockImplementation(async () => {
        callOrder.push('restore');
        return undefined;
      });
      vi.spyOn(
        SessionTranscriptReader.prototype,
        'readLiveRestoreProjection',
      ).mockImplementation(async () => {
        callOrder.push('live');
        return undefined;
      });

      const options = { replay: { kind: 'none' as const } };
      await sessionService.readRestoreProjection(sessionIdB, options);
      await sessionService.readLiveRestoreProjection(sessionIdB, options);

      expect(callOrder).toEqual(['claim', 'restore', 'claim', 'live']);
    });

    it('should load a session by id and reconstruct history', async () => {
      const now = Date.now();
      statSyncSpy.mockReturnValue({
        mtimeMs: now,
        isFile: () => true,
      } as fs.Stats);
      vi.mocked(jsonl.read).mockResolvedValue([recordB1, recordB2]);

      const loaded = await sessionService.loadSession(sessionIdB);

      expect(loaded?.conversation.sessionId).toBe(sessionIdB);
      expect(loaded?.conversation.messages).toHaveLength(2);
      expect(loaded?.conversation.messages[0].uuid).toBe('b1');
      expect(loaded?.conversation.messages[1].uuid).toBe('b2');
      expect(loaded?.lastCompletedUuid).toBe('b2');
    });

    it('reads archived sessions only through the explicit read-only method', async () => {
      const now = Date.now();
      statSyncSpy.mockReturnValue({
        mtimeMs: now,
        isFile: () => true,
      } as fs.Stats);
      vi.mocked(jsonl.read).mockResolvedValue([recordB1, recordB2]);

      const loaded = await sessionService.loadArchivedSession(sessionIdB, {
        maxBytes: SESSION_TRANSCRIPT_MAX_INDEX_BYTES,
      });

      expect(loaded?.conversation.messages).toHaveLength(2);
      expect(vi.mocked(jsonl.read)).toHaveBeenCalledWith(
        expect.stringContaining(`/chats/archive/${sessionIdB}.jsonl`),
      );
      expect(statSyncSpy).toHaveBeenCalledTimes(1);
    });

    it('accepts an archived session exactly at the requested size limit', async () => {
      statSyncSpy.mockReturnValue({
        size: SESSION_TRANSCRIPT_MAX_INDEX_BYTES,
        mtimeMs: Date.now(),
        isFile: () => true,
      } as fs.Stats);
      vi.mocked(jsonl.read).mockResolvedValue([recordB1, recordB2]);

      await expect(
        sessionService.loadArchivedSession(sessionIdB, {
          maxBytes: SESSION_TRANSCRIPT_MAX_INDEX_BYTES,
        }),
      ).resolves.toBeDefined();
    });

    it('rejects an archived session above the requested size limit', async () => {
      const snapshotSize = SESSION_TRANSCRIPT_MAX_INDEX_BYTES + 1;
      statSyncSpy.mockReturnValue({
        size: snapshotSize,
        mtimeMs: Date.now(),
        isFile: () => true,
      } as fs.Stats);

      const load = sessionService.loadArchivedSession(sessionIdB, {
        maxBytes: SESSION_TRANSCRIPT_MAX_INDEX_BYTES,
      });

      await expect(load).rejects.toEqual(
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
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      });

      await expect(
        sessionService.loadArchivedSession(sessionIdB, {
          maxBytes: SESSION_TRANSCRIPT_MAX_INDEX_BYTES,
        }),
      ).resolves.toBeUndefined();
      expect(vi.mocked(jsonl.read)).not.toHaveBeenCalled();
    });

    it('loads artifact side records attached to the active branch', async () => {
      const now = Date.now();
      statSyncSpy.mockReturnValue({
        mtimeMs: now,
        isFile: () => true,
      } as fs.Stats);
      const artifactId = stableSessionArtifactId(
        sessionIdB,
        'url:https://example.com/report',
      );
      const artifactRecord: ChatRecord = {
        ...recordB1,
        uuid: 'artifact-1',
        parentUuid: 'b1',
        type: 'system',
        subtype: 'session_artifact_event',
        message: undefined,
        systemPayload: {
          v: SESSION_ARTIFACT_PERSISTENCE_VERSION,
          sessionId: sessionIdB,
          sequence: 1,
          recordedAt: '2026-07-06T00:00:00.000Z',
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
                createdAt: '2026-07-06T00:00:00.000Z',
                updatedAt: '2026-07-06T00:00:00.000Z',
                persistedAt: '2026-07-06T00:00:00.000Z',
              },
            },
          ],
        },
      };
      vi.mocked(jsonl.read).mockResolvedValue([
        recordB1,
        artifactRecord,
        recordB2,
      ]);

      const loaded = await sessionService.loadSession(sessionIdB);

      expect(
        loaded?.conversation.messages.map((record) => record.uuid),
      ).toEqual(['b1', 'b2']);
      expect(loaded?.artifactSnapshot?.artifacts).toEqual([
        expect.objectContaining({
          id: artifactId,
          title: 'Report',
        }),
      ]);
    });

    it('loads artifact side records after a tail-neutral title reanchor', async () => {
      const now = Date.now();
      statSyncSpy.mockReturnValue({
        mtimeMs: now,
        isFile: () => true,
      } as fs.Stats);
      const artifactId = stableSessionArtifactId(
        sessionIdB,
        'url:https://example.com/reanchored-report',
      );
      const titleRecord: ChatRecord = {
        ...recordB1,
        uuid: 'title-reanchor',
        parentUuid: 'b1',
        type: 'system',
        subtype: 'custom_title',
        message: undefined,
        systemPayload: {
          customTitle: 'Reanchored title',
          titleSource: 'auto',
        },
      };
      const artifactRecord: ChatRecord = {
        ...recordB1,
        uuid: 'artifact-after-title',
        parentUuid: 'b1',
        type: 'system',
        subtype: 'session_artifact_event',
        message: undefined,
        systemPayload: {
          v: SESSION_ARTIFACT_PERSISTENCE_VERSION,
          sessionId: sessionIdB,
          sequence: 1,
          recordedAt: '2026-07-06T00:00:00.000Z',
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
                title: 'Reanchored report',
                url: 'https://example.com/reanchored-report',
                retention: 'restorable',
                clientRetained: true,
                createdAt: '2026-07-06T00:00:00.000Z',
                updatedAt: '2026-07-06T00:00:00.000Z',
                persistedAt: '2026-07-06T00:00:00.000Z',
              },
            },
          ],
        },
      };
      vi.mocked(jsonl.read).mockResolvedValue([
        recordB1,
        titleRecord,
        artifactRecord,
        recordB2,
      ]);

      const loaded = await sessionService.loadSession(sessionIdB);

      expect(
        loaded?.conversation.messages.map((record) => record.uuid),
      ).toEqual(['b1', 'b2']);
      expect(loaded?.artifactSnapshot?.artifacts).toEqual([
        expect.objectContaining({
          id: artifactId,
          title: 'Reanchored report',
        }),
      ]);
    });

    it('loads chained artifact side records attached to the active branch', async () => {
      const now = Date.now();
      statSyncSpy.mockReturnValue({
        mtimeMs: now,
        isFile: () => true,
      } as fs.Stats);
      const artifactId = stableSessionArtifactId(
        sessionIdB,
        'url:https://example.com/chained-report',
      );
      const createRecord: ChatRecord = {
        ...recordB1,
        uuid: 'artifact-create',
        parentUuid: 'b1',
        type: 'system',
        subtype: 'session_artifact_event',
        message: undefined,
        systemPayload: {
          v: SESSION_ARTIFACT_PERSISTENCE_VERSION,
          sessionId: sessionIdB,
          sequence: 1,
          recordedAt: '2026-07-06T00:00:00.000Z',
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
                title: 'Chained report',
                url: 'https://example.com/chained-report',
                retention: 'restorable',
                clientRetained: true,
                createdAt: '2026-07-06T00:00:00.000Z',
                updatedAt: '2026-07-06T00:00:00.000Z',
                persistedAt: '2026-07-06T00:00:00.000Z',
              },
            },
          ],
        },
      };
      const removeRecord: ChatRecord = {
        ...recordB1,
        uuid: 'artifact-remove',
        parentUuid: 'artifact-create',
        type: 'system',
        subtype: 'session_artifact_event',
        message: undefined,
        systemPayload: {
          v: SESSION_ARTIFACT_PERSISTENCE_VERSION,
          sessionId: sessionIdB,
          sequence: 2,
          recordedAt: '2026-07-06T00:00:01.000Z',
          changes: [
            {
              action: 'removed',
              artifactId,
              reason: 'explicit',
            },
          ],
        },
      };
      vi.mocked(jsonl.read).mockResolvedValue([
        recordB1,
        createRecord,
        removeRecord,
        recordB2,
      ]);

      const loaded = await sessionService.loadSession(sessionIdB);

      expect(
        loaded?.conversation.messages.map((record) => record.uuid),
      ).toEqual(['b1', 'b2']);
      expect(loaded?.artifactSnapshot?.artifacts).toEqual([]);
      expect(loaded?.artifactSnapshot?.tombstonedIds).toContain(artifactId);
    });

    it('does not load artifact side records from abandoned branches', async () => {
      const now = Date.now();
      statSyncSpy.mockReturnValue({
        mtimeMs: now,
        isFile: () => true,
      } as fs.Stats);
      const artifactId = stableSessionArtifactId(
        sessionIdB,
        'url:https://example.com/abandoned-report',
      );
      const artifactRecord: ChatRecord = {
        ...recordB1,
        uuid: 'artifact-abandoned',
        parentUuid: 'b1',
        type: 'system',
        subtype: 'session_artifact_event',
        message: undefined,
        systemPayload: {
          v: SESSION_ARTIFACT_PERSISTENCE_VERSION,
          sessionId: sessionIdB,
          sequence: 1,
          recordedAt: '2026-07-06T00:00:00.000Z',
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
                title: 'Abandoned report',
                url: 'https://example.com/abandoned-report',
                retention: 'restorable',
                clientRetained: true,
                createdAt: '2026-07-06T00:00:00.000Z',
                updatedAt: '2026-07-06T00:00:00.000Z',
                persistedAt: '2026-07-06T00:00:00.000Z',
              },
            },
          ],
        },
      };
      const abandonedChild: ChatRecord = {
        ...recordB2,
        uuid: 'abandoned-child',
        parentUuid: 'b1',
      };
      vi.mocked(jsonl.read).mockResolvedValue([
        recordB1,
        artifactRecord,
        abandonedChild,
        recordB2,
      ]);

      const loaded = await sessionService.loadSession(sessionIdB);

      expect(
        loaded?.conversation.messages.map((record) => record.uuid),
      ).toEqual(['b1', 'b2']);
      expect(loaded?.artifactSnapshot).toBeUndefined();
    });

    it('does not treat trailing artifact side records as the conversation leaf', async () => {
      const now = Date.now();
      statSyncSpy.mockReturnValue({
        mtimeMs: now,
        isFile: () => true,
      } as fs.Stats);
      const artifactId = stableSessionArtifactId(
        sessionIdB,
        'url:https://example.com/trailing-report',
      );
      const artifactRecord: ChatRecord = {
        ...recordB2,
        uuid: 'artifact-tail',
        parentUuid: 'b2',
        type: 'system',
        subtype: 'session_artifact_event',
        message: undefined,
        systemPayload: {
          v: SESSION_ARTIFACT_PERSISTENCE_VERSION,
          sessionId: sessionIdB,
          sequence: 1,
          recordedAt: '2026-07-06T00:00:00.000Z',
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
                title: 'Trailing report',
                url: 'https://example.com/trailing-report',
                retention: 'restorable',
                clientRetained: true,
                createdAt: '2026-07-06T00:00:00.000Z',
                updatedAt: '2026-07-06T00:00:00.000Z',
                persistedAt: '2026-07-06T00:00:00.000Z',
              },
            },
          ],
        },
      };
      vi.mocked(jsonl.read).mockResolvedValue([
        recordB1,
        recordB2,
        artifactRecord,
      ]);

      const loaded = await sessionService.loadSession(sessionIdB);

      expect(
        loaded?.conversation.messages.map((record) => record.uuid),
      ).toEqual(['b1', 'b2']);
      expect(loaded?.lastCompletedUuid).toBe('b2');
      expect(loaded?.artifactSnapshot?.artifacts).toEqual([
        expect.objectContaining({
          id: artifactId,
          title: 'Trailing report',
        }),
      ]);
    });

    it('keeps the latest file history snapshot for a prompt id', async () => {
      const now = Date.now();
      statSyncSpy.mockReturnValue({
        mtimeMs: now,
        isFile: () => true,
      } as fs.Stats);

      const firstSnapshotRecord: ChatRecord = {
        ...recordB1,
        uuid: 's1',
        parentUuid: 'b1',
        type: 'system',
        subtype: 'file_history_snapshot',
        message: undefined,
        systemPayload: {
          snapshots: [
            {
              promptId: 'p1',
              timestamp: '2026-06-13T00:00:00.000Z',
              trackedFileBackups: {
                'a.txt': {
                  backupFileName: 'old-backup',
                  version: 1,
                  backupTime: '2026-06-13T00:00:01.000Z',
                },
              },
            },
          ],
        },
      };
      const updatedSnapshotRecord: ChatRecord = {
        ...recordB1,
        uuid: 's2',
        parentUuid: 's1',
        type: 'system',
        subtype: 'file_history_snapshot',
        message: undefined,
        systemPayload: {
          snapshots: [
            {
              promptId: 'p1',
              timestamp: '2026-06-13T00:01:00.000Z',
              trackedFileBackups: {
                'a.txt': {
                  backupFileName: 'updated-backup',
                  version: 2,
                  backupTime: '2026-06-13T00:01:01.000Z',
                },
              },
            },
          ],
        },
      };
      vi.mocked(jsonl.read).mockResolvedValue([
        recordB1,
        firstSnapshotRecord,
        updatedSnapshotRecord,
      ]);

      const loaded = await sessionService.loadSession(sessionIdB);

      expect(loaded?.fileHistorySnapshots).toEqual([
        {
          promptId: 'p1',
          timestamp: new Date('2026-06-13T00:01:00.000Z'),
          trackedFileBackups: {
            'a.txt': {
              backupFileName: 'updated-backup',
              version: 2,
              backupTime: new Date('2026-06-13T00:01:01.000Z'),
              failed: undefined,
            },
          },
        },
      ]);
    });

    it('ignores file history snapshots on a rewound inactive branch', async () => {
      statSyncSpy.mockReturnValue({
        mtimeMs: Date.now(),
        isFile: () => true,
      } as fs.Stats);

      const staleSnapshotRecord: ChatRecord = {
        ...recordB1,
        uuid: 'stale-snapshot',
        parentUuid: 'b1',
        type: 'system',
        subtype: 'file_history_snapshot',
        message: undefined,
        systemPayload: {
          snapshots: [
            {
              promptId: 'p1',
              timestamp: '2026-06-13T00:00:00.000Z',
              trackedFileBackups: {
                'a.txt': {
                  backupFileName: 'stale-backup',
                  version: 1,
                  backupTime: '2026-06-13T00:00:01.000Z',
                },
              },
            },
          ],
        },
      };
      const rewindRecord: ChatRecord = {
        ...recordB1,
        uuid: 'rewind',
        parentUuid: 'b1',
        type: 'system',
        subtype: 'rewind',
        message: undefined,
        systemPayload: { truncatedCount: 1 },
      };
      const survivingSnapshotRecord: ChatRecord = {
        ...recordB1,
        uuid: 'surviving-snapshot',
        parentUuid: 'rewind',
        type: 'system',
        subtype: 'file_history_snapshot',
        message: undefined,
        systemPayload: {
          snapshots: [
            {
              promptId: 'p1',
              timestamp: '2026-06-13T00:01:00.000Z',
              trackedFileBackups: {
                'a.txt': {
                  backupFileName: 'surviving-backup',
                  version: 2,
                  backupTime: '2026-06-13T00:01:01.000Z',
                },
              },
            },
          ],
        },
      };
      vi.mocked(jsonl.read).mockResolvedValue([
        recordB1,
        staleSnapshotRecord,
        rewindRecord,
        survivingSnapshotRecord,
      ]);

      const loaded = await sessionService.loadSession(sessionIdB);

      expect(loaded?.fileHistorySnapshots).toEqual([
        {
          promptId: 'p1',
          timestamp: new Date('2026-06-13T00:01:00.000Z'),
          trackedFileBackups: {
            'a.txt': {
              backupFileName: 'surviving-backup',
              version: 2,
              backupTime: new Date('2026-06-13T00:01:01.000Z'),
              failed: undefined,
            },
          },
        },
      ]);
    });

    it('leaves file history snapshots undefined when none are recorded', async () => {
      const now = Date.now();
      statSyncSpy.mockReturnValue({
        mtimeMs: now,
        isFile: () => true,
      } as fs.Stats);
      vi.mocked(jsonl.read).mockResolvedValue([recordB1, recordB2]);

      const loaded = await sessionService.loadSession(sessionIdB);

      expect(loaded?.fileHistorySnapshots).toBeUndefined();
    });

    it('skips malformed file history snapshot records and keeps later valid ones', async () => {
      const now = Date.now();
      statSyncSpy.mockReturnValue({
        mtimeMs: now,
        isFile: () => true,
      } as fs.Stats);

      const malformedSnapshotRecord = {
        ...recordB1,
        uuid: 'bad-snapshot',
        parentUuid: 'b1',
        type: 'system',
        subtype: 'file_history_snapshot',
        message: undefined,
        systemPayload: {
          snapshots: [
            {
              promptId: 'bad',
              timestamp: 'not-enough-fields',
            },
          ],
        },
      } as unknown as ChatRecord;
      const validSnapshotRecord: ChatRecord = {
        ...recordB1,
        uuid: 'good-snapshot',
        parentUuid: 'bad-snapshot',
        type: 'system',
        subtype: 'file_history_snapshot',
        message: undefined,
        systemPayload: {
          snapshots: [
            {
              promptId: 'p1',
              timestamp: '2026-06-13T00:00:00.000Z',
              trackedFileBackups: {
                'a.txt': {
                  backupFileName: 'backup-a',
                  version: 1,
                  backupTime: '2026-06-13T00:00:01.000Z',
                },
              },
            },
          ],
        },
      };
      vi.mocked(jsonl.read).mockResolvedValue([
        recordB1,
        malformedSnapshotRecord,
        validSnapshotRecord,
      ]);

      const loaded = await sessionService.loadSession(sessionIdB);

      expect(loaded?.fileHistorySnapshots).toEqual([
        {
          promptId: 'p1',
          timestamp: new Date('2026-06-13T00:00:00.000Z'),
          trackedFileBackups: {
            'a.txt': {
              backupFileName: 'backup-a',
              version: 1,
              backupTime: new Date('2026-06-13T00:00:01.000Z'),
              failed: undefined,
            },
          },
        },
      ]);
    });

    it('should return undefined when session file is empty', async () => {
      vi.mocked(jsonl.read).mockResolvedValue([]);

      const loaded = await sessionService.loadSession('nonexistent');

      expect(loaded).toBeUndefined();
    });

    it('should return undefined when session belongs to different project', async () => {
      const now = Date.now();
      statSyncSpy.mockReturnValue({
        mtimeMs: now,
        isFile: () => true,
      } as fs.Stats);

      const differentProjectRecord: ChatRecord = {
        ...recordA1,
        cwd: '/different/project',
      };
      vi.mocked(jsonl.read).mockResolvedValue([differentProjectRecord]);
      vi.mocked(getProjectHash).mockImplementation((cwd: string) =>
        cwd === '/test/project/root'
          ? 'test-project-hash'
          : 'other-project-hash',
      );

      const loaded = await sessionService.loadSession(sessionIdA);

      expect(loaded).toBeUndefined();
    });

    it('should load a migrated session when runtime status matches this project', async () => {
      const now = Date.now();
      statSyncSpy.mockReturnValue({
        mtimeMs: now,
        isFile: () => true,
      } as fs.Stats);

      const migratedRecord: ChatRecord = {
        ...recordA1,
        cwd: '/old/project',
      };
      vi.mocked(jsonl.read).mockResolvedValue([migratedRecord]);
      vi.mocked(readRuntimeStatus).mockResolvedValue({
        schemaVersion: 1,
        pid: 123,
        sessionId: sessionIdA,
        workDir: '/test/project/root',
        hostname: 'host',
        startedAt: 1,
        qwenVersion: null,
      });
      vi.mocked(getProjectHash).mockImplementation((cwd: string) =>
        cwd === '/test/project/root'
          ? 'test-project-hash'
          : 'other-project-hash',
      );

      const loaded = await sessionService.loadSession(sessionIdA);

      expect(loaded?.conversation.sessionId).toBe(sessionIdA);
      expect(loaded?.conversation.projectHash).toBe('test-project-hash');
    });

    it('should reconstruct tree-structured history correctly', async () => {
      const records: ChatRecord[] = [
        {
          uuid: 'r1',
          parentUuid: null,
          sessionId: 'test',
          timestamp: '2024-01-01T00:00:00Z',
          type: 'user',
          message: { role: 'user', parts: [{ text: 'First' }] },
          cwd: '/test/project/root',
          version: '1.0.0',
        },
        {
          uuid: 'r2',
          parentUuid: 'r1',
          sessionId: 'test',
          timestamp: '2024-01-01T00:01:00Z',
          type: 'assistant',
          message: { role: 'model', parts: [{ text: 'Second' }] },
          cwd: '/test/project/root',
          version: '1.0.0',
        },
        {
          uuid: 'r3',
          parentUuid: 'r2',
          sessionId: 'test',
          timestamp: '2024-01-01T00:02:00Z',
          type: 'user',
          message: { role: 'user', parts: [{ text: 'Third' }] },
          cwd: '/test/project/root',
          version: '1.0.0',
        },
      ];

      statSyncSpy.mockReturnValue({
        mtimeMs: Date.now(),
        isFile: () => true,
      } as fs.Stats);
      vi.mocked(jsonl.read).mockResolvedValue(records);

      const loaded = await sessionService.loadSession('test');

      expect(loaded?.conversation.messages).toHaveLength(3);
      expect(loaded?.conversation.messages.map((m) => m.uuid)).toEqual([
        'r1',
        'r2',
        'r3',
      ]);
    });

    it('should aggregate multiple records with same uuid', async () => {
      const records: ChatRecord[] = [
        {
          uuid: 'u1',
          parentUuid: null,
          sessionId: 'test',
          timestamp: '2024-01-01T00:00:00Z',
          type: 'user',
          message: { role: 'user', parts: [{ text: 'Hello' }] },
          cwd: '/test/project/root',
          version: '1.0.0',
        },
        // Multiple records for same assistant message
        {
          uuid: 'a1',
          parentUuid: 'u1',
          sessionId: 'test',
          timestamp: '2024-01-01T00:01:00Z',
          type: 'assistant',
          message: {
            role: 'model',
            parts: [{ thought: true, text: 'Thinking...' }],
          },
          cwd: '/test/project/root',
          version: '1.0.0',
        },
        {
          uuid: 'a1',
          parentUuid: 'u1',
          sessionId: 'test',
          timestamp: '2024-01-01T00:01:01Z',
          type: 'assistant',
          usageMetadata: {
            promptTokenCount: 10,
            candidatesTokenCount: 20,
            cachedContentTokenCount: 0,
            totalTokenCount: 30,
          },
          cwd: '/test/project/root',
          version: '1.0.0',
        },
        {
          uuid: 'a1',
          parentUuid: 'u1',
          sessionId: 'test',
          timestamp: '2024-01-01T00:01:02Z',
          type: 'assistant',
          message: { role: 'model', parts: [{ text: 'Response' }] },
          model: 'gemini-pro',
          cwd: '/test/project/root',
          version: '1.0.0',
        },
      ];

      statSyncSpy.mockReturnValue({
        mtimeMs: Date.now(),
        isFile: () => true,
      } as fs.Stats);
      vi.mocked(jsonl.read).mockResolvedValue(records);

      const loaded = await sessionService.loadSession('test');

      expect(loaded?.conversation.messages).toHaveLength(2);

      const assistantMsg = loaded?.conversation.messages[1];
      expect(assistantMsg?.uuid).toBe('a1');
      expect(assistantMsg?.message?.parts).toHaveLength(2);
      expect(assistantMsg?.usageMetadata?.totalTokenCount).toBe(30);
      expect(assistantMsg?.model).toBe('gemini-pro');
    });
  });

  describe('removeSession', () => {
    const lifecycleParent = {
      device: 7,
      inode: 9,
      inodeVerifiable: true,
    };

    it('should remove session file', async () => {
      vi.mocked(jsonl.readLines).mockResolvedValue([recordA1]);

      const result = await sessionService.removeSession(sessionIdA);

      expect(result).toBe(true);
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
      expect(rmSyncSpy).toHaveBeenCalledWith(
        expect.stringContaining(`file-history/${sessionIdA}`),
        { recursive: true, force: true },
      );
    });

    it('still deletes the session when the usage salvage fails', async () => {
      // Contract: the salvage must never block deletion.
      vi.mocked(prepareUsageBeforeTranscriptDeletion).mockRejectedValueOnce(
        new Error('salvage exploded'),
      );
      vi.mocked(jsonl.readLines).mockResolvedValue([recordA1]);

      await expect(sessionService.removeSession(sessionIdA)).resolves.toBe(
        true,
      );
      expect(unlinkSyncSpy).toHaveBeenCalled();
    });

    it('does not commit usage when a mutation fence rejects deletion', async () => {
      vi.mocked(jsonl.readLines).mockResolvedValue([recordA1]);
      const rejected = new Error('generation changed');

      await expect(
        sessionService.removeSession(sessionIdA, {
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
      const assertCanMutate = vi
        .fn()
        .mockImplementationOnce(() => undefined)
        .mockImplementation(() => {
          throw new Error('generation changed');
        });
      const assertCleanupOwned = vi.fn();
      const removeOrganizationSpy = vi
        .spyOn(SessionOrganizationService.prototype, 'removeSession')
        .mockImplementation(async (_sessionId, options) => {
          options?.assertCanCommit?.();
        });

      await expect(
        sessionService.removeSession(sessionIdA, {
          assertCanMutate,
          assertCleanupOwned,
        }),
      ).resolves.toBe(true);

      expect(assertCanMutate).toHaveBeenCalledOnce();
      expect(assertCleanupOwned).toHaveBeenCalledTimes(6);
      expect(removeOrganizationSpy).toHaveBeenCalledWith(sessionIdA, {
        assertCanCommit: assertCleanupOwned,
      });
      expect(rmSyncSpy).toHaveBeenCalledWith(
        expect.stringContaining(`file-history/${sessionIdA}`),
        { recursive: true, force: true },
      );
    });

    it('stops committed deletion cleanup after writer ownership is lost', async () => {
      vi.mocked(jsonl.readLines).mockResolvedValue([recordA1]);
      const ownershipLost = new Error('writer ownership lost');

      await expect(
        sessionService.removeSession(sessionIdA, {
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
      const unlinkError = Object.assign(new Error('permission denied'), {
        code: 'EACCES',
      });
      unlinkSyncSpy.mockImplementationOnce(() => {
        throw unlinkError;
      });

      await expect(sessionService.removeSession(sessionIdA)).rejects.toBe(
        unlinkError,
      );

      expect(prepareUsageBeforeTranscriptDeletion).toHaveBeenCalled();
      expect(commitUsageBeforeTranscriptDeletion).not.toHaveBeenCalled();
    });

    it('commits usage when a later transcript deletion fails', async () => {
      vi.mocked(jsonl.readLines).mockResolvedValue([recordA1]);
      existsSyncSpy.mockImplementation((filePath: fs.PathLike) =>
        filePath.toString().endsWith(`/chats/archive/${sessionIdA}.jsonl`),
      );
      const unlinkError = Object.assign(new Error('permission denied'), {
        code: 'EACCES',
      });
      unlinkSyncSpy
        .mockImplementationOnce(() => undefined)
        .mockImplementationOnce(() => {
          throw unlinkError;
        });

      await expect(sessionService.removeSession(sessionIdA)).rejects.toBe(
        unlinkError,
      );

      expect(unlinkSyncSpy).toHaveBeenCalledTimes(2);
      expect(commitUsageBeforeTranscriptDeletion).toHaveBeenCalledTimes(1);
      const commitOrder = vi.mocked(commitUsageBeforeTranscriptDeletion).mock
        .invocationCallOrder[0]!;
      expect(commitOrder).toBeGreaterThan(
        unlinkSyncSpy.mock.invocationCallOrder[0]!,
      );
      expect(commitOrder).toBeLessThan(
        unlinkSyncSpy.mock.invocationCallOrder[1]!,
      );
    });

    it('should clear session organization when removing a session', async () => {
      const warnings: string[] = [];
      sessionService = new SessionService('/test/project/root', {
        onWarning: (message) => warnings.push(message),
      });
      const removeOrganizationSpy = vi
        .spyOn(SessionOrganizationService.prototype, 'removeSession')
        .mockImplementation(function (this: {
          onWarning?: (message: string) => void;
        }) {
          this.onWarning?.('sidecar warning');
          return Promise.resolve();
        });
      vi.mocked(jsonl.readLines).mockResolvedValue([recordA1]);

      const result = await sessionService.removeSession(sessionIdA);

      expect(result).toBe(true);
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
      const differentProjectRecord: ChatRecord = {
        ...recordA1,
        cwd: '/different/project',
      };
      vi.mocked(jsonl.readLines).mockResolvedValue([differentProjectRecord]);
      vi.mocked(getProjectHash).mockImplementation((cwd: string) =>
        cwd === '/test/project/root'
          ? 'test-project-hash'
          : 'other-project-hash',
      );

      const result = await sessionService.removeSession(sessionIdA);

      expect(result).toBe(false);
      expect(unlinkSyncSpy).not.toHaveBeenCalled();
    });

    it('should remove a migrated session when runtime status matches this project', async () => {
      const migratedRecord: ChatRecord = {
        ...recordA1,
        cwd: '/old/project',
      };
      vi.mocked(jsonl.readLines).mockResolvedValue([migratedRecord]);
      vi.mocked(readRuntimeStatus).mockResolvedValue({
        schemaVersion: 1,
        pid: 123,
        sessionId: sessionIdA,
        workDir: '/test/project/root',
        hostname: 'host',
        startedAt: 1,
        qwenVersion: null,
      });
      vi.mocked(getProjectHash).mockImplementation((cwd: string) =>
        cwd === '/test/project/root'
          ? 'test-project-hash'
          : 'other-project-hash',
      );

      const result = await sessionService.removeSession(sessionIdA);

      expect(result).toBe(true);
      expect(unlinkSyncSpy).toHaveBeenCalled();
    });

    it('should handle file not found error', async () => {
      const error = new Error('ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      vi.mocked(jsonl.readLines).mockRejectedValue(error);

      const result = await sessionService.removeSession(
        '00000000-0000-0000-0000-000000000000',
      );

      expect(result).toBe(false);
    });

    it('should remove archived session files and both worktree sidecars', async () => {
      vi.mocked(jsonl.readLines).mockImplementation(
        async (filePath: string) => {
          if (filePath.includes('/chats/archive/')) return [recordA1];
          const error = new Error('ENOENT') as NodeJS.ErrnoException;
          error.code = 'ENOENT';
          throw error;
        },
      );
      existsSyncSpy.mockImplementation((filePath: fs.PathLike) =>
        filePath.toString().endsWith(`${sessionIdA}.worktree.json`),
      );

      const result = await sessionService.removeSession(sessionIdA);

      expect(result).toBe(true);
      expect(unlinkSyncSpy).toHaveBeenCalledWith(
        expect.stringContaining(`/chats/archive/${sessionIdA}.jsonl`),
      );
      expect(unlinkSyncSpy).toHaveBeenCalledWith(
        expect.stringContaining(`/chats/${sessionIdA}.worktree.json`),
      );
      expect(unlinkSyncSpy).toHaveBeenCalledWith(
        expect.stringContaining(`/chats/archive/${sessionIdA}.worktree.json`),
      );
    });

    it('should remove pr sidecars in both states when removing a session', async () => {
      vi.mocked(jsonl.readLines).mockImplementation(
        async (filePath: string) => {
          if (filePath.includes('/chats/archive/')) return [recordA1];
          const error = new Error('ENOENT') as NodeJS.ErrnoException;
          error.code = 'ENOENT';
          throw error;
        },
      );
      existsSyncSpy.mockImplementation((filePath: fs.PathLike) =>
        filePath.toString().endsWith(`${sessionIdA}.pr.json`),
      );

      const result = await sessionService.removeSession(sessionIdA);

      expect(result).toBe(true);
      expect(unlinkSyncSpy).toHaveBeenCalledWith(
        expect.stringContaining(`/chats/${sessionIdA}.pr.json`),
      );
      expect(unlinkSyncSpy).toHaveBeenCalledWith(
        expect.stringContaining(`/chats/archive/${sessionIdA}.pr.json`),
      );
    });

    it('should remove both JSONL files when active and archived copies conflict', async () => {
      vi.mocked(jsonl.readLines).mockResolvedValue([recordA1]);
      existsSyncSpy.mockImplementation((filePath: fs.PathLike) =>
        filePath.toString().endsWith(`/chats/archive/${sessionIdA}.jsonl`),
      );

      const result = await sessionService.removeSession(sessionIdA);

      expect(result).toBe(true);
      expect(unlinkSyncSpy).toHaveBeenCalledWith(
        expect.stringContaining(`/chats/${sessionIdA}.jsonl`),
      );
      expect(unlinkSyncSpy).toHaveBeenCalledWith(
        expect.stringContaining(`/chats/archive/${sessionIdA}.jsonl`),
      );
      // #7425 review follow-up: the archived copy's usage must be salvaged
      // before deletion too — with a telemetry-less fresh active copy it is
      // the only holder of the session's history. Pin the call so removing
      // the "redundant-looking" archived salvage fails this test.
      expect(
        vi.mocked(prepareUsageBeforeTranscriptDeletion),
      ).toHaveBeenCalledWith(
        expect.stringContaining(`/chats/archive/${sessionIdA}.jsonl`),
      );
    });

    it('should remove prompt ledger sidecars in both archive states', async () => {
      vi.mocked(jsonl.readLines).mockImplementation(
        async (filePath: string) => {
          if (filePath.includes('/chats/archive/')) return [recordA1];
          const error = new Error('ENOENT') as NodeJS.ErrnoException;
          error.code = 'ENOENT';
          throw error;
        },
      );
      existsSyncSpy.mockImplementation((filePath: fs.PathLike) =>
        filePath.toString().endsWith(`${sessionIdA}.ledger.jsonl`),
      );

      const result = await sessionService.removeSession(sessionIdA);

      expect(result).toBe(true);
      expect(unlinkSyncSpy).toHaveBeenCalledWith(
        expect.stringContaining(`/chats/${sessionIdA}.ledger.jsonl`),
      );
      expect(unlinkSyncSpy).toHaveBeenCalledWith(
        expect.stringContaining(`/chats/archive/${sessionIdA}.ledger.jsonl`),
      );
    });

    it('can commit only the active transcript for lifecycle deletion', async () => {
      vi.mocked(jsonl.readLines).mockImplementation(
        async (filePath: string) => {
          if (filePath.includes('/chats/archive/')) {
            const error = new Error('ENOENT') as NodeJS.ErrnoException;
            error.code = 'ENOENT';
            throw error;
          }
          return [recordA1];
        },
      );
      existsSyncSpy.mockReturnValue(true);
      const removeOrganizationSpy = vi.spyOn(
        SessionOrganizationService.prototype,
        'removeSession',
      );
      const sync = vi.fn(async () => undefined);
      const close = vi.fn(async () => undefined);
      const directoryStats = {
        dev: 7,
        ino: 9,
        isDirectory: () => true,
      } as fs.Stats;
      statPromiseSpy.mockResolvedValue(directoryStats);
      const open = vi.spyOn(fs.promises, 'open').mockResolvedValue({
        stat: vi.fn(async () => directoryStats),
        sync,
        close,
      } as unknown as fs.promises.FileHandle);

      const removed = await sessionService.removeSessionTranscriptForLifecycle(
        sessionIdA,
        'active',
        lifecycleParent,
      );

      expect(removed).toBe(true);
      expect(unlinkSyncSpy).toHaveBeenCalledTimes(1);
      expect(unlinkSyncSpy).toHaveBeenCalledWith(
        expect.stringContaining(`/chats/${sessionIdA}.jsonl`),
      );
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
      vi.mocked(jsonl.readLines).mockImplementation(
        async (filePath: string) => {
          if (filePath.includes('/chats/archive/')) {
            const error = new Error('ENOENT') as NodeJS.ErrnoException;
            error.code = 'ENOENT';
            throw error;
          }
          return [recordA1];
        },
      );
      existsSyncSpy.mockReturnValue(true);
      const syncError = Object.assign(new Error('sync failed'), {
        code: 'EIO',
      });
      const directoryStats = {
        dev: 7,
        ino: 9,
        isDirectory: () => true,
      } as fs.Stats;
      statPromiseSpy.mockResolvedValue(directoryStats);
      vi.spyOn(fs.promises, 'open').mockResolvedValue({
        stat: vi.fn(async () => directoryStats),
        sync: vi.fn(async () => Promise.reject(syncError)),
        close: vi.fn(async () => undefined),
      } as unknown as fs.promises.FileHandle);

      await expect(
        sessionService.removeSessionTranscriptForLifecycle(
          sessionIdA,
          'active',
          lifecycleParent,
        ),
      ).rejects.toMatchObject({
        name: 'SessionTranscriptDurabilityError',
        cause: syncError,
      } satisfies Partial<SessionTranscriptDurabilityError>);

      expect(unlinkSyncSpy).toHaveBeenCalledWith(
        expect.stringContaining(`/chats/${sessionIdA}.jsonl`),
      );
    });

    it('rejects lifecycle durability when the transcript parent is replaced after unlink', async () => {
      vi.mocked(jsonl.readLines).mockImplementation(
        async (filePath: string) => {
          if (filePath.includes('/chats/archive/')) {
            const error = new Error('ENOENT') as NodeJS.ErrnoException;
            error.code = 'ENOENT';
            throw error;
          }
          return [recordA1];
        },
      );
      existsSyncSpy.mockReturnValue(true);
      const original = {
        dev: 7,
        ino: 9,
        isDirectory: () => true,
      } as fs.Stats;
      const replacement = {
        dev: 7,
        ino: 10,
        isDirectory: () => true,
      } as fs.Stats;
      statPromiseSpy
        .mockResolvedValueOnce(original)
        .mockResolvedValueOnce(original)
        .mockResolvedValueOnce(replacement);
      vi.spyOn(fs.promises, 'open').mockResolvedValue({
        stat: vi.fn(async () => original),
        sync: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
      } as unknown as fs.promises.FileHandle);

      await expect(
        sessionService.removeSessionTranscriptForLifecycle(
          sessionIdA,
          'active',
          lifecycleParent,
        ),
      ).rejects.toBeInstanceOf(SessionTranscriptDurabilityError);

      expect(unlinkSyncSpy).toHaveBeenCalledOnce();
    });

    it('rejects recovery confirmation for a replacement transcript parent', async () => {
      const replacement = {
        dev: 7,
        ino: 10,
        isDirectory: () => true,
      } as fs.Stats;
      statPromiseSpy.mockResolvedValue(replacement);
      const sync = vi.fn(async () => undefined);
      vi.spyOn(fs.promises, 'open').mockResolvedValue({
        stat: vi.fn(async () => replacement),
        sync,
        close: vi.fn(async () => undefined),
      } as unknown as fs.promises.FileHandle);

      await expect(
        sessionService.confirmSessionTranscriptDeletionForLifecycle(
          'active',
          lifecycleParent,
        ),
      ).rejects.toBeInstanceOf(SessionTranscriptDurabilityError);

      expect(sync).not.toHaveBeenCalled();
    });

    it('does not hide lifecycle directory I/O failures on Windows', async () => {
      vi.mocked(jsonl.readLines).mockImplementation(
        async (filePath: string) => {
          if (filePath.includes('/chats/archive/')) {
            const error = new Error('ENOENT') as NodeJS.ErrnoException;
            error.code = 'ENOENT';
            throw error;
          }
          return [recordA1];
        },
      );
      existsSyncSpy.mockReturnValue(true);
      vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
      const directoryStats = {
        dev: 7,
        ino: 9,
        isDirectory: () => true,
      } as fs.Stats;
      statPromiseSpy.mockResolvedValue(directoryStats);
      const syncError = Object.assign(new Error('sync failed'), {
        code: 'EIO',
      });
      vi.spyOn(fs.promises, 'open').mockResolvedValue({
        stat: vi.fn(async () => directoryStats),
        sync: vi.fn(async () => Promise.reject(syncError)),
        close: vi.fn(async () => undefined),
      } as unknown as fs.promises.FileHandle);

      await expect(
        sessionService.removeSessionTranscriptForLifecycle(
          sessionIdA,
          'active',
          lifecycleParent,
        ),
      ).rejects.toMatchObject({ cause: syncError });
    });

    it('rejects lifecycle deletion when active and archived transcripts conflict', async () => {
      vi.mocked(jsonl.readLines).mockResolvedValue([recordA1]);

      await expect(
        sessionService.removeSessionTranscriptForLifecycle(
          sessionIdA,
          'active',
          lifecycleParent,
        ),
      ).rejects.toBeInstanceOf(SessionTranscriptChangedError);

      expect(prepareUsageBeforeTranscriptDeletion).not.toHaveBeenCalled();
      expect(unlinkSyncSpy).not.toHaveBeenCalled();
    });

    it('rejects lifecycle deletion when the transcript moved states', async () => {
      vi.mocked(jsonl.readLines).mockImplementation(
        async (filePath: string) => {
          if (!filePath.includes('/chats/archive/')) {
            const error = new Error('ENOENT') as NodeJS.ErrnoException;
            error.code = 'ENOENT';
            throw error;
          }
          return [recordA1];
        },
      );

      await expect(
        sessionService.removeSessionTranscriptForLifecycle(
          sessionIdA,
          'active',
          lifecycleParent,
        ),
      ).rejects.toBeInstanceOf(SessionTranscriptChangedError);

      expect(unlinkSyncSpy).not.toHaveBeenCalled();
    });

    it('cleans sidecars after the transcript is already absent', async () => {
      existsSyncSpy.mockImplementation((filePath: fs.PathLike) => {
        const value = filePath.toString();
        return (
          value.endsWith(`${sessionIdA}.worktree.json`) ||
          value.endsWith(`${sessionIdA}.pr.json`) ||
          value.endsWith(`${sessionIdA}.ledger.jsonl`)
        );
      });
      const removeOrganizationSpy = vi
        .spyOn(SessionOrganizationService.prototype, 'removeSession')
        .mockResolvedValue();

      await sessionService.cleanupRemovedSessionState(sessionIdA);

      expect(unlinkSyncSpy).toHaveBeenCalledWith(
        expect.stringContaining(`${sessionIdA}.worktree.json`),
      );
      expect(unlinkSyncSpy).toHaveBeenCalledWith(
        expect.stringContaining(`${sessionIdA}.pr.json`),
      );
      expect(unlinkSyncSpy).toHaveBeenCalledWith(
        expect.stringContaining(`${sessionIdA}.ledger.jsonl`),
      );
      expect(rmSyncSpy).toHaveBeenCalledWith(
        expect.stringContaining(`file-history/${sessionIdA}`),
        { recursive: true, force: true },
      );
      expect(removeOrganizationSpy).toHaveBeenCalledWith(sessionIdA);
    });

    it('durably confirms lifecycle sidecar cleanup before returning', async () => {
      const directoryStats = {
        dev: 7,
        ino: 9,
        isDirectory: () => true,
      } as fs.Stats;
      statPromiseSpy.mockResolvedValue(directoryStats);
      const sync = vi.fn(async () => undefined);
      const close = vi.fn(async () => undefined);
      const open = vi.spyOn(fs.promises, 'open').mockImplementation(
        async () =>
          ({
            stat: vi.fn(async () => directoryStats),
            sync,
            close,
          }) as unknown as fs.promises.FileHandle,
      );
      vi.spyOn(
        SessionOrganizationService.prototype,
        'removeSession',
      ).mockResolvedValue();

      await sessionService.cleanupRemovedSessionStateForLifecycle(sessionIdA);

      expect(open).toHaveBeenCalledTimes(4);
      expect(sync).toHaveBeenCalledTimes(4);
      expect(close).toHaveBeenCalledTimes(4);
    });

    it('rejects a replacement sidecar parent before lifecycle cleanup', async () => {
      const original = {
        dev: 7,
        ino: 9,
        isDirectory: () => true,
      } as fs.Stats;
      const replacement = {
        dev: 7,
        ino: 10,
        isDirectory: () => true,
      } as fs.Stats;
      statPromiseSpy
        .mockResolvedValueOnce(original)
        .mockResolvedValueOnce(original)
        .mockResolvedValueOnce(original)
        .mockResolvedValueOnce(original)
        .mockResolvedValueOnce(replacement);
      vi.spyOn(fs.promises, 'open').mockImplementation(
        async () =>
          ({
            stat: vi.fn(async () => original),
            sync: vi.fn(async () => undefined),
            close: vi.fn(async () => undefined),
          }) as unknown as fs.promises.FileHandle,
      );
      const removeOrganization = vi.spyOn(
        SessionOrganizationService.prototype,
        'removeSession',
      );

      await expect(
        sessionService.cleanupRemovedSessionStateForLifecycle(sessionIdA),
      ).rejects.toThrow('Session transcript parent directory changed.');

      expect(unlinkSyncSpy).not.toHaveBeenCalled();
      expect(rmSyncSpy).not.toHaveBeenCalled();
      expect(removeOrganization).not.toHaveBeenCalled();
    });

    it('rejects a vanished sidecar parent after opening it', async () => {
      const original = {
        dev: 7,
        ino: 9,
        isDirectory: () => true,
      } as fs.Stats;
      const vanished = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      statPromiseSpy.mockRejectedValueOnce(vanished);
      const close = vi.fn(async () => undefined);
      vi.spyOn(fs.promises, 'open').mockResolvedValue({
        stat: vi.fn(async () => original),
        sync: vi.fn(async () => undefined),
        close,
      } as unknown as fs.promises.FileHandle);
      const removeOrganization = vi.spyOn(
        SessionOrganizationService.prototype,
        'removeSession',
      );

      await expect(
        sessionService.cleanupRemovedSessionStateForLifecycle(sessionIdA),
      ).rejects.toBe(vanished);

      expect(close).toHaveBeenCalledOnce();
      expect(unlinkSyncSpy).not.toHaveBeenCalled();
      expect(rmSyncSpy).not.toHaveBeenCalled();
      expect(removeOrganization).not.toHaveBeenCalled();
    });

    it('surfaces lifecycle sidecar cleanup failures for retry', async () => {
      const cleanupError = new Error('organization cleanup failed');
      vi.spyOn(
        SessionOrganizationService.prototype,
        'removeSession',
      ).mockRejectedValue(cleanupError);

      await expect(
        sessionService.cleanupRemovedSessionState(sessionIdA),
      ).rejects.toBe(cleanupError);
    });
  });

  describe('archiveSessions', () => {
    beforeEach(() => {
      mkdirSyncSpy.mockImplementation(() => undefined);
    });

    const mockActiveSessionOnly = () => {
      vi.mocked(jsonl.readLines).mockImplementation(
        async (filePath: string) => {
          if (filePath.includes('/chats/archive/')) {
            const error = new Error('ENOENT') as NodeJS.ErrnoException;
            error.code = 'ENOENT';
            throw error;
          }
          return [recordA1];
        },
      );
    };

    const mockActiveWorktreeSidecarOnly = () => {
      existsSyncSpy.mockImplementation((filePath) => {
        const value = filePath.toString();
        if (value.endsWith(`/chats/archive/${sessionIdA}.jsonl`)) {
          return false;
        }
        if (value.endsWith(`/chats/${sessionIdA}.worktree.json`)) {
          return true;
        }
        if (value.endsWith(`/chats/archive/${sessionIdA}.worktree.json`)) {
          return false;
        }
        return false;
      });
    };

    it('should move active sessions into the archive directory', async () => {
      mockActiveSessionOnly();
      const result = await sessionService.archiveSessions([sessionIdA]);

      expect(result.archived).toEqual([sessionIdA]);
      expect(result.alreadyArchived).toEqual([]);
      expect(result.notFound).toEqual([]);
      expect(result.errors).toEqual([]);
      expect(mkdirSyncSpy).toHaveBeenCalledWith(
        expect.stringContaining('/chats/archive'),
        { recursive: true },
      );
      expect(renameSyncSpy).toHaveBeenCalledWith(
        expect.stringContaining(`/chats/${sessionIdA}.jsonl`),
        expect.stringContaining(`/chats/archive/${sessionIdA}.jsonl`),
      );
    });

    it('should move the pr sidecar into the archive directory', async () => {
      mockActiveSessionOnly();
      existsSyncSpy.mockImplementation((filePath) =>
        filePath.toString().endsWith(`/chats/${sessionIdA}.pr.json`),
      );

      const result = await sessionService.archiveSessions([sessionIdA]);

      expect(result.archived).toEqual([sessionIdA]);
      expect(result.errors).toEqual([]);
      expect(renameSyncSpy).toHaveBeenCalledWith(
        expect.stringContaining(`/chats/${sessionIdA}.pr.json`),
        expect.stringContaining(`/chats/archive/${sessionIdA}.pr.json`),
      );
    });

    it('should merge split pr sidecars on archive instead of wedging', async () => {
      mockActiveSessionOnly();
      existsSyncSpy.mockImplementation((filePath) => {
        const value = filePath.toString();
        return (
          value.endsWith(`/chats/${sessionIdA}.pr.json`) ||
          value.endsWith(`/chats/archive/${sessionIdA}.pr.json`)
        );
      });
      const archivedEntry = {
        number: 100,
        url: 'https://github.com/o/r/pull/100',
        createdAt: '2026-08-20T00:00:00.000Z',
      };
      const activeEntry = {
        number: 101,
        url: 'https://github.com/o/r/pull/101',
        createdAt: '2026-08-20T01:00:00.000Z',
      };
      vi.mocked(readSessionPrs)
        .mockResolvedValueOnce([archivedEntry])
        .mockResolvedValueOnce([activeEntry]);
      const warnings: string[] = [];
      const service = new SessionService('/test/project/root', {
        onWarning: (message) => warnings.push(message),
      });

      const result = await service.archiveSessions([sessionIdA]);

      expect(result.archived).toEqual([sessionIdA]);
      expect(result.errors).toEqual([]);
      expect(warnings).toEqual([]);
      expect(writeSessionPrs).toHaveBeenCalledWith(
        expect.stringContaining(`/chats/archive/${sessionIdA}.pr.json`),
        [archivedEntry, activeEntry],
      );
      expect(unlinkSyncSpy).toHaveBeenCalledWith(
        expect.stringContaining(`/chats/${sessionIdA}.pr.json`),
      );
    });

    it('passes cleanup ownership to an asynchronous pr-sidecar commit', async () => {
      mockActiveSessionOnly();
      existsSyncSpy.mockImplementation((filePath) => {
        const value = filePath.toString();
        return (
          value.endsWith(`/chats/${sessionIdA}.pr.json`) ||
          value.endsWith(`/chats/archive/${sessionIdA}.pr.json`)
        );
      });
      const entry = {
        number: 100,
        url: 'https://github.com/o/r/pull/100',
        createdAt: '2026-08-20T00:00:00.000Z',
      };
      vi.mocked(readSessionPrs)
        .mockResolvedValueOnce([entry])
        .mockResolvedValueOnce([entry]);
      const assertCanMutate = vi.fn();
      const assertCleanupOwned = vi.fn();

      const result = await sessionService.archiveSessions([sessionIdA], {
        assertCanMutate,
        assertCleanupOwned,
      });

      expect(result.errors).toEqual([]);
      expect(assertCanMutate).toHaveBeenCalledOnce();
      expect(writeSessionPrs).toHaveBeenCalledWith(
        expect.stringContaining(`/chats/archive/${sessionIdA}.pr.json`),
        [entry],
        { assertCanCommit: assertCleanupOwned },
      );
    });

    it('does not swallow writer ownership loss during a pr-sidecar commit', async () => {
      mockActiveSessionOnly();
      existsSyncSpy.mockImplementation((filePath) => {
        const value = filePath.toString();
        return (
          value.endsWith(`/chats/${sessionIdA}.pr.json`) ||
          value.endsWith(`/chats/archive/${sessionIdA}.pr.json`)
        );
      });
      const entry = {
        number: 100,
        url: 'https://github.com/o/r/pull/100',
        createdAt: '2026-08-20T00:00:00.000Z',
      };
      vi.mocked(readSessionPrs).mockResolvedValue([entry]);
      vi.mocked(writeSessionPrs).mockImplementation(
        async (_filePath, _entries, options) => {
          options?.assertCanCommit?.();
        },
      );
      const ownershipLost = new SessionWriterLostError();
      const assertCleanupOwned = vi
        .fn()
        .mockImplementationOnce(() => undefined)
        .mockImplementation(() => {
          throw ownershipLost;
        });

      const result = await sessionService.archiveSessions([sessionIdA], {
        assertCanMutate: vi.fn(),
        assertCleanupOwned,
      });

      expect(result.errors[0]?.error).toBe(ownershipLost);
      expect(assertCleanupOwned).toHaveBeenCalledTimes(2);
    });

    it('should archive JSONL and warn when archiving worktree sidecar fails', async () => {
      mockActiveSessionOnly();
      mockActiveWorktreeSidecarOnly();
      const warnings: string[] = [];
      const service = new SessionService('/test/project/root', {
        onWarning: (message) => warnings.push(message),
      });
      const sidecarError = new Error('sidecar move failed');
      renameSyncSpy.mockImplementation((sourcePath) => {
        if (sourcePath.toString().endsWith('.worktree.json')) {
          throw sidecarError;
        }
        return undefined;
      });

      const result = await service.archiveSessions([sessionIdA]);

      expect(result.archived).toEqual([sessionIdA]);
      expect(result.errors).toEqual([]);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(
        `archiveSessions: failed to move worktree sidecar for ${sessionIdA}`,
      );
      expect(renameSyncSpy).toHaveBeenCalledWith(
        expect.stringContaining(`/chats/${sessionIdA}.jsonl`),
        expect.stringContaining(`/chats/archive/${sessionIdA}.jsonl`),
      );
      expect(renameSyncSpy).toHaveBeenCalledWith(
        expect.stringContaining(`/chats/${sessionIdA}.worktree.json`),
        expect.stringContaining(`/chats/archive/${sessionIdA}.worktree.json`),
      );
    });

    it('finishes moving active sidecars after the generation closes', async () => {
      mockActiveSessionOnly();
      mockActiveWorktreeSidecarOnly();
      const generationChanged = new Error('generation changed');
      const assertCanMutate = vi
        .fn()
        .mockImplementationOnce(() => undefined)
        .mockImplementation(() => {
          throw generationChanged;
        });
      const assertCleanupOwned = vi.fn();

      const result = await sessionService.archiveSessions([sessionIdA], {
        assertCanMutate,
        assertCleanupOwned,
      });

      expect(result.archived).toEqual([sessionIdA]);
      expect(result.errors).toEqual([]);
      expect(assertCanMutate).toHaveBeenCalledOnce();
      expect(assertCleanupOwned).toHaveBeenCalled();
      expect(renameSyncSpy).toHaveBeenCalledWith(
        expect.stringContaining(`/chats/${sessionIdA}.jsonl`),
        expect.stringContaining(`/chats/archive/${sessionIdA}.jsonl`),
      );
      expect(renameSyncSpy).toHaveBeenCalledWith(
        expect.stringContaining(`/chats/${sessionIdA}.worktree.json`),
        expect.stringContaining(`/chats/archive/${sessionIdA}.worktree.json`),
      );
    });

    it('stops archive sidecar cleanup after writer ownership is lost', async () => {
      mockActiveSessionOnly();
      mockActiveWorktreeSidecarOnly();
      const ownershipLost = new Error('writer ownership lost');

      const result = await sessionService.archiveSessions([sessionIdA], {
        assertCanMutate: vi.fn(),
        assertCleanupOwned: () => {
          throw ownershipLost;
        },
      });

      expect(result.errors[0]?.error).toBe(ownershipLost);
      expect(renameSyncSpy).toHaveBeenCalledWith(
        expect.stringContaining(`/chats/${sessionIdA}.jsonl`),
        expect.stringContaining(`/chats/archive/${sessionIdA}.jsonl`),
      );
      expect(renameSyncSpy).not.toHaveBeenCalledWith(
        expect.stringContaining(`/chats/${sessionIdA}.worktree.json`),
        expect.anything(),
      );
    });

    it('should move the prompt ledger alongside the archived session', async () => {
      mockActiveSessionOnly();
      existsSyncSpy.mockImplementation((filePath) => {
        const value = filePath.toString();
        if (value.includes('/chats/archive/')) return false;
        return value.endsWith(`${sessionIdA}.ledger.jsonl`);
      });

      const result = await sessionService.archiveSessions([sessionIdA]);

      expect(result.archived).toEqual([sessionIdA]);
      expect(result.errors).toEqual([]);
      expect(renameSyncSpy).toHaveBeenCalledWith(
        expect.stringContaining(`/chats/${sessionIdA}.ledger.jsonl`),
        expect.stringContaining(`/chats/archive/${sessionIdA}.ledger.jsonl`),
      );
    });

    it('should warn but still archive when the prompt ledger move fails', async () => {
      mockActiveSessionOnly();
      existsSyncSpy.mockImplementation((filePath) => {
        const value = filePath.toString();
        if (value.includes('/chats/archive/')) return false;
        return value.endsWith(`${sessionIdA}.ledger.jsonl`);
      });
      const warnings: string[] = [];
      const service = new SessionService('/test/project/root', {
        onWarning: (message) => warnings.push(message),
      });
      const ledgerError = new Error('ledger move failed');
      renameSyncSpy.mockImplementation((sourcePath) => {
        if (sourcePath.toString().endsWith('.ledger.jsonl')) {
          throw ledgerError;
        }
        return undefined;
      });

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

    it('should merge the prompt ledger into an existing destination instead of wedging', async () => {
      mockActiveSessionOnly();
      const sourceLedger =
        '{"v":1,"promptId":"p1","state":"in_flight","at":1}\n';
      vi.spyOn(fs, 'readFileSync').mockReturnValue(sourceLedger);
      const appendFileSyncSpy = vi
        .spyOn(fs, 'appendFileSync')
        .mockImplementation(() => undefined);
      // Both the active and the archived ledger exist (e.g. a partially
      // completed earlier archive cycle): the merge path must run.
      existsSyncSpy.mockImplementation((filePath) =>
        filePath.toString().endsWith(`${sessionIdA}.ledger.jsonl`),
      );

      const result = await sessionService.archiveSessions([sessionIdA]);

      expect(result.archived).toEqual([sessionIdA]);
      expect(result.errors).toEqual([]);
      // Source records are concatenated onto the destination (append-only
      // JSONL, write order preserved)...
      expect(appendFileSyncSpy).toHaveBeenCalledWith(
        expect.stringContaining(`/chats/archive/${sessionIdA}.ledger.jsonl`),
        expect.stringContaining('"promptId":"p1"'),
        'utf8',
      );
      // ...the source sidecar is unlinked...
      expect(unlinkSyncSpy).toHaveBeenCalledWith(
        expect.stringContaining(`/chats/${sessionIdA}.ledger.jsonl`),
      );
      // ...and no rename was attempted for the ledger.
      expect(renameSyncSpy).not.toHaveBeenCalledWith(
        expect.stringContaining(`${sessionIdA}.ledger.jsonl`),
        expect.anything(),
      );
    });

    it('does not append a prompt ledger after writer ownership is lost', async () => {
      mockActiveSessionOnly();
      const sourceLedger =
        '{"v":1,"promptId":"p1","state":"in_flight","at":1}\n';
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
      existsSyncSpy.mockImplementation((filePath) =>
        filePath.toString().endsWith(`${sessionIdA}.ledger.jsonl`),
      );
      const ownershipLost = new SessionWriterLostError();
      const assertCleanupOwned = vi
        .fn()
        .mockImplementationOnce(() => undefined)
        .mockImplementationOnce(() => undefined)
        .mockImplementation(() => {
          throw ownershipLost;
        });

      const result = await sessionService.archiveSessions([sessionIdA], {
        assertCanMutate: vi.fn(),
        assertCleanupOwned,
      });

      expect(result.errors[0]?.error).toBe(ownershipLost);
      expect(destinationLedger).toBe(originalDestination);
      expect(sourceExists).toBe(true);
      expect(assertCleanupOwned).toHaveBeenCalledTimes(3);
    });

    it('should not move worktree sidecar when archiving JSONL fails', async () => {
      mockActiveSessionOnly();
      mockActiveWorktreeSidecarOnly();
      const jsonlError = new Error(
        `EACCES: permission denied, rename '/tmp/runtime/chats/${sessionIdA}.jsonl' -> '/tmp/runtime/chats/archive/${sessionIdA}.jsonl'`,
      ) as NodeJS.ErrnoException;
      jsonlError.code = 'EACCES';
      renameSyncSpy.mockImplementation((sourcePath) => {
        if (sourcePath.toString().endsWith('.jsonl')) {
          throw jsonlError;
        }
        return undefined;
      });

      const result = await sessionService.archiveSessions([sessionIdA]);

      expect(result.archived).toEqual([]);
      expect(result.errors[0]?.sessionId).toBe(sessionIdA);
      expect(result.errors[0]?.error.message).toBe(
        'Failed to archive session file: EACCES',
      );
      expect(result.errors[0]?.error.message).not.toContain('/tmp/runtime');
      expect(renameSyncSpy).toHaveBeenCalledWith(
        expect.stringContaining(`/chats/${sessionIdA}.jsonl`),
        expect.stringContaining(`/chats/archive/${sessionIdA}.jsonl`),
      );
      expect(renameSyncSpy).not.toHaveBeenCalledWith(
        expect.stringContaining(`/chats/${sessionIdA}.worktree.json`),
        expect.stringContaining(`/chats/archive/${sessionIdA}.worktree.json`),
      );
    });

    it('should archive known active sessions', async () => {
      mockActiveSessionOnly();

      const result = await sessionService.archiveSessions([sessionIdA], {
        knownLocation: 'active',
      });

      expect(result.archived).toEqual([sessionIdA]);
      expect(result.errors).toEqual([]);
      expect(renameSyncSpy).toHaveBeenCalledWith(
        expect.stringContaining(`/chats/${sessionIdA}.jsonl`),
        expect.stringContaining(`/chats/archive/${sessionIdA}.jsonl`),
      );
    });

    it('should report already archived sessions without moving them', async () => {
      vi.mocked(jsonl.readLines).mockImplementation(
        async (filePath: string) => {
          if (filePath.includes('/chats/archive/')) return [recordA1];
          const error = new Error('ENOENT') as NodeJS.ErrnoException;
          error.code = 'ENOENT';
          throw error;
        },
      );

      const result = await sessionService.archiveSessions([sessionIdA]);

      expect(result.archived).toEqual([]);
      expect(result.alreadyArchived).toEqual([sessionIdA]);
      expect(renameSyncSpy).not.toHaveBeenCalled();
    });

    it('should report active and archived duplicate ids as errors', async () => {
      vi.mocked(jsonl.readLines).mockResolvedValue([recordA1]);

      const result = await sessionService.archiveSessions([sessionIdA]);

      expect(result.archived).toEqual([]);
      expect(result.errors[0]?.sessionId).toBe(sessionIdA);
      expect(result.errors[0]?.error.message).toMatch(/conflict/i);
      expect(renameSyncSpy).not.toHaveBeenCalled();
    });

    it('does not commit usage when conflict repair is rejected', async () => {
      vi.mocked(jsonl.readLines).mockResolvedValue([recordA1]);

      const result = await sessionService.archiveSessions([sessionIdA], {
        resolveConflicts: true,
        assertCanMutate: () => {
          throw new Error('generation changed');
        },
      });

      expect(result.errors).toHaveLength(1);
      expect(prepareUsageBeforeTranscriptDeletion).not.toHaveBeenCalled();
      expect(commitUsageBeforeTranscriptDeletion).not.toHaveBeenCalled();
      expect(unlinkSyncSpy).not.toHaveBeenCalled();
    });

    it('does not persist a final usage snapshot during conflict repair', async () => {
      vi.mocked(jsonl.readLines).mockResolvedValue([recordA1]);

      const result = await sessionService.archiveSessions([sessionIdA], {
        resolveConflicts: true,
      });

      expect(result).toMatchObject({
        archived: [sessionIdA],
        resolvedConflicts: [sessionIdA],
        errors: [],
      });
      expect(prepareUsageBeforeTranscriptDeletion).not.toHaveBeenCalled();
      expect(commitUsageBeforeTranscriptDeletion).not.toHaveBeenCalled();
    });

    it('finishes archive conflict cleanup after the generation closes', async () => {
      vi.mocked(jsonl.readLines).mockResolvedValue([recordA1]);
      const assertCanMutate = vi
        .fn()
        .mockImplementationOnce(() => undefined)
        .mockImplementation(() => {
          throw new Error('generation changed');
        });
      const assertCleanupOwned = vi.fn();

      const result = await sessionService.archiveSessions([sessionIdA], {
        resolveConflicts: true,
        assertCanMutate,
        assertCleanupOwned,
      });

      expect(result).toMatchObject({
        archived: [sessionIdA],
        resolvedConflicts: [sessionIdA],
        errors: [],
      });
      expect(assertCanMutate).toHaveBeenCalledOnce();
      expect(assertCleanupOwned).toHaveBeenCalledTimes(3);
    });
  });

  describe('unarchiveSessions', () => {
    beforeEach(() => {
      mkdirSyncSpy.mockImplementation(() => undefined);
    });

    const mockArchivedSessionOnly = () => {
      vi.mocked(jsonl.readLines).mockImplementation(
        async (filePath: string) => {
          if (filePath.includes('/chats/archive/')) return [recordA1];
          const error = new Error('ENOENT') as NodeJS.ErrnoException;
          error.code = 'ENOENT';
          throw error;
        },
      );
    };

    const mockArchivedWorktreeSidecarOnly = () => {
      existsSyncSpy.mockImplementation((filePath) => {
        const value = filePath.toString();
        if (value.endsWith(`/chats/${sessionIdA}.jsonl`)) {
          return false;
        }
        if (value.endsWith(`/chats/archive/${sessionIdA}.worktree.json`)) {
          return true;
        }
        if (value.endsWith(`/chats/${sessionIdA}.worktree.json`)) {
          return false;
        }
        return false;
      });
    };

    it('should move archived sessions back to the active directory', async () => {
      mockArchivedSessionOnly();

      const result = await sessionService.unarchiveSessions([sessionIdA]);

      expect(result.unarchived).toEqual([sessionIdA]);
      expect(result.alreadyActive).toEqual([]);
      expect(result.notFound).toEqual([]);
      expect(result.errors).toEqual([]);
      expect(renameSyncSpy).toHaveBeenCalledWith(
        expect.stringContaining(`/chats/archive/${sessionIdA}.jsonl`),
        expect.stringContaining(`/chats/${sessionIdA}.jsonl`),
      );
    });

    it('should move the pr sidecar back to the active directory', async () => {
      mockArchivedSessionOnly();
      existsSyncSpy.mockImplementation((filePath) =>
        filePath.toString().endsWith(`/chats/archive/${sessionIdA}.pr.json`),
      );

      const result = await sessionService.unarchiveSessions([sessionIdA]);

      expect(result.unarchived).toEqual([sessionIdA]);
      expect(result.errors).toEqual([]);
      expect(renameSyncSpy).toHaveBeenCalledWith(
        expect.stringContaining(`/chats/archive/${sessionIdA}.pr.json`),
        expect.stringContaining(`/chats/${sessionIdA}.pr.json`),
      );
    });

    it('should merge a split pr sidecar pair on unarchive, keeping the full history', async () => {
      mockArchivedSessionOnly();
      existsSyncSpy.mockImplementation((filePath) => {
        const value = filePath.toString();
        return (
          value.endsWith(`/chats/archive/${sessionIdA}.pr.json`) ||
          value.endsWith(`/chats/${sessionIdA}.pr.json`)
        );
      });
      const olderOne = {
        number: 100,
        url: 'https://github.com/o/r/pull/100',
        createdAt: '2026-08-20T00:00:00.000Z',
      };
      const olderTwo = {
        number: 101,
        url: 'https://github.com/o/r/pull/101',
        createdAt: '2026-08-20T00:30:00.000Z',
      };
      const orphan = {
        number: 102,
        url: 'https://github.com/o/r/pull/102',
        createdAt: '2026-08-20T01:00:00.000Z',
      };
      vi.mocked(readSessionPrs)
        .mockResolvedValueOnce([orphan])
        .mockResolvedValueOnce([olderOne, olderTwo]);
      const warnings: string[] = [];
      const service = new SessionService('/test/project/root', {
        onWarning: (message) => warnings.push(message),
      });

      const result = await service.unarchiveSessions([sessionIdA]);

      expect(result.unarchived).toEqual([sessionIdA]);
      expect(result.errors).toEqual([]);
      expect(warnings).toEqual([]);
      expect(writeSessionPrs).toHaveBeenCalledWith(
        expect.stringContaining(`/chats/${sessionIdA}.pr.json`),
        [olderOne, olderTwo, orphan],
      );
      expect(unlinkSyncSpy).toHaveBeenCalledWith(
        expect.stringContaining(`/chats/archive/${sessionIdA}.pr.json`),
      );
    });

    it('should unarchive known archived sessions', async () => {
      mockArchivedSessionOnly();

      const result = await sessionService.unarchiveSessions([sessionIdA], {
        knownLocation: 'archived',
      });

      expect(result.unarchived).toEqual([sessionIdA]);
      expect(result.errors).toEqual([]);
      expect(renameSyncSpy).toHaveBeenCalledWith(
        expect.stringContaining(`/chats/archive/${sessionIdA}.jsonl`),
        expect.stringContaining(`/chats/${sessionIdA}.jsonl`),
      );
    });

    it('does not commit usage when conflict repair is rejected', async () => {
      vi.mocked(jsonl.readLines).mockResolvedValue([recordA1]);

      const result = await sessionService.unarchiveSessions([sessionIdA], {
        resolveConflicts: true,
        assertCanMutate: () => {
          throw new Error('generation changed');
        },
      });

      expect(result.errors).toHaveLength(1);
      expect(prepareUsageBeforeTranscriptDeletion).not.toHaveBeenCalled();
      expect(commitUsageBeforeTranscriptDeletion).not.toHaveBeenCalled();
      expect(unlinkSyncSpy).not.toHaveBeenCalled();
    });

    it('does not persist a final usage snapshot for the retained active copy', async () => {
      vi.mocked(jsonl.readLines).mockResolvedValue([recordA1]);

      const result = await sessionService.unarchiveSessions([sessionIdA], {
        resolveConflicts: true,
      });

      expect(result).toMatchObject({
        unarchived: [sessionIdA],
        resolvedConflicts: [sessionIdA],
        errors: [],
      });
      expect(prepareUsageBeforeTranscriptDeletion).not.toHaveBeenCalled();
      expect(commitUsageBeforeTranscriptDeletion).not.toHaveBeenCalled();
    });

    it('finishes unarchive conflict cleanup after the generation closes', async () => {
      vi.mocked(jsonl.readLines).mockResolvedValue([recordA1]);
      const assertCanMutate = vi
        .fn()
        .mockImplementationOnce(() => undefined)
        .mockImplementation(() => {
          throw new Error('generation changed');
        });
      const assertCleanupOwned = vi.fn();

      const result = await sessionService.unarchiveSessions([sessionIdA], {
        resolveConflicts: true,
        assertCanMutate,
        assertCleanupOwned,
      });

      expect(result).toMatchObject({
        unarchived: [sessionIdA],
        resolvedConflicts: [sessionIdA],
        errors: [],
      });
      expect(assertCanMutate).toHaveBeenCalledOnce();
      expect(assertCleanupOwned).toHaveBeenCalledTimes(3);
    });

    it('should recreate active chats directory before moving archived sessions', async () => {
      mockArchivedSessionOnly();

      const result = await sessionService.unarchiveSessions([sessionIdA]);

      expect(result.unarchived).toEqual([sessionIdA]);
      expect(mkdirSyncSpy).toHaveBeenCalledWith(
        expect.stringMatching(/\/chats$/),
        { recursive: true },
      );
      expect(renameSyncSpy).toHaveBeenCalledWith(
        expect.stringContaining(`/chats/archive/${sessionIdA}.jsonl`),
        expect.stringContaining(`/chats/${sessionIdA}.jsonl`),
      );
    });

    it('should report not found when neither active nor archived file exists', async () => {
      vi.mocked(jsonl.readLines).mockImplementation(async () => {
        const error = new Error('ENOENT') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      });

      const result = await sessionService.unarchiveSessions([sessionIdA]);

      expect(result.unarchived).toEqual([]);
      expect(result.alreadyActive).toEqual([]);
      expect(result.notFound).toEqual([sessionIdA]);
      expect(result.errors).toEqual([]);
      expect(renameSyncSpy).not.toHaveBeenCalled();
    });

    it('should report already active sessions without moving them', async () => {
      vi.mocked(jsonl.readLines).mockImplementation(
        async (filePath: string) => {
          if (filePath.includes('/chats/archive/')) {
            const error = new Error('ENOENT') as NodeJS.ErrnoException;
            error.code = 'ENOENT';
            throw error;
          }
          return [recordA1];
        },
      );

      const result = await sessionService.unarchiveSessions([sessionIdA]);

      expect(result.unarchived).toEqual([]);
      expect(result.alreadyActive).toEqual([sessionIdA]);
      expect(result.notFound).toEqual([]);
      expect(result.errors).toEqual([]);
      expect(renameSyncSpy).not.toHaveBeenCalled();
    });

    it('should unarchive JSONL and warn when worktree sidecar move fails', async () => {
      mockArchivedSessionOnly();
      mockArchivedWorktreeSidecarOnly();
      const warnings: string[] = [];
      const service = new SessionService('/test/project/root', {
        onWarning: (message) => warnings.push(message),
      });
      const sidecarError = new Error('sidecar move failed');
      renameSyncSpy.mockImplementation((sourcePath) => {
        if (sourcePath.toString().endsWith('.worktree.json')) {
          throw sidecarError;
        }
        return undefined;
      });

      const result = await service.unarchiveSessions([sessionIdA]);

      expect(result.unarchived).toEqual([sessionIdA]);
      expect(result.errors).toEqual([]);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(
        `unarchiveSessions: failed to move worktree sidecar for ${sessionIdA}`,
      );
      expect(renameSyncSpy).toHaveBeenCalledWith(
        expect.stringContaining(`/chats/archive/${sessionIdA}.jsonl`),
        expect.stringContaining(`/chats/${sessionIdA}.jsonl`),
      );
      expect(renameSyncSpy).toHaveBeenCalledWith(
        expect.stringContaining(`/chats/archive/${sessionIdA}.worktree.json`),
        expect.stringContaining(`/chats/${sessionIdA}.worktree.json`),
      );
    });

    it('finishes moving archived sidecars after the generation closes', async () => {
      mockArchivedSessionOnly();
      mockArchivedWorktreeSidecarOnly();
      const generationChanged = new Error('generation changed');
      const assertCanMutate = vi
        .fn()
        .mockImplementationOnce(() => undefined)
        .mockImplementation(() => {
          throw generationChanged;
        });
      const assertCleanupOwned = vi.fn();

      const result = await sessionService.unarchiveSessions([sessionIdA], {
        assertCanMutate,
        assertCleanupOwned,
      });

      expect(result.unarchived).toEqual([sessionIdA]);
      expect(result.errors).toEqual([]);
      expect(assertCanMutate).toHaveBeenCalledOnce();
      expect(assertCleanupOwned).toHaveBeenCalled();
      expect(renameSyncSpy).toHaveBeenCalledWith(
        expect.stringContaining(`/chats/archive/${sessionIdA}.jsonl`),
        expect.stringContaining(`/chats/${sessionIdA}.jsonl`),
      );
      expect(renameSyncSpy).toHaveBeenCalledWith(
        expect.stringContaining(`/chats/archive/${sessionIdA}.worktree.json`),
        expect.stringContaining(`/chats/${sessionIdA}.worktree.json`),
      );
    });

    it('stops unarchive sidecar cleanup after writer ownership is lost', async () => {
      mockArchivedSessionOnly();
      mockArchivedWorktreeSidecarOnly();
      const ownershipLost = new Error('writer ownership lost');

      const result = await sessionService.unarchiveSessions([sessionIdA], {
        assertCanMutate: vi.fn(),
        assertCleanupOwned: () => {
          throw ownershipLost;
        },
      });

      expect(result.errors[0]?.error).toBe(ownershipLost);
      expect(renameSyncSpy).toHaveBeenCalledWith(
        expect.stringContaining(`/chats/archive/${sessionIdA}.jsonl`),
        expect.stringContaining(`/chats/${sessionIdA}.jsonl`),
      );
      expect(renameSyncSpy).not.toHaveBeenCalledWith(
        expect.stringContaining(`/chats/archive/${sessionIdA}.worktree.json`),
        expect.anything(),
      );
    });

    it('should move the prompt ledger back to the active directory when unarchiving', async () => {
      mockArchivedSessionOnly();
      existsSyncSpy.mockImplementation((filePath) => {
        const value = filePath.toString();
        if (value.endsWith(`/chats/${sessionIdA}.jsonl`)) return false;
        if (value.endsWith(`${sessionIdA}.ledger.jsonl`)) {
          return value.includes('/chats/archive/');
        }
        return false;
      });

      const result = await sessionService.unarchiveSessions([sessionIdA]);

      expect(result.unarchived).toEqual([sessionIdA]);
      expect(result.errors).toEqual([]);
      expect(renameSyncSpy).toHaveBeenCalledWith(
        expect.stringContaining(`/chats/archive/${sessionIdA}.ledger.jsonl`),
        expect.stringContaining(`/chats/${sessionIdA}.ledger.jsonl`),
      );
    });

    it('should not move worktree sidecar when unarchiving JSONL fails', async () => {
      mockArchivedSessionOnly();
      mockArchivedWorktreeSidecarOnly();
      const jsonlError = new Error(
        `ENOSPC: no space left on device, rename '/tmp/runtime/chats/archive/${sessionIdA}.jsonl' -> '/tmp/runtime/chats/${sessionIdA}.jsonl'`,
      ) as NodeJS.ErrnoException;
      jsonlError.code = 'ENOSPC';
      renameSyncSpy.mockImplementation((sourcePath) => {
        if (
          sourcePath.toString().endsWith('.jsonl') &&
          sourcePath.toString().includes('/chats/archive/')
        ) {
          throw jsonlError;
        }
        return undefined;
      });

      const result = await sessionService.unarchiveSessions([sessionIdA]);

      expect(result.unarchived).toEqual([]);
      expect(result.errors[0]?.sessionId).toBe(sessionIdA);
      expect(result.errors[0]?.error.message).toBe(
        'Failed to unarchive session file: ENOSPC',
      );
      expect(result.errors[0]?.error.message).not.toContain('/tmp/runtime');
      expect(renameSyncSpy).toHaveBeenCalledWith(
        expect.stringContaining(`/chats/archive/${sessionIdA}.jsonl`),
        expect.stringContaining(`/chats/${sessionIdA}.jsonl`),
      );
      expect(renameSyncSpy).not.toHaveBeenCalledWith(
        expect.stringContaining(`/chats/archive/${sessionIdA}.worktree.json`),
        expect.stringContaining(`/chats/${sessionIdA}.worktree.json`),
      );
    });

    it('should reject unarchive when active and archived files both exist', async () => {
      vi.mocked(jsonl.readLines).mockResolvedValue([recordA1]);

      const result = await sessionService.unarchiveSessions([sessionIdA]);

      expect(result.unarchived).toEqual([]);
      expect(result.errors[0]?.sessionId).toBe(sessionIdA);
      expect(result.errors[0]?.error.message).toMatch(/conflict/i);
      expect(renameSyncSpy).not.toHaveBeenCalled();
    });
  });

  describe('removeSessions', () => {
    it('should remove multiple sessions and report each outcome', async () => {
      const removeOrganizationsSpy = vi
        .spyOn(SessionOrganizationService.prototype, 'removeSessions')
        .mockResolvedValue();
      // recordA1 belongs to current project; recordB1 also; the third id
      // never has a backing record (notFound).
      vi.mocked(jsonl.readLines).mockImplementation(
        async (filePath: string) => {
          if (filePath.includes('/chats/archive/')) {
            const error = new Error('ENOENT') as NodeJS.ErrnoException;
            error.code = 'ENOENT';
            throw error;
          }
          if (filePath.includes(sessionIdA)) return [recordA1];
          if (filePath.includes(sessionIdB)) return [recordB1];
          return [];
        },
      );

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
      vi.mocked(jsonl.readLines).mockImplementation(
        async (filePath: string) => {
          if (filePath.includes('/chats/archive/')) {
            const error = new Error('ENOENT') as NodeJS.ErrnoException;
            error.code = 'ENOENT';
            throw error;
          }
          return [recordA1];
        },
      );

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
      vi.mocked(jsonl.readLines).mockImplementation(
        async (filePath: string) => {
          if (filePath.includes('/chats/archive/')) {
            const error = new Error('ENOENT') as NodeJS.ErrnoException;
            error.code = 'ENOENT';
            throw error;
          }
          if (filePath.includes(sessionIdA)) return [recordA1];
          if (filePath.includes(sessionIdB)) return [recordB1];
          return [];
        },
      );

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
    // The lazy counter that replaces the per-file readline scan from
    // listSessions. Four contracts to pin: it actually counts what it
    // promises, it short-circuits on bad input without touching the disk,
    // it returns 0 on any read failure (caller must not see an exception
    // bubble up — the picker treats 0 as "unknown"), and it scopes to
    // the current project (mirroring deleteSession/renameSession's
    // first-record cwd check).

    const stubCreateReadStream = (
      lines: string[],
    ): MockInstance<typeof fs.createReadStream> =>
      vi
        .spyOn(fs, 'createReadStream')
        .mockImplementation(
          () => Readable.from([lines.join('\n')]) as unknown as fs.ReadStream,
        );

    it('should count unique user/assistant uuids and ignore other record types', async () => {
      // Project scoping reads the first record before the count stream;
      // give it a record from this project so the count proceeds.
      vi.mocked(jsonl.readLines).mockResolvedValue([recordA1]);
      // Real countSessionMessagesFromPath routes each line through
      // parseLineTolerant. The default mock is a no-op; for this test we
      // need it to actually decode the JSON so the uuid set is populated.
      vi.mocked(jsonl.parseLineTolerant).mockImplementation((line) => {
        try {
          const parsed = JSON.parse(line);
          return Array.isArray(parsed) ? parsed : [parsed];
        } catch {
          return [];
        }
      });
      const lines = [
        // Two user records sharing a uuid — should be counted once
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
      ];
      const createReadStreamSpy = stubCreateReadStream(lines);

      const count = await sessionService.countSessionMessages(sessionIdA);

      expect(count).toBe(3); // u1, a1, u2
      expect(createReadStreamSpy).toHaveBeenCalledTimes(1);
    });

    it('should return 0 for invalid sessionId without touching the filesystem', async () => {
      const createReadStreamSpy = vi.spyOn(fs, 'createReadStream');

      const count = await sessionService.countSessionMessages('not-a-uuid');

      expect(count).toBe(0);
      expect(createReadStreamSpy).not.toHaveBeenCalled();
    });

    it('should return 0 when the session file is missing (ENOENT)', async () => {
      // The first-record read fires before the count stream, so simulate
      // ENOENT there too — readLines surfaces it as a thrown error.
      vi.mocked(jsonl.readLines).mockRejectedValue(
        Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
      );

      const count = await sessionService.countSessionMessages(sessionIdA);

      expect(count).toBe(0);
    });

    it('should return 0 when the session belongs to a different project', async () => {
      // A valid session ID can exist in the shared chats directory while
      // its first-record cwd hashes to a different project. Lazy-count
      // callers must not bypass project scoping.
      const otherProjectRecord: ChatRecord = {
        ...recordA1,
        cwd: '/some/other/project',
      };
      vi.mocked(jsonl.readLines).mockResolvedValue([otherProjectRecord]);
      // Make the projectHash mock context-sensitive so the cwd check
      // actually distinguishes projects.
      vi.mocked(getProjectHash).mockImplementation((cwd) =>
        cwd === '/test/project/root' ? 'test-project-hash' : 'other-hash',
      );
      const createReadStreamSpy = vi.spyOn(fs, 'createReadStream');

      const count = await sessionService.countSessionMessages(sessionIdA);

      expect(count).toBe(0);
      // No streaming pass should have started — the project check
      // short-circuits before the expensive part.
      expect(createReadStreamSpy).not.toHaveBeenCalled();
    });

    it('should count a migrated session when runtime status matches this project', async () => {
      const migratedRecord: ChatRecord = {
        ...recordA1,
        cwd: '/old/project',
      };
      vi.mocked(jsonl.readLines).mockResolvedValue([migratedRecord]);
      vi.mocked(readRuntimeStatus).mockResolvedValue({
        schemaVersion: 1,
        pid: 123,
        sessionId: sessionIdA,
        workDir: '/test/project/root',
        hostname: 'host',
        startedAt: 1,
        qwenVersion: null,
      });
      vi.mocked(getProjectHash).mockImplementation((cwd) =>
        cwd === '/test/project/root' ? 'test-project-hash' : 'other-hash',
      );
      vi.mocked(jsonl.parseLineTolerant).mockImplementation((line) => [
        JSON.parse(line),
      ]);
      const createReadStreamSpy = stubCreateReadStream([
        JSON.stringify({ uuid: 'u1', type: 'user' }),
        JSON.stringify({ uuid: 'a1', type: 'assistant' }),
      ]);

      const count = await sessionService.countSessionMessages(sessionIdA);

      expect(count).toBe(2);
      expect(createReadStreamSpy).toHaveBeenCalledTimes(1);
    });

    it('should return 0 when the session file has no records (empty file)', async () => {
      vi.mocked(jsonl.readLines).mockResolvedValue([]);
      const createReadStreamSpy = vi.spyOn(fs, 'createReadStream');

      const count = await sessionService.countSessionMessages(sessionIdA);

      expect(count).toBe(0);
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
      const warnings: string[] = [];
      const service = new SessionService('/test/project/root', {
        onWarning: (message) => warnings.push(message),
      });
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

    beforeEach(() => {
      readdirSpy = vi
        .spyOn(fs.promises, 'readdir')
        .mockResolvedValue([] as never);
    });

    it('finds a legacy mixed-case transcript', async () => {
      const legacySessionId = sessionIdA.toUpperCase();
      readdirSpy
        .mockResolvedValueOnce([`${legacySessionId}.jsonl`] as never)
        .mockResolvedValueOnce([] as never);
      vi.spyOn(sessionService, 'getSessionLocation').mockImplementation(
        async (sessionId) =>
          sessionId === legacySessionId ? 'active' : undefined,
      );

      await expect(
        sessionService.findSessionIdIgnoringCase(sessionIdA),
      ).resolves.toBe(legacySessionId);
    });

    it('returns the single authoritative spelling after scanning both states', async () => {
      const legacySessionId = sessionIdA.toUpperCase();
      readdirSpy
        .mockResolvedValueOnce([] as never)
        .mockResolvedValueOnce([`${legacySessionId}.jsonl`] as never);
      vi.spyOn(sessionService, 'getSessionLocation').mockImplementation(
        async (sessionId) =>
          sessionId === legacySessionId ? 'archived' : undefined,
      );

      await expect(
        sessionService.findSessionIdIgnoringCase(sessionIdA),
      ).resolves.toBe(legacySessionId);
    });

    it('rejects case-only duplicate spellings instead of choosing by enumeration order', async () => {
      readdirSpy
        .mockResolvedValueOnce([
          `${sessionIdA.toUpperCase()}.jsonl`,
          `${sessionIdA.replace('e29b', 'E29b')}.jsonl`,
        ] as never)
        .mockResolvedValueOnce([] as never);
      // Both twins are genuinely readable while the requested spelling
      // resolves nothing — a true conflict.
      const getLocation = vi
        .spyOn(sessionService, 'getSessionLocation')
        .mockImplementation(async (id) =>
          id === sessionIdA ? undefined : 'active',
        );

      await expect(
        sessionService.findSessionIdIgnoringCase(sessionIdA),
      ).rejects.toMatchObject({
        name: 'SessionIdCaseConflictError',
        sessionId: sessionIdA,
        candidateSessionId: undefined,
        message: `Multiple persisted sessions match "${sessionIdA}" by case.`,
      });
      expect(getLocation).toHaveBeenCalledTimes(2);
    });

    it('rejects case-only duplicates whose heads are all unreadable as occupying the id', async () => {
      // Neither spelling on disk is the requested one, so minting the request
      // beside them would add a third case-variant of the same id.
      readdirSpy
        .mockResolvedValueOnce([
          `${sessionIdA.toUpperCase()}.jsonl`,
          `${sessionIdA.replace('e29b', 'E29b')}.jsonl`,
        ] as never)
        .mockResolvedValueOnce([] as never);
      // Neither head recovers records, but both files persist on disk.
      vi.spyOn(sessionService, 'getSessionLocation').mockResolvedValue(
        undefined,
      );
      existsSyncSpy.mockReturnValue(true);

      await expect(
        sessionService.findSessionIdIgnoringCase(sessionIdA),
      ).rejects.toMatchObject({
        name: 'SessionIdCaseConflictError',
        sessionId: sessionIdA,
        candidateSessionId: undefined,
        reason: 'unreadable_transcript',
      });
    });

    it('rejects one spelling that exists in both active and archive state', async () => {
      readdirSpy.mockResolvedValue([`${sessionIdA}.jsonl`] as never);
      const getLocation = vi
        .spyOn(sessionService, 'getSessionLocation')
        .mockResolvedValue('conflict');

      await expect(
        sessionService.findSessionIdIgnoringCase(sessionIdA),
      ).rejects.toMatchObject({
        name: 'SessionIdCaseConflictError',
        sessionId: sessionIdA,
        candidateSessionId: sessionIdA,
        message: `Session "${sessionIdA}" is persisted in both active and archived states.`,
      });
      expect(getLocation).toHaveBeenCalledTimes(1);
    });

    it('rejects a present-but-unreadable single candidate as occupying the id', async () => {
      const legacySessionId = sessionIdA.toUpperCase();
      readdirSpy
        .mockResolvedValueOnce([`${legacySessionId}.jsonl`] as never)
        .mockResolvedValueOnce([] as never);
      // The head recovers no records (torn/empty/foreign), but the file
      // still occupies the id — admission must not mint a case-only twin.
      vi.spyOn(sessionService, 'getSessionLocation').mockResolvedValue(
        undefined,
      );
      existsSyncSpy.mockReturnValue(true);

      await expect(
        sessionService.findSessionIdIgnoringCase(sessionIdA),
      ).rejects.toMatchObject({
        name: 'SessionIdCaseConflictError',
        sessionId: sessionIdA,
        candidateSessionId: legacySessionId,
        reason: 'unreadable_transcript',
        message: `Session "${legacySessionId}" is persisted but its transcript head is unreadable.`,
      });
    });

    it('returns the sole readable spelling when a case twin is unreadable', async () => {
      const legacySessionId = sessionIdA.toUpperCase();
      readdirSpy
        .mockResolvedValueOnce([
          `${sessionIdA}.jsonl`,
          `${legacySessionId}.jsonl`,
        ] as never)
        .mockResolvedValueOnce([] as never);
      vi.spyOn(sessionService, 'getSessionLocation').mockImplementation(
        async (id) => (id === legacySessionId ? 'active' : undefined),
      );

      await expect(
        sessionService.findSessionIdIgnoringCase(sessionIdA),
      ).resolves.toBe(legacySessionId);
    });

    it('returns a twin spelling when one of its two state copies is unreadable', async () => {
      const legacySessionId = sessionIdA.toUpperCase();
      readdirSpy.mockResolvedValue([`${legacySessionId}.jsonl`] as never);
      // getSessionLocation counts only readable copies, so one garbage
      // twin still resolves to the surviving state.
      vi.spyOn(sessionService, 'getSessionLocation').mockImplementation(
        async (id) => (id === legacySessionId ? 'active' : undefined),
      );

      await expect(
        sessionService.findSessionIdIgnoringCase(sessionIdA),
      ).resolves.toBe(legacySessionId);
    });

    it('returns undefined when the matching transcript disappears during resolution', async () => {
      // The candidate must differ in case from the request, otherwise the
      // self-escape short-circuits and the race loop below it never runs.
      const legacySessionId = sessionIdA.toUpperCase();
      readdirSpy
        .mockResolvedValueOnce([`${legacySessionId}.jsonl`] as never)
        .mockResolvedValueOnce([] as never);
      vi.spyOn(sessionService, 'getSessionLocation').mockResolvedValue(
        undefined,
      );
      existsSyncSpy.mockReturnValue(false);

      await expect(
        sessionService.findSessionIdIgnoringCase(sessionIdA),
      ).resolves.toBeUndefined();
    });

    it('lets an unreadable case twin keep occupying the id', async () => {
      // Both files are unreadable. The requested spelling's own file is a twin of
      // nothing, but the *other* spelling still occupies the id: minting the
      // request beside it is what would make both permanently unrestorable.
      const legacySessionId = sessionIdA.toUpperCase();
      readdirSpy
        .mockResolvedValueOnce([
          `${sessionIdA}.jsonl`,
          `${legacySessionId}.jsonl`,
        ] as never)
        .mockResolvedValueOnce([] as never);
      vi.spyOn(sessionService, 'getSessionLocation').mockResolvedValue(
        undefined,
      );
      existsSyncSpy.mockReturnValue(true);

      await expect(
        sessionService.findSessionIdIgnoringCase(sessionIdA),
      ).rejects.toMatchObject({
        name: 'SessionIdCaseConflictError',
        sessionId: sessionIdA,
        reason: 'unreadable_transcript',
      });
    });

    it('reports the requested spelling absent when only its own file survives', async () => {
      // The twin raced away between enumeration and the presence check, so
      // nothing but the request's own unreadable file is left to occupy the id.
      const legacySessionId = sessionIdA.toUpperCase();
      readdirSpy
        .mockResolvedValueOnce([
          `${sessionIdA}.jsonl`,
          `${legacySessionId}.jsonl`,
        ] as never)
        .mockResolvedValueOnce([] as never);
      vi.spyOn(sessionService, 'getSessionLocation').mockResolvedValue(
        undefined,
      );
      existsSyncSpy.mockImplementation((filePath: fs.PathLike) =>
        String(filePath).includes(`${sessionIdA}.jsonl`),
      );

      await expect(
        sessionService.findSessionIdIgnoringCase(sessionIdA),
      ).resolves.toBeUndefined();
      expect(existsSyncSpy).toHaveBeenCalledWith(
        expect.stringContaining(`${legacySessionId}.jsonl`),
      );
    });

    it('reports the requested spelling absent when its own transcript head is unreadable', async () => {
      // A first run that crashed before its first record leaves a 0-byte
      // transcript under the requested spelling. It is a case-only twin of
      // nothing, so reusing the id must stay possible — `getSessionLocation`
      // already reports the file as nonexistent.
      readdirSpy
        .mockResolvedValueOnce([`${sessionIdA}.jsonl`] as never)
        .mockResolvedValueOnce([] as never);
      vi.spyOn(sessionService, 'getSessionLocation').mockResolvedValue(
        undefined,
      );
      existsSyncSpy.mockReturnValue(true);

      await expect(
        sessionService.findSessionIdIgnoringCase(sessionIdA),
      ).resolves.toBeUndefined();
    });

    it('ignores persisted names getSessionLocation cannot classify', async () => {
      // Agent-suffixed ids are admitted by the CLI and written under the raw
      // session id, but SESSION_FILE_PATTERN excludes them — enumerating them
      // here would report a healthy transcript as occupied-but-unreadable.
      const agentSessionId = `${sessionIdA}-agent-foo`;
      readdirSpy
        .mockResolvedValueOnce([`${agentSessionId}.jsonl`] as never)
        .mockResolvedValueOnce([] as never);
      const getLocation = vi.spyOn(sessionService, 'getSessionLocation');
      existsSyncSpy.mockReturnValue(true);

      await expect(
        sessionService.findSessionIdIgnoringCase(agentSessionId),
      ).resolves.toBeUndefined();
      expect(getLocation).not.toHaveBeenCalled();
    });

    it('collapses case-variant spellings that alias one physical transcript', async () => {
      // On a case-insensitive filesystem both spellings open the same file, so
      // each reports a readable location even though only one copy exists.
      const legacySessionId = sessionIdA.toUpperCase();
      const mixedSessionId = sessionIdA.replace('e29b', 'E29b');
      readdirSpy
        .mockResolvedValueOnce([`${legacySessionId}.jsonl`] as never)
        .mockResolvedValueOnce([`${mixedSessionId}.jsonl`] as never);
      vi.spyOn(sessionService, 'getSessionLocation').mockImplementation(
        async (id) => (id === sessionIdA ? undefined : 'active'),
      );
      statSyncSpy.mockReturnValue({
        dev: 1,
        ino: 42,
        isFile: () => true,
      } as fs.Stats);

      await expect(
        sessionService.findSessionIdIgnoringCase(sessionIdA),
      ).resolves.toBe(legacySessionId);
    });

    it('still rejects two readable spellings backed by distinct files', async () => {
      const legacySessionId = sessionIdA.toUpperCase();
      const mixedSessionId = sessionIdA.replace('e29b', 'E29b');
      readdirSpy
        .mockResolvedValueOnce([
          `${legacySessionId}.jsonl`,
          `${mixedSessionId}.jsonl`,
        ] as never)
        .mockResolvedValueOnce([] as never);
      vi.spyOn(sessionService, 'getSessionLocation').mockImplementation(
        async (id) => (id === sessionIdA ? undefined : 'active'),
      );
      statSyncSpy.mockImplementation(
        (filePath: fs.PathLike) =>
          ({
            dev: 1,
            ino: String(filePath).includes(legacySessionId) ? 43 : 42,
            isFile: () => true,
          }) as fs.Stats,
      );

      await expect(
        sessionService.findSessionIdIgnoringCase(sessionIdA),
      ).rejects.toMatchObject({
        name: 'SessionIdCaseConflictError',
        sessionId: sessionIdA,
        candidateSessionId: undefined,
      });
    });

    it('reports a conflict rather than collapsing when the filesystem exposes no inode', async () => {
      // FAT/exFAT and some SMB mounts report ino 0 for every file, so `dev:ino`
      // cannot prove two spellings are one transcript. Without that proof the
      // pair must stay a conflict instead of silently resolving to one.
      const legacySessionId = sessionIdA.toUpperCase();
      const mixedSessionId = sessionIdA.replace('e29b', 'E29b');
      readdirSpy
        .mockResolvedValueOnce([`${mixedSessionId}.jsonl`] as never)
        .mockResolvedValueOnce([`${legacySessionId}.jsonl`] as never);
      vi.spyOn(sessionService, 'getSessionLocation').mockImplementation(
        async (id) => (id === sessionIdA ? undefined : 'active'),
      );
      statSyncSpy.mockReturnValue({
        dev: 1,
        ino: 0,
        isFile: () => true,
      } as fs.Stats);

      await expect(
        sessionService.findSessionIdIgnoringCase(sessionIdA),
      ).rejects.toMatchObject({
        name: 'SessionIdCaseConflictError',
        sessionId: sessionIdA,
      });
    });

    it('propagates an I/O failure instead of reporting it as a case conflict', async () => {
      // A transient EACCES/EMFILE says nothing about aliasing; laundering it
      // into `session_conflict` would report a retryable blip as permanent.
      const legacySessionId = sessionIdA.toUpperCase();
      const mixedSessionId = sessionIdA.replace('e29b', 'E29b');
      readdirSpy
        .mockResolvedValueOnce([`${mixedSessionId}.jsonl`] as never)
        .mockResolvedValueOnce([`${legacySessionId}.jsonl`] as never);
      vi.spyOn(sessionService, 'getSessionLocation').mockImplementation(
        async (id) => (id === sessionIdA ? undefined : 'active'),
      );
      statSyncSpy.mockImplementation(() => {
        throw Object.assign(new Error('permission denied'), {
          code: 'EACCES',
        });
      });

      await expect(
        sessionService.findSessionIdIgnoringCase(sessionIdA),
      ).rejects.toMatchObject({ code: 'EACCES' });
    });

    it('ignores a candidate whose transcript vanishes mid-resolution', async () => {
      // The mixed-case entry races away, so only the uppercase spelling is
      // left to back the readable state and it resolves without a conflict.
      const legacySessionId = sessionIdA.toUpperCase();
      const mixedSessionId = sessionIdA.replace('e29b', 'E29b');
      readdirSpy
        .mockResolvedValueOnce([`${mixedSessionId}.jsonl`] as never)
        .mockResolvedValueOnce([`${legacySessionId}.jsonl`] as never);
      vi.spyOn(sessionService, 'getSessionLocation').mockImplementation(
        async (id) => {
          if (id === legacySessionId) return 'archived';
          return id === sessionIdA ? undefined : 'active';
        },
      );
      statSyncSpy.mockImplementation((filePath: fs.PathLike) => {
        if (String(filePath).includes(`${mixedSessionId}.jsonl`)) {
          throw Object.assign(new Error('gone'), { code: 'ENOENT' });
        }
        return { dev: 1, ino: 7, isFile: () => true } as fs.Stats;
      });

      await expect(
        sessionService.findSessionIdIgnoringCase(sessionIdA),
      ).resolves.toBe(legacySessionId);
    });
  });

  describe('loadLastSession', () => {
    it('should return the most recent session (same as getLatestSession)', async () => {
      const now = Date.now();

      readdirSyncSpy.mockReturnValue([
        `${sessionIdA}.jsonl`,
        `${sessionIdB}.jsonl`,
      ] as unknown as Array<fs.Dirent<Buffer>>);

      statSyncSpy.mockImplementation((filePath: fs.PathLike) => {
        const path = filePath.toString();
        return {
          mtimeMs: path.includes(sessionIdB) ? now : now - 10000,
          isFile: () => true,
        } as fs.Stats;
      });

      vi.mocked(jsonl.readLines).mockImplementation(
        async (filePath: string) => {
          if (filePath.includes(sessionIdB)) {
            return [recordB1];
          }
          return [recordA1];
        },
      );

      vi.mocked(jsonl.read).mockResolvedValue([recordB1, recordB2]);

      const latest = await sessionService.loadLastSession();

      expect(latest?.conversation.sessionId).toBe(sessionIdB);
    });

    it('should return undefined when no sessions exist', async () => {
      readdirSyncSpy.mockReturnValue([]);

      const latest = await sessionService.loadLastSession();

      expect(latest).toBeUndefined();
    });
  });

  describe('sessionExists', () => {
    it('should return true for existing session', async () => {
      vi.mocked(jsonl.readLines).mockResolvedValue([recordA1]);

      const exists = await sessionService.sessionExists(sessionIdA);

      expect(exists).toBe(true);
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
      const migratedRecord: ChatRecord = {
        ...recordA1,
        cwd: '/old/project',
      };
      vi.mocked(jsonl.readLines).mockResolvedValue([migratedRecord]);
      vi.mocked(getProjectHash).mockImplementation((cwd: string) =>
        cwd === '/test/project/root'
          ? 'test-project-hash'
          : 'other-project-hash',
      );
      const controller = new AbortController();
      const reason = new Error('cancelled during runtime status read');
      let runtimeStatusSignal: AbortSignal | undefined;
      vi.mocked(readRuntimeStatus).mockImplementation(
        async (_filePath, options) => {
          runtimeStatusSignal = options?.signal;
          await new Promise<void>((_resolve, reject) => {
            runtimeStatusSignal?.addEventListener(
              'abort',
              () => reject(runtimeStatusSignal?.reason),
              { once: true },
            );
          });
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
      const differentProjectRecord: ChatRecord = {
        ...recordA1,
        cwd: '/different/project',
      };
      vi.mocked(jsonl.readLines).mockResolvedValue([differentProjectRecord]);
      vi.mocked(getProjectHash).mockImplementation((cwd: string) =>
        cwd === '/test/project/root'
          ? 'test-project-hash'
          : 'other-project-hash',
      );

      const exists = await sessionService.sessionExists(sessionIdA);

      expect(exists).toBe(false);
    });

    it('should return true for a migrated session when runtime status matches this project', async () => {
      const migratedRecord: ChatRecord = {
        ...recordA1,
        cwd: '/old/project',
      };
      vi.mocked(jsonl.readLines).mockResolvedValue([migratedRecord]);
      vi.mocked(readRuntimeStatus).mockResolvedValue({
        schemaVersion: 1,
        pid: 123,
        sessionId: sessionIdA,
        workDir: '/test/project/root',
        hostname: 'host',
        startedAt: 1,
        qwenVersion: null,
      });
      vi.mocked(getProjectHash).mockImplementation((cwd: string) =>
        cwd === '/test/project/root'
          ? 'test-project-hash'
          : 'other-project-hash',
      );

      const exists = await sessionService.sessionExists(sessionIdA);

      expect(exists).toBe(true);
    });

    it('should keep default existence checks active-only', async () => {
      vi.mocked(jsonl.readLines).mockImplementation(
        async (filePath: string) => {
          if (filePath.includes('/chats/archive/')) return [recordA1];
          const error = new Error('ENOENT') as NodeJS.ErrnoException;
          error.code = 'ENOENT';
          throw error;
        },
      );

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
          const error = new Error('ENOENT') as NodeJS.ErrnoException;
          error.code = 'ENOENT';
          throw error;
        },
      );

      await expect(
        sessionService.sessionExistsInAnyState(sessionIdA),
      ).resolves.toBe(true);
    });
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

    const makeConversation = (messages: ChatRecord[]): ConversationRecord => ({
      sessionId: sessionIdA,
      projectHash: 'test-project-hash',
      startTime: '2024-01-01T00:00:00Z',
      lastUpdated: '2024-01-01T00:00:00Z',
      messages,
    });

    const compressionRecord: ChatRecord = {
      ...baseRecord,
      uuid: 'comp',
      type: 'system',
      subtype: 'chat_compression',
      systemPayload: {
        info: {
          originalTokenCount: 1000,
          newTokenCount: 300,
          newTokenCountIsEstimated: true,
          compressionStatus: CompressionStatus.COMPRESSED,
        },
        compressedHistory: [],
      },
    };

    it('should return latest assistant usage without scanning further back', () => {
      const assistant: ChatRecord = {
        ...baseRecord,
        uuid: 'a1',
        parentUuid: 'comp',
        type: 'assistant',
        usageMetadata: { totalTokenCount: 450 },
      };
      expect(
        getResumePromptTokenCount(
          makeConversation([compressionRecord, assistant]),
        ),
      ).toBe(450);
      expect(
        getResumeTokenCounts(makeConversation([compressionRecord, assistant])),
      ).toEqual({
        promptTokenCount: 450,
        outputTokenCount: 0,
        isEstimated: false,
      });
    });

    it('should prefer promptTokenCount over totalTokenCount when both are present', () => {
      const assistant: ChatRecord = {
        ...baseRecord,
        uuid: 'a1',
        parentUuid: 'comp',
        type: 'assistant',
        usageMetadata: { promptTokenCount: 200, totalTokenCount: 450 },
      };
      expect(
        getResumePromptTokenCount(
          makeConversation([compressionRecord, assistant]),
        ),
      ).toBe(200);
      expect(
        getResumeTokenCounts(makeConversation([compressionRecord, assistant])),
      ).toEqual({
        promptTokenCount: 200,
        outputTokenCount: 250,
        isEstimated: false,
      });
    });

    it('should restore disjoint candidate and thought output tokens when total is unavailable', () => {
      const assistant: ChatRecord = {
        ...baseRecord,
        uuid: 'a1',
        parentUuid: 'comp',
        type: 'assistant',
        usageMetadata: {
          promptTokenCount: 200,
          candidatesTokenCount: 40,
          thoughtsTokenCount: 60,
        },
      };
      expect(
        getResumeTokenCounts(makeConversation([compressionRecord, assistant])),
      ).toEqual({
        promptTokenCount: 200,
        outputTokenCount: 100,
        isEstimated: false,
      });
    });

    it('should fall back to compression when latest assistant has zero usage', () => {
      const assistant: ChatRecord = {
        ...baseRecord,
        uuid: 'a1',
        parentUuid: 'comp',
        type: 'assistant',
        usageMetadata: { totalTokenCount: 0, promptTokenCount: 0 },
      };
      expect(
        getResumePromptTokenCount(
          makeConversation([compressionRecord, assistant]),
        ),
      ).toBe(300);
      expect(
        getResumeTokenCounts(makeConversation([compressionRecord, assistant])),
      ).toEqual({
        promptTokenCount: 300,
        outputTokenCount: 0,
        isEstimated: true,
      });
    });

    it('conservatively treats legacy compression checkpoints as estimated', () => {
      const legacyCompressionRecord: ChatRecord = {
        ...compressionRecord,
        systemPayload: {
          info: {
            originalTokenCount: 1000,
            newTokenCount: 300,
            compressionStatus: CompressionStatus.COMPRESSED,
          },
          compressedHistory: [],
        },
      };

      expect(
        getResumeTokenCounts(makeConversation([legacyCompressionRecord])),
      ).toEqual({
        promptTokenCount: 300,
        outputTokenCount: 0,
        isEstimated: true,
      });
    });

    it('restores an explicit authoritative compression-checkpoint provenance', () => {
      const authoritativeCompressionRecord: ChatRecord = {
        ...compressionRecord,
        systemPayload: {
          info: {
            originalTokenCount: 1000,
            newTokenCount: 300,
            newTokenCountIsEstimated: false,
            compressionStatus: CompressionStatus.COMPRESSED,
          },
          compressedHistory: [],
        },
      };

      expect(
        getResumeTokenCounts(
          makeConversation([authoritativeCompressionRecord]),
        ),
      ).toEqual({
        promptTokenCount: 300,
        outputTokenCount: 0,
        isEstimated: false,
      });
    });
  });

  describe('buildApiHistoryFromConversation', () => {
    it('should return linear messages when no compression checkpoint exists', () => {
      const assistantA1: ChatRecord = {
        ...recordB2,
        sessionId: sessionIdA,
        parentUuid: recordA1.uuid,
      };

      const conversation: ConversationRecord = {
        sessionId: sessionIdA,
        projectHash: 'test-project-hash',
        startTime: '2024-01-01T00:00:00Z',
        lastUpdated: '2024-01-01T00:00:00Z',
        messages: [recordA1, assistantA1],
      };

      const history = buildApiHistoryFromConversation(conversation);

      expect(history).toEqual([recordA1.message, assistantA1.message]);
    });

    it('keeps Realtime dialogue out of backend model history', () => {
      const realtimeUser: ChatRecord = {
        ...recordA1,
        uuid: 'realtime-user',
        subtype: 'realtime_message',
        message: { role: 'user', parts: [{ text: 'voice question' }] },
      };
      const realtimeAssistant: ChatRecord = {
        ...recordB2,
        uuid: 'realtime-assistant',
        parentUuid: realtimeUser.uuid,
        sessionId: sessionIdA,
        subtype: 'realtime_message',
        message: { role: 'model', parts: [{ text: 'voice answer' }] },
      };
      const backendUser: ChatRecord = {
        ...recordA1,
        uuid: 'backend-user',
        parentUuid: realtimeAssistant.uuid,
        message: { role: 'user', parts: [{ text: 'backend task' }] },
      };
      const conversation: ConversationRecord = {
        sessionId: sessionIdA,
        projectHash: 'test-project-hash',
        startTime: '2024-01-01T00:00:00Z',
        lastUpdated: '2024-01-01T00:00:00Z',
        messages: [realtimeUser, realtimeAssistant, backendUser],
      };

      expect(buildApiHistoryFromConversation(conversation)).toEqual([
        backendUser.message,
      ]);
    });

    it('does not deep-clone stored messages when rebuilding resume API history', () => {
      const largePayload = {
        output: 'x'.repeat(128 * 1024),
        nested: { keep: true },
      };
      const toolResult: ChatRecord = {
        uuid: 'large-tool-result',
        parentUuid: recordA1.uuid,
        sessionId: sessionIdA,
        timestamp: '2024-01-01T00:02:00Z',
        type: 'tool_result',
        message: {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'call-1',
                name: 'read_file',
                response: largePayload,
              },
            },
          ],
        },
        cwd: '/test/project/root',
        version: '1.0.0',
      };
      const conversation: ConversationRecord = {
        sessionId: sessionIdA,
        projectHash: 'test-project-hash',
        startTime: '2024-01-01T00:00:00Z',
        lastUpdated: '2024-01-01T00:02:00Z',
        messages: [recordA1, toolResult],
      };
      const structuredCloneSpy = vi
        .spyOn(globalThis, 'structuredClone')
        .mockImplementation(() => {
          throw new Error('unexpected deep clone');
        });

      const history = buildApiHistoryFromConversation(conversation);

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
      const assistantWithToolCall: ChatRecord = {
        uuid: 'a2',
        parentUuid: recordA1.uuid,
        sessionId: sessionIdA,
        timestamp: '2024-01-01T00:01:00Z',
        type: 'assistant',
        message: {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'call-1',
                name: 'read_file',
                args: { path: 'foo.txt' },
              },
            },
          ],
        },
        cwd: '/test/project/root',
        version: '1.0.0',
      };
      const toolResult: ChatRecord = {
        uuid: 'a3',
        parentUuid: assistantWithToolCall.uuid,
        sessionId: sessionIdA,
        timestamp: '2024-01-01T00:02:00Z',
        type: 'tool_result',
        message: {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'call-1',
                name: 'read_file',
                response: { output: 'contents' },
              },
            },
          ],
        },
        cwd: '/test/project/root',
        version: '1.0.0',
      };
      const midTurnUserMessage: ChatRecord = {
        uuid: 'a4',
        parentUuid: toolResult.uuid,
        sessionId: sessionIdA,
        timestamp: '2024-01-01T00:03:00Z',
        type: 'user',
        subtype: 'mid_turn_user_message',
        message: {
          role: 'user',
          parts: [
            {
              text: '\n[User message received during tool execution]: save the logs',
            },
          ],
        },
        cwd: '/test/project/root',
        version: '1.0.0',
      };
      const conversation: ConversationRecord = {
        sessionId: sessionIdA,
        projectHash: 'test-project-hash',
        startTime: '2024-01-01T00:00:00Z',
        lastUpdated: '2024-01-01T00:03:00Z',
        messages: [
          recordA1,
          assistantWithToolCall,
          toolResult,
          midTurnUserMessage,
        ],
      };

      const history = buildApiHistoryFromConversation(conversation);

      expect(history).toEqual([
        recordA1.message,
        assistantWithToolCall.message,
        {
          role: 'user',
          parts: [
            ...toolResult.message!.parts!,
            ...midTurnUserMessage.message!.parts!,
          ],
        },
      ]);
    });

    it('should use compressedHistory snapshot and append subsequent records after compression', () => {
      const compressionRecord: ChatRecord = {
        uuid: 'c1',
        parentUuid: 'b2',
        sessionId: sessionIdA,
        timestamp: '2024-01-02T03:00:00Z',
        type: 'system',
        subtype: 'chat_compression',
        cwd: '/test/project/root',
        version: '1.0.0',
        gitBranch: 'main',
        systemPayload: {
          info: {
            originalTokenCount: 100,
            newTokenCount: 50,
            compressionStatus: CompressionStatus.COMPRESSED,
          },
          compressedHistory: [
            { role: 'user', parts: [{ text: 'summary' }] },
            {
              role: 'model',
              parts: [{ text: 'Got it. Thanks for the additional context!' }],
            },
            recordB2.message!,
          ],
        },
      };

      const postCompressionRecord: ChatRecord = {
        uuid: 'c2',
        parentUuid: 'c1',
        sessionId: sessionIdA,
        timestamp: '2024-01-02T04:00:00Z',
        type: 'user',
        message: { role: 'user', parts: [{ text: 'new question' }] },
        cwd: '/test/project/root',
        version: '1.0.0',
        gitBranch: 'main',
      };

      const conversation: ConversationRecord = {
        sessionId: sessionIdA,
        projectHash: 'test-project-hash',
        startTime: '2024-01-01T00:00:00Z',
        lastUpdated: '2024-01-02T04:00:00Z',
        messages: [
          recordA1,
          recordB2,
          compressionRecord,
          postCompressionRecord,
        ],
      };

      const history = buildApiHistoryFromConversation(conversation);

      expect(history).toEqual([
        { role: 'user', parts: [{ text: 'summary' }] },
        {
          role: 'model',
          parts: [{ text: 'Got it. Thanks for the additional context!' }],
        },
        recordB2.message,
        postCompressionRecord.message,
      ]);
    });

    it('merges post-compression mid-turn user messages into preceding tool results', () => {
      const compressionRecord: ChatRecord = {
        uuid: 'c1',
        parentUuid: 'b2',
        sessionId: sessionIdA,
        timestamp: '2024-01-02T03:00:00Z',
        type: 'system',
        subtype: 'chat_compression',
        cwd: '/test/project/root',
        version: '1.0.0',
        gitBranch: 'main',
        systemPayload: {
          info: {
            originalTokenCount: 100,
            newTokenCount: 50,
            compressionStatus: CompressionStatus.COMPRESSED,
          },
          compressedHistory: [
            { role: 'user', parts: [{ text: 'summary' }] },
            { role: 'model', parts: [{ text: 'continue' }] },
          ],
        },
      };
      const toolResult: ChatRecord = {
        uuid: 'c2',
        parentUuid: 'c1',
        sessionId: sessionIdA,
        timestamp: '2024-01-02T04:00:00Z',
        type: 'tool_result',
        message: {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'call-1',
                name: 'shell',
                response: { output: 'ok' },
              },
            },
          ],
        },
        cwd: '/test/project/root',
        version: '1.0.0',
        gitBranch: 'main',
      };
      const midTurnUserMessage: ChatRecord = {
        uuid: 'c3',
        parentUuid: 'c2',
        sessionId: sessionIdA,
        timestamp: '2024-01-02T04:01:00Z',
        type: 'user',
        subtype: 'mid_turn_user_message',
        message: {
          role: 'user',
          parts: [
            {
              text: '\n[User message received during tool execution]: stop after this',
            },
          ],
        },
        cwd: '/test/project/root',
        version: '1.0.0',
        gitBranch: 'main',
      };
      const conversation: ConversationRecord = {
        sessionId: sessionIdA,
        projectHash: 'test-project-hash',
        startTime: '2024-01-01T00:00:00Z',
        lastUpdated: '2024-01-02T04:01:00Z',
        messages: [
          recordA1,
          recordB2,
          compressionRecord,
          toolResult,
          midTurnUserMessage,
        ],
      };

      const history = buildApiHistoryFromConversation(conversation);

      expect(history).toEqual([
        { role: 'user', parts: [{ text: 'summary' }] },
        { role: 'model', parts: [{ text: 'continue' }] },
        {
          role: 'user',
          parts: [
            ...toolResult.message!.parts!,
            ...midTurnUserMessage.message!.parts!,
          ],
        },
      ]);
    });

    it('should preserve thought parts by default (stripThoughtsFromHistory=false)', () => {
      const modelWithThought: ChatRecord = {
        uuid: 't1',
        parentUuid: 'a1',
        sessionId: sessionIdA,
        timestamp: '2024-01-01T01:00:00Z',
        type: 'assistant',
        message: {
          role: 'model',
          parts: [
            { text: 'reasoning step', thought: true },
            { text: 'final answer' },
          ],
        },
        cwd: '/test/project/root',
        version: '1.0.0',
      };

      const conversation: ConversationRecord = {
        sessionId: sessionIdA,
        projectHash: 'test-project-hash',
        startTime: '2024-01-01T00:00:00Z',
        lastUpdated: '2024-01-01T01:00:00Z',
        messages: [recordA1, modelWithThought],
      };

      const history = buildApiHistoryFromConversation(conversation);

      // Thought parts should be preserved by default
      expect(history).toHaveLength(2);
      expect(history[1].parts).toEqual([
        { text: 'reasoning step', thought: true },
        { text: 'final answer' },
      ]);
    });

    it('should strip thought parts when stripThoughtsFromHistory=true', () => {
      const modelWithThought: ChatRecord = {
        uuid: 't1',
        parentUuid: 'a1',
        sessionId: sessionIdA,
        timestamp: '2024-01-01T01:00:00Z',
        type: 'assistant',
        message: {
          role: 'model',
          parts: [
            { text: 'reasoning step', thought: true },
            { text: 'final answer' },
          ],
        },
        cwd: '/test/project/root',
        version: '1.0.0',
      };

      const conversation: ConversationRecord = {
        sessionId: sessionIdA,
        projectHash: 'test-project-hash',
        startTime: '2024-01-01T00:00:00Z',
        lastUpdated: '2024-01-01T01:00:00Z',
        messages: [recordA1, modelWithThought],
      };

      const history = buildApiHistoryFromConversation(conversation, {
        stripThoughtsFromHistory: true,
      });

      // Thought parts should be stripped
      expect(history).toHaveLength(2);
      expect(history[1].parts).toEqual([{ text: 'final answer' }]);
    });

    it('should preserve thought parts in compressed history by default', () => {
      const compressionRecord: ChatRecord = {
        uuid: 'c1',
        parentUuid: 'b2',
        sessionId: sessionIdA,
        timestamp: '2024-01-02T03:00:00Z',
        type: 'system',
        subtype: 'chat_compression',
        cwd: '/test/project/root',
        version: '1.0.0',
        gitBranch: 'main',
        systemPayload: {
          info: {
            originalTokenCount: 100,
            newTokenCount: 50,
            compressionStatus: CompressionStatus.COMPRESSED,
          },
          compressedHistory: [
            { role: 'user', parts: [{ text: 'summary' }] },
            {
              role: 'model',
              parts: [
                { text: 'deep thinking', thought: true },
                { text: 'final answer' },
              ],
            },
          ],
        },
      };

      const conversation: ConversationRecord = {
        sessionId: sessionIdA,
        projectHash: 'test-project-hash',
        startTime: '2024-01-01T00:00:00Z',
        lastUpdated: '2024-01-02T03:00:00Z',
        messages: [recordA1, recordB2, compressionRecord],
      };

      const history = buildApiHistoryFromConversation(conversation);

      // Thought parts should be preserved in compressed history by default.
      // The compressedHistory has 2 entries (user, model), and no messages
      // exist after the compression record, so the result is 2 items.
      expect(history).toHaveLength(2);
      expect(history[1].parts).toEqual([
        { text: 'deep thinking', thought: true },
        { text: 'final answer' },
      ]);
    });
  });

  describe('forkSession', () => {
    // forkSession uses real disk I/O through `jsonl.read` and `fs.*`.
    // The outer describe hoist-mocks `node:path`, `../utils/paths.js`, and
    // `../utils/jsonl-utils.js`; restore the real implementations inside this
    // describe's setup so the fork actually reads/writes tmp files.
    let realTmpDir: string;
    let realOs: typeof import('node:os');
    let realPath: typeof import('node:path');
    let service: SessionService;
    let cwd: string;
    let originalQwenHome: string | undefined;

    beforeEach(async () => {
      realOs = await import('node:os');
      realPath = await vi.importActual<typeof import('node:path')>('node:path');
      const actualPaths =
        await vi.importActual<typeof import('../utils/paths.js')>(
          '../utils/paths.js',
        );
      const actualJsonl = await vi.importActual<
        typeof import('../utils/jsonl-utils.js')
      >('../utils/jsonl-utils.js');

      vi.mocked(path.join).mockImplementation(
        realPath.join as unknown as typeof path.join,
      );
      vi.mocked(path.dirname).mockImplementation(
        realPath.dirname as unknown as typeof path.dirname,
      );
      vi.mocked(path.basename).mockImplementation(
        realPath.basename as unknown as typeof path.basename,
      );
      // Storage.resolveRuntimeBaseDir uses isAbsolute and resolve; both are
      // auto-mocked to return undefined, which silently falls back to
      // `~/.qwen` and makes the fork write outside the tmp sandbox.
      vi.mocked(path.isAbsolute).mockImplementation(
        realPath.isAbsolute as unknown as typeof path.isAbsolute,
      );
      vi.mocked(path.resolve).mockImplementation(
        realPath.resolve as unknown as typeof path.resolve,
      );
      vi.mocked(getProjectHash).mockImplementation(actualPaths.getProjectHash);
      // Storage.getProjectDir calls sanitizeCwd via a non-spied namespace import;
      // restore it module-globally so getChatsDir() returns a real path.
      const mockedPaths = (await import('../utils/paths.js')) as unknown as {
        sanitizeCwd: (cwd: string) => string;
      };
      mockedPaths.sanitizeCwd = actualPaths.sanitizeCwd;
      vi.mocked(jsonl.read).mockImplementation(actualJsonl.read);
      vi.mocked(jsonl.readLines).mockImplementation(actualJsonl.readLines);

      // Restore any fs spies installed by the outer beforeEach.
      vi.mocked(readdirSyncSpy).mockRestore?.();
      vi.mocked(statSyncSpy).mockRestore?.();
      vi.mocked(statPromiseSpy).mockRestore?.();
      vi.mocked(unlinkSyncSpy).mockRestore?.();
      vi.mocked(renameSyncSpy).mockRestore?.();
      vi.mocked(rmSyncSpy).mockRestore?.();

      realTmpDir = fs.mkdtempSync(
        realPath.join(realOs.tmpdir(), 'fork-session-'),
      );
      originalQwenHome = process.env['QWEN_HOME'];
      process.env['QWEN_HOME'] = realTmpDir;
      process.env['QWEN_RUNTIME_DIR'] = realTmpDir;
      cwd = process.cwd();
      service = new SessionService(cwd);
    });

    afterEach(() => {
      delete process.env['QWEN_RUNTIME_DIR'];
      if (originalQwenHome === undefined) {
        delete process.env['QWEN_HOME'];
      } else {
        process.env['QWEN_HOME'] = originalQwenHome;
      }
      try {
        fs.rmSync(realTmpDir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    });

    const seedSession = (sessionId: string, sessionCwd = cwd) => {
      const chatsDir = realPath.join(
        service['storage'].getProjectDir(),
        'chats',
      );
      fs.mkdirSync(chatsDir, { recursive: true });
      const file = realPath.join(chatsDir, `${sessionId}.jsonl`);
      const lines: Array<Record<string, unknown>> = [
        {
          uuid: 'u1',
          parentUuid: null,
          sessionId,
          type: 'user',
          provenance: 'real_user',
          timestamp: '2026-04-22T00:00:00.000Z',
          cwd: sessionCwd,
          version: 'test',
          message: { role: 'user', parts: [{ text: 'hello' }] },
        },
        {
          uuid: 'u2',
          parentUuid: 'u1',
          sessionId,
          type: 'assistant',
          provenance: 'assistant_output',
          timestamp: '2026-04-22T00:00:01.000Z',
          cwd: sessionCwd,
          version: 'test',
          message: { role: 'model', parts: [{ text: 'hi' }] },
        },
      ];
      fs.writeFileSync(
        file,
        lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
      );
      return { file, lines };
    };

    const appendFileHistorySnapshot = (
      sessionId: string,
      file: string,
      lines: Array<Record<string, unknown>>,
      backupNames: string[],
    ) => {
      fs.writeFileSync(
        file,
        [
          ...lines,
          {
            uuid: 'snapshot-branch',
            parentUuid: 'u2',
            sessionId,
            type: 'system',
            subtype: 'file_history_snapshot',
            timestamp: '2026-04-22T00:00:02.000Z',
            cwd,
            version: 'test',
            systemPayload: {
              snapshots: [
                {
                  promptId: `${sessionId}########0`,
                  timestamp: '2026-04-22T00:00:00.000Z',
                  trackedFileBackups: Object.fromEntries(
                    backupNames.map((backupFileName, index) => [
                      `file-${index}.txt`,
                      {
                        backupFileName,
                        version: 1,
                        backupTime: '2026-04-22T00:00:00.000Z',
                      },
                    ]),
                  ),
                },
              ],
            },
          },
        ]
          .map((record) => JSON.stringify(record))
          .join('\n') + '\n',
      );
    };

    it('rewrites sessionId, rebuilds parentUuid, and stamps forkedFrom on every record', async () => {
      const oldId = '11111111-1111-1111-1111-111111111111';
      const newId = '22222222-2222-2222-2222-222222222222';
      const { file: srcPath } = seedSession(oldId);

      const result = await service.forkSession(oldId, newId);
      expect(result.copiedCount).toBe(2);
      expect(result.filePath).toContain(`${newId}.jsonl`);

      const written = fs
        .readFileSync(result.filePath, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l));

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
      // Source file is untouched.
      expect(fs.existsSync(srcPath)).toBe(true);
      const srcLines = fs
        .readFileSync(srcPath, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l));
      expect(srcLines.every((r) => r.sessionId === oldId)).toBe(true);
      expect(srcLines.every((r) => !r.forkedFrom)).toBe(true);
    });

    it('remaps persisted telemetry prompt ids into the fork', async () => {
      const oldId = '51515151-5151-5151-5151-515151515151';
      const newId = '61616161-6161-6161-6161-616161616161';
      const { file, lines } = seedSession(oldId);
      fs.writeFileSync(
        file,
        [
          ...lines,
          {
            uuid: 'telemetry-1',
            parentUuid: 'u2',
            sessionId: oldId,
            type: 'system',
            subtype: 'ui_telemetry',
            timestamp: '2026-04-22T00:00:02.000Z',
            cwd,
            version: 'test',
            systemPayload: {
              uiEvent: {
                'event.name': 'api_response',
                prompt_id: `${oldId}#Explore#0`,
              },
            },
          },
        ]
          .map((record) => JSON.stringify(record))
          .join('\n') + '\n',
      );

      const result = await service.forkSession(oldId, newId);
      const telemetry = fs
        .readFileSync(result.filePath, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
        .find((record) => record.subtype === 'ui_telemetry');

      expect(telemetry.systemPayload.uiEvent.prompt_id).toBe(
        `${newId}#Explore#0`,
      );
    });

    it('does not copy source turn_result identities into a fork', async () => {
      const oldId = '31313131-3131-3131-3131-313131313131';
      const newId = '41414141-4141-4141-4141-414141414141';
      const { file, lines } = seedSession(oldId);
      fs.writeFileSync(
        file,
        [
          ...lines,
          {
            uuid: 'turn-result-1',
            parentUuid: 'u2',
            sessionId: oldId,
            type: 'system',
            subtype: 'turn_result',
            timestamp: '2026-04-22T00:00:02.000Z',
            cwd: lines[0]!['cwd'],
            version: 'test',
            systemPayload: {
              promptId: 'source-prompt-id',
              state: 'completed',
              endedAt: 2000,
            },
          },
          {
            uuid: 'artifact-after-turn-result',
            parentUuid: 'turn-result-1',
            sessionId: oldId,
            type: 'system',
            subtype: 'session_artifact_event',
            timestamp: '2026-04-22T00:00:03.000Z',
            cwd: lines[0]!['cwd'],
            version: 'test',
            systemPayload: {
              v: SESSION_ARTIFACT_PERSISTENCE_VERSION,
              sessionId: oldId,
              sequence: 1,
              recordedAt: '2026-04-22T00:00:03.000Z',
              changes: [],
            },
          },
        ]
          .map((line) => JSON.stringify(line))
          .join('\n') + '\n',
      );

      const result = await service.forkSession(oldId, newId);
      const written = fs
        .readFileSync(result.filePath, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));

      expect(written).toHaveLength(3);
      expect(written.some((record) => record.subtype === 'turn_result')).toBe(
        false,
      );
      expect(
        written.find((record) => record.uuid === 'artifact-after-turn-result'),
      ).toMatchObject({ parentUuid: 'u2' });
    });

    it('writes source metadata and drops the inherited title for sourced forks', async () => {
      const oldId = '10101010-1010-1010-1010-101010101010';
      const newId = '20202020-2020-2020-2020-202020202020';
      const { file, lines } = seedSession(oldId);
      fs.writeFileSync(
        file,
        [
          ...lines,
          {
            uuid: 'title-1',
            parentUuid: 'u2',
            sessionId: oldId,
            type: 'system',
            subtype: 'custom_title',
            timestamp: '2026-04-22T00:00:02.000Z',
            cwd,
            version: 'test',
            systemPayload: {
              customTitle: 'Parent title',
              titleSource: 'manual',
            },
          },
        ]
          .map((line) => JSON.stringify(line))
          .join('\n') + '\n',
      );

      const result = await service.forkSession(oldId, newId, {
        source: {
          sourceType: 'side_task',
          sourceId: oldId,
        },
      });
      const written = fs
        .readFileSync(result.filePath, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));

      expect(written[0]).toMatchObject({
        parentUuid: null,
        sessionId: newId,
        type: 'system',
        subtype: 'session_source',
        cwd,
        version: 'test',
        systemPayload: {
          sourceType: 'side_task',
          sourceId: oldId,
        },
      });
      expect(written.some((record) => record.subtype === 'custom_title')).toBe(
        false,
      );
      expect(written[1]).toMatchObject({
        parentUuid: written[0].uuid,
        forkedFrom: {
          sessionId: oldId,
          messageUuid: 'u1',
        },
      });
    });

    it('forks from a validated historical Assistant checkpoint', async () => {
      const oldId = '11111111-1111-1111-1111-111111111113';
      const newId = '22222222-2222-2222-2222-222222222224';
      const { file, lines } = seedSession(oldId);
      const checkpoint = {
        uuid: 'checkpoint-1',
        parentUuid: 'u2',
        sessionId: oldId,
        type: 'system',
        subtype: 'branch_checkpoint',
        timestamp: '2026-04-22T00:00:02.000Z',
        cwd,
        version: 'test',
        systemPayload: {
          v: 1,
          startExclusiveRecordUuid: null,
          assistantRecordUuid: 'u2',
          promptId: `${oldId}########0`,
        },
      };
      const laterRecords = [
        {
          uuid: 'u3',
          parentUuid: 'checkpoint-1',
          sessionId: oldId,
          type: 'user',
          timestamp: '2026-04-22T00:00:03.000Z',
          cwd,
          version: 'test',
          message: { role: 'user', parts: [{ text: 'later' }] },
        },
        {
          uuid: 'u4',
          parentUuid: 'u3',
          sessionId: oldId,
          type: 'assistant',
          timestamp: '2026-04-22T00:00:04.000Z',
          cwd,
          version: 'test',
          message: { role: 'model', parts: [{ text: 'later answer' }] },
        },
      ];
      fs.writeFileSync(
        file,
        [...lines, checkpoint, ...laterRecords]
          .map((record) => JSON.stringify(record))
          .join('\n') + '\n',
      );

      const result = await service.forkSession(oldId, newId, {
        atRecordId: 'checkpoint-1',
        title: 'Historical branch',
      });
      const written = fs
        .readFileSync(result.filePath, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));

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
      const oldId = '11111111-1111-1111-1111-111111111115';
      const newId = '22222222-2222-2222-2222-222222222226';
      const nestedId = '33333333-3333-3333-3333-333333333337';
      const { file, lines } = seedSession(oldId);
      const creationRecord = {
        uuid: 'creation-metadata',
        parentUuid: null,
        sessionId: oldId,
        type: 'system',
        subtype: 'session_source',
        timestamp: '2026-04-22T00:00:00.000Z',
        cwd,
        version: 'test',
        systemPayload: { sourceType: 'web-shell' },
      };
      lines[0]!['parentUuid'] = 'creation-metadata';
      const checkpoint = {
        uuid: 'checkpoint-after-creation',
        parentUuid: 'u2',
        sessionId: oldId,
        type: 'system',
        subtype: 'branch_checkpoint',
        timestamp: '2026-04-22T00:00:02.000Z',
        cwd,
        version: 'test',
        systemPayload: {
          v: 1,
          startExclusiveRecordUuid: 'creation-metadata',
          assistantRecordUuid: 'u2',
        },
      };
      fs.writeFileSync(
        file,
        [creationRecord, ...lines, checkpoint]
          .map((record) => JSON.stringify(record))
          .join('\n') + '\n',
      );

      const first = await service.forkSession(oldId, newId, {
        atRecordId: checkpoint.uuid,
      });
      const written = fs
        .readFileSync(first.filePath, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(
        written.some((record) => record.uuid === creationRecord.uuid),
      ).toBe(false);
      expect(
        written.find((record) => record.uuid === checkpoint.uuid)
          ?.systemPayload,
      ).toMatchObject({ startExclusiveRecordUuid: null });
      await expect(
        service.forkSession(newId, nestedId, {
          atRecordId: checkpoint.uuid,
        }),
      ).resolves.toMatchObject({ copiedCount: 3 });
    });

    it('remaps a checkpoint boundary from a filtered custom_title to its predecessor', async () => {
      const oldId = '11111111-1111-1111-1111-111111111116';
      const newId = '22222222-2222-2222-2222-222222222227';
      const chatsDir = realPath.join(
        service['storage'].getProjectDir(),
        'chats',
      );
      fs.mkdirSync(chatsDir, { recursive: true });
      const file = realPath.join(chatsDir, `${oldId}.jsonl`);
      const records = [
        {
          uuid: 'u1',
          parentUuid: null,
          sessionId: oldId,
          type: 'user',
          provenance: 'real_user',
          timestamp: '2026-04-22T00:00:00.000Z',
          cwd,
          version: 'test',
          message: { role: 'user', parts: [{ text: 'first question' }] },
        },
        {
          uuid: 'a1',
          parentUuid: 'u1',
          sessionId: oldId,
          type: 'assistant',
          provenance: 'assistant_output',
          timestamp: '2026-04-22T00:00:01.000Z',
          cwd,
          version: 'test',
          message: { role: 'model', parts: [{ text: 'first answer' }] },
        },
        {
          uuid: 'title-1',
          parentUuid: 'a1',
          sessionId: oldId,
          type: 'system',
          subtype: 'custom_title',
          timestamp: '2026-04-22T00:00:01.500Z',
          cwd,
          version: 'test',
          systemPayload: { customTitle: 'Renamed', titleSource: 'manual' },
        },
        {
          uuid: 'u2',
          parentUuid: 'title-1',
          sessionId: oldId,
          type: 'user',
          provenance: 'real_user',
          timestamp: '2026-04-22T00:00:02.000Z',
          cwd,
          version: 'test',
          message: { role: 'user', parts: [{ text: 'second question' }] },
        },
        {
          uuid: 'a2',
          parentUuid: 'u2',
          sessionId: oldId,
          type: 'assistant',
          provenance: 'assistant_output',
          timestamp: '2026-04-22T00:00:03.000Z',
          cwd,
          version: 'test',
          message: { role: 'model', parts: [{ text: 'second answer' }] },
        },
        {
          uuid: 'checkpoint-2',
          parentUuid: 'a2',
          sessionId: oldId,
          type: 'system',
          subtype: 'branch_checkpoint',
          timestamp: '2026-04-22T00:00:03.500Z',
          cwd,
          version: 'test',
          systemPayload: {
            v: 1,
            startExclusiveRecordUuid: 'title-1',
            assistantRecordUuid: 'a2',
          },
        },
      ];
      fs.writeFileSync(
        file,
        records.map((r) => JSON.stringify(r)).join('\n') + '\n',
      );

      const result = await service.forkSession(oldId, newId, {
        atRecordId: 'checkpoint-2',
        source: { sourceType: 'side_task' },
      });
      const written = fs
        .readFileSync(result.filePath, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(written.some((r) => r.subtype === 'custom_title')).toBe(false);
      const forkedCheckpoint = written.find((r) => r.uuid === 'checkpoint-2');
      expect(forkedCheckpoint?.systemPayload).toMatchObject({
        startExclusiveRecordUuid: 'a1',
      });
      const nestedId = '33333333-3333-3333-3333-333333333338';
      await expect(
        service.forkSession(newId, nestedId, {
          atRecordId: 'checkpoint-2',
        }),
      ).resolves.toBeDefined();
    });

    it('forks from a checkpoint whose line is duplicated in the transcript', async () => {
      const oldId = '11111111-1111-1111-1111-111111111117';
      const newId = '22222222-2222-2222-2222-222222222228';
      const { file, lines } = seedSession(oldId);
      const checkpoint = {
        uuid: 'checkpoint-dup',
        parentUuid: 'u2',
        sessionId: oldId,
        type: 'system',
        subtype: 'branch_checkpoint',
        timestamp: '2026-04-22T00:00:02.000Z',
        cwd,
        version: 'test',
        systemPayload: {
          v: 1,
          startExclusiveRecordUuid: null,
          assistantRecordUuid: 'u2',
        },
      };
      const later = {
        uuid: 'u3',
        parentUuid: 'checkpoint-dup',
        sessionId: oldId,
        type: 'user',
        timestamp: '2026-04-22T00:00:03.000Z',
        cwd,
        version: 'test',
        message: { role: 'user', parts: [{ text: 'later' }] },
      };
      fs.writeFileSync(
        file,
        [...lines, checkpoint, checkpoint, later]
          .map((record) => JSON.stringify(record))
          .join('\n') + '\n',
      );

      const result = await service.forkSession(oldId, newId, {
        atRecordId: 'checkpoint-dup',
      });

      expect(result.copiedCount).toBe(3);
      const written = fs
        .readFileSync(result.filePath, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(written.map((record) => record.uuid)).toEqual([
        'u1',
        'u2',
        'checkpoint-dup',
      ]);
    });

    it('rejects a checkpoint that is no longer on the active chain', async () => {
      const oldId = '11111111-1111-1111-1111-111111111114';
      const newId = '22222222-2222-2222-2222-222222222225';
      const { file, lines } = seedSession(oldId);
      fs.writeFileSync(
        file,
        [
          ...lines,
          {
            uuid: 'inactive-checkpoint',
            parentUuid: 'u2',
            sessionId: oldId,
            type: 'system',
            subtype: 'branch_checkpoint',
            timestamp: '2026-04-22T00:00:02.000Z',
            cwd,
            version: 'test',
            systemPayload: {
              v: 1,
              startExclusiveRecordUuid: null,
              assistantRecordUuid: 'u2',
            },
          },
          {
            uuid: 'active-sibling',
            parentUuid: 'u2',
            sessionId: oldId,
            type: 'user',
            timestamp: '2026-04-22T00:00:03.000Z',
            cwd,
            version: 'test',
            message: { role: 'user', parts: [{ text: 'active sibling' }] },
          },
        ]
          .map((record) => JSON.stringify(record))
          .join('\n') + '\n',
      );

      await expect(
        service.forkSession(oldId, newId, {
          atRecordId: 'inactive-checkpoint',
        }),
      ).rejects.toMatchObject({ name: 'BranchPointInvalidError' });
      expect(
        fs.existsSync(
          realPath.join(
            service['storage'].getProjectDir(),
            'chats',
            `${newId}.jsonl`,
          ),
        ),
      ).toBe(false);
    });

    it('does not resurrect artifacts removed by later side records when forking', async () => {
      const oldId = '72727272-7272-7272-7272-727272727272';
      const newId = '82828282-8282-8282-8282-828282828282';
      const { file, lines } = seedSession(oldId);
      const url = 'https://example.com/forked-then-removed';
      const oldArtifactId = stableSessionArtifactId(oldId, `url:${url}`);
      const forkedArtifactId = stableSessionArtifactId(newId, `url:${url}`);
      const createRecord = {
        uuid: 'artifact-create',
        parentUuid: 'u1',
        sessionId: oldId,
        type: 'system',
        subtype: 'session_artifact_event',
        timestamp: '2026-04-22T00:00:00.500Z',
        cwd,
        version: 'test',
        systemPayload: {
          v: SESSION_ARTIFACT_PERSISTENCE_VERSION,
          sessionId: oldId,
          sequence: 1,
          recordedAt: '2026-04-22T00:00:00.500Z',
          changes: [
            {
              action: 'created',
              artifactId: oldArtifactId,
              artifact: {
                id: oldArtifactId,
                kind: 'link',
                storage: 'external_url',
                source: 'client',
                status: 'available',
                title: 'Forked artifact',
                url,
                retention: 'restorable',
                clientRetained: true,
                createdAt: '2026-04-22T00:00:00.500Z',
                updatedAt: '2026-04-22T00:00:00.500Z',
                persistedAt: '2026-04-22T00:00:00.500Z',
              },
            },
          ],
        },
      };
      const removeRecord = {
        uuid: 'artifact-remove',
        parentUuid: 'u1',
        sessionId: oldId,
        type: 'system',
        subtype: 'session_artifact_event',
        timestamp: '2026-04-22T00:00:00.750Z',
        cwd,
        version: 'test',
        systemPayload: {
          v: SESSION_ARTIFACT_PERSISTENCE_VERSION,
          sessionId: oldId,
          sequence: 2,
          recordedAt: '2026-04-22T00:00:00.750Z',
          changes: [
            {
              action: 'removed',
              artifactId: oldArtifactId,
              reason: 'explicit',
            },
          ],
        },
      };
      fs.writeFileSync(
        file,
        [lines[0], createRecord, removeRecord, lines[1]]
          .map((line) => JSON.stringify(line))
          .join('\n') + '\n',
      );

      const result = await service.forkSession(oldId, newId);
      const loaded = await service.loadSession(newId);
      const forkedLines = fs
        .readFileSync(result.filePath, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      const forkedRemovePayload = forkedLines.find(
        (record) => record.uuid === 'artifact-remove',
      )?.systemPayload;

      expect(result.copiedCount).toBe(4);
      expect(loaded?.artifactSnapshot?.artifacts).toEqual([]);
      expect(loaded?.artifactSnapshot?.tombstonedIds).toContain(
        forkedArtifactId,
      );
      expect(forkedRemovePayload).toMatchObject({
        changes: [
          {
            action: 'removed',
            artifactId: forkedArtifactId,
            reason: 'explicit',
          },
        ],
      });
    });

    it('preserves file history snapshots on the forked session', async () => {
      const oldId = '31313131-3131-3131-3131-313131313131';
      const newId = '41414141-4141-4141-4141-414141414141';
      const { file, lines } = seedSession(oldId);
      const snapshotRecord = {
        uuid: 'snapshot-1',
        parentUuid: 'u2',
        sessionId: oldId,
        type: 'system',
        subtype: 'file_history_snapshot',
        timestamp: '2026-04-22T00:00:02.000Z',
        cwd,
        version: 'test',
        systemPayload: {
          snapshots: [
            {
              promptId: `${oldId}########0`,
              timestamp: '2026-04-22T00:00:00.000Z',
              trackedFileBackups: {
                'a.txt': {
                  backupFileName: 'backup-a',
                  version: 1,
                  backupTime: '2026-04-22T00:00:00.000Z',
                },
              },
            },
          ],
        },
      };
      fs.writeFileSync(
        file,
        [...lines, snapshotRecord].map((l) => JSON.stringify(l)).join('\n') +
          '\n',
      );
      const sourceBackupDir = realPath.join(realTmpDir, 'file-history', oldId);
      fs.mkdirSync(sourceBackupDir, { recursive: true });
      fs.writeFileSync(realPath.join(sourceBackupDir, 'backup-a'), 'content');

      await service.forkSession(oldId, newId);
      const loaded = await service.loadSession(newId);

      expect(loaded?.fileHistorySnapshots).toHaveLength(1);
      expect(loaded?.fileHistorySnapshots?.[0]?.promptId).toBe(
        `${newId}########0`,
      );
    });

    it.runIf(process.platform !== 'win32')(
      'preserves file-history backup modes on the forked session',
      async () => {
        const oldId = '31313131-3131-3131-3131-313131313139';
        const newId = '41414141-4141-4141-4141-414141414149';
        const { file, lines } = seedSession(oldId);
        appendFileHistorySnapshot(oldId, file, lines, ['backup-mode']);
        const sourceBackupDir = realPath.join(
          realTmpDir,
          'file-history',
          oldId,
        );
        const sourceBackupPath = realPath.join(sourceBackupDir, 'backup-mode');
        const targetBackupPath = realPath.join(
          realTmpDir,
          'file-history',
          newId,
          'backup-mode',
        );
        fs.mkdirSync(sourceBackupDir, { recursive: true });
        fs.writeFileSync(sourceBackupPath, 'content');
        fs.chmodSync(sourceBackupPath, 0o755);

        await service.forkSession(oldId, newId);

        expect(fs.statSync(targetBackupPath).mode & 0o777).toBe(0o755);
      },
    );

    it('publishes only backups referenced by the bounded transcript', async () => {
      const oldId = '31313131-3131-3131-3131-313131313133';
      const newId = '41414141-4141-4141-4141-414141414143';
      const { file, lines } = seedSession(oldId);
      const snapshot = (
        uuid: string,
        parentUuid: string,
        backupFileName: string,
        promptId: string,
      ) => ({
        uuid,
        parentUuid,
        sessionId: oldId,
        type: 'system',
        subtype: 'file_history_snapshot',
        timestamp: '2026-04-22T00:00:02.000Z',
        cwd,
        version: 'test',
        systemPayload: {
          snapshots: [
            {
              promptId,
              timestamp: '2026-04-22T00:00:00.000Z',
              trackedFileBackups: {
                'file-0.txt': {
                  backupFileName,
                  version: 1,
                  backupTime: '2026-04-22T00:00:00.000Z',
                },
              },
            },
          ],
        },
      });
      // The turn's snapshot sits on the active chain ahead of the
      // checkpoint (the recorder appends it before the checkpoint
      // transaction), and a LATER snapshot follows the checkpoint. Its
      // backup must not leak into the historical fork: transcript
      // truncation has to happen before backup selection.
      const checkpoint = {
        uuid: 'checkpoint-bounded',
        parentUuid: 'snapshot-before',
        sessionId: oldId,
        type: 'system',
        subtype: 'branch_checkpoint',
        timestamp: '2026-04-22T00:00:03.000Z',
        cwd,
        version: 'test',
        systemPayload: {
          v: 1,
          startExclusiveRecordUuid: null,
          assistantRecordUuid: 'u2',
        },
      };
      fs.writeFileSync(
        file,
        [
          ...lines,
          snapshot('snapshot-before', 'u2', 'backup-a', `${oldId}########0`),
          checkpoint,
          {
            ...snapshot(
              'snapshot-after',
              'checkpoint-bounded',
              'later-backup',
              `${oldId}########1`,
            ),
            timestamp: '2026-04-22T00:00:04.000Z',
          },
        ]
          .map((record) => JSON.stringify(record))
          .join('\n') + '\n',
      );
      const sourceBackupDir = realPath.join(realTmpDir, 'file-history', oldId);
      const targetBackupDir = realPath.join(realTmpDir, 'file-history', newId);
      fs.mkdirSync(sourceBackupDir, { recursive: true });
      fs.writeFileSync(realPath.join(sourceBackupDir, 'backup-a'), 'kept');
      fs.writeFileSync(
        realPath.join(sourceBackupDir, 'later-backup'),
        'created after the checkpoint',
      );
      fs.writeFileSync(
        realPath.join(sourceBackupDir, 'unreferenced-backup'),
        'not copied',
      );

      await service.forkSession(oldId, newId, {
        atRecordId: checkpoint.uuid,
      });

      expect(fs.readdirSync(targetBackupDir)).toEqual(['backup-a']);
    });

    it('retains pre-checkpoint artifacts without leaking later ones', async () => {
      const oldId = '31313131-3131-3131-3131-313131313138';
      const newId = '41414141-4141-4141-4141-414141414148';
      const { file, lines } = seedSession(oldId);
      const checkpoint = {
        uuid: 'checkpoint-artifact',
        parentUuid: 'u2',
        sessionId: oldId,
        type: 'system',
        subtype: 'branch_checkpoint',
        timestamp: '2026-04-22T00:00:03.000Z',
        cwd,
        version: 'test',
        systemPayload: {
          v: 1,
          startExclusiveRecordUuid: null,
          assistantRecordUuid: 'u2',
        },
      };
      const artifactId = stableSessionArtifactId(
        oldId,
        'url:https://example.com/after-checkpoint',
      );
      const earlyArtifactId = stableSessionArtifactId(
        oldId,
        'url:https://example.com/before-checkpoint',
      );
      const earlyArtifact = {
        uuid: 'artifact-early',
        parentUuid: 'u2',
        sessionId: oldId,
        type: 'system',
        subtype: 'session_artifact_event',
        timestamp: '2026-04-22T00:00:02.500Z',
        cwd,
        version: 'test',
        systemPayload: {
          v: SESSION_ARTIFACT_PERSISTENCE_VERSION,
          sessionId: oldId,
          sequence: 1,
          recordedAt: '2026-04-22T00:00:02.500Z',
          changes: [
            {
              action: 'created',
              artifactId: earlyArtifactId,
              artifact: {
                id: earlyArtifactId,
                kind: 'link',
                storage: 'external_url',
                source: 'client',
                status: 'available',
                title: 'Early artifact',
                url: 'https://example.com/before-checkpoint',
                retention: 'restorable',
                clientRetained: true,
                createdAt: '2026-04-22T00:00:02.500Z',
                updatedAt: '2026-04-22T00:00:02.500Z',
                persistedAt: '2026-04-22T00:00:02.500Z',
              },
            },
          ],
        },
      };
      const lateArtifact = {
        uuid: 'artifact-late',
        parentUuid: 'checkpoint-artifact',
        sessionId: oldId,
        type: 'system',
        subtype: 'session_artifact_event',
        timestamp: '2026-04-22T00:00:04.000Z',
        cwd,
        version: 'test',
        systemPayload: {
          v: SESSION_ARTIFACT_PERSISTENCE_VERSION,
          sessionId: oldId,
          sequence: 1,
          recordedAt: '2026-04-22T00:00:04.000Z',
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
                title: 'Late artifact',
                url: 'https://example.com/after-checkpoint',
                retention: 'restorable',
                clientRetained: true,
                createdAt: '2026-04-22T00:00:04.000Z',
                updatedAt: '2026-04-22T00:00:04.000Z',
                persistedAt: '2026-04-22T00:00:04.000Z',
              },
            },
          ],
        },
      };
      fs.writeFileSync(
        file,
        [...lines, earlyArtifact, checkpoint, lateArtifact]
          .map((record) => JSON.stringify(record))
          .join('\n') + '\n',
      );

      const result = await service.forkSession(oldId, newId, {
        atRecordId: checkpoint.uuid,
      });

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
      const oldId = '31313131-3131-3131-3131-313131313134';
      const newId = '41414141-4141-4141-4141-414141414144';
      const warnings: string[] = [];
      service = new SessionService(cwd, {
        onWarning: (message) => warnings.push(message),
      });
      const { file, lines } = seedSession(oldId);
      appendFileHistorySnapshot(oldId, file, lines, [
        'backup-present',
        'backup-missing',
      ]);
      const sourceBackupDir = realPath.join(realTmpDir, 'file-history', oldId);
      const targetBackupDir = realPath.join(realTmpDir, 'file-history', newId);
      const targetTranscript = realPath.join(
        service['storage'].getProjectDir(),
        'chats',
        `${newId}.jsonl`,
      );
      fs.mkdirSync(sourceBackupDir, { recursive: true });
      fs.writeFileSync(
        realPath.join(sourceBackupDir, 'backup-present'),
        'copied first',
      );

      await expect(service.forkSession(oldId, newId)).resolves.toMatchObject({
        filePath: targetTranscript,
      });

      expect(fs.existsSync(targetTranscript)).toBe(true);
      expect(fs.readdirSync(targetBackupDir)).toEqual(['backup-present']);
      expect(warnings).toEqual([
        expect.stringContaining(
          'omitted missing file-history backup backup-missing',
        ),
      ]);
    });

    it('omits dot file-history backup names instead of failing the fork', async () => {
      const oldId = '31313131-3131-3131-3131-313131313137';
      const newId = '41414141-4141-4141-4141-414141414147';
      const { file, lines } = seedSession(oldId);
      appendFileHistorySnapshot(oldId, file, lines, ['.', '..', 'backup-ok']);
      const sourceBackupDir = realPath.join(realTmpDir, 'file-history', oldId);
      const targetBackupDir = realPath.join(realTmpDir, 'file-history', newId);
      fs.mkdirSync(sourceBackupDir, { recursive: true });
      fs.writeFileSync(realPath.join(sourceBackupDir, 'backup-ok'), 'content');

      await expect(service.forkSession(oldId, newId)).resolves.toBeDefined();

      expect(fs.readdirSync(targetBackupDir)).toEqual(['backup-ok']);
    });

    it('leaves no visible target after an existing backup cannot be copied', async () => {
      const oldId = '31313131-3131-3131-3131-313131313135';
      const newId = '41414141-4141-4141-4141-414141414145';
      const { file, lines } = seedSession(oldId);
      appendFileHistorySnapshot(oldId, file, lines, [
        'backup-present',
        'backup-copy-fails',
      ]);
      const sourceBackupDir = realPath.join(realTmpDir, 'file-history', oldId);
      const targetBackupDir = realPath.join(realTmpDir, 'file-history', newId);
      const targetTranscript = realPath.join(
        service['storage'].getProjectDir(),
        'chats',
        `${newId}.jsonl`,
      );
      fs.mkdirSync(sourceBackupDir, { recursive: true });
      fs.writeFileSync(
        realPath.join(sourceBackupDir, 'backup-present'),
        'copied first',
      );
      fs.writeFileSync(
        realPath.join(sourceBackupDir, 'backup-copy-fails'),
        'cannot copy',
      );
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
        await expect(service.forkSession(oldId, newId)).rejects.toThrow(
          'backup copy failed',
        );
      } finally {
        openSpy.mockRestore();
      }

      expect(fs.existsSync(targetTranscript)).toBe(false);
      expect(fs.existsSync(targetBackupDir)).toBe(false);
      expect(
        fs
          .readdirSync(realPath.join(realTmpDir, 'file-history'))
          .some((name) => name.includes(newId)),
      ).toBe(false);
    });

    it('does not follow a file-history backup symlink', async () => {
      const oldId = '31313131-3131-3131-3131-313131313136';
      const newId = '41414141-4141-4141-4141-414141414146';
      const warnings: string[] = [];
      service = new SessionService(cwd, {
        onWarning: (message) => warnings.push(message),
      });
      const { file, lines } = seedSession(oldId);
      appendFileHistorySnapshot(oldId, file, lines, ['backup-symlink']);
      const sourceBackupDir = realPath.join(realTmpDir, 'file-history', oldId);
      const targetBackupDir = realPath.join(realTmpDir, 'file-history', newId);
      fs.mkdirSync(sourceBackupDir, { recursive: true });
      const outside = realPath.join(realTmpDir, 'outside-backup');
      fs.writeFileSync(outside, 'outside content');
      fs.symlinkSync(outside, realPath.join(sourceBackupDir, 'backup-symlink'));

      await expect(service.forkSession(oldId, newId)).resolves.toBeDefined();

      expect(fs.existsSync(targetBackupDir)).toBe(false);
      expect(warnings).toEqual([
        expect.stringContaining(
          'omitted missing file-history backup backup-symlink',
        ),
      ]);
    });

    it('preserves a backup target that appears immediately before publication', async () => {
      const oldId = '31313131-3131-3131-3131-313131313137';
      const newId = '41414141-4141-4141-4141-414141414147';
      const { file, lines } = seedSession(oldId);
      appendFileHistorySnapshot(oldId, file, lines, ['backup-collision']);
      const chatsDir = realPath.join(
        service['storage'].getProjectDir(),
        'chats',
      );
      const sourceBackupDir = realPath.join(realTmpDir, 'file-history', oldId);
      const targetBackupDir = realPath.join(realTmpDir, 'file-history', newId);
      const targetTranscript = realPath.join(chatsDir, `${newId}.jsonl`);
      fs.mkdirSync(sourceBackupDir, { recursive: true });
      fs.writeFileSync(
        realPath.join(sourceBackupDir, 'backup-collision'),
        'source content',
      );
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
            const error = new Error(
              'backup target appeared',
            ) as NodeJS.ErrnoException;
            error.code = 'EEXIST';
            throw error;
          }
          return realRename(source, target);
        });

      try {
        await expect(service.forkSession(oldId, newId)).rejects.toMatchObject({
          code: 'EEXIST',
        });
      } finally {
        renameSpy.mockRestore();
      }

      expect(fs.existsSync(targetTranscript)).toBe(false);
      expect(
        fs.readFileSync(
          realPath.join(targetBackupDir, 'foreign-sentinel'),
          'utf8',
        ),
      ).toBe('foreign content');
      expect(
        fs
          .readdirSync(chatsDir)
          .some(
            (name) => name.startsWith(`.${newId}.`) && name.endsWith('.tmp'),
          ),
      ).toBe(false);
      expect(
        fs
          .readdirSync(realPath.join(realTmpDir, 'file-history'))
          .some(
            (name) => name.startsWith(`.${newId}.`) && name.endsWith('.tmp'),
          ),
      ).toBe(false);
    });

    it('removes copied file-history backups when deleting a fork', async () => {
      const oldId = '31313131-3131-3131-3131-313131313132';
      const newId = '41414141-4141-4141-4141-414141414142';
      const { file, lines } = seedSession(oldId);
      const sourceBackupDir = realPath.join(realTmpDir, 'file-history', oldId);
      const targetBackupDir = realPath.join(realTmpDir, 'file-history', newId);
      fs.mkdirSync(sourceBackupDir, { recursive: true });
      fs.writeFileSync(realPath.join(sourceBackupDir, 'backup-a'), 'content');
      fs.writeFileSync(
        file,
        [
          ...lines,
          {
            uuid: 'snapshot-1',
            parentUuid: 'u2',
            sessionId: oldId,
            type: 'system',
            subtype: 'file_history_snapshot',
            timestamp: '2026-04-22T00:00:02.000Z',
            cwd,
            version: 'test',
            systemPayload: {
              snapshots: [
                {
                  promptId: `${oldId}########0`,
                  timestamp: '2026-04-22T00:00:00.000Z',
                  trackedFileBackups: {
                    'a.txt': {
                      backupFileName: 'backup-a',
                      version: 1,
                      backupTime: '2026-04-22T00:00:00.000Z',
                    },
                  },
                },
              ],
            },
          },
        ]
          .map((record) => JSON.stringify(record))
          .join('\n') + '\n',
      );

      await service.forkSession(oldId, newId);
      expect(fs.existsSync(realPath.join(targetBackupDir, 'backup-a'))).toBe(
        true,
      );

      await expect(service.removeSession(newId)).resolves.toBe(true);
      expect(fs.existsSync(targetBackupDir)).toBe(false);
      expect(fs.existsSync(sourceBackupDir)).toBe(true);
    });

    it('forks only the active branch after rewind', async () => {
      const oldId = '12121212-1212-1212-1212-121212121212';
      const newId = '34343434-3434-3434-3434-343434343434';
      const chatsDir = realPath.join(
        service['storage'].getProjectDir(),
        'chats',
      );
      fs.mkdirSync(chatsDir, { recursive: true });
      fs.writeFileSync(
        realPath.join(chatsDir, `${oldId}.jsonl`),
        [
          {
            uuid: 'u1',
            parentUuid: null,
            sessionId: oldId,
            type: 'user',
            timestamp: '2026-04-22T00:00:00.000Z',
            cwd,
            version: 'test',
            message: { role: 'user', parts: [{ text: 'first' }] },
          },
          {
            uuid: 'u2',
            parentUuid: 'u1',
            sessionId: oldId,
            type: 'assistant',
            timestamp: '2026-04-22T00:00:01.000Z',
            cwd,
            version: 'test',
            message: { role: 'model', parts: [{ text: 'first reply' }] },
          },
          {
            uuid: 'u3',
            parentUuid: 'u2',
            sessionId: oldId,
            type: 'user',
            timestamp: '2026-04-22T00:00:02.000Z',
            cwd,
            version: 'test',
            message: { role: 'user', parts: [{ text: 'second' }] },
          },
          {
            uuid: 'u4',
            parentUuid: 'u3',
            sessionId: oldId,
            type: 'assistant',
            timestamp: '2026-04-22T00:00:03.000Z',
            cwd,
            version: 'test',
            message: { role: 'model', parts: [{ text: 'second reply' }] },
          },
          {
            uuid: 'rewind-1',
            parentUuid: 'u2',
            sessionId: oldId,
            type: 'system',
            subtype: 'rewind',
            timestamp: '2026-04-22T00:00:04.000Z',
            cwd,
            version: 'test',
            systemPayload: { targetTurnIndex: 1, truncatedCount: 2 },
          },
        ]
          .map((line) => JSON.stringify(line))
          .join('\n') + '\n',
      );

      const result = await service.forkSession(oldId, newId);
      const loaded = await service.loadSession(newId);

      expect(result.copiedCount).toBe(3);
      expect(
        loaded?.conversation.messages.flatMap(
          (message) => message.message?.parts?.map((part) => part.text) ?? [],
        ),
      ).toEqual(['first', 'first reply']);
    });

    it('throws when the source session does not exist', async () => {
      const oldId = '33333333-3333-3333-3333-333333333333';
      const newId = '44444444-4444-4444-4444-444444444444';
      await expect(service.forkSession(oldId, newId)).rejects.toThrow();
    });

    it('throws when the target session file already exists', async () => {
      const oldId = '55555555-5555-5555-5555-555555555555';
      const newId = '66666666-6666-6666-6666-666666666666';
      seedSession(oldId);
      const chatsDir = realPath.join(
        service['storage'].getProjectDir(),
        'chats',
      );
      fs.writeFileSync(realPath.join(chatsDir, `${newId}.jsonl`), 'x');

      await expect(service.forkSession(oldId, newId)).rejects.toThrow(
        /already exists/,
      );
    });

    it.each(['ENOTSUP', 'EPERM', 'EXDEV'] as const)(
      'falls back to rename when transcript hard links fail with %s',
      async (causeCode) => {
        const oldId = '55555555-5555-5555-5555-555555555559';
        const newId = '66666666-6666-6666-6666-666666666673';
        seedSession(oldId);
        const chatsDir = realPath.join(
          service['storage'].getProjectDir(),
          'chats',
        );
        const targetPath = realPath.join(chatsDir, `${newId}.jsonl`);
        const realLink = fs.promises.link;
        const linkSpy = vi
          .spyOn(fs.promises, 'link')
          .mockImplementation(async (source, target) => {
            if (target === targetPath) {
              const error = new Error(
                'hard links are unsupported',
              ) as NodeJS.ErrnoException;
              error.code = causeCode;
              throw error;
            }
            return realLink(source, target);
          });

        try {
          await expect(
            service.forkSession(oldId, newId),
          ).resolves.toMatchObject({ filePath: targetPath });
        } finally {
          linkSpy.mockRestore();
        }

        expect(fs.existsSync(targetPath)).toBe(true);
        expect(await service.loadSession(newId)).toBeDefined();
      },
    );

    it('removes published backups when transcript publication fails', async () => {
      const oldId = '55555555-5555-5555-5555-555555555563';
      const newId = '66666666-6666-6666-6666-666666666681';
      const { file, lines } = seedSession(oldId);
      appendFileHistorySnapshot(oldId, file, lines, ['backup-orphan']);
      const sourceBackupDir = realPath.join(realTmpDir, 'file-history', oldId);
      const targetBackupDir = realPath.join(realTmpDir, 'file-history', newId);
      fs.mkdirSync(sourceBackupDir, { recursive: true });
      fs.writeFileSync(
        realPath.join(sourceBackupDir, 'backup-orphan'),
        'backup content',
      );
      const chatsDir = realPath.join(
        service['storage'].getProjectDir(),
        'chats',
      );
      const targetTranscript = realPath.join(chatsDir, `${newId}.jsonl`);
      const realRename = fs.promises.rename;
      const linkError = Object.assign(new Error('link failed'), {
        code: 'EIO',
      });
      const renameError = Object.assign(new Error('rename failed'), {
        code: 'EIO',
      });
      const linkSpy = vi
        .spyOn(fs.promises, 'link')
        .mockRejectedValue(linkError);
      const renameSpy = vi
        .spyOn(fs.promises, 'rename')
        .mockImplementation(async (source, target) => {
          if (String(target) === targetTranscript) throw renameError;
          return realRename(source, target);
        });

      try {
        await expect(service.forkSession(oldId, newId)).rejects.toBe(
          renameError,
        );
      } finally {
        linkSpy.mockRestore();
        renameSpy.mockRestore();
      }

      expect(fs.existsSync(targetTranscript)).toBe(false);
      expect(fs.existsSync(targetBackupDir)).toBe(false);
    });

    it('removes a partially written target when fork creation fails', async () => {
      const oldId = '55555555-5555-5555-5555-555555555556';
      const newId = '66666666-6666-6666-6666-666666666667';
      seedSession(oldId);
      const chatsDir = realPath.join(
        service['storage'].getProjectDir(),
        'chats',
      );
      const targetPath = realPath.join(chatsDir, `${newId}.jsonl`);
      // Fail AFTER a partial write lands on disk so the cleanup path is the
      // thing under test (an open-time failure would leave nothing to clean).
      const realOpen = fs.promises.open;
      const openSpy = vi
        .spyOn(fs.promises, 'open')
        .mockImplementation(async (...args) => {
          const handle = await realOpen(...args);
          if (
            !String(args[0]).startsWith(realPath.join(chatsDir, `.${newId}.`))
          ) {
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
        await expect(service.forkSession(oldId, newId)).rejects.toThrow(
          'disk full',
        );
      } finally {
        openSpy.mockRestore();
      }
      expect(fs.existsSync(targetPath)).toBe(false);
      expect(
        fs.readdirSync(chatsDir).some((name) => name.startsWith(`.${newId}.`)),
      ).toBe(false);
    });

    it.skipIf(process.platform === 'win32')(
      'preserves a committed titled session when final directory fsync fails',
      async () => {
        const oldId = '55555555-5555-5555-5555-555555555557';
        const newId = '66666666-6666-6666-6666-666666666671';
        const warnings: string[] = [];
        service = new SessionService(cwd, {
          onWarning: (message) => warnings.push(message),
        });
        seedSession(oldId);
        const chatsDir = realPath.join(
          service['storage'].getProjectDir(),
          'chats',
        );
        const targetPath = realPath.join(chatsDir, `${newId}.jsonl`);
        const realOpen = fs.promises.open;
        const openSpy = vi
          .spyOn(fs.promises, 'open')
          .mockImplementation(
            async (
              filePath: fs.PathLike,
              flags?: string | number,
              mode?: fs.Mode,
            ) => {
              if (
                filePath === chatsDir &&
                flags === 'r' &&
                fs.existsSync(targetPath)
              ) {
                throw new Error('directory fsync failed');
              }
              return realOpen(filePath, flags, mode);
            },
          );

        try {
          await expect(
            service.forkSession(oldId, newId, { title: 'Durable branch' }),
          ).resolves.toMatchObject({ filePath: targetPath });
        } finally {
          openSpy.mockRestore();
        }

        expect(fs.existsSync(targetPath)).toBe(true);
        expect(service.getSessionTitle(newId)).toBe('Durable branch');
        expect(warnings).toEqual([
          expect.stringContaining(`branch committed session=${newId}`),
        ]);
      },
    );

    it('throws when the source session belongs to a different project', async () => {
      // Defensive guard: a file can physically sit in this project's chats
      // dir but carry a record whose cwd hashes to a different project
      // (manual file move, corrupted state). Fork must refuse rather than
      // silently cross project boundaries.
      const oldId = '77777777-7777-7777-7777-777777777777';
      const newId = '88888888-8888-8888-8888-888888888888';
      const chatsDir = realPath.join(
        service['storage'].getProjectDir(),
        'chats',
      );
      fs.mkdirSync(chatsDir, { recursive: true });
      fs.writeFileSync(
        realPath.join(chatsDir, `${oldId}.jsonl`),
        JSON.stringify({
          uuid: 'u1',
          parentUuid: null,
          sessionId: oldId,
          type: 'user',
          timestamp: '2026-04-22T00:00:00.000Z',
          cwd: '/some/other/project',
          version: 'test',
          message: { role: 'user', parts: [{ text: 'hi' }] },
        }) + '\n',
      );

      await expect(service.forkSession(oldId, newId)).rejects.toThrow(
        /does not belong to current project/,
      );
    });

    it('forks a migrated session when runtime status matches this project', async () => {
      const oldId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
      const newId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
      seedSession(oldId, realPath.join(realTmpDir, 'old-project'));
      vi.mocked(readRuntimeStatus).mockResolvedValue({
        schemaVersion: 1,
        pid: 123,
        sessionId: oldId,
        workDir: cwd,
        hostname: 'host',
        startedAt: 1,
        qwenVersion: null,
      });

      const result = await service.forkSession(oldId, newId);

      expect(result.copiedCount).toBe(2);
      expect(fs.existsSync(result.filePath)).toBe(true);
      const written = fs
        .readFileSync(result.filePath, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l));
      expect(written.every((r) => r.cwd === cwd)).toBe(true);
      await expect(service.loadSession(newId)).resolves.toBeDefined();
    });

    it('rejects invalid sessionId patterns before touching disk', async () => {
      const valid = '99999999-9999-9999-9999-999999999999';
      await expect(service.forkSession('bogus', valid)).rejects.toThrow(
        /Invalid source sessionId/,
      );
      await expect(service.forkSession(valid, 'bogus')).rejects.toThrow(
        /Invalid new sessionId/,
      );
    });

    it('drops creation metadata so the fork inherits no lineage or source', async () => {
      // A fork is a fresh top-level session, not a sub-session. Copying the
      // source's parent_session record would make the fork report the original's
      // parent as its own. Seed the parent_session record on the active branch
      // (u1 -> parent_session -> u2) so it would otherwise be copied.
      const oldId = 'aaaaaaaa-1111-1111-1111-111111111111';
      const newId = 'bbbbbbbb-2222-2222-2222-222222222222';
      const chatsDir = realPath.join(
        service['storage'].getProjectDir(),
        'chats',
      );
      fs.mkdirSync(chatsDir, { recursive: true });
      const srcFile = realPath.join(chatsDir, `${oldId}.jsonl`);
      const lines: Array<Record<string, unknown>> = [
        {
          uuid: 'u1',
          parentUuid: null,
          sessionId: oldId,
          type: 'user',
          timestamp: '2026-04-22T00:00:00.000Z',
          cwd,
          version: 'test',
          message: { role: 'user', parts: [{ text: 'hello' }] },
        },
        {
          uuid: 'up',
          parentUuid: 'u1',
          sessionId: oldId,
          type: 'system',
          subtype: 'parent_session',
          timestamp: '2026-04-22T00:00:00.500Z',
          cwd,
          version: 'test',
          systemPayload: { parentSessionId: 'P' },
        },
        {
          uuid: 'u2',
          parentUuid: 'us',
          sessionId: oldId,
          type: 'assistant',
          timestamp: '2026-04-22T00:00:01.000Z',
          cwd,
          version: 'test',
          message: { role: 'model', parts: [{ text: 'hi' }] },
        },
      ];
      lines.splice(2, 0, {
        uuid: 'us',
        parentUuid: 'up',
        sessionId: oldId,
        type: 'system',
        subtype: 'session_source',
        timestamp: '2026-04-22T00:00:00.750Z',
        cwd,
        version: 'test',
        systemPayload: {
          sourceType: 'scheduled_task',
          sourceId: 'task-123',
        },
      });
      const artifactId = stableSessionArtifactId(
        oldId,
        'url:https://example.com/after-source-metadata',
      );
      lines.splice(3, 0, {
        uuid: 'artifact-after-source',
        parentUuid: 'us',
        sessionId: oldId,
        type: 'system',
        subtype: 'session_artifact_event',
        timestamp: '2026-04-22T00:00:00.800Z',
        cwd,
        version: 'test',
        systemPayload: {
          v: SESSION_ARTIFACT_PERSISTENCE_VERSION,
          sessionId: oldId,
          sequence: 1,
          recordedAt: '2026-04-22T00:00:00.800Z',
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
                title: 'Retained artifact',
                url: 'https://example.com/after-source-metadata',
                retention: 'restorable',
                clientRetained: true,
                createdAt: '2026-04-22T00:00:00.800Z',
                updatedAt: '2026-04-22T00:00:00.800Z',
                persistedAt: '2026-04-22T00:00:00.800Z',
              },
            },
          ],
        },
      });
      fs.writeFileSync(
        srcFile,
        lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
      );

      const result = await service.forkSession(oldId, newId);

      const written = fs
        .readFileSync(result.filePath, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l));
      expect(
        written.some(
          (r) => r.type === 'system' && r.subtype === 'parent_session',
        ),
      ).toBe(false);
      expect(
        written.some(
          (r) => r.type === 'system' && r.subtype === 'session_source',
        ),
      ).toBe(false);

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
    // Uses real disk like forkSession — readSessionTitleInfoFromFile reads
    // the file tail for the custom_title record, so mocks would defeat the
    // method. Mirrors the forkSession describe's setup verbatim so the tmp
    // sandbox + un-mocked path/jsonl utilities are in place.
    let realTmpDir: string;
    let realPath: typeof import('node:path');
    let service: SessionService;
    let cwd: string;

    beforeEach(async () => {
      const realOs = await import('node:os');
      realPath = await vi.importActual<typeof import('node:path')>('node:path');
      const actualPaths =
        await vi.importActual<typeof import('../utils/paths.js')>(
          '../utils/paths.js',
        );
      const actualJsonl = await vi.importActual<
        typeof import('../utils/jsonl-utils.js')
      >('../utils/jsonl-utils.js');

      vi.mocked(path.join).mockImplementation(
        realPath.join as unknown as typeof path.join,
      );
      vi.mocked(path.dirname).mockImplementation(
        realPath.dirname as unknown as typeof path.dirname,
      );
      vi.mocked(path.isAbsolute).mockImplementation(
        realPath.isAbsolute as unknown as typeof path.isAbsolute,
      );
      vi.mocked(path.resolve).mockImplementation(
        realPath.resolve as unknown as typeof path.resolve,
      );
      vi.mocked(getProjectHash).mockImplementation(actualPaths.getProjectHash);
      const mockedPaths = (await import('../utils/paths.js')) as unknown as {
        sanitizeCwd: (cwd: string) => string;
      };
      mockedPaths.sanitizeCwd = actualPaths.sanitizeCwd;
      vi.mocked(jsonl.read).mockImplementation(actualJsonl.read);
      vi.mocked(jsonl.readLines).mockImplementation(actualJsonl.readLines);

      vi.mocked(readdirSyncSpy).mockRestore?.();
      vi.mocked(statSyncSpy).mockRestore?.();
      vi.mocked(statPromiseSpy).mockRestore?.();
      vi.mocked(unlinkSyncSpy).mockRestore?.();
      vi.mocked(rmSyncSpy).mockRestore?.();

      realTmpDir = fs.mkdtempSync(
        realPath.join(realOs.tmpdir(), 'find-titles-prefix-'),
      );
      process.env['QWEN_RUNTIME_DIR'] = realTmpDir;
      cwd = process.cwd();
      service = new SessionService(cwd);
    });

    afterEach(() => {
      delete process.env['QWEN_RUNTIME_DIR'];
      try {
        fs.rmSync(realTmpDir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    });

    const seedSessionWithTitle = (
      sessionId: string,
      title: string,
      sessionCwd: string = cwd,
      state: 'active' | 'archived' = 'active',
    ) => {
      const chatsDir = realPath.join(
        service['storage'].getProjectDir(),
        'chats',
        ...(state === 'archived' ? ['archive'] : []),
      );
      fs.mkdirSync(chatsDir, { recursive: true });
      const file = realPath.join(chatsDir, `${sessionId}.jsonl`);
      const lines = [
        {
          uuid: 'u1',
          parentUuid: null,
          sessionId,
          type: 'user',
          timestamp: '2026-04-22T00:00:00.000Z',
          cwd: sessionCwd,
          version: 'test',
          message: { role: 'user', parts: [{ text: 'hello' }] },
        },
        {
          uuid: 'u2',
          parentUuid: 'u1',
          sessionId,
          type: 'system',
          subtype: 'custom_title',
          timestamp: '2026-04-22T00:00:01.000Z',
          cwd: sessionCwd,
          version: 'test',
          systemPayload: { customTitle: title, titleSource: 'manual' },
        },
      ];
      fs.writeFileSync(
        file,
        lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
      );
      return file;
    };

    it('returns titles whose custom_title starts with the prefix (case-insensitive)', async () => {
      seedSessionWithTitle(
        '11111111-1111-1111-1111-111111111111',
        'my-branch(1)',
      );
      seedSessionWithTitle(
        '22222222-2222-2222-2222-222222222222',
        'My-Branch(2)',
      );
      seedSessionWithTitle(
        '33333333-3333-3333-3333-333333333333',
        'unrelated session',
      );

      const titles = await service.findSessionTitlesByPrefix('my-branch(');

      expect(new Set(titles)).toEqual(
        new Set(['my-branch(1)', 'My-Branch(2)']),
      );
      await expect(
        service.getSessionDisplayName('11111111-1111-1111-1111-111111111111'),
      ).resolves.toBe('my-branch(1)');
    });

    it('also returns titles from archived sessions, so unarchiving cannot surface a duplicate', async () => {
      seedSessionWithTitle(
        '11111111-1111-1111-1111-111111111111',
        'my-branch(1)',
      );
      seedSessionWithTitle(
        '22222222-2222-2222-2222-222222222222',
        'my-branch(2)',
        cwd,
        'archived',
      );

      const titles = await service.findSessionTitlesByPrefix('my-branch(');

      expect(new Set(titles)).toEqual(
        new Set(['my-branch(1)', 'my-branch(2)']),
      );
    });

    it('deduplicates a title held by the same session in both active and archived state', async () => {
      // getSessionLocation's 'conflict' state (reachable via an interrupted
      // move) leaves one session file in both chats/ and chats/archive/;
      // both scans read it and must not report its title twice.
      seedSessionWithTitle(
        '11111111-1111-1111-1111-111111111111',
        'my-branch(1)',
        cwd,
        'active',
      );
      seedSessionWithTitle(
        '11111111-1111-1111-1111-111111111111',
        'my-branch(1)',
        cwd,
        'archived',
      );

      const titles = await service.findSessionTitlesByPrefix('my-branch(');

      expect(titles).toEqual(['my-branch(1)']);
    });

    it('skips archived sessions from other projects (collisions stay project-scoped)', async () => {
      seedSessionWithTitle(
        '11111111-1111-1111-1111-111111111111',
        'shared(1)',
        cwd,
        'archived',
      );
      seedSessionWithTitle(
        '22222222-2222-2222-2222-222222222222',
        'shared(2)',
        '/some/other/project',
        'archived',
      );

      const titles = await service.findSessionTitlesByPrefix('shared(');
      expect(titles).toEqual(['shared(1)']);
    });

    it('computeUniqueBranchTitle skips a suffix already taken by an archived session', async () => {
      seedSessionWithTitle(
        '11111111-1111-1111-1111-111111111111',
        'my-branch(1)',
        cwd,
        'archived',
      );

      const title = await computeUniqueBranchTitle('my-branch', service);

      expect(title).toBe('my-branch(2)');
    });

    it('returns empty when chats directory does not exist', async () => {
      const titles = await service.findSessionTitlesByPrefix('anything');
      expect(titles).toEqual([]);
    });

    it('skips sessions from other projects (collisions are project-scoped)', async () => {
      seedSessionWithTitle(
        '11111111-1111-1111-1111-111111111111',
        'shared(1)',
        cwd,
      );
      // Same chats dir (sessions are stored under projectHash anyway), but
      // the record's cwd belongs to another project → must be skipped.
      seedSessionWithTitle(
        '22222222-2222-2222-2222-222222222222',
        'shared(2)',
        '/some/other/project',
      );

      const titles = await service.findSessionTitlesByPrefix('shared(');
      expect(titles).toEqual(['shared(1)']);
      await expect(
        service.getSessionDisplayName('22222222-2222-2222-2222-222222222222'),
      ).resolves.toBeUndefined();
    });

    it('returns undefined for an empty session file', async () => {
      const sessionId = '11111111-1111-1111-1111-111111111111';
      const chatsDir = realPath.join(
        service['storage'].getProjectDir(),
        'chats',
      );
      fs.mkdirSync(chatsDir, { recursive: true });
      fs.writeFileSync(realPath.join(chatsDir, `${sessionId}.jsonl`), '');

      await expect(service.getSessionDisplayName(sessionId)).resolves.toBe(
        undefined,
      );
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
      const sessionId = '11111111-1111-1111-1111-111111111111';
      const chatsDir = realPath.join(
        service['storage'].getProjectDir(),
        'chats',
      );
      fs.mkdirSync(chatsDir, { recursive: true });
      const file = realPath.join(chatsDir, `${sessionId}.jsonl`);
      fs.writeFileSync(
        file,
        JSON.stringify({
          uuid: 'u1',
          parentUuid: null,
          sessionId,
          type: 'user',
          timestamp: '2026-04-22T00:00:00.000Z',
          cwd,
          version: 'test',
          message: {
            role: 'user',
            parts: [{ text: '创建 MR 描述生成 Skill(1)' }],
          },
        }) + '\n',
      );

      const titles =
        await service.findSessionTitlesByPrefix('创建 MR 描述生成 Skill(');
      expect(titles).toEqual(['创建 MR 描述生成 Skill(1)']);
      expect(
        vi
          .mocked(jsonl.readLines)
          .mock.calls.filter(([filePath]) => filePath === file),
      ).toEqual([[file, 10]]);
      await expect(service.getSessionDisplayName(sessionId)).resolves.toBe(
        '创建 MR 描述生成 Skill(1)',
      );
    });

    it('uses the picker prompt for an archived session with no custom title', async () => {
      const sessionId = '11111111-1111-1111-1111-111111111111';
      const archiveDir = realPath.join(
        service['storage'].getProjectDir(),
        'chats',
        'archive',
      );
      fs.mkdirSync(archiveDir, { recursive: true });
      const file = realPath.join(archiveDir, `${sessionId}.jsonl`);
      fs.writeFileSync(
        file,
        JSON.stringify({
          uuid: 'u1',
          parentUuid: null,
          sessionId,
          type: 'user',
          timestamp: '2026-04-22T00:00:00.000Z',
          cwd,
          version: 'test',
          message: { role: 'user', parts: [{ text: 'archived-prompt(1)' }] },
        }) + '\n',
      );

      const titles =
        await service.findSessionTitlesByPrefix('archived-prompt(');
      expect(titles).toEqual(['archived-prompt(1)']);
    });
  });

  describe('unarchiveSessions title collision', () => {
    // Real disk again (see the findSessionTitlesByPrefix describe above):
    // exercising the actual retitle-then-move needs a real renameSync and a
    // real writeLineSync, neither of which that describe's setup restores
    // (it only needed read paths).
    let realTmpDir: string;
    let realPath: typeof import('node:path');
    let service: SessionService;
    let cwd: string;

    beforeEach(async () => {
      const realOs = await import('node:os');
      realPath = await vi.importActual<typeof import('node:path')>('node:path');
      const actualPaths =
        await vi.importActual<typeof import('../utils/paths.js')>(
          '../utils/paths.js',
        );
      const actualJsonl = await vi.importActual<
        typeof import('../utils/jsonl-utils.js')
      >('../utils/jsonl-utils.js');

      vi.mocked(path.join).mockImplementation(
        realPath.join as unknown as typeof path.join,
      );
      vi.mocked(path.dirname).mockImplementation(
        realPath.dirname as unknown as typeof path.dirname,
      );
      vi.mocked(path.isAbsolute).mockImplementation(
        realPath.isAbsolute as unknown as typeof path.isAbsolute,
      );
      vi.mocked(path.resolve).mockImplementation(
        realPath.resolve as unknown as typeof path.resolve,
      );
      vi.mocked(getProjectHash).mockImplementation(actualPaths.getProjectHash);
      const mockedPaths = (await import('../utils/paths.js')) as unknown as {
        sanitizeCwd: (cwd: string) => string;
      };
      mockedPaths.sanitizeCwd = actualPaths.sanitizeCwd;
      vi.mocked(jsonl.read).mockImplementation(actualJsonl.read);
      vi.mocked(jsonl.readLines).mockImplementation(actualJsonl.readLines);
      vi.mocked(jsonl.writeLineSync).mockImplementation(
        actualJsonl.writeLineSync,
      );

      vi.mocked(readdirSyncSpy).mockRestore?.();
      vi.mocked(statSyncSpy).mockRestore?.();
      vi.mocked(statPromiseSpy).mockRestore?.();
      vi.mocked(unlinkSyncSpy).mockRestore?.();
      vi.mocked(rmSyncSpy).mockRestore?.();
      vi.mocked(renameSyncSpy).mockRestore?.();

      realTmpDir = fs.mkdtempSync(
        realPath.join(realOs.tmpdir(), 'unarchive-title-collision-'),
      );
      process.env['QWEN_RUNTIME_DIR'] = realTmpDir;
      cwd = process.cwd();
      service = new SessionService(cwd);
    });

    afterEach(() => {
      delete process.env['QWEN_RUNTIME_DIR'];
      try {
        fs.rmSync(realTmpDir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    });

    const seedSessionWithTitle = (
      sessionId: string,
      title: string,
      state: 'active' | 'archived' = 'active',
    ) => {
      const chatsDir = realPath.join(
        service['storage'].getProjectDir(),
        'chats',
        ...(state === 'archived' ? ['archive'] : []),
      );
      fs.mkdirSync(chatsDir, { recursive: true });
      const file = realPath.join(chatsDir, `${sessionId}.jsonl`);
      const lines = [
        {
          uuid: 'u1',
          parentUuid: null,
          sessionId,
          type: 'user',
          timestamp: '2026-04-22T00:00:00.000Z',
          cwd,
          version: 'test',
          message: { role: 'user', parts: [{ text: 'hello' }] },
        },
        {
          uuid: 'u2',
          parentUuid: 'u1',
          sessionId,
          type: 'system',
          subtype: 'custom_title',
          timestamp: '2026-04-22T00:00:01.000Z',
          cwd,
          version: 'test',
          systemPayload: { customTitle: title, titleSource: 'manual' },
        },
      ];
      fs.writeFileSync(
        file,
        lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
      );
      return file;
    };

    it('retitles an archived session before unarchiving it into a title an active session already holds', async () => {
      seedSessionWithTitle(
        '11111111-1111-1111-1111-111111111111',
        'my-branch(1)',
        'active',
      );
      seedSessionWithTitle(
        '22222222-2222-2222-2222-222222222222',
        'my-branch(1)',
        'archived',
      );

      const result = await service.unarchiveSessions([
        '22222222-2222-2222-2222-222222222222',
      ]);

      expect(result.unarchived).toEqual([
        '22222222-2222-2222-2222-222222222222',
      ]);
      expect(result.errors).toEqual([]);
      await expect(
        service.getSessionDisplayName('11111111-1111-1111-1111-111111111111'),
      ).resolves.toBe('my-branch(1)');
      await expect(
        service.getSessionDisplayName('22222222-2222-2222-2222-222222222222'),
      ).resolves.toBe('my-branch(2)');
    });

    it('leaves the title untouched when unarchiving does not collide', async () => {
      seedSessionWithTitle(
        '33333333-3333-3333-3333-333333333333',
        'unrelated-branch',
        'archived',
      );

      const result = await service.unarchiveSessions([
        '33333333-3333-3333-3333-333333333333',
      ]);

      expect(result.unarchived).toEqual([
        '33333333-3333-3333-3333-333333333333',
      ]);
      await expect(
        service.getSessionDisplayName('33333333-3333-3333-3333-333333333333'),
      ).resolves.toBe('unrelated-branch');
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

    it('includes a session whose transcript cwd is a worktree under this project', async () => {
      (path as unknown as Record<string, unknown>)['sep'] = '/';
      readdirSyncSpy.mockReturnValue([
        `${worktreeSessionId}.jsonl`,
      ] as unknown as Array<fs.Dirent<Buffer>>);
      vi.mocked(jsonl.readLines).mockResolvedValue([
        {
          ...recordA1,
          sessionId: worktreeSessionId,
          cwd: '/test/project/root/.qwen/worktrees/my-task',
        },
      ]);
      // The full worktree cwd hashes differently from the repo root,
      // so the first getProjectHash(recordCwd) check fails and the
      // marker-based inference branch is exercised.
      vi.mocked(getProjectHash).mockImplementation((p: string) =>
        p === '/test/project/root' ? 'test-project-hash' : 'worktree-hash',
      );

      const result = await sessionService.listSessions();

      expect(result.items).toHaveLength(1);
      expect(result.items[0].sessionId).toBe(worktreeSessionId);
    });

    it('excludes a session whose worktree belongs to a different project', async () => {
      (path as unknown as Record<string, unknown>)['sep'] = '/';
      readdirSyncSpy.mockReturnValue([
        `${worktreeSessionId}.jsonl`,
      ] as unknown as Array<fs.Dirent<Buffer>>);
      vi.mocked(jsonl.readLines).mockResolvedValue([
        {
          ...recordA1,
          sessionId: worktreeSessionId,
          cwd: '/other/repo/.qwen/worktrees/my-task',
        },
      ]);
      vi.mocked(getProjectHash).mockImplementation((p: string) =>
        p.startsWith('/other/repo') ? 'other-hash' : 'test-project-hash',
      );

      const result = await sessionService.listSessions();

      expect(result.items).toHaveLength(0);
    });
  });

  describe('listSessions parentSessionId round-trip', () => {
    // Uses real disk like findSessionTitlesByPrefix — readParentSessionIdFromFile
    // does a synchronous tail/head scan of the file, so the mocked
    // jsonl.readLines path can't stand in for it. Seed a real transcript with a
    // parent_session record and assert listSessions rehydrates parentSessionId.
    let realTmpDir: string;
    let realPath: typeof import('node:path');
    let service: SessionService;
    let cwd: string;

    beforeEach(async () => {
      const realOs = await import('node:os');
      realPath = await vi.importActual<typeof import('node:path')>('node:path');
      const actualPaths =
        await vi.importActual<typeof import('../utils/paths.js')>(
          '../utils/paths.js',
        );
      const actualJsonl = await vi.importActual<
        typeof import('../utils/jsonl-utils.js')
      >('../utils/jsonl-utils.js');

      vi.mocked(path.join).mockImplementation(
        realPath.join as unknown as typeof path.join,
      );
      vi.mocked(path.dirname).mockImplementation(
        realPath.dirname as unknown as typeof path.dirname,
      );
      vi.mocked(path.isAbsolute).mockImplementation(
        realPath.isAbsolute as unknown as typeof path.isAbsolute,
      );
      vi.mocked(path.resolve).mockImplementation(
        realPath.resolve as unknown as typeof path.resolve,
      );
      vi.mocked(getProjectHash).mockImplementation(actualPaths.getProjectHash);
      const mockedPaths = (await import('../utils/paths.js')) as unknown as {
        sanitizeCwd: (cwd: string) => string;
      };
      mockedPaths.sanitizeCwd = actualPaths.sanitizeCwd;
      vi.mocked(jsonl.read).mockImplementation(actualJsonl.read);
      vi.mocked(jsonl.readLines).mockImplementation(actualJsonl.readLines);

      vi.mocked(readdirSyncSpy).mockRestore?.();
      vi.mocked(statSyncSpy).mockRestore?.();
      vi.mocked(statPromiseSpy).mockRestore?.();
      vi.mocked(unlinkSyncSpy).mockRestore?.();
      vi.mocked(rmSyncSpy).mockRestore?.();

      realTmpDir = fs.mkdtempSync(
        realPath.join(realOs.tmpdir(), 'parent-session-id-'),
      );
      process.env['QWEN_RUNTIME_DIR'] = realTmpDir;
      cwd = process.cwd();
      service = new SessionService(cwd);
    });

    afterEach(() => {
      delete process.env['QWEN_RUNTIME_DIR'];
      try {
        fs.rmSync(realTmpDir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    });

    const getChatsDir = () => {
      const chatsDir = realPath.join(
        service['storage'].getProjectDir(),
        'chats',
      );
      fs.mkdirSync(chatsDir, { recursive: true });
      return chatsDir;
    };

    const userLine = (sessionId: string, text: string) => ({
      uuid: 'u1',
      parentUuid: null,
      sessionId,
      type: 'user',
      timestamp: '2026-04-22T00:00:00.000Z',
      cwd,
      version: 'test',
      message: { role: 'user', parts: [{ text }] },
    });

    const parentSessionLine = (sessionId: string, parentSessionId: string) => ({
      uuid: 'u2',
      parentUuid: 'u1',
      sessionId,
      type: 'system',
      subtype: 'parent_session',
      timestamp: '2026-04-22T00:00:01.000Z',
      cwd,
      version: 'test',
      systemPayload: { parentSessionId },
    });

    const sessionSourceLine = (sessionId: string) => ({
      uuid: 'u3',
      parentUuid: 'u2',
      sessionId,
      type: 'system',
      subtype: 'session_source',
      timestamp: '2026-04-22T00:00:02.000Z',
      cwd,
      version: 'test',
      systemPayload: {
        sourceType: 'scheduled_task',
        sourceId: 'task-123',
      },
    });

    const writeSession = (
      sessionId: string,
      lines: Array<Record<string, unknown>>,
    ) => {
      const file = realPath.join(getChatsDir(), `${sessionId}.jsonl`);
      fs.writeFileSync(
        file,
        lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
      );
      return file;
    };

    const findItem = (
      items: Array<{
        sessionId: string;
        parentSessionId?: string;
        sourceType?: string;
        sourceId?: string;
      }>,
      sessionId: string,
    ) => items.find((item) => item.sessionId === sessionId);

    it('rehydrates parentSessionId from a parent_session record', async () => {
      const sessionId = '11111111-1111-1111-1111-111111111111';
      writeSession(sessionId, [
        userLine(sessionId, 'hello'),
        parentSessionLine(sessionId, 'parent-abc'),
      ]);

      const result = await service.listSessions();

      const item = findItem(result.items, sessionId);
      expect(item).toBeDefined();
      expect(item?.parentSessionId).toBe('parent-abc');
    });

    it('rehydrates source metadata for lists and direct restore lookup', async () => {
      const sessionId = '77777777-7777-7777-7777-777777777777';
      writeSession(sessionId, [
        userLine(sessionId, 'hello'),
        parentSessionLine(sessionId, 'parent-abc'),
        sessionSourceLine(sessionId),
      ]);

      const result = await service.listSessions();

      expect(findItem(result.items, sessionId)).toMatchObject({
        parentSessionId: 'parent-abc',
        sourceType: 'scheduled_task',
        sourceId: 'task-123',
      });
      expect(await service.readCreationMetadata(sessionId)).toEqual({
        parentSessionId: 'parent-abc',
        sourceType: 'scheduled_task',
        sourceId: 'task-123',
      });
    });

    it('rehydrates source metadata appended after the head scan window', async () => {
      const sessionId = '78777777-7777-4777-8777-777777777777';
      const lines: Array<Record<string, unknown>> = [
        userLine(sessionId, 'hello'),
      ];
      for (let i = 0; i < 11; i++) {
        lines.push({
          ...userLine(sessionId, `filler-${i}`),
          uuid: `filler-${i}`,
        });
      }
      lines.push(sessionSourceLine(sessionId));
      writeSession(sessionId, lines);

      const result = await service.listSessions();

      expect(findItem(result.items, sessionId)).toMatchObject({
        sourceType: 'scheduled_task',
        sourceId: 'task-123',
      });
      expect(await service.readCreationMetadata(sessionId)).toMatchObject({
        sourceType: 'scheduled_task',
        sourceId: 'task-123',
      });
    });

    it('reads one exact persisted summary without paging the catalog', async () => {
      const sessionId = '79777777-7777-4777-8777-777777777777';
      writeSession(sessionId, [
        userLine(sessionId, 'exact prompt'),
        sessionSourceLine(sessionId),
      ]);

      await expect(
        service.getSessionListItem(sessionId),
      ).resolves.toMatchObject({
        sessionId,
        cwd,
        startTime: '2026-04-22T00:00:00.000Z',
        prompt: 'exact prompt',
        sourceType: 'scheduled_task',
        sourceId: 'task-123',
        isArchived: false,
      });
    });

    it('keeps the first immutable source record', async () => {
      const sessionId = '88888888-8888-8888-8888-888888888888';
      writeSession(sessionId, [
        userLine(sessionId, 'hello'),
        sessionSourceLine(sessionId),
        {
          ...sessionSourceLine(sessionId),
          uuid: 'u4',
          systemPayload: { sourceType: 'api', sourceId: 'request-456' },
        },
      ]);

      expect(await service.readCreationMetadata(sessionId)).toMatchObject({
        sourceType: 'scheduled_task',
        sourceId: 'task-123',
      });
    });

    it('leaves parentSessionId undefined when no parent_session record exists', async () => {
      const sessionId = '22222222-2222-2222-2222-222222222222';
      writeSession(sessionId, [userLine(sessionId, 'hello')]);

      const result = await service.listSessions();

      const item = findItem(result.items, sessionId);
      expect(item).toBeDefined();
      expect(item?.parentSessionId).toBeUndefined();
    });

    it('reads a parent_session record near the head past the tail window', async () => {
      // The parent_session record is written once near the start of the file.
      // Push it out of the trailing 64KB scan window with bulk user records so
      // the read must fall back to the head window to recover it.
      const sessionId = '33333333-3333-3333-3333-333333333333';
      const bulk = 'x'.repeat(4000);
      const lines: Array<Record<string, unknown>> = [
        userLine(sessionId, 'hello'),
        parentSessionLine(sessionId, 'parent-head'),
      ];
      // 30 * ~4KB comfortably exceeds the 64KB tail window.
      for (let i = 0; i < 30; i++) {
        lines.push({
          uuid: `bulk-${i}`,
          parentUuid: i === 0 ? 'u2' : `bulk-${i - 1}`,
          sessionId,
          type: 'user',
          timestamp: '2026-04-22T00:01:00.000Z',
          cwd,
          version: 'test',
          message: { role: 'user', parts: [{ text: bulk }] },
        });
      }
      writeSession(sessionId, lines);

      const result = await service.listSessions();

      const item = findItem(result.items, sessionId);
      expect(item).toBeDefined();
      expect(item?.parentSessionId).toBe('parent-head');
    });

    it('readParentSessionId returns the parentSessionId for a session with a parent_session record', async () => {
      const sessionId = '44444444-4444-4444-4444-444444444444';
      writeSession(sessionId, [
        userLine(sessionId, 'hello'),
        parentSessionLine(sessionId, 'parent-xyz'),
      ]);

      expect(await service.readParentSessionId(sessionId)).toBe('parent-xyz');
    });

    it('readParentSessionId returns undefined for a session without a parent_session record', async () => {
      const sessionId = '55555555-5555-5555-5555-555555555555';
      writeSession(sessionId, [userLine(sessionId, 'hello')]);

      expect(await service.readParentSessionId(sessionId)).toBeUndefined();
    });

    it('readParentSessionId returns undefined for a nonexistent session', async () => {
      const sessionId = '66666666-6666-6666-6666-666666666666';

      expect(await service.readParentSessionId(sessionId)).toBeUndefined();
    });
  });
});
