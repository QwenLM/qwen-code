/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared types for the Plan Approval Gate. Kept in a dependency-light module so
 * `Config` (via state.ts) and the gate orchestrator can both import them without
 * a circular dependency.
 */

/** The three fixed gate review roles. */
export type GateAgentName =
  | 'request_fit'
  | 'system_fit'
  | 'execution_readiness';

export const GATE_AGENT_NAMES: readonly GateAgentName[] = [
  'request_fit',
  'system_fit',
  'execution_readiness',
];

/** Per-agent decision. No confidence — uncertainty is `needs_user`/`unavailable`. */
export type GateAgentDecision =
  | 'pass'
  | 'blocked'
  | 'needs_user'
  | 'unavailable';

/**
 * Severity measures only whether autonomous execution can be trusted — it is
 * NOT the severity scale used by ordinary code review.
 *
 * - P1: autonomous execution would clearly violate the request, ignore an
 *   explicit constraint, or head somewhere dangerous/wrong. Always blocks.
 * - P2: the plan is missing a key design element or conflicts with the code
 *   structure / permission model / verification path. Always blocks.
 * - P3: broadly executable with minor ambiguity or non-critical suggestions.
 *   Blocks within the capped rounds; once the cap is hit, P3-only passes.
 */
export type GateSeverity = 'P1' | 'P2' | 'P3';

export interface GateFinding {
  /** Agent-local id, unique only within a single agent result. */
  localId: string;
  severity: GateSeverity;
  issue: string;
  rationale: string;
  suggestedFix?: string;
  suggestedQuestion?: string;
}

export interface GateAgentResult {
  agent: GateAgentName;
  decision: GateAgentDecision;
  findings: GateFinding[];
  limitations: string[];
  reviewedEvidence: string[];
}

/** A finding after the deterministic cross-agent merge, with a stable id. */
export interface MergedGateFinding {
  /** Stable merged id, e.g. `GF-1`. Referenced by later resolutionSummary. */
  id: string;
  severity: GateSeverity;
  issue: string;
  rationale: string;
  suggestedFix?: string;
  suggestedQuestion?: string;
  /** Which agents reported this finding. */
  reportedBy: GateAgentName[];
}

/**
 * Minimal necessary context handed to each gate review agent. NOT a full
 * transcript. The original request and the user's later additions outrank the
 * plan text — the plan cannot override user constraints with its own wording.
 */
export interface EvidenceBundle {
  originalRequest: string;
  userAdditions: string[];
  plan: string;
  researchSummary?: string;
  keyContext?: string[];
  lastFindings?: MergedGateFinding[];
  resolutionSummary?: string;
  agentLimitations?: string[];
}

/** Final decision produced by the orchestrator for a single gate run. */
export type GateDecision =
  | { kind: 'approved'; nonBlockingFindings?: MergedGateFinding[] }
  | { kind: 'blocked'; findings: MergedGateFinding[] }
  | { kind: 'needs_user'; findings: MergedGateFinding[]; questions: string[] }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'cap_escalation'; blockingFindings: MergedGateFinding[] };

/** Default number of capped review rounds per Plan Mode Entry. */
export const CAPPED_REVIEW_LIMIT = 5;

/** Max retries for a single failed gate agent before declaring it unavailable. */
export const MAX_AGENT_RETRIES = 3;

const SEVERITY_RANK: Record<GateSeverity, number> = { P1: 3, P2: 2, P3: 1 };

/** Returns the higher (more severe) of two severities. */
export function maxSeverity(a: GateSeverity, b: GateSeverity): GateSeverity {
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}

/** True when the severity always blocks during the capped phase. */
export function isBlockingSeverity(severity: GateSeverity): boolean {
  return severity === 'P1' || severity === 'P2' || severity === 'P3';
}
