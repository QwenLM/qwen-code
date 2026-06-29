/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  getSoftwareCursorBackground,
  renderSoftwareCursor,
} from './software-cursor.js';
import { themeManager } from '../themes/theme-manager.js';

describe('renderSoftwareCursor', () => {
  it('uses a dark cursor background on light themes', () => {
    expect(getSoftwareCursorBackground('#FAFAFA')).toBe('#3A3A3A');
  });

  it('uses a light cursor background on dark themes', () => {
    expect(getSoftwareCursorBackground('#002b36')).toBe('#D4D4D4');
  });

  it('handles named ANSI theme background colors', () => {
    expect(getSoftwareCursorBackground('white')).toBe('#3A3A3A');
    expect(getSoftwareCursorBackground('black')).toBe('#D4D4D4');
  });

  it('falls back to a light cursor background when the theme background is unknown', () => {
    expect(getSoftwareCursorBackground('')).toBe('#D4D4D4');
  });

  it('uses an explicit background instead of reverse-video styling', () => {
    const rendered = renderSoftwareCursor('x');

    expect(rendered).toContain('x');
    expect(rendered).not.toContain('\u001b[7m');
  });

  it('does not reset the surrounding foreground color', () => {
    const rendered = renderSoftwareCursor('x');

    expect(rendered).not.toContain('\u001b[39m');
  });

  it('renders an empty cursor cell as a space', () => {
    expect(renderSoftwareCursor('')).toContain(' ');
  });
});

describe('getSoftwareCursorBackground terminal-derived default', () => {
  function setDetectedTerminal(value: 'dark' | 'light') {
    (
      themeManager as unknown as { cachedAutoDetection: 'dark' | 'light' }
    ).cachedAutoDetection = value;
  }

  beforeEach(() => {
    (
      themeManager as unknown as {
        cachedAutoDetection: unknown;
        terminalBackground: unknown;
      }
    ).cachedAutoDetection = undefined;
    (
      themeManager as unknown as { terminalBackground: unknown }
    ).terminalBackground = undefined;
  });

  it('uses a light cursor on a dark terminal', () => {
    setDetectedTerminal('dark');
    expect(getSoftwareCursorBackground()).toBe('#D4D4D4');
  });

  it('uses a dark cursor on a light terminal', () => {
    setDetectedTerminal('light');
    expect(getSoftwareCursorBackground()).toBe('#3A3A3A');
  });

  it('derives contrast from the terminal, not the active theme', () => {
    // The TUI never paints the theme background, so a light theme forced onto a
    // dark terminal must still yield a light cursor that stays visible on the
    // dark terminal.
    themeManager.setActiveTheme('Qwen Light');
    setDetectedTerminal('dark');
    expect(getSoftwareCursorBackground()).toBe('#D4D4D4');
  });
});
