/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { BRAND_PLUGIN_META_DIR } from '../../config/brand.js';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, symlink, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ---------------------------------------------------------------------------
// Module mocks (must be hoisted before imports)
// ---------------------------------------------------------------------------

vi.mock('./installedPluginsManager.js', () => ({
  addPluginInstallation: vi.fn(),
  removePluginInstallation: vi.fn(),
  getPluginInstallationsFresh: vi.fn().mockReturnValue([]),
  isPluginInstalled: vi.fn().mockReturnValue(false),
}));

vi.mock('../pluginDirectories.js', () => ({
  getVersionedCachePath: vi.fn(
    (_mp: string, name: string, version: string) =>
      `/fake-cache/${name}/${version}`,
  ),
  deletePluginDataDir: vi.fn(),
}));

vi.mock('../cacheUtils.js', () => ({
  markPluginVersionOrphaned: vi.fn(),
}));

vi.mock('../pluginTreeCopy.js', () => ({
  copyPluginTree: vi.fn().mockResolvedValue({
    rewrittenSymlinks: 0,
    materializedSymlinks: 0,
    skippedSymlinks: 0,
  }),
}));

// cp is the expensive part — mock it out so tests don't do real file copies
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    cp: vi.fn().mockResolvedValue(undefined),
    rm: vi.fn(actual.rm),
  };
});

// ---------------------------------------------------------------------------
// Import SUT after mocks are set up
// ---------------------------------------------------------------------------

import {
  installLocalPluginOp,
  installPluginOp,
  uninstallPluginOp,
  updatePluginOp,
} from './pluginOperations.js';
import type { LoadedPlugin } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a temp dir and return its path. Cleaned up in afterEach. */
async function makeTmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'test-test-'));
}

/**
 * Write a minimal plugin into `dir` with a `skills/` subdirectory
 * (the simplest convention content).
 */
async function writeSkillsDir(dir: string): Promise<void> {
  const skillsDir = join(dir, 'skills');
  await mkdir(skillsDir, { recursive: true });
  await writeFile(join(skillsDir, 'hello.md'), '# Hello skill\n/hello Hello');
}

/**
 * Write a minimal workflow-only plugin content directory.
 */
async function writeWorkflowsDir(dir: string): Promise<void> {
  const workflowsDir = join(dir, 'workflows');
  await mkdir(workflowsDir, { recursive: true });
  await writeFile(
    join(workflowsDir, 'audit.js'),
    'export const meta = { name: "audit", description: "Audit workflow" };\nreturn { ok: true };\n',
  );
}

/**
 * Write a minimal `.mcp.json` into `dir`.
 */
async function writeMcpJson(dir: string): Promise<void> {
  await writeFile(
    join(dir, '.mcp.json'),
    JSON.stringify({ mcpServers: { 'test-server': { command: 'node', args: ['index.js'] } } }),
  );
}

