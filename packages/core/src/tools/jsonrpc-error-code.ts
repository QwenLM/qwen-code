/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Extract the JSON-RPC error code from a transport-shaped error, if any.
 *
 * Probes in order:
 * 1. a structured numeric `error.code` (McpError / SDK code path);
 * 2. the JSON-RPC error body the legacy-era HTTP transport embeds —
 *    `error.data.text`, then `error.message`.
 *
 * The body probe matches `"code": <integer>` anywhere in the string, so
 * member order and nested objects before `code` do not matter, and it
 * never infers a code from prose: only a literal JSON numeric member
 * counts. A body cut mid-number yields a short code that simply will not
 * equal the caller's sentinel.
 *
 * This is the single extraction site for `isTransientNetworkError`,
 * `isMethodNotFound`, and the onerror tolerance guards, so a future
 * change in how the transport surfaces the code is applied everywhere
 * at once.
 */
export function getJsonRpcErrorCode(error: unknown): number | undefined {
  const direct = (error as { code?: unknown } | null)?.code;
  if (typeof direct === 'number' && Number.isInteger(direct)) return direct;
  const bag = error as {
    data?: { text?: unknown };
    message?: unknown;
  } | null;
  const candidates = [
    bag?.data?.text,
    error instanceof Error ? error.message : undefined,
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const match = /"code"\s*:\s*(-?\d+)/.exec(candidate);
    if (match) return Number(match[1]);
  }
  return undefined;
}
