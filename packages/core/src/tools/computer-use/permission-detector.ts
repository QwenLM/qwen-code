/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * What kind of permission issue, if any, the cua-driver MCP result
 * indicates. We classify based on message strings because cua-driver
 * doesn't expose a typed errorKind through MCP. The strings below are
 * taken from cua-driver's macOS permission surface
 * (`libs/cua-driver/rust/crates/platform-macos/src/permissions/`).
 */
export type PermissionErrorKind =
  | 'none' // success, or non-error result
  | 'other' // error, but not a permission issue
  | 'accessibility' // AX missing
  | 'screenRecording' // Screen Recording missing
  | 'unknown_permission'; // permission-related but doesn't pinpoint which

/**
 * cua-driver permission error patterns. Order matters — more specific
 * patterns first; the generic "Missing TCC grant" / "needs your
 * permission" fallbacks are last so they don't preempt the specific ones.
 */
const PATTERNS: Array<{ kind: PermissionErrorKind; regex: RegExp }> = [
  {
    kind: 'accessibility',
    regex: /accessibility:?\s*(missing|denied|not granted)/i,
  },
  { kind: 'accessibility', regex: /accessibility permission/i },
  {
    kind: 'screenRecording',
    regex: /screen recording:?\s*(missing|denied|not granted)/i,
  },
  { kind: 'screenRecording', regex: /screen recording permission/i },
  {
    kind: 'unknown_permission',
    regex: /missing tcc grant|needs your permission/i,
  },
];

export function detectPermissionError(
  result: CallToolResult,
): PermissionErrorKind {
  if (!result.isError) return 'none';
  const text = result.content
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('\n');
  for (const { kind, regex } of PATTERNS) {
    if (regex.test(text)) return kind;
  }
  return 'other';
}
