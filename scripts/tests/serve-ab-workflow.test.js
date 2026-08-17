/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const workflow = readFileSync('.github/workflows/serve-ab.yml', 'utf8');

const steps = parse(workflow).jobs['ab'].steps;
const WIPE = 'Wipe stale workspace before checkout';
const wipe = steps.find((s) => s.name === WIPE);

// Runs the real wipe script under the runner's shell flags: this job sets
// `defaults.run.shell: bash`, which GitHub Actions executes with
// `-eo pipefail`, so the exec tests must reproduce that instead of hiding
// it behind bare `bash -c`.
const runWipe = (env, options = {}) =>
  execFileSync('bash', ['-e', '-o', 'pipefail', '-c', wipe.run], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    ...options,
  });

// `realpath -m` (the script's canonicalization line) is a GNU coreutils
// extension. Probe the host before asserting GNU-specific path behavior.
const hasGnuRealpath =
  spawnSync('realpath', ['-m', '--', '/'], { stdio: 'ignore' }).status === 0;

describe('serve-ab pre-checkout workspace wipe', () => {
  it('runs only on self-hosted runners, where workspace state persists', () => {
    expect(wipe).toBeTruthy();
    // Hosted runners are ephemeral; the wipe (and its guard) exist for the
    // reusable ECS pool only.
    expect(wipe.if).toBe("${{ runner.environment == 'self-hosted' }}");
  });

  it('carries the full checkout-heal guard (#9220, #9265)', () => {
    // Before the port this step had NO guard: under a mangled env even
    // `/home` or an empty string reached `find … -exec rm -rf {} +`.
    // Pin each ported layer textually, mirroring the reference guard in
    // qwen-code-pr-review.yml; the exec tests below prove the behavior.
    expect(wipe.run).toContain('GITHUB_WORKSPACE:?');
    expect(wipe.run).toContain('realpath -m');
    expect(wipe.run).toContain('refusing to wipe suspicious workspace path');
    expect(wipe.run).toContain('RUNNER_WORKSPACE:?');
    expect(wipe.run).toContain('"$RWS"/*');
    // Exit contract: the wipe stays bare on purpose — under the job's
    // `-eo pipefail` a wipe that cannot clear the workspace fails the job
    // here instead of building both checkouts on top of the leftovers.
    // `|| true` would silently void that.
    expect(wipe.run).not.toContain('|| true');
  });

  it.skipIf(!hasGnuRealpath)(
    'wipes a legitimate workspace inside the runner workspace',
    () => {
      const parent = mkdtempSync(join(tmpdir(), 'serve-ab-wipe-ok-'));
      const ws = join(parent, 'repo');
      // Leftovers shaped like the real ones: the two checkout subtrees plus
      // a stale build artifact.
      mkdirSync(join(ws, 'head'), { recursive: true });
      mkdirSync(join(ws, 'base'), { recursive: true });
      writeFileSync(join(ws, 'head', 'package.json'), '{}');
      writeFileSync(join(ws, 'bundle.tgz'), 'x');
      try {
        runWipe({ GITHUB_WORKSPACE: ws, RUNNER_WORKSPACE: parent });
        expect(readdirSync(ws)).toEqual([]);
        // The directory itself survives: the checkouts clone into it next.
        expect(wipe.run).toContain('-mindepth 1 -maxdepth 1');
      } finally {
        rmSync(parent, { recursive: true, force: true });
      }
    },
  );

  // The guard must be exercised with the REAL dangerous paths, so `rm` is
  // stubbed to a recorder on PATH: the destructive primitive cannot fire
  // here under ANY edit, and the assertion is on the decision rather than
  // on filesystem effects — with the guard gone the recorder shows an
  // attempted delete and the test fails, having deleted nothing.
  it('refuses suspicious workspace paths without invoking rm', () => {
    const dir = mkdtempSync(join(tmpdir(), 'serve-ab-wipe-guard-'));
    try {
      const calls = join(dir, 'rm-calls');
      writeFileSync(
        join(dir, 'rm'),
        `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\nexit 0\n`,
        { mode: 0o755 },
      );

      // Canonical roots, the non-canonical spellings the canonicalize and
      // strip layers exist for, and /tmp + /opt which only the allowlist
      // refuses (the denylist has no arm for them).
      for (const bad of [
        '/',
        '/usr',
        '/etc',
        '/var',
        '/root',
        '/home',
        '',
        '/home/',
        '/root/',
        '/var/',
        '//',
        '/home//',
        '/home/.',
        '/home/..',
        '//usr',
        '//home',
        '/tmp',
        '/opt',
      ]) {
        writeFileSync(calls, '');
        const guard = spawnSync(
          'bash',
          ['-e', '-o', 'pipefail', '-c', wipe.run],
          {
            encoding: 'utf8',
            env: {
              ...process.env,
              PATH: `${dir}:${process.env.PATH}`,
              GITHUB_WORKSPACE: bad,
              // The recorder dir doubles as the allowlist root: every bad
              // path sits outside it, so the refusal is the guard's, not
              // a side effect of the fixture layout.
              RUNNER_WORKSPACE: dir,
            },
          },
        );
        expect(
          guard.status,
          `path ${bad || '<empty>'} was not refused`,
        ).not.toBe(0);
        expect(
          readFileSync(calls, 'utf8'),
          `rm was invoked for ${bad || '<empty>'}`,
        ).toBe('');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!hasGnuRealpath)(
    'refuses an allowlist-escaping .. path via canonicalization',
    () => {
      // The bad paths above all sit outside the recorder dir, so the
      // allowlist refuses them identically whether canonicalization runs
      // or not — they cannot pin the realpath line. This one
      // string-matches "$RWS"/* but canonicalizes out of it, so only
      // `realpath -m` can refuse it: with the line deleted, the raw path
      // passes the allowlist and reaches rm (executed mutant: exit 0,
      // canary in the call log).
      const dir = mkdtempSync(join(tmpdir(), 'serve-ab-wipe-escape-'));
      const outside = mkdtempSync(join(tmpdir(), 'serve-ab-wipe-outside-'));
      mkdirSync(join(dir, 'sub'));
      writeFileSync(join(outside, 'canary'), 'x');
      try {
        const calls = join(dir, 'rm-calls');
        writeFileSync(calls, '');
        writeFileSync(
          join(dir, 'rm'),
          `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\nexit 0\n`,
          { mode: 0o755 },
        );
        const res = spawnSync(
          'bash',
          ['-e', '-o', 'pipefail', '-c', wipe.run],
          {
            encoding: 'utf8',
            env: {
              ...process.env,
              PATH: `${dir}:${process.env.PATH}`,
              // Keep the '..' spelling raw — resolving it here would
              // canonicalize the fixture away before the script sees it.
              GITHUB_WORKSPACE: `${dir}/sub/../../${basename(outside)}`,
              RUNNER_WORKSPACE: dir,
            },
          },
        );
        expect(res.status).not.toBe(0);
        expect(readFileSync(calls, 'utf8')).toBe('');
      } finally {
        rmSync(dir, { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
      }
    },
  );

  // Fronts PATH with a failing realpath so the script must fail closed instead
  // of matching and wiping a raw, potentially misleading spelling.
  const stubRealpath = () => {
    const bin = mkdtempSync(join(tmpdir(), 'serve-ab-wipe-bin-'));
    writeFileSync(join(bin, 'realpath'), '#!/bin/sh\nexit 1\n');
    chmodSync(join(bin, 'realpath'), 0o755);
    return bin;
  };

  it('refuses to wipe when realpath is absent', () => {
    const parent = mkdtempSync(join(tmpdir(), 'serve-ab-wipe-rws-'));
    const ws = join(parent, 'repo');
    mkdirSync(ws);
    writeFileSync(join(ws, 'leftover'), 'x');
    const bin = stubRealpath();
    try {
      const res = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', wipe.run], {
        encoding: 'utf8',
        env: {
          ...process.env,
          GITHUB_WORKSPACE: ws,
          RUNNER_WORKSPACE: `${parent}/`,
          PATH: `${bin}:${process.env.PATH}`,
        },
      });
      expect(res.status).not.toBe(0);
      expect(readdirSync(ws)).toEqual(['leftover']);
    } finally {
      rmSync(parent, { recursive: true, force: true });
      rmSync(bin, { recursive: true, force: true });
    }
  });

  it('refuses a trailing-slash GITHUB_WORKSPACE when realpath is absent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'serve-ab-wipe-ws-'));
    const bin = stubRealpath();
    try {
      const calls = join(dir, 'rm-calls');
      writeFileSync(calls, '');
      writeFileSync(
        join(dir, 'rm'),
        `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\nexit 0\n`,
        { mode: 0o755 },
      );
      const res = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', wipe.run], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${dir}:${bin}:${process.env.PATH}`,
          GITHUB_WORKSPACE: '/home/',
          RUNNER_WORKSPACE: '/home',
        },
      });
      expect(res.status).not.toBe(0);
      expect(readFileSync(calls, 'utf8')).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(bin, { recursive: true, force: true });
    }
  });

  it('refuses an allowlist-escaping .. path when realpath is absent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'serve-ab-wipe-fallback-'));
    const outside = mkdtempSync(join(tmpdir(), 'serve-ab-wipe-outside-'));
    const bin = stubRealpath();
    mkdirSync(join(dir, 'sub'));
    try {
      const calls = join(dir, 'rm-calls');
      writeFileSync(calls, '');
      writeFileSync(
        join(dir, 'rm'),
        `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\nexit 0\n`,
        { mode: 0o755 },
      );
      const res = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', wipe.run], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${dir}:${bin}:${process.env.PATH}`,
          GITHUB_WORKSPACE: `${dir}/sub/../../${basename(outside)}`,
          RUNNER_WORKSPACE: dir,
        },
      });
      expect(res.status).not.toBe(0);
      expect(readFileSync(calls, 'utf8')).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
      rmSync(bin, { recursive: true, force: true });
    }
  });
});
