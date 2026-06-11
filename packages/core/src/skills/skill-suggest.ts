/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SkillConfig } from './types.js';

const STOPWORDS = new Set([
  'a',
  'an',
  'the',
  'and',
  'or',
  'but',
  'in',
  'on',
  'at',
  'to',
  'for',
  'of',
  'with',
  'by',
  'from',
  'is',
  'are',
  'was',
  'be',
  'as',
  'it',
  'its',
  'this',
  'that',
  'i',
  'my',
  'me',
  'we',
  'you',
  'can',
  'do',
  'not',
  'have',
  'has',
  'just',
  'will',
  'get',
  'set',
  'use',
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

/**
 * Score how well a skill's metadata matches a user prompt.
 * Returns a value in [0, 1] — higher is a stronger match.
 *
 * Strategy: keyword overlap between the prompt and the skill's name,
 * description, and whenToUse fields. Intentionally simple — no
 * stemming, no TF-IDF — so it runs synchronously in O(n) with no deps.
 */
export function scoreSkillRelevance(
  userPrompt: string,
  skill: SkillConfig,
): number {
  const needleTokens = tokenize(userPrompt);
  if (needleTokens.length === 0) return 0;

  const haystack = [
    skill.name.replace(/[-_.]/g, ' '),
    skill.description,
    skill.whenToUse ?? '',
  ]
    .join(' ')
    .toLowerCase();

  let hits = 0;
  for (const token of needleTokens) {
    if (haystack.includes(token)) hits++;
  }
  return hits / needleTokens.length;
}

/**
 * Return skills whose metadata overlaps with the user prompt, sorted by
 * descending relevance score. Only skills above \`threshold\` are returned.
 *
 * Designed to be called synchronously before message dispatch — keep it
 * fast: no awaits, no filesystem access.
 */
export function suggestSkills(
  userPrompt: string,
  skills: SkillConfig[],
  threshold = 0.25,
): SkillConfig[] {
  return skills
    .map((s) => ({ skill: s, score: scoreSkillRelevance(userPrompt, s) }))
    .filter(({ score }) => score >= threshold)
    .sort((a, b) => b.score - a.score)
    .map(({ skill }) => skill);
}
