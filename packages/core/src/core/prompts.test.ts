/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  getCoreSystemPrompt,
  getCustomSystemPrompt,
  getSubagentSystemReminder,
  getPlanModeSystemReminder,
  resolvePathFromEnv,
} from './prompts.js';
import { isGitRepository } from '../utils/gitUtils.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { QWEN_CONFIG_DIR } from '../tools/memoryTool.js';

// Mock tool names if they are dynamically generated or complex
vi.mock('../tools/ls', () => ({ LSTool: { Name: 'list_directory' } }));
vi.mock('../tools/edit', () => ({ EditTool: { Name: 'edit' } }));
vi.mock('../tools/glob', () => ({ GlobTool: { Name: 'glob' } }));
vi.mock('../tools/grep', () => ({ GrepTool: { Name: 'search_file_content' } }));
vi.mock('../tools/read-file', () => ({ ReadFileTool: { Name: 'read_file' } }));
vi.mock('../tools/read-many-files', () => ({
  ReadManyFilesTool: { Name: 'read_many_files' },
}));
vi.mock('../tools/shell', () => ({
  ShellTool: { Name: 'run_shell_command' },
}));
vi.mock('../tools/write-file', () => ({
  WriteFileTool: { Name: 'write_file' },
}));
vi.mock('../utils/gitUtils', () => ({
  isGitRepository: vi.fn(),
}));
vi.mock('node:fs');

