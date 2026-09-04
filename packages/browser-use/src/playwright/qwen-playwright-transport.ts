/**
 * Copyright (c) Microsoft Corporation.
 * Licensed under the Apache License, Version 2.0.
 *
 * Adapted from Playwright's cdpRelayV2.ts at revision
 * 350d24a344b07543fdc4014339a7871fd1c1b227.
 */

import { runInThisContext } from 'node:vm';

import type { ConnectOverCDPTransport } from 'playwright-core';

import type { ChromeBridge } from '../bridge/index.js';
import { BrowserModel, type CdpMessage } from './browser-model.js';

interface CdpCommand {
  id: number;
  sessionId?: string;
  method: string;
  params?: Record<string, unknown>;
}

export class QwenPlaywrightTransport implements ConnectOverCDPTransport {
  onmessage: ((message: object) => void) | undefined;
  onclose: ((reason?: string) => void) | undefined;

  private readonly model: BrowserModel;
  private readonly removeEventListener: () => void;
  private readonly removeConnectionListener: () => void;
  private closed = false;

  constructor(bridge: ChromeBridge) {
    this.model = new BrowserModel(bridge);
    this.model.connect((message) => this.emit(message));
    this.removeEventListener = bridge.onEvent((event) => {
      void this.model.onBridgeEvent(event).catch((error: unknown) => {
        this.closeWithReason(
          error instanceof Error
            ? error.message
            : 'Chrome target attachment failed',
        );
      });
    });
    this.removeConnectionListener = bridge.onConnectionChange((connected) => {
      if (!connected) this.closeWithReason('Chrome extension disconnected');
    });
  }

  open(): void {}

  send(message: object): void {
    if (this.closed) return;
    let request: CdpCommand;
    try {
      request = command(message);
    } catch (error) {
      this.closeWithReason(
        error instanceof Error ? error.message : 'Invalid CDP command',
      );
      return;
    }
    const response = {
      id: request.id,
      ...(request.sessionId === undefined
        ? {}
        : { sessionId: request.sessionId }),
    };
    void this.handle(request).then(
      (result) => this.emit({ ...response, result }),
      (error: unknown) =>
        this.emit({
          ...response,
          error: {
            message:
              error instanceof Error
                ? error.message
                : 'Chrome extension operation failed',
          },
        }),
    );
  }

  close(): void {
    this.closeWithReason('Browser Use session closed');
  }

  async registerTab(tabId: number): Promise<string> {
    const info = await this.model.registerTab(tabId);
    return info.targetId;
  }

  async unregisterTab(tabId: number): Promise<void> {
    await this.model.unregisterTab(tabId);
  }

  providerTabId(targetId: string): number | undefined {
    return this.model.providerTabId(targetId);
  }

  private async handle(message: CdpCommand): Promise<unknown> {
    const params = message.params ?? {};
    switch (message.method) {
      case 'Browser.getVersion':
        return {
          protocolVersion: '1.3',
          product: 'Chrome/Extension-Bridge',
          userAgent: 'Qwen-Browser-Use/1.0',
          jsVersion: '',
        };
      case 'Browser.setDownloadBehavior':
        return {};
      case 'Target.attachToBrowserTarget':
        if (message.sessionId !== undefined)
          throw new Error('Target.attachToBrowserTarget requires root session');
        return this.model.attachToBrowserTarget();
      case 'Target.attachToTarget': {
        const parentSessionId = requiredSessionId(message);
        if (this.model.isBrowserSession(parentSessionId))
          return this.model.attachToTarget(
            parentSessionId,
            string(params.targetId, 'targetId'),
          );
        return await this.model.sendCommand(
          parentSessionId,
          message.method,
          params,
        );
      }
      case 'Target.detachFromTarget': {
        const parentSessionId = requiredSessionId(message);
        if (!this.model.isBrowserSession(parentSessionId))
          return await this.model.sendCommand(
            parentSessionId,
            message.method,
            params,
          );
        this.model.detachFromTarget(
          parentSessionId,
          string(params.sessionId, 'sessionId'),
        );
        return {};
      }
      case 'Target.setAutoAttach':
        if (message.sessionId !== undefined)
          return await this.model.sendCommand(
            message.sessionId,
            message.method,
            params,
          );
        return {};
      case 'Target.getTargetInfo':
        return { targetInfo: this.model.getTargetInfo(message.sessionId) };
      default:
        if (message.sessionId === undefined)
          throw new Error(
            `Unsupported browser-level CDP command: ${message.method}`,
          );
        return await this.model.sendCommand(
          message.sessionId,
          message.method,
          params,
        );
    }
  }

  private emit(message: CdpMessage): void {
    if (!this.closed) this.onmessage?.(message);
  }

  private closeWithReason(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.removeEventListener();
    this.removeConnectionListener();
    this.onclose?.(reason);
  }
}

export function playwrightTransportAdapter(
  transport: ConnectOverCDPTransport,
): ConnectOverCDPTransport {
  // Playwright validates custom transports with its host-realm Object. The SDK
  // itself runs in the Node REPL VM, so give Playwright a host-realm facade.
  const adapter = runInThisContext('({})') as ConnectOverCDPTransport;
  Object.defineProperties(adapter, {
    open: { value: () => transport.open?.() },
    send: { value: (message: object) => transport.send(message) },
    close: { value: () => transport.close() },
    onmessage: {
      get: () => transport.onmessage,
      set: (listener: ((message: object) => void) | undefined) => {
        transport.onmessage = listener;
      },
    },
    onclose: {
      get: () => transport.onclose,
      set: (listener: ((reason?: string) => void) | undefined) => {
        transport.onclose = listener;
      },
    },
  });
  return adapter;
}

function command(value: object): CdpCommand {
  const message = value as Partial<CdpCommand>;
  if (typeof message.id !== 'number' || typeof message.method !== 'string')
    throw new Error('Playwright sent an invalid CDP command');
  return message as CdpCommand;
}

function requiredSessionId(message: CdpCommand): string {
  if (message.sessionId === undefined)
    throw new Error(`${message.method} requires a parent session`);
  return message.sessionId;
}

function string(value: unknown, name: string): string {
  if (typeof value !== 'string' || value === '')
    throw new Error(`Missing CDP ${name}`);
  return value;
}
