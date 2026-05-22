/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Default fortune command: runs fortune with short (-s) output limited to 45 chars.
 * Uses bare command name to let execFile search PATH (works on Linux, macOS, Windows).
 * Shared constant to avoid cross-layer imports and duplication.
 */
export const DEFAULT_FORTUNE_COMMAND = 'fortune -s -n 45';
