/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The A/B workflow's pre-checkout wipe, which until #9265 was the one copy of
// the pool-wipe idiom with NO path guard at all: `set -u` refused an UNSET
// workspace and nothing else, so an empty or mangled one — and every guarded
// root, spelled canonically — reached `find … -exec rm -rf {} +` unchallenged.
// #9277 back-ported the checkout-heal guard (fail-closed canonicalization,
// trailing-slash strip, `..` arms, RUNNER_WORKSPACE allowlist), and #9369
// added the heal layer for symlinked workspaces on top of it. This file pins
// the composed guard where it lives, because the three copies of the idiom
// are still copies: nothing but a test stops one of them drifting again.

import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
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
// it behind a bare `bash -c`.
const runWipe = (env, options = {}) =>
  execFileSync('bash', ['-e', '-o', 'pipefail', '-c', wipe.run], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    ...options,
  });

// `realpath -m` (the script's canonicalization line) is a GNU coreutils
// extension. Probe the host before asserting behavior that can only happen
// after canonicalization succeeds: the guard FAILS CLOSED when realpath is
// absent (#9277), so on a host without GNU realpath every exec test either
// asserts that refusal or is skipped by this probe.
const hasGnuRealpath =
  spawnSync('realpath', ['-m', '--', '/'], { stdio: 'ignore' }).status === 0;

// The fail-closed heal fixture needs a host whose kernel refuses the running
// user's unlink into a 0555 parent: root bypasses the mode bits, so probe
// the capability and skip the fixture there instead of asserting a refusal
// that cannot happen.
const hasRefusableUnlink = (() => {
  const probe = mkdtempSync(join(tmpdir(), 'serve-ab-wipe-perm-'));
  try {
    writeFileSync(join(probe, 'file'), 'x');
    chmodSync(probe, 0o555);
    try {
      rmSync(join(probe, 'file'));
      return false;
    } catch {
      return true;
    }
  } finally {
    chmodSync(probe, 0o755);
    rmSync(probe, { recursive: true, force: true });
  }
})();

