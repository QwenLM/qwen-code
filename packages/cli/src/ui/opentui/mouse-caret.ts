/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Prompt-click caret placement for the OpenTUI composer (PR1 slice 4).
 *
 * Re-exports the framework-neutral original (`utils/input-mouse.ts`) so
 * width/grapheme fixes land in one place for both renderers instead of
 * diverging between a fork and its source.
 */

export {
  visualClickToOffset,
  type ClickableBufferState,
} from '../utils/input-mouse.js';
