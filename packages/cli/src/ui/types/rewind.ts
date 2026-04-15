/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SessionHistoryNode } from './sessionHistory.js';

export interface RewindFileChange {
  path: string;
  additions: number;
  deletions: number;
}

export interface RewindCodeSummary {
  hasChanges: boolean;
  summaryText: string;
  detailText: string;
  changes: RewindFileChange[];
  checkpointCommitHash?: string;
}

export interface RewindHistoryEntry {
  key: string;
  kind: 'current' | 'node';
  label: string;
  timestamp?: string;
  node?: SessionHistoryNode;
  codeSummary: RewindCodeSummary;
  restoreCodeSummary?: RewindCodeSummary;
}

export type RewindAction =
  | 'restore_conversation'
  | 'restore_code'
  | 'restore_code_and_conversation'
  | 'summarize_from_here'
  | 'cancel';
