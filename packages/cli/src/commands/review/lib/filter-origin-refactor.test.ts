/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, normalize } from 'node:path';
import { shellQuotePath } from './shell-quote.js';
import { isolateHostGitConfig } from './test-utils.js';
import {
  checkoutFilterCommands,
  filterCommandsIn,
  sanitizedGitEnv,
} from './worktree.js';

const TEAM = 'filter.team.clean';
const FILTER_KEYS = '^filter\\..*\\.(smudge|clean|process)$';
const SCREEN_KEYS = `${FILTER_KEYS}|^include\\.path$|^includeif\\..*\\.path$`;
const scoped = ['config', '--null', '--show-origin', '--show-scope'];
const mergedFilters = [...scoped, '--includes', '--get-regexp', FILTER_KEYS];
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: sanitizedGitEnv(),
    timeout: 5_000,
    maxBuffer: 1024 * 1024,
  }).trim();
const discover = (cwd: string, flag: string) =>
  normalize(git(cwd, 'rev-parse', '--path-format=absolute', flag));
const gitPath = (file: string) => file.split('\\').join('/');

describe('filter origin refactor reproduction (real Git)', () => {
  let dir: string;
  let isolation: ReturnType<typeof isolateHostGitConfig>;
  beforeEach(() => {
    isolation = isolateHostGitConfig();
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'qwen-filter-refactor-')));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    isolation.dispose();
  });

  const fixture = (layout: 'normal' | 'separate' | 'bare') => {
    const repo = join(dir, 'main');
    const linked = join(dir, 'linked');
    const admin = join(dir, 'admin.git');
    mkdirSync(repo);
    if (layout === 'bare') {
      git(dir, 'init', '-q', '--bare', '-b', 'main', admin);
      git(dir, `--git-dir=${admin}`, 'config', 'core.bare', 'false');
    } else {
      git(
        repo,
        'init',
        '-q',
        '-b',
        'main',
        ...(layout === 'separate' ? ['--separate-git-dir', admin] : []),
      );
    }
    const common = layout === 'normal' ? join(repo, '.git') : admin;
    const explicit = [`--git-dir=${common}`, `--work-tree=${repo}`];
    git(dir, ...explicit, 'config', 'user.email', 'test@example.com');
    git(dir, ...explicit, 'config', 'user.name', 'test');
    const name = 'dotfiles/team-filter.cfg';
    const payload = join(repo, name);
    const canary = join(dir, 'filter-ran');
    const command = `printf executed > ${shellQuotePath(canary)}; cat`;
    mkdirSync(dirname(payload));
    git(dir, 'config', '--file', payload, TEAM, command);
    writeFileSync(join(repo, '.gitattributes'), 'witness.txt filter=team\n');
    writeFileSync(join(repo, 'witness.txt'), 'bounded witness\n');
    git(dir, ...explicit, 'add', '.');
    git(dir, ...explicit, 'commit', '-qm', 'tracked filter witness');
    git(dir, ...explicit, 'worktree', 'add', '--detach', '-q', linked, 'HEAD');
    const gitDir = discover(linked, '--git-dir');
    expect(discover(linked, '--git-common-dir')).toBe(common);
    git(linked, 'config', '--global', 'include.path', gitPath(payload));
    expect(
      git(dir, ...explicit, 'ls-files', '--error-unmatch', '--', name),
    ).toBe(name);
    expect(git(dir, ...explicit, 'show', `HEAD:${name}`)).toContain('clean = ');
    expect(git(linked, 'config', '--includes', '--get', TEAM)).toBe(command);
    expect(
      git(linked, ...scoped, '--includes', '--get-regexp', FILTER_KEYS),
    ).toContain(`global\0file:${gitPath(payload)}\0${TEAM}\n${command}`);
    expect(readFileSync(join(common, 'config'), 'utf8')).not.toMatch(
      /\[include(?:If)?\b/,
    );
    return { repo, linked, common, gitDir, payload, canary, command, name };
  };

  const witness = (f: ReturnType<typeof fixture>) => {
    const screen = filterCommandsIn(f.common, f.gitDir, f.linked);
    const checkout = checkoutFilterCommands(f.linked);
    expect(existsSync(f.canary)).toBe(false);
    git(f.linked, 'hash-object', '--path=witness.txt', 'witness.txt');
    expect(readFileSync(f.canary, 'utf8')).toBe('executed');
    return { screen, checkout };
  };

  it('F1: refuses a global-only tracked payload rooted by config.worktree', () => {
    const f = fixture('bare');
    git(f.linked, 'config', 'extensions.worktreeConfig', 'true');
    git(
      f.linked,
      'config',
      '--file',
      join(f.common, 'config.worktree'),
      'core.worktree',
      gitPath(f.repo),
    );
    expect(existsSync(join(f.repo, '.git'))).toBe(false);
    expect(
      git(dir, `--git-dir=${f.common}`, 'config', '--get', 'core.worktree'),
    ).toBe(gitPath(f.repo));
    expect(
      git(dir, `--git-dir=${f.common}`, 'rev-parse', '--show-toplevel'),
    ).toBe(f.repo);
    expect(readFileSync(join(f.common, 'config'), 'utf8')).not.toMatch(
      /worktree\s*=/i,
    );
    const { screen, checkout } = witness(f);
    expect.soft(screen.filters).toContain(TEAM);
    expect.soft(screen.exempt).not.toContain(TEAM);
    expect.soft(checkout).toContain(TEAM);
  });

  it.each(['separate', 'bare'] as const)(
    'F2: refuses a tracked payload behind a redirected %s Git directory',
    (layout) => {
      const f = fixture(layout);
      if (layout === 'bare') {
        git(f.linked, 'config', 'core.worktree', gitPath(f.repo));
      }
      expect(filterCommandsIn(f.common, f.gitDir, f.linked).filters).toContain(
        TEAM,
      );
      expect(checkoutFilterCommands(f.linked)).toContain(TEAM);
      const root = dirname(f.payload);
      git(f.linked, 'config', 'core.worktree', gitPath(root));
      writeFileSync(join(root, '.git'), `gitdir: ${gitPath(f.common)}\n`);
      expect(discover(root, '--show-toplevel')).toBe(root);
      expect(discover(root, '--git-common-dir')).toBe(f.common);
      expect(
        normalize(
          git(root, 'rev-parse', '--resolve-git-dir', join(root, '.git')),
        ),
      ).toBe(f.common);
      expect(
        git(
          dir,
          `--git-dir=${f.common}`,
          `--work-tree=${f.repo}`,
          'ls-files',
          '--error-unmatch',
          '--',
          f.name,
        ),
      ).toBe(f.name);
      const { screen, checkout } = witness(f);
      expect.soft(screen.filters).toContain(TEAM);
      expect.soft(screen.exempt).not.toContain(TEAM);
      expect.soft(checkout).toContain(TEAM);
    },
  );

  it
    .skipIf(process.platform === 'win32')
    .each([
      'legacy-filter-only',
      'merged',
      'native',
      'all-scoped',
      'malformed',
    ])('F3: refuses with a %s enumeration fault', (fault) => {
    const f = fixture('normal');
    expect(filterCommandsIn(f.common, f.gitDir, f.linked).filters).toContain(
      TEAM,
    );
    expect(checkoutFilterCommands(f.linked)).toContain(TEAM);
    const realGit = execFileSync('sh', ['-c', 'command -v git'], {
      encoding: 'utf8',
    }).trim();
    const bin = join(dir, 'bin');
    const hits = join(dir, 'injected-queries');
    mkdirSync(bin);
    const query =
      fault === 'legacy-filter-only'
        ? mergedFilters
        : [
            ...scoped,
            fault === 'native' ? '--no-includes' : '--includes',
            '--get-regexp',
            SCREEN_KEYS,
          ];
    const matches =
      fault === 'all-scoped'
        ? '[ "$4" = --show-scope ]'
        : `[ "$4" = --show-scope ] && [ "$5" = ${shellQuotePath(query[4])} ] && [ "$7" = ${shellQuotePath(query[6])} ]`;
    // Inject only enumeration faults; all other operations use real Git.
    writeFileSync(
      join(bin, 'git'),
      `#!/bin/sh
if ${matches}; then
  printf 'injected\\n' >> ${shellQuotePath(hits)}
  ${fault === 'malformed' ? "printf 'global\\0broken\\0'; exit 0" : "printf 'bounded scoped-filter failure\\n' >&2; exit 73"}
fi
exec ${shellQuotePath(realGit)} "$@"
`,
      { mode: 0o755 },
    );
    process.env['PATH'] = `${bin}${delimiter}${process.env['PATH'] ?? ''}`;
    const injected = spawnSync('git', query, {
      cwd: f.linked,
      encoding: 'utf8',
      env: sanitizedGitEnv(),
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
    });
    expect(injected.error).toBeUndefined();
    expect(injected.status).toBe(fault === 'malformed' ? 0 : 73);
    if (fault !== 'all-scoped') {
      expect(git(f.linked, ...scoped, '--includes', '--list')).toContain(
        `${TEAM}\n${f.command}`,
      );
    }
    expect(git(f.linked, 'config', '--includes', '--get', TEAM)).toBe(
      f.command,
    );
    const { screen, checkout } = witness(f);
    expect(readFileSync(hits, 'utf8').trim().split('\n')).toHaveLength(
      fault === 'legacy-filter-only' ? 1 : fault === 'all-scoped' ? 5 : 3,
    );
    if (fault === 'legacy-filter-only') {
      expect(screen.attribution).toEqual([]);
      expect(screen.filters).toContain(TEAM);
    } else {
      expect(screen.unread.join('\n')).toContain(
        fault === 'malformed'
          ? 'malformed origin records'
          : 'git config exited 73',
      );
    }
    expect.soft([...screen.filters, ...screen.unread]).not.toEqual([]);
    expect.soft(checkout).not.toEqual([]);
  });

  it.each(['native', 'included'])(
    'control: permits a legitimate %s global filter outside the repository',
    (kind) => {
      const repo = join(dir, 'repo');
      mkdirSync(repo);
      git(repo, 'init', '-q');
      const payload = join(
        isolation.home,
        kind === 'native' ? '.gitconfig' : 'user-filter.cfg',
      );
      git(repo, 'config', '--file', payload, TEAM, 'cat');
      if (kind === 'included') {
        git(repo, 'config', '--global', 'include.path', gitPath(payload));
      }
      expect(git(repo, 'config', '--includes', '--get', TEAM)).toBe('cat');
      const common = discover(repo, '--git-common-dir');
      expect(filterCommandsIn(common, common, repo)).toEqual({
        filters: [],
        exempt: [TEAM],
        reachedExempt: [],
        attribution: [],
        unread: [],
        dangling: [],
      });
      expect(checkoutFilterCommands(repo)).toEqual([]);
    },
  );

  it.each(['main', 'linked'])(
    'refuses a markerless nested submodule %s index source',
    (tree) => {
      const f = fixture('normal');
      git(f.linked, 'config', '--global', '--unset-all', 'include.path');
      const source = join(dir, 'source');
      mkdirSync(source);
      git(source, 'init', '-q');
      git(source, 'config', 'user.name', 'test');
      git(source, 'config', 'user.email', 'test@example.com');
      writeFileSync(join(source, 'seed'), 'seed\n');
      git(source, 'add', '.');
      git(source, 'commit', '-qm', 'seed');
      git(
        f.repo,
        '-c',
        'protocol.file.allow=always',
        'submodule',
        'add',
        '-q',
        source,
        'group/mod',
      );
      const main = join(f.repo, 'group/mod');
      const moduleTree = tree === 'main' ? main : join(dir, 'module-linked');
      if (tree === 'linked')
        git(main, 'worktree', 'add', '--detach', '-q', moduleTree, 'HEAD');
      const admin = discover(moduleTree, '--git-dir');
      const payload = join(moduleTree, 'module-only.cfg');
      git(moduleTree, 'config', '--file', payload, TEAM, f.command);
      git(moduleTree, 'add', 'module-only.cfg');
      expect(
        git(moduleTree, 'ls-files', '--error-unmatch', 'module-only.cfg'),
      ).toBe('module-only.cfg');
      rmSync(join(moduleTree, '.git'));
      git(
        f.linked,
        'config',
        '--global',
        '--replace-all',
        'include.path',
        payload,
      );
      expect(
        git(
          dir,
          `--git-dir=${admin}`,
          `--work-tree=${moduleTree}`,
          'ls-files',
          '--error-unmatch',
          'module-only.cfg',
        ),
      ).toBe('module-only.cfg');
      const { screen, checkout } = witness(f);
      expect(screen.filters).toContain(TEAM);
      expect(screen.exempt).not.toContain(TEAM);
      expect(checkout).toContain(TEAM);
    },
  );

  it('refuses an ambiguous external suffix but not an unrelated filename', () => {
    const f = fixture('bare');
    const outside = join(isolation.home, 'dotfiles', 'team-filter.cfg');
    mkdirSync(dirname(outside));
    git(f.linked, 'config', '--file', outside, TEAM, f.command);
    git(
      f.linked,
      'config',
      '--global',
      '--replace-all',
      'include.path',
      outside,
    );
    expect(checkoutFilterCommands(f.linked)).toContain(TEAM);
    const other = join(isolation.home, 'user-filter.cfg');
    git(f.linked, 'config', '--file', other, TEAM, f.command);
    git(f.linked, 'config', '--global', '--replace-all', 'include.path', other);
    expect(checkoutFilterCommands(f.linked)).toEqual([]);
  });

  it.skipIf(process.platform === 'win32').each([false, true])(
    'refuses a tracked prefix symlink to an external include (parent traversal: %s)',
    (parent) => {
      const f = fixture('normal');
      git(f.linked, 'config', '--global', '--unset-all', 'include.path');
      const payload = join(isolation.home, 'user-filter.cfg');
      git(f.linked, 'config', '--file', payload, TEAM, f.command);
      const target = parent ? join(isolation.home, 'child') : isolation.home;
      mkdirSync(target, { recursive: true });
      symlinkSync(target, join(f.repo, 'user-config'));
      git(f.repo, 'add', 'user-config');
      const alias = `${f.repo}/user-config/${parent ? '../' : ''}user-filter.cfg`;
      git(
        f.linked,
        'config',
        '--global',
        '--replace-all',
        'include.path',
        alias,
      );
      expect(realpathSync.native(alias)).toBe(payload);
      expect(checkoutFilterCommands(f.linked)).toContain(TEAM);
      expect(existsSync(f.canary)).toBe(false);
      git(
        f.linked,
        'config',
        '--global',
        '--replace-all',
        'include.path',
        payload,
      );
      expect(checkoutFilterCommands(f.linked)).toEqual([]);
    },
  );

  it('bounds admin groups and does not grant native exemptions after truncation', () => {
    const f = fixture('normal');
    git(f.linked, 'config', '--global', '--unset-all', 'include.path');
    git(f.linked, 'config', '--global', TEAM, f.command);
    for (let n = 0; n < 65; n++)
      mkdirSync(join(f.common, 'modules', `group-${n}`), { recursive: true });
    expect(checkoutFilterCommands(f.linked)).toContain(TEAM);
    expect(existsSync(f.canary)).toBe(false);
  });

  it.skipIf(process.platform === 'win32').for([
    { indexed: '\u03a3', alias: '\u03c2' },
    { indexed: '\u1e9e', alias: '\u00df' },
    { indexed: 'S', alias: '\u017f' },
  ])(
    'refuses a Unicode filesystem alias $indexed / $alias',
    ({ indexed, alias }, context) => {
      const f = fixture('separate');
      git(f.linked, 'config', '--global', '--unset-all', 'include.path');
      const payload = join(isolation.home, 'user-filter.cfg');
      git(f.linked, 'config', '--file', payload, TEAM, f.command);
      const indexedFile = join(f.repo, indexed);
      const aliasFile = join(f.repo, alias);
      symlinkSync(payload, indexedFile);
      if (
        !existsSync(aliasFile) ||
        lstatSync(aliasFile).ino !== lstatSync(indexedFile).ino
      )
        context.skip();
      git(f.repo, 'add', '--', indexed);
      git(f.linked, 'config', 'core.worktree', f.repo);
      rmSync(join(f.repo, '.git'));
      git(f.linked, 'config', '--global', 'include.path', aliasFile);
      const { screen, checkout } = witness(f);
      expect(screen.exempt).not.toContain(TEAM);
      expect(checkout).toContain(TEAM);
      git(
        f.linked,
        'config',
        '--global',
        '--replace-all',
        'include.path',
        payload,
      );
      expect(checkoutFilterCommands(f.linked)).toEqual([]);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'terminates a cyclic module group without losing indexed sources',
    () => {
      const f = fixture('normal');
      const group = join(f.common, 'modules', 'group');
      mkdirSync(group, { recursive: true });
      symlinkSync(group, join(group, 'cycle'));
      expect(checkoutFilterCommands(f.linked)).toContain(TEAM);
      expect(existsSync(f.canary)).toBe(false);
    },
  );
});
