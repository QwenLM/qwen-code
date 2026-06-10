/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomBytes } from 'node:crypto';
import * as os from 'node:os';
import type { Config } from '../../config/config.js';
import { createWorkflowSandbox } from './workflow-sandbox.js';
import type {
  WorkflowAgentOpts,
  WorkflowAgentResult,
} from './workflow-sandbox.js';
import { WORKFLOW_SUBAGENT_SYSTEM_PROMPT } from './workflow-prompts.js';
import { AgentTerminateMode } from './agent-types.js';
import { ToolNames } from '../../tools/tool-names.js';
import { createConcurrencyLimiter } from '../../utils/concurrencyLimiter.js';
import { createDebugLogger } from '../../utils/debugLogger.js';

const debugLogger = createDebugLogger('WORKFLOW');

/**
 * Default ceiling on total `agent()` calls per workflow run (matches upstream
 * `hOK = 1000`). Counts EVERY dispatch — sequential, `parallel()`, and
 * `pipeline()` all funnel through the one wrapped dispatch — so a fan-out
 * cannot bypass it. The 1001st call throws. Override via env (see below).
 */
export const DEFAULT_MAX_AGENTS_PER_RUN = 1000;
export const MAX_WORKFLOW_AGENTS_ENV = 'QWEN_CODE_MAX_WORKFLOW_AGENTS';

/**
 * Resolve the per-run agent cap, honoring `QWEN_CODE_MAX_WORKFLOW_AGENTS`.
 * Mirrors `resolveMaxConcurrentBackgroundAgents` (background-tasks.ts): a
 * non-integer / <1 override is rejected with a debug warning and the default
 * is used.
 */
export function resolveMaxAgentsPerRun(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env[MAX_WORKFLOW_AGENTS_ENV];
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_MAX_AGENTS_PER_RUN;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    debugLogger.warn(
      `Invalid ${MAX_WORKFLOW_AGENTS_ENV}=${JSON.stringify(raw)}, ` +
        `using default (${DEFAULT_MAX_AGENTS_PER_RUN})`,
    );
    return DEFAULT_MAX_AGENTS_PER_RUN;
  }
  return parsed;
}

export const MAX_WORKFLOW_CONCURRENCY_ENV =
  'QWEN_CODE_MAX_WORKFLOW_CONCURRENCY';

/**
 * Maximum agents in flight at once within a single run, shared across all
 * `parallel()` / `pipeline()` calls. `min(16, cpus-2)` mirrors upstream;
 * `max(1, …)` guards 1–2 core machines where `cpus-2 <= 0` would otherwise
 * produce a deadlocking limit. `QWEN_CODE_MAX_WORKFLOW_CONCURRENCY` overrides
 * the computed value with an explicit integer (>=1); an invalid override
 * falls back to the cpu-derived default with a debug warning.
 */
export function resolveConcurrencyLimit(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env[MAX_WORKFLOW_CONCURRENCY_ENV];
  if (raw !== undefined && raw.trim() !== '') {
    const parsed = Number(raw);
    if (Number.isInteger(parsed) && parsed >= 1) {
      return parsed;
    }
    debugLogger.warn(
      `Invalid ${MAX_WORKFLOW_CONCURRENCY_ENV}=${JSON.stringify(raw)}, ` +
        `using cpu-derived default`,
    );
  }
  return Math.max(1, Math.min(16, os.cpus().length - 2));
}

/**
 * Bound the resource ceiling for workflow subagents so a single `agent()`
 * call cannot loop the model indefinitely. Values mirror conservative
 * upstream defaults; P5 will refine via `budget` once it exists.
 */
const WORKFLOW_SUBAGENT_MAX_TURNS = 50;
const WORKFLOW_SUBAGENT_MAX_TIME_MINUTES = 10;

/**
 * disallowedTools mirror the upstream `Tg8` workflow-subagent config — both
 * tools would let a subagent break the "final text IS the return value"
 * contract. SendMessage would deliver the answer to the user instead of
 * the calling script; ExitPlanMode would interrupt the workflow's plan-mode
 * intent. Defense-in-depth alongside the §XmO system prompt that already
 * documents both restrictions.
 */
