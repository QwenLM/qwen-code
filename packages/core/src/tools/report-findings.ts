/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// `report_findings`: the review findings as a typed contract to the client,
// instead of a Markdown convention.
//
// A review's findings already exist as data once — the `qwen review findings`
// artifact — but that file lives on disk, registered after the fact via
// `record_artifact`. Every client rendering the session live (the terminal UI,
// the Web Shell transcript, ACP hosts) saw only the prose restatement, which
// is exactly the transcription surface the artifact exists to close. This tool
// is the in-band half of the same contract: one call, `{level, findings[]}`,
// values copied from the artifact, rendered by the host UI as a per-finding
// list.
//
// The second call is the reason the first is trustworthy: after fixes are
// applied, the reporter calls again with every finding carrying an `outcome`,
// and — like the artifact's own `--outcomes` merge — a PARTIAL outcome set is
// refused. A fixer that applies six of nine findings and reports six has not
// lied about any one of them; it has silently shortened the list — so an
// outcome call is also held to the active report's identity: the same ids,
// none dropped, none added.

import type { ToolInvocation, ToolResult, ReportedFinding } from './tools.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';
import { ToolDisplayNames, ToolNames } from './tool-names.js';
import { hasControlCharacter } from './record-artifact.js';

// These enum spellings have two other deliberate copies: the findings
// artifact (`packages/cli/src/commands/review/findings.ts`, which re-exports these) and
// the Web Shell renderer (`CodeReviewArtifactDetail.tsx`, a browser bundle
// that must not import Node-side packages and fails closed on unknown
// values). A value added here must be added to the renderer copy in the same
// change.
/** The severity ladder, most severe first — this array IS the sort order. */
export const FINDING_SEVERITIES = [
  'Critical',
  'Suggestion',
  'Nice to have',
] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

export const FINDING_CONFIDENCES = ['high', 'low'] as const;
export type FindingConfidence = (typeof FINDING_CONFIDENCES)[number];

export const FINDING_OUTCOMES = [
  'fixed',
  'skipped',
  'no_change_needed',
] as const;
export type FindingOutcome = (typeof FINDING_OUTCOMES)[number];

export const FINDING_SOURCES = [
  'review',
  'build',
  'test',
  'probe',
  'lint',
] as const;
export type FindingSource = (typeof FINDING_SOURCES)[number];

export const REPORT_FINDINGS_LEVELS = ['low', 'medium', 'high'] as const;
export type ReportFindingsLevel = (typeof REPORT_FINDINGS_LEVELS)[number];

export const REPORT_FINDINGS_MAX = 50;
export const SHORT_SUMMARY_MAX = 60;
// The artifact and the repository set the path domain: repo-relative paths
// run to the filesystem limit (PATH_MAX, 4096), and the artifact keeps any
// one of them — a narrower cap refused whole lists the artifact preserves,
// and truncating a path would identify a different location.
export const REPORT_FINDINGS_FILE_MAX = 4096;

/** `shortSummary`, when the caller did not supply one within the cap. */
export function compressFindingSummary(
  summary: string,
  max = SHORT_SUMMARY_MAX,
): string {
  // Collapse whitespace first: a summary that wrapped across lines in the source
  // prose would otherwise carry its newlines into a single-line list cell.
  const flat = summary.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  // Cut on a word boundary when one is reasonably near the limit, so the label
  // reads as a clause rather than a severed word. `max - 1` leaves room for
  // the ellipsis, which is one character (U+2026), not three dots. The hard cut
  // backs off one unit when it would land inside a surrogate pair — an
  // unpaired high surrogate is not a character, and the codebase's other
  // truncation paths (terminal sanitizing, display compaction) all cut on
  // code-point boundaries.
  let head = flat.slice(0, max - 1);
  const lastUnit = head.charCodeAt(head.length - 1);
  if (lastUnit >= 0xd800 && lastUnit <= 0xdbff) {
    head = head.slice(0, -1);
  }
  const space = head.lastIndexOf(' ');
  const cut = space >= max * 0.6 ? head.slice(0, space) : head;
  return `${cut.trimEnd()}…`;
}

export interface ReportFindingsFindingParams {
  id?: string;
  severity: FindingSeverity;
  confidence?: FindingConfidence;
  source?: FindingSource;
  file: string;
  line?: number;
  summary: string;
  shortSummary?: string;
  failureScenario: string;
  category?: string;
  outcome?: FindingOutcome;
  outcomeNote?: string;
}

