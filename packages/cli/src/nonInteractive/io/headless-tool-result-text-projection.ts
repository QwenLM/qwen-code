/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { projectJsonStringToByteBudget } from '../../utils/json-string-byte-projection.js';

export const HEADLESS_TOOL_RESULT_TEXT_JSON_BYTE_BUDGET = 65_536;
export const HEADLESS_TOOL_RESULT_TEXT_TRUNCATION_MARKER =
  '\n[... truncated for Headless transport ...]\n';

export function projectHeadlessToolResultContent(value: string): string {
  return projectJsonStringToByteBudget(
    value,
    HEADLESS_TOOL_RESULT_TEXT_JSON_BYTE_BUDGET,
    HEADLESS_TOOL_RESULT_TEXT_TRUNCATION_MARKER,
  );
}
