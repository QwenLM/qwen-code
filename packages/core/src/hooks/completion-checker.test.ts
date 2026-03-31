/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  CompletionChecker,
  type ToolCallRecord,
} from './completion-checker.js';

describe('CompletionChecker', () => {
  const checker = new CompletionChecker();

  function check(
    toolCallHistory: ToolCallRecord[],
    lastAssistantMessage: string = '',
  ) {
    return checker.check({ toolCallHistory, lastAssistantMessage });
  }

  describe('passes when there are no issues', () => {
    it('should pass with an empty history', () => {
      const result = check([], '');
      expect(result.passed).toBe(true);
      expect(result.issues).toEqual([]);
    });

    it('should pass with successful shell commands', () => {
      const result = check([
        { name: 'run_shell_command', success: true, input: { command: 'ls' } },
        {
          name: 'run_shell_command',
          success: true,
          input: { command: 'cat foo.ts' },
        },
      ]);
      expect(result.passed).toBe(true);
      expect(result.issues).toEqual([]);
    });

    it('should pass when edits are followed by tests', () => {
      const history: ToolCallRecord[] = [
        { name: 'read_file', success: true },
        { name: 'edit', success: true },
        { name: 'write_file', success: true },
        {
          name: 'run_shell_command',
          success: true,
          input: { command: 'npm test' },
        },
        {
          name: 'run_shell_command',
          success: true,
          input: { command: 'echo done' },
        },
        {
          name: 'run_shell_command',
          success: true,
          input: { command: 'git commit -m "fix"' },
        },
      ];
      const result = check(history, 'All done, committed and pushed.');
      expect(result.passed).toBe(true);
    });

    it('should pass when edits exist but session is short (<=5 tool calls)', () => {
      const history: ToolCallRecord[] = [
        { name: 'read_file', success: true },
        { name: 'edit', success: true },
        {
          name: 'run_shell_command',
          success: true,
          input: { command: 'echo done' },
        },
      ];
      const result = check(history);
      expect(result.passed).toBe(true);
    });
  });

  describe('Check 1: Unresolved shell errors', () => {
    it('should flag when the last shell command failed', () => {
      const result = check([
        { name: 'run_shell_command', success: true, input: { command: 'ls' } },
        {
          name: 'run_shell_command',
          success: false,
          input: { command: 'npm build' },
        },
      ]);
      expect(result.passed).toBe(false);
      expect(result.issues).toContain(
        'Last shell command failed -- errors may be unresolved',
      );
    });

    it('should not flag when a middle shell command failed but the last succeeded', () => {
      const result = check([
        {
          name: 'run_shell_command',
          success: false,
          input: { command: 'npm build' },
        },
        {
          name: 'run_shell_command',
          success: true,
          input: { command: 'npm build' },
        },
      ]);
      expect(result.passed).toBe(true);
    });
  });

  describe('Check 2: Edits without test runs', () => {
    it('should flag when edits were made but no tests run in a substantial session', () => {
      const history: ToolCallRecord[] = [
        { name: 'read_file', success: true },
        { name: 'edit', success: true },
        { name: 'read_file', success: true },
        { name: 'edit', success: true },
        {
          name: 'run_shell_command',
          success: true,
          input: { command: 'echo done' },
        },
        { name: 'read_file', success: true },
      ];
      const result = check(history);
      expect(result.passed).toBe(false);
      expect(result.issues).toContain(
        'Files were modified but no tests were run',
      );
    });

    it('should detect various test command patterns', () => {
      const testCommands = [
        'npm test',
        'npx jest',
        'npx vitest',
        'pytest tests/',
        'cargo test',
        'go test ./...',
        'npx vitest run src/foo.test.ts',
        'npm run test:unit',
      ];

      for (const cmd of testCommands) {
        const history: ToolCallRecord[] = [
          { name: 'edit', success: true },
          { name: 'read_file', success: true },
          { name: 'edit', success: true },
          { name: 'read_file', success: true },
          { name: 'run_shell_command', success: true, input: { command: cmd } },
          { name: 'read_file', success: true },
        ];
        const result = check(history);
        expect(result.issues).not.toContain(
          'Files were modified but no tests were run',
        );
      }
    });

    it('should detect write_file as an edit tool', () => {
      const history: ToolCallRecord[] = [
        { name: 'read_file', success: true },
        { name: 'write_file', success: true },
        { name: 'read_file', success: true },
        { name: 'read_file', success: true },
        {
          name: 'run_shell_command',
          success: true,
          input: { command: 'echo ok' },
        },
        { name: 'read_file', success: true },
      ];
      const result = check(history);
      expect(result.passed).toBe(false);
      expect(result.issues).toContain(
        'Files were modified but no tests were run',
      );
    });

    it('should not flag short sessions even with edits and no tests', () => {
      const history: ToolCallRecord[] = [
        { name: 'edit', success: true },
        { name: 'read_file', success: true },
      ];
      const result = check(history);
      expect(result.issues).not.toContain(
        'Files were modified but no tests were run',
      );
    });
  });

  describe('Check 3: Tests mentioned but not executed', () => {
    it('should flag when "should run" tests is mentioned but no test was run', () => {
      const result = check(
        [{ name: 'edit', success: true }],
        'You should run the test suite to verify.',
      );
      expect(result.passed).toBe(false);
      expect(result.issues).toContain(
        'Tests were mentioned but never executed',
      );
    });

    it('should flag "need to run" tests pattern', () => {
      const result = check(
        [{ name: 'edit', success: true }],
        'We need to run the tests before deploying.',
      );
      expect(result.passed).toBe(false);
      expect(result.issues).toContain(
        'Tests were mentioned but never executed',
      );
    });

    it('should flag "haven\'t tested" pattern', () => {
      const result = check(
        [{ name: 'edit', success: true }],
        "I haven't tested this yet but it should work.",
      );
      expect(result.passed).toBe(false);
      expect(result.issues).toContain(
        'Tests were mentioned but never executed',
      );
    });

    it('should not flag when tests are mentioned AND executed', () => {
      const history: ToolCallRecord[] = [
        { name: 'edit', success: true },
        {
          name: 'run_shell_command',
          success: true,
          input: { command: 'npm test' },
        },
      ];
      const result = check(history, 'You should run the tests to verify.');
      expect(result.issues).not.toContain(
        'Tests were mentioned but never executed',
      );
    });
  });

  describe('Check 4: Uncommitted changes', () => {
    it('should flag when edits were made, commit is mentioned, but no git commit was run', () => {
      const history: ToolCallRecord[] = [
        { name: 'edit', success: true },
        {
          name: 'run_shell_command',
          success: true,
          input: { command: 'echo done' },
        },
      ];
      const result = check(
        history,
        'All changes have been made. You should commit these changes.',
      );
      expect(result.passed).toBe(false);
      expect(result.issues).toContain(
        'Changes were made and commit was discussed but no git commit was executed',
      );
    });

    it('should flag when PR is mentioned but no git push/commit was run', () => {
      const history: ToolCallRecord[] = [
        { name: 'edit', success: true },
        {
          name: 'run_shell_command',
          success: true,
          input: { command: 'echo done' },
        },
      ];
      const result = check(
        history,
        'I have created a pull request for your review.',
      );
      expect(result.passed).toBe(false);
      expect(result.issues).toContain(
        'Changes were made and commit was discussed but no git commit was executed',
      );
    });

    it('should not flag when edits were made and git commit was executed', () => {
      const history: ToolCallRecord[] = [
        { name: 'edit', success: true },
        {
          name: 'run_shell_command',
          success: true,
          input: { command: 'git commit -m "fix: resolve issue"' },
        },
      ];
      const result = check(history, 'Changes have been committed.');
      expect(result.passed).toBe(true);
    });

    it('should not flag when edits were made and git push was executed', () => {
      const history: ToolCallRecord[] = [
        { name: 'edit', success: true },
        {
          name: 'run_shell_command',
          success: true,
          input: { command: 'git push origin main' },
        },
      ];
      const result = check(history, 'Changes have been pushed to the remote.');
      expect(result.passed).toBe(true);
    });

    it('should not flag when commit is mentioned but no edits were made', () => {
      const history: ToolCallRecord[] = [
        { name: 'read_file', success: true },
        {
          name: 'run_shell_command',
          success: true,
          input: { command: 'echo ok' },
        },
      ];
      const result = check(history, 'No changes needed. Nothing to commit.');
      expect(result.passed).toBe(true);
    });
  });

  describe('multiple issues', () => {
    it('should report multiple issues when several checks fail', () => {
      const history: ToolCallRecord[] = [
        { name: 'read_file', success: true },
        { name: 'edit', success: true },
        { name: 'read_file', success: true },
        { name: 'edit', success: true },
        { name: 'read_file', success: true },
        {
          name: 'run_shell_command',
          success: false,
          input: { command: 'npm build' },
        },
      ];
      const result = check(
        history,
        "I haven't tested this yet. You should commit these changes.",
      );
      expect(result.passed).toBe(false);
      // Should have at least 3 issues: last shell failed, no tests, tests mentioned, uncommitted
      expect(result.issues.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe('edge cases', () => {
    it('should handle tool calls with no input', () => {
      const result = check([{ name: 'run_shell_command', success: true }]);
      expect(result.passed).toBe(true);
    });

    it('should handle tool calls with non-string command input', () => {
      const result = check([
        {
          name: 'run_shell_command',
          success: true,
          input: { command: 42 as unknown as string },
        },
      ]);
      expect(result.passed).toBe(true);
    });

    it('should handle empty last assistant message', () => {
      const result = check([{ name: 'edit', success: true }], '');
      expect(result.passed).toBe(true);
    });
  });
});
