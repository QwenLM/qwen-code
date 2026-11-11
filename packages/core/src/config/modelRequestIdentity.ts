/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ModelProvider } from '../provider/modelProvider.js';

/**
 * Identity of the request's owner within core.
 *
 * Auth state, token renewal and endpoint election live in the product provider,
 * so Core only fingerprints the providers that serve the request.
 */
export function getModelRequestIdentity(
  accessMode: string,
  providers: readonly ModelProvider[] = [],
): string {
  return JSON.stringify([
    accessMode,
    providers.map((provider) => provider.providerId),
  ]);
}
