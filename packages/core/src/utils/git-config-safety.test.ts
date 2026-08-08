/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gitConfigMayExecutePrograms } from './git-config-safety.js';

describe('gitConfigMayExecutePrograms', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'git-config-safety-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function makeRepo(name: string, config = ''): string {
    const repo = path.join(root, name);
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    if (config) {
      fs.writeFileSync(path.join(repo, '.git', 'config'), config);
    }
    return repo;
  }

  it('returns false outside a git repository', () => {
    expect(gitConfigMayExecutePrograms(root)).toBe(false);
  });

  it('returns false for an undefined cwd', () => {
    expect(gitConfigMayExecutePrograms(undefined)).toBe(false);
  });

  it('returns false for a clean repo config (including nested cwd)', () => {
    const repo = makeRepo(
      'clean',
      '[core]\n\trepositoryformatversion = 0\n\tbare = false\n[remote "origin"]\n\turl = https://example.com/repo.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n',
    );
    expect(gitConfigMayExecutePrograms(repo)).toBe(false);

    const nested = path.join(repo, 'src', 'deep');
    fs.mkdirSync(nested, { recursive: true });
    expect(gitConfigMayExecutePrograms(nested)).toBe(false);
  });

  it('returns false when .git/config does not exist', () => {
    const repo = makeRepo('no-config');
    expect(gitConfigMayExecutePrograms(repo)).toBe(false);
  });

  it.each([
    ['[diff]\n\texternal = /tmp/evil\n', 'diff.external'],
    ['[core]\n\tpager = less -R\n', 'core.pager'],
    ['[core]\n\tfsmonitor = /tmp/evil\n', 'core.fsmonitor'],
    ['[core]\n\taskpass = /tmp/evil\n', 'core.askpass'],
    ['[core]\n\tsshCommand = /tmp/evil\n', 'core.sshCommand'],
    ['[credential]\n\thelper = !/tmp/evil\n', 'credential.helper'],
    ['[gpg]\n\tprogram = /tmp/evil\n', 'gpg.program'],
    [
      '[core]\n\talternateRefsCommand = /tmp/evil\n',
      'core.alternateRefsCommand',
    ],
  ] as Array<[string, string]>)(
    'flags program-valued key %s',
    (config, label) => {
      const repo = makeRepo(label.replace(/\W+/g, '-'), config);
      expect(gitConfigMayExecutePrograms(repo)).toBe(true);
    },
  );

  it('is case-insensitive for section and key names', () => {
    const repo = makeRepo('case', '[DIFF]\n\tEXTERNAL = /tmp/evil\n');
    expect(gitConfigMayExecutePrograms(repo)).toBe(true);
  });

  it('handles quoted values', () => {
    const repo = makeRepo(
      'quoted',
      '[core]\n\tpager = "delta --paging=never"\n',
    );
    expect(gitConfigMayExecutePrograms(repo)).toBe(true);
  });

  it.each([
    ['[pager]\n\tlog = delta\n', 'pager-cmd-override'],
    ['[diff "drv"]\n\ttextconv = /tmp/evil\n', 'diff-driver-textconv'],
    ['[diff "drv"]\n\tcommand = /tmp/evil\n', 'diff-driver-command'],
    [
      '[credential "https://example.com"]\n\thelper = store\n',
      'credential-url-helper',
    ],
    ['[gpg "ssh"]\n\tprogram = /tmp/evil\n', 'gpg-format-program'],
    [
      '[remote "origin"]\n\tproxy = nc -X 5 -x proxy:1080 %h %p\n',
      'remote-proxy',
    ],
    ['[remote "origin"]\n\tuploadpack = /tmp/evil\n', 'remote-uploadpack'],
    ['[remote "origin"]\n\treceivepack = /tmp/evil\n', 'remote-receivepack'],
    ['[remote "origin"]\n\turl = ext::sh -c evil%% %S %u\n', 'remote-ext-url'],
  ] as Array<[string, string]>)('flags subsection key %s', (config, label) => {
    const repo = makeRepo(label, config);
    expect(gitConfigMayExecutePrograms(repo)).toBe(true);
  });

  it.each([
    ['[diff.evil]\n\tcommand = /tmp/evil\n', 'dot-diff-command'],
    ['[diff.evil]\n\ttextconv = /tmp/evil\n', 'dot-diff-textconv'],
    ['[filter.evil]\n\tclean = /tmp/evil\n', 'dot-filter-clean'],
    ['[gpg.ssh]\n\tprogram = /tmp/evil\n', 'dot-gpg-program'],
    [
      '[remote.origin]\n\turl = .\n\tuploadpack = /tmp/evil\n',
      'dot-remote-uploadpack',
    ],
    ['[pager.log]\n\trun = /tmp/evil\n', 'dot-pager'],
    ['[DIFF.EVIL]\n\tCOMMAND = /tmp/evil\n', 'dot-case'],
  ] as Array<[string, string]>)(
    'flags deprecated dot-form subsection header %s',
    (config, label) => {
      const repo = makeRepo(label, config);
      expect(gitConfigMayExecutePrograms(repo)).toBe(true);
    },
  );

  it('splits dot-form headers at the first dot only', () => {
    // git keeps the remaining dots in the subsection
    // (`[diff.evil.suffix]` === `[diff "evil.suffix"]`); a last-dot split
    // would leave section `diff.evil` and miss the attack.
    const repo = makeRepo(
      'dot-first-dot',
      '[diff.evil.suffix]\n\tcommand = /tmp/evil\n',
    );
    expect(gitConfigMayExecutePrograms(repo)).toBe(true);
  });

  it('does not flag benign dot-form subsections', () => {
    // Old git versions wrote branch/remote sections in the deprecated dot
    // form; they must not start prompting.
    const repo = makeRepo(
      'dot-benign',
      '[branch.main]\n\tremote = origin\n\tmerge = refs/heads/main\n[remote.origin]\n\turl = https://example.com/repo.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n',
    );
    expect(gitConfigMayExecutePrograms(repo)).toBe(false);
  });

  it('does not flag core.fsmonitor booleans (built-in daemon / disabled)', () => {
    const enabled = makeRepo('fsm-true', '[core]\n\tfsmonitor = true\n');
    expect(gitConfigMayExecutePrograms(enabled)).toBe(false);
    const disabled = makeRepo('fsm-false', '[core]\n\tfsmonitor = false\n');
    expect(gitConfigMayExecutePrograms(disabled)).toBe(false);
  });

  it('does not flag boolean core.pager values (no repo-supplied program)', () => {
    const off = makeRepo('pager-false', '[core]\n\tpager = false\n');
    expect(gitConfigMayExecutePrograms(off)).toBe(false);
    const on = makeRepo('pager-true', '[core]\n\tpager = true\n');
    expect(gitConfigMayExecutePrograms(on)).toBe(false);
    const program = makeRepo('pager-prog', '[core]\n\tpager = less -R\n');
    expect(gitConfigMayExecutePrograms(program)).toBe(true);
  });

  it('does not flag empty values or non-executing keys', () => {
    const repo = makeRepo(
      'benign',
      '[diff]\n\texternal =\n[pager]\n\tlog =\n[core]\n\teditor = vim\n[init]\n\tdefaultBranch = main\n',
    );
    expect(gitConfigMayExecutePrograms(repo)).toBe(false);
  });

  it('ignores comments', () => {
    const repo = makeRepo(
      'comments',
      '# diff.external = /tmp/evil\n; pager.log = evil\n[core]\n',
    );
    expect(gitConfigMayExecutePrograms(repo)).toBe(false);
  });

  it('strips comments inside sections (trailing and whole-line)', () => {
    // git strips trailing comments, so the value is the boolean `false` —
    // a probe that kept the comment text would fail the boolean exemption
    // and spuriously confirm every whitelisted command.
    const trailing = makeRepo(
      'inline-comment',
      '[pager]\n\tlog = false # disabled\n',
    );
    expect(gitConfigMayExecutePrograms(trailing)).toBe(false);
    const wholeLine = makeRepo('whole-line-comment', '[pager]\n# log = evil\n');
    expect(gitConfigMayExecutePrograms(wholeLine)).toBe(false);
  });

  it('parses inline `[section] key = value` lines', () => {
    const dirty = makeRepo('inline-dirty', '[diff] external = /tmp/evil\n');
    expect(gitConfigMayExecutePrograms(dirty)).toBe(true);
    const clean = makeRepo('inline-clean', '[core] bare = false\n');
    expect(gitConfigMayExecutePrograms(clean)).toBe(false);
  });

  it('flags core.gitProxy (git:// transport helper)', () => {
    const repo = makeRepo('gitproxy', '[core]\n\tgitProxy = /tmp/evil\n');
    expect(gitConfigMayExecutePrograms(repo)).toBe(true);
  });

  describe('core.hooksPath overrides', () => {
    function writeExecutableHook(hooksDir: string, hook: string): void {
      fs.mkdirSync(hooksDir, { recursive: true });
      const hookPath = path.join(hooksDir, hook);
      fs.writeFileSync(hookPath, '#!/bin/sh\ntouch /tmp/evil\n');
      fs.chmodSync(hookPath, 0o755);
    }

    it('flags relative overrides pointing at executable trigger hooks', () => {
      const repo = makeRepo(
        'hookspath-dirty',
        '[core]\n\thooksPath = .myhooks\n',
      );
      writeExecutableHook(path.join(repo, '.myhooks'), 'post-index-change');
      expect(gitConfigMayExecutePrograms(repo)).toBe(true);
    });

    it('keeps husky-style overrides read-only when no trigger hooks exist', () => {
      // husky / lefthook installs set core.hooksPath in every repo; their
      // hook dirs hold commit-time hooks only, so whitelisted read-only
      // commands must keep their auto-approval.
      const repo = makeRepo('husky', '[core]\n\thooksPath = .husky/_\n');
      const hooksDir = path.join(repo, '.husky', '_');
      fs.mkdirSync(hooksDir, { recursive: true });
      fs.writeFileSync(path.join(hooksDir, 'pre-commit'), '#!/bin/sh\n', {
        mode: 0o755,
      });
      fs.writeFileSync(path.join(hooksDir, 'commit-msg'), '#!/bin/sh\n', {
        mode: 0o755,
      });
      expect(gitConfigMayExecutePrograms(repo)).toBe(false);
    });

    it('resolves relative overrides against the worktree root, not the cwd', () => {
      const repo = makeRepo(
        'hookspath-root',
        '[core]\n\thooksPath = hooks-dir\n',
      );
      writeExecutableHook(path.join(repo, 'hooks-dir'), 'fsmonitor-watchman');
      // Decoy with the same name below the probe's cwd: git never consults
      // it, so its emptiness must not hide the root hit.
      const nested = path.join(repo, 'sub');
      fs.mkdirSync(path.join(nested, 'hooks-dir'), { recursive: true });
      expect(gitConfigMayExecutePrograms(nested)).toBe(true);
    });

    it('flags absolute overrides pointing at executable trigger hooks', () => {
      const external = path.join(root, 'external-hooks');
      writeExecutableHook(external, 'post-index-change');
      const repo = makeRepo(
        'hookspath-abs',
        `[core]\n\thooksPath = ${external}\n`,
      );
      expect(gitConfigMayExecutePrograms(repo)).toBe(true);
    });

    it('expands a leading ~ to the user home', () => {
      writeExecutableHook(path.join(root, 'home-hooks'), 'post-index-change');
      const homedir = vi.spyOn(os, 'homedir').mockReturnValue(root);
      try {
        const repo = makeRepo(
          'hookspath-tilde',
          '[core]\n\thooksPath = ~/home-hooks\n',
        );
        expect(gitConfigMayExecutePrograms(repo)).toBe(true);
      } finally {
        homedir.mockRestore();
      }
    });

    it('does not flag an empty override (git then runs no hooks at all)', () => {
      const repo = makeRepo('hookspath-empty', '[core]\n\thooksPath =\n');
      expect(gitConfigMayExecutePrograms(repo)).toBe(false);
    });

    it('fails closed on undecodable override values', () => {
      const repo = makeRepo(
        'hookspath-bad',
        '[core]\n\thooksPath = "unterminated\n',
      );
      expect(gitConfigMayExecutePrograms(repo)).toBe(true);
    });

    it('fails closed on ~user overrides it cannot resolve', () => {
      const repo = makeRepo(
        'hookspath-user',
        '[core]\n\thooksPath = ~other/hooks\n',
      );
      expect(gitConfigMayExecutePrograms(repo)).toBe(true);
    });

    // fs.accessSync(X_OK) is not meaningful on Windows — every file is
    // "executable" there — so only assert the negative case elsewhere.
    it.skipIf(process.platform === 'win32')(
      'does not flag non-executable trigger hooks under an override',
      () => {
        const repo = makeRepo(
          'hookspath-noexec',
          '[core]\n\thooksPath = .myhooks\n',
        );
        const hooksDir = path.join(repo, '.myhooks');
        fs.mkdirSync(hooksDir, { recursive: true });
        fs.writeFileSync(
          path.join(hooksDir, 'post-index-change'),
          '#!/bin/sh\ntouch /tmp/evil\n',
        );
        fs.chmodSync(path.join(hooksDir, 'post-index-change'), 0o644);
        expect(gitConfigMayExecutePrograms(repo)).toBe(false);
      },
    );
  });

  it('flags executable hooks that read-only commands trigger', () => {
    for (const hook of ['post-index-change', 'fsmonitor-watchman']) {
      const repo = makeRepo(`hook-${hook}`, '');
      const hooksDir = path.join(repo, '.git', 'hooks');
      fs.mkdirSync(hooksDir, { recursive: true });
      const hookPath = path.join(hooksDir, hook);
      fs.writeFileSync(hookPath, '#!/bin/sh\ntouch /tmp/evil\n');
      fs.chmodSync(hookPath, 0o755);
      expect(gitConfigMayExecutePrograms(repo)).toBe(true);
    }
  });

  // fs.accessSync(X_OK) is not meaningful on Windows — every file is
  // "executable" there — so only assert the negative case elsewhere.
  it.skipIf(process.platform === 'win32')(
    'does not flag non-executable or unrelated hooks',
    () => {
      const repo = makeRepo('hook-inactive', '');
      const hooksDir = path.join(repo, '.git', 'hooks');
      fs.mkdirSync(hooksDir, { recursive: true });
      fs.writeFileSync(
        path.join(hooksDir, 'post-index-change'),
        '#!/bin/sh\ntouch /tmp/evil\n',
      );
      fs.chmodSync(path.join(hooksDir, 'post-index-change'), 0o644);
      fs.writeFileSync(
        path.join(hooksDir, 'pre-commit.sample'),
        '#!/bin/sh\n',
        { mode: 0o755 },
      );
      expect(gitConfigMayExecutePrograms(repo)).toBe(false);
    },
  );

  it('flags include/includeIf entries instead of resolving them', () => {
    const inc = makeRepo('include', '[include]\n\tpath = ../other-config\n');
    expect(gitConfigMayExecutePrograms(inc)).toBe(true);
    const incIf = makeRepo(
      'include-if',
      '[includeIf "gitdir:~/src/"]\n\tpath = /tmp/other-config\n',
    );
    expect(gitConfigMayExecutePrograms(incIf)).toBe(true);
  });

  it.each(['clean', 'smudge', 'process'])(
    'flags filter %s programs (git diff triggers them)',
    (key) => {
      const repo = makeRepo(
        `filter-${key}`,
        `[filter "evil"]\n\t${key} = /tmp/evil\n`,
      );
      expect(gitConfigMayExecutePrograms(repo)).toBe(true);
    },
  );

  it('flags ext:: url.<base>.insteadOf rewrite targets', () => {
    const repo = makeRepo(
      'url-insteadof',
      '[url "ext::sh -c evil"]\n\tinsteadOf = https://example.com/\n',
    );
    expect(gitConfigMayExecutePrograms(repo)).toBe(true);
  });

  it('flags ext:: url rewrites with an EMPTY insteadOf (match-all prefix)', () => {
    // git treats an empty insteadOf as matching every URL.
    const repo = makeRepo(
      'empty-insteadof',
      '[url "ext::sh -c evil"]\n\tinsteadOf =\n',
    );
    expect(gitConfigMayExecutePrograms(repo)).toBe(true);
  });

  it('flags protocol.<name>.allow lifts of the ext:: transport block', () => {
    const always = makeRepo(
      'proto-always',
      '[protocol "ext"]\n\tallow = always\n',
    );
    expect(gitConfigMayExecutePrograms(always)).toBe(true);
    const user = makeRepo('proto-user', '[protocol]\n\tallow = user\n');
    expect(gitConfigMayExecutePrograms(user)).toBe(true);
    const undecodable = makeRepo(
      'proto-undecodable',
      '[protocol "ext"]\n\tallow = "unterminated\n',
    );
    expect(gitConfigMayExecutePrograms(undecodable)).toBe(true);
    const never = makeRepo(
      'proto-never',
      '[protocol "ext"]\n\tallow = never\n',
    );
    expect(gitConfigMayExecutePrograms(never)).toBe(false);
  });

  it('does not flag boolean pager overrides', () => {
    const repo = makeRepo(
      'pager-bool',
      '[pager]\n\tlog = false\n\tdiff = true\n',
    );
    expect(gitConfigMayExecutePrograms(repo)).toBe(false);
  });

  it('fails closed on implausibly large config files', () => {
    const repo = makeRepo('huge', '');
    fs.writeFileSync(
      path.join(repo, '.git', 'config'),
      `[core]\n\tbare = false\n# ${'x'.repeat(1 << 20)}\n`,
    );
    expect(gitConfigMayExecutePrograms(repo)).toBe(true);
  });

  it('joins continued lines before checking values', () => {
    // git joins values across a backslash continuation; the dirty evidence
    // only exists AFTER the join.
    const dirty = makeRepo(
      'cont-ext',
      '[remote "origin"]\n\turl = ext\\\n::sh -c evil %S %u\n',
    );
    expect(gitConfigMayExecutePrograms(dirty)).toBe(true);
    const clean = makeRepo('cont-bool', '[pager]\n\tlog = fal\\\nse\n');
    expect(gitConfigMayExecutePrograms(clean)).toBe(false);
  });

  it('reads config.worktree of the main checkout (extensions.worktreeConfig)', () => {
    const repo = makeRepo(
      'wtcfg',
      '[extensions]\n\tworktreeConfig = false # ignored\\\n\tworktreeConfig = 0x\\\n1k # enabled\n',
    );
    fs.writeFileSync(
      path.join(repo, '.git', 'config.worktree'),
      '[diff]\n\texternal = /tmp/evil\n',
    );
    expect(gitConfigMayExecutePrograms(repo)).toBe(true);
  });

  it('ignores config.worktree unless worktreeConfig is enabled', () => {
    const repo = makeRepo(
      'disabled-worktree-config',
      '[extensions]\n\tworktreeConfig = 0x0k\n',
    );
    fs.writeFileSync(
      path.join(repo, '.git', 'config.worktree'),
      '[diff]\n\texternal = /tmp/evil\n',
    );
    expect(gitConfigMayExecutePrograms(repo)).toBe(false);
  });

  describe('linked worktrees and submodules', () => {
    it('reads config.worktree and the common config via the .git file', () => {
      const main = makeRepo(
        'main-repo',
        '[core]\n\tbare = false\n[extensions]\n\tworktreeConfig = true\n',
      );
      const commonGitDir = path.join(main, '.git');

      // Linked worktree: <wt>/.git is a file pointing into
      // <main>/.git/worktrees/<name>.
      const wtGitDir = path.join(commonGitDir, 'worktrees', 'wt');
      fs.mkdirSync(wtGitDir, { recursive: true });
      fs.writeFileSync(path.join(wtGitDir, 'commondir'), '../..\n');
      const wt = path.join(root, 'wt-clean');
      fs.mkdirSync(wt, { recursive: true });
      fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${wtGitDir}\n`);
      expect(gitConfigMayExecutePrograms(wt)).toBe(false);

      // Planted key in the per-worktree config.
      fs.writeFileSync(
        path.join(wtGitDir, 'config.worktree'),
        '[core]\n\tpager = /tmp/evil\n',
      );
      expect(gitConfigMayExecutePrograms(wt)).toBe(true);

      // Planted key in the common config instead.
      fs.rmSync(path.join(wtGitDir, 'config.worktree'));
      fs.writeFileSync(
        path.join(commonGitDir, 'config'),
        '[diff]\n\texternal = /tmp/evil\n',
      );
      expect(gitConfigMayExecutePrograms(wt)).toBe(true);
    });

    it('reads the gitdir target config for submodule-style .git files', () => {
      const store = path.join(root, 'store', 'modules', 'sub');
      fs.mkdirSync(store, { recursive: true });
      fs.writeFileSync(
        path.join(store, 'config'),
        '[core]\n\tfsmonitor = /tmp/evil\n',
      );
      const sub = path.join(root, 'sub-checkout');
      fs.mkdirSync(sub, { recursive: true });
      // Real git writes RELATIVE pointers for submodules; resolution is
      // against the pointer's containing directory.
      fs.writeFileSync(
        path.join(sub, '.git'),
        `gitdir: ${path.relative(sub, store)}\n`,
      );
      expect(gitConfigMayExecutePrograms(sub)).toBe(true);
    });
  });

  describe('submodule storage dirs', () => {
    // `git status` / `git diff` in a superproject run child git processes
    // inside each submodule; the children read the config stored under
    // `.git/modules/<name>`. The probe must therefore downgrade the
    // superproject when ANY storage dir can execute programs.

    function makeModuleDir(
      superRepo: string,
      relPath: string,
      config = '',
    ): string {
      const moduleDir = path.join(
        superRepo,
        '.git',
        'modules',
        ...relPath.split('/'),
      );
      fs.mkdirSync(path.join(moduleDir, 'objects'), { recursive: true });
      fs.mkdirSync(path.join(moduleDir, 'refs'), { recursive: true });
      fs.writeFileSync(path.join(moduleDir, 'HEAD'), 'ref: refs/heads/main\n');
      if (config) {
        fs.writeFileSync(path.join(moduleDir, 'config'), config);
      }
      return moduleDir;
    }

    it('keeps a superproject clean when submodule configs are clean', () => {
      const superRepo = makeRepo('super-clean', '[core]\n\tbare = false\n');
      makeModuleDir(superRepo, 'sub', '[core]\n\tworktree = ../../../sub\n');
      expect(gitConfigMayExecutePrograms(superRepo)).toBe(false);
    });

    it('flags executing keys planted in a submodule config', () => {
      const superRepo = makeRepo('super-fsmon', '[core]\n\tbare = false\n');
      makeModuleDir(superRepo, 'sub', '[core]\n\tfsmonitor = /tmp/evil\n');
      expect(gitConfigMayExecutePrograms(superRepo)).toBe(true);
      // The downgrade also applies from a nested cwd in the superproject.
      const nested = path.join(superRepo, 'src', 'deep');
      fs.mkdirSync(nested, { recursive: true });
      expect(gitConfigMayExecutePrograms(nested)).toBe(true);
    });

    it('flags nested submodule storage dirs', () => {
      const superRepo = makeRepo('super-nested', '');
      makeModuleDir(superRepo, 'a', '[core]\n');
      makeModuleDir(
        superRepo,
        'a/modules/b',
        '[diff]\n\texternal = /tmp/evil\n',
      );
      expect(gitConfigMayExecutePrograms(superRepo)).toBe(true);
    });

    it('flags executable trigger hooks in a submodule hooks dir', () => {
      const superRepo = makeRepo('super-hook', '');
      const moduleDir = makeModuleDir(superRepo, 'sub', '[core]\n');
      const hooksDir = path.join(moduleDir, 'hooks');
      fs.mkdirSync(hooksDir, { recursive: true });
      const hookPath = path.join(hooksDir, 'post-index-change');
      fs.writeFileSync(hookPath, '#!/bin/sh\ntouch /tmp/evil\n');
      fs.chmodSync(hookPath, 0o755);
      expect(gitConfigMayExecutePrograms(superRepo)).toBe(true);
    });

    // fs.accessSync(X_OK) is not meaningful on Windows — every file is
    // "executable" there — so only assert the negative case elsewhere.
    it.skipIf(process.platform === 'win32')(
      'does not flag non-executable submodule hooks',
      () => {
        const superRepo = makeRepo('super-hook-noexec', '');
        const moduleDir = makeModuleDir(superRepo, 'sub', '[core]\n');
        const hooksDir = path.join(moduleDir, 'hooks');
        fs.mkdirSync(hooksDir, { recursive: true });
        fs.writeFileSync(
          path.join(hooksDir, 'post-index-change'),
          '#!/bin/sh\n',
        );
        fs.chmodSync(path.join(hooksDir, 'post-index-change'), 0o644);
        expect(gitConfigMayExecutePrograms(superRepo)).toBe(false);
      },
    );

    it('resolves submodule hooksPath overrides via core.worktree', () => {
      // git anchors a relative hooksPath at the submodule WORKTREE root,
      // which the stored config records as core.worktree (relative to the
      // storage dir).
      const superRepo = makeRepo('super-hookspath', '');
      fs.mkdirSync(path.join(superRepo, 'sub'), { recursive: true });
      makeModuleDir(
        superRepo,
        'sub',
        '[core]\n\tworktree = ../../../sub\n\thooksPath = ../hooks-dir\n',
      );
      const hooksDir = path.join(superRepo, 'hooks-dir');
      fs.mkdirSync(hooksDir, { recursive: true });
      const hookPath = path.join(hooksDir, 'fsmonitor-watchman');
      fs.writeFileSync(hookPath, '#!/bin/sh\ntouch /tmp/evil\n');
      fs.chmodSync(hookPath, 0o755);
      expect(gitConfigMayExecutePrograms(superRepo)).toBe(true);
    });

    it('keeps submodule hooksPath overrides read-only without trigger hooks', () => {
      const superRepo = makeRepo('super-hookspath-clean', '');
      fs.mkdirSync(path.join(superRepo, 'sub'), { recursive: true });
      makeModuleDir(
        superRepo,
        'sub',
        '[core]\n\tworktree = ../../../sub\n\thooksPath = ../hooks-dir\n',
      );
      const hooksDir = path.join(superRepo, 'hooks-dir');
      fs.mkdirSync(hooksDir, { recursive: true });
      fs.writeFileSync(path.join(hooksDir, 'pre-commit'), '#!/bin/sh\n', {
        mode: 0o755,
      });
      expect(gitConfigMayExecutePrograms(superRepo)).toBe(false);
    });

    it('anchors submodule hooksPath at the LAST core.worktree (git semantics)', () => {
      const superRepo = makeRepo('super-worktree-last', '');
      fs.mkdirSync(path.join(superRepo, 'a', 'real'), { recursive: true });
      fs.mkdirSync(path.join(superRepo, 'b', 'decoy'), { recursive: true });
      makeModuleDir(
        superRepo,
        'sub',
        '[core]\n\tworktree = ../../../b/decoy\n\tworktree = ../../../a/real\n\thooksPath = ../hooks\n',
      );
      // Executable trigger hook only under the LAST worktree's resolution.
      const hooksDir = path.join(superRepo, 'a', 'hooks');
      fs.mkdirSync(hooksDir, { recursive: true });
      const hookPath = path.join(hooksDir, 'post-index-change');
      fs.writeFileSync(hookPath, '#!/bin/sh\ntouch /tmp/evil\n');
      fs.chmodSync(hookPath, 0o755);
      expect(gitConfigMayExecutePrograms(superRepo)).toBe(true);
    });

    it('fails closed on relative submodule hooksPath without core.worktree', () => {
      // Without a recorded worktree root the redirect target cannot be
      // resolved — confirm instead of guessing.
      const superRepo = makeRepo('super-hookspath-nowt', '');
      makeModuleDir(superRepo, 'sub', '[core]\n\thooksPath = ../hooks-dir\n');
      expect(gitConfigMayExecutePrograms(superRepo)).toBe(true);
    });

    it('probes absolute submodule hooksPath overrides', () => {
      const superRepo = makeRepo('super-hookspath-abs', '');
      const external = path.join(root, 'sub-external-hooks');
      fs.mkdirSync(external, { recursive: true });
      const hookPath = path.join(external, 'post-index-change');
      fs.writeFileSync(hookPath, '#!/bin/sh\ntouch /tmp/evil\n');
      fs.chmodSync(hookPath, 0o755);
      makeModuleDir(superRepo, 'sub', `[core]\n\thooksPath = ${external}\n`);
      expect(gitConfigMayExecutePrograms(superRepo)).toBe(true);
    });

    it('ignores modules entries that are not git directories', () => {
      // git cannot run a child process in a directory it does not accept
      // as a git directory, so its contents never execute.
      const superRepo = makeRepo('super-notgit', '');
      const stray = path.join(superRepo, '.git', 'modules', 'stray');
      fs.mkdirSync(stray, { recursive: true });
      fs.writeFileSync(
        path.join(stray, 'config'),
        '[diff]\n\texternal = /tmp/evil\n',
      );
      expect(gitConfigMayExecutePrograms(superRepo)).toBe(false);
    });

    it('fails closed when the submodule budget is exhausted', () => {
      // All configs CLEAN: discovery would return false, so the `true`
      // verdict uniquely pins the budget path (a raised/removed cap would
      // otherwise walk every dir and read clean configs undetected).
      const superRepo = makeRepo('super-budget', '');
      for (let i = 0; i <= 256; i++) {
        makeModuleDir(superRepo, `sub-${i}`, '[core]\n');
      }
      expect(gitConfigMayExecutePrograms(superRepo)).toBe(true);
    });
  });

  it('fails closed when the config exists but cannot be read', () => {
    const repo = path.join(root, 'unreadable');
    fs.mkdirSync(path.join(repo, '.git', 'config'), { recursive: true });
    // `.git/config` is a directory → readFileSync throws EISDIR.
    expect(gitConfigMayExecutePrograms(repo)).toBe(true);
  });

  // chmod(0o000) does not block reads on Windows (only the owner-write
  // bit is honored) or for root (DAC bypass), so the simulation only
  // means EACCES elsewhere.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'fails closed when the .git pointer file cannot be read',
    () => {
      const repo = path.join(root, 'bad-pointer');
      fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
      fs.rmdirSync(path.join(repo, '.git'));
      fs.mkdirSync(path.join(repo, '.git.d'), { recursive: true });
      fs.writeFileSync(path.join(repo, '.git'), 'gitdir: .git.d\n');
      fs.chmodSync(path.join(repo, '.git'), 0o000);
      try {
        expect(gitConfigMayExecutePrograms(repo)).toBe(true);
      } finally {
        fs.chmodSync(path.join(repo, '.git'), 0o644);
      }
    },
  );

  it('fails closed on an unparseable .git pointer file', () => {
    const repo = path.join(root, 'garbage-pointer');
    fs.mkdirSync(repo, { recursive: true });
    fs.writeFileSync(path.join(repo, '.git'), 'not a gitdir pointer\n');
    expect(gitConfigMayExecutePrograms(repo)).toBe(true);
  });

  it('flags partially quoted ext:: url values (git concatenates segments)', () => {
    const trailing = makeRepo(
      'ext-partial-quote',
      '[remote "origin"]\n\turl = "ext::/tmp/evil.sh" x\n',
    );
    expect(gitConfigMayExecutePrograms(trailing)).toBe(true);
    const split = makeRepo(
      'ext-split-quotes',
      '[remote "origin"]\n\turl = "ext""::/tmp/evil.sh"\n',
    );
    expect(gitConfigMayExecutePrograms(split)).toBe(true);
  });

  it('flags url.<base> subsections whose ext:: prefix is escape-encoded', () => {
    const repo = makeRepo(
      'url-subsection-escape',
      '[url "e\\xt::/tmp/evil.sh "]\n\tinsteadOf = https://example.com/\n',
    );
    expect(gitConfigMayExecutePrograms(repo)).toBe(true);
  });

  it('probes through a symlinked workspace directory', () => {
    if (process.platform === 'win32') return; // symlink perms differ
    const repo = makeRepo('sym-repo', '[diff]\n\texternal = /tmp/evil\n');
    // Point the link at a NESTED path: without the realpathSync in the
    // probe the walk would climb the link's own ancestors, never find the
    // repo, and fail open.
    const nested = path.join(repo, 'src');
    fs.mkdirSync(nested);
    const link = path.join(root, 'ws-link');
    fs.symlinkSync(nested, link);
    expect(gitConfigMayExecutePrograms(link)).toBe(true);
  });

  it('fails closed when the repo search depth is exhausted', () => {
    // A CLEAN config: discovery would return false, so the `true` verdict
    // uniquely pins the exhaustion path (a raised/removed depth cap would
    // otherwise reach the repo and read the clean config undetected).
    // Single-char segments keep 70 levels under Windows MAX_PATH.
    const repo = makeRepo('deep-repo', '[core]\n\tbare = false\n');
    let deep = repo;
    for (let i = 0; i < 70; i++) {
      deep = path.join(deep, 'd');
    }
    fs.mkdirSync(deep, { recursive: true });
    expect(gitConfigMayExecutePrograms(deep)).toBe(true);
  });

  it('probes the target of a .git/commondir redirect (main checkout)', () => {
    // git honors a `.git/commondir` file and reads the pointed-to
    // directory's config as the common config — the probe must too.
    const evilCommon = makeRepo(
      'common-evil',
      '[core]\n\tfsmonitor = /tmp/evil\n',
    );
    const repo = makeRepo('redirected', '');
    fs.writeFileSync(
      path.join(repo, '.git', 'commondir'),
      `${path.join(evilCommon, '.git')}\n`,
    );
    expect(gitConfigMayExecutePrograms(repo)).toBe(true);

    // Clean redirect target keeps the repo clean.
    const cleanCommon = makeRepo('common-clean', '[core]\n\tbare = false\n');
    fs.writeFileSync(
      path.join(repo, '.git', 'commondir'),
      `${path.join(cleanCommon, '.git')}\n`,
    );
    expect(gitConfigMayExecutePrograms(repo)).toBe(false);
  });

  it('probes HEAD+commondir git directories git itself accepts', () => {
    // A HEAD-plus-commondir pair is a git directory to git even without
    // objects/refs (linked-worktree admin dirs — and attacker-shaped
    // stand-ins with a config.worktree).
    const stand = path.join(root, 'stand-head-commondir');
    fs.mkdirSync(stand, { recursive: true });
    fs.writeFileSync(path.join(stand, 'HEAD'), 'ref: refs/heads/main\n');
    const target = makeRepo(
      'head-commondir-target',
      '[diff]\n\texternal = /tmp/evil\n',
    );
    fs.writeFileSync(
      path.join(stand, 'commondir'),
      `${path.join(target, '.git')}\n`,
    );
    expect(gitConfigMayExecutePrograms(stand)).toBe(true);
  });

  it('reads the config of a git directory the cwd stands in', () => {
    // Submodule storage layout: `<repo>/.git/modules/<name>` is itself a
    // git directory; git reads ITS config while standing in it, not the
    // superproject's.
    const moduleGitDir = path.join(root, 'super', '.git', 'modules', 'sub');
    fs.mkdirSync(path.join(moduleGitDir, 'objects'), { recursive: true });
    fs.mkdirSync(path.join(moduleGitDir, 'refs'), { recursive: true });
    fs.writeFileSync(path.join(moduleGitDir, 'HEAD'), 'ref: refs/heads/main\n');
    fs.writeFileSync(path.join(moduleGitDir, 'config'), '[core]\n');
    // Clean module config, clean superproject config.
    const superConfig = path.join(root, 'super', '.git', 'config');
    fs.writeFileSync(superConfig, '[core]\n');
    expect(gitConfigMayExecutePrograms(moduleGitDir)).toBe(false);

    fs.writeFileSync(
      path.join(moduleGitDir, 'config'),
      '[diff]\n\texternal = /tmp/evil\n',
    );
    expect(gitConfigMayExecutePrograms(moduleGitDir)).toBe(true);
  });

  it('probes the commondir target of a standing git directory', () => {
    // cwd stands in a HEAD+objects+refs dir whose commondir points at a
    // NON-ANCESTOR git dir — the walk-up never reaches the target, only
    // the commondir read does.
    const target = makeRepo(
      'standing-commondir-target',
      '[diff]\n\texternal = /tmp/evil\n',
    );
    const stand = path.join(root, 'standing-gitdir');
    fs.mkdirSync(path.join(stand, 'objects'), { recursive: true });
    fs.mkdirSync(path.join(stand, 'refs'), { recursive: true });
    fs.writeFileSync(path.join(stand, 'HEAD'), 'ref: refs/heads/main\n');
    fs.writeFileSync(path.join(stand, 'config'), '[core]\n');
    fs.writeFileSync(
      path.join(stand, 'commondir'),
      `${path.join(target, '.git')}\n`,
    );
    expect(gitConfigMayExecutePrograms(stand)).toBe(true);

    // Same git dir without a commondir stays clean.
    fs.rmSync(path.join(stand, 'commondir'));
    expect(gitConfigMayExecutePrograms(stand)).toBe(false);
  });

  it('fails closed on section headers it cannot parse', () => {
    // `]` inside a quoted subsection is valid to git but opaque to the
    // minimal parser — must not silently drop the entries below it.
    const repo = makeRepo(
      'bracket-subsection',
      '[diff "a]b"]\n\ttextconv = /tmp/evil\n',
    );
    expect(gitConfigMayExecutePrograms(repo)).toBe(true);
  });
});
