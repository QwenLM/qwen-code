/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { runInNewContext } from 'node:vm';

import { afterEach, describe, expect, it, vi } from 'vitest';

const osMock = vi.hoisted(() => ({ platform: process.platform }));
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:os')>()),
  platform: () => osMock.platform,
}));

afterEach(() => {
  osMock.platform = process.platform;
});

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

  connected = true;
  async start(): Promise<void> {}
  isConnected(): boolean {
    return this.connected;
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
    this.connected = false;
    for (const listener of this.connectionListeners) listener(false);
  }
}

describe('QwenPlaywrightTransport', () => {
  it.each(['throw', 'reject'] as const)(
    'closes and releases tabs when message delivery %s fails',
    async (mode) => {
      const bridge = new FakeBridge();
      const transport = new QwenPlaywrightTransport(bridge);
      await transport.registerTab(7);
      const onclose = vi.fn();
      transport.onclose = onclose;
      transport.onmessage = () => {
        if (mode === 'throw') throw new Error('consumer failed');
        return Promise.reject(new Error('consumer failed'));
      };
      transport.send({ id: 1, method: 'Browser.getVersion' });
      await vi.waitFor(() =>
        expect(onclose).toHaveBeenCalledWith('consumer failed'),
      );
      await transport.close();
      expect(
        bridge.calls.filter((call) => call.method === 'tabs.detach'),
      ).toEqual([{ method: 'tabs.detach', params: { tabId: 7 } }]);
      await expect(transport.registerTab(7)).rejects.toThrow('closed');
    },
  );

  it('drains a partial attachment before releasing it once on close', async () => {
    const bridge = new FakeBridge();
    const request = bridge.request.bind(bridge);
    const attached = deferred();
    const releaseAttach = deferred();
    vi.spyOn(bridge, 'request').mockImplementation(async (method, params) => {
      const result = await request(method, params);
      if (method === 'tabs.attach') {
        attached.resolve();
        await releaseAttach.promise;
      }
      return result;
    });
    const transport = new QwenPlaywrightTransport(bridge);
    const registration = transport.registerTab(7).catch((error) => error);
    await attached.promise;
    const closed = vi.fn();
    const stopping = Promise.resolve(transport.close()).then(closed);
    const duplicate = transport.unregisterTab(7);
    await Promise.resolve();
    expect(closed).not.toHaveBeenCalled();
    expect(bridge.calls.map((call) => call.method)).toEqual(['tabs.attach']);
    releaseAttach.resolve();
    expect(await registration).toMatchObject({
      message: 'Playwright transport is closed',
    });
    await Promise.all([stopping, duplicate]);
    expect(bridge.calls.map((call) => call.method)).toEqual([
      'tabs.attach',
      'tabs.detach',
    ]);
    expect(transport.providerTabId('target-7')).toBeUndefined();
  });

  it('waits for a pending release before reattaching the same tab', async () => {
    const bridge = new FakeBridge();
    const transport = new QwenPlaywrightTransport(bridge);
    await transport.registerTab(7);
    const request = bridge.request.bind(bridge);
    const detached = deferred();
    const releaseDetach = deferred();
    vi.spyOn(bridge, 'request').mockImplementation(async (method, params) => {
      const result = await request(method, params);
      if (method === 'tabs.detach') {
        detached.resolve();
        await releaseDetach.promise;
      }
      return result;
    });
    const releasing = transport.unregisterTab(7);
    await detached.promise;
    const registering = transport.registerTab(7);
    await Promise.resolve();
    expect(
      bridge.calls.filter((call) => call.method === 'tabs.attach'),
    ).toHaveLength(1);
    releaseDetach.resolve();
    await Promise.all([releasing, registering]);
    expect(
      bridge.calls.filter((call) => call.method === 'tabs.attach'),
    ).toHaveLength(2);
    await transport.close();
  });

  it('does not release old attachments through a replacement bridge connection', async () => {
    const bridge = new FakeBridge();
    const transport = new QwenPlaywrightTransport(bridge);
    await transport.registerTab(7);
    bridge.disconnect();
    bridge.connected = true;
    await transport.close();
    expect(
      bridge.calls.filter((call) => call.method === 'tabs.detach'),
    ).toHaveLength(0);
  });

  it.each(['context-7', 3, ''])(
    'validates a supplied browser context id: %s',
    async (browserContextId) => {
      const bridge = new FakeBridge();
      const request = bridge.request.bind(bridge);
      vi.spyOn(bridge, 'request').mockImplementation(async (method, params) => {
        const result = await request(method, params);
        if (method === 'cdp.send' && params?.method === 'Target.getTargetInfo')
          return {
            targetInfo: {
              ...(result as { targetInfo: object }).targetInfo,
              browserContextId,
            },
          };
        return result;
      });
      const transport = new QwenPlaywrightTransport(bridge);
      const onmessage = vi.fn();
      transport.onmessage = onmessage;
      if (browserContextId === 'context-7') {
        await transport.registerTab(7);
        expect(onmessage).toHaveBeenCalledWith(
          expect.objectContaining({
            params: expect.objectContaining({
              targetInfo: expect.objectContaining({ browserContextId }),
            }),
          }),
        );
      } else {
        await expect(transport.registerTab(7)).rejects.toThrow(
          'invalid target information',
        );
        expect(onmessage).not.toHaveBeenCalled();
        expect(
          bridge.calls.filter((call) => call.method === 'tabs.detach'),
        ).toHaveLength(1);
      }
      await transport.close();
    },
  );

  it('leaves screenshot frames to the runtime without Playwright acknowledgements', async () => {
    const bridge = new FakeBridge();
    const transport = new QwenPlaywrightTransport(bridge);
    await transport.registerTab(7);
    const onmessage = vi.fn();
    transport.onmessage = onmessage;
    for (const method of [
      'Page.screencastFrame',
      'Page.screencastVisibilityChanged',
    ]) {
      bridge.emit({ type: 'event', tabId: 7, method, params: {} });
    }
    expect(onmessage).not.toHaveBeenCalled();
    bridge.emit({
      type: 'event',
      tabId: 7,
      method: 'Page.loadEventFired',
      params: { timestamp: 1 },
    });
    expect(onmessage).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'Page.loadEventFired' }),
    );
    transport.close();
  });
  it('reports a parseable Chrome version and the host platform', async () => {
    osMock.platform = 'darwin';
    const bridge = new FakeBridge();
    const transport = new QwenPlaywrightTransport(bridge);
    const messages: object[] = [];
    transport.onmessage = (message) => messages.push(message);

    transport.send({ id: 1, method: 'Browser.getVersion' });

    await vi.waitFor(() => expect(messages).toHaveLength(1));
    const result = (
      messages[0] as {
        result: { product: string; userAgent: string };
      }
    ).result;
    expect(result.userAgent).toContain('Macintosh');
    expect(result.userAgent).not.toContain('Headless');
    const major = Number(result.product.split('/')[1]?.split('.')[0]);
    expect(Number.isFinite(major)).toBe(true);
    expect(major).toBeGreaterThan(0);
    transport.close();
  });

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
    expect(messages).toContainEqual({
      sessionId: 'pw-browser-2',
      method: 'Target.detachedFromTarget',
      params: { sessionId: 'pw-cdp-3', targetId: 'target-7' },
    });
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
          browserContextId: 'qwen-default-context',
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
      params: { sessionId: 'child-1', targetId: 'frame-1' },
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
    await transport.close();
    expect(
      bridge.calls.filter((call) => call.method === 'tabs.detach'),
    ).toEqual([{ method: 'tabs.detach', params: { tabId: 7 } }]);
  });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
