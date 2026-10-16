/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  isDestructiveCommand,
  registerSessionCommit,
  clearSessionCommits,
} from './destructive-commands.js';

beforeEach(() => {
  clearSessionCommits();
});

const UNVERIFIABLE = 'could not verify';

async function reasonFor(command: string, cwd?: string) {
  const result = await isDestructiveCommand(command, cwd);
  if (result) expect(result.blocked).toBe(true);
  return result?.reason ?? null;
}

describe('isDestructiveCommand — text that is not executed', () => {
  it.each([
    `printf '%s\\n' 'git reset --hard'`,
    'printf ok # git reset --hard',
    `echo 'git reset --hard'`,
    'echo git reset --hard',
    `grep -rn 'terraform destroy' docs`,
    `rg 'git stash drop'`,
    `git commit -m 'docs: explain git reset --hard'`,
    `git log --grep 'git checkout -- .'`,
    `cat <<'EOF' > notes.md\ngit reset --hard\nEOF`,
    `NOTE='git clean -fd' && echo "$NOTE"`,
    `[ "$x" = 'terraform destroy' ]`,
  ])('allows %j', async (command) => {
    expect(await reasonFor(command)).toBeNull();
  });
});

describe('isDestructiveCommand — executed git and IaC operations', () => {
  it.each<[string, string]>([
    ['git reset --hard', 'git reset --hard'],
    ['git reset --hard HEAD~1', 'git reset --hard'],
    // Git accepts any unambiguous prefix of a long option.
    ['git reset --har', 'git reset --hard'],
    ['git -C /repo reset --hard', 'git reset --hard'],
    ['git -C /a -C b -c core.pager=less reset --hard', 'git reset --hard'],
    ['git -c advice.detachedHead=false reset --hard', 'git reset --hard'],
    ['git --git-dir=/x/.git --work-tree=/x reset --hard', 'git reset --hard'],
    ['git checkout -- .', 'git checkout -- .'],
    ['git checkout .', 'git checkout -- .'],
    ['git checkout HEAD -- ./', 'git checkout -- .'],
    ['git checkout -q -- ../..', 'git checkout -- .'],
    ['git clean -fd', 'git clean -f'],
    ['git clean -d -f', 'git clean -f'],
    ['git clean -xdf', 'git clean -f'],
    ['git clean --force', 'git clean -f'],
    ['git stash drop', 'git stash drop'],
    ['git stash drop stash@{1}', 'git stash drop'],
    ['/usr/bin/git reset --hard', 'git reset --hard'],
    ['terraform destroy', 'terraform destroy'],
    ['terraform -chdir=infra destroy -auto-approve', 'terraform destroy'],
    ['pulumi -C infra destroy --yes', 'pulumi destroy'],
    ['cdk --profile prod destroy MyStack', 'cdk destroy'],
    ['npx cdk destroy', 'cdk destroy'],
  ])('blocks %j as %s', async (command, label) => {
    expect(await reasonFor(command)).toContain(`"${label}"`);
  });

  it('names destructive git and infrastructure commands differently', async () => {
    expect(await reasonFor('git stash drop')).toBe(
      'Blocked destructive git command: "git stash drop".',
    );
    expect(await reasonFor('cdk destroy')).toBe(
      'Blocked infrastructure destroy command: "cdk destroy".',
    );
  });

  it.each([
    'git status',
    'git reset --soft HEAD~1',
    'git reset HEAD~1',
    'git checkout feature-branch',
    // A single file or directory is not the whole tree.
    'git checkout -- ./src',
    'git checkout .gitignore',
    // A brace without a comma is not expanded.
    'git checkout HEAD@{1} -- src',
    // `-b` consumes `.x` as the new branch name.
    'git checkout -b .x',
    // A dry run wins over --force and deletes nothing.
    'git clean -n -f',
    'git clean --dry-run -fd',
    // `-e` consumes `-f` as its exclude pattern.
    'git clean -e -f',
    'git stash',
    'git stash pop',
    'git stash list',
    // The message value is not an option.
    'git commit -m --amend',
    'git commit -m "fix" -- ./',
    'git -C /repo reset -- --hard',
    'terraform plan -out destroy',
    'terraform apply',
    'pulumi stack rm destroy',
    'cdk deploy',
    'npm install',
    'command -v git',
  ])('allows %j', async (command) => {
    expect(await reasonFor(command)).toBeNull();
  });
});

