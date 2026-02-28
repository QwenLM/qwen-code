/**
 * @license
 * Copyright 2026 Qmode
 * SPDX-License-Identifier: Apache-2.0
 */

import type { QualityScores } from './types.js';

/**
 * Weights for different quality dimensions
 */
const QUALITY_WEIGHTS = {
  clarity: 0.25,
  completeness: 0.25,
  actionability: 0.25,
  contextRichness: 0.25,
};

/**
 * Scores the quality of a prompt
 */
export class QualityScorer {
  /**
   * Score a prompt's quality
   */
  score(prompt: string): QualityScores {
    return {
      clarity: this.scoreClarity(prompt),
      completeness: this.scoreCompleteness(prompt),
      actionability: this.scoreActionability(prompt),
      contextRichness: this.scoreContextRichness(prompt),
      overall: 0, // Will be calculated
    };
  }

  /**
   * Calculate overall score from individual scores
   */
  calculateOverall(scores: QualityScores): number {
    const overall =
      scores.clarity * QUALITY_WEIGHTS.clarity +
      scores.completeness * QUALITY_WEIGHTS.completeness +
      scores.actionability * QUALITY_WEIGHTS.actionability +
      scores.contextRichness * QUALITY_WEIGHTS.contextRichness;

    return Math.round(overall * 100) / 100;
  }

  /**
   * Score clarity (0-10)
   * How clear and understandable is the request?
   */
  private scoreClarity(prompt: string): number {
    let score = 10;

    const lowerPrompt = prompt.toLowerCase();

    // Penalize for vague words
    const vagueWords = [
      'something',
      'stuff',
      'thing',
      'whatever',
      'anything',
      'maybe',
      'probably',
    ];
    for (const word of vagueWords) {
      if (lowerPrompt.includes(word)) {
        score -= 1;
      }
    }

    // Penalize for very short prompts
    if (prompt.length < 10) {
      score -= 3;
    } else if (prompt.length < 20) {
      score -= 2;
    } else if (prompt.length < 50) {
      score -= 1;
    }

    // Bonus for having punctuation (indicates thought)
    if (prompt.includes('.') || prompt.includes('?') || prompt.includes('!')) {
      score += 0.5;
    }

    // Penalize for all caps (might indicate frustration, not clarity)
    if (prompt === prompt.toUpperCase() && prompt.length > 10) {
      score -= 1;
    }

    // Bonus for multiple sentences
    const sentences = prompt.split(/[.!?]+/).filter((s) => s.trim().length > 0);
    if (sentences.length > 1) {
      score += 0.5;
    }

    return Math.max(0, Math.min(10, score));
  }

  /**
   * Score completeness (0-10)
   * Does the prompt have all necessary information?
   */
  private scoreCompleteness(prompt: string): number {
    let score = 5; // Start with base score

    const lowerPrompt = prompt.toLowerCase();

    // Check for context indicators
    const contextIndicators = [
      'in my',
      'the project',
      'we are',
      'using',
      'based on',
      'currently',
    ];
    if (contextIndicators.some((ind) => lowerPrompt.includes(ind))) {
      score += 1.5;
    }

    // Check for constraints
    const constraintIndicators = [
      'must',
      'should',
      'cannot',
      'without',
      'only',
      'require',
    ];
    if (constraintIndicators.some((ind) => lowerPrompt.includes(ind))) {
      score += 1.5;
    }

    // Check for success criteria
    const criteriaIndicators = [
      'should work',
      'expected',
      'result',
      'output',
      'return',
      'when',
      'then',
    ];
    if (criteriaIndicators.some((ind) => lowerPrompt.includes(ind))) {
      score += 1.5;
    }

    // Check for examples or code
    if (prompt.includes('```') || prompt.includes('`')) {
      score += 1.5;
    }

    // Check for file paths
    if (prompt.match(/[/\\][\w.-]+/)) {
      score += 1;
    }

    // Check for error messages
    if (lowerPrompt.includes('error') || lowerPrompt.includes('exception')) {
      score += 1;
    }

    return Math.max(0, Math.min(10, score));
  }