const WORKFLOW_SUBAGENT_DISALLOWED_TOOLS: string[] = [
  ToolNames.SEND_MESSAGE,
  ToolNames.EXIT_PLAN_MODE,
];

/**
 * `WorkflowExecutionError` preserves the phases and logs the script
 * accumulated before failing — without it, all diagnostic context is lost
 * when the orchestrator's catch block surfaces only `err.message`.
 *
 * `cause` carries the underlying error message but no host-realm Error
 * object: we only ever store strings to avoid re-introducing the T1
 * thrown-Error realm-escape vector.
 */
export class WorkflowExecutionError extends Error {
  override readonly name = 'WorkflowExecutionError';
  constructor(
    message: string,
    readonly phases: string[],
    readonly logs: string[],
  ) {
    super(message);
  }
}

// FIX-E (Round 4 ARCH-I1): single source of truth for the dispatch return
// type is `workflow-sandbox.ts`. Re-exported here so external consumers
// (WorkflowTool) can import the alias from the orchestrator module.
export type { WorkflowAgentResult };

export interface WorkflowRunRequest {
  script: string;
  args: unknown;
  // FIX-D (Round 3 ARCH-I1): `signal` was previously declared here but never
  // read by `run()` — cancellation flows through `createProductionDispatch`'s
  // closure-captured signal, not via per-run state. Removed to prevent
  // P2 authors from extending the wrong field.
  /**
   * T40 (PR #4732 R4): caller-owned AbortController linked to the wall-clock
   * timeout. When the sandbox times out, this controller is aborted BEFORE
   * the rejection propagates — letting in-flight subagent dispatches see
   * the cancellation and stop burning tokens. The caller (`WorkflowTool`)
   * also threads this same controller's signal into `createProductionDispatch`
   * and aborts it in its own `finally` block to clean up on normal completion.
   * If omitted, the wall-clock still rejects but in-flight subagents continue
   * until their internal `max_time_minutes` limit.
   */
  abortOnTimeout?: AbortController;
}

export interface WorkflowRunOutcome {
  runId: string;
  result: unknown;
  phases: string[];
  logs: string[];
}

export type WorkflowAgentDispatch = (
  prompt: string,
  opts: WorkflowAgentOpts,
) => Promise<WorkflowAgentResult>;

function generateRunId(): string {
  return `wf_${randomBytes(8).toString('hex')}`;
}

/**
 * Build the production agent-dispatch function.
 *
 * Wraps AgentHeadless.create + execute + getFinalText into the
 * `(prompt, opts) => Promise<string>` shape required by the sandbox.
 *
 * Dynamic import lets test mocks swap agent-headless without static-import
 * hoisting interference.
 *
 * FIX-6 (ARCH-C1): accepts an optional AbortSignal and threads it into
 * subagent.execute() so cancellation from the caller propagates correctly.
 * When signal is undefined, subagent.execute() runs without external abort.
 */
export function createProductionDispatch(
  config: Config,
  signal?: AbortSignal,
): WorkflowAgentDispatch {
  return async (prompt, opts) => {
    const { AgentHeadless, ContextState } = await import('./agent-headless.js');
    const ctx = new ContextState();
    ctx.set('task_prompt', prompt);

    const subagent = await AgentHeadless.create(
      opts.label ?? 'workflow-agent',
      config,
      {
        systemPrompt: WORKFLOW_SUBAGENT_SYSTEM_PROMPT,
        initialMessages: [],
      },
      {},
      // T11 (PR #4732 R1): bound resource ceiling so a single agent() call
      // cannot loop the model indefinitely. Without this, runConfig was {}
      // and the loop guards never tripped — combined with the cancellation
      // bug below, workflows were effectively unkillable.
      {
        max_turns: WORKFLOW_SUBAGENT_MAX_TURNS,
        max_time_minutes: WORKFLOW_SUBAGENT_MAX_TIME_MINUTES,
      },
      // T11 (PR #4732 R1): disallow SendMessage / ExitPlanMode to align with
      // upstream Tg8 — closes the back-channel that would let a subagent
      // deliver its answer via user message instead of the script's read.
      { tools: ['*'], disallowedTools: WORKFLOW_SUBAGENT_DISALLOWED_TOOLS },
    );
    await subagent.execute(ctx, signal);
    // T10 (PR #4732 R1): runReasoningLoop does NOT throw on abort / turn /
    // time limit — it returns with terminateMode = CANCELLED|MAX_TURNS|
    // TIMEOUT|ERROR and getFinalText() = '' or partial. Without this check,
    // `await agent(...)` would resolve to '' on user cancel and the script
    // would happily loop on empty results.
    const mode = subagent.getTerminateMode();
    if (mode !== AgentTerminateMode.GOAL) {
      throw new Error(
        `Workflow subagent did not complete (terminate mode: ${mode}).`,
      );
    }
    return subagent.getFinalText();
  };
}