export interface ReportFindingsParams {
  level?: ReportFindingsLevel;
  findings: ReportFindingsFindingParams[];
}

const DESCRIPTION = `Reports code-review findings as typed data so clients (the terminal UI, the Web Shell, ACP hosts) can render a per-finding list. Use it only when an active review flow (such as the bundled review skill) instructs you to report findings with it; otherwise present findings as ordinary text. Call it once per report with the complete list, most severe first — a later call replaces the whole list, it never appends. When the review wrote a findings artifact, copy each field verbatim from it (id, severity, confidence, source, file/line, summary, shortSummary, failureScenario, category); do not re-derive or re-word values — the artifact is the oracle.

After fixes are applied — at the review's own fix step, or ANY later time in the session a reported finding's disposition changes — call it again with the same findings, each carrying "outcome" ("fixed", "skipped", or "no_change_needed"; "outcomeNote" for the reason). Client per-finding status trusts only a call that carries outcomes, and a call where some findings carry an outcome and others do not is refused: account for every finding.

This tool renders data for the client and nothing else: it persists nothing, decides no verdict, and a failure is a UI-delivery failure — disclose it and move on without changing the review's artifacts or verdict.`;

const FINDING_ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: {
      type: 'string',
      maxLength: 64,
      description:
        'The findings artifact id (e.g. "R1-2"), when the review produced one.',
    },
    severity: {
      type: 'string',
      enum: [...FINDING_SEVERITIES],
    },
    confidence: {
      type: 'string',
      enum: [...FINDING_CONFIDENCES],
      description:
        'Verification confidence. Omit on an unverified (low-effort) pass.',
    },
    source: {
      type: 'string',
      enum: [...FINDING_SOURCES],
      description: 'Where the finding came from. Defaults to "review".',
    },
    file: {
      type: 'string',
      maxLength: REPORT_FINDINGS_FILE_MAX,
      description:
        'Repo-relative path, or the review\'s "(body)" stand-in for an unanchored finding.',
    },
    line: {
      type: 'integer',
      minimum: 1,
    },
    summary: {
      type: 'string',
      maxLength: 2000,
      description: 'One sentence stating the defect.',
    },
    shortSummary: {
      type: 'string',
      description: `Compressed label for a compact list UI (<= ${SHORT_SUMMARY_MAX} characters; longer values are compressed, and it is derived from "summary" when absent).`,
    },
    failureScenario: {
      type: 'string',
      maxLength: 4000,
      description: 'The concrete trigger and wrong outcome.',
    },
    category: {
      type: 'string',
      maxLength: 64,
      description:
        'Free-form kebab-case tag ("correctness", "security", "test-coverage", …).',
    },
    outcome: {
      type: 'string',
      enum: [...FINDING_OUTCOMES],
      description:
        'Set ONLY on a re-report after fixes were applied: what happened to this finding. All findings in the call must carry one, or none.',
    },
    outcomeNote: {
      type: 'string',
      maxLength: 1000,
      description: 'The fixer\'s reason — required reading for "skipped".',
    },
  },
  required: ['severity', 'file', 'summary', 'failureScenario'],
} as const;

class ReportFindingsInvocation extends BaseToolInvocation<
  ReportFindingsParams,
  ToolResult
> {
  constructor(
    params: ReportFindingsParams,
    // Identity is committed on successful delivery, not at build: the
    // scheduler builds every invocation of a batch up front and can still
    // discard it before execution (pre-validation cancellation, an aborted
    // signal), and a built-but-never-executed report must not replace the
    // identity the client actually received.
    private readonly commitActiveReport: (
      identity: ReadonlySet<string> | undefined,
    ) => void,
  ) {
    super(params);
  }

  override getDescription(): string {
    const n = this.params.findings.length;
    return `Report ${n} finding${n === 1 ? '' : 's'}`;
  }

  async execute(_signal: AbortSignal): Promise<ToolResult> {
    const findings = sortReportedFindings(
      this.params.findings.map(normalizeFinding),
    );
    const display = {
      type: 'findings_list' as const,
      ...(this.params.level ? { level: this.params.level } : {}),
      findings,
    };

    const bySeverity = FINDING_SEVERITIES.map((severity) => {
      const count = findings.filter((f) => f.severity === severity).length;
      return count > 0 ? `${count} ${severity}` : undefined;
    }).filter((part): part is string => part !== undefined);
    const withOutcomes =
      findings.length > 0 && findings[0].outcome
        ? ` with outcomes (${FINDING_OUTCOMES.map((outcome) => {
            const count = findings.filter((f) => f.outcome === outcome).length;
            return count > 0 ? `${count} ${outcome}` : undefined;
          })
            .filter(Boolean)
            .join(', ')})`
        : '';
    const summaryLine =
      findings.length === 0
        ? 'Reported an empty findings list to the client UI.'
        : `Reported ${findings.length} finding${findings.length === 1 ? '' : 's'} to the client UI (${bySeverity.join(', ')})${withOutcomes}.`;

    this.commitActiveReport(reportIdentity(this.params.findings));

    return {
      llmContent: `${summaryLine} Nothing was persisted; the review's findings artifact remains the canonical record.`,
      returnDisplay: display,
    };
  }
}

