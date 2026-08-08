/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { renderHook } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { SettingsContext } from '../contexts/SettingsContext.js';
import type { LoadedSettings } from '../../config/settings.js';
import { useMouseTrackingEnabled } from './use-mouse-tracking-enabled.js';

const wrapperWith = (ui: Record<string, unknown>) => {
  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <SettingsContext.Provider
      value={{ merged: { ui } } as unknown as LoadedSettings}
    >
      {children}
    </SettingsContext.Provider>
  );
  return Wrapper;
};

describe('useMouseTrackingEnabled', () => {
  it('defaults to true with no SettingsProvider', () => {
    const { result } = renderHook(() => useMouseTrackingEnabled());
    expect(result.current).toBe(true);
  });

  it('defaults to true when ui.mouseTracking is unset', () => {
    const { result } = renderHook(() => useMouseTrackingEnabled(), {
      wrapper: wrapperWith({ useTerminalBuffer: true }),
    });
    expect(result.current).toBe(true);
  });

  it('returns false when ui.mouseTracking is false', () => {
    const { result } = renderHook(() => useMouseTrackingEnabled(), {
      wrapper: wrapperWith({ mouseTracking: false }),
    });
    expect(result.current).toBe(false);
  });

  it('returns true when ui.mouseTracking is true', () => {
    const { result } = renderHook(() => useMouseTrackingEnabled(), {
      wrapper: wrapperWith({ mouseTracking: true }),
    });
    expect(result.current).toBe(true);
  });
});
