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
  /**
   * Upper bound on bytes read off disk while locating the requested window.
   * Line offsets address a byte stream, so a deep `offset` costs a scan from
   * byte 0 — this is what keeps that scan from being unbounded. Defaults to
   * `Infinity` so non-boundary callers (the `read_file` tool) are unchanged;
   * security boundaries must pass a finite value.
   */
  maxScanBytes?: number;
}

/**
 * Request shape for {@link readTextRangeFromHandle}.
 *
 * No `path`: the read is bound to the descriptor, so there is nothing for a
 * path to disambiguate. Both byte bounds are required rather than optional —
 * a handle-bound read exists because some caller pinned an inode at a security
 * boundary, and what makes such a read safe is that the bytes it *returns* and
 * the bytes it *scans* are each capped.
 */
export interface ReadTextRangeFromHandleRequest {
  offset?: number;
  limit?: number;
  /** Upper bound captured from the opened descriptor before reading. */
  fileSize: number;
  maxOutputBytes: number;
  maxScanBytes: number;
  signal?: AbortSignal;
}

export interface ReadTextRangeResult {
  content: string;
  originalLineCount: number;
  /**
   * Byte offset just past the last line the scanner passed, or `undefined` if
   * the stream reached EOF. Lets a line-addressed read hand back a byte cursor
   * so the *next* page costs O(1) instead of another scan from byte 0.
   */
  nextByteOffset?: number;
  encoding?: string;
  bom?: boolean;
  lineEnding?: 'crlf' | 'lf';
  originalLineCountExact: boolean;
  truncatedByBytes: boolean;
}

/**
 * Request for {@link readTextCursorWindowFromHandle}.
 *
 * `startOffset` is a byte offset, which is the whole point: a line offset has
 * to be resolved by scanning from byte 0, so paging by line is O(n²) across
 * pages. A byte offset is O(1), and `maxScanBytes` therefore does not apply.
 */
export interface ReadTextCursorWindowRequest {
  /** Byte offset to resume from. Expected to be the start of a line. */
  startOffset: number;
  /** File size as of the caller's `fstat`; bounds and EOF are relative to it. */
  fileSize: number;
  /** Maximum whole lines to return. */
  limit?: number;
  maxOutputBytes: number;
  /**
   * Bound on the forward scan used to reach a line boundary when
   * `startOffset` lands mid-line. A cursor this reader minted always points at
   * a line start, so the snap is a single byte comparison; the bound only
   * exists to stop a hand-written offset into a file with one enormous line
   * from scanning without limit.
   */
  maxSnapBytes: number;
  signal?: AbortSignal;
}

export interface ReadTextCursorWindowResult {
  content: string;
  /** Where reading actually began — differs from the request only after a snap. */
  startOffset: number;
  /** Byte offset of the next unreturned line. Absent once the file is exhausted. */
  nextOffset?: number;
  encoding: string;
  bom: boolean;
  lineEnding: 'crlf' | 'lf';
  truncatedByBytes: boolean;
}

/**
 * Raised when `startOffset` is not a line boundary and one cannot be reached
 * within `maxSnapBytes`. A malformed request, not an oversized file — the
 * caller supplied an offset this reader never would have.
 */
export class CursorNotAtLineBoundaryError extends Error {
  constructor(
    readonly startOffset: number,
    readonly maxSnapBytes: number,
  ) {
    super(
      `Byte offset ${startOffset} is not the start of a line, and no line break was found within ${maxSnapBytes} bytes after it. Resume from a cursor this reader returned.`,
    );
    this.name = 'CursorNotAtLineBoundaryError';
  }
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
  const stats = request.stats ?? (await stat(request.path));
  const maxOutputBytes = normalizeMaxBytes(request.maxOutputBytes);
  const maxScanBytes = request.maxScanBytes ?? Number.POSITIVE_INFINITY;

  // The fast path buffers the whole file, so it reads `stats.size` bytes no
  // matter how small the window is — a budget that only constrained the
  // streaming path would not be a budget. Falling through to streaming lets
  // the same bound apply, and raises `TextScanBudgetExceededError` if the
  // window really is out of reach.
  if (
    stats.size < TEXT_RANGE_FAST_PATH_MAX_SIZE &&
    stats.size <= maxScanBytes
  ) {
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

  return readLargeUtf8Range(
    request.path,
    request,
    maxOutputBytes,
    maxScanBytes,
    stats.size,
  );
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
    request.maxScanBytes,
    request.fileSize,
  );
}

