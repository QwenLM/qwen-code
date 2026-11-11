/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { AGENT_TOOL_NAME } from '../base-declarations.js';
import { GREP_TOOL_PREAMBLE } from './grep-common.js';

/**
 * Returns the description for `Grep` (legacy non-ripgrep variant).
 */
export function getGrepLegacyDescription(): string {
  return `Searches for a regular expression pattern within file contents. Max 100 matches.

  Usage:
  - ${GREP_TOOL_PREAMBLE}
  - Use ${AGENT_TOOL_NAME} tool for open-ended searches requiring multiple rounds`;
}
