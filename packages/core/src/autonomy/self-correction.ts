/**
 * Copyright (c) 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Validation criteria for outputs
 */
export interface ValidationCriteria {
  type: 'syntax' | 'semantic' | 'tests' | 'type-check' | 'linting' | 'build';
  command?: string;
  expectedResult?: unknown;
  tolerance?: number;
}

/**
 * Validation result
 */
export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
  metadata?: Record<string, unknown>;
}

/**
 * Validation error
 */
export interface ValidationError {
  type: string;
  message: string;
  location?: {
    file: string;
    line: number;
    column?: number;
  };
  severity: 'error' | 'critical';
}

/**
 * Validation warning
 */
export interface ValidationWarning {
  type: string;
  message: string;
  location?: {
    file: string;
    line: number;
    column?: number;
  };
}

/**
 * Execution context for corrections
 */
export interface ExecutionContext {
  task: string;
  files: string[];
  previousAttempts: number;
  maxAttempts: number;
  originalIntent: string;
  constraints?: string[];
}

/**
 * Correction suggestion
 */
export interface Correction {
  id: string;
  type: 'fix' | 'alternative' | 'workaround';
  description: string;
  changes: FileChange[];
  confidence: number; // 0-1
  reasoning: string;
  estimatedImpact: 'small' | 'medium' | 'large';
}

/**
 * File change for correction
 */
export interface FileChange {
  file: string;
  action: 'modify' | 'create' | 'delete';
  content?: string;
  oldContent?: string;
}

/**
 * Failure information
 */
export interface Failure {
  type: 'syntax' | 'runtime' | 'logic' | 'test' | 'build' | 'timeout';
  error: Error | string;
  context: ExecutionContext;
  timestamp: Date;
  stackTrace?: string;
}

/**
 * Learning pattern from failures
 */
export interface LearningPattern {
  errorPattern: string;
  commonCauses: string[];
  successfulFixes: string[];
  frequency: number;
  lastSeen: Date;
}

/**
 * Self-correction engine that validates, detects errors, and auto-corrects
 */
export class SelfCorrectionEngine {
  private learningPatterns: Map<string, LearningPattern> = new Map();
  private maxAttempts: number;

  constructor(maxAttempts = 3) {
    this.maxAttempts = maxAttempts;
  }

  /**
   * Validate output against criteria
   */
  async validateOutput(
    output: unknown,
    expected: ValidationCriteria[],
  ): Promise<ValidationResult> {
    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];

    for (const criteria of expected) {
      switch (criteria.type) {
        case 'syntax': {
          const syntaxResult = await this.validateSyntax(output);
          errors.push(...syntaxResult.errors);
          warnings.push(...syntaxResult.warnings);
          break;
        }
        case 'semantic': {
          const semanticResult = await this.validateSemantic(output);
          errors.push(...semanticResult.errors);
          warnings.push(...semanticResult.warnings);
          break;
        }
        case 'tests': {
          const testResult = await this.validateTests(output, criteria.command);
          errors.push(...testResult.errors);
          warnings.push(...testResult.warnings);
          break;
        }
        case 'type-check': {
          const typeResult = await this.validateTypes(output);
          errors.push(...typeResult.errors);
          warnings.push(...typeResult.warnings);
          break;
        }
        case 'linting': {
          const lintResult = await this.validateLinting(
            output,
            criteria.command,
          );
          errors.push(...lintResult.errors);
          warnings.push(...lintResult.warnings);
          break;
        }
        case 'build': {
          const buildResult = await this.validateBuild(
            output,
            criteria.command,
          );
          errors.push(...buildResult.errors);
          warnings.push(...buildResult.warnings);
          break;
        }
        default:
          break;
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Validate syntax
   */
  private async validateSyntax(
    output: unknown,
  ): Promise<{ errors: ValidationError[]; warnings: ValidationWarning[] }> {
    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];

    // Check if output is valid code
    if (typeof output === 'string') {
      // Check for common syntax errors
      const bracketCount = {
        open: (output.match(/\{/g) || []).length,
        close: (output.match(/\}/g) || []).length,
      };

      if (bracketCount.open !== bracketCount.close) {
        errors.push({
          type: 'syntax',
          message: 'Mismatched braces',
          severity: 'error',
        });
      }

      const parenCount = {
        open: (output.match(/\(/g) || []).length,
        close: (output.match(/\)/g) || []).length,
      };

      if (parenCount.open !== parenCount.close) {
        errors.push({
          type: 'syntax',
          message: 'Mismatched parentheses',
          severity: 'error',
        });
      }
    }

    return { errors, warnings };
  }

  /**
   * Validate semantic correctness
   */
  private async validateSemantic(
    output: unknown,
  ): Promise<{ errors: ValidationError[]; warnings: ValidationWarning[] }> {
    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];

    // Check for logical issues
    if (typeof output === 'string') {
      // Check for unreachable code
      if (output.match(/return\s+[^;]+;\s*\n\s*\S/m)) {
        warnings.push({
          type: 'semantic',
          message: 'Potential unreachable code after return',
        });
      }

      // Check for unused variables
      const declaredVars = output.match(/(?:const|let|var)\s+(\w+)/g) || [];
      const usedVars = new Set<string>();

      output.replace(/\b(\w+)\b/g, (match) => {
        usedVars.add(match);
        return match;
      });

      for (const decl of declaredVars) {
        const varName = decl.split(/\s+/)[1];
        if (!usedVars.has(varName)) {
          warnings.push({
            type: 'semantic',
            message: `Unused variable: ${varName}`,
          });
        }
      }
    }

    return { errors, warnings };
  }

