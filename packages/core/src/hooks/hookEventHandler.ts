/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  getCustomContextFromContext,
  snapshotCustomContext,
} from '../utils/sessionIdContext.js';
import { getCwd } from '../utils/Shell.js';
import type { HookPlanner, HookEventContext } from './hookPlanner.js';
import type { HookRunner } from './hookRunner.js';
import {
  validatePreparedImages,
  type ImagePrepareRequest,
  type ImagePrepareInput,
} from './imagePrepare.js';
import { EXIT_CODE_BLOCK } from './hookRunner.js';
import {
  clearCwdEnvFiles,
  cleanupSessionEnvDir,
} from './sessionEnvironment.js';
import {
  buildPreToolUseDenyResult,
  type HookAggregator,
  type AggregatedHookResult,
} from './hookAggregator.js';
import type { HookRegistry } from './hookRegistry.js';
import { hookResultsToAttachments } from './hookAttachmentHelpers.js';
import {
  HookType,
  HookEventName,
  getHookDisplayText,
  getHookIdentity,
  getHookPluginAttribution,
  isUserVisibleHook,
  type HookConfig,
  type CommandHookConfig,
  type HookInput,
  type PreToolUseInput,
  type PostToolUseInput,
  type PostToolUseFailureInput,
  type SubagentStartInput,
  type NotificationInput,
  type SubagentStopInput,
  type SessionStartInput,
  type SessionEndInput,
  type SetupInput,
  type SetupTrigger,
  type PreCompactInput,
  type PostCompactInput,
  type StopInput,
  type QueryEndInput,
  type QueryEndReason,
  type UserPromptSubmitInput,
  type ConfigChangeInput,
  type ConfigChangeSource,
  type NotificationType,
  type SessionStartSource,
  type SessionEndReason,
  type PreCompactTrigger,
  type HookExecutionResult,
  type McpToolContext,
  type StopFailureInput,
  type TeammateIdleInput,
  type InstructionsLoadedInput,
  type InstructionsLoadReason,
  type CwdChangedInput,
  type FileChangedInput,
  type FileChangeEventType,
  type WorktreeCreateInput,
  type WorktreeRemoveInput,
  type ElicitationInput,
  type ElicitationResultInput,
  type ElicitationAction,
  type TaskCreatedInput,
  type TaskCompletedInput,
  type PermissionRequestInput,
  type PermissionSuggestion,
  type PermissionDeniedInput,
  type StopFailureErrorType,
  type StopFailureOptions,
} from './types.js';


import { runLogger } from '../utils/runLogger.js';
import { coreEvents, CoreEvent } from '../utils/events.js';
import {
  emitHookFinished,
  emitHookStarted,
} from '../utils/diagnosticInterceptors.js';
import type { AgentLoopContext } from '../config/agent-loop-context.js';
import { getAgentContext } from '../utils/agentContext.js';
import { enqueuePendingNotification } from '../services/messageQueueManager.js';
import { escapeXml } from '../constants/xmlTags.js';
import { hookOutputSchema } from './hookOutputSchema.js';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

const MAX_REWAKE_SUMMARY_LEN = 300;

function collapseAndTruncateRewakeSummary(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, MAX_REWAKE_SUMMARY_LEN);
}

/** Diagnostic cap for raw hook stdout; the parsed fields carry the verdict. */
const MAX_HOOK_STDOUT_LOG_LEN = 2000;

/**
 * What a hook execution produced, for the hook.finished diagnostic: the
 * structured outcome (decision/permission verdict when the hook spoke one),
 * the parsed output object, and capped raw stdout. Observability only —
 * never consulted for control flow.
 */
function hookOutputForLog(result: HookExecutionResult): unknown {
  return {
    outcome: result.outcome,
    output: result.output,
    output_format: result.outputFormat,
    ...(result.stdout
      ? {
          stdout:
            result.stdout.length > MAX_HOOK_STDOUT_LOG_LEN
              ? result.stdout.slice(0, MAX_HOOK_STDOUT_LOG_LEN) + '…[truncated]'
              : result.stdout,
        }
      : {}),
  };
}

/** Compose task-notification payload for asyncRewake exit-code-2. Exported for testing. */
export function composeRewakeNotification(args: {
  hookName: string;
  message: string;
  rewakeMessage?: string;
  rewakeSummary?: string;
}): { value: string; summary: string; prefix: string } {
  const prefix =
    args.rewakeMessage ??
    `Stop hook blocking error from command "${args.hookName}":`;
  const summary = collapseAndTruncateRewakeSummary(
    args.rewakeSummary ?? 'Stop hook feedback',
  );
  const value =
    `<task-notification>\n` +
    `<summary>${escapeXml(summary)}</summary>\n` +
    `</task-notification>\n` +
    `<system-reminder>${prefix} ${args.message}</system-reminder>`;
  return { value, summary, prefix };
}

/**
 * Parse stdout from an asyncRewake hook for a dynamic rewakeSummary.
 * Only the first line that parses as valid hook-output JSON is considered.
 * Lines containing `"async"` are skipped (async declaration).
 */
export function extractDynamicRewakeSummary(
  stdout: string,
): string | undefined {
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && 'async' in parsed) continue;
      const validation = hookOutputSchema.safeParse(parsed);
      if (!validation.success) break;
      if (
        typeof validation.data.rewakeSummary === 'string' &&
        validation.data.rewakeSummary.trim()
      ) {
        return collapseAndTruncateRewakeSummary(validation.data.rewakeSummary);
      }
      break;
    } catch {
      /* not valid JSON, try next line */
    }
  }
  return undefined;
}

export const ASYNC_REWAKE_FLUSH_TIMEOUT_MS = 4_000;

const pendingAsyncRewakeHooks = new Set<Promise<void>>();

export async function flushPendingAsyncRewakeHooks(): Promise<void> {
  if (pendingAsyncRewakeHooks.size === 0) return;
  await Promise.race([
    Promise.allSettled([...pendingAsyncRewakeHooks]),
    new Promise<void>((resolve) =>
      setTimeout(resolve, ASYNC_REWAKE_FLUSH_TIMEOUT_MS).unref(),
    ),
  ]);
}

/**
 * Hook event bus that coordinates hook execution across the system
 */
export class HookEventHandler {
  private readonly context: AgentLoopContext;
  private readonly hookPlanner: HookPlanner;
  private readonly hookRunner: HookRunner;
  private readonly hookAggregator: HookAggregator;
  private readonly hookRegistry: HookRegistry | undefined;

  /**
   * Pending async hook results. Each entry contains the additionalContext
   * string collected from a background hook execution. These are drained
   * and injected into the next model turn by calling
   * `drainPendingAsyncContext()`.
   */
  private static readonly MAX_PENDING_ASYNC_CONTEXTS = 100;
  private pendingAsyncContexts: string[] = [];

