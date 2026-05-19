/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Re-exports from the canonical source at `memory/const.ts`.
 * This file exists only for backward compatibility with test mocks
 * that reference `../tools/memory-config`. Runtime code should
 * import directly from `memory/const.js` instead.
 */

export {
  DEFAULT_CONTEXT_FILENAME,
  AGENT_CONTEXT_FILENAME,
  LOCAL_CONTEXT_FILENAME,
  MEMORY_SECTION_HEADER,
  setGeminiMdFilename,
  getCurrentGeminiMdFilename,
  getAllGeminiMdFilenames,
} from '../memory/const.js';
