/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, normalize, relative } from 'node:path';
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
const gitPath = (file: string) =>
  process.platform === 'win32' ? file.replaceAll('\\', '/') : file;
const init = (repo: string, ...args: string[]) => {
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main', ...args);
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

  const trackedInclude = (localInclude = true, name = 'team-filter.cfg') => {
    const repo = join(dir, 'real', 'repo');
    const linked = join(dir, 'linked');
    const payload = join(repo, name);
    const globalConfig = join(isolation.home, '.gitconfig');
    init(repo);
    mkdirSync(dirname(payload), { recursive: true });
    git(repo, 'config', '--file', payload, TEAM, 'cat');
    git(repo, 'add', name);
    git(repo, 'commit', '-qm', 'tracked filter');
    git(repo, 'worktree', 'add', '--detach', '-q', linked, 'HEAD');
    git(repo, 'config', '--global', 'include.path', gitPath(payload));
    if (localInclude) {
      git(repo, 'config', 'include.path', gitPath(globalConfig));
    }
    expect(git(repo, 'ls-files', '--error-unmatch', '--', name)).toBe(name);
    expect(git(repo, 'show', `HEAD:${name}`)).toContain('clean = cat');
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

  it.each(['untracked', 'ignored'])(
    'R7-1: refuses an %s global include inside the screened main tree',
    (kind) => {
      const repo = join(dir, 'main');
      const payload = join(repo, 'team-filter.cfg');
      init(repo);
      git(repo, 'commit', '--allow-empty', '-qm', 'seed');
      git(repo, 'config', '--file', payload, TEAM, 'cat');
      if (kind === 'ignored') {
        writeFileSync(
          join(repo, '.git', 'info', 'exclude'),
          'team-filter.cfg\n',
        );
        expect(git(repo, 'check-ignore', 'team-filter.cfg')).toBe(
          'team-filter.cfg',
        );
      }
      expect(git(repo, 'ls-files', '--', 'team-filter.cfg')).toBe('');
      git(repo, 'config', '--global', 'include.path', gitPath(payload));
      git(repo, 'config', 'include.path', gitPath(payload));
      expect(git(repo, 'config', '--includes', '--get', TEAM)).toBe('cat');
      const common = discover(repo, '--git-common-dir');

      expect.soft(filterCommandsIn(common, common, repo)).toEqual(refusedTeam);
      expect.soft(checkoutFilterCommands(repo)).toEqual([TEAM]);
    },
  );

  it.each(['HOME', 'linked'])(
    'R7-1: classifies an untracked native global slot while screening %s',
    (screened) => {
      const home = isolation.home;
      const linked = join(dir, 'home-linked');
      init(home);
      git(home, 'config', '--global', LFS, 'cat');
      git(home, 'commit', '--allow-empty', '-qm', 'seed');
      git(home, 'worktree', 'add', '--detach', '-q', linked, 'HEAD');
      expect(git(home, 'ls-files', '--', '.gitconfig')).toBe('');
      const tree = screened === 'HOME' ? home : linked;
      const common = discover(tree, '--git-common-dir');
      const gitDir = discover(tree, '--git-dir');
      expect(git(tree, 'config', '--includes', '--get', LFS)).toBe('cat');
      const filters = screened === 'HOME' ? [LFS] : [];

      expect.soft(filterCommandsIn(common, gitDir, tree)).toEqual({
        ...refusedTeam,
        filters,
        exempt: screened === 'HOME' ? [] : [LFS],
      });
      expect.soft(checkoutFilterCommands(tree)).toEqual(filters);
    },
  );

  for (const screened of ['main', 'linked']) {
    it.skipIf(process.platform === 'win32')(
      `R7-1: classifies a global symlink with a tracked target while screening ${screened}`,
      () => {
        const repo = join(isolation.home, 'dotfiles');
        const linked = join(dir, 'dotfiles-linked');
        const payload = join(repo, 'git', 'gitconfig');
        const slot = join(isolation.home, '.gitconfig');
        init(repo);
        mkdirSync(dirname(payload));
        git(repo, 'config', '--file', payload, LFS, 'cat');
        git(repo, 'add', 'git/gitconfig');
        git(repo, 'commit', '-qm', 'tracked global target');
        git(repo, 'worktree', 'add', '--detach', '-q', linked, 'HEAD');
        rmSync(slot);
        symlinkSync(payload, slot);
        expect(realpathSync(slot)).toBe(payload);
        expect(git(repo, 'ls-files', '--stage', '--', 'git/gitconfig')).toMatch(
          /^100644 [0-9a-f]+ 0\tgit\/gitconfig$/,
        );
        const tree = screened === 'main' ? repo : linked;
        const common = discover(tree, '--git-common-dir');
        const gitDir = discover(tree, '--git-dir');
        expect(git(tree, 'config', '--show-origin', '--get', LFS)).toBe(
          `file:${slot}\tcat`,
        );
        const filters = screened === 'main' ? [LFS] : [];

        expect.soft(filterCommandsIn(common, gitDir, tree)).toEqual({
          ...refusedTeam,
          filters,
          exempt: screened === 'main' ? [] : [LFS],
        });
        expect.soft(checkoutFilterCommands(tree)).toEqual(filters);
      },
    );
  }

  const redirects = [
    { root: 'disjoint', localInclude: false },
    { root: 'disjoint', localInclude: true },
    { root: 'ancestor', localInclude: false },
    { root: 'ancestor', localInclude: true },
  ];

  it.each(redirects)(
    'R7-2: refuses a discovered-root $root redirect (local include: $localInclude)',
    ({ root, localInclude }) => {
      const name = 'dotfiles/gitconfig';
      const { repo, linked, payload, common, gitDir } = trackedInclude(
        false,
        name,
      );
      if (localInclude) {
        git(repo, 'config', 'include.path', gitPath(payload));
      }
      expect(filterCommandsIn(common, gitDir, linked)).toEqual(refusedTeam);
      expect(checkoutFilterCommands(linked)).toEqual([TEAM]);
      const elsewhere =
        root === 'ancestor' ? dirname(payload) : join(dir, 'unrelated root');
      mkdirSync(elsewhere, { recursive: true });
      git(repo, 'config', 'core.worktree', gitPath(elsewhere));
      expect(discover(dirname(payload), '--git-common-dir')).toBe(common);
      expect(discover(dirname(payload), '--show-toplevel')).toBe(elsewhere);
      expect(discover(linked, '--show-toplevel')).toBe(linked);
      expect(
        git(
          linked,
          `--git-dir=${common}`,
          `--work-tree=${repo}`,
          'ls-files',
          '--error-unmatch',
          '--',
          name,
        ),
      ).toBe(name);
      if (root === 'ancestor') {
        const wrongPath = spawnSync(
          'git',
          [
            'ls-files',
            '--error-unmatch',
            '--',
            gitPath(relative(elsewhere, payload)),
          ],
          { cwd: elsewhere, encoding: 'utf8', env: sanitizedGitEnv() },
        );
        expect(wrongPath.error).toBeUndefined();
        expect(wrongPath.status).toBe(1);
      }
      expect(git(linked, 'config', '--includes', '--get', TEAM)).toBe('cat');

      expect
        .soft(filterCommandsIn(common, gitDir, linked))
        .toEqual(refusedTeam);
      expect.soft(checkoutFilterCommands(linked)).toEqual([TEAM]);
    },
  );

  it.each(redirects)(
    'R7-2: refuses a declared-root $root redirect (local include: $localInclude)',
    ({ root, localInclude }) => {
      const repo = join(dir, 'separate-main');
      const common = join(dir, 'admin', 'repo.git');
      const linked = join(dir, 'separate-linked');
      const payload = join(repo, 'team-filter.cfg');
      const geometry = join(common, 'worktree.inc');
      mkdirSync(dirname(common));
      init(repo, '--separate-git-dir', common);
      git(repo, 'config', '--file', payload, TEAM, 'cat');
      git(repo, 'add', 'team-filter.cfg');
      git(repo, 'commit', '-qm', 'tracked filter');
      git(repo, 'worktree', 'add', '--detach', '-q', linked, 'HEAD');
      const gitDir = discover(linked, '--git-dir');
      const declared = gitPath(relative(common, repo));
      git(linked, 'config', '--file', geometry, 'core.worktree', declared);
      git(linked, 'config', 'include.path', gitPath(geometry));
      git(linked, 'config', '--global', 'include.path', gitPath(payload));
      if (localInclude) {
        git(linked, 'config', '--add', 'include.path', gitPath(payload));
      }
      rmSync(join(repo, '.git'));
      const discovery = spawnSync('git', ['rev-parse', '--git-common-dir'], {
        cwd: repo,
        encoding: 'utf8',
        env: { ...sanitizedGitEnv(), LC_ALL: 'C' },
      });
      expect(discovery.error).toBeUndefined();
      expect(discovery.status).toBe(128);
      expect(discovery.stderr).toMatch(/^fatal: not a git repository/);
      expect(
        git(linked, 'config', '--includes', '--path', '--get', 'core.worktree'),
      ).toBe(declared);
      expect(filterCommandsIn(common, gitDir, linked)).toEqual(refusedTeam);
      expect(checkoutFilterCommands(linked)).toEqual([TEAM]);

      const elsewhere = root === 'ancestor' ? dir : join(dir, 'unrelated root');
      mkdirSync(elsewhere, { recursive: true });
      // Append after the include: its declared root otherwise wins over a
      // value written into the first [core] section by `git config`.
      appendFileSync(
        join(common, 'config'),
        `\n[core]\n\tworktree = ${JSON.stringify(gitPath(elsewhere))}\n`,
      );
      expect(
        normalize(
          git(
            linked,
            'config',
            '--includes',
            '--path',
            '--get',
            'core.worktree',
          ),
        ),
      ).toBe(elsewhere);
      expect(discover(linked, '--show-toplevel')).toBe(linked);
      expect(
        git(
          linked,
          `--git-dir=${common}`,
          `--work-tree=${repo}`,
          'ls-files',
          '--error-unmatch',
          '--',
          'team-filter.cfg',
        ),
      ).toBe('team-filter.cfg');
      if (root === 'ancestor') {
        const wrongPath = spawnSync(
          'git',
          [
            `--git-dir=${common}`,
            `--work-tree=${elsewhere}`,
            'ls-files',
            '--error-unmatch',
            '--',
            gitPath(relative(elsewhere, payload)),
          ],
          { cwd: elsewhere, encoding: 'utf8', env: sanitizedGitEnv() },
        );
        expect(wrongPath.error).toBeUndefined();
        expect(wrongPath.status).toBe(1);
      }
      expect(git(linked, 'config', '--includes', '--get', TEAM)).toBe('cat');

      expect
        .soft(filterCommandsIn(common, gitDir, linked))
        .toEqual(refusedTeam);
      expect.soft(checkoutFilterCommands(linked)).toEqual([TEAM]);
    },
  );

  it.each(['discovered', 'configured'])(
    'R7-2: refuses a forged common-dir marker at the %s-root entrance',
    (entrance) => {
      const repo = join(dir, 'main');
      const linked = join(dir, 'linked');
      const name = 'dotfiles/gitconfig';
      const payload = join(repo, name);
      init(
        repo,
        ...(entrance === 'configured'
          ? ['--separate-git-dir', join(dir, 'admin.git')]
          : []),
      );
      mkdirSync(dirname(payload));
      git(repo, 'config', '--file', payload, TEAM, 'cat');
      git(repo, 'add', name);
      git(repo, 'commit', '-qm', 'tracked filter');
      git(repo, 'worktree', 'add', '--detach', '-q', linked, 'HEAD');
      const common = discover(linked, '--git-common-dir');
      const gitDir = discover(linked, '--git-dir');
      git(linked, 'config', '--global', 'include.path', gitPath(payload));
      git(linked, 'config', 'include.path', gitPath(payload));
      if (entrance === 'configured') {
        git(linked, 'config', 'core.worktree', gitPath(repo));
        rmSync(join(repo, '.git'));
        const discovery = spawnSync('git', ['rev-parse', '--git-common-dir'], {
          cwd: dirname(payload),
          encoding: 'utf8',
          env: { ...sanitizedGitEnv(), LC_ALL: 'C' },
        });
        expect(discovery.error).toBeUndefined();
        expect(discovery.status).toBe(128);
        expect(discovery.stderr).toMatch(/^fatal: not a git repository/);
      }
      expect(filterCommandsIn(common, gitDir, linked)).toEqual(refusedTeam);
      expect(checkoutFilterCommands(linked)).toEqual([TEAM]);

      const root = join(common, 'info');
      const marker = join(root, '.git');
      mkdirSync(root, { recursive: true });
      git(
        linked,
        'config',
        '--file',
        join(common, 'config'),
        'core.worktree',
        gitPath(root),
      );
      expect(existsSync(marker)).toBe(false);
      expect(filterCommandsIn(common, gitDir, linked)).toEqual(refusedTeam);
      expect(checkoutFilterCommands(linked)).toEqual([TEAM]);

      writeFileSync(marker, `gitdir: ${gitPath(common)}\n`);
      expect(
        normalize(git(common, 'rev-parse', '--resolve-git-dir', marker)),
      ).toBe(common);
      if (entrance === 'discovered') {
        expect(discover(dirname(payload), '--git-common-dir')).toBe(common);
        expect(discover(dirname(payload), '--show-toplevel')).toBe(root);
      }
      expect(discover(linked, '--show-toplevel')).toBe(linked);
      expect(
        git(
          linked,
          `--git-dir=${common}`,
          `--work-tree=${repo}`,
          'ls-files',
          '--error-unmatch',
          '--',
          name,
        ),
      ).toBe(name);
      expect(git(linked, 'config', '--includes', '--get', TEAM)).toBe('cat');

      expect
        .soft(filterCommandsIn(common, gitDir, linked))
        .toEqual(refusedTeam);
      expect.soft(checkoutFilterCommands(linked)).toEqual([TEAM]);
    },
  );

  it.each(['native', 'included'])(
    'R7 control: preserves a legitimate %s global filter with relative core.worktree',
    (kind) => {
      const repo = join(dir, 'main');
      const linked = join(dir, 'linked');
      init(repo);
      git(repo, 'commit', '--allow-empty', '-qm', 'seed');
      git(repo, 'worktree', 'add', '--detach', '-q', linked, 'HEAD');
      git(repo, 'config', 'core.worktree', '..');
      const payload = join(
        isolation.home,
        kind === 'native' ? '.gitconfig' : 'user-filter.cfg',
      );
      git(linked, 'config', '--file', payload, LFS, 'cat');
      if (kind === 'included') {
        git(linked, 'config', '--global', 'include.path', gitPath(payload));
      }
      git(linked, 'config', 'include.path', gitPath(payload));
      const common = discover(linked, '--git-common-dir');
      const gitDir = discover(linked, '--git-dir');
      expect(git(linked, 'config', '--includes', '--get', LFS)).toBe('cat');

      expect(filterCommandsIn(common, gitDir, linked)).toEqual({
        filters: [],
        exempt: [LFS],
        reachedExempt: [LFS],
        attribution: [],
        unread: [],
        dangling: [],
      });
      expect(checkoutFilterCommands(linked)).toEqual([]);
    },
  );

  it.each(['submodule', 'separate-dir'])(
    'R7 control: preserves an external user include with a legitimate %s root',
    (layout) => {
      let repo: string;
      if (layout === 'submodule') {
        const source = join(dir, 'source');
        const parent = join(dir, 'super');
        init(source);
        git(source, 'commit', '--allow-empty', '-qm', 'seed');
        init(parent);
        git(
          parent,
          '-c',
          'protocol.file.allow=always',
          'submodule',
          'add',
          '-q',
          source,
          'mod',
        );
        repo = join(parent, 'mod');
      } else {
        repo = join(dir, 'separate-main');
        init(repo, '--separate-git-dir', join(dir, 'separate.git'));
        git(repo, 'commit', '--allow-empty', '-qm', 'seed');
        const common = discover(repo, '--git-common-dir');
        git(repo, 'config', 'core.worktree', gitPath(relative(common, repo)));
      }
      const linked = join(dir, 'linked');
      git(repo, 'worktree', 'add', '--detach', '-q', linked, 'HEAD');
      const common = discover(linked, '--git-common-dir');
      const gitDir = discover(linked, '--git-dir');
      expect(discover(repo, '--git-common-dir')).toBe(common);
      expect(discover(repo, '--show-toplevel')).toBe(repo);
      expect(git(repo, 'config', '--get', 'core.worktree')).toBe(
        gitPath(relative(common, repo)),
      );
      const payload = join(isolation.home, 'user-filter.cfg');
      git(linked, 'config', '--file', payload, LFS, 'cat');
      git(linked, 'config', '--global', 'include.path', gitPath(payload));
      git(linked, 'config', 'include.path', gitPath(payload));
      expect(git(linked, 'config', '--includes', '--get', LFS)).toBe('cat');

      expect(filterCommandsIn(common, gitDir, linked)).toEqual({
        filters: [],
        exempt: [LFS],
        reachedExempt: [LFS],
        attribution: [],
        unread: [],
        dangling: [],
      });
      expect(checkoutFilterCommands(linked)).toEqual([]);
    },
  );

  it('R7-3: refuses a partial trusted-list failure while global filter records remain visible', () => {
    const { linked, payload, common, gitDir } = trackedInclude(false);
    expect(filterCommandsIn(common, gitDir, linked)).toEqual(refusedTeam);
    expect(checkoutFilterCommands(linked)).toEqual([TEAM]);
    const padding = join(common, 'padding.cfg');
    writeFileSync(padding, `[padding]\n\tvalue = ${'x'.repeat(1024 * 1024)}\n`);
    // Repeated includes overflow only the merged --list output; the
    // filter query and the local include walk still read small records.
    appendFileSync(
      join(common, 'config'),
      `\n[include]\n\tpath = ${JSON.stringify(gitPath(padding))}\n`.repeat(65),
    );
    const read = (...args: string[]) =>
      spawnSync(
        'git',
        ['config', '--null', '--show-origin', '--show-scope', ...args],
        {
          cwd: linked,
          encoding: 'utf8',
          maxBuffer: 64 * 1024 * 1024,
          env: sanitizedGitEnv(),
        },
      );
    const list = read('--includes', '--list');
    expect((list.error as NodeJS.ErrnoException | undefined)?.code).toBe(
      'ENOBUFS',
    );
    const visible = read('--includes', '--get-regexp', '^filter\\..*\\.clean$');
    expect(visible.error).toBeUndefined();
    expect(visible.status).toBe(0);
    expect(visible.stdout.replaceAll('\\', '/')).toBe(
      `global\0file:${payload.replaceAll('\\', '/')}\0${TEAM}\ncat\0`,
    );
    const native = read('--no-includes', '--list');
    expect(native.error).toBeUndefined();
    expect(native.status).toBe(0);
    expect(
      git(linked, 'config', '--local', '--no-includes', '--list'),
    ).not.toMatch(/^filter\./m);

    const screen = filterCommandsIn(common, gitDir, linked);
    expect(screen.exempt).toEqual([]);
    expect(screen.attribution.join('\n')).toContain('ENOBUFS');
    expect.soft(screen.unread).not.toEqual([]);
    expect.soft(checkoutFilterCommands(linked)).not.toEqual([]);
  }, 60_000);
});