describe('isDestructiveCommand — wrappers and shell structure', () => {
  it.each([
    `bash -c 'git reset --hard'`,
    `bash -o pipefail -c 'git reset --hard'`,
    `sh -lc "git -C /repo reset --hard"`,
    `sh -c "bash -c 'git reset --hard'"`,
    `env FOO=1 git reset --hard`,
    `command git reset --hard`,
    `sudo -u build git reset --hard`,
    `timeout 30 git reset --hard`,
    `xargs git reset --hard`,
    `git status && git reset --hard`,
    `git status\ngit reset --hard`,
    `git reset --hard 2>/dev/null | tail -1`,
    `(git reset --hard)`,
    `f() { git reset --hard; }`,
    `if true; then git reset --hard; fi`,
    `echo "$(git reset --hard)"`,
    'echo `git reset --hard`',
    `cat <<EOF\n$(git reset --hard)\nEOF`,
    `bash <<'EOF'\ngit reset --hard\nEOF`,
    `bash <<< 'git reset --hard'`,
    `eval "git reset --hard"`,
    `git -c alias.x=status submodule foreach 'git reset --hard'`,
    `cmd /c "git reset --hard"`,
    `g"it" reset --hard`,
    'g\\it reset --hard',
  ])('blocks %j', async (command) => {
    expect(await reasonFor(command)).toContain('"git reset --hard"');
  });

  it('does not treat a wrapper option value as the program', async () => {
    expect(await reasonFor('bash -o pipefail -c "git status"')).toBeNull();
    expect(await reasonFor('timeout 30 npm test')).toBeNull();
  });
});

describe('isDestructiveCommand — commands it cannot verify', () => {
  it.each([
    // The program, its arguments or the script only exist at run time.
    '$GIT reset --hard',
    'git reset $MODE',
    'git checkout "$TARGET"',
    // Brace expansion yields `.` among other words.
    'git checkout {.,src}',
    'git stash "$ACTION"',
    'terraform "$COMMAND"',
    `bash -c "git reset $MODE"`,
    `echo 'git reset --hard' | bash`,
    `git -c alias.nuke='!git reset --hard' nuke`,
    // The parser cannot read these.
    `case "$1" in x) git reset --hard ;; esac`,
    `echo 'git reset --hard`,
  ])('blocks %j', async (command) => {
    expect(await reasonFor(command)).toContain(UNVERIFIABLE);
  });

  it.each([
    'echo $HOME',
    '$EDITOR notes.md',
    `case "$1" in x) npm test ;; esac`,
    `echo 'npm test' | bash`,
    // The shell reads its program from the here-string, not from the pipe.
    `bash <<< 'git status' | cat`,
    'git commit -m "$(cat msg.txt)"',
    'git commit --message="$MSG"',
    'git checkout -b "feature/$NAME"',
  ])('allows %j, which cannot reach a protected operation', async (command) => {
    expect(await reasonFor(command)).toBeNull();
  });
});

describe('isDestructiveCommand — git commit --amend', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  /** A repo with one commit; registers that commit when `own` is set. */
  function makeRepo(parent: string, name: string, own: boolean): string {
    const dir = path.join(parent, name);
    fs.mkdirSync(dir);
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: dir, encoding: 'utf-8' }).trim();
    git('init', '-q');
    git(
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      name,
    );
    if (own) registerSessionCommit(git('rev-parse', 'HEAD'));
    return dir;
  }

  function makeRepos() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'amend-guard-'));
    tmpDirs.push(root);
    return {
      root,
      own: makeRepo(root, 'own', true),
      other: makeRepo(root, 'other', false),
    };
  }

  it('allows amending a commit the agent made in this session', async () => {
    const { own } = makeRepos();
    expect(await reasonFor('git commit --amend --no-edit', own)).toBeNull();
    expect(
      await reasonFor(`bash -c 'git commit -m "msg" --amend'`, own),
    ).toBeNull();
    // Only a setting's value can run a command, not its name.
    expect(
      await reasonFor('git -c commit.gpgsign=false commit --amend', own),
    ).toBeNull();
  });

  it('resolves git -C against the command directory', async () => {
    const { root, own, other } = makeRepos();
    expect(await reasonFor('git -C own commit --amend', root)).toBeNull();
    expect(
      await reasonFor(`git -C ${other} commit --amend --no-edit`, own),
    ).toContain('git commit --amend');
  });

  it.each([
    [
      'another repository',
      (dirs: Repos) => `git -C ${dirs.other} commit --amend`,
    ],
    [
      'a directory change',
      (dirs: Repos) => `cd ${dirs.own} && git commit --amend`,
    ],
    [
      'a repository variable',
      (dirs: Repos) => `GIT_DIR=${dirs.other}/.git git commit --amend`,
    ],
    ['a wrapper', () => 'env git commit --amend'],
    ['a run-time directory', () => 'git -C "$REPO" commit --amend'],
    ['an option with unknown effect', () => 'git --bare commit --amend'],
  ])('blocks an amend whose target goes through %s', async (_label, build) => {
    const dirs = makeRepos();
    expect(await reasonFor(build(dirs), dirs.own)).toContain(
      'could not be verified as one the agent made in this session',
    );
  });

  it('never falls back to the process directory', async () => {
    registerSessionCommit(
      execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf-8' }),
    );
    expect(await reasonFor('git commit --amend')).toContain(
      'git commit --amend',
    );
  });
});

type Repos = { root: string; own: string; other: string };
