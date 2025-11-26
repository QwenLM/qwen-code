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
import {
  ChatRecordingService,
  type ChatRecord,
  toTokensSummary,
} from './chatRecordingService.js';
import * as jsonl from '../utils/jsonl-utils.js';
import type { Part } from '@google/genai';
import type { ToolCallResponseInfo } from '../core/turn.js';

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
vi.mock('../utils/jsonl-utils.js');

describe('ChatRecordingService', () => {
  let chatRecordingService: ChatRecordingService;
  let mockConfig: Config;

  let mkdirSyncSpy: MockInstance<typeof fs.mkdirSync>;
  let writeFileSyncSpy: MockInstance<typeof fs.writeFileSync>;
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

    // Mock jsonl-utils
    vi.mocked(jsonl.writeLineSync).mockImplementation(() => undefined);
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
    it('should create a new session file if none is provided', async () => {
      await chatRecordingService.initialize();

      expect(mkdirSyncSpy).toHaveBeenCalledWith(
        '/test/project/root/.gemini/projects/test-project/chats',
        { recursive: true },
      );
      expect(writeFileSyncSpy).toHaveBeenCalled();
    });
  });

  describe('recordUserMessage', () => {
    beforeEach(async () => {
      await chatRecordingService.initialize('test-session-id');
    });

    it('should record a user message immediately', () => {
      const userParts: Part[] = [{ text: 'Hello, world!' }];
      chatRecordingService.recordUserMessage(userParts);

      expect(jsonl.writeLineSync).toHaveBeenCalledTimes(1);
      const record = vi.mocked(jsonl.writeLineSync).mock
        .calls[0][1] as ChatRecord;

      expect(record.uuid).toBe('00000000-0000-0000-0000-000000000001');
      expect(record.parentUuid).toBeNull();
      expect(record.type).toBe('user');
      // The service wraps parts in a Content object using createUserContent
      expect(record.message).toEqual({ role: 'user', parts: userParts });
      expect(record.sessionId).toBe('test-session-id');
      expect(record.cwd).toBe('/test/project/root');
      expect(record.version).toBe('1.0.0');
      expect(record.gitBranch).toBe('main');
    });

    it('should chain messages correctly with parentUuid', () => {
      chatRecordingService.recordUserMessage([{ text: 'First message' }]);
      chatRecordingService.recordAssistantTurn({
        model: 'gemini-pro',
        message: [{ text: 'Response' }],
      });
      chatRecordingService.recordUserMessage([{ text: 'Second message' }]);

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
    beforeEach(async () => {
      await chatRecordingService.initialize();
    });

    it('should record assistant turn with content only', () => {
      const parts: Part[] = [{ text: 'Hello!' }];
      chatRecordingService.recordAssistantTurn({
        model: 'gemini-pro',
        message: parts,
      });

      expect(jsonl.writeLineSync).toHaveBeenCalledTimes(1);
      const record = vi.mocked(jsonl.writeLineSync).mock
        .calls[0][1] as ChatRecord;

      expect(record.type).toBe('assistant');
      // The service wraps parts in a Content object using createModelContent
      expect(record.message).toEqual({ role: 'model', parts });
      expect(record.model).toBe('gemini-pro');
      expect(record.usageMetadata).toBeUndefined();
      expect(record.toolCallResult).toBeUndefined();
    });

    it('should record assistant turn with all data', () => {
      const parts: Part[] = [
        { thought: true, text: 'Thinking...' },
        { text: 'Here is the result.' },
        { functionCall: { name: 'read_file', args: { path: '/test.txt' } } },
      ];
      chatRecordingService.recordAssistantTurn({
        model: 'gemini-pro',
        message: parts,
        tokens: {
          input: 100,
          output: 50,
          cached: 10,
          total: 160,
        },
      });

      const record = vi.mocked(jsonl.writeLineSync).mock
        .calls[0][1] as ChatRecord;

      // The service wraps parts in a Content object using createModelContent
      expect(record.message).toEqual({ role: 'model', parts });
      expect(record.model).toBe('gemini-pro');
      expect(record.usageMetadata?.total).toBe(160);
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
  });

  describe('recordToolResult', () => {
    beforeEach(async () => {
      await chatRecordingService.initialize();
    });

    it('should record tool result with Parts', () => {
      // First record a user and assistant message to set up the chain
      chatRecordingService.recordUserMessage([{ text: 'Hello' }]);
      chatRecordingService.recordAssistantTurn({
        model: 'gemini-pro',
        message: [{ functionCall: { name: 'shell', args: { command: 'ls' } } }],
      });

      // Now record the tool result (Parts with functionResponse)
      const toolResultParts: Part[] = [
        {
          functionResponse: {
            id: 'call-1',
            name: 'shell',
            response: { output: 'file1.txt\nfile2.txt' },
          },
        },
      ];
      chatRecordingService.recordToolResult(toolResultParts);

      expect(jsonl.writeLineSync).toHaveBeenCalledTimes(3);
      const record = vi.mocked(jsonl.writeLineSync).mock
        .calls[2][1] as ChatRecord;

      expect(record.type).toBe('tool_result');
      // The service wraps parts in a Content object using createUserContent
      expect(record.message).toEqual({ role: 'user', parts: toolResultParts });
    });

    it('should record tool result with toolCallResult metadata', () => {
      const toolResultParts: Part[] = [
        {
          functionResponse: {
            id: 'call-1',
            name: 'shell',
            response: { output: 'result' },
          },
        },
      ];
      const metadata: Partial<ToolCallResponseInfo> = {
        callId: 'call-1',
        responseParts: toolResultParts,
        resultDisplay: undefined,
      };

      chatRecordingService.recordToolResult(toolResultParts, metadata);

      const record = vi.mocked(jsonl.writeLineSync).mock
        .calls[0][1] as ChatRecord;

      expect(record.type).toBe('tool_result');
      // The service wraps parts in a Content object using createUserContent
      expect(record.message).toEqual({ role: 'user', parts: toolResultParts });
      expect(record.toolCallResult).toBeDefined();
      expect(record.toolCallResult?.callId).toBe('call-1');
    });

    it('should chain tool result correctly with parentUuid', () => {
      chatRecordingService.recordUserMessage([{ text: 'Hello' }]);
      chatRecordingService.recordAssistantTurn({
        model: 'gemini-pro',
        message: [{ text: 'Using tool' }],
      });
      const toolResultParts: Part[] = [
        {
          functionResponse: {
            id: 'call-1',
            name: 'shell',
            response: { output: 'done' },
          },
        },
      ];
      chatRecordingService.recordToolResult(toolResultParts);

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

  // Note: Session management tests (listSessions, loadSession, deleteSession, etc.)
  // have been moved to sessionService.test.ts
  // Session resume integration tests should test via SessionService mock
});
