/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  Content,
  GenerateContentConfig,
  GenerateContentResponseUsageMetadata,
  Part,
  EmbedContentParameters,
  FunctionDeclaration,
  Tool,
  Schema,
} from '@google/genai';
import { FunctionCallingConfigMode } from './genai-compat.js';
import type { Config } from '../config/config.js';
import type {
  ContentGenerator,
  ContentGeneratorConfig,
} from './contentGenerator.js';
import { AuthType, createContentGenerator } from './contentGenerator.js';
import type { ResolvedModelConfig } from '../models/types.js';
import { buildAgentContentGeneratorConfig } from '../models/content-generator-config.js';
import {
  buildModelIdContext,
  resolveModelId,
  type ResolvedModelId,
} from '../utils/modelId.js';
import { reportError } from '../utils/errorReporting.js';
import { getErrorMessage } from '../utils/errors.js';
import { retryWithBackoff, isUnattendedMode } from '../utils/retry.js';
import { subagentNameContext } from '../utils/subagentNameContext.js';
import { ApiRetryEvent } from '../telemetry/types.js';
import { logApiRetry } from '../telemetry/loggers.js';
import { getFunctionCalls } from '../utils/generateContentResponseUtilities.js';
import { getResponseText } from '../utils/partUtils.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import type { RuntimeContentGeneratorView } from '../agents/runtime/agent-context.js';
import { slimCompactionInput } from '../services/compactionInputSlimming.js';

const DEFAULT_MAX_ATTEMPTS = 7;

const debugLogger = createDebugLogger('BASE_LLM_CLIENT');

function splitModelBaseUrl(model: string): { model: string; baseUrl?: string } {
  const idx = model.indexOf('\0');
  if (idx < 0) return { model };
  const modelPart = model.slice(0, idx);
  if (!modelPart) return { model: modelPart };
  return {
    model: modelPart,
    baseUrl: model.slice(idx + 1) || undefined,
  };
}

/**
 * The pair of generator and retry-authType to use for a request targeting
 * a specific model. When the requested model differs from the main session
 * model, both fields are resolved against that model's provider so that
 * per-model `extra_body` / `samplingParams` / reasoning settings — and
 * provider-specific retry/quota behaviour — do not leak from the main
 * session.
 */
export interface ResolvedGeneratorForModel {
  contentGenerator: ContentGenerator;
  contentGeneratorConfig: ContentGeneratorConfig;
  retryAuthType: string | undefined;
  retryErrorCodes?: readonly number[];
  model: string;
}

/**
 * Options for the generateText utility function.
 */
export interface GenerateTextOptions {
  /** The input prompt or history. */
  contents: Content[];
  /** The specific model to use for this task. */
  model: string;
  /**
   * Task-specific system instructions. Passed through to the underlying
   * content generator without the geminiClient main-prompt fallback or
   * user-memory wrapping that `getCustomSystemPrompt` applies.
   */
  systemInstruction?: string | Part | Part[] | Content;
  /**
   * Overrides for generation configuration (e.g., temperature, thinkingConfig).
   */
  config?: Omit<
    GenerateContentConfig,
    'systemInstruction' | 'tools' | 'abortSignal'
  >;
  /** Signal for cancellation. */
  abortSignal: AbortSignal;
  /**
   * A unique ID for the prompt, used for logging/telemetry correlation.
   */
  promptId?: string;
  /**
   * The maximum number of attempts for the request.
   */
  maxAttempts?: number;
  /**
   * Stream the response instead of awaiting the whole non-streaming body.
   * Defaults to `false` (unchanged non-streaming behavior). Opt in to keep the
   * HTTP connection alive against BFF gateways whose `proxy_read_timeout` would
   * otherwise kill a slow inference before the first byte arrives. The streamed
   * deltas are collected into the same `{ text, usage }` result.
   */
  stream?: boolean;
  /**
   * When true, throw instead of silently falling back to the main generator if
   * a distinct generator for `model` can't be created (model not registered, or
   * generator creation fails — e.g. a missing cross-provider credential). The
   * vision bridge sets this so image payloads are never routed at the text-only
   * primary while a notice names a different vision endpoint; it fails the
   * conversion closed instead.
   */
  failClosed?: boolean;
}

