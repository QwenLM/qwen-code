/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { ENV_CONFIG_DIR } from '@qwen-code/core';
import { loadSettings } from '../test-utils/resolveSettings.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ProjectResource,
  type ResourceService,
} from '@qwen-code/resource';
import {
  type Config,
  PluginManager,
} from '@qwen-code/core';
import {
  loadCliConfig as baseLoadCliConfig,
  type CliArgs,
  type LoadCliConfigOptions,
} from './config.js';
import {} from './settings.js';
import { createTestPermissionManager } from '../test-utils/permissionManager.js';
const loadCliConfig = (
  settings: Parameters<typeof baseLoadCliConfig>[0],
  sessionId: string,
  argv: Parameters<typeof baseLoadCliConfig>[2],
  options: Omit<LoadCliConfigOptions, 'permissionManager'> & {
    permissionManager?: LoadCliConfigOptions['permissionManager'];
  },
) =>
  baseLoadCliConfig(settings, sessionId, argv, {
    permissionManager: createTestPermissionManager(),
    ...options,
  });


// The shared CLI setup imports Core before this file. Reload it so the Resource
// watcher override below also applies to Config's dependency graph.
vi.hoisted(() => vi.resetModules());

// Keep real Resource discovery and readiness. Suppress project filesystem
// notifications so a later watcher reload cannot hide an incomplete initial
// skill snapshot.
vi.mock('@qwen-code/resource', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@qwen-code/resource')>();
  return {
    ...actual,
    ResourceService: class extends actual.ResourceService {
      override getProjectResource(
        options: Parameters<ResourceService['getProjectResource']>[0],
      ) {
        return super.getProjectResource({
          ...options,
          fileWatcher: new actual.NoopFileWatcher(),
        });
      }
    },
  };
});

vi.mock('./trustedFolders.js', () => ({
  isWorkspaceTrusted: vi.fn(() => ({ isTrusted: true, source: 'file' })),
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('OutputStyle startup with --add-dir', () => {
  it.each(['sdk', 'interactive'] as const)(
    'loads additional-directory skills in the first %s snapshot',
    async (startupMode) => {
      const root = await mkdtemp(join(tmpdir(), 'output-style-startup-'));
      const cwd = join(root, 'workspace');
      const extra = join(root, 'extra');
      const skillDir = join(extra, '.qwen', 'skills', 'additional-skill');
      let config: Config | undefined;
      const reloadStyles = vi.spyOn(ProjectResource.prototype, 'reloadOutputStyles');
      vi.stubEnv(ENV_CONFIG_DIR, join(root, 'user-config'));
      vi.spyOn(PluginManager.prototype, 'loadSessionPlugins').mockResolvedValue(
        {
          plugins: [],
          errors: [],
        },
      );

      try {
        await mkdir(cwd, { recursive: true });
        await mkdir(skillDir, { recursive: true });
        await writeFile(
          join(skillDir, 'SKILL.md'),
          '---\nname: additional-skill\ndescription: Added workspace skill\n---\nExtra instructions',
        );
        const loadedSettings = loadSettings(cwd, ['project']);
        loadedSettings.setFlagSettings({
          path: '',
          settings: { outputStyle: 'Learning' },
          originalSettings: { outputStyle: 'Learning' },
          readOnly: true,
        });
        config = await loadCliConfig(
          loadedSettings,
          'output-style-startup',
          {
            addDir: [extra],
            outputStyle: 'Explanatory',
            settingSources: ['project'],
            disableBuiltinSkills: true,
            print: startupMode === 'sdk',
          } as CliArgs,
          { cwd, startupMode },
        );

        if (startupMode === 'interactive') {
          await config.initializeForInteractiveStartup();
        }
        await config.initialize();

        expect(
          config.getSkillManager().getSkill('additional-skill')?.body,
        ).toBe('Extra instructions');
        expect(config.getOutputStyle()?.name).toBe('Explanatory');
        expect(reloadStyles).not.toHaveBeenCalled();
      } finally {
        await config?.dispose();
        await config?.getResourceService().dispose();
        await rm(root, { recursive: true, force: true });
      }
    },
  );
  it('keeps original-project styles when entering and leaving a worktree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'output-style-worktree-'));
    const cwd = join(root, '中文 project');
    const worktree = join(root, '中文 worktree');
    let config: Config | undefined;
    vi.stubEnv(ENV_CONFIG_DIR, join(root, 'user-config'));
    vi.spyOn(PluginManager.prototype, 'loadSessionPlugins').mockResolvedValue({
      plugins: [],
      errors: [],
    });
    try {
      for (const [dir, prompt] of [
        [cwd, 'Original'],
        [worktree, 'Worktree'],
      ] as const) {
        const styles = join(dir, '.qwen', 'output-styles');
        await mkdir(styles, { recursive: true });
        await writeFile(
          join(styles, 'example.md'),
          `---\nname: example\ndescription: ${prompt}\n---\n${prompt}`,
        );
      }
      const loadedSettings = loadSettings(cwd, ['project']);
      loadedSettings.setFlagSettings({
        path: '',
        settings: { outputStyle: 'example' },
        originalSettings: { outputStyle: 'example' },
        readOnly: true,
      });
      config = await loadCliConfig(
        loadedSettings,
        'output-style-worktree',
        {
          settingSources: ['project'],
          disableBuiltinSkills: true,
          print: true,
        } as CliArgs,
        { cwd, startupMode: 'sdk' },
      );
      await config.initialize();
      expect(config.getOutputStyle()?.prompt).toBe('Original');
      config.setWorktreeSettings({
        name: 'test',
        path: worktree,
        worktreeCwd: worktree,
        baseSha: 'test-base',
        originalCwd: cwd,
      });
      config.setTargetDir(worktree);
      expect(config.storage.getConfigDir()).toBe(join(cwd, '.qwen'));
      expect((await config.getAvailableOutputStyles())['example']?.prompt).toBe(
        'Original',
      );
      config.setWorktreeSettings(undefined);
      config.setTargetDir(cwd);
      expect((await config.getAvailableOutputStyles())['example']?.prompt).toBe(
        'Original',
      );
    } finally {
      await config?.dispose();
      await config?.getResourceService().dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
});
