/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Parse a unified diff and partition it into review chunks.
//
// Why this exists: /review used to hand each review agent the diff *command*
// (`git diff main...HEAD`) and let the agent run it. Shell tool output is
// capped at `ShellTool.maxOutputChars` (30 000) and split head-1/5 / tail-4/5,
// so on a large PR every agent saw a few hundred lines off the top of the
// first file plus the tail of the last file, and nothing in between. The rest
// of the diff was replaced by a `[CONTENT TRUNCATED]` marker. Ten agents all
// read the same visible sliver; coverage did not grow with the number of
// agents.
//
// Instead the diff is written to a file (`read_file` paginates by
// offset/limit and is exempt from the char cap) and partitioned here into
// contiguous line ranges. Each agent is handed one range and is accountable
// for it. The chunks tile the diff exactly, so the orchestrator can assert
// that every line was assigned to some agent.

import { unquoteCStylePath } from '@qwen-code/qwen-code-core';

/** A single `@@` hunk. All line numbers are 1-based and inclusive. */
export interface DiffHunk {
  /** Range within the diff FILE (what `read_file` offset/limit addresses). */
  diffStart: number;
  diffEnd: number;
  /** Range within the post-change ("+") side of the source file. */
  newStart: number;
  newEnd: number;
  /**
   * How many lines the hunk occupies on the new side. Zero for a pure deletion
   * (`@@ -3,4 +2,0 @@`): the range is then empty and no RIGHT-side inline
   * comment can be anchored inside it. GitHub answers such an anchor with a 422
   * that sinks the entire review.
   */
  newCount: number;
}

/**
 * What kind of code a path holds.
 *
 * The distinction drives how much reviewer attention the file is worth. Across
 * the last 40 merged PRs in this repo the median diff is 41% test code and a
 * third of PRs are more than half tests, so a topology chosen from raw diff
 * size spends most of its reviewers on the least risky lines.
 */
export type PathKind = 'source' | 'test' | 'generated' | 'docs';

const TEST_RE =
  /(^|\/)(__tests__|__snapshots__|__mocks__|tests?|spec|integration-tests|e2e)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py|rb)$|(^|\/)test_[^/]+\.py$|(^|\/)src\/test\//;

const GENERATED_RE =
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lock(b)?|Cargo\.lock|go\.sum|poetry\.lock|Gemfile\.lock|composer\.lock|NOTICES\.txt)$|\.snap$|\.min\.(js|css)$|(^|\/)(dist|build|vendor|node_modules)\//;

/**
 * Prose: a documentation file extension, either under a documentation
 * directory at any depth or at the repository root.
 *
 * Both halves matter. A bare directory match calls `website/src/App.tsx`
 * documentation, and it is executable code. A root-only match calls
 * `packages/cua-driver/docs/tool-output-format.md` source, and it is prose.
 *
 * Markdown *inside a source tree* stays `source`: this repo's bundled skill
 * prompts are `packages/core/src/skills/**\/SKILL.md`, and they are executable
 * behaviour. Only the topology gate cares — chunk agents cover every line
 * either way.
 */
const DOCS_EXT = String.raw`\.(md|mdx|rst|txt|adoc)$`;
const DOCS_RE = new RegExp(
  `(^|/)(docs|doc|documentation|website)/.*${DOCS_EXT}` + `|^[^/]+${DOCS_EXT}`,
);

/**
 * Classify a repo-relative path. Order matters: a generated snapshot under a
 * `__snapshots__/` directory is generated, not a test worth reading.
 */
export function classifyPath(path: string): PathKind {
  if (GENERATED_RE.test(path)) return 'generated';
  if (TEST_RE.test(path)) return 'test';
  if (DOCS_RE.test(path)) return 'docs';
  return 'source';
}

