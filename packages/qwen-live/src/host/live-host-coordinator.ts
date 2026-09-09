/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID, timingSafeEqual } from 'node:crypto';
import { WebSocket, type RawData } from 'ws';
import {
  LIVE_HOST_BUNDLE_ID,
  LIVE_HOST_PROTOCOL_VERSION,
  LIVE_INPUT_AUDIO_EPOCH_BYTES,
  LIVE_OUTPUT_AUDIO_EPOCH_BYTES,
  LIVE_OUTPUT_AUDIO_HEADER_BYTES,
  type LiveAppshotReadiness,
  type LiveDaemonMessage,
  type LiveHostAction,
  type LiveHostHello,
  type LiveHostShortcutResult,
  type LiveHostPlaybackStarted,
  type LiveHostPlaybackCompleted,
  type LiveHostVisualCaptureResult,
  type LiveHostVisualFrame,
  type LiveHostVisualSettings,
  type LiveHostStatus,
  type LiveHostMessage,
  type LiveHostMemoryAction,
  type LiveHostLanguageAction,
  type LiveLanguageResult,
  type LiveLanguageState,
  type LiveMemoryAction,
  type LiveMemoryResult,
  type LiveMemoryState,
  type LiveMuteUpdate,
  type LivePermissionState,
  type LiveProviderReadiness,
  type LiveSessionLocator,
  type LiveState,
  type LiveStatus,
  type LiveVisualInput,
  type LiveVisualSource,
} from './types.js';
import { LiveLogger } from '../logger.js';
import type { SubagentsSnapshot } from '../subagents/types.js';
import {
  isLiveLanguage,
  liveMessage,
  liveText,
  type LiveMessageKey,
} from '../i18n/messages.js';

const DEFAULT_HELLO_TIMEOUT_MS = 5_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 15_000;
const DEFAULT_SHORTCUT_TIMEOUT_MS = 5_000;
// The frame cap must admit every message the per-field caps below allow. The
// Visual capture results combine a bounded JPEG with Appshot metadata.
const MAX_HOST_TEXT_BYTES = 512 * 1024;
const MAX_HOST_AUDIO_BYTES = 64 * 1024;
const MAX_HOST_VISUAL_IMAGE_BYTES = 190 * 1024;
const MAX_HOST_VISUAL_BASE64_LENGTH =
  Math.ceil(MAX_HOST_VISUAL_IMAGE_BYTES / 3) * 4;
const MAX_HOST_AUDIO_WIRE_BYTES =
  LIVE_INPUT_AUDIO_EPOCH_BYTES + MAX_HOST_AUDIO_BYTES;
const MAX_DAEMON_AUDIO_BYTES = 256 * 1024;
const MAX_SOCKET_BUFFERED_BYTES = 1024 * 1024;
const MAX_ID_LENGTH = 128;
const MAX_VERSION_LENGTH = 128;
const MAX_TRANSCRIPT_LENGTH = 8_192;
const MAX_STATUS_TEXT_LENGTH = 512;
const DEFAULT_SHORTCUT = 'Command+E';
const MAX_SHORTCUT_LENGTH = 128;
const MAX_APPSHOT_TEXT_LENGTH = 32_000;
const DEFAULT_VISUAL_CAPTURE_TIMEOUT_MS = 15_000;
const DEFAULT_VISUAL_INPUT: LiveVisualInput = {
  source: 'screen',
  mode: 'on-demand',
  fps: 1,
  liveWidth: 1280,
  liveHeight: 720,
};

interface LiveCall {
  epoch: number;
  callId: string;
  mode: 'resume' | 'new';
  state: Exclude<LiveState, 'unavailable' | 'idle'>;
  transcript?: string;
  caption?: string;
  statusText?: string;
  coordinator?: LiveSessionLocator;
  pendingPermission: boolean;
  workers: LiveSessionLocator[];
}

type StandaloneDaemonMessage =
  | (LiveDaemonMessage & { subagentsV1?: SubagentsSnapshot })
  | { type: 'host.subagents'; subagentsV1: SubagentsSnapshot };
type StandaloneHostHello = LiveHostHello & { subagentsV1?: true };

interface HostLease {
  socket: WebSocket;
  hello?: StandaloneHostHello;
  helloTimer: NodeJS.Timeout;
  heartbeatTimer?: NodeJS.Timeout;
  lastPongAt: number;
  pingId?: string;
  memoryPending?: Set<string>;
  memoryResults?: Map<string, LiveMemoryResult>;
  languageResults?: Map<string, LiveLanguageResult>;
}

export interface LiveCallHandlers {
  onHostReady?: () => void | Promise<void>;
  onStart?: (call: {
    epoch: number;
    callId: string;
    mode: 'resume' | 'new';
    visualInput: LiveVisualInput;
  }) => void | Promise<void>;
  onStop?: (call: {
    epoch: number;
    callId: string;
  }) => void | { error: string } | Promise<void | { error: string }>;
  onInputAudio?: (call: {
    epoch: number;
    callId: string;
    pcm16: Buffer;
  }) => boolean;
  onInputImage?: (call: {
    epoch: number;
    callId: string;
    source: LiveVisualSource;
    image: string;
  }) => boolean;
  onVisualSettings?: (call: {
    epoch: number;
    callId: string;
    visualInput: LiveVisualInput;
  }) => void;
  onPlaybackStarted?: (call: { epoch: number }) => void;
  onPlaybackCompleted?: (call: { epoch: number }) => void;
  onOutputMuted?: (call: { epoch: number }) => void;
}

export interface LiveHostCoordinatorOptions {
  daemonInstanceNonce?: string;
  daemonShutdownV1?: boolean;
  getUiLanguage?: () => LiveLanguageState;
  getSubagents?: () => SubagentsSnapshot | undefined;
  onLanguageAction?: (
    language: LiveLanguageState['language'],
  ) => LiveLanguageState;
  getProviderReadiness: () => LiveProviderReadiness;
  shortcut?: string;
  handlers?: LiveCallHandlers;
  helloTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  visualCaptureTimeoutMs?: number;
  now?: () => number;
  visualInput?: LiveVisualInput;
  logger?: LiveLogger;
  getMemoryState?: () => LiveMemoryState;
  onMemoryAction?: (
    action: LiveMemoryAction,
  ) => LiveMemoryState | Promise<LiveMemoryState>;
}

export interface LiveVisualCapture {
  source: LiveVisualSource;
  image: string;
  width: number;
  height: number;
  appName?: string;
  windowTitle?: string;
  accessibilityText?: string;
  screenshotPath?: string;
}

interface PendingVisualCapture {
  epoch: number;
  source: LiveVisualSource;
  persistAsset: boolean;
  timer: NodeJS.Timeout;
  resolve: (capture: LiveVisualCapture) => void;
  reject: (error: Error) => void;
}

interface PendingShortcut {
  requestId: string;
  shortcut: string;
  timer: NodeJS.Timeout;
  resolve: (status: LiveStatus) => void;
  reject: (error: Error) => void;
}

export class LiveUnavailableError extends Error {
  readonly code = 'live_unavailable' as const;

