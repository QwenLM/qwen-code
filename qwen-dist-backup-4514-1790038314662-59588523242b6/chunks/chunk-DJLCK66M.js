// Force strict mode and setup for ESM
"use strict";
import {
  hasControlCharacter
} from "./chunk-FXPP7VLM.js";
import {
  BaseDeclarativeTool,
  BaseToolInvocation
} from "./chunk-VPGRGNNH.js";
import {
  ToolDisplayNames,
  ToolNames
} from "./chunk-ERIBG3BX.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/tools/report-findings.ts
init_esbuild_shims();
var FINDING_SEVERITIES = [
  "Critical",
  "Suggestion",
  "Nice to have"
];
var FINDING_CONFIDENCES = ["high", "low"];
var FINDING_OUTCOMES = [
  "fixed",
  "skipped",
  "no_change_needed"
];
var FINDING_SOURCES = [
  "review",
  "build",
  "test",
  "probe",
  "lint"
];
var FINDING_DIRECTIONS = [
  "certifies-falsely",
  "fails-closed"
];
var FINDING_BASELINES = ["regression", "new-surface"];
var REPORT_FINDINGS_LEVELS = ["low", "medium", "high"];
var REPORT_FINDINGS_MAX = 50;
var SHORT_SUMMARY_MAX = 60;
var REPORT_FINDINGS_FILE_MAX = 4096;
function compressFindingSummary(summary, max = SHORT_SUMMARY_MAX) {
  const flat = summary.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  let head = flat.slice(0, max - 1);
  const lastUnit = head.charCodeAt(head.length - 1);
  if (lastUnit >= 55296 && lastUnit <= 56319) {
    head = head.slice(0, -1);
  }
  const space = head.lastIndexOf(" ");
  const cut = space >= max * 0.6 ? head.slice(0, space) : head;
  return `${cut.trimEnd()}\u2026`;
}
__name(compressFindingSummary, "compressFindingSummary");
var DESCRIPTION = `Reports code-review findings as typed data so clients (the terminal UI, the Web Shell, ACP hosts) can render a per-finding list. Use it only when an active review flow (such as the bundled review skill) instructs you to report findings with it; otherwise present findings as ordinary text. Call it once per report with the complete list, most severe first \u2014 a later call replaces the whole list, it never appends. When the review wrote a findings artifact, copy each field verbatim from it (id, severity, confidence, source, file/line, summary, shortSummary, failureScenario, category, direction, baseline); do not re-derive or re-word values \u2014 the artifact is the oracle.

After fixes are applied \u2014 at the review's own fix step, or ANY later time in the session a reported finding's disposition changes \u2014 call it again with the same findings, each carrying "outcome" ("fixed", "skipped", or "no_change_needed"; "outcomeNote" for the reason). Client per-finding status trusts only a call that carries outcomes, and a call where some findings carry an outcome and others do not is refused: account for every finding.

This tool renders data for the client and nothing else: it persists nothing, decides no verdict, and a failure is a UI-delivery failure \u2014 disclose it and move on without changing the review's artifacts or verdict.`;
var FINDING_ITEM_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: {
      type: "string",
      maxLength: 64,
      description: 'The findings artifact id (e.g. "R1-2"), when the review produced one.'
    },
    severity: {
      type: "string",
      enum: [...FINDING_SEVERITIES]
    },
    confidence: {
      type: "string",
      enum: [...FINDING_CONFIDENCES],
      description: "Verification confidence. Omit on an unverified (low-effort) pass."
    },
    source: {
      type: "string",
      enum: [...FINDING_SOURCES],
      description: 'Where the finding came from. Defaults to "review".'
    },
    file: {
      type: "string",
      maxLength: REPORT_FINDINGS_FILE_MAX,
      description: `Repo-relative path, or the review's "(body)" stand-in for an unanchored finding.`
    },
    line: {
      type: "integer",
      minimum: 1
    },
    summary: {
      type: "string",
      description: "One sentence stating the defect."
    },
    shortSummary: {
      type: "string",
      description: `Compressed label for a compact list UI (<= ${SHORT_SUMMARY_MAX} characters; longer values are compressed, and it is derived from "summary" when absent).`
    },
    failureScenario: {
      type: "string",
      maxLength: 4e3,
      description: "The concrete trigger and wrong outcome."
    },
    category: {
      type: "string",
      maxLength: 64,
      description: 'Free-form kebab-case tag ("correctness", "security", "test-coverage", \u2026).'
    },
    direction: {
      type: "string",
      enum: [...FINDING_DIRECTIONS],
      description: 'Which way a Critical fails, from the artifact: "certifies-falsely" (a wrong result presented as correct) or "fails-closed" (refuses, wedges or degrades without a wrong result). Omit when the artifact carries none.'
    },
    baseline: {
      type: "string",
      enum: [...FINDING_BASELINES],
      description: 'What a Critical is measured against, from the artifact: "regression" (the merge base handled the trigger correctly) or "new-surface" (the failing path does not exist at the merge base). Omit when the artifact carries none.'
    },
    outcome: {
      type: "string",
      enum: [...FINDING_OUTCOMES],
      description: "Set ONLY on a re-report after fixes were applied: what happened to this finding. All findings in the call must carry one, or none."
    },
    outcomeNote: {
      type: "string",
      maxLength: 1e3,
      description: `The fixer's reason \u2014 required reading for "skipped".`
    }
  },
  required: ["severity", "file", "summary", "failureScenario"]
};
var ReportFindingsInvocation = class extends BaseToolInvocation {
  constructor(params, commitActiveReport) {
    super(params);
    this.commitActiveReport = commitActiveReport;
  }
  static {
    __name(this, "ReportFindingsInvocation");
  }
  getDescription() {
    const n = this.params.findings.length;
    return `Report ${n} finding${n === 1 ? "" : "s"}`;
  }
  async execute(_signal) {
    const findings = sortReportedFindings(
      this.params.findings.map(normalizeFinding)
    );
    const display = {
      type: "findings_list",
      ...this.params.level ? { level: this.params.level } : {},
      findings
    };
    const bySeverity = FINDING_SEVERITIES.map((severity) => {
      const count = findings.filter((f) => f.severity === severity).length;
      return count > 0 ? `${count} ${severity}` : void 0;
    }).filter((part) => part !== void 0);
    const withOutcomes = findings.length > 0 && findings[0].outcome ? ` with outcomes (${FINDING_OUTCOMES.map((outcome) => {
      const count = findings.filter((f) => f.outcome === outcome).length;
      return count > 0 ? `${count} ${outcome}` : void 0;
    }).filter(Boolean).join(", ")})` : "";
    const summaryLine = findings.length === 0 ? "Reported an empty findings list to the client UI." : `Reported ${findings.length} finding${findings.length === 1 ? "" : "s"} to the client UI (${bySeverity.join(", ")})${withOutcomes}.`;
    this.commitActiveReport(reportIdentity(this.params.findings));
    return {
      llmContent: `${summaryLine} Nothing was persisted; the review's findings artifact remains the canonical record.`,
      returnDisplay: display
    };
  }
};
function normalizeFinding(raw) {
  const shortSource = raw.shortSummary?.trim() || raw.summary;
  return {
    ...raw.id?.trim() ? { id: raw.id.trim() } : {},
    severity: raw.severity,
    ...raw.confidence ? { confidence: raw.confidence } : {},
    ...raw.source ? { source: raw.source } : {},
    file: raw.file.trim(),
    ...raw.line !== void 0 ? { line: raw.line } : {},
    summary: raw.summary.trim(),
    shortSummary: compressFindingSummary(shortSource),
    failureScenario: raw.failureScenario.trim(),
    ...raw.category?.trim() ? { category: raw.category.trim() } : {},
    ...raw.direction ? { direction: raw.direction } : {},
    ...raw.baseline ? { baseline: raw.baseline } : {},
    ...raw.outcome ? { outcome: raw.outcome } : {},
    ...raw.outcomeNote?.trim() ? { outcomeNote: raw.outcomeNote.trim() } : {}
  };
}
__name(normalizeFinding, "normalizeFinding");
function sortReportedFindings(findings) {
  const confidenceRank = /* @__PURE__ */ __name((c) => c === "high" ? 0 : c === void 0 ? 1 : 2, "confidenceRank");
  return [...findings].sort((a, b) => {
    const severity = FINDING_SEVERITIES.indexOf(a.severity) - FINDING_SEVERITIES.indexOf(b.severity);
    if (severity !== 0) return severity;
    const confidence = confidenceRank(a.confidence) - confidenceRank(b.confidence);
    if (confidence !== 0) return confidence;
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    const line = (a.line ?? 0) - (b.line ?? 0);
    if (line !== 0) return line;
    const aId = a.id ?? "";
    const bId = b.id ?? "";
    return aId < bId ? -1 : aId > bId ? 1 : 0;
  });
}
__name(sortReportedFindings, "sortReportedFindings");
var ReportFindingsTool = class _ReportFindingsTool extends BaseDeclarativeTool {
  static {
    __name(this, "ReportFindingsTool");
  }
  static Name = ToolNames.REPORT_FINDINGS;
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
  activeReportIds;
  constructor() {
    super(
      _ReportFindingsTool.Name,
      ToolDisplayNames.REPORT_FINDINGS,
      DESCRIPTION,
      "think" /* Think */,
      {
        type: "object",
        additionalProperties: false,
        properties: {
          level: {
            type: "string",
            enum: [...REPORT_FINDINGS_LEVELS],
            description: "The review effort the findings came from."
          },
          findings: {
            type: "array",
            maxItems: REPORT_FINDINGS_MAX,
            items: FINDING_ITEM_SCHEMA,
            description: 'The complete findings list, most severe first. An empty array is a valid "nothing found" report.'
          }
        },
        required: ["findings"]
      },
      true,
      false,
      true,
      false,
      "review findings report code-review severity outcome fixed"
    );
  }
  validateToolParamValues(params) {
    const seenIds = /* @__PURE__ */ new Set();
    let withOutcome = 0;
    for (const [index, finding] of params.findings.entries()) {
      for (const [field, value] of Object.entries({
        id: finding.id,
        file: finding.file,
        summary: finding.summary,
        shortSummary: finding.shortSummary,
        failureScenario: finding.failureScenario,
        category: finding.category,
        outcomeNote: finding.outcomeNote
      })) {
        if (value === void 0) continue;
        if (hasControlCharacter(
          value,
          field === "summary" || field === "failureScenario" || field === "outcomeNote"
        )) {
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
      if (finding.line !== void 0 && !Number.isSafeInteger(finding.line)) {
        return `Finding at index ${index}: "line" must be an integer within JavaScript's safe range`;
      }
      if (finding.outcome === "skipped" && !finding.outcomeNote?.trim()) {
        return `Finding at index ${index}: "outcomeNote" is required when "outcome" is "skipped" \u2014 the reader is owed the reason for work not done`;
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
    if (withOutcome === params.findings.length && params.findings.length > 0 && activeIds !== void 0) {
      const newIds = new Set(
        params.findings.map((finding) => finding.id?.trim() ?? "")
      );
      const missing = [...activeIds].filter((id) => !newIds.has(id));
      if (missing.length > 0) {
        return `Outcome report drops ${missing.length} finding(s) from the active report: ${missing.map((id) => JSON.stringify(id)).join(
          ", "
        )}. An outcome call replaces the whole list \u2014 re-report every active finding with its outcome.`;
      }
      const unknown = [...newIds].filter(
        (id) => id === "" || !activeIds.has(id)
      );
      if (unknown.length > 0) {
        return `Outcome report carries finding(s) the active report does not have: ${unknown.map((id) => id === "" ? "(missing id)" : JSON.stringify(id)).join(", ")}. Outcomes join back to the active report by id.`;
      }
    }
    return null;
  }
  createInvocation(params) {
    return new ReportFindingsInvocation(params, (identity) => {
      this.activeReportIds = identity;
    });
  }
};
function reportIdentity(findings) {
  const ids = findings.map((finding) => finding.id?.trim() ?? "");
  if (findings.length === 0 || ids.some((id) => id === "")) {
    return void 0;
  }
  return new Set(ids);
}
__name(reportIdentity, "reportIdentity");

export {
  FINDING_SEVERITIES,
  FINDING_CONFIDENCES,
  FINDING_OUTCOMES,
  FINDING_SOURCES,
  FINDING_DIRECTIONS,
  FINDING_BASELINES,
  REPORT_FINDINGS_LEVELS,
  REPORT_FINDINGS_MAX,
  SHORT_SUMMARY_MAX,
  REPORT_FINDINGS_FILE_MAX,
  compressFindingSummary,
  ReportFindingsTool
};
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