  constructor(
    context: AgentLoopContext,
    hookPlanner: HookPlanner,
    hookRunner: HookRunner,
    hookAggregator: HookAggregator,
    hookRegistry?: HookRegistry,
  ) {
    this.context = context;
    this.hookPlanner = hookPlanner;
    this.hookRunner = hookRunner;
    this.hookAggregator = hookAggregator;
    this.hookRegistry = hookRegistry;
  }

  /**
   * Handlers receive the same input, not the previous handler's transformed images.
   * Normal synchronous result aggregation applies: the last output containing
   * `hookSpecificOutput.images` in aggregation order wins and is validated below.
   */
  async fireImagePrepareEvent(input: ImagePrepareRequest, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const config = this.context.config;
    const key = input.modelKey ?? config.getModel();
    const route = config.getCustomProviderRegistry().getModelDescriptor(key);
    const identity = config.getModelRequestIdentity();
    const model = route ? undefined : await config.getModelProviderManager().getModel(key);
    signal?.throwIfAborted();
    if ((!input.modelKey && key !== config.getModel()) || identity !== config.getModelRequestIdentity()) {
      throw new Error('Session model changed while preparing input.');
    }
    if (!route && !model) {
      throw new Error('ImagePrepare model is not available');
    }
    const imageModel: ImagePrepareInput['imageModel'] = route
      ? { source: route.providerId, key }
      : { source: model!.source, key: model!.key };
    const hookInput: HookInput & ImagePrepareInput = {
      ...(await this.createBaseInput(HookEventName.ImagePrepare)),
      images: input.images,
      imageModel,
      failureMode: input.failureMode,
    };
    const result = await this.executeHooks(
      HookEventName.ImagePrepare,
      hookInput,
      { agentId: this.getCurrentAgentId() },
      signal,
    );
    signal?.throwIfAborted();
    if (!result.success) {
      if (input.failureMode === 'throw') {
        throw result.errors[0] ?? new Error('ImagePrepare failed');
      }
      runLogger.warn(
        '[ImagePrepare] preparation failed, keeping original images',
      );
      return [...input.images];
    }
    const output = result.finalOutput?.hookSpecificOutput;
    if (!output) return input.images;
    return validatePreparedImages(output['images'], input.images);
  }

  /**
   * Drain all accumulated async hook context strings.
   *
   * Call this before the next model turn to retrieve any context that
   * background hooks produced since the last drain. Returns `undefined`
   * if no async hooks completed.
   */
  drainPendingAsyncContext(): string | undefined {
    if (this.pendingAsyncContexts.length === 0) {
      return undefined;
    }
    const merged = this.pendingAsyncContexts.join('\n');
    this.pendingAsyncContexts = [];
    return merged;
  }

  /**
   * Fire a PreToolUse event
   * Called by handleHookExecutionRequest - executes hooks directly
   */
  async firePreToolUseEvent(
    toolName: string,
    toolInput: Record<string, unknown>,
    toolUseId: string,
    mcpContext?: McpToolContext,
    originalRequestName?: string,
    signal?: AbortSignal,
    model?: string,
  ): Promise<AggregatedHookResult> {
    const input: PreToolUseInput = {
      ...(await this.createBaseInput(HookEventName.PreToolUse, model)),
      tool_use_id: toolUseId,
      tool_name: toolName,
      tool_input: toolInput,
      ...(mcpContext && { mcp_context: mcpContext }),
      ...(originalRequestName && {
        original_request_name: originalRequestName,
      }),
    };

    const context: HookEventContext = {
      toolName,
      toolInput,
      agentId: this.getCurrentAgentId(),
    };
    return this.executeHooks(
      HookEventName.PreToolUse,
      input,
      context,
      signal,
      toolUseId,
    );
  }

  /**
   * Fire a PostToolUse event
   * Called by handleHookExecutionRequest - executes hooks directly
   */
  async firePostToolUseEvent(
    toolName: string,
    toolInput: Record<string, unknown>,
    toolResponse: unknown,
    toolUseId: string,
    mcpContext?: McpToolContext,
    originalRequestName?: string,
    signal?: AbortSignal,
    model?: string,
    fileWrite?: PostToolUseInput['file_write'],
  ): Promise<AggregatedHookResult> {
    const input: PostToolUseInput = {
      ...(await this.createBaseInput(HookEventName.PostToolUse, model)),
      tool_use_id: toolUseId,
      tool_name: toolName,
      tool_input: toolInput,
      tool_response: toolResponse,
      ...(mcpContext && { mcp_context: mcpContext }),
      ...(originalRequestName && {
        original_request_name: originalRequestName,
      }),
    };
    if (fileWrite) {
      Object.defineProperty(input, 'file_write', {
        value: fileWrite,
        enumerable: false,
      });
    }

    const context: HookEventContext = {
      toolName,
      toolInput,
      agentId: this.getCurrentAgentId(),
    };
    return this.executeHooks(
      HookEventName.PostToolUse,
      input,
      context,
      signal,
      toolUseId,
    );
  }

  /**
   * Fire a SubagentStart event
   * Called by handleHookExecutionRequest - executes hooks directly.
   * Carries agent_id and agent_type.
   */
  async fireSubagentStartEvent(
    agentId: string,
    agentType: string,
    signal?: AbortSignal,
    model?: string,
  ): Promise<AggregatedHookResult> {
    const input: SubagentStartInput = {
      ...(await this.createBaseInput(HookEventName.SubagentStart, model)),
      agent_id: agentId,
      agent_type: agentType,
    };

    return this.executeHooks(
      HookEventName.SubagentStart,
      input,
      {
        trigger: agentType,
        agentId: this.getCurrentAgentId(),
      },
      signal,
    );
  }

  /**
   * Fire a Notification event
   */
  async fireNotificationEvent(
    type: NotificationType,
    message: string,
    details: Record<string, unknown>,
    title?: string,
    signal?: AbortSignal,
  ): Promise<AggregatedHookResult> {
    const input: NotificationInput = {
      ...(await this.createBaseInput(HookEventName.Notification)),
      notification_type: type,
      message,
      details,
      ...(title && { title }),
    };

    return this.executeHooks(
      HookEventName.Notification,
      input,
      {
        trigger: type,
        agentId: this.getCurrentAgentId(),
      },
      signal,
    );
  }

