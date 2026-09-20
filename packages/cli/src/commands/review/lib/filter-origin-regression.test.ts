/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, normalize } from 'node:path';
import { shellQuotePath } from './shell-quote.js';
import { isolateHostGitConfig } from './test-utils.js';
import {
  checkoutFilterCommands,
  filterCommandsIn,
  sanitizedGitEnv,
} from './worktree.js';

const TEAM = 'filter.team.clean';
const LFS = 'filter.lfs.clean';
const refusedTeam = {
  filters: [TEAM],
  exempt: [],
  reachedExempt: [],
  attribution: [],
  unread: [],
  dangling: [],
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: sanitizedGitEnv(),
  }).trim();
const discover = (cwd: string, flag: string) =>
  normalize(git(cwd, 'rev-parse', '--path-format=absolute', flag));
const init = (repo: string) => {
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'test');
};

describe('filter origin regressions (real Git)', () => {
  let dir: string;
  let isolation: ReturnType<typeof isolateHostGitConfig>;
  beforeEach(() => {
    isolation = isolateHostGitConfig();
    dir = realpathSync(mkdtempSync(join(tmpdir(), "qwen-filter-origin ' ")));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    isolation.dispose();
  });

  const trackedInclude = () => {
    const repo = join(dir, 'real', 'repo');
    const linked = join(dir, 'linked');
    const payload = join(repo, 'team-filter.cfg');
    const globalConfig = join(isolation.home, '.gitconfig');
    init(repo);
    git(repo, 'config', '--file', payload, TEAM, 'cat');
    git(repo, 'add', 'team-filter.cfg');
    git(repo, 'commit', '-qm', 'tracked filter');
    git(repo, 'worktree', 'add', '--detach', '-q', linked, 'HEAD');
    git(repo, 'config', '--global', 'include.path', payload);
    git(repo, 'config', 'include.path', globalConfig);
    expect(
      git(repo, 'ls-files', '--error-unmatch', '--', 'team-filter.cfg'),
    ).toBe('team-filter.cfg');
    expect(git(repo, 'show', 'HEAD:team-filter.cfg')).toContain('clean = cat');
    expect(git(linked, 'config', '--includes', '--get', TEAM)).toBe('cat');
    return {
      repo,
      linked,
      payload,
      common: discover(linked, '--git-common-dir'),
      gitDir: discover(linked, '--git-dir'),
    };
  };

  it('R5-1: refuses a tracked include with a symlink in its path prefix', () => {
    const { repo, linked, payload, common, gitDir } = trackedInclude();
    expect(filterCommandsIn(common, gitDir, linked)).toEqual(refusedTeam);
    const alias = join(dir, 'alias');
    symlinkSync(
      dirname(repo),
      alias,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const included = join(alias, 'repo', 'team-filter.cfg');
    expect(realpathSync(included)).toBe(payload);
    expect(discover(dirname(included), '--show-toplevel')).toBe(repo);
    git(repo, 'config', '--global', 'include.path', included);
    expect(git(linked, 'config', '--includes', '--get', TEAM)).toBe('cat');

    expect.soft(filterCommandsIn(common, gitDir, linked)).toEqual(refusedTeam);
    expect.soft(checkoutFilterCommands(linked)).toEqual([TEAM]);
  });

  it.runIf(process.platform === 'darwin')(
    'R5-1: refuses a tracked ordinary file through a case-alias spelling',
    ({ skip }) => {
      const { repo, linked, payload, common, gitDir } = trackedInclude();
      const alias = join(repo, 'TEAM-FILTER.CFG');
      if (!existsSync(alias)) return skip();
      expect(realpathSync.native(alias)).toBe(payload);
      git(repo, 'config', '--global', 'include.path', alias);
      expect(git(linked, 'config', '--includes', '--get', TEAM)).toBe('cat');

      expect
        .soft(filterCommandsIn(common, gitDir, linked))
        .toEqual(refusedTeam);
      expect.soft(checkoutFilterCommands(linked)).toEqual([TEAM]);
    },
  );

  for (const spelling of ['team-filter.cfg', 'TEAM-FILTER.CFG']) {
    it.skipIf(process.platform === 'win32')(
      `R5-1: refuses tracked symlink leaf ${spelling} even when its target is outside`,
      ({ skip }) => {
        const { repo, linked, payload, common, gitDir } = trackedInclude();
        const outside = join(isolation.home, 'outside-filter.cfg');
        git(repo, 'config', '--file', outside, TEAM, 'cat');
        rmSync(payload);
        symlinkSync(outside, payload);
        git(repo, 'add', 'team-filter.cfg');
        git(repo, 'commit', '-qm', 'tracked symlink to outside filter');
        expect(realpathSync(payload)).toBe(outside);
        expect(
          git(repo, 'ls-files', '--stage', '--', 'team-filter.cfg'),
        ).toMatch(/^120000 [0-9a-f]+ 0\tteam-filter\.cfg$/);
        expect(git(repo, 'show', 'HEAD:team-filter.cfg')).toBe(outside);
        const included = join(repo, spelling);
        if (!existsSync(included)) return skip();
        git(repo, 'config', '--global', 'include.path', included);
        expect(git(linked, 'config', '--includes', '--get', TEAM)).toBe('cat');

        expect(filterCommandsIn(common, gitDir, linked)).toEqual(refusedTeam);
        expect(checkoutFilterCommands(linked)).toEqual([TEAM]);
      },
    );
  }

  it('R6-1: refuses a tracked include when core.worktree contains commonDir', () => {
    const shell = join(dir, 'shell');
    const common = join(shell, '.git');
    const payload = join(dir, 'team-filter.cfg');
    init(shell);
    git(shell, 'config', 'core.worktree', dir);
    git(dir, 'config', '--file', payload, TEAM, 'cat');
    const explicit = [`--git-dir=${common}`, `--work-tree=${dir}`];
    git(dir, ...explicit, 'add', 'team-filter.cfg');
    git(dir, ...explicit, 'commit', '-qm', 'tracked ancestor filter');
    git(dir, 'config', '--global', 'include.path', payload);
    expect(
      git(
        dir,
        ...explicit,
        'ls-files',
        '--error-unmatch',
        '--',
        'team-filter.cfg',
      ),
    ).toBe('team-filter.cfg');
    expect(git(common, ...explicit, 'rev-parse', '--show-prefix')).toBe(
      'shell/.git/',
    );
    const discovery = spawnSync('git', ['rev-parse', '--git-common-dir'], {
      cwd: dir,
      encoding: 'utf8',
      env: sanitizedGitEnv(),
    });
    expect(discovery.error).toBeUndefined();
    expect(discovery.status).toBe(128);
    expect(git(common, 'config', '--includes', '--get', TEAM)).toBe('cat');

    expect(filterCommandsIn(common, common, dir)).toEqual(refusedTeam);
  });

  it('R6-2: refuses unknown trackedness after a real index corruption', () => {
    const { repo, linked, common, gitDir } = trackedInclude();
    expect(filterCommandsIn(common, gitDir, linked)).toEqual(refusedTeam);
    writeFileSync(join(common, 'index'), 'broken');
    const tracked = spawnSync(
      'git',
      ['ls-files', '--error-unmatch', '--', 'team-filter.cfg'],
      {
        cwd: repo,
        encoding: 'utf8',
        env: sanitizedGitEnv(),
      },
    );
    expect(tracked.error).toBeUndefined();
    expect(tracked.status).toBe(128);
    expect(tracked.stderr).toMatch(/index.*(smaller|corrupt|signature)/i);
    expect(git(repo, 'show', 'HEAD:team-filter.cfg')).toContain('clean = cat');
    expect(git(linked, 'config', '--includes', '--get', TEAM)).toBe('cat');

    const screen = filterCommandsIn(common, gitDir, linked);
    expect.soft(screen.exempt).toEqual([]);
    expect.soft(screen.filters).toContain(TEAM);
    expect.soft(checkoutFilterCommands(linked)).not.toEqual([]);
  });

  it.skipIf(process.platform === 'win32')(
    'R6-2: refuses unknown provenance when origin discovery exits 129',
    () => {
      const { repo, linked, common, gitDir } = trackedInclude();
      expect(filterCommandsIn(common, gitDir, linked)).toEqual(refusedTeam);
      const realGit = execFileSync('which', ['git'], {
        encoding: 'utf8',
      }).trim();
      const shimDir = join(dir, 'shim');
      mkdirSync(shimDir);
      // Only origin discovery fails; config reads and the checkout caller's
      // linked-tree discovery still execute real Git.
      writeFileSync(
        join(shimDir, 'git'),
        [
          '#!/bin/sh',
          `if [ "$PWD" = ${shellQuotePath(repo)} ] && [ "$1" = rev-parse ]; then`,
          '  exit 129',
          'fi',
          `exec ${shellQuotePath(realGit)} "$@"`,
          '',
        ].join('\n'),
        { mode: 0o755 },
      );
      process.env['PATH'] = `${shimDir}:${process.env['PATH'] ?? ''}`;
      const discovery = spawnSync(
        'git',
        ['rev-parse', '--path-format=absolute', '--git-common-dir'],
        {
          cwd: repo,
          encoding: 'utf8',
          env: sanitizedGitEnv(),
        },
      );
      expect(discovery.error).toBeUndefined();
      expect(discovery.status).toBe(129);
      expect(discover(linked, '--git-common-dir')).toBe(common);
      expect(
        git(repo, 'ls-files', '--error-unmatch', '--', 'team-filter.cfg'),
      ).toBe('team-filter.cfg');
      expect(git(linked, 'config', '--includes', '--get', TEAM)).toBe('cat');

      const screen = filterCommandsIn(common, gitDir, linked);
      expect.soft(screen.exempt).toEqual([]);
      expect.soft(screen.filters).toContain(TEAM);
      expect.soft(checkoutFilterCommands(linked)).not.toEqual([]);
    },
  );

  it.each([
    { marker: 'invalid\n', error: 'invalid gitfile format' },
    { marker: 'gitdir: missing\n', error: 'not a git repository:' },
  ])('R6-2: refuses discovery fatal 128 ($error)', ({ marker, error }) => {
    const { repo, linked, common, gitDir } = trackedInclude();
    const nested = join(repo, 'nested');
    const payload = join(nested, 'team-filter.cfg');
    mkdirSync(nested);
    git(repo, 'config', '--file', payload, TEAM, 'cat');
    git(repo, 'add', 'nested/team-filter.cfg');
    git(repo, 'commit', '-qm', 'tracked nested filter');
    git(repo, 'config', '--global', 'include.path', payload);
    writeFileSync(join(nested, '.git'), marker);
    expect(
      git(repo, 'ls-files', '--error-unmatch', '--', 'nested/team-filter.cfg'),
    ).toBe('nested/team-filter.cfg');
    const discovery = spawnSync('git', ['rev-parse', '--git-common-dir'], {
      cwd: nested,
      encoding: 'utf8',
      env: { ...sanitizedGitEnv(), LC_ALL: 'C' },
    });
    expect(discovery.error).toBeUndefined();
    expect(discovery.status).toBe(128);
    expect(discovery.stderr).toContain(error);
    expect(git(linked, 'config', '--includes', '--get', TEAM)).toBe('cat');

    const screen = filterCommandsIn(common, gitDir, linked);
    expect.soft(screen.exempt).toEqual([]);
    expect.soft(screen.filters).toContain(TEAM);
    expect.soft(checkoutFilterCommands(linked)).not.toEqual([]);
  });

  for (const { screened, kind, filters, exempt } of [
    { screened: 'linked', kind: 'file', filters: [], exempt: [LFS] },
    { screened: 'HOME', kind: 'file', filters: [LFS], exempt: [] },
    { screened: 'linked', kind: 'symlink', filters: [], exempt: [LFS] },
    { screened: 'HOME', kind: 'symlink', filters: [LFS], exempt: [] },
  ]) {
    it.skipIf(kind === 'symlink' && process.platform === 'win32')(
      `R6-3: classifies the tracked native global ${kind} slot while screening ${screened}`,
      () => {
        const home = isolation.home;
        const linked = join(dir, 'home-linked');
        const globalConfig = join(home, '.gitconfig');
        init(home);
        git(home, 'config', '--global', LFS, 'cat');
        if (kind === 'symlink') {
          const outside = join(dir, 'outside-global.cfg');
          git(home, 'config', '--file', outside, LFS, 'cat');
          rmSync(globalConfig);
          symlinkSync(outside, globalConfig);
          expect(realpathSync(globalConfig)).toBe(outside);
        }
        git(home, 'add', '.gitconfig');
        git(home, 'commit', '-qm', 'tracked native global config');
        expect(git(home, 'ls-files', '--stage', '--', '.gitconfig')).toMatch(
          kind === 'symlink' ? /^120000 / : /^100644 /,
        );
        git(home, 'worktree', 'add', '--detach', '-q', linked, 'HEAD');
        expect(
          git(home, 'ls-files', '--error-unmatch', '--', '.gitconfig'),
        ).toBe('.gitconfig');
        expect(
          git(home, 'config', '--local', '--no-includes', '--list'),
        ).not.toMatch(/(?:filter\.|include\.)/);
        const tree = screened === 'HOME' ? home : linked;
        const common = discover(tree, '--git-common-dir');
        const gitDir = discover(tree, '--git-dir');
        expect(discover(tree, '--show-toplevel')).toBe(tree);
        expect(common).toBe(join(home, '.git'));
        expect(
          git(
            tree,
            'config',
            '--null',
            '--show-origin',
            '--show-scope',
            '--no-includes',
            '--get',
            LFS,
          ).replaceAll('\\', '/'),
        ).toBe(`global\0file:${globalConfig.replaceAll('\\', '/')}\0cat\0`);

        expect.soft(filterCommandsIn(common, gitDir, tree)).toEqual({
          filters,
          exempt,
          reachedExempt: [],
          attribution: [],
          unread: [],
          dangling: [],
        });
        expect.soft(checkoutFilterCommands(tree)).toEqual(filters);
      },
    );
  }
});
