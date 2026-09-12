/**
 * Copyright (c) Microsoft Corporation.
 * Licensed under the Apache License, Version 2.0.
 *
 * Adapted from Playwright's browserModel.ts at revision
 * 350d24a344b07543fdc4014339a7871fd1c1b227.
 */

import type { BridgeEvent, ChromeBridge } from '../bridge/index.js';
import { CDP_REQUEST_TIMEOUT_MS } from '../bridge/protocol.js';

export interface CdpMessage {
  id?: number;
  sessionId?: string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { message: string };
}

interface TargetInfo {
  targetId: string;
  type: string;
  title: string;
  url: string;
  attached?: boolean;
  browserContextId?: string;
  [key: string]: unknown;
}

interface TabSession {
  tabId: number;
  sessionId: string;
  targetInfo: TargetInfo;
  childSessions: Map<string, TargetInfo>;
}

interface ExplicitPageSession {
  parentSessionId: string;
  tabSession: TabSession;
  targetInfo: TargetInfo;
  sourceSessionId?: string;
}

export class BrowserModel {
  private readonly bridge: ChromeBridge;
  private readonly tabSessions = new Map<number, TabSession>();
  private readonly browserSessions = new Set<string>();
  private readonly explicitPageSessions = new Map<
    string,
    ExplicitPageSession
  >();
  private sendToPlaywright: ((message: CdpMessage) => void) | undefined;
  private nextSessionId = 1;
  private readonly ownedTabs = new Set<number>();
  private readonly operations = new Map<number, Promise<void>>();
  private closing: Promise<void> | undefined;

  constructor(bridge: ChromeBridge) {
    this.bridge = bridge;
  }

  connect(send: (message: CdpMessage) => void): void {
    this.sendToPlaywright = send;
  }

  async registerTab(tabId: number): Promise<TargetInfo> {
    return await this.serializeTab(tabId, async () => {
      this.assertOpen();
      try {
        return (await this.attachTab(tabId)).targetInfo;
      } catch (error) {
        await this.releaseTab(tabId);
        throw error;
      }
    });
  }

  async unregisterTab(tabId: number): Promise<void> {
    await this.serializeTab(tabId, async () => this.releaseTab(tabId));
  }

  close(): Promise<void> {
    if (this.closing !== undefined) return this.closing;
    // A disconnected bridge no longer owns debugger attachments. Never send
    // old cleanup to a replacement connection that may claim the same tabs.
    if (!this.bridge.isConnected()) this.ownedTabs.clear();
    const tabIds = new Set([...this.ownedTabs, ...this.operations.keys()]);
    this.closing = Promise.allSettled(
      [...tabIds].map(async (tabId) => this.unregisterTab(tabId)),
    ).then(() => undefined);
    return this.closing;
  }

  private serializeTab<T>(
    tabId: number,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.operations.get(tabId) ?? Promise.resolve();
    const result = previous.then(operation);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.operations.set(tabId, settled);
    void settled.then(() => {
      if (this.operations.get(tabId) === settled) this.operations.delete(tabId);
    });
    return result;
  }

  private assertOpen(): void {
    if (this.closing !== undefined)
      throw new Error('Playwright transport is closed');
  }

  private assertOwned(tabId: number): void {
    // qwenBrowser.tabRemoved is handled outside the per-tab queue, so the
    // event can land while either request above is in flight.
    if (!this.ownedTabs.has(tabId))
      throw new Error(`Tab ${tabId} was removed during attachment`);
  }

  private async releaseTab(tabId: number): Promise<void> {
    this.detachTab(tabId);
    if (this.ownedTabs.delete(tabId) && this.bridge.isConnected())
      await this.bridge
        .request('tabs.detach', { tabId }, 2_000)
        .catch(() => undefined);
  }

