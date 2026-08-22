/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Write-time anchor resolution for /audit, per docs/design/legacy-code-audit.md:
// every finding's quoted snippet is resolved against the audited files and
// the registered deep-read callers before the report ships. A snippet that
// does not resolve uniquely is refused or downgraded — never silently
// shipped.
//
// WHAT THE GATE READS, AND WHY IT IS NOT THE REPORT PROSE.
//
// The findings arrive as a machine-readable MANIFEST (JSON, schema-checked
// here), not as markdown parsed back out of the human-readable report. An
// earlier shape did parse the report, and the parser was structurally
// fail-open: the report is unbounded LLM-authored text, so any rendering the
// parser's nets did not anticipate — a bold header, a fence length, a
// localized heading, a second Location field, a rejected-findings appendix
// re-entering as if it were a findings section — either produced ZERO
// findings (and the gate certified a report whose snippets were never
// resolved) or silently changed which file a finding was bound to. Each new
// rendering was a new entrance, and a net per entrance never closes the set.
//
// The manifest closes it by construction: fields arrive typed and verbatim,
// so there is nothing to peel, split, or infer. What remains is keeping the
// manifest and the report HONEST about each other — a finding in the report
// but not the manifest would be an unresolved snippet shipping unchecked —
// and that is a counting problem, not a parsing one: each finding block in
// the report carries a machine marker naming its manifest id, and the gate
// checks the two sets are equal. Markers are invisible in rendered markdown,
// carry no prose, and survive translation, so the check is language- and
// layout-independent.

import { join } from 'node:path';
import { AUDIT_READ_MAX_BYTES, readGuarded } from './safe-read.js';
import type { FilesPlan } from './files-plan.js';
import { SEVERITIES, type Severity } from '../../../utils/findings.js';

/** The marker the report's finding blocks carry, one per finding. */
const FINDING_MARKER_RE = /<!--\s*audit-finding:\s*([^\s->]+)\s*-->/g;

/** The manifest id space: interpolated into the marker and compared as a
 *  set key, so it stays a short opaque token. */
const FINDING_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Verbatim snippets have no business exceeding a few hundred lines; the
 *  scan below is O(haystack × needle) on agent-authored input and the
 *  check-anchors handler is synchronous with no timeout — oversized
 *  anchors grade unresolved instead of stalling the gate. */
export const AUDIT_ANCHOR_MAX_LINES = 2000;

export interface AuditFinding {
  /** Stable within one report; the marker in the report names it. */
  id: string;
  title: string;
  severity: Severity;
  /** The cited files, audit-relative (or absolute registered callers). A
   *  pair finding carries both ends — already split by the author, never by
   *  a delimiter guess here. */
  locations: string[];
  /** The verbatim snippet, exactly as it appears in the cited file(s). */
  anchor: string;
}

export type AnchorVerdict =
  | 'resolved'
  | 'unresolved'
  | 'ambiguous'
  | 'out-of-scope';

export interface AnchorResult {
  finding: AuditFinding;
  verdict: AnchorVerdict;
  matchCount: number;
}

/** Thrown for a manifest that is not a manifest. Fail-closed by shape: the
 *  gate refuses rather than resolving a partial set, because a dropped
 *  finding is exactly the failure the gate exists to prevent. */
export class ManifestError extends Error {
  constructor(message: string) {
    super(`audit check-anchors: ${message}`);
    this.name = 'ManifestError';
  }
}

function requireString(
  value: unknown,
  what: string,
  index: number,
  { allowEmpty = false } = {},
): string {
  if (typeof value !== 'string' || (!allowEmpty && value === '')) {
    throw new ManifestError(
      `findings[${index}].${what} must be a non-empty string.`,
    );
  }
  return value;
}

/** Parse and validate the findings manifest. Every field is required and
 *  typed; anything else refuses the whole file. */
