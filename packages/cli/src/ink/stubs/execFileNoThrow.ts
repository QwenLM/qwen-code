/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * Part of the vendored fork of @jrichman/ink v6.6.7, ported to TypeScript
 * with modifications by the Qwen Team. Original work Copyright (c) Vadym
 * Demedes <vadimdemedes@hey.com> (github.com/vadimdemedes), licensed MIT.
 * See packages/cli/src/ink/LICENSE for the full MIT text.
 */

import { execFile as nodeExecFile } from 'child_process';

type ExecFileOptions = {
  abortSignal?: AbortSignal;
  timeout?: number;
  preserveOutputOnError?: boolean;
  useCwd?: boolean;
  env?: NodeJS.ProcessEnv;
  stdin?: 'ignore' | 'inherit' | 'pipe';
  input?: string;
};

type ExecResult = {
  stdout: string;
  stderr: string;
  code: number;
  error?: string;
};

export function execFileNoThrow(
  file: string,
  args: string[],
  options?: ExecFileOptions,
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = nodeExecFile(
      file,
      args,
      {
        timeout: options?.timeout ?? 10000,
        env: options?.env ?? process.env,
        maxBuffer: 10 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        resolve({
          stdout: stdout ?? '',
          stderr: stderr ?? '',
          code: error ? ((error as NodeJS.ErrnoException).code ? 1 : 1) : 0,
          error: error ? String(error) : undefined,
        });
      },
    );

    if (options?.input && child.stdin) {
      child.stdin.write(options.input);
      child.stdin.end();
    }

    if (options?.abortSignal) {
      options.abortSignal.addEventListener('abort', () => {
        child.kill();
      });
    }
  });
}