  constructor(readonly status: LiveStatus) {
    super(status.message ?? 'Live Voice is unavailable.');
    this.name = 'LiveUnavailableError';
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isBoundedString(value: unknown, maxLength = MAX_ID_LENGTH): boolean {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= maxLength
  );
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isPermissionState(value: unknown): value is LivePermissionState {
  return (
    value === 'granted' || value === 'denied' || value === 'not_determined'
  );
}

function parseHello(
  value: Record<string, unknown>,
): StandaloneHostHello | undefined {
  const protocolVersion = value['protocolVersion'];
  const permissions = value['permissions'];
  const selfChecks = value['selfChecks'];
  const cameraPermission = isObject(permissions)
    ? permissions['camera']
    : undefined;
  const legacyHelloWithoutCamera =
    protocolVersion !== LIVE_HOST_PROTOCOL_VERSION &&
    cameraPermission === undefined;
  if (
    value['type'] !== 'host.hello' ||
    (value['subagentsV1'] !== undefined && value['subagentsV1'] !== true) ||
    typeof protocolVersion !== 'number' ||
    !Number.isInteger(protocolVersion) ||
    !isBoundedString(value['hostVersion'], MAX_VERSION_LENGTH) ||
    !isBoundedString(value['bundleId']) ||
    !isBoundedString(value['instanceNonce']) ||
    !isObject(permissions) ||
    !isPermissionState(permissions['microphone']) ||
    (!isPermissionState(cameraPermission) && !legacyHelloWithoutCamera) ||
    !isPermissionState(permissions['accessibility']) ||
    !isPermissionState(permissions['screenRecording']) ||
    !isObject(selfChecks) ||
    typeof selfChecks['audioInput'] !== 'boolean' ||
    typeof selfChecks['audioOutput'] !== 'boolean' ||
    typeof selfChecks['globalShortcut'] !== 'boolean' ||
    typeof selfChecks['appshot'] !== 'boolean'
  ) {
    return undefined;
  }
  return {
    ...(value as unknown as StandaloneHostHello),
    permissions: {
      ...permissions,
      camera: isPermissionState(cameraPermission)
        ? cameraPermission
        : 'not_determined',
    } as LiveHostHello['permissions'],
  };
}

function parseAction(
  value: Record<string, unknown>,
): LiveHostAction | undefined {
  if (value['type'] !== 'host.action') return undefined;
  const action = value['action'];
  const epoch = value['epoch'];
  if (
    epoch !== undefined &&
    (typeof epoch !== 'number' || !Number.isSafeInteger(epoch) || epoch < 0)
  ) {
    return undefined;
  }
  if (action === 'toggle' || action === 'new' || action === 'stop') {
    return {
      type: 'host.action',
      action,
      ...(epoch !== undefined ? { epoch } : {}),
    };
  }
  if (action === 'mute') {
    const inputMuted = value['inputMuted'];
    const outputMuted = value['outputMuted'];
    if (
      (inputMuted === undefined && outputMuted === undefined) ||
      (inputMuted !== undefined && typeof inputMuted !== 'boolean') ||
      (outputMuted !== undefined && typeof outputMuted !== 'boolean')
    ) {
      return undefined;
    }
    return {
      type: 'host.action',
      action,
      ...(inputMuted !== undefined ? { inputMuted } : {}),
      ...(outputMuted !== undefined ? { outputMuted } : {}),
      ...(epoch !== undefined ? { epoch } : {}),
    };
  }
  return undefined;
}

function isBoundedVisualImage(image: unknown): image is string {
  if (
    typeof image !== 'string' ||
    image.length === 0 ||
    image.length > MAX_HOST_VISUAL_BASE64_LENGTH ||
    image.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(image)
  ) {
    return false;
  }
  const jpeg = Buffer.from(image, 'base64');
  return (
    jpeg.byteLength >= 4 &&
    jpeg.byteLength <= MAX_HOST_VISUAL_IMAGE_BYTES &&
    jpeg[0] === 0xff &&
    jpeg[1] === 0xd8 &&
    jpeg[jpeg.byteLength - 2] === 0xff &&
    jpeg[jpeg.byteLength - 1] === 0xd9 &&
    jpeg.toString('base64') === image
  );
}

function isVisualSource(value: unknown): value is LiveVisualSource {
  return value === 'screen' || value === 'camera';
}

function parseVisualFrame(
  value: Record<string, unknown>,
): LiveHostVisualFrame | undefined {
  const epoch = value['epoch'];
  const image = value['image'];
  if (
    value['type'] !== 'host.visual_frame' ||
    typeof epoch !== 'number' ||
    !Number.isSafeInteger(epoch) ||
    epoch < 0 ||
    !isVisualSource(value['source']) ||
    !isBoundedVisualImage(image)
  ) {
    return undefined;
  }
  return {
    type: 'host.visual_frame',
    epoch,
    source: value['source'],
    image,
  };
}

function parseVisualSettings(
  value: Record<string, unknown>,
): LiveHostVisualSettings | undefined {
  const epoch = value['epoch'];
  const permissions = value['permissions'];
  if (
    value['type'] !== 'host.visual_settings' ||
    typeof epoch !== 'number' ||
    !Number.isSafeInteger(epoch) ||
    epoch < 0 ||
    !isVisualSource(value['source']) ||
    (value['mode'] !== 'on-demand' && value['mode'] !== 'live-feed') ||
    !isObject(permissions) ||
    !isPermissionState(permissions['camera']) ||
    !isPermissionState(permissions['accessibility']) ||
    !isPermissionState(permissions['screenRecording']) ||
    typeof value['appshot'] !== 'boolean'
  ) {
    return undefined;
  }
  return {
    type: 'host.visual_settings',
    epoch,
    source: value['source'],
    mode: value['mode'],
    permissions: {
      camera: permissions['camera'],
      accessibility: permissions['accessibility'],
      screenRecording: permissions['screenRecording'],
    },
    appshot: value['appshot'],
  };
}

function parseVisualCaptureResult(
  value: Record<string, unknown>,
): LiveHostVisualCaptureResult | undefined {
  const requestId = value['requestId'];
  if (
    value['type'] !== 'host.visual_capture_result' ||
    !isBoundedString(requestId)
  ) {
    return undefined;
  }
  if (value['success'] === false && isBoundedString(value['error'], 1_024)) {
    return {
      type: 'host.visual_capture_result',
      requestId: requestId as string,
      success: false,
      error: value['error'] as string,
    };
  }
  const source = value['source'];
  const width = value['width'];
  const height = value['height'];
  if (
    value['success'] !== true ||
    !isVisualSource(source) ||
    !isBoundedVisualImage(value['image']) ||
    typeof width !== 'number' ||
    !Number.isSafeInteger(width) ||
    width <= 0 ||
    typeof height !== 'number' ||
    !Number.isSafeInteger(height) ||
    height <= 0 ||
    (value['screenshotPath'] !== undefined &&
      !isBoundedString(value['screenshotPath'], 4_096))
  ) {
    return undefined;
  }
  if (source === 'camera') {
    return {
      type: 'host.visual_capture_result',
      requestId: requestId as string,
      success: true,
      source,
      image: value['image'],
      width,
      height,
      ...(value['screenshotPath']
        ? { screenshotPath: value['screenshotPath'] as string }
        : {}),
    };
  }
  if (
    !isBoundedString(value['appName'], 512) ||
    (value['windowTitle'] !== undefined &&
      !isBoundedString(value['windowTitle'], 2_048)) ||
    typeof value['accessibilityText'] !== 'string' ||
    value['accessibilityText'].length > MAX_APPSHOT_TEXT_LENGTH
  ) {
    return undefined;
  }
  return {
    type: 'host.visual_capture_result',
    requestId: requestId as string,
    success: true,
    source,
    image: value['image'],
    width,
    height,
    appName: value['appName'] as string,
    ...(value['windowTitle']
      ? { windowTitle: value['windowTitle'] as string }
      : {}),
    accessibilityText: value['accessibilityText'],
    ...(value['screenshotPath']
      ? { screenshotPath: value['screenshotPath'] as string }
      : {}),
  };
}

function parseMemoryAction(
  value: Record<string, unknown>,
): LiveHostMemoryAction | undefined {
  if (
    !isBoundedString(value['requestId']) ||
    !isNonNegativeSafeInteger(value['epoch'])
  )
    return undefined;
  const base = {
    type: 'host.memory_action' as const,
    requestId: value['requestId'] as string,
    epoch: value['epoch'],
  };
  switch (value['action']) {
    case 'set_enabled':
    case 'set_visual_enabled':
      return typeof value['enabled'] === 'boolean'
        ? { ...base, action: value['action'], enabled: value['enabled'] }
        : undefined;
    case 'select':
      return isBoundedString(value['libraryId'], 64)
        ? { ...base, action: 'select', libraryId: value['libraryId'] as string }
        : undefined;
    case 'create':
      return isBoundedString(value['name'], 160)
        ? { ...base, action: 'create', name: value['name'] as string }
        : undefined;
    case 'rename':
      return isBoundedString(value['libraryId'], 64) &&
        isBoundedString(value['name'], 160)
        ? {
            ...base,
            action: 'rename',
            libraryId: value['libraryId'] as string,
            name: value['name'] as string,
          }
        : undefined;
    case 'set_model':
      return isBoundedString(value['model'], 256)
        ? { ...base, action: 'set_model', model: value['model'] as string }
        : undefined;
    default:
      return undefined;
  }
}

function parseHostMessage(
  text: string,
): LiveHostMessage | LiveHostLanguageAction | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isObject(value)) return undefined;
  if (value['type'] === 'host.hello') return parseHello(value);
  if (value['type'] === 'host.action') return parseAction(value);
  if (value['type'] === 'host.memory_action') return parseMemoryAction(value);
  if (value['type'] === 'host.language_action') {
    if (
      !isBoundedString(value['requestId']) ||
      !isNonNegativeSafeInteger(value['epoch']) ||
      !isLiveLanguage(value['language'])
    )
      return undefined;
    return {
      type: 'host.language_action',
      requestId: value['requestId'] as string,
      epoch: value['epoch'],
      language: value['language'],
    };
  }
  if (value['type'] === 'host.visual_frame') return parseVisualFrame(value);
  if (value['type'] === 'host.visual_settings')
    return parseVisualSettings(value);
  if (value['type'] === 'host.visual_capture_result')
    return parseVisualCaptureResult(value);
  if (value['type'] === 'host.pong' && isBoundedString(value['pingId'])) {
    return { type: 'host.pong', pingId: value['pingId'] as string };
  }
  if (value['type'] === 'host.shortcut_result') {
    const requestId = value['requestId'];
    const shortcut = value['shortcut'];
    const success = value['success'];
    const error = value['error'];
    if (
      isBoundedString(requestId) &&
      typeof shortcut === 'string' &&
      shortcut.length <= MAX_SHORTCUT_LENGTH &&
      typeof success === 'boolean' &&
      (error === undefined ||
        (typeof error === 'string' && error.length <= 1_024))
    ) {
      return {
        type: 'host.shortcut_result',
        requestId: requestId as string,
        shortcut,
        success,
        ...(error ? { error } : {}),
      };
    }
  }
  if (
    value['type'] === 'host.playback_started' &&
    isNonNegativeSafeInteger(value['epoch']) &&
    isNonNegativeSafeInteger(value['outputId'])
  ) {
    return {
      type: 'host.playback_started',
      epoch: value['epoch'],
      outputId: value['outputId'],
    };
  }
  if (
    value['type'] === 'host.playback_completed' &&
    isNonNegativeSafeInteger(value['epoch']) &&
    isNonNegativeSafeInteger(value['outputId'])
  ) {
    return {
      type: 'host.playback_completed',
      epoch: value['epoch'],
      outputId: value['outputId'],
    };
  }
  return undefined;
}

