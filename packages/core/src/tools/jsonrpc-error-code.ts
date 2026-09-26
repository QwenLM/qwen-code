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
 * 2. the JSON-RPC response body the legacy-era HTTP transport embeds —
 *    `error.data.text` (SdkHttpError's `{status, statusText, text}` bag),
 *    then `error.message`.
 *
 * The body is parsed with `JSON.parse`, not scanned with a regex: the
 * first `{` through the last `}` is taken as the payload (the legacy-era
 * wrapper prefixes prose such as `Error POSTing to endpoint: …`), then
 * `.error.code` — the spec location — is read, falling back to a
 * top-level `.code` for bare error objects. A payload that does not
 * parse (truncated frame, prose containing braces, two objects) yields
 * `undefined` rather than a guessed number; callers decide what an
 * unknown code means for their context. No code is ever inferred from
 * free text.
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
    const code = parseJsonRpcBody(candidate);
    if (code !== undefined) return code;
  }
  return undefined;
}

/**
 * Read a JSON-RPC error code out of a body that may carry a non-JSON
 * prefix/suffix (the legacy-era transport embeds the response text in an
 * error message). Strict parse — no regex over remote content.
 */
function parseJsonRpcBody(text: string): number | undefined {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
  const body = parsed as {
    error?: { code?: unknown };
    code?: unknown;
  } | null;
  const spec = body?.error?.code;
  if (typeof spec === 'number' && Number.isInteger(spec)) return spec;
  const top = body?.code;
  if (typeof top === 'number' && Number.isInteger(top)) return top;
  return undefined;
}
