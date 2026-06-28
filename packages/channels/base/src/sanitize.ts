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
 * tag: strip the bracket/newline delimiters (and the Unicode line/bidi controls
 * above) that would let a crafted nickname break out of the tag or inject extra
 * lines, then cap the length. Shared by ChannelBase group attribution and
 * adapters that self-prefix (e.g. QQ), so the rules stay identical everywhere.
 */
export function sanitizeSenderName(name: string): string {
  return name
    .replace(PROMPT_UNSAFE_INVISIBLES, ' ')
    .replace(/[[\]\r\n]/g, ' ')
    .slice(0, 64);
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