/** One file's section of the diff, from `diff --git` to the next one. */
export interface DiffFile {
  /** New-side path, or the old path for a deletion. */
  path: string;
  kind: PathKind;
  /** Range within the diff FILE, covering header + all hunks. */
  diffStart: number;
  diffEnd: number;
  hunks: DiffHunk[];
  /**
   * New-side line ranges the PR actually **wrote** — the `+` lines, coalesced.
   *
   * Distinct from `hunks`, which also span the three context lines git prints
   * around every change. Telling a whole-file agent that a hunk's whole range
   * is "changed" would have it treat six untouched lines as new and report
   * defects that predate the PR. Anchor validation wants `hunks`; deciding
   * what is new wants this.
   */
  addedRanges: Array<{ start: number; end: number }>;
  addedLines: number;
  removedLines: number;
  /** True for `Binary files ... differ` sections (no hunks to review). */
  binary: boolean;
}

/** A contiguous slice of the diff file assigned to exactly one agent. */
export interface DiffChunk {
  /** 1-based, stable across a run. Used as the agent's coverage receipt id. */
  id: number;
  /** Range within the diff FILE, 1-based inclusive. */
  startLine: number;
  endLine: number;
  lines: number;
  /** Characters in the range. Above `READ_FILE_CHAR_CAP` one read truncates. */
  chars: number;
  /**
   * Longest single line in the range.
   *
   * Paging recovers a chunk that is merely long, because `read_file` takes a
   * line `offset`. It cannot recover a single *line* longer than the read cap:
   * every page starts at a line boundary, so the tail of that line is
   * unreachable. Such a chunk cannot honestly be receipted as fully reviewed.
   */
  maxLineChars: number;
  /**
   * True when this chunk is a single hunk that exceeds `maxChunkLines` or
   * `MAX_CHUNK_CHARS` and offered no safe interior boundary to split on. Such
   * a chunk stands alone: cutting it anywhere else would slice a function in
   * half, which is the failure mode chunking exists to prevent. An oversized
   * chunk may exceed one read's worth of characters, so its agent must page.
   */
  oversized: boolean;
  /** Which source files (and which of their lines) this chunk covers. */
  files: Array<{ path: string; newStart: number; newEnd: number }>;
}

export interface DiffPlan {
  diffLines: number;
  diffChars: number;
  /**
   * Diff lines belonging to `source` files. This — not `diffLines` — is what
   * the review topology is chosen from: a change of 150 production lines that
   * ships 800 lines of new tests carries the review risk of a small change,
   * and deserves the many-lenses treatment rather than being carved into
   * territories where most territories are test code.
   */
  srcDiffLines: number;
  testDiffLines: number;
  generatedDiffLines: number;
  docsDiffLines: number;
  files: DiffFile[];
  chunks: DiffChunk[];
}

/** Default target size of a chunk, in diff lines. */
export const DEFAULT_MAX_CHUNK_LINES = 400;

/**
 * Hard ceiling on a chunk's size in characters.
 *
 * `read_file` truncates a single read at `truncateToolOutputThreshold`
 * (default 25 000 chars) and reports `isTruncated`. A chunk agent is told to
 * read its range in one call, so a chunk above that ceiling would come back
 * silently short — reintroducing, per-chunk, exactly the blind spot the plan
 * exists to remove. 400 lines of ordinary source stays near 16 000 chars, but
 * one minified or long-line file would blow past 25 000, so bound both.
 */
export const MAX_CHUNK_CHARS = 20_000;

/**
 * What one `read_file` call returns before it truncates and sets `isTruncated`
 * (`Config.getTruncateToolOutputThreshold()`, default 25 000).
 */
export const READ_FILE_CHAR_CAP = 25_000;

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Unquote a diff path token.
 *
 * Unquoting must decode octal escapes as **bytes** and UTF-8-decode them
 * together: `\346\226\207` is one character (文), not three. Stripping the
 * backslashes instead yields `346226207`, and every downstream use of the path
 * — `git show`, the heaviness metrics, the filename an agent is told it is
 * reviewing — then refers to a file that does not exist.
 */
function unquote(raw: string): string {
  return unquoteCStylePath(raw.trim());
}

