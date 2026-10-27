/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Pins the persisted-backoff gates in `service-worker.ts` (#13966): a cold
 * `start()` and the keepalive alarm must both consult `isBackingOff` before
 * opening the `/acp` socket. Dropping either gate keeps the rest of the suite
 * green while the reconnect spam returns in full.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DaemonConfig } from '../daemon/config.js';

const BASE_URL = 'http://127.0.0.1:4170';
const WS_URL = 'ws://127.0.0.1:4170/acp';
const CONFIG: DaemonConfig = { baseUrl: BASE_URL };
const KEEPALIVE_ALARM = 'cdp-tunnel-keepalive';

// Shared mock fns live outside the factories so `vi.resetModules()` (used to
// re-run the module top level per test) keeps these references stable.
const mocks = vi.hoisted(() => ({
  getDaemonConfig: vi.fn(),
  checkDaemonHealth: vi.fn(),
  isBackingOff: vi.fn(),
  recordFailure: vi.fn(),
  clearReconnectState: vi.fn(),
}));

vi.mock('../daemon/config.js', () => ({
  getDaemonConfig: mocks.getDaemonConfig,
}));
vi.mock('../daemon/discovery.js', () => ({
  checkDaemonHealth: mocks.checkDaemonHealth,
}));
vi.mock('../daemon/reconnect-backoff.js', () => ({
  isBackingOff: mocks.isBackingOff,
  recordFailure: mocks.recordFailure,
  clearReconnectState: mocks.clearReconnectState,
}));
// The browser-use bridge registers listeners and starts a native-messaging
// restore at import time; it has its own test files.
vi.mock('./browser-use-bridge.js', () => ({}));

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = MockWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  send = vi.fn();
  close = vi.fn(() => {
    this.readyState = MockWebSocket.CLOSED;
  });

  constructor(
    readonly url: string,
    readonly protocols?: string | string[],
  ) {
    sockets.push(this);
  }
}

let sockets: MockWebSocket[];

interface ServiceWorkerChrome {
  createAlarm: ReturnType<typeof vi.fn>;
  fireAlarm(name: string): void;
}

function installChromeHarness(): ServiceWorkerChrome {
  const alarmListeners: Array<(alarm: { name: string }) => void> = [];
  const createAlarm = vi.fn();
  globalThis.chrome = {
    alarms: {
      create: createAlarm,
      onAlarm: {
        addListener: vi.fn((listener: (alarm: { name: string }) => void) =>
          alarmListeners.push(listener),
        ),
      },
    },
    sidePanel: {
      setPanelBehavior: vi.fn().mockResolvedValue(undefined),
    },
  } as unknown as typeof chrome;
  return {
    createAlarm,
    fireAlarm(name: string) {
      for (const listener of alarmListeners) listener({ name });
    },
  };
}

/** Re-import the module so its top level (`void start()`) runs per test. */
async function loadServiceWorker(): Promise<void> {
  vi.resetModules();
  await import('./service-worker.js');
}

/** Drop the active socket the way the module's own `onclose` would see it. */
function dropSocket(socket: MockWebSocket): void {
  socket.onclose?.({ code: 1011, reason: 'daemon restart' });
}

