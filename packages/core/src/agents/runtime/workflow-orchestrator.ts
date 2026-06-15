/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomBytes } from 'node:crypto';
import * as os from 'node:os';
import type { Config } from '../../config/config.js';
import { createWorkflowSandbox, debugLogger } from './workflow-sandbox.js';
import type {
  WorkflowAgentOpts,
  WorkflowAgentResult,
} from './workflow-sandbox.js';
import {
  WORKFLOW_SUBAGENT_SYSTEM_PROMPT,
  WORKFLOW_SUBAGENT_SYSTEM_PROMPT_WITH_SCHEMA,
} from './workflow-prompts.js';
import { AgentTerminateMode } from './agent-types.js';
import type { ContextState } from './agent-headless.js';
import { AgentEventEmitter, AgentEventType } from './agent-events.js';
import type {
  AgentToolCallEvent,
  AgentToolResultEvent,
} from './agent-events.js';
import { ToolNames } from '../../tools/tool-names.js';
import { createConcurrencyLimiter } from '../../utils/concurrencyLimiter.js';
import type { SubagentConfig } from '../../subagents/types.js';
import {
  GitWorktreeService,
  generateAgentWorktreeSlug,
  writeWorktreeSessionMarker,
} from '../../services/gitWorktreeService.js';
import { FileDiscoveryService } from '../../services/fileDiscoveryService.js';
import { WorkspaceContext } from '../../utils/workspaceContext.js';
import { SyntheticOutputTool } from '../../tools/syntheticOutput.js';
import { rebuildToolRegistryOnOverride } from '../../tools/agent/agent.js';

/**
 * Default ceiling on total `agent()` calls per workflow run (matches upstream
 * `hOK = 1000`). Counts EVERY dispatch — sequential, `parallel()`, and
 * `pipeline()` all funnel through the one wrapped dispatch — so a fan-out
 * cannot bypass it. The 1001st call throws. Override via env (see below).
 */
export const DEFAULT_MAX_AGENTS_PER_RUN = 1000;
export const MAX_WORKFLOW_AGENTS_ENV = 'QWEN_CODE_MAX_WORKFLOW_AGENTS';
/**
 * Absolute upper bound on the env-override agent cap. Even an operator who
 * sets `QWEN_CODE_MAX_WORKFLOW_AGENTS=999999999` cannot exceed this — the
 * intent is to catch fat-finger / misconfig that would silently uncap a
 * runaway workflow (1000-agent default × per-agent token cost). 10000 is
 * 10× the default, generous for legitimate large fan-outs.
 */
export const HARD_MAX_AGENTS_PER_RUN_CEILING = 10_000;

/**
 * Resolve the per-run agent cap, honoring `QWEN_CODE_MAX_WORKFLOW_AGENTS`.
 * Mirrors `resolveMaxConcurrentBackgroundAgents` (background-tasks.ts): a
 * non-integer / <1 override is rejected with a debug warning and the default
 * is used. An override above `HARD_MAX_AGENTS_PER_RUN_CEILING` is clamped
 * (with a debug warning) — the env knob is operator-facing, not security-
 * critical, but a misconfigured ceiling shouldn't silently uncap the run.
 */
export function resolveMaxAgentsPerRun(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env[MAX_WORKFLOW_AGENTS_ENV];
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_MAX_AGENTS_PER_RUN;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    debugLogger.warn(
      `Invalid ${MAX_WORKFLOW_AGENTS_ENV}=${JSON.stringify(raw)}, ` +
        `using default (${DEFAULT_MAX_AGENTS_PER_RUN})`,
    );
    return DEFAULT_MAX_AGENTS_PER_RUN;
  }
  if (parsed > HARD_MAX_AGENTS_PER_RUN_CEILING) {
    debugLogger.warn(
      `${MAX_WORKFLOW_AGENTS_ENV}=${parsed} exceeds hard ceiling ` +
        `(${HARD_MAX_AGENTS_PER_RUN_CEILING}); clamping.`,
    );
    return HARD_MAX_AGENTS_PER_RUN_CEILING;
  }
  return parsed;
}

export const MAX_WORKFLOW_CONCURRENCY_ENV =
  'QWEN_CODE_MAX_WORKFLOW_CONCURRENCY';
/**
 * Absolute upper bound on the env-override concurrency window. Above this,
 * a single Node process running N concurrent LLM calls is past the point a
 * distributed worker is the better tool. 64 ≈ 4× the 16-default ceiling.
 */
export const HARD_MAX_CONCURRENCY_CEILING = 64;

/**
 * Maximum agents in flight at once within a single run, shared across all
 * `parallel()` / `pipeline()` calls. `min(16, cpus-2)` mirrors upstream;
 * `max(1, …)` guards 1–2 core machines where `cpus-2 <= 0` would otherwise
 * produce a deadlocking limit. `QWEN_CODE_MAX_WORKFLOW_CONCURRENCY` overrides
 * the computed value with an explicit integer in `[1, HARD_MAX_CONCURRENCY_CEILING]`;
 * an invalid override falls back to the cpu-derived default with a debug
 * warning, and an over-ceiling override is clamped.
 */
export function resolveConcurrencyLimit(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env[MAX_WORKFLOW_CONCURRENCY_ENV];
  if (raw !== undefined && raw.trim() !== '') {
    const parsed = Number(raw);
    if (Number.isInteger(parsed) && parsed >= 1) {
      if (parsed > HARD_MAX_CONCURRENCY_CEILING) {
        debugLogger.warn(
          `${MAX_WORKFLOW_CONCURRENCY_ENV}=${parsed} exceeds hard ceiling ` +
            `(${HARD_MAX_CONCURRENCY_CEILING}); clamping.`,
        );
        return HARD_MAX_CONCURRENCY_CEILING;
      }
      return parsed;
    }
    debugLogger.warn(
      `Invalid ${MAX_WORKFLOW_CONCURRENCY_ENV}=${JSON.stringify(raw)}, ` +
        `using cpu-derived default`,
    );
  }
  return Math.max(1, Math.min(16, os.cpus().length - 2));
}

/**
 * Bound the resource ceiling for workflow subagents so a single `agent()`
 * call cannot loop the model indefinitely. Values mirror conservative
 * upstream defaults; P5 will refine via `budget` once it exists.
 */
const WORKFLOW_SUBAGENT_MAX_TURNS = 50;
const WORKFLOW_SUBAGENT_MAX_TIME_MINUTES = 10;

