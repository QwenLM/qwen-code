/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Part, PartListUnion, PartUnion } from '@google/genai';
import type { Config } from '../config/config.js';
import { getAllGeminiMdFilenames } from './memoryTool.js';

/**
 * Session-scoped tracker for JIT context files already loaded.
 * Prevents duplicate injection of the same context file across tool calls.
 */
const loadedPaths = new Set<string>();

export function resetJitContextState(): void {
  loadedPaths.clear();
}

/**
 * Discovers JIT (Just-In-Time) subdirectory context files by scanning
 * upward from the accessed path to the workspace root. Returns the
 * concatenated content of any newly discovered context files.
 *
 * Accepts either a Config object (extracts trusted roots automatically)
 * or explicit trusted roots array.
 */
export async function discoverJitContext(
  configOrRoots: Config | string[],
  accessedPath: string,
): Promise<string> {
  try {
    const trustedRoots = Array.isArray(configOrRoots)
      ? configOrRoots
      : [...configOrRoots.getWorkspaceContext().getDirectories()];

    const contextFilenames = getAllGeminiMdFilenames();
    const discoveredContents: string[] = [];

    let dir: string;
    try {
      const stat = await fs.stat(accessedPath);
      dir = stat.isDirectory() ? accessedPath : path.dirname(accessedPath);
    } catch {
      dir = path.dirname(accessedPath);
    }

    const isWithinTrustedRoot = (p: string) =>
      trustedRoots.some((root) => {
        const relative = path.relative(root, p);
        return !relative.startsWith('..');
      });

    while (isWithinTrustedRoot(dir)) {
      for (const filename of contextFilenames) {
        const contextFilePath = path.join(dir, filename);
        if (loadedPaths.has(contextFilePath)) continue;

        try {
          const content = await fs.readFile(contextFilePath, 'utf8');
          if (content.trim()) {
            loadedPaths.add(contextFilePath);
            discoveredContents.push(content.trim());
          }
        } catch {
          // File doesn't exist — expected
        }
      }

      const parentDir = path.dirname(dir);
      if (parentDir === dir) break;
      dir = parentDir;
    }

    return discoveredContents.join('\n\n');
  } catch {
    return '';
  }
}

export const JIT_CONTEXT_PREFIX =
  '\n\n--- Newly Discovered Project Context ---\n';
export const JIT_CONTEXT_SUFFIX = '\n--- End Project Context ---';

export function appendJitContext(
  llmContent: string,
  jitContext: string,
): string {
  if (!jitContext) {
    return llmContent;
  }
  return `${llmContent}${JIT_CONTEXT_PREFIX}${jitContext}${JIT_CONTEXT_SUFFIX}`;
}

export function appendJitContextToParts(
  llmContent: PartListUnion,
  jitContext: string,
): PartUnion[] {
  const jitPart: Part = {
    text: `${JIT_CONTEXT_PREFIX}${jitContext}${JIT_CONTEXT_SUFFIX}`,
  };
  const existingParts: PartUnion[] = Array.isArray(llmContent)
    ? llmContent
    : [llmContent];
  return [...existingParts, jitPart];
}
