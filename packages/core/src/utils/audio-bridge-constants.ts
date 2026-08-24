/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Default ceiling for a single audio payload handed to the voice bridge,
 * measured in decoded bytes. Oversized audio is rejected outright, never
 * placeholder-substituted.
 *
 * Lives in utils/ (a leaf layer) so size gates in file reading can reference
 * it without an upward import; `core/inlineMediaLimit.ts` re-exports it to
 * keep the public API stable.
 */
export const DEFAULT_MAX_AUDIO_BRIDGE_BYTES = 10 * 1024 * 1024;
