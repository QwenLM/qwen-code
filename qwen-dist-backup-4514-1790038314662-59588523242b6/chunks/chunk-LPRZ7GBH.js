// Force strict mode and setup for ESM
"use strict";
import {
  functionResponsePartsToString
} from "./chunk-BQDVNRRN.js";
import {
  observeHeadlessToolResultProjection,
  observeHeadlessToolResultWire,
  projectJsonStringToByteBudget
} from "./chunk-TPIZYLF2.js";
import {
  createNotStartedToolErrorResponse,
  parseAndFormatApiError,
  toolResultBoundaryArtifact
} from "./chunk-MRTRBONQ.js";
import {
  formatVisionBridgeNoticeDisplay,
  isVisionBridgeNoticeDisplay
} from "./chunk-KKGSJZWK.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/nonInteractive/io/StreamJsonOutputAdapter.ts
init_esbuild_shims();
import { randomUUID as randomUUID2 } from "node:crypto";

// packages/cli/src/nonInteractive/io/BaseJsonOutputAdapter.ts
init_esbuild_shims();
import { randomUUID } from "node:crypto";

// packages/cli/src/nonInteractive/io/headless-tool-result-text-projection.ts
init_esbuild_shims();
var HEADLESS_TOOL_RESULT_TEXT_JSON_BYTE_BUDGET = 65536;
var HEADLESS_TOOL_RESULT_TEXT_TRUNCATION_MARKER = "\n[... truncated for Headless transport ...]\n";
function projectHeadlessToolResultContent(value) {
  return projectJsonStringToByteBudget(
    value,
    HEADLESS_TOOL_RESULT_TEXT_JSON_BYTE_BUDGET,
    HEADLESS_TOOL_RESULT_TEXT_TRUNCATION_MARKER
  );
}
__name(projectHeadlessToolResultContent, "projectHeadlessToolResultContent");

