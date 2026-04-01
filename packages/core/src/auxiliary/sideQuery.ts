/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  Content,
  GenerateContentConfig,
  Part,
} from '@google/genai';
import type { Config } from '../config/config.js';
import { DEFAULT_QWEN_MODEL } from '../config/models.js';
import { SchemaValidator } from '../utils/schemaValidator.js';

export interface SideQueryOptions<TResponse> {
  contents: Content[];
  schema: Record<string, unknown>;
  abortSignal: AbortSignal;
  model?: string;
  systemInstruction?: string | Part | Part[] | Content;
  promptId?: string;
  purpose?: string;
  config?: Omit<
    GenerateContentConfig,
    | 'systemInstruction'
    | 'responseJsonSchema'
    | 'responseMimeType'
    | 'tools'
    | 'abortSignal'
  >;
  validate?: (response: TResponse) => string | null;
}

function buildDefaultPromptId(purpose?: string): string {
  return purpose ? `side-query:${purpose}` : 'side-query';
}

export async function runSideQuery<TResponse>(
  config: Config,
  options: SideQueryOptions<TResponse>,
): Promise<TResponse> {
  const response = (await config.getBaseLlmClient().generateJson({
    contents: options.contents,
    schema: options.schema,
    abortSignal: options.abortSignal,
    model: options.model ?? config.getModel() ?? DEFAULT_QWEN_MODEL,
    systemInstruction: options.systemInstruction,
    promptId: options.promptId ?? buildDefaultPromptId(options.purpose),
    config: options.config,
  })) as TResponse;

  const schemaError = SchemaValidator.validate(options.schema, response);
  if (schemaError) {
    throw new Error(`Invalid side query response: ${schemaError}`);
  }

  const customError = options.validate?.(response);
  if (customError) {
    throw new Error(customError);
  }

  return response;
}
