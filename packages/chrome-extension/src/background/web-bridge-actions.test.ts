/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const cdp = vi.hoisted(() => ({
  send: vi.fn(),
  withTab: vi.fn(),
  release: vi.fn(),
  unsubscribe: vi.fn(),
  detachListeners: [] as Array<(tabId: number) => void>,
  listeners: [] as Array<
    (method: string, params: Record<string, unknown>, tabId: number) => void
  >,
  subscribe: vi.fn(
    (
      listener: (
        method: string,
        params: Record<string, unknown>,
        tabId: number,
      ) => void,
    ) => {
      cdp.listeners.push(listener);
      return cdp.unsubscribe;
    },
  ),
  subscribeDetach: vi.fn((listener: (tabId: number) => void) => {
    cdp.detachListeners.push(listener);
    return vi.fn();
  }),
}));

vi.mock('./cdp-bridge', () => ({
  withCdpTab: cdp.withTab,
  withDirectBrowserAction: <T>(operation: () => Promise<T>) => operation(),
  releaseCdpTab: cdp.release,
  subscribeCdpEvents: cdp.subscribe,
  subscribeCdpDetaches: cdp.subscribeDetach,
}));

function installChrome(): void {
  globalThis.chrome = {
    tabs: {
      create: vi.fn().mockResolvedValue({
        id: 17,
        url: 'https://example.test',
        status: 'complete',
      }),
      get: vi.fn().mockResolvedValue({
        id: 17,
        url: 'https://example.test',
        title: 'Example',
        status: 'complete',
        groupId: -1,
      }),
      query: vi.fn().mockResolvedValue([]),
      group: vi.fn().mockResolvedValue(3),
      remove: vi.fn().mockResolvedValue(undefined),
      onUpdated: {
        addListener: vi.fn(),
        removeListener: vi.fn(),
      },
    },
    tabGroups: {
      TAB_GROUP_ID_NONE: -1,
      update: vi.fn().mockResolvedValue({}),
      get: vi.fn().mockResolvedValue({ title: 'Research' }),
    },
    windows: {
      getLastFocused: vi.fn().mockResolvedValue({ tabs: [] }),
    },
    runtime: {
      getPlatformInfo: vi.fn().mockResolvedValue({ os: 'mac' }),
    },
  } as unknown as typeof chrome;
}

async function loadActions() {
  return import('./web-bridge-actions.js');
}

const FRAME_TREE_LOADER_1 = {
  frameTree: { frame: { id: 'frame-1', loaderId: 'loader-1' } },
};