/**
 * disallowedTools mirror the upstream `Tg8` workflow-subagent config — both
 * tools would let a subagent break the "final text IS the return value"
 * contract. SendMessage would deliver the answer to the user instead of
 * the calling script; ExitPlanMode would interrupt the workflow's plan-mode
 * intent. Defense-in-depth alongside the §XmO system prompt that already
 * documents both restrictions.
 */
const WORKFLOW_SUBAGENT_DISALLOWED_TOOLS: string[] = [
  ToolNames.SEND_MESSAGE,
  ToolNames.EXIT_PLAN_MODE,
];

/**
 * `WorkflowExecutionError` preserves the phases and logs the script
 * accumulated before failing — without it, all diagnostic context is lost
 * when the orchestrator's catch block surfaces only `err.message`.
 *
 * `cause` carries the underlying error message but no host-realm Error
 * object: we only ever store strings to avoid re-introducing the T1
 * thrown-Error realm-escape vector.
 */
export class WorkflowExecutionError extends Error {
  override readonly name = 'WorkflowExecutionError';
  constructor(
    message: string,
    readonly phases: string[],
    readonly logs: string[],
  ) {
    super(message);
  }
}

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
  /**
   * T40 (PR #4732 R4): caller-owned AbortController linked to the wall-clock
   * timeout. When the sandbox times out, this controller is aborted BEFORE
   * the rejection propagates — letting in-flight subagent dispatches see
   * the cancellation and stop burning tokens. The caller (`WorkflowTool`)
   * also threads this same controller's signal into `createProductionDispatch`
   * and aborts it in its own `finally` block to clean up on normal completion.
   * If omitted, the wall-clock still rejects but in-flight subagents continue
   * until their internal `max_time_minutes` limit.
   */
  abortOnTimeout?: AbortController;
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
 * Sanitize a user-controlled string for safe interpolation into an error
 * message. Control characters (CR / LF / NUL / etc.) are replaced with a
 * single space so a model-authored agentType cannot fragment a single-line
 * error across log records / OTLP fields / display payloads. P3 R2
 * self-review surfaced this; the corresponding throw site is in
 * `runOverridePath` for `opts.agentType`.
 */
