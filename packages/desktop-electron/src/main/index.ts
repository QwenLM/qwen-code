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
  protocol,
  screen,
  session,
  type IpcMainInvokeEvent,
} from 'electron';
import type {
  ChatLaunchConfig,
  DesktopLaunchConfig,
  DesktopLiveStatus,
} from '../shared/types';
import { writeChatNavigation } from '../shared/chat-navigation';
import { rendererResponse } from './app-protocol';
import { EmbeddedBrowser } from './browser-window';
import { DESKTOP_ORIGIN, DesktopRuntime } from './runtime';
import {
  captureChatWindowState,
  initialWindowBounds,
  readDesktopState,
  saveDesktopState,
  type DesktopState,
  type ChatWindowState,
} from './state';

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'qwen-desktop',
    privileges: {
      corsEnabled: true,
      secure: true,
      standard: true,
      supportFetchAPI: true,
    },
  },
]);

const chatWindows = new Map<number, BrowserWindow>();
let embeddedBrowser: EmbeddedBrowser | undefined;
let voiceOverlay: BrowserWindow | undefined;
let runtime: DesktopRuntime | undefined;
let launchConfig: Omit<ChatLaunchConfig, 'kind' | 'windowId'> | undefined;
let desktopState: DesktopState = {};
let statePath = '';
let hostLogPath = '';
let packageDir = '';
let stateTimer: NodeJS.Timeout | undefined;
let quitting = false;
const testStateRoot = process.env['QWEN_DESKTOP_STATE_ROOT'];
if (testStateRoot) {
  app.setPath('userData', path.join(testStateRoot, 'user-data'));
  app.setAppLogsPath(path.join(testStateRoot, 'logs'));
}

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) app.quit();

app.on('second-instance', () => {
  const window = BrowserWindow.getFocusedWindow() ?? firstApplicationWindow();
  if (!window) {
    if (launchConfig) void openChatWindow().catch(failStartup);
    return;
  }
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
});

