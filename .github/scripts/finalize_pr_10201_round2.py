from pathlib import Path

# Close the raw env-prefix bypass at the real permission boundary.
p = Path('packages/core/src/tools/shell.ts')
s = p.read_text()
old = """    if (hasShellSubstitution(this.params.command)) {
      return 'ask';
    }

    const command = stripShellWrapper(this.params.command);"""
new = """    // GIT_CONFIG_COUNT/GIT_CONFIG_KEY_* can inject executable Git config
    // only into the spawned child. Keep all leading env assignments visible
    // to the permission boundary instead of stripping them first.
    if (
      hasShellSubstitution(this.params.command) ||
      LEADING_ENV_ASSIGNMENT_RE.test(this.params.command)
    ) {
      return 'ask';
    }

    const command = stripShellWrapper(this.params.command);"""
if old not in s and 'LEADING_ENV_ASSIGNMENT_RE.test(this.params.command)' not in s:
    raise SystemExit('shell.ts permission marker not found')
if old in s:
    s = s.replace(old, new, 1)
s = s.replace(
    """   *   env-prefix wrapper that `stripShellWrapper` would discard) → 'ask'
   * - Read-only commands (via AST analysis) → 'allow'""",
    """   *   env-prefix wrapper that `stripShellWrapper` would discard) → 'ask'
   * - Commands with leading environment assignments → 'ask' before wrapper stripping
   * - Read-only commands (via AST analysis) → 'allow'""",
    1,
)
p.write_text(s)

# Keep the on-disk config classifier's responsibility explicit. The raw env
# injection route is intentionally handled one layer earlier in shell.ts.
p = Path('packages/core/src/utils/shellAstParser.ts')
s = p.read_text()
marker = """function fallbackGitConfigMakesCommandUnsafe(
  command: string,
  cwd: string,
): boolean {"""
replacement = """// GIT_CONFIG_COUNT/GIT_CONFIG_KEY_* are rejected at the raw shell permission
// boundary before wrapper stripping; this layer protects on-disk repository config.
function fallbackGitConfigMakesCommandUnsafe(
  command: string,
  cwd: string,
): boolean {"""
if marker in s and 'GIT_CONFIG_COUNT/GIT_CONFIG_KEY_*' not in s:
    s = s.replace(marker, replacement, 1)
p.write_text(s)

# Update the original fsmonitor regression: it is not status-only.
p = Path('packages/core/src/utils/shellAstParser.test.ts')
s = p.read_text()
s = s.replace(
    "it('downgrades only the two reproduced command/config pairs', async () => {",
    "it('downgrades Git commands for the repository-local hooks they consume', async () => {",
    1,
)
old = """      gitConfig(cwd, '--unset', 'diff.external');
      gitConfig(cwd, 'core.fsmonitor', 'example-fsmonitor');
      expect(
        await isShellCommandReadOnlyASTInDirectory('git status', cwd),
      ).toBe(false);
      expect(await isShellCommandReadOnlyASTInDirectory('git diff', cwd)).toBe(
        true,
      );"""
new = """      gitConfig(cwd, '--unset', 'diff.external');
      gitConfig(cwd, 'core.fsmonitor', 'example-fsmonitor');
      for (const command of [
        'git status',
        'git diff',
        'git blame file.txt',
        'git grep needle',
        'git ls-files',
      ]) {
        expect(await isShellCommandReadOnlyASTInDirectory(command, cwd)).toBe(
          false,
        );
      }"""
if old not in s and "'git grep needle'" not in s:
    raise SystemExit('shellAstParser.test.ts fsmonitor marker not found')
if old in s:
    s = s.replace(old, new, 1)
p.write_text(s)

# Add an end-to-end permission regression for the exact env-injection class.
p = Path('packages/core/src/tools/shell.test.ts')
s = p.read_text()
marker = """    it('should request confirmation for a non-read-only command and return details', async () => {"""
if 'should keep env-prefixed Git wrappers confirmable before stripping' not in s:
    test = """    it('should keep env-prefixed Git wrappers confirmable before stripping', async () => {
      for (const command of [
        `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=diff.external GIT_CONFIG_VALUE_0=/tmp/helper bash -c 'git diff'`,
        `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.fsmonitor GIT_CONFIG_VALUE_0=/tmp/helper git status`,
      ]) {
        const invocation = shellTool.build({
          command,
          is_background: false,
        });

        expect(await invocation.getDefaultPermission()).toBe('ask');
      }
    });

"""
    if marker not in s:
        raise SystemExit('shell.test.ts insertion marker not found')
    s = s.replace(marker, test + marker, 1)
p.write_text(s)

