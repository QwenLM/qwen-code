/**
* @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Config,
  ToolCallRequestInfo,
  executeToolCall,
  ToolRegistry,
  shutdownTelemetry,
  isTelemetrySdkInitialized,
  GeminiEventType,
  ToolErrorType,
} from '@qwen-code/qwen-code-core';
import { Content, Part, FunctionCall } from '@google/genai';
import * as fs from 'fs/promises';
import * as path from 'path';

import { parseAndFormatApiError } from './ui/utils/errorParsing.js';
import { ConsolePatcher } from './ui/utils/ConsolePatcher.js';

async function loadCheckpoint(checkpointPath: string): Promise<{
  history?: Content[];
  clientHistory?: Content[];
  toolCall?: { name: string; args: any };
  commitHash?: string;
  filePath?: string;
} | null> {
  try {
    const data = await fs.readFile(checkpointPath, 'utf-8');
    const parsed = JSON.parse(data);
    
    // Check if it's a simple conversation history array (logger checkpoint format)
    if (Array.isArray(parsed)) {
      return {
        clientHistory: parsed as Content[]
      };
    }
    
    // Otherwise, it's the full checkpoint format
    return parsed;
  } catch (error) {
    console.error(`Failed to load checkpoint from ${checkpointPath}:`, error);
    return null;
  }
}

async function saveCheckpoint(checkpointPath: string, history: Content[]): Promise<boolean> {
  try {
    // Ensure the directory exists
    const dir = path.dirname(checkpointPath);
    await fs.mkdir(dir, { recursive: true });
    
    // Save the conversation history in logger checkpoint format
    await fs.writeFile(checkpointPath, JSON.stringify(history, null, 2), 'utf-8');
    return true;
  } catch (error) {
    console.error(`Failed to save checkpoint to ${checkpointPath}:`, error);
    return false;
  }
}

export async function runNonInteractive(
  config: Config,
  input: string,
  prompt_id: string,
): Promise<void> {
  const consolePatcher = new ConsolePatcher({
    stderr: true,
    debugMode: config.getDebugMode(),
  });

  const geminiClient = config.getGeminiClient();
  const toolRegistry: ToolRegistry = await config.getToolRegistry();

  const resume = config.getResume();
  
  if (resume) {
    // Check if resume is a checkpoint file name or path
    let checkpointPath: string;
    
    if (resume.includes('/') || resume.endsWith('.json')) {
      // If it's a path or includes .json, use it directly
      checkpointPath = resume;
    } else {
      // For tags, use the checkpoint-<tag>.json format
      checkpointPath = path.join(config.getProjectTempDir(), `checkpoint-${resume}.json`);
    }
    
    // Check if checkpoint file exists before trying to load it
    try {
      await fs.access(checkpointPath);
    } catch {
      console.error(`Error: Checkpoint '${resume}' not found at ${checkpointPath}`);
      process.exit(1);
    }
    
    const checkpoint = await loadCheckpoint(checkpointPath);
    
    if (checkpoint && checkpoint.clientHistory) {
      await geminiClient.setHistory(checkpoint.clientHistory);
      console.error(`Resumed from checkpoint: ${resume}`);
    } else {
      console.error(`Error: Invalid checkpoint file or no conversation history found`);
      process.exit(1);
    }
  }

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
    const toolRegistry: ToolRegistry = await config.getToolRegistry();

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
            toolRegistry,
            abortController.signal,
          );

          if (toolResponse.error) {
            console.error(
              `Error executing tool ${fc.name}: ${toolResponse.resultDisplay || toolResponse.error.message}`,
            );
            if (toolResponse.errorType === ToolErrorType.UNHANDLED_EXCEPTION)
              process.exit(1);
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
    process.exit(1);
  } finally {
    // Save checkpoint if requested
    const save = config.getSave();
    if (save) {
      let checkpointPath: string;
      
      if (save.includes('/') || save.endsWith('.json')) {
        // If it's a path or includes .json, use it directly
        checkpointPath = save;
      } else {
        // For tags, use the checkpoint-<tag>.json format
        checkpointPath = path.join(config.getProjectTempDir(), `checkpoint-${save}.json`);
      }
      
      const history = await geminiClient.getHistory();
      const success = await saveCheckpoint(checkpointPath, history);
      
      if (success) {
        console.error(`Saved checkpoint to: ${save}`);
      }
    }
    consolePatcher.cleanup();
    if (isTelemetrySdkInitialized()) {
      await shutdownTelemetry();
    }
  }
}
