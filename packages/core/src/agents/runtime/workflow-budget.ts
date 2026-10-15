/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview The `budget` a workflow script reads, and the gate behind it.
 *
 * `budget.total` comes from one of two places, in this order:
 *
 *  1. The turn's target — a `+500k`-style directive in the user's message
 *     (`core/turn-budget.ts`). `spent()` then counts every output token the
 *     session has been charged since that turn started: the main loop and
 *     every agent of every workflow, not only this run. That is what lets a
 *     script size its fan-out to what the user said the turn may cost.
 *  2. `QWEN_CODE_MAX_TOKENS_PER_WORKFLOW` — an operator's cap on one run.
 *     `spent()` stays this run's own agents, as the variable has always
 *     documented.
 *
 * With neither, `total` is `null` and `remaining()` is `Infinity`; `spent()`
 * still reports the turn's spend when a turn is known.
 *
 * Whatever the source, `runSpent()` is this run's own agents and `runCap()`
 * is the cap that applies to this run alone. The run registry, `/workflows`
 * and snapshots show those, so a run's numbers never include another run's
 * or the main loop's tokens.
 *
 * The gate is a soft one: `countedDispatch` checks it at dispatch entry and
 * again at slot acquisition, it reserves nothing up front, and agents already
 * in flight keep spending. A run can overshoot by roughly
 * `(concurrency_window − 1) × per_dispatch_tokens`, and a turn target also by
 * whatever the main loop spends alongside.
 *
 * Realm boundary: the impl is host-realm; the sandbox bridge wraps it
 * in a vm-realm shim (workflow-sandbox.ts) so the script sees a
 * vm-realm view whose `.constructor.constructor` cannot reach host
 * primitives — same defense as T1/T8/T14 budget stubs. `runSpent()` and
 * `runCap()` are not bridged.
 */

import type { Config } from '../../config/config.js';
import { MAX_TURN_BUDGET_TOKENS } from '../../core/turn-budget.js';
import { uiTelemetryService } from '../../telemetry/uiTelemetry.js';
import { createDebugLogger } from '../../utils/debugLogger.js';
import { parsePositiveIntegerEnv } from '../../utils/env.js';
import type { WorkflowBudget } from './workflow-sandbox.js';

const debugLogger = createDebugLogger('WORKFLOW_BUDGET');

export const MAX_TOKENS_PER_WORKFLOW_ENV = 'QWEN_CODE_MAX_TOKENS_PER_WORKFLOW';

/**
 * Absolute upper bound on a token cap. Even an operator who sets
 * `QWEN_CODE_MAX_TOKENS_PER_WORKFLOW=999999999` cannot exceed this — protects
 * against a fat-finger / misconfig that would silently uncap a workflow. The
 * same ceiling bounds a turn directive (`MAX_TURN_BUDGET_TOKENS`).
 */
