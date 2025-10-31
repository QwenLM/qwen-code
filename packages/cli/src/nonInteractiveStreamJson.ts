/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Stream JSON Runner with Session State Machine
 *
 * Handles stream-json input/output format with:
 * - Initialize handshake
 * - Message routing (control vs user messages)
 * - FIFO user message queue
 * - Sequential message processing
 * - Graceful shutdown
 */

import type { Config, ToolCallRequestInfo } from '@qwen-code/qwen-code-core';
import { GeminiEventType, executeToolCall } from '@qwen-code/qwen-code-core';
import type { Part, PartListUnion } from '@google/genai';
import { ConsolePatcher } from './ui/utils/ConsolePatcher.js';
import { handleAtCommand } from './ui/hooks/atCommandProcessor.js';
import { StreamJson, extractUserMessageText } from './services/StreamJson.js';
import { MessageRouter, type RoutedMessage } from './services/MessageRouter.js';
import { ControlContext } from './services/control/ControlContext.js';
import { ControlDispatcher } from './services/control/ControlDispatcher.js';
import type {
  CLIMessage,
  CLIUserMessage,
  CLIResultMessage,
  ToolResultBlock,
  CLIControlRequest,
  CLIControlResponse,
  ControlCancelRequest,
} from './types/protocol.js';

const SESSION_STATE = {
  INITIALIZING: 'initializing',
  IDLE: 'idle',
  PROCESSING_QUERY: 'processing_query',
  SHUTTING_DOWN: 'shutting_down',
} as const;

type SessionState = (typeof SESSION_STATE)[keyof typeof SESSION_STATE];

/**
 * Session Manager
 *
 * Manages the session lifecycle and message processing state machine.
 */
class SessionManager {
  private state: SessionState = SESSION_STATE.INITIALIZING;
  private userMessageQueue: CLIUserMessage[] = [];
  private abortController: AbortController;
  private config: Config;
  private sessionId: string;
  private promptIdCounter: number = 0;
  private streamJson: StreamJson;
  private router: MessageRouter;
  private controlContext: ControlContext;
  private dispatcher: ControlDispatcher;
  private consolePatcher: ConsolePatcher;
  private debugMode: boolean;

  constructor(config: Config) {
    this.config = config;
    this.sessionId = config.getSessionId();
    this.debugMode = config.getDebugMode();
    this.abortController = new AbortController();

    this.consolePatcher = new ConsolePatcher({
      stderr: true,
      debugMode: this.debugMode,
    });

    this.streamJson = new StreamJson({
      input: process.stdin,
      output: process.stdout,
    });

    this.router = new MessageRouter(config);

    // Create control context
    this.controlContext = new ControlContext({
      config,
      streamJson: this.streamJson,
      sessionId: this.sessionId,
      abortSignal: this.abortController.signal,
      permissionMode: this.config.getApprovalMode(),
      onInterrupt: () => this.handleInterrupt(),
    });

    // Create dispatcher with context (creates controllers internally)
    this.dispatcher = new ControlDispatcher(this.controlContext);

    // Setup signal handlers for graceful shutdown
    this.setupSignalHandlers();
  }

  /**
   * Get next prompt ID
   */
  private getNextPromptId(): string {
    this.promptIdCounter++;
    return `${this.sessionId}########${this.promptIdCounter}`;
  }

  /**
   * Main entry point - run the session
   */
  async run(): Promise<void> {
    try {
      this.consolePatcher.patch();

      if (this.debugMode) {
        console.error('[SessionManager] Starting session', this.sessionId);
      }

      // Main message processing loop
      for await (const message of this.streamJson.readMessages()) {
        if (this.abortController.signal.aborted) {
          break;
        }

        await this.processMessage(message);

        // Check if we should exit
        if (this.state === SESSION_STATE.SHUTTING_DOWN) {
          break;
        }
      }

      // Stream closed, shutdown
      await this.shutdown();
    } catch (error) {
      if (this.debugMode) {
        console.error('[SessionManager] Error:', error);
      }
      await this.shutdown();
      throw error;
    } finally {
      this.consolePatcher.cleanup();
    }
  }

