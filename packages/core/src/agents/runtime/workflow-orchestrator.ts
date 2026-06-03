import { randomBytes } from 'node:crypto';
import type { Config } from '../../config/config.js';
import { createWorkflowSandbox } from './workflow-sandbox.js';

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
  opts: { label?: string },
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
    const dispatch = this.options.dispatch ?? this.buildProductionDispatch();
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
   * Implemented lazily in Task 7 so this file can be unit-tested without
   * importing the entire agent runtime.
   */
  private buildProductionDispatch(): WorkflowAgentDispatch {
    // Task 7 will wire these into the real AgentHeadless dispatch path.
    void this.config;
    void WORKFLOW_SUBAGENT_SYSTEM_PROMPT;
    return async (_prompt, _opts) => {
      throw new Error(
        'WorkflowOrchestrator: production dispatch not wired yet. ' +
          'P1 step 7 wires AgentHeadless; until then tests must inject options.dispatch.',
      );
    };
  }
}