  /**
   * Fire a SubagentStop event
   * Called by handleHookExecutionRequest - executes hooks directly.
   * Carries agent identity and stop metadata.
   */
  async fireSubagentStopEvent(
    agentId: string,
    agentType: string,
    stopHookActive: boolean = false,
    agentTranscriptPath?: string,
    lastAssistantMessage?: string,
    signal?: AbortSignal,
    model?: string,
  ): Promise<AggregatedHookResult> {
    const input: SubagentStopInput = {
      ...(await this.createBaseInput(HookEventName.SubagentStop, model)),
      agent_id: agentId,
      agent_type: agentType,
      stop_hook_active: stopHookActive,
      ...(agentTranscriptPath && {
        agent_transcript_path: agentTranscriptPath,
      }),
      ...(lastAssistantMessage && {
        last_assistant_message: lastAssistantMessage,
      }),
    };

    return this.executeHooks(
      HookEventName.SubagentStop,
      input,
      {
        trigger: agentType,
        agentId: this.getCurrentAgentId(),
      },
      signal,
    );
  }

  /**
   * Fire a SessionStart event
   */
  async fireSessionStartEvent(
    source: SessionStartSource,
    model?: string,
    signal?: AbortSignal,
  ): Promise<AggregatedHookResult> {
    const input: SessionStartInput = {
      ...(await this.createBaseInput(HookEventName.SessionStart, model)),
      source,
    };

    const context: HookEventContext = { trigger: source };
    return this.executeHooks(
      HookEventName.SessionStart,
      input,
      context,
      signal,
    );
  }

  /**
   * Fire a Setup event.
   */
  async fireSetupEvent(
    trigger: SetupTrigger,
    signal?: AbortSignal,
  ): Promise<AggregatedHookResult> {
    const input: SetupInput = {
      ...(await this.createBaseInput(HookEventName.Setup)),
      trigger,
    };

    const context: HookEventContext = { trigger };
    return this.executeHooks(HookEventName.Setup, input, context, signal);
  }

  /**
   * Fire a SessionEnd event
   */
  async fireSessionEndEvent(
    reason: SessionEndReason,
    signal?: AbortSignal,
  ): Promise<AggregatedHookResult> {
    const input: SessionEndInput = {
      ...(await this.createBaseInput(HookEventName.SessionEnd)),
      reason,
    };

    const context: HookEventContext = { trigger: reason };
    const result = await this.executeHooks(
      HookEventName.SessionEnd,
      input,
      context,
      signal,
    );

    cleanupSessionEnvDir(this.context.config.getSessionId());

    return result;
  }

  /**
   * Fire a PreCompact event
   */
  async firePreCompactEvent(
    trigger: PreCompactTrigger,
    customInstructions: string,
    signal?: AbortSignal,
    model?: string,
  ): Promise<AggregatedHookResult> {
    const input: PreCompactInput = {
      ...(await this.createCompactBaseInput(HookEventName.PreCompact, model)),
      trigger,
      custom_instructions: customInstructions,
    };

    const context: HookEventContext = { trigger };
    return this.executeHooks(HookEventName.PreCompact, input, context, signal);
  }

  /**
   * Fire a PostToolUseFailure event
   * Called when a tool execution fails with an error
   */
  async firePostToolUseFailureEvent(
    toolName: string,
    toolInput: Record<string, unknown>,
    errorMessage: string,
    toolUseId: string,
    errorType?: string,
    mcpContext?: McpToolContext,
    originalRequestName?: string,
    isInterrupt?: boolean,
    signal?: AbortSignal,
    model?: string,
  ): Promise<AggregatedHookResult> {
    const input: PostToolUseFailureInput = {
      ...(await this.createBaseInput(HookEventName.PostToolUseFailure, model)),
      tool_use_id: toolUseId,
      tool_name: toolName,
      tool_input: toolInput,
      error: errorMessage,
      ...(errorType && { error_type: errorType }),
      ...(mcpContext && { mcp_context: mcpContext }),
      ...(originalRequestName && {
        original_request_name: originalRequestName,
      }),
      ...(isInterrupt !== undefined && { is_interrupt: isInterrupt }),
    };

    const context: HookEventContext = {
      toolName,
      toolInput,
      agentId: this.getCurrentAgentId(),
    };
    return this.executeHooks(
      HookEventName.PostToolUseFailure,
      input,
      context,
      signal,
      toolUseId,
    );
  }

  /**
   * Fire a PostCompact event
   * Called after context compression completes
   */
  async firePostCompactEvent(
    trigger: PreCompactTrigger,
    compactSummary: string,
    signal?: AbortSignal,
    model?: string,
  ): Promise<AggregatedHookResult> {
    const input: PostCompactInput = {
      ...(await this.createCompactBaseInput(HookEventName.PostCompact, model)),
      trigger,
      compact_summary: compactSummary,
    };

    const context: HookEventContext = { trigger };
    return this.executeHooks(HookEventName.PostCompact, input, context, signal);
  }

  /**
   * Fire a Stop event
   * Called when the agent is about to stop execution.
   * Hook can block the stop (decision: 'deny') to keep the agent running.
   */
  async fireStopEvent(
    stopHookActive: boolean = false,
    lastAssistantMessage?: string,
    signal?: AbortSignal,
  ): Promise<AggregatedHookResult> {
    const input: StopInput = {
      ...(await this.createBaseInput(HookEventName.Stop)),
      stop_hook_active: stopHookActive,
      ...(lastAssistantMessage && {
        last_assistant_message: lastAssistantMessage,
      }),
    };

    return this.executeHooks(HookEventName.Stop, input, undefined, signal);
  }

  /**
   * Fire a Stop event with full prompt/response context.
   * Used by the main agent loop when the agent finishes processing —
   * carries the original prompt and cumulative response so hooks can
   * inspect conversation content.
   */
  async fireStopEventWithContext(
    prompt: string,
    promptResponse: string,
    stopHookActive: boolean = false,
    lifecycleContext?: {
      requestId?: string;
      parentRequestSetId?: string;
      parentBusinessInfo?: Readonly<
        import('../qoder/business-info.js').BusinessInfo
      >;
      customContext?: Readonly<Record<string, string>>;
    },
    signal?: AbortSignal,
    model?: string,
  ): Promise<AggregatedHookResult> {
    const input: StopInput = {
      ...(await this.createBaseInput(HookEventName.Stop, model)),
      stop_hook_active: stopHookActive,
      last_assistant_message: promptResponse,
      ...(lifecycleContext?.parentRequestSetId && {
        parent_request_set_id: lifecycleContext.parentRequestSetId,
      }),
      ...(lifecycleContext?.parentBusinessInfo && {
        parent_business_info: lifecycleContext.parentBusinessInfo,
      }),
    };

    const result = await this.executeHooks(
      HookEventName.Stop,
      input,
      undefined,
      signal,
    );

    // Emit a turn-complete event so UI-layer listeners (e.g. auto-memory)
    // can react without going through the hook system.
    // sessionId 必填：coreEvents 是进程级单例总线，daemon 里每个存活会话都订阅同一个
    // TurnComplete，payload 携带的是发射会话的对话正文，跨会话投递即内容泄漏。
    // 消费者一律走 onSessionEvent 按这个戳过滤。
    coreEvents.emit(CoreEvent.TurnComplete, {
      sessionId: this.context.config.getSessionId(),
      prompt,
      promptResponse,
      requestId: lifecycleContext?.requestId,
      parentRequestSetId: lifecycleContext?.parentRequestSetId,
      parentBusinessInfo: lifecycleContext?.parentBusinessInfo,
      customContext: lifecycleContext?.customContext,
    });

    return result;
  }

