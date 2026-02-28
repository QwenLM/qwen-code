/**
 * @license
 * Copyright 2026 Qmode
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IntentType, PromptAnalysis } from './types.js';

/**
 * Keywords that indicate specific intents
 */
const INTENT_KEYWORDS: Record<IntentType, string[]> = {
  'code-creation': [
    'create',
    'add',
    'implement',
    'build',
    'write',
    'make',
    'develop',
    'new',
    'feature',
    'function',
    'component',
    'module',
  ],
  'bug-fix': [
    'fix',
    'bug',
    'error',
    'issue',
    'problem',
    'broken',
    'fail',
    'crash',
    'exception',
    'not working',
  ],
  review: [
    'review',
    'check',
    'audit',
    'inspect',
    'examine',
    'feedback',
    'improve',
    'quality',
    'pr',
    'pull request',
  ],
  refactor: [
    'refactor',
    'restructure',
    'reorganize',
    'clean',
    'simplify',
    'optimize',
    'improve',
    'rewrite',
    'rename',
  ],
  ask: [
    'what',
    'how',
    'why',
    'when',
    'where',
    'explain',
    'tell me',
    'question',
    'understand',
    'learn',
  ],
  debug: [
    'debug',
    'trace',
    'investigate',
    'diagnose',
    'find',
    'locate',
    'source',
    'root cause',
  ],
  test: [
    'test',
    'spec',
    'unit test',
    'integration test',
    'e2e',
    'coverage',
    'assert',
    'mock',
  ],
  documentation: [
    'document',
    'doc',
    'readme',
    'comment',
    'describe',
    'explain',
    'guide',
    'tutorial',
    'api doc',
  ],
  unknown: [],
};

/**
 * Analyze a prompt to determine intent and quality
 */
export class PromptAnalyzer {
  /**
   * Analyze the given prompt
   */
  analyze(prompt: string): PromptAnalysis {
    const normalizedPrompt = prompt.toLowerCase().trim();

    const intent = this.detectIntent(normalizedPrompt);
    const confidence = this.calculateConfidence(normalizedPrompt, intent);
    const specificity = this.calculateSpecificity(normalizedPrompt);
    const hasContext = this.hasContextualInformation(normalizedPrompt);
    const hasConstraints = this.hasConstraints(normalizedPrompt);
    const hasSuccessCriteria = this.hasSuccessCriteria(normalizedPrompt);
    const gaps = this.identifyGaps(normalizedPrompt, intent);
    const suggestions = this.generateSuggestions(gaps, intent);

    return {
      intent,
      confidence,
      specificity,
      hasContext,
      hasConstraints,
      hasSuccessCriteria,
      gaps,
      suggestions,
    };
  }

  /**
   * Detect the intent of the prompt
   */
  private detectIntent(prompt: string): IntentType {
    const scores: Record<IntentType, number> = {
      'code-creation': 0,
      'bug-fix': 0,
      review: 0,
      refactor: 0,
      ask: 0,
      debug: 0,
      test: 0,
      documentation: 0,
      unknown: 0,
    };

    // Score each intent based on keyword matches
    for (const [intent, keywords] of Object.entries(INTENT_KEYWORDS)) {
      for (const keyword of keywords) {
        if (prompt.includes(keyword)) {
          scores[intent as IntentType] += 1;
        }
      }
    }

    // Find the intent with highest score
    let maxScore = 0;
    let detectedIntent: IntentType = 'unknown';

    for (const [intent, score] of Object.entries(scores)) {
      if (score > maxScore) {
        maxScore = score;
        detectedIntent = intent as IntentType;
      }
    }

    // If no clear intent, check for question patterns
    if (detectedIntent === 'unknown') {
      if (
        prompt.startsWith('?') ||
        prompt.match(/^(what|how|why|when|where)/)
      ) {
        detectedIntent = 'ask';
      } else if (prompt.length < 10) {
        detectedIntent = 'unknown';
      }
    }

    return detectedIntent;
  }

  /**
   * Calculate confidence in the detected intent
   */
  private calculateConfidence(prompt: string, intent: IntentType): number {
    if (intent === 'unknown') {
      return 0;
    }

    const keywords = INTENT_KEYWORDS[intent];
    let matchCount = 0;

    for (const keyword of keywords) {
      if (prompt.includes(keyword)) {
        matchCount += 1;
      }
    }

    // Base confidence on keyword matches
    const baseConfidence = Math.min(matchCount * 0.2, 0.8);

    // Boost confidence for longer, more detailed prompts
    const lengthBonus = Math.min(prompt.length / 200, 0.2);

    return Math.min(baseConfidence + lengthBonus, 1.0);
  }

