/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface ChromeHarness {
  attach: ReturnType<typeof vi.fn>;
  detach: ReturnType<typeof vi.fn>;
  sendCommand: ReturnType<typeof vi.fn>;
  debuggerEventListeners: Array<
    (source: chrome.debugger.Debuggee, method: string, params?: object) => void
  >;
  debuggerDetachListeners: Array<
    (source: chrome.debugger.Debuggee, reason: string) => void
  >;
}

function installChromeHarness(options?: {
  deferAttach?: boolean;
  deferDetach?: boolean;
  deferSendCommand?: boolean;
}): ChromeHarness & {
  finishAttach(): void;
  finishDetach(): void;
  finishSendCommand(): void;
} {
  let attachCallback: (() => void) | undefined;
  let detachCallback: (() => void) | undefined;
  let sendCommandCallback: ((result?: object) => void) | undefined;
  const debuggerEventListeners: ChromeHarness['debuggerEventListeners'] = [];
  const debuggerDetachListeners: ChromeHarness['debuggerDetachListeners'] = [];
  const attach = vi.fn(
    (
      _target: chrome.debugger.Debuggee,
      _version: string,
      callback: () => void,
    ) => {
      if (options?.deferAttach) attachCallback = callback;
      else callback();
    },
  );
  const detach = vi.fn(
    (_target: chrome.debugger.Debuggee, callback?: () => void) => {
      if (options?.deferDetach) detachCallback = callback;
      else callback?.();
    },
  );
  const sendCommand = vi.fn(
    (
      _target: chrome.debugger.Debuggee,
      _method: string,
      _params: object,
      callback: (result?: object) => void,
    ) => {
      if (options?.deferSendCommand) sendCommandCallback = callback;
      else callback({ value: 'ok' });
    },
  );

  globalThis.chrome = {
    debugger: {
      attach,
      detach,
      sendCommand,
      onEvent: {
        addListener: vi.fn((listener) => debuggerEventListeners.push(listener)),
        removeListener: vi.fn(),
      },
      onDetach: {
        addListener: vi.fn((listener) =>
          debuggerDetachListeners.push(listener),
        ),
        removeListener: vi.fn(),
      },
    },
    tabs: {
      query: vi.fn().mockResolvedValue([{ id: 7 }]),
      get: vi.fn().mockResolvedValue({
        id: 7,
        url: 'https://example.test',
        title: 'Page',
      }),
    },
    runtime: {
      getPlatformInfo: vi.fn((callback) => callback({ os: 'mac' })),
      lastError: undefined as chrome.runtime.LastError | undefined,
    },
  } as unknown as typeof chrome;

  return {
    attach,
    detach,
    sendCommand,
    debuggerEventListeners,
    debuggerDetachListeners,
    finishAttach() {
      attachCallback?.();
    },
    finishDetach() {
      detachCallback?.();
    },
    finishSendCommand() {
      sendCommandCallback?.({ value: 'late' });
    },
  };
}

async function loadBridge() {
  vi.resetModules();
  return import('./cdp-bridge.js');
}

function frame(value: Record<string, unknown>): { type?: unknown } {
  return value;
}

