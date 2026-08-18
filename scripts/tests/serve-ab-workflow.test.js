/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The A/B workflow's pre-checkout wipe, which until #9265 was the one copy of
// the pool-wipe idiom with NO path guard at all: `set -u` refused an UNSET
// workspace and nothing else, so an empty or mangled one — and every guarded
// root, spelled canonically — reached `find … -exec rm -rf {} +` unchallenged.
// This file pins the ported guard where it lives, because the three copies of
// the idiom are still copies: nothing but a test stops one of them drifting
// again.

import { spawnSync } from 'node:child_process';
import {
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

const workflow = parse(readFileSync('.github/workflows/serve-ab.yml', 'utf8'));
const WIPE = 'Wipe stale workspace before checkout';
const steps = workflow.jobs.ab.steps;
const wipeStep = steps.find((s) => s.name === WIPE);

describe('serve-ab workspace wipe guard', () => {
  // `realpath -m` is a GNU coreutils extension; a BSD userland exits 1 on it
  // and the script's `|| printf` fallback keeps the path raw, so the
  // canonicalization simply does not happen there. The pool is Linux-only, so
  // the script is unaffected — but the assertion that depends on the flag is
  // gated on a host probe rather than a platform name, so this suite is green
  // on a non-GNU host instead of red for a defect it cannot have.
  const hasGnuRealpath =
    spawnSync('realpath', ['-m', '--', '/'], { stdio: 'ignore' }).status === 0;

  // PATH-fronted recorder rather than the real `rm`: the guard has to be
  // exercised with the REAL dangerous paths, and a live delete there fires at
  // exactly the moment the test exists to catch.
  const recorder = (dir) => {
    const calls = join(dir, 'rm-calls');
    writeFileSync(calls, '');
    writeFileSync(
      join(dir, 'rm'),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\nexit 0\n`,
      { mode: 0o755 },
    );
    return calls;
  };

  // The symlink-heal fixtures need the link ACTUALLY removed (`mkdir` must
  // succeed afterwards), so their stub records and then delegates to the
  // real `rm`. Every path it can reach sits inside the fixture's temp dirs —
  // unlike the guarded-root fixtures, where a live delete detonates.
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

  // GitHub Actions runs `run:` blocks with `-eo pipefail`; that implicit
  // errexit is what turns a guard's `exit 1` into a failed step, so the exec
  // tests reproduce it instead of hiding it behind a bare `bash -c`.
  const runWipe = (dir, env) =>
    spawnSync('bash', ['-e', '-o', 'pipefail', '-c', wipeStep.run], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        // Never inherited: on a real runner the ambient RUNNER_WORKSPACE
        // points at that job's own workspace, so every fixture below would be
        // refused by the allowlist for the wrong reason — green on a laptop,
        // wrong in CI.
        ...env,
      },
    });

  it('runs only where a stale workspace can exist', () => {
    // Hosted runners are ephemeral; the wipe is for the reusable pool, and it
    // must stay ahead of both checkouts or it deletes the code under test.
    expect(wipeStep).toBeDefined();
    expect(wipeStep.if).toContain("runner.environment == 'self-hosted'");
    expect(steps.findIndex((s) => s.name === WIPE)).toBeLessThan(
      steps.findIndex((s) => s.name === 'Checkout PR head'),
    );
  });

  it('carries every layer of the ported guard', () => {
    // Named layers, not a shape check: this is a hand-copied idiom, and the
    // drift #9265 closes was invisible precisely because nothing compared the
    // copies against the reference implementation.
    for (const layer of [
      'WS="${GITHUB_WORKSPACE:?}"',
      '[ -L "$WS" ] || [ ! -d "$WS" ]',
      'rm -f -- "$WS" && mkdir -- "$WS"',
      'realpath -m -- "$WS"',
      'while [ "${WS%/}" != "$WS" ]',
      '/|/home|/root|/usr*|/etc*|/var|""',
      'RWS="${RUNNER_WORKSPACE:?}"',
      'realpath -m -- "$RWS"',
      'while [ "${RWS%/}" != "$RWS" ]',
      'runner workspace resolved to /',
      'outside the runner workspace',
    ]) {
      expect(wipeStep.run, `guard lost: ${layer}`).toContain(layer);
    }
  });

  it('refuses the guarded roots and their kernel-resolvable spellings', () => {
    const dir = mkdtempSync(join(tmpdir(), 'serve-ab-wipe-guard-'));
    try {
      const calls = recorder(dir);
      for (const bad of [
        '/',
        '/home',
        '/root',
        '/usr',
        '/etc',
        '/var',
        '',
        '/home/',
        '/home/.',
        '/home//',
        '//home',
        '//usr',
        '/root/',
        '/var/',
      ]) {
        writeFileSync(calls, '');
        const res = runWipe(dir, {
          GITHUB_WORKSPACE: bad,
          RUNNER_WORKSPACE: dir,
        });
        // Non-zero, not exactly 1: the case arms exit 1 for a named path,
        // while an empty one never reaches them because
        // `${GITHUB_WORKSPACE:?}` aborts the shell first.
        expect(res.status, `path ${bad || '<empty>'} was not refused`).not.toBe(
          0,
        );
        expect(
          readFileSync(calls, 'utf8'),
          `rm was invoked for ${bad || '<empty>'}`,
        ).toBe('');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a workspace outside the runner workspace', () => {
    // /tmp, /opt and every root the denylist does not enumerate are closed by
    // the allowlist alone.
    const dir = mkdtempSync(join(tmpdir(), 'serve-ab-wipe-allow-'));
    const outside = mkdtempSync(join(tmpdir(), 'serve-ab-wipe-outside-'));
    try {
      const calls = recorder(dir);
      writeFileSync(join(outside, 'canary'), 'x');
      const res = runWipe(dir, {
        GITHUB_WORKSPACE: outside,
        RUNNER_WORKSPACE: dir,
      });
      expect(res.status).not.toBe(0);
      expect(res.stdout + res.stderr).toContain('outside the runner workspace');
      expect(res.stdout + res.stderr).toContain(
        `(runner workspace: ${realpathSync(dir)})`,
      );
      expect(readFileSync(calls, 'utf8')).toBe('');
      expect(existsSync(join(outside, 'canary'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('heals a workspace replaced by a symlink instead of wedging on it', () => {
    // A leftover from the previous job can replace the workspace directory
    // with a symlink pointing outside the runner workspace. Canonicalization
    // resolves THROUGH the link, so the allowlist then refuses the target
    // and exits 1 without removing anything — the link survives and every
    // later job on the runner dies at this step. The heal deletes the link
    // on the raw path (`rm -f` never follows it) and recreates the directory.
    const dir = mkdtempSync(join(tmpdir(), 'serve-ab-wipe-link-'));
    const outside = mkdtempSync(join(tmpdir(), 'serve-ab-wipe-outside-'));
    try {
      const calls = recordingRealRm(dir);
      writeFileSync(join(outside, 'canary'), 'x');
      const ws = join(dir, 'workspace');
      symlinkSync(outside, ws);
      const res = runWipe(dir, {
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
  });

  it('heals a workspace replaced by a plain file, not just a symlink', () => {
    // The heal condition's other half — a non-symlink non-directory. A heal
    // that only tested [ -L ] would leave the file in place, pass the
    // allowlist, and report a successful wipe over the leftover.
    const dir = mkdtempSync(join(tmpdir(), 'serve-ab-wipe-healfile-'));
    try {
      const calls = recordingRealRm(dir);
      const ws = join(dir, 'workspace');
      writeFileSync(ws, 'leftover');
      const res = runWipe(dir, {
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
  });

  it('heals a symlinked workspace spelled with a trailing slash', () => {
    // [ -L "$WS/" ] and [ ! -d "$WS/" ] resolve THROUGH the link, so the
    // slashed spelling hides the corruption from the heal's predicate and
    // the wedge survives — the slash must be stripped before the test.
    const dir = mkdtempSync(join(tmpdir(), 'serve-ab-wipe-healslash-'));
    const outside = mkdtempSync(join(tmpdir(), 'serve-ab-wipe-outside-'));
    try {
      const calls = recordingRealRm(dir);
      writeFileSync(join(outside, 'canary'), 'x');
      const ws = join(dir, 'workspace');
      symlinkSync(outside, ws);
      const res = runWipe(dir, {
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
  });

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
      const res = runWipe(dir, {
        GITHUB_WORKSPACE: ws,
        RUNNER_WORKSPACE: '',
      });
      expect(res.status).not.toBe(0);
      expect(res.stderr).toContain('RUNNER_WORKSPACE');
      expect(readFileSync(calls, 'utf8')).toBe('');
      expect(lstatSync(ws).isFile()).toBe(true);
      expect(readFileSync(ws, 'utf8')).toBe('leftover');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses to heal a .. spelling the raw containment match cannot judge', () => {
    // ".." components string-match the containment pattern while the kernel
    // resolves them OUTSIDE the matched root, where rm -f + mkdir would act
    // before canonicalization. The heal refuses the spelling instead.
    const dir = mkdtempSync(join(tmpdir(), 'serve-ab-wipe-healdotdot-'));
    const outside = mkdtempSync(join(tmpdir(), 'serve-ab-wipe-outside-'));
    try {
      const calls = recordingRealRm(dir);
      mkdirSync(join(dir, 'sub'));
      const victim = join(outside, 'victim');
      writeFileSync(victim, 'canary');
      const res = runWipe(dir, {
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
  });

  it('refuses a sibling directory sharing the runner workspace prefix', () => {
    // The allowlist pattern's strict-containment slash: without it, "$RWS"*
    // matches a sibling whose name merely starts with the runner workspace
    // and hands it to the wipe.
    const dir = mkdtempSync(join(tmpdir(), 'serve-ab-wipe-sib-'));
    const sibling = `${dir}-sibling`;
    mkdirSync(sibling);
    try {
      const calls = recorder(dir);
      writeFileSync(join(sibling, 'canary'), 'x');
      const res = runWipe(dir, {
        GITHUB_WORKSPACE: sibling,
        RUNNER_WORKSPACE: dir,
      });
      expect(res.status).not.toBe(0);
      expect(res.stdout + res.stderr).toContain('outside the runner workspace');
      expect(readFileSync(calls, 'utf8')).toBe('');
      expect(existsSync(join(sibling, 'canary'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(sibling, { recursive: true, force: true });
    }
  });

  it('refuses a symlinked workspace planted outside the runner workspace', () => {
    // The heal matches the RAW path: a symlink whose own location is outside
    // the runner workspace is refused before anything resolves through it —
    // even when its target lies inside and would pass the allowlist.
    const dir = mkdtempSync(join(tmpdir(), 'serve-ab-wipe-linkout-'));
    const outside = mkdtempSync(join(tmpdir(), 'serve-ab-wipe-outside-'));
    try {
      const calls = recorder(dir);
      const sibling = join(dir, 'sibling');
      mkdirSync(sibling);
      writeFileSync(join(sibling, 'canary'), 'x');
      const link = join(outside, 'workspace');
      symlinkSync(sibling, link);
      const res = runWipe(dir, {
        GITHUB_WORKSPACE: link,
        RUNNER_WORKSPACE: dir,
      });
      expect(res.status).not.toBe(0);
      expect(res.stdout + res.stderr).toContain('outside the runner workspace');
      expect(readFileSync(calls, 'utf8')).toBe('');
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(existsSync(join(sibling, 'canary'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it.skipIf(!hasGnuRealpath)(
    'refuses an allowlist-escaping .. path via canonicalization',
    () => {
      // Every other bad path sits outside the allowlist root as written, so
      // none of them can pin the realpath line. This one string-matches
      // "$RWS"/* and canonicalizes out of it: delete the canonicalization and
      // the raw path passes the allowlist and reaches rm.
      const dir = mkdtempSync(join(tmpdir(), 'serve-ab-wipe-escape-'));
      const outside = mkdtempSync(join(tmpdir(), 'serve-ab-wipe-outside-'));
      try {
        const calls = recorder(dir);
        mkdirSync(join(dir, 'sub'));
        writeFileSync(join(outside, 'canary'), 'x');
        const res = runWipe(dir, {
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

  it('refuses when the runner workspace degenerates to / or is empty', () => {
    // An empty allowlist root degenerates the pattern to the match-all "/*",
    // which is worse than having no allowlist; the guard refuses its own
    // pathological input instead. Only the error text says WHICH layer
    // aborted, so the empty case pins the `:?` by name.
    const dir = mkdtempSync(join(tmpdir(), 'serve-ab-wipe-rws-'));
    try {
      const calls = recorder(dir);
      const ws = join(dir, 'workspace');
      mkdirSync(ws);
      writeFileSync(join(ws, 'leftover'), 'x');

      const root = runWipe(dir, {
        GITHUB_WORKSPACE: ws,
        RUNNER_WORKSPACE: '/',
      });
      expect(root.status).not.toBe(0);
      expect(root.stdout + root.stderr).toContain(
        'runner workspace resolved to /',
      );

      writeFileSync(calls, '');
      const empty = runWipe(dir, {
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
  });

  it('refuses a trailing-slash workspace when realpath is absent', () => {
    // The spellings above run with the REAL realpath, which strips the slash
    // before the loop executes — they pin the case arms, not the loop. With
    // realpath absent (the fallback this script keeps for a non-GNU host),
    // `/home/` misses every exact-match arm and the allowlist `"$RWS"/*`
    // matches it, since `*` matches empty: dropping the loop hands /home's
    // contents to rm.
    const dir = mkdtempSync(join(tmpdir(), 'serve-ab-wipe-strip-'));
    const bin = mkdtempSync(join(tmpdir(), 'serve-ab-wipe-bin-'));
    try {
      const calls = recorder(dir);
      writeFileSync(join(bin, 'realpath'), '#!/bin/sh\nexit 1\n', {
        mode: 0o755,
      });
      const res = spawnSync(
        'bash',
        ['-e', '-o', 'pipefail', '-c', wipeStep.run],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${dir}:${bin}:${process.env.PATH}`,
            GITHUB_WORKSPACE: '/home/',
            RUNNER_WORKSPACE: '/home',
          },
        },
      );
      expect(res.status).not.toBe(0);
      expect(readFileSync(calls, 'utf8')).toBe('');
    } finally {
      rmSync(bin, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!hasGnuRealpath)(
    'still empties the workspace when the runner workspace is non-canonical',
    () => {
      // The allowlist compares two strings, so canonicalizing the RWS side is
      // what keeps a legitimate workspace acceptable when the runner hands
      // over a non-canonical spelling. Without that line the pattern becomes
      // "$dir/."/* and refuses the real workspace — the wipe would silently
      // stop happening on exactly the pool it exists for.
      const dir = mkdtempSync(join(tmpdir(), 'serve-ab-wipe-rwsspell-'));
      try {
        const ws = join(dir, 'workspace');
        mkdirSync(ws);
        writeFileSync(join(ws, 'leftover'), 'x');
        const res = spawnSync(
          'bash',
          ['-e', '-o', 'pipefail', '-c', wipeStep.run],
          {
            encoding: 'utf8',
            env: {
              ...process.env,
              GITHUB_WORKSPACE: ws,
              RUNNER_WORKSPACE: `${dir}/.`,
            },
          },
        );
        expect(res.status, res.stdout + res.stderr).toBe(0);
        expect(readdirSync(ws)).toEqual([]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it('still empties a legitimate workspace, hidden entries included', () => {
    // The guard must not cost the step its job. Dotfiles are the regression
    // case the idiom exists for: a leftover .git or .npmrc from the previous
    // PR is exactly what would bleed into the next build.
    const dir = mkdtempSync(join(tmpdir(), 'serve-ab-wipe-ok-'));
    try {
      const ws = join(dir, 'workspace');
      mkdirSync(join(ws, 'head'), { recursive: true });
      mkdirSync(join(ws, '.git'), { recursive: true });
      writeFileSync(join(ws, '.git', 'HEAD'), 'x');
      writeFileSync(join(ws, '.npmrc'), 'script-shell=/tmp/evil\n');
      const res = spawnSync(
        'bash',
        ['-e', '-o', 'pipefail', '-c', wipeStep.run],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            GITHUB_WORKSPACE: ws,
            RUNNER_WORKSPACE: dir,
          },
        },
      );
      expect(res.status, res.stdout + res.stderr).toBe(0);
      expect(existsSync(ws)).toBe(true);
      expect(readdirSync(ws)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
