/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('OUTBOUND_CORRELATION');

/**
 * Placeholders a user may write into a `customHeaders` value, e.g.
 *
 * ```json
 * "customHeaders": { "x-opencode-session": "${session_id}" }
 * ```
 *
 * `customHeaders` is already scoped to one model-provider entry whose
 * `baseUrl` the user chose, so a placeholder needs no host allowlist of
 * its own: "which hosts may receive this" is answered by the provider
 * the header is attached to, and "which providers need it" by which
 * entries carry the header at all.
 *
 * Deliberately a closed set. Each entry is a per-session identifier with
 * a reviewed privacy story; this is not a general environment- or
 * process-state interpolation facility, and it should not grow into one
 * without the same review.
 */
const PLACEHOLDERS: ReadonlyArray<{
  readonly token: string;
  readonly resolve: (config: Config) => string | undefined;
}> = [{ token: '${session_id}', resolve: (config) => config.getSessionId() }];

/** True when `value` asks for at least one runtime-resolved placeholder. */
export function hasDynamicPlaceholder(value: string): boolean {
  return PLACEHOLDERS.some(({ token }) => value.includes(token));
}

/**
 * Expands placeholders in one user-configured header value, or returns
 * `undefined` when the header must not be sent at all.
 *
 * Fail-closed in three ways, all of which drop the header rather than
 * putting a wrong value on the wire:
 *
 * - The `outboundCorrelation.allowDynamicHeaderValues` gate is off (the
 *   default). This is the consent decision: a static header is a string
 *   the user typed, while an expanded one carries live process state to
 *   a third party. It also means a preset or extension that ships a
 *   `customHeaders` entry cannot turn it into an identity header behind
 *   the user's back — provenance is lost once presets and user settings
 *   are merged, so the gate is what distinguishes them.
 * - A placeholder resolves to nothing (no session yet).
 * - `Config` cannot answer at all.
 *
 * A value with no placeholder is returned untouched, so this is a no-op
 * for every existing `customHeaders` entry.
 */
export function resolveDynamicHeaderValue(
  value: string,
  config: Config,
): string | undefined {
  if (!hasDynamicPlaceholder(value)) return value;
  try {
    if (!config.getOutboundAllowDynamicHeaderValues()) {
      debugLogger.warn(
        `Dropping a customHeaders value containing a runtime placeholder: ` +
          `outboundCorrelation.allowDynamicHeaderValues is not enabled.`,
      );
      return undefined;
    }
    let expanded = value;
    for (const { token, resolve } of PLACEHOLDERS) {
      if (!expanded.includes(token)) continue;
      const resolved = resolve(config);
      if (!resolved) return undefined;
      expanded = expanded.split(token).join(resolved);
    }
    return expanded;
  } catch (error) {
    debugLogger.warn(
      `Unable to expand a customHeaders placeholder: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return undefined;
  }
}

/**
 * Rewrites placeholder-bearing entries of an outgoing `Headers` object in
 * place. Used by the shared fetch wrapper, which is the one point every
 * OpenAI-compatible and Anthropic request passes through per request —
 * the SDK clients bake `customHeaders` in at construction, so this is
 * where a value that must change per request gets its chance.
 */
export function applyDynamicHeaderValues(
  headers: Headers,
  config: Config,
): void {
  const pending: Array<[string, string]> = [];
  headers.forEach((value, key) => {
    if (hasDynamicPlaceholder(value)) pending.push([key, value]);
  });
  for (const [key, value] of pending) {
    const resolved = resolveDynamicHeaderValue(value, config);
    if (resolved === undefined) {
      headers.delete(key);
    } else {
      headers.set(key, resolved);
    }
  }
}

/**
 * The subset of `customHeaders` that carries placeholders, expanded for
 * this request. Used by the Gemini path, whose `customHeaders` live in
 * the SDK client options rather than passing through a fetch wrapper;
 * re-emitting just this subset at request level overrides the stale
 * client-level copy.
 */
export function expandDynamicHeaders(
  customHeaders: Record<string, string> | undefined,
  config: Config,
): Record<string, string> {
  if (!customHeaders) return {};
  const expanded: Record<string, string> = {};
  for (const [key, value] of Object.entries(customHeaders)) {
    if (!hasDynamicPlaceholder(value)) continue;
    const resolved = resolveDynamicHeaderValue(value, config);
    if (resolved !== undefined) expanded[key] = resolved;
  }
  return expanded;
}
