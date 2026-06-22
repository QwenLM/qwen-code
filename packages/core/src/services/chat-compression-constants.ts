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
