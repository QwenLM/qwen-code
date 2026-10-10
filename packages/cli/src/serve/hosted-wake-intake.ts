/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  ManagedSessionEvent,
  ManagedSessionJsonValue,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';

// H3 of #12827: which accepted inputs are still owed a consumer. An input
// is consumed exactly when some turn settles under its same turnId — the
// pending set is therefore derivable from the journal alone, any number of
// restarts later. See
// docs/design/2026-10-03-managed-shell-monitor-runtime.md.

export interface PendingSessionInput {
  readonly inputId: string;
  readonly turnId: string;
  readonly source: string;
  readonly sequence: number;
  readonly contentRef: ManagedSessionJsonValue | undefined;
}

/**
 * The inputs the Session still owes a consumer, oldest first. A turn
 * settled under an accepted input's turnId consumes exactly that id;
 * nothing else does.
 */
export function pendingSessionInputs(
  events: readonly ManagedSessionEvent[],
): PendingSessionInput[] {
  const settled = new Set<string>();
  for (const event of events) {
    if (event.kind === 'turn.settled') {
      const turnId = event.payload['turnId'];
      if (typeof turnId === 'string') settled.add(turnId);
    }
  }
  const pending: PendingSessionInput[] = [];
  for (const event of events) {
    if (event.kind !== 'input.accepted') continue;
    const inputId = event.payload['inputId'];
    const turnId = event.payload['turnId'];
    if (typeof inputId !== 'string' || typeof turnId !== 'string') continue;
    if (settled.has(turnId)) continue;
    pending.push({
      inputId,
      turnId,
      source:
        typeof event.payload['source'] === 'string'
          ? (event.payload['source'] as string)
          : 'unknown',
      sequence: event.sequence,
      contentRef: event.payload['contentRef'],
    });
  }
  return pending;
}
