import { isLiveLanguage, type LiveLanguage } from '@qwen-code/qwen-live/i18n';
import {
  parseSubagentsSnapshot,
  type SubagentsSnapshot,
} from '@qwen-code/qwen-live/subagents';

export const LIVE_PROTOCOL_VERSION = 9;
export const LIVE_HOST_BUNDLE_ID = 'com.alibaba.qwen-code.live-host';
export const MAX_CONTROL_FRAME_BYTES = 512 * 1024;
export const MAX_INPUT_AUDIO_FRAME_BYTES = 64 * 1024;
export const MAX_INPUT_IMAGE_FRAME_BYTES = 190 * 1024;
export const MAX_CAPTURE_ASSET_BYTES = 8 * 1024 * 1024;
export const INPUT_AUDIO_EPOCH_BYTES = 8;
export const MAX_INPUT_AUDIO_WIRE_FRAME_BYTES =
  INPUT_AUDIO_EPOCH_BYTES + MAX_INPUT_AUDIO_FRAME_BYTES;
export const MAX_OUTPUT_AUDIO_FRAME_BYTES = 256 * 1024;
export const OUTPUT_AUDIO_EPOCH_BYTES = 8;
export const OUTPUT_AUDIO_ID_BYTES = 8;
export const OUTPUT_AUDIO_HEADER_BYTES =
  OUTPUT_AUDIO_EPOCH_BYTES + OUTPUT_AUDIO_ID_BYTES;
export const MAX_OUTPUT_AUDIO_WIRE_FRAME_BYTES =
  OUTPUT_AUDIO_HEADER_BYTES + MAX_OUTPUT_AUDIO_FRAME_BYTES;
export const MAX_SOCKET_BUFFERED_BYTES = 1024 * 1024;
export const MAX_REALTIME_VISUAL_WIDTH = 1920;
export const MAX_REALTIME_VISUAL_HEIGHT = 1080;
export const MIN_VISUAL_WIDTH = 160;
export const MAX_VISUAL_WIDTH = 7680;
export const MIN_VISUAL_HEIGHT = 120;
export const MAX_VISUAL_HEIGHT = 4320;

export type VisualSource = 'screen' | 'camera';
export type VisualMode = 'on-demand' | 'live-feed';
export type UiLanguageState = { language: LiveLanguage };

function parseUiLanguageState(value: unknown): UiLanguageState | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return undefined;
  const language = (value as Record<string, unknown>).language;
  return isLiveLanguage(language) ? { language } : undefined;
}

export type MemoryState = {
  enabled: boolean;
  visualEnabled: boolean;
  libraryId: string;
  model: string;
  libraries: Array<{ id: string; name: string }>;
  locked: boolean;
  error?: string;
};

export type MemoryAction =
  | { action: 'set_enabled'; enabled: boolean }
  | { action: 'set_visual_enabled'; enabled: boolean }
  | { action: 'select'; libraryId: string }
  | { action: 'create'; name: string }
  | { action: 'rename'; libraryId: string; name: string }
  | { action: 'set_model'; model: string };

export type MemoryResult =
  | {
      type: 'host.memory_result';
      requestId: string;
      ok: true;
      memory: MemoryState;
    }
  | {
      type: 'host.memory_result';
      requestId: string;
      ok: false;
      error: string;
      memory?: MemoryState;
    };

export type VisualInput = {
  source: VisualSource;
  mode: VisualMode;
  fps: number;
  cameraWidth?: number;
  cameraHeight?: number;
  cameraSnapshotWidth?: number;
  cameraSnapshotHeight?: number;
  liveWidth: number;
  liveHeight: number;
  snapshotWidth?: number;
  snapshotHeight?: number;
};

export type PlaybackIdentity = {
  epoch: number;
  outputId: number;
};

export type HostCapabilities = {
  outputAudioEndMarkerV1: true;
};

export type OutputAudioFrame = PlaybackIdentity & {
  audio: Uint8Array;
};

