import { createHash } from 'node:crypto';
import { createWriteStream, mkdirSync } from 'node:fs';
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
import { AppshotReadinessMonitor } from './appshot-readiness.ts';
import { AppshotCaptureService } from './appshot-capture.ts';
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
  projectLiveStatusForCapture,
  shouldCaptureLiveAudio,
  shouldStopLiveOnToggle,
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
let appshotReadiness: AppshotReadinessMonitor;
let shortcut: LiveGlobalShortcut;
let overlayRecovery: OverlayRecoveryController;
let appshotCapture: AppshotCaptureService;
let quitting = false;
let nativeServicesActive = false;
let audioTransportFailed = false;
let readinessReconnectTimer: NodeJS.Timeout | undefined;
let microphonePermissionTimer: NodeJS.Timeout | undefined;
let overlayHideTimer: NodeJS.Timeout | undefined;
let pointerInteractive = false;
let captureReadyEpoch: number | undefined;
let liveStartPending = false;
const READINESS_RECONNECT_DEBOUNCE_MS = 2_500;

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
  shortcut: 'Command+E',
  blocker: 'host_disconnected',
};

function writeLiveDiagnostic(
  event: string,
  details: Readonly<Record<string, unknown>> = {},
): void {
  if (process.env['QWEN_LIVE_DIAGNOSTICS'] !== '1') return;
  process.stderr.write(
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      source: 'live-host',
      event,
      ...details,
    })}\n`,
  );
}

interface HostAudioCapture {
  source: 'host-output' | 'host-input';
  epoch: number;
  path: string;
  stream: ReturnType<typeof createWriteStream>;
  hash: ReturnType<typeof createHash>;
  bytes: number;
}

let hostAudioCapture: HostAudioCapture | undefined;
let hostInputCapture: HostAudioCapture | undefined;

function openHostAudioCapture(
  source: HostAudioCapture['source'],
  epoch: number,
): HostAudioCapture | undefined {
  const directory = process.env['QWEN_LIVE_DIAGNOSTICS_DIR'];
  if (process.env['QWEN_LIVE_DIAGNOSTICS'] !== '1' || !directory?.trim()) {
    return undefined;
  }
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, `${source}-${Date.now()}-epoch-${epoch}.pcm`);
    const stream = createWriteStream(path, { flags: 'wx', mode: 0o600 });
    stream.on('error', () => undefined);
    const capture = {
      source,
      epoch,
      path,
      stream,
      hash: createHash('sha256'),
      bytes: 0,
    };
    writeLiveDiagnostic('host_audio_capture_opened', {
      captureSource: source,
      path,
      epoch,
    });
    return capture;
  } catch {
    return undefined;
  }
}

function appendAudioCapture(
  capture: HostAudioCapture,
  audio: Uint8Array,
): void {
  capture.bytes += audio.byteLength;
  capture.hash.update(audio);
  capture.stream.write(Buffer.from(audio));
}

function closeAudioCapture(
  capture: HostAudioCapture | undefined,
  reason: string,
): void {
  if (!capture) return;
  capture.stream.end();
  writeLiveDiagnostic('host_audio_capture_closed', {
    captureSource: capture.source,
    path: capture.path,
    bytes: capture.bytes,
    sha256: capture.hash.digest('hex'),
    reason,
  });
}

function appendHostAudio(audio: Uint8Array, epoch: number): void {
  if (!hostAudioCapture) {
    hostAudioCapture = openHostAudioCapture('host-output', epoch);
  }
  if (hostAudioCapture) appendAudioCapture(hostAudioCapture, audio);
}

function closeHostAudioCapture(reason: string): void {
  const capture = hostAudioCapture;
  hostAudioCapture = undefined;
  closeAudioCapture(capture, reason);
}

function appendHostInputAudio(audio: Uint8Array, epoch: number): void {
  if (hostInputCapture?.epoch !== epoch) {
    closeAudioCapture(hostInputCapture, 'epoch_changed');
    hostInputCapture = openHostAudioCapture('host-input', epoch);
  }
  if (hostInputCapture) appendAudioCapture(hostInputCapture, audio);
}

function closeHostInputCapture(reason: string): void {
  const capture = hostInputCapture;
  hostInputCapture = undefined;
  closeAudioCapture(capture, reason);
}

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
  if (live.available && blocker) {
    return { ...live, available: false, state: 'unavailable', blocker };
  }
  return projectLiveStatusForCapture(
    live,
    captureReadyEpoch === daemon?.getEpoch(),
  );
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
  }, READINESS_RECONNECT_DEBOUNCE_MS);
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
  captureReadyEpoch = undefined;
  sendAudioCommand('live:audio:clear');
  sendAudioCommand('live:audio:set-capture', {
    enabled: false,
    muted: true,
    epoch: daemon.getEpoch(),
  });
}

function failRequiredAction(action: HostAction['action']): void {
  liveStartPending = false;
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
  liveStartPending = false;
  stopLocalAudio();
  cancelOverlayHide();
  overlay?.hide();
  sendRequiredAction({
    type: 'host.action',
    action: 'stop',
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
  if (status.state !== 'idle') liveStartPending = false;
  if (nativeServicesActive) {
    const state = shortcut.replace(status.shortcut);
    if (!state.healthy && selfChecks.globalShortcut) {
      selfChecks.globalShortcut = false;
      failClosedForReadinessLoss();
      scheduleReadinessReconnect();
    }
  }
  const captureEnabled =
    !audioTransportFailed && shouldCaptureLiveAudio(status, isHostReady());
  const captureEpoch = daemon.getEpoch();
  if (!captureEnabled || captureReadyEpoch !== captureEpoch) {
    captureReadyEpoch = undefined;
  }
  writeLiveDiagnostic('status_applied', {
    epoch: daemon.getEpoch(),
    state: status.state,
    captureEnabled,
    available: status.available,
  });
  sendAudioCommand('live:audio:set-capture', {
    enabled: captureEnabled,
    muted: status.inputMuted ?? false,
    epoch: captureEpoch,
  });
  sendAudioCommand('live:audio:set-output-muted', status.outputMuted ?? false);
  if (!captureEnabled || status.state === 'stopping') {
    closeHostInputCapture(
      status.state === 'stopping' ? 'call_stopping' : 'capture_disabled',
    );
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
  writeLiveDiagnostic('shortcut_toggle', {
    epoch: daemon.getEpoch(),
    state: live.state,
  });
  if (shouldStopLiveOnToggle(live, liveStartPending)) {
    stopLive();
    return;
  }
  showOverlay();
  if (!canToggleLive(live, connection.phase === 'ready', isHostReady())) return;
  if (
    sendRequiredAction({
      type: 'host.action',
      action: 'toggle',
      epoch: daemon.getEpoch(),
    })
  ) {
    liveStartPending = true;
  }
}

function newConversation(): void {
  showOverlay();
  if (connection.phase !== 'ready' || !live.available || !isHostReady()) return;
  if (
    sendRequiredAction({
      type: 'host.action',
      action: 'new',
      epoch: daemon.getEpoch(),
    })
  ) {
    liveStartPending = true;
  }
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
  captureReadyEpoch = undefined;
  liveStartPending = false;
  permissions.microphone = microphonePermission();
  permissions.accessibility = 'not_determined';
  permissions.screenRecording = 'not_determined';
  selfChecks.audioInput = false;
  selfChecks.audioOutput = false;
  selfChecks.globalShortcut = false;
  selfChecks.appshot = false;
  appshotReadiness.start();
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
  captureReadyEpoch = undefined;
  liveStartPending = false;
  if (readinessReconnectTimer) clearTimeout(readinessReconnectTimer);
  readinessReconnectTimer = undefined;
  if (microphonePermissionTimer) clearInterval(microphonePermissionTimer);
  microphonePermissionTimer = undefined;
  shortcut.stop();
  appshotReadiness.stop();
  sendAudioCommand('live:audio:deactivate');
  permissions.microphone = 'not_determined';
  permissions.accessibility = 'not_determined';
  permissions.screenRecording = 'not_determined';
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
  ipcMain.handle('live:open-web-shell-permission', async (event) => {
    if (!isTrustedSender(event) || !live.pendingPermission) return;
    const url = daemon.getWebShellSessionUrl(live.pendingPermission);
    if (url) await shell.openExternal(url);
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
  ipcMain.on('live:audio:playback-started', (event, epoch: unknown) => {
    if (
      typeof epoch !== 'number' ||
      !Number.isSafeInteger(epoch) ||
      epoch !== daemon.getEpoch()
    ) {
      return;
    }
    daemon.sendPlaybackStarted(epoch);
  });

  ipcMain.on('live:audio:playback-completed', (event, epoch: unknown) => {
    if (
      typeof epoch !== 'number' ||
      !Number.isSafeInteger(epoch) ||
      epoch !== daemon.getEpoch()
    ) {
      return;
    }
    daemon.sendPlaybackCompleted(epoch);
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
        appshotReadiness.requestPermission(permission);
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
    if (isValidInputAudioFrame(frame)) {
      appendHostInputAudio(frame, record.epoch);
      if (!daemon.sendAudio(frame, record.epoch)) {
        failAudioAndRecheck('audio_transport_rejected');
      }
    }
  });
  ipcMain.on('live:audio:diagnostic', (event, value: unknown) => {
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
      typeof record.event !== 'string' ||
      record.event.length > 128 ||
      typeof record.details !== 'object' ||
      record.details === null ||
      Array.isArray(record.details)
    ) {
      return;
    }
    writeLiveDiagnostic(
      record.event,
      record.details as Record<string, unknown>,
    );
  });
  ipcMain.on('live:audio:capture-ready', (event, value: unknown) => {
    if (
      !isTrustedSender(event) ||
      !rendererAudioEventsEnabled ||
      typeof value !== 'object' ||
      value === null ||
      Array.isArray(value)
    ) {
      return;
    }
    const epoch = (value as Record<string, unknown>).epoch;
    if (
      typeof epoch !== 'number' ||
      !Number.isSafeInteger(epoch) ||
      epoch < 0 ||
      epoch !== daemon.getEpoch() ||
      audioTransportFailed ||
      !shouldCaptureLiveAudio(live, isHostReady())
    ) {
      return;
    }
    captureReadyEpoch = epoch;
    writeLiveDiagnostic('capture_ready_acknowledged', { epoch });
    publishState();
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
    width: 384,
    height: 400,
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
  window.webContents.on('did-start-loading', () => {
    rendererLoadHealthy = true;
  });
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
  window.webContents.on('did-finish-load', () => {
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

function recoverOverlay(): void {
  if (quitting) return;
  if (!overlay || overlay.isDestroyed() || overlay.webContents.isDestroyed()) {
    overlay = createOverlay();
    return;
  }
  overlay.webContents.reload();
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
  appshotCapture?.dispose();
});

void app.whenReady().then(() => {
  app.setActivationPolicy('accessory');
  registerIpc();
  overlayRecovery = new OverlayRecoveryController((reason) => {
    rendererAudioEventsEnabled = false;
    failAudioAndRecheck(reason);
    overlayReady = false;
  }, recoverOverlay);
  overlay = createOverlay();
  createTray();

  shortcut = new LiveGlobalShortcut(globalShortcut, toggleLive, (state) => {
    const changed = selfChecks.globalShortcut !== state.healthy;
    selfChecks.globalShortcut = state.healthy;
    if (!state.healthy) failClosedForReadinessLoss();
    publishState();
    if (changed) scheduleReadinessReconnect();
  });

  appshotReadiness = new AppshotReadinessMonitor((state) => {
    if (!nativeServicesActive) return;
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
  appshotCapture = new AppshotCaptureService();

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
        const epoch = daemon.getEpoch();
        appendHostAudio(audio, epoch);
        writeLiveDiagnostic('output_frame_received', {
          epoch,
          bytes: audio.byteLength,
        });
        sendAudioCommand('live:audio:play', { audio, epoch });
      }
    },
    onClearOutput: () => {
      closeHostAudioCapture('clear_output');
      writeLiveDiagnostic('clear_output_received', {
        epoch: daemon.getEpoch(),
      });
      sendAudioCommand('live:audio:clear');
    },
    setShortcut: (accelerator) => {
      if (!nativeServicesActive) {
        return {
          success: false,
          error: 'Qwen Live Host is not ready.',
        };
      }
      const state = shortcut.replace(accelerator);
      return {
        success: state.healthy,
        ...(state.error ? { error: state.error } : {}),
      };
    },
    captureScreenContext: () => {
      appshotReadiness.refresh();
      if (!nativeServicesActive || !isHostReady()) {
        throw new Error('Appshot permissions or Host readiness were lost.');
      }
      return appshotCapture.capture();
    },
  });

  daemon.start();
});

app.on('activate', () => {
  if (!quitting) {
    appshotReadiness?.refresh();
    showOverlay();
  }
});
