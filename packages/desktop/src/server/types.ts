/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DesktopServerInfo } from '../shared/desktopApi.js';
import type { AcpSessionClient } from './services/sessionService.js';

export type { DesktopServerInfo };

export interface DesktopServer {
  info: DesktopServerInfo;
  close(): Promise<void>;
}

export interface DesktopServerOptions {
  token?: string;
  now?: () => Date;
  acpClient?: AcpSessionClient;
  permissionRequestTimeoutMs?: number;
  settingsPath?: string;
  projectStorePath?: string;
}

export interface DesktopHealthResponse {
  ok: true;
  service: 'qwen-desktop';
  uptimeMs: number;
  timestamp: string;
}

export interface DesktopRuntimeResponse {
  ok: true;
  desktop: {
    version: string;
    electronVersion: string | null;
    nodeVersion: string;
  };
  cli: {
    path: string | null;
    channel: 'Desktop';
    acpReady: boolean;
  };
  platform: {
    type: NodeJS.Platform;
    arch: string;
    release: string;
  };
  auth: {
    status: 'unknown' | 'authenticated';
    account: {
      authType: string | null;
      model: string | null;
      baseUrl: string | null;
      apiKeyEnvKey: string | null;
    } | null;
  };
}

export interface DesktopErrorResponse {
  ok: false;
  code: string;
  message: string;
}

export type DesktopJsonResponse =
  | DesktopHealthResponse
  | DesktopRuntimeResponse
  | DesktopErrorResponse
  | (Record<string, unknown> & { ok: true });
