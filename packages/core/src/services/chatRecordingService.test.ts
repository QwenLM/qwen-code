/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import { ApprovalMode } from '../config/approval-mode.js';
import {
  backgroundTurnContext,
  type BackgroundNotificationTurn,
} from '../utils/background-turn-context.js';
import { runWithAgentContext } from '../agents/runtime/agent-context.js';
import {
  ChatRecordingService,
  isTurnResultRecordPayload,
  normalizeTurnResultError,
  TURN_RESULT_ERROR_CODE_MAX_CHARS,
  TURN_RESULT_IDENTIFIER_MAX_CHARS,
  TURN_RESULT_ERROR_MESSAGE_MAX_CHARS,
  type BranchCheckpointCursor,
  type ChatRecord,
  type AtCommandRecordPayload,
  type SessionModelRecordPayload,
  type TurnResultRecordPayload,
} from './chatRecordingService.js';
import { MAX_RETAINED_TOOL_RESULT_DISPLAY_CHARS } from '../utils/toolResultDisplayCompaction.js';
import * as jsonl from '../utils/jsonl-utils.js';
import { computeInitialTurnFromHistory } from './session-turn-state.js';
import type { Content, Part } from '@google/genai';
import type { FileDiff, McpAppResultDisplay } from '../tools/tools.js';
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
import type {
  GoalStateRecordPayloadV2,
  GoalTurnPermit,
} from '../goals/goal-protocol.js';
import {
  shellResultText,
  type ShellResultDisplay,
} from '../utils/shell-result.js';
import type { ToolResultBoundaryObservation } from '../tools/tool-result-boundary-diagnostics.js';
import { fnResponse, userText } from '../test-utils/model-fixtures.js';
import { CompressionStatus } from '../core/turn.js';
import { markApiHistoryPrompt } from './session-api-history.js';

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

type ResumedSpec = [string, 'user' | 'assistant', string, Partial<ChatRecord>?];
// Resumed records without provenance, each parented on the previous one (the
// first on `root`), one second apart; assistants carry a model.
function resumedChain(root: string | null, ...specs: ResumedSpec[]) {
  return specs.map(
    ([uuid, type, text, extra], index): ChatRecord => ({
      uuid,
      parentUuid: index ? specs[index - 1][0] : root,
      sessionId: 'test-session-id',
      timestamp: `2026-06-27T00:00:0${index}.000Z`,
      type,
      ...extra,
      cwd: '/test/project/root',
      version: '1.0.0',
      message: {
        role: type === 'assistant' ? 'model' : 'user',
        parts: [{ text }],
      },
      ...(type === 'assistant' ? { model: 'gemini-pro' } : {}),
    }),
  );
}

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const goalPermit = (
  turnId: string,
  revision = 1,
  goalId = 'goal-1',
): GoalTurnPermit => ({ goalId, revision, turnId });

const modelPayload = (
  modelId = 'qwen3-coder-plus',
  extra?: Partial<SessionModelRecordPayload>,
): SessionModelRecordPayload => ({ modelId, authType: 'openai', ...extra });

const artifactEvent = (recordedAt = '2026-07-04T00:00:00.000Z') => ({
  v: 2 as const,
  sessionId: 'test-session-id',
  sequence: 1,
  recordedAt,
  changes: [],
});

