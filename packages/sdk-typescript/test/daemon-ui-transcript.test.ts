import { describe, expect, it } from 'vitest';
import {
  createDaemonTranscriptState,
  reduceDaemonTranscriptEvents,
  selectUnrecognizedDiagnostics,
  UNRECOGNIZED_DIAGNOSTICS_LIMIT,
} from '../src/daemon/ui/transcript.js';
import type { DaemonUiEvent } from '../src/daemon/ui/types.js';
import { matchTurnEvent } from '../src/daemon/DaemonClient.js';

describe('daemon transcript rewind', () => {
  it('drops the target user turn and later transcript blocks', () => {
    const events: DaemonUiEvent[] = [
      { type: 'user.text.delta', text: 'first' },
      { type: 'assistant.text.delta', text: 'first answer' },
      { type: 'assistant.done' },
      { type: 'user.text.delta', text: 'second' },
      { type: 'assistant.text.delta', text: 'second answer' },
      { type: 'assistant.done' },
      {
        type: 'session.rewound',
        promptId: 'session########1',
        targetTurnIndex: 1,
      },
    ];

    const state = reduceDaemonTranscriptEvents(
      createDaemonTranscriptState({ now: 1 }),
      events,
      { now: 1 },
    );

    expect(state.blocks.map((block) => block.kind)).toEqual([
      'user',
      'assistant',
    ]);
    expect(
      state.blocks.map((block) => ('text' in block ? block.text : '')),
    ).toEqual(['first', 'first answer']);
    expect(state.activeUserBlockId).toBeUndefined();
    expect(state.activeAssistantBlockId).toBeUndefined();
  });

  it('preserves earlier background notifications and replies when rewinding a user turn', () => {
    const retainedEvents: DaemonUiEvent[] = [
      { type: 'user.text.delta', text: 'review' },
      { type: 'assistant.text.delta', text: 'review conclusion' },
      { type: 'assistant.done' },
      {
        type: 'user.text.delta',
        text: 'typecheck completed',
        meta: { source: 'background_notification', qwenDiscreteMessage: true },
      },
      { type: 'assistant.text.delta', text: 'typecheck confirmed' },
      { type: 'assistant.done' },
      {
        type: 'user.text.delta',
        text: 'tests completed',
        meta: { source: 'background_notification', qwenDiscreteMessage: true },
      },
      { type: 'assistant.text.delta', text: '943 tests passed' },
      { type: 'assistant.done' },
    ];
    const replayed = reduceDaemonTranscriptEvents(
      createDaemonTranscriptState({ now: 1 }),
      retainedEvents,
      { now: 1 },
    );
    expect(replayed.blocks).toHaveLength(6);

    const rewound = reduceDaemonTranscriptEvents(
      createDaemonTranscriptState({ now: 1 }),
      [
        ...retainedEvents,
        { type: 'user.text.delta', text: 'hello' },
        { type: 'assistant.text.delta', text: 'hello answer' },
        { type: 'assistant.done' },
        {
          type: 'session.rewound',
          promptId: 'session########1',
          targetTurnIndex: 1,
        },
      ],
      { now: 1 },
    );

    expect(rewound.blocks).toEqual(replayed.blocks);
    expect(rewound.activeUserBlockId).toBeUndefined();
    expect(rewound.activeAssistantBlockId).toBeUndefined();
  });

  it('preserves the unrecognized diagnostics sidechannel on rewind (#8823)', () => {
    // Diagnostics have no per-turn association to prune by. Keep the bounded
    // sidechannel intact instead of dropping retained-turn forward-compat
    // signals.
    const turnEvents: DaemonUiEvent[] = [
      { type: 'user.text.delta', text: 'first' },
      {
        type: 'debug',
        debugReason: 'unrecognized_event',
        text: 'future frame during the retained turn',
      },
      { type: 'assistant.text.delta', text: 'first answer' },
      { type: 'assistant.done' },
      { type: 'user.text.delta', text: 'second' },
      {
        type: 'debug',
        debugReason: 'unrecognized_event',
        text: 'future frame during the erased turn',
      },
    ];

    const beforeRewind = reduceDaemonTranscriptEvents(
      createDaemonTranscriptState({ now: 1 }),
      turnEvents,
      { now: 1 },
    );
    expect(beforeRewind.unrecognizedDiagnostics).toHaveLength(2);

    const state = reduceDaemonTranscriptEvents(
      createDaemonTranscriptState({ now: 1 }),
      [
        ...turnEvents,
        {
          type: 'session.rewound',
          promptId: 'session########1',
          targetTurnIndex: 1,
        },
      ],
      { now: 1 },
    );

    expect(state.blocks.map((block) => block.kind)).toEqual([
      'user',
      'assistant',
    ]);
    expect(state.unrecognizedDiagnostics.map((entry) => entry.text)).toEqual([
      'future frame during the retained turn',
      'future frame during the erased turn',
    ]);
  });

  it('attaches a completed-turn branch anchor to the active Assistant block', () => {
    const state = reduceDaemonTranscriptEvents(
      createDaemonTranscriptState({ now: 1 }),
      [
        {
          type: 'assistant.text.delta',
          text: 'answer',
          promptId: 'prompt-1',
        },
        {
          type: 'assistant.done',
          reason: 'end_turn',
          promptId: 'prompt-1',
          sourceRecordIds: ['assistant-record'],
          branchRecordId: 'checkpoint-record',
        },
      ],
      { now: 1 },
    );

    expect(state.blocks[0]).toMatchObject({
      kind: 'assistant',
      promptId: 'prompt-1',
      sourceRecordIds: ['assistant-record'],
      branchRecordId: 'checkpoint-record',
    });
  });

  it('attaches a branch anchor after a passive observer completion', () => {
    const state = reduceDaemonTranscriptEvents(
      createDaemonTranscriptState({ now: 1 }),
      [
        {
          type: 'assistant.text.delta',
          text: 'answer',
          promptId: 'prompt-1',
        },
        {
          type: 'assistant.done',
          reason: 'passive_observer',
          promptId: 'prompt-1',
        },
        {
          type: 'assistant.done',
          reason: 'end_turn',
          promptId: 'prompt-1',
          sourceRecordIds: ['assistant-record'],
          branchRecordId: 'checkpoint-record',
        },
      ],
      { now: 1 },
    );

    expect(state.blocks[0]).toMatchObject({
      kind: 'assistant',
      promptId: 'prompt-1',
      branchRecordId: 'checkpoint-record',
    });
  });

  it('does not attach a branch anchor when the completed prompt differs', () => {
    const state = reduceDaemonTranscriptEvents(
      createDaemonTranscriptState({ now: 1 }),
      [
        {
          type: 'assistant.text.delta',
          text: 'answer',
          promptId: 'prompt-1',
        },
        {
          type: 'assistant.done',
          reason: 'end_turn',
          promptId: 'prompt-2',
          sourceRecordIds: ['assistant-record'],
          branchRecordId: 'checkpoint-record',
        },
      ],
      { now: 1 },
    );

    expect(state.blocks[0]).not.toHaveProperty('branchRecordId');
  });

  it('does not attach a branch anchor to an errored Assistant block', () => {
    const state = reduceDaemonTranscriptEvents(
      createDaemonTranscriptState({ now: 1 }),
      [
        {
          type: 'assistant.text.delta',
          text: 'partial answer',
          promptId: 'prompt-1',
        },
        {
          type: 'assistant.done',
          reason: 'error',
          promptId: 'prompt-1',
          sourceRecordIds: ['assistant-record'],
          branchRecordId: 'checkpoint-record',
        },
      ],
      { now: 1 },
    );

    expect(state.blocks[0]).not.toHaveProperty('branchRecordId');
  });

  it('does not merge text deltas with different promptIds', () => {
    const state = reduceDaemonTranscriptEvents(
      createDaemonTranscriptState({ now: 1 }),
      [
        {
          type: 'assistant.text.delta',
          text: 'first ',
          promptId: 'prompt-1',
        },
        {
          type: 'assistant.text.delta',
          text: 'second',
          promptId: 'prompt-2',
        },
      ],
      { now: 1 },
    );

    expect(state.blocks).toHaveLength(2);
    expect(state.blocks[0]).toMatchObject({
      kind: 'assistant',
      text: 'first ',
      promptId: 'prompt-1',
    });
    expect(state.blocks[1]).toMatchObject({
      kind: 'assistant',
      text: 'second',
      promptId: 'prompt-2',
    });
  });

  it('merges text deltas when one side lacks a promptId', () => {
    const state = reduceDaemonTranscriptEvents(
      createDaemonTranscriptState({ now: 1 }),
      [
        {
          type: 'assistant.text.delta',
          text: 'first ',
        },
        {
          type: 'assistant.text.delta',
          text: 'second',
          promptId: 'prompt-1',
        },
      ],
      { now: 1 },
    );

    expect(state.blocks).toHaveLength(1);
    expect(state.blocks[0]).toMatchObject({
      kind: 'assistant',
      text: 'first second',
    });
  });

  it('backfills the merged promptId so assistant.done attaches the checkpoint', () => {
    const state = reduceDaemonTranscriptEvents(
      createDaemonTranscriptState({ now: 1 }),
      [
        {
          type: 'assistant.text.delta',
          text: 'first ',
        },
        {
          type: 'assistant.text.delta',
          text: 'second',
          promptId: 'prompt-1',
        },
        {
          type: 'assistant.done',
          reason: 'end_turn',
          promptId: 'prompt-1',
          sourceRecordIds: ['assistant-record'],
          branchRecordId: 'checkpoint-record',
        },
      ],
      { now: 1 },
    );

    expect(state.blocks).toHaveLength(1);
    expect(state.blocks[0]).toMatchObject({
      kind: 'assistant',
      text: 'first second',
      promptId: 'prompt-1',
      sourceRecordIds: ['assistant-record'],
      branchRecordId: 'checkpoint-record',
    });
  });

  it('does not attach replay branch metadata to a user block', () => {
    const state = reduceDaemonTranscriptEvents(
      createDaemonTranscriptState({ now: 1 }),
      [
        {
          type: 'user.text.delta',
          text: 'question',
          branchRecordId: 'checkpoint-record',
        },
      ],
      { now: 1 },
    );

    expect(state.blocks[0]).not.toHaveProperty('branchRecordId');
  });

  it('drops malformed or non-completed branch point metadata', () => {
    for (const [stopReason, assistantRecordUuid, checkpointUuid] of [
      ['end_turn', '11111111-1111-4111-8111-111111111111', 'not-a-uuid'],
      [
        'error',
        '11111111-1111-4111-8111-111111111111',
        '22222222-2222-4222-8222-222222222222',
      ],
      ['end_turn', 'not-a-uuid', '22222222-2222-4222-8222-222222222222'],
    ] as const) {
      expect(
        matchTurnEvent(
          {
            v: 1,
            type: 'turn_complete',
            data: {
              promptId: 'prompt-1',
              stopReason,
              branchPoint: {
                assistantRecordUuid,
                checkpointUuid,
              },
            },
          },
          'prompt-1',
        ),
      ).toEqual({ stopReason });
    }
  });
});

