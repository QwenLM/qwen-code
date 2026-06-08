/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Plan Approval Gate orchestrator.
 *
 * Runs three parallel gate review agents (request_fit, system_fit,
 * execution_readiness), merges their findings deterministically, and
 * produces a single {@link GateDecision}.
 *
 * This module is called from `ExitPlanModeToolInvocation.execute()` when
 * the pre-plan mode is AUTO or YOLO.
 */

import type { Config } from '../config/config.js';
import type {
  GateAgentName,
  GateAgentResult,
  GateFinding,
  MergedGateFinding,
  GateDecision,
  EvidenceBundle,
} from './types.js';
import {
  GATE_AGENT_NAMES,
  CAPPED_REVIEW_LIMIT,
  MAX_AGENT_RETRIES,
  CAP_ESCALATION_LABELS,
  maxSeverity,
} from './types.js';
import { runGateAgent } from './gateReviewAgents.js';
import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('PLAN_APPROVAL_GATE');

// ── Public entry point ─────────────────────────────────────────────────

/**
 * Run a single round of the Plan Approval Gate. The caller
 * (ExitPlanModeTool) is responsible for the outer capped/uncapped loop
 * and for persisting the gate state between rounds.
 */
export async function runPlanApprovalGate(
  config: Config,
  bundle: EvidenceBundle,
  signal: AbortSignal,
): Promise<GateDecision> {
  const gateState = config.getPlanGateState();
  if (!gateState) {
    return { kind: 'unavailable', reason: 'No active plan gate state' };
  }

  // ── Run agents in parallel, retrying only failures ───────────────
  const results = await runAgentsWithRetry(config, bundle, signal);

  // Check for total failure
  const unavailable = results.filter((r) => r === null);
  if (unavailable.length === GATE_AGENT_NAMES.length) {
    return {
      kind: 'unavailable',
      reason: 'All gate review agents failed after retries',
    };
  }

  const validResults = results.filter((r): r is GateAgentResult => r !== null);

  // If any single agent is unavailable after retries, fail-closed
  if (unavailable.length > 0) {
    const failedRoles = GATE_AGENT_NAMES.filter(
      (_role, i) => results[i] === null,
    );
    return {
      kind: 'unavailable',
      reason: `Gate agent(s) ${failedRoles.join(', ')} unavailable after ${MAX_AGENT_RETRIES} retries`,
    };
  }

  // ── Merge findings ───────────────────────────────────────────────
  const merged = mergeFindings(validResults);

  // Update gate state
  gateState.reviewCount++;
  gateState.lastFindings = merged;

  // ── Determine decision ───────────────────────────────────────────
  if (merged.length === 0) {
    return { kind: 'approved' };
  }

  // Collect questions from needs_user agents
  const questions: string[] = [];
  for (const result of validResults) {
    if (result.decision === 'needs_user') {
      for (const f of result.findings) {
        if (f.suggestedQuestion) {
          questions.push(f.suggestedQuestion);
        }
      }
    }
  }

  // needs_user outranks blocked
  const hasNeedsUser = validResults.some((r) => r.decision === 'needs_user');
  if (hasNeedsUser && questions.length > 0) {
    return { kind: 'needs_user', findings: merged, questions };
  }

  // Check cap
  const isCapped = gateState.gateMode === 'capped';
  const atCap = isCapped && gateState.reviewCount >= CAPPED_REVIEW_LIMIT;

  const hasBlocking = merged.some(
    (f) => f.severity === 'P1' || f.severity === 'P2',
  );
  const hasOnlyP3 = !hasBlocking;

  if (atCap) {
    if (hasOnlyP3) {
      // P3-only at cap: auto-approve with non-blocking notes
      return { kind: 'approved', nonBlockingFindings: merged };
    }
    // P1/P2 remaining at cap: escalate to user
    return {
      kind: 'cap_escalation',
      blockingFindings: merged.filter(
        (f) => f.severity === 'P1' || f.severity === 'P2',
      ),
    };
  }

  // Not at cap: any finding blocks (P1/P2/P3 all block pre-cap)
  return { kind: 'blocked', findings: merged };
}

// ── Parallel execution with per-agent retry ────────────────────────────

async function runAgentsWithRetry(
  config: Config,
  bundle: EvidenceBundle,
  signal: AbortSignal,
): Promise<Array<GateAgentResult | null>> {
  const promises = GATE_AGENT_NAMES.map((role) =>
    runSingleAgentWithRetry(config, role, bundle, signal),
  );
  return Promise.all(promises);
}

async function runSingleAgentWithRetry(
  config: Config,
  role: GateAgentName,
  bundle: EvidenceBundle,
  signal: AbortSignal,
): Promise<GateAgentResult | null> {
  for (let attempt = 1; attempt <= MAX_AGENT_RETRIES; attempt++) {
    if (signal.aborted) {
      debugLogger.warn(`Gate agent ${role} skipped: signal already aborted`);
      return null;
    }
    try {
      return await runGateAgent(config, role, bundle, signal);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      debugLogger.warn(
        `Gate agent ${role} attempt ${attempt}/${MAX_AGENT_RETRIES} failed: ${msg}`,
      );
      if (attempt === MAX_AGENT_RETRIES) {
        debugLogger.error(
          `Gate agent ${role} exhausted all ${MAX_AGENT_RETRIES} retries`,
        );
        return null;
      }
    }
  }
  return null;
}

