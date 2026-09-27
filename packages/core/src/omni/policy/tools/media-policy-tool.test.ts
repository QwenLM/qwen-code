/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertMediaPolicyIo } from './media-policy-tool.js';

describe('media policy IO boundaries', () => {
  let root: string;
  let inputPath: string;
  let outputDir: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'omni-mp-io-'));
    inputPath = path.join(root, 'input.bin');
    outputDir = path.join(root, 'output');
    await fs.writeFile(inputPath, 'x');
    await fs.mkdir(outputDir);
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it.skipIf(process.platform === 'win32').each(['input', 'output'])(
    'rejects a symlinked %s',
    async (kind) => {
      const link = path.join(root, 'link');
      await fs.symlink(
        kind === 'input' ? inputPath : outputDir,
        link,
        kind === 'input' ? 'file' : 'dir',
      );
      await expect(
        assertMediaPolicyIo({
          inputPath: kind === 'input' ? link : inputPath,
          outputDir: kind === 'output' ? link : outputDir,
        }),
      ).rejects.toThrow(
        kind === 'input' ? /not a regular file/ : /not a real directory/,
      );
      expect(await fs.readFile(inputPath, 'utf8')).toBe('x');
      expect(await fs.readdir(outputDir)).toEqual([]);
    },
  );

  it('refuses a missing output directory without creating it', async () => {
    const missing = path.join(root, 'missing');
    await expect(
      assertMediaPolicyIo({ inputPath, outputDir: missing }),
    ).rejects.toThrow(/output directory not found/);
    await expect(fs.access(missing)).rejects.toThrow();
  });

  it('reports a missing input by basename without exposing its locator', async () => {
    const missing = path.join(root, 'private-file.bin');
    const error: unknown = await assertMediaPolicyIo({
      inputPath: missing,
      outputDir,
    }).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      'input file not found: private-file.bin',
    );
    expect((error as Error).message).not.toContain(root);
  });
});
