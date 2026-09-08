import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream, lstatSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  isLiveLanguage,
  liveMessage,
  liveText,
  type LiveLanguage,
  type LiveMessageKey,
} from '@qwen-code/qwen-live/i18n';
import { readHostLanguage, saveHostLanguage } from './language-store.ts';
import { readHostTheme, saveHostTheme } from './theme-store.ts';
import {
  isLiveTheme,
  type LiveTheme,
  type ResolvedTheme,
} from '../shared/theme.ts';
import {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  screen,
  shell,
  systemPreferences,
  Tray,
} from 'electron';
import { AppshotReadinessMonitor } from './appshot-readiness.ts';
import { AppshotCaptureService } from './appshot-capture.ts';
import { StartupInteraction } from './startup-interaction.ts';
import { SubagentsWindows } from './subagents-windows.ts';
import {
  OVERLAY_GEOMETRY,
  type OverlayLayout,
} from '../shared/overlay-geometry.ts';
import {
  LiveDaemonConnection,
  type ConnectionSnapshot,
} from './daemon-connection.ts';
import { LiveGlobalShortcut } from './global-shortcut.ts';
import {
  isValidInputAudioFrame,
  isValidInputImageFrame,
  isValidCameraSnapshotAsset,
  fitRealtimeVisualDimensions,
  parseMemoryAction,
  MAX_INPUT_IMAGE_FRAME_BYTES,
  type HostAction,
  type HostSelfChecks,
  type LiveStatus,
  type PermissionState,
  type VisualInput,
  type VisualMode,
  type VisualSource,
} from '../shared/protocol.ts';
import { isLiveHostDiagnosticsEnabled } from '../shared/diagnostics.ts';
import type {
  HostPublicPermissions,
  HostPublicState,
} from '../shared/host-api.ts';
import type {
  CameraSnapshot,
  CameraSnapshotOptions,
} from '../preload/camera-engine.ts';
import {
  clampOverlayPosition,
  isOverlayPosition,
  overlayPosition,
  type OverlayPosition,
  type DisplayWorkArea,
} from './overlay-position.ts';
import {
  readOverlayPosition,
  saveOverlayPosition,
} from './overlay-position-store.ts';
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
  canChangeLiveVisualInput,
  canToggleLive,
  isActiveLiveCall,
  projectLiveStatusForCapture,
  shouldCaptureLiveAudio,
  shouldCaptureLiveVisual,
  shouldRequestVisualSourceChange,
  shouldShowCameraPreview,
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
let rendererEventsEnabled = false;
let tray: Tray | undefined;
let subagents: SubagentsWindows | undefined;
let daemon: LiveDaemonConnection;
let appshotReadiness: AppshotReadinessMonitor;
let shortcut: LiveGlobalShortcut;
let overlayRecovery: OverlayRecoveryController;
let appshotCapture: AppshotCaptureService;
let quitting = false;
let quitApproved = false;
let quitOperation: Promise<void> | undefined;
let quitState: HostPublicState['quitState'];
let nativeServicesActive = false;
let nativeServiceGeneration = 0;
let audioTransportFailed = false;
let readinessReconnectTimer: NodeJS.Timeout | undefined;
let mediaPermissionTimer: NodeJS.Timeout | undefined;
let settingsOpen = false;
let language: LiveLanguage = 'en';
let theme: LiveTheme = 'system';

function resolvedTheme(): ResolvedTheme {
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
}
let overlayLayout: OverlayLayout = 'setup';
let desiredOverlayPosition: OverlayPosition | undefined;
let hasCustomOverlayPosition = false;
let overlayOffset: OverlayPosition = { x: 0, y: 0 };
let pointerInteractive = false;
let pointerOverInteractive = false;
let overlayDrag:
  | { pointer: OverlayPosition; origin: OverlayPosition }
  | undefined;
const OVERLAY_WIDTH = OVERLAY_GEOMETRY.canvas.width;
const OVERLAY_HEIGHT = OVERLAY_GEOMETRY.canvas.height;
const startupInteraction = new StartupInteraction();
let captureReadyEpoch: number | undefined;
let liveStartPending = false;
let visualInput: VisualInput | undefined;
let visualReady = false;
let visualError: string | undefined;
let visualCallId: string | undefined;
let screenFeedTimer: NodeJS.Timeout | undefined;
let screenFeedInFlight = false;
let screenFeedGeneration = 0;
let screenFeedKey: string | undefined;
let visualGeneration = 0;
let visualSourceChangeGeneration = 0;
let pendingVisualSourceChange:
  | {
      source: VisualSource;
      generation: number;
      callId?: string;
      epoch: number;
      sent: boolean;
    }
  | undefined;
const READINESS_RECONNECT_DEBOUNCE_MS = 2_500;
const VISUAL_SNAPSHOT_TIMEOUT_MS = 10_000;
const SCREEN_LIVE_JPEG_ATTEMPTS = [
  { scale: 1, quality: 65 },
  { scale: 1, quality: 45 },
  { scale: 1, quality: 30 },
  { scale: 0.75, quality: 55 },
  { scale: 0.75, quality: 35 },
  { scale: 0.5, quality: 50 },
  { scale: 0.5, quality: 30 },
] as const;
const SCREEN_SNAPSHOT_JPEG_QUALITIES = [80, 65, 50, 35, 20, 10] as const;
const diagnosticsEnabled = isLiveHostDiagnosticsEnabled(
  process.argv,
  process.env,
);

const permissions: HostPublicPermissions = {
  microphone: 'not_determined',
  accessibility: 'not_determined',
  screenRecording: 'not_determined',
  camera: 'not_determined',
};
const selfChecks: HostSelfChecks = {
  audioInput: false,
  audioOutput: false,
  globalShortcut: false,
  appshot: false,
};
const pendingCameraSnapshots = new Map<
  string,
  {
    epoch: number;
    timer?: NodeJS.Timeout;
    sent: boolean;
    options: CameraSnapshotOptions;
    resolve: (frame: CameraSnapshot) => void;
    reject: (error: Error) => void;
  }
>();
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
  if (!diagnosticsEnabled) return;
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
  if (visualInput?.source === 'camera') {
    if (permissions.camera !== 'granted') return 'camera_permission';
  } else {
    if (permissions.accessibility !== 'granted')
      return 'accessibility_permission';
    if (permissions.screenRecording !== 'granted')
      return 'screen_recording_permission';
  }
  if (!selfChecks.audioInput) return 'audio_input';
  if (!selfChecks.audioOutput) return 'audio_output';
  if (!selfChecks.globalShortcut) return 'global_shortcut';
  if (visualInput?.source !== 'camera' && !selfChecks.appshot) return 'appshot';
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

function cameraPermission(): PermissionState {
  const status = systemPreferences.getMediaAccessStatus('camera');
  if (status === 'granted') return 'granted';
  if (status === 'denied' || status === 'restricted') return 'denied';
  return 'not_determined';
}

function visualSourceReady(source: VisualSource): boolean {
  return source === 'camera'
    ? permissions.camera === 'granted'
    : permissions.accessibility === 'granted' &&
        permissions.screenRecording === 'granted' &&
        selfChecks.appshot;
}

function applyPendingVisualSourceChange(): boolean {
  const pending = pendingVisualSourceChange;
  if (!pending) return false;
  if (
    pending.generation !== visualSourceChangeGeneration ||
    connection.phase !== 'ready' ||
    live.callId !== pending.callId ||
    daemon.getEpoch() !== pending.epoch ||
    !visualInput ||
    !canChangeLiveVisualInput(live, visualInput, true)
  ) {
    pendingVisualSourceChange = undefined;
    return false;
  }
  if (!visualSourceReady(pending.source)) return false;
  if (pending.sent) return true;
  if (!daemon.sendVisualSettings({ source: pending.source }, pending.epoch)) {
    return false;
  }
  writeLiveDiagnostic('visual_source_changed', {
    epoch: pending.epoch,
    source: pending.source,
  });
  pending.sent = true;
  cancelReadinessReconnect();
  return true;
}

