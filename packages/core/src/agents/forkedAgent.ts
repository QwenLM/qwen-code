/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unified forked-agent execution primitive.
 *
 * The two execution paths are selected by whether cacheSafeParams is supplied:
 *
 *   WITH cacheSafeParams  → LlmChat single-turn, shares parent prompt
 *                            cache (systemInstruction + history). Tools are
 *                            stripped by default (NO_TOOLS) to prevent
 *                            function calls; pass preserveTools: true to
 *                            keep the parent's tools prefix for Anthropic
 *                            prompt-cache hits.
 *                            Use for: /btw, suggestions, pipelined suggestions.
 *
 *   WITHOUT cacheSafeParams → AgentHeadless multi-turn, full tool access,
 *                              isolated session (no shared history).
 *                              Use for: memory extract, dream consolidation.
 *
 * Tool-deny for forked queries is enforced at the per-request level (NO_TOOLS)
 * unless the caller opts out via preserveTools to share the cache prefix.
 *
 * Callers (extractScheduler, dreamScheduler) own concurrency control.
 * runSideQuery() remains a separate primitive for structured-JSON calls that
 * need no conversation history at all (recall, forget, governance).
 */

import type {
  Content,
  GenerateContentConfig,
  GenerateContentResponseUsageMetadata,
  Part,
} from '@google/genai';
import {
  runWithRuntimeContentGenerator,
  type RuntimeContentGeneratorView,
} from './runtime/agent-context.js';
import { ApprovalMode, type Config } from '../config/config.js';
import { LlmChat } from '../core/llm-chat.js';
import { ModelStreamAttemptState } from '../core/model-stream-attempt-state.js';
import { createRuntimeContentGeneratorView } from '../models/content-generator-config.js';
import { createApprovalModeOverride } from '../tools/agent/agent.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import {
  AgentHeadless,
  AgentEventEmitter,
  AgentEventType,
  AgentTerminateMode,
  ContextState,
  type ModelConfig,
  type PromptConfig,
  type RunConfig,
  type ToolConfig,
} from './index.js';
import { toModelVisibleSubagentResult } from './subagent-result.js';
import {
  buildModelIdContext,
  resolveModelId,
  type ResolvedModelId,
} from '../utils/modelId.js';
import { ToolNames } from '../tools/tool-names.js';
import { getFunctionResponseParts } from '../services/compactionInputSlimming.js';
import { runWithChatRecordingSuppressed } from '../utils/chat-recording-suppression-context.js';
import { createChildAbortController } from '../utils/abortController.js';

const debugLogger = createDebugLogger('FORKED_AGENT');

// ---------------------------------------------------------------------------
// CacheSafeParams — shared prompt-cache slot
// ---------------------------------------------------------------------------

/**
 * Snapshot of the main conversation's cache-critical parameters.
 * Captured after each successful main turn so forked queries share the same
 * prompt prefix (systemInstruction + history) for cache hits.
 */
export interface CacheSafeParams {
  /** Full generation config including systemInstruction and tools */
  generationConfig: GenerateContentConfig;
  /**
   * Curated conversation history with copied Content, parts arrays, and Part
   * objects. Nested functionResponse parts are copied too; leaf payloads remain
   * shared and must not be mutated.
   */
  history: Content[];
  /** Model identifier */
  model: string;
  /** Version number — increments when systemInstruction or tools change */
  version: number;
  /**
   * The session that saved these params. The slot is a process-global, so
   * in a multi-session daemon it can hold another session's params; readers
   * must match this against their own session id before trusting it, or a
   * forked query could be built from a different session's transcript
   * (cross-session content leak) (#9233).
   */
  sessionId?: string;
}

// Module-level slot written after each successful main turn.
let currentCacheSafeParams: CacheSafeParams | null = null;
let currentVersion = 0;

function clonePart(part: Part): Part {
  const nested = getFunctionResponseParts(part);
  if (!nested) return { ...part };
  return {
    ...part,
    functionResponse: {
      ...part.functionResponse,
      parts: nested.map((inner) => ({ ...inner })),
    },
  };
}

function copyHistoryContainers(history: Content[]): Content[] {
  return history.map((content) => ({
    ...content,
    ...(content.parts ? { parts: content.parts.map(clonePart) } : {}),
  }));
}

/**
 * Save cache-safe params after a successful main conversation turn.
 * Called from LlmClient.sendMessageStream() on successful completion.
 */
