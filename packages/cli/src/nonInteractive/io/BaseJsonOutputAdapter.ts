/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import type {
  Config,
  ToolCallRequestInfo,
  ToolCallResponseInfo,
  SessionMetrics,
  ServerGeminiStreamEvent,
  TaskResultDisplay,
} from '@qwen-code/qwen-code-core';
import {
  GeminiEventType,
  ToolErrorType,
  parseAndFormatApiError,
} from '@qwen-code/qwen-code-core';
import type { Part, GenerateContentResponseUsageMetadata } from '@google/genai';
import type {
  CLIAssistantMessage,
  CLIMessage,
  CLIPermissionDenial,
  CLIResultMessage,
  CLIResultMessageError,
  CLIResultMessageSuccess,
  CLIUserMessage,
  ContentBlock,
  ExtendedUsage,
  TextBlock,
  ThinkingBlock,
  ToolResultBlock,
  ToolUseBlock,
  Usage,
} from '../types.js';
import { functionResponsePartsToString } from '../../utils/nonInteractiveHelpers.js';

/**
 * Internal state for managing a single message context (main agent or subagent).
 */
export interface MessageState {
  messageId: string | null;
  blocks: ContentBlock[];
  openBlocks: Set<number>;
  usage: Usage;
  messageStarted: boolean;
  finalized: boolean;
  currentBlockType: ContentBlock['type'] | null;
}

/**
 * Options for building result messages.
 * Used by both streaming and non-streaming JSON output adapters.
 */
export interface ResultOptions {
  readonly isError: boolean;
  readonly errorMessage?: string;
  readonly durationMs: number;
  readonly apiDurationMs: number;
  readonly numTurns: number;
  readonly usage?: ExtendedUsage;
  readonly stats?: SessionMetrics;
  readonly summary?: string;
  readonly subtype?: string;
}

/**
 * Interface for message emission strategies.
 * Implementations decide whether to emit messages immediately (streaming)
 * or collect them for batch emission (non-streaming).
 * This interface defines the common message emission methods that
 * all JSON output adapters should implement.
 */
export interface MessageEmitter {
  emitMessage(message: CLIMessage): void;
  emitUserMessage(parts: Part[], parentToolUseId?: string | null): void;
  emitToolResult(
    request: ToolCallRequestInfo,
    response: ToolCallResponseInfo,
    parentToolUseId?: string | null,
  ): void;
  emitSystemMessage(subtype: string, data?: unknown): void;
}

/**
 * JSON-focused output adapter interface.
 * Handles structured JSON output for both streaming and non-streaming modes.
 * This interface defines the complete API that all JSON output adapters must implement.
 */
export interface JsonOutputAdapterInterface extends MessageEmitter {
  startAssistantMessage(): void;
  processEvent(event: ServerGeminiStreamEvent): void;
  finalizeAssistantMessage(): CLIAssistantMessage;
  emitResult(options: ResultOptions): void;

  startSubagentAssistantMessage?(parentToolUseId: string): void;
  processSubagentToolCall?(
    toolCall: NonNullable<TaskResultDisplay['toolCalls']>[number],
    parentToolUseId: string,
  ): void;
  finalizeSubagentAssistantMessage?(
    parentToolUseId: string,
  ): CLIAssistantMessage;
  emitSubagentErrorResult?(
    errorMessage: string,
    numTurns: number,
    parentToolUseId: string,
  ): void;

  getSessionId(): string;
  getModel(): string;
}

/**
 * Abstract base class for JSON output adapters.
 * Contains shared logic for message building, state management, and content block handling.
 */
export abstract class BaseJsonOutputAdapter {
  protected readonly config: Config;

  // Main agent message state
  protected mainAgentMessageState: MessageState;

  // Subagent message states keyed by parentToolUseId
  protected subagentMessageStates = new Map<string, MessageState>();

  // Last assistant message for result generation
  protected lastAssistantMessage: CLIAssistantMessage | null = null;

  // Track permission denials (execution denied tool calls)
  protected permissionDenials: CLIPermissionDenial[] = [];

  constructor(config: Config) {
    this.config = config;
    this.mainAgentMessageState = this.createMessageState();
  }

  /**
   * Creates a new message state with default values.
   */
  protected createMessageState(): MessageState {
    return {
      messageId: null,
      blocks: [],
      openBlocks: new Set<number>(),
      usage: this.createUsage(),
      messageStarted: false,
      finalized: false,
      currentBlockType: null,
    };
  }

