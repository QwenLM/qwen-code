/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createToolFileStateCache,
  isFullFileRead,
} from '../utils/fileStateCache.js';
import { recordShellFileReads } from './shell.js';
let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'shell-read-'));
  writeFileSync(join(cwd, 'file.txt'), 'first\nsecond\nthird');
});
afterEach(() => rmSync(cwd, { force: true, recursive: true }));
describe('Shell read-state sources', () => {
  it.each([
    'cat file.txt',
    'cat -n file.txt',
    'bat -p file.txt',
    'nl file.txt',
  ])('registers %s', async (command) => {
    const cache = createToolFileStateCache();
    await recordShellFileReads(
      command,
      cwd,
      cache,
      0,
      new AbortController().signal,
    );
    expect(cache.get(join(cwd, 'file.txt'))?.content).toBe(
      'first\nsecond\nthird',
    );
  });
  it.each([
    'cat file.txt | head',
    'cat file.txt > out',
    'cat $FILE',
    'cat file.txt; echo other',
    'sed -i x file.txt',
    'cat *.txt',
  ])('ignores unconfirmed reads: %s', async (command) => {
    const cache = createToolFileStateCache();
    await recordShellFileReads(
      command,
      cwd,
      cache,
      0,
      new AbortController().signal,
    );
    expect(cache.size).toBe(0);
  });
  it('records actual ranges without claiming a full read', async () => {
    const cache = createToolFileStateCache();
    await recordShellFileReads(
      "sed -n '2,3p' file.txt",
      cwd,
      cache,
      0,
      new AbortController().signal,
    );
    const record = cache.get(join(cwd, 'file.txt'))!;
    expect(record.content).toBe('second\nthird');
    expect(isFullFileRead(record)).toBe(false);
  });
  it('requires successful search and marks the extra disk contents unseen', async () => {
    const cache = createToolFileStateCache();
    const signal = new AbortController().signal;
    await recordShellFileReads('rg -n first file.txt', cwd, cache, 1, signal);
    expect(cache.size).toBe(0);
    await recordShellFileReads('rg -n first file.txt', cwd, cache, 0, signal);
    expect(cache.get(join(cwd, 'file.txt'))?.contentNotInModelContext).toBe(
      true,
    );
    const previous = cache.get(join(cwd, 'file.txt'));
    await recordShellFileReads('cat file.txt', cwd, cache, 0, signal);
    expect(cache.get(join(cwd, 'file.txt'))).toBe(previous);
  });
  it('does not seed cancelled or oversized files', async () => {
    const cache = createToolFileStateCache();
    const abort = new AbortController();
    abort.abort();
    await recordShellFileReads('cat file.txt', cwd, cache, 0, abort.signal);
    expect(cache.size).toBe(0);
    writeFileSync(join(cwd, 'large'), 'x'.repeat(10 * 1024 * 1024 + 1));
    await recordShellFileReads(
      'cat large',
      cwd,
      cache,
      0,
      new AbortController().signal,
    );
    expect(cache.size).toBe(0);
  });
});
