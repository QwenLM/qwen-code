/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { runQwenReviewCommand } from '../run-qwen-pr-review.js';

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'qwen-pr-review-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('streams command stdout into the log file', async () => {
  await withTempDir(async (dir) => {
    const child = join(dir, 'child.js');
    const logPath = join(dir, 'review.jsonl');
    await writeFile(child, "process.stdout.write('line one\\nline two\\n');");

    const result = await runQwenReviewCommand({
      command: process.execPath,
      args: [child],
      logPath,
      timeoutMs: 5_000,
      stdout: { write() {} },
      stderr: { write() {} },
    });

    expect(result).toEqual({ status: 0, timedOut: false });
    await expect(readFile(logPath, 'utf8')).resolves.toBe(
      'line one\nline two\n',
    );
  });
});

test('returns 124 when the command times out', async () => {
  await withTempDir(async (dir) => {
    const child = join(dir, 'child.js');
    const logPath = join(dir, 'review.jsonl');
    await writeFile(
      child,
      "process.stdout.write('started\\n'); setTimeout(() => {}, 5000);",
    );

    const result = await runQwenReviewCommand({
      command: process.execPath,
      args: [child],
      logPath,
      timeoutMs: 2_000,
      killAfterMs: 50,
      stdout: { write() {} },
      stderr: { write() {} },
    });

    expect(result).toEqual({ status: 124, timedOut: true });
  });
});