export function fitRealtimeVisualDimensions(
  sourceWidth: number,
  sourceHeight: number,
  maximumWidth?: number,
  maximumHeight?: number,
): { width: number; height: number } {
  const widthLimit = Math.min(
    maximumWidth ?? MAX_REALTIME_VISUAL_WIDTH,
    MAX_REALTIME_VISUAL_WIDTH,
  );
  const heightLimit = Math.min(
    maximumHeight ?? MAX_REALTIME_VISUAL_HEIGHT,
    MAX_REALTIME_VISUAL_HEIGHT,
  );
  const scale = Math.min(
    1,
    widthLimit / sourceWidth,
    heightLimit / sourceHeight,
  );
  return {
    width: Math.max(1, Math.round(sourceWidth * scale)),
    height: Math.max(1, Math.round(sourceHeight * scale)),
  };
}

export type PermissionState = 'granted' | 'denied' | 'not_determined';

export type HostPermissions = {
  microphone: PermissionState;
  camera: PermissionState;
  accessibility: PermissionState;
  screenRecording: PermissionState;
};

export type HostSelfChecks = {
  audioInput: boolean;
  audioOutput: boolean;
  globalShortcut: boolean;
  appshot: boolean;
};

export type LiveCallState =
  | 'unavailable'
  | 'idle'
  | 'starting'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'stopping'
  | 'error';

export type LiveStatus = {
  v: 1;
  available: boolean;
  state: LiveCallState;
  shortcut: string;
  blocker?: string;
  message?: string;
  callId?: string;
  inputMuted?: boolean;
  outputMuted?: boolean;
  transcript?: string;
  caption?: string;
  statusText?: string;
  pendingPermission?: {
    workspaceId: string;
    sessionId: string;
  };
  requirements?: Partial<
    Record<
      | 'host'
      | 'microphone'
      | 'camera'
      | 'accessibility'
      | 'screenRecording'
      | 'audioInput'
      | 'audioOutput'
      | 'globalShortcut'
      | 'appshot'
      | 'provider',
      'ready' | 'missing' | 'denied' | 'unavailable' | 'checking'
    >
  >;
  host?: { version?: string; protocolVersion?: number };
};

export type HostHello = {
  type: 'host.hello';
  subagentsV1?: true;
  protocolVersion: number;
  hostVersion: string;
  bundleId: typeof LIVE_HOST_BUNDLE_ID;
  instanceNonce: string;
  capabilities?: HostCapabilities;
  permissions: HostPermissions;
  selfChecks: HostSelfChecks;
};

export type HostAction =
  | { type: 'host.action'; action: 'toggle' | 'new' | 'stop'; epoch?: number }
  | {
      type: 'host.action';
      action: 'mute';
      inputMuted: boolean;
      outputMuted: boolean;
      epoch?: number;
    };

export type HostControlMessage =
  | HostHello
  | HostAction
  | {
      type: 'host.language_action';
      requestId: string;
      epoch: number;
      language: LiveLanguage;
    }
  | (MemoryAction & {
      type: 'host.memory_action';
      requestId: string;
      epoch: number;
    })
  | { type: 'host.pong'; pingId: string }
  | {
      type: 'host.shortcut_result';
      requestId: string;
      shortcut: string;
      success: boolean;
      error?: string;
    }
  | { type: 'host.playback_started'; epoch: number; outputId: number }
  | { type: 'host.playback_completed'; epoch: number; outputId: number }
  | {
      type: 'host.visual_frame';
      epoch: number;
      source: VisualSource;
      image: string;
    }
  | {
      type: 'host.visual_settings';
      epoch: number;
      source: VisualSource;
      mode: VisualMode;
      permissions: Pick<
        HostPermissions,
        'camera' | 'accessibility' | 'screenRecording'
      >;
      appshot: boolean;
    }
  | {
      type: 'host.visual_capture_result';
      requestId: string;
      success: true;
      source: 'screen';
      image: string;
      width: number;
      height: number;
      appName: string;
      windowTitle?: string;
      accessibilityText: string;
      screenshotPath?: string;
    }
  | {
      type: 'host.visual_capture_result';
      requestId: string;
      success: true;
      source: 'camera';
      image: string;
      width: number;
      height: number;
      screenshotPath?: string;
    }
  | {
      type: 'host.visual_capture_result';
      requestId: string;
      success: false;
      error: string;
    };

