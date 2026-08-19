/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ceiling on delegated prompts. It matches the scheduled-task route's limit;
 * core and ACP independently enforce this shared value at their boundaries.
 */
export const MAX_SUB_SESSION_PROMPT_CHARS = 100_000;