/** Drop git's `a/` / `b/` decoration. `fetch-pr` pins those prefixes. */
function stripPrefix(p: string): string {
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}

/** Unquote then de-prefix a `diff --git` / `---` / `+++` path token. */
function cleanPath(raw: string): string {
  return stripPrefix(unquote(raw));
}

/** Read a C-quoted token starting at `i`; returns the token and the next index. */
function readQuoted(s: string, i: number): [string, number] | null {
  if (s[i] !== '"') return null;
  let j = i + 1;
  while (j < s.length) {
    if (s[j] === '\\') {
      j += 2;
      continue;
    }
    if (s[j] === '"') return [s.slice(i, j + 1), j + 1];
    j++;
  }
  return null;
}

/**
 * Split the two path tokens out of a `diff --git <old> <new>` line.
 *
 * Git separates them with a space and does **not** quote a path merely because
 * it contains one, so `diff --git a/my file b/my file` is genuinely ambiguous
 * to a greedy regex — which lands on `space.png` for `a/img with space.png`.
 * Usually the `---`/`+++` headers disambiguate, but a binary or mode-only
 * section has neither.
 *
 * For the overwhelmingly common case — no rename, pinned `a/`/`b/` prefixes —
 * both paths are the *same string*, so the split point is arithmetic rather
 * than guessed: `a/P b/P` has length `2·|P| + 5`.
 */
function splitHeaderPaths(rest: string): [string, string] | null {
  if (rest.startsWith('"')) {
    const first = readQuoted(rest, 0);
    if (!first || rest[first[1]] !== ' ') return null;
    const after = first[1] + 1;
    const second =
      rest[after] === '"'
        ? readQuoted(rest, after)
        : ([rest.slice(after), rest.length] as [string, number]);
    return second ? [first[0], second[0]] : null;
  }
  // Only the new side is quoted (e.g. a rename into a non-ASCII name).
  const q = rest.indexOf(' "');
  if (q > 0 && rest.endsWith('"')) return [rest.slice(0, q), rest.slice(q + 1)];

  // Neither quoted: exploit `old === new` for a non-rename.
  const n = rest.length;
  if (n >= 5 && (n - 5) % 2 === 0) {
    const len = (n - 5) / 2;
    const old = rest.slice(0, 2 + len);
    const neu = rest.slice(3 + len);
    if (
      old.startsWith('a/') &&
      neu.startsWith('b/') &&
      rest[2 + len] === ' ' &&
      old.slice(2) === neu.slice(2)
    ) {
      return [old, neu];
    }
  }
  // A rename whose two paths differ. `+++` / `rename to` will refine this;
  // the last ` b/` is the best guess a header alone can offer.
  const idx = rest.lastIndexOf(' b/');
  if (idx > 0) return [rest.slice(0, idx), rest.slice(idx + 1)];
  return null;
}

/**
 * Parse a unified diff into per-file sections and hunks.
 *
 * The returned sections tile `[1, diffLines]` exactly — every line of the
 * diff belongs to exactly one file section. That invariant is what lets
 * `planChunks` guarantee full coverage.
 */
