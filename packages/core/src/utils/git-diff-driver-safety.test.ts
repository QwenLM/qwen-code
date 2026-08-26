/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  _resetParser,
  initParser,
  isShellCommandReadOnlyASTInDirectory,
} from './shellAstParser.js';

beforeAll(async () => {
  await initParser();
});

afterAll(() => {
  _resetParser();
});

describe('repository-local Git diff-driver config (#10193)', () => {
  const tempDirs: string[] = [];

  const createRepo = (): string => {
    const dir = mkdtempSync(path.join(tmpdir(), 'qwen-git-driver-'));
    tempDirs.push(dir);
    execFileSync('git', ['init', '-q'], { cwd: dir });
    return dir;
  };

  const gitConfig = (cwd: string, ...args: string[]): void => {
    execFileSync('git', ['config', ...args], { cwd });
  };

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('downgrades git diff when a diff driver command is configured', async () => {
    const cwd = createRepo();
    gitConfig(cwd, 'diff.pwn.command', 'example-diff-command');

    expect(await isShellCommandReadOnlyASTInDirectory('git diff', cwd)).toBe(
      false,
    );
    expect(await isShellCommandReadOnlyASTInDirectory('git status', cwd)).toBe(
      true,
    );
  });

  it('downgrades diff/log/show when a textconv driver is configured', async () => {
    const cwd = createRepo();
    gitConfig(cwd, 'diff.pwn.textconv', 'example-textconv');

    for (const command of ['git diff', 'git log -p -1', 'git show HEAD']) {
      expect(await isShellCommandReadOnlyASTInDirectory(command, cwd)).toBe(
        false,
      );
    }
    expect(await isShellCommandReadOnlyASTInDirectory('git status', cwd)).toBe(
      true,
    );
  });

  it('keeps ordinary read-only Git commands read-only without driver helpers', async () => {
    const cwd = createRepo();

    for (const command of ['git diff', 'git log -1', 'git show HEAD']) {
      expect(await isShellCommandReadOnlyASTInDirectory(command, cwd)).toBe(
        true,
      );
    }
  });
});
