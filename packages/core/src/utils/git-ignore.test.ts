/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import { isGitIgnored } from './git-ignore.js';
import { expectWithinLatencyBudget } from '../test-utils/latency-budget.js';

// git-init honors GIT_DIR/GIT_WORK_TREE/GIT_OBJECT_DIRECTORY as
// repo-placement selectors (ambient GIT_WORK_TREE without GIT_DIR is a hard
// fatal; ambient GIT_DIR re-homes the fixture repository — mutating a
// foreign repo when it points at one). Every init the suite spawns scrubs
// the selectors, the foreign inits included: an ambient value would re-home
// a foreign fixture too, letting its arm pass for the wrong reason — or, on
// a host exporting GIT_WORK_TREE alone, fail every foreign-init arm red for
// environmental reasons (measured: 5 failed of 9).
function scrubbedInitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env['GIT_DIR'];
  delete env['GIT_WORK_TREE'];
  delete env['GIT_OBJECT_DIRECTORY'];
  delete env['GIT_INDEX_FILE'];
  delete env['GIT_COMMON_DIR'];
  return env;
}

describe('isGitIgnored', () => {
  let dir: string;
  let outside: string;
  let originalConfigNosystem: string | undefined;
  let originalConfigGlobal: string | undefined;
  let originalXdgConfigHome: string | undefined;
  let originalHome: string | undefined;

  beforeEach(() => {
    originalConfigNosystem = process.env['GIT_CONFIG_NOSYSTEM'];
    originalConfigGlobal = process.env['GIT_CONFIG_GLOBAL'];
    originalXdgConfigHome = process.env['XDG_CONFIG_HOME'];
    originalHome = process.env['HOME'];
    dir = join(
      tmpdir(),
      `git-ignore-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(dir, { recursive: true });
    // Process-level git-config hermeticity: the probe spawns git with the
    // ambient process.env, so a host global exclude (e.g. one ignoring
    // .qwen/) would leak into the verdicts. The config pins block the
    // gitconfig channel but NOT git's XDG default excludes file
    // ($XDG_CONFIG_HOME/git/ignore), which git consults without any
    // config — pin XDG_CONFIG_HOME away from the host's too. HOME as well:
    // the probe scrubs GIT_CONFIG_GLOBAL, so the empty-gitconfig pin never
    // reaches it, and git's default global config resolves under $HOME.
    writeFileSync(join(dir, 'empty-gitconfig'), '');
    process.env['GIT_CONFIG_NOSYSTEM'] = '1';
    process.env['GIT_CONFIG_GLOBAL'] = join(dir, 'empty-gitconfig');
    process.env['XDG_CONFIG_HOME'] = join(dir, 'xdg');
    process.env['HOME'] = dir;
    execFileSync('git', ['init', '-q'], { cwd: dir, env: scrubbedInitEnv() });
    // A genuinely repo-less location: a sibling temp dir the repo walk
    // cannot reach. (A subdirectory of the repo would let git walk up and
    // resolve the enclosing worktree, passing for the wrong reason.)
    outside = mkdtempSync(join(tmpdir(), 'git-ignore-plain-'));
  });

  afterEach(() => {
    if (originalConfigNosystem === undefined)
      delete process.env['GIT_CONFIG_NOSYSTEM'];
    else process.env['GIT_CONFIG_NOSYSTEM'] = originalConfigNosystem;
    if (originalConfigGlobal === undefined)
      delete process.env['GIT_CONFIG_GLOBAL'];
    else process.env['GIT_CONFIG_GLOBAL'] = originalConfigGlobal;
    if (originalXdgConfigHome === undefined)
      delete process.env['XDG_CONFIG_HOME'];
    else process.env['XDG_CONFIG_HOME'] = originalXdgConfigHome;
    if (originalHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = originalHome;
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it('answers git’s own verdict for a representative file path', () => {
    expect(isGitIgnored(dir, '.qwen/audits/x.md')).toBe(false);
    writeFileSync(join(dir, '.gitignore'), '.qwen/\n');
    expect(isGitIgnored(dir, '.qwen/audits/x.md')).toBe(true);
  });

  it('is fresh by default: a rule edit flips the next answer', () => {
    writeFileSync(join(dir, '.gitignore'), '.qwen/\n');
    expect(isGitIgnored(dir, '.qwen/audits/x.md')).toBe(true);
    writeFileSync(
      join(dir, '.gitignore'),
      '.qwen/*\n!.qwen/audits/\n!.qwen/audits/**\n',
    );
    expect(isGitIgnored(dir, '.qwen/audits/x.md')).toBe(false);
  });

  it('treats a non-worktree as not-ignored', () => {
    expect(isGitIgnored(outside, 'anything.md')).toBe(false);
  });

  // Every repository-selecting variable the probe scrubs needs its own
  // pinned arm: deleting any one scrub line ships green unless the fixture
  // proves the -C worktree's verdict still wins under it. Each arm places
  // the foreign state where THAT variable's resolution channel actually
  // reads it, in whichever expectation shape discriminates — a mis-placed
  // rule or a wrong shape passes with or without the scrub line (measured
  // for the gitdir-shaped GIT_INDEX_FILE and worktree-shaped GIT_DIR
  // fixtures: both mutants shipped 9/9 green).

  it('answers for the -C worktree even when GIT_WORK_TREE points elsewhere', () => {
    const foreign = mkdtempSync(join(tmpdir(), 'git-ignore-foreign-'));
    execFileSync('git', ['init', '-q'], {
      cwd: foreign,
      env: scrubbedInitEnv(),
    });
    writeFileSync(join(foreign, '.gitignore'), '.qwen/\n');
    const saved = process.env['GIT_WORK_TREE'];
    const savedGitDir = process.env['GIT_DIR'];
    // GIT_WORK_TREE needs a paired GIT_DIR to be legal; point both at the
    // foreign repo.
    process.env['GIT_WORK_TREE'] = foreign;
    process.env['GIT_DIR'] = join(foreign, '.git');
    try {
      // dir itself has no ignore rules: the foreign tree's .qwen/ rule
      // must not answer for it.
      expect(isGitIgnored(dir, '.qwen/audits/x.md')).toBe(false);
    } finally {
      if (saved === undefined) delete process.env['GIT_WORK_TREE'];
      else process.env['GIT_WORK_TREE'] = saved;
      if (savedGitDir === undefined) delete process.env['GIT_DIR'];
      else process.env['GIT_DIR'] = savedGitDir;
      rmSync(foreign, { recursive: true, force: true });
    }
  });

  it('answers for the -C worktree even when GIT_DIR points elsewhere', () => {
    // With GIT_WORK_TREE unset, check-ignore never consults the foreign
    // worktree's .gitignore — the rule must sit in the foreign gitdir's
    // info/exclude (the GIT_COMMON_DIR arm's shape) or the arm passes with
    // or without its scrub line.
    const foreign = mkdtempSync(join(tmpdir(), 'git-ignore-foreign-'));
    execFileSync('git', ['init', '-q'], {
      cwd: foreign,
      env: scrubbedInitEnv(),
    });
    mkdirSync(join(foreign, '.git', 'info'), { recursive: true });
    writeFileSync(join(foreign, '.git', 'info', 'exclude'), '.qwen/\n');
    const saved = process.env['GIT_DIR'];
    process.env['GIT_DIR'] = join(foreign, '.git');
    try {
      expect(isGitIgnored(dir, '.qwen/audits/x.md')).toBe(false);
    } finally {
      if (saved === undefined) delete process.env['GIT_DIR'];
      else process.env['GIT_DIR'] = saved;
      rmSync(foreign, { recursive: true, force: true });
    }
  });

  it('answers for the -C worktree even when GIT_INDEX_FILE points elsewhere', () => {
    // check-ignore answers "not ignored" for a path tracked in the index it
    // reads, so this arm inverts: the probe path is tracked in the FOREIGN
    // index and ignored by dir's own rules. While the probe scrubs
    // GIT_INDEX_FILE the -C repo's empty index answers and the path stays
    // ignored; deleting the scrub lets the foreign index report it as
    // tracked and flips the verdict. (A foreign gitdir — not an index file
    // — fataled check-ignore either way, so that shape could not pin.)
    const foreign = mkdtempSync(join(tmpdir(), 'git-ignore-foreign-'));
    execFileSync('git', ['init', '-q'], {
      cwd: foreign,
      env: scrubbedInitEnv(),
    });
    mkdirSync(join(foreign, '.qwen', 'audits'), { recursive: true });
    writeFileSync(join(foreign, '.qwen', 'audits', 'x.md'), 'tracked\n');
    execFileSync('git', ['-C', foreign, 'add', '.qwen/audits/x.md'], {
      env: scrubbedInitEnv(),
    });
    writeFileSync(join(dir, '.gitignore'), '.qwen/\n');
    const saved = process.env['GIT_INDEX_FILE'];
    process.env['GIT_INDEX_FILE'] = join(foreign, '.git', 'index');
    try {
      expect(isGitIgnored(dir, '.qwen/audits/x.md')).toBe(true);
    } finally {
      if (saved === undefined) delete process.env['GIT_INDEX_FILE'];
      else process.env['GIT_INDEX_FILE'] = saved;
      rmSync(foreign, { recursive: true, force: true });
    }
  });

  it('answers for the -C worktree even when GIT_OBJECT_DIRECTORY points elsewhere', () => {
    // check-ignore never consults the object store for RULES, but a
    // nonexistent object directory kills repository setup outright (fatal,
    // exit 128) — an ambient stale value flips an ignored path to
    // not-ignored through the catch unless the probe scrubs it. The ambient
    // value is a path that does not exist; dir's own rule keeps the
    // expected verdict true.
    writeFileSync(join(dir, '.gitignore'), '.qwen/\n');
    const saved = process.env['GIT_OBJECT_DIRECTORY'];
    process.env['GIT_OBJECT_DIRECTORY'] = join(dir, 'no-such-object-store');
    try {
      expect(isGitIgnored(dir, '.qwen/audits/x.md')).toBe(true);
    } finally {
      if (saved === undefined) delete process.env['GIT_OBJECT_DIRECTORY'];
      else process.env['GIT_OBJECT_DIRECTORY'] = saved;
    }
  });

  it('answers for the -C worktree even when GIT_COMMON_DIR points elsewhere', () => {
    // GIT_COMMON_DIR selects where check-ignore resolves info/exclude and
    // config, so the foreign rule must sit in the foreign COMMON DIR's
    // info/exclude (a worktree .gitignore would not reach through it).
    const foreign = mkdtempSync(join(tmpdir(), 'git-ignore-common-'));
    execFileSync('git', ['init', '-q'], {
      cwd: foreign,
      env: scrubbedInitEnv(),
    });
    mkdirSync(join(foreign, '.git', 'info'), { recursive: true });
    writeFileSync(join(foreign, '.git', 'info', 'exclude'), '.qwen/\n');
    const saved = process.env['GIT_COMMON_DIR'];
    process.env['GIT_COMMON_DIR'] = join(foreign, '.git');
    try {
      expect(isGitIgnored(dir, '.qwen/audits/x.md')).toBe(false);
    } finally {
      if (saved === undefined) delete process.env['GIT_COMMON_DIR'];
      else process.env['GIT_COMMON_DIR'] = saved;
      rmSync(foreign, { recursive: true, force: true });
    }
  });

  it('answers for the -C worktree even when GIT_CONFIG_COUNT injects config', () => {
    // COUNT activates the inline KEY_<n>/VALUE_<n> channel; aim it at a
    // foreign excludesFile. Without the COUNT scrub the injected rule
    // answers for the -C worktree (measured: the verdict flips to true).
    const excludes = join(outside, 'foreign-excludes');
    writeFileSync(excludes, '.qwen/\n');
    const savedCount = process.env['GIT_CONFIG_COUNT'];
    const savedKey = process.env['GIT_CONFIG_KEY_0'];
    const savedValue = process.env['GIT_CONFIG_VALUE_0'];
    process.env['GIT_CONFIG_COUNT'] = '1';
    process.env['GIT_CONFIG_KEY_0'] = 'core.excludesFile';
    process.env['GIT_CONFIG_VALUE_0'] = excludes;
    try {
      expect(isGitIgnored(dir, '.qwen/audits/x.md')).toBe(false);
    } finally {
      if (savedCount === undefined) delete process.env['GIT_CONFIG_COUNT'];
      else process.env['GIT_CONFIG_COUNT'] = savedCount;
      if (savedKey === undefined) delete process.env['GIT_CONFIG_KEY_0'];
      else process.env['GIT_CONFIG_KEY_0'] = savedKey;
      if (savedValue === undefined) delete process.env['GIT_CONFIG_VALUE_0'];
      else process.env['GIT_CONFIG_VALUE_0'] = savedValue;
    }
  });

  it('answers for the -C worktree even when GIT_CONFIG_PARAMETERS injects config', () => {
    // PARAMETERS is the sibling inline-config channel git itself uses to
    // propagate -c options to child processes; aim it at a foreign
    // excludesFile. Without the scrub the injected rule answers for the
    // -C worktree (measured: the verdict flips to true). Forward slashes
    // keep the fixture parseable on Windows, as in the redirect arm.
    const excludes = join(outside, 'foreign-excludes');
    writeFileSync(excludes, '.qwen/\n');
    const saved = process.env['GIT_CONFIG_PARAMETERS'];
    process.env['GIT_CONFIG_PARAMETERS'] = `'core.excludesfile'='${excludes
      .split('\\')
      .join('/')}'`;
    try {
      expect(isGitIgnored(dir, '.qwen/audits/x.md')).toBe(false);
    } finally {
      if (saved === undefined) delete process.env['GIT_CONFIG_PARAMETERS'];
      else process.env['GIT_CONFIG_PARAMETERS'] = saved;
    }
  });

  it('answers for the -C worktree even when the config files redirect elsewhere', () => {
    // GIT_CONFIG_GLOBAL and GIT_CONFIG_SYSTEM redirect the config files;
    // point both at a foreign gitconfig whose core.excludesFile carries the
    // rule. beforeEach's GIT_CONFIG_NOSYSTEM stays in place: the probe
    // closes the system tier itself, and unsetting the pin here would let
    // the host's real /etc/gitconfig answer for the fixture — a red suite
    // on any host whose system config matches the probe path.
    const excludes = join(outside, 'foreign-excludes');
    writeFileSync(excludes, '.qwen/\n');
    // Git config treats backslashes as escapes, so a platform-native
    // Windows path would leave the fixture unparseable there; git accepts
    // forward slashes on every platform.
    const foreignConfig = join(outside, 'foreign-gitconfig');
    writeFileSync(
      foreignConfig,
      `[core]\n\texcludesFile = ${excludes.split('\\').join('/')}\n`,
    );
    const savedGlobal = process.env['GIT_CONFIG_GLOBAL'];
    const savedSystem = process.env['GIT_CONFIG_SYSTEM'];
    process.env['GIT_CONFIG_GLOBAL'] = foreignConfig;
    process.env['GIT_CONFIG_SYSTEM'] = foreignConfig;
    try {
      expect(isGitIgnored(dir, '.qwen/audits/x.md')).toBe(false);
    } finally {
      if (savedGlobal === undefined) delete process.env['GIT_CONFIG_GLOBAL'];
      else process.env['GIT_CONFIG_GLOBAL'] = savedGlobal;
      if (savedSystem === undefined) delete process.env['GIT_CONFIG_SYSTEM'];
      else process.env['GIT_CONFIG_SYSTEM'] = savedSystem;
    }
  });

  // The pathspec-magic family is the same fatal-128 → catch →
  // false-not-ignored class as GIT_OBJECT_DIRECTORY: any one of them makes
  // check-ignore reject every pathspec outright (exit 128), so each member
  // of the family needs a pin — set the variable, dir's own rule keeps the
  // expected verdict true.
  it.each([
    'GIT_LITERAL_PATHSPECS',
    'GIT_GLOB_PATHSPECS',
    'GIT_NOGLOB_PATHSPECS',
    'GIT_ICASE_PATHSPECS',
  ])('answers for the -C worktree even when %s is set', (variable) => {
    writeFileSync(join(dir, '.gitignore'), '.qwen/\n');
    const saved = process.env[variable];
    process.env[variable] = '1';
    try {
      expect(isGitIgnored(dir, '.qwen/audits/x.md')).toBe(true);
    } finally {
      if (saved === undefined) delete process.env[variable];
      else process.env[variable] = saved;
    }
  });

  it('answers for a dash-leading path thanks to the -- separator', () => {
    // Without '--' a dash-leading path reaches check-ignore in option
    // position (unknown switch, exit 129) and the catch reads it as
    // not-ignored — a flipped verdict for exactly the paths the separator
    // exists for.
    writeFileSync(join(dir, '.gitignore'), '-weird.md\n');
    expect(isGitIgnored(dir, '-weird.md')).toBe(true);
  });

  // ':' is a reserved Win32 filename character, so the fixture directory
  // cannot be created on Windows.
  it.skipIf(process.platform === 'win32')(
    'probes a colon-leading path literally, not as pathspec magic',
    () => {
      mkdirSync(join(dir, ':weird', '.qwen'), { recursive: true });
      // Without the './' disambiguation git parses ':weird/...' as a
      // pathspec magic and answers the wrong pathname (ignored here while
      // the literal directory is not).
      expect(isGitIgnored(dir, ':weird/.qwen/x.md')).toBe(false);
      writeFileSync(join(dir, '.gitignore'), ':weird/.qwen/\n');
      expect(isGitIgnored(dir, ':weird/.qwen/x.md')).toBe(true);
    },
  );

  // The shim is a shebang script named `git` fronting PATH — a shape
  // Windows cannot execute, so the arm skips there (as the colon arm does
  // for its own platform reason).
  it.skipIf(process.platform === 'win32')(
    'kills a wedged probe at the caller’s deadline and reads it as not-ignored',
    () => {
      // This pins the caller-supplied timeoutMs wiring; the default
      // deadline has its own arm below. The blocking shim stands in for a
      // wedged check-ignore on a worktree the caller does not control.
      const shimDir = mkdtempSync(join(tmpdir(), 'git-ignore-shim-'));
      writeFileSync(join(shimDir, 'git'), '#!/bin/sh\nexec sleep 30\n', {
        mode: 0o755,
      });
      const savedPath = process.env['PATH'];
      process.env['PATH'] = `${shimDir}${delimiter}${savedPath ?? ''}`;
      try {
        // A 500 ms kill and a 5 s kill both yield false; only the elapsed
        // time distinguishes the caller deadline from the 5 s default.
        const start = Date.now();
        expect(isGitIgnored(dir, 'anything.md', 500)).toBe(false);
        // A lower bound too: without it the arm passes vacuously (~0 ms)
        // wherever the shim cannot run (a noexec tmpdir, a PATH walk that
        // skips it), so the wiring would ship green unpinned.
        expect(Date.now() - start).toBeGreaterThanOrEqual(400);
        expectWithinLatencyBudget(Date.now() - start, 2500);
      } finally {
        if (savedPath === undefined) delete process.env['PATH'];
        else process.env['PATH'] = savedPath;
        rmSync(shimDir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'kills a wedged probe at the default deadline',
    () => {
      // Same blocking shim, no explicit deadline: every no-arg caller
      // (e.g. team-memory-git-status.ts) rides GIT_TIMEOUT_MS, and no
      // other arm pins its value.
      const shimDir = mkdtempSync(join(tmpdir(), 'git-ignore-shim-'));
      writeFileSync(join(shimDir, 'git'), '#!/bin/sh\nexec sleep 30\n', {
        mode: 0o755,
      });
      const savedPath = process.env['PATH'];
      process.env['PATH'] = `${shimDir}${delimiter}${savedPath ?? ''}`;
      try {
        const start = Date.now();
        expect(isGitIgnored(dir, 'anything.md')).toBe(false);
        const elapsed = Date.now() - start;
        expect(elapsed).toBeGreaterThanOrEqual(4000);
        expectWithinLatencyBudget(elapsed, 8000);
      } finally {
        if (savedPath === undefined) delete process.env['PATH'];
        else process.env['PATH'] = savedPath;
        rmSync(shimDir, { recursive: true, force: true });
      }
    },
    15000,
  );
});
