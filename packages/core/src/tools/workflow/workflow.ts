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
  type ToolCallConfirmationDetails,
  type ToolConfirmationOutcome,
  type ToolConfirmationPayload,
  type ToolInfoConfirmationDetails,
  type ToolInvocation,
  type ToolResult,
  type ToolResultDisplay,
  type ToolLocation,
} from '../tools.js';
import { stripAnsiAndControl } from '../../utils/textUtils.js';
import { isWithinRoot } from '../../utils/fileUtils.js';
import {
  extractAndStripMeta,
  type WorkflowMeta,
} from '../../agents/runtime/workflow-sandbox.js';
import {
  getRuleDisplayName,
  resolveToolName,
} from '../../permissions/rule-parser.js';
import type { ShellExecutionConfig } from '../../services/shellExecutionService.js';
import { ToolNames, ToolDisplayNames } from '../tool-names.js';
// FIX-10 (REUSE-I1): import ToolErrorType to use the standard machine-readable
// error code rather than an ad-hoc bare `{ message }` object.
import { ToolErrorType } from '../tool-error.js';
import type { Config } from '../../config/config.js';
import type { WorkflowAgentDispatch } from '../../agents/runtime/workflow-orchestrator.js';
import {
  DEFAULT_MAX_AGENTS_PER_RUN,
  DEFAULT_WORKFLOW_SUBAGENT_MAX_TIME_MINUTES,
  DEFAULT_WORKFLOW_SUBAGENT_MAX_TURNS,
  MAX_WORKFLOW_AGENTS_ENV,
  MAX_WORKFLOW_CONCURRENCY_ENV,
  WORKFLOW_SUBAGENT_MAX_MINUTES_ENV,
  WORKFLOW_SUBAGENT_MAX_TURNS_ENV,
} from '../../agents/runtime/workflow-orchestrator.js';
import {
  MAX_TOKENS_PER_WORKFLOW_ENV,
  resolveMaxTokensPerWorkflow,
} from '../../agents/runtime/workflow-budget.js';
import {
  WorkflowRunner,
  WorkflowScriptNotLaunchedError,
  WorkflowStartCancelledError,
  type WorkflowRunHandle,
} from '../../agents/runtime/workflow-runner.js';
import { isSymlinkedRoot } from '../../agents/runtime/workflow-saved.js';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type {
  WorkflowDispatchTraceStatus,
  WorkflowTask,
} from '../../agents/workflow-run-registry.js';
import { buildFailureLines } from '../../agents/workflow-failure-lines.js';
import {
  readWorkflowAuthoringReference,
  resolveWorkflowAuthoringSurface,
  toolSearchRevealSentence,
  WORKFLOW_AUTHORING_SKILL_NAME,
  type WorkflowAuthoringReference,
  type WorkflowAuthoringSurface,
} from '../../skills/workflow-authoring-skill.js';
import {
  buildResumeCall,
  hasUninlinableResumeArgs,
  RESUME_ARGS_TOO_LARGE_NOTE,
} from '../../agents/workflow-resume-call.js';

export interface WorkflowParams {
  /**
   * Inline JavaScript source for the workflow. Provide exactly one of
   * `script` or `scriptPath`.
   */
  script?: string;
  /**
   * P7b: absolute path to a workflow `.js` file to load and run instead of
   * inline `script` — a saved workflow, set by the `/<name>` slash command
   * (`SavedWorkflowLoader`), or a one-run script a tool generated under the
   * generated-scripts root. Read at execution time so edits to the file take
   * effect on the next run; the resolved path is recorded on the registry
   * entry as run provenance.
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
  /** Return after registration and continue the run under session ownership. */
  run_in_background?: boolean;
}

export interface WorkflowToolOptions {
  /**
   * Test-only dispatch injection. Production callers should leave this
   * undefined so createProductionDispatch wires real AgentHeadless.
   */
  dispatch?: WorkflowAgentDispatch;
}

export interface WorkflowToolResult extends ToolResult {
  /** Exact run started by a successfully admitted background invocation. */
  workflowRunId?: string;
  /**
   * Where the script that ran lives on disk — the file a `{scriptPath}` call
   * loaded, or the persisted copy of an inline `{script}`. Absent when an
   * inline script could not be persisted.
   */
  scriptPath?: string;
  /** This run's resume journal, when the config has a `storage` to hold one. */
  journalPath?: string;
}

