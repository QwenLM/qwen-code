/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from './build-test.js';

// `run()` on its boxed branch: a sandboxed review is how `/review` runs a
// PR's own commands, and no runtime is needed to see the argv it is handed.
const mocks = vi.hoisted(() => ({
  spawnSync: vi.fn(),
  mountRoot: '',
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    default: { ...actual, spawnSync: mocks.spawnSync },
    spawnSync: mocks.spawnSync,
  };
});

vi.mock('./lib/sandboxed-exec.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./lib/sandboxed-exec.js')>();
  return {
    ...actual,
    sandboxVerdict: () => ({ kind: 'container', runtime: 'docker' }),
    mountRootFor: () => mocks.mountRoot,
    containerPathFor: () => '/workspace/review-pr-9',
    runtimeIsRootless: () => false,
    reviewSandboxImage: () => 'example/image:tag',
  };
});

describe('run (boxed): the declared heap reaches the container', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'bt-boxed-'));
    mocks.mountRoot = root;
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'r',
        scripts: {
          build: 'cross-env NODE_OPTIONS="--max-old-space-size=6144" node b.js',
        },
      }),
    );
    mocks.spawnSync.mockReset();
    mocks.spawnSync.mockReturnValue({
      status: 0,
      signal: null,
      stdout: '',
      stderr: '',
    });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const envEntries = (): string[] => {
    const args = mocks.spawnSync.mock.calls[0]![1] as string[];
    return args.filter((_, i) => args[i - 1] === '--env');
  };

  it('hands a build and an install the heap, and a test none', () => {
    for (const kind of ['build', 'install'] as const) {
      mocks.spawnSync.mockClear();
      run('npm run build', root, 30_000, kind);
      expect(mocks.spawnSync.mock.calls[0]![0]).toBe('docker');
      expect(envEntries()).toContain('NODE_OPTIONS=--max-old-space-size=6144');
    }
    mocks.spawnSync.mockClear();
    run('npm test', root, 30_000, 'test');
    expect(envEntries().some((e) => e.startsWith('NODE_OPTIONS='))).toBe(false);
  });
});
