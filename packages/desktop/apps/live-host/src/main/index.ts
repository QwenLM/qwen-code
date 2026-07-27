import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeImage,
  screen,
  session as electronSession,
  shell,
  systemPreferences,
  Tray,
} from 'electron';
import { CommandMonitor } from './command-monitor.ts';
import { CuaReadinessMonitor } from './cua-readiness.ts';
import {
  LiveDaemonConnection,
  type ConnectionSnapshot,
} from './daemon-connection.ts';
import {
  isValidInputAudioFrame,
  type HostPermissions,
  type HostSelfChecks,
  type LiveStatus,
  type OpenSessionTarget,
  type PermissionState,
  type SessionLocator,
} from '../shared/protocol.ts';
import type { HostPublicState } from '../shared/host-api.ts';
import {
  authorizeDaemonRequest,
  buildWebShellSessionUrl,
  denyWebShellPermissions,
  isSafeExternalUrl,
  isSameDaemonOrigin,
} from './web-shell-security.ts';
import { overlayPosition } from './overlay-position.ts';
import {
  canToggleLive,
  isActiveLiveCall,
  shouldCaptureLiveAudio,
} from './live-state-policy.ts';

if (process.platform !== 'darwin') {
  app.exit(1);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.setName('Qwen Live Host');

let overlay: BrowserWindow | undefined;
let tray: Tray | undefined;
const webShellWindows = new Set<BrowserWindow>();
let daemon: LiveDaemonConnection;
let commandMonitor: CommandMonitor;
let cuaMonitor: CuaReadinessMonitor;
let quitting = false;
let readinessReconnectTimer: NodeJS.Timeout | undefined;
let microphonePermissionTimer: NodeJS.Timeout | undefined;
let overlayHideTimer: NodeJS.Timeout | undefined;
let pointerInteractive = false;

const permissions: HostPermissions = {
  microphone: 'not_determined',
  inputMonitoring: 'not_determined',
  accessibility: 'not_determined',
  screenRecording: 'not_determined',
};
const selfChecks: HostSelfChecks = {
  audioInput: false,
  audioOutput: false,
  globalShortcut: false,
  appshot: false,
};
let connection: ConnectionSnapshot = { phase: 'disconnected' };
let live: LiveStatus = {
  v: 1,
  available: false,
  state: 'unavailable',
  blocker: 'host_disconnected',
};

function hostReadinessBlocker(): string | undefined {
  if (permissions.microphone !== 'granted') return 'microphone_permission';
  if (permissions.inputMonitoring !== 'granted')
    return 'input_monitoring_permission';
  if (permissions.accessibility !== 'granted')
    return 'accessibility_permission';
  if (permissions.screenRecording !== 'granted')
    return 'screen_recording_permission';
  if (!selfChecks.audioInput) return 'audio_input';
  if (!selfChecks.audioOutput) return 'audio_output';
  if (!selfChecks.globalShortcut) return 'global_shortcut';
  if (!selfChecks.appshot) return 'appshot';
  return undefined;
}

function isHostReady(): boolean {
  return hostReadinessBlocker() === undefined;
}

function effectiveLiveStatus(): LiveStatus {
  const blocker = hostReadinessBlocker();
  if (!live.available || !blocker) return live;
  return { ...live, available: false, state: 'unavailable', blocker };
}

function microphonePermission(): PermissionState {
  const status = systemPreferences.getMediaAccessStatus('microphone');
  if (status === 'granted') return 'granted';
  if (status === 'denied' || status === 'restricted') return 'denied';
  return 'not_determined';
}

function publicState(): HostPublicState {
  return {
    connection: connection.phase,
    ...(connection.error ? { connectionError: connection.error } : {}),
    live: effectiveLiveStatus(),
    permissions: { ...permissions },
    selfChecks: { ...selfChecks },
  };
}

function publishState(): void {
  if (overlay && !overlay.isDestroyed()) {
    overlay.webContents.send('live:state', publicState());
  }
  rebuildTrayMenu();
}

function showOverlay(): void {
  if (!overlay || overlay.isDestroyed()) return;
  cancelOverlayHide();
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const bounds = overlay.getBounds();
  const position = overlayPosition(
    display.workArea,
    bounds.width,
    bounds.height,
  );
  overlay.setPosition(position.x, position.y, false);
  overlay.showInactive();
}

function cancelOverlayHide(): void {
  if (overlayHideTimer) clearTimeout(overlayHideTimer);
  overlayHideTimer = undefined;
}

function scheduleOverlayHide(): void {
  if (overlayHideTimer) clearTimeout(overlayHideTimer);
  overlayHideTimer = setTimeout(() => {
    overlayHideTimer = undefined;
    overlay?.hide();
  }, 4_000);
  overlayHideTimer.unref();
}

function scheduleReadinessReconnect(): void {
  if (readinessReconnectTimer) clearTimeout(readinessReconnectTimer);
  readinessReconnectTimer = setTimeout(() => {
    readinessReconnectTimer = undefined;
    daemon.reconnectNow();
  }, 250);
  readinessReconnectTimer.unref();
}

function applyLiveStatus(status: LiveStatus): void {
  live = status;
  const captureEnabled = shouldCaptureLiveAudio(status, isHostReady());
  overlay?.webContents.send('live:audio:set-capture', {
    enabled: captureEnabled,
    muted: status.inputMuted ?? false,
    epoch: daemon.getEpoch(),
  });
  overlay?.webContents.send(
    'live:audio:set-output-muted',
    status.outputMuted ?? false,
  );
  if (!captureEnabled || status.state === 'stopping') {
    overlay?.webContents.send('live:audio:clear');
  }
  if (captureEnabled) showOverlay();
  else if (isHostReady() && status.available && status.state === 'idle') {
    scheduleOverlayHide();
  } else {
    cancelOverlayHide();
  }
  publishState();
}

function stopLocalAudio(): void {
  overlay?.webContents.send('live:audio:clear');
  overlay?.webContents.send('live:audio:set-capture', {
    enabled: false,
    muted: true,
    epoch: daemon.getEpoch(),
  });
}

function toggleLive(): void {
  showOverlay();
  if (!canToggleLive(live, connection.phase === 'ready', isHostReady())) return;
  daemon.sendAction({
    type: 'host.action',
    action: 'toggle',
    epoch: daemon.getEpoch(),
  });
}

function newConversation(): void {
  showOverlay();
  if (connection.phase !== 'ready' || !live.available || !isHostReady()) return;
  daemon.sendAction({
    type: 'host.action',
    action: 'new',
    epoch: daemon.getEpoch(),
  });
}

function stopLive(): void {
  stopLocalAudio();
  daemon.sendAction({
    type: 'host.action',
    action: 'stop',
    epoch: daemon.getEpoch(),
  });
}

function failClosedForReadinessLoss(): void {
  if (isActiveLiveCall(live)) stopLive();
  else stopLocalAudio();
}

function isTrustedSender(
  event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent,
): boolean {
  return Boolean(
    overlay && !overlay.isDestroyed() && event.sender === overlay.webContents,
  );
}

function isLocator(value: unknown): value is SessionLocator {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.workspaceCwd === 'string' &&
    record.workspaceCwd.length > 0 &&
    record.workspaceCwd.length <= 4_096 &&
    typeof record.sessionId === 'string' &&
    record.sessionId.length > 0 &&
    record.sessionId.length <= 256
  );
}

