/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { getTranscriptGitBranch } from './transcriptMetadata.js';

const tempRoots: string[] = [];

async function createRepository(head: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'qwen-transcript-git-'));
  tempRoots.push(root);
  await Promise.all([
    mkdir(path.join(root, '.git', 'objects'), { recursive: true }),
    mkdir(path.join(root, '.git', 'refs', 'heads'), { recursive: true }),
  ]);
  await writeFile(path.join(root, '.git', 'HEAD'), `${head}\n`);
  return root;
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('getTranscriptGitBranch', () => {
  it('reads the symbolic branch directly from HEAD', async () => {
    const root = await createRepository('ref: refs/heads/feature/direct-head');

    await expect(getTranscriptGitBranch(root)).resolves.toBe(
      'feature/direct-head',
    );
  });

  it('returns HEAD for detached and non-repository directories', async () => {
    const detached = await createRepository('a'.repeat(40));
    const plain = await mkdtemp(path.join(tmpdir(), 'qwen-transcript-plain-'));
    tempRoots.push(plain);

    await expect(getTranscriptGitBranch(detached)).resolves.toBe('HEAD');
    await expect(getTranscriptGitBranch(plain)).resolves.toBe('HEAD');
  });
});
