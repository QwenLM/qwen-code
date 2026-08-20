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

// Excludes '<' from the tag body so a run of '<' characters cannot trigger
// quadratic re-scanning (js/polynomial-redos). This also tightens detection:
// `foo < </system-reminder>` now yields the real `</system-reminder>`
// candidate instead of being swallowed by a non-matching `< ...>` span.
const XML_TAG_CANDIDATE_RE = /<[^<>]*>/g;

function isXmlWhitespace(char: string | undefined): boolean {
  return char !== undefined && /\s/.test(char);
}

// Invisible / format / Default_Ignorable code points that must be stripped
// before matching a candidate against the literal `<system-reminder>` tag.
// Untrusted MCP content could otherwise smuggle a zero-width or bidi-format
// character inside the tag name to evade detection (and thus escaping).
// Covers the C0/C1 controls plus the realistically abusable subset of
// Unicode Default_Ignorable_Code_Point — including U+061C (Arabic Letter
// Mark), the Hangul/Mongolian fillers, and the Tags/VS supplement block.
function isSystemReminderTagIgnorable(char: string): boolean {
  const codePoint = char.codePointAt(0);
  if (codePoint === undefined) return false;
  return (
    codePoint === 0x00ad ||
    codePoint === 0x061c ||
    codePoint === 0x3164 ||
    codePoint === 0xfeff ||
    codePoint === 0xffa0 ||
    (codePoint >= 0x0000 && codePoint <= 0x001f) ||
    (codePoint >= 0x007f && codePoint <= 0x009f) ||
    (codePoint >= 0x115f && codePoint <= 0x1160) ||
    (codePoint >= 0x17b4 && codePoint <= 0x17b5) ||
    (codePoint >= 0x180b && codePoint <= 0x180f) ||
    (codePoint >= 0x200b && codePoint <= 0x200f) ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2060 && codePoint <= 0x206f) ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
    (codePoint >= 0xfff0 && codePoint <= 0xfff8) ||
    (codePoint >= 0x1bca0 && codePoint <= 0x1bca3) ||
    (codePoint >= 0x1d173 && codePoint <= 0x1d17a) ||
    (codePoint >= 0xe0000 && codePoint <= 0xe0fff)
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

  // Linear, backtracking-free reimplementation of the former matcher
  // /^<\s*(\/?)\s*system-reminder(?:\s+[^>]*)?\s*(\/?)\s*>$/. The regex form
  // had adjacent ambiguous whitespace quantifiers and was flagged as a
  // polynomial ReDoS (js/polynomial-redos) since it runs on untrusted,
  // model-facing content of unbounded length.
  const len = normalized.length;
  if (len < 2 || normalized[0] !== '<' || normalized[len - 1] !== '>') {
    return undefined;
  }

  let i = 1;
  while (i < len && isXmlWhitespace(normalized[i])) i++;

  let closing = false;
  if (normalized[i] === '/') {
    closing = true;
    i++;
  }
  while (i < len && isXmlWhitespace(normalized[i])) i++;

  const TAG_NAME = 'system-reminder';
  if (normalized.slice(i, i + TAG_NAME.length) !== TAG_NAME) {
    return undefined;
  }
  i += TAG_NAME.length;

  // Optional attribute span: original `(?:\s+[^>]*)?`. The candidate tag was
  // produced by /<[^<>]*>/, so `normalized` (minus the final '>') contains no
  // '>'; consuming to the terminator is a single linear scan.
  if (i < len - 1 && isXmlWhitespace(normalized[i])) {
    while (i < len && isXmlWhitespace(normalized[i])) i++;
    while (i < len && normalized[i] !== '>') i++;
  }

  while (i < len && isXmlWhitespace(normalized[i])) i++;
  if (normalized[i] === '/') i++;
  while (i < len && isXmlWhitespace(normalized[i])) i++;

  if (i !== len - 1 || normalized[i] !== '>') {
    return undefined;
  }
  return closing ? 'closing' : 'other';
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
