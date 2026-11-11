/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import fs, { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ENV_PLUGIN_CACHE_DIR } from '../config/brand.js';
import {
  commitLegacyMarketplaceAliases,
  discoverLegacyMarketplaceAliases,
  migrateInstalledPluginIds,
} from './legacyPluginIdentityMigration.js';
import {
  clearMarketplacesCache,
  loadKnownMarketplacesConfig,
  saveKnownMarketplacesConfig,
} from './management/marketplaceManager.js';
import { invalidateInstalledPluginsCache } from './management/installedPluginsManager.js';
import { checkEnabledPlugins } from './pluginStartupCheck.js';
import { runLogger } from '../utils/runLogger.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: vi.fn(actual.readFileSync),
  };
});

const LEGACY_MARKETPLACE = 'thedotmack/claude-mem';
const CANONICAL_MARKETPLACE = 'thedotmack';
const LEGACY_PLUGIN_ID = `claude-mem@${LEGACY_MARKETPLACE}`;
const CANONICAL_PLUGIN_ID = `claude-mem@${CANONICAL_MARKETPLACE}`;

let pluginHome: string;

beforeEach(async () => {
  vi.mocked(readFileSync).mockReset().mockImplementation(fs.readFileSync);
  pluginHome = await mkdtemp(join(tmpdir(), 'plugin-identity-migration-'));
  vi.stubEnv(ENV_PLUGIN_CACHE_DIR, pluginHome);
  clearMarketplacesCache();
  invalidateInstalledPluginsCache();
});

afterEach(async () => {
  vi.restoreAllMocks();
  clearMarketplacesCache();
  invalidateInstalledPluginsCache();
  vi.unstubAllEnvs();
  await rm(pluginHome, { recursive: true, force: true });
});

