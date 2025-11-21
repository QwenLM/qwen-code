/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
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

  private getNextPromptId(): string {
    this.promptIdCounter++;
    return `${this.sessionId}########${this.promptIdCounter}`;
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

  private async handleFirstMessage(
    message:
      | CLIMessage
      | CLIControlRequest
      | CLIControlResponse
      | ControlCancelRequest,
  ): Promise<boolean> {
    if (isControlRequest(message)) {
      const request = message as CLIControlRequest;
      this.controlSystemEnabled = true;
      this.ensureControlSystem();
      if (request.request.subtype === 'initialize') {
        await this.dispatcher?.dispatch(request);
        return true;
      }
      if (this.debugMode) {
        console.error(
          '[Session] Ignoring non-initialize control request during initialization',
        );
      }
      return true;
    }

    if (isCLIUserMessage(message)) {
      this.controlSystemEnabled = false;
      this.enqueueUserMessage(message as CLIUserMessage);
      return true;
    }

    this.controlSystemEnabled = false;
    return false;
  }

  private async handleControlRequest(
    request: CLIControlRequest,
  ): Promise<void> {
    const dispatcher = this.getDispatcher();
    if (!dispatcher) {
      if (this.debugMode) {
        console.error('[Session] Control system not enabled');
      }
      return;
    }

    await dispatcher.dispatch(request);
  }

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

  private async shutdown(): Promise<void> {
    if (this.debugMode) {
      console.error('[Session] Shutting down');
    }

    this.isShuttingDown = true;

    if (this.processingPromise) {
      try {
        await this.processingPromise;
      } catch (error) {
        if (this.debugMode) {
          console.error(
            '[Session] Error waiting for processing to complete:',
            error,
          );
        }
      }
    }

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

  async run(): Promise<void> {
    try {
      if (this.debugMode) {
        console.error('[Session] Starting session', this.sessionId);
      }

      if (this.initialPrompt !== null) {
        const handled = await this.handleFirstMessage(this.initialPrompt);
        if (handled && this.isShuttingDown) {
          await this.shutdown();
          return;
        }
      }

      try {
        for await (const message of this.inputReader.read()) {
          if (this.abortController.signal.aborted) {
            break;
          }

          if (this.controlSystemEnabled === null) {
            const handled = await this.handleFirstMessage(message);
            if (handled) {
              if (this.isShuttingDown) {
                break;
              }
              continue;
            }
          }

          if (isControlRequest(message)) {
            await this.handleControlRequest(message as CLIControlRequest);
          } else if (isControlResponse(message)) {
            this.handleControlResponse(message as CLIControlResponse);
          } else if (isControlCancel(message)) {
            this.handleControlCancel(message as ControlCancelRequest);
          } else if (isCLIUserMessage(message)) {
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

      while (this.processingPromise) {
        if (this.debugMode) {
          console.error('[Session] Waiting for final processing to complete');
        }
        try {
          await this.processingPromise;
        } catch (error) {
          if (this.debugMode) {
            console.error('[Session] Error in final processing:', error);
          }
        }
      }

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
