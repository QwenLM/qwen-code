/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '@qwen-code/qwen-code-core/config/config.js';
import {
  hasExplicitOutputLimit,
  tokenLimit,
} from '@qwen-code/qwen-code-core/core/tokenLimits.js';
import {
  MOD_MAX_BYTES,
  type ModModelCompleteInput,
  type ModModelCompleteResult,
  type ModModelUsage,
} from '@qwen-code/qwen-code-core/mods/types.js';
import {
  getGenAiUsageProvenance,
  outputTokenCount,
} from '@qwen-code/qwen-code-core/telemetry/gen-ai-usage.js';
import { getErrorStatus } from '@qwen-code/qwen-code-core/utils/errors.js';
import {
  buildModelIdContext,
  resolveModelId,
} from '@qwen-code/qwen-code-core/utils/modelId.js';
import {
  isQuotaExhaustedError,
  isQwenQuotaExceededError,
} from '@qwen-code/qwen-code-core/utils/quotaErrorDetection.js';
import type { GenerateContentResponseUsageMetadata } from '@google/genai';
import { classifyApiError } from '../utils/classify-api-error.js';
import { projectJsonStringToByteBudget } from '../utils/json-string-byte-projection.js';

/** Claude Code's default reply cap for `$.model.complete`. */
export const MOD_MODEL_DEFAULT_MAX_TOKENS = 1024;

// Claude Code's model aliases, read as Qwen Code's selectors: the small model
// is the fast model, the others the session's own.
const ALIASES = new Map([
  ['haiku', 'fast'],
  ['sonnet', 'inherit'],
  ['opus', 'inherit'],
]);

const NO_USAGE: ModModelUsage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

/**
 * The model a Mod named, as a selector `BaseLlmClient` routes: an alias, a
 * configured model id, or `authType:id`. Any other id is refused, since the
 * client would otherwise send the request to the session's model.
 */
export function resolveModModel(
  config: Config,
  name: string,
): { selector: string; modelId: string; authType?: string } {
  const context = buildModelIdContext(config);
  const modelName = name.trim();
  const wanted = ALIASES.get(modelName) ?? modelName;
  const target = wanted === 'fast' ? (context.fastModel ?? 'inherit') : wanted;
  const [modelSelector, endpoint, extra] = target.split('\0');
  if (!modelSelector?.trim() || endpoint === '' || extra !== undefined) {
    throw new Error(`invalid model endpoint selector ${JSON.stringify(name)}`);
  }
  const resolved = resolveModelId(modelSelector, context);
  if (!resolved)
    throw new Error(`model ${JSON.stringify(name)} is not available`);
  const isSession =
    resolved.modelId === context.currentModel &&
    (!resolved.authType || resolved.authType === context.currentAuthType) &&
    (endpoint === undefined ||
      endpoint === config.getContentGeneratorConfig()?.baseUrl);
  const configured = config
    .getAllConfiguredModels(resolved.authType ? [resolved.authType] : undefined)
    .some(
      (model) =>
        model.id === resolved.modelId &&
        (endpoint === undefined || model.baseUrl === endpoint) &&
        !model.voiceOnly &&
        !model.imageOnly &&
        !model.visionOnly,
    );
  if (!isSession && !configured)
    throw new Error(`model ${JSON.stringify(name)} is not configured`);
  // BaseLlmClient parses the selector again, so preserve the provider and
  // endpoint to keep literal names like `inherit` from becoming aliases.
  const selector = resolved.authType
    ? `${resolved.authType}:${resolved.modelId}`
    : resolved.modelId;
  return {
    selector: endpoint === undefined ? selector : `${selector}\0${endpoint}`,
    modelId: resolved.modelId,
    ...(resolved.authType && { authType: resolved.authType }),
  };
}

function tokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;
}

/**
 * A response's cost as the API's four counts. Cache writes are known only
 * where the provider reports them apart, as Anthropic's does.
 */
export function modModelUsage(
  metadata: GenerateContentResponseUsageMetadata | undefined,
  authType: string | undefined,
): ModModelUsage {
  if (!metadata) return { ...NO_USAGE };
  const prompt = tokenCount(metadata.promptTokenCount);
  const read = tokenCount(metadata.cachedContentTokenCount);
  const written = tokenCount(
    getGenAiUsageProvenance(metadata)?.cacheCreationInputTokens,
  );
  return {
    input_tokens: Math.max(0, prompt - read - written),
    // Counted as the session's billable output counts it.
    output_tokens: outputTokenCount(
      {
        input: prompt,
        output: tokenCount(metadata.candidatesTokenCount),
        thoughts: tokenCount(metadata.thoughtsTokenCount),
        total: tokenCount(metadata.totalTokenCount),
      },
      authType,
    ),
    cache_read_input_tokens: read,
    cache_creation_input_tokens: written,
  };
}

