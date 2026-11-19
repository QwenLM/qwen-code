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
 * a quote is always one line.
 *
 * The fence's own tokens are entity-escaped here, before the length cap:
 * an unescaped closing tag in the body would truncate the chip at the
 * first re-parse (the fence matcher stops at the first closing tag), and
 * an unescaped opening tag would let the body carry a second fence the
 * annotation round trip cannot verify. Escaping keeps the mention readable
 * in the chip, its tooltip and the sent prompt while the serialized form
 * always holds exactly one open and one close token.
 */
const QUOTE_FENCE_TOKEN_RE = /<\/?quoted-message>/g;
const escapeQuoteFenceToken = (token: string): string =>
  token.replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function flattenQuoteText(raw: string): string {
  const cleaned = raw
    .replace(BIDI_CONTROL_RE, '')
    .replace(QUOTE_FENCE_TOKEN_RE, escapeQuoteFenceToken)
    .replace(/\s+/g, ' ')
    .trim();
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

/** Opening token of the quote fence; a shell must never receive it. */
export const QUOTE_FENCE_OPEN = '<quoted-message>';

// The non-greedy body stops at the first closing tag; `+` (not `*`) keeps an
// empty fence literal text, since a chip can never serialize to one, and the
// newline-free body keeps the match single-line, because flattenQuoteText
// strips every newline out of a chip's fragment.
const QUOTE_FENCE_MATCH_RE = /<quoted-message>([^\n]+?)<\/quoted-message>/g;

export interface QuoteFenceMatch {
  from: number;
  to: number;
  fragment: string;
}

/**
 * Finds the complete single-line `<quoted-message>` fences in a pasted
 * string. The composer's quote chips are the only producer of this shape,
 * so a fence in a paste is a chip that was copied or cut from the editor
 * and should rehydrate into a chip, not stay as raw tag text.
 */
export function findQuoteFenceRanges(text: string): QuoteFenceMatch[] {
  const matches: QuoteFenceMatch[] = [];
  QUOTE_FENCE_MATCH_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = QUOTE_FENCE_MATCH_RE.exec(text)) !== null) {
    matches.push({
      from: match.index,
      to: match.index + match[0].length,
      fragment: match[1] ?? '',
    });
  }
  return matches;
}

/**
 * Builds the composer insert text for a quoted fragment, e.g.
 * `<quoted-message>quoted fragment text</quoted-message>`. The semantic
 * fence marks the fragment as a quote inside the sent prompt instead of
 * markdown blockquote styling.
 */
export function quoteReferenceInsertText(flattened: string): string {
  return `${QUOTE_FENCE_OPEN}${flattened}</quoted-message>`;
}

// A click in the composer places the caret before the chip's trailing break,
// so a follow-up typed on the fence's line glues to the closing tag once the
// trailing break is trimmed at submit; re-break such a glued follow-up where
// every send path converges, so it always starts on its own line. Only a
// complete chip fence (open + single-line body + close) is re-broken: a
// prompt that merely mentions the closing token as plain text carries no
// quote and must be sent untouched.
export function breakQuoteFenceFollowup(text: string): string {
  return text.replace(
    /<quoted-message>[^\n]+?<\/quoted-message>[ \t]*(?=\S)/g,
    (fence) => `${fence.replace(/[ \t]+$/, '')}\n`,
  );
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

// A random per-page-load base keeps ids unique across reloads: a restored
// chip keeps the id of the load that created it, and the × handler deletes
// every range carrying that id, so a fresh chip must never collide with a
// restored one.
let quoteSequence = Math.floor(Math.random() * 0x7fffffff);

/**
 * Builds the composer tag for a quoted message fragment, or `null` when
 * the selection carries no quotable text. The tag renders as an inline
 * chip (kind `quote`) whose serialized form is a `<quoted-message>`
 * fence, so it survives send/reload through the standard reference
 * annotations. Every call gets its own id: quoting the same fragment
 * twice yields two independent chips (removing one must not remove the
 * other).
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

/**
 * Strips complete quote fences from a prompt so text derived from it — a
 * side task's first-prompt name — reads the user's words, not the chip's
 * fence: a 200+ char quote in front of the question would otherwise
 * swallow the whole name. A fence-only prompt strips to nothing and the
 * caller leaves the session unnamed.
 */
export function stripQuoteFences(text: string): string {
  return text.replace(QUOTE_FENCE_MATCH_RE, ' ').replace(/\s+/g, ' ').trim();
}

/** The part of the composer handle a quote insertion needs. */
export interface QuoteComposerTarget {
  insertQuote?(
    tag: WebShellComposerTag,
    options?: { focus?: boolean },
  ): boolean;
}

/**
 * The one quote-insertion policy both chat hosts (main chat and split-view
 * panes) share. Returns whether a chip was inserted; the composer itself
 * declines while disabled or in shell mode. The `focus` option is passed
 * through so the asynchronous ask-in-side-task delivery can insert without
 * stealing focus from the control the user moved to.
 */
export function insertQuoteIntoComposer(
  composer: QuoteComposerTarget | null | undefined,
  raw: string,
  options?: { focus?: boolean },
): boolean {
  if (!composer?.insertQuote) return false;
  const tag = buildQuoteReferenceTag(raw);
  if (!tag) return false;
  return composer.insertQuote(tag, options);
}
