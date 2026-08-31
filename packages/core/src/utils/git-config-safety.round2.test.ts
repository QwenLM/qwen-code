/**
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
    expect(await isShellCommandReadOnlyASTInDirectory('git status', cwd)).toBe(
      true,
    );
  });

  it('gates repository-local pager commands', async () => {
    const cwd = createRepo();
    config(cwd, 'pager.log', '/tmp/pager-helper');
    expect(getLocalGitConfigRisk(cwd).pager).toBe(true);
    expect(await isShellCommandReadOnlyASTInDirectory('git log -1', cwd)).toBe(
      false,
    );
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
    expect(await isShellCommandReadOnlyASTInDirectory('git status', cwd)).toBe(
      true,
    );
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
    expect(await isShellCommandReadOnlyASTInDirectory('git log -1', cwd)).toBe(
      true,
    );
  });

  it('fails closed for covered Git config hooks when the AST parser is unavailable', async () => {
    const cwd = createRepo();
    config(cwd, 'pager.status', '/tmp/pager-helper');
    _setParserFailedForTesting();
    expect(await isShellCommandReadOnlyASTInDirectory('git status', cwd)).toBe(
      false,
    );
  });
});
