/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  BridgeConnectionListener,
  BridgeEvent,
  BridgeEventListener,
  ChromeBridge,
} from '../bridge/index.js';

import { BrowserRuntimeError } from './index.js';

// 1x1 transparent PNG: lets the runtime parse real IHDR dimensions.
const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

export class FakeBridge implements ChromeBridge {
  connected = true;
  started = false;
  stopped = false;
  devicePixelRatio = 1;
  redirects: Record<string, string> = {};
  hitTarget = 'ok';
  checked = false;
  inputValue = '';
  scrollTop = 0;
  wheelScrolls = true;
  scrollFallbackCalls = 0;
  navigationEventDelayMs = 0;
  networkResponseBodyDelayMs = 0;
  readonly networkResponseBodies = new Map<
    string,
    { body: string; base64Encoded?: boolean }
  >();
  domSnapshotText = '- heading "Inbox"';
  onDomSnapshot: (() => void) | undefined;
  onEvaluation: ((expression: string) => void) | undefined;
  focusResult: Record<string, unknown> = {
    focused: true,
    ref: 'n1',
    editable: true,
  };
  contentSize = { width: 1_280, height: 1_600 };
  readonly extraOpenTabs: Array<Record<string, unknown>> = [];
  readonly historyEntries: Array<Record<string, unknown>> = [
    {
      url: 'https://mail.example/invoice',
      title: 'Invoice',
      dateVisited: '2026-08-20T12:00:00.000Z',
    },
  ];
  readonly failCdpMethods = new Set<string>();
  readonly unsupportedTabIds = new Set<number>();
  current = {
    providerTabId: 41,
    title: 'Inbox',
    url: 'https://mail.example/inbox',
    active: true,
    windowId: 2,
  };
  readonly calls: Array<{ method: string; params: Record<string, unknown> }> =
    [];
  readonly listeners = new Set<BridgeEventListener>();
  readonly connectionListeners = new Set<BridgeConnectionListener>();

  async start(): Promise<void> {
    this.started = true;
  }

