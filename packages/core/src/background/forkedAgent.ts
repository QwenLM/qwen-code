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
 *   WITH cacheSafeParams  → GeminiChat single-turn, NO tools, shares parent
 *                            prompt cache (systemInstruction + history).
 *                            Use for: /btw, suggestions, pipelined suggestions.
 *
 *   WITHOUT cacheSafeParams → AgentHeadless multi-turn, full tool access,
 *                              isolated session (no shared history).
 *                              Use for: memory extract, dream consolidation.
 *
 * Tool-deny for forked queries is enforced at the per-request level (NO_TOOLS).
 *
 * Callers (extractScheduler, dreamScheduler) own concurrency control.
 * runSideQuery() remains a separate primitive for structured-JSON calls that
 * need no conversation history at all (recall, forget, governance).
 */

import type {
  Content,
  GenerateContentConfig,
  GenerateContentResponseUsageMetadata,
} from '@google/genai';
import { ApprovalMode, type Config } from '../config/config.js';
import { GeminiChat, StreamEventType } from '../core/geminiChat.js';
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
} from '../agents/index.js';

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
  /** Curated conversation history (deep clone) */
  history: Content[];
  /** Model identifier */
  model: string;
  /** Version number — increments when systemInstruction or tools change */
  version: number;
}

// Module-level slot written after each successful main turn.
let currentCacheSafeParams: CacheSafeParams | null = null;
let currentVersion = 0;

/**
 * Save cache-safe params after a successful main conversation turn.
 * Called from GeminiClient.sendMessageStream() on successful completion.
 */
export function saveCacheSafeParams(
  generationConfig: GenerateContentConfig,
  history: Content[],
  model: string,
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
    history,
    model,
    version: currentVersion,
  };
}

/**
 * Get the current cache-safe params, or null if not yet captured.
 */
