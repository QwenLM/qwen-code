/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

const mockResolve = vi.hoisted(() => vi.fn());
vi.mock('../../config/createCliSettingsService.js', () => ({
  createCliSettingsService: vi.fn(() => ({ resolve: mockResolve })),
}));
import {
  vi,
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  type MockInstance,
} from 'vitest';
import { type Config, type PluginManagerFactory } from '@qwen-code/core';
import { handleList, createListCommand } from './list.js';
import type { LoadedSettings } from '../../config/settings.js';
import { loadCliConfig } from '../../config/config.js';
import chalk from 'chalk';

vi.mock('@qwen-code/core', async (importOriginal) => {
  const { mockCoreDebugLogger } = await import(
    '../../test-utils/mockDebugLogger.js'
  );
  return mockCoreDebugLogger(
    await importOriginal<typeof import('@qwen-code/core')>(),
    {
      stripAnsi: false,
    },
  );
});

vi.mock('../../config/settings.js');
vi.mock('../../config/config.js');
vi.mock('../../utils/exitCli.js', () => ({
  exitCli: vi.fn(),
}));

describe('skills list command', () => {
  const mockLoadSettings = mockResolve;
  const mockLoadCliConfig = vi.mocked(loadCliConfig);
  let stdoutWriteSpy: MockInstance<typeof process.stdout.write>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockLoadSettings.mockReturnValue({
      merged: {},
    } as unknown as LoadedSettings);
    stdoutWriteSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('handleList', () => {
    it('passes a product plugin factory to discovery configuration', async () => {
      const pluginManagerFactory = vi.fn<PluginManagerFactory>();
      mockLoadCliConfig.mockResolvedValue({
        initialize: vi.fn().mockResolvedValue(undefined),
        getSkillManager: () => ({ getAllSkills: () => [] }),
      } as unknown as Config);

      await handleList({}, pluginManagerFactory);

      expect(mockLoadCliConfig.mock.calls[0]?.[3]).toEqual({
        cwd: process.cwd(),
        pluginManagerFactory,
      });
    });

    it('should log a message if no skills are discovered', async () => {
      const mockConfig = {
        initialize: vi.fn().mockResolvedValue(undefined),
        getSkillManager: vi.fn().mockReturnValue({
          getAllSkills: vi.fn().mockReturnValue([]),
        }),
      };
      mockLoadCliConfig.mockResolvedValue(mockConfig as unknown as Config);

      await handleList({});
      const loadedSettings = mockLoadSettings.mock.results[0]?.value;

      expect(mockLoadCliConfig).toHaveBeenCalledWith(
        loadedSettings,
        'skills-list-session',
        expect.anything(),
        { cwd: process.cwd() },
      );
      expect(mockLoadCliConfig.mock.calls[0]?.[0]).toBe(loadedSettings);

      expect(stdoutWriteSpy).toHaveBeenCalledWith('No skills discovered.\n');
    });

    it('should list all discovered skills', async () => {
      const skills = [
        {
          name: 'skill1',
          description: 'desc1',
          disabled: false,
          location: '/path/to/skill1',
        },
        {
          name: 'skill2',
          description: 'desc2',
          disabled: true,
          location: '/path/to/skill2',
        },
      ];
      const mockConfig = {
        initialize: vi.fn().mockResolvedValue(undefined),
        getSkillManager: vi.fn().mockReturnValue({
          getAllSkills: vi.fn().mockReturnValue(skills),
        }),
      };
      mockLoadCliConfig.mockResolvedValue(mockConfig as unknown as Config);

      await handleList({});

      expect(stdoutWriteSpy).toHaveBeenCalledWith(
        chalk.bold('Discovered Agent Skills:') + '\n\n',
      );
      expect(stdoutWriteSpy).toHaveBeenCalledWith(
        expect.stringContaining('skill1'),
      );
      expect(stdoutWriteSpy).toHaveBeenCalledWith(
        expect.stringContaining(chalk.green('[Enabled]')),
      );
      expect(stdoutWriteSpy).toHaveBeenCalledWith(
        expect.stringContaining('skill2'),
      );
      expect(stdoutWriteSpy).toHaveBeenCalledWith(
        expect.stringContaining(chalk.red('[Disabled]')),
      );
    });

    it('should filter built-in skills by default and show them with { all: true }', async () => {
      const skills = [
        {
          name: 'regular',
          description: 'desc1',
          disabled: false,
          location: '/loc1',
        },
        {
          name: 'builtin',
          description: 'desc2',
          disabled: false,
          location: '/loc2',
          isBuiltin: true,
        },
      ];
      const mockConfig = {
        initialize: vi.fn().mockResolvedValue(undefined),
        getSkillManager: vi.fn().mockReturnValue({
          getAllSkills: vi.fn().mockReturnValue(skills),
        }),
      };
      mockLoadCliConfig.mockResolvedValue(mockConfig as unknown as Config);

      // Default
      await handleList({ all: false });
      expect(stdoutWriteSpy).toHaveBeenCalledWith(
        expect.stringContaining('regular'),
      );
      expect(stdoutWriteSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('builtin'),
      );

      vi.clearAllMocks();

      // With all: true
      await handleList({ all: true });
      expect(stdoutWriteSpy).toHaveBeenCalledWith(
        expect.stringContaining('regular'),
      );
      expect(stdoutWriteSpy).toHaveBeenCalledWith(
        expect.stringContaining('builtin'),
      );
      expect(stdoutWriteSpy).toHaveBeenCalledWith(
        expect.stringContaining(chalk.gray(' [Built-in]')),
      );
    });

    it('should throw an error when listing fails', async () => {
      mockLoadCliConfig.mockRejectedValue(new Error('List failed'));

      await expect(handleList({})).rejects.toThrow('List failed');
    });
  });

  describe('listCommand', () => {
    it('should have correct command and describe', () => {
      const cmd = createListCommand();
      expect(cmd.name()).toBe('list');
      expect(cmd.description()).toBe('Lists discovered agent skills.');
    });
  });
});