// Claude Code's error kinds the shared classifier does not name.
function apiErrorKind(error: unknown, status: number | undefined): string {
  const message = error instanceof Error ? error.message : String(error);
  if (status === 529 || /overloaded/i.test(message)) return 'overloaded';
  if (status === 404 || /model[^.]*not (found|exist)/i.test(message))
    return 'model_not_found';
  if (isQuotaExhaustedError(error) || isQwenQuotaExceededError(error))
    return 'billing_error';
  const kind = classifyApiError({ message, status });
  return kind === 'loop_detected' ? 'unknown' : kind;
}

/**
 * Runs one `$.model.complete` request on the session's client: no tools, no
 * history, and no system prompt but the request's own. It rejects only a
 * request it will not send (a model that is not configured, a cap over the
 * model's output limit); what the provider did is the result.
 */
export async function completeModModel(
  config: Config,
  input: ModModelCompleteInput,
  signal: AbortSignal,
): Promise<ModModelCompleteResult> {
  if (signal.aborted)
    return { isAnswered: false, reason: 'aborted', usage: { ...NO_USAGE } };
  const model = resolveModModel(config, input.model);
  const maxTokens = input.maxTokens ?? MOD_MODEL_DEFAULT_MAX_TOKENS;
  if (
    input.maxTokens !== undefined &&
    hasExplicitOutputLimit(model.modelId) &&
    maxTokens > tokenLimit(model.modelId, 'output')
  )
    throw new Error(
      `maxTokens ${maxTokens} is over ${model.modelId}'s output limit of ${tokenLimit(model.modelId, 'output')}`,
    );
  const abortSignal =
    input.timeoutMs === undefined
      ? signal
      : AbortSignal.any([signal, AbortSignal.timeout(input.timeoutMs)]);
  let onAbort: (() => void) | undefined;
  try {
    const request = Promise.resolve().then(() =>
      config.getBaseLlmClient().generateText({
        contents: [{ role: 'user', parts: [{ text: input.prompt }] }],
        model: model.selector,
        ...(typeof input.system === 'string' &&
          input.system && { systemInstruction: input.system }),
        abortSignal,
        promptId: 'side-query:mod-model-complete',
        config: {
          maxOutputTokens: Math.min(
            maxTokens,
            hasExplicitOutputLimit(model.modelId)
              ? tokenLimit(model.modelId, 'output')
              : maxTokens,
          ),
          // Reasoning stays off, as on every side query, unless the Mod asks
          // for an effort; the level itself is not sent yet.
          thinkingConfig: { includeThoughts: input.effort !== undefined },
        },
        isolatedRequest: true,
      }),
    );
    // Generator setup can be waiting on a shared credential refresh.
    const cancelled = new Promise<never>((_, reject) => {
      onAbort = () => reject(abortSignal.reason);
      abortSignal.addEventListener('abort', onAbort, { once: true });
    });
    const result = await Promise.race([request, cancelled]);
    const usage = modModelUsage(
      result.usage,
      model.authType ?? config.getContentGeneratorConfig()?.authType,
    );
    if (!result.text)
      return { isAnswered: false, reason: 'empty-reply', usage };
    // A reply too long for a Mod payload keeps its head and tail.
    const text = projectJsonStringToByteBudget(
      result.text,
      MOD_MAX_BYTES / 2,
      '\n[... truncated for Mods ...]\n',
    );
    return { isAnswered: true, text, usage };
  } catch (error) {
    if (abortSignal.aborted)
      return { isAnswered: false, reason: 'aborted', usage: { ...NO_USAGE } };
    const providerError =
      error instanceof Error ? (error.cause ?? error) : error;
    let cause = providerError;
    let status = getErrorStatus(cause);
    for (
      let depth = 0;
      depth < 4 &&
      status === undefined &&
      cause instanceof Error &&
      cause.cause !== undefined;
      depth++
    ) {
      cause = cause.cause;
      status = getErrorStatus(cause);
    }
    const providerStatus = status ?? getErrorStatus(error);
    return {
      isAnswered: false,
      reason: 'api-error',
      status: providerStatus ?? null,
      error: apiErrorKind(
        status === undefined ? providerError : cause,
        providerStatus,
      ),
      usage: { ...NO_USAGE },
    };
  } finally {
    if (onAbort) abortSignal.removeEventListener('abort', onAbort);
  }
}
