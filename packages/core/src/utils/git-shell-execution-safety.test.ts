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

    // Preserve the existing safe control: a pure top-level assignment performs
    // no external command and remains read-only.
    expect(await classifyShellCommandSafety('FOO=bar')).toBe('read-only');
  });
});