export function parseFindingsManifest(raw: string): AuditFinding[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ManifestError(
      'the findings manifest is not valid JSON — regenerate it.',
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ManifestError(
      'the findings manifest must be a JSON object with a `findings` array.',
    );
  }
  const record = parsed as Record<string, unknown>;
  if (record['version'] !== 1) {
    throw new ManifestError(
      'the findings manifest must declare `"version": 1`.',
    );
  }
  const list = record['findings'];
  if (!Array.isArray(list)) {
    throw new ManifestError('the findings manifest needs a `findings` array.');
  }
  const seen = new Set<string>();
  const findings: AuditFinding[] = list.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new ManifestError(`findings[${index}] must be an object.`);
    }
    const item = entry as Record<string, unknown>;
    const id = requireString(item['id'], 'id', index);
    if (!FINDING_ID_RE.test(id)) {
      throw new ManifestError(
        `findings[${index}].id must match ${FINDING_ID_RE} (it is compared ` +
          `against the report's marker).`,
      );
    }
    if (seen.has(id)) {
      throw new ManifestError(`findings[${index}].id "${id}" is duplicated.`);
    }
    seen.add(id);
    const severity = item['severity'];
    if (
      typeof severity !== 'string' ||
      !(SEVERITIES as readonly string[]).includes(severity)
    ) {
      throw new ManifestError(
        `findings[${index}].severity must be one of ${SEVERITIES.join(', ')}.`,
      );
    }
    const locations = item['locations'];
    if (
      !Array.isArray(locations) ||
      locations.length === 0 ||
      locations.some((l) => typeof l !== 'string' || l === '')
    ) {
      throw new ManifestError(
        `findings[${index}].locations must be a non-empty array of ` +
          `non-empty strings (one entry per cited file; a pair finding ` +
          `carries both).`,
      );
    }
    return {
      id,
      title: requireString(item['title'], 'title', index),
      severity: severity as Severity,
      locations: locations as string[],
      anchor: requireString(item['anchor'], 'anchor', index),
    };
  });
  return findings;
}

/** Compare the report's finding markers against the manifest. Returns the
 *  problems found; an empty array means the two agree exactly.
 *
 *  This is the whole report-side contract. It cannot be defeated by
 *  rendering, ordering, localization, or section layout, because it reads
 *  nothing but the markers — and a finding that reaches the report without
 *  one is reported here rather than shipping with an unchecked snippet. */
export function checkReportMarkers(
  report: string,
  findings: AuditFinding[],
): string[] {
  const problems: string[] = [];
  const inReport: string[] = [];
  for (const match of report.matchAll(FINDING_MARKER_RE)) {
    inReport.push(match[1]);
  }
  const counts = new Map<string, number>();
  for (const id of inReport) counts.set(id, (counts.get(id) ?? 0) + 1);
  for (const [id, count] of counts) {
    if (count > 1) {
      problems.push(
        `the report carries ${count} markers for finding "${id}" — one block per finding.`,
      );
    }
  }
  const manifestIds = new Set(findings.map((f) => f.id));
  for (const id of manifestIds) {
    if (!counts.has(id)) {
      problems.push(
        `finding "${id}" is in the manifest but no block in the report carries its marker.`,
      );
    }
  }
  for (const id of counts.keys()) {
    if (!manifestIds.has(id)) {
      problems.push(
        `the report carries a marker for "${id}", which the manifest does not list.`,
      );
    }
  }
  return problems;
}

/** The bounded follow rule: a match may end at EOL, or only whitespace or a
 *  comment introducer may follow it. Decided by the two characters after
 *  the hit — never by slicing to EOF, which made every hit cost the rest
 *  of the file and the single-line scan quadratic in file size. */
function followRuleOk(text: string, pos: number): boolean {
  const c1 = text[pos];
  if (c1 === undefined || c1 === '\n') return true;
  if (c1 === '#') return true;
  if (c1 === '/' && (text[pos + 1] === '/' || text[pos + 1] === '*')) {
    return true;
  }
  return /^\s/.test(c1);
}

function leadingIndent(line: string): number {
  let i = 0;
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;
  return i;
}

/** Strip up to `indent` leading whitespace CHARACTERS, of either kind: the
 *  comparison is whitespace-kind-insensitive by construction, so a tab-
 *  indented file and a space-indented one dedent the same way. */
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

