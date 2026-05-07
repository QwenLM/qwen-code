/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import {
  ChatRecordingService,
  type ChatRecord,
  type AtCommandRecordPayload,
} from './chatRecordingService.js';
import * as jsonl from '../utils/jsonl-utils.js';
import type { Part } from '@google/genai';
import type { FileDiff } from '../tools/tools.js';

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
      getFastModel: vi.fn().mockReturnValue(undefined),
      isInteractive: vi.fn().mockReturnValue(false),
      getDebugMode: vi.fn().mockReturnValue(false),
      getToolRegistry: vi.fn().mockReturnValue({
        getTool: vi.fn().mockReturnValue({
          displayName: 'Test Tool',
          description: 'A test tool',
          isOutputMarkdown: false,
        }),
      }),
      getResumedSessionData: vi.fn().mockReturnValue(undefined),
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
    vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined);
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => undefined);
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);

    chatRecordingService = new ChatRecordingService(mockConfig);

    // Mock jsonl-utils. writeLine is async — mockResolvedValue returns
    // a settled Promise so the writeChain in ChatRecordingService advances
    // when flushed.
    vi.mocked(jsonl.writeLine).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('recordUserMessage', () => {
    it('should record a user message immediately', async () => {
      const userParts: Part[] = [{ text: 'Hello, world!' }];
      chatRecordingService.recordUserMessage(userParts);
      await chatRecordingService.flush();

      expect(jsonl.writeLine).toHaveBeenCalledTimes(1);
      const record = vi.mocked(jsonl.writeLine).mock.calls[0][1] as ChatRecord;

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

    it('should chain messages correctly with parentUuid', async () => {
      chatRecordingService.recordUserMessage([{ text: 'First message' }]);
      chatRecordingService.recordAssistantTurn({
        model: 'gemini-pro',
        message: [{ text: 'Response' }],
      });
      chatRecordingService.recordUserMessage([{ text: 'Second message' }]);
      await chatRecordingService.flush();

      const calls = vi.mocked(jsonl.writeLine).mock.calls;
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

  describe('recordAtCommand', () => {
    it('should record @-command metadata as a system payload', async () => {
      const userParts: Part[] = [{ text: 'Hello, world!' }];
      const payload: AtCommandRecordPayload = {
        filesRead: ['foo.txt'],
        status: 'success',
        message: 'Success',
        userText: '@foo.txt',
      };

      chatRecordingService.recordUserMessage(userParts);
      chatRecordingService.recordAtCommand(payload);
      await chatRecordingService.flush();

      expect(jsonl.writeLine).toHaveBeenCalledTimes(2);
      const userRecord = vi.mocked(jsonl.writeLine).mock
        .calls[0][1] as ChatRecord;
      const systemRecord = vi.mocked(jsonl.writeLine).mock
        .calls[1][1] as ChatRecord;

      expect(userRecord.type).toBe('user');
      expect(systemRecord.type).toBe('system');
      expect(systemRecord.subtype).toBe('at_command');
      expect(systemRecord.systemPayload).toEqual(payload);
      expect(systemRecord.parentUuid).toBe(userRecord.uuid);
    });
  });

  describe('recordAssistantTurn', () => {
    it('should record assistant turn with content only', async () => {
      const parts: Part[] = [{ text: 'Hello!' }];
      chatRecordingService.recordAssistantTurn({
        model: 'gemini-pro',
        message: parts,
      });
      await chatRecordingService.flush();

      expect(jsonl.writeLine).toHaveBeenCalledTimes(1);
      const record = vi.mocked(jsonl.writeLine).mock.calls[0][1] as ChatRecord;

      expect(record.type).toBe('assistant');
      // The service wraps parts in a Content object using createModelContent
      expect(record.message).toEqual({ role: 'model', parts });
      expect(record.model).toBe('gemini-pro');
      expect(record.usageMetadata).toBeUndefined();
      expect(record.toolCallResult).toBeUndefined();
    });

    it('should record assistant turn with all data', async () => {
      const parts: Part[] = [
        { thought: true, text: 'Thinking...' },
        { text: 'Here is the result.' },
        { functionCall: { name: 'read_file', args: { path: '/test.txt' } } },
      ];
      chatRecordingService.recordAssistantTurn({
        model: 'gemini-pro',
        message: parts,
        tokens: {
          promptTokenCount: 100,
          candidatesTokenCount: 50,
          cachedContentTokenCount: 10,
          totalTokenCount: 160,
        },
      });
      await chatRecordingService.flush();

      const record = vi.mocked(jsonl.writeLine).mock.calls[0][1] as ChatRecord;

      // The service wraps parts in a Content object using createModelContent
      expect(record.message).toEqual({ role: 'model', parts });
      expect(record.model).toBe('gemini-pro');
      expect(record.usageMetadata?.totalTokenCount).toBe(160);
    });

    it('should record assistant turn with only tokens', async () => {
      chatRecordingService.recordAssistantTurn({
        model: 'gemini-pro',
        tokens: {
          promptTokenCount: 10,
          candidatesTokenCount: 20,
          cachedContentTokenCount: 0,
          totalTokenCount: 30,
        },
      });
      await chatRecordingService.flush();

      const record = vi.mocked(jsonl.writeLine).mock.calls[0][1] as ChatRecord;

      expect(record.message).toBeUndefined();
      expect(record.usageMetadata?.totalTokenCount).toBe(30);
    });
  });

  describe('recordToolResult', () => {
    it('should record tool result with Parts', async () => {
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
      await chatRecordingService.flush();

      expect(jsonl.writeLine).toHaveBeenCalledTimes(3);
      const record = vi.mocked(jsonl.writeLine).mock.calls[2][1] as ChatRecord;

      expect(record.type).toBe('tool_result');
      // The service wraps parts in a Content object using createUserContent
      expect(record.message).toEqual({ role: 'user', parts: toolResultParts });
    });

    it('should record tool result with toolCallResult metadata', async () => {
      const toolResultParts: Part[] = [
        {
          functionResponse: {
            id: 'call-1',
            name: 'shell',
            response: { output: 'result' },
          },
        },
      ];
      const metadata = {
        callId: 'call-1',
        status: 'success',
        responseParts: toolResultParts,
        resultDisplay: undefined,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;

      chatRecordingService.recordToolResult(toolResultParts, metadata);
      await chatRecordingService.flush();

      const record = vi.mocked(jsonl.writeLine).mock.calls[0][1] as ChatRecord;

      expect(record.type).toBe('tool_result');
      // The service wraps parts in a Content object using createUserContent
      expect(record.message).toEqual({ role: 'user', parts: toolResultParts });
      expect(record.toolCallResult).toBeDefined();
      expect(record.toolCallResult?.callId).toBe('call-1');
    });

    it('should keep small file diff resultDisplay unchanged', async () => {
      const toolResultParts: Part[] = [
        {
          functionResponse: {
            id: 'call-1',
            name: 'edit',
            response: { output: 'ok' },
          },
        },
      ];
      const resultDisplay: FileDiff = {
        fileName: 'file.txt',
        fileDiff: '--- file.txt\n+++ file.txt\n@@ -1 +1 @@\n-old\n+new',
        originalContent: 'old',
        newContent: 'new',
        diffStat: {
          model_added_lines: 1,
          model_removed_lines: 1,
          model_added_chars: 3,
          model_removed_chars: 3,
          user_added_lines: 0,
          user_removed_lines: 0,
          user_added_chars: 0,
          user_removed_chars: 0,
        },
      };
      const metadata = {
        callId: 'call-1',
        status: 'success' as const,
        responseParts: toolResultParts,
        resultDisplay,
        error: undefined,
        errorType: undefined,
      };

      chatRecordingService.recordToolResult(toolResultParts, metadata);
      await chatRecordingService.flush();

      const record = vi.mocked(jsonl.writeLine).mock.calls[0][1] as ChatRecord;

      expect(record.toolCallResult?.resultDisplay).toBe(resultDisplay);
      expect(
        (record.toolCallResult?.resultDisplay as FileDiff).truncatedForSession,
      ).toBeUndefined();
    });

    it('should shrink large file diff resultDisplay without mutating input', async () => {
      const toolResultParts: Part[] = [
        {
          functionResponse: {
            id: 'call-1',
            name: 'write_file',
            response: { output: 'ok' },
          },
        },
      ];
      const largeDiff = 'd'.repeat(70_000);
      const largeOriginal = 'a'.repeat(20_000);
      const largeNew = 'b'.repeat(20_000);
      const resultDisplay: FileDiff = {
        fileName: 'large.txt',
        fileDiff: largeDiff,
        originalContent: largeOriginal,
        newContent: largeNew,
        diffStat: {
          model_added_lines: 1,
          model_removed_lines: 1,
          model_added_chars: largeNew.length,
          model_removed_chars: largeOriginal.length,
          user_added_lines: 0,
          user_removed_lines: 0,
          user_added_chars: 0,
          user_removed_chars: 0,
        },
      };
      const metadata = {
        callId: 'call-1',
        status: 'success' as const,
        responseParts: toolResultParts,
        resultDisplay,
        error: undefined,
        errorType: undefined,
      };

      chatRecordingService.recordToolResult(toolResultParts, metadata);
      await chatRecordingService.flush();

      const record = vi.mocked(jsonl.writeLine).mock.calls[0][1] as ChatRecord;
      const savedDisplay = record.toolCallResult?.resultDisplay as FileDiff;

      expect(savedDisplay).not.toBe(resultDisplay);
      expect(savedDisplay.truncatedForSession).toBe(true);
      expect(savedDisplay.fileDiffLength).toBe(largeDiff.length);
      expect(savedDisplay.originalContentLength).toBe(largeOriginal.length);
      expect(savedDisplay.newContentLength).toBe(largeNew.length);
      expect(savedDisplay.fileDiffTruncated).toBe(true);
      expect(savedDisplay.originalContentTruncated).toBe(true);
      expect(savedDisplay.newContentTruncated).toBe(true);
      expect(savedDisplay.fileDiff).toContain(
        'Full diff omitted from saved session history',
      );
      expect(savedDisplay.fileDiff).not.toBe(largeDiff);
      expect(savedDisplay.originalContent?.length).toBeLessThanOrEqual(16_000);
      expect(savedDisplay.originalContent).toContain(
        'truncated for saved session preview',
      );
      expect(savedDisplay.newContent.length).toBeLessThanOrEqual(16_000);
      expect(savedDisplay.newContent).toContain(
        'truncated for saved session preview',
      );
      expect(savedDisplay.diffStat).toEqual(resultDisplay.diffStat);

      expect(resultDisplay.fileDiff).toBe(largeDiff);
      expect(resultDisplay.originalContent).toBe(largeOriginal);
      expect(resultDisplay.newContent).toBe(largeNew);
      expect(resultDisplay.truncatedForSession).toBeUndefined();
    });

    it('should continue stripping nested tool calls from task execution results', async () => {
      const toolResultParts: Part[] = [
        {
          functionResponse: {
            id: 'call-1',
            name: 'task',
            response: { output: 'ok' },
          },
        },
      ];
      const metadata = {
        callId: 'call-1',
        status: 'success' as const,
        responseParts: toolResultParts,
        resultDisplay: {
          type: 'task_execution' as const,
          subagentName: 'Task',
          taskDescription: 'Run task',
          taskPrompt: 'Run task',
          status: 'completed' as const,
          result: 'done',
          toolCalls: [
            {
              callId: 'nested-call',
              name: 'read_file',
              status: 'success' as const,
              args: {},
              result: 'nested result',
            },
          ],
        },
        error: undefined,
        errorType: undefined,
      };

      chatRecordingService.recordToolResult(toolResultParts, metadata);
      await chatRecordingService.flush();

      const record = vi.mocked(jsonl.writeLine).mock.calls[0][1] as ChatRecord;

      expect(record.toolCallResult?.resultDisplay).toMatchObject({
        type: 'task_execution',
        toolCalls: [],
      });
    });

    it('should chain tool result correctly with parentUuid', async () => {
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
      await chatRecordingService.flush();

      const userRecord = vi.mocked(jsonl.writeLine).mock
        .calls[0][1] as ChatRecord;
      const assistantRecord = vi.mocked(jsonl.writeLine).mock
        .calls[1][1] as ChatRecord;
      const toolResultRecord = vi.mocked(jsonl.writeLine).mock
        .calls[2][1] as ChatRecord;

      expect(userRecord.parentUuid).toBeNull();
      expect(assistantRecord.parentUuid).toBe(userRecord.uuid);
      expect(toolResultRecord.parentUuid).toBe(assistantRecord.uuid);
    });
  });

  describe('recordSlashCommand', () => {
    it('should record slash command with payload and subtype', async () => {
      chatRecordingService.recordSlashCommand({
        phase: 'invocation',
        rawCommand: '/about',
      });
      await chatRecordingService.flush();

      expect(jsonl.writeLine).toHaveBeenCalledTimes(1);
      const record = vi.mocked(jsonl.writeLine).mock.calls[0][1] as ChatRecord;

      expect(record.type).toBe('system');
      expect(record.subtype).toBe('slash_command');
      expect(record.systemPayload).toMatchObject({
        phase: 'invocation',
        rawCommand: '/about',
      });
    });

    it('should chain slash command after prior records', async () => {
      chatRecordingService.recordUserMessage([{ text: 'Hello' }]);
      chatRecordingService.recordSlashCommand({
        phase: 'result',
        rawCommand: '/about',
      });
      await chatRecordingService.flush();

      const userRecord = vi.mocked(jsonl.writeLine).mock
        .calls[0][1] as ChatRecord;
      const slashRecord = vi.mocked(jsonl.writeLine).mock
        .calls[1][1] as ChatRecord;

      expect(userRecord.parentUuid).toBeNull();
      expect(slashRecord.parentUuid).toBe(userRecord.uuid);
    });
  });

  describe('flush', () => {
    it('resolves immediately on a service with no enqueued writes', async () => {
      // The writeChain starts as Promise.resolve(), so flush() on a fresh
      // service should settle in a single microtask — important because
      // Config.shutdown awaits flush on every exit path, even for sessions
      // that never recorded anything.
      await expect(chatRecordingService.flush()).resolves.toBeUndefined();
      expect(jsonl.writeLine).not.toHaveBeenCalled();
    });

    it('a failed write does not block subsequent records', async () => {
      // Regression guard: the inner .catch swallows fs errors and keeps
      // the chain alive so the next record's write still runs.
      vi.mocked(jsonl.writeLine).mockRejectedValueOnce(
        new Error('simulated EACCES'),
      );
      chatRecordingService.recordUserMessage([{ text: 'first' }]);
      chatRecordingService.recordUserMessage([{ text: 'second' }]);
      await chatRecordingService.flush();

      expect(jsonl.writeLine).toHaveBeenCalledTimes(2);
      const second = vi.mocked(jsonl.writeLine).mock.calls[1][1] as ChatRecord;
      expect(
        (second.message as { parts: Array<{ text: string }> }).parts[0].text,
      ).toBe('second');
    });
  });

  describe('ensureChatsDir caching', () => {
    it('does not cache when mkdirSync throws so the next write retries', async () => {
      // Regression: a transient mkdir failure used to poison the cache and
      // silently drop the rest of the session's records. We have to fail
      // both mkdir AND the wx-create, otherwise ensureConversationFile's
      // own cache short-circuits ensureChatsDir on the second call.
      const mkdirSpy = vi.spyOn(fs, 'mkdirSync');
      mkdirSpy.mockImplementationOnce(() => {
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      });
      mkdirSpy.mockImplementation(() => undefined);

      const writeSpy = vi.spyOn(fs, 'writeFileSync');
      writeSpy.mockImplementationOnce(() => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });
      writeSpy.mockImplementation(() => undefined);

      chatRecordingService.recordUserMessage([{ text: 'first' }]);
      await chatRecordingService.flush();
      chatRecordingService.recordUserMessage([{ text: 'second' }]);
      await chatRecordingService.flush();

      // ≥ rather than === leaves room for a future flush()-side retry.
      expect(mkdirSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it('caches after a successful mkdir so steady-state writes skip the syscall', async () => {
      const mkdirSpy = vi
        .spyOn(fs, 'mkdirSync')
        .mockImplementation(() => undefined);

      chatRecordingService.recordUserMessage([{ text: 'first' }]);
      await chatRecordingService.flush();
      chatRecordingService.recordUserMessage([{ text: 'second' }]);
      await chatRecordingService.flush();
      chatRecordingService.recordUserMessage([{ text: 'third' }]);
      await chatRecordingService.flush();

      expect(mkdirSpy).toHaveBeenCalledTimes(1);
    });
  });

  // Note: Session management tests (listSessions, loadSession, deleteSession, etc.)
  // have been moved to sessionService.test.ts
  // Session resume integration tests should test via SessionService mock
});