function publicState(): HostPublicState {
  return {
    theme,
    resolvedTheme: resolvedTheme(),
    language,
    connection: connection.phase,
    canOpenConfig:
      connection.phase === 'ready' &&
      !quitState &&
      Boolean(daemon.getConfigFilePath()),
    ...(quitState ? { quitState } : {}),
    overlayOffset: { ...overlayOffset },
    ...(connection.error ? { connectionError: connection.error } : {}),
    ...(visualInput ? { visualInput: { ...visualInput } } : {}),
    ...(connection.memory ? { memory: connection.memory } : {}),
    ...(connection.subagentsV1 ? { subagentsV1: connection.subagentsV1 } : {}),
    live: effectiveLiveStatus(),
    permissions: { ...permissions },
    selfChecks: { ...selfChecks },
    visualReady,
    ...(visualError ? { visualError } : {}),
  };
}

function sameVisualInput(
  left: VisualInput | undefined,
  right: VisualInput | undefined,
): boolean {
  return (
    left?.source === right?.source &&
    left?.mode === right?.mode &&
    left?.fps === right?.fps &&
    left?.cameraWidth === right?.cameraWidth &&
    left?.cameraHeight === right?.cameraHeight &&
    left?.liveWidth === right?.liveWidth &&
    left?.liveHeight === right?.liveHeight &&
    left?.snapshotWidth === right?.snapshotWidth &&
    left?.snapshotHeight === right?.snapshotHeight
  );
}

function publishState(): void {
  subagents?.setTheme(theme, resolvedTheme());
  subagents?.update(
    language,
    connection.phase === 'ready',
    connection.subagentsV1,
    connection.instanceId,
  );
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
  maybeStartStartupInteraction();
}

function maybeStartStartupInteraction(): void {
  if (
    startupInteraction.shouldStart({
      connectionReady: connection.phase === 'ready',
      rendererReady: overlayReady && rendererEventsEnabled,
      hostReady:
        isHostReady() && !audioTransportFailed && quitState === undefined,
      startPending: liveStartPending,
      live: connection.status ?? live,
    })
  )
    toggleLive();
}

function showOverlay(): void {
  if (!overlay || overlay.isDestroyed()) return;
  overlay.showInactive();
}

function persistOverlayPosition(): void {
  if (!desiredOverlayPosition) return;
  try {
    saveOverlayPosition(
      join(app.getPath('userData'), 'overlay-position.json'),
      desiredOverlayPosition,
    );
  } catch (error) {
    writeLiveDiagnostic('overlay_position_save_failed', {
      kind: error instanceof Error ? error.name : 'unknown',
    });
  }
}

function clampOverlayToDisplays(): void {
  subagents?.displaysChanged();
  subagents?.setDragging(false);
  if (!overlay || overlay.isDestroyed()) return;
  if (overlayDrag) persistOverlayPosition();
  overlayDrag = undefined;
  applyOverlayPosition();
  syncPointerInteractivity();
}

function overlayWorkArea(point: OverlayPosition): DisplayWorkArea {
  const orb = OVERLAY_GEOMETRY.orb;
  return screen.getDisplayNearestPoint({
    x: Math.round(point.x + orb.x + orb.width / 2),
    y: Math.round(point.y + orb.y + orb.height / 2),
  }).workArea;
}

function applyOverlayPosition(): void {
  if (!overlay || overlay.isDestroyed() || !desiredOverlayPosition) return;
  const area = overlayWorkArea(desiredOverlayPosition);
  const visible =
    OVERLAY_GEOMETRY.bounds[settingsOpen ? 'setup' : overlayLayout];
  const position = hasCustomOverlayPosition
    ? clampOverlayPosition(desiredOverlayPosition, area, visible)
    : overlayPosition(area, visible);
  positionOverlay(position);
}

function subagentsAnchor(): DisplayWorkArea | undefined {
  if (
    !overlay ||
    overlay.isDestroyed() ||
    overlayLayout === 'setup' ||
    quitState
  )
    return undefined;
  const bounds = overlay.getBounds();
  const visible = OVERLAY_GEOMETRY.bounds[overlayLayout];
  return {
    x: bounds.x + overlayOffset.x + visible.x,
    y: bounds.y + overlayOffset.y + visible.y,
    width: visible.width,
    height: visible.height,
  };
}

function subagentsHoverRegions(): DisplayWorkArea[] {
  if (!subagentsAnchor() || !overlay) return [];
  const bounds = overlay.getBounds();
  return [
    OVERLAY_GEOMETRY.orbMotion,
    OVERLAY_GEOMETRY.toolbar,
    OVERLAY_GEOMETRY.status,
  ].map((region) => ({
    x: bounds.x + overlayOffset.x + region.x,
    y: bounds.y + overlayOffset.y + region.y,
    width: region.width,
    height: region.height,
  }));
}

function positionOverlay(position: OverlayPosition, window = overlay): void {
  if (!window || window.isDestroyed()) return;
  const before = window.getBounds();
  if (position.x !== before.x || position.y !== before.y) {
    window.setPosition(position.x, position.y, false);
  }
  const actual = window.getBounds();
  const offset = { x: position.x - actual.x, y: position.y - actual.y };
  if (offset.x !== overlayOffset.x || offset.y !== overlayOffset.y) {
    overlayOffset = offset;
    if (window === overlay)
      sendRendererCommand('live:overlay-offset', overlayOffset);
  }
}

function setOverlayLayout(layout: OverlayLayout): void {
  if (overlayLayout === layout) return;
  if (overlayDrag) persistOverlayPosition();
  overlayDrag = undefined;
  subagents?.setDragging(false);
  subagents?.dismissPeek();
  overlayLayout = layout;
  if (overlayReady) applyOverlayPosition();
  syncPointerInteractivity();
}

function syncPointerInteractivity(): void {
  if (!overlay || overlay.isDestroyed()) {
    pointerInteractive = false;
    return;
  }
  const interactive =
    pointerOverInteractive || settingsOpen || overlayDrag !== undefined;
  if (pointerInteractive === interactive) return;
  pointerInteractive = interactive;
  overlay.setIgnoreMouseEvents(!interactive, { forward: true });
}

function dragOverlay(
  phase: 'start' | 'move' | 'end',
  x: number,
  y: number,
): void {
  if (!overlay || overlay.isDestroyed()) return;
  if (phase === 'start') {
    subagents?.setDragging(true);
    const bounds = overlay.getBounds();
    overlayDrag = {
      pointer: { x, y },
      origin: { x: bounds.x + overlayOffset.x, y: bounds.y + overlayOffset.y },
    };
  } else if (overlayDrag) {
    const desired = {
      x: Math.round(overlayDrag.origin.x + x - overlayDrag.pointer.x),
      y: Math.round(overlayDrag.origin.y + y - overlayDrag.pointer.y),
    };
    const position = clampOverlayPosition(
      desired,
      overlayWorkArea(desired),
      OVERLAY_GEOMETRY.bounds[settingsOpen ? 'setup' : overlayLayout],
    );
    desiredOverlayPosition = position;
    hasCustomOverlayPosition = true;
    positionOverlay(position);
    if (phase === 'end') {
      overlayDrag = undefined;
      subagents?.setDragging(false);
      persistOverlayPosition();
    }
  }
  syncPointerInteractivity();
}