function normalizeFinding(raw: ReportFindingsFindingParams): ReportedFinding {
  const shortSource = raw.shortSummary?.trim() || raw.summary;
  return {
    ...(raw.id?.trim() ? { id: raw.id.trim() } : {}),
    severity: raw.severity,
    ...(raw.confidence ? { confidence: raw.confidence } : {}),
    ...(raw.source ? { source: raw.source } : {}),
    file: raw.file.trim(),
    ...(raw.line !== undefined ? { line: raw.line } : {}),
    summary: raw.summary.trim(),
    shortSummary: compressFindingSummary(shortSource),
    failureScenario: raw.failureScenario.trim(),
    ...(raw.category?.trim() ? { category: raw.category.trim() } : {}),
    ...(raw.outcome ? { outcome: raw.outcome } : {}),
    ...(raw.outcomeNote?.trim() ? { outcomeNote: raw.outcomeNote.trim() } : {}),
  };
}

/**
 * Severity, then confidence, then location — matching the artifact's own
 * `sortFindings` (code-unit file/id comparison, a missing line ranked first),
 * so the list a client renders and the artifact a reader opens agree about
 * order. The one extension: the artifact requires `confidence`, this contract
 * does not (an unverified low-effort pass omits it), and an absent confidence
 * ranks between `high` and `low`.
 */
function sortReportedFindings(
  findings: readonly ReportedFinding[],
): ReportedFinding[] {
  const confidenceRank = (c: ReportedFinding['confidence']): number =>
    c === 'high' ? 0 : c === undefined ? 1 : 2;
  return [...findings].sort((a, b) => {
    const severity =
      FINDING_SEVERITIES.indexOf(a.severity) -
      FINDING_SEVERITIES.indexOf(b.severity);
    if (severity !== 0) return severity;
    const confidence =
      confidenceRank(a.confidence) - confidenceRank(b.confidence);
    if (confidence !== 0) return confidence;
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    const line = (a.line ?? 0) - (b.line ?? 0);
    if (line !== 0) return line;
    const aId = a.id ?? '';
    const bId = b.id ?? '';
    return aId < bId ? -1 : aId > bId ? 1 : 0;
  });
}

export class ReportFindingsTool extends BaseDeclarativeTool<
  ReportFindingsParams,
  ToolResult