app.on('before-quit', () => {
  quitting = true;
  try {
    flushDesktopState();
  } finally {
    runtime?.stop();
    runtime = undefined;
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (quitting) return;
  const window = firstApplicationWindow();
  if (window) {
    window.show();
    return;
  }
  if (launchConfig) void openChatWindow().catch(failStartup);
});

if (singleInstance) {
  void app.whenReady().then(startApplication).catch(failStartup);
}

async function startApplication(): Promise<void> {
  process.env['ELECTRON_IS_PACKAGED'] = app.isPackaged ? '1' : '0';
  statePath = path.join(app.getPath('userData'), 'desktop-state.json');
  hostLogPath = path.join(app.getPath('logs'), 'desktop-host.log');
  desktopState = readDesktopState(statePath);
  const workspace = await resolveWorkspace();
  if (!workspace) {
    app.quit();
    return;
  }
  desktopState.workspace = workspace;
  saveDesktopState(statePath, desktopState);

  packageDir = app.getAppPath();
  runtime = await DesktopRuntime.start({
    logPath: path.join(app.getPath('logs'), 'desktop-runtime.log'),
    packageDir,
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
  launchConfig = {
    daemonBaseUrl: runtime.baseUrl,
    daemonToken: runtime.token,
    desktopVersion: app.getVersion(),
    workspace,
  };

  registerRendererProtocol(packageDir);
  embeddedBrowser = new EmbeddedBrowser({
    packageDir,
    onChanged: scheduleDesktopStateSave,
    onClosed: () => {
      if (quitting) return;
      desktopState.browser = undefined;
      flushDesktopState();
    },
  });
  registerIpc();
  configurePermissions();
  installApplicationMenu();
  const savedChatWindows = desktopState.chatWindows?.length
    ? desktopState.chatWindows
    : [desktopState.window].filter((value) => value !== undefined);
  await openChatWindow(savedChatWindows[0]);
  for (const saved of savedChatWindows.slice(1)) {
    await openChatWindow(saved);
  }
  if (desktopState.browser) {
    await embeddedBrowser.open(
      desktopState.browser.url,
      desktopState.browser.window,
    );
  }
}

async function openChatWindow(
  savedBounds?: ChatWindowState,
): Promise<BrowserWindow> {
  if (!launchConfig) throw new Error('Desktop runtime is unavailable.');
  const window = createChatWindow(savedBounds);
  chatWindows.set(window.id, window);
  try {
    await window.loadURL(chatWindowUrl(savedBounds));
  } catch (error) {
    chatWindows.delete(window.id);
    if (!window.isDestroyed()) window.destroy();
    throw error;
  }
  return window;
}

function failStartup(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  dialog.showErrorBox('Qwen Code could not start', message);
  app.quit();
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

function registerRendererProtocol(packageDir: string): void {
  const rendererRoot = path.join(packageDir, 'dist', 'renderer');
  protocol.handle('qwen-desktop', (request) =>
    rendererResponse(rendererRoot, request.url),
  );
}

function registerIpc(): void {
  for (const channel of [
    'desktop:get-launch-config',
    'desktop:new-chat-window',
    'desktop:open-browser',
    'desktop:get-browser-state',
    'desktop:navigate-browser',
    'desktop:browser-back',
    'desktop:browser-forward',
    'desktop:browser-reload',
    'desktop:show-voice-overlay',
    'desktop:close-voice-overlay',
    'desktop:get-live-status',
    'desktop:start-live',
    'desktop:stop-live',
    'desktop:set-live-mute',
  ]) {
    ipcMain.removeHandler(channel);
  }
  ipcMain.handle('desktop:get-launch-config', (event) => {
    assertTrustedRenderer(event);
    const chatWindow = chatWindowForSender(event);
    if (chatWindow && launchConfig) {
      return {
        kind: 'chat',
        ...launchConfig,
        windowId: chatWindow.id,
      } satisfies DesktopLaunchConfig;
    }
    if (embeddedBrowser?.ownsChrome(event.sender)) {
      return {
        kind: 'browser',
        desktopVersion: app.getVersion(),
        windowId: embeddedBrowser.getWindow()!.id,
      } satisfies DesktopLaunchConfig;
    }
    if (voiceOverlay?.webContents === event.sender && launchConfig) {
      return {
        kind: 'voice-overlay',
        desktopVersion: app.getVersion(),
        windowId: voiceOverlay.id,
      } satisfies DesktopLaunchConfig;
    }
    throw new Error('Desktop launch configuration is unavailable.');
  });
  ipcMain.handle('desktop:new-chat-window', async (event) => {
    assertTrustedRenderer(event);
    await openChatWindow(undefined);
  });
  ipcMain.handle(
    'desktop:open-browser',
    async (event, url: unknown): Promise<void> => {
      assertTrustedRenderer(event);
      if (url !== undefined && typeof url !== 'string') {
        throw new Error('Browser URL must be a string.');
      }
      await openEmbeddedBrowser(url);
    },
  );
  ipcMain.handle('desktop:get-browser-state', (event) => {
    assertBrowserChrome(event);
    return embeddedBrowser!.getState();
  });
  ipcMain.handle('desktop:navigate-browser', async (event, url: unknown) => {
    assertBrowserChrome(event);
    if (typeof url !== 'string') throw new Error('Browser URL is required.');
    return embeddedBrowser!.navigate(url);
  });
  ipcMain.handle('desktop:browser-back', (event) => {
    assertBrowserChrome(event);
    embeddedBrowser!.goBack();
  });
  ipcMain.handle('desktop:browser-forward', (event) => {
    assertBrowserChrome(event);
    embeddedBrowser!.goForward();
  });
  ipcMain.handle('desktop:browser-reload', (event) => {
    assertBrowserChrome(event);
    embeddedBrowser!.reload();
  });
  ipcMain.handle('desktop:show-voice-overlay', async (event) => {
    assertTrustedRenderer(event);
    await showVoiceOverlay();
  });
  ipcMain.handle('desktop:close-voice-overlay', (event) => {
    assertTrustedRenderer(event);
    if (event.sender !== voiceOverlay?.webContents) {
      throw new Error('Only the voice overlay can close itself.');
    }
    voiceOverlay.close();
  });
  ipcMain.handle('desktop:get-live-status', async (event) => {
    assertTrustedRenderer(event);
    return runtimeRequest<DesktopLiveStatus>('/live/status');
  });
  ipcMain.handle('desktop:start-live', async (event, mode: unknown) => {
    assertTrustedRenderer(event);
    if (mode !== 'resume' && mode !== 'new') {
      throw new Error('Live mode must be resume or new.');
    }
    return runtimeRequest<DesktopLiveStatus>(
      mode === 'new' ? '/live/new' : '/live/start',
      'POST',
    );
  });
  ipcMain.handle('desktop:stop-live', async (event) => {
    assertTrustedRenderer(event);
    return runtimeRequest<DesktopLiveStatus>('/live/stop', 'POST');
  });
  ipcMain.handle('desktop:set-live-mute', async (event, update: unknown) => {
    assertTrustedRenderer(event);
    if (!isLiveMuteUpdate(update))
      throw new Error('Live mute update is invalid.');
    return runtimeRequest<DesktopLiveStatus>('/live/mute', 'POST', update);
  });
}

async function runtimeRequest<T>(
  requestPath: string,
  method: 'GET' | 'POST' = 'GET',
  body?: unknown,
): Promise<T> {
  if (!launchConfig) throw new Error('Desktop runtime is unavailable.');
  const response = await fetch(`${launchConfig.daemonBaseUrl}${requestPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${launchConfig.daemonToken}`,
      ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => undefined)) as
      | { error?: unknown }
      | undefined;
    throw new Error(
      typeof body?.error === 'string'
        ? body.error
        : `Desktop runtime request failed (${response.status}).`,
    );
  }
  return (await response.json()) as T;
}

function isLiveMuteUpdate(
  value: unknown,
): value is { inputMuted?: boolean; outputMuted?: boolean } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const update = value as Record<string, unknown>;
  const inputMuted = update['inputMuted'];
  const outputMuted = update['outputMuted'];
  return (
    (inputMuted !== undefined || outputMuted !== undefined) &&
    (inputMuted === undefined || typeof inputMuted === 'boolean') &&
    (outputMuted === undefined || typeof outputMuted === 'boolean')
  );
}

function configurePermissions(): void {
  session.defaultSession.setPermissionCheckHandler(
    (webContents, permission, requestingOrigin, details) =>
      isChatWebContents(webContents) &&
      permission === 'media' &&
      isTrustedRendererUrl(requestingOrigin) &&
      details.mediaType !== 'video',
  );
  session.defaultSession.setPermissionRequestHandler(
    (webContents, permission, callback, details) => {
      const mediaTypes =
        'mediaTypes' in details ? details.mediaTypes : undefined;
      callback(
        isChatWebContents(webContents) &&
          permission === 'media' &&
          isTrustedRendererUrl(details.requestingUrl) &&
          mediaTypes?.length === 1 &&
          mediaTypes[0] === 'audio',
      );
    },
  );
}

function createChatWindow(savedBounds?: ChatWindowState): BrowserWindow {
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
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(packageDir, 'dist', 'preload', 'index.cjs'),
      sandbox: true,
      webSecurity: true,
    },
  });
  if (maximized) window.maximize();
  window.once('ready-to-show', () => window.show());
  window.webContents.once('did-finish-load', () => {
    appendHostLog(`renderer ready at ${window.webContents.getURL()}`);
  });
  window.on('move', scheduleDesktopStateSave);
  window.on('resize', scheduleDesktopStateSave);
  window.on('maximize', scheduleDesktopStateSave);
  window.on('unmaximize', scheduleDesktopStateSave);
  window.on('closed', () => {
    chatWindows.delete(window.id);
    if (!quitting) flushDesktopState();
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (isTrustedRendererUrl(url)) return;
    event.preventDefault();
    if (isSafeExternalUrl(url)) void openEmbeddedBrowser(url);
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void openEmbeddedBrowser(url);
    return { action: 'deny' };
  });
  return window;
}

