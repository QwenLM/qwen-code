/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment node

import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { afterEach, expect, test, vi } from 'vitest';

const source = await readFile(
  new URL('./browser-use-bridge.js', import.meta.url),
  'utf8',
);
afterEach(() => vi.useRealTimers());

async function fixture(
  alarms = new Map<string, chrome.alarms.AlarmCreateInfo>(),
) {
  vi.useFakeTimers();
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const event = (name: string) => ({
    addListener: (listener: (...args: unknown[]) => void) =>
      listeners.set(name, listener),
  });
  const emit = (name: string, ...args: unknown[]) =>
    listeners.get(name)?.(...args);
  const tabs = new Map<number, Record<string, unknown>>([
    [1, { id: 1, url: 'https://example.test', windowId: 1, groupId: -1 }],
  ]);
  const attached = new Set<number>();
  const saved: Record<string, unknown> = {};
  const port = {
    onMessage: event('message'),
    onDisconnect: event('disconnect'),
    postMessage: vi.fn(),
    disconnect: vi.fn(),
  };
  const chromeApi = {
    runtime: { id: 'extension-id', connectNative: vi.fn(() => port) },
    alarms: {
      onAlarm: event('alarm'),
      create: vi.fn(
        async (name: string, info: chrome.alarms.AlarmCreateInfo) => {
          alarms.set(name, info);
        },
      ),
      get: vi.fn(async (name: string) => alarms.get(name)),
      clear: vi.fn(async (name: string) => alarms.delete(name)),
    },
    storage: {
      session: {
        get: vi.fn(async () => saved),
        set: vi.fn(async (value: Record<string, unknown>) => {
          Object.assign(saved, structuredClone(value));
        }),
      },
    },
    tabs: {
      query: vi.fn(async () => [...tabs.values()]),
      get: vi.fn(async (id: number) => {
        if (!tabs.has(id)) throw new Error('No tab');
        return tabs.get(id);
      }),
      create: vi.fn(async () => {
        const tab = { id: 2, url: 'about:blank', windowId: 1, groupId: -1 };
        tabs.set(2, tab);
        return tab;
      }),
      remove: vi.fn(async (id: number) => {
        tabs.delete(id);
        attached.delete(id);
        emit('removed', id);
      }),
      group: vi.fn(async ({ tabIds }: { tabIds: number[] }) => {
        for (const id of tabIds) tabs.get(id)!.groupId = 10;
        return 10;
      }),
      ungroup: vi.fn(async (id: number) => {
        if (tabs.has(id)) tabs.get(id)!.groupId = -1;
      }),
      onRemoved: event('removed'),
      onCreated: event('created'),
    },
    tabGroups: {
      get: vi.fn(async () => ({ title: 'Qwen Browser' })),
      update: vi.fn(async () => ({})),
    },
    debugger: {
      attach: vi.fn(async ({ tabId }: { tabId: number }) => {
        if (attached.has(tabId))
          throw new Error('Another debugger is already attached');
        attached.add(tabId);
      }),
      detach: vi.fn(async ({ tabId }: { tabId: number }) => {
        attached.delete(tabId);
      }),
      sendCommand: vi.fn(async () => ({})),
      onDetach: event('detached'),
      onEvent: event('debuggerEvent'),
    },
  };
  const context = vm.createContext({
    chrome: chromeApi,
    setTimeout,
    clearTimeout,
    Date,
    Error,
    TextDecoder,
    Uint8Array,
    atob,
  });
  vm.runInContext(source, context);
  const api = vm.runInContext(
    '({dispatch, restoreState, attachedTabs, agentOwnedTabs, derivedTabParents})',
    context,
  ) as {
    restoreState(): Promise<void>;
    dispatch(
      method: string,
      params?: Record<string, unknown>,
    ): Promise<unknown>;
    attachedTabs: Set<number>;
    agentOwnedTabs: Set<number>;
    derivedTabParents: Map<number, number>;
  };
  await vi.advanceTimersByTimeAsync(0);
  return { ...api, chromeApi, tabs, attached, saved, alarms, emit, port };
}

test.each(['group', 'title'])(
  'persists pruned restored state when %s setup fails',
  async (stage) => {
    const f = await fixture();
    Object.assign(f.saved, {
      agentOwnedTabs: [1, 99],
      derivedTabParents: [[99, 1]],
    });
    if (stage === 'group')
      f.chromeApi.tabs.group.mockRejectedValueOnce(new Error('group failed'));
    else
      f.chromeApi.tabGroups.update.mockRejectedValueOnce(
        new Error('title failed'),
      );

    await expect(f.restoreState()).resolves.toBeUndefined();

    expect(f.saved.agentOwnedTabs).toEqual([1]);
    expect(f.saved.derivedTabParents).toEqual([]);
    expect(f.tabs.has(1)).toBe(true);
  },
);

