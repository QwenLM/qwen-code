/**
 * @license
 * Copyright 2026 Qmode
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  EnhancedPrompt,
  Enhancement,
  EnhancementLevel,
  EnhancementPreview,
  PromptAnalysis,
  PromptEnhancerOptions,
  QualityScores,
} from './types.js';
import { PromptAnalyzer } from './analyzer.js';
import { ContextGatherer } from './context-gatherer.js';
import { QualityScorer } from './quality-scorer.js';
import { getStrategy } from './strategies/index.js';
import { getTemplate } from './templates/index.js';

/**
 * Default options for prompt enhancement
 */
const DEFAULT_OPTIONS: PromptEnhancerOptions = {
  level: 'standard',
  forceIntent: undefined,
  extraContext: {},
  skipSteps: [],
  currentMode: undefined,
  projectRoot: process.cwd(),
};

/**
 * Main Prompt Enhancer class
 * Transforms basic prompts into professional team-lead level prompts
 */
export class PromptEnhancer {
  private analyzer: PromptAnalyzer;
  private scorer: QualityScorer;
  private contextGatherer: ContextGatherer;
  private defaultOptions: PromptEnhancerOptions;

  constructor(options?: PromptEnhancerOptions) {
    this.analyzer = new PromptAnalyzer();
    this.scorer = new QualityScorer();
    this.contextGatherer = new ContextGatherer(
      options?.projectRoot || process.cwd(),
    );
    this.defaultOptions = {
      ...DEFAULT_OPTIONS,
      ...options,
    };
  }

  /**
   * Enhance a prompt to team-lead quality
   */
  async enhance(
    prompt: string,
    options?: PromptEnhancerOptions,
  ): Promise<EnhancedPrompt> {
    const mergedOptions = {
      level: this.defaultOptions.level || 'standard',
      forceIntent: undefined,
      extraContext: {},
      skipSteps: [],
      currentMode: undefined,
      projectRoot: process.cwd(),
      ...this.defaultOptions,
      ...options,
    };

    // Step 1: Analyze the original prompt
    const analysis = this.analyzer.analyze(prompt);
    const intent = mergedOptions.forceIntent || analysis.intent;

    // Step 2: Score the original prompt
    const beforeScores = this.scorer.score(prompt);

    // Step 3: Gather project context
    const context = this.contextGatherer.gather();

    // Step 4: Apply enhancement strategy
    const strategy = getStrategy(intent);
    const enhanced = await strategy.enhance(
      prompt,
      analysis,
      context,
      mergedOptions,
    );

    // Step 5: Apply enhancement level adjustments
    const finalEnhanced = this.applyEnhancementLevel(
      enhanced,
      mergedOptions.level,
      analysis,
    );

    // Step 6: Score the enhanced prompt
    const afterScores = this.scorer.score(finalEnhanced);
    afterScores.overall = this.scorer.calculateOverall(afterScores);

    // Step 7: Track applied enhancements
    const appliedEnhancements = this.identifyAppliedEnhancements(
      prompt,
      finalEnhanced,
      analysis,
    );

    return {
      original: prompt,
      enhanced: finalEnhanced,
      intent,
      scores: {
        before: {
          ...beforeScores,
          overall: this.scorer.calculateOverall(beforeScores),
        },
        after: afterScores,
      },
      appliedEnhancements,
      suggestions: analysis.suggestions,
    };
  }

  /**
   * Get enhancement preview without full processing
   */
  async preview(prompt: string): Promise<EnhancementPreview> {
    const analysis = this.analyzer.analyze(prompt);
    const beforeScores = this.scorer.score(prompt);

    // Quick enhancement estimate
    const potentialImprovement = this.estimateImprovement(
      analysis,
      beforeScores,
    );

    // Generate a short preview
    const preview = this.generatePreview(prompt, analysis);

    return {
      original: prompt,
      enhancedPreview: preview,
      estimatedImprovement: potentialImprovement,
    };
  }

  /**
   * Analyze prompt quality
   */
  analyze(prompt: string): PromptAnalysis {
    return this.analyzer.analyze(prompt);
  }

  /**
   * Apply enhancement level adjustments
   */
  private applyEnhancementLevel(
    enhanced: string,
    level: EnhancementLevel,
    analysis: PromptAnalysis,
  ): string {
    switch (level) {
      case 'minimal':
        // Just clean up and add basic structure
        return this.applyMinimalEnhancement(enhanced);

      case 'standard':
        // Full enhancement with all sections
        return enhanced;

      case 'maximal':
        // Add examples, edge cases, and detailed guidance
        return this.applyMaximalEnhancement(enhanced, analysis);

      default:
        return enhanced;
    }
  }