describe('serve-ab pre-checkout workspace wipe', () => {
  it('runs the wipe before both checkouts', () => {
    // Both checkouts clone into the wiped workspace; a wipe ordered after
    // either one deletes what was just cloned, and whichever build runs
    // first runs on the previous run's leftovers — the exact cross-PR
    // bleed the step exists to prevent. The sister qwen-triage suite pins
    // the same property.
    const names = steps.map((stepItem) => stepItem.name);
    const wipeAt = names.indexOf(WIPE);
    expect(wipeAt).toBeGreaterThanOrEqual(0);
    expect(wipeAt).toBeLessThan(names.indexOf('Checkout PR head'));
    expect(wipeAt).toBeLessThan(names.indexOf('Checkout the merge-base'));
  });

  it('runs only on self-hosted runners, where workspace state persists', () => {
    expect(wipe).toBeTruthy();
    // Hosted runners are ephemeral; the wipe (and its guard) exist for the
    // reusable ECS pool only.
    expect(wipe.if).toBe("${{ runner.environment == 'self-hosted' }}");
  });

  it('carries every layer of the guard and the heal (#9220, #9265, #9277, #9369)', () => {
    // Before the port this step had NO guard: under a mangled env even
    // `/home` or an empty string reached `find … -exec rm -rf {} +`.
    // Named layers, not a shape check: this is a hand-copied idiom, and the
    // drift #9265 closed was invisible precisely because nothing compared
    // the copies against the reference implementation. The exec tests below
    // prove the behavior; these text pins catch a layer deleted whole.
    for (const layer of [
      'WS="${GITHUB_WORKSPACE:?}"',
      'RWS="${RUNNER_WORKSPACE:?}"',
      'realpath -m -- "$WS"',
      'realpath -m -- "$RWS"',
      'while [ "${WS%/}" != "$WS" ]',
      'while [ "${RWS%/}" != "$RWS" ]',
      '[ -L "$WS" ] || [ ! -d "$WS" ]',
      'rm -f -- "$WS" || { echo "::error::refusing to heal: cannot remove ${WS}"; exit 1; }',
      'mkdir -- "$WS"',
      '/|/home|/root|/usr*|/etc*|/var|""',
      '"$RWS"/*',
      'refusing to wipe suspicious workspace path',
      "refusing runner workspace path containing '..'",
      'runner workspace resolved to /',
      'outside the runner workspace',
    ]) {
      expect(wipe.run, `guard lost: ${layer}`).toContain(layer);
    }
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
        // Non-zero, not exactly 1: several mechanisms refuse here — the
        // `case` arms exit 1, an empty path never reaches them because
        // `${GITHUB_WORKSPACE:?}` aborts the shell first, and on a host
        // without GNU realpath the fail-closed canonicalization leg
        // refuses everything. Which one fires depends on the host.
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

  // The canonicalization layer needs its own pin: every bad path above
  // sits OUTSIDE the allowlist root, so the allowlist refuses them
  // identically whether canonicalization ran or not, and a bare-link
  // workspace no longer pins the line either — the heal layer removes a
  // workspace symlink BEFORE canonicalization (that is the wedge #9369
  // closes). The spelling that still pins it is a path whose INTERMEDIATE
  // component is a symlink: [ -L ]/[ ! -d ] test the FINAL component, so
  // no heal fires, but only canonicalization resolves the escape — with
  // the line deleted the raw path matches "$RWS"/* and find wipes through
  // the link, which the rm recorder catches.
  it.skipIf(!hasGnuRealpath)(
    'refuses an escape through an intermediate symlink via canonicalization',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'serve-ab-wipe-escape-'));
      const outside = mkdtempSync(join(tmpdir(), 'serve-ab-wipe-outside-'));
      mkdirSync(join(outside, 'sub'));
      writeFileSync(join(outside, 'sub', 'canary'), 'x');
      symlinkSync(outside, join(dir, 'link'));
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
              // A directory reached THROUGH a link inside the runner
              // workspace — no '..' component, and the final component is
              // a real directory, so only canonicalization can resolve the
              // escape.
              GITHUB_WORKSPACE: join(dir, 'link', 'sub'),
              RUNNER_WORKSPACE: dir,
            },
          },
        );
        expect(res.status).not.toBe(0);
        expect(readFileSync(calls, 'utf8')).toBe('');
        expect(existsSync(join(outside, 'sub', 'canary'))).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
      }
    },
  );

  // Fronts PATH with a failing realpath so the script must fail closed
  // instead of matching and wiping a raw, potentially misleading spelling.
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

  // The degenerate-root arm keeps a stripped-empty RUNNER_WORKSPACE from
  // turning the allowlist pattern into `/*` (which admits every absolute
  // path). The reference suite covers the review workflow; this copy needs
  // its own case — deleting the arm ships green otherwise.
  it('refuses a runner workspace that resolves to / without invoking rm', () => {
    const dir = mkdtempSync(join(tmpdir(), 'serve-ab-wipe-root-'));
    const ws = join(dir, 'repo');
    mkdirSync(ws);
    writeFileSync(join(ws, 'leftover'), 'x');
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
          PATH: `${dir}:${process.env.PATH}`,
          GITHUB_WORKSPACE: ws,
          RUNNER_WORKSPACE: '/',
        },
      });
      expect(res.status).not.toBe(0);
      expect(readFileSync(calls, 'utf8')).toBe('');
      expect(readdirSync(ws)).toEqual(['leftover']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The RWS realpath line has no refusal of its own to observe, so pin it
  // from the happy side: a RUNNER_WORKSPACE spelled with '..' that
  // canonicalizes back to the real parent must still be allowed to wipe.
  // Deleting the RWS realpath line leaves the raw spelling to the '..'
  // arm, which refuses — and this test fails on that mutant.
  it.skipIf(!hasGnuRealpath)(
    'canonicalizes a ..-spelled runner workspace instead of refusing it',
    () => {
      const parent = mkdtempSync(join(tmpdir(), 'serve-ab-wipe-rwsdot-'));
      const ws = join(parent, 'repo');
      mkdirSync(ws);
      writeFileSync(join(ws, 'leftover'), 'x');
      try {
        runWipe({
          GITHUB_WORKSPACE: ws,
          RUNNER_WORKSPACE: join(ws, '..'),
        });
        expect(readdirSync(ws)).toEqual([]);
      } finally {
        rmSync(parent, { recursive: true, force: true });
      }
    },
  );

  // --- The heal layer (#9369) ---
  // A leftover from the previous job can replace the workspace with a
  // symlink or a plain file. Canonicalization resolves THROUGH the link,
  // the allowlist then refuses the target, and that refusal removes
  // nothing — every later job on the runner dies at the wipe. The heal
  // deletes the corruption on the raw path (`rm -f` never follows it) and
  // recreates the directory. These exec tests are gated on GNU realpath:
  // without it the fail-closed canonicalization leg refuses before the
  // heal can run, so the behavior they pin is unreachable.

  // PATH-fronted recorder that also DELETES: the heal fixtures need the
  // link actually removed (`mkdir` must succeed afterwards). Every path it
  // can reach sits inside the fixture's temp dirs — unlike the
  // guarded-root fixtures, where a live delete detonates.
  const recordingRealRm = (dir) => {
    const calls = join(dir, 'rm-calls');
    writeFileSync(calls, '');
    writeFileSync(
      join(dir, 'rm'),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\nexec /bin/rm "$@"\n`,
      { mode: 0o755 },
    );
    return calls;
  };

  // dir fronts PATH so the recorder/heal stub shadows the real `rm`.
  const runHeal = (dir, env) =>
    spawnSync('bash', ['-e', '-o', 'pipefail', '-c', wipe.run], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, ...env },
    });

  it.skipIf(!hasGnuRealpath)(
    'refuses a workspace outside the runner workspace',
    () => {
      // /tmp, /opt and every root the denylist does not enumerate are
      // closed by the allowlist alone. Canonicalize the fixture roots at
      // creation (the lockFixture pattern from
      // qwen-pr-review-workflow.test.js): on a host whose tmpdir is a
      // symlink (macOS: /var/folders -> /private/var/...), mkdtempSync
      // returns the link spelling while realpathSync resolves it, and the
      // refusal message below must compare equal to the canonical one.
      const dir = realpathSync(
        mkdtempSync(join(tmpdir(), 'serve-ab-wipe-allow-')),
      );
      const outside = realpathSync(
        mkdtempSync(join(tmpdir(), 'serve-ab-wipe-outside-')),
      );
      try {
        const calls = join(dir, 'rm-calls');
        writeFileSync(calls, '');
        writeFileSync(
          join(dir, 'rm'),
          `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\nexit 0\n`,
          { mode: 0o755 },
        );
        writeFileSync(join(outside, 'canary'), 'x');
        const res = runHeal(dir, {
          GITHUB_WORKSPACE: outside,
          RUNNER_WORKSPACE: dir,
        });
        expect(res.status).not.toBe(0);
        expect(res.stdout + res.stderr).toContain(
          'outside the runner workspace',
        );
        expect(res.stdout + res.stderr).toContain(
          `(runner workspace: ${realpathSync(dir)})`,
        );
        expect(readFileSync(calls, 'utf8')).toBe('');
        expect(existsSync(join(outside, 'canary'))).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!hasGnuRealpath)(
    'heals a workspace replaced by a symlink instead of wedging on it',
    () => {
      const dir = realpathSync(
        mkdtempSync(join(tmpdir(), 'serve-ab-wipe-link-')),
      );
      const outside = realpathSync(
        mkdtempSync(join(tmpdir(), 'serve-ab-wipe-outside-')),
      );
      try {
        const calls = recordingRealRm(dir);
        writeFileSync(join(outside, 'canary'), 'x');
        const ws = join(dir, 'workspace');
        symlinkSync(outside, ws);
        const res = runHeal(dir, {
          GITHUB_WORKSPACE: ws,
          RUNNER_WORKSPACE: dir,
        });
        expect(res.status, res.stdout + res.stderr).toBe(0);
        // The only delete is the link itself — never anything at its target.
        expect(readFileSync(calls, 'utf8').trim()).toBe(`-f -- ${ws}`);
        expect(existsSync(join(outside, 'canary'))).toBe(true);
        expect(lstatSync(ws).isSymbolicLink()).toBe(false);
        expect(lstatSync(ws).isDirectory()).toBe(true);
        expect(readdirSync(ws)).toEqual([]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!hasGnuRealpath)(
    'heals a workspace replaced by a plain file, not just a symlink',
    () => {
      // The heal condition's other half — a non-symlink non-directory. A
      // heal that only tested [ -L ] would leave the file in place, pass
      // the allowlist, and report a successful wipe over the leftover.
      const dir = realpathSync(
        mkdtempSync(join(tmpdir(), 'serve-ab-wipe-healfile-')),
      );
      try {
        const calls = recordingRealRm(dir);
        const ws = join(dir, 'workspace');
        writeFileSync(ws, 'leftover');
        const res = runHeal(dir, {
          GITHUB_WORKSPACE: ws,
          RUNNER_WORKSPACE: dir,
        });
        expect(res.status, res.stdout + res.stderr).toBe(0);
        expect(readFileSync(calls, 'utf8').trim()).toBe(`-f -- ${ws}`);
        expect(lstatSync(ws).isDirectory()).toBe(true);
        expect(readdirSync(ws)).toEqual([]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!hasGnuRealpath)(
    'heals a symlinked workspace spelled with a trailing slash',
    () => {
      // [ -L "$WS/" ] and [ ! -d "$WS/" ] resolve THROUGH the link, so the
      // slashed spelling hides the corruption from the heal's predicate and
      // the wedge survives — the slash must be stripped before the test.
      const dir = realpathSync(
        mkdtempSync(join(tmpdir(), 'serve-ab-wipe-healslash-')),
      );
      const outside = realpathSync(
        mkdtempSync(join(tmpdir(), 'serve-ab-wipe-outside-')),
      );
      try {
        const calls = recordingRealRm(dir);
        writeFileSync(join(outside, 'canary'), 'x');
        const ws = join(dir, 'workspace');
        symlinkSync(outside, ws);
        const res = runHeal(dir, {
          GITHUB_WORKSPACE: `${ws}/`,
          RUNNER_WORKSPACE: dir,
        });
        expect(res.status, res.stdout + res.stderr).toBe(0);
        expect(readFileSync(calls, 'utf8').trim()).toBe(`-f -- ${ws}`);
        expect(existsSync(join(outside, 'canary'))).toBe(true);
        expect(lstatSync(ws).isSymbolicLink()).toBe(false);
        expect(lstatSync(ws).isDirectory()).toBe(true);
        expect(readdirSync(ws)).toEqual([]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!hasGnuRealpath || !hasRefusableUnlink)(
    'fails closed when the heal cannot remove the wedge',
    () => {
      // A prior job that owns the runner workspace can chmod it read-only,
      // making the heal's unlink fail. Under `bash -eo pipefail` errexit
      // does not fire on a failure inside an && list, so the old
      // `rm -f … && mkdir …` shape swallowed the EACCES, canonicalized
      // THROUGH the surviving link, and emptied the sibling workspace with
      // exit 0. This step has no success log of its own, so the refusal
      // error is the fail-closed marker.
      const dir = realpathSync(
        mkdtempSync(join(tmpdir(), 'serve-ab-wipe-healperm-')),
      );
      const sibling = join(dir, 'sibling');
      mkdirSync(sibling);
      writeFileSync(join(sibling, 'canary'), 'x');
      const ws = join(dir, 'workspace');
      symlinkSync(sibling, ws);
      try {
        const calls = recordingRealRm(dir);
        chmodSync(dir, 0o555);
        const res = runHeal(dir, {
          GITHUB_WORKSPACE: ws,
          RUNNER_WORKSPACE: dir,
        });
        expect(res.status).not.toBe(0);
        expect(res.stdout + res.stderr).toContain(
          'refusing to heal: cannot remove',
        );
        expect(readFileSync(calls, 'utf8').trim()).toBe(`-f -- ${ws}`);
        // The wedge survives and nothing at its target was touched.
        expect(lstatSync(ws).isSymbolicLink()).toBe(true);
        expect(readFileSync(join(sibling, 'canary'), 'utf8')).toBe('x');
      } finally {
        chmodSync(dir, 0o755);
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  // Not gated on GNU realpath: an empty RUNNER_WORKSPACE is refused by
  // `${RUNNER_WORKSPACE:?}` before any canonicalization on every host.
  it('refuses to heal before an empty runner workspace is validated', () => {
    // The heal matches a RAW path: an empty $RUNNER_WORKSPACE degenerates
    // the containment pattern to the match-all "/*", so the heal would
    // rm -f + mkdir an arbitrary workspace BEFORE ${RUNNER_WORKSPACE:?}
    // aborts the step. The allowlist root is prepared and validated first.
    const dir = mkdtempSync(join(tmpdir(), 'serve-ab-wipe-healempty-'));
    try {
      const calls = recordingRealRm(dir);
      const ws = join(dir, 'workspace');
      writeFileSync(ws, 'leftover');
      const res = runHeal(dir, { GITHUB_WORKSPACE: ws, RUNNER_WORKSPACE: '' });
      expect(res.status).not.toBe(0);
      expect(res.stderr).toContain('RUNNER_WORKSPACE');
      expect(readFileSync(calls, 'utf8')).toBe('');
      expect(lstatSync(ws).isFile()).toBe(true);
      expect(readFileSync(ws, 'utf8')).toBe('leftover');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!hasGnuRealpath)(
    'refuses to heal a .. spelling the raw containment match cannot judge',
    () => {
      // ".." components string-match the containment pattern while the
      // kernel resolves them OUTSIDE the matched root, where rm -f + mkdir
      // would act before canonicalization. The heal refuses the spelling.
      const dir = mkdtempSync(join(tmpdir(), 'serve-ab-wipe-healdotdot-'));
      const outside = mkdtempSync(join(tmpdir(), 'serve-ab-wipe-outside-'));
      try {
        const calls = recordingRealRm(dir);
        mkdirSync(join(dir, 'sub'));
        const victim = join(outside, 'victim');
        writeFileSync(victim, 'canary');
        const res = runHeal(dir, {
          // Raw '..' spelling on purpose.
          GITHUB_WORKSPACE: `${dir}/sub/../../${basename(outside)}/victim`,
          RUNNER_WORKSPACE: dir,
        });
        expect(res.status).not.toBe(0);
        expect(res.stdout + res.stderr).toContain('non-canonical');
        expect(readFileSync(calls, 'utf8')).toBe('');
        expect(lstatSync(victim).isFile()).toBe(true);
        expect(readFileSync(victim, 'utf8')).toBe('canary');
      } finally {
        rmSync(dir, { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!hasGnuRealpath)(
    'refuses a sibling directory sharing the runner workspace prefix',
    () => {
      // The allowlist pattern's strict-containment slash: without it,
      // "$RWS"* matches a sibling whose name merely starts with the runner
      // workspace and hands it to the wipe.
      const dir = realpathSync(
        mkdtempSync(join(tmpdir(), 'serve-ab-wipe-sib-')),
      );
      const sibling = `${dir}-sibling`;
      mkdirSync(sibling);
      try {
        const calls = join(dir, 'rm-calls');
        writeFileSync(calls, '');
        writeFileSync(
          join(dir, 'rm'),
          `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\nexit 0\n`,
          { mode: 0o755 },
        );
        writeFileSync(join(sibling, 'canary'), 'x');
        const res = runHeal(dir, {
          GITHUB_WORKSPACE: sibling,
          RUNNER_WORKSPACE: dir,
        });
        expect(res.status).not.toBe(0);
        expect(res.stdout + res.stderr).toContain(
          'outside the runner workspace',
        );
        expect(readFileSync(calls, 'utf8')).toBe('');
        expect(existsSync(join(sibling, 'canary'))).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
        rmSync(sibling, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!hasGnuRealpath)(
    'refuses to heal a sibling symlink sharing the runner workspace prefix',
    () => {
      // The heal arm's own strict-containment slash: the sibling fixture
      // above is a plain directory, so no heal fires there and only the
      // allowlist's slash is pinned. Drop the slash from the heal's
      // "$RWS"/* and this raw path matches — the heal then deletes the
      // link and mkdirs OUTSIDE the runner workspace before the allowlist
      // refuses the wipe, the exact "worse than a skipped wipe" case.
      const dir = realpathSync(
        mkdtempSync(join(tmpdir(), 'serve-ab-wipe-healsib-')),
      );
      const evil = `${dir}-evil`;
      mkdirSync(join(dir, 'sibling'));
      mkdirSync(evil);
      const ws = join(evil, 'ws');
      symlinkSync(join(dir, 'sibling'), ws);
      try {
        const calls = join(dir, 'rm-calls');
        writeFileSync(calls, '');
        writeFileSync(
          join(dir, 'rm'),
          `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\nexit 0\n`,
          { mode: 0o755 },
        );
        const res = runHeal(dir, {
          GITHUB_WORKSPACE: ws,
          RUNNER_WORKSPACE: dir,
        });
        expect(res.status).not.toBe(0);
        expect(res.stdout + res.stderr).toContain(
          'outside the runner workspace',
        );
        expect(readFileSync(calls, 'utf8')).toBe('');
        expect(lstatSync(ws).isSymbolicLink()).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
        rmSync(evil, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!hasGnuRealpath)(
    'refuses a symlinked workspace planted outside the runner workspace',
    () => {
      // The heal matches the RAW path: a symlink whose own location is
      // outside the runner workspace is refused before anything resolves
      // through it — even when its target lies inside and would pass the
      // allowlist.
      const dir = realpathSync(
        mkdtempSync(join(tmpdir(), 'serve-ab-wipe-linkout-')),
      );
      const outside = realpathSync(
        mkdtempSync(join(tmpdir(), 'serve-ab-wipe-outside-')),
      );
      try {
        const calls = join(dir, 'rm-calls');
        writeFileSync(calls, '');
        writeFileSync(
          join(dir, 'rm'),
          `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\nexit 0\n`,
          { mode: 0o755 },
        );
        const sibling = join(dir, 'sibling');
        mkdirSync(sibling);
        writeFileSync(join(sibling, 'canary'), 'x');
        const link = join(outside, 'workspace');
        symlinkSync(sibling, link);
        const res = runHeal(dir, {
          GITHUB_WORKSPACE: link,
          RUNNER_WORKSPACE: dir,
        });
        expect(res.status).not.toBe(0);
        expect(res.stdout + res.stderr).toContain(
          'outside the runner workspace',
        );
        expect(readFileSync(calls, 'utf8')).toBe('');
        expect(lstatSync(link).isSymbolicLink()).toBe(true);
        expect(existsSync(join(sibling, 'canary'))).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!hasGnuRealpath)(
    'refuses an allowlist-escaping .. path via canonicalization',
    () => {
      // Every bad path above sits outside the allowlist root as written, so
      // the allowlist refuses them whether canonicalization ran or not.
      // This one string-matches "$RWS"/* and canonicalizes out of it: the
      // '..' arm or canonicalization must refuse it, and a guard missing
      // BOTH lets the raw path reach rm.
      const dir = mkdtempSync(join(tmpdir(), 'serve-ab-wipe-escape2-'));
      const outside = mkdtempSync(join(tmpdir(), 'serve-ab-wipe-outside-'));
      try {
        const calls = join(dir, 'rm-calls');
        writeFileSync(calls, '');
        writeFileSync(
          join(dir, 'rm'),
          `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\nexit 0\n`,
          { mode: 0o755 },
        );
        mkdirSync(join(dir, 'sub'));
        writeFileSync(join(outside, 'canary'), 'x');
        const res = runHeal(dir, {
          // Raw '..' spelling on purpose.
          GITHUB_WORKSPACE: `${dir}/sub/../../${basename(outside)}`,
          RUNNER_WORKSPACE: dir,
        });
        expect(res.status).not.toBe(0);
        expect(readFileSync(calls, 'utf8')).toBe('');
        expect(existsSync(join(outside, 'canary'))).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!hasGnuRealpath)(
    'refuses when the runner workspace degenerates to / or is empty',
    () => {
      // "/" strips to empty and an empty allowlist root would degenerate
      // the pattern to the match-all "/*", which is worse than no
      // allowlist at all — so the guard refuses its own pathological
      // input. The empty case must also name the variable: a dropped `:?`
      // dies later, in the strip loop, which says nothing about which
      // layer failed.
      const dir = mkdtempSync(join(tmpdir(), 'serve-ab-wipe-rws2-'));
      try {
        const calls = join(dir, 'rm-calls');
        writeFileSync(calls, '');
        writeFileSync(
          join(dir, 'rm'),
          `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\nexit 0\n`,
          { mode: 0o755 },
        );
        const ws = join(dir, 'workspace');
        mkdirSync(ws);
        writeFileSync(join(ws, 'leftover'), 'x');

        const root = runHeal(dir, {
          GITHUB_WORKSPACE: ws,
          RUNNER_WORKSPACE: '/',
        });
        expect(root.status).not.toBe(0);
        expect(root.stdout + root.stderr).toContain(
          'runner workspace resolved to /',
        );

        writeFileSync(calls, '');
        const empty = runHeal(dir, {
          GITHUB_WORKSPACE: ws,
          RUNNER_WORKSPACE: '',
        });
        expect(empty.status).not.toBe(0);
        expect(empty.stderr).toContain('RUNNER_WORKSPACE');
        expect(readFileSync(calls, 'utf8')).toBe('');
        expect(readdirSync(ws)).toEqual(['leftover']);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!hasGnuRealpath)(
    'still empties the workspace when the runner workspace is non-canonical',
    () => {
      // The allowlist compares two strings, so canonicalizing the RWS side
      // is what keeps a legitimate workspace acceptable when the runner
      // hands over a non-canonical spelling. Without that line the pattern
      // becomes "$dir/."/* and refuses the real workspace — the wipe would
      // silently stop happening on exactly the pool it exists for.
      const dir = mkdtempSync(join(tmpdir(), 'serve-ab-wipe-rwsspell-'));
      try {
        const ws = join(dir, 'workspace');
        mkdirSync(ws);
        writeFileSync(join(ws, 'leftover'), 'x');
        runWipe({ GITHUB_WORKSPACE: ws, RUNNER_WORKSPACE: `${dir}/.` });
        expect(readdirSync(ws)).toEqual([]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!hasGnuRealpath)(
    'still empties a legitimate workspace, hidden entries included',
    () => {
      // The guard must not cost the step its job. Dotfiles are the
      // regression case the idiom exists for: a leftover .git or .npmrc
      // from the previous PR is exactly what would bleed into the next
      // build.
      const dir = mkdtempSync(join(tmpdir(), 'serve-ab-wipe-ok2-'));
      try {
        const ws = join(dir, 'workspace');
        mkdirSync(join(ws, 'head'), { recursive: true });
        mkdirSync(join(ws, '.git'), { recursive: true });
        writeFileSync(join(ws, '.git', 'HEAD'), 'x');
        writeFileSync(join(ws, '.npmrc'), 'script-shell=/tmp/evil\n');
        const res = runHeal(dir, {
          GITHUB_WORKSPACE: ws,
          RUNNER_WORKSPACE: dir,
        });
        expect(res.status, res.stdout + res.stderr).toBe(0);
        expect(existsSync(ws)).toBe(true);
        expect(readdirSync(ws)).toEqual([]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
