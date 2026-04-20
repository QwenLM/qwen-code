/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';
import type { ToolResult, ToolResultDisplay } from './tools.js';
import { ToolDisplayNames, ToolNames } from './tool-names.js';
import type { Config } from '../config/config.js';
import {
  AgentHeadless,
  ContextState,
} from '../agents/runtime/agent-headless.js';
import { AgentTerminateMode } from '../agents/runtime/agent-types.js';
import type {
  PromptConfig,
  RunConfig,
  ToolConfig,
} from '../agents/runtime/agent-types.js';
import type { AgentStatsSummary } from '../agents/runtime/agent-statistics.js';
import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('SWARM');

const DEFAULT_MAX_TURNS = 8;
const DEFAULT_WORKER_NAME = 'swarm-worker';
const DEFAULT_WORKER_DISALLOWED_TOOLS: readonly string[] = [
  ToolNames.ASK_USER_QUESTION,
  ToolNames.AGENT,
  ToolNames.SKILL,
  ToolNames.SWARM,
];

const DEFAULT_WORKER_SYSTEM_PROMPT = `You are a lightweight swarm worker.
Execute exactly one assigned task independently and return only the requested result.
Do not ask follow-up questions, do not coordinate with other workers, and do not spawn sub-agents.
Keep the response concise and structured so the parent agent can aggregate it.`;

export interface SwarmTask {
  id?: string;
  description: string;
  prompt: string;
}

export interface SwarmParams {
  description: string;
  tasks: SwarmTask[];
  mode?: 'wait_all' | 'first_success';
  max_concurrency?: number;
  max_turns?: number;
  timeout_seconds?: number;
  worker_system_prompt?: string;
  allowed_tools?: string[];
  disallowed_tools?: string[];
}

interface SwarmWorkerResult {
  taskId: string;
  description: string;
  status: 'success' | 'failed' | 'cancelled' | 'not_started';
  output?: string;
  error?: string;
  terminateReason?: string;
  durationMs?: number;
  stats?: AgentStatsSummary;
}

interface SwarmSummary {
  total: number;
  completed: number;
  failed: number;
  cancelled: number;
  notStarted: number;
}

interface SwarmAggregateResult {
  description: string;
  mode: 'wait_all' | 'first_success';
  maxConcurrency: number;
  summary: SwarmSummary;
  results: SwarmWorkerResult[];
}

/**
 * Swarm tool for ephemeral parallel map-style worker execution.
 */
export class SwarmTool extends BaseDeclarativeTool<SwarmParams, ToolResult> {
  static readonly Name: string = ToolNames.SWARM;

