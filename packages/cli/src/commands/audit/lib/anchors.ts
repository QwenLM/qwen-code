/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Write-time anchor resolution for /audit, per docs/design/legacy-code-audit.md:
// every finding's quoted snippet is resolved against the audited files and
// the registered deep-read callers before the report ships. A snippet that
// does not resolve uniquely is refused or downgraded — never silently
// shipped — and every refusal is recorded in the report header.

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

const FINDING_RE = /^###\s+\[(Critical|Suggestion)\]\s+(.+)$/;

/** Parse the finding blocks of a report draft: `### [sev] title` opens a
 *  block; `- Location:` and `- Anchor:` fields inside it. An anchor value
 *  runs to the next `- ` field or the next finding header. */
export function parseReportFindings(report: string): ReportFinding[] {
  const findings: ReportFinding[] = [];
  const lines = report.split('\n');
  let current: (ReportFinding & { anchorLines: string[] }) | null = null;
  let inAnchor = false;
  const push = (): void => {
    if (!current) return;
    current.anchor = current.anchorLines.join('\n').trim();
    if (current.location && current.anchor) {
      findings.push({
        title: current.title,
        severity: current.severity,
        location: current.location,
        anchor: current.anchor,
      });
    }
    current = null;
  };
  for (const line of lines) {
    const header = FINDING_RE.exec(line);
    if (header) {
      push();
      current = {
        title: header[2].trim(),
        severity: header[1],
        location: '',
        anchor: '',
        anchorLines: [],
      };
      inAnchor = false;
      continue;
    }
    if (!current) continue;
    const field = /^-\s+(Location|Anchor):\s*(.*)$/.exec(line);
    if (field) {
      inAnchor = field[1] === 'Anchor';
      if (field[1] === 'Location') {
        current.location = field[2].replace(/:\d+(:\d+)?$/, '').trim();
      } else {
        current.anchorLines.push(field[2]);
      }
      continue;
    }
    if (inAnchor && /^-\s+\w/.test(line)) {
      inAnchor = false;
      continue;
    }
    if (inAnchor) {
      current.anchorLines.push(line);
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
    const isCaller = callerSet.has(finding.location);
    if (!isCaller && !allowed.has(finding.location)) {
      return { finding, verdict: 'out-of-scope', matchCount: 0 };
    }
    const abs = isCaller
      ? finding.location
      : join(plan.targetPathAbsolute, finding.location);
    let content: string;
    try {
      content = readFileSync(abs, 'utf8');
    } catch {
      return { finding, verdict: 'unresolved', matchCount: 0 };
    }
    let matchCount = 0;
    let idx = content.indexOf(finding.anchor);
    while (idx !== -1) {
      matchCount++;
      idx = content.indexOf(finding.anchor, idx + 1);
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
