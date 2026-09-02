/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview WorkflowTool — user-facing tool that executes a workflow script
 * via WorkflowOrchestrator. Supports sequential `agent()`, plus concurrent
 * fan-out via `parallel()` / `pipeline()` throttled at the dispatch layer.
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
import type { WorkflowAgentDispatch } from '../../agents/runtime/workflow-orchestrator.js';
import { MAX_TOKENS_PER_WORKFLOW_ENV } from '../../agents/runtime/workflow-budget.js';
import { WorkflowRunner } from '../../agents/runtime/workflow-runner.js';
import * as path from 'node:path';
import type { WorkflowTask } from '../../agents/workflow-run-registry.js';

export interface WorkflowParams {
  /**
   * Inline JavaScript source for the workflow. Provide exactly one of
   * `script` or `scriptPath`.
   */
  script?: string;
  /**
   * P7b: absolute path to a saved workflow `.js` file to load and run
   * instead of inline `script`. Set by the `/<name>` saved-workflow slash
   * command (`SavedWorkflowLoader`). Read at execution time so edits to the
   * saved file take effect on the next run; the resolved path is recorded on
   * the registry entry as run provenance.
   */
  scriptPath?: string;
  /** Optional structured value bound to the `args` global inside the script. */
  args?: unknown;
  /**
   * P6: resume a prior run by id. When set, the run reuses `<runId>` and
   * loads `<projectDir>/workflows/<runId>/journal.jsonl`; `agent()` calls
   * whose rolling prefix-hash matches a journaled result are served from
   * cache (no re-dispatch) for the longest unchanged prefix. The first miss
   * runs live and the run goes live for the remainder.
   */
  resumeFromRunId?: string;
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
        '`agent(prompt, opts?)`, and read `args`. ' +
        'agent() opts: `{ label?, phase?, schema?, model?, agentType?, isolation? }`. ' +
        '`schema` (JSON Schema object): the subagent must deliver its result ' +
        'by calling `structured_output` with arguments matching the schema; ' +
        'agent() resolves to the validated object. Two failed attempts produce ' +
        'a terminal error "subagent completed without calling StructuredOutput ' +
        '(after 2 in-conversation nudges)". ' +
        '`agentType` (string): resolves against the declarative-agents registry ' +
        '(`.qwen/agents/<name>.md`, project then user then built-in). Unresolved ' +
        'names throw "agent({agentType}): agent type ' +
        "'X'" +
        ' not found". ' +
        '`model` (string): per-call model override; routes provider correctly ' +
        'via the subagent runtime view. ' +
        '`isolation`: `' +
        "'worktree'" +
        '` provisions a fresh git worktree under ' +
        '`<projectRoot>/.qwen/worktrees/agent-<7hex>`; the worktree is auto-removed ' +
        'if no changes, otherwise the path and branch are returned alongside the ' +
        "result. `'remote'` throws \"agent({isolation:'remote'}) is not available " +
        'in this build" (parity with upstream). isolation=worktree refuses to ' +
        'run when the parent working tree has uncommitted changes (the subagent ' +
        'would see a stale HEAD). ' +
        'Workflow subagents always have SendMessage / Monitor / EnterPlanMode / ExitPlanMode ' +
        'in their disallowed-tool floor regardless of agentType. ' +
        'Concurrency: `parallel([() => agent(...), ...])` runs thunks ' +
        'through a shared per-run window (default ' +
        '`max(1, min(16, cpus-2))` agents in flight; override via ' +
        '`QWEN_CODE_MAX_WORKFLOW_CONCURRENCY`) and resolves to a ' +
        'position-aligned array — a thunk that throws, or resolves to a ' +
        'non-JSON-serializable value, becomes `null` at its index ' +
        '(errors-as-data); parallel() itself rejects only on invalid ' +
        'arguments or abort. `pipeline(items, ...stages)` runs each item ' +
        'through the stages (staggered, no inter-stage barrier); a stage ' +
        'that throws, returns `null`, or returns a non-JSON-serializable ' +
        'value drops that item to `null`. Pass ' +
        'THUNKS to parallel, not eager calls: `parallel([() => agent(...)])`, ' +
        'not `parallel([agent(...)])`. At most 1000 agent() calls per run ' +
        '(override via `QWEN_CODE_MAX_WORKFLOW_AGENTS`). ' +
        '`Date.now()` and `Math.random()` both throw — workflow scripts ' +
        'must be deterministic for resume. ' +
        '`export const meta = {...}` declarations are stripped before execution.',
    },
    scriptPath: {
      type: 'string',
      description:
        'Optional. Absolute path to a saved workflow `.js` file to load and ' +
        'run instead of inline `script`. Primarily set by the `/<name>` ' +
        'saved-workflow slash command. Provide exactly ONE of `script` or ' +
        '`scriptPath`. The file is read at execution time, so edits to a ' +
        'saved workflow take effect on the next run.',
    },
    args: {
      description:
        'Optional structured value bound to the `args` global. Pass actual JSON, not a stringified value.',
    },
    resumeFromRunId: {
      type: 'string',
      description:
        'Optional. Resume a prior workflow run by id (e.g. wf_abc123…). ' +
        'Re-runs the SAME script; agent() calls whose rolling prefix-hash ' +
        '(prompt + opts, chained in call order) matches a journaled result ' +
        'are served from cache for the longest unchanged prefix, and the ' +
        'first changed/missing call onward runs live. Pass the same script ' +
        'and args as the original run for the cache to apply.',
    },
  },
  // `script` is required UNLESS `scriptPath` is supplied; this XOR can't be
  // expressed as a plain `required` list, so it's enforced in
  // `validateToolParamValues`. Inline authoring (the LLM path) should always
  // pass `script`; the `scriptPath` property description states the XOR.
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
    if (this.params.scriptPath && this.params.script === undefined) {
      return `Run saved workflow (${path.basename(this.params.scriptPath)})`;
    }
    return `Run a workflow script (${this.params.script?.length ?? 0} chars)`;
  }

  override toolLocations(): ToolLocation[] {
    return [];
  }

  override getDefaultPermission(): Promise<'ask'> {
    return Promise.resolve('ask');
  }

  override async execute(
    signal: AbortSignal,
    updateOutput?: (output: ToolResultDisplay) => void,
    _shellExecutionConfig?: ShellExecutionConfig,
  ): Promise<ToolResult> {
    const handle = await WorkflowRunner.start({
      config: this.config,
      signal,
      script: this.params.script,
      scriptPath: this.params.scriptPath,
      args: this.params.args,
      resumeFromRunId: this.params.resumeFromRunId,
      dispatch: this.toolOptions.dispatch,
      onUpdate: updateOutput
        ? (entry) => safeEmitUpdate(updateOutput, entry)
        : undefined,
    });
    const settlement = await handle.completion;
    if (settlement.ok) {
      const { outcome } = settlement;
      const usageBanner = resolveUsageBanner(
        this.config,
        handle.registry,
        handle.budget.total,
      );

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
      // P4: surface the extracted `export const meta` declaration in the
      // display payload so the user (and future /workflows listing) can
      // see the workflow's name / description / phases without re-reading
      // the script. Omitted when the script had no meta declaration to
      // keep the payload shape minimal.
      const displayJson = safeStringifyDisplayPayload({
        runId: outcome.runId,
        ...(outcome.meta ? { meta: outcome.meta } : {}),
        phases: outcome.phases,
        logs: outcome.logs,
        result: outcome.result,
        // P5: surface the per-run token total in the terminal display so
        // the user sees actual usage even without opening the dialog.
        // P5 R1 (#11): align with `buildLivePhaseTreeDisplay` — include
        // tokens whenever ANY usage is reported OR a cap is set, not
        // only when spend > 0. A capped-but-zero-spend run still wants
        // the cap visible so the user sees the gate engaged.
        ...(handle.budget.spent() > 0 || handle.budget.total !== null
          ? {
              tokens: {
                spent: handle.budget.spent(),
                total: handle.budget.total,
              },
            }
          : {}),
      });

      return {
        llmContent: [{ text: llmText }],
        returnDisplay: usageBanner + '```json\n' + displayJson + '\n```',
      };
    } else {
      // FIX-H (Round 5 SEC Minor): surface only the message — never the
      // stack frame — to the LLM and the UI. Caller's stderr/debug log
      // can still see the full stack via standard logging mechanisms.
      //
      // Cross-realm `instanceof Error` is false for vm-realm Errors; use
      // duck-typed extraction so script-thrown errors aren't coerced to
      // their "Error: <msg>" toString() form.
      const { message, details } = settlement;
      const { phases, logs, meta } = details ?? {};
      // T19 (PR #4732 R1): if the orchestrator preserved phases / logs
      // accumulated before the failure, include them in the display so
      // the user can see what ran before the error.
      // P4: also surface the extracted meta on the failure path. The script
      // body may have thrown long after the meta declaration parsed
      // cleanly; keeping name/description/phases visible on failure helps
      // the user identify which workflow ran.
      // P5 T7: banner is intentionally OMITTED on the failure path.
      // The scheduler's `createErrorResponse` (coreToolScheduler.ts:801)
      // hard-codes `resultDisplay: error.message` whenever a tool
      // returns `error` — overriding any returnDisplay we set. Firing
      // the banner here would (a) be invisible to TUI users since the
      // scheduler drops it, AND (b) consume the registry's one-shot
      // latch, so the NEXT successful run would silently skip the
      // banner too. The trade-off: a brand-new user whose FIRST
      // workflow throws will not see the banner until a later
      // successful run. Mitigation: WorkflowTool's failure message
      // already names the error; the banner is meta-documentation
      // about a separate env knob, not run-specific guidance.
      const display =
        phases || logs || meta
          ? `Workflow failed: ${message}\n\n${safeStringifyDisplayPayload({
              ...(meta ? { meta } : {}),
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
 * P4b: render an in-flight workflow as a compact JSON block for
 * `_updateOutput`. Same shape as the terminal `returnDisplay` so the
 * TUI does not need a separate live renderer. Logs are omitted from
 * the live snapshot — they would churn at >10Hz and the per-line
 * channel adds little value while a workflow is still running.
 */
function buildLivePhaseTreeDisplay(entry: WorkflowTask): string {
  const payload: Record<string, unknown> = {
    runId: entry.runId,
    ...(entry.meta ? { meta: entry.meta } : {}),
    status: entry.status,
    currentPhase: entry.currentPhase,
    phases: entry.phases,
    agentsDispatched: entry.agentsDispatched,
    agentsCompleted: entry.agentsCompleted,
  };
  // P5: include budget info when there's any usage to report OR a cap
  // is set. Both `tokensSpent > 0` and `tokenBudgetTotal !== null` are
  // independently meaningful: an uncapped run that's spent tokens
  // wants the spent total; a capped run with 0 spent still wants the
  // cap visible so the user sees the gate. Keeps the JSON minimal in
  // the common case (no cap, nothing spent yet).
  if (entry.tokensSpent > 0 || entry.tokenBudgetTotal !== null) {
    payload['tokens'] = {
      spent: entry.tokensSpent,
      total: entry.tokenBudgetTotal,
    };
  }
  try {
    return '```json\n' + JSON.stringify(payload, null, 2) + '\n```';
  } catch {
    return `Workflow ${entry.runId} — ${entry.status} — ${entry.phases.length} phase(s)`;
  }
}

/**
 * P5 T7: one-time usage-banner gate. Three filters: settings-level
 * suppression (`skipWorkflowUsageWarning`), the per-session registry
 * latch (`shouldShowUsageWarning`), and the presence of a registry.
 * Returns the banner string when all three pass, empty string otherwise.
 *
 * Called from the SUCCESS path only — see the failure-path comment in
 * `execute()` for why: `coreToolScheduler.createErrorResponse` hard-codes
 * `resultDisplay = error.message` whenever `result.error` is set, so a
 * failure-path banner would be invisible to TUI users AND would silently
 * flip the registry latch, robbing the next successful run of its banner.
 *
 * The banner is prepended to `returnDisplay` only — `llmContent` stays
 * clean so the banner doesn't bias model behavior in agentic loops that
 * read tool results back.
 *
 * Skipped when (a) settings suppress, (b) the registry is absent (test
 * paths that omit the wired Config), or (c) the latch already fired
 * this session.
 */
function resolveUsageBanner(
  config: Config,
  registry: { shouldShowUsageWarning(): boolean } | undefined,
  budgetTotal: number | null,
): string {
  if (!registry) return '';
  if (config.getSkipWorkflowUsageWarning?.()) return '';
  if (!registry.shouldShowUsageWarning()) return '';
  return buildUsageBanner(budgetTotal);
}

/**
 * P5 T7: build the one-time usage-warning banner. Two shapes:
 * (a) `total === null` — explain the uncapped state and the env knob;
 * (b) `total !== null` — confirm the cap is in effect.
 *
 * Both shapes mention `skipWorkflowUsageWarning` so the user knows how
 * to suppress further banners. The banner ends with two newlines so it
 * separates cleanly from the fenced JSON code block that follows in
 * `returnDisplay`.
 */
function buildUsageBanner(total: number | null): string {
  // Banner says "soft cap" rather than "hard ceiling" because the gate
  // is checked at dispatch ENTRY — concurrent fan-out can overshoot by
  // up to (concurrency_window - 1) × per_dispatch_tokens before the
  // first overshoot is caught. See workflow-budget.ts threat-model
  // doc for the precise overshoot bound.
  if (total === null) {
    return (
      `> Workflows have no per-run token cap. Set ` +
      `\`${MAX_TOKENS_PER_WORKFLOW_ENV}=<n>\` (env) for a soft cap. ` +
      `Suppress this notice with \`skipWorkflowUsageWarning: true\` ` +
      `in settings.\n\n`
    );
  }
  return (
    `> Workflow token cap is ${total} (per ` +
    `\`${MAX_TOKENS_PER_WORKFLOW_ENV}\`). ` +
    `Suppress this notice with \`skipWorkflowUsageWarning: true\` ` +
    `in settings.\n\n`
  );
}

