/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A small, dependency-free Markdown → HTML converter for the Matrix bridge's
 * `formatted_body` (`add-matrix-bridge`: "session_update rendering with full
 * Markdown"). Matrix's `org.matrix.custom.html` wants a safe HTML subset; the
 * bridge's deliberate no-SDK / no-heavy-dep ethos rules out a full CommonMark
 * library, and the streamed agent prose only needs the common inline/block forms.
 *
 * Handles: fenced code blocks, inline code, bold, italic, links, and line breaks,
 * with everything else HTML-escaped. Code spans/blocks are extracted BEFORE
 * escaping/inline-formatting so their contents are never treated as markup, then
 * restored (escaped) at the end — so a backtick-wrapped `<b>` renders as literal
 * text in a `<code>`, never as a tag. This is a renderer, not a sanitizer: it
 * only ever EMITS the fixed tag set above and HTML-escapes all author text, so no
 * author input can inject other tags/attributes.
 */

// Private-Use-Area delimiter for extracted-code placeholders: it never appears in
// agent prose, isn't a control char, and escapeHtml + the inline rules all leave
// it untouched — so placeholders can't collide with or be mangled by author text.
const PUA = String.fromCharCode(0xe000);
const SPAN_RE = new RegExp(`${PUA}S(\\d+)${PUA}`, 'g');
const BLOCK_RE = new RegExp(`${PUA}B(\\d+)${PUA}`, 'g');

// Link targets are restricted to these schemes. A `javascript:`/`data:`/`vbscript:`
// href would execute when clicked in some Matrix clients, so anything else is
// dropped to plain text (the link's visible text, escaped — never an href).
// Scheme-relative and relative URLs (no `scheme:`) are allowed through.
function isSafeUrl(url: string): boolean {
  const m = /^\s*([a-z][a-z0-9+.-]*):/i.exec(url);
  if (!m) return true; // no scheme → relative / fragment, safe
  const scheme = m[1].toLowerCase();
  return scheme === 'http' || scheme === 'https' || scheme === 'mailto';
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function markdownToHtml(md: string): string {
  const blocks: string[] = [];
  const spans: string[] = [];
  let s = md;

  // 1. Extract fenced code blocks (```lang\n…```), then inline code (`…`), so
  //    their contents bypass escaping/inline rules and are restored verbatim.
  s = s.replace(/```[^\n]*\n?([\s\S]*?)```/g, (_m, code: string) => {
    blocks.push(code);
    return `${PUA}B${blocks.length - 1}${PUA}`;
  });
  s = s.replace(/`([^`]+)`/g, (_m, code: string) => {
    spans.push(code);
    return `${PUA}S${spans.length - 1}${PUA}`;
  });

  // 2. Escape all remaining author text.
  s = escapeHtml(s);

  // 3. Inline markup on the escaped text (escaping never produces * _ [ ] ( )).
  // `url` is already HTML-escaped (step 2 ran first), so don't re-escape it.
  s = s.replace(
    /\[([^\]]+)\]\(([^)\s]+)\)/g,
    (_m, text: string, url: string) =>
      isSafeUrl(url) ? `<a href="${url}">${text}</a>` : text,
  );
  s = s
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>');
  s = s
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/(^|[^\w])_([^_]+)_(?=[^\w]|$)/g, '$1<em>$2</em>');

  // 4. Line breaks (outside code, which was extracted in step 1).
  s = s.replace(/\n/g, '<br>');

  // 5. Restore code, HTML-escaped inside its tags.
  s = s.replace(
    SPAN_RE,
    (_m, i: string) => `<code>${escapeHtml(spans[Number(i)])}</code>`,
  );
  s = s.replace(
    BLOCK_RE,
    (_m, i: string) =>
      `<pre><code>${escapeHtml(blocks[Number(i)])}</code></pre>`,
  );
  return s;
}