function registerIpc(): void {
  ipcMain.handle('live:toggle', (event) => {
    if (isTrustedSender(event)) toggleLive();
  });
  ipcMain.handle('live:new-conversation', (event) => {
    if (isTrustedSender(event)) newConversation();
  });
  ipcMain.handle('live:stop', (event) => {
    if (isTrustedSender(event)) stopLive();
  });
  ipcMain.handle('live:set-input-muted', (event, muted: unknown) => {
    if (!isTrustedSender(event) || typeof muted !== 'boolean') return;
    const outputMuted = live.outputMuted ?? false;
    live = { ...live, inputMuted: muted };
    overlay?.webContents.send('live:audio:set-capture', {
      enabled: shouldCaptureLiveAudio(live, isHostReady()),
      muted,
      epoch: daemon.getEpoch(),
    });
    daemon.sendAction({
      type: 'host.action',
      action: 'mute',
      inputMuted: muted,
      outputMuted,
      epoch: daemon.getEpoch(),
    });
    publishState();
  });
  ipcMain.handle('live:set-output-muted', (event, muted: unknown) => {
    if (!isTrustedSender(event) || typeof muted !== 'boolean') return;
    const inputMuted = live.inputMuted ?? false;
    live = { ...live, outputMuted: muted };
    overlay?.webContents.send('live:audio:set-output-muted', muted);
    daemon.sendAction({
      type: 'host.action',
      action: 'mute',
      inputMuted,
      outputMuted: muted,
      epoch: daemon.getEpoch(),
    });
    publishState();
  });
  ipcMain.handle('live:open-session', (event, locator: unknown) => {
    if (!isTrustedSender(event) || !isLocator(locator)) return;
    daemon.sendAction({
      type: 'host.action',
      action: 'open_session',
      locator,
      epoch: daemon.getEpoch(),
    });
  });
  ipcMain.handle(
    'live:request-permission',
    async (event, permission: unknown) => {
      if (!isTrustedSender(event) || typeof permission !== 'string') return;
      if (permission === 'microphone') {
        const granted = await systemPreferences.askForMediaAccess('microphone');
        permissions.microphone = granted ? 'granted' : microphonePermission();
        overlay?.webContents.send('live:audio:initialize', granted);
        if (!granted) {
          void shell.openExternal(
            'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
          );
        }
        publishState();
        scheduleReadinessReconnect();
        return;
      }
      if (permission === 'inputMonitoring') {
        commandMonitor.requestAccess();
        return;
      }
      if (permission === 'accessibility' || permission === 'screenRecording') {
        cuaMonitor.requestPermission(permission);
        daemon.sendAction({
          type: 'host.action',
          action: 'request_permission',
          permission,
          epoch: daemon.getEpoch(),
        });
      }
    },
  );
  ipcMain.handle('live:get-state', (event) => {
    if (!isTrustedSender(event))
      throw new Error('Untrusted Live Host renderer');
    return publicState();
  });

  ipcMain.on('live:audio:input', (event, value: unknown) => {
    if (
      !isTrustedSender(event) ||
      typeof value !== 'object' ||
      value === null ||
      Array.isArray(value)
    ) {
      return;
    }
    const record = value as Record<string, unknown>;
    if (
      typeof record.epoch !== 'number' ||
      !Number.isSafeInteger(record.epoch) ||
      record.epoch < 0 ||
      !ArrayBuffer.isView(record.pcm16)
    ) {
      return;
    }
    const valueView = record.pcm16;
    const frame = new Uint8Array(
      valueView.buffer,
      valueView.byteOffset,
      valueView.byteLength,
    );
    if (isValidInputAudioFrame(frame)) daemon.sendAudio(frame, record.epoch);
  });
  ipcMain.on('live:audio:self-check', (event, value: unknown) => {
    if (!isTrustedSender(event) || typeof value !== 'object' || value === null)
      return;
    const record = value as Record<string, unknown>;
    const nextInput = record.audioInput === true;
    const nextOutput = record.audioOutput === true;
    const changed =
      selfChecks.audioInput !== nextInput ||
      selfChecks.audioOutput !== nextOutput;
    selfChecks.audioInput = nextInput;
    selfChecks.audioOutput = nextOutput;
    if (!nextInput || !nextOutput) failClosedForReadinessLoss();
    publishState();
    if (changed) scheduleReadinessReconnect();
  });
  ipcMain.on('live:audio:capture-error', (event) => {
    if (!isTrustedSender(event)) return;
    selfChecks.audioInput = false;
    failClosedForReadinessLoss();
    publishState();
    scheduleReadinessReconnect();
  });
  ipcMain.on('live:audio:output-error', (event) => {
    if (!isTrustedSender(event)) return;
    selfChecks.audioOutput = false;
    failClosedForReadinessLoss();
    publishState();
    scheduleReadinessReconnect();
  });
  ipcMain.on('live:pointer-interactivity', (event, interactive: unknown) => {
    if (!isTrustedSender(event) || typeof interactive !== 'boolean') return;
    if (pointerInteractive === interactive) return;
    pointerInteractive = interactive;
    overlay?.setIgnoreMouseEvents(!interactive, { forward: true });
  });
}

