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

export const AUTO_MEMORY_SCHEMA_VERSION = 1;

export interface AutoMemorySourceRef {
  sessionId?: string;
  transcriptPath?: string;
  recordedAt: string;
  messageIds?: string[];
}

export interface AutoMemoryEntry {
  id: string;
  type: AutoMemoryType;
  title: string;
  summary: string;
  tags: string[];
  lastUpdated: string;
  stability: 'working' | 'stable';
  sources: AutoMemorySourceRef[];
}

export interface AutoMemoryTopicDocument {
  type: AutoMemoryType;
  title: string;
  description: string;
  entries: AutoMemoryEntry[];
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

export interface AutoMemoryExtractCursor {
  sessionId?: string;
  transcriptPath?: string;
  processedOffset?: number;
  updatedAt: string;
}