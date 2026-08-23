/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AnyDeclarativeTool } from '../tools/tools.js';

/**
 * Type guard to check if an object is a Tool.
 * @param obj The object to check.
 * @returns True if the object is a Tool, false otherwise.
 */
export function isTool(obj: unknown): obj is AnyDeclarativeTool {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    'name' in obj &&
    'build' in obj &&
    typeof (obj as AnyDeclarativeTool).build === 'function'
  );
}