export type DaemonControlMessage =
  | {
      type: 'host.welcome';
      protocolVersion: number;
      daemonInstanceNonce: string;
      daemonShutdownV1?: true;
      heartbeatIntervalMs: number;
      epoch: number;
      capabilities?: HostCapabilities;
      visualInput?: VisualInput;
      memory?: MemoryState;
      uiLanguageV1?: UiLanguageState;
      subagentsV1?: SubagentsSnapshot;
      status: LiveStatus;
    }
  | {
      type: 'host.state';
      epoch: number;
      visualInput?: VisualInput;
      memory?: MemoryState;
      uiLanguageV1?: UiLanguageState;
      subagentsV1?: SubagentsSnapshot;
      status: LiveStatus;
    }
  | { type: 'host.subagents'; subagentsV1: SubagentsSnapshot }
  | {
      type: 'host.language_result';
      requestId: string;
      ok: true;
      uiLanguageV1: UiLanguageState;
    }
  | {
      type: 'host.language_result';
      requestId: string;
      ok: false;
      error: string;
      uiLanguageV1?: UiLanguageState;
    }
  | MemoryResult
  | { type: 'host.ping'; pingId: string }
  | { type: 'host.clear_output'; epoch: number }
  | { type: 'host.output_audio_finished'; epoch: number; outputId: number }
  | { type: 'host.set_shortcut'; requestId: string; shortcut: string }
  | {
      type: 'host.capture_visual';
      requestId: string;
      epoch: number;
      source: VisualSource;
      snapshotWidth?: number;
      snapshotHeight?: number;
      persistAsset?: boolean;
    }
  | { type: 'host.error'; code: string; message?: string };

const LIVE_STATES = new Set<LiveCallState>([
  'unavailable',
  'idle',
  'starting',
  'listening',
  'thinking',
  'speaking',
  'stopping',
  'error',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseHostCapabilities(value: unknown): HostCapabilities | undefined {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 1 ||
    value.outputAudioEndMarkerV1 !== true
  ) {
    return undefined;
  }
  return { outputAudioEndMarkerV1: true };
}

function boundedString(
  value: unknown,
  maximumLength: number,
): string | undefined {
  return typeof value === 'string' && value.length <= maximumLength
    ? value
    : undefined;
}

const MEMORY_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function memoryName(value: unknown, maximumLength: number): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    Array.from(value).length <= maximumLength &&
    !/\p{C}/u.test(value)
  );
}

export function parseMemoryAction(value: unknown): MemoryAction | undefined {
  if (!isRecord(value)) return undefined;
  switch (value.action) {
    case 'set_enabled':
    case 'set_visual_enabled':
      return typeof value.enabled === 'boolean'
        ? { action: value.action, enabled: value.enabled }
        : undefined;
    case 'select':
      return typeof value.libraryId === 'string' &&
        MEMORY_ID.test(value.libraryId)
        ? { action: value.action, libraryId: value.libraryId }
        : undefined;
    case 'create':
      return memoryName(value.name, 80)
        ? { action: value.action, name: value.name.trim() }
        : undefined;
    case 'rename':
      return typeof value.libraryId === 'string' &&
        MEMORY_ID.test(value.libraryId) &&
        memoryName(value.name, 80)
        ? {
            action: value.action,
            libraryId: value.libraryId,
            name: value.name.trim(),
          }
        : undefined;
    case 'set_model':
      return memoryName(value.model, 256)
        ? { action: value.action, model: value.model.trim() }
        : undefined;
    default:
      return undefined;
  }
}

export function parseMemoryState(value: unknown): MemoryState | undefined {
  if (
    !isRecord(value) ||
    typeof value.enabled !== 'boolean' ||
    typeof value.visualEnabled !== 'boolean' ||
    typeof value.locked !== 'boolean' ||
    typeof value.libraryId !== 'string' ||
    !MEMORY_ID.test(value.libraryId) ||
    !memoryName(value.model, 256) ||
    !Array.isArray(value.libraries) ||
    (value.error !== undefined &&
      boundedString(value.error, 1024) === undefined)
  ) {
    return undefined;
  }
  const libraries: MemoryState['libraries'] = [];
  const seen = new Set<string>();
  for (const library of value.libraries) {
    if (
      !isRecord(library) ||
      typeof library.id !== 'string' ||
      !MEMORY_ID.test(library.id) ||
      !memoryName(library.name, 80) ||
      seen.has(library.id)
    ) {
      return undefined;
    }
    seen.add(library.id);
    libraries.push({ id: library.id, name: library.name });
  }
  return {
    enabled: value.enabled,
    visualEnabled: value.visualEnabled,
    libraryId: value.libraryId,
    model: value.model,
    libraries,
    locked: value.locked,
    ...(typeof value.error === 'string' ? { error: value.error } : {}),
  };
}

