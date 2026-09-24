/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment jsdom

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  useLiveBrowserHost,
  type UseLiveBrowserHostResult,
} from './useLiveBrowserHost';

// The capture pipeline itself (video element, canvas, JPEG ladder) is covered
// in screen-share.test.ts; here only what crosses the Host socket matters.
const shareHandle = {
  label: 'Terminal',
  stop: vi.fn(),
  grab: vi.fn(),
};
const canShare = vi.fn(() => true);
const startShare = vi.fn();
vi.mock('./screen-share', () => ({
  canShareScreen: () => canShare(),
  startScreenShare: (onEnded: () => void) => startShare(onEnded),
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static instances: MockWebSocket[] = [];

  readyState = MockWebSocket.OPEN;
  bufferedAmount = 0;
  binaryType = 'blob';
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  readonly sent: Array<string | ArrayBuffer> = [];
  closedWith?: number;

  constructor(
    readonly url: string,
    readonly protocols?: string | string[],
  ) {
    MockWebSocket.instances.push(this);
  }

  send(data: string | ArrayBuffer): void {
    this.sent.push(data);
  }

  close(code?: number): void {
    this.closedWith = code;
    this.readyState = 3;
  }

  text(): Array<Record<string, unknown>> {
    return this.sent
      .filter((value): value is string => typeof value === 'string')
      .map((value) => JSON.parse(value) as Record<string, unknown>);
  }

  audio(): ArrayBuffer[] {
    return this.sent.filter(
      (value): value is ArrayBuffer => typeof value !== 'string',
    );
  }

  receive(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent);
  }

  receiveAudio(epoch: number, samples: number[]): void {
    const frame = new ArrayBuffer(16 + samples.length * 2);
    const view = new DataView(frame);
    view.setBigUint64(0, BigInt(epoch));
    samples.forEach((sample, i) => view.setInt16(16 + i * 2, sample, true));
    this.onmessage?.({ data: frame } as MessageEvent);
  }

  serverClose(code: number, reason = ''): void {
    this.readyState = 3;
    this.onclose?.({ code, reason } as CloseEvent);
  }
}

function node() {
  return { connect: vi.fn(), disconnect: vi.fn() };
}

type Processor = ReturnType<typeof node> & {
  onaudioprocess: ((event: AudioProcessingEvent) => void) | null;
};

class MockWorkletNode {
  static instances: MockWorkletNode[] = [];
  static failConstruction = false;
  connect = vi.fn();
  disconnect = vi.fn();
  port: {
    onmessage: ((event: MessageEvent) => void) | null;
    close: ReturnType<typeof vi.fn>;
  } = { onmessage: null, close: vi.fn() };

  constructor(
    readonly context: unknown,
    readonly name: string,
    readonly options: Record<string, unknown>,
  ) {
    if (MockWorkletNode.failConstruction) throw new Error('not registered');
    MockWorkletNode.instances.push(this);
  }

  /** A frame as the audio thread posts it. */
  post(samples: number[], level: number): void {
    const pcm = Int16Array.from(samples).buffer;
    this.port.onmessage?.({ data: { pcm, level } } as MessageEvent);
  }
}

class MockAudioContext {
  static instances: MockAudioContext[] = [];
  /** `undefined`: the browser has no AudioWorklet (the default here). */
  static addModule: ((url: string) => Promise<void>) | undefined;
  static processor: Processor | undefined;
  static sources: Array<{
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
  }> = [];

  state = 'running';
  currentTime = 0;
  readonly sampleRate: number;
  readonly destination = {};
  get audioWorklet():
    | { addModule: (url: string) => Promise<void> }
    | undefined {
    return MockAudioContext.addModule
      ? { addModule: MockAudioContext.addModule }
      : undefined;
  }
  createMediaStreamSource = vi.fn(() => node());
  createScriptProcessor = vi.fn((size: number) => {
    const processor = { ...node(), onaudioprocess: null, size };
    MockAudioContext.processor = processor;
    return processor;
  });
  createGain = vi.fn(() => ({ ...node(), gain: { value: 1 } }));
  createBuffer = vi.fn((_channels: number, length: number, rate: number) => {
    const samples = new Float32Array(length);
    return { duration: length / rate, getChannelData: () => samples };
  });
  createBufferSource = vi.fn(() => {
    const source = {
      ...node(),
      start: vi.fn(),
      stop: vi.fn(),
      onended: null,
      buffer: null,
    };
    MockAudioContext.sources.push(source);
    return source;
  });
  resume = vi.fn(async () => {});
  close = vi.fn(async () => {
    this.state = 'closed';
  });

  constructor(options?: { sampleRate?: number }) {
    this.sampleRate = options?.sampleRate ?? 48_000;
    MockAudioContext.instances.push(this);
  }
}

const track = { stop: vi.fn() };
const getUserMedia = vi.fn();
const onStatus = vi.fn();
let root: Root | null = null;
let container: HTMLDivElement | null = null;
let host: UseLiveBrowserHostResult | undefined;
let token: string | undefined;
/** The `onended` the hook handed to the share, i.e. the browser's own stop. */
let shareEnded: (() => void) | undefined;

function TestHost() {
  host = useLiveBrowserHost({
    baseUrl: 'http://127.0.0.1:4170',
    token,
    onStatus,
  });
  return null;
}

async function render(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(React.createElement(TestHost));
  });
}

