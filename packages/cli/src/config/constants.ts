/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Default fortune command: runs fortune with short (-s) output limited to 45 chars.
 * Shared constant to avoid cross-layer imports and duplication.
 */
export const DEFAULT_FORTUNE_COMMAND = '/usr/games/fortune -s -n 45';