describe('service worker reconnect-backoff gates (#13966)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    sockets = [];
    vi.stubGlobal('WebSocket', MockWebSocket);
    mocks.getDaemonConfig.mockResolvedValue(CONFIG);
    mocks.checkDaemonHealth.mockResolvedValue({
      reachable: true,
      status: 'ok',
    });
    mocks.isBackingOff.mockResolvedValue(false);
    mocks.recordFailure.mockResolvedValue(1_000);
    mocks.clearReconnectState.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('cold start with a pending nextRetryAt stays idle and opens no socket', async () => {
    mocks.isBackingOff.mockResolvedValue(true);
    installChromeHarness();

    await loadServiceWorker();

    await vi.waitFor(() =>
      expect(mocks.isBackingOff).toHaveBeenCalledWith(BASE_URL),
    );
    // The gate returns before the health probe, and nothing ever connects.
    expect(mocks.checkDaemonHealth).not.toHaveBeenCalled();
    expect(sockets).toHaveLength(0);
  });

  it('keepalive alarm on a fresh worker consults the persisted backoff', async () => {
    mocks.isBackingOff.mockResolvedValue(true);
    const harness = installChromeHarness();
    await loadServiceWorker();
    await vi.waitFor(() => expect(mocks.isBackingOff).toHaveBeenCalledTimes(1));
    expect(harness.createAlarm).toHaveBeenCalledWith(KEEPALIVE_ALARM, {
      periodInMinutes: 0.5,
    });

    // Unrelated alarms are filtered by name before any backoff consult.
    harness.fireAlarm('some-other-alarm');
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.isBackingOff).toHaveBeenCalledTimes(1);

    harness.fireAlarm(KEEPALIVE_ALARM);
    await vi.waitFor(() => expect(mocks.isBackingOff).toHaveBeenCalledTimes(2));
    expect(sockets).toHaveLength(0);
  });

  it('keepalive alarm on a live worker does not reconnect during a pending backoff', async () => {
    const harness = installChromeHarness();
    await loadServiceWorker();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));

    // The tunnel drops and the ladder says the next retry is still pending.
    dropSocket(sockets[0]);
    await vi.waitFor(() =>
      expect(mocks.recordFailure).toHaveBeenCalledWith(BASE_URL),
    );
    mocks.isBackingOff.mockResolvedValue(true);

    harness.fireAlarm(KEEPALIVE_ALARM);
    // Give the alarm handler room to (wrongly) reach `connect()`.
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets).toHaveLength(1);
  });

  it('cold start with no pending backoff probes health and opens the socket', async () => {
    installChromeHarness();

    await loadServiceWorker();

    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    expect(mocks.checkDaemonHealth).toHaveBeenCalledWith(CONFIG);
    expect(sockets[0]?.url).toBe(WS_URL);
    // No token configured, so the handshake carries no subprotocol list.
    expect(sockets[0]?.protocols).toBeUndefined();
  });

  it('keepalive alarm reconnects a dropped socket once the backoff expires', async () => {
    const harness = installChromeHarness();
    await loadServiceWorker();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));

    dropSocket(sockets[0]);
    await vi.waitFor(() =>
      expect(mocks.recordFailure).toHaveBeenCalledWith(BASE_URL),
    );

    harness.fireAlarm(KEEPALIVE_ALARM);
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    expect(sockets[1]?.url).toBe(WS_URL);
  });

  it('preserves the ladder when the daemon closes before the ACP init ack', async () => {
    installChromeHarness();
    await loadServiceWorker();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    const ws = sockets[0];
    ws.readyState = MockWebSocket.OPEN;

    ws.onopen?.();
    expect(mocks.clearReconnectState).not.toHaveBeenCalled();

    ws.onclose?.({ code: 1013, reason: 'Too many connections' });
    await vi.waitFor(() =>
      expect(mocks.recordFailure).toHaveBeenCalledWith(BASE_URL),
    );
    expect(mocks.clearReconnectState).not.toHaveBeenCalled();
  });

  it('clears the ladder only after a successful ACP init ack', async () => {
    installChromeHarness();
    await loadServiceWorker();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    const ws = sockets[0];
    ws.readyState = MockWebSocket.OPEN;
    ws.onopen?.();
    expect(mocks.clearReconnectState).not.toHaveBeenCalled();

    ws.onmessage?.({
      data: JSON.stringify({
        jsonrpc: '2.0',
        id: 'browser-tools-acp-init',
        result: {},
      }),
    });

    await vi.waitFor(() =>
      expect(mocks.clearReconnectState).toHaveBeenCalledTimes(1),
    );
  });
});
