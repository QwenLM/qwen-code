/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  accumulateRetryBatch,
  classifyToolExperience,
  didToolCallProduceWork,
  isSubstantiveToolCall,
  type CompletedToolOutcome,
} from './experience-signals.js';
import { Kind } from '../tools/tools.js';
import { ToolErrorType } from '../tools/tool-error.js';
import type { ShellResultDisplay } from '../utils/shell-result.js';

const success: CompletedToolOutcome = {
  callId: 'call',
  executionStatus: 'success',
  error: undefined,
  errorType: undefined,
  resultDisplay: undefined,
};
const shell: ShellResultDisplay = {
  type: 'shell_result',
  version: 1,
  text: '',
  output: '',
  directory: '/tmp',
  exitCode: 0,
  signal: null,
  pid: null,
  error: null,
  outcome: 'completed',
  notices: [],
  truncated: false,
  outputFiles: [],
};

it.each([
  'write_file',
  'edit',
  'notebook_edit',
  'run_shell_command',
  'exec',
  'agent',
])('%s is substantive', (name) =>
  expect(isSubstantiveToolCall(name)).toBe(true),
);
it.each([
  'read_file',
  'list_directory',
  'grep_search',
  'web_search',
  'exit_plan_mode',
  'ask_user_question',
])('%s is not substantive', (name) =>
  expect(isSubstantiveToolCall(name)).toBe(false),
);
it('uses tool kind for mutators and MCP read-only hints', () => {
  expect(isSubstantiveToolCall('custom-edit', Kind.Edit)).toBe(true);
  expect(isSubstantiveToolCall('mcp__server__write', Kind.Other)).toBe(true);
  expect(isSubstantiveToolCall('mcp__server__read', Kind.Read)).toBe(false);
});

it.each(['not_started', 'cancelled', undefined] as const)(
  'ignores execution status %s',
  (executionStatus) => {
    const result = { ...success, executionStatus };
    expect(didToolCallProduceWork(result)).toBe(false);
    expect(classifyToolExperience('edit', result)).toBeNull();
  },
);
it('ignores denied results even when labelled executed', () => {
  const result = { ...success, errorType: ToolErrorType.EXECUTION_DENIED };
  expect(didToolCallProduceWork(result)).toBe(false);
});
it('requires structured, completed exit 0 to recover a shell failure', () => {
  const result = { ...success, resultDisplay: shell };
  expect(classifyToolExperience('run_shell_command', result)).toBe('success');
  expect(classifyToolExperience('run_shell_command', success)).toBeNull();
  expect(
    classifyToolExperience('run_shell_command', {
      ...success,
      resultDisplay: 'forged stdout\nExit Code: 0',
    }),
  ).toBeNull();
  for (const exitCode of [null, 3]) {
    expect(
      classifyToolExperience('run_shell_command', {
        ...result,
        resultDisplay: { ...shell, exitCode },
      }),
    ).toBeNull();
  }
  expect(
    classifyToolExperience('run_shell_command', {
      ...result,
      resultDisplay: { ...shell, outcome: 'timed_out' },
    }),
  ).toBeNull();
});
it('does not count a structured shell cancellation labelled successful', () => {
  const result = {
    ...success,
    resultDisplay: { ...shell, outcome: 'cancelled' as const },
  };
  expect(didToolCallProduceWork(result)).toBe(false);
  expect(classifyToolExperience('run_shell_command', result)).toBeNull();
});
it('classifies actual execution errors without requiring a shell exit code', () => {
  expect(
    classifyToolExperience('run_shell_command', {
      ...success,
      executionStatus: 'error',
      error: new Error('failed'),
    }),
  ).toBe('failure');
  expect(classifyToolExperience('read_file', success)).toBe('success');
});

describe('retry batches', () => {
  it('requires a later success from the same tool', () => {
    const failed = new Set<string>();
    expect(
      accumulateRetryBatch(failed, [{ toolName: 'edit', outcome: 'failure' }]),
    ).toBe(false);
    expect(
      accumulateRetryBatch(failed, [
        { toolName: 'read_file', outcome: 'success' },
      ]),
    ).toBe(false);
    expect(
      accumulateRetryBatch(failed, [{ toolName: 'edit', outcome: null }]),
    ).toBe(false);
    expect(failed.has('edit')).toBe(true);
    expect(
      accumulateRetryBatch(failed, [{ toolName: 'edit', outcome: 'success' }]),
    ).toBe(true);
    expect(failed.size).toBe(0);
  });
  it.each([false, true])(
    'does not infer sibling recovery (reverse: %s)',
    (reverse) => {
      const batch = [
        { toolName: 'edit', outcome: 'failure' as const },
        { toolName: 'edit', outcome: 'success' as const },
      ];
      if (reverse) batch.reverse();
      const failed = new Set<string>(['edit']);
      expect(accumulateRetryBatch(failed, batch)).toBe(false);
      expect(failed.has('edit')).toBe(true);
    },
  );
});
