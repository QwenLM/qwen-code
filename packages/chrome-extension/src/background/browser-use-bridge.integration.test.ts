/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'vitest';
import vm from 'node:vm';

const CHROME_EXTENSION_ID = 'idkijaaipeeinemigojbjkmfmabokbdk';
const CHROME_NATIVE_HOST_NAME = 'com.qwen.browser';

const extensionRoot = process.cwd();

test('unpacked extension has a stable id and the expected least-privilege bridge permissions', async () => {
  const manifest = JSON.parse(
    await readFile(join(extensionRoot, 'public/manifest.json'), 'utf8'),
  ) as {
    key: string;
    minimum_chrome_version: string;
    permissions: string[];
    optional_permissions?: string[];
    background: { service_worker: string };
  };
  const digest = createHash('sha256')
    .update(Buffer.from(manifest.key, 'base64'))
    .digest()
    .subarray(0, 16);
  const extensionId = [...digest]
    .flatMap((byte) => [byte >> 4, byte & 15])
    .map((nibble) => String.fromCharCode(97 + nibble))
    .join('');
  assert.equal(extensionId, CHROME_EXTENSION_ID);
  assert.equal(manifest.minimum_chrome_version, '125');
  assert.deepEqual([...manifest.permissions].sort(), [
    'alarms',
    'debugger',
    'history',
    'nativeMessaging',
    'sidePanel',
    'storage',
    'tabGroups',
    'tabs',
  ]);
  assert.equal(manifest.optional_permissions, undefined);
  assert.equal(
    manifest.background.service_worker,
    'background/service-worker.js',
  );
  assert.equal(
    'action' in manifest,
    true,
    'Qwen keeps its toolbar action and side panel',
  );
});

test('extension service worker enumerates user tabs over Native Messaging without exposing a debug port', async () => {
  const source = await readFile(
    join(extensionRoot, 'src/background/browser-use-bridge.js'),
    'utf8',
  );
  assert.match(
    source,
    new RegExp(CHROME_NATIVE_HOST_NAME.split('.').join('\\.')),
  );
  assert.match(source, /chrome\.debugger\.attach/);
  assert.match(source, /chrome\.debugger\.sendCommand/);
  assert.match(
    source,
    /chrome\.debugger\.onEvent\.addListener/,
    'CDP events must be pushed to the backend',
  );
  assert.match(
    source,
    /chrome\.history\.search/,
    'history queries must go through the browser history API',
  );
  assert.match(source, /qwenBrowser\.detached/);
  assert.match(source, /chrome\.tabs\.onCreated\.addListener/);
  assert.match(source, /DERIVED_TAB_WINDOW_MS/);
  assert.doesNotMatch(source, /remote-debugging-port|connectOverCDP|WebSocket/);
  assert.doesNotMatch(
    source,
    /grantedTabs/,
    'per-tab grant state must not come back silently',
  );
  assert.doesNotMatch(
    source,
    /chrome\.action/,
    'the Browser Use bridge must not override the existing Qwen toolbar action',
  );
});

