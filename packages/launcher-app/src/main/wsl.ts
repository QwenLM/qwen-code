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

/** Run a shell command inside the WSL distro (login shell → qwen-rc on PATH). */
export type RunWsl = (command: string) => Promise<CommandResult>;

/**
 * Real impl. Runs `wsl.exe [-d <distro>] -- bash -lc "<command>"`. `command`
 * is passed as a single argv element (execFile does not use a shell), so its
 * spaces/quotes are safe. Never rejects — a failure resolves with a nonzero code.
 */
export function realRunWsl(distro?: string): RunWsl {
  const distroArgs = distro ? ['-d', distro] : [];
  return (command) =>
    new Promise((resolve) => {
      execFile(
        'wsl.exe',
        [...distroArgs, '--', 'bash', '-lc', command],
        { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
        (err, stdout, stderr) => {
          const code =
            err && typeof (err as { code?: unknown }).code === 'number'
              ? (err as { code: number }).code
              : err
                ? 1
                : 0;
          resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '' });
        },
      );
    });
}

/** Parse decoded `wsl.exe -l -q` output into a list of distro names. */
export function parseDistroList(raw: string): string[] {
  return raw
    .split('\n')
    .map((l) =>
      l
        .replace(/\r/g, '')
        .replace(/\s*\(Default\)\s*$/i, '')
        .trim(),
    )
    .filter((l) => l.length > 0);
}

/**
 * Enumerate installed WSL distros. `wsl.exe -l -q` emits UTF-16LE, so read the
 * raw buffer and decode before parsing. (Operator-verified on Windows.)
 */
export function listDistros(): Promise<string[]> {
  return new Promise((resolve) => {
    execFile(
      'wsl.exe',
      ['-l', '-q'],
      { encoding: 'buffer', maxBuffer: 1024 * 1024 },
      (_err, stdout) => {
        const buf = (stdout as unknown as Buffer) ?? Buffer.alloc(0);
        // UTF-16LE from wsl.exe; fall back to utf8 if it looks like utf8.
        const text = buf.includes(0)
          ? buf.toString('utf16le')
          : buf.toString('utf8');
        resolve(parseDistroList(text));
      },
    );
  });
}
