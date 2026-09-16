/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Keep the persisted key stable across the WebUI-to-Web-Shell migration.
const SESSION_CLIENT_ID_STORAGE_PREFIX = 'qwen-code-webui-client-id:session:';

export function getStableClientId(
  clientId: string | undefined,
  sessionId?: string,
): string {
  if (clientId) return clientId;
  if (typeof window === 'undefined') return createWebShellClientId();
  try {
    if (sessionId) {
      const existingSessionClientId = window.sessionStorage.getItem(
        sessionClientIdKey(sessionId),
      );
      if (existingSessionClientId) return existingSessionClientId;
    }
    return createWebShellClientId();
  } catch {
    return createWebShellClientId();
  }
}

/**
 * Read the client id persisted for `sessionId` without generating one. Returns
 * `undefined` when nothing is stored (SSR, private-mode quota failure, or a
 * session this client never attached). Callers use this to act on behalf of a
 * NON-current session, where `getStableClientId`'s generate-on-miss would mint
 * an unrelated id that is not attached to the target session.
 */
export function getPersistedClientId(sessionId: string): string | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    return (
      window.sessionStorage.getItem(sessionClientIdKey(sessionId)) ?? undefined
    );
  } catch {
    return undefined;
  }
}

export function persistStableClientId(
  clientId: string | undefined,
  sessionId?: string,
): void {
  if (!clientId || !sessionId || typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(sessionClientIdKey(sessionId), clientId);
  } catch {
    // Best-effort persistence only. Private-mode or quota failures should not
    // break an already attached daemon session.
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

function createWebShellClientId(): string {
  const random =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `webui_${random}`;
}

function sessionClientIdKey(sessionId: string): string {
  return `${SESSION_CLIENT_ID_STORAGE_PREFIX}${encodeURIComponent(sessionId)}`;
}

function stripTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url.charCodeAt(end - 1) === 0x2f /* / */) {
    end -= 1;
  }
  return end === url.length ? url : url.slice(0, end);
}
