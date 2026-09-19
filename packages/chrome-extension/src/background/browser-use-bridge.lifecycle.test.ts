/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment node

import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import { afterEach, expect, test, vi } from 'vitest';

const source = await readFile(
  new URL('./browser-use-bridge.js', import.meta.url),
  'utf8',
);
afterEach(() => vi.useRealTimers());

function navigationTarget(tab: {
  id: number;
  openerTabId: number;
  url: string;
  pendingUrl?: string;
}) {
  return {
    tabId: tab.id,
    sourceTabId: tab.openerTabId,
    timeStamp: Date.now(),
    url: tab.pendingUrl || tab.url,
  };
}

async function fixture(
  alarms = new Map<string, chrome.alarms.AlarmCreateInfo>(),
  localState: Record<string, unknown> = {},
  startupStorageFailure = false,
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
  let nextTab = 2;
  let nextGroup = 10;
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
      local: {
        get: vi.fn(async () => ({ ...localState })),
        set: vi.fn(async (value: Record<string, unknown>) => {
          Object.assign(localState, structuredClone(value));
        }),
      },
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
        const id = nextTab++;
        const tab = { id, url: 'about:blank', windowId: 1, groupId: -1 };
        tabs.set(tab.id, tab);
        return tab;
      }),
      remove: vi.fn(async (id: number) => {
        tabs.delete(id);
        attached.delete(id);
        emit('removed', id);
      }),
      group: vi.fn(async (arg: { tabIds: number[]; groupId?: number }) => {
        const groupId = arg.groupId ?? nextGroup++;
        for (const id of arg.tabIds) tabs.get(id)!.groupId = groupId;
        return groupId;
      }),
      ungroup: vi.fn(async (id: number) => {
        if (tabs.has(id)) tabs.get(id)!.groupId = -1;
      }),
      onRemoved: event('removed'),
    },
    webNavigation: { onCreatedNavigationTarget: event('navigationTarget') },
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
  if (startupStorageFailure)
    chromeApi.storage.session.get.mockRejectedValueOnce(
      new Error('storage temporarily unavailable'),
    );
  const context = vm.createContext({
    chrome: chromeApi,
    crypto: webcrypto,
    setTimeout,
    clearTimeout,
    Date,
    Error,
    TextDecoder,
    TextEncoder,
    Uint8Array,
    atob,
  });
  vm.runInContext(source, context);
  const api = vm.runInContext(
    `({dispatch: (method, params = {}) => dispatch(method, params, 'test-session'), sessionDispatch: dispatch, restoreState, sessions, attachedTabs, agentOwnedTabs, managedTabs, tabOwners, derivedTabParents})`,
    context,
  ) as {
    sessionDispatch(
      method: string,
      params: Record<string, unknown>,
      session: string,
    ): Promise<unknown>;
    sessions: Map<string, unknown>;
    restoreState(): Promise<void>;
    dispatch(
      method: string,
      params?: Record<string, unknown>,
    ): Promise<unknown>;
    attachedTabs: Set<number>;
    agentOwnedTabs: Set<number>;
    managedTabs: Set<number>;
    tabOwners: Map<number, unknown>;
    derivedTabParents: Map<number, number>;
  };
  await vi.advanceTimersByTimeAsync(0);
  await api.sessionDispatch('session.open', {}, 'test-session');
  await api.sessionDispatch('session.open', {}, 'B');
  return {
    ...api,
    chromeApi,
    tabs,
    attached,
    saved,
    localState,
    alarms,
    emit,
    port,
  };
}

function gate() {
  let resolve!: () => void;
  let entered = false;
  const wait = new Promise<void>((done) => {
    resolve = done;
  });
  return {
    block() {
      entered = true;
      return wait;
    },
    finish() {
      expect(entered).toBe(true);
      resolve();
    },
  };
}

const ownershipConflict = { code: 'TAB_OWNERSHIP_CONFLICT' };

type Fixture = Awaited<ReturnType<typeof fixture>>;

function pauseCommand(f: Fixture) {
  const { block, finish } = gate();
  f.chromeApi.debugger.sendCommand.mockImplementationOnce(async () => {
    await block();
    return {};
  });
  return finish;
}

async function pendingCommand(f: Fixture, tabId = 1) {
  const finish = pauseCommand(f);
  const command = f.dispatch('cdp.send', { tabId, method: 'Runtime.evaluate' });
  await vi.advanceTimersByTimeAsync(0);
  return { command, finish };
}

const pressEnter = (f: Fixture, tabId = 1) =>
  f.dispatch('cdp.send', {
    tabId,
    method: 'Input.dispatchKeyEvent',
    params: { type: 'keyDown', key: 'Enter' },
  });