export class WorkflowOrchestrator {
  constructor(private readonly dispatch: WorkflowAgentDispatch) {}

  async run(req: WorkflowRunRequest): Promise<WorkflowRunOutcome> {
    // Signal threading lives in createProductionDispatch (closure-captured)
    // rather than per-run state. Sandbox-level signal is intentionally not
    // exposed in P1 — sync-loop protection is provided by the 30s vm
    // timeout in workflow-sandbox.ts; async-loop cancellation flows
    // through dispatch's subagent.execute path.
    const runId = generateRunId();

    const maxAgents = resolveMaxAgentsPerRun();
    const signal = req.abortOnTimeout?.signal;

    // P2: the concurrency window throttles AGENT DISPATCHES, not orchestration
    // thunks. parallel()/pipeline() compose promises freely; only the leaf
    // agent() calls acquire a slot. This gives the correct "N agents in flight
    // per run" semantics AND avoids a re-entrancy deadlock (F1, P2 review): if
    // the window sat at the thunk level, a nested parallel()/pipeline() — e.g.
    // a pipeline stage that fans out, the canonical /deep-research shape —
    // would hold every slot while awaiting inner work that can never acquire
    // one. One shared limiter per run keeps total in-flight agents under the
    // cap across all fan-out calls.
    const limiter = createConcurrencyLimiter(resolveConcurrencyLimit(), signal);

    // Every agent() call — sequential, parallel(), or pipeline() — funnels
    // through this one wrapped dispatch: the counter enforces the per-run agent
    // cap regardless of launch path (increment-then-check: calls 1..max pass,
    // the (max+1)th throws), and limiter.run enforces the concurrency window.
    let agentCount = 0;
    const countedDispatch: WorkflowAgentDispatch = (prompt, opts) => {
      agentCount += 1;
      if (agentCount > maxAgents) {
        return Promise.reject(
          new Error(
            `Workflow exceeded the maximum of ${maxAgents} agent() calls per run.`,
          ),
        );
      }
      return limiter.run(() => this.dispatch(prompt, opts));
    };

    const parallelImpl = makeParallelImpl(signal);
    const pipelineImpl = makePipelineImpl(signal);

    const sandbox = createWorkflowSandbox({
      args: req.args,
      dispatch: countedDispatch,
      parallel: parallelImpl,
      pipeline: pipelineImpl,
      abortOnTimeout: req.abortOnTimeout,
    });
    try {
      const result = await sandbox.run(req.script);
      return {
        runId,
        result,
        phases: sandbox.getPhases(),
        logs: sandbox.getLogs(),
      };
    } catch (err) {
      // T19 (PR #4732 R1): preserve phases and logs accumulated before the
      // script failed so the caller can surface them in the error display.
      // We only carry primitive strings across the boundary — no host-realm
      // Error instance — to avoid reintroducing the T1 escape vector.
      //
      // Cross-realm `instanceof Error` is false for vm-realm Error objects,
      // so duck-type on `.message` instead. `String(vmError)` would coerce
      // to "Error: <msg>" which is the wrong shape for a clean message.
      throw new WorkflowExecutionError(
        extractErrorMessage(err),
        sandbox.getPhases(),
        sandbox.getLogs(),
      );
    }
  }
}

/**
 * Settle a batch of thunks into a position-aligned `Array<T|null>` —
 * errors-as-data: a thunk that rejects (including an over-cap dispatch or a
 * stage error) becomes `null` at its index, never collapsing the batch.
 * `Promise.resolve().then(t)` funnels a synchronously-throwing thunk into the
 * rejection path. The ONE thing that rejects the whole batch is an abort, so
 * an aborted run surfaces a rejection rather than a silent array of nulls.
 * Concurrency is bounded at the dispatch layer (limiter.run in countedDispatch),
 * not here — so nesting a parallel()/pipeline() inside a thunk cannot deadlock.
 */