/** Connect and complete the handshake; returns the socket. */
async function connected(options?: {
  takeover?: boolean;
}): Promise<MockWebSocket> {
  await act(async () => {
    host!.connect(options);
  });
  const ws = MockWebSocket.instances.at(-1)!;
  await act(async () => {
    ws.onopen?.();
    ws.receive({ type: 'host.welcome', epoch: 0, status: status('idle') });
  });
  return ws;
}

function status(
  state: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { v: 1, available: true, state, shortcut: '', ...extra };
}

function speak(samples: number[] = [0.5, -0.5]): void {
  MockAudioContext.processor!.onaudioprocess?.({
    inputBuffer: { getChannelData: () => Float32Array.from(samples) },
  } as unknown as AudioProcessingEvent);
}

beforeEach(() => {
  host = undefined;
  token = undefined;
  onStatus.mockReset();
  track.stop.mockReset();
  getUserMedia.mockReset();
  getUserMedia.mockResolvedValue({
    getTracks: () => [track],
    getAudioTracks: () => [track],
  });
  canShare.mockReset();
  canShare.mockReturnValue(true);
  shareHandle.stop.mockReset();
  shareHandle.grab.mockReset();
  shareHandle.grab.mockResolvedValue({
    image: 'ZmFrZS1qcGVn',
    width: 1920,
    height: 1080,
  });
  startShare.mockReset();
  startShare.mockImplementation((onEnded: () => void) => {
    shareEnded = onEnded;
    return Promise.resolve(shareHandle);
  });
  shareEnded = undefined;
  MockWebSocket.instances = [];
  MockAudioContext.instances = [];
  MockAudioContext.processor = undefined;
  MockAudioContext.sources = [];
  MockAudioContext.addModule = undefined;
  MockWorkletNode.instances = [];
  MockWorkletNode.failConstruction = false;
  Object.defineProperty(globalThis, 'AudioWorkletNode', {
    value: MockWorkletNode,
    configurable: true,
  });
  Object.defineProperty(globalThis, 'WebSocket', {
    value: MockWebSocket,
    configurable: true,
  });
  Object.defineProperty(globalThis, 'AudioContext', {
    value: MockAudioContext,
    configurable: true,
  });
  Object.defineProperty(navigator, 'mediaDevices', {
    value: { getUserMedia },
    configurable: true,
  });
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

describe('useLiveBrowserHost', () => {
  it('takes the lease on /live/web with the reduced browser hello', async () => {
    token = 'secret-token';
    await render();
    const ws = await connected();

    expect(ws.url).toBe('ws://127.0.0.1:4170/live/web');
    expect(ws.protocols).toEqual([
      'qwen-ws',
      expect.stringMatching(/^qwen-bearer\./),
    ]);
    expect(ws.text()[0]).toEqual({
      type: 'host.hello',
      kind: 'browser',
      protocolVersion: 9,
      hostVersion: 'web-shell',
      bundleId: 'com.alibaba.qwen-code.web-shell',
      instanceNonce: expect.any(String),
      permissions: { microphone: 'granted' },
      selfChecks: { audioInput: true, audioOutput: true, screenShare: true },
    });
    expect(host!.phase).toBe('connected');
    expect(onStatus).toHaveBeenCalledWith(status('idle'));
    // 64 ms frames, not dictation's 256 ms.
    expect(
      MockAudioContext.instances[0]!.createScriptProcessor,
    ).toHaveBeenCalledWith(1024, 1, 1);
    expect(MockAudioContext.instances.map((c) => c.sampleRate)).toEqual([
      16_000, 24_000,
    ]);
  });

  it('answers a screen request with one frame from the shared screen', async () => {
    await render();
    const ws = await connected();
    await act(async () => {
      await host!.startSharingScreen();
    });

    await act(async () => {
      ws.receive({
        type: 'host.capture_visual',
        requestId: 'req-1',
        epoch: 0,
        source: 'screen',
      });
    });

    expect(shareHandle.grab).toHaveBeenCalledOnce();
    expect(ws.text().at(-1)).toEqual({
      type: 'host.visual_capture_result',
      requestId: 'req-1',
      success: true,
      source: 'screen',
      image: 'ZmFrZS1qcGVn',
      width: 1920,
      height: 1080,
      appName: 'Shared screen',
      windowTitle: 'Terminal',
      accessibilityText: '',
    });
    expect(host!.screenShare.lastLookAt).toBeTypeOf('number');
  });

  it('answers at once when nothing is shared, and says so in the dialog', async () => {
    await render();
    const ws = await connected();

    await act(async () => {
      ws.receive({
        type: 'host.capture_visual',
        requestId: 'req-2',
        epoch: 0,
        source: 'screen',
      });
    });

    // A silent drop would leave the daemon waiting out its Appshot timeout
    // while the model has nothing to tell the user.
    expect(ws.text().at(-1)).toEqual({
      type: 'host.visual_capture_result',
      requestId: 'req-2',
      success: false,
      error: 'The user is not sharing a screen.',
    });
    expect(host!.screenShare.requestedWhileIdle).toBe(true);
    expect(host!.screenShare.lastLookAt).toBeUndefined();
  });

  it('refuses to read the screen for a call that has moved on', async () => {
    await render();
    const ws = await connected();
    await act(async () => {
      await host!.startSharingScreen();
    });

    await act(async () => {
      ws.receive({
        type: 'host.capture_visual',
        requestId: 'req-stale',
        epoch: 7,
        source: 'screen',
      });
    });

    expect(ws.text().at(-1)).toMatchObject({
      requestId: 'req-stale',
      success: false,
    });
    // The daemon would discard the result anyway, but only after the frame
    // had left the machine.
    expect(shareHandle.grab).not.toHaveBeenCalled();
  });

  it('refuses a source it cannot be', async () => {
    await render();
    const ws = await connected();
    await act(async () => {
      await host!.startSharingScreen();
    });

    await act(async () => {
      ws.receive({
        type: 'host.capture_visual',
        requestId: 'req-3',
        epoch: 0,
        source: 'camera',
      });
    });

    expect(ws.text().at(-1)).toMatchObject({
      requestId: 'req-3',
      success: false,
      error: 'This Host can only share a screen.',
    });
    expect(shareHandle.grab).not.toHaveBeenCalled();
  });

  it('reports a capture that failed instead of going quiet', async () => {
    await render();
    const ws = await connected();
    await act(async () => {
      await host!.startSharingScreen();
    });
    shareHandle.grab.mockRejectedValue(
      new Error('The screen was too detailed to send.'),
    );

    await act(async () => {
      ws.receive({
        type: 'host.capture_visual',
        requestId: 'req-4',
        epoch: 0,
        source: 'screen',
      });
    });

    expect(ws.text().at(-1)).toMatchObject({
      requestId: 'req-4',
      success: false,
      error: 'The screen was too detailed to send.',
    });
  });

  it('follows the browser\u2019s own stop-sharing control', async () => {
    await render();
    await connected();
    await act(async () => {
      await host!.startSharingScreen();
    });
    expect(host!.screenShare.sharing).toBe(true);

    await act(async () => {
      shareEnded?.();
    });

    expect(host!.screenShare.sharing).toBe(false);
    expect(host!.screenShare.label).toBeUndefined();
  });

  it('treats a dismissed picker as a choice, not an error', async () => {
    await render();
    await connected();
    startShare.mockRejectedValue(
      new DOMException('Permission denied', 'NotAllowedError'),
    );

    await act(async () => {
      await host!.startSharingScreen();
    });

    expect(host!.screenShare.sharing).toBe(false);
    expect(host!.screenShare.errorMessage).toBeUndefined();
  });

  it('ends the share when the Host connection goes', async () => {
    await render();
    const ws = await connected();
    await act(async () => {
      await host!.startSharingScreen();
    });

    await act(async () => {
      ws.serverClose(4010, 'Qwen Live Host took over.');
    });

    // No page keeps a screen open that nothing can look at.
    expect(shareHandle.stop).toHaveBeenCalled();
    expect(host!.screenShare.sharing).toBe(false);
  });

  it('never offers the share where getDisplayMedia is missing', async () => {
    canShare.mockReturnValue(false);
    await render();
    const ws = await connected();

    expect(host!.screenShare.supported).toBe(false);
    expect(
      (ws.text()[0]['selfChecks'] as Record<string, unknown>)['screenShare'],
    ).toBe(false);
  });

  it('asks for the lease back only when told to take over', async () => {
    await render();
    const ws = await connected({ takeover: true });
    expect(ws.url).toBe('ws://127.0.0.1:4170/live/web?takeover=1');
  });

  it('does not take the lease when the microphone is refused', async () => {
    getUserMedia.mockRejectedValue(
      Object.assign(new Error('denied'), { name: 'NotAllowedError' }),
    );
    await render();
    await act(async () => {
      host!.connect();
    });

    expect(MockWebSocket.instances).toHaveLength(0);
    expect(host!.phase).toBe('error');
    expect(host!.closeReason).toBe('microphone');
    expect(host!.errorMessage).toMatch(/Microphone blocked/);
    expect(MockAudioContext.instances.every((c) => c.state === 'closed')).toBe(
      true,
    );
  });

  it('answers the daemon heartbeat', async () => {
    await render();
    const ws = await connected();
    await act(async () => {
      ws.receive({ type: 'host.ping', pingId: 'ping-7' });
    });
    expect(ws.text().at(-1)).toEqual({ type: 'host.pong', pingId: 'ping-7' });
  });

  it('streams the microphone only once the call can accept audio', async () => {
    await render();
    const ws = await connected();

    // `starting`: the daemon fails a call that gets audio before its
    // realtime session is open.
    await act(async () => {
      ws.receive({ type: 'host.state', epoch: 4, status: status('starting') });
    });
    speak();
    expect(ws.audio()).toHaveLength(0);

    await act(async () => {
      ws.receive({ type: 'host.state', epoch: 4, status: status('listening') });
    });
    speak([1, -1]);
    const [frame] = ws.audio();
    const view = new DataView(frame!);
    expect(Number(view.getBigUint64(0))).toBe(4);
    expect(view.getInt16(8, true)).toBe(0x7fff);
    expect(view.getInt16(10, true)).toBe(-0x8000);

    await act(async () => {
      ws.receive({
        type: 'host.state',
        epoch: 4,
        status: status('listening', { inputMuted: true }),
      });
    });
    speak();
    expect(ws.audio()).toHaveLength(1);
  });

  it('measures the microphone before the call starts, so it can be checked', async () => {
    await render();
    const ws = await connected();

    // Idle: nothing is sent yet, but the meter answers "will it hear me?".
    speak([0.5, -0.5]);
    expect(host!.inputLevel.current.level).toBeCloseTo(0.5, 3);
    expect(host!.inputLevel.current.dropping).toBe(false);
    expect(ws.audio()).toHaveLength(0);

    await act(async () => {
      ws.receive({ type: 'host.state', epoch: 1, status: status('listening') });
    });
    speak([0.5, -0.5]);
    expect(host!.inputLevel.current.level).toBeCloseTo(0.5, 3);
    expect(ws.audio()).toHaveLength(1);
  });

  it('stamps every frame, so a meter can tell a stalled callback from silence', async () => {
    const now = vi.spyOn(performance, 'now');
    await render();
    await connected();
    now.mockReturnValue(1_000);
    speak([0.5, -0.5]);
    expect(host!.inputLevel.current.at).toBe(1_000);
    now.mockReturnValue(1_064);
    speak([0.5, -0.5]);
    expect(host!.inputLevel.current.at).toBe(1_064);
    now.mockRestore();
  });

  it('drops the meter to zero when input is muted', async () => {
    await render();
    const ws = await connected();
    await act(async () => {
      ws.receive({ type: 'host.state', epoch: 1, status: status('listening') });
    });
    speak([0.5, -0.5]);
    expect(host!.inputLevel.current.level).toBeGreaterThan(0);

    await act(async () => {
      ws.receive({
        type: 'host.state',
        epoch: 1,
        status: status('listening', { inputMuted: true }),
      });
    });
    // Not frozen at the last level before the mute.
    speak([0.5, -0.5]);
    expect(host!.inputLevel.current.level).toBe(0);
  });

  it('reads zero, not the last level, once the socket is no longer open', async () => {
    await render();
    const ws = await connected();
    await act(async () => {
      ws.receive({ type: 'host.state', epoch: 1, status: status('listening') });
    });
    speak([0.5, -0.5]);
    expect(host!.inputLevel.current.level).toBeGreaterThan(0);

    ws.readyState = 2; // CLOSING: the capture callback can still fire
    speak([0.5, -0.5]);
    expect(host!.inputLevel.current.level).toBe(0);
  });

  it('flags frames it drops during a call, instead of looking healthy', async () => {
    await render();
    const ws = await connected();
    await act(async () => {
      ws.receive({ type: 'host.state', epoch: 1, status: status('listening') });
    });
    ws.bufferedAmount = 10 * 1024 * 1024;
    speak([0.5, -0.5]);

    // The microphone works and the daemon still is not hearing it.
    expect(ws.audio()).toHaveLength(0);
    expect(host!.inputLevel.current).toMatchObject({ dropping: true });
    expect(host!.inputLevel.current.level).toBeGreaterThan(0);

    // Sending resumes at once; the report itself is held (see below).
    ws.bufferedAmount = 0;
    speak([0.5, -0.5]);
    expect(ws.audio()).toHaveLength(1);
  });

  it('holds the dropping report instead of flickering with the socket buffer', async () => {
    const now = vi.spyOn(performance, 'now');
    await render();
    const ws = await connected();
    await act(async () => {
      ws.receive({ type: 'host.state', epoch: 1, status: status('listening') });
    });

    // bufferedAmount hovering around the limit: over, under, over, under...
    now.mockReturnValue(1_000);
    ws.bufferedAmount = 10 * 1024 * 1024;
    speak([0.5, -0.5]);
    expect(host!.inputLevel.current.dropping).toBe(true);
    expect(ws.audio()).toHaveLength(0);

    // The very next frame goes out again — but the report does not flip back
    // 64 ms later, or the flag would strobe at the audio frame rate.
    now.mockReturnValue(1_064);
    ws.bufferedAmount = 0;
    speak([0.5, -0.5]);
    expect(ws.audio()).toHaveLength(1);
    expect(host!.inputLevel.current.dropping).toBe(true);

    now.mockReturnValue(1_400);
    speak([0.5, -0.5]);
    expect(host!.inputLevel.current.dropping).toBe(true);

    // Half a second after the last dropped frame it clears.
    now.mockReturnValue(1_501);
    speak([0.5, -0.5]);
    expect(host!.inputLevel.current.dropping).toBe(false);
    expect(ws.audio()).toHaveLength(3);
    now.mockRestore();
  });

  it('ends the dropping report with the call', async () => {
    const now = vi.spyOn(performance, 'now');
    await render();
    const ws = await connected();
    await act(async () => {
      ws.receive({ type: 'host.state', epoch: 1, status: status('listening') });
    });
    now.mockReturnValue(1_000);
    ws.bufferedAmount = 10 * 1024 * 1024;
    speak([0.5, -0.5]);
    expect(host!.inputLevel.current.dropping).toBe(true);

    // The call stops inside the hold window: nothing is being sent by design
    // now, and that is not a fault to keep reporting.
    await act(async () => {
      ws.receive({ type: 'host.state', epoch: 2, status: status('idle') });
    });
    now.mockReturnValue(1_064);
    speak([0.5, -0.5]);
    expect(host!.inputLevel.current.dropping).toBe(false);
    now.mockRestore();
  });

  it('does not call a backed-up socket "dropping" before the call has started', async () => {
    await render();
    const ws = await connected();
    ws.bufferedAmount = 10 * 1024 * 1024;
    speak([0.5, -0.5]);
    // Nothing is sent while idle anyway; that is not a fault to report.
    expect(host!.inputLevel.current.dropping).toBe(false);
  });

  it('drops microphone frames rather than queue them behind a stalled socket', async () => {
    await render();
    const ws = await connected();
    await act(async () => {
      ws.receive({ type: 'host.state', epoch: 1, status: status('listening') });
    });
    ws.bufferedAmount = 10 * 1024 * 1024;
    speak();
    expect(ws.audio()).toHaveLength(0);
  });

  it('plays downstream audio and cuts it when the user barges in', async () => {
    await render();
    const ws = await connected();
    await act(async () => {
      ws.receiveAudio(2, [100, 200, 300]);
      ws.receiveAudio(2, [100, 200, 300]);
    });
    expect(MockAudioContext.sources).toHaveLength(2);
    expect(MockAudioContext.sources[0]!.start).toHaveBeenCalledOnce();

    await act(async () => {
      ws.receive({ type: 'host.clear_output', epoch: 2 });
    });
    expect(
      MockAudioContext.sources.map((s) => s.stop.mock.calls.length),
    ).toEqual([1, 1]);
  });

  it('stays silent while output is muted', async () => {
    await render();
    const ws = await connected();
    await act(async () => {
      ws.receive({
        type: 'host.state',
        epoch: 2,
        status: status('speaking', { outputMuted: true }),
      });
      ws.receiveAudio(2, [100, 200]);
    });
    expect(MockAudioContext.sources).toHaveLength(0);
  });

  it.each([
    [4009, 'A Live Host is already connected.', 'occupied'],
    [4010, 'Superseded by native Live Host.', 'superseded-native'],
    [4010, 'Superseded by another Web Shell tab.', 'superseded-tab'],
    [4003, 'Workspace is not trusted.', 'refused'],
    [1006, '', 'lost'],
  ] as const)(
    'reports close %i (%s) as %s and frees the microphone',
    async (code, reason, expected) => {
      await render();
      const ws = await connected();
      await act(async () => {
        ws.serverClose(code, reason);
      });

      expect(host!.phase).toBe('error');
      expect(host!.closeReason).toBe(expected);
      expect(track.stop).toHaveBeenCalled();
      expect(
        MockAudioContext.instances.every((c) => c.state === 'closed'),
      ).toBe(true);
    },
  );

  it('releases the lease, the microphone and both audio contexts on disconnect', async () => {
    await render();
    const ws = await connected();
    await act(async () => {
      host!.disconnect();
    });

    expect(ws.closedWith).toBe(1000);
    expect(track.stop).toHaveBeenCalled();
    expect(MockAudioContext.instances.every((c) => c.state === 'closed')).toBe(
      true,
    );
    expect(host!.phase).toBe('idle');
    // Our own close must not surface as a lost connection.
    expect(host!.closeReason).toBeUndefined();
  });

  it('releases everything when the page goes away', async () => {
    await render();
    const ws = await connected();
    await act(async () => {
      window.dispatchEvent(new Event('pagehide'));
    });
    expect(ws.closedWith).toBe(1000);
    expect(track.stop).toHaveBeenCalled();
  });

  it('ignores a connection that was abandoned before the microphone arrived', async () => {
    let grant: (stream: unknown) => void = () => {};
    getUserMedia.mockReturnValue(
      new Promise((resolve) => {
        grant = resolve;
      }),
    );
    await render();
    await act(async () => {
      host!.connect();
    });
    await act(async () => {
      host!.disconnect();
    });
    await act(async () => {
      grant({ getTracks: () => [track], getAudioTracks: () => [track] });
    });

    expect(MockWebSocket.instances).toHaveLength(0);
    expect(track.stop).toHaveBeenCalled();
    expect(host!.phase).toBe('idle');
  });

  describe('capture path', () => {
    it('captures on the audio thread when the worklet module loads', async () => {
      const addModule = vi.fn(async () => {});
      MockAudioContext.addModule = addModule;
      await render();
      const ws = await connected();

      expect(host!.captureMode).toBe('worklet');
      expect(addModule).toHaveBeenCalledOnce();
      // A same-origin asset URL: the CSP refuses blob: and data: modules.
      expect(addModule.mock.calls[0]![0]).toMatch(/capture-worklet/);
      const [node] = MockWorkletNode.instances;
      expect(node!.name).toBe('qwen-live-capture');
      expect(node!.options).toMatchObject({
        processorOptions: { frameSize: 1024 },
      });
      // No main-thread capture node alongside it.
      expect(
        MockAudioContext.instances[0]!.createScriptProcessor,
      ).not.toHaveBeenCalled();

      await act(async () => {
        ws.receive({
          type: 'host.state',
          epoch: 7,
          status: status('listening'),
        });
      });
      node!.post([100, -200], 0.25);
      const [frame] = ws.audio();
      const view = new DataView(frame!);
      expect(Number(view.getBigUint64(0))).toBe(7);
      expect(view.getInt16(8, true)).toBe(100);
      expect(view.getInt16(10, true)).toBe(-200);
      expect(host!.inputLevel.current.level).toBe(0.25);
    });

    it('applies the same gates to worklet frames: not before the call, not while muted', async () => {
      MockAudioContext.addModule = async () => {};
      await render();
      const ws = await connected();
      const [node] = MockWorkletNode.instances;

      node!.post([1, 2], 0.5);
      expect(ws.audio()).toHaveLength(0);
      expect(host!.inputLevel.current.level).toBe(0.5);

      await act(async () => {
        ws.receive({
          type: 'host.state',
          epoch: 1,
          status: status('listening', { inputMuted: true }),
        });
      });
      node!.post([1, 2], 0.5);
      expect(ws.audio()).toHaveLength(0);
      expect(host!.inputLevel.current.level).toBe(0);
    });

    it.each([
      ['the browser has no AudioWorklet', undefined, false],
      [
        'the module cannot be loaded (a data: URL under the CSP)',
        async () => {
          throw new Error('Refused to load the script');
        },
        false,
      ],
      ['the processor cannot be constructed', async () => {}, true],
    ] as const)(
      'falls back to the main-thread node when %s',
      async (_label, addModule, failConstruction) => {
        MockAudioContext.addModule = addModule;
        MockWorkletNode.failConstruction = failConstruction;
        await render();
        const ws = await connected();

        expect(host!.captureMode).toBe('script-processor');
        expect(host!.phase).toBe('connected');
        await act(async () => {
          ws.receive({
            type: 'host.state',
            epoch: 1,
            status: status('listening'),
          });
        });
        speak([1, -1]);
        expect(ws.audio()).toHaveLength(1);
      },
    );

    it('shuts the worklet down with the connection', async () => {
      MockAudioContext.addModule = async () => {};
      await render();
      await connected();
      const [node] = MockWorkletNode.instances;
      await act(async () => {
        host!.disconnect();
      });

      expect(node!.port.onmessage).toBeNull();
      expect(node!.port.close).toHaveBeenCalledOnce();
      expect(node!.disconnect).toHaveBeenCalled();
      expect(host!.captureMode).toBeUndefined();
    });

    it('builds nothing for a connect abandoned while the module was loading', async () => {
      let loaded: () => void = () => {};
      MockAudioContext.addModule = () =>
        new Promise<void>((resolve) => {
          loaded = resolve;
        });
      await render();
      await act(async () => {
        host!.connect();
      });
      await act(async () => {
        host!.disconnect();
      });
      await act(async () => {
        loaded();
      });

      // A node parked in the shared resources now would belong to the next
      // connect, and nothing would ever release it.
      expect(MockWorkletNode.instances).toHaveLength(0);
      expect(MockWebSocket.instances).toHaveLength(0);
      expect(host!.phase).toBe('idle');
      expect(host!.captureMode).toBeUndefined();
    });
  });
});
