/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import process from 'node:process';
import { themeCommand } from './themeCommand.js';
import { type CommandContext } from './types.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import { SettingScope } from '../../config/settings.js';
import type { LoadedSettings } from '../../config/settings.js';
import { themeManager } from '../themes/theme-manager.js';

describe('themeCommand', () => {
  let mockContext: CommandContext;
  const previousNoColor = process.env['NO_COLOR'];

  beforeEach(() => {
    mockContext = createMockCommandContext();
    delete process.env['NO_COLOR'];
  });

  afterEach(() => {
    if (previousNoColor === undefined) delete process.env['NO_COLOR'];
    else process.env['NO_COLOR'] = previousNoColor;
  });

  it('should return a dialog action to open the theme dialog', () => {
    // Ensure the command has an action to test.
    if (!themeCommand.action) {
      throw new Error('The theme command must have an action.');
    }

    const result = themeCommand.action(mockContext, '');

    // Assert that the action returns the correct object to trigger the theme dialog.
    expect(result).toEqual({
      type: 'dialog',
      dialog: 'theme',
    });
  });

  it('returns a message instead of opening the dialog when NO_COLOR is set', () => {
    if (!themeCommand.action) {
      throw new Error('The theme command must have an action.');
    }
    process.env['NO_COLOR'] = '1';

    const result = themeCommand.action(mockContext, '');

    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: 'Theme configuration unavailable due to NO_COLOR env variable.',
    });
  });

  it('should have the correct name and description', () => {
    expect(themeCommand.name).toBe('theme');
    expect(themeCommand.description).toBe('change the theme');
    expect(themeCommand.canRunDuringStreaming).toBe(true);
  });
  describe('with a theme name', () => {
    const originalTheme = themeManager.getActiveTheme().name;

    function makeSettings(workspaceTheme?: string) {
      const merged: { ui: { theme?: string } } = { ui: {} };
      const settings = {
        user: { settings: { ui: {} } },
        workspace: {
          settings: { ui: workspaceTheme ? { theme: workspaceTheme } : {} },
        },
        merged,
        setValue: vi.fn((_scope: SettingScope, _key: string, value: string) => {
          merged.ui.theme = value;
        }),
      };
      return settings;
    }

    function run(args: string, settings = makeSettings()) {
      const onThemeChanged = vi.fn();
      const context = createMockCommandContext({
        services: { settings: settings as unknown as LoadedSettings },
        ui: { onThemeChanged },
      });
      const result = themeCommand.action!(context, args);
      return { result, settings, onThemeChanged };
    }

    afterEach(() => {
      themeManager.setActiveTheme(originalTheme);
    });

    it('switches to the named theme, saves it, and tells the renderer', () => {
      const { result, settings, onThemeChanged } = run('  ansi light ');

      expect(settings.setValue).toHaveBeenCalledWith(
        SettingScope.User,
        'ui.theme',
        'ANSI Light',
      );
      expect(themeManager.getActiveTheme().name).toBe('ANSI Light');
      expect(onThemeChanged).toHaveBeenCalledTimes(1);
      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: 'Theme set to ANSI Light.',
      });
    });

    it('saves to the workspace when the workspace already sets a theme', () => {
      const { settings } = run('ANSI', makeSettings('ANSI Light'));

      expect(settings.setValue).toHaveBeenCalledWith(
        SettingScope.Workspace,
        'ui.theme',
        'ANSI',
      );
      expect(themeManager.getActiveTheme().name).toBe('ANSI');
    });

    it('rejects an unknown name without saving or switching', () => {
      const before = themeManager.getActiveTheme().name;
      const { result, settings, onThemeChanged } = run('Draculaa');

      expect(settings.setValue).not.toHaveBeenCalled();
      expect(onThemeChanged).not.toHaveBeenCalled();
      expect(themeManager.getActiveTheme().name).toBe(before);
      expect(result).toMatchObject({ type: 'message', messageType: 'error' });
      expect((result as { content: string }).content).toContain(
        'Unknown theme "Draculaa"',
      );
    });

    it('still refuses when NO_COLOR is set', () => {
      process.env['NO_COLOR'] = '1';
      const { result, settings } = run('ANSI');

      expect(settings.setValue).not.toHaveBeenCalled();
      expect(result).toMatchObject({ type: 'message', messageType: 'info' });
    });
  });
});
