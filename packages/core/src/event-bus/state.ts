/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AgentLoopContext } from '../config/agent-loop-context.js';
import type { Config } from '../config/config.js';
import type { SessionContextReason } from '../attachments/models/session-context-attachment.js';
import type { ModelRequestOutcome } from '../model-request/types.js';
import type { NonNullableUsage } from '../protocol/schemas/common.js';
import type {
  AssistantMessage,
  Message,
  UserMessage,
} from '../protocol/transcript/message.js';
import type { PromptBuildResult, SystemPrompt } from '../prompts/types.js';
import type {
  ModelMessage,
  ModelToolUseBlock,
} from '../provider/event/modelCompleteEvent.js';
import type { ModelStreamTool } from '../provider/modelStreamRequest.js';
import type { ModelSelection } from '../provider/model/modelSelection.js';
import type { Model } from '../provider/model/model.js';
import type { BusinessInfo } from '../qoder/business-info.js';
import type { TaskTrigger } from '../core/task-trigger.js';
import type { TaskRunStatsAccumulator } from '../core/task-run-stats.js';
import type { ToolExecutionSummary } from '../tool-executor/index.js';
import type { QueryLifecycle, ToolUseContext } from '../tools/tool-types.js';
import type { NormalizeMessagesForAPIOptions as ModelProjectionOptions } from '../protocol/provider/request-converter.js';
import type { AgentLifecycleState } from '../core/agent-lifecycle-state.js';
import type { CacheSafeQuerySnapshot } from '../core/cache-safe-query-snapshot.js';
import type { CompressionRequestModel } from '../core/compact-request-resolver.js';
import type {
  ModelPolicyLabels,
  ModelPolicySelectContext,
} from '../core/model-policy.js';
import type { QueryParams } from '../core/query-params.js';
import type { Terminal } from '../core/query-event.js';
import type { QueryRuntimeState } from '../core/query-runtime-state.js';
import type { createQueryRequestMessages } from '../core/query-request-messages.js';
import type { QueryTurn } from '../core/query-turn.js';
import type { LlmFailureKind, LlmOutcome, RequestReason } from './events.js';

export interface QueryEndNotificationState {
  requestSetId?: string;
  businessId?: string;
  model: string;
  reason?: Terminal['reason'];
}

/** Written by query() at creation and read-only afterwards. */
export interface QueryInput {
  readonly queryId: string;
  readonly parentQueryId?: string;
  readonly sessionId: string;
  /** The caller's parameters; `signal` is not read by handlers. */
  readonly params: Readonly<QueryParams>;
  readonly config: Config;
  readonly promptText: string;
  readonly startTime: number;
  readonly turn: QueryTurn;
  readonly taskRunStats: TaskRunStatsAccumulator;
  readonly queryEndState: QueryEndNotificationState;
  readonly toolAgentContext: AgentLoopContext;
  readonly selectInput: ModelPolicySelectContext;
  readonly startupMemoryPrefix: readonly Message[];
  /** Binds session, request set, business and request context for handler work. */
  readonly runInContext: <T>(fn: () => T) => T;
}

/** Selection and prompt state; Llm produces it, Conversation writes it. */
export interface QueryModelState {
  resolution: ModelSelection;
  readonly requestMessages: ReturnType<typeof createQueryRequestMessages>;
  key: string;
  systemPrompt?: SystemPrompt;
  promptResult?: PromptBuildResult;
  policyLabels?: ModelPolicyLabels;
  selectionSource: CompressionRequestModel['source'];
  selectedSkillModel?: string;
  thinkingBudget?: number;
  contextWindow?: number;
  readonly initialThinkingBudget?: number;
  readonly initialMaxOutputTokens?: number;
}

/** Facts fixed when the request is assembled; tools of this round use them. */
export interface RoundDispatch {
  modelRequestId: string;
  responseGroupId: string;
  modelKey: string;
  modelEntry: Model;
  toolUseContext: ToolUseContext;
}

/** What request preparation changed; Conversation writes it on llm.settled. */
export interface PreparedRequest {
  runtime: QueryRuntimeState;
  model?: QueryModelState;
  sessionContextReason: SessionContextReason;
  requestSent: boolean;
  nextTurnCount: number;
  iterationStartMs: number;
  modelRequestId?: string;
  responseGroupId?: string;
  canonicalModelKey?: string;
  toolSchemas: ModelStreamTool[];
  projectionOptions?: ModelProjectionOptions;
  requestPrefixMessages: readonly Message[];
  requestSnapshot?: CacheSafeQuerySnapshot;
  /** Captured with the request; a completed end-turn checkpoint carries it. */
  parentTurn?: CacheSafeQuerySnapshot['completedTurn'];
  hasPendingUserMessage: boolean;
}

export interface ModelResult {
  outcome: LlmOutcome;
  failure?: LlmFailureKind;
  prepared: PreparedRequest;
  /** Complete response, or the delivered part of an interrupted one. */
  modelMessage?: ModelMessage;
  interrupted?: Extract<ModelRequestOutcome, { kind: 'interrupted' }>;
  terminalInterruption: boolean;
  usage?: NonNullableUsage;
  toolUseBlocks: ModelToolUseBlock[];
  dispatchedToolUseBlocks: ModelToolUseBlock[];
  responseText: string;
  malformedToolUse: boolean;
  nextMaxOutputTokens?: number;
  /** complete / interrupted: the split response; failed: dispatched tool parts. */
  assistantMessages: AssistantMessage[];
  iterationHadThought: boolean;
  error?: unknown;
}

