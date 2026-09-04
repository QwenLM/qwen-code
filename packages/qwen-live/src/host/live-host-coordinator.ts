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
  type LiveAppshotReadiness,
  type LiveDaemonMessage,
  type LiveHostAction,
  type LiveHostHello,
  type LiveHostShortcutResult,
  type LiveHostScreenContextResult,
  type LiveHostPlaybackStarted,
  type LiveHostPlaybackCompleted,
  type LiveHostStatus,
  type LiveHostMessage,
  type LiveMuteUpdate,
  type LivePermissionState,
  type LiveProviderReadiness,
  type LiveSessionLocator,
  type LiveState,
  type LiveStatus,
} from './types.js';

const DEFAULT_HELLO_TIMEOUT_MS = 5_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 15_000;
const DEFAULT_SHORTCUT_TIMEOUT_MS = 5_000;
// The frame cap must admit every message the per-field caps below allow. The
// worst conformant case is a host.screen_context_result: requestId (128) +
// appName (512) + windowTitle (2,048) + accessibilityText (32,000) +
// screenshotPath (4,096) ≈ 38,784 UTF-16 units, each up to 6 UTF-8 bytes once
// JSON-escaped (≈ 227 KiB), plus JSON syntax overhead — 256 KiB covers it.
const MAX_HOST_TEXT_BYTES = 256 * 1024;
const MAX_HOST_AUDIO_BYTES = 64 * 1024;
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
const DEFAULT_APPSHOT_TIMEOUT_MS = 15_000;

