/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Smart auto-detection for suggesting the best mode based on user input.
 *
 * The ModeDetector analyzes user input text and file context to suggest
 * the most appropriate mode with confidence scores. It also learns from
 * user behavior to provide personalized suggestions over time.
 */

import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('MODE_DETECTOR');

/**
 * A suggestion for which mode to use, with a confidence score and reason.
 */
export interface ModeSuggestion {
  /** Suggested mode name */
  mode: string;

  /** Confidence score from 0 to 1 */
  confidence: number;

  /** Human-readable reason for the suggestion */
  reason: string;
}

/**
 * A stored usage record for learning from user behavior.
 */
interface UsageRecord {
  modeName: string;
  taskDescription: string;
  timestamp: Date;
}

/**
 * A detection rule that maps patterns to mode suggestions.
 */
interface DetectionRule {
  /** Keywords or regex patterns to match */
  patterns: (string | RegExp)[];

  /** Mode to suggest when patterns match */
  mode: string;

  /** Confidence score when this rule matches (0-1) */
  confidence: number;

  /** Reason text for the suggestion */
  reason: string;
}

// ─── Built-in Detection Rules ────────────────────────────────────────────────

const BUILTIN_RULES: DetectionRule[] = [
  {
    patterns: ['test', 'spec', 'coverage', 'unit test', 'integration test', 'e2e', 'assert'],
    mode: 'tester',
    confidence: 0.9,
    reason: 'Task involves testing or test coverage',
  },
  {
    patterns: ['review', 'audit', 'check code', 'code review', 'pr review', 'lint'],
    mode: 'reviewer',
    confidence: 0.9,
    reason: 'Task involves code review or auditing',
  },
  {
    patterns: ['bug', 'fix', 'error', 'debug', 'crash', 'exception', 'stack trace', 'broken'],
    mode: 'debugger',
    confidence: 0.9,
    reason: 'Task involves debugging or fixing errors',
  },
  {
    patterns: ['optimize', 'performance', 'slow', 'bottleneck', 'memory leak', 'profiling'],
    mode: 'optimizer',
    confidence: 0.8,
    reason: 'Task involves performance optimization',
  },
  {
    patterns: ['security', 'vulnerability', 'auth', 'authentication', 'authorization', 'xss', 'sql injection', 'cwe', 'owasp'],
    mode: 'security',
    confidence: 0.8,
    reason: 'Task involves security analysis',
  },
  {
    patterns: ['deploy', 'ci/cd', 'cicd', 'docker', 'pipeline', 'kubernetes', 'k8s', 'infrastructure', 'terraform'],
    mode: 'devops',
    confidence: 0.8,
    reason: 'Task involves DevOps or infrastructure',
  },
  {
    patterns: ['design', 'architecture', 'plan', 'adr', 'system design', 'component', 'microservice'],
    mode: 'architect',
    confidence: 0.8,
    reason: 'Task involves system design or architecture',
  },
  {
    patterns: ['implement', 'create', 'write code', 'build', 'develop', 'feature', 'function'],
    mode: 'developer',
    confidence: 0.7,
    reason: 'Task involves implementing code',
  },
  {
    patterns: ['user story', 'requirement', 'feature spec', 'acceptance criteria', 'product', 'stakeholder'],
    mode: 'product',
    confidence: 0.7,
    reason: 'Task involves product management',
  },
];

/**
 * Analyzes user input and suggests the best matching mode.
 */
export class ModeDetector {
  private rules: DetectionRule[];
  private usageHistory: UsageRecord[];

  constructor() {
    this.rules = [...BUILTIN_RULES];
    this.usageHistory = [];
  }

  /**
   * Analyze text and suggest best matching modes.
   *
   * @param text - User input text to analyze
   * @returns Array of mode suggestions sorted by confidence (highest first)
   */
  detect(text: string): ModeSuggestion[] {
    if (!text || text.trim().length === 0) {
      return [];
    }

    const lowerText = text.toLowerCase();
    const suggestions: ModeSuggestion[] = [];
    const matchedModes = new Set<string>();

    for (const rule of this.rules) {
      for (const pattern of rule.patterns) {
        let matched = false;
        if (typeof pattern === 'string') {
          matched = lowerText.includes(pattern.toLowerCase());
        } else {
          matched = pattern.test(lowerText);
        }

        if (matched && !matchedModes.has(rule.mode)) {
          matchedModes.add(rule.mode);
          suggestions.push({
            mode: rule.mode,
            confidence: rule.confidence,
            reason: rule.reason,
          });
          break;
        }
      }
    }

    // Sort by confidence descending
    suggestions.sort((a, b) => b.confidence - a.confidence);

    debugLogger.debug(
      `Detected ${suggestions.length} mode suggestions for input`,
    );

    return suggestions;
  }

