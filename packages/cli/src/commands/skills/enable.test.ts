/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { resolveCommandSettings as loadSettings } from '../../config/createCliSettingsService.js';
vi.mock('../../config/createCliSettingsService.js', () => ({
  resolveCommandSettings: vi.fn(),
}));
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { handleEnable, createEnableCommand } from './enable.js';
import { SettingScope, type LoadedSettings } from '../../config/settings.js';

const { emitFeedback, coreEvents } = await vi.hoisted(async () => {
  const { createMockCoreFeedback } = await import(
    '../../test-utils/mockCoreFeedback.js'
  );
  return createMockCoreFeedback({ stripAnsi: true });
});

vi.mock('@qwen-code/core', async (importOriginal) => {
  const { withMockCoreFeedback } = await import(
    '../../test-utils/mockCoreFeedback.js'
  );
  return withMockCoreFeedback(
    await importOriginal<typeof import('@qwen-code/core')>(),
    coreEvents,
  );
});

vi.mock('../../config/settings.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../config/settings.js')>();
  return {
    ...actual,
    loadSettings: vi.fn(),
    isLoadableSettingScope: vi.fn((s) => s === 'User' || s === 'Project'),
  };
});

vi.mock('../../utils/exitCli.js', () => ({
  exitCli: vi.fn(),
}));

describe('skills enable command', () => {
  const mockLoadSettings = vi.mocked(loadSettings);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('handleEnable', () => {
    it('should enable a disabled skill in user scope', async () => {
      const mockSettings = {
        forScope: vi.fn().mockImplementation((scope) => {
          if (scope === SettingScope.User) {
            return {
              settings: { skills: { disabled: ['skill1'] } },
              path: '/user/settings.json',
            };
          }
          return { settings: {}, path: '/workspace/settings.json' };
        }),
        setValue: vi.fn(() => true),
      };
      mockLoadSettings.mockResolvedValue(
        mockSettings as unknown as LoadedSettings,
      );

      await handleEnable({ name: 'skill1' });

      expect(mockSettings.setValue).toHaveBeenCalledWith(
        SettingScope.User,
        'skills.disabled',
        [],
      );
      expect(emitFeedback).toHaveBeenCalledWith(
        'info',
        'Skill "skill1" enabled by removing it from the disabled list in user (/user/settings.json) and project (/workspace/settings.json) settings.',
      );
    });

    it('should enable a skill across multiple scopes', async () => {
      const mockSettings = {
        forScope: vi.fn().mockImplementation((scope) => {
          if (scope === SettingScope.User) {
            return {
              settings: { skills: { disabled: ['skill1'] } },
              path: '/user/settings.json',
            };
          }
          if (scope === SettingScope.Project) {
            return {
              settings: { skills: { disabled: ['skill1'] } },
              path: '/workspace/settings.json',
            };
          }
          return { settings: {}, path: '' };
        }),
        setValue: vi.fn(() => true),
      };
      mockLoadSettings.mockResolvedValue(
        mockSettings as unknown as LoadedSettings,
      );

      await handleEnable({ name: 'skill1' });

      expect(mockSettings.setValue).toHaveBeenCalledWith(
        SettingScope.User,
        'skills.disabled',
        [],
      );
      expect(mockSettings.setValue).toHaveBeenCalledWith(
        SettingScope.Project,
        'skills.disabled',
        [],
      );
      expect(emitFeedback).toHaveBeenCalledWith(
        'info',
        'Skill "skill1" enabled by removing it from the disabled list in project (/workspace/settings.json) and user (/user/settings.json) settings.',
      );
    });

    it('should log a message if the skill is already enabled', async () => {
      const mockSettings = {
        forScope: vi.fn().mockReturnValue({
          settings: { skills: { disabled: [] } },
          path: '/user/settings.json',
        }),
        setValue: vi.fn(() => true),
      };
      mockLoadSettings.mockResolvedValue(
        mockSettings as unknown as LoadedSettings,
      );

      await handleEnable({ name: 'skill1' });

      expect(mockSettings.setValue).not.toHaveBeenCalled();
      expect(emitFeedback).toHaveBeenCalledWith(
        'info',
        'Skill "skill1" is already enabled.',
      );
    });
  });

  describe('enableCommand', () => {
    it('should have correct command and describe', () => {
      const cmd = createEnableCommand();
      expect(cmd.name()).toBe('enable');
      expect(cmd.description()).toBe('Enables an agent skill.');
    });
  });
});
