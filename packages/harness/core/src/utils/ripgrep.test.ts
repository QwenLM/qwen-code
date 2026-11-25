/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  execFile,
  type ChildProcess,
  type ExecFileException,
} from 'node:child_process';
import { ripGrep } from './ripgrep.js';
import { decodeSearchPaths } from './searchOutput.js';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFile: vi.fn(actual.execFile) };
});

describe('ripgrep partial output', () => {
  afterEach(() => vi.mocked(execFile).mockRestore());

  it.each([
    {
      output: 'first.ts\0odd\nname.ts\0partial',
      paths: ['first.ts', 'odd\nname.ts'],
    },
    { output: 'first.ts\0', paths: ['first.ts'] },
  ])(
    'preserves complete NUL-delimited paths after a timeout: $output',
    async ({ output, paths }) => {
      vi.mocked(execFile).mockImplementation(((
        _file: string,
        _args: readonly string[],
        _options: unknown,
        callback: (
          error: ExecFileException | null,
          stdout: string,
          stderr: string,
        ) => void,
      ) => {
        queueMicrotask(() =>
          callback(
            Object.assign(new Error('timeout'), {
              signal: 'SIGTERM',
            }) as ExecFileException,
            output,
            '',
          ),
        );
        return { pid: 0 } as ChildProcess;
      }) as typeof execFile);
      const onPartialResults = vi.fn();
      const result = await ripGrep(
        ['--files', '--null'],
        '.',
        new AbortController().signal,
        {
          outputDelimiter: '\0',
          onPartialResults,
        },
      );
      expect(decodeSearchPaths(result)).toEqual(paths);
      expect(onPartialResults).toHaveBeenCalledOnce();
    },
  );
});
