/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Normalizes user-facing permission mode values to their canonical settings
 * representation. Unknown values are returned unchanged so callers can report
 * the original invalid input.
 */
export function normalizePermissionModeValue(value: string): string {
  const canonical = value.toLowerCase().replace(/[^a-z0-9]/g, '');

  const canonicalMap: Record<string, string> = {
    default: 'default',
    plan: 'plan',
    auto: 'auto',
    acceptedits: 'accept_edits',
    bypasspermissions: 'bypass_permissions',
    yolo: 'bypass_permissions',
    dontask: 'dont_ask',
  };

  return canonicalMap[canonical] ?? value;
}
