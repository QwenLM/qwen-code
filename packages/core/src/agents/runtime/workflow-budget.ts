/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview P5: WorkflowBudget concrete implementation. P1 reserved
 * the seam (`SandboxOptions.budget`) with throwing stubs so dynamic-loop
 * patterns like `while (budget.total && budget.remaining() > 50_000) { ... }`
 * would survive shape-wise; P5 fills the seam with a real per-run token
 * tracker.
 *
 * Threat model:
 *  - Workflows can dispatch up to 1000 agents per run; a runaway script
 *    can burn through significant token budget without an upper bound.
 *  - The env override `QWEN_CODE_MAX_TOKENS_PER_WORKFLOW` lets operators
 *    set a per-run output-token cap. The cap is a **soft gate**, not a
 *    hard pre-commit reservation: it is checked at dispatch ENTRY in
 *    `countedDispatch`, so concurrent fan-out (`parallel()` /
 *    `pipeline()`) inside the concurrency window can overshoot before
 *    the first overshooting dispatch throws. Worst-case overshoot bound
 *    ≈ `(concurrency_window − 1) × per_dispatch_tokens`, where
 *    `concurrency_window = min(16, cpus−2)` by default (overridable via
 *    `QWEN_CODE_MAX_WORKFLOW_CONCURRENCY`). Operators sizing the cap
 *    should pick a value below the true ceiling by this margin; the
 *    gate matches upstream Claude Code 2.1.168 semantics.
 *  - When the env is unset (`total = null`), there is no cap and
 *    `remaining()` returns `Infinity` — matching upstream's "no target"
 *    sentinel for dynamic-loop callers that gate on `budget.total`.
 *
 * Realm boundary: the impl is host-realm; the sandbox bridge wraps it
 * in a vm-realm shim (workflow-sandbox.ts) so the script sees a
 * vm-realm view whose `.constructor.constructor` cannot reach host
 * primitives — same defense as T1/T8/T14 budget stubs.
 */

import { createDebugLogger } from '../../utils/debugLogger.js';
import type { WorkflowBudget } from './workflow-sandbox.js';

const debugLogger = createDebugLogger('WORKFLOW_BUDGET');

export const MAX_TOKENS_PER_WORKFLOW_ENV = 'QWEN_CODE_MAX_TOKENS_PER_WORKFLOW';

/**
 * Absolute upper bound on the env-override token cap. Even an operator
 * who sets `QWEN_CODE_MAX_TOKENS_PER_WORKFLOW=999999999` cannot exceed
 * this — protects against a fat-finger / misconfig that would silently
 * uncap a workflow. 100M tokens is roughly 20× the largest legitimate
 * single-workflow envelope (5M tokens × heavy ultracode pass).
 */
export const HARD_MAX_TOKENS_CEILING = 100_000_000;

/**
 * Resolve the per-run output-token ceiling, honoring
 * `QWEN_CODE_MAX_TOKENS_PER_WORKFLOW`. Returns `null` when the env is
 * unset or empty — null is the "no target" sentinel that
 * `budget.total === null` consumers gate on.
 *
 * A non-integer override, a value `< 1` (notably `0` and negative
 * numbers), or a non-numeric string is rejected with a debug warning
 * and falls back to `null` — i.e. treated as "no cap" rather than
 * crashing. This matches the `resolveMaxAgentsPerRun` fall-back policy
 * and means `QWEN_CODE_MAX_TOKENS_PER_WORKFLOW=0` does NOT disable
 * workflows; operators wanting "no agents may run" should disable the
 * tool entirely via `QWEN_CODE_DISABLE_WORKFLOWS=1` instead. An
 * override above `HARD_MAX_TOKENS_CEILING` is clamped (with a debug
 * warning).
 */