  async fireQueryEndEvent(
    requestSetId: string,
    businessId: string | undefined,
    model: string,
    reason: QueryEndReason,
    signal: AbortSignal,
  ): Promise<AggregatedHookResult> {
    const input: QueryEndInput = {
      ...(await this.createBaseInput(HookEventName.QueryEnd)),
      request_set_id: requestSetId,
      ...(businessId && { business_id: businessId }),
      model,
      reason,
    };

    return this.executeHooks(
      HookEventName.QueryEnd,
      input,
      { trigger: reason },
      signal,
    );
  }

  /**
   * Fire a UserPromptSubmit event
   * Called when the user submits a prompt, before it is processed.
   * Hooks can modify the prompt or inject additional context.
   */
  async fireUserPromptSubmitEvent(
    userPrompt: string,
    signal?: AbortSignal,
    imageUrls?: readonly string[],
    requestSetId?: string,
  ): Promise<AggregatedHookResult> {
    const input: UserPromptSubmitInput = {
      ...(await this.createBaseInput(HookEventName.UserPromptSubmit)),
      prompt: userPrompt,
      ...(requestSetId !== undefined ? { request_set_id: requestSetId } : {}),
      ...(imageUrls?.length ? { image_urls: [...imageUrls] } : {}),
    };

    return this.executeHooks(
      HookEventName.UserPromptSubmit,
      input,
      undefined,
      signal,
    );
  }

  /**
   * Fire a ConfigChange event.
   * Called when configuration changes are detected.
   *
   * Hooks are matched by `source` (via the `trigger` context field), so
   * user-configured matchers can target specific sources (e.g. only `skills`).
   *
   * Policy settings are enterprise-managed — hooks fire for audit logging
   * but blocking results are forced to non-blocking so policy changes
   * can never be prevented by hooks.
   */
  async fireConfigChangeEvent(
    source: ConfigChangeSource,
    filePath?: string,
    signal?: AbortSignal,
  ): Promise<AggregatedHookResult> {
    const input: ConfigChangeInput = {
      ...(await this.createBaseInput(HookEventName.ConfigChange)),
      source,
      ...(filePath && { file_path: filePath }),
    };

    const result = await this.executeHooks(
      HookEventName.ConfigChange,
      input,
      {
        trigger: source,
      },
      signal,
    );

    // Policy settings are enterprise-managed — hooks fire for audit logging
    // but must never block policy changes from being applied.
    if (source === 'policy_settings' && result.finalOutput) {
      result.finalOutput.decision = 'allow';
    }

    return result;
  }

  /**
   * Fire a StopFailure event
   * Called when the agent unexpectedly stops due to an error.
   * Output is ignored; this is notification-only.
   */
  async fireStopFailureEvent(
    error: StopFailureErrorType,
    options?: StopFailureOptions,
    signal?: AbortSignal,
    model?: string,
  ): Promise<AggregatedHookResult> {
    const input: StopFailureInput = {
      ...(await this.createBaseInput(HookEventName.StopFailure, model)),
      error,
      ...(options?.errorDetails && { error_details: options.errorDetails }),
      ...(options?.lastAssistantMessage && {
        last_assistant_message: options.lastAssistantMessage,
      }),
    };

    const context: HookEventContext = { trigger: error };
    return this.executeHooks(HookEventName.StopFailure, input, context, signal);
  }

  /**
   * Fire a TeammateIdle event
   * Called when a teammate agent attempts to become idle.
   * Hook can block (decision: 'deny') to keep teammate active.
   */
  async fireTeammateIdleEvent(
    teammateName: string,
    teamName?: string,
    signal?: AbortSignal,
  ): Promise<AggregatedHookResult> {
    const input: TeammateIdleInput = {
      ...(await this.createBaseInput(HookEventName.TeammateIdle)),
      teammate_name: teammateName,
      ...(teamName && { team_name: teamName }),
    };

    return this.executeHooks(
      HookEventName.TeammateIdle,
      input,
      undefined,
      signal,
    );
  }

  /**
   * Fire an InstructionsLoaded event
   * Called when instruction/memory files are loaded.
   * Output is ignored; this is notification-only.
   */
  async fireInstructionsLoadedEvent(
    filePath: string,
    memoryType: string,
    loadReason: InstructionsLoadReason,
    options?: {
      globs?: string[];
      triggerFilePath?: string;
      parentFilePath?: string;
    },
    signal?: AbortSignal,
  ): Promise<AggregatedHookResult> {
    const input: InstructionsLoadedInput = {
      ...(await this.createBaseInput(HookEventName.InstructionsLoaded)),
      file_path: filePath,
      memory_type: memoryType,
      load_reason: loadReason,
      ...(options?.globs && { globs: options.globs }),
      ...(options?.triggerFilePath && {
        trigger_file_path: options.triggerFilePath,
      }),
      ...(options?.parentFilePath && {
        parent_file_path: options.parentFilePath,
      }),
    };

    const context: HookEventContext = { trigger: loadReason };
    return this.executeHooks(
      HookEventName.InstructionsLoaded,
      input,
      context,
      signal,
    );
  }

  /**
   * Fire a CwdChanged event
   * Called when the working directory changes.
   */
  async fireCwdChangedEvent(
    oldCwd: string,
    newCwd: string,
    signal?: AbortSignal,
  ): Promise<AggregatedHookResult> {
    clearCwdEnvFiles(this.context.config.getSessionId());

    const input: CwdChangedInput = {
      ...(await this.createBaseInput(HookEventName.CwdChanged)),
      cwd: newCwd,
      old_cwd: oldCwd,
      new_cwd: newCwd,
    };

    return this.executeHooks(
      HookEventName.CwdChanged,
      input,
      undefined,
      signal,
    );
  }

