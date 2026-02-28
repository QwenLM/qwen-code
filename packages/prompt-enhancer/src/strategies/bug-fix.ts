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
import { BUG_FIX_TEMPLATE } from '../templates/index.js';

/**
 * Strategy for enhancing bug fix prompts
 */
export class BugFixStrategy extends BaseStrategy {
  readonly intent: IntentType = 'bug-fix';

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
      errorLocation: this.extractErrorLocation(prompt, context),
      errorMessage: this.extractErrorMessage(prompt) || 'Not provided',
      stackTrace: this.extractStackTrace(prompt) || 'Not provided',
      reproductionSteps:
        this.extractReproductionSteps(prompt) || 'To be determined',
      affectedFiles: this.findAffectedFiles(prompt, context),
      hypothesis: 'To be investigated',
    };

    return this.fillTemplate(BUG_FIX_TEMPLATE.template, values);
  }

  /**
   * Extract error location from prompt
   */
  private extractErrorLocation(
    prompt: string,
    _context: ProjectContext,
  ): string {
    // Look for file:line patterns
    const fileLineMatch = prompt.match(/[\w./-]+\.(ts|tsx|js|jsx):\d+/);
    if (fileLineMatch) {
      return fileLineMatch[0];
    }

    // Look for file paths
    const filePathMatch = prompt.match(/[/\\][\w./-]+\.[tj]sx?/);
    if (filePathMatch) {
      return filePathMatch[0];
    }

    return 'To be determined from error logs';
  }

  /**
   * Extract error message from prompt
   */
  private extractErrorMessage(prompt: string): string | null {
    // Look for quoted text
    const quoteMatch = prompt.match(/["']([^"']+)["']/);
    if (quoteMatch) {
      return quoteMatch[1];
    }

    // Look for common error patterns
    const errorPatterns = [
      /Error:\s*([^.]+)/i,
      /Exception:\s*([^.]+)/i,
      /Failed to\s+([^.]+)/i,
    ];

    for (const pattern of errorPatterns) {
      const match = prompt.match(pattern);
      if (match) {
        return match[1].trim();
      }
    }

    return null;
  }

  /**
   * Extract stack trace from prompt
   */
  private extractStackTrace(prompt: string): string | null {
    // Look for stack trace patterns
    const stackPattern = /at\s+\w+/i;
    if (stackPattern.test(prompt)) {
      const lines = prompt.split('\n');
      const stackLines = lines.filter(
        (line) =>
          line.includes('at ') ||
          line.includes('.js:') ||
          line.includes('.ts:'),
      );
      return stackLines.slice(0, 5).join('\n') || 'Partial stack trace';
    }

    return null;
  }

  /**
   * Extract reproduction steps from prompt
   */
  private extractReproductionSteps(prompt: string): string | null {
    const lowerPrompt = prompt.toLowerCase();

    if (lowerPrompt.includes('when')) {
      const whenIndex = lowerPrompt.indexOf('when');
      return prompt.substring(whenIndex).split('.')[0];
    }

    if (lowerPrompt.includes('after')) {
      const afterIndex = lowerPrompt.indexOf('after');
      return prompt.substring(afterIndex).split('.')[0];
    }

    return null;
  }

  /**
   * Find affected files
   */
  private findAffectedFiles(prompt: string, _context: ProjectContext): string {
    const affectedFiles: string[] = [];

    // Look for file references in the prompt
    const filePattern = /[\w./-]+\.(ts|tsx|js|jsx)/g;
    const matches = prompt.match(filePattern);

    if (matches) {
      for (const file of matches) {
        if (
          _context.fileStructure.some((f: { path: string }) =>
            f.path.includes(file),
          )
        ) {
          affectedFiles.push(file);
        }
      }
    }

    if (affectedFiles.length === 0) {
      return 'To be identified during investigation';
    }

    return affectedFiles.join(', ');
  }
}
