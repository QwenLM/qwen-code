/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { iconvEncode } from './iconvHelper.js';
import {
  CursorNotAtLineBoundaryError,
  LargeNonUtf8TextError,
  detectLineEndingFromContent,
  readTextCursorWindowFromHandle,
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
    const readSpy = vi.spyOn(fileHandle, 'read');
    try {
      const stats = await fileHandle.stat();
      const result = await readTextRangeFromHandle(fileHandle, {
        offset: 1_500,
        limit: 3,
        fileSize: stats.size,
        maxOutputBytes: 10_000,
        maxScanBytes: Number.MAX_SAFE_INTEGER,
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
        fileSize: stats.size,
        maxOutputBytes: 10_000,
        maxScanBytes: Number.MAX_SAFE_INTEGER,
      });
      expect(beyondEof.content).toBe('');
      expect(beyondEof.originalLineCount).toBe(2_000);
      expect(beyondEof.originalLineCountExact).toBe(true);
      await expect(fileHandle.stat()).resolves.toMatchObject({
        size: stats.size,
      });
      expect(
        readSpy.mock.calls.some(
          ([buffer]) => Buffer.isBuffer(buffer) && buffer.length === 512 * 1024,
        ),
      ).toBe(true);
    } finally {
      readSpy.mockRestore();
      await fileHandle.close();
    }
  });

  it('bounds handle reads to the supplied snapshot and reuses the chunk buffer', async () => {
    const original = Buffer.from(`${'x'.repeat(99)}\n`.repeat(7_000));
    let current = original;
    let appended = false;
    const streamBuffers: Buffer[] = [];
    const streamReads: Array<{ position: number; length: number }> = [];
    const fileHandle = {
      read: vi.fn(
        async (
          buffer: Buffer,
          offset: number,
          length: number,
          position: number,
        ) => {
          const available = Math.max(0, current.length - position);
          const bytesRead = Math.min(length, available);
          current.copy(buffer, offset, position, position + bytesRead);
          if (buffer.length === 512 * 1024) {
            streamBuffers.push(buffer);
            streamReads.push({ position, length });
            if (!appended) {
              appended = true;
              current = Buffer.concat([
                current,
                Buffer.from('APPENDED-AFTER-OPEN\n'),
              ]);
            }
          }
          return { bytesRead, buffer };
        },
      ),
    } as unknown as import('node:fs/promises').FileHandle;

    const result = await readTextRangeFromHandle(fileHandle, {
      offset: 7_000,
      limit: 1,
      fileSize: original.length,
      maxOutputBytes: 10_000,
      maxScanBytes: Number.MAX_SAFE_INTEGER,
    });

    expect(result.content).toBe('');
    expect(streamBuffers.length).toBeGreaterThan(1);
    expect(streamBuffers.every((buffer) => buffer === streamBuffers[0])).toBe(
      true,
    );
    expect(
      streamReads.every(
        ({ position, length }) => position + length <= original.length,
      ),
    ).toBe(true);
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
      const stats = await fileHandle.stat();
      const result = await readTextRangeFromHandle(fileHandle, {
        offset: 60_000,
        limit: 3,
        fileSize: stats.size,
        maxOutputBytes: 256,
        maxScanBytes: Number.MAX_SAFE_INTEGER,
      });

      expect(result.content).toMatch(/^line-60001 /);
      expect(Buffer.byteLength(result.content)).toBeLessThanOrEqual(256);
      expect(result.content).not.toContain('\uFFFD');
      expect(result.truncatedByBytes).toBe(true);
      expect(result.originalLineCountExact).toBe(false);
      await expect(fileHandle.stat()).resolves.toMatchObject({
        size: stats.size,
      });
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
      const stats = await fileHandle.stat();
      const result = await readTextRangeFromHandle(fileHandle, {
        offset: 0,
        limit: 1,
        fileSize: stats.size,
        maxOutputBytes: 16_384,
        maxScanBytes: Number.MAX_SAFE_INTEGER,
      });

      expect(result.content).toBe(firstLine);
      expect(result.encoding).toBe('utf-8');
      expect(result.content).not.toContain('\uFFFD');
      await expect(fileHandle.stat()).resolves.toMatchObject({
        size: stats.size,
      });
    } finally {
      await fileHandle.close();
    }
  });

  it('does not read bytes appended past the supplied handle stats', async () => {
    const filePath = await writeFile(
      'growing.log',
      `${'a'.repeat(500_000)}\n${'b'.repeat(50_000)}`,
    );
    const fileHandle = await fs.open(filePath, 'r');
    const stats = await fileHandle.stat();
    let appended = false;
    const boundedHandle = {
      read: async (
        buffer: Buffer,
        offset: number,
        length: number,
        position: number,
      ) => {
        const result = await fileHandle.read(buffer, offset, length, position);
        if (!appended && length === 512 * 1024 && position === 0) {
          appended = true;
          await fs.appendFile(filePath, '\nAPPENDED');
        }
        return result;
      },
    } as unknown as import('node:fs/promises').FileHandle;

    try {
      const result = await readTextRangeFromHandle(boundedHandle, {
        offset: 1,
        limit: 2,
        fileSize: stats.size,
        maxOutputBytes: 100_000,
        maxScanBytes: Number.MAX_SAFE_INTEGER,
      });

      expect(appended).toBe(true);
      expect(result.content).toBe('b'.repeat(50_000));
      expect(result.content).not.toContain('APPENDED');
      expect(result.originalLineCount).toBe(2);
      expect(result.originalLineCountExact).toBe(true);
      await expect(fileHandle.stat()).resolves.toMatchObject({
        size: stats.size + 9,
      });
    } finally {
      await fileHandle.close();
    }
  });

  it.skipIf(process.platform === 'win32')(
    'reads the pinned inode after the path is replaced underneath it',
    async () => {
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
        const stats = await fileHandle.stat();
        await fs.rename(replacementPath, targetPath);

        const result = await readTextRangeFromHandle(fileHandle, {
          offset: 0,
          limit: 2,
          fileSize: stats.size,
          maxOutputBytes: 1_024,
          maxScanBytes: Number.MAX_SAFE_INTEGER,
        });

        expect(result.content).toBe('safe-one\nsafe-two');
        expect(result.content).not.toContain('secret');
      } finally {
        await fileHandle.close();
      }
    },
  );

  it('refuses a line offset that cannot be reached within maxScanBytes', async () => {
    const filePath = await writeFile('budget.log', largeUtf8Lines(5_000));

    await expect(
      readTextRange({
        path: filePath,
        offset: 4_000,
        limit: 20,
        maxOutputBytes: 262_144,
        maxScanBytes: 100_000,
      }),
    ).rejects.toMatchObject({
      name: 'TextScanBudgetExceededError',
      scannedBytes: 100_000,
      maxScanBytes: 100_000,
    });
  });

  it('serves a shallow window from a file far larger than maxScanBytes', async () => {
    const filePath = await writeFile('budget-head.log', largeUtf8Lines(5_000));

    const result = await readTextRange({
      path: filePath,
      offset: 0,
      limit: 3,
      maxOutputBytes: 262_144,
      maxScanBytes: 100_000,
    });

    expect(result.content.split('\n')).toEqual([
      expect.stringContaining('line-1 '),
      expect.stringContaining('line-2 '),
      expect.stringContaining('line-3 '),
    ]);
  });

  it('does not charge a budget failure to a file that ends within it', async () => {
    // The scan reaches EOF on the same chunk that exhausts the budget; the
    // window was fully satisfied, so there is nothing to refuse.
    // Goes through the handle variant purely because that is the one that
    // always streams: this file is far too small to leave the path variant's
    // buffering fast path, and the buffered path never consults the budget.
    const body = largeUtf8Lines(100);
    const filePath = await writeFile('budget-exact.log', body);
    const fileHandle = await fs.open(filePath, 'r');

    const result = await readTextRangeFromHandle(fileHandle, {
      offset: 98,
      limit: 10,
      fileSize: Buffer.byteLength(body),
      maxOutputBytes: 262_144,
      maxScanBytes: Buffer.byteLength(body),
    }).finally(() => fileHandle.close());

    expect(result.content.split('\n')).toEqual([
      expect.stringContaining('line-99 '),
      expect.stringContaining('line-100 '),
    ]);
    expect(result.originalLineCount).toBe(100);
    expect(result.originalLineCountExact).toBe(true);
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

  it('reports the next byte offset when a skipped line spans chunks', async () => {
    const firstLine = 'a'.repeat(512 * 1024 + 10);
    const body = `${firstLine}\nsecond\nthird`;
    const filePath = await writeFile('split-line-offset.log', body);
    const fileHandle = await fs.open(filePath, 'r');

    const result = await readTextRangeFromHandle(fileHandle, {
      offset: 1,
      limit: 1,
      fileSize: Buffer.byteLength(body),
      maxOutputBytes: 1_024,
      maxScanBytes: Buffer.byteLength(body),
    }).finally(() => fileHandle.close());

    expect(result.content).toBe('second');
    expect(result.nextByteOffset).toBe(
      Buffer.byteLength(`${firstLine}\nsecond\n`),
    );
  });

  it('does not report a cursor at EOF when the limit ends on the final newline', async () => {
    const body = 'first\nsecond\n';
    const filePath = await writeFile('exact-page.log', body);
    const fileHandle = await fs.open(filePath, 'r');

    const result = await readTextRangeFromHandle(fileHandle, {
      offset: 0,
      limit: 2,
      fileSize: Buffer.byteLength(body),
      maxOutputBytes: 1_024,
      maxScanBytes: Buffer.byteLength(body),
    }).finally(() => fileHandle.close());

    expect(result.content).toBe('first\nsecond');
    expect(result.nextByteOffset).toBeUndefined();
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

describe('readTextCursorWindowFromHandle', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'text-cursor-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function withHandle<T>(
    name: string,
    data: string | Buffer,
    run: (fh: fs.FileHandle, size: number) => Promise<T>,
  ): Promise<T> {
    const filePath = path.join(tempDir, name);
    await fs.writeFile(filePath, data);
    const size = (await fs.stat(filePath)).size;
    const fh = await fs.open(filePath, 'r');
    try {
      return await run(fh, size);
    } finally {
      await fh.close();
    }
  }

  /** Page to exhaustion, returning the pages and the byte spans they covered. */
  async function pageAll(
    fh: fs.FileHandle,
    fileSize: number,
    opts: { limit?: number; maxOutputBytes?: number } = {},
  ): Promise<{ pages: string[]; spans: Array<[number, number]> }> {
    const pages: string[] = [];
    const spans: Array<[number, number]> = [];
    let offset = 0;
    for (let guard = 0; guard < 10_000; guard++) {
      const page = await readTextCursorWindowFromHandle(fh, {
        startOffset: offset,
        fileSize,
        limit: opts.limit ?? 3,
        maxOutputBytes: opts.maxOutputBytes ?? 262_144,
        maxSnapBytes: 1_048_576,
      });
      pages.push(page.content);
      spans.push([page.startOffset, page.nextOffset ?? fileSize]);
      if (page.nextOffset === undefined) return { pages, spans };
      expect(page.nextOffset).toBeGreaterThan(offset);
      offset = page.nextOffset;
    }
    throw new Error('paging did not terminate');
  }

  it('reconstructs the file exactly from the spans it reports', async () => {
    const body = Array.from(
      { length: 200 },
      (_, i) => `line-${i} ${'x'.repeat(i % 40)}`,
    ).join('\n');
    await withHandle('span.log', body, async (fh, size) => {
      const { spans } = await pageAll(fh, size);
      // Spans must tile [0, size) with no gap and no overlap.
      expect(spans[0][0]).toBe(0);
      for (let i = 1; i < spans.length; i++) {
        expect(spans[i][0]).toBe(spans[i - 1][1]);
      }
      expect(spans[spans.length - 1][1]).toBe(size);

      const raw = await fs.readFile(path.join(tempDir, 'span.log'));
      const rebuilt = spans
        .map(([from, to]) => raw.subarray(from, to).toString('utf8'))
        .join('');
      expect(rebuilt).toBe(body);
    });
  });

  it('round-trips content when pages are rejoined with a newline', async () => {
    // No trailing newline: `content` drops the terminator of its last line,
    // matching the line-addressed readers, so a page boundary that lands
    // exactly on EOF would otherwise swallow the file's final newline. Byte
    // spans, asserted above, are the lossless reassembly path.
    const body = 'alpha\nbeta\ngamma\ndelta';
    await withHandle('join.log', body, async (fh, size) => {
      const { pages } = await pageAll(fh, size, { limit: 2 });
      expect(pages.join('\n')).toBe(body);
    });
  });

  it('preserves a trailing newline as split semantics do', async () => {
    await withHandle('trailing.log', 'a\nb\n', async (fh, size) => {
      const page = await readTextCursorWindowFromHandle(fh, {
        startOffset: 0,
        fileSize: size,
        maxOutputBytes: 1_024,
        maxSnapBytes: 1_024,
      });
      expect(page.content).toBe('a\nb\n');
      expect(page.nextOffset).toBeUndefined();
    });
  });

  it('snaps a mid-line offset forward to the next line start', async () => {
    await withHandle('snap.log', 'alpha\nbeta\ngamma\n', async (fh, size) => {
      const page = await readTextCursorWindowFromHandle(fh, {
        startOffset: 2, // inside "alpha"
        fileSize: size,
        limit: 1,
        maxOutputBytes: 1_024,
        maxSnapBytes: 1_024,
      });
      expect(page.startOffset).toBe(6);
      expect(page.content).toBe('beta');
    });
  });

  it('refuses a mid-line offset when no line break is within maxSnapBytes', async () => {
    await withHandle('one-line.log', 'x'.repeat(5_000), async (fh, size) => {
      await expect(
        readTextCursorWindowFromHandle(fh, {
          startOffset: 10,
          fileSize: size,
          maxOutputBytes: 1_024,
          maxSnapBytes: 64,
        }),
      ).rejects.toBeInstanceOf(CursorNotAtLineBoundaryError);
    });
  });

  it('makes progress when a single line exceeds maxOutputBytes', async () => {
    const body = `${'y'.repeat(5_000)}\ntail\n`;
    await withHandle('long-line.log', body, async (fh, size) => {
      const first = await readTextCursorWindowFromHandle(fh, {
        startOffset: 0,
        fileSize: size,
        maxOutputBytes: 100,
        maxSnapBytes: 1_024,
      });
      expect(first.truncatedByBytes).toBe(true);
      expect(first.content).toBe('y'.repeat(100));
      // The cursor skips to the start of the *next* line rather than stopping
      // mid-line. Resuming mid-line would make the following call snap forward
      // and silently drop the rest of this line at the page seam; skipping it
      // here loses the same bytes but says so via `truncatedByBytes`.
      expect(first.nextOffset).toBe(5_001);

      const second = await readTextCursorWindowFromHandle(fh, {
        startOffset: first.nextOffset!,
        fileSize: size,
        maxOutputBytes: 1_024,
        maxSnapBytes: 1_024,
      });
      expect(second.startOffset).toBe(5_001);
      expect(second.content).toBe('tail\n');
    });
  });

  it('stops decoding an oversized line before reading the next full chunk', async () => {
    const body = `${'z'.repeat(2 * 1024 * 1024)}\ntail\n`;
    await withHandle('bounded-line.log', body, async (fh, size) => {
      const readSpy = vi.spyOn(fh, 'read');
      const page = await readTextCursorWindowFromHandle(fh, {
        startOffset: 0,
        fileSize: size,
        maxOutputBytes: 100,
        maxSnapBytes: 1_024,
      });

      expect(page.content).toBe('z'.repeat(100));
      expect(page.nextOffset).toBe(2 * 1024 * 1024 + 1);
      const readCalls = readSpy.mock.calls as unknown as ReadonlyArray<
        readonly unknown[]
      >;
      expect(readCalls.map((call) => call[3])).not.toContain(512 * 1024);
    });
  });

  it('mints only line-start cursors, so paging never straddles a line', async () => {
    const body = `${'q'.repeat(300)}\nshort\n`;
    await withHandle('seam.log', body, async (fh, size) => {
      let offset = 0;
      const starts: number[] = [];
      for (let i = 0; i < 10; i++) {
        const page = await readTextCursorWindowFromHandle(fh, {
          startOffset: offset,
          fileSize: size,
          maxOutputBytes: 40,
          maxSnapBytes: 4_096,
        });
        starts.push(page.startOffset);
        // A cursor that already points at a line start needs no snapping, so
        // the reader begins exactly where it was told to.
        expect(page.startOffset).toBe(offset);
        if (page.nextOffset === undefined) break;
        offset = page.nextOffset;
      }
      expect(starts).toEqual([0, 301]);
    });
  });

  it('does not split a multibyte character when truncating', async () => {
    await withHandle(
      'multibyte.log',
      `${'中'.repeat(50)}\n`,
      async (fh, size) => {
        const page = await readTextCursorWindowFromHandle(fh, {
          startOffset: 0,
          fileSize: size,
          maxOutputBytes: 7, // two 3-byte chars fit, the third does not
          maxSnapBytes: 1_024,
        });
        expect(page.content).toBe('中中');
        expect(page.content).not.toContain('\uFFFD');
        expect(page.truncatedByBytes).toBe(true);
        // The file is a single line, so skipping its dropped remainder lands at
        // EOF and there is no next page.
        expect(page.nextOffset).toBeUndefined();
      },
    );
  });

  it('advances when no multibyte character fits in maxOutputBytes', async () => {
    await withHandle('tiny-budget.log', '中\nnext\n', async (fh, size) => {
      const first = await readTextCursorWindowFromHandle(fh, {
        startOffset: 0,
        fileSize: size,
        maxOutputBytes: 1,
        maxSnapBytes: 1_024,
      });
      expect(first.content).toBe('');
      expect(first.truncatedByBytes).toBe(true);
      expect(first.nextOffset).toBe(Buffer.byteLength('中\n'));
      expect(first.nextOffset).toBeGreaterThan(first.startOffset);

      const second = await readTextCursorWindowFromHandle(fh, {
        startOffset: first.nextOffset!,
        fileSize: size,
        maxOutputBytes: 1_024,
        maxSnapBytes: 1_024,
      });
      expect(second.content).toBe('next\n');
    });
  });

  it('ends paging after truncating a final line without a newline', async () => {
    await withHandle(
      'unterminated-long-line.log',
      'x'.repeat(5_000),
      async (fh, size) => {
        const page = await readTextCursorWindowFromHandle(fh, {
          startOffset: 0,
          fileSize: size,
          maxOutputBytes: 100,
          maxSnapBytes: 1_024,
        });
        expect(page.content).toBe('x'.repeat(100));
        expect(page.truncatedByBytes).toBe(true);
        expect(page.nextOffset).toBeUndefined();
      },
    );
  });

  it('reports the BOM and keeps offsets absolute across pages', async () => {
    const body = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('one\ntwo\nthree\n'),
    ]);
    await withHandle('bom.log', body, async (fh, size) => {
      const first = await readTextCursorWindowFromHandle(fh, {
        startOffset: 0,
        fileSize: size,
        limit: 1,
        maxOutputBytes: 1_024,
        maxSnapBytes: 1_024,
      });
      expect(first.bom).toBe(true);
      expect(first.content).toBe('one');
      // 3 BOM bytes + "one\n"
      expect(first.nextOffset).toBe(7);

      const second = await readTextCursorWindowFromHandle(fh, {
        startOffset: first.nextOffset!,
        fileSize: size,
        limit: 1,
        maxOutputBytes: 1_024,
        maxSnapBytes: 1_024,
      });
      expect(second.bom).toBe(true);
      expect(second.content).toBe('two');
    });
  });

  it('keeps CRLF terminators in the returned text', async () => {
    await withHandle('crlf.log', 'one\r\ntwo\r\n', async (fh, size) => {
      const page = await readTextCursorWindowFromHandle(fh, {
        startOffset: 0,
        fileSize: size,
        limit: 1,
        maxOutputBytes: 1_024,
        maxSnapBytes: 1_024,
      });
      expect(page.content).toBe('one\r');
      expect(page.lineEnding).toBe('crlf');
      expect(page.nextOffset).toBe(5);
    });
  });

  it('seeds an unterminated tail page from the terminator it resumes after', async () => {
    // The tail page of 'aa\r\nbb' holds only 'bb' — no terminator to test —
    // so without the byte pair before the window it would report 'lf' while
    // the first page reported 'crlf' for the same file.
    await withHandle('crlf-no-final.log', 'aa\r\nbb', async (fh, size) => {
      const first = await readTextCursorWindowFromHandle(fh, {
        startOffset: 0,
        fileSize: size,
        limit: 1,
        maxOutputBytes: 1_024,
        maxSnapBytes: 1_024,
      });
      expect(first.content).toBe('aa\r');
      expect(first.lineEnding).toBe('crlf');
      expect(first.nextOffset).toBe(4);

      const tail = await readTextCursorWindowFromHandle(fh, {
        startOffset: first.nextOffset!,
        fileSize: size,
        maxOutputBytes: 1_024,
        maxSnapBytes: 1_024,
      });
      expect(tail.content).toBe('bb');
      expect(tail.nextOffset).toBeUndefined();
      expect(tail.lineEnding).toBe('crlf');
    });

    // The LF counterpart stays 'lf': the peek only confirms a CRLF pair.
    await withHandle('lf-no-final.log', 'aa\nbb', async (fh, size) => {
      const tail = await readTextCursorWindowFromHandle(fh, {
        startOffset: 3,
        fileSize: size,
        maxOutputBytes: 1_024,
        maxSnapBytes: 1_024,
      });
      expect(tail.content).toBe('bb');
      expect(tail.lineEnding).toBe('lf');
    });
  });

  it('seeds from the snapped offset, not the requested one', async () => {
    // The request lands between '\r' and '\n'; the reader snaps to the next
    // line start and must seed from there. Seeding from the raw request would
    // probe 'a','\r' instead of the CRLF pair and misreport 'lf'.
    await withHandle('crlf-snap.log', 'aa\r\nbb', async (fh, size) => {
      const page = await readTextCursorWindowFromHandle(fh, {
        startOffset: 3, // between the '\r' and the '\n'
        fileSize: size,
        maxOutputBytes: 1_024,
        maxSnapBytes: 1_024,
      });
      expect(page.startOffset).toBe(4);
      expect(page.content).toBe('bb');
      expect(page.lineEnding).toBe('crlf');
    });
  });

  it('seeds at the minimum probe offset', async () => {
    // startOffset 2 is the earliest window that can probe — bytes 0-1 are the
    // terminator itself. Anything stricter skips the only line-ending evidence
    // the tail page of '\r\nbb' has.
    await withHandle('crlf-empty-first.log', '\r\nbb', async (fh, size) => {
      const first = await readTextCursorWindowFromHandle(fh, {
        startOffset: 0,
        fileSize: size,
        limit: 1,
        maxOutputBytes: 1_024,
        maxSnapBytes: 1_024,
      });
      expect(first.content).toBe('\r');
      expect(first.nextOffset).toBe(2);

      const tail = await readTextCursorWindowFromHandle(fh, {
        startOffset: first.nextOffset!,
        fileSize: size,
        maxOutputBytes: 1_024,
        maxSnapBytes: 1_024,
      });
      expect(tail.content).toBe('bb');
      expect(tail.lineEnding).toBe('crlf');
    });
  });

  it('counts the terminator a byte-truncated giant line is cut from', async () => {
    // A line longer than one read chunk (512 KiB) reaches the byte cut before
    // its terminator is ever decoded, so the cut cannot test it for '\r'. The
    // re-snap then steps over that terminator; counting it is what keeps this
    // page's lineEnding equal to the next page's, which seeds from the pair.
    const body = `${'x'.repeat(600 * 1024)}\r\nbb`;
    await withHandle('giant-crlf.log', body, async (fh, size) => {
      const first = await readTextCursorWindowFromHandle(fh, {
        startOffset: 0,
        fileSize: size,
        maxOutputBytes: 100,
        maxSnapBytes: 1_024,
      });
      expect(first.truncatedByBytes).toBe(true);
      expect(first.content).toBe('x'.repeat(100));
      expect(first.nextOffset).toBe(600 * 1024 + 2);
      expect(first.lineEnding).toBe('crlf');

      const second = await readTextCursorWindowFromHandle(fh, {
        startOffset: first.nextOffset!,
        fileSize: size,
        maxOutputBytes: 1_024,
        maxSnapBytes: 1_024,
      });
      expect(second.content).toBe('bb');
      expect(second.lineEnding).toBe('crlf');
    });
  });

  it('does not let a budget-excluded CRLF line flip lineEnding', async () => {
    // "aaa" (3) + sep (1) + "bbb" (3) = 7 <= 8; "ccc\r" would need 7+1+4 = 12 > 8.
    await withHandle(
      'crlf-budget.log',
      'aaa\nbbb\nccc\r\n',
      async (fh, size) => {
        const page = await readTextCursorWindowFromHandle(fh, {
          startOffset: 0,
          fileSize: size,
          maxOutputBytes: 8,
          maxSnapBytes: 1_024,
        });
        expect(page.content).toBe('aaa\nbbb');
        expect(page.lineEnding).toBe('lf');
        expect(page.nextOffset).toBe(8);
      },
    );
  });

  it('returns nothing for an offset at or past EOF', async () => {
    await withHandle('eof.log', 'a\nb\n', async (fh, size) => {
      const page = await readTextCursorWindowFromHandle(fh, {
        startOffset: size,
        fileSize: size,
        maxOutputBytes: 1_024,
        maxSnapBytes: 1_024,
      });
      expect(page.content).toBe('');
      expect(page.nextOffset).toBeUndefined();
    });
  });

  it('refuses a non-UTF-8 file', async () => {
    const gbk = iconvEncode('中文日志\n'.repeat(100), 'gbk');
    await withHandle('gbk.log', gbk, async (fh, size) => {
      await expect(
        readTextCursorWindowFromHandle(fh, {
          startOffset: 0,
          fileSize: size,
          maxOutputBytes: 1_024,
          maxSnapBytes: 1_024,
        }),
      ).rejects.toBeInstanceOf(LargeNonUtf8TextError);
    });
  });

  it('pages a file larger than one read chunk', async () => {
    // Forces lines to span chunk boundaries (chunks are 512 KiB).
    const body = Array.from(
      { length: 20_000 },
      (_, i) => `row-${i} ${'z'.repeat(60)}`,
    ).join('\n');
    await withHandle('big.log', body, async (fh, size) => {
      expect(size).toBeGreaterThan(1024 * 1024);
      const { pages, spans } = await pageAll(fh, size, { limit: 500 });
      expect(spans[spans.length - 1][1]).toBe(size);
      expect(pages.join('\n')).toBe(body);
    });
  });
});

describe('detectLineEndingFromContent', () => {
  it('reports crlf for small CRLF content', () => {
    expect(detectLineEndingFromContent('line1\r\nline2\r\n')).toBe('crlf');
  });

  it('reports lf when no CRLF is present', () => {
    expect(detectLineEndingFromContent('line1\nline2\n')).toBe('lf');
  });
});
