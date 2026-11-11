/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TranscriptMessageEntry } from './transcript-message-entry.js';
import type {
  ActiveLeafEntry,
  AiTitleEntry,
  ContentReplacementEntry,
  CustomTitleEntry,
  FileHistorySnapshotEntry,
  LastPromptEntry,
  ModeEntry,
  RelocatedEntry,
  RuntimeConfigEntry,
  SummaryEntry,
  TagEntry,
  TokenStatsEntry,
  WorktreeStateEntry,
  WorkspaceDirectoriesEntry,
} from './transcript-metadata-entries.js';

/** Discriminated union of all JSONL entry types known to the writer. */
export type TranscriptEntry =
  | TranscriptMessageEntry
  | SummaryEntry
  | CustomTitleEntry
  | AiTitleEntry
  | LastPromptEntry
  | TagEntry
  | ModeEntry
  | WorkspaceDirectoriesEntry
  | RuntimeConfigEntry
  | ContentReplacementEntry
  | FileHistorySnapshotEntry
  | TokenStatsEntry
  | ActiveLeafEntry
  | RelocatedEntry
  | WorktreeStateEntry;

/**
 * Returns true when the entry is a persisted message that participates in the
 * main or sidechain DAG.
 */
export function isTranscriptMessageEntry(
  entry: TranscriptEntry,
): entry is TranscriptMessageEntry {
  if (entry.type === 'attachment') {
    return 'attachment' in entry;
  }
  return (
    entry.type === 'user' ||
    entry.type === 'assistant' ||
    entry.type === 'system'
  );
}
