/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { createThinkingTextState } from './thinkingTextState.js';

describe('createThinkingTextState', () => {
  it('accumulates split thinking and returns the full unmodified text', () => {
    const state = createThinkingTextState();
    expect(state.append('  **Checking')).toBe('  **Checking');
    expect(state.append(' cwd**\nInspecting\n')).toBe(
      '  **Checking cwd**\nInspecting\n',
    );
    expect(state.append('')).toBe('  **Checking cwd**\nInspecting\n');
  });

  it('takes pending text once and starts the next segment empty', () => {
    const state = createThinkingTextState();
    expect(state.takePending()).toBe('');
    state.append('first');
    expect(state.takePending()).toBe('first');
    expect(state.takePending()).toBe('');
    expect(state.append('second')).toBe('second');
  });

  it('preserves whitespace in pending text but does not record blank history', () => {
    const state = createThinkingTextState();
    state.append(' \n\t');
    expect(state.takePending()).toBe(' \n\t');
    expect(state.markPersisted('')).toBe(false);
    expect(state.markPersisted(' \n\t')).toBe(false);
    expect(state.markPersisted('thinking')).toBe(true);
  });

  it('deduplicates final thinking after the streamed thinking entered history', () => {
    const state = createThinkingTextState();
    state.append('**Checking');
    state.append(' cwd**\nInspecting');
    const streamedText = state.takePending();
    expect(state.markPersisted(streamedText)).toBe(true);
    expect(state.markPersisted('**Checking cwd**\nInspecting')).toBe(false);
    expect(state.takePending()).toBe('');
  });

  it('trims only surrounding whitespace when comparing history entries', () => {
    const state = createThinkingTextState();
    expect(state.markPersisted(' \nThinking\t')).toBe(true);
    expect(state.markPersisted('Thinking')).toBe(false);
    expect(state.markPersisted('Think ing')).toBe(true);
    expect(state.markPersisted('Think  ing')).toBe(true);
    expect(state.markPersisted('thinking')).toBe(true);
  });

  it('clears pending text while retaining every recorded history key', () => {
    const state = createThinkingTextState();
    state.markPersisted('first');
    state.markPersisted('second');
    state.append('unfinished');
    state.clearPending();
    expect(state.takePending()).toBe('');
    expect(state.markPersisted('first')).toBe(false);
    expect(state.markPersisted('second')).toBe(false);
    expect(state.append('next')).toBe('next');
  });

  it('retains history keys when taking pending text', () => {
    const state = createThinkingTextState();
    state.markPersisted('already shown');
    state.append('already shown');
    expect(state.takePending()).toBe('already shown');
    expect(state.markPersisted('already shown')).toBe(false);
  });

  it('resets pending text and all history keys for the next turn', () => {
    const state = createThinkingTextState();
    state.markPersisted('first');
    state.markPersisted('second');
    state.append('unfinished');
    state.reset();
    expect(state.takePending()).toBe('');
    expect(state.markPersisted('first')).toBe(true);
    expect(state.markPersisted('second')).toBe(true);
    expect(state.append('next')).toBe('next');
  });

  it('keeps pending text and history keys isolated between sessions', () => {
    const first = createThinkingTextState();
    const second = createThinkingTextState();
    first.append('first');
    second.append('second');
    first.markPersisted('shared text');
    expect(second.markPersisted('shared text')).toBe(true);
    first.reset();
    expect(second.takePending()).toBe('second');
    expect(second.markPersisted('shared text')).toBe(false);
    expect(first.takePending()).toBe('');
  });
});
