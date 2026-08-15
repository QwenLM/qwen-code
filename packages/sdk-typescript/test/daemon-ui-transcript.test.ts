import { describe, expect, it } from 'vitest';
import {
  createDaemonTranscriptState,
  reduceDaemonTranscriptEvents,
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
