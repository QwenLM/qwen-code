/**
 * Copyright (c) Microsoft Corporation.
 * Licensed under the Apache License, Version 2.0.
 *
 * Adapted from Playwright's browserModel.ts at revision
 * 350d24a344b07543fdc4014339a7871fd1c1b227.
 */

import type { BridgeEvent, ChromeBridge } from '../bridge/index.js';

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

  constructor(bridge: ChromeBridge) {
    this.bridge = bridge;
  }

  connect(send: (message: CdpMessage) => void): void {
    this.sendToPlaywright = send;
  }

  async registerTab(tabId: number): Promise<TargetInfo> {
    return (await this.attachTab(tabId)).targetInfo;
  }

  async unregisterTab(tabId: number): Promise<void> {
    this.detachTab(tabId);
  }

  async onBridgeEvent(event: BridgeEvent): Promise<void> {
    if (event.method === 'qwenBrowser.tabRemoved') {
      this.detachTab(event.tabId);
      return;
    }
    if (event.method === 'qwenBrowser.detached') {
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
      tabSession.childSessions.delete(event.sessionId);
      this.detachExplicitSessions(
        (session) =>
          session.tabSession === tabSession &&
          session.sourceSessionId === event.sessionId,
      );
      this.emit({
        sessionId: tabSession.sessionId,
        method: 'Target.detachedFromTarget',
        params: { sessionId: event.sessionId },
      });
      return;
    }
    const params = record(event.params);
    const childSessionId = stringOrUndefined(params.sessionId);
    if (event.method === 'Target.attachedToTarget' && childSessionId) {
      tabSession.childSessions.set(
        childSessionId,
        targetInfo(params.targetInfo),
      );
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
    this.explicitPageSessions.delete(sessionId);
  }

  async sendCommand(
    sessionId: string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const explicit = this.explicitPageSessions.get(sessionId);
    if (explicit !== undefined) {
      return await this.bridge.request('cdp.send', {
        tabId: explicit.tabSession.tabId,
        method,
        params,
        ...(explicit.sourceSessionId === undefined
          ? {}
          : { sessionId: explicit.sourceSessionId }),
      });
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
    return await this.bridge.request('cdp.send', {
      tabId: session.tabId,
      method,
      params,
      ...(childSessionId === undefined ? {} : { sessionId: childSessionId }),
    });
  }

  private async attachTab(tabId: number): Promise<TabSession> {
    const existing = this.tabSessions.get(tabId);
    if (existing !== undefined) return existing;
    await this.bridge.request('tabs.attach', { tabId });
    const response = record(
      await this.bridge.request('cdp.send', {
        tabId,
        method: 'Target.getTargetInfo',
        params: {},
      }),
    );
    const info = targetInfo(response.targetInfo);
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
    typeof info.url !== 'string'
  )
    throw new Error('Chrome extension returned invalid target information');
  return info as TargetInfo;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}
