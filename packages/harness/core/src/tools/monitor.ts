/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { MODEL_ONLY_HINTS } from '../codemode/types.js';
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  type ToolInvocation,
  type ToolResult,
} from './tools.js';
import type { Config } from '../config/config.js';
import type { ToolUseContext } from './tool-types.js';
import { MONITOR_TOOL_NAME } from './tool-names.js';
import {
  getCustomContextFromContext,
  snapshotCustomContext,
} from '../utils/sessionIdContext.js';
import {
  ShellExecutionService,
  type ShellExecutionHandle,
} from '../services/shellExecutionService.js';
import { ExecutionLifecycleService } from '../services/executionLifecycleService.js';
import { MonitorEventPipeline } from '../services/monitorEventPipeline.js';
import { buildMonitorEventNotificationXml } from '../services/taskNotification.js';
import { enqueuePendingNotification } from '../services/messageQueueManager.js';
import { createLocalBashTaskId } from '../tasks/task-id.js';
import { getCwd } from '../utils/Shell.js';
import { runLogger } from '../utils/runLogger.js';
import { isRemoteWorkerMode } from '../utils/headless.js';

export const MONITOR_DEFAULT_TIMEOUT_MS = 300_000;
export const MONITOR_MAX_TIMEOUT_MS = 3_600_000;
export const MONITOR_REMOTE_MAX_TIMEOUT_MS = 1_800_000;

export interface MonitorToolParams {
  command: string;
  description: string;
  timeout_ms?: number;
  persistent?: boolean;
}

export interface MonitorStartResult {
  taskId: string;
  timeoutMs: number;
  persistent: boolean;
}

const MONITOR_PARAMETER_SCHEMA = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    command: {
      type: 'string' as const,
      description:
        'Shell command or script. Each stdout line is an event; exit ends the watch.',
    },
    description: {
      type: 'string' as const,
      description:
        'Short human-readable description of what you are monitoring (shown in notifications).',
    },
    timeout_ms: {
      type: 'number' as const,
      minimum: 1_000,
      default: MONITOR_DEFAULT_TIMEOUT_MS,
      description:
        'Kill the monitor after this deadline. Ignored when persistent is true.',
    },
    persistent: {
      type: 'boolean' as const,
      default: false,
      description:
        'Run for the lifetime of the session. Stop with TaskStop.',
    },
  },
  required: ['command', 'description'] as const,
};

export function applyMonitorRemoteTimeoutCap(params: {
  timeout_ms: number;
  persistent: boolean;
}): { timeout_ms: number; persistent: boolean } {
  if (!isRemoteWorkerMode()) return params;
  return {
    timeout_ms: params.persistent
      ? MONITOR_REMOTE_MAX_TIMEOUT_MS
      : Math.min(params.timeout_ms, MONITOR_REMOTE_MAX_TIMEOUT_MS),
    persistent: false,
  };
}

class MonitorInvocation extends BaseToolInvocation<MonitorToolParams, ToolResult> {
  constructor(
    private readonly config: Config,
    params: MonitorToolParams,
    toolName?: string,
    toolDisplayName?: string,
  ) {
    super(params, toolName, toolDisplayName);
  }

  getDescription(): string {
    return this.params.description;
  }

  override executeWithContext(ctx: ToolUseContext): Promise<ToolResult> {
    return this.start(ctx);
  }

  async execute(signal: AbortSignal): Promise<ToolResult> {
    return this.start({
      signal,
      config: this.config,
      sessionId: this.config.getSessionId(),
    });
  }

