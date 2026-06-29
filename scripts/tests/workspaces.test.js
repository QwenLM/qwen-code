/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getWorkspacePackageJsonPaths } from '../workspaces.js';

describe('workspace helpers', () => {
  const tempDirs = [];

  afterEach(() => {
    for (const tempDir of tempDirs.splice(0)) {
      rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it('honors negated workspace patterns', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'qwen-workspaces-'));
    tempDirs.push(root);

    for (const packagePath of [
      'packages/cli/package.json',
      'packages/core/package.json',
      'packages/desktop/package.json',
      'packages/channels/base/package.json',
    ]) {
      writeFile(root, packagePath, '{}\n');
    }

    expect(
      getWorkspacePackageJsonPaths(root, [
        'packages/*',
        'packages/channels/base',
        '!packages/desktop',
      ]),
    ).toEqual([
      'packages/channels/base/package.json',
      'packages/cli/package.json',
      'packages/core/package.json',
    ]);
  });

  it('normalizes Windows-style workspace patterns', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'qwen-workspaces-'));
    tempDirs.push(root);

    for (const packagePath of [
      'packages/cli/package.json',
      'packages/core/package.json',
      'packages/desktop/package.json',
      'packages/channels/base/package.json',
    ]) {
      writeFile(root, packagePath, '{}\n');
    }

    expect(
      getWorkspacePackageJsonPaths(root, [
        'packages\\*',
        'packages\\channels\\base',
        '!packages\\desktop',
      ]),
    ).toEqual([
      'packages/channels/base/package.json',
      'packages/cli/package.json',
      'packages/core/package.json',
    ]);
  });

  function writeFile(root, relativePath, content) {
    const filePath = path.join(root, relativePath);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, content);
  }
});
