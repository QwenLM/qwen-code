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

import type { Config } from '@qwen-code/qwen-code-core';
import { StreamJsonInputReader } from './io/StreamJsonInputReader.js';
import { StreamJsonOutputAdapter } from './io/StreamJsonOutputAdapter.js';
import { ControlContext } from './control/ControlContext.js';
import { ControlDispatcher } from './control/ControlDispatcher.js';
import { ControlService } from './control/ControlService.js';
import type {
  CLIMessage,
  CLIUserMessage,
  CLIControlRequest,
  CLIControlResponse,
  ControlCancelRequest,
} from './types.js';
import {
  isCLIUserMessage,
  isCLIAssistantMessage,
  isCLISystemMessage,
  isCLIResultMessage,
  isCLIPartialAssistantMessage,
  isControlRequest,
  isControlResponse,
  isControlCancel,
} from './types.js';
import { createMinimalSettings } from '../config/settings.js';
import { runNonInteractive } from '../nonInteractiveCli.js';
import { ConsolePatcher } from '../ui/utils/ConsolePatcher.js';

const SESSION_STATE = {
  INITIALIZING: 'initializing',
  IDLE: 'idle',
  PROCESSING_QUERY: 'processing_query',
  SHUTTING_DOWN: 'shutting_down',
} as const;

type SessionState = (typeof SESSION_STATE)[keyof typeof SESSION_STATE];

/**
 * Message type classification for routing
 */
type MessageType =
  | 'control_request'
  | 'control_response'
  | 'control_cancel'
  | 'user'
  | 'assistant'
  | 'system'
  | 'result'
  | 'stream_event'
  | 'unknown';

/**
 * Routed message with classification
 */
