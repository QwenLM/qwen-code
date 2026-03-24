/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Follow-up Suggestions Generator
 *
 * Main service for generating follow-up suggestions based on
 * conversation context and tool calls.
 */

import type {
  SuggestionContext,
  SuggestionResult,
  SuggestionProvider,
} from './types.js';
import { createDefaultProvider } from './ruleBasedProvider.js';

/**
 * Follow-up suggestion generator
 */
export class FollowupSuggestionsGenerator {
  private providers: SuggestionProvider[] = [];

  constructor() {
    // Add default rule-based provider
    this.providers.push(createDefaultProvider());
  }

  /**
   * Generate suggestions based on the context
   */
  generate(context: SuggestionContext): SuggestionResult {
    // Try each provider in order until one returns suggestions
    for (const provider of this.providers) {
      const result = provider.getSuggestions(context);
      if (result.shouldShow && result.suggestions.length > 0) {
        return result;
      }
    }

    return { suggestions: [], shouldShow: false };
  }

  /**
   * Add a custom provider
   */
  addProvider(provider: SuggestionProvider): void {
    this.providers.unshift(provider); // Add to front for priority
  }

  /**
   * Remove a provider
   */
  removeProvider(provider: SuggestionProvider): void {
    const index = this.providers.indexOf(provider);
    if (index > -1) {
      this.providers.splice(index, 1);
    }
  }

  /**
   * Clear all custom providers (keeps default)
   */
  clearCustomProviders(): void {
    this.providers = [createDefaultProvider()];
  }
}

/**
 * Helper function to extract suggestion context from a message
 */
export function extractSuggestionContext(options: {
  lastMessage: string;
  toolCalls?: Array<{
    name: string;
    input: Record<string, unknown>;
    status?: string;
  }>;
  modifiedFiles?: Array<{
    path: string;
    type: 'created' | 'edited' | 'deleted';
  }>;
  gitStatus?: {
    hasStagedChanges?: boolean;
    hasUnstagedChanges?: boolean;
    branch?: string;
  };
  hasError?: boolean;
  wasCancelled?: boolean;
}): SuggestionContext {
  const {
    lastMessage,
    toolCalls = [],
    modifiedFiles = [],
    gitStatus,
    hasError = false,
    wasCancelled = false,
  } = options;

  return {
    lastMessage,
    toolCalls: toolCalls.map((call) => ({
      name: call.name,
      input: call.input,
      status:
        call.status === 'success' ||
        call.status === 'error' ||
        call.status === 'cancelled'
          ? call.status
          : 'success',
    })),
    modifiedFiles,
    gitStatus: gitStatus
      ? {
          hasStagedChanges: gitStatus.hasStagedChanges || false,
          hasUnstagedChanges: gitStatus.hasUnstagedChanges || false,
          branch: gitStatus.branch,
        }
      : undefined,
    hasError,
    wasCancelled,
  };
}

/**
 * Create a singleton generator instance
 */
let defaultGenerator: FollowupSuggestionsGenerator | null = null;

export function getGenerator(): FollowupSuggestionsGenerator {
  if (!defaultGenerator) {
    defaultGenerator = new FollowupSuggestionsGenerator();
  }
  return defaultGenerator;
}

/**
 * Reset the singleton (useful for testing)
 */
export function resetGenerator(): void {
  defaultGenerator = null;
}

/**
 * Convenience function to generate suggestions
 */
export function generateFollowupSuggestions(
  context: SuggestionContext,
): SuggestionResult {
  return getGenerator().generate(context);
}