  /**
   * Gets or creates message state for a given context.
   *
   * @param parentToolUseId - null for main agent, string for subagent
   * @returns MessageState for the context
   */
  protected getMessageState(parentToolUseId: string | null): MessageState {
    if (parentToolUseId === null) {
      return this.mainAgentMessageState;
    }

    let state = this.subagentMessageStates.get(parentToolUseId);
    if (!state) {
      state = this.createMessageState();
      this.subagentMessageStates.set(parentToolUseId, state);
    }
    return state;
  }

  /**
   * Creates a Usage object from metadata.
   *
   * @param metadata - Optional usage metadata from Gemini API
   * @returns Usage object
   */
  protected createUsage(
    metadata?: GenerateContentResponseUsageMetadata | null,
  ): Usage {
    const usage: Usage = {
      input_tokens: 0,
      output_tokens: 0,
    };

    if (!metadata) {
      return usage;
    }

    if (typeof metadata.promptTokenCount === 'number') {
      usage.input_tokens = metadata.promptTokenCount;
    }
    if (typeof metadata.candidatesTokenCount === 'number') {
      usage.output_tokens = metadata.candidatesTokenCount;
    }
    if (typeof metadata.cachedContentTokenCount === 'number') {
      usage.cache_read_input_tokens = metadata.cachedContentTokenCount;
    }
    if (typeof metadata.totalTokenCount === 'number') {
      usage.total_tokens = metadata.totalTokenCount;
    }

    return usage;
  }

  /**
   * Builds a CLIAssistantMessage from the current message state.
   *
   * @param parentToolUseId - null for main agent, string for subagent
   * @returns CLIAssistantMessage
   */
  protected buildMessage(parentToolUseId: string | null): CLIAssistantMessage {
    const state = this.getMessageState(parentToolUseId);

    if (!state.messageId) {
      throw new Error('Message not started');
    }

    // Enforce constraint: assistant message must contain only a single type of ContentBlock
    if (state.blocks.length > 0) {
      const blockTypes = new Set(state.blocks.map((block) => block.type));
      if (blockTypes.size > 1) {
        throw new Error(
          `Assistant message must contain only one type of ContentBlock, found: ${Array.from(blockTypes).join(', ')}`,
        );
      }
    }

    // Determine stop_reason based on content block types
    // If the message contains only tool_use blocks, set stop_reason to 'tool_use'
    const stopReason =
      state.blocks.length > 0 &&
      state.blocks.every((block) => block.type === 'tool_use')
        ? 'tool_use'
        : null;

    return {
      type: 'assistant',
      uuid: state.messageId,
      session_id: this.config.getSessionId(),
      parent_tool_use_id: parentToolUseId,
      message: {
        id: state.messageId,
        type: 'message',
        role: 'assistant',
        model: this.config.getModel(),
        content: state.blocks,
        stop_reason: stopReason,
        usage: state.usage,
      },
    };
  }

  /**
   * Finalizes pending blocks (text or thinking) by closing them.
   *
   * @param state - Message state to finalize blocks for
   * @param parentToolUseId - null for main agent, string for subagent (optional, defaults to null)
   */
  protected finalizePendingBlocks(
    state: MessageState,
    parentToolUseId?: string | null,
  ): void {
    const actualParentToolUseId = parentToolUseId ?? null;
    const lastBlock = state.blocks[state.blocks.length - 1];
    if (!lastBlock) {
      return;
    }

    if (lastBlock.type === 'text') {
      const index = state.blocks.length - 1;
      this.onBlockClosed(state, index, actualParentToolUseId);
      this.closeBlock(state, index);
    } else if (lastBlock.type === 'thinking') {
      const index = state.blocks.length - 1;
      this.onBlockClosed(state, index, actualParentToolUseId);
      this.closeBlock(state, index);
    }
  }

  /**
   * Opens a block (adds to openBlocks set).
   *
   * @param state - Message state
   * @param index - Block index
   * @param _block - Content block
   */
  protected openBlock(
    state: MessageState,
    index: number,
    _block: ContentBlock,
  ): void {
    state.openBlocks.add(index);
  }

  /**
   * Closes a block (removes from openBlocks set).
   *
   * @param state - Message state
   * @param index - Block index
   */
  protected closeBlock(state: MessageState, index: number): void {
    if (!state.openBlocks.has(index)) {
      return;
    }
    state.openBlocks.delete(index);
  }

  /**
   * Guarantees that a single assistant message aggregates only one
   * content block category (text, thinking, or tool use). When a new
   * block type is requested, the current message is finalized and a fresh
   * assistant message is started to honour the single-type constraint.
   *
   * @param state - Message state
   * @param targetType - Target block type
   * @param parentToolUseId - null for main agent, string for subagent
   */
  protected ensureBlockTypeConsistency(
    state: MessageState,
    targetType: ContentBlock['type'],
    parentToolUseId: string | null,
  ): void {
    if (state.currentBlockType === targetType) {
      return;
    }

    if (state.currentBlockType === null) {
      state.currentBlockType = targetType;
      return;
    }

    // Finalize current message and start new one
    this.finalizeAssistantMessageInternal(state, parentToolUseId);
    this.startAssistantMessageInternal(state);
    state.currentBlockType = targetType;
  }

