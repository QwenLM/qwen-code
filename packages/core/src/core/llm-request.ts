/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { PartListUnion } from '@google/genai';
import { partToString } from '../utils/partUtils.js';

/**
 * Represents a request to be sent to the LLM API.
 * For now, it's an alias to PartListUnion as the primary content.
 * This can be expanded later to include other request parameters.
 */
export type LlmCodeRequest = PartListUnion;

/**
 * @deprecated Use `LlmCodeRequest`. Kept for one release so standalone core
 * package consumers can migrate without a breaking rename.
 */
export type GeminiCodeRequest = LlmCodeRequest;

export function partListUnionToString(value: PartListUnion): string {
  return partToString(value, { verbose: true });
}
