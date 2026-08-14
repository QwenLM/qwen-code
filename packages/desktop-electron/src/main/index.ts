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
  ipcMain,
  Menu,
  nativeTheme,
  screen,
  shell,
} from 'electron';
import { DesktopRuntime } from './runtime';
import {
  PetWindowController,
  petRendererPath,
  preloadPath,
} from './pet-window';
import {
  captureWindowState,
  defaultPetSettings,
  initialWindowBounds,
  normalizePetSize,
  normalizePetSettings,
  readDesktopState,
  saveDesktopState,
  type DesktopState,
  type WindowState,
} from './state';
import {
  DESKTOP_CHANNELS,
  type HostSettingsCategory,
  type PetSettings,
  type SessionChangeReport,
} from '../shared/desktop-api';

let mainWindow: BrowserWindow | undefined;
let runtime: DesktopRuntime | undefined;
let petController: PetWindowController | undefined;
let desktopState: DesktopState = {};
let statePath = '';
let hostLogPath = '';
let stateTimer: NodeJS.Timeout | undefined;
let quitting = false;

const MACOS_TITLE_BAR_CSS = `
  [data-web-shell-root] {
    padding-top: calc(env(safe-area-inset-top) + 28px) !important;
  }

  [data-web-shell-root]::before {
    app-region: drag;
    align-items: center;
    background: var(--sidebar-background, #0d0d0d);
    color: color-mix(
      in srgb,
      var(--sidebar-foreground, #fafafa) 58%,
      transparent
    );
    content: 'Qwen Code' / '';
    display: flex;
    font-family: -apple-system, BlinkMacSystemFont, sans-serif;
    font-size: 11px;
    font-weight: 600;
    height: 28px;
    left: 0;
    padding-left: 74px;
    position: absolute;
    right: 0;
    top: 0;
    user-select: none;
    z-index: 1;
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
    petController?.destroy();
    petController = undefined;
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
  desktopState.pet =
    normalizePetSettings(desktopState.pet) ?? defaultPetSettings();
  petController = new PetWindowController(desktopState.pet, {
    preloadPath: preloadPath(__dirname),
    rendererPath: petRendererPath(__dirname),
    onPositionChange: (position) => {
      desktopState.pet = { ...currentPetSettings(), position };
      scheduleDesktopStateSave();
    },
  });
  registerDesktopIpc();

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
  petController.applySettings(currentPetSettings());
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
      preload: preloadPath(__dirname),
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
  window.on('move', scheduleDesktopStateSave);
  window.on('resize', scheduleDesktopStateSave);
  window.on('maximize', scheduleDesktopStateSave);
  window.on('unmaximize', scheduleDesktopStateSave);
  window.on('close', flushDesktopState);
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = undefined;
    if (process.platform !== 'darwin' && !quitting) app.quit();
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

function currentPetSettings(): PetSettings {
  return desktopState.pet ?? defaultPetSettings();
}

function updatePetSettings(update: Partial<PetSettings>): void {
  desktopState.pet = { ...currentPetSettings(), ...update };
  petController?.applySettings(desktopState.pet);
  flushDesktopState();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(DESKTOP_CHANNELS.hostSettingsChanged);
  }
}

function hostSettings(language: string): HostSettingsCategory[] {
  const chinese = language.toLowerCase().startsWith('zh');
  const pet = currentPetSettings();
  return [
    {
      id: 'desktop',
      label: chinese ? '桌面端' : 'Desktop',
      scopeLabel: chinese ? '应用' : 'Application',
      items: [
        {
          key: 'pet.enabled',
          label: chinese ? '桌面小宠物' : 'Desktop pet',
          description: chinese
            ? '在其他窗口上方显示 Qwen 水豚，并跟随任务状态变化。'
            : 'Show the Qwen capybara above other windows and reflect task activity.',
          kind: 'boolean',
          value: pet.enabled,
        },
        {
          key: 'pet.size',
          label: chinese ? '小宠物尺寸' : 'Pet size',
          description: chinese
            ? '宠物高度，支持 64 到 240 像素。'
            : 'Pet height from 64 to 240 pixels.',
          kind: 'number',
          value: pet.size,
          disabled: !pet.enabled,
        },
      ],
    },
  ];
}

function registerDesktopIpc(): void {
  ipcMain.handle(
    DESKTOP_CHANNELS.loadHostSettings,
    (event, language: unknown) => {
      requireMainSender(event.sender.id);
      return hostSettings(typeof language === 'string' ? language : 'en');
    },
  );
  ipcMain.handle(
    DESKTOP_CHANNELS.setHostSetting,
    (event, key: unknown, value: unknown) => {
      requireMainSender(event.sender.id);
      if (key === 'pet.enabled' && typeof value === 'boolean') {
        updatePetSettings({ enabled: value });
        return;
      }
      if (key === 'pet.size' && typeof value === 'number') {
        updatePetSettings({ size: normalizePetSize(value) });
        return;
      }
      throw new Error('Unsupported desktop setting.');
    },
  );
  ipcMain.handle(DESKTOP_CHANNELS.petBootstrap, (event) => {
    requirePetSender(event.sender.id);
    return currentPetSettings();
  });
  ipcMain.on(DESKTOP_CHANNELS.streamingState, (event, state: unknown) => {
    if (!isMainSender(event.sender.id) || typeof state !== 'string') return;
    petController?.reportStreamingState(state);
  });
  ipcMain.on(
    DESKTOP_CHANNELS.sessionChange,
    (event, report: SessionChangeReport) => {
      if (!isMainSender(event.sender.id)) return;
      if (
        !report ||
        (report.type !== 'submit' && report.type !== 'turn_complete')
      ) {
        return;
      }
      petController?.reportSessionChange(report);
    },
  );
  ipcMain.on(DESKTOP_CHANNELS.petIgnoreMouse, (event, ignore: unknown) => {
    if (!petController?.owns(event.sender.id) || typeof ignore !== 'boolean') {
      return;
    }
    petController.setIgnoreMouseEvents(ignore);
  });
  ipcMain.on(
    DESKTOP_CHANNELS.petDragStart,
    (event, screenX: unknown, screenY: unknown) => {
      if (
        !petController?.owns(event.sender.id) ||
        !Number.isFinite(screenX) ||
        !Number.isFinite(screenY)
      ) {
        return;
      }
      petController.beginDrag(screenX as number, screenY as number);
    },
  );
  ipcMain.on(
    DESKTOP_CHANNELS.petDragMove,
    (event, screenX: unknown, screenY: unknown) => {
      if (
        !petController?.owns(event.sender.id) ||
        !Number.isFinite(screenX) ||
        !Number.isFinite(screenY)
      ) {
        return;
      }
      petController.moveDrag(screenX as number, screenY as number);
    },
  );
  ipcMain.on(DESKTOP_CHANNELS.petDragEnd, (event) => {
    if (petController?.owns(event.sender.id)) petController.endDrag();
  });
  ipcMain.on(DESKTOP_CHANNELS.petClose, (event) => {
    if (petController?.owns(event.sender.id)) {
      updatePetSettings({ enabled: false });
    }
  });
}

function isMainSender(webContentsId: number): boolean {
  return (
    mainWindow !== undefined &&
    !mainWindow.isDestroyed() &&
    mainWindow.webContents.id === webContentsId
  );
}

function requireMainSender(webContentsId: number): void {
  if (!isMainSender(webContentsId))
    throw new Error('Untrusted desktop sender.');
}

function requirePetSender(webContentsId: number): void {
  if (!petController?.owns(webContentsId)) {
    throw new Error('Untrusted pet sender.');
  }
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
