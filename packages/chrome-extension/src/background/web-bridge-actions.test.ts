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
      return () => undefined;
    },
  ),
}));

vi.mock('./cdp-bridge', () => ({
  withCdpTab: cdp.withTab,
  releaseCdpTab: cdp.release,
  subscribeCdpEvents: cdp.subscribe,
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

describe('WebBridge actions', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    cdp.listeners.length = 0;
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

  it('creates stable snapshot refs and clicks them through DOM.resolveNode', async () => {
    cdp.send
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
    expect(cdp.send).toHaveBeenNthCalledWith(2, 'DOM.resolveNode', {
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

  it('requires an explicitly selected session tab', async () => {
    const { executeWebBridgeAction } = await loadActions();

    await expect(executeWebBridgeAction('snapshot', {})).rejects.toThrow(
      'No current tab for this session',
    );
    expect(chrome.tabs.query).not.toHaveBeenCalled();
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
      executeWebBridgeAction('save_as_pdf', { _tabId: 17 }),
    ).resolves.toMatchObject({ data: 'cGRm', pageTitle: 'Example' });
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
    ).resolves.toMatchObject({ success: true, fileCount: 1 });
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
