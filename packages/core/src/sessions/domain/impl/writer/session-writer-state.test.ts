/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { SessionWriterState } from './session-writer-state.js';

describe('SessionWriterState', () => {
  it('retains and releases with reference counting', async () => {
    const writer = {
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as import('./session-transcript-writer-impl.js').SessionTranscriptWriterImpl;
    const state = new SessionWriterState('key', '/tmp/t.jsonl', writer);

    expect(state.references).toBe(0);
    expect(state.retain()).toBe(true);
    expect(state.retain()).toBe(true);
    expect(state.references).toBe(2);

    expect(await state.release()).toBe(false);
    expect(state.references).toBe(1);

    expect(await state.release()).toBe(true);
    expect(state.references).toBe(0);
    expect(state.lifecycle).toBe('closed');
    expect(writer.close).toHaveBeenCalledTimes(1);
  });

  it('does not retain a closing/closed state', async () => {
    const writer = {
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as import('./session-transcript-writer-impl.js').SessionTranscriptWriterImpl;
    const state = new SessionWriterState('key', '/tmp/t.jsonl', writer);

    await state.forceClose();
    expect(state.retain()).toBe(false);
    expect(await state.release()).toBe(false);
  });

  it('guards double close', async () => {
    const writer = {
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as import('./session-transcript-writer-impl.js').SessionTranscriptWriterImpl;
    const state = new SessionWriterState('key', '/tmp/t.jsonl', writer);

    await state.forceClose();
    await state.forceClose();
    expect(writer.close).toHaveBeenCalledTimes(1);
  });
});
