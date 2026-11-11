/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createLoadedSettings } from './settings.js';
import { describe, expect, it } from 'vitest';
import {
  getLoadableSettingScopes,
  isLoadableSettingScope,
  SettingScope,
  type SettingsFile,
} from './settings.js';

function emptyFile(): SettingsFile {
  return { path: '', settings: {}, originalSettings: {} };
}

describe('Settings scope names', () => {
  it('exposes only the canonical scope names and values', () => {
    expect(SettingScope).toEqual({
      User: 'User',
      Project: 'Project',
      Local: 'Local',
      Session: 'Session',
    });
    const scopes = getLoadableSettingScopes();
    expect(scopes).toEqual([
      SettingScope.User,
      SettingScope.Project,
      SettingScope.Local,
    ]);
    expect(new Set(scopes).size).toBe(scopes.length);
    expect(scopes.every(isLoadableSettingScope)).toBe(true);
    expect(isLoadableSettingScope(SettingScope.Session)).toBe(false);
  });

  it('routes project and local writes to their settings files and preserves precedence', () => {
    const settings = createLoadedSettings(
      emptyFile(),
      emptyFile(),
      emptyFile(),
      true,
    );
    expect(settings.forScope(SettingScope.Project)).toBe(settings.project);
    expect(settings.forScope(SettingScope.Local)).toBe(settings.local);
    expect(settings.setValue(SettingScope.Project, 'ui.theme', 'dark')).toBe(
      true,
    );
    expect(settings.setValue(SettingScope.Local, 'ui.theme', 'light')).toBe(
      true,
    );
    expect(settings.project.settings.ui?.theme).toBe('dark');
    expect(settings.local.settings.ui?.theme).toBe('light');
    expect(settings.merged.ui.theme).toBe('light');
    expect(settings.getSnapshot().project.settings).toEqual(
      settings.project.settings,
    );
    expect(settings.getSnapshot()).not.toHaveProperty('workspace');
    expect(settings).not.toHaveProperty('workspace');
  });

  it('keeps project snapshots filtered by trust and restores the backing settings', () => {
    const settings = createLoadedSettings(
      emptyFile(),
      emptyFile(),
      emptyFile(),
      true,
    );
    settings.setValue(SettingScope.User, 'ui.theme', 'user');
    settings.setValue(SettingScope.Project, 'ui.theme', 'project');
    settings.setTrusted(false);
    expect(settings.project.settings).toEqual({});
    expect(settings.getSnapshot().project.settings).toEqual({});
    expect(settings.merged.ui.theme).toBe('user');
    settings.setTrusted(true);
    expect(settings.project.settings.ui?.theme).toBe('project');
    expect(settings.getSnapshot().project.settings.ui?.theme).toBe('project');
    expect(settings.merged.ui.theme).toBe('project');
  });
});
