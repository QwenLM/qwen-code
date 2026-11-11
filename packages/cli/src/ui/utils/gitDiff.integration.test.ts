/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { fetchGitDiffFiles, fetchGitDiffString } from './gitDiff.js';

let root: string;
afterEach(async () => {
  vi.restoreAllMocks();
  if (root) await fs.rm(root, { recursive: true, force: true });
});

it('reads diffs without running fsmonitor, diff drivers or shell syntax in filenames', async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-diff-security-'));
  const git = (args: string[]) =>
    execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  git(['init', '-q']);
  const filename = 'file$(touch injected).txt';
  await fs.writeFile(path.join(root, filename), 'before\n');
  git(['-c', 'core.fsmonitor=false', 'add', '--', filename]);
  git([
    '-c',
    'core.fsmonitor=false',
    '-c',
    'core.hooksPath=/dev/null',
    '-c',
    'commit.gpgsign=false',
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    'commit',
    '-qm',
    'initial',
  ]);
  await fs.writeFile(path.join(root, filename), 'after\n');
  const helper = path.join(root, 'monitor');
  await fs.writeFile(
    helper,
    '#!/bin/sh\nprintf executed > helper-ran\nprintf "token\\000"\n',
    { mode: 0o755 },
  );
  git(['config', 'core.fsmonitor', helper]);
  git(['config', 'diff.external', helper]);
  git(['config', 'diff.test.textconv', helper]);
  await fs.writeFile(path.join(root, '.gitattributes'), '*.txt diff=test\n');
  vi.spyOn(process, 'cwd').mockReturnValue(root);

  expect(
    fetchGitDiffFiles().some((file) => file.path.includes('injected')),
  ).toBe(true);
  expect(fetchGitDiffString(filename).diffString).toContain('+after');
  await expect(fs.stat(path.join(root, 'helper-ran'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
  await expect(fs.stat(path.join(root, 'injected'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
});
