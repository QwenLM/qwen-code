/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export function normalizeWorkflowToolArgs(args: unknown): unknown {
  if (typeof args !== 'string') return args;
  const trimmed = args.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return args;
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === 'object' && parsed !== null) return parsed;
  } catch {
    return args;
  }
  return args;
}