  /**
   * Fire a FileChanged event
   * Called when a watched file changes.
   */
  async fireFileChangedEvent(
    filePath: string,
    event: FileChangeEventType,
    signal?: AbortSignal,
    cwd: string = this.context.config.getWorkingDir(),
  ): Promise<AggregatedHookResult> {
    const input: FileChangedInput = {
      ...(await this.createBaseInput(HookEventName.FileChanged)),
      cwd,
      file_path: filePath,
      event,
    };

    const context: HookEventContext = { toolName: path.basename(filePath) };
    return this.executeHooks(HookEventName.FileChanged, input, context, signal);
  }

  /**
   * Fire a WorktreeCreate event
   * Called when a git worktree needs to be created.
   * Any non-zero exit code fails the creation.
   */
  async fireWorktreeCreateEvent(
    name: string,
    signal?: AbortSignal,
  ): Promise<AggregatedHookResult> {
    const input: WorktreeCreateInput = {
      ...(await this.createBaseInput(HookEventName.WorktreeCreate)),
      name,
    };

    return this.executeHooks(
      HookEventName.WorktreeCreate,
      input,
      undefined,
      signal,
    );
  }

  /**
   * Fire a WorktreeRemove event
   * Called when a git worktree is being removed.
   *
   * When this hook is configured it owns the removal. Callers must check
   * `successfulHookCount` rather than `success`: an empty success is returned
   * when every hook is async or filtered out by an `if:` condition, and treating
   * that as a removal would strand the worktree on disk.
   */
  async fireWorktreeRemoveEvent(
    worktreePath: string,
    signal?: AbortSignal,
  ): Promise<AggregatedHookResult> {
    const input: WorktreeRemoveInput = {
      ...(await this.createBaseInput(HookEventName.WorktreeRemove)),
      worktree_path: worktreePath,
    };

    return this.executeHooks(
      HookEventName.WorktreeRemove,
      input,
      undefined,
      signal,
    );
  }

  /**
   * Fire an Elicitation event
   * Called when an MCP server requests user input.
   * Hooks can auto-accept, decline, or cancel.
   */
  async fireElicitationEvent(
    mcpServerName: string,
    message: string,
    options?: {
      mode?: string;
      url?: string;
      elicitationId?: string;
      requestedSchema?: Record<string, unknown>;
    },
    signal?: AbortSignal,
  ): Promise<AggregatedHookResult> {
    const input: ElicitationInput = {
      ...(await this.createBaseInput(HookEventName.Elicitation)),
      mcp_server_name: mcpServerName,
      message,
      ...(options?.mode && { mode: options.mode }),
      ...(options?.url && { url: options.url }),
      ...(options?.elicitationId && {
        elicitation_id: options.elicitationId,
      }),
      ...(options?.requestedSchema && {
        requested_schema: options.requestedSchema,
      }),
    };

    const context: HookEventContext = { toolName: mcpServerName };
    return this.executeHooks(HookEventName.Elicitation, input, context, signal);
  }

  /**
   * Fire an ElicitationResult event
   * Called after an elicitation completes.
   * Hooks can override the action/content.
   */
  async fireElicitationResultEvent(
    mcpServerName: string,
    action: ElicitationAction,
    options?: {
      content?: Record<string, unknown>;
      mode?: string;
      elicitationId?: string;
    },
    signal?: AbortSignal,
  ): Promise<AggregatedHookResult> {
    const input: ElicitationResultInput = {
      ...(await this.createBaseInput(HookEventName.ElicitationResult)),
      mcp_server_name: mcpServerName,
      action,
      ...(options?.content && { content: options.content }),
      ...(options?.mode && { mode: options.mode }),
      ...(options?.elicitationId && {
        elicitation_id: options.elicitationId,
      }),
    };

    const context: HookEventContext = { toolName: mcpServerName };
    return this.executeHooks(
      HookEventName.ElicitationResult,
      input,
      context,
      signal,
    );
  }

  /**
   * Fire a TaskCreated event
   * Called when a task is created.
   * Hook can block (decision: 'deny') to prevent task creation.
   */
  async fireTaskCreatedEvent(
    taskId: string,
    taskSubject: string,
    options?: {
      taskDescription?: string;
      teammateName?: string;
      teamName?: string;
    },
    signal?: AbortSignal,
  ): Promise<AggregatedHookResult> {
    const input: TaskCreatedInput = {
      ...(await this.createBaseInput(HookEventName.TaskCreated)),
      task_id: taskId,
      task_subject: taskSubject,
      ...(options?.taskDescription !== undefined && {
        task_description: options.taskDescription,
      }),
      ...(options?.teammateName && {
        teammate_name: options.teammateName,
      }),
      ...(options?.teamName && { team_name: options.teamName }),
    };

    return this.executeHooks(
      HookEventName.TaskCreated,
      input,
      undefined,
      signal,
    );
  }

  /**
   * Fire a TaskCompleted event
   * Called when a task completes.
   * Hook can block (decision: 'deny') to keep task active.
   */
  async fireTaskCompletedEvent(
    taskId: string,
    taskSubject: string,
    options?: {
      taskDescription?: string;
      teammateName?: string;
      teamName?: string;
    },
    signal?: AbortSignal,
  ): Promise<AggregatedHookResult> {
    const input: TaskCompletedInput = {
      ...(await this.createBaseInput(HookEventName.TaskCompleted)),
      task_id: taskId,
      task_subject: taskSubject,
      ...(options?.taskDescription !== undefined && {
        task_description: options.taskDescription,
      }),
      ...(options?.teammateName && {
        teammate_name: options.teammateName,
      }),
      ...(options?.teamName && { team_name: options.teamName }),
    };

    return this.executeHooks(
      HookEventName.TaskCompleted,
      input,
      undefined,
      signal,
    );
  }

  /**
   * Fire a PermissionRequest event
   * Called when a tool requests permission.
   * Hooks can auto-allow, deny, or modify the tool input.
   */
  async firePermissionRequestEvent(
    toolName: string,
    toolInput: Record<string, unknown>,
    permissionSuggestions?: PermissionSuggestion[],
    signal?: AbortSignal,
    model?: string,
  ): Promise<AggregatedHookResult> {
    const input: PermissionRequestInput = {
      ...(await this.createBaseInput(HookEventName.PermissionRequest, model)),
      tool_name: toolName,
      tool_input: toolInput,
      ...(permissionSuggestions && {
        permission_suggestions: permissionSuggestions,
      }),
    };

    const context: HookEventContext = {
      toolName,
      toolInput,
      agentId: this.getCurrentAgentId(),
    };
    return this.executeHooks(
      HookEventName.PermissionRequest,
      input,
      context,
      signal,
    );
  }

