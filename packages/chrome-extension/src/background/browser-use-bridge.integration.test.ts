/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path, { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, vi } from 'vitest';
import vm from 'node:vm';

// Resolved from this module, not process.cwd(), so the suite also passes via
// `vitest run --root packages/chrome-extension` from the repository root.
// (String form: under jsdom the global URL is not one Node's fs accepts.)
const extensionRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const bridgeSource = await readFile(
  join(extensionRoot, 'src/background/browser-use-bridge.js'),
  'utf8',
);

// AGENTS.md forbids relative imports between packages, so the SDK's identity
// and protocol constants are pinned by reading their source text, the way
// packages/live-host/src/main/__tests__/protocol.test.ts pins the live protocol.
const sdkProtocolSource = await readFile(
  join(extensionRoot, '../browser-use/src/bridge/protocol.ts'),
  'utf8',
);
const sdkChunkSource = await readFile(
  join(
    extensionRoot,
    '../browser-use/src/bridge/native-host/native-messaging-output.ts',
  ),
  'utf8',
);

function sourceConstant(source: string, name: string): string {
  const match = source.match(
    new RegExp(`\\b${name} = (?:'([^']*)'|(\\d+));`, 'u'),
  );
  assert.ok(match, `${name} must be declared as a string or integer literal`);
  return match[1] ?? match[2];
}

const CHROME_EXTENSION_ID = sourceConstant(
  sdkProtocolSource,
  'CHROME_EXTENSION_ID',
);
const CHROME_NATIVE_HOST_NAME = sourceConstant(
  sdkProtocolSource,
  'CHROME_NATIVE_HOST_NAME',
);
const CHROME_BRIDGE_PROTOCOL_VERSION = Number(
  sourceConstant(sdkProtocolSource, 'CHROME_BRIDGE_PROTOCOL_VERSION'),
);
const NATIVE_MESSAGE_CHUNK_TYPE = sourceConstant(
  sdkChunkSource,
  'NATIVE_MESSAGE_CHUNK_TYPE',
);

test('bridge identity and protocol constants match the SDK source of truth', () => {
  assert.match(CHROME_EXTENSION_ID, /^[a-p]{32}$/);
  assert.ok(Number.isInteger(CHROME_BRIDGE_PROTOCOL_VERSION));
  assert.equal(
    Number(sourceConstant(bridgeSource, 'PROTOCOL_VERSION')),
    CHROME_BRIDGE_PROTOCOL_VERSION,
  );
  assert.equal(
    sourceConstant(bridgeSource, 'NATIVE_MESSAGE_CHUNK_TYPE'),
    NATIVE_MESSAGE_CHUNK_TYPE,
  );
  assert.equal(
    sourceConstant(bridgeSource, 'NATIVE_HOST'),
    CHROME_NATIVE_HOST_NAME,
  );
});

test('profile identity persists before hello and survives reconnects and worker restarts', async () => {
  const source = bridgeSource;
  const startWorker = async (
    localState: Record<string, unknown>,
    failSave = false,
  ) => {
    // Every hello the port receives is recorded together with the identity
    // persisted at that moment; the ordering invariant is asserted on this
    // record outside the bridge, which wraps postMessage in a bare catch
    // that would swallow an assertion thrown from inside the mock.
    const hellos: Array<{
      extensionInstanceId: string;
      protocolVersion: number;
      persistedInstanceId: unknown;
    }> = [];
    const listeners: Record<string, (...args: unknown[]) => void> = {};
    const event = (name: string) => ({
      addListener: (callback: (...args: unknown[]) => void) => {
        listeners[name] = callback;
      },
    });
    const port = {
      onMessage: event('message'),
      onDisconnect: event('disconnect'),
      postMessage: (hello: {
        extensionInstanceId: string;
        protocolVersion: number;
      }) => {
        hellos.push({
          ...hello,
          persistedInstanceId: localState.browserUseInstanceId,
        });
      },
    };
    const context = vm.createContext({
      crypto: webcrypto,
      setTimeout,
      clearTimeout,
      chrome: {
        runtime: { id: CHROME_EXTENSION_ID, connectNative: () => port },
        alarms: {
          get: async () => undefined,
          create: async () => undefined,
          onAlarm: event('alarm'),
        },
        storage: {
          local: {
            get: async () => ({ ...localState }),
            set: async (value: Record<string, unknown>) => {
              if (failSave) {
                failSave = false;
                throw new Error('storage write failed');
              }
              Object.assign(localState, value);
            },
          },
          session: { get: async () => ({}), set: async () => undefined },
        },
        tabs: {
          query: async () => [],
          onCreated: event('created'),
          onRemoved: event('removed'),
        },
        debugger: { onDetach: event('detached'), onEvent: event('cdp') },
      },
    });
    vm.runInContext(source, context);
    await new Promise((resolve) => setTimeout(resolve, 0));
    return { hellos, listeners };
  };
  const state: Record<string, unknown> = {};
  const first = await startWorker(state, true);
  assert.equal(first.hellos.length, 0, 'no unpersisted identity may connect');
  first.listeners.alarm({ name: 'browser-use-reconnect' });
  first.listeners.alarm({ name: 'browser-use-reconnect' });
  await vi.waitFor(() => assert.equal(first.hellos.length, 1));
  const persistedBeforeConnecting = () => {
    for (const hello of first.hellos)
      assert.equal(
        hello.persistedInstanceId,
        hello.extensionInstanceId,
        'persist before connecting',
      );
  };
  persistedBeforeConnecting();
  const identity = first.hellos[0].extensionInstanceId;
  assert.match(identity, /^[0-9a-f-]{36}$/);
  assert.equal(first.hellos[0].protocolVersion, CHROME_BRIDGE_PROTOCOL_VERSION);
  first.listeners.disconnect();
  first.listeners.alarm({ name: 'browser-use-reconnect' });
  await vi.waitFor(() => assert.equal(first.hellos.length, 2));
  persistedBeforeConnecting();
  assert.equal(first.hellos[1].extensionInstanceId, identity);
  const restarted = await startWorker(state);
  assert.equal(restarted.hellos[0].extensionInstanceId, identity);
  const other = await startWorker({});
  assert.notEqual(other.hellos[0].extensionInstanceId, identity);
});