const WORKFLOW_PARAM_SCHEMA = {
  type: 'object',
  properties: {
    script: {
      type: 'string',
      description:
        'JavaScript source of the workflow, wrapped as an async IIFE: ' +
        'top-level `await` and `return` are both legal, and a trailing ' +
        'expression is NOT a return value. Uses the injected globals ' +
        '`phase()`, `log()`, `agent()`, `parallel()`, `pipeline()`, ' +
        '`workflow()`, `args` and `budget`, and cannot import anything. ' +
        'May start with a literal `export const meta = {...}` ' +
        '(stripped before execution). ' +
        '`Math.random()` and all of `Date` (`new Date()`, `Date.now()` ' +
        'included) throw — a script must be deterministic for resume, so ' +
        'pass timestamps in via `args` or stamp the result after the run ' +
        'returns. Pass THUNKS to parallel(), not eager calls: ' +
        '`parallel([() => agent(...)])`, not `parallel([agent(...)])`.',
    },
    scriptPath: {
      type: 'string',
      description:
        'Optional. Absolute path to a workflow `.js` file to load and run ' +
        'instead of inline `script`. Primarily set by the `/<name>` ' +
        'saved-workflow slash command; a tool that generated a script for ' +
        'this run hands you its path the same way. The file must resolve ' +
        'inside a saved-workflow directory (`.qwen/workflows`, ' +
        '`~/.qwen/workflows`) or the generated-scripts root ' +
        '(`$QWEN_CODE_PROJECT_DIR/workflows/generated` — the per-project ' +
        'runtime dir, not the project tree) — any other path is refused. ' +
        'Provide exactly ONE of `script` or `scriptPath`. The file is read ' +
        'at execution time, so edits to a saved workflow take effect on the ' +
        'next run. An inline `script` is persisted to ' +
        '`<generated root>/inline/<runId>.js` and that path comes back in the ' +
        'result, so a resume passes the path instead of the source.',
    },
    args: {
      description:
        'Optional structured value bound to the `args` global. Pass actual JSON, not a stringified value.',
    },
    resumeFromRunId: {
      type: 'string',
      description:
        'Optional. Resume a prior workflow run by id (e.g. wf_abc123…). ' +
        'Re-runs the supplied script or returned script path; agent() calls ' +
        'whose rolling prefix-hash ' +
        '(prompt + opts, chained in call order) matches a journaled result ' +
        'are served from cache for the longest unchanged prefix, and the ' +
        'first changed/missing call onward runs live. Pass the `scriptPath` ' +
        'the original run returned and the same `args`. Editing a saved ' +
        'workflow changes future runs too, so copy it for run-specific edits. ' +
        'Replay requires a journal; without one, every agent() call runs live. ' +
        'The journal keys hash each agent() ' +
        "call's prompt and opts, not the script text, so post-processing can " +
        'change without losing the cache.',
    },
    run_in_background: {
      type: 'boolean',
      default: false,
      description:
        'Optional. When true, start the workflow under the interactive session and return a run handle immediately. The Background Tasks view can observe, cooperatively pause/resume, or stop it, and completion is delivered to the conversation when the run settles. Interactive TUI only. Defaults to false.',
    },
  },
  // `script` is required UNLESS `scriptPath` is supplied; this XOR can't be
  // expressed as a plain `required` list, so it's enforced in
  // `validateToolParamValues`. Inline authoring (the LLM path) should always
  // pass `script`; the `scriptPath` property description states the XOR.
} as const;

class WorkflowToolInvocation extends BaseToolInvocation<
  WorkflowParams,
  WorkflowToolResult
