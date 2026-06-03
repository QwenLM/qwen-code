import { randomBytes } from 'node:crypto';
import type { Config } from '../../config/config.js';
import { createWorkflowSandbox } from './workflow-sandbox.js';
import type { WorkflowAgentOpts } from './workflow-sandbox.js';

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

export interface WorkflowOrchestratorOptions {
  /**
   * Override the agent-dispatch function. Used by tests to inject a mock
   * without spawning a real subagent.
   *
   * In production this is undefined, and the orchestrator builds the real
   * dispatch lazily (Task 7) by wrapping `AgentHeadless.create`.
   */
  dispatch?: WorkflowAgentDispatch;
}

// FIX-5 (UP-I1): verbatim from claude-code 2.1.160 binary §XmO constant.
// The binary string begins at the segment "You are a subagent spawned by a
// workflow" and covers the full instructional block. Retaining this verbatim
// ensures subagents receive the same behavioural contract the upstream binary
// ships with, rather than a paraphrase that may omit critical framing.
const WORKFLOW_SUBAGENT_SYSTEM_PROMPT =
  'You are a subagent spawned by a workflow orchestration script. ' +
  'Use the tools available to complete the task.\n\n' +
  'NOTE: You are running inside a workflow script. Your final text response ' +
  'is returned verbatim as a string to the calling script — it is your ' +
  'return value, not a message to a human. Output the literal result; do ' +
  "not output confirmations like 'Done.' Be concise — the script will " +
  'parse your output.';

function generateRunId(): string {
  return `wf_${randomBytes(8).toString('hex')}`;
}

export class WorkflowOrchestrator {
  constructor(
    private readonly config: Config,
    private readonly options: WorkflowOrchestratorOptions = {},
  ) {}

  async run(req: WorkflowRunRequest): Promise<WorkflowRunOutcome> {
    const runId = generateRunId();
    // FIX-6 (ARCH-C1): thread req.signal into the production dispatch so that
    // an AbortSignal raised by the caller propagates to the subagent.execute()
    // call rather than being silently dropped.
    const dispatch =
      this.options.dispatch ?? this.buildProductionDispatch(req.signal);
    const sandbox = createWorkflowSandbox({
      args: req.args,
      startTime: 0, // P1: fixed sentinel; resume work in P6 will use real run-start time.
      dispatch,
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

  /**
   * Production dispatch — wraps AgentHeadless.create + execute + getFinalText.
   * Uses dynamic import so test mocks can swap the module via vi.mock.
   *
   * FIX-6 (ARCH-C1): accepts an optional AbortSignal and threads it into
   * subagent.execute() so cancellation from the caller propagates correctly.
   * When signal is undefined, subagent.execute() runs without external abort.
   */
  private buildProductionDispatch(signal?: AbortSignal): WorkflowAgentDispatch {
    return async (prompt, opts) => {
      const { AgentHeadless, ContextState } = await import(
        './agent-headless.js'
      );
      const ctx = new ContextState();
      ctx.set('task_prompt', prompt);

      const subagent = await AgentHeadless.create(
        opts.label ?? 'workflow-agent',
        this.config,
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
}
