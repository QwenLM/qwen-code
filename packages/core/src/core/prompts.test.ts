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
  buildSystemPromptParts,
  joinSystemPrompt,
  resolveInteractionMode,
} from './prompts.js';
import { InputFormat } from '../output/types.js';
import { getRecentGitStatus, isGitRepository } from '../utils/gitUtils.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { QWEN_DIR } from '../config/storage.js';
import type { Config } from '../config/config.js';
import { collectAvailableSkillEntries } from '../tools/skill-utils.js';

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
  getRecentGitStatus: vi.fn().mockReturnValue(null),
}));
vi.mock('../utils/getFolderStructure.js', () => ({
  getFolderStructure: vi.fn().mockResolvedValue('src/\n  index.ts'),
}));
vi.mock('../tools/skill-utils.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../tools/skill-utils.js')>();
  return {
    ...actual,
    collectAvailableSkillEntries: vi.fn(),
  };
});
vi.mock('node:fs');

describe('Core System Prompt (prompts.ts)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
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

  it('should append userMemory when provided', () => {
    vi.stubEnv('SANDBOX', undefined);
    const memory = 'This is custom user memory.\nBe extra polite.';
    const expectedSuffix = `\n\n${memory}`;
    const prompt = getCoreSystemPrompt(memory);

    expect(prompt.endsWith(expectedSuffix)).toBe(true);
    expect(prompt).toContain('You are Qwen Code, an interactive CLI agent'); // Ensure base prompt follows
    expect(prompt).toMatchSnapshot(); // Snapshot the combined prompt
  });

  it('places caller system instructions before volatile user memory', () => {
    vi.stubEnv('SANDBOX', undefined);
    const memory = 'Remember the project conventions.';
    const appendInstruction = 'Always answer in exactly one sentence.';
    const prompt = getCoreSystemPrompt(memory, undefined, appendInstruction);

    expect(prompt).toContain(`\n\n${memory}`);
    expect(prompt).toContain(`\n\n${appendInstruction}`);
    expect(prompt.indexOf(appendInstruction)).toBeLessThan(
      prompt.indexOf(memory),
    );
  });

  it('places a caller system message in context and user memory in volatile', () => {
    const customInstruction = 'You are a release manager.';
    const userMemory = 'The repo uses pnpm.';
    const appendInstruction = 'Only report blocking issues.';

    const result = getCustomSystemPrompt(
      customInstruction,
      userMemory,
      appendInstruction,
    );

    expect(result).toBe(
      [customInstruction, appendInstruction, userMemory].join('\n\n'),
    );
  });

  it('omits blank system prompt tiers without changing order', () => {
    expect(
      joinSystemPrompt({
        stable: '  Base  ',
        context: '',
        volatile: '\nGit\n',
      }),
    ).toBe(['Base', 'Git'].join('\n\n'));
  });

  it('builds the complete Hermes tiers and returns only three keys', async () => {
    vi.mocked(collectAvailableSkillEntries).mockResolvedValue({
      availableSkills: [],
      pendingConditionalSkillNames: new Set(),
      modelInvocableCommands: [],
      entries: [
        {
          name: 'review',
          description: 'Review code',
          level: 'project',
        },
      ],
    });
    const toolRegistry = {
      warmAll: vi.fn().mockResolvedValue(undefined),
      getMcpServerInstructions: vi
        .fn()
        .mockReturnValue(new Map([['docs', 'Use the docs index.']])),
      getDeferredToolSummary: vi
        .fn()
        .mockReturnValue([
          { name: 'search_docs', description: 'Search documentation.' },
        ]),
      isDeferredToolRevealed: vi.fn().mockReturnValue(false),
    };
    const config = {
      getToolRegistry: vi.fn().mockReturnValue(toolRegistry),
      getSystemPrompt: vi.fn().mockReturnValue(undefined),
      getModel: vi.fn().mockReturnValue('qwen3-coder-plus'),
      getWorkingDir: vi.fn().mockReturnValue('/workspace'),
      getSkipStartupContext: vi.fn().mockReturnValue(false),
      getWorkspaceContext: vi.fn().mockReturnValue({
        getDirectories: vi.fn().mockReturnValue(['/workspace']),
      }),
      getFileService: vi.fn(),
      getSkillManager: vi.fn().mockReturnValue({}),
      getSystemPromptContext: vi.fn().mockReturnValue('Project instructions'),
      getSystemPromptVolatileMemory: vi
        .fn()
        .mockReturnValue('Memory snapshot\n\nUser profile'),
    } as unknown as Config;

    vi.mocked(getRecentGitStatus).mockReturnValue('Git snapshot');
    const parts = await buildSystemPromptParts(config, 'Caller message', {
      stablePrompt: 'Identity',
    });

    expect(Object.keys(parts)).toEqual(['stable', 'context', 'volatile']);
    const stableMarkers = [
      'Identity',
      'Use the docs index.',
      'search_docs',
      '<available_skills>',
      `My operating system is: ${process.platform}`,
      "I'm currently working in the directory: /workspace",
    ];
    for (const marker of stableMarkers) {
      expect(parts.stable).toContain(marker);
    }
    for (let index = 1; index < stableMarkers.length; index++) {
      expect(parts.stable.indexOf(stableMarkers[index - 1]!)).toBeLessThan(
        parts.stable.indexOf(stableMarkers[index]!),
      );
    }
    expect(parts.context).toBe('Caller message\n\nProject instructions');
    expect(parts.volatile).toMatch(
      /^Memory snapshot\n\nUser profile\n\nGit snapshot\n\nToday's date is .+\.$/,
    );
    expect(getRecentGitStatus).toHaveBeenCalledWith('/workspace');
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
      'You are a helpful assistant specialized in code review.\n\nRemember to be extra thorough.\nFocus on security issues.',
    );
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
      'You are a code assistant. Always provide examples.\n\nUser prefers TypeScript examples.',
    );
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