> {
  private callId?: string;

  /**
   * The failure hint, when the failing script is one this call authored.
   *
   * A saved workflow is the user's file, and the resume advice already tells
   * the model to copy it before making a run-specific change — "fix the script,
   * and retry" would contradict that in the same message.
   */
  private authoredScriptHint(): string | null {
    if (!this.authoringHint) return null;
    return isScriptAuthoredByThisCall(
      this.config,
      this.workflowName,
      this.params.scriptPath,
    )
      ? this.authoringHint
      : null;
  }

  constructor(
    private readonly config: Config,
    private readonly toolOptions: WorkflowToolOptions,
    params: WorkflowParams,
    /** This session's failure hint, from the tool's recorded description shape. */
    private readonly authoringHint: string | null,
    private readonly workflowName?: string,
  ) {
    super(params);
  }

  setCallId(callId: string): void {
    this.callId = callId;
  }

  /**
   * Cache so the transcript header and the approval dialog cannot disagree,
   * and so an oversized script is scanned once per invocation rather than
   * once per surface that asks.
   */
  private metaCache?: WorkflowMeta | null;

  private resolveMeta(): WorkflowMeta | null {
    if (this.metaCache === undefined) {
      this.metaCache = this.params.script
        ? readMetaForConfirmation(this.params.script)
        : null;
    }
    return this.metaCache;
  }

  getDescription(): string {
    const meta = this.resolveMeta();
    if (meta) {
      return `Run workflow: ${sanitizeLine(meta.name)}`;
    }
    if (this.params.scriptPath && this.params.script === undefined) {
      const kind = isGeneratedWorkflowScriptPath(
        this.config,
        this.params.scriptPath,
      )
        ? 'generated workflow script'
        : 'saved workflow';
      return `Run ${kind} (${path.basename(this.params.scriptPath)})`;
    }
    return `Run a workflow script (${this.params.script?.length ?? 0} chars)`;
  }

  override toolLocations(): ToolLocation[] {
    return [];
  }

  override getDefaultPermission(): Promise<'ask'> {
    return Promise.resolve('ask');
  }

  /**
   * Show what is about to run, and scope the grant that approves it.
   *
   * Without this override the base class renders `Confirm WorkflowTool` over
   * `Run a workflow script (4127 chars)` — a character count standing in for
   * arbitrary model-authored JavaScript that may fan out to
   * `DEFAULT_MAX_AGENTS_PER_RUN` subagents, provision git worktrees and spend
   * an uncapped token budget. The asymmetry is visible within one run: the
   * subagent approvals this workflow bubbles up each get a full dialog.
   *
   * Two properties of the grant matter as much as the disclosure:
   *
   *   - An inline `script` can never be pre-approved. It is fresh
   *     model-authored source every time, so a blanket "always allow" would
   *     transfer consent from the script the user read to every script the
   *     model writes afterwards. `hideAlwaysAllow` removes the option and the
   *     empty `permissionRules` stops `injectPermissionRulesIfMissing` from
   *     supplying the bare-tool-name rule, which `buildPermissionRules`
   *     documents as matching *all* invocations.
   *   - A `scriptPath` names a file on disk that the user chose, so it can be
   *     pre-approved — but scoped to that path. The rule is built with the
   *     same helpers the matcher uses so a tool rename moves both sides.
   */
  override async getConfirmationDetails(
    _abortSignal: AbortSignal,
  ): Promise<ToolCallConfirmationDetails> {
    const meta = this.resolveMeta();
    // The consent surface classifies canonically (the loader's own
    // normalization) so the label matches the content that actually loads.
    const isGeneratedScriptPath =
      this.params.scriptPath !== undefined &&
      (await isGeneratedWorkflowScriptPathCanonical(
        this.config,
        this.params.scriptPath,
      ));
    const isGeneratedInlineScriptPath =
      this.params.scriptPath !== undefined &&
      (await isWorkflowScriptPathWithinCanonicalRoot(
        this.params.scriptPath,
        path.dirname(this.config.storage.getInlineWorkflowScriptPath('wf_0')),
      ));
    const body = buildConfirmationPrompt(
      this.params,
      meta,
      isGeneratedScriptPath,
    );

    // The cost warning belongs before the spend, not after it. The registry
    // latch flips on read, so surfacing it here means the post-hoc copy on
    // the result path suppresses itself rather than repeating.
    const banner = resolveUsageBanner(
      this.config,
      this.config.getWorkflowRunRegistry?.(),
      resolveMaxTokensPerWorkflow(),
    );

    const isInlineScript =
      this.params.script !== undefined || isGeneratedInlineScriptPath;
    const details: ToolInfoConfirmationDetails = {
      type: 'info',
      title: 'Run a dynamic workflow?',
      prompt: banner ? `${banner}${body}` : body,
      // The body is a script excerpt and a phase list: rendering it as
      // Markdown would swallow the very characters the reader needs to see.
      renderPromptAsPlainText: true,
      hideAlwaysAllow: isInlineScript,
      permissionRules: isInlineScript
        ? []
        : [
            `${getRuleDisplayName(resolveToolName(ToolNames.WORKFLOW))}(scriptPath:${this.params.scriptPath})`,
          ],
      onConfirm: async (
        _outcome: ToolConfirmationOutcome,
        _payload?: ToolConfirmationPayload,
      ) => {
        // No-op: persistence is handled by coreToolScheduler via PM rules.
      },
    };
    return details;
  }

  override async execute(
    signal: AbortSignal,
    updateOutput?: (output: ToolResultDisplay) => void,
    _shellExecutionConfig?: ShellExecutionConfig,
  ): Promise<WorkflowToolResult> {
    const runInBackground = this.params.run_in_background === true;
    if (runInBackground && signal.aborted) {
      return startCancelledResult();
    }
    let handle: WorkflowRunHandle;
    try {
      handle = await WorkflowRunner.start({
        config: this.config,
        signal,
        toolUseId: this.callId,
        ...(this.workflowName ? { workflowName: this.workflowName } : {}),
        ...authoringHintOption(this.authoredScriptHint()),
        script: this.params.script,
        scriptPath: this.params.scriptPath,
        args: this.params.args,
        resumeFromRunId: this.params.resumeFromRunId,
        dispatch: this.toolOptions.dispatch,
        runInBackground,
        onUpdate:
          !runInBackground && updateOutput
            ? (entry) => safeEmitUpdate(updateOutput, entry)
            : undefined,
      });
    } catch (error) {
      // Two cancel sources reach a start before it registers: the caller's
      // own signal (background only — a foreground start registers and
      // settles `cancelled` instead), and a registry-side cancel
      // (`cancelStarting`, `abortAll`) that aborts the run's controller
      // while the caller's signal stays live, in either mode. The runner
      // reports the latter with a typed error; both are the same outcome
      // to the model.
      if (
        error instanceof WorkflowStartCancelledError ||
        (runInBackground && signal.aborted)
      ) {
        return startCancelledResult();
      }
      // A script that never compiled has no run behind it, so reporting it as
      // a failed workflow would be wrong twice: it invites the model to go
      // looking for a runId that was never minted, and it reads as "the
      // orchestration broke" when the actual problem is a typo the model can
      // fix and re-send.
      if (error instanceof WorkflowScriptNotLaunchedError) {
        // The earliest and most common first-attempt failure, and the one a
        // model is most likely to hit without having read the reference.
        // Mirrored into `error.message` for the same reason the run-failure
        // trailer is: the scheduler surfaces that string.
        const hint = this.authoredScriptHint();
        const text = hint ? `${error.message}\n${hint}` : error.message;
        return {
          llmContent: [{ text }],
          returnDisplay: error.message,
          error: {
            message: text,
            type: ToolErrorType.INVALID_TOOL_PARAMS,
          },
        };
      }
      throw error;
    }
    if (runInBackground) {
      const status = handle.registry?.get(handle.runId)?.status ?? 'running';
      const usageBanner = resolveUsageBanner(
        this.config,
        handle.registry,
        handle.budget.total,
      );
      return {
        workflowRunId: handle.runId,
        ...(handle.scriptPath ? { scriptPath: handle.scriptPath } : {}),
        ...(handle.journalPath ? { journalPath: handle.journalPath } : {}),
        llmContent: [
          {
            text: buildBackgroundStartText(handle, status),
          },
        ],
        returnDisplay:
          usageBanner +
          `Workflow ${handle.runId} started in the background (status: ${status}). Use Background Tasks to observe, cooperatively pause/resume, or stop it.`,
      };
    }
    const settlement = await handle.completion;
    if (settlement.ok) {
      const { outcome } = settlement;
      const usageBanner = resolveUsageBanner(
        this.config,
        handle.registry,
        handle.budget.total,
      );

      // FIX-7 (UP-C2): unwrap the script result so the run's own bookkeeping
      // (phases, logs, the display payload below) does not wrap the script's
      // return value. That full metadata stays in returnDisplay for the UI.
      // The one exception is the run trailer appended after this value: a
      // result the model cannot name, read back or resume is a result it
      // cannot follow up on, so a short run handle is worth its few lines.
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
        ...(handle.scriptPath ? { scriptPath: handle.scriptPath } : {}),
        ...(handle.journalPath ? { journalPath: handle.journalPath } : {}),
        // Two parts: the script's return value is left exactly as it was,
        // and the run handle follows as a separate part. Note what this does
        // NOT mean — `convertToFunctionResponse` joins the text parts with a
        // newline, so the model reads `<return value>\n--- workflow run ---…`
        // as one string. Keeping them apart is still what makes the return
        // value untouched at the tool boundary, keeps `returnDisplay` clean,
        // and gives the per-tool head/tail truncator a distinct trailer part.
        // The scheduler-wide persistence gate may still fold both parts into
        // one head-only preview when their combined text crosses its limit.
        llmContent: [
          { text: llmText },
          { text: buildRunTrailer(this.config, handle, this.params.args) },
        ],
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
      const cancelled =
        handle.registry?.get(handle.runId)?.status === 'cancelled';
      const failureText = cancelled
        ? 'Workflow cancelled.'
        : `Workflow failed: ${clampForDisplay(
            sanitizeBlock(message),
            TRAILER_ERROR_CHARS,
          )}`;
      const trailer = buildRunTrailer(
        this.config,
        handle,
        this.params.args,
        logs,
        !cancelled,
        cancelled ? null : this.authoredScriptHint(),
      );
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
      const display = `${cancelled ? 'Workflow cancelled.' : `Workflow failed: ${message}`}\n\n${safeStringifyDisplayPayload(
        {
          runId: handle.runId,
          ...(meta ? { meta } : {}),
          phases: phases ?? [],
          logs: logs ?? [],
        },
      )}`;
      return {
        ...(handle.scriptPath ? { scriptPath: handle.scriptPath } : {}),
        ...(handle.journalPath ? { journalPath: handle.journalPath } : {}),
        // The failure message alone names what threw but not where to look:
        // the logs the runtime already mirrored (`dispatch failed (result not
        // consumed)` and friends) only reached `returnDisplay`, which the
        // scheduler overwrites with `error.message` — so the model never saw
        // them. Mirror the two content parts into the error message because
        // that is the only text the non-timeout scheduler branch delivers.
        llmContent: [{ text: failureText }, { text: trailer }],
        returnDisplay: display,
        // FIX-10 (REUSE-I1): use the standard ToolErrorType.EXECUTION_FAILED
        // code so error routing / dashboards can classify workflow failures
        // the same way as other execution-time tool errors.
        error: {
          message: `${failureText}\n${trailer}`,
          type: ToolErrorType.EXECUTION_FAILED,
        },
        ...(cancelled ? { aborted: true } : {}),
      };
    }
  }
}

