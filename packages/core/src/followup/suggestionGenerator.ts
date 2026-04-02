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
import type { ContentGenerator } from '../core/contentGenerator.js';
import { AuthType, createContentGenerator } from '../core/contentGenerator.js';
import { buildAgentContentGeneratorConfig } from '../models/content-generator-config.js';
import { getCacheSafeParams, runForkedQuery } from './forkedQuery.js';
import {
  uiTelemetryService,
  EVENT_API_RESPONSE,
} from '../telemetry/uiTelemetry.js';
import { ApiResponseEvent } from '../telemetry/types.js';

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
 * Cache of fast-model ContentGenerators, keyed by model ID.
 * Avoids re-creating the generator on every suggestion request.
 */
const fastGeneratorCache = new Map<string, ContentGenerator>();

/**
 * Get or create a ContentGenerator for the given fast model.
 *
 * For OpenAI-compatible providers, the pipeline ignores `request.model` and
 * always uses the model baked into the ContentGenerator at construction time.
 * So if `fastModel` points to a different model/baseUrl than the main model,
 * we must create a dedicated ContentGenerator for it.
 *
 * Returns null if the model is the same as the main model (no need for a
 * separate generator) or if creation fails.
 *
 * @param config - App config
 * @param fastModelId - The fast model ID from settings (e.g., "glm-4.7")
 */
async function getOrCreateFastGenerator(
  config: Config,
  fastModelId: string,
): Promise<ContentGenerator | null> {
  // If fast model is the same as main model, no dedicated generator needed
  if (fastModelId === config.getModel()) {
    return null;
  }

  const cached = fastGeneratorCache.get(fastModelId);
  if (cached) {
    return cached;
  }

  try {
    const parentAuthType = config.getContentGeneratorConfig().authType;
    const cgConfig = buildAgentContentGeneratorConfig(config, fastModelId, {
      authType: parentAuthType ?? AuthType.USE_OPENAI,
    });
    // Disable thinking/reasoning for the fast suggestion generator:
    // - glm-4.7 uses extra_body.thinking.enabled
    // - qwen3 series uses extra_body.enable_thinking
    // - other providers use the reasoning field
    // Setting all of these ensures the model returns a plain text response
    // immediately, without a thinking phase that can result in empty content parts.
    cgConfig.reasoning = false;
    cgConfig.extra_body = {
      ...cgConfig.extra_body,
      thinking: { enabled: false },
      enable_thinking: false,
    };
    const generator = await createContentGenerator(cgConfig, config);
    fastGeneratorCache.set(fastModelId, generator);
    return generator;
  } catch {
    return null;
  }
}

/**
 * Generate a prompt suggestion using an LLM call.
 *
 * @param config - App config (provides ContentGenerator and model)
 * @param conversationHistory - Full conversation history as Content[]
 * @param abortSignal - Signal to cancel the LLM call (e.g., when user types)
 * @param options.enableCacheSharing - Use cache-aware forked query path
 * @param options.model - Fast model ID override (e.g., "glm-4.7")
 * @returns Object with suggestion text and optional filter reason, or null on error/early skip
 */