  onEvent(listener: BridgeEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  onConnectionChange(listener: BridgeConnectionListener): () => void {
    this.connectionListeners.add(listener);
    return () => {
      this.connectionListeners.delete(listener);
    };
  }

  setConnected(connected: boolean): void {
    if (this.connected === connected) return;
    this.connected = connected;
    for (const listener of this.connectionListeners) listener(connected);
  }

  emit(method: string, params: unknown, tabId = 41): void {
    const event: BridgeEvent = { type: 'event', tabId, method, params };
    for (const listener of this.listeners) listener(event);
  }

  isConnected(): boolean {
    return this.connected;
  }

  async request(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<unknown> {
    this.calls.push({ method, params });
    if (!this.connected)
      throw new BrowserRuntimeError('BROWSER_DISCONNECTED', 'not connected');
    switch (method) {
      case 'ping':
        return { ok: true };
      case 'tabs.queryOpen':
        return [this.current, ...this.extraOpenTabs];
      case 'tabs.queryDerived':
        return this.extraOpenTabs.filter(
          (tab) => tab.derivedFromProviderTabId !== undefined,
        );
      case 'history.query':
        return this.historyEntries;
      case 'tabs.get': {
        const tabId = params.tabId;
        if (typeof tabId === 'number' && this.unsupportedTabIds.has(tabId)) {
          throw new BrowserRuntimeError('UNSUPPORTED_TAB', 'unsupported tab');
        }
        return tabId === this.current.providerTabId
          ? this.current
          : (this.extraOpenTabs.find((tab) => tab.providerTabId === tabId) ??
              this.current);
      }
      case 'tabs.attach':
      case 'tabs.detach':
      case 'tabs.close':
      case 'tabs.activate':
      case 'session.name':
        return null;
      case 'tabs.create':
        return this.current;
      case 'cdp.send':
        return await this.handleCdp(params);
      default:
        throw new Error(`Unexpected bridge method: ${method}`);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }

  private async handleCdp(params: Record<string, unknown>): Promise<unknown> {
    const cdpMethod = params.method;
    const cdpParams = params.params as Record<string, unknown>;
    if (typeof cdpMethod === 'string' && this.failCdpMethods.has(cdpMethod)) {
      throw new BrowserRuntimeError('OPERATION_FAILED', `${cdpMethod} failed`);
    }
    if (cdpMethod === 'Page.navigate') {
      const normalized = new URL(String(cdpParams.url)).href;
      this.current = {
        ...this.current,
        url: this.redirects[normalized] ?? normalized,
        title: 'Target',
      };
      this.emitCommittedNavigation();
      return { frameId: 'main', loaderId: 'loader-1' };
    }
    if (
      cdpMethod === 'Page.reload' ||
      cdpMethod === 'Page.navigateToHistoryEntry'
    ) {
      this.emitCommittedNavigation();
      return {};
    }
    if (cdpMethod === 'Page.captureScreenshot') return { data: TINY_PNG };
    if (cdpMethod === 'Network.getResponseBody') {
      if (this.networkResponseBodyDelayMs > 0) {
        await new Promise((resolve) =>
          setTimeout(resolve, this.networkResponseBodyDelayMs),
        );
      }
      return (
        this.networkResponseBodies.get(String(cdpParams.requestId)) ?? {
          body: '',
          base64Encoded: false,
        }
      );
    }
    if (cdpMethod === 'Page.getLayoutMetrics') {
      return {
        cssVisualViewport: {
          pageX: 0,
          pageY: 0,
          clientWidth: 1_280,
          clientHeight: 800,
        },
        cssLayoutViewport: { clientWidth: 1_280, clientHeight: 800 },
        cssContentSize: { x: 0, y: 0, ...this.contentSize },
      };
    }
    if (
      [
        'DOM.scrollIntoViewIfNeeded',
        'Runtime.releaseObject',
        'DOM.setFileInputFiles',
        'Target.setAutoAttach',
      ].includes(String(cdpMethod))
    )
      return {};
    if (cdpMethod === 'DOM.describeNode') {
      const objectId = String(cdpParams.objectId);
      if (objectId.startsWith('iframe-'))
        return {
          node: {
            nodeName: 'IFRAME',
            frameId: `F-${objectId.slice('iframe-'.length)}`,
          },
        };
      return { node: { nodeName: 'BUTTON' } };
    }
    if (cdpMethod === 'DOM.getBoxModel')
      return { model: { content: [100, 200, 500, 200, 500, 500, 100, 500] } };
    if (cdpMethod === 'DOM.getContentQuads')
      return { quads: [[10, 20, 110, 20, 110, 60, 10, 60]] };
    if (cdpMethod === 'Input.dispatchMouseEvent') {
      if (cdpParams.type === 'mousePressed') this.checked = !this.checked;
      if (cdpParams.type === 'mouseWheel' && this.wheelScrolls)
        this.scrollTop += Number(cdpParams.deltaY ?? 0);
      return {};
    }
    if (cdpMethod === 'Input.dispatchKeyEvent') {
      if (cdpParams.type === 'keyDown' && typeof cdpParams.text === 'string')
        this.inputValue += cdpParams.text;
      return {};
    }
    if (cdpMethod === 'Input.insertText') {
      this.inputValue += String(cdpParams.text ?? '');
      return {};
    }
    if (cdpMethod === 'Runtime.callFunctionOn')
      return this.handleFunctionCall(cdpParams);
    if (cdpMethod === 'Runtime.evaluate')
      return await this.handleEvaluation(cdpParams);
    if (cdpMethod === 'Page.getNavigationHistory')
      return { currentIndex: 0, entries: [{ id: 1 }] };
    return {};
  }

  private handleFunctionCall(params: Record<string, unknown>): unknown {
    const declaration = String(params.functionDeclaration);
    if (declaration.includes('__qwenBrowserScrollState')) {
      return {
        result: {
          value: [{ left: 0, top: this.scrollTop, width: 100, height: 1_000 }],
        },
      };
    }
    if (declaration.includes('__qwenBrowserScrollFallback')) {
      const callArgs = Array.isArray(params.arguments)
        ? (params.arguments as Array<Record<string, unknown>>)
        : [];
      this.scrollFallbackCalls += 1;
      this.scrollTop += Number(callArgs[1]?.value ?? 0);
      return { result: { value: true } };
    }
    if (declaration.includes('elementFromPoint'))
      return { result: { value: this.hitTarget } };
    if (declaration.includes('checkable'))
      return {
        result: { value: { kind: 'checkable', checked: this.checked } },
      };
    if (declaration.includes('this.type === "file"'))
      return { result: { value: 'file' } };
    return { result: { value: null } };
  }

  private async handleEvaluation(
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const expression = String(params.expression);
    this.onEvaluation?.(expression);
    if (
      expression.includes('__qwenBrowserInputBarrier') ||
      expression.includes('__qwenBrowserScrollBarrier')
    ) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      return { result: { value: null } };
    }
    if (params.returnByValue === false) {
      const iframe = /"selector":"#(same|cross)"|"ref":"(n5)"/.exec(expression);
      const objectId =
        iframe === null
          ? 'node-1'
          : iframe[1] === 'same' || iframe[2] === 'n5'
            ? 'iframe-same'
            : 'iframe-cross';
      return { result: { type: 'object', subtype: 'node', objectId } };
    }
    if (expression.includes('return 6 * 7;')) return { result: { value: 42 } };
    if (expression.includes('return element.id;'))
      return { result: { value: 'submit' } };
    if (expression.includes('return elements.length;'))
      return { result: { value: 3 } };
    if (expression.includes('"operation":"readyState"'))
      return { result: { value: 'complete' } };
    if (expression.includes('"operation":"viewport"')) {
      return {
        result: {
          value: {
            devicePixelRatio: this.devicePixelRatio,
            width: 1_280,
            height: 800,
          },
        },
      };
    }
    if (expression.includes('"operation":"domSnapshot"')) {
      const onDomSnapshot = this.onDomSnapshot;
      this.onDomSnapshot = undefined;
      onDomSnapshot?.();
      return {
        result: {
          value:
            params.contextId === undefined
              ? this.domSnapshotText
              : '  - button "Inside" [n5/n1]',
        },
      };
    }
    if (expression.includes('"operation":"count"'))
      return { result: { value: 3 } };
    if (expression.includes('"operation":"focus"'))
      return { result: { value: this.focusResult } };
    if (expression.includes('"operation":"inputValue"'))
      return { result: { value: this.inputValue } };
    return { result: { value: null } };
  }

  private emitCommittedNavigation(): void {
    const emit = (): void =>
      this.emit('Page.frameNavigated', {
        frame: { id: 'main', url: this.current.url },
      });
    if (this.navigationEventDelayMs > 0)
      setTimeout(emit, this.navigationEventDelayMs);
    else emit();
  }
}
