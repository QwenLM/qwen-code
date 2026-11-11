/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const NOTIFY_SCRIPT = String.raw`
  import { dlopen } from 'bun:ffi';
  const user32 = dlopen('user32.dll', {
    SendMessageTimeoutW: {
      args: ['u64', 'u32', 'u64', 'ptr', 'u32', 'u32', 'ptr'],
      returns: 'i64',
    },
  });

  try {
    const sent = user32.symbols.SendMessageTimeoutW(
      0xffffn, // HWND_BROADCAST
      0x001a, // WM_SETTINGCHANGE
      0n,
      Buffer.from('Environment\0', 'utf16le'),
      0x0002, // SMTO_ABORTIFHUNG
      100,
      new BigUint64Array(1),
    );
    process.exitCode = sent ? 0 : 1;
  } finally {
    user32.close();
  }
`;

/** Run the fixed script in the bundled Bun runtime without entering the CLI. */
export function notifyWindowsPathChange(): void {
  const cwd = mkdtempSync(join(tmpdir(), 'qwen-path-notify-'));
  try {
    // Prevent project bunfig, preloads and .env files from running in the child.
    const config = join(cwd, 'bunfig.toml');
    writeFileSync(config, '', { flag: 'wx' });
    execFileSync(
      process.execPath,
      [`--config=${config}`, '--no-env-file', '--no-install', '--eval', NOTIFY_SCRIPT],
      {
        cwd,
        env: { BUN_BE_BUN: '1', SystemRoot: process.env['SystemRoot'] },
        // Win32's timeout is per window. Bound the whole broadcast here.
        timeout: 2_000,
        stdio: 'ignore',
        windowsHide: true,
      },
    );
  } finally {
    try {
      rmSync(cwd, { recursive: true, force: true });
    } catch {
      // Cleanup is best-effort, including after a child timeout.
    }
  }
}