export async function generatePromptSuggestion(
  config: Config,
  conversationHistory: Content[],
  abortSignal: AbortSignal,
  options?: { enableCacheSharing?: boolean; model?: string },
): Promise<{ suggestion: string | null; filterReason?: string }> {
  // Don't suggest in very early conversations
  const modelTurns = conversationHistory.filter(
    (c) => c.role === 'model',
  ).length;
  if (modelTurns < MIN_ASSISTANT_TURNS) {
    return { suggestion: null, filterReason: 'early_conversation' };
  }

  // Resolve the fast generator if a different model is configured
  const fastModelId = options?.model;
  const fastGenerator = fastModelId
    ? await getOrCreateFastGenerator(config, fastModelId)
    : null;
  const effectiveModelId = fastModelId ?? config.getModel();

  try {
    // Try cache-aware forked query if enabled and params available
    const cacheSafe = options?.enableCacheSharing ? getCacheSafeParams() : null;

    let raw: string | null = null;

    if (cacheSafe) {
      raw = await generateViaForkedQuery(config, abortSignal, effectiveModelId);
    } else {
      raw = await generateViaBaseLlm(
        config,
        conversationHistory,
        abortSignal,
        effectiveModelId,
        fastGenerator ?? undefined,
      );

      // Fallback: if the fast generator returned empty (some endpoints return
      // candidatesLen=0 for certain requests), retry with the main generator.
      if (raw === null && fastGenerator) {
        raw = await generateViaBaseLlm(
          config,
          conversationHistory,
          abortSignal,
          config.getModel(),
          undefined, // use main generator
        );
      }
    }

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
  model: string,
): Promise<string | null> {
  const startTime = Date.now();
  const result = await runForkedQuery(config, SUGGESTION_PROMPT, {
    abortSignal,
    jsonSchema: SUGGESTION_SCHEMA,
    model,
  });
  const durationMs = Date.now() - startTime;

  // Report usage to session stats
  if (result.usage) {
    reportSuggestionUsage(
      model,
      {
        promptTokenCount: result.usage.inputTokens,
        candidatesTokenCount: result.usage.outputTokens,
        totalTokenCount: result.usage.inputTokens + result.usage.outputTokens,
        cachedContentTokenCount: result.usage.cacheHitTokens,
      },
      durationMs,
    );
  }

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

/**
 * Generate via direct ContentGenerator.generateContent.
 *
 * @param config - App config (used as fallback generator source)
 * @param conversationHistory - Conversation history to include in request
 * @param abortSignal - Abort signal
 * @param model - Effective model ID to pass in the request
 * @param generator - Optional dedicated ContentGenerator (e.g., for fastModel with different baseUrl).
 *   When provided, this generator is used instead of config.getContentGenerator(), which allows
 *   OpenAI-compatible providers to use the correct model/baseUrl instead of the main model.
 */
async function generateViaBaseLlm(
  config: Config,
  conversationHistory: Content[],
  abortSignal: AbortSignal,
  model: string,
  generator?: ContentGenerator,
): Promise<string | null> {
  const resolvedGenerator = generator ?? config.getContentGenerator();

  // When using a dedicated fast generator (different model/provider), strip the
  // conversation history down to plain text only.  Fast / lite models typically
  // cannot handle function-call, function-response, or inline-data parts that
  // the main model produced and will return an empty response (candidates: []).
  const simplifiedHistory = generator
    ? simplifyHistoryForFastModel(conversationHistory)
    : conversationHistory;

  const contents: Content[] = [
    ...simplifiedHistory,
    { role: 'user', parts: [{ text: SUGGESTION_PROMPT }] },
  ];

  const startTime = Date.now();

  // Use streaming API (generateContentStream) instead of non-streaming
  // (generateContent). Some OpenAI-compatible endpoints (e.g., BFF proxies)
  // only support streaming and return empty choices for non-streaming requests.
  const stream = await resolvedGenerator.generateContentStream(
    {
      model,
      contents,
      config: { abortSignal },
    },
    'prompt_suggestion',
  );

  // Collect the full streamed response
  const allParts: Array<{ text?: string; thought?: boolean }> = [];
  let usageMetadata:
    | {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
        totalTokenCount?: number;
        cachedContentTokenCount?: number;
        thoughtsTokenCount?: number;
      }
    | undefined;

  for await (const chunk of stream) {
    const candidate = chunk.candidates?.[0];
    if (candidate?.content?.parts) {
      for (const part of candidate.content.parts) {
        allParts.push(part as { text?: string; thought?: boolean });
      }
    }
    if (chunk.usageMetadata) {
      usageMetadata = chunk.usageMetadata;
    }
  }
  const durationMs = Date.now() - startTime;

  // Report usage to session stats so /stats tracks suggestion model tokens
  if (usageMetadata) {
    reportSuggestionUsage(model, usageMetadata, durationMs);
  }

  const thoughtParts = allParts.filter((p) => 'thought' in p && p.thought);
  const textParts = allParts.filter((p) => !('thought' in p && p.thought));

  // Extract text from non-thought parts first
  const text = textParts
    .map((p) => p.text ?? '')
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

  // Fallback: if the model put its answer entirely in thought parts (common
  // with glm-5 style reasoning models), extract text from thought parts.
  // This handles the case where the model wraps its entire response in thinking.
  if (thoughtParts.length > 0) {
    const thoughtText = thoughtParts
      .map((p) => p.text ?? '')
      .join('')
      .trim();
    if (thoughtText) {
      try {
        const parsed = JSON.parse(thoughtText) as Record<string, unknown>;
        const s = parsed['suggestion'];
        if (typeof s === 'string') return s;
      } catch {
        // Not JSON — use raw thought text
      }
      return thoughtText;
    }
  }

  return null;
}

/**
 * Simplify conversation history for fast/lite models that cannot handle
 * complex parts like function calls, function responses, or inline data.
 *
 * Extracts only the text content from each turn, preserving the user/model
 * alternation that the API expects. Turns that become empty after stripping
 * non-text parts are dropped. Consecutive same-role entries are merged to
 * maintain strict alternation.
 *
 * @param history - Full conversation history with potentially complex parts
 * @returns Simplified history containing only plain text parts
 */
function simplifyHistoryForFastModel(history: Content[]): Content[] {
  const result: Content[] = [];

  for (const entry of history) {
    const textParts = (entry.parts ?? [])
      .filter((p) => 'text' in p && typeof p.text === 'string' && p.text.trim())
      .map((p) => ({ text: (p as { text: string }).text }));

    if (textParts.length === 0) {
      continue;
    }

    const last = result[result.length - 1];
    if (last && last.role === entry.role) {
      // Merge into the previous entry to maintain strict alternation
      last.parts = [...(last.parts ?? []), ...textParts];
    } else {
      result.push({ role: entry.role, parts: textParts });
    }
  }

  return result;
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

/**
 * Report suggestion API usage to the UI telemetry service so it appears in /stats.
 */
function reportSuggestionUsage(
  model: string,
  usage: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
    cachedContentTokenCount?: number;
    thoughtsTokenCount?: number;
  },
  durationMs: number,
): void {
  const event = new ApiResponseEvent(
    'suggestion-' + Date.now(),
    model,
    durationMs,
    'prompt_suggestion',
    undefined,
    {
      promptTokenCount: usage.promptTokenCount ?? 0,
      candidatesTokenCount: usage.candidatesTokenCount ?? 0,
      totalTokenCount: usage.totalTokenCount ?? 0,
      cachedContentTokenCount: usage.cachedContentTokenCount ?? 0,
      thoughtsTokenCount: usage.thoughtsTokenCount ?? 0,
    },
  );
  // Override event.name to match UiEvent type (UiTelemetryService switch)
  const uiEvent = Object.assign(event, {
    'event.name': EVENT_API_RESPONSE as typeof EVENT_API_RESPONSE,
  });
  uiTelemetryService.addEvent(uiEvent);
}