function permissionRequirement(
  value: LivePermissionState,
): 'ready' | 'missing' | 'denied' {
  if (value === 'granted') return 'ready';
  if (value === 'denied') return 'denied';
  return 'missing';
}

function projectStatusForHost(status: LiveStatus): LiveHostStatus {
  return {
    v: status.v,
    available: status.available,
    state: status.state,
    shortcut: status.shortcut,
    ...(status.blocker ? { blocker: status.blocker } : {}),
    ...(status.message ? { message: status.message } : {}),
    ...(status.callId ? { callId: status.callId } : {}),
    ...(status.inputMuted !== undefined
      ? { inputMuted: status.inputMuted }
      : {}),
    ...(status.outputMuted !== undefined
      ? { outputMuted: status.outputMuted }
      : {}),
    ...(status.transcript ? { transcript: status.transcript } : {}),
    ...(status.caption ? { caption: status.caption } : {}),
    ...(status.statusText ? { statusText: status.statusText } : {}),
    ...(status.pendingPermission
      ? { pendingPermission: { ...status.pendingPermission } }
      : {}),
    ...(status.requirements
      ? { requirements: { ...status.requirements } }
      : {}),
    ...(status.host ? { host: { ...status.host } } : {}),
  };
}

export class LiveHostCoordinator {
  readonly daemonInstanceNonce: string;
  private readonly now: () => number;
  private readonly helloTimeoutMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly heartbeatTimeoutMs: number;
  private readonly visualCaptureTimeoutMs: number;
  private readonly logger: LiveLogger;
  private visualInput: LiveVisualInput;
  private shortcut: string;
  private handlers: LiveCallHandlers;
  private host?: HostLease;
  private hadConnectedHost = false;
  private lastHostFailure?: 'host_disconnected' | 'host_version';
  private providerOverride?: LiveProviderReadiness;
  private appshotReadiness: LiveAppshotReadiness = {
    state: 'unavailable',
    message: liveText('en', 'runtime.appshotUnchecked'),
  };
  private call?: LiveCall;
  private pendingStartMode?: 'new';
  private deactivating = false;
  private nextEpoch = 0;
  private nextOutputId = 0;
  private writableOutputId?: number;
  private readonly outputAudio = new Map<
    number,
    { finished: boolean; drained: boolean }
  >();
  private playbackStartedNotified = false;
  private inputMuted = false;
  private outputMuted = false;
  private lastCallError?: string;
  private readonly pendingVisualCaptures = new Map<
    string,
    PendingVisualCapture
  >();
  private pendingShortcut?: PendingShortcut;
  private readonly inactiveWaiters = new Set<() => void>();

  constructor(private readonly options: LiveHostCoordinatorOptions) {
    this.daemonInstanceNonce = options.daemonInstanceNonce ?? randomUUID();
    this.handlers = options.handlers ?? {};
    this.now = options.now ?? Date.now;
    this.helloTimeoutMs = options.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS;
    this.heartbeatIntervalMs =
      options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.heartbeatTimeoutMs =
      options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
    this.visualCaptureTimeoutMs =
      options.visualCaptureTimeoutMs ?? DEFAULT_VISUAL_CAPTURE_TIMEOUT_MS;
    this.visualInput = {
      ...(options.visualInput ?? DEFAULT_VISUAL_INPUT),
    };
    this.logger = options.logger ?? new LiveLogger();
    this.appshotReadiness.message = this.uiText('runtime.appshotUnchecked');
    const shortcut = options.shortcut?.trim();
    this.shortcut =
      shortcut && shortcut.length <= MAX_SHORTCUT_LENGTH
        ? shortcut
        : DEFAULT_SHORTCUT;
  }

  setHandlers(handlers: LiveCallHandlers): void {
    this.handlers = handlers;
  }

  setConfiguredShortcut(shortcut: string): LiveStatus {
    const normalized = shortcut.trim();
    if (normalized.length > MAX_SHORTCUT_LENGTH) {
      throw new Error('The Live shortcut is too long.');
    }
    this.shortcut = normalized;
    this.broadcastState();
    return this.getStatus();
  }

  async deactivate(): Promise<void> {
    // Host-initiated starts must not re-arm a call while the stop drains:
    // state broadcasts during 'stopping' still carry the stopping call's
    // epoch, so a host.action would otherwise pass the epoch gate.
    this.deactivating = true;
    this.pendingStartMode = undefined;
    if (this.call) {
      const stopped = new Promise<void>((resolve) => {
        this.inactiveWaiters.add(resolve);
      });
      this.stop();
      await stopped;
    }
    if (!this.host) return;
    const lease = this.host;
    if (lease.socket.readyState === WebSocket.OPEN) {
      lease.socket.close(1001, 'Live Voice disabled.');
    }
    this.detachHost(lease, 'host_disconnected');
  }

  attachHost(socket: WebSocket, daemonNonce: string | undefined): void {
    const expectedNonce = Buffer.from(this.daemonInstanceNonce);
    const presentedNonce = Buffer.from(daemonNonce ?? '');
    if (
      expectedNonce.byteLength !== presentedNonce.byteLength ||
      !timingSafeEqual(expectedNonce, presentedNonce)
    ) {
      this.debug('host.rejected', { reason: 'daemon_nonce' });
      socket.close(4003, 'Invalid daemon instance nonce.');
      return;
    }
    if (this.host && this.isLeaseHealthy(this.host)) {
      this.debug('host.rejected', { reason: 'lease_active' });
      socket.close(4009, 'A Live Host is already connected.');
      return;
    }
    if (this.host) this.disconnectHost(this.host, 4008, 'Host lease expired.');

    // Only an accepted lease revives Live Voice: a fresh host connection is
    // the re-activation signal that ends the deactivating window.
    this.deactivating = false;
    const lease: HostLease = {
      socket,
      lastPongAt: this.now(),
      helloTimer: setTimeout(() => {
        if (this.host === lease && !lease.hello) {
          socket.close(4000, 'Host hello timeout.');
          this.detachHost(lease, 'host_disconnected');
        }
      }, this.helloTimeoutMs),
    };
    lease.helloTimer.unref?.();
    this.host = lease;
    this.debug('host.connected', {});

    socket.on('message', (data, isBinary) => {
      if (this.host !== lease) return;
      if (isBinary) this.handleAudioFrame(lease, data);
      else this.handleTextFrame(lease, data);
    });
    socket.on('close', (code = 0, reason = Buffer.alloc(0)) => {
      this.debug('host.closed', {
        code,
        reason: reason.toString('utf8').slice(0, 256),
      });
      if (this.host === lease) this.detachHost(lease, 'host_disconnected');
    });
    socket.on('error', (error: Error) => {
      this.debug('host.error', { message: error.message.slice(0, 256) });
      if (this.host === lease) this.detachHost(lease, 'host_disconnected');
    });
  }

  getStatus(): LiveStatus {
    return this.buildStatus(true);
  }

