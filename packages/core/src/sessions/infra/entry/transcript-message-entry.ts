/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A message entry persisted in the transcript, enriched with chain metadata.
 *
 * The embedded message payload is intentionally left as an opaque record so
 * the codec does not depend on the runtime Message union.
 */
export interface TranscriptMessageEntry {
  readonly type: 'user' | 'assistant' | 'system' | 'attachment';
  readonly uuid: string;
  readonly timestamp: string;
  readonly parentUuid: string | null;
  readonly logicalParentUuid?: string | null;
  readonly isSidechain: boolean;
  readonly cwd: string;
  readonly sessionId: string;
  readonly userType: string;
  readonly version: string;
  readonly gitBranch?: string;
  readonly agentId?: string;
  readonly teamName?: string;
  readonly agentName?: string;
  readonly agentColor?: string;
  /** Identifier shared by all messages created for the same user turn. */
  readonly promptId?: string;
  /** Request-set grouping key started by this human message, when applicable. */
  readonly requestSetId?: string;
  /** Fork provenance, present only for messages copied by a fork. */
  readonly forkedFrom?: {
    readonly sessionId: string;
    readonly messageUuid: string;
  };
  /** Present for user / assistant / system entries. */
  readonly message?: Record<string, unknown>;
  /** Present for attachment entries; payload is opaque to avoid runtime type coupling. */
  readonly attachment?: Record<string, unknown>;
  readonly [key: string]: unknown;
}
