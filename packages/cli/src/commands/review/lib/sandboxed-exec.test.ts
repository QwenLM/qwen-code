/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The reviewed repository's own commands, and the boundary they run behind
// (#9556). What these pin is not that a container starts — that needs a
// runtime and belongs to an integration harness — but the three decisions the
// argv encodes: what is mounted, what crosses in the environment, and what
// happens when there is no runtime at all.

import { describe, it, expect } from 'vitest';
import { join, sep } from 'node:path';
import {
  containerCommand,
  containerEnv,
  reviewSandboxImage,
  sandboxPolicy,
  sandboxVerdict,
} from './sandboxed-exec.js';

describe('sandboxPolicy', () => {
  it('lets the environment outrank the setting, and defaults to off', () => {
    // CI has to be able to require containment without depending on a
    // settings file the runner may not carry.
    expect(sandboxPolicy({ QWEN_REVIEW_SANDBOX: 'required' }, {})).toBe(
      'required',
    );
    expect(
      sandboxPolicy({ QWEN_REVIEW_SANDBOX: 'auto' }, { sandbox: 'off' }),
    ).toBe('auto');
    expect(sandboxPolicy({}, { sandbox: 'required' })).toBe('required');
    // Today every review runs the reviewed code directly; turning that into a
    // container by default would change what native modules compile against
    // on machines nobody asked.
    expect(sandboxPolicy({}, {})).toBe('off');
    // A garbled value is not a policy — it falls through rather than being
    // guessed at.
    expect(sandboxPolicy({ QWEN_REVIEW_SANDBOX: 'yes' }, {})).toBe('off');
  });
});

describe('sandboxVerdict', () => {
  it('does not nest: an already-sandboxed session runs direct', () => {
    // `sandbox.ts` sets SANDBOX to the seatbelt profile or the container name.
    // The outer boundary is the one the operator asked for.
    const got = sandboxVerdict('required', { SANDBOX: 'qwen-code-abc123' });
    expect(got.kind).toBe('direct');
    expect(got.kind === 'direct' && got.disclose).toContain(
      'already sandboxed',
    );
  });

  it('discloses rather than hides that the reviewed code ran as you', () => {
    const got = sandboxVerdict('off', {});
    expect(got.kind).toBe('direct');
    expect(got.kind === 'direct' && got.disclose).toContain('ran as you');
  });
});

describe('containerCommand', () => {
  const tmpDir = join(sep, 'repo', '.qwen', 'tmp');
  const base = {
    tmpDir,
    runtime: 'docker' as const,
    image: 'example/image:tag',
  };

  it('mounts the review temp dir, not the tree the command runs in', () => {
    // The dependency farm links OUT of every tree: each package in the probe
    // tree's `node_modules` points at the review worktree's copy (1 722 of
    // them on a live CI review). Mounting the probe tree alone would leave
    // every one of those dangling and no probe would resolve a dependency.
    const probeTree = join(tmpDir, 'review-pr-9-probe');
    const { file, args } = containerCommand('npm test', {
      ...base,
      cwd: probeTree,
      kind: 'test',
    });

    expect(file).toBe('docker');
    const mount = args[args.indexOf('--volume') + 1];
    expect(mount).toBe(`${tmpDir}:${tmpDir}`);
    expect(mount).not.toContain('-probe');
    // ...and the command still RUNS in the tree.
    expect(args[args.indexOf('--workdir') + 1]).toBe(probeTree);
    // `<repo>/.git` — the filter/fsmonitor/replace surface — is outside it.
    expect(mount.startsWith(join(sep, 'repo', '.git'))).toBe(false);
  });

  it('gives the network to an install and to nothing else', () => {
    const cwd = join(tmpDir, 'review-pr-9');
    const install = containerCommand('npm ci', {
      ...base,
      cwd,
      kind: 'install',
    });
    expect(install.args).not.toContain('none');

    for (const kind of ['build', 'test'] as const) {
      const r = containerCommand('npm run build', { ...base, cwd, kind });
      expect(r.args[r.args.indexOf('--network') + 1]).toBe('none');
    }
  });

  it('hands the reviewed code an env allowlist, never the inherited one', () => {
    // This is the finding the design is built on: both call sites used to give
    // the PR's code `process.env`, which on CI carries the review's model and
    // GitHub credentials. A `postinstall` reading them is one line.
    const env = containerEnv('/cache');
    expect(env).toEqual([
      'CI=1',
      'npm_config_yes=true',
      'QWEN_SKIP_PREPARE=1',
      'npm_config_cache=/cache',
    ]);

    const { args } = containerCommand('npm ci', {
      ...base,
      cwd: join(tmpDir, 'review-pr-9'),
      kind: 'install',
    });
    const passed = args.filter((_, i) => args[i - 1] === '--env');
    expect(passed.some((e) => /TOKEN|KEY|SECRET|PASSWORD/i.test(e))).toBe(
      false,
    );
  });

  it('runs one ephemeral container per command', () => {
    // Not one long-lived container per phase: that would be cheaper by about
    // a percent of the efficacy budget and would re-introduce the cross-run
    // state this pipeline spent rounds closing.
    const { args } = containerCommand('npm test', {
      ...base,
      cwd: join(tmpDir, 'review-pr-9-probe'),
      kind: 'test',
    });
    expect(args[0]).toBe('run');
    expect(args).toContain('--rm');
  });

  it('passes the command to a shell inside, not to the host', () => {
    const { args } = containerCommand('npm ci && npm test', {
      ...base,
      cwd: join(tmpDir, 'review-pr-9'),
      kind: 'install',
    });
    expect(args.slice(-3)).toEqual(['sh', '-lc', 'npm ci && npm test']);
  });
});

describe('reviewSandboxImage', () => {
  it('is overridable, because one image cannot carry every toolchain', () => {
    expect(reviewSandboxImage({ QWEN_REVIEW_SANDBOX_IMAGE: 'mine:1' })).toBe(
      'mine:1',
    );
    expect(reviewSandboxImage({})).toContain('sandbox');
  });
});