const REQUIREMENT_STATES = new Set([
  'ready',
  'missing',
  'denied',
  'unavailable',
  'checking',
]);

const REQUIREMENT_KEYS = [
  'host',
  'microphone',
  'camera',
  'accessibility',
  'screenRecording',
  'audioInput',
  'audioOutput',
  'globalShortcut',
  'appshot',
  'provider',
] as const;

export function parseLiveStatus(value: unknown): LiveStatus | undefined {
  const shortcut = isRecord(value)
    ? boundedString(value.shortcut, 128)
    : undefined;
  if (
    !isRecord(value) ||
    value.v !== 1 ||
    typeof value.available !== 'boolean' ||
    shortcut === undefined
  ) {
    return undefined;
  }
  if (
    typeof value.state !== 'string' ||
    !LIVE_STATES.has(value.state as LiveCallState)
  ) {
    return undefined;
  }

  const status: LiveStatus = {
    v: 1,
    available: value.available,
    state: value.state as LiveCallState,
    shortcut,
  };
  const blocker = boundedString(value.blocker, 128);
  const message = boundedString(value.message, 1_024);
  const callId = boundedString(value.callId, 256);
  const transcript = boundedString(value.transcript, 8_192);
  const caption = boundedString(value.caption, 8_192);
  const statusText = boundedString(value.statusText, 512);
  if (blocker) status.blocker = blocker;
  if (message) status.message = message;
  if (callId) status.callId = callId;
  if (transcript) status.transcript = transcript;
  if (caption) status.caption = caption;
  if (statusText) status.statusText = statusText;
  if (isRecord(value.pendingPermission)) {
    const workspaceId = boundedString(value.pendingPermission.workspaceId, 512);
    const sessionId = boundedString(value.pendingPermission.sessionId, 256);
    if (workspaceId && sessionId) {
      status.pendingPermission = { workspaceId, sessionId };
    }
  }
  if (typeof value.inputMuted === 'boolean')
    status.inputMuted = value.inputMuted;
  if (typeof value.outputMuted === 'boolean')
    status.outputMuted = value.outputMuted;
  if (isRecord(value.requirements)) {
    const requirements: NonNullable<LiveStatus['requirements']> = {};
    for (const key of REQUIREMENT_KEYS) {
      const requirement = value.requirements[key];
      if (
        typeof requirement === 'string' &&
        REQUIREMENT_STATES.has(requirement)
      ) {
        requirements[key] = requirement as NonNullable<
          LiveStatus['requirements']
        >[typeof key];
      }
    }
    status.requirements = requirements;
  }
  if (isRecord(value.host)) {
    const version = boundedString(value.host.version, 128);
    const protocolVersion = Number.isSafeInteger(value.host.protocolVersion)
      ? Number(value.host.protocolVersion)
      : undefined;
    status.host = {
      ...(version ? { version } : {}),
      ...(protocolVersion !== undefined ? { protocolVersion } : {}),
    };
  }
  return status;
}

