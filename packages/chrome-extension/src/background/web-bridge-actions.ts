/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  releaseCdpTab,
  subscribeCdpDetaches,
  subscribeCdpEvents,
  withCdpTab,
  withDirectBrowserAction,
  type CdpCommand,
} from './cdp-bridge';

type Args = Record<string, unknown>;
type JsonRecord = Record<string, unknown>;

interface ElementRef {
  backendNodeId: number;
}

interface NetworkRequest {
  requestId: string;
  url: string;
  method: string;
  status?: number;
  mimeType?: string;
  completed?: boolean;
  failed?: boolean;
  errorText?: string;
}

interface NetworkCapture {
  session: string;
  tabId: number;
  requests: Map<string, NetworkRequest>;
}

const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'checkbox',
  'radio',
  'combobox',
  'listbox',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'searchbox',
  'slider',
  'spinbutton',
  'switch',
  'tab',
  'treeitem',
]);
interface SessionRefs {
  /**
   * Top-frame loaderId captured when the snapshot was taken. Resolving a ref
   * against a different loader fails closed: backendNodeIds restart from
   * small integers in every new document, so a stale ref would otherwise
   * silently resolve to a different element.
   */
  loaderId?: string;
  refs: Map<string, ElementRef>;
  /**
   * Highest ref number ever issued for this session (high-water mark across
   * ALL snapshots, not the previous snapshot's count): numbering must never
   * re-issue a number the agent may still hold from an earlier snapshot of
   * the same document, where the loaderId guard cannot fire.
   */
  nextRef: number;
}

const refsByTab = new Map<number, Map<string, SessionRefs>>();
const groupBySession = new Map<string, number>();
const tabsBySession = new Map<string, Set<number>>();
const networkCaptures = new Map<string, NetworkCapture>();
// Sessions whose capture was destroyed by a debugger detach (banner cancel,
// tab crash, action timeout). list/detail/stop surface the loss instead of
// reporting an empty-but-"successful" capture; a fresh `network start`
// clears the mark.
const invalidatedCaptureSessions = new Set<string>();
const MAX_NETWORK_CAPTURES = 32;
const MAX_NETWORK_REQUESTS = 2_000;
let removeNetworkListener: (() => void) | undefined;

subscribeCdpDetaches((tabId) => {
  for (const [key, capture] of networkCaptures) {
    if (capture.tabId === tabId) {
      invalidatedCaptureSessions.add(capture.session);
      networkCaptures.delete(key);
    }
  }
  stopNetworkListenerIfIdle();
});

const ACTIONS: Record<string, (args: Args) => Promise<unknown>> = {
  navigate,
  find_tab: findTab,
  evaluate,
  network,
  snapshot,
  click,
  fill,
  mouse_click: mouseClick,
  cdp,
  key_type: keyType,
  send_keys: sendKeys,
  screenshot,
  save_as_pdf: saveAsPdf,
  upload,
  close_tab: closeTab,
  list_tabs: listTabs,
  close_session: closeSession,
};

export function executeWebBridgeAction(
  name: string,
  args: Args,
): Promise<unknown> {
  const action = ACTIONS[name];
  if (!action) {
    throw new Error(
      `Unknown WebBridge action: ${name}. Available: ${Object.keys(ACTIONS).join(', ')}`,
    );
  }
  return withDirectBrowserAction(async () => {
    try {
      return await action(args);
    } finally {
      if (name !== 'close_tab' && name !== 'close_session') {
        try {
          await releaseIdleTabs(args);
        } catch {
          // Cleanup must never replace the action's outcome.
        }
      }
    }
  });
}

async function navigate(args: Args): Promise<unknown> {
  const url = requiredString(args, 'url', 'navigate');
  const currentTabId = integer(args['_tabId']);
  if (args['newTab'] === true || currentTabId === undefined) {
    return { success: true, ...(await createSessionTab(url, args)) };
  }

  const tab = await chrome.tabs.get(currentTabId);
  if (/^(chrome|edge):\/\//.test(tab.url ?? '')) {
    return { success: true, ...(await createSessionTab(url, args)) };
  }

  const frameId = await withCdpTab(currentTabId, async (send) => {
    const loadedLifecycles = new Set<string>();
    let expectedLifecycle: string | undefined;
    let resolveLoaded!: () => void;
    const loaded = new Promise<void>((resolve) => {
      resolveLoaded = resolve;
    });
    let rejectNavigation!: (error: Error) => void;
    const navigationFailure = new Promise<never>((_resolve, reject) => {
      rejectNavigation = reject;
    });
    let reloadFrom: { frameId: string; loaderId: string } | undefined;
    let directNavigationStarted = false;
    let directNavigationFrameId: string | undefined;
    let latestDirectLoader: { frameId: string; loaderId: string } | undefined;
    let nextReloadLoader: { frameId: string; loaderId: string } | undefined;
    let resolveNextReloadLoader!: (value: {
      frameId: string;
      loaderId: string;
    }) => void;
    const nextReloadLoaderPromise = new Promise<{
      frameId: string;
      loaderId: string;
    }>((resolve) => {
      resolveNextReloadLoader = resolve;
    });
    const unsubscribe = subscribeCdpEvents((method, params, eventTabId) => {
      if (eventTabId !== currentTabId) return;
      if (method === 'Page.lifecycleEvent' && params['name'] === 'load') {
        const frameId = string(params['frameId']);
        const loaderId = string(params['loaderId']);
        if (frameId === undefined || loaderId === undefined) return;
        const key = JSON.stringify([frameId, loaderId]);
        loadedLifecycles.add(key);
        if (key === expectedLifecycle) resolveLoaded();
        return;
      }
      if (method !== 'Page.frameNavigated') return;
      const frame = record(params['frame']);
      const frameId = string(frame['id']);
      const loaderId = string(frame['loaderId']);
      if (frame['parentId'] !== undefined || loaderId === undefined) return;
      if (string(frame['url'])?.startsWith('chrome-error://')) {
        rejectNavigation(new Error('navigate: page failed to load'));
        return;
      }
      if (
        reloadFrom !== undefined &&
        frameId === reloadFrom.frameId &&
        loaderId !== reloadFrom.loaderId
      ) {
        nextReloadLoader = { frameId, loaderId };
        if (expectedLifecycle === undefined) {
          resolveNextReloadLoader(nextReloadLoader);
        } else {
          expectedLifecycle = JSON.stringify([frameId, loaderId]);
          if (loadedLifecycles.has(expectedLifecycle)) resolveLoaded();
        }
      }
      if (!directNavigationStarted || frameId === undefined) return;
      latestDirectLoader = { frameId, loaderId };
      if (frameId !== directNavigationFrameId) return;
      expectedLifecycle = JSON.stringify([frameId, loaderId]);
      if (loadedLifecycles.has(expectedLifecycle)) resolveLoaded();
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let timedOut: Promise<never> | undefined;
    const pageLoadTimeout = () => {
      timedOut ??= new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error('navigate: page load timeout (30s)')),
          30_000,
        );
      });
      return timedOut;
    };
    try {
      await send('Page.enable');
      await send('Page.setLifecycleEventsEnabled', { enabled: true });
      let frameId: string | undefined;
      let target: { frameId: string; loaderId: string } | undefined;
      if (tab.url === url || tab.url === `${url}/`) {
        const tree = record(await send('Page.getFrameTree'));
        const frame = record(record(tree['frameTree'])['frame']);
        const currentFrameId = string(frame['id']);
        const currentLoaderId = string(frame['loaderId']);
        if (currentFrameId === undefined || currentLoaderId === undefined) {
          throw new Error('navigate: current page has no loader');
        }
        reloadFrom = {
          frameId: currentFrameId,
          loaderId: currentLoaderId,
        };
        refsByTab.delete(currentTabId);
        await send('Page.reload', {
          ignoreCache: true,
          loaderId: currentLoaderId,
        });
        target = await Promise.race([
          nextReloadLoaderPromise,
          navigationFailure,
          pageLoadTimeout(),
        ]);
        target = nextReloadLoader ?? target;
        frameId = target.frameId;
      } else {
        refsByTab.delete(currentTabId);
        directNavigationStarted = true;
        const result = record(
          await Promise.race([
            send('Page.navigate', { url }),
            navigationFailure,
          ]),
        );
        const errorText = string(result['errorText']);
        if (errorText) throw new Error(`navigate: ${errorText}`);
        frameId = string(result['frameId']);
        const loaderId = string(result['loaderId']);
        if (loaderId === undefined) return frameId;
        if (frameId === undefined) {
          throw new Error('navigate: Page.navigate returned no frame');
        }
        directNavigationFrameId = frameId;
        target =
          latestDirectLoader?.frameId === frameId
            ? latestDirectLoader
            : { frameId, loaderId };
      }
      expectedLifecycle = JSON.stringify([target.frameId, target.loaderId]);
      if (loadedLifecycles.has(expectedLifecycle)) resolveLoaded();
      await Promise.race([loaded, navigationFailure, pageLoadTimeout()]);
      return frameId;
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      unsubscribe();
    }
  });
  const loaded = await chrome.tabs.get(currentTabId);
  rememberTab(args, currentTabId);
  return {
    success: true,
    url: loaded.url ?? url,
    tabId: currentTabId,
    frameId,
  };
}

