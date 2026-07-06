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
import { SettingsContext } from '../contexts/SettingsContext.js';
import { UIStateContext, type UIState } from '../contexts/UIStateContext.js';
import type { LoadedSettings } from '../../config/settings.js';
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
const ENABLE_ANY = '\x1b[?1003h\x1b[?1006h';
const DISABLE_ANY = '\x1b[?1006l\x1b[?1003l';

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <KeypressProvider kittyProtocolEnabled={false}>{children}</KeypressProvider>
);

const vpWrapper = (useTerminalBuffer: boolean) => {
  const VpWrapper = ({ children }: { children: React.ReactNode }) => (
    <SettingsContext.Provider
      value={
        { merged: { ui: { useTerminalBuffer } } } as unknown as LoadedSettings
      }
    >
      <KeypressProvider kittyProtocolEnabled={false}>
        {children}
      </KeypressProvider>
    </SettingsContext.Provider>
  );
  return VpWrapper;
};

const uiStateVpWrapper = (useTerminalBuffer: boolean) => {
  const VpWrapper = ({ children }: { children: React.ReactNode }) => (
    <SettingsContext.Provider
      value={{ merged: { ui: {} } } as unknown as LoadedSettings}
    >
      <UIStateContext.Provider
        value={{ useTerminalBuffer } as unknown as UIState}
      >
        <KeypressProvider kittyProtocolEnabled={false}>
          {children}
        </KeypressProvider>
      </UIStateContext.Provider>
    </SettingsContext.Provider>
  );
  return VpWrapper;
};

// Mechanism tests exercise enable/disable/ref-counting independent of the VP
// gate, so they opt out via bypassVpGate.
function useTwoMouseSubscribers(firstActive: boolean, secondActive: boolean) {
  useMouseEvents(() => {}, { isActive: firstActive, bypassVpGate: true });
  useMouseEvents(() => {}, { isActive: secondActive, bypassVpGate: true });
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

  it('upgrades to ?1003h when a hover (any) subscriber is active, then restores ?1002h', () => {
    const { rerender, unmount } = renderHook(
      ({
        buttonActive,
        anyActive,
      }: {
        buttonActive: boolean;
        anyActive: boolean;
      }) => {
        useMouseEvents(() => {}, {
          isActive: buttonActive,
          bypassVpGate: true,
        });
        useMouseEvents(() => {}, {
          isActive: anyActive,
          tracking: 'any',
          bypassVpGate: true,
        });
      },
      {
        initialProps: { buttonActive: true, anyActive: false },
        wrapper,
      },
    );

    // Only the button subscriber is active → button-event tracking.
    expect(stdout.write).toHaveBeenCalledTimes(1);
    expect(stdout.write).toHaveBeenCalledWith(ENABLE_MOUSE);

    // Hover subscriber mounts → upgrade: disable 1002, enable 1003.
    stdout.write.mockClear();
    rerender({ buttonActive: true, anyActive: true });
    expect(stdout.write).toHaveBeenCalledWith(DISABLE_MOUSE);
    expect(stdout.write).toHaveBeenCalledWith(ENABLE_ANY);

    // Hover subscriber leaves → downgrade back to 1002.
    stdout.write.mockClear();
    rerender({ buttonActive: true, anyActive: false });
    expect(stdout.write).toHaveBeenCalledWith(DISABLE_ANY);
    expect(stdout.write).toHaveBeenCalledWith(ENABLE_MOUSE);

    // Last subscriber leaves → disable entirely.
    stdout.write.mockClear();
    rerender({ buttonActive: false, anyActive: false });
    expect(stdout.write).toHaveBeenCalledWith(DISABLE_MOUSE);

    unmount();
  });

  it('enables ?1003h directly when the only active subscriber wants hover', () => {
    const { unmount } = renderHook(
      () =>
        useMouseEvents(() => {}, {
          isActive: true,
          tracking: 'any',
          bypassVpGate: true,
        }),
      { wrapper },
    );

    expect(stdout.write).toHaveBeenCalledTimes(1);
    expect(stdout.write).toHaveBeenCalledWith(ENABLE_ANY);

    stdout.write.mockClear();
    unmount();
    expect(stdout.write).toHaveBeenCalledWith(DISABLE_ANY);
  });

  describe('VP gate', () => {
    it('non-VP without bypass: does NOT enable mouse mode (native scrollback preserved)', () => {
      renderHook(() => useMouseEvents(() => {}, { isActive: true }), {
        wrapper: vpWrapper(false),
      });
      expect(stdout.write).not.toHaveBeenCalledWith(ENABLE_MOUSE);
    });

    it('VP without bypass: enables mouse mode', () => {
      renderHook(() => useMouseEvents(() => {}, { isActive: true }), {
        wrapper: vpWrapper(true),
      });
      expect(stdout.write).toHaveBeenCalledWith(ENABLE_MOUSE);
    });

    it('uses UIState VP mode when the raw setting is unset', () => {
      renderHook(() => useMouseEvents(() => {}, { isActive: true }), {
        wrapper: uiStateVpWrapper(true),
      });
      expect(stdout.write).toHaveBeenCalledWith(ENABLE_MOUSE);
    });

    it('bypassVpGate: enables mouse mode even in non-VP (modal / VP viewport)', () => {
      renderHook(
        () => useMouseEvents(() => {}, { isActive: true, bypassVpGate: true }),
        { wrapper: vpWrapper(false) },
      );
      expect(stdout.write).toHaveBeenCalledWith(ENABLE_MOUSE);
    });
  });
});
