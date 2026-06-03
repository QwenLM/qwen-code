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

const XML_TAG_CANDIDATE_RE = /<[^>]*>/g;

function isSystemReminderTagIgnorable(char: string): boolean {
  const codePoint = char.codePointAt(0);
  return (
    codePoint === 0x00ad ||
    codePoint === 0xfeff ||
    (codePoint !== undefined &&
      ((codePoint >= 0x0000 && codePoint <= 0x001f) ||
        (codePoint >= 0x007f && codePoint <= 0x009f) ||
        (codePoint >= 0x200b && codePoint <= 0x200f) ||
        (codePoint >= 0x202a && codePoint <= 0x202e) ||
        (codePoint >= 0x2060 && codePoint <= 0x206f) ||
        (codePoint >= 0xfe00 && codePoint <= 0xfe0f)))
  );
}

function normalizeSystemReminderCandidateTag(tag: string): string {
  let normalized = '';
  for (const char of tag) {
    if (!isSystemReminderTagIgnorable(char)) {
      normalized += char;
    }
  }
  return normalized.toLowerCase();
}

function getSystemReminderTagKind(
  tag: string,
): 'closing' | 'other' | undefined {
  // NOTE: no fast-path pre-check (e.g. tag.toLowerCase().includes()) here.
  // Zero-width obfuscated variants would bypass a literal substring check,
  // which is exactly the injection vector normalization is designed to catch.
  const normalized = normalizeSystemReminderCandidateTag(tag);
  const match = /^<\s*(\/?)\s*system-reminder(?:\s+[^>]*)?\s*(\/?)\s*>$/.exec(
    normalized,
  );
  if (!match) {
    return undefined;
  }
  return match[1] ? 'closing' : 'other';
}

function escapeSystemReminderTag(tag: string): string {
  const tagKind = getSystemReminderTagKind(tag);
  if (tagKind === 'closing') {
    return '<\\/system-reminder>';
  }
  if (tagKind === 'other') {
    return escapeXml(tag);
  }
  return tag;
}

/**
 * Escape `<system-reminder>` tag variants in model-facing reminder bodies
 * without XML-escaping the whole body. This keeps markdown/code blocks readable
 * while preventing untrusted content, including visually hidden format/control
 * characters inside the tag, from ending or spoofing the reminder envelope.
 */
export function escapeSystemReminderTags(text: string): string {
  return text.replace(XML_TAG_CANDIDATE_RE, escapeSystemReminderTag);
}
