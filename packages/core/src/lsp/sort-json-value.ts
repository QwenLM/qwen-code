/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }
  if (value && typeof value === 'object') {
    // Object.create(null) avoids prototype pollution from __proto__ keys
    const sorted = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortJsonValue((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}
