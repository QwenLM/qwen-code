/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as childProcess from 'node:child_process';
import { isGitRepository } from './gitDiff.js';

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFileSync: vi.fn(() => {
    throw new Error('Git unavailable');
  }),
}));

let root: string;
afterEach(async () => {
  vi.restoreAllMocks();
  if (root) await fs.rm(root, { recursive: true, force: true });
});

it('detects repositories without launching Git and rejects an invalid .git marker', async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'page-git-'));
  vi.spyOn(process, 'cwd').mockReturnValue(root);
  const exec = vi.mocked(childProcess.execFileSync);
  await fs.mkdir(path.join(root, '.git'));
  await expect(isGitRepository()).resolves.toBe(false);
  await fs.mkdir(path.join(root, '.git', 'objects'));
  await fs.mkdir(path.join(root, '.git', 'refs'));
  await fs.writeFile(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  await expect(isGitRepository()).resolves.toBe(true);
  await fs.writeFile(
    path.join(root, '.git', 'HEAD'),
    'ref: refs/heads/.invalid\n',
  );
  await expect(isGitRepository()).resolves.toBe(false);
  await fs.writeFile(
    path.join(root, '.git', 'refs', 'heads'),
    'this repository uses the reftable format\n',
  );
  await expect(isGitRepository()).resolves.toBe(true);
  expect(exec).not.toHaveBeenCalled();
});