describe('legacy plugin identity migration', () => {
  it.each([
    { retry: false, parseFailure: false, errorCode: 'UNKNOWN' },
    { retry: false, parseFailure: true, errorCode: 'JSON_INVALID' },
    { retry: true, parseFailure: false, errorCode: 'UNKNOWN' },
    { retry: true, parseFailure: true, errorCode: 'JSON_INVALID' },
  ])(
    '读取诊断区分读取和解析失败且不改写原文件（retry=$retry, parseFailure=$parseFailure）',
    async ({ retry, parseFailure, errorCode }) => {
      await writeInstalledState({
        [LEGACY_PLUGIN_ID]: [{ scope: 'user', installPath: '/fixture/plugin' }],
      });
      const before = await readFile(installedPath(), 'utf-8');
      const truncated = '{"version":2,"plugins":';
      const warn = vi.spyOn(runLogger, 'warn').mockImplementation(() => {});
      let stateReads = 0;
      vi.mocked(readFileSync).mockImplementation((...args) => {
        if (args[0] === installedPath()) {
          stateReads++;
          if (retry && stateReads === 1) {
            // 模拟首次读取时文件尚未生成，随后加载器能读取到文件。
            throw Object.assign(new Error('fixture missing'), {
              code: 'ENOENT',
            });
          }
          if (!retry || stateReads === 3) {
            if (parseFailure) return truncated;
            throw new Error('fixture read failure');
          }
        }
        return fs.readFileSync(...args);
      });

      expect(
        migrateInstalledPluginIds({
          [LEGACY_MARKETPLACE]: CANONICAL_MARKETPLACE,
        }),
      ).toEqual({ changed: false, success: false });
      expect(warn).toHaveBeenCalledWith(
        '[InstalledPlugins] State read failed',
        expect.objectContaining({
          errorCode,
          byteLength: Buffer.byteLength(before),
          mtimeMs: expect.any(Number),
          readByteLength: parseFailure
            ? Buffer.byteLength(truncated)
            : undefined,
          empty: parseFailure ? false : undefined,
        }),
      );
      expect(await readFile(installedPath(), 'utf-8')).toBe(before);
    },
  );

  it('discovers the manifest name and migrates installed and known state', async () => {
    const installLocation = await seedLegacyMarketplace();
    await writeInstalledState({
      [LEGACY_PLUGIN_ID]: [
        {
          scope: 'user',
          installPath: '/cache/legacy',
          version: '1.0.0',
        },
      ],
      'normal@market': [
        {
          scope: 'user',
          installPath: '/cache/normal',
          version: '2.0.0',
        },
      ],
      'malformed id': { siblingOwned: true },
    });

    const aliases = await discoverLegacyMarketplaceAliases();
    expect(aliases).toEqual({
      [LEGACY_MARKETPLACE]: CANONICAL_MARKETPLACE,
    });

    expect(migrateInstalledPluginIds(aliases)).toEqual({
      changed: true,
      success: true,
    });
    expect(commitLegacyMarketplaceAliases(aliases)).toEqual({
      changed: true,
      success: true,
    });

    const installed = await readInstalledState();
    expect(installed.plugins[LEGACY_PLUGIN_ID]).toBeUndefined();
    expect(installed.plugins[CANONICAL_PLUGIN_ID]).toEqual([
      {
        scope: 'user',
        installPath: '/cache/legacy',
        version: '1.0.0',
      },
    ]);
    expect(installed.plugins['normal@market']).toBeDefined();
    expect(installed.plugins['malformed id']).toEqual({
      siblingOwned: true,
    });

    const known = loadKnownMarketplacesConfig();
    expect(known[LEGACY_MARKETPLACE]).toBeUndefined();
    expect(known[CANONICAL_MARKETPLACE]?.installLocation).toBe(
      installLocation,
    );
    await expect(
      checkEnabledPlugins([CANONICAL_PLUGIN_ID]),
    ).resolves.toEqual([]);

    // Once committed, the repair is idempotent and no alias is rediscovered.
    expect(await discoverLegacyMarketplaceAliases()).toEqual({});
  });

  it('keeps legacy state untouched when the cached manifest is unavailable', async () => {
    saveKnownMarketplacesConfig({
      [LEGACY_MARKETPLACE]: {
        source: { source: 'github', repo: LEGACY_MARKETPLACE },
        installLocation: join(pluginHome, 'missing-marketplace-cache'),
        lastUpdated: '2026-01-01T00:00:00.000Z',
      },
    });
    await writeInstalledState({
      [LEGACY_PLUGIN_ID]: [
        { scope: 'user', installPath: '/cache/legacy', version: '1.0.0' },
      ],
    });
    const before = await readFile(installedPath(), 'utf-8');

    expect(await discoverLegacyMarketplaceAliases()).toEqual({});
    expect(await readFile(installedPath(), 'utf-8')).toBe(before);
    expect(loadKnownMarketplacesConfig()[LEGACY_MARKETPLACE]).toBeDefined();
  });

  it('merges into an existing canonical install with canonical entries winning', async () => {
    await seedLegacyMarketplace();
    await writeInstalledState({
      [LEGACY_PLUGIN_ID]: [
        {
          scope: 'user',
          installPath: '/cache/legacy',
          version: '1.0.0',
        },
        {
          scope: 'project',
          projectPath: '/project',
          installPath: '/cache/legacy-project',
          version: '1.0.0',
        },
      ],
      [CANONICAL_PLUGIN_ID]: [
        {
          scope: 'user',
          installPath: '/cache/canonical',
          version: '2.0.0',
        },
      ],
    });

    const aliases = await discoverLegacyMarketplaceAliases();
    expect(migrateInstalledPluginIds(aliases).success).toBe(true);

    const installed = await readInstalledState();
    expect(installed.plugins[CANONICAL_PLUGIN_ID]).toEqual([
      {
        scope: 'user',
        installPath: '/cache/canonical',
        version: '2.0.0',
      },
      {
        scope: 'project',
        projectPath: '/project',
        installPath: '/cache/legacy-project',
        version: '1.0.0',
      },
    ]);
  });
});

async function seedLegacyMarketplace(): Promise<string> {
  const installLocation = join(
    pluginHome,
    'marketplaces',
    'thedotmack',
    'claude-mem',
  );
  const manifestDir = join(installLocation, '.claude-plugin');
  await mkdir(manifestDir, { recursive: true });
  await writeFile(
    join(manifestDir, 'marketplace.json'),
    JSON.stringify({
      name: CANONICAL_MARKETPLACE,
      owner: { name: 'The Dot Mack' },
      plugins: [{ name: 'claude-mem', source: './plugin' }],
    }),
  );
  await mkdir(join(installLocation, 'plugin'), { recursive: true });
  saveKnownMarketplacesConfig({
    [LEGACY_MARKETPLACE]: {
      source: { source: 'github', repo: LEGACY_MARKETPLACE },
      installLocation,
      lastUpdated: '2026-01-01T00:00:00.000Z',
    },
  });
  clearMarketplacesCache();
  return installLocation;
}

function installedPath(): string {
  return join(pluginHome, 'installed_plugins_v2.json');
}

async function writeInstalledState(
  plugins: Record<string, unknown>,
): Promise<void> {
  await writeFile(installedPath(), JSON.stringify({ version: 2, plugins }));
}

async function readInstalledState(): Promise<{
  version: number;
  plugins: Record<string, unknown>;
}> {
  return JSON.parse(await readFile(installedPath(), 'utf-8')) as {
    version: number;
    plugins: Record<string, unknown>;
  };
}
