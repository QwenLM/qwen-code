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

class MockAudioContext {
  static instances: MockAudioContext[] = [];
  static processor: Processor | undefined;
  static sources: Array<{
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
  }> = [];

  state = 'running';
  currentTime = 0;
  readonly sampleRate: number;
  readonly destination = {};
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
  MockWebSocket.instances = [];
  MockAudioContext.instances = [];
  MockAudioContext.processor = undefined;
  MockAudioContext.sources = [];
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
      selfChecks: { audioInput: true, audioOutput: true },
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
});
