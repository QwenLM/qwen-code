/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ExportSessionData } from '../types.js';

/**
 * Converts ExportSessionData to JSON format.
 * Outputs a single JSON object containing the entire session.
 */
export function toJson(sessionData: ExportSessionData): string {
  return JSON.stringify(sessionData, null, 2);
}
