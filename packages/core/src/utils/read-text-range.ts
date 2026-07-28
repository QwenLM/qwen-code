/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createReadStream, type Stats } from 'node:fs';
import { stat, type FileHandle } from 'node:fs/promises';
import { TextDecoder } from 'node:util';
import {
  decodeBufferWithEncodingInfoAsync,
  detectFileEncoding,
  readFileWithEncodingInfo,
} from './fileUtils.js';
import { isUtf8CompatibleEncoding } from './encoding.js';
import {
  DEFAULT_RANGE_READ_BYTES,
  TEXT_RANGE_FAST_PATH_MAX_SIZE,
} from './text-range-constants.js';

export interface ReadTextRangeRequest {
  path: string;
  offset?: number;
  limit?: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
  stats?: Stats;
  /**
   * Optional caller-owned handle. When present, every read is bound to this
   * already-open inode; this function never closes the handle.
   */
  fileHandle?: FileHandle;
  /** Skip the small-file full-buffer fast path. */
  forceStreaming?: boolean;
  /**
   * Upper bound on bytes read off disk while locating the requested window.
   * Line offsets address a byte stream, so a deep `offset` costs a scan from
   * byte 0 — this is what keeps that scan from being unbounded. Defaults to
   * `Infinity` so non-boundary callers (the `read_file` tool) are unchanged;
   * security boundaries must pass a finite value.
   */
  maxScanBytes?: number;
}

export interface ReadTextRangeResult {
  content: string;
  originalLineCount: number;
  encoding?: string;
  bom?: boolean;
  lineEnding?: 'crlf' | 'lf';
  originalLineCountExact: boolean;
  truncatedByBytes: boolean;
}

export class LargeNonUtf8TextError extends Error {
  constructor(
    readonly encoding: string,
    readonly reason?: 'invalid-utf8',
  ) {
    super(
      reason === 'invalid-utf8'
        ? 'Large text file contains invalid UTF-8 byte sequence beyond the initial encoding sample. Convert or extract a smaller UTF-8 slice and read that instead.'
        : `Large non-UTF-8 text files are not supported for streaming reads (detected ${encoding}). Convert or extract a smaller UTF-8 slice and read that instead.`,
    );
    this.name = 'LargeNonUtf8TextError';
  }
}

/**
 * Raised when locating the requested line window would require reading more
 * than `maxScanBytes`. Distinct from `LargeNonUtf8TextError`: the file is
 * readable, the *offset* is what cannot be reached affordably.
 */
export class TextScanBudgetExceededError extends Error {
  constructor(
    readonly scannedBytes: number,
    readonly maxScanBytes: number,
  ) {
    super(
      `Locating the requested line window would read more than ${maxScanBytes} bytes (line offsets are resolved by scanning from the start of the file). Use a byte-offset read to reach this part of the file.`,
    );
    this.name = 'TextScanBudgetExceededError';
  }
}

export async function readTextRange(
  request: ReadTextRangeRequest,
): Promise<ReadTextRangeResult> {
  request.signal?.throwIfAborted();
  const stats =
    request.stats ??
    (request.fileHandle !== undefined
      ? await request.fileHandle.stat()
      : await stat(request.path));
  const maxOutputBytes = normalizeMaxBytes(request.maxOutputBytes);
  const maxScanBytes = request.maxScanBytes ?? Number.POSITIVE_INFINITY;

  // The fast path buffers the whole file, so it reads `stats.size` bytes no
  // matter how small the window is — a budget that only constrained the
  // streaming path would not be a budget. Falling through to streaming lets
  // the same bound apply, and raises `TextScanBudgetExceededError` if the
  // window really is out of reach.
  if (
    request.forceStreaming !== true &&
    stats.size < TEXT_RANGE_FAST_PATH_MAX_SIZE &&
    stats.size <= maxScanBytes
  ) {
    const { content, encoding, bom } =
      request.fileHandle === undefined
        ? await readFileWithEncodingInfo(request.path, request.signal)
        : await decodeBufferWithEncodingInfoAsync(
            await readFileHandleBuffer(
              request.fileHandle,
              stats.size,
              request.signal,
            ),
          );
    request.signal?.throwIfAborted();
    const range = sliceDecodedContent(
      content,
      request.offset,
      request.limit,
      maxOutputBytes,
    );
    return {
      ...range,
      encoding,
      bom,
      lineEnding: detectLineEndingFromContent(content),
    };
  }

  return readLargeUtf8Range(request, maxOutputBytes, maxScanBytes);
}