describe('WebBridge actions', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    cdp.listeners.length = 0;
    cdp.detachListeners.length = 0;
    installChrome();
    cdp.withTab.mockImplementation(
      async (
        _tabId: number,
        operation: (
          send: (method: string, params?: Record<string, unknown>) => unknown,
        ) => Promise<unknown>,
      ) => operation(cdp.send),
    );
  });

  it('opens and groups the first session tab', async () => {
    const { executeWebBridgeAction } = await loadActions();

    await expect(
      executeWebBridgeAction('navigate', {
        url: 'https://example.test',
        newTab: true,
        _session: 'research',
        group_title: 'Research',
      }),
    ).resolves.toEqual({
      success: true,
      url: 'https://example.test',
      tabId: 17,
    });
    expect(chrome.tabs.group).toHaveBeenCalledWith({ tabIds: 17 });
    expect(chrome.tabs.create).toHaveBeenCalledWith({
      url: 'https://example.test',
      active: false,
    });
    expect(chrome.tabGroups.update).toHaveBeenCalledWith(3, {
      title: 'Research',
      color: 'blue',
      collapsed: false,
    });
  });

  it('closes a newly created tab when navigation setup fails', async () => {
    cdp.withTab.mockRejectedValueOnce(new Error('debugger attach failed'));
    const { executeWebBridgeAction } = await loadActions();

    await expect(
      executeWebBridgeAction('navigate', {
        url: 'https://example.test',
        newTab: true,
        _session: 'research',
      }),
    ).rejects.toThrow('debugger attach failed');
    expect(chrome.tabs.remove).toHaveBeenCalledWith(17);
  });

  it('rejects a new tab that completes on Chrome error page', async () => {
    (chrome.tabs.get as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 17,
      url: 'chrome-error://chromewebdata/',
      status: 'complete',
      groupId: -1,
    });
    const { executeWebBridgeAction } = await loadActions();

    await expect(
      executeWebBridgeAction('navigate', {
        url: 'https://missing.example.test',
        newTab: true,
        _session: 'research',
      }),
    ).rejects.toThrow('page failed to load');
    expect(chrome.tabs.remove).toHaveBeenCalledWith(17);
  });

  it('returns the final URL after navigation redirects', async () => {
    (chrome.tabs.get as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 17,
      url: 'https://example.test/final',
      status: 'complete',
      groupId: -1,
    });
    const { executeWebBridgeAction } = await loadActions();

    await expect(
      executeWebBridgeAction('navigate', {
        url: 'https://example.test/start',
        newTab: true,
        _session: 'research',
      }),
    ).resolves.toMatchObject({ url: 'https://example.test/final' });
  });

  it('accepts about:blank as a completed navigation target', async () => {
    (chrome.tabs.get as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 17,
      url: 'about:blank',
      status: 'complete',
      groupId: -1,
    });
    const { executeWebBridgeAction } = await loadActions();

    await expect(
      executeWebBridgeAction('navigate', {
        url: 'about:blank',
        newTab: true,
        _session: 'research',
      }),
    ).resolves.toMatchObject({ url: 'about:blank' });
  });

  it('reports Page.navigate failures', async () => {
    cdp.send.mockResolvedValue({
      frameId: 'frame-1',
      errorText: 'net::ERR_NAME_NOT_RESOLVED',
    });
    const { executeWebBridgeAction } = await loadActions();

    await expect(
      executeWebBridgeAction('navigate', {
        url: 'https://missing.example.test',
        _tabId: 17,
      }),
    ).rejects.toThrow('net::ERR_NAME_NOT_RESOLVED');
  });

  it('invalidates snapshot refs as soon as navigation starts', async () => {
    cdp.send.mockImplementation(async (method: string) => {
      if (method === 'Accessibility.getFullAXTree') {
        return {
          nodes: [
            { nodeId: 'root', childIds: ['button'] },
            {
              nodeId: 'button',
              role: { value: 'button' },
              name: { value: 'Run' },
              backendDOMNodeId: 55,
            },
          ],
        };
      }
      if (method === 'Page.navigate') {
        return { frameId: 'frame-1', errorText: 'net::ERR_FAILED' };
      }
      return {};
    });
    const { executeWebBridgeAction } = await loadActions();
    await executeWebBridgeAction('snapshot', { _tabId: 17, _session: 'one' });
    await executeWebBridgeAction('snapshot', { _tabId: 17, _session: 'two' });

    await expect(
      executeWebBridgeAction('navigate', {
        url: 'https://example.test/next',
        _tabId: 17,
        _session: 'one',
      }),
    ).rejects.toThrow('net::ERR_FAILED');
    await expect(
      executeWebBridgeAction('click', {
        selector: '@e1',
        _tabId: 17,
        _session: 'two',
      }),
    ).rejects.toThrow('unknown ref');
  });

  it('waits for the current navigation to finish loading', async () => {
    cdp.send.mockImplementation(async (method: string) =>
      method === 'Page.navigate'
        ? { frameId: 'frame-1', loaderId: 'loader-1' }
        : {},
    );
    const { executeWebBridgeAction } = await loadActions();
    let settled = false;
    const pending = executeWebBridgeAction('navigate', {
      url: 'https://example.test/next',
      _tabId: 17,
    }).finally(() => {
      settled = true;
    });

    await vi.waitFor(() =>
      expect(cdp.send).toHaveBeenCalledWith('Page.navigate', {
        url: 'https://example.test/next',
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    const listener = cdp.listeners[0];
    expect(listener).toBeDefined();
    if (!listener) throw new Error('lifecycle listener was not installed');

    listener(
      'Page.lifecycleEvent',
      { name: 'load', frameId: 'frame-1', loaderId: 'old-loader' },
      17,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    listener(
      'Page.lifecycleEvent',
      { name: 'load', frameId: 'frame-1', loaderId: 'loader-1' },
      17,
    );
    await expect(pending).resolves.toMatchObject({
      url: 'https://example.test',
      frameId: 'frame-1',
    });
    expect(cdp.unsubscribe).toHaveBeenCalledOnce();
  });

  it('follows a redirect loader reported before Page.navigate returns', async () => {
    let resolveNavigate:
      | ((value: { frameId: string; loaderId: string }) => void)
      | undefined;
    cdp.send.mockImplementation(async (method: string) =>
      method === 'Page.navigate'
        ? new Promise<{ frameId: string; loaderId: string }>((resolve) => {
            resolveNavigate = resolve;
          })
        : {},
    );
    const { executeWebBridgeAction } = await loadActions();
    const pending = executeWebBridgeAction('navigate', {
      url: 'https://example.test/redirect',
      _tabId: 17,
    });

    await vi.waitFor(() => expect(resolveNavigate).toBeDefined());
    const listener = cdp.listeners[0];
    expect(listener).toBeDefined();
    if (!listener) throw new Error('lifecycle listener was not installed');
    listener(
      'Page.frameNavigated',
      { frame: { id: 'frame-1', loaderId: 'loader-2' } },
      17,
    );
    listener(
      'Page.lifecycleEvent',
      { name: 'load', frameId: 'frame-1', loaderId: 'loader-2' },
      17,
    );
    resolveNavigate?.({ frameId: 'frame-1', loaderId: 'loader-1' });

    await expect(pending).resolves.toMatchObject({ frameId: 'frame-1' });
  });

  it('waits for a same-URL reload to finish loading', async () => {
    cdp.send.mockImplementation(async (method: string) =>
      method === 'Page.getFrameTree'
        ? {
            frameTree: {
              frame: { id: 'frame-1', loaderId: 'loader-old' },
            },
          }
        : {},
    );
    const { executeWebBridgeAction } = await loadActions();
    let settled = false;
    const pending = executeWebBridgeAction('navigate', {
      url: 'https://example.test',
      _tabId: 17,
    }).finally(() => {
      settled = true;
    });

    await vi.waitFor(() =>
      expect(cdp.send).toHaveBeenCalledWith('Page.reload', {
        ignoreCache: true,
        loaderId: 'loader-old',
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);

    const listener = cdp.listeners[0];
    expect(listener).toBeDefined();
    if (!listener) throw new Error('lifecycle listener was not installed');
    listener(
      'Page.lifecycleEvent',
      { name: 'load', frameId: 'frame-1', loaderId: 'loader-old' },
      17,
    );
    listener(
      'Page.frameNavigated',
      { frame: { id: 'frame-1', loaderId: 'loader-new' } },
      17,
    );
    listener(
      'Page.lifecycleEvent',
      { name: 'load', frameId: 'frame-1', loaderId: 'loader-new' },
      17,
    );
    await expect(pending).resolves.toMatchObject({
      frameId: 'frame-1',
      url: 'https://example.test',
    });
  });

  it('follows a redirect loader after a same-URL reload starts', async () => {
    cdp.send.mockImplementation(async (method: string) =>
      method === 'Page.getFrameTree'
        ? {
            frameTree: {
              frame: { id: 'frame-1', loaderId: 'loader-old' },
            },
          }
        : {},
    );
    const { executeWebBridgeAction } = await loadActions();
    const pending = executeWebBridgeAction('navigate', {
      url: 'https://example.test',
      _tabId: 17,
    });

    await vi.waitFor(() => expect(cdp.listeners[0]).toBeDefined());
    const listener = cdp.listeners[0];
    if (!listener) throw new Error('lifecycle listener was not installed');
    listener(
      'Page.frameNavigated',
      { frame: { id: 'frame-1', loaderId: 'loader-reload' } },
      17,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    listener(
      'Page.frameNavigated',
      { frame: { id: 'frame-1', loaderId: 'loader-redirect' } },
      17,
    );
    listener(
      'Page.lifecycleEvent',
      { name: 'load', frameId: 'frame-1', loaderId: 'loader-reload' },
      17,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    listener(
      'Page.lifecycleEvent',
      { name: 'load', frameId: 'frame-1', loaderId: 'loader-redirect' },
      17,
    );

    await expect(pending).resolves.toMatchObject({
      url: 'https://example.test',
    });
  });

  it('rejects a reload that commits a Chrome error page', async () => {
    cdp.send.mockImplementation(async (method: string) =>
      method === 'Page.getFrameTree'
        ? {
            frameTree: {
              frame: { id: 'frame-1', loaderId: 'loader-old' },
            },
          }
        : {},
    );
    const { executeWebBridgeAction } = await loadActions();
    const pending = executeWebBridgeAction('navigate', {
      url: 'https://example.test',
      _tabId: 17,
    });

    await vi.waitFor(() => expect(cdp.listeners[0]).toBeDefined());
    cdp.listeners[0]?.(
      'Page.frameNavigated',
      {
        frame: {
          id: 'frame-1',
          loaderId: 'loader-new',
          url: 'chrome-error://chromewebdata/',
        },
      },
      17,
    );

    await expect(pending).rejects.toThrow('page failed to load');
  });

  it('recovers the existing session tab group after a worker restart', async () => {
    (chrome.tabs.get as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async (tabId: number) =>
        tabId === 16
          ? { id: 16, groupId: 9, url: 'https://example.test/one' }
          : {
              id: 17,
              groupId: 9,
              url: 'https://example.test/two',
              status: 'complete',
            },
    );
    const { executeWebBridgeAction } = await loadActions();

    await executeWebBridgeAction('navigate', {
      url: 'https://example.test/two',
      newTab: true,
      _session: 'research',
      _tabIds: [16],
    });

    expect(chrome.tabs.group).toHaveBeenCalledWith({
      tabIds: 17,
      groupId: 9,
    });
    expect(chrome.tabGroups.update).not.toHaveBeenCalled();
  });

  it('supports top-level await in evaluate', async () => {
    cdp.send.mockResolvedValue({ result: { type: 'number', value: 42 } });
    const { executeWebBridgeAction } = await loadActions();

    await executeWebBridgeAction('evaluate', {
      code: 'await Promise.resolve(42)',
      _tabId: 17,
    });

    expect(cdp.send).toHaveBeenCalledWith('Runtime.evaluate', {
      expression: 'await Promise.resolve(42)',
      returnByValue: true,
      awaitPromise: true,
      replMode: true,
    });
  });

  it('awaits implicit promise results in evaluate', async () => {
    cdp.send
      .mockResolvedValueOnce({
        result: {
          type: 'object',
          subtype: 'promise',
          objectId: 'promise-1',
        },
      })
      .mockResolvedValueOnce({ result: { type: 'number', value: 42 } });
    const { executeWebBridgeAction } = await loadActions();

    await expect(
      executeWebBridgeAction('evaluate', {
        code: 'Promise.resolve(42)',
        _tabId: 17,
      }),
    ).resolves.toEqual({ type: 'number', value: 42 });
    expect(cdp.send).toHaveBeenLastCalledWith('Runtime.callFunctionOn', {
      objectId: 'promise-1',
      functionDeclaration: 'function() { return this; }',
      returnByValue: true,
      awaitPromise: true,
    });
  });

  it('preserves unserializable evaluate results', async () => {
    cdp.send.mockResolvedValue({
      result: { type: 'bigint', unserializableValue: '1n' },
    });
    const { executeWebBridgeAction } = await loadActions();

    await expect(
      executeWebBridgeAction('evaluate', { code: '1n', _tabId: 17 }),
    ).resolves.toEqual({ type: 'bigint', value: '1n' });
  });

  it('surfaces implicit promise rejections in evaluate', async () => {
    cdp.send
      .mockResolvedValueOnce({
        result: {
          type: 'object',
          subtype: 'promise',
          objectId: 'promise-1',
        },
      })
      .mockResolvedValueOnce({
        exceptionDetails: { text: 'boom' },
      });
    const { executeWebBridgeAction } = await loadActions();

    await expect(
      executeWebBridgeAction('evaluate', {
        code: 'Promise.reject(new Error("boom"))',
        _tabId: 17,
      }),
    ).rejects.toThrow('evaluate: boom');
  });

  it('fills textarea values through the textarea setter', async () => {
    document.body.innerHTML = '<textarea id="notes"></textarea>';
    cdp.send.mockImplementation(
      async (_method: string, params?: Record<string, unknown>) => ({
        result: { value: window.eval(String(params?.['expression'])) },
      }),
    );
    const { executeWebBridgeAction } = await loadActions();

    await expect(
      executeWebBridgeAction('fill', {
        selector: '#notes',
        value: 'hello',
        _tabId: 17,
      }),
    ).resolves.toMatchObject({ success: true, mode: 'value' });
    expect(
      (document.querySelector('#notes') as HTMLTextAreaElement).value,
    ).toBe('hello');
  });

  it.each(['constructor', 'constructor+a'])(
    'rejects inherited key name %s',
    async (keys) => {
      const { executeWebBridgeAction } = await loadActions();

      await expect(
        executeWebBridgeAction('send_keys', { keys, _tabId: 17 }),
      ).rejects.toThrow('send_keys');
    },
  );

  it('creates stable snapshot refs and clicks them through DOM.resolveNode', async () => {
    cdp.send
      .mockResolvedValueOnce(
        FRAME_TREE_LOADER_1,
      )
      .mockResolvedValueOnce({
        nodes: [
          { nodeId: 'root', childIds: ['button'] },
          {
            nodeId: 'button',
            role: { value: 'button' },
            name: { value: 'Submit' },
            backendDOMNodeId: 91,
          },
        ],
      })
      .mockResolvedValueOnce(
        FRAME_TREE_LOADER_1,
      )
      .mockResolvedValueOnce({ object: { objectId: 'object-91' } })
      .mockResolvedValueOnce({
        result: { value: { success: true, tag: 'BUTTON', text: 'Submit' } },
      });
    const { executeWebBridgeAction } = await loadActions();

    const snapshot = await executeWebBridgeAction('snapshot', { _tabId: 17 });
    expect(snapshot).toMatchObject({
      tree: [{ role: 'button', name: 'Submit', ref: '@e1' }],
    });
    await expect(
      executeWebBridgeAction('click', { selector: '@e1', _tabId: 17 }),
    ).resolves.toMatchObject({ success: true, tag: 'BUTTON' });
    expect(cdp.send).toHaveBeenNthCalledWith(4, 'DOM.resolveNode', {
      backendNodeId: 91,
    });

    await executeWebBridgeAction('navigate', {
      url: 'https://example.test/next',
      _tabId: 17,
    });
    await expect(
      executeWebBridgeAction('click', { selector: '@e1', _tabId: 17 }),
    ).rejects.toThrow('Run snapshot first');
  });

  it('keeps snapshot refs isolated by session on a shared tab', async () => {
    const nodes = (backendDOMNodeId: number) => ({
      nodes: [
        { nodeId: 'root', childIds: ['button'] },
        {
          nodeId: 'button',
          role: { value: 'button' },
          name: { value: 'Submit' },
          backendDOMNodeId,
        },
      ],
    });
    cdp.send
      .mockResolvedValueOnce(FRAME_TREE_LOADER_1)
      .mockResolvedValueOnce(nodes(91))
      .mockResolvedValueOnce(FRAME_TREE_LOADER_1)
      .mockResolvedValueOnce(nodes(55))
      .mockResolvedValueOnce(FRAME_TREE_LOADER_1)
      .mockResolvedValueOnce({ object: { objectId: 'object-91' } })
      .mockResolvedValueOnce({ result: { value: { success: true } } });
    const { executeWebBridgeAction } = await loadActions();

    await executeWebBridgeAction('snapshot', {
      _session: 'one',
      _tabId: 17,
    });
    await executeWebBridgeAction('snapshot', {
      _session: 'two',
      _tabId: 17,
    });
    await executeWebBridgeAction('click', {
      _session: 'one',
      selector: '@e1',
      _tabId: 17,
    });

    expect(cdp.send).toHaveBeenNthCalledWith(6, 'DOM.resolveNode', {
      backendNodeId: 91,
    });
  });

  it('continues ref numbering across re-snapshots so stale refs stay unknown', async () => {
    let backendNodeId = 91;
    cdp.send.mockImplementation(async (method: string) => {
      if (method === 'Page.getFrameTree') return FRAME_TREE_LOADER_1;
      if (method === 'Accessibility.getFullAXTree') {
        return {
          nodes: [
            { nodeId: 'root', childIds: ['button'] },
            {
              nodeId: 'button',
              role: { value: 'button' },
              name: { value: 'Submit' },
              backendDOMNodeId: backendNodeId,
            },
          ],
        };
      }
      return {};
    });
    const { executeWebBridgeAction } = await loadActions();

    const first = await executeWebBridgeAction('snapshot', {
      _tabId: 17,
      _session: 'research',
    });
    expect(first).toMatchObject({
      tree: [{ role: 'button', name: 'Submit', ref: '@e1' }],
    });
    backendNodeId = 92;
    const second = await executeWebBridgeAction('snapshot', {
      _tabId: 17,
      _session: 'research',
    });
    expect(second).toMatchObject({
      tree: [{ role: 'button', name: 'Submit', ref: '@e2' }],
    });

    await expect(
      executeWebBridgeAction('click', {
        selector: '@e1',
        _tabId: 17,
        _session: 'research',
      }),
    ).rejects.toThrow('unknown ref');
  });

  it('never re-issues ref numbers from earlier snapshots (high-water numbering)', async () => {
    // snap1 issues @e1..@e5, snap2 issues @e6; snap3 must continue from the
    // highest number EVER issued (@e7..@e9). Continuing from only the
    // previous snapshot's COUNT would re-issue @e2..@e4 — colliding with
    // snap1 refs the agent may still hold inside the same document, where
    // the loaderId guard cannot fire.
    let buttons = 5;
    cdp.send.mockImplementation(async (method: string) => {
      if (method === 'Page.getFrameTree') return FRAME_TREE_LOADER_1;
      if (method === 'Accessibility.getFullAXTree') {
        const nodes: Array<Record<string, unknown>> = [
          {
            nodeId: 'root',
            childIds: Array.from({ length: buttons }, (_, i) => `button-${i}`),
          },
        ];
        for (let i = 0; i < buttons; i++) {
          nodes.push({
            nodeId: `button-${i}`,
            role: { value: 'button' },
            name: { value: `Button ${i}` },
            backendDOMNodeId: 100 + i,
          });
        }
        return { nodes };
      }
      return {};
    });
    const { executeWebBridgeAction } = await loadActions();

    const first = (await executeWebBridgeAction('snapshot', {
      _tabId: 17,
      _session: 'research',
    })) as { tree: Array<{ ref?: string }> };
    expect(first.tree).toHaveLength(5);

    buttons = 1;
    const second = await executeWebBridgeAction('snapshot', {
      _tabId: 17,
      _session: 'research',
    });
    expect(second).toMatchObject({ tree: [{ ref: '@e6' }] });

    buttons = 3;
    const third = (await executeWebBridgeAction('snapshot', {
      _tabId: 17,
      _session: 'research',
    })) as { tree: Array<{ ref?: string }> };
    expect(third.tree.map((node) => node.ref)).toEqual([
      '@e7',
      '@e8',
      '@e9',
    ]);
  });

  it('fails ref resolution closed when the page navigated after the snapshot', async () => {
    let loaderId = 'loader-1';
    cdp.send.mockImplementation(async (method: string) => {
      if (method === 'Page.getFrameTree') {
        return { frameTree: { frame: { id: 'frame-1', loaderId } } };
      }
      if (method === 'Accessibility.getFullAXTree') {
        return {
          nodes: [
            { nodeId: 'root', childIds: ['button'] },
            {
              nodeId: 'button',
              role: { value: 'button' },
              name: { value: 'Submit' },
              backendDOMNodeId: 91,
            },
          ],
        };
      }
      return {};
    });
    const { executeWebBridgeAction } = await loadActions();

    await executeWebBridgeAction('snapshot', { _tabId: 17, _session: 'one' });
    loaderId = 'loader-2';

    await expect(
      executeWebBridgeAction('click', {
        selector: '@e1',
        _tabId: 17,
        _session: 'one',
      }),
    ).rejects.toThrow('Page changed, run snapshot first');
  });

  it('matches host:port requests by port, not hostname only', async () => {
    (
      chrome.tabs.get as unknown as ReturnType<typeof vi.fn>
    ).mockImplementation(async (tabId: number) => ({
      id: tabId,
      url: 'http://localhost:3000/',
      title: 'Dev server',
      status: 'complete',
      groupId: -1,
    }));
    const { executeWebBridgeAction } = await loadActions();

    await expect(
      executeWebBridgeAction('find_tab', {
        url: 'localhost:9222',
        _session: 'research',
        _tabIds: [17],
      }),
    ).rejects.toThrow('no tab matching localhost:9222');
  });

  it('matches host:port/path requests against same-origin tabs', async () => {
    (
      chrome.tabs.get as unknown as ReturnType<typeof vi.fn>
    ).mockImplementation(async (tabId: number) => ({
      id: tabId,
      url: 'https://example.com:8080/path/page',
      title: 'Example',
      status: 'complete',
      groupId: -1,
    }));
    const { executeWebBridgeAction } = await loadActions();

    await expect(
      executeWebBridgeAction('find_tab', {
        url: 'example.com:8080/path',
        _session: 'research',
        _tabIds: [17],
      }),
    ).resolves.toMatchObject({ tabId: 17 });
  });

  it('matches about:blank tabs in find_tab', async () => {
    (chrome.tabs.get as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 17,
      url: 'about:blank',
      title: '',
      index: 0,
      groupId: -1,
    });
    const { executeWebBridgeAction } = await loadActions();

    await expect(
      executeWebBridgeAction('find_tab', {
        url: 'about:blank',
        _session: 'research',
        _tabIds: [17],
      }),
    ).resolves.toMatchObject({ success: true, tabId: 17 });
  });

  it('dispatches a trusted mouse click at the element center', async () => {
    cdp.send
      .mockResolvedValueOnce({ result: { objectId: 'button-1' } })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        model: { content: [10, 20, 30, 20, 30, 40, 10, 40] },
      })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ result: { value: { tag: 'BUTTON' } } });
    const { executeWebBridgeAction } = await loadActions();

    await expect(
      executeWebBridgeAction('mouse_click', {
        selector: '#submit',
        _tabId: 17,
      }),
    ).resolves.toMatchObject({ success: true, x: 20, y: 30 });
    expect(cdp.send).toHaveBeenCalledWith(
      'Input.dispatchMouseEvent',
      expect.objectContaining({ type: 'mousePressed', x: 20, y: 30 }),
    );
    // Coordinates are sampled after the scroll: it must not be a smooth
    // animation still in flight when getBoxModel measures the box.
    expect(cdp.send).toHaveBeenCalledWith(
      'Runtime.callFunctionOn',
      expect.objectContaining({
        functionDeclaration: expect.stringContaining("behavior: 'instant'"),
      }),
    );
  });

  it('keeps a delivered mouse click successful if navigation clears metadata', async () => {
    cdp.send
      .mockResolvedValueOnce({ result: { objectId: 'button-1' } })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        model: { content: [10, 20, 30, 20, 30, 40, 10, 40] },
      })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(
        new Error('Cannot find context with specified id'),
      );
    const { executeWebBridgeAction } = await loadActions();

    await expect(
      executeWebBridgeAction('mouse_click', {
        selector: '#submit',
        _tabId: 17,
      }),
    ).resolves.toMatchObject({ success: true, x: 20, y: 30 });
  });

  it('retries mouse release without replacing the original error', async () => {
    cdp.send
      .mockResolvedValueOnce({ result: { objectId: 'button-1' } })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        model: { content: [10, 20, 30, 20, 30, 40, 10, 40] },
      })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('release failed'))
      .mockResolvedValueOnce({});
    const { executeWebBridgeAction } = await loadActions();

    await expect(
      executeWebBridgeAction('mouse_click', {
        selector: '#submit',
        _tabId: 17,
      }),
    ).rejects.toThrow('release failed');
    expect(cdp.send).toHaveBeenCalledTimes(7);
  });

  it('rejects mouse clicks on zero-size elements', async () => {
    cdp.send
      .mockResolvedValueOnce({ result: { objectId: 'button-1' } })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        model: { content: [10, 20, 10, 20, 10, 20, 10, 20] },
      });
    const { executeWebBridgeAction } = await loadActions();

    await expect(
      executeWebBridgeAction('mouse_click', {
        selector: '#submit',
        _tabId: 17,
      }),
    ).rejects.toThrow('mouse_click: element has zero-size box');
  });

  it('dispatches the shifted character for shift+<digit>', async () => {
    cdp.send.mockResolvedValue({});
    const { executeWebBridgeAction } = await loadActions();

    await executeWebBridgeAction('send_keys', {
      keys: 'shift+1',
      _tabId: 17,
    });

    expect(cdp.send).toHaveBeenCalledWith(
      'Input.dispatchKeyEvent',
      expect.objectContaining({ type: 'keyDown', key: '!', text: '!' }),
    );
  });

  it('maps Mod to Meta on macOS and sends key down/up events', async () => {
    cdp.send.mockResolvedValue({});
    const { executeWebBridgeAction } = await loadActions();

    await expect(
      executeWebBridgeAction('send_keys', {
        keys: 'Mod+A Enter',
        _tabId: 17,
      }),
    ).resolves.toMatchObject({ success: true, dispatched: 2, os: 'mac' });
    expect(cdp.send).toHaveBeenCalledWith(
      'Input.dispatchKeyEvent',
      expect.objectContaining({ type: 'rawKeyDown', key: 'Meta' }),
    );
    expect(cdp.send).toHaveBeenCalledWith(
      'Input.dispatchKeyEvent',
      expect.objectContaining({ key: 'a', commands: ['selectAll'] }),
    );
    expect(cdp.send).toHaveBeenCalledWith(
      'Input.dispatchKeyEvent',
      expect.objectContaining({ type: 'keyDown', key: 'Enter' }),
    );
  });

  it('rejects key_type without a focused editable element', async () => {
    cdp.send.mockResolvedValueOnce({ result: { value: false } });
    const { executeWebBridgeAction } = await loadActions();

    await expect(
      executeWebBridgeAction('key_type', { text: 'hello', _tabId: 17 }),
    ).rejects.toThrow('key_type: no focused editable element');
    expect(cdp.send).not.toHaveBeenCalledWith('Input.insertText', {
      text: 'hello',
    });
  });

  it('releases pressed modifiers when a key event fails', async () => {
    cdp.send
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('tab closed'))
      .mockResolvedValueOnce({});
    const { executeWebBridgeAction } = await loadActions();

    await expect(
      executeWebBridgeAction('send_keys', { keys: 'Mod+A', _tabId: 17 }),
    ).rejects.toThrow('tab closed');
    expect(cdp.send).toHaveBeenLastCalledWith(
      'Input.dispatchKeyEvent',
      expect.objectContaining({ type: 'keyUp', key: 'Meta' }),
    );
  });

  it('rejects oversized send_keys before dispatching', async () => {
    const { executeWebBridgeAction } = await loadActions();

    await expect(
      executeWebBridgeAction('send_keys', {
        keys: 'a'.repeat(1025),
        _tabId: 17,
      }),
    ).rejects.toThrow('send_keys: too many keys');

    await expect(
      executeWebBridgeAction('send_keys', {
        keys: Array.from({ length: 400 }, () => 'a').join(' '),
        _tabId: 17,
      }),
    ).rejects.toThrow('send_keys: too many keys');
    expect(cdp.send).not.toHaveBeenCalledWith(
      'Input.dispatchKeyEvent',
      expect.anything(),
    );
  });

  it('keeps a successful action result when idle-tab release fails', async () => {
    cdp.send.mockResolvedValue({ nodes: [] });
    cdp.release.mockRejectedValueOnce(new Error('tab gone'));
    const { executeWebBridgeAction } = await loadActions();

    await expect(
      executeWebBridgeAction('snapshot', { _tabId: 17, _session: 'research' }),
    ).resolves.toMatchObject({ url: 'https://example.test' });
  });

  it('retries releasing the main key before releasing modifiers', async () => {
    cdp.send
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('key up failed'))
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});
    const { executeWebBridgeAction } = await loadActions();

    await expect(
      executeWebBridgeAction('send_keys', { keys: 'Mod+A', _tabId: 17 }),
    ).rejects.toThrow('key up failed');
    expect(cdp.send).toHaveBeenNthCalledWith(
      4,
      'Input.dispatchKeyEvent',
      expect.objectContaining({ type: 'keyUp', key: 'a' }),
    );
    expect(cdp.send).toHaveBeenLastCalledWith(
      'Input.dispatchKeyEvent',
      expect.objectContaining({ type: 'keyUp', key: 'Meta' }),
    );
  });

  it('captures network metadata and reads the response body', async () => {
    cdp.send
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ body: '{"ok":true}', base64Encoded: false });
    const { executeWebBridgeAction } = await loadActions();

    await executeWebBridgeAction('network', {
      cmd: 'start',
      _tabId: 17,
      _session: 'research',
    });
    const listener = cdp.listeners[0];
    listener(
      'Network.requestWillBeSent',
      {
        requestId: 'request-1',
        request: { url: 'https://example.test/api', method: 'GET' },
      },
      17,
    );
    listener(
      'Network.responseReceived',
      {
        requestId: 'request-1',
        response: { status: 200, mimeType: 'application/json' },
      },
      17,
    );
    listener('Network.loadingFinished', { requestId: 'request-1' }, 17);

    await expect(
      executeWebBridgeAction('network', {
        cmd: 'list',
        filter: '/api',
        _tabId: 17,
        _session: 'research',
      }),
    ).resolves.toMatchObject({
      count: 1,
      requests: [{ requestId: 'request-1', status: 200, completed: true }],
    });
    await expect(
      executeWebBridgeAction('network', {
        cmd: 'detail',
        requestId: 'request-1',
        _tabId: 17,
        _session: 'research',
      }),
    ).resolves.toMatchObject({ body: { ok: true } });
  });

  it('marks failed network requests complete', async () => {
    cdp.send.mockResolvedValueOnce({});
    const { executeWebBridgeAction } = await loadActions();

    await executeWebBridgeAction('network', {
      cmd: 'start',
      _tabId: 17,
      _session: 'research',
    });
    const listener = cdp.listeners[0];
    listener(
      'Network.requestWillBeSent',
      {
        requestId: 'request-1',
        request: { url: 'https://missing.example.test', method: 'GET' },
      },
      17,
    );
    listener(
      'Network.loadingFailed',
      { requestId: 'request-1', errorText: 'net::ERR_NAME_NOT_RESOLVED' },
      17,
    );

    await expect(
      executeWebBridgeAction('network', {
        cmd: 'list',
        _tabId: 17,
        _session: 'research',
      }),
    ).resolves.toMatchObject({
      requests: [
        {
          requestId: 'request-1',
          completed: true,
          failed: true,
          errorText: 'net::ERR_NAME_NOT_RESOLVED',
        },
      ],
    });
    await expect(
      executeWebBridgeAction('network', {
        cmd: 'detail',
        requestId: 'request-1',
        _tabId: 17,
        _session: 'research',
      }),
    ).resolves.toMatchObject({ failed: true });
    expect(cdp.withTab).toHaveBeenCalledTimes(1);
  });

  it('removes the global network listener when capture stops', async () => {
    cdp.send.mockResolvedValue({});
    const { executeWebBridgeAction } = await loadActions();

    await executeWebBridgeAction('network', {
      cmd: 'start',
      _tabId: 17,
      _session: 'research',
    });
    await executeWebBridgeAction('network', {
      cmd: 'stop',
      _tabId: 17,
      _session: 'research',
    });

    expect(cdp.unsubscribe).toHaveBeenCalledOnce();
  });

  it('stops a session capture after the current tab changes', async () => {
    cdp.send.mockResolvedValue({});
    const { executeWebBridgeAction } = await loadActions();

    await executeWebBridgeAction('network', {
      cmd: 'start',
      _tabId: 17,
      _session: 'research',
    });
    await executeWebBridgeAction('network', {
      cmd: 'stop',
      _tabId: 18,
      _session: 'research',
    });

    expect(cdp.withTab).toHaveBeenLastCalledWith(17, expect.any(Function));
    expect(cdp.unsubscribe).toHaveBeenCalledOnce();
  });

  it('lists a running capture after the current tab changes', async () => {
    cdp.send.mockResolvedValue({});
    const { executeWebBridgeAction } = await loadActions();

    await executeWebBridgeAction('network', {
      cmd: 'start',
      _tabId: 17,
      _session: 'research',
    });
    cdp.listeners[0](
      'Network.requestWillBeSent',
      {
        requestId: 'captured-request',
        request: { url: 'https://example.test/api', method: 'GET' },
      },
      17,
    );

    await expect(
      executeWebBridgeAction('network', {
        cmd: 'list',
        _tabId: 18,
        _session: 'research',
      }),
    ).resolves.toMatchObject({ count: 1 });
  });

  it('invalidates network captures when Chrome detaches the debugger', async () => {
    cdp.send.mockResolvedValue({});
    const { executeWebBridgeAction } = await loadActions();
    await executeWebBridgeAction('network', {
      cmd: 'start',
      _tabId: 17,
      _session: 'research',
    });
    cdp.listeners[0](
      'Network.requestWillBeSent',
      {
        requestId: 'stale-request',
        request: { url: 'https://example.test/api', method: 'GET' },
      },
      17,
    );

    cdp.detachListeners[0](17);

    // The lost capture must surface, not masquerade as an empty capture.
    await expect(
      executeWebBridgeAction('network', {
        cmd: 'list',
        _tabId: 17,
        _session: 'research',
      }),
    ).rejects.toThrow('capture was invalidated by a debugger detach');
    await expect(
      executeWebBridgeAction('network', {
        cmd: 'stop',
        _tabId: 17,
        _session: 'research',
      }),
    ).rejects.toThrow('capture was invalidated by a debugger detach');
    expect(cdp.unsubscribe).toHaveBeenCalledOnce();
  });

  it('keeps recorded requests when network start is called twice', async () => {
    cdp.send.mockResolvedValue({});
    const { executeWebBridgeAction } = await loadActions();
    await executeWebBridgeAction('network', {
      cmd: 'start',
      _tabId: 17,
      _session: 'research',
    });
    cdp.listeners[0](
      'Network.requestWillBeSent',
      {
        requestId: 'captured-request',
        request: { url: 'https://example.test/api', method: 'GET' },
      },
      17,
    );

    const secondStart = await executeWebBridgeAction('network', {
      cmd: 'start',
      _tabId: 17,
      _session: 'research',
    });
    expect(secondStart).toMatchObject({
      success: true,
      message: 'network capture already running',
    });

    await expect(
      executeWebBridgeAction('network', {
        cmd: 'list',
        _tabId: 17,
        _session: 'research',
      }),
    ).resolves.toMatchObject({ count: 1 });
  });

  it('merges captures across the session tabs for list and detail', async () => {
    cdp.send.mockResolvedValue({ body: '"ok"', base64Encoded: false });
    (
      chrome.tabs.get as unknown as ReturnType<typeof vi.fn>
    ).mockImplementation(async (tabId: number) => ({
      id: tabId,
      url: `https://example.test/${tabId}`,
      title: 'Example',
      status: 'complete',
      groupId: -1,
    }));
    const { executeWebBridgeAction } = await loadActions();
    await executeWebBridgeAction('network', {
      cmd: 'start',
      _tabId: 17,
      _session: 'research',
    });
    await executeWebBridgeAction('network', {
      cmd: 'start',
      _tabId: 18,
      _session: 'research',
    });
    cdp.listeners[0](
      'Network.requestWillBeSent',
      {
        requestId: 'req-A',
        request: { url: 'https://a.example.test', method: 'GET' },
      },
      17,
    );
    cdp.listeners[0](
      'Network.requestWillBeSent',
      {
        requestId: 'req-B',
        request: { url: 'https://b.example.test', method: 'GET' },
      },
      18,
    );

    await expect(
      executeWebBridgeAction('network', {
        cmd: 'list',
        _tabId: 19,
        _session: 'research',
      }),
    ).resolves.toMatchObject({ count: 2 });
    await expect(
      executeWebBridgeAction('network', {
        cmd: 'detail',
        requestId: 'req-B',
        _tabId: 19,
        _session: 'research',
      }),
    ).resolves.toMatchObject({ requestId: 'req-B', body: 'ok' });
  });

  it('stops remaining captures when one tab attach fails', async () => {
    cdp.send.mockResolvedValue({});
    const { executeWebBridgeAction } = await loadActions();
    await executeWebBridgeAction('network', {
      cmd: 'start',
      _tabId: 17,
      _session: 'research',
    });
    await executeWebBridgeAction('network', {
      cmd: 'start',
      _tabId: 18,
      _session: 'research',
    });

    cdp.withTab.mockImplementation(
      async (
        tabId: number,
        operation: (
          send: (
            method: string,
            params?: Record<string, unknown>,
          ) => unknown,
        ) => Promise<unknown>,
      ) => {
        if (tabId === 17) {
          throw new Error('debugger attach failed: tab gone');
        }
        return operation(cdp.send);
      },
    );

    await expect(
      executeWebBridgeAction('network', {
        cmd: 'stop',
        _tabId: 18,
        _session: 'research',
      }),
    ).resolves.toMatchObject({ success: true });
    // Both captures are gone: a follow-up list sees no capture at all.
    await expect(
      executeWebBridgeAction('network', {
        cmd: 'list',
        _tabId: 18,
        _session: 'research',
      }),
    ).resolves.toMatchObject({ count: 0 });
  });

  it('rolls back capture state when Network.enable fails', async () => {
    cdp.send
      .mockRejectedValueOnce(new Error('debugger detached'))
      .mockResolvedValueOnce({});
    const { executeWebBridgeAction } = await loadActions();

    await expect(
      executeWebBridgeAction('network', {
        cmd: 'start',
        _tabId: 17,
        _session: 'research',
      }),
    ).rejects.toThrow('debugger detached');
    expect(cdp.unsubscribe).toHaveBeenCalledOnce();

    await executeWebBridgeAction('network', {
      cmd: 'start',
      _tabId: 17,
      _session: 'research',
    });
    expect(cdp.subscribe).toHaveBeenCalledTimes(2);
  });

  it('requires an explicitly selected session tab', async () => {
    const { executeWebBridgeAction } = await loadActions();

    await expect(executeWebBridgeAction('snapshot', {})).rejects.toThrow(
      'No current tab for this session',
    );
    expect(chrome.tabs.query).not.toHaveBeenCalled();
  });

  it('reports a closed current tab with an actionable error', async () => {
    (chrome.tabs.get as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('No tab with id: 17'),
    );
    const { executeWebBridgeAction } = await loadActions();

    await expect(
      executeWebBridgeAction('snapshot', { _tabId: 17 }),
    ).rejects.toThrow('No active tab found');
  });

  it('bounds captured network request metadata', async () => {
    cdp.send.mockResolvedValue({});
    const { executeWebBridgeAction } = await loadActions();
    await executeWebBridgeAction('network', {
      cmd: 'start',
      _tabId: 17,
      _session: 'research',
    });
    const listener = cdp.listeners[0];

    for (let index = 0; index <= 2_000; index++) {
      listener(
        'Network.requestWillBeSent',
        {
          requestId: `request-${index}`,
          request: { url: `https://example.test/${index}`, method: 'GET' },
        },
        17,
      );
    }

    await expect(
      executeWebBridgeAction('network', {
        cmd: 'list',
        _tabId: 17,
        _session: 'research',
      }),
    ).resolves.toMatchObject({ count: 2_000 });
  });

  it('bounds retained network captures', async () => {
    cdp.send.mockResolvedValue({});
    const { executeWebBridgeAction } = await loadActions();

    for (let index = 0; index < 32; index++) {
      await executeWebBridgeAction('network', {
        cmd: 'start',
        _tabId: 17,
        _session: `session-${index}`,
      });
    }
    await expect(
      executeWebBridgeAction('network', {
        cmd: 'start',
        _tabId: 17,
        _session: 'overflow',
      }),
    ).rejects.toThrow('capture limit reached');
  });

  it('isolates network captures by session on a shared tab', async () => {
    cdp.send.mockResolvedValue({});
    const { executeWebBridgeAction } = await loadActions();
    await executeWebBridgeAction('network', {
      cmd: 'start',
      _tabId: 17,
      _session: 'one',
    });
    cdp.listeners[0](
      'Network.requestWillBeSent',
      {
        requestId: 'private-request',
        request: { url: 'https://example.test/private', method: 'GET' },
      },
      17,
    );
    await executeWebBridgeAction('network', {
      cmd: 'start',
      _tabId: 17,
      _session: 'two',
    });

    await expect(
      executeWebBridgeAction('network', {
        cmd: 'list',
        _tabId: 17,
        _session: 'two',
      }),
    ).resolves.toMatchObject({ count: 0 });
    await expect(
      executeWebBridgeAction('network', {
        cmd: 'list',
        _tabId: 17,
        _session: 'one',
      }),
    ).resolves.toMatchObject({ count: 1 });
  });

  it('releases a borrowed tab without closing it when the session closes', async () => {
    (
      chrome.windows.getLastFocused as unknown as ReturnType<typeof vi.fn>
    ).mockResolvedValue({
      tabs: [{ id: 17, active: true, url: 'https://example.test' }],
    });
    const { executeWebBridgeAction } = await loadActions();
    await executeWebBridgeAction('find_tab', {
      url: 'https://example.test',
      active: true,
      _session: 'borrower',
    });

    await executeWebBridgeAction('close_session', {
      _session: 'borrower',
      _tabIds: [],
    });

    expect(chrome.tabs.remove).not.toHaveBeenCalled();
    expect(cdp.release).toHaveBeenCalledWith(17);
  });

  it('does not close a tab another session is using', async () => {
    (
      chrome.windows.getLastFocused as unknown as ReturnType<typeof vi.fn>
    ).mockResolvedValue({
      tabs: [{ id: 17, active: true, url: 'https://example.test' }],
    });
    const { executeWebBridgeAction } = await loadActions();
    await executeWebBridgeAction('navigate', {
      url: 'https://example.test',
      newTab: true,
      _session: 'owner',
    });
    await executeWebBridgeAction('find_tab', {
      url: 'https://example.test',
      active: true,
      _session: 'borrower',
    });

    await expect(
      executeWebBridgeAction('close_tab', {
        _session: 'owner',
        _tabId: 17,
        _tabIds: [17],
      }),
    ).resolves.toEqual({
      success: false,
      closed: false,
      reason: 'tab is used by another session',
    });
    expect(chrome.tabs.remove).not.toHaveBeenCalled();
  });

  it('releases a borrowed current tab after extension state is lost', async () => {
    cdp.send.mockResolvedValue({ nodes: [] });
    const { executeWebBridgeAction } = await loadActions();

    await executeWebBridgeAction('snapshot', {
      _session: 'borrower',
      _tabId: 17,
      _tabIds: [],
    });
    expect(cdp.release).toHaveBeenCalledWith(17);
    cdp.release.mockClear();

    await executeWebBridgeAction('close_session', {
      _session: 'borrower',
      _tabId: 17,
      _tabIds: [],
    });
    expect(chrome.tabs.remove).not.toHaveBeenCalled();
    expect(cdp.release).toHaveBeenCalledWith(17);
  });

  it('prefers an exact URL when multiple session tabs share a host', async () => {
    (chrome.tabs.get as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async (tabId: number) => ({
        id: tabId,
        url:
          tabId === 17
            ? 'https://example.test/inbox'
            : 'https://example.test/settings',
      }),
    );
    const { executeWebBridgeAction } = await loadActions();

    await expect(
      executeWebBridgeAction('find_tab', {
        url: 'https://example.test/settings',
        _session: 'research',
        _tabIds: [17, 18],
      }),
    ).resolves.toMatchObject({ tabId: 18 });
    expect(cdp.withTab).toHaveBeenCalledWith(18, expect.any(Function));
  });

  it('selects the leftmost tab when exact URLs are duplicated', async () => {
    (chrome.tabs.get as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async (tabId: number) => ({
        id: tabId,
        index: tabId === 17 ? 8 : 2,
        url: 'https://example.test/settings',
      }),
    );
    const { executeWebBridgeAction } = await loadActions();

    await expect(
      executeWebBridgeAction('find_tab', {
        url: 'https://example.test/settings',
        _session: 'research',
        _tabIds: [17, 18],
      }),
    ).resolves.toMatchObject({ tabId: 18 });
  });

  it('does not fall back to another path for a full URL', async () => {
    (chrome.tabs.get as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 17,
      url: 'https://example.test/inbox',
    });
    const { executeWebBridgeAction } = await loadActions();

    await expect(
      executeWebBridgeAction('find_tab', {
        url: 'https://example.test/settings',
        _session: 'research',
        _tabIds: [17],
      }),
    ).rejects.toThrow('no tab matching');
  });

  it.each([
    ['https://example.test/*', 'https://example.test/inbox'],
    ['*://*.example.test/*', 'https://app.example.test/inbox'],
  ])('finds tabs with host pattern %s', async (url, actual) => {
    (chrome.tabs.get as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 17,
      url: actual,
    });
    const { executeWebBridgeAction } = await loadActions();

    await expect(
      executeWebBridgeAction('find_tab', {
        url,
        _session: 'research',
        _tabIds: [17],
      }),
    ).resolves.toMatchObject({ tabId: 17 });
  });

  it('returns screenshot and PDF bytes for daemon-side persistence', async () => {
    cdp.send
      .mockResolvedValueOnce({ data: 'cG5n' })
      .mockResolvedValueOnce({ data: 'cGRm' })
      .mockResolvedValueOnce({ result: { value: 'Example' } });
    const { executeWebBridgeAction } = await loadActions();

    await expect(
      executeWebBridgeAction('screenshot', { format: 'png', _tabId: 17 }),
    ).resolves.toEqual({ format: 'png', dataLength: 4, data: 'cG5n' });
    await expect(
      executeWebBridgeAction('save_as_pdf', {
        paper_format: 'a4',
        _tabId: 17,
      }),
    ).resolves.toMatchObject({ data: 'cGRm', pageTitle: 'Example' });
    expect(cdp.send).toHaveBeenCalledWith(
      'Page.printToPDF',
      expect.objectContaining({
        paperWidth: 8.27,
        paperHeight: 11.69,
        preferCSSPageSize: false,
      }),
    );
  });

  it('caps page-controlled pageTitle in the PDF metadata frame', async () => {
    // document.title is page-controlled and rides the unchunked metadata
    // frame; an uncapped multi-MiB title would exceed the daemon's WS
    // maxPayload and drop the bridge for every session.
    cdp.send
      .mockResolvedValueOnce({ data: 'cGRm' })
      .mockResolvedValueOnce({ result: { value: 't'.repeat(4096) } });
    const { executeWebBridgeAction } = await loadActions();

    const result = (await executeWebBridgeAction('save_as_pdf', {
      _tabId: 17,
    })) as { pageTitle: string };

    expect(result.pageTitle).toHaveLength(1024);
  });

  it('captures element screenshots in document coordinates', async () => {
    cdp.send
      .mockResolvedValueOnce({ result: { objectId: 'button-1' } })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        model: { border: [10, 20, 30, 20, 30, 60, 10, 60] },
      })
      .mockResolvedValueOnce({ cssVisualViewport: { pageX: 4, pageY: 300 } })
      .mockResolvedValueOnce({ data: 'cG5n' });
    const { executeWebBridgeAction } = await loadActions();

    await expect(
      executeWebBridgeAction('screenshot', {
        format: 'png',
        selector: '#submit',
        _tabId: 17,
      }),
    ).resolves.toMatchObject({ data: 'cG5n' });
    expect(cdp.send).toHaveBeenCalledWith('Page.captureScreenshot', {
      format: 'png',
      clip: { x: 14, y: 320, width: 20, height: 40, scale: 1 },
    });
  });

  it('releases a session without closing its owned tabs', async () => {
    const { executeWebBridgeAction } = await loadActions();
    await executeWebBridgeAction('navigate', {
      url: 'https://example.test',
      newTab: true,
      _session: 'research',
    });
    cdp.release.mockClear();

    await expect(
      executeWebBridgeAction('close_session', {
        close_tabs: false,
        _session: 'research',
        _tabIds: [17],
      }),
    ).resolves.toEqual({ success: true, closed: 0, released: 1 });
    expect(chrome.tabs.remove).not.toHaveBeenCalled();
    expect(cdp.release).toHaveBeenCalledWith(17);
  });

  it('handles tab-removal failures without leaking attachment state', async () => {
    const remove = chrome.tabs.remove as unknown as ReturnType<typeof vi.fn>;
    remove.mockRejectedValue(new Error('Tabs cannot be edited right now'));
    const { executeWebBridgeAction } = await loadActions();

    await expect(
      executeWebBridgeAction('close_tab', {
        _session: 'research',
        _tabId: 17,
        _tabIds: [17],
      }),
    ).rejects.toThrow('Tabs cannot be edited right now');
    expect(cdp.release).not.toHaveBeenCalled();

    await expect(
      executeWebBridgeAction('close_session', {
        _session: 'research',
        _tabId: 17,
        _tabIds: [17],
      }),
    ).rejects.toThrow('Tabs cannot be edited right now');
    expect(cdp.release).not.toHaveBeenCalled();
  });

  it('uploads files through DOM.setFileInputFiles', async () => {
    cdp.send
      .mockResolvedValueOnce({ root: { nodeId: 1 } })
      .mockResolvedValueOnce({ nodeId: 2 })
      .mockResolvedValueOnce({});
    const { executeWebBridgeAction } = await loadActions();

    await expect(
      executeWebBridgeAction('upload', {
        selector: 'input[type=file]',
        files: ['/tmp/example.txt'],
        _tabId: 17,
      }),
    ).resolves.toEqual({ success: true, fileCount: 1 });
    expect(cdp.send).toHaveBeenLastCalledWith('DOM.setFileInputFiles', {
      files: ['/tmp/example.txt'],
      nodeId: 2,
    });
  });

  it('lists and closes only session-owned tabs', async () => {
    const { executeWebBridgeAction } = await loadActions();

    await expect(
      executeWebBridgeAction('list_tabs', { _tabIds: [17] }),
    ).resolves.toMatchObject({ tabs: [{ tabId: 17 }] });
    await expect(
      executeWebBridgeAction('close_session', {
        _tabIds: [17, 18],
        _session: 'research',
      }),
    ).resolves.toEqual({ success: true, closed: 2 });
    expect(chrome.tabs.remove).toHaveBeenCalledTimes(2);
  });
});
