/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Context-aware mode switching based on file and git context.
 *
 * The ContextAwareSwitcher monitors file context (open files, changed files,
 * directory, git status) and suggests appropriate modes based on configurable
 * rules. It includes built-in rules for common development patterns.
 */

import type { ModeSuggestion } from './mode-detection.js';
import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('MODE_CONTEXT');

/**
 * The type of event that triggers a mode suggestion rule.
 */
export type ContextTrigger = 'fileOpen' | 'fileChange' | 'directoryChange' | 'gitStatus';

/**
 * A rule that maps file or git patterns to mode suggestions.
 */
export interface ModeContextRule {
  /** Unique identifier for the rule */
  id?: string;

  /** Event type that triggers this rule */
  trigger: ContextTrigger;

  /** File patterns or git status patterns to match */
  patterns: string[];

  /** Mode to suggest when patterns match */
  suggestedMode: string;

  /** Confidence score for this suggestion (0-1) */
  confidence: number;

  /** If true, auto-switch without asking the user */
  autoSwitch?: boolean;

  /** Human-readable description of the rule */
  description?: string;
}

/**
 * Context information for evaluating mode suggestions.
 */
export interface ModeContext {
  /** Currently open file paths */
  openFiles: string[];

  /** Recently changed file paths */
  changedFiles: string[];

  /** Current working directory */
  currentDirectory: string;

  /** Git status output (e.g., from `git status --porcelain`) */
  gitStatus: string;
}

// ─── Built-in Context Rules ─────────────────────────────────────────────────

function createBuiltinRules(): ModeContextRule[] {
  let idCounter = 0;
  const nextId = () => `builtin-${idCounter++}`;

  return [
    // Test files -> tester
    {
      id: nextId(),
      trigger: 'fileOpen',
      patterns: ['*.test.*', '*.spec.*', '**/__tests__/**', '**/test/**'],
      suggestedMode: 'tester',
      confidence: 0.9,
      description: 'Test file opened',
    },
    // Docker files -> devops
    {
      id: nextId(),
      trigger: 'fileOpen',
      patterns: ['**/Dockerfile', '**/docker-compose.*', '**/Dockerfile.*', '**/.dockerignore'],
      suggestedMode: 'devops',
      confidence: 0.85,
      description: 'Docker file opened',
    },
    // CI/CD configs -> devops
    {
      id: nextId(),
      trigger: 'fileOpen',
      patterns: [
        '**/.github/workflows/*',
        '**/.gitlab-ci.yml',
        '**/Jenkinsfile',
        '**/.circleci/*',
      ],
      suggestedMode: 'devops',
      confidence: 0.85,
      description: 'CI/CD config opened',
    },
    // Documentation in docs/ -> product
    {
      id: nextId(),
      trigger: 'fileOpen',
      patterns: ['**/docs/*.md', '**/documentation/*.md'],
      suggestedMode: 'product',
      confidence: 0.7,
      description: 'Documentation file opened',
    },
    // Architecture/design docs -> architect
    {
      id: nextId(),
      trigger: 'fileOpen',
      patterns: ['**/architecture*.md', '**/design*.md', '**/*.adr.md', '**/ADRs/**'],
      suggestedMode: 'architect',
      confidence: 0.8,
      description: 'Architecture document opened',
    },
    // Security files -> security
    {
      id: nextId(),
      trigger: 'fileOpen',
      patterns: ['**/.env', '**/.env.*', '**/security*.md', '**/auth*.*'],
      suggestedMode: 'security',
      confidence: 0.75,
      autoSwitch: false,
      description: 'Security-related file opened',
    },
    // Git diff shows security-related changes -> security
    {
      id: nextId(),
      trigger: 'gitStatus',
      patterns: ['auth', 'login', 'permission', 'token', 'secret', 'password', 'credential', 'encrypt'],
      suggestedMode: 'security',
      confidence: 0.8,
      description: 'Security-related git changes detected',
    },
    // Many changed files -> debugger (potential bug context)
    {
      id: nextId(),
      trigger: 'fileChange',
      patterns: ['*'],
      suggestedMode: 'debugger',
      confidence: 0.5,
      description: 'Multiple file changes detected',
    },
    // Infrastructure files -> devops
    {
      id: nextId(),
      trigger: 'fileOpen',
      patterns: [
        '**/terraform/**',
        '**/*.tf',
        '**/kubernetes/**',
        '**/k8s/**',
        '**/helm/**',
        '**/infrastructure/**',
      ],
      suggestedMode: 'devops',
      confidence: 0.85,
      description: 'Infrastructure file opened',
    },
    // Package/config files on change -> developer
    {
      id: nextId(),
      trigger: 'fileChange',
      patterns: ['**/package.json', '**/tsconfig.json', '**/*.config.js', '**/*.config.ts'],
      suggestedMode: 'developer',
      confidence: 0.6,
      description: 'Configuration file changed',
    },
  ];
}

/**
 * Monitors file context and suggests modes based on configurable rules.
 */
export class ContextAwareSwitcher {
  private rules: ModeContextRule[];
  private ruleIndex: Map<string, ModeContextRule>;

