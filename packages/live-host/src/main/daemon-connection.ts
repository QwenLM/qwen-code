import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  isLiveLanguage,
  liveMessage,
  liveText,
  displayLiveMessage,
  type LiveLanguage,
} from '@qwen-code/qwen-live/i18n';
import WebSocket, { type RawData } from 'ws';
import type { SubagentsSnapshot } from '@qwen-code/qwen-live/subagents';
import {
  LIVE_HOST_BUNDLE_ID,
  LIVE_PROTOCOL_VERSION,
  MAX_CONTROL_FRAME_BYTES,
  MAX_INPUT_AUDIO_WIRE_FRAME_BYTES,
  MAX_OUTPUT_AUDIO_WIRE_FRAME_BYTES,
  MAX_SOCKET_BUFFERED_BYTES,
  decodeOutputAudioFrame,
  encodeInputAudioFrame,
  encodeHostControlMessage,
  isValidInputImageFrame,
  parseDaemonControlMessage,
  parseMemoryAction,
  type DaemonControlMessage,
  type HostAction,
  type HostCapabilities,
  type HostPermissions,
  type HostSelfChecks,
  type HostControlMessage,
  type LiveStatus,
  type MemoryAction,
  type MemoryState,
  type OutputAudioFrame,
  type PlaybackIdentity,
  type VisualInput,
  type VisualSource,
  type UiLanguageState,
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
const QUIT_TIMEOUT_MS = 75_000;

export type ConnectionPhase =
  | 'disconnected'
  | 'connecting'
  | 'ready'
  | 'incompatible'
  | 'error';

export type ConnectionSnapshot = {
  phase: ConnectionPhase;
  error?: string;
  capabilities?: HostCapabilities;
  visualInput?: VisualInput;
  memory?: MemoryState;
  uiLanguageV1?: UiLanguageState;
  subagentsV1?: SubagentsSnapshot;
  instanceId?: string;
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
  onSubagents?: (snapshot: SubagentsSnapshot) => void;
  onOutputAudio: (frame: OutputAudioFrame) => void;
  onOutputAudioFinished: (identity: PlaybackIdentity) => void;
  onClearOutput: () => void;
  setShortcut?: (shortcut: string) => { success: boolean; error?: string };
  captureVisual?: (request: {
    source: VisualSource;
    snapshotWidth?: number;
    snapshotHeight?: number;
    persistAsset?: boolean;
  }) => Promise<{
    source: VisualSource;
    image: string;
    width: number;
    height: number;
    appName?: string;
    windowTitle?: string;
    accessibilityText?: string;
    screenshotPath?: string;
  }>;
};

const MAX_VISUAL_CAPTURE_ERROR_CHARS = 1_024;

type VisualCapture = Awaited<
  ReturnType<NonNullable<ConnectionCallbacks['captureVisual']>>
>;

function visualCaptureResultMessage(
  requestId: string,
  result: VisualCapture,
): HostControlMessage {
  const message = (accessibilityText?: string): HostControlMessage =>
    result.source === 'screen'
      ? {
          type: 'host.visual_capture_result',
          requestId,
          success: true,
          source: 'screen',
          image: result.image,
          width: result.width,
          height: result.height,
          appName: result.appName ?? 'Unknown',
          ...(result.windowTitle ? { windowTitle: result.windowTitle } : {}),
          accessibilityText: accessibilityText ?? '',
          ...(result.screenshotPath
            ? { screenshotPath: result.screenshotPath }
            : {}),
        }
      : {
          type: 'host.visual_capture_result',
          requestId,
          success: true,
          source: 'camera',
          image: result.image,
          width: result.width,
          height: result.height,
          ...(result.screenshotPath
            ? { screenshotPath: result.screenshotPath }
            : {}),
        };
  const fits = (candidate: HostControlMessage) =>
    Buffer.byteLength(JSON.stringify(candidate), 'utf8') <=
    MAX_CONTROL_FRAME_BYTES;
  const accessibilityText = result.accessibilityText ?? '';
  if (fits(message(accessibilityText))) return message(accessibilityText);
  let lower = 0;
  let upper = accessibilityText.length;
  while (lower < upper) {
    const middle = Math.ceil((lower + upper) / 2);
    if (fits(message(accessibilityText.slice(0, middle)))) lower = middle;
    else upper = middle - 1;
  }
  const bounded = message(accessibilityText.slice(0, lower));
  if (!fits(bounded)) {
    throw new Error(liveMessage('host.error.captureTooLarge'));
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
  private capabilities: HostCapabilities | undefined;
  private visualInput: VisualInput | undefined;
  private memory: MemoryState | undefined;
  private uiLanguageV1: UiLanguageState | undefined;
  private subagentsV1: SubagentsSnapshot | undefined;
  private pendingLanguageRequest:
    | {
        requestId: string;
        epoch: number;
        language: LiveLanguage;
        timer: NodeJS.Timeout;
        resolve: (language: LiveLanguage) => void;
        reject: (error: Error) => void;
      }
    | undefined;
  private pendingMemoryRequest:
    | {
        requestId: string;
        epoch: number;
        timer: NodeJS.Timeout;
        resolve: (memory: MemoryState) => void;
        reject: (error: Error) => void;
      }
    | undefined;
  private pendingVisualSelection:
    | (Pick<VisualInput, 'source' | 'mode'> & { epoch: number })
    | undefined;
  private snapshot: ConnectionSnapshot = { phase: 'disconnected' };
  private shutdownTarget: LiveDiscoveryRecord | undefined;
  private quitTarget: LiveDiscoveryRecord | undefined;
  private quitPromise: Promise<void> | undefined;

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
    if (this.quitPromise || this.quitTarget) return;
    this.discovery.start();
  }

  stop(): void {
    this.discovery.stop();
    this.cancelReconnect();
    this.closeSocket(1000, 'host stopping');
    if (!this.quitPromise && !this.quitTarget) {
      this.shutdownTarget = undefined;
      this.publish({ phase: 'disconnected' });
    }
  }

  requestQuit(): Promise<void> {
    if (this.quitPromise) return this.quitPromise;
    const socket =
      this.welcomed && this.socket?.readyState === WebSocket.OPEN
        ? this.socket
        : undefined;
    const target = this.quitTarget ?? this.shutdownTarget;
    if (target) this.quitTarget = { ...target };
    this.discovery.stop();
    this.cancelReconnect();
    this.clearHeartbeatTimer();
    this.intentionalClose = true;
    this.quitPromise = this.quitConnection(socket, target).then(
      () => {
        this.closeSocket(1000, 'host quitting');
        this.shutdownTarget = undefined;
        this.quitTarget = undefined;
      },
      (cause: unknown) => {
        this.quitPromise = undefined;
        const error = new Error(liveMessage('host.error.quitUnconfirmed'), {
          cause,
        });
        this.publish({ phase: 'error', error: error.message });
        throw error;
      },
    );
    return this.quitPromise;
  }

  private isShutdownProcessGone(target: LiveDiscoveryRecord): boolean {
    try {
      process.kill(target.pid, 0);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException | undefined)?.code === 'ESRCH';
    }
  }

  private async quitConnection(
    socket: WebSocket | undefined,
    target: LiveDiscoveryRecord | undefined,
  ): Promise<void> {
    if (target) {
      if (!target.token)
        throw new Error(liveMessage('host.error.quitCredentials'));
      if (this.isShutdownProcessGone(target)) return;
      const url = new URL(buildHostWebSocketUrl(target.url));
      url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
      url.pathname = '/live/quit';
      let response: Response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${target.token}`,
            'x-qwen-live-nonce': target.instanceNonce,
          },
          redirect: 'error',
          signal: AbortSignal.timeout(QUIT_TIMEOUT_MS),
        });
      } catch (error) {
        if (this.isShutdownProcessGone(target)) return;
        throw error;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(liveMessage('host.error.quitRejected'));
      }
      const receipt: unknown = await response.json();
      if (
        typeof receipt !== 'object' ||
        receipt === null ||
        !('stopped' in receipt) ||
        receipt.stopped !== true ||
        !('instanceNonce' in receipt) ||
        typeof receipt.instanceNonce !== 'string' ||
        !this.nonceMatches(receipt.instanceNonce, target.instanceNonce)
      ) {
        throw new Error(liveMessage('host.error.quitAck'));
      }
      return;
    }
    if (!socket) return;
    const action: HostAction = {
      type: 'host.action',
      action: 'stop',
      epoch: this.epoch,
    };
    if (
      !canSendHostControlMessage(
        action,
        socket.readyState === WebSocket.OPEN,
        true,
        socket.bufferedAmount,
      )
    )
      throw new Error(liveMessage('host.error.stopFailed'));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(liveMessage('host.error.stopTimeout'))),
        QUIT_TIMEOUT_MS,
      );
      timer.unref();
      socket.send(encodeHostControlMessage(action), (error) => {
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      });
    });
  }

  reconnectNow(): void {
    if (this.quitPromise || this.quitTarget) return;
    this.reconnectPolicy.reset();
    this.cancelReconnect();
    if (!this.currentRecord) return;
    this.closeSocket(1001, 'host readiness changed');
    this.connect(this.currentRecord);
  }

  forceReconnectNow(): void {
    if (this.quitPromise || this.quitTarget) return;
    this.reconnectPolicy.reset();
    this.cancelReconnect();
    if (!this.currentRecord) return;
    this.terminateSocket();
    this.connect(this.currentRecord);
  }

  sendAction(action: HostAction): boolean {
    return this.sendControl(action);
  }

  requestMemoryAction(action: MemoryAction): Promise<MemoryState> {
    const parsed = parseMemoryAction(action);
    if (!parsed)
      return Promise.reject(new Error(liveMessage('host.error.memoryInvalid')));
    if (!this.welcomed || this.snapshot.phase !== 'ready' || !this.memory) {
      return Promise.reject(
        new Error(liveMessage('host.error.memoryUnavailable')),
      );
    }
    if (this.pendingMemoryRequest) {
      return Promise.reject(new Error(liveMessage('host.error.memoryBusy')));
    }
    if (
      this.memory.locked &&
      ['select', 'create', 'set_model'].includes(parsed.action)
    ) {
      return Promise.reject(new Error(liveMessage('host.error.endCallFirst')));
    }
    const requestId = randomBytes(16).toString('hex');
    return new Promise<MemoryState>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.rejectMemoryRequest(
          new Error(liveMessage('host.error.memoryTimeout')),
        );
      }, 30_000);
      timer.unref();
      this.pendingMemoryRequest = {
        requestId,
        epoch: this.epoch,
        timer,
        resolve,
        reject,
      };
      try {
        if (
          !this.sendControl({
            type: 'host.memory_action',
            requestId,
            epoch: this.epoch,
            ...parsed,
          })
        ) {
          this.rejectMemoryRequest(
            new Error(liveMessage('host.error.memorySendFailed')),
          );
        }
      } catch (error) {
        this.rejectMemoryRequest(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    });
  }

  requestLanguage(language: LiveLanguage): Promise<LiveLanguage> {
    if (!isLiveLanguage(language))
      return Promise.reject(new Error(liveMessage('host.language.invalid')));
    if (!this.welcomed || this.snapshot.phase !== 'ready' || !this.uiLanguageV1)
      return Promise.reject(
        new Error(liveMessage('host.language.unavailable')),
      );
    if (this.pendingLanguageRequest)
      return Promise.reject(new Error(liveMessage('host.language.busy')));
    const requestId = randomBytes(16).toString('hex');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          this.rejectLanguageRequest(
            new Error(liveMessage('host.language.timeout')),
          ),
        30_000,
      );
      timer.unref();
      this.pendingLanguageRequest = {
        requestId,
        epoch: this.epoch,
        language,
        timer,
        resolve,
        reject,
      };
      try {
        if (
          !this.sendControl({
            type: 'host.language_action',
            requestId,
            epoch: this.epoch,
            language,
          })
        )
          this.rejectLanguageRequest(
            new Error(liveMessage('host.language.sendFailed')),
          );
      } catch (error) {
        this.rejectLanguageRequest(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    });
  }

  sendAudio(frame: Uint8Array, epoch: number): boolean {
    const socket = this.socket;
    const encoded = encodeInputAudioFrame(epoch, frame);
    if (
      !socket ||
      this.quitPromise ||
      this.quitTarget ||
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

  sendVisualFrame(source: VisualSource, image: string, epoch: number): boolean {
    if (
      !this.welcomed ||
      epoch !== this.epoch ||
      !isValidInputImageFrame(image)
    ) {
      return false;
    }
    try {
      return this.sendControl({
        type: 'host.visual_frame',
        epoch,
        source,
        image,
      });
    } catch {
      return false;
    }
  }

  sendVisualSettings(
    update: Partial<Pick<VisualInput, 'source' | 'mode'>>,
    epoch: number,
  ): boolean {
    const current =
      this.pendingVisualSelection?.epoch === epoch
        ? this.pendingVisualSelection
        : this.visualInput;
    if (
      !this.welcomed ||
      epoch !== this.epoch ||
      !current ||
      (update.source === undefined && update.mode === undefined)
    ) {
      return false;
    }
    const next = { ...current, ...update };
    const readiness = this.callbacks.getReadiness();
    try {
      const sent = this.sendControl({
        type: 'host.visual_settings',
        epoch,
        source: next.source,
        mode: next.mode,
        permissions: {
          camera: readiness.permissions.camera,
          accessibility: readiness.permissions.accessibility,
          screenRecording: readiness.permissions.screenRecording,
        },
        appshot: readiness.selfChecks.appshot,
      });
      if (sent) this.pendingVisualSelection = { ...next, epoch };
      return sent;
    } catch {
      return false;
    }
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

  getConfigFilePath(): string | undefined {
    if (
      this.quitPromise ||
      this.quitTarget ||
      !this.welcomed ||
      this.snapshot.phase !== 'ready' ||
      this.socket?.readyState !== WebSocket.OPEN
    )
      return undefined;
    return this.currentRecord?.configPath;
  }

  private handleDiscovery(result: DiscoveryResult): void {
    if (this.quitPromise || this.quitTarget) return;
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
    if (
      this.shutdownTarget &&
      (this.shutdownTarget.instanceNonce !== result.record.instanceNonce ||
        this.shutdownTarget.pid !== result.record.pid ||
        this.shutdownTarget.url !== result.record.url ||
        this.shutdownTarget.token !== result.record.token)
    )
      this.shutdownTarget = undefined;
    this.currentRecord = result.record;
    this.currentSignature = result.signature;
    this.reconnectPolicy.reset();
    this.cancelReconnect();
    this.closeSocket(1001, 'daemon discovery changed');
    this.connect(result.record);
  }

  private connect(record: LiveDiscoveryRecord): void {
    if (this.socket || this.quitPromise || this.quitTarget) return;
    this.capabilities = undefined;
    this.visualInput = undefined;
    this.pendingVisualSelection = undefined;
    this.publish({ phase: 'connecting' });

    const headers: Record<string, string> = {
      'X-Qwen-Live-Nonce': record.instanceNonce,
    };
    if (record.token) headers.Authorization = `Bearer ${record.token}`;

    const socket = new WebSocket(buildHostWebSocketUrl(record.url), {
      headers,
      handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
      maxPayload: Math.max(
        MAX_CONTROL_FRAME_BYTES,
        MAX_OUTPUT_AUDIO_WIRE_FRAME_BYTES,
      ),
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
        subagentsV1: true,
        protocolVersion: LIVE_PROTOCOL_VERSION,
        hostVersion: this.hostVersion,
        bundleId: LIVE_HOST_BUNDLE_ID,
        instanceNonce: this.hostInstanceNonce,
        capabilities: { outputAudioEndMarkerV1: true },
        permissions: readiness.permissions,
        selfChecks: readiness.selfChecks,
      });
      this.handshakeTimer = setTimeout(() => {
        if (!this.welcomed) socket.close(4008, 'handshake timeout');
      }, HANDSHAKE_TIMEOUT_MS);
      this.handshakeTimer.unref();
    });

    socket.on('message', (data, isBinary) => {
      if (socket !== this.socket || this.quitPromise || this.quitTarget) return;
      if (isBinary) {
        if (!this.welcomed) {
          socket.close(1002, 'audio before welcome');
          return;
        }
        const frame = decodeOutputAudioFrame(rawDataToBuffer(data));
        if (!frame) {
          socket.close(1009, 'invalid audio frame');
          return;
        }
        this.callbacks.onOutputAudio(frame);
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
          this.shutdownTarget = message.daemonShutdownV1
            ? { ...record }
            : undefined;
          this.epoch = message.epoch;
          this.capabilities = message.capabilities;
          this.visualInput = message.visualInput;
          this.memory = message.memory;
          this.uiLanguageV1 = message.uiLanguageV1;
          this.subagentsV1 = message.subagentsV1;
          this.pendingVisualSelection = undefined;
          this.heartbeatIntervalMs = message.heartbeatIntervalMs;
          this.clearHandshakeTimer();
          this.reconnectPolicy.reset();
          this.armHeartbeat(message.heartbeatIntervalMs);
          this.publish({
            phase: 'ready',
            instanceId: record.instanceNonce,
            ...(this.capabilities
              ? { capabilities: { ...this.capabilities } }
              : {}),
            ...(this.visualInput
              ? { visualInput: { ...this.visualInput } }
              : {}),
            ...(this.memory ? { memory: this.memory } : {}),
            ...(this.uiLanguageV1 ? { uiLanguageV1: this.uiLanguageV1 } : {}),
            ...(this.subagentsV1 ? { subagentsV1: this.subagentsV1 } : {}),
            status: message.status,
          });
          break;
        case 'host.state':
          if (message.epoch < this.epoch) break;
          if (
            this.pendingLanguageRequest &&
            this.pendingLanguageRequest.epoch !== message.epoch
          )
            this.rejectLanguageRequest(
              new Error(liveMessage('host.language.changedCall')),
            );
          if (
            this.pendingMemoryRequest &&
            this.pendingMemoryRequest.epoch !== message.epoch
          ) {
            this.rejectMemoryRequest(
              new Error(liveMessage('host.error.memoryCallChanged')),
            );
          }
          if (message.epoch > this.epoch) this.callbacks.onClearOutput();
          this.epoch = message.epoch;
          this.memory = message.memory;
          this.uiLanguageV1 = message.uiLanguageV1;
          if (
            message.subagentsV1 &&
            (!this.subagentsV1 ||
              message.subagentsV1.revision >= this.subagentsV1.revision)
          )
            this.subagentsV1 = message.subagentsV1;
          if (message.visualInput) {
            this.visualInput = message.visualInput;
            if (
              this.pendingVisualSelection &&
              (this.pendingVisualSelection.epoch !== message.epoch ||
                (this.pendingVisualSelection.source ===
                  message.visualInput.source &&
                  this.pendingVisualSelection.mode ===
                    message.visualInput.mode))
            ) {
              this.pendingVisualSelection = undefined;
            }
          }
          this.publish({
            phase: 'ready',
            instanceId: record.instanceNonce,
            ...(this.capabilities
              ? { capabilities: { ...this.capabilities } }
              : {}),
            ...(this.visualInput
              ? { visualInput: { ...this.visualInput } }
              : {}),
            ...(this.memory ? { memory: this.memory } : {}),
            ...(this.uiLanguageV1 ? { uiLanguageV1: this.uiLanguageV1 } : {}),
            ...(this.subagentsV1 ? { subagentsV1: this.subagentsV1 } : {}),
            status: message.status,
          });
          break;
        case 'host.subagents': {
          if (
            !this.subagentsV1 ||
            message.subagentsV1.revision <= this.subagentsV1.revision
          )
            break;
          this.subagentsV1 = message.subagentsV1;
          this.snapshot = { ...this.snapshot, subagentsV1: this.subagentsV1 };
          this.callbacks.onSubagents?.(this.subagentsV1);
          break;
        }
        case 'host.language_result': {
          const pending = this.pendingLanguageRequest;
          if (!pending || pending.requestId !== message.requestId) break;
          if (
            message.ok &&
            message.uiLanguageV1.language !== pending.language
          ) {
            this.rejectLanguageRequest(
              new Error(liveMessage('host.language.invalid')),
            );
            break;
          }
          clearTimeout(pending.timer);
          this.pendingLanguageRequest = undefined;
          if (message.uiLanguageV1) {
            this.uiLanguageV1 = message.uiLanguageV1;
            this.publish({ ...this.snapshot, uiLanguageV1: this.uiLanguageV1 });
          }
          if (message.ok) pending.resolve(message.uiLanguageV1.language);
          else pending.reject(new Error(message.error));
          break;
        }
        case 'host.memory_result': {
          const pending = this.pendingMemoryRequest;
          if (!pending || pending.requestId !== message.requestId) break;
          clearTimeout(pending.timer);
          this.pendingMemoryRequest = undefined;
          if (message.memory) {
            this.memory = message.memory;
            this.publish({ ...this.snapshot, memory: this.memory });
          }
          if (message.ok) pending.resolve(message.memory);
          else pending.reject(new Error(message.error));
          break;
        }
        case 'host.ping':
          this.armHeartbeat(this.heartbeatIntervalMs);
          this.sendControl({ type: 'host.pong', pingId: message.pingId });
          break;
        case 'host.clear_output':
          if (message.epoch === this.epoch) {
            this.callbacks.onClearOutput();
          }
          break;
        case 'host.output_audio_finished':
          if (
            this.capabilities?.outputAudioEndMarkerV1 === true &&
            message.epoch === this.epoch
          ) {
            this.callbacks.onOutputAudioFinished({
              epoch: message.epoch,
              outputId: message.outputId,
            });
          }
          break;
        case 'host.set_shortcut': {
          const result = this.callbacks.setShortcut?.(message.shortcut) ?? {
            success: false,
            error: liveText('en', 'host.error.shortcutUnavailable'),
          };
          this.sendControl({
            type: 'host.shortcut_result',
            requestId: message.requestId,
            shortcut: message.shortcut,
            ...result,
            ...(result.error
              ? { error: displayLiveMessage('en', result.error) }
              : {}),
          });
          break;
        }
        case 'host.capture_visual':
          if (message.epoch !== this.epoch) {
            this.sendControl({
              type: 'host.visual_capture_result',
              requestId: message.requestId,
              success: false,
              error: liveText('en', 'host.error.visualStale'),
            });
            break;
          }
          void this.captureVisual(message);
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
      this.capabilities = undefined;
      this.clearHandshakeTimer();
      this.clearHeartbeatTimer();
      if (this.intentionalClose) {
        if (!this.quitPromise && this.snapshot.phase === 'ready')
          this.publish({ phase: 'disconnected', error: 'daemon_disconnected' });
        return;
      }
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
    if (
      !this.currentRecord ||
      this.reconnectTimer ||
      this.quitPromise ||
      this.quitTarget
    )
      return;
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
      this.quitPromise ||
      this.quitTarget ||
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

  sendPlaybackStarted(epoch: number, outputId: number): boolean {
    return this.sendControl({ type: 'host.playback_started', epoch, outputId });
  }

  sendPlaybackCompleted(epoch: number, outputId: number): boolean {
    return this.sendControl({
      type: 'host.playback_completed',
      epoch,
      outputId,
    });
  }

  private async captureVisual(
    request: Extract<DaemonControlMessage, { type: 'host.capture_visual' }>,
  ): Promise<void> {
    const capture = this.callbacks.captureVisual;
    if (!capture) {
      this.sendControl({
        type: 'host.visual_capture_result',
        requestId: request.requestId,
        success: false,
        error: liveText('en', 'host.error.visualUnavailable'),
      });
      return;
    }
    try {
      const result = await capture({
        source: request.source,
        ...(request.snapshotWidth !== undefined
          ? { snapshotWidth: request.snapshotWidth }
          : {}),
        ...(request.snapshotHeight !== undefined
          ? { snapshotHeight: request.snapshotHeight }
          : {}),
        ...(request.persistAsset !== undefined
          ? { persistAsset: request.persistAsset }
          : {}),
      });
      if (result.source !== request.source) {
        throw new Error(liveText('en', 'host.error.visualWrongSource'));
      }
      if (!this.welcomed || request.epoch !== this.epoch) return;
      this.sendControl(visualCaptureResultMessage(request.requestId, result));
    } catch (error) {
      if (!this.welcomed || request.epoch !== this.epoch) return;
      const message =
        error instanceof Error && error.message
          ? displayLiveMessage('en', error.message).slice(
              0,
              MAX_VISUAL_CAPTURE_ERROR_CHARS,
            )
          : liveText('en', 'host.error.visualFailed');
      this.sendControl({
        type: 'host.visual_capture_result',
        requestId: request.requestId,
        success: false,
        error: message,
      });
    }
  }

  private closeSocket(code: number, reason: string): void {
    this.subagentsV1 = undefined;
    this.rejectLanguageRequest(
      new Error(liveMessage('host.language.disconnected')),
    );
    this.uiLanguageV1 = undefined;
    this.rejectMemoryRequest(
      new Error(liveMessage('host.error.memoryDisconnected')),
    );
    this.memory = undefined;
    const socket = this.socket;
    if (!socket) return;
    this.intentionalClose = true;
    this.socket = undefined;
    this.welcomed = false;
    this.capabilities = undefined;
    this.pendingVisualSelection = undefined;
    this.clearHandshakeTimer();
    this.clearHeartbeatTimer();
    socket.close(code, reason);
  }

  private terminateSocket(): void {
    this.subagentsV1 = undefined;
    this.rejectLanguageRequest(
      new Error(liveMessage('host.language.disconnected')),
    );
    this.uiLanguageV1 = undefined;
    this.rejectMemoryRequest(
      new Error(liveMessage('host.error.memoryDisconnected')),
    );
    this.memory = undefined;
    const socket = this.socket;
    if (!socket) return;
    this.intentionalClose = true;
    this.socket = undefined;
    this.welcomed = false;
    this.capabilities = undefined;
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
    if (snapshot.phase !== 'ready') {
      this.rejectLanguageRequest(
        new Error(liveMessage('host.language.disconnected')),
      );
      this.uiLanguageV1 = undefined;
      this.rejectMemoryRequest(
        new Error(liveMessage('host.error.memoryDisconnected')),
      );
    }
    this.snapshot = snapshot;
    this.callbacks.onSnapshot(snapshot);
  }

  private rejectMemoryRequest(error: Error): void {
    const pending = this.pendingMemoryRequest;
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingMemoryRequest = undefined;
    pending.reject(error);
  }

  private rejectLanguageRequest(error: Error): void {
    const pending = this.pendingLanguageRequest;
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingLanguageRequest = undefined;
    pending.reject(error);
  }
}