test('restores the remaining owned tabs after one grouping failure', async () => {
  const f = await fixture();
  f.tabs.set(3, {
    id: 3,
    url: 'https://example.test/other',
    windowId: 2,
    groupId: -1,
  });
  Object.assign(f.saved, { agentOwnedTabs: [1, 3, 99] });
  f.chromeApi.tabs.group.mockRejectedValueOnce(new Error('group failed'));

  await expect(f.restoreState()).resolves.toBeUndefined();

  expect(f.chromeApi.tabs.group).toHaveBeenCalledWith({ tabIds: [3] });
  expect(f.tabs.get(3)?.groupId).toBe(10);
  expect(f.saved.agentOwnedTabs).toEqual([1, 3]);
});

test('detach and reattach wait for Chrome to actually release its debugger', async () => {
  const f = await fixture();
  await f.dispatch('tabs.attach', { tabId: 1 });
  let finish!: () => void;
  f.chromeApi.debugger.detach.mockImplementationOnce(async ({ tabId }) => {
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    f.attached.delete(tabId);
  });
  let released = false;
  const release = f.dispatch('tabs.detach', { tabId: 1 }).then(() => {
    released = true;
  });
  await vi.advanceTimersByTimeAsync(0);
  let reattached = false;
  const attach = f.dispatch('tabs.attach', { tabId: 1 }).then(() => {
    reattached = true;
  });
  // Observe rejections immediately too, so the red baseline has no unhandled rejection.
  const result = Promise.allSettled([release, attach]);
  await vi.advanceTimersByTimeAsync(500);
  expect(released).toBe(false);
  expect(reattached).toBe(false);
  expect(f.chromeApi.debugger.attach).toHaveBeenCalledTimes(1);
  finish();
  expect(await result).toEqual([
    { status: 'fulfilled', value: undefined },
    { status: 'fulfilled', value: undefined },
  ]);
  expect(f.attached.has(1)).toBe(true);
});

test('failed detach retains attachment and does not report successful release', async () => {
  const f = await fixture();
  await f.dispatch('tabs.attach', { tabId: 1 });
  f.chromeApi.debugger.detach.mockRejectedValueOnce(new Error('detach failed'));
  await expect(f.dispatch('tabs.detach', { tabId: 1 })).rejects.toThrow(
    'detach failed',
  );
  expect(f.attachedTabs.has(1)).toBe(true);
  await f.dispatch('tabs.detach', { tabId: 1 });
  expect(f.attachedTabs.has(1)).toBe(false);
});

test('a pending advisory overlay does not block debugger release', async () => {
  const f = await fixture();
  let finish!: () => void;
  f.chromeApi.debugger.sendCommand.mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    return {};
  });
  const attaching = f.dispatch('tabs.attach', { tabId: 1 });
  await vi.advanceTimersByTimeAsync(0);
  expect(f.attached.has(1)).toBe(true);
  let released = false;
  const release = f.dispatch('tabs.detach', { tabId: 1 }).then(() => {
    released = true;
  });
  await vi.advanceTimersByTimeAsync(500);
  expect(released).toBe(true);
  expect(f.attached.has(1)).toBe(false);
  finish();
  await Promise.all([attaching, release]);
});

test('a foreign debugger still causes a conflict and is never detached', async () => {
  const f = await fixture();
  f.attached.add(1);
  await expect(f.dispatch('tabs.attach', { tabId: 1 })).rejects.toMatchObject({
    code: 'TAB_DEBUGGER_CONFLICT',
  });
  expect(f.chromeApi.debugger.detach).not.toHaveBeenCalled();
});

test.each([' ', 'Enter'])(
  'only Enter input can claim a later popup (key=%j)',
  async (key) => {
    const f = await fixture();
    await f.dispatch('cdp.send', {
      tabId: 1,
      method: 'Input.dispatchKeyEvent',
      params: { type: 'keyDown', key, text: key },
    });
    const popup = {
      id: 3,
      openerTabId: 1,
      url: 'https://popup.test',
      windowId: 1,
    };
    f.tabs.set(3, popup);
    f.emit('created', popup);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.agentOwnedTabs.has(3)).toBe(key === 'Enter');
    expect(f.derivedTabParents.has(3)).toBe(key === 'Enter');
  },
);

