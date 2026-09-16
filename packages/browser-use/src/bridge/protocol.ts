/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { statSync } from 'node:fs';
import { posix } from 'node:path';

export const CHROME_BRIDGE_PROTOCOL_VERSION = 1;
export const CHROME_NATIVE_HOST_NAME = 'com.qwen.browser';
export const CHROME_EXTENSION_ID = 'idkijaaipeeinemigojbjkmfmabokbdk';
export const MAX_BRIDGE_FRAME_BYTES = 16 * 1024 * 1024;

// Operation deadlines (core/schemas.ts timeoutMs) may reach 120s, and every
// Playwright CDP command rides one bridge request: the request must outlive
// the operation's own timeout so the caller's deadline reports first.
export const CDP_REQUEST_TIMEOUT_MS = 130_000;

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
  // The win32 branch returned above; keep the remaining joins POSIX so the
  // derived path is a pure function of uid and platform on every host.
  return posix.join(
    defaultChromeBridgeSocketDirectory(uid),
    `qwen-browser-use-${uid}.sock`,
  );
}

interface DirectoryStat {
  isDirectory(): boolean;
  uid: number;
  mode: number;
}

// The world-writable temp root lets any local user squat a predictable
// socket name (or its recovery lock) and deny the bridge permanently.
// Prefer a per-user directory when the platform offers one; otherwise fall
// back to a per-user directory directly under the sticky temp root, which
// the bridge server creates 0700 and verifies before binding. A shared
// intermediate directory would belong to whichever user created it first,
// so the fallback never inserts one. The choice must stay a pure
// function of uid and platform — never of $TMPDIR/$XDG_RUNTIME_DIR — so the
// CLI and the Chrome-launched native host derive the same path without
// sharing an environment.
export function defaultChromeBridgeSocketDirectory(
  uid: number | 'default',
  platform: NodeJS.Platform = process.platform,
  stat: (path: string) => DirectoryStat | undefined = statDirectory,
): string {
  if (platform !== 'win32' && typeof uid === 'number') {
    const runtimeDir = `/run/user/${uid}`;
    const info = stat(runtimeDir);
    if (
      info !== undefined &&
      info.isDirectory() &&
      info.uid === uid &&
      (info.mode & 0o077) === 0
    )
      return runtimeDir;
  }
  const base = platform === 'darwin' ? '/private/tmp' : '/tmp';
  return posix.join(base, `qwen-browser-use-${uid}`);
}

function statDirectory(path: string): DirectoryStat | undefined {
  try {
    return statSync(path);
  } catch {
    return undefined;
  }
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
