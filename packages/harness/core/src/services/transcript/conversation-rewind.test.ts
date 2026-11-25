/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  createToolResultMessage,
  createUserMessage,
} from '../../protocol/transcript/conversions.js';
import { buildSlashCommandMetadata } from '../../constants/xmlTags.js';
import type {
  Message,
  SystemMessage,
  UserMessage,
} from '../../protocol/transcript/message.js';
import type { TranscriptMessage } from '../../protocol/transcript/entry.js';
import {
  ConversationRewindError,
  executeConversationRewind,
  getRewindCandidates,
  planHistoricalConversationRewind,
  planConversationRewind,
  type ConversationRewindAdapter,
  type ConversationRewindState,
} from './conversation-rewind.js';

function user(
  uuid: string,
  content: string,
  options: Partial<UserMessage> = {},
): UserMessage {
  return {
    ...createUserMessage(content, { uuid }),
    ...options,
  };
}

function assistant(uuid: string): Message {
  return {
    type: 'assistant',
    uuid,
    timestamp: '2026-08-04T00:00:01.000Z',
    message: {
      type: 'message',
      role: 'assistant',
      stop_sequence: null,
      container: null,
      context_management: null,
      id: `provider-${uuid}`,

      model: 'test-model',
      stop_reason: 'end_turn',

      content: [{ type: 'text', text: uuid }],
    },
  };
}

function transcript(
  message: Message,
  parentUuid: string | null,
  logicalParentUuid?: string,
): TranscriptMessage {
  return {
    ...message,
    parentUuid,
    ...(logicalParentUuid ? { logicalParentUuid } : {}),
    isSidechain: false,
    cwd: '/workspace',
    sessionId: 'session-1',
    userType: 'external',
    version: '1.0.0',
  } as TranscriptMessage;
}

function state(
  messages: readonly Message[],
  overrides: Partial<ConversationRewindState> = {},
): ConversationRewindState {
  return {
    sessionId: 'session-1',
    messages,
    leafUuid: messages.at(-1)?.uuid ?? null,
    guardRevision: 1,
    ...overrides,
  };
}

function adapterFor(
  states: readonly ConversationRewindState[],
  overrides: Partial<ConversationRewindAdapter> = {},
): ConversationRewindAdapter {
  let index = 0;
  return {
    readState: vi.fn(() => states[Math.min(index++, states.length - 1)]),
    assertReady: vi.fn(),
    commit: vi.fn(),
    restore: vi.fn(),
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('getRewindCandidates', () => {
  it('uses exact snapshots for normal, slash and shell human inputs', () => {
    const normal = user('normal', 'normalized', {
      humanInput: { text: 'line 1\n  line 2', mode: 'prompt' },
    });
    const slash = user('slash', 'expanded model prompt', {
      humanInput: {
        text: '/skill   keep\nspacing',
        mode: 'prompt',
      },
    });
    const shell = user('shell', '<bash-input>npm test</bash-input>', {
      isMeta: true,
      humanInput: { text: 'npm   test', mode: 'bash' },
    });

    expect(getRewindCandidates([normal, slash, shell])).toEqual([
      expect.objectContaining({
        message: normal,
        displayText: 'line 1 line 2',
        prefillText: 'line 1\n  line 2',
        inputMode: 'prompt',
      }),
      expect.objectContaining({
        message: slash,
        displayText: '/skill keep spacing',
        prefillText: '/skill   keep\nspacing',
        inputMode: 'prompt',
      }),
      expect.objectContaining({
        message: shell,
        displayText: 'npm test',
        prefillText: 'npm   test',
        inputMode: 'bash',
      }),
    ]);
  });

  it('supports legacy human and bash messages without inventing input syntax', () => {
    const legacy = user('legacy', 'legacy\n  prompt');
    const legacyBash = user(
      'legacy-bash',
      '<bash-input>echo  two</bash-input>',
      { isMeta: true },
    );

    expect(getRewindCandidates([legacy, legacyBash])).toEqual([
      expect.objectContaining({
        message: legacy,
        displayText: 'legacy prompt',
        prefillText: 'legacy\n  prompt',
        inputMode: 'prompt',
      }),
      expect.objectContaining({
        message: legacyBash,
        displayText: 'echo two',
        prefillText: 'echo  two',
        inputMode: 'bash',
      }),
    ]);
  });

  it('excludes internal, non-human and content-free records', () => {
    const toolResult = createToolResultMessage(
      [
        {
          type: 'tool_result',
          tool_use_id: 'tool-1',
          content: 'done',
          is_error: false,
        },
      ],
      'assistant-1',
    );
    const textualToolResult = user('textual-tool-result', 'tool output');
    textualToolResult.toolUseResult = { result: 'done' };
    const pureImage = createUserMessage([
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'aW1n' },
      },
    ]);
    const internalSlashCommand = user(
      'internal-slash-command',
      buildSlashCommandMetadata('rewind'),
    );
    const excluded: Message[] = [
      toolResult,
      textualToolResult,
      user('task', 'task', { origin: { kind: 'task-notification' } }),
      user('bridge', 'bridge', { origin: { kind: 'bridge' } }),
      user('compact', 'summary', { isCompactSummary: true }),
      user('transcript-only', 'hidden', {
        isVisibleInTranscriptOnly: true,
      }),
      user('sub-agent', 'delegated', { parent_tool_use_id: 'tool-1' }),
      user('agent', 'agent', { agentId: 'agent-1' }),
      user('meta', 'internal', { isMeta: true }),
      internalSlashCommand,
      pureImage,
      {
        type: 'attachment',
        uuid: 'queued',
        timestamp: '2026-08-04T00:00:00.000Z',
        attachment: { type: 'queued_command', prompt: 'not executed' },
      },
    ];

    expect(getRewindCandidates(excluded)).toEqual([]);
  });
});

