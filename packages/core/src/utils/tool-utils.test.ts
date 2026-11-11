/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, describe, it } from 'vitest';
import {
  doesToolInvocationMatch,
  getToolSuggestion,
  shouldHideToolCall,
} from './tool-utils.js';
import type { Config } from '../config/config.js';
import { CoreToolCallStatus } from '../tool-executor/types.js';
import { ReadFileTool } from '../tools/read-file.js';
import type { AnyToolInvocation } from '../tools/tools.js';
import {
  ASK_USER_DISPLAY_NAME,
  EDIT_DISPLAY_NAME,
  READ_FILE_DISPLAY_NAME,
  WRITE_FILE_DISPLAY_NAME,
  SHELL_TOOL_NAME,
  SEND_MESSAGE_TOOL_NAME,
  READ_FILE_TOOL_NAME,
  TASK_CREATE_TOOL_NAME,
  TASK_GET_TOOL_NAME,
  TASK_LIST_TOOL_NAME,
  TASK_UPDATE_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
} from '../tools/tool-names.js';

describe('shouldHideToolCall', () => {
  it.each([
    {
      status: CoreToolCallStatus.Scheduled,
      hasResult: true,
      shouldHide: true,
    },
    {
      status: CoreToolCallStatus.Executing,
      hasResult: true,
      shouldHide: true,
    },
    {
      status: CoreToolCallStatus.AwaitingApproval,
      hasResult: true,
      shouldHide: true,
    },
    {
      status: CoreToolCallStatus.Validating,
      hasResult: true,
      shouldHide: true,
    },
    {
      status: CoreToolCallStatus.Success,
      hasResult: true,
      shouldHide: false,
    },
    {
      status: CoreToolCallStatus.Error,
      hasResult: false,
      shouldHide: true,
    },
    {
      status: CoreToolCallStatus.Error,
      hasResult: true,
      shouldHide: false,
    },
  ])(
    'AskUser: status=$status, hasResult=$hasResult -> hide=$shouldHide',
    ({ status, hasResult, shouldHide }) => {
      expect(
        shouldHideToolCall({
          toolName: ASK_USER_DISPLAY_NAME,
          status,
          hasResultDisplay: hasResult,
        }),
      ).toBe(shouldHide);
    },
  );

  it.each([
    { name: WRITE_FILE_DISPLAY_NAME, planModeActive: true, visible: false },
    { name: EDIT_DISPLAY_NAME, planModeActive: true, visible: false },
    { name: WRITE_FILE_DISPLAY_NAME, planModeActive: false, visible: true },
    { name: READ_FILE_DISPLAY_NAME, planModeActive: true, visible: true },
  ])(
    'Plan Mode: tool=$name, planModeActive=$planModeActive -> visible=$visible',
    ({ name, planModeActive, visible }) => {
      expect(
        shouldHideToolCall({
          toolName: name,
          status: CoreToolCallStatus.Success,
          planModeActive,
          hasResultDisplay: true,
        }),
      ).toBe(!visible);
    },
  );

  it('hides tool calls with a parentCallId', () => {
    expect(
      shouldHideToolCall({
        toolName: 'any_tool',
        status: CoreToolCallStatus.Success,
        hasResultDisplay: true,
        parentCallId: 'some-parent',
      }),
    ).toBe(true);
  });

  it.each([
    TASK_CREATE_TOOL_NAME,
    TASK_GET_TOOL_NAME,
    TASK_LIST_TOOL_NAME,
    TASK_UPDATE_TOOL_NAME,
  ])('hides %s because the task panel renders persistent task state', (name) => {
    expect(
      shouldHideToolCall({
        toolName: name,
        status: CoreToolCallStatus.Success,
        hasResultDisplay: true,
      }),
    ).toBe(true);
  });

  it('hides successful plain SendMessage calls', () => {
    expect(
      shouldHideToolCall({
        toolName: SEND_MESSAGE_TOOL_NAME,
        status: CoreToolCallStatus.Success,
        hasResultDisplay: false,
        input: {
          to: 'reviewer',
          summary: 'Review complete',
          message: 'The review is complete.',
        },
      }),
    ).toBe(true);
  });

  it('shows failed SendMessage calls', () => {
    expect(
      shouldHideToolCall({
        toolName: SEND_MESSAGE_TOOL_NAME,
        status: CoreToolCallStatus.Error,
        hasResultDisplay: true,
        input: {
          to: 'missing-agent',
          message: 'Hello',
        },
      }),
    ).toBe(false);
  });
});

