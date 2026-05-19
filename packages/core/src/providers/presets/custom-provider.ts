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
 * `API_EXAMPLE_COM`. A 6-hex-char suffix derived from a SHA-256 of the raw
 * (protocol, baseUrl) pair disambiguates structurally distinct endpoints so
 * configuring one custom provider can't silently overwrite another's API
 * key. The suffix is short enough that a paste of the env var name into a
 * dashboard stays manageable, and collision probability at this size is
 * ~1 in 16M per pair — fine for an interactive setup flow.
 */
export function generateCustomEnvKey(
  protocol: AuthType,
  baseUrl: string,
): string {
  const normalize = (value: string) =>
    value
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '');

  // Strip trailing slashes before hashing so callers that differ only in
  // that (e.g. .../v1 vs .../v1/) still resolve to the same env-var bucket,
  // preserving the prior implementation's invariant.
  const canonicalBaseUrl = baseUrl.trim().replace(/\/+$/, '');
  const suffix = createHash('sha256')
    .update(`${protocol}\0${canonicalBaseUrl}`)
    .digest('hex')
    .slice(0, 6)
    .toUpperCase();

  return `${CUSTOM_API_KEY_ENV_PREFIX}${normalize(protocol)}_${normalize(baseUrl)}_${suffix}`;
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
  models: undefined,
  modelNamePrefix: '',
  showAdvancedConfig: true,
  uiGroup: 'custom',
};
