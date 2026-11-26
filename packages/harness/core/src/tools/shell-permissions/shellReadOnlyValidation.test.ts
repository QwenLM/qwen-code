/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach } from 'vitest';
import { scanShellShape } from './shellCommandAnalysis.js';
import {
  ENV_DISABLE_READONLY_SHELL_AUTO_ALLOW,
  checkReadOnlyShellCommand,
} from './shellReadOnlyValidation.js';

// ============================================================================
// Helper
// ============================================================================

function expectReadOnly(command: string) {
  const result = checkReadOnlyShellCommand(command);
  expect(result.readonly).toBe(true);
}

function expectNotReadOnly(command: string) {
  const result = checkReadOnlyShellCommand(command);
  expect(result.readonly).toBe(false);
}

// ============================================================================
// Tests
// ============================================================================

describe('checkReadOnlyShellCommand', () => {
  afterEach(() => {
    delete process.env[ENV_DISABLE_READONLY_SHELL_AUTO_ALLOW];
  });

  describe('basic read-only commands', () => {
    it('allows pwd', () => expectReadOnly('pwd'));
    it('allows whoami', () => expectReadOnly('whoami'));
    it('allows ls', () => expectReadOnly('ls'));
    it('allows ls -la', () => expectReadOnly('ls -la'));
    it('allows ls --color=auto', () => expectReadOnly('ls --color=auto'));
    it('allows ls packages', () => expectReadOnly('ls packages'));
    it('allows cat package.json', () => expectReadOnly('cat package.json'));
    it('allows head -n 20 file', () => expectReadOnly('head -n 20 file'));
    it('allows tail -n 100 file', () => expectReadOnly('tail -n 100 file'));
    it('allows wc -l file', () => expectReadOnly('wc -l file'));
    it('allows stat file', () => expectReadOnly('stat file'));
    it('allows file dist/app', () => expectReadOnly('file dist/app'));
    it('allows which node', () => expectReadOnly('which node'));
    it('allows type npm', () => expectReadOnly('type npm'));
    it('allows uname -a', () => expectReadOnly('uname -a'));
    it('allows id', () => expectReadOnly('id'));
    it('allows df -h', () => expectReadOnly('df -h'));
    it('allows du -sh src', () => expectReadOnly('du -sh src'));
    it('allows free -m', () => expectReadOnly('free -m'));
    it('allows basename /path/to/file', () =>
      expectReadOnly('basename /path/to/file'));
    it('allows dirname /path/to/file', () =>
      expectReadOnly('dirname /path/to/file'));
    it('allows realpath ./file', () => expectReadOnly('realpath ./file'));
    it('allows readlink -f ./file', () => expectReadOnly('readlink -f ./file'));
    it('allows sort file', () => expectReadOnly('sort file'));
    it('allows uniq file', () => expectReadOnly('uniq file'));
    it('allows cut -d: -f1 file', () => expectReadOnly('cut -d: -f1 file'));
  });

  describe('git read-only subcommands', () => {
    it('allows git status', () => expectReadOnly('git status'));
    it('allows git status --short', () => expectReadOnly('git status --short'));
    it('allows git status -s', () => expectReadOnly('git status -s'));
    it('allows git log', () => expectReadOnly('git log'));
    it('allows git log --oneline -5', () =>
      expectReadOnly('git log --oneline -n 5'));
    it('allows git log --oneline -n 5', () =>
      expectReadOnly('git log --oneline -n 5'));
    it('allows git log --pretty=format:"%h %s"', () =>
      expectReadOnly('git log --pretty=format:"%h %s"'));
    it('allows git diff', () => expectReadOnly('git diff'));
    it('allows git diff --stat', () => expectReadOnly('git diff --stat'));
    it('allows git diff HEAD~1', () => expectReadOnly('git diff HEAD~1'));
    it('allows git diff --cached', () => expectReadOnly('git diff --cached'));
    it('allows git show HEAD', () => expectReadOnly('git show HEAD'));
    it('allows git show HEAD:file', () => expectReadOnly('git show HEAD:file'));
    it('allows git blame file', () => expectReadOnly('git blame file'));
    it('allows git branch --list', () => expectReadOnly('git branch --list'));
    it('allows git branch --show-current', () =>
      expectReadOnly('git branch --show-current'));
    it('allows git branch -a', () => expectReadOnly('git branch -a'));
    it('allows git branch -r', () => expectReadOnly('git branch -r'));
    it('allows git tag --list', () => expectReadOnly('git tag --list'));
    it('allows git tag -l', () => expectReadOnly('git tag -l'));
    it('allows git remote -v', () => expectReadOnly('git remote -v'));
    it('allows git ls-files', () => expectReadOnly('git ls-files'));
    it('allows git rev-parse --show-toplevel', () =>
      expectReadOnly('git rev-parse --show-toplevel'));
    it('allows git describe --tags', () =>
      expectReadOnly('git describe --tags'));
    it('allows git shortlog -s -n', () => expectReadOnly('git shortlog -s -n'));
    it('allows git stash list', () => expectReadOnly('git stash list'));
    it('allows git rev-list --count HEAD', () =>
      expectReadOnly('git rev-list --count HEAD'));
    it('allows git for-each-ref --format="%(refname)"', () =>
      expectReadOnly('git for-each-ref --format="%(refname)"'));
    it('allows git cat-file -t HEAD', () =>
      expectReadOnly('git cat-file -t HEAD'));
    it('allows git reflog', () => expectReadOnly('git reflog'));
    it('allows git worktree list', () => expectReadOnly('git worktree list'));
    it('allows git merge-base HEAD main', () =>
      expectReadOnly('git merge-base HEAD main'));
  });

  describe('search commands', () => {
    it('allows grep -n foo file', () => expectReadOnly('grep -n foo file'));
    it('allows grep -R "pattern" src', () =>
      expectReadOnly('grep -R "pattern" src'));
    it('allows grep -r --include="*.ts" pattern src', () =>
      expectReadOnly('grep -r --include="*.ts" pattern src'));
    it('allows rg TODO src', () => expectReadOnly('rg TODO src'));
    it('allows rg --files src', () => expectReadOnly('rg --files src'));
    it('allows rg -n pattern file', () => expectReadOnly('rg -n pattern file'));
    it('allows rg --type ts pattern', () =>
      expectReadOnly('rg --type ts pattern'));
    it('allows find . -name "*.ts"', () =>
      expectReadOnly('find . -name "*.ts"'));
    it('allows find . -name "*.ts" -maxdepth 2', () =>
      expectReadOnly('find . -name "*.ts" -maxdepth 2'));
    it('allows find . -type f -name "*.json"', () =>
      expectReadOnly('find . -type f -name "*.json"'));
  });

  describe('compound commands (&&, ;, |)', () => {
    it('allows ls && git log --oneline -n 1', () =>
      expectReadOnly('ls && git log --oneline -n 1'));
    it('allows cat package.json | wc -l', () =>
      expectReadOnly('cat package.json | wc -l'));
    it('allows git status && git log --oneline -n 3', () =>
      expectReadOnly('git status && git log --oneline -n 3'));
    it('allows grep TODO src | wc -l', () =>
      expectReadOnly('grep TODO src | wc -l'));
    it('allows ls; pwd', () => expectReadOnly('ls; pwd'));
    it('allows the original feedback command', () =>
      expectReadOnly(
        'git log --oneline -5 2>/dev/null; echo "---"; git branch --show-current 2>/dev/null',
      ));
    it('rescans the original feedback command after normalization', () => {
      const command =
        'git log --oneline -5 2>/dev/null; echo "---"; git branch --show-current 2>/dev/null';
      const result = checkReadOnlyShellCommand(
        command,
        scanShellShape(command),
      );
      expect(result.readonly).toBe(true);
    });
  });

  describe('commands with 2>&1 (safe stderr redirect)', () => {
    it('allows git status 2>&1', () => expectReadOnly('git status 2>&1'));
    it('allows ls -la 2>&1', () => expectReadOnly('ls -la 2>&1'));
  });

  // ========================================================================
  // Commands that must NOT be auto-allowed
  // ========================================================================

  describe('output redirection (NOT read-only)', () => {
    it('rejects ls > out.txt', () => expectNotReadOnly('ls > out.txt'));
    it('rejects grep foo file > out.txt', () =>
      expectNotReadOnly('grep foo file > out.txt'));
    it('rejects cat > out.txt', () => expectNotReadOnly('cat > out.txt'));
    it('rejects git diff --output=patch.diff', () =>
      expectNotReadOnly('git diff --output=patch.diff'));
  });

  describe('dangerous commands (NOT read-only)', () => {
    it('rejects rm -rf tmp', () => expectNotReadOnly('rm -rf tmp'));
    it('rejects chmod 777 file', () => expectNotReadOnly('chmod 777 file'));
    it('rejects sudo ls', () => expectNotReadOnly('sudo ls'));
    it('rejects bash -c "ls"', () => expectNotReadOnly('bash -c "ls"'));
    it('rejects python -c "print(1)"', () =>
      expectNotReadOnly('python -c "print(1)"'));
    it('rejects node -e "console.log(1)"', () =>
      expectNotReadOnly('node -e "console.log(1)"'));
  });

  describe('git write commands (NOT read-only)', () => {
    it('rejects git reset --hard', () => expectNotReadOnly('git reset --hard'));
    it('rejects git clean -fd', () => expectNotReadOnly('git clean -fd'));
    it('rejects git checkout main', () =>
      expectNotReadOnly('git checkout main'));
    it('rejects git switch main', () => expectNotReadOnly('git switch main'));
    it('rejects git branch new-branch', () =>
      expectNotReadOnly('git branch new-branch'));
    it('rejects git branch -D old-branch', () =>
      expectNotReadOnly('git branch -D old-branch'));
    it('rejects git tag v1.0.0', () => expectNotReadOnly('git tag v1.0.0'));
    it('rejects git fetch', () => expectNotReadOnly('git fetch'));
    it('rejects git pull', () => expectNotReadOnly('git pull'));
    it('rejects git push', () => expectNotReadOnly('git push'));
    it('rejects git commit -m "msg"', () =>
      expectNotReadOnly('git commit -m "msg"'));
    it('rejects git add .', () => expectNotReadOnly('git add .'));
    it('rejects git merge main', () => expectNotReadOnly('git merge main'));
    it('rejects git rebase main', () => expectNotReadOnly('git rebase main'));
    it('rejects git stash', () => expectNotReadOnly('git stash'));
    it('rejects git stash pop', () => expectNotReadOnly('git stash pop'));
  });

  describe('shell features that block auto-allow', () => {
    it('rejects command substitution $(rm -rf tmp)', () =>
      expectNotReadOnly('echo $(rm -rf tmp)'));
    it('rejects backtick substitution', () => expectNotReadOnly('echo `date`'));
    it('rejects quoted variable expansion in echo', () =>
      expectNotReadOnly('echo "$HOME"'));
    it('rejects echo output redirection', () =>
      expectNotReadOnly('echo ok > output.txt'));
    it('rejects background echo', () => expectNotReadOnly('echo ok &'));
    it('rejects printf variable-write conversions', () =>
      expectNotReadOnly("printf '%n' 42"));
    it('rejects subshell (cd a && ls)', () =>
      expectNotReadOnly('(cd a && ls)'));
    it('rejects tail -f (follow mode)', () =>
      expectNotReadOnly('tail -f app.log'));
    it('rejects find -delete', () => expectNotReadOnly('find . -delete'));
    it('rejects find -exec', () => expectNotReadOnly('find . -exec rm {} \\;'));
  });

  describe('xargs and tee (NOT auto-allowed)', () => {
    it('rejects cat files | xargs rm', () =>
      expectNotReadOnly('cat files | xargs rm'));
    it('rejects ls | tee out.txt', () => expectNotReadOnly('ls | tee out.txt'));
  });

  describe('variable expansion (NOT auto-allowed)', () => {
    it('rejects commands with $VAR', () => expectNotReadOnly('cat $HOME/file'));
    it('rejects commands with ${VAR}', () =>
      expectNotReadOnly('cat ${HOME}/file'));
  });

  describe('rollback environment variable', () => {
    it('disables readonly auto-allow when env var is set', () => {
      process.env[ENV_DISABLE_READONLY_SHELL_AUTO_ALLOW] = '1';
      const result = checkReadOnlyShellCommand('ls -la');
      expect(result.readonly).toBe(false);
      expect(result.reason).toContain('disabled by env var');
    });

    it('does not disable when env var is not "1"', () => {
      process.env[ENV_DISABLE_READONLY_SHELL_AUTO_ALLOW] = '0';
      const result = checkReadOnlyShellCommand('ls -la');
      expect(result.readonly).toBe(true);
    });
  });

  describe('git security checks', () => {
    it('rejects git with -c flag', () =>
      expectNotReadOnly('git -c core.fsmonitor=evil status'));
    it('rejects git with --exec-path', () =>
      expectNotReadOnly('git --exec-path=/evil status'));
    it('rejects git with --config-env', () =>
      expectNotReadOnly('git --config-env=core.fsmonitor=EVIL status'));
    it('rejects git reflog expire', () =>
      expectNotReadOnly('git reflog expire'));
    it('rejects git reflog delete', () =>
      expectNotReadOnly('git reflog delete'));
    it('rejects git cat-file modes that may execute configured filters', () => {
      expectNotReadOnly('git cat-file --textconv HEAD:file.txt');
      expectNotReadOnly('git cat-file --filters HEAD:file.txt');
    });
    it('rejects git tag verification that may execute configured programs', () =>
      expectNotReadOnly('git tag --verify v1.0.0'));
  });

  describe('Phase 0 regression: git numeric shorthand', () => {
    it('allows git log --oneline -5 (numeric shorthand)', () =>
      expectReadOnly('git log --oneline -5'));
    it('allows git log -3', () => expectReadOnly('git log -3'));
    it('allows git log --graph -10', () =>
      expectReadOnly('git log --graph -10'));
    it('allows git rev-list -1 HEAD', () =>
      expectReadOnly('git rev-list -1 HEAD'));
  });

  describe('Phase 0 regression: sort -o writes to file', () => {
    it('allows sort file (basic read)', () => expectReadOnly('sort file'));
    it('allows sort -r file', () => expectReadOnly('sort -r file'));
    it('allows sort -n -u file', () => expectReadOnly('sort -n -u file'));
    it('allows sort -k2,2 file', () => expectReadOnly('sort -k2,2 file'));
    it('rejects sort -o out.txt input.txt', () =>
      expectNotReadOnly('sort -o out.txt input.txt'));
    it('rejects sort --output=out.txt input.txt', () =>
      expectNotReadOnly('sort --output=out.txt input.txt'));
  });

  describe('Phase 0 regression: uniq output file', () => {
    it('allows uniq file (single input)', () => expectReadOnly('uniq file'));
    it('allows uniq -c file', () => expectReadOnly('uniq -c file'));
    it('rejects uniq input.txt out.txt (output file)', () =>
      expectNotReadOnly('uniq input.txt out.txt'));
  });

  describe('Phase 0 regression: tail follow modes', () => {
    it('allows tail -n 20 file', () => expectReadOnly('tail -n 20 file'));
    it('allows tail file', () => expectReadOnly('tail file'));
    it('rejects tail -f app.log', () => expectNotReadOnly('tail -f app.log'));
    it('rejects tail -F app.log', () => expectNotReadOnly('tail -F app.log'));
    it('rejects tail --follow app.log', () =>
      expectNotReadOnly('tail --follow app.log'));
  });

  describe('edge cases', () => {
    it('rejects empty command', () => expectNotReadOnly(''));
    it('rejects whitespace-only command', () => expectNotReadOnly('   '));
    it('handles commands with quoted args', () =>
      expectReadOnly('grep "hello world" file'));
    it('handles git log with positional refs', () =>
      expectReadOnly('git log main..feature'));
    it('handles git diff between refs', () =>
      expectReadOnly('git diff main...HEAD'));
  });

  describe('Phase 3: git config read operations', () => {
    it('allows git config --get user.name', () =>
      expectReadOnly('git config --get user.name'));
    it('allows git config --get-all user.email', () =>
      expectReadOnly('git config --get-all user.email'));
    it('allows git config --get-regexp "^user"', () =>
      expectReadOnly('git config --get-regexp "^user"'));
    it('allows git config --list', () => expectReadOnly('git config --list'));
    it('allows git config -l', () => expectReadOnly('git config -l'));
    it('allows git config --list --show-origin', () =>
      expectReadOnly('git config --list --show-origin'));
    it('allows git config --list --show-scope', () =>
      expectReadOnly('git config --list --show-scope'));
    it('allows git config --global --list', () =>
      expectReadOnly('git config --global --list'));
    it('allows git config user.name (bare key lookup)', () =>
      expectReadOnly('git config user.name'));
    it('rejects git config user.name "John" (set operation)', () =>
      expectNotReadOnly('git config user.name "John"'));
    it('rejects git config --add user.name "John"', () =>
      expectNotReadOnly('git config --add user.name "John"'));
    it('rejects git config --unset user.name', () =>
      expectNotReadOnly('git config --unset user.name'));
    it('rejects git config --unset-all user.name', () =>
      expectNotReadOnly('git config --unset-all user.name'));
    it('rejects git config --rename-section old new', () =>
      expectNotReadOnly('git config --rename-section old new'));
    it('rejects git config --remove-section section', () =>
      expectNotReadOnly('git config --remove-section section'));
    it('rejects git config --edit', () =>
      expectNotReadOnly('git config --edit'));
    it('rejects git config -e', () => expectNotReadOnly('git config -e'));
  });

  describe('Phase 3: git grep', () => {
    it('allows git grep pattern', () => expectReadOnly('git grep pattern'));
    it('allows git grep -n pattern', () =>
      expectReadOnly('git grep -n pattern'));
    it('allows git grep -i "todo"', () => expectReadOnly('git grep -i "todo"'));
    it('allows git grep --count pattern', () =>
      expectReadOnly('git grep --count pattern'));
    it('allows git grep -e pattern -e other', () =>
      expectReadOnly('git grep -e pattern -e other'));
    it('allows git grep -C 3 pattern', () =>
      expectReadOnly('git grep -C 3 pattern'));
    it('allows git grep --heading -n pattern', () =>
      expectReadOnly('git grep --heading -n pattern'));
    it('allows git grep -l pattern', () =>
      expectReadOnly('git grep -l pattern'));
    it('allows git grep --recurse-submodules pattern', () =>
      expectReadOnly('git grep --recurse-submodules pattern'));
  });

  describe('Phase 3: git remote show', () => {
    it('allows git remote show origin', () =>
      expectReadOnly('git remote show origin'));
    it('allows git remote show upstream', () =>
      expectReadOnly('git remote show upstream'));
    it('allows git remote show -n origin', () =>
      expectReadOnly('git remote show -n origin'));
    it('rejects git remote show with path-like arg', () =>
      expectNotReadOnly('git remote show /etc/evil'));
  });

  describe('Phase 3: enhanced git branch callback', () => {
    it('allows git branch --list', () => expectReadOnly('git branch --list'));
    it('allows git branch -a', () => expectReadOnly('git branch -a'));
    it('allows git branch -r', () => expectReadOnly('git branch -r'));
    it('allows git branch -vv', () => expectReadOnly('git branch -vv'));
    it('allows git branch --merged main', () =>
      expectReadOnly('git branch --merged main'));
    it('allows git branch --no-merged main', () =>
      expectReadOnly('git branch --no-merged main'));
    it('allows git branch --contains HEAD', () =>
      expectReadOnly('git branch --contains HEAD'));
    it('rejects git branch -d feature', () =>
      expectNotReadOnly('git branch -d feature'));
    it('rejects git branch -D feature', () =>
      expectNotReadOnly('git branch -D feature'));
    it('rejects git branch -m old new', () =>
      expectNotReadOnly('git branch -m old new'));
    it('rejects git branch -M old new', () =>
      expectNotReadOnly('git branch -M old new'));
    it('rejects git branch -c old new', () =>
      expectNotReadOnly('git branch -c old new'));
    it('rejects git branch new-branch', () =>
      expectNotReadOnly('git branch new-branch'));
  });

  describe('Phase 3: enhanced git tag callback', () => {
    it('allows git tag --list', () => expectReadOnly('git tag --list'));
    it('allows git tag -l', () => expectReadOnly('git tag -l'));
    it('allows git tag -l "v1.*"', () => expectReadOnly('git tag -l "v1.*"'));
    it('allows git tag --list --sort=-creatordate', () =>
      expectReadOnly('git tag --list --sort=-creatordate'));
    it('rejects git tag v1.0.0', () => expectNotReadOnly('git tag v1.0.0'));
    it('rejects git tag -d v1.0.0', () =>
      expectNotReadOnly('git tag -d v1.0.0'));
    it('rejects git tag -a v1.0.0', () =>
      expectNotReadOnly('git tag -a v1.0.0'));
    it('rejects git tag -s v1.0.0', () =>
      expectNotReadOnly('git tag -s v1.0.0'));
    it('rejects git tag -f v1.0.0', () =>
      expectNotReadOnly('git tag -f v1.0.0'));
  });

  describe('Phase 3: git reflog safety', () => {
    it('allows git reflog', () => expectReadOnly('git reflog'));
    it('allows git reflog show', () => expectReadOnly('git reflog show'));
    it('allows git reflog show HEAD', () =>
      expectReadOnly('git reflog show HEAD'));
    it('rejects git reflog expire', () =>
      expectNotReadOnly('git reflog expire'));
    it('rejects git reflog delete', () =>
      expectNotReadOnly('git reflog delete'));
  });

  describe('Phase 3: git diff --output excluded', () => {
    it('rejects git diff --output=patch.diff', () =>
      expectNotReadOnly('git diff --output=patch.diff'));
    it('allows git diff -S "pattern"', () =>
      expectReadOnly('git diff -S "pattern"'));
    it('allows git diff -G "regex"', () =>
      expectReadOnly('git diff -G "regex"'));
    it('allows git diff --no-index file1 file2', () =>
      expectReadOnly('git diff --no-index file1 file2'));
  });

  // ==========================================================================
  // Phase 3 收尾: git ls-remote
  // ==========================================================================
  describe('Phase 3: git ls-remote', () => {
    it('allows git ls-remote', () => expectReadOnly('git ls-remote'));
    it('allows git ls-remote origin', () =>
      expectReadOnly('git ls-remote origin'));
    it('allows git ls-remote --heads origin', () =>
      expectReadOnly('git ls-remote --heads origin'));
    it('allows git ls-remote --tags origin', () =>
      expectReadOnly('git ls-remote --tags origin'));
    it('allows git ls-remote --refs origin', () =>
      expectReadOnly('git ls-remote --refs origin'));
    it('allows git ls-remote --symref origin', () =>
      expectReadOnly('git ls-remote --symref origin'));
    it('allows git ls-remote -q origin', () =>
      expectReadOnly('git ls-remote -q origin'));
    it('allows git ls-remote --sort=version:refname origin', () =>
      expectReadOnly('git ls-remote --sort=version:refname origin'));
    it('allows git ls-remote --sort version:refname origin', () =>
      expectReadOnly('git ls-remote --sort version:refname origin'));
    it('allows git ls-remote --get-url origin', () =>
      expectReadOnly('git ls-remote --get-url origin'));

    it('rejects git ls-remote with HTTPS URL', () =>
      expectNotReadOnly('git ls-remote https://github.com/a/b.git'));
    it('rejects git ls-remote with SSH URL', () =>
      expectNotReadOnly('git ls-remote ssh://github.com/a/b.git'));
    it('rejects git ls-remote with git@ URL', () =>
      expectNotReadOnly('git ls-remote git@github.com:a/b.git'));
    it('rejects git ls-remote with user@host:repo', () =>
      expectNotReadOnly('git ls-remote user@host:repo'));
    it('rejects git ls-remote with absolute path', () =>
      expectNotReadOnly('git ls-remote /etc/repo'));
    it('rejects git ls-remote with path traversal', () =>
      expectNotReadOnly('git ls-remote ../other-repo'));
    it('rejects git ls-remote --sort with HTTPS URL', () =>
      expectNotReadOnly(
        'git ls-remote --sort version:refname https://github.com/a/b.git',
      ));
    it('rejects git ls-remote --upload-pack=sh origin', () =>
      expectNotReadOnly('git ls-remote --upload-pack=sh origin'));
  });

  // ==========================================================================
  // Phase 4B: checksum commands
  // ==========================================================================
  describe('Phase 4B: checksum commands', () => {
    it('allows sha256sum package.json', () =>
      expectReadOnly('sha256sum package.json'));
    it('allows sha1sum README.md', () => expectReadOnly('sha1sum README.md'));
    it('allows md5sum file.txt', () => expectReadOnly('md5sum file.txt'));
    it('allows sha256sum -b package.json', () =>
      expectReadOnly('sha256sum -b package.json'));
    it('allows md5sum --binary file.txt', () =>
      expectReadOnly('md5sum --binary file.txt'));
    it('allows sha256sum (no args, reads stdin)', () =>
      expectReadOnly('sha256sum'));

    it('rejects sha256sum --check because referenced paths are data-dependent', () =>
      expectNotReadOnly('sha256sum --check sums.txt'));
    it('rejects sha256sum -c because referenced paths are data-dependent', () =>
      expectNotReadOnly('sha256sum -c sums.txt'));
    it('rejects sha256sum --unknown file.txt', () =>
      expectNotReadOnly('sha256sum --unknown file.txt'));
  });

  // ==========================================================================
  // Phase 4B: tree command
  // ==========================================================================
  describe('Phase 4B: tree command', () => {
    it('allows tree', () => expectReadOnly('tree'));
    it('allows tree .', () => expectReadOnly('tree .'));
    it('allows tree packages/core', () => expectReadOnly('tree packages/core'));
    it('allows tree -L 2 packages', () => expectReadOnly('tree -L 2 packages'));
    it('allows tree -a -d', () => expectReadOnly('tree -a -d'));
    it('allows tree -J', () => expectReadOnly('tree -J'));
    it('allows tree --dirsfirst --noreport', () =>
      expectReadOnly('tree --dirsfirst --noreport'));
    it('allows tree -I node_modules', () =>
      expectReadOnly('tree -I node_modules'));
    it('allows tree -P "*.ts"', () => expectReadOnly('tree -P "*.ts"'));

    it('rejects tree -o out.txt', () => expectNotReadOnly('tree -o out.txt'));
    it('rejects tree --output=out.txt', () =>
      expectNotReadOnly('tree --output=out.txt'));
    it('rejects tree --fromfile', () => expectNotReadOnly('tree --fromfile'));
    it('rejects tree --unknown', () => expectNotReadOnly('tree --unknown'));
  });

  // ==========================================================================
  // Phase 4B: ps/pgrep and system viewing commands
  // ==========================================================================
  describe('Phase 4B: ps/pgrep', () => {
    it('allows ps', () => expectReadOnly('ps'));
    it('allows ps -ef', () => expectReadOnly('ps -ef'));
    it('allows ps -u root', () => expectReadOnly('ps -u root'));
    it('allows ps --format pid,comm', () =>
      expectReadOnly('ps --format pid,comm'));
    it('allows ps -H', () => expectReadOnly('ps -H'));
    it('allows pgrep node', () => expectReadOnly('pgrep node'));
    it('allows pgrep -fl node', () => expectReadOnly('pgrep -fl node'));
    it('allows pgrep -u root', () => expectReadOnly('pgrep -u root'));

    it('rejects ps with e in positional (env leak)', () =>
      expectNotReadOnly('ps auxe'));
    it('rejects ps axe (env leak)', () => expectNotReadOnly('ps axe'));
  });

  describe('Phase 4B: system viewing commands', () => {
    it('allows date', () => expectReadOnly('date'));
    it('allows date -u', () => expectReadOnly('date -u'));
    it('allows date --iso-8601=seconds', () =>
      expectReadOnly('date --iso-8601=seconds'));
    it('rejects date --set', () => expectNotReadOnly('date --set=now'));
    it('rejects date -s', () => expectNotReadOnly('date -s tomorrow'));

    it('allows hostname', () => expectReadOnly('hostname'));
    it('allows hostname -f', () => expectReadOnly('hostname -f'));
    it('allows hostname --ip-address', () =>
      expectReadOnly('hostname --ip-address'));
    it('rejects hostname with positional (sets hostname)', () =>
      expectNotReadOnly('hostname newname'));

    it('allows uptime', () => expectReadOnly('uptime'));
    it('allows uptime -p', () => expectReadOnly('uptime -p'));
    it('allows uptime --since', () => expectReadOnly('uptime --since'));

    it('allows df structured low-risk flags', () => {
      expectReadOnly('df');
      expectReadOnly('df -h');
      expectReadOnly('df --human-readable');
      expectReadOnly('df -Th');
      expectReadOnly('df --block-size=1M');
    });
    it('rejects df positional paths and unsafe flags', () => {
      expectNotReadOnly('df /etc');
      expectNotReadOnly('df --output=source');
      expectNotReadOnly('df --sync');
      expectNotReadOnly('df --unknown');
    });

    it('allows free structured low-risk flags', () => {
      expectReadOnly('free');
      expectReadOnly('free -h');
      expectReadOnly('free --mega');
      expectReadOnly('free -mt');
    });
    it('rejects free repeated-output and unknown flags', () => {
      expectNotReadOnly('free -s 1');
      expectNotReadOnly('free --seconds 1');
      expectNotReadOnly('free --unknown');
    });

    it('allows tput safe capabilities', () => {
      expectReadOnly('tput cols');
      expectReadOnly('tput lines');
      expectReadOnly('tput colors');
      expectReadOnly('tput sgr0');
    });
    it('rejects tput terminal reset and stdin batch modes', () => {
      expectNotReadOnly('tput init');
      expectNotReadOnly('tput reset');
      expectNotReadOnly('tput -S');
      expectNotReadOnly('tput -T xterm init');
    });

    it('allows man path lookup only', () => {
      expectReadOnly('man -w ls');
      expectReadOnly('man --where ls');
      expectReadOnly('man -w 1 ls');
    });
    it('rejects man render, pager, local-file, and inline flag forms', () => {
      expectNotReadOnly('man ls');
      expectNotReadOnly('man -P sh ls');
      expectNotReadOnly('man -l /etc/passwd');
      expectNotReadOnly('man --where=ls');
    });

    it('allows info metadata-only queries', () => {
      expectReadOnly('info --where coreutils');
      expectReadOnly('info -w ls');
      expectReadOnly('info --version');
    });
    it('rejects info reader, arbitrary file, and output forms', () => {
      expectNotReadOnly('info ls');
      expectNotReadOnly('info -f /etc/passwd');
      expectNotReadOnly('info --output out.txt');
      expectNotReadOnly('info --where=coreutils');
    });

    it('allows help builtin queries', () => {
      expectReadOnly('help');
      expectReadOnly('help cd');
      expectReadOnly('help -d cd');
      expectReadOnly('help -m test');
      expectReadOnly('help -s printf');
    });
    it('rejects help unknown flags and unsafe topics', () => {
      expectNotReadOnly('help --unknown');
      expectNotReadOnly('help ../../x');
      expectNotReadOnly('help a b');
    });

    it('allows P2 small system query commands', () => {
      expectReadOnly('groups');
      expectReadOnly('groups alice');
      expectReadOnly('groups alice bob-dev');
      expectReadOnly('arch');
      expectReadOnly('locale');
      expectReadOnly('locale -a');
      expectReadOnly('locale -ck LC_TIME');
      expectReadOnly('locale LANG');
      expectReadOnly('locale charmap');
      expectReadOnly('tty');
      expectReadOnly('tty -s');
    });
    it('rejects unsafe P2 small system query edges', () => {
      expectNotReadOnly('groups ../../root');
      expectNotReadOnly('groups --unknown');
      expectNotReadOnly('arch -x86_64 uname');
      expectNotReadOnly('arch arm64');
      expectNotReadOnly('locale /etc/passwd');
      expectNotReadOnly('locale foo');
      expectNotReadOnly('locale charmap /etc/passwd');
      expectNotReadOnly('locale --unknown');
      expectNotReadOnly('tty /dev/ttys001');
      expectNotReadOnly('tty --unknown');
    });
  });

  // ==========================================================================
  // Phase 4A: migrated commands (formerly regex, now flag-parsed)
  // ==========================================================================
  describe('Phase 4A: migrated commands', () => {
    it('allows ls -la', () => expectReadOnly('ls -la'));
    it('allows ls --color=auto', () => expectReadOnly('ls --color=auto'));
    it('allows cat -n file.txt', () => expectReadOnly('cat -n file.txt'));
    it('allows head -n 20 file.txt', () =>
      expectReadOnly('head -n 20 file.txt'));
    it('allows wc -l file.txt', () => expectReadOnly('wc -l file.txt'));
    it('allows stat file.txt', () => expectReadOnly('stat file.txt'));
    it('allows file document.pdf', () => expectReadOnly('file document.pdf'));
    it('allows du -sh src', () => expectReadOnly('du -sh src'));
    it('allows cut -d: -f1 file.txt', () =>
      expectReadOnly('cut -d: -f1 file.txt'));
    it('allows diff -u a.txt b.txt', () =>
      expectReadOnly('diff -u a.txt b.txt'));
    it('allows realpath ./file', () => expectReadOnly('realpath ./file'));
    it('allows readlink -f link', () => expectReadOnly('readlink -f link'));

    it('rejects ls with unknown flag', () =>
      expectNotReadOnly('ls --exec foo'));
    it('rejects diff with unknown flag', () =>
      expectNotReadOnly('diff --exec a b'));
  });

  // ==========================================================================
  // Phase 4C: fd / fdfind
  // ==========================================================================
  describe('Phase 4C: fd / fdfind', () => {
    // Basic usage
    it('allows fd with pattern', () => expectReadOnly('fd TODO'));
    it('allows fd with extension filter', () => expectReadOnly('fd -e ts'));
    it('allows fd with type filter', () => expectReadOnly('fd --type f'));
    it('allows fd with hidden files', () =>
      expectReadOnly('fd --hidden pattern'));
    it('allows fd with pattern and path', () =>
      expectReadOnly('fd pattern src'));
    it('allows fd with depth limit', () =>
      expectReadOnly('fd --max-depth 3 pattern'));
    it('allows fd with glob mode', () =>
      expectReadOnly('fd -g "*.ts" packages'));
    it('allows fd with case insensitive', () =>
      expectReadOnly('fd -i pattern'));
    it('allows fd with size filter', () => expectReadOnly('fd --size +1m'));
    it('allows fd with exclude', () =>
      expectReadOnly('fd -E node_modules pattern'));
    it('allows fd with multiple flags', () =>
      expectReadOnly('fd -H -I --type f -e ts pattern src'));
    it('allows fd with search-path flag', () =>
      expectReadOnly('fd --search-path src pattern'));
    it('allows fd with color=never', () =>
      expectReadOnly('fd --color never pattern'));
    it('allows fd with threads', () => expectReadOnly('fd -j 4 pattern'));

    // fdfind alias
    it('allows fdfind with pattern', () => expectReadOnly('fdfind TODO'));
    it('allows fdfind -e ts', () => expectReadOnly('fdfind -e ts'));
    it('allows fdfind with path', () => expectReadOnly('fdfind pattern src'));

    // Dangerous: exec
    it('rejects fd -x (exec)', () => expectNotReadOnly('fd -x rm pattern'));
    it('rejects fd --exec', () => expectNotReadOnly('fd --exec rm pattern'));
    it('rejects fd -X (exec-batch)', () =>
      expectNotReadOnly('fd -X rm pattern'));
    it('rejects fd --exec-batch', () =>
      expectNotReadOnly('fd --exec-batch rm pattern'));
    it('rejects fdfind --exec', () =>
      expectNotReadOnly('fdfind --exec rm pattern'));
    it('rejects fd --list-details', () =>
      expectNotReadOnly('fd --list-details pattern'));
    it('rejects fd -l', () => expectNotReadOnly('fd -l pattern'));

    // Unknown flags rejected
    it('rejects fd with unknown flag', () =>
      expectNotReadOnly('fd --unknown-flag pattern'));
  });

  // ==========================================================================
  // Phase 4D: sed read-only subset
  // ==========================================================================
  describe('Phase 4D: sed read-only subset', () => {
    // Safe sed usages
    it('allows sed with print command', () =>
      expectReadOnly("sed -n '1,20p' file.txt"));
    it('allows sed with substitution', () =>
      expectReadOnly("sed 's/foo/bar/g' file.txt"));
    it('allows sed with extended regex', () =>
      expectReadOnly("sed -E 's/foo/bar/' file.txt"));
    it('allows sed with -r flag', () =>
      expectReadOnly("sed -r 's/foo/bar/' file.txt"));
    it('allows sed with -e expression', () =>
      expectReadOnly("sed -e 's/foo/bar/' -e 's/baz/qux/' file.txt"));
    it('allows sed with -f script file', () =>
      expectReadOnly('sed -f script.sed file.txt'));
    it('allows sed with delete command', () =>
      expectReadOnly("sed '/pattern/d' file.txt"));
    it('allows sed with print specific lines', () =>
      expectReadOnly("sed -n '5,10p' file.txt"));
    it('allows sed with multiple files', () =>
      expectReadOnly("sed 's/foo/bar/' a.txt b.txt"));
    it('allows sed with no files (stdin)', () =>
      expectReadOnly("sed 's/foo/bar/'"));
    it('allows sed -n with address', () =>
      expectReadOnly("sed -n '/start/,/end/p' file.txt"));

    // Dangerous: in-place editing
    it('rejects sed -i', () =>
      expectNotReadOnly("sed -i 's/foo/bar/' file.txt"));
    it('rejects sed --in-place', () =>
      expectNotReadOnly("sed --in-place 's/foo/bar/' file.txt"));
    it('rejects sed -i with backup suffix', () =>
      expectNotReadOnly("sed -i.bak 's/foo/bar/' file.txt"));
    it('rejects sed --in-place=.bak', () =>
      expectNotReadOnly("sed --in-place=.bak 's/foo/bar/' file.txt"));

    // Dangerous: sed script commands
    it('rejects sed w command (write to file)', () =>
      expectNotReadOnly("sed 'w out.txt' file.txt"));
    it('rejects sed w command without whitespace before file', () =>
      expectNotReadOnly("sed '1w/tmp/out.txt' file.txt"));
    it('rejects sed e command (execute)', () =>
      expectNotReadOnly("sed 'e' file.txt"));
    it('rejects sed e with command', () =>
      expectNotReadOnly("sed 'e ls' file.txt"));
    it('rejects sed r command (read file)', () =>
      expectNotReadOnly("sed 'r /etc/passwd' file.txt"));
    it('rejects sed r command without whitespace before file', () =>
      expectNotReadOnly("sed '1r/etc/passwd' file.txt"));
    it('rejects sed R command (read line from file)', () =>
      expectNotReadOnly("sed 'R /etc/passwd' file.txt"));
    it('rejects sed W command (write first line)', () =>
      expectNotReadOnly("sed 'W out.txt' file.txt"));
    it('rejects sed substitution w flag without whitespace before file', () =>
      expectNotReadOnly("sed 's/a/b/w/tmp/out.txt' file.txt"));
    it('rejects sed substitution e flag', () =>
      expectNotReadOnly("sed 's/a/echo pwn/e' file.txt"));
    // Address-prefixed substitution with dangerous flags
    it('rejects sed with address + s///w', () =>
      expectNotReadOnly("sed '1s/a/b/w/tmp/out.txt' file.txt"));
    it('rejects sed with range address + s///w', () =>
      expectNotReadOnly("sed '1,3s/a/b/w/tmp/out.txt' file.txt"));
    it('rejects sed with regex address + s///w', () =>
      expectNotReadOnly("sed '/foo/s/a/b/w/tmp/out.txt' file.txt"));
    it('rejects sed with address + s///e', () =>
      expectNotReadOnly("sed '1s/a/echo pwn/e' file.txt"));

    // Unknown flags rejected
    it('rejects sed with unknown flag', () =>
      expectNotReadOnly('sed --unknown-flag file.txt'));
  });

  // ==========================================================================
  // Phase 4E: jq read-only subset
  // ==========================================================================
  describe('Phase 4E: jq read-only subset', () => {
    // Safe jq usages
    it('allows jq . file', () => expectReadOnly('jq . package.json'));
    it('allows jq with filter', () =>
      expectReadOnly("jq '.scripts' package.json"));
    it('allows jq -r', () => expectReadOnly("jq -r '.name' package.json"));
    it('allows jq -c', () => expectReadOnly("jq -c '.[]' data.json"));
    it('allows jq --slurp', () => expectReadOnly("jq -s '.' a.json b.json"));
    it('allows jq --raw-input', () => expectReadOnly("jq -R '.' file.txt"));
    it('allows jq --null-input', () => expectReadOnly("jq -n '{}'"));
    it('allows jq --sort-keys', () => expectReadOnly('jq -S . package.json'));
    it('allows jq --tab', () => expectReadOnly('jq --tab . package.json'));
    it('allows jq --indent', () =>
      expectReadOnly('jq --indent 4 . package.json'));
    it('allows jq --arg', () =>
      expectReadOnly("jq --arg name foo '.key' data.json"));
    it('rejects jq filter with $name (shell expansion risk)', () =>
      expectNotReadOnly("jq --arg name foo '.[$name]' data.json"));
    it('allows jq with compact and exit-status', () =>
      expectReadOnly("jq -ce '.key' data.json"));
    it('allows jq with no file (stdin)', () => expectReadOnly("jq '.'"));

    // Dangerous: file reading flags
    it('rejects jq -f (from-file)', () =>
      expectNotReadOnly('jq -f filter.jq data.json'));
    it('rejects jq --from-file', () =>
      expectNotReadOnly('jq --from-file filter.jq data.json'));
    it('rejects jq --rawfile', () =>
      expectNotReadOnly('jq --rawfile var /etc/passwd . data.json'));
    it('rejects jq --slurpfile', () =>
      expectNotReadOnly('jq --slurpfile var /etc/passwd . data.json'));
    it('rejects jq -L (library path)', () =>
      expectNotReadOnly("jq -L /tmp/filters '.' data.json"));
    it('rejects jq --run-tests', () =>
      expectNotReadOnly('jq --run-tests tests.jq'));

    // Dangerous: env access in filter
    it('rejects jq env filter', () => expectNotReadOnly('jq env'));
    it('rejects jq $ENV filter', () =>
      expectNotReadOnly("jq '$ENV' data.json"));

    // Unknown flags rejected
    it('rejects jq with unknown flag', () =>
      expectNotReadOnly('jq --unknown . data.json'));
  });

  // ========================================================================
  // Special device redirections — full dimension matrix
  // Dimensions: device type × redirect type × command structure
  // ========================================================================

  describe('special device redirections', () => {
    // --- /dev/null × all redirect types × simple command ---
    it('allows git log 2>/dev/null (2>, simple)', () =>
      expectReadOnly('git log 2>/dev/null'));
    it('allows git log 1>/dev/null (1>, simple)', () =>
      expectReadOnly('git log 1>/dev/null'));
    it('allows git status >/dev/null (>, simple)', () =>
      expectReadOnly('git status >/dev/null'));
    it('allows git log >>/dev/null (>>, simple)', () =>
      expectReadOnly('git log >>/dev/null'));
    it('allows git log 2>>/dev/null (2>>, simple)', () =>
      expectReadOnly('git log 2>>/dev/null'));
    it('allows git log &>/dev/null (&>, simple)', () =>
      expectReadOnly('git log &>/dev/null'));

    // --- /dev/null × 2> × pipe ---
    it('allows git log 2>/dev/null | head -n 30 (2>, pipe)', () =>
      expectReadOnly('git log 2>/dev/null | head -n 30'));
    it('allows ls -R src 2>/dev/null | head -n 50 (2>, pipe)', () =>
      expectReadOnly('ls -R src 2>/dev/null | head -n 50'));
    it('allows git log 1>/dev/null | head -n 10 (1>, pipe)', () =>
      expectReadOnly('git log 1>/dev/null | head -n 10'));

    // --- /dev/null × 2> × compound (&&) ---
    it('allows git status && git log 2>/dev/null (2>, compound)', () =>
      expectReadOnly('git status && git log 2>/dev/null'));

    // --- /dev/stdout ---
    it('allows git log 2>/dev/stdout (simple)', () =>
      expectReadOnly('git log 2>/dev/stdout'));
    it('allows git log 2>/dev/stdout | head -n 5 (pipe)', () =>
      expectReadOnly('git log 2>/dev/stdout | head -n 5'));

    // --- /dev/stderr ---
    it('allows git log 2>/dev/stderr (simple)', () =>
      expectReadOnly('git log 2>/dev/stderr'));
    it('allows git log 2>/dev/stderr | head -n 5 (pipe)', () =>
      expectReadOnly('git log 2>/dev/stderr | head -n 5'));

    // --- /dev/stdin ---
    it('allows git log 2>/dev/stdin (simple)', () =>
      expectReadOnly('git log 2>/dev/stdin'));

    // --- /dev/tty ---
    it('allows git log 2>/dev/tty (simple)', () =>
      expectReadOnly('git log 2>/dev/tty'));

    // --- /dev/fd/N ---
    it('allows git log 2>/dev/fd/0 (simple)', () =>
      expectReadOnly('git log 2>/dev/fd/0'));
    it('allows git log 2>/dev/fd/1 (simple)', () =>
      expectReadOnly('git log 2>/dev/fd/1'));
    it('allows git log 2>/dev/fd/2 (simple)', () =>
      expectReadOnly('git log 2>/dev/fd/2'));

    // --- Windows NUL ---
    it('allows git log 2>NUL (2>, simple)', () =>
      expectReadOnly('git log 2>NUL'));
    it('allows git status >NUL (>, simple)', () =>
      expectReadOnly('git status >NUL'));

    // --- Mixed redirects: real file + special device ---
    it('rejects git log > real.txt 2>/dev/null (real first)', () =>
      expectNotReadOnly('git log > real.txt 2>/dev/null'));
    it('rejects git log 2>/dev/null > real.txt (device first)', () =>
      expectNotReadOnly('git log 2>/dev/null > real.txt'));

    // --- Real file redirects (negative controls) ---
    it('rejects git log > out.txt (>, simple)', () =>
      expectNotReadOnly('git log > out.txt'));
    it('rejects git log >> real.txt (>>, simple)', () =>
      expectNotReadOnly('git log >> real.txt'));
  });
});

describe('sleep read-only classification', () => {
  it.each(['sleep 0', 'sleep 0.1', 'sleep .5', 'sleep 1s 2m'])(
    'allows a duration-only wait: %s',
    (command) => {
      expect(checkReadOnlyShellCommand(command).readonly).toBe(true);
    },
  );
  it.each([
    'sleep',
    'sleep --help',
    'sleep infinity',
    'sleep $WAIT',
    'sleep 1 > out',
    'sleep 1 &',
    'sleep 1; touch out',
  ])('rejects non-duration input or side effects: %s', (command) => {
    expect(checkReadOnlyShellCommand(command).readonly).toBe(false);
  });
});
