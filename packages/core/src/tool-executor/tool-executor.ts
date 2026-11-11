/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AgentLoopContext } from '../config/agent-loop-context.js';
import type { ModelToolUseBlock } from '../provider/event/modelCompleteEvent.js';
import type { QueryEvent } from '../core/query-event.js';
import type {
  ToolExecutionSummary,
  ToolExecutionSummaryOptions,
} from './streaming/tool-execution-summary.js';
import type { ToolResultBlock } from '../core/tool-result.js';
import type { ToolPermissionDenial } from '../core/tool-result.js';
import type { HookAttachment } from '../attachments/types.js';
import type { UserMessage } from '../protocol/transcript/message.js';
import type { ImagePreparationContext } from '../hooks/imagePrepare.js';
import type { ToolUseContext } from '../tools/tool-types.js';
import type { ToolSettlement } from './types.js';
import type { ToolLiveOutput } from '../tools/tools.js';
import type { Model } from '../provider/model/model.js';
import type { RepeatedCallStats } from './streaming/repeated-tool-call.js';

/** Reason carried by the response signal when the model refused the turn. */
export const REFUSAL_REASON = 'model-refusal';

export const REFUSAL_UNKNOWN_TOOL_MODEL_CONTENT =
  'The tool execution outcome is unknown because the model response ended in refusal. ' +
  'The tool may not have run, may have partially completed, or may have completed. ' +
  'Do not assume rollback or repeat side-effecting work without first inspecting the current state.';

export const REFUSAL_UNKNOWN_TOOL_DISPLAY =
  'The model response ended in refusal before the tool result could be confirmed. ' +
  'The tool may not have run, may have partially completed, or may have completed. ' +
  'Inspect the current state before retrying or continuing.';

/** Per-call facts handed to the executor; never carries product rules. */
export interface ToolExecuteContext {
  /** Agent that owns this execution; carries registry, snapshots and config. */
  agentContext: AgentLoopContext;
  /** Loop-level context shared by every tool call in the query. */
  toolUseContext: ToolUseContext;
  signal: AbortSignal;
  /** Groups calls belonging to the same model response. */
  responseId: string;
  promptId: string;
  /** Session owning the query; established for every tool execution. */
  sessionId?: string;
  /** Parent request-set attribution for the execution context. */
  requestSetId?: string;
  /** Parent business attribution for the execution context. */
  businessInfo?: import('../qoder/business-info.js').BusinessInfo;
  assistantMessageUuid?: string;
  modelEntry?: Model;
  updateOutput?: (output: ToolLiveOutput) => void;
  /** Turn-scoped counters the executor increments; the loop only reports them. */
  repeatedCallStats?: RepeatedCallStats;
  /** Session-scoped allow list for repeated calls, owned by the host. */
  repeatedCallAllowedKeys?: Set<string>;
  /** Subagent label for gate reports; absent for the main agent. */
  agentType?: string;
  parentCallId?: string;
  maxConcurrency?: number;
  /** Schema-only fork: reject execution instead of running tools. */
  executionDisabled?: boolean;
  onCompletedToolCall?: (
    call: import('./types.js').CompletedToolCall,
  ) => void;
  /** Enables image upload/preparation for the history message. */
  imagePreparation?: ImagePreparationContext;
}

/** Control metadata the query loop uses to branch the turn. */
interface ToolResultControl {
  settlement: ToolSettlement;
  terminalReason?: string;
  permissionDenial?: ToolPermissionDenial;
  stopRequested?: boolean;
  attachments?: HookAttachment[];
  /** Skill overrides and permission overlays carried by the tool result. */
  contextModifier?: (context: ToolUseContext) => ToolUseContext;
}

/** Everything one tool call produces: the protocol block plus history and control. */
export interface ToolCallResult {
  block: ToolResultBlock;
  /** Extra meta messages the tool asked the query to inject. */
  supplementaryMessages: UserMessage[];
  /** The protocol message to append to conversation history. */
  historyMessage: UserMessage;
  control: ToolResultControl;
}

/**
 * Session-level tool execution contract. Implementations own per-agent
 * isolation internally (streaming, remote, ...).
 */
/** One agent's model-response batch and how to settle it. */
export interface ToolExecutionBatch extends ToolExecutionSummaryOptions {
  /** Model response that produced the batch. */
  responseId: string;
  signal: AbortSignal;
  sessionId: string;
  /** Forward session-wide task snapshots (root agent only). */
  includeSessionSnapshots?: boolean;
  /** Host deadline (epoch ms) bounding terminal settlement. */
  settlementDeadlineMs?: number;
  /** Present when waiting failed; every call settles as an error. */
  failure?: { error: unknown; cancelled: boolean };
}

export interface ToolExecutor {
  execute(
    block: ModelToolUseBlock,
    ctx: ToolExecuteContext,
  ): Promise<ToolCallResult>;
  /** Settle this batch, forwarding subagent events. */
  waitForExecutions(
    batch: ToolExecutionBatch,
  ): AsyncGenerator<QueryEvent, ToolExecutionSummary>;
  /** Settle this batch without forwarding subagent events. */
  stopExecution(batch: ToolExecutionBatch): Promise<ToolExecutionSummary>;
  dispose(): void;
}