function createOverlay(showOnReady: boolean): BrowserWindow {
  const width = 420;
  const height = 300;
  const window = new BrowserWindow({
    width,
    height,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    title: 'Qwen Live Host',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
    },
  });
  window.setAlwaysOnTop(true, 'floating');
  window.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    skipTransformProcessType: true,
  });
  window.setIgnoreMouseEvents(true, { forward: true });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.once('ready-to-show', () => {
    if (showOnReady) showOverlay();
  });
  window.webContents.once('did-finish-load', () => {
    window.webContents.send(
      'live:audio:initialize',
      permissions.microphone === 'granted',
    );
    publishState();
  });
  void window.loadFile(join(__dirname, 'renderer', 'index.html'));
  return window;
}

function openWebShellWindow(
  target: OpenSessionTarget,
  daemonConnection: { url: string; token?: string },
): void {
  const url = buildWebShellSessionUrl(daemonConnection.url, target);
  const daemonOrigin = new URL(url).origin;
  const isolatedSession = electronSession.fromPartition(
    `qwen-live-web-shell-${randomUUID()}`,
    { cache: false },
  );
  denyWebShellPermissions(isolatedSession);
  isolatedSession.webRequest.onBeforeSendHeaders(
    { urls: ['<all_urls>'] },
    (details, callback) => {
      callback({
        requestHeaders: authorizeDaemonRequest(
          details.url,
          daemonOrigin,
          daemonConnection.token,
          details.requestHeaders,
        ),
      });
    },
  );

  const window = new BrowserWindow({
    width: 1_280,
    height: 860,
    minWidth: 860,
    minHeight: 600,
    show: false,
    title: 'Qwen Code',
    autoHideMenuBar: true,
    backgroundColor: '#0d0d0d',
    webPreferences: {
      session: isolatedSession,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
    },
  });
  webShellWindows.add(window);

  const openExternal = (value: string): void => {
    if (isSafeExternalUrl(value)) {
      void shell.openExternal(value).catch(() => undefined);
    }
  };
  const guardNavigation = (event: Electron.Event, value: string): void => {
    if (isSameDaemonOrigin(value, daemonOrigin)) return;
    event.preventDefault();
    openExternal(value);
  };
  window.webContents.on('will-frame-navigate', (event) => {
    if (isSameDaemonOrigin(event.url, daemonOrigin)) return;
    event.preventDefault();
    if (event.isMainFrame) openExternal(event.url);
  });
  window.webContents.on('will-redirect', guardNavigation);
  window.webContents.setWindowOpenHandler(({ url: requestedUrl }) => {
    if (isSameDaemonOrigin(requestedUrl, daemonOrigin)) {
      void window.loadURL(requestedUrl);
    } else {
      openExternal(requestedUrl);
    }
    return { action: 'deny' };
  });
  window.once('ready-to-show', () => window.show());
  window.on('closed', () => {
    webShellWindows.delete(window);
    isolatedSession.webRequest.onBeforeSendHeaders(null);
    void isolatedSession.clearCache();
    void isolatedSession.clearStorageData();
  });
  void window.loadURL(url).catch(() => {
    if (!window.isDestroyed()) window.close();
  });
}

function trayIconPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'live-host-icon.png')
    : join(
        app.getAppPath(),
        '..',
        'electron',
        'resources',
        'brands',
        'qwen-code',
        'icon.png',
      );
}

function rebuildTrayMenu(): void {
  if (!tray) return;
  const effectiveLive = effectiveLiveStatus();
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '打开 Qwen Live 状态', click: showOverlay },
      {
        label: '开始对话',
        enabled: effectiveLive.available && !isActiveLiveCall(live),
        click: toggleLive,
      },
      {
        label: '新对话',
        enabled: effectiveLive.available,
        click: newConversation,
      },
      {
        label: '停止对话',
        enabled: isActiveLiveCall(live),
        click: stopLive,
      },
      { type: 'separator' },
      {
        label: '退出 Qwen Live Host',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
  tray.setToolTip(`Qwen Live Host · ${effectiveLive.state}`);
}

function createTray(): void {
  const icon = nativeImage
    .createFromPath(trayIconPath())
    .resize({ width: 18, height: 18 });
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.on('click', showOverlay);
  rebuildTrayMenu();
}

app.on('second-instance', showOverlay);
app.on('window-all-closed', () => {});
app.on('before-quit', () => {
  quitting = true;
  if (readinessReconnectTimer) clearTimeout(readinessReconnectTimer);
  if (microphonePermissionTimer) clearInterval(microphonePermissionTimer);
  if (overlayHideTimer) clearTimeout(overlayHideTimer);
  commandMonitor?.stop();
  cuaMonitor?.stop();
  daemon?.stop();
});

