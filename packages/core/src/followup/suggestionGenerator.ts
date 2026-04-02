/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Prompt Suggestion Generator
 *
 * Uses a lightweight LLM call to predict what the user would naturally
 * type next (Next-step Suggestion / NES).
 */

import type { Content } from '@google/genai';
import type { Config } from '../config/config.js';
import { getCacheSafeParams, runForkedQuery } from './forkedQuery.js';

/**
 * Prompt for suggestion generation.
 * Instructs the model to predict the user's next input.
 */
export const SUGGESTION_PROMPT = `[SUGGESTION MODE: Suggest what the user might naturally type next.]

FIRST: Look at the user's recent messages and original request.

Your job is to predict what THEY would type - not what you think they should do.

THE TEST: Would they think "I was just about to type that"?

EXAMPLES:
User asked "fix the bug and run tests", bug is fixed → "run the tests"
After code written → "try it out"
Model offers options → suggest the one the user would likely pick, based on conversation
Model asks to continue → "yes" or "go ahead"
Task complete, obvious follow-up → "commit this" or "push it"
After error or misunderstanding → silence (let them assess/correct)

Be specific: "run the tests" beats "continue".

NEVER SUGGEST:
- Evaluative ("looks good", "thanks")
- Questions ("what about...?")
- AI-voice ("Let me...", "I'll...", "Here's...")
- New ideas they didn't ask about
- Multiple sentences

Stay silent if the next step isn't obvious from what the user said.

Format: 2-12 words, match the user's style. Or nothing.

Reply with ONLY the suggestion, no quotes or explanation.`;

/**
 * JSON schema for the suggestion response.
 */
const SUGGESTION_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    suggestion: {
      type: 'string',
      description:
        'The predicted next user input (2-12 words), or empty string if nothing obvious.',
    },
  },
  required: ['suggestion'],
};

/** Minimum assistant turns before generating suggestions */
const MIN_ASSISTANT_TURNS = 2;

/**
 * Generate a prompt suggestion using an LLM call.
 *
 * @param config - App config (provides BaseLlmClient and model)
 * @param conversationHistory - Full conversation history as Content[]
 * @param abortSignal - Signal to cancel the LLM call (e.g., when user types)
 * @returns Object with suggestion text and optional filter reason, or null on error/early skip
 */
export async function generatePromptSuggestion(
  config: Config,
  conversationHistory: Content[],
  abortSignal: AbortSignal,
  options?: { enableCacheSharing?: boolean },
): Promise<{ suggestion: string | null; filterReason?: string }> {
  // Don't suggest in very early conversations
  const modelTurns = conversationHistory.filter(
    (c) => c.role === 'model',
  ).length;
  if (modelTurns < MIN_ASSISTANT_TURNS) {
    return { suggestion: null, filterReason: 'early_conversation' };
  }

  try {
    // Try cache-aware forked query if enabled and params available
    const cacheSafe = options?.enableCacheSharing ? getCacheSafeParams() : null;
    const raw = cacheSafe
      ? await generateViaForkedQuery(config, abortSignal)
      : await generateViaBaseLlm(config, conversationHistory, abortSignal);

    const suggestion = typeof raw === 'string' ? raw.trim() : null;

    if (!suggestion) {
      return { suggestion: null, filterReason: 'empty' };
    }

    const filterReason = getFilterReason(suggestion);
    if (filterReason) {
      return { suggestion: null, filterReason };
    }

    return { suggestion };
  } catch {
    if (abortSignal.aborted) {
      return { suggestion: null };
    }
    return { suggestion: null, filterReason: 'error' };
  }
}

/** Generate suggestion via cache-aware forked query */
async function generateViaForkedQuery(
  config: Config,
  abortSignal: AbortSignal,
): Promise<string | null> {
  const result = await runForkedQuery(config, SUGGESTION_PROMPT, {
    abortSignal,
    jsonSchema: SUGGESTION_SCHEMA,
  });

  if (result.jsonResult) {
    const raw = result.jsonResult['suggestion'];
    return typeof raw === 'string' ? raw : null;
  }

  // Fallback: try parsing text as JSON
  if (result.text) {
    try {
      const parsed = JSON.parse(result.text) as Record<string, unknown>;
      const raw = parsed['suggestion'];
      return typeof raw === 'string' ? raw : null;
    } catch {
      // Model returned plain text — use it directly
      return result.text;
    }
  }

  return null;
}

