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

vi.mock('node:path');
vi.mock('../utils/paths.js');
vi.mock('../utils/jsonl-utils.js');

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

    vi.mocked(jsonl.read).mockResolvedValue([]);
    vi.mocked(jsonl.readLines).mockResolvedValue([]);
    vi.mocked(jsonl.writeLineSync).mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('renameSession', () => {
    it('should append a custom_title record to the session file', async () => {
      vi.mocked(jsonl.readLines).mockResolvedValue([recordA1]);

      const result = await sessionService.renameSession(
        sessionIdA,
        'my-feature',
      );

      expect(result).toBe(true);
      expect(jsonl.writeLineSync).toHaveBeenCalledOnce();

      const writtenRecord = vi.mocked(jsonl.writeLineSync).mock
        .calls[0][1] as ChatRecord;
      expect(writtenRecord.type).toBe('system');
      expect(writtenRecord.subtype).toBe('custom_title');
      expect(writtenRecord.systemPayload).toEqual({
        customTitle: 'my-feature',
        titleSource: 'manual',
      });
      expect(writtenRecord.sessionId).toBe(sessionIdA);
    });

    it('should return false when session does not exist', async () => {
      vi.mocked(jsonl.readLines).mockResolvedValue([]);

      const result = await sessionService.renameSession(
        '00000000-0000-0000-0000-000000000000',
        'test',
      );

      expect(result).toBe(false);
      expect(jsonl.writeLineSync).not.toHaveBeenCalled();
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

      const result = await sessionService.renameSession(
        sessionIdA,
        'my-feature',
      );

      expect(result).toBe(false);
      expect(jsonl.writeLineSync).not.toHaveBeenCalled();
    });

    it('should handle file not found error', async () => {
      const error = new Error('ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      vi.mocked(jsonl.readLines).mockRejectedValue(error);

      const result = await sessionService.renameSession(
        '00000000-0000-0000-0000-000000000000',
        'test',
      );

      expect(result).toBe(false);
    });
  });

  describe('getSessionTitle', () => {
    it('should return custom title from session file tail', () => {
      const titleRecord = JSON.stringify({
        type: 'system',
        subtype: 'custom_title',
        systemPayload: { customTitle: 'my-feature' },
      });

      statSyncSpy.mockReturnValue({
        size: titleRecord.length + 1,
        mtimeMs: Date.now(),
      } as unknown as fs.Stats);

      readSyncSpy.mockImplementation(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (_fd: number, buffer: any) => {
          const data = Buffer.from(titleRecord + '\n');
          data.copy(buffer);
          return data.length;
        },
      );

      const title = sessionService.getSessionTitle(sessionIdA);
      expect(title).toBe('my-feature');
    });

    it('should return last custom title when multiple exist', () => {
      const line1 = JSON.stringify({
        type: 'system',
        subtype: 'custom_title',
        systemPayload: { customTitle: 'old-name' },
      });
      const line2 = JSON.stringify({
        type: 'system',
        subtype: 'custom_title',
        systemPayload: { customTitle: 'new-name' },
      });
      const content = line1 + '\n' + line2 + '\n';

      statSyncSpy.mockReturnValue({
        size: content.length,
        mtimeMs: Date.now(),
      } as unknown as fs.Stats);

      readSyncSpy.mockImplementation(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (_fd: number, buffer: any) => {
          const data = Buffer.from(content);
          data.copy(buffer);
          return data.length;
        },
      );

      const title = sessionService.getSessionTitle(sessionIdA);
      expect(title).toBe('new-name');
    });

    it('should return undefined when no custom title exists', () => {
      const userRecord = JSON.stringify({
        type: 'user',
        message: { role: 'user', parts: [{ text: 'hello' }] },
      });

      statSyncSpy.mockReturnValue({
        size: userRecord.length + 1,
        mtimeMs: Date.now(),
      } as unknown as fs.Stats);

      readSyncSpy.mockImplementation(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (_fd: number, buffer: any) => {
          const data = Buffer.from(userRecord + '\n');
          data.copy(buffer);
          return data.length;
        },
      );

      const title = sessionService.getSessionTitle(sessionIdA);
      expect(title).toBeUndefined();
    });

    it('should return undefined when file does not exist', () => {
      statSyncSpy.mockImplementation(() => {
        throw new Error('ENOENT');
      });

      const title = sessionService.getSessionTitle(sessionIdA);
      expect(title).toBeUndefined();
    });
  });

  describe('findSessionsByTitle', () => {
    const now = Date.now();

    function setupSessionFiles(
      sessions: Array<{
        id: string;
        record: ChatRecord;
        mtime: number;
        titleContent?: string;
      }>,
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
          size: session?.titleContent?.length ?? 100,
          isFile: () => true,
        } as unknown as fs.Stats;
      });

      vi.mocked(jsonl.readLines).mockImplementation(
        async (filePath: string) => {
          const session = sessions.find((s) => filePath.includes(s.id));
          return session ? [session.record] : [];
        },
      );

      readSyncSpy.mockImplementation(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (_fd: number, _buffer: any) =>
          // For simplicity, return empty content (no title by default)
          // Individual tests can override this
          0,
      );
    }

    it('should find session by exact custom title (case-insensitive)', async () => {
      const titleContent =
        JSON.stringify({
          type: 'system',
          subtype: 'custom_title',
          systemPayload: { customTitle: 'My-Feature' },
        }) + '\n';

      setupSessionFiles([
        { id: sessionIdA, record: recordA1, mtime: now, titleContent },
      ]);

      // Override readSync to return title for session A
      readSyncSpy.mockImplementation(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (_fd: number, buffer: any) => {
          const data = Buffer.from(titleContent);
          data.copy(buffer);
          return data.length;
        },
      );

      const matches = await sessionService.findSessionsByTitle('my-feature');

      expect(matches).toHaveLength(1);
      expect(matches[0].sessionId).toBe(sessionIdA);
    });

    it('omits messageCount and avoids createReadStream (perf contract)', async () => {
      // findSessionsByTitle is the second user-facing call site that the
      // perf work removed `messageCount` from. This test pins both
      // contracts: matched items must have `messageCount === undefined`,
      // and the per-match `fs.createReadStream` count pass must not run
      // — re-introducing it would silently bring back the O(file-size)
      // cost without any other test failing.
      const titleContent =
        JSON.stringify({
          type: 'system',
          subtype: 'custom_title',
          systemPayload: { customTitle: 'my-feature' },
        }) + '\n';

      setupSessionFiles([
        { id: sessionIdA, record: recordA1, mtime: now, titleContent },
      ]);

      readSyncSpy.mockImplementation(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (_fd: number, buffer: any) => {
          const data = Buffer.from(titleContent);
          data.copy(buffer);
          return data.length;
        },
      );

      const createReadStreamSpy = vi.spyOn(fs, 'createReadStream');

      const matches = await sessionService.findSessionsByTitle('my-feature');

      expect(matches).toHaveLength(1);
      expect(matches[0].messageCount).toBeUndefined();
      expect(createReadStreamSpy).not.toHaveBeenCalled();
    });

    it('should return empty array when no session matches', async () => {
      setupSessionFiles([{ id: sessionIdA, record: recordA1, mtime: now }]);

      const matches = await sessionService.findSessionsByTitle('nonexistent');

      expect(matches).toHaveLength(0);
    });

    it('should not skip matches when multiple sessions share the same mtime (regression for PR #3093 review)', async () => {
      // Three sessions sharing identical mtimes would fall on the page
      // boundary of a paginated listSessions() and the third would be
      // dropped by the strict `mtime < cursor` filter. Verify the exhaustive
      // scan path returns all three.
      const sessionIdC = '7ba7b810-9dad-11d1-80b4-00c04fd430c9';
      const recordC1: ChatRecord = {
        uuid: 'c1',
        parentUuid: null,
        sessionId: sessionIdC,
        timestamp: '2024-01-03T00:00:00Z',
        type: 'user',
        message: { role: 'user', parts: [{ text: 'hi session c' }] },
        cwd: '/test/project/root',
        version: '1.0.0',
        gitBranch: 'main',
      };

      const titleContent =
        JSON.stringify({
          type: 'system',
          subtype: 'custom_title',
          systemPayload: { customTitle: 'shared-name' },
        }) + '\n';

      readdirSyncSpy.mockReturnValue([
        `${sessionIdA}.jsonl`,
        `${sessionIdB}.jsonl`,
        `${sessionIdC}.jsonl`,
      ] as unknown as Array<fs.Dirent<Buffer>>);

      const sharedMtime = now;
      statSyncSpy.mockImplementation(
        () =>
          ({
            mtimeMs: sharedMtime,
            size: titleContent.length,
            isFile: () => true,
          }) as unknown as fs.Stats,
      );

      vi.mocked(jsonl.readLines).mockImplementation(
        async (filePath: string) => {
          if (filePath.includes(sessionIdA)) return [recordA1];
          if (filePath.includes(sessionIdB)) return [recordB1];
          if (filePath.includes(sessionIdC)) return [recordC1];
          return [];
        },
      );

      readSyncSpy.mockImplementation(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (_fd: number, buffer: any) => {
          const data = Buffer.from(titleContent);
          data.copy(buffer);
          return data.length;
        },
      );

      const matches = await sessionService.findSessionsByTitle('shared-name');

      expect(matches).toHaveLength(3);
      const matchedIds = matches.map((m) => m.sessionId).sort();
      expect(matchedIds).toEqual([sessionIdA, sessionIdB, sessionIdC].sort());
    });

    it('should return multiple matches for duplicate titles', async () => {
      const titleContent =
        JSON.stringify({
          type: 'system',
          subtype: 'custom_title',
          systemPayload: { customTitle: 'shared-name' },
        }) + '\n';

      readdirSyncSpy.mockReturnValue([
        `${sessionIdA}.jsonl`,
        `${sessionIdB}.jsonl`,
      ] as unknown as Array<fs.Dirent<Buffer>>);

      statSyncSpy.mockImplementation((filePath: fs.PathLike) => {
        const p = filePath.toString();
        return {
          mtimeMs: p.includes(sessionIdB) ? now : now - 1000,
          size: titleContent.length,
          isFile: () => true,
        } as unknown as fs.Stats;
      });

      vi.mocked(jsonl.readLines).mockImplementation(
        async (filePath: string) => {
          if (filePath.includes(sessionIdA)) return [recordA1];
          return [recordB1];
        },
      );

      readSyncSpy.mockImplementation(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (_fd: number, buffer: any) => {
          const data = Buffer.from(titleContent);
          data.copy(buffer);
          return data.length;
        },
      );

      const matches = await sessionService.findSessionsByTitle('shared-name');

      expect(matches).toHaveLength(2);
    });
  });

  describe('listSessions with customTitle', () => {
    it('should include customTitle in session list items', async () => {
      const now = Date.now();
      const titleContent =
        JSON.stringify({
          type: 'system',
          subtype: 'custom_title',
          systemPayload: { customTitle: 'my-feature' },
        }) + '\n';

      readdirSyncSpy.mockReturnValue([
        `${sessionIdA}.jsonl`,
      ] as unknown as Array<fs.Dirent<Buffer>>);

      statSyncSpy.mockReturnValue({
        mtimeMs: now,
        size: titleContent.length,
        isFile: () => true,
      } as unknown as fs.Stats);

      vi.mocked(jsonl.readLines).mockResolvedValue([recordA1]);

      readSyncSpy.mockImplementation(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (_fd: number, buffer: any) => {
          const data = Buffer.from(titleContent);
          data.copy(buffer);
          return data.length;
        },
      );

      const result = await sessionService.listSessions();

      expect(result.items).toHaveLength(1);
      expect(result.items[0].customTitle).toBe('my-feature');
    });

    it('should return undefined customTitle when none set', async () => {
      const now = Date.now();

      readdirSyncSpy.mockReturnValue([
        `${sessionIdA}.jsonl`,
      ] as unknown as Array<fs.Dirent<Buffer>>);

      statSyncSpy.mockReturnValue({
        mtimeMs: now,
        size: 100,
        isFile: () => true,
      } as unknown as fs.Stats);

      vi.mocked(jsonl.readLines).mockResolvedValue([recordA1]);

      readSyncSpy.mockImplementation(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (_fd: number, _buffer: any) => 0,
      );

      const result = await sessionService.listSessions();

      expect(result.items).toHaveLength(1);
      expect(result.items[0].customTitle).toBeUndefined();
      expect(result.items[0].titleSource).toBeUndefined();
    });

    it('should surface titleSource on session list items', async () => {
      const now = Date.now();
      const titleContent =
        JSON.stringify({
          type: 'system',
          subtype: 'custom_title',
          systemPayload: {
            customTitle: 'Fix login bug',
            titleSource: 'auto',
          },
        }) + '\n';

      readdirSyncSpy.mockReturnValue([
        `${sessionIdA}.jsonl`,
      ] as unknown as Array<fs.Dirent<Buffer>>);

      statSyncSpy.mockReturnValue({
        mtimeMs: now,
        size: titleContent.length,
        isFile: () => true,
      } as unknown as fs.Stats);

      vi.mocked(jsonl.readLines).mockResolvedValue([recordA1]);

      readSyncSpy.mockImplementation(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (_fd: number, buffer: any) => {
          const data = Buffer.from(titleContent);
          data.copy(buffer);
          return data.length;
        },
      );

      const result = await sessionService.listSessions();

      expect(result.items[0].customTitle).toBe('Fix login bug');
      expect(result.items[0].titleSource).toBe('auto');
    });

    it('leaves titleSource undefined for legacy records without the field', async () => {
      // Back-compat: old sessions written before titleSource existed should
      // be treated as manual (via `undefined` — consumers check `=== 'auto'`),
      // so auto-generation never dims a title the user chose pre-upgrade.
      const now = Date.now();
      const titleContent =
        JSON.stringify({
          type: 'system',
          subtype: 'custom_title',
          systemPayload: { customTitle: 'legacy-title' },
        }) + '\n';

      readdirSyncSpy.mockReturnValue([
        `${sessionIdA}.jsonl`,
      ] as unknown as Array<fs.Dirent<Buffer>>);

      statSyncSpy.mockReturnValue({
        mtimeMs: now,
        size: titleContent.length,
        isFile: () => true,
      } as unknown as fs.Stats);

      vi.mocked(jsonl.readLines).mockResolvedValue([recordA1]);

      readSyncSpy.mockImplementation(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (_fd: number, buffer: any) => {
          const data = Buffer.from(titleContent);
          data.copy(buffer);
          return data.length;
        },
      );

      const result = await sessionService.listSessions();

      expect(result.items[0].customTitle).toBe('legacy-title');
      expect(result.items[0].titleSource).toBeUndefined();
    });
  });
});
