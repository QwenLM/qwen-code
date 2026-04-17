/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { createCombinedAbortSignal } from './combinedAbortSignal.js';

describe('createCombinedAbortSignal', () => {
  it('should return a non-aborted signal by default', () => {
    const { signal, cleanup } = createCombinedAbortSignal();
    expect(signal.aborted).toBe(false);
    cleanup();
  });

  it('should abort after timeout', async () => {
    const { signal, cleanup } = createCombinedAbortSignal(undefined, {
      timeoutMs: 50,
    });
    expect(signal.aborted).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(signal.aborted).toBe(true);
    cleanup();
  });

  it('should abort when external signal is aborted', () => {
    const externalController = new AbortController();
    const { signal, cleanup } = createCombinedAbortSignal(
      externalController.signal,
    );
    expect(signal.aborted).toBe(false);

    externalController.abort();
    expect(signal.aborted).toBe(true);
    cleanup();
  });

  it('should abort immediately if external signal is already aborted', () => {
    const externalController = new AbortController();
    externalController.abort();

    const { signal, cleanup } = createCombinedAbortSignal(
      externalController.signal,
    );
    expect(signal.aborted).toBe(true);
    cleanup();
  });

  it('should cleanup timeout timer', async () => {
    const { signal, cleanup } = createCombinedAbortSignal(undefined, {
      timeoutMs: 50,
    });

    cleanup();

    // Wait longer than timeout - should not abort because timer was cleared
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(signal.aborted).toBe(false);
  });

  it('should work with both external signal and timeout', async () => {
    const externalController = new AbortController();
    const { signal, cleanup } = createCombinedAbortSignal(
      externalController.signal,
      { timeoutMs: 200 },
    );

    // Abort external signal before timeout
    externalController.abort();
    expect(signal.aborted).toBe(true);
    cleanup();
  });

  it('should timeout before external signal', async () => {
    const externalController = new AbortController();
    const { signal, cleanup } = createCombinedAbortSignal(
      externalController.signal,
      { timeoutMs: 50 },
    );

    // Wait for timeout
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(signal.aborted).toBe(true);

    // External signal is still not aborted
    expect(externalController.signal.aborted).toBe(false);
    cleanup();
  });
});
