/**
 * Plan Types
 *
 * Defines the structure for plans and plan-related types.
 * Plans are used for structured task execution with user review.
 */

import { randomUUID } from 'crypto';

/**
 * The current state of a plan
 */
export type PlanState =
  | 'creating'    // Agent is generating the plan
  | 'refining'    // User is providing feedback, agent is refining
  | 'ready'       // Plan is approved and ready to execute
  | 'executing'   // Plan is being executed
  | 'completed'   // Plan execution finished
  | 'cancelled';  // User cancelled the plan

/**
 * A single step in a plan
 */
export interface PlanStep {
  /** Unique identifier for this step */
  id: string;
  /** Human-readable description of what this step does */
  description: string;
  /** Current status of this step */
  status: 'pending' | 'in_progress' | 'completed' | 'skipped';
  /** Optional detailed implementation notes */
  details?: string;
  /** Files that will be modified in this step */
  files?: string[];
  /** Estimated complexity (for UI display) */
  complexity?: 'low' | 'medium' | 'high';
}

/**
 * A complete plan for a task
 */
export interface Plan {
  /** Unique identifier */
  id: string;
  /** Short title describing the plan */
  title: string;
  /** Current state of the plan */
  state: PlanState;
  /** Ordered list of steps to execute */
  steps: PlanStep[];
  /** Original user request that triggered this plan */
  context: string;
  /** Current refinement iteration (0 = initial, 1+ = after feedback) */
  refinementRound: number;
  /** Timestamp when plan was created */
  createdAt: number;
  /** Timestamp when plan was last modified */
  updatedAt: number;
  /** History of refinements for reference */
  refinementHistory?: PlanRefinementEntry[];
}

/**
 * A single refinement round entry
 */
export interface PlanRefinementEntry {
  /** Round number */
  round: number;
  /** Questions the agent asked */
  questions: string[];
  /** User's feedback/answers */
  feedback: string;
  /** Timestamp */
  timestamp: number;
}

/**
 * Request for user to review and potentially refine a plan
 */
export interface PlanRefinementRequest {
  /** The current plan */
  plan: Plan;
  /** Questions from the agent that need user input */
  questions: string[];
  /** Optional suggestions for improvement */
  suggestions?: string[];
}

/**
 * Events emitted during plan mode
 */
export type PlanEvent =
  | { type: 'plan_creating'; message: string }
  | { type: 'plan_ready'; plan: Plan; questions?: string[] }
  | { type: 'plan_refining'; plan: Plan; feedback: string }
  | { type: 'plan_approved'; plan: Plan }
  | { type: 'plan_cancelled' }
  | { type: 'plan_step_start'; stepId: string; description: string }
  | { type: 'plan_step_complete'; stepId: string }
  | { type: 'plan_complete'; plan: Plan };

/**
 * Options for starting plan mode
 */
export interface PlanModeOptions {
  /** The task to plan for */
  task: string;
  /** Skip refinement and auto-approve (for simple tasks) */
  autoApprove?: boolean;
  /** Maximum refinement rounds before forcing a decision */
  maxRefinementRounds?: number;
}

/**
 * Result of checking if a task should trigger plan mode
 */
export interface PlanSuggestion {
  /** Whether planning is suggested */
  shouldPlan: boolean;
  /** Reason for the suggestion */
  reason?: string;
  /** Complexity assessment */
  complexity?: 'simple' | 'moderate' | 'complex';
}

/**
 * Request sent to UI when a plan is ready for review
 */
export interface PlanReviewRequest {
  /** Unique identifier for this review request */
  requestId: string;
  /** The plan to review */
  plan: Plan;
  /** Optional questions from the agent that need user input */
  questions?: string[];
}

/**
 * Result of a plan review from the user
 */
export type PlanReviewResult =
  | { action: 'approve'; modifiedPlan?: Plan }
  | { action: 'refine'; feedback: string }
  | { action: 'saveOnly'; modifiedPlan?: Plan }
  | { action: 'cancel' };

/**
 * Helper to create a new plan
 */
export function createPlan(title: string, context: string): Plan {
  return {
    id: randomUUID(),
    title,
    state: 'creating',
    steps: [],
    context,
    refinementRound: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

/**
 * Helper to create a plan step
 */
export function createPlanStep(description: string, details?: string): PlanStep {
  return {
    id: randomUUID(),
    description,
    status: 'pending',
    details,
  };
}

/**
 * Helper to update plan state
 */
export function updatePlanState(plan: Plan, state: PlanState): Plan {
  return {
    ...plan,
    state,
    updatedAt: Date.now(),
  };
}

/**
 * Helper to add refinement entry to plan
 */
export function addRefinementEntry(
  plan: Plan,
  questions: string[],
  feedback: string
): Plan {
  const entry: PlanRefinementEntry = {
    round: plan.refinementRound + 1,
    questions,
    feedback,
    timestamp: Date.now(),
  };

  return {
    ...plan,
    refinementRound: plan.refinementRound + 1,
    refinementHistory: [...(plan.refinementHistory || []), entry],
    updatedAt: Date.now(),
  };
}

// ============================================
// Permission Mode UI Messages (single source of truth)
// ============================================
// Permission modes control tool execution behavior.
// User can cycle via SHIFT+TAB: YOLO -> Plan mode -> Ask before edits -> Edit automatically

import type { PermissionMode } from './mode-manager.ts';
import { PERMISSION_MODE_CONFIG } from './mode-types.ts';

/** User-visible messages for each permission mode */
export const PERMISSION_MODE_MESSAGES: Record<PermissionMode, string> = {
  'safe': `${PERMISSION_MODE_CONFIG['safe'].displayName} active. Plan-first workflow enabled.`,
  'ask': `${PERMISSION_MODE_CONFIG['ask'].displayName} mode active. Prompts before edits and dangerous operations.`,
  'auto-edit': `${PERMISSION_MODE_CONFIG['auto-edit'].displayName} mode active. File edits are automatic; other risky operations may prompt.`,
  'allow-all': `${PERMISSION_MODE_CONFIG['allow-all'].displayName} mode active. All operations permitted.`,
};

/** System prompts sent to the agent when mode changes */
export const PERMISSION_MODE_PROMPTS: Record<PermissionMode, string> = {
  'safe': `The user has switched to ${PERMISSION_MODE_CONFIG['safe'].displayName}. You can read files, search, and explore the codebase, but write operations (Bash, Write, Edit, API calls) are blocked until a plan is accepted or the mode changes.`,
  'ask': `The user has switched to ${PERMISSION_MODE_CONFIG['ask'].displayName} mode. Most operations are allowed, but edits and dangerous commands will prompt for user approval.`,
  'auto-edit': `The user has switched to ${PERMISSION_MODE_CONFIG['auto-edit'].displayName} mode. File edits can be applied without prompting, but other risky operations may still ask for user approval.`,
  'allow-all': `The user has switched to ${PERMISSION_MODE_CONFIG['allow-all'].displayName} mode. All operations are permitted without prompts. Use with care.`,
};
