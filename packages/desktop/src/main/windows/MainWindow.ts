/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { BrowserWindow } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openExternalUrl } from '../native/shell.js';

const mainDir = dirname(fileURLToPath(import.meta.url));
const preloadPath = join(mainDir, '../../preload/index.cjs');
const rendererIndexPath = join(mainDir, '../../renderer/index.html');

export async function createMainWindow(): Promise<BrowserWindow> {
  const mainWindow = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    title: 'Qwen Code',
    backgroundColor: '#101214',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: preloadPath,
      sandbox: false,
      webSecurity: true,
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void openExternalUrl(url);
    return { action: 'deny' };
  });

  const rendererUrl = process.env['QWEN_DESKTOP_RENDERER_URL'];
  if (rendererUrl) {
    await mainWindow.loadURL(rendererUrl);
  } else {
    await mainWindow.loadFile(rendererIndexPath);
  }

  return mainWindow;
}