  private buildStatus(stopOnReadinessLoss: boolean): LiveStatus {
    const provider = this.readProviderReadiness();
    const appshot = this.appshotReadiness;
    const hello = this.host?.hello;
    const requirements: NonNullable<LiveStatus['requirements']> = {
      host: hello
        ? 'ready'
        : this.lastHostFailure === 'host_version'
          ? 'unavailable'
          : this.hadConnectedHost
            ? 'unavailable'
            : 'missing',
      provider:
        provider.state === 'ready'
          ? 'ready'
          : provider.state === 'checking'
            ? 'checking'
            : 'unavailable',
    };
    if (hello) {
      requirements.microphone = permissionRequirement(
        hello.permissions.microphone,
      );
      if (this.visualInput.source === 'camera') {
        requirements.camera = permissionRequirement(hello.permissions.camera);
      } else {
        requirements.accessibility = permissionRequirement(
          hello.permissions.accessibility,
        );
        requirements.screenRecording = permissionRequirement(
          hello.permissions.screenRecording,
        );
      }
      requirements.audioInput = hello.selfChecks.audioInput
        ? 'ready'
        : 'unavailable';
      requirements.audioOutput = hello.selfChecks.audioOutput
        ? 'ready'
        : 'unavailable';
      requirements.globalShortcut = hello.selfChecks.globalShortcut
        ? 'ready'
        : 'unavailable';
      if (this.visualInput.source === 'screen') {
        requirements.appshot = hello.selfChecks.appshot
          ? appshot.state
          : 'unavailable';
      }
    } else if (
      this.visualInput.source === 'screen' &&
      appshot.state !== 'ready'
    ) {
      requirements.appshot = appshot.state;
    }

    const blocker = this.resolveBlocker(provider, appshot, hello);
    const providerChecking = provider.state === 'checking';
    const available = !providerChecking && blocker === undefined;
    const preserveCheckingCall =
      providerChecking && blocker === undefined && this.call !== undefined;
    if (
      !available &&
      this.call &&
      stopOnReadinessLoss &&
      !preserveCheckingCall
    ) {
      this.stopForReadinessLoss();
    }
    const active = this.call;
    return {
      v: 1,
      available,
      shortcut: this.shortcut,
      state: preserveCheckingCall
        ? (active?.state ?? 'starting')
        : available
          ? (active?.state ?? (this.lastCallError ? 'error' : 'idle'))
          : 'unavailable',
      ...(blocker ? { blocker } : {}),
      ...(blocker
        ? { message: this.blockerMessage(blocker, provider, appshot, hello) }
        : this.lastCallError
          ? { message: this.lastCallError }
          : {}),
      ...(active ? { callId: active.callId } : {}),
      inputMuted: this.inputMuted,
      outputMuted: this.outputMuted,
      ...(active?.transcript ? { transcript: active.transcript } : {}),
      ...(active?.caption ? { caption: active.caption } : {}),
      ...(active?.statusText ? { statusText: active.statusText } : {}),
      ...(active?.pendingPermission && active.coordinator?.workspaceId
        ? {
            pendingPermission: {
              workspaceId: active.coordinator.workspaceId,
              sessionId: active.coordinator.sessionId,
            },
          }
        : {}),
      requirements,
      ...(hello
        ? {
            host: {
              version: hello.hostVersion,
              protocolVersion: hello.protocolVersion,
            },
          }
        : {}),
    };
  }

  start(mode: 'resume' | 'new'): {
    epoch: number;
    callId: string;
    status: LiveStatus;
  } {
    const status = this.getStatus();
    if (!status.available) throw new LiveUnavailableError(status);
    if (mode === 'resume' && this.call) {
      return {
        epoch: this.call.epoch,
        callId: this.call.callId,
        status,
      };
    }
    if (this.call) {
      const replacedCall = this.call;
      this.pendingStartMode = 'new';
      this.beginCallStop(replacedCall);
      const reportedCall = this.call ?? replacedCall;
      return {
        epoch: reportedCall.epoch,
        callId: reportedCall.callId,
        status: this.getStatus(),
      };
    }
    return this.startCall(mode);
  }

  private startCall(mode: 'resume' | 'new'): {
    epoch: number;
    callId: string;
    status: LiveStatus;
  } {
    const call: LiveCall = {
      epoch: ++this.nextEpoch,
      callId: randomUUID(),
      mode,
      state: 'starting',
      pendingPermission: false,
      workers: [],
    };
    this.call = call;
    this.debug('call.start', { epoch: call.epoch, mode });
    this.lastCallError = undefined;
    this.broadcastState();
    try {
      void Promise.resolve(
        this.handlers.onStart?.({
          epoch: call.epoch,
          callId: call.callId,
          mode,
          visualInput: { ...this.visualInput },
        }),
      ).catch(() => {
        this.failCall(call.epoch, this.uiText('runtime.startFailed'));
      });
    } catch {
      this.failCall(call.epoch, this.uiText('runtime.startFailed'));
    }
    return { epoch: call.epoch, callId: call.callId, status: this.getStatus() };
  }

  stop(): LiveStatus {
    this.pendingStartMode = undefined;
    if (this.call) this.beginCallStop(this.call);
    return this.getStatus();
  }

  setMute(update: LiveMuteUpdate): LiveStatus {
    if (update.inputMuted !== undefined) {
      this.inputMuted = update.inputMuted;
    }
    if (update.outputMuted !== undefined) {
      const becameMuted = update.outputMuted && !this.outputMuted;
      this.outputMuted = update.outputMuted;
      if (becameMuted && this.call) {
        this.clearOutput(this.call.epoch);
        this.handlers.onOutputMuted?.({ epoch: this.call.epoch });
      }
    }
    this.broadcastState();
    return this.getStatus();
  }

