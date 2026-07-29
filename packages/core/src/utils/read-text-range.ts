/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createReadStream, type Stats } from 'node:fs';
import { stat, type FileHandle } from 'node:fs/promises';
import { TextDecoder } from 'node:util';
import { detectFileEncoding, readFileWithEncodingInfo } from './fileUtils.js';
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
}

/**
 * Request shape for {@link readTextRangeFromHandle}.
 *
 * No `path`: the read is bound to the descriptor, so there is nothing for a
 * path to disambiguate. `maxOutputBytes` is required rather than optional — a
 * handle-bound read exists because some caller pinned an inode at a security
 * boundary, and what makes such a read safe is that the bytes it *returns* are
 * capped.
 */
export interface ReadTextRangeFromHandleRequest {
  offset?: number;
  limit?: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
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

export async function readTextRange(
  request: ReadTextRangeRequest,
): Promise<ReadTextRangeResult> {
  request.signal?.throwIfAborted();
  const stats = request.stats ?? (await stat(request.path));
  const maxOutputBytes = normalizeMaxBytes(request.maxOutputBytes);

  if (stats.size < TEXT_RANGE_FAST_PATH_MAX_SIZE) {
    const { content, encoding, bom } = await readFileWithEncodingInfo(
      request.path,
      request.signal,
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

  return readLargeUtf8Range(request.path, request, maxOutputBytes);
}

/**
 * Range read bound to a caller-owned descriptor.
 *
 * Always streams: the buffering fast path would read the whole file, and a
 * caller reaches for a handle precisely when it needs the read bounded. The
 * handle is borrowed — every read uses an explicit position, and this function
 * never closes it.
 */
export async function readTextRangeFromHandle(
  fileHandle: FileHandle,
  request: ReadTextRangeFromHandleRequest,
): Promise<ReadTextRangeResult> {
  request.signal?.throwIfAborted();
  return readLargeUtf8Range(
    fileHandle,
    request,
    normalizeMaxBytes(request.maxOutputBytes),
  );
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
  source: string | FileHandle,
  request: { offset?: number; limit?: number; signal?: AbortSignal },
  maxOutputBytes: number,
): Promise<ReadTextRangeResult> {
  const encoding = await detectFileEncoding(source);
  // Detection is one bounded 8 KiB read, but check here anyway so an abort
  // that lands during it is still observed before the streaming loop starts.
  request.signal?.throwIfAborted();
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
  const decoder = new TextDecoder('utf-8', {
    fatal: true,
    ignoreBOM: true,
  });

  let pathStream: ReturnType<typeof createReadStream> | undefined;
  let chunks: AsyncIterable<Buffer>;
  if (typeof source === 'string') {
    pathStream = createReadStream(source, {
      highWaterMark: 512 * 1024,
      signal: request.signal,
    });
    chunks = pathStream;
  } else {
    chunks = chunksFromHandle(source, 0, request.signal);
  }

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

/**
 * Sequential chunks off a borrowed descriptor, starting at `from`.
 *
 * Reads use explicit positions, so the caller's file position is untouched and
 * two readers can share one handle. Each chunk is a fresh buffer and stays
 * valid after the next iteration — do not "optimize" this into one reused
 * buffer without giving the yielded value a documented lifetime.
 */
async function* chunksFromHandle(
  fileHandle: FileHandle,
  from = 0,
  signal?: AbortSignal,
): AsyncGenerator<Buffer> {
  const highWaterMark = 512 * 1024;
  let position = from;
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
