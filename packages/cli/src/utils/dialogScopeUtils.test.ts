/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SettingScope, type LoadedSettings } from '../config/settings.js';
import {
  getScopeItems,
  getScopeMessageForSetting,
} from './dialogScopeUtils.js';
import { isInSettingsScope } from './settingsUtils.js';

vi.mock('../config/settings', () => ({
  SettingScope: {
    User: 'user',
    Project: 'project',
  },
  getLoadableSettingScopes: () => ['user', 'project'],
}));

vi.mock('./settingsUtils', () => ({
  isInSettingsScope: vi.fn(),
}));

describe('dialogScopeUtils', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe('getScopeItems', () => {
    it('should return scope items with correct labels and values', () => {
      const items = getScopeItems();
      expect(items).toEqual([
        { label: 'User Settings', value: SettingScope.User },
        { label: 'Project Settings', value: SettingScope.Project },
      ]);
    });
  });

  describe('getScopeMessageForSetting', () => {
    let mockSettings: { forScope: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      mockSettings = {
        forScope: vi.fn().mockReturnValue({ settings: {} }),
      };
    });

    it('should return empty string if not modified in other scopes', () => {
      vi.mocked(isInSettingsScope).mockReturnValue(false);
      const message = getScopeMessageForSetting(
        'key',
        SettingScope.User,
        mockSettings as unknown as LoadedSettings,
      );
      expect(message).toBe('');
    });

    it('should return message indicating modification in other scopes', () => {
      vi.mocked(isInSettingsScope).mockReturnValue(true);

      const message = getScopeMessageForSetting(
        'key',
        SettingScope.User,
        mockSettings as unknown as LoadedSettings,
      );
      expect(message).toMatch(/Also modified in/);
      expect(message).toMatch(/Project/);
    });

    it('should return message indicating modification in other scopes but not current', () => {
      const projectSettings = { scope: 'workspace' };
      const userSettings = { scope: 'user' };

      mockSettings.forScope.mockImplementation((scope: string) => {
        if (scope === SettingScope.Project)
          return { settings: projectSettings };
        if (scope === SettingScope.User) return { settings: userSettings };
        return { settings: {} };
      });

      vi.mocked(isInSettingsScope).mockImplementation(
        (_key, settings: unknown) => {
          if (settings === projectSettings) return true;
          if (settings === userSettings) return false;
          return false;
        },
      );

      const message = getScopeMessageForSetting(
        'key',
        SettingScope.User,
        mockSettings as unknown as LoadedSettings,
      );
      expect(message).toBe('(Modified in Project)');
    });
  });
});
