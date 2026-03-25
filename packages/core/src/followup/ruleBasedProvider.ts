/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Rule-Based Follow-up Suggestions Provider
 *
 * Generates follow-up suggestions based on pattern matching rules.
 */

import type {
  SuggestionContext,
  SuggestionProvider,
  SuggestionResult,
  SuggestionRule,
  FollowupSuggestion,
} from './types.js';

/**
 * Default suggestion rules for common workflows
 */
export const DEFAULT_SUGGESTION_RULES: SuggestionRule[] = [
  // After file edit operations (only when files were actually modified)
  {
    pattern: /(?:Edit|WriteFile)/,
    suggestions: [
      { text: 'commit this', description: 'Commit the changes' },
      { text: 'review changes', description: 'Review what was changed' },
      { text: 'undo', description: 'Undo the last change' },
    ],
    condition: (context) =>
      // Only suggest if files were actually modified
      context.modifiedFiles.length > 0,
    priority: 100,
  },
  // After running tests
  {
    pattern: /Shell/,
    suggestions: [
      { text: 'fix failing tests', description: 'Fix the tests that failed' },
      { text: 'run all tests', description: 'Run the full test suite' },
    ],
    condition: (context) => {
      const testCommands = [
        'npm test',
        'pytest',
        'cargo test',
        'go test',
        'jest',
        'vitest',
      ];
      return context.toolCalls.some((call) => {
        const cmdInput = call.input as Record<string, unknown>;
        const command = String(cmdInput['command'] || '');
        return testCommands.some((cmd) => command.includes(cmd));
      });
    },
    priority: 90,
  },
  // After git operations
  {
    pattern: /Shell/,
    suggestions: [
      { text: 'git push', description: 'Push commits to remote' },
      { text: 'create PR', description: 'Create a pull request' },
      { text: 'amend commit', description: 'Amend the last commit' },
    ],
    condition: (context) =>
      context.toolCalls.some((call) => {
        const cmdInput = call.input as Record<string, unknown>;
        const command = String(cmdInput['command'] || '');
        return (
          command.includes('git ') &&
          (command.includes('add') || command.includes('commit'))
        );
      }),
    priority: 85,
  },
  // After creating new files
  {
    pattern: /WriteFile/,
    suggestions: [
      { text: 'add tests', description: 'Add unit tests for this file' },
      { text: 'document this', description: 'Add documentation' },
      { text: 'review file', description: 'Review the new file' },
    ],
    condition: (context) =>
      context.modifiedFiles.some((f) => f.type === 'created'),
    priority: 80,
  },
  // After fixing bugs
  {
    pattern: /fix|bug|error/i,
    suggestions: [
      { text: 'verify fix', description: 'Verify the fix works' },
      { text: 'add test case', description: 'Add a test for this bug' },
      {
        text: 'check for regressions',
        description: 'Check for similar issues',
      },
    ],
    priority: 70,
    matchMessage: true, // Match against message content, not tool names
    condition: (context) => {
      const hasToolCalls = context.toolCalls.length > 0;
      const messageHasKeywords =
        context.lastMessage.toLowerCase().includes('fix') ||
        context.lastMessage.toLowerCase().includes('bug');
      return hasToolCalls && messageHasKeywords;
    },
  },
  // After refactoring
  {
    pattern: /refactor|reorganize|clean up/i,
    suggestions: [
      { text: 'run tests', description: 'Make sure nothing broke' },
      { text: 'commit changes', description: 'Commit the refactor' },
    ],
    priority: 65,
    matchMessage: true, // Match against message content, not tool names
    condition: (context) => {
      const hasToolCalls = context.toolCalls.length > 0;
      const messageHasKeywords =
        context.lastMessage.toLowerCase().includes('refactor') ||
        context.lastMessage.toLowerCase().includes('reorganize');
      return hasToolCalls && messageHasKeywords;
    },
  },
  // After dependency operations
  {
    pattern: /Shell/,
    suggestions: [
      { text: 'restart server', description: 'Restart the development server' },
      { text: 'clear cache', description: 'Clear node_modules and reinstall' },
    ],
    condition: (context) => {
      const installCommands = [
        'npm install',
        'npm add',
        'yarn add',
        'pnpm add',
        'bun add',
      ];
      return context.toolCalls.some((call) => {
        const cmdInput = call.input as Record<string, unknown>;
        const command = String(cmdInput['command'] || '');
        return installCommands.some((cmd) => command.includes(cmd));
      });
    },
    priority: 60,
  },
  // After build operations
  {
    pattern: /Shell/,
    suggestions: [
      { text: 'run build', description: 'Build for production' },
      { text: 'check bundle size', description: 'Analyze the build output' },
    ],
    condition: (context) => {
      const buildCommands = [
        'npm run build',
        'yarn build',
        'pnpm build',
        'bun build',
      ];
      return context.toolCalls.some((call) => {
        const cmdInput = call.input as Record<string, unknown>;
        const command = String(cmdInput['command'] || '');
        return buildCommands.some((cmd) => command.includes(cmd));
      });
    },
    priority: 55,
  },
];