export function saveCacheSafeParams(
  generationConfig: GenerateContentConfig,
  history: Content[],
  model: string,
  sessionId?: string,
): void {
  const prevConfig = currentCacheSafeParams?.generationConfig;
  const sysChanged =
    !prevConfig ||
    JSON.stringify(prevConfig.systemInstruction) !==
      JSON.stringify(generationConfig.systemInstruction);
  const toolsChanged =
    !prevConfig ||
    JSON.stringify(prevConfig.tools) !== JSON.stringify(generationConfig.tools);

  if (sysChanged || toolsChanged) {
    currentVersion++;
  }

  currentCacheSafeParams = {
    generationConfig: structuredClone(generationConfig),
    history: copyHistoryContainers(history),
    model,
    version: currentVersion,
    sessionId,
  };
}

/**
 * Get the current cache-safe params, or null if not yet captured or owned by
 * another session. Production readers must pass their session id; omitting it
 * is retained for tests and callers that inspect the raw process-global slot.
 */
export function getCacheSafeParams(
  expectedSessionId?: string,
): CacheSafeParams | null {
  if (!currentCacheSafeParams) return null;
  if (
    expectedSessionId !== undefined &&
    currentCacheSafeParams.sessionId !== expectedSessionId
  ) {
    debugLogger.debug(
      `CacheSafeParams session_mismatch: requested=${expectedSessionId}, cached=${currentCacheSafeParams.sessionId ?? '(none)'}`,
    );
    return null;
  }
  return {
    generationConfig: structuredClone(currentCacheSafeParams.generationConfig),
    history: copyHistoryContainers(currentCacheSafeParams.history),
    model: currentCacheSafeParams.model,
    version: currentCacheSafeParams.version,
    sessionId: currentCacheSafeParams.sessionId,
  };
}

export function getCacheSafeParamsSessionId(): string | undefined {
  return currentCacheSafeParams?.sessionId;
}

/**
 * Clear cache-safe params (e.g., on session reset).
 */
export function clearCacheSafeParams(): void {
  currentCacheSafeParams = null;
}

// ---------------------------------------------------------------------------
// Forked chat — shared by runForkedAgent (cache path) and speculation
// ---------------------------------------------------------------------------

/**
 * Per-request config that strips tools so the model never produces function
 * calls. Applied by default in the cache path; skipped when preserveTools
 * is true (to share the Anthropic prompt-cache prefix).
 */
const NO_TOOLS = Object.freeze({ tools: [] as const }) as Pick<
  GenerateContentConfig,
  'tools'
>;

/**
 * Create an isolated LlmChat that shares the main conversation's
 * generationConfig (including systemInstruction, tools, and history).
 *
 * Used by runForkedAgent (cache path) and directly by speculation.ts which
 * needs its own multi-turn tool-execution loop with OverlayFs interception.
 */
export function createForkedChat(
  config: Config,
  params: CacheSafeParams,
): LlmChat {
  const maxHistoryEntries = 40;
  const history =
    params.history.length > maxHistoryEntries
      ? params.history.slice(-maxHistoryEntries)
      : params.history;

  const forkedChat = new LlmChat(
    config,
    {
      ...params.generationConfig,
      // Disable thinking for forked queries — no reasoning tokens needed,
      // and it doesn't affect the cache prefix.
      thinkingConfig: { includeThoughts: false },
    },
    [...history],
    undefined, // no chatRecordingService
    undefined, // no telemetryService
  );
  // The fork shares the parent's ToolRegistry; its history rewrites must
  // not touch the parent's loaded-skill tracking.
  forkedChat.isForkedChat = true;
  return forkedChat;
}

interface ForkedModelRuntime {
  model: string;
  runtimeView?: RuntimeContentGeneratorView;
}

async function buildForkedModelRuntime(
  base: Config,
  contentGeneratorOwner: Config,
  modelSelector: string,
): Promise<ForkedModelRuntime> {
  const resolvedModel = resolveModelId(
    modelSelector,
    buildModelIdContext(base),
  );
  // When the selector cannot resolve (e.g. `fast` with no fast model
  // configured, or `inherit` on a config without a current model), fall back
  // to the parent session model instead of passing the raw selector string
  // to the provider. Matches the subagent path, where an unresolvable
  // selector means "inherit parent".
  const model = resolvedModel?.modelId ?? base.getModel();
  const runtimeView = await buildForkedRuntimeContentGeneratorView(
    base,
    contentGeneratorOwner,
    resolvedModel,
  );

  return { model, runtimeView };
}

