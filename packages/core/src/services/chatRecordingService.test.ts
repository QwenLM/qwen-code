/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type MockInstance,
  vi,
} from 'vitest';
import type { Config } from '../config/config.js';
import { getProjectHash } from '../utils/paths.js';
import {
  ChatRecordingService,
  type ChatRecord,
  type ToolCallRecord,
  toTokensSummary,
} from './chatRecordingService.js';
import * as jsonl from '../utils/jsonl-utils.js';

vi.mock('node:fs');
vi.mock('node:path');
vi.mock('node:child_process');
vi.mock('node:crypto', () => ({
  randomUUID: vi.fn(),
  createHash: vi.fn(() => ({
    update: vi.fn(() => ({
      digest: vi.fn(() => 'mocked-hash'),
    })),
  })),
}));
vi.mock('../utils/paths.js');
vi.mock('../utils/jsonl-utils.js');

describe('ChatRecordingService', () => {
  let chatRecordingService: ChatRecordingService;
  let mockConfig: Config;

  let mkdirSyncSpy: MockInstance<typeof fs.mkdirSync>;
  let writeFileSyncSpy: MockInstance<typeof fs.writeFileSync>;
  let readdirSyncSpy: MockInstance<typeof fs.readdirSync>;
  let unlinkSyncSpy: MockInstance<typeof fs.unlinkSync>;
  let uuidCounter = 0;

  beforeEach(() => {
    uuidCounter = 0;

    mockConfig = {
      getSessionId: vi.fn().mockReturnValue('test-session-id'),
      getProjectRoot: vi.fn().mockReturnValue('/test/project/root'),
      getCliVersion: vi.fn().mockReturnValue('1.0.0'),
      storage: {
        getProjectTempDir: vi
          .fn()
          .mockReturnValue('/test/project/root/.gemini/tmp/hash'),
        getProjectDir: vi
          .fn()
          .mockReturnValue('/test/project/root/.gemini/projects/test-project'),
      },
      getModel: vi.fn().mockReturnValue('gemini-pro'),
      getDebugMode: vi.fn().mockReturnValue(false),
      getToolRegistry: vi.fn().mockReturnValue({
        getTool: vi.fn().mockReturnValue({
          displayName: 'Test Tool',
          description: 'A test tool',
          isOutputMarkdown: false,
        }),
      }),
    } as unknown as Config;

    vi.mocked(getProjectHash).mockReturnValue('test-project-hash');
    vi.mocked(randomUUID).mockImplementation(
      () =>
        `00000000-0000-0000-0000-00000000000${++uuidCounter}` as `${string}-${string}-${string}-${string}-${string}`,
    );
    vi.mocked(path.join).mockImplementation((...args) => args.join('/'));
    vi.mocked(path.dirname).mockImplementation((p) => {
      const parts = p.split('/');
      parts.pop();
      return parts.join('/');
    });
    vi.mocked(execSync).mockReturnValue('main\n');

    chatRecordingService = new ChatRecordingService(mockConfig);

    mkdirSyncSpy = vi
      .spyOn(fs, 'mkdirSync')
      .mockImplementation(() => undefined);

    writeFileSyncSpy = vi
      .spyOn(fs, 'writeFileSync')
      .mockImplementation(() => undefined);

    readdirSyncSpy = vi.spyOn(fs, 'readdirSync').mockReturnValue([]);
    unlinkSyncSpy = vi
      .spyOn(fs, 'unlinkSync')
      .mockImplementation(() => undefined);

    // Mock jsonl-utils
    vi.mocked(jsonl.exists).mockReturnValue(false);
    vi.mocked(jsonl.writeLineSync).mockImplementation(() => undefined);
    vi.mocked(jsonl.write).mockImplementation(() => undefined);
    vi.mocked(jsonl.read).mockResolvedValue([]);
    vi.mocked(jsonl.readLines).mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('toTokensSummary', () => {
    it('should convert GenerateContentResponseUsageMetadata to TokensSummary', () => {
      const result = toTokensSummary({
        promptTokenCount: 10,
        candidatesTokenCount: 20,
        cachedContentTokenCount: 5,
        thoughtsTokenCount: 3,
        toolUsePromptTokenCount: 2,
        totalTokenCount: 40,
      });

      expect(result).toEqual({
        input: 10,
        output: 20,
        cached: 5,
        thoughts: 3,
        tool: 2,
        total: 40,
      });
    });

    it('should handle missing fields with defaults', () => {
      const result = toTokensSummary({});

      expect(result).toEqual({
        input: 0,
        output: 0,
        cached: 0,
        thoughts: 0,
        tool: 0,
        total: 0,
      });
    });
  });

  describe('initialize', () => {
    it('should create a new session file if none is provided', () => {
      chatRecordingService.initialize();

      expect(mkdirSyncSpy).toHaveBeenCalledWith(
        '/test/project/root/.gemini/projects/test-project/chats',
        { recursive: true },
      );
      expect(writeFileSyncSpy).toHaveBeenCalled();
    });

    it('should resume from an existing session if provided', () => {
      const existingRecord: ChatRecord = {
        uuid: 'existing-uuid',
        parentUuid: null,
        sessionId: 'old-session-id',
        timestamp: '2024-01-01T00:00:00Z',
        type: 'user',
        message: { role: 'user', parts: [{ text: 'Hello' }] },
        cwd: '/test/project/root',
        version: '1.0.0',
      };

      chatRecordingService.initialize({
        filePath: '/test/project/root/.gemini/tmp/hash/chats/session.jsonl',
        conversation: {
          sessionId: 'old-session-id',
          projectHash: 'test-project-hash',
          startTime: '2024-01-01T00:00:00Z',
          lastUpdated: '2024-01-01T00:00:00Z',
          messages: [existingRecord],
        },
        lastCompletedUuid: 'existing-uuid',
      });

      // Should not create new directory or file
      expect(mkdirSyncSpy).not.toHaveBeenCalled();
      expect(writeFileSyncSpy).not.toHaveBeenCalled();
    });
  });

  describe('recordUserMessage', () => {
    beforeEach(() => {
      chatRecordingService.initialize();
    });

    it('should record a user message immediately', () => {
      const userContent = { role: 'user', parts: [{ text: 'Hello, world!' }] };
      chatRecordingService.recordUserMessage(userContent);

      expect(jsonl.writeLineSync).toHaveBeenCalledTimes(1);
      const record = vi.mocked(jsonl.writeLineSync).mock
        .calls[0][1] as ChatRecord;

      expect(record.uuid).toBe('00000000-0000-0000-0000-000000000001');
      expect(record.parentUuid).toBeNull();
      expect(record.type).toBe('user');
      expect(record.message).toEqual(userContent);
      expect(record.sessionId).toBe('test-session-id');
      expect(record.cwd).toBe('/test/project/root');
      expect(record.version).toBe('1.0.0');
      expect(record.gitBranch).toBe('main');
    });

    it('should chain messages correctly with parentUuid', () => {
      chatRecordingService.recordUserMessage({
        role: 'user',
        parts: [{ text: 'First message' }],
      });
      chatRecordingService.recordAssistantTurn({
        model: 'gemini-pro',
        content: { role: 'model', parts: [{ text: 'Response' }] },
      });
      chatRecordingService.recordUserMessage({
        role: 'user',
        parts: [{ text: 'Second message' }],
      });

      const calls = vi.mocked(jsonl.writeLineSync).mock.calls;
      const user1 = calls[0][1] as ChatRecord;
      const assistant = calls[1][1] as ChatRecord;
      const user2 = calls[2][1] as ChatRecord;

      expect(user1.uuid).toBe('00000000-0000-0000-0000-000000000001');
      expect(user1.parentUuid).toBeNull();

      expect(assistant.uuid).toBe('00000000-0000-0000-0000-000000000002');
      expect(assistant.parentUuid).toBe('00000000-0000-0000-0000-000000000001');

      expect(user2.uuid).toBe('00000000-0000-0000-0000-000000000003');
      expect(user2.parentUuid).toBe('00000000-0000-0000-0000-000000000002');
    });
  });

  describe('recordAssistantTurn', () => {
    beforeEach(() => {
      chatRecordingService.initialize();
    });

    it('should record assistant turn with content only', () => {
      const content = { role: 'model', parts: [{ text: 'Hello!' }] };
      chatRecordingService.recordAssistantTurn({
        model: 'gemini-pro',
        content,
      });

      expect(jsonl.writeLineSync).toHaveBeenCalledTimes(1);
      const record = vi.mocked(jsonl.writeLineSync).mock
        .calls[0][1] as ChatRecord;

      expect(record.type).toBe('assistant');
      expect(record.message).toEqual(content);
      expect(record.model).toBe('gemini-pro');
      expect(record.usageMetadata).toBeUndefined();
      expect(record.toolCallsMetadata).toBeUndefined();
    });

    it('should record assistant turn with all data', () => {
      const content = {
        role: 'model',
        parts: [
          { thought: true, text: 'Thinking...' },
          { text: 'Here is the result.' },
          { functionCall: { name: 'read_file', args: { path: '/test.txt' } } },
        ],
      };
      chatRecordingService.recordAssistantTurn({
        model: 'gemini-pro',
        content,
        tokens: {
          input: 100,
          output: 50,
          cached: 10,
          total: 160,
        },
        toolCallsMetadata: [
          {
            id: 'tool-1',
            name: 'read_file',
            args: { path: '/test.txt' },
            status: 'success',
            timestamp: '2024-01-01T00:00:00Z',
          },
        ],
      });

      const record = vi.mocked(jsonl.writeLineSync).mock
        .calls[0][1] as ChatRecord;

      expect(record.message).toEqual(content);
      expect(record.model).toBe('gemini-pro');
      expect(record.usageMetadata?.total).toBe(160);
      expect(record.toolCallsMetadata).toHaveLength(1);
      expect(record.toolCallsMetadata?.[0].displayName).toBe('Test Tool'); // Enriched
    });

    it('should record assistant turn with only tokens', () => {
      chatRecordingService.recordAssistantTurn({
        model: 'gemini-pro',
        tokens: { input: 10, output: 20, cached: 0, total: 30 },
      });

      const record = vi.mocked(jsonl.writeLineSync).mock
        .calls[0][1] as ChatRecord;

      expect(record.message).toBeUndefined();
      expect(record.usageMetadata?.total).toBe(30);
    });

    it('should record assistant turn with only toolCallsMetadata', () => {
      chatRecordingService.recordAssistantTurn({
        model: 'gemini-pro',
        toolCallsMetadata: [
          {
            id: 'tool-1',
            name: 'shell',
            args: { command: 'ls' },
            status: 'success',
            timestamp: '2024-01-01T00:00:00Z',
          },
        ],
      });

      const record = vi.mocked(jsonl.writeLineSync).mock
        .calls[0][1] as ChatRecord;

      expect(record.message).toBeUndefined();
      expect(record.toolCallsMetadata).toHaveLength(1);
    });
  });

  describe('recordToolResult', () => {
    beforeEach(() => {
      chatRecordingService.initialize();
    });

    it('should record tool result with Content', () => {
      // First record a user and assistant message to set up the chain
      chatRecordingService.recordUserMessage({
        role: 'user',
        parts: [{ text: 'Hello' }],
      });
      chatRecordingService.recordAssistantTurn({
        model: 'gemini-pro',
        content: {
          role: 'model',
          parts: [{ functionCall: { name: 'shell', args: { command: 'ls' } } }],
        },
      });

      // Now record the tool result (Content with functionResponse parts)
      const toolResultContent = {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'call-1',
              name: 'shell',
              response: { output: 'file1.txt\nfile2.txt' },
            },
          },
        ],
      };
      chatRecordingService.recordToolResult(toolResultContent);

      expect(jsonl.writeLineSync).toHaveBeenCalledTimes(3);
      const record = vi.mocked(jsonl.writeLineSync).mock
        .calls[2][1] as ChatRecord;

      expect(record.type).toBe('tool_result');
      expect(record.message).toEqual(toolResultContent);
    });

    it('should record tool result with toolCallsMetadata', () => {
      const toolResultContent = {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'call-1',
              name: 'shell',
              response: { output: 'result' },
            },
          },
        ],
      };
      const metadata: ToolCallRecord[] = [
        {
          id: 'call-1',
          name: 'shell',
          args: { command: 'ls' },
          result: 'result',
          status: 'success',
          timestamp: '2024-01-01T00:00:00Z',
        },
      ];

      chatRecordingService.recordToolResult(toolResultContent, metadata);

      const record = vi.mocked(jsonl.writeLineSync).mock
        .calls[0][1] as ChatRecord;

      expect(record.type).toBe('tool_result');
      expect(record.message).toEqual(toolResultContent);
      expect(record.toolCallsMetadata).toHaveLength(1);
      expect(record.toolCallsMetadata?.[0].displayName).toBe('Test Tool'); // Enriched
    });

    it('should chain tool result correctly with parentUuid', () => {
      chatRecordingService.recordUserMessage({
        role: 'user',
        parts: [{ text: 'Hello' }],
      });
      chatRecordingService.recordAssistantTurn({
        model: 'gemini-pro',
        content: { role: 'model', parts: [{ text: 'Using tool' }] },
      });
      chatRecordingService.recordToolResult({
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'call-1',
              name: 'shell',
              response: { output: 'done' },
            },
          },
        ],
      });

      const userRecord = vi.mocked(jsonl.writeLineSync).mock
        .calls[0][1] as ChatRecord;
      const assistantRecord = vi.mocked(jsonl.writeLineSync).mock
        .calls[1][1] as ChatRecord;
      const toolResultRecord = vi.mocked(jsonl.writeLineSync).mock
        .calls[2][1] as ChatRecord;

      expect(userRecord.parentUuid).toBeNull();
      expect(assistantRecord.parentUuid).toBe(userRecord.uuid);
      expect(toolResultRecord.parentUuid).toBe(assistantRecord.uuid);
    });
  });

  describe('deleteSession', () => {
    it('should delete the session file', async () => {
      // @ts-expect-error - Mocking fs.readdirSync with string array for simplicity
      readdirSyncSpy.mockReturnValue(['file-a.jsonl']);
      const filePath =
        '/test/project/root/.gemini/projects/test-project/chats/file-a.jsonl';

      vi.mocked(jsonl.read).mockResolvedValue([
        {
          uuid: 'record-1',
          parentUuid: null,
          sessionId: 'test-session-id',
          timestamp: '2024-01-01T00:00:00Z',
          type: 'user',
          message: { role: 'user', parts: [{ text: 'Hello' }] },
          cwd: '/test/project/root',
          version: '1.0.0',
        } as ChatRecord,
      ]);

      await chatRecordingService.deleteSession('test-session-id');
      expect(unlinkSyncSpy).toHaveBeenCalledWith(filePath);
    });
  });

  describe('record aggregation', () => {
    it('should aggregate multiple records with same uuid by merging Content parts', async () => {
      const records: ChatRecord[] = [
        {
          uuid: 'u1',
          parentUuid: null,
          sessionId: 'test',
          timestamp: '2024-01-01T00:00:00Z',
          type: 'user',
          message: { role: 'user', parts: [{ text: 'Hello' }] },
          cwd: '/test',
          version: '1.0.0',
        },
        // Multiple records for the same assistant message (streaming scenario)
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
          cwd: '/test',
          version: '1.0.0',
        },
        {
          uuid: 'a1',
          parentUuid: 'u1',
          sessionId: 'test',
          timestamp: '2024-01-01T00:01:01Z',
          type: 'assistant',
          usageMetadata: { input: 10, output: 20, cached: 0, total: 30 },
          cwd: '/test',
          version: '1.0.0',
        },
        {
          uuid: 'a1',
          parentUuid: 'u1',
          sessionId: 'test',
          timestamp: '2024-01-01T00:01:02Z',
          type: 'assistant',
          message: { role: 'model', parts: [{ text: 'Hi there!' }] },
          model: 'gemini-pro',
          cwd: '/test',
          version: '1.0.0',
        },
      ];

      // @ts-expect-error - Mocking fs.readdirSync with string array for simplicity
      readdirSyncSpy.mockReturnValue(['test.jsonl']);
      vi.mocked(jsonl.read).mockResolvedValue(records);

      const loaded = await chatRecordingService.loadSession('test');

      // Should have 2 messages: user and aggregated assistant
      expect(loaded?.conversation.messages).toHaveLength(2);

      const assistantMsg = loaded?.conversation.messages[1];
      expect(assistantMsg?.uuid).toBe('a1');
      // Parts should be merged from all records
      expect(assistantMsg?.message?.parts).toHaveLength(2);
      expect(assistantMsg?.usageMetadata?.total).toBe(30);
      expect(assistantMsg?.model).toBe('gemini-pro');
    });
  });

  describe('session listing and loading', () => {
    const recordA1: ChatRecord = {
      uuid: 'a1',
      parentUuid: null,
      sessionId: 'session-a',
      timestamp: '2024-01-01T00:00:00Z',
      type: 'user',
      message: { role: 'user', parts: [{ text: 'hello' }] },
      cwd: '/test/project/root',
      version: '1.0.0',
    };

    const recordB1: ChatRecord = {
      uuid: 'b1',
      parentUuid: null,
      sessionId: 'session-b',
      timestamp: '2024-01-02T00:00:00Z',
      type: 'user',
      message: { role: 'user', parts: [{ text: 'hi' }] },
      cwd: '/test/project/root',
      version: '1.0.0',
    };

    const recordB2: ChatRecord = {
      uuid: 'b2',
      parentUuid: 'b1',
      sessionId: 'session-b',
      timestamp: '2024-01-02T02:00:00Z',
      type: 'assistant',
      message: { role: 'model', parts: [{ text: 'hey' }] },
      cwd: '/test/project/root',
      version: '1.0.0',
    };

    it('should list sessions sorted by lastUpdated desc', async () => {
      // @ts-expect-error - Mocking fs.readdirSync with string array for simplicity
      readdirSyncSpy.mockReturnValue(['session-a.jsonl', 'session-b.jsonl']);

      vi.mocked(jsonl.read).mockImplementation(async (filePath: string) => {
        if (filePath.includes('session-a')) {
          return [recordA1];
        }
        return [recordB1, recordB2];
      });

      const sessions = await chatRecordingService.listSessions();
      expect(sessions.map((s) => s.sessionId)).toEqual([
        'session-b',
        'session-a',
      ]);
    });

    it('should load a session by id and reconstruct history', async () => {
      // @ts-expect-error - Mocking fs.readdirSync with string array for simplicity
      readdirSyncSpy.mockReturnValue(['session-b.jsonl']);

      vi.mocked(jsonl.read).mockResolvedValue([recordB1, recordB2]);

      const loaded = await chatRecordingService.loadSession('session-b');

      expect(loaded?.conversation.sessionId).toBe('session-b');
      expect(loaded?.conversation.messages).toHaveLength(2);
      expect(loaded?.conversation.messages[0].uuid).toBe('b1');
      expect(loaded?.conversation.messages[1].uuid).toBe('b2');
      expect(loaded?.lastCompletedUuid).toBe('b2');
    });

    it('should return null when session id is not found', async () => {
      // @ts-expect-error - Mocking fs.readdirSync with string array for simplicity
      readdirSyncSpy.mockReturnValue(['session-a.jsonl']);

      vi.mocked(jsonl.read).mockResolvedValue([recordA1]);

      const loaded = await chatRecordingService.loadSession('missing');
      expect(loaded).toBeNull();
    });

    it('should return the latest session', async () => {
      // @ts-expect-error - Mocking fs.readdirSync with string array for simplicity
      readdirSyncSpy.mockReturnValue(['session-a.jsonl', 'session-b.jsonl']);

      vi.mocked(jsonl.read).mockImplementation(async (filePath: string) => {
        if (filePath.includes('session-a')) {
          return [recordA1];
        }
        return [recordB1, recordB2];
      });

      const latest = await chatRecordingService.getLatestSession();
      expect(latest?.conversation.sessionId).toBe('session-b');
    });
  });

  describe('tree reconstruction', () => {
    it('should reconstruct linear history from tree-structured records', async () => {
      const records: ChatRecord[] = [
        {
          uuid: 'r1',
          parentUuid: null,
          sessionId: 'test',
          timestamp: '2024-01-01T00:00:00Z',
          type: 'user',
          message: { role: 'user', parts: [{ text: 'First' }] },
          cwd: '/test',
          version: '1.0.0',
        },
        {
          uuid: 'r2',
          parentUuid: 'r1',
          sessionId: 'test',
          timestamp: '2024-01-01T00:01:00Z',
          type: 'assistant',
          message: { role: 'model', parts: [{ text: 'Second' }] },
          cwd: '/test',
          version: '1.0.0',
        },
        {
          uuid: 'r3',
          parentUuid: 'r2',
          sessionId: 'test',
          timestamp: '2024-01-01T00:02:00Z',
          type: 'user',
          message: { role: 'user', parts: [{ text: 'Third' }] },
          cwd: '/test',
          version: '1.0.0',
        },
      ];

      // @ts-expect-error - Mocking fs.readdirSync with string array for simplicity
      readdirSyncSpy.mockReturnValue(['test.jsonl']);
      vi.mocked(jsonl.read).mockResolvedValue(records);

      const loaded = await chatRecordingService.loadSession('test');

      expect(loaded?.conversation.messages).toHaveLength(3);
      expect(loaded?.conversation.messages.map((m) => m.uuid)).toEqual([
        'r1',
        'r2',
        'r3',
      ]);
    });

    it('should handle branching (checkpointing scenario)', async () => {
      const records: ChatRecord[] = [
        {
          uuid: 'r1',
          parentUuid: null,
          sessionId: 'test',
          timestamp: '2024-01-01T00:00:00Z',
          type: 'user',
          message: { role: 'user', parts: [{ text: 'First' }] },
          cwd: '/test',
          version: '1.0.0',
        },
        {
          uuid: 'r2',
          parentUuid: 'r1',
          sessionId: 'test',
          timestamp: '2024-01-01T00:01:00Z',
          type: 'assistant',
          message: { role: 'model', parts: [{ text: 'Original response' }] },
          cwd: '/test',
          version: '1.0.0',
        },
        // Branch: new response from r1
        {
          uuid: 'r3',
          parentUuid: 'r1',
          sessionId: 'test',
          timestamp: '2024-01-01T00:02:00Z',
          type: 'assistant',
          message: { role: 'model', parts: [{ text: 'New branch response' }] },
          cwd: '/test',
          version: '1.0.0',
        },
      ];

      // @ts-expect-error - Mocking fs.readdirSync with string array for simplicity
      readdirSyncSpy.mockReturnValue(['test.jsonl']);
      vi.mocked(jsonl.read).mockResolvedValue(records);

      const loaded = await chatRecordingService.loadSession('test');

      // Should follow from r3 (last in file) back to r1
      expect(loaded?.conversation.messages).toHaveLength(2);
      expect(loaded?.conversation.messages.map((m) => m.uuid)).toEqual([
        'r1',
        'r3',
      ]);
    });
  });

  describe('resume from existing session', () => {
    it('should continue chain from lastCompletedUuid', () => {
      chatRecordingService.initialize({
        filePath: '/test/session.jsonl',
        conversation: {
          sessionId: 'resumed-session',
          projectHash: 'test-project-hash',
          startTime: '2024-01-01T00:00:00Z',
          lastUpdated: '2024-01-01T00:00:00Z',
          messages: [],
        },
        lastCompletedUuid: 'existing-uuid',
      });

      chatRecordingService.recordAssistantTurn({
        model: 'gemini-pro',
        content: { role: 'model', parts: [{ text: 'Continuing...' }] },
      });

      const record = vi.mocked(jsonl.writeLineSync).mock
        .calls[0][1] as ChatRecord;

      expect(record.parentUuid).toBe('existing-uuid');
      expect(record.sessionId).toBe('resumed-session');
    });
  });
});
