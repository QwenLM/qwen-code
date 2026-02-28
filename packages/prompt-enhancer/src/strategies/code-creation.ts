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
import { CODE_CREATION_TEMPLATE } from '../templates/index.js';

/**
 * Strategy for enhancing code creation prompts
 */
export class CodeCreationStrategy extends BaseStrategy {
  readonly intent: IntentType = 'code-creation';

  async enhance(
    prompt: string,
    analysis: PromptAnalysis,
    context: ProjectContext,
    options: PromptEnhancerOptions,
  ): Promise<string> {
    const defaultValues = this.getDefaultValues(context, options);

    // Extract or infer values from the prompt and context
    const values = {
      ...defaultValues,
      task: prompt,
      filePath: this.extractFilePath(prompt) || 'To be determined',
      relatedFiles: this.findRelatedFiles(prompt, context),
      existingPatterns: this.describeExistingPatterns(context),
      functionalRequirements: this.inferFunctionalRequirements(prompt),
      performanceRequirements:
        this.extractPerformanceRequirements(prompt) || 'Not specified',
      acceptanceCriteria1: this.generateAcceptanceCriteria(prompt, context),
      acceptanceCriteria2: 'Code follows project conventions',
    };

    return this.fillTemplate(CODE_CREATION_TEMPLATE.template, values);
  }

  /**
   * Extract file path from prompt
   */
  private extractFilePath(prompt: string): string | null {
    const pathMatch = prompt.match(/[/\\][\w./-]+\.[tj]sx?/);
    return pathMatch ? pathMatch[0] : null;
  }

  /**
   * Find related files in the project
   */
  private findRelatedFiles(prompt: string, context: ProjectContext): string {
    const relatedFiles: string[] = [];

    // Look for files mentioned in the prompt
    const words = prompt.split(/\s+/);
    for (const word of words) {
      if (
        word.endsWith('.ts') ||
        word.endsWith('.tsx') ||
        word.endsWith('.js')
      ) {
        if (context.fileStructure.some((f) => f.path.includes(word))) {
          relatedFiles.push(word);
        }
      }
    }

    // If no files found, suggest looking at similar implementations
    if (relatedFiles.length === 0) {
      return 'Check existing implementations in src/';
    }

    return relatedFiles.join(', ');
  }

  /**
   * Describe existing patterns in the project
   */
  private describeExistingPatterns(context: ProjectContext): string {
    const patterns: string[] = [];

    if (context.framework) {
      patterns.push(`Uses ${context.framework} patterns`);
    }

    patterns.push(`${context.conventions.namingConvention} naming`);

    if (context.conventions.documentationStyle !== 'none') {
      patterns.push(
        `${context.conventions.documentationStyle.toUpperCase()} comments`,
      );
    }

    return patterns.join(', ') || 'Standard TypeScript patterns';
  }

  /**
   * Infer functional requirements from prompt
   */
  private inferFunctionalRequirements(prompt: string): string {
    // Extract what the code should do
    const lowerPrompt = prompt.toLowerCase();

    if (lowerPrompt.includes('function')) {
      return 'Implement the specified function with proper input validation';
    }
    if (lowerPrompt.includes('component')) {
      return 'Create a reusable component with proper props typing';
    }
    if (lowerPrompt.includes('api') || lowerPrompt.includes('endpoint')) {
      return 'Implement API endpoint with proper error handling';
    }
    if (lowerPrompt.includes('class')) {
      return 'Create a class with proper encapsulation';
    }

    return 'Implement the requested functionality';
  }

  /**
   * Extract performance requirements from prompt
   */
  private extractPerformanceRequirements(prompt: string): string | null {
    const lowerPrompt = prompt.toLowerCase();

    if (lowerPrompt.includes('fast') || lowerPrompt.includes('performance')) {
      return 'Optimize for performance';
    }
    if (lowerPrompt.includes('memory')) {
      return 'Optimize for memory usage';
    }
    if (lowerPrompt.includes('async') || lowerPrompt.includes('concurrent')) {
      return 'Handle concurrent operations efficiently';
    }

    return null;
  }

  /**
   * Generate acceptance criteria
   */
  private generateAcceptanceCriteria(
    prompt: string,
    context: ProjectContext,
  ): string {
    const criteria: string[] = [];

    if (context.conventions.testingFramework !== 'unknown') {
      criteria.push(
        `Tests written using ${context.conventions.testingFramework}`,
      );
    }

    criteria.push('Functionality works as expected');

    return criteria.join('; ');
  }
}
