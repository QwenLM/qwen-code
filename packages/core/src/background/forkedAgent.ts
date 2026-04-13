/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Lightweight forked-agent execution primitive.
 *
 * Analogous to Claude Code's runForkedAgent(): a thin wrapper around
 * AgentHeadless that runs a single background agent task and returns the
 * outcome — no task registry, no scheduler, no drainer.
 *
 * Callers (extractScheduler, dreamScheduler) own all concurrency control
 * (deduplication, queue, lock). This primitive is purely responsible for
 * executing one agent run.
 *
 * Use runForkedAgent() when you need:
 *   - Tool access (read/write files, shell commands)
 *   - Multi-turn execution
 *   - Inheriting the runtime config (model, approval mode)
 *
 * Use runSideQuery() instead when:
 *   - No tool access is needed
 *   - Output must be structured JSON with schema validation
 *   - A single LLM call suffices
 */

import { ApprovalMode, type Config } from '../config/config.js';
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

export interface ForkedAgentParams {
  /** Unique name for this agent run (for logging and telemetry). */
  name: string;
  /** Runtime config. ApprovalMode is forced to YOLO internally. */
  config: Config;
  /** Task prompt sent as the initial user message. */
  taskPrompt: string;
  /** System prompt defining the agent's persona and constraints. */
  systemPrompt: string;
  /** Model override (defaults to config.getModel()). */
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
 * Run a single forked agent to completion and return the outcome.
 *
 * This is the lowest-level execution primitive for background agents in
 * Qwen Code. It directly wraps AgentHeadless.execute() with:
 *   - Forced YOLO approval mode (no user prompts)
 *   - File-path tracking via AgentEventEmitter TOOL_CALL events
 *   - Normalized status/terminateReason in the return value
 */
export async function runForkedAgent(
  params: ForkedAgentParams,
): Promise<ForkedAgentResult> {
  const yoloConfig = createYoloConfig(params.config);
  const filesTouched = new Set<string>();

  // Track file paths from all tool calls for the caller's use.
  const emitter = new AgentEventEmitter();
  emitter.on(AgentEventType.TOOL_CALL, (event) => {
    for (const filePath of extractFilePathsFromArgs(event.args)) {
      filesTouched.add(filePath);
    }
  });

  const promptConfig: PromptConfig = { systemPrompt: params.systemPrompt };
  const modelConfig: ModelConfig = {
    model: params.model ?? params.config.getModel(),
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
