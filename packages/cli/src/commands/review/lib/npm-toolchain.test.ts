/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { npmToolchainAdapter } from './npm-toolchain.js';
import { selectToolchainAdapter } from './toolchain.js';

const okExec = (command: string) => ({
  command,
  exitCode: 0,
  seconds: 1,
  timedOut: false,
  output: '',
});

describe('npm toolchain adapter', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'npm-toolchain-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('selects the npm adapter for a repository with package.json', () => {
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'root', workspaces: ['packages/*'] }),
    );
    mkdirSync(join(root, 'packages', 'a'), { recursive: true });
    writeFileSync(
      join(root, 'packages', 'a', 'package.json'),
      JSON.stringify({ name: '@x/a', scripts: { build: 'exit 0' } }),
    );

    expect(selectToolchainAdapter(root, [npmToolchainAdapter])).toBe(
      npmToolchainAdapter,
    );
    expect(npmToolchainAdapter.applies(root)).toBe(true);
  });

  it('does not select the npm adapter for a non-npm repository', () => {
    expect(selectToolchainAdapter(root, [npmToolchainAdapter])).toBeNull();
    expect(npmToolchainAdapter.applies(root)).toBe(false);
  });

  it('fails closed when more than one adapter applies', () => {
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ scripts: { build: 'exit 0' } }),
    );
    const other = { applies: () => true, run: npmToolchainAdapter.run };

    expect(
      selectToolchainAdapter(root, [npmToolchainAdapter, other]),
    ).toBeNull();
  });

  it('returns the unchanged report shape for a supported single-root package', () => {
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'root',
        scripts: { build: 'exit 0', test: 'exit 0' },
      }),
    );

    expect(
      npmToolchainAdapter.run({
        root,
        changedFiles: ['src/index.ts'],
        timeout: 5,
        install: false,
        exec: okExec,
      }),
    ).toEqual({
      toolchain: 'npm',
      affected: ['.'],
      buildSet: ['.'],
      widenedWith: [],
      install: null,
      build: [
        {
          command: 'npm run build',
          exitCode: 0,
          seconds: 1,
          timedOut: false,
          output: '',
        },
      ],
      test: [
        {
          command: 'npm test',
          exitCode: 0,
          seconds: 1,
          timedOut: false,
          output: '',
        },
      ],
      ok: true,
      timedOut: [],
      note:
        'Built 1 of 1 workspaces (the 1 the diff changes, plus what they compile ' +
        'against) and ran the tests of the changed ones. Everything passed.',
    });
  });

  it('keeps an unmodeled npm layout on the structured unsupported path', () => {
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'root', workspaces: ['packages/**'] }),
    );

    const report = npmToolchainAdapter.run({
      root,
      changedFiles: ['packages/a/src/x.ts'],
      timeout: 5,
      install: false,
      exec: okExec,
    });
    expect(report).toEqual({
      toolchain: 'unsupported',
      affected: [],
      buildSet: [],
      widenedWith: [],
      install: null,
      build: [],
      test: [],
      ok: true,
      timedOut: [],
      note:
        'This repo uses a workspace glob shape this command does not model ' +
        '(e.g. `**`, an inner `*`, or a `foo-*` prefix), so it cannot safely decide ' +
        'which packages the diff touches. Fall back to the build/test precedence in ' +
        'your brief, and give each command a deadline it can actually meet.',
    });
  });

  it('does not treat a workspace repo as single-root when the root has scripts', () => {
    // The single-root guard must fire ONLY for a workspace-less repo. A monorepo
    // whose root package.json also has build/test scripts (this repo's shape) must
    // still map the diff to its workspace. Forcing the guard on would set
    // singleRoot, scope the build to '.', and silently skip the changed workspace.
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'root',
        workspaces: ['packages/*'],
        scripts: { build: 'exit 0', test: 'exit 0' },
      }),
    );
    mkdirSync(join(root, 'packages', 'a'), { recursive: true });
    writeFileSync(
      join(root, 'packages', 'a', 'package.json'),
      JSON.stringify({
        name: '@x/a',
        scripts: { build: 'exit 0', test: 'exit 0' },
      }),
    );

    const report = npmToolchainAdapter.run({
      root,
      changedFiles: ['packages/a/src/x.ts'],
      timeout: 5,
      install: false,
      exec: okExec,
    });

    expect(report.toolchain).toBe('npm');
    // The diff maps to the workspace, NOT the root package.
    expect(report.affected).toEqual(['packages/a']);
    expect(report.build.map((b) => b.command)).toEqual([
      'npm run build --workspace="packages/a"',
    ]);
    expect(report.test.map((t) => t.command)).toEqual([
      'npm test --workspace="packages/a"',
    ]);
  });
});