  constructor() {
    this.rules = createBuiltinRules();
    this.ruleIndex = new Map();
    for (const rule of this.rules) {
      if (rule.id) {
        this.ruleIndex.set(rule.id, rule);
      }
    }
  }

  /**
   * Add a new context rule for mode suggestion.
   *
   * @param rule - Rule to add
   */
  addRule(rule: ModeContextRule): void {
    const id = rule.id || `custom-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const ruleWithId: ModeContextRule = { ...rule, id };
    this.rules.push(ruleWithId);
    this.ruleIndex.set(id, ruleWithId);
    debugLogger.debug(`Added context rule: ${id}`);
  }

  /**
   * Remove a context rule by ID.
   *
   * @param id - Rule identifier
   */
  removeRule(id: string): void {
    const rule = this.ruleIndex.get(id);
    if (!rule) {
      debugLogger.warn(`Rule not found: ${id}`);
      return;
    }

    this.rules = this.rules.filter((r) => r.id !== id);
    this.ruleIndex.delete(id);
    debugLogger.debug(`Removed context rule: ${id}`);
  }

  /**
   * Check current context and return mode suggestions.
   *
   * @param context - Current context information
   * @returns Array of mode suggestions sorted by confidence (highest first)
   */
  evaluateContext(context: ModeContext): ModeSuggestion[] {
    const suggestions: ModeSuggestion[] = [];
    const matchedKeys = new Set<string>();

    for (const rule of this.rules) {
      const triggered = this.isRuleTriggered(rule, context);
      if (!triggered) continue;

      const matched = this.matchPatterns(rule, context);
      if (matched && !matchedKeys.has(rule.suggestedMode)) {
        matchedKeys.add(rule.suggestedMode);
        suggestions.push({
          mode: rule.suggestedMode,
          confidence: rule.confidence,
          reason: rule.description || `Context match for ${rule.trigger}`,
        });
      }
    }

    // Sort by confidence descending
    suggestions.sort((a, b) => b.confidence - a.confidence);

    debugLogger.debug(
      `Evaluated context: ${suggestions.length} mode suggestions`,
    );

    return suggestions;
  }

  /**
   * Get all active rules.
   *
   * @returns Array of context rules
   */
  getRules(): ModeContextRule[] {
    return [...this.rules];
  }

  /**
   * Get a rule by ID.
   *
   * @param id - Rule identifier
   * @returns Rule or undefined
   */
  getRule(id: string): ModeContextRule | undefined {
    return this.ruleIndex.get(id);
  }

  /**
   * Check if a rule's trigger type matches the current context availability.
   */
  private isRuleTriggered(rule: ModeContextRule, context: ModeContext): boolean {
    switch (rule.trigger) {
      case 'fileOpen':
        return context.openFiles.length > 0;
      case 'fileChange':
        return context.changedFiles.length > 0;
      case 'directoryChange':
        return !!context.currentDirectory;
      case 'gitStatus':
        return !!context.gitStatus && context.gitStatus.trim().length > 0;
      default:
        return false;
    }
  }

  /**
   * Check if a rule's patterns match the current context.
   */
  private matchPatterns(rule: ModeContextRule, context: ModeContext): boolean {
    const filesToCheck = this.getFilesForTrigger(rule.trigger, context);
    if (filesToCheck.length === 0) return false;

    for (const file of filesToCheck) {
      const lowerFile = file.toLowerCase();
      for (const pattern of rule.patterns) {
        if (this.matchPattern(pattern, lowerFile)) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Get the relevant files/strings to check for a given trigger type.
   */
  private getFilesForTrigger(trigger: ContextTrigger, context: ModeContext): string[] {
    switch (trigger) {
      case 'fileOpen':
        return context.openFiles;
      case 'fileChange':
        return context.changedFiles;
      case 'directoryChange':
        return [context.currentDirectory];
      case 'gitStatus':
        return [context.gitStatus];
      default:
        return [];
    }
  }

  /**
   * Match a single pattern against a string. Supports glob-like patterns.
   */
  private matchPattern(pattern: string, target: string): boolean {
    // Convert glob pattern to regex
    // * matches anything except /
    // ** matches anything including /
    const regexPattern = pattern
      .replace(/\./g, '\\.')
      .replace(/\*\*/g, '__DOUBLESTAR__')
      .replace(/\*/g, '[^/]*')
      .replace(/__DOUBLESTAR__/g, '.*');

    const regex = new RegExp(regexPattern, 'i');
    return regex.test(target);
  }

  /**
   * Get rules that support auto-switching.
   *
   * @returns Array of rules with autoSwitch enabled
   */
  getAutoSwitchRules(): ModeContextRule[] {
    return this.rules.filter((r) => r.autoSwitch);
  }

  /**
   * Reset to built-in rules only.
   */
  resetRules(): void {
    this.rules = createBuiltinRules();
    this.ruleIndex.clear();
    for (const rule of this.rules) {
      if (rule.id) {
        this.ruleIndex.set(rule.id, rule);
      }
    }
  }
}
