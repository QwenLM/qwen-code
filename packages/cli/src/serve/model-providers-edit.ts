/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { resolveProviderProtocol } from '@qwen-code/qwen-code-core';
import type {
  ModelProvidersConfig,
  ProviderProtocolConfig,
} from '@qwen-code/qwen-code-core';

export interface RemoveModelTarget {
  /** Resolved protocol/authType the model is grouped under (e.g. "openai"). */
  authType: string;
  /** The raw model id (ModelConfig.id / baseModelId). */
  modelId: string;
  /** Optional baseUrl to disambiguate same-id models across endpoints. */
  baseUrl?: string;
}

export interface RemoveModelResult {
  next: ModelProvidersConfig;
  removed: boolean;
}

/**
 * Return a copy of `modelProviders` with the model matching `target` removed.
 *
 * `modelProviders` is keyed by provider id; for built-in providers the key
 * equals the protocol/authType, and custom ids resolve to a protocol via
 * `providerProtocol`. We locate the model by resolving each key's protocol and
 * matching the model id (plus baseUrl when supplied, to disambiguate the same
 * id configured against different endpoints). Emptied provider keys are kept as
 * empty arrays (see `buildRemoval`).
 */
export function removeModelFromProviders(
  modelProviders: ModelProvidersConfig,
  providerProtocol: ProviderProtocolConfig | undefined,
  target: RemoveModelTarget,
): RemoveModelResult {
  // The caller's baseUrl comes from the providers status, which sanitizes
  // credential-bearing URLs — so prefer an exact id+baseUrl match but fall back
  // to an id-only match, which keeps deletion working when the sanitized baseUrl
  // no longer equals the stored one. The fallback takes the FIRST id match in
  // iteration order; if a provider has multiple models sharing an id and the
  // baseUrl matches none exactly, that first one is removed (an uncommon config,
  // and the exact-match branch above covers the normal case).
  let idOnly: { key: string; index: number } | undefined;
  for (const [key, models] of Object.entries(modelProviders)) {
    if (!Array.isArray(models)) continue;
    const protocol = resolveProviderProtocol(key, providerProtocol) ?? key;
    if (protocol !== target.authType) continue;
    for (let index = 0; index < models.length; index++) {
      if (models[index].id !== target.modelId) continue;
      if (
        target.baseUrl === undefined ||
        (models[index].baseUrl ?? undefined) === target.baseUrl
      ) {
        return buildRemoval(modelProviders, key, index);
      }
      if (!idOnly) idOnly = { key, index };
    }
  }
  if (idOnly) return buildRemoval(modelProviders, idOnly.key, idOnly.index);
  return { next: modelProviders, removed: false };
}

function buildRemoval(
  modelProviders: ModelProvidersConfig,
  key: string,
  index: number,
): RemoveModelResult {
  const nextModels = (modelProviders[key] ?? []).filter((_, i) => i !== index);
  const next: ModelProvidersConfig = { ...modelProviders };
  // Keep the (possibly empty) provider key rather than deleting it: the settings
  // writer merges the modelProviders object per key and only replaces arrays
  // wholesale, so dropping a key here would leave a zombie entry in the file
  // while an emptied array is written correctly. An empty provider contributes
  // no models and is hidden from the model list.
  next[key] = nextModels;
  return { next, removed: true };
}

/**
 * Whether the given model is the currently-selected active model, so callers
 * can clear `model.name` when deleting it (leaving a dangling selection would
 * make the runtime fall back to an unrelated model on the next turn).
 */
export function isActiveModelSelection(
  activeModelName: string | undefined,
  activeBaseUrl: string | undefined,
  target: RemoveModelTarget,
): boolean {
  if (!activeModelName || activeModelName !== target.modelId) return false;
  // No explicit active baseUrl → the selection isn't pinned to an endpoint, so
  // an id match is enough. When the active selection IS pinned to a baseUrl,
  // require the deletion to target that same baseUrl — otherwise an id-only
  // delete (which removes the first same-id variant, not necessarily the active
  // one) must not clear the active selection.
  if (!activeBaseUrl) return true;
  if (!target.baseUrl) return false;
  return activeBaseUrl === target.baseUrl;
}
