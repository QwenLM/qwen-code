/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
    const cwd = mkdtempSync(path.join(tmpdir(), 'qwen-git-config-'));
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

  it('keeps AST and fallback Git helper rules in lockstep', async () => {
    const cases: Array<{
      command: string;
      ast: 'read-only' | 'unknown';
      fallback: boolean;
    }> = [
      { command: 'git remote show -n origin', ast: 'read-only', fallback: true },
      {
        command: 'git remote show origin -- -n',
        ast: 'unknown',
        fallback: false,
      },
      { command: 'git show --remerge-diff', ast: 'unknown', fallback: false },
      {
        command: 'git log --diff-merges=remerge -1',
        ast: 'unknown',
        fallback: false,
      },
      {
        command: 'git log --diff-merges=r -1',
        ast: 'unknown',
        fallback: false,
      },
      { command: 'git log --format=%G? -1', ast: 'unknown', fallback: false },
    ];

    for (const testCase of cases) {
      expect(await classifyShellCommandSafety(testCase.command)).toBe(
        testCase.ast,
      );
      expect(isShellCommandReadOnly(testCase.command)).toBe(testCase.fallback);
    }
  });

  it('requires no-query mode before the option terminator for git remote show', async () => {
    expect(await classifyShellCommandSafety('git remote show origin')).toBe(
      'unknown',
    );
    expect(await classifyShellCommandSafety('git remote show -n origin')).toBe(
      'read-only',
    );
    expect(
      await classifyShellCommandSafety('git remote show --no-query origin'),
    ).toBe('read-only');
    expect(
      await classifyShellCommandSafety('git remote show origin -- -n'),
    ).toBe('unknown');

    expect(isShellCommandReadOnly('git remote show origin')).toBe(false);
    expect(isShellCommandReadOnly('git remote show -n origin')).toBe(true);
    expect(isShellCommandReadOnly('git remote show origin -- -n')).toBe(false);
  });

  it('gates command-form fsmonitor with a default-deny consumer model', async () => {
    const cwd = createRepo();
    config(cwd, 'core.fsmonitor', '/tmp/fsmonitor-helper');
    expect(getLocalGitConfigRisk(cwd).fsmonitor).toBe(true);

    for (const command of [
      'git status',
      'git diff',
      'git blame file.txt',
      'git grep needle',
      'git ls-files',
      'git describe --dirty',
      'git describe --broken',
    ]) {
      expect(await isShellCommandReadOnlyASTInDirectory(command, cwd)).toBe(
        false,
      );
    }

    for (const command of [
      'git log -1',
      'git show HEAD',
      'git rev-parse HEAD',
    ]) {
      expect(await isShellCommandReadOnlyASTInDirectory(command, cwd)).toBe(
        true,
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

  it('gates repository-local pager commands but not boolean pager values', async () => {
    const commandCwd = createRepo();
    config(commandCwd, 'pager.log', '/tmp/pager-helper');
    expect(getLocalGitConfigRisk(commandCwd).pager).toBe(true);
    expect(
      await isShellCommandReadOnlyASTInDirectory('git log -1', commandCwd),
    ).toBe(false);

    const coreCommandCwd = createRepo();
    config(coreCommandCwd, 'core.pager', '/tmp/core-pager-helper');
    expect(getLocalGitConfigRisk(coreCommandCwd).pager).toBe(true);
    expect(
      await isShellCommandReadOnlyASTInDirectory('git status', coreCommandCwd),
    ).toBe(false);

    for (const value of ['false', 'true', '0', '1']) {
      const cwd = createRepo();
      config(cwd, 'core.pager', value);
      expect(getLocalGitConfigRisk(cwd).pager).toBe(false);
    }

    const commandSpecificCwd = createRepo();
    config(commandSpecificCwd, 'pager.status', 'false');
    expect(getLocalGitConfigRisk(commandSpecificCwd).pager).toBe(false);
    expect(
      await isShellCommandReadOnlyASTInDirectory(
        'git status',
        commandSpecificCwd,
      ),
    ).toBe(true);
  });

  it('uses fail-closed Git boolean semantics for signature and promisor switches', async () => {
    for (const value of ['-1', '+1', '0x1', '01', '1k']) {
      const signatureCwd = createRepo();
      config(signatureCwd, 'log.showSignature', value);
      config(signatureCwd, 'gpg.program', '/tmp/gpg-helper');
      expect(getLocalGitConfigRisk(signatureCwd).signatureVerifier).toBe(true);
      expect(
        await isShellCommandReadOnlyASTInDirectory('git log -1', signatureCwd),
      ).toBe(false);
    }

    const falseSignatureCwd = createRepo();
    config(falseSignatureCwd, 'log.showSignature', '0');
    config(falseSignatureCwd, 'gpg.program', '/tmp/gpg-helper');
    expect(getLocalGitConfigRisk(falseSignatureCwd).signatureVerifier).toBe(
      false,
    );

    const promisorCwd = createRepo();
    config(promisorCwd, 'remote.origin.promisor', '+1');
    expect(getLocalGitConfigRisk(promisorCwd).promisorRemote).toBe(true);
    expect(
      await isShellCommandReadOnlyASTInDirectory('git show HEAD', promisorCwd),
    ).toBe(false);
  });

  it('gates configured signature verifier programs for all supported program keys', async () => {
    const defaultCwd = createRepo();
    config(defaultCwd, 'log.showSignature', 'true');
    config(defaultCwd, 'gpg.program', '/tmp/gpg-helper');
    expect(getLocalGitConfigRisk(defaultCwd).signatureVerifier).toBe(true);

    const sshCwd = createRepo();
    config(sshCwd, 'log.showSignature', 'true');
    config(sshCwd, 'gpg.format', 'ssh');
    config(sshCwd, 'gpg.ssh.program', '/tmp/ssh-signature-helper');
    expect(getLocalGitConfigRisk(sshCwd).signatureVerifier).toBe(true);

    for (const cwd of [defaultCwd, sshCwd]) {
      for (const command of ['git log -1', 'git show HEAD']) {
        expect(await isShellCommandReadOnlyASTInDirectory(command, cwd)).toBe(
          false,
        );
      }
      expect(
        await isShellCommandReadOnlyASTInDirectory('git status', cwd),
      ).toBe(true);
    }
  });

  it('detects effective pretty formats that request signature verification', async () => {
    for (const [key, value] of [
      ['format.pretty', 'format:%G? %s'],
      ['pretty.audit', 'format:%G? %s'],
    ] as const) {
      const cwd = createRepo();
      config(cwd, key, value);
      config(cwd, 'gpg.program', '/tmp/gpg-helper');
      expect(getLocalGitConfigRisk(cwd).signatureVerifier).toBe(true);
      expect(
        await isShellCommandReadOnlyASTInDirectory('git log -1', cwd),
      ).toBe(false);
    }

    const globalCwd = createRepo();
    const globalConfig = path.join(globalCwd, 'global-pretty.gitconfig');
    writeFileSync(globalConfig, '[format]\n\tpretty = format:%G? %s\n');
    config(globalCwd, 'gpg.program', '/tmp/gpg-helper');
    const previousGlobal = process.env['GIT_CONFIG_GLOBAL'];
    const previousNoSystem = process.env['GIT_CONFIG_NOSYSTEM'];
    process.env['GIT_CONFIG_GLOBAL'] = globalConfig;
    process.env['GIT_CONFIG_NOSYSTEM'] = '1';
    try {
      expect(getLocalGitConfigRisk(globalCwd).signatureVerifier).toBe(true);
      expect(
        await isShellCommandReadOnlyASTInDirectory('git log -1', globalCwd),
      ).toBe(false);
    } finally {
      if (previousGlobal === undefined) delete process.env['GIT_CONFIG_GLOBAL'];
      else process.env['GIT_CONFIG_GLOBAL'] = previousGlobal;
      if (previousNoSystem === undefined)
        delete process.env['GIT_CONFIG_NOSYSTEM'];
      else process.env['GIT_CONFIG_NOSYSTEM'] = previousNoSystem;
    }
  });

  it('gates clean and process filters while preserving proven non-consumers', async () => {
    for (const key of ['filter.demo.clean', 'filter.demo.process']) {
      const cwd = createRepo();
      config(cwd, key, '/tmp/filter-helper');
      expect(getLocalGitConfigRisk(cwd).worktreeFilter).toBe(true);

      for (const command of [
        'git blame file.txt',
        'git diff',
        'git status',
        'git ls-files',
        'git ls-files -m',
        'git ls-files --modified',
        'git ls-files --mod',
        'git describe --dirty',
        'git describe --broken',
      ]) {
        expect(await isShellCommandReadOnlyASTInDirectory(command, cwd)).toBe(
          false,
        );
      }

      for (const command of [
        'git log -1',
        'git show HEAD',
        'git rev-parse HEAD',
      ]) {
        expect(await isShellCommandReadOnlyASTInDirectory(command, cwd)).toBe(
          true,
        );
      }
    }
  });

  it('honors worktree-scoped executable driver config', async () => {
    const cwd = createRepo();
    config(cwd, 'extensions.worktreeConfig', 'true');
    execFileSync(
      'git',
      ['config', '--worktree', 'diff.audit.command', '/tmp/worktree-driver'],
      { cwd },
    );
    expect(getLocalGitConfigRisk(cwd).diffDriverCommand).toBe(true);
    expect(await isShellCommandReadOnlyASTInDirectory('git diff', cwd)).toBe(
      false,
    );
  });

  it('ignores executable diff-driver helpers from global scope', async () => {
    const cwd = createRepo();
    const globalConfig = path.join(cwd, 'global.gitconfig');
    writeFileSync(
      globalConfig,
      '[diff "pwn"]\n\tcommand = /tmp/global-command\n\ttextconv = /tmp/global-textconv\n',
    );

    const previousGlobal = process.env['GIT_CONFIG_GLOBAL'];
    const previousNoSystem = process.env['GIT_CONFIG_NOSYSTEM'];
    process.env['GIT_CONFIG_GLOBAL'] = globalConfig;
    process.env['GIT_CONFIG_NOSYSTEM'] = '1';
    try {
      const risk = getLocalGitConfigRisk(cwd);
      expect(risk.diffDriverCommand).toBe(false);
      expect(risk.diffDriverTextconv).toBe(false);
      expect(await isShellCommandReadOnlyASTInDirectory('git diff', cwd)).toBe(
        true,
      );
      expect(
        await isShellCommandReadOnlyASTInDirectory('git blame file.txt', cwd),
      ).toBe(true);
    } finally {
      if (previousGlobal === undefined) delete process.env['GIT_CONFIG_GLOBAL'];
      else process.env['GIT_CONFIG_GLOBAL'] = previousGlobal;
      if (previousNoSystem === undefined)
        delete process.env['GIT_CONFIG_NOSYSTEM'];
      else process.env['GIT_CONFIG_NOSYSTEM'] = previousNoSystem;
    }
  });

  it('fails closed for every read-only Git command in a promisor repository', async () => {
    const cwd = createRepo();
    config(cwd, 'extensions.partialClone', 'origin');
    expect(getLocalGitConfigRisk(cwd).promisorRemote).toBe(true);

    for (const command of [
      'git blame file.txt',
      'git cat-file -p HEAD:file',
      'git diff',
      'git grep needle HEAD',
      'git log -1',
      'git log --max-count=1',
      'git log -1 -- file.txt',
      'git log --max-count=1 -- file.txt',
      'git log -p -1',
      'git log -Sneedle -1',
      'git log -Gneedle -1',
      'git log -L1,1:file',
      'git log -u -1',
      'git log --patch-with-stat -1',
      'git log --patch-with-raw -1',
      'git log -m -1',
      'git log -c -1',
      'git log --cc -1',
      'git ls-files --with-tree=HEAD',
      'git show HEAD',
      'git status',
    ]) {
      expect(await isShellCommandReadOnlyASTInDirectory(command, cwd)).toBe(
        false,
      );
    }
  });

  it('detects every repository-local promisor configuration branch', () => {
    const extensionCwd = createRepo();
    config(extensionCwd, 'extensions.partialClone', 'origin');
    expect(getLocalGitConfigRisk(extensionCwd).promisorRemote).toBe(true);

    const remoteCwd = createRepo();
    config(remoteCwd, 'remote.origin.promisor', 'true');
    expect(getLocalGitConfigRisk(remoteCwd).promisorRemote).toBe(true);

    const filterCwd = createRepo();
    config(filterCwd, 'remote.origin.partialCloneFilter', 'blob:none');
    expect(getLocalGitConfigRisk(filterCwd).promisorRemote).toBe(true);
  });

  it('gates repository-local merge drivers and remerge options without over-denying non-consumers', async () => {
    const cwd = createRepo();
    config(cwd, 'merge.audit.driver', '/tmp/merge-helper %O %A %B');
    expect(getLocalGitConfigRisk(cwd).mergeDriver).toBe(true);
    expect(
      await isShellCommandReadOnlyASTInDirectory('git log -1', cwd),
    ).toBe(false);
    expect(
      await isShellCommandReadOnlyASTInDirectory('git show HEAD', cwd),
    ).toBe(false);
    expect(await isShellCommandReadOnlyASTInDirectory('git diff', cwd)).toBe(
      true,
    );
    expect(await isShellCommandReadOnlyASTInDirectory('git status', cwd)).toBe(
      true,
    );
    expect(await classifyShellCommandSafety('git show --remerge-diff')).toBe(
      'unknown',
    );
    expect(
      await classifyShellCommandSafety('git log --diff-merges=remerge -1'),
    ).toBe('unknown');
    expect(
      await classifyShellCommandSafety('git log --diff-merges=r -1'),
    ).toBe('unknown');
    expect(isShellCommandReadOnly('git log --diff-merges=r -1')).toBe(false);
  });

  it('fails closed for every probed Git config risk when the AST parser is unavailable', async () => {
    const cases: Array<{
      configure: (cwd: string) => void;
      command: string;
    }> = [
      {
        configure: (cwd) => config(cwd, 'diff.external', '/tmp/diff-helper'),
        command: 'git diff',
      },
      {
        configure: (cwd) =>
          config(cwd, 'diff.audit.command', '/tmp/diff-driver'),
        command: 'git diff',
      },
      {
        configure: (cwd) =>
          config(cwd, 'diff.audit.textconv', '/tmp/textconv-helper'),
        command: 'git log -1',
      },
      {
        configure: (cwd) => config(cwd, 'core.fsmonitor', '/tmp/fsmonitor'),
        command: 'git status',
      },
      {
        configure: (cwd) => config(cwd, 'filter.audit.clean', '/tmp/filter'),
        command: 'git status',
      },
      {
        configure: (cwd) => config(cwd, 'pager.status', '/tmp/pager'),
        command: 'git status',
      },
      {
        configure: (cwd) => {
          config(cwd, 'log.showSignature', 'true');
          config(cwd, 'gpg.program', '/tmp/gpg-helper');
        },
        command: 'git log -1',
      },
      {
        configure: (cwd) => config(cwd, 'extensions.partialClone', 'origin'),
        command: 'git log -1',
      },
      {
        configure: (cwd) =>
          config(cwd, 'merge.audit.driver', '/tmp/merge-helper %O %A %B'),
        command: 'git log -1',
      },
    ];

    for (const testCase of cases) {
      const cwd = createRepo();
      testCase.configure(cwd);
      _setParserFailedForTesting();
      expect(
        await isShellCommandReadOnlyASTInDirectory(testCase.command, cwd),
      ).toBe(false);
      _resetParser();
      await initParser();
    }
  });
});
