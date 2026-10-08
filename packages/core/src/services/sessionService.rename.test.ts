/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
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
import { SessionService } from './sessionService.js';
import type { ChatRecord } from './chatRecordingService.js';
import * as jsonl from '../utils/jsonl-utils.js';
import { readRuntimeStatus } from '../utils/runtimeStatus.js';

vi.mock('node:path');
vi.mock('../utils/paths.js');
vi.mock('../utils/jsonl-utils.js');
vi.mock('../utils/runtimeStatus.js');

describe('SessionService - rename and custom title', () => {
  let sessionService: SessionService;

  let readdirSyncSpy: MockInstance<typeof fs.readdirSync>;
  let statSyncSpy: MockInstance<typeof fs.statSync>;

  let readSyncSpy: MockInstance<typeof fs.readSync>;

  const sessionIdA = '550e8400-e29b-41d4-a716-446655440000';
  const sessionIdB = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
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
    ...recordA1,
    uuid: 'b1',
    sessionId: sessionIdB,
    timestamp: '2024-01-02T00:00:00Z',
    message: { role: 'user', parts: [{ text: 'hi session b' }] },
    gitBranch: 'feature',
  };

  /** One `custom_title` system record line, newline-terminated. */
  const titleLine = (customTitle: string, titleSource?: string) =>
    JSON.stringify({
      type: 'system',
      subtype: 'custom_title',
      systemPayload: { customTitle, ...(titleSource ? { titleSource } : {}) },
    }) + '\n';

  /** An fs.readSync implementation that serves `content` as the file tail. */
  const readsAs =
    (content: string) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (_fd: number, buffer: any) => {
      const data = Buffer.from(content);
      data.copy(buffer);
      return data.length;
    };

  /** statSync reports `content`'s size (unless `stat` overrides it) and readSync serves it. */
  function serveTail(content: string, stat: object = {}) {
    statSyncSpy.mockReturnValue({
      size: content.length,
      mtimeMs: Date.now(),
      ...stat,
    } as unknown as fs.Stats);
    readSyncSpy.mockImplementation(readsAs(content));
  }

  /** Records from any cwd other than the project root hash to another project. */
  const hashOnlyProjectRoot = () =>
    vi
      .mocked(getProjectHash)
      .mockImplementation((cwd: string) =>
        cwd === '/test/project/root'
          ? 'test-project-hash'
          : 'other-project-hash',
      );

  beforeEach(() => {
    vi.mocked(getProjectHash).mockReturnValue('test-project-hash');
    vi.mocked(path.join).mockImplementation((...args) => args.join('/'));
    vi.mocked(path.dirname).mockImplementation((p) => {
      const parts = p.split('/');
      parts.pop();
      return parts.join('/');
    });

    sessionService = new SessionService('/test/project/root');

    readdirSyncSpy = vi.spyOn(fs, 'readdirSync').mockReturnValue([]);
    statSyncSpy = vi.spyOn(fs, 'statSync').mockImplementation(
      () =>
        ({
          mtimeMs: Date.now(),
          size: 100,
          isFile: () => true,
        }) as unknown as fs.Stats,
    );
    vi.spyOn(fs, 'openSync').mockReturnValue(42);
    readSyncSpy = vi.spyOn(fs, 'readSync').mockReturnValue(0);
    vi.spyOn(fs, 'closeSync').mockImplementation(() => undefined);
    // Without O_NOFOLLOW (Windows) session files open through an lstat ->
    // open -> fstat identity check (openSyncNoFollow); these stats make that
    // fallback accept the fabricated paths as a regular, self-matching file.
    // With the flag the spies stay inert.
    vi.spyOn(fs, 'lstatSync').mockImplementation(
      () =>
        ({
          dev: 1,
          ino: 1,
          isSymbolicLink: () => false,
          isFile: () => true,
        }) as unknown as fs.Stats,
    );
    vi.spyOn(fs, 'fstatSync').mockImplementation(
      () =>
        ({
          dev: 1,
          ino: 1,
          // size 0 keeps readLatestTailIfGrown's grown-tail pass inert,
          // matching the pre-rerouting behavior where it never ran.
          size: 0,
          isSymbolicLink: () => false,
          isFile: () => true,
        }) as unknown as fs.Stats,
    );

    vi.mocked(jsonl.read).mockResolvedValue([]);
    vi.mocked(jsonl.readLines).mockResolvedValue([]);
    vi.mocked(jsonl.readLinesWithIntegrity).mockImplementation(
      async (filePath, count, options) => ({
        records: await jsonl.readLines(filePath, count, options),
        complete: true,
      }),
    );
    vi.mocked(jsonl.writeLineSync).mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('renameSession', () => {
    it('should append a custom_title record to the session file', async () => {
      vi.mocked(jsonl.readLines).mockResolvedValue([recordA1]);

      expect(await sessionService.renameSession(sessionIdA, 'my-feature')).toBe(
        true,
      );
      expect(jsonl.writeLineSync).toHaveBeenCalledOnce();

      const written = vi.mocked(jsonl.writeLineSync).mock
        .calls[0][1] as ChatRecord;
      expect(written.type).toBe('system');
      expect(written.subtype).toBe('custom_title');
      expect(written.systemPayload).toEqual({
        customTitle: 'my-feature',
        titleSource: 'manual',
      });
      expect(written.sessionId).toBe(sessionIdA);
    });

    it('should rename a session in the archive store', async () => {
      vi.mocked(jsonl.readLines).mockResolvedValue([recordA1]);

      expect(
        await sessionService.renameSession(
          sessionIdA,
          'archived session',
          'manual',
          'archived',
        ),
      ).toBe(true);
      expect(vi.mocked(jsonl.writeLineSync).mock.calls[0][0]).toContain(
        `/archive/${sessionIdA}.jsonl`,
      );
    });

    it('runs lifecycle mutation fences before appending the title', async () => {
      vi.mocked(jsonl.readLines).mockResolvedValue([recordA1]);
      const internals = sessionService as unknown as {
        resolveMaintainableSessionSnapshot: () => Promise<unknown>;
        assertMaintainableSessionUnchanged: () => void;
      };
      vi.spyOn(
        internals,
        'resolveMaintainableSessionSnapshot',
      ).mockResolvedValue({
        location: 'active',
        identities: [
          {
            state: 'active',
            filePath: `/chats/${sessionIdA}.jsonl`,
            dev: 1,
            ino: 1,
            size: 1,
            mtimeMs: 1,
            ctimeMs: 1,
          },
        ],
      });
      vi.spyOn(
        internals,
        'assertMaintainableSessionUnchanged',
      ).mockImplementation(() => undefined);
      const order: string[] = [];
      vi.mocked(jsonl.writeLineSync).mockImplementation(() => {
        order.push('write');
      });

      await expect(
        sessionService.renameSessionForLifecycle(
          sessionIdA,
          'lifecycle title',
          'manual',
          'active',
          {
            assertStorageUnchanged: () => {
              order.push('storage');
            },
            assertCanMutate: () => {
              order.push('runtime');
            },
          },
        ),
      ).resolves.toBe(true);

      expect(order).toEqual(['storage', 'runtime', 'write']);
    });

    it('should return false when session does not exist', async () => {
      vi.mocked(jsonl.readLines).mockResolvedValue([]);

      expect(
        await sessionService.renameSession(
          '00000000-0000-0000-0000-000000000000',
          'test',
        ),
      ).toBe(false);
      expect(jsonl.writeLineSync).not.toHaveBeenCalled();
    });

    it('should return false for session from different project', async () => {
      vi.mocked(jsonl.readLines).mockResolvedValue([
        { ...recordA1, cwd: '/different/project' },
      ]);
      hashOnlyProjectRoot();

      expect(await sessionService.renameSession(sessionIdA, 'my-feature')).toBe(
        false,
      );
      expect(jsonl.writeLineSync).not.toHaveBeenCalled();
    });

    it('should handle file not found error', async () => {
      const error = new Error('ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      vi.mocked(jsonl.readLines).mockRejectedValue(error);

      expect(
        await sessionService.renameSession(
          '00000000-0000-0000-0000-000000000000',
          'test',
        ),
      ).toBe(false);
    });
  });

  describe('getSessionTitle', () => {
    it('should return custom title from session file tail', () => {
      serveTail(titleLine('my-feature'));
      expect(sessionService.getSessionTitle(sessionIdA)).toBe('my-feature');
    });

    it('should return last custom title when multiple exist', () => {
      serveTail(titleLine('old-name') + titleLine('new-name'));
      expect(sessionService.getSessionTitle(sessionIdA)).toBe('new-name');
    });

    it('should return undefined when no custom title exists', () => {
      serveTail(
        JSON.stringify({
          type: 'user',
          message: { role: 'user', parts: [{ text: 'hello' }] },
        }) + '\n',
      );
      expect(sessionService.getSessionTitle(sessionIdA)).toBeUndefined();
    });

    it('should return undefined when file does not exist', () => {
      statSyncSpy.mockImplementation(() => {
        throw new Error('ENOENT');
      });
      expect(sessionService.getSessionTitle(sessionIdA)).toBeUndefined();
    });
  });

  describe('findSessionsByTitle', () => {
    const now = Date.now();

    /**
     * Lists `sessions` as session files (stat'ed at their mtime, or `now`),
     * serves each one's record as its head and `tail` (default: empty) as
     * every file's tail, then searches for `query`.
     */
    function findByTitle(
      query: string,
      sessions: Array<{ id: string; record: ChatRecord; mtime?: number }>,
      tail?: string,
    ) {
      readdirSyncSpy.mockReturnValue(
        sessions.map((s) => `${s.id}.jsonl`) as unknown as Array<
          fs.Dirent<Buffer>
        >,
      );
      statSyncSpy.mockImplementation((filePath: fs.PathLike) => {
        const p = filePath.toString();
        const session = sessions.find((s) => p.includes(s.id));
        return {
          mtimeMs: session?.mtime ?? now,
          size: tail?.length ?? 100,
          isFile: () => true,
        } as unknown as fs.Stats;
      });
      vi.mocked(jsonl.readLines).mockImplementation(
        async (filePath: string) => {
          const session = sessions.find((s) => filePath.includes(s.id));
          return session ? [session.record] : [];
        },
      );
      readSyncSpy.mockImplementation(readsAs(tail ?? ''));
      return sessionService.findSessionsByTitle(query);
    }

    it('should find session by exact custom title (case-insensitive)', async () => {
      const matches = await findByTitle(
        'my-feature',
        [{ id: sessionIdA, record: recordA1 }],
        titleLine('My-Feature'),
      );

      expect(matches).toHaveLength(1);
      expect(matches[0].sessionId).toBe(sessionIdA);
    });

    it('omits messageCount and avoids createReadStream (perf contract)', async () => {
      // findSessionsByTitle is the second user-facing call site the perf work
      // removed `messageCount` from. Pins both contracts: matches carry
      // `messageCount === undefined`, and no per-match `fs.createReadStream`
      // count pass runs; reintroducing it would silently bring back the
      // O(file-size) cost without any other test failing.
      const createReadStreamSpy = vi.spyOn(fs, 'createReadStream');

      const matches = await findByTitle(
        'my-feature',
        [{ id: sessionIdA, record: recordA1 }],
        titleLine('my-feature'),
      );

      expect(matches).toHaveLength(1);
      expect(matches[0].messageCount).toBeUndefined();
      expect(createReadStreamSpy).not.toHaveBeenCalled();
    });

    it('should return empty array when no session matches', async () => {
      const matches = await findByTitle('nonexistent', [
        { id: sessionIdA, record: recordA1 },
      ]);

      expect(matches).toHaveLength(0);
    });

    it('should find a migrated session when runtime status matches this project', async () => {
      vi.mocked(readRuntimeStatus).mockResolvedValue({
        schemaVersion: 1,
        pid: 123,
        sessionId: sessionIdA,
        workDir: '/test/project/root',
        hostname: 'host',
        startedAt: 1,
        qwenVersion: null,
      });
      hashOnlyProjectRoot();

      const matches = await findByTitle(
        'my-feature',
        [{ id: sessionIdA, record: { ...recordA1, cwd: '/old/project' } }],
        titleLine('my-feature'),
      );

      expect(matches).toHaveLength(1);
      expect(matches[0].sessionId).toBe(sessionIdA);
    });

    it('should not skip matches when multiple sessions share the same mtime (regression for PR #3093 review)', async () => {
      // Three sessions sharing one mtime would straddle a page boundary of a
      // paginated listSessions(), and its strict `mtime < cursor` filter
      // would drop the third. The exhaustive scan must return all three.
      const sessionIdC = '7ba7b810-9dad-11d1-80b4-00c04fd430c9';
      const recordC1: ChatRecord = {
        ...recordA1,
        uuid: 'c1',
        sessionId: sessionIdC,
        timestamp: '2024-01-03T00:00:00Z',
        message: { role: 'user', parts: [{ text: 'hi session c' }] },
      };

      const matches = await findByTitle(
        'shared-name',
        [
          { id: sessionIdA, record: recordA1 },
          { id: sessionIdB, record: recordB1 },
          { id: sessionIdC, record: recordC1 },
        ],
        titleLine('shared-name'),
      );

      expect(matches).toHaveLength(3);
      const matchedIds = matches.map((m) => m.sessionId).sort();
      expect(matchedIds).toEqual([sessionIdA, sessionIdB, sessionIdC].sort());
    });

    it('should return multiple matches for duplicate titles', async () => {
      const matches = await findByTitle(
        'shared-name',
        [
          { id: sessionIdA, record: recordA1, mtime: now - 1000 },
          { id: sessionIdB, record: recordB1 },
        ],
        titleLine('shared-name'),
      );

      expect(matches).toHaveLength(2);
    });
  });

  describe('listSessions with customTitle', () => {
    /** Lists session A, its tail holding `content` (stat'ed at `size`). */
    async function listWithTail(content: string, size = content.length) {
      readdirSyncSpy.mockReturnValue([
        `${sessionIdA}.jsonl`,
      ] as unknown as Array<fs.Dirent<Buffer>>);
      serveTail(content, { size, isFile: () => true });
      vi.mocked(jsonl.readLines).mockResolvedValue([recordA1]);
      return (await sessionService.listSessions()).items;
    }

    it('should include customTitle in session list items', async () => {
      const items = await listWithTail(titleLine('my-feature'));

      expect(items).toHaveLength(1);
      expect(items[0].customTitle).toBe('my-feature');
    });

    it('should return undefined customTitle when none set', async () => {
      const items = await listWithTail('', 100);

      expect(items).toHaveLength(1);
      expect(items[0].customTitle).toBeUndefined();
      expect(items[0].titleSource).toBeUndefined();
    });

    it('should surface titleSource on session list items', async () => {
      const items = await listWithTail(titleLine('Fix login bug', 'auto'));

      expect(items[0].customTitle).toBe('Fix login bug');
      expect(items[0].titleSource).toBe('auto');
    });

    it('leaves titleSource undefined for legacy records without the field', async () => {
      // Back-compat: sessions written before titleSource existed count as
      // manual (via `undefined`; consumers check `=== 'auto'`), so
      // auto-generation never dims a title the user chose pre-upgrade.
      const items = await listWithTail(titleLine('legacy-title'));

      expect(items[0].customTitle).toBe('legacy-title');
      expect(items[0].titleSource).toBeUndefined();
    });
  });
});
