/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';

const SAMPLE_BYTES = 4096;
const ERROR_REASONS = [
  'command not found',
  'No such file or directory',
  'Permission denied',
  'not a valid identifier',
  'readonly variable',
  'syntax error',
  'unexpected EOF',
  'unexpected end of file',
  'Argument list too long',
  'cannot execute',
  'bad interpreter',
  'here-document',
] as const;

/**
 * Bash may echo an entire command or environment assignment in an error.
 * Retain only recognized error categories and source line numbers, never its
 * operands. This also avoids exposing secrets split across stream chunks.
 */
function describeErrors(text: string): string[] {
  const errors = new Set<string>();
  for (const line of text.split('\n')) {
    const reason = ERROR_REASONS.find((candidate) => line.includes(candidate));
    if (!reason) continue;
    const lineNumber = /(?:line |:)(\d+):/.exec(line)?.[1] ?? 'unknown';
    const context = /\beval:/.test(line) ? 'eval' : 'shell';
    errors.add(`${context}:line=${lineNumber}:${reason}`);
    if (errors.size === 16) break;
  }
  return [...errors];
}

/** Bounded head/tail samples; the raw samples never leave this object. */
export class ShellErrorDiagnostics {
  private head = Buffer.alloc(0);
  private tail = Buffer.alloc(0);
  private bytes = 0;

  append(chunk: Buffer | string): void {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.bytes += buffer.length;
    if (this.head.length < SAMPLE_BYTES) {
      this.head = Buffer.concat([
        this.head,
        buffer.subarray(0, SAMPLE_BYTES - this.head.length),
      ]);
    }
    this.tail = Buffer.concat([
      this.tail,
      buffer.subarray(-SAMPLE_BYTES),
    ]).subarray(-SAMPLE_BYTES);
  }

  summary(): string {
    const errors = describeErrors(
      this.head.toString('utf8') + '\n' + this.tail.toString('utf8'),
    );
    return (
      `stderr_bytes=${this.bytes}, stderr_truncated=${this.bytes > SAMPLE_BYTES * 2}, ` +
      `stderr_errors=${JSON.stringify(errors)}`
    );
  }
}

/**
 * Capture at process exit, before result consumers can delete the output.
 * Only regular files are sampled, with at most 8 KiB of synchronous reads.
 * File-mode output combines stdout/stderr.
 */
export function summarizeShellOutputFile(filePath: string): string {
  const file = openSync(
    filePath,
    constants.O_RDONLY |
      (constants.O_NOFOLLOW || 0) |
      (constants.O_NONBLOCK || 0),
  );
  try {
    const stat = fstatSync(file);
    if (!stat.isFile()) throw new Error('Shell output is not a regular file');
    const { size } = stat;
    const head = Buffer.alloc(Math.min(size, SAMPLE_BYTES));
    const tail = Buffer.alloc(
      Math.min(Math.max(0, size - SAMPLE_BYTES), SAMPLE_BYTES),
    );
    const first = readSync(file, head, 0, head.length, 0);
    const last = readSync(file, tail, 0, tail.length, size - tail.length);
    const errors = describeErrors(
      head.subarray(0, first).toString('utf8') +
        '\n' +
        tail.subarray(0, last).toString('utf8'),
    );
    return (
      `output_bytes=${size}, output_truncated=${size > SAMPLE_BYTES * 2}, ` +
      `output_errors=${JSON.stringify(errors)}`
    );
  } finally {
    closeSync(file);
  }
}
