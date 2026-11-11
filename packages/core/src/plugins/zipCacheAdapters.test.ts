/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BRAND_PLUGIN_META_DIR,
  ENV_PLUGIN_CACHE_DIR,
  ENV_PLUGIN_ZIP_CACHE,
} from '../config/brand.js';
import { getMarketplaceJsonRelativePath } from './zipCache.js';
import { saveMarketplaceJsonToZipCache } from './zipCacheAdapters.js';

const tmpDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const dir of tmpDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe('marketplace manifest zip cache', () => {
  it('caches branded metadata before the root fallback', async () => {
    const root = await mkdtemp(join(tmpdir(), 'marketplace-zip-test-'));
    tmpDirs.push(root);
    const cache = join(root, 'cache');
    const source = join(root, 'source');
    vi.stubEnv(ENV_PLUGIN_ZIP_CACHE, '1');
    vi.stubEnv(ENV_PLUGIN_CACHE_DIR, cache);
    await mkdir(join(source, BRAND_PLUGIN_META_DIR), { recursive: true });
    const content = JSON.stringify({ name: 'test-market' });
    await writeFile(join(source, BRAND_PLUGIN_META_DIR, 'marketplace.json'), content);
    await writeFile(join(source, 'marketplace.json'), '{}');

    await saveMarketplaceJsonToZipCache('test-market', source);

    expect(
      await readFile(
        join(cache, getMarketplaceJsonRelativePath('test-market')),
        'utf-8',
      ),
    ).toBe(content);
  });
});
