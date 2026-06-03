import { randomBytes } from 'node:crypto';
import type { Config } from '../../config/config.js';
import { createWorkflowSandbox } from './workflow-sandbox.js';
import type {
  WorkflowAgentOpts,
  WorkflowAgentResult,
} from './workflow-sandbox.js';
import { WORKFLOW_SUBAGENT_SYSTEM_PROMPT } from './workflow-prompts.js';

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
      {},
      { tools: ['*'] },
    );
    // FIX-6 (ARCH-C1): signal threaded — undefined is safe (optional param).
    await subagent.execute(ctx, signal);
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
    const result = await sandbox.run(req.script);
    return {
      runId,
      result,
      phases: sandbox.getPhases(),
      logs: sandbox.getLogs(),
    };
  }
}