/** Fallback: generate via standalone BaseLlmClient.generateJson */
async function generateViaBaseLlm(
  config: Config,
  conversationHistory: Content[],
  abortSignal: AbortSignal,
): Promise<string | null> {
  const contents: Content[] = [
    ...conversationHistory,
    { role: 'user', parts: [{ text: SUGGESTION_PROMPT }] },
  ];

  // Try function-calling JSON first
  const result = await config.getBaseLlmClient().generateJson({
    contents,
    schema: SUGGESTION_SCHEMA,
    model: config.getModel(),
    abortSignal,
    promptId: 'prompt_suggestion',
    maxAttempts: 2,
  });

  const raw = result['suggestion'];
  if (typeof raw === 'string' && raw.trim()) {
    return raw;
  }

  // Fallback: some models (e.g., glm-5.1) don't support function calling.
  // Send a direct text request and use the response as-is.
  if (Object.keys(result).length === 0) {
    const generator = config.getContentGenerator();
    const response = await generator.generateContent(
      {
        model: config.getModel(),
        contents,
        config: { abortSignal },
      },
      'prompt_suggestion',
    );
    const text = response.candidates?.[0]?.content?.parts
      ?.map((p) => p.text ?? '')
      .join('')
      .trim();
    if (text) {
      // Try to parse as JSON first (model might return {"suggestion": "..."})
      try {
        const parsed = JSON.parse(text) as Record<string, unknown>;
        const s = parsed['suggestion'];
        if (typeof s === 'string') return s;
      } catch {
        // Not JSON — use raw text as the suggestion
      }
      return text;
    }
  }

  return null;
}

/** Single-word suggestions allowed through the too_few_words filter */
const ALLOWED_SINGLE_WORDS = new Set([
  'yes',
  'yeah',
  'yep',
  'yea',
  'yup',
  'sure',
  'ok',
  'okay',
  'push',
  'commit',
  'deploy',
  'stop',
  'continue',
  'check',
  'exit',
  'quit',
  'no',
]);

/**
 * Returns the filter reason if the suggestion should be suppressed, or null if it passes.
 */
export function getFilterReason(suggestion: string): string | null {
  const lower = suggestion.toLowerCase();
  const wordCount = suggestion.trim().split(/\s+/).length;

  if (lower === 'done') return 'done';

  if (
    lower === 'nothing found' ||
    lower === 'nothing found.' ||
    lower.startsWith('nothing to suggest') ||
    lower.startsWith('no suggestion') ||
    /\bsilence is\b|\bstay(s|ing)? silent\b/.test(lower) ||
    /^\W*silence\W*$/.test(lower)
  ) {
    return 'meta_text';
  }

  if (/^\(.*\)$|^\[.*\]$/.test(suggestion)) return 'meta_wrapped';

  if (
    lower.startsWith('api error:') ||
    lower.startsWith('prompt is too long') ||
    lower.startsWith('request timed out') ||
    lower.startsWith('invalid api key') ||
    lower.startsWith('image was too large')
  ) {
    return 'error_message';
  }

  if (/^\w+:\s/.test(suggestion)) return 'prefixed_label';

  // CJK text has no spaces — skip whitespace-based word count checks
  // and use character count instead
  const hasCJK = /[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/.test(
    suggestion,
  );
  if (!hasCJK) {
    if (wordCount < 2) {
      if (suggestion.startsWith('/')) return null; // slash commands ok
      if (!ALLOWED_SINGLE_WORDS.has(lower)) return 'too_few_words';
    }
    if (wordCount > 12) return 'too_many_words';
  } else {
    // For CJK: filter if too short (< 2 chars) or too long (> 30 chars)
    if (suggestion.length < 2) return 'too_few_words';
    if (suggestion.length > 30) return 'too_many_words';
  }
  if (suggestion.length >= 100) return 'too_long';
  if (/[.!?]\s+[A-Z]/.test(suggestion)) return 'multiple_sentences';
  if (/[\n*]|\*\*/.test(suggestion)) return 'has_formatting';

  if (
    /\bthanks\b|\bthank you\b|\blooks good\b|\bsounds good\b|\bthat works\b|\bthat worked\b|\bthat's all\b|\bnice\b|\bgreat\b|\bperfect\b|\bmakes sense\b|\bawesome\b|\bexcellent\b/.test(
      lower,
    )
  ) {
    return 'evaluative';
  }

  if (
    /^(let me|i'll|i've|i'm|i can|i would|i think|i notice|here's|here is|here are|that's|this is|this will|you can|you should|you could|sure,|of course|certainly)/i.test(
      suggestion,
    )
  ) {
    return 'ai_voice';
  }

  return null;
}

/**
 * Returns true if the suggestion should be filtered out.
 * Convenience wrapper around getFilterReason for tests and simple checks.
 */
export function shouldFilterSuggestion(suggestion: string): boolean {
  return getFilterReason(suggestion) !== null;
}
