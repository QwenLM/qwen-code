/**
 * Strip a leading `export const meta = { ... }` declaration from a workflow
 * script. Required because Node's vm script mode rejects ES module syntax.
 *
 * P1 does not use meta semantically; it is removed so that Claude-Code-trained
 * models whose first line is `export const meta = {...}` do not produce a
 * SyntaxError at sandbox parse time.
 *
 * Matches only at the start of a (optionally whitespace-prefixed) line; a
 * naked `const meta = ...` later in the script is left intact. Single-quote,
 * double-quote, and template-literal contents inside the meta object are
 * treated opaquely (their `{` / `}` characters are not counted as braces).
 * Template-literal `${...}` substitutions that contain `{` or `}` are not
 * supported — model-authored `meta` should avoid them.
 */
export function stripExportMeta(source: string): string {
  const re = /^\s*export\s+const\s+meta\s*=\s*\{/m;
  const match = re.exec(source);
  if (!match) return source;
  const exportIdx = match.index;
  const startBrace = source.indexOf('{', exportIdx);
  let depth = 1;
  let i = startBrace + 1;
  while (i < source.length && depth > 0) {
    const ch = source[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      const q = ch;
      i++;
      while (i < source.length && source[i] !== q) {
        if (source[i] === '\\') i++; // skip escaped char
        i++;
      }
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
    }
    i++;
  }
  // Skip trailing whitespace and an optional semicolon.
  while (i < source.length && /[\s;]/.test(source[i]!)) i++;
  return source.slice(0, exportIdx) + source.slice(i);
}
