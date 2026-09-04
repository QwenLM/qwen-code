import { randomBytes, timingSafeEqual } from 'node:crypto';
import WebSocket, { type RawData } from 'ws';
import {
  LIVE_HOST_BUNDLE_ID,
  LIVE_PROTOCOL_VERSION,
  MAX_CONTROL_FRAME_BYTES,
  MAX_INPUT_AUDIO_WIRE_FRAME_BYTES,
  MAX_OUTPUT_AUDIO_FRAME_BYTES,
  MAX_SOCKET_BUFFERED_BYTES,
  encodeInputAudioFrame,
  encodeHostControlMessage,
  isValidOutputAudioFrame,
  parseDaemonControlMessage,
  type HostAction,
  type HostPermissions,
  type HostSelfChecks,
  type HostControlMessage,
  type LiveStatus,
} from '../shared/protocol.ts';
import {
  buildHostWebSocketUrl,
  buildWebShellSessionUrl,
  DiscoveryMonitor,
  resolveDiscoveryPath,
  type DiscoveryResult,
  type LiveDiscoveryRecord,
} from './discovery.ts';
import { BoundedReconnectPolicy } from './reconnect-policy.ts';

const HANDSHAKE_TIMEOUT_MS = 5_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000;
const EXHAUSTED_RETRY_DELAY_MS = 30_000;

export type ConnectionPhase =
  | 'disconnected'
  | 'connecting'
  | 'ready'
  | 'incompatible'
  | 'error';

export type ConnectionSnapshot = {
  phase: ConnectionPhase;
  error?: string;
  status?: LiveStatus;
};

export type HostReadiness = {
  permissions: HostPermissions;
  selfChecks: HostSelfChecks;
};

export function canSendHostControlMessage(
  message: Parameters<typeof encodeHostControlMessage>[0],
  socketOpen: boolean,
  welcomed: boolean,
  bufferedAmount: number,
): boolean {
  return (
    socketOpen &&
    (message.type === 'host.hello' || welcomed) &&
    bufferedAmount <= MAX_SOCKET_BUFFERED_BYTES
  );
}

type ConnectionCallbacks = {
  getReadiness: () => HostReadiness;
  onSnapshot: (snapshot: ConnectionSnapshot) => void;
  onOutputAudio: (audio: Uint8Array) => void;
  onClearOutput: () => void;
  setShortcut?: (shortcut: string) => { success: boolean; error?: string };
  captureScreenContext?: () => Promise<{
    appName: string;
    windowTitle?: string;
    accessibilityText: string;
    screenshotPath: string;
  }>;
};

type ScreenContextCapture = Awaited<
  ReturnType<NonNullable<ConnectionCallbacks['captureScreenContext']>>
>;

const MAX_APPSHOT_ERROR_CHARS = 1_024;

function screenContextResultMessage(
  requestId: string,
  result: ScreenContextCapture,
): HostControlMessage {
  const message = (accessibilityText: string): HostControlMessage => ({
    type: 'host.screen_context_result',
    requestId,
    success: true,
    ...result,
    accessibilityText,
  });
  const fits = (candidate: HostControlMessage) =>
    Buffer.byteLength(JSON.stringify(candidate), 'utf8') <=
    MAX_CONTROL_FRAME_BYTES;
  if (fits(message(result.accessibilityText))) {
    return message(result.accessibilityText);
  }
  let lower = 0;
  let upper = result.accessibilityText.length;
  while (lower < upper) {
    const middle = Math.ceil((lower + upper) / 2);
    if (fits(message(result.accessibilityText.slice(0, middle)))) {
      lower = middle;
    } else {
      upper = middle - 1;
    }
  }
  const bounded = message(result.accessibilityText.slice(0, lower));
  if (!fits(bounded)) {
    throw new Error('Appshot metadata exceeds the protocol limit.');
  }
  return bounded;
}

function rawDataToBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (Array.isArray(data)) return Buffer.concat(data);
  throw new Error('Unsupported WebSocket frame representation');
}