async function buildForkedRuntimeContentGeneratorView(
  base: Config,
  contentGeneratorOwner: Config,
  resolvedModel: ResolvedModelId | undefined,
): Promise<RuntimeContentGeneratorView | undefined> {
  if (!resolvedModel?.authType) return undefined;

  const currentContentGeneratorConfig = base.getContentGeneratorConfig?.();
  const currentAuthType = currentContentGeneratorConfig?.authType;
  const currentModel =
    currentContentGeneratorConfig?.model ?? base.getModel?.();
  if (
    resolvedModel.authType === currentAuthType &&
    resolvedModel.modelId === currentModel
  ) {
    return undefined;
  }

  return createRuntimeContentGeneratorView(
    base,
    contentGeneratorOwner,
    resolvedModel.modelId,
    { authType: resolvedModel.authType },
  );
}

function runWithForkedModelRuntime<T>(
  runtime: ForkedModelRuntime,
  fn: (model: string) => Promise<T>,
): Promise<T> {
  const run = () => fn(runtime.model);
  return runtime.runtimeView
    ? runWithRuntimeContentGenerator(runtime.runtimeView, run)
    : run();
}

/**
 * Run a direct forked-chat loop under the runtime view required by the
 * selected model. This is used by speculation, which owns its own multi-turn
 * loop instead of going through runForkedAgent().
 */
export async function runWithForkedChatModel<T>(
  config: Config,
  modelSelector: string,
  fn: (model: string) => Promise<T>,
): Promise<T> {
  const runtime = await buildForkedModelRuntime(config, config, modelSelector);
  return runWithForkedModelRuntime(runtime, fn);
}

// ---------------------------------------------------------------------------
// ForkedQueryResult — returned by cache-path runForkedAgent
// ---------------------------------------------------------------------------

/**
 * Result from a cache-path runForkedAgent (with cacheSafeParams).
 * Single-turn, text-only. Tools stripped by default; pass preserveTools
 * to keep the parent's tools for cache-prefix matching.
 */
export interface ForkedQueryResult {
  /** Extracted text response, or null if no text */
  text: string | null;
  /** Parsed JSON result if jsonSchema was provided */
  jsonResult?: Record<string, unknown>;
  /** Token usage metrics */
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheHitTokens: number;
  };
  /** Resolved model id used for the query (after selector/alias resolution). */
  model: string;
}

function extractQueryUsage(
  metadata?: GenerateContentResponseUsageMetadata,
): ForkedQueryResult['usage'] {
  return {
    inputTokens: metadata?.promptTokenCount ?? 0,
    outputTokens: metadata?.candidatesTokenCount ?? 0,
    cacheHitTokens: metadata?.cachedContentTokenCount ?? 0,
  };
}

// ---------------------------------------------------------------------------
// ForkedAgentParams / ForkedAgentResult — AgentHeadless path
// ---------------------------------------------------------------------------

/**
 * Overloaded params for runForkedAgent.
 *
 * Supply `cacheSafeParams` to run the cache path (single-turn, no tools,
 * shares parent prompt cache). Omit it to run the AgentHeadless path
 * (multi-turn, full tool access, isolated session).
 */
export type ForkedAgentParams = CachePathParams | AgentPathParams;

/** Cache path: single-turn, shares parent prompt cache. */
export interface CachePathParams {
  /** Runtime config. */
  config: Config;
  /** The user message to send to the forked chat. */
  userMessage: string;
  /** CacheSafeParams snapshot from the main session (required). */
  cacheSafeParams: CacheSafeParams;
  /** Optional JSON schema for structured output. */
  jsonSchema?: Record<string, unknown>;
  /** Model override (defaults to cacheSafeParams.model). */
  model?: string;
  /** External cancellation signal. */
  abortSignal?: AbortSignal;
  /** Do not route the query through configured model fallbacks. */
  disableModelFallbacks?: boolean;
  /**
   * When true, keep the parent's tools in the per-request config so the
   * Anthropic prompt-cache key (system + tools) matches the main agent's.
   * Default (false/omitted): strip tools via NO_TOOLS to prevent function
   * calls — appropriate for most forked queries.
   */
  preserveTools?: boolean;
}

