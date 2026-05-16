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
import type { Config } from '../config/config.js';
import type { ContentGenerator } from './contentGenerator.js';
import { AuthType, createContentGenerator } from './contentGenerator.js';
import type { ResolvedModelConfig } from '../models/types.js';
import { buildAgentContentGeneratorConfig } from '../models/content-generator-config.js';
import { resolveModelId, type ResolvedModelId } from '../utils/modelId.js';
import { reportError } from '../utils/errorReporting.js';
import { getErrorMessage } from '../utils/errors.js';
import { retryWithBackoff, isUnattendedMode } from '../utils/retry.js';
import { getFunctionCalls } from '../utils/generateContentResponseUtilities.js';
import { getResponseText } from '../utils/partUtils.js';
import { createDebugLogger } from '../utils/debugLogger.js';

const DEFAULT_MAX_ATTEMPTS = 7;

const debugLogger = createDebugLogger('BASE_LLM_CLIENT');

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
  retryAuthType: string | undefined;
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
    Promise<ContentGenerator>
  >();

  constructor(
    private readonly contentGenerator: ContentGenerator,
    private readonly config: Config,
  ) {}

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
      retryAuthType,
      model: requestModel,
    } = await this.resolveForModel(model);

    try {
      const apiCall = () =>
        contentGenerator.generateContent(
          {
            model: requestModel,
            config: {
              ...requestConfig,
              tools,
            },
            contents,
          },
          promptId ?? '',
        );

      const result = await retryWithBackoff(apiCall, {
        maxAttempts: maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
        authType: retryAuthType,
        persistentMode: isUnattendedMode(),
        signal: abortSignal,
        heartbeatFn: (info) => {
          process.stderr.write(
            `[qwen-code] Waiting for API capacity... attempt ${info.attempt}, retry in ${Math.ceil(info.remainingMs / 1000)}s\n`,
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
    } = options;

    const requestConfig: GenerateContentConfig = {
      abortSignal,
      ...options.config,
      ...(systemInstruction && { systemInstruction }),
    };

    const {
      contentGenerator,
      retryAuthType,
      model: requestModel,
    } = await this.resolveForModel(model);

    try {
      const apiCall = () =>
        contentGenerator.generateContent(
          {
            model: requestModel,
            config: requestConfig,
            contents,
          },
          promptId ?? '',
        );

      const result = await retryWithBackoff(apiCall, {
        maxAttempts: maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
        authType: retryAuthType,
        persistentMode: isUnattendedMode(),
        signal: abortSignal,
        heartbeatFn: (info) => {
          process.stderr.write(
            `[qwen-code] Waiting for API capacity... attempt ${info.attempt}, retry in ${Math.ceil(info.remainingMs / 1000)}s\n`,
          );
        },
      });

      return {
        text: (getResponseText(result) ?? '').trim(),
        usage: result.usageMetadata,
      };
    } catch (error) {
      if (abortSignal.aborted) {
        throw error;
      }

      await reportError(
        error,
        'Error generating text content via API.',
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
  async resolveForModel(model: string): Promise<ResolvedGeneratorForModel> {
    const selector = this.resolveModelSelector(model);
    const requestModel = selector?.modelId ?? this.config.getModel() ?? model;
    const mainModel = this.config.getModel() ?? model;
    const mainAuthType = this.config.getContentGeneratorConfig()?.authType;

    if (
      requestModel === mainModel &&
      (!selector?.authType || selector.authType === mainAuthType)
    ) {
      return {
        contentGenerator: this.contentGenerator,
        retryAuthType: mainAuthType,
        model: requestModel,
      };
    }

    const contentGenerator = await this.createContentGeneratorForModel(
      model,
      selector,
    );
    const resolvedModel = this.resolveModelAcrossAuthTypes(model, selector);
    const retryAuthType =
      resolvedModel?.authType ?? mainAuthType ?? AuthType.USE_OPENAI;

    return {
      contentGenerator,
      retryAuthType,
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
  ): ResolvedModelConfig | undefined {
    const modelsConfig = this.config.getModelsConfig?.();
    if (!modelsConfig) return undefined;
    if (!selector) return undefined;
    const modelId = selector.modelId;

    if (selector.authType) {
      return modelsConfig.getResolvedModel(selector.authType, modelId);
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
      const resolved = modelsConfig.getResolvedModel(mainAuthType, modelId);
      if (resolved) return resolved;
    }

    for (const authType of allAuthTypes) {
      if (authType === mainAuthType) continue;
      const resolved = modelsConfig.getResolvedModel(authType, modelId);
      if (resolved) return resolved;
    }

    return undefined;
  }

  private async createContentGeneratorForModel(
    model: string,
    selector: ResolvedModelId | undefined,
  ): Promise<ContentGenerator> {
    const cacheKey = selector
      ? `${selector.authType ?? ''}:${selector.modelId}`
      : model;
    const cached = this.perModelGeneratorCache.get(cacheKey);
    if (cached) return cached;

    const generatorPromise = (async () => {
      try {
        const resolvedModel = this.resolveModelAcrossAuthTypes(model, selector);

        if (!resolvedModel) {
          debugLogger.warn(
            `Model "${model}" not found in registry across all authTypes, falling back to main generator.`,
          );
          return this.contentGenerator;
        }

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

        return await createContentGenerator(targetConfig, this.config);
      } catch (err: unknown) {
        debugLogger.warn(
          `Failed to create content generator for model "${model}", falling back to main generator.`,
          err instanceof Error ? err.message : String(err),
        );
        this.perModelGeneratorCache.delete(cacheKey);
        return this.contentGenerator;
      }
    })();

    this.perModelGeneratorCache.set(cacheKey, generatorPromise);
    return generatorPromise;
  }

  private resolveModelSelector(model: string): ResolvedModelId | undefined {
    return resolveModelId(model, {
      currentModel: this.config.getModel(),
      currentAuthType: this.config.getContentGeneratorConfig()?.authType,
      fastModel:
        this.config.getFastModelForSideQuery?.() ??
        this.config.getFastModel?.(),
    });
  }
}