describe('status event while an assistant block is streaming', () => {
  it('finalizes the active assistant block by default', () => {
    const state = reduceDaemonTranscriptEvents(
      createDaemonTranscriptState({ now: 1 }),
      [
        { type: 'user.text.delta', text: 'question' },
        { type: 'assistant.text.delta', text: 'answering' },
        { type: 'status', text: 'mid-stream status' },
        { type: 'assistant.text.delta', text: ' more' },
        { type: 'assistant.done' },
      ],
      { now: 1 },
    );

    expect(state.blocks.map((block) => block.kind)).toEqual([
      'user',
      'assistant',
      'status',
      'assistant',
    ]);
  });

  it('keeps the assistant block active when clearActiveText is false', () => {
    const state = reduceDaemonTranscriptEvents(
      createDaemonTranscriptState({ now: 1 }),
      [
        { type: 'user.text.delta', text: 'question' },
        { type: 'assistant.text.delta', text: 'answering' },
        { type: 'status', text: 'mid-stream status', clearActiveText: false },
        { type: 'assistant.text.delta', text: ' more' },
        {
          type: 'assistant.usage',
          usage: { inputTokens: 3, outputTokens: 5 },
        },
        { type: 'assistant.done' },
      ],
      { now: 1 },
    );

    expect(state.blocks.map((block) => block.kind)).toEqual([
      'user',
      'assistant',
      'status',
    ]);
    const assistant = state.blocks[1];
    if (assistant.kind !== 'assistant') throw new Error('expected assistant');
    expect(assistant.text).toBe('answering more');
    expect(assistant.usage).toEqual({
      inputTokens: 3,
      outputTokens: 5,
      cachedTokens: 0,
    });
  });

  it('resets the active user block even when clearActiveText is false', () => {
    let state = reduceDaemonTranscriptEvents(
      createDaemonTranscriptState({ now: 1 }),
      [{ type: 'user.text.delta', text: '/stats' }],
      { now: 1 },
    );
    state = reduceDaemonTranscriptEvents(
      state,
      [{ type: 'status', text: 'stats output', clearActiveText: false }],
      { now: 1 },
    );

    expect(state.activeUserBlockId).toBeUndefined();

    // A peer client's prompt echo must open its own user block instead of
    // merging into the local command echo.
    state = reduceDaemonTranscriptEvents(
      state,
      [{ type: 'user.text.delta', text: 'fix the bug' }],
      { now: 1 },
    );

    expect(state.blocks.map((block) => block.kind)).toEqual([
      'user',
      'status',
      'user',
    ]);
    expect(
      state.blocks.map((block) => ('text' in block ? block.text : '')),
    ).toEqual(['/stats', 'stats output', 'fix the bug']);
  });
});