async function createSessionTab(
  url: string,
  args: Args,
): Promise<{ url: string; tabId: number }> {
  const tab = await chrome.tabs.create({ url, active: false });
  if (tab.id === undefined) throw new Error('navigate: created tab has no id');
  try {
    await groupTab(tab.id, args);
    const loaded = await waitForLoad(tab.id, url);
    await withCdpTab(tab.id, async () => undefined);
    rememberTab(args, tab.id);
    return { url: loaded.url ?? url, tabId: tab.id };
  } catch (error) {
    forgetTab(tab.id);
    try {
      await chrome.tabs.remove(tab.id);
    } catch {
      // The user may have already closed it.
    }
    throw error;
  }
}

async function findTab(args: Args): Promise<unknown> {
  const url = requiredString(args, 'url', 'find_tab');
  if (args['active'] === true) {
    const window = await chrome.windows.getLastFocused({
      populate: true,
      windowTypes: ['normal'],
    });
    const tab = window.tabs?.find(
      (candidate) =>
        candidate.active && matchesRequestedUrl(candidate.url, url),
    );
    if (tab?.id === undefined) {
      throw new Error(
        `find_tab(active:true): no foreground tab matching ${url}`,
      );
    }
    await withCdpTab(tab.id, async () => undefined);
    rememberTab(args, tab.id);
    return {
      success: true,
      url: tab.url ?? url,
      tabId: tab.id,
      borrowed: true,
    };
  }

  const candidates: Array<{ tabId: number; tab: chrome.tabs.Tab }> = [];
  for (const tabId of tabIds(args)) {
    let tab: chrome.tabs.Tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      continue;
    }
    candidates.push({ tabId, tab });
  }
  candidates.sort((left, right) => left.tab.index - right.tab.index);
  const match = candidates.find(({ tab }) => matchesRequestedUrl(tab.url, url));
  if (!match)
    throw new Error(`find_tab: no tab matching ${url} in this session`);
  await withCdpTab(match.tabId, async () => undefined);
  rememberTab(args, match.tabId);
  return {
    success: true,
    url: match.tab.url ?? url,
    tabId: match.tabId,
    borrowed: false,
  };
}

async function evaluate(args: Args): Promise<unknown> {
  const code = requiredString(args, 'code', 'evaluate');
  return onCurrentTab(args, async (send) => {
    let result = record(
      await send('Runtime.evaluate', {
        expression: code,
        returnByValue: true,
        awaitPromise: true,
        replMode: true,
      }),
    );
    throwOnCdpException('evaluate', result);
    let remote = record(result['result']);
    if (
      remote['subtype'] === 'promise' &&
      typeof remote['objectId'] === 'string'
    ) {
      result = record(
        await send('Runtime.callFunctionOn', {
          objectId: remote['objectId'],
          functionDeclaration: 'function() { return this; }',
          returnByValue: true,
          awaitPromise: true,
        }),
      );
      throwOnCdpException('evaluate', result);
      remote = record(result['result']);
    }
    return {
      type: remote['type'],
      value:
        'value' in remote ? remote['value'] : remote['unserializableValue'],
    };
  });
}

async function snapshot(args: Args): Promise<unknown> {
  const tab = await currentTab(args);
  return withCdpTab(tab.id, async (send) => {
    const loaderId = await topFrameLoaderId(send);
    const result = record(await send('Accessibility.getFullAXTree'));
    const nodes = Array.isArray(result['nodes']) ? result['nodes'] : [];
    const refsBySession = refsByTab.get(tab.id) ?? new Map();
    // Continue numbering from the highest number EVER issued for this
    // session so a ref remembered from any earlier snapshot can never
    // collide with a freshly issued one (the previous snapshot's count
    // alone would re-issue numbers from two snapshots back).
    const startRef = refsBySession.get(sessionKey(args))?.nextRef ?? 0;
    const refs = new Map<string, ElementRef>();
    const entry: SessionRefs = { loaderId, refs, nextRef: startRef };
    refsBySession.set(sessionKey(args), entry);
    refsByTab.set(tab.id, refsBySession);
    const tree = formatAccessibilityTree(nodes, refs, startRef);
    entry.nextRef = startRef + refs.size;
    return {
      url: tab.url,
      title: tab.title,
      tree,
    };
  });
}