  /**
   * Score actionability (0-10)
   * Can the AI take action based on this prompt?
   */
  private scoreActionability(prompt: string): number {
    let score = 5; // Start with base score

    const lowerPrompt = prompt.toLowerCase();

    // Check for action verbs
    const actionVerbs = [
      'create',
      'fix',
      'add',
      'remove',
      'update',
      'change',
      'implement',
      'write',
      'build',
      'test',
      'review',
      'explain',
      'help',
    ];

    let verbCount = 0;
    for (const verb of actionVerbs) {
      if (lowerPrompt.includes(verb)) {
        verbCount++;
      }
    }

    if (verbCount >= 2) {
      score += 3;
    } else if (verbCount === 1) {
      score += 2;
    }

    // Check for specific target
    if (
      lowerPrompt.includes('function') ||
      lowerPrompt.includes('component') ||
      lowerPrompt.includes('file') ||
      lowerPrompt.includes('module') ||
      lowerPrompt.includes('class') ||
      lowerPrompt.includes('api')
    ) {
      score += 2;
    }

    // Check for clear intent
    const intentPatterns = [
      /i want to/i,
      /i need to/i,
      /can you/i,
      /please/i,
      /how to/i,
      /what is/i,
    ];
    if (intentPatterns.some((pattern) => pattern.test(prompt))) {
      score += 1;
    }

    return Math.max(0, Math.min(10, score));
  }

  /**
   * Score context richness (0-10)
   * How much relevant context is provided?
   */
  private scoreContextRichness(prompt: string): number {
    let score = 3; // Start with low base score

    // Check for technical details
    const technicalIndicators = [
      'typescript',
      'javascript',
      'react',
      'node',
      'api',
      'database',
      'function',
      'component',
      'module',
      'interface',
      'type',
    ];

    let techCount = 0;
    const lowerPrompt = prompt.toLowerCase();
    for (const indicator of technicalIndicators) {
      if (lowerPrompt.includes(indicator)) {
        techCount++;
      }
    }

    score += Math.min(techCount * 0.5, 3);

    // Check for project-specific context
    const projectContext = [
      'our codebase',
      'this project',
      'the app',
      'the system',
      'existing',
      'current',
    ];
    if (projectContext.some((ctx) => lowerPrompt.includes(ctx))) {
      score += 1.5;
    }

    // Check for references to other files/code
    if (prompt.match(/[A-Z][a-zA-Z]+/)) {
      score += 1; // Likely references to classes/components
    }

    // Check for version/dependency info
    if (prompt.match(/v\d+|version|@[\d.]+/)) {
      score += 1.5;
    }

    // Check for environment info
    if (
      lowerPrompt.includes('browser') ||
      lowerPrompt.includes('server') ||
      lowerPrompt.includes('local') ||
      lowerPrompt.includes('production') ||
      lowerPrompt.includes('development')
    ) {
      score += 1;
    }

    return Math.max(0, Math.min(10, score));
  }

  /**
   * Compare before and after scores
   */
  compareScores(
    before: QualityScores,
    after: QualityScores,
  ): {
    improvement: number;
    improvements: string[];
  } {
    const beforeOverall = this.calculateOverall(before);
    const afterOverall = this.calculateOverall(after);
    const improvement = afterOverall - beforeOverall;

    const improvements: string[] = [];

    if (after.clarity > before.clarity) {
      improvements.push(
        `Clarity: +${(after.clarity - before.clarity).toFixed(1)}`,
      );
    }
    if (after.completeness > before.completeness) {
      improvements.push(
        `Completeness: +${(after.completeness - before.completeness).toFixed(1)}`,
      );
    }
    if (after.actionability > before.actionability) {
      improvements.push(
        `Actionability: +${(after.actionability - before.actionability).toFixed(1)}`,
      );
    }
    if (after.contextRichness > before.contextRichness) {
      improvements.push(
        `Context: +${(after.contextRichness - before.contextRichness).toFixed(1)}`,
      );
    }

    return {
      improvement: Math.round(improvement * 100) / 100,
      improvements,
    };
  }
}
