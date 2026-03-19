/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

describe('formatShortcut', () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    vi.resetModules();
  });

  it('converts modifier keys to Mac symbols on darwin', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const { formatShortcut } = await import('./shortcutFormatter.js');
    expect(formatShortcut('ctrl+y')).toBe('⌃Y');
    expect(formatShortcut('cmd+v')).toBe('⌘V');
    expect(formatShortcut('alt+v')).toBe('⌥V');
    expect(formatShortcut('shift+tab')).toBe('⇧TAB');
  });

  it('handles multi-part shortcuts on darwin', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const { formatShortcut } = await import('./shortcutFormatter.js');
    expect(formatShortcut('esc esc')).toBe('ESC ESC');
  });

  it('returns input unchanged on non-darwin', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const { formatShortcut } = await import('./shortcutFormatter.js');
    expect(formatShortcut('ctrl+y')).toBe('ctrl+y');
    expect(formatShortcut('ctrl+c')).toBe('ctrl+c');
  });
});