test.each(['persist', 'group', 'attach'])(
  'create failure during %s removes only the new tab',
  async (stage) => {
    const f = await fixture();
    if (stage === 'persist')
      f.chromeApi.storage.session.set.mockRejectedValueOnce(
        new Error('create failed'),
      );
    if (stage === 'group')
      f.chromeApi.tabs.group.mockRejectedValueOnce(new Error('create failed'));
    if (stage === 'attach')
      f.chromeApi.debugger.attach.mockRejectedValueOnce(
        new Error('create failed'),
      );
    f.chromeApi.tabs.remove.mockImplementationOnce(async (id) => {
      f.tabs.delete(id);
      f.attached.delete(id);
    });
    await expect(f.dispatch('tabs.create', {})).rejects.toThrow(
      'create failed',
    );
    expect([...f.tabs.keys()]).toEqual([1]);
    expect(f.agentOwnedTabs.size).toBe(0);
    expect(f.derivedTabParents.size).toBe(0);
    expect(f.attached.size).toBe(0);
    expect(f.saved.agentOwnedTabs).toEqual([]);
  },
);

test('user cancellation releases derived ownership, grouping and persisted state', async () => {
  const f = await fixture();
  await f.dispatch('cdp.send', {
    tabId: 1,
    method: 'Input.dispatchKeyEvent',
    params: { type: 'keyDown', key: 'Enter' },
  });
  const popup = {
    id: 3,
    openerTabId: 1,
    url: 'https://popup.test',
    windowId: 1,
  };
  f.tabs.set(3, popup);
  f.emit('created', popup);
  await vi.advanceTimersByTimeAsync(0);
  await f.dispatch('tabs.attach', { tabId: 3 });
  f.attached.delete(3);
  f.emit('detached', { tabId: 3 }, 'canceled_by_user');
  await vi.advanceTimersByTimeAsync(0);
  expect(f.tabs.get(3)?.groupId).toBe(-1);
  expect(f.agentOwnedTabs.has(3)).toBe(false);
  expect(f.derivedTabParents.has(3)).toBe(false);
  expect(f.saved.agentOwnedTabs).toEqual([]);
  expect(f.saved.derivedTabParents).toEqual([]);
  expect(await f.dispatch('tabs.queryDerived', {})).toEqual([]);
  expect(f.port.postMessage).toHaveBeenCalledWith(
    expect.objectContaining({ method: 'qwenBrowser.detached', tabId: 3 }),
  );
});

test('an absent host waits for an alarm without rewriting session state or retrying every second', async () => {
  const f = await fixture();
  const writes = f.chromeApi.storage.session.set.mock.calls.length;
  f.emit('disconnect');
  await vi.advanceTimersByTimeAsync(29_000);
  expect(f.chromeApi.runtime.connectNative).toHaveBeenCalledTimes(1);
  expect(f.chromeApi.storage.session.set).toHaveBeenCalledTimes(writes);
  expect(f.alarms.size).toBe(1);
  const [name, info] = [...f.alarms][0]!;
  expect(info.delayInMinutes).toBe(0.5);
  f.alarms.delete(name);
  f.emit('alarm', { name });
  await vi.advanceTimersByTimeAsync(0);
  expect(f.chromeApi.runtime.connectNative).toHaveBeenCalledTimes(2);
  f.emit('message', {
    type: 'request',
    id: 'ping',
    method: 'ping',
    params: {},
  });
  await vi.advanceTimersByTimeAsync(61_000);
  expect(f.port.postMessage).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'ping', ok: true }),
  );
  expect(f.chromeApi.runtime.connectNative).toHaveBeenCalledTimes(2);
  expect(f.port.disconnect).not.toHaveBeenCalled();
});

test('worker restart preserves the scheduled retry instead of starting another host', async () => {
  const first = await fixture();
  first.emit('disconnect');
  await vi.advanceTimersByTimeAsync(0);
  const restarted = await fixture(first.alarms);
  expect(restarted.chromeApi.runtime.connectNative).not.toHaveBeenCalled();
  const name = [...restarted.alarms.keys()][0]!;
  restarted.alarms.delete(name);
  restarted.emit('alarm', { name });
  await vi.advanceTimersByTimeAsync(0);
  expect(restarted.chromeApi.runtime.connectNative).toHaveBeenCalledTimes(1);
});

test('user cancellation persists even while grouping another tab is pending', async () => {
  const f = await fixture();
  await f.dispatch('tabs.attach', { tabId: 1 });
  f.agentOwnedTabs.add(1);
  let finish!: () => void;
  f.chromeApi.tabs.group.mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    return 10;
  });
  const creating = f.dispatch('tabs.create', {});
  await vi.advanceTimersByTimeAsync(0);
  f.emit('detached', { tabId: 1 }, 'canceled_by_user');
  await vi.advanceTimersByTimeAsync(0);
  expect(f.saved.agentOwnedTabs).not.toContain(1);
  finish();
  await creating;
  await vi.advanceTimersByTimeAsync(0);
  expect(f.chromeApi.tabs.ungroup).toHaveBeenCalledWith(1);
});
