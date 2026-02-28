/**
 * @license
 * Copyright 2026 Qmode
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Enhancement level - controls how much enhancement is applied
 */
export type EnhancementLevel = 'minimal' | 'standard' | 'maximal';

/**
 * Intent type - what the user wants to accomplish
 */
export type IntentType =
  | 'code-creation'
  | 'bug-fix'
  | 'review'
  | 'refactor'
  | 'ask'
  | 'debug'
  | 'test'
  | 'documentation'
  | 'unknown';

/**
 * Quality scores for a prompt
 */
export interface QualityScores {
  clarity: number;
  completeness: number;
  actionability: number;
  contextRichness: number;
  overall: number;
}

/**
 * Analysis of a prompt
 */
export interface PromptAnalysis {
  intent: IntentType;
  confidence: number;
  specificity: number;
  hasContext: boolean;
  hasConstraints: boolean;
  hasSuccessCriteria: boolean;
  gaps: string[];
  suggestions: string[];
}

/**
 * Enhancement that was applied
 */
export interface Enhancement {
  type: string;
  description: string;
  impact: 'low' | 'medium' | 'high';
}

/**
 * Enhanced prompt result
 */
export interface EnhancedPrompt {
  /** Original user prompt */
  original: string;
  /** Enhanced prompt ready for AI consumption */
  enhanced: string;
  /** Detected intent */
  intent: IntentType;
  /** Quality scores before and after */
  scores: {
    before: QualityScores;
    after: QualityScores;
  };
  /** Applied enhancements */
  appliedEnhancements: Enhancement[];
  /** Suggestions for user */
  suggestions: string[];
}

/**
 * Preview of enhancement
 */
export interface EnhancementPreview {
  original: string;
  enhancedPreview: string;
  estimatedImprovement: number;
}

/**
 * Options for prompt enhancement
 */
export interface PromptEnhancerOptions {
  /** Enhancement level: minimal | standard | maximal */
  level?: EnhancementLevel;
  /** Override detected intent */
  forceIntent?: IntentType | undefined;
  /** Additional context to include */
  extraContext?: Record<string, unknown>;
  /** Skip specific enhancement steps */
  skipSteps?: string[];
  /** Current active mode (from modes layer) */
  currentMode?: string | undefined;
  /** Project root directory */
  projectRoot?: string;
}

/**
 * Context gathered from the project
 */
export interface ProjectContext {
  projectName: string;
  projectType: string;
  language: string;
  framework?: string;
  dependencies: Record<string, string>;
  scripts: Record<string, string>;
  fileStructure: FileNode[];
  conventions: CodeConventions;
  recentChanges?: GitChange[];
}

/**
 * File node in project structure
 */
export interface FileNode {
  name: string;
  type: 'file' | 'directory';
  path: string;
  children?: FileNode[];
}

/**
 * Code conventions detected from project
 */
export interface CodeConventions {
  namingConvention: 'camelCase' | 'snake_case' | 'PascalCase' | 'mixed';
  testingFramework: string;
  documentationStyle: 'jsdoc' | 'tsdoc' | 'mixed' | 'none';
  codeStyle: 'functional' | 'oop' | 'mixed';
}

/**
 * Git change record
 */
export interface GitChange {
  hash: string;
  message: string;
  files: string[];
  date: string;
}

/**
 * Template for prompt enhancement
 */
export interface PromptTemplate {
  id: string;
  name: string;
  description: string;
  intent: IntentType;
  template: string;
  variables: string[];
}

/**
 * Strategy for enhancing prompts
 */
export interface EnhancementStrategy {
  intent: IntentType;
  enhance(
    prompt: string,
    analysis: PromptAnalysis,
    context: ProjectContext,
    options: PromptEnhancerOptions,
  ): Promise<string>;
}
