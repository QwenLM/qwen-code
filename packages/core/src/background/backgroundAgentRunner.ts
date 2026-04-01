/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
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
  status: 'completed' | 'failed';
  finalText?: string;
  terminateReason?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
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
    const scheduled = this.scheduler.schedule({
      taskType: request.taskType,
      title: request.title,
      projectRoot: request.projectRoot,
      sessionId: request.sessionId,
      dedupeKey: request.dedupeKey,
      metadata: request.metadata,
      run: async (task) => {
        const emitter = new AgentEventEmitter();
        this.bindTaskEvents(task.id, emitter, usage);

        const headless = await this.createAgentHeadless(
          request.name,
          request.runtimeContext,
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
          terminateReason === AgentTerminateMode.CANCELLED ||
          terminateReason === AgentTerminateMode.TIMEOUT
        ) {
          throw new Error(`Background agent terminated with ${terminateReason}`);
        }

        return {
          progressText: headless.getFinalText() || request.description,
          metadata: {
            finalText: headless.getFinalText(),
            terminateReason,
            usage,
            filesTouched: [],
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
  ): void {
    emitter.on(AgentEventType.STREAM_TEXT, (event) => {
      if (!event.thought && event.text.trim().length > 0) {
        this.registry.update(taskId, {
          progressText: event.text,
        });
      }
    });

    emitter.on(AgentEventType.TOOL_CALL, (event) => {
      this.registry.update(taskId, {
        metadata: {
          lastToolCall: event.name,
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

    return {
      taskId,
      status: finalTask.status === 'completed' ? 'completed' : 'failed',
      finalText: typeof finalText === 'string' ? finalText : undefined,
      terminateReason:
        typeof terminateReason === 'string' ? terminateReason : undefined,
      usage:
        usage && typeof usage === 'object'
          ? (usage as BackgroundAgentResult['usage'])
          : undefined,
      filesTouched: Array.isArray(filesTouched) ? (filesTouched as string[]) : [],
      error: finalTask.error,
    };
  }
}
