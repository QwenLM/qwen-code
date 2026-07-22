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
import { MAX_RETAINED_TOOL_RESULT_DISPLAY_CHARS } from '../utils/toolResultDisplayCompaction.js';
import * as jsonl from '../utils/jsonl-utils.js';
import type { Part } from '@google/genai';
import type { FileDiff } from '../tools/tools.js';
import {
  deserializeSnapshots,
  serializeSnapshot,
  type FileHistorySnapshot,
} from './fileHistoryService.js';
import type {
  SessionWriterUnavailableError,
  SessionWriterLease,
} from './session-writer-lease.js';
import type {
  GoalStateRecordPayloadV2,
  GoalTurnPermit,
} from '../goals/goal-protocol.js';

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
  let mockLease: SessionWriterLease;

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
      getSessionService: vi.fn(),
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

    // Mock jsonl-utils. writeLine is async — mockResolvedValue returns
    // a settled Promise so the writeChain in ChatRecordingService advances
    // when flushed.
    vi.mocked(jsonl.writeLine).mockResolvedValue(undefined);

    mockLease = {
      sessionId: 'test-session-id',
      ownerId: 'test-owner-id',
      appendJsonLine: vi.fn((record: unknown) =>
        jsonl.writeLine('/test/session.jsonl', record),
      ),
      assertOwnedAndUnchanged: vi.fn().mockResolvedValue(undefined),
      release: vi.fn().mockResolvedValue(undefined),
    } as unknown as SessionWriterLease;
    chatRecordingService = activateRecording(
      new ChatRecordingService(mockConfig),
    );
  });

  function activateRecording(
    service: ChatRecordingService,
  ): ChatRecordingService {
    const resumed = mockConfig.getResumedSessionData();
    service.activate(
      mockLease,
      resumed && !resumed.conversation
        ? {
            conversation: { messages: [] },
            lastCompletedUuid: resumed.lastCompletedUuid,
          }
        : resumed,
    );
    return service;
  }

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
      expect(record.provenance).toBe('real_user');
    });

    it('blocks later turns after a generic durable write failure', async () => {
      const failure = new Error('disk full');
      vi.mocked(mockLease.appendJsonLine).mockRejectedValueOnce(failure);

      chatRecordingService.recordUserMessage([{ text: 'not durable' }]);
      await expect(chatRecordingService.flush()).rejects.toBe(failure);
      await expect(
        chatRecordingService.assertCanStartTurn(),
      ).rejects.toMatchObject({
        name: 'SessionWriterUnavailableError',
        cause: failure,
      } satisfies Partial<SessionWriterUnavailableError>);
      chatRecordingService.recordUserMessage([{ text: 'must be blocked' }]);
      expect(mockLease.appendJsonLine).toHaveBeenCalledTimes(1);
    });

    it('orders new appends after an authoritative read barrier', async () => {
      let releaseRead!: () => void;
      let markReadStarted!: () => void;
      const readStarted = new Promise<void>((resolve) => {
        markReadStarted = resolve;
      });
      const readGate = new Promise<void>((resolve) => {
        releaseRead = resolve;
      });
      const snapshot = chatRecordingService.runWithWriteBarrier(async () => {
        markReadStarted();
        await readGate;
        return 'snapshot';
      });
      await readStarted;

      chatRecordingService.recordUserMessage([{ text: 'after snapshot' }]);
      expect(mockLease.appendJsonLine).not.toHaveBeenCalled();
      releaseRead();

      await expect(snapshot).resolves.toBe('snapshot');
      await chatRecordingService.flush();
      expect(mockLease.appendJsonLine).toHaveBeenCalledOnce();
      expect(mockLease.assertOwnedAndUnchanged).toHaveBeenCalledTimes(2);
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

    it('should record mid-turn user messages with a mergeable subtype', async () => {
      const modelFacingParts: Part[] = [
        {
          text: '\n[User message received during tool execution]: save logs',
        },
      ];

      chatRecordingService.recordMidTurnUserMessage(
        modelFacingParts,
        'save logs',
      );
      await chatRecordingService.flush();

      expect(jsonl.writeLine).toHaveBeenCalledTimes(1);
      const record = vi.mocked(jsonl.writeLine).mock.calls[0][1] as ChatRecord;

      expect(record.type).toBe('user');
      expect(record.subtype).toBe('mid_turn_user_message');
      expect(record.message).toEqual({
        role: 'user',
        parts: modelFacingParts,
      });
      expect(record.systemPayload).toEqual({ displayText: 'save logs' });
    });

    it('records defensive Goal context on top-level and mid-turn real user messages', async () => {
      const topLevelPermit: GoalTurnPermit = {
        goalId: 'goal-1',
        revision: 2,
        turnId: 'turn-top-level',
      };
      const midTurnPermit: GoalTurnPermit = {
        goalId: 'goal-1',
        revision: 2,
        turnId: 'turn-mid-turn',
      };

      chatRecordingService.recordUserMessage(
        [{ text: 'top-level evidence' }],
        topLevelPermit,
      );
      chatRecordingService.recordMidTurnUserMessage(
        [{ text: 'mid-turn evidence' }],
        'mid-turn evidence',
        midTurnPermit,
      );
      topLevelPermit.revision = 99;
      midTurnPermit.turnId = 'mutated';
      await chatRecordingService.flush();

      const [topLevel, midTurn] = vi
        .mocked(jsonl.writeLine)
        .mock.calls.map((call) => call[1] as ChatRecord);
      expect(topLevel).toMatchObject({
        type: 'user',
        provenance: 'real_user',
        goalContext: {
          goalId: 'goal-1',
          revision: 2,
          turnId: 'turn-top-level',
        },
      });
      expect(midTurn).toMatchObject({
        type: 'user',
        subtype: 'mid_turn_user_message',
        provenance: 'real_user',
        goalContext: {
          goalId: 'goal-1',
          revision: 2,
          turnId: 'turn-mid-turn',
        },
      });
    });

    it('keeps notification-like provenance while recording defensive Goal context', async () => {
      const notificationPermit: GoalTurnPermit = {
        goalId: 'goal-1',
        revision: 2,
        turnId: 'turn-notification',
      };
      const cronPermit: GoalTurnPermit = {
        goalId: 'goal-1',
        revision: 2,
        turnId: 'turn-cron',
      };

      chatRecordingService.recordNotification(
        [{ text: 'dependency completed' }],
        'Dependency completed',
        notificationPermit,
      );
      chatRecordingService.recordCronPrompt(
        [{ text: 'scheduled check' }],
        'Scheduled check',
        cronPermit,
      );
      notificationPermit.turnId = 'mutated';
      cronPermit.revision = 99;
      await chatRecordingService.flush();

      const [notification, cron] = vi
        .mocked(jsonl.writeLine)
        .mock.calls.map((call) => call[1] as ChatRecord);
      expect(notification).toMatchObject({
        type: 'user',
        subtype: 'notification',
        provenance: 'system',
        goalContext: {
          goalId: 'goal-1',
          revision: 2,
          turnId: 'turn-notification',
        },
      });
      expect(cron).toMatchObject({
        type: 'user',
        subtype: 'cron',
        provenance: 'system',
        goalContext: {
          goalId: 'goal-1',
          revision: 2,
          turnId: 'turn-cron',
        },
      });
    });
  });

  describe('Goal records', () => {
    const goalPayload: GoalStateRecordPayloadV2 = {
      v: 2,
      cause: 'create',
      snapshot: {
        v: 2,
        activity: 'running',
        goal: {
          goalId: 'goal-1',
          revision: 1,
          objective: 'ship it',
          status: 'active',
          evidenceCursor: { recordId: 'goal-record' },
          turnCount: 0,
          activeTimeMs: 0,
          createdAt: 100,
          updatedAt: 100,
        },
      },
    };

    it('strictly persists the caller-owned lifecycle UUID and normalizes activity', async () => {
      let resolveWrite!: () => void;
      vi.mocked(jsonl.writeLine).mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveWrite = resolve;
          }),
      );

      let settled = false;
      const pending = chatRecordingService
        .recordGoalState('goal-record', goalPayload)
        .then((value) => {
          settled = true;
          return value;
        });
      await Promise.resolve();

      expect(settled).toBe(false);
      const record = vi.mocked(jsonl.writeLine).mock
        .calls[0]?.[1] as ChatRecord;
      expect(record).toMatchObject({
        uuid: 'goal-record',
        subtype: 'goal_state',
        provenance: 'goal_control',
      });
      expect(record.systemPayload).toMatchObject({
        snapshot: {
          activity: 'idle',
          goal: { evidenceCursor: { recordId: 'goal-record' } },
        },
      });

      resolveWrite();
      await expect(pending).resolves.toEqual(record);
      expect(chatRecordingService.getTranscriptCursor()).toEqual({
        recordId: 'goal-record',
      });
    });

    it('rejects a lifecycle append on disk failure and restores the cursor', async () => {
      vi.mocked(jsonl.writeLine).mockRejectedValueOnce(new Error('disk full'));

      await expect(
        chatRecordingService.recordGoalState('goal-record', goalPayload),
      ).rejects.toThrow('disk full');
      expect(chatRecordingService.getTranscriptCursor()).toEqual({
        recordId: null,
      });
    });

    it('restores the last persisted cursor when a queued successor follows a failed lifecycle append', async () => {
      chatRecordingService.recordUserMessage([{ text: 'persisted baseline' }]);
      await chatRecordingService.flush();
      const persistedCursor = chatRecordingService.getTranscriptCursor();

      let rejectStrict!: (error: Error) => void;
      const strictWrite = new Promise<void>((_resolve, reject) => {
        rejectStrict = reject;
      });
      vi.mocked(jsonl.writeLine).mockImplementationOnce(() => strictWrite);

      const strict = chatRecordingService.recordGoalState(
        'goal-record',
        goalPayload,
      );
      chatRecordingService.recordUserMessage([
        { text: 'queued after strict record' },
      ]);
      rejectStrict(new Error('disk full'));

      await expect(strict).rejects.toThrow('disk full');
      await expect(chatRecordingService.flush()).rejects.toThrow('disk full');
      expect(jsonl.writeLine).toHaveBeenCalledTimes(2);
      expect(chatRecordingService.getTranscriptCursor()).toEqual(
        persistedCursor,
      );
    });

    it('keeps Goal-owned external tool results eligible while excluding explicit control results', async () => {
      const goalContext = { goalId: 'goal-1', revision: 1, turnId: 'turn-1' };

      chatRecordingService.recordGoalRuntimeMessage(
        [{ text: 'continue' }],
        goalContext,
      );
      chatRecordingService.recordToolResult(
        [{ functionResponse: { name: 'run', response: { ok: true } } }],
        undefined,
        { goalContext },
      );
      chatRecordingService.recordToolResult(
        [{ functionResponse: { name: 'update_goal', response: { ok: true } } }],
        undefined,
        { goalContext, provenance: 'goal_runtime' },
      );
      chatRecordingService.recordAssistantTurn({
        model: 'gemini-pro',
        message: [{ text: 'done' }],
        goalContext,
      });
      await chatRecordingService.flush();

      const records = vi
        .mocked(jsonl.writeLine)
        .mock.calls.map((call) => call[1] as ChatRecord);
      expect(records[0]).toMatchObject({
        subtype: 'goal_runtime',
        provenance: 'goal_runtime',
        goalContext,
      });
      expect(records[1]).toMatchObject({
        provenance: 'tool_result',
        goalContext,
      });
      expect(records[2]).toMatchObject({
        provenance: 'goal_runtime',
        goalContext,
      });
      expect(records[3]).toMatchObject({
        provenance: 'assistant_output',
        goalContext,
      });
    });

    it('defensively copies Goal context for runtime, assistant, and tool records', async () => {
      const runtimePermit: GoalTurnPermit = {
        goalId: 'goal-1',
        revision: 3,
        turnId: 'runtime-turn',
      };
      const assistantPermit: GoalTurnPermit = {
        goalId: 'goal-1',
        revision: 3,
        turnId: 'assistant-turn',
      };
      const toolPermit: GoalTurnPermit = {
        goalId: 'goal-1',
        revision: 3,
        turnId: 'tool-turn',
      };

      chatRecordingService.recordGoalRuntimeMessage(
        [{ text: 'continue' }],
        runtimePermit,
      );
      chatRecordingService.recordAssistantTurn({
        model: 'gemini-pro',
        message: [{ text: 'working' }],
        goalContext: assistantPermit,
      });
      chatRecordingService.recordToolResult(
        [{ functionResponse: { name: 'run', response: { ok: true } } }],
        undefined,
        { goalContext: toolPermit },
      );
      runtimePermit.turnId = 'mutated-runtime';
      assistantPermit.revision = 99;
      toolPermit.goalId = 'mutated-goal';
      await chatRecordingService.flush();

      const records = vi
        .mocked(jsonl.writeLine)
        .mock.calls.map((call) => call[1] as ChatRecord);
      expect(records.map((record) => record.goalContext)).toEqual([
        { goalId: 'goal-1', revision: 3, turnId: 'runtime-turn' },
        { goalId: 'goal-1', revision: 3, turnId: 'assistant-turn' },
        { goalId: 'goal-1', revision: 3, turnId: 'tool-turn' },
      ]);
    });

    it('does not treat Goal runtime continuations as rewind boundaries', async () => {
      chatRecordingService.recordAssistantTurn({
        model: 'gemini-pro',
        message: [{ text: 'before Goal runtime turn' }],
      });
      chatRecordingService.recordGoalRuntimeMessage(
        [{ text: 'continue Goal' }],
        { goalId: 'goal-1', revision: 1, turnId: 'turn-1' },
      );
      chatRecordingService.recordAssistantTurn({
        model: 'gemini-pro',
        message: [{ text: 'after Goal runtime turn' }],
      });

      chatRecordingService.rewindRecording(0, { truncatedCount: 2 });
      await chatRecordingService.flush();

      const records = vi
        .mocked(jsonl.writeLine)
        .mock.calls.map((call) => call[1] as ChatRecord);
      expect(records[3]).toMatchObject({
        type: 'system',
        subtype: 'rewind',
        parentUuid: null,
      });
    });

    it('flushes before returning the canonical active transcript chain', async () => {
      const order: string[] = [];
      const activeChain = [
        {
          uuid: 'active-record',
          parentUuid: null,
          sessionId: 'test-session-id',
          timestamp: '2026-07-21T00:00:00.000Z',
          type: 'user' as const,
          provenance: 'real_user' as const,
          cwd: '/test/project/root',
          version: '1.0.0',
          message: { role: 'user' as const, parts: [{ text: 'active' }] },
        },
      ];
      const originalFlush =
        chatRecordingService.flush.bind(chatRecordingService);
      vi.spyOn(chatRecordingService, 'flush').mockImplementation(async () => {
        order.push('flush');
        await originalFlush();
      });
      const loadSession = vi.fn().mockImplementation(async () => {
        order.push('load');
        return {
          conversation: { messages: activeChain },
        };
      });
      vi.mocked(mockConfig.getSessionService).mockReturnValue({
        loadSession,
      } as unknown as ReturnType<Config['getSessionService']>);

      await expect(
        chatRecordingService.readActiveTranscriptChain(),
      ).resolves.toEqual(activeChain);
      expect(order).toEqual(['flush', 'load']);
      expect(loadSession).toHaveBeenCalledWith('test-session-id');
    });

    it('fails closed when the canonical active session cannot be loaded', async () => {
      const loadSession = vi.fn().mockResolvedValue(undefined);
      vi.mocked(mockConfig.getSessionService).mockReturnValue({
        loadSession,
      } as unknown as ReturnType<Config['getSessionService']>);

      await expect(
        chatRecordingService.readActiveTranscriptChain(),
      ).rejects.toThrow(/active transcript/i);
    });
  });

  describe('rewindRecording', () => {
    it('preserves a resumed user turn parent when rebuilding rewind boundaries', async () => {
      vi.mocked(mockConfig.getResumedSessionData).mockReturnValue({
        lastCompletedUuid: 'assistant-1',
      } as unknown as ReturnType<Config['getResumedSessionData']>);
      chatRecordingService = activateRecording(
        new ChatRecordingService(mockConfig),
      );

      chatRecordingService.rebuildTurnBoundaries([
        {
          uuid: 'user-1',
          parentUuid: 'pre-resume-parent',
          sessionId: 'test-session-id',
          timestamp: '2026-06-27T00:00:00.000Z',
          type: 'user',
          cwd: '/test/project/root',
          version: '1.0.0',
          message: { role: 'user', parts: [{ text: 'first resumed turn' }] },
        },
        {
          uuid: 'assistant-1',
          parentUuid: 'user-1',
          sessionId: 'test-session-id',
          timestamp: '2026-06-27T00:00:01.000Z',
          type: 'assistant',
          cwd: '/test/project/root',
          version: '1.0.0',
          message: { role: 'model', parts: [{ text: 'response' }] },
          model: 'gemini-pro',
        },
      ]);

      chatRecordingService.rewindRecording(0, { truncatedCount: 2 });
      await chatRecordingService.flush();

      expect(jsonl.writeLine).toHaveBeenCalledTimes(1);
      const rewind = vi.mocked(jsonl.writeLine).mock.calls[0][1] as ChatRecord;
      expect(rewind.subtype).toBe('rewind');
      expect(rewind.parentUuid).toBe('pre-resume-parent');
    });

    it('treats a rebuilt conversation tail as persisted during failure rollback', async () => {
      chatRecordingService.rebuildTurnBoundaries([
        {
          uuid: 'persisted-tail',
          parentUuid: null,
          sessionId: 'test-session-id',
          timestamp: '2026-06-27T00:00:00.000Z',
          type: 'assistant',
          cwd: '/test/project/root',
          version: '1.0.0',
          message: { role: 'model', parts: [{ text: 'persisted response' }] },
          model: 'gemini-pro',
        },
      ]);
      vi.mocked(jsonl.writeLine).mockRejectedValueOnce(new Error('disk full'));

      chatRecordingService.recordUserMessage([{ text: 'new message' }]);

      await expect(chatRecordingService.flush()).rejects.toThrow('disk full');
      expect(chatRecordingService.getTranscriptCursor()).toEqual({
        recordId: 'persisted-tail',
      });
    });
  });

  describe('recordUserTextElements', () => {
    it('records user text elements as a strict system payload', async () => {
      const payload = {
        content: 'hello',
        textElements: [{ text: 'hello', start: 0, end: 5 }],
      };

      await chatRecordingService.recordUserTextElements(payload);

      expect(jsonl.writeLine).toHaveBeenCalledTimes(1);
      const record = vi.mocked(jsonl.writeLine).mock.calls[0][1] as ChatRecord;
      expect(record.type).toBe('system');
      expect(record.subtype).toBe('user_text_elements');
      expect(record.systemPayload).toEqual(payload);
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

  describe('recordFileHistorySnapshot', () => {
    const oldSnapshot: FileHistorySnapshot = {
      promptId: 'p1',
      timestamp: new Date('2026-06-13T00:00:00.000Z'),
      trackedFileBackups: {
        'a.txt': {
          backupFileName: 'backup-a-v1',
          version: 1,
          backupTime: new Date('2026-06-13T00:00:01.000Z'),
        },
      },
    };
    const updatedSnapshot: FileHistorySnapshot = {
      promptId: 'p1',
      timestamp: new Date('2026-06-13T00:01:00.000Z'),
      trackedFileBackups: {
        'a.txt': {
          backupFileName: 'backup-a-v2',
          version: 2,
          backupTime: new Date('2026-06-13T00:01:01.000Z'),
        },
        'b.txt': {
          backupFileName: null,
          version: 1,
          backupTime: new Date('2026-06-13T00:01:02.000Z'),
        },
      },
    };
    const failedSnapshot: FileHistorySnapshot = {
      promptId: 'p2',
      timestamp: new Date('2026-06-13T00:02:00.000Z'),
      trackedFileBackups: {
        'failed.txt': {
          backupFileName: 'backup-failed-v1',
          version: 1,
          backupTime: new Date('2026-06-13T00:02:01.000Z'),
          failed: true,
        },
        'deleted.txt': {
          backupFileName: null,
          version: 2,
          backupTime: new Date('2026-06-13T00:02:02.000Z'),
        },
      },
    };

    it('writes a system record with the serialized snapshot payload', async () => {
      chatRecordingService.recordFileHistorySnapshot(oldSnapshot);
      await chatRecordingService.flush();

      expect(jsonl.writeLine).toHaveBeenCalledTimes(1);
      const record = vi.mocked(jsonl.writeLine).mock.calls[0][1] as ChatRecord;
      expect(record.type).toBe('system');
      expect(record.subtype).toBe('file_history_snapshot');
      expect(JSON.parse(JSON.stringify(record.systemPayload))).toEqual({
        snapshots: [
          {
            promptId: 'p1',
            timestamp: '2026-06-13T00:00:00.000Z',
            trackedFileBackups: {
              'a.txt': {
                backupFileName: 'backup-a-v1',
                version: 1,
                backupTime: '2026-06-13T00:00:01.000Z',
              },
            },
          },
        ],
      });
    });

    it('writes a batch of serialized snapshots in order', async () => {
      chatRecordingService.recordFileHistorySnapshotBatch([
        oldSnapshot,
        updatedSnapshot,
      ]);
      await chatRecordingService.flush();

      expect(jsonl.writeLine).toHaveBeenCalledTimes(1);
      const record = vi.mocked(jsonl.writeLine).mock.calls[0][1] as ChatRecord;
      expect(record.type).toBe('system');
      expect(record.subtype).toBe('file_history_snapshot');
      expect(JSON.parse(JSON.stringify(record.systemPayload))).toEqual({
        snapshots: [
          {
            promptId: 'p1',
            timestamp: '2026-06-13T00:00:00.000Z',
            trackedFileBackups: {
              'a.txt': {
                backupFileName: 'backup-a-v1',
                version: 1,
                backupTime: '2026-06-13T00:00:01.000Z',
              },
            },
          },
          {
            promptId: 'p1',
            timestamp: '2026-06-13T00:01:00.000Z',
            trackedFileBackups: {
              'a.txt': {
                backupFileName: 'backup-a-v2',
                version: 2,
                backupTime: '2026-06-13T00:01:01.000Z',
              },
              'b.txt': {
                backupFileName: null,
                version: 1,
                backupTime: '2026-06-13T00:01:02.000Z',
              },
            },
          },
        ],
      });
    });

    it('appends single-snapshot updates in order so resume can last-win', async () => {
      chatRecordingService.recordFileHistorySnapshot(oldSnapshot);
      chatRecordingService.recordFileHistorySnapshot(updatedSnapshot);
      await chatRecordingService.flush();

      expect(jsonl.writeLine).toHaveBeenCalledTimes(2);
      const first = vi.mocked(jsonl.writeLine).mock.calls[0][1] as ChatRecord;
      const second = vi.mocked(jsonl.writeLine).mock.calls[1][1] as ChatRecord;
      expect(JSON.parse(JSON.stringify(first.systemPayload))).toEqual({
        snapshots: [
          {
            promptId: 'p1',
            timestamp: '2026-06-13T00:00:00.000Z',
            trackedFileBackups: {
              'a.txt': {
                backupFileName: 'backup-a-v1',
                version: 1,
                backupTime: '2026-06-13T00:00:01.000Z',
              },
            },
          },
        ],
      });
      expect(JSON.parse(JSON.stringify(second.systemPayload))).toEqual({
        snapshots: [
          {
            promptId: 'p1',
            timestamp: '2026-06-13T00:01:00.000Z',
            trackedFileBackups: {
              'a.txt': {
                backupFileName: 'backup-a-v2',
                version: 2,
                backupTime: '2026-06-13T00:01:01.000Z',
              },
              'b.txt': {
                backupFileName: null,
                version: 1,
                backupTime: '2026-06-13T00:01:02.000Z',
              },
            },
          },
        ],
      });
    });

    it('retains distinct prompt ids in one batch', async () => {
      chatRecordingService.recordFileHistorySnapshotBatch([
        oldSnapshot,
        failedSnapshot,
      ]);
      await chatRecordingService.flush();

      expect(jsonl.writeLine).toHaveBeenCalledTimes(1);
      const record = vi.mocked(jsonl.writeLine).mock.calls[0][1] as ChatRecord;
      expect(JSON.parse(JSON.stringify(record.systemPayload))).toEqual({
        snapshots: [
          {
            promptId: 'p1',
            timestamp: '2026-06-13T00:00:00.000Z',
            trackedFileBackups: {
              'a.txt': {
                backupFileName: 'backup-a-v1',
                version: 1,
                backupTime: '2026-06-13T00:00:01.000Z',
              },
            },
          },
          {
            promptId: 'p2',
            timestamp: '2026-06-13T00:02:00.000Z',
            trackedFileBackups: {
              'failed.txt': {
                backupFileName: 'backup-failed-v1',
                version: 1,
                backupTime: '2026-06-13T00:02:01.000Z',
                failed: true,
              },
              'deleted.txt': {
                backupFileName: null,
                version: 2,
                backupTime: '2026-06-13T00:02:02.000Z',
              },
            },
          },
        ],
      });
    });

    it('round-trips serialized snapshots through JSON and deserialization', () => {
      expect(
        deserializeSnapshots([
          JSON.parse(JSON.stringify(serializeSnapshot(failedSnapshot))),
        ]),
      ).toEqual([failedSnapshot]);
    });

    it('re-records surviving snapshots after rewind on the active branch', async () => {
      chatRecordingService.recordFileHistorySnapshot(updatedSnapshot);
      chatRecordingService.rewindRecording(0, { truncatedCount: 1 }, [
        oldSnapshot,
      ]);
      await chatRecordingService.flush();

      expect(jsonl.writeLine).toHaveBeenCalledTimes(3);
      const staleSnapshot = vi.mocked(jsonl.writeLine).mock
        .calls[0][1] as ChatRecord;
      const rewind = vi.mocked(jsonl.writeLine).mock.calls[1][1] as ChatRecord;
      const snapshots = vi.mocked(jsonl.writeLine).mock
        .calls[2][1] as ChatRecord;
      expect(staleSnapshot.subtype).toBe('file_history_snapshot');
      expect(rewind.subtype).toBe('rewind');
      expect(JSON.parse(JSON.stringify(snapshots.systemPayload))).toEqual({
        snapshots: [
          {
            promptId: 'p1',
            timestamp: '2026-06-13T00:00:00.000Z',
            trackedFileBackups: {
              'a.txt': {
                backupFileName: 'backup-a-v1',
                version: 1,
                backupTime: '2026-06-13T00:00:01.000Z',
              },
            },
          },
        ],
      });
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

    it('compacts large resultDisplay metadata before recording', async () => {
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
        resultDisplay: `head-${'x'.repeat(
          MAX_RETAINED_TOOL_RESULT_DISPLAY_CHARS,
        )}-tail`,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;

      chatRecordingService.recordToolResult(toolResultParts, metadata);
      await chatRecordingService.flush();

      const record = vi.mocked(jsonl.writeLine).mock.calls[0][1] as ChatRecord;
      const resultDisplay = record.toolCallResult?.resultDisplay;

      expect(typeof resultDisplay).toBe('string');
      expect((resultDisplay as string).length).toBeLessThanOrEqual(
        MAX_RETAINED_TOOL_RESULT_DISPLAY_CHARS,
      );
      expect(resultDisplay).toContain('head-');
      expect(resultDisplay).toContain('-tail');
      expect(resultDisplay).toContain('truncated for saved session preview');
      expect(resultDisplay).not.toContain('CLI history display');
    });

    it('records promptId on tool results when provided', async () => {
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

    it('permanently stops recording after a failed write', async () => {
      const writeError = new Error('simulated EACCES');
      vi.mocked(jsonl.writeLine).mockRejectedValueOnce(writeError);
      chatRecordingService.recordUserMessage([{ text: 'first' }]);
      chatRecordingService.recordUserMessage([{ text: 'second' }]);
      await expect(chatRecordingService.flush()).rejects.toBe(writeError);

      expect(jsonl.writeLine).toHaveBeenCalledTimes(1);

      chatRecordingService.recordAssistantTurn({
        model: 'gemini-pro',
        message: [{ text: 'third' }],
      });
      expect(jsonl.writeLine).toHaveBeenCalledTimes(1);
      await expect(chatRecordingService.flush()).rejects.toBe(writeError);
      expect(jsonl.writeLine).toHaveBeenCalledTimes(1);
    });

    it('scopes a write failure to the recorder instance', async () => {
      vi.mocked(jsonl.writeLine)
        .mockRejectedValueOnce(new Error('disk full'))
        .mockResolvedValue(undefined);
      chatRecordingService.recordUserMessage([{ text: 'first' }]);
      await expect(chatRecordingService.flush()).rejects.toThrow('disk full');

      const nextRecordingService = activateRecording(
        new ChatRecordingService(mockConfig),
      );
      nextRecordingService.recordUserMessage([{ text: 'new session' }]);
      await expect(nextRecordingService.flush()).resolves.toBeUndefined();

      expect(jsonl.writeLine).toHaveBeenCalledTimes(2);
    });

    it('normalizes a non-Error rejection and keeps it sticky', async () => {
      vi.mocked(jsonl.writeLine).mockRejectedValueOnce('disk full');
      chatRecordingService.recordUserMessage([{ text: 'first' }]);

      let firstFailure: unknown;
      try {
        await chatRecordingService.flush();
      } catch (error) {
        firstFailure = error;
      }
      expect(firstFailure).toEqual(new Error('disk full'));
      await expect(chatRecordingService.flush()).rejects.toBe(firstFailure);
    });

    it('notifies once with the failed record session id', async () => {
      let rejectWrite!: (error: Error) => void;
      vi.mocked(jsonl.writeLine).mockReturnValueOnce(
        new Promise<void>((_resolve, reject) => {
          rejectWrite = reject;
        }),
      );
      const listener = vi.fn();
      const service = activateRecording(
        new ChatRecordingService(mockConfig, listener),
      );

      service.recordUserMessage([{ text: 'first' }]);
      service.recordUserMessage([{ text: 'queued descendant' }]);
      vi.mocked(mockConfig.getSessionId).mockReturnValue('new-session-id');
      const writeError = new Error('disk full');
      rejectWrite(writeError);

      await expect(service.flush()).rejects.toBe(writeError);
      service.recordUserMessage([{ text: 'after failure' }]);
      await expect(service.flush()).rejects.toBe(writeError);
      expect(jsonl.writeLine).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledOnce();
      expect(listener).toHaveBeenCalledWith({
        sessionId: 'test-session-id',
        error: writeError,
      });
    });

    it('allows a replacement recorder to notify independently', async () => {
      const firstListener = vi.fn();
      const secondListener = vi.fn();
      vi.mocked(jsonl.writeLine)
        .mockRejectedValueOnce(new Error('first failure'))
        .mockRejectedValueOnce(new Error('second failure'));

      const first = activateRecording(
        new ChatRecordingService(mockConfig, firstListener),
      );
      first.recordUserMessage([{ text: 'first' }]);
      await expect(first.flush()).rejects.toThrow('first failure');

      const second = activateRecording(
        new ChatRecordingService(mockConfig, secondListener),
      );
      second.recordUserMessage([{ text: 'second' }]);
      await expect(second.flush()).rejects.toThrow('second failure');

      expect(firstListener).toHaveBeenCalledOnce();
      expect(secondListener).toHaveBeenCalledOnce();
    });

    it('isolates synchronous and asynchronous listener failures', async () => {
      const unhandled: unknown[] = [];
      const handler = (error: unknown) => unhandled.push(error);
      process.on('unhandledRejection', handler);
      try {
        const syncFailure = activateRecording(
          new ChatRecordingService(mockConfig, () => {
            throw new Error('listener threw');
          }),
        );
        vi.mocked(jsonl.writeLine).mockRejectedValueOnce(
          new Error('sync observer write failure'),
        );
        syncFailure.recordUserMessage([{ text: 'first' }]);
        await expect(syncFailure.flush()).rejects.toThrow(
          'sync observer write failure',
        );

        const asyncFailure = activateRecording(
          new ChatRecordingService(mockConfig, async () => {
            throw new Error('listener rejected');
          }),
        );
        vi.mocked(jsonl.writeLine).mockRejectedValueOnce(
          new Error('async observer write failure'),
        );
        asyncFailure.recordUserMessage([{ text: 'second' }]);
        await expect(asyncFailure.flush()).rejects.toThrow(
          'async observer write failure',
        );
        await new Promise((resolve) => setImmediate(resolve));
        expect(unhandled).toEqual([]);
      } finally {
        process.off('unhandledRejection', handler);
      }
    });
  });

  describe('legacy recorder', () => {
    it('retries directory setup after a synchronous failure', async () => {
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

      const service = new ChatRecordingService(mockConfig, undefined, false);
      service.recordUserMessage([{ text: 'retry me' }]);
      await expect(service.flush()).resolves.toBeUndefined();
      expect(jsonl.writeLine).not.toHaveBeenCalled();

      service.recordUserMessage([{ text: 'retry me' }]);
      await expect(service.flush()).resolves.toBeUndefined();

      expect(mkdirSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(jsonl.writeLine).toHaveBeenCalledTimes(1);
      const record = vi.mocked(jsonl.writeLine).mock.calls[0][1] as ChatRecord;
      expect(record.parentUuid).toBeNull();
    });

    it('does not notify for a synchronous conversation-file failure', () => {
      const listener = vi.fn();
      const service = new ChatRecordingService(mockConfig, listener, false);
      vi.spyOn(fs, 'writeFileSync').mockImplementationOnce(() => {
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      });

      service.recordUserMessage([{ text: 'retry me' }]);

      expect(listener).not.toHaveBeenCalled();
      expect(jsonl.writeLine).not.toHaveBeenCalled();
    });

    it('caches successful directory setup', async () => {
      const mkdirSpy = vi
        .spyOn(fs, 'mkdirSync')
        .mockImplementation(() => undefined);
      const service = new ChatRecordingService(mockConfig, undefined, false);

      service.recordUserMessage([{ text: 'first' }]);
      await service.flush();
      service.recordUserMessage([{ text: 'second' }]);
      await service.flush();
      service.recordUserMessage([{ text: 'third' }]);
      await service.flush();

      expect(mkdirSpy).toHaveBeenCalledTimes(1);
    });

    it('retries an identical attribution snapshot after a synchronous failure', async () => {
      const snapshot = {
        type: 'attribution-snapshot' as const,
        version: 1,
        surface: 'cli',
        fileStates: {},
        promptCount: 0,
        promptCountAtLastCommit: 0,
      };
      const writeFileSpy = vi.spyOn(fs, 'writeFileSync');
      writeFileSpy.mockImplementationOnce(() => {
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      });
      const service = new ChatRecordingService(mockConfig, undefined, false);

      service.recordAttributionSnapshot(snapshot);
      await service.flush();
      expect(jsonl.writeLine).not.toHaveBeenCalled();

      service.recordAttributionSnapshot(snapshot);
      await service.flush();
      expect(jsonl.writeLine).toHaveBeenCalledTimes(1);
    });
  });

  describe('recordAttributionSnapshot', () => {
    const baseSnapshot = {
      type: 'attribution-snapshot' as const,
      version: 1,
      surface: 'cli',
      fileStates: {},
      promptCount: 0,
      promptCountAtLastCommit: 0,
    };

    it('should write each distinct snapshot', async () => {
      chatRecordingService.recordAttributionSnapshot(baseSnapshot);
      chatRecordingService.recordAttributionSnapshot({
        ...baseSnapshot,
        promptCount: 1,
      });
      chatRecordingService.recordAttributionSnapshot({
        ...baseSnapshot,
        promptCount: 2,
      });
      await chatRecordingService.flush();
      expect(jsonl.writeLine).toHaveBeenCalledTimes(3);
    });

    it('refreshes the cached git branch at the attribution turn boundary', async () => {
      vi.mocked(execSync)
        .mockReturnValueOnce('main\n')
        .mockReturnValueOnce('feature\n');

      chatRecordingService.recordUserMessage([{ text: 'first' }]);
      await chatRecordingService.flush();
      chatRecordingService.recordAttributionSnapshot({
        ...baseSnapshot,
        promptCount: 1,
      });
      await chatRecordingService.flush();

      const userRecord = vi.mocked(jsonl.writeLine).mock
        .calls[0][1] as ChatRecord;
      const attributionRecord = vi.mocked(jsonl.writeLine).mock
        .calls[1][1] as ChatRecord;
      expect(userRecord.gitBranch).toBe('main');
      expect(attributionRecord.gitBranch).toBe('feature');
    });

    // Sessions that touch many files emit a non-retry turn snapshot
    // every prompt cycle. Without dedup, repeated identical snapshots
    // (no edits, no prompt-counter change) would re-serialize the entire
    // attribution state into the JSONL on every turn, inflating session
    // size and slowing /resume.
    it('should skip a snapshot identical to the previous write', async () => {
      chatRecordingService.recordAttributionSnapshot(baseSnapshot);
      chatRecordingService.recordAttributionSnapshot(baseSnapshot);
      chatRecordingService.recordAttributionSnapshot(baseSnapshot);
      await chatRecordingService.flush();
      expect(jsonl.writeLine).toHaveBeenCalledTimes(1);
    });

    // After rewindRecording, the previous attribution snapshot lives on
    // the abandoned branch, so the dedup key has to clear — otherwise
    // the post-rewind identical snapshot would be silently skipped and
    // /resume on the rewound session would lose all attribution state.
    it('should re-write an identical snapshot after rewindRecording', async () => {
      chatRecordingService.recordUserMessage([{ text: 'turn 1' }]);
      chatRecordingService.recordAttributionSnapshot(baseSnapshot);
      await chatRecordingService.flush();
      const beforeRewind = vi.mocked(jsonl.writeLine).mock.calls.length;

      chatRecordingService.rewindRecording(0, { truncatedCount: 0 });
      // Same snapshot bytes — without the rewind reset this would dedup.
      chatRecordingService.recordAttributionSnapshot(baseSnapshot);
      await chatRecordingService.flush();
      // 1 rewind record + 1 fresh snapshot = 2 more writes after rewind.
      expect(vi.mocked(jsonl.writeLine).mock.calls.length).toBe(
        beforeRewind + 2,
      );
    });

    it('should not retry an identical snapshot after a write failure', async () => {
      const writeError = new Error('disk full');
      vi.mocked(jsonl.writeLine).mockRejectedValueOnce(writeError);
      chatRecordingService.recordAttributionSnapshot(baseSnapshot);
      await expect(chatRecordingService.flush()).rejects.toBe(writeError);

      chatRecordingService.recordAttributionSnapshot(baseSnapshot);
      await expect(chatRecordingService.flush()).rejects.toBe(writeError);
      expect(jsonl.writeLine).toHaveBeenCalledTimes(1);
    });

    it('should handle fire-and-forget rejection while flush reports it', async () => {
      vi.mocked(jsonl.writeLine).mockRejectedValueOnce(new Error('disk full'));
      const unhandled: unknown[] = [];
      const handler = (err: unknown) => unhandled.push(err);
      process.on('unhandledRejection', handler);
      try {
        chatRecordingService.recordUserMessage([{ text: 'hi' }]);
        await new Promise((resolve) => setImmediate(resolve));
        expect(unhandled).toHaveLength(0);
        await expect(chatRecordingService.flush()).rejects.toThrow('disk full');
      } finally {
        process.off('unhandledRejection', handler);
      }
    });

    it('restores the last persisted cursor when a normal write and its successor are skipped by failure', async () => {
      chatRecordingService.recordUserMessage([{ text: 'persisted baseline' }]);
      await chatRecordingService.flush();
      const persistedCursor = chatRecordingService.getTranscriptCursor();

      let rejectWrite!: (error: Error) => void;
      const failedWrite = new Promise<void>((_resolve, reject) => {
        rejectWrite = reject;
      });
      vi.mocked(jsonl.writeLine).mockImplementationOnce(() => failedWrite);

      chatRecordingService.recordUserMessage([{ text: 'failing write' }]);
      chatRecordingService.recordUserMessage([{ text: 'queued successor' }]);
      rejectWrite(new Error('disk full'));

      await expect(chatRecordingService.flush()).rejects.toThrow('disk full');
      expect(jsonl.writeLine).toHaveBeenCalledTimes(2);
      expect(chatRecordingService.getTranscriptCursor()).toEqual(
        persistedCursor,
      );
    });

    it('stops queued normal writes when a strict artifact write fails', async () => {
      let rejectStrict!: (error: Error) => void;
      const strictWrite = new Promise<void>((_resolve, reject) => {
        rejectStrict = reject;
      });
      vi.mocked(jsonl.writeLine)
        .mockImplementationOnce(() => strictWrite)
        .mockResolvedValue(undefined);

      const strict = chatRecordingService.recordSessionArtifactEvent({
        v: 2,
        sessionId: 'test-session-id',
        sequence: 1,
        recordedAt: '2026-07-04T00:00:00.000Z',
        changes: [],
      });
      chatRecordingService.recordUserMessage([{ text: 'after strict write' }]);
      rejectStrict(new Error('disk full'));

      await expect(strict).rejects.toThrow('disk full');
      await expect(chatRecordingService.flush()).rejects.toThrow('disk full');
      expect(jsonl.writeLine).toHaveBeenCalledTimes(1);

      chatRecordingService.recordUserMessage([{ text: 'next message' }]);
      await expect(
        chatRecordingService.recordSessionArtifactSnapshot({
          v: 2,
          sessionId: 'test-session-id',
          sequence: 2,
          recordedAt: '2026-07-04T00:00:01.000Z',
          artifacts: [],
          tombstonedIds: [],
          stickyEphemeralIds: [],
        }),
      ).rejects.toThrow('disk full');
      expect(jsonl.writeLine).toHaveBeenCalledTimes(1);
    });

    it('rejects strict artifact records after a previous strict write failed', async () => {
      const writeError = new Error('corrupt journal');
      vi.mocked(jsonl.writeLine)
        .mockRejectedValueOnce(writeError)
        .mockResolvedValue(undefined);

      await expect(
        chatRecordingService.recordSessionArtifactEvent({
          v: 2,
          sessionId: 'test-session-id',
          sequence: 1,
          recordedAt: '2026-07-04T00:00:00.000Z',
          changes: [],
        }),
      ).rejects.toBe(writeError);

      await expect(
        chatRecordingService.recordSessionArtifactSnapshot({
          v: 2,
          sessionId: 'test-session-id',
          sequence: 2,
          recordedAt: '2026-07-04T00:00:01.000Z',
          artifacts: [],
          tombstonedIds: [],
          stickyEphemeralIds: [],
        }),
      ).rejects.toBe(writeError);
      await expect(chatRecordingService.flush()).rejects.toBe(writeError);
      expect(jsonl.writeLine).toHaveBeenCalledTimes(1);
    });

    it('does not let anchor size estimation preempt a strict writer result', async () => {
      await chatRecordingService.recordCustomTitle('durable-title');
      vi.mocked(jsonl.writeLine).mockClear();
      const circular: Record<string, unknown> = {};
      circular['self'] = circular;
      const payload = {
        v: 2,
        sessionId: 'test-session-id',
        sequence: 1,
        recordedAt: '2026-07-04T00:00:00.000Z',
        changes: [
          {
            action: 'upsert',
            artifactId: 'artifact-1',
            artifact: circular,
          },
        ],
      } as unknown as Parameters<
        ChatRecordingService['recordSessionArtifactEvent']
      >[0];

      await expect(
        chatRecordingService.recordSessionArtifactEvent(payload),
      ).resolves.toBeUndefined();
      expect(jsonl.writeLine).toHaveBeenCalledOnce();
    });

    it('keeps artifact journal records out of the active conversation chain', async () => {
      chatRecordingService.recordUserMessage([{ text: 'before artifact' }]);
      await chatRecordingService.flush();

      await chatRecordingService.recordSessionArtifactEvent({
        v: 2,
        sessionId: 'test-session-id',
        sequence: 1,
        recordedAt: '2026-07-04T00:00:00.000Z',
        changes: [],
      });

      chatRecordingService.recordUserMessage([{ text: 'after artifact' }]);
      await chatRecordingService.flush();

      const before = vi.mocked(jsonl.writeLine).mock.calls[0][1] as ChatRecord;
      const artifact = vi.mocked(jsonl.writeLine).mock
        .calls[1][1] as ChatRecord;
      const after = vi.mocked(jsonl.writeLine).mock.calls[2][1] as ChatRecord;
      expect(artifact.parentUuid).toBe(before.uuid);
      expect(after.parentUuid).toBe(before.uuid);
      expect(after.parentUuid).not.toBe(artifact.uuid);
    });
  });

  // Note: Session management tests (listSessions, loadSession, deleteSession, etc.)
  // have been moved to sessionService.test.ts
  // Session resume integration tests should test via SessionService mock
});
