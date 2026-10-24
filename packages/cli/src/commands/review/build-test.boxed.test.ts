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
    // The host asks npm for the tree's own node-options; the runtime runs
    // the command.
    mocks.spawnSync.mockImplementation((file: string) => ({
      status: 0,
      signal: null,
      stdout:
        file === 'npm'
          ? '--require=/w/preload.cjs --max-old-space-size=512\n'
          : '',
      stderr: '',
    }));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const callsOf = (file: string): unknown[][] =>
    mocks.spawnSync.mock.calls.filter((c) => c[0] === file);
  const envEntries = (): string[] => {
    const args = callsOf('docker')[0]![1] as string[];
    return args.filter((_, i) => args[i - 1] === '--env');
  };

  it('hands a build and an install the heap, and a test none', () => {
    for (const kind of ['build', 'install'] as const) {
      mocks.spawnSync.mockClear();
      run('npm run build', root, 30_000, kind);
      expect(callsOf('docker')).toHaveLength(1);
      expect(envEntries()).toContain('NODE_OPTIONS=--max-old-space-size=6144');
      // The tree's own npm options, raised and kept whole.
      expect(envEntries()).toContain(
        'npm_config_node_options=--require=/w/preload.cjs --max-old-space-size=6144',
      );
    }
    mocks.spawnSync.mockClear();
    run('npm test', root, 30_000, 'test');
    expect(
      envEntries().some(
        (e) =>
          e.startsWith('NODE_OPTIONS=') ||
          e.startsWith('npm_config_node_options='),
      ),
    ).toBe(false);
  });

  it("asks npm what the container sees: the tree's .npmrc, no user or global file, no host variable", () => {
    vi.stubEnv('npm_config_node_options', '--max-old-space-size=700');
    vi.stubEnv('QWEN_BT_SECRET', 'host-secret');
    try {
      run('npm run build', root, 30_000, 'build');
      const [, args, opts] = callsOf('npm')[0]! as [
        string,
        string[],
        { cwd: string; env: NodeJS.ProcessEnv },
      ];
      expect(args.slice(0, 3)).toEqual(['config', 'get', 'node-options']);
      expect(args).toContain('--userconfig');
      expect(args).toContain('--globalconfig');
      expect(opts.cwd).toBe(root);
      // What npm needs to start, and nothing a `${VAR}` could name.
      expect(
        Object.keys(opts.env).every((k) =>
          ['path', 'pathext', 'systemroot', 'comspec'].includes(
            k.toLowerCase(),
          ),
        ),
      ).toBe(true);
      expect(Object.keys(opts.env).length).toBeGreaterThan(0);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
