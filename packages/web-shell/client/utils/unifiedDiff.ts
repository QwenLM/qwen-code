// Cap the LCS table's memory: `dp` allocates (n+1) * (m+1) numbers, so an
// asymmetric edit (small n+m but large n*m) can still balloon into an
// enormous 2D array here. Callers that need a size gate on the raw payload
// (chars / total lines) apply their own before calling in — this only guards
// the LCS itself from allocating unbounded memory.
const MAX_DIFF_PRODUCT = 250_000;

/**
 * Non-diff outcomes are signalled with ASCII-safe, non-prose markers rather
 * than user-facing sentences. This module is deliberately import-free, so the
 * Web Shell `t()` catalog can never reach it — `formatRelativeTime.ts` threads
 * a translator in, but a translator returns prose whose first character the
 * diff grammar would then have to accept. A backslash-prefixed marker stays
 * under our control here and is still classified as a `header` by
 * {@link parseUnifiedDiff} (the same branch that handles git's
 * `\ No newline at end of file`), so neither marker is counted as a
 * context/add/del row and the `+N/-M` badge stays correct. The render boundary
 * ({@link localizeDiffNotice} in `DiffView`) swaps them for localized copy.
 */
export const DIFF_OMITTED_MARKER = '\\diff-omitted';
export const DIFF_TRAILING_NEWLINE_ADDED_MARKER =
  '\\diff-trailing-newline-added';
export const DIFF_TRAILING_NEWLINE_REMOVED_MARKER =
  '\\diff-trailing-newline-removed';
export const DIFF_CRLF_UNIFORM_MARKER = '\\diff-crlf-uniform';
/**
 * The negative half of the source-layer verdict. A builder that saw the source
 * text and refused to certify uniformity used to stay silent, and silence was
 * indistinguishable from "no builder ran" — so the renderer filled the gap by
 * voting on whichever rows the patch happened to show. A context window cannot
 * speak for the rest of the file, and rows cannot distinguish an unterminated
 * final line from an LF line inside a mixed file. The negative verdict removes
 * the gap: the row vote now only runs where nobody decided.
 */
export const DIFF_CRLF_MIXED_MARKER = '\\diff-crlf-mixed';

const CRLF_VERDICT_MARKERS = new Set([
  DIFF_CRLF_UNIFORM_MARKER,
  DIFF_CRLF_MIXED_MARKER,
]);

/**
 * Prefixes builder output with the source-layer verdict.
 *
 * Only pairs that actually contain a `\r` get one: an all-LF pair has no
 * line-ending question to answer, and stamping every diff would churn every
 * pinned builder-output expectation to say nothing.
 */
function withCrlfVerdict(
  rows: string,
  involvesCr: boolean,
  uniform: boolean,
): string {
  if (!involvesCr || !rows) return rows;
  return `${uniform ? DIFF_CRLF_UNIFORM_MARKER : DIFF_CRLF_MIXED_MARKER}\n${rows}`;
}

/**
 * Decided at the SOURCE layer, never from rendered patch text: a patch line
 * carries no marker distinguishing "unterminated final line" from "an LF
 * line inside a mixed-ending file", so any inference at the render boundary
 * certifies whole-file properties it cannot know. Here the raw text does
 * know. Uniform means: every line is terminated by `\r\n`, with the sole
 * allowed exception of a final line that has no terminator at all — a bare
 * `\n` anywhere (a line ending without its `\r`) breaks it.
 */
function isUniformCrlf(text: string): boolean {
  if (!text) return true;
  const segments = text.split('\n');
  const trailing = segments[segments.length - 1] === '';
  const body = trailing ? segments.slice(0, -1) : segments;
  for (let i = 0; i < body.length - 1; i++) {
    if (!body[i].endsWith('\r')) return false;
  }
  const lastLine = body[body.length - 1];
  // A blank last line here means the text ends with `\n\n` (or is a lone
  // `\n`): that final terminator carries no `\r`, so it is a bare LF like any
  // other and breaks uniformity. The loop above never inspects it — it walks
  // the interior lines only, and this one is the segment the trailing
  // newline terminated.
  if (lastLine === '') return false;
  if (lastLine.endsWith('\r')) return true;
  return !trailing;
}

type Translate = (
  key: string,
  vars?: Record<string, string | number>,
) => string;

