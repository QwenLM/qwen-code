/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config, ToolCallRequestInfo } from '@qwen-code/qwen-code-core';
import {
  executeToolCall,
  shutdownTelemetry,
  isTelemetrySdkInitialized,
  GeminiEventType,
  parseAndFormatApiError,
  FatalInputError,
  FatalTurnLimitedError,
} from '@qwen-code/qwen-code-core';
import type { Content, Part } from '@google/genai';

import { ConsolePatcher } from './ui/utils/ConsolePatcher.js';
import {
  saveSession,
  loadSession,
  createNewSessionData,
} from './utils/sessionManager.js';
import { handleAtCommand } from './ui/hooks/atCommandProcessor.js';

export async function runNonInteractive(
  config: Config,
  input: string,
  prompt_id: string,
  verbose: boolean = false,
  verboseToStdout: boolean = false,
): Promise<void> {
  const consolePatcher = new ConsolePatcher({
    stderr: true,
    debugMode: config.getDebugMode(),
  });

  try {
    consolePatcher.patch();
    // Handle EPIPE errors when the output is piped to a command that closes early.
    process.stdout.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EPIPE') {
        // Exit gracefully if the pipe is closed.
        process.exit(0);
      }
    });

    const geminiClient = config.getGeminiClient();
    const sessionId = config.getSessionId();
    const projectRoot = config.getProjectRoot();

    // Load existing session or create new one
    let sessionData = await loadSession(sessionId);
    if (!sessionData) {
      sessionData = createNewSessionData(sessionId, projectRoot);
      if (config.getDebugMode()) {
        console.error(`Created new session: ${sessionId}`);
      }
    } else {
      if (config.getDebugMode()) {
        console.error(`Loaded existing session: ${sessionId} with ${sessionData.history.length} messages`);
      }
      // Restore conversation history to gemini client
      if (sessionData.history.length > 0) {
        geminiClient.setHistory(sessionData.history);
      }
    }

    const abortController = new AbortController();

    const { processedQuery, shouldProceed } = await handleAtCommand({
      query: input,
      config,
      addItem: (_item, _timestamp) => 0,
      onDebugMessage: () => {},
      messageId: Date.now(),
      signal: abortController.signal,
    });

    if (!shouldProceed || !processedQuery) {
      // An error occurred during @include processing (e.g., file not found).
      // The error message is already logged by handleAtCommand.
      throw new FatalInputError(
        'Exiting due to an error processing the @ command.',
      );
    }

    let currentMessages: Content[] = [
      { role: 'user', parts: processedQuery as Part[] },
    ];

    let turnCount = 0;
    while (true) {
      turnCount++;
      if (
        config.getMaxSessionTurns() >= 0 &&
        turnCount > config.getMaxSessionTurns()
      ) {
        throw new FatalTurnLimitedError(
          'Reached max session turns for this session. Increase the number of turns by specifying maxSessionTurns in settings.json.',
        );
      }
      const toolCallRequests: ToolCallRequestInfo[] = [];

      const responseStream = geminiClient.sendMessageStream(
        currentMessages[0]?.parts || [],
        abortController.signal,
        prompt_id,
      );

      for await (const event of responseStream) {
        if (abortController.signal.aborted) {
          console.error('Operation cancelled.');
          return;
        }

        if (event.type === GeminiEventType.Content) {
          process.stdout.write(event.value);
        } else if (event.type === GeminiEventType.ToolCallRequest) {
          const toolCallRequest = event.value;
          const fc: FunctionCall = {
            name: toolCallRequest.name,
            args: toolCallRequest.args,
            id: toolCallRequest.callId,
          };
          functionCalls.push(fc);

          // In verbose mode, show the function call
          if (verbose) {
            const output = verboseToStdout ? process.stdout : process.stderr;
            output.write(`\n[FUNCTION CALL] ${fc.name}\n`);
            output.write(`[ARGS] ${JSON.stringify(fc.args, null, 2)}\n`);
          }
          toolCallRequests.push(event.value);
        }
      }

      if (toolCallRequests.length > 0) {
        const toolResponseParts: Part[] = [];
        for (const requestInfo of toolCallRequests) {
          const toolResponse = await executeToolCall(
            config,
            requestInfo,
            abortController.signal,
          );

          if (toolResponse.error) {
            console.error(
              `Error executing tool ${requestInfo.name}: ${toolResponse.resultDisplay || toolResponse.error.message}`,
            );
          }

          // In verbose mode, show the function response
          if (verbose) {
            const output = verboseToStdout ? process.stdout : process.stderr;
            output.write(`\n[FUNCTION RESPONSE] ${fc.name}\n`);
            if (toolResponse.resultDisplay) {
              output.write(`[RESULT] ${toolResponse.resultDisplay}\n`);
            }
            if (toolResponse.responseParts) {
              output.write(`[RESPONSE PARTS] ${JSON.stringify(toolResponse.responseParts, null, 2)}\n`);
            }
          }

          if (toolResponse.responseParts) {
            toolResponseParts.push(...toolResponse.responseParts);
          }
        }
        currentMessages = [{ role: 'user', parts: toolResponseParts }];
      } else {
        process.stdout.write('\n'); // Ensure a final newline
        
        // Save session data before returning
        try {
          // Update session history with the current conversation
          sessionData.history = geminiClient.getHistory();
          await saveSession(sessionData);
          if (config.getDebugMode()) {
            console.error(`Session saved: ${sessionId}`);
          }
        } catch (error) {
          if (config.getDebugMode()) {
            console.error(`Failed to save session: ${error}`);
          }
        }
        
        return;
      }
    }
  } catch (error) {
    console.error(
      parseAndFormatApiError(
        error,
        config.getContentGeneratorConfig()?.authType,
      ),
    );
    
    // Try to save session even if there was an error
    try {
      const sessionId = config.getSessionId();
      let sessionData = await loadSession(sessionId);
      if (sessionData) {
        sessionData.history = config.getGeminiClient().getHistory();
        await saveSession(sessionData);
      }
    } catch (saveError) {
      // Ignore save errors in error path
    }
    
    process.exit(1);
    throw error;
  } finally {
    consolePatcher.cleanup();
    if (isTelemetrySdkInitialized()) {
      await shutdownTelemetry(config);
    }
  }
}