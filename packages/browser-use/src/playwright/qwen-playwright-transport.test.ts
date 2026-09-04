/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { runInNewContext } from 'node:vm';

import { describe, expect, it, vi } from 'vitest';

import type {
  BridgeConnectionListener,
  BridgeEvent,
  BridgeEventListener,
  ChromeBridge,
} from '../bridge/index.js';
import {
  playwrightTransportAdapter,
  QwenPlaywrightTransport,
} from './qwen-playwright-transport.js';

class FakeBridge implements ChromeBridge {
  readonly calls: Array<{
    method: string;
    params: Record<string, unknown>;
  }> = [];
  private readonly eventListeners = new Set<BridgeEventListener>();
  private readonly connectionListeners = new Set<BridgeConnectionListener>();

  async start(): Promise<void> {}
  isConnected(): boolean {
    return true;
  }
  async request(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<unknown> {
    this.calls.push({ method, params });
    if (method === 'cdp.send' && params.method === 'Target.getTargetInfo') {
      return {
        targetInfo: {
          targetId: 'target-7',
          type: 'page',
          title: 'Example',
          url: 'https://example.com/',
        },
      };
    }
    if (method === 'cdp.send' && params.method === 'Runtime.evaluate')
      return { result: { value: 42 } };
    return null;
  }
  onEvent(listener: BridgeEventListener): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }
  onConnectionChange(listener: BridgeConnectionListener): () => void {
    this.connectionListeners.add(listener);
    return () => this.connectionListeners.delete(listener);
  }
  async stop(): Promise<void> {}
  emit(event: BridgeEvent): void {
    for (const listener of this.eventListeners) listener(event);
  }
  disconnect(): void {
    for (const listener of this.connectionListeners) listener(false);
  }
}

