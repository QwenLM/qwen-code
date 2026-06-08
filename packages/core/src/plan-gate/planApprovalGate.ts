/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Plan Approval Gate orchestrator.
 *
 * Runs a single gate review agent, assigns stable finding ids, and
 * produces a {@link GateDecision}.
 *
 * This module is called from `ExitPlanModeToolInvocation.execute()` when
 * the pre-plan mode is AUTO or YOLO.
 */

import type { Config } from '../config/config.js';
import type {
  GateAgentResult,
  MergedGateFinding,
  GateDecision,
  EvidenceBundle,
} from './types.js';
import {
  CAPPED_REVIEW_LIMIT,
  MAX_AGENT_RETRIES,
  CAP_ESCALATION_LABELS,
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

  // ── Run single agent with retry ──────────────────────────────────
  const result = await runAgentWithRetry(config, bundle, signal);

  if (result === null) {
    return {
      kind: 'unavailable',
      reason: `Gate review agent unavailable after ${MAX_AGENT_RETRIES} retries`,
    };
  }

  // ── Assign stable finding ids ────────────────────────────────────
  const findings = assignFindingIds(result);

  // Update gate state
  gateState.reviewCount++;
  gateState.lastFindings = findings;

  // ── Determine decision ───────────────────────────────────────────
  if (findings.length === 0) {
    return { kind: 'approved' };
  }

  // Collect questions from needs_user
  if (result.decision === 'needs_user') {
    const questions = result.findings
      .filter((f) => f.suggestedQuestion)
      .map((f) => f.suggestedQuestion!);
    if (questions.length > 0) {
      return { kind: 'needs_user', findings, questions };
    }
  }

  // Check cap
  const isCapped = gateState.gateMode === 'capped';
  const atCap = isCapped && gateState.reviewCount >= CAPPED_REVIEW_LIMIT;

  const hasBlocking = findings.some(
    (f) => f.severity === 'P1' || f.severity === 'P2',
  );

  if (atCap) {
    if (!hasBlocking) {
      return { kind: 'approved', nonBlockingFindings: findings };
    }
    return {
      kind: 'cap_escalation',
      blockingFindings: findings.filter(
        (f) => f.severity === 'P1' || f.severity === 'P2',
      ),
    };
  }

  // Not at cap: any finding blocks (P1/P2/P3 all block pre-cap)
  return { kind: 'blocked', findings };
}

// ── Agent execution with retry ─────────────────────────────────────────

async function runAgentWithRetry(
  config: Config,
  bundle: EvidenceBundle,
  signal: AbortSignal,
): Promise<GateAgentResult | null> {
  for (let attempt = 1; attempt <= MAX_AGENT_RETRIES; attempt++) {
    if (signal.aborted) {
      debugLogger.warn('Gate agent skipped: signal already aborted');
      return null;
    }
    try {
      return await runGateAgent(config, bundle, signal);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      debugLogger.warn(
        `Gate agent attempt ${attempt}/${MAX_AGENT_RETRIES} failed: ${msg}`,
      );
      if (attempt === MAX_AGENT_RETRIES) {
        debugLogger.error(
          `Gate agent exhausted all ${MAX_AGENT_RETRIES} retries`,
        );
        return null;
      }
    }
  }
  return null;
}

// ── Finding id assignment ──────────────────────────────────────────────

/**
 * Assigns stable GF-N ids to findings from the single agent's result.
 */
export function assignFindingIds(result: GateAgentResult): MergedGateFinding[] {
  return result.findings.map((finding, i) => ({
    id: `GF-${i + 1}`,
    severity: finding.severity,
    issue: finding.issue,
    rationale: finding.rationale,
    suggestedFix: finding.suggestedFix,
    suggestedQuestion: finding.suggestedQuestion,
  }));
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