export class LiveDaemonConnection {
  private readonly hostInstanceNonce = randomBytes(24).toString('base64url');
  private readonly reconnectPolicy: BoundedReconnectPolicy;
  private readonly discovery: DiscoveryMonitor;
  private currentRecord: LiveDiscoveryRecord | undefined;
  private currentSignature = '';
  private socket: WebSocket | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private handshakeTimer: NodeJS.Timeout | undefined;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private intentionalClose = false;
  private welcomed = false;
  private epoch = 0;
  private heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS;
  private snapshot: ConnectionSnapshot = { phase: 'disconnected' };

  constructor(
    private readonly hostVersion: string,
    private readonly callbacks: ConnectionCallbacks,
    discoveryPath = resolveDiscoveryPath(),
    private readonly retryOptions: {
      policy?: BoundedReconnectPolicy;
      exhaustedRetryDelayMs?: number;
    } = {},
  ) {
    this.reconnectPolicy = retryOptions.policy ?? new BoundedReconnectPolicy();
    this.discovery = new DiscoveryMonitor(discoveryPath, (result) => {
      this.handleDiscovery(result);
    });
  }

  start(): void {
    this.discovery.start();
  }

  stop(): void {
    this.discovery.stop();
    this.cancelReconnect();
    this.closeSocket(1000, 'host stopping');
    this.publish({ phase: 'disconnected' });
  }

  reconnectNow(): void {
    this.reconnectPolicy.reset();
    this.cancelReconnect();
    if (!this.currentRecord) return;
    this.closeSocket(1001, 'host readiness changed');
    this.connect(this.currentRecord);
  }

  forceReconnectNow(): void {
    this.reconnectPolicy.reset();
    this.cancelReconnect();
    if (!this.currentRecord) return;
    this.terminateSocket();
    this.connect(this.currentRecord);
  }

  sendAction(action: HostAction): boolean {
    return this.sendControl(action);
  }

  sendAudio(frame: Uint8Array, epoch: number): boolean {
    const socket = this.socket;
    const encoded = encodeInputAudioFrame(epoch, frame);
    if (
      !socket ||
      !this.welcomed ||
      epoch !== this.epoch ||
      socket.readyState !== WebSocket.OPEN ||
      socket.bufferedAmount > MAX_SOCKET_BUFFERED_BYTES ||
      !encoded ||
      encoded.byteLength > MAX_INPUT_AUDIO_WIRE_FRAME_BYTES
    ) {
      return false;
    }
    socket.send(encoded, { binary: true });
    return true;
  }

  getSnapshot(): ConnectionSnapshot {
    return this.snapshot;
  }

  getEpoch(): number {
    return this.epoch;
  }

  getWebShellSessionUrl(
    target: NonNullable<LiveStatus['pendingPermission']>,
  ): string | undefined {
    return this.currentRecord
      ? buildWebShellSessionUrl(this.currentRecord, target)
      : undefined;
  }

  private handleDiscovery(result: DiscoveryResult): void {
    if (result.kind !== 'ready') {
      this.currentRecord = undefined;
      this.currentSignature = '';
      this.cancelReconnect();
      this.closeSocket(1001, 'daemon discovery unavailable');
      this.publish({
        phase: result.kind === 'missing' ? 'disconnected' : 'error',
        ...(result.kind === 'invalid' ? { error: result.reason } : {}),
      });
      return;
    }

    if (result.signature === this.currentSignature && this.socket) return;
    this.currentRecord = result.record;
    this.currentSignature = result.signature;
    this.reconnectPolicy.reset();
    this.cancelReconnect();
    this.closeSocket(1001, 'daemon discovery changed');
    this.connect(result.record);
  }