function popupTab(f: Fixture, overrides = {}) {
  const popup = {
    id: 3,
    openerTabId: 1,
    url: 'https://popup.test',
    windowId: 1,
    ...overrides,
  };
  f.tabs.set(popup.id, popup);
  return popup;
}

const claimB = (f: Fixture, tabId = 1) =>
  f.sessionDispatch('tabs.attach', { tabId }, 'B');

test('preserves abandoned pages, releases their ownership and ungroups them on worker recovery', async () => {
  const f = await fixture();
  f.tabs.set(3, {
    id: 3,
    url: 'https://example.test/other',
    windowId: 2,
    groupId: 10,
  });
  Object.assign(f.saved, {
    agentOwnedTabs: [1, 3, 99],
    derivedTabParents: [[99, 1]],
  });

  await expect(f.restoreState()).resolves.toBeUndefined();

  expect(f.chromeApi.tabs.ungroup).toHaveBeenCalledWith(3);
  expect(f.tabs.get(3)?.groupId).toBe(-1);
  expect(f.saved.agentOwnedTabs).toEqual([]);
  expect(f.saved.derivedTabParents).toEqual([]);
  expect(f.tabs.has(1)).toBe(true);
});

test('detach and reattach wait for Chrome to actually release its debugger', async () => {
  const f = await fixture();
  await f.dispatch('tabs.attach', { tabId: 1 });
  const { block, finish } = gate();
  f.chromeApi.debugger.detach.mockImplementationOnce(async ({ tabId }) => {
    await block();
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
  const finish = pauseCommand(f);
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
    await f.dispatch('tabs.attach', { tabId: 1 });
    await f.dispatch('cdp.send', {
      tabId: 1,
      method: 'Input.dispatchKeyEvent',
      params: { type: 'keyDown', key, text: key },
    });
    const popup = popupTab(f);
    f.emit('navigationTarget', navigationTarget(popup));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.agentOwnedTabs.has(3)).toBe(key === 'Enter');
    expect(f.derivedTabParents.has(3)).toBe(key === 'Enter');
  },
);

test('a popup known only by its pending URL stays controllable', async () => {
  // `chrome.tabs.onCreated` delivers a cross-origin popup with an empty `url`
  // and the destination in `pendingUrl`. The claim already keys on
  // `pendingUrl`; the runtime's immediate `tabs.get` must not then reject the
  // same tab as unsupported because it only looked at `url`.
  const f = await fixture();
  await f.dispatch('tabs.attach', { tabId: 1 });
  await pressEnter(f);
  const popup = popupTab(f, { url: '', pendingUrl: 'https://popup.test/cart' });
  f.emit('navigationTarget', navigationTarget(popup));
  await vi.advanceTimersByTimeAsync(0);
  expect(f.agentOwnedTabs.has(3)).toBe(true);
  await expect(f.dispatch('tabs.get', { tabId: 3 })).resolves.toMatchObject({
    providerTabId: 3,
  });
  await expect(f.dispatch('tabs.attach', { tabId: 3 })).resolves.toBeDefined();
});

test.each(['persist', 'attach'])(
  'create failure during %s removes only the new tab',
  async (stage) => {
    const f = await fixture();
    if (stage === 'persist')
      f.chromeApi.storage.session.set.mockRejectedValueOnce(
        new Error('create failed'),
      );
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
  await f.dispatch('tabs.attach', { tabId: 1 });
  await pressEnter(f);
  const popup = popupTab(f);
  f.emit('navigationTarget', navigationTarget(popup));
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
  await f.sessionDispatch('session.open', {}, 'reconnected-session');
  f.emit('message', {
    type: 'request',
    browserSessionId: 'reconnected-session',
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
  const restarted = await fixture(first.alarms, first.localState);
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
  f.managedTabs.add(1);
  f.tabs.get(1)!.groupId = 10;
  const { block, finish } = gate();
  f.chromeApi.tabs.group.mockImplementationOnce(async () => {
    await block();
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

test('a grouping failure during create keeps the new tab owned and attached', async () => {
  const f = await fixture();
  f.chromeApi.tabs.group.mockRejectedValueOnce(
    new Error('Tabs cannot be edited right now (user may be dragging a tab).'),
  );
  await expect(f.dispatch('tabs.create', {})).resolves.toMatchObject({
    providerTabId: 2,
  });
  expect(f.chromeApi.tabs.remove).not.toHaveBeenCalled();
  expect(f.tabs.has(2)).toBe(true);
  expect(f.attached.has(2)).toBe(true);
  expect(f.agentOwnedTabs.has(2)).toBe(true);
  expect(f.saved.agentOwnedTabs).toEqual([2]);
  await f.dispatch('tabs.release', { tabId: 2 });
  await vi.advanceTimersByTimeAsync(3000);
  // Never grouped, so there is nothing to ungroup.
  expect(f.chromeApi.tabs.ungroup).not.toHaveBeenCalled();
  await expect(claimB(f, 2)).resolves.toBeNull();
  expect(f.saved.agentOwnedTabs).toEqual([]);
});

test('closing an owned tab that already vanished is not a failure', async () => {
  const f = await fixture();
  await f.dispatch('tabs.attach', { tabId: 1 });
  f.chromeApi.tabs.remove.mockRejectedValueOnce(
    new Error('No tab with id: 1.'),
  );
  await expect(f.dispatch('tabs.close', { tabId: 1 })).resolves.toBeNull();
});

test('a tab vanishing before the debugger attaches is reported as stale', async () => {
  const f = await fixture();
  f.chromeApi.debugger.attach.mockRejectedValueOnce(
    new Error('No tab with id: 1.'),
  );
  await expect(f.dispatch('tabs.attach', { tabId: 1 })).rejects.toMatchObject({
    code: 'STALE_TAB',
  });
  expect(f.attachedTabs.has(1)).toBe(false);
});

test('listed tab titles and urls stay within the SDK schema bound', async () => {
  const f = await fixture();
  f.tabs.set(4, {
    id: 4,
    title: 't'.repeat(30_000),
    url: `https://example.test/?q=${'u'.repeat(30_000)}`,
    windowId: 1,
    groupId: -1,
  });
  const listed = (await f.dispatch('tabs.queryOpen', {})) as Array<{
    providerTabId: number;
    title: string | null;
    url: string | null;
  }>;
  const long = listed.find((tab) => tab.providerTabId === 4);
  expect(long?.url?.length).toBe(20_000);
  expect(long?.url?.startsWith('https://example.test/?q=u')).toBe(true);
  expect(long?.title?.length).toBe(20_000);
  const short = listed.find((tab) => tab.providerTabId === 1);
  expect(short?.url).toBe('https://example.test');
  expect(short?.title).toBeNull();
});

test('concurrent claims reserve ownership before debugger attachment and route events to their owner', async () => {
  const f = await fixture();
  const { block, finish } = gate();
  f.chromeApi.debugger.attach.mockImplementationOnce(async ({ tabId }) => {
    await block();
    f.attached.add(tabId);
  });
  const attaching = f.dispatch('tabs.attach', { tabId: 1 });
  await vi.advanceTimersByTimeAsync(0);
  await expect(claimB(f)).rejects.toMatchObject(ownershipConflict);
  finish();
  await attaching;
  f.emit(
    'debuggerEvent',
    { tabId: 1, sessionId: 'child-frame' },
    'Runtime.consoleAPICalled',
    {},
  );
  expect(f.port.postMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      browserSessionId: 'test-session',
      sessionId: 'child-frame',
      tabId: 1,
    }),
  );
  expect(f.chromeApi.debugger.attach).toHaveBeenCalledTimes(1);
});

test.each(['graceful', 'disconnected'] as const)(
  'closing A (%s) preserves B operations, tabs and session group',
  async (reason) => {
    const f = await fixture();
    await f.dispatch('session.name', { name: 'A work' });
    await f.sessionDispatch('session.name', { name: 'B work' }, 'B');
    await f.dispatch('tabs.create');
    await f.sessionDispatch('tabs.create', {}, 'B');
    const groupB = f.tabs.get(3)!.groupId;
    expect(groupB).not.toBe(f.tabs.get(2)!.groupId);
    await f.dispatch('tabs.create');
    expect(f.tabs.get(4)!.groupId).toBe(f.tabs.get(2)!.groupId);
    expect(f.tabs.get(4)!.groupId).not.toBe(groupB);
    f.chromeApi.tabGroups.update.mockClear();
    await f.dispatch('session.name', { name: 'A renamed' });
    expect(f.chromeApi.tabGroups.update).toHaveBeenCalledExactlyOnceWith(
      f.tabs.get(2)!.groupId,
      { title: 'A renamed', color: 'blue' },
    );
    expect(f.tabs.get(3)!.groupId).toBe(groupB);
    const finish = pauseCommand(f);
    const operationB = f.sessionDispatch(
      'cdp.send',
      { tabId: 3, method: 'Runtime.evaluate' },
      'B',
    );
    await vi.advanceTimersByTimeAsync(0);
    await f.dispatch('session.close', { reason });
    expect(f.tabs.has(2)).toBe(reason === 'disconnected');
    expect(f.attached.has(2)).toBe(false);
    expect(f.tabs.has(3)).toBe(true);
    expect(f.attached.has(3)).toBe(true);
    expect(f.tabs.get(3)!.groupId).toBe(groupB);
    finish();
    await expect(operationB).resolves.toEqual({});
    await expect(
      f.sessionDispatch('cdp.send', { tabId: 3, method: 'Page.enable' }, 'B'),
    ).resolves.toEqual({});
    await expect(f.dispatch('session.close', { reason })).resolves.toBeNull();
  },
);

test('closing a session quarantines its busy tab, and only that tab, until the command and debugger cleanup finish', async () => {
  const f = await fixture();
  await f.dispatch('tabs.attach', { tabId: 1 });
  await f.dispatch('tabs.create');
  const { command: pending, finish } = await pendingCommand(f);
  const closing = f.dispatch('session.close', { reason: 'disconnected' });
  await vi.advanceTimersByTimeAsync(300);
  await closing;
  expect(f.attached.has(1)).toBe(false);
  expect(f.attached.has(2)).toBe(false);
  await expect(claimB(f)).rejects.toMatchObject(ownershipConflict);
  await claimB(f, 2);
  finish();
  await pending;
  await vi.advanceTimersByTimeAsync(0);
  expect(f.tabs.has(1)).toBe(true);
  expect(f.attached.has(1)).toBe(false);
  expect(f.attached.has(2)).toBe(true);
  await expect(claimB(f)).resolves.toBeNull();
  await expect(f.dispatch('tabs.detach', { tabId: 1 })).rejects.toThrow();
  expect(f.attached.has(1)).toBe(true);
});

test('a dialog handler can progress while an input acknowledgement is pending', async () => {
  const f = await fixture();
  await f.dispatch('tabs.attach', { tabId: 1 });
  const finish = pauseCommand(f);
  const input = pressEnter(f);
  await vi.advanceTimersByTimeAsync(0);
  await expect(
    f.dispatch('cdp.send', {
      tabId: 1,
      method: 'Page.handleJavaScriptDialog',
      params: { accept: true },
    }),
  ).resolves.toEqual({});
  finish();
  await input;
});

test('a tab finishing creation after client loss is preserved and its ownership released', async () => {
  const f = await fixture();
  const { block, finish } = gate();
  f.chromeApi.tabs.create.mockImplementationOnce(async () => {
    await block();
    const tab = { id: 2, url: 'about:blank', windowId: 1, groupId: -1 };
    f.tabs.set(2, tab);
    return tab;
  });
  const creating = f.dispatch('tabs.create');
  const rejected = creating.catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(0);
  const closing = f.dispatch('session.close', { reason: 'disconnected' });
  await vi.advanceTimersByTimeAsync(300);
  await closing;
  finish();
  expect(await rejected).toMatchObject({
    message: 'Browser backend disconnected',
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(f.tabs.has(2)).toBe(true);
  expect(f.chromeApi.tabs.remove).not.toHaveBeenCalled();
  await expect(claimB(f, 2)).resolves.toBeNull();
});

test('wire requests require session registration and responses echo session identity', async () => {
  const f = await fixture();
  for (const [id, method, ok] of [
    ['unregistered', 'tabs.create', false],
    ['register', 'session.open', true],
    ['registered', 'tabs.create', true],
  ] as const) {
    f.emit('message', {
      type: 'request',
      id,
      browserSessionId: 'wire-session',
      method,
      params: {},
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.port.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id, browserSessionId: 'wire-session', ok }),
    );
  }
});

test('worker recovery retains an unavailable owner when debugger cleanup fails', async () => {
  const f = await fixture();
  Object.assign(f.saved, {
    tabOwners: [[1, 'old-worker-session']],
    agentOwnedTabs: [1],
  });
  f.attached.add(1);
  f.chromeApi.debugger.detach.mockRejectedValueOnce(
    new Error('Chrome temporarily unavailable'),
  );
  await f.restoreState();
  expect(f.tabs.has(1)).toBe(true);
  expect(f.attached.has(1)).toBe(true);
  await expect(f.dispatch('tabs.attach', { tabId: 1 })).rejects.toMatchObject(
    ownershipConflict,
  );
  expect(f.saved.agentOwnedTabs).toEqual([1]);
});

test.each(['release', 'cancellation'])(
  '%s keeps a busy tab reserved until outstanding work and cleanup complete',
  async (mode) => {
    const f = await fixture();
    await f.dispatch('tabs.create');
    const { command, finish } = await pendingCommand(f, 2);
    if (mode === 'release') void f.dispatch('tabs.release', { tabId: 2 });
    else {
      f.attached.delete(2);
      f.emit('detached', { tabId: 2 }, 'canceled_by_user');
    }
    await expect(f.dispatch('tabs.attach', { tabId: 2 })).rejects.toMatchObject(
      ownershipConflict,
    );
    await expect(claimB(f, 2)).rejects.toMatchObject(ownershipConflict);
    finish();
    await command;
    await vi.advanceTimersByTimeAsync(0);
    expect(f.tabs.get(2)!.groupId).toBe(-1);
    await expect(claimB(f, 2)).resolves.toBeNull();
    await expect(f.dispatch('tabs.detach', { tabId: 2 })).rejects.toMatchObject(
      ownershipConflict,
    );
    expect(f.attached.has(2)).toBe(true);
  },
);

test('completed sessions are reclaimed and repeated close remains idempotent', async () => {
  const f = await fixture();
  const baseline = f.sessions.size;
  for (let index = 0; index < 12; index++) {
    const id = `short-lived-${index}`;
    await f.sessionDispatch('session.open', {}, id);
    await f.sessionDispatch('session.name', { name: id }, id);
    await f.sessionDispatch('tabs.create', {}, id);
    await f.sessionDispatch('session.close', { reason: 'graceful' }, id);
    expect(f.sessions.size).toBe(baseline);
    await expect(
      f.sessionDispatch('session.close', { reason: 'disconnected' }, id),
    ).resolves.toBeNull();
  }
});

test('pending and failed cleanup retains a session until no owned tabs remain', async () => {
  const f = await fixture();
  await f.dispatch('tabs.attach', { tabId: 1 });
  const { command, finish } = await pendingCommand(f);
  f.chromeApi.debugger.detach.mockRejectedValueOnce(new Error('detach failed'));
  const closing = f.dispatch('session.close', { reason: 'disconnected' });
  await vi.advanceTimersByTimeAsync(300);
  await closing;
  expect(f.sessions.has('test-session')).toBe(true);
  finish();
  await command;
  await vi.advanceTimersByTimeAsync(0);
  expect(f.sessions.has('test-session')).toBe(true);
  f.tabs.delete(1);
  f.emit('removed', 1);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.sessions.has('test-session')).toBe(false);
});

test.each(['opener', 'background navigation source'])(
  '%s owns its popup through opener closure and excludes B',
  async (source) => {
    const f = await fixture();
    if (source === 'background navigation source') {
      f.tabs.set(2, {
        id: 2,
        url: 'https://other.test',
        windowId: 1,
        groupId: -1,
      });
      await claimB(f, 2);
    }
    await f.dispatch('tabs.attach', { tabId: 1 });
    await pressEnter(f);
    const popup = popupTab(f, {
      openerTabId: source === 'opener' ? 1 : 2,
      groupId: -1,
    });
    const { block, finish } = gate();
    if (source === 'background navigation source')
      f.chromeApi.tabs.get.mockImplementationOnce(async () => {
        await block();
        return popup;
      });
    f.emit('navigationTarget', { ...navigationTarget(popup), sourceTabId: 1 });
    await vi.advanceTimersByTimeAsync(0);
    if (source === 'background navigation source')
      await expect(claimB(f, 3)).rejects.toMatchObject(ownershipConflict);
    await f.dispatch('tabs.close', { tabId: 1 });
    if (source === 'background navigation source') {
      finish();
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(f.derivedTabParents.get(3)).toBe(1);
    expect(f.port.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        browserSessionId: 'test-session',
        tabId: 3,
        method: 'qwenBrowser.derivedTabTracked',
        params: { openerTabId: 1 },
      }),
    );
    expect(await f.sessionDispatch('tabs.queryDerived', {}, 'B')).toEqual([]);
    expect(await f.dispatch('tabs.queryDerived')).toEqual([
      expect.objectContaining({ providerTabId: 3 }),
    ]);
    await expect(claimB(f, 3)).rejects.toMatchObject(ownershipConflict);
  },
);

test('the last reader releases a failed claim belonging to another session', async () => {
  const f = await fixture();
  const { block, finish } = gate();
  f.chromeApi.tabs.get.mockRejectedValueOnce(
    new Error('temporary lookup failure'),
  );
  f.chromeApi.tabs.get.mockImplementationOnce(async () => {
    await block();
    return f.tabs.get(1);
  });
  const claim = f.dispatch('tabs.attach', { tabId: 1 });
  const reader = f.sessionDispatch('tabs.get', { tabId: 1 }, 'B');
  await expect(claim).rejects.toThrow();
  expect(f.tabOwners.has(1)).toBe(true);
  finish();
  await reader;
  expect(f.tabOwners.has(1)).toBe(false);
  await expect(claimB(f)).resolves.toBeNull();
});

test.each(['release', 'cancellation', 'session'])(
  '%s retries failed ungrouping without giving another session the tab early',
  async (mode) => {
    const f = await fixture();
    await f.dispatch('tabs.create');
    f.chromeApi.tabs.ungroup.mockRejectedValueOnce(
      new Error('tab is being dragged'),
    );
    if (mode === 'release') {
      await expect(f.dispatch('tabs.release', { tabId: 2 })).rejects.toThrow(
        'dragged',
      );
    } else if (mode === 'cancellation') {
      f.attached.delete(2);
      f.emit('detached', { tabId: 2 }, 'canceled_by_user');
    } else {
      await f.dispatch('session.close', { reason: 'disconnected' });
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(f.chromeApi.tabs.ungroup).toHaveBeenCalledTimes(1);
    expect(f.saved.managedTabs).toContain(2);
    await expect(claimB(f, 2)).rejects.toMatchObject(ownershipConflict);
    await vi.advanceTimersByTimeAsync(999);
    expect(f.chromeApi.tabs.ungroup).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.chromeApi.tabs.ungroup).toHaveBeenCalledTimes(2);
    expect(f.tabs.get(2)!.groupId).toBe(-1);
    expect(f.saved.managedTabs).toEqual([]);
    await expect(claimB(f, 2)).resolves.toBeNull();
  },
);

test('user cancellation retains the ungroup obligation through concurrent graceful close', async () => {
  const f = await fixture();
  await f.dispatch('tabs.create');
  const { block, finish } = gate();
  f.chromeApi.tabs.ungroup.mockImplementationOnce(async (id) => {
    await block();
    f.tabs.get(id)!.groupId = -1;
  });
  f.attached.delete(2);
  f.emit('detached', { tabId: 2 }, 'canceled_by_user');
  const closing = f.dispatch('session.close', { reason: 'graceful' });
  await vi.advanceTimersByTimeAsync(300);
  await closing;
  expect(f.tabs.has(2)).toBe(true);
  expect(f.saved.agentOwnedTabs).toEqual([]);
  expect(f.saved.managedTabs).toEqual([2]);
  expect(f.tabOwners.has(2)).toBe(true);
  finish();
  await vi.advanceTimersByTimeAsync(0);
  expect(f.tabs.get(2)!.groupId).toBe(-1);
  expect(f.tabOwners.has(2)).toBe(false);
  expect(f.chromeApi.tabs.remove).not.toHaveBeenCalled();
});

test('worker recovery retries cleanup and preserves pending cancellation ungrouping', async () => {
  const f = await fixture();
  Object.assign(f.saved, {
    managedTabs: [1],
    agentOwnedTabs: [],
    tabOwners: [[1, 'old-session']],
  });
  f.tabs.get(1)!.groupId = 10;
  f.chromeApi.tabs.ungroup.mockRejectedValueOnce(
    new Error('temporary failure'),
  );
  await f.restoreState();
  expect(f.tabOwners.has(1)).toBe(true);
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.tabs.get(1)!.groupId).toBe(-1);
  expect(f.tabOwners.has(1)).toBe(false);
  expect(f.chromeApi.tabs.remove).not.toHaveBeenCalled();
});

test('overlapping input events preserve the beginning of the popup causal window', async () => {
  const f = await fixture();
  await f.dispatch('tabs.attach', { tabId: 1 });
  const popup = popupTab(f);
  const open = (tabId: number, timeStamp = Date.now()) =>
    f.emit('navigationTarget', {
      ...navigationTarget(popup),
      tabId,
      timeStamp,
    });
  open(3);
  expect(f.tabOwners.has(3)).toBe(false);
  vi.setSystemTime(10000);
  await f.dispatch('cdp.send', {
    tabId: 1,
    method: 'Input.dispatchMouseEvent',
    params: { type: 'mousePressed', button: 'left' },
  });
  vi.setSystemTime(10010);
  await f.dispatch('cdp.send', {
    tabId: 1,
    method: 'Input.dispatchMouseEvent',
    params: { type: 'mouseReleased', button: 'left' },
  });
  open(3, 10005);
  expect(f.tabOwners.has(3)).toBe(true);
  open(4, 9999);
  expect(f.tabOwners.has(4)).toBe(false);
  vi.setSystemTime(14000);
  await pressEnter(f);
  open(5, 13000);
  expect(f.tabOwners.has(5)).toBe(false);
  await vi.advanceTimersByTimeAsync(3000);
  open(6);
  expect(f.tabOwners.has(6)).toBe(false);
  expect(f.chromeApi.tabs.group).toHaveBeenCalledTimes(1);
});

test.each(['tabs.release', 'tabs.close', 'session.close'])(
  '%s terminates dialog-blocked renderer work before waiting for it',
  async (method) => {
    const f = await fixture();
    await f.dispatch('tabs.create');
    const finish = pauseCommand(f);
    const input = pressEnter(f, 2);
    await vi.advanceTimersByTimeAsync(0);
    const detach = f.chromeApi.debugger.detach.getMockImplementation()!;
    f.chromeApi.debugger.detach.mockImplementationOnce(async (target) => {
      finish();
      await detach(target);
    });
    const remove = f.chromeApi.tabs.remove.getMockImplementation()!;
    f.chromeApi.tabs.remove.mockImplementationOnce(async (id) => {
      finish();
      await remove(id);
    });
    await f.dispatch(
      method,
      method === 'session.close' ? { reason: 'disconnected' } : { tabId: 2 },
    );
    await input;
    expect(f.attached.has(2)).toBe(false);
    expect(f.tabOwners.has(2)).toBe(false);
    expect(f.tabs.has(2)).toBe(method !== 'tabs.close');
  },
);

test('overlay teardown yields to detach on a modal and retains ownership until old work settles', async () => {
  const f = await fixture();
  await f.dispatch('tabs.create');
  const finish = pauseCommand(f);
  const releasing = f.dispatch('tabs.release', { tabId: 2 });
  await vi.advanceTimersByTimeAsync(251);
  expect(f.attached.has(2)).toBe(false);
  await expect(claimB(f, 2)).rejects.toMatchObject(ownershipConflict);
  finish();
  await releasing;
  await claimB(f, 2);
  expect(f.attached.has(2)).toBe(true);
});

test.each(['tabs.release', 'tabs.close'])(
  '%s sees all post-allocation creation work while persistence is pending',
  async (method) => {
    const f = await fixture();
    const { block, finish } = gate();
    f.chromeApi.storage.session.set.mockImplementationOnce(block);
    const created = f.dispatch('tabs.create').catch(() => 'failed');
    await vi.advanceTimersByTimeAsync(0);
    const releasing = f.dispatch(method, { tabId: 2 });
    await vi.advanceTimersByTimeAsync(0);
    finish();
    expect(await created).toBe('failed');
    await releasing;
    expect(f.tabOwners.has(2)).toBe(false);
    expect(f.attached.has(2)).toBe(false);
    expect(f.chromeApi.debugger.attach).not.toHaveBeenCalled();
    expect(f.tabs.has(2)).toBe(method === 'tabs.release');
  },
);

test('a failed startup restore is retried by the existing reconnect alarm', async () => {
  const f = await fixture(new Map(), {}, true);
  expect(f.chromeApi.runtime.connectNative).not.toHaveBeenCalled();
  expect(f.alarms.has('browser-use-reconnect')).toBe(true);
  f.alarms.delete('browser-use-reconnect');
  f.emit('alarm', { name: 'browser-use-reconnect' });
  await vi.advanceTimersByTimeAsync(0);
  expect(f.chromeApi.storage.session.get).toHaveBeenCalledTimes(2);
  expect(f.chromeApi.runtime.connectNative).toHaveBeenCalledTimes(1);
});

test.each(['Page.addScriptToEvaluateOnNewDocument', 'Runtime.evaluate'])(
  'pending overlay %s does not block attach and remains tracked through release',
  async (blockedMethod) => {
    const f = await fixture();
    const { block, finish } = gate();
    let blocked = false;
    f.chromeApi.debugger.sendCommand.mockImplementation(
      async (...args: unknown[]) => {
        if (!blocked && args[1] === blockedMethod) {
          blocked = true;
          await block();
        }
        return { identifier: 'overlay-test' };
      },
    );
    let attached = false;
    const attaching = f.dispatch('tabs.attach', { tabId: 1 }).then(() => {
      attached = true;
    });
    await vi.advanceTimersByTimeAsync(251);
    expect(attached).toBe(true);
    await attaching;
    expect(f.attached.has(1)).toBe(true);

    const releasing = f.dispatch('tabs.release', { tabId: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.attached.has(1)).toBe(false);
    expect(f.tabOwners.has(1)).toBe(true);
    await expect(claimB(f)).rejects.toMatchObject(ownershipConflict);
    const commandsBeforeOldOverlaySettles =
      f.chromeApi.debugger.sendCommand.mock.calls.length;
    finish();
    await releasing;
    expect(f.tabOwners.has(1)).toBe(false);
    expect(f.chromeApi.debugger.sendCommand.mock.calls.length).toBe(
      commandsBeforeOldOverlaySettles,
    );
    await expect(claimB(f)).resolves.toBeNull();
    expect(f.attached.has(1)).toBe(true);
  },
);

test('close during a pending release reports a conflict instead of claiming the page was closed', async () => {
  const f = await fixture();
  await f.dispatch('tabs.create');
  const { block, finish } = gate();
  f.chromeApi.tabs.ungroup.mockImplementationOnce(async (id) => {
    await block();
    f.tabs.get(id)!.groupId = -1;
  });
  const releasing = f.dispatch('tabs.release', { tabId: 2 });
  await vi.advanceTimersByTimeAsync(0);
  const closing = f
    .dispatch('tabs.close', { tabId: 2 })
    .catch((error: unknown) => error);
  finish();
  await releasing;
  expect(await closing).toMatchObject(ownershipConflict);
  expect(f.tabs.has(2)).toBe(true);
  expect(f.tabs.get(2)!.groupId).toBe(-1);
  expect(f.chromeApi.tabs.remove).not.toHaveBeenCalled();
});

test('a command racing user cancellation does not take the tab back', async () => {
  const f = await fixture();
  await f.dispatch('tabs.attach', { tabId: 1 });
  f.attached.delete(1);
  f.emit('detached', { tabId: 1 }, 'canceled_by_user');
  await vi.advanceTimersByTimeAsync(0);
  await expect(
    f.dispatch('cdp.send', { tabId: 1, method: 'Page.captureScreenshot' }),
  ).rejects.toMatchObject({ code: 'TAB_NOT_OWNED' });
  expect(f.chromeApi.debugger.attach).toHaveBeenCalledTimes(1);
  expect(f.tabOwners.has(1)).toBe(false);
});

test('releasing a claim whose ownership already lapsed stays idempotent', async () => {
  const f = await fixture();
  await f.dispatch('tabs.attach', { tabId: 1 });
  await f.dispatch('tabs.detach', { tabId: 1 });
  expect(f.tabOwners.has(1)).toBe(false);
  await expect(f.dispatch('tabs.release', { tabId: 1 })).resolves.toBeNull();
  await expect(f.dispatch('tabs.release', { tabId: 1 })).resolves.toBeNull();
});

test('user cancellation turns a pending close retry into a release', async () => {
  const f = await fixture();
  await f.dispatch('tabs.attach', { tabId: 1 });
  f.chromeApi.tabs.remove.mockRejectedValueOnce(
    new Error('Tabs cannot be edited right now (user may be dragging a tab).'),
  );
  await expect(f.dispatch('tabs.close', { tabId: 1 })).rejects.toThrow(
    'dragging',
  );
  f.attached.delete(1);
  f.emit('detached', { tabId: 1 }, 'canceled_by_user');
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.chromeApi.tabs.remove).toHaveBeenCalledTimes(1);
  expect(f.tabs.has(1)).toBe(true);
  expect(f.tabOwners.has(1)).toBe(false);
});

test('a close that Chrome never confirms releases the tab instead of wedging it', async () => {
  const f = await fixture();
  await f.dispatch('tabs.create');
  // A "Leave site?" prompt answered with Stay: tabs.remove never settles.
  f.chromeApi.tabs.remove.mockImplementationOnce(() => new Promise(() => {}));
  const closing = f.dispatch('tabs.close', { tabId: 2 }).then(
    () => 'closed',
    (error: Error) => error.message,
  );
  await vi.advanceTimersByTimeAsync(4999);
  await expect(claimB(f, 2)).rejects.toMatchObject(ownershipConflict);
  await vi.advanceTimersByTimeAsync(1);
  expect(await closing).toContain('kept the tab open');
  expect(f.port.postMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      browserSessionId: 'test-session',
      method: 'qwenBrowser.detached',
      tabId: 2,
    }),
  );
  expect(f.tabs.has(2)).toBe(true);
  expect(f.attached.has(2)).toBe(false);
  expect(f.saved.tabOwners).toEqual([]);
  await expect(claimB(f, 2)).resolves.toBeNull();
  await f.dispatch('session.close', { reason: 'graceful' });
  expect(f.sessions.has('test-session')).toBe(false);
});

test('an oversized debugger event is dropped instead of reaching the Host', async () => {
  const f = await fixture();
  await f.dispatch('tabs.attach', { tabId: 1 });
  f.emit('debuggerEvent', { tabId: 1 }, 'Runtime.consoleAPICalled', {
    text: 'x'.repeat(17 * 1024 * 1024),
  });
  f.emit('debuggerEvent', { tabId: 1 }, 'Page.loadEventFired', {});
  const methods = f.port.postMessage.mock.calls.map(
    ([message]) => (message as { method?: string }).method,
  );
  expect(methods).not.toContain('Runtime.consoleAPICalled');
  expect(methods).toContain('Page.loadEventFired');
});