// ── Deterministic finding merge ────────────────────────────────────────

/**
 * Conservative merge across all agent results.
 *
 * - Duplicates (same issue text after normalization) are collapsed,
 *   keeping the highest severity and accumulating reportedBy.
 * - Stable GF-N ids are assigned in order of first appearance.
 * - No arbiter, no voting. Every finding survives unless it's a
 *   textual duplicate.
 */
export function mergeFindings(results: GateAgentResult[]): MergedGateFinding[] {
  const byKey = new Map<string, MergedGateFinding>();
  const order: string[] = [];

  for (const result of results) {
    for (const finding of result.findings) {
      const key = normalizeFindingKey(finding);
      const existing = byKey.get(key);
      if (existing) {
        existing.severity = maxSeverity(existing.severity, finding.severity);
        if (!existing.reportedBy.includes(result.agent)) {
          existing.reportedBy.push(result.agent);
        }
        // Keep more detailed rationale
        if (finding.rationale.length > existing.rationale.length) {
          existing.rationale = finding.rationale;
        }
        if (finding.suggestedFix && !existing.suggestedFix) {
          existing.suggestedFix = finding.suggestedFix;
        }
        if (finding.suggestedQuestion && !existing.suggestedQuestion) {
          existing.suggestedQuestion = finding.suggestedQuestion;
        }
      } else {
        const merged: MergedGateFinding = {
          id: '', // assigned below
          severity: finding.severity,
          issue: finding.issue,
          rationale: finding.rationale,
          suggestedFix: finding.suggestedFix,
          suggestedQuestion: finding.suggestedQuestion,
          reportedBy: [result.agent],
        };
        byKey.set(key, merged);
        order.push(key);
      }
    }
  }

  // Assign stable ids in order of first appearance
  return order.map((key, i) => {
    const finding = byKey.get(key)!;
    finding.id = `GF-${i + 1}`;
    return finding;
  });
}

function normalizeFindingKey(finding: GateFinding): string {
  return finding.issue.toLowerCase().replace(/\s+/g, ' ').trim();
}

// ── Formatting helpers for exit_plan_mode responses ────────────────────

export function formatBlockedResponse(
  decision: GateDecision & { kind: 'blocked' },
): string {
  const lines = [
    'Plan Approval Gate: **blocked**. The following issues must be resolved before the plan can be executed:\n',
  ];
  for (const f of decision.findings) {
    lines.push(
      `- **${f.id}** [${f.severity}]: ${f.issue}\n  _Rationale:_ ${f.rationale}`,
    );
    if (f.suggestedFix) {
      lines.push(`  _Suggested fix:_ ${f.suggestedFix}`);
    }
  }
  lines.push(
    '\nRevise the plan to address each finding, then call exit_plan_mode again. Include a resolutionSummary referencing each finding id (e.g. GF-1).',
  );
  return lines.join('\n');
}

export function formatNeedsUserResponse(
  decision: GateDecision & { kind: 'needs_user' },
): string {
  const lines = [
    'Plan Approval Gate: **needs_user**. The gate requires user input before it can approve.\n',
  ];
  for (const f of decision.findings) {
    lines.push(`- **${f.id}** [${f.severity}]: ${f.issue}`);
  }
  lines.push('\nSuggested questions to ask the user:');
  for (const q of decision.questions) {
    lines.push(`- ${q}`);
  }
  lines.push(
    '\nUse AskUserQuestion with metadata `{ source: "plan_gate_needs_user" }` to ask the user, then revise the plan and call exit_plan_mode again.',
  );
  return lines.join('\n');
}

export function formatCapEscalationResponse(
  decision: GateDecision & { kind: 'cap_escalation' },
): string {
  const lines = [
    `Plan Approval Gate: **cap reached** with ${decision.blockingFindings.length} blocking finding(s) remaining.\n`,
    'You must present these to the user via AskUserQuestion with metadata `{ source: "plan_gate_cap" }`.\n',
    'The question body must list the remaining blocking findings:\n',
  ];
  for (const f of decision.blockingFindings) {
    lines.push(
      `- **${f.id}** [${f.severity}]: ${f.issue}\n  _Rationale:_ ${f.rationale}`,
    );
  }
  lines.push(
    '\nProvide these options (the UI automatically provides a free-text "Other" input):',
    `1. "${CAP_ESCALATION_LABELS.CONTINUE}" — keep iterating with the gate (uncapped)`,
    `2. "${CAP_ESCALATION_LABELS.APPROVE}" — user override, skip the gate and execute`,
  );
  return lines.join('\n');
}

export function formatUnavailableResponse(
  decision: GateDecision & { kind: 'unavailable' },
): string {
  return `Plan Approval Gate: **unavailable** — ${decision.reason}. Staying in plan mode. The gate cannot approve autonomous execution; the user may need to intervene.`;
}

export function formatApprovedNotes(findings: MergedGateFinding[]): string {
  if (findings.length === 0) return '';
  const lines = ['Non-blocking review notes (P3, not required to address):\n'];
  for (const f of findings) {
    lines.push(`- **${f.id}** [${f.severity}]: ${f.issue}`);
  }
  return lines.join('\n');
}
