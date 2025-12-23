/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content, Part } from '@google/genai';
import type { ContentGenerator } from '../core/contentGenerator.js';
import { tokenLimit } from '../core/tokenLimits.js';

export interface ContextBreakdown {
  userMessages: number;
  assistantResponses: number;
  toolCalls: number;
  toolResponses: number;
  systemInstructions: number;
  cached: number;
  thoughts: number;
  total: number;
}

export interface ContextUsageInfo {
  totalTokens: number;
  breakdown: ContextBreakdown;
  sessionLimit: number;
  usagePercentage: number;
  remainingTokens: number;
  estimatedExchanges: number;
}

/**
 * Analyzes token contribution of different parts within content
 */
async function analyzeContentParts(
  content: Content,
  contentGenerator: ContentGenerator,
  model: string,
): Promise<Partial<ContextBreakdown>> {
  const breakdown: Partial<ContextBreakdown> = {
    toolCalls: 0,
    toolResponses: 0,
    thoughts: 0,
  };

  if (!content.parts || content.parts.length === 0) {
    return breakdown;
  }

  // Attempt to categorize and count tokens for different types of parts
  for (const part of content.parts) {
    try {
      // Calculate tokens for each part individually
      const { totalTokens } = await contentGenerator.countTokens({
        model,
        contents: [{ role: content.role, parts: [part] }],
      });

      if (part.functionCall) {
        breakdown.toolCalls = (breakdown.toolCalls || 0) + (totalTokens || 0);
      } else if (part.functionResponse) {
        breakdown.toolResponses =
          (breakdown.toolResponses || 0) + (totalTokens || 0);
      } else if ((part as Part & { thought?: boolean }).thought) {
        breakdown.thoughts = (breakdown.thoughts || 0) + (totalTokens || 0);
      }
    } catch {
      // If calculation fails for a part, skip it
      continue;
    }
  }

  return breakdown;
}

/**
 * Analyzes conversation history context usage
 * @param history Array of conversation history content
 * @param systemPrompt System prompt text
 * @param model Model name
 * @param contentGenerator Content generator for token counting
 * @param sessionLimit Session token limit
 */
export async function analyzeContextUsage(
  history: Content[],
  systemPrompt: string,
  model: string,
  contentGenerator: ContentGenerator,
  sessionLimit: number,
): Promise<ContextUsageInfo> {
  const breakdown: ContextBreakdown = {
    userMessages: 0,
    assistantResponses: 0,
    toolCalls: 0,
    toolResponses: 0,
    systemInstructions: 0,
    cached: 0,
    thoughts: 0,
    total: 0,
  };

  // Count system prompt tokens
  try {
    const systemTokens = await contentGenerator.countTokens({
      model,
      contents: [{ role: 'system', parts: [{ text: systemPrompt }] }],
    });
    breakdown.systemInstructions = systemTokens.totalTokens || 0;
  } catch {
    // If counting fails, use rough estimate
    breakdown.systemInstructions = Math.ceil(systemPrompt.length / 4);
  }

  // Count tokens in history messages
  for (const content of history) {
    try {
      // Get total token count for the entire content
      const { totalTokens, cachedContentTokenCount } =
        await contentGenerator.countTokens({
          model,
          contents: [content],
        });

      const contentTokens = totalTokens || 0;

      // Accumulate cached tokens
      if (cachedContentTokenCount) {
        breakdown.cached += cachedContentTokenCount;
      }

      // Categorize by role
      if (content.role === 'user') {
        breakdown.userMessages += contentTokens;
      } else if (content.role === 'model') {
        breakdown.assistantResponses += contentTokens;

        // Further analyze tool calls and thoughts in model responses
        const partBreakdown = await analyzeContentParts(
          content,
          contentGenerator,
          model,
        );
        breakdown.toolCalls += partBreakdown.toolCalls || 0;
        breakdown.thoughts += partBreakdown.thoughts || 0;

        // Subtract already counted parts from assistant responses
        breakdown.assistantResponses -= partBreakdown.toolCalls || 0;
        breakdown.assistantResponses -= partBreakdown.thoughts || 0;
      } else if (content.role === 'function') {
        breakdown.toolResponses += contentTokens;
      }
    } catch {
      // If counting fails for a message, use rough estimate
      const estimatedTokens = Math.ceil(JSON.stringify(content).length / 4);
      if (content.role === 'user') {
        breakdown.userMessages += estimatedTokens;
      } else if (content.role === 'model') {
        breakdown.assistantResponses += estimatedTokens;
      } else if (content.role === 'function') {
        breakdown.toolResponses += estimatedTokens;
      }
    }
  }

  // Calculate total tokens
  breakdown.total =
    breakdown.userMessages +
    breakdown.assistantResponses +
    breakdown.toolCalls +
    breakdown.toolResponses +
    breakdown.systemInstructions +
    breakdown.thoughts;

  // Use actual session limit, or model's max input limit if not configured
  const effectiveLimit =
    sessionLimit > 0 ? sessionLimit : tokenLimit(model, 'input');

  // Calculate usage percentage
  const usagePercentage =
    effectiveLimit > 0 ? (breakdown.total / effectiveLimit) * 100 : 0;

  // Calculate remaining tokens
  const remainingTokens = Math.max(0, effectiveLimit - breakdown.total);

  // Estimate remaining conversation exchanges
  // Assumes average of 500 tokens per exchange (200 user input + 300 assistant output)
  const avgTokensPerExchange = 500;
  const estimatedExchanges = Math.floor(remainingTokens / avgTokensPerExchange);

  return {
    totalTokens: breakdown.total,
    breakdown,
    sessionLimit: effectiveLimit,
    usagePercentage,
    remainingTokens,
    estimatedExchanges: Math.max(0, estimatedExchanges),
  };
}
