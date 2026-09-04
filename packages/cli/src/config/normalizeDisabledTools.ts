/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Normalize a raw `tools.disabled` settings array into the canonical
 * deduplicated list the agent / restart paths share.
 *
 * Boot path (`cli/src/config/config.ts`'s `disabledTools` array
 * construction) and MCP restart refresh path
 * (`cli/src/acp-integration/acpAgent.ts` post-`restartMcpServer`
 * settings refresh) must agree byte-for-byte on what counts as
 * "disabled" — without that agreement, `ToolRegistry.has(tool.name)`
 * exact-match check silently re-registers tools whose disabled-name
 * carries whitespace (e.g., `' Foo '` typed in settings.json by hand).
 *
 * Lifted from inline implementations so boot path and MCP restart
 * refresh path share a single implementation.
 *
 * Behavior contract:
 *
 *   1. Non-array `raw` (object / number / boolean / null / undefined)
 *      → return `[]`.
 *   2. Non-string entries inside the array → skipped individually
 *      (does NOT abort the whole list — e.g., `[42, 'Foo', null]` → `['Foo']`).
 *   3. Each string entry is `.trim()`-ed.
 *   4. Empty-after-trim entries (`''`, `'  '`, `'\n'`, `'\t'`) → skipped.
 *   5. Duplicates de-duped, preserving first-occurrence order.
 *      Downstream callers materialize the result to `Set<string>`
 *      so order is only meaningful for diagnostic output today,
 *      but this helper preserves it for any future order-sensitive
 *      consumer.
 *
 * The helper does NOT case-fold (e.g., `'Foo'` vs `'foo'` remain
 * distinct) — Stage 1 tool names are case-sensitive throughout
 * `ToolRegistry`, so case-folding here would silently break tool
 * lookups elsewhere. Unicode normalization (`String.prototype.normalize`)
 * is similarly out of scope; if a user pastes a combining-form vs
 * precomposed-form variant they want collapsed, that's a separate
 * decision tracked under workspace settings UX.
 */
export function normalizeDisabledToolList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}
