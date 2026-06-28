/**
 * Characters that must be neutralized in ANY attacker-controlled text we embed
 * into a prompt, independent of the wrapper's own delimiters: Unicode line and
 * paragraph separators (U+2028/U+2029 render as newlines in many contexts ->
 * prompt-line injection) and bidirectional override/isolate controls
 * (U+202A-U+202E, U+2066-U+2069 -> trojan-source, where the visual order differs
 * from the logical byte order). ASCII CR/LF are handled by each caller.
 */
const PROMPT_UNSAFE_INVISIBLES = /[\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

/**
 * Neutralize a platform display name before embedding it in a `[name]` prompt
 * tag: strip the bracket/newline delimiters, C0/DEL control chars, and the
 * Unicode line/bidi controls above that would let a crafted nickname break out
 * of the tag, inject extra lines, or smuggle terminal escape sequences, then
 * cap the length. Shared by ChannelBase group attribution and adapters that
 * self-prefix (e.g. QQ), so the rules stay identical everywhere.
 */
export function sanitizeSenderName(name: string): string {
  // A name made entirely of strippable chars collapses to all-spaces; trim()-ing
  // it to '' lets the `|| 'unknown'` fallback fire so the [name] tag is never an
  // anonymous `[]`. Both callers embed the result with no fallback of their own.
  return (
    name
      .replace(PROMPT_UNSAFE_INVISIBLES, ' ')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/[[\]\r\n]/g, ' ')
      .slice(0, 64)
      .trim() || 'unknown'
  );
}

/**
 * Neutralize attacker-controlled text embedded inside a `"..."` prompt wrapper
 * (reply quotes, attachment filenames): strip C0/DEL control chars, the
 * wrapper's own quote/bracket delimiters, and the Unicode line/bidi controls
 * above, then cap the length. Shared so the reply-quote and filename paths
 * can't drift apart.
 */
export function sanitizeQuotedText(text: string, maxLen: number): string {
  return (
    text
      .replace(PROMPT_UNSAFE_INVISIBLES, ' ')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/["[\]]/g, ' ')
      .slice(0, maxLen)
  );
}

/**
 * Neutralize an attacker-influenced filesystem path before rendering it on
 * its own line in a prompt (`... saved to: <path>`). Unlike
 * sanitizeQuotedText, this PRESERVES `[`, `]`, `"`, and spaces: those are
 * valid, common path characters (e.g. Next.js `app/[slug]/page.tsx`, a
 * quoted segment, a space in a folder name), and a path rendered alone on a
 * line cannot use them to break out of that line, so stripping them would
 * only corrupt the path and make the agent's read-file tool miss a file that
 * exists on disk. We strip ONLY what can break or reorder the line: C0/DEL
 * controls (incl. CR/LF -> prompt-line injection) and the Unicode line/para
 * separators + bidi overrides (trojan-source). Length is intentionally NOT
 * capped: real paths can be long.
 */
export function sanitizePromptPath(path: string): string {
  return (
    path
      .replace(PROMPT_UNSAFE_INVISIBLES, ' ')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
  );
}
