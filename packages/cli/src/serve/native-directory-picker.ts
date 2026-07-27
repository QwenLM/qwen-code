/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Matches the SDK client's 5-minute ceiling so a dismissed dialog cannot leave
// an orphaned native picker (and its visible GUI) running after the request
// that spawned it is gone.
const PICKER_TIMEOUT_MS = 300_000;

export class NativeDirectoryPickerUnavailableError extends Error {}

export async function pickNativeDirectory(
  signal?: AbortSignal,
): Promise<string | undefined> {
  try {
    if (process.platform === 'darwin') {
      const script = [
        'const app = Application.currentApplication();',
        'app.includeStandardAdditions = true;',
        'app.chooseFolder({',
        'withPrompt: "Select a workspace folder",',
        '}).toString();',
      ].join(' ');
      const { stdout } = await execFileAsync(
        'osascript',
        ['-l', 'JavaScript', '-e', script],
        { timeout: PICKER_TIMEOUT_MS, signal },
      );
      return stdout.trim() || undefined;
    }

    if (process.platform === 'win32') {
      const script = [
        '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;',
        'Add-Type -AssemblyName System.Windows.Forms;',
        '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog;',
        'if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {',
        '[Console]::Out.Write($dialog.SelectedPath)',
        '}',
      ].join(' ');
      const { stdout } = await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-STA', '-Command', script],
        { timeout: PICKER_TIMEOUT_MS, signal },
      );
      return stdout.trim() || undefined;
    }

    if (process.platform === 'linux') {
      const { stdout } = await execFileAsync(
        'zenity',
        [
          '--file-selection',
          '--directory',
          '--title=Select a workspace folder',
        ],
        { timeout: PICKER_TIMEOUT_MS, signal },
      );
      return stdout.trim() || undefined;
    }
  } catch (error) {
    const result = error as {
      code?: number | string;
      stderr?: string;
      killed?: boolean;
    };
    // A timeout kill (PICKER_TIMEOUT_MS) or an abort-signal kill means the
    // dialog is gone; treat it as a cancel rather than an OS-level failure.
    if (result.killed) {
      return undefined;
    }
    if (
      (process.platform === 'darwin' &&
        (result.stderr?.includes('(-128)') ||
          result.stderr?.includes('User canceled'))) ||
      // Zenity exits 1 both for a deliberate cancel and for "cannot open
      // display" on headless Linux; only the former is a silent cancel.
      (process.platform === 'linux' &&
        result.code === 1 &&
        !result.stderr?.includes('cannot open display'))
    ) {
      return undefined;
    }
    throw new NativeDirectoryPickerUnavailableError(
      error instanceof Error ? error.message : String(error),
    );
  }

  throw new NativeDirectoryPickerUnavailableError(
    `Native directory picker is not supported on ${process.platform}`,
  );
}
