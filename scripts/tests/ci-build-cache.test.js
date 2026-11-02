/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

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
