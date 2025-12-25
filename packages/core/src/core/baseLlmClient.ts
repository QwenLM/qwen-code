/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  Content,
  GenerateContentConfig,
  Part,
  EmbedContentParameters,
  FunctionDeclaration,
  Tool,
  Schema,
} from '@google/genai';
import type { Config } from '../config/config.js';
import type { ContentGenerator } from './contentGenerator.js';
import { reportError } from '../utils/errorReporting.js';
import { getErrorMessage } from '../utils/errors.js';
import { retryWithBackoff } from '../utils/retry.js';
import { getFunctionCalls } from '../utils/generateContentResponseUtilities.js';

const DEFAULT_MAX_ATTEMPTS = 5;

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

    try {
      const apiCall = () =>
        this.contentGenerator.generateContent(
          {
            model,
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
        `Failed to generate JSON content: ${getErrorMessage(error)}`,
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
}
