/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import { QWEN_DIR } from '../utils/paths.js';
import type { AutoMemoryType } from './types.js';

export const AUTO_MEMORY_DIRNAME = 'memory';
export const AUTO_MEMORY_INDEX_FILENAME = 'MEMORY.md';
export const AUTO_MEMORY_METADATA_FILENAME = 'meta.json';
export const AUTO_MEMORY_EXTRACT_CURSOR_FILENAME = 'extract-cursor.json';
export const AUTO_MEMORY_CONSOLIDATION_LOCK_FILENAME = 'consolidation.lock';

export function getAutoMemoryRoot(projectRoot: string): string {
  return path.join(projectRoot, QWEN_DIR, AUTO_MEMORY_DIRNAME);
}

export function getAutoMemoryIndexPath(projectRoot: string): string {
  return path.join(getAutoMemoryRoot(projectRoot), AUTO_MEMORY_INDEX_FILENAME);
}

export function getAutoMemoryMetadataPath(projectRoot: string): string {
  return path.join(
    getAutoMemoryRoot(projectRoot),
    AUTO_MEMORY_METADATA_FILENAME,
  );
}

export function getAutoMemoryExtractCursorPath(projectRoot: string): string {
  return path.join(
    getAutoMemoryRoot(projectRoot),
    AUTO_MEMORY_EXTRACT_CURSOR_FILENAME,
  );
}

export function getAutoMemoryConsolidationLockPath(
  projectRoot: string,
): string {
  return path.join(
    getAutoMemoryRoot(projectRoot),
    AUTO_MEMORY_CONSOLIDATION_LOCK_FILENAME,
  );
}

export function getAutoMemoryTopicFilename(type: AutoMemoryType): string {
  return `${type}.md`;
}

export function getAutoMemoryTopicPath(
  projectRoot: string,
  type: AutoMemoryType,
): string {
  return path.join(getAutoMemoryRoot(projectRoot), getAutoMemoryTopicFilename(type));
}