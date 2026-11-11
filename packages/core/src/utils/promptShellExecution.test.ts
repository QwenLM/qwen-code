/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  executeShellCommandsInPrompt,
  PromptShellExecutionError,
} from './promptShellExecution.js';

describe('executeShellCommandsInPrompt', () => {
  const mockExecutor = vi.fn<(command: string) => Promise<string>>();

  beforeEach(() => {
    mockExecutor.mockReset();
  });

  it('should return text unchanged when no shell markers exist', async () => {
    const text = 'Hello world, no shell here.';
    const result = await executeShellCommandsInPrompt(
      text,
      mockExecutor,
      'test-skill',
    );
    expect(result).toBe(text);
    expect(mockExecutor).not.toHaveBeenCalled();
  });

  it('should replace inline !`command` with executor output', async () => {
    mockExecutor.mockResolvedValue('hello');
    const text = 'Say !`echo hello` please';
    const result = await executeShellCommandsInPrompt(
      text,
      mockExecutor,
      'test-skill',
    );
    expect(result).toBe('Say hello please');
    expect(mockExecutor).toHaveBeenCalledWith('echo hello');
  });

  it('should replace code block ```! command ``` with executor output', async () => {
    mockExecutor.mockResolvedValue('2026-04-16');
    const text = 'Today is:\n```!\ndate +%Y-%m-%d\n```\nEnd.';
    const result = await executeShellCommandsInPrompt(
      text,
      mockExecutor,
      'test-skill',
    );
    expect(result).toBe('Today is:\n2026-04-16\nEnd.');
    expect(mockExecutor).toHaveBeenCalledWith('date +%Y-%m-%d');
  });

  it('should handle multiple inline commands', async () => {
    mockExecutor.mockResolvedValueOnce('alice').mockResolvedValueOnce('bob');
    const text = 'User: !`whoami` Host: !`hostname`';
    const result = await executeShellCommandsInPrompt(
      text,
      mockExecutor,
      'test-skill',
    );
    expect(result).toBe('User: alice Host: bob');
    expect(mockExecutor).toHaveBeenCalledTimes(2);
  });

  it('should handle mixed inline and code block commands', async () => {
    mockExecutor
      .mockResolvedValueOnce('block-output')
      .mockResolvedValueOnce('inline-output');
    const text = '```!\nls\n```\nand !`pwd`';
    const result = await executeShellCommandsInPrompt(
      text,
      mockExecutor,
      'test-skill',
    );
    expect(result).toBe('block-output\nand inline-output');
    expect(mockExecutor).toHaveBeenCalledTimes(2);
  });

  it('should not corrupt output containing $ characters', async () => {
    mockExecutor.mockResolvedValue('$HOME is /Users/test and $$ is 1234');
    const text = 'Path: !`echo $HOME`';
    const result = await executeShellCommandsInPrompt(
      text,
      mockExecutor,
      'test-skill',
    );
    expect(result).toBe('Path: $HOME is /Users/test and $$ is 1234');
  });

  it('should not match !` inside a word (no leading whitespace)', async () => {
    // The lookbehind requires start-of-line or whitespace before !`
    const text = 'foo!`bar`';
    const result = await executeShellCommandsInPrompt(
      text,
      mockExecutor,
      'test-skill',
    );
    expect(result).toBe('foo!`bar`');
    expect(mockExecutor).not.toHaveBeenCalled();
  });

  it('should match !` at start of line', async () => {
    mockExecutor.mockResolvedValue('result');
    const text = '!`date`';
    const result = await executeShellCommandsInPrompt(
      text,
      mockExecutor,
      'test-skill',
    );
    expect(result).toBe('result');
  });

  it('should propagate executor errors as PromptShellExecutionError', async () => {
    mockExecutor.mockRejectedValue(new Error('permission denied'));
    const text = 'Run !`rm -rf /`';
    await expect(
      executeShellCommandsInPrompt(text, mockExecutor, 'danger-skill'),
    ).rejects.toThrow(PromptShellExecutionError);
    await expect(
      executeShellCommandsInPrompt(text, mockExecutor, 'danger-skill'),
    ).rejects.toThrow(/permission denied/);
  });

  it('should handle empty command output', async () => {
    mockExecutor.mockResolvedValue('');
    const text = 'Before !`true` After';
    const result = await executeShellCommandsInPrompt(
      text,
      mockExecutor,
      'test-skill',
    );
    expect(result).toBe('Before  After');
  });

  it('should handle multiline code block command', async () => {
    mockExecutor.mockResolvedValue('combined-output');
    const text = '```!\ncd /tmp\nls -la\n```';
    const result = await executeShellCommandsInPrompt(
      text,
      mockExecutor,
      'test-skill',
    );
    expect(result).toBe('combined-output');
    expect(mockExecutor).toHaveBeenCalledWith('cd /tmp\nls -la');
  });

  it('should handle output containing replacement pattern characters', async () => {
    // String.replace would interpret $& as the matched string,
    // $` as the portion before the match, $' as the portion after.
    // Our implementation should handle these safely.
    mockExecutor.mockResolvedValue("$& $` $' $$");
    const text = 'Output: !`special`';
    const result = await executeShellCommandsInPrompt(
      text,
      mockExecutor,
      'test-skill',
    );
    expect(result).toBe("Output: $& $` $' $$");
  });
});
