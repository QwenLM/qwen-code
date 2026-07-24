/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  getCoreSystemPrompt,
  getCustomSystemPrompt,
  getPlanModeSystemReminder,
  resolvePathFromEnv,
  getCompressionPrompt,
  resolveInteractionMode,
} from './prompts.js';
import { InputFormat } from '../output/types.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { QWEN_DIR } from '../config/storage.js';
import { DEFAULT_SYSTEM_PROMPT } from './default-system-prompt.js';

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
vi.mock('node:fs');

describe('Core System Prompt (prompts.ts)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('QWEN_SYSTEM_MD', undefined);
    vi.stubEnv('QWEN_WRITE_SYSTEM_MD', undefined);
  });

  it('uses the JobBench-validated prompt as the default base prompt', () => {
    const prompt = getCoreSystemPrompt();

    expect(prompt).toBe(DEFAULT_SYSTEM_PROMPT);
    expect(prompt).not.toContain(
      'You are Qwen Code, an interactive CLI agent developed by Alibaba Group',
    );
    expect(prompt).toMatchSnapshot();
  });

  it('uses Qwen tool function names in the adapted prompt', () => {
    const prompt = getCoreSystemPrompt();

    for (const toolName of [
      'read_file',
      'write_file',
      'edit',
      'glob',
      'grep_search',
      'run_shell_command',
      'skill',
    ]) {
      expect(prompt).toContain(`\`${toolName}\``);
    }

    expect(prompt).not.toContain('the Write tool');
    expect(prompt).not.toContain('via Skill');
    expect(prompt).not.toContain('Bash');
  });

  it('does not vary by legacy interaction mode argument', () => {
    const prompt = getCoreSystemPrompt(
      undefined,
      undefined,
      undefined,
      'headless',
    );
    expect(prompt).toBe(DEFAULT_SYSTEM_PROMPT);
  });

  it('instructs the model to preserve unrelated existing work', () => {
    const prompt = getCoreSystemPrompt();

    expect(prompt).toContain("preserve the user's existing or unexpected work");
    expect(prompt).toContain(
      'Do not overwrite, revert, stage, or otherwise mix unrelated changes',
    );
  });

  it('excludes collector and unsupported runtime-specific content', () => {
    const prompt = getCoreSystemPrompt();

    for (const excludedContent of [
      '===== SYSTEM MESSAGE INDEX',
      '/logs/agent/sessions/projects/-workspace/memory/',
      'Fast mode',
      'Available agent types for the Agent tool',
      'The following skills are available',
      '# Outside of Sandbox',
      '# Sandbox',
      '# macOS Seatbelt',
      '# Executing actions with care',
      '# Git Repository',
      '# Examples (Illustrating Tone and Workflow)',
      '# Final Reminder',
    ]) {
      expect(prompt).not.toContain(excludedContent);
    }
  });

  it('should return the base prompt when userMemory is empty string', () => {
    vi.stubEnv('SANDBOX', undefined);
    const prompt = getCoreSystemPrompt('');
    expect(prompt).toBe(DEFAULT_SYSTEM_PROMPT);
  });

  it('should return the base prompt when userMemory is whitespace only', () => {
    vi.stubEnv('SANDBOX', undefined);
    const prompt = getCoreSystemPrompt('   \n  \t ');
    expect(prompt).toBe(DEFAULT_SYSTEM_PROMPT);
  });

  it('keeps runtime user context out of the fixed system prompt', () => {
    const memory = 'This is custom user memory.\nBe extra polite.';
    const prompt = getCoreSystemPrompt(memory);

    expect(prompt).toBe(DEFAULT_SYSTEM_PROMPT);
    expect(prompt).not.toContain(memory);
  });

  it('keeps the general Memory protocol in the fixed base', () => {
    const prompt = getCoreSystemPrompt();

    expect(prompt.indexOf('# Session-specific guidance')).toBeLessThan(
      prompt.indexOf('# Memory'),
    );
    expect(prompt.indexOf('# Memory')).toBeLessThan(
      prompt.indexOf('# Context management'),
    );
    expect(prompt).toContain('persistent file-based memory');
    expect(prompt).toContain('USER memory');
    expect(prompt).toContain('PROJECT memory');
    expect(prompt).toContain('TEAM memory');
    expect(prompt).not.toContain('/tmp/project/.qwen/memory');
    expect(prompt).not.toContain('[Preference]');
    expect(prompt).not.toContain(
      '/logs/agent/sessions/projects/-workspace/memory/',
    );
  });

  it('does not append hierarchical memory inputs', () => {
    const agentsMemory = '--- Context from: AGENTS.md ---\nProject rules';
    const prompt = getCoreSystemPrompt(agentsMemory);

    expect(prompt).not.toContain(agentsMemory);
    expect(prompt.match(/^# Memory$/gm)).toHaveLength(1);
  });

  it('appends explicit extra system instructions after the fixed base', () => {
    const appendInstruction = 'Always answer in exactly one sentence.';
    const prompt = getCoreSystemPrompt(undefined, undefined, appendInstruction);

    expect(prompt).toContain(`\n\n---\n\n${appendInstruction}`);
  });

  it('appends extra instructions after a custom base without runtime context', () => {
    const customInstruction = 'You are a release manager.';
    const appendInstruction = 'Only report blocking issues.';

    const result = getCustomSystemPrompt(
      customInstruction,
      undefined,
      appendInstruction,
    );

    expect(result).toBe(
      [customInstruction, appendInstruction].join('\n\n---\n\n'),
    );
  });

  it.each([undefined, 'true', 'sandbox-exec'])(
    'does not inject sandbox guidance when SANDBOX=%s',
    (sandbox) => {
      vi.stubEnv('SANDBOX', sandbox);
      expect(getCoreSystemPrompt()).toBe(DEFAULT_SYSTEM_PROMPT);
    },
  );

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
      const defaultPath = path.resolve(path.join(QWEN_DIR, 'system.md'));
      vi.stubEnv('QWEN_SYSTEM_MD', 'true');
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('custom system prompt');

      const prompt = getCoreSystemPrompt();
      expect(fs.readFileSync).toHaveBeenCalledWith(defaultPath, 'utf8');
      expect(prompt).toBe('custom system prompt');
    });

    it('should read from default path when QWEN_SYSTEM_MD is "1"', () => {
      const defaultPath = path.resolve(path.join(QWEN_DIR, 'system.md'));
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
      const defaultPath = path.resolve(path.join(QWEN_DIR, 'system.md'));
      vi.stubEnv('QWEN_WRITE_SYSTEM_MD', 'true');
      getCoreSystemPrompt();
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        defaultPath,
        expect.any(String),
      );
    });

    it('should write to default path when QWEN_WRITE_SYSTEM_MD is "1"', () => {
      const defaultPath = path.resolve(path.join(QWEN_DIR, 'system.md'));
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
  it('does not inject model-specific tool examples', () => {
    expect(getCoreSystemPrompt()).toBe(DEFAULT_SYSTEM_PROMPT);
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

  it('does not append user memory to a custom instruction', () => {
    const customInstruction =
      'You are a helpful assistant specialized in code review.';
    const userMemory = 'Always use the repository conventions.';
    const result = getCustomSystemPrompt(customInstruction, userMemory);

    expect(result).toBe(customInstruction);
  });

  it('flattens a Content object without appending user memory', () => {
    const customInstruction = {
      parts: [
        { text: 'You are a code assistant. ' },
        { text: 'Always provide examples.' },
      ],
    };
    const result = getCustomSystemPrompt(customInstruction, 'Runtime memory');

    expect(result).toBe('You are a code assistant. Always provide examples.');
  });

  it('appends explicit content after a custom base', () => {
    const result = getCustomSystemPrompt(
      'Custom base',
      undefined,
      'Append content',
    );

    expect(result).toBe(['Custom base', 'Append content'].join('\n\n---\n\n'));
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

    expect(result).toContain('Iterative Planning Workflow');
    expect(result).toContain('### The Loop');
    expect(result).toContain('exit_plan_mode tool');
  });

  it('should include guidance when a tool is blocked by plan mode', () => {
    const result = getPlanModeSystemReminder();

    expect(result).toContain('When a Tool is Blocked by Plan Mode');
    expect(result).toContain('Do NOT retry');
    expect(result).toContain(
      'wrappers, quoting tricks, aliases, or obfuscation',
    );
    expect(result).toContain('Pivot to read-only');
    expect(result).toContain('does not approve the plan');
    expect(result).toContain('exit Plan mode');
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

      const result = resolvePathFromEnv('~/documents/file.txt');
      expect(result).toEqual({
        isSwitch: false,
        value: null,
        isDisabled: false,
      });
    });
  });
});

