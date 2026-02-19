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
import {
  SessionService,
  buildApiHistoryFromConversation,
  type ConversationRecord,
} from './sessionService.js';
import { CompressionStatus } from '../core/turn.js';
import type { ChatRecord } from './chatRecordingService.js';
import * as jsonl from '../utils/jsonl-utils.js';

vi.mock('node:path');
vi.mock('../utils/paths.js');
vi.mock('../utils/jsonl-utils.js');

describe('SessionService', () => {
  let sessionService: SessionService;

  let readdirSyncSpy: MockInstance<typeof fs.readdirSync>;
  let statSyncSpy: MockInstance<typeof fs.statSync>;
  let unlinkSyncSpy: MockInstance<typeof fs.unlinkSync>;

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
          isFile: () => true,
        }) as fs.Stats,
    );
    unlinkSyncSpy = vi
      .spyOn(fs, 'unlinkSync')
      .mockImplementation(() => undefined);

    // Mock jsonl-utils
    vi.mocked(jsonl.read).mockResolvedValue([]);
    vi.mocked(jsonl.readLines).mockResolvedValue([]);
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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ] as any);

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

    it('should extract prompt text from first record', async () => {
      const now = Date.now();

      readdirSyncSpy.mockReturnValue([
        `${sessionIdA}.jsonl`,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ] as any);

      statSyncSpy.mockReturnValue({
        mtimeMs: now,
        isFile: () => true,
      } as fs.Stats);

      vi.mocked(jsonl.readLines).mockResolvedValue([recordA1]);

      const result = await sessionService.listSessions();

      expect(result.items[0].prompt).toBe('hello session a');
      expect(result.items[0].gitBranch).toBe('main');
    });

    it('should truncate long prompts', async () => {
      const longPrompt = 'A'.repeat(300);
      const recordWithLongPrompt: ChatRecord = {
        ...recordA1,
        message: { role: 'user', parts: [{ text: longPrompt }] },
      };

      readdirSyncSpy.mockReturnValue([
        `${sessionIdA}.jsonl`,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ] as any);
      statSyncSpy.mockReturnValue({
        mtimeMs: Date.now(),
        isFile: () => true,
      } as fs.Stats);
      vi.mocked(jsonl.readLines).mockResolvedValue([recordWithLongPrompt]);

      const result = await sessionService.listSessions();

      expect(result.items[0].prompt.length).toBe(203); // 200 + '...'
      expect(result.items[0].prompt.endsWith('...')).toBe(true);
    });

    it('should paginate with size parameter', async () => {
      const now = Date.now();

      readdirSyncSpy.mockReturnValue([
        `${sessionIdA}.jsonl`,
        `${sessionIdB}.jsonl`,
        `${sessionIdC}.jsonl`,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ] as any);

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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ] as any);

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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ] as any);
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

    it('should skip files that do not match session file pattern', async () => {
      readdirSyncSpy.mockReturnValue([
        `${sessionIdA}.jsonl`, // valid
        'not-a-uuid.jsonl', // invalid pattern
        'readme.txt', // not jsonl
        '.hidden.jsonl', // hidden file
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ] as any);
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
    it('should remove session file', async () => {
      vi.mocked(jsonl.readLines).mockResolvedValue([recordA1]);

      const result = await sessionService.removeSession(sessionIdA);

      expect(result).toBe(true);
      expect(unlinkSyncSpy).toHaveBeenCalled();
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

    it('should handle file not found error', async () => {
      const error = new Error('ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      vi.mocked(jsonl.readLines).mockRejectedValue(error);

      const result = await sessionService.removeSession(
        '00000000-0000-0000-0000-000000000000',
      );

      expect(result).toBe(false);
    });
  });

  describe('loadLastSession', () => {
    it('should return the most recent session (same as getLatestSession)', async () => {
      const now = Date.now();

      readdirSyncSpy.mockReturnValue([
        `${sessionIdA}.jsonl`,
        `${sessionIdB}.jsonl`,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ] as any);

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
  });
});
