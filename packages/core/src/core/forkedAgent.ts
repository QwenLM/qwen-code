/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import type { ModelSelection } from '../provider/model/modelSelection.js';
import type { ModelPolicyLabels } from './model-policy.js';
import { modelConfigFromGeneration } from '../config/generation-config.js';
import { mergeModelConfig } from '../provider/model/modelConfig.js';
import { readAgentSelectionDefaults } from '../agents/agentModelConfig.js';

import { createToolFileStateCache } from '../utils/fileStateCache.js';
import type { FileStateCache } from '../utils/fileStateCache.js';
import { query, type QueryParams } from './agent-loop.js';
import {
  withForkAccounting,
  type ForkExecution,
  type ForkedAgentCompletion,
  type ForkedAgentResult,
} from './fork-accounting.js';
import { collectQueryResults } from './query-result-collector.js';
import {
  getCustomContextFromContext,
  sessionIdContext,
  snapshotCustomContext,
} from '../utils/sessionIdContext.js';
import {
  runSingleRequestFork,
  type SingleRequestForkParams,
} from './single-request-fork.js';
import type {
  ModelStreamMessage,
  ModelToolChoice,
} from '../provider/modelStreamRequest.js';
import type { Message } from '../protocol/transcript/message.js';
import type { ModelRequestObserver } from '../model-request/types.js';
import type { QueryEvent } from './query-event.js';
import type { ToolExecutor } from '../tool-executor/index.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import type { AgentLoopContext } from '../config/agent-loop-context.js';

import type { HookCoordinatorAdapter } from './hook-coordinator-types.js';
import type { ReasoningEffortLevel } from '../config/model-values.js';
import type { SidechainTranscriptRecorder } from '../services/transcript/writer-handle.js';
import {
  attachSubagentMessageContext,
  attachSubagentQueryEventContext,
} from '../agents/subagent-message-context.js';
import type { BusinessInfo } from '../qoder/business-info.js';
import type { LlmGenerationConfig } from '../config/generation-config.js';
import type { AttachmentToolUseContext } from '../attachments/types.js';
import type { SystemPrompt } from '../prompts/types.js';

export type {
  ForkedAgentCompletion,
  ForkedAgentResult,
} from './fork-accounting.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type { SingleRequestForkParams } from './single-request-fork.js';

export interface ForkedAgentParams {
  mode?: 'agent';
  config: Config;
  /** 父请求的完整选择，沿用到 fork，不重复选模。 */
  parentSelection?: ModelSelection;
  /** 仅 compact / partial-compact 摘要使用；复用提前确定的压缩选择。 */
  compactSelection?: ModelSelection;
  policyLabels?: ModelPolicyLabels;
  /** The prompt text for the fork (becomes query()'s `prompt` → user message). */
  prompt: string;
  /** Root session ID. Fork owners must preserve it across async boundaries. */
  sessionId: string;
  /** 显式模型要求；省略时由 select 使用会话模型，父快照路径仍原样复用。 */
  model?: string;
  /** Tracing / prompt ID. */
  promptId: string;
  /** System prompt passed to the forked agent. Parent forks provide exact blocks. */
  systemPrompt?: SystemPrompt;
  /**
   * 父请求的标准模型消息前缀，直接复用于 fork 请求。
   * Passed as `preProjectedMessages` to query(), bypassing normalizeMessagesForAPI().
   */
  forkContextMessages?: readonly ModelStreamMessage[];
  /** Context baselines in that exact prefix, used for deduplication without replay. */
  contextAttachmentMessages?: readonly Message[];
  /** Label for logging / analytics (e.g. 'compact', 'partial-compact'). */
  forkLabel: string;
  /** 带工具 fork 的稳定子 Agent 类型，同时作为 `business.sub_task`。 */
  agentType?: string;
  /** Source identifier for request routing and diagnostics. */
  querySource?: string;
  /** Maximum agent loop turns. Defaults to one. */
  maxTurns?: number;
  /** Abort signal for cancellation. */
  signal?: AbortSignal;
  /** Optional callback invoked for each QueryEvent as it arrives. */
  onEvent?: (event: QueryEvent) => void;

  // -- Tool execution (optional — omit for text-only forks like compact) --

  /** Agent-level schema surface; when provided, the fork can use tools. */
  toolRegistry?: ToolRegistry;
  /** Session executor override; defaults to the Config-owned one. */
  toolExecutor?: ToolExecutor;
  /** Schema-only fork: advertise tools but reject execution. */
  executionDisabled?: boolean;
  /** Agent whose registry, snapshots and callbacks tool execution uses. */
  agentContext?: AgentLoopContext;
  /** Provider-level tool choice constraint; schemas may still be advertised. */
  toolChoice?: ModelToolChoice;

  // -- Optional collaborators --

