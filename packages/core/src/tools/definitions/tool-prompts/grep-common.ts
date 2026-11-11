/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { GREP_TOOL_NAME } from '../base-declarations.js';

/**
 * Shared preamble used by both grep variants (legacy and ripgrep).
 */
export const GREP_TOOL_PREAMBLE = `ALWAYS use ${GREP_TOOL_NAME} for search tasks. NEVER invoke \`grep\` or \`rg\` through a shell tool. The ${GREP_TOOL_NAME} tool has been optimized for correct permissions and access.`;
