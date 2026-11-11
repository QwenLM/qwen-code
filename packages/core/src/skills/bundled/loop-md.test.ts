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

describe('loop-md project config directory', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'loop-md-'));
    vi.stubEnv('BRAND_ENV_PREFIX', 'EXAMPLE_');
    vi.stubEnv('EXAMPLE_CONFIG_DIR_NAME', 'abc');
    vi.resetModules();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.resetModules();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('reads loop.md from the configured project config directory', async () => {
    await fs.mkdir(path.join(root, 'abc'), { recursive: true });
    await fs.writeFile(path.join(root, 'abc', 'loop.md'), '- task one\n');
    // A stale .qwen/loop.md must not shadow the configured directory.
    await fs.mkdir(path.join(root, '.qwen'), { recursive: true });
    await fs.writeFile(path.join(root, '.qwen', 'loop.md'), '- stale\n');

    const { readLoopMd } = await import('./loop-md.js');

    expect((await readLoopMd(root))?.content).toBe('- task one\n');
  });

  it('reports existence from the configured project config directory', async () => {
    await fs.mkdir(path.join(root, '.qwen'), { recursive: true });
    await fs.writeFile(path.join(root, '.qwen', 'loop.md'), '- stale\n');

    const { hasLoopMd } = await import('./loop-md.js');

    expect(await hasLoopMd(root)).toBe(false);

    await fs.mkdir(path.join(root, 'abc'), { recursive: true });
    await fs.writeFile(path.join(root, 'abc', 'loop.md'), '- task\n');

    expect(await hasLoopMd(root)).toBe(true);
  });
});