describe('teammate_activity status events', () => {
  const activity = (text: string, agentName?: string): DaemonUiEvent => ({
    type: 'status',
    source: 'teammate_activity',
    text,
    ...(agentName
      ? { agent: { agentName, depth: 1, kind: 'teammate' as const } }
      : {}),
    clearActiveText: false,
  });

  it('keeps one row per teammate so activity cannot evict conversation', () => {
    const events: DaemonUiEvent[] = [
      { type: 'user.text.delta', text: 'question' },
      { type: 'assistant.text.delta', text: 'answer' },
      { type: 'assistant.done' },
    ];
    for (let i = 0; i < 40; i += 1) {
      events.push(activity(`read_file #${i}`, `/root/qa-${i % 2}`));
    }

    const state = reduceDaemonTranscriptEvents(
      createDaemonTranscriptState({ now: 1, maxBlocks: 10 }),
      events,
      { now: 1, maxBlocks: 10 },
    );

    const rows = state.blocks.filter(
      (block) =>
        block.kind === 'status' && block.source === 'teammate_activity',
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((block) => ('text' in block ? block.text : ''))).toEqual([
      'read_file #38',
      'read_file #39',
    ]);
    // One block per event would spend the window on rows a reload never
    // contains, and `trimTranscriptState` evicts from the front.
    expect(state.blocks.map((block) => block.kind).slice(0, 2)).toEqual([
      'user',
      'assistant',
    ]);
  });

  it('keeps message rows distinct from each other and from tool rows', () => {
    // Keying the coalesce on `agent.agentName` alone let a message row and the
    // recipient's tool row overwrite each other; these frames are never
    // persisted, so the lost text is unrecoverable.
    const frame = (text: string, status: string): DaemonUiEvent => ({
      type: 'status',
      source: 'teammate_activity',
      text,
      data: { status },
      agent: { agentName: '/root/checker', depth: 1, kind: 'teammate' },
      clearActiveText: false,
    });

    const state = reduceDaemonTranscriptEvents(
      createDaemonTranscriptState({ now: 1 }),
      [
        frame('checker started read_file', 'call'),
        frame('writer -> checker: review the auth module', 'message'),
        frame('writer -> checker: check a different file', 'message'),
        frame('checker finished read_file', 'result'),
      ],
      { now: 1 },
    );

    const rows = state.blocks.filter(
      (block) =>
        block.kind === 'status' && block.source === 'teammate_activity',
    );
    // The tool row stays latest-state coalesced; both messages keep their own.
    expect(rows.map((block) => ('text' in block ? block.text : ''))).toEqual([
      'checker finished read_file',
      'writer -> checker: review the auth module',
      'writer -> checker: check a different file',
    ]);
  });

  it('keeps a failed tool row instead of letting the next call overwrite it', () => {
    // A failure is an outcome, not a phase, and the system row renders it as
    // one; the teammate's next call frame carries the same identity and these
    // frames are never persisted, so merging it would lose the failure.
    const frame = (text: string, status: string): DaemonUiEvent => ({
      type: 'status',
      source: 'teammate_activity',
      text,
      data: { status },
      agent: { agentName: '/root/qa', depth: 1, kind: 'teammate' as const },
      clearActiveText: false,
    });

    const state = reduceDaemonTranscriptEvents(
      createDaemonTranscriptState({ now: 1 }),
      [
        frame('qa failed read_file', 'failed'),
        frame('qa started write_file', 'call'),
      ],
      { now: 1 },
    );

    const rows = state.blocks.filter(
      (block) =>
        block.kind === 'status' && block.source === 'teammate_activity',
    );
    expect(rows.map((block) => ('text' in block ? block.text : ''))).toEqual([
      'qa failed read_file',
      'qa started write_file',
    ]);
    expect(rows[0]).toMatchObject({ data: { status: 'failed' } });
  });

  it('keeps failed rows distinct from each other and from tool progress', () => {
    const frame = (text: string, status: string): DaemonUiEvent => ({
      ...activity(text, '/root/checker'),
      data: { status },
    });
    const state = reduceDaemonTranscriptEvents(
      createDaemonTranscriptState({ now: 1 }),
      [
        frame('checker failed read_file', 'failed'),
        frame('checker started write_file', 'call'),
        frame('checker failed write_file', 'failed'),
        frame('checker finished retry', 'result'),
      ],
      { now: 1 },
    );

    expect(state.blocks).toMatchObject([
      {
        kind: 'status',
        source: 'teammate_activity',
        text: 'checker failed read_file',
        data: { status: 'failed' },
      },
      {
        kind: 'status',
        source: 'teammate_activity',
        text: 'checker finished retry',
        data: { status: 'result' },
      },
      {
        kind: 'status',
        source: 'teammate_activity',
        text: 'checker failed write_file',
        data: { status: 'failed' },
      },
    ]);
  });

  it('appends a separate row when the activity carries no identity', () => {
    const state = reduceDaemonTranscriptEvents(
      createDaemonTranscriptState({ now: 1 }),
      [activity('first'), activity('second')],
      { now: 1 },
    );

    expect(state.blocks.map((block) => block.kind)).toEqual([
      'status',
      'status',
    ]);
    expect(
      state.blocks.map((block) => ('text' in block ? block.text : '')),
    ).toEqual(['first', 'second']);
  });

  it('starts a new row after a turn boundary instead of rewriting the old one', () => {
    const state = reduceDaemonTranscriptEvents(
      createDaemonTranscriptState({ now: 1 }),
      [
        activity('turn one work', '/root/qa'),
        { type: 'user.text.delta', text: 'next question' },
        activity('turn two work', '/root/qa'),
      ],
      { now: 1 },
    );

    expect(state.blocks.map((block) => block.kind)).toEqual([
      'status',
      'user',
      'status',
    ]);
    expect(
      state.blocks.map((block) => ('text' in block ? block.text : '')),
    ).toEqual(['turn one work', 'next question', 'turn two work']);
  });

  it('finalises the streaming block on a coalesced row that did not opt out', () => {
    // Clients may dispatch these events themselves, so the reducer must key
    // off the event rather than off whether a row already existed.
    const plain = (text: string): DaemonUiEvent => ({
      type: 'status',
      source: 'teammate_activity',
      text,
      agent: { agentName: '/root/qa', depth: 1, kind: 'teammate' },
    });
    const state = reduceDaemonTranscriptEvents(
      createDaemonTranscriptState({ now: 1 }),
      [
        { type: 'assistant.text.delta', text: 'answering' },
        plain('first'),
        { type: 'assistant.text.delta', text: ' more' },
        plain('second'),
        { type: 'assistant.text.delta', text: ' tail' },
      ],
      { now: 1 },
    );

    expect(state.blocks.map((block) => block.kind)).toEqual([
      'assistant',
      'status',
      'assistant',
      'assistant',
    ]);
    expect(
      state.blocks.map((block) => ('text' in block ? block.text : '')),
    ).toEqual(['answering', 'second', ' more', ' tail']);
  });

  it('starts a new row after a branch marker instead of rewriting the old one', () => {
    const state = reduceDaemonTranscriptEvents(
      createDaemonTranscriptState({ now: 1 }),
      [
        activity('before the branch', '/root/qa'),
        {
          type: 'session.branched',
          sourceSessionId: 'session-a',
          newSessionId: 'session-b',
          displayName: 'retry',
        },
        activity('after the branch', '/root/qa'),
      ],
      { now: 1 },
    );

    expect(
      state.blocks.map((block) => ('text' in block ? block.text : '')),
    ).toEqual([
      'before the branch',
      'Branched conversation "retry". You are now in the branch.',
      'after the branch',
    ]);
  });
});

