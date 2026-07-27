/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export class NativeDirectoryPickerUnavailableError extends Error {}

export async function pickNativeDirectory(): Promise<string | undefined> {
  try {
    if (process.platform === 'darwin') {
      const script = [
        'const app = Application.currentApplication();',
        'app.includeStandardAdditions = true;',
        'app.chooseFolder({',
        'withPrompt: "Select a workspace folder",',
        '}).toString();',
      ].join(' ');
      const { stdout } = await execFileAsync('osascript', [
        '-l',
        'JavaScript',
        '-e',
        script,
      ]);
      return stdout.trim() || undefined;
    }

    if (process.platform === 'win32') {
      const script = [
        'Add-Type -AssemblyName System.Windows.Forms;',
        '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog;',
        'if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {',
        '[Console]::Out.Write($dialog.SelectedPath)',
        '}',
      ].join(' ');
      const { stdout } = await execFileAsync('powershell.exe', [
        '-NoProfile',
        '-STA',
        '-Command',
        script,
      ]);
      return stdout.trim() || undefined;
    }

    if (process.platform === 'linux') {
      const { stdout } = await execFileAsync('zenity', [
        '--file-selection',
        '--directory',
        '--title=Select a workspace folder',
      ]);
      return stdout.trim() || undefined;
    }
  } catch (error) {
    const result = error as { code?: number | string; stderr?: string };
    if (
      (process.platform === 'darwin' &&
        (result.stderr?.includes('(-128)') ||
          result.stderr?.includes('User canceled'))) ||
      (process.platform === 'linux' && result.code === 1)
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
