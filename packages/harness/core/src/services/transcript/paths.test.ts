/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalizeTranscriptPath } from './paths.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe('canonicalizeTranscriptPath', () => {
  it('maps symlink aliases of a not-yet-created transcript to one path key', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'transcript-paths-'));
    tempDirs.push(root);
    const realDirectory = path.join(root, 'real');
    const aliasDirectory = path.join(root, 'alias');
    await fs.mkdir(realDirectory);
    await fs.symlink(realDirectory, aliasDirectory, 'dir');

    const realPath = path.join(realDirectory, 'nested', 'session.jsonl');
    const aliasPath = path.join(aliasDirectory, 'nested', 'session.jsonl');

    await expect(canonicalizeTranscriptPath(aliasPath)).resolves.toBe(
      await canonicalizeTranscriptPath(realPath),
    );
  });
});