  /**
   * Starts a new assistant message, resetting state.
   *
   * @param state - Message state to reset
   */
  protected startAssistantMessageInternal(state: MessageState): void {
    state.messageId = randomUUID();
    state.blocks = [];
    state.openBlocks = new Set<number>();
    state.usage = this.createUsage();
    state.messageStarted = false;
    state.finalized = false;
    state.currentBlockType = null;
  }

  /**
   * Finalizes an assistant message.
   *
   * @param state - Message state to finalize
   * @param parentToolUseId - null for main agent, string for subagent
   * @returns CLIAssistantMessage
   */
  protected finalizeAssistantMessageInternal(
    state: MessageState,
    parentToolUseId: string | null,
  ): CLIAssistantMessage {
    if (state.finalized) {
      return this.buildMessage(parentToolUseId);
    }
    state.finalized = true;

    this.finalizePendingBlocks(state, parentToolUseId);
    const orderedOpenBlocks = Array.from(state.openBlocks).sort(
      (a, b) => a - b,
    );
    for (const index of orderedOpenBlocks) {
      this.onBlockClosed(state, index, parentToolUseId);
      this.closeBlock(state, index);
    }

    const message = this.buildMessage(parentToolUseId);
    this.emitMessageImpl(message);
    return message;
  }

  /**
   * Abstract method for emitting messages. Implementations decide whether
   * to emit immediately (streaming) or collect for batch emission.
   * Note: The message object already contains parent_tool_use_id field,
   * so it doesn't need to be passed as a separate parameter.
   *
   * @param message - Message to emit (already contains parent_tool_use_id if applicable)
   */
  protected abstract emitMessageImpl(message: CLIMessage): void;

  /**
   * Abstract method to determine if stream events should be emitted.
   *
   * @returns true if stream events should be emitted
   */
  protected abstract shouldEmitStreamEvents(): boolean;

  /**
   * Hook method called when a text block is created.
   * Subclasses can override this to emit stream events.
   *
   * @param state - Message state
   * @param index - Block index
   * @param block - Text block that was created
   * @param parentToolUseId - null for main agent, string for subagent
   */
  protected onTextBlockCreated(
    _state: MessageState,
    _index: number,
    _block: TextBlock,
    _parentToolUseId: string | null,
  ): void {
    // Default implementation does nothing
  }

  /**
   * Hook method called when text content is appended.
   * Subclasses can override this to emit stream events.
   *
   * @param state - Message state
   * @param index - Block index
   * @param fragment - Text fragment that was appended
   * @param parentToolUseId - null for main agent, string for subagent
   */
  protected onTextAppended(
    _state: MessageState,
    _index: number,
    _fragment: string,
    _parentToolUseId: string | null,
  ): void {
    // Default implementation does nothing
  }

  /**
   * Hook method called when a thinking block is created.
   * Subclasses can override this to emit stream events.
   *
   * @param state - Message state
   * @param index - Block index
   * @param block - Thinking block that was created
   * @param parentToolUseId - null for main agent, string for subagent
   */
  protected onThinkingBlockCreated(
    _state: MessageState,
    _index: number,
    _block: ThinkingBlock,
    _parentToolUseId: string | null,
  ): void {
    // Default implementation does nothing
  }

  /**
   * Hook method called when thinking content is appended.
   * Subclasses can override this to emit stream events.
   *
   * @param state - Message state
   * @param index - Block index
   * @param fragment - Thinking fragment that was appended
   * @param parentToolUseId - null for main agent, string for subagent
   */
  protected onThinkingAppended(
    _state: MessageState,
    _index: number,
    _fragment: string,
    _parentToolUseId: string | null,
  ): void {
    // Default implementation does nothing
  }

  /**
   * Hook method called when a tool_use block is created.
   * Subclasses can override this to emit stream events.
   *
   * @param state - Message state
   * @param index - Block index
   * @param block - Tool use block that was created
   * @param parentToolUseId - null for main agent, string for subagent
   */
  protected onToolUseBlockCreated(
    _state: MessageState,
    _index: number,
    _block: ToolUseBlock,
    _parentToolUseId: string | null,
  ): void {
    // Default implementation does nothing
  }

