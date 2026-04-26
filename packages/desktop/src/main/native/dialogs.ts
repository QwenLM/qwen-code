/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { dialog, type BrowserWindow, type OpenDialogOptions } from 'electron';
import { getE2eSelectedDirectory } from './e2eSelectDirectory.js';

export async function selectDirectory(
  owner: BrowserWindow | null,
): Promise<string | null> {
  const e2eDirectory = getE2eSelectedDirectory();
  if (e2eDirectory) {
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
