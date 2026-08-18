/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  nativeTheme,
  screen,
  shell,
} from 'electron';
import { BrowserPanelController } from './browser-panel';
import { DesktopRuntime } from './runtime';
import { BROWSER_PANEL_CSS } from '../shared/browser-panel';
import {
  captureWindowState,
  initialWindowBounds,
  readDesktopState,
  saveDesktopState,
  type DesktopState,
  type WindowState,
} from './state';

let mainWindow: BrowserWindow | undefined;
let runtime: DesktopRuntime | undefined;
let desktopState: DesktopState = {};
let statePath = '';
let hostLogPath = '';
let stateTimer: NodeJS.Timeout | undefined;
let quitting = false;
const browserPanel = new BrowserPanelController(() => mainWindow);

const MACOS_TITLE_BAR_CSS = `
  [data-web-shell-root] [data-sidebar-shell] > aside {
    padding-top: 40px !important;
  }

  [data-web-shell-root] [data-sidebar-shell] > aside::before {
    app-region: drag;
    content: '';
    height: 28px;
    left: 0;
    position: absolute;
    right: 0;
    top: 0;
    user-select: none;
    z-index: 1;
  }

  [data-web-shell-root] [data-testid='chat-context-header'] {
    app-region: drag;
    user-select: none;
  }

  [data-web-shell-root]
    [data-testid='chat-context-header']
    :where(button, a, input, select, textarea, [role='button']) {
    app-region: no-drag;
  }

  [data-web-shell-root]
    [data-testid='context-body']:has([data-web-shell-new-session-dot-field])::before {
    app-region: drag;
    content: '';
    height: 28px;
    left: 0;
    position: absolute;
    right: 0;
    top: 0;
    user-select: none;
    z-index: 1;
  }

  /* Electron 38+ only hit-tests native title tooltips reliably at the edges
     of elements on macOS. Keep the Chromium workaround inside this host and
     scoped to buttons that already opt in with a title attribute.
     https://github.com/electron/electron/issues/49843 */
  :where([data-web-shell-root] button[title]) {
    position: relative;
  }

  :where([data-web-shell-root] button[title])::after {
    content: '';
    inset: 0;
    position: absolute;
  }
`;

const testStateRoot = process.env['QWEN_DESKTOP_STATE_ROOT'];
if (testStateRoot) {
  app.setPath('userData', path.join(testStateRoot, 'user-data'));
  app.setAppLogsPath(path.join(testStateRoot, 'logs'));
}

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) app.quit();

app.on('second-instance', () => {
  if (runtime) void showMainWindow(desktopState.window).catch(failStartup);
});

app.on('before-quit', () => {
  quitting = true;
  try {
    flushDesktopState();
  } finally {
    browserPanel.close();
    runtime?.stop();
    runtime = undefined;
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (!quitting && runtime) {
    void showMainWindow(desktopState.window).catch(failStartup);
  }
});

if (singleInstance) {
  void app.whenReady().then(startApplication).catch(failStartup);
}

async function startApplication(): Promise<void> {
  process.env['ELECTRON_IS_PACKAGED'] = app.isPackaged ? '1' : '0';
  statePath = path.join(app.getPath('userData'), 'desktop-state.json');
  hostLogPath = path.join(app.getPath('logs'), 'desktop-host.log');
  desktopState = readDesktopState(statePath);
  browserPanel.registerIpc();

  const workspace = await resolveWorkspace();
  if (!workspace) {
    app.quit();
    return;
  }
  desktopState.workspace = workspace;
  saveDesktopState(statePath, desktopState);

  runtime = await DesktopRuntime.start({
    logPath: path.join(app.getPath('logs'), 'desktop-runtime.log'),
    packageDir: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    workspace,
    onUnexpectedExit: (status) => {
      if (quitting) return;
      dialog.showErrorBox(
        'Qwen Code stopped',
        `The local runtime exited: ${status}`,
      );
      app.quit();
    },
  });

  installApplicationMenu();
  await showMainWindow(desktopState.window);
}

async function showMainWindow(
  savedBounds?: WindowState,
): Promise<BrowserWindow> {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    return mainWindow;
  }
  if (!runtime) throw new Error('Desktop runtime is unavailable.');

  const window = createMainWindow(savedBounds);
  mainWindow = window;
  try {
    await window.loadURL(runtime.authenticatedWebUrl());
    await window.webContents.insertCSS(BROWSER_PANEL_CSS);
    if (process.platform === 'darwin') {
      await window.webContents.insertCSS(MACOS_TITLE_BAR_CSS);
      window.show();
    }
  } catch (error) {
    if (mainWindow === window) mainWindow = undefined;
    if (!window.isDestroyed()) window.destroy();
    throw error;
  }
  return window;
}

