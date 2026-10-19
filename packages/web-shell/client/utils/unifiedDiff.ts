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
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);

  const n = oldLines.length;
  const m = newLines.length;

  const crlfUniform =
    isUniformCrlf(oldText) &&
    isUniformCrlf(newText) &&
    (oldText.includes('\r') || newText.includes('\r')) &&
    n + m > 0;

  if (n * m > MAX_DIFF_PRODUCT) {
    const removed = oldLines.map((l) => (l ? `-${l}` : '-'));
    const added = newLines.map((l) => (l ? `+${l}` : '+'));
    const rows = [...removed, ...added].join('\n');
    return crlfUniform ? `${DIFF_CRLF_UNIFORM_MARKER}\n${rows}` : rows;
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
  return crlfUniform ? `${DIFF_CRLF_UNIFORM_MARKER}\n${rows}` : rows;
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
  // The inner builder stamps its own CRLF marker as the first row; pull it
  // out so it neither counts toward the @@ hunk arithmetic nor lands inside
  // a hunk body — the verdict is re-stamped below from the source layer.
  if (inner[0] === DIFF_CRLF_UNIFORM_MARKER) {
    inner.shift();
  }
  const rows = inner;
  // The CRLF decision uses the ORIGINAL texts, not the windowed substring:
  // re-joining sliced rows appends a `\n` to the window's last line, which
  // would turn a genuinely unterminated final line into a bare-LF one and
  // flip the verdict. The inner builder's own stamp (if any) is dropped and
  // the decision is re-stamped from the source layer.
  const crlfUniform =
    isUniformCrlf(oldText) &&
    isUniformCrlf(newText) &&
    (oldText.includes('\r') || newText.includes('\r'));
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
  return crlfUniform ? `${DIFF_CRLF_UNIFORM_MARKER}\n${output}` : output;
}

interface UnifiedDiffLine {
  type: 'add' | 'del' | 'context' | 'header';
  content: string;
  oldLine?: number;
  newLine?: number;
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
  // `getRawFileDiff`) never carry `DIFF_CRLF_UNIFORM_MARKER`, because no
  // builder saw the source text. The information is still recoverable from
  // the rows themselves: a `\r\n` file keeps its `\r` on every content row,
  // so a patch whose content rows all end with `\r` is uniform by the same
  // definition the builders use. Collect the terminators and decide at the
  // end, excluding a possibly-truncated trailing row (`DiffView` slices by
  // `maxLength`) so truncation cannot turn a uniform file into a mixed one.
  const endsWithNewline = diff.endsWith('\n');
  const contentTerminators: boolean[] = [];

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
      if (line === DIFF_CRLF_UNIFORM_MARKER) crlfUniform = true;
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
    if (contentRow && (endsWithNewline || index < diffLines.length - 1)) {
      contentTerminators.push(line.endsWith('\r'));
    }
  }

  if (
    !crlfUniform &&
    contentTerminators.length > 0 &&
    contentTerminators.every((terminated) => terminated)
  ) {
    crlfUniform = true;
  }

  return { lines, additions, deletions, crlfUniform };
}
