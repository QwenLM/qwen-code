/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

describe.sequential('shell execution safety regressions', () => {
  const tempDirs: string[] = [];

  const createRepo = (): string => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'qwen-shell-exec-safety-'));
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

  it('fails closed for alternate-refs commands and repository hook paths', async () => {
    const alternateRefsCwd = createRepo();
    config(
      alternateRefsCwd,
      'core.alternateRefsCommand',
      '/tmp/alternate-refs-helper',
    );
    expect(getLocalGitConfigRisk(alternateRefsCwd).alternateRefsCommand).toBe(
      true,
    );
    for (const command of [
      'git log --alternate-refs',
      'git show --alternate-refs HEAD',
    ]) {
      expect(
        await isShellCommandReadOnlyASTInDirectory(command, alternateRefsCwd),
      ).toBe(false);
    }

    const hooksCwd = createRepo();
    config(hooksCwd, 'core.hooksPath', '.githooks');
    expect(getLocalGitConfigRisk(hooksCwd).hooksPath).toBe(true);
    expect(
      await isShellCommandReadOnlyASTInDirectory('git status', hooksCwd),
    ).toBe(false);
  });

  it('detects executable hooks in the default Git hooks directory without config', async () => {
    const cwd = createRepo();
    const hooksDir = path.join(cwd, '.git', 'hooks');
    mkdirSync(hooksDir, { recursive: true });
    const hook = path.join(hooksDir, 'post-index-change');
    writeFileSync(hook, '#!/bin/sh\nexit 0\n', 'utf8');
    chmodSync(hook, 0o755);

    expect(getLocalGitConfigRisk(cwd).hooksPath).toBe(true);
    expect(await isShellCommandReadOnlyASTInDirectory('git status', cwd)).toBe(
      false,
    );

    _setParserFailedForTesting();
    expect(await isShellCommandReadOnlyASTInDirectory('git status', cwd)).toBe(
      false,
    );
  });

  it('keeps the new broad Git risks fail-closed in parser fallback mode', async () => {
    for (const [key, value, command] of [
      [
        'core.alternateRefsCommand',
        '/tmp/alternate-refs-helper',
        'git log --alternate-refs',
      ],
      ['core.hooksPath', '.githooks', 'git status'],
    ] as const) {
      const cwd = createRepo();
      config(cwd, key, value);
      _setParserFailedForTesting();
      expect(await isShellCommandReadOnlyASTInDirectory(command, cwd)).toBe(
        false,
      );
      _resetParser();
      await initParser();
    }
  });

  it('treats every %G pretty placeholder as signature-verifying', async () => {
    const cwd = createRepo();
    config(cwd, 'gpg.program', '/tmp/gpg-helper');

    for (const pretty of ['format:%GB', 'format:%GX', 'format:%GZ', 'format:%G']) {
      config(cwd, 'format.pretty', pretty);
      expect(getLocalGitConfigRisk(cwd).signatureVerifier).toBe(true);
      expect(await isShellCommandReadOnlyASTInDirectory('git log', cwd)).toBe(
        false,
      );
    }

    expect(await classifyShellCommandSafety('git log --pretty=format:%GB')).toBe(
      'unknown',
    );
    expect(isShellCommandReadOnly('git log --pretty=format:%GB')).toBe(false);
  });

  it('fails closed for unquoted backslash-escaped Git helper options', async () => {
    for (const command of [
      'git log --show\\-signature',
      'git log --ext\\-diff -p',
      'git grep --textcon\\v needle',
      'git log --format=%G\\K',
    ]) {
      expect(await classifyShellCommandSafety(command)).toBe('unknown');
      expect(isShellCommandReadOnly(command)).toBe(false);
    }
  });

  it('does not let brace-group assignments persist through read-only classification', async () => {
    const command =
      "{ GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=diff.external GIT_CONFIG_VALUE_0=/tmp/evil; } && git diff";
    expect(await classifyShellCommandSafety(command)).toBe('unknown');

    const cwd = createRepo();
    expect(await isShellCommandReadOnlyASTInDirectory(command, cwd)).toBe(
      false,
    );
    expect(await classifyShellCommandSafety('{ PATH=.; } && ls')).toBe(
      'unknown',
    );

    expect(await classifyShellCommandSafety('FOO=bar')).toBe('read-only');
  });
});