  /**
   * Calculate specificity score (0-10)
   */
  private calculateSpecificity(prompt: string): number {
    let score = 0;

    // Check for file paths
    if (prompt.match(/[/\\][\w.-]+/)) {
      score += 2;
    }

    // Check for specific function/class names
    if (prompt.match(/[a-zA-Z][a-zA-Z0-9_]*\s*\(/)) {
      score += 1;
    }

    // Check for line numbers
    if (prompt.match(/line\s*\d+/i)) {
      score += 2;
    }

    // Check for specific technologies
    if (
      prompt.match(
        /\b(typescript|javascript|python|react|vue|angular|node|express|next\.js)\b/i,
      )
    ) {
      score += 1;
    }

    // Check for detailed descriptions (multiple sentences)
    const sentences = prompt.split(/[.!?]+/).filter((s) => s.trim().length > 0);
    if (sentences.length > 1) {
      score += 2;
    }

    // Check for examples or code snippets
    if (prompt.match(/```|`/)) {
      score += 2;
    }

    // Length bonus
    if (prompt.length > 50) {
      score += 1;
    }

    return Math.min(score, 10);
  }

  /**
   * Check if prompt has contextual information
   */
  private hasContextualInformation(prompt: string): boolean {
    const contextIndicators = [
      'in my',
      'the project',
      'we are using',
      'based on',
      'according to',
      'as you know',
      'previously',
      'earlier',
      'context',
      'background',
    ];

    return contextIndicators.some((indicator) => prompt.includes(indicator));
  }

  /**
   * Check if prompt has constraints
   */
  private hasConstraints(prompt: string): boolean {
    const constraintIndicators = [
      'must',
      'should',
      'cannot',
      'without',
      'except',
      'only',
      'require',
      'constraint',
      'limit',
      'performance',
      'memory',
      'time',
      'compatible',
    ];

    return constraintIndicators.some((indicator) => prompt.includes(indicator));
  }

  /**
   * Check if prompt has success criteria
   */
  private hasSuccessCriteria(prompt: string): boolean {
    const criteriaIndicators = [
      'should work',
      'must pass',
      'expected',
      'result',
      'output',
      'return',
      'when',
      'then',
      'so that',
      'in order to',
    ];

    return criteriaIndicators.some((indicator) => prompt.includes(indicator));
  }

  /**
   * Identify gaps in the prompt
   */
  private identifyGaps(prompt: string, intent: IntentType): string[] {
    const gaps: string[] = [];

    // Check for missing file paths
    if (
      intent === 'code-creation' ||
      intent === 'bug-fix' ||
      intent === 'refactor'
    ) {
      if (!prompt.match(/[/\\][\w.-]+/)) {
        gaps.push('No file paths specified');
      }
    }

    // Check for missing error details
    if (intent === 'bug-fix' || intent === 'debug') {
      if (!prompt.includes('error') && !prompt.includes('stack')) {
        gaps.push('No error message or stack trace provided');
      }
    }

    // Check for missing context
    if (!this.hasContextualInformation(prompt)) {
      gaps.push('No project context provided');
    }

    // Check for missing constraints
    if (!this.hasConstraints(prompt)) {
      gaps.push('No constraints or requirements specified');
    }

    // Check for missing success criteria
    if (!this.hasSuccessCriteria(prompt)) {
      gaps.push('No success criteria defined');
    }

    // Check for very short prompts
    if (prompt.length < 20) {
      gaps.push('Prompt is too brief');
    }

    return gaps;
  }

  /**
   * Generate suggestions for improvement
   */
  private generateSuggestions(gaps: string[], intent: IntentType): string[] {
    const suggestions: string[] = [];

    for (const gap of gaps) {
      switch (gap) {
        case 'No file paths specified':
          suggestions.push(
            'Specify the file path(s) where changes should be made',
          );
          break;
        case 'No error message or stack trace provided':
          suggestions.push(
            'Include the full error message and stack trace if available',
          );
          break;
        case 'No project context provided':
          suggestions.push(
            'Add context about your project (framework, dependencies, etc.)',
          );
          break;
        case 'No constraints or requirements specified':
          suggestions.push(
            'Specify any constraints (performance, compatibility, etc.)',
          );
          break;
        case 'No success criteria defined':
          suggestions.push(
            'Define what "done" looks like - how will you know it works?',
          );
          break;
        case 'Prompt is too brief':
          suggestions.push(
            'Provide more details about what you want to accomplish',
          );
          break;
        default:
          suggestions.push(`Consider adding more details about: ${gap}`);
      }
    }

    // Add intent-specific suggestions
    if (intent === 'code-creation') {
      suggestions.push('Consider mentioning existing patterns to follow');
    } else if (intent === 'bug-fix') {
      suggestions.push('Describe steps to reproduce the issue');
    } else if (intent === 'review') {
      suggestions.push(
        'Specify what aspects to focus on (performance, security, etc.)',
      );
    }

    return suggestions;
  }
}