  /**
   * Validate tests pass
   */
  private async validateTests(
    output: unknown,
    command?: string,
  ): Promise<{ errors: ValidationError[]; warnings: ValidationWarning[] }> {
    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];

    // In a real implementation, this would run the tests
    // For now, just check if test command is available
    if (!command) {
      warnings.push({
        type: 'tests',
        message: 'No test command specified',
      });
    }

    return { errors, warnings };
  }

  /**
   * Validate type correctness
   */
  private async validateTypes(
    _output: unknown,
  ): Promise<{ errors: ValidationError[]; warnings: ValidationWarning[] }> {
    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];

    // Would run TypeScript compiler in real implementation
    return { errors, warnings };
  }

  /**
   * Validate linting passes
   */
  private async validateLinting(
    _output: unknown,
    _command?: string,
  ): Promise<{ errors: ValidationError[]; warnings: ValidationWarning[] }> {
    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];

    // Would run linter in real implementation
    return { errors, warnings };
  }

  /**
   * Validate build succeeds
   */
  private async validateBuild(
    _output: unknown,
    _command?: string,
  ): Promise<{ errors: ValidationError[]; warnings: ValidationWarning[] }> {
    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];

    // Would run build in real implementation
    return { errors, warnings };
  }

  /**
   * Correct errors automatically
   */
  async correctErrors(
    errors: ValidationError[],
    context: ExecutionContext,
  ): Promise<Correction[]> {
    const corrections: Correction[] = [];

    // Check if we've exceeded max attempts
    if (context.previousAttempts >= this.maxAttempts) {
      return [];
    }

    for (const error of errors) {
      // Try to find known patterns
      const pattern = this.findMatchingPattern(error);

      if (pattern && pattern.successfulFixes.length > 0) {
        // Use learned fix
        corrections.push({
          id: this.generateCorrectionId(),
          type: 'fix',
          description: `Apply known fix for ${error.type}`,
          changes: [],
          confidence: 0.8,
          reasoning: `This fix has worked ${pattern.frequency} times before`,
          estimatedImpact: 'small',
        });
      } else {
        // Try to infer fix
        const inferredCorrection = this.inferCorrection(error, context);
        if (inferredCorrection) {
          corrections.push(inferredCorrection);
        }
      }
    }

    return corrections;
  }

  /**
   * Find matching error pattern
   */
  private findMatchingPattern(error: ValidationError): LearningPattern | null {
    for (const [pattern, learning] of this.learningPatterns.entries()) {
      if (error.message.includes(pattern)) {
        return learning;
      }
    }
    return null;
  }

  /**
   * Infer correction from error
   */
  private inferCorrection(
    error: ValidationError,
    _context: ExecutionContext,
  ): Correction | null {
    // Syntax errors
    if (error.type === 'syntax') {
      if (error.message.includes('Mismatched braces')) {
        return {
          id: this.generateCorrectionId(),
          type: 'fix',
          description: 'Fix mismatched braces',
          changes: [],
          confidence: 0.9,
          reasoning: 'Add missing closing brace',
          estimatedImpact: 'small',
        };
      }

      if (error.message.includes('Mismatched parentheses')) {
        return {
          id: this.generateCorrectionId(),
          type: 'fix',
          description: 'Fix mismatched parentheses',
          changes: [],
          confidence: 0.9,
          reasoning: 'Add missing closing parenthesis',
          estimatedImpact: 'small',
        };
      }
    }

    // Type errors
    if (error.type.includes('type')) {
      return {
        id: this.generateCorrectionId(),
        type: 'fix',
        description: 'Fix type error',
        changes: [],
        confidence: 0.7,
        reasoning: 'Add type annotation or cast',
        estimatedImpact: 'small',
      };
    }

    // Import errors
    if (error.message.includes('Cannot find module')) {
      return {
        id: this.generateCorrectionId(),
        type: 'fix',
        description: 'Fix missing import',
        changes: [],
        confidence: 0.8,
        reasoning: 'Add missing import statement',
        estimatedImpact: 'small',
      };
    }

    return null;
  }

  /**
   * Learn from mistakes
   */
  async learnFromMistake(
    failure: Failure,
    correction?: Correction,
  ): Promise<void> {
    const errorMessage =
      failure.error instanceof Error
        ? failure.error.message
        : String(failure.error);

    // Extract pattern
    const pattern = this.extractPattern(errorMessage);

    let learning = this.learningPatterns.get(pattern);

    if (!learning) {
      learning = {
        errorPattern: pattern,
        commonCauses: [],
        successfulFixes: [],
        frequency: 0,
        lastSeen: new Date(),
      };
    }

    learning.frequency++;
    learning.lastSeen = new Date();

    // Record successful correction
    if (correction) {
      const fixDescription = `${correction.type}: ${correction.description}`;
      if (!learning.successfulFixes.includes(fixDescription)) {
        learning.successfulFixes.push(fixDescription);
      }
    }

    // Identify common cause
    const cause = this.identifyCommonCause(failure);
    if (cause && !learning.commonCauses.includes(cause)) {
      learning.commonCauses.push(cause);
    }

    this.learningPatterns.set(pattern, learning);

    // Persist learning (in real implementation)
    await this.persistLearning();
  }

  /**
   * Extract error pattern
   */
  private extractPattern(errorMessage: string): string {
    // Remove specific details to create a pattern
    return errorMessage
      .replace(/['"][^'"]+['"]/g, '<string>')
      .replace(/\d+/g, '<number>')
      .replace(/\b[a-f0-9]{8,}\b/g, '<hash>')
      .substring(0, 100);
  }

  /**
   * Identify common cause of failure
   */
  private identifyCommonCause(failure: Failure): string | null {
    const errorMessage =
      failure.error instanceof Error
        ? failure.error.message
        : String(failure.error);

    if (errorMessage.includes('undefined')) return 'Uninitialized variable';
    if (errorMessage.includes('null')) return 'Null reference';
    if (errorMessage.includes('type')) return 'Type mismatch';
    if (errorMessage.includes('import')) return 'Missing dependency';
    if (errorMessage.includes('syntax')) return 'Syntax error';

    return null;
  }

  /**
   * Generate correction ID
   */
  private generateCorrectionId(): string {
    return `correction-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Persist learning patterns
   */
  private async persistLearning(): Promise<void> {
    // In real implementation, save to disk
  }

  /**
   * Load learning patterns
   */
  async loadLearning(): Promise<void> {
    // In real implementation, load from disk
  }

  /**
   * Get learning statistics
   */
  getLearningStats(): {
    totalPatterns: number;
    mostCommonErrors: Array<{ pattern: string; frequency: number }>;
    successRate: number;
  } {
    const patterns = Array.from(this.learningPatterns.values());

    const mostCommon = patterns
      .sort((a, b) => b.frequency - a.frequency)
      .slice(0, 10)
      .map((p) => ({
        pattern: p.errorPattern,
        frequency: p.frequency,
      }));

    const totalAttempts = patterns.reduce((sum, p) => sum + p.frequency, 0);
    const totalSuccesses = patterns.reduce(
      (sum, p) => sum + p.successfulFixes.length,
      0,
    );
    const successRate = totalAttempts > 0 ? totalSuccesses / totalAttempts : 0;

    return {
      totalPatterns: patterns.length,
      mostCommonErrors: mostCommon,
      successRate,
    };
  }

  /**
   * Suggest alternative approaches
   */
  suggestAlternatives(
    failure: Failure,
    _context: ExecutionContext,
  ): Correction[] {
    const alternatives: Correction[] = [];

    // Based on failure type, suggest alternatives
    if (failure.type === 'timeout') {
      alternatives.push({
        id: this.generateCorrectionId(),
        type: 'alternative',
        description: 'Use asynchronous approach',
        changes: [],
        confidence: 0.7,
        reasoning: 'Async operations can prevent timeouts',
        estimatedImpact: 'medium',
      });
    }

    if (failure.type === 'test') {
      alternatives.push({
        id: this.generateCorrectionId(),
        type: 'alternative',
        description: 'Revise test expectations',
        changes: [],
        confidence: 0.6,
        reasoning: 'Test expectations might be incorrect',
        estimatedImpact: 'small',
      });
    }

    return alternatives;
  }
}

/**
 * Create a new self-correction engine instance
 */
export function createSelfCorrectionEngine(
  maxAttempts = 3,
): SelfCorrectionEngine {
  return new SelfCorrectionEngine(maxAttempts);
}