/** Log lines carried back to the model on the failure path. */
const TRAILER_LOG_LINES = 20;
/** Per-line bound that keeps the recovery handle below the scheduler gate. */
const TRAILER_LOG_LINE_CHARS = 400;
/** Bound for the thrown message before the recovery handle is appended. */
const TRAILER_ERROR_CHARS = 4000;

/**
 * The run handle, as plain text for the model: run id, the script on disk,
 * the journal, what the fan-out cost, and the exact call that resumes it.
 *
 * Emitted as a second `llmContent` part that follows the script's return
 * value rather than wrapping it: the first part keeps exactly the bytes it
 * had before, and everything downstream that reads a workflow result at the
 * tool boundary sees the same value it always did. Downstream of the
 * scheduler the two parts are joined with a newline into one function
 * response, so what the model reads is the return value with this block
 * appended — which is the point. Without it the model was handed a result it
 * could not follow up on: no run id to name to `/workflows`, no path to read
 * the per-agent results from, and no way to resume short of re-sending the
 * whole script.
 *
 * Every field is omitted when the run does not have it (a config without
 * `storage` has no journal; an inline script that could not be persisted has
 * no path), so the trailer never names a file that is not there.
 */
function buildRunTrailer(
  config: Config,
  handle: WorkflowRunHandle,
  args: unknown,
  logs?: string[],
  includeResume = true,
  authoringHint: string | null = null,
): string {
  const lines = [
    '--- workflow run ---',
    `runId: ${sanitizeLine(handle.runId)}`,
  ];
  if (handle.scriptPath) {
    lines.push(`script: ${sanitizeLine(handle.scriptPath)}`);
  }
  if (handle.journalPath) {
    lines.push(`journal: ${sanitizeLine(handle.journalPath)}`);
  }
  const entry = handle.registry?.get(handle.runId);
  let failedCount = 0;
  if (entry) {
    const countByStatus = (status: WorkflowDispatchTraceStatus): number =>
      entry.dispatches.reduce(
        (n, dispatch) => (dispatch.status === status ? n + 1 : n),
        0,
      );
    const respawned = entry.agentsRespawned ?? 0;
    failedCount = countByStatus('failed');
    lines.push(
      `agents: ${entry.dispatches.length} dispatched` +
        (respawned > 0 ? ` (${respawned} re-ran from a prior run)` : '') +
        ` · ${countByStatus('completed')} completed · ${countByStatus('cached')} cached · ${failedCount} failed · ${countByStatus('cancelled')} cancelled`,
    );
  }
  const spent = handle.budget.spent();
  lines.push(
    handle.budget.total === null
      ? `tokens: ${spent} spent (no cap)`
      : `tokens: ${spent} / ${handle.budget.total} spent`,
  );
  // Which agents came back empty and why. A script that reads `null` for a
  // failed agent may well return a perfectly well-formed result built from
  // the survivors, so a run can look successful while a third of its fan-out
  // is missing. The count on the agents line says how many; this says which.
  const failures = entry ? buildFailureLines(entry) : [];
  if (failures.length > 0 && entry) {
    lines.push(
      `failures (${failedCount}):`,
      ...failures.map((line) =>
        clampForDisplay(sanitizeLine(line), TRAILER_LOG_LINE_CHARS),
      ),
    );
  }
  // Built by the shared resume builder, the same one the background
  // completion notification uses: this string is copied verbatim into the
  // next tool call, and a second implementation would drift on `args` —
  // silently, because a resume without them still runs and simply misses
  // every journal key.
  const resume = buildResumeCall({
    runId: handle.runId,
    scriptPath: handle.scriptPath,
    args,
  });
  if (resume && includeResume) {
    const pathAdvice =
      entry?.workflowName ||
      !isGeneratedWorkflowScriptPath(config, handle.scriptPath!)
        ? 'this reads the saved workflow; copy it before making a run-specific change'
        : 'edit that generated copy first if the script needs to change';
    const journalAdvice = handle.journalPath
      ? 'the journal replays the longest unchanged prefix of agent() calls, and the first changed call onward runs live'
      : 'no journal was written for this run, so every agent() call runs live';
    lines.push(`resume: ${resume} — ${pathAdvice}; ${journalAdvice}.`);
    if (hasUninlinableResumeArgs({ runId: handle.runId, args })) {
      lines.push(RESUME_ARGS_TOO_LARGE_NOTE);
    }
  }
  // A script that threw has to be rewritten, and the model may have written
  // it without reading the reference — the description only points at it. The
  // caller decides whether this run is one the model authored, and the wording
  // comes from what this session's description actually holds. A name the
  // runner resolved — from a resumed run too, which a caller re-running a
  // saved workflow's inline source does not pass — wins: the resume advice
  // above then says to copy the saved workflow, not to fix the script.
  if (authoringHint && !entry?.workflowName) lines.push(authoringHint);
  const tail = (logs ?? []).slice(-TRAILER_LOG_LINES);
  if (tail.length > 0) {
    lines.push(
      `logs (last ${tail.length}):`,
      ...tail.map((line) =>
        clampForDisplay(sanitizeLine(line), TRAILER_LOG_LINE_CHARS),
      ),
    );
  }
  return lines.join('\n');
}

