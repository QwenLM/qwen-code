/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import chalk from 'chalk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  compositionOverlaysSoftwareCursor,
  getSoftwareCursorBackground,
  renderSoftwareCursor,
} from './software-cursor.js';
import { themeManager } from '../themes/theme-manager.js';

describe('renderSoftwareCursor', () => {
  const originalChalkLevel = chalk.level;

  beforeEach(() => {
    chalk.level = 3;
  });

  afterEach(() => {
    chalk.level = originalChalkLevel;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

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
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    vi.stubEnv('TMUX', undefined);
    const rendered = renderSoftwareCursor('x');

    expect(rendered).toContain('x');
    expect(rendered).toContain('\u001b[48;2;');
    expect(rendered).not.toContain('\u001b[7m');
  });

  it('keeps the Windows IME composition cell free of a fixed background', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const rendered = renderSoftwareCursor('x');

    expect(rendered).toBe('\u001b[4mx\u001b[24m');
    expect(rendered).not.toContain('\u001b[48;');
    expect(rendered).not.toContain('\u001b[7m');
  });

  it('keeps the tmux IME composition cell free of a fixed background (#8177)', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    vi.stubEnv('TMUX', '/tmp/tmux-1000/default,4242,0');
    const rendered = renderSoftwareCursor('x');

    // tmux cannot apply frames atomically (no DECSET 2026 support in
    // tmux <= 3.6), so the preedit string is repainted on the cursor cell
    // mid-composition; a fixed background there corrupts the composition
    // overlay. Underline leaves the cell's background untouched.
    expect(rendered).toBe('\u001b[4mx\u001b[24m');
    expect(rendered).not.toContain('\u001b[48;');
    expect(rendered).not.toContain('\u001b[7m');
  });

  it('restores the block cursor under tmux when synchronized output is forced on', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    vi.stubEnv('TMUX', '/tmp/tmux-1000/default,4242,0');
    vi.stubEnv('QWEN_CODE_SYNCHRONIZED_OUTPUT', '1');
    const rendered = renderSoftwareCursor('x');

    // Atomic frames protect the preedit cell, so the high-contrast block
    // cursor is safe again (future tmux releases with 2026 support).
    expect(rendered).toContain('\u001b[48;2;');
    expect(rendered).not.toContain('\u001b[4m');
  });

  it('renders an empty tmux cursor cell as an underlined space', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    vi.stubEnv('TMUX', '/tmp/tmux-1000/default,4242,0');
    expect(renderSoftwareCursor('')).toBe('\u001b[4m \u001b[24m');
  });

  it('does not reset the surrounding foreground color', () => {
    const rendered = renderSoftwareCursor('x');

    expect(rendered).not.toContain('\u001b[39m');
  });

  it('renders an empty cursor cell as a space', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    expect(renderSoftwareCursor('')).toBe('\u001b[4m \u001b[24m');
  });
});

describe('compositionOverlaysSoftwareCursor', () => {
  it('is always true on Windows (terminal composition highlight)', () => {
    expect(compositionOverlaysSoftwareCursor({}, 'win32')).toBe(true);
  });

  it('is false outside tmux on macOS/Linux', () => {
    expect(compositionOverlaysSoftwareCursor({}, 'darwin')).toBe(false);
    expect(compositionOverlaysSoftwareCursor({}, 'linux')).toBe(false);
  });

  it('is true inside tmux sessions', () => {
    expect(
      compositionOverlaysSoftwareCursor(
        { TMUX: '/tmp/tmux-1000/default,4242,0' },
        'darwin',
      ),
    ).toBe(true);
    expect(
      compositionOverlaysSoftwareCursor(
        { TMUX: '/tmp/tmux-1000/default,4242,0' },
        'linux',
      ),
    ).toBe(true);
  });

  it('is false inside tmux when synchronized output is forced on', () => {
    expect(
      compositionOverlaysSoftwareCursor(
        {
          TMUX: '/tmp/tmux-1000/default,4242,0',
          QWEN_CODE_SYNCHRONIZED_OUTPUT: '1',
        },
        'darwin',
      ),
    ).toBe(false);
    expect(
      compositionOverlaysSoftwareCursor(
        {
          TMUX: '/tmp/tmux-1000/default,4242,0',
          QWEN_CODE_FORCE_SYNCHRONIZED_OUTPUT: '1',
        },
        'darwin',
      ),
    ).toBe(false);
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
