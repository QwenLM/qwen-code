/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
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
import { BackgroundTaskDrainer } from './taskDrainer.js';
import {
  BackgroundTaskRegistry,
  type BackgroundTaskState,
} from './taskRegistry.js';
import { BackgroundTaskScheduler } from './taskScheduler.js';

export interface BackgroundAgentTaskRequest {
  taskType: string;
  title: string;
  description: string;
  projectRoot: string;
  sessionId?: string;
  dedupeKey?: string;
  name: string;
  runtimeContext: Config;
  taskPrompt: string;
  promptConfig: PromptConfig;
  modelConfig: ModelConfig;
  runConfig: RunConfig;
  toolConfig?: ToolConfig;
  metadata?: Record<string, unknown>;
  abortSignal?: AbortSignal;
}

export interface BackgroundAgentResult {
  taskId: string;
  status: 'completed' | 'failed' | 'cancelled';
  finalText?: string;
  terminateReason?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  roundCount?: number;
  filesTouched: string[];
  error?: string;
}

type AgentHeadlessLike = Pick<
  AgentHeadless,
  'execute' | 'getTerminateMode' | 'getFinalText'
>;

type CreateAgentHeadlessFn = (
  name: string,
  runtimeContext: Config,
  promptConfig: PromptConfig,
  modelConfig: ModelConfig,
  runConfig: RunConfig,
  toolConfig?: ToolConfig,
  eventEmitter?: AgentEventEmitter,
) => Promise<AgentHeadlessLike>;

function createBackgroundConfig(config: Config): Config {
  const backgroundConfig = Object.create(config) as Config;
  backgroundConfig.getApprovalMode = () => ApprovalMode.YOLO;
  return backgroundConfig;
}

export class BackgroundAgentRunner {
  readonly registry: BackgroundTaskRegistry;
  readonly drainer: BackgroundTaskDrainer;
  readonly scheduler: BackgroundTaskScheduler;

  constructor(
    registry = new BackgroundTaskRegistry(),
    drainer = new BackgroundTaskDrainer(),
    scheduler = new BackgroundTaskScheduler(registry, drainer),
    private readonly createAgentHeadless: CreateAgentHeadlessFn =
      AgentHeadless.create,
  ) {
    this.registry = registry;
    this.drainer = drainer;
    this.scheduler = scheduler;
  }

  async run(
    request: BackgroundAgentTaskRequest,
  ): Promise<BackgroundAgentResult> {
    const usage: BackgroundAgentResult['usage'] = {};
    const filesTouched = new Set<string>();
    let roundCount = 0;
    const scheduled = this.scheduler.schedule({
      taskType: request.taskType,
      title: request.title,
      projectRoot: request.projectRoot,
      sessionId: request.sessionId,
      dedupeKey: request.dedupeKey,
      metadata: {
        ...(request.metadata ?? {}),
        budget: {
          maxTurns: request.runConfig.max_turns,
          maxTimeMinutes: request.runConfig.max_time_minutes,
        },
        allowedTools: request.toolConfig?.tools?.map((tool) =>
          typeof tool === 'string' ? tool : tool.name,
        ) ?? ['*'],
      },
      run: async (task) => {
        const emitter = new AgentEventEmitter();
        this.bindTaskEvents(task.id, emitter, usage, filesTouched, (nextRound) => {
          roundCount = Math.max(roundCount, nextRound);
        });

        // Background agents must never block on permission prompts — there is
        // no user present to answer them. Wrap the config to force YOLO mode
        // so any tool call that would return 'ask' is auto-approved instead of
        // hanging the process indefinitely. This mirrors Claude Code's
        // shouldAvoidPermissionPrompts: true pattern in createSubagentContext().
        // Safety boundary: toolConfig.tools already restricts the model to the
        // declared tool set; prompt instructions constrain intended paths.
        const backgroundConfig = createBackgroundConfig(request.runtimeContext);

        const headless = await this.createAgentHeadless(
          request.name,
          backgroundConfig,
          request.promptConfig,
          request.modelConfig,
          request.runConfig,
          request.toolConfig,
          emitter,
        );

        const context = new ContextState();
        context.set('task_prompt', request.taskPrompt);
        await headless.execute(context, request.abortSignal);

        const terminateReason = headless.getTerminateMode();
        if (
          terminateReason === AgentTerminateMode.ERROR ||
          terminateReason === AgentTerminateMode.TIMEOUT
        ) {
          throw new Error(`Background agent terminated with ${terminateReason}`);
        }

        if (terminateReason === AgentTerminateMode.CANCELLED) {
          return {
            status: 'cancelled',
            progressText: 'Background agent cancelled.',
            error: 'Background agent terminated with CANCELLED',
            metadata: {
              finalText: headless.getFinalText(),
              terminateReason,
              usage,
              roundCount,
              filesTouched: [...filesTouched],
            },
          };
        }

        return {
          progressText: headless.getFinalText() || request.description,
          metadata: {
            finalText: headless.getFinalText(),
            terminateReason,
            usage,
            roundCount,
            filesTouched: [...filesTouched],
          },
        };
      },
    });

    const finalTask = await scheduled.promise;
    return this.buildResult(scheduled.taskId, finalTask);
  }

