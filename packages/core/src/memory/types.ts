/**
 * @license
 * Copyright 2025 protoLabs
 * SPDX-License-Identifier: Apache-2.0
 */

export const MEMORY_TYPES = [
  'user',
  'feedback',
  'project',
  'reference',
] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

export type MemoryScope = 'global' | 'project';

export interface MemoryHeader {
  name: string;
  description: string;
  type: MemoryType;
}

export interface MemoryFile {
  header: MemoryHeader;
  content: string;
  filePath: string;
  mtimeMs: number;
}

export interface EntrypointTruncation {
  content: string;
  lineCount: number;
  byteCount: number;
  wasLineTruncated: boolean;
  wasByteTruncated: boolean;
}

export const MAX_ENTRYPOINT_LINES = 200;
export const MAX_ENTRYPOINT_BYTES = 25_000;
export const ENTRYPOINT_NAME = 'MEMORY.md';
export const FRONTMATTER_MAX_LINES = 30;
export const MAX_MEMORY_FILES = 200;
