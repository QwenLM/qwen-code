/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

describe('generate-git-commit-info', () => {
  let root;

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  it('writes git-commit.ts for the CLI only', () => {
    root = mkdtempSync(path.join(tmpdir(), 'qwen-git-commit-info-'));
    const script = path.join(root, 'scripts', 'generate-git-commit-info.js');
    mkdirSync(path.dirname(script));
    copyFileSync(
      path.join(repoRoot, 'scripts', 'generate-git-commit-info.js'),
      script,
    );
    symlinkSync(
      path.join(repoRoot, 'node_modules'),
      path.join(root, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    execFileSync(process.execPath, [script], { cwd: root, stdio: 'pipe' });

    expect(
      readFileSync(
        path.join(root, 'packages', 'cli', 'src', 'generated', 'git-commit.ts'),
        'utf8',
      ),
    ).toContain('export const GIT_COMMIT_INFO');
    expect(existsSync(path.join(root, 'packages', 'core', 'src'))).toBe(false);
  });
});