/**
 * Resolves a complete marker-only preview, never individual parsed rows:
 * raw patches may contain identical marker text. All other previews are
 * returned unchanged.
 */
export function localizeDiffNotice(content: string, t: Translate): string {
  switch (content) {
    case DIFF_OMITTED_MARKER:
      return t('approval.diffOmitted');
    case DIFF_TRAILING_NEWLINE_ADDED_MARKER:
      return t('approval.trailingNewlineAdded');
    case DIFF_TRAILING_NEWLINE_REMOVED_MARKER:
      return t('approval.trailingNewlineRemoved');
    default:
      return content;
  }
}

function splitLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split('\n');
  // A trailing newline terminates the last line rather than starting an empty
  // one. Counting the segment after it inflates the +/- badge — a one-line new
  // file rendered as `+2/-0` with a phantom blank row — and the file bodies
  // `permissionUtils` sends always end with '\n'.
  return lines.length > 1 && lines[lines.length - 1] === ''
    ? lines.slice(0, -1)
    : lines;
}

export function buildUnifiedDiff(oldText: string, newText: string): string {
  // A pair whose only difference is the final line terminator has no rows to
  // show: `splitLines` drops the terminator from both sides, so the two bodies
  // are identical and every row this builder could emit renders the same text
  // in both columns — a `+1/-1` badge over a change the view cannot display.
  // The bounded builder answers this shape with a notice; the two producers of
  // one card must speak with one voice, so this one does too. Both emptiness
  // guards are load-bearing: `''.replace(/\r?\n$/, '')` equals
  // `'\n'.replace(/\r?\n$/, '')`, and `extractDiff` builds insertion previews
  // from `('', newText)`, where a sole blank line is real content.
  if (
    oldText.length > 0 &&
    newText.length > 0 &&
    oldText.endsWith('\n') !== newText.endsWith('\n') &&
    oldText.replace(/\r?\n$/, '') === newText.replace(/\r?\n$/, '')
  ) {
    return newText.endsWith('\n')
      ? DIFF_TRAILING_NEWLINE_ADDED_MARKER
      : DIFF_TRAILING_NEWLINE_REMOVED_MARKER;
  }
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);

  const n = oldLines.length;
  const m = newLines.length;
  const involvesCr = oldText.includes('\r') || newText.includes('\r');

  const crlfUniform =
    isUniformCrlf(oldText) && isUniformCrlf(newText) && involvesCr && n + m > 0;

  if (n * m > MAX_DIFF_PRODUCT) {
    const removed = oldLines.map((l) => (l ? `-${l}` : '-'));
    const added = newLines.map((l) => (l ? `+${l}` : '+'));
    const rows = [...removed, ...added].join('\n');
    return withCrlfVerdict(rows, involvesCr, crlfUniform);
  }

  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    Array(m + 1).fill(0),
  );
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i][j] =
        oldLines[i - 1] === newLines[j - 1]
          ? dp[i - 1][j - 1] + 1
          : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  const result: string[] = [];
  let i = n,
    j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      result.push(` ${oldLines[i - 1]}`);
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.push(`+${newLines[j - 1]}`);
      j--;
    } else {
      result.push(`-${oldLines[i - 1]}`);
      i--;
    }
  }

  const rows = result.reverse().join('\n');
  return withCrlfVerdict(rows, involvesCr, crlfUniform);
}

