/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { AuthType } from '../../core/contentGenerator.js';
import type { ProviderConfig } from '../types.js';

export const CUSTOM_API_KEY_ENV_PREFIX = 'QWEN_CUSTOM_API_KEY_';

/**
 * Derive the env-var key that holds the API token for a custom provider.
 *
 * The readable part (`PROTOCOL_NORMALIZED_URL`) is kept for human eyeballing
 * of settings.json, but URL normalization is lossy — `api.example.com`,
 * `api-example.com`, and `api_example.com` all collapse to
 * `API_EXAMPLE_COM`. A 12-hex-char (48-bit) suffix derived from a SHA-256
 * of the canonicalized (protocol, baseUrl) pair disambiguates structurally
 * distinct endpoints so configuring one custom provider can't silently
 * overwrite another's API key. 48 bits gives ~280 trillion values — well
 * past the point where an attacker controlling a user-typed URL could
 * realistically collide an existing entry to redirect an API key write,
 * while still keeping the env var name pasteable into a dashboard.
 *
 * Migration note: this suffix changed from 6 → 12 chars in a recent commit.
 * Old 6-char keys persist in settings.json (and ~/.qwen/env-equivalent
 * stores) until either the user reconnects under the same URL (which writes
 * the new 12-char key but leaves the old one as orphan disk state — harmless,
 * never read) or runs the "clear auth" flow. The old key is never read by
 * applyProviderInstallPlan because the new model provider entries point at
 * the new key.
 */
/**
 * Normalize a string to a `[A-Z0-9_]+` env-var-safe segment without using any
 * `+`-quantified regex. CodeQL flags polynomial regex on user-controlled
 * input even though V8 handles these patterns linearly; a single-pass
 * character scan side-steps both the warning and the (theoretical) worst
 * case. Collapses runs of non-alphanumeric characters to a single `_` and
 * strips leading/trailing underscores.
 */
function normalizeEnvSegment(value: string): string {
  const upper = value.trim().toUpperCase();
  let result = '';
  let prevWasUnderscore = false;
  for (let i = 0; i < upper.length; i++) {
    const code = upper.charCodeAt(i);
    const isAlphaNum =
      (code >= 65 /* A */ && code <= 90) /* Z */ ||
      (code >= 48 /* 0 */ && code <= 57); /* 9 */
    if (isAlphaNum) {
      result += upper[i];
      prevWasUnderscore = false;
    } else if (!prevWasUnderscore) {
      result += '_';
      prevWasUnderscore = true;
    }
  }
  // Strip leading/trailing underscores.
  let start = 0;
  let end = result.length;
  while (start < end && result.charCodeAt(start) === 95 /* _ */) start++;
  while (end > start && result.charCodeAt(end - 1) === 95 /* _ */) end--;
  return result.slice(start, end);
}

/**
 * Strip trailing `/` characters from a URL without a `+`-quantified regex
 * (CodeQL flags `/\/+$/` as polynomial on uncontrolled input). Linear.
 */
function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47 /* / */) end--;
  return value.slice(0, end);
}

export function generateCustomEnvKey(
  protocol: AuthType,
  baseUrl: string,
): string {
  return `${customEnvKeyReadable(protocol, baseUrl)}_${customEnvKeyHash(
    protocol,
    baseUrl,
  ).slice(0, 12)}`;
}

/**
 * The human-readable `PREFIX_PROTOCOL_URL` part of the custom env key. Shared
 * by every shape the key generation went through (no suffix → 6-hex suffix →
 * 12-hex suffix), so it attributes historical keys to their endpoint.
 */
function customEnvKeyReadable(protocol: AuthType, baseUrl: string): string {
  // Strip trailing slashes so callers that differ only in that
  // (e.g. .../v1 vs .../v1/) still resolve to the same env-var bucket,
  // preserving the prior implementation's invariant.
  const canonicalBaseUrl = stripTrailingSlashes(baseUrl.trim());
  return `${CUSTOM_API_KEY_ENV_PREFIX}${normalizeEnvSegment(
    protocol,
  )}_${normalizeEnvSegment(canonicalBaseUrl)}`;
}

/** The full uppercase SHA-256 hex of the canonical (protocol, baseUrl) pair. */
function customEnvKeyHash(protocol: AuthType, baseUrl: string): string {
  const canonicalBaseUrl = stripTrailingSlashes(baseUrl.trim());
  return createHash('sha256')
    .update(`${protocol}\0${canonicalBaseUrl}`)
    .digest('hex')
    .toUpperCase();
}

