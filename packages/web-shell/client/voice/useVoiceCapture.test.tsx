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

  constructor(readonly url: string) {
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
  state = 'running';
  sampleRate = 16_000;
  readonly destination = {};
  createMediaStreamSource = vi.fn(() => node());
  createScriptProcessor = vi.fn(() => ({ ...node(), onaudioprocess: null }));
  createGain = vi.fn(() => ({ ...node(), gain: { value: 1 } }));
  resume = vi.fn(async () => {});
  close = vi.fn(async () => {
    this.state = 'closed';
  });
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let capture: UseVoiceCaptureReturn | undefined;
const onFinal = vi.fn();
const onError = vi.fn();
const track = { stop: vi.fn() };

function TestHost() {
  capture = useVoiceCapture({
    baseUrl: 'http://127.0.0.1:1234',
    onFinal,
    onError,
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
  track.stop.mockReset();
  MockWebSocket.latest = undefined;
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
});

describe('useVoiceCapture', () => {
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
});
