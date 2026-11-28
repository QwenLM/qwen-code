/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { readCurrentGitBranch } from './worktreeService.js';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFile: vi.fn() };
});

describe('Git branch metadata timeout', () => {
  it('terminates a real stuck child and resolves without partial metadata', async () => {
    const actual =
      await vi.importActual<typeof import('node:child_process')>(
        'node:child_process',
      );
    let child: ReturnType<typeof execFile> | undefined;
    // Exercise the production timeout/kill options with a portable child,
    // without replacing Git on PATH or relying on a shell script.
    vi.mocked(execFile).mockImplementationOnce(
      (_command, _args, options, callback) => {
        child = actual.execFile(
          process.execPath,
          [
            '-e',
            `
        process.on('SIGTERM', () => {});
        process.stdout.write('partial-branch');
        setInterval(() => {}, 1000);
      `,
          ],
          options,
          callback,
        );
        return child;
      },
    );
    const startedAt = performance.now();
    try {
      await expect(
        readCurrentGitBranch(process.cwd()),
      ).resolves.toBeUndefined();
      expect(performance.now() - startedAt).toBeGreaterThanOrEqual(4800);
      expect(performance.now() - startedAt).toBeLessThan(8000);
      expect(child?.killed).toBe(true);
      expect(child?.exitCode !== null || child?.signalCode !== null).toBe(true);
    } finally {
      child?.kill('SIGKILL');
    }
  }, 10000);
});
