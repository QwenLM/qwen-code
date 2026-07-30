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
        { type: 'assistant.text.delta', text: 'answer' },
        {
          type: 'assistant.done',
          reason: 'end_turn',
          sourceRecordIds: ['assistant-record'],
          branchRecordId: 'checkpoint-record',
        },
      ],
      { now: 1 },
    );

    expect(state.blocks[0]).toMatchObject({
      kind: 'assistant',
      sourceRecordIds: ['assistant-record'],
      branchRecordId: 'checkpoint-record',
    });
  });

  it('does not attach a branch anchor to an errored Assistant block', () => {
    const state = reduceDaemonTranscriptEvents(
      createDaemonTranscriptState({ now: 1 }),
      [
        { type: 'assistant.text.delta', text: 'partial answer' },
        {
          type: 'assistant.done',
          reason: 'error',
          sourceRecordIds: ['assistant-record'],
          branchRecordId: 'checkpoint-record',
        },
      ],
      { now: 1 },
    );

    expect(state.blocks[0]).not.toHaveProperty('branchRecordId');
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
    for (const [stopReason, checkpointUuid] of [
      ['end_turn', 'not-a-uuid'],
      ['error', '22222222-2222-4222-8222-222222222222'],
    ] as const) {
      expect(
        matchTurnEvent(
          {
            type: 'turn_complete',
            data: {
              promptId: 'prompt-1',
              stopReason,
              branchPoint: {
                assistantRecordUuid: '11111111-1111-4111-8111-111111111111',
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
