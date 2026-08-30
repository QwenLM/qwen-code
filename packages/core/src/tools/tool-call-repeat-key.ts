/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { canonicalToolName } from './tool-names.js';

/**
 * Recursively canonicalizes a JSON-compatible value for stable hashing: object
 * keys are sorted (so property insertion order does not change the identity)
 * while array order is preserved. Used by getToolCallRepeatKey so two
 * semantically identical tool-call arguments that differ only in field order
 * hash to the same key — otherwise a stuck model could evade the repeat
 * guards just by reordering fields.
 */
function canonicalizeForHash(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeForHash);
  }
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    // Null prototype so a literal '__proto__' own key (JSON.parse preserves
    // it) becomes a plain data property instead of routing through the
    // inherited setter and vanishing — two args differing only in
    // '__proto__' must not collide on the same repeat key.
    const sorted = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(source).sort()) {
      sorted[key] = canonicalizeForHash(source[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Stable identity of a (tool, args) call for repeat tracking: a sha256 over
 * the canonicalized name and args (legacy aliases resolved, sorted object
 * keys, preserved array order), so identical calls that differ only in
 * field order — or in a legacy alias such as `task` vs `agent` — hash to
 * the same key, and large payloads (e.g. write_file content) are retained
 * as a fixed-size digest rather than the raw JSON. Shared by the loop
 * detection service, the daemon's turn-loop guard (ACP Session), and the
 * duplicate provider tool-call replay detection so every runtime keys
 * repeats the same way.
 */
export function getToolCallRepeatKey(toolName: string, args: unknown): string {
  const argsString = JSON.stringify(canonicalizeForHash(args));
  const keyString = `${canonicalToolName(toolName)}:${argsString}`;
  return createHash('sha256').update(keyString).digest('hex');
}
