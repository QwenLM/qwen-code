/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// @ts-check
/* global atob, chrome, clearTimeout, setTimeout, TextDecoder */

const NATIVE_HOST = 'com.qwen.browser';
const PROTOCOL_VERSION = 1;
/** @type {Set<number>} */
const attachedTabs = new Set();
/** @type {Map<number, number>} */
const derivedTabParents = new Map();
/** @type {Set<number>} */
const agentOwnedTabs = new Set();
/** @type {Map<number, number>} */
const managedGroupIdsByWindow = new Map();
/** @type {Map<number, string>} */
const overlayScriptIds = new Map();
/** @type {Map<number, number>} */
const derivedTabDeadlines = new Map();
/** @type {Set<Promise<void>>} */
const inFlightDispatches = new Set();
/** @type {Map<string, { chunks: (Uint8Array | undefined)[], received: number }>} */
const nativeMessageChunks = new Map();
const DERIVED_TAB_WINDOW_MS = 2_500;
const DISCONNECT_DRAIN_MS = 250;
const CDP_CLEANUP_TIMEOUT_MS = 250;
const NATIVE_MESSAGE_CHUNK_TYPE = 'qwen.browser.chunk';
const MAX_NATIVE_MESSAGE_CHUNKS = 32;
const DEFAULT_SESSION_NAME = 'Qwen Browser';
const AGENT_OVERLAY_GLOBAL = '__qwenBrowserOverlay';
const AGENT_OVERLAY_BOOTSTRAP = `(() => {
  const globalName = "${AGENT_OVERLAY_GLOBAL}";
  if (globalThis[globalName]) return;
  let root;
  let shell;
  let hideTimer;
  const mount = () => {
    if (!document.documentElement) {
      addEventListener("DOMContentLoaded", mount, { once: true });
      return;
    }
    root = document.getElementById("__qwen-browser-overlay");
    if (!root) {
      root = document.createElement("div");
      root.id = "__qwen-browser-overlay";
      root.setAttribute("aria-hidden", "true");
      Object.assign(root.style, {
        all: "initial",
        display: "none",
        position: "fixed",
        left: "0",
        top: "0",
        width: "92px",
        height: "42px",
        pointerEvents: "none",
        zIndex: "2147483647",
        transform: "translate3d(0, 0, 0)",
      });
      document.documentElement.appendChild(root);
    }
    const shadow = root.shadowRoot || root.attachShadow({ mode: "open" });
    if (!shadow.firstChild) {
      shadow.innerHTML = '<style>:host{all:initial}.shell{position:relative;width:92px;height:42px;filter:drop-shadow(0 2px 3px rgba(0,0,0,.3))}.cursor{width:21px;height:26px;background:#0b57d0;clip-path:polygon(0 0,0 100%,7px 77%,12px 100%,17px 97%,12px 73%,21px 72%)}.label{position:absolute;left:18px;top:17px;padding:3px 7px;border-radius:999px;background:#0b57d0;color:white;font:600 11px/14px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;white-space:nowrap}.shell.pressed .cursor,.shell.pressed .label{background:#d93025}.ring{position:absolute;left:-8px;top:-8px;width:30px;height:30px;border:2px solid rgba(11,87,208,.45);border-radius:50%;opacity:0;transform:scale(.6)}.shell.pressed .ring{opacity:1;transform:scale(1)}</style><div class="shell"><div class="ring"></div><div class="cursor"></div><div class="label">Qwen</div></div>';
    }
    shell = shadow.querySelector(".shell");
  };
  const controller = {
    move(x, y, pressed) {
      mount();
      if (!root) return;
      root.style.display = "block";
      root.style.transform = "translate3d(" + Math.round(x) + "px, " + Math.round(y) + "px, 0)";
      root.dataset.visible = "true";
      shell?.classList.toggle("pressed", pressed === true);
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => {
        if (!root) return;
        root.style.display = "none";
        root.dataset.visible = "false";
      }, 2_500);
    },
    destroy() {
      clearTimeout(hideTimer);
      root?.remove();
      delete globalThis[globalName];
    },
  };
  Object.defineProperty(globalThis, globalName, { value: controller, configurable: true });
  mount();
})();`;

