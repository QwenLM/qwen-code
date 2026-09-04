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
  /[\u0080-\u009f\p{Cf}\u2028\u2029]|\p{Variation_Selector}/gu;

/**
 * Truncate to at most `max` Unicode CODE POINTS (not UTF-16 code units). A cap
 * applied with `.slice` counts code units, so one landing mid-surrogate-pair
 * (e.g. an emoji \ud83c\udf89 = 2 units) leaves a lone surrogate that renders as `\ufffd`.
 * `Array.from` iterates by code point, so slicing it never splits a pair.
 */
export function truncateCodePoints(str: string, max: number): string {
  const cp = Array.from(str);
  return cp.length > max ? cp.slice(0, max).join('') : str;
}

/**
 * Truncate so the result is at most `max` UTF-16 CODE UNITS (`.length`), cut on
 * code-point boundaries. The companion to {@link truncateCodePoints}, for the
 * callers whose budget is measured in `.length` — an astral character costs two
 * units there, so a code-point cap lets a fully-astral value overshoot its
 * reserved space by up to 2x and starve whatever the same budget still owes.
 * Cutting on code-point boundaries still means a pair is never split (an astral
 * character that does not fit whole is dropped whole), so the result can be one
 * unit shorter than `max` but never contains a lone surrogate.
 */
