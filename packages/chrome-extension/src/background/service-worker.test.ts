/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getDaemonConfig: vi.fn(),
  checkExtensionPairing: vi.fn(),
  getDaemonFeatures: vi.fn(),
  registerBrowserMcp: vi.fn(),
  routeBrowserMcpFrame: vi.fn(async () => false),
  shutdownBrowserTools: vi.fn(async () => {}),
  shutdownCdpBridge: vi.fn(),
}));

vi.mock('../daemon/config.js', () => ({
  getDaemonConfig: mocks.getDaemonConfig,
}));
vi.mock('../daemon/discovery.js', () => ({
  checkExtensionPairing: mocks.checkExtensionPairing,
  getDaemonFeatures: mocks.getDaemonFeatures,
}));
vi.mock('./browser-mcp/connection.js', () => ({
  BROWSER_MCP_SERVER_NAME: 'qwen-browser',
  registerBrowserMcp: mocks.registerBrowserMcp,
  routeBrowserMcpFrame: mocks.routeBrowserMcpFrame,
}));
vi.mock('./browser-mcp/debugger-session.js', () => ({
  ChromeDebuggerSession: class {},
}));
vi.mock('./browser-mcp/browser-tools.js', () => ({
  BrowserTools: class {
    shutdown = mocks.shutdownBrowserTools;
  },
}));
vi.mock('./browser-mcp/server.js', () => ({
  BrowserMcpServer: class {},
}));
vi.mock('./cdp-bridge', () => ({
  isCdpBridgeFrame: () => false,
  handleCdpFrame: vi.fn(),
  shutdownCdpBridge: mocks.shutdownCdpBridge,
}));

type ScheduledTask = { callback: () => void; delay: number };

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly instances: FakeWebSocket[] = [];

  readonly send = vi.fn();
  readonly close = vi.fn();
  readyState = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;

  constructor(
    readonly url: string,
    readonly protocols?: string | string[],
  ) {
    FakeWebSocket.instances.push(this);
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  message(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  disconnect(code = 1006, reason = 'daemon stopped'): void {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

async function flushPromises(): Promise<void> {
  for (let index = 0; index < 8; index++) await Promise.resolve();
}

describe('browser-tools service worker', () => {
  const scheduled: ScheduledTask[] = [];

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    FakeWebSocket.instances.length = 0;
    scheduled.length = 0;
    mocks.getDaemonConfig.mockResolvedValue({
      baseUrl: 'http://127.0.0.1:4170',
      token: 'daemon-token',
      extensionPairingCredential: 'credential.secret',
    });
    mocks.checkExtensionPairing.mockResolvedValue({ paired: true });
    mocks.getDaemonFeatures.mockResolvedValue(new Set());
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.stubGlobal('chrome', {
      alarms: {
        create: vi.fn(),
        onAlarm: { addListener: vi.fn() },
      },
      runtime: {
        onMessage: { addListener: vi.fn() },
      },
      sidePanel: {
        setPanelBehavior: vi.fn(async () => {}),
      },
    });
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      callback: () => void,
      delay = 0,
    ) => {
      scheduled.push({ callback, delay });
      return 1;
    }) as typeof setTimeout);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('does not connect before extension pairing succeeds', async () => {
    mocks.checkExtensionPairing.mockResolvedValueOnce({
      paired: false,
      reason: 'missing_credential',
    });

    await import('./service-worker.js');
    await flushPromises();

    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(mocks.getDaemonFeatures).not.toHaveBeenCalled();
    expect(scheduled).toEqual([expect.objectContaining({ delay: 1_000 })]);
  });

  it('keeps native tools disabled when an external adapter is active', async () => {
    mocks.getDaemonFeatures.mockResolvedValueOnce(
      new Set(['browser_automation_mcp']),
    );

    await import('./service-worker.js');
    await flushPromises();
    const ws = FakeWebSocket.instances[0]!;
    ws.open();
    ws.message({ id: 'browser-tools-acp-init', result: {} });
    await flushPromises();

    expect(mocks.registerBrowserMcp).not.toHaveBeenCalled();
  });

  it('pairs before connecting, registers tools, and reconnects after cleanup', async () => {
    await import('./service-worker.js');
    await flushPromises();

    expect(mocks.checkExtensionPairing).toHaveBeenCalledOnce();
    expect(mocks.getDaemonFeatures).toHaveBeenCalledOnce();
    expect(
      mocks.checkExtensionPairing.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.getDaemonFeatures.mock.invocationCallOrder[0]!);
    expect(FakeWebSocket.instances).toHaveLength(1);

    const first = FakeWebSocket.instances[0]!;
    expect(first.url).toBe('ws://127.0.0.1:4170/acp');
    expect(first.protocols).toEqual([
      'qwen-ws',
      expect.stringMatching(/^qwen-bearer\./),
    ]);
    expect(JSON.stringify(first.protocols)).not.toContain('daemon-token');

    first.open();
    const initialize = JSON.parse(String(first.send.mock.calls[0]![0])) as {
      params: { clientInfo: Record<string, unknown> };
    };
    expect(initialize.params.clientInfo).toMatchObject({
      name: 'qwen-cdp-bridge',
      extensionPairingCredential: 'credential.secret',
    });

    first.message({ id: 'browser-tools-acp-init', result: {} });
    await flushPromises();
    expect(mocks.registerBrowserMcp).toHaveBeenCalledOnce();

    first.message({ type: 'mcp_error', code: 'register_failed' });
    await flushPromises();
    expect(first.close).toHaveBeenCalledWith(
      4001,
      'Browser MCP registration failed',
    );

    let finishCleanup: (() => void) | undefined;
    mocks.shutdownBrowserTools.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishCleanup = resolve;
        }),
    );
    first.disconnect();
    await flushPromises();
    expect(mocks.shutdownBrowserTools).toHaveBeenCalledOnce();
    expect(mocks.shutdownCdpBridge).not.toHaveBeenCalled();
    expect(scheduled).toEqual([expect.objectContaining({ delay: 1_000 })]);

    scheduled[0]!.callback();
    await flushPromises();
    expect(FakeWebSocket.instances).toHaveLength(1);

    finishCleanup?.();
    await flushPromises();
    expect(mocks.shutdownCdpBridge).toHaveBeenCalledOnce();
    expect(FakeWebSocket.instances).toHaveLength(2);
  });
});
