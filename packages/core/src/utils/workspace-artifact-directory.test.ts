/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  mkdtemp,
  mkdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MAX_DIRECTORY_ARTIFACT_DEPTH,
  collectRecordableWorkspaceFiles,
} from './workspace-artifact-directory.js';

describe('collectRecordableWorkspaceFiles', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  async function workspace() {
    const root = await realpath(
      await mkdtemp(path.join(os.tmpdir(), 'artifact-dir-')),
    );
    dirs.push(root);
    return root;
  }

  it('skips junk directories, lock files, hidden names, and symlink entries', async () => {
    const root = await workspace();
    await mkdir(path.join(root, 'node_modules'), { recursive: true });
    await writeFile(path.join(root, 'node_modules', 'junk.txt'), 'x');
    await mkdir(path.join(root, 'keep'), { recursive: true });
    await writeFile(path.join(root, 'keep', 'report.xlsx'), 'xlsx');
    await writeFile(path.join(root, '.hidden.xlsx'), 'hidden');
    await writeFile(path.join(root, '~$lock.xlsx'), 'lock');
    await writeFile(path.join(root, 'real.txt'), 'real');
    await symlink(path.join(root, 'real.txt'), path.join(root, 'link.txt'));

    const collected = await collectRecordableWorkspaceFiles(root, '', root);
    expect(collected.files.sort()).toEqual(['keep/report.xlsx', 'real.txt']);
    expect(collected.truncated).toBe(false);
    expect(collected.depthLimited).toBe(false);
  });

  it('signals depth-limited truncation instead of silently dropping deep files', async () => {
    const root = await workspace();
    const deepParts = Array.from(
      { length: MAX_DIRECTORY_ARTIFACT_DEPTH + 2 },
      (_, index) => `d${index}`,
    );
    const deepDir = path.join(root, ...deepParts);
    await mkdir(deepDir, { recursive: true });
    await writeFile(path.join(deepDir, 'deep.xlsx'), 'deep');
    await writeFile(path.join(root, 'shallow.xlsx'), 'shallow');

    const collected = await collectRecordableWorkspaceFiles(root, '', root);
    expect(collected.files).toEqual(['shallow.xlsx']);
    expect(collected.truncated).toBe(false);
    expect(collected.depthLimited).toBe(true);
  });
});
