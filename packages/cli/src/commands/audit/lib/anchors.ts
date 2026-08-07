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

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FilesPlan } from './files-plan.js';

export interface ReportFinding {
  title: string;
  severity: string;
  /** The cited file, audit-relative (or an absolute registered caller). */
  location: string;
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
// HEADER_SHAPED_RE and fails closed.
const FINDING_RE = /^#{2,4}\s+\[(critical|suggestion)\]\s+(.+)$/i;
const HEADER_SHAPED_RE = /^#{1,6}\s*\[/;
const FIELD_RE = /^-\s+(Location|Anchor):\s*(.*)$/;
// Anchor collection ends only on a RECOGNIZED finding field: a column-0
// `- ` line inside the quoted snippet (a YAML/markdown list item) must not
// truncate the anchor.
const FIELD_END_RE = /^-\s+(Issue|Failure scenario|Severity|Location|Anchor):/;

/** Parse the finding blocks of a report draft: `### [sev] title` opens a
 *  block; `- Location:` and `- Anchor:` fields inside it. An anchor value
 *  runs to the next recognized field or the next finding header. Fails
 *  closed: a header-shaped line that yields no finding emits a synthetic
 *  entry (its raw text as the title), and a block whose location or anchor
 *  field is missing keeps its empty fields — resolveAnchors verdicts both
 *  `unresolved`, so exit 4 fires and the handling path runs. */
export function parseReportFindings(report: string): ReportFinding[] {
  const findings: ReportFinding[] = [];
  const lines = report.split('\n');
  let current: (ReportFinding & { anchorLines: string[] }) | null = null;
  let inAnchor = false;
  const push = (): void => {
    if (!current) return;
    current.anchor = current.anchorLines.join('\n').trim();
    findings.push({
      title: current.title,
      severity: current.severity,
      location: current.location,
      anchor: current.anchor,
    });
    current = null;
  };
  for (const raw of lines) {
    const line = raw.trim();
    const header = FINDING_RE.exec(line);
    if (header) {
      push();
      current = {
        title: header[2].trim(),
        severity:
          header[1].toLowerCase() === 'critical' ? 'Critical' : 'Suggestion',
        location: '',
        anchor: '',
        anchorLines: [],
      };
      inAnchor = false;
      continue;
    }
    if (HEADER_SHAPED_RE.test(line)) {
      push();
      findings.push({ title: line, severity: '', location: '', anchor: '' });
      continue;
    }
    if (!current) continue;
    const field = FIELD_RE.exec(line);
    if (field) {
      inAnchor = field[1] === 'Anchor';
      if (field[1] === 'Location') {
        current.location = field[2].replace(/:\d+(:\d+)?$/, '').trim();
      } else {
        current.anchorLines.push(field[2]);
      }
      continue;
    }
    if (inAnchor && FIELD_END_RE.test(line)) {
      inAnchor = false;
      continue;
    }
    if (inAnchor) {
      current.anchorLines.push(raw.replace(/\r$/, ''));
    }
  }
  push();
  return findings;
}

/** Resolve each finding's anchor against the cited file. The resolution set
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
    // header can never resolve.
    if (!finding.location || !finding.anchor) {
      return { finding, verdict: 'unresolved', matchCount: 0 };
    }
    const isCaller = callerSet.has(finding.location);
    if (!isCaller && !allowed.has(finding.location)) {
      return { finding, verdict: 'out-of-scope', matchCount: 0 };
    }
    const abs = isCaller
      ? finding.location
      : join(plan.targetPathAbsolute, finding.location);
    let haystack: string;
    try {
      haystack = readFileSync(abs, 'utf8');
    } catch {
      return { finding, verdict: 'unresolved', matchCount: 0 };
    }
    // Multi-line anchors join with \n; a CRLF file (Windows checkouts,
    // vendored .bat/.cmd) must resolve against the same anchor, so
    // normalize both sides to LF before matching.
    haystack = haystack.replace(/\r\n/g, '\n');
    const needle = finding.anchor.replace(/\r\n/g, '\n');
    let matchCount = 0;
    let idx = haystack.indexOf(needle);
    while (idx !== -1) {
      matchCount++;
      idx = haystack.indexOf(needle, idx + 1);
    }
    const verdict: AnchorVerdict =
      matchCount === 0
        ? 'unresolved'
        : matchCount === 1
          ? 'resolved'
          : 'ambiguous';
    return { finding, verdict, matchCount };
  });
}
