/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { AuthType } from '../core/contentGenerator.js';
import { tryResolveModelProtocol } from '../models/modelRegistry.js';
import type {
  ModelConfig,
  ModelProvidersConfig,
  ProviderProtocolConfig,
} from '../models/types.js';
import { getModelsForProviderProtocol } from './provider-config.js';

function preservePlaceholders(
  value: unknown,
  resolved: unknown,
  original: unknown,
): unknown {
  if (typeof original === 'string' && value === resolved) return original;
  if (
    Array.isArray(value) &&
    Array.isArray(resolved) &&
    Array.isArray(original)
  ) {
    return value.map((entry, index) =>
      preservePlaceholders(entry, resolved[index], original[index]),
    );
  }
  if (
    value &&
    resolved &&
    original &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof resolved === 'object' &&
    !Array.isArray(resolved) &&
    typeof original === 'object' &&
    !Array.isArray(original)
  ) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        preservePlaceholders(
          entry,
          (resolved as Record<string, unknown>)[key],
          (original as Record<string, unknown>)[key],
        ),
      ]),
    );
  }
  return value;
}

export function preserveModelProviderPlaceholders(
  models: ModelConfig[],
  provider: string,
  resolvedProviders: ModelProvidersConfig,
  rawProviders: ModelProvidersConfig,
  mapping?: ProviderProtocolConfig,
): ModelConfig[] {
  const pairs = Object.entries(resolvedProviders).flatMap(
    ([providerId, entries]) => {
      if (!Array.isArray(entries)) return [];
      return entries.flatMap((entry, index) => {
        const resolved =
          provider === AuthType.USE_OPENAI
            ? getModelsForProviderProtocol(
                { [providerId]: [entry] },
                AuthType.USE_OPENAI,
                mapping,
              )[0]
            : providerId === provider
              ? entry
              : undefined;
        return resolved
          ? [
              {
                providerId,
                resolved,
                source: entry,
                raw: rawProviders[providerId]?.[index] ?? entry,
              },
            ]
          : [];
      });
    },
  );
  return models.map((model) => {
    const matches = pairs.filter(
      ({ resolved }) =>
        resolved.id === model.id &&
        resolved.baseUrl === model.baseUrl &&
        tryResolveModelProtocol(provider, resolved, mapping) ===
          tryResolveModelProtocol(provider, model, mapping),
    );
    // The registry uses the first bucket for duplicate identities. Only
    // duplicates inside that winning bucket make placeholder recovery ambiguous.
    const sourceMatches = matches.filter(
      (pair) => pair.providerId === matches[0]?.providerId,
    );
    if (
      sourceMatches.length > 1 &&
      sourceMatches.some(
        (pair) => JSON.stringify(pair.raw) !== JSON.stringify(pair.source),
      )
    ) {
      throw new Error(
        'Cannot preserve placeholders in an ambiguous model configuration. Remove duplicate model entries first.',
      );
    }
    const match = matches[0];
    return match
      ? (preservePlaceholders(model, match.resolved, match.raw) as ModelConfig)
      : model;
  });
}