async function topFrameLoaderId(send: CdpCommand): Promise<string | undefined> {
  try {
    const tree = record(await send('Page.getFrameTree'));
    return string(record(record(tree['frameTree'])['frame'])['loaderId']);
  } catch {
    return undefined;
  }
}

async function click(args: Args): Promise<unknown> {
  const selector = requiredString(args, 'selector', 'click');
  return onCurrentTab(args, async (send, tabId) => {
    if (isRef(selector)) {
      const objectId = await objectIdFromRef(
        'click',
        selector,
        tabId,
        sessionKey(args),
        send,
      );
      const result = record(
        await send('Runtime.callFunctionOn', {
          objectId,
          functionDeclaration:
            "function() { this.scrollIntoView({ block: 'center' }); this.click(); return { success: true, tag: this.tagName, text: this.textContent?.slice(0, 100) }; }",
          returnByValue: true,
        }),
      );
      throwOnCdpException('click', result);
      return record(record(result['result'])['value']);
    }
    const result = record(
      await send('Runtime.evaluate', {
        expression: `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return { error: ${JSON.stringify(`element not found: ${selector}`)} }; el.scrollIntoView({ block: 'center' }); el.click(); return { success: true, tag: el.tagName, text: el.textContent?.slice(0, 100) }; })()`,
        returnByValue: true,
      }),
    );
    return checkedValue('click', result);
  });
}

async function fill(args: Args): Promise<unknown> {
  const selector = requiredString(args, 'selector', 'fill');
  if (args['value'] === undefined || args['value'] === null) {
    throw new Error('fill: value is required');
  }
  const body = fillFunction(args['value']);
  return onCurrentTab(args, async (send, tabId) => {
    let result: JsonRecord;
    if (isRef(selector)) {
      const objectId = await objectIdFromRef(
        'fill',
        selector,
        tabId,
        sessionKey(args),
        send,
      );
      result = record(
        await send('Runtime.callFunctionOn', {
          objectId,
          functionDeclaration: `function() { ${body.replace('__TARGET__', 'this')} }`,
          returnByValue: true,
        }),
      );
    } else {
      result = record(
        await send('Runtime.evaluate', {
          expression: `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return { error: ${JSON.stringify(`element not found: ${selector}`)} }; ${body.replace('__TARGET__', 'el')} })()`,
          returnByValue: true,
        }),
      );
    }
    return checkedValue('fill', result);
  });
}

async function mouseClick(args: Args): Promise<unknown> {
  const selector = requiredString(args, 'selector', 'mouse_click');
  return onCurrentTab(args, async (send, tabId) => {
    const objectId = await objectIdFromSelectorOrRef(
      'mouse_click',
      selector,
      tabId,
      sessionKey(args),
      send,
    );
    await send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration:
        "function() { this.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); }",
    });
    const box = record(await send('DOM.getBoxModel', { objectId }));
    const content = record(box['model'])['content'];
    if (!numberArray(content) || content.length < 8) {
      throw new Error('mouse_click: element has no layout box');
    }
    const xs = [content[0], content[2], content[4], content[6]];
    const ys = [content[1], content[3], content[5], content[7]];
    if (
      Math.max(...xs) - Math.min(...xs) <= 0 ||
      Math.max(...ys) - Math.min(...ys) <= 0
    ) {
      throw new Error('mouse_click: element has zero-size box');
    }
    const x = xs.reduce((sum, value) => sum + value, 0) / 4;
    const y = ys.reduce((sum, value) => sum + value, 0) / 4;
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x,
      y,
      button: 'none',
      buttons: 0,
    });
    await send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    });
    let released = false;
    try {
      await send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x,
        y,
        button: 'left',
        buttons: 0,
        clickCount: 1,
      });
      released = true;
    } finally {
      if (!released) {
        try {
          await send('Input.dispatchMouseEvent', {
            type: 'mouseReleased',
            x,
            y,
            button: 'left',
            buttons: 0,
            clickCount: 1,
          });
        } catch {
          // Preserve the original release error.
        }
      }
    }
    let value: JsonRecord = {};
    try {
      const metadata = record(
        await send('Runtime.callFunctionOn', {
          objectId,
          functionDeclaration:
            "function() { return { tag: this.tagName, text: (this.textContent || '').slice(0, 100) }; }",
          returnByValue: true,
        }),
      );
      value = record(record(metadata['result'])['value']);
    } catch {
      // The click may have navigated and invalidated the execution context.
    }
    return {
      success: true,
      x: Math.round(x),
      y: Math.round(y),
      tag: value['tag'] ?? '',
      text: value['text'] ?? '',
    };
  });
}

async function cdp(args: Args): Promise<unknown> {
  const method = requiredString(args, 'method', 'cdp');
  const params = args['params'] === undefined ? {} : record(args['params']);
  return onCurrentTab(args, async (send) => record(await send(method, params)));
}

async function keyType(args: Args): Promise<unknown> {
  const text = requiredString(args, 'text', 'key_type', true);
  return onCurrentTab(args, async (send) => {
    const focused = record(
      await send('Runtime.evaluate', {
        expression:
          "(() => { const editable = (el) => !!el && (el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA'); let el = document.activeElement; while (el) { if (editable(el)) return true; if (el.tagName === 'IFRAME') { try { el = el.contentDocument ? el.contentDocument.activeElement : null; } catch { el = null; } continue; } el = el.shadowRoot ? el.shadowRoot.activeElement : null; } return false; })()",
        returnByValue: true,
      }),
    );
    if (record(focused['result'])['value'] !== true) {
      throw new Error('key_type: no focused editable element');
    }
    await send('Input.insertText', { text });
    return { success: true, length: text.length };
  });
}

const MAX_SEND_KEYS_CHARS = 1_024;
const MAX_SEND_KEYS_DISPATCH_GROUPS = 300;