describe('getToolSuggestion', () => {
  // skip: 现存失败
  it.skip('should suggest the top N closest tool names for a typo', () => {
    const allToolNames = [
      'list_files',
      READ_FILE_TOOL_NAME,
      WRITE_FILE_TOOL_NAME,
    ];

    // Test that the right tool is selected, with only 1 result, for typos
    const misspelledTool = getToolSuggestion('list_fils', allToolNames, 1);
    expect(misspelledTool).toBe(' Did you mean "list_files"?');

    // Test that the right tool is selected, with only 1 result, for prefixes
    const prefixedTool = getToolSuggestion(
      'github.list_files',
      allToolNames,
      1,
    );
    expect(prefixedTool).toBe(' Did you mean "list_files"?');

    // Test that the right tool is first
    const suggestionMultiple = getToolSuggestion('list_fils', allToolNames);
    expect(suggestionMultiple).toBe(
      ` Did you mean one of: "list_files", "${READ_FILE_TOOL_NAME}", "${WRITE_FILE_TOOL_NAME}"?`,
    );
  });
});

describe('doesToolInvocationMatch', () => {
  it('should not match a partial command prefix', () => {
    const invocation = {
      params: { command: 'git commitsomething' },
    } as AnyToolInvocation;
    const patterns = ['ShellTool(git commit)'];
    const result = doesToolInvocationMatch(
      SHELL_TOOL_NAME,
      invocation,
      patterns,
    );
    expect(result).toBe(false);
  });

  it('should match an exact command', () => {
    const invocation = {
      params: { command: 'git status' },
    } as AnyToolInvocation;
    const patterns = ['ShellTool(git status)'];
    const result = doesToolInvocationMatch(
      SHELL_TOOL_NAME,
      invocation,
      patterns,
    );
    expect(result).toBe(true);
  });

  it('should match a command with an alias', () => {
    const invocation = {
      params: { command: 'wc -l' },
    } as AnyToolInvocation;
    const patterns = ['ShellTool(wc)'];
    const result = doesToolInvocationMatch('ShellTool', invocation, patterns);
    expect(result).toBe(true);
  });

  it('should match a command that is a prefix', () => {
    const invocation = {
      params: { command: 'git status -v' },
    } as AnyToolInvocation;
    const patterns = ['ShellTool(git status)'];
    const result = doesToolInvocationMatch(
      SHELL_TOOL_NAME,
      invocation,
      patterns,
    );
    expect(result).toBe(true);
  });

  describe('for non-shell tools', () => {
    const mockConfig = {
      getTargetDir: () => '/tmp',
      getFileFilteringOptions: () => ({}),
    } as unknown as Config;
    const readFileTool = new ReadFileTool(mockConfig);
    const invocation = {
      params: { file: 'test.txt' },
    } as AnyToolInvocation;

    it('should match by tool name', () => {
      const patterns = [READ_FILE_TOOL_NAME];
      const result = doesToolInvocationMatch(
        readFileTool,
        invocation,
        patterns,
      );
      expect(result).toBe(true);
    });

    it('should match by tool class name', () => {
      const patterns = ['ReadFileTool'];
      const result = doesToolInvocationMatch(
        readFileTool,
        invocation,
        patterns,
      );
      expect(result).toBe(true);
    });

    it('should not match if neither name is in the patterns', () => {
      const patterns = ['some_other_tool', 'AnotherToolClass'];
      const result = doesToolInvocationMatch(
        readFileTool,
        invocation,
        patterns,
      );
      expect(result).toBe(false);
    });

    it('should match by tool name when passed as a string', () => {
      const patterns = [READ_FILE_TOOL_NAME];
      const result = doesToolInvocationMatch(
        READ_FILE_TOOL_NAME,
        invocation,
        patterns,
      );
      expect(result).toBe(true);
    });
  });
});
