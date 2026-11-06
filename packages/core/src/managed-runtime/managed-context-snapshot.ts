/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content } from '@google/genai';
import type { LlmPreparedRequest } from '../core/llm-chat.js';
import { getStartupContextLength } from '../core/environmentContext.js';
import { AUTO_MEMORY_SNAPSHOT_METADATA } from '../memory/request-context.js';
import { computeThresholds } from '../services/chatCompressionService.js';
import {
  estimateContentTokens,
  estimateContextTextTokens,
} from '../services/tokenEstimation.js';
import {
  boundManagedCommittedContext,
  boundedModelName,
  type ManagedCommittedContext,
  type ManagedContextCategory,
} from './managed-model-statistics.js';

/** The caller supplies origins from its own injection path, never prompt text tags. */
export function captureManagedContext(input: {
  prepared: LlmPreparedRequest;
  turnId: string;
  contextWindowSize?: number;
  autoCompactThreshold?: number;
  mcpToolNames: ReadonlySet<string>;
  origins: ReadonlyArray<{
    category: 'instructionFiles' | 'memoryFiles' | 'skills' | 'startupContext';
    name: string;
    text: string | undefined;
  }>;
}): Omit<ManagedCommittedContext, 'attemptId'> {
  const { prepared } = input;
  const result: ManagedCommittedContext = {
    version: 1,
    attemptId: 'pending',
    turnId: input.turnId,
    model: prepared.request.model,
    providerPin: prepared.providerPin,
    observedAt: Date.now(),
    inputTokens: null,
    cachedTokens: null,
    contextWindowSize: input.contextWindowSize ?? null,
    breakdown: {
      systemPrompt: 0,
      builtinTools: 0,
      mcpTools: 0,
      instructionFiles: 0,
      memoryFiles: 0,
      skills: 0,
      startupContext: 0,
      messages: 0,
    },
    thresholds: null,
    details: [],
    attributionComplete: true,
    detailsTruncated: false,
  };
  const detail = (
    category: ManagedContextCategory,
    name: string,
    tokens: number,
  ) => {
    result.breakdown[category] += tokens;
    if (!tokens) return;
    if (result.details.length < 32)
      result.details.push({ category, name: boundedModelName(name), tokens });
    else result.detailsTruncated = true;
  };
  const instruction = prepared.request.config.systemInstruction;
  const systemTexts = (value: unknown): string[] => {
    if (typeof value === 'string') return [value];
    if (Array.isArray(value)) return value.flatMap(systemTexts);
    if (value && typeof value === 'object') {
      if ('parts' in value) return systemTexts(value.parts);
      if ('text' in value && typeof value.text === 'string')
        return [value.text];
      result.attributionComplete = false;
    }
    return [];
  };
  const texts = systemTexts(instruction);
  result.breakdown.systemPrompt = texts.reduce(
    (total, text) => total + estimateContextTextTokens(text),
    0,
  );
  const occupied = new Map<string, Array<[number, number]>>();
  for (const origin of input.origins) {
    const text = origin.text?.trim();
    if (!text) continue;
    const containing = texts.find((part) => part.includes(text));
    if (containing === undefined) continue;
    const start = containing.indexOf(text);
    const end = start + text.length;
    const spans = occupied.get(containing) ?? [];
    if (spans.some(([left, right]) => start < right && end > left)) {
      result.attributionComplete = false;
      continue;
    }
    spans.push([start, end]);
    occupied.set(containing, spans);
    const tokens = estimateContextTextTokens(text);
    result.breakdown.systemPrompt = Math.max(
      0,
      result.breakdown.systemPrompt - tokens,
    );
    detail(origin.category, origin.name, tokens);
  }
  for (const tool of prepared.request.config.tools ?? []) {
    if (
      typeof tool !== 'object' ||
      !tool ||
      !('functionDeclarations' in tool)
    ) {
      result.attributionComplete = false;
      continue;
    }
    for (const declaration of tool.functionDeclarations ?? []) {
      const name = declaration.name ?? 'unnamed';
      const category =
        name === 'skill'
          ? 'skills'
          : input.mcpToolNames.has(name)
            ? 'mcpTools'
            : 'builtinTools';
      detail(
        category,
        name,
        estimateContextTextTokens(JSON.stringify(declaration)),
      );
    }
  }
  const startupLength = getStartupContextLength(prepared.request.contents);
  const skillCalls = new Set<string>();
  for (const [index, content] of prepared.request.contents.entries()) {
    for (const part of content.parts ?? []) {
      if (part.functionCall?.name === 'skill' && part.functionCall.id)
        skillCalls.add(part.functionCall.id);
      const category: ManagedContextCategory =
        part.partMetadata?.[AUTO_MEMORY_SNAPSHOT_METADATA] === true
          ? 'memoryFiles'
          : part.functionResponse?.name === 'skill' &&
              part.functionResponse.id &&
              skillCalls.has(part.functionResponse.id)
            ? 'skills'
            : index < startupLength
              ? 'startupContext'
              : 'messages';
      const tokens = estimateContentTokens([
        { role: content.role, parts: [part] } satisfies Content,
      ]);
      result.breakdown[category] += tokens;
    }
  }
  if (input.contextWindowSize && input.contextWindowSize > 0) {
    const { warn, auto, hard } = computeThresholds(
      input.contextWindowSize,
      input.autoCompactThreshold,
    );
    result.thresholds = {
      warn: warn / input.contextWindowSize,
      auto: auto / input.contextWindowSize,
      hard: hard / input.contextWindowSize,
    };
  }
  const { attemptId: _, ...snapshot } = boundManagedCommittedContext(result);
  return snapshot;
}
