/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Span } from '@opentelemetry/api';
import type { Config } from '../config/config.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import { isTelemetrySdkInitialized } from './sdk.js';
import { DEFAULT_SENSITIVE_SPAN_ATTRIBUTE_MAX_LENGTH } from './constants.js';
import { extractGeminiContent, stringifyGenAiJson } from './gen-ai-content.js';

const SHORT_TRUNCATION_SUFFIX = '...[TRUNCATED]';
const debugLogger = createDebugLogger('GEN_AI_CONTENT');

export function areSensitiveSpanAttributesEnabled(config: Config): boolean {
  return (
    isTelemetrySdkInitialized() &&
    config.getTelemetryIncludeSensitiveSpanAttributes()
  );
}

export function truncateContent(
  content: string,
  maxSize: number = DEFAULT_SENSITIVE_SPAN_ATTRIBUTE_MAX_LENGTH,
  originalLength: number = content.length,
): { content: string; truncated: boolean } {
  if (!Number.isSafeInteger(maxSize) || maxSize < 1) {
    throw new TypeError(
      `maxSize must be a positive safe integer, got ${String(maxSize)}`,
    );
  }
  if (!Number.isSafeInteger(originalLength) || originalLength < 0) {
    throw new TypeError(
      `originalLength must be a non-negative safe integer, got ${String(
        originalLength,
      )}`,
    );
  }
  if (originalLength < content.length) {
    throw new TypeError(
      `originalLength must be greater than or equal to content length, got ${originalLength} for content length ${content.length}`,
    );
  }

  if (originalLength <= maxSize && content.length <= maxSize) {
    return { content, truncated: false };
  }
  if (originalLength > content.length && content.length <= maxSize) {
    return { content, truncated: true };
  }
  const suffix = `\n\n[TRUNCATED - Content exceeds configured limit of ${maxSize} characters]`;
  if (suffix.length >= maxSize) {
    if (SHORT_TRUNCATION_SUFFIX.length >= maxSize) {
      return {
        content: SHORT_TRUNCATION_SUFFIX.slice(0, maxSize),
        truncated: true,
      };
    }
    return {
      content:
        content.slice(0, maxSize - SHORT_TRUNCATION_SUFFIX.length) +
        SHORT_TRUNCATION_SUFFIX,
      truncated: true,
    };
  }
  return {
    content: content.slice(0, maxSize - suffix.length) + suffix,
    truncated: true,
  };
}

function getMaxContentSize(config: Config): number {
  return config.getTelemetrySensitiveSpanAttributeMaxLength();
}

function truncatePrefixedContent(
  prefix: string,
  content: string,
  maxSize: number,
): { content: string; truncated: boolean; originalLength: number } {
  const prefixedContent = `${prefix}${content}`;
  const result = truncateContent(prefixedContent, maxSize);
  return {
    ...result,
    originalLength: content.length,
  };
}

// --- Interaction Span: User Prompt ---

export function addAgentInputMessageAttributes(
  config: Config,
  span: Span,
  promptText: string,
): void {
  if (
    !areSensitiveSpanAttributesEnabled(config) ||
    promptText.trim().length === 0
  ) {
    return;
  }
  writeJsonAttribute(config, span, 'gen_ai.input.messages', [
    {
      role: 'user',
      parts: [{ type: 'text', content: promptText }],
    },
  ]);
}

export function addAgentOutputMessageAttributes(
  config: Config,
  span: Span,
  responseText: string,
  finishReason: string,
): void {
  if (
    !areSensitiveSpanAttributesEnabled(config) ||
    responseText.trim().length === 0
  ) {
    return;
  }
  const reason = normalizeAgentFinishReason(finishReason);
  if (!reason) return;
  writeJsonAttribute(config, span, 'gen_ai.output.messages', [
    {
      role: 'assistant',
      parts: [{ type: 'text', content: responseText }],
      finish_reason: reason,
    },
  ]);
}

function normalizeAgentFinishReason(
  finishReason: string | undefined,
): string | undefined {
  const reason = finishReason?.trim().toLowerCase();
  if (!reason || reason === 'finish_reason_unspecified') return undefined;
  if (reason === 'stop') return 'stop';
  if (reason === 'max_tokens') return 'length';
  if (
    reason === 'tool_calls' ||
    reason === 'function_call' ||
    reason === 'tool_call'
  ) {
    return 'tool_call';
  }
  if (
    reason === 'safety' ||
    reason === 'recitation' ||
    reason === 'language' ||
    reason === 'blocklist' ||
    reason === 'prohibited_content' ||
    reason === 'spii' ||
    reason === 'image_safety' ||
    reason === 'image_prohibited_content' ||
    reason === 'image_recitation' ||
    reason === 'image_other'
  ) {
    return 'content_filter';
  }
  return reason;
}

export class AgentOutputMessageCapture {
  private readonly enabled: boolean;
  private readonly maxLength: number;
  private responseText = '';
  private finishReason: string | undefined;
  private overflow = false;
  private committed: { responseText: string; finishReason: string } | undefined;

  constructor(private readonly config: Config) {
    this.enabled = areSensitiveSpanAttributesEnabled(config);
    this.maxLength = this.enabled
      ? config.getTelemetrySensitiveSpanAttributeMaxLength()
      : 0;
  }

  beginResponse(): void {
    if (!this.enabled) return;
    this.clearResponse();
    this.committed = undefined;
  }

  appendText(text: string): void {
    if (!this.enabled || !text || this.overflow) return;
    const remaining = this.maxLength - this.responseText.length;
    if (text.length > remaining) {
      this.responseText = '';
      this.overflow = true;
      this.committed = undefined;
      return;
    }
    this.responseText += text;
  }