/** AgentHeadless path: multi-turn, full tool access, isolated session. */
export interface AgentPathParams {
  /** Unique name for this agent run (for logging and telemetry). */
  name: string;
  /** Runtime config. ApprovalMode is forced to YOLO internally. */
  config: Config;
  /** Task prompt sent as the initial user message. */
  taskPrompt: string;
  /** System prompt defining the agent's persona and constraints. */
  systemPrompt: string;
  /** Model override (defaults to fast model selector, then current model). */
  model?: string;
  /** Maximum number of agent turns (default: unlimited). */
  maxTurns?: number;
  /** Maximum execution time in minutes (default: unlimited). */
  maxTimeMinutes?: number;
  /**
   * Allowed tools. Pass a string array to restrict access.
   * Omit (undefined) to allow all available tools.
   * Pass an empty array to deny all tools (single-turn text output only).
   */
  tools?: string[];
  /**
   * Optional parent conversation history to inject for richer context.
   * Ensures the agent sees the conversation without re-serializing it.
   * Must end with a `model` role entry; call buildAgentHistory() to enforce this.
   */
  extraHistory?: Content[];
  /**
   * Preserve an explicit empty `extraHistory` as caller-owned history.
   * Most callers use [] to mean "no prior history"; keep that as undefined so
   * AgentCore still bootstraps workspace env context. Clean remember sets this
   * to intentionally suppress that bootstrap.
   */
  preserveEmptyExtraHistory?: boolean;
  /** External cancellation signal. */
  abortSignal?: AbortSignal;
  /** Suppress chat-recording UI telemetry for hidden internal agents. */
  suppressChatRecording?: boolean;
  /**
   * Complete the run as soon as the first successful file write succeeds.
   * Pass a predicate to restrict early completion to matching paths — the
   * remember caller excludes MEMORY.md, whose write does not count as a
   * memory update on its own.
   */
  completeAfterFirstSuccessfulWrite?: boolean | ((filePath: string) => boolean);
}

export interface ForkedAgentResult {
  status: 'completed' | 'failed' | 'cancelled';
  /** Final text output from the agent's last response. */
  finalText?: string;
  /** AgentTerminateMode string explaining why the agent stopped. */
  terminateReason?: string;
  /** File paths observed in path-like tool call arguments during execution. */
  filesTouched: string[];
  /** File paths from successful mutating tool results. */
  filesWritten?: string[];
}

/**
 * Extracts file paths from a tool call's args object.
 * Matches any arg key that contains "path", "file", or "target".
 */
function extractFilePathsFromArgs(args: Record<string, unknown>): string[] {
  const matches = new Set<string>();

  const visit = (value: unknown, key?: string): void => {
    if (typeof value === 'string') {
      const normalizedKey = key?.toLowerCase() ?? '';
      if (
        normalizedKey.includes('path') ||
        normalizedKey.includes('file') ||
        normalizedKey.includes('target')
      ) {
        matches.add(value);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, key);
      return;
    }
    if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        visit(v, k);
      }
    }
  };

  visit(args);
  return [...matches];
}

function isMutatingFileTool(toolName: string): boolean {
  return toolName === ToolNames.WRITE_FILE || toolName === ToolNames.EDIT;
}

/**
 * Unified forked-agent execution primitive.
 *
 * Two overloads selected by the shape of `params`:
 *
 *   params.cacheSafeParams present  → cache path (ForkedQueryResult)
 *     Single-turn, tools stripped by default (preserveTools overrides),
 *     shares parent prompt cache.
 *     Use for: /btw, suggestions, pipelined suggestions.
 *
 *   params.taskPrompt present        → agent path (ForkedAgentResult)
 *     Multi-turn AgentHeadless, full tool access, isolated session.
 *     Use for: memory extract, dream consolidation.
 */
