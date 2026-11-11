/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Regression coverage for the plugin install failure reported as
 * `Install failed: Failed to fetch plugin: undefined is not an object
 * (evaluating 'C.close().catch')`.
 *
 * The packaged CLI runs on the bun runtime, where `Dir.close()` does not return
 * a thenable once async iteration has already closed the handle. The old
 * `await handle.close().catch(() => {})` in `copyDirectory`'s `finally` block
 * therefore threw a `TypeError` out of an otherwise successful copy, which
 * bubbled up as a raw install failure.
 *
 * `node:fs/promises` lives in its own test file because the mock has to wrap
 * `opendir` for every case; the rest of the copier is covered against the real
 * filesystem in `pluginTreeCopy.test.ts`.
 */

import type { Dir } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { copyPluginTree } from './pluginTreeCopy.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    opendir: (async (
      ...args: Parameters<typeof actual.opendir>
    ): Promise<Dir> => {
      const handle = await actual.opendir(...args);
      return withNonThenableClose(handle);
    }) as typeof actual.opendir,
  };
});

/** Mimics bun: `close()` still closes the handle but returns a plain value. */
function withNonThenableClose(handle: Dir): Dir {
  return {
    path: handle.path,
    [Symbol.asyncIterator]: () => handle[Symbol.asyncIterator](),
    read: () => handle.read(),
    close: () => {
      // Release the real handle without exposing a promise to the caller.
      void Promise.resolve(handle.close()).catch(() => {});
      return undefined;
    },
  } as unknown as Dir;
}

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe.skipIf(process.platform === 'win32')(
  'copyPluginTree on a runtime whose Dir.close() is not thenable',
  () => {
    it('copies the tree instead of throwing a TypeError', async () => {
      const root = await mkdtemp(join(tmpdir(), 'plugin-copy-bun-close-'));
      tempDirs.push(root);
      const source = join(root, 'source');
      const destination = join(root, 'destination');
      await mkdir(join(source, 'commands'), { recursive: true });
      await writeFile(join(source, 'plugin.json'), '{"name":"demo"}');
      await writeFile(join(source, 'commands', 'audit.md'), '# audit');

      const result = await copyPluginTree(source, destination);

      expect(result).toEqual({
        rewrittenSymlinks: 0,
        materializedSymlinks: 0,
        skippedSymlinks: 0,
      });
      expect(await readFile(join(destination, 'plugin.json'), 'utf8')).toBe(
        '{"name":"demo"}',
      );
      expect(
        await readFile(join(destination, 'commands', 'audit.md'), 'utf8'),
      ).toBe('# audit');
    });
  },
);