  /** Hook coordinator for before/after agent lifecycle hooks. */
  hookCoordinator?: HookCoordinatorAdapter;
  /**
   * Attachment state for tool-enabled forks. Text-only forks omit this to keep
   * their query loop lightweight.
   */
  attachmentCtx?: AttachmentToolUseContext;
  fileReadState?: FileStateCache;
  /** Max output tokens override. */
  maxOutputTokens?: number;
  /** Thinking budget for reasoning models. */
  thinkingBudget?: number;
  /** Explicit reasoning effort level for reasoning models. */
  reasoningEffort?: ReasoningEffortLevel;
  /** Unified generation config for the fork model. */
  generation?: LlmGenerationConfig;
  /** Explicit context window for the forked request. */
  contextWindow?: number;
  /**
   * Reuse the parent's cached prefix without writing this fork's one-off
   * prompt as the next cache breakpoint.
   */
  skipCacheWrite?: boolean;
  /** Sidechain transcript writer for this fork invocation. */
  transcriptWriter?: SidechainTranscriptRecorder;
  /** Optional initial runtime messages to seed the sidechain transcript. */
  initialTranscriptMessages?: readonly Message[];
  /** Runtime agent identity used on sidechain transcript entries. */
  transcriptAgentId?: string;
  /** Parent Agent tool_use_id for parent-child message attribution. */
  parentToolUseId?: string;
  /**
   * Parent agent's requestSetId for request grouping.
   * Explicit params take priority over AsyncLocalStorage fallback.
   */
  parentRequestSetId?: string;
  /** Opaque SDK context inherited only when explicitly supplied by an Agent. */
  customContext?: Readonly<Record<string, string>>;
  /**
   * Parent agent's BusinessInfo for lifecycle inheritance (read-only).
   * Explicit params take priority over AsyncLocalStorage fallback.
   */
  parentBusinessInfo?: Readonly<BusinessInfo>;

  /**
   * Workspace directories for Codebase C4 header injection.
   * Propagated to query() → streamProviderRequest → sendRemoteChatAsk
   * so that `Cosy-Codebase-*` headers are injected for forked agent calls.
   */
  workdirs?: readonly string[];

  /**
   * Parent session ID for diagnostic event routing. When set, fork lifecycle
   * events (`fork.agent.started` / `fork.agent.completed`) are written to the
   * parent session's log segment so they're visible alongside the main
   * conversation — not buried in the fork's own random session segment.
   */
  sessionScopeId?: string;
  /** Best-effort completion observer used by the owning domain event. */
  onCompleted?: (completion: ForkedAgentCompletion) => void;
  /** Passive request-attempt observer inherited from the owning operation. */
  onObservation?: ModelRequestObserver;
}

function forkQuerySelection({
  parentSelection,
  compactSelection,
  model,
  generation,
  reasoningEffort,
  contextWindow,
  maxOutputTokens,
  thinkingBudget,
}: ForkedAgentParams): QueryParams['querySelection'] {
  if (
    parentSelection ||
    compactSelection ||
    (model === undefined &&
      generation === undefined &&
      reasoningEffort === undefined &&
      contextWindow === undefined &&
      maxOutputTokens === undefined &&
      thinkingBudget === undefined)
  )
    return undefined;
  return {
    key: model,
    config: mergeModelConfig(
      modelConfigFromGeneration(generation, reasoningEffort, contextWindow),
      {
        context: { maxOutputTokens },
        ...(thinkingBudget !== undefined
          ? {
              reasoning: {
                thinking:
                  thinkingBudget > 0
                    ? { type: 'enabled', budgetTokens: thinkingBudget }
                    : { type: 'disabled' },
              },
            }
          : {}),
      },
    ),
  };
}

/**
 * Runs a fork with shared request accounting. Existing callers use the agent loop.
 *
 * @example
 * ```typescript
 * const result = await runForkedAgent({
 *   prompt: 'Summarize the conversation into <analysis> and <summary> blocks.',
 *   sessionId: 'root-session-id',
 *   model: 'qwen-max',
 *   promptId: 'compress-123',
 *   systemPrompt: parentSystemPrompt,
 *   forkContextMessages: parentHistoryAsMessageParams,
 *   forkLabel: 'compact',
 *   maxTurns: 1,
 * });
 * console.log(result.textContent); // "<analysis>...</analysis>\n<summary>...</summary>"
 * ```
 */
