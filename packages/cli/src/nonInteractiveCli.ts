/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Config,
  ToolCallRequestInfo,
  executeToolCall,
  shutdownTelemetry,
  isTelemetrySdkInitialized,
  GeminiEventType,
  parseAndFormatApiError,
} from '@qwen-code/qwen-code-core';
import { Content, Part, FunctionCall } from '@google/genai';

import { ConsolePatcher } from './ui/utils/ConsolePatcher.js';
import {
  saveSession,
  loadSession,
  createNewSessionData,
} from './utils/sessionManager.js';

export async function runNonInteractive(
  config: Config,
  input: string,
  prompt_id: string,
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
    let currentMessages: Content[] = [
      { role: 'user', parts: [{ text: input }] },
    ];
    let turnCount = 0;
    while (true) {
      turnCount++;
      if (
        config.getMaxSessionTurns() >= 0 &&
        turnCount > config.getMaxSessionTurns()
      ) {
        console.error(
          '\n Reached max session turns for this session. Increase the number of turns by specifying maxSessionTurns in settings.json.',
        );
        return;
      }
      const functionCalls: FunctionCall[] = [];

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
        }
      }

      if (functionCalls.length > 0) {
        const toolResponseParts: Part[] = [];

        for (const fc of functionCalls) {
          const callId = fc.id ?? `${fc.name}-${Date.now()}`;
          const requestInfo: ToolCallRequestInfo = {
            callId,
            name: fc.name as string,
            args: (fc.args ?? {}) as Record<string, unknown>,
            isClientInitiated: false,
            prompt_id,
          };

          const toolResponse = await executeToolCall(
            config,
            requestInfo,
            abortController.signal,
          );

          if (toolResponse.error) {
            console.error(
              `Error executing tool ${fc.name}: ${toolResponse.resultDisplay || toolResponse.error.message}`,
            );
          }

          if (toolResponse.responseParts) {
            const parts = Array.isArray(toolResponse.responseParts)
              ? toolResponse.responseParts
              : [toolResponse.responseParts];
            for (const part of parts) {
              if (typeof part === 'string') {
                toolResponseParts.push({ text: part });
              } else if (part) {
                toolResponseParts.push(part);
              }
            }
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
  } finally {
    consolePatcher.cleanup();
    if (isTelemetrySdkInitialized()) {
      await shutdownTelemetry(config);
    }
  }
}