function dismissSettings(): void {
  if (!settingsOpen) return;
  settingsOpen = false;
  subagents?.setBlocked(false);
  applyOverlayPosition();
  sendRendererCommand('live:settings-dismiss');
  syncPointerInteractivity();
}

function resetOverlayInteraction(preserveSubagents = false): void {
  subagents?.setDragging(false);
  if (!preserveSubagents) subagents?.dismissPeek();
  else subagents?.setOrbHovered(false);
  if (overlayDrag) persistOverlayPosition();
  overlayDrag = undefined;
  pointerOverInteractive = false;
  dismissSettings();
  syncPointerInteractivity();
}

function quitHost(): Promise<void> {
  startupInteraction.cancel();
  if (quitOperation) return quitOperation;
  quitting = true;
  quitState = 'pending';
  deactivateNativeServices();
  publishState();
  writeLiveDiagnostic('host_quit_requested', {
    connected: connection.phase === 'ready',
  });
  quitOperation = (async () => {
    try {
      await daemon?.requestQuit();
    } catch (error) {
      quitting = false;
      quitOperation = undefined;
      quitState = 'failed';
      writeLiveDiagnostic('host_quit_failed', {
        kind: error instanceof Error ? error.name : 'unknown',
      });
      publishState();
      showOverlay();
      throw new Error(liveMessage('ui.quitFailed'));
    }
    resetOverlayInteraction();
    quitApproved = true;
    app.quit();
  })();
  return quitOperation;
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

function cancelReadinessReconnect(): void {
  if (readinessReconnectTimer) clearTimeout(readinessReconnectTimer);
  readinessReconnectTimer = undefined;
}

function sendRendererCommand(channel: string, value?: unknown): void {
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

function syncOutputAudioEndMarkerMode(): void {
  sendRendererCommand(
    'live:audio:set-output-end-marker-mode',
    connection.phase === 'ready' &&
      connection.capabilities?.outputAudioEndMarkerV1 === true,
  );
}

function rejectCameraSnapshots(error: Error): void {
  for (const [requestId, pending] of pendingCameraSnapshots) {
    pendingCameraSnapshots.delete(requestId);
    if (pending.timer) clearTimeout(pending.timer);
    pending.reject(error);
  }
}

function dispatchNextCameraSnapshot(): void {
  if (
    !visualReady ||
    !overlayReady ||
    !overlay ||
    overlay.isDestroyed() ||
    overlay.webContents.isDestroyed() ||
    [...pendingCameraSnapshots.values()].some((pending) => pending.sent)
  ) {
    return;
  }
  for (const [requestId, pending] of pendingCameraSnapshots) {
    if (pending.epoch !== daemon.getEpoch()) {
      pendingCameraSnapshots.delete(requestId);
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(new Error('stale_visual_capture'));
      continue;
    }
    pending.sent = true;
    sendRendererCommand('live:camera:capture-once', {
      requestId,
      ...pending.options,
    });
    return;
  }
}

function stopScreenFeed(): void {
  screenFeedGeneration += 1;
  if (screenFeedTimer) clearInterval(screenFeedTimer);
  screenFeedTimer = undefined;
  screenFeedKey = undefined;
  screenFeedInFlight = false;
}

function resetActiveVisualCapture(): void {
  visualGeneration += 1;
  stopScreenFeed();
  rejectCameraSnapshots(new Error(liveMessage('host.error.visualStopped')));
  visualCallId = undefined;
}

function stopLocalVisual(): void {
  resetActiveVisualCapture();
  visualReady = false;
  visualError = undefined;
  sendRendererCommand('live:camera:set-capture', { enabled: false });
}

function shouldOpenCameraPreview(): boolean {
  return (
    nativeServicesActive &&
    permissions.camera === 'granted' &&
    shouldShowCameraPreview(
      effectiveLiveStatus(),
      visualInput,
      connection.phase === 'ready',
    )
  );
}

function encodeScreenFrame(
  png: Uint8Array,
  maximumWidth: number | undefined,
  maximumHeight: number | undefined,
  liveFeed: boolean,
): { image: string; width: number; height: number } {
  const source = nativeImage.createFromBuffer(Buffer.from(png));
  if (source.isEmpty()) throw new Error('screen_image_decode_failed');
  const sourceSize = source.getSize();
  const { width: baseWidth, height: baseHeight } = fitRealtimeVisualDimensions(
    sourceSize.width,
    sourceSize.height,
    maximumWidth,
    maximumHeight,
  );
  const attempts = liveFeed
    ? SCREEN_LIVE_JPEG_ATTEMPTS
    : SCREEN_SNAPSHOT_JPEG_QUALITIES.map((quality) => ({ scale: 1, quality }));
  for (const attempt of attempts) {
    const width = Math.max(1, Math.round(baseWidth * attempt.scale));
    const height = Math.max(1, Math.round(baseHeight * attempt.scale));
    const image =
      width === sourceSize.width && height === sourceSize.height
        ? source
        : source.resize({ width, height, quality: 'best' });
    const jpeg = image.toJPEG(attempt.quality);
    const encoded = jpeg.toString('base64');
    if (
      jpeg.byteLength <= MAX_INPUT_IMAGE_FRAME_BYTES &&
      isValidInputImageFrame(encoded)
    ) {
      return { image: encoded, width, height };
    }
  }
  throw new Error('screen_frame_too_large');
}

async function captureScreenFeed(generation: number): Promise<void> {
  const settings = visualInput;
  if (
    generation !== screenFeedGeneration ||
    screenFeedInFlight ||
    !settings ||
    settings.source !== 'screen' ||
    settings.mode !== 'live-feed' ||
    visualCallId !== live.callId
  ) {
    return;
  }
  screenFeedInFlight = true;
  try {
    const capture = await appshotCapture.captureFrame();
    if (generation !== screenFeedGeneration) return;
    const frame = encodeScreenFrame(
      capture.screenshot,
      settings.liveWidth,
      settings.liveHeight,
      true,
    );
    const sent = daemon.sendVisualFrame(
      'screen',
      frame.image,
      daemon.getEpoch(),
    );
    const nextError = sent ? undefined : 'screen_transport_rejected';
    const stateChanged = visualReady !== sent || visualError !== nextError;
    visualReady = sent;
    visualError = nextError;
    writeLiveDiagnostic('visual_frame_sent', {
      epoch: daemon.getEpoch(),
      source: 'screen',
      width: frame.width,
      height: frame.height,
      bytes: Buffer.byteLength(frame.image, 'base64'),
      sent,
    });
    if (stateChanged) publishState();
  } catch (error) {
    if (generation !== screenFeedGeneration) return;
    const nextError =
      error instanceof Error ? error.message.slice(0, 128) : 'screen_failed';
    const stateChanged = visualReady || visualError !== nextError;
    visualReady = false;
    visualError = nextError;
    appshotReadiness.refresh();
    writeLiveDiagnostic('visual_capture_error', {
      source: 'screen',
      code: visualError,
    });
    if (stateChanged) publishState();
  } finally {
    if (generation === screenFeedGeneration) screenFeedInFlight = false;
  }
}

function startScreenFeed(settings: VisualInput): void {
  const key = `${daemon.getEpoch()}:${settings.fps}:${settings.liveWidth}x${settings.liveHeight}`;
  if (screenFeedTimer && screenFeedKey === key) return;
  stopScreenFeed();
  screenFeedKey = key;
  visualCallId = live.callId;
  const generation = screenFeedGeneration;
  const capture = () => void captureScreenFeed(generation);
  capture();
  screenFeedTimer = setInterval(capture, Math.round(1000 / settings.fps));
  screenFeedTimer.unref();
}

function syncVisualCapture(): void {
  const settings = visualInput;
  const callActive =
    settings !== undefined &&
    visualCallId === live.callId &&
    shouldCaptureLiveVisual(live, settings) &&
    connection.phase === 'ready';
  if (!settings || connection.phase !== 'ready') {
    stopScreenFeed();
    sendRendererCommand('live:camera:set-capture', { enabled: false });
    visualReady = false;
    return;
  }
  if (settings.source === 'screen') {
    sendRendererCommand('live:camera:set-capture', { enabled: false });
    if (callActive && settings.mode === 'live-feed') startScreenFeed(settings);
    else if (callActive) {
      stopScreenFeed();
      visualReady = selfChecks.appshot;
      visualError = visualReady ? undefined : 'screen_capture_unavailable';
    } else {
      stopScreenFeed();
      visualReady = false;
      visualError = undefined;
    }
    return;
  }
  stopScreenFeed();
  const enabled = shouldOpenCameraPreview();
  sendRendererCommand('live:camera:set-capture', {
    enabled,
    ...(enabled
      ? {
          settings: {
            epoch: daemon.getEpoch(),
            mode: callActive ? settings.mode : 'on-demand',
            fps: settings.fps,
            cameraWidth: settings.cameraWidth ?? 1280,
            cameraHeight: settings.cameraHeight ?? 720,
            liveWidth: settings.liveWidth,
            liveHeight: settings.liveHeight,
          },
        }
      : {}),
  });
  if (!enabled) {
    visualReady = false;
    if (permissions.camera !== 'granted') {
      visualError = 'camera_permission_required';
    }
  }
}

function stopLocalAudio(): void {
  captureReadyEpoch = undefined;
  sendRendererCommand('live:audio:clear');
  sendRendererCommand('live:audio:set-capture', {
    enabled: false,
    muted: true,
    epoch: daemon.getEpoch(),
  });
}

function failRequiredDaemonMessage(messageType: string): void {
  if (audioTransportFailed || quitState !== undefined) return;
  writeLiveDiagnostic('host_action_failed', {
    action: messageType,
    epoch: daemon.getEpoch(),
    connection: connection.phase,
    ...(hostReadinessBlocker() ? { blocker: hostReadinessBlocker() } : {}),
  });
  liveStartPending = false;
  audioTransportFailed = true;
  selfChecks.audioInput = false;
  selfChecks.audioOutput = false;
  stopLocalVisual();
  stopLocalAudio();
  live = {
    ...live,
    available: false,
    state: 'error',
    blocker: 'host_disconnected',
    message: liveMessage('host.error.requiredMessage', { messageType }),
  };
  publishState();
  sendRendererCommand('live:audio:recheck', 'daemon_action_failed');
  daemon.forceReconnectNow();
}

function sendRequiredAction(action: HostAction): boolean {
  let sent = false;
  try {
    sent = daemon.sendAction(action);
  } catch {
    sent = false;
  }
  if (!sent) failRequiredDaemonMessage(action.action);
  return sent;
}

function sendRequiredPlaybackReceipt(
  messageType: 'playback_started' | 'playback_completed',
  send: () => boolean,
): void {
  if (quitState !== undefined) return;
  let sent = false;
  try {
    sent = send();
  } catch {
    sent = false;
  }
  if (!sent) failRequiredDaemonMessage(messageType);
}

function stopLive(): void {
  startupInteraction.cancel();
  liveStartPending = false;
  stopLocalVisual();
  stopLocalAudio();
  showOverlay();
  sendRequiredAction({
    type: 'host.action',
    action: 'stop',
  });
}

function failClosedForReadinessLoss(): void {
  if (isActiveLiveCall(live)) stopLive();
  else {
    stopLocalVisual();
    stopLocalAudio();
  }
}

function failAudioAndRecheck(reason: string): void {
  if (!nativeServicesActive) return;
  audioTransportFailed = true;
  selfChecks.audioInput = false;
  selfChecks.audioOutput = false;
  failClosedForReadinessLoss();
  publishState();
  sendRendererCommand('live:audio:recheck', reason);
  scheduleReadinessReconnect();
}

function applyLiveStatus(status: LiveStatus): void {
  live = status;
  if (shouldCaptureLiveVisual(status, visualInput)) {
    if (visualCallId !== status.callId) {
      stopLocalVisual();
      visualCallId = status.callId;
    }
  } else if (visualCallId !== undefined) {
    resetActiveVisualCapture();
    visualReady = false;
    visualError = undefined;
  }
  syncVisualCapture();
  if (status.state !== 'idle') liveStartPending = false;
  if (nativeServicesActive) {
    const state = shortcut.replace(status.shortcut);
    if (!state.healthy && selfChecks.globalShortcut) {
      selfChecks.globalShortcut = false;
      failClosedForReadinessLoss();
      scheduleReadinessReconnect();
    }
  }
  const blocker = hostReadinessBlocker();
  const captureEnabled =
    !audioTransportFailed &&
    shouldCaptureLiveAudio(
      status,
      nativeServicesActive && blocker === undefined,
    );
  const captureEpoch = daemon.getEpoch();
  if (!captureEnabled || captureReadyEpoch !== captureEpoch) {
    captureReadyEpoch = undefined;
  }
  writeLiveDiagnostic('status_applied', {
    epoch: daemon.getEpoch(),
    state: status.state,
    captureEnabled,
    available: status.available,
    ...(blocker ? { blocker } : {}),
  });
  sendRendererCommand('live:audio:set-capture', {
    enabled: captureEnabled,
    muted: status.inputMuted ?? false,
    epoch: captureEpoch,
  });
  sendRendererCommand(
    'live:audio:set-output-muted',
    status.outputMuted ?? false,
  );
  if (!captureEnabled || status.state === 'stopping') {
    closeHostInputCapture(
      status.state === 'stopping' ? 'call_stopping' : 'capture_disabled',
    );
    sendRendererCommand('live:audio:clear');
  }
  showOverlay();
  publishState();
}

function toggleLive(): void {
  startupInteraction.cancel();
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
  startupInteraction.cancel();
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

function beginMediaPermissionMonitor(): void {
  if (mediaPermissionTimer) return;
  mediaPermissionTimer = setInterval(() => {
    if (!nativeServicesActive) return;
    const nextMicrophone = microphonePermission();
    const nextCamera = cameraPermission();
    if (
      visualInput?.source === 'screen' ||
      pendingVisualSourceChange?.source === 'screen'
    ) {
      appshotReadiness.refresh();
    }
    const microphoneChanged = nextMicrophone !== permissions.microphone;
    const cameraChanged = nextCamera !== permissions.camera;
    if (!microphoneChanged && !cameraChanged) return;
    if (microphoneChanged) {
      permissions.microphone = nextMicrophone;
      selfChecks.audioInput = false;
      if (nextMicrophone !== 'granted') {
        failClosedForReadinessLoss();
      } else {
        sendRendererCommand('live:audio:initialize', true);
      }
      scheduleReadinessReconnect();
    }
    if (cameraChanged) {
      permissions.camera = nextCamera;
      if (visualInput?.source === 'camera') {
        if (nextCamera !== 'granted') {
          failClosedForReadinessLoss();
        } else {
          syncVisualCapture();
        }
        scheduleReadinessReconnect();
      }
    }
    if (pendingVisualSourceChange?.source === 'camera') {
      applyPendingVisualSourceChange();
    }
    publishState();
  }, 2_000);
  mediaPermissionTimer.unref();
}

function activateNativeServices(): void {
  if (nativeServicesActive || quitState !== undefined) return;
  nativeServiceGeneration += 1;
  nativeServicesActive = true;
  audioTransportFailed = false;
  captureReadyEpoch = undefined;
  liveStartPending = false;
  permissions.microphone = microphonePermission();
  permissions.camera = cameraPermission();
  permissions.accessibility = 'not_determined';
  permissions.screenRecording = 'not_determined';
  selfChecks.audioInput = false;
  selfChecks.audioOutput = false;
  selfChecks.globalShortcut = false;
  selfChecks.appshot = false;
  appshotReadiness.start();
  beginMediaPermissionMonitor();
  sendRendererCommand(
    'live:audio:initialize',
    permissions.microphone === 'granted',
  );
}

function deactivateNativeServices(): void {
  resetOverlayInteraction();
  nativeServiceGeneration += 1;
  nativeServicesActive = false;
  pendingVisualSourceChange = undefined;
  visualSourceChangeGeneration += 1;
  audioTransportFailed = false;
  captureReadyEpoch = undefined;
  liveStartPending = false;
  stopLocalVisual();
  closeHostAudioCapture('native_services_stopped');
  closeHostInputCapture('native_services_stopped');
  if (readinessReconnectTimer) clearTimeout(readinessReconnectTimer);
  readinessReconnectTimer = undefined;
  if (mediaPermissionTimer) clearInterval(mediaPermissionTimer);
  mediaPermissionTimer = undefined;
  shortcut?.stop();
  appshotReadiness?.stop();
  sendRendererCommand('live:camera:deactivate');
  sendRendererCommand('live:audio:deactivate');
  permissions.microphone = 'not_determined';
  permissions.accessibility = 'not_determined';
  permissions.screenRecording = 'not_determined';
  permissions.camera = 'not_determined';
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

async function requestCameraPermission(
  reconnectAfterChange = true,
): Promise<boolean> {
  if (!nativeServicesActive || quitState !== undefined) return false;
  const generation = nativeServiceGeneration;
  let granted = false;
  try {
    granted = await systemPreferences.askForMediaAccess('camera');
  } catch (error) {
    writeLiveDiagnostic('camera_permission_error', {
      message: error instanceof Error ? error.message.slice(0, 256) : 'unknown',
    });
  }
  if (
    generation !== nativeServiceGeneration ||
    !nativeServicesActive ||
    quitState !== undefined
  )
    return false;
  permissions.camera = granted ? 'granted' : cameraPermission();
  writeLiveDiagnostic('camera_permission_result', {
    permission: permissions.camera,
  });
  if (!granted) {
    if (visualInput?.source === 'camera') failClosedForReadinessLoss();
    void shell.openExternal(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_Camera',
    );
  }
  publishState();
  if (reconnectAfterChange) scheduleReadinessReconnect();
  return granted;
}

function requestCameraSnapshot(
  epoch: number,
  options: CameraSnapshotOptions,
): Promise<CameraSnapshot> {
  if (
    !overlayReady ||
    !overlay ||
    overlay.isDestroyed() ||
    overlay.webContents.isDestroyed()
  ) {
    return Promise.reject(new Error('camera_renderer_unavailable'));
  }
  const requestId = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const pending = pendingCameraSnapshots.get(requestId);
      if (!pending) return;
      pendingCameraSnapshots.delete(requestId);
      pending.reject(new Error('camera_snapshot_timeout'));
      dispatchNextCameraSnapshot();
    }, VISUAL_SNAPSHOT_TIMEOUT_MS);
    timer.unref();
    pendingCameraSnapshots.set(requestId, {
      epoch,
      timer,
      sent: false,
      options,
      resolve,
      reject,
    });
    dispatchNextCameraSnapshot();
  });
}

