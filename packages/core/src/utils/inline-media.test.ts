/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { base64ByteLength, readFileWithinBase64Limit } from './inline-media.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open) };
});

let directory: string;
beforeEach(async () => {
  directory = await fs.mkdtemp(join(tmpdir(), 'inline-media-test-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(directory, { recursive: true, force: true });
});

it.each([0, 1, 2, 3, 4, 5, 6])(
  'accounts for base64 padding at %i bytes',
  async (size) => {
    const bytes = Buffer.alloc(size, 42);
    const file = join(directory, 'media');
    await fs.writeFile(file, bytes);
    const limit = bytes.toString('base64').length;
    expect(base64ByteLength(size)).toBe(limit);
    expect(await readFileWithinBase64Limit(file, limit)).toEqual(bytes);
    await fs.appendFile(file, Buffer.alloc(3 - (size % 3) + 1));
    expect(await readFileWithinBase64Limit(file, limit)).toBeUndefined();
  },
);

it('reads at most the decoded ceiling plus one byte even when the file grows', async () => {
  const file = join(directory, 'media');
  await fs.writeFile(file, 'abc');
  const handle = await fs.open(file, 'r');
  vi.spyOn(fs, 'open').mockResolvedValueOnce(handle);
  const originalRead = handle.read.bind(handle);
  let total = 0;
  let grown = false;
  vi.spyOn(handle, 'read').mockImplementation(async (options) => {
    if (!grown) {
      grown = true;
      await fs.appendFile(file, Buffer.alloc(256 * 1024));
    }
    const result = await originalRead(options);
    total += result.bytesRead;
    return result;
  });
  const close = vi.spyOn(handle, 'close');
  expect(await readFileWithinBase64Limit(file, 8)).toBeUndefined();
  expect(total).toBe(7);
  expect(close).toHaveBeenCalledOnce();
});

it('closes the owned handle on abort during a read', async () => {
  const file = join(directory, 'media');
  await fs.writeFile(file, 'abc');
  const handle = await fs.open(file, 'r');
  vi.spyOn(fs, 'open').mockResolvedValueOnce(handle);
  const controller = new AbortController();
  const originalRead = handle.read.bind(handle);
  vi.spyOn(handle, 'read').mockImplementation(async (options) => {
    const result = await originalRead(options);
    controller.abort();
    return result;
  });
  const close = vi.spyOn(handle, 'close');
  await expect(
    readFileWithinBase64Limit(file, 4, controller.signal),
  ).rejects.toThrow(/abort/i);
  expect(close).toHaveBeenCalledOnce();
});

it('closes the owned handle on read failure and on success', async () => {
  const file = join(directory, 'media');
  await fs.writeFile(file, 'abc');
  for (const fail of [false, true]) {
    const handle = await fs.open(file, 'r');
    vi.spyOn(fs, 'open').mockResolvedValueOnce(handle);
    const close = vi.spyOn(handle, 'close');
    if (fail) {
      vi.spyOn(handle, 'read').mockRejectedValueOnce(new Error('read failure'));
      await expect(readFileWithinBase64Limit(file, 4)).rejects.toThrow(
        'read failure',
      );
    } else {
      expect(await readFileWithinBase64Limit(file, 4)).toEqual(
        Buffer.from('abc'),
      );
    }
    expect(close).toHaveBeenCalledOnce();
  }
});
