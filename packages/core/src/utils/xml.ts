/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Escape text so it is safe to interpolate into an XML element body OR
 * an attribute value. Covers all five XML metacharacters (`&`, `<`, `>`,
 * `"`, `'`) so callers can't pick a context-incomplete subset by
 * accident — a future caller using `attr="${escapeXml(input)}"` would
 * otherwise be vulnerable to attribute injection through unescaped `"`.
 *
 * Used wherever model-facing prompts wrap user / extension / MCP-
 * supplied strings in tags (`<available_skills>`, `<task-notification>`,
 * `<system-reminder>`, etc.) — without escaping, a value containing
 * one of the metacharacters could close the envelope early and forge
 * sibling tags that the model would treat as trusted metadata.
 *
 * Pure: no I/O, no allocation beyond the string replacement chain.
 */
export function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
