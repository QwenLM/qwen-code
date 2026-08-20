/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../../config/config.js';
import type { ToolInvocation, ToolResult } from '../tools.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from '../tools.js';
import { ToolDisplayNames, ToolNames } from '../tool-names.js';
import { ToolErrorType } from '../tool-error.js';
import { HeadlessSpawner } from '../../workflows/spawner.js';
import {
  WorkflowEngine,
  WorkflowScriptError,
  resolveNamedWorkflow,
} from '../../workflows/index.js';

export interface WorkflowRunToolParams {
  script?: string;
  scriptPath?: string;
  name?: string;
  args?: unknown;
  resumeFromRunId?: string;
}

/** Test seam: a Config may carry a pre-built spawner/runsDir override. */
interface WorkflowConfigSeam {
  __workflowSpawner?: { spawn: HeadlessSpawner['spawn'] };
  __workflowRunsDir?: string;
}

async function resolveSource(
  params: WorkflowRunToolParams,
  workingDir: string,
): Promise<string> {
  if (typeof params.script === 'string') return params.script;
  if (typeof params.scriptPath === 'string') {
    // `scriptPath` is an explicit, operator-supplied path: it is *meant* to
    // point anywhere the operator chooses, so it is deliberately NOT sandboxed
    // to .qwen/workflows. We only reject obviously malformed values. Only
    // `name` (below) is constrained to the workflows directory.
    if (params.scriptPath.length === 0 || params.scriptPath.includes('\0')) {
      throw new WorkflowScriptError('invalid scriptPath: empty or malformed');
    }
    return readFile(params.scriptPath, 'utf8');
  }
  if (typeof params.name === 'string') {
    // Single guarded name resolution shared with the gateway route (see
    // workflows/resolveNamed.ts) — one traversal defense, not two copies.
    return resolveNamedWorkflow(params.name, {
      workingDir,
      homeDir: homedir(),
    });
  }
  throw new WorkflowScriptError(
    'Workflow requires one of: script, scriptPath, name',
  );
}

class WorkflowRunToolInvocation extends BaseToolInvocation<
  WorkflowRunToolParams,
  ToolResult
> {
  constructor(
    private readonly config: Config,
    params: WorkflowRunToolParams,
  ) {
    super(params);
  }

  getDescription(): string {
    if (this.params.name) return `workflow: ${this.params.name}`;
    if (this.params.scriptPath) return `workflow: ${this.params.scriptPath}`;
    return 'workflow: inline script';
  }

  async execute(signal: AbortSignal): Promise<ToolResult> {
    const registry = this.config.getBackgroundTaskRegistry();
    const seam = this.config as unknown as WorkflowConfigSeam;
    const spawner = seam.__workflowSpawner ?? new HeadlessSpawner(this.config);
    const runsDir = seam.__workflowRunsDir; // undefined → engine default (~/.qwen/...)
    const engine = new WorkflowEngine(spawner as HeadlessSpawner, { runsDir });

    let source: string;
    try {
      source = await resolveSource(this.params, this.config.getWorkingDir());
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return {
        llmContent: `Workflow error: ${message}`,
        returnDisplay: `Error: ${message}`,
        error: { message, type: ToolErrorType.INVALID_TOOL_PARAMS },
      };
    }

    // Foreground task (isBackgrounded: false) → never consumes the
    // background-agent concurrency cap. agentId = runId keeps the pill stable.
    const runId = crypto.randomUUID();
    registry.register({
      agentId: runId,
      subagentType: 'workflow',
      description: this.getDescription(),
      status: 'running',
      startTime: Date.now(),
      outputFile: join(
        homedir(),
        '.qwen',
        'workflows',
        'runs',
        runId,
        'run.json',
      ),
      isBackgrounded: false,
      abortController: new AbortController(),
      prompt: this.params.name ?? this.params.scriptPath ?? 'inline',
    } as never);

    // Outer finally guarantees the foreground registry entry is removed on
    // every termination shape (success, failure, unexpected throw) — matching
    // the agent tool-call pattern (see agents/agent.ts). The inner try/catch
    // still performs the terminal complete()/fail() transition first, and
    // because `return` runs the finally before returning, unregisterForeground
    // always fires *after* the terminal status transition.
    try {
      try {
        const result = await engine.run(source, {
          runId,
          args: this.params.args,
          resumeFromRunId: this.params.resumeFromRunId,
          signal,
          onPhase: (title, index) =>
            registry.appendActivity(runId, {
              name: 'phase',
              description: `Phase ${index}: ${title}`,
              at: Date.now(),
            }),
          onAgentCount: (counted) =>
            registry.appendActivity(runId, {
              name: 'agents',
              description: `${counted} agent(s) spawned`,
              at: Date.now(),
            }),
        });
        registry.complete(
          runId,
          JSON.stringify({ runId, tokensSpent: result.tokensSpent }),
          {
            totalTokens: result.tokensSpent,
            outputTokens: 0,
            toolUses: 0,
            durationMs: 0,
          },
        );
        const payload = JSON.stringify({
          runId: result.runId,
          result: result.result,
        });
        return {
          llmContent: payload,
          returnDisplay: `Workflow ${result.status} (run ${result.runId}).`,
        };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        registry.fail(runId, message);
        const type =
          e instanceof WorkflowScriptError
            ? ToolErrorType.INVALID_TOOL_PARAMS
            : ToolErrorType.EXECUTION_FAILED;
        return {
          llmContent: `Workflow failed: ${message}`,
          returnDisplay: `Error: ${message}`,
          error: { message, type },
        };
      }
    } finally {
      registry.unregisterForeground(runId);
    }
  }
}

/**
 * The `WorkflowRun` tool (design: "CLI tool"). Runs a sandboxed workflow script
 * over the headless agent runtime and surfaces the run through the
 * background-task registry.
 */
export class WorkflowRunTool extends BaseDeclarativeTool<
  WorkflowRunToolParams,
  ToolResult
> {
  static readonly Name = ToolNames.WORKFLOW_RUN;

  constructor(private readonly config: Config) {
    super(
      WorkflowRunTool.Name,
      ToolDisplayNames.WORKFLOW_RUN,
      'Run a deterministic, sandboxed multi-agent workflow script. Provide one of `script` (inline JS), `scriptPath` (a .js file), or `name` (resolved from .qwen/workflows). Returns { runId, result }.',
      Kind.Think,
      {
        type: 'object',
        properties: {
          script: {
            type: 'string',
            description: 'Inline workflow script source.',
          },
          scriptPath: {
            type: 'string',
            description: 'Absolute path to a workflow .js file.',
          },
          name: {
            type: 'string',
            description: 'Named workflow in .qwen/workflows/<name>.js.',
          },
          args: {
            description: 'Optional value exposed to the script as `args`.',
          },
          resumeFromRunId: {
            type: 'string',
            description:
              'Resume from a prior run id (replays the cached prefix).',
          },
        },
      },
    );
  }

  protected override validateToolParamValues(
    params: WorkflowRunToolParams,
  ): string | null {
    if (!params.script && !params.scriptPath && !params.name) {
      return 'Provide one of: script, scriptPath, name.';
    }
    return null;
  }

  protected createInvocation(
    params: WorkflowRunToolParams,
  ): ToolInvocation<WorkflowRunToolParams, ToolResult> {
    return new WorkflowRunToolInvocation(this.config, params);
  }
}
