import { randomBytes } from 'node:crypto';
import type { Config } from '../../config/config.js';
import { createWorkflowSandbox } from './workflow-sandbox.js';
import type { WorkflowAgentOpts } from './workflow-sandbox.js';
import { WORKFLOW_SUBAGENT_SYSTEM_PROMPT } from './workflow-prompts.js';

export interface WorkflowRunRequest {
  script: string;
  args: unknown;
  signal?: AbortSignal;
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
) => Promise<string>;

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
    const runId = generateRunId();
    const sandbox = createWorkflowSandbox({
      args: req.args,
      startTime: 0, // P1: fixed sentinel; resume work in P6 will use real run-start time.
      dispatch: this.dispatch,
      signal: req.signal,
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
