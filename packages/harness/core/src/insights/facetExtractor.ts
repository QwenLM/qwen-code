/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { systemPromptFromText } from '../prompts/system-prompt.js';
import type { Config } from '../config/config.js';
import { TranscriptRepository } from '../services/transcript/repository.js';
import {
  isHiddenUserMessageInDefaultHistory,
  getDisplayableUserText,
} from '../protocol/transcript/message-utils.js';
import type { UserMessage } from '../protocol/transcript/message.js';
import { generateInsight } from './modelRequest.js';
import { readCache, writeCache, isCacheFresh } from './cache.js';
import type { SessionMeta, SessionFacets } from './types.js';
import { runLogger } from '../utils/runLogger.js';

const MAX_MESSAGES_FOR_EXTRACTION = 10;
const MAX_CONTENT_LENGTH = 4000;

const FACETS_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    topics: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Main topics discussed (e.g., refactoring, testing, deployment)',
    },
    languages: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Programming languages mentioned or used (e.g., typescript, python)',
    },
    intents: {
      type: 'array',
      items: { type: 'string' },
      description:
        'User intents (e.g., debug, explain, generate, review, refactor)',
    },
    entities: {
      type: 'array',
      items: { type: 'string' },
      description: 'Key entities: file names, libraries, APIs mentioned',
    },
    sentiment: {
      type: 'string',
      enum: ['positive', 'neutral', 'negative'],
      description: 'Overall sentiment of the conversation',
    },
    complexityEstimate: {
      type: 'string',
      enum: ['low', 'medium', 'high'],
      description: 'Estimated complexity of the tasks discussed',
    },
  },
  required: [
    'topics',
    'languages',
    'intents',
    'entities',
    'sentiment',
    'complexityEstimate',
  ],
};

const SYSTEM_PROMPT = `You are an expert at analyzing coding conversations. Given the following user messages from a coding assistant session, extract structured semantic facets.

Rules:
- Keep each list short (3-8 items max).
- Normalize language names to lowercase (e.g., "TypeScript" → "typescript").
- Normalize topics and intents to lowercase single words or short phrases.
- Be specific about entities (actual file names, library names, API endpoints mentioned).
- Assess sentiment based on the user's tone (frustration = negative, gratitude = positive, neutral otherwise).
- Estimate complexity: simple questions/fixes = low, multi-step tasks = medium, architectural/design work = high.`;

/**
 * Extracts semantic facets from a session using AI.
 * Results are cached per session ID; cache is invalidated when the transcript file changes.
 */
export async function extractFacets(
  session: SessionMeta,
  config: Config,
  abortSignal: AbortSignal,
): Promise<SessionFacets> {
  const cacheKey = session.id;

  // Check cache
  const cacheFresh = await isCacheFresh(
    'facets',
    cacheKey,
    session.lastUpdated,
  );
  if (cacheFresh) {
    const cached = await readCache<SessionFacets>('facets', cacheKey);
    if (cached) {
      return cached;
    }
  }

  // Cache miss — load transcript content
  const content = await loadSessionContent(session.filePath);
  if (!content) {
    // Return default facets for empty sessions
    const defaultFacets: SessionFacets = {
      sessionId: session.id,
      topics: [],
      languages: [],
      intents: [],
      entities: [],
      sentiment: 'neutral',
      complexityEstimate: 'low',
    };
    await writeCache('facets', cacheKey, defaultFacets);
    return defaultFacets;
  }

  try {
    const result = await generateInsight(config, {
      sessionId: session.id,
      messages: [
        {
          role: 'user',
          content: `Analyze this coding session and extract facets:\n\n${content}`,
        },
      ],
      schema: FACETS_SCHEMA,
      systemPrompt: systemPromptFromText(SYSTEM_PROMPT),
      abortSignal,
      promptId: 'insights-extract-facets',
    });

    const facets: SessionFacets = {
      sessionId: session.id,
      topics: asStringArray(result['topics']),
      languages: asStringArray(result['languages']).map((l) => l.toLowerCase()),
      intents: asStringArray(result['intents']).map((i) => i.toLowerCase()),
      entities: asStringArray(result['entities']),
      sentiment: asSentiment(result['sentiment']),
      complexityEstimate: asComplexity(result['complexityEstimate']),
    };

    await writeCache('facets', cacheKey, facets);
    return facets;
  } catch (err) {
    runLogger.debug(
      `[insights/facetExtractor] Failed to extract facets for session "${session.id}": ${err instanceof Error ? err.message : String(err)}`,
    );

    // Return default facets on failure rather than breaking the pipeline
    const fallbackFacets: SessionFacets = {
      sessionId: session.id,
      topics: [],
      languages: [],
      intents: [],
      entities: [],
      sentiment: 'neutral',
      complexityEstimate: 'low',
    };
    return fallbackFacets;
  }
}

async function loadSessionContent(filePath: string): Promise<string | null> {
  try {
    const loadResult = await new TranscriptRepository().resolveSession(
      filePath,
    );
    const messages = [...(loadResult?.messages ?? [])];

    const userMessages = messages
      .filter((m): m is UserMessage => m.type === 'user')
      .filter(
        (m) =>
          !isHiddenUserMessageInDefaultHistory(m) &&
          m.isCompactSummary !== true,
      );

    const selected = userMessages.slice(0, MAX_MESSAGES_FOR_EXTRACTION);
    const texts: string[] = [];
    let totalLength = 0;

    for (const msg of selected) {
      const text = getDisplayableUserText(msg);
      if (text && text.trim()) {
        const remaining = MAX_CONTENT_LENGTH - totalLength;
        if (remaining <= 0) break;
        const truncated = text.slice(0, remaining);
        texts.push(truncated);
        totalLength += truncated.length;
      }
    }

    return texts.length > 0 ? texts.join('\n---\n') : null;
  } catch {
    return null;
  }
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string');
  }
  return [];
}

function asSentiment(value: unknown): 'positive' | 'neutral' | 'negative' {
  if (value === 'positive' || value === 'neutral' || value === 'negative') {
    return value;
  }
  return 'neutral';
}

function asComplexity(value: unknown): 'low' | 'medium' | 'high' {
  if (value === 'low' || value === 'medium' || value === 'high') {
    return value;
  }
  return 'low';
}
