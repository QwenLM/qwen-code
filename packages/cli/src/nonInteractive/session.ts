/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  Config,
  ConfigInitializeOptions,
} from '@qwen-code/qwen-code-core';
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

class Session {
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
  private processingPromise: Promise<void> | null = null;
  private isShuttingDown: boolean = false;
  private configInitialized: boolean = false;

  // Single initialization promise that resolves when session is ready for user messages.
  // Created lazily once initialization actually starts.
  private initializationPromise: Promise<void> | null = null;
  private initializationResolve: (() => void) | null = null;
  private initializationReject: ((error: Error) => void) | null = null;

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

    this.setupSignalHandlers();
  }

  private ensureInitializationPromise(): void {
    if (this.initializationPromise) {
      return;
    }
    this.initializationPromise = new Promise<void>((resolve, reject) => {
      this.initializationResolve = () => {
        resolve();
        this.initializationResolve = null;
        this.initializationReject = null;
      };
      this.initializationReject = (error: Error) => {
        reject(error);
        this.initializationResolve = null;
        this.initializationReject = null;
      };
    });
  }

  private getNextPromptId(): string {
    this.promptIdCounter++;
    return `${this.sessionId}########${this.promptIdCounter}`;
  }

  private async ensureConfigInitialized(
    options?: ConfigInitializeOptions,
  ): Promise<void> {
    if (this.configInitialized) {
      return;
    }

    if (this.debugMode) {
      console.error('[Session] Initializing config');
    }

    try {
      await this.config.initialize(options);
      this.configInitialized = true;
    } catch (error) {
      if (this.debugMode) {
        console.error('[Session] Failed to initialize config:', error);
      }
      throw error;
    }
  }

  /**
   * Mark initialization as complete
   */
  private completeInitialization(): void {
    if (this.initializationResolve) {
      if (this.debugMode) {
        console.error('[Session] Initialization complete');
      }
      this.initializationResolve();
      this.initializationResolve = null;
      this.initializationReject = null;
    }
  }

  /**
   * Mark initialization as failed
   */
  private failInitialization(error: Error): void {
    if (this.initializationReject) {
      if (this.debugMode) {
        console.error('[Session] Initialization failed:', error);
      }
      this.initializationReject(error);
      this.initializationResolve = null;
      this.initializationReject = null;
    }
  }

  /**
   * Wait for session to be ready for user messages
   */
  private async waitForInitialization(): Promise<void> {
    if (!this.initializationPromise) {
      return;
    }
    await this.initializationPromise;
  }

  private ensureControlSystem(): void {
    if (this.controlContext && this.dispatcher && this.controlService) {
      return;
    }
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

  /**
   * Handle the first message to determine session mode (SDK vs direct).
   * This is synchronous from the message loop's perspective - it starts
   * async work but does not return a promise that the loop awaits.
   *
   * The initialization completes asynchronously and resolves initializationPromise
   * when ready for user messages.
   */
  private handleFirstMessage(
    message:
      | CLIMessage
      | CLIControlRequest
      | CLIControlResponse
      | ControlCancelRequest,
  ): void {
    if (isControlRequest(message)) {
      const request = message as CLIControlRequest;
      this.controlSystemEnabled = true;
      this.ensureControlSystem();

      if (request.request.subtype === 'initialize') {
        // Start SDK mode initialization (fire-and-forget from loop perspective)
        void this.initializeSdkMode(request);
        return;
      }

      if (this.debugMode) {
        console.error(
          '[Session] Ignoring non-initialize control request during initialization',
        );
      }
      return;
    }

    if (isCLIUserMessage(message)) {
      this.controlSystemEnabled = false;
      // Start direct mode initialization (fire-and-forget from loop perspective)
      void this.initializeDirectMode(message as CLIUserMessage);
      return;
    }

    this.controlSystemEnabled = false;
  }

  /**
   * SDK mode initialization flow
   * Dispatches initialize request and initializes config with MCP support
   */
  private async initializeSdkMode(request: CLIControlRequest): Promise<void> {
    this.ensureInitializationPromise();
    try {
      // Dispatch the initialize request first
      // This registers SDK MCP servers in the control context
      await this.dispatcher?.dispatch(request);

      // Get sendSdkMcpMessage callback from SdkMcpController
      // This callback is used by McpClientManager to send MCP messages
      // from CLI MCP clients to SDK MCP servers via the control plane
      const sendSdkMcpMessage =
        this.dispatcher?.sdkMcpController.createSendSdkMcpMessage();

      // Initialize config with SDK MCP message support
      await this.ensureConfigInitialized({ sendSdkMcpMessage });

      // Initialization complete!
      this.completeInitialization();
    } catch (error) {
      if (this.debugMode) {
        console.error('[Session] SDK mode initialization failed:', error);
      }
      this.failInitialization(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  /**
   * Direct mode initialization flow
   * Initializes config and enqueues the first user message
   */
  private async initializeDirectMode(
    userMessage: CLIUserMessage,
  ): Promise<void> {
    this.ensureInitializationPromise();
    try {
      // Initialize config
      await this.ensureConfigInitialized();

      // Initialization complete!
      this.completeInitialization();

      // Enqueue the first user message for processing
      this.enqueueUserMessage(userMessage);
    } catch (error) {
      if (this.debugMode) {
        console.error('[Session] Direct mode initialization failed:', error);
      }
      this.failInitialization(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  /**
   * Handle control request asynchronously (fire-and-forget from main loop).
   * Errors are handled internally and responses sent by dispatcher.
   */
  private handleControlRequestAsync(request: CLIControlRequest): void {
    const dispatcher = this.getDispatcher();
    if (!dispatcher) {
      if (this.debugMode) {
        console.error('[Session] Control system not enabled');
      }
      return;
    }

    // Fire-and-forget: dispatch runs concurrently
    // The dispatcher's pendingIncomingRequests tracks completion
    void dispatcher.dispatch(request).catch((error) => {
      if (this.debugMode) {
        console.error('[Session] Control request dispatch error:', error);
      }
      // Error response is already sent by dispatcher.dispatch()
    });
  }

  /**
   * Handle control response - MUST be synchronous
   * This resolves pending outgoing requests, breaking the deadlock cycle.
   */
  private handleControlResponse(response: CLIControlResponse): void {
    const dispatcher = this.getDispatcher();
    if (!dispatcher) {
      return;
    }

    dispatcher.handleControlResponse(response);
  }

  private handleControlCancel(cancelRequest: ControlCancelRequest): void {
    const dispatcher = this.getDispatcher();
    if (!dispatcher) {
      return;
    }

    dispatcher.handleCancel(cancelRequest.request_id);
  }

  private async processUserMessage(userMessage: CLIUserMessage): Promise<void> {
    const input = extractUserMessageText(userMessage);
    if (!input) {
      if (this.debugMode) {
        console.error('[Session] No text content in user message');
      }
      return;
    }

    // Wait for initialization to complete before processing user messages
    await this.waitForInitialization();

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
      if (this.debugMode) {
        console.error('[Session] Query execution error:', error);
      }
    }
  }

  private async processUserMessageQueue(): Promise<void> {
    if (this.isShuttingDown || this.abortController.signal.aborted) {
      return;
    }

    while (
      this.userMessageQueue.length > 0 &&
      !this.isShuttingDown &&
      !this.abortController.signal.aborted
    ) {
      const userMessage = this.userMessageQueue.shift()!;
      try {
        await this.processUserMessage(userMessage);
      } catch (error) {
        if (this.debugMode) {
          console.error('[Session] Error processing user message:', error);
        }
        this.emitErrorResult(error);
      }
    }
  }

  private enqueueUserMessage(userMessage: CLIUserMessage): void {
    this.userMessageQueue.push(userMessage);
    this.ensureProcessingStarted();
  }

  private ensureProcessingStarted(): void {
    if (this.processingPromise) {
      return;
    }

    this.processingPromise = this.processUserMessageQueue().finally(() => {
      this.processingPromise = null;
      if (
        this.userMessageQueue.length > 0 &&
        !this.isShuttingDown &&
        !this.abortController.signal.aborted
      ) {
        this.ensureProcessingStarted();
      }
    });
  }

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

  private handleInterrupt(): void {
    if (this.debugMode) {
      console.error('[Session] Interrupt requested');
    }
    this.abortController.abort();
    this.abortController = new AbortController();
  }

  private setupSignalHandlers(): void {
    this.shutdownHandler = () => {
      if (this.debugMode) {
        console.error('[Session] Shutdown signal received');
      }
      this.isShuttingDown = true;
      this.abortController.abort();
    };

    process.on('SIGINT', this.shutdownHandler);
    process.on('SIGTERM', this.shutdownHandler);
  }

  /**
   * Wait for all pending work to complete before shutdown
   */
  private async waitForAllPendingWork(): Promise<void> {
    // 1. Wait for initialization to complete (or fail)
    try {
      await this.waitForInitialization();
    } catch (error) {
      if (this.debugMode) {
        console.error('[Session] Initialization error during shutdown:', error);
      }
    }

    // 2. Wait for all control request handlers using dispatcher's tracking
    if (this.dispatcher) {
      const pendingCount = this.dispatcher.getPendingIncomingRequestCount();
      if (pendingCount > 0 && this.debugMode) {
        console.error(
          `[Session] Waiting for ${pendingCount} pending control request handlers`,
        );
      }
      await this.dispatcher.waitForPendingIncomingRequests();
    }

    // 3. Wait for user message processing queue
    while (this.processingPromise) {
      if (this.debugMode) {
        console.error('[Session] Waiting for user message processing');
      }
      try {
        await this.processingPromise;
      } catch (error) {
        if (this.debugMode) {
          console.error('[Session] Error in user message processing:', error);
        }
      }
    }
  }

  private async shutdown(): Promise<void> {
    if (this.debugMode) {
      console.error('[Session] Shutting down');
    }

    this.isShuttingDown = true;

    // Wait for all pending work
    await this.waitForAllPendingWork();

    this.dispatcher?.shutdown();
    this.cleanupSignalHandlers();
  }

  private cleanupSignalHandlers(): void {
    if (this.shutdownHandler) {
      process.removeListener('SIGINT', this.shutdownHandler);
      process.removeListener('SIGTERM', this.shutdownHandler);
      this.shutdownHandler = null;
    }
  }

  /**
   * Main message processing loop
   *
   * CRITICAL: This loop must NEVER await handlers that might need to
   * send control requests and wait for responses. Such handlers must
   * be started in fire-and-forget mode, allowing the loop to continue
   * reading responses that resolve pending requests.
   *
   * Message handling order:
   * 1. control_response - FIRST, synchronously resolves pending requests
   * 2. First message - determines mode, starts async initialization
   * 3. control_request - fire-and-forget, tracked by dispatcher
   * 4. control_cancel - synchronous
   * 5. user_message - enqueued for processing
   */
  async run(): Promise<void> {
    try {
      if (this.debugMode) {
        console.error('[Session] Starting session', this.sessionId);
      }

      // Handle initial prompt if provided (fire-and-forget)
      if (this.initialPrompt !== null) {
        this.handleFirstMessage(this.initialPrompt);
      }

      try {
        for await (const message of this.inputReader.read()) {
          if (this.abortController.signal.aborted) {
            break;
          }

          // ============================================================
          // CRITICAL: Handle control_response FIRST and SYNCHRONOUSLY
          // This resolves pending outgoing requests, breaking deadlock.
          // ============================================================
          if (isControlResponse(message)) {
            this.handleControlResponse(message as CLIControlResponse);
            continue;
          }

          // Handle first message to determine session mode
          if (this.controlSystemEnabled === null) {
            this.handleFirstMessage(message);
            continue;
          }

          // ============================================================
          // CRITICAL: Handle control_request in FIRE-AND-FORGET mode
          // DON'T await - let handler run concurrently while loop continues
          // Dispatcher's pendingIncomingRequests tracks completion
          // ============================================================
          if (isControlRequest(message)) {
            this.handleControlRequestAsync(message as CLIControlRequest);
          } else if (isControlCancel(message)) {
            // Cancel is synchronous - OK to handle inline
            this.handleControlCancel(message as ControlCancelRequest);
          } else if (isCLIUserMessage(message)) {
            // User messages are enqueued, processing runs separately
            this.enqueueUserMessage(message as CLIUserMessage);
          } else if (this.debugMode) {
            if (
              !isCLIAssistantMessage(message) &&
              !isCLISystemMessage(message) &&
              !isCLIResultMessage(message) &&
              !isCLIPartialAssistantMessage(message)
            ) {
              console.error(
                '[Session] Unknown message type:',
                JSON.stringify(message, null, 2),
              );
            }
          }

          if (this.isShuttingDown) {
            break;
          }
        }
      } catch (streamError) {
        if (this.debugMode) {
          console.error('[Session] Stream reading error:', streamError);
        }
        throw streamError;
      }

      // Stream ended - wait for all pending work before shutdown
      await this.waitForAllPendingWork();
      await this.shutdown();
    } catch (error) {
      if (this.debugMode) {
        console.error('[Session] Error:', error);
      }
      await this.shutdown();
      throw error;
    } finally {
      this.cleanupSignalHandlers();
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

export async function runNonInteractiveStreamJson(
  config: Config,
  input: string,
): Promise<void> {
  const consolePatcher = new ConsolePatcher({
    debugMode: config.getDebugMode(),
  });
  consolePatcher.patch();

  try {
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

    const manager = new Session(config, initialPrompt);
    await manager.run();
  } finally {
    consolePatcher.cleanup();
  }
}