async function captureOnDemandVisual(request: {
  source: VisualSource;
  snapshotWidth?: number;
  snapshotHeight?: number;
  persistAsset?: boolean;
}): Promise<{
  source: VisualSource;
  image: string;
  width: number;
  height: number;
  appName?: string;
  windowTitle?: string;
  accessibilityText?: string;
  screenshotPath?: string;
}> {
  const epoch = daemon.getEpoch();
  const generation = visualGeneration;
  if (request.source === 'screen') appshotReadiness.refresh();
  const configuredRequestIsCurrent =
    visualInput?.mode === 'on-demand' &&
    visualInput.source === request.source &&
    shouldCaptureLiveVisual(live, visualInput);
  const builtInScreenRequestIsCurrent =
    visualInput === undefined &&
    request.source === 'screen' &&
    isActiveLiveCall(live) &&
    isHostReady();
  if (!configuredRequestIsCurrent && !builtInScreenRequestIsCurrent) {
    throw new Error('visual_settings_changed');
  }
  if (request.source === 'camera') {
    if (permissions.camera !== 'granted') {
      throw new Error('camera_permission_required');
    }
    const frame = await requestCameraSnapshot(epoch, {
      snapshotWidth: request.snapshotWidth,
      snapshotHeight: request.snapshotHeight,
      persistAsset: request.persistAsset,
    });
    if (epoch !== daemon.getEpoch() || generation !== visualGeneration) {
      throw new Error('stale_visual_capture');
    }
    let screenshotPath: string | undefined;
    if (request.persistAsset !== false) {
      if (!frame.assetImage) throw new Error('camera_snapshot_asset_missing');
      screenshotPath = await appshotCapture.storeJpeg(
        Buffer.from(frame.assetImage, 'base64'),
      );
    }
    if (epoch !== daemon.getEpoch() || generation !== visualGeneration) {
      throw new Error('stale_visual_capture');
    }
    return {
      source: 'camera',
      image: frame.image,
      width: frame.width,
      height: frame.height,
      ...(screenshotPath ? { screenshotPath } : {}),
    };
  }

  if (!selfChecks.appshot) throw new Error('screen_capture_unavailable');
  const capture = await appshotCapture.captureFrame();
  if (epoch !== daemon.getEpoch() || generation !== visualGeneration) {
    throw new Error('stale_visual_capture');
  }
  const frame = encodeScreenFrame(
    capture.screenshot,
    request.snapshotWidth,
    request.snapshotHeight,
    false,
  );
  const screenshotPath =
    request.persistAsset === false
      ? undefined
      : await appshotCapture.storePng(capture.screenshot);
  if (epoch !== daemon.getEpoch() || generation !== visualGeneration) {
    throw new Error('stale_visual_capture');
  }
  return {
    source: 'screen',
    ...frame,
    appName: capture.appName,
    ...(capture.windowTitle ? { windowTitle: capture.windowTitle } : {}),
    accessibilityText: capture.accessibilityText,
    ...(screenshotPath ? { screenshotPath } : {}),
  };
}