  constructor(private readonly config: Config) {
    super(
      SwarmTool.Name,
      ToolDisplayNames.SWARM,
      `Spawn a dynamic swarm of lightweight workers for independent batch tasks.

Use this for map-reduce style work where many simple tasks can run independently,
such as analyzing files, scanning chunks of data, or trying independent searches.
The tool creates ephemeral workers at runtime, runs them with bounded concurrency,
and returns structured per-task results for aggregation.

Do not use this for tasks that require worker-to-worker communication or tightly
coupled edits to the same files. For a few complex role-based tasks, use the
${ToolNames.AGENT} tool instead.`,
      Kind.Other,
      {
        type: 'object',
        properties: {
          description: {
            type: 'string',
            description: 'A short description of the overall swarm job.',
          },
          tasks: {
            type: 'array',
            description:
              'Independent tasks to execute. Each task becomes one ephemeral worker.',
            minItems: 1,
            items: {
              type: 'object',
              properties: {
                id: {
                  type: 'string',
                  description:
                    'Optional stable task identifier used in aggregated results.',
                },
                description: {
                  type: 'string',
                  description:
                    'Short per-worker description for progress and result labels.',
                },
                prompt: {
                  type: 'string',
                  description:
                    'Complete instructions for this worker. Include all task-specific context.',
                },
              },
              required: ['description', 'prompt'],
              additionalProperties: false,
            },
          },
          mode: {
            type: 'string',
            enum: ['wait_all', 'first_success'],
            description:
              'wait_all runs every task and returns all results. first_success returns after the first successful worker and cancels the rest.',
          },
          max_concurrency: {
            type: 'number',
            description:
              'Maximum number of workers to run at once. Defaults to QWEN_CODE_MAX_SWARM_CONCURRENCY, QWEN_CODE_MAX_TOOL_CONCURRENCY, or 10.',
          },
          max_turns: {
            type: 'number',
            description:
              'Maximum model/tool turns per worker. Defaults to 8 for lightweight execution.',
          },
          timeout_seconds: {
            type: 'number',
            description:
              'Optional wall-clock timeout per worker in seconds. Timed-out workers are cancelled and reported as failures.',
          },
          worker_system_prompt: {
            type: 'string',
            description:
              'Optional system prompt shared by all workers. Defaults to a concise one-task worker prompt.',
          },
          allowed_tools: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Optional allowlist of tool names available to workers. Defaults to all non-recursive tools.',
          },
          disallowed_tools: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Optional blocklist of tool names removed from the worker tool pool.',
          },
        },
        required: ['description', 'tasks'],
        additionalProperties: false,
        $schema: 'http://json-schema.org/draft-07/schema#',
      },
      true,
      true,
    );
  }

  override validateToolParams(params: SwarmParams): string | null {
    if (
      !params.description ||
      typeof params.description !== 'string' ||
      params.description.trim() === ''
    ) {
      return 'Parameter "description" must be a non-empty string.';
    }

    if (!Array.isArray(params.tasks) || params.tasks.length === 0) {
      return 'Parameter "tasks" must be a non-empty array.';
    }

    for (const [index, task] of params.tasks.entries()) {
      if (!task || typeof task !== 'object') {
        return `Task at index ${index} must be an object.`;
      }
      if (
        !task.description ||
        typeof task.description !== 'string' ||
        task.description.trim() === ''
      ) {
        return `Task at index ${index} must include a non-empty "description".`;
      }
      if (
        !task.prompt ||
        typeof task.prompt !== 'string' ||
        task.prompt.trim() === ''
      ) {
        return `Task at index ${index} must include a non-empty "prompt".`;
      }
      if (task.id !== undefined && typeof task.id !== 'string') {
        return `Task at index ${index} has invalid "id"; it must be a string.`;
      }
    }

    if (
      params.mode !== undefined &&
      params.mode !== 'wait_all' &&
      params.mode !== 'first_success'
    ) {
      return 'Parameter "mode" must be "wait_all" or "first_success".';
    }

    const numericChecks: Array<[keyof SwarmParams, number | undefined]> = [
      ['max_concurrency', params.max_concurrency],
      ['max_turns', params.max_turns],
      ['timeout_seconds', params.timeout_seconds],
    ];

    for (const [name, value] of numericChecks) {
      if (value === undefined) continue;
      if (!Number.isInteger(value) || value < 1) {
        return `Parameter "${name}" must be a positive integer.`;
      }
    }

    if (
      params.worker_system_prompt !== undefined &&
      (typeof params.worker_system_prompt !== 'string' ||
        params.worker_system_prompt.trim() === '')
    ) {
      return 'Parameter "worker_system_prompt" must be a non-empty string when provided.';
    }

    if (
      params.allowed_tools !== undefined &&
      !this.isStringArray(params.allowed_tools)
    ) {
      return 'Parameter "allowed_tools" must be an array of strings.';
    }

    if (
      params.disallowed_tools !== undefined &&
      !this.isStringArray(params.disallowed_tools)
    ) {
      return 'Parameter "disallowed_tools" must be an array of strings.';
    }

    return null;
  }

  protected createInvocation(params: SwarmParams) {
    return new SwarmToolInvocation(this.config, params);
  }

  private isStringArray(value: unknown): value is string[] {
    return (
      Array.isArray(value) &&
      value.every((item) => typeof item === 'string' && item.trim() !== '')
    );
  }
}

class SwarmToolInvocation extends BaseToolInvocation<SwarmParams, ToolResult> {
  private readonly mode = this.params.mode ?? 'wait_all';

  constructor(
    private readonly config: Config,
    params: SwarmParams,
  ) {
    super(params);
  }

  getDescription(): string {
    return `${this.params.description} (${this.params.tasks.length} workers)`;
  }

