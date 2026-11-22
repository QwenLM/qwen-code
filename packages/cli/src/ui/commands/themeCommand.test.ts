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
import { applyThemeSetting } from '../themes/theme-selection.js';

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
        undefined,
        { throwOnWriteFailure: true },
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
        undefined,
        { throwOnWriteFailure: true },
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
        undefined,
        { throwOnWriteFailure: true },
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
      const { result, settings, onThemeChanged } = run('ANSI');

      expect(onThemeChanged).not.toHaveBeenCalled();
      expect(settings.user.settings.ui?.theme).toBeUndefined();
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
        undefined,
        { throwOnWriteFailure: true },
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
            ui: {
              customThemes: {
                'Team Theme': { name: 'Team Theme', type: 'custom' },
              },
            },
          },
        }),
      );

      expect(setValue).toHaveBeenCalledWith(
        SettingScope.Workspace,
        'ui.theme',
        'Team Theme',
        undefined,
        { throwOnWriteFailure: true },
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
            ui: {
              customThemes: {
                'Team Theme': { name: 'Team Theme', type: 'custom' },
              },
            },
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
            ui: {
              customThemes: { dracula: { name: 'dracula', type: 'custom' } },
            },
          },
        }),
      );

      expect(setValue).toHaveBeenCalledWith(
        SettingScope.User,
        'ui.theme',
        'dracula',
        undefined,
        { throwOnWriteFailure: true },
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

    it('switches to auto and saves it', () => {
      const { result, setValue, settings } = run('auto');

      expect(setValue).toHaveBeenCalledWith(
        SettingScope.User,
        'ui.theme',
        'auto',
        undefined,
        { throwOnWriteFailure: true },
      );
      expect(settings.user.settings.ui?.theme).toBe('auto');
      expect(['Qwen Dark', 'Qwen Light']).toContain(
        themeManager.getActiveTheme().name,
      );
      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: 'Theme set to auto (user settings).',
      });
    });

    it('accepts a custom theme defined only in system settings', () => {
      const { result, setValue } = run(
        'Brand',
        makeSettings({
          system: {
            ui: { customThemes: { Brand: { name: 'Brand', type: 'custom' } } },
          },
        }),
      );

      expect(setValue).toHaveBeenCalledWith(
        SettingScope.User,
        'ui.theme',
        'Brand',
        undefined,
        { throwOnWriteFailure: true },
      );
      expect(result).toMatchObject({ messageType: 'info' });
    });

    it('treats a custom theme key that reads as a file path as unknown', () => {
      const { result, setValue, settings } = run(
        'night.json',
        makeSettings({
          user: {
            ui: {
              customThemes: {
                'night.json': { name: 'night.json', type: 'custom' },
              },
            },
          },
        }),
      );

      expect(setValue).not.toHaveBeenCalled();
      expect(settings.user.settings.ui?.theme).toBeUndefined();
      expect(content(result)).toContain('Unknown theme "night.json"');
    });

    it('keeps an aliased custom theme active after an unknown name', () => {
      const settings = makeSettings({
        user: {
          ui: {
            customThemes: { Alias: { name: 'Shown Name', type: 'custom' } },
          },
        },
      });
      run('alias', settings);
      expect(themeManager.getActiveTheme().name).toBe('Shown Name');

      const { result } = run('Draculaa', settings);

      expect(result).toMatchObject({ messageType: 'error' });
      expect(themeManager.getActiveTheme().name).toBe('Shown Name');
    });

    describe('applyThemeSetting', () => {
      it('writes nothing when system settings pin the theme', () => {
        const settings = makeSettings({
          system: { ui: { theme: 'Qwen Light' } },
        });
        const setValue = vi.spyOn(settings, 'setValue');

        const outcome = applyThemeSetting(
          settings,
          SettingScope.User,
          'Dracula',
        );

        expect(outcome).toMatchObject({ applied: false, pinnedBySystem: true });
        expect(setValue).not.toHaveBeenCalled();
        expect(settings.user.settings.ui?.theme).toBeUndefined();
      });

      it('keeps a failed write through the untrusted redirect out of both files', () => {
        vi.spyOn(themeManager, 'setActiveTheme').mockImplementation(
          (name) => name !== 'Qwen Light',
        );
        const settings = makeSettings({
          workspace: { ui: { theme: 'ANSI Light' } },
          isTrusted: false,
        });

        const outcome = applyThemeSetting(
          settings,
          SettingScope.Workspace,
          'Qwen Light',
        );

        expect(outcome.applied).toBe(false);
        expect(settings.user.settings.ui?.theme).toBeUndefined();
        expect(settings.workspace.settings.ui?.theme).toBe('ANSI Light');
      });

      it('keeps a pick that a broken theme in another scope overrides', () => {
        const settings = makeSettings({
          workspace: { ui: { theme: 'NotATheme' } },
        });

        const outcome = applyThemeSetting(
          settings,
          SettingScope.User,
          'Qwen Light',
        );

        expect(outcome).toMatchObject({
          effective: 'NotATheme',
          applied: false,
        });
        expect(settings.user.settings.ui?.theme).toBe('Qwen Light');
      });

      it('removes a failed write again so the lower scope theme shows through', () => {
        vi.spyOn(themeManager, 'setActiveTheme').mockImplementation(
          (name) => name !== 'Qwen Light',
        );
        const settings = makeSettings({
          user: { ui: { theme: 'Dracula' } },
          workspace: { ui: { customThemes: {} } },
        });

        const outcome = applyThemeSetting(
          settings,
          SettingScope.Workspace,
          'Qwen Light',
        );

        expect(outcome.applied).toBe(false);
        expect(settings.merged.ui?.theme).toBe('Dracula');
        expect(settings.workspace.settings.ui).not.toHaveProperty('theme');
      });

      it('saves to user settings when asked for an untrusted workspace', () => {
        const settings = makeSettings({ isTrusted: false });

        const outcome = applyThemeSetting(
          settings,
          SettingScope.Workspace,
          'ANSI',
        );

        expect(outcome).toEqual({
          effective: 'ANSI',
          applied: true,
          scope: SettingScope.User,
        });
        expect(settings.user.settings.ui?.theme).toBe('ANSI');
        expect(settings.workspace.settings.ui?.theme).toBeUndefined();
      });
    });

    it('reports an error and changes nothing when the settings file cannot be saved', () => {
      const settings = makeSettings();
      const userFile = settings.user.path;
      fs.mkdirSync(path.dirname(userFile), { recursive: true });
      fs.writeFileSync(userFile, '{ not json');
      const before = themeManager.getActiveTheme().name;

      const { result, onThemeChanged } = run('ANSI', settings);

      expect(result).toEqual({
        type: 'message',
        messageType: 'error',
        content: 'Theme "ANSI" could not be applied.',
      });
      expect(onThemeChanged).not.toHaveBeenCalled();
      expect(settings.merged.ui?.theme).toBeUndefined();
      expect(themeManager.getActiveTheme().name).toBe(before);
      expect(fs.readFileSync(userFile, 'utf-8')).toBe('{ not json');
    });

    it('still refuses when NO_COLOR is set', () => {
      process.env['NO_COLOR'] = '1';
      const { result, setValue } = run('ANSI');

      expect(setValue).not.toHaveBeenCalled();
      expect(result).toMatchObject({ type: 'message', messageType: 'info' });
    });
  });
});