  async onBridgeEvent(event: BridgeEvent): Promise<void> {
    if (this.closing !== undefined) return;
    if (
      event.method === 'qwenBrowser.tabRemoved' ||
      event.method === 'qwenBrowser.detached'
    ) {
      this.ownedTabs.delete(event.tabId);
      this.detachTab(event.tabId);
      return;
    }
    const tabSession = this.tabSessions.get(event.tabId);
    if (tabSession === undefined) return;
    if (
      event.method === 'Page.downloadWillBegin' ||
      event.method === 'Page.downloadProgress'
    ) {
      this.emit({
        method: event.method.replace('Page.', 'Browser.'),
        params: record(event.params),
      });
      return;
    }
    if (
      event.method === 'qwenBrowser.sessionDetached' &&
      event.sessionId !== undefined
    ) {
      // Playwright's OOPIF teardown looks the frame session up by the child
      // target id, so the event must carry it before the entry is dropped.
      const child = tabSession.childSessions.get(event.sessionId);
      tabSession.childSessions.delete(event.sessionId);
      this.detachExplicitSessions(
        (session) =>
          session.tabSession === tabSession &&
          session.sourceSessionId === event.sessionId,
      );
      this.emit({
        sessionId: tabSession.sessionId,
        method: 'Target.detachedFromTarget',
        params: {
          sessionId: event.sessionId,
          ...(child === undefined ? {} : { targetId: child.targetId }),
        },
      });
      return;
    }
    const params = { ...record(event.params) };
    const childSessionId = stringOrUndefined(params.sessionId);
    if (event.method === 'Target.attachedToTarget' && childSessionId) {
      const info = targetInfo(params.targetInfo);
      tabSession.childSessions.set(childSessionId, info);
      params.targetInfo = info;
    }
    if (event.method === 'Target.detachedFromTarget' && childSessionId) {
      tabSession.childSessions.delete(childSessionId);
      this.detachExplicitSessions(
        (session) =>
          session.tabSession === tabSession &&
          session.sourceSessionId === childSessionId,
      );
    }
    const sourceSessionId = event.sessionId;
    const message = {
      sessionId: sourceSessionId || tabSession.sessionId,
      method: event.method,
      params,
    };
    this.emit(message);
    for (const [sessionId, session] of this.explicitPageSessions) {
      if (
        session.tabSession === tabSession &&
        session.sourceSessionId === sourceSessionId
      )
        this.emit({ ...message, sessionId });
    }
  }

  getTargetInfo(sessionId: string | undefined): TargetInfo | undefined {
    if (sessionId === undefined) return undefined;
    const explicit = this.explicitPageSessions.get(sessionId);
    if (explicit !== undefined) return explicit.targetInfo;
    const root = this.findSession(
      (candidate) => candidate.sessionId === sessionId,
    );
    if (root !== undefined) return root.targetInfo;
    for (const session of this.tabSessions.values()) {
      const child = session.childSessions.get(sessionId);
      if (child !== undefined) return child;
    }
    return undefined;
  }

  providerTabId(targetId: string): number | undefined {
    return this.findSession(
      (candidate) => candidate.targetInfo.targetId === targetId,
    )?.tabId;
  }

  attachToBrowserTarget(): { sessionId: string } {
    const sessionId = `pw-browser-${this.nextSessionId++}`;
    this.browserSessions.add(sessionId);
    return { sessionId };
  }

  isBrowserSession(sessionId: string): boolean {
    return this.browserSessions.has(sessionId);
  }

  attachToTarget(
    parentSessionId: string,
    targetId: string,
  ): { sessionId: string } {
    if (!this.browserSessions.has(parentSessionId))
      throw new Error(`Unknown Playwright browser session: ${parentSessionId}`);
    const target = this.findTarget(targetId);
    if (target === undefined)
      throw new Error(`No controlled tab found for CDP target: ${targetId}`);
    const sessionId = `pw-cdp-${this.nextSessionId++}`;
    this.explicitPageSessions.set(sessionId, {
      parentSessionId,
      ...target,
    });
    return { sessionId };
  }

  detachFromTarget(parentSessionId: string, sessionId: string): void {
    const session = this.explicitPageSessions.get(sessionId);
    if (session?.parentSessionId !== parentSessionId)
      throw new Error(`Unknown Playwright target session: ${sessionId}`);
    this.detachExplicitSessions((candidate) => candidate === session);
  }

  async sendCommand(
    sessionId: string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const explicit = this.explicitPageSessions.get(sessionId);
    if (explicit !== undefined) {
      return await this.bridge.request(
        'cdp.send',
        {
          tabId: explicit.tabSession.tabId,
          method,
          params,
          ...(explicit.sourceSessionId === undefined
            ? {}
            : { sessionId: explicit.sourceSessionId }),
        },
        CDP_REQUEST_TIMEOUT_MS,
      );
    }
    let session = this.findSession(
      (candidate) => candidate.sessionId === sessionId,
    );
    let childSessionId: string | undefined;
    if (session === undefined) {
      session = this.findSession((candidate) =>
        candidate.childSessions.has(sessionId),
      );
      childSessionId = sessionId;
    }
    if (session === undefined)
      throw new Error(`No tab found for CDP session: ${sessionId}`);
    return await this.bridge.request(
      'cdp.send',
      {
        tabId: session.tabId,
        method,
        params,
        ...(childSessionId === undefined ? {} : { sessionId: childSessionId }),
      },
      CDP_REQUEST_TIMEOUT_MS,
    );
  }