describe('New Applications workflow deferred to skill', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('SANDBOX', undefined);
  });

  it('system prompt does not contain the full New Applications workflow', () => {
    const prompt = getCoreSystemPrompt();
    expect(prompt).not.toContain(
      'Autonomously implement and deliver a visually appealing',
    );
    expect(prompt).not.toContain('Websites (Frontend):');
    expect(prompt).not.toContain('npx create-react-app');
  });

  it('system prompt does not hard-code the new-app skill', () => {
    const prompt = getCoreSystemPrompt();
    expect(prompt).not.toContain('new-app');
    expect(prompt).not.toContain('## New Applications');
  });
});

describe('getCompressionPrompt', () => {
  it('uses the <state_snapshot> XML envelope with all 9 required section tags', () => {
    const prompt = getCompressionPrompt();
    expect(prompt).toContain('<state_snapshot>');
    expect(prompt).toContain('</state_snapshot>');
    expect(prompt).toContain('<primary_request_and_intent>');
    expect(prompt).toContain('<key_technical_concepts>');
    expect(prompt).toContain('<files_and_code_sections>');
    expect(prompt).toContain('<errors_and_fixes>');
    expect(prompt).toContain('<problem_solving>');
    expect(prompt).toContain('<all_user_messages>');
    expect(prompt).toContain('<pending_tasks>');
    expect(prompt).toContain('<current_work>');
    expect(prompt).toContain('<next_step>');
  });

  it('instructs the model to wrap reasoning in an <analysis> block', () => {
    const prompt = getCompressionPrompt();
    expect(prompt).toContain('<analysis>');
    // Must signal that <analysis> is stripped (so the model knows it is a
    // drafting scratchpad, not part of the final summary).
    expect(prompt).toMatch(/<analysis>.*stripped|stripped.*<analysis>/is);
  });

  it('asks for the <all_user_messages> section to be chronological and inclusive', () => {
    const prompt = getCompressionPrompt();
    // The actual mandate text — verbatim-but-not-VERBATIM-policed.
    expect(prompt).toMatch(/all user messages.*chronological/i);
    expect(prompt).toContain('"ok"');
    expect(prompt).toContain('"continue"');
  });

  it('does NOT include the resume trailer in the prompt body', () => {
    // The trailer lives in postCompactAttachments.postProcessSummary, not in
    // the prompt. Keeping it out of the prompt saves output tokens per
    // compaction and prevents wording drift.
    const prompt = getCompressionPrompt();
    expect(prompt).not.toMatch(
      /resume.*directly|continue the conversation from where it left off/i,
    );
  });
});

