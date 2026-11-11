/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Stamp for constructing a {@link Message} aggregate from external data.
 *
 * All fields are optional so that callers with partial data (e.g. daemon
 * RPC-loaded JSONL entries) can still construct a Session projection. The
 * factory applies sensible defaults for missing identity/timing fields.
 */
export interface MessageStamp {
  readonly uuid?: string;
  readonly sessionId?: string;
  readonly turnId?: string;
  /** Parent uuid in the transcript DAG; null for root messages. */
  readonly parent?: string | null;
  readonly logicalParent?: string | null;
  readonly sidechainOf?: string;
  readonly timestamp?: string;
  /** Message role discriminant. */
  readonly role?: 'user' | 'assistant' | 'system' | 'attachment';
  /**
   * Opaque protocol payload carried by the message. The writer serializes this
   * record into the JSONL transcript entry, so it must be JSON-serializable.
   */
  readonly payload?: Record<string, unknown>;

  // ── Turn context ──
  /** Identifier shared by all messages created for the same user turn. */
  readonly promptId?: string;
  /** Request-set grouping key started by this human message, when applicable. */
  readonly requestSetId?: string;
  /** Owning subagent, when this message belongs to a sidechain. */
  readonly agentId?: string;
  /** Fork provenance, present only for messages copied by a fork. */
  readonly forkedFrom?: {
    /** Source session id that was forked. */
    readonly sessionId: string;
    /** Source message UUID carried over in the fork. */
    readonly messageUuid: string;
  };

  // ── Classification flags ──
  /** Synthetic/meta message (not a real user/assistant interaction). */
  readonly isMeta?: boolean;
  /** Whether this message belongs to a sidechain (subagent conversation). */
  readonly isSidechain?: boolean;
  /** Origin metadata for user messages; maps to the legacy `UserMessage.origin`. */
  readonly origin?: { readonly kind: string };
}