  private async attachTab(tabId: number): Promise<TabSession> {
    const existing = this.tabSessions.get(tabId);
    if (existing !== undefined) return existing;
    this.ownedTabs.add(tabId);
    await this.bridge.request('tabs.attach', { tabId });
    this.assertOpen();
    this.assertOwned(tabId);
    const response = record(
      await this.bridge.request('cdp.send', {
        tabId,
        method: 'Target.getTargetInfo',
        params: {},
      }),
    );
    this.assertOpen();
    this.assertOwned(tabId);
    const info = targetInfo(response.targetInfo);
    // Playwright never enables CDP download events here (noDefaults), so the
    // bridge must: without this, Page.downloadWillBegin never fires and
    // waitForEvent('download') cannot resolve.
    await this.bridge.request('cdp.send', {
      tabId,
      method: 'Page.setDownloadBehavior',
      params: { behavior: 'default', eventsEnabled: true },
    });
    this.assertOpen();
    this.assertOwned(tabId);
    const session: TabSession = {
      tabId,
      sessionId: `pw-tab-${this.nextSessionId++}`,
      targetInfo: info,
      childSessions: new Map(),
    };
    this.tabSessions.set(tabId, session);
    this.emit({
      method: 'Target.attachedToTarget',
      params: {
        sessionId: session.sessionId,
        targetInfo: { ...info, attached: true },
        waitingForDebugger: false,
      },
    });
    return session;
  }

  private detachTab(tabId: number): void {
    const session = this.tabSessions.get(tabId);
    if (session === undefined) return;
    this.tabSessions.delete(tabId);
    this.detachExplicitSessions(
      (candidate) => candidate.tabSession === session,
    );
    this.emit({
      method: 'Target.detachedFromTarget',
      params: {
        sessionId: session.sessionId,
        targetId: session.targetInfo.targetId,
      },
    });
  }

  private findSession(
    predicate: (session: TabSession) => boolean,
  ): TabSession | undefined {
    for (const session of this.tabSessions.values()) {
      if (predicate(session)) return session;
    }
    return undefined;
  }

  private findTarget(
    targetId: string,
  ):
    | Pick<ExplicitPageSession, 'tabSession' | 'targetInfo' | 'sourceSessionId'>
    | undefined {
    for (const tabSession of this.tabSessions.values()) {
      if (tabSession.targetInfo.targetId === targetId)
        return { tabSession, targetInfo: tabSession.targetInfo };
      for (const [sourceSessionId, info] of tabSession.childSessions) {
        if (info.targetId === targetId)
          return { tabSession, targetInfo: info, sourceSessionId };
      }
    }
    return undefined;
  }

  private detachExplicitSessions(
    predicate: (session: ExplicitPageSession) => boolean,
  ): void {
    for (const [sessionId, session] of this.explicitPageSessions) {
      if (!predicate(session)) continue;
      this.explicitPageSessions.delete(sessionId);
      this.emit({
        sessionId: session.parentSessionId,
        method: 'Target.detachedFromTarget',
        params: { sessionId, targetId: session.targetInfo.targetId },
      });
    }
  }

  private emit(message: CdpMessage): void {
    this.sendToPlaywright?.(message);
  }
}

function targetInfo(value: unknown): TargetInfo {
  const info = record(value);
  if (
    typeof info.targetId !== 'string' ||
    typeof info.type !== 'string' ||
    typeof info.title !== 'string' ||
    typeof info.url !== 'string' ||
    (info.browserContextId !== undefined &&
      (typeof info.browserContextId !== 'string' ||
        info.browserContextId === ''))
  )
    throw new Error('Chrome extension returned invalid target information');
  // CDP omits this field for the default context; Playwright requires an id.
  return {
    ...info,
    browserContextId: info.browserContextId ?? 'qwen-default-context',
  } as TargetInfo;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}