export function buildContextBoundedDiff(
  oldText: string,
  newText: string,
): string {
  const omitted = DIFF_OMITTED_MARKER;
  if (oldText.length + newText.length > 100_000) return omitted;
  if (oldText === newText) return '';
  if (
    oldText.length > 0 &&
    newText.length > 0 &&
    oldText.endsWith('\n') !== newText.endsWith('\n') &&
    oldText.replace(/\r?\n$/, '') === newText.replace(/\r?\n$/, '')
  ) {
    return newText.endsWith('\n')
      ? DIFF_TRAILING_NEWLINE_ADDED_MARKER
      : DIFF_TRAILING_NEWLINE_REMOVED_MARKER;
  }
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  const context = 3;
  let prefix = 0;
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix++;
  }
  if (prefix === oldLines.length && prefix === newLines.length) {
    // Identical line arrays over non-identical raw text means the only
    // difference is the final terminator — `splitLines` drops it from both
    // sides. `''` is this module's "nothing changed" verdict, so returning it
    // here certified a pending edit that does change the file as a no-op: for
    // `'a\r\n'` vs `'a\r'` (what `content.replace(/\n$/,'')` over a CRLF file
    // produces) the approval card rendered a path and no rows, and approving
    // it applied the edit blind. Report it as the terminator notice instead.
    return newText.endsWith('\n')
      ? DIFF_TRAILING_NEWLINE_ADDED_MARKER
      : DIFF_TRAILING_NEWLINE_REMOVED_MARKER;
  }
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - suffix - 1] ===
      newLines[newLines.length - suffix - 1]
  ) {
    suffix++;
  }
  const start = Math.max(0, prefix - context);
  const skippedSuffix = Math.max(0, suffix - context);
  if (
    (oldLines.length - skippedSuffix - start) *
      (newLines.length - skippedSuffix - start) >
    MAX_DIFF_PRODUCT
  ) {
    return omitted;
  }
  const inner = buildUnifiedDiff(
    oldLines
      .slice(start, oldLines.length - skippedSuffix)
      .map((line) => `${line}\n`)
      .join(''),
    newLines
      .slice(start, newLines.length - skippedSuffix)
      .map((line) => `${line}\n`)
      .join(''),
  ).split('\n');
  // The inner builder stamps its own CRLF verdict as the first row; pull it
  // out so it neither counts toward the @@ hunk arithmetic nor lands inside
  // a hunk body — the verdict is re-stamped below from the source layer.
  if (CRLF_VERDICT_MARKERS.has(inner[0])) {
    inner.shift();
  }
  const rows = inner;
  // The CRLF decision uses the ORIGINAL texts, not the windowed substring:
  // re-joining sliced rows appends a `\n` to the window's last line, which
  // would turn a genuinely unterminated final line into a bare-LF one and
  // flip the verdict. The inner builder's own stamp (if any) is dropped and
  // the decision is re-stamped from the source layer.
  const involvesCr = oldText.includes('\r') || newText.includes('\r');
  const crlfUniform =
    isUniformCrlf(oldText) && isUniformCrlf(newText) && involvesCr;
  const ranges: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].startsWith(' ')) continue;
    const from = Math.max(0, i - context);
    const to = Math.min(rows.length, i + context + 1);
    const previous = ranges.at(-1);
    if (previous && from <= previous.end) previous.end = to;
    else ranges.push({ start: from, end: to });
  }
  const result: string[] = [];
  let oldLine = start + 1;
  let newLine = start + 1;
  let cursor = 0;
  for (const range of ranges) {
    while (cursor < range.start) {
      oldLine++;
      newLine++;
      cursor++;
    }
    const hunk = rows.slice(range.start, range.end);
    const oldCount = hunk.filter((row) => !row.startsWith('+')).length;
    const newCount = hunk.filter((row) => !row.startsWith('-')).length;
    result.push(
      `@@ -${oldCount ? oldLine : oldLine - 1},${oldCount} +${newCount ? newLine : newLine - 1},${newCount} @@`,
      ...hunk,
    );
    if (result.length > 1_000 || result.join('\n').length > 100_000) {
      return omitted;
    }
    oldLine += oldCount;
    newLine += newCount;
    cursor = range.end;
  }
  const output = result.join('\n');
  return withCrlfVerdict(output, involvesCr, crlfUniform);
}

interface UnifiedDiffLine {
  type: 'add' | 'del' | 'context' | 'header';
  content: string;
  oldLine?: number;
  newLine?: number;
}

/**
 * One side's row terminators, judged by the rule {@link isUniformCrlf} applies
 * to the source text: every line closed by `\r\n`, with at most a final line
 * that has no terminator at all. A patch can only justify that exception for
 * its final row when git's `\ No newline at end of file` notice says the row
 * really is an unterminated last line — otherwise an unterminated row is an
 * LF line inside a mixed file, which breaks uniformity. An empty side is
 * vacuously uniform: a pure insertion says nothing about the old side and must
 * not be demoted for it.
 */
function votesUniform(votes: boolean[], notice: boolean): boolean {
  if (votes.length === 0) return true;
  const unterminated = votes.filter((terminated) => !terminated).length;
  if (unterminated === 0) return true;
  return notice && unterminated === 1 && !votes[votes.length - 1];
}