export function getCacheSafeParams(): CacheSafeParams | null {
  return currentCacheSafeParams
    ? structuredClone(currentCacheSafeParams)
    : null;
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

/** Per-request config that strips tools so the model never produces function calls. */
const NO_TOOLS = Object.freeze({ tools: [] as const }) as Pick<
  GenerateContentConfig,
  'tools'
>;

/**
 * Create an isolated GeminiChat that shares the main conversation's
 * generationConfig (including systemInstruction, tools, and history).
 *
 * Used by runForkedAgent (cache path) and directly by speculation.ts which
 * needs its own multi-turn tool-execution loop with OverlayFs interception.
 */
export function createForkedChat(
  config: Config,
  params: CacheSafeParams,
): GeminiChat {
  const maxHistoryEntries = 40;
  const history =
    params.history.length > maxHistoryEntries
      ? params.history.slice(-maxHistoryEntries)
      : params.history;

  return new GeminiChat(
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
}

// ---------------------------------------------------------------------------
// ForkedQueryResult — returned by cache-path runForkedAgent
// ---------------------------------------------------------------------------

/**
 * Result from a cache-path runForkedAgent (with cacheSafeParams).
 * Single-turn, text-only — tools are denied.
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

/** Cache path: single-turn, tool-free, shares parent prompt cache. */
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
  /** Model override (defaults to config.getFastModel() ?? config.getModel()). */
  model?: string;
  /** Sampling temperature (default: 0 for deterministic output). */
  temp?: number;
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
  /** External cancellation signal. */
  abortSignal?: AbortSignal;
}

export interface ForkedAgentResult {
  status: 'completed' | 'failed' | 'cancelled';
  /** Final text output from the agent's last response. */
  finalText?: string;
  /** AgentTerminateMode string explaining why the agent stopped. */
  terminateReason?: string;
  /** File paths observed in Write/Edit tool calls during execution. */
  filesTouched: string[];
}

/**
 * Returns a shallow clone of config with ApprovalMode forced to YOLO.
 * Background agents must never block on permission prompts — there is
 * no user present to answer them.
 */
function createYoloConfig(config: Config): Config {
  const yoloConfig = Object.create(config) as Config;
  yoloConfig.getApprovalMode = () => ApprovalMode.YOLO;
  return yoloConfig;
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

/**
 * Unified forked-agent execution primitive.
 *
 * Two overloads selected by the shape of `params`:
 *
 *   params.cacheSafeParams present  → cache path (ForkedQueryResult)
 *     Single-turn, NO tools, shares parent prompt cache.
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
    const { config, userMessage, cacheSafeParams, jsonSchema, abortSignal } =
      params;
    const model = params.model ?? cacheSafeParams.model;
    const chat = createForkedChat(config, cacheSafeParams);

    const requestConfig: GenerateContentConfig = { ...NO_TOOLS };
    if (abortSignal) requestConfig.abortSignal = abortSignal;
    if (jsonSchema) {
      requestConfig.responseMimeType = 'application/json';
      requestConfig.responseJsonSchema = jsonSchema;
    }

    const stream = await chat.sendMessageStream(
      model,
      { message: [{ text: userMessage }], config: requestConfig },
      'forked_query',
    );

    let fullText = '';
    let usage: ForkedQueryResult['usage'] = {
      inputTokens: 0,
      outputTokens: 0,
      cacheHitTokens: 0,
    };

    for await (const event of stream) {
      if (event.type !== StreamEventType.CHUNK) continue;
      const response = event.value;
      const text = response.candidates?.[0]?.content?.parts
        ?.filter((p) => !(p as Record<string, unknown>)['thought'])
        .map((p) => p.text ?? '')
        .join('');
      if (text) fullText += text;
      if (response.usageMetadata)
        usage = extractQueryUsage(response.usageMetadata);
    }

    const trimmed = fullText.trim() || null;
    let jsonResult: Record<string, unknown> | undefined;
    if (jsonSchema && trimmed) {
      try {
        jsonResult = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        // non-JSON response despite schema constraint — treat as text
      }
    }

    return { text: trimmed, jsonResult, usage };
  }

  // ── AgentHeadless path ────────────────────────────────────────────────────
  const yoloConfig = createYoloConfig(params.config);
  const filesTouched = new Set<string>();

  const emitter = new AgentEventEmitter();
  emitter.on(AgentEventType.TOOL_CALL, (event) => {
    for (const filePath of extractFilePathsFromArgs(event.args)) {
      filesTouched.add(filePath);
    }
  });

  const promptConfig: PromptConfig = { systemPrompt: params.systemPrompt };
  const modelConfig: ModelConfig = {
    model:
      params.model ?? params.config.getFastModel() ?? params.config.getModel(),
    temp: params.temp ?? 0,
  };
  const runConfig: RunConfig = {
    max_turns: params.maxTurns,
    max_time_minutes: params.maxTimeMinutes,
  };
  const toolConfig: ToolConfig | undefined =
    params.tools !== undefined ? { tools: params.tools } : undefined;

  const headless = await AgentHeadless.create(
    params.name,
    yoloConfig,
    promptConfig,
    modelConfig,
    runConfig,
    toolConfig,
    emitter,
  );

  const context = new ContextState();
  context.set('task_prompt', params.taskPrompt);
  await headless.execute(context, params.abortSignal);

  const terminateReason = headless.getTerminateMode();
  const finalText = headless.getFinalText() || undefined;
  const touched = [...filesTouched];

  if (terminateReason === AgentTerminateMode.CANCELLED) {
    return {
      status: 'cancelled',
      terminateReason,
      finalText,
      filesTouched: touched,
    };
  }
  if (
    terminateReason === AgentTerminateMode.ERROR ||
    terminateReason === AgentTerminateMode.TIMEOUT
  ) {
    return {
      status: 'failed',
      terminateReason,
      finalText,
      filesTouched: touched,
    };
  }
  return {
    status: 'completed',
    terminateReason,
    finalText,
    filesTouched: touched,
  };
}
