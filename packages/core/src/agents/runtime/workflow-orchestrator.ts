/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomBytes } from 'node:crypto';
import type { Config } from '../../config/config.js';
import { createWorkflowSandbox } from './workflow-sandbox.js';
import type {
  WorkflowAgentOpts,
  WorkflowAgentResult,
} from './workflow-sandbox.js';
import { WORKFLOW_SUBAGENT_SYSTEM_PROMPT } from './workflow-prompts.js';
import { AgentTerminateMode } from './agent-types.js';
import { ToolNames } from '../../tools/tool-names.js';

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
    const sandbox = createWorkflowSandbox({
      args: req.args,
      dispatch: this.dispatch,
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
