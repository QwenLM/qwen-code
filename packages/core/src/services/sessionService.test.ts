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
  getResumePromptTokenCount,
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
      vi.mocked(unlinkSyncSpy).mockRestore?.();

      realTmpDir = fs.mkdtempSync(
        realPath.join(realOs.tmpdir(), 'fork-session-'),
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

    const seedSession = (sessionId: string) => {
      const chatsDir = realPath.join(
        service['storage'].getProjectDir(),
        'chats',
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
          type: 'assistant',
          timestamp: '2026-04-22T00:00:01.000Z',
          cwd,
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

    it('rejects invalid sessionId patterns before touching disk', async () => {
      const valid = '99999999-9999-9999-9999-999999999999';
      await expect(service.forkSession('bogus', valid)).rejects.toThrow(
        /Invalid source sessionId/,
      );
      await expect(service.forkSession(valid, 'bogus')).rejects.toThrow(
        /Invalid new sessionId/,
      );
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
      vi.mocked(unlinkSyncSpy).mockRestore?.();

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
    ) => {
      const chatsDir = realPath.join(
        service['storage'].getProjectDir(),
        'chats',
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
        'my-branch (Branch)',
      );
      seedSessionWithTitle(
        '22222222-2222-2222-2222-222222222222',
        'My-Branch (Branch 2)',
      );
      seedSessionWithTitle(
        '33333333-3333-3333-3333-333333333333',
        'unrelated session',
      );

      const titles =
        await service.findSessionTitlesByPrefix('my-branch (Branch');

      expect(new Set(titles)).toEqual(
        new Set(['my-branch (Branch)', 'My-Branch (Branch 2)']),
      );
    });

    it('returns empty when chats directory does not exist', async () => {
      const titles = await service.findSessionTitlesByPrefix('anything');
      expect(titles).toEqual([]);
    });

    it('skips sessions from other projects (collisions are project-scoped)', async () => {
      seedSessionWithTitle(
        '11111111-1111-1111-1111-111111111111',
        'shared (Branch)',
        cwd,
      );
      // Same chats dir (sessions are stored under projectHash anyway), but
      // the record's cwd belongs to another project → must be skipped.
      seedSessionWithTitle(
        '22222222-2222-2222-2222-222222222222',
        'shared (Branch 2)',
        '/some/other/project',
      );

      const titles = await service.findSessionTitlesByPrefix('shared (Branch');
      expect(titles).toEqual(['shared (Branch)']);
    });

    it('skips files without a custom_title record', async () => {
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
          message: { role: 'user', parts: [{ text: 'hi' }] },
        }) + '\n',
      );

      const titles = await service.findSessionTitlesByPrefix('anything');
      expect(titles).toEqual([]);
    });
  });
});