/** One window of consecutive haystack lines against the needle, tolerating
 *  indent: a snippet quoted from an indented body keeps its indent in the
 *  file, while the needle may have been quoted with the block's own indent
 *  removed. Window lines compare right-trimmed. The LAST needle line
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
    const needleLine = needleLines[j].trimEnd();
    if (j === needleLines.length - 1) {
      if (!windowLine.startsWith(needleLine)) return false;
      if (!followRuleOk(windowLine, needleLine.length)) return false;
    } else if (windowLine !== needleLine) {
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
  let maxIndent = 0;
  for (let j = 0; j < needleLines.length; j++) {
    const windowLine = hayLines[start + j];
    if (windowLine.trim() === '') continue;
    const indent = leadingIndent(windowLine);
    if (indent < base) base = indent;
    if (indent > maxIndent) maxIndent = indent;
  }
  if (base === Number.POSITIVE_INFINITY) base = leadingIndent(hayLines[start]);
  // Base 0 is the verbatim reading — the needle as literally written, which
  // is what a correctly quoted snippet from a column-0 body is. The other
  // bases cover quotes whose own indent was dropped: the window minimum
  // (uniformly indented occurrences), the first line's indent (a first line
  // deeper than the rest), the last line's, the maximum (a wrapped call
  // whose DEEPEST line sits in the middle), and the first-line offset (a
  // first line adding whitespace beyond the needle's own indent). An
  // occurrence matching none of them escapes the count, which grades
  // ambiguity wrong in the fail-OPEN direction — hence the spread.
  const firstIndent = leadingIndent(hayLines[start]);
  const lastIndent = leadingIndent(hayLines[start + needleLines.length - 1]);
  const offsetBase = firstIndent - leadingIndent(needleLines[0]);
  const bases = new Set<number>([0, base, firstIndent, lastIndent, maxIndent]);
  if (offsetBase >= 0) bases.add(offsetBase);
  for (const candidate of bases) {
    if (windowMatchesWithBase(hayLines, start, needleLines, candidate)) {
      return true;
    }
  }
  return false;
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
  findings: AuditFinding[],
  plan: FilesPlan,
  registeredCallers: string[] = [],
): AnchorResult[] {
  const allowed = new Set([
    ...plan.subjectFiles.map((f) => f.path),
    ...plan.testCorpus.map((f) => f.path),
  ]);
  // Callers arrive absolute and platform-native — backslashed on Windows —
  // so both sides of the membership test are forward-slashed or no Windows
  // caller binds.
  const normalize = (p: string): string => p.replace(/\\/g, '/');
  const callerSet = new Set(registeredCallers.map(normalize));
  return findings.map((finding) => {
    const needle = finding.anchor.replace(/\r\n/g, '\n');
    const needleLines = needle.split('\n');
    if (needleLines.length > AUDIT_ANCHOR_MAX_LINES) {
      return { finding, verdict: 'unresolved', matchCount: 0 };
    }
    let matchCount = 0;
    let onePerLocation = true;
    for (const raw of finding.locations) {
      const location = normalize(raw);
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
      if (needleLines.length > 1) {
        // The window matcher covers every line-start occurrence (base 0 is
        // the verbatim reading); add only raw matches starting MID-line.
        const hayLines = haystack.split('\n');
        locationMatches = countIndentTolerantMatches(hayLines, needleLines);
        let idx = haystack.indexOf(needle);
        while (idx !== -1) {
          const lineStart = haystack.lastIndexOf('\n', idx - 1) + 1;
          if (haystack.slice(lineStart, idx).trim() !== '') {
            // A mid-line hit carries neither boundary the line-start
            // windows get by construction: the preceding character must
            // not fuse an identifier, and the last needle line obeys the
            // bounded follow rule — or the raw scan certifies a quoted
            // line that does not exist in the file.
            const leadingOk = !/[A-Za-z0-9_$]/.test(haystack[idx - 1]);
            if (leadingOk && followRuleOk(haystack, idx + needle.length)) {
              locationMatches++;
            }
          }
          idx = haystack.indexOf(needle, idx + 1);
        }
      } else {
        // The same bounded follow rule the multi-line last line applies,
        // plus the leading-edge rule: a bare indexOf fuses tokens in BOTH
        // directions ('return x' into 'return x2;', 'bar()' into
        // 'foobar()') unless the hit's edges sit at a line/token boundary,
        // and would certify a quoted line that does not exist in the file.
        locationMatches = 0;
        let idx = haystack.indexOf(needle);
        while (idx !== -1) {
          const prev = idx > 0 ? haystack[idx - 1] : '';
          const leadingOk = prev === '' || !/[A-Za-z0-9_$]/.test(prev);
          if (leadingOk && followRuleOk(haystack, idx + needle.length)) {
            locationMatches++;
          }
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