async function sendKeys(args: Args): Promise<unknown> {
  const keys = requiredString(args, 'keys', 'send_keys');
  const repeat = args['repeat'] === undefined ? 1 : Number(args['repeat']);
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > 100) {
    throw new Error('send_keys: repeat must be an integer in [1, 100]');
  }
  const platform = (await chrome.runtime.getPlatformInfo()).os;
  const segments = keys.trim().split(/\s+/);
  // Bound the serialized CDP work so one oversized request cannot keep
  // typing into the user's page long after the daemon-side 60s timeout,
  // wedging every queued WebBridge command behind it.
  if (
    keys.length > MAX_SEND_KEYS_CHARS ||
    segments.length * repeat > MAX_SEND_KEYS_DISPATCH_GROUPS
  ) {
    throw new Error(
      `send_keys: too many keys (max ${MAX_SEND_KEYS_CHARS} chars and ${MAX_SEND_KEYS_DISPATCH_GROUPS} key*repeat dispatch groups)`,
    );
  }
  const sequences = segments.map((key) => parseKey(key, platform));
  return onCurrentTab(args, async (send) => {
    let dispatched = 0;
    for (let run = 0; run < repeat; run++) {
      for (const sequence of sequences) {
        await dispatchKey(send, sequence);
        dispatched++;
      }
    }
    return { success: true, dispatched, os: platform };
  });
}

async function network(args: Args): Promise<unknown> {
  const command = requiredString(args, 'cmd', 'network');
  const session = requiredString(args, '_session', 'network');
  const tab = await currentTab(args);
  rememberTab(args, tab.id);
  const key = JSON.stringify([session, tab.id]);
  if (command === 'start') {
    if (networkCaptures.has(key)) {
      // A re-start must not wipe what is already being captured.
      return { success: true, message: 'network capture already running' };
    }
    if (networkCaptures.size >= MAX_NETWORK_CAPTURES) {
      throw new Error('network: capture limit reached');
    }
    networkCaptures.set(key, {
      session,
      tabId: tab.id,
      requests: new Map(),
    });
    installNetworkListener();
    try {
      await withCdpTab(tab.id, (send) => send('Network.enable'));
    } catch (error) {
      networkCaptures.delete(key);
      stopNetworkListenerIfIdle();
      throw error;
    }
    invalidatedCaptureSessions.delete(session);
    return { success: true, message: 'network capture started' };
  }
  if (command === 'stop') {
    const hadInvalidatedCapture = invalidatedCaptureSessions.delete(session);
    const captures = [...networkCaptures.entries()].filter(
      ([, capture]) => capture.session === session,
    );
    for (const [captureKey, capture] of captures) {
      networkCaptures.delete(captureKey);
      if (
        [...networkCaptures.values()].some(
          ({ tabId }) => tabId === capture.tabId,
        )
      ) {
        continue;
      }
      try {
        await withCdpTab(capture.tabId, async (send) => {
          try {
            await send('Network.disable');
          } catch {
            // The target may already be gone.
          }
        });
      } catch {
        // The tab may already be gone; keep disabling the remaining
        // captures instead of aborting the whole stop.
      }
    }
    stopNetworkListenerIfIdle();
    if (hadInvalidatedCapture) {
      throw new Error(
        'network: capture was invalidated by a debugger detach',
      );
    }
    return { success: true, message: 'network capture stopped' };
  }
  if (invalidatedCaptureSessions.has(session)) {
    throw new Error('network: capture was invalidated by a debugger detach');
  }
  // The current tab may have changed since `start` (newTab navigation or
  // stale-tab recovery), and one session may capture on several tabs —
  // merge every capture owned by the session instead of reading only the
  // first one.
  const sessionCaptures = [...networkCaptures.values()].filter(
    (candidate) => candidate.session === session,
  );
  if (command === 'list') {
    const filter = string(args['filter']);
    const values = sessionCaptures
      .flatMap((capture) => [...capture.requests.values()])
      .filter((request) => !filter || request.url.includes(filter));
    return {
      count: values.length,
      requests: values.map((request) => ({
        ...request,
        completed: request.completed ?? false,
      })),
    };
  }
  if (command === 'detail') {
    const requestId = requiredString(args, 'requestId', 'network');
    const owner = sessionCaptures.find((capture) =>
      capture.requests.has(requestId),
    );
    const request = owner?.requests.get(requestId);
    if (!request) throw new Error(`network: request "${requestId}" not found`);
    if (request.failed) return request;
    const captureTabId = owner?.tabId ?? tab.id;
    const response = await withCdpTab(captureTabId, async (send) =>
      record(await send('Network.getResponseBody', { requestId })),
    );
    let body: unknown = response['body'];
    if (response['base64Encoded'] !== true && typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch {
        // Text response.
      }
    }
    return { ...request, base64Encoded: response['base64Encoded'], body };
  }
  throw new Error(`network: unknown cmd "${command}"`);
}

async function screenshot(args: Args): Promise<unknown> {
  const format = args['format'] === 'jpeg' ? 'jpeg' : 'png';
  return onCurrentTab(args, async (send, tabId) => {
    const params: JsonRecord = { format };
    if (format === 'jpeg') {
      const quality =
        args['quality'] === undefined ? 80 : Number(args['quality']);
      if (!Number.isFinite(quality) || quality < 0 || quality > 100) {
        throw new Error('screenshot: quality must be in [0, 100]');
      }
      params['quality'] = quality;
    }
    const selector = string(args['selector']);
    if (selector) {
      const objectId = await objectIdFromSelectorOrRef(
        'screenshot',
        selector,
        tabId,
        sessionKey(args),
        send,
      );
      await send('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration:
          "function() { this.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); }",
      });
      const box = record(await send('DOM.getBoxModel', { objectId }));
      const border = record(box['model'])['border'];
      if (!numberArray(border) || border.length < 8) {
        throw new Error('screenshot: element has no layout box');
      }
      const xs = [border[0], border[2], border[4], border[6]];
      const ys = [border[1], border[3], border[5], border[7]];
      const x = Math.min(...xs);
      const y = Math.min(...ys);
      const width = Math.max(...xs) - x;
      const height = Math.max(...ys) - y;
      if (width <= 0 || height <= 0) {
        throw new Error('screenshot: element has zero-size box');
      }
      const metrics = record(await send('Page.getLayoutMetrics'));
      const viewport = record(
        metrics['cssVisualViewport'] ?? metrics['visualViewport'],
      );
      params['clip'] = {
        x: x + (number(viewport['pageX']) ?? 0),
        y: y + (number(viewport['pageY']) ?? 0),
        width,
        height,
        scale: 1,
      };
    }
    const result = record(await send('Page.captureScreenshot', params));
    return {
      format,
      dataLength: string(result['data'])?.length,
      data: result['data'],
    };
  });
}

const PAPER_FORMATS: Record<string, [number, number]> = {
  letter: [8.5, 11],
  legal: [8.5, 14],
  a4: [8.27, 11.69],
  a3: [11.69, 16.54],
  tabloid: [11, 17],
};

