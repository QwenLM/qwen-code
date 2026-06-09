/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import { ApprovalMode } from '../config/config.js';
import { ContextState } from '../agents/runtime/agent-headless.js';
import { AgentTerminateMode } from '../agents/runtime/agent-types.js';
import { createApprovalModeOverride } from '../tools/agent/agent.js';
import type { GateAgentResult, EvidenceBundle } from './types.js';
import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('GATE_REVIEW_AGENTS');

// ── Gate agent prompt ──────────────────────────────────────────────────

function buildReviewPrompt(evidence: string): string {
  return `You are a Plan Design Reviewer for the Plan Approval Gate. Review the plan across three dimensions:

1. **Request Fit** — Does the plan fulfill every part of the user's original request and respect all explicit constraints? Does it do anything the user explicitly asked NOT to do?
2. **System Fit** — Does the plan align with the codebase structure, file paths, function names, permission model, and integration boundaries found during investigation?
3. **Execution Readiness** — Is each step concrete enough to implement without guessing? Is there a verification/test path? Are risks handled? Are there steps that still need a human decision?

The user's original request and later additions always outrank the plan text.

${evidence}

Respond with ONLY a JSON object matching this schema (no markdown fences):
{
  "agent": "plan_reviewer",
  "decision": "pass" | "blocked" | "needs_user" | "unavailable",
  "findings": [
    {
      "localId": "GF-1",
      "severity": "P1" | "P2" | "P3",
      "issue": "...",
      "rationale": "...",
      "suggestedFix": "..." (optional),
      "suggestedQuestion": "..." (optional, for needs_user)
    }
  ],
  "limitations": ["..."],
  "reviewedEvidence": ["..."]
}

Rules:
- "pass" means no findings at all.
- "blocked" means at least one finding exists.
- "needs_user" means you need information from the user to make a judgement.
- "unavailable" only if you truly cannot produce a reliable review.
- P1: plan clearly violates the request or would lead to dangerous/wrong execution. P2: missing key design/verification elements. P3: minor ambiguity.
- Do NOT invent confidence scores. If uncertain, use needs_user.`;
}

// ── Evidence formatting ────────────────────────────────────────────────

export function formatEvidence(bundle: EvidenceBundle): string {
  const sections: string[] = [];

  sections.push(`## Original User Request\n${bundle.originalRequest}`);

  sections.push(`## Current Plan\n${bundle.plan}`);

  if (bundle.researchSummary) {
    sections.push(`## Research Summary\n${bundle.researchSummary}`);
  }

  if (bundle.keyContext && bundle.keyContext.length > 0) {
    sections.push(`## Key Context\n${bundle.keyContext.join('\n')}`);
  }

  if (bundle.lastFindings && bundle.lastFindings.length > 0) {
    const findingsText = bundle.lastFindings
      .map((f) => `- ${f.id} [${f.severity}]: ${f.issue} — ${f.rationale}`)
      .join('\n');
    sections.push(`## Previous Gate Findings\n${findingsText}`);
  }

  if (bundle.resolutionSummary) {
    sections.push(
      `## Resolution Summary (model's response to previous findings)\n${bundle.resolutionSummary}`,
    );
  }

  if (bundle.agentLimitations && bundle.agentLimitations.length > 0) {
    sections.push(
      `## Known Limitations\n${bundle.agentLimitations.join('\n')}`,
    );
  }

  return sections.join('\n\n');
}

// ── Single-agent runner ────────────────────────────────────────────────

/**
 * Runs the gate review agent via `createAgentHeadless`. The agent operates
 * under a forced-PLAN config override and cannot spawn nested agents.
 *
 * Returns the parsed `GateAgentResult`, or throws on unrecoverable failure.
 */
export async function runGateAgent(
  config: Config,
  bundle: EvidenceBundle,
  signal: AbortSignal,
): Promise<GateAgentResult> {
  const evidence = formatEvidence(bundle);
  const taskPrompt = buildReviewPrompt(evidence);

  const subagentConfig = {
    name: 'plan-gate-reviewer',
    description: 'Plan Approval Gate: design reviewer',
    systemPrompt:
      'You are a design review agent for the Plan Approval Gate. Follow the instructions in the user message exactly. Respond with valid JSON only.',
    level: 'session' as const,
    approvalMode: 'plan',
    runConfig: { max_turns: 3, max_time_minutes: 5 },
  };

  const { config: planConfig, cleanup } = await createApprovalModeOverride(
    config,
    ApprovalMode.PLAN,
  );

  try {
    const subagentManager = config.getSubagentManager();
    const subagent = await subagentManager.createAgentHeadless(
      subagentConfig,
      planConfig,
    );

    const contextState = new ContextState();
    contextState.set('task_prompt', taskPrompt);

    await subagent.execute(contextState, signal);

    const terminateMode = subagent.getTerminateMode();
    const rawText = subagent.getFinalText();

    if (
      terminateMode !== AgentTerminateMode.GOAL ||
      !rawText ||
      rawText.trim().length === 0
    ) {
      throw new Error(
        `Gate agent terminated with mode=${terminateMode} and no usable output`,
      );
    }

    return parseGateAgentResult(rawText);
  } finally {
    cleanup();
  }
}

// ── JSON parsing / validation ──────────────────────────────────────────

export function parseGateAgentResult(raw: string): GateAgentResult {
  let jsonText = raw.trim();
  if (jsonText.startsWith('```')) {
    jsonText = jsonText
      .replace(/^```(?:json)?\s*\n?/, '')
      .replace(/\n?```\s*$/, '');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new Error(`Gate agent returned invalid JSON: ${raw.slice(0, 200)}`);
  }

  const obj = parsed as Record<string, unknown>;

  if (typeof obj !== 'object' || obj === null) {
    throw new Error('Gate agent returned non-object JSON');
  }

  const validDecisions = new Set([
    'pass',
    'blocked',
    'needs_user',
    'unavailable',
  ]);
  if (!validDecisions.has(obj['decision'] as string)) {
    throw new Error(
      `Gate agent returned invalid decision: ${String(obj['decision'])}`,
    );
  }

  const findings = Array.isArray(obj['findings']) ? obj['findings'] : [];
  const limitations = Array.isArray(obj['limitations'])
    ? (obj['limitations'] as string[])
    : [];
  const reviewedEvidence = Array.isArray(obj['reviewedEvidence'])
    ? (obj['reviewedEvidence'] as string[])
    : [];

  return {
    agent: 'plan_reviewer',
    decision: obj['decision'] as GateAgentResult['decision'],
    findings: findings.map((f: Record<string, unknown>, i: number) => ({
      localId: (f['localId'] as string) ?? `GF-${i + 1}`,
      severity: validateSeverity(f['severity'] as string),
      issue: String(f['issue'] ?? ''),
      rationale: String(f['rationale'] ?? ''),
      suggestedFix: f['suggestedFix'] as string | undefined,
      suggestedQuestion: f['suggestedQuestion'] as string | undefined,
    })),
    limitations,
    reviewedEvidence,
  };
}

function validateSeverity(s: string): 'P1' | 'P2' | 'P3' {
  if (s === 'P1' || s === 'P2' || s === 'P3') return s;
  debugLogger.warn(`Invalid severity "${s}", defaulting to P2`);
  return 'P2';
}