function parseVisualInput(value: unknown): VisualInput | undefined {
  if (!isRecord(value)) return undefined;
  const source = value.source;
  const mode = value.mode;
  const cameraWidth = value.cameraWidth;
  const cameraHeight = value.cameraHeight;
  const hasCameraSize = cameraWidth !== undefined || cameraHeight !== undefined;
  const cameraSnapshotWidth = value.cameraSnapshotWidth;
  const cameraSnapshotHeight = value.cameraSnapshotHeight;
  const hasCameraSnapshotSize =
    cameraSnapshotWidth !== undefined || cameraSnapshotHeight !== undefined;
  const snapshotWidth = value.snapshotWidth;
  const snapshotHeight = value.snapshotHeight;
  const hasSnapshotSize =
    snapshotWidth !== undefined || snapshotHeight !== undefined;
  if (
    (source !== 'screen' && source !== 'camera') ||
    (mode !== 'on-demand' && mode !== 'live-feed') ||
    typeof value.fps !== 'number' ||
    !Number.isFinite(value.fps) ||
    value.fps < 0.1 ||
    value.fps > 10 ||
    (hasCameraSize &&
      (!Number.isInteger(cameraWidth) ||
        Number(cameraWidth) < MIN_VISUAL_WIDTH ||
        Number(cameraWidth) > 3840 ||
        !Number.isInteger(cameraHeight) ||
        Number(cameraHeight) < MIN_VISUAL_HEIGHT ||
        Number(cameraHeight) > 2160)) ||
    (hasCameraSnapshotSize &&
      (!Number.isInteger(cameraSnapshotWidth) ||
        Number(cameraSnapshotWidth) < MIN_VISUAL_WIDTH ||
        Number(cameraSnapshotWidth) > MAX_VISUAL_WIDTH ||
        !Number.isInteger(cameraSnapshotHeight) ||
        Number(cameraSnapshotHeight) < MIN_VISUAL_HEIGHT ||
        Number(cameraSnapshotHeight) > MAX_VISUAL_HEIGHT)) ||
    !Number.isInteger(value.liveWidth) ||
    Number(value.liveWidth) < MIN_VISUAL_WIDTH ||
    Number(value.liveWidth) > 3840 ||
    !Number.isInteger(value.liveHeight) ||
    Number(value.liveHeight) < MIN_VISUAL_HEIGHT ||
    Number(value.liveHeight) > 2160 ||
    (hasSnapshotSize &&
      (!Number.isInteger(snapshotWidth) ||
        Number(snapshotWidth) < MIN_VISUAL_WIDTH ||
        Number(snapshotWidth) > MAX_VISUAL_WIDTH ||
        !Number.isInteger(snapshotHeight) ||
        Number(snapshotHeight) < MIN_VISUAL_HEIGHT ||
        Number(snapshotHeight) > MAX_VISUAL_HEIGHT))
  ) {
    return undefined;
  }
  return {
    source,
    mode,
    fps: value.fps,
    ...(typeof cameraWidth === 'number' ? { cameraWidth } : {}),
    ...(typeof cameraHeight === 'number' ? { cameraHeight } : {}),
    ...(typeof cameraSnapshotWidth === 'number' ? { cameraSnapshotWidth } : {}),
    ...(typeof cameraSnapshotHeight === 'number'
      ? { cameraSnapshotHeight }
      : {}),
    liveWidth: Number(value.liveWidth),
    liveHeight: Number(value.liveHeight),
    ...(typeof snapshotWidth === 'number' ? { snapshotWidth } : {}),
    ...(typeof snapshotHeight === 'number' ? { snapshotHeight } : {}),
  };
}