/** Maximum number of suggestions returned */
const MAX_SUGGESTIONS = 5;

/**
 * Rule-based suggestion provider
 */
export class RuleBasedProvider implements SuggestionProvider {
  private rules: SuggestionRule[];

  constructor(rules: SuggestionRule[] = DEFAULT_SUGGESTION_RULES) {
    // Sort rules by priority (highest first)
    this.rules = [...rules].sort(
      (a, b) => (b.priority || 0) - (a.priority || 0),
    );
  }

  /**
   * Get suggestions based on the context.
   * Collects suggestions from all matching rules, deduplicates by text,
   * and returns up to MAX_SUGGESTIONS results sorted by priority.
   */
  getSuggestions(context: SuggestionContext): SuggestionResult {
    // Don't show suggestions if there was an error or cancellation
    if (context.hasError || context.wasCancelled) {
      return { suggestions: [], shouldShow: false };
    }

    // Don't show suggestions if no tool calls were made
    if (context.toolCalls.length === 0 && context.modifiedFiles.length === 0) {
      return { suggestions: [], shouldShow: false };
    }

    // Collect suggestions from all matching rules
    const seen = new Set<string>();
    const all: FollowupSuggestion[] = [];

    for (const rule of this.rules) {
      if (this.matchesRule(rule, context)) {
        for (const s of this.convertToFollowupSuggestions(
          rule.suggestions,
          rule.priority ?? 0,
        )) {
          if (!seen.has(s.text)) {
            seen.add(s.text);
            all.push(s);
          }
        }
      }
    }

    // Sort by priority descending and limit
    all.sort((a, b) => b.priority - a.priority);
    const suggestions = all.slice(0, MAX_SUGGESTIONS);

    return { suggestions, shouldShow: suggestions.length > 0 };
  }

  /**
   * Check if a rule matches the context
   */
  private matchesRule(
    suggestionRule: SuggestionRule,
    context: SuggestionContext,
  ): boolean {
    const pattern = suggestionRule.pattern;

    // Check pattern first (cheap string/regex match) before condition (may be expensive)
    let patternMatches = false;

    if (suggestionRule.matchMessage) {
      // Match pattern against message content only
      if (pattern instanceof RegExp) {
        pattern.lastIndex = 0; // Reset for g/y flag safety
        patternMatches = pattern.test(context.lastMessage);
      } else if (typeof pattern === 'string') {
        patternMatches = context.lastMessage
          .toLowerCase()
          .includes(pattern.toLowerCase());
      }
    } else if (pattern instanceof RegExp) {
      patternMatches = context.toolCalls.some((call) => {
        pattern.lastIndex = 0; // Reset for g/y flag safety
        return pattern.test(call.name);
      });
    } else if (typeof pattern === 'string') {
      const lowerPattern = pattern.toLowerCase();
      patternMatches = context.toolCalls.some((call) =>
        call.name.toLowerCase().includes(lowerPattern),
      );
    }

    if (!patternMatches) {
      return false;
    }

    // Pattern matched — now check custom condition (potentially expensive)
    if (suggestionRule.condition && !suggestionRule.condition(context)) {
      return false;
    }

    return true;
  }

  /**
   * Convert rule suggestions to FollowupSuggestion objects
   */
  private convertToFollowupSuggestions(
    suggestions: Array<string | { text: string; description?: string }>,
    rulePriority: number,
  ): FollowupSuggestion[] {
    return suggestions.map((s, index) => {
      // Combine rule priority with index offset so higher-priority rules dominate
      const priority = rulePriority * 100 + (100 - index * 10);
      if (typeof s === 'string') {
        return { text: s, priority };
      }
      return {
        text: s.text,
        description: s.description,
        priority,
      };
    });
  }

  /**
   * Add a custom rule to the provider
   */
  addRule(rule: SuggestionRule): void {
    this.rules.push(rule);
    this.rules.sort((a, b) => (b.priority || 0) - (a.priority || 0));
  }

  /**
   * Remove rules matching a pattern
   */
  removeRules(pattern: RegExp): void {
    this.rules = this.rules.filter((rule) => {
      const patternStr =
        rule.pattern instanceof RegExp
          ? rule.pattern.source
          : String(rule.pattern);
      return !pattern.test(patternStr);
    });
  }
}

/**
 * Create a default rule-based provider
 */
export function createDefaultProvider(): RuleBasedProvider {
  return new RuleBasedProvider(DEFAULT_SUGGESTION_RULES);
}
