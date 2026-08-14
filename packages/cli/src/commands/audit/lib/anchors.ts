/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Write-time anchor resolution for /audit, per docs/design/legacy-code-audit.md:
// every finding's quoted snippet is resolved against the audited files and
// the registered deep-read callers before the report ships. A snippet that
// does not resolve uniquely is refused or downgraded — never silently
// shipped — and every refusal is recorded in the report header. The parser
// fails closed the same way: a block that looks like a finding but deviates
// past the tolerated axes (an unparseable header, a missing field) still
// emits an entry with empty fields, so the gate fires instead of skipping it.

import { join } from 'node:path';
import { AUDIT_READ_MAX_BYTES, readGuarded } from './safe-read.js';
import type { FilesPlan } from './files-plan.js';
import type { Severity } from '../../../utils/findings.js';

export interface ReportFinding {
  title: string;
  /** The lifted findings schema's ladder; '' marks the parser's fail-closed
   *  synthetic entries, which never resolve. */
  severity: Severity | '';
  /** The cited files, audit-relative (or absolute registered callers). A
   *  pair finding carries both ends. */
  locations: string[];
  /** The raw Location value before comma/and splitting: a single cited
   *  file whose NAME carries a comma or spaced 'and' must still bind when
   *  the whole value names a known file. */
  locationRaw?: string;
  anchor: string;
}

export type AnchorVerdict =
  | 'resolved'
  | 'unresolved'
  | 'ambiguous'
  | 'out-of-scope';

export interface AnchorResult {
  finding: ReportFinding;
  verdict: AnchorVerdict;
  matchCount: number;
}

// Header matching is lenient on the axes an agent plausibly deviates on —
// leading indentation (stripped before matching), 2–4 hashes, severity case —
// so a deviated header still parses. What still fails to parse is caught by
// the header-shaped net and fails closed.
const FINDING_RE = /^#{2,4}\s+\[(critical|suggestion)\]\s+(.+)$/i;
// The fail-closed net. Bracket-less severity headers with a title
// (`### Critical: foo`) and bold headers (`**[Critical] foo**`) are the
// common rendering deviations; without them a deviated draft parses to ZERO
// findings and the gate exits 0. The colon is load-bearing: the report's
// own section headings ('## Critical', '## Critical Findings') carry no
// colon after the severity word and must stay invisible — their fields, if
// any follow, are caught by the orphan-field synthesis instead.
const HEADER_SHAPED_RE = /^#{1,6}\s*\[/;
const SEVERITY_HEADING_RE = /^#{2,6}\s*(?:critical|suggestion)\b\s*:/i;
const BOLD_FINDING_RE = /^\*\*\s*\[(?:critical|suggestion)\]/i;
const headerNetted = (line: string): boolean =>
  HEADER_SHAPED_RE.test(line) ||
  SEVERITY_HEADING_RE.test(line) ||
  BOLD_FINDING_RE.test(line);
// Inside an UNFENCED anchor the generic header-shaped arm stays out: it
// would split on `#[cfg(test)]` and other single-hash attribute/macro
// lines a snippet legitimately quotes. The two severity-bearing shapes
// are the deviated-finding-header class; code does not carry them.
const deviatedFindingHeader = (line: string): boolean =>
  SEVERITY_HEADING_RE.test(line) || BOLD_FINDING_RE.test(line);
// Field names match case-insensitively: header matching is deliberately
// case-lenient, and LLM casing deviation on the fields must not fail a
// correctly-anchored finding. Bold labels are the same deviation the
// header net tolerates on headers, colon inside OR outside the bold
// (`- **Location:**` / `- **Location**:`).
const FIELD_RE =
  /^-\s+(?:\*\*)?(Location|Anchor)(?:\*\*)?\s*:(?:\*\*)?\s*(.*)$/i;
// Anchor collection ends only on a RECOGNIZED finding field indented at or
// shallower than the Anchor field line: a deeper-indented line inside the
// quoted snippet (a YAML/markdown list item, an embedded `- Issue:`) must
// not truncate the anchor.
const FIELD_END_RE =
  /^-\s+(?:\*\*)?(Issue|Failure scenario|Severity|Location|Anchor)(?:\*\*)?\s*:/i;