describe('QwenPlaywrightTransport', () => {
  it('adapts a Node REPL VM transport into the host realm Playwright expects', () => {
    const foreignTransport = runInNewContext(`({
      open() {},
      send() {},
      close() {},
    })`) as {
      open(): void;
      send(message: object): void;
      close(): void;
      onmessage?: (message: object) => void;
      onclose?: (reason?: string) => void;
    };
    expect(foreignTransport instanceof Object).toBe(false);

    const adapter = playwrightTransportAdapter(foreignTransport);
    const onmessage = vi.fn();
    const onclose = vi.fn();
    adapter.onmessage = onmessage;
    adapter.onclose = onclose;

    expect(adapter instanceof Object).toBe(true);
    expect(foreignTransport.onmessage).toBe(onmessage);
    expect(foreignTransport.onclose).toBe(onclose);
  });

  it('rejects unsupported browser-level commands', async () => {
    const bridge = new FakeBridge();
    const transport = new QwenPlaywrightTransport(bridge);
    const messages: object[] = [];
    const onclose = vi.fn();
    transport.onmessage = (message) => messages.push(message);
    transport.onclose = onclose;

    transport.send({
      id: 1,
      method: 'Browser.getWindowForTarget',
      params: {},
    });
    await vi.waitFor(() =>
      expect(messages).toContainEqual({
        id: 1,
        error: {
          message:
            'Unsupported browser-level CDP command: Browser.getWindowForTarget',
        },
      }),
    );
    expect(bridge.calls).toEqual([]);
    expect(onclose).not.toHaveBeenCalled();
  });

  it('provides explicit target sessions for Playwright CDP sessions', async () => {
    const bridge = new FakeBridge();
    const transport = new QwenPlaywrightTransport(bridge);
    const messages: object[] = [];
    transport.onmessage = (message) => messages.push(message);
    await transport.registerTab(7);

    transport.send({ id: 1, method: 'Target.attachToBrowserTarget' });
    await vi.waitFor(() =>
      expect(messages).toContainEqual({
        id: 1,
        result: { sessionId: 'pw-browser-2' },
      }),
    );
    transport.send({
      id: 2,
      sessionId: 'pw-browser-2',
      method: 'Target.attachToTarget',
      params: { targetId: 'target-7', flatten: true },
    });
    await vi.waitFor(() =>
      expect(messages).toContainEqual({
        id: 2,
        sessionId: 'pw-browser-2',
        result: { sessionId: 'pw-cdp-3' },
      }),
    );

    transport.send({
      id: 3,
      sessionId: 'pw-cdp-3',
      method: 'Target.getTargetInfo',
    });
    await vi.waitFor(() =>
      expect(messages).toContainEqual({
        id: 3,
        sessionId: 'pw-cdp-3',
        result: {
          targetInfo: expect.objectContaining({ targetId: 'target-7' }),
        },
      }),
    );

    transport.send({
      id: 4,
      sessionId: 'pw-cdp-3',
      method: 'Runtime.evaluate',
      params: { expression: '6 * 7' },
    });
    await vi.waitFor(() =>
      expect(bridge.calls).toContainEqual({
        method: 'cdp.send',
        params: {
          tabId: 7,
          method: 'Runtime.evaluate',
          params: { expression: '6 * 7' },
        },
      }),
    );

    bridge.emit({
      type: 'event',
      tabId: 7,
      method: 'Runtime.consoleAPICalled',
      params: { type: 'log' },
    });
    expect(messages.at(-1)).toEqual({
      sessionId: 'pw-cdp-3',
      method: 'Runtime.consoleAPICalled',
      params: { type: 'log' },
    });

    transport.send({
      id: 5,
      sessionId: 'pw-browser-2',
      method: 'Target.detachFromTarget',
      params: { sessionId: 'pw-cdp-3' },
    });
    await vi.waitFor(() =>
      expect(messages).toContainEqual({
        id: 5,
        sessionId: 'pw-browser-2',
        result: {},
      }),
    );
  });

  it('forwards target attachment from a real tab session', async () => {
    const bridge = new FakeBridge();
    const transport = new QwenPlaywrightTransport(bridge);
    const messages: object[] = [];
    transport.onmessage = (message) => messages.push(message);
    await transport.registerTab(7);

    transport.send({
      id: 1,
      sessionId: 'pw-tab-1',
      method: 'Target.attachToTarget',
      params: { targetId: 'frame-1', flatten: true },
    });

    await vi.waitFor(() =>
      expect(bridge.calls).toContainEqual({
        method: 'cdp.send',
        params: {
          tabId: 7,
          method: 'Target.attachToTarget',
          params: { targetId: 'frame-1', flatten: true },
        },
      }),
    );
    await vi.waitFor(() =>
      expect(messages).toContainEqual({
        id: 1,
        sessionId: 'pw-tab-1',
        result: null,
      }),
    );
  });

  it('maps a claimed Chrome tab to a Playwright target session', async () => {
    const bridge = new FakeBridge();
    const transport = new QwenPlaywrightTransport(bridge);
    const messages: object[] = [];
    transport.onmessage = (message) => messages.push(message);

    transport.send({
      id: 1,
      method: 'Target.setAutoAttach',
      params: { autoAttach: true, flatten: true },
    });
    await vi.waitFor(() =>
      expect(messages).toContainEqual({ id: 1, result: {} }),
    );

    await expect(transport.registerTab(7)).resolves.toBe('target-7');
    expect(bridge.calls).toContainEqual({
      method: 'tabs.attach',
      params: { tabId: 7 },
    });
    expect(messages).toContainEqual({
      method: 'Target.attachedToTarget',
      params: {
        sessionId: 'pw-tab-1',
        targetInfo: {
          targetId: 'target-7',
          type: 'page',
          title: 'Example',
          url: 'https://example.com/',
          attached: true,
        },
        waitingForDebugger: false,
      },
    });

    transport.send({
      id: 2,
      sessionId: 'pw-tab-1',
      method: 'Runtime.evaluate',
      params: { expression: '6 * 7' },
    });
    await vi.waitFor(() =>
      expect(messages).toContainEqual({
        id: 2,
        sessionId: 'pw-tab-1',
        result: { result: { value: 42 } },
      }),
    );
    expect(bridge.calls).toContainEqual({
      method: 'cdp.send',
      params: {
        tabId: 7,
        method: 'Runtime.evaluate',
        params: { expression: '6 * 7' },
      },
    });
  });

  it('forwards tab events and closes when Native Messaging disconnects', async () => {
    const bridge = new FakeBridge();
    const transport = new QwenPlaywrightTransport(bridge);
    const messages: object[] = [];
    const onclose = vi.fn();
    transport.onmessage = (message) => messages.push(message);
    transport.onclose = onclose;
    transport.send({ id: 1, method: 'Target.setAutoAttach', params: {} });
    await vi.waitFor(() => expect(messages).toHaveLength(1));
    await transport.registerTab(7);

    bridge.emit({
      type: 'event',
      tabId: 7,
      method: 'Page.loadEventFired',
      params: { timestamp: 1 },
    });
    expect(messages.at(-1)).toEqual({
      sessionId: 'pw-tab-1',
      method: 'Page.loadEventFired',
      params: { timestamp: 1 },
    });

    bridge.emit({
      type: 'event',
      tabId: 7,
      method: 'Page.downloadWillBegin',
      params: {
        frameId: 'target-7',
        guid: 'download-1',
        suggestedFilename: 'fixture.txt',
        url: 'https://example.com/fixture.txt',
      },
    });
    expect(messages.at(-1)).toEqual({
      method: 'Browser.downloadWillBegin',
      params: {
        frameId: 'target-7',
        guid: 'download-1',
        suggestedFilename: 'fixture.txt',
        url: 'https://example.com/fixture.txt',
      },
    });

    bridge.disconnect();
    expect(onclose).toHaveBeenCalledWith('Chrome extension disconnected');
  });

  it('maps child target sessions and their detach lifecycle', async () => {
    const bridge = new FakeBridge();
    const transport = new QwenPlaywrightTransport(bridge);
    const messages: object[] = [];
    transport.onmessage = (message) => messages.push(message);
    transport.send({ id: 1, method: 'Target.setAutoAttach', params: {} });
    await vi.waitFor(() => expect(messages).toHaveLength(1));
    await transport.registerTab(7);

    bridge.emit({
      type: 'event',
      tabId: 7,
      method: 'Target.attachedToTarget',
      params: {
        sessionId: 'child-1',
        targetInfo: {
          targetId: 'frame-1',
          type: 'iframe',
          title: '',
          url: 'https://example.com/frame',
        },
        waitingForDebugger: false,
      },
    });
    transport.send({
      id: 2,
      sessionId: 'child-1',
      method: 'Runtime.evaluate',
      params: { expression: '6 * 7' },
    });
    await vi.waitFor(() =>
      expect(bridge.calls).toContainEqual({
        method: 'cdp.send',
        params: {
          tabId: 7,
          sessionId: 'child-1',
          method: 'Runtime.evaluate',
          params: { expression: '6 * 7' },
        },
      }),
    );

    bridge.emit({
      type: 'event',
      tabId: 7,
      sessionId: 'child-1',
      method: 'qwenBrowser.sessionDetached',
      params: { reason: 'target_closed' },
    });
    expect(messages.at(-1)).toEqual({
      sessionId: 'pw-tab-1',
      method: 'Target.detachedFromTarget',
      params: { sessionId: 'child-1' },
    });
  });

  it('closes when Chrome reports malformed child target information', async () => {
    const bridge = new FakeBridge();
    const transport = new QwenPlaywrightTransport(bridge);
    const onclose = vi.fn();
    transport.onclose = onclose;
    await transport.registerTab(7);

    bridge.emit({
      type: 'event',
      tabId: 7,
      method: 'Target.attachedToTarget',
      params: {
        sessionId: 'child-1',
        targetInfo: { targetId: 'frame-1' },
        waitingForDebugger: false,
      },
    });

    await vi.waitFor(() =>
      expect(onclose).toHaveBeenCalledWith(
        'Chrome extension returned invalid target information',
      ),
    );
  });
});