/** @type {chrome.runtime.Port | undefined} */
let nativePort;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let reconnectTimer;
let sessionName = DEFAULT_SESSION_NAME;
let groupOperation = Promise.resolve();
let connectionGeneration = 0;

async function restoreState() {
  const stored = /** @type {{
    derivedTabParents?: unknown[],
    agentOwnedTabs?: unknown[],
    managedGroupIdsByWindow?: unknown[],
    sessionName?: unknown,
  }} */ (
    await chrome.storage.session.get([
      'derivedTabParents',
      'agentOwnedTabs',
      'managedGroupIdsByWindow',
      'sessionName',
    ])
  );
  for (const entry of stored.derivedTabParents || []) {
    if (!Array.isArray(entry) || entry.length !== 2) continue;
    const [tabId, parentTabId] = entry;
    if (typeof tabId === 'number' && typeof parentTabId === 'number') {
      derivedTabParents.set(tabId, parentTabId);
    }
  }
  for (const id of stored.agentOwnedTabs || []) {
    if (typeof id === 'number') agentOwnedTabs.add(id);
  }
  for (const entry of stored.managedGroupIdsByWindow || []) {
    if (!Array.isArray(entry) || entry.length !== 2) continue;
    const [windowId, groupId] = entry;
    if (typeof windowId === 'number' && typeof groupId === 'number') {
      managedGroupIdsByWindow.set(windowId, groupId);
    }
  }
  if (
    typeof stored.sessionName === 'string' &&
    stored.sessionName.trim() !== ''
  ) {
    sessionName = stored.sessionName;
  }
  const tabs = await chrome.tabs.query({});
  const existingIds = new Set(
    tabs.map((tab) => tab.id).filter(Number.isInteger),
  );
  for (const tabId of agentOwnedTabs)
    if (!existingIds.has(tabId)) agentOwnedTabs.delete(tabId);
  for (const tabId of [...derivedTabParents.keys()]) {
    if (!existingIds.has(tabId)) derivedTabParents.delete(tabId);
  }
  await Promise.all(
    tabs
      .filter((tab) => typeof tab.id === 'number' && agentOwnedTabs.has(tab.id))
      .map((tab) => groupAgentOwnedTab(tab, connectionGeneration)),
  );
  await persistState();
}

/** @param {number} [generation] */
async function persistState(generation = connectionGeneration) {
  await chrome.storage.session.set(stateSnapshot());
  if (generation !== connectionGeneration) {
    await chrome.storage.session.set(stateSnapshot());
  }
}

function stateSnapshot() {
  return {
    derivedTabParents: [...derivedTabParents],
    agentOwnedTabs: [...agentOwnedTabs],
    managedGroupIdsByWindow: [...managedGroupIdsByWindow],
    sessionName,
  };
}

function connectNative() {
  if (nativePort) return;
  // Unlike the /cdp path, a live Native Messaging port keeps the MV3 worker
  // alive on every supported Chrome version.
  try {
    const port = chrome.runtime.connectNative(NATIVE_HOST);
    nativePort = port;
    const generation = ++connectionGeneration;
    port.onMessage.addListener((message) => {
      const operation = handleNativeMessage(port, message, generation);
      inFlightDispatches.add(operation);
      void operation.then(
        () => inFlightDispatches.delete(operation),
        () => inFlightDispatches.delete(operation),
      );
    });
    port.onDisconnect.addListener(() => {
      if (nativePort !== port) return;
      nativePort = undefined;
      connectionGeneration += 1;
      void cleanupBackendState().finally(scheduleReconnect);
    });
    port.postMessage({
      type: 'hello',
      protocolVersion: PROTOCOL_VERSION,
      extensionId: chrome.runtime.id,
    });
  } catch {
    nativePort = undefined;
    connectionGeneration += 1;
    void cleanupBackendState().finally(scheduleReconnect);
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    connectNative();
  }, 1_000);
}

