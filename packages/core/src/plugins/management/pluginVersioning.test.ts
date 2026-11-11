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
import { calculatePluginVersion, getGitCommitSha } from './pluginVersioning.js';

const exec = vi.hoisted(() =>
  vi.fn(async (): Promise<{ stdout: string }> => {
    throw new Error('Git unavailable');
  }),
);
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFile: Object.assign(vi.fn(), {
    [Symbol.for('nodejs.util.promisify.custom')]: exec,
  }),
}));

let root: string;
afterEach(async () => {
  vi.restoreAllMocks();
  if (root) await fs.rm(root, { recursive: true, force: true });
});

it('uses filesystem commit metadata when Git is unavailable and keeps the unknown fallback', async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-version-'));
  const gitDir = path.join(root, '.git');
  await fs.mkdir(path.join(gitDir, 'objects'), { recursive: true });
  await fs.mkdir(path.join(gitDir, 'refs'), { recursive: true });
  const sha = 'abcdef0123456789abcdef0123456789abcdef01';
  await fs.writeFile(path.join(gitDir, 'HEAD'), sha + '\n');
  await expect(getGitCommitSha(root)).resolves.toBe(sha);
  await expect(
    calculatePluginVersion('test', 'local', undefined, root),
  ).resolves.toBe('abcdef012345');
  await fs.rm(gitDir, { recursive: true });
  await expect(
    calculatePluginVersion('test', 'local', undefined, root),
  ).resolves.toBe('unknown');
  expect(exec).not.toHaveBeenCalled();
});

it('uses bounded Git for reftable versions and falls back to unknown on failure', async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-reftable-'));
  const gitDir = path.join(root, '.git');
  await fs.mkdir(path.join(gitDir, 'objects'), { recursive: true });
  await fs.mkdir(path.join(gitDir, 'refs'), { recursive: true });
  await fs.writeFile(path.join(gitDir, 'HEAD'), 'ref: refs/heads/.invalid\n');
  await fs.writeFile(
    path.join(gitDir, 'refs', 'heads'),
    'this repository uses the reftable format\n',
  );
  exec.mockResolvedValueOnce({ stdout: 'a'.repeat(40) });
  await expect(
    calculatePluginVersion('test', 'local', undefined, root),
  ).resolves.toBe('aaaaaaaaaaaa');
  expect(exec).toHaveBeenLastCalledWith(
    'git',
    expect.arrayContaining(['rev-parse', '--verify', 'HEAD']),
    expect.objectContaining({
      cwd: root,
      timeout: 2000,
      killSignal: 'SIGKILL',
    }),
  );
  await expect(
    calculatePluginVersion('test', 'local', undefined, root),
  ).resolves.toBe('unknown');
  exec.mockResolvedValueOnce({ stdout: '../invalid-version' });
  await expect(getGitCommitSha(root)).resolves.toBeNull();
});