function normalizeMaxBytes(maxOutputBytes: number): number {
  if (maxOutputBytes === Number.POSITIVE_INFINITY) {
    return Number.POSITIVE_INFINITY;
  }
  if (!Number.isFinite(maxOutputBytes)) {
    return DEFAULT_RANGE_READ_BYTES;
  }
  return Math.max(0, Math.floor(maxOutputBytes));
}

function sliceDecodedContent(
  content: string,
  offset: number | undefined,
  limit: number | undefined,
  maxOutputBytes: number,
): Pick<
  ReadTextRangeResult,
  | 'content'
  | 'originalLineCount'
  | 'originalLineCountExact'
  | 'truncatedByBytes'
> {
  const lines = content.split('\n');
  const originalLineCount = lines.length;
  const start = Math.min(Math.max(0, offset ?? 0), originalLineCount);
  const end =
    limit === undefined
      ? originalLineCount
      : Math.min(start + Math.max(0, limit), originalLineCount);
  const selected = lines.slice(start, end).join('\n');
  const truncated = truncateUtf8(selected, maxOutputBytes);

  return {
    content: truncated.content,
    originalLineCount,
    originalLineCountExact: true,
    truncatedByBytes: truncated.truncated,
  };
}

async function readLargeUtf8Range(
  request: ReadTextRangeRequest,
  maxOutputBytes: number,
  maxScanBytes: number,
): Promise<ReadTextRangeResult> {
  const encoding =
    request.fileHandle === undefined
      ? await detectFileEncoding(request.path)
      : await detectFileHandleEncoding(request.fileHandle, request.signal);
  if (!isUtf8CompatibleEncoding(encoding)) {
    throw new LargeNonUtf8TextError(encoding);
  }

  const offset = Math.max(0, request.offset ?? 0);
  const endLine =
    offset + Math.max(0, request.limit ?? Number.POSITIVE_INFINITY);
  let currentLine = 0;
  let output = '';
  let outputBytes = 0;
  let truncatedByBytes = false;
  let bom = false;
  let firstChunk = true;
  let lineEnding: 'crlf' | 'lf' = 'lf';
  let previousChunkEndedWithCR = false;
  let originalLineCountExact = true;
  let stoppedEarly = false;
  let scannedBytes = 0;
  let budgetExhausted = false;
  const decoder = new TextDecoder('utf-8', {
    fatal: true,
    ignoreBOM: true,
  });

  const pathStream =
    request.fileHandle === undefined
      ? createReadStream(request.path, {
          highWaterMark: 512 * 1024,
          signal: request.signal,
        })
      : undefined;
  const chunks =
    pathStream ?? readFileHandleChunks(request.fileHandle!, request.signal);

  function appendSelected(fragment: string): void {
    if (fragment.length === 0 || truncatedByBytes) {
      return;
    }

    const available = maxOutputBytes - outputBytes;
    if (available <= 0) {
      truncatedByBytes = true;
      return;
    }

    const truncated = truncateUtf8(fragment, available);
    output += truncated.content;
    outputBytes += Buffer.byteLength(truncated.content, 'utf8');
    if (truncated.truncated) {
      truncatedByBytes = true;
    }
  }

  function isSelectedLine(): boolean {
    return currentLine >= offset && currentLine < endLine;
  }

  function decodeUtf8Chunk(
    chunk?: Buffer,
    options?: TextDecodeOptions,
  ): string {
    try {
      return decoder.decode(chunk, options);
    } catch {
      throw new LargeNonUtf8TextError(encoding, 'invalid-utf8');
    }
  }

  try {
    for await (const rawChunk of chunks) {
      request.signal?.throwIfAborted();
      // Checked on arrival of the *next* chunk rather than after consuming
      // the current one: reaching here at all proves there was more file to
      // read, which is what separates "budget ran out mid-file" from "the
      // file happened to end on the budget". Costs one chunk of overshoot.
      if (scannedBytes >= maxScanBytes) {
        budgetExhausted = true;
        break;
      }
      scannedBytes += (rawChunk as Buffer).length;
      let chunk = decodeUtf8Chunk(rawChunk as Buffer, { stream: true });
      if (firstChunk) {
        firstChunk = false;
        if (chunk.charCodeAt(0) === 0xfeff) {
          chunk = chunk.slice(1);
          bom = true;
        }
      }

      if (
        (previousChunkEndedWithCR && chunk.startsWith('\n')) ||
        chunk.includes('\r\n')
      ) {
        lineEnding = 'crlf';
      }
      previousChunkEndedWithCR = chunk.endsWith('\r');

      let start = 0;
      let newline = chunk.indexOf('\n', start);
      while (newline !== -1) {
        if (isSelectedLine()) {
          appendSelected(chunk.slice(start, newline));
          if (currentLine + 1 < endLine) {
            appendSelected('\n');
          }
        }
        currentLine++;
        start = newline + 1;
        if (currentLine >= endLine || truncatedByBytes) {
          originalLineCountExact = false;
          stoppedEarly = true;
          break;
        }
        newline = chunk.indexOf('\n', start);
      }

      if (start < chunk.length && isSelectedLine()) {
        appendSelected(chunk.slice(start));
      }
      if (currentLine >= endLine || truncatedByBytes) {
        originalLineCountExact = false;
        stoppedEarly = true;
        break;
      }
    }
  } finally {
    if (pathStream !== undefined && !pathStream.destroyed) {
      pathStream.destroy();
    }
  }

  if (budgetExhausted) {
    throw new TextScanBudgetExceededError(scannedBytes, maxScanBytes);
  }

  if (!stoppedEarly) {
    decodeUtf8Chunk();
  }

  return {
    content: output,
    originalLineCount: currentLine + 1,
    encoding: 'utf-8',
    bom,
    lineEnding,
    originalLineCountExact,
    truncatedByBytes,
  };
}

