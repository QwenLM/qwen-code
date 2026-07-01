/**
 * Characters that must be neutralized in ANY attacker-controlled text we embed
 * into a prompt, independent of the wrapper's own delimiters: the C1 control
 * block (U+0080-U+009F) - notably NEL (U+0085), a Unicode line break (UAX#14 BK
 * class) that renders as a new line, i.e. prompt-line injection - plus the
 * Unicode line/paragraph separators (U+2028/U+2029, likewise rendered as
 * newlines) and the bidirectional override/isolate controls (U+202A-U+202E,
 * U+2066-U+2069 -> trojan-source, where the visual order differs from the
 * logical byte order). Also strips common zero-width format chars that make
 * visually identical names/text compare differently. ASCII C0/DEL (incl. CR/LF)
 * are stripped by each caller.
 */
export const PROMPT_UNSAFE_INVISIBLES =
  /[\u0080-\u009f\u200b-\u200d\u2028\u2029\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g;

/**
 * Truncate to at most `max` Unicode CODE POINTS (not UTF-16 code units). A cap
 * applied with `.slice` counts code units, so one landing mid-surrogate-pair
 * (e.g. an emoji \ud83c\udf89 = 2 units) leaves a lone surrogate that renders as `\ufffd`.
 * `Array.from` iterates by code point, so slicing it never splits a pair.
 */
function truncateCodePoints(str: string, max: number): string {
  const cp = Array.from(str);
  return cp.length > max ? cp.slice(0, max).join('') : str;
}

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
  const cleaned = name
    .replace(PROMPT_UNSAFE_INVISIBLES, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[[\]\r\n]/g, ' ');
  // Truncate on code-point boundaries so an emoji nick capped mid-pair can't
  // leave a lone surrogate (renders as `�`).
  return truncateCodePoints(cleaned, 64).trim() || 'unknown';
}

/**
 * Neutralize attacker-controlled text embedded inside a `"..."` prompt wrapper
 * (reply quotes, attachment filenames): strip C0/DEL control chars, the
 * wrapper's own quote/bracket delimiters, and the Unicode line/bidi controls
 * above, then cap the length. Shared so the reply-quote and filename paths
 * can't drift apart. On truncation a single-char ellipsis is appended (kept
 * within maxLen) so the agent can tell a quote/filename was cut rather than
 * silently ending mid-token.
 */
export function sanitizeQuotedText(text: string, maxLen: number): string {
  const cleaned = text
    .replace(PROMPT_UNSAFE_INVISIBLES, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/["[\]]/g, ' ');
  // Count/slice by CODE POINT, not UTF-16 unit, so a cap landing mid-surrogate-
  // pair can't leave a lone surrogate (`�`). On truncation keep maxLen-1 code
  // points + the single-char ellipsis, so the result stays within maxLen.
  const cp = Array.from(cleaned);
  return cp.length > maxLen ? cp.slice(0, maxLen - 1).join('') + '…' : cleaned;
}

export function sanitizePromptText(text: string): string {
  return (
    text
      .replace(PROMPT_UNSAFE_INVISIBLES, ' ')
      .replace(/^([ \t]*)\[([^\]\r\n]{1,64})\](:?)/gm, '$1$2$3')
      // Fold ASCII C0/DEL, including CR/LF/TAB, so attacker-controlled group
      // text cannot create prompt lines outside the adapter's sender attribution.
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
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
 * separators + bidi overrides (trojan-source). Length is capped generously
 * (1024) as defense-in-depth: well beyond any real path, but enough to stop a
 * pathological attacker filename from ballooning the prompt unboundedly.
 */
export function sanitizePromptPath(path: string): string {
  const cleaned = path
    .replace(PROMPT_UNSAFE_INVISIBLES, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, ' ');
  // Cap by code point so a path ending in an emoji can't be split mid-pair.
  return truncateCodePoints(cleaned, 1024);
}

/**
 * Neutralize attacker-controlled text before it is written to a single-line
 * stderr audit/diagnostic log. Caps to `maxLen` code points, renders ASCII
 * newlines as a visible `\n` escape (so a multi-line payload stays one readable
 * log line instead of collapsing to a space), then strips everything that could
 * forge or corrupt a log line: PROMPT_UNSAFE_INVISIBLES (the C1 block incl. NEL
 * U+0085, the Unicode line/paragraph separators U+2028/U+2029, and the bidi
 * override/isolate controls — all of which render as a line break or reorder
 * text) AND the C0/DEL controls (CR could overwrite the line, ESC could inject
 * ANSI/OSC). Shared by every audit-log site so the strip set can't drift apart.
 */
export function sanitizeLogText(text: string, maxLen: number): string {
  return (
    truncateCodePoints(text, maxLen)
      // Render real newlines visibly BEFORE the control strip, so the common
      // ASCII-newline case shows as `\n` rather than collapsing to a space.
      .replace(/\n/g, '\\n')
      .replace(PROMPT_UNSAFE_INVISIBLES, ' ')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
  );
}