describe('status event while a thought block is streaming', () => {
  it('keeps the thought block active when clearActiveText is false', () => {
    const state = reduceDaemonTranscriptEvents(
      createDaemonTranscriptState({ now: 1 }),
      [
        { type: 'user.text.delta', text: 'question' },
        { type: 'thought.text.delta', text: 'thinking' },
        { type: 'status', text: 'mid-stream status', clearActiveText: false },
        { type: 'thought.text.delta', text: ' more' },
        { type: 'assistant.done' },
      ],
      { now: 1 },
    );

    expect(state.blocks.map((block) => block.kind)).toEqual([
      'user',
      'thought',
      'status',
    ]);
    const thought = state.blocks[1];
    if (thought.kind !== 'thought') throw new Error('expected thought');
    expect(thought.text).toBe('thinking more');
  });
});

describe('unrecognized diagnostics stay out of the chat transcript', () => {
  it('preserves the active assistant block and usage across an unrecognized diagnostic', () => {
    const state = reduceDaemonTranscriptEvents(
      createDaemonTranscriptState({ now: 1 }),
      [
        { type: 'user.text.delta', text: 'question' },
        { type: 'assistant.text.delta', text: 'hello' },
        {
          type: 'debug',
          text: 'language_changed (unrecognized daemon event): {"language":"en"}',
          debugReason: 'unrecognized_event',
        },
        {
          type: 'assistant.usage',
          usage: { inputTokens: 10, outputTokens: 5 },
        },
        { type: 'assistant.done' },
      ],
      { now: 1 },
    );

    expect(state.blocks.map((block) => block.kind)).toEqual([
      'user',
      'assistant',
    ]);
    const assistant = state.blocks[1];
    if (assistant.kind !== 'assistant') throw new Error('expected assistant');
    expect(assistant.text).toBe('hello');
    expect(assistant.usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cachedTokens: 0,
    });

    expect(state.unrecognizedDiagnostics).toHaveLength(1);
    expect(state.unrecognizedDiagnostics[0]?.debugReason).toBe(
      'unrecognized_event',
    );
    expect(state.unrecognizedDiagnostics[0]?.text).toBe(
      'language_changed (unrecognized daemon event): {"language":"en"}',
    );
  });

  it('does not let hidden diagnostics evict conversation blocks through maxBlocks', () => {
    let state = reduceDaemonTranscriptEvents(
      createDaemonTranscriptState({ now: 1 }),
      [
        { type: 'user.text.delta', text: 'question' },
        { type: 'assistant.text.delta', text: 'answer' },
        { type: 'assistant.done' },
      ],
      { now: 1, maxBlocks: 2 },
    );

    state = reduceDaemonTranscriptEvents(
      state,
      [
        {
          type: 'debug',
          text: 'some_future_event (unrecognized daemon event): {"a":1}',
          debugReason: 'unrecognized_event',
        },
        {
          type: 'debug',
          text: 'some_future_update (unrecognized session update): {"b":2}',
          debugReason: 'unrecognized_session_update',
        },
      ],
      { now: 1, maxBlocks: 2 },
    );

    expect(state.blocks.map((block) => block.kind)).toEqual([
      'user',
      'assistant',
    ]);
    expect(
      state.blocks.map((block) => ('text' in block ? block.text : '')),
    ).toEqual(['question', 'answer']);
    expect(
      state.unrecognizedDiagnostics.map((entry) => entry.debugReason),
    ).toEqual(['unrecognized_event', 'unrecognized_session_update']);
  });

  it('resets the active user pointer across a sidechanneled diagnostic', () => {
    // The replaced `appendStatusBlock` path reset `activeUserBlockId` for
    // every non-user block; the sidechannel must keep that reset. Without
    // it, a later mergeable `user.text.delta` with no promptId stamp (e.g.
    // a peer client's `$ <cmd>` echo) appends onto the earlier user block
    // across the diagnostic, collapsing two user turns into one and
    // skewing `rewindTranscriptToUserTurn`'s turn indexing.
    const state = reduceDaemonTranscriptEvents(
      createDaemonTranscriptState({ now: 1 }),
      [
        { type: 'user.text.delta', text: '$ cmd1' },
        {
          type: 'debug',
          text: 'some_future_event (unrecognized daemon event): {"a":1}',
          debugReason: 'unrecognized_event',
        },
        { type: 'user.text.delta', text: '$ cmd2' },
      ],
      { now: 1 },
    );

    expect(state.blocks.map((block) => block.kind)).toEqual(['user', 'user']);
    expect(
      state.blocks.map((block) => ('text' in block ? block.text : '')),
    ).toEqual(['$ cmd1', '$ cmd2']);
    // The pointer follows the latest user block, not the pre-diagnostic one.
    expect(state.activeUserBlockId).toBe(state.blocks[1]?.id);
    expect(state.unrecognizedDiagnostics).toHaveLength(1);
  });

  it('keeps malformed-payload diagnostics in the transcript', () => {
    const state = reduceDaemonTranscriptEvents(
      createDaemonTranscriptState({ now: 1 }),
      [
        { type: 'assistant.text.delta', text: 'answering' },
        {
          type: 'debug',
          text: 'session_rewound (malformed payload): {"oops":true}',
          debugReason: 'malformed_payload',
        },
      ],
      { now: 1 },
    );

    expect(state.blocks.map((block) => block.kind)).toEqual([
      'assistant',
      'debug',
    ]);
    expect(state.unrecognizedDiagnostics).toHaveLength(0);
    expect(state.activeAssistantBlockId).toBeUndefined();
  });

  it('keeps client-dispatched debug events in the transcript', () => {
    const state = reduceDaemonTranscriptEvents(
      createDaemonTranscriptState({ now: 1 }),
      [
        { type: 'assistant.text.delta', text: 'answering' },
        { type: 'debug', text: 'Model switched: qwen3-max' },
      ],
      { now: 1 },
    );

    expect(state.blocks.map((block) => block.kind)).toEqual([
      'assistant',
      'debug',
    ]);
    expect(state.unrecognizedDiagnostics).toHaveLength(0);
    expect(state.activeAssistantBlockId).toBeUndefined();
  });

  it('bounds the unrecognized diagnostics sidechannel', () => {
    const events: DaemonUiEvent[] = [];
    for (let index = 0; index < UNRECOGNIZED_DIAGNOSTICS_LIMIT + 5; index++) {
      events.push({
        type: 'debug',
        text: `event_${index} (unrecognized daemon event): {}`,
        debugReason: 'unrecognized_event',
      });
    }

    const state = reduceDaemonTranscriptEvents(
      createDaemonTranscriptState({ now: 1 }),
      events,
      { now: 1 },
    );

    expect(state.unrecognizedDiagnostics).toHaveLength(
      UNRECOGNIZED_DIAGNOSTICS_LIMIT,
    );
    expect(state.unrecognizedDiagnostics.at(-1)?.text).toBe(
      `event_${UNRECOGNIZED_DIAGNOSTICS_LIMIT + 4} (unrecognized daemon event): {}`,
    );
    expect(state.unrecognizedDiagnostics[0]?.text).toBe(
      'event_5 (unrecognized daemon event): {}',
    );
  });

  it('selectUnrecognizedDiagnostics returns the routed sidechannel itself', () => {
    const state = reduceDaemonTranscriptEvents(
      createDaemonTranscriptState({ now: 1 }),
      [
        {
          type: 'debug',
          text: 'language_changed (unrecognized daemon event): {"language":"en"}',
          debugReason: 'unrecognized_event',
        },
      ],
      { now: 1 },
    );

    // The documented read path must return the live sidechannel, not a copy
    // or a stub: `toBe` discriminates a `return []` or shallow-copy
    // regression that would compile and export green.
    expect(selectUnrecognizedDiagnostics(state)).toBe(
      state.unrecognizedDiagnostics,
    );
    expect(selectUnrecognizedDiagnostics(state)).toHaveLength(1);
  });
});

it('preserves local command identity on read-only status results', () => {
  const state = reduceDaemonTranscriptEvents(
    createDaemonTranscriptState({ now: 1 }),
    [
      {
        type: 'user.text.delta',
        text: '/tools',
        promptId: 'local-command:tools',
      },
      {
        type: 'status',
        text: 'Tools list',
        promptId: 'local-command:tools',
        clearActiveText: false,
      },
    ],
    { now: 1 },
  );
  expect(state.blocks.map((block) => block.promptId)).toEqual([
    'local-command:tools',
    'local-command:tools',
  ]);
  expect(
    state.blocks.every((block) => block.id.startsWith('local-command:tools:')),
  ).toBe(true);
  expect(new Set(state.blocks.map((block) => block.id)).size).toBe(2);
});
