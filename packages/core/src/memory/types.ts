/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export const AUTO_MEMORY_TYPES = [
  'user',
  'feedback',
  'project',
  'reference',
] as const;

export type AutoMemoryType = (typeof AUTO_MEMORY_TYPES)[number];

export const AUTO_MEMORY_SCOPES = ['project', 'user', 'team'] as const;

export type AutoMemoryScope = (typeof AUTO_MEMORY_SCOPES)[number];

export const AUTO_MEMORY_TREE_CATEGORIES = [
  'basic_information',
  'hobbies',
  'communication_preference',
  'behavior_habit',
  'project_introduction',
  'tech_stack',
  'build_configuration',
  'dependency_configuration',
  'ide_configuration',
  'scm_configuration',
  'environment_configuration',
  'code_standard',
  'practice_standard',
  'testing_standard',
  'comment_standard',
  'tool_experience',
  'mcp_experience',
  'common_pitfall',
  'important_decision',
  'task_summary',
] as const;

export const AUTO_MEMORY_UNCATEGORIZED = 'uncategorized' as const;

export type AutoMemoryTreeCategory =
  (typeof AUTO_MEMORY_TREE_CATEGORIES)[number];

export type AutoMemoryTreeCategoryKey =
  | AutoMemoryTreeCategory
  | typeof AUTO_MEMORY_UNCATEGORIZED;

export const AUTO_MEMORY_SCHEMA_VERSION = 1;

export interface AutoMemorySourceRef {
  sessionId?: string;
  recordedAt: string;
  messageIds?: string[];
}

export interface AutoMemoryMetadata {
  version: typeof AUTO_MEMORY_SCHEMA_VERSION;
  createdAt: string;
  updatedAt: string;
  lastExtractionAt?: string;
  lastExtractionSessionId?: string;
  lastExtractionTouchedTopics?: AutoMemoryType[];
  lastExtractionStatus?: 'updated' | 'noop';
  lastDreamAt?: string;
  lastDreamSessionId?: string;
  lastDreamTouchedTopics?: AutoMemoryType[];
  lastDreamStatus?: 'updated' | 'noop';
  recentSessionIdsSinceDream?: string[];
}

export type UserAutoMemoryDreamStatus =
  | 'idle'
  | 'pending'
  | 'running'
  | 'updated'
  | 'noop'
  | 'failed'
  | 'cancelled';

export interface UserAutoMemoryMetadata {
  version: typeof AUTO_MEMORY_SCHEMA_VERSION;
  createdAt: string;
  updatedAt: string;
  lastDreamAt?: string;
  lastAttemptAt?: string;
  dirtyMutations: number;
  status: UserAutoMemoryDreamStatus;
  pendingReason?: 'dirty_mutations' | 'document_limit';
}

export interface AutoMemoryExtractCursor {
  sessionId?: string;
  /**
   * RAW-history index covered by extraction. Never compare this with the
   * curated-window fields below: curation merges and drops entries, so raw and
   * curated index spaces are not interchangeable.
   */
  processedOffset?: number;
  updatedAt: string;
  /**
   * Opt-in stable extraction window state (#15493,
   * `QWEN_CODE_MEMORY_EXTRACT_STABLE_WINDOW`). Every offset here is a CURATED
   * history index. All fields are absent unless the experiment has run for
   * this project, so a pre-experiment cursor stays readable.
   */
  epoch?: number;
  windowStartCurated?: number;
  coveredCurated?: number;
  windowHeadHash?: string;
  windowEpochId?: string;
}
