/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Optional knobs for {@link SessionManager} read operations — where to read
 * from, how deep to project, and how sessions are presented in the result.
 *
 * One type parameterizes all four load methods: `list`, `loadLatest`,
 * `loadById`, `loadByIndex` share the same read-policy dimensions.
 */

/**
 * Filter predicate used by {@link SessionManager.listAll} to decide which
 * project buckets to enter and which session files to read.
 *
 * `entryPath` is the absolute filesystem path of the entry being considered:
 * the bucket directory path when `sessionId` is omitted, and the full path to
 * the `sessionId.jsonl` file when `sessionId` is present. It is NOT the exact
 * `projectDir` stored inside the transcript metadata.
 */
export type SessionFilter = (options: {
  /** Omitting `sessionId` means the callback is deciding bucket entry. */
  readonly sessionId?: string;
  readonly entryPath: string;
}) => boolean;

/** Options controlling how sessions are read and projected. */
export interface SessionLoadOptions {
  /**
   * Overrides the physical bucket directory to read. By default the bucket
   * is derived by sanitizing `projectDir` under the config home; this
   * bypasses that forward derivation.
   *
   * Reverse-addressing callers only (worktree discovery, all-projects
   * browser): they start from a bucket directory enumerated on disk and
   * merely guess `projectDir` from the transcripts' recorded cwd. That
   * guess can legitimately disagree with the bucket physically holding
   * the files (enter-worktree relocation moves a file across buckets but
   * never rewrites its historical entries; fork copies keep the original
   * chain). For such callers `projectDir` is an annotation value while
   * this option is the read address.
   *
   * Omit it in every forward-addressing call: the bucket then follows
   * from `projectDir`.
   */
  readonly bucketDir?: string;
  /**
   * Marks the given session as current
   * (`Session.isCurrentSession()`), e.g. for highlighting in pickers or
   * annotating the resumed session.
   */
  readonly currentSessionId?: string;
  /**
   * Projects searchable text for every session
   * (`Session.getSearchableMessages()` / `getFullContent()`). Off by
   * default: the projection holds the full conversation text in memory
   * per session.
   */
  readonly includeFullContent?: boolean;
  /**
   * Sessions that must be treated as nonexistent for this read — a
   * session whose writer is currently open (e.g. mid-fork) may be in an
   * intermediate state. `list` skips them; `loadById` throws
   * SESSION_NOT_FOUND for them.
   */
  readonly excludeSessionIds?: readonly string[];
  /**
   * Optional filter for {@link SessionManager.listAll}. When provided it is
   * invoked twice:
   * 1. Once per project bucket with `sessionId` omitted, to decide whether to
   *    enter the bucket.
   * 2. Once per session file with both `sessionId` and `entryPath` populated,
   *    to decide whether to read that `sessionId.jsonl`.
   *
   * `entryPath` is the absolute filesystem path of the bucket directory (step
   * 1) or the `sessionId.jsonl` file (step 2).
   */
  readonly filter?: SessionFilter;
}