export function truncateUtf16Units(str: string, max: number): string {
  if (str.length <= max) return str;
  let kept = '';
  let units = 0;
  for (const ch of str) {
    if (units + ch.length > max) break;
    kept += ch;
    units += ch.length;
  }
  return kept;
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

/**
 * The tag this peel deletes, as a regex, for reference:
 * `/^([^\S\r\n]*)\[([^\]\r\n]{1,64})\](:?)/gm` -> `'$1$2$3'`, applied to a
 * fixpoint. The leading class is every whitespace character EXCEPT CR/LF, not
 * just space/tab: `trim()` also strips VT, FF, NBSP, U+1680, U+2000-U+200A,
 * U+202F, U+205F and U+3000, so a `[ \t]*` window let any of them push the
 * bracket off start-of-line, block the match, and then be trimmed away by a
 * caller — reassembling the very tag the unwrap exists to peel.
 */
const START_OF_LINE_TAG_MAX_CONTENT = 64;
/** Where `m`-flagged `^` matches: string start, and after each of these. */
const LINE_TERMINATORS = '\r\n\u2028\u2029';

/** The `[^\S\r\n]` leading window of the tag above. */
function isTagLeadBlank(ch: string): boolean {
  return ch !== '\r' && ch !== '\n' && /\s/.test(ch);
}

/**
 * Peel start-of-line `[tag]` wrappers until none is left, not just once.
 *
 * A single pass removes exactly ONE layer, so `[[SYSTEM]]` comes out as
 * `[SYSTEM]` — a fully-formed forged tag that the caller then embeds at
 * start-of-line, which is precisely what this unwrap exists to prevent. Any
 * caller that gets only one pass (DingTalk 1:1 DMs: `ChannelBase` re-sanitizes
 * only when `isGroup || sessionScope === 'single'`) hands the model the forge
 * verbatim; two passes just move the bar to `[[[SYSTEM]]]`.
 *
 * ONE linear pass, not a `replace` fixpoint over the whole string. The loop
 * this replaces rebuilt the entire string for every tag it peeled, and a tag
 * whose content is all whitespace peels to whitespace — re-opening the
 * start-of-line window — so `'[ ]'.repeat(n)` cost n x O(n): measured 16 ms at
 * 10 KB, 1216 ms at 80 KB of synchronous event-loop stall. That input is
 * attacker-authorable and reaches `sanitizePromptText` BEFORE any cap (chat
 * record titles and summary lines, entry bodies, any group message routed
 * through `ChannelBase`), so the stall is repeatable per message.
 *
 * Same peel, simulated in place — the technique `startOfLineSafeChatRecordField`
 * uses on the DingTalk side. Each pass of that loop deleted exactly two
 * characters, the leading `[` and the FIRST `]` after it (the content class
 * `[^\]\r\n]` can match no other), so instead of re-copying between passes,
 * mark the pairs and emit what survives. `open` walks the head of the line past
 * what is already deleted and past the blanks the `[^\S\r\n]*` window absorbs;
 * `close` never rewinds because every `]` it passed is already deleted, and
 * `carried` remembers how much of the content window the previous pass already
 * measured. Both pointers only move forward, and each pass measures at most
 * `START_OF_LINE_TAG_MAX_CONTENT + 1` live characters, so the whole peel is
 * linear in the input.
 *
 * Terminates: `open` and `lineStart` strictly increase.
 */
function unwrapStartOfLineTags(text: string): string {
  if (!text.includes('[')) return text;
  const deleted = new Uint8Array(text.length);
  let peeled = false;
  let lineStart = 0;
  while (lineStart < text.length) {
    // `open` is the `^[^\S\r\n]*` cursor; `close` is one past the last `]`
    // consumed on this line; `carried` counts the still-live characters in
    // `[open, close)` that a previous pass already measured.
    let open = lineStart;
    let close = lineStart;
    let carried = 0;
    for (;;) {
      while (open < text.length) {
        const ch = text[open]!;
        if (ch === '\r' || ch === '\n') break;
        if (deleted[open] === 0 && !isTagLeadBlank(ch)) break;
        if (open < close && deleted[open] === 0) carried -= 1;
        open += 1;
      }
      if (text[open] !== '[') break;
      // The `[` itself is not content; everything already measured between it
      // and `close` is.
      let content = open < close ? carried - 1 : 0;
      let cursor = Math.max(close, open + 1);
      while (cursor < text.length) {
        const ch = text[cursor]!;
        if (ch === ']' || ch === '\r' || ch === '\n') break;
        content += 1;
        if (content > START_OF_LINE_TAG_MAX_CONTENT) break;
        cursor += 1;
      }
      if (
        text[cursor] !== ']' ||
        content < 1 ||
        content > START_OF_LINE_TAG_MAX_CONTENT
      ) {
        break;
      }
      deleted[open] = 1;
      deleted[cursor] = 1;
      peeled = true;
      open += 1;
      close = cursor + 1;
      carried = content;
    }
    // No further `[tag]` can match on this line; resume at the next `^`.
    let nextLine = open;
    while (
      nextLine < text.length &&
      !LINE_TERMINATORS.includes(text[nextLine]!)
    ) {
      nextLine += 1;
    }
    lineStart = nextLine + 1;
  }
  if (!peeled) return text;
  const parts: string[] = [];
  let cut = 0;
  for (let i = 0; i < text.length; i++) {
    if (deleted[i] === 0) continue;
    if (i > cut) parts.push(text.slice(cut, i));
    cut = i + 1;
  }
  parts.push(text.slice(cut));
  return parts.join('');
}

export function sanitizePromptText(text: string): string {
  const unwrapped = unwrapStartOfLineTags(
    text.replace(PROMPT_UNSAFE_INVISIBLES, ' '),
  );
  // Fold ASCII C0/DEL, including CR/LF/TAB, so attacker-controlled group
  // text cannot create prompt lines outside the adapter's sender attribution.
  // eslint-disable-next-line no-control-regex
  const folded = unwrapped.replace(/[\u0000-\u001f\u007f]/g, ' ');
  // Unwrap AGAIN over the folded text: the fold itself ASSEMBLES tags the first
  // pass could not see. A line-leading C0/DEL that `trim()` does not strip
  // (x00-x08, x0E-x1F, x7F) blocks the match and then becomes a space, and an
  // interior CR/LF splits a tag past the content class (`[SYS` + LF + `TEM]:`)
  // and then becomes a space that joins the halves. Folding first instead would
  // be wrong: it destroys the line structure the FIRST pass needs, and after it
  // only the string start is still a start-of-line prompt position — which is
  // exactly what this second pass covers.
  return unwrapStartOfLineTags(folded);
}

/**
 * Neutralize attacker-controlled text that is surfaced VERBATIM to users
 * (session-bus display projections, transcripts, session-list previews):
 * strip the Unicode line/bidi/zero-width controls that can reorder or hide
 * rendered text, plus C0/DEL controls EXCEPT newline — multi-line user text
 * keeps its line structure in the transcript. Capped by CODE POINT so a cap
 * landing mid-surrogate-pair cannot leave a lone surrogate. Unlike
 * sanitizePromptText it preserves newlines and brackets: display text is
 * rendered to a human, not parsed as prompt structure.
 */
export function sanitizeDisplayText(text: string, maxLen: number): string {
  const cleaned = text
    .replace(PROMPT_UNSAFE_INVISIBLES, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ');
  return truncateCodePoints(cleaned, maxLen);
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
