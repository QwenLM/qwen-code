/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LiveBrowserHostUnsupportedError,
  LiveHostCoordinator,
} from './live-host-coordinator.js';
import {
  LIVE_HOST_BUNDLE_ID,
  LIVE_HOST_PROTOCOL_VERSION,
  LIVE_INPUT_AUDIO_EPOCH_BYTES,
  LIVE_OUTPUT_AUDIO_HEADER_BYTES,
  LIVE_WEB_HOST_BUNDLE_ID,
  type LiveDaemonMessage,
} from './types.js';

class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  readonly sent: Array<string | Uint8Array> = [];
  closeCode?: number;
  closeReason?: string;

  send(data: string | Uint8Array): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closeCode = code;
    this.closeReason = reason;
    this.readyState = WebSocket.CLOSED;
    this.emit('close');
  }

  receive(message: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify(message)), false);
  }

  receiveAudio(epoch: number, bytes: readonly number[]): void {
    const frame = Buffer.alloc(LIVE_INPUT_AUDIO_EPOCH_BYTES + bytes.length);
    frame.writeBigUInt64BE(BigInt(epoch), 0);
    Buffer.from(bytes).copy(frame, LIVE_INPUT_AUDIO_EPOCH_BYTES);
    this.emit('message', frame, true);
  }

  messages(): LiveDaemonMessage[] {
    return this.sent
      .filter((value): value is string => typeof value === 'string')
      .map((value) => JSON.parse(value) as LiveDaemonMessage);
  }

  binaryFrames(): Buffer[] {
    return this.sent
      .filter((value): value is Uint8Array => typeof value !== 'string')
      .map((value) => Buffer.from(value));
  }
}

const coordinators: LiveHostCoordinator[] = [];

function coordinator(
  options: Partial<ConstructorParameters<typeof LiveHostCoordinator>[0]> = {},
): LiveHostCoordinator {
  const value = new LiveHostCoordinator({
    daemonInstanceNonce: 'daemon_instance_nonce_0001',
    getProviderReadiness: () => ({ state: 'ready' }),
    ...options,
  });
  value.setAppshotReadiness({ state: 'ready' });
  coordinators.push(value);
  return value;
}

/** What a Web Shell page sends: no OS-level permissions or self-checks. */
function browserHello(overrides: Record<string, unknown> = {}) {
  return {
    type: 'host.hello',
    kind: 'browser',
    protocolVersion: LIVE_HOST_PROTOCOL_VERSION,
    hostVersion: '0.24.0',
    bundleId: LIVE_WEB_HOST_BUNDLE_ID,
    instanceNonce: 'browser_tab_nonce_0001',
    permissions: { microphone: 'granted' },
    selfChecks: { audioInput: true, audioOutput: true },
    ...overrides,
  };
}

function nativeHello() {
  return {
    type: 'host.hello',
    protocolVersion: LIVE_HOST_PROTOCOL_VERSION,
    hostVersion: '1.0.0',
    bundleId: LIVE_HOST_BUNDLE_ID,
    instanceNonce: 'host_instance_nonce_0001',
    permissions: {
      microphone: 'granted',
      camera: 'granted',
      accessibility: 'granted',
      screenRecording: 'granted',
    },
    selfChecks: {
      audioInput: true,
      audioOutput: true,
      globalShortcut: true,
      appshot: true,
    },
  };
}

function connectBrowser(
  value: LiveHostCoordinator,
  hello: unknown = browserHello(),
  options?: { takeover?: boolean },
): FakeSocket {
  const socket = new FakeSocket();
  value.attachBrowserHost(socket as unknown as WebSocket, options);
  socket.receive(hello);
  return socket;
}

function connectNative(value: LiveHostCoordinator): FakeSocket {
  const socket = new FakeSocket();
  value.attachHost(socket as unknown as WebSocket, value.daemonInstanceNonce);
  socket.receive(nativeHello());
  return socket;
}

afterEach(() => {
  for (const value of coordinators.splice(0)) value.dispose();
  vi.useRealTimers();
});

