/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';

import { copyBundleAssets } from '../copy_bundle_assets.js';

const tempRoots = [];

describe('copyBundleAssets', () => {
  afterEach(async () => {
    await Promise.all(
      tempRoots
        .splice(0)
        .map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  it('copies extension boilerplate examples into dist', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qwen-bundle-assets-'));
    tempRoots.push(root);

    await mkdir(join(root, 'packages'), { recursive: true });
    await writeFile(join(root, 'packages', 'sandbox.sb'), 'sandbox');
    await mkdir(join(root, 'packages', 'core', 'vendor', 'rg'), {
      recursive: true,
    });
    await writeFile(
      join(root, 'packages', 'core', 'vendor', 'rg', 'README'),
      'rg',
    );
    await mkdir(
      join(root, 'packages', 'core', 'src', 'skills', 'bundled', 'review'),
      { recursive: true },
    );
    await writeFile(
      join(
        root,
        'packages',
        'core',
        'src',
        'skills',
        'bundled',
        'review',
        'SKILL.md',
      ),
      'review',
    );
    await mkdir(join(root, 'docs', 'users'), { recursive: true });
    await writeFile(join(root, 'docs', 'users', 'commands.md'), 'commands');
    await mkdir(join(root, 'packages', 'cli', 'src', 'i18n', 'locales'), {
      recursive: true,
    });
    await writeFile(
      join(root, 'packages', 'cli', 'src', 'i18n', 'locales', 'en.json'),
      '{}',
    );
    await mkdir(
      join(
        root,
        'packages',
        'cli',
        'src',
        'commands',
        'extensions',
        'examples',
        'mcp-server',
      ),
      { recursive: true },
    );
    await writeFile(
      join(
        root,
        'packages',
        'cli',
        'src',
        'commands',
        'extensions',
        'examples',
        'mcp-server',
        'qwen-extension.json',
      ),
      '{"name":"mcp-server"}',
    );

    copyBundleAssets(root);

    expect(existsSync(join(root, 'dist', 'sandbox.sb'))).toBe(true);
    expect(existsSync(join(root, 'dist', 'examples', 'mcp-server'))).toBe(true);
    await expect(
      readFile(
        join(root, 'dist', 'examples', 'mcp-server', 'qwen-extension.json'),
        'utf-8',
      ),
    ).resolves.toContain('mcp-server');
  });
});
