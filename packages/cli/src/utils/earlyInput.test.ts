/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { drainEarlyInput, startCapturingEarlyInput } from './earlyInput.js';

describe('earlyInput', () => {
  const originalStdin = process.stdin;
  const stdinListeners = new Map<string, Set<(chunk: Buffer) => void>>();
  const mockStdin = {
    isTTY: true,
    isRaw: false,
    setRawMode: vi.fn((mode: boolean) => {
      mockStdin.isRaw = mode;
      return mockStdin;
    }),
    on: vi.fn((event: string, handler: (chunk: Buffer) => void) => {
      const listeners = stdinListeners.get(event) ?? new Set();
      listeners.add(handler);
      stdinListeners.set(event, listeners);
      return mockStdin;
    }),
    removeListener: vi.fn((event: string, handler: (chunk: Buffer) => void) => {
      stdinListeners.get(event)?.delete(handler);
      return mockStdin;
    }),
    resume: vi.fn(() => mockStdin),
  };

  const emitData = (value: string) => {
    const listeners = stdinListeners.get('data');
    if (!listeners) {
      return;
    }
    const chunk = Buffer.from(value);
    for (const listener of listeners) {
      listener(chunk);
    }
  };

  beforeEach(() => {
    vi.clearAllMocks();
    stdinListeners.clear();
    mockStdin.isTTY = true;
    mockStdin.isRaw = false;
    Object.defineProperty(process, 'stdin', {
      value: mockStdin,
      configurable: true,
    });
  });

  afterEach(() => {
    drainEarlyInput();
    Object.defineProperty(process, 'stdin', {
      value: originalStdin,
      configurable: true,
    });
  });

  it('buffers tty input and restores raw mode when drained', () => {
    startCapturingEarlyInput();

    emitData('a');
    emitData('bc');

    const chunks = drainEarlyInput();

    expect(mockStdin.setRawMode).toHaveBeenNthCalledWith(1, true);
    expect(mockStdin.setRawMode).toHaveBeenNthCalledWith(2, false);
    expect(mockStdin.resume).toHaveBeenCalledTimes(1);
    expect(chunks.map((chunk: Buffer) => chunk.toString())).toEqual([
      'a',
      'bc',
    ]);
    expect(mockStdin.removeListener).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when stdin is not a tty', () => {
    mockStdin.isTTY = false;

    startCapturingEarlyInput();
    emitData('ignored');

    expect(drainEarlyInput()).toEqual([]);
    expect(mockStdin.setRawMode).not.toHaveBeenCalled();
    expect(mockStdin.on).not.toHaveBeenCalled();
  });
});
