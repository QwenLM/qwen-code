/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

export const COMPRESSION_SUMMARY_MODEL_ACK =
  'Got it. Thanks for the additional context!';

export const COMPRESSION_CONTINUATION_BRIDGE_MARKER =
  '\u200B\u200C\u200D\u2060';
const COMPRESSION_CONTINUATION_BRIDGE_PROMPT =
  'Continue with the prior task using the context above.';

// The invisible sentinel marker prevents a real user prompt with the same
// visible text from being treated as the synthetic bridge inserted after
// compression. Detection should use isCompressionContinuationBridge()
// which checks for the marker prefix rather than the full string.
export const COMPRESSION_CONTINUATION_BRIDGE = `${COMPRESSION_CONTINUATION_BRIDGE_MARKER}${COMPRESSION_CONTINUATION_BRIDGE_PROMPT}`;

export const POST_COMPACT_FILE_REFERENCES_PREFIX =
  'The following files were recently accessed before context was compacted.';
export const POST_COMPACT_FILE_EMBED_PREFIX =
  'Recently accessed file (full current content embedded):';
export const POST_COMPACT_IMAGE_RESTORATION_PREFIX =
  'Recent visual snapshots preserved from before context was compacted';
export const POST_COMPACT_PLAN_MODE_PREFIX = '<plan-mode-active>';
export const POST_COMPACT_BACKGROUND_TASKS_PREFIX = '<background-tasks>';

export const POST_COMPACT_ATTACHMENT_TEXT_PREFIXES = [
  POST_COMPACT_FILE_REFERENCES_PREFIX,
  POST_COMPACT_FILE_EMBED_PREFIX,
  POST_COMPACT_IMAGE_RESTORATION_PREFIX,
  POST_COMPACT_PLAN_MODE_PREFIX,
  POST_COMPACT_BACKGROUND_TASKS_PREFIX,
] as const;