describe('Core System Prompt (prompts.ts)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('QWEN_SYSTEM_MD', undefined);
    vi.stubEnv('QWEN_WRITE_SYSTEM_MD', undefined);
  });

  it('should return the base prompt when no userMemory is provided', () => {
    vi.stubEnv('SANDBOX', undefined);
    const prompt = getCoreSystemPrompt();
    expect(prompt).not.toContain('---\n\n'); // Separator should not be present
    expect(prompt).toContain('You are Qwen Code, an interactive CLI agent'); // Check for core content
    expect(prompt).toMatchSnapshot(); // Use snapshot for base prompt structure
  });

  it('should return the base prompt when userMemory is empty string', () => {
    vi.stubEnv('SANDBOX', undefined);
    const prompt = getCoreSystemPrompt('');
    expect(prompt).not.toContain('---\n\n');
    expect(prompt).toContain('You are Qwen Code, an interactive CLI agent');
    expect(prompt).toMatchSnapshot();
  });

  it('should return the base prompt when userMemory is whitespace only', () => {
    vi.stubEnv('SANDBOX', undefined);
    const prompt = getCoreSystemPrompt('   \n  \t ');
    expect(prompt).not.toContain('---\n\n');
    expect(prompt).toContain('You are Qwen Code, an interactive CLI agent');
    expect(prompt).toMatchSnapshot();
  });

  it('should append userMemory with separator when provided', () => {
    vi.stubEnv('SANDBOX', undefined);
    const memory = 'This is custom user memory.\nBe extra polite.';
    const expectedSuffix = `\n\n---\n\n${memory}`;
    const prompt = getCoreSystemPrompt(memory);

    expect(prompt.endsWith(expectedSuffix)).toBe(true);
    expect(prompt).toContain('You are Qwen Code, an interactive CLI agent'); // Ensure base prompt follows
    expect(prompt).toMatchSnapshot(); // Snapshot the combined prompt
  });

  it('should include sandbox-specific instructions when SANDBOX env var is set', () => {
    vi.stubEnv('SANDBOX', 'true'); // Generic sandbox value
    const prompt = getCoreSystemPrompt();
    expect(prompt).toContain('# Sandbox');
    expect(prompt).not.toContain('# macOS Seatbelt');
    expect(prompt).not.toContain('# Outside of Sandbox');
    expect(prompt).toMatchSnapshot();
  });

  it('should include seatbelt-specific instructions when SANDBOX env var is "sandbox-exec"', () => {
    vi.stubEnv('SANDBOX', 'sandbox-exec');
    const prompt = getCoreSystemPrompt();
    expect(prompt).toContain('# macOS Seatbelt');
    expect(prompt).not.toContain('# Sandbox');
    expect(prompt).not.toContain('# Outside of Sandbox');
    expect(prompt).toMatchSnapshot();
  });

  it('should include non-sandbox instructions when SANDBOX env var is not set', () => {
    vi.stubEnv('SANDBOX', undefined); // Ensure it's not set
    const prompt = getCoreSystemPrompt();
    expect(prompt).toContain('# Outside of Sandbox');
    expect(prompt).not.toContain('# Sandbox');
    expect(prompt).not.toContain('# macOS Seatbelt');
    expect(prompt).toMatchSnapshot();
  });

  it('should include git instructions when in a git repo', () => {
    vi.stubEnv('SANDBOX', undefined);
    vi.mocked(isGitRepository).mockReturnValue(true);
    const prompt = getCoreSystemPrompt();
    expect(prompt).toContain('# Git Repository');
    expect(prompt).toMatchSnapshot();
  });

  it('should not include git instructions when not in a git repo', () => {
    vi.stubEnv('SANDBOX', undefined);
    vi.mocked(isGitRepository).mockReturnValue(false);
    const prompt = getCoreSystemPrompt();
    expect(prompt).not.toContain('# Git Repository');
    expect(prompt).toMatchSnapshot();
  });

  describe('QWEN_SYSTEM_MD environment variable', () => {
    it('should use default prompt when QWEN_SYSTEM_MD is "false"', () => {
      vi.stubEnv('QWEN_SYSTEM_MD', 'false');
      const prompt = getCoreSystemPrompt();
      expect(fs.readFileSync).not.toHaveBeenCalled();
      expect(prompt).not.toContain('custom system prompt');
    });

    it('should use default prompt when QWEN_SYSTEM_MD is "0"', () => {
      vi.stubEnv('QWEN_SYSTEM_MD', '0');
      const prompt = getCoreSystemPrompt();
      expect(fs.readFileSync).not.toHaveBeenCalled();
      expect(prompt).not.toContain('custom system prompt');
    });

    it('should throw error if QWEN_SYSTEM_MD points to a non-existent file', () => {
      const customPath = '/non/existent/path/system.md';
      vi.stubEnv('QWEN_SYSTEM_MD', customPath);
      vi.mocked(fs.existsSync).mockReturnValue(false);
      expect(() => getCoreSystemPrompt()).toThrow(
        `missing system prompt file '${path.resolve(customPath)}'`,
      );
    });

    it('should read from default path when QWEN_SYSTEM_MD is "true"', () => {
      const defaultPath = path.resolve(path.join(QWEN_CONFIG_DIR, 'system.md'));
      vi.stubEnv('QWEN_SYSTEM_MD', 'true');
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('custom system prompt');

      const prompt = getCoreSystemPrompt();
      expect(fs.readFileSync).toHaveBeenCalledWith(defaultPath, 'utf8');
      expect(prompt).toBe('custom system prompt');
    });

    it('should read from default path when QWEN_SYSTEM_MD is "1"', () => {
      const defaultPath = path.resolve(path.join(QWEN_CONFIG_DIR, 'system.md'));
      vi.stubEnv('QWEN_SYSTEM_MD', '1');
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('custom system prompt');

      const prompt = getCoreSystemPrompt();
      expect(fs.readFileSync).toHaveBeenCalledWith(defaultPath, 'utf8');
      expect(prompt).toBe('custom system prompt');
    });

    it('should read from custom path when QWEN_SYSTEM_MD provides one, preserving case', () => {
      const customPath = path.resolve('/custom/path/SyStEm.Md');
      vi.stubEnv('QWEN_SYSTEM_MD', customPath);
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('custom system prompt');

      const prompt = getCoreSystemPrompt();
      expect(fs.readFileSync).toHaveBeenCalledWith(customPath, 'utf8');
      expect(prompt).toBe('custom system prompt');
    });

    it('should expand tilde in custom path when QWEN_SYSTEM_MD is set', () => {
      const homeDir = '/Users/test';
      vi.spyOn(os, 'homedir').mockReturnValue(homeDir);
      const customPath = '~/custom/system.md';
      const expectedPath = path.join(homeDir, 'custom/system.md');
      vi.stubEnv('QWEN_SYSTEM_MD', customPath);
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('custom system prompt');

      const prompt = getCoreSystemPrompt();
      expect(fs.readFileSync).toHaveBeenCalledWith(
        path.resolve(expectedPath),
        'utf8',
      );
      expect(prompt).toBe('custom system prompt');
    });
  });

  describe('QWEN_WRITE_SYSTEM_MD environment variable', () => {
    it('should not write to file when QWEN_WRITE_SYSTEM_MD is "false"', () => {
      vi.stubEnv('QWEN_WRITE_SYSTEM_MD', 'false');
      getCoreSystemPrompt();
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });

    it('should not write to file when QWEN_WRITE_SYSTEM_MD is "0"', () => {
      vi.stubEnv('QWEN_WRITE_SYSTEM_MD', '0');
      getCoreSystemPrompt();
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });

    it('should write to default path when QWEN_WRITE_SYSTEM_MD is "true"', () => {
      const defaultPath = path.resolve(path.join(QWEN_CONFIG_DIR, 'system.md'));
      vi.stubEnv('QWEN_WRITE_SYSTEM_MD', 'true');
      getCoreSystemPrompt();
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        defaultPath,
        expect.any(String),
      );
    });

    it('should write to default path when QWEN_WRITE_SYSTEM_MD is "1"', () => {
      const defaultPath = path.resolve(path.join(QWEN_CONFIG_DIR, 'system.md'));
      vi.stubEnv('QWEN_WRITE_SYSTEM_MD', '1');
      getCoreSystemPrompt();
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        defaultPath,
        expect.any(String),
      );
    });

    it('should write to custom path when QWEN_WRITE_SYSTEM_MD provides one', () => {
      const customPath = path.resolve('/custom/path/system.md');
      vi.stubEnv('QWEN_WRITE_SYSTEM_MD', customPath);
      getCoreSystemPrompt();
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        customPath,
        expect.any(String),
      );
    });

    it('should expand tilde in custom path when QWEN_WRITE_SYSTEM_MD is set', () => {
      const homeDir = '/Users/test';
      vi.spyOn(os, 'homedir').mockReturnValue(homeDir);
      const customPath = '~/custom/system.md';
      const expectedPath = path.join(homeDir, 'custom/system.md');
      vi.stubEnv('QWEN_WRITE_SYSTEM_MD', customPath);
      getCoreSystemPrompt();
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        path.resolve(expectedPath),
        expect.any(String),
      );
    });

    it('should expand tilde in custom path when QWEN_WRITE_SYSTEM_MD is just ~', () => {
      const homeDir = '/Users/test';
      vi.spyOn(os, 'homedir').mockReturnValue(homeDir);
      const customPath = '~';
      const expectedPath = homeDir;
      vi.stubEnv('QWEN_WRITE_SYSTEM_MD', customPath);
      getCoreSystemPrompt();
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        path.resolve(expectedPath),
        expect.any(String),
      );
    });
  });
});