function makeLoadedPlugin(
  name: string,
  source: string,
  dependencies: string[] = [],
): LoadedPlugin {
  return {
    name,
    source,
    repository: source,
    path: `/plugins/${name}`,
    enabled: true,
    manifest: {
      name,
      version: '1.0.0',
      ...(dependencies.length > 0 ? { dependencies } : {}),
    },
  } as LoadedPlugin;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('installLocalPluginOp', () => {
  const cleanupDirs: string[] = [];

  async function tmp(): Promise<string> {
    const d = await makeTmpDir();
    cleanupDirs.push(d);
    return d;
  }

  afterEach(async () => {
    for (const d of cleanupDirs.splice(0)) {
      await rm(d, { recursive: true, force: true });
    }
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Flat format — success cases
  // -------------------------------------------------------------------------

  it('installs a flat plugin with skills/', async () => {
    const dir = await tmp();
    await writeSkillsDir(dir);

    const { addPluginInstallation } = await import(
      './installedPluginsManager.js'
    );

    const result = await installLocalPluginOp(dir, 'user');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pluginId).toMatch(/@local$/);
    expect(result.installPath).toContain('local');
    expect(result.marketplace).toBe('local');
    // Version must be 'local' for flat format
    expect(addPluginInstallation).toHaveBeenCalledWith(
      result.pluginId,
      expect.objectContaining({ version: 'local' }),
    );
  });

  it('installs a flat plugin with .mcp.json', async () => {
    const dir = await tmp();
    await writeMcpJson(dir);

    const result = await installLocalPluginOp(dir, 'user');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.marketplace).toBe('local');
  });

  it('installs a flat plugin with workflows/', async () => {
    const dir = await tmp();
    await writeWorkflowsDir(dir);

    const result = await installLocalPluginOp(dir, 'user');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.marketplace).toBe('local');
  });

  // -------------------------------------------------------------------------
  // Flat format — failure cases
  // -------------------------------------------------------------------------

  it('rejects an empty directory', async () => {
    const dir = await tmp();

    const result = await installLocalPluginOp(dir, 'user');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.type).toBe('generic-error');
    expect('error' in result.error && result.error.error).toMatch(
      /No plugin content found/,
    );
  });

  it('rejects a directory with only non-convention subdirs', async () => {
    const dir = await tmp();
    await mkdir(join(dir, 'docs'), { recursive: true });
    await writeFile(join(dir, 'docs', 'readme.md'), '# readme');

    const result = await installLocalPluginOp(dir, 'user');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect('error' in result.error && result.error.error).toMatch(
      /No plugin content found/,
    );
  });

  it('rejects a directory with subdirs named non-semver (e.g. "latest")', async () => {
    const dir = await tmp();
    const sub = join(dir, 'latest');
    await writeSkillsDir(sub);

    const result = await installLocalPluginOp(dir, 'user');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect('error' in result.error && result.error.error).toMatch(
      /No plugin content found/,
    );
  });

  it('rejects two-level deep nesting (only scans one level)', async () => {
    const dir = await tmp();
    const deep = join(dir, 'sub', '1.0.0');
    await writeSkillsDir(deep);

    const result = await installLocalPluginOp(dir, 'user');

    // 'sub' is not semver → no candidates → "No plugin content found"
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect('error' in result.error && result.error.error).toMatch(
      /No plugin content found/,
    );
  });

  // -------------------------------------------------------------------------
  // Version subdirectories are no longer supported — directory is the root
  // -------------------------------------------------------------------------

  it('rejects a single semver subdirectory at root (no longer auto-detected)', async () => {
    const dir = await tmp();
    const vDir = join(dir, '1.0.0');
    await writeSkillsDir(vDir);

    const result = await installLocalPluginOp(dir, 'user');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect('error' in result.error && result.error.error).toMatch(
      /No plugin content found/,
    );
  });

  it('rejects multiple semver subdirectories at root (no longer auto-detected)', async () => {
    const dir = await tmp();
    await writeSkillsDir(join(dir, '1.0.0'));
    await writeSkillsDir(join(dir, '2.0.0'));

    const result = await installLocalPluginOp(dir, 'user');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect('error' in result.error && result.error.error).toMatch(
      /No plugin content found/,
    );
  });

  // -------------------------------------------------------------------------
  // Version comes from the manifest, not the directory layout
  // -------------------------------------------------------------------------

  it('uses manifest version for a flat plugin', async () => {
    const dir = await tmp();
    await writeSkillsDir(dir);
    await mkdir(join(dir, BRAND_PLUGIN_META_DIR), { recursive: true });
    await writeFile(
      join(dir, BRAND_PLUGIN_META_DIR, 'plugin.json'),
      JSON.stringify({ name: 'my-plugin', version: '2.1.0', displayName: '中文插件' }),
    );

    const { addPluginInstallation } = await import(
      './installedPluginsManager.js'
    );

    const result = await installLocalPluginOp(dir, 'user');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pluginId).toBe('my-plugin@local');
    expect(addPluginInstallation).toHaveBeenCalledWith(
      result.pluginId,
      expect.objectContaining({ version: '2.1.0', displayName: '中文插件' }),
    );
  });

  it('clears a same-version cache path before copying new content', async () => {
    const dir = await tmp();
    await writeSkillsDir(dir);
    await mkdir(join(dir, BRAND_PLUGIN_META_DIR), { recursive: true });
    await writeFile(
      join(dir, BRAND_PLUGIN_META_DIR, 'plugin.json'),
      JSON.stringify({ name: 'replace-me', version: '1.0.0' }),
    );

    const fsPromises = await import('node:fs/promises');
    await installLocalPluginOp(dir, 'user');

    expect(fsPromises.rm).toHaveBeenCalledWith(
      '/fake-cache/replace-me/1.0.0',
      { recursive: true, force: true },
    );
    expect(fsPromises.rm).toHaveBeenCalledBefore(
      vi.mocked(fsPromises.cp),
    );
  });

  it.skipIf(process.platform === 'win32')(
    'materializes a contained top-level symlink during the cache copy',
    async () => {
    const dir = await tmp();
    await writeSkillsDir(dir);
    await writeFile(join(dir, 'CLAUDE.md'), '# Instructions');
    const linkPath = join(dir, 'AGENTS.md');
    await symlink('CLAUDE.md', linkPath);

    const fsPromises = await import('node:fs/promises');
    await installLocalPluginOp(dir, 'user');

    const copyOptions = vi.mocked(fsPromises.cp).mock.calls[0]?.[2];
    expect(copyOptions?.dereference).toBe(true);
    expect(await copyOptions?.filter?.(linkPath, '/unused')).toBe(true);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'skips top-level symlinks that escape or recurse into the source',
    async () => {
    const dir = await tmp();
    await writeSkillsDir(dir);
    const outsidePath = join(await tmp(), 'outside.md');
    await writeFile(outsidePath, 'outside');
    const outsideLink = join(dir, 'outside-link');
    const recursiveLink = join(dir, 'recursive-link');
    await symlink(outsidePath, outsideLink);
    await symlink('.', recursiveLink);

    const fsPromises = await import('node:fs/promises');
    await installLocalPluginOp(dir, 'user');

    const copyOptions = vi.mocked(fsPromises.cp).mock.calls[0]?.[2];
    expect(await copyOptions?.filter?.(outsideLink, '/unused')).toBe(false);
    expect(await copyOptions?.filter?.(recursiveLink, '/unused')).toBe(false);
    },
  );

  it('falls back to version "local" when the manifest omits version', async () => {
    const dir = await tmp();
    await writeSkillsDir(dir);
    await mkdir(join(dir, BRAND_PLUGIN_META_DIR), { recursive: true });
    await writeFile(
      join(dir, BRAND_PLUGIN_META_DIR, 'plugin.json'),
      JSON.stringify({ name: 'my-plugin' }),
    );

    const { addPluginInstallation } = await import(
      './installedPluginsManager.js'
    );

    const result = await installLocalPluginOp(dir, 'user');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(addPluginInstallation).toHaveBeenCalledWith(
      result.pluginId,
      expect.objectContaining({ version: 'local' }),
    );
  });

  // -------------------------------------------------------------------------
  // hooks-only plugin (covers hasPluginContent's hooksConfig branch)
  // -------------------------------------------------------------------------

  it('accepts a plugin whose only content is hooks/hooks.json', async () => {
    const dir = await tmp();
    await mkdir(join(dir, 'hooks'), { recursive: true });
    await writeFile(
      join(dir, 'hooks', 'hooks.json'),
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            { hooks: [{ type: 'command', command: 'echo hi' }] },
          ],
        },
      }),
    );

    const result = await installLocalPluginOp(dir, 'user');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.marketplace).toBe('local');
  });

  // -------------------------------------------------------------------------
  // Version-named directory installed directly — basename becomes the name
  // -------------------------------------------------------------------------

  it('accepts installing a version-named dir directly when no manifest is present', async () => {
    // The derived plugin name comes from the basename verbatim; a manifest.name
    // (when present) still takes precedence in the loader.
    const root = await tmp();
    const pluginDir = join(root, 'context7');
    const versionDir = join(pluginDir, '1.0.0');
    await writeSkillsDir(versionDir);

    const result = await installLocalPluginOp(versionDir, 'user');

    expect(result.ok).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Invalid plugin name
  // -------------------------------------------------------------------------

  it('rejects a directory whose name is only dots', async () => {
    const parent = await tmp();
    const dotsDir = join(parent, '...');
    await mkdir(dotsDir);
    await writeSkillsDir(dotsDir);

    const result = await installLocalPluginOp(dotsDir, 'user');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.type).toBe('generic-error');
    if (result.error.type !== 'generic-error') return;
    expect(result.error.error).toMatch(/Invalid plugin directory name/);
  });

  it('accepts a directory whose basename is non-ASCII', async () => {
    const parent = await tmp();
    const cnDir = join(parent, '中文插件');
    await writeSkillsDir(cnDir);

    const result = await installLocalPluginOp(cnDir, 'user');

    expect(result.ok).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Path precheck (non-existent / non-directory)
  // -------------------------------------------------------------------------

  it('rejects a path that does not exist', async () => {
    const parent = await tmp();
    const missing = join(parent, 'nope');

    const result = await installLocalPluginOp(missing, 'user');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.type).toBe('generic-error');
    if (result.error.type !== 'generic-error') return;
    expect(result.error.error).toMatch(/Directory not found:/);
  });

  it('rejects a path that exists but is not a directory', async () => {
    const parent = await tmp();
    const file = join(parent, 'plugin.txt');
    await writeFile(file, 'not a plugin');

    const result = await installLocalPluginOp(file, 'user');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.type).toBe('generic-error');
    if (result.error.type !== 'generic-error') return;
    expect(result.error.error).toMatch(/Not a directory:/);
  });
});