function leadingIndent(line: string): number {
  let i = 0;
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;
  return i;
}

function dedent(line: string, indent: number): string {
  let i = 0;
  while (
    i < indent &&
    i < line.length &&
    (line[i] === ' ' || line[i] === '\t')
  ) {
    i++;
  }
  return line.slice(i);
}

/** One cited location, normalized to the audit-relative file path: strip a
 *  leading './' (agents emit it habitually) and peel the line/column/range
 *  suffixes — iteratively, so the four-part editor form ':1:5-10' peels
 *  whole instead of leaving a residual ':1'. FIELD_RE is lenient on the
 *  LABEL but passes value decoration through: inline-code wrapping and
 *  trailing bold are the pervasive LLM renderings, '#L42' the GitHub form,
 *  backslashes the Windows quoting — all peel before the membership check
 *  instead of grading a correctly-anchored finding out-of-scope. */
function normalizeLocation(raw: string): string {
  let value = raw.trim();
  while (value.length >= 2 && value.startsWith('`') && value.endsWith('`')) {
    value = value.slice(1, -1).trim();
  }
  return (
    value
      .replace(/\*{1,2}$/, '')
      // Trailing sentence punctuation (a prose citation ending 'unique.ts:1,')
      // blocks the line-suffix peels below, and the unknown whole value would
      // replace the correctly parsed fragment.
      .replace(/[,;.]+$/, '')
      .replace(/\\/g, '/')
      .replace(/^\.\//, '')
      .replace(/#L\d+(?:-L?\d+)?$/i, '')
      .replace(/\s+lines?\s+\d+(?:-\d+)?$/i, '')
      .replace(/(?::\d+)+(?:-\d+)?$/, '')
      .trim()
  );
}

/** The brief template instructs pairs to cite both locations on the one
 *  line ('a.ts:1, b.ts:2'); split on the comma/and spellings. */
function parseLocations(value: string): string[] {
  // 'and' requires surrounding whitespace: it also delimits filenames
  // ('drag-and-drop.tsx'), and an unanchored \band\b splits inside them.
  return value
    .split(/,|\s+and\s+/)
    .map(normalizeLocation)
    .filter((l) => l !== '');
}

/** The next non-blank line after a would-be terminator: only a recognized
 *  field or finding header confirms the terminator is a real report field
 *  and not a field-shaped line quoted inside an UNFENCED anchor. EOF
 *  confirms — collection ends there anyway. */
function nextLineFieldShaped(lines: string[], i: number): boolean {
  for (let k = i + 1; k < lines.length; k++) {
    const next = lines[k].trim();
    if (next === '') continue;
    return (
      FINDING_RE.test(next) || FIELD_END_RE.test(next) || headerNetted(next)
    );
  }
  return true;
}

/** Parse the finding blocks of a report draft: `### [sev] title` opens a
 *  block; `- Location:` and `- Anchor:` fields inside it. An anchor value
 *  runs to the next recognized field or the next finding header. Fails
 *  closed: a header-shaped line that yields no finding emits a synthetic
 *  entry (its raw text as the title); a block whose location or anchor
 *  field is missing keeps its empty fields; and a field arriving with no
 *  open block at all (the bare-header deviation) opens a synthetic entry —
 *  resolveAnchors verdicts an incomplete entry `unresolved`, so exit 4
 *  fires and the handling path runs instead of a silent zero-finding
 *  parse. */
export function parseReportFindings(report: string): ReportFinding[] {
  const findings: ReportFinding[] = [];
  const lines = report.split('\n');
  let current: (ReportFinding & { anchorLines: string[] }) | null = null;
  // A second Location field does not overwrite at once: it is held here
  // and committed only when a SECOND Anchor field confirms the restart
  // (an author re-writing the block pair-wise). A field-shaped line
  // quoted inside an unfenced snippet is never followed by a new Anchor
  // field, so the first locations survive and the mis-bind fails closed.
  let pendingLocations: { locations: string[]; raw: string } | null = null;
  let inAnchor = false;
  // Open-fence state inside the collected anchor: a ``` fence pair quoted
  // into the snippet shields its interior from field- and header-detection
  // (an embedded '- location:' or '### [...]' line is content there).
  let inFence = false;
  // The Anchor field line's indentation: continuation lines are dedented by
  // it (an indented finding block must still yield a matchable needle), and
  // only fields indented at or shallower terminate collection.
  let anchorIndent = 0;
  // The collected anchor carried a fence pair: only then does a following
  // second Location/Anchor pair read unambiguously as the author rewriting
  // the block — an unfenced anchor cannot rule out the quoted-pair reading
  // (a snippet quoting a prior round's fields).
  let anchorFenced = false;

  const push = (): void => {
    if (!current) return;
    const collected = current.anchorLines;
    let lo = 0;
    let hi = collected.length;
    while (lo < hi && collected[lo].trim() === '') lo++;
    while (hi > lo && collected[hi - 1].trim() === '') hi--;
    // Agents habitually wrap quoted code in fences: drop a surrounding pair
    // so the needle is the snippet itself — a multi-line fence pair, or the
    // inline-code forms on a single line.
    if (
      hi - lo >= 2 &&
      collected[lo].trim().startsWith('```') &&
      collected[hi - 1].trim().startsWith('```')
    ) {
      lo++;
      hi--;
    } else if (hi - lo === 1) {
      const trimmed = collected[lo].trim();
      if (/^`+$/.test(trimmed)) {
        // A line of fence markers only is residue, not a snippet: empty
        // it so the gate grades the finding unresolved instead of
        // matching a stray backtick in the cited file.
        collected[lo] = '';
      } else if (
        trimmed.length >= 6 &&
        trimmed.startsWith('```') &&
        trimmed.endsWith('```')
      ) {
        collected[lo] = trimmed.slice(3, -3);
      } else if (
        trimmed.length >= 4 &&
        trimmed.startsWith('``') &&
        trimmed.endsWith('``')
      ) {
        // The CommonMark-required span when the snippet itself carries
        // backticks: the generic arm below would leave one backtick pair.
        collected[lo] = trimmed.slice(2, -2);
      } else if (
        trimmed.length >= 2 &&
        trimmed.startsWith('`') &&
        trimmed.endsWith('`')
      ) {
        collected[lo] = trimmed.slice(1, -1);
      }
    }
    const kept = collected.slice(lo, hi);
    // Markdown-conventional continuations arrive indented deeper than the
    // field line: dedent by the minimum indent of the surviving lines so
    // the needle matches column-0 code (relative indent within the snippet
    // is preserved).
    let minIndent = Number.POSITIVE_INFINITY;
    for (const l of kept) {
      if (l.trim() === '') continue;
      const ind = leadingIndent(l);
      if (ind < minIndent) minIndent = ind;
    }
    // No final trim: the needle keeps its first line's relative indent
    // when it sits deeper than the snippet minimum — trimming it away
    // made that shape structurally unmatchable. The lo/hi blank-line
    // strip above already handles the edges.
    const anchor = kept
      .map((l) =>
        minIndent === Number.POSITIVE_INFINITY ? l : dedent(l, minIndent),
      )
      .join('\n');
    findings.push({
      title: current.title,
      severity: current.severity,
      locations: current.locations,
      locationRaw: current.locationRaw,
      anchor,
    });
    current = null;
    pendingLocations = null;
    inAnchor = false;
    inFence = false;
    anchorFenced = false;
  };

  const handleField = (rawLine: string, trimmed: string): void => {
    if (!current) return;
    const field = FIELD_RE.exec(trimmed);
    if (!field) return;
    if (field[1].toLowerCase() === 'anchor') {
      // A well-formed finding carries exactly one Anchor field: a second
      // one starts over, whatever came between (a bare `- Location:` in
      // between turned collection off but must not merge the blocks).
      if (current.anchorLines.length > 0 && pendingLocations) {
        // The restart is confirmed by the pair shape — a second Location
        // preceded this second Anchor. An ISOLATED second Anchor (no held
        // Location) is a quoted line, not a rewrite: it was dropped at
        // termination and the original needle stands.
        if (anchorFenced) {
          // The fence pair shielded the first anchor's interior, so the
          // pair is the author rewriting the block — commit it.
          current.locations = pendingLocations.locations;
          current.locationRaw = pendingLocations.raw;
        } else {
          // Unfenced: the quoted-pair reading cannot be ruled out, so
          // neither binding may win — downgrade to fail-closed.
          current.severity = '';
        }
        pendingLocations = null;
        current.anchorLines = [];
        anchorFenced = false;
      }
      inAnchor = true;
      const value = field[2].trim();
      // Latch only when the fence OPENS without closing on the same line:
      // a self-closing inline fence (`- Anchor: ```foo```) must not
      // swallow every subsequent line into this anchor.
      inFence =
        value.startsWith('```') &&
        !(value.length >= 6 && value.endsWith('```'));
      if (inFence) anchorFenced = true;
      anchorIndent = leadingIndent(rawLine);
      current.anchorLines.push(field[2].trimEnd());
    } else {
      // The FIRST Location field binds: a second one — a bare duplicate,
      // or a field-shaped line quoted inside an unfenced snippet — must
      // not silently overwrite the finding's real locations (the
      // reordered Anchor-before-Location shape arrives with locations
      // still empty). Held as pending instead, committed only by a
      // following second Anchor (see above).
      if (current.locations.length === 0) {
        current.locations = parseLocations(field[2]);
        current.locationRaw = field[2];
      } else {
        pendingLocations = {
          locations: parseLocations(field[2]),
          raw: field[2],
        };
      }
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    const header = FINDING_RE.exec(line);
    if (header) {
      // A well-formed finding header ends an open anchor (unless the anchor
      // is inside an open fence — quoted markdown legitimately carries
      // header lines) and opens the new block.
      if (!(current && inAnchor && inFence)) {
        push();
        current = {
          title: header[2].trim(),
          severity:
            header[1].toLowerCase() === 'critical' ? 'Critical' : 'Suggestion',
          locations: [],
          anchor: '',
          anchorLines: [],
        };
        inAnchor = false;
        inFence = false;
        continue;
      }
    }
    if (current && inAnchor) {
      if (line.startsWith('```')) {
        inFence = !inFence;
        if (inFence) anchorFenced = true;
      }
      if (
        !inFence &&
        FIELD_END_RE.test(line) &&
        leadingIndent(raw) <= anchorIndent &&
        nextLineFieldShaped(lines, i)
      ) {
        inAnchor = false;
        // The terminating line is itself a field (the reordered
        // Anchor-before-Location shape): parse it, do not drop it.
        handleField(raw, line);
        continue;
      }
      if (!inFence && deviatedFindingHeader(line)) {
        // A deviated finding header inside an UNFENCED anchor ends
        // collection: fall through to the fail-closed net below instead
        // of merging the two blocks into one. Only genuinely
        // fence-shielded lines stay content.
        inAnchor = false;
      } else {
        current.anchorLines.push(
          dedent(raw.replace(/\r$/, ''), anchorIndent).trimEnd(),
        );
        continue;
      }
    }
    if (headerNetted(line)) {
      push();
      // Open a fail-closed block rather than emitting at once: fields that
      // follow a deviant header attach to it, so the block emits ONCE with
      // whatever it carried (with no fields it still emits at EOF — either
      // shape grades unresolved).
      current = {
        title: line,
        severity: '',
        locations: [],
        anchor: '',
        anchorLines: [],
      };
      inAnchor = false;
      inFence = false;
      continue;
    }
    const field = FIELD_RE.exec(line);
    // Any recognized field — not only Location/Anchor — opens a synthetic
    // block: orphan Issue/Failure scenario/Severity lines with no open
    // block must not parse to zero findings and a silent exit 0.
    if (!field && !FIELD_END_RE.test(line)) continue;
    if (!current) {
      // A field with no open block: the bare-header deviation (a header the
      // nets tolerate as a section heading, followed by real fields). The
      // fields belong to a finding — synthesize one so the gate rules on it
      // instead of dropping it silently.
      current = {
        title: '',
        severity: '',
        locations: [],
        anchor: '',
        anchorLines: [],
      };
    }
    handleField(raw, line);
  }
  // An unclosed fence at EOF means the draft is truncated mid-anchor: emit
  // the collected block AND a synthetic entry naming the truncation, so the
  // remediation sees the true cause instead of a bare 'failed to resolve'.
  const fenceUnclosed = current !== null && inAnchor && inFence;
  push();
  if (fenceUnclosed) {
    findings.push({
      title: 'unclosed anchor fence at end of report — the draft is truncated',
      severity: '',
      locations: [],
      anchor: '',
    });
  }
  return findings;
}

/** One window of consecutive haystack lines against the needle, tolerating
 *  indent: the needle arrives dedented to column 0, while code quoted from
 *  an indented body keeps its indent in the file. The window is dedented by
 *  the MINIMUM indent across its non-empty lines, with the FIRST line's own
 *  indent tried as a second base, so an occurrence whose first line sits
 *  deeper than the rest still matches. Window lines compare right-trimmed (the
 *  needle's lines are right-trimmed at collection). The LAST needle line
 *  compares by prefix: an agent trimming a trailing comment when quoting
 *  (`const b = 2;` against `const b = 2; // TODO`) cites code that is
 *  present at the location. The tolerance is BOUNDED — only whitespace or
 *  a comment introducer may follow — or it fuses tokens (`const b = 2`
 *  against `const b = 22;`), certifying a line that does not exist. */
function windowMatchesWithBase(
  hayLines: string[],
  start: number,
  needleLines: string[],
  base: number,
): boolean {
  for (let j = 0; j < needleLines.length; j++) {
    const windowLine = dedent(hayLines[start + j], base).trimEnd();
    if (j === needleLines.length - 1) {
      if (!windowLine.startsWith(needleLines[j])) return false;
      const rest = windowLine.slice(needleLines[j].length);
      if (rest !== '' && !/^(?:\s|\/\/|\/\*|#)/.test(rest)) return false;
    } else if (windowLine !== needleLines[j]) {
      return false;
    }
  }
  return true;
}

function windowMatchesAt(
  hayLines: string[],
  start: number,
  needleLines: string[],
): boolean {
  if (start + needleLines.length > hayLines.length) return false;
  let base = Number.POSITIVE_INFINITY;
  for (let j = 0; j < needleLines.length; j++) {
    const windowLine = hayLines[start + j];
    if (windowLine.trim() === '') continue;
    const indent = leadingIndent(windowLine);
    if (indent < base) base = indent;
  }
  if (base === Number.POSITIVE_INFINITY) base = leadingIndent(hayLines[start]);
  // The minimum-indent base covers uniformly indented occurrences; an
  // occurrence whose FIRST line sits deeper than the minimum needs its
  // own indent tried too, or it matches no base and escapes the count.
  const firstIndent = leadingIndent(hayLines[start]);
  return (
    windowMatchesWithBase(hayLines, start, needleLines, base) ||
    (firstIndent !== base &&
      windowMatchesWithBase(hayLines, start, needleLines, firstIndent))
  );
}

function countIndentTolerantMatches(
  hayLines: string[],
  needleLines: string[],
): number {
  let count = 0;
  for (let i = 0; i + needleLines.length <= hayLines.length; i++) {
    if (windowMatchesAt(hayLines, i, needleLines)) count++;
  }
  return count;
}

/** Resolve each finding's anchor against the cited files. The resolution set
 *  is the audited subject/test files plus the registered deep-read callers —
 *  the headline cross-file findings anchor in callers outside the audited
 *  path, and a narrower set would refuse exactly those. */
export function resolveAnchors(
  findings: ReportFinding[],
  plan: FilesPlan,
  registeredCallers: string[] = [],
): AnchorResult[] {
  const allowed = new Set([
    ...plan.subjectFiles.map((f) => f.path),
    ...plan.testCorpus.map((f) => f.path),
  ]);
  const callerSet = new Set(registeredCallers);
  return findings.map((finding) => {
    // The parser's fail-closed entries: a missing field or an unparseable
    // header can never resolve — a finding whose header did not parse is
    // uncertifiable even when its anchor snippet matches.
    if (
      !finding.severity ||
      finding.locations.length === 0 ||
      !finding.anchor
    ) {
      return { finding, verdict: 'unresolved', matchCount: 0 };
    }
    const needle = finding.anchor.replace(/\r\n/g, '\n');
    // A single cited file whose NAME carries a comma or spaced 'and' is
    // shredded by the split into fragments that match nothing: try the
    // WHOLE raw value against the known set first, and fall back to the
    // fragments only when it names nothing.
    const whole =
      finding.locationRaw !== undefined
        ? normalizeLocation(finding.locationRaw)
        : '';
    const wholeKnown =
      whole !== '' && (allowed.has(whole) || callerSet.has(whole));
    // The shredded fragments bind only when every fragment carries its
    // own :line suffix — the cited-pair shape the briefs instruct. Any
    // other split is an out-of-scope bypass: a delimiter inside an
    // unknown name would certify the finding against files the report
    // never cited. The whole (unknown) value binds instead and the
    // membership check below refuses it.
    const fragmentsLined =
      !wholeKnown &&
      finding.locations.length > 1 &&
      (finding.locationRaw ?? '')
        .split(/,|\s+and\s+/)
        .filter((fragment) => fragment.trim() !== '')
        .every((fragment) => /(?::\d+|#L\d+)/i.test(fragment));
    const locations = wholeKnown
      ? [whole]
      : fragmentsLined
        ? finding.locations
        : whole !== ''
          ? [whole]
          : finding.locations;
    let matchCount = 0;
    let onePerLocation = true;
    for (const location of locations) {
      const isCaller = callerSet.has(location);
      if (!isCaller && !allowed.has(location)) {
        return { finding, verdict: 'out-of-scope', matchCount: 0 };
      }
      const abs = isCaller ? location : join(plan.targetPathAbsolute, location);
      // Guarded read: the cited path is agent-authored — a writer-less FIFO
      // must not hang the gate, nor a multi-GB file exhaust memory.
      const content = readGuarded(abs, AUDIT_READ_MAX_BYTES);
      if (content === null) {
        return { finding, verdict: 'unresolved', matchCount: 0 };
      }
      // Multi-line anchors join with \n; a CRLF file (Windows checkouts,
      // vendored .bat/.cmd) must resolve against the same anchor, so
      // normalize both sides to LF before matching. A UTF-8 BOM on line 1
      // (the same Windows/vendored class) must not defeat an anchor whose
      // first line sits there.
      const haystack = content
        .toString('utf8')
        .replace(/^\uFEFF/, '')
        .replace(/\r\n/g, '\n');
      // Count PER CITED LOCATION: a pair finding's snippet appears in every
      // cited file by definition, so a sum across locations grades exactly
      // the pair class ambiguous whenever it binds at all. The finding
      // resolves only when each cited file contributes exactly one hit.
      let locationMatches: number;
      if (needle.includes('\n')) {
        // Multi-line needles match indent-tolerantly: the needle is
        // dedented to column 0, so a snippet quoted from an indented body
        // must still resolve (a raw substring search would never find it).
        // The window matcher tries both the window-minimum and the first
        // line's indent as bases, so it subsumes every line-start raw
        // occurrence; add only raw matches starting MID-line.
        const needleLines = needle.split('\n');
        const hayLines = haystack.split('\n');
        locationMatches = countIndentTolerantMatches(hayLines, needleLines);
        let idx = haystack.indexOf(needle);
        while (idx !== -1) {
          const lineStart = haystack.lastIndexOf('\n', idx - 1) + 1;
          if (haystack.slice(lineStart, idx).trim() !== '') {
            locationMatches++;
          }
          idx = haystack.indexOf(needle, idx + 1);
        }
      } else {
        locationMatches = 0;
        let idx = haystack.indexOf(needle);
        while (idx !== -1) {
          locationMatches++;
          idx = haystack.indexOf(needle, idx + 1);
        }
      }
      matchCount += locationMatches;
      if (locationMatches !== 1) onePerLocation = false;
    }
    const verdict: AnchorVerdict =
      matchCount === 0
        ? 'unresolved'
        : onePerLocation
          ? 'resolved'
          : 'ambiguous';
    return { finding, verdict, matchCount };
  });
}