interface RoutedMessage {
  type: MessageType;
  message:
    | CLIMessage
    | CLIControlRequest
    | CLIControlResponse
    | ControlCancelRequest;
}

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
  private inputReader: StreamJsonInputReader;
  private outputAdapter: StreamJsonOutputAdapter;
  private controlContext: ControlContext | null = null;
  private dispatcher: ControlDispatcher | null = null;
  private controlService: ControlService | null = null;
  private controlSystemEnabled: boolean | null = null;
  private debugMode: boolean;
  private shutdownHandler: (() => void) | null = null;
  private initialPrompt: CLIUserMessage | null = null;

  constructor(config: Config, initialPrompt?: CLIUserMessage) {
    this.config = config;
    this.sessionId = config.getSessionId();
    this.debugMode = config.getDebugMode();
    this.abortController = new AbortController();
    this.initialPrompt = initialPrompt ?? null;

    this.inputReader = new StreamJsonInputReader();
    this.outputAdapter = new StreamJsonOutputAdapter(
      config,
      config.getIncludePartialMessages(),
    );

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
   * Route a message to the appropriate handler based on its type
   *
   * Classifies incoming messages and routes them to appropriate handlers.
   */
  private route(
    message:
      | CLIMessage
      | CLIControlRequest
      | CLIControlResponse
      | ControlCancelRequest,
  ): RoutedMessage {
    // Check control messages first
    if (isControlRequest(message)) {
      return { type: 'control_request', message };
    }
    if (isControlResponse(message)) {
      return { type: 'control_response', message };
    }
    if (isControlCancel(message)) {
      return { type: 'control_cancel', message };
    }

    // Check data messages
    if (isCLIUserMessage(message)) {
      return { type: 'user', message };
    }
    if (isCLIAssistantMessage(message)) {
      return { type: 'assistant', message };
    }
    if (isCLISystemMessage(message)) {
      return { type: 'system', message };
    }
    if (isCLIResultMessage(message)) {
      return { type: 'result', message };
    }
    if (isCLIPartialAssistantMessage(message)) {
      return { type: 'stream_event', message };
    }

    // Unknown message type
    if (this.debugMode) {
      console.error(
        '[SessionManager] Unknown message type:',
        JSON.stringify(message, null, 2),
      );
    }
    return { type: 'unknown', message };
  }

  /**
   * Process a single message with unified logic for both initial prompt and stream messages.
   *
   * Handles:
   * - Abort check
   * - First message detection and handling
   * - Normal message processing
   * - Shutdown state checks
   *
   * @param message - Message to process
   * @returns true if the calling code should exit (break/return), false to continue
   */
  private async processSingleMessage(
    message:
      | CLIMessage
      | CLIControlRequest
      | CLIControlResponse
      | ControlCancelRequest,
  ): Promise<boolean> {
    // Check for abort
    if (this.abortController.signal.aborted) {
      return true;
    }

    // Handle first message if control system not yet initialized
    if (this.controlSystemEnabled === null) {
      const handled = await this.handleFirstMessage(message);
      if (handled) {
        // If handled, check if we should shutdown
        return this.state === SESSION_STATE.SHUTTING_DOWN;
      }
      // If not handled, fall through to normal processing
    }

    // Process message normally
    await this.processMessage(message);

    // Check for shutdown after processing
    return this.state === SESSION_STATE.SHUTTING_DOWN;
  }

  /**
   * Main entry point - run the session
   */
  async run(): Promise<void> {
    try {
      if (this.debugMode) {
        console.error('[SessionManager] Starting session', this.sessionId);
      }

      // Process initial prompt if provided
      if (this.initialPrompt !== null) {
        const shouldExit = await this.processSingleMessage(this.initialPrompt);
        if (shouldExit) {
          await this.shutdown();
          return;
        }
      }

      // Process messages from stream
      for await (const message of this.inputReader.read()) {
        const shouldExit = await this.processSingleMessage(message);
        if (shouldExit) {
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
      // Ensure signal handlers are always cleaned up even if shutdown wasn't called
      this.cleanupSignalHandlers();
    }
  }

  private ensureControlSystem(): void {
    if (this.controlContext && this.dispatcher && this.controlService) {
      return;
    }
    // The control system follows a strict three-layer architecture:
    // 1. ControlContext (shared session state)
    // 2. ControlDispatcher (protocol routing SDK ↔ CLI)
    // 3. ControlService (programmatic API for CLI runtime)
    //
    // Application code MUST interact with the control plane exclusively through
    // ControlService. ControlDispatcher is reserved for protocol-level message
    // routing and should never be used directly outside of this file.
    this.controlContext = new ControlContext({
      config: this.config,
      streamJson: this.outputAdapter,
      sessionId: this.sessionId,
      abortSignal: this.abortController.signal,
      permissionMode: this.config.getApprovalMode(),
      onInterrupt: () => this.handleInterrupt(),
    });
    this.dispatcher = new ControlDispatcher(this.controlContext);
    this.controlService = new ControlService(
      this.controlContext,
      this.dispatcher,
    );
  }

  private getDispatcher(): ControlDispatcher | null {
    if (this.controlSystemEnabled !== true) {
      return null;
    }
    if (!this.dispatcher) {
      this.ensureControlSystem();
    }
    return this.dispatcher;
  }

  private async handleFirstMessage(
    message:
      | CLIMessage
      | CLIControlRequest
      | CLIControlResponse
      | ControlCancelRequest,
  ): Promise<boolean> {
    const routed = this.route(message);

    if (routed.type === 'control_request') {
      const request = routed.message as CLIControlRequest;
      this.controlSystemEnabled = true;
      this.ensureControlSystem();
      if (request.request.subtype === 'initialize') {
        await this.dispatcher?.dispatch(request);
        this.state = SESSION_STATE.IDLE;
        return true;
      }
      return false;
    }

    if (routed.type === 'user') {
      this.controlSystemEnabled = false;
      this.state = SESSION_STATE.PROCESSING_QUERY;
      this.userMessageQueue.push(routed.message as CLIUserMessage);
      await this.processUserMessageQueue();
      return true;
    }

    this.controlSystemEnabled = false;
    return false;
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
    const routed = this.route(message);

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
      const dispatcher = this.getDispatcher();
      if (!dispatcher) {
        if (this.debugMode) {
          console.error(
            '[SessionManager] Control request received before control system initialization',
          );
        }
        return;
      }
      if (request.request.subtype === 'initialize') {
        await dispatcher.dispatch(request);
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
    const dispatcher = this.getDispatcher();
    if (routed.type === 'control_request') {
      if (!dispatcher) {
        if (this.debugMode) {
          console.error('[SessionManager] Ignoring control request (disabled)');
        }
        return;
      }
      const request = routed.message as CLIControlRequest;
      await dispatcher.dispatch(request);
      // Stay in idle state
    } else if (routed.type === 'control_response') {
      if (!dispatcher) {
        return;
      }
      const response = routed.message as CLIControlResponse;
      dispatcher.handleControlResponse(response);
      // Stay in idle state
    } else if (routed.type === 'control_cancel') {
      if (!dispatcher) {
        return;
      }
      const cancelRequest = routed.message as ControlCancelRequest;
      dispatcher.handleCancel(cancelRequest.request_id);
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
    const dispatcher = this.getDispatcher();
    if (routed.type === 'control_request') {
      if (!dispatcher) {
        if (this.debugMode) {
          console.error(
            '[SessionManager] Control request ignored during processing (disabled)',
          );
        }
        return;
      }
      const request = routed.message as CLIControlRequest;
      await dispatcher.dispatch(request);
      // Continue processing
    } else if (routed.type === 'control_response') {
      if (!dispatcher) {
        return;
      }
      const response = routed.message as CLIControlResponse;
      dispatcher.handleControlResponse(response);
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
        this.emitErrorResult(error);
      }
    }

    // If control system is disabled (single-query mode) and queue is empty,
    // automatically shutdown instead of returning to idle
    if (
      !this.abortController.signal.aborted &&
      this.state === SESSION_STATE.PROCESSING_QUERY &&
      this.controlSystemEnabled === false &&
      this.userMessageQueue.length === 0
    ) {
      if (this.debugMode) {
        console.error(
          '[SessionManager] Single-query mode: queue processed, shutting down',
        );
      }
      this.state = SESSION_STATE.SHUTTING_DOWN;
      return;
    }

    // Return to idle after processing queue (for multi-query mode with control system)
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
    const input = extractUserMessageText(userMessage);
    if (!input) {
      if (this.debugMode) {
        console.error('[SessionManager] No text content in user message');
      }
      return;
    }

    const promptId = this.getNextPromptId();

    try {
      await runNonInteractive(
        this.config,
        createMinimalSettings(),
        input,
        promptId,
        {
          abortController: this.abortController,
          adapter: this.outputAdapter,
          controlService: this.controlService ?? undefined,
        },
      );
    } catch (error) {
      // Error already handled by runNonInteractive via adapter.emitResult
      if (this.debugMode) {
        console.error('[SessionManager] Query execution error:', error);
      }
    }
  }

  /**
   * Send tool results as user message
   */
  private emitErrorResult(
    error: unknown,
    numTurns: number = 0,
    durationMs: number = 0,
    apiDurationMs: number = 0,
  ): void {
    const message = error instanceof Error ? error.message : String(error);
    this.outputAdapter.emitResult({
      isError: true,
      errorMessage: message,
      durationMs,
      apiDurationMs,
      numTurns,
      usage: undefined,
    });
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
    this.shutdownHandler = () => {
      if (this.debugMode) {
        console.error('[SessionManager] Shutdown signal received');
      }
      this.abortController.abort();
      this.state = SESSION_STATE.SHUTTING_DOWN;
    };

    process.on('SIGINT', this.shutdownHandler);
    process.on('SIGTERM', this.shutdownHandler);
  }

  /**
   * Shutdown session and cleanup resources
   */
  private async shutdown(): Promise<void> {
    if (this.debugMode) {
      console.error('[SessionManager] Shutting down');
    }

    this.state = SESSION_STATE.SHUTTING_DOWN;
    this.dispatcher?.shutdown();
    this.cleanupSignalHandlers();
  }

  /**
   * Remove signal handlers to prevent memory leaks
   */
  private cleanupSignalHandlers(): void {
    if (this.shutdownHandler) {
      process.removeListener('SIGINT', this.shutdownHandler);
      process.removeListener('SIGTERM', this.shutdownHandler);
      this.shutdownHandler = null;
    }
  }
}

function extractUserMessageText(message: CLIUserMessage): string | null {
  const content = message.message.content;
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    const parts = content
      .map((block) => {
        if (!block || typeof block !== 'object') {
          return '';
        }
        if ('type' in block && block.type === 'text' && 'text' in block) {
          return typeof block.text === 'string' ? block.text : '';
        }
        return JSON.stringify(block);
      })
      .filter((part) => part.length > 0);

    return parts.length > 0 ? parts.join('\n') : null;
  }

  return null;
}

/**
 * Entry point for stream-json mode
 *
 * @param config - Configuration object
 * @param input - Optional initial prompt input to process before reading from stream
 */
export async function runNonInteractiveStreamJson(
  config: Config,
  input: string,
): Promise<void> {
  const consolePatcher = new ConsolePatcher({
    debugMode: config.getDebugMode(),
  });
  consolePatcher.patch();

  try {
    // Create initial user message from prompt input if provided
    let initialPrompt: CLIUserMessage | undefined = undefined;
    if (input && input.trim().length > 0) {
      const sessionId = config.getSessionId();
      initialPrompt = {
        type: 'user',
        session_id: sessionId,
        message: {
          role: 'user',
          content: input.trim(),
        },
        parent_tool_use_id: null,
      };
    }

    const manager = new SessionManager(config, initialPrompt);
    await manager.run();
  } finally {
    consolePatcher.cleanup();
  }
}