  async execute(
    signal?: AbortSignal,
    updateOutput?: (output: ToolResultDisplay) => void,
  ): Promise<ToolResult> {
    const maxConcurrency = Math.min(
      this.params.tasks.length,
      this.params.max_concurrency ?? getDefaultMaxConcurrency(),
    );
    const results = new Array<SwarmWorkerResult | undefined>(
      this.params.tasks.length,
    );

    updateOutput?.(
      formatProgress(
        this.params.description,
        results,
        this.params.tasks.length,
      ),
    );

    if (this.mode === 'first_success') {
      await this.runFirstSuccess(results, maxConcurrency, signal, updateOutput);
    } else {
      await this.runWaitAll(results, maxConcurrency, signal, updateOutput);
    }

    for (const [index, task] of this.params.tasks.entries()) {
      results[index] ??= {
        taskId: getTaskId(task, index),
        description: task.description,
        status: 'not_started',
      };
    }

    const aggregate = buildAggregateResult(
      this.params.description,
      this.mode,
      maxConcurrency,
      results as SwarmWorkerResult[],
    );

    return {
      llmContent: [{ text: JSON.stringify(aggregate, null, 2) }],
      returnDisplay: formatAggregateDisplay(aggregate),
    };
  }

  private async runWaitAll(
    results: Array<SwarmWorkerResult | undefined>,
    maxConcurrency: number,
    signal?: AbortSignal,
    updateOutput?: (output: ToolResultDisplay) => void,
  ): Promise<void> {
    let nextIndex = 0;

    const workerLoop = async () => {
      while (!signal?.aborted) {
        const index = nextIndex++;
        if (index >= this.params.tasks.length) return;
        results[index] = await this.executeTask(index, signal);
        updateOutput?.(
          formatProgress(
            this.params.description,
            results,
            this.params.tasks.length,
          ),
        );
      }
    };

    await Promise.all(
      Array.from({ length: maxConcurrency }, () => workerLoop()),
    );
  }

  private async runFirstSuccess(
    results: Array<SwarmWorkerResult | undefined>,
    maxConcurrency: number,
    signal?: AbortSignal,
    updateOutput?: (output: ToolResultDisplay) => void,
  ): Promise<void> {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });

    let nextIndex = 0;
    let shouldStopLaunching = false;

    const workerLoop = async () => {
      while (!signal?.aborted && !controller.signal.aborted) {
        if (shouldStopLaunching) return;
        const index = nextIndex++;
        if (index >= this.params.tasks.length) return;

        const result = await this.executeTask(index, controller.signal);
        results[index] = result;
        updateOutput?.(
          formatProgress(
            this.params.description,
            results,
            this.params.tasks.length,
          ),
        );

        if (result.status === 'success') {
          shouldStopLaunching = true;
          controller.abort();
          return;
        }
      }
    };

    try {
      await Promise.all(
        Array.from({ length: maxConcurrency }, () => workerLoop()),
      );
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

  private async executeTask(
    index: number,
    signal?: AbortSignal,
  ): Promise<SwarmWorkerResult> {
    const task = this.params.tasks[index]!;
    const taskId = getTaskId(task, index);
    const startTime = Date.now();
    const timeoutController = new AbortController();
    const onAbort = () => timeoutController.abort();
    signal?.addEventListener('abort', onAbort, { once: true });

    let timeoutHandle: NodeJS.Timeout | undefined;
    let timedOut = false;
    if (this.params.timeout_seconds) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        timeoutController.abort();
      }, this.params.timeout_seconds * 1000);
    }

    try {
      if (signal?.aborted) {
        return {
          taskId,
          description: task.description,
          status: 'cancelled',
          error: 'Worker was cancelled before it started.',
          durationMs: Date.now() - startTime,
        };
      }

      const subagent = await AgentHeadless.create(
        DEFAULT_WORKER_NAME,
        this.createWorkerConfig(),
        this.createPromptConfig(),
        {},
        this.createRunConfig(),
        this.createToolConfig(),
      );

      const contextState = new ContextState();
      contextState.set('task_prompt', buildTaskPrompt(task, taskId));
      await subagent.execute(contextState, timeoutController.signal);

      const terminateMode = subagent.getTerminateMode();
      const finalText = subagent.getFinalText();
      const stats = subagent.getExecutionSummary();
      const wasSuccessful = terminateMode === AgentTerminateMode.GOAL;

      return {
        taskId,
        description: task.description,
        status: wasSuccessful ? 'success' : 'failed',
        ...(finalText
          ? wasSuccessful
            ? { output: finalText }
            : { error: finalText }
          : {}),
        terminateReason: terminateMode,
        durationMs: Date.now() - startTime,
        stats,
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error ?? 'Unknown');
      debugLogger.warn(`Swarm worker ${taskId} failed: ${message}`);
      return {
        taskId,
        description: task.description,
        status:
          timedOut || timeoutController.signal.aborted ? 'cancelled' : 'failed',
        error: timedOut
          ? `Worker timed out after ${this.params.timeout_seconds} seconds.`
          : message,
        durationMs: Date.now() - startTime,
      };
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      signal?.removeEventListener('abort', onAbort);
    }
  }

  private createWorkerConfig(): Config {
    // Swarm workers run concurrently, so interactive prompts cannot be safely
    // surfaced one-by-one. Permission hooks may still allow specific actions.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const workerConfig = Object.create(this.config) as any;
    workerConfig.getShouldAvoidPermissionPrompts = () => true;
    return workerConfig as Config;
  }

  private createPromptConfig(): PromptConfig {
    return {
      systemPrompt:
        this.params.worker_system_prompt ?? DEFAULT_WORKER_SYSTEM_PROMPT,
    };
  }

  private createRunConfig(): RunConfig {
    return {
      max_turns: this.params.max_turns ?? DEFAULT_MAX_TURNS,
    };
  }

  private createToolConfig(): ToolConfig {
    const disallowedTools = Array.from(
      new Set([
        ...DEFAULT_WORKER_DISALLOWED_TOOLS,
        ...(this.params.disallowed_tools ?? []),
      ]),
    );

    return {
      tools:
        this.params.allowed_tools && this.params.allowed_tools.length > 0
          ? this.params.allowed_tools
          : ['*'],
      disallowedTools,
    };
  }
}

