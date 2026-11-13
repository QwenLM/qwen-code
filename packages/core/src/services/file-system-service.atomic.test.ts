/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { arePermissionBitsEnforced } from '../test-utils/permission-bits.js';
import { StandardFileSystemService } from './fileSystemService.js';

describe('user file writes through StandardFileSystemService', () => {
  const service = new StandardFileSystemService();
  let root: string;
  let first: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'fs-service-write-'));
    first = path.join(root, 'file');
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('preserves BOM, line endings and hard-link aliases', async () => {
    await fs.writeFile(first, 'original');
    const second = path.join(root, 'alias');
    await fs.link(first, second);
    const before = await fs.stat(first);

    await service.writeTextFile({
      path: first,
      content: 'first\nsecond\n',
      _meta: { bom: true, encoding: 'utf-8', lineEnding: 'crlf' },
    });

    const expected = Buffer.from('\ufefffirst\r\nsecond\r\n');
    expect(await fs.readFile(first)).toEqual(expected);
    expect(await fs.readFile(second)).toEqual(expected);
    expect((await fs.stat(first)).ino).toBe(before.ino);
    expect((await fs.stat(first)).nlink).toBe(2);
    expect(await fs.readdir(root)).toEqual(['alias', 'file']);
  });

  it.skipIf(!arePermissionBitsEnforced())(
    'refuses a read-only target and leaves no temporary files',
    async () => {
      await fs.writeFile(first, 'original');
      await fs.chmod(first, 0o444);
      try {
        await expect(
          service.writeTextFile({ path: first, content: 'replacement' }),
        ).rejects.toMatchObject({ code: 'EACCES' });
        expect(await fs.readFile(first, 'utf8')).toBe('original');
        expect(await fs.readdir(root)).toEqual(['file']);
      } finally {
        await fs.chmod(first, 0o600);
      }
    },
  );
});