// The permission list itself is owned by sidepanel-assets.test.ts.
test('unpacked extension has a stable id matching the SDK and asks for nothing optional', async () => {
  const manifest = JSON.parse(
    await readFile(join(extensionRoot, 'public/manifest.json'), 'utf8'),
  ) as {
    key: string;
    minimum_chrome_version: string;
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

// Pins browser-use-bridge.js only: service-worker.ts legitimately opens a
// WebSocket for the daemon ACP socket, so this must not widen to the bundle.
test('browser-use-bridge.js drives Chrome over Native Messaging and CDP without a debug port or socket of its own', () => {
  const source = bridgeSource;
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
  const source = bridgeSource;
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
  let failGroupUpdateOnce = false;
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
    crypto: webcrypto,
    console,
    setTimeout,
    clearTimeout,
    TextDecoder,
    TextEncoder,
    Uint8Array,
    chrome: {
      runtime: { id: CHROME_EXTENSION_ID, connectNative: () => port },
      alarms: {
        get: async () => undefined,
        create: async () => undefined,
        onAlarm: noOpEvent('alarm'),
      },
      storage: {
        local: {
          get: async () => ({ browserUseInstanceId: 'test-profile' }),
        },
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
          const tab = tabs.get(tabId);
          if (!tab) throw new Error('No tab with this id');
          return tab;
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
          if (failGroupUpdateOnce) {
            failGroupUpdateOnce = false;
            // Chromium's kTabStripNotEditableError, e.g. during a tab drag.
            throw new Error(
              'Tabs cannot be edited right now (user may be dragging a tab).',
            );
          }
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
              // Matches the 'invoice' query so the bridge, not this mock,
              // has to keep the chrome:// scheme out of the result.
              url: 'chrome://history/',
              title: 'Invoice history',
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
          if (
            method === 'Runtime.evaluate' &&
            params.expression === 'oversizedResult'
          ) {
            return {
              result: { type: 'string', value: '界'.repeat(6 * 1024 * 1024) },
            };
          }
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
    // trackDerivedTab persists before it groups, so the barrier must cover the
    // in-flight dispatch as well as groupOperation (cleanupBackendState's shape).
    `${source}\n;globalThis.__popupTest = { attachedTabs, inFlightDispatches, dispatch, trackDerivedTab, waitForGroups: () => Promise.all([...inFlightDispatches, groupOperation]).then(() => undefined) };`,
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

  assert.deepEqual(
    plain(postedMessages[0]),
    {
      type: 'hello',
      protocolVersion: CHROME_BRIDGE_PROTOCOL_VERSION,
      extensionId: CHROME_EXTENSION_ID,
      extensionInstanceId: 'test-profile',
    },
    'the hello frame must carry the SDK-pinned protocol version and extension id',
  );

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
  await assert.rejects(api.dispatch('tabs.close', { tabId: 9 }), {
    code: 'TAB_NOT_OWNED',
  });
  assert.ok(tabs.has(9));
  await assert.rejects(api.dispatch('tabs.close', { tabId: 99 }), {
    code: 'STALE_TAB',
  });

  await api.dispatch('tabs.attach', { tabId: 1 });
  hangOverlayCleanup = true;
  const detaching = api.dispatch('tabs.detach', { tabId: 1 });
  const reattaching = api.dispatch('cdp.send', {
    tabId: 1,
    method: 'Page.enable',
    params: {},
  });
  await Promise.all([detaching, reattaching]);
  assert.ok(debuggerAttachedTabIds.has(1));
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
  assert.deepEqual(
    (plain(postedMessages) as Array<Record<string, unknown>>).filter(
      (message) => message.method === 'qwenBrowser.derivedTabTracked',
    ),
    [
      {
        type: 'event',
        tabId: 3,
        method: 'qwenBrowser.derivedTabTracked',
        params: { openerTabId: 1 },
      },
    ],
    'the backend must learn about a derived popup once it is tracked and grouped',
  );
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
  assertOverlayLifecycle(String(overlayBootstrap.params.source), true);
  assertOverlayToleratesBareDocument(String(overlayBootstrap.params.source));

  const responseFor = (id: string) =>
    postedMessages.find(
      (message) =>
        typeof message === 'object' &&
        message !== null &&
        'id' in message &&
        message.id === id,
    ) as { ok: boolean; error?: { code: string } } | undefined;
  listeners['nativeMessage']?.({
    type: 'request',
    id: 'oversized-result',
    method: 'cdp.send',
    params: {
      tabId: 1,
      method: 'Runtime.evaluate',
      params: { expression: 'oversizedResult', returnByValue: true },
    },
  });
  await waitFor(() => responseFor('oversized-result') !== undefined);
  const oversizedResponse = responseFor('oversized-result');
  assert.ok(oversizedResponse);
  assert.equal(oversizedResponse.ok, false);
  assert.equal(oversizedResponse.error?.code, 'OPERATION_FAILED');
  assert.ok(Buffer.byteLength(JSON.stringify(oversizedResponse)) < 1_024);
  assert.ok(api.attachedTabs.has(1));
  listeners['nativeMessage']?.({
    type: 'request',
    id: 'after-oversized-result',
    method: 'cdp.send',
    params: { tabId: 1, method: 'Page.enable', params: {} },
  });
  await waitFor(() => responseFor('after-oversized-result') !== undefined);
  assert.equal(responseFor('after-oversized-result')?.ok, true);
  assert.ok(debuggerAttachedTabIds.has(1));

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

  // Grouping is cosmetic: Chrome refuses tab-strip edits while the user drags
  // a tab, and that must not close the tab tabs.create just opened.
  failGroupUpdateOnce = true;
  const groupUpdatesBeforeFault = groupUpdates.length;
  const survivor = (await api.dispatch('tabs.create')) as {
    providerTabId: number;
  };
  assert.equal(failGroupUpdateOnce, false, 'the group title fault must fire');
  assert.ok(
    tabs.has(survivor.providerTabId),
    'a failed tab-group edit must not close the tab that was just created',
  );
  assert.ok(api.attachedTabs.has(survivor.providerTabId));
  assert.ok(
    (plain(sessionState.agentOwnedTabs) as number[]).includes(
      survivor.providerTabId,
    ),
    'ownership of the surviving tab must be persisted',
  );
  assert.equal(groupUpdates.length, groupUpdatesBeforeFault);

  const disposable = (await api.dispatch('tabs.create')) as {
    providerTabId: number;
  };
  assert.ok(
    groupUpdates
      .slice(groupUpdatesBeforeFault)
      .some((update) => update.title === 'Research run'),
    'the next created tab must re-apply the session title to the group',
  );
  const disposableTab = tabs.get(disposable.providerTabId);
  assert.ok(disposableTab);
  disposableTab.url = 'data:text/plain,disposable';
  await api.dispatch('tabs.close', { tabId: disposable.providerTabId });
  assert.equal(
    tabs.has(disposable.providerTabId),
    false,
    'cleanup must close an owned tab even after it navigates off HTTP(S)',
  );
  await api.dispatch('tabs.close', { tabId: survivor.providerTabId });
  assert.equal(tabs.has(survivor.providerTabId), false);

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
      type: NATIVE_MESSAGE_CHUNK_TYPE,
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
  assert.equal(sessionState.sessionName, 'Research run');
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
  await waitFor(
    () => !tabs.has(slowCreatedTabId),
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
  assert.equal(
    sessionState.sessionName,
    'Qwen Browser',
    'disconnect must reset the session name so a new session does not inherit it',
  );
  assert.equal(api.inFlightDispatches.size, 0);
});

function assertOverlayLifecycle(source: string, preplant = false): void {
  const overlayDocument = document.implementation.createHTMLDocument('Page');
  const planted = preplant ? overlayDocument.createElement('div') : undefined;
  if (planted) {
    planted.id = '__qwen-browser-overlay';
    planted.style.cssText =
      'position:fixed;inset:0;pointer-events:auto;z-index:5;background:red';
    overlayDocument.body.appendChild(planted);
  }
  const plantedHtml = planted?.outerHTML;
  const ownedRoot = () =>
    [
      ...overlayDocument.querySelectorAll<HTMLDivElement>(
        '#__qwen-browser-overlay',
      ),
    ].find((element) => element !== planted);
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
  vm.runInContext(source, context);
  assert.equal(
    vm.runInContext('globalThis.__qwenBrowserOverlay', context),
    controller,
  );
  controller.move(12, 34, true);
  assert.equal(planted?.outerHTML, plantedHtml);
  const firstRoot = ownedRoot();
  assert.ok(firstRoot);
  assertOverlayHostVisible(firstRoot);
  assert.equal(firstRoot.style.transform, 'translate3d(12px, 34px, 0)');
  assert.equal(firstRoot.style.pointerEvents, 'none');
  assert.equal(firstRoot.getAttribute('aria-hidden'), 'true');
  const pressed = () =>
    firstRoot.shadowRoot
      ?.querySelector('.shell')
      ?.classList.contains('pressed');
  assert.equal(pressed(), true);
  assert.equal(
    firstRoot.style.all,
    '',
    'the inline reset expands into hundreds of serialized CSS declarations',
  );
  assert.ok((firstRoot.getAttribute('style')?.length ?? 0) < 500);
  const overlayStyle =
    firstRoot.shadowRoot?.querySelector('style')?.textContent ?? '';
  assert.ok(overlayStyle.includes(':host{all:initial}'));
  assert.ok(
    overlayStyle.includes(
      '.shell.pressed .cursor,.shell.pressed .label{background:#d93025}',
    ),
    'a press must recolour the cursor and label so the user sees the click',
  );
  assert.ok(
    overlayStyle.includes('.shell.pressed .ring{opacity:1;transform:scale(1)}'),
    'a press must reveal the click ring',
  );

  controller.move(56, 78, false);
  assert.equal(pressed(), false, 'a release must clear the pressed state');
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
  const secondRoot = ownedRoot();
  assert.ok(secondRoot);
  assert.notEqual(
    secondRoot,
    firstRoot,
    'later input must remount the overlay',
  );
  assertOverlayHostVisible(secondRoot);
  assert.equal(secondRoot.style.transform, 'translate3d(90px, 12px, 0)');
  controller.destroy();
  assert.equal(timers.size, 0);
  assert.equal(overlayDocument.documentElement.outerHTML, originalHtml);
  assert.equal(
    vm.runInContext('globalThis.__qwenBrowserOverlay', context),
    undefined,
  );
}

// The host is created display:none and must be shown, viewport-fixed (CDP
// coordinates are viewport-relative) and above every page stacking context.
function assertOverlayHostVisible(root: HTMLDivElement): void {
  assert.equal(root.style.display, 'block', 'input must show the overlay host');
  assert.equal(root.style.position, 'fixed');
  assert.equal(root.style.zIndex, '2147483647');
}

function assertOverlayToleratesBareDocument(source: string): void {
  const bareDocument = document.implementation.createHTMLDocument('Bare');
  bareDocument.removeChild(bareDocument.documentElement);
  assert.equal(bareDocument.documentElement, null);
  // Only the doctype node remains; nothing may be added beside it.
  const bareChildCount = bareDocument.childNodes.length;
  const timers: Array<() => void> = [];
  const context = vm.createContext({
    document: bareDocument,
    setTimeout(callback: () => void) {
      timers.push(callback);
      return timers.length;
    },
    clearTimeout() {},
  });
  vm.runInContext(source, context);
  const controller = vm.runInContext(
    'globalThis.__qwenBrowserOverlay',
    context,
  ) as { move(x: number, y: number, pressed: boolean): void; destroy(): void };
  assert.doesNotThrow(
    () => controller.move(1, 2, true),
    'a document without a root element must not break the bootstrap',
  );
  assert.equal(
    bareDocument.childNodes.length,
    bareChildCount,
    'nothing may be mounted into a document without a root element',
  );
  assert.equal(bareDocument.documentElement, null);
  assert.equal(timers.length, 0);
  assert.doesNotThrow(() => controller.destroy());
}

async function waitFor(
  predicate: () => boolean,
  message = 'Timed out waiting for Browser Use bridge cleanup',
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
}
