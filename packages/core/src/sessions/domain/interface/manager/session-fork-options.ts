/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** Options for forking a session into a new transcript. */
export interface SessionForkOptions {
  /** Explicit transcript bucket directory; falls back to the default bucket. */
  readonly bucketDir?: string;
  /**
   * Target session id. When omitted a new UUID is generated.
   * Must differ from the source session id when provided.
   */
  readonly targetSessionId?: string;
  /** Keep the source chain only through this entry UUID. */
  readonly resumeSessionAt?: string;
  /** Refuse the truncation unless the discarded range belongs to this turn. */
  readonly resumeDropsTurn?: string;
  /** Optional title for the forked session. */
  readonly targetTitle?: string;
  /**
   * Fork provenance to stamp on each copied message.
   * When omitted the manager derives it from the source chain.
   */
  readonly forkedFrom?: {
    /** Source session id that was forked. */
    readonly sessionId: string;
    /** Source message UUID carried over in the fork. */
    readonly messageUuid: string;
  };
}
