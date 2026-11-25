/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  symlinkSync,
  unlinkSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FileWriteTargetChangedError,
  pinFileWriteTarget,
  resolveFileWritePath,
  withFileWriteLock,
} from './fileWriteTarget.js';
import { writeFileAtomic } from './fileWriteUtils.js';

const dirs: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'write-target-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
describe('file write coordination', () => {
  it('serializes independent callers and releases a cancelled wait', async () => {
    const file = join(temp(), 'file');
    const order: number[] = [];
    let release!: () => void;
    const first = withFileWriteLock(file, undefined, async () => {
      order.push(1);
      await new Promise<void>((done) => (release = done));
      order.push(2);
    });
    await Promise.resolve();
    const abort = new AbortController();
    const second = withFileWriteLock(file, abort.signal, async () => {
      order.push(99);
    });
    const third = withFileWriteLock(file, undefined, async () => {
      order.push(3);
    });
    abort.abort();
    release();
    await expect(second).rejects.toThrow();
    await Promise.all([first, third]);
    expect(order).toEqual([1, 2, 3]);
  });
  it('detects a retargeted symlink without modifying either file', () => {
    const dir = temp();
    const a = join(dir, 'a');
    const b = join(dir, 'b');
    const link = join(dir, 'link');
    writeFileSync(a, 'a');
    writeFileSync(b, 'b');
    symlinkSync(a, link);
    const target = pinFileWriteTarget(link, resolveFileWritePath(link));
    unlinkSync(link);
    symlinkSync(b, link);
    expect(target.recheckBeforeWrite).toThrow(FileWriteTargetChangedError);
    expect(readFileSync(a, 'utf8')).toBe('a');
    expect(readFileSync(b, 'utf8')).toBe('b');
  });
  it('does not fall back to direct writing after target validation fails', async () => {
    const file = join(temp(), 'protected');
    writeFileSync(file, 'original');
    await expect(
      writeFileAtomic(file, 'replacement', {
        encoding: 'utf8',
        beforeWrite: () => {
          throw new FileWriteTargetChangedError();
        },
      }),
    ).rejects.toThrow(FileWriteTargetChangedError);
    expect(readFileSync(file, 'utf8')).toBe('original');
  });
  it('detects creation of a new target before committing', () => {
    const file = join(temp(), 'new');
    const target = pinFileWriteTarget(file, resolveFileWritePath(file));
    writeFileSync(file, 'external');
    expect(target.recheckBeforeWrite).toThrow(FileWriteTargetChangedError);
  });
});

it('releases a failed operation and allows unrelated paths to proceed', async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = withFileWriteLock('/workspace/a', undefined, async () => {
    await blocked;
    throw new Error('write failed');
  });
  const failed = first.catch((error: unknown) => error);
  const second = withFileWriteLock(
    '/workspace/./a',
    undefined,
    async () => 'next',
  );
  expect(
    await withFileWriteLock(
      '/workspace/b',
      undefined,
      async () => 'independent',
    ),
  ).toBe('independent');
  release();
  expect(await failed).toEqual(new Error('write failed'));
  expect(await second).toBe('next');
});
