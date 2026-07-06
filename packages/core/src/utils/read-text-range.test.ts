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
import { LargeNonUtf8TextError, readTextRange } from './read-text-range.js';

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
});
