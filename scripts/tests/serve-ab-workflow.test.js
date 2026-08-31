/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const workflow = readFileSync('.github/workflows/serve-ab.yml', 'utf8');

const job = parse(workflow).jobs['ab'];
const steps = job.steps;
const WIPE = 'Wipe stale workspace except the shared .git before checkout';
const wipe = steps.find((s) => s.name === WIPE);

// Runs the real wipe script under the runner's shell flags: this job sets
// `defaults.run.shell: bash`, which GitHub Actions executes with
// `-eo pipefail`, so the exec tests must reproduce that instead of hiding
// it behind bare `bash -c`.
const runWipe = (env, options = {}) => {
  // GitHub Actions starts the step with its CWD in GITHUB_WORKSPACE, so
  // the harness does too — a symlinked root then opens the link's target
  // as the CWD, exactly the shape the kept-.git tail must contain. The
  // heal fixtures hand over a workspace that is a file or a dangling
  // symlink — no cwd to stand in — so pin the parent instead: a mkdtemp
  // dir, never a repo.
  let cwd = env.GITHUB_WORKSPACE;
  try {
    if (!statSync(cwd).isDirectory()) cwd = dirname(cwd);
  } catch {
    cwd = dirname(cwd);
  }
  return execFileSync('bash', ['-e', '-o', 'pipefail', '-c', wipe.run], {
    encoding: 'utf8',
    cwd,
    env: { ...process.env, ...env },
    ...options,
  });
};

