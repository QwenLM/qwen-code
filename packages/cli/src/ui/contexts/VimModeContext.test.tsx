/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 *
 * Regression tests for vim Esc key isolation.
 *
 * Guards against Esc leaking from vim INSERT mode into AppContainer's
 * escape handler (cancel stream / "Press Esc again to clear").
 */

import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { Text } from 'ink';
import { act } from 'react';
import {
  VimModeProvider,
  useVimModeState,
  useVimModeActions,
} from './VimModeContext.js';
import type { LoadedSettings } from '../../config/settings.js';

function makeSettings(vimEnabled = true): LoadedSettings {
  return {
    merged: { general: { vimMode: vimEnabled } },
    setValue: vi.fn().mockResolvedValue(undefined),
  } as unknown as LoadedSettings;
}

describe('VimModeContext — Esc key isolation in INSERT mode', () => {
  it('setVimMode should be available and callable', () => {
    const settings = makeSettings(true);
    let capturedSetVimMode: ((mode: 'NORMAL' | 'INSERT') => void) | null = null;

    function Capture() {
      const { setVimMode } = useVimModeActions();
      capturedSetVimMode = setVimMode;
      return <Text>ok</Text>;
    }

    render(
      <VimModeProvider settings={settings}>
        <Capture />
      </VimModeProvider>,
    );

    expect(capturedSetVimMode).toBeTypeOf('function');

    expect(() => {
      act(() => {
        capturedSetVimMode!('NORMAL');
      });
    }).not.toThrow();
  });

  it('setVimMode reference should be stable across re-renders', () => {
    const settings = makeSettings(true);
    const refs: Array<(mode: 'NORMAL' | 'INSERT') => void> = [];

    function Capture() {
      const { setVimMode } = useVimModeActions();
      refs.push(setVimMode);
      return <Text>ok</Text>;
    }

    const { rerender } = render(
      <VimModeProvider settings={settings}>
        <Capture />
      </VimModeProvider>,
    );

    rerender(
      <VimModeProvider settings={settings}>
        <Capture />
      </VimModeProvider>,
    );

    expect(refs.length).toBeGreaterThanOrEqual(2);
    expect(refs[0]).toBe(refs[refs.length - 1]);
  });

  it('Actions consumers should NOT re-render when mode changes', () => {
    const settings = makeSettings(true);
    const actionsSpy = vi.fn();
    let setVimModeRef: (mode: 'NORMAL' | 'INSERT') => void = () => {};

    function ActionsCapture() {
      const { setVimMode } = useVimModeActions();
      setVimModeRef = setVimMode;
      actionsSpy();
      return <Text>ok</Text>;
    }

    render(
      <VimModeProvider settings={settings}>
        <ActionsCapture />
      </VimModeProvider>,
    );

    act(() => {
      setVimModeRef('INSERT');
    });
    actionsSpy.mockClear();

    // Simulate Esc in INSERT mode → NORMAL
    act(() => {
      setVimModeRef('NORMAL');
    });

    // Actions consumer must NOT re-render — this is the key invariant.
    // If it re-renders, AppContainer would also re-render on every Esc,
    // causing the "Press Esc again" leak.
    expect(actionsSpy.mock.calls.length).toBe(0);
  });

  it('State consumers should re-render when mode changes', () => {
    const settings = makeSettings(true);
    const stateSpy = vi.fn();
    let setVimModeRef: (mode: 'NORMAL' | 'INSERT') => void = () => {};

    function StateCapture() {
      const { vimMode } = useVimModeState();
      setVimModeRef = useVimModeActions().setVimMode;
      stateSpy();
      return <Text>{vimMode}</Text>;
    }

    render(
      <VimModeProvider settings={settings}>
        <StateCapture />
      </VimModeProvider>,
    );

    act(() => {
      setVimModeRef('INSERT');
    });
    stateSpy.mockClear();

    act(() => {
      setVimModeRef('NORMAL');
    });

    // State consumer should re-render to reflect the new mode
    expect(stateSpy.mock.calls.length).toBeGreaterThan(0);
  });
});