describe('uninstallPluginOp', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('allows uninstall when enabled plugins depend on the target and returns a warning list', async () => {
    const { getPluginInstallationsFresh, removePluginInstallation } = await import(
      './installedPluginsManager.js'
    );

    vi.mocked(getPluginInstallationsFresh).mockReturnValue([
      {
        scope: 'user',
        installPath: '/cache/provider',
        version: '1.0.0',
        installedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
    vi.mocked(removePluginInstallation).mockReturnValue(true);

    const result = await uninstallPluginOp('provider@mp', 'user', {
      loadedPlugins: [
        makeLoadedPlugin('consumer', 'mp', ['provider']),
        makeLoadedPlugin('provider', 'mp'),
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reverseDependents).toEqual(['consumer@mp']);
    expect(removePluginInstallation).toHaveBeenCalledWith(
      'provider@mp',
      'user',
      undefined,
    );
  });

  it('refuses to uninstall any pluginId with a managed entry (chokepoint)', async () => {
    const { getPluginInstallationsFresh, removePluginInstallation } = await import(
      './installedPluginsManager.js'
    );
    vi.mocked(getPluginInstallationsFresh).mockReturnValue([
      {
        scope: 'managed',
        installPath: '/cache/foo/1.0.0',
        version: '1.0.0',
        orgId: 'acme',
        userVisible: true,
        userCanDisable: false,
        fileHash: 'sha256:abc',
        fileSize: 1,
      },
    ]);
    vi.mocked(removePluginInstallation).mockReturnValue(true);

    const result = await uninstallPluginOp(
      'foo@qoder-enterprise-acme',
      'user',
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeDefined();
    expect(removePluginInstallation).not.toHaveBeenCalled();
  });

  it('refuses to update a plugin that is no longer installed', async () => {
    const { getPluginInstallationsFresh } = await import(
      './installedPluginsManager.js'
    );
    // Another process uninstalled it; the fresh read reflects that.
    vi.mocked(getPluginInstallationsFresh).mockReturnValue([]);

    const { addPluginInstallation } = await import(
      './installedPluginsManager.js'
    );
    const result = await updatePluginOp('gone@mp', 'user');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(addPluginInstallation).not.toHaveBeenCalled();
  });

  it('rejects a plugin using the supplied exclusion before reading or writing installations', async () => {
    const { getPluginInstallationsFresh, addPluginInstallation } = await import(
      './installedPluginsManager.js'
    );
    const result = await installPluginOp('host-owned@host-market', 'user', {
      getPluginExclusionReason: () => 'Excluded by the host',
    });
    expect(result).toEqual({
      ok: false,
      error: {
        type: 'generic-error',
        source: 'install',
        plugin: 'host-owned@host-market',
        error: 'Excluded by the host',
      },
    });
    expect(getPluginInstallationsFresh).not.toHaveBeenCalled();
    expect(addPluginInstallation).not.toHaveBeenCalled();
  });

  it('checks the resolved ID before caching an unqualified marketplace plugin', async () => {
    const marketplaces = await import('./marketplaceManager.js');
    const { addPluginInstallation } = await import(
      './installedPluginsManager.js'
    );
    const lookup = vi
      .spyOn(marketplaces, 'getPluginById')
      .mockResolvedValueOnce({
        entry: {
          name: 'host-owned',
          source: '/market/plugins/host-owned',
          strict: true,
        },
        marketplaceName: 'host-market',
        marketplaceSource: { source: 'directory', path: '/market' },
        marketplaceInstallLocation: '/market',
      });
    const exclusion = vi.fn((id: string) =>
      id === 'host-owned@host-market' ? 'Excluded by the host' : undefined,
    );
    try {
      const result = await installPluginOp('host-owned', 'user', {
        getPluginExclusionReason: exclusion,
      });
      expect(result).toEqual({
        ok: false,
        error: {
          type: 'generic-error',
          source: 'install',
          plugin: 'host-owned@host-market',
          error: 'Excluded by the host',
        },
      });
      expect(exclusion.mock.calls.map(([id]) => id)).toEqual([
        'host-owned',
        'host-owned@host-market',
      ]);
      expect(addPluginInstallation).not.toHaveBeenCalled();
      const fs = await import('node:fs/promises');
      expect(fs.cp).not.toHaveBeenCalled();
    } finally {
      lookup.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// hasPluginContent (indirectly tested via installLocalPluginOp above,
// but we add a few direct edge cases via the empty-dir check)
// ---------------------------------------------------------------------------

describe('installLocalPluginOp – scoped install options', () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    for (const d of cleanupDirs.splice(0)) {
      await rm(d, { recursive: true, force: true });
    }
  });

  it('passes projectPath to installEntry for project scope', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'test-test-'));
    cleanupDirs.push(dir);
    await writeSkillsDir(dir);

    const { addPluginInstallation } = await import(
      './installedPluginsManager.js'
    );

    await installLocalPluginOp(dir, 'project', {
      projectPath: '/my/project',
    });

    expect(addPluginInstallation).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ projectPath: '/my/project', scope: 'project' }),
    );
  });

  it('does not set projectPath for user scope', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'test-test-'));
    cleanupDirs.push(dir);
    await writeSkillsDir(dir);

    const { addPluginInstallation } = await import(
      './installedPluginsManager.js'
    );

    await installLocalPluginOp(dir, 'user');

    expect(addPluginInstallation).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ scope: 'user', projectPath: undefined }),
    );
  });
});