async function settleToNullArray(
  thunks: Array<() => Promise<unknown>>,
  signal?: AbortSignal,
): Promise<unknown[]> {
  const settled = await Promise.allSettled(
    thunks.map((t) => Promise.resolve().then(t)),
  );
  if (signal?.aborted) throw new Error('Workflow run aborted.');
  return settled.map((r) => (r.status === 'fulfilled' ? r.value : null));
}

/**
 * Build the host-side `parallel(thunks)` impl. Each thunk is a vm-realm
 * function whose agent() calls throttle through the per-run concurrency window
 * at the dispatch layer. A thunk that rejects becomes `null` at its index
 * (errors-as-data); `parallel()` itself only rejects on abort. The result
 * array is revived into the vm realm by the sandbox wrapper (JSON round-trip)
 * — this host array never reaches the script directly.
 */
function makeParallelImpl(
  signal?: AbortSignal,
): (thunks: Array<() => Promise<unknown>>) => Promise<unknown[]> {
  return (thunks) => {
    if (!Array.isArray(thunks)) {
      return Promise.reject(
        new Error(
          'parallel() expects an array of thunks (functions returning promises).',
        ),
      );
    }
    for (const t of thunks) {
      if (typeof t !== 'function') {
        return Promise.reject(
          new Error(
            'parallel() expects an array of functions, not values — wrap each ' +
              'call: parallel([() => agent(...), () => agent(...)]).',
          ),
        );
      }
    }
    return settleToNullArray(thunks, signal);
  };
}

/**
 * Build the host-side `pipeline(items, ...stages)` impl as parallel-of-chains.
 *
 * Each item becomes one chain that runs the stages in sequence — staggered,
 * with NO barrier between stages, so item A can be in stage 3 while item B is
 * still in stage 1. Stage callbacks receive `(prev, item, idx)`; the first
 * stage's `prev` is the item itself. A stage that throws OR returns `null`
 * drops that item to `null` and skips its remaining stages, leaving other
 * items unaffected. Concurrency is bounded at the dispatch layer.
 */
function makePipelineImpl(
  signal?: AbortSignal,
): (
  items: unknown[],
  ...stages: Array<
    (prev: unknown, item: unknown, idx: number) => Promise<unknown>
  >
) => Promise<unknown[]> {
  return (items, ...stages) => {
    if (!Array.isArray(items)) {
      return Promise.reject(
        new Error(
          'pipeline() expects an array of items as its first argument.',
        ),
      );
    }
    for (const s of stages) {
      if (typeof s !== 'function') {
        return Promise.reject(
          new Error(
            'pipeline() stages must be functions: ' +
              'pipeline(items, item => ..., result => ...).',
          ),
        );
      }
    }
    const chains = items.map(
      (item, idx) => () => runPipelineChain(item, idx, stages),
    );
    return settleToNullArray(chains, signal);
  };
}

/**
 * Run one item through every stage in order. `null` is the universal drop
 * sentinel: a stage that returns `null` (or throws — surfaced as a rejection
 * that the batch maps to `null`) short-circuits the rest of the chain.
 */
async function runPipelineChain(
  item: unknown,
  idx: number,
  stages: Array<
    (prev: unknown, item: unknown, idx: number) => Promise<unknown>
  >,
): Promise<unknown> {
  let prev: unknown = item;
  for (const stage of stages) {
    if (prev === null) break;
    prev = await stage(prev, item, idx);
  }
  return prev;
}

/**
 * Duck-typed message extraction. `instanceof Error` is realm-local; vm-realm
 * Errors raised inside the sandbox are NOT instances of host Error from the
 * orchestrator's perspective, so the standard `err instanceof Error ?
 * err.message : String(err)` pattern produces "Error: msg" via toString().
 * This helper falls back to the .message property regardless of realm.
 */
function extractErrorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err) {
    const m = (err as { message: unknown }).message;
    if (typeof m === 'string') return m;
    return String(m);
  }
  return String(err);
}
