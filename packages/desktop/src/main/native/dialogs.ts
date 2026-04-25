/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { dialog, type BrowserWindow, type OpenDialogOptions } from 'electron';

export async function selectDirectory(
  owner: BrowserWindow | null,
): Promise<string | null> {
  const e2eDirectory = process.env['QWEN_DESKTOP_TEST_SELECT_DIRECTORY'];
  if (process.env['QWEN_DESKTOP_E2E'] === '1' && e2eDirectory) {
    return e2eDirectory;
  }

  const options: OpenDialogOptions = {
    properties: ['openDirectory', 'createDirectory'],
  };
  const result = owner
    ? await dialog.showOpenDialog(owner, options)
    : await dialog.showOpenDialog(options);

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  return result.filePaths[0] ?? null;
}
