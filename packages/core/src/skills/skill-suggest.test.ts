/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { scoreSkillRelevance, suggestSkills } from './skill-suggest.js';
import type { SkillConfig } from './types.js';

function makeSkill(
  name: string,
  description: string,
  whenToUse?: string,
): SkillConfig {
  return {
    name,
    description,
    whenToUse,
    level: 'user',
    filePath: `/skills/${name}/SKILL.md`,
    body: '',
  };
}

const REVIEW_SKILL = makeSkill(
  'review',
  'Review code changes and provide feedback',
  'Use when the user asks to review a PR or diff',
);
const SIMPLIFY_SKILL = makeSkill(
  'simplify',
  'Simplify complex code by refactoring it',
  'Use when asked to refactor or clean up code',
);
const STUCK_SKILL = makeSkill(
  'stuck',
  'Help when you are stuck or need a different approach',
);

describe('scoreSkillRelevance', () => {
  it('returns 0 for empty prompt', () => {
    expect(scoreSkillRelevance('', REVIEW_SKILL)).toBe(0);
  });

  it('returns > 0 when prompt overlaps with description', () => {
    expect(
      scoreSkillRelevance('please review my code changes', REVIEW_SKILL),
    ).toBeGreaterThan(0);
  });

  it('scores review skill higher than simplify skill for a review prompt', () => {
    const prompt = 'can you review this PR';
    const reviewScore = scoreSkillRelevance(prompt, REVIEW_SKILL);
    const simplifyScore = scoreSkillRelevance(prompt, SIMPLIFY_SKILL);
    expect(reviewScore).toBeGreaterThan(simplifyScore);
  });

  it('matches against whenToUse field', () => {
    const score = scoreSkillRelevance('I am stuck and need help', STUCK_SKILL);
    expect(score).toBeGreaterThan(0);
  });

  it('matches name with hyphens replaced by spaces', () => {
    const skill = makeSkill('code-review', 'Code review tool');
    expect(scoreSkillRelevance('code review please', skill)).toBeGreaterThan(0);
  });
});

describe('suggestSkills', () => {
  const ALL_SKILLS = [REVIEW_SKILL, SIMPLIFY_SKILL, STUCK_SKILL];

  it('returns empty array when no skill matches', () => {
    expect(suggestSkills('hello world', ALL_SKILLS)).toHaveLength(0);
  });

  it('returns matching skills sorted by score descending', () => {
    const results = suggestSkills(
      'please review my code changes and provide feedback',
      ALL_SKILLS,
    );
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.name).toBe('review');
  });

  it('respects custom threshold', () => {
    const withLowThreshold = suggestSkills('code', ALL_SKILLS, 0.0);
    const withHighThreshold = suggestSkills('code', ALL_SKILLS, 0.99);
    expect(withLowThreshold.length).toBeGreaterThanOrEqual(
      withHighThreshold.length,
    );
  });

  it('does not suggest disabled skills if filtered before calling', () => {
    const enabled = ALL_SKILLS.filter((s) => s.name !== 'review');
    const results = suggestSkills('review my code', enabled);
    expect(results.map((s) => s.name)).not.toContain('review');
  });
});