export interface QueryRound {
  readonly roundId: string;
  readonly reason: RequestReason;
  readonly requestIndex: number;
  /** The failure that triggered this request, when it is a recovery. */
  readonly cause?: unknown;
  /** Written once by Llm after the query's first selection. */
  selection?: QueryModelState;
  /** Task trigger returned by turn.runStart after the first selection. */
  taskTrigger?: TaskTrigger;
  /** Written once by Llm before the response streams. */
  dispatch?: RoundDispatch;
  /** Written once by Llm, then llm.settled. */
  modelResult?: ModelResult;
  /** Written by Tool: its working state for this round. */
  tools?: ToolRound;
  /** Written once by Tool, then tool.settled. */
  toolSummary?: ToolExecutionSummary;
}

/** Owned by Tool: one round's dispatched calls and how they settle. */
export interface ToolRound {
  /** Aborting it settles this response's in-flight calls. */
  readonly responseController: AbortController;
  responseSignal?: AbortSignal;
  readonly dispatched: ModelToolUseBlock[];
  pendingToolResponseId?: string;
  cancelled: boolean;
  /** Resolves on tool.cancel or query cancellation. */
  readonly cancellation: Promise<void>;
  resolveCancellation(): void;
  settling: boolean;
}

export interface QueryTerminalSlot {
  terminal?: Terminal;
  /** Rethrown by query() after QueryEnd. */
  thrownError?: unknown;
  thrown: boolean;
}

/** Created by query() with the state; the controllers are shared by the handlers. */
export interface QueryControl {
  /** Aborted by query() when the query is cancelled. */
  readonly abort: AbortController;
  /** Aborted by Conversation when the turn ends on a refusal or interruption. */
  readonly turnAbort: AbortController;
  /** Either of the two; tools receive it through ToolUseContext. */
  readonly toolSignal: AbortSignal;
  /** Cleanups run by Conversation when the query finishes. */
  readonly queryLifecycle: QueryLifecycle;
}

/** The settled response the tool continuation still needs. */
export interface SettledRound {
  readonly round: QueryRound;
  readonly result: ModelResult;
  readonly modelMessage?: ModelMessage;
  readonly usage?: NonNullableUsage;
  readonly toolUseBlocks: ModelToolUseBlock[];
  readonly assistantMessages: AssistantMessage[];
  readonly responseText: string;
  readonly interrupted?: Extract<ModelRequestOutcome, { kind: 'interrupted' }>;
  terminalInterruption: boolean;
  readonly canonicalModelKey: string;
  readonly modelRequestId?: string;
  readonly nextTurnCount: number;
  readonly loopId: string;
  stateAfterAssistant?: QueryRuntimeState;
  streamRecoveryMessages: Message[];
}

/** What Conversation does once this round's tools are settled. */
export type ToolContinuation =
  | { kind: 'abort_streaming' }
  | { kind: 'request_error'; error: unknown; isModelRefusal: boolean }
  | { kind: 'refusal' }
  | { kind: 'aborted_after_assistant' }
  | { kind: 'tool_results' }
  | { kind: 'release_then_request'; reason: RequestReason; cause?: unknown };

/** Conversation's bookkeeping between events. */
export interface ConversationFlow {
  llmInFlight: boolean;
  toolsInFlight: boolean;
  /** Set once Conversation itself failed; it then only waits to finalize. */
  failure?: { error: unknown };
  finishing: boolean;
  businessFinishStarted: boolean;
  settled?: SettledRound;
  afterTools?: ToolContinuation;
}

export interface QueryState {
  readonly input: QueryInput;
  readonly control: QueryControl;
  /** Written only by Conversation. */
  flow: ConversationFlow;
  // Context: written only by Conversation.
  runtime: QueryRuntimeState;
  toolUseContext: ToolUseContext;
  model?: QueryModelState;
  usage: NonNullableUsage;
  requestIndex: number;
  userMessage?: UserMessage;
  businessInfo?: Readonly<BusinessInfo>;
  lifecycle?: AgentLifecycleState;
  cumulativeResponseText: string;
  toolStreamRecoveryCount: number;
  sessionContextReason: SessionContextReason;
  /** Prefix of the last sent request, reused by reactive compaction. */
  lastRequestPrefixMessages: readonly Message[];
  task: {
    trigger?: TaskTrigger;
    started: boolean;
    terminalReported: boolean;
  };
  round?: QueryRound;
  terminal?: QueryTerminalSlot;
}

export interface QueryStateStore {
  create(input: QueryInput, initial: Omit<QueryState, 'input'>): QueryState;
  get(queryId: string): QueryState | undefined;
  delete(queryId: string): void;
}

export function createQueryStateStore(): QueryStateStore {
  const states = new Map<string, QueryState>();
  return {
    create(input, initial) {
      if (states.has(input.queryId)) {
        throw new Error(`Query ${input.queryId} already exists.`);
      }
      const state: QueryState = { input, ...initial };
      states.set(input.queryId, state);
      return state;
    },
    get: (queryId) => states.get(queryId),
    delete: (queryId) => {
      states.delete(queryId);
    },
  };
}

/** The round an event belongs to, or undefined for a late event. */
export function currentRound(
  state: QueryState | undefined,
  roundId: string | undefined,
): QueryRound | undefined {
  const round = state?.round;
  if (!round || roundId === undefined || round.roundId !== roundId) {
    return undefined;
  }
  return round;
}