function getDefaultMaxConcurrency(): number {
  const parsed = parseInt(
    process.env['QWEN_CODE_MAX_SWARM_CONCURRENCY'] ||
      process.env['QWEN_CODE_MAX_TOOL_CONCURRENCY'] ||
      '',
    10,
  );
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : 10;
}

function getTaskId(task: SwarmTask, index: number): string {
  return task.id?.trim() || `task-${index + 1}`;
}

function buildTaskPrompt(task: SwarmTask, taskId: string): string {
  return `Swarm task id: ${taskId}
Swarm task description: ${task.description}

${task.prompt}

Return only the result for this task.`;
}

function buildAggregateResult(
  description: string,
  mode: 'wait_all' | 'first_success',
  maxConcurrency: number,
  results: SwarmWorkerResult[],
): SwarmAggregateResult {
  const summary: SwarmSummary = {
    total: results.length,
    completed: results.filter((r) => r.status === 'success').length,
    failed: results.filter((r) => r.status === 'failed').length,
    cancelled: results.filter((r) => r.status === 'cancelled').length,
    notStarted: results.filter((r) => r.status === 'not_started').length,
  };

  return {
    description,
    mode,
    maxConcurrency,
    summary,
    results,
  };
}

function formatProgress(
  description: string,
  results: Array<SwarmWorkerResult | undefined>,
  total: number,
): string {
  const settled = results.filter(Boolean) as SwarmWorkerResult[];
  const completed = settled.filter((r) => r.status === 'success').length;
  const failed = settled.filter((r) => r.status === 'failed').length;
  const cancelled = settled.filter((r) => r.status === 'cancelled').length;
  const finished = completed + failed + cancelled;
  return `Swarm "${description}": ${finished}/${total} settled (${completed} succeeded, ${failed} failed, ${cancelled} cancelled).`;
}

function formatAggregateDisplay(result: SwarmAggregateResult): string {
  const lines = [
    `### Swarm Complete`,
    ``,
    `**Task**: ${result.description}`,
    `**Mode**: ${result.mode}`,
    `**Max concurrency**: ${result.maxConcurrency}`,
    ``,
    `| Status | Count |`,
    `| --- | ---: |`,
    `| Success | ${result.summary.completed} |`,
    `| Failed | ${result.summary.failed} |`,
    `| Cancelled | ${result.summary.cancelled} |`,
    `| Not started | ${result.summary.notStarted} |`,
    ``,
    `| Task | Status | Result |`,
    `| --- | --- | --- |`,
  ];

  for (const workerResult of result.results) {
    lines.push(
      `| ${escapeMarkdownTableCell(workerResult.taskId)} | ${workerResult.status} | ${escapeMarkdownTableCell(
        summarizeWorkerResult(workerResult),
      )} |`,
    );
  }

  return lines.join('\n');
}

function summarizeWorkerResult(result: SwarmWorkerResult): string {
  const value = result.output ?? result.error ?? result.terminateReason ?? '';
  if (value.length <= 160) return value;
  return `${value.slice(0, 157)}...`;
}

function escapeMarkdownTableCell(value: string): string {
  return value.replace(/\|/g, '&#124;').replace(/\r?\n/g, '<br>');
}