# Focused regression file for every execution path raised in the latest review.
p = Path('packages/core/src/utils/git-config-safety.round2.test.ts')
p.write_text(r'''/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { getLocalGitConfigRisk } from './git-config-safety.js';
import {
  _resetParser,
  _setParserFailedForTesting,
  classifyShellCommandSafety,
  initParser,
  isShellCommandReadOnlyASTInDirectory,
} from './shellAstParser.js';
import { isShellCommandReadOnly } from './shellReadOnlyChecker.js';

describe.sequential('repository-local Git execution hooks', () => {
  const tempDirs: string[] = [];

  const createRepo = (): string => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'qwen-git-config-r2-'));
    tempDirs.push(cwd);
    execFileSync('git', ['init', '-q'], { cwd });
    return cwd;
  };

  const config = (cwd: string, key: string, value: string): void => {
    execFileSync('git', ['config', '--local', key, value], { cwd });
  };

  beforeAll(async () => {
    await initParser();
  });

  afterEach(async () => {
    _resetParser();
    await initParser();
    for (const cwd of tempDirs.splice(0)) {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('requires no-query mode for git remote show in AST and regex classifiers', async () => {
    expect(await classifyShellCommandSafety('git remote show origin')).toBe(
      'unknown',
    );
    expect(await classifyShellCommandSafety('git remote show -n origin')).toBe(
      'read-only',
    );
    expect(
      await classifyShellCommandSafety('git remote show --no-query origin'),
    ).toBe('read-only');
    expect(isShellCommandReadOnly('git remote show origin')).toBe(false);
    expect(isShellCommandReadOnly('git remote show -n origin')).toBe(true);
  });

  it('gates command-form fsmonitor for every covered index/worktree consumer', async () => {
    const cwd = createRepo();
    config(cwd, 'core.fsmonitor', '/tmp/fsmonitor-helper');
    expect(getLocalGitConfigRisk(cwd).fsmonitor).toBe(true);

    for (const command of [
      'git status',
      'git diff',
      'git blame file.txt',
      'git grep needle',
      'git ls-files',
    ]) {
      expect(await isShellCommandReadOnlyASTInDirectory(command, cwd)).toBe(
        false,
      );
    }
  });

  it('does not mistake boolean fsmonitor values for helper commands', async () => {
    const cwd = createRepo();
    config(cwd, 'core.fsmonitor', 'false');
    expect(getLocalGitConfigRisk(cwd).fsmonitor).toBe(false);
    expect(
      await isShellCommandReadOnlyASTInDirectory('git status', cwd),
    ).toBe(true);
  });

  it('gates repository-local pager commands', async () => {
    const cwd = createRepo();
    config(cwd, 'pager.log', '/tmp/pager-helper');
    expect(getLocalGitConfigRisk(cwd).pager).toBe(true);
    expect(
      await isShellCommandReadOnlyASTInDirectory('git log -1', cwd),
    ).toBe(false);
  });

  it('keeps boolean core.pager values non-executable', () => {
    const cwd = createRepo();
    config(cwd, 'core.pager', 'false');
    expect(getLocalGitConfigRisk(cwd).pager).toBe(false);
    config(cwd, 'core.pager', '/tmp/pager-helper');
    expect(getLocalGitConfigRisk(cwd).pager).toBe(true);
  });

  it('gates configured signature verifier programs for log and show', async () => {
    const cwd = createRepo();
    config(cwd, 'log.showSignature', 'true');
    config(cwd, 'gpg.program', '/tmp/gpg-helper');
    expect(getLocalGitConfigRisk(cwd).signatureVerifier).toBe(true);

    for (const command of ['git log -1', 'git show HEAD']) {
      expect(await isShellCommandReadOnlyASTInDirectory(command, cwd)).toBe(
        false,
      );
    }
    expect(
      await isShellCommandReadOnlyASTInDirectory('git status', cwd),
    ).toBe(true);
  });

  it('gates clean/process filters only for worktree-content consumers', async () => {
    const cwd = createRepo();
    config(cwd, 'filter.demo.process', '/tmp/filter-helper');
    expect(getLocalGitConfigRisk(cwd).worktreeFilter).toBe(true);

    for (const command of [
      'git blame file.txt',
      'git diff',
      'git status',
      'git ls-files -m',
    ]) {
      expect(await isShellCommandReadOnlyASTInDirectory(command, cwd)).toBe(
        false,
      );
    }
    expect(
      await isShellCommandReadOnlyASTInDirectory('git ls-files', cwd),
    ).toBe(true);
  });

  it('gates partial-clone lazy-fetch consumers without over-gating commit-only log', async () => {
    const cwd = createRepo();
    config(cwd, 'extensions.partialClone', 'origin');
    expect(getLocalGitConfigRisk(cwd).promisorRemote).toBe(true);

    for (const command of [
      'git blame file.txt',
      'git cat-file -p HEAD:file',
      'git diff',
      'git grep needle HEAD',
      'git log -p -1',
      'git show HEAD',
    ]) {
      expect(await isShellCommandReadOnlyASTInDirectory(command, cwd)).toBe(
        false,
      );
    }
    expect(
      await isShellCommandReadOnlyASTInDirectory('git log -1', cwd),
    ).toBe(true);
  });

  it('fails closed for covered Git config hooks when the AST parser is unavailable', async () => {
    const cwd = createRepo();
    config(cwd, 'pager.status', '/tmp/pager-helper');
    _setParserFailedForTesting();
    expect(
      await isShellCommandReadOnlyASTInDirectory('git status', cwd),
    ).toBe(false);
  });
});
''')