export function parseDaemonControlMessage(
  data: string,
): DaemonControlMessage | undefined {
  if (Buffer.byteLength(data, 'utf8') > MAX_CONTROL_FRAME_BYTES)
    return undefined;

  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || typeof value.type !== 'string') return undefined;

  if (value.type === 'host.welcome') {
    const uiLanguageV1 = parseUiLanguageState(value.uiLanguageV1);
    const subagentsV1 = parseSubagentsSnapshot(value.subagentsV1);
    const status = parseLiveStatus(value.status);
    const daemonInstanceNonce = boundedString(value.daemonInstanceNonce, 256);
    const capabilities =
      value.capabilities === undefined
        ? undefined
        : parseHostCapabilities(value.capabilities);
    const visualInput =
      value.visualInput === undefined
        ? undefined
        : parseVisualInput(value.visualInput);
    const memory =
      value.memory === undefined ? undefined : parseMemoryState(value.memory);
    if (
      !Number.isSafeInteger(value.protocolVersion) ||
      !Number.isSafeInteger(value.heartbeatIntervalMs) ||
      !Number.isSafeInteger(value.epoch) ||
      Number(value.epoch) < 0 ||
      !daemonInstanceNonce ||
      (value.daemonShutdownV1 !== undefined &&
        value.daemonShutdownV1 !== true) ||
      (value.capabilities !== undefined && !capabilities) ||
      (value.visualInput !== undefined && !visualInput) ||
      (value.memory !== undefined && !memory) ||
      (value.uiLanguageV1 !== undefined && !uiLanguageV1) ||
      (value.subagentsV1 !== undefined && !subagentsV1) ||
      !status
    ) {
      return undefined;
    }
    return {
      type: 'host.welcome',
      protocolVersion: Number(value.protocolVersion),
      daemonInstanceNonce,
      ...(value.daemonShutdownV1 === true
        ? { daemonShutdownV1: true as const }
        : {}),
      heartbeatIntervalMs: Math.min(
        30_000,
        Math.max(1_000, Number(value.heartbeatIntervalMs)),
      ),
      epoch: Number(value.epoch),
      ...(capabilities ? { capabilities } : {}),
      ...(visualInput ? { visualInput } : {}),
      ...(memory ? { memory } : {}),
      ...(uiLanguageV1 ? { uiLanguageV1 } : {}),
      ...(subagentsV1 ? { subagentsV1 } : {}),
      status,
    };
  }

  if (value.type === 'host.state') {
    const uiLanguageV1 = parseUiLanguageState(value.uiLanguageV1);
    const subagentsV1 = parseSubagentsSnapshot(value.subagentsV1);
    const status = parseLiveStatus(value.status);
    const visualInput =
      value.visualInput === undefined
        ? undefined
        : parseVisualInput(value.visualInput);
    const memory =
      value.memory === undefined ? undefined : parseMemoryState(value.memory);
    return status &&
      Number.isSafeInteger(value.epoch) &&
      Number(value.epoch) >= 0 &&
      (value.visualInput === undefined || visualInput) &&
      (value.memory === undefined || memory) &&
      (value.uiLanguageV1 === undefined || uiLanguageV1) &&
      (value.subagentsV1 === undefined || subagentsV1)
      ? {
          type: 'host.state',
          epoch: Number(value.epoch),
          ...(visualInput ? { visualInput } : {}),
          ...(memory ? { memory } : {}),
          ...(uiLanguageV1 ? { uiLanguageV1 } : {}),
          ...(subagentsV1 ? { subagentsV1 } : {}),
          status,
        }
      : undefined;
  }

  if (value.type === 'host.subagents') {
    const subagentsV1 = parseSubagentsSnapshot(value.subagentsV1);
    return subagentsV1 ? { type: 'host.subagents', subagentsV1 } : undefined;
  }

  if (value.type === 'host.language_result') {
    const requestId = boundedString(value.requestId, 128);
    const uiLanguageV1 = parseUiLanguageState(value.uiLanguageV1);
    if (!requestId || (value.uiLanguageV1 !== undefined && !uiLanguageV1))
      return undefined;
    if (value.ok === true && uiLanguageV1)
      return {
        type: 'host.language_result',
        requestId,
        ok: true,
        uiLanguageV1,
      };
    const error = boundedString(value.error, 1024);
    return value.ok === false && error
      ? {
          type: 'host.language_result',
          requestId,
          ok: false,
          error,
          ...(uiLanguageV1 ? { uiLanguageV1 } : {}),
        }
      : undefined;
  }

  if (value.type === 'host.memory_result') {
    const requestId = boundedString(value.requestId, 128);
    const memory =
      value.memory === undefined ? undefined : parseMemoryState(value.memory);
    if (!requestId || (value.memory !== undefined && !memory)) return undefined;
    if (value.ok === true && memory) {
      return { type: 'host.memory_result', requestId, ok: true, memory };
    }
    const error = boundedString(value.error, 1024);
    return value.ok === false && error
      ? {
          type: 'host.memory_result',
          requestId,
          ok: false,
          error,
          ...(memory ? { memory } : {}),
        }
      : undefined;
  }

  if (value.type === 'host.ping') {
    const pingId = boundedString(value.pingId, 128);
    return pingId ? { type: 'host.ping', pingId } : undefined;
  }

  if (value.type === 'host.clear_output') {
    return Number.isSafeInteger(value.epoch) && Number(value.epoch) >= 0
      ? { type: 'host.clear_output', epoch: Number(value.epoch) }
      : undefined;
  }

  if (value.type === 'host.output_audio_finished') {
    return Number.isSafeInteger(value.epoch) &&
      Number(value.epoch) >= 0 &&
      Number.isSafeInteger(value.outputId) &&
      Number(value.outputId) >= 0
      ? {
          type: 'host.output_audio_finished',
          epoch: Number(value.epoch),
          outputId: Number(value.outputId),
        }
      : undefined;
  }

  if (value.type === 'host.set_shortcut') {
    const requestId = boundedString(value.requestId, 128);
    const shortcut = boundedString(value.shortcut, 128);
    return requestId && shortcut !== undefined
      ? { type: 'host.set_shortcut', requestId, shortcut }
      : undefined;
  }

  if (value.type === 'host.capture_visual') {
    const requestId = boundedString(value.requestId, 128);
    const source = value.source;
    const snapshotWidth = value.snapshotWidth;
    const snapshotHeight = value.snapshotHeight;
    const persistAsset = value.persistAsset;
    const hasSnapshotSize =
      snapshotWidth !== undefined || snapshotHeight !== undefined;
    return requestId &&
      Number.isSafeInteger(value.epoch) &&
      Number(value.epoch) >= 0 &&
      (source === 'screen' || source === 'camera') &&
      (!hasSnapshotSize ||
        (Number.isInteger(snapshotWidth) &&
          Number(snapshotWidth) >= MIN_VISUAL_WIDTH &&
          Number(snapshotWidth) <= MAX_VISUAL_WIDTH &&
          Number.isInteger(snapshotHeight) &&
          Number(snapshotHeight) >= MIN_VISUAL_HEIGHT &&
          Number(snapshotHeight) <= MAX_VISUAL_HEIGHT)) &&
      (persistAsset === undefined || typeof persistAsset === 'boolean')
      ? {
          type: 'host.capture_visual',
          requestId,
          epoch: Number(value.epoch),
          source,
          ...(typeof snapshotWidth === 'number' ? { snapshotWidth } : {}),
          ...(typeof snapshotHeight === 'number' ? { snapshotHeight } : {}),
          ...(typeof persistAsset === 'boolean' ? { persistAsset } : {}),
        }
      : undefined;
  }

  if (value.type === 'host.error') {
    const code = boundedString(value.code, 128);
    const message = boundedString(value.message, 1_024);
    if (!code) return undefined;
    return message
      ? { type: 'host.error', code, message }
      : { type: 'host.error', code };
  }

  return undefined;
}