  private async start(ctx: ToolUseContext): Promise<ToolResult> {
    const requestedTimeout = Math.min(
      Math.max(this.params.timeout_ms ?? MONITOR_DEFAULT_TIMEOUT_MS, 1_000),
      MONITOR_MAX_TIMEOUT_MS,
    );
    const effective = applyMonitorRemoteTimeoutCap({
      timeout_ms: requestedTimeout,
      persistent: this.params.persistent ?? false,
    });
    const sessionId = ctx.sessionId ?? this.config.getSessionId();
    const customContext = snapshotCustomContext(
      ctx.customContext ?? getCustomContextFromContext(),
    );
    const taskId = createLocalBashTaskId();
    const executionIdRef: { current?: number } = {};
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;

    const emitMonitorEvent = (event: string): void => {
      enqueuePendingNotification({
        prompt: buildMonitorEventNotificationXml({
          description: this.params.description,
          event,
          taskId,
        }),
        commandMode: 'task-notification',
        priority: 'next',
        targetAgentId: ctx.agentId,
        sessionId,
        ...(customContext !== undefined ? { customContext } : {}),
      });
    };

    const pipeline = new MonitorEventPipeline({
      emitEvent: emitMonitorEvent,
      emitHousekeeping: emitMonitorEvent,
      stopForOverload: () => {
        if (executionIdRef.current !== undefined) {
          void ExecutionLifecycleService.kill(executionIdRef.current).catch(
            () => {},
          );
        }
      },
    });

    let handle: ShellExecutionHandle;
    try {
      handle = await ShellExecutionService.execute(
        this.params.command,
        getCwd(),
        () => {},
        ctx.signal,
        {
          ...this.config.getShellExecutionConfig(),
          absoluteTimeout: 0,
          autoBackgroundOnTimeout: false,
          sessionId,
          pager: 'cat',
          sanitizationConfig: this.config.sanitizationConfig,
          sessionContext: this.config,
          originalCommand: this.params.command,
          preventCwdChanges: true,
          completionBehavior: 'notify',
          taskId,
          taskKind: 'monitor',
          taskDescription: this.params.description,
          ownerAgentId: ctx.agentId,
          toolUseId: ctx.callId,
          customContext,
          stdoutToFile: false,
          persistOutputToFile: true,
          onStdout: (chunk) => pipeline.onData(chunk),
        },
      );
    } catch (error) {
      pipeline.dispose();
      throw error;
    }
    const executionId = handle.pid;
    executionIdRef.current = executionId;
    if (executionId === undefined) {
      pipeline.close();
      const message = 'Monitor failed to start: shell process has no execution ID.';
      return {
        llmContent: message,
        returnDisplay: message,
        error: { message },
      };
    }

    ShellExecutionService.background(
      executionId,
      sessionId,
      this.params.command,
      'model',
      taskId,
      true,
    );
    this.config.taskRegistry?.update(`b-${taskId}`, {
      timeoutMs: effective.persistent ? 0 : effective.timeout_ms,
      persistent: effective.persistent,
    });

    if (!effective.persistent) {
      timeoutTimer = setTimeout(() => {
        emitMonitorEvent('[Monitor timed out — re-arm if needed.]');
        void ExecutionLifecycleService.kill(executionId).catch(() => {});
      }, effective.timeout_ms);
    }

    const finalizeMonitor = (): void => {
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = undefined;
      }
      pipeline.close();
    };
    // `handle.result` is the lifecycle promise: ShellExecutionService.background()
    // above resolves it immediately with `backgrounded: true`, long before the
    // watch process exits. Finalizing on that early resolution disposed the
    // event pipeline at startup, so no stdout event was ever delivered.
    // Finalize on the real process exit instead, and keep the handle-based
    // finalization only for executions that never reached the background.
    ShellExecutionService.onExit(executionId, finalizeMonitor);
    void handle.result.then((result) => {
      if (!result.backgrounded) {
        finalizeMonitor();
      }
    }, finalizeMonitor);

    const result: MonitorStartResult = {
      taskId,
      timeoutMs: effective.persistent ? 0 : effective.timeout_ms,
      persistent: effective.persistent,
    };
    runLogger.debug(
      `[Monitor] started taskId=${taskId}, executionId=${executionId}, persistent=${effective.persistent}, timeoutMs=${result.timeoutMs}`,
    );
    return {
      llmContent: `Monitor started (task ${result.taskId}, ${result.persistent ? 'persistent — runs until TaskStop or session end' : `timeout ${result.timeoutMs}ms`}). You will be notified on each event. Keep working — do not poll or sleep. Events may arrive while you are waiting for the user — an event is not their reply.`,
      returnDisplay: `Monitor started · task ${result.taskId} · ${result.persistent ? 'persistent' : `timeout ${result.timeoutMs / 1000}s`}`,
      toolUseResult: result,
      data: { ...result },
    };
  }
}

export class MonitorTool extends BaseDeclarativeTool<
  MonitorToolParams,
  ToolResult
> {
  override get exposureHints() {
    return MODEL_ONLY_HINTS;
  }
  static readonly Name = MONITOR_TOOL_NAME;

  constructor(private readonly config: Config) {
    super(
      MonitorTool.Name,
      MonitorTool.Name,
      'Run a background shell command as a live event monitor. Each complete stdout line becomes a notification. Use a selective, line-buffered command because high-rate output is limited and sustained overload stops the monitor.',
      Kind.Execute,
      MONITOR_PARAMETER_SCHEMA,
    );
  }

  override isConcurrencySafe(): boolean {
    return true;
  }

  override isDestructive(): boolean {
    return true;
  }

  protected override validateToolParamValues(
    params: MonitorToolParams,
  ): string | null {
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x08\x0b-\x1f\x7f-\x9f]/u.test(params.command)) {
      return 'command contains control characters that would be hidden in the approval dialog';
    }
    if (params.timeout_ms !== undefined && params.timeout_ms < 1_000) {
      return 'timeout_ms must be ≥ 1000';
    }
    if (
      params.persistent !== true &&
      params.timeout_ms !== undefined &&
      params.timeout_ms > MONITOR_MAX_TIMEOUT_MS
    ) {
      return `timeout_ms must be ≤ ${MONITOR_MAX_TIMEOUT_MS}`;
    }
    return null;
  }

  protected createInvocation(
    params: MonitorToolParams,
    toolName?: string,
    toolDisplayName?: string,
  ): ToolInvocation<MonitorToolParams, ToolResult> {
    return new MonitorInvocation(
      this.config,
      params,
      toolName,
      toolDisplayName,
    );
  }

  override toClassifierInput(input: MonitorToolParams): unknown {
    return input.command;
  }
}
