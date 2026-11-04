/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  changedWorkspaces,
  hashWorkspaces,
  isGlobalInput,
  isTestFile,
} from '../ci-build-cache.mjs';

const workspaces = [
  { name: 'core', dir: 'packages/core', deps: ['vitest'] },
  { name: 'cli', dir: 'packages/cli', deps: ['core'] },
  { name: 'channel', dir: 'packages/channels/base', deps: [] },
  { name: 'nested', dir: 'packages/channels/base/nested', deps: [] },
];
const files = [
  { path: 'package.json', blob: 'a1' },
  { path: 'scripts/build_package.js', blob: 'a2' },
  { path: 'packages/core/src/index.ts', blob: 'b1' },
  { path: 'packages/cli/src/index.ts', blob: 'c1' },
  { path: 'packages/channels/base/src/index.ts', blob: 'd1' },
  { path: 'packages/channels/base/nested/src/index.ts', blob: 'e1' },
];
const hashAfter = (path, blob) =>
  hashWorkspaces(
    workspaces,
    files.some((file) => file.path === path)
      ? files.map((file) => (file.path === path ? { path, blob } : file))
      : [...files, { path, blob }],
  );
const changedBy = (path, blob = 'changed') =>
  changedWorkspaces(hashAfter(path, blob), hashWorkspaces(workspaces, files));

describe('ci-build-cache', () => {
  it('rebuilds a changed workspace and every workspace depending on it', () => {
    expect(changedBy('packages/core/src/index.ts')).toEqual(['core', 'cli']);
    expect(changedBy('packages/cli/src/index.ts')).toEqual(['cli']);
  });

  it('gives a nested workspace its own files', () => {
    expect(changedBy('packages/channels/base/nested/src/index.ts')).toEqual([
      'nested',
    ]);
    expect(changedBy('packages/channels/base/src/index.ts')).toEqual([
      'channel',
    ]);
  });

  it('rebuilds everything when a shared build input changes', () => {
    expect(changedBy('package.json')).toEqual(workspaces.map((w) => w.name));
    expect(changedBy('scripts/build_package.js')).toEqual(
      workspaces.map((w) => w.name),
    );
  });

  it('ignores tests and paths no build reads', () => {
    expect(changedBy('packages/core/src/index.test.ts')).toEqual([]);
    expect(changedBy('packages/cli/src/__snapshots__/a.snap')).toEqual([]);
    expect(changedBy('scripts/tests/build.test.js')).toEqual([]);
    expect(changedBy('docs/guide.md')).toEqual([]);
    expect(changedBy('.github/workflows/ci.yml')).toEqual([]);
  });

  it('rebuilds everything when nothing was stored', () => {
    expect(changedWorkspaces(hashWorkspaces(workspaces, files), null)).toEqual(
      workspaces.map((w) => w.name),
    );
  });

  it('classifies test files and shared build inputs', () => {
    expect(isTestFile('src/a.test.tsx')).toBe(true);
    expect(isTestFile('src/a.spec.mjs')).toBe(true);
    expect(isTestFile('src/__tests__/helper.ts')).toBe(true);
    expect(isTestFile('src/testing.ts')).toBe(false);
    expect(isGlobalInput('pnpm-lock.yaml')).toBe(true);
    expect(isGlobalInput('patches/ink+7.0.3.patch')).toBe(true);
    expect(isGlobalInput('scripts/copy_files.js')).toBe(true);
    expect(isGlobalInput('scripts/tests/a.test.js')).toBe(false);
    expect(isGlobalInput('docs/a.md')).toBe(false);
  });
});

// The three modes that run in CI call git, pnpm, npm and tar, so they are
// exercised as the real CLI against a fixture repository with those binaries
// stubbed. The pure-helper tests above never reach `main()`, so a broken
// `builtPaths()` filter — the one both `pack` and the `rm -rf` purge use —
// could take every shard down while the unit suite stayed green.
const scriptPath = join(import.meta.dirname, '..', 'ci-build-cache.mjs');