async function cleanupBackendState() {
  const operations = [...inFlightDispatches, groupOperation];
  await drainOperations(operations);
  for (const operation of operations) inFlightDispatches.delete(operation);
  groupOperation = Promise.resolve();
  await Promise.allSettled([...attachedTabs].map((tabId) => detach(tabId)));
  const ownedTabIds = [...agentOwnedTabs];
  await Promise.allSettled(
    ownedTabIds.map((tabId) => chrome.tabs.ungroup(tabId)),
  );
  attachedTabs.clear();
  derivedTabParents.clear();
  agentOwnedTabs.clear();
  managedGroupIdsByWindow.clear();
  overlayScriptIds.clear();
  derivedTabDeadlines.clear();
  nativeMessageChunks.clear();
  sessionName = DEFAULT_SESSION_NAME;
  await persistState();
}

/** @param {Promise<unknown>[]} operations */
async function drainOperations(operations) {
  await settleWithin(operations, DISCONNECT_DRAIN_MS);
}

/**
 * @param {Promise<unknown>[]} operations
 * @param {number} timeoutMs
 */
async function settleWithin(operations, timeoutMs) {
  if (operations.length === 0) return;
  let timer;
  await Promise.race([
    Promise.allSettled(operations),
    new Promise((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
}

/**
 * @param {chrome.runtime.Port} port
 * @param {unknown} message
 * @param {number} generation
 */
async function handleNativeMessage(port, message, generation) {
  if (
    typeof message !== 'object' ||
    message === null ||
    !('type' in message) ||
    message.type !== NATIVE_MESSAGE_CHUNK_TYPE
  ) {
    await handleBridgeMessage(port, message, generation);
    return;
  }
  if (
    !('id' in message) ||
    typeof message.id !== 'string' ||
    message.id.length === 0 ||
    message.id.length > 100 ||
    !('index' in message) ||
    typeof message.index !== 'number' ||
    !Number.isInteger(message.index) ||
    !('total' in message) ||
    typeof message.total !== 'number' ||
    !Number.isInteger(message.total) ||
    message.total < 1 ||
    message.total > MAX_NATIVE_MESSAGE_CHUNKS ||
    message.index < 0 ||
    message.index >= message.total ||
    !('data' in message) ||
    typeof message.data !== 'string'
  ) {
    return;
  }
  let state = nativeMessageChunks.get(message.id);
  if (state === undefined) {
    state = { chunks: Array(message.total), received: 0 };
    nativeMessageChunks.set(message.id, state);
  }
  if (state.chunks.length !== message.total || state.chunks[message.index]) {
    nativeMessageChunks.delete(message.id);
    return;
  }
  let binary;
  try {
    binary = atob(message.data);
  } catch {
    nativeMessageChunks.delete(message.id);
    return;
  }
  const chunk = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    chunk[index] = binary.charCodeAt(index);
  }
  state.chunks[message.index] = chunk;
  state.received += 1;
  if (state.received !== state.chunks.length) return;
  nativeMessageChunks.delete(message.id);
  const length = state.chunks.reduce(
    (total, part) => total + (part?.length || 0),
    0,
  );
  const payload = new Uint8Array(length);
  let offset = 0;
  for (const part of state.chunks) {
    if (part === undefined) return;
    payload.set(part, offset);
    offset += part.length;
  }
  let decoded;
  try {
    decoded = JSON.parse(new TextDecoder().decode(payload));
  } catch {
    return;
  }
  await handleBridgeMessage(port, decoded, generation);
}

// Browser → backend push channel: CDP events for attached tabs and extension
// lifecycle notices. The backend keeps bounded per-tab buffers; nothing is
// stored here.
/**
 * @param {number} tabId
 * @param {string} method
 * @param {unknown} params
 * @param {string | undefined} [sessionId]
 */
function postEvent(tabId, method, params, sessionId) {
  if (!nativePort) return;
  try {
    nativePort.postMessage({
      type: 'event',
      tabId,
      method,
      params: params || {},
      ...(typeof sessionId === 'string' && sessionId !== ''
        ? { sessionId }
        : {}),
    });
  } catch {
    // The port may be closing. The backend invalidates the current session,
    // and a new Browser Use runtime establishes fresh event subscriptions.
  }
}

/**
 * @param {chrome.runtime.Port} port
 * @param {unknown} message
 * @param {number} generation
 */
async function handleBridgeMessage(port, message, generation) {
  if (
    typeof message !== 'object' ||
    message === null ||
    !('type' in message) ||
    message.type !== 'request' ||
    !('id' in message) ||
    typeof message.id !== 'string' ||
    !('method' in message) ||
    typeof message.method !== 'string'
  )
    return;
  const params =
    'params' in message &&
    typeof message.params === 'object' &&
    message.params !== null
      ? /** @type {Record<string, unknown>} */ (message.params)
      : {};
  try {
    const result = await dispatch(message.method, params, generation);
    if (nativePort === port) {
      port.postMessage({
        type: 'response',
        id: message.id,
        ok: true,
        result,
      });
    }
  } catch (error) {
    if (nativePort === port) {
      port.postMessage({
        type: 'response',
        id: message.id,
        ok: false,
        error: normalizeError(error),
      });
    }
  }
}

/**
 * @param {string} method
 * @param {Record<string, unknown>} params
 * @param {number} [generation]
 */
async function dispatch(method, params, generation = connectionGeneration) {
  switch (method) {
    case 'ping':
      return {
        extensionId: chrome.runtime.id,
        protocolVersion: PROTOCOL_VERSION,
      };
    case 'session.name': {
      assertActiveGeneration(generation);
      if (typeof params.name !== 'string' || params.name.trim() === '') {
        throw bridgeError('INVALID_ARGUMENT', 'Missing session name');
      }
      sessionName = params.name.slice(0, 200);
      await updateManagedGroupTitles(generation);
      await persistState(generation);
      return null;
    }
    case 'tabs.queryOpen':
      return await listOpenTabs();
    case 'tabs.queryDerived':
      return await listDerivedTabs();
    case 'history.query':
      return await queryHistory(params);
    case 'tabs.create': {
      const tab = await chrome.tabs.create({
        url: 'about:blank',
        active: true,
      });
      if (tab.id == null)
        throw bridgeError('STALE_TAB', 'Chrome did not return a tab id');
      if (generation !== connectionGeneration) {
        await chrome.tabs.remove(tab.id).catch(() => undefined);
        assertActiveGeneration(generation);
      }
      agentOwnedTabs.add(tab.id);
      await persistState(generation);
      await groupAgentOwnedTab(tab, generation);
      await ensureAttached(tab.id, generation);
      return tabInfo({
        ...tab,
        url: tab.url || tab.pendingUrl || 'about:blank',
      });
    }
    case 'tabs.get':
      return tabInfo(
        await requireControllableTab(numberParam(params, 'tabId')),
      );
    case 'tabs.attach': {
      const tabId = numberParam(params, 'tabId');
      await requireControllableTab(tabId);
      await ensureAttached(tabId, generation);
      return null;
    }
    case 'tabs.detach': {
      const tabId = numberParam(params, 'tabId');
      assertActiveGeneration(generation);
      await detach(tabId);
      return null;
    }
    case 'tabs.close': {
      const tabId = numberParam(params, 'tabId');
      await requireControllableTab(tabId);
      assertActiveGeneration(generation);
      await chrome.tabs.remove(tabId);
      return null;
    }
    case 'cdp.send': {
      const tabId = numberParam(params, 'tabId');
      await requireControllableTab(tabId);
      await ensureAttached(tabId, generation);
      assertActiveGeneration(generation);
      if (typeof params.method !== 'string')
        throw bridgeError('INVALID_ARGUMENT', 'Missing CDP method');
      const commandParams =
        typeof params.params === 'object' && params.params !== null
          ? /** @type {Record<string, unknown>} */ (params.params)
          : {};
      armDerivedTabWindow(tabId, params.method, commandParams);
      if (params.method === 'Input.dispatchMouseEvent') {
        void showAgentCursor(tabId, commandParams).catch(() => undefined);
      }
      assertActiveGeneration(generation);
      // A sessionId addresses a child target (for example an out-of-process
      // iframe) auto-attached under this tab's root debugger session.
      const target =
        typeof params.sessionId === 'string' && params.sessionId !== ''
          ? { tabId, sessionId: params.sessionId }
          : { tabId };
      return await chrome.debugger.sendCommand(
        target,
        params.method,
        commandParams,
      );
    }
    default:
      throw bridgeError('UNKNOWN_METHOD', `Unknown bridge method: ${method}`);
  }
}

/** @param {number} tabId */
async function requireControllableTab(tabId) {
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    throw bridgeError('STALE_TAB', 'The Chrome tab no longer exists');
  }
  if (!supportedUrl(tab.url)) {
    throw bridgeError(
      'UNSUPPORTED_TAB',
      'Qwen Browser can only control http(s) and about:blank tabs',
    );
  }
  return tab;
}

async function listOpenTabs() {
  return await listTabs((tab) => discoverableUrl(tab.url));
}

async function listDerivedTabs() {
  return await listTabs(
    (tab) =>
      typeof tab.id === 'number' &&
      derivedTabParents.has(tab.id) &&
      supportedUrl(tab.url),
  );
}

/** @param {(tab: chrome.tabs.Tab) => boolean} include */
async function listTabs(include) {
  const tabs = (await chrome.tabs.query({}))
    .filter((tab) => tab.id != null && include(tab))
    .sort(
      (left, right) => (right.lastAccessed || 0) - (left.lastAccessed || 0),
    );
  /** @type {Map<number, string>} */
  const groupTitles = new Map();
  /** @type {Set<number>} */
  const groupIds = new Set();
  for (const tab of tabs) {
    if (typeof tab.groupId === 'number' && tab.groupId >= 0)
      groupIds.add(tab.groupId);
  }
  for (const groupId of groupIds) {
    try {
      const group = await chrome.tabGroups.get(groupId);
      if (typeof group?.title === 'string' && group.title !== '')
        groupTitles.set(groupId, group.title);
    } catch {
      // The group may have been closed between the query and this lookup.
    }
  }
  return tabs.map((tab) => tabInfo(tab, groupTitles.get(tab.groupId)));
}

/** @param {Record<string, unknown>} params */
async function queryHistory(params) {
  const limit = params.limit === undefined ? 100 : params.limit;
  if (
    typeof limit !== 'number' ||
    !Number.isInteger(limit) ||
    limit <= 0 ||
    limit > 500
  ) {
    throw bridgeError(
      'INVALID_ARGUMENT',
      'History limit must be an integer between 1 and 500',
    );
  }
  const queries = historyQueriesParam(params.queries);
  const startTime = timestampParam(params.from, 'from');
  const endTime = timestampParam(params.to, 'to');
  /** @type {Map<string, { url: string, title: string | null, visitedAt: number }>} */
  const merged = new Map();
  for (const text of queries.length > 0 ? queries : ['']) {
    const items = await chrome.history.search({
      text,
      maxResults: limit,
      ...(startTime === undefined ? {} : { startTime }),
      ...(endTime === undefined ? {} : { endTime }),
    });
    for (const item of items) {
      if (typeof item.url !== 'string' || !discoverableUrl(item.url)) continue;
      const visitedAt =
        typeof item.lastVisitTime === 'number'
          ? item.lastVisitTime
          : Number.NaN;
      if (
        !Number.isFinite(visitedAt) ||
        !Number.isFinite(new Date(visitedAt).getTime())
      )
        continue;
      const existing = merged.get(item.url);
      if (existing !== undefined && existing.visitedAt >= visitedAt) continue;
      merged.set(item.url, {
        url: item.url,
        title: item.title || null,
        visitedAt,
      });
    }
  }
  return [...merged.values()]
    .sort((left, right) => right.visitedAt - left.visitedAt)
    .slice(0, limit)
    .map((entry) => ({
      url: entry.url,
      title: entry.title,
      dateVisited: new Date(entry.visitedAt).toISOString(),
    }));
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function historyQueriesParam(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) {
    throw bridgeError(
      'INVALID_ARGUMENT',
      'History queries must contain between 1 and 20 terms',
    );
  }
  return value.map((query) => {
    if (
      typeof query !== 'string' ||
      query.trim() === '' ||
      query.length > 1_000
    ) {
      throw bridgeError(
        'INVALID_ARGUMENT',
        'History query terms must be non-empty strings',
      );
    }
    return query.trim();
  });
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {number | undefined}
 */
function timestampParam(value, name) {
  if (value === undefined) return undefined;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  throw bridgeError('INVALID_ARGUMENT', `History ${name} must be a valid date`);
}

/**
 * @param {number} tabId
 * @param {number} generation
 */
async function ensureAttached(tabId, generation) {
  assertActiveGeneration(generation);
  if (attachedTabs.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    if (generation !== connectionGeneration) {
      await chrome.debugger.detach({ tabId }).catch(() => undefined);
      assertActiveGeneration(generation);
    }
    attachedTabs.add(tabId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('Another debugger is already attached')) {
      throw bridgeError(
        'TAB_DEBUGGER_CONFLICT',
        `Another debugger is already attached to tab ${tabId}`,
      );
    } else {
      throw error;
    }
  }
  await installAgentOverlay(tabId, generation);
  if (generation !== connectionGeneration) {
    await detach(tabId);
    assertActiveGeneration(generation);
  }
}

/** @param {number} tabId */
async function detach(tabId) {
  derivedTabDeadlines.delete(tabId);
  if (!attachedTabs.has(tabId)) return;
  attachedTabs.delete(tabId);
  await removeAgentOverlay(tabId);
  await settleWithin(
    [chrome.debugger.detach({ tabId })],
    CDP_CLEANUP_TIMEOUT_MS,
  );
}

/**
 * @param {number} tabId
 * @param {number} generation
 */
async function installAgentOverlay(tabId, generation) {
  if (generation !== connectionGeneration) return;
  if (!overlayScriptIds.has(tabId)) {
    try {
      const result = /** @type {{ identifier?: string }} */ (
        await chrome.debugger.sendCommand(
          { tabId },
          'Page.addScriptToEvaluateOnNewDocument',
          { source: AGENT_OVERLAY_BOOTSTRAP },
        )
      );
      if (
        generation === connectionGeneration &&
        typeof result?.identifier === 'string'
      )
        overlayScriptIds.set(tabId, result.identifier);
    } catch {
      // Overlay setup is advisory and must not block browser control.
    }
  }
  if (generation !== connectionGeneration) return;
  try {
    await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
      expression: AGENT_OVERLAY_BOOTSTRAP,
    });
  } catch {
    // The current document may be navigating; the new-document script handles it.
  }
}

/**
 * @param {number} tabId
 * @param {Record<string, unknown>} params
 */
async function showAgentCursor(tabId, params) {
  if (!params || typeof params !== 'object') return;
  const x = Number(params.x);
  const y = Number(params.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  const pressed = params.type === 'mousePressed';
  await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
    expression: `globalThis[${JSON.stringify(AGENT_OVERLAY_GLOBAL)}]?.move(${Math.round(x)}, ${Math.round(y)}, ${pressed})`,
  });
}

