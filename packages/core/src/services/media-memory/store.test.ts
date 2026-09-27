/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as atomicFileWrite from '../../utils/atomicFileWrite.js';
import { MediaMemoryStore } from './store.js';

it('preserves an unreadable graph without invoking its mutator or saving', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'media-memory-unreadable-'));
  try {
    const store = new MediaMemoryStore(root);
    const original = JSON.stringify({
      schemaVersion: 1,
      files: { keep: { fileRef: '/original.png' } },
      versions: {},
      executions: {},
      entries: {},
    });
    await fs.writeFile(store.filePath, original);
    const read = vi
      .spyOn(fs, 'readFile')
      .mockRejectedValueOnce(
        Object.assign(new Error('permission denied'), { code: 'EACCES' }),
      );
    const save = vi.spyOn(atomicFileWrite, 'atomicWriteFile');
    const mutate = vi.fn(() => ({ result: 'mutated', changed: true }));

    expect(await store.transact('unreadable', mutate)).toBe('unreadable');
    expect(read).toHaveBeenCalledExactlyOnceWith(store.filePath, 'utf8');
    expect(mutate).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    read.mockRestore();
    expect(await fs.readFile(store.filePath, 'utf8')).toBe(original);
    expect(await store.read([], (s) => Object.keys(s.files))).toEqual(['keep']);
  } finally {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  }
});
