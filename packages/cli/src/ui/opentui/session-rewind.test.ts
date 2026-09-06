/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Verifies the OpenTUI rewind state machine and helpers reproduce the ink
 * RewindSelector behavior: real-user-turn filtering, the 7-row scroll
 * window, the checkpoint-dependent restore option list, and the
 * pick → restore-options/confirm → restoring phase transitions.
 */

import { describe, it, expect } from 'vitest';
import type { Content, Part } from '@google/genai';
import {
  SYSTEM_REMINDER_OPEN,
  SYSTEM_REMINDER_CLOSE,
} from '@qwen-code/qwen-code-core';
import {
  isRewindableTurn,
  rewindableTurns,
  rewindScrollWindow,
  buildRestoreOptions,
  createRewindState,
  rewindReducer,
  rewindApiCutPoint,
  REWIND_MAX_VISIBLE_ITEMS,
  type RewindTurn,
} from './session-rewind-model.js';

function turn(overrides: Partial<RewindTurn> = {}): RewindTurn {
  return { id: 't1', text: 'fix the bug', ...overrides };
}

describe('session-rewind turn filtering (isRealUserTurn parity)', () => {
  it('keeps real prompts', () => {
    expect(isRewindableTurn(turn())).toBe(true);
  });

  it('drops empty prompts', () => {
    expect(isRewindableTurn(turn({ text: '' }))).toBe(false);
  });

  it('drops slash commands and ?-prefixed queries', () => {
    expect(isRewindableTurn(turn({ text: '/compact' }))).toBe(false);
    expect(isRewindableTurn(turn({ text: '?quick question' }))).toBe(false);
  });

  it('keeps file paths that only look like commands', () => {
    expect(isRewindableTurn(turn({ text: '/Users/me/x.ts' }))).toBe(true);
  });

  it('honors an explicit sentToModel flag', () => {
    expect(isRewindableTurn(turn({ sentToModel: false }))).toBe(false);
    expect(
      isRewindableTurn(turn({ text: '/compact', sentToModel: true })),
    ).toBe(true);
  });

  it('filters a mixed transcript', () => {
    const turns = [
      turn({ id: 'a', text: 'first prompt' }),
      turn({ id: 'b', text: '/compact' }),
      turn({ id: 'c', text: 'second prompt' }),
    ];
    expect(rewindableTurns(turns).map((t) => t.id)).toEqual(['a', 'c']);
  });
});

describe('session-rewind scroll window (RewindSelector parity)', () => {
  it('shows everything without arrows when the list fits', () => {
    expect(rewindScrollWindow(3, REWIND_MAX_VISIBLE_ITEMS, 2)).toEqual({
      offset: 0,
      visibleCount: 3,
      showScrollUp: false,
      showScrollDown: false,
    });
  });

  it('caps the visible rows at the max', () => {
    const win = rewindScrollWindow(20, REWIND_MAX_VISIBLE_ITEMS, 19);
    expect(win.visibleCount).toBe(7);
  });

  it('centers the selection with clamped offsets', () => {
    // selected 4 -> 4 - floor(7/2) = 1
    expect(rewindScrollWindow(10, 7, 4)).toMatchObject({
      offset: 1,
      showScrollUp: true,
      showScrollDown: true,
    });
  });

  it('pins the window to the end for the newest turn', () => {
    expect(rewindScrollWindow(10, 7, 9)).toMatchObject({
      offset: 3,
      showScrollUp: true,
      showScrollDown: false,
    });
  });

  it('pins the window to the start for the oldest turn', () => {
    expect(rewindScrollWindow(10, 7, 0)).toMatchObject({
      offset: 0,
      showScrollUp: false,
      showScrollDown: true,
    });
  });
});

describe('session-rewind restore options (getRestoreOptions parity)', () => {
  it('offers only conversation + cancel without captured changes', () => {
    expect(buildRestoreOptions(undefined).map((o) => o.key)).toEqual([
      'conversation',
      'cancel',
    ]);
    expect(
      buildRestoreOptions({
        filesChanged: [],
        insertions: 3,
        deletions: 1,
      }).map((o) => o.key),
    ).toEqual(['conversation', 'cancel']);
  });

  it('offers both/conversation/code with the diff detail line', () => {
    const options = buildRestoreOptions({
      filesChanged: ['a.ts', 'b.ts'],
      insertions: 10,
      deletions: 2,
    });
    expect(options.map((o) => o.key)).toEqual([
      'both',
      'conversation',
      'code',
      'cancel',
    ]);
    expect(options[0]?.detail).toBe('(+10 -2 in 2 files)');
  });

  it('uses the singular file wording for one changed file', () => {
    const options = buildRestoreOptions({
      filesChanged: ['a.ts'],
      insertions: 1,
      deletions: 0,
    });
    expect(options[0]?.detail).toBe('(+1 -0 in 1 file)');
  });
});