/** @param {number} tabId */
async function removeAgentOverlay(tabId) {
  const identifier = overlayScriptIds.get(tabId);
  overlayScriptIds.delete(tabId);
  const operations = [];
  if (identifier !== undefined) {
    operations.push(
      chrome.debugger.sendCommand(
        { tabId },
        'Page.removeScriptToEvaluateOnNewDocument',
        {
          identifier,
        },
      ),
    );
  }
  operations.push(
    chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
      expression: `globalThis[${JSON.stringify(AGENT_OVERLAY_GLOBAL)}]?.destroy()`,
    }),
  );
  await settleWithin(operations, CDP_CLEANUP_TIMEOUT_MS);
}

/**
 * @param {chrome.tabs.Tab} tab
 * @param {string | undefined} [tabGroup]
 */
function tabInfo(tab, tabGroup) {
  if (typeof tab.id !== 'number')
    throw bridgeError('STALE_TAB', 'Chrome did not return a tab id');
  const tabId = tab.id;
  return {
    providerTabId: tabId,
    title: tab.title || null,
    url: tab.url || null,
    active: tab.active === true,
    windowId: tab.windowId,
    ...(typeof tab.lastAccessed === 'number' &&
    Number.isFinite(tab.lastAccessed)
      ? { lastOpened: new Date(tab.lastAccessed).toISOString() }
      : {}),
    ...(typeof tabGroup === 'string' && tabGroup !== '' ? { tabGroup } : {}),
    ...(derivedTabParents.has(tabId)
      ? { derivedFromProviderTabId: derivedTabParents.get(tabId) }
      : {}),
  };
}