async function openEmbeddedBrowser(url?: string): Promise<void> {
  if (!embeddedBrowser) throw new Error('The embedded browser is unavailable.');
  await embeddedBrowser.open(url);
}

async function showVoiceOverlay(): Promise<void> {
  if (voiceOverlay && !voiceOverlay.isDestroyed()) {
    voiceOverlay.show();
    voiceOverlay.focus();
    return;
  }
  const workArea = screen.getDisplayNearestPoint(
    screen.getCursorScreenPoint(),
  ).workArea;
  const width = 380;
  const height = 260;
  const window = new BrowserWindow({
    width,
    height,
    x: workArea.x + workArea.width - width - 20,
    y: workArea.y + workArea.height - height - 20,
    alwaysOnTop: true,
    backgroundColor: '#15161a',
    frame: false,
    fullscreenable: false,
    maximizable: false,
    minimizable: false,
    resizable: false,
    show: false,
    skipTaskbar: true,
    title: 'Qwen Voice',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(packageDir, 'dist', 'preload', 'index.cjs'),
      sandbox: true,
      webSecurity: true,
    },
  });
  voiceOverlay = window;
  if (process.platform === 'darwin') {
    window.setAlwaysOnTop(true, 'floating');
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }
  window.webContents.on('will-navigate', (event, url) => {
    if (isTrustedRendererUrl(url)) return;
    event.preventDefault();
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.once('ready-to-show', () => window.show());
  window.on('closed', () => {
    if (voiceOverlay === window) voiceOverlay = undefined;
  });
  try {
    await window.loadURL(`${DESKTOP_ORIGIN}/index.html?surface=voice-overlay`);
  } catch (error) {
    if (voiceOverlay === window) voiceOverlay = undefined;
    if (!window.isDestroyed()) window.destroy();
    throw error;
  }
}

function assertTrustedRenderer(event: IpcMainInvokeEvent): void {
  const frameUrl = event.senderFrame?.url;
  const knownRenderer = Boolean(
    chatWindowForSender(event) ||
      embeddedBrowser?.ownsChrome(event.sender) ||
      event.sender === voiceOverlay?.webContents,
  );
  if (!frameUrl || !isTrustedRendererUrl(frameUrl) || !knownRenderer) {
    throw new Error('Desktop IPC is unavailable to this renderer.');
  }
}

function assertBrowserChrome(event: IpcMainInvokeEvent): void {
  assertTrustedRenderer(event);
  if (!embeddedBrowser?.ownsChrome(event.sender)) {
    throw new Error('Browser controls are unavailable to this renderer.');
  }
}

function chatWindowForSender(
  event: Pick<IpcMainInvokeEvent, 'sender'>,
): BrowserWindow | undefined {
  return [...chatWindows.values()].find(
    (window) => window.webContents === event.sender,
  );
}

function isChatWebContents(webContents: Electron.WebContents | null): boolean {
  return (
    webContents !== null &&
    [...chatWindows.values()].some(
      (window) => window.webContents === webContents,
    )
  );
}

function firstApplicationWindow(): BrowserWindow | undefined {
  return (
    [...chatWindows.values()].find((window) => !window.isDestroyed()) ??
    embeddedBrowser?.getWindow() ??
    voiceOverlay
  );
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
        {
          label: 'New Qwen Window',
          accelerator: 'CmdOrCtrl+N',
          click: () =>
            void openChatWindow(undefined).catch((error) =>
              reportActionError('Could not open a new Qwen window', error),
            ),
        },
        {
          label: 'Open Browser',
          accelerator: 'CmdOrCtrl+Shift+B',
          click: () =>
            void openEmbeddedBrowser().catch((error) =>
              reportActionError('Could not open the browser', error),
            ),
        },
        {
          label: 'Voice Overlay',
          accelerator: 'CmdOrCtrl+Shift+V',
          click: () =>
            void showVoiceOverlay().catch((error) =>
              reportActionError('Could not open Qwen Voice', error),
            ),
        },
        { type: 'separator' },
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
  desktopState.chatWindows = [...chatWindows.values()]
    .filter((window) => !window.isDestroyed())
    .map(captureChatWindowState);
  desktopState.window = undefined;
  desktopState.browser = embeddedBrowser?.getSavedState();
  if (statePath) saveDesktopState(statePath, desktopState);
}

function isTrustedRendererUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return (
      url.protocol === 'qwen-desktop:' &&
      url.hostname === 'app' &&
      !url.port &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

function chatWindowUrl(saved?: ChatWindowState): string {
  return writeChatNavigation(`${DESKTOP_ORIGIN}/index.html`, {
    sessionId: saved?.sessionId,
    workspaceId: saved?.workspaceId,
  });
}

function reportActionError(title: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  dialog.showErrorBox(title, message);
}

function isSafeExternalUrl(raw: string): boolean {
  try {
    const protocol = new URL(raw).protocol;
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

function appendHostLog(message: string): void {
  if (!hostLogPath) return;
  fs.mkdirSync(path.dirname(hostLogPath), { recursive: true });
  fs.appendFileSync(hostLogPath, `[${new Date().toISOString()}] ${message}\n`);
}