export const HARD_MAX_TOKENS_CEILING = MAX_TURN_BUDGET_TOKENS;

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
  // Parse through the shared helper so only plain decimal integers are
  // accepted; Number() alone would let "0x2BF20"/"1e6"/"5.0" slip through.
  const parsed = parsePositiveIntegerEnv(raw, 0);
  if (parsed < 1) {
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

/** Where a budget's `total` came from. */
export type WorkflowBudgetSource = 'directive' | 'env';

export interface WorkflowBudgetOptions {
  /** Where a non-null `total` came from. Defaults to `'env'`. */
  source?: WorkflowBudgetSource;
  /**
   * Output tokens the session has been charged since the turn started. Given
   * when a turn is known; `spent()` reads it unless the source is `'env'`.
   */
  turnSpent?: () => number;
  /** The directive text that set a `'directive'` total, for display. */
  directiveText?: string;
}

/**
 * One run's view of the token budget. Single instance per run, shared with a
 * nested `workflow()`. `total` is fixed at construction; the script sees no
 * setter.
 *
 * Threading: workflows are single-threaded JS, so the counter has no
 * synchronisation primitive — every `recordSpent` happens on the host
 * event loop between dispatch resolutions.
 */
export class WorkflowBudgetImpl implements WorkflowBudget {
  readonly total: number | null;
  readonly source: WorkflowBudgetSource | undefined;
  readonly directiveText: string | undefined;
  private readonly turnSpent: (() => number) | undefined;
  private _runSpent: number;

  constructor(total: number | null, options: WorkflowBudgetOptions = {}) {
    this.total = total;
    this.source = total === null ? undefined : (options.source ?? 'env');
    this.directiveText =
      this.source === 'directive' ? options.directiveText : undefined;
    this.turnSpent = options.turnSpent;
    this._runSpent = 0;
  }

  /**
   * What the gate and the script measure against `total`: the turn's spend,
   * unless the total is an operator's per-run cap.
   */
  spent(): number {
    if (this.source !== 'env' && this.turnSpent) return this.turnSpent();
    return this._runSpent;
  }

  /** Output tokens this run's own agents reported. */
  runSpent(): number {
    return this._runSpent;
  }

  /** The cap on this run alone: only an operator's env cap is per run. */
  runCap(): number | null {
    return this.source === 'env' ? this.total : null;
  }

  remaining(): number {
    if (this.total === null) return Infinity;
    return Math.max(0, this.total - this.spent());
  }

  /**
   * Host-side increment. NOT exposed to the script — the
   * `WorkflowBudget` interface deliberately omits any setter so a
   * malicious workflow cannot inflate / deflate the budget. Only the
   * production dispatch's `onTokens` callback calls this after a dispatch
   * settles with the agent's output token count.
   *
   * Non-positive deltas are silently dropped (some dispatches return
   * `output_tokens: 0` on early failures); negative deltas would be a
   * caller bug and are also dropped rather than silently rewinding
   * the counter.
   */
  recordSpent(deltaTokens: number): void {
    if (!Number.isFinite(deltaTokens) || deltaTokens <= 0) return;
    this._runSpent += deltaTokens;
  }

  /** A per-run budget from the environment alone, with no turn. */
  static fromEnv(
    env: Record<string, string | undefined> = process.env,
  ): WorkflowBudgetImpl {
    return new WorkflowBudgetImpl(resolveMaxTokensPerWorkflow(env));
  }

  /**
   * The budget for a run launched now: the turn's directive when the current
   * turn set one, else the env cap, else none. The turn is read once — a run
   * that outlives its turn keeps measuring against the turn it started in.
   */
  static fromConfig(
    config: Config,
    env: Record<string, string | undefined> = process.env,
  ): WorkflowBudgetImpl {
    const sessionId = config.getSessionId?.();
    const turn =
      sessionId === undefined
        ? null
        : (config.getTurnBudget?.()?.current(sessionId) ?? null);
    const turnSpent = turn
      ? () =>
          Math.max(
            0,
            uiTelemetryService.getTotalOutputTokens(turn.sessionId) -
              turn.outputTokensAtTurnStart,
          )
      : undefined;
    if (turn && turn.budget !== null) {
      return new WorkflowBudgetImpl(turn.budget, {
        source: 'directive',
        turnSpent,
        directiveText: turn.directiveText,
      });
    }
    const envCap = resolveMaxTokensPerWorkflow(env);
    if (envCap !== null) {
      return new WorkflowBudgetImpl(envCap, { source: 'env' });
    }
    return new WorkflowBudgetImpl(null, { turnSpent });
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
    // P5 R2 (#14): keep the factual portion only — no advisory tail. A
    // "raise QWEN_CODE_MAX_TOKENS_PER_WORKFLOW or unset it" suffix reaches
    // the LLM via `tool_result` and could coach the model into telling the
    // user how to lift an operator-set cap. Operators looking up the knob
    // can still find it via `MAX_TOKENS_PER_WORKFLOW_ENV` in the debug log
    // site in `countedDispatch`.
    super(
      `Workflow ${runId}: token budget exceeded ` +
        `(${spent} / ${budgetTotal} output tokens). Stopping further agent() calls.`,
    );
    this.runId = runId;
    this.budgetTotal = budgetTotal;
    this.spent = spent;
  }
}
