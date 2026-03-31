/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('COMPLETION_CHECKER');

export interface ToolCallRecord {
  name: string;
  success: boolean;
  input?: Record<string, unknown>;
}

export interface CompletionCheckResult {
  passed: boolean;
  issues: string[];
}

/**
 * Heuristic completion checker that validates the agent actually finished its work.
 * Runs as part of the Stop hook -- no model call needed.
 *
 * Inspects the tool call history and the final assistant message to detect
 * common signs of incomplete work: unresolved shell errors, missing test runs,
 * tests mentioned but never executed, and uncommitted changes.
 */
export class CompletionChecker {
  check(context: {
    toolCallHistory: ToolCallRecord[];
    lastAssistantMessage: string;
  }): CompletionCheckResult {
    const issues: string[] = [];
    const { toolCallHistory, lastAssistantMessage } = context;

    // Check 1: Unresolved shell errors
    const shellCalls = toolCallHistory.filter(
      (t) => t.name === 'run_shell_command',
    );
    const lastShellFailed =
      shellCalls.length > 0 && !shellCalls[shellCalls.length - 1]?.success;
    if (lastShellFailed) {
      issues.push('Last shell command failed -- errors may be unresolved');
    }

    // Check 2: Edit tools used but no test run
    const editTools = ['edit', 'write_file'];
    const hasEdits = toolCallHistory.some((t) => editTools.includes(t.name));
    const hasTestRun = shellCalls.some((t) => {
      const cmd =
        typeof t.input?.['command'] === 'string' ? t.input['command'] : '';
      return /\b(test|spec|jest|vitest|pytest|mocha|cargo\s+test|go\s+test|npm\s+test|npx\s+vitest|npx\s+jest)\b/i.test(
        cmd,
      );
    });
    if (hasEdits && !hasTestRun && toolCallHistory.length > 5) {
      // Only flag if session was substantial (>5 tool calls)
      issues.push('Files were modified but no tests were run');
    }

    // Check 3: Tests mentioned in final message but never executed
    const mentionsTests =
      /\b(should run|need to run|run the tests|test.*later|haven't tested)\b/i.test(
        lastAssistantMessage,
      );
    if (mentionsTests && !hasTestRun) {
      issues.push('Tests were mentioned but never executed');
    }

    // Check 4: Uncommitted changes in git workflow
    const hasGitCommit = shellCalls.some((t) => {
      const cmd =
        typeof t.input?.['command'] === 'string' ? t.input['command'] : '';
      return /git\s+(commit|push)/.test(cmd);
    });
    const mentionsCommit = /\b(commit|push|PR|pull request)\b/i.test(
      lastAssistantMessage,
    );
    if (hasEdits && mentionsCommit && !hasGitCommit) {
      issues.push(
        'Changes were made and commit was discussed but no git commit was executed',
      );
    }

    if (issues.length > 0) {
      debugLogger.debug(
        `Completion check found ${issues.length} issues: ${issues.join('; ')}`,
      );
    }

    return {
      passed: issues.length === 0,
      issues,
    };
  }
}
