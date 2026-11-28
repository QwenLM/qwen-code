/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Raw metadata read from a single session transcript file.
 *
 * This is an infrastructure DTO: it carries only the facts extracted from
 * disk, leaving domain projection to the manager layer.
 */
export interface SessionFileMetadata {
  /** Session identifier, typically the file stem. */
  readonly sessionId: string;
  /** Absolute path to the transcript file. */
  readonly sessionPath: string;
  /** Absolute path to the directory containing the transcript file. */
  readonly transcriptBucketDir: string;
  /** File size in bytes. */
  readonly fileSize: number;
  /** ISO timestamp of the last file modification. */
  readonly updatedAt: string;
  /** ISO timestamp parsed from the first JSONL line, falling back to updatedAt. */
  readonly startedAt: string;
  /** Current working directory parsed from the first JSONL line. */
  readonly cwd: string;
  /** Latest workspace directories parsed from the transcript tail, if present. */
  readonly directories: readonly string[] | undefined;
  /** Git branch parsed from the first JSONL line, if present. */
  readonly gitBranch: string | undefined;
  /** Latest custom title parsed from the transcript tail, if present. */
  readonly customTitle: string | undefined;
  /** Latest AI-generated title parsed from the transcript tail, if present. */
  readonly aiTitle: string | undefined;
  /** Latest last-prompt entry parsed from the transcript tail, if present. */
  readonly lastPrompt: string | undefined;
  /** Latest summary entry parsed from the transcript tail, if present. */
  readonly summary: string | undefined;
  /** Latest tag entry parsed from the transcript tail, if present. */
  readonly tag: string | undefined;
}