/**
 * @param {number} tabId
 * @param {string} method
 * @param {Record<string, unknown> | undefined} params
 */
function armDerivedTabWindow(tabId, method, params) {
  if (params === undefined) return;
  if (method === 'Input.dispatchMouseEvent') {
    const type = params.type;
    if (type !== 'mousePressed' && type !== 'mouseReleased') return;
    if (params.button === 'right') return;
  } else if (method === 'Input.dispatchKeyEvent') {
    const type = params.type;
    if (type !== 'keyDown' && type !== 'rawKeyDown') return;
    if (params.key !== 'Enter' && params.key !== ' ') return;
  } else {
    return;
  }
  derivedTabDeadlines.set(tabId, Date.now() + DERIVED_TAB_WINDOW_MS);
}

/**
 * A popup created by an agent input action on a tab the agent already controls
 * is treated as agent-owned, so the backend auto-claims it and it joins the
 * session tab group. The causal window keeps unrelated user popups out.
 */
/** @param {chrome.tabs.Tab} tab */
function trackDerivedTab(tab) {
  const generation = connectionGeneration;
  const tabId = tab.id;
  const openerTabId = tab.openerTabId;
  if (
    typeof tabId !== 'number' ||
    typeof openerTabId !== 'number' ||
    nativePort === undefined ||
    !attachedTabs.has(openerTabId)
  )
    return;
  const deadline = derivedTabDeadlines.get(openerTabId) || 0;
  if (Date.now() > deadline) return;
  const initialUrl = tab.pendingUrl || tab.url || 'about:blank';
  if (!supportedUrl(initialUrl)) return;
  derivedTabParents.set(tabId, openerTabId);
  agentOwnedTabs.add(tabId);
  const operation = (async () => {
    await persistState(generation);
    if (generation !== connectionGeneration) return;
    await groupAgentOwnedTab(tab, generation).catch(() => undefined);
    if (generation !== connectionGeneration) return;
    postEvent(tabId, 'qwenBrowser.derivedTabTracked', {
      openerTabId,
    });
    connectNative();
  })();
  inFlightDispatches.add(operation);
  void operation.then(
    () => inFlightDispatches.delete(operation),
    () => inFlightDispatches.delete(operation),
  );
}

