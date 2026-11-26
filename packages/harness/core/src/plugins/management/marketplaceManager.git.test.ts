/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ENV_PLUGIN_CACHE_DIR } from '../../config/brand.js';

const execPluginGitMock = vi.hoisted(() => vi.fn());

vi.mock('../pluginGit.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../pluginGit.js')>()),
  execPluginGit: execPluginGitMock,
}));

import {
  addMarketplaceSource,
  clearMarketplacesCache,
} from './marketplaceManager.js';

const tmpDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  execPluginGitMock.mockReset();
  clearMarketplacesCache();
  for (const dir of tmpDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe('GitHub marketplace fetching', () => {
  it('keeps using SSH when the configured SSH path succeeds', async () => {
    const pluginHome = await mkdtemp(join(tmpdir(), 'test-github-market-'));
    tmpDirs.push(pluginHome);
    vi.stubEnv(ENV_PLUGIN_CACHE_DIR, pluginHome);
    clearMarketplacesCache();

    execPluginGitMock.mockImplementationOnce(async (args: string[]) => {
      const targetDir = args.at(-1);
      if (!targetDir) throw new Error('missing clone target');
      const manifestDir = join(targetDir, '.claude-plugin');
      await mkdir(manifestDir, { recursive: true });
      await writeFile(
        join(manifestDir, 'marketplace.json'),
        JSON.stringify({
          name: 'ssh-market',
          owner: { name: 'Test' },
          plugins: [],
        }),
      );
    });

    await expect(
      addMarketplaceSource('ssh-market', {
        source: 'github',
        repo: 'owner/private-repo',
      }),
    ).resolves.toMatchObject({ name: 'ssh-market' });

    expect(execPluginGitMock).toHaveBeenCalledTimes(1);
    expect(execPluginGitMock.mock.calls[0]?.[0]).toEqual(
      expect.arrayContaining(['git@github.com:owner/private-repo.git']),
    );
  });

  it('falls back from SSH to HTTPS when non-interactive SSH fails', async () => {
    const pluginHome = await mkdtemp(join(tmpdir(), 'test-github-market-'));
    tmpDirs.push(pluginHome);
    vi.stubEnv(ENV_PLUGIN_CACHE_DIR, pluginHome);
    clearMarketplacesCache();

    execPluginGitMock
      .mockRejectedValueOnce(new Error('Host key verification failed'))
      .mockImplementationOnce(async (args: string[]) => {
        const targetDir = args.at(-1);
        if (!targetDir) throw new Error('missing clone target');
        const manifestDir = join(targetDir, '.claude-plugin');
        await mkdir(manifestDir, { recursive: true });
        await writeFile(
          join(manifestDir, 'marketplace.json'),
          JSON.stringify({
            name: 'test-market',
            owner: { name: 'Test' },
            plugins: [],
          }),
        );
      });

    await expect(
      addMarketplaceSource('test-market', {
        source: 'github',
        repo: 'owner/repo',
      }),
    ).resolves.toMatchObject({ name: 'test-market' });

    expect(execPluginGitMock).toHaveBeenCalledTimes(2);
    expect(execPluginGitMock.mock.calls[0]?.[0]).toEqual(
      expect.arrayContaining(['git@github.com:owner/repo.git']),
    );
    expect(execPluginGitMock.mock.calls[1]?.[0]).toEqual(
      expect.arrayContaining(['https://github.com/owner/repo.git']),
    );
  });
});
