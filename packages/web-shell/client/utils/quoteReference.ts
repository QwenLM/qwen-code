import type { WebShellComposerTag } from '../customization';

/**
 * Cap for a quoted fragment inserted into the composer. Guards both the
 * prompt (token cost) and the chip DOM, which carries the full value.
 */
export const QUOTE_REFERENCE_MAX_CHARS = 4000;

// Bidirectional controls (the Unicode Bidi_Control property, including the
// Arabic letter mark) can reach rendered message text (pasted RTL
// fragments); they break layout once re-inserted into the CodeMirror
// composer document. Other format characters, such as the zero-width
// joiner inside emoji sequences, are content and stay.
const BIDI_CONTROL_RE = /\p{Bidi_Control}/gu;

/**
 * Normalizes a selected message fragment for composer insertion: strips
 * bidirectional controls, collapses every whitespace run (including
 * newlines) to a single space, trims, and caps the length. Newlines are
 * flattened on purpose: an inline chip is a single editor range, and a
 * multi-line serialized form would leave ghost lines behind the chip, so
 * a quote is always one blockquote line.
 */
export function flattenQuoteText(raw: string): string {
  const cleaned = raw.replace(BIDI_CONTROL_RE, '').replace(/\s+/g, ' ').trim();
  if (cleaned.length <= QUOTE_REFERENCE_MAX_CHARS) return cleaned;
  let end = QUOTE_REFERENCE_MAX_CHARS;
  // Never cut a surrogate pair in half: a lone high surrogate would end up
  // in the chip, its accessible name and the sent prompt.
  const last = cleaned.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${cleaned.slice(0, end)}…`;
}

/** Whether a selection would produce a quote (the Quote button's gate). */
export function isQuotableText(raw: string): boolean {
  return flattenQuoteText(raw).length > 0;
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
  // FNV-1a (32-bit): a short id stem without carrying the full fragment in
  // the id, which travels in the reference annotation.
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

let quoteSequence = 0;

/**
 * Builds the composer tag for a quoted message fragment, or `null` when
 * the selection carries no quotable text. The tag renders as an inline
 * chip (kind `quote`) whose serialized form is a blockquote line, so it
 * survives send/reload through the standard reference annotations. Every
 * call gets its own id: quoting the same fragment twice yields two
 * independent chips (removing one must not remove the other).
 */
export function buildQuoteReferenceTag(
  raw: string,
): WebShellComposerTag | null {
  const flattened = flattenQuoteText(raw);
  if (flattened.length === 0) return null;
  quoteSequence += 1;
  return {
    id: `quote:${hashQuoteText(flattened)}-${quoteSequence.toString(36)}`,
    kind: 'quote',
    value: flattened,
    serialized: quoteReferenceInsertText(flattened),
  };
}

/** The part of the composer handle a quote insertion needs. */
export interface QuoteComposerTarget {
  insertQuote?(tag: WebShellComposerTag): boolean;
}

/**
 * The one quote-insertion policy both chat hosts (main chat and split-view
 * panes) share. Returns whether a chip was inserted; the composer itself
 * declines while disabled or in shell mode.
 */
export function insertQuoteIntoComposer(
  composer: QuoteComposerTarget | null | undefined,
  raw: string,
): boolean {
  if (!composer?.insertQuote) return false;
  const tag = buildQuoteReferenceTag(raw);
  if (!tag) return false;
  return composer.insertQuote(tag);
}