  /**
   * Process a single message from the stream
   */
  private async processMessage(
    message:
      | CLIMessage
      | CLIControlRequest
      | CLIControlResponse
      | ControlCancelRequest,
  ): Promise<void> {
    const routed = this.router.route(message);

    if (this.debugMode) {
      console.error(
        `[SessionManager] State: ${this.state}, Message type: ${routed.type}`,
      );
    }

    switch (this.state) {
      case SESSION_STATE.INITIALIZING:
        await this.handleInitializingState(routed);
        break;

      case SESSION_STATE.IDLE:
        await this.handleIdleState(routed);
        break;

      case SESSION_STATE.PROCESSING_QUERY:
        await this.handleProcessingState(routed);
        break;

      case SESSION_STATE.SHUTTING_DOWN:
        // Ignore all messages during shutdown
        break;

      default: {
        // Exhaustive check
        const _exhaustiveCheck: never = this.state;
        if (this.debugMode) {
          console.error('[SessionManager] Unknown state:', _exhaustiveCheck);
        }
        break;
      }
    }
  }

  /**
   * Handle messages in initializing state
   */
  private async handleInitializingState(routed: RoutedMessage): Promise<void> {
    if (routed.type === 'control_request') {
      const request = routed.message as CLIControlRequest;
      if (request.request.subtype === 'initialize') {
        await this.dispatcher.dispatch(request);
        this.state = SESSION_STATE.IDLE;
        if (this.debugMode) {
          console.error('[SessionManager] Initialized, transitioning to idle');
        }
      } else {
        if (this.debugMode) {
          console.error(
            '[SessionManager] Ignoring non-initialize control request during initialization',
          );
        }
      }
    } else {
      if (this.debugMode) {
        console.error(
          '[SessionManager] Ignoring non-control message during initialization',
        );
      }
    }
  }

  /**
   * Handle messages in idle state
   */
  private async handleIdleState(routed: RoutedMessage): Promise<void> {
    if (routed.type === 'control_request') {
      const request = routed.message as CLIControlRequest;
      await this.dispatcher.dispatch(request);
      // Stay in idle state
    } else if (routed.type === 'control_response') {
      const response = routed.message as CLIControlResponse;
      this.dispatcher.handleControlResponse(response);
      // Stay in idle state
    } else if (routed.type === 'control_cancel') {
      // Handle cancellation
      const cancelRequest = routed.message as ControlCancelRequest;
      this.dispatcher.handleCancel(cancelRequest.request_id);
    } else if (routed.type === 'user') {
      const userMessage = routed.message as CLIUserMessage;
      this.userMessageQueue.push(userMessage);
      // Start processing queue
      await this.processUserMessageQueue();
    } else {
      if (this.debugMode) {
        console.error(
          '[SessionManager] Ignoring message type in idle state:',
          routed.type,
        );
      }
    }
  }

  /**
   * Handle messages in processing state
   */
  private async handleProcessingState(routed: RoutedMessage): Promise<void> {
    if (routed.type === 'control_request') {
      const request = routed.message as CLIControlRequest;
      await this.dispatcher.dispatch(request);
      // Continue processing
    } else if (routed.type === 'control_response') {
      const response = routed.message as CLIControlResponse;
      this.dispatcher.handleControlResponse(response);
      // Continue processing
    } else if (routed.type === 'user') {
      // Enqueue for later
      const userMessage = routed.message as CLIUserMessage;
      this.userMessageQueue.push(userMessage);
      if (this.debugMode) {
        console.error(
          '[SessionManager] Enqueued user message during processing',
        );
      }
    } else {
      if (this.debugMode) {
        console.error(
          '[SessionManager] Ignoring message type during processing:',
          routed.type,
        );
      }
    }
  }