describe('LiveHostCoordinator browser Host', () => {
  it('admits a browser hello without the native-only permissions and self-checks', () => {
    const value = coordinator();
    const socket = connectBrowser(value);

    const status = value.getStatus();
    expect(socket.closeCode).toBeUndefined();
    expect(status.available).toBe(true);
    expect(status.blocker).toBeUndefined();
    expect(status.host).toEqual({
      version: '0.24.0',
      protocolVersion: LIVE_HOST_PROTOCOL_VERSION,
      kind: 'browser',
    });
    expect(status.requirements).toEqual({
      host: 'ready',
      provider: 'ready',
      microphone: 'ready',
      audioInput: 'ready',
      audioOutput: 'ready',
      appshot: 'ready',
    });
    expect(socket.messages().map((message) => message.type)).toEqual([
      'host.welcome',
      'host.state',
    ]);
  });

  it('does not mark a native status with a kind', () => {
    const value = coordinator();
    connectNative(value);
    expect(value.getStatus().host).toEqual({
      version: '1.0.0',
      protocolVersion: LIVE_HOST_PROTOCOL_VERSION,
    });
  });

  it('rejects a hello whose bundle or kind does not match its ingress', () => {
    const viaNative = coordinator();
    const nativeSocket = new FakeSocket();
    viaNative.attachHost(
      nativeSocket as unknown as WebSocket,
      viaNative.daemonInstanceNonce,
    );
    nativeSocket.receive(browserHello());
    expect(nativeSocket.closeCode).toBe(4006);
    expect(viaNative.getStatus().blocker).toBe('host_version');

    const viaBrowser = coordinator();
    expect(connectBrowser(viaBrowser, nativeHello()).closeCode).toBe(4006);

    const lyingKind = coordinator();
    expect(
      connectBrowser(lyingKind, browserHello({ kind: 'native' })).closeCode,
    ).toBe(4006);
  });

  it('still requires the microphone, the audio devices and the Live runtime', () => {
    const denied = coordinator();
    connectBrowser(
      denied,
      browserHello({ permissions: { microphone: 'denied' } }),
    );
    expect(denied.getStatus().blocker).toBe('microphone_permission');

    const noOutput = coordinator();
    connectBrowser(
      noOutput,
      browserHello({ selfChecks: { audioInput: true, audioOutput: false } }),
    );
    expect(noOutput.getStatus().blocker).toBe('audio_output');

    const noRuntime = coordinator();
    noRuntime.setAppshotReadiness({
      state: 'unavailable',
      message: 'The dedicated Live Appshot channel is unavailable.',
    });
    connectBrowser(noRuntime);
    expect(noRuntime.getStatus()).toMatchObject({
      available: false,
      blocker: 'appshot',
      // Not the native "self-check failed" wording: a page has no self-check.
      message: 'The dedicated Live Appshot channel is unavailable.',
    });
  });

  it('rejects a malformed browser hello', () => {
    const value = coordinator();
    const socket = connectBrowser(
      value,
      browserHello({ selfChecks: { audioInput: true } }),
    );
    expect(socket.closeCode).toBe(1002);
    expect(value.getStatus().requirements?.host).not.toBe('ready');
  });

  it('never lets a browser displace a native Host', () => {
    const value = coordinator();
    const native = connectNative(value);
    const browser = connectBrowser(value, browserHello(), { takeover: true });

    expect(browser.closeCode).toBe(4009);
    expect(native.closeCode).toBeUndefined();
    // Still the native Host: its status carries no kind.
    expect(value.getStatus().host).toEqual({
      version: '1.0.0',
      protocolVersion: LIVE_HOST_PROTOCOL_VERSION,
    });
  });

  it('lets a native Host supersede a browser and stops its call first', () => {
    const onStop = vi.fn();
    const value = coordinator({ handlers: { onStop } });
    const browser = connectBrowser(value);
    const call = value.start('resume');

    const native = connectNative(value);

    expect(browser.closeCode).toBe(4010);
    expect(browser.closeReason).toBe('Superseded by native Live Host.');
    expect(onStop).toHaveBeenCalledWith({
      epoch: call.epoch,
      callId: call.callId,
    });
    expect(native.closeCode).toBeUndefined();
    // Still the native Host: its status carries no kind.
    expect(value.getStatus().host).toEqual({
      version: '1.0.0',
      protocolVersion: LIVE_HOST_PROTOCOL_VERSION,
    });
    expect(value.getStatus()).toMatchObject({ available: true, state: 'idle' });
  });

  it('displaces another browser tab only on an explicit takeover', () => {
    const value = coordinator();
    const first = connectBrowser(value);

    const refused = connectBrowser(
      value,
      browserHello({ instanceNonce: 'browser_tab_nonce_0002' }),
    );
    expect(refused.closeCode).toBe(4009);
    expect(first.closeCode).toBeUndefined();

    const taker = connectBrowser(
      value,
      browserHello({ instanceNonce: 'browser_tab_nonce_0003' }),
      { takeover: true },
    );
    expect(first.closeCode).toBe(4010);
    expect(first.closeReason).toBe('Superseded by another Web Shell tab.');
    expect(taker.closeCode).toBeUndefined();
    expect(value.getStatus().available).toBe(true);
  });

  it('carries call audio both ways with the native framing', () => {
    const onInputAudio = vi.fn(() => true);
    const value = coordinator({ handlers: { onInputAudio } });
    const socket = connectBrowser(value);
    const call = value.start('resume');

    socket.receiveAudio(call.epoch, [1, 2, 3, 4]);
    expect(onInputAudio).toHaveBeenCalledWith({
      epoch: call.epoch,
      callId: call.callId,
      pcm16: Buffer.from([1, 2, 3, 4]),
    });

    expect(value.sendOutputAudio(call.epoch, Buffer.from([5, 6, 7, 8]))).toBe(
      true,
    );
    const [frame] = socket.binaryFrames();
    expect(Number(frame.readBigUInt64BE(0))).toBe(call.epoch);
    expect(frame.subarray(LIVE_OUTPUT_AUDIO_HEADER_BYTES)).toEqual(
      Buffer.from([5, 6, 7, 8]),
    );
  });

  it('refuses screen capture without asking the page', async () => {
    const value = coordinator();
    const socket = connectBrowser(value);
    const call = value.start('resume');
    value.setCoordinator(call.epoch, {
      workspaceCwd: '/conversations/live-1',
      sessionId: 'coordinator-1',
    });

    await expect(
      value.captureVisualContext('coordinator-1'),
    ).rejects.toBeInstanceOf(LiveBrowserHostUnsupportedError);
    expect(socket.messages().map((message) => message.type)).not.toContain(
      'host.capture_visual',
    );
  });

  it('keeps a shortcut change as a setting for the next native Host', async () => {
    const value = coordinator();
    const browser = connectBrowser(value);

    // Resolves at once: a page has no global shortcut to confirm, and the
    // native round trip would otherwise time out.
    const status = await value.setShortcut('Alt+Space');
    expect(status.shortcut).toBe('Alt+Space');
    expect(browser.messages().map((message) => message.type)).not.toContain(
      'host.set_shortcut',
    );

    const native = connectNative(value);
    const welcome = native
      .messages()
      .find((message) => message.type === 'host.welcome');
    expect(welcome).toMatchObject({ status: { shortcut: 'Alt+Space' } });
  });
});
