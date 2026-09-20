/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { persistDaemonToken } from './daemon';

export async function exchangePairingCode(
  baseUrl: string,
): Promise<{ token?: string; failed?: boolean } | undefined> {
  const url = new URL(window.location.href);
  const fragment = new URLSearchParams(url.hash.slice(1));
  const code = fragment.get('pairing');
  if (code === null) return undefined;
  fragment.delete('pairing');
  url.hash = fragment.toString();
  window.history.replaceState(null, '', url);
  if (baseUrl !== window.location.origin) return { failed: true };
  try {
    const response = await fetch(`${baseUrl}/web-shell/pairing/exchange`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${code}` },
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return { failed: true };
    const payload = (await response.json()) as { token?: unknown };
    if (typeof payload.token !== 'string' || !payload.token)
      return { failed: true };
    persistDaemonToken(payload.token, baseUrl);
    return { token: payload.token };
  } catch {
    return { failed: true };
  }
}
