export const LIVE_PROTOCOL_VERSION = 2;
export const LIVE_HOST_BUNDLE_ID = 'com.alibaba.qwen-code.live-host';
export const MAX_CONTROL_FRAME_BYTES = 64 * 1024;
export const MAX_INPUT_AUDIO_FRAME_BYTES = 64 * 1024;
export const INPUT_AUDIO_EPOCH_BYTES = 8;
export const MAX_INPUT_AUDIO_WIRE_FRAME_BYTES =
  INPUT_AUDIO_EPOCH_BYTES + MAX_INPUT_AUDIO_FRAME_BYTES;
export const MAX_OUTPUT_AUDIO_FRAME_BYTES = 256 * 1024;
export const MAX_SOCKET_BUFFERED_BYTES = 1024 * 1024;

export type PermissionState = 'granted' | 'denied' | 'not_determined';

export type HostPermissions = {
  microphone: PermissionState;
  inputMonitoring: PermissionState;
  accessibility: PermissionState;
  screenRecording: PermissionState;
};

export type HostSelfChecks = {
  audioInput: boolean;
  audioOutput: boolean;
  globalShortcut: boolean;
  appshot: boolean;
};

export type SessionLocator = {
  workspaceCwd: string;
  sessionId: string;
};

export type OpenSessionTarget = SessionLocator & {
  workspaceId: string;
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
  blocker?: string;
  message?: string;
  callId?: string;
  inputMuted?: boolean;
  outputMuted?: boolean;
  transcript?: string;
  coordinator?: SessionLocator;
  workers?: SessionLocator[];
  requirements?: Partial<
    Record<
      | 'host'
      | 'microphone'
      | 'inputMonitoring'
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
  installUrl?: string;
};

export type HostHello = {
  type: 'host.hello';
  protocolVersion: number;
  hostVersion: string;
  bundleId: typeof LIVE_HOST_BUNDLE_ID;
  instanceNonce: string;
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
    }
  | {
      type: 'host.action';
      action: 'open_session';
      locator: SessionLocator;
      epoch?: number;
    }
  | {
      type: 'host.action';
      action: 'request_permission';
      permission: keyof HostPermissions;
      epoch?: number;
    };

export type HostControlMessage =
  | HostHello
  | HostAction
  | { type: 'host.pong'; pingId: string };

export type DaemonControlMessage =
  | {
      type: 'host.welcome';
      protocolVersion: number;
      daemonInstanceNonce: string;
      heartbeatIntervalMs: number;
      epoch: number;
      status: LiveStatus;
    }
  | { type: 'host.state'; epoch: number; status: LiveStatus }
  | { type: 'host.ping'; pingId: string }
  | { type: 'host.clear_output'; epoch: number }
  | { type: 'host.open_session'; target: OpenSessionTarget }
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

function boundedString(
  value: unknown,
  maximumLength: number,
): string | undefined {
  return typeof value === 'string' && value.length <= maximumLength
    ? value
    : undefined;
}

function parseLocator(value: unknown): SessionLocator | undefined {
  if (!isRecord(value)) return undefined;
  const workspaceCwd = boundedString(value.workspaceCwd, 4096);
  const sessionId = boundedString(value.sessionId, 256);
  return workspaceCwd && sessionId ? { workspaceCwd, sessionId } : undefined;
}

function parseOpenSessionTarget(value: unknown): OpenSessionTarget | undefined {
  const locator = parseLocator(value);
  if (!locator || !isRecord(value)) return undefined;
  const workspaceId = boundedString(value.workspaceId, 256);
  return workspaceId ? { ...locator, workspaceId } : undefined;
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
  'inputMonitoring',
  'accessibility',
  'screenRecording',
  'audioInput',
  'audioOutput',
  'globalShortcut',
  'appshot',
  'provider',
] as const;

export function parseLiveStatus(value: unknown): LiveStatus | undefined {
  if (
    !isRecord(value) ||
    value.v !== 1 ||
    typeof value.available !== 'boolean'
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
  };
  const blocker = boundedString(value.blocker, 128);
  const message = boundedString(value.message, 1_024);
  const callId = boundedString(value.callId, 256);
  const transcript = boundedString(value.transcript, 8_192);
  const coordinator = parseLocator(value.coordinator);
  if (blocker) status.blocker = blocker;
  if (message) status.message = message;
  if (callId) status.callId = callId;
  if (transcript) status.transcript = transcript;
  if (coordinator) status.coordinator = coordinator;
  if (typeof value.inputMuted === 'boolean')
    status.inputMuted = value.inputMuted;
  if (typeof value.outputMuted === 'boolean')
    status.outputMuted = value.outputMuted;
  if (Array.isArray(value.workers)) {
    status.workers = value.workers.slice(0, 20).flatMap((worker) => {
      const locator = parseLocator(worker);
      return locator ? [locator] : [];
    });
  }
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
  const installUrl = boundedString(value.installUrl, 2_048);
  if (installUrl) status.installUrl = installUrl;
  return status;
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
    const status = parseLiveStatus(value.status);
    const daemonInstanceNonce = boundedString(value.daemonInstanceNonce, 256);
    if (
      !Number.isSafeInteger(value.protocolVersion) ||
      !Number.isSafeInteger(value.heartbeatIntervalMs) ||
      !Number.isSafeInteger(value.epoch) ||
      Number(value.epoch) < 0 ||
      !daemonInstanceNonce ||
      !status
    ) {
      return undefined;
    }
    return {
      type: 'host.welcome',
      protocolVersion: Number(value.protocolVersion),
      daemonInstanceNonce,
      heartbeatIntervalMs: Math.min(
        30_000,
        Math.max(1_000, Number(value.heartbeatIntervalMs)),
      ),
      epoch: Number(value.epoch),
      status,
    };
  }

  if (value.type === 'host.state') {
    const status = parseLiveStatus(value.status);
    return status &&
      Number.isSafeInteger(value.epoch) &&
      Number(value.epoch) >= 0
      ? { type: 'host.state', epoch: Number(value.epoch), status }
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

  if (value.type === 'host.open_session') {
    const target = parseOpenSessionTarget(value.target);
    return target ? { type: 'host.open_session', target } : undefined;
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
  const encoded = JSON.stringify(message);
  if (Buffer.byteLength(encoded, 'utf8') > MAX_CONTROL_FRAME_BYTES) {
    throw new Error('Live Host control frame exceeds the protocol limit');
  }
  return encoded;
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