describe('planConversationRewind', () => {
  it('retains messages strictly before the selected human turn', () => {
    const userA = user('user-a', 'A', {
      humanInput: { text: 'A', mode: 'prompt' },
    });
    const assistantA = assistant('assistant-a');
    const userB = user('user-b', 'expanded B', {
      humanInput: { text: 'B  exact', mode: 'prompt' },
    });
    const assistantB = assistant('assistant-b');

    const plan = planConversationRewind(
      [userA, assistantA, userB, assistantB],
      userB.uuid,
    );

    expect(plan.retainedMessages).toEqual([userA, assistantA]);
    expect(plan.retainedLeafUuid).toBe(assistantA.uuid);
    expect(plan.removedMessageIds).toEqual([userB.uuid, assistantB.uuid]);
    expect(plan.target.prefillText).toBe('B  exact');
  });

  it('uses an explicit null leaf when rewinding the first user turn', () => {
    const first = user('first', 'first');

    expect(
      planConversationRewind([first, assistant('reply')], first.uuid),
    ).toMatchObject({ retainedMessages: [], retainedLeafUuid: null });
  });

  it('rejects unknown and excluded targets', () => {
    const internal = user('internal', 'hidden', { isMeta: true });

    for (const targetUuid of ['missing', internal.uuid]) {
      expect(() => planConversationRewind([internal], targetUuid)).toThrowError(
        expect.objectContaining({ code: 'target-not-found' }),
      );
    }
  });
});