  /**
   * Hook method called when tool_use input is set.
   * Subclasses can override this to emit stream events.
   *
   * @param state - Message state
   * @param index - Block index
   * @param input - Tool use input that was set
   * @param parentToolUseId - null for main agent, string for subagent
   */
  protected onToolUseInputSet(
    _state: MessageState,
    _index: number,
    _input: unknown,
    _parentToolUseId: string | null,
  ): void {
    // Default implementation does nothing
  }

  /**
   * Hook method called when a block is closed.
   * Subclasses can override this to emit stream events.
   *
   * @param state - Message state
   * @param index - Block index
   * @param parentToolUseId - null for main agent, string for subagent
   */
  protected onBlockClosed(
    _state: MessageState,
    _index: number,
    _parentToolUseId: string | null,
  ): void {
    // Default implementation does nothing
  }

  /**
   * Hook method called to ensure message is started.
   * Subclasses can override this to emit message_start events.
   *
   * @param state - Message state
   * @param parentToolUseId - null for main agent, string for subagent
   */
  protected onEnsureMessageStarted(
    _state: MessageState,
    _parentToolUseId: string | null,
  ): void {
    // Default implementation does nothing
  }

  /**
   * Gets the session ID from config.
   *
   * @returns Session ID
   */
  getSessionId(): string {
    return this.config.getSessionId();
  }

  /**
   * Gets the model name from config.
   *
   * @returns Model name
   */
  getModel(): string {
    return this.config.getModel();
  }

  // ========== Main Agent APIs ==========

  /**
   * Starts a new assistant message for the main agent.
   * This is a shared implementation used by both streaming and non-streaming adapters.
   */
  startAssistantMessage(): void {
    this.startAssistantMessageInternal(this.mainAgentMessageState);
  }

  /**
   * Processes a stream event from the Gemini API.
   * This is a shared implementation used by both streaming and non-streaming adapters.
   *
   * @param event - Stream event from Gemini API
   */
  processEvent(event: ServerGeminiStreamEvent): void {
    const state = this.mainAgentMessageState;
    if (state.finalized) {
      return;
    }

    switch (event.type) {
      case GeminiEventType.Content:
        this.appendText(state, event.value, null);
        break;
      case GeminiEventType.Citation:
        if (typeof event.value === 'string') {
          this.appendText(state, `\n${event.value}`, null);
        }
        break;
      case GeminiEventType.Thought:
        this.appendThinking(
          state,
          event.value.subject,
          event.value.description,
          null,
        );
        break;
      case GeminiEventType.ToolCallRequest:
        this.appendToolUse(state, event.value, null);
        break;
      case GeminiEventType.Finished:
        if (event.value?.usageMetadata) {
          state.usage = this.createUsage(event.value.usageMetadata);
        }
        this.finalizePendingBlocks(state, null);
        break;
      case GeminiEventType.Error: {
        // Format the error message using parseAndFormatApiError for consistency
        // with interactive mode error display
        const errorText = parseAndFormatApiError(
          event.value.error,
          this.config.getContentGeneratorConfig()?.authType,
        );
        this.appendText(state, errorText, null);
        break;
      }
      default:
        break;
    }
  }

  // ========== Subagent APIs ==========

  /**
   * Starts a new assistant message for a subagent.
   * This is a shared implementation used by both streaming and non-streaming adapters.
   *
   * @param parentToolUseId - Parent tool use ID
   */
  startSubagentAssistantMessage(parentToolUseId: string): void {
    const state = this.getMessageState(parentToolUseId);
    this.startAssistantMessageInternal(state);
  }

  /**
   * Finalizes a subagent assistant message.
   * This is a shared implementation used by both streaming and non-streaming adapters.
   *
   * @param parentToolUseId - Parent tool use ID
   * @returns CLIAssistantMessage
   */
  finalizeSubagentAssistantMessage(
    parentToolUseId: string,
  ): CLIAssistantMessage {
    const state = this.getMessageState(parentToolUseId);
    const message = this.finalizeAssistantMessageInternal(
      state,
      parentToolUseId,
    );
    this.updateLastAssistantMessage(message);
    return message;
  }

  /**
   * Emits a subagent error result message.
   * This is a shared implementation used by both streaming and non-streaming adapters.
   *
   * @param errorMessage - Error message
   * @param numTurns - Number of turns
   * @param parentToolUseId - Parent tool use ID
   */
  emitSubagentErrorResult(
    errorMessage: string,
    numTurns: number,
    parentToolUseId: string,
  ): void {
    const state = this.getMessageState(parentToolUseId);
    // Finalize any pending assistant message
    if (state.messageStarted && !state.finalized) {
      this.finalizeSubagentAssistantMessage(parentToolUseId);
    }

    const errorResult = this.buildSubagentErrorResult(errorMessage, numTurns);
    this.emitMessageImpl(errorResult);
  }