async function saveAsPdf(args: Args): Promise<unknown> {
  const format = string(args['paper_format'])?.toLowerCase() ?? 'letter';
  const [paperWidth, paperHeight] =
    PAPER_FORMATS[format] ?? PAPER_FORMATS['letter'];
  const scale = args['scale'] === undefined ? 1 : Number(args['scale']);
  if (!Number.isFinite(scale) || scale < 0.1 || scale > 2) {
    throw new Error(`save_as_pdf: scale must be in [0.1, 2.0], got ${scale}`);
  }
  return onCurrentTab(args, async (send) => {
    const result = record(
      await send('Page.printToPDF', {
        printBackground: args['print_background'] !== false,
        landscape: args['landscape'] === true,
        scale,
        paperWidth,
        paperHeight,
        preferCSSPageSize: false,
      }),
    );
    if (typeof result['data'] !== 'string') {
      throw new Error('save_as_pdf: CDP returned no data');
    }
    let pageTitle = '';
    try {
      const titleResult = record(
        await send('Runtime.evaluate', {
          expression: 'document.title',
          returnByValue: true,
        }),
      );
      // document.title is page-controlled and rides the unchunked metadata
      // frame — cap it so a multi-MiB title cannot exceed the daemon's WS
      // maxPayload and take down the bridge for every session.
      pageTitle = (string(record(titleResult['result'])['value']) ?? '').slice(
        0,
        1024,
      );
    } catch {
      // Metadata is optional.
    }
    return {
      data: result['data'],
      dataLength: result['data'].length,
      pageTitle,
    };
  });
}

async function upload(args: Args): Promise<unknown> {
  const selector = requiredString(args, 'selector', 'upload');
  const files = args['files'];
  if (
    !Array.isArray(files) ||
    files.length === 0 ||
    !files.every((file) => typeof file === 'string')
  ) {
    throw new Error('upload: files is required (array of local file paths)');
  }
  return onCurrentTab(args, async (send) => {
    const document = record(await send('DOM.getDocument'));
    const rootId = integer(record(document['root'])['nodeId']);
    if (rootId === undefined) throw new Error('upload: document has no root');
    const query = record(
      await send('DOM.querySelector', { nodeId: rootId, selector }),
    );
    const nodeId = integer(query['nodeId']);
    if (!nodeId) throw new Error(`upload: element not found: ${selector}`);
    await send('DOM.setFileInputFiles', { files, nodeId });
    return { success: true, fileCount: files.length };
  });
}

async function closeTab(args: Args): Promise<unknown> {
  const tabId = integer(args['_tabId']);
  if (tabId === undefined) {
    return { success: true, closed: false, reason: 'session has no tab' };
  }
  if (tabUsedByAnotherSession(tabId, string(args['_session']))) {
    return {
      success: false,
      closed: false,
      reason: 'tab is used by another session',
    };
  }
  let closed = true;
  try {
    await chrome.tabs.remove(tabId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/no tab|tab not found|invalid tab id/i.test(message)) {
      throw new Error(`close_tab: ${message}`);
    }
    closed = false;
  }
  refsByTab.delete(tabId);
  forgetTab(tabId);
  for (const [key, capture] of networkCaptures) {
    if (capture.tabId === tabId) networkCaptures.delete(key);
  }
  stopNetworkListenerIfIdle();
  await releaseCdpTab(tabId);
  return closed
    ? { success: true, closed: true }
    : { success: true, closed: false, reason: 'tab already closed' };
}

async function listTabs(args: Args): Promise<unknown> {
  const tabs = [];
  for (const tabId of tabIds(args)) {
    try {
      const tab = await chrome.tabs.get(tabId);
      let groupTitle: string | undefined;
      if (
        tab.groupId !== undefined &&
        tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE
      ) {
        try {
          groupTitle = (await chrome.tabGroups.get(tab.groupId)).title;
        } catch {
          // Group may have just been removed.
        }
      }
      tabs.push({
        tabId,
        url: tab.url ?? '',
        title: tab.title ?? '',
        active: tab.active,
        groupTitle,
      });
    } catch {
      // Ignore tabs the user already closed.
      refsByTab.delete(tabId);
      forgetTab(tabId);
      for (const [key, capture] of networkCaptures) {
        if (capture.tabId === tabId) networkCaptures.delete(key);
      }
    }
  }
  stopNetworkListenerIfIdle();
  return { success: true, tabs };
}

async function closeSession(args: Args): Promise<unknown> {
  const session = string(args['_session']);
  const touched = session
    ? new Set(tabsBySession.get(session) ?? [])
    : new Set<number>();
  const currentTabId = integer(args['_tabId']);
  if (currentTabId !== undefined) touched.add(currentTabId);
  const owned = new Set(tabIds(args));
  if (args['close_tabs'] === false) {
    let released = 0;
    for (const tabId of new Set([...touched, ...owned])) {
      const shared = tabUsedByAnotherSession(tabId, session);
      const captured = [...networkCaptures.values()].some(
        (capture) => capture.tabId === tabId && capture.session !== session,
      );
      if (!captured) {
        await releaseCdpTab(tabId);
        released++;
      }
      if (!shared) refsByTab.delete(tabId);
    }
    forgetSession(session);
    return { success: true, closed: 0, released };
  }
  let closed = 0;
  for (const tabId of owned) {
    const shared = tabUsedByAnotherSession(tabId, session);
    if (shared) {
      const captured = [...networkCaptures.values()].some(
        (capture) => capture.tabId === tabId && capture.session !== session,
      );
      if (!captured) await releaseCdpTab(tabId);
      continue;
    }
    try {
      await chrome.tabs.remove(tabId);
      closed++;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/no tab|tab not found|invalid tab id/i.test(message)) {
        throw new Error(`close_session: ${message}`);
      }
    }
    refsByTab.delete(tabId);
    await releaseCdpTab(tabId);
    forgetTab(tabId);
    for (const [key, capture] of networkCaptures) {
      if (capture.tabId === tabId) networkCaptures.delete(key);
    }
  }
  for (const tabId of touched) {
    if (owned.has(tabId) || tabUsedByAnotherSession(tabId, session)) continue;
    await releaseCdpTab(tabId);
  }
  forgetSession(session);
  return { success: true, closed };
}

function forgetSession(session: string | undefined): void {
  if (!session) return;
  tabsBySession.delete(session);
  groupBySession.delete(session);
  for (const [key, capture] of networkCaptures) {
    if (capture.session === session) networkCaptures.delete(key);
  }
  for (const refsBySession of refsByTab.values()) {
    refsBySession.delete(session);
  }
  stopNetworkListenerIfIdle();
}

