/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DesktopServerInfo } from '../../shared/desktopApi.js';

export interface DesktopHealth {
  ok: true;
  service: 'qwen-desktop';
  uptimeMs: number;
  timestamp: string;
}

export interface DesktopConnectionStatus {
  serverUrl: string;
  health: DesktopHealth;
}

export async function loadDesktopStatus(): Promise<DesktopConnectionStatus> {
  const serverInfo = await getServerInfo();
  const healthUrl = new URL('/health', serverInfo.url);
  const response = await fetch(healthUrl, {
    headers: {
      Authorization: `Bearer ${serverInfo.token}`,
    },
  });
  const payload = (await response.json()) as unknown;

  if (!response.ok || !isDesktopHealth(payload)) {
    throw new Error('Desktop service health check failed.');
  }

  return {
    serverUrl: serverInfo.url,
    health: payload,
  };
}

async function getServerInfo(): Promise<DesktopServerInfo> {
  if (!window.qwenDesktop) {
    throw new Error('Desktop preload API is unavailable.');
  }

  return window.qwenDesktop.getServerInfo();
}

function isDesktopHealth(value: unknown): value is DesktopHealth {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<DesktopHealth>;
  return (
    candidate.ok === true &&
    candidate.service === 'qwen-desktop' &&
    typeof candidate.uptimeMs === 'number' &&
    typeof candidate.timestamp === 'string'
  );
}