  /**
   * Processes a subagent tool call.
   * This is a shared implementation used by both streaming and non-streaming adapters.
   * Uses template method pattern with hooks for stream events.
   *
   * @param toolCall - Tool call information
   * @param parentToolUseId - Parent tool use ID
   */
  processSubagentToolCall(
    toolCall: NonNullable<TaskResultDisplay['toolCalls']>[number],
    parentToolUseId: string,
  ): void {
    const state = this.getMessageState(parentToolUseId);

    // Finalize any pending text message before starting tool_use
    const hasText =
      state.blocks.some((b) => b.type === 'text') ||
      (state.currentBlockType === 'text' && state.blocks.length > 0);
    if (hasText) {
      this.finalizeSubagentAssistantMessage(parentToolUseId);
      this.startSubagentAssistantMessage(parentToolUseId);
    }

    // Ensure message is started before appending tool_use
    if (!state.messageId || !state.messageStarted) {
      this.startAssistantMessageInternal(state);
    }

    this.ensureBlockTypeConsistency(state, 'tool_use', parentToolUseId);
    this.ensureMessageStarted(state, parentToolUseId);
    this.finalizePendingBlocks(state, parentToolUseId);

    const { index } = this.createSubagentToolUseBlock(
      state,
      toolCall,
      parentToolUseId,
    );

    // Process tool use block creation and closure
    // Subclasses can override hook methods to emit stream events
    this.processSubagentToolUseBlock(state, index, toolCall, parentToolUseId);

    // Finalize tool_use message immediately
    this.finalizeSubagentAssistantMessage(parentToolUseId);
    this.startSubagentAssistantMessage(parentToolUseId);
  }

  /**
   * Processes a tool use block for subagent.
   * This method is called by processSubagentToolCall to handle tool use block creation,
   * input setting, and closure. Subclasses can override this to customize behavior.
   *
   * @param state - Message state
   * @param index - Block index
   * @param toolCall - Tool call information
   * @param parentToolUseId - Parent tool use ID
   */
  protected processSubagentToolUseBlock(
    state: MessageState,
    index: number,
    toolCall: NonNullable<TaskResultDisplay['toolCalls']>[number],
    parentToolUseId: string,
  ): void {
    // Emit tool_use block creation event (with empty input)
    const startBlock: ToolUseBlock = {
      type: 'tool_use',
      id: toolCall.callId,
      name: toolCall.name,
      input: {},
    };
    this.onToolUseBlockCreated(state, index, startBlock, parentToolUseId);
    this.onToolUseInputSet(state, index, toolCall.args ?? {}, parentToolUseId);
    this.onBlockClosed(state, index, parentToolUseId);
    this.closeBlock(state, index);
  }

  /**
   * Updates the last assistant message.
   * Subclasses can override this to customize tracking behavior.
   *
   * @param message - Assistant message to track
   */
  protected updateLastAssistantMessage(message: CLIAssistantMessage): void {
    this.lastAssistantMessage = message;
  }

  // ========== Shared Content Block Methods ==========

  /**
   * Appends text content to the current message.
   * Uses template method pattern with hooks for stream events.
   *
   * @param state - Message state
   * @param fragment - Text fragment to append
   * @param parentToolUseId - null for main agent, string for subagent
   */
  protected appendText(
    state: MessageState,
    fragment: string,
    parentToolUseId: string | null,
  ): void {
    if (fragment.length === 0) {
      return;
    }

    this.ensureBlockTypeConsistency(state, 'text', parentToolUseId);
    this.ensureMessageStarted(state, parentToolUseId);

    let current = state.blocks[state.blocks.length - 1] as
      | TextBlock
      | undefined;
    const isNewBlock = !current || current.type !== 'text';
    if (isNewBlock) {
      current = { type: 'text', text: '' } satisfies TextBlock;
      const index = state.blocks.length;
      state.blocks.push(current);
      this.openBlock(state, index, current);
      this.onTextBlockCreated(state, index, current, parentToolUseId);
    }

    // current is guaranteed to be defined here (either existing or newly created)
    current!.text += fragment;
    const index = state.blocks.length - 1;
    this.onTextAppended(state, index, fragment, parentToolUseId);
  }

