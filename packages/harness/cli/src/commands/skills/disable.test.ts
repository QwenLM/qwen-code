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
import { handleDisable, createDisableCommand } from './disable.js';
import {
  SettingScope,
  type LoadedSettings,
  type LoadableSettingScope,
} from '../../config/settings.js';
import { CONFIG_DIR } from '@qwen-code/core';

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

describe('skills disable command', () => {
  const mockLoadSettings = vi.mocked(loadSettings);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('handleDisable', () => {
    it('should disable an enabled skill in user scope', async () => {
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

      await handleDisable({
        name: 'skill1',
        scope: SettingScope.User as LoadableSettingScope,
      });

      expect(mockSettings.setValue).toHaveBeenCalledWith(
        SettingScope.User,
        'skills.disabled',
        ['skill1'],
      );
      expect(emitFeedback).toHaveBeenCalledWith(
        'info',
        'Skill "skill1" disabled by adding it to the disabled list in user (/user/settings.json) settings.',
      );
    });

    it('should disable an enabled skill in workspace scope', async () => {
      const mockSettings = {
        forScope: vi.fn().mockReturnValue({
          settings: { skills: { disabled: [] } },
          path: `/workspace/${CONFIG_DIR}/settings.json`,
        }),
        setValue: vi.fn(() => true),
      };
      mockLoadSettings.mockResolvedValue(
        mockSettings as unknown as LoadedSettings,
      );

      await handleDisable({
        name: 'skill1',
        scope: SettingScope.Project as LoadableSettingScope,
      });

      expect(mockSettings.setValue).toHaveBeenCalledWith(
        SettingScope.Project,
        'skills.disabled',
        ['skill1'],
      );
      expect(emitFeedback).toHaveBeenCalledWith(
        'info',
        `Skill "skill1" disabled by adding it to the disabled list in project (/workspace/${CONFIG_DIR}/settings.json) settings.`,
      );
    });

    it('should log a message if the skill is already disabled', async () => {
      const mockSettings = {
        forScope: vi.fn().mockReturnValue({
          settings: { skills: { disabled: ['skill1'] } },
          path: '/user/settings.json',
        }),
        setValue: vi.fn(() => true),
      };
      vi.mocked(loadSettings).mockResolvedValue(
        mockSettings as unknown as LoadedSettings,
      );

      await handleDisable({ name: 'skill1', scope: SettingScope.User });

      expect(mockSettings.setValue).not.toHaveBeenCalled();
      expect(emitFeedback).toHaveBeenCalledWith(
        'info',
        'Skill "skill1" is already disabled.',
      );
    });
  });

  describe('disableCommand', () => {
    it('should have correct command and describe', () => {
      const cmd = createDisableCommand();
      expect(cmd.name()).toBe('disable');
      expect(cmd.description()).toBe('Disables an agent skill.');
    });

    it('should accept the project alias while defaulting to workspace', () => {
      const cmd = createDisableCommand();
      const scopeOption = cmd.options.find((o) => o.long === '--scope');
      expect(scopeOption?.short).toBe('-s');
      expect(scopeOption?.argChoices).toEqual([
        'user',
        'workspace',
        'project',
      ]);
      expect(scopeOption?.defaultValue).toBe('workspace');
    });
  });
});
