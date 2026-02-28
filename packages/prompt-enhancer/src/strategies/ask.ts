/**
 * @license
 * Copyright 2026 Qmode
 * SPDX-License-Identifier: Apache-2.0
 */

import { BaseStrategy } from './base.js';
import type {
  IntentType,
  PromptAnalysis,
  ProjectContext,
  PromptEnhancerOptions,
} from '../types.js';
import { ASK_TEMPLATE } from '../templates/index.js';

/**
 * Strategy for enhancing Q&A prompts
 */
export class AskStrategy extends BaseStrategy {
  readonly intent: IntentType = 'ask';

  async enhance(
    prompt: string,
    analysis: PromptAnalysis,
    context: ProjectContext,
    options: PromptEnhancerOptions,
  ): Promise<string> {
    const defaultValues = this.getDefaultValues(context, options);

    const values = {
      ...defaultValues,
      task: prompt,
      topic: this.extractTopic(prompt),
      priorKnowledge: this.inferPriorKnowledge(prompt),
      attemptedSolutions: 'Not specified',
      specificQuestion: this.formulateSpecificQuestion(prompt),
    };

    return this.fillTemplate(ASK_TEMPLATE.template, values);
  }

  /**
   * Extract the main topic from the question
   */
  private extractTopic(prompt: string): string {
    const lowerPrompt = prompt.toLowerCase();

    // Look for common topic indicators
    const topics: Record<string, string[]> = {
      TypeScript: ['typescript', 'type', 'interface', 'generic'],
      React: ['react', 'component', 'hook', 'jsx'],
      'Node.js': ['node', 'server', 'express', 'api'],
      Testing: ['test', 'mock', 'jest', 'vitest'],
      Debugging: ['debug', 'error', 'issue', 'problem'],
      Architecture: ['architecture', 'pattern', 'design', 'structure'],
      Performance: ['performance', 'optimize', 'fast', 'slow'],
    };

    for (const [topic, keywords] of Object.entries(topics)) {
      if (keywords.some((keyword) => lowerPrompt.includes(keyword))) {
        return topic;
      }
    }

    return 'General development';
  }

  /**
   * Infer user's prior knowledge from the question
   */
  private inferPriorKnowledge(prompt: string): string {
    const lowerPrompt = prompt.toLowerCase();

    // Check for indicators of knowledge level
    if (lowerPrompt.includes('beginner') || lowerPrompt.includes('new to')) {
      return 'Beginner level';
    }
    if (lowerPrompt.includes('advanced') || lowerPrompt.includes('expert')) {
      return 'Advanced level';
    }

    // Check for specific knowledge indicators
    if (prompt.includes('I understand') || prompt.includes('I know')) {
      return 'Some background knowledge';
    }

    if (prompt.includes('?') && prompt.split(' ').length > 10) {
      return 'Intermediate - asking specific question';
    }

    return 'Not specified';
  }

  /**
   * Formulate the specific question
   */
  private formulateSpecificQuestion(prompt: string): string {
    // If it's already a question, extract it
    if (prompt.includes('?')) {
      const questionMatch = prompt.match(/([A-Z][^?]+\?)/);
      if (questionMatch) {
        return questionMatch[1].trim();
      }
    }

    // Convert statement to question format
    return `How to ${prompt.trim().toLowerCase()}?`;
  }
}
