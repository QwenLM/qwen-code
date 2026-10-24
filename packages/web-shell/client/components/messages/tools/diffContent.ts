import { escapePreviewText } from '../../../adapters/transcriptAdapter';
import { sanitizeControlChars } from '../toolFormatting';

// Both diff renderers mark invisible characters, so a bidi override or a
// zero-width joiner cannot hide what a diff row says. This is the class the
// decoration layer uses: it also covers the structural characters a line can
// carry (\t, \r), because a decoration rewrites one row of an existing
// document and those characters are rendered as text there anyway.
export const DIFF_INVISIBLE_CHARACTERS =
  // eslint-disable-next-line no-control-regex -- This renderer makes control characters visible.
  /([\x00-\x08\x0b-\x1f\x7f-\x9f\u2028\u2029\p{Cf}])/gu;

// The narrow merge layout cannot decorate the deletion side, so it neutralises
// the same characters in the text it hands CodeMirror as a document. That
// consumer splits on line endings, so a terminator must survive verbatim:
// escaping CR would append a literal `\r` to every row of a CRLF file (the
// row would read `alpha\r` for a line whose content is `alpha`), which buries
// exactly the line-ending signal the CRLF marker exists to surface.
export const DIFF_MERGE_INVISIBLE_CHARACTERS =
  // eslint-disable-next-line no-control-regex -- This renderer makes control characters visible.
  /([\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u2028\u2029\p{Cf}])/gu;

export function escapeDiffContent(content: string): string {
  return escapePreviewText(sanitizeControlChars(content));
}

export function escapeInvisibleForMerge(content: string): string {
  // The merge view compares these documents to decide what changed, so the
  // transform has to be injective: escape the escape itself before inserting
  // any. Without this, a real U+200B and the four-character text `\u200b`
  // collapse to the same string, the merge reports "unchanged" for a file
  // that did change, and resizing across the wide/narrow breakpoint flips
  // the verdict because the wide branch compares raw text.
  return content
    .replace(/\\/g, '\\\\')
    .replace(DIFF_MERGE_INVISIBLE_CHARACTERS, (character) =>
      escapeDiffContent(character),
    );
}

// Non-global on purpose: `test()` on a global regex advances `lastIndex`, and
// `DIFF_MERGE_INVISIBLE_CHARACTERS` is shared with `MatchDecorator`, which
// mutates that state on its own schedule.
const MERGE_INVISIBLE_PROBE = new RegExp(
  DIFF_MERGE_INVISIBLE_CHARACTERS.source,
  'u',
);

/**
 * The pair-level entry point, and the only one the merge view should use.
 *
 * `escapeInvisibleForMerge` is injective but not free: doubling a backslash
 * rewrites text that has no invisible character in it, so applying it to every
 * file renders `/\\d+/` for a regex whose source is `/\d+/` — content that is
 * not in the file, inside the surface whose job is to show the file. The
 * transform is only *needed* when there is a character to neutralise, so the
 * decision belongs to the pair: if neither side carries one, hand both sides
 * through untouched and the merge view compares the real bytes.
 *
 * The decision must be taken over both texts at once. Deciding per side lets
 * one side's raw `\u200b` literal meet the other side's escaped real U+200B and
 * compare equal, which is the original "certifies unchanged" defect wearing the
 * opposite mask. A side without an invisible character is still passed through
 * the transform when its partner has one, so both documents stay in the same
 * comparison space.
 */
export function escapePairForMerge(
  oldText: string,
  newText: string,
): { oldText: string; newText: string } {
  const needsNeutralizing =
    MERGE_INVISIBLE_PROBE.test(oldText) || MERGE_INVISIBLE_PROBE.test(newText);
  if (!needsNeutralizing) return { oldText, newText };
  return {
    oldText: escapeInvisibleForMerge(oldText),
    newText: escapeInvisibleForMerge(newText),
  };
}
