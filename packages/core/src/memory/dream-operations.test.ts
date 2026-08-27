/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyDreamOperations,
  DREAM_OPERATIONS_FILENAME,
} from './dream-operations.js';

function memory(type: string, name: string): string {
  return `---\ntype: ${type}\nname: ${name}\ndescription: ${name}\nkeywords:\n  - ${name}\n---\n\n${name}\n`;
}

describe('Dream operations', () => {
  let tempDir: string;
  let memoryRoot: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dream-operations-'));
    memoryRoot = path.join(tempDir, 'memory');
    await fs.mkdir(path.join(memoryRoot, 'feedback'), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('deletes a split source only after every target is valid', async () => {
    await fs.writeFile(
      path.join(memoryRoot, 'feedback', 'long.md'),
      memory('feedback', 'Long'),
    );
    await fs.writeFile(
      path.join(memoryRoot, 'feedback', 'rule-a.md'),
      memory('feedback', 'Rule A'),
    );
    await fs.writeFile(
      path.join(memoryRoot, 'feedback', 'rule-b.md'),
      memory('feedback', 'Rule B'),
    );
    await fs.writeFile(
      path.join(memoryRoot, DREAM_OPERATIONS_FILENAME),
      JSON.stringify({
        version: 1,
        delete: ['feedback/long.md'],
        operations: [
          {
            type: 'split',
            source: 'feedback/long.md',
            targets: ['feedback/rule-a.md', 'feedback/rule-b.md'],
          },
        ],
      }),
    );

    const result = await applyDreamOperations(memoryRoot);

    expect(result).toEqual({
      deletedPaths: ['feedback/long.md'],
      dedupedEntries: 0,
      splitEntries: 1,
    });
    await expect(
      fs.stat(path.join(memoryRoot, 'feedback', 'long.md')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects traversal before deleting any source and removes the manifest', async () => {
    const source = path.join(memoryRoot, 'feedback', 'source.md');
    const outside = path.join(tempDir, 'outside.md');
    await fs.writeFile(source, memory('feedback', 'Source'));
    await fs.writeFile(outside, 'outside');
    await fs.writeFile(
      path.join(memoryRoot, DREAM_OPERATIONS_FILENAME),
      JSON.stringify({
        version: 1,
        delete: ['feedback/source.md', '../outside.md'],
        operations: [],
      }),
    );

    await expect(applyDreamOperations(memoryRoot)).rejects.toThrow(
      'unsafe path',
    );
    await expect(fs.readFile(source, 'utf-8')).resolves.toContain('Source');
    await expect(fs.readFile(outside, 'utf-8')).resolves.toBe('outside');
    await expect(
      fs.stat(path.join(memoryRoot, DREAM_OPERATIONS_FILENAME)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps all sources when one replacement target is invalid', async () => {
    const source = path.join(memoryRoot, 'feedback', 'source.md');
    await fs.writeFile(source, memory('feedback', 'Source'));
    await fs.writeFile(
      path.join(memoryRoot, DREAM_OPERATIONS_FILENAME),
      JSON.stringify({
        version: 1,
        delete: ['feedback/source.md'],
        operations: [
          {
            type: 'split',
            source: 'feedback/source.md',
            targets: ['feedback/missing.md', 'feedback/also-missing.md'],
          },
        ],
      }),
    );

    await expect(applyDreamOperations(memoryRoot)).rejects.toThrow();
    await expect(fs.readFile(source, 'utf-8')).resolves.toContain('Source');
  });

  it('rejects a symlink alias instead of deleting its target', async () => {
    const target = path.join(memoryRoot, 'feedback', 'target.md');
    const alias = path.join(memoryRoot, 'feedback', 'alias.md');
    await fs.writeFile(target, memory('feedback', 'Target'));
    await fs.symlink(target, alias);
    await fs.writeFile(
      path.join(memoryRoot, DREAM_OPERATIONS_FILENAME),
      JSON.stringify({
        version: 1,
        delete: ['feedback/alias.md'],
        operations: [],
      }),
    );

    await expect(applyDreamOperations(memoryRoot)).rejects.toThrow('symlink');
    await expect(fs.readFile(target, 'utf-8')).resolves.toContain('Target');
    await expect(fs.lstat(alias)).resolves.toBeDefined();
  });

  it('rejects operations that delete pinned memory', async () => {
    const pinnedDir = path.join(memoryRoot, 'pinned');
    const pinnedFile = path.join(pinnedDir, 'important.md');
    await fs.mkdir(pinnedDir, { recursive: true });
    await fs.writeFile(pinnedFile, memory('project', 'Important'));
    await fs.writeFile(
      path.join(memoryRoot, DREAM_OPERATIONS_FILENAME),
      JSON.stringify({
        version: 1,
        delete: ['pinned/important.md'],
        operations: [],
      }),
    );

    await expect(applyDreamOperations(memoryRoot)).rejects.toThrow(
      'unsafe path',
    );
    await expect(fs.readFile(pinnedFile, 'utf-8')).resolves.toContain(
      'Important',
    );
  });

  it.each(['Pinned/important.md', 'memory.md'])(
    'rejects case variants of protected path %s',
    async (protectedPath) => {
      await fs.writeFile(
        path.join(memoryRoot, DREAM_OPERATIONS_FILENAME),
        JSON.stringify({
          version: 1,
          delete: [protectedPath],
          operations: [],
        }),
      );

      await expect(applyDreamOperations(memoryRoot)).rejects.toThrow(
        'unsafe path',
      );
    },
  );
});
