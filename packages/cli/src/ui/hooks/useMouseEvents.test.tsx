/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { EventEmitter } from 'node:events';
import { renderHook } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useStdin, useStdout } from 'ink';
import { KeypressProvider } from '../contexts/KeypressContext.js';
import { useMouseEvents } from './useMouseEvents.js';

vi.mock('ink', async (importOriginal) => {
  const original = await importOriginal<typeof import('ink')>();
  return {
    ...original,
    useStdin: vi.fn(),
    useStdout: vi.fn(),
  };
});

const mockedUseStdin = vi.mocked(useStdin);
const mockedUseStdout = vi.mocked(useStdout);

const ENABLE_MOUSE = '\x1b[?1002h\x1b[?1006h';
const DISABLE_MOUSE = '\x1b[?1006l\x1b[?1002l';

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <KeypressProvider kittyProtocolEnabled={false}>{children}</KeypressProvider>
);

function useTwoMouseSubscribers(firstActive: boolean, secondActive: boolean) {
  useMouseEvents(() => {}, { isActive: firstActive });
  useMouseEvents(() => {}, { isActive: secondActive });
}

describe('useMouseEvents', () => {
  let stdin: EventEmitter & {
    isTTY: boolean;
    setRawMode: ReturnType<typeof vi.fn>;
    resume: ReturnType<typeof vi.fn>;
    pause: ReturnType<typeof vi.fn>;
  };
  let stdout: { write: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    stdin = Object.assign(new EventEmitter(), {
      isTTY: true,
      setRawMode: vi.fn(),
      resume: vi.fn(),
      pause: vi.fn(),
    });
    stdout = { write: vi.fn() };
    mockedUseStdin.mockReturnValue({
      stdin,
      setRawMode: vi.fn(),
      isRawModeSupported: true,
    } as unknown as ReturnType<typeof useStdin>);
    mockedUseStdout.mockReturnValue({ stdout } as unknown as ReturnType<
      typeof useStdout
    >);
  });

  afterEach(() => {
    vi.clearAllMocks();
    stdin.removeAllListeners();
  });

  it('keeps terminal mouse mode enabled until all subscribers are inactive', () => {
    const { rerender, unmount } = renderHook(
      ({ firstActive, secondActive }) =>
        useTwoMouseSubscribers(firstActive, secondActive),
      {
        initialProps: { firstActive: true, secondActive: true },
        wrapper,
      },
    );

    expect(stdout.write).toHaveBeenCalledTimes(1);
    expect(stdout.write).toHaveBeenCalledWith(ENABLE_MOUSE);

    stdout.write.mockClear();
    rerender({ firstActive: false, secondActive: true });
    expect(stdout.write).not.toHaveBeenCalledWith(DISABLE_MOUSE);

    rerender({ firstActive: false, secondActive: false });
    expect(stdout.write).toHaveBeenCalledTimes(1);
    expect(stdout.write).toHaveBeenCalledWith(DISABLE_MOUSE);

    stdout.write.mockClear();
    unmount();
    expect(stdout.write).not.toHaveBeenCalled();
  });
});
