/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  mkdtemp,
  open,
  rm,
  writeFile,
  type FileHandle,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  readFileHandleBytes,
  digestFileReadSource,
} from './file-read-source.js';
import { detectFileEncoding, detectFileType } from './fileUtils.js';
import {
  readTextContentRangeFromHandle,
  readTextRangeFromHandle,
} from './read-text-range.js';
import { iconvEncode } from './iconvHelper.js';

describe('borrowed file bytes and complete text', () => {
  let directory: string;
  let handle: FileHandle;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'file-read-source-'));
    const filePath = join(directory, 'source');
    await writeFile(filePath, 'original\r\nsecond\r\nthird');
    handle = await open(filePath, 'r+');
  });
  afterEach(async () => {
    await handle.close();
    await rm(directory, { recursive: true, force: true });
  });

  it('joins short positional reads without changing the file offset', async () => {
    const size = (await handle.stat()).size;
    const actualRead = handle.read.bind(handle);
    const read = vi
      .spyOn(handle, 'read')
      .mockImplementation((async (
        buffer: Buffer,
        offset: number,
        length: number,
        position: number,
      ) =>
        actualRead(
          buffer,
          offset,
          Math.min(length, 3),
          position,
        )) as typeof handle.read);
    const bytes = await readFileHandleBytes(handle, size);
    read.mockRestore();
    const next = Buffer.alloc(1);
    await handle.read(next, 0, 1, null);
    expect({ content: bytes.toString(), next: next.toString() }).toEqual({
      content: 'original\r\nsecond\r\nthird',
      next: 'o',
    });
  });

  it('hashes the captured raw extent through short positional reads and leaves the borrower open', async () => {
    const stats = await handle.stat();
    const actualRead = handle.read.bind(handle);
    const read = vi
      .spyOn(handle, 'read')
      .mockImplementation((async (
        buffer: Buffer,
        offset: number,
        length: number,
        position: number,
      ) =>
        actualRead(
          buffer,
          offset,
          Math.min(length, 2),
          position,
        )) as typeof handle.read);
    try {
      expect(
        await digestFileReadSource({
          kind: 'descriptor',
          fileHandle: handle,
          stats,
        }),
      ).toBe(
        createHash('sha256')
          .update('original\r\nsecond\r\nthird')
          .digest('hex'),
      );
      const next = Buffer.alloc(1);
      await handle.read(next, 0, 1, null);
      expect(next.toString()).toBe('o');
    } finally {
      read.mockRestore();
    }
    expect((await handle.stat()).size).toBe(stats.size);
  });

  it('rejects truncation and read failures during raw hashing instead of returning a shorter digest', async () => {
    const source = {
      kind: 'descriptor' as const,
      fileHandle: handle,
      stats: await handle.stat(),
    };
    await handle.truncate(1);
    await expect(digestFileReadSource(source)).rejects.toThrow(
      'changed while hashing',
    );
    const read = vi
      .spyOn(handle, 'read')
      .mockRejectedValue(new Error('hash read failed'));
    try {
      await expect(digestFileReadSource(source)).rejects.toThrow(
        'hash read failed',
      );
    } finally {
      read.mockRestore();
    }
    expect((await handle.stat()).size).toBe(1);
  });

  it('stops at captured extent after growth and never closes the borrower', async () => {
    const size = (await handle.stat()).size;
    await handle.write(Buffer.from('APPENDED'), 0, 8, size);
    const bytes = await readFileHandleBytes(handle, size);
    const current = await handle.stat();
    expect({ bytes: bytes.toString(), size: current.size }).toEqual({
      bytes: 'original\r\nsecond\r\nthird',
      size: size + 8,
    });
  });

  it('propagates cancellation during a read', async () => {
    const controller = new AbortController();
    const actualRead = handle.read.bind(handle);
    const read = vi.spyOn(handle, 'read').mockImplementation((async (
      buffer: Buffer,
      offset: number,
      length: number,
      position: number,
    ) => {
      const result = await actualRead(buffer, offset, length, position);
      controller.abort(new Error('cancelled-during-read'));
      return result;
    }) as typeof handle.read);
    await expect(
      readFileHandleBytes(handle, 3, controller.signal),
    ).rejects.toThrow('cancelled-during-read');
    read.mockRestore();
  });

  it('does not disguise descriptor classification or encoding I/O failures', async () => {
    const failure = new Error('owned descriptor read failed');
    const read = vi.spyOn(handle, 'read').mockRejectedValue(failure);
    const source = {
      kind: 'descriptor' as const,
      fileHandle: handle,
      stats: await handle.stat(),
    };
    try {
      await expect(detectFileEncoding(handle)).rejects.toBe(failure);
      await expect(detectFileType('input.png', source)).rejects.toBe(failure);
      await expect(detectFileType('input.unknown', source)).rejects.toBe(
        failure,
      );
    } finally {
      read.mockRestore();
    }
  });

  it.each(['utf16-le', 'utf16-be', 'utf32-le', 'gbk'])(
    'preserves small %s range semantics',
    async (encoding) => {
      const content =
        '你好世界这是中文内容用于测试编码检测\r\n第二行包含足够多的中文用于编码识别\r\n第三行';
      const bytes = iconvEncode(content, encoding);
      const bom =
        encoding === 'utf16-le'
          ? Buffer.from([0xff, 0xfe])
          : encoding === 'utf16-be'
            ? Buffer.from([0xfe, 0xff])
            : encoding === 'utf32-le'
              ? Buffer.from([0xff, 0xfe, 0, 0])
              : Buffer.alloc(0);
      await handle.truncate(0);
      await handle.write(
        Buffer.concat([bom, bytes]),
        0,
        bom.length + bytes.length,
        0,
      );
      const request = {
        fileSize: bom.length + bytes.length,
        maxScanBytes: bom.length + bytes.length,
        maxOutputBytes: 4096,
        offset: 1,
        limit: 1,
      };
      const result = await readTextContentRangeFromHandle(handle, request);
      expect(result).toMatchObject({
        content: '第二行包含足够多的中文用于编码识别\r',
        originalLineCount: 3,
        originalLineCountExact: true,
        lineEnding: 'crlf',
        truncatedByBytes: false,
      });
      if (bom.length > 0)
        await expect(readTextRangeFromHandle(handle, request)).rejects.toThrow(
          'non-UTF-8',
        );
    },
  );
});
