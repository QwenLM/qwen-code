import { join } from 'node:path';
import {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  screen,
  shell,
  systemPreferences,
  Tray,
} from 'electron';
import { CuaReadinessMonitor } from './cua-readiness.ts';
import {
  LiveDaemonConnection,
  type ConnectionSnapshot,
} from './daemon-connection.ts';
import { LiveGlobalShortcut } from './global-shortcut.ts';
import {
  isValidInputAudioFrame,
  type HostAction,
  type HostPermissions,
  type HostSelfChecks,
  type LiveStatus,
  type PermissionState,
} from '../shared/protocol.ts';
import type { HostPublicState } from '../shared/host-api.ts';
import { overlayPosition } from './overlay-position.ts';
import {
  shouldActivateNativeServices,
  shouldDeactivateNativeServices,
} from './native-service-policy.ts';
import {
  isRecoverableOverlayLoadFailure,
  OverlayRecoveryController,
  type OverlayFailureReason,
} from './overlay-recovery.ts';
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
let overlayReady = false;
let rendererAudioEventsEnabled = false;
let tray: Tray | undefined;
let daemon: LiveDaemonConnection;
let cuaMonitor: CuaReadinessMonitor;
let shortcut: LiveGlobalShortcut;
let overlayRecovery: OverlayRecoveryController;
let quitting = false;
let nativeServicesActive = false;
let audioTransportFailed = false;
let cuaInstalled = false;
let readinessReconnectTimer: NodeJS.Timeout | undefined;
let microphonePermissionTimer: NodeJS.Timeout | undefined;
let overlayHideTimer: NodeJS.Timeout | undefined;
let pointerInteractive = false;

const permissions: HostPermissions = {
  microphone: 'not_determined',
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
  shortcut: 'Command+Q',
  blocker: 'host_disconnected',
};

function hostReadinessBlocker(): string | undefined {
  if (permissions.microphone !== 'granted') return 'microphone_permission';
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
  return nativeServicesActive && hostReadinessBlocker() === undefined;
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
    cuaInstalled,
  };
}

