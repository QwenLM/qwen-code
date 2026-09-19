/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  hashFile,
  readSourceIdentity,
  verifySourceManifest,
} from '../sandbox-runtime/source-manifest.mjs';

const roots = [];

async function fixture() {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'qwen-source-manifest-'),
  );
  roots.push(root);
  await fs.writeFile(path.join(root, 'input.txt'), 'before\n');
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'core.hooksPath', '/dev/null'], { cwd: root });
  execFileSync('git', ['add', 'input.txt'], { cwd: root });
  execFileSync(
    'git',
    [
      '-c',
      'user.name=Qwen Test',
      '-c',
      'user.email=qwen-test@example.com',
      'commit',
      '-qm',
      'fixture',
    ],
    { cwd: root },
  );
  const identity = readSourceIdentity(root);
  return {
    root,
    manifest: {
      ...identity,
      inputs: { 'input.txt': await hashFile(path.join(root, 'input.txt')) },
    },
  };
}

describe('sandbox runtime source manifest', () => {
  afterEach(async () => {
    await Promise.all(
      roots
        .splice(0)
        .map((root) => fs.rm(root, { recursive: true, force: true })),
    );
  });

  it('binds a candidate to its exact source revision and inputs', async () => {
    const { root, manifest } = await fixture();
    await expect(verifySourceManifest(root, manifest)).resolves.toEqual(
      manifest,
    );
  });

  it('rejects source changes after the candidate build', async () => {
    const { root, manifest } = await fixture();
    await fs.writeFile(path.join(root, 'input.txt'), 'after\n');
    await expect(verifySourceManifest(root, manifest)).rejects.toThrow(
      'Source inputs differ from the candidate build',
    );
  });

  it('rejects a different source revision with matching inputs', async () => {
    const { root, manifest } = await fixture();
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Qwen Test',
        '-c',
        'user.email=qwen-test@example.com',
        'commit',
        '--allow-empty',
        '-qm',
        'next',
      ],
      { cwd: root },
    );
    await expect(verifySourceManifest(root, manifest)).rejects.toThrow(
      'Source revision differs from the candidate build',
    );
  });

  it('rejects a different source dirtiness state', async () => {
    const { root, manifest } = await fixture();
    await fs.writeFile(path.join(root, 'untracked.txt'), 'new\n');
    await expect(verifySourceManifest(root, manifest)).rejects.toThrow(
      'Source worktree dirtiness differs from the candidate build',
    );
  });

  it('rejects source inputs that escape the checkout', async () => {
    const { root, manifest } = await fixture();
    await expect(
      verifySourceManifest(root, {
        ...manifest,
        inputs: { '../outside': '0'.repeat(64) },
      }),
    ).rejects.toThrow('escapes the source root');
  });
});
