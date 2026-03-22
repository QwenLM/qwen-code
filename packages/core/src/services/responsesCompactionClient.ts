/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content } from '@google/genai';
import type { ContentGeneratorConfig } from '../core/contentGenerator.js';
import type {
  ResponsesApiInputItem,
  ResponsesApiTool,
  ResponsesApiReasoning,
  ResponsesApiTextControls,
} from '../core/openaiResponsesContentGenerator/types.js';
import { convertGeminiContentsToResponsesInput } from '../core/openaiResponsesContentGenerator/responsesConverter.js';
import { COMPACTION_SUMMARY_PREFIX } from '../core/prompts.js';
import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('COMPACTION_CLIENT');

// ── Compaction request/response types ──────────────────────────────────

interface CompactionRequest {
  model: string;
  input: ResponsesApiInputItem[];
  instructions?: string;
  tools?: ResponsesApiTool[];
  parallel_tool_calls?: boolean;
  reasoning?: ResponsesApiReasoning;
  text?: ResponsesApiTextControls;
  include?: string[];
  truncation?: { type: 'auto' | 'disabled' };
}

interface CompactionResponseItem {
  type: string;
  role?: string;
  content?: string | Array<{ type: string; text?: string }>;
  encrypted_content?: string;
  [key: string]: unknown;
}

interface CompactionResponse {
  output: CompactionResponseItem[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
}

// ── Filtering logic (ports Codex's should_keep_compacted_history_item) ─

export function shouldKeepCompactedItem(
  item: CompactionResponseItem,
): boolean {
  if (item.type === 'compaction') return true;

  if (item.type === 'message') {
    if (item.role === 'developer') return false;
    if (item.role === 'user') return true;
    if (item.role === 'assistant') return true;
    return false;
  }

  if (item.type === 'function_call') return false;
  if (item.type === 'function_call_output') return false;

  return false;
}

export function processCompactedOutput(
  output: CompactionResponseItem[],
): CompactionResponseItem[] {
  return output.filter(shouldKeepCompactedItem);
}

// ── Convert compacted items back to Content[] ──────────────────────────

export function compactedItemsToContents(
  items: CompactionResponseItem[],
): Content[] {
  const contents: Content[] = [];

  for (const item of items) {
    if (item.type === 'compaction') {
      contents.push({
        role: 'user',
        parts: [
          {
            text: `${COMPACTION_SUMMARY_PREFIX}\n${JSON.stringify(item)}`,
          },
        ],
      });
      continue;
    }

    if (item.type === 'message') {
      const role = item.role === 'assistant' ? 'model' : 'user';
      let text = '';

      if (typeof item.content === 'string') {
        text = item.content;
      } else if (Array.isArray(item.content)) {
        text = item.content
          .map((p) => (p.type === 'output_text' || p.type === 'text' ? p.text ?? '' : ''))
          .join('');
      }

      if (text) {
        contents.push({ role, parts: [{ text }] });
      }
    }
  }

  return contents;
}

// ── HTTP client ────────────────────────────────────────────────────────

export class ResponsesCompactionClient {
  private readonly config: ContentGeneratorConfig;

  constructor(config: ContentGeneratorConfig) {
    this.config = config;
  }

  async compact(
    history: readonly Content[],
    systemInstruction?: string,
    tools?: Content[],
  ): Promise<{
    compactedHistory: Content[];
    inputTokens: number;
    outputTokens: number;
  }> {
    const { instructions: extractedInstructions, input } =
      convertGeminiContentsToResponsesInput({
        contents: [...history],
        config: systemInstruction
          ? { systemInstruction }
          : undefined,
      } as import('@google/genai').GenerateContentParameters);

    const request: CompactionRequest = {
      model: this.config.model,
      input,
      instructions: extractedInstructions ?? systemInstruction,
      parallel_tool_calls: true,
      truncation: { type: 'auto' },
    };

    const reasoning = this.config.reasoning;
    if (reasoning && typeof reasoning === 'object') {
      const reqReasoning: ResponsesApiReasoning = {};
      if (reasoning.effort) reqReasoning.effort = reasoning.effort;
      if (reasoning.summary) {
        reqReasoning.summary = reasoning.summary;
      } else if (reasoning.effort) {
        reqReasoning.summary = 'auto';
      }
      if (Object.keys(reqReasoning).length > 0) {
        request.reasoning = reqReasoning;
        request.include = ['reasoning.encrypted_content'];
      }
    }

    if (this.config.verbosity) {
      request.text = { verbosity: this.config.verbosity };
    }

    const baseUrl = this.config.baseUrl ?? 'https://api.openai.com';
    const url = `${baseUrl.replace(/\/$/, '')}/v1/responses/compact`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    const apiKey =
      this.config.apiKey ??
      (this.config.apiKeyEnvKey
        ? process.env[this.config.apiKeyEnvKey]
        : undefined);
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    if (this.config.customHeaders) {
      Object.assign(headers, this.config.customHeaders);
    }

    const body = JSON.stringify(request);
    debugLogger.debug(
      `POST ${url} (${input.length} items, ${body.length} bytes)`,
    );

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body,
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      debugLogger.error(
        `Compaction failed: ${response.status} ${errBody.substring(0, 500)}`,
      );
      throw new Error(
        `Responses compact error ${response.status}: ${errBody.substring(0, 200)}`,
      );
    }

    const result = (await response.json()) as CompactionResponse;

    const filtered = processCompactedOutput(result.output ?? []);
    const compactedHistory = compactedItemsToContents(filtered);

    const inputTokens = result.usage?.input_tokens ?? 0;
    const outputTokens = result.usage?.output_tokens ?? 0;

    debugLogger.debug(
      `Compaction complete: ${input.length} items -> ${compactedHistory.length} contents (${inputTokens} in, ${outputTokens} out)`,
    );

    return { compactedHistory, inputTokens, outputTokens };
  }
}
