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
import { useVoiceCapture, type UseVoiceCaptureReturn } from './useVoiceCapture';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

class MockWebSocket {
  static readonly OPEN = 1;
  static latest: MockWebSocket | undefined;

  readonly OPEN = 1;
  readyState = MockWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  readonly sent: unknown[] = [];

  constructor(
    readonly url: string,
    readonly protocols?: string | string[],
  ) {
    MockWebSocket.latest = this;
  }

  send(data: unknown): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
  }
}

function node() {
  return { connect: vi.fn(), disconnect: vi.fn() };
}

class MockAudioContext {
  static latest: MockAudioContext | undefined;
  static latestProcessor:
    | (ReturnType<typeof node> & {
        onaudioprocess: ((event: AudioProcessingEvent) => void) | null;
      })
    | undefined;

  state = 'running';
  sampleRate = 16_000;
  readonly destination = {};
  createMediaStreamSource = vi.fn(() => node());
  createScriptProcessor = vi.fn(() => {
    const processor = { ...node(), onaudioprocess: null };
    MockAudioContext.latestProcessor = processor;
    return processor;
  });
  createGain = vi.fn(() => ({ ...node(), gain: { value: 1 } }));
  resume = vi.fn(async () => {});
  close = vi.fn(async () => {
    this.state = 'closed';
  });

  constructor() {
    MockAudioContext.latest = this;
  }
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let capture: UseVoiceCaptureReturn | undefined;
const onFinal = vi.fn();
const onError = vi.fn();
const onUnexpectedClose = vi.fn();
const track = { stop: vi.fn() };
let baseUrl = 'http://127.0.0.1:1234';
let token: string | undefined;
let ownerKey = 'workspace-a:session-a';
let streamPath = 'voice/stream';

/** Decode a `qwen-bearer.<base64url>` subprotocol back to the raw token. */
function decodeBearerSubprotocol(proto: string): string {
  const b64 = proto
    .slice('qwen-bearer.'.length)
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const binary = atob(b64);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function TestHost() {
  capture = useVoiceCapture({
    baseUrl,
    token,
    target: { ownerKey, streamPath },
    onFinal,
    onError,
    onUnexpectedClose,
  });
  return null;
}

async function renderHookHost() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(React.createElement(TestHost));
  });
  if (!capture) throw new Error('hook did not render');
  return capture;
}

beforeEach(() => {
  capture = undefined;
  onFinal.mockReset();
  onError.mockReset();
  onUnexpectedClose.mockReset();
  track.stop.mockReset();
  baseUrl = 'http://127.0.0.1:1234';
  token = undefined;
  ownerKey = 'workspace-a:session-a';
  streamPath = 'voice/stream';
  MockWebSocket.latest = undefined;
  MockAudioContext.latest = undefined;
  MockAudioContext.latestProcessor = undefined;
  Object.defineProperty(globalThis, 'WebSocket', {
    value: MockWebSocket,
    configurable: true,
  });
  Object.defineProperty(window, 'AudioContext', {
    value: MockAudioContext,
    configurable: true,
  });
  Object.defineProperty(navigator, 'mediaDevices', {
    value: {
      getUserMedia: vi.fn(async () => ({
        getTracks: () => [track],
      })),
    },
    configurable: true,
  });
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root?.unmount();
    });
    root = null;
  }
  container?.remove();
  container = null;
  vi.useRealTimers();
});

