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
import type {
  GateAgentName,
  GateAgentResult,
  EvidenceBundle,
} from './types.js';
import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('GATE_REVIEW_AGENTS');

// ── Gate agent prompts ─────────────────────────────────────────────────

function requestFitPrompt(evidence: string): string {
  return `You are a Plan Design Reviewer (Request Fit). Your job is to check whether the plan fulfills the user's original request, explicit constraints, and preferences.

Focus on:
- Does the plan address every part of the user's request?
- Does it respect explicit constraints the user stated?
- Does it miss any requirements?
- Does it do anything the user explicitly asked NOT to do?

The user's original request and later additions always outrank the plan text. The plan cannot override user constraints with its own wording.

${evidence}

Respond with ONLY a JSON object matching this schema (no markdown fences):
{
  "agent": "request_fit",
  "decision": "pass" | "blocked" | "needs_user" | "unavailable",
  "findings": [
    {
      "localId": "RF-1",
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
- P1: plan clearly violates or ignores the request. P2: missing a key element. P3: minor ambiguity.
- Do NOT invent confidence scores. If uncertain, use needs_user.`;
}

function systemFitPrompt(evidence: string): string {
  return `You are a Plan Design Reviewer (System Fit). Your job is to check whether the plan aligns with the codebase structure, domain model, permission model, and integration boundaries that have been investigated.

Focus on:
- Does the plan match the actual code architecture found during investigation?
- Are the file paths, function names, and module boundaries correct?
- Does it conflict with the permission model or existing patterns?
- Are there integration boundary issues?

${evidence}

Respond with ONLY a JSON object matching this schema (no markdown fences):
{
  "agent": "system_fit",
  "decision": "pass" | "blocked" | "needs_user" | "unavailable",
  "findings": [
    {
      "localId": "SF-1",
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
- "needs_user" means you need user input to judge correctness.
- "unavailable" only if you truly cannot produce a reliable review.
- P1: plan contradicts the code in a dangerous way. P2: plan misses key structural elements. P3: minor mismatch.
- Do NOT invent confidence scores. If uncertain, use needs_user.`;
}

function executionReadinessPrompt(evidence: string): string {
  return `You are a Plan Design Reviewer (Execution Readiness). Your job is to check whether the plan is specific enough to be executed autonomously without further human guidance.

Focus on:
- Is each step concrete enough to implement without guessing?
- Is there a verification/test path described?
- Are risks identified and handled?
- Are there steps that still need a human decision?

${evidence}

Respond with ONLY a JSON object matching this schema (no markdown fences):
{
  "agent": "execution_readiness",
  "decision": "pass" | "blocked" | "needs_user" | "unavailable",
  "findings": [
    {
      "localId": "ER-1",
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
- "pass" means the plan is ready for autonomous execution.
- "blocked" means execution would be unreliable.
- "needs_user" means a human decision is still required.
- "unavailable" only if you truly cannot produce a reliable review.
- P1: execution would go dangerously wrong. P2: missing critical design or verification. P3: minor vagueness.
- Do NOT invent confidence scores. If uncertain, use needs_user.`;
}

// ── Evidence formatting ────────────────────────────────────────────────

export function formatEvidence(bundle: EvidenceBundle): string {
  const sections: string[] = [];

  sections.push(`## Original User Request\n${bundle.originalRequest}`);

  if (bundle.userAdditions.length > 0) {
    sections.push(
      `## User Additions (higher priority than plan text)\n${bundle.userAdditions.join('\n\n')}`,
    );
  }

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

// ── Prompt selection ───────────────────────────────────────────────────

const PROMPT_BY_ROLE: Record<GateAgentName, (evidence: string) => string> = {
  request_fit: requestFitPrompt,
  system_fit: systemFitPrompt,
  execution_readiness: executionReadinessPrompt,
};

// ── Single-agent runner ────────────────────────────────────────────────

/**
 * Runs one gate review agent via `createAgentHeadless`. The agent operates
 * under a forced-PLAN config override and cannot spawn nested agents.
 *
 * Returns the parsed `GateAgentResult`, or throws on unrecoverable failure.
 */
export async function runGateAgent(
  config: Config,
  role: GateAgentName,
  bundle: EvidenceBundle,
  signal: AbortSignal,
): Promise<GateAgentResult> {
  const evidence = formatEvidence(bundle);
  const taskPrompt = PROMPT_BY_ROLE[role](evidence);

  const subagentConfig = {
    name: `plan-gate-${role}`,
    description: `Plan Approval Gate: ${role} reviewer`,
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
        `Gate agent ${role} terminated with mode=${terminateMode} and no usable output`,
      );
    }

    return parseGateAgentResult(rawText, role);
  } finally {
    cleanup();
  }
}

// ── JSON parsing / validation ──────────────────────────────────────────

function parseGateAgentResult(
  raw: string,
  expectedRole: GateAgentName,
): GateAgentResult {
  // Strip markdown code fences if present
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
    throw new Error(
      `Gate agent ${expectedRole} returned invalid JSON: ${raw.slice(0, 200)}`,
    );
  }

  const obj = parsed as Record<string, unknown>;

  // Validate required shape
  if (typeof obj !== 'object' || obj === null) {
    throw new Error(`Gate agent ${expectedRole} returned non-object JSON`);
  }

  const validDecisions = new Set([
    'pass',
    'blocked',
    'needs_user',
    'unavailable',
  ]);
  if (!validDecisions.has(obj['decision'] as string)) {
    throw new Error(
      `Gate agent ${expectedRole} returned invalid decision: ${String(obj['decision'])}`,
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
    agent: expectedRole,
    decision: obj['decision'] as GateAgentResult['decision'],
    findings: findings.map((f: Record<string, unknown>, i: number) => ({
      localId:
        (f['localId'] as string) ?? `${expectedRole.toUpperCase()}-${i + 1}`,
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