describe('session-rewind state machine', () => {
  it('starts on the most recent turn', () => {
    const state = createRewindState(3);
    expect(state).toEqual({
      phase: 'pick',
      turnCount: 3,
      selectedIndex: 2,
      selectedTurnIndex: null,
      restoreOptionIndex: 0,
    });
  });

  it('clamps pick-list navigation', () => {
    let state = createRewindState(3);
    state = rewindReducer(state, { type: 'select-up' });
    state = rewindReducer(state, { type: 'select-up' });
    state = rewindReducer(state, { type: 'select-up' });
    expect(state.selectedIndex).toBe(0);
    state = rewindReducer(state, { type: 'select-down' });
    state = rewindReducer(state, { type: 'select-down' });
    state = rewindReducer(state, { type: 'select-down' });
    state = rewindReducer(state, { type: 'select-down' });
    expect(state.selectedIndex).toBe(2);
  });

  it('opens restore options when file checkpointing is on', () => {
    let state = createRewindState(3);
    state = rewindReducer(state, { type: 'select-up' });
    state = rewindReducer(state, {
      type: 'enter-pick',
      fileCheckpointingEnabled: true,
    });
    expect(state.phase).toBe('restore-options');
    expect(state.selectedTurnIndex).toBe(1);
    expect(state.restoreOptionIndex).toBe(0);
  });

  it('opens the legacy confirm when file checkpointing is off', () => {
    let state = createRewindState(2);
    state = rewindReducer(state, {
      type: 'enter-pick',
      fileCheckpointingEnabled: false,
    });
    expect(state.phase).toBe('confirm');
    expect(state.selectedTurnIndex).toBe(1);
  });

  it('refuses to open with zero turns', () => {
    const state = createRewindState(0);
    const next = rewindReducer(state, {
      type: 'enter-pick',
      fileCheckpointingEnabled: true,
    });
    expect(next.phase).toBe('pick');
  });

  it('navigates restore options with clamping', () => {
    let state = createRewindState(2);
    state = rewindReducer(state, {
      type: 'enter-pick',
      fileCheckpointingEnabled: true,
    });
    state = rewindReducer(state, { type: 'option-up' });
    expect(state.restoreOptionIndex).toBe(0);
    state = rewindReducer(state, { type: 'option-down', optionCount: 4 });
    state = rewindReducer(state, { type: 'option-down', optionCount: 4 });
    state = rewindReducer(state, { type: 'option-down', optionCount: 4 });
    state = rewindReducer(state, { type: 'option-down', optionCount: 4 });
    expect(state.restoreOptionIndex).toBe(3);
  });

  it('goes back to the pick list and clears the selection', () => {
    let state = createRewindState(2);
    state = rewindReducer(state, {
      type: 'enter-pick',
      fileCheckpointingEnabled: true,
    });
    state = rewindReducer(state, { type: 'back' });
    expect(state.phase).toBe('pick');
    expect(state.selectedTurnIndex).toBeNull();
    // back in pick is a no-op
    expect(rewindReducer(state, { type: 'back' })).toEqual(state);
  });

  it('enters restoring from a sub-phase and then ignores keys', () => {
    let state = createRewindState(2);
    state = rewindReducer(state, {
      type: 'enter-pick',
      fileCheckpointingEnabled: false,
    });
    state = rewindReducer(state, { type: 'begin-restore' });
    expect(state.phase).toBe('restoring');
    expect(rewindReducer(state, { type: 'back' })).toEqual(state);
    expect(rewindReducer(state, { type: 'select-up' })).toEqual(state);
    expect(
      rewindReducer(state, {
        type: 'enter-pick',
        fileCheckpointingEnabled: true,
      }),
    ).toEqual(state);
  });
});

function userPrompt(text: string): Content {
  return { role: 'user', parts: [{ text } as Part] };
}

function imagePrompt(text: string): Content {
  return {
    role: 'user',
    parts: [
      { text } as Part,
      {
        inlineData: { mimeType: 'image/png', data: 'AAA=' },
      } as unknown as Part,
    ],
  };
}

function toolResult(): Content {
  return {
    role: 'user',
    parts: [
      {
        functionResponse: { name: 'tool', response: { result: 'ok' } },
      } as unknown as Part,
    ],
  };
}

function startupContext(): Content {
  return userPrompt(
    `${SYSTEM_REMINDER_OPEN}\nEnvironment context...\n${SYSTEM_REMINDER_CLOSE}`,
  );
}

describe('rewindApiCutPoint (positional, text-independent)', () => {
  it('locates the N-th real user prompt regardless of transcript text', () => {
    // The UI transcript projects an image turn as `${text} 📎1`, but the
    // API entry carries raw parts — matching must not depend on text.
    const api: Content[] = [
      userPrompt('first'),
      { role: 'model', parts: [{ text: 'reply' } as Part] },
      imagePrompt('second'),
    ];
    expect(rewindApiCutPoint(api, 1)).toBe(0);
    expect(rewindApiCutPoint(api, 2)).toBe(2);
  });

  it('skips startup-context and tool-result entries', () => {
    const api: Content[] = [
      startupContext(),
      userPrompt('first'),
      toolResult(),
      userPrompt('second'),
    ];
    expect(rewindApiCutPoint(api, 1)).toBe(1);
    expect(rewindApiCutPoint(api, 2)).toBe(3);
  });

  it('returns -1 when the history holds fewer prompts (compressed turn)', () => {
    const api: Content[] = [userPrompt('first')];
    expect(rewindApiCutPoint(api, 2)).toBe(-1);
    expect(rewindApiCutPoint([], 1)).toBe(-1);
  });
});
