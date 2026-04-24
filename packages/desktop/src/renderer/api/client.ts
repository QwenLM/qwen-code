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
  runtime: DesktopRuntime;
}

export interface DesktopRuntime {
  ok: true;
  desktop: {
    version: string;
    electronVersion: string | null;
    nodeVersion: string;
  };
  cli: {
    path: string | null;
    channel: 'Desktop';
    acpReady: false;
  };
  platform: {
    type: string;
    arch: string;
    release: string;
  };
  auth: {
    status: 'unknown';
    account: null;
  };
}

export async function loadDesktopStatus(): Promise<DesktopConnectionStatus> {
  const serverInfo = await getServerInfo();
  const [health, runtime] = await Promise.all([
    getJson(serverInfo, '/health', isDesktopHealth),
    getJson(serverInfo, '/api/runtime', isDesktopRuntime),
  ]);

  return {
    serverUrl: serverInfo.url,
    health,
    runtime,
  };
}

async function getJson<T>(
  serverInfo: DesktopServerInfo,
  path: string,
  isExpectedPayload: (value: unknown) => value is T,
): Promise<T> {
  const response = await fetch(new URL(path, serverInfo.url), {
    headers: {
      Authorization: `Bearer ${serverInfo.token}`,
    },
  });
  const payload = (await response.json()) as unknown;

  if (!response.ok || !isExpectedPayload(payload)) {
    throw new Error(`Desktop service request failed: ${path}`);
  }

  return payload;
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

function isDesktopRuntime(value: unknown): value is DesktopRuntime {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<DesktopRuntime>;
  return (
    candidate.ok === true &&
    isDesktopRuntimeDesktop(candidate.desktop) &&
    isDesktopRuntimeCli(candidate.cli) &&
    isDesktopRuntimePlatform(candidate.platform) &&
    candidate.auth?.status === 'unknown' &&
    candidate.auth.account === null
  );
}

function isDesktopRuntimeDesktop(
  value: DesktopRuntime['desktop'] | undefined,
): value is DesktopRuntime['desktop'] {
  return (
    !!value &&
    typeof value.version === 'string' &&
    (typeof value.electronVersion === 'string' ||
      value.electronVersion === null) &&
    typeof value.nodeVersion === 'string'
  );
}

function isDesktopRuntimeCli(
  value: DesktopRuntime['cli'] | undefined,
): value is DesktopRuntime['cli'] {
  return (
    !!value &&
    (typeof value.path === 'string' || value.path === null) &&
    value.channel === 'Desktop' &&
    value.acpReady === false
  );
}

function isDesktopRuntimePlatform(
  value: DesktopRuntime['platform'] | undefined,
): value is DesktopRuntime['platform'] {
  return (
    !!value &&
    typeof value.type === 'string' &&
    typeof value.arch === 'string' &&
    typeof value.release === 'string'
  );
}