function sanitizeForErrorMessage(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ');
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
 *
 * P3 dispatch routing — two paths:
 *
 *  - **Fast path** (no `agentType` and no `model`): direct
 *    `AgentHeadless.create` with the default workflow subagent prompt and
 *    the hardcoded resource bounds + disallowed-tool floor. P1/P2 behaviour
 *    unchanged — zero added overhead, no SubagentManager touch.
 *
 *  - **Override path** (`agentType` and/or `model` set): route through
 *    `SubagentManager.createAgentHeadless` so per-call model overrides go
 *    through `buildRuntimeContentGeneratorView` (provider routing) and
 *    per-agent MCP servers / hooks get their own ToolRegistry + lifecycle.
 *    `dispose()` runs in a `finally` block so the rebuilt registry never
 *    leaks past a dispatch — even on a thrown subagent.execute().
 */
export function createProductionDispatch(
  config: Config,
  signal?: AbortSignal,
): WorkflowAgentDispatch {
  return async (prompt, opts) => {
    const { AgentHeadless, ContextState } = await import('./agent-headless.js');
    const ctx = new ContextState();
    ctx.set('task_prompt', prompt);

    if (
      opts.agentType === undefined &&
      opts.model === undefined &&
      opts.isolation === undefined &&
      opts.schema === undefined
    ) {
      const subagent = await AgentHeadless.create(
        opts.label ?? 'workflow-agent',
        config,
        {
          systemPrompt: WORKFLOW_SUBAGENT_SYSTEM_PROMPT,
          initialMessages: [],
        },
        {},
        // T11 (PR #4732 R1): bound resource ceiling so a single agent() call
        // cannot loop the model indefinitely. Without this, runConfig was {}
        // and the loop guards never tripped — combined with the cancellation
        // bug below, workflows were effectively unkillable.
        {
          max_turns: WORKFLOW_SUBAGENT_MAX_TURNS,
          max_time_minutes: WORKFLOW_SUBAGENT_MAX_TIME_MINUTES,
        },
        // T11 (PR #4732 R1): disallow SendMessage / ExitPlanMode to align with
        // upstream Tg8 — closes the back-channel that would let a subagent
        // deliver its answer via user message instead of the script's read.
        { tools: ['*'], disallowedTools: WORKFLOW_SUBAGENT_DISALLOWED_TOOLS },
      );
      await subagent.execute(ctx, signal);
      // T10 (PR #4732 R1): runReasoningLoop does NOT throw on abort / turn /
      // time limit — it returns with terminateMode = CANCELLED|MAX_TURNS|
      // TIMEOUT|ERROR and getFinalText() = '' or partial. Without this check,
      // `await agent(...)` would resolve to '' on user cancel and the script
      // would happily loop on empty results.
      const mode = subagent.getTerminateMode();
      if (mode !== AgentTerminateMode.GOAL) {
        throw new Error(
          `Workflow subagent did not complete (terminate mode: ${mode}).`,
        );
      }
      return subagent.getFinalText();
    }

    return runOverridePath(config, ctx, opts, signal);
  };
}

/**
 * Override path for `agent({ agentType, model, isolation })`. Resolves the
 * requested agentType against `SubagentManager`, applies the workflow
 * disallowed-tool floor, threads `opts.model` into `SubagentConfig.model`
 * so provider routing in `buildRuntimeContentGeneratorView` sees the
 * override, optionally provisions a fresh git worktree for
 * `isolation: 'worktree'` (refused for `'remote'` to match upstream's
 * "not available in this build" signal), and always disposes the
 * per-agent registry/hooks in `finally`.
 *
 * Why opts.model goes into `SubagentConfig.model` (not
 * `modelConfigOverrides`): `SubagentManager.buildRuntimeContentGeneratorView`
 * (subagent-manager.ts:945) consults `SubagentConfig.model` to decide
 * whether to build a dedicated ContentGenerator for a different provider
 * — `modelConfigOverrides` would only swap the model name within the
 * existing provider's runtime view.
 *
 * Why disallowed-floor is augmented on `SubagentConfig.disallowedTools`
 * (not via `toolConfigOverride`): augmenting before `convertToRuntimeConfig`
 * lets the manager's `transformToToolNames` normalize all entries together
 * (display name → tool name + MCP pattern preservation). A toolConfigOverride
 * would bypass that normalization and require us to duplicate it here.
 *
 * Why the worktree-rebound Config is passed as `runtimeContext` (not
 * `toolConfigOverride`): `SubagentManager.buildSubagentContextOverride`
 * (subagent-manager.ts:857) builds the subagent context via
 * `Object.create(runtimeContext)`. The own-property rebinds we set on the
 * worktree override propagate through the prototype chain, so all
 * `getTargetDir() / getCwd() / getFileService() / getWorkspaceContext()`
 * call sites inside the subagent see the worktree path. Subsequent
 * `rebuildToolRegistryOnOverride` re-resolves `this.config` through the
 * chain and anchors EditTool / WriteFileTool / ReadFileTool to the
 * worktree's FileReadCache, so the subagent cannot leak writes back into
 * the parent project tree.
 */
async function runOverridePath(
  config: Config,
  ctx: ContextState,
  opts: WorkflowAgentOpts,
  signal: AbortSignal | undefined,
): Promise<WorkflowAgentResult> {
  if (opts.isolation === 'remote') {
    // Error message verbatim from upstream Claude Code 2.1.168 strings.
    // Match for parity so scripts written against either runtime see the
    // same text and can branch on it.
    throw new Error(
      "agent({isolation:'remote'}) is not available in this build.",
    );
  }

  const subagentMgr = config.getSubagentManager();
  let baseConfig: SubagentConfig;

  if (opts.agentType !== undefined) {
    const resolved = await subagentMgr.findSubagentByName(opts.agentType);
    if (!resolved) {
      // Error message verbatim from upstream Claude Code 2.1.168 strings:
      // "agent({agentType}): agent type '{name}' not found". Match for
      // user-visible parity so scripts authored against either runtime see
      // the same error text.
      //
      // SECURITY (P3 R2 self-review): sanitize opts.agentType before
      // interpolation. The string is model-authored; an attacker model
      // could embed CRLF / control characters that fragment the error
      // message in logs / display / OTLP traces. Replace control chars
      // with a single space so the error stays single-line.
      const safeAgentType = sanitizeForErrorMessage(opts.agentType);
      throw new Error(
        `agent({agentType}): agent type '${safeAgentType}' not found.`,
      );
    }
    baseConfig = resolved;
  } else {
    // Model-only / isolation-only path: build an ephemeral session-level
    // default that uses the workflow subagent prompt. Going through
    // createAgentHeadless gives us provider routing via
    // buildRuntimeContentGeneratorView and per-agent ToolRegistry cleanup.
    baseConfig = {
      name: opts.label ?? 'workflow-agent',
      description: 'Default workflow subagent (per-call overrides).',
      systemPrompt: WORKFLOW_SUBAGENT_SYSTEM_PROMPT,
      level: 'session',
      isBuiltin: false,
    };
  }

  // R3 review (wenshao T1 [Critical] + H1): schema mode used to (a)
  // inherit the resolved agentType's `tools` allowlist verbatim — so
  // `structured_output` was present in the per-call ToolRegistry but
  // filtered OUT by prepareTools when the agentType allowlist didn't
  // include it, producing the silent "after 2 nudges" dead-end with no
  // hint that the tool was invisible; and (b) replace the resolved
  // agentType's systemPrompt outright with WORKFLOW_SUBAGENT_SYSTEM_PROMPT_WITH_SCHEMA,
  // silently dropping the agentType's persona (e.g. Explore's
  // read-only / be-fast instructions). Upstream's contract is to APPEND
  // the StructuredOutput instruction block to the resolved persona, so
  // `agent('review X', {agentType:'code-reviewer', schema:S})` keeps the
  // code-reviewer persona AND knows to call structured_output. Replace
  // only on the ephemeral-default no-agentType path, where the persona
  // IS WORKFLOW_SUBAGENT_SYSTEM_PROMPT and the schema variant is its
  // strict superset (avoids two near-identical prompt blocks).
  let schemaSystemPrompt: string | undefined;
  if (opts.schema !== undefined) {
    schemaSystemPrompt =
      opts.agentType !== undefined && baseConfig.systemPrompt
        ? `${baseConfig.systemPrompt}\n\n${WORKFLOW_SUBAGENT_SYSTEM_PROMPT_WITH_SCHEMA}`
        : WORKFLOW_SUBAGENT_SYSTEM_PROMPT_WITH_SCHEMA;
  }
  // Tools allowlist: when schema mode runs over an agentType with a
  // restricted allowlist (no '*'), ensure structured_output is part of
  // the allowed set so prepareTools doesn't filter it out. The case
  // where baseConfig.tools is undefined / empty is already covered by
  // convertToRuntimeConfig defaulting to ['*'], which lets every
  // registered tool through (including the per-call structured_output).
  let schemaTools: string[] | undefined;
  if (
    opts.schema !== undefined &&
    baseConfig.tools &&
    baseConfig.tools.length > 0 &&
    !baseConfig.tools.includes('*') &&
    !baseConfig.tools.includes(ToolNames.STRUCTURED_OUTPUT)
  ) {
    schemaTools = [...baseConfig.tools, ToolNames.STRUCTURED_OUTPUT];
  }

  const augmented: SubagentConfig = {
    ...baseConfig,
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    ...(schemaSystemPrompt !== undefined
      ? { systemPrompt: schemaSystemPrompt }
      : {}),
    ...(schemaTools !== undefined ? { tools: schemaTools } : {}),
    disallowedTools: Array.from(
      new Set([
        ...(baseConfig.disallowedTools ?? []),
        ...WORKFLOW_SUBAGENT_DISALLOWED_TOOLS,
      ]),
    ),
  };

  // Provision worktree BEFORE createAgentHeadless so the override Config
  // is in place when convertToRuntimeConfig and buildSubagentContextOverride
  // resolve cwd-related getters via the prototype chain.
  let worktreeIsolation: WorkflowWorktreeIsolation | null = null;
  let effectiveContext: Config = config;
  if (opts.isolation === 'worktree') {
    worktreeIsolation = await provisionWorkflowWorktree(config);
    effectiveContext = createWorktreeConfigOverride(
      config,
      worktreeIsolation.path,
    );
  }

  // R3 review (wenshao T2/T5 [M1]): named parent-abort listener so the
  // outer finally can remove it. Declared outside the try so it survives
  // into the cleanup block. The previous `{ once: true }` registration
  // only auto-removed when the parent actually aborted; the happy-path
  // schema dispatch — success capture / 3-failure abort fires the CHILD
  // controller, not the parent — left the listener attached. With N
  // schema-mode calls in one workflow the registration accumulated on the
  // per-run signal.
  let onParentAbort: (() => void) | undefined;

  // R3 review (wenshao T0 [Critical]): the outer try MUST start
  // immediately after worktree provision. The earlier layout opened it
  // only after createSchemaConfigOverride / createSchemaModeState /
  // addEventListener — so any throw in those three (e.g. a broken MCP
  // server during the schema override's tool-registry rebuild) orphaned
  // the just-provisioned worktree on disk under .qwen/worktrees/. Move
  // schema setup + signal chaining + emitter creation inside.
  try {
    // Schema mode: build a per-call Config override with a fresh ToolRegistry
    // containing a fresh SyntheticOutputTool whose params schema IS the
    // user-supplied schema. Each agent({schema}) call gets its own override
    // and its own registry, so concurrent calls under parallel()/pipeline()
    // do not share state.
    let schemaState: SchemaModeState | null = null;
    if (opts.schema !== undefined) {
      effectiveContext = await createSchemaConfigOverride(
        effectiveContext,
        opts.schema as Record<string, unknown>,
      );
      schemaState = createSchemaModeState();
    }

    // Schema mode chains a child AbortController so the dispatch can stop
    // the subagent after the 3rd validation failure (or as soon as a valid
    // `structured_output` call is captured). Outside the schema path, the
    // caller's signal is passed through unchanged.
    let dispatchSignal: AbortSignal | undefined = signal;
    if (schemaState) {
      const child = new AbortController();
      if (signal) {
        if (signal.aborted) {
          child.abort(signal.reason);
        } else {
          onParentAbort = () => child.abort(signal.reason);
          signal.addEventListener('abort', onParentAbort);
        }
      }
      schemaState.abortController = child;
      dispatchSignal = child.signal;
    }

    const eventEmitter = schemaState
      ? createSchemaEventEmitter(schemaState)
      : undefined;

    const { subagent, dispose } = await subagentMgr.createAgentHeadless(
      augmented,
      effectiveContext,
      {
        // Workflow always bounds resource ceiling regardless of agentType's
        // own runConfig / maxTurns — these are workflow-level safety bounds,
        // not subagent-level preferences. P5 will refine via budget.
        runConfigOverrides: {
          max_turns: WORKFLOW_SUBAGENT_MAX_TURNS,
          max_time_minutes: WORKFLOW_SUBAGENT_MAX_TIME_MINUTES,
        },
        eventEmitter,
      },
    );

    try {
      await subagent.execute(ctx, dispatchSignal);

      if (schemaState) {
        if (schemaState.result !== null) {
          // structured_output captured. Worktree cleanup runs here so the
          // happy path doesn't leak a worktree; the preserved info is
          // operator-visible via debugLogger only — appending a suffix to
          // a structured object would mean either rewrapping the schema
          // (changes the contract the script sees) or stringifying
          // (defeats the structured payload).
          if (worktreeIsolation) {
            const isolation = worktreeIsolation;
            worktreeIsolation = null;
            const preserved = await cleanupWorkflowWorktree(isolation);
            if (preserved) {
              debugLogger.info(
                `[Workflow] Schema-mode subagent preserved worktree at ` +
                  `${preserved.path ?? '(directory removed)'} on branch ` +
                  `${preserved.branch}. The structured payload is returned ` +
                  `verbatim; recover the work from the preserved path / branch.`,
              );
            }
          }
          return schemaState.result as object;
        }
        // No structured_output captured. Caller-side abort takes priority
        // over the schema terminal error so the workflow-level cancellation
        // path is honoured instead of looking like a content failure.
        if (signal?.aborted) {
          throw new DOMException('Workflow aborted.', 'AbortError');
        }
        // R3 review (wenshao M2): the schema path used to throw the
        // "after 2 in-conversation nudges" terminal for EVERY non-result
        // outcome — including TIMEOUT (10 min cap), MAX_TURNS (50 cap),
        // and ERROR (model client crash). Those aren't content failures
        // and aren't nudge exhaustion; they're the same terminate-mode
        // outcomes the non-schema branch below already distinguishes.
        // Match that shape here BEFORE attributing the failure to schema.
        const mode = subagent.getTerminateMode();
        if (
          mode !== AgentTerminateMode.GOAL &&
          mode !== AgentTerminateMode.CANCELLED
        ) {
          throw new Error(
            `Workflow subagent did not complete (terminate mode: ${mode}).`,
          );
        }
        // The dispatch aborts via schemaState.abortController on the
        // 3rd validation failure (attempts > 2) AND on success capture.
        // The success path returns above, so reaching here means either
        // (a) the model never called structured_output at all — answered
        // in plain text — or (b) the 3-failure abort fired. Distinguish
        // the messages so an operator sees what actually happened:
        // upstream's verbatim "after 2 in-conversation nudges" wording is
        // factually correct only for (b).
        if (schemaState.attempts > 2) {
          // Error message verbatim from upstream Claude Code 2.1.168 strings.
          throw new Error(
            'subagent completed without calling StructuredOutput (after 2 in-conversation nudges).',
          );
        }
        throw new Error(
          'subagent completed without calling structured_output ' +
            '(no validation attempt — model produced plain-text content).',
        );
      }

      // Non-schema mode.
      const mode = subagent.getTerminateMode();
      if (mode !== AgentTerminateMode.GOAL) {
        throw new Error(
          `Workflow subagent did not complete (terminate mode: ${mode}).`,
        );
      }
      let finalText: WorkflowAgentResult = subagent.getFinalText();
      // Cleanup worktree on the success path while we still have the
      // isolation handle. The preserved suffix (if any) is appended to
      // the final text so the script can see it. The outer finally below
      // only fires the fallback cleanup if THIS branch threw.
      if (worktreeIsolation) {
        const isolation = worktreeIsolation;
        worktreeIsolation = null;
        const preserved = await cleanupWorkflowWorktree(isolation);
        if (preserved && typeof finalText === 'string') {
          finalText = appendWorktreePreservedSuffix(finalText, preserved);
        }
      }
      return finalText;
    } finally {
      // dispose() unregisters per-agent hooks and stops the per-agent
      // ToolRegistry (including any per-agent MCP processes spawned by
      // mcpServers override). Must run in finally; a leaked registry means
      // stdio handles to spawned MCP processes leak past the dispatch.
      await dispose();
    }
  } finally {
    // R3 review (wenshao T2/T5 [M1]): always remove the parent-abort
    // listener if we registered one. Happens regardless of how the
    // dispatch ended — success capture, 3-failure abort, exception in
    // schema setup, exception in execute — so a workflow with many
    // schema-mode calls does not accumulate per-call listeners (and
    // per-call AbortController closures) on the long-lived per-run
    // parent signal.
    if (onParentAbort && signal) {
      signal.removeEventListener('abort', onParentAbort);
    }
    // Outer fallback cleanup: fires only when worktree was provisioned
    // but the success-path cleanup didn't run (createAgentHeadless threw,
    // or execute threw, or the terminateMode check threw, or — after the
    // R3 T0 fix — schema setup / signal chaining threw). Swallow errors
    // here — the original exception (already in flight) is more important
    // than a cleanup failure, but we still log so operators can find the
    // orphaned worktree.
    if (worktreeIsolation) {
      try {
        await cleanupWorkflowWorktree(worktreeIsolation);
      } catch (error) {
        debugLogger.warn(
          `Workflow worktree cleanup in fallback finally failed for ` +
            `${worktreeIsolation.path}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
}

/**
 * Result of a worktree-isolation cleanup: nothing when the worktree was
 * cleanly removed (no changes and no unmerged commits), or the path /
 * branch that was preserved on disk so the script (or user) can recover
 * the work. `path` is omitted when the worktree directory itself was
 * removed but the branch could not be safely deleted (the work is on the
 * branch, not at a filesystem path).
 */
interface WorktreePreservedInfo {
  path?: string;
  branch: string;
}

/**
 * In-flight handle for one `agent({isolation:'worktree'})` provision —
 * passed from `provisionWorkflowWorktree` to `cleanupWorkflowWorktree`
 * (plus the outer-finally fallback) so cleanup can address the right
 * worktree without re-discovering it from the filesystem.
 *
 *  - `slug` — the ephemeral `agent-<7hex>` name; used as the
 *    `removeUserWorktree` argument AND as the input to
 *    `hasUnmergedWorktreeCommits` (which resolves the slug to its
 *    branch name internally).
 *  - `path` — absolute worktree directory under
 *    `<projectRoot>/.qwen/worktrees/`; the subagent's rebound cwd.
 *  - `branch` — the branch created for this worktree
 *    (`worktree-<slug>`); appears verbatim in the user-facing preserved
 *    suffix.
 *  - `repoRoot` — the parent project root; the cleanup helper builds a
 *    fresh `GitWorktreeService` anchored here so the worktree-side
 *    git invocations target the right repo.
 */
interface WorkflowWorktreeIsolation {
  slug: string;
  path: string;
  branch: string;
  repoRoot: string;
}

/**
 * Provision an isolation worktree for one `agent({isolation:'worktree'})`
 * call. Mirrors the AgentTool provision path (agent.ts:1849-1963) with
 * the same fail-closed dirty-parent refuse: if the parent working tree
 * has uncommitted changes, `git worktree add` would silently check out
 * the parent's HEAD without those edits and the subagent would see a
 * stale tree. Forcing the user to commit / stash matches AgentTool's
 * UX so model authors can rely on consistent behavior across both call
 * sites.
 */
async function provisionWorkflowWorktree(
  config: Config,
): Promise<WorkflowWorktreeIsolation> {
  const cwd = config.getTargetDir();
  if (/\.qwen[\\/]worktrees[\\/]/.test(cwd)) {
    throw new Error(
      `agent({isolation:'worktree'}): parent is already inside a worktree ` +
        `(${cwd}). Nested isolation worktrees are not supported — the ` +
        `subagent's inherited paths would still reference the outer worktree.`,
    );
  }
  const probe = new GitWorktreeService(cwd);
  const gitCheck = await probe.checkGitAvailable();
  if (!gitCheck.available) {
    throw new Error(
      `agent({isolation:'worktree'}): ${gitCheck.error ?? 'git is not available'}.`,
    );
  }
  if (!(await probe.isGitRepository())) {
    throw new Error(
      `agent({isolation:'worktree'}): ${cwd} is not a git repository.`,
    );
  }
  const projectRoot = (await probe.getRepoTopLevel()) ?? cwd;
  const wtService =
    projectRoot === cwd ? probe : new GitWorktreeService(projectRoot);

  let parentDirty = false;
  try {
    parentDirty = await wtService.hasWorktreeChanges(projectRoot);
  } catch (error) {
    debugLogger.warn(
      `[Workflow] hasWorktreeChanges failed at ${projectRoot}: ${error}`,
    );
    parentDirty = true;
  }
  if (parentDirty) {
    throw new Error(
      `agent({isolation:'worktree'}): parent working tree at ${projectRoot} ` +
        `has uncommitted changes that would not propagate into the isolated ` +
        `worktree. The subagent would see the prior HEAD instead of the ` +
        `current state. Commit or stash the changes, then re-run.`,
    );
  }

  const slug = generateAgentWorktreeSlug();
  let parentBranch: string | undefined;
  try {
    parentBranch = await wtService.getCurrentBranch();
  } catch (error) {
    debugLogger.warn(
      `[Workflow] getCurrentBranch failed at ${projectRoot}: ${error}`,
    );
  }
  const created = await wtService.createUserWorktree(slug, parentBranch, {
    symlinkDirectories: config.getWorktreeSymlinkDirectories(),
  });
  if (!created.success || !created.worktree) {
    throw new Error(
      `agent({isolation:'worktree'}): failed to create worktree: ` +
        `${created.error ?? 'unknown error'}.`,
    );
  }
  try {
    await writeWorktreeSessionMarker(
      created.worktree.path,
      config.getSessionId(),
    );
  } catch (error) {
    debugLogger.warn(
      `[Workflow] failed to write session marker at ${created.worktree.path}: ${error}`,
    );
  }
  return {
    slug,
    path: created.worktree.path,
    branch: created.worktree.branch,
    repoRoot: projectRoot,
  };
}

/**
 * Build a Config wrapper that rebinds every "where am I?" surface to the
 * isolated worktree path. `Object.create(base)` keeps prototype lookups
 * walking back to the parent for everything else (model config, session
 * id, MCP servers), while the own-property overrides shadow the cwd-
 * adjacent fields so the subagent's tools (Edit / Write / Read / Glob /
 * Grep / Ls / Shell) anchor inside the worktree.
 *
 * Mirrors the inline rebind block at agent.ts:2008-2024. Sets BOTH the
 * field shape (e.g. `targetDir`) AND the method shape (`getTargetDir`)
 * because JS does not promote a getter assignment to a field shadow —
 * call sites that read `this.targetDir` directly inside Config methods
 * would otherwise still resolve through the prototype to the parent.
 */
function createWorktreeConfigOverride(base: Config, wtPath: string): Config {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ov: any = Object.create(base);
  ov.targetDir = wtPath;
  ov.cwd = wtPath;
  ov.getTargetDir = () => wtPath;
  ov.getCwd = () => wtPath;
  ov.getWorkingDir = () => wtPath;
  ov.getProjectRoot = () => wtPath;
  const wtFileService = new FileDiscoveryService(wtPath);
  ov.fileDiscoveryService = wtFileService;
  ov.getFileService = () => wtFileService;
  const wtWorkspace = new WorkspaceContext(wtPath);
  ov.workspaceContext = wtWorkspace;
  ov.getWorkspaceContext = () => wtWorkspace;
  return ov as Config;
}

/**
 * Decide whether the isolation worktree carries work worth preserving:
 * uncommitted edits OR commits that the parent's history does not yet
 * cover. If either check fails-closed, preserve — the cost of preserving
 * spuriously is a stale worktree on disk that the next session-startup
 * sweep cleans up; the cost of removing spuriously is the user's work.
 *
 * Both checks run concurrently because they have no data dependency and
 * each spawns its own `git` invocation. Mirrors AgentTool's
 * `cleanupWorktreeIsolation` (agent.ts:1607-1698).
 */
async function cleanupWorkflowWorktree(
  isolation: WorkflowWorktreeIsolation,
): Promise<WorktreePreservedInfo | null> {
  const wtService = new GitWorktreeService(isolation.repoRoot);
  const [hasChanges, hasUnmerged] = await Promise.all([
    wtService.hasWorktreeChanges(isolation.path).catch((error) => {
      debugLogger.warn(
        `[Workflow] hasWorktreeChanges failed for ${isolation.path}: ${error}`,
      );
      return true;
    }),
    wtService.hasUnmergedWorktreeCommits(isolation.slug).catch((error) => {
      debugLogger.warn(
        `[Workflow] hasUnmergedWorktreeCommits failed for ${isolation.slug}: ${error}`,
      );
      return true;
    }),
  ]);
  if (hasChanges || hasUnmerged) {
    debugLogger.info(
      `[Workflow] Preserving isolation worktree ${isolation.path} ` +
        `(branch ${isolation.branch}, hasChanges=${hasChanges}, hasUnmerged=${hasUnmerged})`,
    );
    return { path: isolation.path, branch: isolation.branch };
  }
  try {
    const result = await wtService.removeUserWorktree(isolation.slug, {
      deleteBranch: true,
    });
    if (!result.success) {
      debugLogger.warn(
        `[Workflow] Failed to remove ephemeral worktree ${isolation.path}: ${result.error}`,
      );
      return { path: isolation.path, branch: isolation.branch };
    }
    if (result.branchPreserved) {
      // Directory removed, but a safe `git branch -d` refused — race where
      // commits landed between the unmerged check and the delete. Surface
      // the branch only; the directory is already gone, so reporting a
      // preservedPath here would point the script at a missing location.
      debugLogger.warn(
        `[Workflow] Removed worktree directory ${isolation.path} but kept ` +
          `branch ${isolation.branch} (unmerged commits at delete time)`,
      );
      return { branch: isolation.branch };
    }
  } catch (error) {
    debugLogger.warn(
      `[Workflow] Failed to remove ephemeral worktree ${isolation.path}: ${error}`,
    );
    return { path: isolation.path, branch: isolation.branch };
  }
  return null;
}

/**
 * Append a single-line suffix to the subagent's final text describing the
 * preserved worktree, so the calling script (and the user reading the
 * workflow result) can find and review the work. The suffix is appended
 * to the existing string return contract — P3 does not widen
 * `WorkflowAgentResult` for this; T4 will widen for the `schema` mode and
 * the suffix is preserved as the fallback shape.
 */
function appendWorktreePreservedSuffix(
  finalText: string,
  preserved: WorktreePreservedInfo,
): string {
  // Wording mirrors AgentTool's formatWorktreeSuffix (agent.ts:1700-1719)
  // verbatim so a user who has seen both tools' worktree-preserved messages
  // sees one consistent shape. AgentTool's version includes the
  // `git worktree add <path> <branch>` recovery hint for the
  // directory-removed-but-branch-preserved race; the Workflow path hits the
  // same race (cleanupWorkflowWorktree's result.branchPreserved branch) so
  // it gets the same hint.
  const sep = finalText.endsWith('\n') ? '\n' : '\n\n';
  if (preserved.path) {
    return `${finalText}${sep}[worktree preserved: ${preserved.path} (branch ${preserved.branch})]`;
  }
  return (
    `${finalText}${sep}[worktree directory removed; branch ${preserved.branch} ` +
    `preserved — recover with \`git worktree add <path> ${preserved.branch}\`]`
  );
}

/**
 * Per-call schema-mode state. The dispatch listens to TOOL_CALL/TOOL_RESULT
 * events from the subagent and updates this object: failed
 * `structured_output` calls increment `attempts` (and abort the dispatch
 * after the third failure — "after 2 in-conversation nudges" in upstream
 * parlance), and a successful call captures the validated args as
 * `result` and aborts the dispatch so the subagent stops generating
 * additional tokens.
 *
 * Per-element isolation: each agent({schema}) call gets its own
 * SchemaModeState. Concurrent calls under parallel()/pipeline() do not
 * share counters or results.
 */
interface SchemaModeState {
  result: unknown | null;
  attempts: number;
  pendingArgs: Map<string, Record<string, unknown>>;
  abortController: AbortController;
}

function createSchemaModeState(): SchemaModeState {
  return {
    result: null,
    attempts: 0,
    pendingArgs: new Map(),
    abortController: new AbortController(),
  };
}

/**
 * Build an AgentEventEmitter that observes `structured_output` tool calls
 * for one subagent. The emitter is single-purpose: it only updates the
 * provided schema state, and ignores every other event type.
 *
 * Why TOOL_CALL captures `args` and TOOL_RESULT decides success: the
 * TOOL_RESULT event in agent-core (line 1194-1205) carries `success` and
 * `responseParts` but not the original arguments, so we snapshot args at
 * TOOL_CALL time keyed by `callId` and look them up when TOOL_RESULT
 * fires. A successful call's args ARE the validated structured payload
 * (AJV validation runs inside `BaseDeclarativeTool.validateToolParams`
 * before `execute()` is invoked).
 *
 * Abort semantics:
 *   - On successful capture: abort the dispatch signal so the subagent
 *     loop stops emitting tokens. `SyntheticOutputTool.execute()` already
 *     instructs the model to stop, but abort makes termination
 *     deterministic.
 *   - On the third failure (attempts > 2 after increment): abort the
 *     dispatch signal so the subagent stops retrying. The post-execute
 *     check in `runOverridePath` then throws the upstream-aligned
 *     "completed without calling StructuredOutput (after 2 in-conversation
 *     nudges)" error.
 *   - Caller abort: outer code in `runOverridePath` forwards the caller's
 *     signal into this state's controller, so a caller cancellation
 *     propagates straight to the subagent.
 */
function createSchemaEventEmitter(state: SchemaModeState): AgentEventEmitter {
  const emitter = new AgentEventEmitter();
  const targetTool = ToolNames.STRUCTURED_OUTPUT;
  emitter.on(AgentEventType.TOOL_CALL, (evt: AgentToolCallEvent) => {
    if (evt.name !== targetTool) return;
    // Args are the candidate structured payload. They're stashed pending
    // the matching TOOL_RESULT, then either promoted to `result` (success)
    // or discarded (failure).
    state.pendingArgs.set(evt.callId, evt.args);
  });
  emitter.on(AgentEventType.TOOL_RESULT, (evt: AgentToolResultEvent) => {
    if (evt.name !== targetTool) return;
    const args = state.pendingArgs.get(evt.callId);
    state.pendingArgs.delete(evt.callId);
    if (evt.success) {
      if (args !== undefined && state.result === null) {
        state.result = args;
        state.abortController.abort();
      }
      return;
    }
    state.attempts += 1;
    if (state.attempts > 2 && state.result === null) {
      state.abortController.abort();
    }
  });
  return emitter;
}

/**
 * Build a Config override whose `getToolRegistry()` returns a fresh
 * registry with a per-call `SyntheticOutputTool` bound to the
 * user-supplied schema. The base registry is rebuilt via
 * `rebuildToolRegistryOnOverride` (the same helper AgentTool /
 * SubagentManager use), so the override carries the full core toolset
 * AND the user's schema-bound tool — both anchored to the override
 * Config, isolating any per-tool caches (FileReadCache, etc.) from the
 * parent.
 *
 * Why a fresh tool instance per call (no caching): each `agent({schema:S})`
 * call may carry a different `S`, and `SyntheticOutputTool`'s parameter
 * schema IS its constructor argument — caching would alias different
 * schemas to the same tool name and let validation pass against the wrong
 * shape. The cost (one tool instantiation per schema call) is bounded by
 * the 1000-agent-per-run cap.
 *
 * Concurrency safety: the override is per-call, so concurrent
 * agent({schema:S1}) and agent({schema:S2}) under parallel()/pipeline()
 * each get their own override Config and their own registry. No shared
 * mutation, no race.
 */
async function createSchemaConfigOverride(
  base: Config,
  schema: Record<string, unknown>,
): Promise<Config> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const override: any = Object.create(base);
  await rebuildToolRegistryOnOverride(override as Config, base);
  const registry = override.getToolRegistry();
  registry.registerTool(new SyntheticOutputTool(schema));
  return override as Config;
}

export class WorkflowOrchestrator {
  constructor(private readonly dispatch: WorkflowAgentDispatch) {}

  async run(req: WorkflowRunRequest): Promise<WorkflowRunOutcome> {
    // Signal threading: createProductionDispatch closure-captures a signal
    // for subagent.execute cancellation. P2 additionally derives a per-run
    // limiter from req.abortOnTimeout?.signal so wall-clock abort drains
    // queued dispatches promptly. Sync-loop protection is the 30s vm
    // timeout in workflow-sandbox.ts; async-loop cancellation flows through
    // dispatch's subagent.execute path.
    const runId = generateRunId();

    const maxAgents = resolveMaxAgentsPerRun();
    const signal = req.abortOnTimeout?.signal;

    // P2: the concurrency window throttles AGENT DISPATCHES, not orchestration
    // thunks. parallel()/pipeline() compose promises freely; only the leaf
    // agent() calls acquire a slot. This gives the correct "N agents in flight
    // per run" semantics AND avoids a re-entrancy deadlock (F1, P2 review): if
    // the window sat at the thunk level, a nested parallel()/pipeline() — e.g.
    // a pipeline stage that fans out, the canonical /deep-research shape —
    // would hold every slot while awaiting inner work that can never acquire
    // one. One shared limiter per run keeps total in-flight agents under the
    // cap across all fan-out calls.
    const limiter = createConcurrencyLimiter(resolveConcurrencyLimit(), signal);

    // Every agent() call — sequential, parallel(), or pipeline() — funnels
    // through this one wrapped dispatch: the counter enforces the per-run agent
    // cap regardless of launch path (increment-then-check: calls 1..max pass,
    // the (max+1)th throws), and limiter.run enforces the concurrency window.
    let agentCount = 0;
    const countedDispatch: WorkflowAgentDispatch = (prompt, opts) => {
      agentCount += 1;
      if (agentCount > maxAgents) {
        return Promise.reject(
          new Error(
            `Workflow exceeded the maximum of ${maxAgents} agent() calls per run.`,
          ),
        );
      }
      return limiter.run(() => this.dispatch(prompt, opts));
    };

    const parallelImpl = makeParallelImpl(signal);
    const pipelineImpl = makePipelineImpl(signal);

    const sandbox = createWorkflowSandbox({
      args: req.args,
      dispatch: countedDispatch,
      parallel: parallelImpl,
      pipeline: pipelineImpl,
      abortOnTimeout: req.abortOnTimeout,
    });
    try {
      const result = await sandbox.run(req.script);
      return {
        runId,
        result,
        phases: sandbox.getPhases(),
        logs: sandbox.getLogs(),
      };
    } catch (err) {
      // T19 (PR #4732 R1): preserve phases and logs accumulated before the
      // script failed so the caller can surface them in the error display.
      // We only carry primitive strings across the boundary — no host-realm
      // Error instance — to avoid reintroducing the T1 escape vector.
      //
      // Cross-realm `instanceof Error` is false for vm-realm Error objects,
      // so duck-type on `.message` instead. `String(vmError)` would coerce
      // to "Error: <msg>" which is the wrong shape for a clean message.
      throw new WorkflowExecutionError(
        extractErrorMessage(err),
        sandbox.getPhases(),
        sandbox.getLogs(),
      );
    }
  }
}

/**
 * Settle a batch of thunks into a position-aligned `Array<T|null>` —
 * errors-as-data: a thunk that rejects (including an over-cap dispatch or a
 * stage error) becomes `null` at its index, never collapsing the batch.
 * `Promise.resolve().then(t)` funnels a synchronously-throwing thunk into the
 * rejection path. The ONE thing that rejects the whole batch is an abort, so
 * an aborted run surfaces a rejection rather than a silent array of nulls.
 * Concurrency is bounded at the dispatch layer (limiter.run in countedDispatch),
 * not here — so nesting a parallel()/pipeline() inside a thunk cannot deadlock.
 *
 * Abort responsiveness: this function awaits `Promise.allSettled` which only
 * settles after every thunk settles. That is NOT a long wait in practice
 * because the dispatch signal (workflow-orchestrator.ts countedDispatch +
 * createProductionDispatch) is threaded through to `subagent.execute(ctx,
 * signal)`, so each in-flight thunk reacts to abort and rejects promptly. The
 * limiter's separate `addEventListener('abort')` listener drains the
 * not-yet-started queued thunks instantly. So the apparent "wait for all to
 * complete" is in reality "wait for all to reach an abort-aware rejection",
 * which fires immediately after the signal — not after each subagent's full
 * 10-min internal timeout.
 */
async function settleToNullArray(
  thunks: Array<() => Promise<unknown>>,
  signal?: AbortSignal,
): Promise<unknown[]> {
  const settled = await Promise.allSettled(
    thunks.map((t) => Promise.resolve().then(t)),
  );
  // Use DOMException('AbortError') for consistency with the limiter's
  // abort path so HOST-side callers seeing this rejection directly can
  // classify it via isAbortError() (utils/errors.ts). NOTE: this name is
  // NOT preserved across the vm boundary — vmAsync (workflow-sandbox.ts)
  // re-throws the script-visible rejection as a fresh vm-realm `new
  // Error(msg)`, and the orchestrator's outer catch then wraps it as
  // WorkflowExecutionError. So isAbortError() at the WorkflowTool layer
  // returns false either way; the DOMException is purely a host-internal
  // consistency choice, not a script-observable one.
  if (signal?.aborted)
    throw new DOMException('Workflow run aborted.', 'AbortError');
  // Errors-as-data: a rejected thunk becomes null at its index. Log the
  // discarded rejection reason at debug level so operators investigating a
  // workflow that returned unexpected nulls can disambiguate between (a) a
  // dispatch failure (rate limit / model outage), (b) the 1000-agent cap,
  // (c) a pipeline stage exception, and (d) a non-JSON-serializable thunk
  // return — all of which surface as the same `null` to the script by
  // design. The log line is the only operator-side signal of which path
  // fired; the contract to the script stays opaque.
  return settled.map((r, i) => {
    if (r.status === 'fulfilled') return r.value;
    debugLogger.warn(
      `Workflow thunk at index ${i} rejected: ${String((r.reason as { message?: unknown })?.message ?? r.reason)}`,
    );
    return null;
  });
}

/**
 * Build the host-side `parallel(thunks)` impl. Each thunk is a vm-realm
 * function whose agent() calls throttle through the per-run concurrency window
 * at the dispatch layer. A thunk that rejects, or resolves to a non-JSON-
 * serializable value, becomes `null` at its index (errors-as-data). `parallel()`
 * itself rejects only when given invalid arguments (non-array / non-function
 * element) or when the run is aborted. The result array is revived into the
 * vm realm by the sandbox wrapper (per-element JSON round-trip) — this host
 * array never reaches the script directly.
 */
function makeParallelImpl(
  signal?: AbortSignal,
): (thunks: Array<() => Promise<unknown>>) => Promise<unknown[]> {
  return (thunks) => {
    if (!Array.isArray(thunks)) {
      return Promise.reject(
        new Error(
          'parallel() expects an array of thunks (functions returning promises).',
        ),
      );
    }
    for (const t of thunks) {
      if (typeof t !== 'function') {
        return Promise.reject(
          new Error(
            'parallel() expects an array of functions, not values — wrap each ' +
              'call: parallel([() => agent(...), () => agent(...)]).',
          ),
        );
      }
    }
    return settleToNullArray(thunks, signal);
  };
}

/**
 * Build the host-side `pipeline(items, ...stages)` impl as parallel-of-chains.
 *
 * Each item becomes one chain that runs the stages in sequence — staggered,
 * with NO barrier between stages, so item A can be in stage 3 while item B is
 * still in stage 1. Stage callbacks receive `(prev, item, idx)`; the first
 * stage's `prev` is the item itself. A stage that throws, returns `null`, or
 * returns a non-JSON-serializable value drops that item to `null` and skips
 * its remaining stages, leaving other items unaffected. Concurrency is
 * bounded at the dispatch layer, and the result array shares parallel()'s
 * per-element vm-realm revival.
 */
function makePipelineImpl(
  signal?: AbortSignal,
): (
  items: unknown[],
  ...stages: Array<
    (prev: unknown, item: unknown, idx: number) => Promise<unknown>
  >
) => Promise<unknown[]> {
  return (items, ...stages) => {
    if (!Array.isArray(items)) {
      return Promise.reject(
        new Error(
          'pipeline() expects an array of items as its first argument.',
        ),
      );
    }
    for (const s of stages) {
      if (typeof s !== 'function') {
        return Promise.reject(
          new Error(
            'pipeline() stages must be functions: ' +
              'pipeline(items, item => ..., result => ...).',
          ),
        );
      }
    }
    const chains = items.map(
      (item, idx) => () => runPipelineChain(item, idx, stages),
    );
    return settleToNullArray(chains, signal);
  };
}

/**
 * Run one item through every stage in order. `null` is the universal drop
 * sentinel: a stage that returns `null` (or throws — surfaced as a rejection
 * that the batch maps to `null`) short-circuits the rest of the chain.
 */
async function runPipelineChain(
  item: unknown,
  idx: number,
  stages: Array<
    (prev: unknown, item: unknown, idx: number) => Promise<unknown>
  >,
): Promise<unknown> {
  let prev: unknown = item;
  for (const stage of stages) {
    if (prev === null) break;
    prev = await stage(prev, item, idx);
  }
  return prev;
}

/**
 * Duck-typed message extraction. `instanceof Error` is realm-local; vm-realm
 * Errors raised inside the sandbox are NOT instances of host Error from the
 * orchestrator's perspective, so the standard `err instanceof Error ?
 * err.message : String(err)` pattern produces "Error: msg" via toString().
 * This helper falls back to the .message property regardless of realm.
 */
function extractErrorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err) {
    const m = (err as { message: unknown }).message;
    if (typeof m === 'string') return m;
    return String(m);
  }
  return String(err);
}
