/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Per-session attribution for cost tracking (`add-cost-tracking`: the ingester
 * records `attribution_token_id` = "the originating client's tokenId" and
 * `sub_actor` from `X-RC-SubActor`). A prompt is the originating request, so the
 * prompt route records the current `(tokenId, subActor)` for the session here, and
 * the ingester reads it when a `session_update` arrives.
 *
 * In-memory and ephemeral (like the daemon's session state): on a restart, or for
 * events with no preceding prompt this process saw (session resume, daemon-
 * initiated activity, the first frames after subscribe), `get` returns the
 * {@link UNATTRIBUTED_TOKEN_ID} sentinel so the NOT-NULL column always has a value
 * and the ingester never throws.
 */

export interface Attribution {
  attributionTokenId: string;
  subActor: string | null;
}

/** Recorded when no prompt-originated attribution is known for a session. */
export const UNATTRIBUTED_TOKEN_ID = 'unknown';

export class SessionAttributionMap {
  private readonly map = new Map<string, Attribution>();

  /** Record the originator of a session's current activity (on prompt send). */
  set(sessionId: string, attribution: Attribution): void {
    this.map.set(sessionId, attribution);
  }

  /** The session's attribution, or the unattributed sentinel when unknown. */
  get(sessionId: string): Attribution {
    return (
      this.map.get(sessionId) ?? {
        attributionTokenId: UNATTRIBUTED_TOKEN_ID,
        subActor: null,
      }
    );
  }

  /** Forget a session (e.g. on removal) so the map can't grow unbounded. */
  delete(sessionId: string): void {
    this.map.delete(sessionId);
  }
}
