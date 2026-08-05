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