/**
 * Read whole lines starting at a byte offset, and report where the next line
 * begins.
 *
 * This is the O(1)-per-page counterpart to the line-addressed readers: it seeks
 * rather than counting newlines from byte 0, so paging a large log costs
 * O(file) in total instead of O(file²).
 */
export async function readTextCursorWindowFromHandle(
  fileHandle: FileHandle,
  request: ReadTextCursorWindowRequest,
): Promise<ReadTextCursorWindowResult> {
  request.signal?.throwIfAborted();

  // Same refusal as the streamed line path. Without it a large GBK file — which
  // that path already rejects — would be byte-paged and decoded as UTF-8
  // garbage, which is worse than the error it replaces.
  const encoding = await detectFileEncoding(fileHandle);
  request.signal?.throwIfAborted();
  if (!isUtf8CompatibleEncoding(encoding)) {
    throw new LargeNonUtf8TextError(encoding);
  }

  const bom = await hasUtf8Bom(fileHandle, request.fileSize);
  const maxOutputBytes = normalizeMaxBytes(request.maxOutputBytes);
  const startOffset = await snapToLineStart(fileHandle, request);

  if (startOffset >= request.fileSize) {
    return {
      content: '',
      startOffset,
      encoding: 'utf-8',
      bom,
      lineEnding: 'lf',
      truncatedByBytes: false,
    };
  }

  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const decode = (chunk?: Buffer, options?: TextDecodeOptions): string => {
    try {
      return decoder.decode(chunk, options);
    } catch {
      throw new LargeNonUtf8TextError(encoding, 'invalid-utf8');
    }
  };

  const lines: string[] = [];
  let contentBytes = 0;
  // Bytes of the file consumed, relative to `startOffset`. Counts the newline
  // that terminates each emitted line, which `contentBytes` does not — the
  // next page begins after that byte, but the returned text carries no
  // trailing newline (matching the line-addressed readers).
  let consumedBytes = 0;
  let truncatedByBytes = false;
  let stop = false;
  let skipRestOfLine = false;
  // A CRLF line arrives here as text ending in '\r' with the '\n' consumed as
  // its terminator, so the returned text never contains the pair — testing
  // `content` for '\r\n' would report 'lf' for every single-line page.
  let sawCrlf = false;

  const emit = (line: string, hadNewline: boolean): void => {
    const separator = lines.length > 0 ? 1 : 0;
    const lineBytes = Buffer.byteLength(line, 'utf8');
    if (contentBytes + separator + lineBytes > maxOutputBytes) {
      if (lines.length > 0) {
        // Whole lines only: leave this one for the next page.
        stop = true;
        return;
      }
      // Except when the very first line does not fit. Emitting nothing would
      // return an empty page whose cursor had not advanced, and a client
      // following cursors would loop on it forever.
      const cut = truncateUtf8(line, maxOutputBytes);
      lines.push(cut.content);
      if (hadNewline && line.endsWith('\r')) sawCrlf = true;
      contentBytes = Buffer.byteLength(cut.content, 'utf8');
      consumedBytes += contentBytes;
      truncatedByBytes = true;
      // The rest of this line is dropped, and the cursor must skip it: every
      // cursor this reader mints points at a line start, so that resuming
      // never lands mid-line and quietly re-snaps over content.
      skipRestOfLine = true;
      stop = true;
      return;
    }
    lines.push(line);
    if (hadNewline && line.endsWith('\r')) sawCrlf = true;
    contentBytes += separator + lineBytes;
    consumedBytes += lineBytes + (hadNewline ? 1 : 0);
    if (request.limit !== undefined && lines.length >= request.limit) {
      stop = true;
    }
  };

  let pending = '';
  let firstChunk = true;
  let reachedEof = true;

  for await (const raw of chunksFromHandle(
    fileHandle,
    startOffset,
    request.fileSize,
    request.signal,
  )) {
    request.signal?.throwIfAborted();
    let text = decode(raw, { stream: true });
    if (firstChunk) {
      firstChunk = false;
      // A BOM only exists at byte 0, so it is only in our way when the window
      // starts there. Charge its bytes to `consumedBytes` so offsets stay
      // absolute even though the text drops it.
      if (startOffset === 0 && text.charCodeAt(0) === 0xfeff) {
        text = text.slice(1);
        consumedBytes += UTF8_BOM_BYTES;
      }
    }
    pending += text;

    let newline = pending.indexOf('\n');
    const pendingLine = newline === -1 ? pending : pending.slice(0, newline);
    const pendingSeparator = lines.length > 0 ? 1 : 0;
    if (
      contentBytes + pendingSeparator + Buffer.byteLength(pendingLine, 'utf8') >
      maxOutputBytes
    ) {
      if (lines.length === 0) {
        emit(pendingLine, newline !== -1);
      } else {
        stop = true;
      }
      reachedEof = false;
      break;
    }
    while (newline !== -1) {
      emit(pending.slice(0, newline), true);
      pending = pending.slice(newline + 1);
      if (stop) break;
      newline = pending.indexOf('\n');
    }
    if (stop) {
      reachedEof = false;
      break;
    }
  }

  if (reachedEof) {
    decode();
    // `pending` is whatever followed the last newline, and under
    // `split('\n')` semantics that is a line even when it is empty — which is
    // how a file ending in a newline keeps it.
    if (!stop) emit(pending, false);
  }

  if (skipRestOfLine) {
    const resumeAt = await snapToLineStart(
      fileHandle,
      {
        ...request,
        startOffset: startOffset + Math.max(consumedBytes, 1),
        // This offset was produced internally after returning a truncated prefix,
        // so it must advance past the rest of that line. `maxSnapBytes` protects
        // only client-supplied offsets.
        maxSnapBytes: request.fileSize,
      },
      true,
    );
    consumedBytes = resumeAt - startOffset;
  }

  const content = lines.join('\n');
  const nextOffset = startOffset + consumedBytes;
  return {
    content,
    startOffset,
    ...(nextOffset < request.fileSize ? { nextOffset } : {}),
    encoding: 'utf-8',
    bom,
    lineEnding: sawCrlf ? 'crlf' : 'lf',
    truncatedByBytes,
  };
}