// `realpath -m` (the script's canonicalization line) is a GNU coreutils
// extension. Probe the host before asserting GNU-specific path behavior.
const hasGnuRealpath =
  spawnSync('realpath', ['-m', '--', '/'], { stdio: 'ignore' }).status === 0;

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

  // The job drives BOTH checkouts end-to-end (npm ci, full monorepo build,
  // daemon drive, each); a contended shared runner exhausted 45 minutes near
  // the end of the second cycle. Pin the floor so that cancellation does not
  // recur.
  it('keeps a job timeout with headroom for two full build cycles', () => {
    expect(job['timeout-minutes']).toBeGreaterThanOrEqual(60);
  });

  it('carries the full checkout-heal guard (#9220, #9265)', () => {
    // Before the port this step had NO guard: under a mangled env even
    // `/home` or an empty string reached `find … -exec rm -rf {} +`.
    // Pin each ported layer textually, mirroring the reference guard in
    // qwen-code-pr-review.yml; the exec tests below prove the behavior.
    expect(wipe.run).toContain('GITHUB_WORKSPACE:?');
    expect(wipe.run).toContain('realpath -m');
    expect(wipe.run).toContain('realpath -m -- "$RWS"');
    expect(wipe.run).toContain('refusing to wipe suspicious workspace path');
    expect(wipe.run).toContain('RUNNER_WORKSPACE:?');
    expect(wipe.run).toContain('"$RWS"/*');
    // RWS-side layers: the '..' arm and the degenerate-root refusal that
    // keeps a stripped-empty runner workspace from degenerating the
    // allowlist pattern to `/*`.
    expect(wipe.run).toContain(
      "refusing runner workspace path containing '..'",
    );
    expect(wipe.run).toContain('runner workspace resolved to /');
    // Exit contract: the guard and the destructive lines stay bare on
    // purpose — under the job's `-eo pipefail` a wipe that cannot clear the
    // workspace fails the job here instead of building both checkouts on
    // top of the leftovers. `|| true` may appear only on the kept-.git
    // defang scrub — the config.worktree defang pair and the allowlist
    // sweep — mirroring qwen-triage.yml's config-sanitize.
    const loosened = wipe.run
      .split('\n')
      .filter((line) => line.includes('|| true'));
    expect(loosened).toHaveLength(3);
    expect(loosened[0]).toContain('--git-path config.worktree');
    expect(loosened[1]).toContain('--unset-all extensions.worktreeConfig');
    expect(loosened[2]).toContain('config --local --name-only --list');
  });

  it('carries the symlink heal, ordered and bounded (#9480)', () => {
    // The heal has to sit BEFORE the canonicalization: afterwards the path
    // has already resolved to the link's target, the allowlist refuses it,
    // and that refusal removes nothing — the wedge. Order is the property,
    // so it is asserted as one, not as the presence of two strings.
    const healAt = wipe.run.indexOf('[ -L "$WS" ] || [ ! -d "$WS" ]');
    const canonAt = wipe.run.indexOf('realpath -m -- "$WS"');
    const rwsAt = wipe.run.indexOf('RWS="${RUNNER_WORKSPACE:?}"');
    expect(healAt).toBeGreaterThan(-1);
    expect(healAt).toBeLessThan(canonAt);
    // …and AFTER the allowlist root is prepared, since that root is what
    // bounds the heal. A raw, empty $RUNNER_WORKSPACE would degenerate the
    // containment pattern to the match-all `/*`.
    expect(rwsAt).toBeLessThan(healAt);
    // The raw strip has to precede the predicates: `[ -L "$WS/" ]` and
    // `[ ! -d "$WS/" ]` both resolve THROUGH the link and report its target.
    expect(wipe.run.indexOf('while [ "${WS%/}" != "$WS" ]')).toBeLessThan(
      healAt,
    );
    // Containment is judged on the canonical PARENT, never on $WS itself —
    // resolving $WS would follow the very link being removed, and a raw
    // match cannot see intermediate symlink components.
    expect(wipe.run).toContain(
      'HEAL_PARENT="$(realpath -m -- "$(dirname -- "$WS")" 2>/dev/null)"',
    );
    expect(wipe.run).toContain('"$RWS"|"$RWS"/*)');
    expect(wipe.run).toContain('refusing to heal workspace outside');
    // Both legs fail closed: under `-e` a failure that is not the last
    // command of an && list is swallowed, and a swallowed one here leaves
    // the wipe running against a corrupt path.
    expect(wipe.run).toContain('rm -f -- "$WS" || {');
    expect(wipe.run).toContain('mkdir -- "$WS" || {');
    // The incident leaves no other trace.
    expect(wipe.run).toContain('::warning::healing workspace');
  });

  it.skipIf(!hasGnuRealpath)(
    'wipes a legitimate workspace but keeps and defangs the shared .git',
    () => {
      const parent = mkdtempSync(join(tmpdir(), 'serve-ab-wipe-ok-'));
      const ws = join(parent, 'repo');
      // Leftovers shaped like the real ones: the two checkout subtrees plus
      // a stale build artifact.
      mkdirSync(join(ws, 'head'), { recursive: true });
      mkdirSync(join(ws, 'base'), { recursive: true });
      writeFileSync(join(ws, 'head', 'package.json'), '{}');
      writeFileSync(join(ws, 'bundle.tgz'), 'x');
      // A shared root .git shaped like the real one: objects are the reason
      // it is kept; hooks, info/attributes, and non-allowlisted local
      // config are the exec vectors that must not survive into the next
      // job's checkout.
      execFileSync('git', ['init', '--quiet', ws]);
      mkdirSync(join(ws, '.git', 'objects', 'pack'), { recursive: true });
      writeFileSync(join(ws, '.git', 'objects', 'pack', 'sentinel'), 'x');
      writeFileSync(
        join(ws, '.git', 'hooks', 'post-checkout'),
        '#!/bin/sh\necho pwned\n',
      );
      writeFileSync(join(ws, '.git', 'info', 'attributes'), '* filter=x\n');
      execFileSync('git', ['config', '--local', 'alias.pwned', '!echo pwned'], {
        cwd: ws,
      });
      execFileSync('git', ['config', '--local', 'safe.directory', ws], {
        cwd: ws,
      });
      try {
        runWipe({ GITHUB_WORKSPACE: ws, RUNNER_WORKSPACE: parent });
        expect(readdirSync(ws)).toEqual(['.git']);
        expect(
          readFileSync(join(ws, '.git', 'objects', 'pack', 'sentinel'), 'utf8'),
        ).toBe('x');
        expect(existsSync(join(ws, '.git', 'hooks'))).toBe(false);
        expect(existsSync(join(ws, '.git', 'info', 'attributes'))).toBe(false);
        expect(() =>
          execFileSync('git', ['config', '--local', 'alias.pwned'], {
            cwd: ws,
            stdio: 'pipe',
          }),
        ).toThrow();
        expect(
          execFileSync('git', ['config', '--local', 'safe.directory'], {
            cwd: ws,
            encoding: 'utf8',
          }).trim(),
        ).toBe(ws);
        // The directory itself survives: the checkouts clone into it next.
        expect(wipe.run).toContain('-mindepth 1 -maxdepth 1');
      } finally {
        rmSync(parent, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!hasGnuRealpath)(
    'defangs the worktreeConfig split-config bypass',
    () => {
      // extensions.worktreeConfig activates .git/config.worktree, a second
      // local file that `git config --local` neither lists nor unsets — a
      // planted exec vector there survives the allowlist sweep and fires on
      // the next job's checkout. The defang deletes the file and drops the
      // extension, mirroring qwen-triage.yml's hardened config-sanitize.
      const parent = mkdtempSync(join(tmpdir(), 'serve-ab-wipe-wtcfg-'));
      const ws = join(parent, 'repo');
      execFileSync('git', ['init', '--quiet', ws]);
      execFileSync(
        'git',
        ['config', '--local', 'extensions.worktreeConfig', 'true'],
        { cwd: ws },
      );
      execFileSync(
        'git',
        ['config', '--worktree', 'core.hooksPath', join(parent, 'evil-hooks')],
        { cwd: ws },
      );
      try {
        runWipe({ GITHUB_WORKSPACE: ws, RUNNER_WORKSPACE: parent });
        expect(existsSync(join(ws, '.git', 'config.worktree'))).toBe(false);
        expect(() =>
          execFileSync(
            'git',
            ['config', '--local', 'extensions.worktreeConfig'],
            { cwd: ws, stdio: 'pipe' },
          ),
        ).toThrow();
        // Full-scope resolution: the planted exec vector no longer resolves.
        expect(
          spawnSync('git', ['-C', ws, 'config', '--get', 'core.hooksPath'], {
            encoding: 'utf8',
          }).status,
        ).not.toBe(0);
      } finally {
        rmSync(parent, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!hasGnuRealpath)(
    'never scrubs a repo outside a healed workspace',
    () => {
      // The heal unlinks the workspace symlink and recreates it as an empty
      // real dir, but the step's CWD was opened through the link and still
      // IS the target repo. The kept-.git tail must stay anchored to
      // $WS/.git: discovering the repo from the CWD here unsets the
      // target's local config and deletes its config.worktree — writes
      // outside the workspace. The target carries the full split-config
      // shape so every anchored line has its own witness.
      const parent = mkdtempSync(join(tmpdir(), 'serve-ab-heal-scrub-'));
      const target = mkdtempSync(join(tmpdir(), 'serve-ab-heal-target-'));
      execFileSync('git', ['init', '--quiet', target]);
      execFileSync(
        'git',
        ['config', '--local', 'extensions.worktreeConfig', 'true'],
        { cwd: target },
      );
      execFileSync(
        'git',
        ['config', '--worktree', 'core.hooksPath', join(target, 'evil')],
        { cwd: target },
      );
      execFileSync('git', ['config', '--local', 'alias.pwned', '!echo pwned'], {
        cwd: target,
      });
      const ws = join(parent, 'repo');
      symlinkSync(target, ws);
      try {
        runWipe({ GITHUB_WORKSPACE: ws, RUNNER_WORKSPACE: parent });
        // The workspace heals to an empty real dir...
        expect(lstatSync(ws).isSymbolicLink()).toBe(false);
        expect(lstatSync(ws).isDirectory()).toBe(true);
        expect(readdirSync(ws)).toEqual([]);
        // ...and the link target's repo is untouched: the split file, the
        // extension, and the hostile local key all survive.
        expect(existsSync(join(target, '.git', 'config.worktree'))).toBe(true);
        expect(
          execFileSync(
            'git',
            ['config', '--local', 'extensions.worktreeConfig'],
            { cwd: target, encoding: 'utf8' },
          ).trim(),
        ).toBe('true');
        expect(
          execFileSync('git', ['config', '--local', 'alias.pwned'], {
            cwd: target,
            encoding: 'utf8',
          }).trim(),
        ).toBe('!echo pwned');
      } finally {
        rmSync(parent, { recursive: true, force: true });
        rmSync(target, { recursive: true, force: true });
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
    'refuses an allowlist-escaping path reached through an intermediate symlink',
    () => {
      // Pins the canonicalization line. The bad paths above all sit outside
      // the recorder dir, so the allowlist refuses them identically whether
      // canonicalization runs or not, and a raw '..' spelling is refused by
      // the '..' arm first — neither can pin it. The vector that can is a
      // path whose INTERMEDIATE component is a link out of the runner
      // workspace: it matches "$RWS"/* as a string and names a directory
      // outside it.
      //
      // It is deliberately a directory at the far end, not the link itself:
      // a workspace that IS a link is now healed rather than refused
      // (#9480), and this test exists for the refusal, not the heal.
      // Executed mutant (canonicalization line deleted): the raw path
      // passes the allowlist and find, resolving the link through the
      // kernel, hands the outside directory's entries to the rm recorder.
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
              GITHUB_WORKSPACE: join(dir, 'link', 'sub'),
              RUNNER_WORKSPACE: dir,
            },
          },
        );
        expect(res.status).not.toBe(0);
        expect(res.stdout + res.stderr).toContain(
          'outside the runner workspace',
        );
        expect(readFileSync(calls, 'utf8')).toBe('');
        expect(readdirSync(join(outside, 'sub'))).toEqual(['canary']);
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

  // The wedge this heal exists for, and the hole the first attempt at it
  // shipped. Both are exec fixtures: the guard runs for real, and where a
  // regression would delete something, `rm` is a PATH-fronted recorder so
  // the assertion is on the decision and nothing on the machine can be lost.
  const rmRecorder = (dir) => {
    const calls = join(dir, 'rm-calls');
    writeFileSync(calls, '');
    writeFileSync(
      join(dir, 'rm'),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\nexit 0\n`,
      { mode: 0o755 },
    );
    return calls;
  };

  it.skipIf(!hasGnuRealpath)(
    'heals a workspace a previous job replaced with a symlink',
    () => {
      // Without the heal this is a permanent wedge: canonicalization
      // resolves the link to its target, the allowlist refuses, the step
      // exits 1 having removed nothing, and every later job on the runner
      // dies at the same line. The unlink must take the LINK and leave the
      // target alone.
      const parent = mkdtempSync(join(tmpdir(), 'serve-ab-heal-'));
      const outside = mkdtempSync(join(tmpdir(), 'serve-ab-heal-outside-'));
      const ws = join(parent, 'repo');
      writeFileSync(join(outside, 'canary'), 'x');
      symlinkSync(outside, ws);
      try {
        const out = runWipe({ GITHUB_WORKSPACE: ws, RUNNER_WORKSPACE: parent });
        expect(out).toContain('healing workspace');
        expect(out).toContain(outside);
        expect(lstatSync(ws).isSymbolicLink()).toBe(false);
        expect(lstatSync(ws).isDirectory()).toBe(true);
        expect(readdirSync(ws)).toEqual([]);
        // The link was removed, not followed: the target keeps its contents.
        expect(readdirSync(outside)).toEqual(['canary']);
      } finally {
        rmSync(parent, { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!hasGnuRealpath)(
    'refuses to heal through an intermediate symlink, before touching anything',
    () => {
      // The defect the first attempt at this layer kept through three
      // rounds: it matched the RAW path, and a raw `"$RWS"/*` accepts
      // `$RWS/link/sub` as a string while the kernel resolves it to a file
      // outside the runner workspace — so the unlink and the mkdir landed
      // OUTSIDE, and only then did canonicalization and the allowlist
      // refuse the wipe.
      //
      // What this fixture pins is the containment arm: deleting it lets the
      // heal act here. It does NOT discriminate parent-from-self — resolving
      // $WS itself also lands outside and also refuses. The fixture that
      // separates the two is the legitimate heal above, where judging $WS
      // resolves through the link being removed and refuses a repair that
      // must succeed.
      const parent = mkdtempSync(join(tmpdir(), 'serve-ab-heal-inter-'));
      const outside = mkdtempSync(join(tmpdir(), 'serve-ab-heal-outside-'));
      writeFileSync(join(outside, 'sub'), 'canary');
      symlinkSync(outside, join(parent, 'link'));
      try {
        const calls = rmRecorder(parent);
        const res = spawnSync(
          'bash',
          ['-e', '-o', 'pipefail', '-c', wipe.run],
          {
            encoding: 'utf8',
            env: {
              ...process.env,
              PATH: `${parent}:${process.env.PATH}`,
              GITHUB_WORKSPACE: join(parent, 'link', 'sub'),
              RUNNER_WORKSPACE: parent,
            },
          },
        );
        expect(res.status).not.toBe(0);
        expect(res.stdout + res.stderr).toContain(
          'refusing to heal workspace outside the runner workspace',
        );
        // Nothing was deleted, and the file at the resolved target is still
        // a file — the mutation the old shape performed before refusing.
        expect(readFileSync(calls, 'utf8')).toBe('');
        expect(lstatSync(join(outside, 'sub')).isFile()).toBe(true);
        expect(readFileSync(join(outside, 'sub'), 'utf8')).toBe('canary');
      } finally {
        rmSync(parent, { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!hasGnuRealpath)(
    'heals a workspace that is not a directory',
    () => {
      // The other half of the predicate: a leftover regular file where the
      // workspace should be wedges the step exactly the same way, and it is
      // the half the first attempt left untested.
      const parent = mkdtempSync(join(tmpdir(), 'serve-ab-heal-file-'));
      const ws = join(parent, 'repo');
      writeFileSync(ws, 'not a directory');
      try {
        const out = runWipe({ GITHUB_WORKSPACE: ws, RUNNER_WORKSPACE: parent });
        expect(out).toContain('it was not a directory');
        expect(lstatSync(ws).isDirectory()).toBe(true);
      } finally {
        rmSync(parent, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!hasGnuRealpath)(
    'sees the corruption through a trailing-slash spelling',
    () => {
      // `[ -L "$WS/" ]` is false and `[ ! -d "$WS/" ]` resolves through the
      // link, so without the raw strip ahead of the predicates the heal
      // never fires and the wedge survives one keystroke.
      const parent = mkdtempSync(join(tmpdir(), 'serve-ab-heal-slash-'));
      const outside = mkdtempSync(join(tmpdir(), 'serve-ab-heal-outside-'));
      const ws = join(parent, 'repo');
      writeFileSync(join(outside, 'canary'), 'x');
      symlinkSync(outside, ws);
      try {
        runWipe({ GITHUB_WORKSPACE: `${ws}/`, RUNNER_WORKSPACE: parent });
        expect(lstatSync(ws).isSymbolicLink()).toBe(false);
        expect(readdirSync(outside)).toEqual(['canary']);
      } finally {
        rmSync(parent, { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!hasGnuRealpath)(
    'leaves an ordinary workspace untouched by the heal',
    () => {
      // The heal must cost nothing on the path every real run takes.
      const parent = mkdtempSync(join(tmpdir(), 'serve-ab-heal-noop-'));
      const ws = join(parent, 'repo');
      mkdirSync(ws);
      writeFileSync(join(ws, 'leftover'), 'x');
      try {
        const out = runWipe({ GITHUB_WORKSPACE: ws, RUNNER_WORKSPACE: parent });
        expect(out).not.toContain('healing workspace');
        expect(readdirSync(ws)).toEqual([]);
      } finally {
        rmSync(parent, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!hasGnuRealpath || process.getuid?.() === 0)(
    'fails closed when the corrupt workspace cannot be unlinked',
    () => {
      // A swallowed `rm -f` failure would let the mkdir and the wipe run on
      // a path that is still a symlink. Root bypasses the mode bits, so the
      // fixture cannot produce the refusal there.
      const parent = mkdtempSync(join(tmpdir(), 'serve-ab-heal-perm-'));
      const outside = mkdtempSync(join(tmpdir(), 'serve-ab-heal-outside-'));
      const ws = join(parent, 'repo');
      writeFileSync(join(outside, 'canary'), 'x');
      symlinkSync(outside, ws);
      chmodSync(parent, 0o555);
      try {
        const res = spawnSync(
          'bash',
          ['-e', '-o', 'pipefail', '-c', wipe.run],
          {
            encoding: 'utf8',
            env: {
              ...process.env,
              GITHUB_WORKSPACE: ws,
              RUNNER_WORKSPACE: parent,
            },
          },
        );
        expect(res.status).not.toBe(0);
        expect(res.stdout + res.stderr).toContain('could not remove');
        expect(lstatSync(ws).isSymbolicLink()).toBe(true);
        expect(readdirSync(outside)).toEqual(['canary']);
      } finally {
        chmodSync(parent, 0o755);
        rmSync(parent, { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!hasGnuRealpath)(
    'keeps a forged workflow command in the symlink target out of the log',
    () => {
      // The target is bytes a previous job chose, and the runner parses `::`
      // at the start of ANY stdout line as a workflow command — so a target
      // of $'…\n::error::forged' would forge an annotation from a step that
      // is reporting corruption. The annotation carries no untrusted bytes
      // and the target is printed on a prefixed line with its newlines gone.
      const parent = mkdtempSync(join(tmpdir(), 'serve-ab-heal-inject-'));
      const outside = mkdtempSync(join(tmpdir(), 'serve-ab-heal-outside-'));
      const ws = join(parent, 'repo');
      symlinkSync(`${outside}\n::error::forged-annotation`, ws);
      try {
        const out = runWipe({ GITHUB_WORKSPACE: ws, RUNNER_WORKSPACE: parent });
        expect(out).toContain('healing workspace');
        // The target is still reported — just never as a command.
        expect(out).toContain('pointed at');
        expect(out).toContain(basename(outside));
        for (const line of out.split('\n')) {
          expect(line.startsWith('::error::')).toBe(false);
        }
      } finally {
        rmSync(parent, { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!hasGnuRealpath)(
    'fails closed when the healed workspace cannot be recreated',
    () => {
      // The mkdir leg's own refusal, reachable without a permission trick:
      // `rm -f` returns 0 for a path whose parent is not a directory (it
      // reads as "already absent"), and the mkdir that follows cannot
      // succeed. Swallowed, the wipe would then run against a path that
      // does not exist.
      const parent = mkdtempSync(join(tmpdir(), 'serve-ab-heal-mkdir-'));
      writeFileSync(join(parent, 'file'), 'not a directory');
      try {
        const res = spawnSync(
          'bash',
          ['-e', '-o', 'pipefail', '-c', wipe.run],
          {
            encoding: 'utf8',
            env: {
              ...process.env,
              GITHUB_WORKSPACE: join(parent, 'file', 'sub'),
              RUNNER_WORKSPACE: parent,
            },
          },
        );
        expect(res.status).not.toBe(0);
        expect(res.stdout + res.stderr).toContain('could not recreate');
      } finally {
        rmSync(parent, { recursive: true, force: true });
      }
    },
  );
});
