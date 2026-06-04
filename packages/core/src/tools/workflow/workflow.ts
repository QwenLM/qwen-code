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
// FIX-10 (REUSE-I1): import ToolErrorType to use the standard machine-readable
// error code rather than an ad-hoc bare `{ message }` object.
import { ToolErrorType } from '../tool-error.js';
import type { Config } from '../../config/config.js';
import {
  WorkflowOrchestrator,
  WorkflowExecutionError,
  createProductionDispatch,
  type WorkflowAgentDispatch,
} from '../../agents/runtime/workflow-orchestrator.js';

export interface WorkflowParams {
  /** Inline JavaScript source for the workflow. Required in P1. */
  script: string;
  /** Optional structured value bound to the `args` global inside the script. */
  args?: unknown;
}

export interface WorkflowToolOptions {
  /**
   * Test-only dispatch injection. Production callers should leave this
   * undefined so createProductionDispatch wires real AgentHeadless.
   */
  dispatch?: WorkflowAgentDispatch;
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
        '`Date.now()` and `Math.random()` both throw — workflow scripts ' +
        'must be deterministic for resume. ' +
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
    const dispatch =
      this.toolOptions.dispatch ??
      createProductionDispatch(this.config, signal);
    const orchestrator = new WorkflowOrchestrator(dispatch);
    try {
      const outcome = await orchestrator.run({
        script: this.params.script,
        args: this.params.args,
      });

      // FIX-7 (UP-C2): unwrap the script result so the LLM receives the
      // script's return value verbatim. The full metadata (runId, phases,
      // logs) is preserved in returnDisplay for the UI but does not pad
      // the LLM context with bookkeeping noise.
      //
      // T12 / T18 (PR #4732 R1): defensive serialization. A successful
      // workflow whose `return` value is a BigInt, a circular reference,
      // or otherwise non-JSON used to be reported as `Workflow failed:
      // Converting circular structure to JSON` — the script succeeded but
      // the post-processing crashed. Wrap each JSON.stringify in its own
      // try/catch with a clear placeholder so a serialization issue
      // degrades gracefully instead of masquerading as a run failure.
      const llmText = safeStringifyResult(outcome.result);
      const displayJson = safeStringifyDisplayPayload({
        runId: outcome.runId,
        phases: outcome.phases,
        logs: outcome.logs,
        result: outcome.result,
      });

      return {
        llmContent: [{ text: llmText }],
        returnDisplay: '```json\n' + displayJson + '\n```',
      };
    } catch (err) {
      // FIX-H (Round 5 SEC Minor): surface only the message — never the
      // stack frame — to the LLM and the UI. Caller's stderr/debug log
      // can still see the full stack via standard logging mechanisms.
      //
      // Cross-realm `instanceof Error` is false for vm-realm Errors; use
      // duck-typed extraction so script-thrown errors aren't coerced to
      // their "Error: <msg>" toString() form.
      const message = extractErrorMessage(err);
      // T19 (PR #4732 R1): if the orchestrator preserved phases / logs
      // accumulated before the failure, include them in the display so
      // the user can see what ran before the error.
      const phases =
        err instanceof WorkflowExecutionError ? err.phases : undefined;
      const logs = err instanceof WorkflowExecutionError ? err.logs : undefined;
      const display =
        phases || logs
          ? `Workflow failed: ${message}\n\n${safeStringifyDisplayPayload({
              phases: phases ?? [],
              logs: logs ?? [],
            })}`
          : `Workflow failed: ${message}`;
      return {
        llmContent: [{ text: `Workflow failed: ${message}` }],
        returnDisplay: display,
        // FIX-10 (REUSE-I1): use the standard ToolErrorType.EXECUTION_FAILED
        // code so error routing / dashboards can classify workflow failures
        // the same way as other execution-time tool errors.
        error: { message, type: ToolErrorType.EXECUTION_FAILED },
      };
    }
  }
}

/**
 * T12 / T18 (PR #4732 R1): serialize the script's return value, falling back
 * to a clear placeholder on BigInt / circular / non-JSON values so a
 * successful workflow is not reported as a failure.
 */
function safeStringifyResult(result: unknown): string {
  if (result === undefined) return '(workflow returned no value)';
  if (typeof result === 'string') return result;
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return `(workflow returned a non-JSON-serializable value of type ${typeof result})`;
  }
}

function safeStringifyDisplayPayload(payload: unknown): string {
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return '(display payload not JSON-serializable)';
  }
}

/**
 * Duck-typed extraction so vm-realm Errors (raised inside the sandbox)
 * don't coerce to "Error: <msg>" via toString(). See workflow-orchestrator.ts
 * for the matching helper on the orchestrator side.
 */
function extractErrorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err) {
    const m = (err as { message: unknown }).message;
    if (typeof m === 'string') return m;
    return String(m);
  }
  return String(err);
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
