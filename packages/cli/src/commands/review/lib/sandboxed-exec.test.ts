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
  mountRootFor,
  refuseUnsandboxedPhase,
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
  it('does not let an already-sandboxed session satisfy `required`', () => {
    // The first cut returned `direct` here, reasoning that the outer boundary
    // is the one the operator asked for. That is wrong for the property this
    // module is about: the CLI's own sandbox constrains the filesystem and the
    // network and hands the child `process.env` ENTIRE — and stripping the
    // secrets is half of what `required` promises. So `SANDBOX` is not a
    // shortcut past the policy; the runtime probe still decides.
    const got = sandboxVerdict(
      'required',
      { SANDBOX: 'qwen-code-abc123' },
      () => null,
    );
    expect(got.kind).toBe('refused');
    expect(got.kind === 'refused' && got.reason).toContain(
      'does not satisfy "required"',
    );
  });

  it('turns `required` with no runtime into a refusal a phase can act on', () => {
    // The refusal has to reach something that stops the phase. Left to "the
    // caller", no caller acted and `required` ran the reviewed code
    // unsandboxed with the full environment — the policy meant nothing.
    const verdict = sandboxVerdict('required', {}, () => null);
    expect(refuseUnsandboxedPhase(verdict)).toContain('no container runtime');
    // ...and a verdict that is not a refusal never stops one.
    expect(refuseUnsandboxedPhase(sandboxVerdict('off', {}, () => null))).toBe(
      null,
    );
    expect(
      refuseUnsandboxedPhase(sandboxVerdict('auto', {}, () => 'docker')),
    ).toBe(null);
  });

  it('discloses rather than hides that the reviewed code ran as you', () => {
    const got = sandboxVerdict('off', {}, () => null);
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
    const env = containerEnv('/home-in-mount');
    expect(env).toEqual([
      'CI=1',
      'npm_config_yes=true',
      'QWEN_SKIP_PREPARE=1',
      // HOME inside the mount: forcing a uid resets it to `/`, which the
      // mapped user cannot write, and npm fails before the install starts.
      'HOME=/home-in-mount',
      'npm_config_cache=/home-in-mount/.npm',
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

  it('maps the host uid so its writes stay removable from the host', () => {
    // The container writes into a mount the HOST then cleans up — `node_modules`
    // after an install timeout, the tree at `discardWorktree`, the sweeps. Root
    // in the container makes every one of those EACCES, and the residue
    // accumulates across reviews: the cross-run-state class #9221 closed.
    const { args } = containerCommand('npm ci', {
      ...base,
      cwd: join(tmpDir, 'review-pr-9'),
      kind: 'install',
    });
    const user = args[args.indexOf('--user') + 1];
    expect(user).toBe(`${process.getuid?.()}:${process.getgid?.()}`);
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

describe('mountRootFor', () => {
  it('takes the DEEPEST temp dir, not the first', () => {
    // A review run from inside another review's worktree — this pipeline's own
    // dogfood geometry — nests one `.qwen/tmp` inside another. First-occurrence
    // search widens the mount to the OUTER temp dir, which pulls `<repo>/.git`
    // and every sibling checkout into the container and defeats the one
    // property the mount exists for.
    const nested = join(
      sep,
      'srv',
      '.qwen',
      'tmp',
      'checkouts',
      'myrepo',
      '.qwen',
      'tmp',
      'review-pr-1-probe',
    );
    expect(mountRootFor(nested)).toBe(
      join(sep, 'srv', '.qwen', 'tmp', 'checkouts', 'myrepo', '.qwen', 'tmp'),
    );
    // The flat case — the one the other tests exercise — is unchanged.
    expect(mountRootFor(join(sep, 'repo', '.qwen', 'tmp', 'review-pr-9'))).toBe(
      join(sep, 'repo', '.qwen', 'tmp'),
    );
  });

  it('is null outside a temp dir, so a local checkout is never mounted', () => {
    // `/review` of a local checkout has no sibling layout: the tree under test
    // IS the user's working copy.
    expect(mountRootFor(join(sep, 'home', 'me', 'myrepo'))).toBe(null);
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