function publishState(): void {
  if (
    overlayReady &&
    overlay &&
    !overlay.isDestroyed() &&
    !overlay.webContents.isDestroyed()
  ) {
    try {
      overlay.webContents.send('live:state', publicState());
    } catch {
      overlayReady = false;
    }
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
  if (!nativeServicesActive) return;
  if (readinessReconnectTimer) clearTimeout(readinessReconnectTimer);
  readinessReconnectTimer = setTimeout(() => {
    readinessReconnectTimer = undefined;
    daemon.reconnectNow();
  }, 250);
  readinessReconnectTimer.unref();
}

function sendAudioCommand(channel: string, value?: unknown): void {
  if (
    !overlayReady ||
    !overlay ||
    overlay.isDestroyed() ||
    overlay.webContents.isDestroyed()
  ) {
    return;
  }
  try {
    overlay.webContents.send(channel, value);
  } catch {
    overlayReady = false;
  }
}

function stopLocalAudio(): void {
  sendAudioCommand('live:audio:clear');
  sendAudioCommand('live:audio:set-capture', {
    enabled: false,
    muted: true,
    epoch: daemon.getEpoch(),
  });
}

function failRequiredAction(action: HostAction['action']): void {
  audioTransportFailed = true;
  selfChecks.audioInput = false;
  selfChecks.audioOutput = false;
  stopLocalAudio();
  cancelOverlayHide();
  live = {
    ...live,
    available: false,
    state: 'error',
    blocker: 'host_disconnected',
    message: `Live action "${action}" could not reach the daemon. Reconnecting.`,
  };
  publishState();
  sendAudioCommand('live:audio:recheck', 'daemon_action_failed');
  daemon.forceReconnectNow();
}

function sendRequiredAction(action: HostAction): boolean {
  let sent = false;
  try {
    sent = daemon.sendAction(action);
  } catch {
    sent = false;
  }
  if (!sent) failRequiredAction(action.action);
  return sent;
}

function stopLive(): void {
  stopLocalAudio();
  sendRequiredAction({
    type: 'host.action',
    action: 'stop',
    epoch: daemon.getEpoch(),
  });
}

function failClosedForReadinessLoss(): void {
  if (isActiveLiveCall(live)) stopLive();
  else stopLocalAudio();
}

function failAudioAndRecheck(reason: string): void {
  if (!nativeServicesActive) return;
  audioTransportFailed = true;
  selfChecks.audioInput = false;
  selfChecks.audioOutput = false;
  failClosedForReadinessLoss();
  publishState();
  sendAudioCommand('live:audio:recheck', reason);
  scheduleReadinessReconnect();
}

function applyLiveStatus(status: LiveStatus): void {
  live = status;
  if (nativeServicesActive) shortcut.replace(status.shortcut);
  const captureEnabled =
    !audioTransportFailed && shouldCaptureLiveAudio(status, isHostReady());
  sendAudioCommand('live:audio:set-capture', {
    enabled: captureEnabled,
    muted: status.inputMuted ?? false,
    epoch: daemon.getEpoch(),
  });
  sendAudioCommand('live:audio:set-output-muted', status.outputMuted ?? false);
  if (!captureEnabled || status.state === 'stopping') {
    sendAudioCommand('live:audio:clear');
  }
  if (captureEnabled) showOverlay();
  else if (isHostReady() && status.available && status.state === 'idle') {
    scheduleOverlayHide();
  } else {
    cancelOverlayHide();
  }
  publishState();
}

function toggleLive(): void {
  showOverlay();
  if (!canToggleLive(live, connection.phase === 'ready', isHostReady())) return;
  sendRequiredAction({
    type: 'host.action',
    action: 'toggle',
    epoch: daemon.getEpoch(),
  });
}

function newConversation(): void {
  showOverlay();
  if (connection.phase !== 'ready' || !live.available || !isHostReady()) return;
  sendRequiredAction({
    type: 'host.action',
    action: 'new',
    epoch: daemon.getEpoch(),
  });
}

function beginMicrophonePermissionMonitor(): void {
  if (microphonePermissionTimer) return;
  microphonePermissionTimer = setInterval(() => {
    if (!nativeServicesActive) return;
    const next = microphonePermission();
    if (next === permissions.microphone) return;
    permissions.microphone = next;
    selfChecks.audioInput = false;
    if (next !== 'granted') {
      failClosedForReadinessLoss();
    } else {
      sendAudioCommand('live:audio:initialize', true);
    }
    publishState();
    scheduleReadinessReconnect();
  }, 2_000);
  microphonePermissionTimer.unref();
}

function activateNativeServices(): void {
  if (nativeServicesActive) return;
  nativeServicesActive = true;
  audioTransportFailed = false;
  permissions.microphone = microphonePermission();
  permissions.accessibility = 'not_determined';
  permissions.screenRecording = 'not_determined';
  cuaInstalled = false;
  selfChecks.audioInput = false;
  selfChecks.audioOutput = false;
  selfChecks.globalShortcut = false;
  selfChecks.appshot = false;
  cuaMonitor.start();
  beginMicrophonePermissionMonitor();
  sendAudioCommand(
    'live:audio:initialize',
    permissions.microphone === 'granted',
  );
}

function deactivateNativeServices(): void {
  if (!nativeServicesActive) return;
  nativeServicesActive = false;
  audioTransportFailed = false;
  if (readinessReconnectTimer) clearTimeout(readinessReconnectTimer);
  readinessReconnectTimer = undefined;
  if (microphonePermissionTimer) clearInterval(microphonePermissionTimer);
  microphonePermissionTimer = undefined;
  shortcut.stop();
  cuaMonitor.stop();
  sendAudioCommand('live:audio:deactivate');
  permissions.microphone = 'not_determined';
  permissions.accessibility = 'not_determined';
  permissions.screenRecording = 'not_determined';
  cuaInstalled = false;
  selfChecks.audioInput = false;
  selfChecks.audioOutput = false;
  selfChecks.globalShortcut = false;
  selfChecks.appshot = false;
}

function isTrustedSender(
  event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent,
): boolean {
  return Boolean(
    overlay && !overlay.isDestroyed() && event.sender === overlay.webContents,
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
    sendAudioCommand('live:audio:set-capture', {
      enabled:
        !audioTransportFailed && shouldCaptureLiveAudio(live, isHostReady()),
      muted,
      epoch: daemon.getEpoch(),
    });
    sendRequiredAction({
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
    sendAudioCommand('live:audio:set-output-muted', muted);
    sendRequiredAction({
      type: 'host.action',
      action: 'mute',
      inputMuted,
      outputMuted: muted,
      epoch: daemon.getEpoch(),
    });
    publishState();
  });
  ipcMain.handle(
    'live:request-permission',
    async (event, permission: unknown) => {
      if (
        !isTrustedSender(event) ||
        !nativeServicesActive ||
        typeof permission !== 'string'
      ) {
        return;
      }
      if (permission === 'microphone') {
        const granted = await systemPreferences.askForMediaAccess('microphone');
        permissions.microphone = granted ? 'granted' : microphonePermission();
        selfChecks.audioInput = false;
        failClosedForReadinessLoss();
        sendAudioCommand('live:audio:initialize', granted);
        if (!granted) {
          void shell.openExternal(
            'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
          );
        }
        publishState();
        scheduleReadinessReconnect();
        return;
      }
      if (permission === 'accessibility' || permission === 'screenRecording') {
        if (cuaInstalled) cuaMonitor.requestPermission(permission);
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
      !nativeServicesActive ||
      !rendererAudioEventsEnabled ||
      audioTransportFailed ||
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
    if (
      isValidInputAudioFrame(frame) &&
      !daemon.sendAudio(frame, record.epoch)
    ) {
      failAudioAndRecheck('audio_transport_rejected');
    }
  });
  ipcMain.on('live:audio:self-check', (event, value: unknown) => {
    if (
      !isTrustedSender(event) ||
      !nativeServicesActive ||
      !rendererAudioEventsEnabled ||
      typeof value !== 'object' ||
      value === null
    ) {
      return;
    }
    const record = value as Record<string, unknown>;
    const nextInput = record.audioInput === true;
    const nextOutput = record.audioOutput === true;
    const changed =
      selfChecks.audioInput !== nextInput ||
      selfChecks.audioOutput !== nextOutput;
    selfChecks.audioInput = nextInput;
    selfChecks.audioOutput = nextOutput;
    if (nextInput && nextOutput) audioTransportFailed = false;
    else failClosedForReadinessLoss();
    publishState();
    if (changed) scheduleReadinessReconnect();
  });
  ipcMain.on('live:audio:capture-error', (event) => {
    if (isTrustedSender(event) && rendererAudioEventsEnabled) {
      failAudioAndRecheck('audio_capture_error');
    }
  });
  ipcMain.on('live:audio:output-error', (event) => {
    if (isTrustedSender(event) && rendererAudioEventsEnabled) {
      failAudioAndRecheck('audio_output_error');
    }
  });
  ipcMain.on('live:pointer-interactivity', (event, interactive: unknown) => {
    if (!isTrustedSender(event) || typeof interactive !== 'boolean') return;
    if (pointerInteractive === interactive) return;
    pointerInteractive = interactive;
    overlay?.setIgnoreMouseEvents(!interactive, { forward: true });
  });
}

function createOverlay(): BrowserWindow {
  const window = new BrowserWindow({
    width: 420,
    height: 300,
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
  let rendererLoadHealthy = true;
  const handleFailure = (reason: OverlayFailureReason): void => {
    if (window !== overlay || quitting) return;
    rendererLoadHealthy = false;
    overlayRecovery.handleFailure(reason);
  };
  window.webContents.on('render-process-gone', () => {
    handleFailure('renderer_process_gone');
  });
  window.webContents.on('unresponsive', () => {
    handleFailure('renderer_unresponsive');
  });
  window.webContents.on('preload-error', () => {
    handleFailure('preload_failed');
  });
  window.webContents.on(
    'did-fail-load',
    (_event, errorCode, _description, _url, isMainFrame) => {
      if (isRecoverableOverlayLoadFailure(errorCode, isMainFrame)) {
        handleFailure('renderer_load_failed');
      }
    },
  );
  window.once('ready-to-show', showOverlay);
  window.webContents.once('did-finish-load', () => {
    if (window !== overlay || !rendererLoadHealthy) return;
    overlayRecovery.markReady();
    overlayReady = true;
    rendererAudioEventsEnabled = true;
    if (nativeServicesActive) {
      sendAudioCommand(
        'live:audio:initialize',
        permissions.microphone === 'granted',
      );
    }
    publishState();
  });
  void window.loadFile(join(__dirname, 'renderer', 'index.html'));
  return window;
}

function recreateOverlay(): void {
  if (quitting) return;
  const previous = overlay;
  overlayReady = false;
  rendererAudioEventsEnabled = false;
  pointerInteractive = false;
  const replacement = createOverlay();
  overlay = replacement;
  if (previous && !previous.isDestroyed()) previous.destroy();
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
  if (overlayHideTimer) clearTimeout(overlayHideTimer);
  overlayRecovery?.stop();
  deactivateNativeServices();
  daemon?.stop();
});

void app.whenReady().then(() => {
  app.setActivationPolicy('accessory');
  registerIpc();
  overlayRecovery = new OverlayRecoveryController((reason) => {
    rendererAudioEventsEnabled = false;
    failAudioAndRecheck(reason);
    overlayReady = false;
  }, recreateOverlay);
  overlay = createOverlay();
  createTray();

  shortcut = new LiveGlobalShortcut(globalShortcut, toggleLive, (state) => {
    const changed = selfChecks.globalShortcut !== state.healthy;
    selfChecks.globalShortcut = state.healthy;
    if (!state.healthy) failClosedForReadinessLoss();
    publishState();
    if (changed) scheduleReadinessReconnect();
  });

  cuaMonitor = new CuaReadinessMonitor((state) => {
    if (!nativeServicesActive) return;
    const changed =
      cuaInstalled !== state.installed ||
      permissions.accessibility !== state.accessibility ||
      permissions.screenRecording !== state.screenRecording ||
      selfChecks.appshot !== state.appshot;
    cuaInstalled = state.installed;
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
      if (shouldActivateNativeServices(snapshot.phase)) {
        activateNativeServices();
      }
      if (shouldDeactivateNativeServices(snapshot.phase)) {
        cancelOverlayHide();
        deactivateNativeServices();
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
      if (snapshot.status) applyLiveStatus(snapshot.status);
      else publishState();
    },
    onOutputAudio: (audio) => {
      if (nativeServicesActive && !live.outputMuted) {
        sendAudioCommand('live:audio:play', audio);
      }
    },
    onClearOutput: () => sendAudioCommand('live:audio:clear'),
  });

  daemon.start();
});

app.on('activate', () => {
  if (!quitting) showOverlay();
});
