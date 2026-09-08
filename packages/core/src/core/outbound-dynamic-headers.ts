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

// Normalize equivalent runtime session spellings before applying the consent
// gate so settings interpolation cannot turn one into an unguarded static value.
const SESSION_ID_PLACEHOLDER_PATTERN =
  /\$(?:session_id|QWEN_CODE_SESSION_ID)(?!\w)|\$\{(?:session_id|QWEN_CODE_SESSION_ID)\}/gi;

/**
 * Reports a configured placeholder that the gate is currently refusing,
 * once per distinct header set, on the console.
 *
 * The issue this feature answers (#10995) treats writing the placeholder
 * into a provider entry as the opt-in, so a user following the docs can
 * reasonably arrive here with the gate still off. Their symptom would
 * otherwise be a gateway rejecting every request with nothing to explain
 * it — the failure has to name the switch to flip, and a debug log that
 * is normally off does not count.
 *
 * Never throws: it is called while building a provider client, and a
 * partial `Config` must not be able to break client construction.
 */
const warnedGateOff = new Set<string>();
export function warnIfDynamicHeadersDisabled(
  customHeaders: Record<string, string> | undefined,
  config: Config,
): void {
  try {
    const names = Object.entries(customHeaders ?? {})
      .filter(
        ([, value]) =>
          typeof value === 'string' && hasDynamicPlaceholder(value),
      )
      .map(([name]) => name);
    if (names.length === 0) return;
    if (config.getOutboundAllowDynamicHeaderValues()) return;
    const key = names.slice().sort().join(',');
    if (warnedGateOff.has(key)) return;
    warnedGateOff.add(key);
    // eslint-disable-next-line no-console -- operator-facing misconfiguration breadcrumb; the alternative symptom is a gateway rejecting every request
    console.warn(
      `customHeaders ${names.join(', ')} contain a runtime placeholder, but ` +
        `outboundCorrelation.allowDynamicHeaderValues is not enabled — the ` +
        `header(s) will not be sent. Set it to true in settings.json to ` +
        `allow the value to be filled in per request.`,
    );
  } catch {
    // A Config that cannot answer is not worth failing client construction.
  }
}

/** True when `value` asks for at least one runtime-resolved placeholder. */
export function hasDynamicPlaceholder(value: string): boolean {
  return value.search(SESSION_ID_PLACEHOLDER_PATTERN) !== -1;
}

/**
 * Expands placeholders in one user-configured header value, or returns
 * `undefined` when the header must not be sent at all.
 *
 * Fail-closed in three ways, all of which drop the header rather than
 * putting a wrong value on the wire:
 *
 * - The `outboundCorrelation.allowDynamicHeaderValues` gate is off (the
 *   default). The gate controls whether `${session_id}` may be expanded
 *   from live process state; it cannot recover a header's provenance after
 *   settings are merged.
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
  if (typeof value !== 'string') return undefined;
  if (!hasDynamicPlaceholder(value)) return value;
  try {
    if (!config.getOutboundAllowDynamicHeaderValues()) {
      debugLogger.warn(
        `Dropping a customHeaders value containing a runtime placeholder: ` +
          `outboundCorrelation.allowDynamicHeaderValues is not enabled.`,
      );
      return undefined;
    }
    let expanded = value.replace(
      SESSION_ID_PLACEHOLDER_PATTERN,
      '${session_id}',
    );
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
    if (typeof value !== 'string' || !hasDynamicPlaceholder(value)) continue;
    const resolved = resolveDynamicHeaderValue(value, config);
    if (resolved !== undefined) expanded[key] = resolved;
  }
  return expanded;
}