  /**
   * Fire a PermissionDenied event
   * Called when a tool permission is denied.
   * Hooks can request a retry.
   */
  async firePermissionDeniedEvent(
    toolName: string,
    toolInput: Record<string, unknown>,
    toolUseId: string,
    reason: string,
    signal?: AbortSignal,
    model?: string,
  ): Promise<AggregatedHookResult> {
    const input: PermissionDeniedInput = {
      ...(await this.createBaseInput(HookEventName.PermissionDenied, model)),
      tool_name: toolName,
      tool_input: toolInput,
      tool_use_id: toolUseId,
      reason,
    };

    const context: HookEventContext = {
      toolName,
      toolInput,
      agentId: this.getCurrentAgentId(),
    };
    return this.executeHooks(
      HookEventName.PermissionDenied,
      input,
      context,
      signal,
      toolUseId,
    );
  }

  /** Execute hooks for a specific event without the hook queue. */
  private async executeHooks(
    eventName: HookEventName,
    input: HookInput,
    context?: HookEventContext,
    signal?: AbortSignal,
    toolUseId?: string,
  ): Promise<AggregatedHookResult> {
    try {
      const isQueryEnd = eventName === HookEventName.QueryEnd;
      const canConsumeRewake =
        !isQueryEnd && this.context.config.canRunAsyncRewakeHooks();
      const plan = this.hookPlanner.createExecutionPlan(
        eventName,
        context,
        canConsumeRewake,
      );

      if (
        !plan ||
        (plan.hookConfigs.length === 0 && plan.asyncHookConfigs.length === 0)
      ) {
        return {
          success: true,
          hooksSkipped: true,
          allOutputs: [],
          errors: [],
          totalDuration: 0,
        };
      }

      const internalOnly = this.context.config.isAllHooksDisabled();
      const keepEnabled = (config: HookConfig): boolean =>
        !internalOnly ||
        (config.type === HookType.Runtime && config.internal === true);
      const plannedSyncConfigs = plan.hookConfigs.filter(keepEnabled);
      const plannedAsyncConfigs = plan.asyncHookConfigs.filter(keepEnabled);
      const hookConfigs = isQueryEnd
        ? [...plannedSyncConfigs, ...plannedAsyncConfigs]
        : plannedSyncConfigs;
      const asyncHookConfigs = isQueryEnd ? [] : plannedAsyncConfigs;
      const hookIdentity = getHookIdentity(eventName, plan.matchQuery);

      // UI lifecycle events cover only user-visible hooks, numbered within
      // that subset, so the status row's k/n progress never waits on a hidden
      // System/Runtime hook.
      const batchId = randomUUID();
      const agentId = this.getCurrentAgentId();
      // Plan index -> 1-based ordinal among user-visible hooks.
      const visibleOrdinals = new Map<number, number>();
      hookConfigs.forEach((config, planIndex) => {
        if (isUserVisibleHook(config.source)) {
          visibleOrdinals.set(planIndex, visibleOrdinals.size + 1);
        }
      });
      const visibleTotal = visibleOrdinals.size;

      const onHookStart = (config: HookConfig, index: number) => {
        const fields = {
          sessionId: input.session_id,
          turnId: this.context.promptId,
          toolCallId: toolUseId,
          hookName: hookIdentity,
          eventName,
          source: config.source,
          statusMessage: config.statusMessage,
          displayText: getHookDisplayText(config),
          ...getHookPluginAttribution(config),
        };
        emitHookStarted({
          ...fields,
          hookIndex: index + 1,
          totalHooks: hookConfigs.length,
        });
        const ordinal = visibleOrdinals.get(index);
        if (ordinal === undefined) return;
        coreEvents.emit(CoreEvent.HookStart, {
          ...fields,
          batchId,
          agentId,
          hookIndex: ordinal,
          totalHooks: visibleTotal,
          hookInput: input,
        });
      };

      const onHookEnd = (
        config: HookConfig,
        result: HookExecutionResult,
        index: number,
      ) => {
        const fields = {
          sessionId: input.session_id,
          turnId: this.context.promptId,
          toolCallId: toolUseId,
          hookName: hookIdentity,
          eventName,
          source: config.source,
          success: result.success,
          durationMs: result.duration,
          exitCode: result.exitCode,
          error: result.error?.message,
          ...getHookPluginAttribution(config),
        };
        emitHookFinished(fields);
        const ordinal = visibleOrdinals.get(index);
        if (ordinal === undefined) return;
        coreEvents.emit(CoreEvent.HookEnd, {
          ...fields,
          batchId,
          agentId,
          hookIndex: ordinal,
          hookOutput: hookOutputForLog(result),
          ...(signal?.aborted ? { cancelled: true } : {}),
        });
      };

      // Fire async hooks in the background (fire-and-forget).
      // Pass the caller signal so async hooks honor parent abort (e.g.
      // SessionEnd's clamped timeout); without this, async hooks would run
      // up to their own per-hook timeout regardless of the parent bound.
      if (asyncHookConfigs.length > 0) {
        this.executeAsyncHooksInBackground(
          asyncHookConfigs,
          eventName,
          input,
          context,
          toolUseId,
          hookIdentity,
          signal,
        );
      }

      // If there are no sync hooks, return immediately
      if (hookConfigs.length === 0) {
        return {
          success: true,
          hooksSkipped: asyncHookConfigs.length === 0,
          allOutputs: [],
          errors: [],
          totalDuration: 0,
        };
      }

      // Execute sync hooks according to the plan's strategy
      const results = plan.sequential
        ? await this.hookRunner.executeHooksSequential(
            hookConfigs,
            eventName,
            input,
            onHookStart,
            onHookEnd,
            signal,
          )
        : await this.hookRunner.executeHooksParallel(
            hookConfigs,
            eventName,
            input,
            onHookStart,
            onHookEnd,
            signal,
          );

      // Aggregate results
      const aggregated = this.hookAggregator.aggregateResults(
        results,
        eventName,
      );

      // Remove hooks marked with `once` after successful execution
      this.processOnceHooks(results, context);

      // Process common hook output fields centrally
      this.processCommonHookOutputFields(aggregated, eventName);

      // Log hook execution
      this.logHookExecution(eventName, results, aggregated);

      // Build structured attachments (errors, cancellations, system messages)
      // for display in the TUI. Call sites push these into
      // attachmentCtx.pendingHookAttachments.
      const pendingAttachments = hookResultsToAttachments(results, eventName, {
        toolUseID: toolUseId,
        matchQuery: plan.matchQuery,
      });
      if (pendingAttachments.length > 0) {
        aggregated.pendingAttachments = pendingAttachments;
      }

      return aggregated;
    } catch (error) {
      runLogger.error(`Hook event bus error for ${eventName}: ${error}`);

      if (eventName === HookEventName.PreToolUse) {
        return buildPreToolUseDenyResult(
          `PreToolUse hook system error: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      return {
        success: false,
        allOutputs: [],
        errors: [error instanceof Error ? error : new Error(String(error))],
        totalDuration: 0,
      };
    }
  }

  /**
   * Fire async hooks in the background. Results are collected into
   * `pendingAsyncContexts` for injection in the next model turn.
   */
  private executeAsyncHooksInBackground(
    asyncHookConfigs: HookConfig[],
    eventName: HookEventName,
    input: HookInput,
    context?: HookEventContext,
    toolUseId?: string,
    hookIdentity: string = eventName,
    signal?: AbortSignal,
  ): void {
    // Separate asyncRewake hooks from normal async hooks (single pass)
    const normalAsync: HookConfig[] = [];
    const rewakeConfigs: HookConfig[] = [];
    for (const c of asyncHookConfigs) {
      if (c.type === 'command' && c.asyncRewake) {
        rewakeConfigs.push(c);
      } else {
        normalAsync.push(c);
      }
    }

    const emitAsyncHookStart =
      (totalHooks: number) => (config: HookConfig, index: number) => {
        emitHookStarted({
          sessionId: input.session_id,
          turnId: this.context.promptId,
          toolCallId: toolUseId,
          hookName: hookIdentity,
          eventName,
          source: config.source,
          hookIndex: index + 1,
          totalHooks,
          statusMessage: config.statusMessage,
          displayText: getHookDisplayText(config),
          hookInput: input,
          ...getHookPluginAttribution(config),
        });
      };

    const emitAsyncHookEnd = (
      config: HookConfig,
      result: HookExecutionResult,
    ) => {
      emitHookFinished({
        sessionId: input.session_id,
        turnId: this.context.promptId,
        toolCallId: toolUseId,
        hookName: hookIdentity,
        eventName,
        success: result.success,
        durationMs: result.duration,
        exitCode: result.exitCode,
        error: result.error?.message,
        source: config.source,
        hookOutput: hookOutputForLog(result),
        ...getHookPluginAttribution(config),
      });
    };

    // Normal async hooks: existing behaviour (fire-and-forget, collect additionalContext)
    if (normalAsync.length > 0) {
      void (async () => {
        try {
          const results = await this.hookRunner.executeHooksParallel(
            normalAsync,
            eventName,
            input,
            emitAsyncHookStart(normalAsync.length),
            emitAsyncHookEnd,
            signal,
            { schemaFailureMode: 'plain-text-fallback' },
          );

          // Remove async hooks marked with `once` after successful execution
          this.processOnceHooks(results, context);

          for (const result of results) {
            if (!result.success) {
              const hookName = getHookDisplayText(result.hookConfig);
              runLogger.warn(
                `Async hook [${hookName}] for ${eventName} failed: ${result.error?.message}`,
              );
              continue;
            }

            // Collect additionalContext from the hook output
            const output = result.output;
            if (!output) continue;

            const specific = output.hookSpecificOutput;
            if (
              this.pendingAsyncContexts.length >=
              HookEventHandler.MAX_PENDING_ASYNC_CONTEXTS
            ) {
              runLogger.warn(
                `Pending async contexts limit reached (${HookEventHandler.MAX_PENDING_ASYNC_CONTEXTS}). Dropping additional context from async hook.`,
              );
              break;
            }

            if (
              specific &&
              'additionalContext' in specific &&
              // eslint-disable-next-line eslint-js/no-restricted-syntax
              typeof specific['additionalContext'] === 'string'
            ) {
              this.pendingAsyncContexts.push(specific['additionalContext']);
            } else if (output.stdoutContent) {
              // Only shell hook stdout reaches the model via pendingAsyncContexts.
              // JSON hook systemMessage is UI-only and must NOT leak to model.
              this.pendingAsyncContexts.push(output.stdoutContent);
            }
          }
        } catch (error) {
          runLogger.warn(
            `Async hooks background execution error for ${eventName}: ${error}`,
          );
        }
      })();
    }

    // asyncRewake hooks: fire-and-forget, exit code 2 wakes the model.
    // Promises tracked in pendingAsyncRewakeHooks for session-end flush.
    for (const config of rewakeConfigs) {
      const rewakeCustomContext = snapshotCustomContext(
        getCustomContextFromContext(),
      );
      const promise = (async () => {
        try {
          const results = await this.hookRunner.executeHooksParallel(
            [config],
            eventName,
            input,
            emitAsyncHookStart(1),
            emitAsyncHookEnd,
            signal,
            { schemaFailureMode: 'plain-text-fallback' },
          );
          const result = results[0];
          if (
            result &&
            !result.success &&
            result.exitCode === EXIT_CODE_BLOCK
          ) {
            const hookName = getHookDisplayText(result.hookConfig);
            const message =
              result.stderr?.trim() ||
              result.stdout?.trim() ||
              result.error?.message ||
              'Hook blocking error';
            const cmdConfig = result.hookConfig as CommandHookConfig;

            let dynamicRewakeSummary: string | undefined;
            if (cmdConfig.pluginId && result.stdout) {
              dynamicRewakeSummary = extractDynamicRewakeSummary(result.stdout);
            }

            const { value, summary } = composeRewakeNotification({
              hookName,
              message,
              rewakeMessage: cmdConfig.rewakeMessage,
              rewakeSummary: dynamicRewakeSummary ?? cmdConfig.rewakeSummary,
            });
            runLogger.debug(
              `[asyncRewake] Hook "${hookName}" exited with code 2, ` +
                `waking model (summary="${summary}"): ${message}`,
            );
            enqueuePendingNotification({
              prompt: value,
              commandMode: 'task-notification',
              priority: 'next',
              targetAgentId: this.getCurrentAgentId(),
              stopHookActive: true,
              ...(rewakeCustomContext !== undefined
                ? { customContext: rewakeCustomContext }
                : {}),
            });
          }
        } catch (error) {
          runLogger.warn(
            `[asyncRewake] Hook background execution error for ${eventName}: ${error}`,
          );
        }
      })();
      pendingAsyncRewakeHooks.add(promise);
      void promise.finally(() => pendingAsyncRewakeHooks.delete(promise));
    }
  }

  /**
   * Get the current agent ID from AsyncLocalStorage context.
   * Used to pass agentId into HookEventContext for session hook matching.
   */
  private getCurrentAgentId(): string | undefined {
    return getAgentContext()?.agentId;
  }

  /**
   * Process hooks with `once` flag: remove them from the registry after
   * their first successful execution.
   * Only effective for session-scoped hooks (agent/skill frontmatter).
   * Persistent hooks from settings.json are never removed by `once`.
   */
  private processOnceHooks(
    results: HookExecutionResult[],
    context?: HookEventContext,
  ): void {
    if (!this.hookRegistry) return;

    const agentId = context?.agentId;

    for (const result of results) {
      if (!result.success) continue;

      const config = result.hookConfig;
      // Check if the hook has the `once` flag (only command, http, prompt, agent types)
      if (!('once' in config) || !config.once) continue;

      if (agentId) {
        this.hookRegistry.removeSessionHook(agentId, config);
      } else {
        // Inline skill hooks fire in the main agent context, which carries
        // no agentId. Remove them by config reference across the skill
        // buckets so `once` is honored there too.
        this.hookRegistry.removeInlineSkillSessionHooks(config);
      }
    }
  }

  /**
   * Resolve the model field carried by hook payloads.
   *
   * Reads the in-memory catalog snapshot only: PreToolUse and PostToolUse build
   * a payload around every tool call, so refreshing the catalog here would put
   * a remote models.list on the tool-call critical path. When the snapshot has
   * no entry for the key, the key itself is the fallback — hooks still receive
   * a model identifier instead of a missing field.
   */
  private async resolveModelName(model?: string): Promise<string | undefined> {
    if (!model) return undefined;
    const models = await this.context.config
      .getModelProviderManager()
      .listModels({ cachedOnly: true });
    const entry =
      models.find((candidate) => candidate.key === model) ??
      models.find(
        (candidate) => candidate.key.toLowerCase() === model.toLowerCase(),
      );
    return entry?.displayName?.trim() || model;
  }

  /**
   * Create base hook input with common fields
   */
  private async createCoreBaseInput(
    eventName: HookEventName,
    model?: string,
  ): Promise<HookInput> {
    const modelName = await this.resolveModelName(model);
    return {
      session_id: this.context.config.getSessionId(),
      transcript_path: this.context.config.getActiveSessionTranscriptPath(),
      cwd: this.context.config.getWorkingDir(),
      hook_event_name: eventName,
      workspace_dirs: this.context.config.getWorkspaceContext().getDirectories(),
      ...(modelName && { model: modelName }),
    };
  }

  private async createBaseInput(
    eventName: HookEventName,
    model?: string,
  ): Promise<HookInput> {
    const agentCtx = getAgentContext();
    return {
      ...(await this.createCoreBaseInput(eventName, model)),
      permission_mode:
        this.context.config.getPermissionMode() as HookInput['permission_mode'],
      ...(agentCtx && {
        agent_id: agentCtx.agentId,
        agent_type: agentCtx.agentType,
      }),
    };
  }

  /**
   * Upstream PreCompact / PostCompact payloads carry only the core common
   * keys — no `permission_mode`, no `agent_id`/`agent_type` — even when
   * compaction fires from a subagent context. Keep parity by skipping
   * createBaseInput's extras.
   */
  private async createCompactBaseInput(
    eventName: HookEventName,
    model?: string,
  ): Promise<HookInput> {
    return {
      ...(await this.createCoreBaseInput(eventName, model)),
      cwd: getCwd(),
    };
  }

  /**
   * Log hook execution for observability
   */
  private logHookExecution(
    eventName: HookEventName,
    results: HookExecutionResult[],
    aggregated: AggregatedHookResult,
  ): void {
    const failedHooks = results.filter((r) => !r.success);
    const successCount = results.length - failedHooks.length;
    const errorCount = failedHooks.length;

    if (errorCount > 0) {
      // Only exit code 2 represents an explicit hook policy decision (deny/block).
      // All other failures (exit 1, spawn errors, timeouts) are non-blocking.
      const nonBlockingHooks = failedHooks.filter(
        (r) => r.exitCode !== EXIT_CODE_BLOCK,
      );
      const blockingFailedHooks = failedHooks.filter(
        (r) => r.exitCode === EXIT_CODE_BLOCK,
      );

      const failedNames = failedHooks
        .map((r) => getHookDisplayText(r.hookConfig))
        .join(', ');

      runLogger.warn(
        `Hook execution for ${eventName}: ${successCount} succeeded, ${errorCount} failed (${failedNames}), ` +
          `total duration: ${aggregated.totalDuration}ms`,
      );

      if (blockingFailedHooks.length > 0) {
        const blockingFailedNames = blockingFailedHooks
          .map((r) => getHookDisplayText(r.hookConfig))
          .join(', ');
        const details = blockingFailedHooks
          .map((r) => {
            const name = getHookDisplayText(r.hookConfig);
            const parts = [`  ${name}: ${String(r.error ?? 'unknown error')}`];
            if (r.exitCode !== undefined) parts.push(`exit code ${r.exitCode}`);
            if (r.stderr) parts.push(`stderr: ${r.stderr.slice(0, 1024)}`);
            return parts.join(', ');
          })
          .join('\n');
        runLogger.warn(
          `Blocking hook failure(s) [${blockingFailedNames}] for ${eventName}:\n${details}`,
        );
      }

      if (nonBlockingHooks.length > 0) {
        const nonBlockingNames = nonBlockingHooks
          .map((r) => getHookDisplayText(r.hookConfig))
          .join(', ');
        runLogger.warn(
          `Non-blocking hook error(s) for ${eventName}: [${nonBlockingNames}] exited with non-zero code. Continuing execution.`,
        );
      }

      // Log stdout/stderr for all failed hooks so users can diagnose failures
      for (const r of failedHooks) {
        const name = getHookDisplayText(r.hookConfig);
        if (r.stdout) {
          runLogger.warn(`Hook [${name}] stdout:\n${r.stdout.slice(0, 4096)}`);
        }
        if (r.stderr) {
          runLogger.warn(`Hook [${name}] stderr:\n${r.stderr.slice(0, 4096)}`);
        }
      }
    } else {
      runLogger.debug(
        `Hook execution for ${eventName}: ${successCount} hooks executed successfully, ` +
          `total duration: ${aggregated.totalDuration}ms`,
      );
    }

    // Log individual errors
    for (const error of aggregated.errors) {
      runLogger.warn(`Hook execution error: ${error.message}`);
    }
  }

  /**
   * Process common hook output fields centrally.
   * Note: additionalContext is pushed explicitly at each call site to avoid ALS issues.
   */
  private processCommonHookOutputFields(
    aggregated: AggregatedHookResult,
    _eventName: HookEventName,
  ): void {
    if (!aggregated.finalOutput) {
      return;
    }

    const systemMessage = aggregated.finalOutput.systemMessage;
    if (systemMessage && !aggregated.finalOutput.suppressOutput) {
      runLogger.debug(`Hook system message: ${systemMessage}`);
    }

    if (aggregated.finalOutput.shouldStopExecution()) {
      const stopReason = aggregated.finalOutput.getEffectiveReason();
      runLogger.debug(`Hook requested to stop execution: ${stopReason}`);
    }
  }
}