describe('resolveInteractionMode', () => {
  const makeConfig = (opts: {
    zed?: boolean;
    inputFormat?: string;
    interactive?: boolean;
  }) => ({
    getExperimentalZedIntegration: () => opts.zed ?? false,
    getInputFormat: () => opts.inputFormat ?? InputFormat.TEXT,
    isInteractive: () => opts.interactive ?? false,
  });

  it("resolves the Zed integration to 'acp'", () => {
    expect(resolveInteractionMode(makeConfig({ zed: true }))).toBe('acp');
  });

  it("resolves a stream-json session to 'acp' so the model may still ask questions", () => {
    // Must match the runtime question/permission sites, which treat a
    // stream-json session as ACP-capable (the host relays the question).
    expect(
      resolveInteractionMode(
        makeConfig({ inputFormat: InputFormat.STREAM_JSON }),
      ),
    ).toBe('acp');
  });

  it("resolves an interactive text session to 'interactive'", () => {
    expect(
      resolveInteractionMode(
        makeConfig({ inputFormat: InputFormat.TEXT, interactive: true }),
      ),
    ).toBe('interactive');
  });

  it("resolves a non-interactive text session to 'headless'", () => {
    expect(
      resolveInteractionMode(
        makeConfig({ inputFormat: InputFormat.TEXT, interactive: false }),
      ),
    ).toBe('headless');
  });

  it("prefers 'acp' over 'interactive' for a stream-json session (ACP precedence)", () => {
    expect(
      resolveInteractionMode(
        makeConfig({ inputFormat: InputFormat.STREAM_JSON, interactive: true }),
      ),
    ).toBe('acp');
  });

  it('treats a missing getInputFormat as a text session', () => {
    // getInputFormat is optional on the structural type; its absence must not
    // throw and must not resolve to 'acp'.
    expect(
      resolveInteractionMode({
        getExperimentalZedIntegration: () => false,
        isInteractive: () => true,
      }),
    ).toBe('interactive');
    expect(
      resolveInteractionMode({
        getExperimentalZedIntegration: () => false,
        isInteractive: () => false,
      }),
    ).toBe('headless');
  });
});