/**
 * @param {chrome.tabs.Tab} tab
 * @param {number} generation
 */
function groupAgentOwnedTab(tab, generation) {
  const operation = groupOperation.then(() =>
    ensureAgentOwnedTabGrouped(tab, generation),
  );
  groupOperation = operation.catch(() => undefined);
  return operation;
}

/**
 * @param {chrome.tabs.Tab} tab
 * @param {number} generation
 */
async function ensureAgentOwnedTabGrouped(tab, generation) {
  if (
    generation !== connectionGeneration ||
    tab.id == null ||
    tab.windowId == null ||
    !agentOwnedTabs.has(tab.id)
  )
    return;
  let groupId = managedGroupIdsByWindow.get(tab.windowId);
  if (groupId !== undefined && tab.groupId !== groupId) {
    try {
      await chrome.tabs.group({ tabIds: [tab.id], groupId });
      if (generation !== connectionGeneration) {
        await chrome.tabs.ungroup(tab.id).catch(() => undefined);
        return;
      }
    } catch {
      if (generation !== connectionGeneration) return;
      if (managedGroupIdsByWindow.get(tab.windowId) === groupId)
        managedGroupIdsByWindow.delete(tab.windowId);
      groupId = undefined;
    }
  }
  if (groupId === undefined) {
    groupId = await chrome.tabs.group({ tabIds: [tab.id] });
    if (generation !== connectionGeneration) {
      await chrome.tabs.ungroup(tab.id).catch(() => undefined);
      return;
    }
    managedGroupIdsByWindow.set(tab.windowId, groupId);
  }
  await chrome.tabGroups.update(groupId, { title: sessionName, color: 'blue' });
  if (generation !== connectionGeneration) {
    if (managedGroupIdsByWindow.get(tab.windowId) === groupId)
      managedGroupIdsByWindow.delete(tab.windowId);
    await chrome.tabs.ungroup(tab.id).catch(() => undefined);
    return;
  }
  await persistState(generation);
}

