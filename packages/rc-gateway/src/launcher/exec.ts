/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { execFile } from 'node:child_process';

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Injected exec boundary — every launcher flow calls the outside world through this. */
export type RunCommand = (argv: string[]) => Promise<CommandResult>;

/** Real impl over child_process.execFile. Never rejects — a failed/absent command resolves with a nonzero code. */
export const realRunCommand: RunCommand = (argv) =>
  new Promise((resolve) => {
    execFile(
      argv[0],
      argv.slice(1),
      { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code =
          err && typeof (err as { code?: unknown }).code === 'number'
            ? (err as { code: number }).code
            : err
              ? (err as { code?: unknown }).code === 'ENOENT'
                ? 127
                : 1
              : 0;
        resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '' });
      },
    );
  });