export async function runForkedAgent(
  params: CachePathParams,
): Promise<ForkedQueryResult>;
export async function runForkedAgent(
  params: AgentPathParams,
): Promise<ForkedAgentResult>;
export async function runForkedAgent(
  params: ForkedAgentParams,
): Promise<ForkedQueryResult | ForkedAgentResult> {
  // ── Cache path ────────────────────────────────────────────────────────────
  if ('cacheSafeParams' in params) {
    const {
      config,
      userMessage,
      cacheSafeParams,
      jsonSchema,
      abortSignal,
      preserveTools,
      disableModelFallbacks,
    } = params;
    const modelSelector = params.model ?? cacheSafeParams.model;
    const modelRuntime = await buildForkedModelRuntime(
      config,
      config,
      modelSelector,
    );

    return runWithForkedModelRuntime(modelRuntime, async (model) => {
      const chat = createForkedChat(config, cacheSafeParams);

      const requestConfig: GenerateContentConfig = preserveTools
        ? {}
        : { ...NO_TOOLS };
      if (abortSignal) requestConfig.abortSignal = abortSignal;
      if (jsonSchema) {
        requestConfig.responseMimeType = 'application/json';
        requestConfig.responseJsonSchema = jsonSchema;
      }

      const sendParams = {
        message: [{ text: userMessage }],
        config: requestConfig,
      };
      const stream = disableModelFallbacks
        ? await chat.sendMessageStream(
            model,
            sendParams,
            'forked_query',
            undefined,
            { disableModelFallbacks: true },
          )
        : await chat.sendMessageStream(model, sendParams, 'forked_query');

      const attemptState = new ModelStreamAttemptState();

      for await (const event of stream) {
        const transition = attemptState.accept(event);
        if (transition.type !== 'chunk') continue;
        const response = transition.response;
        const parts = response.candidates?.[0]?.content?.parts ?? [];

        // Defensive: when preserveTools is true the model could produce
        // functionCall parts instead of text. Log and discard them.
        if (
          preserveTools &&
          parts.some((p) => (p as Record<string, unknown>)['functionCall'])
        ) {
          debugLogger.warn(
            'Cache-path forked query received functionCall with preserveTools; discarding.',
          );
        }
      }

      const attempt = attemptState.snapshot();
      const trimmed = attempt.text.trim() || null;
      const usage: ForkedQueryResult['usage'] = attempt.usageMetadata
        ? extractQueryUsage(attempt.usageMetadata)
        : {
            inputTokens: 0,
            outputTokens: 0,
            cacheHitTokens: 0,
          };
      let jsonResult: Record<string, unknown> | undefined;
      if (jsonSchema && trimmed) {
        try {
          jsonResult = JSON.parse(trimmed) as Record<string, unknown>;
        } catch {
          // non-JSON response despite schema constraint — treat as text
        }
      }

      return { text: trimmed, jsonResult, usage, model };
    });
  }

  // ── AgentHeadless path ────────────────────────────────────────────────────
  // `createApprovalModeOverride` rebuilds the tool registry on the YOLO
  // wrapper Config so core file tools (`EditTool` / `WriteFileTool` /
  // `ReadFileTool`) resolve `this.config` to the wrapper, not to the
  // parent. Without that rebuild the YOLO override is silently ignored
  // on the bound-tool path (parent's pre-bound tool instances keep
  // reading the parent's approval mode), and the wrapper's own
  // `FileReadCache` lazy-init is bypassed too.
  //
  // Consumers that pre-wrap with `createMemoryScopedAgentConfig`
  // (memory extraction / dream agent) compose correctly: the YOLO
  // wrapper's bound tools resolve `this.config.getPermissionManager()`
  // through the prototype chain to the scoped wrapper's own override,
  // while `this.config.getApprovalMode()` lands on YOLO.
  const { config: yoloConfig, cleanup: restoreParentPM } =
    await createApprovalModeOverride(params.config, ApprovalMode.YOLO);
  // YOLO never triggers strip → restoreParentPM is a no-op. Kept for
  // API symmetry with the other createApprovalModeOverride callers; if
  // this function ever switches away from YOLO the lifecycle stays
  // correct without further refactor.
  const filesTouched = new Set<string>();
  const pendingMutatingPaths = new Map<string, string[]>();
  const filesWritten = new Set<string>();

  const initialMessages =
    params.extraHistory &&
    (params.extraHistory.length > 0 || params.preserveEmptyExtraHistory)
      ? params.extraHistory
      : undefined;
  const promptConfig: PromptConfig = {
    systemPrompt: params.systemPrompt,
    initialMessages,
  };
  const modelSelector =
    params.model ?? params.config.getFastModel?.() ?? params.config.getModel();
  const modelRuntime = await buildForkedModelRuntime(
    params.config,
    yoloConfig,
    modelSelector,
  );
  const modelConfig: ModelConfig = {
    model: modelRuntime.model,
  };
  const runConfig: RunConfig = {
    max_turns: params.maxTurns,
    max_time_minutes: params.maxTimeMinutes,
  };
  const toolConfig: ToolConfig | undefined =
    params.tools !== undefined ? { tools: params.tools } : undefined;
  const executionController = createChildAbortController(params.abortSignal);
  let completedAfterWrite = false;
  // Identity marker for the run's own early-completion abort, so the
  // execute catch below can tell it apart from an external cancel
  // that races it — an external cancel must still reject the run.
  const selfAbortReason = new DOMException(
    'Early completion after successful write',
    'AbortError',
  );

  const emitter = new AgentEventEmitter();
  emitter.on(AgentEventType.TOOL_CALL, (event) => {
    const filePaths = extractFilePathsFromArgs(event.args);
    for (const filePath of filePaths) {
      filesTouched.add(filePath);
    }
    if (isMutatingFileTool(event.name)) {
      pendingMutatingPaths.set(event.callId, filePaths);
    }
  });
  emitter.on(AgentEventType.TOOL_RESULT, (event) => {
    if (!event.success) {
      pendingMutatingPaths.delete(event.callId);
      return;
    }
    const filePaths = pendingMutatingPaths.get(event.callId) ?? [];
    pendingMutatingPaths.delete(event.callId);
    for (const filePath of filePaths) {
      filesWritten.add(filePath);
    }
    const completesEarly =
      params.completeAfterFirstSuccessfulWrite === true
        ? filePaths.length > 0
        : typeof params.completeAfterFirstSuccessfulWrite === 'function'
          ? filePaths.some(params.completeAfterFirstSuccessfulWrite)
          : false;
    if (completesEarly && !executionController.signal.aborted) {
      completedAfterWrite = true;
      // Defer the abort out of this emitter handler: agent-core emits a
      // parallel batch's TOOL_RESULT events one by one, and aborting
      // synchronously re-enters its onAbort mid-emission, which replaces
      // the still-unemitted real successes of the same batch with
      // synthetic cancellation failures — truncating filesWritten below
      // the writes that actually landed on disk.
      setImmediate(() => executionController.abort(selfAbortReason));
    }
  });

  try {
    const headless = await AgentHeadless.create(
      params.name,
      yoloConfig,
      promptConfig,
      modelConfig,
      runConfig,
      toolConfig,
      emitter,
      undefined,
      modelRuntime.runtimeView,
    );

    const context = new ContextState();
    context.set('task_prompt', params.taskPrompt);
    context.set('hook_context', '');
    const execute = () =>
      runWithForkedModelRuntime(modelRuntime, async () => {
        await headless.execute(context, executionController.signal);
      });

    try {
      if (params.suppressChatRecording) {
        await runWithChatRecordingSuppressed(execute);
      } else {
        await execute();
      }
    } catch (err) {
      // The deferred self-abort lands after the reasoning loop's
      // post-batch abort check, inside the next model round, so the
      // run can reject with an AbortError even though the goal write
      // is already on disk. Fall through to the completedAfterWrite
      // return for that self-triggered abort; every other failure
      // (external cancels included) propagates.
      if (
        !completedAfterWrite ||
        executionController.signal.reason !== selfAbortReason
      ) {
        throw err;
      }
    }

    const terminateReason = headless.getTerminateMode();
    const finalText = completedAfterWrite
      ? undefined
      : toModelVisibleSubagentResult(
          headless.getFinalText(),
          terminateReason,
        ) || undefined;
    const touched = [...filesTouched];
    const written = [...filesWritten];

    // The reject path above consults the abort identity; this one must too.
    // When the external cancel lands on a batch boundary agent-core RESOLVES
    // cancelled rather than throwing, so the catch never runs — and without
    // this gate the latched early completion converted that cancellation into
    // a successful GOAL result. The same user action then yielded opposite
    // outcomes depending only on which event-loop boundary the cancel hit.
    if (
      completedAfterWrite &&
      (!executionController.signal.aborted ||
        executionController.signal.reason === selfAbortReason)
    ) {
      return {
        status: 'completed',
        terminateReason: AgentTerminateMode.GOAL,
        finalText,
        filesTouched: touched,
        filesWritten: written,
      };
    }
    if (terminateReason === AgentTerminateMode.CANCELLED) {
      return {
        status: 'cancelled',
        terminateReason,
        finalText,
        filesTouched: touched,
        filesWritten: written,
      };
    }
    if (terminateReason !== AgentTerminateMode.GOAL) {
      return {
        status: 'failed',
        terminateReason,
        finalText,
        filesTouched: touched,
        filesWritten: written,
      };
    }
    return {
      status: 'completed',
      terminateReason,
      finalText,
      filesTouched: touched,
      filesWritten: written,
    };
  } finally {
    executionController.abort();
    // Release the per-fork ToolRegistry so AgentTool / SkillTool
    // instances dispose their change-listeners on shared
    // SubagentManager / SkillManager. Same shape as the spawn-path
    // finallys in `agent.ts` and `background-agent-resume.ts`.
    void yoloConfig
      .getToolRegistry()
      .stop()
      .catch(() => {});
    restoreParentPM();
  }
}
