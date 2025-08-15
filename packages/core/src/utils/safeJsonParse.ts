/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { jsonrepair } from 'jsonrepair';

/**
 * Safely parse JSON string with jsonrepair fallback for malformed JSON.
 * This function attempts to parse JSON normally first, and if that fails,
 * it uses jsonrepair to fix common JSON formatting issues before parsing.
 *
 * @param jsonString - The JSON string to parse
 * @param fallbackValue - The value to return if parsing fails completely
 * @returns The parsed object or the fallback value
 */
export function safeJsonParse<T = Record<string, unknown>>(
  jsonString: string,
  fallbackValue: T = {} as T,
): T {
  if (!jsonString || typeof jsonString !== 'string') {
    return fallbackValue;
  }

  try {
    // First attempt: try normal JSON.parse
    return JSON.parse(jsonString) as T;
  } catch (error) {
    try {
      // Second attempt: use jsonrepair to fix common JSON issues
      const repairedJson = jsonrepair(jsonString);

      // jsonrepair always returns a string, so we need to parse it
      return JSON.parse(repairedJson) as T;
    } catch (repairError) {
      console.error('Failed to parse JSON even with jsonrepair:', {
        originalError: error,
        repairError,
        jsonString,
      });
      return fallbackValue;
    }
  }
}
