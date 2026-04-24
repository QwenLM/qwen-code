/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DesktopServerInfo } from '../shared/desktopApi.js';

export type { DesktopServerInfo };

export interface DesktopServer {
  info: DesktopServerInfo;
  close(): Promise<void>;
}

export interface DesktopServerOptions {
  token?: string;
  now?: () => Date;
}

export interface DesktopHealthResponse {
  ok: true;
  service: 'qwen-desktop';
  uptimeMs: number;
  timestamp: string;
}

export interface DesktopErrorResponse {
  ok: false;
  code: string;
  message: string;
}