describe('Model-specific tool call formats', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('SANDBOX', undefined);
  });

  it('should use XML format for qwen3-coder model', () => {
    vi.mocked(isGitRepository).mockReturnValue(false);
    const prompt = getCoreSystemPrompt(undefined, 'qwen3-coder-7b');

    // Should contain XML-style tool calls
    expect(prompt).toContain('<tool_call>');
    expect(prompt).toContain('<function=run_shell_command>');
    expect(prompt).toContain('<parameter=command>');
    expect(prompt).toContain('</function>');
    expect(prompt).toContain('</tool_call>');

    // Should NOT contain bracket-style tool calls
    expect(prompt).not.toContain('[tool_call: run_shell_command for');

    // Should NOT contain JSON-style tool calls
    expect(prompt).not.toContain('{"name": "run_shell_command"');

    expect(prompt).toMatchSnapshot();
  });

  it('should use JSON format for qwen-vl model', () => {
    vi.mocked(isGitRepository).mockReturnValue(false);
    const prompt = getCoreSystemPrompt(undefined, 'qwen-vl-max');

    // Should contain JSON-style tool calls
    expect(prompt).toContain('<tool_call>');
    expect(prompt).toContain('{"name": "run_shell_command"');
    expect(prompt).toContain('"arguments": {"command": "node server.js &"}');
    expect(prompt).toContain('</tool_call>');

    // Should NOT contain bracket-style tool calls
    expect(prompt).not.toContain('[tool_call: run_shell_command for');

    // Should NOT contain XML-style tool calls with parameters
    expect(prompt).not.toContain('<function=run_shell_command>');
    expect(prompt).not.toContain('<parameter=command>');

    expect(prompt).toMatchSnapshot();
  });

  it('should use bracket format for generic models', () => {
    vi.mocked(isGitRepository).mockReturnValue(false);
    const prompt = getCoreSystemPrompt(undefined, 'gpt-4');

    // Should contain bracket-style tool calls
    expect(prompt).toContain('[tool_call: run_shell_command for');
    expect(prompt).toContain('because it must run in the background]');

    // Should NOT contain XML-style tool calls
    expect(prompt).not.toContain('<function=run_shell_command>');
    expect(prompt).not.toContain('<parameter=command>');

    // Should NOT contain JSON-style tool calls
    expect(prompt).not.toContain('{"name": "run_shell_command"');

    expect(prompt).toMatchSnapshot();
  });

  it('should use bracket format when no model is specified', () => {
    vi.mocked(isGitRepository).mockReturnValue(false);
    const prompt = getCoreSystemPrompt();

    // Should contain bracket-style tool calls (default behavior)
    expect(prompt).toContain('[tool_call: run_shell_command for');
    expect(prompt).toContain('because it must run in the background]');

    // Should NOT contain XML or JSON formats
    expect(prompt).not.toContain('<function=run_shell_command>');
    expect(prompt).not.toContain('{"name": "run_shell_command"');

    expect(prompt).toMatchSnapshot();
  });

  it('should preserve model-specific formats with user memory', () => {
    vi.mocked(isGitRepository).mockReturnValue(false);
    const userMemory = 'User prefers concise responses.';
    const prompt = getCoreSystemPrompt(userMemory, 'qwen3-coder-14b');

    // Should contain XML-style tool calls
    expect(prompt).toContain('<tool_call>');
    expect(prompt).toContain('<function=run_shell_command>');

    // Should contain user memory with separator
    expect(prompt).toContain('---');
    expect(prompt).toContain('User prefers concise responses.');

    expect(prompt).toMatchSnapshot();
  });

  it('should preserve model-specific formats with sandbox environment', () => {
    vi.stubEnv('SANDBOX', 'true');
    vi.mocked(isGitRepository).mockReturnValue(false);
    const prompt = getCoreSystemPrompt(undefined, 'qwen-vl-plus');

    // Should contain JSON-style tool calls
    expect(prompt).toContain('{"name": "run_shell_command"');

    // Should contain sandbox instructions
    expect(prompt).toContain('# Sandbox');

    expect(prompt).toMatchSnapshot();
  });
});

