/**
 * Split plain text into URL and non-URL segments so callers can render the URL
 * parts as anchors. Only explicit `http://` / `https://` URLs match — bare
 * domains and emails are left as text on purpose. CJK characters terminate a
 * match (they are always percent-encoded in real URLs, and CJK prose commonly
 * follows a URL with no space), and trailing ASCII sentence punctuation plus
 * closing brackets with no matching opener inside the URL are trimmed from it
 * (so `https://en.wikipedia.org/wiki/Foo_(bar)` keeps its `)` while
 * `(see https://example.com/foo)` drops it). A match that trims down to the
 * bare scheme (`https://`) is not a URL and stays text.
 */

export interface LinkifySegment {
  type: 'text' | 'url';
  value: string;
}

// Excluded after the scheme: whitespace and markup delimiters, full-width
// forms, and the CJK punctuation / ideograph / kana / hangul ranges — all of
// them percent-encoded in real URLs.
const URL_PATTERN =
  /https?:\/\/[^\s<>"'，；：！？（）·—…\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]+/gi;

const TRAILING_PUNCT = new Set([...'.,;:!?\'"`']);

const PAIRED_CLOSERS: Record<string, string> = {
  ')': '(',
  ']': '[',
  '}': '{',
};

const HAS_HOST = /^https?:\/\/./i;

function countChar(text: string, char: string): number {
  let count = 0;
  for (const c of text) {
    if (c === char) count += 1;
  }
  return count;
}

function trimTrailing(url: string): string {
  let out = url;
  while (out.length > 0) {
    const last = out.charAt(out.length - 1);
    const opener = PAIRED_CLOSERS[last];
    if (opener !== undefined) {
      if (countChar(out, opener) >= countChar(out, last)) break;
      out = out.slice(0, -1);
      continue;
    }
    if (!TRAILING_PUNCT.has(last)) break;
    out = out.slice(0, -1);
  }
  return out;
}

export function splitTextByUrls(text: string): LinkifySegment[] {
  const segments: LinkifySegment[] = [];
  let cursor = 0;
  URL_PATTERN.lastIndex = 0;
  for (
    let match = URL_PATTERN.exec(text);
    match !== null;
    match = URL_PATTERN.exec(text)
  ) {
    const url = trimTrailing(match[0]);
    if (!HAS_HOST.test(url)) continue;
    const start = match.index;
    if (start > cursor) {
      segments.push({ type: 'text', value: text.slice(cursor, start) });
    }
    segments.push({ type: 'url', value: url });
    cursor = start + url.length;
  }
  if (cursor < text.length) {
    segments.push({ type: 'text', value: text.slice(cursor) });
  }
  return segments;
}
