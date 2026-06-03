/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview WorkflowTool — user-facing tool that executes a workflow script
 * via WorkflowOrchestrator (P1: sequential agent dispatch only).
 */

import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  type ToolInvocation,
  type ToolResult,
  type ToolResultDisplay,
  type ToolLocation,
} from '../tools.js';
import type { ShellExecutionConfig } from '../../services/shellExecutionService.js';
import { ToolNames, ToolDisplayNames } from '../tool-names.js';
import type { Config } from '../../config/config.js';
import {
  WorkflowOrchestrator,
  type WorkflowOrchestratorOptions,
} from '../../agents/runtime/workflow-orchestrator.js';

export interface WorkflowParams {
  /** Inline JavaScript source for the workflow. Required in P1. */
  script: string;
  /** Optional structured value bound to the `args` global inside the script. */
  args?: unknown;
}

export interface WorkflowToolOptions {
  /**
   * Test-only orchestrator overrides (dispatch injection). Production callers
   * should leave this undefined so the orchestrator wires real AgentHeadless.
   */
  orchestratorOverrides?: WorkflowOrchestratorOptions;
}

const WORKFLOW_PARAM_SCHEMA = {
  type: 'object',
  properties: {
    script: {
      type: 'string',
      description:
        'JavaScript source of the workflow. Wrapped as an async IIFE. ' +
        'May call the injected globals `phase(title)`, `log(msg)`, ' +
        '`agent(prompt, { label? })` (sequential only in P1), and read `args`. ' +
        '`Date.now()` returns a fixed value; `Math.random()` throws. ' +
        '`export const meta = {...}` declarations are stripped before execution.',
    },
    args: {
      description:
        'Optional structured value bound to the `args` global. Pass actual JSON, not a stringified value.',
    },
  },
  required: ['script'],
} as const;

class WorkflowToolInvocation extends BaseToolInvocation<
  WorkflowParams,
  ToolResult
> {
  constructor(
    private readonly config: Config,
    private readonly toolOptions: WorkflowToolOptions,
    params: WorkflowParams,
  ) {
    super(params);
  }

  getDescription(): string {
    return `Run a workflow script (${this.params.script.length} chars)`;
  }

  override toolLocations(): ToolLocation[] {
    return [];
  }

  override getDefaultPermission(): Promise<'ask'> {
    return Promise.resolve('ask');
  }

  override async execute(
    signal: AbortSignal,
    _updateOutput?: (output: ToolResultDisplay) => void,
    _shellExecutionConfig?: ShellExecutionConfig,
  ): Promise<ToolResult> {
    const orchestrator = new WorkflowOrchestrator(
      this.config,
      this.toolOptions.orchestratorOverrides,
    );
    try {
      const outcome = await orchestrator.run({
        script: this.params.script,
        args: this.params.args,
        signal,
      });
      const payload = {
        runId: outcome.runId,
        result: outcome.result,
        phases: outcome.phases,
        logs: outcome.logs,
      };
      const json = JSON.stringify(payload, null, 2);
      return {
        llmContent: [{ text: json }],
        returnDisplay: '```json\n' + json + '\n```',
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        llmContent: [{ text: `Workflow failed: ${message}` }],
        returnDisplay: `Workflow failed: ${message}`,
        error: { message },
      };
    }
  }
}

export class WorkflowTool extends BaseDeclarativeTool<
  WorkflowParams,
  ToolResult
> {
  constructor(
    private readonly config: Config,
    private readonly toolOptions: WorkflowToolOptions = {},
  ) {
    super(
      ToolNames.WORKFLOW,
      ToolDisplayNames.WORKFLOW,
      'Execute a workflow script that orchestrates subagents sequentially. ' +
        'P1 supports `phase`, `log`, and sequential `agent` only. No parallel, ' +
        'no pipeline, no schema, no resume, no background execution. ' +
        'Scripts run in a node:vm sandbox without access to the filesystem or ' +
        'shell; all I/O happens through the spawned agents.',
      Kind.Other,
      WORKFLOW_PARAM_SCHEMA,
      /* isOutputMarkdown */ true,
      /* canUpdateOutput */ false,
    );
  }

  protected override validateToolParamValues(
    params: WorkflowParams,
  ): string | null {
    if (typeof params.script !== 'string' || params.script.length === 0) {
      return 'WorkflowTool: `script` parameter is required and must be a non-empty string.';
    }
    return null;
  }

  protected createInvocation(
    params: WorkflowParams,
  ): ToolInvocation<WorkflowParams, ToolResult> {
    return new WorkflowToolInvocation(this.config, this.toolOptions, params);
  }
}
