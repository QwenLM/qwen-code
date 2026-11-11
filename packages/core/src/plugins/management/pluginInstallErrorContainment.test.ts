/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Regression coverage for the diagnosability half of the reported marketplace
 * install failure (`Install failed: undefined is not an object (evaluating
 * 'C.close().catch')`).
 *
 * The runtime cause of that message is fixed in `copyDirectory`, but the
 * install pipeline still let any throw from the cache/commit stage escape the
 * `CacheAndRegisterResult | CacheAndRegisterError` contract completely
 * unlogged, so the TUI showed a bare runtime message and `qwen.log` held
 * nothing at all. `copyPluginTree` is mocked here to throw on the commit copy
 * — the exact stage that failed for the reporter — because reproducing it for
 * real requires the packaged bun runtime.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ENV_PLUGIN_CACHE_DIR } from '../../config/brand.js';
import { runLogger } from '../../utils/runLogger.js';
import { invalidateInstalledPluginsCache } from './installedPluginsManager.js';
import { getVersionedCachePath } from '../pluginDirectories.js';
import { cacheAndRegisterPlugin } from './pluginInstallationHelpers.js';
const COMMIT_COPY_FAILURE =
  "undefined is not an object (evaluating 'C.close().catch')";

let copyCalls = 0;
let commitCopyFailure: unknown;

vi.mock('../pluginTreeCopy.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../pluginTreeCopy.js')>();
  return {
    ...actual,
    copyPluginTree: (async (
      ...args: Parameters<typeof actual.copyPluginTree>
    ) => {
      copyCalls++;
      // Call 1 stages the source into the temp dir; call 2 is the commit copy
      // into the versioned cache, which is where the reporter's install died.
      if (copyCalls === 2) {
        throw commitCopyFailure;
      }
      return actual.copyPluginTree(...args);
    }) as typeof actual.copyPluginTree,
  };
});

const tempDirs: string[] = [];

async function createTempDir(label: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `plugin-install-error-${label}-`));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  copyCalls = 0;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  invalidateInstalledPluginsCache();
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe.skipIf(process.platform === 'win32')(
  'cacheAndRegisterPlugin when the cache commit throws',
  () => {
    it.each([
      {
        label: 'an Error',
        failure: new TypeError(COMMIT_COPY_FAILURE),
        expectedMessage: COMMIT_COPY_FAILURE,
        expectedLogDetail: `TypeError: ${COMMIT_COPY_FAILURE}`,
      },
      {
        label: 'a non-stringifiable thrown value',
        failure: Object.create(null),
        expectedMessage: 'Failed to get error details',
        expectedLogDetail: 'Failed to get error details',
      },
    ])(
      'returns a structured, attributed error and logs details for $label',
      async ({ failure, expectedMessage, expectedLogDetail }) => {
        commitCopyFailure = failure;
        const pluginHome = await createTempDir('home');
        const marketplaceRoot = await createTempDir('marketplace');
        vi.stubEnv(ENV_PLUGIN_CACHE_DIR, pluginHome);
        invalidateInstalledPluginsCache();
        const errorLog = vi
          .spyOn(runLogger, 'error')
          .mockImplementation(() => {});

        const pluginRoot = join(marketplaceRoot, 'plugins', 'demo');
        await mkdir(join(pluginRoot, '.claude-plugin'), { recursive: true });
        await mkdir(join(pluginRoot, 'skills'), { recursive: true });
        await writeFile(
          join(pluginRoot, '.claude-plugin', 'plugin.json'),
          JSON.stringify({ name: 'demo', version: '1.0.0' }),
        );

        const cache = getVersionedCachePath('team-market', 'demo', '1.0.0');
        await mkdir(cache, { recursive: true });
        await writeFile(join(cache, 'old.txt'), 'keep');

        const result = await cacheAndRegisterPlugin(
          'demo@team-market',
          pluginRoot,
          'user',
          { marketplaceInstallLocation: marketplaceRoot, version: '1.0.0' },
        );

        await expect(readFile(join(cache, 'old.txt'), 'utf8')).resolves.toBe(
          'keep',
        );
        expect(copyCalls).toBe(2);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error).toMatchObject({
          type: 'generic-error',
          source: 'cache',
          plugin: 'demo@team-market',
        });
        const message =
          'error' in result.error ? String(result.error.error) : '';
        expect(message).toContain('demo@team-market');
        expect(message).toContain(expectedMessage);

        const logged = errorLog.mock.calls.map((call) => String(call[0]));
        expect(
          logged.some(
            (line) =>
              line.includes('demo@team-market') &&
              line.includes(expectedLogDetail),
          ),
        ).toBe(true);
      },
    );
  },
);