  observeFinishReason(finishReason: string | undefined): void {
    if (!this.enabled) return;
    const normalized = normalizeAgentFinishReason(finishReason);
    if (normalized) this.finishReason = normalized;
  }

  restartAttempt(preserveText: boolean): void {
    if (!this.enabled) return;
    if (!preserveText) {
      this.clearResponse();
    } else {
      this.finishReason = undefined;
    }
    this.committed = undefined;
  }

  commitResponse(hasToolCalls: boolean): void {
    if (
      !this.enabled ||
      hasToolCalls ||
      this.overflow ||
      this.responseText.trim().length === 0 ||
      !this.finishReason
    ) {
      this.committed = undefined;
      return;
    }
    this.committed = {
      responseText: this.responseText,
      finishReason: this.finishReason,
    };
  }

  writeToSpan(span: Span | undefined): void {
    if (!span || !this.committed) return;
    addAgentOutputMessageAttributes(
      this.config,
      span,
      this.committed.responseText,
      this.committed.finishReason,
    );
  }

  private clearResponse(): void {
    this.responseText = '';
    this.finishReason = undefined;
    this.overflow = false;
  }
}

export function addUserPromptAttributes(
  config: Config,
  span: Span,
  promptText: string,
): void {
  if (!areSensitiveSpanAttributesEnabled(config) || !promptText) return;

  const { content, truncated, originalLength } = truncatePrefixedContent(
    `[USER PROMPT]\n`,
    promptText,
    getMaxContentSize(config),
  );
  span.setAttributes({
    new_context: content,
    ...(truncated && {
      new_context_truncated: true,
      new_context_original_length: originalLength,
    }),
  });
}

/**
 * @deprecated Provider-final requests are captured by the GenAI exchange.
 */
export function addSystemPromptAttributes(
  config: Config,
  span: Span,
  systemInstruction: unknown,
): void {
  if (!areSensitiveSpanAttributesEnabled(config)) return;
  const parts = extractGeminiContent({
    config: { systemInstruction },
  }).systemInstructions;
  if (parts !== undefined) {
    writeJsonAttribute(config, span, 'gen_ai.system_instructions', parts);
  }
}

/**
 * @deprecated Provider-final requests are captured by the GenAI exchange.
 */
export function addToolSchemaAttributes(
  config: Config,
  span: Span,
  tools: unknown[] | undefined,
): void {
  if (!areSensitiveSpanAttributesEnabled(config) || tools === undefined) return;
  const providerTools = tools.every(
    (tool) =>
      typeof tool === 'object' &&
      tool !== null &&
      Object.hasOwn(tool, 'functionDeclarations'),
  )
    ? tools
    : [{ functionDeclarations: tools }];
  const definitions = extractGeminiContent({
    config: { tools: providerTools },
  }).toolDefinitions;
  if (definitions !== undefined) {
    writeJsonAttribute(config, span, 'gen_ai.tool.definitions', definitions);
  }
}

/**
 * @deprecated Provider responses are captured by the GenAI exchange.
 * This compatibility helper writes nothing without an explicit finish reason.
 */
export function addModelOutputAttributes(
  config: Config,
  span: Span,
  responseText: string | undefined,
  originalLengthOrFinishReason?: number | string,
  finishReason?: string,
): void {
  if (!areSensitiveSpanAttributesEnabled(config) || responseText === undefined)
    return;
  const reason =
    typeof originalLengthOrFinishReason === 'string'
      ? originalLengthOrFinishReason
      : finishReason;
  if (!reason) return;
  addAgentOutputMessageAttributes(config, span, responseText, reason);
}

/**
 * @deprecated Use addToolArgumentsAttributes with the final invocation params.
 * Only JSON object strings produce a standard arguments attribute.
 */
export function addToolInputAttributes(
  config: Config,
  span: Span,
  _toolName: string,
  toolInput: string,
): void {
  let value: unknown;
  try {
    value = JSON.parse(toolInput);
  } catch {
    return;
  }
  addToolArgumentsAttributes(config, span, value);
}

/**
 * @deprecated Use addToolCallResultAttributes with the final FunctionResponse.
 * Only JSON object strings produce a standard result attribute.
 */
export function addToolResultAttributes(
  config: Config,
  span: Span,
  _toolName: string,
  toolResult: string,
): void {
  let value: unknown;
  try {
    value = JSON.parse(toolResult);
  } catch {
    return;
  }
  addToolCallResultAttributes(config, span, value);
}

export function addToolArgumentsAttributes(
  config: Config,
  span: Span,
  argumentsValue: unknown,
): void {
  if (!areSensitiveSpanAttributesEnabled(config)) return;
  writeJsonAttribute(
    config,
    span,
    'gen_ai.tool.call.arguments',
    argumentsValue,
    true,
  );
}

export function addToolCallResultAttributes(
  config: Config,
  span: Span,
  result: unknown,
): void {
  if (!areSensitiveSpanAttributesEnabled(config)) return;
  writeJsonAttribute(config, span, 'gen_ai.tool.call.result', result, true);
}

/**
 * @deprecated Sensitive GenAI attributes no longer use process-global state.
 */
export function clearDetailedSpanState(): void {
  // Compatibility no-op.
}

function writeJsonAttribute(
  config: Config,
  span: Span,
  key: string,
  value: unknown,
  requireObject = false,
): void {
  let serialized: string | undefined;
  try {
    serialized = stringifyGenAiJson(
      value,
      getMaxContentSize(config),
      requireObject,
    );
  } catch {
    debugLogger.debug(`Failed to serialize ${key} span attribute`);
    return;
  }
  if (serialized === undefined) return;
  try {
    span.setAttribute(key, serialized);
  } catch {
    debugLogger.debug(`Failed to set ${key} span attribute`);
  }
}
