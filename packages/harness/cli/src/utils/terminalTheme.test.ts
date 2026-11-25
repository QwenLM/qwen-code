/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { coreEvents, makeFakeConfig, type Config } from '@qwen-code/core';
import os from 'node:os';
import { setupTerminalAndTheme } from './terminalTheme.js';
import { themeManager, DEFAULT_THEME } from '../ui/themes/theme-manager.js';
import { createMockSettings } from '../test-utils/settings.js';
import { terminalCapabilityManager } from '../ui/utils/terminalCapabilityManager.js';

/**
 * These cover the startup half of "follow the terminal background": the theme
 * must be right on the first frame, and the mismatch warning must only fire
 * when the user pinned a theme AND the background is unambiguously the other
 * type.
 */
describe('setupTerminalAndTheme', () => {
  let config: Config;
  let feedback: ReturnType<typeof vi.fn>;
  let originalIsTTY: boolean | undefined;

  const withBackground = (color: string | undefined) => {
    vi.spyOn(
      terminalCapabilityManager,
      'getTerminalBackgroundColor',
    ).mockReturnValue(color);
    vi.spyOn(terminalCapabilityManager, 'detectCapabilities').mockResolvedValue(
      undefined,
    );
  };

  beforeEach(() => {
    config = makeFakeConfig({ targetDir: os.tmpdir() });
    // The background is only read on the interactive TTY path, so both have to
    // be true; detectCapabilities is stubbed so no real probe is written.
    vi.spyOn(config, 'isInteractive').mockReturnValue(true);
    originalIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', {
      value: true,
      configurable: true,
      writable: true,
    });
    feedback = vi.fn();
    vi.spyOn(coreEvents, 'emitFeedback').mockImplementation(
      feedback as unknown as typeof coreEvents.emitFeedback,
    );
    themeManager.setActiveTheme(DEFAULT_THEME.name);
    themeManager.setTerminalBackground(undefined);
  });

  afterEach(() => {
    Object.defineProperty(process.stdin, 'isTTY', {
      value: originalIsTTY,
      configurable: true,
      writable: true,
    });
    vi.restoreAllMocks();
  });

  const setup = async (settingsObj: object, background?: string) => {
    withBackground(background);
    await setupTerminalAndTheme(config, createMockSettings(settingsObj));
  };

  it('renders a light theme on a light background when ui.theme is auto', async () => {
    await setup({ ui: { theme: 'auto' } }, '#ffffff');

    expect(themeManager.getThemeName()).toBe('Default Light');
    expect(feedback).not.toHaveBeenCalled();
  });

  it('renders a dark theme on a dark background when ui.theme is auto', async () => {
    await setup({ ui: { theme: 'auto' } }, '#000000');

    expect(themeManager.getThemeName()).toBe(DEFAULT_THEME.name);
    expect(feedback).not.toHaveBeenCalled();
  });

  it('honours ui.autoThemePair', async () => {
    await setup(
      {
        ui: {
          theme: 'auto',
          autoThemePair: { dark: 'Dracula', light: 'GitHub Light' },
        },
      },
      '#ffffff',
    );

    expect(themeManager.getThemeName()).toBe('GitHub Light');
  });

  it('never warns in auto mode', async () => {
    // A background that would be "wrong" for whatever we happened to pick is
    // impossible in auto mode, but assert it explicitly: auto must be silent.
    await setup({ ui: { theme: 'auto' } }, '#c0c0c0');
    expect(feedback).not.toHaveBeenCalled();
  });

  it('keeps a pinned theme and warns on an unambiguous mismatch', async () => {
    await setup({ ui: { theme: 'GitHub' } }, '#ffffff');

    expect(themeManager.getThemeName()).toBe('GitHub');
    expect(feedback).toHaveBeenCalledWith(
      'warning',
      expect.stringContaining('might look incorrect'),
    );
  });

  it('does not warn for a pinned theme inside the ambiguous band', async () => {
    // #c0c0c0 is luminance 134.4. The old code called this "light" and warned
    // forever while auto-switching never acted on it.
    await setup({ ui: { theme: 'Default' } }, '#c0c0c0');

    expect(themeManager.getThemeName()).toBe('Default');
    expect(feedback).not.toHaveBeenCalled();
  });

  it('does not warn when a pinned theme matches the background', async () => {
    await setup({ ui: { theme: 'Default' } }, '#000000');
    expect(feedback).not.toHaveBeenCalled();
  });

  it('resolves an unset theme from the background, as before', async () => {
    await setup({ ui: {} }, '#ffffff');

    expect(themeManager.getThemeName()).toBe('Default Light');
    expect(feedback).not.toHaveBeenCalled();
  });

  it('falls back to the dark default when no background was detected', async () => {
    await setup({ ui: { theme: 'auto' } }, undefined);

    expect(themeManager.getThemeName()).toBe(DEFAULT_THEME.name);
    expect(feedback).not.toHaveBeenCalled();
  });
});