/** @param {number} generation */
async function updateManagedGroupTitles(generation) {
  for (const [windowId, groupId] of [...managedGroupIdsByWindow]) {
    try {
      await chrome.tabGroups.update(groupId, {
        title: sessionName,
        color: 'blue',
      });
      if (generation !== connectionGeneration) return;
    } catch {
      if (
        generation === connectionGeneration &&
        managedGroupIdsByWindow.get(windowId) === groupId
      ) {
        managedGroupIdsByWindow.delete(windowId);
      }
    }
  }
}

/** @param {number} generation */
function assertActiveGeneration(generation) {
  if (generation !== connectionGeneration) {
    throw bridgeError('OPERATION_FAILED', 'Browser backend disconnected');
  }
}

/** @param {string | undefined} url */
function supportedUrl(url) {
  return discoverableUrl(url) || url === 'about:blank';
}

/** @param {string | undefined} url */
function discoverableUrl(url) {
  return typeof url === 'string' && /^https?:\/\//.test(url);
}

/**
 * @param {Record<string, unknown>} params
 * @param {string} name
 */
function numberParam(params, name) {
  const value = params[name];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0)
    throw bridgeError('INVALID_ARGUMENT', `Missing ${name}`);
  return value;
}

/**
 * @param {string} code
 * @param {string} message
 */
