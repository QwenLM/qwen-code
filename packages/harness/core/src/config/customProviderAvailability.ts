/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from './config.js';

/**
 * Returns the first candidate that is configured as a Custom Provider model
 * but is not currently available in the registry (e.g. access denied or the
 * provider failed to load), or `undefined` when every candidate is fine.
 *
 * Centralizes the "configured-but-unavailable" predicate shared by the routing
 * strategy and the utility client, so the semantics can't drift between them. Call sites turn a non-undefined result into their own
 * domain error. Tolerates a partial/absent `config` for defensive call sites.
 */
export function findUnavailableConfiguredCustomProviderModel(
  config:
    | Pick<
        Config,
        'getCustomProviderRegistry' | 'isConfiguredCustomProviderModelKey'
      >
    | undefined,
  ...candidates: Array<string | undefined>
): string | undefined {
  const registry = config?.getCustomProviderRegistry?.();
  return candidates.find(
    (candidate) =>
      config?.isConfiguredCustomProviderModelKey?.(candidate) === true &&
      registry?.isCustomProviderModel(candidate) !== true,
  );
}