export function parseDiff(diffText: string): {
  files: DiffFile[];
  diffLines: number;
} {
  // A trailing newline yields a final empty element; the diff's last real
  // line is the one before it. Treat the file as having no trailing blank.
  const lines = diffText.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const total = lines.length;

  const files: DiffFile[] = [];
  let cur: DiffFile | null = null;
  let curHunk: DiffHunk | null = null;
  let oldPath = '';
  /** New-side line number of the next body line of the current hunk. */
  let newCursor = 0;

  const noteAdded = (f: DiffFile, line: number) => {
    const last = f.addedRanges[f.addedRanges.length - 1];
    if (last && last.end === line - 1) last.end = line;
    else f.addedRanges.push({ start: line, end: line });
  };

  const closeHunk = (endLine: number) => {
    if (curHunk) {
      curHunk.diffEnd = endLine;
      curHunk = null;
    }
  };
  const closeFile = (endLine: number) => {
    if (cur) {
      closeHunk(endLine);
      cur.diffEnd = endLine;
      // Binary and mode-only sections carry no `+++` header, so classify here
      // as well; for the common case this just re-confirms what `+++` set.
      cur.kind = classifyPath(cur.path);
      files.push(cur);
      cur = null;
    }
  };

  for (let i = 0; i < total; i++) {
    const line = lines[i];
    const n = i + 1; // 1-based line number within the diff file

    if (line.startsWith('diff --git ')) {
      closeFile(n - 1);
      oldPath = '';
      // Path is refined below from `+++ b/...` / `rename to ...` when
      // present; this header parse is what mode-only and binary sections have
      // to rely on, since they carry no `---`/`+++` at all.
      const tokens = splitHeaderPaths(line.slice('diff --git '.length));
      cur = {
        path: tokens ? cleanPath(tokens[1]) : '(unknown)',
        kind: 'source', // refined once the real path is known, below
        diffStart: n,
        diffEnd: n,
        hunks: [],
        addedRanges: [],
        addedLines: 0,
        removedLines: 0,
        binary: false,
      };
      continue;
    }
    if (!cur) continue; // preamble before the first `diff --git` (rare)

    if (
      line.startsWith('Binary files ') ||
      line.startsWith('GIT binary patch')
    ) {
      cur.binary = true;
      continue;
    }
    // Metadata only exists BEFORE the first hunk of a file. Inside a hunk body
    // a removed line whose content starts with `-- ` is emitted as `--- ...`,
    // and an added line whose content starts with `++ ` as `+++ ...` — SQL and
    // Lua comments, for instance. Treating those as headers overwrites the
    // file's path and swallows the line from the add/remove counts.
    if (!curHunk) {
      if (line.startsWith('rename to ')) {
        // A rename states its new path outright, without an `a/`/`b/` prefix.
        cur.path = unquote(line.slice('rename to '.length));
        continue;
      }
      // `diff --git a/x b/x` is ambiguous when a path contains a space (git
      // only C-quotes non-ASCII and control bytes, not spaces), so prefer the
      // unambiguous `+++` / `---` headers. For a deletion `+++` is `/dev/null`,
      // and the old path from `---` is the right label.
      if (line.startsWith('--- ')) {
        const p = line.slice(4);
        if (p !== '/dev/null') oldPath = cleanPath(p);
        continue;
      }
      if (line.startsWith('+++ ')) {
        const p = line.slice(4);
        if (p !== '/dev/null') cur.path = cleanPath(p);
        else if (oldPath) cur.path = oldPath;
        cur.kind = classifyPath(cur.path);
        continue;
      }
    }

    const hm = HUNK_RE.exec(line);
    if (hm) {
      closeHunk(n - 1);
      const newStart = Number(hm[3]);
      const newCount = hm[4] === undefined ? 1 : Number(hm[4]);
      curHunk = {
        diffStart: n,
        diffEnd: n,
        // A pure deletion hunk is `+N,0`: it occupies no new-side lines. Keep
        // `newStart`/`newEnd` clamped so chunk labelling stays sane, and let
        // `newCount` be the authority on whether the range is real.
        newStart,
        newEnd: newCount === 0 ? newStart : newStart + newCount - 1,
        newCount,
      };
      cur.hunks.push(curHunk);
      newCursor = newStart;
      continue;
    }

    if (curHunk) {
      if (line.startsWith('+')) {
        cur.addedLines++;
        noteAdded(cur, newCursor);
        newCursor++;
      } else if (line.startsWith('-')) {
        cur.removedLines++;
      } else if (line === '' || line.startsWith(' ')) {
        // A context line: present on the new side, but not new. With
        // `diff.suppressBlankEmpty` git prints a blank one as a physically
        // empty record rather than a lone space, and failing to advance the
        // cursor shifts every later `addedRanges` entry up by one.
        newCursor++;
      }
    }
  }
  closeFile(total);

  return { files, diffLines: total };
}