const attributionSnapshot = {
  type: 'attribution-snapshot' as const,
  version: 1,
  surface: 'cli',
  fileStates: {},
  promptCount: 0,
  promptCountAtLastCommit: 0,
};

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
  let svc: ChatRecordingService;
  let mockConfig: Config;
  let mockLease: SessionWriterLease;

  let uuidCounter = 0;

  beforeEach(() => {
    uuidCounter = 0;
    boundaryObserveMock.mockClear();

    const returns = (value: unknown) => vi.fn().mockReturnValue(value);
    mockConfig = {
      getSessionId: returns('test-session-id'),
      getProjectRoot: returns('/test/project/root'),
      getCliVersion: returns('1.0.0'),
      storage: {
        getProjectTempDir: returns('/test/project/root/.gemini/tmp/hash'),
        getProjectDir: returns(
          '/test/project/root/.gemini/projects/test-project',
        ),
      },
      getModel: returns('gemini-pro'),
      getFastModel: returns(undefined),
      isInteractive: returns(false),
      getDebugMode: returns(false),
      getToolRegistry: returns({
        getTool: returns({
          displayName: 'Test Tool',
          description: 'A test tool',
          isOutputMarkdown: false,
        }),
      }),
      getResumedSessionData: returns(undefined),
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
    vi.mocked(execFileSync).mockReturnValue('main\n');
    vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined);
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => undefined);
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);

    // writeLine is async; a settled Promise lets the service's writeChain
    // advance when flushed.
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
    svc = activateRecording(new ChatRecordingService(mockConfig));
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

  type UserArgs = Parameters<ChatRecordingService['recordUserMessage']>;
  type RestOf<T> = T extends [unknown, ...infer R] ? R : never;

  const writes = () =>
    vi.mocked(jsonl.writeLine).mock.calls.map((call) => call[1] as ChatRecord);
  const written = (index = 0) =>
    vi.mocked(jsonl.writeLine).mock.calls.at(index)![1] as ChatRecord;
  const subtypes = (records: ChatRecord[]) =>
    records.map((record) => record.subtype);
  const appended = () =>
    vi
      .mocked(mockLease.appendJsonLine)
      .mock.calls.map((call) => call[0] as ChatRecord);
  async function flushed(index = 0) {
    await svc.flush();
    return written(index);
  }
  async function flushedAll() {
    await svc.flush();
    return writes();
  }
  const user = (text: string, ...rest: RestOf<UserArgs>) =>
    svc.recordUserMessage([{ text }], ...rest);
  const reply = (message: string | Part[], target = svc) =>
    target.recordAssistantTurn({
      model: 'gemini-pro',
      message: typeof message === 'string' ? [{ text: message }] : message,
    });
  const turn = (question: string, answer: string | Part[]) => {
    user(question);
    reply(answer);
  };
  const checkpoint = (
    cursor: BranchCheckpointCursor,
    stopReason = 'end_turn',
    target = svc,
  ) => target.recordBranchCheckpointTransaction({ cursor, stopReason });
  const recordModel = (...args: Parameters<typeof modelPayload>) =>
    svc.recordSessionModel(modelPayload(...args));
  const legacyRecorder = () =>
    new ChatRecordingService(mockConfig, undefined, false);
  /** Holds the next call of `mock` on a promise the test settles by hand. */
  function holdNext(mock: {
    mockImplementationOnce(impl: () => Promise<void>): unknown;
  }) {
    const held: { resolve?: () => void; reject?: (error: Error) => void } = {};
    mock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve, reject) => {
          Object.assign(held, { resolve, reject });
        }),
    );
    return held;
  }
  /** Clears prior writes, then records `payload`, which must resolve true. */
  async function recordModelFresh(
    target: ChatRecordingService,
    payload = modelPayload(),
  ) {
    vi.mocked(jsonl.writeLine).mockClear();
    await expect(target.recordSessionModel(payload)).resolves.toBe(true);
  }

  describe('background execution recording ownership', () => {
    const turn: BackgroundNotificationTurn = {
      turnId: 'automatic-turn',
      taskId: 'completed-agent',
      kind: 'agent',
      sourceTurnId: 'original-user-turn',
      toolUseId: 'launch-tool',
      startedAt: 1234,
    };

    it.each([
      ['ordinary execution', undefined, null, false],
      ['active parent execution', 'test-session-id', null, true],
      ['different session', 'other-session-id', null, false],
      ['nested subagent', 'test-session-id', 'nested-agent', false],
    ] as const)(
      'records ownership for %s',
      async (_, sessionId, agentId, tagged) => {
        const record = async () => user('message');
        const inAgent = () =>
          agentId ? runWithAgentContext(agentId, record) : record();
        if (sessionId) {
          await backgroundTurnContext.run(
            { sessionId, turn, active: true },
            async () => {
              await Promise.resolve();
              await inAgent();
            },
          );
        } else {
          await inAgent();
        }

        expect((await flushed()).backgroundTurn).toEqual(
          tagged ? turn : undefined,
        );
      },
    );

    it('records task completion as session metadata without model content', async () => {
      const payload = {
        displayText: 'A separate background task completed',
        backgroundTask: {
          taskId: 'other-agent',
          status: 'completed',
          kind: 'agent' as const,
          sourceTurnId: 'earlier-turn',
        },
      };
      backgroundTurnContext.run(
        { sessionId: 'test-session-id', turn, active: true },
        () => svc.recordBackgroundTaskCompleted(payload),
      );

      const persisted = await flushed();
      expect(persisted).toMatchObject({
        type: 'system',
        subtype: 'background_task_completed',
        systemPayload: payload,
      });
      expect(persisted.message).toBeUndefined();
      expect(persisted.backgroundTurn).toBeUndefined();
    });

    it('does not tag a callback inherited from a completed automatic execution', async () => {
      const context = { sessionId: 'test-session-id', turn, active: true };
      const gate = deferred();
      const delayed = backgroundTurnContext.run(context, async () => {
        await gate.promise;
        user('late callback');
      });
      context.active = false;
      gate.resolve();
      await delayed;

      expect((await flushed()).backgroundTurn).toBeUndefined();
    });
  });

  describe('recordUserMessage', () => {
    const hookText = [
      '<qwen:user-prompt-submit-context>',
      'hook-only context',
      '</qwen:user-prompt-submit-context>',
    ].join('\n');
    const hookPayload = (displayText: string) => ({
      displayText,
      hookContext: 'hook-only context',
    });
    async function recordMidTurnImage(text: string, displayText: string) {
      const attachmentReferences = [
        {
          type: 'image' as const,
          attachmentId: 'image.png',
          mimeType: 'image/png',
          size: 3,
        },
      ];
      svc.recordMidTurnUserMessage(
        [{ text }],
        displayText,
        undefined,
        attachmentReferences,
      );
      return { record: await flushed(), attachmentReferences };
    }

    it('should record a user message immediately', async () => {
      const userParts: Part[] = [{ text: 'Hello, world!' }];
      svc.recordUserMessage(userParts, undefined, undefined, 'prompt-1');
      const record = await flushed();

      expect(jsonl.writeLine).toHaveBeenCalledTimes(1);
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
      expect(record.daemonPromptId).toBeUndefined();
    });

    it('preserves prompt identities in compression checkpoints', async () => {
      const content: Content = {
        role: 'user',
        parts: [{ text: 'prompt' }],
      };
      markApiHistoryPrompt(content, 'prompt-1');

      svc.recordChatCompression({
        info: {
          originalTokenCount: 10,
          newTokenCount: 5,
          compressionStatus: CompressionStatus.COMPRESSED,
        },
        compressedHistory: [content],
      });

      const record = await flushed();
      expect(record.systemPayload).toMatchObject({ promptIds: ['prompt-1'] });
    });

    it('freezes the compression snapshot array against later live-history mutation', async () => {
      // Deferred serialization must keep entries aligned with promptIds.
      const first: Content = { role: 'user', parts: [{ text: 'A' }] };
      const second: Content = { role: 'user', parts: [{ text: 'B' }] };
      markApiHistoryPrompt(first, 'prompt-1');
      markApiHistoryPrompt(second, 'prompt-2');
      const liveHistory: Content[] = [first, second];

      svc.recordChatCompression({
        info: {
          originalTokenCount: 10,
          newTokenCount: 5,
          compressionStatus: CompressionStatus.COMPRESSED,
        },
        compressedHistory: liveHistory,
      });

      // Mutations the same turn performs before the queued write drains.
      liveHistory.splice(1, 0, {
        role: 'user',
        parts: [
          {
            functionResponse: { name: 'tool', response: {} },
          } as Part,
        ],
      });
      liveHistory.push({ role: 'user', parts: [{ text: 'C' }] });

      const record = await flushed();
      const payload = record.systemPayload as {
        compressedHistory: Content[];
        promptIds: Array<string | null>;
      };
      expect(payload.compressedHistory).toHaveLength(2);
      expect(payload.compressedHistory).toHaveLength(payload.promptIds.length);
      expect(payload.promptIds).toEqual(['prompt-1', 'prompt-2']);
      expect(
        payload.compressedHistory.map((c) =>
          c.parts?.map((p) => ('text' in p ? p.text : undefined)),
        ),
      ).toEqual([['A'], ['B']]);
    });

    it('persists the daemon prompt identity before any turn result', async () => {
      user('same prompt', undefined, undefined, undefined, 'daemon-prompt-1');
      await svc.flush();

      expect(jsonl.writeLine).toHaveBeenCalledTimes(1);
      expect(written()).toMatchObject({
        type: 'user',
        daemonPromptId: 'daemon-prompt-1',
        message: { role: 'user', parts: [{ text: 'same prompt' }] },
      });
    });

    it.each(['42', '9007199254740992'])(
      'keeps daemon IDs ending in ########%s out of CLI turn recovery',
      async (turn) => {
        const daemonPromptId = `test-session-id########${turn}`;
        user('same prompt', undefined, undefined, undefined, daemonPromptId);

        const record = await flushed();
        expect(record.daemonPromptId).toBe(daemonPromptId);
        expect(record).not.toHaveProperty('promptId');
        expect(computeInitialTurnFromHistory([record], 'test-session-id')).toBe(
          1,
        );
      },
    );

    it('preserves model-bound parts and records clean display text', async () => {
      const modelParts: Part[] = [
        { text: 'expanded model prompt' },
        { text: hookText },
      ];
      svc.recordUserMessage(
        modelParts,
        undefined,
        hookPayload('raw @file prompt'),
      );

      const record = await flushed();
      expect(record.message).toEqual({ role: 'user', parts: modelParts });
      expect(record.systemPayload).toEqual(hookPayload('raw @file prompt'));
    });

    it('records empty display text without dropping prompt provenance', async () => {
      user(hookText, undefined, hookPayload(''));

      expect((await flushed()).systemPayload).toEqual(hookPayload(''));
    });

    it('blocks later turns after a generic durable write failure', async () => {
      const failure = new Error('disk full');
      vi.mocked(mockLease.appendJsonLine).mockRejectedValueOnce(failure);

      user('not durable');
      await expect(svc.flush()).rejects.toBe(failure);
      await expect(svc.assertCanStartTurn()).rejects.toMatchObject({
        name: 'SessionWriterUnavailableError',
        cause: failure,
      } satisfies Partial<SessionWriterUnavailableError>);
      user('must be blocked');
      expect(mockLease.appendJsonLine).toHaveBeenCalledTimes(1);
    });

    it('orders new appends after an authoritative read barrier', async () => {
      const readStarted = deferred();
      const readGate = deferred();
      const snapshot = svc.runWithWriteBarrier(async () => {
        readStarted.resolve();
        await readGate.promise;
        return 'snapshot';
      });
      await readStarted.promise;

      user('after snapshot');
      expect(mockLease.appendJsonLine).not.toHaveBeenCalled();
      readGate.resolve();

      await expect(snapshot).resolves.toBe('snapshot');
      await svc.flush();
      expect(mockLease.appendJsonLine).toHaveBeenCalledOnce();
      expect(mockLease.assertOwnedAndUnchanged).toHaveBeenCalledTimes(2);
    });

    it('should chain messages correctly with parentUuid', async () => {
      turn('First message', 'Response');
      user('Second message');
      const [user1, assistant, user2] = await flushedAll();
      expect(user1.uuid).toBe('00000000-0000-0000-0000-000000000001');
      expect(user1.parentUuid).toBeNull();

      expect(assistant.uuid).toBe('00000000-0000-0000-0000-000000000002');
      expect(assistant.parentUuid).toBe('00000000-0000-0000-0000-000000000001');

      expect(user2.uuid).toBe('00000000-0000-0000-0000-000000000003');
      expect(user2.parentUuid).toBe('00000000-0000-0000-0000-000000000002');
    });

    it('should record mid-turn user messages with a mergeable subtype', async () => {
      const modelFacingParts: Part[] = [
        { text: '\n[User message received during tool execution]: save logs' },
      ];
      svc.recordMidTurnUserMessage(modelFacingParts, 'save logs');
      const record = await flushed();

      expect(jsonl.writeLine).toHaveBeenCalledTimes(1);
      expect(record.type).toBe('user');
      expect(record.subtype).toBe('mid_turn_user_message');
      expect(record.message).toEqual({ role: 'user', parts: modelFacingParts });
      expect(record.systemPayload).toEqual({ displayText: 'save logs' });
    });

    it('writes original resource links on an attachment-only user record', async () => {
      const resourceLinks = [
        {
          type: 'resource_link' as const,
          uri: 'transit://resource-a',
          name: 'notes.md',
          mimeType: 'text/markdown',
          size: 0,
          description: 'Original reference',
          annotations: { audience: ['user' as const], priority: 0.5 },
          _meta: { preview: { version: 1 } },
        },
      ];
      svc.recordUserMessage(
        '',
        undefined,
        { displayText: '', hookContext: '', resourceLinks },
        undefined,
        'resource-prompt',
      );

      const record = await flushed();
      expect(record.type).toBe('user');
      expect(record.daemonPromptId).toBe('resource-prompt');
      expect(record.systemPayload).toEqual({
        displayText: '',
        hookContext: '',
        resourceLinks,
      });
    });

    it('records mid-turn attachment references without inline bytes', async () => {
      const { record, attachmentReferences } = await recordMidTurnImage(
        'inspect image',
        'inspect image',
      );
      expect(record.message).toEqual(userText('inspect image'));
      expect(record.systemPayload).toEqual({
        displayText: 'inspect image',
        attachmentReferences,
      });
    });

    it('records attachment references when the mid-turn display text is empty', async () => {
      const { record, attachmentReferences } = await recordMidTurnImage(
        '[User message received during tool execution]: ',
        '',
      );
      expect(record.systemPayload).toEqual({
        displayText: '',
        attachmentReferences,
      });
    });

    it('records defensive Goal context on real user messages', async () => {
      const topLevelPermit = goalPermit('turn-top-level', 2);
      const midTurnPermit = goalPermit('turn-mid-turn', 2);

      user('top-level evidence', topLevelPermit);
      svc.recordMidTurnUserMessage(
        [{ text: 'mid-turn evidence' }],
        'mid-turn evidence',
        midTurnPermit,
      );
      topLevelPermit.revision = 99;
      midTurnPermit.turnId = 'mutated';
      const [topLevel, midTurn] = await flushedAll();
      expect(topLevel).toMatchObject({
        provenance: 'real_user',
        goalContext: goalPermit('turn-top-level', 2),
      });
      expect(midTurn).toMatchObject({
        subtype: 'mid_turn_user_message',
        provenance: 'real_user',
        goalContext: goalPermit('turn-mid-turn', 2),
      });
    });

    it('classifies notification-like records as system provenance', async () => {
      const permit = goalPermit('turn-notification', 2);
      const backgroundTask = {
        taskId: 'task-1',
        status: 'completed',
        kind: 'agent',
      } as const;
      svc.recordNotification(
        [{ text: 'dependency completed' }],
        'Dependency completed',
        backgroundTask,
        permit,
      );
      permit.turnId = 'mutated';

      expect(await flushed()).toMatchObject({
        subtype: 'notification',
        provenance: 'system',
        goalContext: goalPermit('turn-notification', 2),
        systemPayload: { displayText: 'Dependency completed', backgroundTask },
      });
    });

    it('persists deliveredTurn only on the delivered notification turn', async () => {
      // Producer guard for the `deliveredTurn` stamp. Session recovery reads
      // it back off the persisted JSONL record
      // (`isSystemNotificationRecord`, session-api-history.ts), so the
      // argument has to survive recordNotification -> recordNotificationLike
      // -> createNotificationRecord -> appendRecord. Without this case the
      // reader-side tests in session-recovery.test.ts and
      // session-api-history.test.ts stay green on hand-built records even if
      // no record on disk ever carries the stamp.
      svc.recordNotification(
        [{ text: 'dependency completed' }],
        'Dependency completed',
        undefined,
        undefined,
        /* deliveredTurn */ true,
      );
      svc.recordNotification(
        [{ text: 'persisted before the turn ran' }],
        'Persisted early',
      );

      const [delivered, cold] = await flushedAll();
      expect(delivered).toMatchObject({
        subtype: 'notification',
        provenance: 'system',
        deliveredTurn: true,
      });
      expect(cold).toMatchObject({
        subtype: 'notification',
        provenance: 'system',
      });
      // Absence, not `false`: a `deliveredTurn: false` key would satisfy the
      // reader just as well, but undelivered records must stay byte-identical
      // to pre-stamp transcripts so old and new cold records compare equal.
      expect(cold).toBeDefined();
      expect('deliveredTurn' in (cold as object)).toBe(false);
    });
  });

  describe('recordBranchCheckpointTransaction', () => {
    const cursorThenTurn = (
      answer: string | Part[] = 'hi',
      question = 'hello',
    ) => {
      const cursor = svc.getBranchCheckpointCursor();
      turn(question, answer);
      return cursor;
    };
    // Checkpoints a hello/hi turn while `side` appends during validation;
    // the side record must land after the checkpoint, parented on it.
    async function checkpointWithSide(
      side: () => Promise<unknown>,
      subtype: string,
    ) {
      const pending = checkpoint(cursorThenTurn());
      const sideWrite = side();
      const point = await pending;
      await sideWrite;

      const records = appended();
      expect(subtypes(records)).toEqual([
        undefined,
        undefined,
        'branch_checkpoint',
        subtype,
      ]);
      expect(records.at(-1)?.parentUuid).toBe(point?.checkpointUuid);
      return point;
    }
    it('durably records a checkpoint for a completed text turn', async () => {
      const cursor = cursorThenTurn();
      await svc.recordCustomTitle('Title', 'manual');

      const point = await checkpoint(cursor);

      expect(point).toEqual({
        startExclusiveRecordUuid: null,
        endInclusiveRecordUuid: '00000000-0000-0000-0000-000000000003',
        assistantRecordUuid: '00000000-0000-0000-0000-000000000002',
        checkpointUuid: '00000000-0000-0000-0000-000000000004',
      });
      const record = appended().at(-1) as ChatRecord;
      expect(record).toMatchObject({
        uuid: point?.checkpointUuid,
        parentUuid: point?.endInclusiveRecordUuid,
        subtype: 'branch_checkpoint',
        systemPayload: {
          v: 1,
          startExclusiveRecordUuid: null,
          assistantRecordUuid: point?.assistantRecordUuid,
        },
      });
      expect(record.systemPayload).not.toHaveProperty('promptId');
      expect(mockConfig.getSessionService).not.toHaveBeenCalled();
    });

    it('validates successive turns from in-memory cursors without reloading history', async () => {
      const firstCursor = svc.getBranchCheckpointCursor();
      turn('first', 'first answer');
      const first = await checkpoint(firstCursor);

      const secondCursor = svc.getBranchCheckpointCursor();
      turn('second', 'second answer');
      const second = await checkpoint(secondCursor);

      expect(first).toBeDefined();
      expect(second).toBeDefined();
      expect(second?.startExclusiveRecordUuid).toBe(first?.checkpointUuid);
      expect(mockConfig.getSessionService).not.toHaveBeenCalled();
    });

    it('orders metadata arriving during validation after the checkpoint', async () => {
      await checkpointWithSide(
        () => svc.recordCustomTitle('Title', 'manual'),
        'custom_title',
      );
    });

    it('keeps a buffered side artifact out of the active branch tail', async () => {
      const point = await checkpointWithSide(
        () =>
          svc.recordSessionArtifactEvent(
            artifactEvent('2026-08-10T00:00:00.000Z'),
          ),
        'session_artifact_event',
      );
      expect(svc.getBranchCheckpointCursor()).toMatchObject({
        recordId: point?.checkpointUuid,
        activeRecordCount: 3,
      });
    });

    it('restores pending tool state before checkpointing a continued turn', async () => {
      svc.rebuildTurnBoundaries([
        branchTestRecord('user-1', null, 'user', [{ text: 'first' }]),
        branchTestRecord('assistant-tool-1', 'user-1', 'assistant', [
          { functionCall: { id: 'call-1', name: 'read_file', args: {} } },
        ]),
        branchTestRecord('tool-1', 'assistant-tool-1', 'tool_result', [
          fnResponse('read_file', { output: 'ok' }, 'call-1'),
        ]),
        branchTestRecord('assistant-1', 'tool-1', 'assistant', [
          { text: 'first done' },
        ]),
        branchTestRecord('user-2', 'assistant-1', 'user', [{ text: 'second' }]),
        branchTestRecord('assistant-tool-2', 'user-2', 'assistant', [
          { functionCall: { id: 'call-2', name: 'shell', args: {} } },
        ]),
      ]);
      const cursor = svc.getBranchCheckpointCursor();

      svc.recordToolResult([fnResponse('shell', { output: 'ok' }, 'call-2')]);
      reply('second done');

      await expect(checkpoint(cursor)).resolves.toMatchObject({
        startExclusiveRecordUuid: 'assistant-tool-2',
        assistantRecordUuid: '00000000-0000-0000-0000-000000000002',
      });
    });

    it('tracks tool calls incrementally across a checkpoint cursor', async () => {
      turn('question', [
        { functionCall: { id: 'call-1', name: 'read_file', args: {} } },
      ]);
      const cursor = svc.getBranchCheckpointCursor();

      svc.recordToolResult([
        fnResponse('read_file', { output: 'ok' }, 'call-1'),
      ]);
      reply('done');

      await expect(checkpoint(cursor)).resolves.toMatchObject({
        startExclusiveRecordUuid: cursor.recordId,
        assistantRecordUuid: '00000000-0000-0000-0000-000000000004',
      });
    });

    it('rejects a completed turn with a dangling tool call', async () => {
      const cursor = cursorThenTurn(
        [{ functionCall: { id: 'call-1', name: 'read_file', args: {} } }],
        'question',
      );

      await expect(checkpoint(cursor)).resolves.toBeUndefined();
    });

    it.each([{ recordId: 'stale-record' }, { activeRecordCount: 99 }])(
      'rejects a stale checkpoint cursor: %o',
      async (cursorOverride) => {
        const cursor = cursorThenTurn();

        await expect(
          checkpoint({ ...cursor, ...cursorOverride }),
        ).rejects.toThrow(
          'Transcript changed while recording branch checkpoint',
        );
      },
    );

    it('releases buffered appends with a continuous chain when no candidate exists', async () => {
      const cursor = svc.getBranchCheckpointCursor();
      user('no assistant yet');
      const pending = checkpoint(cursor);
      const title = svc.recordCustomTitle('Title', 'manual');
      user('next turn');

      await expect(pending).resolves.toBeUndefined();
      await expect(title).resolves.toBe(true);
      await svc.flush();

      const records = appended();
      expect(subtypes(records)).toEqual([undefined, 'custom_title', undefined]);
      expect(records[1]?.parentUuid).toBe(records[0]?.uuid);
      expect(records[2]?.parentUuid).toBe(records[1]?.uuid);
      expect(svc.getTranscriptCursor().recordId).toBe(records[2]?.uuid);
    });

    it.each(['cancelled', 'max_tokens'])(
      'does not record a checkpoint for a %s turn',
      async (stopReason) => {
        turn('hello', 'partial');
        await svc.flush();
        const writesBeforeCheckpoint = vi.mocked(mockLease.appendJsonLine).mock
          .calls.length;

        await expect(
          checkpoint(svc.getBranchCheckpointCursor(), stopReason),
        ).resolves.toBeUndefined();
        expect(vi.mocked(mockLease.appendJsonLine)).toHaveBeenCalledTimes(
          writesBeforeCheckpoint,
        );
      },
    );

    it('settles buffered appends without stalling when the checkpoint write fails', async () => {
      const writeError = new Error('disk full');
      const cursor = cursorThenTurn();

      // Fail only the checkpoint append; the turn's records still write.
      vi.mocked(mockLease.appendJsonLine).mockImplementation(
        async (record: unknown) => {
          if ((record as ChatRecord).subtype === 'branch_checkpoint') {
            throw writeError;
          }
          return jsonl.writeLine('/test/session.jsonl', record);
        },
      );

      const pending = checkpoint(cursor);
      // Buffered behind the topology fence while validation is in flight:
      // one strict append and one fire-and-forget append.
      const title = svc.recordCustomTitle('Title', 'manual');
      user('next turn');

      await expect(pending).rejects.toBe(writeError);
      // The buffered strict append settles (rejected with the write
      // failure, surfaced as `false`) instead of hanging on the fence.
      await expect(title).resolves.toBe(false);

      const records = appended();
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
      await expect(checkpoint(svc.getBranchCheckpointCursor())).rejects.toBe(
        writeError,
      );
    });

    it('rejects a concurrent recordBranchCheckpointTransaction', async () => {
      const cursor = cursorThenTurn();

      const first = checkpoint(cursor);

      await expect(checkpoint(cursor)).rejects.toThrow(
        'Transcript topology transaction already active',
      );

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
    const okResult = () => [
      { functionResponse: { name: 'run', response: { ok: true } } },
    ];

    it('strictly persists the caller-owned state UUID', async () => {
      const record = await svc.recordGoalState('goal-record', goalPayload);

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
      expect(svc.getTranscriptCursor()).toEqual({ recordId: 'goal-record' });
    });

    it('restores the persisted cursor when a queued append fails', async () => {
      user('persisted baseline');
      await svc.flush();
      const persistedCursor = svc.getTranscriptCursor();

      const held = holdNext(vi.mocked(jsonl.writeLine));
      const strict = svc.recordGoalState('goal-record', goalPayload);
      user('queued after strict record');
      await Promise.resolve();
      held.reject!(new Error('disk full'));

      await expect(strict).rejects.toThrow('disk full');
      await expect(svc.flush()).rejects.toThrow('disk full');
      expect(svc.getTranscriptCursor()).toEqual(persistedCursor);
    });

    it('records Goal-owned model traffic without aliasing permits', async () => {
      const runtimePermit = goalPermit('runtime-turn', 3);
      const assistantPermit = goalPermit('assistant-turn', 3);
      const toolPermit = goalPermit('tool-turn', 3);

      svc.recordGoalRuntimeMessage([{ text: 'continue' }], runtimePermit);
      svc.recordAssistantTurn({
        model: 'gemini-pro',
        message: [{ text: 'working' }],
        goalContext: assistantPermit,
      });
      svc.recordToolResult(okResult(), undefined, { goalContext: toolPermit });
      runtimePermit.turnId = 'mutated-runtime';
      assistantPermit.revision = 99;
      toolPermit.goalId = 'mutated-goal';
      const records = await flushedAll();
      expect(records.map((record) => record.provenance)).toEqual([
        'goal_runtime',
        'assistant_output',
        'tool_result',
      ]);
      expect(records.map((record) => record.goalContext)).toEqual([
        goalPermit('runtime-turn', 3),
        goalPermit('assistant-turn', 3),
        goalPermit('tool-turn', 3),
      ]);
    });

    it('overrides tool result provenance to goal_runtime when requested', async () => {
      const permit = goalPermit('tool-override-turn', 4);
      svc.recordToolResult(okResult(), undefined, {
        goalContext: permit,
        provenance: 'goal_runtime',
      });
      permit.turnId = 'mutated';

      expect(await flushed()).toMatchObject({
        provenance: 'goal_runtime',
        goalContext: goalPermit('tool-override-turn', 4),
      });
    });

    it('does not treat Goal runtime continuations as rewind boundaries', async () => {
      reply('before Goal runtime turn');
      svc.recordGoalRuntimeMessage(
        [{ text: 'continue Goal' }],
        goalPermit('turn-1'),
      );
      reply('after Goal runtime turn');

      svc.rewindRecording(0, { truncatedCount: 2 });

      expect(await flushed(3)).toMatchObject({
        subtype: 'rewind',
        parentUuid: null,
      });
    });
  });

  describe('recordExternalAgentRecordStrict', () => {
    const mention = (recordKey = 'mention:client-1') => ({
      kind: 'agent_mention' as const,
      recordKey,
      modelText: '<agent_mention>hi</agent_mention>',
      payload: { displayText: '@claude hi', mentionedAgentIds: ['agent-1'] },
    });
    const persistedMention: ChatRecord = {
      ...branchTestRecord('mention-0', null, 'user', [{ text: 'hi' }]),
      subtype: 'agent_mention',
      provenance: 'real_user',
      externalRecordKey: 'mention:client-1',
      systemPayload: { displayText: '@claude hi', mentionedAgentIds: [] },
    };
    const resumeWith = (messages: ChatRecord[]) => {
      const loadSession = vi
        .fn()
        .mockResolvedValue({ conversation: { messages } });
      vi.mocked(mockConfig.getResumedSessionData).mockReturnValue({
        conversation: { messages },
        lastCompletedUuid: messages.at(-1)?.uuid ?? null,
      } as unknown as ReturnType<Config['getResumedSessionData']>);
      vi.mocked(mockConfig.getSessionService).mockReturnValue({
        loadSession,
      } as unknown as ReturnType<Config['getSessionService']>);
      return loadSession;
    };

    it('persists the key and returns the record uuid and timestamp', async () => {
      const result = await svc.recordExternalAgentRecordStrict(mention());
      expect(written()).toMatchObject({
        type: 'user',
        subtype: 'agent_mention',
        externalRecordKey: 'mention:client-1',
      });
      expect(result).toEqual({
        uuid: written().uuid,
        timestamp: written().timestamp,
        created: true,
      });
    });

    it('returns the first record for a repeated key without writing', async () => {
      const first = await svc.recordExternalAgentRecordStrict(mention());
      vi.mocked(jsonl.writeLine).mockClear();
      await expect(
        svc.recordExternalAgentRecordStrict(mention()),
      ).resolves.toEqual({ ...first, created: false });
      expect(jsonl.writeLine).not.toHaveBeenCalled();
    });

    it('does not read a fresh transcript to build its index', async () => {
      const loadSession = vi.fn();
      vi.mocked(mockConfig.getSessionService).mockReturnValue({
        loadSession,
      } as unknown as ReturnType<Config['getSessionService']>);
      await svc.recordExternalAgentRecordStrict(mention());
      expect(loadSession).not.toHaveBeenCalled();
    });

    it('finds a key persisted before a restart', async () => {
      const loadSession = resumeWith([persistedMention]);
      const restarted = activateRecording(new ChatRecordingService(mockConfig));

      await expect(
        restarted.findExternalAgentRecord('mention:client-1'),
      ).resolves.toEqual({
        uuid: 'mention-0',
        timestamp: persistedMention.timestamp,
      });
      await expect(
        restarted.recordExternalAgentRecordStrict(mention()),
      ).resolves.toEqual({
        uuid: 'mention-0',
        timestamp: persistedMention.timestamp,
        created: false,
      });
      expect(jsonl.writeLine).not.toHaveBeenCalled();

      // A new key is written and joins the index; the transcript is read once.
      const other = await restarted.recordExternalAgentRecordStrict(
        mention('mention:client-2'),
      );
      expect(other.created).toBe(true);
      await expect(
        restarted.findExternalAgentRecord('mention:client-2'),
      ).resolves.toEqual({ uuid: other.uuid, timestamp: other.timestamp });
      expect(loadSession).toHaveBeenCalledOnce();
    });

    it('fails closed when the transcript cannot be read', async () => {
      const loadSession = resumeWith([persistedMention]);
      loadSession.mockRejectedValueOnce(new Error('EIO'));
      const restarted = activateRecording(new ChatRecordingService(mockConfig));

      await expect(
        restarted.recordExternalAgentRecordStrict(mention()),
      ).rejects.toThrow('EIO');
      expect(jsonl.writeLine).not.toHaveBeenCalled();
      // The next attempt reads again and finds the record.
      await expect(
        restarted.recordExternalAgentRecordStrict(mention()),
      ).resolves.toMatchObject({ uuid: 'mention-0', created: false });
    });
  });

  describe('recordNotificationStrict', () => {
    const workerTask = {
      taskId: 'worker-1',
      status: 'completed',
      kind: 'agent',
    } as const;
    const notifyStrict = (target: ChatRecordingService) =>
      target.recordNotificationStrict(
        [{ text: '<task-notification />' }],
        'Worker completed.',
        workerTask,
      );
    const resumeWithSessionModel = (modelId: unknown) =>
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
              systemPayload: { modelId, authType: 'openai' },
            },
          ],
        },
        lastCompletedUuid: 'model-1',
      } as unknown as ReturnType<Config['getResumedSessionData']>);

    it('resolves only after the notification is durably appended', async () => {
      await expect(notifyStrict(svc)).resolves.toBeUndefined();
      expect(written()).toMatchObject({
        type: 'user',
        subtype: 'notification',
        systemPayload: {
          displayText: 'Worker completed.',
          backgroundTask: workerTask,
        },
      });
      // The cold record must never carry the stamp: it is written before
      // admission, so a stamp would also mark turns later refused or
      // deferred (turn-interruption.ts). `toMatchObject` ignores extra
      // keys, so the absence has to be pinned by key.
      expect('deliveredTurn' in written()).toBe(false);
    });

    it('rejects instead of acknowledging an inactive recorder', async () => {
      await expect(
        notifyStrict(new ChatRecordingService(mockConfig)),
      ).rejects.toMatchObject({ name: 'SessionWriterUnavailableError' });
      expect(jsonl.writeLine).not.toHaveBeenCalled();
    });

    it('restores session model bindings for duplicate suppression', async () => {
      const service = new ChatRecordingService(mockConfig, undefined, false, {
        lastCompletedUuid: 'projected-leaf',
        turnParentUuids: [null],
        sessionModel: { modelId: 'qwen3-coder-plus', authType: 'openai' },
      });
      await recordModelFresh(service);
      expect(jsonl.writeLine).not.toHaveBeenCalled();
    });

    it('restores session model bindings from a full-record replay', async () => {
      resumeWithSessionModel('qwen3-coder-plus');
      await recordModelFresh(legacyRecorder());
      expect(jsonl.writeLine).not.toHaveBeenCalled();
    });

    it('skips a non-string session_model payload during full-record replay', async () => {
      resumeWithSessionModel(42);
      expect(() => legacyRecorder()).not.toThrow();
      await recordModelFresh(legacyRecorder());
      expect(jsonl.writeLine).toHaveBeenCalledOnce();
    });
  });

  describe('rewindRecording', () => {
    const displayed = (text: string) =>
      user(`hidden ${text}`, undefined, { displayText: text, hookContext: '' });

    it('drops display projections from rewound user turns', async () => {
      displayed('A');
      displayed('B');

      svc.rewindRecording(1, { truncatedCount: 1 });
      displayed('C');

      expect(svc.getUserDisplayTextsForTitle()).toEqual(['A', 'C']);
      await svc.flush();
      vi.mocked(jsonl.writeLine).mockClear();
    });

    it('compensates the rewind splice for the display-text cap window', async () => {
      // 25 turns, but the projection buffer retains only the last 20, so the
      // rewind splice must offset by the 5 turns that fell out of the window.
      for (let index = 0; index < 25; index += 1) {
        user(`hidden ${index}`, undefined, {
          displayText: `visible ${index}`,
          hookContext: '',
        });
      }
      expect(svc.getUserDisplayTextsForTitle()).toHaveLength(20);

      // Rewind to turn 22 keeps turns 0..21; the retained window covers turns
      // 5..24, so projections for turns 5..21 (entries 0..16) must survive.
      svc.rewindRecording(22, { truncatedCount: 3 });

      expect(svc.getUserDisplayTextsForTitle()).toEqual(
        Array.from({ length: 17 }, (_, index) => `visible ${index + 5}`),
      );
      await svc.flush();
      vi.mocked(jsonl.writeLine).mockClear();
    });

    it('preserves a resumed user turn parent when rebuilding rewind boundaries', async () => {
      vi.mocked(mockConfig.getResumedSessionData).mockReturnValue({
        lastCompletedUuid: 'assistant-1',
      } as unknown as ReturnType<Config['getResumedSessionData']>);
      svc = activateRecording(new ChatRecordingService(mockConfig));

      svc.rebuildTurnBoundaries(
        resumedChain(
          'pre-resume-parent',
          ['user-1', 'user', 'first resumed turn'],
          ['assistant-1', 'assistant', 'response'],
        ),
      );

      svc.rewindRecording(0, { truncatedCount: 2 });
      const rewind = await flushed();

      expect(jsonl.writeLine).toHaveBeenCalledTimes(1);
      expect(rewind.subtype).toBe('rewind');
      expect(rewind.parentUuid).toBe('pre-resume-parent');
    });

    it('does not treat a resumed Goal runtime continuation as a rewind boundary', async () => {
      const goalRuntime = {
        subtype: 'goal_runtime',
        provenance: 'goal_runtime',
      } as const;
      svc.rebuildTurnBoundaries(
        resumedChain(
          null,
          ['user-1', 'user', 'first turn'],
          ['assistant-1', 'assistant', 'response'],
          ['goal-runtime-1', 'user', 'Continue working.', goalRuntime],
          ['assistant-2', 'assistant', 'still working'],
          ['user-2', 'user', 'second turn'],
        ),
      );

      // The Goal runtime continuation is not a turn boundary, so turn index 1
      // is the second REAL user turn (user-2), re-rooting at assistant-2. Were
      // the continuation counted, index 1 would re-root at assistant-1.
      svc.rewindRecording(1, { truncatedCount: 3 });
      await svc.flush();

      const rewind = writes().find((record) => record.subtype === 'rewind');
      expect(rewind?.parentUuid).toBe('assistant-2');
    });

    it('restores a rebuilt persisted tail after a failed append', async () => {
      svc.rebuildTurnBoundaries(
        resumedChain(null, [
          'persisted-tail',
          'assistant',
          'persisted response',
        ]),
      );
      vi.mocked(jsonl.writeLine).mockRejectedValueOnce(new Error('disk full'));

      user('new message');

      await expect(svc.flush()).rejects.toThrow('disk full');
      expect(svc.getTranscriptCursor()).toEqual({ recordId: 'persisted-tail' });
    });
  });

  describe('recordUserTextElements', () => {
    it('records user text elements as a strict system payload', async () => {
      const payload = {
        content: 'hello',
        textElements: [{ text: 'hello', start: 0, end: 5 }],
      };

      await svc.recordUserTextElements(payload);

      expect(jsonl.writeLine).toHaveBeenCalledTimes(1);
      const record = written();
      expect(record.type).toBe('system');
      expect(record.subtype).toBe('user_text_elements');
      expect(record.systemPayload).toEqual(payload);
    });
  });

  describe('recordGoalTurnEnd', () => {
    it('waits for the durable system record and copies the Goal permit', async () => {
      const held = holdNext(vi.mocked(jsonl.writeLine));
      const permit = { goalId: 'goal', revision: 1, turnId: 'turn' };
      const pending = svc.recordGoalTurnEnd('finish', permit);
      permit.turnId = 'changed';
      let settled = false;
      void pending.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      held.resolve!();
      await pending;
      const record = written();
      expect(record).toMatchObject({
        type: 'system',
        subtype: 'goal_turn_end',
        goalContext: { goalId: 'goal', revision: 1, turnId: 'turn' },
        systemPayload: { toolCallId: 'finish' },
      });
      expect(record.message).toBeUndefined();
    });

    it('rejects a failed append instead of reporting a persisted boundary', async () => {
      vi.mocked(jsonl.writeLine).mockRejectedValueOnce(new Error('disk full'));
      await expect(
        svc.recordGoalTurnEnd('finish', goalPermit('turn', 1, 'goal')),
      ).rejects.toThrow('disk full');
    });
  });

  describe('recordTurnResult', () => {
    const isValid = (extra: Record<string, unknown>) =>
      isTurnResultRecordPayload({
        promptId: 'prompt-1',
        state: 'completed',
        endedAt: 2_000,
        ...extra,
      });
    const completed = {
      promptId: 'prompt-1',
      state: 'completed',
      endedAt: 2_000,
    } as const;

    it('normalizes hostile and oversized error fields without throwing', () => {
      const hostile = Object.create(null, {
        message: { get: () => 'm'.repeat(5_000) },
        code: { get: () => 'c'.repeat(500) },
      });

      expect(normalizeTurnResultError(hostile)).toEqual({
        message: 'm'.repeat(TURN_RESULT_ERROR_MESSAGE_MAX_CHARS),
        messageTruncated: true,
        code: 'c'.repeat(TURN_RESULT_ERROR_CODE_MAX_CHARS),
        codeTruncated: true,
      });
      const explode = (what: string) => () => {
        throw new Error(what);
      };
      expect(
        normalizeTurnResultError(
          Object.create(null, {
            message: { get: explode('getter exploded') },
            toString: { value: explode('conversion exploded') },
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
        isValid({
          resultText: 'bounded prefix',
          resultTruncated: true,
          resultCode: 'RESULT_TEXT_TRUNCATED',
        }),
      ).toBe(true);
      expect(isValid({ resultCode: 'RESULT_TEXT_TRUNCATED' })).toBe(false);
    });

    it.each([
      [undefined, true],
      [1_500, true],
      [NaN, false],
      [Infinity, false],
      ['1500', false],
    ])('validates cancellation timestamp %s', (cancelledAt, valid) => {
      expect(
        isTurnResultRecordPayload({
          promptId: 'prompt-1',
          state: 'cancelled',
          startedAt: 1_000,
          cancelledAt,
          endedAt: 2_000,
        }),
      ).toBe(valid);
    });

    it('caps promptId, stopReason, and originatorClientId in turn_result payloads', () => {
      const oversized = 'x'.repeat(TURN_RESULT_IDENTIFIER_MAX_CHARS + 1);
      expect(isValid({ promptId: oversized })).toBe(false);
      expect(isValid({ stopReason: oversized })).toBe(false);
      expect(isValid({ originatorClientId: oversized })).toBe(false);
      const bounded = 'y'.repeat(TURN_RESULT_IDENTIFIER_MAX_CHARS);
      expect(
        isValid({
          promptId: bounded,
          stopReason: bounded,
          originatorClientId: bounded,
        }),
      ).toBe(true);
    });

    it('rejects empty error message and code in turn_result payloads', () => {
      const failed = (error: object) => isValid({ state: 'error', error });
      expect(failed({ message: '' })).toBe(false);
      expect(failed({ message: 'boom', code: '' })).toBe(false);
      expect(failed({ message: 'boom' })).toBe(true);
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

      svc.recordTurnResult(payload);
      const record = await flushed();

      expect(jsonl.writeLine).toHaveBeenCalledTimes(1);
      expect(record.type).toBe('system');
      expect(record.subtype).toBe('turn_result');
      expect(record.systemPayload).toEqual(payload);
    });

    it('refuses to append payloads the bounded contract rejects', async () => {
      svc.recordTurnResult({
        promptId: 'prompt-1',
        state: 'error',
        endedAt: 2_000,
      });
      svc.recordTurnResult({
        promptId: 'prompt-2',
        state: 'completed',
        endedAt: 2_000,
        error: { message: 'stray' },
      });
      await svc.flush();

      expect(
        writes().filter((record) => record.subtype === 'turn_result'),
      ).toHaveLength(0);
    });

    it('keeps turn_result records on the active transcript chain', async () => {
      user('before result');
      svc.recordTurnResult({ ...completed });
      await svc.recordSessionArtifactEvent(
        artifactEvent('2026-08-14T00:00:00.000Z'),
      );
      user('after result');
      const [before, turnResult, artifact, after] = await flushedAll();
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
      /** Records a completed turn_result on `target` after the Config id rotates. */
      async function recordAfterRotation(
        target: ChatRecordingService,
        index = 0,
      ) {
        vi.mocked(mockConfig.getSessionId).mockReturnValue(
          'rotated-session-id',
        );
        target.recordTurnResult({ ...completed });
        await target.flush();
        return vi.mocked(jsonl.writeLine).mock.calls.at(index) as [
          string,
          ChatRecord,
        ];
      }

      it('keeps late turn_result writes on the pinned pre-rotation session', async () => {
        const outgoing = legacyRecorder();
        outgoing.pinSessionIdentity('test-session-id');
        const [filePath, record] = await recordAfterRotation(outgoing);

        expect(jsonl.writeLine).toHaveBeenCalledTimes(1);
        expect(filePath).toContain('test-session-id.jsonl');
        expect(record.sessionId).toBe('test-session-id');
      });

      it('resolves the shared Config session id at write time when not pinned', async () => {
        const [filePath, record] = await recordAfterRotation(legacyRecorder());

        expect(filePath).toContain('rotated-session-id.jsonl');
        expect(record.sessionId).toBe('rotated-session-id');
      });

      it('never overrides a lease binding that owns the session identity', async () => {
        svc.pinSessionIdentity('pinned-session-id');
        const [, record] = await recordAfterRotation(svc, -1);
        expect(record.sessionId).toBe('test-session-id');
      });
    });
  });

  describe('recordAtCommand', () => {
    it('should record @-command metadata as a system payload', async () => {
      const payload: AtCommandRecordPayload = {
        filesRead: ['foo.txt'],
        status: 'success',
        message: 'Success',
        userText: '@foo.txt',
      };

      user('Hello, world!');
      svc.recordAtCommand(payload);
      const [userRecord, systemRecord] = await flushedAll();
      expect(jsonl.writeLine).toHaveBeenCalledTimes(2);
      expect(userRecord.type).toBe('user');
      expect(systemRecord.type).toBe('system');
      expect(systemRecord.subtype).toBe('at_command');
      expect(systemRecord.systemPayload).toEqual(payload);
      expect(systemRecord.parentUuid).toBe(userRecord.uuid);
    });
  });

  describe('recordFileHistorySnapshot', () => {
    type Backup = [string, string | null, number, string, true?];
    // A snapshot and the JSON it must serialize to, from [file,
    // backupFileName, version, HH:MM:SS on 2026-06-13, failed?] specs.
    function snapshotPair(promptId: string, at: string, ...backups: Backup[]) {
      const iso = (time: string) => `2026-06-13T${time}.000Z`;
      const tracked = <T>(time: (at: string) => T) =>
        Object.fromEntries(
          backups.map(([file, backupFileName, version, backupAt, failed]) => [
            file,
            {
              backupFileName,
              version,
              backupTime: time(backupAt),
              ...(failed ? { failed } : {}),
            },
          ]),
        );
      const snapshot = {
        promptId,
        timestamp: new Date(iso(at)),
        trackedFileBackups: tracked((time) => new Date(iso(time))),
      } as FileHistorySnapshot;
      const json = {
        promptId,
        timestamp: iso(at),
        trackedFileBackups: tracked(iso),
      };
      return [snapshot, json] as const;
    }
    const [oldSnapshot, oldJson] = snapshotPair('p1', '00:00:00', [
      'a.txt',
      'backup-a-v1',
      1,
      '00:00:01',
    ]);
    const [updatedSnapshot, updatedJson] = snapshotPair(
      'p1',
      '00:01:00',
      ['a.txt', 'backup-a-v2', 2, '00:01:01'],
      ['b.txt', null, 1, '00:01:02'],
    );
    const [failedSnapshot, failedJson] = snapshotPair(
      'p2',
      '00:02:00',
      ['failed.txt', 'backup-failed-v1', 1, '00:02:01', true],
      ['deleted.txt', null, 2, '00:02:02'],
    );
    const payloadJson = (record: ChatRecord) =>
      JSON.parse(JSON.stringify(record.systemPayload));

    it('writes a system record with the serialized snapshot payload', async () => {
      svc.recordFileHistorySnapshot(oldSnapshot);
      const record = await flushed();

      expect(jsonl.writeLine).toHaveBeenCalledTimes(1);
      expect(record.type).toBe('system');
      expect(record.subtype).toBe('file_history_snapshot');
      expect(payloadJson(record)).toEqual({ snapshots: [oldJson] });
    });

    it('writes a batch of serialized snapshots in order', async () => {
      svc.recordFileHistorySnapshotBatch([oldSnapshot, updatedSnapshot]);
      const record = await flushed();

      expect(jsonl.writeLine).toHaveBeenCalledTimes(1);
      expect(record.type).toBe('system');
      expect(record.subtype).toBe('file_history_snapshot');
      expect(payloadJson(record)).toEqual({
        snapshots: [oldJson, updatedJson],
      });
    });

    it('appends single-snapshot updates in order so resume can last-win', async () => {
      svc.recordFileHistorySnapshot(oldSnapshot);
      svc.recordFileHistorySnapshot(updatedSnapshot);
      const [first, second] = await flushedAll();
      expect(jsonl.writeLine).toHaveBeenCalledTimes(2);
      expect(payloadJson(first)).toEqual({ snapshots: [oldJson] });
      expect(payloadJson(second)).toEqual({ snapshots: [updatedJson] });
    });

    it('retains distinct prompt ids in one batch', async () => {
      svc.recordFileHistorySnapshotBatch([oldSnapshot, failedSnapshot]);
      const record = await flushed();

      expect(jsonl.writeLine).toHaveBeenCalledTimes(1);
      expect(payloadJson(record)).toEqual({ snapshots: [oldJson, failedJson] });
    });

    it('round-trips serialized snapshots through JSON and deserialization', () => {
      expect(
        deserializeSnapshots([
          JSON.parse(JSON.stringify(serializeSnapshot(failedSnapshot))),
        ]),
      ).toEqual([failedSnapshot]);
    });

    it('re-records surviving snapshots after rewind on the active branch', async () => {
      svc.recordFileHistorySnapshot(updatedSnapshot);
      svc.rewindRecording(0, { truncatedCount: 1 }, [oldSnapshot]);
      const [staleSnapshot, rewind, snapshots] = await flushedAll();
      expect(jsonl.writeLine).toHaveBeenCalledTimes(3);
      expect(staleSnapshot.subtype).toBe('file_history_snapshot');
      expect(rewind.subtype).toBe('rewind');
      expect(payloadJson(snapshots)).toEqual({ snapshots: [oldJson] });
    });
  });

  describe('recordAssistantTurn', () => {
    it('should record assistant turn with content only', async () => {
      const parts: Part[] = [{ text: 'Hello!' }];
      reply(parts);
      const record = await flushed();

      expect(jsonl.writeLine).toHaveBeenCalledTimes(1);
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
      svc.recordAssistantTurn({
        model: 'gemini-pro',
        message: parts,
        tokens: {
          promptTokenCount: 100,
          candidatesTokenCount: 50,
          cachedContentTokenCount: 10,
          totalTokenCount: 160,
        },
      });

      const record = await flushed();
      // The service wraps parts in a Content object using createModelContent
      expect(record.message).toEqual({ role: 'model', parts });
      expect(record.model).toBe('gemini-pro');
      expect(record.usageMetadata?.totalTokenCount).toBe(160);
    });

    it('should record assistant turn with only tokens', async () => {
      svc.recordAssistantTurn({
        model: 'gemini-pro',
        tokens: {
          promptTokenCount: 10,
          candidatesTokenCount: 20,
          cachedContentTokenCount: 0,
          totalTokenCount: 30,
        },
      });

      const record = await flushed();
      expect(record.message).toBeUndefined();
      expect(record.usageMetadata?.totalTokenCount).toBe(30);
    });
  });

  describe('recordRealtimeConversation', () => {
    it('durably records direct Realtime dialogue as non-model history', async () => {
      await svc.recordRealtimeConversation(
        [
          { role: 'user', text: '你好' },
          { role: 'assistant', text: '你好！' },
        ],
        'qwen3.5-omni-plus-realtime',
      );

      const records = writes();
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
    async function recordTool(
      ...args: Parameters<ChatRecordingService['recordToolResult']>
    ) {
      svc.recordToolResult(...args);
      return flushed();
    }
    type ToolMeta = Parameters<ChatRecordingService['recordToolResult']>[1];
    // One call-1 response plus success metadata echoing it; the metadata
    // carries undefined `error`/`errorType` keys unless `bare`.
    function successResult(
      name: string,
      output: string,
      resultDisplay: unknown,
      bare = false,
    ) {
      const parts: Part[] = [fnResponse(name, { output }, 'call-1')];
      const meta = {
        callId: 'call-1',
        status: 'success' as const,
        responseParts: parts,
        resultDisplay,
        ...(bare ? {} : { error: undefined, errorType: undefined }),
      } as ToolMeta;
      return [parts, meta] as const;
    }
    const diffStat = (addedChars: number, removedChars: number) => ({
      model_added_lines: 1,
      model_removed_lines: 1,
      model_added_chars: addedChars,
      model_removed_chars: removedChars,
      user_added_lines: 0,
      user_removed_lines: 0,
      user_added_chars: 0,
      user_removed_chars: 0,
    });
    /** Records a small edit diff and checks it is kept by reference. */
    async function expectSmallDiffKept() {
      const resultDisplay: FileDiff = {
        fileName: 'file.txt',
        fileDiff: '--- file.txt\n+++ file.txt\n@@ -1 +1 @@\n-old\n+new',
        originalContent: 'old',
        newContent: 'new',
        diffStat: diffStat(3, 3),
      };
      const record = await recordTool(
        ...successResult('edit', 'ok', resultDisplay),
      );
      expect(record.toolCallResult?.resultDisplay).toBe(resultDisplay);
      expect(
        (record.toolCallResult?.resultDisplay as FileDiff).truncatedForSession,
      ).toBeUndefined();
    }
    /** The `mutated` flag of the recorder_input boundary observation. */
    function inputMutated() {
      const observation = boundaryObserveMock.mock.calls.find(
        ([entry]) => entry.stage === 'recorder_input',
      )?.[0];
      return typeof observation?.mutated === 'function'
        ? observation.mutated()
        : observation?.mutated;
    }

    it('should record tool result with Parts', async () => {
      turn('Hello', [
        { functionCall: { name: 'shell', args: { command: 'ls' } } },
      ]);

      const toolResultParts: Part[] = [
        fnResponse('shell', { output: 'file1.txt\nfile2.txt' }, 'call-1'),
      ];
      svc.recordToolResult(toolResultParts);
      const record = await flushed(2);

      expect(jsonl.writeLine).toHaveBeenCalledTimes(3);
      expect(record.type).toBe('tool_result');
      // The service wraps parts in a Content object using createUserContent
      expect(record.message).toEqual({ role: 'user', parts: toolResultParts });
    });

    it('should record tool result with toolCallResult metadata', async () => {
      const [toolResultParts, metadata] = successResult(
        'shell',
        'result',
        undefined,
        true,
      );
      const record = await recordTool(toolResultParts, metadata);

      expect(record.type).toBe('tool_result');
      // The service wraps parts in a Content object using createUserContent
      expect(record.message).toEqual({ role: 'user', parts: toolResultParts });
      expect(record.toolCallResult).toBeDefined();
      expect(record.toolCallResult?.callId).toBe('call-1');
    });

    it('preserves replayable artifacts without diagnostic metadata', async () => {
      const artifacts = [
        {
          kind: 'link' as const,
          title: 'Replay artifact',
          url: 'https://example.com/replayed',
        },
      ];
      const record = await recordTool(
        [fnResponse('shell', { output: 'result' }, 'call-1')],
        {
          callId: 'call-1',
          status: 'success',
          persistedOutputFiles: ['/private/tool-result.txt'],
          artifacts,
          boundaryArtifact: { state: 'reusable', kinds: ['link'] },
        },
      );

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

    it.each(['', 'small display', 'x'.repeat(40_000)])(
      'observes structured shell display before and after recording (case %#)',
      async (text) => {
        const display: ShellResultDisplay = {
          type: 'shell_result',
          version: 1,
          text,
          output: text,
          directory: '/tmp',
          exitCode: 0,
          signal: null,
          pid: null,
          error: null,
          outcome: 'completed',
          notices: [],
          truncated: false,
          outputFiles: [],
        };
        const record = await recordTool([{ text: 'model response' }], {
          callId: 'shell-1',
          status: 'success',
          resultDisplay: display,
        });

        const savedText = shellResultText(record.toolCallResult?.resultDisplay);
        expect(savedText).toBeDefined();
        expect(savedText!.length).toBeLessThanOrEqual(
          MAX_RETAINED_TOOL_RESULT_DISPLAY_CHARS,
        );
        for (const [stage, value] of [
          ['recorder_input', text],
          ['recorder_output', savedText],
        ]) {
          const observation = boundaryObserveMock.mock.calls.find(
            ([entry]) => entry.stage === stage,
          )?.[0];
          const values = observation?.values;
          expect(
            (typeof values === 'function' ? values() : values)?.filter(
              (entry) => entry.representation === 'display',
            ),
          ).toEqual([{ representation: 'display', value }]);
        }
        expect(display.text).toBe(text);
      },
    );

    it('should keep small file diff resultDisplay unchanged', async () => {
      await expectSmallDiffKept();
      expect(inputMutated()).toBe(false);
    });

    it('compacts large resultDisplay metadata before recording', async () => {
      const large = `head-${'x'.repeat(MAX_RETAINED_TOOL_RESULT_DISPLAY_CHARS)}-tail`;
      const resultDisplay = (
        await recordTool(...successResult('shell', 'result', large, true))
      ).toolCallResult?.resultDisplay;

      expect(typeof resultDisplay).toBe('string');
      expect((resultDisplay as string).length).toBeLessThanOrEqual(
        MAX_RETAINED_TOOL_RESULT_DISPLAY_CHARS,
      );
      expect(resultDisplay).toContain('head-');
      expect(resultDisplay).toContain('-tail');
      expect(resultDisplay).toContain('truncated for saved session preview');
      expect(resultDisplay).not.toContain('CLI history display');
    });

    // https://github.com/QwenLM/qwen-code/issues/10369 - the Web Shell mounts
    // the sandboxed iframe only when the recorded `html` is non-empty, and it
    // never re-fetches the `ui://` resource. Recording an empty `html` makes
    // every replayed MCP App fall back to plain text permanently.
    it('keeps MCP App html and toolResult in the recorded transcript', async () => {
      const html = '<main id="dashboard">MCP_APP_HTML_MARKER</main>';
      const toolResult = {
        content: [{ type: 'text', text: 'Dashboard ready' }],
      };
      const [parts, metadata] = successResult(
        'mcp__demo__dashboard',
        'Dashboard ready',
        {
          type: 'mcp_app',
          serverName: 'demo',
          resourceUri: 'ui://demo/dashboard',
          html,
          toolResult,
          toolArguments: { region: 'APAC' },
          fallbackText: 'Dashboard ready',
        },
        true,
      );

      const recorded = (await recordTool(parts, metadata)).toolCallResult
        ?.resultDisplay as McpAppResultDisplay;

      expect(recorded.type).toBe('mcp_app');
      expect(recorded.html).toBe(html);
      expect(recorded.toolResult).toEqual(toolResult);
      expect(recorded.fallbackText).toBe('Dashboard ready');
    });

    it('records promptId on tool results when provided', async () => {
      await expectSmallDiffKept();
    });

    it('should shrink large file diff resultDisplay without mutating input', async () => {
      const largeDiff = 'd'.repeat(70_000);
      const largeOriginal = 'a'.repeat(20_000);
      const largeNew = 'b'.repeat(20_000);
      const resultDisplay: FileDiff = {
        fileName: 'large.txt',
        fileDiff: largeDiff,
        originalContent: largeOriginal,
        newContent: largeNew,
        diffStat: diffStat(largeNew.length, largeOriginal.length),
      };

      const savedDisplay = (
        await recordTool(...successResult('write_file', 'ok', resultDisplay))
      ).toolCallResult?.resultDisplay as FileDiff;

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
      expect(inputMutated()).toBe(true);
    });

    it('should continue stripping nested tool calls from task execution results', async () => {
      const record = await recordTool(
        ...successResult('task', 'ok', {
          type: 'task_execution',
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
        }),
      );

      expect(record.toolCallResult?.resultDisplay).toMatchObject({
        type: 'task_execution',
        toolCalls: [],
      });
      expect(inputMutated()).toBe(true);
    });

    it('should chain tool result correctly with parentUuid', async () => {
      turn('Hello', 'Using tool');
      svc.recordToolResult([fnResponse('shell', { output: 'done' }, 'call-1')]);
      const [userRecord, assistantRecord, toolResultRecord] =
        await flushedAll();
      expect(userRecord.parentUuid).toBeNull();
      expect(assistantRecord.parentUuid).toBe(userRecord.uuid);
      expect(toolResultRecord.parentUuid).toBe(assistantRecord.uuid);
    });
  });

  describe('recordSlashCommand', () => {
    it('should record slash command with payload and subtype', async () => {
      svc.recordSlashCommand({ phase: 'invocation', rawCommand: '/about' });
      const record = await flushed();

      expect(jsonl.writeLine).toHaveBeenCalledTimes(1);
      expect(record.type).toBe('system');
      expect(record.subtype).toBe('slash_command');
      expect(record.systemPayload).toMatchObject({
        phase: 'invocation',
        rawCommand: '/about',
      });
    });

    it('should chain slash command after prior records', async () => {
      user('Hello');
      svc.recordSlashCommand({ phase: 'result', rawCommand: '/about' });
      const [userRecord, slashRecord] = await flushedAll();
      expect(userRecord.parentUuid).toBeNull();
      expect(slashRecord.parentUuid).toBe(userRecord.uuid);
    });
  });

  describe('flush', () => {
    const withListener = (
      listener: ConstructorParameters<typeof ChatRecordingService>[1],
    ) => activateRecording(new ChatRecordingService(mockConfig, listener));

    it('resolves immediately on a service with no enqueued writes', async () => {
      // The writeChain starts as Promise.resolve(), so flush() on a fresh
      // service settles in one microtask: Config.shutdown awaits flush on
      // every exit path, even for sessions that never recorded anything.
      await expect(svc.flush()).resolves.toBeUndefined();
      expect(jsonl.writeLine).not.toHaveBeenCalled();
    });

    it('permanently stops recording after a failed write', async () => {
      const writeError = new Error('simulated EACCES');
      vi.mocked(jsonl.writeLine).mockRejectedValueOnce(writeError);
      user('first');
      user('second');
      await expect(svc.flush()).rejects.toBe(writeError);

      expect(jsonl.writeLine).toHaveBeenCalledTimes(1);

      reply('third');
      expect(jsonl.writeLine).toHaveBeenCalledTimes(1);
      await expect(svc.flush()).rejects.toBe(writeError);
      expect(jsonl.writeLine).toHaveBeenCalledTimes(1);
    });

    it('scopes a write failure to the recorder instance', async () => {
      vi.mocked(jsonl.writeLine)
        .mockRejectedValueOnce(new Error('disk full'))
        .mockResolvedValue(undefined);
      user('first');
      await expect(svc.flush()).rejects.toThrow('disk full');

      const next = activateRecording(new ChatRecordingService(mockConfig));
      next.recordUserMessage([{ text: 'new session' }]);
      await expect(next.flush()).resolves.toBeUndefined();

      expect(jsonl.writeLine).toHaveBeenCalledTimes(2);
    });

    it('normalizes a non-Error rejection and keeps it sticky', async () => {
      vi.mocked(jsonl.writeLine).mockRejectedValueOnce('disk full');
      user('first');

      let firstFailure: unknown;
      try {
        await svc.flush();
      } catch (error) {
        firstFailure = error;
      }
      expect(firstFailure).toEqual(new Error('disk full'));
      await expect(svc.flush()).rejects.toBe(firstFailure);
    });

    it('notifies once with the failed record session id', async () => {
      const write = deferred();
      vi.mocked(jsonl.writeLine).mockReturnValueOnce(write.promise);
      const listener = vi.fn();
      const service = withListener(listener);

      service.recordUserMessage([{ text: 'first' }]);
      service.recordUserMessage([{ text: 'queued descendant' }]);
      vi.mocked(mockConfig.getSessionId).mockReturnValue('new-session-id');
      const writeError = new Error('disk full');
      write.reject(writeError);

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

      const first = withListener(firstListener);
      first.recordUserMessage([{ text: 'first' }]);
      await expect(first.flush()).rejects.toThrow('first failure');

      const second = withListener(secondListener);
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
        const syncFailure = withListener(() => {
          throw new Error('listener threw');
        });
        vi.mocked(jsonl.writeLine).mockRejectedValueOnce(
          new Error('sync observer write failure'),
        );
        syncFailure.recordUserMessage([{ text: 'first' }]);
        await expect(syncFailure.flush()).rejects.toThrow(
          'sync observer write failure',
        );

        const asyncFailure = withListener(async () => {
          throw new Error('listener rejected');
        });
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
      await recordModelFresh(svc);
      expect(jsonl.writeLine).toHaveBeenCalledOnce();
      expect(written()).toMatchObject({
        type: 'system',
        subtype: 'session_model',
        systemPayload: { modelId: 'qwen3-coder-plus', authType: 'openai' },
      });

      await recordModelFresh(svc);
      expect(jsonl.writeLine).not.toHaveBeenCalled();
    });

    it('writes a new record when the model changes', async () => {
      await recordModel();
      await recordModelFresh(svc, modelPayload('qwen3-coder-flash'));
      expect(jsonl.writeLine).toHaveBeenCalledOnce();
    });

    it('canonicalizes a runtime-prefixed modelId before writing', async () => {
      const prefixed = () =>
        modelPayload('$runtime|openai|custom-runtime', { isRuntime: true });
      await recordModelFresh(svc, prefixed());
      expect(written().systemPayload).toEqual({
        modelId: 'custom-runtime',
        authType: 'openai',
        isRuntime: true,
      });

      await recordModelFresh(svc, prefixed());
      expect(jsonl.writeLine).not.toHaveBeenCalled();
    });

    it('re-anchors the live session model onto the rewind branch', async () => {
      user('first');
      await recordModel();
      user('second');
      await recordModel('qwen3-coder-flash');
      vi.mocked(jsonl.writeLine).mockClear();

      svc.rewindRecording(1, { truncatedCount: 1 });
      const records = await flushedAll();
      expect(subtypes(records)).toEqual(['rewind', 'session_model']);
      expect(records[1]?.parentUuid).toBe(records[0]?.uuid);
      expect(records[1]?.systemPayload).toEqual({
        modelId: 'qwen3-coder-flash',
        authType: 'openai',
      });

      await recordModelFresh(svc, modelPayload('qwen3-coder-flash'));
      expect(jsonl.writeLine).not.toHaveBeenCalled();
    });

    it('writes a second record when only the isRuntime flag differs', async () => {
      await recordModel();
      await recordModelFresh(svc, modelPayload(undefined, { isRuntime: true }));
      expect(jsonl.writeLine).toHaveBeenCalledOnce();
      expect(written().systemPayload).toEqual({
        modelId: 'qwen3-coder-plus',
        authType: 'openai',
        isRuntime: true,
      });
    });

    it('writes a new record when only the baseUrl differs', async () => {
      await recordModel(undefined, { baseUrl: 'https://a.example/v1' });
      await recordModelFresh(
        svc,
        modelPayload(undefined, { baseUrl: 'https://b.example/v1' }),
      );
      expect(jsonl.writeLine).toHaveBeenCalledOnce();
    });

    it('skips a payload identical on the isRuntime and baseUrl dimensions', async () => {
      const both = () =>
        modelPayload(undefined, {
          baseUrl: 'https://a.example/v1',
          isRuntime: true,
        });
      await svc.recordSessionModel(both());
      await recordModelFresh(svc, both());
      expect(jsonl.writeLine).not.toHaveBeenCalled();
    });

    it('re-anchors the pending new binding when a rewind lands mid-write', async () => {
      user('first');
      await recordModel();
      user('second');

      // Hold the next session_model write at the IO layer so the rewind
      // lands inside the pending-write window.
      vi.mocked(jsonl.writeLine).mockClear();
      const held = holdNext(vi.mocked(jsonl.writeLine));
      const pendingSwitch = recordModel('qwen3-coder-flash');
      await vi.waitFor(() => {
        expect(vi.mocked(jsonl.writeLine).mock.calls.length).toBe(1);
      });

      svc.rewindRecording(1, { truncatedCount: 1 });
      held.resolve?.();
      await pendingSwitch;
      const records = await flushedAll();
      const rewindIndex = records.findIndex(
        (record) => record.subtype === 'rewind',
      );
      expect(rewindIndex).toBeGreaterThanOrEqual(0);
      const reAppended = records[rewindIndex + 1];
      expect(reAppended?.subtype).toBe('session_model');
      expect(reAppended?.parentUuid).toBe(records[rewindIndex]?.uuid);
      expect(reAppended?.systemPayload).toEqual({
        modelId: 'qwen3-coder-flash',
        authType: 'openai',
      });
    });
  });

  describe('recordSessionApprovalMode', () => {
    it('appends normalized approval state and skips identical payloads', async () => {
      vi.mocked(jsonl.writeLine).mockClear();
      await expect(
        svc.recordSessionApprovalMode({
          mode: ApprovalMode.PLAN,
        }),
      ).resolves.toBe(true);

      const record = vi.mocked(jsonl.writeLine).mock.calls[0][1] as ChatRecord;
      expect(record).toMatchObject({
        type: 'system',
        subtype: 'session_approval_mode',
        systemPayload: {
          mode: ApprovalMode.PLAN,
          prePlanMode: ApprovalMode.DEFAULT,
        },
      });

      vi.mocked(jsonl.writeLine).mockClear();
      await expect(
        svc.recordSessionApprovalMode({
          mode: ApprovalMode.PLAN,
          prePlanMode: ApprovalMode.DEFAULT,
        }),
      ).resolves.toBe(true);
      expect(jsonl.writeLine).not.toHaveBeenCalled();

      await expect(
        svc.recordSessionApprovalMode({
          mode: ApprovalMode.PLAN,
          prePlanMode: ApprovalMode.DEFAULT,
          planExecutionMode: ApprovalMode.YOLO,
        }),
      ).resolves.toBe(true);
      expect(jsonl.writeLine).toHaveBeenCalledOnce();
      expect(
        (vi.mocked(jsonl.writeLine).mock.calls[0][1] as ChatRecord)
          .systemPayload,
      ).toEqual({
        mode: ApprovalMode.PLAN,
        prePlanMode: ApprovalMode.DEFAULT,
        planExecutionMode: ApprovalMode.YOLO,
      });
    });

    it('restores projected approval state for duplicate suppression', async () => {
      const service = new ChatRecordingService(mockConfig, undefined, false, {
        lastCompletedUuid: 'projected-leaf',
        turnParentUuids: [null],
        sessionApprovalMode: { mode: ApprovalMode.YOLO },
      });
      vi.mocked(jsonl.writeLine).mockClear();

      await expect(
        service.recordSessionApprovalMode({ mode: ApprovalMode.YOLO }),
      ).resolves.toBe(true);
      expect(jsonl.writeLine).not.toHaveBeenCalled();
    });

    it('restores approval state from a full-record replay', async () => {
      vi.mocked(mockConfig.getResumedSessionData).mockReturnValue({
        conversation: {
          messages: [
            {
              uuid: 'approval-1',
              parentUuid: null,
              sessionId: 'test-session-id',
              timestamp: '2026-08-31T00:00:00.000Z',
              type: 'system',
              subtype: 'session_approval_mode',
              cwd: '/test/project/root',
              version: '1.0.0',
              systemPayload: { mode: ApprovalMode.YOLO },
            },
          ],
        },
        lastCompletedUuid: 'approval-1',
      } as unknown as ReturnType<Config['getResumedSessionData']>);
      const service = new ChatRecordingService(mockConfig, undefined, false);
      vi.mocked(jsonl.writeLine).mockClear();

      await expect(
        service.recordSessionApprovalMode({ mode: ApprovalMode.YOLO }),
      ).resolves.toBe(true);
      expect(jsonl.writeLine).not.toHaveBeenCalled();
    });

    it('re-anchors the supplied live approval state onto the rewind branch', async () => {
      svc.recordUserMessage([{ text: 'first' }]);
      await svc.recordSessionApprovalMode({
        mode: ApprovalMode.YOLO,
      });
      svc.recordUserMessage([{ text: 'second' }]);
      await svc.flush();
      vi.mocked(jsonl.writeLine).mockClear();

      svc.rewindRecording(1, { truncatedCount: 1 }, undefined, {
        mode: ApprovalMode.DEFAULT,
      });
      await svc.flush();

      const written = vi
        .mocked(jsonl.writeLine)
        .mock.calls.map((call) => call[1] as ChatRecord);
      expect(written.map((record) => record.subtype)).toEqual([
        'rewind',
        'session_approval_mode',
      ]);
      expect(written[1]?.parentUuid).toBe(written[0]?.uuid);
      expect(written[1]?.systemPayload).toEqual({
        mode: ApprovalMode.DEFAULT,
      });
    });

    it('re-anchors a pending approval change when rewind lands mid-write', async () => {
      svc.recordUserMessage([{ text: 'first' }]);
      await svc.recordSessionApprovalMode({
        mode: ApprovalMode.DEFAULT,
      });
      svc.recordUserMessage([{ text: 'second' }]);
      await svc.flush();

      vi.mocked(jsonl.writeLine).mockClear();
      let releaseWrite: (() => void) | undefined;
      vi.mocked(jsonl.writeLine).mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            releaseWrite = resolve;
          }),
      );
      const pendingChange = svc.recordSessionApprovalMode({
        mode: ApprovalMode.YOLO,
      });
      await vi.waitFor(() => {
        expect(vi.mocked(jsonl.writeLine).mock.calls.length).toBe(1);
      });

      svc.rewindRecording(1, { truncatedCount: 1 });
      releaseWrite?.();
      await pendingChange;
      await svc.flush();

      const written = vi
        .mocked(jsonl.writeLine)
        .mock.calls.map((call) => call[1] as ChatRecord);
      const rewindIndex = written.findIndex(
        (record) => record.subtype === 'rewind',
      );
      expect(written[rewindIndex + 1]).toMatchObject({
        subtype: 'session_approval_mode',
        systemPayload: { mode: ApprovalMode.YOLO },
      });
    });

    it('retries an identical approval state after a synchronous failure', async () => {
      const writeFileSpy = vi.spyOn(fs, 'writeFileSync');
      writeFileSpy.mockImplementationOnce(() => {
        throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
      });
      const service = new ChatRecordingService(mockConfig, undefined, false);

      await expect(
        service.recordSessionApprovalMode({ mode: ApprovalMode.YOLO }),
      ).resolves.toBe(false);
      expect(jsonl.writeLine).not.toHaveBeenCalled();

      await expect(
        service.recordSessionApprovalMode({ mode: ApprovalMode.YOLO }),
      ).resolves.toBe(true);
      expect(jsonl.writeLine).toHaveBeenCalledOnce();
    });

    it('does not suppress a later mode after a failed write races a newer one', async () => {
      const service = new ChatRecordingService(mockConfig, undefined, false, {
        lastCompletedUuid: 'projected-leaf',
        turnParentUuids: [null],
        sessionApprovalMode: { mode: ApprovalMode.DEFAULT },
      });
      vi.spyOn(fs, 'writeFileSync').mockImplementationOnce(() => {
        throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
      });

      const failed = service.recordSessionApprovalMode({
        mode: ApprovalMode.YOLO,
      });
      const later = service.recordSessionApprovalMode({
        mode: ApprovalMode.PLAN,
      });
      await expect(failed).resolves.toBe(false);
      await expect(later).resolves.toBe(true);
      const writesBefore = vi.mocked(jsonl.writeLine).mock.calls.length;

      await expect(
        service.recordSessionApprovalMode({ mode: ApprovalMode.DEFAULT }),
      ).resolves.toBe(true);
      expect(vi.mocked(jsonl.writeLine).mock.calls.length).toBe(
        writesBefore + 1,
      );
    });

    it('rejects a Plan predecessor that is itself Plan', async () => {
      vi.mocked(jsonl.writeLine).mockClear();
      await expect(
        svc.recordSessionApprovalMode({
          mode: ApprovalMode.PLAN,
          prePlanMode: ApprovalMode.PLAN,
        }),
      ).resolves.toBe(false);
      expect(jsonl.writeLine).not.toHaveBeenCalled();
    });

    it('rejects Plan as its own execution mode', async () => {
      vi.mocked(jsonl.writeLine).mockClear();
      await expect(
        svc.recordSessionApprovalMode({
          mode: ApprovalMode.PLAN,
          planExecutionMode: ApprovalMode.PLAN,
        }),
      ).resolves.toBe(false);
      expect(jsonl.writeLine).not.toHaveBeenCalled();
    });

    it('ignores predecessor data on a non-Plan record', async () => {
      vi.mocked(jsonl.writeLine).mockClear();
      await expect(
        svc.recordSessionApprovalMode({
          mode: ApprovalMode.YOLO,
          prePlanMode: ApprovalMode.PLAN,
          planExecutionMode: ApprovalMode.PLAN,
        }),
      ).resolves.toBe(true);

      const record = vi.mocked(jsonl.writeLine).mock.calls[0][1] as ChatRecord;
      expect(record.systemPayload).toEqual({ mode: ApprovalMode.YOLO });
    });
  });

  describe('legacy recorder', () => {
    const activateReduced = (
      state: Parameters<ChatRecordingService['activate']>[3],
    ) => {
      const service = new ChatRecordingService(mockConfig);
      service.activate(mockLease, undefined, undefined, state);
      return service;
    };
    const channelSource = { sourceType: 'channel', sourceId: 'channel-main' };
    const leasedState = () => ({
      lastCompletedUuid: 'leased-projected-leaf',
      turnParentUuids: [null],
    });
    const throwFsError = (code: string) => () => {
      throw Object.assign(new Error(code), { code });
    };
    const failNextFileWrite = (code: string) =>
      vi.spyOn(fs, 'writeFileSync').mockImplementationOnce(throwFsError(code));

    it('reanchors session source after more than the tail window is appended', async () => {
      await expect(
        svc.recordSessionSource('channel', 'channel-main'),
      ).resolves.toBe(true);

      user('x'.repeat(65 * 1024));
      await svc.flush();

      const sourceRecords = appended().filter(
        (record) => record.subtype === 'session_source',
      );
      expect(sourceRecords).toHaveLength(2);
      expect(sourceRecords.at(-1)?.systemPayload).toEqual(channelSource);
    });

    it('reanchors a restored session source on the next append', async () => {
      const service = activateReduced({
        lastCompletedUuid: 'projected-leaf',
        turnParentUuids: [null],
        ...channelSource,
      });

      service.recordUserMessage([{ text: 'next' }]);
      await service.flush();

      const sourceRecord = appended().find(
        (record) => record.subtype === 'session_source',
      );
      expect(sourceRecord?.systemPayload).toEqual(channelSource);
    });

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

      expect(written().parentUuid).toBe('projected-leaf');
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
      const service = activateReduced(leasedState());

      service.recordUserMessage([{ text: 'next' }]);
      await service.flush();

      expect(written().parentUuid).toBe('leased-projected-leaf');
    });

    it('records the first checkpoint after activating from reduced state', async () => {
      const service = activateReduced(leasedState());
      const cursor = service.getBranchCheckpointCursor();

      service.recordUserMessage([{ text: 'next' }]);
      reply('continued answer', service);

      await expect(
        checkpoint(cursor, 'end_turn', service),
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
      failNextFileWrite('ENOSPC');
      const service = legacyRecorder();

      await expect(service.recordSessionModel(modelPayload())).resolves.toBe(
        false,
      );
      expect(jsonl.writeLine).not.toHaveBeenCalled();

      await expect(service.recordSessionModel(modelPayload())).resolves.toBe(
        true,
      );
      expect(jsonl.writeLine).toHaveBeenCalledOnce();
    });

    it('retries directory setup after a synchronous failure', async () => {
      const mkdirSpy = vi.spyOn(fs, 'mkdirSync');
      mkdirSpy.mockImplementationOnce(throwFsError('EACCES'));
      mkdirSpy.mockImplementation(() => undefined);

      const writeSpy = vi.spyOn(fs, 'writeFileSync');
      writeSpy.mockImplementationOnce(throwFsError('ENOENT'));
      writeSpy.mockImplementation(() => undefined);

      const service = legacyRecorder();
      service.recordUserMessage([{ text: 'retry me' }]);
      await expect(service.flush()).resolves.toBeUndefined();
      expect(jsonl.writeLine).not.toHaveBeenCalled();

      service.recordUserMessage([{ text: 'retry me' }]);
      await expect(service.flush()).resolves.toBeUndefined();

      expect(mkdirSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(jsonl.writeLine).toHaveBeenCalledTimes(1);
      expect(written().parentUuid).toBeNull();
    });

    it('does not notify for a synchronous conversation-file failure', () => {
      const listener = vi.fn();
      const service = new ChatRecordingService(mockConfig, listener, false);
      failNextFileWrite('EACCES');

      service.recordUserMessage([{ text: 'retry me' }]);

      expect(listener).not.toHaveBeenCalled();
      expect(jsonl.writeLine).not.toHaveBeenCalled();
    });

    it('caches successful directory setup', async () => {
      const mkdirSpy = vi
        .spyOn(fs, 'mkdirSync')
        .mockImplementation(() => undefined);
      const service = legacyRecorder();

      for (const text of ['first', 'second', 'third']) {
        service.recordUserMessage([{ text }]);
        await service.flush();
      }

      expect(mkdirSpy).toHaveBeenCalledTimes(1);
    });

    it('retries an identical attribution snapshot after a synchronous failure', async () => {
      failNextFileWrite('EACCES');
      const service = legacyRecorder();

      service.recordAttributionSnapshot(attributionSnapshot);
      await service.flush();
      expect(jsonl.writeLine).not.toHaveBeenCalled();

      service.recordAttributionSnapshot(attributionSnapshot);
      await service.flush();
      expect(jsonl.writeLine).toHaveBeenCalledTimes(1);
    });
  });

  describe('recordAttributionSnapshot', () => {
    const baseSnapshot = attributionSnapshot;
    const artifactSnapshot = () => ({
      v: 2 as const,
      sessionId: 'test-session-id',
      sequence: 2,
      recordedAt: '2026-07-04T00:00:01.000Z',
      artifacts: [],
      tombstonedIds: [],
      stickyEphemeralIds: [],
    });

    it('should write each distinct snapshot', async () => {
      svc.recordAttributionSnapshot(baseSnapshot);
      svc.recordAttributionSnapshot({ ...baseSnapshot, promptCount: 1 });
      svc.recordAttributionSnapshot({ ...baseSnapshot, promptCount: 2 });
      await svc.flush();
      expect(jsonl.writeLine).toHaveBeenCalledTimes(3);
    });

    it('refreshes the cached git branch at the attribution turn boundary', async () => {
      vi.mocked(execFileSync)
        .mockReturnValueOnce('main\n')
        .mockReturnValueOnce('feature\n');

      user('first');
      await svc.flush();
      svc.recordAttributionSnapshot({ ...baseSnapshot, promptCount: 1 });
      const [userRecord, attributionRecord] = await flushedAll();
      expect(userRecord.gitBranch).toBe('main');
      expect(attributionRecord.gitBranch).toBe('feature');
    });

    // Sessions touching many files emit a non-retry turn snapshot every
    // prompt cycle. Without dedup, identical snapshots (no edits, no
    // prompt-counter change) would re-serialize the whole attribution state
    // into the JSONL every turn, inflating session size and slowing /resume.
    it('should skip a snapshot identical to the previous write', async () => {
      svc.recordAttributionSnapshot(baseSnapshot);
      svc.recordAttributionSnapshot(baseSnapshot);
      svc.recordAttributionSnapshot(baseSnapshot);
      await svc.flush();
      expect(jsonl.writeLine).toHaveBeenCalledTimes(1);
    });

    // After rewindRecording the previous attribution snapshot lives on the
    // abandoned branch, so the dedup key must clear; otherwise the identical
    // post-rewind snapshot would be skipped and /resume on the rewound
    // session would lose all attribution state.
    it('should re-write an identical snapshot after rewindRecording', async () => {
      user('turn 1');
      svc.recordAttributionSnapshot(baseSnapshot);
      await svc.flush();
      const beforeRewind = vi.mocked(jsonl.writeLine).mock.calls.length;

      svc.rewindRecording(0, { truncatedCount: 0 });
      // Same snapshot bytes — without the rewind reset this would dedup.
      svc.recordAttributionSnapshot(baseSnapshot);
      await svc.flush();
      // 1 rewind record + 1 fresh snapshot = 2 more writes after rewind.
      expect(vi.mocked(jsonl.writeLine).mock.calls.length).toBe(
        beforeRewind + 2,
      );
    });

    it('should not retry an identical snapshot after a write failure', async () => {
      const writeError = new Error('disk full');
      vi.mocked(jsonl.writeLine).mockRejectedValueOnce(writeError);
      svc.recordAttributionSnapshot(baseSnapshot);
      await expect(svc.flush()).rejects.toBe(writeError);

      svc.recordAttributionSnapshot(baseSnapshot);
      await expect(svc.flush()).rejects.toBe(writeError);
      expect(jsonl.writeLine).toHaveBeenCalledTimes(1);
    });

    it('should handle fire-and-forget rejection while flush reports it', async () => {
      vi.mocked(jsonl.writeLine).mockRejectedValueOnce(new Error('disk full'));
      const unhandled: unknown[] = [];
      const handler = (err: unknown) => unhandled.push(err);
      process.on('unhandledRejection', handler);
      try {
        user('hi');
        await new Promise((resolve) => setImmediate(resolve));
        expect(unhandled).toHaveLength(0);
        await expect(svc.flush()).rejects.toThrow('disk full');
      } finally {
        process.off('unhandledRejection', handler);
      }
    });

    it('stops queued normal writes when a strict artifact write fails', async () => {
      const strictWrite = deferred();
      vi.mocked(jsonl.writeLine)
        .mockImplementationOnce(() => strictWrite.promise)
        .mockResolvedValue(undefined);

      const strict = svc.recordSessionArtifactEvent(artifactEvent());
      user('after strict write');
      strictWrite.reject(new Error('disk full'));

      await expect(strict).rejects.toThrow('disk full');
      await expect(svc.flush()).rejects.toThrow('disk full');
      expect(jsonl.writeLine).toHaveBeenCalledTimes(1);

      user('next message');
      await expect(
        svc.recordSessionArtifactSnapshot(artifactSnapshot()),
      ).rejects.toThrow('disk full');
      expect(jsonl.writeLine).toHaveBeenCalledTimes(1);
    });

    it('rejects strict artifact records after a previous strict write failed', async () => {
      const writeError = new Error('corrupt journal');
      vi.mocked(jsonl.writeLine)
        .mockRejectedValueOnce(writeError)
        .mockResolvedValue(undefined);

      await expect(
        svc.recordSessionArtifactEvent(artifactEvent()),
      ).rejects.toBe(writeError);
      await expect(
        svc.recordSessionArtifactSnapshot(artifactSnapshot()),
      ).rejects.toBe(writeError);
      await expect(svc.flush()).rejects.toBe(writeError);
      expect(jsonl.writeLine).toHaveBeenCalledTimes(1);
    });

    it('does not let anchor size estimation preempt a strict writer result', async () => {
      await svc.recordCustomTitle('durable-title');
      vi.mocked(jsonl.writeLine).mockClear();
      const circular: Record<string, unknown> = {};
      circular['self'] = circular;
      const payload = {
        ...artifactEvent(),
        changes: [
          { action: 'upsert', artifactId: 'artifact-1', artifact: circular },
        ],
      } as unknown as Parameters<
        ChatRecordingService['recordSessionArtifactEvent']
      >[0];

      await expect(
        svc.recordSessionArtifactEvent(payload),
      ).resolves.toBeUndefined();
      expect(jsonl.writeLine).toHaveBeenCalledOnce();
    });

    it('keeps artifact journal records out of the active conversation chain', async () => {
      user('before artifact');
      await svc.flush();

      await svc.recordSessionArtifactEvent(artifactEvent());

      user('after artifact');
      const [before, artifact, after] = await flushedAll();
      expect(artifact.parentUuid).toBe(before.uuid);
      expect(after.parentUuid).toBe(before.uuid);
      expect(after.parentUuid).not.toBe(artifact.uuid);
    });
  });

  describe('close', () => {
    /** Fails the pending append of one queued record, then closes. */
    async function closeAfterFailedDrain(options?: { handoff: true }) {
      const failure = new SessionTranscriptChangedError();
      vi.mocked(mockLease.appendJsonLine).mockRejectedValueOnce(failure);
      user('not durable');
      await expect(svc.close(options)).rejects.toBe(failure);
    }

    it('seals instead of releasing after a successful handoff drain', async () => {
      user('durable');

      await expect(svc.close({ handoff: true })).resolves.toBeUndefined();
      expect(mockLease.sealForHandoff).toHaveBeenCalledOnce();
      expect(mockLease.release).not.toHaveBeenCalled();
      expect(svc.hasWriteOwnership()).toBe(false);
    });

    it('retains ownership when a handoff drain fails', async () => {
      await closeAfterFailedDrain({ handoff: true });
      expect(mockLease.sealForHandoff).not.toHaveBeenCalled();
      expect(mockLease.release).not.toHaveBeenCalled();
      expect(svc.hasWriteOwnership()).toBe(true);
    });

    it('releases the writer lease before reporting a flush failure', async () => {
      await closeAfterFailedDrain();
      expect(mockLease.release).toHaveBeenCalledOnce();
      expect(svc.hasWriteOwnership()).toBe(false);
    });

    it('cuts off new writes synchronously and closes single-flight', async () => {
      const held = holdNext(vi.mocked(mockLease.appendJsonLine));
      user('accepted');

      const first = svc.close();
      const second = svc.close();
      user('too late');
      await Promise.resolve();
      held.resolve!();

      await expect(Promise.all([first, second])).resolves.toEqual([
        undefined,
        undefined,
      ]);
      expect(mockLease.appendJsonLine).toHaveBeenCalledTimes(1);
      expect(mockLease.release).toHaveBeenCalledTimes(1);
      expect(svc.hasWriteOwnership()).toBe(false);
    });

    it('drains a write barrier admitted before the close cutoff', async () => {
      const operation = vi.fn().mockResolvedValue('snapshot');
      const barrier = svc.runWithWriteBarrier(operation);

      const close = svc.close();

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

      await expect(svc.close()).rejects.toBe(cleanupFailure);
      expect(svc.hasWriteOwnership()).toBe(false);
    });

    it('retries release durability without reporting stale write ownership', async () => {
      const cleanupFailure = new SessionWriterUnavailableError();
      let released = false;
      let durabilityPending = false;
      Object.defineProperties(mockLease, {
        isReleased: { configurable: true, get: () => released },
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

      await expect(svc.close()).rejects.toBe(cleanupFailure);
      expect(svc.hasWriteOwnership()).toBe(false);

      await expect(svc.close()).resolves.toBeUndefined();
      expect(mockLease.release).toHaveBeenCalledTimes(2);
      expect(svc.hasWriteOwnership()).toBe(false);
    });
  });

  // Session management tests (listSessions, loadSession, deleteSession, etc.)
  // live in sessionService.test.ts; resume integration tests should go
  // through a SessionService mock.
});

// Bare prototype instances: no lease, config or constructor state; `stubs`
// replace the record plumbing, and appended records are collected.
const bareRecorder = () =>
  Object.create(ChatRecordingService.prototype) as ChatRecordingService;
function stubRecorder(type: string, stubs: object) {
  const service = bareRecorder();
  const appended: unknown[] = [];
  Object.assign(service, {
    createBaseRecord: () => ({ type }),
    appendRecord: (record: unknown) => appended.push(record),
    ...stubs,
  });
  return { service, appended };
}

describe('Goal turn token ledger', () => {
  const assistantRecorder = () =>
    stubRecorder('assistant', { maybeTriggerAutoTitle: () => {} });
  function tokenAccumulator() {
    const service = bareRecorder();
    type Accumulate = (
      turnId: string,
      usage: { totalTokenCount?: number },
    ) => void;
    const accumulate = (
      service as unknown as { accumulateGoalTurnTokens: Accumulate }
    ).accumulateGoalTurnTokens.bind(service);
    return { service, accumulate };
  }

  it('shares external spend with assistant usage and consumes each turn once', () => {
    const { service } = assistantRecorder();
    service.billGoalTurnTokens('turn-1', 30);
    service.recordAssistantTurn({
      model: 'qwen',
      tokens: { totalTokenCount: 70 },
      goalContext: goalPermit('turn-1'),
    });
    for (const tokens of [NaN, Infinity, -1, 0])
      service.billGoalTurnTokens('turn-2', tokens);
    expect(service.takeGoalTurnTokens('turn-2')).toBe(0);
    expect(service.takeGoalTurnTokens('turn-1')).toBe(100);
    expect(service.takeGoalTurnTokens('turn-1')).toBe(0);
    service.billGoalTurnTokens('turn-1', 10);
    service.billGoalTurnTokens('turn-2', 20);
    expect(service.takeGoalTurnTokens('turn-1')).toBe(0);
    expect(service.takeGoalTurnTokens('turn-2')).toBe(20);
  });

  it('bills a Goal turn from the assistant records it produced', () => {
    // The wiring that matters: recordAssistantTurn must feed the ledger. A
    // ledger that is never fed reports every Goal turn as free.
    const { service, appended } = assistantRecorder();
    const goalContext = goalPermit('turn-1');
    const bill = (totalTokenCount: number, context?: GoalTurnPermit) =>
      service.recordAssistantTurn({
        model: 'qwen',
        tokens: { totalTokenCount },
        ...(context ? { goalContext: context } : {}),
      });

    bill(900, goalContext);
    bill(100, goalContext);
    // A record with no Goal permit belongs to no Goal turn.
    bill(5_000);

    expect(appended).toHaveLength(3);
    expect(service.takeGoalTurnTokens('turn-1')).toBe(1_000);
  });

  it("sums a turn's usage and hands it over once", () => {
    const { service, accumulate } = tokenAccumulator();

    accumulate('turn-1', { totalTokenCount: 1_000 });
    accumulate('turn-1', { totalTokenCount: 250 });

    expect(service.takeGoalTurnTokens('turn-1')).toBe(1_250);
    // Consumed: a turn is billed once.
    expect(service.takeGoalTurnTokens('turn-1')).toBe(0);
  });

  it("does not bill one turn for another turn's usage", () => {
    const { service, accumulate } = tokenAccumulator();

    accumulate('turn-1', { totalTokenCount: 1_000 });
    // A record stamped with the next turn ends the previous one.
    accumulate('turn-2', { totalTokenCount: 40 });

    expect(service.takeGoalTurnTokens('turn-1')).toBe(0);
    expect(service.takeGoalTurnTokens('turn-2')).toBe(40);
  });

  it('ignores usage with no usable total', () => {
    const { service, accumulate } = tokenAccumulator();

    accumulate('turn-1', {});
    accumulate('turn-1', { totalTokenCount: Number.NaN });
    accumulate('turn-1', { totalTokenCount: -5 });

    expect(service.takeGoalTurnTokens('turn-1')).toBe(0);
  });
});

describe('Goal turn tool result ledger', () => {
  const permit = goalPermit('turn-1');

  function recorderForToolResults() {
    const { service, appended } = stubRecorder('tool_result', {
      getSessionId: () => 'session-1',
    });
    const record = (
      options?: Parameters<ChatRecordingService['recordToolResult']>[2],
    ) =>
      service.recordToolResult(
        [
          {
            functionResponse: { id: 'call-1', name: 'run_shell', response: {} },
          },
        ],
        undefined,
        options,
      );
    return { service, appended, record };
  }

  it('counts the evidence-bearing tool results a Goal turn recorded', () => {
    // The wiring that matters: recordToolResult must feed the ledger, or the
    // no-progress bound reads every turn as idle.
    const { service, appended, record } = recorderForToolResults();

    record({ goalContext: permit });
    record({ goalContext: permit });
    // A result outside a Goal turn belongs to no turn.
    record();

    expect(appended).toHaveLength(3);
    expect(service.takeGoalTurnToolResults('turn-1')).toBe(2);
    // Consumed: a turn is counted once.
    expect(service.takeGoalTurnToolResults('turn-1')).toBe(0);
  });

  it('does not count the Goal runtime talking to itself', () => {
    // `get_goal` and `update_goal` results are recorded under the permit but
    // are not evidence: a turn that only reads its own state is exactly the
    // idling the count exists to notice.
    const { service, record } = recorderForToolResults();

    record({ goalContext: permit, provenance: 'goal_runtime' });

    expect(service.takeGoalTurnToolResults('turn-1')).toBe(0);
  });

  it("does not credit one turn with another turn's results", () => {
    const { service, record } = recorderForToolResults();

    record({ goalContext: permit });
    record({ goalContext: { ...permit, turnId: 'turn-2' } });

    expect(service.takeGoalTurnToolResults('turn-1')).toBe(0);
    expect(service.takeGoalTurnToolResults('turn-2')).toBe(1);
  });
});
