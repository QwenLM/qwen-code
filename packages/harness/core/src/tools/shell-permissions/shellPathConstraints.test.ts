/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import type { PathPermissionContext } from '../tool-checkers/checker-reasons.js';
import { getPlatform } from '../../utils/platform.js';
import { checkReadOnlyShellPathConstraints } from './shellPathConstraints.js';

vi.mock('../../utils/platform.js', () => ({
  getPlatform: vi.fn(() => 'linux'),
}));

// ============================================================================
// Helpers
// ============================================================================

function makeContext(
  overrides: {
    allow?: Record<string, string[]>;
    deny?: Record<string, string[]>;
    ask?: Record<string, string[]>;
    additionalDirectories?: string[];
  } = {},
): PathPermissionContext {
  const {
    allow = {},
    deny = {},
    ask = {},
    additionalDirectories = [],
  } = overrides;
  return { rules: { allow, deny, ask }, additionalDirectories };
}

const PROJECT_CWD = '/Users/dev/myproject';

function expectAllowed(
  command: string,
  executionCwd = PROJECT_CWD,
  permissionCwd = executionCwd,
) {
  const result = checkReadOnlyShellPathConstraints(
    command,
    makeContext(),
    executionCwd,
    permissionCwd,
  );
  expect(result.allowed).not.toBe(false);
}

function expectBlocked(
  command: string,
  executionCwd = PROJECT_CWD,
  permissionCwd = executionCwd,
) {
  const result = checkReadOnlyShellPathConstraints(
    command,
    makeContext(),
    executionCwd,
    permissionCwd,
  );
  expect(result.allowed).toBe(false);
}

function expectSkip(
  command: string,
  executionCwd = PROJECT_CWD,
  permissionCwd = executionCwd,
) {
  const result = checkReadOnlyShellPathConstraints(
    command,
    makeContext(),
    executionCwd,
    permissionCwd,
  );
  expect(result.allowed).toBe('skip');
}

// ============================================================================
// Tests
// ============================================================================

