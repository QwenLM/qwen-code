/**
 * @license
 * Copyright 2025 protoLabs
 * SPDX-License-Identifier: Apache-2.0
 */

import { scanMemoryHeaders, getMemoryDir } from './memoryStore.js';
import { formatAge } from './memoryAge.js';
import type { MemoryScope, MemoryHeader } from './types.js';

export interface ScannedMemory extends MemoryHeader {
  filePath: string;
  mtimeMs: number;
}

/**
 * Scan and return memory headers for a scope.
 */
export async function scanMemories(
  scope: MemoryScope,
  cwd?: string,
): Promise<ScannedMemory[]> {
  return scanMemoryHeaders(scope, cwd);
}

/**
 * Format scanned memories as a text manifest (for injection into agent prompts).
 * One line per file: `- [type] filename (age): description`
 */
export function formatMemoryManifest(memories: ScannedMemory[]): string {
  if (memories.length === 0) return '(no existing memories)';

  return memories
    .map((m) => {
      const age = formatAge(m.mtimeMs);
      const filename = m.filePath.split('/').pop() ?? m.name;
      return `- [${m.type}] ${filename} (${age}): ${m.description}`;
    })
    .join('\n');
}

/**
 * Get the memory directory path for a scope.
 */
export { getMemoryDir };