describe('useVoiceCapture', () => {
  it('preserves reverse-proxy base paths in the websocket URL', async () => {
    baseUrl = 'https://example.test/qwen/';
    const result = await renderHookHost();

    await act(async () => {
      result.start();
    });

    expect(MockWebSocket.latest?.url).toBe(
      'wss://example.test/qwen/voice/stream',
    );
  });

  it('uses a workspace-qualified stream path without double encoding', async () => {
    baseUrl = 'https://example.test/qwen/';
    streamPath = 'workspaces/%2Frepo%2F%E4%BA%8C%20%E6%AC%A1/voice/stream';
    const result = await renderHookHost();

    await act(async () => {
      result.start();
    });

    expect(MockWebSocket.latest?.url).toBe(
      'wss://example.test/qwen/workspaces/%2Frepo%2F%E4%BA%8C%20%E6%AC%A1/voice/stream',
    );
  });

  it('carries the bearer token as a Sec-WebSocket-Protocol subprotocol', async () => {
    token = 'secret-token-123';
    const result = await renderHookHost();

    await act(async () => {
      result.start();
    });

    const protocols = MockWebSocket.latest?.protocols;
    expect(Array.isArray(protocols)).toBe(true);
    const list = protocols as string[];
    // Non-secret marker first (what the daemon selects), then the bearer token.
    expect(list).toHaveLength(2);
    expect(list[0]).toBe('qwen-ws');
    expect(list[1].startsWith('qwen-bearer.')).toBe(true);
    // Round-trips back to the raw token (what the daemon decodes + hashes).
    expect(decodeBearerSubprotocol(list[1])).toBe('secret-token-123');
  });

  it('offers no subprotocol when no token is configured', async () => {
    const result = await renderHookHost();

    await act(async () => {
      result.start();
    });

    expect(MockWebSocket.latest?.protocols).toBeUndefined();
  });

  it('resumes audio during the start gesture before mic permission resolves', async () => {
    let resolveStream: (stream: {
      getTracks: () => (typeof track)[];
    }) => void = () => undefined;
    const getUserMedia = vi.fn(
      () =>
        new Promise<{ getTracks: () => (typeof track)[] }>((resolve) => {
          resolveStream = resolve;
        }),
    );
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia },
      configurable: true,
    });
    const resume = vi.fn(async () => {});
    class SuspendedAudioContext extends MockAudioContext {
      override state = 'suspended';
      override resume = resume;
    }
    Object.defineProperty(window, 'AudioContext', {
      value: SuspendedAudioContext,
      configurable: true,
    });
    const result = await renderHookHost();

    act(() => {
      result.start();
    });

    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(resume).toHaveBeenCalledOnce();
    expect(capture?.status).toBe('connecting');

    await act(async () => {
      resolveStream({ getTracks: () => [track] });
      await Promise.resolve();
    });
    const ws = MockWebSocket.latest;
    if (!ws) throw new Error('WebSocket was not created');

    await act(async () => {
      ws.onopen?.();
    });
    expect(capture?.status).toBe('recording');
  });

  it('times out and cleans up when mobile audio resume stalls', async () => {
    vi.useFakeTimers();
    const close = vi.fn(async () => {});
    class StalledAudioContext extends MockAudioContext {
      override state = 'suspended';
      override resume = vi.fn(() => new Promise<void>(() => undefined));
      override close = close;
    }
    Object.defineProperty(window, 'AudioContext', {
      value: StalledAudioContext,
      configurable: true,
    });
    const result = await renderHookHost();

    await act(async () => {
      result.start();
      await Promise.resolve();
    });
    expect(capture?.status).toBe('connecting');
    expect(MockWebSocket.latest).toBeUndefined();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    expect(onError).toHaveBeenCalledWith(
      'Voice capture timed out while starting.',
    );
    expect(capture?.status).toBe('error');
    expect(track.stop).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it('uses server error frame messages', async () => {
    const result = await renderHookHost();

    await act(async () => {
      result.start();
    });
    const ws = MockWebSocket.latest;
    if (!ws) throw new Error('WebSocket was not created');

    await act(async () => {
      ws.onopen?.();
      ws.onmessage?.({
        data: JSON.stringify({
          type: 'error',
          message: 'No voice model is configured.',
        }),
      } as MessageEvent);
    });

    expect(onError).toHaveBeenCalledWith('No voice model is configured.');
    expect(capture?.status).toBe('error');
  });

  it('delivers final transcripts and returns to idle', async () => {
    const result = await renderHookHost();

    await act(async () => {
      result.start();
    });
    const ws = MockWebSocket.latest;
    if (!ws) throw new Error('WebSocket was not created');

    await act(async () => {
      ws.onopen?.();
      ws.onmessage?.({
        data: JSON.stringify({
          type: 'final',
          text: 'hello from voice',
        }),
      } as MessageEvent);
    });

    expect(onFinal).toHaveBeenCalledWith('hello from voice');
    expect(onError).not.toHaveBeenCalled();
    expect(capture?.status).toBe('idle');
  });

  it('fails instead of staying transcribing when the socket closes early', async () => {
    const result = await renderHookHost();

    await act(async () => {
      result.start();
    });
    const ws = MockWebSocket.latest;
    if (!ws) throw new Error('WebSocket was not created');

    await act(async () => {
      ws.onopen?.();
    });
    await act(async () => {
      result.stop();
    });
    expect(capture?.status).toBe('transcribing');

    await act(async () => {
      ws.onclose?.({ code: 1006, reason: '' } as CloseEvent);
    });

    expect(onError).toHaveBeenCalledWith(
      'Voice connection closed (code=1006, reason=none).',
    );
    expect(capture?.status).toBe('error');
  });

  it('cleans up when the unexpected-close callback throws', async () => {
    onUnexpectedClose.mockImplementation(() => {
      throw new Error('close callback failed');
    });
    const result = await renderHookHost();

    await act(async () => {
      result.start();
    });
    const ws = MockWebSocket.latest;
    const context = MockAudioContext.latest;
    if (!ws || !context) throw new Error('capture resources were not created');

    await act(async () => {
      ws.onopen?.();
    });
    await act(async () => {
      ws.onclose?.({ code: 1006, reason: '' } as CloseEvent);
    });

    expect(onUnexpectedClose).toHaveBeenCalledWith({
      code: 1006,
      reason: 'none',
    });
    expect(capture?.status).toBe('error');
    expect(track.stop).toHaveBeenCalledOnce();
    expect(context.close).toHaveBeenCalledOnce();
    expect(ws.readyState).toBe(3);
  });

  it('flushes buffered audio before a pending stop when the socket opens', async () => {
    const result = await renderHookHost();

    await act(async () => {
      result.start();
    });
    const ws = MockWebSocket.latest;
    if (!ws) throw new Error('WebSocket was not created');
    ws.readyState = 0;
    const processor = MockAudioContext.latestProcessor;
    if (!processor?.onaudioprocess) {
      throw new Error('Audio processor was not ready');
    }

    expect(processor.connect).toHaveBeenCalledOnce();
    await act(async () => {
      processor.onaudioprocess?.({
        inputBuffer: {
          getChannelData: () => new Float32Array([0.5, -0.5]),
        },
      } as AudioProcessingEvent);
      result.stop();
    });
    expect(capture?.status).toBe('connecting');
    expect(processor.onaudioprocess).toBeNull();

    ws.readyState = MockWebSocket.OPEN;
    await act(async () => {
      ws.onopen?.();
    });

    expect(ws.sent[0]).toBe(JSON.stringify({ type: 'start' }));
    expect(Array.from(new Int16Array(ws.sent[1] as ArrayBuffer))).toEqual([
      16383, -16384,
    ]);
    expect(ws.sent[2]).toBe(JSON.stringify({ type: 'stop' }));
    expect(capture?.status).toBe('transcribing');
  });

  it('fails and stops buffering when pre-open audio exceeds the limit', async () => {
    const result = await renderHookHost();

    await act(async () => {
      result.start();
    });
    const ws = MockWebSocket.latest;
    const processor = MockAudioContext.latestProcessor;
    if (!ws || !processor?.onaudioprocess) {
      throw new Error('Voice capture was not ready');
    }
    ws.readyState = 0;

    const event = {
      inputBuffer: {
        getChannelData: () => new Float32Array(4096),
      },
    } as AudioProcessingEvent;
    await act(async () => {
      for (let frame = 0; frame < 235; frame += 1) {
        processor.onaudioprocess?.(event);
      }
    });

    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(
      'Voice capture buffer limit reached while starting.',
    );
    expect(capture?.status).toBe('error');
    expect(processor.onaudioprocess).toBeNull();
    expect(ws.sent).toEqual([]);
    expect(track.stop).toHaveBeenCalledOnce();
  });

  it('does not start capturing after release while microphone access is pending', async () => {
    let resolveStream: (stream: {
      getTracks: () => (typeof track)[];
    }) => void = () => undefined;
    Object.defineProperty(navigator, 'mediaDevices', {
      value: {
        getUserMedia: vi.fn(
          () =>
            new Promise<{ getTracks: () => (typeof track)[] }>((resolve) => {
              resolveStream = resolve;
            }),
        ),
      },
      configurable: true,
    });
    const result = await renderHookHost();

    await act(async () => {
      result.start();
      result.stop();
    });
    await act(async () => {
      resolveStream({ getTracks: () => [track] });
      await Promise.resolve();
    });
    const ws = MockWebSocket.latest;
    const processor = MockAudioContext.latestProcessor;
    if (!ws || !processor) throw new Error('Voice capture was not ready');

    expect(processor.connect).not.toHaveBeenCalled();
    await act(async () => {
      ws.onopen?.();
    });

    expect(ws.sent).toEqual([
      JSON.stringify({ type: 'start' }),
      JSON.stringify({ type: 'stop' }),
    ]);
    expect(capture?.status).toBe('transcribing');
  });

  it('clears a pending stop when capture is aborted', async () => {
    const result = await renderHookHost();

    await act(async () => {
      result.start();
    });
    const ws = MockWebSocket.latest;
    if (!ws) throw new Error('WebSocket was not created');
    ws.readyState = 0;

    await act(async () => {
      result.stop();
      result.abort();
    });
    ws.readyState = MockWebSocket.OPEN;
    await act(async () => {
      ws.onopen?.();
    });

    expect(ws.sent).toEqual([]);
    expect(capture?.status).toBe('idle');
  });

  it('clears the start timeout when stop is deferred until connect', async () => {
    vi.useFakeTimers();
    const result = await renderHookHost();

    await act(async () => {
      result.start();
    });
    const ws = MockWebSocket.latest;
    if (!ws) throw new Error('WebSocket was not created');
    ws.readyState = 0;

    await act(async () => {
      result.stop();
    });
    expect(capture?.status).toBe('connecting');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    expect(onError).not.toHaveBeenCalled();
    expect(capture?.status).toBe('connecting');

    ws.readyState = MockWebSocket.OPEN;
    await act(async () => {
      ws.onopen?.();
    });

    expect(ws.sent[0]).toBe(JSON.stringify({ type: 'start' }));
    expect(ws.sent[1]).toBe(JSON.stringify({ type: 'stop' }));
    expect(capture?.status).toBe('transcribing');
  });

  it('does not leak a transcription timer when stop is called twice', async () => {
    vi.useFakeTimers();
    const result = await renderHookHost();

    await act(async () => {
      result.start();
    });
    const ws = MockWebSocket.latest;
    if (!ws) throw new Error('WebSocket was not created');

    await act(async () => {
      ws.onopen?.();
      result.stop();
    });
    expect(vi.getTimerCount()).toBe(1);

    await act(async () => {
      result.stop();
    });
    expect(vi.getTimerCount()).toBe(1);
  });

  it('fails when the server sends no response after recording starts', async () => {
    vi.useFakeTimers();
    const result = await renderHookHost();

    await act(async () => {
      result.start();
    });
    const ws = MockWebSocket.latest;
    if (!ws) throw new Error('WebSocket was not created');

    await act(async () => {
      ws.onopen?.();
    });
    expect(capture?.status).toBe('recording');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    expect(onError).toHaveBeenCalledWith(
      'No response from server. Check that the voice model is running.',
    );
    expect(capture?.status).toBe('error');
  });

  it('ignores stale socket callbacks after a new capture starts', async () => {
    const result = await renderHookHost();

    await act(async () => {
      result.start();
    });
    const firstWs = MockWebSocket.latest;
    if (!firstWs?.onmessage) throw new Error('first WebSocket was not ready');
    const staleMessage = firstWs.onmessage;

    await act(async () => {
      staleMessage({
        data: JSON.stringify({ type: 'error', message: 'first failed' }),
      } as MessageEvent);
    });
    expect(capture?.status).toBe('error');

    await act(async () => {
      capture?.start();
    });
    const secondWs = MockWebSocket.latest;
    if (!secondWs || secondWs === firstWs) {
      throw new Error('second WebSocket was not created');
    }

    await act(async () => {
      staleMessage({
        data: JSON.stringify({ type: 'final', text: 'stale transcript' }),
      } as MessageEvent);
    });

    expect(capture?.status).toBe('connecting');
    expect(secondWs.readyState).toBe(MockWebSocket.OPEN);
    expect(onFinal).not.toHaveBeenCalled();
  });

  it('aborts and drops an old final when the owner changes', async () => {
    const result = await renderHookHost();
    await act(async () => {
      result.start();
    });
    const firstWs = MockWebSocket.latest;
    const staleMessage = firstWs?.onmessage;
    if (!firstWs || !staleMessage) throw new Error('socket was not ready');

    ownerKey = 'workspace-b:session-b';
    await act(async () => {
      root?.render(React.createElement(TestHost));
    });

    expect(firstWs.sent).toContain(JSON.stringify({ type: 'abort' }));
    expect(track.stop).toHaveBeenCalled();
    expect(capture?.status).toBe('idle');

    await act(async () => {
      staleMessage({
        data: JSON.stringify({ type: 'final', text: 'wrong owner' }),
      } as MessageEvent);
    });
    expect(onFinal).not.toHaveBeenCalled();
  });

  it('clears an old owner error before the new owner can retry', async () => {
    const result = await renderHookHost();
    await act(async () => {
      result.start();
    });
    const firstWs = MockWebSocket.latest;
    if (!firstWs) throw new Error('socket was not ready');
    await act(async () => {
      firstWs.onmessage?.({
        data: JSON.stringify({ type: 'error', message: 'owner A failed' }),
      } as MessageEvent);
    });
    expect(capture?.status).toBe('error');

    ownerKey = 'workspace-b:session-b';
    await act(async () => {
      root?.render(React.createElement(TestHost));
    });

    expect(capture?.status).toBe('idle');
    expect(capture?.errorMessage).toBeUndefined();
  });

  it('stops a pending microphone stream after the owner changes', async () => {
    let resolveStream:
      | ((stream: { getTracks: () => Array<typeof track> }) => void)
      | undefined;
    Object.defineProperty(navigator, 'mediaDevices', {
      value: {
        getUserMedia: vi.fn(
          () =>
            new Promise<{ getTracks: () => Array<typeof track> }>((resolve) => {
              resolveStream = resolve;
            }),
        ),
      },
      configurable: true,
    });
    const result = await renderHookHost();
    await act(async () => {
      result.start();
    });

    ownerKey = 'workspace-b:session-b';
    await act(async () => {
      root?.render(React.createElement(TestHost));
    });
    await act(async () => {
      resolveStream?.({ getTracks: () => [track] });
    });

    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(MockWebSocket.latest).toBeUndefined();
    expect(onFinal).not.toHaveBeenCalled();
  });

  it('releases an active capture when the hook unmounts', async () => {
    vi.useFakeTimers();
    const result = await renderHookHost();
    await act(async () => {
      result.start();
    });
    const ws = MockWebSocket.latest;
    const context = MockAudioContext.latest;
    if (!ws || !context) throw new Error('capture resources were not created');
    const staleMessage = ws.onmessage;
    const source = context.createMediaStreamSource.mock.results[0]?.value;
    const processor = context.createScriptProcessor.mock.results[0]?.value;
    const sink = context.createGain.mock.results[0]?.value;

    await act(async () => {
      ws.onopen?.();
    });
    expect(capture?.status).toBe('recording');
    expect(vi.getTimerCount()).toBe(1);

    await act(async () => {
      root?.unmount();
    });
    root = null;

    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(source?.disconnect).toHaveBeenCalledOnce();
    expect(processor?.disconnect).toHaveBeenCalledOnce();
    expect(sink?.disconnect).toHaveBeenCalledOnce();
    expect(context.close).toHaveBeenCalledOnce();
    expect(ws.readyState).toBe(3);
    expect(ws.onmessage).toBeNull();
    expect(ws.onerror).toBeNull();
    expect(ws.onclose).toBeNull();
    expect(vi.getTimerCount()).toBe(0);

    staleMessage?.({
      data: JSON.stringify({ type: 'final', text: 'after unmount' }),
    } as MessageEvent);
    expect(onFinal).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it('stops a microphone stream that resolves after unmount', async () => {
    let resolveStream:
      | ((stream: { getTracks: () => Array<typeof track> }) => void)
      | undefined;
    Object.defineProperty(navigator, 'mediaDevices', {
      value: {
        getUserMedia: vi.fn(
          () =>
            new Promise<{ getTracks: () => Array<typeof track> }>((resolve) => {
              resolveStream = resolve;
            }),
        ),
      },
      configurable: true,
    });
    const result = await renderHookHost();
    await act(async () => {
      result.start();
    });
    const context = MockAudioContext.latest;
    if (!context) throw new Error('audio context was not created');
    await act(async () => {
      root?.unmount();
    });
    root = null;

    await act(async () => {
      resolveStream?.({ getTracks: () => [track] });
    });

    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(MockWebSocket.latest).toBeUndefined();
    expect(context.close).toHaveBeenCalledOnce();
    expect(onFinal).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });
});
