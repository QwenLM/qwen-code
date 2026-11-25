/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '../../test-utils/render.js';
import {
  useAlternateBuffer,
  isAlternateBufferEnabled,
} from './useAlternateBuffer.js';
import type { Config } from '@qwen-code/core';

vi.mock('../contexts/ConfigContext.js', () => ({
  useConfig: vi.fn(),
}));

const mockUseConfig = vi.mocked(
  await import('../contexts/ConfigContext.js').then((m) => m.useConfig),
);

describe('useAlternateBuffer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return false when config.getUseAlternateBuffer returns false', async () => {
    mockUseConfig.mockReturnValue({
      getUseAlternateBuffer: () => false,
      getUseTerminalBuffer: () => false,
      getScreenReader: () => false,
    } as unknown as ReturnType<typeof mockUseConfig>);

    const { result } = await renderHook(() => useAlternateBuffer());
    expect(result.current).toBe(false);
  });

  it('should return true when config.getUseAlternateBuffer returns true', async () => {
    mockUseConfig.mockReturnValue({
      getUseAlternateBuffer: () => true,
      getUseTerminalBuffer: () => false,
      getScreenReader: () => false,
    } as unknown as ReturnType<typeof mockUseConfig>);

    const { result } = await renderHook(() => useAlternateBuffer());
    expect(result.current).toBe(true);
  });

  it('should keep the enabled value stable across rerenders', async () => {
    const mockConfig = {
      getUseAlternateBuffer: () => true,
      getUseTerminalBuffer: () => false,
      getScreenReader: () => false,
    } as unknown as ReturnType<typeof mockUseConfig>;

    mockUseConfig.mockReturnValue(mockConfig);

    const { result, rerender } = await renderHook(() => useAlternateBuffer());

    expect(result.current).toBe(true);

    rerender();

    expect(result.current).toBe(true);
  });
});

describe('isAlternateBufferEnabled', () => {
  // The layout must match the alternate-screen decision in interactiveCli:
  // Ink clips alternate-screen frames to the terminal rows, so the
  // main-screen layout would push the composer below the viewport.
  it('should return true when config.getUseAlternateBuffer returns true', () => {
    const config = {
      getUseAlternateBuffer: () => true,
      getUseTerminalBuffer: () => false,
      getScreenReader: () => false,
    } as unknown as Config;

    expect(isAlternateBufferEnabled(config)).toBe(true);
  });

  it('should return false when the screen reader keeps the main screen', () => {
    const config = {
      getUseAlternateBuffer: () => true,
      getUseTerminalBuffer: () => false,
      getScreenReader: () => true,
    } as unknown as Config;

    expect(isAlternateBufferEnabled(config)).toBe(false);
  });

  it('should return false when config.getUseAlternateBuffer returns false', () => {
    const config = {
      getUseAlternateBuffer: () => false,
      getUseTerminalBuffer: () => false,
      getScreenReader: () => false,
    } as unknown as Config;

    expect(isAlternateBufferEnabled(config)).toBe(false);
  });

  it('should return false when config.getUseTerminalBuffer returns true', () => {
    const config = {
      getUseAlternateBuffer: () => false,
      getUseTerminalBuffer: () => true,
      getScreenReader: () => false,
    } as unknown as Config;

    expect(isAlternateBufferEnabled(config)).toBe(false);
  });
});