test('smoke: openTabs lists eligible user tabs and derived popups need recent agent input on a controlled opener', async () => {
  const source = await readFile(
    join(extensionRoot, 'src/background/browser-use-bridge.js'),
    'utf8',
  );
  const tabs = new Map<number, Record<string, unknown>>([
    [
      1,
      {
        id: 1,
        title: 'Opener',
        url: 'https://app.example/',
        active: true,
        windowId: 1,
        lastAccessed: 1_000,
        groupId: -1,
      },
    ],
    [
      9,
      {
        id: 9,
        title: 'Settings',
        url: 'chrome://settings/',
        active: false,
        windowId: 1,
        lastAccessed: 9_000,
        groupId: -1,
      },
    ],
  ]);
  const debuggerCommands: Array<{
    tabId: number;
    method: string;
    params: Record<string, unknown>;
  }> = [];
  const groupCalls: Array<{ tabIds: number[]; groupId?: number }> = [];
  const ungroupCalls: number[][] = [];
  const groupUpdates: Array<{ groupId: number; title: string; color: string }> =
    [];
  const detachedTabIds: number[] = [];
  const debuggerAttachedTabIds = new Set<number>();
  const postedMessages: unknown[] = [];
  let releaseSlowCreate: (() => void) | undefined;
  let nextTabId = 5;
  let failUngroupTabId: number | undefined;
  let hangOverlayCleanup = false;
  let hangCursorOverlay = false;
  let nextGroupId = 100;
  const listeners: Record<string, (...args: unknown[]) => unknown> = {};
  const sessionState: Record<string, unknown> = {};
  const noOpEvent = (name: string) => ({
    addListener(listener: (...args: unknown[]) => unknown) {
      listeners[name] = listener;
    },
  });
  const port = {
    onMessage: noOpEvent('nativeMessage'),
    onDisconnect: noOpEvent('nativeDisconnect'),
    postMessage(message: unknown) {
      postedMessages.push(message);
    },
  };
  const context = vm.createContext({
    atob,
    console,
    setTimeout,
    clearTimeout,
    TextDecoder,
    Uint8Array,
    chrome: {
      runtime: { id: 'extension-id', connectNative: () => port },
      storage: {
        session: {
          async get(keys: string | string[]) {
            const wanted = Array.isArray(keys) ? keys : [keys];
            return Object.fromEntries(
              wanted
                .filter((key) => key in sessionState)
                .map((key) => [key, sessionState[key]]),
            );
          },
          async set(value: Record<string, unknown>) {
            Object.assign(sessionState, value);
          },
        },
      },
      tabs: {
        async query() {
          return [...tabs.values()];
        },
        async get(tabId: number) {
          return tabs.get(tabId);
        },
        async create(options: { active: boolean }) {
          assert.equal(
            options.active,
            false,
            'agent tabs must open in the background',
          );
          if (releaseSlowCreate !== undefined) {
            await new Promise<void>((resolve) => {
              const release = releaseSlowCreate;
              releaseSlowCreate = () => {
                release?.();
                resolve();
              };
            });
          }
          const id = nextTabId++;
          const tab = {
            id,
            title: 'Agent tab',
            url: 'about:blank',
            active: options.active,
            windowId: 1,
            groupId: -1,
          };
          tabs.set(id, tab);
          return tab;
        },
        async remove(tabId: number) {
          tabs.delete(tabId);
          await listeners.tabRemoved?.(tabId);
        },
        async update() {},
        async group({
          tabIds,
          groupId,
        }: {
          tabIds: number[];
          groupId?: number;
        }) {
          const resolvedGroupId = groupId ?? nextGroupId++;
          groupCalls.push({
            tabIds: [...tabIds],
            ...(groupId === undefined ? {} : { groupId }),
          });
          for (const tabId of tabIds) {
            const tab = tabs.get(tabId);
            if (tab !== undefined) tab.groupId = resolvedGroupId;
          }
          return resolvedGroupId;
        },
        async ungroup(tabIds: number | number[]) {
          const ids = Array.isArray(tabIds) ? tabIds : [tabIds];
          if (
            failUngroupTabId !== undefined &&
            ids.includes(failUngroupTabId)
          ) {
            throw new Error('ungroup failed');
          }
          ungroupCalls.push(ids);
          for (const tabId of ids) {
            const tab = tabs.get(tabId);
            if (tab !== undefined) tab.groupId = -1;
          }
        },
        onCreated: noOpEvent('tabCreated'),
        onRemoved: noOpEvent('tabRemoved'),
      },
      tabGroups: {
        async get(groupId: number) {
          const update = [...groupUpdates]
            .reverse()
            .find((entry) => entry.groupId === groupId);
          return { id: groupId, title: update?.title ?? '' };
        },
        async update(
          groupId: number,
          update: { title: string; color: string },
        ) {
          groupUpdates.push({ groupId, ...update });
        },
      },
      history: {
        async search({ text }: { text: string }) {
          return [
            {
              url: 'https://app.example/invoice/2',
              title: 'Invoice 2',
              lastVisitTime: 2_000,
            },
            {
              url: 'https://app.example/invoice/1',
              title: 'Invoice 1',
              lastVisitTime: 1_000,
            },
            {
              url: 'https://app.example/no-time',
              title: 'Invoice missing timestamp',
            },
            {
              url: 'chrome://history/',
              title: 'History',
              lastVisitTime: 3_000,
            },
          ].filter(
            (item) =>
              text === '' ||
              item.title.toLowerCase().includes(text.toLowerCase()),
          );
        },
      },
      debugger: {
        async attach({ tabId }: { tabId: number }) {
          if (tabId === 3 || debuggerAttachedTabIds.has(tabId))
            throw new Error('Another debugger is already attached to the tab');
          debuggerAttachedTabIds.add(tabId);
        },
        async detach({ tabId }: { tabId: number }) {
          detachedTabIds.push(tabId);
          debuggerAttachedTabIds.delete(tabId);
        },
        async sendCommand(
          { tabId }: { tabId: number },
          method: string,
          params: Record<string, unknown> = {},
        ) {
          debuggerCommands.push({ tabId, method, params });
          if (method === 'Runtime.callFunctionOn') {
            return await new Promise(() => undefined);
          }
          if (
            hangOverlayCleanup &&
            method === 'Runtime.evaluate' &&
            String(params.expression).includes('?.destroy()')
          ) {
            return await new Promise(() => undefined);
          }
          if (
            hangCursorOverlay &&
            method === 'Runtime.evaluate' &&
            String(params.expression).includes('?.move(')
          ) {
            return await new Promise(() => undefined);
          }
          if (method === 'Page.addScriptToEvaluateOnNewDocument')
            return { identifier: `overlay-${tabId}` };
          return {};
        },
        onDetach: noOpEvent('debuggerDetached'),
        onEvent: noOpEvent('debuggerEvent'),
      },
    },
  });
  vm.runInContext(
    `${source}\n;globalThis.__popupTest = { attachedTabs, inFlightDispatches, dispatch, trackDerivedTab, waitForGroups: () => groupOperation };`,
    context,
  );
  const api = (
    context as unknown as {
      __popupTest: {
        attachedTabs: Set<number>;
        inFlightDispatches: Set<Promise<void>>;
        dispatch(
          method: string,
          params?: Record<string, unknown>,
        ): Promise<unknown>;
        trackDerivedTab(tab: Record<string, unknown>): void;
        waitForGroups(): Promise<void>;
      };
    }
  ).__popupTest;
  const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
  const listed = async (): Promise<Array<Record<string, unknown>>> =>
    plain(await api.dispatch('tabs.queryOpen')) as Array<
      Record<string, unknown>
    >;
  const listedDerived = async (): Promise<Array<Record<string, unknown>>> =>
    plain(await api.dispatch('tabs.queryDerived')) as Array<
      Record<string, unknown>
    >;

  await new Promise((resolve) => setTimeout(resolve, 0));

  // Installing the extension is the consent: an untouched HTTP(S) user tab is
  // already discoverable, while other URL schemes stay out of user discovery.
  assert.deepEqual(await listed(), [
    {
      providerTabId: 1,
      title: 'Opener',
      url: 'https://app.example/',
      active: true,
      windowId: 1,
      lastOpened: new Date(1_000).toISOString(),
    },
  ]);
  await assert.rejects(api.dispatch('tabs.attach', { tabId: 9 }), /http\(s\)/);
  await assert.rejects(
    api.dispatch('tabs.close', { tabId: 9 }),
    /not controlled/,
  );

  await api.dispatch('tabs.attach', { tabId: 1 });
  hangOverlayCleanup = true;
  const detaching = api.dispatch('tabs.detach', { tabId: 1 });
  await waitFor(() => !api.attachedTabs.has(1));
  await assert.rejects(
    api.dispatch('cdp.send', {
      tabId: 1,
      method: 'Page.enable',
      params: {},
    }),
    (error: unknown) =>
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'TAB_DEBUGGER_CONFLICT',
  );
  await detaching;
  hangOverlayCleanup = false;
  assert.ok(
    debuggerCommands.some(
      (command) =>
        command.method === 'Page.removeScriptToEvaluateOnNewDocument',
    ),
  );
  assert.ok(
    debuggerCommands.some(
      (command) =>
        command.method === 'Runtime.evaluate' &&
        String(command.params.expression).includes('?.destroy()'),
    ),
  );

  await api.dispatch('tabs.attach', { tabId: 1 });
  const unsolicited = {
    id: 2,
    openerTabId: 1,
    title: 'Unsolicited',
    url: 'about:blank',
    active: true,
    windowId: 1,
    lastAccessed: 4_000,
    groupId: -1,
  };
  tabs.set(2, unsolicited);
  api.trackDerivedTab(unsolicited);
  assert.equal(
    (await listedDerived()).find((tab) => tab.providerTabId === 2)
      ?.derivedFromProviderTabId,
    undefined,
    'a popup without recent agent input must not enter the derived-tab listing',
  );

  hangCursorOverlay = true;
  await api.dispatch('cdp.send', {
    tabId: 1,
    method: 'Input.dispatchMouseEvent',
    params: { type: 'mousePressed', x: 10, y: 10 },
  });
  hangCursorOverlay = false;
  assert.ok(
    debuggerCommands.some(
      (command) =>
        command.method === 'Runtime.evaluate' &&
        String(command.params.expression).includes('?.move(10, 10, true)'),
    ),
  );
  const derived = {
    id: 3,
    openerTabId: 1,
    title: 'OAuth',
    url: 'about:blank',
    active: true,
    windowId: 1,
    lastAccessed: 3_000,
    groupId: -1,
  };
  tabs.set(3, derived);
  api.trackDerivedTab(derived);
  await api.waitForGroups();
  assert.equal(
    (await listedDerived()).find((tab) => tab.providerTabId === 3)
      ?.derivedFromProviderTabId,
    1,
  );
  await assert.rejects(
    api.dispatch('cdp.send', {
      tabId: 3,
      method: 'Page.enable',
      params: {},
    }),
    /Another debugger is already attached/,
  );

  const unrelated = {
    id: 4,
    openerTabId: 99,
    title: 'Other',
    url: 'about:blank',
    active: true,
    windowId: 1,
    lastAccessed: 2_000,
    groupId: -1,
  };
  tabs.set(4, unrelated);
  api.trackDerivedTab(unrelated);
  assert.equal(
    (await listedDerived()).find((tab) => tab.providerTabId === 4)
      ?.derivedFromProviderTabId,
    undefined,
    'a popup whose opener is not controlled must not enter the derived-tab listing',
  );

  // about:blank stays out of ordinary user-tab discovery. Derived popups use a
  // separate internal listing.
  assert.deepEqual(
    (await listed()).map((tab) => tab.providerTabId),
    [1],
  );
  assert.deepEqual(
    (await listedDerived()).map((tab) => tab.providerTabId),
    [3],
  );

  await api.dispatch('session.name', { name: 'Research run' });
  const created = (await api.dispatch('tabs.create')) as {
    providerTabId: number;
  };
  assert.equal(created.providerTabId, 5);
  assert.equal(tabs.get(5)?.active, false);
  assert.equal(tabs.get(1)?.active, true);
  assert.ok(
    groupCalls.some((call) => call.tabIds.includes(3)),
    'causally derived popups must join the agent group',
  );
  assert.ok(
    groupCalls.some((call) => call.tabIds.includes(5)),
    'tabs.new tabs must join the agent group',
  );
  assert.equal(
    groupCalls.some((call) => call.tabIds.includes(1)),
    false,
    'claimed user tabs must not be grouped',
  );
  assert.ok(
    groupUpdates.some(
      (update) => update.title === 'Research run' && update.color === 'blue',
    ),
  );
  assert.equal(
    (await listedDerived()).find((tab) => tab.providerTabId === 3)?.tabGroup,
    'Research run',
    'listings must expose the tab group name the user can see',
  );
  const overlayBootstrap = debuggerCommands.find(
    (command) =>
      command.method === 'Page.addScriptToEvaluateOnNewDocument' &&
      String(command.params.source).includes('__qwen-browser-overlay'),
  );
  assert.ok(overlayBootstrap);
  assertOverlayLifecycle(String(overlayBootstrap.params.source));

  failUngroupTabId = 5;
  const createdTab = tabs.get(5);
  assert.ok(createdTab);
  createdTab.url = 'data:text/plain,finished';
  await assert.rejects(
    api.dispatch('tabs.release', { tabId: 5 }),
    /ungroup failed/,
  );
  assert.deepEqual(
    plain(sessionState.agentOwnedTabs),
    [3, 5],
    'a failed ungroup must retain ownership for cleanup or retry',
  );
  failUngroupTabId = undefined;
  await api.dispatch('tabs.release', { tabId: 5 });
  assert.ok(
    detachedTabIds.includes(5),
    'releasing a created tab must detach the debugger',
  );
  assert.ok(
    ungroupCalls.some((tabIds) => tabIds.includes(5)),
    'releasing a created tab must remove its Browser Use grouping',
  );
  assert.deepEqual(
    plain(sessionState.agentOwnedTabs),
    [3],
    'releasing a created tab must clear extension ownership',
  );

  const disposable = (await api.dispatch('tabs.create')) as {
    providerTabId: number;
  };
  const disposableTab = tabs.get(disposable.providerTabId);
  assert.ok(disposableTab);
  disposableTab.url = 'data:text/plain,disposable';
  await api.dispatch('tabs.close', { tabId: disposable.providerTabId });
  assert.equal(
    tabs.has(disposable.providerTabId),
    false,
    'cleanup must close an owned tab even after it navigates off HTTP(S)',
  );

  assert.deepEqual(
    plain(
      await api.dispatch('history.query', { queries: ['invoice'], limit: 5 }),
    ),
    [
      {
        url: 'https://app.example/invoice/2',
        title: 'Invoice 2',
        dateVisited: new Date(2_000).toISOString(),
      },
      {
        url: 'https://app.example/invoice/1',
        title: 'Invoice 1',
        dateVisited: new Date(1_000).toISOString(),
      },
    ],
  );
  await assert.rejects(
    api.dispatch('history.query', { queries: [] }),
    /between 1 and 20/,
  );
  await assert.rejects(
    api.dispatch('history.query', { queries: [' '] }),
    /non-empty/,
  );
  await assert.rejects(
    api.dispatch('history.query', { from: 'not-a-date' }),
    /valid date/,
  );

  const chunkedRequest = Buffer.from(
    JSON.stringify({
      type: 'request',
      id: 'chunked-query',
      method: 'tabs.queryOpen',
      params: {},
    }),
  );
  const splitAt = Math.floor(chunkedRequest.length / 2);
  for (const [index, part] of [
    chunkedRequest.subarray(0, splitAt),
    chunkedRequest.subarray(splitAt),
  ].entries()) {
    listeners['nativeMessage']?.({
      type: 'qwen.browser.chunk',
      id: 'chunk-1',
      index,
      total: 2,
      data: part.toString('base64'),
    });
  }
  await waitFor(() =>
    postedMessages.some(
      (message) =>
        typeof message === 'object' &&
        message !== null &&
        'id' in message &&
        message.id === 'chunked-query',
    ),
  );

  detachedTabIds.length = 0;
  releaseSlowCreate = () => undefined;
  const slowCreatedTabId = nextTabId;
  listeners['nativeMessage']?.({
    type: 'request',
    id: 'slow-create',
    method: 'tabs.create',
    params: {},
  });
  listeners['nativeMessage']?.({
    type: 'request',
    id: 'hanging-cdp',
    method: 'cdp.send',
    params: {
      tabId: 1,
      method: 'Runtime.callFunctionOn',
      params: { awaitPromise: true },
    },
  });
  await waitFor(() =>
    debuggerCommands.some(
      (command) => command.method === 'Runtime.callFunctionOn',
    ),
  );
  hangOverlayCleanup = true;
  listeners['nativeDisconnect']?.();
  releaseSlowCreate();
  await waitFor(() => detachedTabIds.length === 1);
  assert.deepEqual(detachedTabIds, [1]);
  assert.deepEqual(ungroupCalls, [[5], [3]]);
  assert.equal(
    groupCalls.some((call) => call.tabIds.includes(slowCreatedTabId)),
    false,
    'a tab created after disconnect must not regain Browser Use ownership',
  );
  assert.equal(
    tabs.has(6),
    false,
    'a tab created after disconnect must be closed instead of orphaned',
  );
  assert.equal(
    postedMessages.some(
      (message) =>
        typeof message === 'object' &&
        message !== null &&
        'id' in message &&
        message.id === 'slow-create',
    ),
    false,
    'a disconnected port must not receive the late response',
  );
  assert.deepEqual(plain(sessionState.agentOwnedTabs), []);
  assert.deepEqual(plain(sessionState.derivedTabParents), []);
  assert.deepEqual(plain(sessionState.managedGroupIdsByWindow), []);
  assert.equal(api.inFlightDispatches.size, 0);
});