/**
 * Result of a generateText call.
 */
export interface GenerateTextResult {
  text: string;
  usage: GenerateContentResponseUsageMetadata | undefined;
}

/**
 * Best-effort JSON-object extraction from a model's text response. Used as a
 * fallback when the model emits plain-text JSON instead of calling the
 * registered tool. Strips a leading ```json / ``` fence, then takes the
 * substring from the first `{` to the matching last `}` and JSON-parses it.
 * Returns the parsed object on success, or `null` if nothing usable is found.
 */
function parseLooseJsonObject(text: string): Record<string, unknown> | null {
  let s = text.trim();
  if (s.startsWith('```')) {
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  }
  const firstStructuredChar = s.search(/[[{]/);
  if (firstStructuredChar !== -1 && s[firstStructuredChar] === '[') {
    return null;
  }
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first === -1 || last === -1 || last <= first) return null;
  try {
    const parsed = JSON.parse(s.slice(first, last + 1));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Options for the generateJson utility function.
 */
export interface GenerateJsonOptions {
  /** The input prompt or history. */
  contents: Content[];
  /** The required JSON schema for the output. */
  schema: Record<string, unknown>;
  /** The specific model to use for this task. */
  model: string;
  /**
   * Task-specific system instructions.
   * If omitted, no system instruction is sent.
   */
  systemInstruction?: string | Part | Part[] | Content;
  /**
   * Overrides for generation configuration (e.g., temperature).
   */
  config?: Omit<
    GenerateContentConfig,
    | 'systemInstruction'
    | 'responseJsonSchema'
    | 'responseMimeType'
    | 'tools'
    | 'abortSignal'
  >;
  /** Signal for cancellation. */
  abortSignal: AbortSignal;
  /**
   * A unique ID for the prompt, used for logging/telemetry correlation.
   */
  promptId?: string;
  /**
   * The maximum number of attempts for the request.
   */
  maxAttempts?: number;
}

/**
 * A client dedicated to stateless, utility-focused LLM calls.
 */
export class BaseLlmClient {
  /**
   * Cache of per-model ContentGenerators keyed by model ID. Avoids rebuilding
   * the generator (SDK instantiation, config resolution) on every side query.
   * Cleared via {@link clearPerModelGeneratorCache} when the session resets.
   */
  private readonly perModelGeneratorCache = new Map<
    string,
    Promise<RuntimeContentGeneratorView>
  >();

  constructor(
    private readonly contentGenerator: ContentGenerator,
    private readonly config: Config,
  ) {}

  private getCurrentContentGenerator(): ContentGenerator {
    return this.config.getContentGenerator?.() ?? this.contentGenerator;
  }

  async generateJson(
    options: GenerateJsonOptions,
  ): Promise<Record<string, unknown>> {
    const {
      contents,
      schema,
      model,
      abortSignal,
      systemInstruction,
      promptId,
      maxAttempts,
    } = options;

    const requestConfig: GenerateContentConfig = {
      abortSignal,
      ...options.config,
      ...(systemInstruction && { systemInstruction }),
    };

    // Convert schema to function declaration
    const functionDeclaration: FunctionDeclaration = {
      name: 'respond_in_schema',
      description: 'Provide the response in provided schema',
      parameters: schema as Schema,
    };

    const tools: Tool[] = [
      {
        functionDeclarations: [functionDeclaration],
      },
    ];

    const {
      contentGenerator,
      contentGeneratorConfig,
      retryAuthType,
      retryErrorCodes,
      model: requestModel,
    } = await this.resolveForModel(model);
    const requestContents = slimCompactionInput(
      contents,
      contentGeneratorConfig.modalities,
    ).slimmedHistory;

    try {
      const apiCall = () =>
        contentGenerator.generateContent(
          {
            model: requestModel,
            config: {
              ...requestConfig,
              tools,
              // Force the model to call the respond_in_schema tool rather
              // than free-texting. Without this, Anthropic-native and
              // some OpenAI-compat providers default to tool_choice=auto
              // and may skip the tool call entirely — especially
              // adaptive-thinking models that consume the tiny output
              // budget on thinking before producing any tool_use.
              toolConfig: {
                functionCallingConfig: { mode: FunctionCallingConfigMode.ANY },
              },
            },
            contents: requestContents,
          },
          promptId ?? '',
        );

      const result = await retryWithBackoff(apiCall, {
        maxAttempts: maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
        authType: retryAuthType,
        extraRetryErrorCodes: retryErrorCodes,
        persistentMode: isUnattendedMode(),
        signal: abortSignal,
        heartbeatFn: (info) => {
          process.stderr.write(
            `[qwen-code] Waiting for API capacity... attempt ${info.attempt}, retry in ${Math.ceil(info.remainingMs / 1000)}s\n`,
          );
        },
        onRetry: (info) => {
          logApiRetry(
            this.config,
            new ApiRetryEvent({
              model: requestModel,
              promptId,
              attemptNumber: info.attempt,
              error: info.error,
              statusCode: info.errorStatus,
              retryDelayMs: info.delayMs,
              subagentName: subagentNameContext.getStore(),
            }),
          );
        },
      });

      const functionCalls = getFunctionCalls(result);
      if (functionCalls && functionCalls.length > 0) {
        const functionCall = functionCalls.find(
          (call) => call.name === 'respond_in_schema',
        );
        if (functionCall && functionCall.args) {
          return functionCall.args as Record<string, unknown>;
        }
      }

      const text = getResponseText(result);
      if (text) {
        const parsed = parseLooseJsonObject(text);
        if (parsed) return parsed;
      }
      return {};
    } catch (error) {
      if (abortSignal.aborted) {
        throw error;
      }

      // Avoid double reporting for the empty response case handled above
      if (
        error instanceof Error &&
        error.message === 'API returned an empty response for generateJson.'
      ) {
        throw error;
      }

      await reportError(
        error,
        'Error generating JSON content via API.',
        contents,
        'generateJson-api',
      );
      throw new Error(
        `Failed to generate JSON content${promptId ? ` (${promptId})` : ''}: ${getErrorMessage(error)}`,
        { cause: error },
      );
    }
  }

  /**
   * Free-form text generation primitive used by `runSideQuery` text mode.
   *
   * Distinct from `GeminiClient.generateContent`: this calls the underlying
   * `ContentGenerator` directly, so the caller's `systemInstruction` is sent
   * through verbatim — no `getCustomSystemPrompt` wrapping (which would append
   * user memory) and no main-session-prompt fallback when omitted. Side queries
   * need that contract; the main turn does not.
   */
  async generateText(
    options: GenerateTextOptions,
  ): Promise<GenerateTextResult> {
    const {
      contents,
      model,
      abortSignal,
      systemInstruction,
      promptId,
      maxAttempts,
      stream,
    } = options;

    const requestConfig: GenerateContentConfig = {
      abortSignal,
      ...options.config,
      ...(systemInstruction && { systemInstruction }),
    };

    const {
      contentGenerator,
      contentGeneratorConfig,
      retryAuthType,
      retryErrorCodes,
      model: requestModel,
    } = await this.resolveForModel(model, { failClosed: options.failClosed });
    const requestContents = slimCompactionInput(
      contents,
      contentGeneratorConfig.modalities,
    ).slimmedHistory;

    try {
      const request = {
        model: requestModel,
        config: requestConfig,
        contents: requestContents,
      };

      // Both branches resolve to the same `{ text, usage }` shape so a single
      // retryWithBackoff governs the whole request (a mid-stream failure retries
      // the entire call — side queries are idempotent). Streaming keeps the HTTP
      // connection alive so a slow inference can't be killed by a gateway's
      // `proxy_read_timeout`; non-streaming is the unchanged default.
      const apiCall: () => Promise<GenerateTextResult> = stream
        ? async () => {
            const responseStream = await contentGenerator.generateContentStream(
              request,
              promptId ?? '',
            );
            // Chunks are deltas, not cumulative snapshots, so concatenate.
            // getResponseText already drops thought parts; usageMetadata rides
            // the final chunk (last one wins), matching the non-streaming read.
            let text = '';
            let usage: GenerateContentResponseUsageMetadata | undefined;
            for await (const chunk of responseStream) {
              text += getResponseText(chunk) ?? '';
              if (chunk.usageMetadata) {
                usage = chunk.usageMetadata;
              }
            }
            return { text, usage };
          }
        : async () => {
            const result = await contentGenerator.generateContent(
              request,
              promptId ?? '',
            );
            return {
              text: getResponseText(result) ?? '',
              usage: result.usageMetadata,
            };
          };

      const result = await retryWithBackoff(apiCall, {
        maxAttempts: maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
        authType: retryAuthType,
        extraRetryErrorCodes: retryErrorCodes,
        persistentMode: isUnattendedMode(),
        signal: abortSignal,
        heartbeatFn: (info) => {
          process.stderr.write(
            `[qwen-code] Waiting for API capacity... attempt ${info.attempt}, retry in ${Math.ceil(info.remainingMs / 1000)}s\n`,
          );
        },
        onRetry: (info) => {
          logApiRetry(
            this.config,
            new ApiRetryEvent({
              model: requestModel,
              promptId,
              attemptNumber: info.attempt,
              error: info.error,
              statusCode: info.errorStatus,
              retryDelayMs: info.delayMs,
              subagentName: subagentNameContext.getStore(),
            }),
          );
        },
      });

      return {
        text: result.text.trim(),
        usage: result.usage,
      };
    } catch (error) {
      if (abortSignal.aborted) {
        throw error;
      }

      await reportError(
        error,
        // Mark streaming failures so an oncall can tell a mid-stream error
        // apart from the original non-streaming gateway timeout (#5861).
        `Error generating text content via API${stream ? ' [streaming]' : ''}.`,
        contents,
        'generateText-api',
      );
      throw new Error(
        `Failed to generate text content${promptId ? ` (${promptId})` : ''}: ${getErrorMessage(error)}`,
        { cause: error },
      );
    }
  }

  async generateEmbedding(texts: string[]): Promise<number[][]> {
    if (!texts || texts.length === 0) {
      return [];
    }
    const embedModelParams: EmbedContentParameters = {
      model: this.config.getEmbeddingModel(),
      contents: texts,
    };

    const embedContentResponse =
      await this.contentGenerator.embedContent(embedModelParams);
    if (
      !embedContentResponse.embeddings ||
      embedContentResponse.embeddings.length === 0
    ) {
      throw new Error('No embeddings found in API response.');
    }

    if (embedContentResponse.embeddings.length !== texts.length) {
      throw new Error(
        `API returned a mismatched number of embeddings. Expected ${texts.length}, got ${embedContentResponse.embeddings.length}.`,
      );
    }

    return embedContentResponse.embeddings.map((embedding, index) => {
      const values = embedding.values;
      if (!values || values.length === 0) {
        throw new Error(
          `API returned an empty embedding for input text at index ${index}: "${texts[index]}"`,
        );
      }
      return values;
    });
  }

  /**
   * Resolve the ContentGenerator and retry authType for a request targeting
   * a specific model.
   *
   * When the requested model matches the main session model, returns the
   * constructor-injected generator and the main session's authType. When it
   * differs (e.g. a fast model on a different provider), constructs and caches
   * a per-model generator with that provider's auth, baseUrl, sampling, and
   * extra_body settings — and reports the target provider as the retry
   * authType so quota detection and provider-specific retry logic line up.
   *
   * Falls back to the main generator when the target model is not registered
   * or generator creation fails (e.g. tests without full auth setup).
   */
  async resolveForModel(
    model: string,
    opts?: { failClosed?: boolean },
  ): Promise<ResolvedGeneratorForModel> {
    const requested = splitModelBaseUrl(model);
    const selector = this.resolveModelSelector(requested.model);
    const requestModel =
      selector?.modelId ?? this.config.getModel() ?? requested.model;
    const mainModel = this.config.getModel() ?? requested.model;
    const mainGeneratorConfig = this.config.getContentGeneratorConfig();
    const mainAuthType = mainGeneratorConfig?.authType;
    const mainBaseUrl = mainGeneratorConfig?.baseUrl;
    const mainRetryErrorCodes = mainGeneratorConfig?.retryErrorCodes;
    const matchesMainBaseUrl =
      requested.baseUrl === undefined || requested.baseUrl === mainBaseUrl;

    if (
      requestModel === mainModel &&
      (!selector?.authType || selector.authType === mainAuthType) &&
      matchesMainBaseUrl
    ) {
      return {
        contentGenerator: this.getCurrentContentGenerator(),
        contentGeneratorConfig: mainGeneratorConfig,
        retryAuthType: mainAuthType,
        retryErrorCodes: mainRetryErrorCodes,
        model: requestModel,
      };
    }

    const { contentGenerator, contentGeneratorConfig } =
      await this.createRuntimeViewForModel(
        requested.model,
        selector,
        opts?.failClosed ?? false,
        requested.baseUrl,
      );
    const resolvedModel = this.resolveModelAcrossAuthTypes(
      requested.model,
      selector,
      requested.baseUrl,
    );
    const retryAuthType =
      resolvedModel?.authType ?? mainAuthType ?? AuthType.USE_OPENAI;
    const retryErrorCodes =
      resolvedModel?.generationConfig?.retryErrorCodes ?? mainRetryErrorCodes;

    return {
      contentGenerator,
      contentGeneratorConfig,
      retryAuthType,
      retryErrorCodes,
      model: resolvedModel?.id ?? requestModel,
    };
  }

  /**
   * Drop cached per-model ContentGenerators. Called on session reset so that
   * the next side query picks up updated provider settings.
   */
  clearPerModelGeneratorCache(): void {
    this.perModelGeneratorCache.clear();
  }

  /**
   * Resolve a model across all authTypes. Handles the case where the target
   * model is registered under a different authType than the main model
   * (e.g. main=QWEN_OAUTH, fast=USE_ANTHROPIC).
   */
  private resolveModelAcrossAuthTypes(
    model: string,
    selector: ResolvedModelId | undefined,
    modelBaseUrl?: string,
  ): ResolvedModelConfig | undefined {
    const modelsConfig = this.config.getModelsConfig?.();
    if (!modelsConfig) return undefined;
    if (!selector) return undefined;
    const modelId = selector.modelId;
    const getResolvedModel = (authType: AuthType) =>
      modelBaseUrl === undefined
        ? modelsConfig.getResolvedModel(authType, modelId)
        : modelsConfig.getResolvedModel(authType, modelId, modelBaseUrl);

    if (selector.authType) {
      return getResolvedModel(selector.authType);
    }

    const allAuthTypes: AuthType[] = [
      AuthType.QWEN_OAUTH,
      AuthType.USE_OPENAI,
      AuthType.USE_VERTEX_AI,
      AuthType.USE_ANTHROPIC,
      AuthType.USE_GEMINI,
    ];

    const mainAuthType = this.config.getContentGeneratorConfig()?.authType;
    if (mainAuthType) {
      const resolved = getResolvedModel(mainAuthType);
      if (resolved) return resolved;
    }

    for (const authType of allAuthTypes) {
      if (authType === mainAuthType) continue;
      const resolved = getResolvedModel(authType);
      if (resolved) return resolved;
    }

    return undefined;
  }

  private async createRuntimeViewForModel(
    model: string,
    selector: ResolvedModelId | undefined,
    failClosed = false,
    modelBaseUrl?: string,
  ): Promise<RuntimeContentGeneratorView> {
    const routeKey = selector
      ? modelBaseUrl === undefined
        ? `${selector.authType ?? ''}:${selector.modelId}`
        : `${selector.authType ?? ''}:${selector.modelId}\0${modelBaseUrl}`
      : model;
    const cacheKey = routeKey;
    const cached = this.perModelGeneratorCache.get(cacheKey);
    const normalizeGeneratorError = (err: unknown) =>
      err instanceof Error
        ? err
        : new Error(
            `Failed to create content generator for model "${model}": ${String(err)}`,
          );
    const fallbackAfterGeneratorError = (
      err: unknown,
    ): RuntimeContentGeneratorView => {
      if (failClosed) throw normalizeGeneratorError(err);
      debugLogger.warn(
        `Failed to create content generator for model "${model}", falling back to main generator.`,
        err instanceof Error ? err.message : String(err),
      );
      return {
        contentGenerator: this.getCurrentContentGenerator(),
        contentGeneratorConfig: this.config.getContentGeneratorConfig(),
      };
    };
    if (cached) return cached.catch(fallbackAfterGeneratorError);

    const resolvedModel = this.resolveModelAcrossAuthTypes(
      model,
      selector,
      modelBaseUrl,
    );

    if (!resolvedModel) {
      // failClosed callers (vision bridge) must NOT silently run on the main
      // generator — that would send image payloads to the text-only primary.
      if (failClosed) {
        const baseUrlMessage =
          modelBaseUrl === undefined ? '' : ` at baseUrl "${modelBaseUrl}"`;
        throw new Error(
          `Model "${model}"${baseUrlMessage} is not registered across any auth type; ` +
            `refusing to fall back to the main generator.`,
        );
      }
      debugLogger.warn(
        `Model "${model}" not found in registry across all authTypes, falling back to main generator.`,
      );
      // Do not cache the fallback: getCurrentContentGenerator() reads the
      // runtime view from AsyncLocalStorage, which can differ between calls
      // (e.g. inside a subagent vs. on the main session). Caching here would
      // pin the first-call view's generator under this selector key.
      return {
        contentGenerator: this.getCurrentContentGenerator(),
        contentGeneratorConfig: this.config.getContentGeneratorConfig(),
      };
    }

    const generatorPromise = (async () => {
      try {
        const targetModel = resolvedModel.id ?? selector?.modelId ?? model;
        const targetConfig = buildAgentContentGeneratorConfig(
          this.config,
          targetModel,
          {
            authType: resolvedModel.authType,
            apiKey: resolvedModel.envKey
              ? (process.env[resolvedModel.envKey] ?? undefined)
              : undefined,
            baseUrl: resolvedModel.baseUrl,
          },
        );
        if (resolvedModel.capabilities?.vision) {
          targetConfig.modalities = {
            ...targetConfig.modalities,
            image: true,
          };
        }
        return {
          contentGenerator: await createContentGenerator(
            targetConfig,
            this.config,
          ),
          contentGeneratorConfig: targetConfig,
        };
      } catch (err: unknown) {
        this.perModelGeneratorCache.delete(cacheKey);
        throw normalizeGeneratorError(err);
      }
    })();

    this.perModelGeneratorCache.set(cacheKey, generatorPromise);
    return generatorPromise.catch(fallbackAfterGeneratorError);
  }

  private resolveModelSelector(model: string): ResolvedModelId | undefined {
    return resolveModelId(model, buildModelIdContext(this.config));
  }
}
