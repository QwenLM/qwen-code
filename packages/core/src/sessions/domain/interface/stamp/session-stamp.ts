/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { MessageStamp } from './message-stamp.js';
import type { TurnStamp } from './turn-stamp.js';

/**
 * Stamp for constructing or locating a {@link Session} aggregate.
 *
 * This is the single external DTO for all Session construction pathways:
 * - `SessionManager.create` uses the identity/origin/location fields as the
 *   initial session context; omitted fields receive defaults.
 * - `SessionManager.loadByStamp` uses the full stamp as a fallback when no
 *   cached or persisted session exists for the given id.
 * - `SessionManager.load*` ignores the data fields and projects from disk.
 *
 * All fields are optional so that callers with partial data (e.g. daemon
 * RPC-loaded JSONL entries) can still construct a Session projection.
 */
export interface SessionStamp {
  // ── Identity / origin (used by create and loadByStamp) ──
  readonly sessionId?: string;
  readonly remoteId?: string;
  readonly entrypoint?: string;
  readonly version?: string;
  readonly userType?: string;

  // ── Location (used by create and loadByStamp) ──
  readonly projectDir?: string;
  readonly sessionPath?: string;
  readonly cwd?: string;
  readonly gitBranch?: string;
  readonly worktree?: string | null;
  readonly directories?: readonly string[];

  // ── Time (used by loadByStamp) ──
  readonly startedAt?: string;
  readonly updatedAt?: string;

  // ── Catalog metadata (used by loadByStamp) ──
  readonly tag?: string;
  readonly summary?: string;
  readonly lastPrompt?: string;
  readonly customTitle?: string;
  readonly aiTitle?: string;

  // ── Presentation / addressing (used by loadByStamp) ──
  readonly index?: number;
  readonly isCurrentSession?: boolean;
  readonly transcriptProjectDir?: string;
  readonly transcriptBucketDir?: string;
  readonly sourceWorktreePath?: string;
  readonly displayProjectPath?: string;
  readonly fullContent?: string;
  readonly searchableMessages?: ReadonlyArray<{
    role: 'user' | 'assistant';
    content: string;
  }>;
  readonly searchableContent?: string;

  // ── Statistics (used by loadByStamp) ──
  readonly fileSize?: number;

  // ── Domain children (used by loadByStamp) ──
  /** Flat message chain, in chain order. */
  readonly messages?: readonly MessageStamp[];
  /** All turns of the active chain, in chain order. */
  readonly turns?: readonly TurnStamp[];
}