async function currentTab(
  args: Args,
): Promise<chrome.tabs.Tab & { id: number }> {
  const tabId = integer(args['_tabId']);
  if (tabId === undefined) {
    throw new Error(
      'No current tab for this session; call navigate or find_tab first',
    );
  }
  const tab = await chrome.tabs.get(tabId).catch(() => {
    throw new Error('No active tab found');
  });
  if (!tab || tab.id === undefined) throw new Error('No active tab found');
  return tab as chrome.tabs.Tab & { id: number };
}

async function onCurrentTab<T>(
  args: Args,
  operation: (send: CdpCommand, tabId: number) => Promise<T>,
): Promise<T> {
  const tab = await currentTab(args);
  rememberTab(args, tab.id);
  return withCdpTab(tab.id, (send) => operation(send, tab.id));
}

async function waitForLoad(
  tabId: number,
  requestedUrl: string,
): Promise<chrome.tabs.Tab> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === 'complete' && tab.url?.startsWith('chrome-error://')) {
      throw new Error('navigate: page failed to load');
    }
    if (
      tab.status === 'complete' &&
      tab.url &&
      (tab.url !== 'about:blank' || requestedUrl === 'about:blank')
    ) {
      return tab;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('navigate: page load timeout (30s)');
}

async function groupTab(tabId: number, args: Args): Promise<void> {
  const session = string(args['_session']);
  if (!session) return;
  const knownGroup = groupBySession.get(session);
  if (knownGroup !== undefined) {
    try {
      await chrome.tabs.group({ tabIds: tabId, groupId: knownGroup });
      return;
    } catch {
      groupBySession.delete(session);
    }
  }
  for (const existingTabId of tabIds(args)) {
    try {
      const existing = await chrome.tabs.get(existingTabId);
      if (
        existing.groupId === undefined ||
        existing.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE
      ) {
        continue;
      }
      await chrome.tabs.group({ tabIds: tabId, groupId: existing.groupId });
      groupBySession.set(session, existing.groupId);
      return;
    } catch {
      // Try another owned tab before creating a replacement group.
    }
  }
  const title = string(args['group_title']) ?? `agent:${session}`;
  const groupId = await chrome.tabs.group({ tabIds: tabId });
  await chrome.tabGroups.update(groupId, {
    title,
    color: 'blue',
    collapsed: false,
  });
  groupBySession.set(session, groupId);
}

function formatAccessibilityTree(
  rawNodes: unknown[],
  refs: Map<string, ElementRef>,
  startRef = 0,
): unknown[] {
  const nodes = rawNodes.map(record);
  const byId = new Map<string, JsonRecord>();
  for (const node of nodes) {
    const nodeId = string(node['nodeId']);
    if (nodeId) byId.set(nodeId, node);
  }
  const format = (node: JsonRecord): unknown => {
    const role = string(record(node['role'])['value']);
    const childIds = Array.isArray(node['childIds']) ? node['childIds'] : [];
    const children = childIds
      .map((id) => byId.get(String(id)))
      .filter((child): child is JsonRecord => child !== undefined)
      .flatMap((child) => {
        const value = format(child);
        return Array.isArray(value) ? value : value ? [value] : [];
      });
    if (!role || role === 'none' || role === 'generic') return children;
    const output: JsonRecord = { role };
    for (const field of ['name', 'value', 'description']) {
      const value = record(node[field])['value'];
      if (value !== undefined && value !== '') output[field] = value;
    }
    const backendNodeId = integer(node['backendDOMNodeId']);
    if (INTERACTIVE_ROLES.has(role) && backendNodeId !== undefined) {
      const ref = `e${startRef + refs.size + 1}`;
      refs.set(ref, { backendNodeId });
      output['ref'] = `@${ref}`;
    }
    if (children.length > 0) output['children'] = children;
    return output;
  };
  if (nodes.length === 0) return [];
  const rootChildren = Array.isArray(nodes[0]['childIds'])
    ? nodes[0]['childIds']
    : [];
  return rootChildren
    .map((id) => byId.get(String(id)))
    .filter((node): node is JsonRecord => node !== undefined)
    .flatMap((node) => {
      const value = format(node);
      return Array.isArray(value) ? value : value ? [value] : [];
    });
}

async function objectIdFromSelectorOrRef(
  action: string,
  selector: string,
  tabId: number,
  session: string,
  send: CdpCommand,
): Promise<string> {
  if (isRef(selector)) {
    return objectIdFromRef(action, selector, tabId, session, send);
  }
  const result = record(
    await send('Runtime.evaluate', {
      expression: `document.querySelector(${JSON.stringify(selector)})`,
      returnByValue: false,
    }),
  );
  throwOnCdpException(action, result);
  const remote = record(result['result']);
  const objectId = string(remote['objectId']);
  if (!objectId || remote['subtype'] === 'null') {
    throw new Error(`${action}: element not found: ${selector}`);
  }
  return objectId;
}

async function objectIdFromRef(
  action: string,
  selector: string,
  tabId: number,
  session: string,
  send: CdpCommand,
): Promise<string> {
  const ref = selector.startsWith('@') ? selector.slice(1) : selector;
  const entry = refsByTab.get(tabId)?.get(session);
  const element = entry?.refs.get(ref);
  if (!entry || !element) {
    throw new Error(`${action}: unknown ref "${selector}". Run snapshot first`);
  }
  if (entry.loaderId !== undefined) {
    const currentLoaderId = await topFrameLoaderId(send);
    if (currentLoaderId !== entry.loaderId) {
      throw new Error(
        `${action}: unknown ref "${selector}". Page changed, run snapshot first`,
      );
    }
  }
  const result = record(
    await send('DOM.resolveNode', { backendNodeId: element.backendNodeId }),
  );
  const objectId = string(record(result['object'])['objectId']);
  if (!objectId)
    throw new Error(`${action}: could not resolve ref "${selector}"`);
  return objectId;
}

function fillFunction(value: unknown): string {
  const json = JSON.stringify(value);
  return `const target = __TARGET__; target.focus(); if (target.isContentEditable) { const selection = window.getSelection(); if (selection) { const range = document.createRange(); range.selectNodeContents(target); selection.removeAllRanges(); selection.addRange(range); } let inserted = false; try { inserted = document.execCommand('insertText', false, ${json}); } catch {} if (!inserted) { target.textContent = ${json}; target.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: ${json}, bubbles: true })); } return { success: true, tag: target.tagName, mode: 'contenteditable' }; } const prototype = target instanceof window.HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype; const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set; if (setter) setter.call(target, ${json}); else target.value = ${json}; target.dispatchEvent(new Event('input', { bubbles: true })); target.dispatchEvent(new Event('change', { bubbles: true })); return { success: true, tag: target.tagName, mode: 'value' };`;
}

