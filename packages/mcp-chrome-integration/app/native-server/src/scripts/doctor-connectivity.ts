/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * doctor-connectivity.ts
 *
 * Connectivity check utilities for the doctor diagnostic script.
 */

type FetchFn = typeof globalThis.fetch;

/**
 * Resolve the fetch function available in the environment.
 */
export function resolveFetch(): FetchFn | null {
  if (typeof globalThis.fetch === 'function') {
    return globalThis.fetch.bind(globalThis) as FetchFn;
  }
  return null;
}

/**
 * Check connectivity to a URL.
 */
export async function checkConnectivity(
  url: string,
  timeoutMs: number,
): Promise<{ ok: boolean; status?: number; error?: string }> {
  const fetchFn = resolveFetch();
  if (!fetchFn) {
    return {
      ok: false,
      error: 'fetch is not available (requires Node.js >=18 or node-fetch)',
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  // Prevent timeout from keeping the process alive
  if (typeof timeout.unref === 'function') {
    timeout.unref();
  }

  try {
    const res = await fetchFn(url, {
      method: 'GET',
      signal: controller.signal,
    });
    return { ok: res.ok, status: res.status };
  } catch (e: unknown) {
    const errMessage = e instanceof Error ? e.message : String(e);
    const errName = e instanceof Error ? e.name : '';
    if (
      errName === 'AbortError' ||
      errMessage.toLowerCase().includes('abort')
    ) {
      return { ok: false, error: `Timeout after ${timeoutMs}ms` };
    }
    return { ok: false, error: errMessage };
  } finally {
    clearTimeout(timeout);
  }
}
