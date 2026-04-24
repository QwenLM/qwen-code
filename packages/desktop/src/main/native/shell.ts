/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { shell } from 'electron';

export async function openPath(path: string): Promise<void> {
  const errorMessage = await shell.openPath(path);
  if (errorMessage) {
    throw new Error(errorMessage);
  }
}

export function showItemInFolder(path: string): void {
  shell.showItemInFolder(path);
}

export async function openExternalUrl(url: string): Promise<void> {
  if (!isAllowedExternalUrl(url)) {
    throw new Error('External URL scheme is not allowed.');
  }

  await shell.openExternal(url);
}

function isAllowedExternalUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}