function installNetworkListener(): void {
  if (removeNetworkListener) return;
  removeNetworkListener = subscribeCdpEvents((method, params, tabId) => {
    const requestId = string(params['requestId']);
    if (!requestId) return;
    for (const capture of networkCaptures.values()) {
      if (capture.tabId !== tabId) continue;
      const requests = capture.requests;
      if (method === 'Network.requestWillBeSent') {
        const request = record(params['request']);
        if (!requests.has(requestId) && requests.size >= MAX_NETWORK_REQUESTS) {
          const oldest = requests.keys().next().value;
          if (oldest !== undefined) requests.delete(oldest);
        }
        requests.set(requestId, {
          requestId,
          url: string(request['url']) ?? '',
          method: string(request['method']) ?? '',
        });
      } else if (method === 'Network.responseReceived') {
        const request = requests.get(requestId);
        const response = record(params['response']);
        if (request) {
          request.status = number(response['status']);
          request.mimeType = string(response['mimeType']);
        }
      } else if (method === 'Network.loadingFinished') {
        const request = requests.get(requestId);
        if (request) request.completed = true;
      } else if (method === 'Network.loadingFailed') {
        const request = requests.get(requestId);
        if (request) {
          request.completed = true;
          request.failed = true;
          request.errorText = string(params['errorText']);
        }
      }
    }
  });
}

function stopNetworkListenerIfIdle(): void {
  if (networkCaptures.size > 0) return;
  removeNetworkListener?.();
  removeNetworkListener = undefined;
}

async function releaseIdleTabs(args: Args): Promise<void> {
  const ids = new Set(tabIds(args));
  const currentTabId = integer(args['_tabId']);
  if (currentTabId !== undefined) ids.add(currentTabId);
  const session = string(args['_session']);
  if (session) {
    for (const tabId of tabsBySession.get(session) ?? []) ids.add(tabId);
  }
  for (const tabId of ids) {
    const capturing = [...networkCaptures.values()].some(
      (capture) => capture.tabId === tabId,
    );
    if (capturing) continue;
    try {
      await releaseCdpTab(tabId);
    } catch {
      // The tab may already be gone; keep releasing the rest.
    }
  }
}

function rememberTab(args: Args, tabId: number): void {
  const session = string(args['_session']);
  if (!session) return;
  const tabs = tabsBySession.get(session) ?? new Set<number>();
  tabs.add(tabId);
  tabsBySession.set(session, tabs);
}

function forgetTab(tabId: number): void {
  for (const [session, tabs] of tabsBySession) {
    tabs.delete(tabId);
    if (tabs.size === 0) tabsBySession.delete(session);
  }
}

function tabUsedByAnotherSession(
  tabId: number,
  excludedSession?: string,
): boolean {
  return [...tabsBySession].some(
    ([session, tabs]) => session !== excludedSession && tabs.has(tabId),
  );
}

function sessionKey(args: Args): string {
  return string(args['_session']) ?? '';
}

interface KeySpec {
  key: string;
  code: string;
  virtualKeyCode: number;
  text?: string;
}

interface KeySequence {
  modifiers: Array<KeySpec & { bit: number }>;
  key: KeySpec;
  modifierBits: number;
}

// US-layout shifted characters for `shift+<digit>` — without this the page
// would receive the bare digit with Shift held, a combination no physical
// keyboard produces.
const SHIFTED_DIGITS: Record<string, string> = {
  '1': '!',
  '2': '@',
  '3': '#',
  '4': '$',
  '5': '%',
  '6': '^',
  '7': '&',
  '8': '*',
  '9': '(',
  '0': ')',
};

const MODIFIERS: Record<string, KeySpec & { bit: number }> = {
  alt: { bit: 1, key: 'Alt', code: 'AltLeft', virtualKeyCode: 18 },
  ctrl: { bit: 2, key: 'Control', code: 'ControlLeft', virtualKeyCode: 17 },
  control: { bit: 2, key: 'Control', code: 'ControlLeft', virtualKeyCode: 17 },
  cmd: { bit: 4, key: 'Meta', code: 'MetaLeft', virtualKeyCode: 91 },
  meta: { bit: 4, key: 'Meta', code: 'MetaLeft', virtualKeyCode: 91 },
  shift: { bit: 8, key: 'Shift', code: 'ShiftLeft', virtualKeyCode: 16 },
};

const SPECIAL_KEYS: Record<string, KeySpec> = {
  enter: { key: 'Enter', code: 'Enter', virtualKeyCode: 13, text: '\r' },
  return: { key: 'Enter', code: 'Enter', virtualKeyCode: 13, text: '\r' },
  escape: { key: 'Escape', code: 'Escape', virtualKeyCode: 27 },
  esc: { key: 'Escape', code: 'Escape', virtualKeyCode: 27 },
  tab: { key: 'Tab', code: 'Tab', virtualKeyCode: 9 },
  backspace: { key: 'Backspace', code: 'Backspace', virtualKeyCode: 8 },
  delete: { key: 'Delete', code: 'Delete', virtualKeyCode: 46 },
  space: { key: ' ', code: 'Space', virtualKeyCode: 32, text: ' ' },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', virtualKeyCode: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', virtualKeyCode: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', virtualKeyCode: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', virtualKeyCode: 39 },
  home: { key: 'Home', code: 'Home', virtualKeyCode: 36 },
  end: { key: 'End', code: 'End', virtualKeyCode: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', virtualKeyCode: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', virtualKeyCode: 34 },
};

function parseKey(value: string, platform: string): KeySequence {
  const parts = value
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) throw new Error('send_keys: empty segment');
  const modifiers = parts.slice(0, -1).map((part) => {
    const normalized = part.toLowerCase();
    const modifier =
      normalized === 'mod'
        ? platform === 'mac'
          ? MODIFIERS['cmd']
          : MODIFIERS['ctrl']
        : Object.prototype.hasOwnProperty.call(MODIFIERS, normalized)
          ? MODIFIERS[normalized]
          : undefined;
    if (!modifier) throw new Error(`send_keys: "${part}" is not a modifier`);
    return modifier;
  });
  return {
    modifiers,
    key: keySpec(parts.at(-1) ?? ''),
    modifierBits: modifiers.reduce((bits, modifier) => bits | modifier.bit, 0),
  };
}