describe('CDP bridge', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('attaches the active tab and returns its metadata', async () => {
    const chromeHarness = installChromeHarness();
    const bridge = await loadBridge();
    const send = vi.fn();

    bridge.handleCdpFrame(frame({ type: 'cdp_attach', id: 1 }), send);

    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith({
        type: 'cdp_attached',
        id: 1,
        url: 'https://example.test',
        title: 'Page',
      }),
    );
    expect(chromeHarness.attach).toHaveBeenCalledWith(
      { tabId: 7 },
      '1.3',
      expect.any(Function),
    );

    bridge.shutdownCdpBridge();
  });

  it('forwards commands to the attached tab', async () => {
    const chromeHarness = installChromeHarness();
    const bridge = await loadBridge();
    const send = vi.fn();

    bridge.handleCdpFrame(frame({ type: 'cdp_attach', id: 1 }), send);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    bridge.handleCdpFrame(
      frame({
        type: 'cdp_command',
        id: 2,
        method: 'Runtime.evaluate',
        params: { expression: 'document.title' },
      }),
      send,
    );

    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith({
        type: 'cdp_result',
        id: 2,
        result: { value: 'ok' },
      }),
    );
    expect(chromeHarness.sendCommand).toHaveBeenCalledWith(
      { tabId: 7 },
      'Runtime.evaluate',
      { expression: 'document.title' },
      expect.any(Function),
    );

    bridge.shutdownCdpBridge();
  });

  it('runs direct WebBridge commands through the shared attachment', async () => {
    const chromeHarness = installChromeHarness();
    const bridge = await loadBridge();

    await bridge.withCdpTab(7, (send) =>
      send('Runtime.evaluate', { expression: 'document.title' }),
    );
    await bridge.withCdpTab(7, async () => undefined);

    expect(chromeHarness.attach).toHaveBeenCalledOnce();
    expect(chromeHarness.sendCommand).toHaveBeenCalledWith(
      { tabId: 7 },
      'Runtime.evaluate',
      { expression: 'document.title' },
      expect.any(Function),
    );
    bridge.shutdownCdpBridge();
  });

  it('delivers debugger events to direct subscribers without a raw client', async () => {
    const chromeHarness = installChromeHarness();
    const bridge = await loadBridge();
    const listener = vi.fn();
    const unsubscribe = bridge.subscribeCdpEvents(listener);

    await bridge.withCdpTab(7, async () => undefined);

    for (const emit of chromeHarness.debuggerEventListeners) {
      emit({ tabId: 7 }, 'Network.requestWillBeSent', { requestId: 'r1' });
    }
    expect(listener).toHaveBeenCalledWith(
      'Network.requestWillBeSent',
      { requestId: 'r1' },
      7,
    );

    listener.mockClear();
    for (const emit of chromeHarness.debuggerEventListeners) {
      emit({ tabId: 99 }, 'Network.requestWillBeSent', { requestId: 'r2' });
    }
    expect(listener).not.toHaveBeenCalled();

    unsubscribe();
    bridge.shutdownCdpBridge();
  });

  it('detaches only the timed-out action\'s tab, not every attachment', async () => {
    const chromeHarness = installChromeHarness({ deferSendCommand: true });
    const bridge = await loadBridge();

    await bridge.withCdpTab(7, async () => undefined);
    await bridge.withCdpTab(8, async () => undefined);

    const pending = bridge.withCdpTab(7, (send) =>
      send('Runtime.evaluate', { expression: 'new Promise(() => {})' }),
    );
    void pending.catch(() => {});
    await vi.waitFor(() =>
      expect(chromeHarness.sendCommand).toHaveBeenCalledOnce(),
    );

    await vi.advanceTimersByTimeAsync(55_000);

    await expect(pending).rejects.toThrow(
      'WebBridge action timed out after 55s',
    );
    expect(chromeHarness.detach).toHaveBeenCalledWith(
      { tabId: 7 },
      expect.any(Function),
    );
    expect(chromeHarness.detach).not.toHaveBeenCalledWith(
      { tabId: 8 },
      expect.any(Function),
    );

    // The untouched tab stays attached and usable.
    await expect(
      bridge.withCdpTab(8, async () => undefined),
    ).resolves.toBeUndefined();
    bridge.shutdownCdpBridge();
  });

  it('keeps direct WebBridge tabs attached while switching targets', async () => {
    const chromeHarness = installChromeHarness();
    const bridge = await loadBridge();

    await bridge.withCdpTab(7, async () => undefined);
    await bridge.withCdpTab(8, async () => undefined);

    expect(chromeHarness.attach).toHaveBeenCalledTimes(2);
    expect(chromeHarness.detach).not.toHaveBeenCalled();
    bridge.shutdownCdpBridge();
    expect(chromeHarness.detach).toHaveBeenCalledWith(
      { tabId: 7 },
      expect.any(Function),
    );
    expect(chromeHarness.detach).toHaveBeenCalledWith(
      { tabId: 8 },
      expect.any(Function),
    );
  });

  it('rejects a raw CDP attach while WebBridge is attaching', async () => {
    const chromeHarness = installChromeHarness({ deferAttach: true });
    const bridge = await loadBridge();
    const send = vi.fn();

    const direct = bridge.withCdpTab(7, async () => undefined);
    await vi.waitFor(() => expect(chromeHarness.attach).toHaveBeenCalledOnce());
    bridge.handleCdpFrame(frame({ type: 'cdp_attach', id: 2 }), send);

    expect(send).toHaveBeenCalledWith({
      type: 'cdp_attached',
      id: 2,
      error: { message: 'WebBridge is currently controlling the browser' },
    });
    chromeHarness.finishAttach();
    await direct;
    bridge.shutdownCdpBridge();
  });

  it('rejects a whole WebBridge action while the raw tunnel owns Chrome', async () => {
    installChromeHarness();
    const bridge = await loadBridge();
    const send = vi.fn();
    const operation = vi.fn(async () => undefined);

    bridge.handleCdpFrame(frame({ type: 'cdp_attach', id: 1 }), send);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));

    await expect(bridge.withDirectBrowserAction(operation)).rejects.toThrow(
      'CDP tunnel is currently controlling the browser',
    );
    expect(operation).not.toHaveBeenCalled();
    bridge.shutdownCdpBridge();
  });

  it('rejects overlapping direct actions instead of queueing them', async () => {
    installChromeHarness();
    const bridge = await loadBridge();
    let release!: () => void;
    const first = bridge.withDirectBrowserAction(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );

    await expect(
      bridge.withDirectBrowserAction(async () => undefined),
    ).rejects.toThrow('WebBridge action is already in progress');
    release();
    await first;
  });

  it('releases a timed-out direct command before detach finishes', async () => {
    const chromeHarness = installChromeHarness({
      deferDetach: true,
      deferSendCommand: true,
    });
    const bridge = await loadBridge();
    const pending = bridge.withCdpTab(7, (send) =>
      send('Runtime.evaluate', { expression: 'new Promise(() => {})' }),
    );
    let settled = false;
    void pending
      .finally(() => {
        settled = true;
      })
      .catch(() => {});
    await vi.waitFor(() =>
      expect(chromeHarness.sendCommand).toHaveBeenCalledOnce(),
    );

    await vi.advanceTimersByTimeAsync(55_000);

    expect(chromeHarness.detach).toHaveBeenCalledWith(
      { tabId: 7 },
      expect.any(Function),
    );
    await Promise.resolve();
    expect(settled).toBe(true);
    await expect(
      bridge.withDirectBrowserAction(async () => undefined),
    ).rejects.toThrow('CDP tunnel is releasing the browser');

    chromeHarness.finishSendCommand();
    chromeHarness.finishDetach();
    await expect(pending).rejects.toThrow(
      'WebBridge action timed out after 55s',
    );
    await expect(
      bridge.withDirectBrowserAction(async () => undefined),
    ).resolves.toBeUndefined();
    expect(chromeHarness.detach).toHaveBeenCalledOnce();
  });

  it('blocks WebBridge actions until raw CDP detach completes', async () => {
    const chromeHarness = installChromeHarness({ deferDetach: true });
    const bridge = await loadBridge();
    const send = vi.fn();

    bridge.handleCdpFrame(frame({ type: 'cdp_attach', id: 1 }), send);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    bridge.handleCdpFrame(frame({ type: 'cdp_release' }), send);

    await expect(
      bridge.withDirectBrowserAction(async () => undefined),
    ).rejects.toThrow('CDP tunnel is releasing the browser');
    chromeHarness.finishDetach();
    await vi.waitFor(() =>
      expect(
        bridge.withDirectBrowserAction(async () => undefined),
      ).resolves.toBeUndefined(),
    );
    bridge.shutdownCdpBridge();
  });

  it('rejects a raw reattach until the previous detach completes', async () => {
    const chromeHarness = installChromeHarness({ deferDetach: true });
    const bridge = await loadBridge();
    const send = vi.fn();

    bridge.handleCdpFrame(frame({ type: 'cdp_attach', id: 1 }), send);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    bridge.handleCdpFrame(frame({ type: 'cdp_release' }), send);
    bridge.handleCdpFrame(frame({ type: 'cdp_attach', id: 2 }), send);

    expect(send).toHaveBeenCalledWith({
      type: 'cdp_attached',
      id: 2,
      error: { message: 'CDP tunnel is releasing the browser' },
    });
    chromeHarness.finishDetach();
    await vi.waitFor(() =>
      expect(
        bridge.withDirectBrowserAction(async () => undefined),
      ).resolves.toBeUndefined(),
    );
    bridge.shutdownCdpBridge();
  });

  it('rejects raw ownership while a WebBridge tab remains attached', async () => {
    const chromeHarness = installChromeHarness();
    const bridge = await loadBridge();
    const send = vi.fn();

    await bridge.withCdpTab(7, async () => undefined);
    bridge.handleCdpFrame(frame({ type: 'cdp_attach', id: 1 }), send);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send).toHaveBeenCalledWith({
      type: 'cdp_attached',
      id: 1,
      error: { message: 'WebBridge is currently controlling the browser' },
    });
    expect(chromeHarness.detach).not.toHaveBeenCalled();
    bridge.shutdownCdpBridge();
  });

  it('notifies the daemon when Chrome detaches the debugger', async () => {
    const chromeHarness = installChromeHarness();
    const bridge = await loadBridge();
    const send = vi.fn();

    bridge.handleCdpFrame(frame({ type: 'cdp_attach', id: 1 }), send);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    chromeHarness.debuggerDetachListeners[0]?.(
      { tabId: 7 },
      'canceled_by_user',
    );

    expect(send).toHaveBeenCalledWith({
      type: 'cdp_detach',
      reason: 'canceled_by_user',
    });
    await expect(
      bridge.withCdpTab(7, async () => undefined),
    ).resolves.toBeUndefined();
  });

  it('releases an attachment that finishes after shutdown', async () => {
    const chromeHarness = installChromeHarness({ deferAttach: true });
    const bridge = await loadBridge();
    const send = vi.fn();

    bridge.handleCdpFrame(frame({ type: 'cdp_attach', id: 1 }), send);
    await vi.waitFor(() => expect(chromeHarness.attach).toHaveBeenCalledOnce());
    bridge.shutdownCdpBridge();
    chromeHarness.finishAttach();

    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith({
        type: 'cdp_attached',
        id: 1,
        error: { message: 'released during attach' },
      }),
    );
    expect(chromeHarness.detach).toHaveBeenCalledWith(
      { tabId: 7 },
      expect.any(Function),
    );
  });

  it('releases a direct attachment that finishes after shutdown', async () => {
    const chromeHarness = installChromeHarness({ deferAttach: true });
    const bridge = await loadBridge();

    const direct = bridge.withCdpTab(7, async () => undefined);
    await vi.waitFor(() => expect(chromeHarness.attach).toHaveBeenCalledOnce());
    bridge.shutdownCdpBridge();
    chromeHarness.finishAttach();

    await expect(direct).rejects.toThrow('released during attach');
    expect(chromeHarness.detach).toHaveBeenCalledWith(
      { tabId: 7 },
      expect.any(Function),
    );
  });

  it('honors a raw release while attach is pending', async () => {
    const chromeHarness = installChromeHarness({ deferAttach: true });
    const bridge = await loadBridge();
    const send = vi.fn();

    bridge.handleCdpFrame(frame({ type: 'cdp_attach', id: 1 }), send);
    await vi.waitFor(() => expect(chromeHarness.attach).toHaveBeenCalledOnce());
    bridge.handleCdpFrame(frame({ type: 'cdp_release' }), send);
    chromeHarness.finishAttach();

    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith({
        type: 'cdp_attached',
        id: 1,
        error: { message: 'released during attach' },
      }),
    );
    expect(chromeHarness.detach).toHaveBeenCalledWith(
      { tabId: 7 },
      expect.any(Function),
    );
  });

  it('detaches the previous raw tab before attaching a new one', async () => {
    const chromeHarness = installChromeHarness();
    const bridge = await loadBridge();
    const send = vi.fn();

    bridge.handleCdpFrame(frame({ type: 'cdp_attach', id: 1 }), send);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    (chrome.tabs.query as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 9 },
    ]);
    bridge.handleCdpFrame(frame({ type: 'cdp_attach', id: 2 }), send);

    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send.mock.calls[1]?.[0]).not.toHaveProperty('error');
    expect(chromeHarness.detach).toHaveBeenCalledWith(
      { tabId: 7 },
      expect.any(Function),
    );
    expect(chromeHarness.attach).toHaveBeenLastCalledWith(
      { tabId: 9 },
      '1.3',
      expect.any(Function),
    );
    bridge.shutdownCdpBridge();
  });

  it('does not treat previous-tab detach as new-tab release during attach', async () => {
    const chromeHarness = installChromeHarness({ deferDetach: true });
    const bridge = await loadBridge();
    const send = vi.fn();

    bridge.handleCdpFrame(frame({ type: 'cdp_attach', id: 1 }), send);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    (chrome.tabs.query as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 9 },
    ]);

    bridge.handleCdpFrame(frame({ type: 'cdp_attach', id: 2 }), send);
    await vi.waitFor(() => expect(chromeHarness.detach).toHaveBeenCalled());
    chromeHarness.debuggerDetachListeners[0]?.({ tabId: 7 }, 'target_closed');
    chromeHarness.finishDetach();

    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send.mock.calls[1]?.[0]).toMatchObject({
      type: 'cdp_attached',
      id: 2,
    });
    expect(send.mock.calls[1]?.[0]).not.toHaveProperty('error');
  });

  it('forwards debugger events for the attached tab', async () => {
    const chromeHarness = installChromeHarness();
    const bridge = await loadBridge();
    const send = vi.fn();

    bridge.handleCdpFrame(frame({ type: 'cdp_attach', id: 1 }), send);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    chromeHarness.debuggerEventListeners[0]?.(
      { tabId: 7 },
      'Runtime.consoleAPICalled',
      { type: 'log' },
    );

    expect(send).toHaveBeenCalledWith({
      type: 'cdp_event',
      method: 'Runtime.consoleAPICalled',
      params: { type: 'log' },
    });
  });

  it('ignores debugger events from a different tab', async () => {
    const chromeHarness = installChromeHarness();
    const bridge = await loadBridge();
    const send = vi.fn();

    bridge.handleCdpFrame(frame({ type: 'cdp_attach', id: 1 }), send);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    chromeHarness.debuggerEventListeners[0]?.(
      { tabId: 999 },
      'Runtime.consoleAPICalled',
      { type: 'log' },
    );

    expect(send).toHaveBeenCalledTimes(1);
  });

  it('rejects a CDP command when chrome.runtime.lastError is set', async () => {
    const chromeHarness = installChromeHarness();
    chromeHarness.sendCommand.mockImplementation(
      (
        _target: chrome.debugger.Debuggee,
        _method: string,
        _params: object,
        callback: (result?: object) => void,
      ) => {
        (chrome.runtime as { lastError: unknown }).lastError = {
          message: 'No tab with id: 7',
        };
        callback(undefined);
        (chrome.runtime as { lastError: unknown }).lastError = undefined;
      },
    );
    const bridge = await loadBridge();
    const send = vi.fn();

    bridge.handleCdpFrame(frame({ type: 'cdp_attach', id: 1 }), send);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    bridge.handleCdpFrame(
      frame({
        type: 'cdp_command',
        id: 2,
        method: 'Runtime.evaluate',
        params: { expression: '1' },
      }),
      send,
    );

    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith({
        type: 'cdp_result',
        id: 2,
        error: { code: -32000, message: 'No tab with id: 7' },
      }),
    );
  });
});