describe('getCustomSystemPrompt', () => {
  it('should handle string custom instruction without user memory', () => {
    const customInstruction =
      'You are a helpful assistant specialized in code review.';
    const result = getCustomSystemPrompt(customInstruction);

    expect(result).toBe(
      'You are a helpful assistant specialized in code review.',
    );
    expect(result).not.toContain('---');
  });

  it('should handle string custom instruction with user memory', () => {
    const customInstruction =
      'You are a helpful assistant specialized in code review.';
    const userMemory =
      'Remember to be extra thorough.\nFocus on security issues.';
    const result = getCustomSystemPrompt(customInstruction, userMemory);

    expect(result).toBe(
      'You are a helpful assistant specialized in code review.\n\n---\n\nRemember to be extra thorough.\nFocus on security issues.',
    );
    expect(result).toContain('---');
  });

  it('should handle Content object with parts array and user memory', () => {
    const customInstruction = {
      parts: [
        { text: 'You are a code assistant. ' },
        { text: 'Always provide examples.' },
      ],
    };
    const userMemory = 'User prefers TypeScript examples.';
    const result = getCustomSystemPrompt(customInstruction, userMemory);

    expect(result).toBe(
      'You are a code assistant. Always provide examples.\n\n---\n\nUser prefers TypeScript examples.',
    );
    expect(result).toContain('---');
  });
});

describe('getSubagentSystemReminder', () => {
  it('should format single agent type correctly', () => {
    const result = getSubagentSystemReminder(['python']);

    expect(result).toMatch(/^<system-reminder>.*<\/system-reminder>$/);
    expect(result).toContain('available agent types are: python');
    expect(result).toContain('PROACTIVELY use the');
  });

  it('should join multiple agent types with commas', () => {
    const result = getSubagentSystemReminder(['python', 'web', 'analysis']);

    expect(result).toContain(
      'available agent types are: python, web, analysis',
    );
  });

  it('should handle empty array', () => {
    const result = getSubagentSystemReminder([]);

    expect(result).toContain('available agent types are: ');
    expect(result).toContain('<system-reminder>');
  });
});

