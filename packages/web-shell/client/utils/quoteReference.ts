import type { WebShellComposerTag } from '../customization';

/**
 * Cap for a quoted fragment inserted into the composer. Guards both the
 * prompt (token cost) and the chip DOM, which carries the full value.
 */
export const QUOTE_REFERENCE_MAX_CHARS = 4000;

// Bidirectional embedding/isolation controls can reach rendered message
// text (pasted RTL fragments); they break layout once re-inserted into
// the CodeMirror composer document.
const BIDI_CONTROL_RE = /[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

/**
 * Normalizes a selected message fragment for composer insertion: strips
 * bidirectional controls, collapses every whitespace run (including
 * newlines) to a single space, trims, and caps the length. Newlines are
 * flattened because an inline chip is a single editor range: a
 * multi-line serialized form would leave ghost lines behind the chip.
 */
export function flattenQuoteText(raw: string): string {
  const cleaned = raw.replace(BIDI_CONTROL_RE, '').replace(/\s+/g, ' ').trim();
  if (cleaned.length <= QUOTE_REFERENCE_MAX_CHARS) return cleaned;
  return `${cleaned.slice(0, QUOTE_REFERENCE_MAX_CHARS)}…`;
}

/**
 * Builds the composer insert text for a quoted fragment, e.g.
 * `> quoted fragment text`. The markdown blockquote prefix keeps the
 * quote visibly a quote inside the sent prompt without a new protocol
 * construct.
 */
export function quoteReferenceInsertText(flattened: string): string {
  return `> ${flattened}`;
}

function hashQuoteText(text: string): string {
  // FNV-1a (32-bit) — a stable tag id for dedup without carrying the
  // full fragment in the id (long values would bloat aria labels).
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Builds the composer tag for a quoted message fragment, or `null` when
 * the selection carries no quotable text. The tag renders as an inline
 * chip (kind `quote`) whose serialized form is a blockquote line, so it
 * survives send/reload through the standard reference annotations.
 */
export function buildQuoteReferenceTag(
  raw: string,
): WebShellComposerTag | null {
  const flattened = flattenQuoteText(raw);
  if (flattened.length === 0) return null;
  return {
    id: `quote:${hashQuoteText(flattened)}`,
    kind: 'quote',
    value: flattened,
    serialized: quoteReferenceInsertText(flattened),
  };
}
