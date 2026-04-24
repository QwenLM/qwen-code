/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcMain, type BrowserWindow } from 'electron';
import type { DesktopServerInfo } from '../../shared/desktopApi.js';
import { IPC_CHANNELS } from '../../shared/ipcChannels.js';
import { selectDirectory } from '../native/dialogs.js';
import { openPath, showItemInFolder } from '../native/shell.js';

interface RegisterIpcOptions {
  getServerInfo(): DesktopServerInfo;
  getMainWindow(): BrowserWindow | null;
}

export function registerIpc(options: RegisterIpcOptions): void {
  ipcMain.handle(IPC_CHANNELS.getServerInfo, () => options.getServerInfo());
  ipcMain.handle(IPC_CHANNELS.selectDirectory, () =>
    selectDirectory(options.getMainWindow()),
  );
  ipcMain.handle(IPC_CHANNELS.openPath, async (_event, path: unknown) => {
    await openPath(requireString(path, 'path'));
  });
  ipcMain.handle(IPC_CHANNELS.showItemInFolder, (_event, path: unknown) => {
    showItemInFolder(requireString(path, 'path'));
  });
  ipcMain.handle(IPC_CHANNELS.windowMinimize, () => {
    options.getMainWindow()?.minimize();
  });
  ipcMain.handle(IPC_CHANNELS.windowMaximize, () => {
    const window = options.getMainWindow();
    if (!window) {
      return;
    }

    if (window.isMaximized()) {
      window.unmaximize();
    } else {
      window.maximize();
    }
  });
  ipcMain.handle(IPC_CHANNELS.windowClose, () => {
    options.getMainWindow()?.close();
  });
  ipcMain.handle(
    IPC_CHANNELS.windowIsMaximized,
    () => options.getMainWindow()?.isMaximized() ?? false,
  );
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }

  return value;
}
