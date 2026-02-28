/**
 * @license
 * Copyright 2026 Qmode
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  EnhancementStrategy,
  IntentType,
  PromptAnalysis,
  ProjectContext,
  PromptEnhancerOptions,
} from '../types.js';

/**
 * Base class for enhancement strategies
 */
export abstract class BaseStrategy implements EnhancementStrategy {
  abstract readonly intent: IntentType;

  /**
   * Enhance a prompt using this strategy
   */
  abstract enhance(
    prompt: string,
    analysis: PromptAnalysis,
    context: ProjectContext,
    options: PromptEnhancerOptions,
  ): Promise<string>;

  /**
   * Fill template with values
   */
  protected fillTemplate(
    template: string,
    values: Record<string, string>,
  ): string {
    let result = template;
    for (const [key, value] of Object.entries(values)) {
      result = result.replace(new RegExp(`\\{${key}\\}`, 'g'), value);
    }
    return result;
  }

  /**
   * Get default values for template variables
   */
  protected getDefaultValues(
    context: ProjectContext,
    _options: PromptEnhancerOptions,
  ): Record<string, string> {
    return {
      projectName: context.projectName,
      namingConvention: context.conventions.namingConvention,
      testingFramework: context.conventions.testingFramework,
      documentationStyle: context.conventions.documentationStyle,
      framework: context.framework || 'Not specified',
      language: context.language,
    };
  }
}
