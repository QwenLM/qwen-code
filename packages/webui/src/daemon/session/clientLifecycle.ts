/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

const WEBUI_CLIENT_ID_KEY = 'qwen-code-webui-client-id';

export function getStableClientId(clientId: string | undefined): string {
  if (clientId) return clientId;
  if (typeof window === 'undefined') return createWebuiClientId();
  try {
    const existing = window.sessionStorage.getItem(WEBUI_CLIENT_ID_KEY);
    if (existing) return existing;
    const next = createWebuiClientId();
    window.sessionStorage.setItem(WEBUI_CLIENT_ID_KEY, next);
    return next;
  } catch {
    return createWebuiClientId();
  }
}

export async function detachDaemonClient(opts: {
  baseUrl: string;
  token?: string;
  sessionId: string;
  clientId?: string;
}): Promise<void> {
  if (!opts.clientId) return;
  const headers: Record<string, string> = {
    'X-Qwen-Client-Id': opts.clientId,
  };
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
  const url = `${stripTrailingSlashes(opts.baseUrl)}/session/${encodeURIComponent(
    opts.sessionId,
  )}/detach`;
  const res = await fetch(url, { method: 'POST', headers, keepalive: true });
  if (res.status === 204 || res.status === 404) return;
  throw new Error(`Detach client failed (${res.status})`);
}

function createWebuiClientId(): string {
  const random =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `webui_${random}`;
}

function stripTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url.charCodeAt(end - 1) === 0x2f /* / */) {
    end -= 1;
  }
  return end === url.length ? url : url.slice(0, end);
}