export function resolveMaxTokensPerWorkflow(
  env: Record<string, string | undefined> = process.env,
): number | null {
  const raw = env[MAX_TOKENS_PER_WORKFLOW_ENV];
  if (raw === undefined || raw.trim() === '') {
    return null;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    debugLogger.warn(
      `Invalid ${MAX_TOKENS_PER_WORKFLOW_ENV}=${JSON.stringify(raw)}, ` +
        `treating as unset (no cap)`,
    );
    return null;
  }
  if (parsed > HARD_MAX_TOKENS_CEILING) {
    debugLogger.warn(
      `${MAX_TOKENS_PER_WORKFLOW_ENV}=${parsed} exceeds hard ceiling ` +
        `(${HARD_MAX_TOKENS_CEILING}); clamping.`,
    );
    return HARD_MAX_TOKENS_CEILING;
  }
  return parsed;
}

/**
 * Per-run output-token tracker. Single instance lives in the orchestrator
 * across the lifetime of one `run()` call. The orchestrator's
 * `countedDispatch` reads `remaining()` to gate dispatches and calls
 * `recordSpent()` after each agent completion.
 *
 * `total` is set once at construction from
 * `resolveMaxTokensPerWorkflow()`; subsequent mutations are forbidden
 * (the field is `readonly` from the script's perspective — there is no
 * setter on `WorkflowBudget`).
 *
 * Threading: workflows are single-threaded JS, so the counter has no
 * synchronisation primitive — every `recordSpent` happens on the host
 * event loop between dispatch resolutions.
 */
export class WorkflowBudgetImpl implements WorkflowBudget {
  readonly total: number | null;
  private _spent: number;

  constructor(total: number | null) {
    this.total = total;
    this._spent = 0;
  }

  spent(): number {
    return this._spent;
  }

  remaining(): number {
    if (this.total === null) return Infinity;
    return Math.max(0, this.total - this._spent);
  }

  /**
   * Host-side increment. NOT exposed to the script — the
   * `WorkflowBudget` interface deliberately omits any setter so a
   * malicious workflow cannot inflate / deflate the budget. Only the
   * orchestrator (in `countedDispatch`) calls this after a dispatch
   * resolves with the agent's output token count.
   *
   * Non-positive deltas are silently dropped (some dispatches return
   * `output_tokens: 0` on early failures); negative deltas would be a
   * caller bug and are also dropped rather than silently rewinding
   * the counter.
   */
  recordSpent(deltaTokens: number): void {
    if (!Number.isFinite(deltaTokens) || deltaTokens <= 0) return;
    this._spent += deltaTokens;
  }

  /**
   * Factory: build a budget from the current environment. Convenience
   * over `new WorkflowBudgetImpl(resolveMaxTokensPerWorkflow(env))`.
   */
  static fromEnv(
    env: Record<string, string | undefined> = process.env,
  ): WorkflowBudgetImpl {
    return new WorkflowBudgetImpl(resolveMaxTokensPerWorkflow(env));
  }
}

/**
 * Thrown when an `agent()` dispatch would exceed `budget.total`. The
 * orchestrator's `countedDispatch` checks `budget.remaining() > 0`
 * BEFORE invoking the dispatch — once thrown, no further LLM calls
 * happen for this run. The script-side catch (if any) sees this as a
 * regular rejection from `await agent(...)`.
 *
 * Carries `runId` so the catch-arm display can identify the offending
 * workflow without parsing the message; `budgetTotal` and `spent`
 * snapshot the budget state at throw-time so logging / UI can render
 * the precise overshoot.
 *
 * Production callers (`WorkflowTool`) format the error message for the
 * LLM-facing tool result via `extractErrorMessage` (the duck-typed
 * extractor — cross-realm `instanceof` is unreliable in the vm-realm
 * sandbox, so we keep the message string self-describing rather than
 * relying on `err.name`).
 */
export class WorkflowBudgetExceededError extends Error {
  override readonly name = 'WorkflowBudgetExceededError';
  readonly runId: string;
  readonly budgetTotal: number;
  readonly spent: number;

  constructor(runId: string, budgetTotal: number, spent: number) {
    super(
      `Workflow ${runId} exceeded the token budget ` +
        `(${spent} / ${budgetTotal} output tokens spent). ` +
        `Increase ${MAX_TOKENS_PER_WORKFLOW_ENV} or unset it to remove the cap.`,
    );
    this.runId = runId;
    this.budgetTotal = budgetTotal;
    this.spent = spent;
  }
}
