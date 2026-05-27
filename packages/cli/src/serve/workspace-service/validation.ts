/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared validation helpers for workspace sub-services.
 */

import type { WorkspaceRequestContext } from './types.js';

/**
 * Validate that the originator client id (if present) belongs to a
 * currently registered session. Throws when the id is set but unknown,
 * which prevents stale or forged client ids from mutating workspace
 * state.
 */
export function validateClientId(
  ctx: WorkspaceRequestContext,
  knownClientIds: () => ReadonlySet<string>,
): void {
  const clientId = ctx.originatorClientId;
  if (clientId === undefined) return;
  if (!knownClientIds().has(clientId)) {
    throw new Error(
      `Client id "${clientId}" is not registered for this workspace`,
    );
  }
}
