/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Follow-up Suggestions Generator
 *
 * Singleton that delegates to the rule-based provider.
 */

import type { SuggestionContext, SuggestionResult } from './types.js';
import { createDefaultProvider } from './ruleBasedProvider.js';

const provider = createDefaultProvider();

/**
 * Generate follow-up suggestions for the given context.
 *
 * @param context - Conversation context (last message, tool calls, etc.)
 * @returns Suggestions and a flag indicating whether to show them
 */
export function generateFollowupSuggestions(
  context: SuggestionContext,
): SuggestionResult {
  return provider.getSuggestions(context);
}
