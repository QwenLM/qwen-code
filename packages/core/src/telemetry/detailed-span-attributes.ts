/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import type { Span } from '@opentelemetry/api';
import type { Config } from '../config/config.js';
import { isTelemetrySdkInitialized } from './sdk.js';
import { safeJsonStringify } from '../utils/safeJsonStringify.js';
import { DEFAULT_SENSITIVE_SPAN_ATTRIBUTE_MAX_LENGTH } from './constants.js';

const SYSTEM_PROMPT_PREVIEW_LENGTH = 500;

// Process-global; intentionally never cleared in production. Bounded by the
// number of unique system prompts + tool schemas seen in one session.
const seenHashes = new Set<string>();

function isEnabled(config: Config): boolean {
  return (
    isTelemetrySdkInitialized() &&
    config.getTelemetryIncludeSensitiveSpanAttributes()
  );
}

export function truncateContent(
  content: string,
  maxSize: number = DEFAULT_SENSITIVE_SPAN_ATTRIBUTE_MAX_LENGTH,
): { content: string; truncated: boolean } {
  if (content.length <= maxSize) {
    return { content, truncated: false };
  }
  return {
    content:
      content.slice(0, maxSize) +
      '\n\n[TRUNCATED - Content exceeds configured span attribute limit]',
    truncated: true,
  };
}

function getMaxContentSize(config: Config): number {
  return config.getTelemetrySensitiveSpanAttributeMaxLength();
}

function shortHash(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 12);
}

function stringifyContentUnion(value: unknown): string {
  if (typeof value === 'string') return value;
  return safeJsonStringify(value) ?? '';
}

// --- Interaction Span: User Prompt ---

export function addUserPromptAttributes(
  config: Config,
  span: Span,
  promptText: string,
): void {
  if (!isEnabled(config) || !promptText) return;

  const { content, truncated } = truncateContent(
    promptText,
    getMaxContentSize(config),
  );
  span.setAttributes({
    new_context: `[USER PROMPT]\n${content}`,
    ...(truncated && {
      new_context_truncated: true,
      new_context_original_length: promptText.length,
    }),
  });
}

// --- LLM Request Span: System Prompt ---

export function addSystemPromptAttributes(
  config: Config,
  span: Span,
  systemInstruction: unknown,
): void {
  if (!isEnabled(config) || !systemInstruction) return;

  const text = stringifyContentUnion(systemInstruction);
  if (!text) return;

  const hash = `sp_${shortHash(text)}`;
  span.setAttributes({
    system_prompt_hash: hash,
    system_prompt_preview: text.slice(0, SYSTEM_PROMPT_PREVIEW_LENGTH),
    system_prompt_length: text.length,
  });

  if (!seenHashes.has(hash)) {
    seenHashes.add(hash);
    const { content, truncated } = truncateContent(
      text,
      getMaxContentSize(config),
    );
    span.setAttribute('system_prompt', content);
    if (truncated) {
      span.setAttribute('system_prompt_truncated', true);
    }
  }
}

// --- LLM Request Span: Tool Schemas ---

export function addToolSchemaAttributes(
  config: Config,
  span: Span,
  tools: unknown[] | undefined,
): void {
  if (!isEnabled(config) || !tools?.length) return;

  // The Gemini API shape is `[{ functionDeclarations: [...] }]` — a single
  // wrapper object whose inner array holds the actual per-tool schemas.
  // Flatten that here so each declaration becomes its own summary entry and
  // its own deduped tool_schema event, while still falling back to a flat
  // input shape used by tests.
  const declarations: unknown[] = [];
  for (const tool of tools) {
    const inner = (tool as Record<string, unknown>)['functionDeclarations'];
    if (Array.isArray(inner)) {
      declarations.push(...inner);
    } else {
      declarations.push(tool);
    }
  }

  const summary: Array<{ name: string; hash: string }> = [];

  for (const decl of declarations) {
    const declObj = decl as Record<string, unknown>;
    const name =
      typeof declObj['name'] === 'string' ? declObj['name'] : 'unknown_tool';
    const declJson = safeJsonStringify(decl) ?? `unstringifiable_${name}`;
    const hash = shortHash(declJson);
    summary.push({ name, hash });

    const hashKey = `tool_${hash}`;
    if (!seenHashes.has(hashKey)) {
      seenHashes.add(hashKey);
      const { content, truncated } = truncateContent(
        declJson,
        getMaxContentSize(config),
      );
      span.addEvent('tool_schema', {
        tool_name: name,
        tool_hash: hash,
        tool_definition: content,
        ...(truncated && { tool_definition_truncated: true }),
      });
    }
  }

  span.setAttributes({
    tools: safeJsonStringify(summary) ?? '[]',
    tools_count: summary.length,
  });
}

// --- LLM Request Span: Model Output ---

export function addModelOutputAttributes(
  config: Config,
  span: Span,
  responseText: string | undefined,
): void {
  if (!isEnabled(config) || !responseText) return;

  const { content, truncated } = truncateContent(
    responseText,
    getMaxContentSize(config),
  );
  span.setAttributes({
    'response.model_output': content,
    ...(truncated && {
      'response.model_output_truncated': true,
      'response.model_output_original_length': responseText.length,
    }),
  });
}

// --- Tool Span: Input ---

export function addToolInputAttributes(
  config: Config,
  span: Span,
  toolName: string,
  toolInput: string,
): void {
  if (!isEnabled(config)) return;

  const { content, truncated } = truncateContent(
    toolInput,
    getMaxContentSize(config),
  );
  span.setAttributes({
    tool_input: `[TOOL INPUT: ${toolName}]\n${content}`,
    ...(truncated && {
      tool_input_truncated: true,
      tool_input_original_length: toolInput.length,
    }),
  });
}

// --- Tool Span: Result ---

export function addToolResultAttributes(
  config: Config,
  span: Span,
  toolName: string,
  toolResult: string,
): void {
  if (!isEnabled(config)) return;

  const { content, truncated } = truncateContent(
    toolResult,
    getMaxContentSize(config),
  );
  span.setAttributes({
    tool_result: `[TOOL RESULT: ${toolName}]\n${content}`,
    ...(truncated && {
      tool_result_truncated: true,
      tool_result_original_length: toolResult.length,
    }),
  });
}

// --- State Management ---

export function clearDetailedSpanState(): void {
  seenHashes.clear();
}