describe('getPlanModeSystemReminder', () => {
  it('should return plan mode system reminder with proper structure', () => {
    const result = getPlanModeSystemReminder();

    expect(result).toMatch(/^<system-reminder>[\s\S]*<\/system-reminder>$/);
    expect(result).toContain('Plan mode is active');
    expect(result).toContain('MUST NOT make any edits');
  });

  it('should include workflow instructions', () => {
    const result = getPlanModeSystemReminder();

    expect(result).toContain("1. Answer the user's query comprehensively");
    expect(result).toContain("2. When you're done researching");
    expect(result).toContain('exit_plan_mode tool');
  });

  it('should be deterministic', () => {
    const result1 = getPlanModeSystemReminder();
    const result2 = getPlanModeSystemReminder();

    expect(result1).toBe(result2);
  });
});

describe('resolvePathFromEnv helper function', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe('when envVar is undefined, empty, or whitespace', () => {
    it('should return null for undefined', () => {
      const result = resolvePathFromEnv(undefined);
      expect(result).toEqual({
        isSwitch: false,
        value: null,
        isDisabled: false,
      });
    });

    it('should return null for empty string', () => {
      const result = resolvePathFromEnv('');
      expect(result).toEqual({
        isSwitch: false,
        value: null,
        isDisabled: false,
      });
    });

    it('should return null for whitespace only', () => {
      const result = resolvePathFromEnv('   \n\t  ');
      expect(result).toEqual({
        isSwitch: false,
        value: null,
        isDisabled: false,
      });
    });
  });

  describe('when envVar is a boolean-like string', () => {
    it('should handle "0" as disabled switch', () => {
      const result = resolvePathFromEnv('0');
      expect(result).toEqual({
        isSwitch: true,
        value: '0',
        isDisabled: true,
      });
    });

    it('should handle "false" as disabled switch', () => {
      const result = resolvePathFromEnv('false');
      expect(result).toEqual({
        isSwitch: true,
        value: 'false',
        isDisabled: true,
      });
    });

    it('should handle "1" as enabled switch', () => {
      const result = resolvePathFromEnv('1');
      expect(result).toEqual({
        isSwitch: true,
        value: '1',
        isDisabled: false,
      });
    });

    it('should handle "true" as enabled switch', () => {
      const result = resolvePathFromEnv('true');
      expect(result).toEqual({
        isSwitch: true,
        value: 'true',
        isDisabled: false,
      });
    });

    it('should be case-insensitive for boolean values', () => {
      expect(resolvePathFromEnv('FALSE')).toEqual({
        isSwitch: true,
        value: 'false',
        isDisabled: true,
      });
      expect(resolvePathFromEnv('TRUE')).toEqual({
        isSwitch: true,
        value: 'true',
        isDisabled: false,
      });
    });
  });

  describe('when envVar is a file path', () => {
    it('should resolve absolute paths', () => {
      const result = resolvePathFromEnv('/absolute/path/file.txt');
      expect(result).toEqual({
        isSwitch: false,
        value: path.resolve('/absolute/path/file.txt'),
        isDisabled: false,
      });
    });

    it('should resolve relative paths', () => {
      const result = resolvePathFromEnv('relative/path/file.txt');
      expect(result).toEqual({
        isSwitch: false,
        value: path.resolve('relative/path/file.txt'),
        isDisabled: false,
      });
    });

    it('should expand tilde to home directory', () => {
      const homeDir = '/Users/test';
      vi.spyOn(os, 'homedir').mockReturnValue(homeDir);

      const result = resolvePathFromEnv('~/documents/file.txt');
      expect(result).toEqual({
        isSwitch: false,
        value: path.resolve(path.join(homeDir, 'documents/file.txt')),
        isDisabled: false,
      });
    });

    it('should handle standalone tilde', () => {
      const homeDir = '/Users/test';
      vi.spyOn(os, 'homedir').mockReturnValue(homeDir);

      const result = resolvePathFromEnv('~');
      expect(result).toEqual({
        isSwitch: false,
        value: path.resolve(homeDir),
        isDisabled: false,
      });
    });

    it('should handle os.homedir() errors gracefully', () => {
      vi.spyOn(os, 'homedir').mockImplementation(() => {
        throw new Error('Cannot resolve home directory');
      });
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const result = resolvePathFromEnv('~/documents/file.txt');
      expect(result).toEqual({
        isSwitch: false,
        value: null,
        isDisabled: false,
      });
      expect(consoleSpy).toHaveBeenCalledWith(
        'Could not resolve home directory for path: ~/documents/file.txt',
        expect.any(Error),
      );

      consoleSpy.mockRestore();
    });
  });
});
