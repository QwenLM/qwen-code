/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Line-oriented file reader with two code paths for optimal performance.
 *
 * Returns lines [offset, offset + maxLines) from a file.
 *
 * Fast path (regular files < 10MB):
 *   Reads the whole file with readFile(), then splits lines in memory.
 *   Avoids the per-chunk async overhead of createReadStream and is ~2x
 *   faster for typical source files.
 *
 * Streaming path (large files, pipes, devices, etc.):
 *   Uses createReadStream with manual indexOf('\n') scanning. Content is
 *   only accumulated for lines inside the requested range -- lines outside
 *   the range are counted (for totalLines) but discarded, so reading line
 *   1 of a huge file won't balloon RSS.
 *
 * Both paths strip UTF-8 BOM and \r (CRLF -> LF).
 *
 * mtime comes from fstat/stat on the already-open fd.
 *
 * maxBytes behavior depends on options.truncateOnByteLimit:
 *   false (default): throws FileTooLargeError if the FILE size (fast path)
 *     or total streamed bytes (streaming) exceed maxBytes.
 *   true: caps SELECTED OUTPUT at maxBytes. Stops at the last complete line
 *     that fits; sets truncatedByBytes in the result. Never throws.
 */

import { isUtf8 } from 'node:buffer';
import { createReadStream, fstat } from 'node:fs';
import { stat as fsStat, readFile } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import { stripBOM } from './stripBom.js';
import { readFileStage } from './readFileExecution.js';
import {
  NUL_SCAN_BYTES,
  detectEncodingFromBytes,
  detectNotText,
  type NotTextReason,
} from './fileWriteUtils.js';

const FAST_PATH_MAX_SIZE = 10 * 1024 * 1024; // 10 MB

export interface ReadFileRangeResult {
  content: string;
  lineCount: number;
  totalLines: number;
  totalBytes: number;
  readBytes: number;
  mtimeMs: number;
  /** True when output was clipped to maxBytes under truncate mode. */
  truncatedByBytes?: boolean;
  /** Set when the raw bytes cannot be round-tripped by the write tools. */
  notText?: NotTextReason;
}

/**
 * Formats a byte count to a human-readable string.
 */
function formatSize(sizeInBytes: number): string {
  const kb = sizeInBytes / 1024;
  if (kb < 1) return `${sizeInBytes} bytes`;
  if (kb < 1024) return `${kb.toFixed(1).replace(/\.0$/, '')}KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1).replace(/\.0$/, '')}MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(1).replace(/\.0$/, '')}GB`;
}