  /**
   * Analyze file context and suggest modes based on file types and paths.
   *
   * @param files - Array of file paths to analyze
   * @returns Array of mode suggestions sorted by confidence (highest first)
   */
  detectFromFiles(files: string[]): ModeSuggestion[] {
    if (!files || files.length === 0) {
      return [];
    }

    const suggestions: ModeSuggestion[] = [];
    const matchedModes = new Set<string>();

    for (const file of files) {
      const lowerFile = file.toLowerCase();

      // Test file patterns
      if (/\.(test|spec)\./.test(lowerFile) && !matchedModes.has('tester')) {
        matchedModes.add('tester');
        suggestions.push({
          mode: 'tester',
          confidence: 0.9,
          reason: `Test file detected: ${file}`,
        });
      }

      // Docker files
      if ((lowerFile.includes('dockerfile') || lowerFile.includes('docker-compose')) && !matchedModes.has('devops')) {
        matchedModes.add('devops');
        suggestions.push({
          mode: 'devops',
          confidence: 0.85,
          reason: `DevOps file detected: ${file}`,
        });
      }

      // CI/CD configs
      if ((lowerFile.includes('.github/workflows') || lowerFile.includes('.gitlab-ci') || lowerFile.includes('jenkinsfile')) && !matchedModes.has('devops')) {
        matchedModes.add('devops');
        suggestions.push({
          mode: 'devops',
          confidence: 0.85,
          reason: `CI/CD config detected: ${file}`,
        });
      }

      // Security files
      if ((lowerFile.includes('.env') || lowerFile.includes('security') || lowerFile.includes('auth')) && !matchedModes.has('security')) {
        matchedModes.add('security');
        suggestions.push({
          mode: 'security',
          confidence: 0.75,
          reason: `Security-related file detected: ${file}`,
        });
      }

      // Documentation
      if (lowerFile.endsWith('.md') && (lowerFile.includes('/docs/') || lowerFile.includes('/documentation/')) && !matchedModes.has('product')) {
        matchedModes.add('product');
        suggestions.push({
          mode: 'product',
          confidence: 0.7,
          reason: `Documentation file detected: ${file}`,
        });
      }

      // Architecture/design docs
      if ((lowerFile.includes('architecture') || lowerFile.includes('design') || lowerFile.endsWith('.adr.md')) && !matchedModes.has('architect')) {
        matchedModes.add('architect');
        suggestions.push({
          mode: 'architect',
          confidence: 0.8,
          reason: `Architecture doc detected: ${file}`,
        });
      }
    }

    // Sort by confidence descending
    suggestions.sort((a, b) => b.confidence - a.confidence);

    debugLogger.debug(
      `Detected ${suggestions.length} mode suggestions from ${files.length} files`,
    );

    return suggestions;
  }

  /**
   * Record a mode usage for learning personalized suggestions.
   *
   * @param modeName - The mode that was used
   * @param taskDescription - Description of the task performed
   */
  recordUsage(modeName: string, taskDescription: string): void {
    this.usageHistory.push({
      modeName,
      taskDescription: taskDescription.toLowerCase(),
      timestamp: new Date(),
    });

    // Keep history manageable — retain last 1000 entries
    if (this.usageHistory.length > 1000) {
      this.usageHistory = this.usageHistory.slice(-1000);
    }

    debugLogger.debug(
      `Recorded mode usage: ${modeName} for "${taskDescription}"`,
    );
  }

  /**
   * Get personalized mode suggestions based on past usage history.
   *
   * @returns Array of mode suggestions sorted by frequency of past use
   */
  getPersonalizedSuggestions(): ModeSuggestion[] {
    if (this.usageHistory.length === 0) {
      return [];
    }

    // Count mode usage frequency
    const modeCounts = new Map<string, number>();
    for (const record of this.usageHistory) {
      modeCounts.set(record.modeName, (modeCounts.get(record.modeName) || 0) + 1);
    }

    const totalUsage = this.usageHistory.length;
    const suggestions: ModeSuggestion[] = [];

    for (const [modeName, count] of modeCounts.entries()) {
      // Confidence based on relative frequency, capped at 0.95
      const frequency = count / totalUsage;
      const confidence = Math.min(0.95, 0.5 + frequency * 0.5);

      suggestions.push({
        mode: modeName,
        confidence,
        reason: `Frequently used mode (${count} times)`,
      });
    }

    // Sort by confidence descending
    suggestions.sort((a, b) => b.confidence - a.confidence);

    return suggestions;
  }

  /**
   * Add a custom detection rule.
   *
   * @param rule - Detection rule to add
   */
  addRule(rule: DetectionRule): void {
    this.rules.push(rule);
  }

  /**
   * Remove all custom rules (keeps built-in rules).
   */
  resetRules(): void {
    this.rules = [...BUILTIN_RULES];
  }

  /**
   * Get all active detection rules.
   *
   * @returns Array of detection rules
   */
  getRules(): DetectionRule[] {
    return [...this.rules];
  }

  /**
   * Clear all usage history.
   */
  clearHistory(): void {
    this.usageHistory = [];
  }

  /**
   * Get usage history (for testing or inspection).
   *
   * @returns Array of usage records
   */
  getUsageHistory(): UsageRecord[] {
    return [...this.usageHistory];
  }
}