export function encodeHostControlMessage(message: HostControlMessage): string {
  if (
    message.type === 'host.hello' &&
    message.subagentsV1 !== undefined &&
    message.subagentsV1 !== true
  )
    throw new Error('Invalid subagents capability');
  if (
    message.type === 'host.language_action' &&
    (!isLiveLanguage(message.language) ||
      !boundedString(message.requestId, 128) ||
      !Number.isSafeInteger(message.epoch) ||
      message.epoch < 0)
  )
    throw new Error('Invalid Live Host language action');
  if (
    message.type === 'host.memory_action' &&
    (!Number.isSafeInteger(message.epoch) ||
      message.epoch < 0 ||
      !boundedString(message.requestId, 128) ||
      !parseMemoryAction(message))
  ) {
    throw new Error('Invalid Live Host memory action');
  }
  if (
    message.type === 'host.visual_frame' &&
    (!Number.isSafeInteger(message.epoch) ||
      message.epoch < 0 ||
      (message.source !== 'screen' && message.source !== 'camera') ||
      !isValidInputImageFrame(message.image))
  ) {
    throw new Error('Invalid Live Host visual frame');
  }
  if (
    message.type === 'host.visual_settings' &&
    (!Number.isSafeInteger(message.epoch) ||
      message.epoch < 0 ||
      (message.source !== 'screen' && message.source !== 'camera') ||
      (message.mode !== 'on-demand' && message.mode !== 'live-feed') ||
      !['granted', 'denied', 'not_determined'].includes(
        message.permissions.camera,
      ) ||
      !['granted', 'denied', 'not_determined'].includes(
        message.permissions.accessibility,
      ) ||
      !['granted', 'denied', 'not_determined'].includes(
        message.permissions.screenRecording,
      ) ||
      typeof message.appshot !== 'boolean')
  ) {
    throw new Error('Invalid Live Host visual settings');
  }
  if (
    message.type === 'host.visual_capture_result' &&
    message.success &&
    (!isValidInputImageFrame(message.image) ||
      !Number.isSafeInteger(message.width) ||
      message.width <= 0 ||
      !Number.isSafeInteger(message.height) ||
      message.height <= 0)
  ) {
    throw new Error('Invalid Live Host visual capture');
  }
  const encoded = JSON.stringify(message);
  if (Buffer.byteLength(encoded, 'utf8') > MAX_CONTROL_FRAME_BYTES) {
    throw new Error('Live Host control frame exceeds the protocol limit');
  }
  return encoded;
}

