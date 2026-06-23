/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { Protocol } from '../../core/contentGenerator.js';
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
  protocol: Protocol,
  baseUrl: string,
): string {
  // Strip trailing slashes before hashing so callers that differ only in
  // that (e.g. .../v1 vs .../v1/) still resolve to the same env-var bucket,
  // preserving the prior implementation's invariant.
  const canonicalBaseUrl = stripTrailingSlashes(baseUrl.trim());
  const suffix = createHash('sha256')
    .update(`${protocol}\0${canonicalBaseUrl}`)
    .digest('hex')
    .slice(0, 12)
    .toUpperCase();

  return `${CUSTOM_API_KEY_ENV_PREFIX}${normalizeEnvSegment(
    protocol,
  )}_${normalizeEnvSegment(baseUrl)}_${suffix}`;
}

export const customProvider: ProviderConfig = {
  id: 'custom-openai-compatible',
  label: 'Custom Provider',
  description:
    'Manually connect a local server, proxy, or unsupported provider',
  protocol: Protocol.OPENAI,
  protocolOptions: [Protocol.OPENAI, Protocol.ANTHROPIC, Protocol.GEMINI],
  baseUrl: undefined,
  envKey: generateCustomEnvKey,
  models: undefined,
  modelNamePrefix: '',
  showAdvancedConfig: true,
  // Detect existing custom entries by our env-key namespace for UI/ACP flows,
  // but merge installs by id+baseUrl so /auth can add another custom model
  // without deleting models from other endpoints or different models on the
  // same endpoint.
  ownsModel: (model) =>
    typeof model.envKey === 'string' &&
    model.envKey.startsWith(CUSTOM_API_KEY_ENV_PREFIX),
  mergeModelsByIdentity: true,
  uiGroup: 'custom',
};
