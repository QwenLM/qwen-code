/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  useVirtualViewport,
  VirtualViewportContext,
} from './VirtualViewportContext.js';

const wrapper = (value: boolean) =>
  function VirtualViewportWrapper({ children }: { children: React.ReactNode }) {
    return (
      <VirtualViewportContext.Provider value={value}>
        {children}
      </VirtualViewportContext.Provider>
    );
  };

describe('useVirtualViewport', () => {
  it('uses the fallback outside the app provider', () => {
    expect(renderHook(() => useVirtualViewport()).result.current).toBe(false);
    expect(renderHook(() => useVirtualViewport(true)).result.current).toBe(
      true,
    );
  });

  it('gives the startup decision precedence over the fallback', () => {
    expect(
      renderHook(() => useVirtualViewport(true), {
        wrapper: wrapper(false),
      }).result.current,
    ).toBe(false);
    expect(
      renderHook(() => useVirtualViewport(false), {
        wrapper: wrapper(true),
      }).result.current,
    ).toBe(true);
  });
});