> {
  static readonly Name: string = ToolNames.REPORT_FINDINGS;

  // Id set of the most recent DELIVERED report whose findings all carried
  // ids, committed in the invocation's execute(). An outcome call replaces
  // the whole list, so it must match this identity in full; undefined when
  // there is no identity to join on (no report yet, or a low-effort report
  // without artifact ids).
  //
  // The gate is a contract about the live process, not a persisted one: the
  // tool instance is cached by the registry for the session, but a cold
  // session resume (--resume, a daemon or process restart) constructs a
  // fresh instance with no active identity. That is the documented limit of
  // the join — after a restart an outcome call is validated on its own
  // terms (all-or-nothing outcomes) instead of against the pre-restart
  // report — and the transcript surfaces render the same replacement (the
  // last delivered list wins) independently of this gate.
  private activeReportIds: ReadonlySet<string> | undefined;

  constructor() {
    super(
      ReportFindingsTool.Name,
      ToolDisplayNames.REPORT_FINDINGS,
      DESCRIPTION,
      Kind.Think,
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          level: {
            type: 'string',
            enum: [...REPORT_FINDINGS_LEVELS],
            description: 'The review effort the findings came from.',
          },
          findings: {
            type: 'array',
            maxItems: REPORT_FINDINGS_MAX,
            items: FINDING_ITEM_SCHEMA,
            description:
              'The complete findings list, most severe first. An empty array is a valid "nothing found" report.',
          },
        },
        required: ['findings'],
      },
      true,
      false,
      true,
      false,
      'review findings report code-review severity outcome fixed',
    );
  }

  protected override validateToolParamValues(
    params: ReportFindingsParams,
  ): string | null {
    const seenIds = new Set<string>();
    let withOutcome = 0;
    for (const [index, finding] of params.findings.entries()) {
      for (const [field, value] of Object.entries({
        id: finding.id,
        file: finding.file,
        summary: finding.summary,
        shortSummary: finding.shortSummary,
        failureScenario: finding.failureScenario,
        category: finding.category,
        outcomeNote: finding.outcomeNote,
      })) {
        if (value === undefined) continue;
        if (
          hasControlCharacter(
            value,
            field === 'summary' ||
              field === 'failureScenario' ||
              field === 'outcomeNote',
          )
        ) {
          return `Finding at index ${index}: "${field}" contains control characters`;
        }
      }
      if (!finding.file.trim()) {
        return `Finding at index ${index}: "file" must not be empty`;
      }
      if (!finding.summary.trim()) {
        return `Finding at index ${index}: "summary" must not be empty`;
      }
      if (!finding.failureScenario.trim()) {
        return `Finding at index ${index}: "failureScenario" must not be empty`;
      }
      if (finding.line !== undefined && !Number.isSafeInteger(finding.line)) {
        return `Finding at index ${index}: "line" must be an integer within JavaScript's safe range`;
      }
      if (finding.outcome === 'skipped' && !finding.outcomeNote?.trim()) {
        return `Finding at index ${index}: "outcomeNote" is required when "outcome" is "skipped" — the reader is owed the reason for work not done`;
      }
      const id = finding.id?.trim();
      if (id) {
        if (seenIds.has(id)) {
          return `Finding at index ${index}: duplicate id "${id}"`;
        }
        seenIds.add(id);
      }
      if (finding.outcome) withOutcome++;
    }
    if (withOutcome > 0 && withOutcome < params.findings.length) {
      return `${withOutcome} of ${params.findings.length} findings carry an "outcome". Outcomes account for every finding or none: a partial set silently shortens the list. Add the missing outcomes (or remove them all) and call again.`;
    }
    const activeIds = this.activeReportIds;
    if (
      withOutcome === params.findings.length &&
      params.findings.length > 0 &&
      activeIds !== undefined
    ) {
      const newIds = new Set(
        params.findings.map((finding) => finding.id?.trim() ?? ''),
      );
      const missing = [...activeIds].filter((id) => !newIds.has(id));
      if (missing.length > 0) {
        return `Outcome report drops ${missing.length} finding(s) from the active report: ${missing
          .map((id) => JSON.stringify(id))
          .join(
            ', ',
          )}. An outcome call replaces the whole list — re-report every active finding with its outcome.`;
      }
      const unknown = [...newIds].filter(
        (id) => id === '' || !activeIds.has(id),
      );
      if (unknown.length > 0) {
        return `Outcome report carries finding(s) the active report does not have: ${unknown
          .map((id) => (id === '' ? '(missing id)' : JSON.stringify(id)))
          .join(', ')}. Outcomes join back to the active report by id.`;
      }
    }
    return null;
  }

  protected createInvocation(
    params: ReportFindingsParams,
  ): ToolInvocation<ReportFindingsParams, ToolResult> {
    return new ReportFindingsInvocation(params, (identity) => {
      this.activeReportIds = identity;
    });
  }
}

/**
 * The identity an outcome replacement is held to: the id set of a report
 * whose findings ALL carry ids. A report with any id-less finding (a
 * low-effort pass has no artifact ids) has no identity to join on, so a
 * later outcome call is accepted on its own terms.
 */
function reportIdentity(
  findings: readonly ReportFindingsFindingParams[],
): ReadonlySet<string> | undefined {
  const ids = findings.map((finding) => finding.id?.trim() ?? '');
  if (findings.length === 0 || ids.some((id) => id === '')) {
    return undefined;
  }
  return new Set(ids);
}