void app.whenReady().then(() => {
  app.setActivationPolicy('accessory');
  if (app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true });
  }

  permissions.microphone = microphonePermission();
  registerIpc();
  overlay = createOverlay(!app.getLoginItemSettings().wasOpenedAtLogin);
  createTray();

  commandMonitor = new CommandMonitor(toggleLive, (state) => {
    const changed =
      permissions.inputMonitoring !== state.permission ||
      selfChecks.globalShortcut !== state.healthy;
    permissions.inputMonitoring = state.permission;
    selfChecks.globalShortcut = state.healthy;
    if (state.permission !== 'granted' || !state.healthy) {
      failClosedForReadinessLoss();
    }
    publishState();
    if (changed) scheduleReadinessReconnect();
  });

  cuaMonitor = new CuaReadinessMonitor((state) => {
    const changed =
      permissions.accessibility !== state.accessibility ||
      permissions.screenRecording !== state.screenRecording ||
      selfChecks.appshot !== state.appshot;
    permissions.accessibility = state.accessibility;
    permissions.screenRecording = state.screenRecording;
    selfChecks.appshot = state.appshot;
    if (
      state.accessibility !== 'granted' ||
      state.screenRecording !== 'granted' ||
      !state.appshot
    ) {
      failClosedForReadinessLoss();
    }
    publishState();
    if (changed) scheduleReadinessReconnect();
  });

  daemon = new LiveDaemonConnection(app.getVersion(), {
    getReadiness: () => ({
      permissions: { ...permissions },
      selfChecks: { ...selfChecks },
    }),
    onSnapshot: (snapshot) => {
      connection = snapshot;
      if (snapshot.status) applyLiveStatus(snapshot.status);
      else {
        if (snapshot.phase !== 'ready') {
          cancelOverlayHide();
          stopLocalAudio();
          live = {
            ...live,
            available: false,
            state: 'unavailable',
            blocker:
              snapshot.phase === 'incompatible'
                ? 'host_version'
                : 'host_disconnected',
          };
        }
        publishState();
      }
    },
    onOutputAudio: (audio) => {
      if (!live.outputMuted)
        overlay?.webContents.send('live:audio:play', audio);
    },
    onClearOutput: () => overlay?.webContents.send('live:audio:clear'),
    onOpenSession: openWebShellWindow,
  });

  commandMonitor.start();
  cuaMonitor.start();
  daemon.start();
  microphonePermissionTimer = setInterval(() => {
    const next = microphonePermission();
    if (next === permissions.microphone) return;
    permissions.microphone = next;
    if (next !== 'granted') {
      selfChecks.audioInput = false;
      failClosedForReadinessLoss();
    } else {
      overlay?.webContents.send('live:audio:initialize', true);
    }
    publishState();
    scheduleReadinessReconnect();
  }, 2_000);
  microphonePermissionTimer.unref();
});

app.on('activate', () => {
  if (!quitting) showOverlay();
});