function assertOverlayLifecycle(source: string): void {
  const overlayDocument = document.implementation.createHTMLDocument('Page');
  const originalHtml = overlayDocument.documentElement.outerHTML;
  const timers = new Map<number, () => void>();
  let nextTimerId = 0;
  const context = vm.createContext({
    document: overlayDocument,
    setTimeout(callback: () => void, delay: number) {
      assert.equal(delay, 2_500);
      timers.set(++nextTimerId, callback);
      return nextTimerId;
    },
    clearTimeout(id: number) {
      timers.delete(id);
    },
  });
  vm.runInContext(source, context);
  assert.equal(
    overlayDocument.documentElement.outerHTML,
    originalHtml,
    'attaching a read-only page must not add overlay DOM',
  );
  assert.equal(timers.size, 0);
  const controller = vm.runInContext(
    'globalThis.__qwenBrowserOverlay',
    context,
  ) as {
    move(x: number, y: number, pressed: boolean): void;
    destroy(): void;
  };
  controller.move(12, 34, true);
  const firstRoot = overlayDocument.getElementById('__qwen-browser-overlay');
  assert.ok(firstRoot);
  assert.equal(firstRoot.style.transform, 'translate3d(12px, 34px, 0)');
  assert.equal(firstRoot.style.pointerEvents, 'none');
  assert.equal(firstRoot.getAttribute('aria-hidden'), 'true');
  assert.equal(
    firstRoot.shadowRoot
      ?.querySelector('.shell')
      ?.classList.contains('pressed'),
    true,
  );
  assert.equal(
    firstRoot.style.all,
    '',
    'the inline reset expands into hundreds of serialized CSS declarations',
  );
  assert.ok((firstRoot.getAttribute('style')?.length ?? 0) < 500);
  assert.ok(
    firstRoot.shadowRoot
      ?.querySelector('style')
      ?.textContent?.includes(':host{all:initial}'),
  );

  controller.move(56, 78, false);
  assert.equal(timers.size, 1, 'new input must reset the expiry timer');
  const expire = timers.get(nextTimerId);
  assert.ok(expire);
  timers.delete(nextTimerId);
  expire();
  assert.equal(
    overlayDocument.documentElement.outerHTML,
    originalHtml,
    'the overlay must leave no DOM behind after input stops',
  );

  controller.move(90, 12, false);
  const secondRoot = overlayDocument.getElementById('__qwen-browser-overlay');
  assert.ok(secondRoot);
  assert.notEqual(
    secondRoot,
    firstRoot,
    'later input must remount the overlay',
  );
  assert.equal(secondRoot.style.transform, 'translate3d(90px, 12px, 0)');
  controller.destroy();
  assert.equal(timers.size, 0);
  assert.equal(overlayDocument.documentElement.outerHTML, originalHtml);
  assert.equal(
    vm.runInContext('globalThis.__qwenBrowserOverlay', context),
    undefined,
  );
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for Browser Use bridge cleanup');
}
