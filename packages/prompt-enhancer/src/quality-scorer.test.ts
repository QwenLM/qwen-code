/**
 * @license
 * Copyright 2026 Qmode
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { QualityScorer } from './quality-scorer.js';

describe('QualityScorer', () => {
  const scorer = new QualityScorer();

  describe('score', () => {
    it('should return scores for all dimensions', () => {
      const scores = scorer.score('Create a function');
      expect(scores).toHaveProperty('clarity');
      expect(scores).toHaveProperty('completeness');
      expect(scores).toHaveProperty('actionability');
      expect(scores).toHaveProperty('contextRichness');
    });

    it('should give low scores for vague prompts', () => {
      const scores = scorer.score('stuff');
      expect(scores.overall).toBeLessThan(5);
    });

    it('should give higher scores for detailed prompts', () => {
      const scores = scorer.score(
        'Create a TypeScript function that validates email addresses using regex. ' +
          'It should return true for valid emails and false otherwise. ' +
          'Follow our project conventions in /src/utils.',
      );
      expect(scores.overall).toBeGreaterThan(5);
    });
  });

  describe('clarity scoring', () => {
    it('should penalize vague words', () => {
      const scores = scorer.score('Fix something stuff');
      expect(scores.clarity).toBeLessThan(7);
    });

    it('should penalize very short prompts', () => {
      const scores = scorer.score('fix');
      expect(scores.clarity).toBeLessThan(5);
    });

    it('should give bonus for punctuation', () => {
      const scores = scorer.score('Create a function. It should work.');
      expect(scores.clarity).toBeGreaterThan(5);
    });
  });

  describe('completeness scoring', () => {
    it('should reward context indicators', () => {
      const scores = scorer.score('In my project, we are using React');
      expect(scores.completeness).toBeGreaterThan(5);
    });

    it('should reward constraints', () => {
      const scores = scorer.score(
        'Create function without using external libraries',
      );
      expect(scores.completeness).toBeGreaterThan(5);
    });

    it('should reward code snippets', () => {
      const scores = scorer.score('Fix this: ```typescript\ncode\n```');
      expect(scores.completeness).toBeGreaterThan(6);
    });
  });

  describe('actionability scoring', () => {
    it('should reward action verbs', () => {
      const scores = scorer.score('Create and implement a function');
      expect(scores.actionability).toBeGreaterThan(6);
    });

    it('should reward specific targets', () => {
      const scores = scorer.score('Create a component with props');
      expect(scores.actionability).toBeGreaterThan(5);
    });
  });

  describe('context richness scoring', () => {
    it('should reward technical details', () => {
      const scores = scorer.score(
        'Create TypeScript React component with API integration',
      );
      expect(scores.contextRichness).toBeGreaterThan(5);
    });

    it('should reward project context', () => {
      const scores = scorer.score(
        'In our codebase, the current implementation uses',
      );
      expect(scores.contextRichness).toBeGreaterThan(5);
    });
  });

  describe('calculateOverall', () => {
    it('should calculate weighted average', () => {
      const scores = {
        clarity: 8,
        completeness: 6,
        actionability: 7,
        contextRichness: 5,
        overall: 0,
      };
      const overall = scorer.calculateOverall(scores);
      expect(overall).toBeGreaterThan(0);
      expect(overall).toBeLessThanOrEqual(10);
    });
  });

  describe('compareScores', () => {
    it('should calculate improvement', () => {
      const before = {
        clarity: 5,
        completeness: 4,
        actionability: 5,
        contextRichness: 3,
        overall: 4.25,
      };
      const after = {
        clarity: 8,
        completeness: 7,
        actionability: 8,
        contextRichness: 6,
        overall: 7.25,
      };

      const comparison = scorer.compareScores(before, after);
      expect(comparison.improvement).toBeGreaterThan(0);
      expect(comparison.improvements.length).toBeGreaterThan(0);
    });
  });
});
