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
  type SystemPromptInteractionMode,
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
import { ToolNames } from '../tools/tool-names.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { QWEN_DIR } from '../config/storage.js';

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

interface PromptOpts {
  memory?: string;
  model?: string;
  append?: string;
  mode?: SystemPromptInteractionMode;
  style?: OutputStyleDefinition;
  todo?: boolean;
  codeMode?: boolean;
  declaredTools?: ReadonlySet<string>;
  agentReachable?: boolean;
}

/** getCoreSystemPrompt with named options; omitted ones take their defaults. */
const corePrompt = (o: PromptOpts = {}) =>
  getCoreSystemPrompt(
    o.memory,
    o.model,
    o.append,
    o.mode,
    o.style,
    o.todo,
    o.codeMode,
    o.declaredTools || o.agentReachable !== undefined
      ? { declaredTools: o.declaredTools, agentReachable: o.agentReachable }
      : undefined,
  );

/** Asserts `text` contains every `has` entry and none of the `lacks` ones. */
function expectText(text: string, has: string[], lacks: string[] = []) {
  for (const s of has) expect(text).toContain(s);
  for (const s of lacks) expect(text).not.toContain(s);
}

/** resetAllMocks, then unsets the system-md env vars plus `extra`. */
function resetPromptEnv(...extra: string[]) {
  vi.resetAllMocks();
  for (const name of [
    'QWEN_SYSTEM_MD',
    'QWEN_SYSTEM_IDENTITY_MD',
    'QWEN_WRITE_SYSTEM_MD',
    ...extra,
  ]) {
    vi.stubEnv(name, undefined);
  }
}

const CUSTOM = 'custom system prompt';
const HOME = '/Users/test';
const DEFAULT_MD = path.resolve(path.join(QWEN_DIR, 'system.md'));

/** Every file exists and every read returns `text`. */
function mockAnyFile(text = CUSTOM) {
  vi.mocked(fs.existsSync).mockReturnValue(true);
  vi.mocked(fs.readFileSync).mockReturnValue(text);
}

/** Only `file` exists and reads as `text`; any other read throws. */
function mockOnlyFile(file: string, text: string) {
  vi.mocked(fs.existsSync).mockImplementation(
    (p) => path.resolve(String(p)) === file,
  );
  vi.mocked(fs.readFileSync).mockImplementation((p) => {
    if (path.resolve(String(p)) === file) return text;
    throw new Error(`unexpected read: ${String(p)}`);
  });
}

const makeConfig = (opts: {
  customPrompt?: string;
  style?: OutputStyleDefinition;
  codeModeOnly?: boolean;
  interactive: boolean;
  acp: boolean;
}) => ({
  getSystemPrompt: () => opts.customPrompt,
  getModel: () => 'test-model',
  getOutputStyle: () => opts.style,
  getCodeModeOnly: () => opts.codeModeOnly ?? false,
  getExperimentalZedIntegration: () => opts.acp,
  getInputFormat: () => InputFormat.TEXT,
  isInteractive: () => opts.interactive,
  isTodoWriteEnabled: () => false,
});