describe('planHistoricalConversationRewind', () => {
  const oldUser = user('old-user', 'old');
  const oldAssistant = assistant('old-assistant');
  const boundary: SystemMessage = {
    type: 'system',
    uuid: 'boundary',
    timestamp: '2026-08-04T00:00:02.000Z',
    subtype: 'compact_boundary',
    content: 'Conversation compacted',
    level: 'info',
    isCompactSummary: true,
  };
  const summary = user('summary', 'summary', { isCompactSummary: true });
  const postAssistant = assistant('post-assistant');
  const postUser = user('post-user', 'post', {
    humanInput: { text: 'post exact', mode: 'prompt' },
  });
  const lineage = [
    transcript(oldUser, null),
    transcript(oldAssistant, oldUser.uuid),
    transcript(boundary, null, oldAssistant.uuid),
    transcript(summary, boundary.uuid),
    transcript(postAssistant, summary.uuid),
    transcript(postUser, postAssistant.uuid),
  ];

  it('uses the raw parent chain when rewinding before Compact Boundary', () => {
    const plan = planHistoricalConversationRewind(lineage, oldUser.uuid);

    expect(plan.retainedMessages).toEqual([]);
    expect(plan.retainedLeafUuid).toBeNull();
    expect(plan.removedMessageIds).toEqual([
      oldUser.uuid,
      oldAssistant.uuid,
      postAssistant.uuid,
      postUser.uuid,
    ]);
  });

  it('keeps the compact runtime prefix when rewinding after Compact Boundary', () => {
    const plan = planHistoricalConversationRewind(lineage, postUser.uuid);

    expect(plan.retainedMessages.map((message) => message.uuid)).toEqual([
      boundary.uuid,
      summary.uuid,
      postAssistant.uuid,
    ]);
    expect(plan.retainedLeafUuid).toBe(postAssistant.uuid);
    expect(plan.removedMessageIds).toEqual([postUser.uuid]);
    expect(plan.target.prefillText).toBe('post exact');
  });
});