export function runForkedAgent(
  params: ForkedAgentParams | SingleRequestForkParams,
): Promise<ForkedAgentResult>;
export function runForkedAgent(
  params: ForkedAgentParams,
): Promise<ForkedAgentResult>;
export async function runForkedAgent(
  params: ForkedAgentParams | SingleRequestForkParams,
): Promise<ForkedAgentResult> {
  const singleRequest = params.mode === 'singleRequest';
  const fork: ForkExecution = singleRequest
    ? {
        model: params.selection.model.key,
        promptId: params.parent.completedTurn.promptId,
        forkLabel: params.querySource,
        sessionScopeId: params.parent.completedTurn.sessionId,
        customContext: params.parent.completedTurn.customContext ?? {},
        onCompleted: params.onCompleted,
        execute: (request) => runSingleRequestFork(params, request),
      }
    : await prepareAgentLoopFork(params);

  const run = () => withForkAccounting(fork);
  return singleRequest
    ? sessionIdContext.run(params.parent.completedTurn.sessionId, run)
    : run();
}

async function prepareAgentLoopFork(
  params: ForkedAgentParams,
): Promise<ForkExecution> {
  const {
    prompt,
    model: requestedModel,
    promptId,
    systemPrompt,
    forkContextMessages,
    forkLabel,
    agentType,
    signal,
    onEvent,
    toolRegistry,
    toolExecutor,
    hookCoordinator,
    attachmentCtx,
    sessionId,
    transcriptWriter,
    initialTranscriptMessages,
    transcriptAgentId,
    parentToolUseId,
    workdirs,
  } = params;

  const model =
    requestedModel ??
    params.compactSelection?.model.key ??
    params.parentSelection?.model.key ??
    (toolRegistry
      ? readAgentSelectionDefaults(
          params.config,
          {
            agentId: attachmentCtx?.agentId,
            agentType: agentType ?? forkLabel,
          },
          'fork',
        )?.key
      : undefined) ??
    params.config.getModel();

  const effectiveCustomContext =
    params.customContext ?? getCustomContextFromContext();
  const startTime = Date.now();
  let lastRecordedUuid: string | null = null;

  if (
    transcriptWriter &&
    transcriptAgentId &&
    initialTranscriptMessages &&
    initialTranscriptMessages.length > 0
  ) {
    lastRecordedUuid = await transcriptWriter.recordSidechainMessages(
      initialTranscriptMessages,
      transcriptAgentId,
    );
  }

  const decorateMessage =
    sessionId || parentToolUseId
      ? (message: Message) =>
          attachSubagentMessageContext(message, {
            sessionId: sessionId ?? message.sessionId ?? '',
            parentToolUseId,
          })
      : undefined;
  const decorateEvent =
    sessionId || parentToolUseId
      ? (event: QueryEvent) =>
          attachSubagentQueryEventContext(event, {
            sessionId: sessionId ?? '',
            parentToolUseId,
          })
      : undefined;

  return {
    model,
    promptId,
    forkLabel,
    sessionScopeId: params.sessionScopeId,
    onCompleted: params.onCompleted,
    customContext: snapshotCustomContext(effectiveCustomContext),
    startedAt: startTime,
    execute(request) {
      const generator = query({
        ...request,
        config: params.config,
        policyLabels: params.policyLabels,
        prompt,
        sessionId,
        systemPrompt,
        signal,
        workdirs,
        onModelRequestObservation: params.onObservation,
        agentContext: params.agentContext,
        querySelection: forkQuerySelection(params),
        turnHookFactories: params.config.turnHookFactories,
        modelPurpose:
          params.compactSelection &&
          (forkLabel === 'compact' || forkLabel === 'partial-compact')
            ? 'compact'
            : 'fork',
        parentSelection: params.parentSelection,
        compactSelection: params.compactSelection,
        querySource: params.querySource,
        preProjectedMessages: forkContextMessages,
        messages:
          forkContextMessages && params.contextAttachmentMessages
            ? [...params.contextAttachmentMessages]
            : undefined,
        maxTurns: params.maxTurns ?? 1,
        skipCacheWrite: params.skipCacheWrite,
        toolRegistry,
        toolExecutor,
        executionDisabled: params.executionDisabled,
        toolChoice: params.toolChoice,
        hookCoordinator,
        ...(attachmentCtx ? { attachmentCtx } : {}),
        fileReadState:
          attachmentCtx?.fileReadState ??
          params.fileReadState ??
          createToolFileStateCache(),
        ...(toolRegistry
          ? {
              isSubagent: true,
              agentId: attachmentCtx?.agentId,
              agentType: agentType ?? forkLabel,
              parentRequestSetId: params.parentRequestSetId,
              parentBusinessInfo: params.parentBusinessInfo,
            }
          : {}),
      });
      return collectQueryResults(
        generator,
        onEvent
          ? (event) => onEvent(decorateEvent ? decorateEvent(event) : event)
          : undefined,
        async (message) => {
          if (!transcriptWriter || !transcriptAgentId) {
            return;
          }
          lastRecordedUuid = await transcriptWriter.recordSidechainMessages(
            [message],
            transcriptAgentId,
            lastRecordedUuid,
          );
        },
        decorateMessage,
      );
    },
  };
}
