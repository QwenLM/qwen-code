/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  assembleSystemPrompt,
  getCoreSystemPrompt,
  getCustomSystemPrompt,
  getManualPlanExitSystemReminder,
  getPlanModeSystemReminder,
  resolvePathFromEnv,
  getCompressionPrompt,
  resolveInteractionMode,
  resolveMainSessionOutputStyle,
} from './prompts.js';
// The base-prompt builder lives with the client that calls it; these tests
// pin it against the resolver here so the prompt and the per-turn reminder
// cannot drift apart.
import { getMainSessionBaseSystemPrompt } from './client.js';
import {
  BUILT_IN_OUTPUT_STYLES,
  getBuiltInOutputStyle,
  type OutputStyleDefinition,
} from './output-styles.js';
import { InputFormat } from '../output/types.js';
import { isGitRepository } from '../utils/gitUtils.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { QWEN_DIR } from '../config/storage.js';
import { isBashSearchAvailable } from '../utils/bash-search-tools.js';

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
vi.mock('../utils/bash-search-tools.js', () => ({
  isBashSearchAvailable: vi.fn(),
}));
vi.mock('node:fs');

describe('Core System Prompt (prompts.ts)', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.resetAllMocks();
    vi.mocked(isBashSearchAvailable).mockReturnValue(false);
    vi.stubEnv('QWEN_SYSTEM_MD', undefined);
    vi.stubEnv('QWEN_SYSTEM_IDENTITY_MD', undefined);
    vi.stubEnv('QWEN_WRITE_SYSTEM_MD', undefined);
  });

  it('should return the base prompt when no userMemory is provided', () => {
    vi.stubEnv('SANDBOX', undefined);
    const prompt = getCoreSystemPrompt();
    expect(prompt).not.toContain('---\n\n'); // Separator should not be present
    expect(prompt).toContain('You are Qwen Code, an interactive CLI agent'); // Check for core content
    expect(prompt).toContain('# Executing actions with care');
    expect(prompt).toMatchSnapshot(); // Use snapshot for base prompt structure
  });

  it('instructs the model not to bypass denied tool calls through equivalent paths', () => {
    vi.stubEnv('SANDBOX', undefined);
    const prompt = getCoreSystemPrompt();

    // Forbid equivalent paths for the denied action while allowing unrelated
    // safer alternatives.
    expect(prompt).toContain('denied action through another tool');
    expect(prompt).toContain(
      'genuinely safer alternative that does not accomplish the denied action',
    );
    expect(prompt).toContain(
      'request explicit approval only when the current interaction mode can receive it',
    );
  });

  it('identifies UserPromptSubmit hook context as distinct from user input', () => {
    vi.stubEnv('SANDBOX', undefined);
    const prompt = getCoreSystemPrompt();

    expect(prompt).toContain(
      'Text inside a `<qwen:user-prompt-submit-context>` tag is model context added by a configured `UserPromptSubmit` hook, not user input.',
    );
  });

  it.each([
    [
      'interactive',
      'an interactive CLI agent',
      "Use 'ask_user_question' when you need clarification",
    ],
    [
      'headless',
      'a non-interactive CLI agent',
      'Never ask the user a question',
    ],
    [
      'acp',
      'a CLI agent operating through an ACP host',
      'The ACP host can relay the question and response',
    ],
  ] as const)(
    'aligns the system prompt with %s mode',
    (mode, role, questionGuidance) => {
      vi.stubEnv('SANDBOX', undefined);
      const prompt = getCoreSystemPrompt(undefined, undefined, undefined, mode);

      expect(prompt).toContain(`You are Qwen Code, ${role}`);
      expect(prompt).toContain(questionGuidance);
    },
  );

  it('does not tell headless runs to wait for user input', () => {
    vi.stubEnv('SANDBOX', undefined);
    vi.mocked(isGitRepository).mockReturnValue(true);
    const prompt = getCoreSystemPrompt(
      undefined,
      undefined,
      undefined,
      'headless',
    );

    expect(prompt).not.toContain('stop and ask the user for explicit approval');
    expect(prompt).not.toContain('ask clarifying questions');
    expect(prompt).not.toContain('If unsure, ask the user');
    expect(prompt).not.toContain(
      'ask for clarification or confirmation where needed',
    );
    expect(prompt).not.toMatch(/Use 'ask_user_question' when you need/);
    expect(
      prompt.lastIndexOf('This is a non-interactive, single-turn run'),
    ).toBeGreaterThan(prompt.lastIndexOf('# Examples'));
  });

  it('instructs the model to preserve unrelated existing work', () => {
    vi.stubEnv('SANDBOX', undefined);
    vi.mocked(isGitRepository).mockReturnValue(true);
    const prompt = getCoreSystemPrompt();

    expect(prompt).toContain(
      'Treat existing or unexpected changes as user-owned',
    );
    expect(prompt).toContain(
      'Do not modify, stage, commit, or revert unrelated changes',
    );
    expect(prompt).toContain(
      'Stage only paths that belong to the requested change',
    );
    expect(prompt).toContain(
      'Do not use broad staging commands such as `git add -A` when unrelated changes are present',
    );
  });

  it('uses Shell search guidance when Bash search is available', () => {
    vi.mocked(isBashSearchAvailable).mockReturnValue(true);

    const prompt = getCoreSystemPrompt();

    expect(prompt).toContain("use 'run_shell_command' with `rg`");
    expect(prompt).toContain('`rg --files`');
    expect(prompt).toContain('rg --files | rg');
    expect(prompt).toContain('Qwen ignore files');
    expect(prompt).toContain("use 'grep_search' or 'glob'");
    expect(prompt).not.toContain("use 'glob' instead of find");
    expect(prompt).not.toContain("Reserve using the 'run_shell_command'");
  });

  it.each(['qwen-coder', 'qwen-vl', 'gemma4', 'general'])(
    'replaces %s Glob examples with Shell pipelines',
    (style) => {
      vi.mocked(isBashSearchAvailable).mockReturnValue(true);
      vi.stubEnv('QWEN_CODE_TOOL_CALL_STYLE', style);

      const prompt = getCoreSystemPrompt();

      expect(prompt).toContain('rg --files | rg');
      expect(prompt).not.toContain('[tool_call: glob');
      expect(prompt).not.toContain('<function=glob>');
      expect(prompt).not.toContain('"name": "glob"');
      expect(prompt).not.toContain('call:glob{');
    },
  );

  it('does not tell the model to enter plan mode without user opt-in', () => {
    vi.stubEnv('SANDBOX', undefined);
    const prompt = getCoreSystemPrompt();

    expect(prompt).toContain(
      'Do not enter plan mode or call enter_plan_mode on your own',
    );
    expect(prompt).toContain(
      'Use plan mode only when the user explicitly asks you to switch to plan mode',
    );
    expect(prompt).not.toContain(
      'When the work requires a shared plan before execution, enter plan mode',
    );
  });

  it('uses todos selectively and keeps plans outcome-oriented', () => {
    vi.stubEnv('SANDBOX', undefined);
    const prompt = getCoreSystemPrompt();

    expect(prompt).toContain('complex, ambiguous, or multi-phase tasks');
    expect(prompt).toContain('Do not use it for simple or single-step queries');
    expect(prompt).toContain('unless the user explicitly asks for a plan');
    expect(prompt).toContain('Keep it short and outcome-oriented');
    expect(prompt).toContain(
      'rather than one item per error, file, command, or minor edit',
    );
    expect(prompt).toContain(
      'When an active Todo plan covers work delegated through top-level Agent calls',
    );
    expect(prompt).not.toContain(
      'For complex work delegated through top-level Agent calls, create the relevant todo first',
    );
    expect(prompt).not.toContain('VERY frequently');
    expect(prompt).not.toContain('EXTREMELY helpful');
    expect(prompt).not.toContain('write 10 items to the todo list');
  });

  it('adapts final response detail to the request', () => {
    vi.stubEnv('SANDBOX', undefined);
    const prompt = getCoreSystemPrompt();

    expect(prompt).toContain(
      'Final responses should be concise by default, but their shape and depth must match the request',
    );
    expect(prompt).toContain(
      'For code reviews, explanations, investigations, or substantial changes',
    );
    expect(prompt).toContain(
      'complex findings may require several paragraphs or sections',
    );
    expect(prompt).not.toContain('End-of-turn summary: one or two sentences');
    expect(prompt).not.toContain('Nothing else.');
    expect(prompt).not.toContain('fewer than 3 lines');
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

  it('should append extra system prompt instructions after user memory when provided', () => {
    vi.stubEnv('SANDBOX', undefined);
    const memory = 'Remember the project conventions.';
    const appendInstruction = 'Always answer in exactly one sentence.';
    const prompt = getCoreSystemPrompt(memory, undefined, appendInstruction);

    expect(prompt).toContain(`\n\n---\n\n${memory}`);
    expect(prompt).toContain(`\n\n---\n\n${appendInstruction}`);
    expect(prompt.indexOf(memory)).toBeLessThan(
      prompt.indexOf(appendInstruction),
    );
  });

  it('should append extra instructions after a custom system prompt and user memory', () => {
    const customInstruction = 'You are a release manager.';
    const userMemory = 'The repo uses pnpm.';
    const appendInstruction = 'Only report blocking issues.';

    const result = getCustomSystemPrompt(
      customInstruction,
      userMemory,
      appendInstruction,
    );

    expect(result).toBe(
      [customInstruction, userMemory, appendInstruction].join('\n\n---\n\n'),
    );
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

  describe('QWEN_SYSTEM_IDENTITY_MD environment variable', () => {
    const customIdentity =
      'You are Acme Code, an interactive CLI agent for Acme Corp.';

    /** Sample the default identity from the live prompt to avoid drift. */
    const sampleDefaultIdentity = (): string => {
      vi.stubEnv('QWEN_SYSTEM_IDENTITY_MD', undefined);
      vi.stubEnv('QWEN_SYSTEM_MD', undefined);
      return getCoreSystemPrompt().split('\n\n', 1)[0];
    };

    it('should keep default prompt byte-identical when identity env is unset', () => {
      const defaultIdentity = sampleDefaultIdentity();
      const prompt = getCoreSystemPrompt();
      expect(prompt.startsWith(defaultIdentity)).toBe(true);
      expect(fs.readFileSync).not.toHaveBeenCalled();
    });

    it('should replace only the identity sentence when identity env points to a file', () => {
      const defaultIdentity = sampleDefaultIdentity();
      const identityPath = path.resolve('/custom/identity.md');
      vi.stubEnv('QWEN_SYSTEM_IDENTITY_MD', identityPath);
      vi.mocked(fs.existsSync).mockImplementation(
        (p) => path.resolve(String(p)) === identityPath,
      );
      vi.mocked(fs.readFileSync).mockImplementation((p) => {
        if (path.resolve(String(p)) === identityPath) {
          return `${customIdentity}  \n\n`;
        }
        throw new Error(`unexpected read: ${String(p)}`);
      });

      const withOverride = getCoreSystemPrompt();
      vi.stubEnv('QWEN_SYSTEM_IDENTITY_MD', undefined);
      const baseline = getCoreSystemPrompt();

      expect(withOverride.startsWith(customIdentity)).toBe(true);
      expect(withOverride).not.toContain('You are Qwen Code');
      // trimEnd() strips trailing spaces/newlines from the identity file.
      expect(withOverride.slice(customIdentity.length)).toBe(
        baseline.slice(defaultIdentity.length),
      );
    });

    it('should ignore identity env when QWEN_SYSTEM_MD is set', () => {
      const systemPath = path.resolve('/custom/system.md');
      const identityPath = path.resolve('/custom/identity.md');
      vi.stubEnv('QWEN_SYSTEM_MD', systemPath);
      vi.stubEnv('QWEN_SYSTEM_IDENTITY_MD', identityPath);
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockImplementation((p) => {
        if (path.resolve(String(p)) === systemPath) {
          return 'full system override';
        }
        throw new Error(`identity file should not be read: ${String(p)}`);
      });

      const prompt = getCoreSystemPrompt();
      expect(prompt).toBe('full system override');
      expect(fs.readFileSync).toHaveBeenCalledTimes(1);
      expect(fs.readFileSync).toHaveBeenCalledWith(systemPath, 'utf8');
    });

    it('should not inject identity when QWEN_SYSTEM_MD points to an empty file', () => {
      const systemPath = path.resolve('/custom/empty-system.md');
      const identityPath = path.resolve('/custom/identity.md');
      vi.stubEnv('QWEN_SYSTEM_MD', systemPath);
      vi.stubEnv('QWEN_SYSTEM_IDENTITY_MD', identityPath);
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockImplementation((p) => {
        if (path.resolve(String(p)) === systemPath) {
          return '';
        }
        throw new Error(`identity file should not be read: ${String(p)}`);
      });

      const prompt = getCoreSystemPrompt();
      expect(prompt).toBe('');
      expect(prompt).not.toContain(customIdentity);
      expect(prompt).not.toContain('You are Qwen Code');
    });

    it('should throw when identity env points to a missing file', () => {
      const identityPath = path.resolve('/missing/identity.md');
      vi.stubEnv('QWEN_SYSTEM_IDENTITY_MD', identityPath);
      vi.mocked(fs.existsSync).mockReturnValue(false);

      expect(() => getCoreSystemPrompt()).toThrow(
        `missing system identity file '${identityPath}'`,
      );
    });

    it('should throw when identity env points to an empty or whitespace-only file', () => {
      const identityPath = path.resolve('/custom/blank-identity.md');
      vi.stubEnv('QWEN_SYSTEM_IDENTITY_MD', identityPath);
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('  \n\t  ');

      expect(() => getCoreSystemPrompt()).toThrow(
        `empty system identity file '${identityPath}'`,
      );
    });

    it('should throw when a ~/ identity path cannot resolve the home directory', () => {
      vi.stubEnv('QWEN_SYSTEM_IDENTITY_MD', '~/identity.md');
      vi.spyOn(os, 'homedir').mockImplementation(() => {
        throw new Error('homedir unavailable');
      });

      expect(() => getCoreSystemPrompt()).toThrow(
        `failed to resolve system identity path '~/identity.md'`,
      );
    });

    it.each(['0', 'false', '1', 'true'] as const)(
      'should not override identity when env is switch value %s',
      (switchValue) => {
        const defaultIdentity = sampleDefaultIdentity();
        vi.stubEnv('QWEN_SYSTEM_IDENTITY_MD', switchValue);
        const prompt = getCoreSystemPrompt();
        expect(prompt.startsWith(defaultIdentity)).toBe(true);
        expect(fs.readFileSync).not.toHaveBeenCalled();
      },
    );
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

  describe('outputStyle parameter', () => {
    const concise = getBuiltInOutputStyle('Concise')!;
    const learning = getBuiltInOutputStyle('Learning')!;

    it('leaves the prompt untouched when no style is active', () => {
      const prompt = getCoreSystemPrompt();
      for (const style of BUILT_IN_OUTPUT_STYLES) {
        expect(prompt).not.toContain(`# Output Style: ${style.name}`);
      }
    });

    it('appends the style section to the end of the base prompt', () => {
      const prompt = getCoreSystemPrompt(
        undefined,
        undefined,
        undefined,
        'interactive',
        concise,
      );
      expect(prompt).toContain('# Output Style: Concise');
      // The style refines the mandates, so it has to land after them...
      expect(prompt.indexOf('# Output Style: Concise')).toBeGreaterThan(
        prompt.indexOf('# Core Mandates'),
      );
      // ...and the base prompt must still be intact.
      expect(prompt).toContain('# Core Mandates');
    });

    it('keeps the style ahead of the context and volatile layers', () => {
      const prompt = getCoreSystemPrompt(
        'MEMORY_MARKER',
        undefined,
        'APPEND_MARKER',
        'interactive',
        concise,
      );
      const styleIndex = prompt.indexOf('# Output Style: Concise');
      expect(styleIndex).toBeGreaterThan(-1);
      expect(styleIndex).toBeLessThan(prompt.indexOf('MEMORY_MARKER'));
      expect(styleIndex).toBeLessThan(prompt.indexOf('APPEND_MARKER'));
    });

    it('is ignored when QWEN_SYSTEM_MD replaces the base prompt', () => {
      vi.stubEnv('QWEN_SYSTEM_MD', '/custom/path/system.md');
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('custom system prompt');
      const prompt = getCoreSystemPrompt(
        undefined,
        undefined,
        undefined,
        'interactive',
        concise,
      );
      expect(prompt).toContain('custom system prompt');
      expect(prompt).not.toContain('# Output Style: Concise');
    });

    it('points the identity sentence at the style when one is active', () => {
      const plain = getCoreSystemPrompt();
      expect(plain).toContain('specializing in software engineering tasks');

      const styled = getCoreSystemPrompt(
        undefined,
        undefined,
        undefined,
        'interactive',
        concise,
      );
      expect(styled).toContain('responding according to your "Output Style"');
      expect(styled).not.toContain(
        'specializing in software engineering tasks',
      );
    });

    it('drops only the software-engineering section for keepCodingInstructions: false', () => {
      const nonCoding = {
        ...concise,
        name: 'NonCoding',
        keepCodingInstructions: false,
      };
      const prompt = getCoreSystemPrompt(
        undefined,
        undefined,
        undefined,
        'interactive',
        nonCoding,
      );
      expect(prompt).not.toContain('## Software Engineering Tasks');
      // Everything else the base prompt carries must survive — dropping the
      // safety rules along with the workflow guidance would be a regression.
      expect(prompt).toContain('# Core Mandates');
      expect(prompt).toContain('# Executing actions with care');
      expect(prompt).toContain('## Using Your Tools');
      expect(prompt).toContain('## Tone and Style (CLI Interaction)');
      expect(prompt).toContain('# Output Style: NonCoding');
    });

    it('keeps the software-engineering section under a normal style', () => {
      const prompt = getCoreSystemPrompt(
        undefined,
        undefined,
        undefined,
        'interactive',
        concise,
      );
      expect(prompt).toContain('## Software Engineering Tasks');
    });

    it('omits Learning from headless prompts that cannot receive a reply', () => {
      const prompt = getCoreSystemPrompt(
        undefined,
        undefined,
        undefined,
        'headless',
        learning,
      );

      expect(prompt).toContain('This is a non-interactive, single-turn run');
      expect(prompt).toContain('specializing in software engineering tasks');
      expect(prompt).not.toContain(
        'responding according to your "Output Style"',
      );
      expect(prompt).not.toContain('# Output Style: Learning');
      expect(prompt).not.toContain('TODO(human)');
      expect(prompt).not.toContain('until the user has written their piece');
    });

    it('keeps Learning in interactive prompts', () => {
      const prompt = getCoreSystemPrompt(
        undefined,
        undefined,
        undefined,
        'interactive',
        learning,
      );

      expect(prompt).toContain('# Output Style: Learning');
      expect(prompt).toContain('TODO(human)');
    });

    it('keeps Learning in acp prompts', () => {
      const prompt = getCoreSystemPrompt(
        undefined,
        undefined,
        undefined,
        'acp',
        learning,
      );

      expect(prompt).toContain('# Output Style: Learning');
    });

    it('keeps the style section under a QWEN_SYSTEM_IDENTITY_MD override', () => {
      // The override owns the identity sentence verbatim, so the styled
      // wording is skipped there — but the style itself still has to land.
      const identityPath = path.resolve('/custom/identity.md');
      const customIdentity =
        'You are Acme Code, an interactive CLI agent for Acme Corp.';
      vi.stubEnv('QWEN_SYSTEM_IDENTITY_MD', identityPath);
      vi.mocked(fs.existsSync).mockImplementation(
        (p) => path.resolve(String(p)) === identityPath,
      );
      vi.mocked(fs.readFileSync).mockImplementation((p) => {
        if (path.resolve(String(p)) === identityPath) {
          return customIdentity;
        }
        throw new Error(`unexpected read: ${String(p)}`);
      });

      const prompt = getCoreSystemPrompt(
        undefined,
        undefined,
        undefined,
        'interactive',
        concise,
      );
      expect(prompt.startsWith(customIdentity)).toBe(true);
      expect(prompt).not.toContain(
        'responding according to your "Output Style"',
      );
      expect(prompt).toContain('# Output Style: Concise');
    });

    it('does not bake the style into the QWEN_WRITE_SYSTEM_MD dump', () => {
      // The dump is meant to be reusable as a QWEN_SYSTEM_MD base; baking the
      // style in would apply it twice when that file is fed back.
      vi.stubEnv('QWEN_WRITE_SYSTEM_MD', 'true');
      getCoreSystemPrompt(
        undefined,
        undefined,
        undefined,
        'interactive',
        concise,
      );
      const [, written] = vi.mocked(fs.writeFileSync).mock.calls[0];
      expect(written).not.toContain('# Output Style: Concise');
      // ...and the dumped identity sentence is the unstyled one.
      expect(written).toContain('specializing in software engineering tasks');
    });
  });
});

describe('main-session style: reminder decision matches prompt section', () => {
  const concise = getBuiltInOutputStyle('Concise')!;
  const learning = getBuiltInOutputStyle('Learning')!;

  const sessions = [
    ['interactive', { interactive: true, acp: false }],
    ['headless', { interactive: false, acp: false }],
    ['acp', { interactive: false, acp: true }],
  ] as const;

  const makeConfig = (opts: {
    customPrompt?: string;
    style?: OutputStyleDefinition;
    interactive: boolean;
    acp: boolean;
  }) => ({
    getSystemPrompt: () => opts.customPrompt,
    getModel: () => 'test-model',
    getOutputStyle: () => opts.style,
    getExperimentalZedIntegration: () => opts.acp,
    getInputFormat: () => InputFormat.TEXT,
    isInteractive: () => opts.interactive,
  });

  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('QWEN_SYSTEM_MD', undefined);
    vi.stubEnv('QWEN_SYSTEM_IDENTITY_MD', undefined);
    vi.stubEnv('QWEN_WRITE_SYSTEM_MD', undefined);
    vi.stubEnv('QWEN_CODE_TOOL_CALL_STYLE', undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(sessions)(
    'renders the %s interaction mode the config resolves to',
    (session, flags) => {
      const markers = {
        interactive: 'an interactive CLI agent',
        headless: 'a non-interactive CLI agent',
        acp: 'a CLI agent operating through an ACP host',
      } as const;
      expect(getMainSessionBaseSystemPrompt(makeConfig(flags))).toContain(
        markers[session],
      );
    },
  );

  interface Case {
    name: string;
    customPrompt?: string;
    systemMd?: string;
    style?: OutputStyleDefinition;
    flags: { interactive: boolean; acp: boolean };
  }

  const cases: Case[] = [];
  for (const customPrompt of [undefined, 'You are terse.']) {
    for (const systemMd of [undefined, 'true']) {
      for (const style of [undefined, concise, learning]) {
        for (const [session, flags] of sessions) {
          cases.push({
            name:
              `custom=${customPrompt ? 'yes' : 'no'} ` +
              `systemMd=${systemMd ?? 'off'} ` +
              `style=${style?.name ?? 'none'} session=${session}`,
            customPrompt,
            systemMd,
            style,
            flags,
          });
        }
      }
    }
  }

  // The per-turn gate in LlmClient is exactly
  // resolveMainSessionOutputStyle(config), so pinning that decision against
  // the rendered prompt means the reminder and the prompt cannot drift when
  // a new prompt condition is added. The client-side wiring is pinned by the
  // reminder tests in client.test.ts.
  it.each(cases)(
    'reminds if and only if the prompt carries the style section ($name)',
    ({ customPrompt, systemMd, style, flags }) => {
      vi.stubEnv('QWEN_SYSTEM_MD', systemMd);
      if (systemMd) {
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockReturnValue('custom system prompt');
      }

      const config = makeConfig({ customPrompt, style, ...flags });
      const reminded = resolveMainSessionOutputStyle(config) !== undefined;
      const prompt = getMainSessionBaseSystemPrompt(config);

      expect(reminded).toBe(prompt.includes('# Output Style:'));
      if (customPrompt) {
        // The override replaces the base verbatim.
        expect(prompt).toContain(customPrompt);
        expect(prompt).not.toContain('You are Qwen Code');
      } else if (!systemMd) {
        expect(prompt).toContain('You are Qwen Code');
      }
    },
  );

  it('forwards the config model to the base prompt', () => {
    const config = {
      ...makeConfig({ interactive: true, acp: false }),
      getModel: () => 'qwen3-coder-7b',
    };

    expect(getMainSessionBaseSystemPrompt(config)).toContain(
      '<function=run_shell_command>',
    );
  });
});

describe('Model-specific tool call formats', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('SANDBOX', undefined);
  });

  it.each([
    ['generic', 'gpt-4'],
    ['qwen-coder', 'qwen3-coder-7b'],
    ['qwen-vl', 'qwen-vl-max'],
    ['gemma4', 'gemma-4'],
  ])(
    'reads the write target before establishing absence in the %s tool-call example',
    (_style, model) => {
      vi.mocked(isGitRepository).mockReturnValue(false);
      const prompt = getCoreSystemPrompt(undefined, model);
      const exampleStart = prompt.indexOf('user: Write tests for someFile.ts');
      const exampleEnd = prompt.indexOf('</example>', exampleStart);
      const example = prompt.slice(exampleStart, exampleEnd);
      const targetPath = example.indexOf('/path/to/someFile.test.ts');
      const targetReadCall = example.lastIndexOf('read_file', targetPath);
      const absenceResult = example.indexOf(
        'After read_file reports that /path/to/someFile.test.ts does not exist',
      );
      const writeCall = example.indexOf('write_file');

      expect(exampleStart).toBeGreaterThanOrEqual(0);
      expect(exampleEnd).toBeGreaterThan(exampleStart);
      expect(targetReadCall).toBeGreaterThanOrEqual(0);
      expect(targetPath).toBeGreaterThan(targetReadCall);
      expect(absenceResult).toBeGreaterThan(targetPath);
      expect(writeCall).toBeGreaterThan(absenceResult);
    },
  );

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
    expect(prompt).toContain(
      '"arguments": {"command": "node server.js", "is_background": true}',
    );
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

  it('should use native Gemma 4 format for gemma4 models', () => {
    vi.mocked(isGitRepository).mockReturnValue(false);

    // Test detection via regex
    const prompt = getCoreSystemPrompt(
      undefined,
      'unsloth/gemma-4-26B-A4B-it-qat',
    );

    // Should contain Gemma native token boundaries and quotes
    expect(prompt).toContain('<|tool_call>call:run_shell_command');
    expect(prompt).toContain(
      '{command:<|"|>node server.js<|"|>,is_background:true}<tool_call|>',
    );

    // Should NOT contain legacy/generic formats
    expect(prompt).not.toContain('[tool_call: run_shell_command for');
    expect(prompt).not.toContain('<function=run_shell_command>');
    expect(prompt).not.toContain('{"name": "run_shell_command"');

    expect(prompt).toMatchSnapshot();
  });

  it('should override tool call format via QWEN_CODE_TOOL_CALL_STYLE env variable for gemma4', () => {
    vi.stubEnv('QWEN_CODE_TOOL_CALL_STYLE', 'gemma4');
    vi.mocked(isGitRepository).mockReturnValue(false);

    // Pass a non-gemma model string to verify env var takes precedence
    const prompt = getCoreSystemPrompt(undefined, 'gpt-4');

    expect(prompt).toContain('<|tool_call>call:run_shell_command');
    expect(prompt).not.toContain('[tool_call: run_shell_command for');
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
    // list_directory is opt-in (off by default) — the reminder must not steer
    // the model toward a tool that is not registered.
    expect(result).not.toContain('list_directory');
    expect(result).toContain('does not approve the plan');
    expect(result).toContain('exit Plan mode');
  });

  it('uses Bash search guidance throughout the plan reminder', () => {
    vi.mocked(isBashSearchAvailable).mockReturnValue(true);

    const result = getPlanModeSystemReminder();

    expect(result).toContain('run_shell_command with `rg`/`rg --files`');
    expect(result).not.toContain('grep_search');
    expect(result).not.toContain('glob, agents');
  });

  it('should be deterministic', () => {
    const result1 = getPlanModeSystemReminder();
    const result2 = getPlanModeSystemReminder();

    expect(result1).toBe(result2);
  });
});

describe('getManualPlanExitSystemReminder', () => {
  it('should name the new mode and forbid exit_plan_mode', () => {
    const result = getManualPlanExitSystemReminder('default');

    expect(result).toBe(`<system-reminder>
The approval mode changed outside the approved exit_plan_mode flow.
The current approval mode is: default.
Plan mode is no longer active. This notice supersedes any earlier reminder that Plan mode is active. Do not call exit_plan_mode; no plan approval is pending. Continue under the current mode's permissions and confirmation requirements.
</system-reminder>`);
  });

  it('should render whichever mode the user switched to', () => {
    expect(getManualPlanExitSystemReminder('yolo')).toContain(
      'current approval mode is: yolo',
    );
    expect(getManualPlanExitSystemReminder('auto-edit')).toContain(
      'current approval mode is: auto-edit',
    );
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
    vi.mocked(isGitRepository).mockReturnValue(false);
    const prompt = getCoreSystemPrompt();
    expect(prompt).not.toContain(
      'Autonomously implement and deliver a visually appealing',
    );
    expect(prompt).not.toContain('Websites (Frontend):');
    expect(prompt).not.toContain('npx create-react-app');
  });

  it('system prompt references the new-app skill', () => {
    vi.mocked(isGitRepository).mockReturnValue(false);
    const prompt = getCoreSystemPrompt();
    expect(prompt).toContain('new-app');
    expect(prompt).toContain('## New Applications');
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

describe('assembleSystemPrompt', () => {
  it('joins all layers in stable -> context -> volatile order', () => {
    const result = assembleSystemPrompt({
      base: 'BASE',
      contextFiles: 'CONTEXT_FILES',
      appendPrompt: 'APPEND',
      gitStatus: 'GIT_STATUS',
      autoMemory: 'AUTO_MEMORY',
    });

    expect(result).toBe(
      'BASE\n\n---\n\nCONTEXT_FILES\n\n---\n\nAPPEND\n\nGIT_STATUS\n\n---\n\nAUTO_MEMORY',
    );
  });

  it('returns only the base when every other layer is empty', () => {
    expect(assembleSystemPrompt({ base: 'BASE' })).toBe('BASE');
    expect(
      assembleSystemPrompt({
        base: 'BASE',
        contextFiles: '',
        appendPrompt: '   ',
        gitStatus: null,
        autoMemory: '',
      }),
    ).toBe('BASE');
  });

  it('skips empty slots without leaving separators behind', () => {
    const result = assembleSystemPrompt({
      base: 'BASE',
      appendPrompt: 'APPEND',
      autoMemory: 'AUTO_MEMORY',
    });

    expect(result).toBe('BASE\n\n---\n\nAPPEND\n\n---\n\nAUTO_MEMORY');
  });

  it('keeps the volatile auto-memory slot last even after git status', () => {
    const result = assembleSystemPrompt({
      base: 'BASE',
      gitStatus: 'GIT_STATUS',
      autoMemory: 'AUTO_MEMORY',
    });

    expect(result.endsWith('\n\n---\n\nAUTO_MEMORY')).toBe(true);
    expect(result.indexOf('GIT_STATUS')).toBeLessThan(
      result.indexOf('AUTO_MEMORY'),
    );
  });

  it('matches the composition getCoreSystemPrompt produces for the same inputs', () => {
    // getCoreSystemPrompt(userMemory, ..., appendInstruction) must be
    // byte-identical to assembling its base with the same context slots —
    // both paths go through assembleSystemPrompt.
    const base = getCoreSystemPrompt(undefined, undefined, undefined);
    const viaParams = getCoreSystemPrompt('MEMORY', undefined, 'APPEND');
    const viaAssembler = assembleSystemPrompt({
      base,
      contextFiles: 'MEMORY',
      appendPrompt: 'APPEND',
    });

    expect(viaParams).toBe(viaAssembler);
  });
});