  /**
   * Process user message queue (FIFO)
   */
  private async processUserMessageQueue(): Promise<void> {
    while (
      this.userMessageQueue.length > 0 &&
      !this.abortController.signal.aborted
    ) {
      this.state = SESSION_STATE.PROCESSING_QUERY;
      const userMessage = this.userMessageQueue.shift()!;

      try {
        await this.processUserMessage(userMessage);
      } catch (error) {
        if (this.debugMode) {
          console.error(
            '[SessionManager] Error processing user message:',
            error,
          );
        }
        // Send error result
        this.sendErrorResult(
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    // Return to idle after processing queue
    if (
      !this.abortController.signal.aborted &&
      this.state === SESSION_STATE.PROCESSING_QUERY
    ) {
      this.state = SESSION_STATE.IDLE;
      if (this.debugMode) {
        console.error('[SessionManager] Queue processed, returning to idle');
      }
    }
  }

  /**
   * Process a single user message
   */
  private async processUserMessage(userMessage: CLIUserMessage): Promise<void> {
    // Extract text from user message
    const texts = extractUserMessageText(userMessage);
    if (texts.length === 0) {
      if (this.debugMode) {
        console.error('[SessionManager] No text content in user message');
      }
      return;
    }

    const input = texts.join('\n');

    // Handle @command preprocessing
    const { processedQuery, shouldProceed } = await handleAtCommand({
      query: input,
      config: this.config,
      addItem: (_item, _timestamp) => 0,
      onDebugMessage: () => {},
      messageId: Date.now(),
      signal: this.abortController.signal,
    });

    if (!shouldProceed || !processedQuery) {
      this.sendErrorResult('Error processing input');
      return;
    }

    // Execute query via Gemini client
    await this.executeQuery(processedQuery);
  }

  /**
   * Execute query through Gemini client
   */
  private async executeQuery(query: PartListUnion): Promise<void> {
    const geminiClient = this.config.getGeminiClient();
    const promptId = this.getNextPromptId();
    let accumulatedContent = '';
    let turnCount = 0;
    const maxTurns = this.config.getMaxSessionTurns();

    try {
      let currentMessages: PartListUnion = query;

      while (true) {
        turnCount++;

        if (maxTurns >= 0 && turnCount > maxTurns) {
          this.sendErrorResult(`Reached max turns: ${turnCount}`);
          return;
        }

        const toolCallRequests: ToolCallRequestInfo[] = [];

        // Create assistant message builder for this turn
        const assistantBuilder = this.streamJson.createAssistantBuilder(
          this.sessionId,
          null, // parent_tool_use_id
          this.config.getModel(),
          false, // includePartialMessages - TODO: make this configurable
        );

        // Stream response from Gemini
        const responseStream = geminiClient.sendMessageStream(
          currentMessages,
          this.abortController.signal,
          promptId,
        );

        for await (const event of responseStream) {
          if (this.abortController.signal.aborted) {
            return;
          }

          switch (event.type) {
            case GeminiEventType.Content:
              // Process content through builder
              assistantBuilder.processEvent(event);
              accumulatedContent += event.value;
              break;

            case GeminiEventType.Thought:
              // Process thinking through builder
              assistantBuilder.processEvent(event);
              break;

            case GeminiEventType.ToolCallRequest:
              // Process tool call through builder
              assistantBuilder.processEvent(event);
              toolCallRequests.push(event.value);
              break;

            case GeminiEventType.Finished: {
              // Finalize and send assistant message
              assistantBuilder.processEvent(event);
              const assistantMessage = assistantBuilder.finalize();
              this.streamJson.send(assistantMessage);
              break;
            }

            case GeminiEventType.Error:
              this.sendErrorResult(event.value.error.message);
              return;

            case GeminiEventType.MaxSessionTurns:
              this.sendErrorResult('Max session turns exceeded');
              return;

            case GeminiEventType.SessionTokenLimitExceeded:
              this.sendErrorResult(event.value.message);
              return;

            default:
              // Ignore other event types
              break;
          }
        }

        // Handle tool calls - execute tools and continue conversation
        if (toolCallRequests.length > 0) {
          // Execute tools and prepare response
          const toolResponseParts: Part[] = [];
          for (const requestInfo of toolCallRequests) {
            // Check permissions before executing tool
            const permissionResult =
              await this.checkToolPermission(requestInfo);
            if (!permissionResult.allowed) {
              if (this.debugMode) {
                console.error(
                  `[SessionManager] Tool execution denied: ${requestInfo.name} - ${permissionResult.message}`,
                );
              }
              // Skip this tool and continue with others
              continue;
            }

            // Use updated args if provided by permission check
            const finalRequestInfo = permissionResult.updatedArgs
              ? { ...requestInfo, args: permissionResult.updatedArgs }
              : requestInfo;

            // Execute tool
            const toolResponse = await executeToolCall(
              this.config,
              finalRequestInfo,
              this.abortController.signal,
              {
                onToolCallsUpdate:
                  this.dispatcher.permissionController.getToolCallUpdateCallback(),
              },
            );

            if (toolResponse.responseParts) {
              toolResponseParts.push(...toolResponse.responseParts);
            }

            if (toolResponse.error && this.debugMode) {
              console.error(
                `[SessionManager] Tool execution error: ${requestInfo.name}`,
                toolResponse.error,
              );
            }
          }

          // Send tool results as user message
          this.sendToolResultsAsUserMessage(
            toolCallRequests,
            toolResponseParts,
          );

          // Continue with tool responses for next turn
          currentMessages = toolResponseParts;
        } else {
          // No more tool calls, done
          this.sendSuccessResult(accumulatedContent);
          return;
        }
      }
    } catch (error) {
      if (this.debugMode) {
        console.error('[SessionManager] Query execution error:', error);
      }
      this.sendErrorResult(
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  /**
   * Check tool permission before execution
   */
  private async checkToolPermission(requestInfo: ToolCallRequestInfo): Promise<{
    allowed: boolean;
    message?: string;
    updatedArgs?: Record<string, unknown>;
  }> {
    try {
      // Get permission controller from dispatcher
      const permissionController = this.dispatcher.permissionController;
      if (!permissionController) {
        // Fallback: allow if no permission controller available
        if (this.debugMode) {
          console.error(
            '[SessionManager] No permission controller available, allowing tool execution',
          );
        }
        return { allowed: true };
      }

      // Check permission using the controller
      return await permissionController.shouldAllowTool(requestInfo);
    } catch (error) {
      if (this.debugMode) {
        console.error(
          '[SessionManager] Error checking tool permission:',
          error,
        );
      }
      // Fail safe: deny on error
      return {
        allowed: false,
        message:
          error instanceof Error
            ? `Permission check failed: ${error.message}`
            : 'Permission check failed',
      };
    }
  }

  /**
   * Send tool results as user message
   */
  private sendToolResultsAsUserMessage(
    toolCallRequests: ToolCallRequestInfo[],
    toolResponseParts: Part[],
  ): void {
    // Create a map of function response names to call IDs
    const callIdMap = new Map<string, string>();
    for (const request of toolCallRequests) {
      callIdMap.set(request.name, request.callId);
    }

    // Convert Part[] to ToolResultBlock[]
    const toolResultBlocks: ToolResultBlock[] = [];

    for (const part of toolResponseParts) {
      if (part.functionResponse) {
        const functionName = part.functionResponse.name;
        if (!functionName) continue;

        const callId = callIdMap.get(functionName) || functionName;

        // Extract content from function response
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let content: string | Array<Record<string, any>> | null = null;
        if (part.functionResponse.response?.['output']) {
          const output = part.functionResponse.response['output'];
          if (typeof output === 'string') {
            content = output;
          } else if (Array.isArray(output)) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            content = output as Array<Record<string, any>>;
          } else {
            content = JSON.stringify(output);
          }
        }

        const toolResultBlock: ToolResultBlock = {
          type: 'tool_result',
          tool_use_id: callId,
          content,
          is_error: false,
        };
        toolResultBlocks.push(toolResultBlock);
      }
    }

    // Only send if we have tool result blocks
    if (toolResultBlocks.length > 0) {
      const userMessage: CLIUserMessage = {
        type: 'user',
        uuid: `${this.sessionId}-tool-result-${Date.now()}`,
        session_id: this.sessionId,
        message: {
          role: 'user',
          content: toolResultBlocks,
        },
        parent_tool_use_id: null,
      };
      this.streamJson.send(userMessage);
    }
  }

  /**
   * Send success result
   */
  private sendSuccessResult(message: string): void {
    const result: CLIResultMessage = {
      type: 'result',
      subtype: 'success',
      uuid: `${this.sessionId}-result-${Date.now()}`,
      session_id: this.sessionId,
      is_error: false,
      duration_ms: 0,
      duration_api_ms: 0,
      num_turns: 0,
      result: message || 'Query completed successfully',
      total_cost_usd: 0,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
      },
      permission_denials: [],
    };
    this.streamJson.send(result);
  }

  /**
   * Send error result
   */
  private sendErrorResult(_errorMessage: string): void {
    // Note: CLIResultMessageError doesn't have a result field
    // Error details would need to be logged separately or the type needs updating
    const result: CLIResultMessage = {
      type: 'result',
      subtype: 'error_during_execution',
      uuid: `${this.sessionId}-result-${Date.now()}`,
      session_id: this.sessionId,
      is_error: true,
      duration_ms: 0,
      duration_api_ms: 0,
      num_turns: 0,
      total_cost_usd: 0,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
      },
      permission_denials: [],
    };
    this.streamJson.send(result);
  }

  /**
   * Handle interrupt control request
   */
  private handleInterrupt(): void {
    if (this.debugMode) {
      console.error('[SessionManager] Interrupt requested');
    }
    // Abort current query if processing
    if (this.state === SESSION_STATE.PROCESSING_QUERY) {
      this.abortController.abort();
      this.abortController = new AbortController(); // Create new controller for next query
    }
  }

  /**
   * Setup signal handlers for graceful shutdown
   */
  private setupSignalHandlers(): void {
    const shutdownHandler = () => {
      if (this.debugMode) {
        console.error('[SessionManager] Shutdown signal received');
      }
      this.abortController.abort();
      this.state = SESSION_STATE.SHUTTING_DOWN;
    };

    process.on('SIGINT', shutdownHandler);
    process.on('SIGTERM', shutdownHandler);

    // Handle stdin close - let the session complete naturally
    // instead of immediately aborting when input stream ends
    process.stdin.on('close', () => {
      if (this.debugMode) {
        console.error(
          '[SessionManager] stdin closed - waiting for generation to complete',
        );
      }
      // Don't abort immediately - let the message processing loop exit naturally
      // when streamJson.readMessages() completes, which will trigger shutdown()
    });
  }

  /**
   * Shutdown session and cleanup resources
   */
  private async shutdown(): Promise<void> {
    if (this.debugMode) {
      console.error('[SessionManager] Shutting down');
    }

    this.state = SESSION_STATE.SHUTTING_DOWN;
    this.dispatcher.shutdown();
    this.streamJson.cleanup();
  }
}

/**
 * Entry point for stream-json mode
 */
export async function runNonInteractiveStreamJson(
  config: Config,
  _input: string,
  _promptId: string,
): Promise<void> {
  const manager = new SessionManager(config);
  await manager.run();
}
