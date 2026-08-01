/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { app, BrowserWindow } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerIpc } from './ipc.js';
import { readAppConfig, writeAppConfig } from './appConfig.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function createWindow(): BrowserWindow {
  const config = readAppConfig();
  const bounds = config.windowBounds;

  const win = new BrowserWindow({
    width: bounds?.width ?? 960,
    height: bounds?.height ?? 720,
    x: bounds?.x,
    y: bounds?.y,
    webPreferences: {
      preload: join(__dirname, '../preload/preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  void win.loadFile(join(__dirname, '../renderer/index.html'));

  registerIpc(win);

  const persistBounds = (): void => {
    if (win.isDestroyed()) return;
    writeAppConfig({ ...readAppConfig(), windowBounds: win.getBounds() });
  };
  win.on('resize', persistBounds);
  win.on('move', persistBounds);

  return win;
}

void app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