describe('executeConversationRewind', () => {
  const userA = user('user-a', 'A');
  const assistantA = assistant('assistant-a');
  const userB = user('user-b', 'B');
  const messages = [userA, assistantA, userB];
  const before = state(messages, { leafUuid: userB.uuid });

  it('persists the new leaf before committing runtime state', async () => {
    const marker = deferred<void>();
    const writer = { recordActiveLeaf: vi.fn(() => marker.promise) };
    const adapter = adapterFor([before, before, before]);

    const pending = executeConversationRewind({
      targetUuid: userB.uuid,
      writer,
      adapter,
    });
    await vi.waitFor(() => expect(writer.recordActiveLeaf).toHaveBeenCalled());
    expect(adapter.commit).not.toHaveBeenCalled();

    marker.resolve();
    const plan = await pending;

    expect(adapter.commit).toHaveBeenCalledWith(plan);
    expect(writer.recordActiveLeaf).toHaveBeenCalledWith(assistantA.uuid, {
      explicit: true,
      rewound: true,
      durable: true,
    });
  });

  it('reports a successful rewind with target correlation and message counts', async () => {
    const target = user('user-task-b', 'B', { requestSetId: 'task-b' });
    const currentMessages = [userA, assistantA, target];
    const currentState = state(currentMessages, { leafUuid: target.uuid });
    const writer = { recordActiveLeaf: vi.fn().mockResolvedValue(undefined) };
    const adapter = adapterFor([currentState, currentState, currentState]);
    const onOutcome = vi.fn();

    await executeConversationRewind({
      targetUuid: target.uuid,
      writer,
      adapter,
      onOutcome,
    });

    expect(onOutcome).toHaveBeenCalledWith({
      rewindId: expect.any(String),
      targetMessageId: target.uuid,
      targetTaskId: 'task-b',
      preMessageCount: 3,
      postMessageCount: 2,
      outcome: 'success',
    });
  });

  it('reports a failed rewind with a normalized error code', async () => {
    const writer = { recordActiveLeaf: vi.fn() };
    const adapter = adapterFor([before]);
    const onOutcome = vi.fn();

    await expect(
      executeConversationRewind({
        targetUuid: 'missing',
        writer,
        adapter,
        onOutcome,
      }),
    ).rejects.toMatchObject({ code: 'target-not-found' });

    expect(onOutcome).toHaveBeenCalledWith({
      rewindId: expect.any(String),
      targetMessageId: 'missing',
      targetTaskId: undefined,
      preMessageCount: 3,
      outcome: 'failed',
      errorCode: 'target-not-found',
    });
  });

  it('reports not-ready when no transcript writer is available', async () => {
    const onOutcome = vi.fn();

    await expect(
      executeConversationRewind({
        targetUuid: userB.uuid,
        writer: undefined,
        adapter: adapterFor([before]),
        onOutcome,
      }),
    ).rejects.toMatchObject({ code: 'not-ready' });
    expect(onOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        targetMessageId: userB.uuid,
        outcome: 'failed',
        errorCode: 'not-ready',
      }),
    );
  });

  it('does not fail the rewind when outcome reporting fails', async () => {
    const writer = { recordActiveLeaf: vi.fn().mockResolvedValue(undefined) };
    const adapter = adapterFor([before, before, before]);

    await expect(
      executeConversationRewind({
        targetUuid: userB.uuid,
        writer,
        adapter,
        onOutcome: () => {
          throw new Error('outcome failed');
        },
      }),
    ).resolves.toBeDefined();
  });

  it('does not commit or restore when initial persistence fails', async () => {
    const writer = {
      recordActiveLeaf: vi.fn().mockRejectedValue(new Error('disk failed')),
    };
    const adapter = adapterFor([before, before]);

    await expect(
      executeConversationRewind({ targetUuid: userB.uuid, writer, adapter }),
    ).rejects.toMatchObject({ code: 'persistence-failed' });
    expect(adapter.commit).not.toHaveBeenCalled();
    expect(adapter.restore).not.toHaveBeenCalled();
  });

  it('writes no marker when state changes before persistence', async () => {
    const changed = state(messages, { guardRevision: 2 });
    const writer = { recordActiveLeaf: vi.fn() };
    const adapter = adapterFor([before, changed]);

    await expect(
      executeConversationRewind({ targetUuid: userB.uuid, writer, adapter }),
    ).rejects.toMatchObject({ code: 'state-changed' });
    expect(writer.recordActiveLeaf).not.toHaveBeenCalled();
  });

  it('compensates to the old leaf when state changes after persistence', async () => {
    const changed = state(messages, { guardRevision: 2 });
    const writer = { recordActiveLeaf: vi.fn().mockResolvedValue(undefined) };
    const adapter = adapterFor([before, before, changed]);

    await expect(
      executeConversationRewind({ targetUuid: userB.uuid, writer, adapter }),
    ).rejects.toMatchObject({ code: 'state-changed' });

    expect(writer.recordActiveLeaf.mock.calls).toEqual([
      [assistantA.uuid, { explicit: true, rewound: true, durable: true }],
      [userB.uuid, { explicit: true, rewound: false, durable: true }],
    ]);
    expect(adapter.commit).not.toHaveBeenCalled();
    expect(adapter.restore).toHaveBeenCalledOnce();
  });

  it('restores runtime state and compensates when commit throws', async () => {
    const writer = { recordActiveLeaf: vi.fn().mockResolvedValue(undefined) };
    const adapter = adapterFor([before, before, before], {
      commit: vi.fn(() => {
        throw new Error('commit failed');
      }),
    });

    await expect(
      executeConversationRewind({ targetUuid: userB.uuid, writer, adapter }),
    ).rejects.toBeInstanceOf(ConversationRewindError);
    expect(adapter.restore).toHaveBeenCalledOnce();
    expect(writer.recordActiveLeaf).toHaveBeenLastCalledWith(userB.uuid, {
      explicit: true,
      rewound: false,
      durable: true,
    });
  });

  it('reports compensation failure with both original and compensation causes', async () => {
    const commitError = new Error('commit failed');
    const compensationError = new Error('compensation failed');
    const writer = {
      recordActiveLeaf: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(compensationError),
    };
    const adapter = adapterFor([before, before, before], {
      commit: vi.fn(() => {
        throw commitError;
      }),
    });

    await expect(
      executeConversationRewind({ targetUuid: userB.uuid, writer, adapter }),
    ).rejects.toMatchObject({
      code: 'compensation-failed',
      cause: commitError,
      compensationCause: compensationError,
    });
  });
});
