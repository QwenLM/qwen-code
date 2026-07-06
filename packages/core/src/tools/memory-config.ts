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
export {
  AGENT_CONTEXT_FILENAME,
  DEFAULT_CONTEXT_FILENAME,
  getAllGeminiMdFilenames,
  getCurrentGeminiMdFilename,
  MEMORY_SECTION_HEADER,
  setGeminiMdFilename,
} from '../memory/const.js';
