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

/** A 1x1 JPEG: enough to satisfy the wire's SOI/EOI and base64 checks. */
const JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01,
  0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
]).toString('base64');

/** A page that reported it can be asked for a screen. */
function sharingHello() {
  return browserHello({
    selfChecks: { audioInput: true, audioOutput: true, screenShare: true },
  });
}

function screenResult(requestId: string) {
  return {
    type: 'host.visual_capture_result',
    requestId,
    success: true,
    source: 'screen',
    image: JPEG,
    width: 1920,
    height: 1080,
    appName: 'Shared screen',
    windowTitle: 'Terminal',
    accessibilityText: '',
    screenshotPath: '/captures/stored-1.jpg',
  };
}

class FakeCaptureStore {
  readonly stored: Buffer[] = [];
  failWith?: Error;

  store(image: Buffer): Promise<string> {
    if (this.failWith) return Promise.reject(this.failWith);
    this.stored.push(image);
    return Promise.resolve(`/captures/stored-${this.stored.length}.jpg`);
  }

  dispose(): void {}
}

/** An active call whose coordinator session is the one allowed to ask. */
function startSharedCall(value: LiveHostCoordinator) {
  const call = value.start('resume');
  value.setCoordinator(call.epoch, {
    workspaceCwd: '/conversations/live-1',
    sessionId: 'coordinator-1',
  });
  return call;
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

  it('pushes the coordinator locator to the browser Host as soon as it exists', () => {
    const value = coordinator();
    const socket = connectBrowser(value);
    const call = value.start('new');
    value.setCoordinator(call.epoch, {
      workspaceCwd: '/conversations/live-1',
      sessionId: 'coordinator-1',
    });

    expect(socket.messages().at(-1)).toMatchObject({
      type: 'host.state',
      status: {
        coordinator: {
          workspaceCwd: '/conversations/live-1',
          sessionId: 'coordinator-1',
        },
      },
    });
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

  it('refuses screen capture without asking a page that cannot share', async () => {
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

  it('asks a sharing page for the screen and stores what it sends', async () => {
    const store = new FakeCaptureStore();
    const value = coordinator({ visualCaptures: store });
    const socket = connectBrowser(value, sharingHello());
    const capture = startSharedCall(value);

    const pending = value.captureVisualContext('coordinator-1');
    const request = socket
      .messages()
      .find((message) => message.type === 'host.capture_visual');
    expect(request).toMatchObject({ epoch: capture.epoch, source: 'screen' });

    socket.receive(screenResult((request as { requestId: string }).requestId));

    await expect(pending).resolves.toEqual({
      appName: 'Shared screen',
      windowTitle: 'Terminal',
      accessibilityText: '',
      screenshotPath: '/captures/stored-1.jpg',
    });
    // The bytes the page sent, not a path it named.
    expect(store.stored).toEqual([Buffer.from(JPEG, 'base64')]);
  });

  it('ignores a path a page claims and hands over the one it stored', async () => {
    const store = new FakeCaptureStore();
    const value = coordinator({ visualCaptures: store });
    const socket = connectBrowser(value, sharingHello());
    startSharedCall(value);

    const pending = value.captureVisualContext('coordinator-1');
    const request = socket
      .messages()
      .find((message) => message.type === 'host.capture_visual');
    socket.receive({
      ...screenResult((request as { requestId: string }).requestId),
      screenshotPath: '/etc/passwd',
    });

    await expect(pending).resolves.toMatchObject({
      screenshotPath: '/captures/stored-1.jpg',
    });
  });

  it('reports a page that answers with a failure', async () => {
    const value = coordinator({ visualCaptures: new FakeCaptureStore() });
    const socket = connectBrowser(value, sharingHello());
    startSharedCall(value);

    const pending = value.captureVisualContext('coordinator-1');
    const request = socket
      .messages()
      .find((message) => message.type === 'host.capture_visual');
    socket.receive({
      type: 'host.visual_capture_result',
      requestId: (request as { requestId: string }).requestId,
      success: false,
      error: 'The user is not sharing a screen.',
    });

    await expect(pending).rejects.toThrow('The user is not sharing a screen.');
  });

  it('reports a capture it could not store rather than a path that is not there', async () => {
    const store = new FakeCaptureStore();
    store.failWith = new Error('The Live capture directory is not private.');
    const value = coordinator({ visualCaptures: store });
    const socket = connectBrowser(value, sharingHello());
    startSharedCall(value);

    const pending = value.captureVisualContext('coordinator-1');
    const request = socket
      .messages()
      .find((message) => message.type === 'host.capture_visual');
    socket.receive(screenResult((request as { requestId: string }).requestId));

    await expect(pending).rejects.toThrow(
      'The shared screen could not be saved: The Live capture directory is not private.',
    );
  });

  it('still requires a native Host to persist its own Appshot', async () => {
    const value = coordinator({ visualCaptures: new FakeCaptureStore() });
    const socket = connectNative(value);
    startSharedCall(value);

    const pending = value.captureVisualContext('coordinator-1');
    const request = socket
      .messages()
      .find((message) => message.type === 'host.capture_visual');
    const { screenshotPath: _dropped, ...withoutPath } = screenResult(
      (request as { requestId: string }).requestId,
    );
    socket.receive(withoutPath);

    await expect(pending).rejects.toThrow('did not persist');
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

describe('browser screen feed ownership', () => {
  it('advertises the extension only for a wired browser endpoint', () => {
    const value = coordinator({ handlers: { onScreenFeed: vi.fn() } });
    const socket = connectBrowser(value, sharingHello());
    expect(
      socket.messages().find((m) => m.type === 'host.welcome'),
    ).toMatchObject({ screenFeedV1: true });
    const old = connectBrowser(coordinator(), sharingHello());
    expect(
      old.messages().find((m) => m.type === 'host.welcome'),
    ).not.toHaveProperty('screenFeedV1');
  });

  it('routes only the active epoch and feed, without restarting retransmissions', () => {
    const handler = vi.fn();
    const value = coordinator({ handlers: { onScreenFeed: handler } });
    const socket = connectBrowser(value, sharingHello());
    const call = value.start('new');
    value.setCallState(call.epoch, 'listening');
    const start = {
      type: 'host.screen_feed_start',
      epoch: call.epoch,
      feedId: 'watch-1',
    };
    socket.receive({ ...start, epoch: call.epoch - 1 });
    expect(handler).not.toHaveBeenCalled();
    socket.receive(start);
    socket.receive(start);
    expect(handler).toHaveBeenCalledExactlyOnceWith(start);
    socket.receive({
      type: 'host.screen_feed_frame',
      epoch: call.epoch,
      feedId: 'obsolete',
      image: JPEG,
    });
    expect(handler).toHaveBeenCalledOnce();
    socket.receive({
      type: 'host.screen_feed_frame',
      epoch: call.epoch,
      feedId: 'watch-1',
      image: JPEG,
    });
    expect(handler).toHaveBeenCalledTimes(2);
    expect(
      value.setScreenFeedState(call.epoch, 'obsolete', 'streaming', 'old'),
    ).toBe(false);
    expect(value.setScreenFeedState(call.epoch, 'watch-1', 'streaming')).toBe(
      true,
    );
    socket.receive({
      type: 'host.screen_feed_stop',
      epoch: call.epoch,
      feedId: 'watch-1',
    });
    expect(handler).toHaveBeenLastCalledWith({
      type: 'host.screen_feed_stop',
      epoch: call.epoch,
      feedId: 'watch-1',
    });
    value.stop();
    socket.receive(start);
    expect(handler).toHaveBeenCalledTimes(3);
  });

  it('refuses streaming without a declared share capability', () => {
    const handler = vi.fn();
    const value = coordinator({ handlers: { onScreenFeed: handler } });
    const socket = connectBrowser(value);
    const call = value.start('new');
    value.setCallState(call.epoch, 'listening');
    socket.receive({
      type: 'host.screen_feed_start',
      epoch: call.epoch,
      feedId: 'watch',
    });
    expect(handler).not.toHaveBeenCalled();
    expect(socket.messages().at(-1)).toMatchObject({
      type: 'host.error',
      code: 'invalid_message',
    });
  });

  it('rejects native-host feed messages', () => {
    const handler = vi.fn();
    const value = coordinator({ handlers: { onScreenFeed: handler } });
    const socket = new FakeSocket();
    value.attachHost(socket as unknown as WebSocket, value.daemonInstanceNonce);
    socket.receive(nativeHello());
    const call = value.start('new');
    value.setCallState(call.epoch, 'listening');
    socket.receive({
      type: 'host.screen_feed_start',
      epoch: call.epoch,
      feedId: 'watch',
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it.each([
    { type: 'host.screen_feed_start', epoch: -1 },
    { type: 'host.screen_feed_start', feedId: 'x'.repeat(129) },
    { type: 'host.screen_feed_frame', image: 'not-jpeg' },
    {
      type: 'host.screen_feed_frame',
      image: Buffer.alloc(191 * 1024).toString('base64'),
    },
  ])('rejects invalid or unbounded input: $type', (payload) => {
    const handler = vi.fn();
    const value = coordinator({ handlers: { onScreenFeed: handler } });
    const socket = connectBrowser(value, sharingHello());
    socket.receive({ epoch: 1, feedId: 'watch', ...payload });
    expect(socket.closeCode).toBe(1002);
    expect(handler).not.toHaveBeenCalled();
  });
});