/**
 * Launch receipt for a backgrounded run. The run id alone was not enough to
 * act on: the completion arrives in a later turn, and until it does the model
 * has nothing to read. The script and journal paths are the two files that
 * exist from the moment the run starts.
 */
function buildBackgroundStartText(
  handle: WorkflowRunHandle,
  status: string,
): string {
  const lines = [
    'Workflow started in background.',
    `Run ID: ${sanitizeLine(handle.runId)}`,
    `Status: ${sanitizeLine(status)}`,
  ];
  if (handle.scriptPath) {
    lines.push(`Script file: ${sanitizeLine(handle.scriptPath)}`);
  }
  if (handle.journalPath) {
    lines.push(`Journal: ${sanitizeLine(handle.journalPath)}`);
  }
  lines.push(
    `You will be notified when it settles. Use /workflows ${sanitizeLine(handle.runId)} for the live phase tree.`,
  );
  return lines.join('\n');
}

function startCancelledResult(): WorkflowToolResult {
  return {
    llmContent: 'Workflow was cancelled before it could start.',
    returnDisplay: 'Workflow cancelled.',
    aborted: true,
  };
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

/** Characters of script source shown in the approval dialog. */
const CONFIRM_SCRIPT_EXCERPT_CHARS = 1200;
/** Characters of serialized `args` shown in the approval dialog. */
const CONFIRM_ARGS_CHARS = 300;
/** Phases listed individually before the remainder becomes a count. */
const CONFIRM_MAX_PHASES = 12;

/**
 * Sanitize a value that will be rendered on one line of the approval dialog.
 *
 * Everything shown in the dialog is model-authored, so it is attacker-shaped
 * text reaching a terminal: without this an embedded escape sequence could
 * repaint the dialog and misrepresent what the user is approving. Newlines are
 * control characters and go too, which is what we want for a single-line field
 * — a `meta.name` spanning three lines is itself a spoofing attempt.
 */
function sanitizeLine(text: string): string {
  return stripAnsiAndControl(text);
}

/**
 * Sanitize text whose line structure is meaningful (the script excerpt).
 *
 * `stripAnsiAndControl` removes C0 controls, and `\n` is one of them — running
 * it over a script would collapse it to a single unreadable line. Sanitize each
 * line separately so the structure survives while escape sequences do not.
 * Tabs become spaces first, since they would otherwise be stripped and silently
 * destroy indentation.
 */
function sanitizeBlock(text: string): string {
  return text
    .replace(/\t/g, '  ')
    .split('\n')
    .map((line) => stripAnsiAndControl(line))
    .join('\n');
}

/** Clamp already-sanitized text, naming what was dropped rather than eliding it. */
function clampForDisplay(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… (${text.length - max} more characters)`;
}

/**
 * Read `export const meta` for the approval dialog, degrading to `null` on any
 * problem.
 *
 * `extractAndStripMeta` parses rather than evaluates, so reading meta here
 * cannot run model-authored code — that property is what makes it safe to do
 * before the user has approved anything. It still *throws* on malformed meta,
 * and this is the approval path: a script with a broken meta literal must
 * remain approvable-or-rejectable, never take the dialog down with it. The
 * script is refused later, on its own terms, with a real error.
 */
function readMetaForConfirmation(script: string): WorkflowMeta | null {
  try {
    return extractAndStripMeta(script).meta;
  } catch {
    return null;
  }
}

/**
 * True when a `scriptPath` points inside the generated-scripts root. Such a
 * script is a throwaway artifact a tool emitted for this run, not a workflow
 * the user saved — the transcript surface labels it accordingly. Normalizes
 * `..` lexically only (no disk I/O, so it can back the synchronous
 * `getDescription()`); where a spelling diverges from its realpath (a
 * symlinked file, or a symlinked ancestor) it can disagree with the content
 * the loader reads — the confirmation dialog therefore classifies with
 * {@link isGeneratedWorkflowScriptPathCanonical} instead. This only picks a
 * label; the security check is the realpath boundary in the loader.
 */
function isGeneratedWorkflowScriptPath(
  config: Config,
  scriptPath: string,
): boolean {
  return isWithinRoot(scriptPath, config.storage.getGeneratedWorkflowsDir());
}

/**
 * Canonical provenance classification for the confirmation dialog: the same
 * normalization the loader applies, so the label matches the content that
 * actually loads. Both sides go through `fs.realpath` (resolving `..` AND
 * symlinks), with a lexical fallback where a side does not exist yet — and a
 * symlinked generated root counts as not-generated because the loader
 * refuses it outright.
 */
async function isGeneratedWorkflowScriptPathCanonical(
  config: Config,
  scriptPath: string,
): Promise<boolean> {
  return isWorkflowScriptPathWithinCanonicalRoot(
    scriptPath,
    config.storage.getGeneratedWorkflowsDir(),
  );
}

async function isWorkflowScriptPathWithinCanonicalRoot(
  scriptPath: string,
  root: string,
): Promise<boolean> {
  if (await isSymlinkedRoot(root)) return false;
  let realScriptPath: string;
  try {
    realScriptPath = await fs.realpath(scriptPath);
  } catch {
    return isWithinRoot(scriptPath, root);
  }
  let realRoot: string;
  try {
    realRoot = await fs.realpath(root);
  } catch {
    realRoot = path.resolve(root);
  }
  return isWithinRoot(realScriptPath, realRoot);
}

/**
 * The body of the approval dialog: what this workflow says it will do.
 *
 * Everything here comes from `meta`, the call's own parameters, and the
 * caller's provenance classification — never from executing the script.
 * When `meta` is absent or unreadable the dialog still renders, just with
 * less to say.
 */
function buildConfirmationPrompt(
  params: WorkflowParams,
  meta: WorkflowMeta | null,
  isGeneratedScriptPath: boolean,
): string {
  const lines: string[] = [];

  if (meta) {
    lines.push(`Workflow: ${sanitizeLine(meta.name)}`);
    lines.push(sanitizeLine(meta.description));
  } else if (params.scriptPath) {
    const label = isGeneratedScriptPath
      ? 'Generated workflow script'
      : 'Saved workflow';
    lines.push(`${label}: ${sanitizeLine(params.scriptPath)}`);
  } else {
    lines.push('Workflow: (the script declares no meta block)');
  }

  if (meta?.phases?.length) {
    const shown = meta.phases.slice(0, CONFIRM_MAX_PHASES);
    lines.push('', `Phases (${meta.phases.length}):`);
    shown.forEach((phase, i) => {
      const detail = phase.detail ? ` — ${sanitizeLine(phase.detail)}` : '';
      lines.push(`  ${i + 1}. ${sanitizeLine(phase.title)}${detail}`);
    });
    if (meta.phases.length > shown.length) {
      lines.push(`  … and ${meta.phases.length - shown.length} more`);
    }
  }

  if (params.scriptPath && meta) {
    lines.push('', `Loaded from: ${sanitizeLine(params.scriptPath)}`);
  }

  if (params.resumeFromRunId) {
    lines.push('', `Resuming run: ${sanitizeLine(params.resumeFromRunId)}`);
  }

  if (params.args !== undefined) {
    let rendered: string;
    try {
      rendered = JSON.stringify(params.args) ?? String(params.args);
    } catch {
      rendered = '(args are not JSON-serializable)';
    }
    lines.push(
      '',
      `Args: ${clampForDisplay(sanitizeLine(rendered), CONFIRM_ARGS_CHARS)}`,
    );
  }

  if (params.script) {
    lines.push(
      '',
      'Script:',
      clampForDisplay(
        sanitizeBlock(params.script),
        CONFIRM_SCRIPT_EXCERPT_CHARS,
      ),
    );
  }

  return lines.join('\n');
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
 * The half of the description that decides WHETHER to call this tool. Present
 * in every shape: it is the opt-in rule, and nothing else may displace it from
 * the front of the text.
 */
const WORKFLOW_TOOL_DECISION = `Execute a workflow script that orchestrates subagents deterministically.

**Only on an explicit request**

Do not call this tool unless the user has asked for multi-agent orchestration. A run can dispatch up to ${DEFAULT_MAX_AGENTS_PER_RUN} subagents and spend tokens accordingly, so that scale has to be requested rather than inferred. It counts as requested when any of these holds:

- The user's message contains the word \`workflow\`; a system reminder confirms it when it does.
- The user asked for orchestration in their own words — run a workflow, fan out agents, orchestrate this with subagents.
- A skill or slash command the user invoked instructs you to use this tool.
- The user named a saved workflow to run, reached through \`workflow('<name>')\` or \`scriptPath\`.
- The user asked to resume or continue an earlier run, which is \`resumeFromRunId\`.

Otherwise do not call it, however well the task would parallelize. Do the work in the main loop, or spawn a single subagent for one self-contained piece. When a workflow would genuinely be the better tool, say in one sentence what it would fan out over and roughly how many agents that is, then let the user decide — and mention that including the word \`workflow\` next time skips the ask.

**What a workflow is for**

Reach for one to be comprehensive (cover every part of the work in parallel), to be confident (independent perspectives and adversarial checks before an answer is committed to), or to take on scale a single context cannot hold. Parallelism on its own is not a reason; work that is already one short sequence of edits belongs in the main loop.`;

/**
 * The runtime facts a model needs to plan a run and to read back a result it
 * did not author. Carried by the pointer and withheld shapes; the inline shape
 * leaves it out because the reference states all of it in full, and two
 * copies of every number in one string is how they come to disagree.
 *
 * Every cap and env knob with an exported constant is interpolated from it.
 * Two are literals on both sides: the wall-clock cap
 * (`DEFAULT_MAX_WALL_CLOCK_MS` is private to `workflow-sandbox.ts`) and the
 * concurrency window formula, so edit those alongside the runtime.
 */
const WORKFLOW_TOOL_RUNTIME = `**Runtime**

\`phase(title)\`, \`log(msg)\`, \`agent(prompt, opts?)\`, \`parallel(thunks)\`, \`pipeline(items, ...stages)\`, \`workflow(nameOrRef, args?)\`, plus the \`args\` and \`budget\` globals. Saved workflows are \`<name>.js\` files under \`<projectRoot>/.qwen/workflows\` (project scope, also surfaced as \`/<name>\` slash commands) or \`~/.qwen/workflows\` (user scope); \`scriptPath\` additionally accepts a path inside the generated-scripts root (\`$QWEN_CODE_PROJECT_DIR/workflows/generated\` — the per-project runtime dir, not the project tree), and a path outside those roots is refused. Default \`max(2, min(16, availableParallelism()-2))\` agents in flight per run, which follows CPU affinity and container CPU limits (\`${MAX_WORKFLOW_CONCURRENCY_ENV}\`), up to ${DEFAULT_MAX_AGENTS_PER_RUN} agents total (\`${MAX_WORKFLOW_AGENTS_ENV}\`), under a 30-minute wall-clock cap per run (\`QWEN_CODE_MAX_WORKFLOW_SECONDS\`) — a fan-out near the agent cap will not fit inside the default cap. Each subagent attempt is separately capped at ${DEFAULT_WORKFLOW_SUBAGENT_MAX_TURNS} turns (\`${WORKFLOW_SUBAGENT_MAX_TURNS_ENV}\`) and ${DEFAULT_WORKFLOW_SUBAGENT_MAX_TIME_MINUTES} minutes (\`${WORKFLOW_SUBAGENT_MAX_MINUTES_ENV}\`). \`agent()\` resolves to \`null\` when that admitted agent fails on its own — turn/time caps, model or setup errors, missing structured output, exhausted stall retries — for a bare \`await agent()\` exactly as inside \`parallel()\`/\`pipeline()\`, so check for \`null\` wherever you read a result; run-level rejections no later call could survive (the token budget, the ${DEFAULT_MAX_AGENTS_PER_RUN}-agent cap, cancellation) throw instead. Every run hands back its runId, the script's path on disk (an inline script is persisted, so a resume edits that file rather than re-sending the source) and its journal path; read it before diagnosing an empty or surprising result. Runs appear in the background-tasks view and the \`/workflows\` dialog (live phase tree, token usage, cooperative pause/resume, cancel); \`run_in_background: true\` returns a run handle immediately in the interactive TUI and delivers completion through the conversation. Scripts run in a node:vm sandbox with no filesystem or shell access — all I/O happens through the spawned agents.`;

/**
 * Replaces the authoring reference when the model can load it on its own.
 * Names what is in there, so the model can tell whether this request needs it.
 */
const WORKFLOW_AUTHORING_POINTER = `**Writing the script**

Before writing a script, load the \`${WORKFLOW_AUTHORING_SKILL_NAME}\` skill — the authoring reference: the sandbox contract, agent() options, \`pipeline()\` vs \`parallel()\`, verification and convergence patterns, resume, and a worked example.`;

/** Appended to the pointer when a `tools.eager` allowlist defers the Skill tool. */
const WORKFLOW_AUTHORING_TOOL_SEARCH_NOTE = ` ${toolSearchRevealSentence(ToolDisplayNames.SKILL)}`;

/**
 * Leads the inlined reference. The reference is written for sessions that can
 * load skills, so it names another one (`workflow-creator`); say up front that
 * such pointers do not apply here.
 */
const WORKFLOW_AUTHORING_INLINE_NOTE =
  'Skills cannot be loaded in this session, even one named in a skill listing, so the authoring reference follows in full. Where it points at another skill, that skill is not available here either.';

/**
 * The tool description for a given shape.
 *
 * - `pointer` / `pointer-via-tool-search`: decision + runtime + a line naming
 *   the skill. This is the point of moving the reference out: roughly four
 *   times this text, needed only on the turn that writes a script.
 * - `inline`: decision + the reference in full. No route to any skill, so a
 *   pointer would leave the model writing scripts against nothing.
 * - `withheld`: decision + runtime. The user turned the reference off; putting
 *   it back into every request would raise exactly the cost they removed.
 *
 * An `inline` request without a readable reference falls back to the pointer:
 * it is the only remaining text that names the reference at all.
 */
export function buildWorkflowToolDescription(
  surface: WorkflowAuthoringSurface,
  reference: WorkflowAuthoringReference | null = readWorkflowAuthoringReference(),
): string {
  const pointer = `${WORKFLOW_TOOL_DECISION}\n\n${WORKFLOW_TOOL_RUNTIME}\n\n${WORKFLOW_AUTHORING_POINTER}`;
  switch (surface) {
    case 'pointer':
      return pointer;
    case 'pointer-via-tool-search':
      return `${pointer}${WORKFLOW_AUTHORING_TOOL_SEARCH_NOTE}`;
    case 'withheld':
      return `${WORKFLOW_TOOL_DECISION}\n\n${WORKFLOW_TOOL_RUNTIME}`;
    case 'inline':
      return reference
        ? `${WORKFLOW_TOOL_DECISION}\n\n${WORKFLOW_AUTHORING_INLINE_NOTE}\n\n---\n\n${reference.body.trim()}`
        : pointer;
    default: {
      // Unreachable while every surface has a case above. Typed `never` so a
      // new surface is a compile error here rather than a silent pointer.
      const unhandled: never = surface;
      return unhandled;
    }
  }
}

/**
 * The parameter schema for a given shape. Only `script` varies: its closing
 * sentence has to name wherever the rest of the authoring contract actually is
 * in this session, or the parameter the model is about to fill contradicts the
 * description beside it.
 */
function buildWorkflowParamSchema(surface: WorkflowAuthoringSurface) {
  const base = WORKFLOW_PARAM_SCHEMA.properties.script.description;
  const where =
    surface === 'pointer' || surface === 'pointer-via-tool-search'
      ? ` agent() options and orchestration patterns are in the \`${WORKFLOW_AUTHORING_SKILL_NAME}\` skill.`
      : surface === 'inline'
        ? " agent() options and orchestration patterns are in the authoring reference in this tool's description."
        : '';
  return {
    ...WORKFLOW_PARAM_SCHEMA,
    properties: {
      ...WORKFLOW_PARAM_SCHEMA.properties,
      script: { type: 'string', description: `${base}${where}` },
    },
  };
}

/**
 * The failure hint for a given shape, or `null` when there is nowhere to send
 * the model: a user who withheld the reference asked for it not to come back.
 */
function buildWorkflowAuthoringHint(
  surface: WorkflowAuthoringSurface,
): string | null {
  const loadSkill = `hint: Load the \`${WORKFLOW_AUTHORING_SKILL_NAME}\` skill for the script reference if you have not, fix the script, and retry.`;
  switch (surface) {
    case 'pointer':
      return loadSkill;
    case 'pointer-via-tool-search':
      // The retry moment is exactly when the model reaches for the Skill tool,
      // so the detour the description names has to be repeated here.
      return `${loadSkill} ${toolSearchRevealSentence(ToolDisplayNames.SKILL)}`;
    case 'inline':
      return "hint: See the authoring reference in this tool's description, fix the script, and retry.";
    case 'withheld':
      return null;
    default: {
      const unhandled: never = surface;
      return unhandled;
    }
  }
}

/**
 * Whether the script this call runs is one the model wrote: an inline script,
 * or a generated one-run copy. A saved workflow — named, or reached by a path
 * outside the generated root — belongs to the user. A path that cannot be
 * classified counts as not authored, the conservative reading for advice that
 * says to edit it.
 */
function isScriptAuthoredByThisCall(
  config: Config,
  workflowName: string | undefined,
  scriptPath: string | undefined,
): boolean {
  if (workflowName) return false;
  if (!scriptPath) return true;
  try {
    return isGeneratedWorkflowScriptPath(config, scriptPath);
  } catch {
    return false;
  }
}

/** Runner option carrying the hint, omitted when there is none. */
function authoringHintOption(hint: string | null): { authoringHint?: string } {
  return hint ? { authoringHint: hint } : {};
}

export class WorkflowTool extends BaseDeclarativeTool<
  WorkflowParams,
  WorkflowToolResult
> {
  /**
   * What this tool's description says about the authoring reference, decided
   * once here. The failure hint and the keyword reminder read it instead of
   * asking again, so a mid-session `/skills` toggle cannot make them disagree
   * with the description the model is holding.
   */
  readonly authoringSurface: WorkflowAuthoringSurface;

  constructor(
    private readonly config: Config,
    private readonly toolOptions: WorkflowToolOptions = {},
  ) {
    const surface = resolveWorkflowAuthoringSurface(config);
    super(
      ToolNames.WORKFLOW,
      ToolDisplayNames.WORKFLOW,
      buildWorkflowToolDescription(surface),
      Kind.Other,
      buildWorkflowParamSchema(surface),
      /* isOutputMarkdown */ true,
      /* canUpdateOutput */ true,
    );
    this.authoringSurface = surface;
  }

  buildSessionOwnedBackground(
    params: Omit<WorkflowParams, 'run_in_background'>,
    workflowName?: string,
  ): ToolInvocation<WorkflowParams, WorkflowToolResult> {
    const validationError = this.validateToolParams(params);
    if (validationError) {
      throw new Error(validationError);
    }
    if (!this.config.getWorkflowRunRegistry().hasCompletionCallback()) {
      throw new Error(
        'WorkflowTool: session-owned background runs require an active workflow completion channel.',
      );
    }
    return new WorkflowToolInvocation(
      this.config,
      this.toolOptions,
      { ...params, run_in_background: true },
      buildWorkflowAuthoringHint(this.authoringSurface),
      workflowName,
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
    // slash command or a generated script), never both, never neither.
    if (!hasScript && !hasPath) {
      return 'WorkflowTool: provide `script` (inline source) or `scriptPath` (a workflow script file).';
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
    if (params.run_in_background === true) {
      if (
        !this.config.isInteractive() ||
        this.config.getExperimentalZedIntegration?.() === true
      ) {
        return 'WorkflowTool: `run_in_background` is available only in the interactive TUI.';
      }
      if (!this.config.getWorkflowRunRegistry().hasCompletionCallback()) {
        return 'WorkflowTool: `run_in_background` requires an active workflow completion channel.';
      }
    }
    return null;
  }

  protected createInvocation(
    params: WorkflowParams,
  ): ToolInvocation<WorkflowParams, WorkflowToolResult> {
    return new WorkflowToolInvocation(
      this.config,
      this.toolOptions,
      params,
      buildWorkflowAuthoringHint(this.authoringSurface),
    );
  }
}
