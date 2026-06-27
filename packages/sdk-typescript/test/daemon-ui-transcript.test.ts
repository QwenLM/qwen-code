import { describe, expect, it } from 'vitest';
import {
  createDaemonTranscriptState,
  reduceDaemonTranscriptEvents,
} from '../src/daemon/ui/transcript.js';
import type { DaemonUiEvent } from '../src/daemon/ui/types.js';

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
});