/**
 * Anti-sliver floor for a split segment: at least this many diff lines, OR
 * — for files whose lines are very long — at least half the char budget.
 *
 * A lines-only floor deadlocks against the char budget: at 400 chars per line
 * a 40-line minimum is already 16 000 chars, so no cut can satisfy both and
 * the hunk degrades to a single oversized chunk.
 */
const MIN_SPLIT_SEGMENT = 40;

interface Unit {
  start: number;
  end: number;
  path: string;
  newStart: number;
  newEnd: number;
}

/**
 * True iff diff line `n` (1-based) is a safe place to start a new segment
 * inside a hunk: a source line at column 0, preceded by a blank source line.
 *
 * That is the shape of a top-level declaration in brace languages and of a
 * top-level `def`/`class` in Python. Cutting there keeps a function whole,
 * which is the only reason hunks are otherwise treated as atomic.
 */
function isSafeSplitPoint(lines: string[], n: number): boolean {
  const cur = lines[n - 1];
  const prev = lines[n - 2];
  if (cur === undefined || prev === undefined) return false;
  // Both lines must exist in the post-change file — that is the file an agent
  // reads, and the claim being made is about *it*: a top-level declaration
  // preceded by a blank line. A `-` line is old-side only, so neither the
  // declaration nor the blank line before it can be one. Under
  // `diff.suppressBlankEmpty` a blank context line is the empty string.
  const isNewSide = (l: string) => l === '' || /^[+ ]/.test(l);
  if (!isNewSide(cur) || !isNewSide(prev)) return false;
  if (cur === '') return false; // an empty line is not a declaration
  const content = cur.slice(1);
  if (content.length === 0 || /^\s/.test(content)) return false;
  return prev === '' || /^\s*$/.test(prev.slice(1));
}

/** Prefix sums of line lengths (incl. newline) for O(1) range char counts. */
function charPrefix(lines: string[]): number[] {
  const p = new Array<number>(lines.length + 1).fill(0);
  for (let i = 0; i < lines.length; i++) p[i + 1] = p[i] + lines[i].length + 1;
  return p;
}

/** Characters in the 1-based inclusive diff-line range `[s, e]`. */
function charsIn(prefix: number[], s: number, e: number): number {
  return prefix[e] - prefix[s - 1];
}

/**
 * Split a hunk that exceeds the line or character budget at safe interior
 * boundaries.
 *
 * A brand-new file arrives as one enormous hunk (PR #6457 added
 * `events.test.ts` as a single 1535-line hunk), so "hunks are atomic" alone
 * would hand one agent a 50 000-char territory — both the attention dilution
 * chunking exists to avoid, and past `read_file`'s 25 000-char per-read cap.
 * Segments still tile `[unit.start, unit.end]` exactly. When the budget window
 * holds no safe boundary the splitter reaches past it for the next one rather
 * than abandoning the remainder, so a single distant boundary cannot collapse a
 * whole file into one chunk. Only when no boundary exists at all does the
 * remainder stay whole, flagged `oversized`.
 */
