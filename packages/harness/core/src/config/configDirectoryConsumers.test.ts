/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Each case changes the config home; bypass the setup mock's cached Storage.
vi.unmock('./storage.js');

describe('configured directory resource consumers', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'config-dir-consumers-'));
    vi.stubEnv('QODERCLI_SITE', 'global');
    vi.stubEnv('BRAND_ENV_PREFIX', 'QWEN_');
    vi.stubEnv('QWEN_CONFIG_DIR', undefined);
    vi.stubEnv('QWEN_CLI_HOME', tmpDir);
    vi.stubEnv('QWEN_CONFIG_DIR_NAME', 'abc');
    vi.resetModules();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it.each(['global', 'cn'])(
    'uses Qwen resource paths without an injected prefix for site=%s',
    async (site) => {
      vi.stubEnv('QODERCLI_SITE', site);
      vi.stubEnv('BRAND_ENV_PREFIX', undefined);
      vi.stubEnv('QWEN_CONFIG_DIR_NAME', undefined);
      vi.stubEnv('QWEN_CONFIG_DIR', undefined);
      vi.stubEnv('QWEN_CLI_HOME', tmpDir);
      vi.resetModules();

      const [{ Storage }, { getCronFilePath }, workflows] = await Promise.all([
        import('./storage.js'),
        import('../cron/cron-tasks.js'),
        import('../workflows/workflow-storage.js'),
      ]);
      const configRoot = path.join(tmpDir, '.qwen');
      expect(new Storage(tmpDir).getConfigDir()).toBe(configRoot);
      expect(Storage.getGlobalSettingsPath()).toBe(
        path.join(configRoot, 'settings.json'),
      );
      expect(getCronFilePath(tmpDir)).toBe(
        path.join(configRoot, 'scheduled_tasks.json'),
      );
      expect(workflows.getProjectWorkflowsDir(tmpDir)).toBe(
        path.join(configRoot, 'workflows'),
      );
    },
  );

  it('stores cron tasks below the selected project directory', async () => {
    const { getCronFilePath, writeCronTasks } = await import(
      '../cron/cron-tasks.js'
    );

    expect(getCronFilePath(tmpDir)).toBe(
      path.join(tmpDir, 'abc', 'scheduled_tasks.json'),
    );

    await writeCronTasks([], tmpDir);
    await expect(
      fs.readFile(path.join(tmpDir, 'abc', 'scheduled_tasks.json'), 'utf8'),
    ).resolves.toContain('"tasks"');
  });

  it('stores project and session workflows below the selected directory', async () => {
    const storage = await import('../workflows/workflow-storage.js');

    expect(storage.getProjectWorkflowsDir(tmpDir)).toBe(
      path.join(tmpDir, 'abc', 'workflows'),
    );
    expect(storage.getWorkflowSessionDir(tmpDir, 'session-1')).toBe(
      path.join(tmpDir, 'abc', 'sessions', 'session-1', 'workflows'),
    );
  });

  it('uses a complete user config root for workflows', async () => {
    const userConfigRoot = path.join(tmpDir, 'complete-user-root');
    vi.stubEnv('QWEN_CONFIG_DIR', userConfigRoot);
    vi.resetModules();

    const storage = await import('../workflows/workflow-storage.js');
    const getUserWorkflowsDirFromConfigRoot = (
      storage as unknown as {
        getUserWorkflowsDirFromConfigRoot(configRoot: string): string;
      }
    ).getUserWorkflowsDirFromConfigRoot;

    expect(getUserWorkflowsDirFromConfigRoot(userConfigRoot)).toBe(
      path.join(userConfigRoot, 'workflows'),
    );

    const { WorkflowRegistry } = await import(
      '../workflows/workflow-registry.js'
    );
    await fs.mkdir(path.join(userConfigRoot, 'workflows'), { recursive: true });
    await fs.writeFile(
      path.join(userConfigRoot, 'workflows', 'user-flow.js'),
      'export const meta = { name: "user-flow", description: "User flow" };',
    );

    const registry = WorkflowRegistry.createDefault(tmpDir);
    const listed = await registry.listAvailable();
    expect(listed.entries).toContainEqual(
      expect.objectContaining({ name: 'user-flow', source: 'user' }),
    );
  });

  it('gives an explicit workflow user config root priority over homeDir', async () => {
    const explicitRoot = path.join(tmpDir, 'explicit-config-root');
    const legacyHome = path.join(tmpDir, 'legacy-home');
    await fs.mkdir(path.join(explicitRoot, 'workflows'), { recursive: true });
    await fs.mkdir(path.join(legacyHome, 'abc', 'workflows'), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(explicitRoot, 'workflows', 'preferred.js'),
      'export const meta = { name: "preferred", description: "Preferred" };',
    );
    await fs.writeFile(
      path.join(legacyHome, 'abc', 'workflows', 'legacy.js'),
      'export const meta = { name: "legacy", description: "Legacy" };',
    );

    const { WorkflowRegistry } = await import(
      '../workflows/workflow-registry.js'
    );
    const registry = new WorkflowRegistry({
      projectRoot: tmpDir,
      homeDir: legacyHome,
      userConfigRoot: explicitRoot,
    });
    const names = (await registry.listAvailable()).entries.map(
      (entry) => entry.name,
    );

    expect(names).toContain('preferred');
    expect(names).not.toContain('legacy');
  });

  it('copies project-local settings using the selected directory', async () => {
    const repoRoot = path.join(tmpDir, 'repo');
    const worktreePath = path.join(tmpDir, 'worktree');
    await fs.mkdir(path.join(repoRoot, 'abc'), { recursive: true });
    await fs.mkdir(worktreePath, { recursive: true });
    await fs.writeFile(
      path.join(repoRoot, 'abc', 'settings.local.json'),
      '{"selected":true}',
    );

    const { performPostCreationSetup } = await import(
      '../services/worktreeService.js'
    );
    await performPostCreationSetup(repoRoot, worktreePath);

    await expect(
      fs.readFile(path.join(worktreePath, 'abc', 'settings.local.json'), 'utf8'),
    ).resolves.toBe('{"selected":true}');
    await expect(
      fs.stat(path.join(worktreePath, '.qwen', 'settings.local.json')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('recognizes only the selected project config directory as internal', async () => {
    const { isProjectInternalPath } = await import(
      '../tools/filesystem-permissions/internalPaths.js'
    );
    const { qwenInternalPathDeps } = await import(
      '../tools/filesystem-permissions/internal-path-deps.js'
    );
    const context = qwenInternalPathDeps.resolve({ cwd: tmpDir });

    expect(context.projectConfigDir).toBe(path.join(tmpDir, 'abc'));
    expect(
      isProjectInternalPath(path.join(tmpDir, 'abc', 'settings.json'), tmpDir, context),
    ).toBe(true);
    expect(
      isProjectInternalPath(path.join(tmpDir, '.qwen', 'settings.json'), tmpDir, context),
    ).toBe(false);
  });

  it('recognizes project rules after case-insensitive path normalization', async () => {
    vi.stubEnv('QWEN_CONFIG_DIR_NAME', 'TeamConfig');
    vi.stubGlobal(
      'process',
      Object.create(process, {
        platform: { get: () => 'darwin' },
      }),
    );
    vi.resetModules();

    const { isRuleMemoryPath } = await import('../utils/memoryDiscovery.js');

    expect(
      isRuleMemoryPath(
        path.join(tmpDir, 'project', 'teamconfig', 'rules', 'project.md'),
      ),
    ).toBe(true);
  });
});