  /**
   * Apply minimal enhancement
   */
  private applyMinimalEnhancement(enhanced: string): string {
    // Remove some verbose sections for minimal mode
    const lines = enhanced.split('\n');
    const filteredLines = lines.filter((line) => {
      // Keep most content but simplify some sections
      if (line.includes('## Implementation Plan')) {
        return false;
      }
      if (line.trim().startsWith('- [ ]')) {
        // Keep only first 3 checklist items
        return true;
      }
      return true;
    });

    return filteredLines.slice(0, 50).join('\n');
  }

  /**
   * Apply maximal enhancement
   */
  private applyMaximalEnhancement(
    enhanced: string,
    _analysis: PromptAnalysis,
  ): string {
    // Add additional sections for maximal mode
    const additions: string[] = [];

    // Add examples section
    additions.push(
      `\n## Examples\nProvide code examples demonstrating the expected behavior.`,
    );

    // Add edge cases section
    additions.push(
      `\n## Edge Cases to Consider\n- Input validation\n- Error handling\n- Boundary conditions`,
    );

    // Add testing notes
    additions.push(
      `\n## Testing Notes\n- Unit tests required\n- Integration tests if applicable\n- Consider mocking external dependencies`,
    );

    return enhanced + additions.join('\n');
  }

  /**
   * Identify what enhancements were applied
   */
  private identifyAppliedEnhancements(
    original: string,
    enhanced: string,
    _analysis: PromptAnalysis,
  ): Enhancement[] {
    const enhancements: Enhancement[] = [];

    // Check for structure additions
    if (enhanced.includes('##')) {
      enhancements.push({
        type: 'structure',
        description: 'Added structured sections with headers',
        impact: 'high',
      });
    }

    // Check for requirements addition
    if (
      enhanced.includes('Requirements') &&
      !original.includes('Requirements')
    ) {
      enhancements.push({
        type: 'requirements',
        description: 'Added explicit requirements section',
        impact: 'high',
      });
    }

    // Check for acceptance criteria
    if (
      enhanced.includes('Acceptance Criteria') &&
      !original.includes('Acceptance Criteria')
    ) {
      enhancements.push({
        type: 'acceptance-criteria',
        description: 'Added acceptance criteria',
        impact: 'high',
      });
    }

    // Check for context enrichment
    if (enhanced.includes('Context') || enhanced.includes('Project:')) {
      enhancements.push({
        type: 'context',
        description: 'Enriched with project context',
        impact: 'medium',
      });
    }

    // Check for constraints
    if (enhanced.includes('Constraints') && !original.includes('Constraints')) {
      enhancements.push({
        type: 'constraints',
        description: 'Added constraints section',
        impact: 'medium',
      });
    }

    // Check for implementation plan
    if (enhanced.includes('Implementation Plan')) {
      enhancements.push({
        type: 'implementation-plan',
        description: 'Added step-by-step implementation plan',
        impact: 'medium',
      });
    }

    return enhancements;
  }

  /**
   * Estimate potential improvement
   */
  private estimateImprovement(
    analysis: PromptAnalysis,
    scores: QualityScores,
  ): number {
    // Base improvement on gaps and current scores
    const gapBonus = analysis.gaps.length * 5;
    const lowScoreBonus = (10 - scores.overall) * 8;

    return Math.min(gapBonus + lowScoreBonus, 50);
  }

  /**
   * Generate a short preview
   */
  private generatePreview(prompt: string, analysis: PromptAnalysis): string {
    const template = getTemplate(analysis.intent);

    return (
      `Will enhance using "${template.name}" template with:\n` +
      `- Intent: ${analysis.intent}\n` +
      `- Gaps to fill: ${analysis.gaps.length}\n` +
      `- Suggestions: ${analysis.suggestions.length}`
    );
  }

  /**
   * Refresh project context (e.g., after file changes)
   */
  refreshContext(): void {
    this.contextGatherer.clearCache();
  }

  /**
   * Set project root for context gathering
   */
  setProjectRoot(projectRoot: string): void {
    this.contextGatherer = new ContextGatherer(projectRoot);
  }
}
