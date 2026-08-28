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
  isTurnResultRecordPayload,
  normalizeTurnResultError,
  TURN_RESULT_ERROR_CODE_MAX_CHARS,
  TURN_RESULT_IDENTIFIER_MAX_CHARS,
  TURN_RESULT_ERROR_MESSAGE_MAX_CHARS,
  type ChatRecord,
  type AtCommandRecordPayload,
  type TurnResultRecordPayload,
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
import {
  SessionWriterLostError,
  SessionTranscriptChangedError,
  SessionWriterUnavailableError,
  type SessionWriterLease,
} from './session-writer-lease.js';
import {
  buildApiHistoryFromConversation,
  getApiHistoryPromptId,
  markApiHistoryPrompt,
} from './session-api-history.js';
import type {
  GoalStateRecordPayloadV2,
  GoalTurnPermit,
} from '../goals/goal-protocol.js';
import type { ToolResultBoundaryObservation } from '../tools/tool-result-boundary-diagnostics.js';
import { CompressionStatus } from '../core/turn.js';

function branchTestRecord(
  uuid: string,
  parentUuid: string | null,
  type: ChatRecord['type'],
  parts: Part[],
): ChatRecord {
  return {
    uuid,
    parentUuid,
    sessionId: 'test-session-id',
    timestamp: '2026-08-10T00:00:00.000Z',
    type,
    provenance:
      type === 'user'
        ? 'real_user'
        : type === 'assistant'
          ? 'assistant_output'
          : type === 'tool_result'
            ? 'tool_result'
            : 'system',
    cwd: '/test/project/root',
    version: '1.0.0',
    message: { role: type === 'assistant' ? 'model' : 'user', parts },
  };
}

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

const boundaryObserveMock = vi.hoisted(() =>
  vi.fn((_observation: ToolResultBoundaryObservation) => false),
);
vi.mock(
  '../tools/tool-result-boundary-diagnostics.js',
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import('../tools/tool-result-boundary-diagnostics.js')
    >()),
    observeToolResultBoundary: boundaryObserveMock,
  }),
);

