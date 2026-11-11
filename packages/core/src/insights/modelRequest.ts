/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import type { Config } from '../config/config.js';
import { resolveBusinessIdentity } from '../core/agent-lifecycle-state.js';
import { MaxOutputTokensError } from '../core/max-output-tokens.js';
import type { SystemPrompt } from '../prompts/types.js';
import { systemPromptToText } from '../prompts/system-prompt.js';
import type { ModelStreamMessage } from '../provider/modelStreamRequest.js';
import { synchronizeSessionModelProvider } from '../provider/session-model.js';
import {
  applyBusinessSubTask,
  resolveBusinessSubTask,
} from '../qoder/business-info.js';
import { raceWithAbortSignal } from '../utils/abort-race.js';
import { extractJsonFromText } from '../utils/extractJson.js';
import { DEFAULT_MAX_ATTEMPTS, retryWithBackoff } from '../utils/retry.js';
import { SchemaValidator } from '../utils/schemaValidator.js';
import {
  getBusinessInfoFromContext,
  getCustomContextFromContext,
  getRequestSetIdFromContext,
  snapshotCustomContext,
} from '../utils/sessionIdContext.js';
import { SessionIdInvariantError } from '../utils/sessionIdInvariantError.js';
import { getVersion } from '../utils/version.js';

interface InsightRequest {
  sessionId: string;
  messages: readonly ModelStreamMessage[];
  systemPrompt: SystemPrompt;
  abortSignal: AbortSignal;
  promptId: string;
  schema?: Record<string, unknown>;
}

export function generateInsight(
  config: Config,
  options: InsightRequest & { schema: Record<string, unknown> },
): Promise<Record<string, unknown>>;
export function generateInsight(
  config: Config,
  options: InsightRequest,
): Promise<string>;
/** Shared request handling for session facets and report sections. */
export async function generateInsight(
  config: Config,
  options: InsightRequest,
): Promise<string | Record<string, unknown>> {
  const { sessionId, abortSignal, schema } = options;
  if (!sessionId.trim()) {
    throw new SessionIdInvariantError(
      'Insights model requests require a non-empty sessionId.',
    );
  }
  abortSignal.throwIfAborted();
  await synchronizeSessionModelProvider(config, abortSignal);
  const manager = config.getModelProviderManager();
  const resolution = await raceWithAbortSignal(
    manager.select({ purpose: 'insights' }),
    abortSignal,
  );
  abortSignal.throwIfAborted();
  const systemPrompt =
    systemPromptToText(options.systemPrompt) +
    (schema
      ? `\n\nReturn only a JSON object that conforms to this JSON Schema.\nDo not wrap the JSON in Markdown.\n${JSON.stringify(schema, null, 2)}`
      : '');
  const parent = getBusinessInfoFromContext();
  const subTask = resolveBusinessSubTask();
  const business = parent
    ? applyBusinessSubTask({ ...parent })
    : subTask
      ? {
          ...resolveBusinessIdentity(),
          version: await getVersion(),
          id: randomUUID(),
          model_key: config.getModel(),
          name: subTask,
          sub_task: subTask,
          begin_at: Date.now(),
          stage: 'init',
        }
      : undefined;
  const customContext = snapshotCustomContext(getCustomContextFromContext());
  const requestSetId = getRequestSetIdFromContext();
  let truncated = false;
  try {
    const text = await retryWithBackoff(
      async () => {
        abortSignal.throwIfAborted();
        truncated = false;
        const request = {
          resolution,
          prompt: { messages: [{ role: 'system' as const, content: systemPrompt }, ...options.messages] },
          control: { signal: abortSignal },
          qoder: {
            identity: { sessionId, requestSetId, requestId: randomUUID() },
            business,
            customContext,
          },
        };
        const response = await manager.inference(request);
        const message = await response.completed;
        abortSignal.throwIfAborted();
        if (!message.stopReason)
          throw new Error(`Incomplete insights response: ${options.promptId}.`);
        truncated = message.stopReason === 'max_tokens';
        return message.blocks
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('');
      },
      {
        maxAttempts: DEFAULT_MAX_ATTEMPTS,
        signal: abortSignal,
        // Client RetryValve owns transport errors; only retry invalid output.
        shouldRetryOnError: () => false,
        shouldRetryOnContent: (text) => {
          if (!text.trim()) return true;
          if (!schema) return false;
          try {
            const parsed: unknown = JSON.parse(extractJsonFromText(text));
            return (
              !parsed ||
              typeof parsed !== 'object' ||
              Array.isArray(parsed) ||
              SchemaValidator.validate(schema, parsed) !== null
            );
          } catch {
            return true;
          }
        },
      },
    );
    return schema
      ? (JSON.parse(extractJsonFromText(text)) as Record<string, unknown>)
      : text;
  } catch (error) {
    if (
      truncated &&
      error instanceof Error &&
      error.message === 'Retry attempts exhausted'
    ) {
      throw new MaxOutputTokensError({ cause: error });
    }
    throw error;
  }
}