function writeLiveHostDiagnostic(
  event: string,
  details: Readonly<Record<string, string | number | boolean | undefined>>,
): void {
  if (process.env['QWEN_LIVE_DIAGNOSTICS'] !== '1') return;
  process.stderr.write(
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      source: 'live-host-coordinator',
      event,
      ...details,
    })}\n`,
  );
}

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

interface HostLease {
  socket: WebSocket;
  hello?: LiveHostHello;
  helloTimer: NodeJS.Timeout;
  heartbeatTimer?: NodeJS.Timeout;
  lastPongAt: number;
  pingId?: string;
}

export interface LiveCallHandlers {
  onHostReady?: () => void | Promise<void>;
  onStart?: (call: {
    epoch: number;
    callId: string;
    mode: 'resume' | 'new';
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
  onPlaybackStarted?: (call: { epoch: number }) => void;
  onPlaybackCompleted?: (call: { epoch: number }) => void;
}

export interface LiveHostCoordinatorOptions {
  daemonInstanceNonce?: string;
  getProviderReadiness: () => LiveProviderReadiness;
  shortcut?: string;
  handlers?: LiveCallHandlers;
  helloTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  appshotTimeoutMs?: number;
  now?: () => number;
}

export interface LiveScreenContextCapture {
  appName: string;
  windowTitle?: string;
  accessibilityText: string;
  screenshotPath: string;
}

interface PendingAppshot {
  epoch: number;
  timer: NodeJS.Timeout;
  resolve: (capture: LiveScreenContextCapture) => void;
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

function isPermissionState(value: unknown): value is LivePermissionState {
  return (
    value === 'granted' || value === 'denied' || value === 'not_determined'
  );
}

function parseHello(value: Record<string, unknown>): LiveHostHello | undefined {
  const permissions = value['permissions'];
  const selfChecks = value['selfChecks'];
  if (
    value['type'] !== 'host.hello' ||
    typeof value['protocolVersion'] !== 'number' ||
    !Number.isInteger(value['protocolVersion']) ||
    !isBoundedString(value['hostVersion'], MAX_VERSION_LENGTH) ||
    !isBoundedString(value['bundleId']) ||
    !isBoundedString(value['instanceNonce']) ||
    !isObject(permissions) ||
    !isPermissionState(permissions['microphone']) ||
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
  return value as unknown as LiveHostHello;
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

function parseHostMessage(text: string): LiveHostMessage | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isObject(value)) return undefined;
  if (value['type'] === 'host.hello') return parseHello(value);
  if (value['type'] === 'host.action') return parseAction(value);
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
  if (value['type'] === 'host.screen_context_result') {
    const requestId = value['requestId'];
    if (!isBoundedString(requestId)) return undefined;
    if (value['success'] === false && isBoundedString(value['error'], 1_024)) {
      return {
        type: 'host.screen_context_result',
        requestId: requestId as string,
        success: false,
        error: value['error'] as string,
      };
    }
    if (
      value['success'] === true &&
      isBoundedString(value['appName'], 512) &&
      (value['windowTitle'] === undefined ||
        isBoundedString(value['windowTitle'], 2_048)) &&
      typeof value['accessibilityText'] === 'string' &&
      value['accessibilityText'].length <= MAX_APPSHOT_TEXT_LENGTH &&
      isBoundedString(value['screenshotPath'], 4_096)
    ) {
      return {
        type: 'host.screen_context_result',
        requestId: requestId as string,
        success: true,
        appName: value['appName'] as string,
        ...(value['windowTitle']
          ? { windowTitle: value['windowTitle'] as string }
          : {}),
        accessibilityText: value['accessibilityText'],
        screenshotPath: value['screenshotPath'] as string,
      };
    }
  }
  if (
    value['type'] === 'host.playback_started' &&
    typeof value['epoch'] === 'number'
  ) {
    return { type: 'host.playback_started', epoch: value['epoch'] };
  }
  if (
    value['type'] === 'host.playback_completed' &&
    typeof value['epoch'] === 'number'
  ) {
    return { type: 'host.playback_completed', epoch: value['epoch'] };
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
  private readonly appshotTimeoutMs: number;
  private shortcut: string;
  private handlers: LiveCallHandlers;
  private host?: HostLease;
  private hadConnectedHost = false;
  private lastHostFailure?: 'host_disconnected' | 'host_version';
  private providerOverride?: LiveProviderReadiness;
  private appshotReadiness: LiveAppshotReadiness = {
    state: 'unavailable',
    message: 'The dedicated Appshot channel has not been verified.',
  };
  private call?: LiveCall;
  private pendingStartMode?: 'new';
  private deactivating = false;
  private nextEpoch = 0;
  private inputMuted = false;
  private outputMuted = false;
  private lastCallError?: string;
  private readonly pendingAppshots = new Map<string, PendingAppshot>();
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
    this.appshotTimeoutMs =
      options.appshotTimeoutMs ?? DEFAULT_APPSHOT_TIMEOUT_MS;
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
      socket.close(4003, 'Invalid daemon instance nonce.');
      return;
    }
    if (this.host && this.isLeaseHealthy(this.host)) {
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

    socket.on('message', (data, isBinary) => {
      if (this.host !== lease) return;
      if (isBinary) this.handleAudioFrame(lease, data);
      else this.handleTextFrame(lease, data);
    });
    socket.on('close', () => {
      if (this.host === lease) this.detachHost(lease, 'host_disconnected');
    });
    socket.on('error', () => {
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
      requirements.accessibility = permissionRequirement(
        hello.permissions.accessibility,
      );
      requirements.screenRecording = permissionRequirement(
        hello.permissions.screenRecording,
      );
      requirements.audioInput = hello.selfChecks.audioInput
        ? 'ready'
        : 'unavailable';
      requirements.audioOutput = hello.selfChecks.audioOutput
        ? 'ready'
        : 'unavailable';
      requirements.globalShortcut = hello.selfChecks.globalShortcut
        ? 'ready'
        : 'unavailable';
      requirements.appshot = hello.selfChecks.appshot
        ? appshot.state
        : 'unavailable';
    } else if (appshot.state !== 'ready') {
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
    this.lastCallError = undefined;
    this.broadcastState();
    try {
      void Promise.resolve(
        this.handlers.onStart?.({
          epoch: call.epoch,
          callId: call.callId,
          mode,
        }),
      ).catch(() => {
        this.failCall(call.epoch, 'Live Voice failed to start.');
      });
    } catch {
      this.failCall(call.epoch, 'Live Voice failed to start.');
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
      this.outputMuted = update.outputMuted;
      if (update.outputMuted && this.call) this.clearOutput(this.call.epoch);
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

  captureScreenContext(
    callerSessionId: string,
  ): Promise<LiveScreenContextCapture> {
    const call = this.call;
    const host = this.host;
    if (
      !call ||
      call.coordinator?.sessionId !== callerSessionId ||
      !host?.hello ||
      !this.isLeaseHealthy(host) ||
      host.hello.permissions.accessibility !== 'granted' ||
      host.hello.permissions.screenRecording !== 'granted' ||
      !host.hello.selfChecks.appshot
    ) {
      return Promise.reject(
        new Error(
          'Appshot is available only to the active Live session with a ready Host.',
        ),
      );
    }
    const requestId = randomUUID();
    return new Promise<LiveScreenContextCapture>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingAppshots.delete(requestId);
        reject(new Error('Live Host Appshot timed out.'));
      }, this.appshotTimeoutMs);
      timer.unref?.();
      this.pendingAppshots.set(requestId, {
        epoch: call.epoch,
        timer,
        resolve,
        reject,
      });
      if (
        !this.sendHost({
          type: 'host.capture_screen_context',
          requestId,
          epoch: call.epoch,
        })
      ) {
        this.rejectPendingAppshot(
          requestId,
          new Error('Live Host is unavailable for Appshot.'),
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

  failCall(epoch: number, message = 'Live Voice failed.'): boolean {
    if (!this.call || this.call.epoch !== epoch) return false;
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
    if (this.outputMuted) return true;
    const socket = this.host?.socket;
    if (
      !socket ||
      socket.readyState !== WebSocket.OPEN ||
      socket.bufferedAmount > MAX_SOCKET_BUFFERED_BYTES
    ) {
      return false;
    }
    socket.send(pcm16, { binary: true });
    writeLiveHostDiagnostic('output_audio_sent', {
      epoch,
      bytes: pcm16.byteLength,
      socketBufferedBytes: socket.bufferedAmount,
    });
    return true;
  }

  clearOutput(epoch: number): void {
    if (this.call && this.call.epoch !== epoch) return;
    writeLiveHostDiagnostic('clear_output_sent', { epoch });
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
    this.rejectPendingAppshots(new Error('Live Voice is shutting down.'));
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
        message: 'Live provider configuration is invalid.',
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
    if (hello.permissions.accessibility !== 'granted') {
      return 'accessibility_permission';
    }
    if (hello.permissions.screenRecording !== 'granted') {
      return 'screen_recording_permission';
    }
    if (!hello.selfChecks.audioInput) return 'audio_input';
    if (!hello.selfChecks.audioOutput) return 'audio_output';
    if (!hello.selfChecks.globalShortcut) return 'global_shortcut';
    if (!hello.selfChecks.appshot) return 'appshot';
    if (appshot.state !== 'ready') return 'appshot';
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
    const messages: Record<NonNullable<LiveStatus['blocker']>, string> = {
      host_missing: 'Qwen Live Host is not connected.',
      host_disconnected: 'Qwen Live Host disconnected.',
      host_version: 'Qwen Live Host is not protocol-compatible.',
      microphone_permission: 'Microphone permission is required.',
      accessibility_permission: 'Accessibility permission is required.',
      screen_recording_permission: 'Screen Recording permission is required.',
      audio_input: 'Live Host audio input self-check failed.',
      audio_output: 'Live Host audio output self-check failed.',
      global_shortcut: 'Live Host global shortcut self-check failed.',
      appshot: 'Appshot self-check failed.',
      provider_config: 'Live provider configuration is invalid.',
      provider_unreachable: 'The Live provider is unreachable.',
    };
    return messages[blocker];
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
    if (message.type === 'host.screen_context_result') {
      this.handleScreenContextResult(message);
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
    this.handleAction(message);
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

  private handleScreenContextResult(
    message: LiveHostScreenContextResult,
  ): void {
    const pending = this.pendingAppshots.get(message.requestId);
    if (!pending) return;
    const call = this.call;
    if (!call || call.epoch !== pending.epoch) {
      this.rejectPendingAppshot(
        message.requestId,
        new Error('The Live call changed before Appshot completed.'),
      );
      return;
    }
    this.pendingAppshots.delete(message.requestId);
    clearTimeout(pending.timer);
    if (!message.success) {
      pending.reject(new Error(message.error));
      return;
    }
    pending.resolve({
      appName: message.appName,
      ...(message.windowTitle ? { windowTitle: message.windowTitle } : {}),
      accessibilityText: message.accessibilityText,
      screenshotPath: message.screenshotPath,
    });
  }

  private handleHello(lease: HostLease, hello: LiveHostHello): void {
    if (
      hello.protocolVersion !== LIVE_HOST_PROTOCOL_VERSION ||
      hello.bundleId !== LIVE_HOST_BUNDLE_ID ||
      (lease.hello && lease.hello.instanceNonce !== hello.instanceNonce)
    ) {
      this.lastHostFailure = 'host_version';
      lease.socket.close(4006, 'Incompatible Live Host.');
      this.detachHost(lease, 'host_version');
      return;
    }
    lease.hello = hello;
    lease.lastPongAt = this.now();
    this.hadConnectedHost = true;
    this.lastHostFailure = undefined;
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
    this.sendHost({
      type: 'host.welcome',
      protocolVersion: LIVE_HOST_PROTOCOL_VERSION,
      daemonInstanceNonce: this.daemonInstanceNonce,
      heartbeatIntervalMs: this.heartbeatIntervalMs,
      epoch: this.nextEpoch,
      status: projectStatusForHost(status),
    });
    this.sendState(status);
  }

  private handlePlaybackStarted(message: LiveHostPlaybackStarted): void {
    const call = this.call;
    if (!call || call.epoch !== message.epoch) return;
    this.handlers.onPlaybackStarted?.({ epoch: call.epoch });
  }

  private handlePlaybackCompleted(message: LiveHostPlaybackCompleted): void {
    const call = this.call;
    if (!call || call.epoch !== message.epoch) return;
    this.handlers.onPlaybackCompleted?.({ epoch: call.epoch });
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
        this.sendState(error.status);
        return;
      }
      this.sendState({
        ...this.getStatus(),
        state: 'error',
        message: 'Live Voice failed to start.',
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
        this.failCall(call.epoch, 'Live Voice audio transport dropped input.');
      }
    } catch {
      this.failCall(call.epoch, 'Live Voice audio input failed.');
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
    this.rejectPendingAppshots(
      new Error('The Live call ended before Appshot completed.'),
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
      this.failStoppingCall(call, 'Live Voice failed to stop safely.');
      return;
    }
    if (!result || !('then' in result)) {
      this.finishStoppingCall(call, result);
      return;
    }
    void Promise.resolve(result).then(
      (outcome) => this.finishStoppingCall(call, outcome),
      () => this.failStoppingCall(call, 'Live Voice failed to stop safely.'),
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
    this.notifyInactive();
    this.rejectPendingAppshots(
      new Error('The Live call ended before Appshot completed.'),
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
    this.notifyInactive();
    this.rejectPendingAppshots(new Error(message), call.epoch);
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
    this.rejectPendingAppshots(new Error('Qwen Live Host disconnected.'));
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

  private rejectPendingAppshot(requestId: string, error: Error): void {
    const pending = this.pendingAppshots.get(requestId);
    if (!pending) return;
    this.pendingAppshots.delete(requestId);
    clearTimeout(pending.timer);
    pending.reject(error);
  }

  private rejectPendingAppshots(error: Error, epoch?: number): void {
    for (const [requestId, pending] of this.pendingAppshots) {
      if (epoch !== undefined && pending.epoch !== epoch) continue;
      this.rejectPendingAppshot(requestId, error);
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
    this.sendHost({
      type: 'host.state',
      epoch: this.nextEpoch,
      status: projectStatusForHost(status),
    });
  }

  private sendHostError(
    code: Extract<LiveDaemonMessage, { type: 'host.error' }>['code'],
    message: string,
  ): void {
    this.sendHost({ type: 'host.error', code, message });
  }

  private sendHost(message: LiveDaemonMessage): boolean {
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

  private notifyInactive(): void {
    if (this.call) return;
    for (const resolve of this.inactiveWaiters) resolve();
    this.inactiveWaiters.clear();
  }
}