  private bindTaskEvents(
    taskId: string,
    emitter: AgentEventEmitter,
    usage: NonNullable<BackgroundAgentResult['usage']>,
    filesTouched: Set<string>,
    onRound: (round: number) => void,
  ): void {
    emitter.on(AgentEventType.ROUND_START, (event) => {
      onRound(event.round);
      this.registry.update(taskId, {
        metadata: {
          currentRound: event.round,
        },
      });
    });

    emitter.on(AgentEventType.STREAM_TEXT, (event) => {
      if (!event.thought && event.text.trim().length > 0) {
        this.registry.update(taskId, {
          progressText: event.text,
        });
      }
    });

    emitter.on(AgentEventType.TOOL_CALL, (event) => {
      onRound(event.round);
      for (const filePath of extractFilePathsFromArgs(event.args)) {
        filesTouched.add(filePath);
      }
      this.registry.update(taskId, {
        metadata: {
          currentRound: event.round,
          lastToolCall: event.name,
          filesTouched: [...filesTouched],
        },
      });
    });

    emitter.on(AgentEventType.USAGE_METADATA, (event) => {
      usage.inputTokens = event.usage.promptTokenCount;
      usage.outputTokens = event.usage.candidatesTokenCount;
      usage.totalTokens = event.usage.totalTokenCount;
      this.registry.update(taskId, {
        metadata: {
          usage,
        },
      });
    });
  }

  private buildResult(
    taskId: string,
    finalTask: BackgroundTaskState,
  ): BackgroundAgentResult {
    const metadata = finalTask.metadata ?? {};
    const finalText = metadata['finalText'];
    const terminateReason = metadata['terminateReason'];
    const usage = metadata['usage'];
    const filesTouched = metadata['filesTouched'];
    const roundCount = metadata['roundCount'];

    return {
      taskId,
      status:
        finalTask.status === 'completed'
          ? 'completed'
          : finalTask.status === 'cancelled'
            ? 'cancelled'
            : 'failed',
      finalText: typeof finalText === 'string' ? finalText : undefined,
      terminateReason:
        typeof terminateReason === 'string' ? terminateReason : undefined,
      usage:
        usage && typeof usage === 'object'
          ? (usage as BackgroundAgentResult['usage'])
          : undefined,
      roundCount: typeof roundCount === 'number' ? roundCount : undefined,
      filesTouched: Array.isArray(filesTouched) ? (filesTouched as string[]) : [],
      error: finalTask.error,
    };
  }
}

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
      for (const item of value) {
        visit(item, key);
      }
      return;
    }

    if (value && typeof value === 'object') {
      for (const [nextKey, nextValue] of Object.entries(value as Record<string, unknown>)) {
        visit(nextValue, nextKey);
      }
    }
  };

  visit(args);
  return [...matches];
}