function createMainWindow(savedBounds?: WindowState): BrowserWindow {
  const displays = screen.getAllDisplays().map((display) => display.workArea);
  const bounds = initialWindowBounds(savedBounds, displays);
  const { maximized, ...browserWindowBounds } = bounds;
  const window = new BrowserWindow({
    ...browserWindowBounds,
    backgroundColor: '#0d0d0d',
    minHeight: 600,
    minWidth: 900,
    show: false,
    title: 'Qwen Code',
    titleBarStyle: process.platform === 'darwin' ? 'hidden' : 'default',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  if (maximized) window.maximize();

  if (process.platform !== 'darwin') {
    window.once('ready-to-show', () => window.show());
  }
  window.webContents.on('page-title-updated', (event) => {
    event.preventDefault();
    window.setTitle('Qwen Code');
  });
  window.webContents.on('did-change-theme-color', (_event, color) => {
    applyWebShellNativeTheme(window, color);
  });
  window.webContents.once('did-finish-load', () => {
    appendHostLog(`web shell ready at ${runtime?.baseUrl ?? 'unknown'}`);
  });
  window.webContents.on(
    'did-start-navigation',
    (_event, url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace && isRuntimeUrl(url)) browserPanel.close();
    },
  );
  window.webContents.on('render-process-gone', () => browserPanel.close());
  window.on('move', scheduleDesktopStateSave);
  window.on('resize', scheduleDesktopStateSave);
  window.on('maximize', scheduleDesktopStateSave);
  window.on('unmaximize', scheduleDesktopStateSave);
  window.on('close', flushDesktopState);
  window.on('closed', () => {
    browserPanel.close();
    if (mainWindow === window) mainWindow = undefined;
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (isRuntimeUrl(url)) return;
    event.preventDefault();
    if (isSafeExternalUrl(url)) void shell.openExternal(url);
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (!isRuntimeUrl(url) && isSafeExternalUrl(url)) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });
  return window;
}

function applyWebShellNativeTheme(
  window: BrowserWindow,
  color: string | null,
): void {
  const normalized = color?.toLowerCase();
  if (normalized !== '#0d0d0d' && normalized !== '#ffffff') return;
  nativeTheme.themeSource = normalized === '#0d0d0d' ? 'dark' : 'light';
  window.setBackgroundColor(normalized);
}

async function resolveWorkspace(): Promise<string | undefined> {
  const configured = process.env['QWEN_DESKTOP_WORKSPACE'];
  for (const candidate of [configured, desktopState.workspace]) {
    if (!candidate) continue;
    try {
      const resolved = fs.realpathSync(candidate);
      if (fs.statSync(resolved).isDirectory()) return resolved;
    } catch {
      // Fall through to the native picker.
    }
  }
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory', 'createDirectory'],
    title: 'Choose a Qwen Code workspace',
  });
  if (result.canceled || !result.filePaths[0]) return undefined;
  return fs.realpathSync(result.filePaths[0]);
}

function installApplicationMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin'
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' as const },
              { type: 'separator' as const },
              { role: 'services' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const },
            ],
          },
        ]
      : []),
    {
      label: 'File',
      submenu: [
        process.platform === 'darwin' ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function scheduleDesktopStateSave(): void {
  if (stateTimer) clearTimeout(stateTimer);
  stateTimer = setTimeout(flushDesktopState, 250);
}

function flushDesktopState(): void {
  if (stateTimer) clearTimeout(stateTimer);
  stateTimer = undefined;
  if (mainWindow && !mainWindow.isDestroyed()) {
    desktopState.window = captureWindowState(mainWindow);
  }
  if (statePath) saveDesktopState(statePath, desktopState);
}

function isRuntimeUrl(raw: string): boolean {
  if (!runtime) return false;
  try {
    return new URL(raw).origin === runtime.baseUrl;
  } catch {
    return false;
  }
}

function isSafeExternalUrl(raw: string): boolean {
  try {
    const protocol = new URL(raw).protocol;
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

function failStartup(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  dialog.showErrorBox('Qwen Code could not start', message);
  app.quit();
}

function appendHostLog(message: string): void {
  if (!hostLogPath) return;
  fs.mkdirSync(path.dirname(hostLogPath), { recursive: true });
  fs.appendFileSync(hostLogPath, `[${new Date().toISOString()}] ${message}\n`);
}