function splitUnit(
  unit: Unit,
  lines: string[],
  prefix: number[],
  maxChunkLines: number,
  bodyStart: number,
): Unit[] {
  const over = (s: number, e: number) =>
    e - s + 1 > maxChunkLines || charsIn(prefix, s, e) > MAX_CHUNK_CHARS;
  const bigEnough = (s: number, e: number) =>
    e - s + 1 >= MIN_SPLIT_SEGMENT ||
    charsIn(prefix, s, e) >= MAX_CHUNK_CHARS / 2;
  if (!over(unit.start, unit.end)) return [unit];

  // new-side line number for each diff line of the hunk body.
  const newLineOf = new Map<number, number>();
  let newLine = unit.newStart;
  for (let n = bodyStart; n <= unit.end; n++) {
    const c = lines[n - 1]?.[0];
    if (c === ' ' || c === '+') newLineOf.set(n, newLine++);
  }

  const out: Unit[] = [];
  let segStart = unit.start;
  while (over(segStart, unit.end)) {
    // Scan down from the furthest line either budget allows, taking the last
    // safe boundary that keeps the segment within both.
    const upper = Math.min(unit.end, segStart + maxChunkLines - 1);
    let cut = -1;
    for (let n = upper; n > bodyStart; n--) {
      if (!isSafeSplitPoint(lines, n)) continue;
      if (over(segStart, n - 1)) continue;
      if (!bigEnough(segStart, n - 1)) continue;
      cut = n; // scanning down, the first hit is the largest valid cut
      break;
    }
    // Nothing inside the budget window. Do not give up on the whole remainder:
    // a 1400-line React component whose first top-level boundary sits 460 lines
    // in (PR #6591) would otherwise collapse into one 45 000-char chunk, past
    // what a single `read_file` returns — even though 27 later boundaries
    // exist. Take the next safe point beyond the window instead. One segment
    // runs over budget; the rest stay within it.
    if (cut < 0) {
      for (let n = upper + 1; n <= unit.end; n++) {
        if (isSafeSplitPoint(lines, n) && bigEnough(segStart, n - 1)) {
          cut = n;
          break;
        }
      }
    }
    if (cut < 0) break; // genuinely no safe boundary left — keep the rest intact
    out.push({ ...unit, start: segStart, end: cut - 1 });
    segStart = cut;
  }
  out.push({ ...unit, start: segStart, end: unit.end });

  // Re-derive each segment's new-side range from the lines it actually holds.
  for (const seg of out) {
    let lo = Number.POSITIVE_INFINITY;
    let hi = -1;
    for (let n = seg.start; n <= seg.end; n++) {
      const nl = newLineOf.get(n);
      if (nl === undefined) continue;
      lo = Math.min(lo, nl);
      hi = Math.max(hi, nl);
    }
    seg.newStart = Number.isFinite(lo) ? lo : unit.newStart;
    seg.newEnd = hi >= 0 ? hi : seg.newStart;
  }
  return out;
}

/**
 * Partition the diff into contiguous chunks of at most `maxChunkLines` diff
 * lines and `MAX_CHUNK_CHARS` characters, splitting on hunk boundaries and —
 * for hunks larger than either budget — on safe top-level boundaries inside
 * them.
 *
 * Both budgets bind. Lines govern how much a single agent can attend to;
 * characters govern what `read_file` will hand back in one call. A chunk over
 * the char budget comes back silently short, which is the failure this whole
 * module exists to remove.
 *
 * A file's header lines (`diff --git`, `index`, `---`, `+++`) are attached to
 * its first hunk so a chunk never begins with an orphaned header. Chunks may
 * span several small files.
 */
