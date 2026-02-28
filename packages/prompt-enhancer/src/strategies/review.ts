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
import { REVIEW_TEMPLATE } from '../templates/index.js';

/**
 * Strategy for enhancing code review prompts
 */
export class ReviewStrategy extends BaseStrategy {
  readonly intent: IntentType = 'review';

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
      filesChanged: this.extractFilesChanged(prompt, context),
      reviewType: this.detectReviewType(prompt),
      prReference: this.extractPRReference(prompt) || 'Current changes',
      styleGuide: this.findStyleGuide(context),
      conventions: this.describeConventions(context),
      performanceRequirements:
        this.extractPerformanceRequirements(prompt) || 'Standard',
    };

    return this.fillTemplate(REVIEW_TEMPLATE.template, values);
  }

  /**
   * Extract files that were changed
   */
  private extractFilesChanged(
    prompt: string,
    _context: ProjectContext,
  ): string {
    // Look for file references
    const filePattern = /[\w./-]+\.(ts|tsx|js|jsx)/g;
    const matches = prompt.match(filePattern);

    if (matches) {
      return matches.join(', ');
    }

    // Check for git diff context
    if (
      prompt.toLowerCase().includes('git diff') ||
      prompt.toLowerCase().includes('changes')
    ) {
      return 'From git diff';
    }

    return 'To be determined from context';
  }

  /**
   * Detect the type of review
   */
  private detectReviewType(prompt: string): string {
    const lowerPrompt = prompt.toLowerCase();

    if (lowerPrompt.includes('pre-commit')) {
      return 'Pre-commit';
    }
    if (lowerPrompt.includes('pr') || lowerPrompt.includes('pull request')) {
      return 'Pull Request';
    }
    if (
      lowerPrompt.includes('architecture') ||
      lowerPrompt.includes('design')
    ) {
      return 'Architectural';
    }
    if (lowerPrompt.includes('security')) {
      return 'Security-focused';
    }
    if (lowerPrompt.includes('performance')) {
      return 'Performance-focused';
    }

    return 'General';
  }

  /**
   * Extract PR reference
   */
  private extractPRReference(prompt: string): string | null {
    // Look for PR numbers
    const prMatch = prompt.match(/#(\d+)/);
    if (prMatch) {
      return `#${prMatch[1]}`;
    }

    // Look for PR URLs
    const urlMatch = prompt.match(/github\.com\/[\w/-]+\/pull\/(\d+)/);
    if (urlMatch) {
      return `#${urlMatch[1]}`;
    }

    return null;
  }

  /**
   * Find style guide reference
   */
  private findStyleGuide(context: ProjectContext): string {
    // Check common style guide locations
    const styleGuidePaths = [
      'docs/styleguide.md',
      'STYLEGUIDE.md',
      'docs/CONTRIBUTING.md',
      'CONTRIBUTING.md',
    ];

    for (const path of styleGuidePaths) {
      if (context.fileStructure.some((f) => f.path === path)) {
        return path;
      }
    }

    return 'Project conventions';
  }

  /**
   * Describe project conventions
   */
  private describeConventions(context: ProjectContext): string {
    const conventions: string[] = [];

    conventions.push(`${context.conventions.namingConvention} naming`);

    if (context.conventions.testingFramework !== 'unknown') {
      conventions.push(`${context.conventions.testingFramework} for tests`);
    }

    if (context.conventions.documentationStyle !== 'none') {
      conventions.push(
        `${context.conventions.documentationStyle.toUpperCase()} documentation`,
      );
    }

    return conventions.join(', ') || 'Standard TypeScript conventions';
  }

  /**
   * Extract performance requirements
   */
  private extractPerformanceRequirements(prompt: string): string | null {
    const lowerPrompt = prompt.toLowerCase();

    if (lowerPrompt.includes('performance')) {
      return 'Focus on performance implications';
    }
    if (lowerPrompt.includes('memory')) {
      return 'Check memory usage';
    }
    if (lowerPrompt.includes('optimization')) {
      return 'Look for optimization opportunities';
    }

    return null;
  }
}