export function parseUnifiedDiff(diff: string): {
  lines: UnifiedDiffLine[];
  additions: number;
  deletions: number;
  crlfUniform: boolean;
} {
  let additions = 0;
  let deletions = 0;
  let crlfUniform = false;
  const lines: UnifiedDiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;
  let oldRemaining = 0;
  let newRemaining = 0;
  const hunkHeader = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  const diffLines = diff.split('\n');
  const hasHunks = diffLines.some((line) => hunkHeader.test(line));
  // Raw patches (a `fileDiff` built by jsdiff and shipped through
  // `getRawFileDiff`) never carry a verdict marker, because no builder saw the
  // source text. The information is still recoverable from the rows
  // themselves: a `\r\n` file keeps its `\r` on every content row, so a patch
  // whose content rows all end with `\r` is uniform by the same definition the
  // builders use.
  //
  // That recovery is a fallback, not a method. It runs only when no verdict
  // was seen, because a builder that decided "mixed" says so now — silence
  // used to mean both "mixed" and "no builder", and the renderer resolved the
  // ambiguity by voting, which certified whole-file properties from whatever
  // rows the context window happened to include. Votes are collected per side:
  // `isUniformCrlf` allows one unterminated final line, and only git's
  // `\ No newline at end of file` notice says a row really is that line rather
  // than an LF line in a mixed file.
  let noNewlineNotice = false;
  let verdictSeen = false;
  const oldVotes: boolean[] = [];
  const newVotes: boolean[] = [];
  // `DiffView` slices by `maxLength`, which can cut the final row mid-way. A
  // row that still ends with `\r` kept its terminator, so only an unmarked
  // tail is withheld from the vote — excluding the tail unconditionally threw
  // away the vote of every single-row patch, which has no other row to be
  // judged by.
  const lastRowTerminated = diff.endsWith('\n') || diff.endsWith('\r');

  for (let index = 0; index < diffLines.length; index++) {
    const line = diffLines[index];
    const match = line.match(hunkHeader);
    let contentRow = false;
    if (match) {
      oldLine = parseInt(match[1], 10);
      oldRemaining = match[2] === undefined ? 1 : parseInt(match[2], 10);
      newLine = parseInt(match[3], 10);
      newRemaining = match[4] === undefined ? 1 : parseInt(match[4], 10);
      lines.push({ type: 'header', content: line });
    } else if (line.startsWith('\\')) {
      // Read the notice off the row itself rather than substring-matching the
      // whole patch: a content row is free to contain that text, and a diff
      // cannot grant itself the allowance by quoting it.
      if (line.startsWith('\\ No newline at end of file')) {
        noNewlineNotice = true;
      }
      if (line === DIFF_CRLF_UNIFORM_MARKER) {
        crlfUniform = true;
        verdictSeen = true;
      } else if (line === DIFF_CRLF_MIXED_MARKER) {
        verdictSeen = true;
      }
      lines.push({ type: 'header', content: line });
    } else if ((!hasHunks || newRemaining > 0) && line.startsWith('+')) {
      additions++;
      lines.push({ type: 'add', content: line.slice(1), newLine });
      newLine++;
      if (hasHunks) newRemaining--;
      contentRow = true;
    } else if ((!hasHunks || oldRemaining > 0) && line.startsWith('-')) {
      deletions++;
      lines.push({ type: 'del', content: line.slice(1), oldLine });
      oldLine++;
      if (hasHunks) oldRemaining--;
      contentRow = true;
    } else if (
      (!hasHunks || (oldRemaining > 0 && newRemaining > 0)) &&
      line.startsWith(' ')
    ) {
      lines.push({
        type: 'context',
        content: line.slice(1),
        oldLine,
        newLine,
      });
      oldLine++;
      newLine++;
      if (hasHunks) {
        oldRemaining--;
        newRemaining--;
      }
      contentRow = true;
    } else {
      lines.push({ type: 'header', content: line });
    }
    if (contentRow && (index < diffLines.length - 1 || lastRowTerminated)) {
      const terminated = line.endsWith('\r');
      const row = lines[lines.length - 1];
      if (row.type !== 'add') oldVotes.push(terminated);
      if (row.type !== 'del') newVotes.push(terminated);
    }
  }

  if (!verdictSeen) {
    crlfUniform =
      oldVotes.length + newVotes.length > 0 &&
      votesUniform(oldVotes, noNewlineNotice) &&
      votesUniform(newVotes, noNewlineNotice);
  }

  return { lines, additions, deletions, crlfUniform };
}