export function planChunks(
  files: DiffFile[],
  lines: string[],
  maxChunkLines: number = DEFAULT_MAX_CHUNK_LINES,
): DiffChunk[] {
  const diffLines = lines.length;
  if (diffLines === 0) return [];
  const prefix = charPrefix(lines);

  // Units tile the diff exactly. For a file with hunks: [header+hunk0],
  // [hunk1], ... For a binary / mode-only file: the whole section.
  const units: Unit[] = [];
  for (const f of files) {
    if (f.hunks.length === 0) {
      units.push({
        start: f.diffStart,
        end: f.diffEnd,
        path: f.path,
        newStart: 0,
        newEnd: 0,
      });
      continue;
    }
    f.hunks.forEach((h, idx) => {
      const unit: Unit = {
        // The first hunk swallows the file header so the chunk that owns it
        // shows the agent which file it is looking at.
        start: idx === 0 ? f.diffStart : h.diffStart,
        end: h.diffEnd,
        path: f.path,
        newStart: h.newStart,
        newEnd: h.newEnd,
      };
      // `h.diffStart` is the `@@` line; the body begins on the next line.
      units.push(
        ...splitUnit(unit, lines, prefix, maxChunkLines, h.diffStart + 1),
      );
    });
  }

  const chunks: DiffChunk[] = [];
  let cur: DiffChunk | null = null;
  const flush = () => {
    if (cur) {
      cur.lines = cur.endLine - cur.startLine + 1;
      cur.chars = charsIn(prefix, cur.startLine, cur.endLine);
      let widest = 0;
      for (let n = cur.startLine; n <= cur.endLine; n++) {
        if (lines[n - 1].length > widest) widest = lines[n - 1].length;
      }
      cur.maxLineChars = widest;
      chunks.push(cur);
      cur = null;
    }
  };

  for (const u of units) {
    const uLines = u.end - u.start + 1;
    // Units are contiguous, so appending `u` to `cur` yields exactly the range
    // [cur.startLine, u.end] — check both budgets against that.
    if (
      cur &&
      (u.end - cur.startLine + 1 > maxChunkLines ||
        charsIn(prefix, cur.startLine, u.end) > MAX_CHUNK_CHARS)
    ) {
      flush();
    }
    if (!cur) {
      cur = {
        id: chunks.length + 1,
        startLine: u.start,
        endLine: u.end,
        lines: uLines,
        chars: 0, // set in flush(), once the chunk's final range is known
        maxLineChars: 0, // ditto
        oversized:
          uLines > maxChunkLines ||
          charsIn(prefix, u.start, u.end) > MAX_CHUNK_CHARS,
        files: [],
      };
    } else {
      cur.endLine = u.end;
    }
    const last = cur.files[cur.files.length - 1];
    if (last && last.path === u.path) {
      last.newStart = Math.min(last.newStart || u.newStart, u.newStart);
      last.newEnd = Math.max(last.newEnd, u.newEnd);
    } else {
      cur.files.push({ path: u.path, newStart: u.newStart, newEnd: u.newEnd });
    }
    // An oversized hunk stands alone: close immediately so it cannot absorb
    // a following unit and grow further.
    if (cur.oversized) flush();
  }
  flush();

  return chunks;
}

/** Parse + partition in one call. */
export function buildDiffPlan(
  diffText: string,
  maxChunkLines: number = DEFAULT_MAX_CHUNK_LINES,
): DiffPlan {
  const { files, diffLines } = parseDiff(diffText);
  const lines = diffText.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const linesOf = (kind: PathKind) =>
    files
      .filter((f) => f.kind === kind)
      .reduce((n, f) => n + (f.diffEnd - f.diffStart + 1), 0);
  const chunks = planChunks(files, lines, maxChunkLines);
  // The tiling invariant is the whole point: every diff line belongs to exactly
  // one chunk, so a missing coverage receipt means a territory nobody read. It
  // was only ever asserted in tests. A parser regression would have shipped a
  // plan with a hole in it and the review would have reported "no blockers"
  // over the gap. Fail loudly instead.
  if (!chunksCoverDiff(chunks, diffLines)) {
    throw new Error(
      `diff-plan: chunks do not tile the diff (${chunks.length} chunks over ` +
        `${diffLines} lines). Refusing to plan a review with a coverage hole.`,
    );
  }
  return {
    diffLines,
    diffChars: diffText.length,
    srcDiffLines: linesOf('source'),
    testDiffLines: linesOf('test'),
    generatedDiffLines: linesOf('generated'),
    docsDiffLines: linesOf('docs'),
    files,
    chunks,
  };
}

/**
 * True iff the chunks tile `[1, diffLines]` with no gap and no overlap.
 *
 * The orchestrator's coverage assertion depends on this; a regression here
 * would silently reintroduce the blind spot the whole design removes.
 */
export function chunksCoverDiff(
  chunks: DiffChunk[],
  diffLines: number,
): boolean {
  if (diffLines === 0) return chunks.length === 0;
  const sorted = [...chunks].sort((a, b) => a.startLine - b.startLine);
  let expected = 1;
  for (const c of sorted) {
    if (c.startLine !== expected) return false;
    if (c.endLine < c.startLine) return false;
    expected = c.endLine + 1;
  }
  return expected === diffLines + 1;
}
