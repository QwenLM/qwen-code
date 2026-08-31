from pathlib import Path

# 1. Preserve env assignments at the permission boundary before wrapper stripping.
p = Path('packages/core/src/tools/shell.ts')
s = p.read_text()
marker = """/**
 * Escape `s` so it is safe to interpolate inside a bash double-quoted
 * string."""
helper = """function hasLeadingEnvironmentAssignment(command: string): boolean {
  try {
    const first = parse(command)[0];
    return (
      typeof first === 'string' &&
      /^[A-Za-z_][A-Za-z0-9_]*=/.test(first)
    );
  } catch {
    // A parse failure must not make a wrapper look safer than it is.
    return true;
  }
}

/**
 * Escape `s` so it is safe to interpolate inside a bash double-quoted
 * string."""
if 'function hasLeadingEnvironmentAssignment' not in s:
    if marker not in s:
        raise SystemExit('shell helper insertion marker not found')
    s = s.replace(marker, helper, 1)
old = """    if (hasShellSubstitution(this.params.command)) {
      return 'ask';
    }

    const command = stripShellWrapper(this.params.command);"""
new = """    if (
      hasShellSubstitution(this.params.command) ||
      hasLeadingEnvironmentAssignment(this.params.command)
    ) {
      return 'ask';
    }

    const command = stripShellWrapper(this.params.command);"""
if old in s:
    s = s.replace(old, new, 1)
elif 'hasLeadingEnvironmentAssignment(this.params.command)' not in s:
    raise SystemExit('default permission marker not found')
s = s.replace(
    """   * - Substitution-bearing commands (any form, including inside an
   *   env-prefix wrapper that `stripShellWrapper` would discard) → 'ask'
   * - Read-only commands (via AST analysis) → 'allow'""",
    """   * - Substitution-bearing commands (any form, including inside an
   *   env-prefix wrapper that `stripShellWrapper` would discard) → 'ask'
   * - Commands with leading environment assignments → 'ask' before wrapper stripping
   * - Read-only commands (via AST analysis) → 'allow'""",
    1,
)
p.write_text(s)

# 2. Update the now-obsolete fsmonitor expectation.
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
if old not in s:
    raise SystemExit('fsmonitor expectation marker not found')
s = s.replace(old, new, 1)
p.write_text(s)

# 3. Add the end-to-end permission regression to shell.test.ts.
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
        raise SystemExit('shell test marker not found')
    s = s.replace(marker, test + marker, 1)
p.write_text(s)

# 4. Add focused Round-3 regression coverage.
p = Path('packages/core/src/utils/git-config-safety.round3.test.ts')
p.write_text(r'''/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getLocalGitConfigRisk } from './git-config-safety.js';
import {
  _resetParser,
  _setParserFailedForTesting,
  classifyShellCommandSafety,
  classifyShellCommandSafetyInDirectory,
  initParser,
  isShellCommandReadOnlyASTInDirectory,
} from './shellAstParser.js';
import { isShellCommandReadOnly } from './shellReadOnlyChecker.js';

describe.sequential('repository-local Git execution hooks (round 3)', () => {
  const tempDirs: string[] = [];
  const createRepo = (): string => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'qwen-git-r3-'));
    tempDirs.push(cwd);
    execFileSync('git', ['init', '-q'], { cwd });
    return cwd;
  };
  const config = (cwd: string, key: string, value: string): void => {
    execFileSync('git', ['config', '--local', key, value], { cwd });
  };

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

  it('gates pager commands from repository-local config', async () => {
    const cwd = createRepo();
    config(cwd, 'pager.log', '/tmp/pager-helper');
    expect(getLocalGitConfigRisk(cwd).pager).toBe(true);
    expect(
      await classifyShellCommandSafetyInDirectory('git log -1', cwd),
    ).toBe('unknown');
  });

  it('ignores boolean core.pager values but gates command values', () => {
    const cwd = createRepo();
    config(cwd, 'core.pager', 'false');
    expect(getLocalGitConfigRisk(cwd).pager).toBe(false);
    config(cwd, 'core.pager', '/tmp/pager-helper');
    expect(getLocalGitConfigRisk(cwd).pager).toBe(true);
  });

  it('gates configured signature verification programs for log and show', async () => {
    const cwd = createRepo();
    config(cwd, 'log.showSignature', 'true');
    config(cwd, 'gpg.program', '/tmp/gpg-helper');
    expect(getLocalGitConfigRisk(cwd).signatureVerifier).toBe(true);
    for (const command of ['git log -1', 'git show HEAD']) {
      expect(await classifyShellCommandSafetyInDirectory(command, cwd)).toBe(
        'unknown',
      );
    }
    expect(
      await classifyShellCommandSafetyInDirectory('git status', cwd),
    ).toBe('read-only');
  });

  it('gates fsmonitor for grep and ls-files', async () => {
    const cwd = createRepo();
    config(cwd, 'core.fsmonitor', '/tmp/fsmonitor-helper');
    for (const command of ['git grep needle', 'git ls-files']) {
      expect(await classifyShellCommandSafetyInDirectory(command, cwd)).toBe(
        'unknown',
      );
    }
  });

  it('gates clean/process filters for worktree consumers including ls-files -m', async () => {
    const cwd = createRepo();
    config(cwd, 'filter.demo.process', '/tmp/filter-helper');
    expect(getLocalGitConfigRisk(cwd).worktreeFilter).toBe(true);
    for (const command of [
      'git blame file.txt',
      'git diff',
      'git status',
      'git ls-files -m',
    ]) {
      expect(await classifyShellCommandSafetyInDirectory(command, cwd)).toBe(
        'unknown',
      );
    }
    expect(
      await classifyShellCommandSafetyInDirectory('git ls-files', cwd),
    ).toBe('read-only');
  });

  it('gates partial clone lazy-fetch consumers without over-gating commit-only log', async () => {
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
      expect(await classifyShellCommandSafetyInDirectory(command, cwd)).toBe(
        'unknown',
      );
    }
    expect(
      await classifyShellCommandSafetyInDirectory('git log -1', cwd),
    ).toBe('read-only');
  });

  it('keeps all covered config hooks fail-closed in regex fallback mode', async () => {
    const cwd = createRepo();
    config(cwd, 'pager.status', '/tmp/pager-helper');
    _setParserFailedForTesting();
    expect(
      await isShellCommandReadOnlyASTInDirectory('git status', cwd),
    ).toBe(false);
  });
});
''')
