/**
 * Factory function for creating Query instances.
 */

import type { SDKUserMessage } from '../types/protocol.js';
import { serializeJsonLine } from '../utils/jsonLines.js';
import { ProcessTransport } from '../transport/ProcessTransport.js';
import { prepareSpawnInfo, type SpawnInfo } from '../utils/cliPath.js';
import { Query } from './Query.js';
import type { QueryOptions } from '../types/types.js';
import { QueryOptionsSchema } from '../types/queryOptionsSchema.js';
import { SdkLogger } from '../utils/logger.js';
import { randomUUID } from 'node:crypto';
import { validateSessionId } from '../utils/validation.js';

export type { QueryOptions };

const logger = SdkLogger.createLogger('createQuery');

export function query({
  prompt,
  options = {},
}: {
  /**
   * The prompt to send to the Qwen Code CLI process.
   * - `string` for single-turn query,
   * - `AsyncIterable<SDKUserMessage>` for multi-turn query.
   *
   * The transport will remain open until the prompt is done.
   */
  prompt: string | AsyncIterable<SDKUserMessage>;
  /**
   * Configuration options for the query.
   */
  options?: QueryOptions;
}): Query {
  const spawnInfo = validateOptions(options);

  const isSingleTurn = typeof prompt === 'string';

  const pathToQwenExecutable = options.pathToQwenExecutable;

  const abortController = options.abortController ?? new AbortController();

  // Generate or use provided session ID for SDK-CLI alignment
  const sessionId = options.resume ?? options.sessionId ?? randomUUID();

  const transport = new ProcessTransport({
    pathToQwenExecutable,
    spawnInfo,
    cwd: options.cwd,
    model: options.model,
    permissionMode: options.permissionMode,
    env: options.env,
    abortController,
    debug: options.debug,
    stderr: options.stderr,
    logLevel: options.logLevel,
    maxSessionTurns: options.maxSessionTurns,
    coreTools: options.coreTools,
    excludeTools: options.excludeTools,
    allowedTools: options.allowedTools,
    authType: options.authType,
    includePartialMessages: options.includePartialMessages,
    resume: options.resume,
    sessionId,
  });

  const queryOptions: QueryOptions = {
    ...options,
    abortController,
    sessionId,
  };

  const queryInstance = new Query(transport, queryOptions, isSingleTurn);

  if (isSingleTurn) {
    const stringPrompt = prompt as string;
    const message: SDKUserMessage = {
      type: 'user',
      session_id: queryInstance.getSessionId(),
      message: {
        role: 'user',
        content: stringPrompt,
      },
      parent_tool_use_id: null,
    };

    (async () => {
      try {
        await queryInstance.initialized;
        // Skip writing if transport has already exited with an error
        if (transport.exitError) {
          return;
        }
        transport.write(serializeJsonLine(message));
      } catch (err) {
        // Only log error if it's not due to transport already being closed
        if (!transport.exitError) {
          logger.error('Error sending single-turn prompt:', err);
        }
      }
    })();
  } else {
    queryInstance
      .streamInput(prompt as AsyncIterable<SDKUserMessage>)
      .catch((err) => {
        logger.error('Error streaming input:', err);
      });
  }

  return queryInstance;
}

function validateOptions(options: QueryOptions): SpawnInfo | undefined {
  const validationResult = QueryOptionsSchema.safeParse(options);
  if (!validationResult.success) {
    const errors = validationResult.error.errors
      .map((err) => `${err.path.join('.')}: ${err.message}`)
      .join('; ');
    throw new Error(`Invalid QueryOptions: ${errors}`);
  }

  // Validate sessionId format if provided
  if (options.sessionId) {
    validateSessionId(options.sessionId, 'sessionId');
  }

  // Validate resume format if provided
  if (options.resume) {
    validateSessionId(options.resume, 'resume');
  }

  try {
    return prepareSpawnInfo(options.pathToQwenExecutable);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid pathToQwenExecutable: ${errorMessage}`);
  }
}