  setShortcut(shortcut: string): Promise<LiveStatus> {
    const normalized = shortcut.trim();
    if (normalized.length > MAX_SHORTCUT_LENGTH) {
      return Promise.reject(new Error('The Live shortcut is too long.'));
    }
    if (normalized === this.shortcut) {
      return Promise.resolve(this.getStatus());
    }
    if (this.pendingShortcut) {
      return Promise.reject(
        new Error('Another Live shortcut update is already in progress.'),
      );
    }
    const host = this.host;
    if (!host?.hello || !this.isLeaseHealthy(host)) {
      return Promise.reject(
        new Error('Qwen Live Host must be connected to change the shortcut.'),
      );
    }
    const requestId = randomUUID();
    return new Promise<LiveStatus>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.rejectPendingShortcut(
          new Error('Qwen Live Host did not confirm the shortcut change.'),
        );
      }, DEFAULT_SHORTCUT_TIMEOUT_MS);
      timer.unref?.();
      this.pendingShortcut = {
        requestId,
        shortcut: normalized,
        timer,
        resolve,
        reject,
      };
      if (
        !this.sendHost({
          type: 'host.set_shortcut',
          requestId,
          shortcut: normalized,
        })
      ) {
        this.rejectPendingShortcut(
          new Error('Qwen Live Host is unavailable for shortcut changes.'),
        );
      }
    });
  }

  setCallState(epoch: number, state: LiveCall['state']): boolean {
    if (!this.call || this.call.epoch !== epoch) return false;
    if (this.call.state === state) return true;
    this.call.state = state;
    this.broadcastState();
    return true;
  }

  setCoordinator(epoch: number, locator: LiveSessionLocator): boolean {
    if (!this.call || this.call.epoch !== epoch) return false;
    this.call.coordinator = locator;
    this.broadcastState();
    return true;
  }

  setPendingPermission(epoch: number, pending: boolean): boolean {
    if (!this.call || this.call.epoch !== epoch) return false;
    if (this.call.pendingPermission === pending) return true;
    this.call.pendingPermission = pending;
    this.broadcastState();
    return true;
  }

  setTranscript(epoch: number, transcript: string): boolean {
    if (!this.call || this.call.epoch !== epoch) return false;
    const truncated = transcript.slice(0, MAX_TRANSCRIPT_LENGTH);
    if (this.call.transcript === truncated) return true;
    this.call.transcript = truncated;
    this.broadcastState();
    return true;
  }

  setCaption(epoch: number, caption: string): boolean {
    if (!this.call || this.call.epoch !== epoch) return false;
    const truncated = caption.slice(0, MAX_TRANSCRIPT_LENGTH);
    if (this.call.caption === truncated) return true;
    this.call.caption = truncated || undefined;
    this.broadcastState();
    return true;
  }

  setStatusText(epoch: number, statusText?: string): boolean {
    if (!this.call || this.call.epoch !== epoch) return false;
    const truncated = statusText?.trim().slice(0, MAX_STATUS_TEXT_LENGTH);
    if (this.call.statusText === truncated) return true;
    this.call.statusText = truncated || undefined;
    this.broadcastState();
    return true;
  }

  setWorkers(epoch: number, workers: readonly LiveSessionLocator[]): boolean {
    if (!this.call || this.call.epoch !== epoch) return false;
    this.call.workers = [...workers];
    this.broadcastState();
    return true;
  }

  isActiveSession(sessionId: string): boolean {
    const call = this.call;
    return (
      call !== undefined &&
      (call.coordinator?.sessionId === sessionId ||
        call.workers.some((worker) => worker.sessionId === sessionId))
    );
  }

  captureVisualContext(
    callerSessionId: string,
    options: { persistAsset?: boolean } = {},
  ): Promise<LiveVisualCapture> {
    const call = this.call;
    const host = this.host;
    const sourceReady =
      this.visualInput.source === 'camera'
        ? host?.hello?.permissions.camera === 'granted'
        : host?.hello?.permissions.accessibility === 'granted' &&
          host.hello.permissions.screenRecording === 'granted' &&
          host.hello.selfChecks.appshot;
    if (
      !call ||
      call.coordinator?.sessionId !== callerSessionId ||
      !host?.hello ||
      !this.isLeaseHealthy(host) ||
      this.visualInput.mode !== 'on-demand' ||
      !sourceReady
    ) {
      return Promise.reject(
        new Error(
          'On Demand capture is available only to the active Live session with a ready selected source.',
        ),
      );
    }
    const requestId = randomUUID();
    const source = this.visualInput.source;
    const snapshotWidth =
      source === 'camera'
        ? this.visualInput.cameraSnapshotWidth
        : this.visualInput.snapshotWidth;
    const snapshotHeight =
      source === 'camera'
        ? this.visualInput.cameraSnapshotHeight
        : this.visualInput.snapshotHeight;
    this.debug('visual.capture_requested', { epoch: call.epoch, source });
    return new Promise<LiveVisualCapture>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingVisualCaptures.delete(requestId);
        this.debug('visual.capture_failed', {
          epoch: call.epoch,
          source,
          reason: 'timeout',
        });
        reject(new Error('Live Host On Demand capture timed out.'));
      }, this.visualCaptureTimeoutMs);
      timer.unref?.();
      this.pendingVisualCaptures.set(requestId, {
        epoch: call.epoch,
        source,
        persistAsset: options.persistAsset !== false,
        timer,
        resolve,
        reject,
      });
      if (
        !this.sendHost({
          type: 'host.capture_visual',
          requestId,
          epoch: call.epoch,
          source,
          ...(snapshotWidth !== undefined ? { snapshotWidth } : {}),
          ...(snapshotHeight !== undefined ? { snapshotHeight } : {}),
          ...(options.persistAsset !== undefined
            ? { persistAsset: options.persistAsset }
            : {}),
        })
      ) {
        this.rejectPendingVisualCapture(
          requestId,
          new Error('Live Host is unavailable for On Demand capture.'),
        );
      }
    });
  }

  setProviderReachability(readiness?: LiveProviderReadiness): void {
    this.providerOverride = readiness;
    const status = this.getStatus();
    this.sendState(status);
  }

  setAppshotReadiness(readiness: LiveAppshotReadiness): void {
    this.appshotReadiness = { ...readiness };
    this.sendState(this.getStatus());
  }

  failCall(
    epoch: number,
    message = this.uiText('runtime.callFailed'),
  ): boolean {
    if (
      !this.call ||
      this.call.epoch !== epoch ||
      this.call.state === 'stopping'
    ) {
      return false;
    }
    this.debug('call.failed', { epoch, message });
    const call = this.call;
    this.pendingStartMode = undefined;
    this.lastCallError = message;
    this.beginCallStop(call);
    return true;
  }

  sendOutputAudio(epoch: number, pcm16: Uint8Array): boolean {
    if (
      !this.call ||
      this.call.epoch !== epoch ||
      pcm16.byteLength === 0 ||
      pcm16.byteLength > MAX_DAEMON_AUDIO_BYTES ||
      pcm16.byteLength % 2 !== 0
    ) {
      return false;
    }
    if (this.outputMuted) return false;
    const socket = this.host?.socket;
    if (
      !socket ||
      socket.readyState !== WebSocket.OPEN ||
      socket.bufferedAmount > MAX_SOCKET_BUFFERED_BYTES
    ) {
      return false;
    }
    const outputId = this.writableOutputId ?? this.allocateOutputId();
    const output = this.outputAudio.get(outputId) ?? {
      finished: false,
      drained: false,
    };
    const frame = Buffer.allocUnsafe(
      LIVE_OUTPUT_AUDIO_HEADER_BYTES + pcm16.byteLength,
    );
    frame.writeBigUInt64BE(BigInt(epoch), 0);
    frame.writeBigUInt64BE(BigInt(outputId), LIVE_OUTPUT_AUDIO_EPOCH_BYTES);
    frame.set(pcm16, LIVE_OUTPUT_AUDIO_HEADER_BYTES);
    socket.send(frame, { binary: true });
    this.writableOutputId = outputId;
    if (!this.supportsOutputAudioEndMarker()) {
      output.finished = false;
      output.drained = false;
    }
    this.outputAudio.set(outputId, output);
    this.debug('audio.output_sent', {
      epoch,
      outputId,
      bytes: pcm16.byteLength,
      socketBufferedBytes: socket.bufferedAmount,
    });
    return true;
  }

  finishOutputAudio(epoch: number): void {
    const call = this.call;
    const outputId = this.writableOutputId;
    if (!call || call.epoch !== epoch || outputId === undefined) {
      return;
    }
    const output = this.outputAudio.get(outputId);
    if (!output || output.finished) return;
    output.finished = true;
    if (this.supportsOutputAudioEndMarker()) {
      if (
        !this.sendHost({
          type: 'host.output_audio_finished',
          epoch,
          outputId,
        })
      ) {
        output.finished = false;
      } else {
        this.writableOutputId = undefined;
      }
      return;
    }
    if (output.drained) this.completeOutputAudio(call, outputId);
  }

  isOutputMuted(): boolean {
    return this.outputMuted;
  }

  clearOutput(epoch: number): void {
    if (this.call && this.call.epoch !== epoch) return;
    this.resetOutputAudio();
    this.debug('audio.output_cleared', { epoch });
    this.sendHost({ type: 'host.clear_output', epoch });
  }

  dispose(): void {
    this.pendingStartMode = undefined;
    if (this.call) this.finishCall(this.call);
    if (this.host) {
      const lease = this.host;
      this.host = undefined;
      this.clearLeaseTimers(lease);
      if (lease.socket.readyState === WebSocket.OPEN) {
        lease.socket.close(1001, 'Daemon shutting down.');
      }
    }
    this.rejectPendingVisualCaptures(new Error('Live Voice is shutting down.'));
    this.rejectPendingShortcut(new Error('Live Voice is shutting down.'));
    this.notifyInactive();
  }

  private readProviderReadiness(): LiveProviderReadiness {
    if (this.providerOverride) return this.providerOverride;
    try {
      return this.options.getProviderReadiness();
    } catch {
      return {
        state: 'unavailable',
        blocker: 'provider_config',
        message: this.uiText('runtime.providerConfig'),
      };
    }
  }

  private resolveBlocker(
    provider: LiveProviderReadiness,
    appshot: LiveAppshotReadiness,
    hello: LiveHostHello | undefined,
  ): LiveStatus['blocker'] {
    if (provider.state === 'unavailable') {
      return provider.blocker ?? 'provider_config';
    }
    if (!hello) {
      if (this.lastHostFailure === 'host_version') return 'host_version';
      return this.hadConnectedHost ? 'host_disconnected' : 'host_missing';
    }
    if (hello.permissions.microphone !== 'granted') {
      return 'microphone_permission';
    }
    if (
      this.visualInput.source === 'camera' &&
      hello.permissions.camera !== 'granted'
    )
      return 'camera_permission';
    if (
      this.visualInput.source === 'screen' &&
      hello.permissions.accessibility !== 'granted'
    )
      return 'accessibility_permission';
    if (
      this.visualInput.source === 'screen' &&
      hello.permissions.screenRecording !== 'granted'
    )
      return 'screen_recording_permission';
    if (!hello.selfChecks.audioInput) return 'audio_input';
    if (!hello.selfChecks.audioOutput) return 'audio_output';
    if (!hello.selfChecks.globalShortcut) return 'global_shortcut';
    if (this.visualInput.source === 'screen' && !hello.selfChecks.appshot)
      return 'appshot';
    if (this.visualInput.source === 'screen' && appshot.state !== 'ready')
      return 'appshot';
    return undefined;
  }

  private blockerMessage(
    blocker: NonNullable<LiveStatus['blocker']>,
    provider: LiveProviderReadiness,
    appshot: LiveAppshotReadiness,
    hello: LiveHostHello | undefined,
  ): string {
    if (
      (blocker === 'provider_config' || blocker === 'provider_unreachable') &&
      provider.message
    ) {
      return provider.message;
    }
    if (blocker === 'appshot' && hello?.selfChecks.appshot && appshot.message) {
      return appshot.message;
    }
    const messages: Record<
      NonNullable<LiveStatus['blocker']>,
      LiveMessageKey
    > = {
      host_missing: 'runtime.hostMissing',
      host_disconnected: 'runtime.hostDisconnected',
      host_version: 'runtime.hostVersion',
      microphone_permission: 'runtime.microphonePermission',
      camera_permission: 'runtime.cameraPermission',
      accessibility_permission: 'runtime.accessibilityPermission',
      screen_recording_permission: 'runtime.screenPermission',
      audio_input: 'runtime.audioInput',
      audio_output: 'runtime.audioOutput',
      global_shortcut: 'runtime.shortcut',
      appshot: 'runtime.appshot',
      provider_config: 'runtime.providerConfig',
      provider_unreachable: 'runtime.providerUnavailable',
    };
    return this.uiText(messages[blocker]);
  }

  private uiText(key: LiveMessageKey): string {
    return this.options.getUiLanguage ? liveMessage(key) : liveText('en', key);
  }

  private isLeaseHealthy(lease: HostLease): boolean {
    return (
      lease.socket.readyState === WebSocket.OPEN &&
      this.now() - lease.lastPongAt <= this.heartbeatTimeoutMs
    );
  }

  private handleTextFrame(lease: HostLease, data: RawData): void {
    const text = Buffer.isBuffer(data)
      ? data.toString('utf8')
      : Array.isArray(data)
        ? Buffer.concat(data).toString('utf8')
        : Buffer.from(data).toString('utf8');
    if (Buffer.byteLength(text) > MAX_HOST_TEXT_BYTES) {
      lease.socket.close(1009, 'Host message is too large.');
      return;
    }
    const message = parseHostMessage(text);
    if (!message) {
      this.sendHostError('invalid_message', 'Invalid Live Host message.');
      lease.socket.close(1002, 'Invalid Live Host message.');
      return;
    }
    if (message.type === 'host.hello') {
      this.handleHello(lease, message);
      return;
    }
    if (!lease.hello) {
      lease.socket.close(1002, 'host.hello must be the first message.');
      return;
    }
    if (message.type === 'host.pong') {
      if (message.pingId === lease.pingId) {
        lease.lastPongAt = this.now();
        lease.pingId = undefined;
      }
      return;
    }
    if (message.type === 'host.visual_capture_result') {
      this.handleVisualCaptureResult(message);
      return;
    }
    if (message.type === 'host.shortcut_result') {
      this.handleShortcutResult(message);
      return;
    }
    if (message.type === 'host.playback_started') {
      this.handlePlaybackStarted(message);
      return;
    }
    if (message.type === 'host.playback_completed') {
      this.handlePlaybackCompleted(message);
      return;
    }
    if (message.type === 'host.visual_frame') {
      this.handleVisualFrame(message);
      return;
    }
    if (message.type === 'host.visual_settings') {
      this.handleVisualSettings(message);
      return;
    }
    if (message.type === 'host.memory_action') {
      void this.handleMemoryAction(lease, message);
      return;
    }
    if (message.type === 'host.language_action') {
      this.handleLanguageAction(lease, message);
      return;
    }
    this.handleAction(message);
  }

  private handleLanguageAction(
    lease: HostLease,
    message: LiveHostLanguageAction,
  ): void {
    lease.languageResults ??= new Map();
    const cached = lease.languageResults.get(message.requestId);
    if (cached) {
      this.sendHost(cached);
      return;
    }
    let result: LiveLanguageResult;
    try {
      if (message.epoch !== this.nextEpoch)
        throw new Error(liveMessage('language.callChanged'));
      if (!this.options.onLanguageAction)
        throw new Error(liveMessage('language.unavailable'));
      const uiLanguageV1 = this.options.onLanguageAction(message.language);
      result = {
        type: 'host.language_result',
        requestId: message.requestId,
        ok: true,
        uiLanguageV1,
      };
    } catch (error) {
      result = {
        type: 'host.language_result',
        requestId: message.requestId,
        ok: false,
        error:
          error instanceof Error && error.message.startsWith('qwen-live-ui:')
            ? error.message
            : liveMessage('language.saveFailed'),
        ...(this.options.getUiLanguage
          ? { uiLanguageV1: this.options.getUiLanguage() }
          : {}),
      };
    }
    lease.languageResults.set(message.requestId, result);
    if (lease.languageResults.size > 64)
      lease.languageResults.delete(lease.languageResults.keys().next().value!);
    this.sendHost(result);
    this.broadcastState();
  }

  refreshMemoryState(): void {
    this.broadcastState();
  }

  refreshSubagentsState(): void {
    const subagentsV1 = this.options.getSubagents?.();
    if (subagentsV1 && this.host?.hello?.subagentsV1)
      this.sendHost({ type: 'host.subagents', subagentsV1 });
  }

  private memoryState(): LiveMemoryState | undefined {
    const state = this.options.getMemoryState?.();
    return state ? { ...state, locked: this.call !== undefined } : undefined;
  }

  private async handleMemoryAction(
    lease: HostLease,
    message: LiveHostMemoryAction,
  ): Promise<void> {
    lease.memoryResults ??= new Map();
    lease.memoryPending ??= new Set();
    const cached = lease.memoryResults.get(message.requestId);
    if (cached) {
      this.sendHost(cached);
      return;
    }
    if (lease.memoryPending.has(message.requestId)) return;
    if (lease.memoryPending.size >= 16) {
      this.sendHost({
        type: 'host.memory_result',
        requestId: message.requestId,
        ok: false,
        error: this.uiText('memoryUI.pending'),
      });
      return;
    }
    lease.memoryPending.add(message.requestId);
    let result: LiveMemoryResult;
    try {
      if (message.epoch !== this.nextEpoch)
        throw new Error(this.uiText('memoryUI.callChanged'));
      if (!this.options.onMemoryAction)
        throw new Error(this.uiText('memoryUI.unavailable'));
      if (
        this.call &&
        ['select', 'create', 'set_model'].includes(message.action)
      )
        throw new Error(this.uiText('memoryUI.locked'));
      await this.options.onMemoryAction(message);
      const memory = this.memoryState();
      if (!memory) throw new Error(this.uiText('memoryUI.stateUnavailable'));
      result = {
        type: 'host.memory_result',
        requestId: message.requestId,
        ok: true,
        memory,
      };
    } catch (error) {
      const memory = this.memoryState();
      result = {
        type: 'host.memory_result',
        requestId: message.requestId,
        ok: false,
        error:
          error instanceof Error
            ? error.message.slice(0, 1024)
            : this.uiText('memoryUI.updateFailed'),
        ...(memory ? { memory } : {}),
      };
    }
    lease.memoryPending.delete(message.requestId);
    if (this.host !== lease) return;
    lease.memoryResults.set(message.requestId, result);
    if (lease.memoryResults.size > 64)
      lease.memoryResults.delete(lease.memoryResults.keys().next().value!);
    this.sendHost(result);
    this.broadcastState();
  }

  private handleShortcutResult(message: LiveHostShortcutResult): void {
    const pending = this.pendingShortcut;
    if (!pending || message.requestId !== pending.requestId) return;
    this.pendingShortcut = undefined;
    clearTimeout(pending.timer);
    if (message.shortcut !== pending.shortcut) {
      pending.reject(
        new Error('Qwen Live Host returned a mismatched shortcut.'),
      );
      return;
    }
    if (!message.success) {
      pending.reject(
        new Error(
          message.error || 'The Live shortcut could not be registered.',
        ),
      );
      return;
    }
    this.shortcut = pending.shortcut;
    const status = this.getStatus();
    this.sendState(status);
    pending.resolve(status);
  }

  private handleVisualCaptureResult(
    message: LiveHostVisualCaptureResult,
  ): void {
    const pending = this.pendingVisualCaptures.get(message.requestId);
    if (!pending) return;
    const call = this.call;
    if (!call || call.epoch !== pending.epoch) {
      this.rejectPendingVisualCapture(
        message.requestId,
        new Error('The Live call changed before visual capture completed.'),
      );
      return;
    }
    this.pendingVisualCaptures.delete(message.requestId);
    clearTimeout(pending.timer);
    if (!message.success) {
      this.debug('visual.capture_failed', {
        epoch: pending.epoch,
        reason: message.error.slice(0, 256),
      });
      pending.reject(new Error(message.error));
      return;
    }
    if (message.source !== pending.source) {
      this.debug('visual.capture_failed', {
        epoch: pending.epoch,
        source: pending.source,
        reason: 'source_mismatch',
      });
      pending.reject(
        new Error('Live Host returned the wrong visual capture source.'),
      );
      return;
    }
    if (pending.persistAsset && !message.screenshotPath) {
      this.debug('visual.capture_failed', {
        epoch: pending.epoch,
        source: pending.source,
        reason: 'asset_missing',
      });
      pending.reject(
        new Error('Live Host did not persist the requested visual capture.'),
      );
      return;
    }
    this.debug('visual.capture_completed', {
      epoch: pending.epoch,
      source: message.source,
      width: message.width,
      height: message.height,
      bytes: Buffer.byteLength(message.image, 'base64'),
    });
    pending.resolve({
      source: message.source,
      image: message.image,
      width: message.width,
      height: message.height,
      ...(message.source === 'screen'
        ? {
            appName: message.appName,
            ...(message.windowTitle
              ? { windowTitle: message.windowTitle }
              : {}),
            accessibilityText: message.accessibilityText,
            ...(message.screenshotPath
              ? { screenshotPath: message.screenshotPath }
              : {}),
          }
        : message.screenshotPath
          ? { screenshotPath: message.screenshotPath }
          : {}),
    });
  }

  private handleHello(lease: HostLease, hello: StandaloneHostHello): void {
    if (
      hello.protocolVersion !== LIVE_HOST_PROTOCOL_VERSION ||
      hello.bundleId !== LIVE_HOST_BUNDLE_ID ||
      (lease.hello && lease.hello.instanceNonce !== hello.instanceNonce)
    ) {
      this.lastHostFailure = 'host_version';
      this.detachHost(lease, 'host_version');
      lease.socket.close(4006, 'Incompatible Live Host.');
      return;
    }
    lease.hello = hello;
    lease.lastPongAt = this.now();
    this.hadConnectedHost = true;
    this.lastHostFailure = undefined;
    this.debug('host.ready', {
      hostVersion: hello.hostVersion,
      protocolVersion: hello.protocolVersion,
      microphone: hello.permissions.microphone,
      camera: hello.permissions.camera,
      accessibility: hello.permissions.accessibility,
      screenRecording: hello.permissions.screenRecording,
      audioInput: hello.selfChecks.audioInput,
      audioOutput: hello.selfChecks.audioOutput,
      appshot: hello.selfChecks.appshot,
    });
    clearTimeout(lease.helloTimer);
    if (!lease.heartbeatTimer) {
      lease.heartbeatTimer = setInterval(
        () => this.heartbeat(lease),
        this.heartbeatIntervalMs,
      );
      lease.heartbeatTimer.unref?.();
    }
    try {
      void Promise.resolve(this.handlers.onHostReady?.()).catch(
        () => undefined,
      );
    } catch {
      /* readiness remains fail-closed until a later Host hello */
    }
    const status = this.getStatus();
    const memory = this.memoryState();
    this.sendHost({
      type: 'host.welcome',
      ...(this.host?.hello?.subagentsV1 && this.options.getSubagents
        ? { subagentsV1: this.options.getSubagents() }
        : {}),
      protocolVersion: LIVE_HOST_PROTOCOL_VERSION,
      daemonInstanceNonce: this.daemonInstanceNonce,
      ...(this.options.getUiLanguage
        ? { uiLanguageV1: this.options.getUiLanguage() }
        : {}),
      ...(this.options.daemonShutdownV1
        ? { daemonShutdownV1: true as const }
        : {}),
      heartbeatIntervalMs: this.heartbeatIntervalMs,
      epoch: this.nextEpoch,
      ...(hello.capabilities?.outputAudioEndMarkerV1 === true
        ? { capabilities: { outputAudioEndMarkerV1: true as const } }
        : {}),
      visualInput: { ...this.visualInput },
      status: projectStatusForHost(status),
      ...(memory ? { memory } : {}),
    });
    this.sendState(status);
  }

  private handlePlaybackStarted(message: LiveHostPlaybackStarted): void {
    const call = this.call;
    if (
      !call ||
      call.epoch !== message.epoch ||
      !this.outputAudio.has(message.outputId) ||
      this.outputMuted
    ) {
      return;
    }
    if (this.playbackStartedNotified) return;
    this.playbackStartedNotified = true;
    this.handlers.onPlaybackStarted?.({ epoch: call.epoch });
  }

  private handlePlaybackCompleted(message: LiveHostPlaybackCompleted): void {
    const call = this.call;
    if (
      !call ||
      call.epoch !== message.epoch ||
      !this.outputAudio.has(message.outputId) ||
      this.outputMuted
    ) {
      return;
    }
    const output = this.outputAudio.get(message.outputId);
    if (!output) return;
    if (this.supportsOutputAudioEndMarker() && !output.finished) return;
    output.drained = true;
    if (output.finished) this.completeOutputAudio(call, message.outputId);
  }

  private completeOutputAudio(call: LiveCall, outputId: number): void {
    this.outputAudio.delete(outputId);
    if (this.writableOutputId === outputId) this.writableOutputId = undefined;
    if (this.outputAudio.size > 0) return;
    this.playbackStartedNotified = false;
    this.handlers.onPlaybackCompleted?.({ epoch: call.epoch });
  }

  private resetOutputAudio(): void {
    this.writableOutputId = undefined;
    this.outputAudio.clear();
    this.playbackStartedNotified = false;
  }

  private handleVisualFrame(message: LiveHostVisualFrame): void {
    const call = this.call;
    if (
      !call ||
      call.epoch !== message.epoch ||
      call.state === 'stopping' ||
      this.visualInput.mode !== 'live-feed' ||
      this.visualInput.source !== message.source
    ) {
      return;
    }
    try {
      const accepted =
        this.handlers.onInputImage?.({
          epoch: call.epoch,
          callId: call.callId,
          source: message.source,
          image: message.image,
        }) ?? false;
      this.debug('visual.frame', {
        epoch: call.epoch,
        source: message.source,
        bytes: Buffer.byteLength(message.image, 'base64'),
        accepted,
      });
    } catch (error) {
      this.debug('visual.frame', {
        epoch: call.epoch,
        source: message.source,
        accepted: false,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private handleVisualSettings(message: LiveHostVisualSettings): void {
    const call = this.call;
    if (
      message.epoch !== (call?.epoch ?? this.nextEpoch) ||
      call?.state === 'stopping'
    ) {
      return;
    }
    const hello = this.host?.hello;
    if (hello) {
      hello.permissions.camera = message.permissions.camera;
      hello.permissions.accessibility = message.permissions.accessibility;
      hello.permissions.screenRecording = message.permissions.screenRecording;
      hello.selfChecks.appshot = message.appshot;
    }
    const changed =
      this.visualInput.source !== message.source ||
      this.visualInput.mode !== message.mode;
    this.visualInput = {
      ...this.visualInput,
      source: message.source,
      mode: message.mode,
    };
    if (call && changed) {
      this.rejectPendingVisualCaptures(
        new Error('The visual settings changed before capture completed.'),
        call.epoch,
      );
    }
    this.debug('visual.settings', {
      epoch: message.epoch,
      source: message.source,
      mode: message.mode,
    });
    if (call && changed) {
      this.handlers.onVisualSettings?.({
        epoch: call.epoch,
        callId: call.callId,
        visualInput: { ...this.visualInput },
      });
    }
    this.broadcastState();
  }

  private handleAction(action: LiveHostAction): void {
    if (
      action.epoch !== undefined &&
      action.epoch !== (this.call?.epoch ?? this.nextEpoch)
    ) {
      this.sendHostError('stale_epoch', 'The Live action epoch is stale.');
      return;
    }
    switch (action.action) {
      case 'toggle':
        if (this.call) this.stop();
        else this.startFromHost('resume');
        return;
      case 'new':
        this.startFromHost('new');
        return;
      case 'stop':
        this.stop();
        return;
      case 'mute':
        this.setMute(action);
        return;
      default:
        return;
    }
  }

  private startFromHost(mode: 'resume' | 'new'): void {
    if (this.deactivating) return;
    try {
      this.start(mode);
    } catch (error) {
      if (error instanceof LiveUnavailableError) {
        this.debug('call.start_blocked', {
          mode,
          ...(error.status.blocker ? { blocker: error.status.blocker } : {}),
          ...(error.status.message ? { message: error.status.message } : {}),
        });
        this.sendState(error.status);
        return;
      }
      this.debug('call.start_failed', {
        mode,
        message: error instanceof Error ? error.message : String(error),
      });
      this.sendState({
        ...this.getStatus(),
        state: 'error',
        message: this.uiText('runtime.startFailed'),
      });
    }
  }

  private handleAudioFrame(lease: HostLease, data: RawData): void {
    if (!lease.hello) {
      lease.socket.close(1002, 'host.hello must precede audio.');
      return;
    }
    const audio = Buffer.isBuffer(data)
      ? data
      : Array.isArray(data)
        ? Buffer.concat(data)
        : Buffer.from(data);
    if (
      audio.byteLength <= LIVE_INPUT_AUDIO_EPOCH_BYTES ||
      audio.byteLength > MAX_HOST_AUDIO_WIRE_BYTES ||
      (audio.byteLength - LIVE_INPUT_AUDIO_EPOCH_BYTES) % 2 !== 0
    ) {
      lease.socket.close(1009, 'Invalid Live audio frame.');
      return;
    }
    const encodedEpoch = audio.readBigUInt64BE(0);
    if (encodedEpoch > BigInt(Number.MAX_SAFE_INTEGER)) {
      lease.socket.close(1009, 'Invalid Live audio frame.');
      return;
    }
    const epoch = Number(encodedEpoch);
    const call = this.call;
    if (
      !call ||
      epoch !== call.epoch ||
      call.state === 'stopping' ||
      this.inputMuted
    ) {
      return;
    }
    const pcm16 = audio.subarray(LIVE_INPUT_AUDIO_EPOCH_BYTES);
    try {
      const accepted = this.handlers.onInputAudio?.({
        epoch,
        callId: call.callId,
        pcm16: Buffer.from(pcm16),
      });
      if (accepted === false) {
        this.failCall(call.epoch, this.uiText('runtime.audioDropped'));
      }
    } catch {
      this.failCall(call.epoch, this.uiText('runtime.audioInputFailed'));
    }
  }

  private heartbeat(lease: HostLease): void {
    if (this.host !== lease) return;
    if (this.now() - lease.lastPongAt > this.heartbeatTimeoutMs) {
      this.disconnectHost(lease, 4008, 'Live Host heartbeat timed out.');
      return;
    }
    const pingId = randomUUID();
    lease.pingId = pingId;
    this.sendHost({ type: 'host.ping', pingId });
  }

  private finishCall(call: LiveCall): void {
    if (this.call !== call) return;
    this.pendingStartMode = undefined;
    call.state = 'stopping';
    this.sendState(this.buildStatus(false));
    this.clearOutput(call.epoch);
    this.call = undefined;
    this.notifyInactive();
    this.rejectPendingVisualCaptures(
      new Error('The Live call ended before visual capture completed.'),
      call.epoch,
    );
    ++this.nextEpoch;
    try {
      void Promise.resolve(
        this.handlers.onStop?.({ epoch: call.epoch, callId: call.callId }),
      ).catch(() => {});
    } catch {
      // The call is already stopped. Handler failures cannot restore it.
    }
    this.broadcastState();
  }

  private beginCallStop(call: LiveCall): void {
    if (this.call !== call || call.state === 'stopping') return;
    call.state = 'stopping';
    this.sendState(this.buildStatus(false));
    this.clearOutput(call.epoch);
    let result: void | { error: string } | Promise<void | { error: string }>;
    try {
      result = this.handlers.onStop?.({
        epoch: call.epoch,
        callId: call.callId,
      });
    } catch {
      this.failStoppingCall(call, this.uiText('runtime.stopFailed'));
      return;
    }
    if (!result || !('then' in result)) {
      this.finishStoppingCall(call, result);
      return;
    }
    void Promise.resolve(result).then(
      (outcome) => this.finishStoppingCall(call, outcome),
      () => this.failStoppingCall(call, this.uiText('runtime.stopFailed')),
    );
  }

  private finishStoppingCall(
    call: LiveCall,
    outcome: void | { error: string },
  ): void {
    if (this.call !== call || call.state !== 'stopping') return;
    if (outcome?.error) {
      this.failStoppingCall(call, outcome.error);
      return;
    }
    this.call = undefined;
    this.resetOutputAudio();
    this.notifyInactive();
    this.rejectPendingVisualCaptures(
      new Error('The Live call ended before visual capture completed.'),
      call.epoch,
    );
    ++this.nextEpoch;
    const pendingStartMode = this.pendingStartMode;
    this.pendingStartMode = undefined;
    if (pendingStartMode) {
      const status = this.getStatus();
      if (status.available) {
        this.startCall(pendingStartMode);
        return;
      }
    }
    this.broadcastState();
  }

  private failStoppingCall(call: LiveCall, message: string): void {
    if (this.call !== call || call.state !== 'stopping') return;
    this.pendingStartMode = undefined;
    this.call = undefined;
    this.resetOutputAudio();
    this.notifyInactive();
    this.rejectPendingVisualCaptures(new Error(message), call.epoch);
    this.lastCallError = message;
    ++this.nextEpoch;
    this.broadcastState();
  }

  private stopForReadinessLoss(): void {
    const call = this.call;
    if (!call) return;
    this.pendingStartMode = undefined;
    this.beginCallStop(call);
  }

  private disconnectHost(lease: HostLease, code: number, reason: string): void {
    if (lease.socket.readyState === WebSocket.OPEN) {
      lease.socket.close(code, reason);
    }
    this.detachHost(lease, 'host_disconnected');
  }

  private detachHost(
    lease: HostLease,
    failure: 'host_disconnected' | 'host_version',
  ): void {
    if (this.host !== lease) return;
    this.host = undefined;
    this.clearLeaseTimers(lease);
    this.lastHostFailure = failure;
    this.rejectPendingVisualCaptures(new Error('Qwen Live Host disconnected.'));
    this.rejectPendingShortcut(new Error('Qwen Live Host disconnected.'));
    this.stopForReadinessLoss();
  }

  private rejectPendingShortcut(error: Error): void {
    const pending = this.pendingShortcut;
    if (!pending) return;
    this.pendingShortcut = undefined;
    clearTimeout(pending.timer);
    pending.reject(error);
  }

  private rejectPendingVisualCapture(requestId: string, error: Error): void {
    const pending = this.pendingVisualCaptures.get(requestId);
    if (!pending) return;
    this.pendingVisualCaptures.delete(requestId);
    clearTimeout(pending.timer);
    pending.reject(error);
  }

  private rejectPendingVisualCaptures(error: Error, epoch?: number): void {
    for (const [requestId, pending] of this.pendingVisualCaptures) {
      if (epoch !== undefined && pending.epoch !== epoch) continue;
      this.rejectPendingVisualCapture(requestId, error);
    }
  }

  private clearLeaseTimers(lease: HostLease): void {
    clearTimeout(lease.helloTimer);
    if (lease.heartbeatTimer) clearInterval(lease.heartbeatTimer);
  }

  private broadcastState(): void {
    this.sendState(this.getStatus());
  }

  private sendState(status: LiveStatus): void {
    const memory = this.memoryState();
    this.sendHost({
      type: 'host.state',
      ...(this.host?.hello?.subagentsV1 && this.options.getSubagents
        ? { subagentsV1: this.options.getSubagents() }
        : {}),
      epoch: this.nextEpoch,
      ...(this.options.getUiLanguage
        ? { uiLanguageV1: this.options.getUiLanguage() }
        : {}),
      visualInput: { ...this.visualInput },
      status: projectStatusForHost(status),
      ...(memory ? { memory } : {}),
    });
  }

  private sendHostError(
    code: Extract<LiveDaemonMessage, { type: 'host.error' }>['code'],
    message: string,
  ): void {
    this.sendHost({ type: 'host.error', code, message });
  }

  private sendHost(message: StandaloneDaemonMessage): boolean {
    const lease = this.host;
    const socket = lease?.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    if (socket.bufferedAmount > MAX_SOCKET_BUFFERED_BYTES) {
      this.disconnectHost(lease, 4008, 'Live Host is not consuming messages.');
      return false;
    }
    socket.send(JSON.stringify(message));
    return true;
  }

  private allocateOutputId(): number {
    if (this.nextOutputId >= Number.MAX_SAFE_INTEGER) {
      this.nextOutputId = 0;
    }
    this.nextOutputId += 1;
    return this.nextOutputId;
  }

  private supportsOutputAudioEndMarker(): boolean {
    return this.host?.hello?.capabilities?.outputAudioEndMarkerV1 === true;
  }

  private debug(event: string, details: Record<string, unknown>): void {
    this.logger.debug(`${event} ${JSON.stringify(details)}`);
  }

  private notifyInactive(): void {
    if (this.call) return;
    for (const resolve of this.inactiveWaiters) resolve();
    this.inactiveWaiters.clear();
  }
}
