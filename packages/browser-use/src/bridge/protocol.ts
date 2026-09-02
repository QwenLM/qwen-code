/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { join } from 'node:path';

export const CHROME_BRIDGE_PROTOCOL_VERSION = 4;
export const CHROME_NATIVE_HOST_NAME = 'com.qwen.browser';
export const CHROME_EXTENSION_ID = 'idkijaaipeeinemigojbjkmfmabokbdk';
export const MAX_BRIDGE_FRAME_BYTES = 16 * 1024 * 1024;

export function defaultChromeBridgeSocketPath(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const configured = environment.QWEN_BROWSER_USE_SOCKET_PATH?.trim();
  if (configured) return configured;
  if (process.platform === 'win32') {
    const identity =
      environment.USERNAME?.replace(/[^a-zA-Z0-9_.-]/g, '_') || 'default';
    return `\\\\.\\pipe\\qwen-browser-use-${identity}`;
  }
  const uid =
    typeof process.getuid === 'function' ? process.getuid() : 'default';
  return join('/tmp', `qwen-browser-use-${uid}.sock`);
}

export interface BridgeHello {
  type: 'hello';
  protocolVersion: number;
  extensionId: string;
}

export interface BridgeRequest {
  type: 'request';
  id: string;
  method: string;
  params: Record<string, unknown>;
}

export interface BridgeResponse {
  type: 'response';
  id: string;
  ok: boolean;
  result?: unknown;
  error?: { code?: string; message?: string };
}

/**
 * Pushed by the extension without a request: CDP events for an attached tab
 * (method/params as Chrome emits them) plus extension lifecycle notices
 * (`qwenBrowser.detached`, `qwenBrowser.tabRemoved`).
 */
export interface BridgeEvent {
  type: 'event';
  tabId: number;
  method: string;
  params: unknown;
  /** Present for events from a child target session (out-of-process iframe). */
  sessionId?: string;
}

export type BridgeMessage =
  | BridgeHello
  | BridgeRequest
  | BridgeResponse
  | BridgeEvent;
