/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { iconvEncode } from './iconvHelper.js';
import {
  LargeNonUtf8TextError,
  readTextRange,
  readTextRangeFromHandle,
} from './read-text-range.js';

describe('readTextRange', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'read-text-range-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function writeFile(
    name: string,
    data: string | Buffer,
  ): Promise<string> {
    const filePath = path.join(tempDir, name);
    await fs.writeFile(filePath, data);
    return filePath;
  }

  function largeUtf8Lines(lineCount: number): string {
    return Array.from(
      { length: lineCount },
      (_, index) => `line-${index + 1} ${'x'.repeat(180)}`,
    ).join('\n');
  }

  it('preserves split newline semantics on the fast path', async () => {
    const emptyPath = await writeFile('empty.txt', '');
    await expect(
      readTextRange({
        path: emptyPath,
        offset: 0,
        limit: 10,
        maxOutputBytes: 100,
      }),
    ).resolves.toMatchObject({
      content: '',
      originalLineCount: 1,
      truncatedByBytes: false,
    });

    const trailingPath = await writeFile('trailing.txt', 'a\n');
    await expect(
      readTextRange({
        path: trailingPath,
        offset: 0,
        limit: 10,
        maxOutputBytes: 100,
      }),
    ).resolves.toMatchObject({
      content: 'a\n',
      originalLineCount: 2,
      truncatedByBytes: false,
    });
  });

  it('streams a large UTF-8 file and returns the requested range', async () => {
    const filePath = await writeFile('large.log', largeUtf8Lines(65_000));

    const result = await readTextRange({
      path: filePath,
      offset: 42_000,
      limit: 3,
      maxOutputBytes: 10_000,
    });

    expect(result.content.split('\n')).toEqual([
      expect.stringContaining('line-42001'),
      expect.stringContaining('line-42002'),
      expect.stringContaining('line-42003'),
    ]);
    expect(result.originalLineCount).toBeGreaterThanOrEqual(42_004);
    expect(result.originalLineCount).toBeLessThan(65_000);
    expect(result.originalLineCountExact).toBe(false);
    expect(result.encoding).toBe('utf-8');
    expect(result.bom).toBe(false);
    expect(result.truncatedByBytes).toBe(false);
  });

  it('streams a requested range from a caller-owned file handle', async () => {
    const filePath = await writeFile('handle.log', largeUtf8Lines(2_000));
    const fileHandle = await fs.open(filePath, 'r');
    try {
      const stats = await fileHandle.stat();
      const result = await readTextRangeFromHandle(fileHandle, {
        offset: 1_500,
        limit: 3,
        maxOutputBytes: 10_000,
      });

      expect(result.content.split('\n')).toEqual([
        expect.stringContaining('line-1501'),
        expect.stringContaining('line-1502'),
        expect.stringContaining('line-1503'),
      ]);
      expect(result.originalLineCountExact).toBe(false);

      const beyondEof = await readTextRangeFromHandle(fileHandle, {
        offset: 10_000,
        limit: 3,
        maxOutputBytes: 10_000,
      });
      expect(beyondEof.content).toBe('');
      expect(beyondEof.originalLineCount).toBe(2_000);
      expect(beyondEof.originalLineCountExact).toBe(true);
      await expect(fileHandle.stat()).resolves.toMatchObject({
        size: stats.size,
      });
    } finally {
      await fileHandle.close();
    }
  });

  it('reads a handle-bound range beyond 10 MiB with a byte cap', async () => {
    const content = largeUtf8Lines(65_000);
    const marker = 'line-60001';
    expect(
      Buffer.byteLength(content.slice(0, content.indexOf(marker))),
    ).toBeGreaterThan(10 * 1024 * 1024);
    const filePath = await writeFile('deep-handle.log', content);
    const fileHandle = await fs.open(filePath, 'r');
    try {
      const result = await readTextRangeFromHandle(fileHandle, {
        offset: 60_000,
        limit: 3,
        maxOutputBytes: 256,
      });

      expect(result.content).toMatch(/^line-60001 /);
      expect(Buffer.byteLength(result.content)).toBeLessThanOrEqual(256);
      expect(result.content).not.toContain('\uFFFD');
      expect(result.truncatedByBytes).toBe(true);
      expect(result.originalLineCountExact).toBe(false);
    } finally {
      await fileHandle.close();
    }
  });

  it('accepts handle-bound UTF-8 when the encoding sample splits an emoji', async () => {
    const firstLine = `${'a'.repeat(8191)}🙂`;
    const filePath = await writeFile(
      'split-encoding-sample.log',
      `${firstLine}\n${'b'.repeat(300_000)}`,
    );
    const fileHandle = await fs.open(filePath, 'r');
    try {
      const result = await readTextRangeFromHandle(fileHandle, {
        offset: 0,
        limit: 1,
        maxOutputBytes: 16_384,
      });

      expect(result.content).toBe(firstLine);
      expect(result.encoding).toBe('utf-8');
      expect(result.content).not.toContain('\uFFFD');
    } finally {
      await fileHandle.close();
    }
  });

  it('reads the pinned inode after the path is replaced underneath it', async () => {
    // The handle variant takes no path, so "read the wrong file" is no longer
    // representable. What is still worth pinning down is the property that
    // motivated the API: once opened, the read follows the inode, not the name.
    const targetPath = await writeFile(
      'original.log',
      'safe-one\nsafe-two\nsafe-three\n',
    );
    const replacementPath = await writeFile(
      'replacement.log',
      'secret-one\nsecret-two\n',
    );
    const fileHandle = await fs.open(targetPath, 'r');
    try {
      await fs.rename(replacementPath, targetPath);

      const result = await readTextRangeFromHandle(fileHandle, {
        offset: 0,
        limit: 2,
        maxOutputBytes: 1_024,
      });

      expect(result.content).toBe('safe-one\nsafe-two');
      expect(result.content).not.toContain('secret');
    } finally {
      await fileHandle.close();
    }
  });

  it('reads the full file when limit is omitted', async () => {
    const filePath = await writeFile('small.txt', 'one\ntwo\nthree\n');
    const fileHandle = await fs.open(filePath, 'r');
    try {
      const omitted = await readTextRangeFromHandle(fileHandle, {
        maxOutputBytes: 10_000,
      });
      expect(omitted.content).toBe('one\ntwo\nthree\n');
      expect(omitted.originalLineCount).toBe(4);
      expect(omitted.originalLineCountExact).toBe(true);
      expect(omitted.truncatedByBytes).toBe(false);
    } finally {
      await fileHandle.close();
    }
  });

  it('bounds handle reads to the stat size, not live EOF', async () => {
    const filePath = await writeFile('bounded.txt', 'first\nsecond\n');
    const fileHandle = await fs.open(filePath, 'r');
    try {
      const result = await readTextRangeFromHandle(fileHandle, {
        offset: 10_000,
        limit: 3,
        maxOutputBytes: 10_000,
      });

      expect(result.content).toBe('');
      expect(result.originalLineCount).toBe(3);
      expect(result.originalLineCountExact).toBe(true);
    } finally {
      await fileHandle.close();
    }
  });

  it('streams a large UTF-8 file from the beginning when no range is provided', async () => {
    const filePath = await writeFile('large.log', largeUtf8Lines(65_000));

    const result = await readTextRange({
      path: filePath,
      maxOutputBytes: 10_000,
    });

    expect(result.content).toContain('line-1');
    expect(result.content).toContain('line-2');
    expect(result.content).not.toContain('line-65000');
    expect(result.originalLineCount).toBeGreaterThan(1);
    expect(result.originalLineCountExact).toBe(false);
    expect(result.truncatedByBytes).toBe(true);
  });

  it('returns empty content when a large UTF-8 range starts beyond EOF', async () => {
    const filePath = await writeFile('large.log', largeUtf8Lines(65_000));

    const result = await readTextRange({
      path: filePath,
      offset: 100_000,
      limit: 10,
      maxOutputBytes: 10_000,
    });

    expect(result.content).toBe('');
    expect(result.originalLineCount).toBe(65_000);
    expect(result.originalLineCountExact).toBe(true);
    expect(result.truncatedByBytes).toBe(false);
  });

  it('preserves CRLF content and line-ending metadata for large files', async () => {
    const content = Array.from(
      { length: 65_000 },
      (_, index) => `line-${index + 1} ${'x'.repeat(180)}`,
    ).join('\r\n');
    const filePath = await writeFile('crlf.log', content);

    const result = await readTextRange({
      path: filePath,
      offset: 1,
      limit: 2,
      maxOutputBytes: 10_000,
    });

    expect(result.content).toContain('\r\n');
    expect(result.content.split('\n')[0]).toMatch(/\r$/);
    expect(result.lineEnding).toBe('crlf');
    expect(result.originalLineCount).toBeGreaterThanOrEqual(4);
    expect(result.originalLineCount).toBeLessThan(65_000);
    expect(result.originalLineCountExact).toBe(false);
  });

  it('detects CRLF when the pair crosses a stream chunk boundary', async () => {
    const highWaterMark = 512 * 1024;
    const firstChunk = `${'a'.repeat(highWaterMark - 1)}\r`;
    const body = Buffer.concat([
      Buffer.from(firstChunk),
      Buffer.from('\nsecond\n'),
      Buffer.alloc(11 * 1024 * 1024, 'x'),
    ]);
    const filePath = await writeFile('split-crlf.log', body);

    const result = await readTextRange({
      path: filePath,
      offset: 0,
      limit: 2,
      maxOutputBytes: highWaterMark + 100,
    });

    expect(result.lineEnding).toBe('crlf');
    expect(result.content).toContain('\r\nsecond');
  });

  it('strips UTF-8 BOM from large file content and reports BOM metadata', async () => {
    const body = largeUtf8Lines(65_000);
    const filePath = await writeFile(
      'bom.log',
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(body)]),
    );

    const result = await readTextRange({
      path: filePath,
      offset: 0,
      limit: 1,
      maxOutputBytes: 10_000,
    });

    expect(result.content.charCodeAt(0)).not.toBe(0xfeff);
    expect(result.content).toContain('line-1');
    expect(result.bom).toBe(true);
    expect(result.encoding).toBe('utf-8');
    expect(result.originalLineCountExact).toBe(false);
  });

  it('does not split a UTF-8 character when byte-truncating', async () => {
    const filePath = await writeFile('emoji.txt', `a🙂b`);

    const result = await readTextRange({
      path: filePath,
      offset: 0,
      limit: 1,
      maxOutputBytes: 4,
    });

    expect(result.content).toBe('a');
    expect(result.content).not.toContain('\uFFFD');
    expect(result.truncatedByBytes).toBe(true);
    expect(result.originalLineCountExact).toBe(true);
  });

  it('rejects large non-UTF-8 files with a targeted error', async () => {
    const gbkLine = iconvEncode('中文日志行\n', 'gbk');
    const repeatCount = Math.ceil((11 * 1024 * 1024) / gbkLine.length);
    const filePath = await writeFile(
      'gbk.log',
      Buffer.concat(Array.from({ length: repeatCount }, () => gbkLine)),
    );

    await expect(
      readTextRange({
        path: filePath,
        offset: 0,
        limit: 10,
        maxOutputBytes: 10_000,
      }),
    ).rejects.toThrow(LargeNonUtf8TextError);
  });

  it('rejects large files with invalid UTF-8 beyond the encoding sample', async () => {
    const mostlyAsciiThenGbk = Buffer.concat([
      Buffer.alloc(9 * 1024, 'a'),
      iconvEncode('你好', 'gbk'),
      Buffer.alloc(11 * 1024 * 1024, 'b'),
    ]);
    const filePath = await writeFile('late-gbk.log', mostlyAsciiThenGbk);

    const promise = readTextRange({
      path: filePath,
      offset: 0,
      limit: 500,
      maxOutputBytes: 20_000,
    });

    await expect(promise).rejects.toThrow(LargeNonUtf8TextError);
    await expect(promise).rejects.toThrow(/invalid UTF-8 byte sequence/);
    await expect(promise).rejects.toMatchObject({ reason: 'invalid-utf8' });
  });

  it('bounds selected output for a large single-line file', async () => {
    const filePath = await writeFile(
      'single-line.log',
      'x'.repeat(11 * 1024 * 1024),
    );

    const result = await readTextRange({
      path: filePath,
      offset: 0,
      limit: 1,
      maxOutputBytes: 1024,
    });

    expect(result.content).toBe('x'.repeat(1024));
    expect(result.originalLineCount).toBe(1);
    expect(result.originalLineCountExact).toBe(false);
    expect(result.truncatedByBytes).toBe(true);
  });

  it('propagates aborts before reading large files', async () => {
    const filePath = await writeFile('large.log', largeUtf8Lines(65_000));
    const controller = new AbortController();
    controller.abort();

    await expect(
      readTextRange({
        path: filePath,
        offset: 0,
        limit: 10,
        maxOutputBytes: 10_000,
        signal: controller.signal,
      }),
    ).rejects.toThrow(/abort/i);
  });

  it('propagates aborts while streaming large files', async () => {
    const filePath = await writeFile('large.log', largeUtf8Lines(80_000));
    const controller = new AbortController();
    const promise = readTextRange({
      path: filePath,
      offset: 70_000,
      limit: 10,
      maxOutputBytes: 10_000,
      signal: controller.signal,
    });

    setTimeout(() => controller.abort(), 0);

    await expect(promise).rejects.toThrow(/abort/i);
  });

  it('propagates a pre-aborted signal to a handle-bound read', async () => {
    const filePath = await writeFile('handle-abort.log', largeUtf8Lines(2_000));
    const fileHandle = await fs.open(filePath, 'r');
    const controller = new AbortController();
    controller.abort();
    try {
      await expect(
        readTextRangeFromHandle(fileHandle, {
          offset: 0,
          limit: 3,
          maxOutputBytes: 10_000,
          signal: controller.signal,
        }),
      ).rejects.toThrow(/abort/i);
    } finally {
      await fileHandle.close();
    }
  });

  it('propagates an abort that lands during a handle-bound stream', async () => {
    const filePath = await writeFile(
      'handle-abort-stream.log',
      largeUtf8Lines(80_000),
    );
    const fileHandle = await fs.open(filePath, 'r');
    const controller = new AbortController();
    try {
      const promise = readTextRangeFromHandle(fileHandle, {
        offset: 70_000,
        limit: 10,
        maxOutputBytes: 10_000,
        signal: controller.signal,
      });
      setTimeout(() => controller.abort(), 0);
      await expect(promise).rejects.toThrow(/abort/i);
    } finally {
      await fileHandle.close();
    }
  });
});
