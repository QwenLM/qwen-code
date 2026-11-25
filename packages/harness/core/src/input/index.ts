/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Barrel export for the input processing pipeline.
 *
 * Public API surface for the `@qwen-code/core` input module.
 */

// ── Types ──
export type {
  PastedContent,
  CommandMode,
  QueuePriority,
  MessageOrigin,
  QueuedCommand,
  SelectedSkillInput,
  ProcessInputRequest,
  ProcessInputResult,
  ProcessInputContext,
} from './types.js';

// ── Origin content wrapping ──
export {
  deriveOrigin,
  unwrapPeerMessageText,
  wrapContentByOrigin,
  wrapTextByOrigin,
} from './origin-content-wrapping.js';

// ── Text expansion utilities ──
export {
  expandPastedTextRefs,
  filterOrphanedImages,
  parseImagePlaceholderIds,
  restoreImagePlaceholderText,
} from './text-expander.js';

// ── Image pipeline ──
export {
  preparePastedImage,
  materializePastedContents,
  storeImages,
  resizePastedImage,
  processPastedImages,
  addImageMetadataMessage,
} from './image-pipeline.js';
export type {
  ResizedImage,
  ImagePipelineResult,
  DegradedPastedImage,
} from './image-pipeline.js';

// ── Core processor ──
export { processUserInput, resizeImageBlocks } from './processor.js';
export type { ProcessInputFullContext } from './processor.js';

// ── Batch executor ──
export { executeUserInput } from './executor.js';
export type { ExecuteInputContext, ExecuteInputResult } from './executor.js';