function registerIpc(): void {
  ipcMain.handle('live:open-config', async (event) => {
    if (
      !isTrustedSender(event) ||
      !rendererEventsEnabled ||
      connection.phase !== 'ready' ||
      quitState
    )
      throw new Error(liveMessage('host.config.unavailable'));
    const configPath = daemon.getConfigFilePath();
    if (!configPath) throw new Error(liveMessage('host.config.unavailable'));
    try {
      if (!lstatSync(configPath).isFile()) throw new Error();
    } catch {
      throw new Error(liveMessage('host.config.inaccessible'));
    }
    try {
      const error = await shell.openPath(configPath);
      if (error) throw new Error();
    } catch {
      throw new Error(liveMessage('host.config.openFailed'));
    }
  });
  ipcMain.on('live:subagents:orb-keyboard', (event, held: unknown) => {
    if (
      isTrustedSender(event) &&
      rendererEventsEnabled &&
      typeof held === 'boolean'
    )
      subagents?.setOrbKeyboardHeld(held);
  });
  ipcMain.handle('live:set-theme', (event, value: unknown) => {
    if (
      !isTrustedSender(event) ||
      !rendererEventsEnabled ||
      !isLiveTheme(value)
    )
      throw new Error(liveMessage('host.theme.invalid'));
    if (quitState) throw new Error(liveMessage('host.theme.unavailable'));
    try {
      saveHostTheme(join(app.getPath('userData'), 'theme.json'), value);
    } catch {
      throw new Error(liveMessage('host.theme.saveFailed'));
    }
    theme = value;
    nativeTheme.themeSource = value;
    publishState();
  });
  ipcMain.on('live:subagents:orb-hover', (event, hovered: unknown) => {
    if (
      !isTrustedSender(event) ||
      !rendererEventsEnabled ||
      typeof hovered !== 'boolean'
    )
      return;
    subagents?.setOrbHovered(hovered);
  });
  ipcMain.handle('live:set-language', async (event, value: unknown) => {
    if (
      !isTrustedSender(event) ||
      !rendererEventsEnabled ||
      !isLiveLanguage(value)
    )
      throw new Error(liveMessage('host.language.invalid'));
    if (quitState) throw new Error(liveMessage('host.language.unavailable'));
    if (connection.phase === 'ready' && connection.uiLanguageV1) {
      await daemon.requestLanguage(value);
      return;
    }
    try {
      saveHostLanguage(join(app.getPath('userData'), 'language.json'), value);
    } catch {
      throw new Error(liveMessage('host.language.saveFailed'));
    }
    language = value;
    publishState();
  });
  ipcMain.on('live:overlay-layout', (event, layout: unknown) => {
    if (
      !isTrustedSender(event) ||
      (layout !== 'setup' && layout !== 'orb' && layout !== 'orb-preview')
    )
      return;
    setOverlayLayout(layout);
  });
  ipcMain.handle('live:quit', (event) => {
    if (!isTrustedSender(event))
      throw new Error(liveMessage('host.error.untrustedQuit'));
    return quitHost();
  });
  ipcMain.on(
    'live:drag-overlay',
    (event, phase: unknown, x: unknown, y: unknown) => {
      if (
        !isTrustedSender(event) ||
        !rendererEventsEnabled ||
        (phase !== 'start' && phase !== 'move' && phase !== 'end') ||
        !isOverlayPosition({ x, y })
      )
        return;
      dragOverlay(phase, x as number, y as number);
    },
  );
  ipcMain.handle('live:settings-open', (event, open: unknown) => {
    if (
      !isTrustedSender(event) ||
      !rendererEventsEnabled ||
      typeof open !== 'boolean'
    ) {
      throw new Error(liveMessage('host.settings.unavailable'));
    }
    if (settingsOpen === open) return;
    settingsOpen = open;
    subagents?.setBlocked(open);
    applyOverlayPosition();
    syncPointerInteractivity();
  });
  ipcMain.handle('live:memory-action', (event, value: unknown) => {
    if (!isTrustedSender(event))
      throw new Error(liveMessage('host.error.untrustedMemory'));
    const action = parseMemoryAction(value);
    if (!action) throw new Error(liveMessage('host.error.memoryInvalid'));
    return daemon.requestMemoryAction(action);
  });
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
    sendRendererCommand('live:audio:set-capture', {
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
  ipcMain.on('live:audio:playback-started', (event, value: unknown) => {
    if (
      !isTrustedSender(event) ||
      !rendererEventsEnabled ||
      typeof value !== 'object' ||
      value === null ||
      !('epoch' in value) ||
      !('outputId' in value) ||
      typeof value.epoch !== 'number' ||
      !Number.isSafeInteger(value.epoch) ||
      value.epoch !== daemon.getEpoch() ||
      typeof value.outputId !== 'number' ||
      !Number.isSafeInteger(value.outputId) ||
      value.outputId < 0
    ) {
      return;
    }
    const epoch = value.epoch;
    const outputId = value.outputId;
    sendRequiredPlaybackReceipt('playback_started', () =>
      daemon.sendPlaybackStarted(epoch, outputId),
    );
  });

  ipcMain.on('live:audio:playback-completed', (event, value: unknown) => {
    if (
      !isTrustedSender(event) ||
      !rendererEventsEnabled ||
      typeof value !== 'object' ||
      value === null ||
      !('epoch' in value) ||
      !('outputId' in value) ||
      typeof value.epoch !== 'number' ||
      !Number.isSafeInteger(value.epoch) ||
      value.epoch !== daemon.getEpoch() ||
      typeof value.outputId !== 'number' ||
      !Number.isSafeInteger(value.outputId) ||
      value.outputId < 0
    ) {
      return;
    }
    const epoch = value.epoch;
    const outputId = value.outputId;
    sendRequiredPlaybackReceipt('playback_completed', () =>
      daemon.sendPlaybackCompleted(epoch, outputId),
    );
  });

  ipcMain.handle('live:set-output-muted', (event, muted: unknown) => {
    if (!isTrustedSender(event) || typeof muted !== 'boolean') return;
    const inputMuted = live.inputMuted ?? false;
    live = { ...live, outputMuted: muted };
    sendRendererCommand('live:audio:set-output-muted', muted);
    sendRequiredAction({
      type: 'host.action',
      action: 'mute',
      inputMuted,
      outputMuted: muted,
      epoch: daemon.getEpoch(),
    });
    publishState();
  });
  ipcMain.handle('live:set-visual-source', async (event, value: unknown) => {
    if (
      !isTrustedSender(event) ||
      quitState !== undefined ||
      (value !== 'screen' && value !== 'camera') ||
      !visualInput ||
      !canChangeLiveVisualInput(live, visualInput, connection.phase === 'ready')
    ) {
      return;
    }
    const source = value as VisualSource;
    if (
      !shouldRequestVisualSourceChange(
        visualInput.source,
        source,
        pendingVisualSourceChange?.source,
      )
    ) {
      return;
    }
    const pending = {
      source,
      generation: ++visualSourceChangeGeneration,
      ...(live.callId ? { callId: live.callId } : {}),
      epoch: daemon.getEpoch(),
      sent: false,
    };
    pendingVisualSourceChange = pending;
    writeLiveDiagnostic('visual_source_requested', {
      epoch: pending.epoch,
      source,
      waitingForPermission: !visualSourceReady(source),
    });
    if (
      source === 'camera' &&
      permissions.camera !== 'granted' &&
      !(await requestCameraPermission(false))
    ) {
      return;
    }
    if (source === 'screen') {
      appshotReadiness.refresh();
      if (permissions.accessibility !== 'granted') {
        appshotReadiness.requestPermission('accessibility');
      }
      if (permissions.screenRecording !== 'granted') {
        appshotReadiness.requestPermission('screenRecording');
      }
    }
    if (
      pending.generation !== visualSourceChangeGeneration ||
      !isTrustedSender(event) ||
      live.callId !== pending.callId ||
      daemon.getEpoch() !== pending.epoch
    ) {
      return;
    }
    applyPendingVisualSourceChange();
  });
  ipcMain.handle('live:set-visual-mode', (event, value: unknown) => {
    if (
      !isTrustedSender(event) ||
      (value !== 'on-demand' && value !== 'live-feed') ||
      !visualInput ||
      !canChangeLiveVisualInput(live, visualInput, connection.phase === 'ready')
    ) {
      return;
    }
    const mode = value as VisualMode;
    const epoch = daemon.getEpoch();
    if (!daemon.sendVisualSettings({ mode }, epoch)) return;
  });
  ipcMain.handle(
    'live:request-permission',
    async (event, permission: unknown) => {
      if (
        !isTrustedSender(event) ||
        !nativeServicesActive ||
        quitState !== undefined ||
        typeof permission !== 'string'
      ) {
        return;
      }
      if (permission === 'microphone') {
        const generation = nativeServiceGeneration;
        const granted = await systemPreferences.askForMediaAccess('microphone');
        if (
          generation !== nativeServiceGeneration ||
          !nativeServicesActive ||
          quitState !== undefined ||
          !isTrustedSender(event)
        )
          return;
        permissions.microphone = granted ? 'granted' : microphonePermission();
        selfChecks.audioInput = false;
        failClosedForReadinessLoss();
        sendRendererCommand('live:audio:initialize', granted);
        if (!granted) {
          void shell.openExternal(
            'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
          );
        }
        publishState();
        scheduleReadinessReconnect();
        return;
      }
      if (permission === 'camera') {
        await requestCameraPermission();
        return;
      }
      if (permission === 'accessibility' || permission === 'screenRecording') {
        appshotReadiness.requestPermission(permission);
      }
    },
  );
  ipcMain.handle('live:get-state', (event) => {
    if (!isTrustedSender(event))
      throw new Error(liveMessage('host.error.untrusted'));
    return publicState();
  });

  ipcMain.on('live:audio:input', (event, value: unknown) => {
    if (
      !isTrustedSender(event) ||
      !nativeServicesActive ||
      !rendererEventsEnabled ||
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
  ipcMain.on('live:camera:frame', (event, value: unknown) => {
    if (
      !isTrustedSender(event) ||
      !nativeServicesActive ||
      !rendererEventsEnabled ||
      visualInput?.source !== 'camera' ||
      visualInput.mode !== 'live-feed' ||
      !shouldCaptureLiveVisual(live, visualInput) ||
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
      record.epoch !== daemon.getEpoch() ||
      typeof record.image !== 'string' ||
      !isValidInputImageFrame(record.image)
    ) {
      return;
    }
    const sent = daemon.sendVisualFrame('camera', record.image, record.epoch);
    const nextError = sent ? undefined : 'camera_transport_rejected';
    const stateChanged = visualReady !== sent || visualError !== nextError;
    visualReady = sent;
    visualError = nextError;
    writeLiveDiagnostic('visual_frame_sent', {
      epoch: record.epoch,
      source: 'camera',
      bytes: Buffer.byteLength(record.image, 'base64'),
      sent,
    });
    if (stateChanged) publishState();
  });
  ipcMain.on('live:camera:ready', (event, epoch: unknown) => {
    if (
      !isTrustedSender(event) ||
      !rendererEventsEnabled ||
      visualInput?.source !== 'camera' ||
      typeof epoch !== 'number' ||
      !Number.isSafeInteger(epoch) ||
      epoch !== daemon.getEpoch() ||
      !shouldOpenCameraPreview()
    ) {
      return;
    }
    visualReady = true;
    visualError = undefined;
    publishState();
    dispatchNextCameraSnapshot();
  });
  ipcMain.on('live:camera:snapshot-result', (event, value: unknown) => {
    if (
      !isTrustedSender(event) ||
      !rendererEventsEnabled ||
      typeof value !== 'object' ||
      value === null ||
      Array.isArray(value)
    ) {
      return;
    }
    const record = value as Record<string, unknown>;
    const requestId = record.requestId;
    if (typeof requestId !== 'string') return;
    const pending = pendingCameraSnapshots.get(requestId);
    if (!pending) return;
    pendingCameraSnapshots.delete(requestId);
    if (pending.timer) clearTimeout(pending.timer);
    if (
      record.success === true &&
      typeof record.image === 'string' &&
      isValidInputImageFrame(record.image) &&
      typeof record.width === 'number' &&
      Number.isSafeInteger(record.width) &&
      record.width > 0 &&
      typeof record.height === 'number' &&
      Number.isSafeInteger(record.height) &&
      record.height > 0 &&
      (pending.options.persistAsset === false ||
        (typeof record.assetImage === 'string' &&
          isValidCameraSnapshotAsset(record.assetImage))) &&
      pending.epoch === daemon.getEpoch()
    ) {
      pending.resolve({
        epoch: pending.epoch,
        image: record.image,
        width: record.width,
        height: record.height,
        ...(pending.options.persistAsset !== false
          ? { assetImage: record.assetImage as string }
          : {}),
      });
      dispatchNextCameraSnapshot();
      return;
    }
    const code =
      typeof record.error === 'string'
        ? record.error.slice(0, 128)
        : 'camera_snapshot_failed';
    pending.reject(new Error(code));
    dispatchNextCameraSnapshot();
  });
  ipcMain.on('live:camera:capture-error', (event, value: unknown) => {
    if (
      !isTrustedSender(event) ||
      !nativeServicesActive ||
      !rendererEventsEnabled
    )
      return;
    const code =
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      typeof (value as Record<string, unknown>).code === 'string'
        ? String((value as Record<string, unknown>).code).slice(0, 128)
        : 'camera_unavailable';
    writeLiveDiagnostic('camera_capture_error', { code });
    permissions.camera = cameraPermission();
    rejectCameraSnapshots(new Error(code));
    if (visualInput?.source === 'camera') {
      failClosedForReadinessLoss();
    }
    visualReady = false;
    visualError = code;
    sendRendererCommand('live:camera:set-capture', { enabled: false });
    showOverlay();
    publishState();
  });
  ipcMain.on('live:camera:diagnostic', (event, value: unknown) => {
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
      !rendererEventsEnabled ||
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
      !rendererEventsEnabled ||
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
    if (isTrustedSender(event) && rendererEventsEnabled) {
      failAudioAndRecheck('audio_capture_error');
    }
  });
  ipcMain.on('live:audio:output-error', (event) => {
    if (isTrustedSender(event) && rendererEventsEnabled) {
      failAudioAndRecheck('audio_output_error');
    }
  });
  ipcMain.on('live:pointer-interactivity', (event, interactive: unknown) => {
    if (
      !isTrustedSender(event) ||
      !rendererEventsEnabled ||
      typeof interactive !== 'boolean'
    )
      return;
    pointerOverInteractive = interactive;
    syncPointerInteractivity();
  });
}

function createOverlay(): BrowserWindow {
  if (!desiredOverlayPosition) {
    const saved = readOverlayPosition(
      join(app.getPath('userData'), 'overlay-position.json'),
    );
    hasCustomOverlayPosition = saved !== undefined;
    desiredOverlayPosition =
      saved ??
      overlayPosition(
        screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea,
        OVERLAY_GEOMETRY.bounds.orb,
      );
  }
  const area = overlayWorkArea(desiredOverlayPosition);
  const position = hasCustomOverlayPosition
    ? clampOverlayPosition(
        desiredOverlayPosition,
        area,
        OVERLAY_GEOMETRY.bounds.setup,
      )
    : overlayPosition(area, OVERLAY_GEOMETRY.bounds.setup);
  overlayLayout = 'setup';
  overlayReady = false;
  rendererEventsEnabled = false;
  settingsOpen = false;
  overlayDrag = undefined;
  pointerInteractive = false;
  pointerOverInteractive = false;
  const window = new BrowserWindow({
    ...position,
    width: OVERLAY_WIDTH,
    height: OVERLAY_HEIGHT,
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
      ...(diagnosticsEnabled
        ? { additionalArguments: ['--qwen-live-debug'] }
        : {}),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
    },
  });
  positionOverlay(position, window);
  window.setAlwaysOnTop(true, 'floating');
  window.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    skipTransformProcessType: true,
  });
  window.setIgnoreMouseEvents(true, { forward: true });
  window.on('blur', () => {
    if (window === overlay) resetOverlayInteraction(true);
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  let rendererLoadHealthy = true;
  window.webContents.on('did-start-loading', () => {
    rendererLoadHealthy = true;
    if (window === overlay) {
      overlayReady = false;
      rendererEventsEnabled = false;
      resetOverlayInteraction();
    }
  });
  const handleFailure = (reason: OverlayFailureReason): void => {
    if (window !== overlay || quitting) return;
    rendererLoadHealthy = false;
    overlayRecovery.handleFailure(reason);
  };
  window.webContents.on('render-process-gone', (_event, details) => {
    writeLiveDiagnostic('renderer_process_gone', {
      reason: details.reason,
      exitCode: details.exitCode,
    });
    handleFailure('renderer_process_gone');
  });
  window.webContents.on('unresponsive', () => {
    handleFailure('renderer_unresponsive');
  });
  window.webContents.on('preload-error', (_event, _path, error) => {
    writeLiveDiagnostic('preload_failed', { kind: error.name });
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
    rendererEventsEnabled = true;
    applyOverlayPosition();
    overlayReady = true;
    sendRendererCommand('live:overlay-offset', overlayOffset);
    syncOutputAudioEndMarkerMode();
    if (nativeServicesActive) {
      sendRendererCommand(
        'live:audio:initialize',
        permissions.microphone === 'granted',
      );
      syncVisualCapture();
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
      { label: liveText(language, 'tray.show'), click: showOverlay },
      {
        label: liveText(language, 'tray.start'),
        enabled: effectiveLive.available && !isActiveLiveCall(live),
        click: toggleLive,
      },
      {
        label: liveText(language, 'tray.new'),
        enabled: effectiveLive.available,
        click: newConversation,
      },
      {
        label: liveText(language, 'tray.stop'),
        enabled: isActiveLiveCall(live),
        click: stopLive,
      },
      { type: 'separator' },
      {
        label: liveText(language, 'tray.quit'),
        click: () => {
          void quitHost().catch(() => undefined);
        },
      },
    ]),
  );
  const stateLabels: Record<LiveStatus['state'], LiveMessageKey> = {
    idle: 'ui.ready',
    starting: 'ui.starting',
    listening: 'ui.listening',
    thinking: 'ui.thinking',
    speaking: 'ui.speaking',
    stopping: 'ui.stopping',
    error: 'ui.callEnded',
    unavailable: 'ui.unavailable',
  };
  tray.setToolTip(
    liveText(language, 'tray.tooltip', {
      state: liveText(language, stateLabels[effectiveLive.state]),
    }),
  );
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
app.on('before-quit', (event) => {
  if (!quitApproved) {
    event.preventDefault();
    void quitHost().catch(() => undefined);
    return;
  }
  quitting = true;
  writeLiveDiagnostic('host_before_quit');
  overlayRecovery?.stop();
  deactivateNativeServices();
  daemon?.stop();
  appshotCapture?.dispose();
  subagents?.dispose();
});

void app.whenReady().then(() => {
  theme = readHostTheme(join(app.getPath('userData'), 'theme.json'));
  nativeTheme.themeSource = theme;
  nativeTheme.on('updated', () => {
    if (!quitApproved) publishState();
  });
  language = readHostLanguage(join(app.getPath('userData'), 'language.json'));
  writeLiveDiagnostic('host_started', {
    pid: process.pid,
    parentPid: process.ppid,
    version: app.getVersion(),
  });
  app.setActivationPolicy('accessory');
  registerIpc();
  overlayRecovery = new OverlayRecoveryController((reason) => {
    rendererEventsEnabled = false;
    resetOverlayInteraction();
    failAudioAndRecheck(reason);
    overlayReady = false;
  }, recoverOverlay);
  overlay = createOverlay();
  subagents = new SubagentsWindows({
    baseDirectory: __dirname,
    anchor: subagentsAnchor,
    hoverRegions: subagentsHoverRegions,
  });
  screen.on('display-added', clampOverlayToDisplays);
  screen.on('display-removed', clampOverlayToDisplays);
  screen.on('display-metrics-changed', clampOverlayToDisplays);
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
    if (pendingVisualSourceChange?.source === 'screen') {
      applyPendingVisualSourceChange();
    }
    if (
      visualInput?.source !== 'camera' &&
      (state.accessibility !== 'granted' ||
        state.screenRecording !== 'granted' ||
        !state.appshot)
    ) {
      failClosedForReadinessLoss();
    }
    publishState();
    if (changed && visualInput?.source !== 'camera') {
      scheduleReadinessReconnect();
    }
  });
  appshotCapture = new AppshotCaptureService();

  daemon = new LiveDaemonConnection(app.getVersion(), {
    onSubagents: (snapshot) => {
      connection = { ...connection, subagentsV1: snapshot };
      subagents?.update(
        language,
        connection.phase === 'ready',
        snapshot,
        connection.instanceId,
      );
    },
    getReadiness: () => ({
      permissions: { ...permissions },
      selfChecks: { ...selfChecks },
    }),
    onSnapshot: (snapshot) => {
      writeLiveDiagnostic('daemon_connection', {
        phase: snapshot.phase,
        ...(snapshot.error ? { error: snapshot.error } : {}),
        ...(snapshot.visualInput
          ? {
              visualSource: snapshot.visualInput.source,
              visualMode: snapshot.visualInput.mode,
            }
          : {}),
      });
      connection = snapshot;
      if (
        snapshot.phase === 'ready' &&
        snapshot.uiLanguageV1 &&
        language !== snapshot.uiLanguageV1.language
      ) {
        language = snapshot.uiLanguageV1.language;
        try {
          saveHostLanguage(
            join(app.getPath('userData'), 'language.json'),
            language,
          );
        } catch {
          writeLiveDiagnostic('language_cache_save_failed');
        }
      }
      syncOutputAudioEndMarkerMode();
      if (snapshot.phase === 'ready') {
        if (!sameVisualInput(visualInput, snapshot.visualInput)) {
          stopLocalVisual();
        }
        visualInput = snapshot.visualInput;
        if (
          pendingVisualSourceChange &&
          snapshot.visualInput?.source === pendingVisualSourceChange.source
        ) {
          pendingVisualSourceChange = undefined;
        }
      }
      if (snapshot.phase !== 'ready') {
        resetOverlayInteraction();
        pendingVisualSourceChange = undefined;
        stopLocalVisual();
      }
      if (shouldActivateNativeServices(snapshot.phase)) {
        activateNativeServices();
      }
      if (shouldDeactivateNativeServices(snapshot.phase)) {
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
    onOutputAudio: ({ audio, epoch, outputId }) => {
      if (
        nativeServicesActive &&
        !live.outputMuted &&
        epoch === daemon.getEpoch()
      ) {
        appendHostAudio(audio, epoch);
        writeLiveDiagnostic('output_frame_received', {
          epoch,
          outputId,
          bytes: audio.byteLength,
        });
        sendRendererCommand('live:audio:play', { audio, epoch, outputId });
      }
    },
    onOutputAudioFinished: ({ epoch, outputId }) => {
      if (
        !nativeServicesActive ||
        !isActiveLiveCall(live) ||
        live.outputMuted ||
        epoch !== daemon.getEpoch()
      ) {
        return;
      }
      writeLiveDiagnostic('output_audio_finished_received', {
        epoch,
        outputId,
      });
      sendRendererCommand('live:audio:output-finished', { epoch, outputId });
    },
    onClearOutput: () => {
      closeHostAudioCapture('clear_output');
      writeLiveDiagnostic('clear_output_received', {
        epoch: daemon.getEpoch(),
      });
      sendRendererCommand('live:audio:clear');
    },
    setShortcut: (accelerator) => {
      if (!nativeServicesActive) {
        return {
          success: false,
          error: liveMessage('host.error.notReady'),
        };
      }
      const state = shortcut.replace(accelerator);
      return {
        success: state.healthy,
        ...(state.error ? { error: state.error } : {}),
      };
    },
    captureVisual: captureOnDemandVisual,
  });

  daemon.start();
});

app.on('activate', () => {
  if (!quitting) {
    appshotReadiness?.refresh();
    showOverlay();
  }
});
