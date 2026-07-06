/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { detectFileEncoding, readFileWithEncodingInfo } from './fileUtils.js';
import { isUtf8CompatibleEncoding } from './iconvHelper.js';
import {
  DEFAULT_RANGE_READ_BYTES,
  TEXT_RANGE_FAST_PATH_MAX_SIZE,
} from './text-range-constants.js';

export interface ReadTextRangeRequest {
  path: string;
  offset: number;
  limit: number;
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
  constructor(readonly encoding: string) {
    super(
      `Large non-UTF-8 text files are not supported for streaming reads (detected ${encoding}). Convert or extract a smaller UTF-8 slice and read that instead.`,
    );
    this.name = 'LargeNonUtf8TextError';
  }
}

export async function readTextRange(
  request: ReadTextRangeRequest,
): Promise<ReadTextRangeResult> {
  request.signal?.throwIfAborted();
  const stats = await stat(request.path);
  const maxOutputBytes = normalizeMaxBytes(request.maxOutputBytes);

  if (stats.size < TEXT_RANGE_FAST_PATH_MAX_SIZE) {
    const { content, encoding, bom } = await readFileWithEncodingInfo(
      request.path,
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

  return readLargeUtf8Range(request, maxOutputBytes);
}

function normalizeMaxBytes(maxOutputBytes: number): number {
  if (!Number.isFinite(maxOutputBytes)) {
    return DEFAULT_RANGE_READ_BYTES;
  }
  return Math.max(0, Math.floor(maxOutputBytes));
}

function sliceDecodedContent(
  content: string,
  offset: number,
  limit: number,
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
  const start = Math.min(Math.max(0, offset), originalLineCount);
  const end = Math.min(start + Math.max(0, limit), originalLineCount);
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
): Promise<ReadTextRangeResult> {
  const encoding = await detectFileEncoding(request.path);
  if (!isUtf8CompatibleEncoding(encoding)) {
    throw new LargeNonUtf8TextError(encoding);
  }

  const offset = Math.max(0, request.offset);
  const endLine = offset + Math.max(0, request.limit);
  let currentLine = 0;
  let output = '';
  let outputBytes = 0;
  let truncatedByBytes = false;
  let bom = false;
  let firstChunk = true;
  let lineEnding: 'crlf' | 'lf' = 'lf';
  let previousChunkEndedWithCR = false;
  let originalLineCountExact = true;

  const stream = createReadStream(request.path, {
    encoding: 'utf8',
    highWaterMark: 512 * 1024,
    signal: request.signal,
  });

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

  for await (const rawChunk of stream) {
    request.signal?.throwIfAborted();
    let chunk = rawChunk;
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
        break;
      }
      newline = chunk.indexOf('\n', start);
    }

    if (start < chunk.length && isSelectedLine()) {
      appendSelected(chunk.slice(start));
    }
    if (currentLine >= endLine || truncatedByBytes) {
      originalLineCountExact = false;
      break;
    }
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