  private connect(record: LiveDiscoveryRecord): void {
    if (this.socket) return;
    this.publish({ phase: 'connecting' });

    const headers: Record<string, string> = {
      'X-Qwen-Live-Nonce': record.instanceNonce,
    };
    if (record.token) headers.Authorization = `Bearer ${record.token}`;

    const socket = new WebSocket(buildHostWebSocketUrl(record.url), {
      headers,
      handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
      maxPayload: MAX_OUTPUT_AUDIO_FRAME_BYTES,
      perMessageDeflate: false,
    });
    this.socket = socket;
    this.intentionalClose = false;
    this.welcomed = false;

    socket.on('open', () => {
      if (socket !== this.socket) return;
      const readiness = this.callbacks.getReadiness();
      this.sendControl({
        type: 'host.hello',
        protocolVersion: LIVE_PROTOCOL_VERSION,
        hostVersion: this.hostVersion,
        bundleId: LIVE_HOST_BUNDLE_ID,
        instanceNonce: this.hostInstanceNonce,
        permissions: readiness.permissions,
        selfChecks: readiness.selfChecks,
      });
      this.handshakeTimer = setTimeout(() => {
        if (!this.welcomed) socket.close(4008, 'handshake timeout');
      }, HANDSHAKE_TIMEOUT_MS);
      this.handshakeTimer.unref();
    });

    socket.on('message', (data, isBinary) => {
      if (socket !== this.socket) return;
      if (isBinary) {
        if (!this.welcomed) {
          socket.close(1002, 'audio before welcome');
          return;
        }
        const frame = rawDataToBuffer(data);
        if (!isValidOutputAudioFrame(frame)) {
          socket.close(1009, 'invalid audio frame');
          return;
        }
        this.callbacks.onOutputAudio(
          new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength),
        );
        return;
      }

      const encoded = rawDataToBuffer(data);
      if (encoded.byteLength > MAX_CONTROL_FRAME_BYTES) {
        socket.close(1009, 'control frame too large');
        return;
      }
      const message = parseDaemonControlMessage(encoded.toString('utf8'));
      if (!message) {
        socket.close(1002, 'invalid control frame');
        return;
      }

      if (!this.welcomed && message.type !== 'host.welcome') {
        socket.close(1002, 'welcome required');
        return;
      }

      switch (message.type) {
        case 'host.welcome':
          if (message.protocolVersion !== LIVE_PROTOCOL_VERSION) {
            this.intentionalClose = true;
            socket.close(4006, 'protocol mismatch');
            this.publish({ phase: 'incompatible', error: 'host_version' });
            return;
          }
          if (
            !this.nonceMatches(
              message.daemonInstanceNonce,
              record.instanceNonce,
            )
          ) {
            this.intentionalClose = true;
            socket.close(4003, 'daemon nonce mismatch');
            this.publish({ phase: 'error', error: 'daemon_identity' });
            return;
          }
          this.welcomed = true;
          this.epoch = message.epoch;
          this.heartbeatIntervalMs = message.heartbeatIntervalMs;
          this.clearHandshakeTimer();
          this.reconnectPolicy.reset();
          this.armHeartbeat(message.heartbeatIntervalMs);
          this.publish({ phase: 'ready', status: message.status });
          break;
        case 'host.state':
          if (message.epoch < this.epoch) break;
          if (message.epoch > this.epoch) this.callbacks.onClearOutput();
          this.epoch = message.epoch;
          this.publish({ phase: 'ready', status: message.status });
          break;
        case 'host.ping':
          this.armHeartbeat(this.heartbeatIntervalMs);
          this.sendControl({ type: 'host.pong', pingId: message.pingId });
          break;
        case 'host.clear_output':
          if (message.epoch === this.epoch) {
            this.callbacks.onClearOutput();
          }
          break;
        case 'host.set_shortcut': {
          const result = this.callbacks.setShortcut?.(message.shortcut) ?? {
            success: false,
            error: 'Global shortcut registration is unavailable.',
          };
          this.sendControl({
            type: 'host.shortcut_result',
            requestId: message.requestId,
            shortcut: message.shortcut,
            ...result,
          });
          break;
        }
        case 'host.capture_screen_context':
          if (message.epoch !== this.epoch) {
            this.sendControl({
              type: 'host.screen_context_result',
              requestId: message.requestId,
              success: false,
              error: 'The Appshot request belongs to a stale Live call.',
            });
            break;
          }
          void this.captureScreenContext(message.requestId, message.epoch);
          break;
        case 'host.error':
          this.publish({
            ...this.snapshot,
            phase: this.welcomed ? 'ready' : 'error',
            error: message.code,
          });
          break;
      }
    });

    socket.on('error', () => {
      if (socket !== this.socket || this.intentionalClose) return;
      this.publish({ phase: 'error', error: 'daemon_connection' });
    });