// packages/cli/src/nonInteractive/io/BaseJsonOutputAdapter.ts
var BaseJsonOutputAdapter = class {
  static {
    __name(this, "BaseJsonOutputAdapter");
  }
  config;
  // Main agent message state
  mainAgentMessageState;
  // Subagent message states keyed by parentToolUseId
  subagentMessageStates = /* @__PURE__ */ new Map();
  // Last assistant message for result generation
  lastAssistantMessage = null;
  // Track permission denials (execution denied tool calls)
  permissionDenials = [];
  constructor(config) {
    this.config = config;
    this.mainAgentMessageState = this.createMessageState();
  }
  /**
   * Creates a new message state with default values.
   */
  createMessageState() {
    return {
      messageId: null,
      blocks: [],
      openBlocks: /* @__PURE__ */ new Set(),
      usage: this.createUsage(),
      messageStarted: false,
      finalized: false,
      currentBlockType: null
    };
  }
  /**
   * Gets or creates message state for a given context.
   *
   * @param parentToolUseId - null for main agent, string for subagent
   * @returns MessageState for the context
   */
  getMessageState(parentToolUseId) {
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
   * @param metadata - Optional LLM usage metadata
   * @returns Usage object
   */
  createUsage(metadata) {
    const usage = {
      input_tokens: 0,
      output_tokens: 0
    };
    if (!metadata) {
      return usage;
    }
    if (typeof metadata.promptTokenCount === "number") {
      usage.input_tokens = metadata.promptTokenCount;
    }
    if (typeof metadata.candidatesTokenCount === "number") {
      usage.output_tokens = metadata.candidatesTokenCount;
    }
    if (typeof metadata.cachedContentTokenCount === "number") {
      usage.cache_read_input_tokens = metadata.cachedContentTokenCount;
    }
    if (typeof metadata.totalTokenCount === "number") {
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
  buildMessage(parentToolUseId) {
    const state = this.getMessageState(parentToolUseId);
    if (!state.messageId) {
      throw new Error("Message not started");
    }
    if (state.blocks.length > 0) {
      const blockTypes = new Set(state.blocks.map((block) => block.type));
      if (blockTypes.size > 1) {
        throw new Error(
          `Assistant message must contain only one type of ContentBlock, found: ${Array.from(blockTypes).join(", ")}`
        );
      }
    }
    const stopReason = state.blocks.length > 0 && state.blocks.every((block) => block.type === "tool_use") ? "tool_use" : null;
    return {
      type: "assistant",
      uuid: state.messageId,
      session_id: this.config.getSessionId(),
      parent_tool_use_id: parentToolUseId,
      message: {
        id: state.messageId,
        type: "message",
        role: "assistant",
        model: this.config.getModel(),
        content: state.blocks,
        stop_reason: stopReason,
        usage: state.usage
      }
    };
  }
  /**
   * Finalizes pending blocks (text or thinking) by closing them.
   *
   * @param state - Message state to finalize blocks for
   * @param parentToolUseId - null for main agent, string for subagent (optional, defaults to null)
   */
  finalizePendingBlocks(state, parentToolUseId) {
    const actualParentToolUseId = parentToolUseId ?? null;
    const lastBlock = state.blocks[state.blocks.length - 1];
    if (!lastBlock) {
      return;
    }
    const index = state.blocks.length - 1;
    if (!state.openBlocks.has(index)) {
      return;
    }
    if (lastBlock.type === "text" || lastBlock.type === "thinking") {
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
  openBlock(state, index, _block) {
    state.openBlocks.add(index);
  }
  /**
   * Closes a block (removes from openBlocks set).
   *
   * @param state - Message state
   * @param index - Block index
   */
  closeBlock(state, index) {
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
  ensureBlockTypeConsistency(state, targetType, parentToolUseId) {
    if (state.currentBlockType === targetType) {
      return;
    }
    if (state.currentBlockType === null) {
      state.currentBlockType = targetType;
      return;
    }
    this.finalizeAssistantMessageInternal(state, parentToolUseId);
    this.startAssistantMessageInternal(state);
    state.currentBlockType = targetType;
  }
  /**
   * Starts a new assistant message, resetting state.
   *
   * @param state - Message state to reset
   */
  startAssistantMessageInternal(state) {
    state.messageId = randomUUID();
    state.blocks = [];
    state.openBlocks = /* @__PURE__ */ new Set();
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
  finalizeAssistantMessageInternal(state, parentToolUseId) {
    if (state.finalized) {
      return this.buildMessage(parentToolUseId);
    }
    state.finalized = true;
    this.finalizePendingBlocks(state, parentToolUseId);
    const orderedOpenBlocks = Array.from(state.openBlocks).sort(
      (a, b) => a - b
    );
    for (const index of orderedOpenBlocks) {
      this.onBlockClosed(state, index, parentToolUseId);
      this.closeBlock(state, index);
    }
    const message = this.buildMessage(parentToolUseId);
    if (state.messageStarted) {
      this.emitMessageImpl(message);
    }
    return message;
  }
  /**
   * Emits a control-plane message (control_request / control_response).
   * Only meaningful in streaming adapters; batch adapters inherit this
   * no-op since control messages are not collected into the final array.
   */
  emitControlMessageImpl(_message) {
  }
  /**
   * Hook method called when a text block is created.
   * Subclasses can override this to emit stream events.
   *
   * @param state - Message state
   * @param index - Block index
   * @param block - Text block that was created
   * @param parentToolUseId - null for main agent, string for subagent
   */
  onTextBlockCreated(_state, _index, _block, _parentToolUseId) {
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
  onTextAppended(_state, _index, _fragment, _parentToolUseId) {
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
  onThinkingBlockCreated(_state, _index, _block, _parentToolUseId) {
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
  onThinkingAppended(_state, _index, _fragment, _parentToolUseId) {
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
  onToolUseBlockCreated(_state, _index, _block, _parentToolUseId) {
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
  onToolUseInputSet(_state, _index, _input, _parentToolUseId) {
  }
  /**
   * Hook method called when a block is closed.
   * Subclasses can override this to emit stream events.
   *
   * @param state - Message state
   * @param index - Block index
   * @param parentToolUseId - null for main agent, string for subagent
   */
  onBlockClosed(_state, _index, _parentToolUseId) {
  }
  /**
   * Hook method called to ensure message is started.
   * Subclasses can override this to emit message_start events.
   *
   * @param state - Message state
   * @param parentToolUseId - null for main agent, string for subagent
   */
  onEnsureMessageStarted(_state, _parentToolUseId) {
  }
  /**
   * Gets the session ID from config.
   *
   * @returns Session ID
   */
  getSessionId() {
    return this.config.getSessionId();
  }
  /**
   * Gets the model name from config.
   *
   * @returns Model name
   */
  getModel() {
    return this.config.getModel();
  }
  // ========== Main Agent APIs ==========
  /**
   * Starts a new assistant message for the main agent.
   * This is a shared implementation used by both streaming and non-streaming adapters.
   */
  startAssistantMessage() {
    this.startAssistantMessageInternal(this.mainAgentMessageState);
  }
  /**
   * Starts a replacement provider attempt. Continuation retries keep the
   * already-delivered text; fresh retries and fallbacks discard the pending
   * assistant state. Streaming adapters override this to pair any tool_use
   * frames that are already on the wire before resetting.
   */
  restartAttempt(preserveText, discardedToolCalls) {
    if (preserveText) {
      const discardedIds = new Set(
        discardedToolCalls.map((request) => request.callId)
      );
      if (discardedIds.size > 0) {
        const state = this.mainAgentMessageState;
        const retainedBlocks = [];
        const retainedOpenBlocks = /* @__PURE__ */ new Set();
        for (const [index, block] of state.blocks.entries()) {
          if (block.type === "tool_use" && discardedIds.has(block.id)) {
            continue;
          }
          const retainedIndex = retainedBlocks.length;
          retainedBlocks.push(block);
          if (state.openBlocks.has(index)) {
            retainedOpenBlocks.add(retainedIndex);
          }
        }
        state.blocks = retainedBlocks;
        state.openBlocks = retainedOpenBlocks;
        state.currentBlockType = retainedBlocks.at(-1)?.type ?? null;
        state.messageStarted = retainedBlocks.length > 0;
      }
      return;
    }
    this.startAssistantMessageInternal(this.mainAgentMessageState);
  }
  emitDiscardedAttemptToolResults(discardedToolCalls) {
    const message = "Skipped because the provider attempt was retried before execution.";
    for (const request of discardedToolCalls) {
      this.emitToolResult(
        request,
        createNotStartedToolErrorResponse(request, message)
      );
    }
  }
  /**
   * Processes an LLM stream event.
   * This is a shared implementation used by both streaming and non-streaming adapters.
   *
   * @param event - LLM stream event
   */
  processEvent(event) {
    const state = this.mainAgentMessageState;
    if (state.finalized) {
      return;
    }
    switch (event.type) {
      case "content" /* Content */:
        this.appendText(state, event.value, null);
        break;
      case "citation" /* Citation */:
        if (typeof event.value === "string") {
          this.appendText(state, `
${event.value}`, null);
        }
        break;
      case "thought" /* Thought */:
        this.appendThinking(
          state,
          event.value.subject,
          event.value.description,
          null
        );
        break;
      case "tool_call_request" /* ToolCallRequest */:
        this.appendToolUse(state, event.value, null);
        break;
      case "finished" /* Finished */:
        if (event.value?.usageMetadata) {
          state.usage = this.createUsage(event.value.usageMetadata);
        }
        this.finalizePendingBlocks(state, null);
        break;
      case "error" /* Error */: {
        const errorText = parseAndFormatApiError(
          event.value.error,
          this.config.getContentGeneratorConfig()?.authType
        );
        this.appendText(state, errorText, null);
        break;
      }
      case "model_fallback" /* ModelFallback */:
        this.emitSystemMessage("model_fallback", {
          fromModel: event.fromModel,
          toModel: event.toModel,
          statusCode: event.statusCode,
          fallbackIndex: event.fallbackIndex
        });
        break;
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
  startSubagentAssistantMessage(parentToolUseId) {
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
  finalizeSubagentAssistantMessage(parentToolUseId) {
    const state = this.getMessageState(parentToolUseId);
    return this.finalizeAssistantMessageInternal(state, parentToolUseId);
  }
  /**
   * Emits a subagent error result message.
   * This is a shared implementation used by both streaming and non-streaming adapters.
   *
   * @param errorMessage - Error message
   * @param numTurns - Number of turns
   * @param parentToolUseId - Parent tool use ID
   */
  emitSubagentErrorResult(errorMessage, numTurns, parentToolUseId) {
    const state = this.getMessageState(parentToolUseId);
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
  processSubagentToolCall(toolCall, parentToolUseId) {
    const state = this.getMessageState(parentToolUseId);
    const hasText = state.blocks.some((b) => b.type === "text") || state.currentBlockType === "text" && state.blocks.length > 0;
    if (hasText) {
      this.finalizeSubagentAssistantMessage(parentToolUseId);
      this.startSubagentAssistantMessage(parentToolUseId);
    }
    if (!state.messageId || !state.messageStarted) {
      this.startAssistantMessageInternal(state);
    }
    this.ensureBlockTypeConsistency(state, "tool_use", parentToolUseId);
    this.ensureMessageStarted(state, parentToolUseId);
    this.finalizePendingBlocks(state, parentToolUseId);
    const { index } = this.createSubagentToolUseBlock(
      state,
      toolCall,
      parentToolUseId
    );
    this.processSubagentToolUseBlock(state, index, toolCall, parentToolUseId);
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
  processSubagentToolUseBlock(state, index, toolCall, parentToolUseId) {
    const startBlock = {
      type: "tool_use",
      id: toolCall.callId,
      name: toolCall.name,
      input: {}
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
  updateLastAssistantMessage(message) {
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
  appendText(state, fragment, parentToolUseId) {
    if (fragment.length === 0) {
      return;
    }
    this.ensureBlockTypeConsistency(state, "text", parentToolUseId);
    this.ensureMessageStarted(state, parentToolUseId);
    let current = state.blocks[state.blocks.length - 1];
    const isNewBlock = !current || current.type !== "text";
    if (isNewBlock) {
      current = { type: "text", text: "" };
      const index2 = state.blocks.length;
      state.blocks.push(current);
      this.openBlock(state, index2, current);
      this.onTextBlockCreated(state, index2, current, parentToolUseId);
    }
    current.text += fragment;
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
  appendThinking(state, subject, description, parentToolUseId) {
    const actualParentToolUseId = parentToolUseId ?? null;
    const parts = [];
    if (subject && subject.length > 0) {
      parts.push(subject);
    }
    if (description && description.length > 0) {
      parts.push(description);
    }
    const fragment = parts.join(": ");
    if (!fragment) {
      return;
    }
    this.ensureBlockTypeConsistency(state, "thinking", actualParentToolUseId);
    this.ensureMessageStarted(state, actualParentToolUseId);
    let current = state.blocks[state.blocks.length - 1];
    const isNewBlock = !current || current.type !== "thinking";
    if (isNewBlock) {
      current = {
        type: "thinking",
        thinking: "",
        signature: subject
      };
      const index2 = state.blocks.length;
      state.blocks.push(current);
      this.openBlock(state, index2, current);
      this.onThinkingBlockCreated(state, index2, current, actualParentToolUseId);
    }
    current.thinking = `${current.thinking ?? ""}${fragment}`;
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
  appendToolUse(state, request, parentToolUseId) {
    this.ensureBlockTypeConsistency(state, "tool_use", parentToolUseId);
    this.ensureMessageStarted(state, parentToolUseId);
    this.finalizePendingBlocks(state, parentToolUseId);
    const index = state.blocks.length;
    const block = {
      type: "tool_use",
      id: request.callId,
      name: request.name,
      input: request.args
    };
    state.blocks.push(block);
    this.openBlock(state, index, block);
    const startBlock = {
      type: "tool_use",
      id: request.callId,
      name: request.name,
      input: {}
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
  ensureMessageStarted(state, parentToolUseId) {
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
  createSubagentToolUseBlock(state, toolCall, _parentToolUseId) {
    const index = state.blocks.length;
    const block = {
      type: "tool_use",
      id: toolCall.callId,
      name: toolCall.name,
      input: toolCall.args || {}
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
  emitUserMessage(parts, parentToolUseId) {
    const content = partsToContentBlock(parts);
    const message = {
      type: "user",
      uuid: randomUUID(),
      session_id: this.getSessionId(),
      parent_tool_use_id: parentToolUseId ?? null,
      message: {
        role: "user",
        content
      }
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
  checkResponsePartsForError(responseParts) {
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
  emitToolResult(request, response, parentToolUseId = null) {
    const responsePartsError = this.checkResponsePartsForError(
      response.responseParts
    );
    const hasError = Boolean(response.error) || Boolean(responsePartsError);
    if (response.error && response.errorType === "execution_denied" /* EXECUTION_DENIED */) {
      const denial = {
        tool_name: request.name,
        tool_use_id: request.callId,
        tool_input: request.args
      };
      this.permissionDenials.push(denial);
    }
    const block = {
      type: "tool_result",
      tool_use_id: request.callId,
      is_error: hasError
    };
    const content = toolResultContent(response);
    let projectedContent;
    if (content !== void 0) {
      projectedContent = projectHeadlessToolResultContent(content);
      block.content = projectedContent;
    }
    const message = {
      type: "user",
      uuid: randomUUID(),
      session_id: this.getSessionId(),
      parent_tool_use_id: parentToolUseId,
      message: {
        role: "user",
        content: [block]
      }
    };
    if (content !== void 0 && projectedContent !== void 0) {
      observeHeadlessToolResultProjection(
        message,
        content,
        projectedContent,
        request.callId,
        response.boundaryArtifact ?? toolResultBoundaryArtifact(
          response.persistedOutputFiles,
          response.artifacts
        )
      );
    }
    this.emitMessageImpl(message);
  }
  /**
   * Emits a system message.
   * @param subtype - System message subtype
   * @param data - Optional data payload
   */
  emitSystemMessage(subtype, data) {
    const systemMessage = {
      type: "system",
      subtype,
      uuid: randomUUID(),
      session_id: this.getSessionId(),
      parent_tool_use_id: null,
      data
    };
    this.emitMessageImpl(systemMessage);
  }
  /**
   * Emits a `can_use_tool` permission control_request so an external consumer
   * can approve or deny the tool call. Pairs with {@link emitControlResponse}.
   */
  emitPermissionRequest(requestId, toolName, toolUseId, input, blockedPath = null, permissionSuggestions = null) {
    const message = {
      type: "control_request",
      request_id: requestId,
      request: {
        subtype: "can_use_tool",
        tool_name: toolName,
        tool_use_id: toolUseId,
        input,
        permission_suggestions: permissionSuggestions,
        blocked_path: blockedPath
      }
    };
    this.emitControlMessageImpl(message);
  }
  /**
   * Emits a control_response carrying a permission approval result.
   * Used both to mirror TUI-native resolutions back to external consumers
   * and to acknowledge externally-supplied confirmation_responses.
   */
  emitControlResponse(requestId, allowed) {
    const message = {
      type: "control_response",
      response: {
        subtype: "success",
        request_id: requestId,
        response: { allowed }
      }
    };
    this.emitControlMessageImpl(message);
  }
  /**
   * Emits a control_response with subtype `error`. Used to reject an
   * external confirmation_response that cannot be honored (unknown
   * request_id, tool call already resolved, etc.) so the consumer can
   * surface or retry, instead of waiting forever for an implicit ack.
   */
  emitControlError(requestId, errorMessage) {
    const message = {
      type: "control_response",
      response: {
        subtype: "error",
        request_id: requestId,
        error: errorMessage
      }
    };
    this.emitControlMessageImpl(message);
  }
  /**
   * Emits a tool progress stream event.
   * Default implementation is a no-op. StreamJsonOutputAdapter overrides this
   * to emit stream events when includePartialMessages is enabled.
   *
   * @param _request - Tool call request info
   * @param _progress - Structured MCP progress data or shell liveness heartbeat
   */
  emitToolProgress(_request, _progress) {
  }
  /**
   * Builds a result message from options.
   * Helper method used by both emitResult implementations.
   * Includes permission denials collected from execution denied tool calls.
   * @param options - Result options
   * @param lastAssistantMessage - Last assistant message for text extraction
   * @returns CLIResultMessage
   */
  buildResultMessage(options, lastAssistantMessage) {
    const usage = options.usage ?? createExtendedUsage();
    const resultText = options.summary ?? (lastAssistantMessage ? extractTextFromBlocks(lastAssistantMessage.message.content) : "");
    const baseUuid = randomUUID();
    const baseSessionId = this.getSessionId();
    if (options.isError) {
      const errorMessage = options.errorMessage ?? "Unknown error";
      return {
        type: "result",
        subtype: options.subtype ?? "error_during_execution",
        uuid: baseUuid,
        session_id: baseSessionId,
        is_error: true,
        duration_ms: options.durationMs,
        duration_api_ms: options.apiDurationMs,
        num_turns: options.numTurns,
        usage,
        permission_denials: [...this.permissionDenials],
        error: { message: errorMessage }
      };
    } else {
      const hasStructured = "structuredResult" in options;
      const normalizedStructured = hasStructured ? options.structuredResult ?? null : void 0;
      const finalResult = hasStructured ? JSON.stringify(normalizedStructured) : resultText;
      const success = {
        type: "result",
        subtype: options.subtype ?? "success",
        uuid: baseUuid,
        session_id: baseSessionId,
        is_error: false,
        duration_ms: options.durationMs,
        duration_api_ms: options.apiDurationMs,
        num_turns: options.numTurns,
        result: finalResult,
        usage,
        permission_denials: [...this.permissionDenials]
      };
      if (options.stats) {
        success.stats = options.stats;
      }
      if (hasStructured) {
        success.structured_result = normalizedStructured;
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
  buildSubagentErrorResult(errorMessage, numTurns) {
    const usage = {
      input_tokens: 0,
      output_tokens: 0
    };
    return {
      type: "result",
      subtype: "error_during_execution",
      uuid: randomUUID(),
      session_id: this.getSessionId(),
      is_error: true,
      duration_ms: 0,
      duration_api_ms: 0,
      num_turns: numTurns,
      usage,
      permission_denials: [],
      error: { message: errorMessage }
    };
  }
};
function partsToContentBlock(parts) {
  const blocks = [];
  let currentTextBlock = null;
  for (const part of parts) {
    let textContent = null;
    if ("text" in part && typeof part.text === "string") {
      textContent = part.text;
    } else if ("functionResponse" in part && part.functionResponse) {
      const output = part.functionResponse.response?.["output"] ?? part.functionResponse.response?.["content"] ?? "";
      textContent = typeof output === "string" ? output : JSON.stringify(output);
    } else {
      textContent = JSON.stringify(part);
    }
    if (textContent !== null && textContent.length > 0) {
      if (currentTextBlock === null) {
        currentTextBlock = {
          type: "text",
          text: textContent
        };
        blocks.push(currentTextBlock);
      } else {
        currentTextBlock.text += textContent;
      }
    }
  }
  return blocks;
}
__name(partsToContentBlock, "partsToContentBlock");
function checkResponsePartsForError(responseParts) {
  if (!responseParts || responseParts.length === 0) {
    return void 0;
  }
  for (const part of responseParts) {
    if ("functionResponse" in part && part.functionResponse?.response && typeof part.functionResponse.response === "object" && "error" in part.functionResponse.response && part.functionResponse.response["error"]) {
      const error = part.functionResponse.response["error"];
      return typeof error === "string" ? error : String(error);
    }
  }
  return void 0;
}
__name(checkResponsePartsForError, "checkResponsePartsForError");
function mcpAppFallbackText(display) {
  if (!display || typeof display !== "object" || !("type" in display) || display.type !== "mcp_app" || !("fallbackText" in display) || typeof display.fallbackText !== "string") {
    return void 0;
  }
  const text = display.fallbackText.trim();
  return text.length > 0 ? display.fallbackText : void 0;
}
__name(mcpAppFallbackText, "mcpAppFallbackText");
function toolResultContent(response) {
  if (response.visionBridgeNotice) {
    const content = toolResultContent({
      ...response,
      visionBridgeNotice: void 0
    });
    return content ? `${response.visionBridgeNotice}
${content}` : response.visionBridgeNotice;
  }
  if (isVisionBridgeNoticeDisplay(response.resultDisplay)) {
    const notice = formatVisionBridgeNoticeDisplay(response.resultDisplay);
    if (response.error) {
      return `${notice}
${response.error.message}`;
    }
    const responsePartsError2 = checkResponsePartsForError(
      response.responseParts
    );
    if (responsePartsError2) {
      return `${notice}
${responsePartsError2}`;
    }
    if (response.responseParts && response.responseParts.length > 0) {
      return `${notice}
${functionResponsePartsToString(response.responseParts)}`;
    }
    return notice;
  }
  const responsePartsError = checkResponsePartsForError(response.responseParts);
  if (responsePartsError) {
    return responsePartsError;
  }
  if (response.error) {
    return response.error.message;
  }
  const mcpAppFallback = mcpAppFallbackText(response.resultDisplay);
  if (mcpAppFallback) {
    return mcpAppFallback;
  }
  if (typeof response.resultDisplay === "string" && response.resultDisplay.trim().length > 0) {
    return response.resultDisplay;
  }
  if (response.responseParts && response.responseParts.length > 0) {
    return functionResponsePartsToString(response.responseParts);
  }
  return void 0;
}
__name(toolResultContent, "toolResultContent");
function extractTextFromBlocks(blocks) {
  return blocks.filter((block) => block.type === "text").map((block) => block.type === "text" ? block.text : "").join("");
}
__name(extractTextFromBlocks, "extractTextFromBlocks");
function createExtendedUsage() {
  return {
    input_tokens: 0,
    output_tokens: 0
  };
}
__name(createExtendedUsage, "createExtendedUsage");

// packages/cli/src/nonInteractive/io/StreamJsonOutputAdapter.ts
var StreamJsonOutputAdapter = class extends BaseJsonOutputAdapter {
  constructor(config, includePartialMessages, outputStream) {
    super(config);
    this.includePartialMessages = includePartialMessages;
    this.outputStream = outputStream ?? process.stdout;
  }
  static {
    __name(this, "StreamJsonOutputAdapter");
  }
  mainTurnMessageStartEmitted = false;
  lastGoalStateSignature;
  outputStream;
  /**
   * Emits message immediately to the output stream (stream mode).
   */
  emitMessageImpl(message) {
    if (typeof message === "object" && message !== null && "type" in message && message.type === "assistant") {
      this.updateLastAssistantMessage(message);
    }
    const frame = `${JSON.stringify(message)}
`;
    if ("session_id" in message) {
      observeHeadlessToolResultWire(message, frame);
    }
    this.outputStream.write(frame);
  }
  /**
   * Control-plane messages (control_request / control_response) share the
   * same transport as data messages in stream mode.
   */
  emitControlMessageImpl(message) {
    this.outputStream.write(`${JSON.stringify(message)}
`);
  }
  /**
   * Stream mode emits stream events when includePartialMessages is enabled.
   */
  shouldEmitStreamEvents() {
    return this.includePartialMessages;
  }
  startAssistantMessage() {
    this.mainTurnMessageStartEmitted = false;
    super.startAssistantMessage();
  }
  restartAttempt(preserveText, discardedToolCalls) {
    if (preserveText && discardedToolCalls.length === 0) {
      return;
    }
    if (this.mainAgentMessageState.messageStarted && !this.mainAgentMessageState.finalized) {
      this.finalizeAssistantMessage();
    }
    this.emitDiscardedAttemptToolResults(discardedToolCalls);
    super.restartAttempt(false, discardedToolCalls);
  }
  finalizeAssistantMessage() {
    const message = this.finalizeAssistantMessageInternal(
      this.mainAgentMessageState,
      null
    );
    if (this.mainTurnMessageStartEmitted && this.includePartialMessages) {
      const partial = {
        type: "stream_event",
        uuid: randomUUID2(),
        session_id: this.getSessionId(),
        parent_tool_use_id: null,
        event: { type: "message_stop" }
      };
      this.emitMessageImpl(partial);
    }
    this.mainTurnMessageStartEmitted = false;
    return message;
  }
  emitResult(options) {
    const resultMessage = this.buildResultMessage(
      options,
      this.lastAssistantMessage
    );
    this.emitMessageImpl(resultMessage);
  }
  emitMessage(message) {
    this.emitMessageImpl(message);
  }
  send(message) {
    this.emitMessage(message);
  }
  processEvent(event) {
    if (event.type === "goal_state" /* GoalState */) {
      const signature = JSON.stringify(event.value);
      if (signature === this.lastGoalStateSignature) return;
      this.lastGoalStateSignature = signature;
      const partial = {
        type: "stream_event",
        uuid: randomUUID2(),
        session_id: this.getSessionId(),
        parent_tool_use_id: null,
        event: {
          type: "goal_state",
          goal_state: event.value
        }
      };
      this.emitMessageImpl(partial);
      return;
    }
    if (event.type === "active_goal" /* ActiveGoal */) {
      this.emitStreamEventIfEnabled(
        {
          type: "active_goal",
          active_goal: event.value
        },
        null
      );
      return;
    }
    super.processEvent(event);
  }
  /**
   * Overrides base class hook to emit stream event when text block is created.
   */
  onTextBlockCreated(state, index, block, parentToolUseId) {
    this.emitStreamEventIfEnabled(
      {
        type: "content_block_start",
        index,
        content_block: block
      },
      parentToolUseId
    );
  }
  /**
   * Overrides base class hook to emit stream event when text is appended.
   */
  onTextAppended(state, index, fragment, parentToolUseId) {
    this.emitStreamEventIfEnabled(
      {
        type: "content_block_delta",
        index,
        delta: { type: "text_delta", text: fragment }
      },
      parentToolUseId
    );
  }
  /**
   * Overrides base class hook to emit stream event when thinking block is created.
   */
  onThinkingBlockCreated(state, index, block, parentToolUseId) {
    this.emitStreamEventIfEnabled(
      {
        type: "content_block_start",
        index,
        content_block: block
      },
      parentToolUseId
    );
  }
  /**
   * Overrides base class hook to emit stream event when thinking is appended.
   */
  onThinkingAppended(state, index, fragment, parentToolUseId) {
    this.emitStreamEventIfEnabled(
      {
        type: "content_block_delta",
        index,
        delta: { type: "thinking_delta", thinking: fragment }
      },
      parentToolUseId
    );
  }
  /**
   * Overrides base class hook to emit stream event when tool_use block is created.
   */
  onToolUseBlockCreated(state, index, block, parentToolUseId) {
    this.emitStreamEventIfEnabled(
      {
        type: "content_block_start",
        index,
        content_block: block
      },
      parentToolUseId
    );
  }
  /**
   * Overrides base class hook to emit stream event when tool_use input is set.
   */
  onToolUseInputSet(state, index, input, parentToolUseId) {
    this.emitStreamEventIfEnabled(
      {
        type: "content_block_delta",
        index,
        delta: {
          type: "input_json_delta",
          partial_json: JSON.stringify(input)
        }
      },
      parentToolUseId
    );
  }
  /**
   * Overrides base class hook to emit stream event when block is closed.
   */
  onBlockClosed(state, index, parentToolUseId) {
    if (this.includePartialMessages) {
      this.emitStreamEventIfEnabled(
        {
          type: "content_block_stop",
          index
        },
        parentToolUseId
      );
    }
  }
  /**
   * Overrides base class hook to emit message_start event when message is started.
   * Only emits once per turn for the main agent (guarded by mainTurnMessageStartEmitted),
   * so block-type transitions inside a single turn do not produce spurious message_start events.
   */
  onEnsureMessageStarted(state, parentToolUseId) {
    if (parentToolUseId === null && !this.mainTurnMessageStartEmitted) {
      this.mainTurnMessageStartEmitted = true;
      this.emitStreamEventIfEnabled(
        {
          type: "message_start",
          message: {
            id: state.messageId,
            role: "assistant",
            model: this.config.getModel(),
            content: []
          }
        },
        null
      );
    }
  }
  /**
   * Emits a tool progress stream event when partial messages are enabled.
   * This overrides the no-op in BaseJsonOutputAdapter.
   */
  emitToolProgress(request, progress) {
    if (!this.includePartialMessages) {
      return;
    }
    const partial = {
      type: "stream_event",
      uuid: randomUUID2(),
      session_id: this.getSessionId(),
      parent_tool_use_id: null,
      event: {
        type: "tool_progress",
        tool_use_id: request.callId,
        content: progress
      }
    };
    this.emitMessageImpl(partial);
  }
  /**
   * Emits stream events when partial messages are enabled.
   * This is a private method specific to StreamJsonOutputAdapter.
   * @param event - Stream event to emit
   * @param parentToolUseId - null for main agent, string for subagent
   */
  emitStreamEventIfEnabled(event, parentToolUseId) {
    if (!this.includePartialMessages) {
      return;
    }
    const partial = {
      type: "stream_event",
      uuid: randomUUID2(),
      session_id: this.getSessionId(),
      parent_tool_use_id: parentToolUseId,
      event
    };
    this.emitMessageImpl(partial);
  }
};

export {
  BaseJsonOutputAdapter,
  StreamJsonOutputAdapter
};
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