export class FileTooLargeError extends Error {
  constructor(
    public sizeInBytes: number,
    public maxSizeBytes: number,
  ) {
    super(
      `File content (${formatSize(sizeInBytes)}) exceeds maximum allowed size (${formatSize(maxSizeBytes)}). Use offset and limit parameters to read specific portions of the file, or search for specific content instead of reading the whole file.`,
    );
    this.name = 'FileTooLargeError';
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function readFileInRange(
  filePath: string,
  offset = 0,
  maxLines?: number,
  maxBytes?: number,
  signal?: AbortSignal,
  options?: { truncateOnByteLimit?: boolean },
): Promise<ReadFileRangeResult> {
  signal?.throwIfAborted();
  const truncateOnByteLimit = options?.truncateOnByteLimit ?? false;

  const stats = await readFileStage('stat', () => fsStat(filePath));
  signal?.throwIfAborted();

  if (stats.isDirectory()) {
    throw new Error(
      `EISDIR: illegal operation on a directory, read '${filePath}'`,
    );
  }

  if (stats.isFile() && stats.size < FAST_PATH_MAX_SIZE) {
    if (
      !truncateOnByteLimit &&
      maxBytes !== undefined &&
      stats.size > maxBytes
    ) {
      throw new FileTooLargeError(stats.size, maxBytes);
    }

    const bytes = await readFileStage('read_file', () =>
      readFile(filePath, { signal }),
    );
    signal?.throwIfAborted();
    const notText = detectNotText(bytes);
    const result = readFileInRangeFast(
      bytes.toString(detectEncodingFromBytes(bytes)),
      stats.mtimeMs,
      offset,
      maxLines,
      truncateOnByteLimit ? maxBytes : undefined,
    );
    return notText ? { ...result, notText } : result;
  }

  return readFileStage('read_file', () =>
    readFileInRangeStreaming(
      filePath,
      offset,
      maxLines,
      maxBytes,
      truncateOnByteLimit,
      signal,
    ),
  );
}

// ---------------------------------------------------------------------------
// Fast path -- readFile + in-memory split
// ---------------------------------------------------------------------------

function readFileInRangeFast(
  raw: string,
  mtimeMs: number,
  offset: number,
  maxLines: number | undefined,
  truncateAtBytes: number | undefined,
): ReadFileRangeResult {
  const endLine = maxLines !== undefined ? offset + maxLines : Infinity;

  const text = stripBOM(raw);

  // Split lines, strip \r, select range.
  const selectedLines: string[] = [];
  let lineIndex = 0;
  let startPos = 0;
  let newlinePos: number;
  let selectedBytes = 0;
  let truncatedByBytes = false;

  function tryPush(line: string): boolean {
    if (truncateAtBytes !== undefined) {
      const sep = selectedLines.length > 0 ? 1 : 0;
      const nextBytes = selectedBytes + sep + Buffer.byteLength(line);
      if (nextBytes > truncateAtBytes) {
        truncatedByBytes = true;
        return false;
      }
      selectedBytes = nextBytes;
    }
    selectedLines.push(line);
    return true;
  }

  while ((newlinePos = text.indexOf('\n', startPos)) !== -1) {
    if (lineIndex >= offset && lineIndex < endLine && !truncatedByBytes) {
      let line = text.slice(startPos, newlinePos);
      if (line.endsWith('\r')) {
        line = line.slice(0, -1);
      }
      tryPush(line);
    }
    lineIndex++;
    startPos = newlinePos + 1;
  }

  // Final fragment (no trailing newline).
  if (lineIndex >= offset && lineIndex < endLine && !truncatedByBytes) {
    let line = text.slice(startPos);
    if (line.endsWith('\r')) {
      line = line.slice(0, -1);
    }
    tryPush(line);
  }
  lineIndex++;

  const content = selectedLines.join('\n');
  return {
    content,
    lineCount: selectedLines.length,
    totalLines: lineIndex,
    totalBytes: Buffer.byteLength(text, 'utf8'),
    readBytes: Buffer.byteLength(content, 'utf8'),
    mtimeMs,
    ...(truncatedByBytes ? { truncatedByBytes: true } : {}),
  };
}

// ---------------------------------------------------------------------------
// Streaming path -- createReadStream + event handlers
// ---------------------------------------------------------------------------

/** Bytes at the end of `bytes` that start a UTF-8 sequence still missing bytes. */
function incompleteUtf8TailLength(bytes: Buffer): number {
  for (let i = 1; i <= Math.min(3, bytes.length); i++) {
    const byte = bytes[bytes.length - i];
    if ((byte & 0xc0) === 0x80) continue;
    const needed = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    return needed > i ? i : 0;
  }
  return 0;
}

/** Classifies a stream chunk by chunk without holding more than its head. */
class NotTextScanner {
  private readonly head: Buffer[] = [];
  private headLength = 0;
  private tail = Buffer.alloc(0);
  private invalidUtf8 = false;

  push(chunk: Buffer): void {
    if (this.headLength < NUL_SCAN_BYTES) {
      const part = chunk.subarray(0, NUL_SCAN_BYTES - this.headLength);
      this.head.push(part);
      this.headLength += part.length;
    }
    if (this.invalidUtf8) return;
    const data =
      this.tail.length > 0 ? Buffer.concat([this.tail, chunk]) : chunk;
    const complete = data.length - incompleteUtf8TailLength(data);
    if (!isUtf8(data.subarray(0, complete))) {
      this.invalidUtf8 = true;
      return;
    }
    this.tail = Buffer.from(data.subarray(complete));
  }

  finish(): NotTextReason | undefined {
    return detectNotText(
      Buffer.concat(this.head),
      () => !this.invalidUtf8 && this.tail.length === 0,
    );
  }
}

type StreamState = {
  stream: ReturnType<typeof createReadStream>;
  decoder?: StringDecoder;
  encodingPrefix: Buffer;
  pendingHighSurrogate: string;
  scanner: NotTextScanner;
  offset: number;
  endLine: number;
  maxBytes: number | undefined;
  truncateOnByteLimit: boolean;
  resolve: (value: ReadFileRangeResult) => void;
  totalBytesRead: number;
  selectedBytes: number;
  truncatedByBytes: boolean;
  currentLineIndex: number;
  selectedLines: string[];
  partial: string;
  isFirstChunk: boolean;
  resolveMtime: (ms: number) => void;
  mtimeReady: Promise<number>;
};

function streamOnOpen(this: StreamState, fd: number): void {
  fstat(fd, (err, stats) => {
    this.resolveMtime(err ? 0 : stats.mtimeMs);
  });
}

function streamOnData(this: StreamState, chunk: string): void {
  if (this.isFirstChunk) {
    this.isFirstChunk = false;
    chunk = stripBOM(chunk);
  }

  this.totalBytesRead += Buffer.byteLength(chunk);
  if (
    !this.truncateOnByteLimit &&
    this.maxBytes !== undefined &&
    this.totalBytesRead > this.maxBytes
  ) {
    this.stream.destroy(
      new FileTooLargeError(this.totalBytesRead, this.maxBytes),
    );
    return;
  }

  const data = this.partial.length > 0 ? this.partial + chunk : chunk;
  this.partial = '';

  let startPos = 0;
  let newlinePos: number;
  while ((newlinePos = data.indexOf('\n', startPos)) !== -1) {
    if (
      this.currentLineIndex >= this.offset &&
      this.currentLineIndex < this.endLine
    ) {
      let line = data.slice(startPos, newlinePos);
      if (line.endsWith('\r')) {
        line = line.slice(0, -1);
      }
      if (this.truncateOnByteLimit && this.maxBytes !== undefined) {
        const sep = this.selectedLines.length > 0 ? 1 : 0;
        const nextBytes = this.selectedBytes + sep + Buffer.byteLength(line);
        if (nextBytes > this.maxBytes) {
          this.truncatedByBytes = true;
          this.endLine = this.currentLineIndex;
        } else {
          this.selectedBytes = nextBytes;
          this.selectedLines.push(line);
        }
      } else {
        this.selectedLines.push(line);
      }
    }
    this.currentLineIndex++;
    startPos = newlinePos + 1;
  }

  if (startPos < data.length) {
    if (
      this.currentLineIndex >= this.offset &&
      this.currentLineIndex < this.endLine
    ) {
      const fragment = data.slice(startPos);
      if (this.truncateOnByteLimit && this.maxBytes !== undefined) {
        const sep = this.selectedLines.length > 0 ? 1 : 0;
        const fragBytes =
          this.selectedBytes + sep + Buffer.byteLength(fragment);
        if (fragBytes > this.maxBytes) {
          this.truncatedByBytes = true;
          this.endLine = this.currentLineIndex;
          return;
        }
      }
      this.partial = fragment;
    }
  }
}

function streamOnEnd(this: StreamState): void {
  let line = this.partial;
  if (line.endsWith('\r')) {
    line = line.slice(0, -1);
  }
  if (
    this.currentLineIndex >= this.offset &&
    this.currentLineIndex < this.endLine
  ) {
    if (this.truncateOnByteLimit && this.maxBytes !== undefined) {
      const sep = this.selectedLines.length > 0 ? 1 : 0;
      const nextBytes = this.selectedBytes + sep + Buffer.byteLength(line);
      if (nextBytes > this.maxBytes) {
        this.truncatedByBytes = true;
      } else {
        this.selectedLines.push(line);
      }
    } else {
      this.selectedLines.push(line);
    }
  }
  this.currentLineIndex++;

  const content = this.selectedLines.join('\n');
  const truncated = this.truncatedByBytes;
  const notText = this.scanner.finish();
  void this.mtimeReady.then((mtimeMs) => {
    this.resolve({
      content,
      lineCount: this.selectedLines.length,
      totalLines: this.currentLineIndex,
      totalBytes: this.totalBytesRead,
      readBytes: Buffer.byteLength(content, 'utf8'),
      mtimeMs,
      ...(truncated ? { truncatedByBytes: true } : {}),
      ...(notText ? { notText } : {}),
    });
  });
}

function readFileInRangeStreaming(
  filePath: string,
  offset: number,
  maxLines: number | undefined,
  maxBytes: number | undefined,
  truncateOnByteLimit: boolean,
  signal?: AbortSignal,
): Promise<ReadFileRangeResult> {
  return new Promise((resolve, reject) => {
    // Create the mtime promise up-front so we never have to stash a fake
    // Promise placeholder (which would trip no-unsafe-type-assertion).
    let resolveMtime: (value: number) => void = () => {};
    const mtimeReady = new Promise<number>((r) => {
      resolveMtime = r;
    });

    const state: StreamState = {
      stream: createReadStream(filePath, {
        highWaterMark: 512 * 1024,
        ...(signal ? { signal } : undefined),
      }),
      encodingPrefix: Buffer.alloc(0),
      pendingHighSurrogate: '',
      scanner: new NotTextScanner(),
      offset,
      endLine: maxLines !== undefined ? offset + maxLines : Infinity,
      maxBytes,
      truncateOnByteLimit,
      resolve,
      totalBytesRead: 0,
      selectedBytes: 0,
      truncatedByBytes: false,
      currentLineIndex: 0,
      selectedLines: [],
      partial: '',
      isFirstChunk: true,
      resolveMtime,
      mtimeReady,
    };

    state.stream.once('open', streamOnOpen.bind(state));
    state.stream.on('data', (chunk: string | Buffer) => {
      let bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      state.scanner.push(bytes);
      if (!state.decoder) {
        bytes = state.encodingPrefix.length > 0
          ? Buffer.concat([state.encodingPrefix, bytes])
          : bytes;
        if (bytes.length < 2) {
          state.encodingPrefix = bytes;
          return;
        }
        state.decoder = new StringDecoder(detectEncodingFromBytes(bytes));
        state.encodingPrefix = Buffer.alloc(0);
      }
      let text = state.pendingHighSurrogate + state.decoder.write(bytes);
      state.pendingHighSurrogate = '';
      // UTF-16LE decoders can split surrogate pairs at odd-byte chunk boundaries.
      const lastCodeUnit = text.charCodeAt(text.length - 1);
      if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) {
        state.pendingHighSurrogate = text.slice(-1);
        text = text.slice(0, -1);
      }
      if (text) streamOnData.call(state, text);
    });
    state.stream.once('end', () => {
      const rest = state.pendingHighSurrogate +
        (state.decoder ?? new StringDecoder('utf8')).end(state.encodingPrefix);
      if (rest) streamOnData.call(state, rest);
      if (state.stream.destroyed) return;
      streamOnEnd.call(state);
    });
    state.stream.once('error', reject);
  });
}