/**
 * Defensive bridge from the emitter's host-realm callbacks to
 * `updateOutput`. The TUI's renderer wraps the callback in its own
 * try/catch but we add another layer here because an outer throw
 * inside `phaseStarted` would propagate up through the vm-realm
 * `bridge.pushPhase` call and corrupt the script's `phase()` global.
 */
function safeEmitUpdate(
  updateOutput: ((output: ToolResultDisplay) => void) | undefined,
  entry: WorkflowTask | undefined,
): void {
  if (!updateOutput || !entry) return;
  try {
    updateOutput(buildLivePhaseTreeDisplay(entry));
  } catch {
    // Renderer errors must not interrupt orchestration.
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

/**
 * T30 (PR #4732 R3): degrade per-field instead of all-or-nothing. The
 * happy path is one stringify; on failure, walk the top-level keys and
 * replace each non-serializable value with a placeholder, then
 * re-stringify. This keeps always-serializable metadata (runId, phases,
 * logs) visible to the user even when one field (typically `result`)
 * carries a BigInt / circular value. Future-proof against new payload
 * fields without requiring caller-side special cases.
 */
function safeStringifyDisplayPayload(payload: unknown): string {
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    if (payload && typeof payload === 'object') {
      const sanitized: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(payload)) {
        try {
          JSON.stringify(value);
          sanitized[key] = value;
        } catch {
          sanitized[key] =
            `(non-JSON-serializable value of type ${typeof value})`;
        }
      }
      try {
        return JSON.stringify(sanitized, null, 2);
      } catch {
        // Fall through to the generic fallback string below.
      }
    }
    return '(display payload not JSON-serializable)';
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
      'Execute a workflow script that orchestrates subagents. ' +
        'Supports `phase`, `log`, sequential `agent`, concurrent fan-out via ' +
        '`parallel(thunks)` / `pipeline(items, ...stages)` (default ' +
        '`max(1, min(16, cpus-2))` agents in flight per run, up to 1000 ' +
        'agents total; both env-overridable), per-call `agent({ schema, ' +
        "agentType, model, isolation: 'worktree' })` for structured-output " +
        'contracts, declarative-agent selection, model override, and git-' +
        'worktree-isolated subagents. Pass `resumeFromRunId` to resume a prior ' +
        'run — agent() calls whose rolling prefix-hash matches the journal are ' +
        'served from cache for the longest unchanged prefix. Runs are tracked ' +
        'in the background-tasks view and the `/workflows` dialog (live phase ' +
        'tree, token usage, cancel). Scripts run in a node:vm sandbox without ' +
        'access to the filesystem or shell; all I/O happens through the ' +
        'spawned agents.',
      Kind.Other,
      WORKFLOW_PARAM_SCHEMA,
      /* isOutputMarkdown */ true,
      /* canUpdateOutput */ true,
    );
  }

  protected override validateToolParamValues(
    params: WorkflowParams,
  ): string | null {
    const hasScript =
      typeof params.script === 'string' && params.script.length > 0;
    const hasPath =
      typeof params.scriptPath === 'string' && params.scriptPath.length > 0;
    // XOR: inline `script` (LLM authoring) or `scriptPath` (a saved-workflow
    // slash command), never both, never neither.
    if (!hasScript && !hasPath) {
      return 'WorkflowTool: provide `script` (inline source) or `scriptPath` (a saved workflow file).';
    }
    if (hasScript && hasPath) {
      return 'WorkflowTool: provide exactly one of `script` or `scriptPath`, not both.';
    }
    // Security: `resumeFromRunId` becomes the `runId` and flows verbatim into
    // `getWorkflowRunJournalPath` / `getWorkflowRunSnapshotPath` (both
    // `path.join`-based), so a value containing `..` or path separators could
    // move journal/snapshot reads and writes outside `<projectDir>/workflows`.
    // Accept only the generated id shape.
    if (
      params.resumeFromRunId !== undefined &&
      !/^wf_[0-9a-f]+$/.test(params.resumeFromRunId)
    ) {
      return 'WorkflowTool: `resumeFromRunId` must match the generated id format `wf_<hex>`.';
    }
    return null;
  }

  protected createInvocation(
    params: WorkflowParams,
  ): ToolInvocation<WorkflowParams, ToolResult> {
    return new WorkflowToolInvocation(this.config, this.toolOptions, params);
  }
}
