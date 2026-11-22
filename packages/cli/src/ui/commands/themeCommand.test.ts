/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import process from 'node:process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { themeCommand } from './themeCommand.js';
import { type CommandContext } from './types.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import { LoadedSettings, SettingScope } from '../../config/settings.js';
import type { Settings, SettingsFile } from '../../config/settings.js';
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
    let tmpDir: string;

    interface Scopes {
      system?: Settings;
      user?: Settings;
      workspace?: Settings;
      isTrusted?: boolean;
    }

    function file(name: string, settings: Settings = {}): SettingsFile {
      return {
        settings: structuredClone(settings),
        originalSettings: structuredClone(settings),
        path: path.join(tmpDir, name, 'settings.json'),
      };
    }

    // A real LoadedSettings, so merging, trust and scope handling behave as
    // they do at runtime. setValue persists into the temp dir.
    function makeSettings({
      system,
      user,
      workspace,
      isTrusted = true,
    }: Scopes = {}): LoadedSettings {
      return new LoadedSettings(
        file('system', system),
        file('system-defaults'),
        file('user', user),
        file('workspace', workspace),
        isTrusted,
        new Set(),
      );
    }

    function run(args: string, settings: LoadedSettings = makeSettings()) {
      const setValue = vi.spyOn(settings, 'setValue');
      const onThemeChanged = vi.fn();
      const context = createMockCommandContext({ ui: { onThemeChanged } });
      // Assigned after creation: the mock context's deep merge would strip
      // the LoadedSettings prototype.
      context.services.settings = settings;
      const result = themeCommand.action!(context, args);
      return { result, settings, setValue, onThemeChanged };
    }

    function content(result: unknown): string {
      return (result as { content: string }).content;
    }

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'theme-command-'));
    });

    afterEach(() => {
      vi.restoreAllMocks();
      themeManager.loadCustomThemes(undefined);
      themeManager.setActiveTheme(originalTheme);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('switches to the named theme, saves it, and tells the renderer', () => {
      const { result, setValue, settings, onThemeChanged } =
        run('  ansi light ');

      expect(setValue).toHaveBeenCalledWith(
        SettingScope.User,
        'ui.theme',
        'ANSI Light',
      );
      expect(settings.user.settings.ui?.theme).toBe('ANSI Light');
      expect(themeManager.getActiveTheme().name).toBe('ANSI Light');
      expect(onThemeChanged).toHaveBeenCalledTimes(1);
      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: 'Theme set to ANSI Light (user settings).',
      });
    });

    it('saves to the workspace when a trusted workspace already sets a theme', () => {
      const { result, setValue } = run(
        'ANSI',
        makeSettings({ workspace: { ui: { theme: 'ANSI Light' } } }),
      );

      expect(setValue).toHaveBeenCalledWith(
        SettingScope.Workspace,
        'ui.theme',
        'ANSI',
      );
      expect(themeManager.getActiveTheme().name).toBe('ANSI');
      expect(content(result)).toBe('Theme set to ANSI (project settings).');
    });

    it('saves to user settings when an untrusted workspace sets a theme', () => {
      const { result, setValue, settings } = run(
        'ANSI',
        makeSettings({
          workspace: { ui: { theme: 'ANSI Light' } },
          isTrusted: false,
        }),
      );

      expect(setValue).toHaveBeenCalledTimes(1);
      expect(setValue).toHaveBeenCalledWith(
        SettingScope.User,
        'ui.theme',
        'ANSI',
      );
      expect(settings.workspace.settings.ui?.theme).toBe('ANSI Light');
      expect(settings.merged.ui?.theme).toBe('ANSI');
      expect(themeManager.getActiveTheme().name).toBe('ANSI');
      expect(content(result)).toBe('Theme set to ANSI (user settings).');
    });

    it('refuses when system settings pin the theme', () => {
      const before = themeManager.getActiveTheme().name;
      const { result, setValue, onThemeChanged } = run(
        'ANSI',
        makeSettings({ system: { ui: { theme: 'ANSI Light' } } }),
      );

      expect(setValue).not.toHaveBeenCalled();
      expect(onThemeChanged).not.toHaveBeenCalled();
      expect(themeManager.getActiveTheme().name).toBe(before);
      expect(result).toEqual({
        type: 'message',
        messageType: 'error',
        content:
          'The theme is set in system settings, so /theme cannot change it.',
      });
    });

    it('reports an error instead of success when the theme cannot be activated', () => {
      vi.spyOn(themeManager, 'setActiveTheme').mockReturnValue(false);
      const { result, onThemeChanged } = run('ANSI');

      expect(onThemeChanged).not.toHaveBeenCalled();
      expect(result).toEqual({
        type: 'message',
        messageType: 'error',
        content: 'Theme "ANSI" could not be applied.',
      });
    });

    it('accepts a custom theme by its settings key, not its display name', () => {
      const settings = makeSettings({
        user: {
          ui: {
            customThemes: {
              Alias: { name: 'Shown Name', type: 'custom' },
            },
          },
        },
      });

      const byName = run('Shown Name', settings);
      expect(byName.setValue).not.toHaveBeenCalled();
      expect(byName.result).toMatchObject({ messageType: 'error' });
      expect(content(byName.result)).toContain('Unknown theme "Shown Name"');
      byName.setValue.mockRestore();

      const byKey = run('alias', settings);
      expect(byKey.setValue).toHaveBeenCalledWith(
        SettingScope.User,
        'ui.theme',
        'Alias',
      );
      expect(themeManager.getActiveTheme().name).toBe('Shown Name');
      expect(content(byKey.result)).toBe('Theme set to Alias (user settings).');
    });

    it('treats a custom theme that fails validation as unknown', () => {
      const { result, setValue } = run(
        'Broken',
        makeSettings({
          user: {
            ui: { customThemes: { Broken: { name: '   ', type: 'custom' } } },
          },
        }),
      );

      expect(setValue).not.toHaveBeenCalled();
      expect(content(result)).toContain('Unknown theme "Broken"');
      expect(content(result)).not.toContain('Broken,');
    });

    it('saves a trusted workspace-only custom theme to the workspace', () => {
      const { result, setValue } = run(
        'Team Theme',
        makeSettings({
          workspace: {
            ui: { customThemes: { 'Team Theme': { type: 'custom' } } },
          },
        }),
      );

      expect(setValue).toHaveBeenCalledWith(
        SettingScope.Workspace,
        'ui.theme',
        'Team Theme',
      );
      expect(themeManager.getActiveTheme().name).toBe('Team Theme');
      expect(content(result)).toBe(
        'Theme set to Team Theme (project settings).',
      );
    });

    it('ignores custom themes from an untrusted workspace', () => {
      const { result, setValue } = run(
        'Team Theme',
        makeSettings({
          workspace: {
            ui: { customThemes: { 'Team Theme': { type: 'custom' } } },
          },
          isTrusted: false,
        }),
      );

      expect(setValue).not.toHaveBeenCalled();
      expect(content(result)).toContain('Unknown theme "Team Theme"');
    });

    it('prefers an exact custom key over a case-insensitive built-in match', () => {
      const { result, setValue } = run(
        'dracula',
        makeSettings({
          user: {
            ui: { customThemes: { dracula: { type: 'custom' } } },
          },
        }),
      );

      expect(setValue).toHaveBeenCalledWith(
        SettingScope.User,
        'ui.theme',
        'dracula',
      );
      expect(themeManager.getActiveTheme().type).toBe('custom');
      expect(content(result)).toBe('Theme set to dracula (user settings).');
    });

    it('rejects an unknown name without saving or switching', () => {
      const before = themeManager.getActiveTheme().name;
      const { result, setValue, onThemeChanged } = run('Draculaa');

      expect(setValue).not.toHaveBeenCalled();
      expect(onThemeChanged).not.toHaveBeenCalled();
      expect(themeManager.getActiveTheme().name).toBe(before);
      expect(result).toMatchObject({ type: 'message', messageType: 'error' });
      expect(content(result)).toContain('Unknown theme "Draculaa"');
    });

    it('still refuses when NO_COLOR is set', () => {
      process.env['NO_COLOR'] = '1';
      const { result, setValue } = run('ANSI');

      expect(setValue).not.toHaveBeenCalled();
      expect(result).toMatchObject({ type: 'message', messageType: 'info' });
    });
  });
});
