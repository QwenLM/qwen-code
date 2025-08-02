/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { getCoreSystemPrompt } from './prompts.js';
import { isGitRepository } from '../utils/gitUtils.js';

// Mock tool names if they are dynamically generated or complex
vi.mock('../tools/ls', () => ({ LSTool: { Name: 'list_directory' } }));
vi.mock('../tools/edit', () => ({ EditTool: { Name: 'replace' } }));
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

describe('Core System Prompt (prompts.ts)', () => {
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
    expect(prompt).not.toContain('# MacOS Seatbelt');
    expect(prompt).not.toContain('# Outside of Sandbox');
    expect(prompt).toMatchSnapshot();
  });

  it('should include seatbelt-specific instructions when SANDBOX env var is "sandbox-exec"', () => {
    vi.stubEnv('SANDBOX', 'sandbox-exec');
    const prompt = getCoreSystemPrompt();
    expect(prompt).toContain('# MacOS Seatbelt');
    expect(prompt).not.toContain('# Sandbox');
    expect(prompt).not.toContain('# Outside of Sandbox');
    expect(prompt).toMatchSnapshot();
  });

  it('should include non-sandbox instructions when SANDBOX env var is not set', () => {
    vi.stubEnv('SANDBOX', undefined); // Ensure it's not set
    const prompt = getCoreSystemPrompt();
    expect(prompt).toContain('# Outside of Sandbox');
    expect(prompt).not.toContain('# Sandbox');
    expect(prompt).not.toContain('# MacOS Seatbelt');
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
});

describe('URL matching with trailing slash compatibility', () => {
  it('should match URLs with and without trailing slash', () => {
    const config = {
      systemPromptMappings: [
        {
          baseUrls: ['https://api.example.com'],
          modelNames: ['gpt-4'],
          template: 'Custom template for example.com',
        },
        {
          baseUrls: ['https://api.openai.com/'],
          modelNames: ['gpt-3.5-turbo'],
          template: 'Custom template for openai.com',
        },
      ],
    };

    // Simulate environment variables
    const originalEnv = process.env;

    // Test case 1: No trailing slash in config, actual URL has trailing slash
    process.env = {
      ...originalEnv,
      QWEN_CODE_BASE_URL: 'https://api.example.com/',
      QWEN_CODE_MODEL: 'gpt-4',
    };

    const result1 = getCoreSystemPrompt(undefined, config);
    expect(result1).toContain('Custom template for example.com');

    // Test case 2: Config has trailing slash, actual URL has no trailing slash
    process.env = {
      ...originalEnv,
      QWEN_CODE_BASE_URL: 'https://api.openai.com',
      QWEN_CODE_MODEL: 'gpt-3.5-turbo',
    };

    const result2 = getCoreSystemPrompt(undefined, config);
    expect(result2).toContain('Custom template for openai.com');

    // Test case 3: No trailing slash in config, actual URL has no trailing slash
    process.env = {
      ...originalEnv,
      QWEN_CODE_BASE_URL: 'https://api.example.com',
      QWEN_CODE_MODEL: 'gpt-4',
    };

    const result3 = getCoreSystemPrompt(undefined, config);
    expect(result3).toContain('Custom template for example.com');

    // Test case 4: Config has trailing slash, actual URL has trailing slash
    process.env = {
      ...originalEnv,
      QWEN_CODE_BASE_URL: 'https://api.openai.com/',
      QWEN_CODE_MODEL: 'gpt-3.5-turbo',
    };

    const result4 = getCoreSystemPrompt(undefined, config);
    expect(result4).toContain('Custom template for openai.com');

    // Restore original environment variables
    process.env = originalEnv;
  });

  it('should not match when URLs are different', () => {
    const config = {
      systemPromptMappings: [
        {
          baseUrls: ['https://api.example.com'],
          modelNames: ['gpt-4'],
          template: 'Custom template for example.com',
        },
      ],
    };

    const originalEnv = process.env;

    // Test case: URLs do not match
    process.env = {
      ...originalEnv,
      QWEN_CODE_BASE_URL: 'https://api.different.com',
      QWEN_CODE_MODEL: 'gpt-4',
    };

    const result = getCoreSystemPrompt(undefined, config);
    // Should return default template, not contain custom template
    expect(result).not.toContain('Custom template for example.com');

    // Restore original environment variables
    process.env = originalEnv;
  });
});