  /**
   * Appends thinking content to the current message.
   * Uses template method pattern with hooks for stream events.
   *
   * @param state - Message state
   * @param subject - Thinking subject
   * @param description - Thinking description
   * @param parentToolUseId - null for main agent, string for subagent
   */
  protected appendThinking(
    state: MessageState,
    subject?: string,
    description?: string,
    parentToolUseId?: string | null,
  ): void {
    const actualParentToolUseId = parentToolUseId ?? null;

    // Build fragment without trimming to preserve whitespace in streaming content
    // Only filter out null/undefined/empty values
    const parts: string[] = [];
    if (subject && subject.length > 0) {
      parts.push(subject);
    }
    if (description && description.length > 0) {
      parts.push(description);
    }

    const fragment = parts.join(': ');
    if (!fragment) {
      return;
    }

    this.ensureBlockTypeConsistency(state, 'thinking', actualParentToolUseId);
    this.ensureMessageStarted(state, actualParentToolUseId);

    let current = state.blocks[state.blocks.length - 1] as
      | ThinkingBlock
      | undefined;
    const isNewBlock = !current || current.type !== 'thinking';
    if (isNewBlock) {
      current = {
        type: 'thinking',
        thinking: '',
        signature: subject,
      } satisfies ThinkingBlock;
      const index = state.blocks.length;
      state.blocks.push(current);
      this.openBlock(state, index, current);
      this.onThinkingBlockCreated(state, index, current, actualParentToolUseId);
    }

    // current is guaranteed to be defined here (either existing or newly created)
    current!.thinking = `${current!.thinking ?? ''}${fragment}`;
    const index = state.blocks.length - 1;
    this.onThinkingAppended(state, index, fragment, actualParentToolUseId);
  }

  /**
   * Appends a tool_use block to the current message.
   * Uses template method pattern with hooks for stream events.
   *
   * @param state - Message state
   * @param request - Tool call request info
   * @param parentToolUseId - null for main agent, string for subagent
   */
  protected appendToolUse(
    state: MessageState,
    request: ToolCallRequestInfo,
    parentToolUseId: string | null,
  ): void {
    this.ensureBlockTypeConsistency(state, 'tool_use', parentToolUseId);
    this.ensureMessageStarted(state, parentToolUseId);
    this.finalizePendingBlocks(state, parentToolUseId);

    const index = state.blocks.length;
    const block: ToolUseBlock = {
      type: 'tool_use',
      id: request.callId,
      name: request.name,
      input: request.args,
    };
    state.blocks.push(block);
    this.openBlock(state, index, block);

    // Emit tool_use block creation event (with empty input)
    const startBlock: ToolUseBlock = {
      type: 'tool_use',
      id: request.callId,
      name: request.name,
      input: {},
    };
    this.onToolUseBlockCreated(state, index, startBlock, parentToolUseId);
    this.onToolUseInputSet(state, index, request.args ?? {}, parentToolUseId);

    this.onBlockClosed(state, index, parentToolUseId);
    this.closeBlock(state, index);
  }

  /**
   * Ensures that a message has been started.
   * Calls hook method for subclasses to emit message_start events.
   *
   * @param state - Message state
   * @param parentToolUseId - null for main agent, string for subagent
   */
  protected ensureMessageStarted(
    state: MessageState,
    parentToolUseId: string | null,
  ): void {
    if (state.messageStarted) {
      return;
    }
    state.messageStarted = true;
    this.onEnsureMessageStarted(state, parentToolUseId);
  }

  /**
   * Creates and adds a tool_use block to the state.
   * This is a shared helper method used by processSubagentToolCall implementations.
   *
   * @param state - Message state
   * @param toolCall - Tool call information
   * @param parentToolUseId - Parent tool use ID
   * @returns The created block and its index
   */
  protected createSubagentToolUseBlock(
    state: MessageState,
    toolCall: NonNullable<TaskResultDisplay['toolCalls']>[number],
    _parentToolUseId: string,
  ): { block: ToolUseBlock; index: number } {
    const index = state.blocks.length;
    const block: ToolUseBlock = {
      type: 'tool_use',
      id: toolCall.callId,
      name: toolCall.name,
      input: toolCall.args || {},
    };
    state.blocks.push(block);
    this.openBlock(state, index, block);
    return { block, index };
  }

  /**
   * Emits a user message.
   * @param parts - Array of Part objects
   * @param parentToolUseId - Optional parent tool use ID for subagent messages
   */
  emitUserMessage(parts: Part[], parentToolUseId?: string | null): void {
    const content = partsToContentBlock(parts);
    const message: CLIUserMessage = {
      type: 'user',
      uuid: randomUUID(),
      session_id: this.getSessionId(),
      parent_tool_use_id: parentToolUseId ?? null,
      message: {
        role: 'user',
        content,
      },
    };
    this.emitMessageImpl(message);
  }

