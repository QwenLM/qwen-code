/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Lightweight configuration for memory/context file naming.
 * Extracted from memoryTool.ts to avoid loading the full tool module
 * when only the filename configuration is needed.
 */

export const QWEN_CONFIG_DIR = '.qwen';
export const DEFAULT_CONTEXT_FILENAME = 'QWEN.md';
export const AGENT_CONTEXT_FILENAME = 'AGENTS.md';
export const MEMORY_SECTION_HEADER = '## Qwen Added Memories';

// This variable will hold the currently configured filename for context files.
// It defaults to include both QWEN.md and AGENTS.md but can be overridden by setGeminiMdFilename.
// QWEN.md is first to maintain backward compatibility (used by /init command and save_memory tool).
let currentGeminiMdFilename: string | string[] = [
  DEFAULT_CONTEXT_FILENAME,
  AGENT_CONTEXT_FILENAME,
];

export function setGeminiMdFilename(newFilename: string | string[]): void {
  if (Array.isArray(newFilename)) {
    if (newFilename.length > 0) {
      currentGeminiMdFilename = newFilename.map((name) => name.trim());
    }
  } else if (newFilename && newFilename.trim() !== '') {
    currentGeminiMdFilename = newFilename.trim();
  }
}

export function getCurrentGeminiMdFilename(): string {
  if (Array.isArray(currentGeminiMdFilename)) {
    return currentGeminiMdFilename[0];
  }
  return currentGeminiMdFilename;
}

export function getAllGeminiMdFilenames(): string[] {
  if (Array.isArray(currentGeminiMdFilename)) {
    return currentGeminiMdFilename;
  }
  return [currentGeminiMdFilename];
}
