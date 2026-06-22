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
import {
  WorkflowOrchestrator,
  WorkflowExecutionError,
  createProductionDispatch,
  type WorkflowAgentDispatch,
  type WorkflowOrchestratorEmitter,
} from '../../agents/runtime/workflow-orchestrator.js';
import {
  WorkflowBudgetImpl,
  MAX_TOKENS_PER_WORKFLOW_ENV,
} from '../../agents/runtime/workflow-budget.js';
import { resolveSavedWorkflowScript } from '../../agents/runtime/workflow-saved.js';
import { WorkflowJournal } from '../../agents/runtime/workflow-journal.js';
import type { JournalReplay } from '../../agents/runtime/workflow-journal.js';
import { writeWorkflowSnapshot } from '../../agents/workflow-snapshot.js';
import { logWorkflowRun } from '../../telemetry/loggers.js';
import { WorkflowRunEvent } from '../../telemetry/types.js';
import { createChildAbortController } from '../../utils/abortController.js';
import { randomBytes } from 'node:crypto';
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
        'Workflow subagents always have SendMessage / ExitPlanMode in their ' +
        'disallowed-tool floor regardless of agentType. ' +
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
    // T40 (PR #4732 R4): child controller so dispatch sees caller aborts
    // AND sandbox.ts wall-clock aborts (see setTimeout handler).
    const dispatchController = createChildAbortController(signal);
    // P5: per-run token tracker. Reads `QWEN_CODE_MAX_TOKENS_PER_WORKFLOW`
    // from the environment via the impl's `fromEnv` factory. When the env
    // is unset (`budget.total === null`), the orchestrator's gate is a
    // no-op and `budgetUpdated` events still fire so the registry can
    // surface cumulative usage even on uncapped runs.
    const budget = WorkflowBudgetImpl.fromEnv();
    const dispatch =
      this.toolOptions.dispatch ??
      createProductionDispatch(
        this.config,
        dispatchController.signal,
        // P5 T3: production-dispatch onTokens callback. Test-injected
        // dispatches (`toolOptions.dispatch`) handle their own
        // recording — they don't surface stats the same way.
        (outputTokens) => budget.recordSpent(outputTokens),
      );
    const orchestrator = new WorkflowOrchestrator(dispatch);

    // P7b: resolve the script source. A `/<name>` saved-workflow slash
    // command dispatches `{scriptPath}` instead of inline `script`; read the
    // file here (fresh, so edits to a saved workflow take effect on the next
    // run). The resolved absolute path is recorded on the registry entry as
    // run provenance — it is never re-read mid-run. `validateToolParamValues`
    // has already guaranteed exactly one of `script` / `scriptPath` is set.
    let resolvedScript = this.params.script ?? '';
    let resolvedScriptPath = this.params.scriptPath;
    if (this.params.scriptPath && this.params.script === undefined) {
      const loaded = await resolveSavedWorkflowScript(
        { scriptPath: this.params.scriptPath },
        this.config,
      );
      resolvedScript = loaded.script;
      resolvedScriptPath = loaded.scriptPath;
    }

    // P4b: pre-generate the runId so the registry record exists before
    // the first sandbox event fires. Without this, `agentDispatched` /
    // `phaseStarted` callbacks would have no entry to update.
    // P6: a resume reuses the prior run's id so it appends to the same
    // journal; a fresh run gets a new id.
    const runId =
      this.params.resumeFromRunId ?? `wf_${randomBytes(8).toString('hex')}`;
    // P6: per-run resume journal. Always created (any run is resumable);
    // the replay maps are loaded only when resuming. Production storage
    // path is `<projectDir>/workflows/<runId>/journal.jsonl`; the tool's
    // test-injected dispatch path leaves `config.storage` undefined, so
    // guard and skip journaling there.
    let journal: WorkflowJournal | undefined;
    let resumeReplay: JournalReplay | undefined;
    const storage = this.config.storage;
    if (storage) {
      journal = new WorkflowJournal(storage.getWorkflowRunJournalPath(runId));
      if (this.params.resumeFromRunId) {
        resumeReplay = await journal.load();
      }
    }
    const registry = this.config.getWorkflowRunRegistry?.();
    const registryEntry = registry?.register({
      runId,
      meta: null, // populated after meta parses; safe default until then
      status: 'running',
      startTime: Date.now(),
      outputFile: '', // P4b reserves the field but doesn't materialize
      abortController: dispatchController,
      // P5: seed the cap so the dialog can render the `M / N` form
      // immediately, before the first `budgetUpdated` fires. Stays
      // `null` when no env override.
      tokenBudgetTotal: budget.total,
      // P7b: carry the script source so a completed run can be snapshotted
      // to disk and saved to `.qwen/workflows/<name>.js` from the dialog.
      // `scriptPath` is set when the run was launched from a saved file (run
      // provenance for the snapshot).
      script: resolvedScript,
      scriptPath: resolvedScriptPath,
    });
    // The emitter forwards sandbox + dispatch events into the registry
    // AND fires `updateOutput` so the tool's renderDisplay block (a
    // phase-tree-shaped JSON) refreshes live in the TUI. Each method
    // is fail-safe: registry mutation errors are swallowed by the
    // registry itself; updateOutput errors are caught here.
    const emitter: WorkflowOrchestratorEmitter = {
      phaseStarted: (title) => {
        registry?.onPhaseStarted(runId, title);
        safeEmitUpdate(updateOutput, registryEntry);
      },
      agentDispatched: () => {
        registry?.onAgentDispatched(runId);
        safeEmitUpdate(updateOutput, registryEntry);
      },
      agentCompleted: () => {
        registry?.onAgentCompleted(runId);
        // P5 R2 (#12): defer the UI re-render to the `budgetUpdated`
        // callback that the orchestrator fires immediately after this
        // one. Without this skip, every dispatch completion produces
        // TWO `safeEmitUpdate` calls (one here + one in budgetUpdated)
        // — over a 1000-agent workflow that's 2000 TUI redraws when
        // 1000 suffices. The budget snapshot lands AFTER the agent
        // counter increment, so the deferred render shows both updates
        // atomically. Production callers always wire a budget
        // (`WorkflowBudgetImpl.fromEnv()` in `execute()` above), so the
        // deferral is unconditional; test paths that omit budget go
        // through the injected dispatch shape and don't exercise this
        // emitter wiring.
      },
      logAppended: () => {
        // P4b: skip per-line emit; the tool snapshots logs at terminal
        // via `registry.setRecentLogs` so the registry record reflects
        // the final tail without per-line churn driving rerenders.
      },
      budgetUpdated: (spent, total) => {
        registry?.onBudgetUpdated(runId, spent, total);
        safeEmitUpdate(updateOutput, registryEntry);
      },
    };

    try {
      const outcome = await orchestrator.run({
        script: resolvedScript,
        args: this.params.args,
        abortOnTimeout: dispatchController,
        runId,
        emitter,
        budget,
        // P-nested: resolve `workflow('<name>')` / `workflow({scriptPath})`
        // against the saved-workflow scripts in `.qwen/workflows/`.
        resolveSavedWorkflow: (ref) =>
          resolveSavedWorkflowScript(ref, this.config),
        // P6: resume journal (always wired) + replay maps (resume only).
        journal,
        resumeReplay,
      });

      // P4b: snapshot meta + logs onto the registry record so the dialog
      // detail body reflects the final state once the run terminates.
      if (registryEntry) {
        registryEntry.meta = outcome.meta;
        if (outcome.meta?.name && registryEntry.description === runId) {
          registryEntry.description = outcome.meta.name;
        }
      }
      registry?.setRecentLogs(runId, outcome.logs);
      registry?.complete(runId, outcome.result, Date.now());

      const usageBanner = resolveUsageBanner(
        this.config,
        registry,
        budget.total,
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
        ...(budget.spent() > 0 || budget.total !== null
          ? {
              tokens: {
                spent: budget.spent(),
                total: budget.total,
              },
            }
          : {}),
      });

      return {
        llmContent: [{ text: llmText }],
        returnDisplay: usageBanner + '```json\n' + displayJson + '\n```',
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
      // P4: also surface the extracted meta on the failure path. The script
      // body may have thrown long after the meta declaration parsed
      // cleanly; keeping name/description/phases visible on failure helps
      // the user identify which workflow ran.
      const meta = err instanceof WorkflowExecutionError ? err.meta : undefined;
      // P4b: surface the failure / abort to the registry. A caller-aborted
      // run (`signal.aborted === true`) becomes `cancelled` rather than
      // `failed` so the dialog distinguishes user intent from script bugs.
      if (registryEntry) {
        if (meta && !registryEntry.meta) registryEntry.meta = meta;
      }
      if (logs) registry?.setRecentLogs(runId, logs);
      if (signal.aborted) {
        registry?.cancel(runId, Date.now());
      } else {
        registry?.fail(runId, message, Date.now());
      }
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
    } finally {
      // T40: cancel any straggler subagent on natural completion.
      dispatchController.abort();
      // P7b: persist a snapshot of the terminal run so `/workflows` can show
      // it after a CLI restart. Runs on every terminal path (success / fail /
      // cancel) because the registry entry has already transitioned by here.
      // Best-effort: the writer swallows its own errors. Skipped when there's
      // no registry entry (test-injected configs) or the entry is somehow
      // still running (defensive).
      if (registryEntry && registryEntry.status !== 'running') {
        await writeWorkflowSnapshot(this.config, registryEntry);
        // P-telemetry: emit the terminal run event (no-op when telemetry is
        // off). Best-effort: never let a logging failure mask the result.
        try {
          logWorkflowRun(
            this.config,
            new WorkflowRunEvent({
              status: registryEntry.status,
              agents_dispatched: registryEntry.agentsDispatched,
              agents_completed: registryEntry.agentsCompleted,
              phase_count: registryEntry.phases.length,
              tokens_spent: registryEntry.tokensSpent,
              duration_ms:
                (registryEntry.endTime ?? registryEntry.startTime) -
                registryEntry.startTime,
            }),
          );
        } catch {
          // swallow — telemetry must not affect tool output
        }
      }
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
  registry:
    | { shouldShowUsageWarning(): boolean }
    | undefined,
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