describe('Core System Prompt (prompts.ts)', () => {
  beforeEach(() => resetPromptEnv());

  /** The prompt with SANDBOX unset, as most cases here pin it. */
  function unsandboxed(o?: PromptOpts) {
    vi.stubEnv('SANDBOX', undefined);
    return corePrompt(o);
  }

  /** No memory separator, the default identity (plus `more`), snapshot. */
  function expectBasePrompt(prompt: string, ...more: string[]) {
    expect(prompt).not.toContain('---\n\n');
    expectText(prompt, [
      'You are Qwen Code, an interactive CLI agent',
      ...more,
    ]);
    expect(prompt).toMatchSnapshot();
  }

  it('should return the base prompt when no userMemory is provided', () => {
    expectBasePrompt(unsandboxed(), '# Executing actions with care');
  });

  it('keeps the merged verification and faithful-reporting rules', () => {
    const prompt = getCoreSystemPrompt();

    expect(prompt).toContain('NEVER assume standard commands.');
    expect(prompt).toContain(
      'Read-only or explanatory turns do not require verification.',
    );
    expect(prompt).toContain(
      'if you did not run a verification step — including when you could not',
    );
  });

  it('separates the workflow from the general context rules with a blank line', () => {
    const prompt = getCoreSystemPrompt();

    expect(prompt).toContain(
      'or broken work as done.\n\n- Tool results and user messages',
    );
  });

  it('does not advertise todo_write by default', () => {
    expectText(
      unsandboxed(),
      ['revise it as you learn'],
      ['todo_write', '# Task Management'],
    );
  });

  it('advertises todo_write when it is enabled', () => {
    expectText(unsandboxed({ todo: true }), [
      '# Task Management',
      "Use 'todo_write'",
      'pass the matching Todo ID as `todo_id`',
    ]);
  });

  it('instructs the model not to bypass denied tool calls through equivalent paths', () => {
    // Forbid equivalent paths for the denied action while allowing unrelated
    // safer alternatives.
    expectText(unsandboxed(), [
      'denied action through another tool',
      'genuinely safer alternative that does not accomplish the denied action',
      'request explicit approval only when the current interaction mode can receive it',
    ]);
  });

  it('leaves mode-specific managed-memory access out of the core prompt', () => {
    const prompt = getCoreSystemPrompt();

    expect(prompt).not.toContain('search_memory');
    expect(prompt).not.toContain('Managed Memory Access');
  });

  it('identifies UserPromptSubmit hook context as distinct from user input', () => {
    expect(unsandboxed()).toContain(
      'Text inside a `<qwen:user-prompt-submit-context>` tag is model context added by a configured `UserPromptSubmit` hook, not user input.',
    );
  });

  it('answers from sufficient current context without weakening verification', () => {
    const prompt = getCoreSystemPrompt();

    expect(prompt).toContain('**Answer From Context First:**');
    expect(prompt).toContain('reuse prior observations');
    expect(prompt).toContain('current or post-change state');
    expect(prompt).toContain('only a summary lacking the needed evidence');
    expect(prompt).toContain('not verification before claiming a change works');
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
      expectText(unsandboxed({ mode }), [
        `You are Qwen Code, ${role}`,
        questionGuidance,
      ]);
    },
  );

  it('does not tell headless runs to wait for user input', () => {
    vi.mocked(isGitRepository).mockReturnValue(true);
    const prompt = unsandboxed({ mode: 'headless' });
    expectText(
      prompt,
      [],
      [
        'stop and ask the user for explicit approval',
        'ask clarifying questions',
        'If unsure, ask the user',
        'ask for clarification or confirmation where needed',
      ],
    );
    expect(prompt).not.toMatch(/Use 'ask_user_question' when you need/);
    expect(
      prompt.lastIndexOf('This is a non-interactive, single-turn run'),
    ).toBeGreaterThan(prompt.lastIndexOf('# Examples'));
  });

  it.each([
    ['general', 'gpt-4', false],
    ['qwen-coder', 'qwen3-coder', false],
    ['qwen-vl', 'qwen3-vl', false],
    ['gemma4', 'gemma4', false],
    ['code mode', 'qwen3-coder', true],
  ] as const)(
    'keeps %s headless examples free of follow-up questions',
    (_name, model, codeMode) => {
      vi.stubEnv('QWEN_CODE_TOOL_CALL_STYLE', undefined);
      const prompt = corePrompt({ model, mode: 'headless', codeMode });
      const responses = [
        ...prompt.matchAll(
          /<example>\s*user:[\s\S]*?\nmodel:([\s\S]*?)<\/example>/g,
        ),
      ];

      expect(responses.length).toBeGreaterThan(0);
      expect(prompt).toContain('no reply can be received');
      for (const response of responses) {
        expect(response[1]).not.toContain('?');
      }
    },
  );

  it('instructs the model to preserve unrelated existing work', () => {
    vi.mocked(isGitRepository).mockReturnValue(true);
    expectText(unsandboxed(), [
      'Treat existing or unexpected changes as user-owned',
      'Do not modify, stage, commit, or revert unrelated changes',
      'Stage only paths that belong to the requested change',
      'Do not use broad staging commands such as `git add -A` when unrelated changes are present',
    ]);
  });

  it('does not tell the model to enter plan mode without user opt-in', () => {
    expectText(
      unsandboxed(),
      [
        'Do not enter plan mode or call enter_plan_mode on your own',
        'Use plan mode only when the user explicitly asks you to switch to plan mode',
      ],
      [
        'When the work requires a shared plan before execution, enter plan mode',
      ],
    );
  });

  it('uses todos selectively and keeps plans outcome-oriented', () => {
    expectText(
      unsandboxed({ todo: true }),
      [
        'complex, ambiguous, or multi-phase tasks',
        'Do not use it for simple or single-step queries',
        'unless the user explicitly asks for a plan',
        'Keep it short and outcome-oriented',
        'rather than one item per error, file, command, or minor edit',
        'When an active Todo plan covers work delegated through top-level Agent calls',
      ],
      [
        'For complex work delegated through top-level Agent calls, create the relevant todo first',
        'VERY frequently',
        'EXTREMELY helpful',
        'write 10 items to the todo list',
      ],
    );
  });

  it('states the todo usage rules once, in the Task Management section', () => {
    vi.stubEnv('SANDBOX', undefined);
    const prompt = getCoreSystemPrompt(
      undefined,
      undefined,
      undefined,
      'interactive',
      undefined,
      true,
    );

    // The Plan bullet and the tool-guidance bullet only point at the section.
    expect(prompt).toContain(
      "Track complex, ambiguous, or multi-step work with 'todo_write'",
    );
    expect(prompt).toContain("'# Task Management' governs its use");
    expect(prompt).not.toContain(
      'If a todo list exists, keep it current as the scope or approach changes',
    );
    expect(prompt.match(/outcome-oriented/g)?.length).toBe(1);
    expect(prompt.match(/simple or single-step/g)?.length).toBe(1);
  });

  it('states the comment rule once', () => {
    vi.stubEnv('SANDBOX', undefined);
    const prompt = getCoreSystemPrompt();

    expect(prompt).toContain(
      'Default to none. Add one only when the _why_ cannot be conveyed',
    );
    // The removed sentences are covered by the why-only criterion and the
    // 'Tools vs. Text' rule; they must not creep back as a second statement.
    expect(prompt).not.toContain(
      'talk to the user or describe your changes through comments',
    );
    expect(prompt.match(/Default to none/g)?.length).toBe(1);
  });

  it('adapts final response detail to the request', () => {
    expectText(
      unsandboxed(),
      [
        'Final responses should be concise by default, but their shape and depth must match the request',
        'For code reviews, explanations, investigations, or substantial changes',
        'complex findings may require several paragraphs or sections',
      ],
      [
        'End-of-turn summary: one or two sentences',
        'Nothing else.',
        'fewer than 3 lines',
      ],
    );
  });

  it('should return the base prompt when userMemory is empty string', () => {
    expectBasePrompt(unsandboxed({ memory: '' }));
  });

  it('should return the base prompt when userMemory is whitespace only', () => {
    expectBasePrompt(unsandboxed({ memory: '   \n  \t ' }));
  });

  it('should append userMemory with separator when provided', () => {
    const memory = 'This is custom user memory.\nBe extra polite.';
    const prompt = unsandboxed({ memory });
    expect(prompt.endsWith(`\n\n---\n\n${memory}`)).toBe(true);
    expect(prompt).toContain('You are Qwen Code, an interactive CLI agent'); // Ensure base prompt follows
    expect(prompt).toMatchSnapshot();
  });

  it('should append extra system prompt instructions after user memory when provided', () => {
    const memory = 'Remember the project conventions.';
    const append = 'Always answer in exactly one sentence.';
    const prompt = unsandboxed({ memory, append });
    expectText(prompt, [`\n\n---\n\n${memory}`, `\n\n---\n\n${append}`]);
    expect(prompt.indexOf(memory)).toBeLessThan(prompt.indexOf(append));
  });

  it('should append extra instructions after a custom system prompt and user memory', () => {
    const parts = [
      'You are a release manager.',
      'The repo uses pnpm.',
      'Only report blocking issues.',
    ] as const;
    expect(getCustomSystemPrompt(...parts)).toBe(parts.join('\n\n---\n\n'));
  });

  /** The prompt under SANDBOX=`value`, checked against `has`/`lacks`. */
  function sandboxPrompt(
    value: string | undefined,
    has: string[],
    lacks: string[],
  ) {
    vi.stubEnv('SANDBOX', value);
    const prompt = getCoreSystemPrompt();
    expectText(prompt, has, lacks);
    return prompt;
  }

  it('should include sandbox-specific instructions when SANDBOX env var is set', () => {
    // Generic sandbox value
    const prompt = sandboxPrompt(
      'true',
      ['# Sandbox'],
      ['# macOS Seatbelt', '# Outside of Sandbox'],
    );
    expect(prompt).toMatchSnapshot();
  });

  it('should include seatbelt-specific instructions when SANDBOX env var is "sandbox-exec"', () => {
    const prompt = sandboxPrompt(
      'sandbox-exec',
      ['# macOS Seatbelt'],
      ['# Sandbox', '# Outside of Sandbox'],
    );
    expect(prompt).toMatchSnapshot();
  });

  it('describes the bwrap filesystem boundary and distinguishes ordinary permissions', () => {
    const prompt = sandboxPrompt(
      'bwrap',
      [
        '# Kernel Sandbox (bwrap)',
        'repository Git metadata, including config and hooks, remains writable',
        'later unconfined Git commands',
        "'Read-only file system' (EROFS)",
        "'Permission denied' (EACCES) can instead come from ordinary file permissions",
        'Host services reached through Unix sockets remain outside this filesystem boundary',
        'changing the writable roots requires restarting',
        // /dev is a fresh minimal devtmpfs, so host device nodes are absent
        // (ENOENT), not read-only: the remedy is an argv change, not a root grant.
        'minimal synthetic device tree',
        'QWEN_SANDBOX=bwrap qwen sandbox',
        // The inspection remedy is addressed to the user, from the project
        // directory, with the settings-derived scope of the report named.
        'tell the user to run it from this project directory on the host',
        'Do NOT work around a refusal',
      ],
      [
        "(EROFS) or 'Permission denied'",
        'You are running in a sandbox container',
        '# Outside of Sandbox',
        '# macOS Seatbelt',
      ],
    );
    expect(prompt).toMatchSnapshot();
  });

  it('should include non-sandbox instructions when SANDBOX env var is not set', () => {
    const prompt = sandboxPrompt(
      undefined,
      ['# Outside of Sandbox'],
      ['# Sandbox', '# macOS Seatbelt'],
    );
    expect(prompt).toMatchSnapshot();
  });

  it('should include git instructions when in a git repo', () => {
    vi.mocked(isGitRepository).mockReturnValue(true);
    const prompt = unsandboxed();
    expect(prompt).toContain('# Git Repository');
    expect(prompt).toContain('## Git as Source of Truth');
    expect(prompt).toContain('`git log` / `git blame` are authoritative');
    expect(prompt).toMatchSnapshot();
  });

  it('should not include git instructions when not in a git repo', () => {
    vi.mocked(isGitRepository).mockReturnValue(false);
    const prompt = unsandboxed();
    expect(prompt).not.toContain('# Git Repository');
    expect(prompt).not.toContain('Git as Source of Truth');
    expect(prompt).not.toMatch(/\bgit (?:log|blame|status|diff|show|add)\b/);
    expect(prompt).toMatchSnapshot();
  });

  describe('QWEN_SYSTEM_MD environment variable', () => {
    it.each([
      ['should use default prompt when QWEN_SYSTEM_MD is "false"', 'false'],
      ['should use default prompt when QWEN_SYSTEM_MD is "0"', '0'],
    ])('%s', (_title, value) => {
      vi.stubEnv('QWEN_SYSTEM_MD', value);
      const prompt = getCoreSystemPrompt();
      expect(fs.readFileSync).not.toHaveBeenCalled();
      expect(prompt).not.toContain(CUSTOM);
    });

    it('should throw error if QWEN_SYSTEM_MD points to a non-existent file', () => {
      const customPath = '/non/existent/path/system.md';
      vi.stubEnv('QWEN_SYSTEM_MD', customPath);
      vi.mocked(fs.existsSync).mockReturnValue(false);
      expect(() => getCoreSystemPrompt()).toThrow(
        `missing system prompt file '${path.resolve(customPath)}'`,
      );
    });

    const customMd = path.resolve('/custom/path/SyStEm.Md');
    const readCases: Array<[string, string, string, string?]> = [
      [
        'should read from default path when QWEN_SYSTEM_MD is "true"',
        'true',
        DEFAULT_MD,
      ],
      [
        'should read from default path when QWEN_SYSTEM_MD is "1"',
        '1',
        DEFAULT_MD,
      ],
      [
        'should read from custom path when QWEN_SYSTEM_MD provides one, preserving case',
        customMd,
        customMd,
      ],
      [
        'should expand tilde in custom path when QWEN_SYSTEM_MD is set',
        '~/custom/system.md',
        path.resolve(path.join(HOME, 'custom/system.md')),
        HOME,
      ],
    ];
    it.each(readCases)('%s', (_title, value, expectedPath, home) => {
      if (home) vi.spyOn(os, 'homedir').mockReturnValue(home);
      vi.stubEnv('QWEN_SYSTEM_MD', value);
      mockAnyFile();
      const prompt = getCoreSystemPrompt();
      expect(fs.readFileSync).toHaveBeenCalledWith(expectedPath, 'utf8');
      expect(prompt).toBe(CUSTOM);
    });
  });

  describe('QWEN_SYSTEM_IDENTITY_MD environment variable', () => {
    const customIdentity =
      'You are Acme Code, an interactive CLI agent for Acme Corp.';
    const identityPath = path.resolve('/custom/identity.md');

    /** Sample the default identity from the live prompt to avoid drift. */
    const sampleDefaultIdentity = (): string => {
      vi.stubEnv('QWEN_SYSTEM_IDENTITY_MD', undefined);
      vi.stubEnv('QWEN_SYSTEM_MD', undefined);
      return getCoreSystemPrompt().split('\n\n', 1)[0];
    };

    /** QWEN_SYSTEM_MD=`systemPath` (reading as `text`) plus an identity env. */
    function withSystemMdAndIdentity(systemPath: string, text: string) {
      vi.stubEnv('QWEN_SYSTEM_MD', systemPath);
      vi.stubEnv('QWEN_SYSTEM_IDENTITY_MD', identityPath);
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockImplementation((p) => {
        if (path.resolve(String(p)) === systemPath) return text;
        throw new Error(`identity file should not be read: ${String(p)}`);
      });
      return getCoreSystemPrompt();
    }

    /** The prompt keeps the sampled default identity and reads no file. */
    function expectDefaultIdentity(envValue?: string) {
      const defaultIdentity = sampleDefaultIdentity();
      if (envValue !== undefined) {
        vi.stubEnv('QWEN_SYSTEM_IDENTITY_MD', envValue);
      }
      const prompt = getCoreSystemPrompt();
      expect(prompt.startsWith(defaultIdentity)).toBe(true);
      expect(fs.readFileSync).not.toHaveBeenCalled();
    }

    it('should keep default prompt byte-identical when identity env is unset', () => {
      expectDefaultIdentity();
    });

    it('should replace only the identity sentence when identity env points to a file', () => {
      const defaultIdentity = sampleDefaultIdentity();
      vi.stubEnv('QWEN_SYSTEM_IDENTITY_MD', identityPath);
      mockOnlyFile(identityPath, `${customIdentity}  \n\n`);

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
      const prompt = withSystemMdAndIdentity(
        systemPath,
        'full system override',
      );
      expect(prompt).toBe('full system override');
      expect(fs.readFileSync).toHaveBeenCalledTimes(1);
      expect(fs.readFileSync).toHaveBeenCalledWith(systemPath, 'utf8');
    });

    it('should not inject identity when QWEN_SYSTEM_MD points to an empty file', () => {
      const systemPath = path.resolve('/custom/empty-system.md');
      const prompt = withSystemMdAndIdentity(systemPath, '');
      expect(prompt).toBe('');
      expectText(prompt, [], [customIdentity, 'You are Qwen Code']);
    });

    it('should throw when identity env points to a missing file', () => {
      const missingPath = path.resolve('/missing/identity.md');
      vi.stubEnv('QWEN_SYSTEM_IDENTITY_MD', missingPath);
      vi.mocked(fs.existsSync).mockReturnValue(false);
      expect(() => getCoreSystemPrompt()).toThrow(
        `missing system identity file '${missingPath}'`,
      );
    });

    it('should throw when identity env points to an empty or whitespace-only file', () => {
      const blankPath = path.resolve('/custom/blank-identity.md');
      vi.stubEnv('QWEN_SYSTEM_IDENTITY_MD', blankPath);
      mockAnyFile('  \n\t  ');
      expect(() => getCoreSystemPrompt()).toThrow(
        `empty system identity file '${blankPath}'`,
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
      (switchValue) => expectDefaultIdentity(switchValue),
    );
  });

  describe('QWEN_WRITE_SYSTEM_MD environment variable', () => {
    it.each([
      [
        'should not write to file when QWEN_WRITE_SYSTEM_MD is "false"',
        'false',
      ],
      ['should not write to file when QWEN_WRITE_SYSTEM_MD is "0"', '0'],
    ])('%s', (_title, value) => {
      vi.stubEnv('QWEN_WRITE_SYSTEM_MD', value);
      getCoreSystemPrompt();
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });

    const customMd = path.resolve('/custom/path/system.md');
    const writeCases: Array<[string, string, string, string?]> = [
      [
        'should write to default path when QWEN_WRITE_SYSTEM_MD is "true"',
        'true',
        DEFAULT_MD,
      ],
      [
        'should write to default path when QWEN_WRITE_SYSTEM_MD is "1"',
        '1',
        DEFAULT_MD,
      ],
      [
        'should write to custom path when QWEN_WRITE_SYSTEM_MD provides one',
        customMd,
        customMd,
      ],
      [
        'should expand tilde in custom path when QWEN_WRITE_SYSTEM_MD is set',
        '~/custom/system.md',
        path.resolve(path.join(HOME, 'custom/system.md')),
        HOME,
      ],
      [
        'should expand tilde in custom path when QWEN_WRITE_SYSTEM_MD is just ~',
        '~',
        path.resolve(HOME),
        HOME,
      ],
    ];
    it.each(writeCases)('%s', (_title, value, expectedPath, home) => {
      if (home) vi.spyOn(os, 'homedir').mockReturnValue(home);
      vi.stubEnv('QWEN_WRITE_SYSTEM_MD', value);
      getCoreSystemPrompt();
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expectedPath,
        expect.any(String),
      );
    });
  });

  describe('outputStyle parameter', () => {
    const concise = getBuiltInOutputStyle('Concise')!;
    const learning = getBuiltInOutputStyle('Learning')!;
    const STYLED_IDENTITY = 'responding according to your "Output Style"';
    const SWE_IDENTITY = 'specializing in software engineering tasks';

    it('leaves the prompt untouched when no style is active', () => {
      const prompt = getCoreSystemPrompt();
      for (const style of BUILT_IN_OUTPUT_STYLES) {
        expect(prompt).not.toContain(`# Output Style: ${style.name}`);
      }
    });

    it('appends the style section to the end of the base prompt', () => {
      const prompt = corePrompt({ style: concise });
      expect(prompt).toContain('# Output Style: Concise');
      // The style refines the mandates, so it has to land after them...
      expect(prompt.indexOf('# Output Style: Concise')).toBeGreaterThan(
        prompt.indexOf('# Core Mandates'),
      );
      // ...and the base prompt must still be intact.
      expect(prompt).toContain('# Core Mandates');
    });

    it('keeps the style ahead of the context and volatile layers', () => {
      const prompt = corePrompt({
        memory: 'MEMORY_MARKER',
        append: 'APPEND_MARKER',
        style: concise,
      });
      const styleIndex = prompt.indexOf('# Output Style: Concise');
      expect(styleIndex).toBeGreaterThan(-1);
      expect(styleIndex).toBeLessThan(prompt.indexOf('MEMORY_MARKER'));
      expect(styleIndex).toBeLessThan(prompt.indexOf('APPEND_MARKER'));
    });

    it('is ignored when QWEN_SYSTEM_MD replaces the base prompt', () => {
      vi.stubEnv('QWEN_SYSTEM_MD', '/custom/path/system.md');
      mockAnyFile();
      expectText(
        corePrompt({ style: concise }),
        [CUSTOM],
        ['# Output Style: Concise'],
      );
    });

    it('points the identity sentence at the style when one is active', () => {
      expect(getCoreSystemPrompt()).toContain(SWE_IDENTITY);
      expectText(
        corePrompt({ style: concise }),
        [STYLED_IDENTITY],
        [SWE_IDENTITY],
      );
    });

    it('drops only the software-engineering section for keepCodingInstructions: false', () => {
      const nonCoding = {
        ...concise,
        name: 'NonCoding',
        keepCodingInstructions: false,
      };
      const prompt = corePrompt({ style: nonCoding });
      expect(prompt).not.toContain('## Software Engineering Tasks');
      expect(prompt).not.toContain('**Report outcomes faithfully:**');
      expect(prompt).toContain(
        '# Primary Workflows\n\n- Tool results and user messages',
      );
      expect(prompt).toContain('- When you see a <persisted-output> tag');
      // Everything else the base prompt carries must survive — dropping the
      // safety rules along with the workflow guidance would be a regression.
      expectText(prompt, [
        '# Core Mandates',
        '# Executing actions with care',
        '## Using Your Tools',
        '## Tone and Style (CLI Interaction)',
        '# Output Style: NonCoding',
      ]);
    });

    it('keeps the software-engineering section under a normal style', () => {
      expectText(corePrompt({ style: concise }), [
        '## Software Engineering Tasks',
        'did not run a verification step',
      ]);
    });

    it('omits Learning from headless prompts that cannot receive a reply', () => {
      expectText(
        corePrompt({ mode: 'headless', style: learning }),
        ['This is a non-interactive, single-turn run', SWE_IDENTITY],
        [
          STYLED_IDENTITY,
          '# Output Style: Learning',
          'TODO(human)',
          'until the user has written their piece',
        ],
      );
    });

    it('keeps Learning in interactive prompts', () => {
      expectText(corePrompt({ style: learning }), [
        '# Output Style: Learning',
        'TODO(human)',
      ]);
    });

    it('keeps Learning in acp prompts', () => {
      expect(corePrompt({ mode: 'acp', style: learning })).toContain(
        '# Output Style: Learning',
      );
    });

    it('keeps the style section under a QWEN_SYSTEM_IDENTITY_MD override', () => {
      // The override owns the identity sentence verbatim, so the styled
      // wording is skipped there, but the style itself still has to land.
      const identityPath = path.resolve('/custom/identity.md');
      const customIdentity =
        'You are Acme Code, an interactive CLI agent for Acme Corp.';
      vi.stubEnv('QWEN_SYSTEM_IDENTITY_MD', identityPath);
      mockOnlyFile(identityPath, customIdentity);

      const prompt = corePrompt({ style: concise });
      expect(prompt.startsWith(customIdentity)).toBe(true);
      expectText(prompt, ['# Output Style: Concise'], [STYLED_IDENTITY]);
    });

    it('does not bake the style into the QWEN_WRITE_SYSTEM_MD dump', () => {
      // The dump is meant to be reusable as a QWEN_SYSTEM_MD base; baking the
      // style in would apply it twice when that file is fed back.
      vi.stubEnv('QWEN_WRITE_SYSTEM_MD', 'true');
      corePrompt({ style: concise });
      const [, written] = vi.mocked(fs.writeFileSync).mock.calls[0];
      expect(written).not.toContain('# Output Style: Concise');
      // ...and the dumped identity sentence is the unstyled one.
      expect(written).toContain(SWE_IDENTITY);
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

  beforeEach(() => resetPromptEnv('QWEN_CODE_TOOL_CALL_STYLE'));
  afterEach(() => vi.unstubAllEnvs());

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
      if (systemMd) mockAnyFile();

      const config = makeConfig({ customPrompt, style, ...flags });
      const reminded = resolveMainSessionOutputStyle(config) !== undefined;
      const prompt = getMainSessionBaseSystemPrompt(config);

      expect(reminded).toBe(prompt.includes('# Output Style:'));
      if (customPrompt) {
        // The override replaces the base verbatim.
        expectText(prompt, [customPrompt], ['You are Qwen Code']);
      } else if (!systemMd) {
        expect(prompt).toContain('You are Qwen Code');
      }
    },
  );

  const headlessConfig = () => makeConfig({ interactive: false, acp: false });

  it('forwards the config model to the base prompt', () => {
    const config = {
      ...makeConfig({ interactive: true, acp: false }),
      getModel: () => 'qwen3-coder-7b',
    };
    expect(getMainSessionBaseSystemPrompt(config)).toContain(
      '<function=run_shell_command>',
    );
  });

  it('forwards CodeModeOnly to the base prompt', () => {
    const config = makeConfig({
      interactive: true,
      acp: false,
      codeModeOnly: true,
    });
    expect(getMainSessionBaseSystemPrompt(config)).toContain(
      "Ordinary tools exist only inside 'exec'",
    );
  });

  it('forwards the todo_write setting to the base prompt', () => {
    const config = { ...headlessConfig(), isTodoWriteEnabled: () => true };
    expect(getMainSessionBaseSystemPrompt(config)).toContain('todo_write');
  });

  it('describes the admitted tool execution sandbox instead of the host process', () => {
    const config = {
      ...headlessConfig(),
      getShellExecutionSandbox: () => ({
        filesystem: 'read-only' as const,
        workspace: '/workspace',
        installation: '/installation',
        state: '/state',
        network: 'closed' as const,
        requestedBackend: 'bwrap' as const,
      }),
    };
    expectText(
      getMainSessionBaseSystemPrompt(config),
      ['# Tool Execution Sandbox (bwrap)', 'workspace is read-only'],
      ['# Outside of Sandbox'],
    );
  });

  it.each(['open', 'closed'] as const)(
    'names effective command networking %s in the model prompt',
    (network) => {
      const config = {
        ...headlessConfig(),
        getShellExecutionSandbox: () => ({
          filesystem: 'read-only' as const,
          network,
          requestedBackend: 'bwrap' as const,
          effectiveBackend: 'bwrap' as const,
          workspace: '/workspace',
          installation: '/installation',
          state: '/state',
        }),
      };
      const prompt = getMainSessionBaseSystemPrompt(config);
      expect(prompt).toContain(`command network policy is ${network}`);
      expect(prompt.includes('Closed networking prevents')).toBe(
        network === 'closed',
      );
    },
  );

  it.each(['read-only', 'workspace-write'] as const)(
    'describes resolved Landlock restrictions for %s',
    (filesystem) => {
      const config = {
        ...makeConfig({ interactive: false, acp: false }),
        getShellExecutionSandbox: () => ({
          filesystem,
          workspace: '/workspace',
          installation: '/installation',
          state: '/state',
          network: 'open' as const,
          requestedBackend: 'auto' as const,
          effectiveBackend: 'landlock' as const,
          enforcement: 'partial' as const,
          landlockAbi: 3,
        }),
      };

      const prompt = getMainSessionBaseSystemPrompt(config);
      expect(prompt).toContain('# Tool Execution Sandbox (Landlock, partial)');
      expect(prompt).toContain('Command network policy is open');
      expect(prompt).toContain(
        `workspace is ${filesystem === 'workspace-write' ? 'writable' : 'read-only'}`,
      );
      expect(prompt).toContain('Treat EACCES as a possible sandbox refusal');
      expect(prompt).toContain(
        'report it to the user and name the refused path',
      );
      expect(prompt).toContain('Do NOT work around a refusal');
      expect(prompt).toContain('metadata operations');
      expect(prompt).toContain('does not create PID or network namespaces');
      expect(prompt).not.toContain('EROFS');
      expect(prompt).not.toContain('# Tool Execution Sandbox (bwrap)');
      expect(prompt).not.toContain('# Outside of Sandbox');
    },
  );
});

describe('main-session style: project trust gate', () => {
  const projectStyle: OutputStyleDefinition = {
    name: 'Team',
    source: 'project',
    description: 'The style this repo ships',
    keepCodingInstructions: true,
    prompt: 'Answer the way this team answers.',
  };
  const userStyle: OutputStyleDefinition = {
    ...projectStyle,
    name: 'Mine',
    source: 'user',
  };

  /** An interactive session on `style`; isTrustedFolder only when given. */
  const trustConfig = (style: OutputStyleDefinition, trusted?: boolean) => ({
    ...makeConfig({ style, interactive: true, acp: false }),
    ...(trusted === undefined ? {} : { isTrustedFolder: () => trusted }),
  });

  beforeEach(() => resetPromptEnv('QWEN_CODE_TOOL_CALL_STYLE'));
  afterEach(() => vi.unstubAllEnvs());

  // Trust can be revoked mid-session — the IDE branch flips the verdict in
  // place — while the catalog is read once at startup, so the gate has to hold
  // where the style is consumed, not only where it is loaded.
  it('drops a project style once the workspace is untrusted', () => {
    const config = trustConfig(projectStyle, false);
    expect(resolveMainSessionOutputStyle(config)).toBeUndefined();
    expect(getMainSessionBaseSystemPrompt(config)).not.toContain(
      '# Output Style: Team',
    );
  });

  it('keeps a project style while the workspace is trusted', () => {
    const config = trustConfig(projectStyle, true);
    expect(resolveMainSessionOutputStyle(config)).toBe(projectStyle);
    expect(getMainSessionBaseSystemPrompt(config)).toContain(
      '# Output Style: Team',
    );
  });

  // The gate is about repo-authored prompts; a style from the user's own home
  // directory is theirs either way.
  it('keeps a user style in an untrusted workspace', () => {
    const config = trustConfig(userStyle, false);
    expect(resolveMainSessionOutputStyle(config)).toBe(userStyle);
    expect(getMainSessionBaseSystemPrompt(config)).toContain(
      '# Output Style: Mine',
    );
  });

  it('keeps a project style when the config reports no trust verdict', () => {
    expect(resolveMainSessionOutputStyle(trustConfig(projectStyle))).toBe(
      projectStyle,
    );
  });
});

describe('Model-specific tool call formats', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('SANDBOX', undefined);
  });

  /** The prompt for `model` outside a git repo. */
  function modelPrompt(model?: string, memory?: string) {
    vi.mocked(isGitRepository).mockReturnValue(false);
    return getCoreSystemPrompt(memory, model);
  }

  const XML_CALL = '<function=run_shell_command>';
  const JSON_CALL = '{"name": "run_shell_command"';
  const BRACKET_CALL = '[tool_call: run_shell_command for';

  it.each([
    ['generic', 'gpt-4'],
    ['qwen-coder', 'qwen3-coder-7b'],
    ['qwen-vl', 'qwen-vl-max'],
    ['gemma4', 'gemma-4'],
  ])(
    'reads the write target before establishing absence in the %s tool-call example',
    (_style, model) => {
      const prompt = modelPrompt(model);
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
    const prompt = modelPrompt('qwen3-coder-7b');
    // XML-style calls, and neither the bracket nor the JSON style.
    expectText(
      prompt,
      [
        '<tool_call>',
        XML_CALL,
        '<parameter=command>',
        '</function>',
        '</tool_call>',
      ],
      [BRACKET_CALL, JSON_CALL],
    );
    expect(prompt).toMatchSnapshot();
  });

  it('should use JSON format for qwen-vl model', () => {
    const prompt = modelPrompt('qwen-vl-max');
    // JSON-style calls, and neither the bracket nor the XML-with-parameters style.
    expectText(
      prompt,
      [
        '<tool_call>',
        JSON_CALL,
        '"arguments": {"command": "node server.js", "is_background": true}',
        '</tool_call>',
      ],
      [BRACKET_CALL, XML_CALL, '<parameter=command>'],
    );
    expect(prompt).toMatchSnapshot();
  });

  it('should use bracket format for generic models', () => {
    const prompt = modelPrompt('gpt-4');
    // Bracket-style calls, and neither the XML nor the JSON style.
    expectText(
      prompt,
      [BRACKET_CALL, 'because it must run in the background]'],
      [XML_CALL, '<parameter=command>', JSON_CALL],
    );
    expect(prompt).toMatchSnapshot();
  });

  it('should use bracket format when no model is specified', () => {
    const prompt = modelPrompt();
    // Bracket-style calls by default, and neither the XML nor the JSON style.
    expectText(
      prompt,
      [BRACKET_CALL, 'because it must run in the background]'],
      [XML_CALL, JSON_CALL],
    );
    expect(prompt).toMatchSnapshot();
  });

  it('should preserve model-specific formats with user memory', () => {
    const prompt = modelPrompt(
      'qwen3-coder-14b',
      'User prefers concise responses.',
    );
    // XML-style calls plus the user memory behind its separator.
    expectText(prompt, [
      '<tool_call>',
      XML_CALL,
      '---',
      'User prefers concise responses.',
    ]);
    expect(prompt).toMatchSnapshot();
  });

  it('should preserve model-specific formats with sandbox environment', () => {
    vi.stubEnv('SANDBOX', 'true');
    const prompt = modelPrompt('qwen-vl-plus');
    // JSON-style calls plus the sandbox instructions.
    expectText(prompt, [JSON_CALL, '# Sandbox']);
    expect(prompt).toMatchSnapshot();
  });

  it('should use native Gemma 4 format for gemma4 models', () => {
    // Detected by regex; native token boundaries and quotes, and none of the
    // legacy/generic formats.
    const prompt = modelPrompt('unsloth/gemma-4-26B-A4B-it-qat');
    expectText(
      prompt,
      [
        '<|tool_call>call:run_shell_command',
        '{command:<|"|>node server.js<|"|>,is_background:true}<tool_call|>',
      ],
      [BRACKET_CALL, XML_CALL, JSON_CALL],
    );
    expect(prompt).toMatchSnapshot();
  });

  it('should override tool call format via QWEN_CODE_TOOL_CALL_STYLE env variable for gemma4', () => {
    vi.stubEnv('QWEN_CODE_TOOL_CALL_STYLE', 'gemma4');
    // A non-gemma model verifies the env var takes precedence.
    const prompt = modelPrompt('gpt-4');
    expect(prompt).toContain('<|tool_call>call:run_shell_command');
    expect(prompt).not.toContain(BRACKET_CALL);
  });
});