  /**
   * Checks if responseParts contain any functionResponse with an error.
   * This handles cancelled responses and other error cases where the error
   * is embedded in responseParts rather than the top-level error field.
   * @param responseParts - Array of Part objects
   * @returns Error message if found, undefined otherwise
   */
  private checkResponsePartsForError(
    responseParts: Part[] | undefined,
  ): string | undefined {
    // Use the shared helper function defined at file level
    return checkResponsePartsForError(responseParts);
  }

  /**
   * Emits a tool result message.
   * Collects execution denied tool calls for inclusion in result messages.
   * Handles both explicit errors (response.error) and errors embedded in
   * responseParts (e.g., cancelled responses).
   * @param request - Tool call request info
   * @param response - Tool call response info
   * @param parentToolUseId - Parent tool use ID (null for main agent)
   */
  emitToolResult(
    request: ToolCallRequestInfo,
    response: ToolCallResponseInfo,
    parentToolUseId: string | null = null,
  ): void {
    // Check for errors in responseParts (e.g., cancelled responses)
    const responsePartsError = this.checkResponsePartsForError(
      response.responseParts,
    );

    // Determine if this is an error response
    const hasError = Boolean(response.error) || Boolean(responsePartsError);

    // Track permission denials (execution denied errors)
    if (
      response.error &&
      response.errorType === ToolErrorType.EXECUTION_DENIED
    ) {
      const denial: CLIPermissionDenial = {
        tool_name: request.name,
        tool_use_id: request.callId,
        tool_input: request.args,
      };
      this.permissionDenials.push(denial);
    }

    const block: ToolResultBlock = {
      type: 'tool_result',
      tool_use_id: request.callId,
      is_error: hasError,
    };
    const content = toolResultContent(response);
    if (content !== undefined) {
      block.content = content;
    }

    const message: CLIUserMessage = {
      type: 'user',
      uuid: randomUUID(),
      session_id: this.getSessionId(),
      parent_tool_use_id: parentToolUseId,
      message: {
        role: 'user',
        content: [block],
      },
    };
    this.emitMessageImpl(message);
  }

  /**
   * Emits a system message.
   * @param subtype - System message subtype
   * @param data - Optional data payload
   */
  emitSystemMessage(subtype: string, data?: unknown): void {
    const systemMessage = {
      type: 'system',
      subtype,
      uuid: randomUUID(),
      session_id: this.getSessionId(),
      parent_tool_use_id: null,
      data,
    } as const;
    this.emitMessageImpl(systemMessage);
  }

  /**
   * Builds a result message from options.
   * Helper method used by both emitResult implementations.
   * Includes permission denials collected from execution denied tool calls.
   * @param options - Result options
   * @param lastAssistantMessage - Last assistant message for text extraction
   * @returns CLIResultMessage
   */
  protected buildResultMessage(
    options: ResultOptions,
    lastAssistantMessage: CLIAssistantMessage | null,
  ): CLIResultMessage {
    const usage = options.usage ?? createExtendedUsage();
    const resultText =
      options.summary ??
      (lastAssistantMessage
        ? extractTextFromBlocks(lastAssistantMessage.message.content)
        : '');

    const baseUuid = randomUUID();
    const baseSessionId = this.getSessionId();

    if (options.isError) {
      const errorMessage = options.errorMessage ?? 'Unknown error';
      return {
        type: 'result',
        subtype:
          (options.subtype as CLIResultMessageError['subtype']) ??
          'error_during_execution',
        uuid: baseUuid,
        session_id: baseSessionId,
        is_error: true,
        duration_ms: options.durationMs,
        duration_api_ms: options.apiDurationMs,
        num_turns: options.numTurns,
        usage,
        permission_denials: [...this.permissionDenials],
        error: { message: errorMessage },
      };
    } else {
      const success: CLIResultMessageSuccess & { stats?: SessionMetrics } = {
        type: 'result',
        subtype:
          (options.subtype as CLIResultMessageSuccess['subtype']) ?? 'success',
        uuid: baseUuid,
        session_id: baseSessionId,
        is_error: false,
        duration_ms: options.durationMs,
        duration_api_ms: options.apiDurationMs,
        num_turns: options.numTurns,
        result: resultText,
        usage,
        permission_denials: [...this.permissionDenials],
      };

      if (options.stats) {
        success.stats = options.stats;
      }

      return success;
    }
  }

  /**
   * Builds a subagent error result message.
   * Helper method used by both emitSubagentErrorResult implementations.
   * Note: Subagent permission denials are not included here as they are tracked
   * separately and would be included in the main agent's result message.
   * @param errorMessage - Error message
   * @param numTurns - Number of turns
   * @returns CLIResultMessageError
   */
  protected buildSubagentErrorResult(
    errorMessage: string,
    numTurns: number,
  ): CLIResultMessageError {
    const usage: ExtendedUsage = {
      input_tokens: 0,
      output_tokens: 0,
    };

    return {
      type: 'result',
      subtype: 'error_during_execution',
      uuid: randomUUID(),
      session_id: this.getSessionId(),
      is_error: true,
      duration_ms: 0,
      duration_api_ms: 0,
      num_turns: numTurns,
      usage,
      permission_denials: [],
      error: { message: errorMessage },
    };
  }
}

