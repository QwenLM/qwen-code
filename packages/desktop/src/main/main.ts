/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { app, BrowserWindow, dialog, session } from 'electron';
import { shouldQuitWhenWindowsClosed } from './lifecycle/AppLifecycle.js';
import { registerIpc } from './ipc/registerIpc.js';
import { createMainWindow } from './windows/MainWindow.js';
import { resolveDesktopAcpLaunchConfig } from './acp/resolveCli.js';
import { AcpProcessClient } from '../server/acp/AcpProcessClient.js';
import { startDesktopServer } from '../server/index.js';
import type { DesktopServer } from '../server/types.js';

let desktopServer: DesktopServer | undefined;
let acpClient: AcpProcessClient | undefined;
let mainWindow: BrowserWindow | null = null;

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) {
      return;
    }

    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.focus();
  });

  app
    .whenReady()
    .then(bootstrap)
    .catch((error: unknown) => {
      dialog.showErrorBox(
        'Qwen Code failed to start',
        error instanceof Error ? error.message : String(error),
      );
      app.exit(1);
    });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createOrFocusMainWindow();
    }
  });

  app.on('window-all-closed', () => {
    if (shouldQuitWhenWindowsClosed()) {
      app.quit();
    }
  });

  app.on('before-quit', () => {
    acpClient?.disconnect();
    void desktopServer?.close();
  });
}

async function bootstrap(): Promise<void> {
  app.setName('Qwen Code');
  registerContentSecurityPolicy();

  const acpLaunchConfig = resolveDesktopAcpLaunchConfig({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    mainModuleUrl: import.meta.url,
    env: process.env,
    execPath: process.execPath,
  });
  process.env['QWEN_DESKTOP_CLI_PATH'] ??= acpLaunchConfig.cliEntryPath;
  acpClient = new AcpProcessClient(acpLaunchConfig);
  desktopServer = await startDesktopServer({ acpClient });
  registerIpc({
    getServerInfo: () => {
      if (!desktopServer) {
        throw new Error('Desktop server is not running.');
      }

      return desktopServer.info;
    },
    getMainWindow: () => mainWindow,
  });

  await createOrFocusMainWindow();
}

async function createOrFocusMainWindow(): Promise<void> {
  if (mainWindow) {
    mainWindow.focus();
    return;
  }

  mainWindow = await createMainWindow();
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function registerContentSecurityPolicy(): void {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [createContentSecurityPolicy()],
      },
    });
  });
}

function createContentSecurityPolicy(): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:*",
    "object-src 'none'",
    "base-uri 'self'",
  ].join('; ');
}