/**
 * Recognizes the env-key shapes this provider generated for the endpoint
 * (`protocol`, `baseUrl`) that can be attributed UNAMBIGUOUSLY: the current
 * 12-hex-suffix shape and the earlier 6-hex-suffix shape (same hash, shorter
 * slice — old keys persist in settings until reconnect or clear-auth). Both
 * carry (a prefix of) the SHA-256 of the canonical (protocol, baseUrl) pair,
 * which distinguishes structurally distinct endpoints whose URLs normalize to
 * the same readable segment (`api.example.com` vs `api-example.com`).
 *
 * The original suffix-less `PREFIX_PROTOCOL_URL` shape is deliberately NOT
 * recognized (R40-3): the readable segment is lossy, so a suffix-less key
 * cannot tell its endpoint apart from a colliding one — connecting either
 * endpoint would "own" it and delete/rewrite the entry for the other.
 * Attribution fails closed instead. This is safe: commit-level archaeology
 * (#3864's predecessors included) shows every released flow that wrote a
 * prefixed env key stamped `baseUrl` on the entry in the same write, so a
 * suffix-less key only ever appears on a stamped entry — which the baseUrl
 * clause of buildInstallPlan's ownsModel attributes without any shape help.
 * A suffix-less key on a baseUrl-less entry is a hand-written artifact and
 * survives every connect, like any key that names no endpoint (R39-3
 * boundary).
 */
function ownsCustomEnvKeyShape(
  envKey: string,
  protocol: AuthType,
  baseUrl: string,
): boolean {
  const readable = customEnvKeyReadable(protocol, baseUrl);
  const hash = customEnvKeyHash(protocol, baseUrl);
  return (
    envKey === `${readable}_${hash.slice(0, 6)}` || // 6-hex suffix era
    envKey === `${readable}_${hash.slice(0, 12)}` // current (generateCustomEnvKey)
  );
}

/**
 * A stored key names SOME endpoint of this provider under `protocol` when it
 * carries the `PREFIX_PROTOCOL_` part followed by URL content. The
 * prefix-only `QWEN_CUSTOM_API_KEY_<PROTOCOL>` shape (and anything shorter)
 * names no endpoint — it is a floating hand-written key.
 */
function customEnvKeyNamesAnEndpoint(
  envKey: string,
  protocol: AuthType,
): boolean {
  return envKey.startsWith(
    `${CUSTOM_API_KEY_ENV_PREFIX}${normalizeEnvSegment(protocol)}_`,
  );
}

/**
 * The original suffix-less `PREFIX_PROTOCOL_URL` key shape (#3864 era).
 * Exported for test fixtures; NOT recognized by ownsCustomEnvKeyShape — see
 * the fail-closed note there (R40-3).
 */
export function legacyCustomEnvKey(
  protocol: AuthType,
  baseUrl: string,
): string {
  return customEnvKeyReadable(protocol, baseUrl);
}

/** The 6-hex-suffix key shape that preceded the current 12-hex one. */
export function legacyCustomEnvKey6Hex(
  protocol: AuthType,
  baseUrl: string,
): string {
  return `${customEnvKeyReadable(protocol, baseUrl)}_${customEnvKeyHash(
    protocol,
    baseUrl,
  ).slice(0, 6)}`;
}

export const customProvider: ProviderConfig = {
  id: 'custom-openai-compatible',
  label: 'Custom Provider',
  description:
    'Manually connect a local server, proxy, or unsupported provider',
  protocol: AuthType.USE_OPENAI,
  protocolOptions: [
    AuthType.USE_OPENAI,
    AuthType.USE_ANTHROPIC,
    AuthType.USE_GEMINI,
  ],
  baseUrl: undefined,
  envKey: generateCustomEnvKey,
  ownsEnvKeyShape: ownsCustomEnvKeyShape,
  envKeyNamesAnEndpoint: customEnvKeyNamesAnEndpoint,
  models: undefined,
  modelNamePrefix: '',
  showAdvancedConfig: true,
  // Detect existing custom entries by our env-key namespace for UI/ACP flows,
  // while install plans scope replacement to the selected endpoint. The
  // submitted modelIds are the complete list for that endpoint, so omitted
  // entries are removed without deleting models from sibling endpoints.
  ownsModel: (model) =>
    typeof model.envKey === 'string' &&
    model.envKey.startsWith(CUSTOM_API_KEY_ENV_PREFIX),
  mergeModelsByIdentity: true,
  uiGroup: 'custom',
};
