/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, describe, it } from 'vitest';
import { doesToolInvocationMatch, isToolEnabled } from './tool-utils.js';
import type { AnyToolInvocation, Config } from '../index.js';
import { ReadFileTool } from '../tools/read-file.js';
import { ToolNames } from '../tools/tool-names.js';

describe('doesToolInvocationMatch', () => {
  it('should not match a partial command prefix', () => {
    const invocation = {
      params: { command: 'git commitsomething' },
    } as AnyToolInvocation;
    const patterns = ['ShellTool(git commit)'];
    const result = doesToolInvocationMatch(
      'run_shell_command',
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
      'run_shell_command',
      invocation,
      patterns,
    );
    expect(result).toBe(true);
  });

  it('should match a command that is a prefix', () => {
    const invocation = {
      params: { command: 'git status -v' },
    } as AnyToolInvocation;
    const patterns = ['ShellTool(git status)'];
    const result = doesToolInvocationMatch(
      'run_shell_command',
      invocation,
      patterns,
    );
    expect(result).toBe(true);
  });

  describe('for non-shell tools', () => {
    const readFileTool = new ReadFileTool({} as Config);
    const invocation = {
      params: { file: 'test.txt' },
    } as AnyToolInvocation;

    it('should match by tool name', () => {
      const patterns = ['read_file'];
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
      const patterns = ['read_file'];
      const result = doesToolInvocationMatch('read_file', invocation, patterns);
      expect(result).toBe(true);
    });
  });
});

describe('isToolEnabled', () => {
  it('enables tool when coreTools is undefined and tool is not excluded', () => {
    expect(isToolEnabled(ToolNames.SHELL, undefined, undefined)).toBe(true);
  });

  it('disables tool when excluded by canonical tool name', () => {
    expect(
      isToolEnabled(ToolNames.SHELL, undefined, ['run_shell_command']),
    ).toBe(false);
  });

  it('enables tool when explicitly listed by display name', () => {
    expect(isToolEnabled(ToolNames.SHELL, ['Shell'], undefined)).toBe(true);
  });

  it('enables tool when explicitly listed by class name', () => {
    expect(isToolEnabled(ToolNames.SHELL, ['ShellTool'], undefined)).toBe(true);
  });

  it('supports class names with leading underscores', () => {
    expect(isToolEnabled(ToolNames.SHELL, ['__ShellTool'], undefined)).toBe(
      true,
    );
  });

  it('enables tool when coreTools contains a legacy tool name alias', () => {
    expect(
      isToolEnabled(ToolNames.GREP, ['search_file_content'], undefined),
    ).toBe(true);
  });

  it('enables tool when coreTools contains a legacy display name alias', () => {
    expect(isToolEnabled(ToolNames.GLOB, ['FindFiles'], undefined)).toBe(true);
  });

  it('enables tool when coreTools contains an argument-specific pattern', () => {
    expect(
      isToolEnabled(ToolNames.SHELL, ['Shell(git status)'], undefined),
    ).toBe(true);
  });

  it('disables tool when not present in coreTools', () => {
    expect(isToolEnabled(ToolNames.SHELL, ['Edit'], undefined)).toBe(false);
  });

  it('uses legacy display name aliases when excluding tools', () => {
    expect(isToolEnabled(ToolNames.GREP, undefined, ['SearchFiles'])).toBe(
      false,
    );
  });

  it('does not treat argument-specific exclusions as matches', () => {
    expect(
      isToolEnabled(ToolNames.SHELL, undefined, ['Shell(git status)']),
    ).toBe(true);
  });

  it('considers excludeTools even when tool is explicitly enabled', () => {
    expect(isToolEnabled(ToolNames.SHELL, ['Shell'], ['ShellTool'])).toBe(
      false,
    );
  });
});