function makeFixture() {
  const repo = mkdtempSync(join(tmpdir(), 'ci-build-cache-fixture-'));
  const workspace = join(repo, 'packages/a');
  const shims = join(repo, '.shims');
  const calls = join(repo, '.calls');
  const workspacesJson = join(repo, '.workspaces.json');

  mkdirSync(join(workspace, 'src'), { recursive: true });
  mkdirSync(join(workspace, 'dist'), { recursive: true });
  mkdirSync(join(repo, 'node_modules/x'), { recursive: true });
  mkdirSync(shims, { recursive: true });
  writeFileSync(join(repo, '.gitignore'), 'dist/\nnode_modules/\n');
  writeFileSync(join(repo, 'package.json'), '{"name":"root","private":true}\n');
  writeFileSync(
    join(workspace, 'package.json'),
    '{"name":"a","version":"1.0.0"}\n',
  );
  writeFileSync(join(workspace, 'src/index.ts'), 'export {};\n');
  writeFileSync(join(workspace, 'dist/out.js'), 'built\n');
  writeFileSync(join(repo, 'node_modules/x/index.js'), 'dep\n');
  writeFileSync(
    workspacesJson,
    JSON.stringify([{ name: 'a', path: workspace }]),
  );

  const shim = (name, body) => {
    const path = join(shims, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
  };
  shim('npm', 'printf \'npm %s\\n\' "$*" >> "$CALLS"');
  shim('node', 'printf \'node %s\\n\' "$*" >> "$CALLS"');
  shim(
    'corepack',
    'printf \'corepack %s\\n\' "$*" >> "$CALLS"\n' +
      'case "$*" in *"ls -r"*) cat "$WORKSPACES" ;; esac',
  );

  execFileSync('git', ['init', '-q', '.'], { cwd: repo });
  execFileSync('git', ['add', '-A'], { cwd: repo });

  const env = {
    ...process.env,
    CI_BUILD_CACHE_ROOT: repo,
    PATH: `${shims}:${process.env.PATH}`,
    CALLS: calls,
    WORKSPACES: workspacesJson,
  };
  const run = (...argv) => {
    writeFileSync(calls, '');
    const stdout = execFileSync(process.execPath, [scriptPath, ...argv], {
      cwd: repo,
      env,
      encoding: 'utf8',
    });
    return { stdout, calls: readFileSync(calls, 'utf8') };
  };
  return {
    repo,
    run,
    cleanup: () => rmSync(repo, { recursive: true, force: true }),
  };
}

describe('ci-build-cache CLI', () => {
  it('packs the built tree without node_modules', () => {
    const fixture = makeFixture();
    try {
      const cache = join(fixture.repo, '.cache');
      fixture.run('pack', cache);
      expect(existsSync(join(cache, 'hashes.json'))).toBe(true);
      const listed = execFileSync('tar', ['-tzf', join(cache, 'tree.tgz')], {
        encoding: 'utf8',
      })
        .split('\n')
        .filter(Boolean);
      expect(listed).toContain('packages/a/dist/');
      // The filter feeds both this archive and the `rm -rf` purge of a changed
      // workspace: if it stops matching, the cache entry carries every
      // node_modules tree and the incremental build deletes one it still needs.
      expect(listed.some((path) => path.startsWith('node_modules'))).toBe(
        false,
      );
    } finally {
      fixture.cleanup();
    }
  });

  it('restores a cache hit, rebuilds nothing, and still runs the build preflight', () => {
    const fixture = makeFixture();
    try {
      const cache = join(fixture.repo, '.cache');
      fixture.run('pack', cache);
      rmSync(join(fixture.repo, 'packages/a/dist'), {
        recursive: true,
        force: true,
      });

      const { calls } = fixture.run('build', cache);
      expect(calls).toContain('node scripts/build.js --preflight');
      expect(calls).toContain('npm run generate');
      expect(calls).toContain('npm run bundle');
      // The cached branch rebuilds only changed workspaces; `npm run build`
      // would rebuild every one of them.
      expect(calls).not.toContain('npm run build');
      expect(calls).not.toMatch(/corepack pnpm -r .*run build/);
      // The preflight guards the ink patch packages/cli typechecks against,
      // and this branch never reaches scripts/build.js otherwise.
      expect(calls.indexOf('node scripts/build.js --preflight')).toBeLessThan(
        calls.indexOf('npm run generate'),
      );
      expect(existsSync(join(fixture.repo, 'packages/a/dist/out.js'))).toBe(
        true,
      );
    } finally {
      fixture.cleanup();
    }
  });

  it('builds everything when no cache was stored', () => {
    const fixture = makeFixture();
    try {
      const { calls } = fixture.run('build', join(fixture.repo, '.missing'));
      expect(calls).toContain('npm run build');
      expect(calls).toContain('npm run bundle');
    } finally {
      fixture.cleanup();
    }
  });

  it('prints one key per tracked tree', () => {
    const fixture = makeFixture();
    try {
      const first = fixture.run('key').stdout.trim();
      expect(first).toMatch(/^[0-9a-f]{64}$/);
      expect(fixture.run('key').stdout.trim()).toBe(first);
      // The key reads the index, so the fixture restages after the edit.
      writeFileSync(
        join(fixture.repo, 'packages/a/src/index.ts'),
        'export {}; //x\n',
      );
      execFileSync('git', ['add', '-A'], { cwd: fixture.repo });
      expect(fixture.run('key').stdout.trim()).not.toBe(first);
    } finally {
      fixture.cleanup();
    }
  });
});