describe('ChatRecordingService', () => {
  let chatRecordingService: ChatRecordingService;
  let mockConfig: Config;
  let mockLease: SessionWriterLease;

  let uuidCounter = 0;

  beforeEach(() => {
    uuidCounter = 0;
    boundaryObserveMock.mockClear();

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
      sealForHandoff: vi.fn().mockResolvedValue(undefined),
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
      chatRecordingService.recordUserMessage(
        userParts,
        undefined,
        undefined,
        'prompt-1',
      );
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
      expect(record.promptId).toBe('prompt-1');
    });

    it('preserves model-bound parts and records clean display text', async () => {
      const modelParts: Part[] = [
        { text: 'expanded model prompt' },
        {
          text: [
            '<qwen:user-prompt-submit-context>',
            'hook-only context',
            '</qwen:user-prompt-submit-context>',
          ].join('\n'),
        },
      ];

      chatRecordingService.recordUserMessage(modelParts, undefined, {
        displayText: 'raw @file prompt',
        hookContext: 'hook-only context',
      });
      await chatRecordingService.flush();

      const record = vi.mocked(jsonl.writeLine).mock.calls[0][1] as ChatRecord;
      expect(record.message).toEqual({ role: 'user', parts: modelParts });
      expect(record.systemPayload).toEqual({
        displayText: 'raw @file prompt',
        hookContext: 'hook-only context',
      });
    });

    it('records empty display text without dropping prompt provenance', async () => {
      chatRecordingService.recordUserMessage(
        [
          {
            text: [
              '<qwen:user-prompt-submit-context>',
              'hook-only context',
              '</qwen:user-prompt-submit-context>',
            ].join('\n'),
          },
        ],
        undefined,
        {
          displayText: '',
          hookContext: 'hook-only context',
        },
      );
      await chatRecordingService.flush();

      const record = vi.mocked(jsonl.writeLine).mock.calls[0][1] as ChatRecord;
      expect(record.systemPayload).toEqual({
        displayText: '',
        hookContext: 'hook-only context',
      });
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

    it('records mid-turn attachment references without inline bytes', async () => {
      const attachmentReferences = [
        {
          type: 'image' as const,
          attachmentId: 'image.png',
          mimeType: 'image/png',
          size: 3,
        },
      ];

      chatRecordingService.recordMidTurnUserMessage(
        [{ text: 'inspect image' }],
        'inspect image',
        undefined,
        attachmentReferences,
      );
      await chatRecordingService.flush();

      const record = vi.mocked(jsonl.writeLine).mock.calls[0][1] as ChatRecord;
      expect(record.message).toEqual({
        role: 'user',
        parts: [{ text: 'inspect image' }],
      });
      expect(record.systemPayload).toEqual({
        displayText: 'inspect image',
        attachmentReferences,
      });
    });

    it('records attachment references when the mid-turn display text is empty', async () => {
      const attachmentReferences = [
        {
          type: 'image' as const,
          attachmentId: 'image.png',
          mimeType: 'image/png',
          size: 3,
        },
      ];

      chatRecordingService.recordMidTurnUserMessage(
        [{ text: '[User message received during tool execution]: ' }],
        '',
        undefined,
        attachmentReferences,
      );
      await chatRecordingService.flush();

      const record = vi.mocked(jsonl.writeLine).mock.calls[0][1] as ChatRecord;
      expect(record.systemPayload).toEqual({
        displayText: '',
        attachmentReferences,
      });
    });

    it('records defensive Goal context on real user messages', async () => {
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
        provenance: 'real_user',
        goalContext: {
          goalId: 'goal-1',
          revision: 2,
          turnId: 'turn-top-level',
        },
      });
      expect(midTurn).toMatchObject({
        subtype: 'mid_turn_user_message',
        provenance: 'real_user',
        goalContext: {
          goalId: 'goal-1',
          revision: 2,
          turnId: 'turn-mid-turn',
        },
      });
    });

    it('classifies notification-like records as system provenance', async () => {
      const permit: GoalTurnPermit = {
        goalId: 'goal-1',
        revision: 2,
        turnId: 'turn-notification',
      };

      chatRecordingService.recordNotification(
        [{ text: 'dependency completed' }],
        'Dependency completed',
        {
          taskId: 'task-1',
          status: 'completed',
          kind: 'agent',
        },
        permit,
      );
      permit.turnId = 'mutated';
      await chatRecordingService.flush();

      const record = vi.mocked(jsonl.writeLine).mock.calls[0][1] as ChatRecord;
      expect(record).toMatchObject({
        subtype: 'notification',
        provenance: 'system',
        goalContext: {
          goalId: 'goal-1',
          revision: 2,
          turnId: 'turn-notification',
        },
        systemPayload: {
          displayText: 'Dependency completed',
          backgroundTask: {
            taskId: 'task-1',
            status: 'completed',
            kind: 'agent',
          },
        },
      });
    });
  });

  describe('retireTurnBoundary', () => {
    it('pops the newest boundary when the promptId matches', () => {
      chatRecordingService.recordUserMessage(
        [{ text: 'first' }],
        undefined,
        { displayText: 'first', hookContext: '' },
        'prompt-1',
      );
      chatRecordingService.recordUserMessage(
        [{ text: 'second' }],
        undefined,
        { displayText: 'second', hookContext: '' },
        'prompt-2',
      );
      expect(chatRecordingService.getRewindableTurnPromptIds()).toEqual([
        'prompt-1',
        'prompt-2',
      ]);

      expect(chatRecordingService.retireTurnBoundary('prompt-2')).toBe(true);

      // The newest boundary and its title display text are retired together,
      // keeping the boundary space aligned with the positional turns after a
      // prompt is dropped before its content ever reaches API history.
      expect(chatRecordingService.getRewindableTurnPromptIds()).toEqual([
        'prompt-1',
      ]);
      expect(chatRecordingService.getUserDisplayTextsForTitle()).toEqual([
        'first',
      ]);
    });

    it('is a no-op unless the newest boundary owns the promptId', () => {
      chatRecordingService.recordUserMessage(
        [{ text: 'first' }],
        undefined,
        { displayText: 'first', hookContext: '' },
        'prompt-1',
      );
      chatRecordingService.recordUserMessage(
        [{ text: 'second' }],
        undefined,
        { displayText: 'second', hookContext: '' },
        'prompt-2',
      );

      // Retiring an older (or unknown/empty) boundary would shift every later
      // slot — the same desync a leaked boundary creates — so it must refuse.
      expect(chatRecordingService.retireTurnBoundary('prompt-1')).toBe(false);
      expect(chatRecordingService.retireTurnBoundary('prompt-missing')).toBe(
        false,
      );
      expect(chatRecordingService.retireTurnBoundary('')).toBe(false);

      expect(chatRecordingService.getRewindableTurnPromptIds()).toEqual([
        'prompt-1',
        'prompt-2',
      ]);
      expect(chatRecordingService.getUserDisplayTextsForTitle()).toEqual([
        'first',
        'second',
      ]);
    });

    it('keeps the next recorded turn paired after a retirement', () => {
      chatRecordingService.recordUserMessage(
        [{ text: 'dropped' }],
        undefined,
        { displayText: 'dropped', hookContext: '' },
        'prompt-dropped',
      );
      expect(chatRecordingService.retireTurnBoundary('prompt-dropped')).toBe(
        true,
      );

      chatRecordingService.recordUserMessage(
        [{ text: 'next' }],
        undefined,
        { displayText: 'next', hookContext: '' },
        'prompt-next',
      );

      expect(chatRecordingService.getRewindableTurnPromptIds()).toEqual([
        'prompt-next',
      ]);
      expect(chatRecordingService.getUserDisplayTextsForTitle()).toEqual([
        'next',
      ]);
    });
  });

  describe('recordBranchCheckpointTransaction', () => {
    it('durably records a checkpoint for a completed text turn', async () => {
      const cursor = chatRecordingService.getBranchCheckpointCursor();
      chatRecordingService.recordUserMessage([{ text: 'hello' }]);
      chatRecordingService.recordAssistantTurn({
        model: 'gemini-pro',
        message: [{ text: 'hi' }],
      });
      await chatRecordingService.recordCustomTitle('Title', 'manual');

      const point =
        await chatRecordingService.recordBranchCheckpointTransaction({
          cursor,
          stopReason: 'end_turn',
        });

      expect(point).toEqual({
        startExclusiveRecordUuid: null,
        endInclusiveRecordUuid: '00000000-0000-0000-0000-000000000003',
        assistantRecordUuid: '00000000-0000-0000-0000-000000000002',
        checkpointUuid: '00000000-0000-0000-0000-000000000004',
      });
      const checkpoint = vi
        .mocked(mockLease.appendJsonLine)
        .mock.calls.at(-1)?.[0] as ChatRecord;
      expect(checkpoint).toMatchObject({
        uuid: point?.checkpointUuid,
        parentUuid: point?.endInclusiveRecordUuid,
        subtype: 'branch_checkpoint',
        systemPayload: {
          v: 1,
          startExclusiveRecordUuid: null,
          assistantRecordUuid: point?.assistantRecordUuid,
        },
      });
      expect(checkpoint.systemPayload).not.toHaveProperty('promptId');
      expect(mockConfig.getSessionService).not.toHaveBeenCalled();
    });

    it('validates successive turns from in-memory cursors without reloading history', async () => {
      const firstCursor = chatRecordingService.getBranchCheckpointCursor();
      chatRecordingService.recordUserMessage([{ text: 'first' }]);
      chatRecordingService.recordAssistantTurn({
        model: 'gemini-pro',
        message: [{ text: 'first answer' }],
      });
      const first =
        await chatRecordingService.recordBranchCheckpointTransaction({
          cursor: firstCursor,
          stopReason: 'end_turn',
        });

      const secondCursor = chatRecordingService.getBranchCheckpointCursor();
      chatRecordingService.recordUserMessage([{ text: 'second' }]);
      chatRecordingService.recordAssistantTurn({
        model: 'gemini-pro',
        message: [{ text: 'second answer' }],
      });
      const second =
        await chatRecordingService.recordBranchCheckpointTransaction({
          cursor: secondCursor,
          stopReason: 'end_turn',
        });

      expect(first).toBeDefined();
      expect(second).toBeDefined();
      expect(second?.startExclusiveRecordUuid).toBe(first?.checkpointUuid);
      expect(mockConfig.getSessionService).not.toHaveBeenCalled();
    });

    it('orders metadata arriving during validation after the checkpoint', async () => {
      const cursor = chatRecordingService.getBranchCheckpointCursor();
      chatRecordingService.recordUserMessage([{ text: 'hello' }]);
      chatRecordingService.recordAssistantTurn({
        model: 'gemini-pro',
        message: [{ text: 'hi' }],
      });

      const checkpoint = chatRecordingService.recordBranchCheckpointTransaction(
        {
          cursor,
          stopReason: 'end_turn',
        },
      );
      const title = chatRecordingService.recordCustomTitle('Title', 'manual');
      const point = await checkpoint;
      await title;

      const records = vi
        .mocked(mockLease.appendJsonLine)
        .mock.calls.map((call) => call[0] as ChatRecord);
      expect(records.map((record) => record.subtype)).toEqual([
        undefined,
        undefined,
        'branch_checkpoint',
        'custom_title',
      ]);
      expect(records.at(-1)?.parentUuid).toBe(point?.checkpointUuid);
    });

    it('keeps a buffered side artifact out of the active branch tail', async () => {
      const cursor = chatRecordingService.getBranchCheckpointCursor();
      chatRecordingService.recordUserMessage([{ text: 'hello' }]);
      chatRecordingService.recordAssistantTurn({
        model: 'gemini-pro',
        message: [{ text: 'hi' }],
      });

      const checkpoint = chatRecordingService.recordBranchCheckpointTransaction(
        { cursor, stopReason: 'end_turn' },
      );
      const artifact = chatRecordingService.recordSessionArtifactEvent({
        v: 2,
        sessionId: 'test-session-id',
        sequence: 1,
        recordedAt: '2026-08-10T00:00:00.000Z',
        changes: [],
      });
      const point = await checkpoint;
      await artifact;

      const records = vi
        .mocked(mockLease.appendJsonLine)
        .mock.calls.map((call) => call[0] as ChatRecord);
      expect(records.map((record) => record.subtype)).toEqual([
        undefined,
        undefined,
        'branch_checkpoint',
        'session_artifact_event',
      ]);
      expect(records.at(-1)?.parentUuid).toBe(point?.checkpointUuid);
      expect(chatRecordingService.getBranchCheckpointCursor()).toMatchObject({
        recordId: point?.checkpointUuid,
        activeRecordCount: 3,
      });
    });

    it('restores pending tool state before checkpointing a continued turn', async () => {
      const restored = [
        branchTestRecord('user-1', null, 'user', [{ text: 'first' }]),
        branchTestRecord('assistant-tool-1', 'user-1', 'assistant', [
          { functionCall: { id: 'call-1', name: 'read_file', args: {} } },
        ]),
        branchTestRecord('tool-1', 'assistant-tool-1', 'tool_result', [
          {
            functionResponse: {
              id: 'call-1',
              name: 'read_file',
              response: { output: 'ok' },
            },
          },
        ]),
        branchTestRecord('assistant-1', 'tool-1', 'assistant', [
          { text: 'first done' },
        ]),
        branchTestRecord('user-2', 'assistant-1', 'user', [{ text: 'second' }]),
        branchTestRecord('assistant-tool-2', 'user-2', 'assistant', [
          { functionCall: { id: 'call-2', name: 'shell', args: {} } },
        ]),
      ];
      chatRecordingService.rebuildTurnBoundaries(restored);
      const cursor = chatRecordingService.getBranchCheckpointCursor();

      chatRecordingService.recordToolResult([
        {
          functionResponse: {
            id: 'call-2',
            name: 'shell',
            response: { output: 'ok' },
          },
        },
      ]);
      chatRecordingService.recordAssistantTurn({
        model: 'gemini-pro',
        message: [{ text: 'second done' }],
      });

      await expect(
        chatRecordingService.recordBranchCheckpointTransaction({
          cursor,
          stopReason: 'end_turn',
        }),
      ).resolves.toMatchObject({
        startExclusiveRecordUuid: 'assistant-tool-2',
        assistantRecordUuid: '00000000-0000-0000-0000-000000000002',
      });
    });

    it('tracks tool calls incrementally across a checkpoint cursor', async () => {
      chatRecordingService.recordUserMessage([{ text: 'question' }]);
      chatRecordingService.recordAssistantTurn({
        model: 'gemini-pro',
        message: [
          { functionCall: { id: 'call-1', name: 'read_file', args: {} } },
        ],
      });
      const cursor = chatRecordingService.getBranchCheckpointCursor();

      chatRecordingService.recordToolResult([
        {
          functionResponse: {
            id: 'call-1',
            name: 'read_file',
            response: { output: 'ok' },
          },
        },
      ]);
      chatRecordingService.recordAssistantTurn({
        model: 'gemini-pro',
        message: [{ text: 'done' }],
      });

      await expect(
        chatRecordingService.recordBranchCheckpointTransaction({
          cursor,
          stopReason: 'end_turn',
        }),
      ).resolves.toMatchObject({
        startExclusiveRecordUuid: cursor.recordId,
        assistantRecordUuid: '00000000-0000-0000-0000-000000000004',
      });
    });

    it('rejects a completed turn with a dangling tool call', async () => {
      const cursor = chatRecordingService.getBranchCheckpointCursor();
      chatRecordingService.recordUserMessage([{ text: 'question' }]);
      chatRecordingService.recordAssistantTurn({
        model: 'gemini-pro',
        message: [
          { functionCall: { id: 'call-1', name: 'read_file', args: {} } },
        ],
      });

      await expect(
        chatRecordingService.recordBranchCheckpointTransaction({
          cursor,
          stopReason: 'end_turn',
        }),
      ).resolves.toBeUndefined();
    });

    it.each([{ recordId: 'stale-record' }, { activeRecordCount: 99 }])(
      'rejects a stale checkpoint cursor: %o',
      async (cursorOverride) => {
        const cursor = chatRecordingService.getBranchCheckpointCursor();
        chatRecordingService.recordUserMessage([{ text: 'hello' }]);
        chatRecordingService.recordAssistantTurn({
          model: 'gemini-pro',
          message: [{ text: 'hi' }],
        });

        await expect(
          chatRecordingService.recordBranchCheckpointTransaction({
            cursor: { ...cursor, ...cursorOverride },
            stopReason: 'end_turn',
          }),
        ).rejects.toThrow(
          'Transcript changed while recording branch checkpoint',
        );
      },
    );

    it('releases buffered appends with a continuous chain when no candidate exists', async () => {
      const cursor = chatRecordingService.getBranchCheckpointCursor();
      chatRecordingService.recordUserMessage([{ text: 'no assistant yet' }]);
      const checkpoint = chatRecordingService.recordBranchCheckpointTransaction(
        {
          cursor,
          stopReason: 'end_turn',
        },
      );
      const title = chatRecordingService.recordCustomTitle('Title', 'manual');
      chatRecordingService.recordUserMessage([{ text: 'next turn' }]);

      await expect(checkpoint).resolves.toBeUndefined();
      await expect(title).resolves.toBe(true);
      await chatRecordingService.flush();

      const records = vi
        .mocked(mockLease.appendJsonLine)
        .mock.calls.map((call) => call[0] as ChatRecord);
      expect(records.map((record) => record.subtype)).toEqual([
        undefined,
        'custom_title',
        undefined,
      ]);
      expect(records[1]?.parentUuid).toBe(records[0]?.uuid);
      expect(records[2]?.parentUuid).toBe(records[1]?.uuid);
      expect(chatRecordingService.getTranscriptCursor().recordId).toBe(
        records[2]?.uuid,
      );
    });

    it.each(['cancelled', 'max_tokens'])(
      'does not record a checkpoint for a %s turn',
      async (stopReason) => {
        chatRecordingService.recordUserMessage([{ text: 'hello' }]);
        chatRecordingService.recordAssistantTurn({
          model: 'gemini-pro',
          message: [{ text: 'partial' }],
        });
        await chatRecordingService.flush();
        const writesBeforeCheckpoint = vi.mocked(mockLease.appendJsonLine).mock
          .calls.length;

        await expect(
          chatRecordingService.recordBranchCheckpointTransaction({
            cursor: chatRecordingService.getBranchCheckpointCursor(),
            stopReason,
          }),
        ).resolves.toBeUndefined();
        expect(vi.mocked(mockLease.appendJsonLine)).toHaveBeenCalledTimes(
          writesBeforeCheckpoint,
        );
      },
    );

    it('settles buffered appends without stalling when the checkpoint write fails', async () => {
      const writeError = new Error('disk full');
      const cursor = chatRecordingService.getBranchCheckpointCursor();
      chatRecordingService.recordUserMessage([{ text: 'hello' }]);
      chatRecordingService.recordAssistantTurn({
        model: 'gemini-pro',
        message: [{ text: 'hi' }],
      });

      // Fail only the checkpoint append; the turn's records still write.
      vi.mocked(mockLease.appendJsonLine).mockImplementation(
        async (record: unknown) => {
          if ((record as ChatRecord).subtype === 'branch_checkpoint') {
            throw writeError;
          }
          return jsonl.writeLine('/test/session.jsonl', record);
        },
      );

      const checkpoint = chatRecordingService.recordBranchCheckpointTransaction(
        {
          cursor,
          stopReason: 'end_turn',
        },
      );
      // Buffered behind the topology fence while validation is in flight:
      // one strict append and one fire-and-forget append.
      const title = chatRecordingService.recordCustomTitle('Title', 'manual');
      chatRecordingService.recordUserMessage([{ text: 'next turn' }]);

      await expect(checkpoint).rejects.toBe(writeError);
      // The buffered strict append settles (rejected with the write
      // failure, surfaced as `false`) instead of hanging on the fence.
      await expect(title).resolves.toBe(false);

      const records = vi
        .mocked(mockLease.appendJsonLine)
        .mock.calls.map((call) => call[0] as ChatRecord);
      const checkpointRecord = records.find(
        (record) => record.subtype === 'branch_checkpoint',
      );
      expect(checkpointRecord).toBeDefined();
      // Nothing was appended after the failed checkpoint: the buffered
      // records were dropped, so no child references the failed
      // checkpoint and the recorder is not wedged behind the fence.
      expect(records.at(-1)).toBe(checkpointRecord);
      expect(
        records.some((record) => record.parentUuid === checkpointRecord?.uuid),
      ).toBe(false);

      // The fence is released: a fresh transaction attempt fails with the
      // write failure, not with 'topology transaction already active'.
      await expect(
        chatRecordingService.recordBranchCheckpointTransaction({
          cursor: chatRecordingService.getBranchCheckpointCursor(),
          stopReason: 'end_turn',
        }),
      ).rejects.toBe(writeError);
    });

    it('rejects a concurrent recordBranchCheckpointTransaction', async () => {
      const cursor = chatRecordingService.getBranchCheckpointCursor();
      chatRecordingService.recordUserMessage([{ text: 'hello' }]);
      chatRecordingService.recordAssistantTurn({
        model: 'gemini-pro',
        message: [{ text: 'hi' }],
      });

      const first = chatRecordingService.recordBranchCheckpointTransaction({
        cursor,
        stopReason: 'end_turn',
      });

      await expect(
        chatRecordingService.recordBranchCheckpointTransaction({
          cursor,
          stopReason: 'end_turn',
        }),
      ).rejects.toThrow('Transcript topology transaction already active');

      await first;
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
          tokensUsed: 0,
          createdAt: 100,
          updatedAt: 100,
        },
      },
    };

    it('strictly persists the caller-owned state UUID', async () => {
      const record = await chatRecordingService.recordGoalState(
        'goal-record',
        goalPayload,
      );

      expect(record).toMatchObject({
        uuid: 'goal-record',
        subtype: 'goal_state',
        provenance: 'goal_control',
        systemPayload: {
          snapshot: {
            activity: 'idle',
            goal: { evidenceCursor: { recordId: 'goal-record' } },
          },
        },
      });
      expect(chatRecordingService.getTranscriptCursor()).toEqual({
        recordId: 'goal-record',
      });
    });

    it('restores the persisted cursor when a queued append fails', async () => {
      chatRecordingService.recordUserMessage([{ text: 'persisted baseline' }]);
      await chatRecordingService.flush();
      const persistedCursor = chatRecordingService.getTranscriptCursor();

      let rejectStrict!: (error: Error) => void;
      vi.mocked(jsonl.writeLine).mockImplementationOnce(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectStrict = reject;
          }),
      );

      const strict = chatRecordingService.recordGoalState(
        'goal-record',
        goalPayload,
      );
      chatRecordingService.recordUserMessage([
        { text: 'queued after strict record' },
      ]);
      await Promise.resolve();
      rejectStrict(new Error('disk full'));

      await expect(strict).rejects.toThrow('disk full');
      await expect(chatRecordingService.flush()).rejects.toThrow('disk full');
      expect(chatRecordingService.getTranscriptCursor()).toEqual(
        persistedCursor,
      );
    });

    it('records Goal-owned model traffic without aliasing permits', async () => {
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
      expect(records.map((record) => record.provenance)).toEqual([
        'goal_runtime',
        'assistant_output',
        'tool_result',
      ]);
      expect(records.map((record) => record.goalContext)).toEqual([
        { goalId: 'goal-1', revision: 3, turnId: 'runtime-turn' },
        { goalId: 'goal-1', revision: 3, turnId: 'assistant-turn' },
        { goalId: 'goal-1', revision: 3, turnId: 'tool-turn' },
      ]);
    });

    it('overrides tool result provenance to goal_runtime when requested', async () => {
      const permit: GoalTurnPermit = {
        goalId: 'goal-1',
        revision: 4,
        turnId: 'tool-override-turn',
      };

      chatRecordingService.recordToolResult(
        [{ functionResponse: { name: 'run', response: { ok: true } } }],
        undefined,
        { goalContext: permit, provenance: 'goal_runtime' },
      );
      permit.turnId = 'mutated';
      await chatRecordingService.flush();

      const record = vi.mocked(jsonl.writeLine).mock.calls[0][1] as ChatRecord;
      expect(record).toMatchObject({
        provenance: 'goal_runtime',
        goalContext: {
          goalId: 'goal-1',
          revision: 4,
          turnId: 'tool-override-turn',
        },
      });
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

      const rewind = vi.mocked(jsonl.writeLine).mock.calls[3][1] as ChatRecord;
      expect(rewind).toMatchObject({
        subtype: 'rewind',
        parentUuid: null,
      });
    });
  });

  describe('recordNotificationStrict', () => {
    it('resolves only after the notification is durably appended', async () => {
      const pending = chatRecordingService.recordNotificationStrict(
        [{ text: '<task-notification />' }],
        'Worker completed.',
        {
          taskId: 'worker-1',
          status: 'completed',
          kind: 'agent',
        },
      );

      await expect(pending).resolves.toBeUndefined();
      const record = vi.mocked(jsonl.writeLine).mock.calls[0][1] as ChatRecord;
      expect(record).toMatchObject({
        type: 'user',
        subtype: 'notification',
        systemPayload: {
          displayText: 'Worker completed.',
          backgroundTask: {
            taskId: 'worker-1',
            status: 'completed',
            kind: 'agent',
          },
        },
      });
    });

    it('rejects instead of acknowledging an inactive recorder', async () => {
      const inactive = new ChatRecordingService(mockConfig);

      await expect(
        inactive.recordNotificationStrict(
          [{ text: '<task-notification />' }],
          'Worker completed.',
          {
            taskId: 'worker-1',
            status: 'completed',
            kind: 'agent',
          },
        ),
      ).rejects.toMatchObject({ name: 'SessionWriterUnavailableError' });
      expect(jsonl.writeLine).not.toHaveBeenCalled();
    });

    it('restores session model bindings for duplicate suppression', async () => {
      const service = new ChatRecordingService(mockConfig, undefined, false, {
        lastCompletedUuid: 'projected-leaf',
        turnParentUuids: [null],
        sessionModel: {
          modelId: 'qwen3-coder-plus',
          authType: 'openai',
        },
      });
      vi.mocked(jsonl.writeLine).mockClear();
      await expect(
        service.recordSessionModel({
          modelId: 'qwen3-coder-plus',
          authType: 'openai',
        }),
      ).resolves.toBe(true);
      expect(jsonl.writeLine).not.toHaveBeenCalled();
    });

    it('restores session model bindings from a full-record replay', async () => {
      vi.mocked(mockConfig.getResumedSessionData).mockReturnValue({
        conversation: {
          messages: [
            {
              uuid: 'model-1',
              parentUuid: null,
              sessionId: 'test-session-id',
              timestamp: '2026-06-27T00:00:00.000Z',
              type: 'system',
              subtype: 'session_model',
              cwd: '/test/project/root',
              version: '1.0.0',
              systemPayload: {
                modelId: 'qwen3-coder-plus',
                authType: 'openai',
              },
            },
          ],
        },
        lastCompletedUuid: 'model-1',
      } as unknown as ReturnType<Config['getResumedSessionData']>);
      const service = new ChatRecordingService(mockConfig, undefined, false);
      vi.mocked(jsonl.writeLine).mockClear();
      await expect(
        service.recordSessionModel({
          modelId: 'qwen3-coder-plus',
          authType: 'openai',
        }),
      ).resolves.toBe(true);
      expect(jsonl.writeLine).not.toHaveBeenCalled();
    });

    it('skips a non-string session_model payload during full-record replay', async () => {
      vi.mocked(mockConfig.getResumedSessionData).mockReturnValue({
        conversation: {
          messages: [
            {
              uuid: 'model-1',
              parentUuid: null,
              sessionId: 'test-session-id',
              timestamp: '2026-06-27T00:00:00.000Z',
              type: 'system',
              subtype: 'session_model',
              cwd: '/test/project/root',
              version: '1.0.0',
              systemPayload: {
                modelId: 42,
                authType: 'openai',
              },
            },
          ],
        },
        lastCompletedUuid: 'model-1',
      } as unknown as ReturnType<Config['getResumedSessionData']>);
      expect(
        () => new ChatRecordingService(mockConfig, undefined, false),
      ).not.toThrow();
      const service = new ChatRecordingService(mockConfig, undefined, false);
      vi.mocked(jsonl.writeLine).mockClear();
      await expect(
        service.recordSessionModel({
          modelId: 'qwen3-coder-plus',
          authType: 'openai',
        }),
      ).resolves.toBe(true);
      expect(jsonl.writeLine).toHaveBeenCalledOnce();
    });
  });

  describe('rewindRecording', () => {
    it('drops display projections from rewound user turns', async () => {
      chatRecordingService.recordUserMessage(
        [{ text: 'hidden A' }],
        undefined,
        {
          displayText: 'A',
          hookContext: '',
        },
      );
      chatRecordingService.recordUserMessage(
        [{ text: 'hidden B' }],
        undefined,
        {
          displayText: 'B',
          hookContext: '',
        },
      );

      chatRecordingService.rewindRecording(1, { truncatedCount: 1 });
      chatRecordingService.recordUserMessage(
        [{ text: 'hidden C' }],
        undefined,
        {
          displayText: 'C',
          hookContext: '',
        },
      );

      expect(chatRecordingService.getUserDisplayTextsForTitle()).toEqual([
        'A',
        'C',
      ]);
      await chatRecordingService.flush();
      vi.mocked(jsonl.writeLine).mockClear();
    });

    it('compensates the rewind splice for the display-text cap window', async () => {
      // 25 turns, but the projection buffer retains only the last 20, so the
      // rewind splice must offset by the 5 turns that fell out of the window.
      for (let index = 0; index < 25; index += 1) {
        chatRecordingService.recordUserMessage(
          [{ text: `hidden ${index}` }],
          undefined,
          {
            displayText: `visible ${index}`,
            hookContext: '',
          },
        );
      }
      expect(chatRecordingService.getUserDisplayTextsForTitle()).toHaveLength(
        20,
      );

      // Rewind to turn 22 keeps turns 0..21; the retained window covers turns
      // 5..24, so projections for turns 5..21 (entries 0..16) must survive.
      chatRecordingService.rewindRecording(22, { truncatedCount: 3 });

      expect(chatRecordingService.getUserDisplayTextsForTitle()).toEqual(
        Array.from({ length: 17 }, (_, index) => `visible ${index + 5}`),
      );
      await chatRecordingService.flush();
      vi.mocked(jsonl.writeLine).mockClear();
    });

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

    it('does not treat a resumed Goal runtime continuation as a rewind boundary', async () => {
      chatRecordingService.rebuildTurnBoundaries([
        {
          uuid: 'user-1',
          parentUuid: null,
          sessionId: 'test-session-id',
          timestamp: '2026-06-27T00:00:00.000Z',
          type: 'user',
          promptId: 'prompt-1',
          cwd: '/test/project/root',
          version: '1.0.0',
          message: { role: 'user', parts: [{ text: 'first turn' }] },
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
        {
          uuid: 'goal-runtime-1',
          parentUuid: 'assistant-1',
          sessionId: 'test-session-id',
          timestamp: '2026-06-27T00:00:02.000Z',
          type: 'user',
          subtype: 'goal_runtime',
          provenance: 'goal_runtime',
          cwd: '/test/project/root',
          version: '1.0.0',
          message: { role: 'user', parts: [{ text: 'Continue working.' }] },
        },
        {
          uuid: 'assistant-2',
          parentUuid: 'goal-runtime-1',
          sessionId: 'test-session-id',
          timestamp: '2026-06-27T00:00:03.000Z',
          type: 'assistant',
          cwd: '/test/project/root',
          version: '1.0.0',
          message: { role: 'model', parts: [{ text: 'still working' }] },
          model: 'gemini-pro',
        },
        {
          uuid: 'user-2',
          parentUuid: 'assistant-2',
          sessionId: 'test-session-id',
          timestamp: '2026-06-27T00:00:04.000Z',
          type: 'user',
          promptId: 'prompt-2',
          cwd: '/test/project/root',
          version: '1.0.0',
          message: { role: 'user', parts: [{ text: 'second turn' }] },
        },
      ]);

      // The Goal runtime continuation is not a turn boundary, so turn index 1
      // is the second REAL user turn (user-2), re-rooting at assistant-2. Were
      // the continuation counted, index 1 would re-root at assistant-1.
      expect(chatRecordingService.getRewindableTurnPromptIds()).toEqual([
        'prompt-1',
        'prompt-2',
      ]);
      chatRecordingService.rewindRecording(1, { truncatedCount: 3 });
      expect(chatRecordingService.getRewindableTurnPromptIds()).toEqual([
        'prompt-1',
      ]);
      await chatRecordingService.flush();

      const records = vi
        .mocked(jsonl.writeLine)
        .mock.calls.map((call) => call[1] as ChatRecord);
      const rewind = records.find((record) => record.subtype === 'rewind');
      expect(rewind?.parentUuid).toBe('assistant-2');
    });

    it('restores the active recording branch after a failed rewind consumer', async () => {
      chatRecordingService.rebuildTurnBoundaries([
        {
          uuid: 'user-1',
          parentUuid: null,
          sessionId: 'test-session-id',
          timestamp: '2026-06-27T00:00:00.000Z',
          type: 'user',
          promptId: 'prompt-1',
          cwd: '/test/project/root',
          version: '1.0.0',
          message: { role: 'user', parts: [{ text: 'first turn' }] },
        },
        {
          uuid: 'assistant-1',
          parentUuid: 'user-1',
          sessionId: 'test-session-id',
          timestamp: '2026-06-27T00:00:01.000Z',
          type: 'assistant',
          cwd: '/test/project/root',
          version: '1.0.0',
          message: { role: 'model', parts: [{ text: 'first reply' }] },
          model: 'gemini-pro',
        },
        {
          uuid: 'user-2',
          parentUuid: 'assistant-1',
          sessionId: 'test-session-id',
          timestamp: '2026-06-27T00:00:02.000Z',
          type: 'user',
          promptId: 'prompt-2',
          cwd: '/test/project/root',
          version: '1.0.0',
          message: { role: 'user', parts: [{ text: 'second turn' }] },
        },
        {
          uuid: 'assistant-2',
          parentUuid: 'user-2',
          sessionId: 'test-session-id',
          timestamp: '2026-06-27T00:00:03.000Z',
          type: 'assistant',
          cwd: '/test/project/root',
          version: '1.0.0',
          message: { role: 'model', parts: [{ text: 'second reply' }] },
          model: 'gemini-pro',
        },
      ]);
      const checkpoint = chatRecordingService.captureRewindCheckpoint();

      chatRecordingService.rewindRecording(1, { truncatedCount: 2 });
      chatRecordingService.restoreRewindCheckpoint(checkpoint);
      chatRecordingService.recordUserMessage(
        [{ text: 'replacement turn' }],
        undefined,
        undefined,
        'prompt-3',
      );

      expect(chatRecordingService.getRewindableTurnPromptIds()).toEqual([
        'prompt-1',
        'prompt-2',
        'prompt-3',
      ]);
      await chatRecordingService.flush();
      const records = vi
        .mocked(jsonl.writeLine)
        .mock.calls.map((call) => call[1] as ChatRecord);
      const rollback = records.filter(
        (record) => record.subtype === 'rewind',
      )[1];
      expect(rollback?.parentUuid).toBe('assistant-2');
      expect(records.at(-1)?.parentUuid).toBe(rollback?.uuid);
    });

    it('restores a rebuilt persisted tail after a failed append', async () => {
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

  describe('recordTurnResult', () => {
    it('normalizes hostile and oversized error fields without throwing', () => {
      const hostile = Object.create(null, {
        message: { get: () => 'm'.repeat(5_000) },
        code: {
          get: () => 'c'.repeat(500),
        },
      });

      expect(normalizeTurnResultError(hostile)).toEqual({
        message: 'm'.repeat(TURN_RESULT_ERROR_MESSAGE_MAX_CHARS),
        messageTruncated: true,
        code: 'c'.repeat(TURN_RESULT_ERROR_CODE_MAX_CHARS),
        codeTruncated: true,
      });
      expect(
        normalizeTurnResultError(
          Object.create(null, {
            message: {
              get: () => {
                throw new Error('getter exploded');
              },
            },
            toString: {
              value: () => {
                throw new Error('conversion exploded');
              },
            },
          }),
        ),
      ).toEqual({ message: 'Unknown error' });
    });

    it('preserves the RPC code of session writer errors', () => {
      expect(normalizeTurnResultError(new SessionWriterLostError())).toEqual(
        expect.objectContaining({ code: '-32021' }),
      );
    });

    it('validates the bounded turn_result transcript contract', () => {
      expect(
        isTurnResultRecordPayload({
          promptId: 'prompt-1',
          state: 'completed',
          endedAt: 2_000,
          resultText: 'bounded prefix',
          resultTruncated: true,
          resultCode: 'RESULT_TEXT_TRUNCATED',
        }),
      ).toBe(true);
      expect(
        isTurnResultRecordPayload({
          promptId: 'prompt-1',
          state: 'completed',
          endedAt: 2_000,
          resultCode: 'RESULT_TEXT_TRUNCATED',
        }),
      ).toBe(false);
    });

    it('caps promptId, stopReason, and originatorClientId in turn_result payloads', () => {
      const oversized = 'x'.repeat(TURN_RESULT_IDENTIFIER_MAX_CHARS + 1);
      expect(
        isTurnResultRecordPayload({
          promptId: oversized,
          state: 'completed',
          endedAt: 2_000,
        }),
      ).toBe(false);
      expect(
        isTurnResultRecordPayload({
          promptId: 'prompt-1',
          state: 'completed',
          endedAt: 2_000,
          stopReason: oversized,
        }),
      ).toBe(false);
      expect(
        isTurnResultRecordPayload({
          promptId: 'prompt-1',
          state: 'completed',
          endedAt: 2_000,
          originatorClientId: oversized,
        }),
      ).toBe(false);
      const bounded = 'y'.repeat(TURN_RESULT_IDENTIFIER_MAX_CHARS);
      expect(
        isTurnResultRecordPayload({
          promptId: bounded,
          state: 'completed',
          endedAt: 2_000,
          stopReason: bounded,
          originatorClientId: bounded,
        }),
      ).toBe(true);
    });

    it('rejects empty error message and code in turn_result payloads', () => {
      expect(
        isTurnResultRecordPayload({
          promptId: 'prompt-1',
          state: 'error',
          endedAt: 2_000,
          error: { message: '' },
        }),
      ).toBe(false);
      expect(
        isTurnResultRecordPayload({
          promptId: 'prompt-1',
          state: 'error',
          endedAt: 2_000,
          error: { message: 'boom', code: '' },
        }),
      ).toBe(false);
      expect(
        isTurnResultRecordPayload({
          promptId: 'prompt-1',
          state: 'error',
          endedAt: 2_000,
          error: { message: 'boom' },
        }),
      ).toBe(true);
    });

    it('records a settled turn outcome as a system payload', async () => {
      const payload: TurnResultRecordPayload = {
        promptId: 'prompt-1',
        state: 'completed',
        stopReason: 'end_turn',
        startedAt: 1000,
        endedAt: 2000,
        promptText: 'hello',
        resultText: 'world',
        originatorClientId: 'client-1',
      };

      chatRecordingService.recordTurnResult(payload);
      await chatRecordingService.flush();

      expect(jsonl.writeLine).toHaveBeenCalledTimes(1);
      const record = vi.mocked(jsonl.writeLine).mock.calls[0][1] as ChatRecord;
      expect(record.type).toBe('system');
      expect(record.subtype).toBe('turn_result');
      expect(record.systemPayload).toEqual(payload);
    });

    it('refuses to append payloads the bounded contract rejects', async () => {
      chatRecordingService.recordTurnResult({
        promptId: 'prompt-1',
        state: 'error',
        endedAt: 2_000,
      });
      chatRecordingService.recordTurnResult({
        promptId: 'prompt-2',
        state: 'completed',
        endedAt: 2_000,
        error: { message: 'stray' },
      });
      await chatRecordingService.flush();

      const records = vi
        .mocked(jsonl.writeLine)
        .mock.calls.map((call) => call[1] as ChatRecord);
      expect(
        records.filter((record) => record.subtype === 'turn_result'),
      ).toHaveLength(0);
    });

    it('keeps turn_result records on the active transcript chain', async () => {
      chatRecordingService.recordUserMessage([{ text: 'before result' }]);
      chatRecordingService.recordTurnResult({
        promptId: 'prompt-1',
        state: 'completed',
        endedAt: 2_000,
      });
      await chatRecordingService.recordSessionArtifactEvent({
        v: 2,
        sessionId: 'test-session-id',
        sequence: 1,
        recordedAt: '2026-08-14T00:00:00.000Z',
        changes: [],
      });
      chatRecordingService.recordUserMessage([{ text: 'after result' }]);
      await chatRecordingService.flush();

      const records = vi
        .mocked(jsonl.writeLine)
        .mock.calls.map((call) => call[1] as ChatRecord);
      const before = records[0]!;
      const turnResult = records[1]!;
      const artifact = records[2]!;
      const after = records[3]!;
      expect(turnResult.subtype).toBe('turn_result');
      expect(turnResult.parentUuid).toBe(before.uuid);
      expect(artifact.parentUuid).toBe(turnResult.uuid);
      expect(after.parentUuid).toBe(turnResult.uuid);
    });

    it('is best-effort when recording is inactive', () => {
      const inactive = new ChatRecordingService(mockConfig);
      expect(() =>
        inactive.recordTurnResult({
          promptId: 'prompt-1',
          state: 'cancelled',
          startedAt: 1000,
          endedAt: 1500,
        }),
      ).not.toThrow();
      expect(jsonl.writeLine).not.toHaveBeenCalled();
    });

    describe('session identity pinning', () => {
      it('keeps late turn_result writes on the pinned pre-rotation session', async () => {
        const outgoing = new ChatRecordingService(mockConfig, undefined, false);
        outgoing.pinSessionIdentity('test-session-id');
        vi.mocked(mockConfig.getSessionId).mockReturnValue(
          'rotated-session-id',
        );

        outgoing.recordTurnResult({
          promptId: 'prompt-1',
          state: 'completed',
          endedAt: 2_000,
        });
        await outgoing.flush();

        expect(jsonl.writeLine).toHaveBeenCalledTimes(1);
        const [filePath, record] = vi.mocked(jsonl.writeLine).mock.calls[0] as [
          string,
          ChatRecord,
        ];
        expect(filePath).toContain('test-session-id.jsonl');
        expect(record.sessionId).toBe('test-session-id');
      });

      it('resolves the shared Config session id at write time when not pinned', async () => {
        const outgoing = new ChatRecordingService(mockConfig, undefined, false);
        vi.mocked(mockConfig.getSessionId).mockReturnValue(
          'rotated-session-id',
        );

        outgoing.recordTurnResult({
          promptId: 'prompt-1',
          state: 'completed',
          endedAt: 2_000,
        });
        await outgoing.flush();

        const [filePath, record] = vi.mocked(jsonl.writeLine).mock.calls[0] as [
          string,
          ChatRecord,
        ];
        expect(filePath).toContain('rotated-session-id.jsonl');
        expect(record.sessionId).toBe('rotated-session-id');
      });

      it('never overrides a lease binding that owns the session identity', async () => {
        chatRecordingService.pinSessionIdentity('pinned-session-id');
        vi.mocked(mockConfig.getSessionId).mockReturnValue(
          'rotated-session-id',
        );

        chatRecordingService.recordTurnResult({
          promptId: 'prompt-1',
          state: 'completed',
          endedAt: 2_000,
        });
        await chatRecordingService.flush();

        const record = vi
          .mocked(jsonl.writeLine)
          .mock.calls.at(-1)![1] as ChatRecord;
        expect(record.sessionId).toBe('test-session-id');
      });
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

  describe('recordRealtimeConversation', () => {
    it('durably records direct Realtime dialogue as non-model history', async () => {
      await chatRecordingService.recordRealtimeConversation(
        [
          { role: 'user', text: '你好' },
          { role: 'assistant', text: '你好！' },
        ],
        'qwen3.5-omni-plus-realtime',
      );

      const records = vi
        .mocked(jsonl.writeLine)
        .mock.calls.map((call) => call[1] as ChatRecord);
      expect(records).toHaveLength(2);
      expect(records[0]).toMatchObject({
        type: 'user',
        subtype: 'realtime_message',
        provenance: 'real_user',
        message: { role: 'user', parts: [{ text: '你好' }] },
      });
      expect(records[1]).toMatchObject({
        type: 'assistant',
        subtype: 'realtime_message',
        provenance: 'assistant_output',
        model: 'qwen3.5-omni-plus-realtime',
        message: { role: 'model', parts: [{ text: '你好！' }] },
      });
      expect(records[1]?.parentUuid).toBe(records[0]?.uuid);
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

    it('preserves replayable artifacts without diagnostic metadata', async () => {
      const toolResultParts: Part[] = [
        {
          functionResponse: {
            id: 'call-1',
            name: 'shell',
            response: { output: 'result' },
          },
        },
      ];

      const artifacts = [
        {
          kind: 'link' as const,
          title: 'Replay artifact',
          url: 'https://example.com/replayed',
        },
      ];
      chatRecordingService.recordToolResult(toolResultParts, {
        callId: 'call-1',
        status: 'success',
        persistedOutputFiles: ['/private/tool-result.txt'],
        artifacts,
        boundaryArtifact: { state: 'reusable', kinds: ['link'] },
      });
      await chatRecordingService.flush();

      const record = vi.mocked(jsonl.writeLine).mock.calls[0][1] as ChatRecord;
      expect(record.toolCallResult).not.toHaveProperty('persistedOutputFiles');
      expect(record.toolCallResult).not.toHaveProperty('boundaryArtifact');
      expect(
        JSON.parse(JSON.stringify(record)).toolCallResult.artifacts,
      ).toEqual(artifacts);
      expect(JSON.stringify(record)).not.toContain('/private/tool-result.txt');
      expect(boundaryObserveMock).toHaveBeenCalledTimes(2);
      for (const [observation] of boundaryObserveMock.mock.calls) {
        expect(observation.artifacts).toEqual([
          { state: 'reusable', kinds: ['file', 'link'] },
        ]);
      }
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
      const inputObservation = boundaryObserveMock.mock.calls.find(
        ([observation]) => observation.stage === 'recorder_input',
      )?.[0];
      expect(
        typeof inputObservation?.mutated === 'function'
          ? inputObservation.mutated()
          : inputObservation?.mutated,
      ).toBe(false);
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
      const inputObservation = boundaryObserveMock.mock.calls.find(
        ([observation]) => observation.stage === 'recorder_input',
      )?.[0];
      expect(
        typeof inputObservation?.mutated === 'function'
          ? inputObservation.mutated()
          : inputObservation?.mutated,
      ).toBe(true);
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
      const inputObservation = boundaryObserveMock.mock.calls.find(
        ([observation]) => observation.stage === 'recorder_input',
      )?.[0];
      expect(
        typeof inputObservation?.mutated === 'function'
          ? inputObservation.mutated()
          : inputObservation?.mutated,
      ).toBe(true);
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

  describe('recordChatCompression', () => {
    it('preserves prompt identities through persistence and resume', async () => {
      const compressedHistory = [
        { role: 'user' as const, parts: [{ text: 'question' }] },
        { role: 'model' as const, parts: [{ text: 'answer' }] },
      ];
      markApiHistoryPrompt(compressedHistory[0]!, 'prompt-1');

      chatRecordingService.recordChatCompression({
        info: {
          originalTokenCount: 100,
          newTokenCount: 50,
          compressionStatus: CompressionStatus.COMPRESSED,
        },
        compressedHistory,
      });
      await chatRecordingService.flush();

      const record = vi.mocked(jsonl.writeLine).mock.calls[0][1] as ChatRecord;
      const persistedRecord = JSON.parse(JSON.stringify(record)) as ChatRecord;
      const restored = buildApiHistoryFromConversation({
        messages: [persistedRecord],
      });

      expect(restored.map(getApiHistoryPromptId)).toEqual([
        'prompt-1',
        undefined,
      ]);
      expect(JSON.stringify(restored)).not.toContain('prompt-1');
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

  describe('recordSessionModel', () => {
    it('appends a session_model record and skips identical payloads', async () => {
      vi.mocked(jsonl.writeLine).mockClear();
      await expect(
        chatRecordingService.recordSessionModel({
          modelId: 'qwen3-coder-plus',
          authType: 'openai',
        }),
      ).resolves.toBe(true);
      expect(jsonl.writeLine).toHaveBeenCalledOnce();
      const record = vi.mocked(jsonl.writeLine).mock.calls[0][1] as ChatRecord;
      expect(record).toMatchObject({
        type: 'system',
        subtype: 'session_model',
        systemPayload: {
          modelId: 'qwen3-coder-plus',
          authType: 'openai',
        },
      });

      vi.mocked(jsonl.writeLine).mockClear();
      await expect(
        chatRecordingService.recordSessionModel({
          modelId: 'qwen3-coder-plus',
          authType: 'openai',
        }),
      ).resolves.toBe(true);
      expect(jsonl.writeLine).not.toHaveBeenCalled();
    });

    it('writes a new record when the model changes', async () => {
      await chatRecordingService.recordSessionModel({
        modelId: 'qwen3-coder-plus',
        authType: 'openai',
      });
      vi.mocked(jsonl.writeLine).mockClear();
      await expect(
        chatRecordingService.recordSessionModel({
          modelId: 'qwen3-coder-flash',
          authType: 'openai',
        }),
      ).resolves.toBe(true);
      expect(jsonl.writeLine).toHaveBeenCalledOnce();
    });

    it('canonicalizes a runtime-prefixed modelId before writing', async () => {
      vi.mocked(jsonl.writeLine).mockClear();
      await expect(
        chatRecordingService.recordSessionModel({
          modelId: '$runtime|openai|custom-runtime',
          authType: 'openai',
          isRuntime: true,
        }),
      ).resolves.toBe(true);
      const record = vi.mocked(jsonl.writeLine).mock.calls[0][1] as ChatRecord;
      expect(record.systemPayload).toEqual({
        modelId: 'custom-runtime',
        authType: 'openai',
        isRuntime: true,
      });

      vi.mocked(jsonl.writeLine).mockClear();
      await expect(
        chatRecordingService.recordSessionModel({
          modelId: '$runtime|openai|custom-runtime',
          authType: 'openai',
          isRuntime: true,
        }),
      ).resolves.toBe(true);
      expect(jsonl.writeLine).not.toHaveBeenCalled();
    });

    it('re-anchors the live session model onto the rewind branch', async () => {
      chatRecordingService.recordUserMessage([{ text: 'first' }]);
      await chatRecordingService.recordSessionModel({
        modelId: 'qwen3-coder-plus',
        authType: 'openai',
      });
      chatRecordingService.recordUserMessage([{ text: 'second' }]);
      await chatRecordingService.recordSessionModel({
        modelId: 'qwen3-coder-flash',
        authType: 'openai',
      });
      vi.mocked(jsonl.writeLine).mockClear();

      chatRecordingService.rewindRecording(1, { truncatedCount: 1 });
      await chatRecordingService.flush();

      const written = vi
        .mocked(jsonl.writeLine)
        .mock.calls.map((call) => call[1] as ChatRecord);
      expect(written.map((record) => record.subtype)).toEqual([
        'rewind',
        'session_model',
      ]);
      expect(written[1]?.parentUuid).toBe(written[0]?.uuid);
      expect(written[1]?.systemPayload).toEqual({
        modelId: 'qwen3-coder-flash',
        authType: 'openai',
      });

      vi.mocked(jsonl.writeLine).mockClear();
      await expect(
        chatRecordingService.recordSessionModel({
          modelId: 'qwen3-coder-flash',
          authType: 'openai',
        }),
      ).resolves.toBe(true);
      expect(jsonl.writeLine).not.toHaveBeenCalled();
    });

    it('re-anchors the live session model after a checkpoint restore', async () => {
      chatRecordingService.recordUserMessage([{ text: 'first' }]);
      await chatRecordingService.recordSessionModel({
        modelId: 'qwen3-coder-plus',
        authType: 'openai',
      });
      chatRecordingService.recordUserMessage([{ text: 'second' }]);
      const checkpoint = chatRecordingService.captureRewindCheckpoint();

      // A model switch between the rewind and the restore lands on the
      // post-rewind tail the checkpoint is about to roll back. The restore
      // must re-append the live binding — the abandoned branch keeps the
      // stale M1 record, and an in-process re-set is deduped away
      // (sessionModelPayloadsEqual) so it never heals the transcript.
      await chatRecordingService.recordSessionModel({
        modelId: 'qwen3-coder-flash',
        authType: 'openai',
      });
      vi.mocked(jsonl.writeLine).mockClear();

      chatRecordingService.restoreRewindCheckpoint(checkpoint);
      await chatRecordingService.flush();

      const written = vi
        .mocked(jsonl.writeLine)
        .mock.calls.map((call) => call[1] as ChatRecord);
      expect(written.map((record) => record.subtype)).toEqual([
        'rewind',
        'session_model',
      ]);
      expect(written[1]?.parentUuid).toBe(written[0]?.uuid);
      expect(written[1]?.systemPayload).toEqual({
        modelId: 'qwen3-coder-flash',
        authType: 'openai',
      });

      vi.mocked(jsonl.writeLine).mockClear();
      await expect(
        chatRecordingService.recordSessionModel({
          modelId: 'qwen3-coder-flash',
          authType: 'openai',
        }),
      ).resolves.toBe(true);
      expect(jsonl.writeLine).not.toHaveBeenCalled();
    });

    it('writes a second record when only the isRuntime flag differs', async () => {
      await chatRecordingService.recordSessionModel({
        modelId: 'qwen3-coder-plus',
        authType: 'openai',
      });
      vi.mocked(jsonl.writeLine).mockClear();
      await expect(
        chatRecordingService.recordSessionModel({
          modelId: 'qwen3-coder-plus',
          authType: 'openai',
          isRuntime: true,
        }),
      ).resolves.toBe(true);
      expect(jsonl.writeLine).toHaveBeenCalledOnce();
      const record = vi.mocked(jsonl.writeLine).mock.calls[0][1] as ChatRecord;
      expect(record.systemPayload).toEqual({
        modelId: 'qwen3-coder-plus',
        authType: 'openai',
        isRuntime: true,
      });
    });

    it('writes a new record when only the baseUrl differs', async () => {
      await chatRecordingService.recordSessionModel({
        modelId: 'qwen3-coder-plus',
        authType: 'openai',
        baseUrl: 'https://a.example/v1',
      });
      vi.mocked(jsonl.writeLine).mockClear();
      await expect(
        chatRecordingService.recordSessionModel({
          modelId: 'qwen3-coder-plus',
          authType: 'openai',
          baseUrl: 'https://b.example/v1',
        }),
      ).resolves.toBe(true);
      expect(jsonl.writeLine).toHaveBeenCalledOnce();
    });

    it('skips a payload identical on the isRuntime and baseUrl dimensions', async () => {
      await chatRecordingService.recordSessionModel({
        modelId: 'qwen3-coder-plus',
        authType: 'openai',
        baseUrl: 'https://a.example/v1',
        isRuntime: true,
      });
      vi.mocked(jsonl.writeLine).mockClear();
      await expect(
        chatRecordingService.recordSessionModel({
          modelId: 'qwen3-coder-plus',
          authType: 'openai',
          baseUrl: 'https://a.example/v1',
          isRuntime: true,
        }),
      ).resolves.toBe(true);
      expect(jsonl.writeLine).not.toHaveBeenCalled();
    });

    it('re-anchors the pending new binding when a rewind lands mid-write', async () => {
      chatRecordingService.recordUserMessage([{ text: 'first' }]);
      await chatRecordingService.recordSessionModel({
        modelId: 'qwen3-coder-plus',
        authType: 'openai',
      });
      chatRecordingService.recordUserMessage([{ text: 'second' }]);

      // Hold the next session_model write at the IO layer so the rewind
      // lands inside the pending-write window.
      vi.mocked(jsonl.writeLine).mockClear();
      let releaseWrite: (() => void) | undefined;
      vi.mocked(jsonl.writeLine).mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            releaseWrite = resolve;
          }),
      );
      const pendingSwitch = chatRecordingService.recordSessionModel({
        modelId: 'qwen3-coder-flash',
        authType: 'openai',
      });
      await vi.waitFor(() => {
        expect(vi.mocked(jsonl.writeLine).mock.calls.length).toBe(1);
      });

      chatRecordingService.rewindRecording(1, { truncatedCount: 1 });
      releaseWrite?.();
      await pendingSwitch;
      await chatRecordingService.flush();

      const written = vi
        .mocked(jsonl.writeLine)
        .mock.calls.map((call) => call[1] as ChatRecord);
      const rewindIndex = written.findIndex(
        (record) => record.subtype === 'rewind',
      );
      expect(rewindIndex).toBeGreaterThanOrEqual(0);
      const reAppended = written[rewindIndex + 1];
      expect(reAppended?.subtype).toBe('session_model');
      expect(reAppended?.parentUuid).toBe(written[rewindIndex]?.uuid);
      expect(reAppended?.systemPayload).toEqual({
        modelId: 'qwen3-coder-flash',
        authType: 'openai',
      });
    });
  });

  describe('legacy recorder', () => {
    it('restores reduced recorder state without the full conversation', async () => {
      const service = new ChatRecordingService(mockConfig, undefined, false, {
        lastCompletedUuid: 'projected-leaf',
        turnParentUuids: [null, 'projected-parent'],
        customTitle: 'Projected title',
        titleSource: 'manual',
        parentSessionId: 'parent-session',
        sourceType: 'channel',
        sourceId: 'channel-main',
      });

      service.recordUserMessage([{ text: 'next' }]);
      await service.flush();

      const record = vi.mocked(jsonl.writeLine).mock.calls[0][1] as ChatRecord;
      expect(record.parentUuid).toBe('projected-leaf');
      expect(service.getCurrentCustomTitle()).toBe('Projected title');
      expect(service.getCurrentTitleSource()).toBe('manual');
      vi.mocked(jsonl.writeLine).mockClear();
      await expect(service.recordParentSession('parent-session')).resolves.toBe(
        true,
      );
      await expect(
        service.recordSessionSource('channel', 'channel-main'),
      ).resolves.toBe(true);
      expect(jsonl.writeLine).not.toHaveBeenCalled();
    });

    it('activates a leased recorder from reduced state', async () => {
      const service = new ChatRecordingService(mockConfig);
      service.activate(mockLease, undefined, undefined, {
        lastCompletedUuid: 'leased-projected-leaf',
        turnParentUuids: [null],
      });

      service.recordUserMessage([{ text: 'next' }]);
      await service.flush();

      const record = vi.mocked(jsonl.writeLine).mock.calls[0][1] as ChatRecord;
      expect(record.parentUuid).toBe('leased-projected-leaf');
    });

    it('records the first checkpoint after activating from reduced state', async () => {
      const service = new ChatRecordingService(mockConfig);
      service.activate(mockLease, undefined, undefined, {
        lastCompletedUuid: 'leased-projected-leaf',
        turnParentUuids: [null],
      });
      const cursor = service.getBranchCheckpointCursor();

      service.recordUserMessage([{ text: 'next' }]);
      service.recordAssistantTurn({
        model: 'gemini-pro',
        message: [{ text: 'continued answer' }],
      });

      await expect(
        service.recordBranchCheckpointTransaction({
          cursor,
          stopReason: 'end_turn',
        }),
      ).resolves.toMatchObject({
        startExclusiveRecordUuid: 'leased-projected-leaf',
      });
    });

    it('uses the effective session writer lease gate by default', async () => {
      mockConfig.getExperimentalZedIntegration = vi.fn().mockReturnValue(true);
      mockConfig.isSessionWriterLeaseEnabled = vi.fn().mockReturnValue(false);
      const service = new ChatRecordingService(mockConfig);

      service.recordUserMessage([{ text: 'legacy' }]);
      await service.flush();

      expect(jsonl.writeLine).toHaveBeenCalledOnce();
    });

    it('retries an identical session_model payload after a synchronous failure', async () => {
      const writeFileSpy = vi.spyOn(fs, 'writeFileSync');
      writeFileSpy.mockImplementationOnce(() => {
        throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
      });
      const service = new ChatRecordingService(mockConfig, undefined, false);

      await expect(
        service.recordSessionModel({
          modelId: 'qwen3-coder-plus',
          authType: 'openai',
        }),
      ).resolves.toBe(false);
      expect(jsonl.writeLine).not.toHaveBeenCalled();

      await expect(
        service.recordSessionModel({
          modelId: 'qwen3-coder-plus',
          authType: 'openai',
        }),
      ).resolves.toBe(true);
      expect(jsonl.writeLine).toHaveBeenCalledOnce();
    });

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

  describe('close', () => {
    it('seals instead of releasing after a successful handoff drain', async () => {
      chatRecordingService.recordUserMessage([{ text: 'durable' }]);

      await expect(
        chatRecordingService.close({ handoff: true }),
      ).resolves.toBeUndefined();
      expect(mockLease.sealForHandoff).toHaveBeenCalledOnce();
      expect(mockLease.release).not.toHaveBeenCalled();
      expect(chatRecordingService.hasWriteOwnership()).toBe(false);
    });

    it('retains ownership when a handoff drain fails', async () => {
      const failure = new SessionTranscriptChangedError();
      vi.mocked(mockLease.appendJsonLine).mockRejectedValueOnce(failure);
      chatRecordingService.recordUserMessage([{ text: 'not durable' }]);

      await expect(chatRecordingService.close({ handoff: true })).rejects.toBe(
        failure,
      );
      expect(mockLease.sealForHandoff).not.toHaveBeenCalled();
      expect(mockLease.release).not.toHaveBeenCalled();
      expect(chatRecordingService.hasWriteOwnership()).toBe(true);
    });

    it('releases the writer lease before reporting a flush failure', async () => {
      const failure = new SessionTranscriptChangedError();
      vi.mocked(mockLease.appendJsonLine).mockRejectedValueOnce(failure);

      chatRecordingService.recordUserMessage([{ text: 'not durable' }]);

      await expect(chatRecordingService.close()).rejects.toBe(failure);
      expect(mockLease.release).toHaveBeenCalledOnce();
      expect(chatRecordingService.hasWriteOwnership()).toBe(false);
    });

    it('cuts off new writes synchronously and closes single-flight', async () => {
      let finishWrite!: () => void;
      vi.mocked(mockLease.appendJsonLine).mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishWrite = resolve;
          }),
      );
      chatRecordingService.recordUserMessage([{ text: 'accepted' }]);

      const first = chatRecordingService.close();
      const second = chatRecordingService.close();
      chatRecordingService.recordUserMessage([{ text: 'too late' }]);
      await Promise.resolve();
      finishWrite();

      await expect(Promise.all([first, second])).resolves.toEqual([
        undefined,
        undefined,
      ]);
      expect(mockLease.appendJsonLine).toHaveBeenCalledTimes(1);
      expect(mockLease.release).toHaveBeenCalledTimes(1);
      expect(chatRecordingService.hasWriteOwnership()).toBe(false);
    });

    it('drains a write barrier admitted before the close cutoff', async () => {
      const operation = vi.fn().mockResolvedValue('snapshot');
      const barrier = chatRecordingService.runWithWriteBarrier(operation);

      const close = chatRecordingService.close();

      await expect(barrier).resolves.toBe('snapshot');
      await expect(close).resolves.toBeUndefined();
      expect(operation).toHaveBeenCalledOnce();
    });

    it('clears ownership after an error that follows the release commit', async () => {
      const cleanupFailure = new SessionWriterUnavailableError();
      Object.defineProperty(mockLease, 'isReleased', {
        configurable: true,
        get: () => true,
      });
      vi.mocked(mockLease.release).mockRejectedValueOnce(cleanupFailure);

      await expect(chatRecordingService.close()).rejects.toBe(cleanupFailure);
      expect(chatRecordingService.hasWriteOwnership()).toBe(false);
    });

    it('retries release durability without reporting stale write ownership', async () => {
      const cleanupFailure = new SessionWriterUnavailableError();
      let released = false;
      let durabilityPending = false;
      Object.defineProperties(mockLease, {
        isReleased: {
          configurable: true,
          get: () => released,
        },
        isReleaseDurabilityPending: {
          configurable: true,
          get: () => durabilityPending,
        },
      });
      vi.mocked(mockLease.release)
        .mockImplementationOnce(async () => {
          released = true;
          durabilityPending = true;
          throw cleanupFailure;
        })
        .mockImplementationOnce(async () => {
          durabilityPending = false;
        });

      await expect(chatRecordingService.close()).rejects.toBe(cleanupFailure);
      expect(chatRecordingService.hasWriteOwnership()).toBe(false);

      await expect(chatRecordingService.close()).resolves.toBeUndefined();
      expect(mockLease.release).toHaveBeenCalledTimes(2);
      expect(chatRecordingService.hasWriteOwnership()).toBe(false);
    });
  });

  // Note: Session management tests (listSessions, loadSession, deleteSession, etc.)
  // have been moved to sessionService.test.ts
  // Session resume integration tests should test via SessionService mock
});

describe('Goal turn token ledger', () => {
  it('bills a Goal turn from the assistant records it produced', () => {
    // The wiring that matters: recordAssistantTurn must feed the ledger. A
    // ledger that is never fed reports every Goal turn as free.
    const service = Object.create(
      ChatRecordingService.prototype,
    ) as ChatRecordingService;
    const appended: unknown[] = [];
    Object.assign(service, {
      createBaseRecord: () => ({ type: 'assistant' }),
      appendRecord: (record: unknown) => appended.push(record),
      maybeTriggerAutoTitle: () => {},
    });
    const goalContext = { goalId: 'goal-1', revision: 1, turnId: 'turn-1' };

    service.recordAssistantTurn({
      model: 'qwen',
      tokens: { totalTokenCount: 900 },
      goalContext,
    });
    service.recordAssistantTurn({
      model: 'qwen',
      tokens: { totalTokenCount: 100 },
      goalContext,
    });
    // A record with no Goal permit belongs to no Goal turn.
    service.recordAssistantTurn({
      model: 'qwen',
      tokens: { totalTokenCount: 5_000 },
    });

    expect(appended).toHaveLength(3);
    expect(service.takeGoalTurnTokens('turn-1')).toBe(1_000);
  });

  function recorderForGoalSpend() {
    const service = Object.create(
      ChatRecordingService.prototype,
    ) as ChatRecordingService;
    return service;
  }

  const permit = (turnId: string) => ({
    goalId: 'goal-1',
    revision: 1,
    turnId,
  });

  it("sums a turn's usage and hands it over once", () => {
    const service = recorderForGoalSpend();
    const accumulate = (
      service as unknown as {
        accumulateGoalTurnTokens: (
          turnId: string,
          usage: { totalTokenCount?: number },
        ) => void;
      }
    ).accumulateGoalTurnTokens.bind(service);

    accumulate(permit('turn-1').turnId, { totalTokenCount: 1_000 });
    accumulate(permit('turn-1').turnId, { totalTokenCount: 250 });

    expect(service.takeGoalTurnTokens('turn-1')).toBe(1_250);
    // Consumed: a turn is billed once.
    expect(service.takeGoalTurnTokens('turn-1')).toBe(0);
  });

  it("does not bill one turn for another turn's usage", () => {
    const service = recorderForGoalSpend();
    const accumulate = (
      service as unknown as {
        accumulateGoalTurnTokens: (
          turnId: string,
          usage: { totalTokenCount?: number },
        ) => void;
      }
    ).accumulateGoalTurnTokens.bind(service);

    accumulate('turn-1', { totalTokenCount: 1_000 });
    // A record stamped with the next turn ends the previous one.
    accumulate('turn-2', { totalTokenCount: 40 });

    expect(service.takeGoalTurnTokens('turn-1')).toBe(0);
    expect(service.takeGoalTurnTokens('turn-2')).toBe(40);
  });

  it('ignores usage with no usable total', () => {
    const service = recorderForGoalSpend();
    const accumulate = (
      service as unknown as {
        accumulateGoalTurnTokens: (
          turnId: string,
          usage: { totalTokenCount?: number },
        ) => void;
      }
    ).accumulateGoalTurnTokens.bind(service);

    accumulate('turn-1', {});
    accumulate('turn-1', { totalTokenCount: Number.NaN });
    accumulate('turn-1', { totalTokenCount: -5 });

    expect(service.takeGoalTurnTokens('turn-1')).toBe(0);
  });
});