export function isValidInputImageFrame(image: string): boolean {
  return isValidJpegImage(image, MAX_INPUT_IMAGE_FRAME_BYTES);
}

export function isValidCameraSnapshotAsset(image: string): boolean {
  return isValidJpegImage(image, MAX_CAPTURE_ASSET_BYTES);
}

function isValidJpegImage(image: string, maximumBytes: number): boolean {
  const maxBase64Chars = Math.ceil(maximumBytes / 3) * 4;
  if (
    image.length === 0 ||
    image.length > maxBase64Chars ||
    image.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(image)
  ) {
    return false;
  }
  const jpeg = Buffer.from(image, 'base64');
  return (
    jpeg.byteLength >= 4 &&
    jpeg.byteLength <= maximumBytes &&
    jpeg[0] === 0xff &&
    jpeg[1] === 0xd8 &&
    jpeg[jpeg.byteLength - 2] === 0xff &&
    jpeg[jpeg.byteLength - 1] === 0xd9 &&
    jpeg.toString('base64') === image
  );
}

export function isValidInputAudioFrame(frame: ArrayBufferView): boolean {
  return (
    frame.byteLength > 0 &&
    frame.byteLength <= MAX_INPUT_AUDIO_FRAME_BYTES &&
    frame.byteLength % 2 === 0
  );
}

export function encodeInputAudioFrame(
  epoch: number,
  pcm16: ArrayBufferView,
): Uint8Array | undefined {
  if (
    !Number.isSafeInteger(epoch) ||
    epoch < 0 ||
    !isValidInputAudioFrame(pcm16)
  ) {
    return undefined;
  }
  const frame = new Uint8Array(INPUT_AUDIO_EPOCH_BYTES + pcm16.byteLength);
  new DataView(frame.buffer).setBigUint64(0, BigInt(epoch), false);
  frame.set(
    new Uint8Array(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength),
    INPUT_AUDIO_EPOCH_BYTES,
  );
  return frame;
}

export function isValidOutputAudioFrame(frame: ArrayBufferView): boolean {
  return (
    frame.byteLength > 0 &&
    frame.byteLength <= MAX_OUTPUT_AUDIO_FRAME_BYTES &&
    frame.byteLength % 2 === 0
  );
}

export function encodeOutputAudioFrame(
  epoch: number,
  outputId: number,
  pcm16: ArrayBufferView,
): Uint8Array | undefined {
  if (
    !Number.isSafeInteger(epoch) ||
    epoch < 0 ||
    !Number.isSafeInteger(outputId) ||
    outputId < 0 ||
    !isValidOutputAudioFrame(pcm16)
  ) {
    return undefined;
  }
  const frame = new Uint8Array(OUTPUT_AUDIO_HEADER_BYTES + pcm16.byteLength);
  const header = new DataView(frame.buffer);
  header.setBigUint64(0, BigInt(epoch), false);
  header.setBigUint64(OUTPUT_AUDIO_EPOCH_BYTES, BigInt(outputId), false);
  frame.set(
    new Uint8Array(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength),
    OUTPUT_AUDIO_HEADER_BYTES,
  );
  return frame;
}

export function decodeOutputAudioFrame(
  frame: ArrayBufferView,
): OutputAudioFrame | undefined {
  if (
    frame.byteLength <= OUTPUT_AUDIO_HEADER_BYTES ||
    frame.byteLength > MAX_OUTPUT_AUDIO_WIRE_FRAME_BYTES
  ) {
    return undefined;
  }
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const epoch = view.getBigUint64(0, false);
  const outputId = view.getBigUint64(OUTPUT_AUDIO_EPOCH_BYTES, false);
  if (
    epoch > BigInt(Number.MAX_SAFE_INTEGER) ||
    outputId > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    return undefined;
  }
  const audio = new Uint8Array(
    frame.buffer,
    frame.byteOffset + OUTPUT_AUDIO_HEADER_BYTES,
    frame.byteLength - OUTPUT_AUDIO_HEADER_BYTES,
  );
  if (!isValidOutputAudioFrame(audio)) return undefined;
  return { epoch: Number(epoch), outputId: Number(outputId), audio };
}