/**
 * Converts Part array to ContentBlock array.
 * Handles various Part types including text, functionResponse, and other types.
 * For functionResponse parts, extracts the output content.
 * For other non-text parts, converts them to text representation.
 *
 * @param parts - Array of Part objects
 * @returns Array of ContentBlock objects (primarily TextBlock)
 */
export function partsToContentBlock(parts: Part[]): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  let currentTextBlock: TextBlock | null = null;

  for (const part of parts) {
    let textContent: string | null = null;

    // Handle text parts
    if ('text' in part && typeof part.text === 'string') {
      textContent = part.text;
    }
    // Handle functionResponse parts - extract output content
    else if ('functionResponse' in part && part.functionResponse) {
      const output =
        part.functionResponse.response?.['output'] ??
        part.functionResponse.response?.['content'] ??
        '';
      textContent =
        typeof output === 'string' ? output : JSON.stringify(output);
    }
    // Handle other part types - convert to JSON string
    else {
      textContent = JSON.stringify(part);
    }

    // If we have text content, add it to the current text block or create a new one
    if (textContent !== null && textContent.length > 0) {
      if (currentTextBlock === null) {
        currentTextBlock = {
          type: 'text',
          text: textContent,
        };
        blocks.push(currentTextBlock);
      } else {
        // Append to existing text block
        currentTextBlock.text += textContent;
      }
    }
  }

  // Return blocks array, or empty array if no content
  return blocks;
}

/**
 * Converts Part array to string representation.
 * This is a legacy function kept for backward compatibility.
 * For new code, prefer using partsToContentBlock.
 *
 * @param parts - Array of Part objects
 * @returns String representation
 */
export function partsToString(parts: Part[]): string {
  return parts
    .map((part) => {
      if ('text' in part && typeof part.text === 'string') {
        return part.text;
      }
      return JSON.stringify(part);
    })
    .join('');
}

/**
 * Checks if responseParts contain any functionResponse with an error.
 * Helper function for extracting error messages from responseParts.
 * @param responseParts - Array of Part objects
 * @returns Error message if found, undefined otherwise
 */
function checkResponsePartsForError(
  responseParts: Part[] | undefined,
): string | undefined {
  if (!responseParts || responseParts.length === 0) {
    return undefined;
  }

  for (const part of responseParts) {
    if (
      'functionResponse' in part &&
      part.functionResponse?.response &&
      typeof part.functionResponse.response === 'object' &&
      'error' in part.functionResponse.response &&
      part.functionResponse.response['error']
    ) {
      const error = part.functionResponse.response['error'];
      return typeof error === 'string' ? error : String(error);
    }
  }

  return undefined;
}

/**
 * Extracts content from tool response.
 * Uses functionResponsePartsToString to properly handle functionResponse parts,
 * which correctly extracts output content from functionResponse objects rather
 * than simply concatenating text or JSON.stringify.
 * Also handles errors embedded in responseParts (e.g., cancelled responses).
 *
 * @param response - Tool call response
 * @returns String content or undefined
 */
export function toolResultContent(
  response: ToolCallResponseInfo,
): string | undefined {
  if (response.error) {
    return response.error.message;
  }
  // Check for errors in responseParts (e.g., cancelled responses)
  const responsePartsError = checkResponsePartsForError(response.responseParts);
  if (responsePartsError) {
    return responsePartsError;
  }
  if (
    typeof response.resultDisplay === 'string' &&
    response.resultDisplay.trim().length > 0
  ) {
    return response.resultDisplay;
  }
  if (response.responseParts && response.responseParts.length > 0) {
    // Always use functionResponsePartsToString to properly handle
    // functionResponse parts that contain output content
    return functionResponsePartsToString(response.responseParts);
  }
  return undefined;
}

/**
 * Extracts text from content blocks.
 *
 * @param blocks - Array of content blocks
 * @returns Extracted text
 */
export function extractTextFromBlocks(blocks: ContentBlock[]): string {
  return blocks
    .filter((block) => block.type === 'text')
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('');
}

/**
 * Creates an extended usage object with default values.
 *
 * @returns ExtendedUsage object
 */
export function createExtendedUsage(): ExtendedUsage {
  return {
    input_tokens: 0,
    output_tokens: 0,
  };
}
