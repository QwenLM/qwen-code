/**
 * Split plain text into URL and non-URL segments so callers can render the URL
 * parts as anchors. Only explicit `http://` / `https://` URLs match — bare
 * domains and emails are left as text on purpose. The character set is an
 * allowlist of the ASCII URL grammar, so anything else — whitespace, markup
 * delimiters, CJK prose, emoji — terminates the match (`详情见https://a.com即可`
 * splits at the boundary, `https://a.com👍` does not absorb the emoji).
 * Trailing ASCII sentence punctuation, markdown emphasis delimiters (`*`, `_`),
 * and closing brackets with no matching opener inside the URL are trimmed from
 * it (so `https://en.wikipedia.org/wiki/Foo_(bar)` keeps its `)` while
 * `(see https://example.com/foo)` drops it, and `**https://a.com**` sheds the
 * asterisks). A match that trims down to the bare scheme (`https://`) is not a
 * URL and stays text.
 */

export interface LinkifySegment {
  type: 'text' | 'url';
  value: string;
}

// RFC 3986-ish ASCII URL grammar as an allowlist: alphanumerics, unreserved
// marks, sub-delims, and the gen-delims that can appear inside a URL. Anything
// outside it terminates the match — non-ASCII characters are percent-encoded
// in real URLs, so they fail closed to plain text.
const URL_PATTERN = /https?:\/\/[A-Za-z0-9\-._~:/?#[\]{}@!$&'()*+,;=%]+/gi;

const TRAILING_PUNCT = new Set([...".,;:!?'*_"]);

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
  // A trailing closer belongs to the URL only when an opener inside the URL
  // matches it; each pair's excess closers is counted once up front so the
  // loop below trims by index in O(n) total.
  const excess: Record<string, number> = {};
  for (const [closer, opener] of Object.entries(PAIRED_CLOSERS)) {
    excess[closer] = countChar(url, closer) - countChar(url, opener);
  }
  let end = url.length;
  while (end > 0) {
    const last = url.charAt(end - 1);
    if (Object.hasOwn(excess, last)) {
      if (excess[last] <= 0) break;
      excess[last]--;
      end--;
      continue;
    }
    if (!TRAILING_PUNCT.has(last)) break;
    end--;
  }
  return url.slice(0, end);
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
