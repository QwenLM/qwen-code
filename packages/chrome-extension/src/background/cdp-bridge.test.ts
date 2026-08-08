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
}): ChromeHarness & { finishAttach(): void } {
  let attachCallback: (() => void) | undefined;
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
    (_target: chrome.debugger.Debuggee, callback?: () => void) => callback?.(),
  );
  const sendCommand = vi.fn(
    (
      _target: chrome.debugger.Debuggee,
      _method: string,
      _params: object,
      callback: (result?: object) => void,
    ) => callback({ value: 'ok' }),
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
    expect(chromeHarness.detach).toHaveBeenCalledWith({ tabId: 7 });
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

  it('two links share one chrome.debugger attach (issue #8737)', async () => {
    const chromeHarness = installChromeHarness();
    const bridge = await loadBridge();
    const send = vi.fn();

    bridge.handleCdpFrame(
      frame({ type: 'cdp_attach', id: 1, linkId: 'cdp-link-1' }),
      send,
    );
    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith({
        type: 'cdp_attached',
        id: 1,
        url: 'https://example.test',
        title: 'Page',
        linkId: 'cdp-link-1',
      }),
    );

    // Second link joins the existing attachment — no second debugger attach.
    bridge.handleCdpFrame(
      frame({ type: 'cdp_attach', id: 2, linkId: 'cdp-link-2' }),
      send,
    );
    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith({
        type: 'cdp_attached',
        id: 2,
        url: 'https://example.test',
        title: 'Page',
        linkId: 'cdp-link-2',
      }),
    );
    expect(chromeHarness.attach).toHaveBeenCalledTimes(1);
  });

  it('concurrent attaches join the in-flight attach instead of racing', async () => {
    const chromeHarness = installChromeHarness({ deferAttach: true });
    const bridge = await loadBridge();
    const send = vi.fn();

    bridge.handleCdpFrame(
      frame({ type: 'cdp_attach', id: 1, linkId: 'cdp-link-1' }),
      send,
    );
    bridge.handleCdpFrame(
      frame({ type: 'cdp_attach', id: 2, linkId: 'cdp-link-2' }),
      send,
    );
    await vi.waitFor(() =>
      expect(chromeHarness.attach).toHaveBeenCalledTimes(1),
    );
    expect(send).not.toHaveBeenCalled();

    chromeHarness.finishAttach();

    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'cdp_attached',
          id: 1,
          linkId: 'cdp-link-1',
        }),
      ),
    );
    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'cdp_attached',
          id: 2,
          linkId: 'cdp-link-2',
        }),
      ),
    );
  });

  it('results echo the requesting linkId', async () => {
    installChromeHarness();
    const bridge = await loadBridge();
    const send = vi.fn();

    bridge.handleCdpFrame(
      frame({ type: 'cdp_attach', id: 1, linkId: 'cdp-link-1' }),
      send,
    );
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    bridge.handleCdpFrame(
      frame({
        type: 'cdp_command',
        id: 2,
        method: 'Runtime.evaluate',
        linkId: 'cdp-link-1',
      }),
      send,
    );

    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith({
        type: 'cdp_result',
        id: 2,
        result: { value: 'ok' },
        linkId: 'cdp-link-1',
      }),
    );
  });

  it('releasing one link keeps the attach; the last release detaches', async () => {
    const chromeHarness = installChromeHarness();
    const bridge = await loadBridge();
    const send = vi.fn();

    bridge.handleCdpFrame(
      frame({ type: 'cdp_attach', id: 1, linkId: 'cdp-link-1' }),
      send,
    );
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    bridge.handleCdpFrame(
      frame({ type: 'cdp_attach', id: 2, linkId: 'cdp-link-2' }),
      send,
    );
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));

    bridge.handleCdpFrame(
      frame({ type: 'cdp_release', linkId: 'cdp-link-1' }),
      send,
    );
    // One link still holds the attachment: no debugger detach.
    expect(chromeHarness.detach).not.toHaveBeenCalled();

    bridge.handleCdpFrame(
      frame({ type: 'cdp_release', linkId: 'cdp-link-2' }),
      send,
    );
    await vi.waitFor(() =>
      expect(chromeHarness.detach).toHaveBeenCalledWith({ tabId: 7 }),
    );
  });

  it('an untagged release (legacy daemon) detaches immediately', async () => {
    const chromeHarness = installChromeHarness();
    const bridge = await loadBridge();
    const send = vi.fn();

    bridge.handleCdpFrame(frame({ type: 'cdp_attach', id: 1 }), send);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    bridge.handleCdpFrame(frame({ type: 'cdp_release' }), send);
    await vi.waitFor(() =>
      expect(chromeHarness.detach).toHaveBeenCalledWith({ tabId: 7 }),
    );
  });

  it('attaching to a switched tab broadcasts cdp_detach and re-attaches', async () => {
    const chromeHarness = installChromeHarness();
    const bridge = await loadBridge();
    const send = vi.fn();

    bridge.handleCdpFrame(
      frame({ type: 'cdp_attach', id: 1, linkId: 'cdp-link-1' }),
      send,
    );
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));

    // The user switched tabs; a new link attaches to the now-active one.
    (chrome.tabs.query as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 9 },
    ]);
    bridge.handleCdpFrame(
      frame({ type: 'cdp_attach', id: 2, linkId: 'cdp-link-2' }),
      send,
    );

    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith({
        type: 'cdp_detach',
        reason: 'target_switched',
      }),
    );
    await vi.waitFor(() =>
      expect(chromeHarness.attach).toHaveBeenCalledWith(
        { tabId: 9 },
        '1.3',
        expect.any(Function),
      ),
    );
    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'cdp_attached',
          id: 2,
          linkId: 'cdp-link-2',
        }),
      ),
    );
  });
});