function keySpec(value: string): KeySpec {
  const normalized = value.toLowerCase();
  const special = Object.prototype.hasOwnProperty.call(SPECIAL_KEYS, normalized)
    ? SPECIAL_KEYS[normalized]
    : undefined;
  if (special) return special;
  const functionKey = /^f(\d{1,2})$/i.exec(value);
  if (functionKey) {
    const index = Number(functionKey[1]);
    if (index >= 1 && index <= 12) {
      return {
        key: `F${index}`,
        code: `F${index}`,
        virtualKeyCode: 111 + index,
      };
    }
  }
  if (/^[a-z]$/i.test(value)) {
    const upper = value.toUpperCase();
    return {
      key: value.toLowerCase(),
      code: `Key${upper}`,
      virtualKeyCode: upper.charCodeAt(0),
      text: value.toLowerCase(),
    };
  }
  if (/^\d$/.test(value)) {
    return {
      key: value,
      code: `Digit${value}`,
      virtualKeyCode: value.charCodeAt(0),
      text: value,
    };
  }
  throw new Error(`send_keys: unknown key "${value}"`);
}

async function dispatchKey(
  send: CdpCommand,
  sequence: KeySequence,
): Promise<void> {
  let activeBits = 0;
  const pressed: KeySequence['modifiers'] = [];
  const shifted = (sequence.modifierBits & 8) !== 0;
  const shiftedDigit = SHIFTED_DIGITS[sequence.key.key];
  const key =
    shifted && /^[a-z]$/.test(sequence.key.key)
      ? {
          ...sequence.key,
          key: sequence.key.key.toUpperCase(),
          text: sequence.key.text?.toUpperCase(),
        }
      : shifted && shiftedDigit !== undefined
        ? {
            ...sequence.key,
            key: shiftedDigit,
            text: shiftedDigit,
          }
        : sequence.key;
  const printable =
    (sequence.modifierBits & ~8) === 0 && key.text !== undefined
      ? { text: key.text }
      : {};
  const commands =
    key.key === 'a' &&
    sequence.modifiers.some(
      (modifier) => modifier.key === 'Meta' || modifier.key === 'Control',
    )
      ? { commands: ['selectAll'] }
      : {};
  let keyPressed = false;
  let failure: unknown;
  try {
    for (const modifier of sequence.modifiers) {
      const nextBits = activeBits | modifier.bit;
      await send(
        'Input.dispatchKeyEvent',
        keyEvent('rawKeyDown', modifier, nextBits),
      );
      activeBits = nextBits;
      pressed.push(modifier);
    }
    await send('Input.dispatchKeyEvent', {
      ...keyEvent(
        Object.keys(printable).length === 0 ? 'rawKeyDown' : 'keyDown',
        key,
        sequence.modifierBits,
      ),
      ...printable,
      ...commands,
    });
    keyPressed = true;
    await send(
      'Input.dispatchKeyEvent',
      keyEvent('keyUp', key, sequence.modifierBits),
    );
    keyPressed = false;
  } catch (error) {
    failure = error;
  }
  let cleanupError: unknown;
  if (keyPressed) {
    try {
      await send(
        'Input.dispatchKeyEvent',
        keyEvent('keyUp', key, sequence.modifierBits),
      );
    } catch (error) {
      cleanupError = error;
    }
  }
  for (const modifier of pressed.reverse()) {
    activeBits &= ~modifier.bit;
    try {
      await send(
        'Input.dispatchKeyEvent',
        keyEvent('keyUp', modifier, activeBits),
      );
    } catch (error) {
      cleanupError ??= error;
    }
  }
  if (failure !== undefined) throw failure;
  if (cleanupError !== undefined) throw cleanupError;
}

function keyEvent(type: string, spec: KeySpec, modifiers: number): JsonRecord {
  return {
    type,
    modifiers,
    key: spec.key,
    code: spec.code,
    windowsVirtualKeyCode: spec.virtualKeyCode,
  };
}

function checkedValue(action: string, result: JsonRecord): unknown {
  throwOnCdpException(action, result);
  const value = record(record(result['result'])['value']);
  if (typeof value['error'] === 'string') throw new Error(value['error']);
  return value;
}

function throwOnCdpException(action: string, result: JsonRecord): void {
  const details = result['exceptionDetails'];
  if (!isRecord(details)) return;
  const description = string(record(details['exception'])['description']);
  throw new Error(
    `${action}: ${description ?? string(details['text']) ?? 'JavaScript exception'}`,
  );
}

function tabIds(args: Args): number[] {
  const ids = args['_tabIds'];
  if (Array.isArray(ids))
    return ids.filter((id): id is number => integer(id) !== undefined);
  const tabId = integer(args['_tabId']);
  return tabId === undefined ? [] : [tabId];
}

function matchesHost(actual: string | undefined, requested: string): boolean {
  if (!actual) return false;
  try {
    const expectedHost = new URL(
      requested.includes('://')
        ? requested.replace(/^\*:\/\//, 'https://')
        : `https://${requested}`,
    ).hostname;
    const hostname = new URL(actual).hostname;
    return expectedHost.startsWith('*.')
      ? hostname === expectedHost.slice(2) ||
          hostname.endsWith(expectedHost.slice(1))
      : hostname === expectedHost;
  } catch {
    return false;
  }
}

function matchesRequestedUrl(
  actual: string | undefined,
  requested: string,
): boolean {
  if (!actual) return false;
  if (requested === '*') return true;
  if (requested.includes('://') && !requested.includes('*')) {
    return matchesExactUrl(actual, requested);
  }
  if (!requested.includes('*')) {
    // A schemeless request is host[:port][/path]: parse it as an https://
    // URL so the port and path participate in the match. Hostname-only
    // matching used to discard the port (`localhost:9222` matched a :3000
    // tab), and `host:port/path` was misparsed as an opaque-scheme URL and
    // never matched. Requests that cannot be a host (about:, data:, …)
    // fall through to href comparison.
    try {
      const expected = new URL(`https://${requested}`);
      const actualUrl = new URL(actual);
      if (expected.hostname !== actualUrl.hostname) return false;
      if (expected.port !== '' && expected.port !== actualUrl.port) {
        return false;
      }
      if (
        expected.pathname !== '/' &&
        !actualUrl.pathname.startsWith(expected.pathname)
      ) {
        return false;
      }
      return true;
    } catch {
      try {
        return new URL(actual).href === new URL(requested).href;
      } catch {
        return false;
      }
    }
  }
  return matchesHost(actual, requested);
}

function matchesExactUrl(
  actual: string | undefined,
  requested: string,
): boolean {
  if (!actual || !requested.includes('://') || requested.includes('*')) {
    return false;
  }
  try {
    return new URL(actual).href === new URL(requested).href;
  } catch {
    return false;
  }
}

function requiredString(
  args: Args,
  key: string,
  action: string,
  allowEmpty = false,
): string {
  const value = args[key];
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    throw new Error(`${action}: ${key} is required`);
  }
  return value;
}

function isRef(value: string): boolean {
  return /^@?e\d+$/.test(value);
}

function record(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function integer(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value)
    ? value
    : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function numberArray(value: unknown): value is number[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === 'number')
  );
}