describe('checkReadOnlyShellPathConstraints', () => {
  beforeEach(() => {
    vi.mocked(getPlatform).mockReturnValue('linux');
  });

  describe('commands that skip path validation', () => {
    it('skips literal echo', () => expectSkip('echo "safe"'));
    it('skips stdout-only printf', () => expectSkip('printf "%s\\n" safe'));
    it('skips pwd', () => expectSkip('pwd'));
    it('skips whoami', () => expectSkip('whoami'));
    it('skips uname -a', () => expectSkip('uname -a'));
    it('skips id', () => expectSkip('id'));
    it('skips groups alice', () => expectSkip('groups alice'));
    it('skips arch', () => expectSkip('arch'));
    it('skips locale -a', () => expectSkip('locale -a'));
    it('skips tty -s', () => expectSkip('tty -s'));
    it('skips df -h', () => expectSkip('df -h'));
    it('skips free -m', () => expectSkip('free -m'));
    it('skips tput cols', () => expectSkip('tput cols'));
    it('skips man -w ls', () => expectSkip('man -w ls'));
    it('skips info --where coreutils', () =>
      expectSkip('info --where coreutils'));
    it('skips help cd', () => expectSkip('help cd'));
    it('skips which node', () => expectSkip('which node'));
    it('skips type npm', () => expectSkip('type npm'));
    it('skips basename /path/to/file', () =>
      expectSkip('basename /path/to/file'));
    it('skips dirname /path/to/file', () =>
      expectSkip('dirname /path/to/file'));
    it('allows realpath with workspace path', () =>
      expectAllowed('realpath ./file'));
  });

  describe('git commands that skip path validation', () => {
    it('skips git status', () => expectSkip('git status'));
    it('skips git log --oneline -5', () => expectSkip('git log --oneline -5'));
    it('skips git diff', () => expectSkip('git diff'));
    it('skips git diff --stat', () => expectSkip('git diff --stat'));
    it('skips git show HEAD', () => expectSkip('git show HEAD'));
    it('skips git blame file.ts', () => expectSkip('git blame file.ts'));
    it('skips git branch -a', () => expectSkip('git branch -a'));
    it('skips git tag -l', () => expectSkip('git tag -l'));
    it('skips git remote -v', () => expectSkip('git remote -v'));
    it('skips git ls-files', () => expectSkip('git ls-files'));
    it('skips git rev-parse --show-toplevel', () =>
      expectSkip('git rev-parse --show-toplevel'));
    it('skips git grep pattern', () => expectSkip('git grep pattern'));
    it('skips git config --list', () => expectSkip('git config --list'));
    it('skips git reflog', () => expectSkip('git reflog'));
    it('skips git worktree list', () => expectSkip('git worktree list'));
  });

  describe('relative paths within workspace — allowed', () => {
    it('allows cat package.json', () => expectAllowed('cat package.json'));
    it('allows cat src/index.ts', () => expectAllowed('cat src/index.ts'));
    it('allows head -n 20 README.md', () =>
      expectAllowed('head -n 20 README.md'));
    it('allows tail -n 100 src/app.ts', () =>
      expectAllowed('tail -n 100 src/app.ts'));
    it('allows wc -l src/main.ts', () => expectAllowed('wc -l src/main.ts'));
    it('allows ls src', () => expectAllowed('ls src'));
    it('allows ls -la packages', () => expectAllowed('ls -la packages'));
    it('allows stat dist/bundle.js', () =>
      expectAllowed('stat dist/bundle.js'));
    it('allows file dist/app', () => expectAllowed('file dist/app'));
    it('allows sort data.txt', () => expectAllowed('sort data.txt'));
    it('allows du -sh src', () => expectAllowed('du -sh src'));
  });

  describe('absolute paths within workspace — allowed', () => {
    it('allows cat with absolute path in workspace', () =>
      expectAllowed(`cat ${PROJECT_CWD}/package.json`));
    it('allows head with absolute path in workspace', () =>
      expectAllowed(`head -n 10 ${PROJECT_CWD}/src/index.ts`));
    it('allows ls with absolute path in workspace', () =>
      expectAllowed(`ls ${PROJECT_CWD}/src`));
  });

  describe('Windows path normalization', () => {
    const WINDOWS_POSIX_CWD = '/d/workspace';
    const WINDOWS_NATIVE_CWD = 'D:\\workspace';

    beforeEach(() => {
      vi.mocked(getPlatform).mockReturnValue('windows');
      // Network-path enforcement reads process.platform directly; stub it so
      // the UNC/device blocks below hold on every CI OS. An ask verdict from
      // the permission pipeline maps to allowed:false here.
      vi.stubGlobal(
        'process',
        Object.create(process, { platform: { get: () => 'win32' } }),
      );
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('allows drive-letter paths with forward slashes inside permission cwd', () =>
      expectAllowed(
        'cat D:/workspace/file',
        WINDOWS_POSIX_CWD,
        WINDOWS_POSIX_CWD,
      ));

    it('allows quoted drive-letter paths with backslashes inside permission cwd', () =>
      expectAllowed(
        "cat 'D:\\workspace\\file'",
        WINDOWS_POSIX_CWD,
        WINDOWS_POSIX_CWD,
      ));

    it('blocks UNC paths without resolving them under cwd', () =>
      expectBlocked(
        "cat '\\\\server\\share\\file'",
        WINDOWS_POSIX_CWD,
        WINDOWS_POSIX_CWD,
      ));

    it('blocks device paths without resolving them under cwd', () =>
      expectBlocked("cat '\\\\.\\COM1'", WINDOWS_POSIX_CWD, WINDOWS_POSIX_CWD));

    it('allows relative paths resolved from a native Windows execution cwd', () =>
      expectAllowed('cat ./src', WINDOWS_NATIVE_CWD, WINDOWS_POSIX_CWD));

    it('allows backslash relative paths resolved from a native Windows execution cwd', () =>
      expectAllowed(
        "cat 'src\\utils\\file.ts'",
        WINDOWS_NATIVE_CWD,
        WINDOWS_POSIX_CWD,
      ));
  });

  describe('non-Windows path behavior', () => {
    it('does not normalize Windows drive-letter syntax', () =>
      expectBlocked('cat D:/workspace/file', '/d/workspace', '/d/workspace'));
  });

  describe('paths outside workspace — blocked', () => {
    it('blocks cat ~/.ssh/id_rsa', () => expectBlocked('cat ~/.ssh/id_rsa'));
    it('blocks head /etc/passwd', () => expectBlocked('head /etc/passwd'));
    it('blocks tail -n 50 /etc/shadow', () =>
      expectBlocked('tail -n 50 /etc/shadow'));
    it('blocks cat /root/.bashrc', () => expectBlocked('cat /root/.bashrc'));
    it('blocks ls /etc', () => expectBlocked('ls /etc'));
    it('blocks wc -l /var/log/syslog', () =>
      expectBlocked('wc -l /var/log/syslog'));
    it('blocks stat /usr/bin/node', () => expectBlocked('stat /usr/bin/node'));
    it('blocks du -sh /tmp', () => expectBlocked('du -sh /tmp'));
  });

  describe('grep/rg: pattern is not treated as path', () => {
    it('allows grep pattern with relative file', () =>
      expectAllowed('grep -n TODO src/main.ts'));
    it('allows rg pattern with relative dir', () =>
      expectAllowed('rg TODO src'));
    it('blocks rg with path outside workspace', () =>
      expectBlocked('rg token /etc'));
    it('blocks grep with path outside workspace', () =>
      expectBlocked('grep password /etc/shadow'));
    it('blocks rg with home dir path', () =>
      expectBlocked('rg secret ~/.config'));
  });

  describe('find command paths', () => {
    it('allows find with relative path', () =>
      expectAllowed('find . -name "*.ts"'));
    it('allows find with relative subdir', () =>
      expectAllowed('find src -name "*.ts"'));
    it('blocks find with absolute path outside workspace', () =>
      expectBlocked('find / -name "*.ts"'));
    it('blocks find with home dir', () =>
      expectBlocked('find ~ -name "*.config"'));
  });

  describe('commands with no positional args — allowed', () => {
    it('allows ls with no args', () => expectAllowed('ls'));
    it('allows ls -la with no path', () => expectAllowed('ls -la'));
  });

  describe('path traversal attempts — blocked', () => {
    it('blocks relative path escaping workspace', () =>
      expectBlocked('cat ../../etc/passwd'));
    it('blocks deeply nested traversal', () =>
      expectBlocked('cat ../../../root/.ssh/id_rsa'));
  });

  describe('2>&1 suffix handling', () => {
    it('allows command with 2>&1 and workspace path', () =>
      expectAllowed('cat package.json 2>&1'));
    it('blocks command with 2>&1 and outside path', () =>
      expectBlocked('cat /etc/passwd 2>&1'));
  });

  // ==========================================================================
  // Security fixes: Issue 5 — realpath/readlink path validation
  // ==========================================================================
  describe('realpath/readlink path validation (Issue 5)', () => {
    it('allows realpath with workspace-relative path', () =>
      expectAllowed('realpath ./file'));
    it('allows realpath src/index.ts', () =>
      expectAllowed('realpath src/index.ts'));
    it('allows readlink src/link', () => expectAllowed('readlink src/link'));
    it('allows realpath -s ./file', () => expectAllowed('realpath -s ./file'));
    it('allows realpath with absolute workspace path', () =>
      expectAllowed(`realpath ${PROJECT_CWD}/file`));
    it('allows realpath with no args', () => expectAllowed('realpath'));
    it('allows readlink with no args', () => expectAllowed('readlink'));

    it('blocks realpath /etc/passwd', () =>
      expectBlocked('realpath /etc/passwd'));
    it('blocks readlink /etc/shadow', () =>
      expectBlocked('readlink /etc/shadow'));
    it('blocks realpath ~/.ssh/id_rsa', () =>
      expectBlocked('realpath ~/.ssh/id_rsa'));
    it('blocks readlink /usr/bin/node', () =>
      expectBlocked('readlink /usr/bin/node'));

    // basename/dirname remain skipped (string manipulation only)
    it('still skips basename /etc/passwd', () =>
      expectSkip('basename /etc/passwd'));
    it('still skips dirname /etc/passwd', () =>
      expectSkip('dirname /etc/passwd'));
  });

  // ==========================================================================
  // Security fixes: Issue 1 — git diff/grep --no-index bypass
  // ==========================================================================
  describe('git diff/grep --no-index path validation (Issue 1)', () => {
    // Without --no-index: should skip (operates within git repo)
    it('still skips git diff without --no-index', () => expectSkip('git diff'));
    it('still skips git diff --stat', () => expectSkip('git diff --stat'));
    it('still skips git diff HEAD~1', () => expectSkip('git diff HEAD~1'));
    it('still skips git grep pattern', () => expectSkip('git grep pattern'));
    it('still skips git grep -i pattern', () =>
      expectSkip('git grep -i pattern'));

    // With --no-index and workspace paths → allowed
    it('allows git diff --no-index with workspace paths', () =>
      expectAllowed('git diff --no-index file1.txt file2.txt'));
    it('allows git grep --no-index pattern src/', () =>
      expectAllowed('git grep --no-index pattern src/'));

    // With --no-index and paths outside workspace → blocked
    it('blocks git diff --no-index /etc/passwd /etc/shadow', () =>
      expectBlocked('git diff --no-index /etc/passwd /etc/shadow'));
    it('blocks git grep --no-index pattern /etc/', () =>
      expectBlocked('git grep --no-index pattern /etc/'));
    it('blocks git diff --no-index /etc/passwd ./local.txt', () =>
      expectBlocked('git diff --no-index /etc/passwd ./local.txt'));
  });

  // ==========================================================================
  // Security fixes: Issue 3 — deny behavior preserved
  // ==========================================================================
  describe('deny/ask behavior preserved (Issue 3)', () => {
    it('returns behavior field when path is outside workspace', () => {
      const result = checkReadOnlyShellPathConstraints(
        'cat /etc/passwd',
        makeContext(),
        PROJECT_CWD,
      );
      expect(result.allowed).toBe(false);
      if (result.allowed === false) {
        // checkReadPermissionForPath returns 'ask' for paths outside workspace
        // (unless there's an explicit deny rule)
        expect(result.behavior).toBeDefined();
        expect(result.decision).toMatchObject({
          kind: 'ask',
          reason: { blockedPath: '/etc/passwd' },
        });
      }
    });
  });

  // ==========================================================================
  // Security fixes: Issue 4 — diff --from-file + unknown flag fail-closed
  // ==========================================================================
  describe('diff --from-file/--to-file and unknown flags (Issue 4)', () => {
    it('blocks diff --from-file=/etc/passwd a.txt', () =>
      expectBlocked('diff --from-file=/etc/passwd a.txt'));
    it('blocks diff --to-file=/etc/shadow a.txt b.txt', () =>
      expectBlocked('diff --to-file=/etc/shadow a.txt b.txt'));
    it('allows diff --from-file=ref.txt a.txt', () =>
      expectAllowed('diff --from-file=ref.txt a.txt'));
    it('allows diff --to-file=out.txt a.txt', () =>
      expectAllowed('diff --to-file=out.txt a.txt'));

    // Unknown flags — fail closed
    it('blocks diff --unknown-flag=value a.txt', () =>
      expectBlocked('diff --unknown-flag=value a.txt'));
    it('blocks cat --secret-output=/etc/shadow file.txt', () =>
      expectBlocked('cat --secret-output=/etc/shadow file.txt'));
    it('allows diff -u a.txt b.txt (known flags only)', () =>
      expectAllowed('diff -u a.txt b.txt'));
  });

  // ==========================================================================
  // Security fixes: Issue 2 — grep/rg pattern vs path distinction
  // ==========================================================================
  describe('grep/rg -e/--regexp pattern detection (Issue 2)', () => {
    // Standard form: first positional is pattern, second is path
    it('allows grep pattern file (normal form)', () =>
      expectAllowed('grep TODO src/main.ts'));
    it('blocks grep pattern /etc (normal form)', () =>
      expectBlocked('grep password /etc/shadow'));

    // -e form: all positionals are paths
    it('allows grep -e pattern src/', () => expectAllowed('grep -e TODO src/'));
    it('blocks grep -e pattern /etc/', () =>
      expectBlocked('grep -e TODO /etc/'));
    it('allows rg -e pattern src/', () => expectAllowed('rg -e TODO src/'));
    it('blocks rg -e pattern /etc/', () => expectBlocked('rg -e TODO /etc/'));

    // --regexp= form
    it('blocks grep --regexp=pattern /etc/', () =>
      expectBlocked('grep --regexp=TODO /etc/'));

    // Bundled flags with 'e' (e.g. -ie)
    it('blocks grep -ie pattern /etc/', () =>
      expectBlocked('grep -ie TODO /etc/'));

    // -f/--file flag values are paths
    it('allows grep -f patterns.txt src/', () =>
      expectAllowed('grep -f patterns.txt src/'));
    it('blocks grep -f /etc/passwd src/', () =>
      expectBlocked('grep -f /etc/passwd src/'));
    it('blocks grep --file=/etc/passwd src/', () =>
      expectBlocked('grep --file=/etc/passwd src/'));
    it('blocks rg -f /etc/passwd src/', () =>
      expectBlocked('rg -f /etc/passwd src/'));
  });

  // ==========================================================================
  // Security fixes: attached short flag values (-f/path)
  // ==========================================================================
  describe('attached short flag path values', () => {
    // -f/etc/passwd (attached value, not separated)
    it('blocks grep -f/etc/passwd package.json', () =>
      expectBlocked('grep -f/etc/passwd package.json'));
    it('blocks rg -f/etc/passwd package.json', () =>
      expectBlocked('rg -f/etc/passwd package.json'));

    // Workspace-relative attached value → allowed
    it('allows grep -fpatterns.txt src/', () =>
      expectAllowed('grep -fpatterns.txt src/'));

    // diff with attached value on unknown flag
    it('blocks diff -X/etc/passwd a.txt b.txt', () =>
      expectBlocked('diff -X/etc/passwd a.txt b.txt'));
  });

  // ==========================================================================
  // Security fixes: --exclude-from and other path-reading flags
  // ==========================================================================
  describe('path-reading flags beyond -f/--file', () => {
    it('blocks grep --exclude-from=/etc/passwd TODO package.json', () =>
      expectBlocked('grep --exclude-from=/etc/passwd TODO package.json'));
    it('blocks grep --exclude-from /etc/passwd TODO package.json', () =>
      expectBlocked('grep --exclude-from /etc/passwd TODO package.json'));
    it('allows grep --exclude-from=patterns.txt TODO src/', () =>
      expectAllowed('grep --exclude-from=patterns.txt TODO src/'));
    it('blocks wc --files0-from=/etc/shadow', () =>
      expectBlocked('wc --files0-from=/etc/shadow'));
    it('blocks wc --files0-from /etc/shadow', () =>
      expectBlocked('wc --files0-from /etc/shadow'));
    it('blocks wc --files0-from with workspace file list', () =>
      expectBlocked('wc --files0-from file-list.txt'));
  });

  // ==========================================================================
  // Security fixes: git grep --no-index -f/path
  // ==========================================================================
  describe('git grep --no-index with -f flag', () => {
    it('blocks git grep --no-index -f/etc/passwd package.json', () =>
      expectBlocked('git grep --no-index -f/etc/passwd package.json'));
    it('blocks git grep --no-index -f /etc/passwd package.json', () =>
      expectBlocked('git grep --no-index -f /etc/passwd package.json'));
    it('allows git grep --no-index -f patterns.txt src/', () =>
      expectAllowed('git grep --no-index -f patterns.txt src/'));
  });

  // ==========================================================================
  // Security fixes: -f/--file provides pattern, so positionals are paths
  // ==========================================================================
  describe('-f/--file pattern providers', () => {
    it('blocks grep -f patterns.txt /etc/passwd', () =>
      expectBlocked('grep -f patterns.txt /etc/passwd'));
    it('blocks grep --file=patterns.txt /etc/passwd', () =>
      expectBlocked('grep --file=patterns.txt /etc/passwd'));
    it('blocks grep --file patterns.txt /etc/passwd', () =>
      expectBlocked('grep --file patterns.txt /etc/passwd'));
    it('blocks rg -f patterns.txt /etc', () =>
      expectBlocked('rg -f patterns.txt /etc'));
    it('blocks rg --file=patterns.txt /etc', () =>
      expectBlocked('rg --file=patterns.txt /etc'));
    it('blocks git grep --no-index -f patterns.txt /etc/passwd', () =>
      expectBlocked('git grep --no-index -f patterns.txt /etc/passwd'));

    it('allows grep -f patterns.txt src/main.ts', () =>
      expectAllowed('grep -f patterns.txt src/main.ts'));
    it('allows rg --file=patterns.txt src', () =>
      expectAllowed('rg --file=patterns.txt src'));
    it('allows git grep --no-index -f patterns.txt src', () =>
      expectAllowed('git grep --no-index -f patterns.txt src'));
  });

  describe('rg modes without a search pattern', () => {
    it('blocks rg --files with outside path', () =>
      expectBlocked('rg --files /etc'));
    it('blocks rg --files with home path', () =>
      expectBlocked('rg --files ~/.config'));
    it('allows rg --files with workspace path', () =>
      expectAllowed('rg --files src'));
    it('allows rg --files without explicit path', () =>
      expectAllowed('rg --files'));
  });

  describe('execution cwd and permission cwd are distinct', () => {
    it('blocks relative path resolved outside permission cwd', () =>
      expectBlocked('cat passwd', '/etc', PROJECT_CWD));
    it('blocks grep path resolved outside permission cwd', () =>
      expectBlocked('grep root passwd', '/etc', PROJECT_CWD));
    it('allows relative path resolved inside permission cwd', () =>
      expectAllowed('cat package.json', PROJECT_CWD, PROJECT_CWD));
    it('allows nested execution cwd inside permission cwd', () =>
      expectAllowed(
        'cat package.json',
        `${PROJECT_CWD}/packages/core`,
        PROJECT_CWD,
      ));
    it('allows relative traversal that stays inside permission cwd', () =>
      expectAllowed(
        'cat ../../package.json',
        `${PROJECT_CWD}/packages/core`,
        PROJECT_CWD,
      ));
    it('blocks relative traversal that escapes permission cwd', () =>
      expectBlocked(
        'cat ../../../.ssh/id_rsa',
        `${PROJECT_CWD}/packages/core`,
        PROJECT_CWD,
      ));
  });

  // ==========================================================================
  // Phase 3 收尾: git ls-remote skips path check
  // ==========================================================================
  describe('git ls-remote skips path check', () => {
    it('skips git ls-remote', () => expectSkip('git ls-remote'));
    it('skips git ls-remote origin', () => expectSkip('git ls-remote origin'));
    it('skips git ls-remote --heads origin', () =>
      expectSkip('git ls-remote --heads origin'));
  });

  // ==========================================================================
  // Phase 4B: checksum commands path validation
  // ==========================================================================
  describe('checksum commands path validation', () => {
    it('allows sha256sum with workspace file', () =>
      expectAllowed('sha256sum package.json'));
    it('allows sha1sum with workspace file', () =>
      expectAllowed('sha1sum README.md'));
    it('allows md5sum with workspace file', () =>
      expectAllowed('md5sum src/index.ts'));
    it('allows sha256sum with multiple workspace files', () =>
      expectAllowed('sha256sum package.json README.md'));

    it('blocks sha256sum /etc/passwd', () =>
      expectBlocked('sha256sum /etc/passwd'));
    it('blocks sha1sum ~/.ssh/id_rsa', () =>
      expectBlocked('sha1sum ~/.ssh/id_rsa'));
    it('blocks md5sum /etc/shadow', () => expectBlocked('md5sum /etc/shadow'));
  });

  // ==========================================================================
  // Phase 4B: tree command path validation
  // ==========================================================================
  describe('tree command path validation', () => {
    it('allows tree with workspace path', () => expectAllowed('tree src'));
    it('allows tree with relative path', () =>
      expectAllowed('tree packages/core'));
    it('allows tree -L 2 with workspace path', () =>
      expectAllowed('tree -L 2 packages'));

    it('blocks tree /etc', () => expectBlocked('tree /etc'));
    it('blocks tree ~/.config', () => expectBlocked('tree ~/.config'));
    it('blocks tree /usr/local', () => expectBlocked('tree /usr/local'));
  });

  // ==========================================================================
  // Phase 4C: fd / fdfind path validation
  // ==========================================================================
  describe('fd / fdfind path validation', () => {
    it('allows fd with workspace search root', () =>
      expectAllowed('fd pattern src'));
    it('allows fd with relative search root', () =>
      expectAllowed('fd pattern packages/core'));
    it('allows fd with multiple workspace roots', () =>
      expectAllowed('fd pattern src packages'));
    it('allows fdfind with workspace root', () =>
      expectAllowed('fdfind pattern src'));
    it('allows fd with no path (defaults to .)', () =>
      expectAllowed('fd pattern'));
    it('allows fd -e ts with workspace root', () =>
      expectAllowed('fd -e ts pattern src'));

    it('blocks fd with /etc search root', () =>
      expectBlocked('fd pattern /etc'));
    it('blocks fd with absolute path outside workspace', () =>
      expectBlocked('fd pattern /usr/local'));
    it('blocks fd with home path search root', () =>
      expectBlocked('fd pattern ~/.ssh'));
    it('blocks fdfind with /etc search root', () =>
      expectBlocked('fdfind pattern /etc'));

    // Path-valued flags validation
    it('blocks fd --search-path /etc', () =>
      expectBlocked('fd --search-path /etc pattern'));
    it('blocks fd --base-directory /etc', () =>
      expectBlocked('fd --base-directory /etc pattern'));
    it('allows fd --search-path with workspace path', () =>
      expectAllowed('fd --search-path src pattern'));
    it('allows fd --base-directory with workspace path', () =>
      expectAllowed('fd --base-directory packages pattern'));
  });

  // ==========================================================================
  // Phase 4D: sed path validation
  // ==========================================================================
  describe('sed path validation', () => {
    it('allows sed with workspace file', () =>
      expectAllowed("sed 's/foo/bar/' src/index.ts"));
    it('allows sed with multiple workspace files', () =>
      expectAllowed("sed 's/foo/bar/' src/a.ts src/b.ts"));
    it('allows sed -n with workspace file', () =>
      expectAllowed("sed -n '1,20p' README.md"));
    it('allows sed -f with workspace script file', () =>
      expectAllowed('sed -f scripts/fix.sed src/main.ts'));

    it('blocks sed with /etc/passwd', () =>
      expectBlocked("sed -n '1p' /etc/passwd"));
    it('blocks sed with home directory file', () =>
      expectBlocked("sed 's/foo/bar/' ~/.bashrc"));
    it('blocks sed -f with path outside workspace', () =>
      expectBlocked('sed -f /etc/scripts/exploit.sed file.txt'));
  });

  // ==========================================================================
  // Phase 4E: jq path validation
  // ==========================================================================
  describe('jq path validation', () => {
    it('allows jq with workspace file', () =>
      expectAllowed('jq . package.json'));
    it('allows jq -r with workspace file', () =>
      expectAllowed("jq -r '.name' package.json"));
    it('allows jq with multiple workspace files', () =>
      expectAllowed("jq '.' src/a.json src/b.json"));
    it('allows jq with no file (stdin)', () => expectAllowed("jq '.'"));

    it('blocks jq with /etc/passwd', () => expectBlocked("jq '.' /etc/passwd"));
    it('blocks jq with home directory file', () =>
      expectBlocked("jq '.' ~/.config/secret.json"));
  });
});