    socket.on('close', (code) => {
      if (socket !== this.socket) return;
      this.socket = undefined;
      this.welcomed = false;
      this.clearHandshakeTimer();
      this.clearHeartbeatTimer();
      if (this.intentionalClose) return;
      if (code === 4006) {
        this.publish({ phase: 'incompatible', error: 'host_version' });
        return;
      }
      if (code === 4003) {
        this.publish({ phase: 'error', error: 'daemon_identity' });
        return;
      }
      this.publish({ phase: 'disconnected', error: 'daemon_disconnected' });
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (!this.currentRecord || this.reconnectTimer) return;
    const delay = this.reconnectPolicy.nextDelayMs();
    if (delay === undefined) {
      this.publish({ phase: 'error', error: 'daemon_reconnect_exhausted' });
      this.reconnectTimer = setTimeout(
        () => {
          this.reconnectTimer = undefined;
          if (!this.currentRecord) return;
          this.reconnectPolicy.reset();
          this.connect(this.currentRecord);
        },
        Math.max(
          1,
          this.retryOptions.exhaustedRetryDelayMs ?? EXHAUSTED_RETRY_DELAY_MS,
        ),
      );
      this.reconnectTimer.unref();
      return;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.currentRecord) this.connect(this.currentRecord);
    }, delay);
    this.reconnectTimer.unref();
  }

  private sendControl(message: HostControlMessage): boolean {
    const socket = this.socket;
    if (
      !socket ||
      !canSendHostControlMessage(
        message,
        socket.readyState === WebSocket.OPEN,
        this.welcomed,
        socket.bufferedAmount,
      )
    ) {
      return false;
    }
    socket.send(encodeHostControlMessage(message));
    return true;
  }

  sendPlaybackStarted(epoch: number): boolean {
    return this.sendControl({ type: 'host.playback_started', epoch });
  }

  sendPlaybackCompleted(epoch: number): boolean {
    return this.sendControl({ type: 'host.playback_completed', epoch });
  }

  private async captureScreenContext(
    requestId: string,
    epoch: number,
  ): Promise<void> {
    const capture = this.callbacks.captureScreenContext;
    if (!capture) {
      this.sendControl({
        type: 'host.screen_context_result',
        requestId,
        success: false,
        error: 'Appshot capture is unavailable.',
      });
      return;
    }
    try {
      const result = await capture();
      if (!this.welcomed || epoch !== this.epoch) return;
      this.sendControl(screenContextResultMessage(requestId, result));
    } catch (error) {
      if (!this.welcomed || epoch !== this.epoch) return;
      const message =
        error instanceof Error && error.message
          ? error.message.slice(0, MAX_APPSHOT_ERROR_CHARS)
          : 'Appshot failed.';
      this.sendControl({
        type: 'host.screen_context_result',
        requestId,
        success: false,
        error: message,
      });
    }
  }

  private closeSocket(code: number, reason: string): void {
    const socket = this.socket;
    if (!socket) return;
    this.intentionalClose = true;
    this.socket = undefined;
    this.welcomed = false;
    this.clearHandshakeTimer();
    this.clearHeartbeatTimer();
    socket.close(code, reason);
  }

  private terminateSocket(): void {
    const socket = this.socket;
    if (!socket) return;
    this.intentionalClose = true;
    this.socket = undefined;
    this.welcomed = false;
    this.clearHandshakeTimer();
    this.clearHeartbeatTimer();
    socket.terminate();
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  private clearHandshakeTimer(): void {
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    this.handshakeTimer = undefined;
  }

  private armHeartbeat(intervalMs: number): void {
    this.clearHeartbeatTimer();
    this.heartbeatTimer = setTimeout(
      () => {
        this.socket?.close(4008, 'heartbeat timeout');
      },
      Math.max(3_000, intervalMs * 3),
    );
    this.heartbeatTimer.unref();
  }

  private clearHeartbeatTimer(): void {
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  private nonceMatches(received: string, expected: string): boolean {
    const left = Buffer.from(received);
    const right = Buffer.from(expected);
    return left.byteLength === right.byteLength && timingSafeEqual(left, right);
  }

  private publish(snapshot: ConnectionSnapshot): void {
    this.snapshot = snapshot;
    this.callbacks.onSnapshot(snapshot);
  }
}
