/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
    [
      '[credential "https://example.com"]\n\thelper = store\n',
      'credential-url-helper',
    ],
    ['[gpg "ssh"]\n\tprogram = /tmp/evil\n', 'gpg-format-program'],
    [
      '[remote "origin"]\n\tproxy = nc -X 5 -x proxy:1080 %h %p\n',
      'remote-proxy',
    ],
    ['[remote "origin"]\n\turl = ext::sh -c evil%% %S %u\n', 'remote-ext-url'],
  ] as Array<[string, string]>)('flags subsection key %s', (config, label) => {
    const repo = makeRepo(label, config);
    expect(gitConfigMayExecutePrograms(repo)).toBe(true);
  });

  it('does not flag core.fsmonitor booleans (built-in daemon / disabled)', () => {
    const enabled = makeRepo('fsm-true', '[core]\n\tfsmonitor = true\n');
    expect(gitConfigMayExecutePrograms(enabled)).toBe(false);
    const disabled = makeRepo('fsm-false', '[core]\n\tfsmonitor = false\n');
    expect(gitConfigMayExecutePrograms(disabled)).toBe(false);
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

  it('flags include/includeIf entries instead of resolving them', () => {
    const inc = makeRepo('include', '[include]\n\tpath = ../other-config\n');
    expect(gitConfigMayExecutePrograms(inc)).toBe(true);
    const incIf = makeRepo(
      'include-if',
      '[includeIf "gitdir:~/src/"]\n\tpath = /tmp/other-config\n',
    );
    expect(gitConfigMayExecutePrograms(incIf)).toBe(true);
  });

  it('flags filter clean/smudge/process programs (git diff triggers them)', () => {
    const repo = makeRepo('filter', '[filter "evil"]\n\tclean = /tmp/evil\n');
    expect(gitConfigMayExecutePrograms(repo)).toBe(true);
  });

  it('flags ext:: url.<base>.insteadOf rewrite targets', () => {
    const repo = makeRepo(
      'url-insteadof',
      '[url "ext::sh -c evil"]\n\tinsteadOf = https://example.com/\n',
    );
    expect(gitConfigMayExecutePrograms(repo)).toBe(true);
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
      fs.writeFileSync(path.join(sub, '.git'), `gitdir: ${store}\n`);
      expect(gitConfigMayExecutePrograms(sub)).toBe(true);
    });
  });

  it('fails closed when the config exists but cannot be read', () => {
    const repo = path.join(root, 'unreadable');
    fs.mkdirSync(path.join(repo, '.git', 'config'), { recursive: true });
    // `.git/config` is a directory → readFileSync throws EISDIR.
    expect(gitConfigMayExecutePrograms(repo)).toBe(true);
  });

  it('fails closed when the .git pointer file cannot be read', () => {
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
  });

  it('fails closed on an unparseable .git pointer file', () => {
    const repo = path.join(root, 'garbage-pointer');
    fs.mkdirSync(repo, { recursive: true });
    fs.writeFileSync(path.join(repo, '.git'), 'not a gitdir pointer\n');
    expect(gitConfigMayExecutePrograms(repo)).toBe(true);
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