function bridgeError(code, message) {
  const error = /** @type {Error & { code: string }} */ (new Error(message));
  error.code = code;
  return error;
}

/** @param {unknown} error */
function normalizeError(error) {
  const value =
    error instanceof Error
      ? /** @type {Error & { code?: unknown }} */ (error)
      : undefined;
  return {
    code: typeof value?.code === 'string' ? value.code : 'OPERATION_FAILED',
    message:
      typeof value?.message === 'string'
        ? value.message
        : 'Chrome extension operation failed',
  };
}

chrome.tabs.onRemoved.addListener((tabId) => {
  const wasAttached = attachedTabs.has(tabId);
  attachedTabs.delete(tabId);
  agentOwnedTabs.delete(tabId);
  overlayScriptIds.delete(tabId);
  derivedTabParents.delete(tabId);
  derivedTabDeadlines.delete(tabId);
  if (wasAttached) postEvent(tabId, 'qwenBrowser.tabRemoved', {});
  void persistState();
});

chrome.tabs.onCreated.addListener(trackDerivedTab);

chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId == null) return;
  const sessionId = /** @type {{ sessionId?: string }} */ (source).sessionId;
  if (typeof sessionId === 'string' && sessionId !== '') {
    // A child session (iframe target) went away; the tab itself is still attached.
    postEvent(
      source.tabId,
      'qwenBrowser.sessionDetached',
      { reason: reason || 'unknown' },
      sessionId,
    );
    return;
  }
  derivedTabDeadlines.delete(source.tabId);
  attachedTabs.delete(source.tabId);
  overlayScriptIds.delete(source.tabId);
  postEvent(source.tabId, 'qwenBrowser.detached', {
    reason: reason || 'unknown',
  });
});

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId == null || !attachedTabs.has(source.tabId)) return;
  postEvent(source.tabId, method, params, source.sessionId);
});

void restoreState().finally(connectNative);