async function readFileHandleBuffer(
  fileHandle: FileHandle,
  size: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  const buffer = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    signal?.throwIfAborted();
    const read = await fileHandle.read(buffer, offset, size - offset, offset);
    if (read.bytesRead === 0) break;
    offset += read.bytesRead;
  }
  signal?.throwIfAborted();
  return offset === buffer.length ? buffer : buffer.subarray(0, offset);
}

async function* readFileHandleChunks(
  fileHandle: FileHandle,
  signal?: AbortSignal,
): AsyncGenerator<Buffer> {
  const highWaterMark = 512 * 1024;
  let position = 0;
  while (true) {
    signal?.throwIfAborted();
    const buffer = Buffer.allocUnsafe(highWaterMark);
    const { bytesRead } = await fileHandle.read(
      buffer,
      0,
      buffer.length,
      position,
    );
    signal?.throwIfAborted();
    if (bytesRead === 0) return;
    position += bytesRead;
    yield buffer.subarray(0, bytesRead);
  }
}

async function detectFileHandleEncoding(
  fileHandle: FileHandle,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const stats = await fileHandle.stat();
  if (stats.size === 0) return 'utf-8';

  const sample = Buffer.alloc(Math.min(8192, stats.size));
  const { bytesRead } = await fileHandle.read(sample, 0, sample.length, 0);
  signal?.throwIfAborted();
  if (bytesRead === 0) return 'utf-8';
  return (
    (await decodeBufferWithEncodingInfoAsync(sample.subarray(0, bytesRead)))
      .encoding ?? 'utf-8'
  );
}

function truncateUtf8(
  content: string,
  maxBytes: number,
): { content: string; truncated: boolean } {
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes <= maxBytes) {
    return { content, truncated: false };
  }
  if (maxBytes <= 0) {
    return { content: '', truncated: true };
  }

  const buffer = Buffer.from(content, 'utf8');
  let end = Math.min(maxBytes, buffer.length);
  // `end` is the first excluded byte. If it lands inside a multi-byte UTF-8
  // sequence, the byte at `end` is a continuation byte, so back up until the
  // prefix ends before the incomplete character.
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) {
    end--;
  }
  return {
    content: buffer.subarray(0, end).toString('utf8'),
    truncated: true,
  };
}

function detectLineEndingFromContent(content: string): 'crlf' | 'lf' {
  return content.includes('\r\n') ? 'crlf' : 'lf';
}
