/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The on-disk half of `ensureReviewTmpDir` lists a directory that concurrent
// reviews share, so the listing errors are reached through an fs spy rather
// than staged: a `cleanup` of another target racing the walk, and a
// directory this process cannot read (unstageable under uid 0).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureReviewTmpDir } from './paths.js';

vi.mock('node:fs', { spy: true });

let root: string;
let cwd: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'tmpdir-ondisk-')));
  cwd = process.cwd();
  process.chdir(root);
  fs.mkdirSync(join(root, '.qwen', 'tmp', 'qwen-review-pr-8-prompts'), {
    recursive: true,
  });
});

afterEach(() => {
  vi.mocked(fs.readdirSync).mockRestore();
  process.chdir(cwd);
  fs.rmSync(root, { recursive: true, force: true });
});

async function failInnerListing(code: string): Promise<void> {
  const { readdirSync: real } =
    await vi.importActual<typeof import('node:fs')>('node:fs');
  vi.mocked(fs.readdirSync).mockImplementation(((
    path: fs.PathLike,
    ...rest: unknown[]
  ) => {
    if (String(path).endsWith('qwen-review-pr-8-prompts')) {
      throw Object.assign(new Error(`${code}: scandir`), { code });
    }
    return (real as (...a: unknown[]) => unknown)(path, ...rest);
  }) as typeof fs.readdirSync);
}

describe('ensureReviewTmpDir — listing the shared directory', () => {
  it('reads an entry removed mid-walk as nothing here', async () => {
    for (const code of ['ENOENT', 'ENOTDIR']) {
      await failInnerListing(code);
      expect(() => ensureReviewTmpDir('fetch-pr')).not.toThrow();
    }
  });

  it('refuses under its own name on any other listing error', async () => {
    await failInnerListing('EACCES');
    expect(() => ensureReviewTmpDir('fetch-pr')).toThrow(
      /^fetch-pr: could not list .*qwen-review-pr-8-prompts .*EACCES/s,
    );
  });
});
