/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtemp,
  rm,
  readFile,
  writeFile,
  mkdir,
  stat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readParentRecords,
  writeFork,
  removeFork,
  ForkExistsError,
} from './forkStore.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rc-forkstore-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('readParentRecords', () => {
  it('parses a real multi-line JSONL transcript', async () => {
    const body =
      JSON.stringify({ uuid: 'a', sessionId: 's' }) +
      '\n' +
      JSON.stringify({ uuid: 'b', sessionId: 's' }) +
      '\n';
    await writeFile(join(dir, 'parent.jsonl'), body, 'utf8');
    const records = await readParentRecords(dir, 'parent');
    expect(records).toEqual([
      { uuid: 'a', sessionId: 's' },
      { uuid: 'b', sessionId: 's' },
    ]);
  });

  it('returns null when the file is missing (ENOENT)', async () => {
    expect(await readParentRecords(dir, 'nope')).toBeNull();
  });

  it('returns null for an empty file', async () => {
    await writeFile(join(dir, 'empty.jsonl'), '', 'utf8');
    expect(await readParentRecords(dir, 'empty')).toBeNull();
  });

  it('skips corrupt lines but keeps valid ones', async () => {
    const body = `${JSON.stringify({ uuid: 'a' })}\nnot json\n${JSON.stringify({ uuid: 'c' })}\n`;
    await writeFile(join(dir, 'mixed.jsonl'), body, 'utf8');
    const records = await readParentRecords(dir, 'mixed');
    expect(records).toEqual([{ uuid: 'a' }, { uuid: 'c' }]);
  });

  it('returns null when every line is corrupt (zero valid records)', async () => {
    await writeFile(join(dir, 'bad.jsonl'), 'nope\nalso nope\n', 'utf8');
    expect(await readParentRecords(dir, 'bad')).toBeNull();
  });
});

describe('writeFork', () => {
  it('creates the chats dir and a 0600 file with exact bytes', async () => {
    const nested = join(dir, 'projects', 'p', 'chats');
    const body = '{"x":1}\n';
    await writeFork(nested, 'newid', body);
    const written = await readFile(join(nested, 'newid.jsonl'), 'utf8');
    expect(written).toBe(body);
    const s = await stat(join(nested, 'newid.jsonl'));
    // Mode bits 0600 on the file (mask off the type bits).
    expect(s.mode & 0o777).toBe(0o600);
  });

  it('throws ForkExistsError when the target already exists (wx)', async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'dup.jsonl'), 'pre', 'utf8');
    await expect(writeFork(dir, 'dup', 'body')).rejects.toBeInstanceOf(
      ForkExistsError,
    );
  });
});

describe('removeFork', () => {
  it('unlinks an existing fork file', async () => {
    await writeFile(join(dir, 'gone.jsonl'), 'x', 'utf8');
    await removeFork(dir, 'gone');
    expect(await readParentRecords(dir, 'gone')).toBeNull();
  });

  it('is a no-op (does not throw) when the file is absent', async () => {
    await expect(removeFork(dir, 'absent')).resolves.toBeUndefined();
  });
});