describe('resident tool gating (#12032)', () => {
  beforeEach(() => {
    resetPromptEnv('QWEN_CODE_TOOL_CALL_STYLE', 'SANDBOX');
    vi.mocked(isGitRepository).mockReturnValue(false);
  });

  const promptFor = (declaredTools?: ReadonlySet<string>) =>
    corePrompt({ model: 'gpt-4', declaredTools });

  it('renders identically when every tool is declared', () => {
    const everyTool = new Set<string>(Object.values(ToolNames));

    expect(promptFor(everyTool)).toBe(promptFor());
  });

  it('drops the dedicated-tool lines for tools the session did not declare', () => {
    const prompt = promptFor(new Set([ToolNames.SHELL, ToolNames.READ_FILE]));

    expect(prompt).toContain(`To read files use '${ToolNames.READ_FILE}'`);
    expect(prompt).not.toContain(`To search for files use '${ToolNames.GLOB}'`);
    expect(prompt).not.toContain('- **Subagent Delegation:**');
    expect(prompt).not.toContain('- **Codebase Search:**');
    // Shell policy survives because the shell itself is declared.
    expect(prompt).toContain('- **Background Processes:**');
  });

  it('drops the prefer-dedicated bullet when it would recommend nothing', () => {
    const prompt = promptFor(new Set([ToolNames.AGENT]));

    expect(prompt).not.toContain('- **Prefer Dedicated Tools:**');
    expect(prompt).not.toContain('- **Background Processes:**');
    expect(prompt).toContain('- **Subagent Delegation:**');
    // Policy that does not depend on the tool surface stays either way.
    expect(prompt).toContain('- **Tool Fallback:**');
    expect(prompt).toContain('- **Respect Tool Decisions:**');
  });

  it('keeps every safety section regardless of the declared set', () => {
    const prompt = promptFor(new Set([ToolNames.READ_FILE]));

    expect(prompt).toContain('# Executing actions with care');
    expect(prompt).toContain('**Denied Tool Calls:**');
    expect(prompt).toContain('## Security and Safety Rules');
    expect(prompt).toContain('**Report outcomes faithfully:**');
    expect(prompt).toContain('did not run a verification step');
  });

  it('keeps only examples whose tools are all declared', () => {
    const prompt = promptFor(
      new Set([ToolNames.READ_FILE, ToolNames.WRITE_FILE, ToolNames.SHELL]),
    );

    expect(prompt).toContain('# Examples');
    expect(prompt).toContain(`[tool_call: ${ToolNames.SHELL}`);
    expect(prompt).not.toContain(`[tool_call: ${ToolNames.GLOB}`);
    // `edit` is called from the refactor example's later paragraphs, past a
    // blank line: the block has to be gated as one unit, not per paragraph.
    expect(prompt).not.toContain(`[tool_call: ${ToolNames.EDIT}`);
    expect(prompt).toContain('user: Write tests for someFile.ts');
  });

  it.each(['gpt-4', 'qwen3-coder', 'qwen3-vl', 'gemma4'])(
    'omits the examples heading when no %s example tools are declared',
    (model) => {
      const declaredTools = new Set([ToolNames.ASK_USER_QUESTION]);
      expectText(
        corePrompt({ model, declaredTools }),
        [
          '# Executing actions with care',
          "Use 'ask_user_question' when you need clarification",
        ],
        ['# Examples', '<example>'],
      );
    },
  );

  // A `tools.eager` allowlist sized for file work, plus the tools that stay
  // declared whatever the allowlist says (they are exempt from eager demotion).
  const FILE_WORK_TOOLS: ReadonlySet<string> = new Set<string>([
    ToolNames.READ_FILE,
    ToolNames.WRITE_FILE,
    ToolNames.EDIT,
    ToolNames.GLOB,
    ToolNames.GREP,
    ToolNames.SHELL,
    ToolNames.SKILL,
    ToolNames.ASK_USER_QUESTION,
    ToolNames.TOOL_SEARCH,
  ]);
  const NARROW_TOOLS: ReadonlySet<string> = new Set<string>([
    ToolNames.READ_FILE,
    ToolNames.SHELL,
    ToolNames.SKILL,
    ToolNames.ASK_USER_QUESTION,
    ToolNames.TOOL_SEARCH,
  ]);

  const countExamples = (prompt: string) =>
    prompt.split('<example>').length - 1;

  /** The two sections this change gates: tool policy, and the examples. */
  function gatedParts(prompt: string): [string, string] {
    const guidance =
      prompt.match(/## Using Your Tools\n[\s\S]*?(?=\n#{1,2} )/)?.[0] ?? '';
    const examples =
      prompt.match(/# Examples[\s\S]*?(?=\n# Final Reminder)/)?.[0] ?? '';
    return [guidance, examples];
  }

  it('saves about 1.1k characters of policy text for a file-work allowlist when Agent is not bridge-reachable', () => {
    const full = promptFor();
    const trimmed = promptFor(FILE_WORK_TOOLS);

    // 无声明快照的基线假定所有工具都可用，因此共移除 1,135 字符：
    // 委派与搜索规则占 818，未列入白名单的 monitor 规则占 317。
    // 示例仅调用文件工具和 shell，全部保留。字符区间允许措辞精简，
    // 同时检测节省量丢失；此口径不同于默认不声明 monitor 的真实会话。
    const saved = full.length - trimmed.length;
    expect(saved).toBeGreaterThan(900);
    expect(saved).toBeLessThan(1_500);
    expect(countExamples(trimmed)).toBe(countExamples(full));
  });

  it('saves only the monitor policy text for a file-work allowlist when Agent is bridge-reachable', () => {
    // The bridge-intact trimmed session is the default: tool_search/tool_call
    // are exempt from `tools.eager`, so Agent stays reachable and §4.6 keeps
    // both Agent bullets. The only policy text that drops is the monitor
    // line (317 characters at the commit that added this pin) — the
    // delegation (448) and codebase-search (368) bullets survive. Goes red
    // if the Agent bullets start dropping in a bridge-intact session (the
    // §4.6 regression) or if the monitor line stops dropping.
    const full = promptFor();
    const trimmed = corePrompt({
      model: 'gpt-4',
      declaredTools: FILE_WORK_TOOLS,
      agentReachable: true,
    });

    expect(trimmed).toContain('- **Subagent Delegation:**');
    expect(trimmed).toContain('- **Codebase Search:**');
    expect(trimmed).not.toContain('- **Monitor Processes:**');
    const saved = full.length - trimmed.length;
    expect(saved).toBeGreaterThan(250);
    expect(saved).toBeLessThan(450);
    expect(countExamples(trimmed)).toBe(countExamples(full));
  });

  it('keeps the policy text of every tool that is declared', () => {
    // The other half of the invariant: gating must not take guidance for a
    // tool the session does have. Only the bullets whose tools are absent go.
    expectText(
      promptFor(FILE_WORK_TOOLS),
      [
        `To read files use '${ToolNames.READ_FILE}'`,
        `To edit files use '${ToolNames.EDIT}'`,
        `To create files use '${ToolNames.WRITE_FILE}'`,
        `To search for files use '${ToolNames.GLOB}'`,
        `To search the content of files, use '${ToolNames.GREP}'`,
        '- **Prefer Dedicated Tools:**',
        '- **File Paths:**',
        '- **Background Processes:**',
        '- **Interactive Commands:**',
      ],
      ['- **Subagent Delegation:**', '- **Codebase Search:**'],
    );
  });

  // `monitor` is registered `shouldDefer=true, alwaysLoad=false`, so a default
  // session leaves it out of `getFunctionDeclarations()` and therefore out of
  // the prompt snapshot built from it. The bullet has to follow the tool:
  // discovery of a still-deferred `monitor` is the startup reminder's job, and
  // usage guidance for a deferred tool is exactly what #12032 gates away.
  // Agent is the one exception (`agentReachable`): its delegation bullets are
  // the policy that sends the model to the bridge to discover Agent at all, so
  // gating them whenever Agent is deferred would turn deferral into silent
  // removal — no other deferred tool's guidance drives its own discovery.
  it('gates the monitor bullet on the session declaring monitor', () => {
    const withMonitor = new Set<string>([
      ...FILE_WORK_TOOLS,
      ToolNames.MONITOR,
    ]);

    expect(promptFor(withMonitor)).toContain(
      `- **Monitor Processes:** Use the '${ToolNames.MONITOR}' tool`,
    );
    expect(promptFor(FILE_WORK_TOOLS)).not.toContain(
      '- **Monitor Processes:**',
    );
  });

  it('drops example blocks too once the allowlist is narrower', () => {
    const full = promptFor();
    const trimmed = promptFor(NARROW_TOOLS);

    expect(trimmed.length).toBeLessThan(full.length);
    expect(countExamples(trimmed)).toBe(countExamples(full) - 2);
    expectText(
      gatedParts(trimmed)[1],
      ['node server.js'],
      ['Refactor the auth logic', 'Write tests for someFile.ts'],
    );
  });

  it('gates the model-specific example notations, not just the bracket form', () => {
    // getToolCallExamples picks a different notation per model, so a filter
    // that only understood `[tool_call: …]` would quietly stop gating the
    // examples for every Qwen model that has its own set.
    for (const model of ['qwen3-coder', 'qwen3-vl', 'gemma4']) {
      const full = corePrompt({ model });
      const trimmed = corePrompt({ model, declaredTools: NARROW_TOOLS });
      expect(countExamples(trimmed)).toBe(countExamples(full) - 2);
      // Checked on the examples section alone: `glob` also appears in prose
      // this change deliberately leaves untouched.
      expect(gatedParts(trimmed)[1]).not.toContain(ToolNames.GLOB);
    }
  });

  it('changes nothing outside the two gated sections', () => {
    const strip = (prompt: string) => {
      const [guidance, examples] = gatedParts(prompt);
      expect(guidance).not.toBe('');
      expect(examples).not.toBe('');
      return prompt.replace(guidance, '').replace(examples, '');
    };

    expect(strip(promptFor(FILE_WORK_TOOLS))).toBe(strip(promptFor()));
  });

  it('never names an undeclared tool inside the gated sections', () => {
    // Extracted so the bridge-reachable arm below reads the gated text, the
    // declared set and the regex exactly as this one does.
    const leakedNames = (
      declaredTools: ReadonlySet<string>,
      agentReachable?: boolean,
    ) => {
      const [guidance, examples] = gatedParts(
        corePrompt({ model: 'gpt-4', declaredTools, agentReachable }),
      );
      expect(guidance).not.toBe('');
      expect(examples).not.toBe('');
      const gated = `${guidance}\n${examples}`;

      // Mechanical sweep rather than hand-picked assertions: it catches
      // under-gating (a line that survived and should not have) and, read the
      // other way with a full set, over-gating.
      return Object.values(ToolNames).filter(
        (name) =>
          name !== ToolNames.TOOL_CALL &&
          !declaredTools.has(name) &&
          new RegExp(`(?<![a-z_])${name}(?![a-z_])`).test(gated),
      );
    };

    expect(leakedNames(NARROW_TOOLS)).toEqual([]);

    // The one configuration in which the gated sections may legitimately name
    // an undeclared tool: a session that withholds `agent` but keeps it
    // bridge-reachable retains the two Agent bullets (§4.6). Pinned exactly —
    // a second name leaking through that branch, here or in a future one,
    // fails this arm instead of shipping.
    expect(leakedNames(NARROW_TOOLS, true)).toEqual([ToolNames.AGENT]);
  });

  it('gates every tool name the gated sections can mention, on every example set', () => {
    const everyTool = new Set<string>(Object.values(ToolNames));

    // Both arms: with `agentReachable` unset nothing withheld may survive,
    // and with it set the exception is exactly one name wide. Sweeping only
    // the unset arm would leave the one configuration where the sections may
    // legitimately name an undeclared tool — the one the new exception branch
    // creates — outside the invariant the design's §7 item 3 calls the
    // config-independent guard.
    for (const agentReachable of [undefined, true]) {
      const leaked: string[] = [];

      // Withhold one tool at a time, against each model's example set: the
      // config-independent version of the invariant above, and the check that
      // would have caught the example notations going ungated.
      for (const model of ['gpt-4', 'qwen3-coder', 'qwen3-vl', 'gemma4']) {
        for (const tool of everyTool) {
          // `ask_user_question` is exempt from `tools.eager`, so it is declared
          // in practice, and the interaction-mode bullet naming it also carries
          // the policy for not asking questions — gating that bullet would drop
          // real guidance. Recorded as residue in the design's §6. `tool_call`
          // is also the literal protocol marker in every example notation, so a
          // text scan cannot distinguish that syntax from the bridge tool name.
          if (
            tool === ToolNames.ASK_USER_QUESTION ||
            tool === ToolNames.TOOL_CALL
          ) {
            continue;
          }
          const declaredTools = new Set(everyTool);
          declaredTools.delete(tool);
          const [guidance, examples] = gatedParts(
            corePrompt({ model, declaredTools, agentReachable }),
          );
          const gated = `${guidance}\n${examples}`;
          if (new RegExp(`(?<![a-z_])${tool}(?![a-z_])`).test(gated)) {
            leaked.push(`${model}: ${tool}`);
          }
        }
      }

      // Distinct names, not occurrences: under the reachable arm the surviving
      // Agent bullet names `agent` on every model's set, and nothing else may.
      expect([...new Set(leaked.map((entry) => entry.split(': ')[1]))]).toEqual(
        agentReachable ? [ToolNames.AGENT] : [],
      );
    }
  });

  it('leaves CodeModeOnly guidance untouched by the declared set', () => {
    const codeModePrompt = (declaredTools?: ReadonlySet<string>) =>
      corePrompt({ model: 'gpt-4', codeMode: true, declaredTools });

    // Reverse check: in code mode the tools are reached as `tools.<jsName>`
    // inside `exec` and are not declarations, so a narrow declared set must not
    // strip that guidance.
    expect(codeModePrompt(new Set([ToolNames.EXEC]))).toBe(codeModePrompt());
  });

  it('keeps Agent guidance when Agent is bridge-reachable', () => {
    const base = {
      ...makeConfig({ interactive: true, acp: false }),
      getModel: () => 'gpt-4',
    };

    // `/context` and the request share these session snapshots, so the prompt
    // must read them rather than recompute from a live registry.
    const gated = getMainSessionBaseSystemPrompt({
      ...base,
      getPromptToolSnapshot: () =>
        new Set([...FILE_WORK_TOOLS, ToolNames.TOOL_CALL]),
      getPromptAgentReachable: () => true,
    });
    const ungated = getMainSessionBaseSystemPrompt(base);

    expect(gated).toContain('- **Subagent Delegation:**');
    expect(gated).toContain('- **Codebase Search:**');
    expect(ungated).toContain('- **Subagent Delegation:**');
    expect(gated.length).toBeLessThan(ungated.length);
  });
});

describe('CodeModeOnly tool guidance', () => {
  beforeEach(() => {
    resetPromptEnv('QWEN_CODE_TOOL_CALL_STYLE', 'SANDBOX');
    vi.mocked(isGitRepository).mockReturnValue(false);
  });

  const codeModePrompt = (model = 'gpt-4') =>
    corePrompt({ model, codeMode: true });

  it('points the dedicated-tool guidance at tools.<jsName>', () => {
    expectText(
      codeModePrompt(),
      [
        'as `tools.<jsName>(args)`',
        "use the top-level 'tool_search' when available",
        'Read its returned schema and JavaScript name',
        'To read files use `tools.read_file`',
      ],
      ["To read files use 'read_file'"],
    );
  });

  it.each([
    [
      'shell reservation',
      '  - Reserve `tools.run_shell_command` for system commands and terminal operations that require shell execution.',
    ],
    [
      'subagent delegation',
      "- **Subagent Delegation:** Use the 'agent' tool with specialized agents when the task at hand matches the agent's description. Do not duplicate work a subagent is already doing — if you delegate research to a subagent, do not perform the same searches yourself. A background subagent's result arrives as a task notification in a later turn; while waiting, do not read its transcript, predict its findings, or launch a replacement for the same task.",
    ],
    [
      'directed search',
      "- **Codebase Search:** For simple, directed codebase searches (e.g. for a specific file/class/function) call `tools.grep_search` or `tools.glob` yourself. For broader codebase exploration and deep research, use the 'agent' tool with subagent_type=Explore — it is slower, so only when a directed search proves insufficient or the task clearly requires more than 3 queries.",
    ],
  ])('keeps the condensed %s rule', (_name, rule) => {
    expect(codeModePrompt().split('\n')).toContain(rule);
  });

  it('does not advertise todo_write when it is disabled', () => {
    expect(codeModePrompt()).not.toContain('todo_write');
  });

  it('advertises todo_write when it is enabled', () => {
    expectText(corePrompt({ model: 'gpt-4', todo: true, codeMode: true }), [
      'todo_write',
      '# Task Management',
    ]);
  });

  it('replaces multi-tool parallelism with batching inside one exec program', () => {
    expectText(
      codeModePrompt(),
      [
        '**Batch Into One Program:**',
        'await Promise.allSettled([...])',
        'Inspect every result',
        'String(result.reason)',
        'Keep dependent actions, mutations, and approvals sequential',
      ],
      [
        'await Promise.all([',
        'Call independent tools in parallel; run dependent calls sequentially',
      ],
    );
  });

  it('says the direct controls are not reachable through tools', () => {
    expect(codeModePrompt()).toContain(
      'is called directly and is not reachable through `tools`',
    );
  });

  it('uses the same exec examples for every model family', () => {
    const execExample =
      "[tool_call: exec with source: await tools.run_shell_command({ command: 'node server.js', is_background: true });]";

    expect(codeModePrompt()).toContain(execExample);
    expect(codeModePrompt('qwen3-coder-14b')).toContain(execExample);
    expect(codeModePrompt('qwen3-coder-14b')).not.toContain(
      '<function=run_shell_command>',
    );
    expect(codeModePrompt('qwen-vl-plus')).not.toContain(
      '{"name": "run_shell_command"',
    );
  });

  it('keeps direct calls and parallelism in Direct mode', () => {
    expectText(
      getCoreSystemPrompt(undefined, 'gpt-4'),
      [
        "To read files use 'read_file'",
        'Call independent tools in parallel; run dependent calls sequentially',
        '[tool_call: run_shell_command for',
      ],
      ['tools.<jsName>(args)', '**Batch Into One Program:**'],
    );
  });
});

describe('getCustomSystemPrompt', () => {
  const REVIEWER = 'You are a helpful assistant specialized in code review.';

  it('should handle string custom instruction without user memory', () => {
    const result = getCustomSystemPrompt(REVIEWER);
    expect(result).toBe(REVIEWER);
    expect(result).not.toContain('---');
  });

  it('should handle string custom instruction with user memory', () => {
    const userMemory =
      'Remember to be extra thorough.\nFocus on security issues.';
    const result = getCustomSystemPrompt(REVIEWER, userMemory);

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
    expectText(getPlanModeSystemReminder(), [
      'Iterative Planning Workflow',
      '### The Loop',
      'exit_plan_mode tool',
    ]);
  });

  it('should include guidance when a tool is blocked by plan mode', () => {
    const result = getPlanModeSystemReminder();

    expectText(result, [
      'When a Tool is Blocked by Plan Mode',
      'Do NOT retry',
      'wrappers, quoting tricks, aliases, or obfuscation',
      'Pivot to read-only',
    ]);
    // list_directory is opt-in (off by default) — the reminder must not steer
    // the model toward a tool that is not registered.
    expect(result).not.toContain('list_directory');
    expectText(result, ['does not approve the plan', 'exit Plan mode']);
  });

  it('should be deterministic', () => {
    expect(getPlanModeSystemReminder()).toBe(getPlanModeSystemReminder());
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

  const resolved = (
    isSwitch: boolean,
    value: string | null,
    isDisabled = false,
  ) => ({ isSwitch, value, isDisabled });

  describe('when envVar is undefined, empty, or whitespace', () => {
    it.each([
      ['should return null for undefined', undefined],
      ['should return null for empty string', ''],
      ['should return null for whitespace only', '   \n\t  '],
    ])('%s', (_title, input) => {
      expect(resolvePathFromEnv(input)).toEqual(resolved(false, null));
    });
  });

  describe('when envVar is a boolean-like string', () => {
    it.each([
      ['should handle "0" as disabled switch', '0', true],
      ['should handle "false" as disabled switch', 'false', true],
      ['should handle "1" as enabled switch', '1', false],
      ['should handle "true" as enabled switch', 'true', false],
    ] as const)('%s', (_title, input, disabled) => {
      expect(resolvePathFromEnv(input)).toEqual(
        resolved(true, input, disabled),
      );
    });

    it('should be case-insensitive for boolean values', () => {
      expect(resolvePathFromEnv('FALSE')).toEqual(
        resolved(true, 'false', true),
      );
      expect(resolvePathFromEnv('TRUE')).toEqual(resolved(true, 'true'));
    });
  });

  describe('when envVar is a file path', () => {
    it('should resolve absolute paths', () => {
      expect(resolvePathFromEnv('/absolute/path/file.txt')).toEqual(
        resolved(false, path.resolve('/absolute/path/file.txt')),
      );
    });

    it('should resolve relative paths', () => {
      expect(resolvePathFromEnv('relative/path/file.txt')).toEqual(
        resolved(false, path.resolve('relative/path/file.txt')),
      );
    });

    it('should expand tilde to home directory', () => {
      vi.spyOn(os, 'homedir').mockReturnValue(HOME);
      expect(resolvePathFromEnv('~/documents/file.txt')).toEqual(
        resolved(false, path.resolve(path.join(HOME, 'documents/file.txt'))),
      );
    });

    it('should handle standalone tilde', () => {
      vi.spyOn(os, 'homedir').mockReturnValue(HOME);
      expect(resolvePathFromEnv('~')).toEqual(
        resolved(false, path.resolve(HOME)),
      );
    });

    it('should handle os.homedir() errors gracefully', () => {
      vi.spyOn(os, 'homedir').mockImplementation(() => {
        throw new Error('Cannot resolve home directory');
      });
      expect(resolvePathFromEnv('~/documents/file.txt')).toEqual(
        resolved(false, null),
      );
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
    expectText(
      getCoreSystemPrompt(),
      [],
      [
        'Autonomously implement and deliver a visually appealing',
        'Websites (Frontend):',
        'npx create-react-app',
      ],
    );
  });

  it('system prompt references the new-app skill', () => {
    vi.mocked(isGitRepository).mockReturnValue(false);
    expectText(getCoreSystemPrompt(), ['new-app', '## New Applications']);
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
  const modeOf = (opts: {
    zed?: boolean;
    inputFormat?: string;
    interactive?: boolean;
  }) =>
    resolveInteractionMode({
      getExperimentalZedIntegration: () => opts.zed ?? false,
      getInputFormat: () => opts.inputFormat ?? InputFormat.TEXT,
      isInteractive: () => opts.interactive ?? false,
    });
  const { TEXT, STREAM_JSON } = InputFormat;

  it("resolves the Zed integration to 'acp'", () => {
    expect(modeOf({ zed: true })).toBe('acp');
  });

  it("resolves a stream-json session to 'acp' so the model may still ask questions", () => {
    // Must match the runtime question/permission sites, which treat a
    // stream-json session as ACP-capable (the host relays the question).
    expect(modeOf({ inputFormat: STREAM_JSON })).toBe('acp');
  });

  it("resolves an interactive text session to 'interactive'", () => {
    expect(modeOf({ inputFormat: TEXT, interactive: true })).toBe(
      'interactive',
    );
  });

  it("resolves a non-interactive text session to 'headless'", () => {
    expect(modeOf({ inputFormat: TEXT, interactive: false })).toBe('headless');
  });

  it("prefers 'acp' over 'interactive' for a stream-json session (ACP precedence)", () => {
    expect(modeOf({ inputFormat: STREAM_JSON, interactive: true })).toBe('acp');
  });

  it('treats a missing getInputFormat as a text session', () => {
    // getInputFormat is optional on the structural type; its absence must not
    // throw and must not resolve to 'acp'.
    const withoutFormat = (interactive: boolean) =>
      resolveInteractionMode({
        getExperimentalZedIntegration: () => false,
        isInteractive: () => interactive,
      });
    expect(withoutFormat(true)).toBe('interactive');
    expect(withoutFormat(false)).toBe('headless');
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