const UTF8_BOM_BYTES = 3;

/** Byte 0x0A never appears inside a multi-byte UTF-8 sequence. */
const LINE_FEED = 0x0a;

async function hasUtf8Bom(
  fileHandle: FileHandle,
  fileSize: number,
): Promise<boolean> {
  if (fileSize < UTF8_BOM_BYTES) return false;
  const probe = Buffer.alloc(UTF8_BOM_BYTES);
  const { bytesRead } = await fileHandle.read(probe, 0, UTF8_BOM_BYTES, 0);
  return (
    bytesRead === UTF8_BOM_BYTES &&
    probe[0] === 0xef &&
    probe[1] === 0xbb &&
    probe[2] === 0xbf
  );
}

/**
 * Move `startOffset` forward to the beginning of a line.
 *
 * Searching the raw bytes for `0x0A` is safe without decoding: that byte
 * cannot occur inside a multi-byte UTF-8 sequence, so a character split across
 * the boundary cannot be mistaken for a line break.
 */
async function snapToLineStart(
  fileHandle: FileHandle,
  request: ReadTextCursorWindowRequest,
  allowEof = false,
): Promise<number> {
  const { startOffset, fileSize, maxSnapBytes, signal } = request;
  if (startOffset <= 0) return 0;
  if (startOffset >= fileSize) return startOffset;

  const previous = Buffer.alloc(1);
  const { bytesRead } = await fileHandle.read(previous, 0, 1, startOffset - 1);
  if (bytesRead === 1 && previous[0] === LINE_FEED) return startOffset;

  let scanned = 0;
  const snapEnd = Math.min(fileSize, startOffset + maxSnapBytes);
  for await (const chunk of chunksFromHandle(
    fileHandle,
    startOffset,
    snapEnd,
    signal,
  )) {
    const index = chunk.indexOf(LINE_FEED);
    if (index !== -1) return startOffset + scanned + index + 1;
    scanned += chunk.length;
  }
  if (allowEof) return fileSize;
  throw new CursorNotAtLineBoundaryError(startOffset, maxSnapBytes);
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
  maxScanBytes: number,
  sourceSize?: number,
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
  let scannedBytes = 0;
  // Bytes of the file the decoder has walked past. `scannedBytes` is
  // chunk-granular and cannot locate a line boundary, while mapping a decoded
  // string index back into its raw chunk is wrong because streaming decode can
  // hold an incomplete trailing sequence. Re-encoding each decoded fragment is
  // exact here because this path has already refused non-UTF-8.
  let consumedBytes = 0;
  const decoder = new TextDecoder('utf-8', {
    fatal: true,
    ignoreBOM: true,
  });

  let pathStream: ReturnType<typeof createReadStream> | undefined;
  let chunks: AsyncIterable<Buffer>;
  const sourceEnd = Math.min(
    sourceSize ?? Number.POSITIVE_INFINITY,
    maxScanBytes,
  );
  if (sourceEnd <= 0 && (sourceSize ?? 0) > 0) {
    throw new TextScanBudgetExceededError(0, maxScanBytes);
  }
  if (typeof source === 'string') {
    pathStream = createReadStream(source, {
      highWaterMark: 512 * 1024,
      signal: request.signal,
      ...(Number.isFinite(sourceEnd)
        ? { end: Math.max(0, sourceEnd - 1) }
        : {}),
    });
    chunks = pathStream;
  } else {
    chunks = chunksFromHandle(source, 0, sourceEnd, request.signal);
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
      scannedBytes += (rawChunk as Buffer).length;
      let chunk = decodeUtf8Chunk(rawChunk as Buffer, { stream: true });
      if (firstChunk) {
        firstChunk = false;
        if (chunk.charCodeAt(0) === 0xfeff) {
          chunk = chunk.slice(1);
          bom = true;
          consumedBytes += 3;
        }
      }

      if (
        isSelectedLine() &&
        previousChunkEndedWithCR &&
        chunk.startsWith('\n')
      ) {
        lineEnding = 'crlf';
      }
      previousChunkEndedWithCR = chunk.endsWith('\r');

      let start = 0;
      let newline = chunk.indexOf('\n', start);
      while (newline !== -1) {
        if (isSelectedLine()) {
          const fragment = chunk.slice(start, newline);
          if (fragment.endsWith('\r')) lineEnding = 'crlf';
          appendSelected(fragment);
          if (currentLine + 1 < endLine) {
            appendSelected('\n');
          }
        }
        consumedBytes +=
          Buffer.byteLength(chunk.slice(start, newline), 'utf8') + 1;
        currentLine++;
        start = newline + 1;
        if (currentLine >= endLine || truncatedByBytes) {
          originalLineCountExact = false;
          stoppedEarly = true;
          break;
        }
        newline = chunk.indexOf('\n', start);
      }

      if (!stoppedEarly && start < chunk.length) {
        const tail = chunk.slice(start);
        if (isSelectedLine()) {
          appendSelected(tail);
        }
        consumedBytes += Buffer.byteLength(tail, 'utf8');
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

  const budgetExhausted =
    !stoppedEarly &&
    sourceSize !== undefined &&
    sourceSize > maxScanBytes &&
    scannedBytes >= maxScanBytes;
  if (budgetExhausted) {
    throw new TextScanBudgetExceededError(scannedBytes, maxScanBytes);
  }

  if (!stoppedEarly) {
    decodeUtf8Chunk();
  }

  return {
    content: output,
    originalLineCount: currentLine + 1,
    ...(stoppedEarly &&
    !truncatedByBytes &&
    consumedBytes < (sourceSize ?? Number.POSITIVE_INFINITY)
      ? { nextByteOffset: consumedBytes }
      : {}),
    encoding: 'utf-8',
    bom,
    lineEnding,
    originalLineCountExact,
    truncatedByBytes,
  };
}

/**
 * Sequential chunks off a borrowed descriptor in `[from, toExclusive)`.
 *
 * Reads use explicit positions, so the caller's file position is untouched and
 * two readers can share one handle.
 */
async function* chunksFromHandle(
  fileHandle: FileHandle,
  from = 0,
  toExclusive = Number.POSITIVE_INFINITY,
  signal?: AbortSignal,
): AsyncGenerator<Buffer> {
  const highWaterMark = 512 * 1024;
  const buffer = Buffer.allocUnsafe(highWaterMark);
  let position = from;
  while (position < toExclusive) {
    signal?.throwIfAborted();
    const bytesToRead = Math.min(highWaterMark, toExclusive - position);
    const { bytesRead } = await fileHandle.read(
      buffer,
      0,
      bytesToRead,
      position,
    );
    signal?.throwIfAborted();
    if (bytesRead === 0) return;
    position += bytesRead;
    // `buffer` is reused across iterations, so each yielded view is valid
    // only until the next read; consumers must decode or copy it before
    // advancing the generator.
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
