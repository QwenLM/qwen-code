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

  it('retains the branch point when matching a prompt completion', () => {
    const assistantRecordUuid = '11111111-1111-4111-8111-111111111111';
    const checkpointUuid = '22222222-2222-4222-8222-222222222222';
    expect(
      matchTurnEvent(
        {
          v: 1,
          type: 'turn_complete',
          data: {
            promptId: 'prompt-1',
            stopReason: 'end_turn',
            branchPoint: {
              assistantRecordUuid,
              checkpointUuid,
            },
          },
        },
        'prompt-1',
      ),
    ).toEqual({
      stopReason: 'end_turn',
      branchPoint: {
        assistantRecordUuid,
        checkpointUuid,
      },
    });
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
