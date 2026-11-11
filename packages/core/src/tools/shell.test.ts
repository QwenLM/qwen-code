/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createToolFileStateCache } from '../utils/fileStateCache.js';

import { createIsolatedPermissionSession } from '../test-utils/config.js';
import {
  vi,
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
  type Mock,
} from 'vitest';

const mockPlatform = vi.hoisted(() => vi.fn(() => 'linux'));
const mockHomedir = vi.hoisted(() => vi.fn(() => '/home/user'));

const mockShellExecutionService = vi.hoisted(() => vi.fn());
const mockShellBackground = vi.hoisted(() => vi.fn());
const mockExecuteBashPtyCommand = vi.hoisted(() => vi.fn());

vi.mock('../services/shellExecutionService.js', () => ({
  ShellExecutionService: {
    execute: mockShellExecutionService,
    background: mockShellBackground,
    getOutputFilePath: vi.fn(() => undefined),
  },
}));

vi.mock('./bash-pty.js', () => ({
  executeBashPtyCommand: mockExecuteBashPtyCommand,
}));

vi.mock('node:os', async (importOriginal) => {
  const actualOs = await importOriginal<typeof os>();
  return {
    ...actualOs,
    default: {
      ...actualOs,
      platform: mockPlatform,
      homedir: mockHomedir,
    },
    platform: mockPlatform,
    homedir: mockHomedir,
  };
});
vi.mock('../utils/summarizer.js');

import { initializeShellParsers } from '../utils/shell-utils.js';
import { ShellTool } from './shell.js';
import { StreamingToolExecutor } from './streaming-tool-executor.js';
import { constrainAgentPermissions } from '../permissions/agent-tool-constraints.js';
import type { AgentLoopContext } from '../config/agent-loop-context.js';
import type { ToolUseContext } from './tool-types.js';
import type { Config } from '../config/config.js';
import { setTestSessionPermission } from '../test-utils/config.js';
import {
  type ShellExecutionResult,
  type ShellOutputEvent,
} from '../services/shellExecutionService.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isSubpath } from '../utils/paths.js';
import * as summarizer from '../utils/summarizer.js';
import { ToolErrorType } from './tool-error.js';
import { SHELL_TOOL_NAME } from './tool-names.js';
import { ENV_ENABLE_BASH_PTY_TOOLS } from './bash-pty-feature-gate.js';
import { buildConfirmationDetails } from './confirmation-details-builder.js';
import { WorkspaceContext } from '../utils/workspaceContext.js';
import {
  resetForTest,
  setCwd,
  getCwd,
  getOriginalCwd,
  runWithCwdOverride,
} from '../utils/Shell.js';
import { realpathSync } from 'node:fs';
import { SIMPLE_SYSTEM_PROMPT_ENV } from '../prompts/bundle-resolver.js';
import {
  completedToolCallToResult,
  convertToolResultToCompletedToolCall,
  LocalToolCallExecutor,
} from '../tool-executor/index.js';
import { CoreToolCallStatus } from '../tool-executor/types.js';

const originalComSpec = process.env['ComSpec'];
const originalBashPtyToolsEnv = process.env[ENV_ENABLE_BASH_PTY_TOOLS];
const itWindowsOnly = process.platform === 'win32' ? it : it.skip;

describe('ShellTool', () => {
  beforeAll(async () => {
    await initializeShellParsers();
  });

  let shellTool: ShellTool;
  let mockConfig: Config;
  let mockShellOutputCallback: (event: ShellOutputEvent) => void;
  let resolveExecutionPromise: (result: ShellExecutionResult) => void;
  let tempRootDir: string;

  const resolveShellExecution = (
    result: Partial<ShellExecutionResult> = {},
  ) => {
    const fullResult: ShellExecutionResult = {
      rawOutput: Buffer.from(result.output || ''),
      output: 'Success',
      exitCode: 0,
      signal: null,
      error: null,
      aborted: false,
      pid: 12345,
      executionMethod: 'child_process',
      ...result,
    };
    resolveExecutionPromise(fullResult);
  };

  beforeEach(() => {
    vi.clearAllMocks();

    tempRootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-test-'));
    fs.mkdirSync(path.join(tempRootDir, 'subdir'));
    // Set Shell module CWD to match tempRootDir so getCwd() === getTargetDir()
    resetForTest(tempRootDir);

    mockConfig = {
      fileReadState: createToolFileStateCache(),
      toolRegistry: { getTool: () => ({ name: 'Read' }) },
      get config() {
        return this;
      },
      getPermissionMode: vi.fn().mockReturnValue('strict'),
      getCoreTools: vi.fn().mockReturnValue([]),
      getExcludeTools: vi.fn().mockReturnValue(new Set([])),
      getDebugMode: vi.fn().mockReturnValue(false),
      isInteractive: vi.fn().mockReturnValue(true),
      getAcpMode: vi.fn().mockReturnValue(false),
      isParallelReadOnlyShellEnabled: vi.fn().mockReturnValue(true),
      isParallelToolStreamingEnabled: vi.fn().mockReturnValue(true),
      getTargetDir: vi.fn().mockReturnValue(tempRootDir),
      getSummarizeToolOutputConfig: vi.fn().mockReturnValue(undefined),
      getWorkspaceContext: vi
        .fn()
        .mockReturnValue(new WorkspaceContext(tempRootDir)),
      storage: {
        getProjectTempDir: vi.fn().mockReturnValue('/tmp/project'),
      },
      isPathAllowed(this: Config, absolutePath: string): boolean {
        const workspaceContext = this.getWorkspaceContext();
        if (workspaceContext.isPathWithinWorkspace(absolutePath)) {
          return true;
        }

        const projectTempDir = this.storage.getProjectTempDir();
        return isSubpath(path.resolve(projectTempDir), absolutePath);
      },
      validatePathAccess(this: Config, absolutePath: string): string | null {
        if (this.isPathAllowed(absolutePath)) {
          return null;
        }

        const workspaceDirs = this.getWorkspaceContext().getDirectories();
        const projectTempDir = this.storage.getProjectTempDir();
        return `Path not in workspace: Attempted path "${absolutePath}" resolves outside the allowed workspace directories: ${workspaceDirs.join(', ')} or the project temp directory: ${projectTempDir}`;
      },
      getShellToolInactivityTimeout: vi.fn().mockReturnValue(1000),
      sanitizationConfig: {},
    } as unknown as Config;

    shellTool = new ShellTool(mockConfig);

    mockPlatform.mockReturnValue('linux');
    mockHomedir.mockReturnValue('/home/user');
    process.env['ComSpec'] =
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

    // Capture the output callback to simulate streaming events from the service.
    // The execution result promise is created eagerly (below) so that tests can
    // call resolveExecutionPromise() regardless of whether the service mock has
    // been invoked yet — the tool now awaits parser init before calling execute.
    const executionResultPromise = new Promise<ShellExecutionResult>(
      (resolve) => {
        resolveExecutionPromise = resolve;
      },
    );
    mockShellExecutionService.mockImplementation((_cmd, _cwd, callback) => {
      mockShellOutputCallback = callback;
      return {
        pid: 12345,
        result: executionResultPromise,
      };
    });

    mockShellBackground.mockImplementation(() => {
      resolveExecutionPromise({
        output: '',
        rawOutput: Buffer.from(''),
        exitCode: null,
        signal: null,
        error: null,
        aborted: false,
        pid: 12345,
        executionMethod: 'child_process',
        backgrounded: true,
        backgroundReason: 'model',
      });
    });
    mockExecuteBashPtyCommand.mockResolvedValue({
      llmContent: 'Bash PTY started',
      returnDisplay: 'Bash PTY started',
      toolUseResult: {
        kind: 'bash_pty',
        pty: true,
        pid: 12345,
        stdout: 'Bash PTY started',
      },
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    if (fs.existsSync(tempRootDir)) {
      fs.rmSync(tempRootDir, { recursive: true, force: true });
    }
    if (originalComSpec === undefined) {
      delete process.env['ComSpec'];
    } else {
      process.env['ComSpec'] = originalComSpec;
    }
    if (originalBashPtyToolsEnv === undefined) {
      delete process.env[ENV_ENABLE_BASH_PTY_TOOLS];
    } else {
      process.env[ENV_ENABLE_BASH_PTY_TOOLS] = originalBashPtyToolsEnv;
    }
  });

  describe('file read state integration', () => {
    beforeEach(() => {
      mockConfig.fileReadState.clear();
      setTestSessionPermission(
        mockConfig,
        createIsolatedPermissionSession({
          permissionMode: 'default',
          additionalDirectories: [],
          cwd: tempRootDir,
          rules: { allow: {}, deny: {}, ask: {} },
          toolCheckerMap: new Map(),
        }) as unknown as typeof mockConfig.permission,
      );
    });

    afterEach(() => mockConfig.fileReadState.clear());

    it('keeps delivered CodeMode file reads visible when model summarization is configured', async () => {
      const file = path.join(tempRootDir, 'sample.txt');
      fs.writeFileSync(file, 'hello\n');
      vi.mocked(mockConfig.getSummarizeToolOutputConfig).mockReturnValue({
        Bash: { tokenBudget: 100 },
      });
      resolveShellExecution({ output: 'hello\n' });
      await shellTool.build({ command: 'cat sample.txt' }).executeWithContext!({
        signal: new AbortController().signal,
        resultConsumption: 'programmatic',
      });
      expect(mockConfig.fileReadState.get(file)?.contentNotInModelContext).toBe(
        false,
      );
      expect(summarizer.summarizeToolOutput).not.toHaveBeenCalled();
    });

    it.each(['cat sample.txt', 'cat -n sample.txt'])(
      'registers the visible result of %s',
      async (command) => {
        const file = path.join(tempRootDir, 'sample.txt');
        fs.writeFileSync(file, 'hello\n');
        resolveShellExecution({
          output:
            command === 'cat -n sample.txt' ? '     1\thello\n' : 'hello\n',
        });
        await shellTool
          .build({ command })
          .execute(new AbortController().signal);
        expect(mockConfig.fileReadState.get(file)).toMatchObject({
          content: 'hello\n',
          offset: undefined,
          limit: undefined,
        });
      },
    );

    it.each(['cat sample.txt', 'cat -n sample.txt'])(
      'marks summarized %s content as outside the model context',
      async (command) => {
        const file = path.join(tempRootDir, 'sample.txt');
        fs.writeFileSync(file, 'hello\n');
        (mockConfig.getSummarizeToolOutputConfig as Mock).mockReturnValue({
          [SHELL_TOOL_NAME]: { tokenBudget: 1000 },
        });
        vi.mocked(summarizer.summarizeToolOutput).mockResolvedValue('summary');
        resolveShellExecution({
          output:
            command === 'cat -n sample.txt' ? '     1\thello\n' : 'hello\n',
        });
        await shellTool
          .build({ command })
          .execute(new AbortController().signal);
        expect(mockConfig.fileReadState.get(file)).toMatchObject({
          content: 'hello\n',
          contentNotInModelContext: true,
        });
      },
    );

    it.each(['cat sample.txt', 'cat -n sample.txt'])(
      'records %s without overriding an explicit Read deny',
      async (command) => {
        const file = path.join(tempRootDir, 'sample.txt');
        fs.writeFileSync(file, 'hello\n');
        mockConfig.permission!.setRules({
          allow: {},
          deny: { session: ['Read'] },
          ask: {},
        });
        resolveShellExecution({
          output:
            command === 'cat -n sample.txt' ? '     1\thello\n' : 'hello\n',
        });
        const signal = new AbortController().signal;
        await shellTool.build({ command }).execute(signal);
        expect(mockConfig.fileReadState.get(file)).toMatchObject({
          content: 'hello\n',
        });
        const { fileReadPermission } = await import(
          '../permissions/file-read.js'
        );
        expect(
          (
            await fileReadPermission(
              {
                config: mockConfig,
                signal,
                fileReadState: mockConfig.fileReadState,
              },
              file,
            )
          ).denied,
        ).toBe(true);
      },
    );

    it('does not register output from a failed command', async () => {
      const file = path.join(tempRootDir, 'sample.txt');
      fs.writeFileSync(file, 'hello\n');
      resolveShellExecution({ output: 'hello\n', exitCode: 1 });
      await shellTool
        .build({ command: 'cat sample.txt' })
        .execute(new AbortController().signal);
      expect(mockConfig.fileReadState.has(file)).toBe(false);
    });

    it('does not mark user-shell output as model-visible', async () => {
      const file = path.join(tempRootDir, 'sample.txt');
      fs.writeFileSync(file, 'hello\n');
      resolveShellExecution({ output: 'hello\n' });
      await shellTool.build({ command: 'cat sample.txt' }).executeWithContext!({
        signal: new AbortController().signal,
        invocationOrigin: 'user-shell',
      });
      expect(mockConfig.fileReadState.has(file)).toBe(false);
    });

    it('preserves a stale-file notice after shell output summarization', async () => {
      const file = path.join(tempRootDir, 'sample.txt');
      fs.writeFileSync(file, 'hello\n');
      const timestamp = Math.floor(fs.statSync(file).mtimeMs);
      mockConfig.fileReadState.set(file, {
        content: 'hello\n',
        timestamp,
        offset: undefined,
        limit: undefined,
      });
      const execute = mockShellExecutionService.getMockImplementation()!;
      mockShellExecutionService.mockImplementationOnce((...args: unknown[]) => {
        fs.writeFileSync(file, 'changed\n');
        fs.utimesSync(file, new Date(), new Date(timestamp + 2000));
        const running = execute(...args);
        resolveShellExecution({ output: 'done' });
        return running;
      });
      (mockConfig.getSummarizeToolOutputConfig as Mock).mockReturnValue({
        [SHELL_TOOL_NAME]: { tokenBudget: 1000 },
      });
      vi.mocked(summarizer.summarizeToolOutput).mockResolvedValue('summary');
      const result = await shellTool
        .build({ command: 'python3 rewrite.py --write' })
        .execute(new AbortController().signal);
      expect(result.llmContent).toContain('summary');
      expect(result.llmContent).toContain(
        'Read the relevant content before editing',
      );
      expect(result.toolUseResult).toHaveProperty(
        'staleReadFileStateHint',
        expect.stringContaining(file),
      );
      expect(mockConfig.fileReadState.get(file)?.content).toBe('hello\n');
    });

    it.each([false, true])(
      'only snapshots foreground writes (run_in_background=%s)',
      async (runInBackground) => {
        const entries = vi.spyOn(mockConfig.fileReadState, 'entries');
        resolveShellExecution();
        await shellTool
          .build({
            command: 'touch sample.txt',
            run_in_background: runInBackground,
          })
          .execute(new AbortController().signal);
        expect(entries).toHaveBeenCalledTimes(runInBackground ? 0 : 1);
      },
    );

    it('keeps the bound agent restrictions when no tool-use context is supplied', async () => {
      const file = path.join(tempRootDir, 'restricted.txt');
      fs.writeFileSync(file, 'before');
      const timestamp = Math.floor(fs.statSync(file).mtimeMs);
      mockConfig.fileReadState.set(file, {
        content: 'before',
        timestamp,
        offset: undefined,
        limit: undefined,
      });
      const execute = mockShellExecutionService.getMockImplementation()!;
      mockShellExecutionService.mockImplementationOnce((...args: unknown[]) => {
        fs.writeFileSync(file, 'after');
        fs.utimesSync(file, new Date(), new Date(timestamp + 2000));
        const running = execute(...args);
        resolveShellExecution();
        return running;
      });
      const restricted = new ShellTool({
        config: mockConfig,
        fileReadState: mockConfig.fileReadState,
        toolRegistry: mockConfig.toolRegistry,
        permission: constrainAgentPermissions(mockConfig.permission!, ['Read']),
      } as unknown as AgentLoopContext);
      const result = await restricted
        .build({ command: 'touch restricted.txt' })
        .execute(new AbortController().signal);
      expect(result.toolUseResult).not.toHaveProperty('staleReadFileStateHint');
      expect(mockConfig.fileReadState.get(file)?.content).toBe('before');
    });

    it.each([
      { interactive: false, acp: false, origin: 'model' as const },
      { interactive: true, acp: true, origin: 'model' as const },
      { interactive: true, acp: false, origin: 'user-shell' as const },
    ])(
      'keeps changed-file hints out of non-TUI calls: %j',
      async ({ interactive, acp, origin }) => {
        vi.mocked(mockConfig.isInteractive).mockReturnValue(interactive);
        vi.mocked(mockConfig.getAcpMode).mockReturnValue(acp);
        const file = path.join(tempRootDir, 'sample.txt');
        fs.writeFileSync(file, 'before');
        const timestamp = Math.floor(fs.statSync(file).mtimeMs);
        mockConfig.fileReadState.set(file, {
          content: 'before',
          timestamp,
          offset: undefined,
          limit: undefined,
        });
        const execute = mockShellExecutionService.getMockImplementation()!;
        mockShellExecutionService.mockImplementationOnce(
          (...args: unknown[]) => {
            fs.writeFileSync(file, 'after');
            fs.utimesSync(file, new Date(), new Date(timestamp + 2000));
            const running = execute(...args);
            resolveShellExecution();
            return running;
          },
        );
        const result = await shellTool.build({ command: 'touch sample.txt' })
          .executeWithContext!({
          signal: new AbortController().signal,
          invocationOrigin: origin,
        });
        expect(result.toolUseResult).not.toHaveProperty(
          'staleReadFileStateHint',
        );
        expect(result.llmContent).not.toContain('previously read file(s)');
        expect(mockConfig.fileReadState.get(file)?.content).toBe('before');
      },
    );
  });

  describe('build', () => {
    it('should return an invocation for a valid command', () => {
      const invocation = shellTool.build({ command: 'goodCommand --safe' });
      expect(invocation).toBeDefined();
    });

    it('should throw an error for an empty command', () => {
      expect(() => shellTool.build({ command: ' ' })).toThrow(
        'Command cannot be empty.',
      );
    });

    it('should return an invocation for a valid relative directory path', () => {
      const invocation = shellTool.build({
        command: 'ls',
        dir_path: 'subdir',
      });
      expect(invocation).toBeDefined();
    });

    it('should not throw for a directory outside the workspace at build time', () => {
      const outsidePath = path.resolve(tempRootDir, '../outside');
      const invocation = shellTool.build({
        command: 'ls',
        dir_path: outsidePath,
      });
      expect(invocation).toBeDefined();
    });

    it('should return an invocation for a valid absolute directory path', () => {
      const invocation = shellTool.build({
        command: 'ls',
        dir_path: path.join(tempRootDir, 'subdir'),
      });
      expect(invocation).toBeDefined();
    });
  });

  describe('isConcurrencySafe', () => {
    it.each([
      { interactive: true, acp: false },
      { interactive: false, acp: false },
      { interactive: true, acp: true },
    ])(
      'overlaps reads, preserves result order, and fences writes: %j',
      async ({ interactive, acp }) => {
        vi.mocked(mockConfig.isInteractive).mockReturnValue(interactive);
        vi.mocked(mockConfig.getAcpMode).mockReturnValue(acp);
        vi.mocked(mockConfig.isParallelToolStreamingEnabled).mockReturnValue(
          false,
        );
        const started: string[] = [];
        const finished: string[] = [];
        const yielded: string[] = [];
        const release = new Map<string, () => void>();
        const pending = new Map(
          ['read-1', 'read-2', 'write', 'read-3'].map((id) => [
            id,
            new Promise<void>((resolve) => release.set(id, resolve)),
          ]),
        );
        const executor = new StreamingToolExecutor({
          parentSignal: new AbortController().signal,
          preserveSubmissionOrder: true,
          resolveTool: () => shellTool,
          executeTool: async (_invocation, request) => {
            started.push(request.callId);
            await pending.get(request.callId);
            finished.push(request.callId);
            return { llmContent: 'done', returnDisplay: 'done' };
          },
        });
        for (const [id, command] of [
          ['read-1', 'pwd'],
          ['read-2', 'ls'],
          ['write', 'echo changed > result.txt'],
          ['read-3', 'pwd'],
        ]) {
          executor.addTool({
            callId: id,
            name: SHELL_TOOL_NAME,
            args: { command },
            prompt_id: 'test',
          });
        }
        executor.seal();
        const consuming = (async () => {
          for await (const result of executor.getRemainingResults()) {
            expect(result.error).toBeUndefined();
            yielded.push(result.request.callId);
          }
        })();
        try {
          await vi.waitFor(() => expect(started).toEqual(['read-1', 'read-2']));
          release.get('read-2')!();
          await vi.waitFor(() => expect(finished).toEqual(['read-2']));
          expect(yielded).toEqual([]);
          expect(started).toEqual(['read-1', 'read-2']);
          release.get('read-1')!();
          await vi.waitFor(() =>
            expect(started).toEqual(['read-1', 'read-2', 'write']),
          );
          expect(yielded).toEqual(['read-1', 'read-2']);
          release.get('write')!();
          await vi.waitFor(() =>
            expect(started).toEqual(['read-1', 'read-2', 'write', 'read-3']),
          );
          release.get('read-3')!();
          await consuming;
          expect(yielded).toEqual(['read-1', 'read-2', 'write', 'read-3']);
        } finally {
          for (const resolve of release.values()) resolve();
          await consuming;
        }
      },
    );

    it.each([
      { interactive: false, acp: false, streaming: false, enabled: true },
      { interactive: false, acp: false, streaming: true, enabled: true },
      { interactive: true, acp: true, streaming: false, enabled: true },
      { interactive: true, acp: true, streaming: true, enabled: true },
      { interactive: true, acp: false, streaming: false, enabled: true },
      { interactive: true, acp: false, streaming: true, enabled: false },
      { interactive: false, acp: false, streaming: true, enabled: false },
    ])(
      'keeps execution-surface opt-in: %j',
      ({ interactive, acp, streaming, enabled }) => {
        vi.mocked(mockConfig.isInteractive).mockReturnValue(interactive);
        vi.mocked(mockConfig.getAcpMode).mockReturnValue(acp);
        vi.mocked(mockConfig.isParallelReadOnlyShellEnabled).mockReturnValue(
          enabled,
        );
        vi.mocked(mockConfig.isParallelToolStreamingEnabled).mockReturnValue(
          streaming,
        );
        expect(shellTool.isConcurrencySafe({ command: 'pwd' })).toBe(enabled);
        expect(
          shellTool.isConcurrencySafe({ command: 'pwd && touch changed.txt' }),
        ).toBe(false);
      },
    );

    it('uses the execution directory for Git context checks', () => {
      expect(shellTool.isConcurrencySafe({ command: 'git diff' })).toBe(true);
      fs.writeFileSync(
        path.join(tempRootDir, 'subdir', 'HEAD'),
        'ref: refs/heads/main\n',
      );
      expect(
        shellTool.isConcurrencySafe({
          command: 'git diff',
          dir_path: 'subdir',
        }),
      ).toBe(false);
      expect(shellTool.isConcurrencySafe({ command: 'git diff' })).toBe(true);
      expect(shellTool.isConcurrencySafe({ command: 'git diff' })).toBe(true);
      expect(
        shellTool.isConcurrencySafe({
          command: 'git diff',
          dir_path: 'subdir',
        }),
      ).toBe(false);
    });

    it('classifies only non-PTY read-only commands as safe', () => {
      expect(shellTool.isConcurrencySafe({ command: 'pwd' })).toBe(true);
      expect(shellTool.isConcurrencySafe({ command: 'sleep 0.1' })).toBe(true);
      expect(shellTool.isConcurrencySafe({ command: 'cd /tmp' })).toBe(false);
      expect(
        shellTool.isConcurrencySafe({ command: 'echo ok > output.txt' }),
      ).toBe(false);
      expect(
        shellTool.isConcurrencySafe({
          command: 'pwd',
          run_in_background: true,
        }),
      ).toBe(true);
      expect(shellTool.isConcurrencySafe({ command: 'pwd', pty: true })).toBe(
        false,
      );
    });

    it('classifies commands when parallel result streaming is disabled', () => {
      vi.mocked(mockConfig.isParallelToolStreamingEnabled).mockReturnValue(
        false,
      );
      expect(shellTool.isConcurrencySafe({ command: 'pwd' })).toBe(true);
      expect(shellTool.isConcurrencySafe({ command: 'ls' })).toBe(true);
      expect(shellTool.isConcurrencySafe({ command: 'git diff' })).toBe(true);
      expect(shellTool.isConcurrencySafe({ command: 'cd /tmp' })).toBe(false);
      expect(
        shellTool.isConcurrencySafe({ command: 'echo ok > output.txt' }),
      ).toBe(false);
      expect(shellTool.isConcurrencySafe({ command: 'pwd', pty: true })).toBe(
        false,
      );
    });
  });

  describe('Git execution compatibility', () => {
    it.each(['git diff', 'git show HEAD', 'git status --short'])(
      'passes %s through without Git-specific hardening',
      async (command) => {
        const execution = shellTool
          .build({ command })
          .execute(new AbortController().signal);
        await vi.waitFor(() =>
          expect(mockShellExecutionService).toHaveBeenCalled(),
        );
        expect(mockShellExecutionService.mock.calls[0][0]).toBe(command);
        expect(mockShellExecutionService.mock.calls[0][4]).not.toHaveProperty(
          'hardenReadOnlyGit',
        );
        resolveShellExecution();
        await execution;
      },
    );
  });

  describe('execute', () => {
    const mockAbortSignal = new AbortController().signal;

    it.each([{ pty: true }, { run_in_background: true }])(
      'rejects CodeMode persistent execution before spawning: %j',
      async (params) => {
        const result = await shellTool.build({ command: 'npm test', ...params })
          .executeWithContext!({
          signal: mockAbortSignal,
          resultConsumption: 'programmatic',
        });
        expect(result.error?.message).toContain('foreground commands only');
        expect(mockShellExecutionService).not.toHaveBeenCalled();
        expect(mockExecuteBashPtyCommand).not.toHaveBeenCalled();
      },
    );

    it('keeps CodeMode commands in the foreground and skips lossy summaries', async () => {
      vi.mocked(mockConfig.getSummarizeToolOutputConfig).mockReturnValue({
        Bash: { tokenBudget: 100 },
      });
      const controller = new AbortController();
      const promise = shellTool.build({ command: 'npm test' })
        .executeWithContext!({
        signal: controller.signal,
        resultConsumption: 'programmatic',
      });
      resolveShellExecution({ exitCode: 1, output: 'test failed' });
      const result = await promise;
      expect(mockShellExecutionService.mock.calls[0][3]).toBe(
        controller.signal,
      );
      expect(mockShellExecutionService.mock.calls[0][4]).toMatchObject({
        autoBackgroundOnTimeout: false,
      });
      expect(
        mockShellExecutionService.mock.calls[0][4].startInBackground,
      ).toBeUndefined();
      expect(summarizer.summarizeToolOutput).not.toHaveBeenCalled();
      expect(result.isError).toBe(true);
      expect(shellTool.programmatic.acceptsErrorResult?.(result)).toBe(true);
      expect(shellTool.programmatic.project(result)).toMatchObject({
        output: 'test failed',
        exitCode: 1,
        truncated: false,
      });
    });

    it.each([
      { aborted: false, signal: 15, exitCode: 143 },
      { aborted: true, signal: 15, exitCode: 143 },
      { aborted: false, signal: null, exitCode: 0 },
    ])(
      'reports a timeout as a model-visible failure: %j',
      async (processStatus) => {
        const args = { command: 'sleep 30', timeout: 100 };
        const invocation = shellTool.build(args);
        const promise = invocation.executeWithContext!({
          signal: mockAbortSignal,
          resultConsumption: 'programmatic',
        });
        resolveShellExecution({
          ...processStatus,
          timedOut: true,
          output: 'partial output',
        });
        const result = await promise;
        expect(result.isError).toBe(true);
        expect(result.error).toBeUndefined();
        expect(result.toolUseResult).toMatchObject({
          kind: 'cancelled',
          timedOut: true,
          timeoutMs: 100,
          isError: true,
        });
        expect(result.llmContent).toContain(
          'Command timed out after 100ms and was terminated.',
        );
        expect(result.llmContent).toContain('partial output');
        expect(result.returnDisplay).toContain('Command timed out after 100ms');
        expect(() => shellTool.programmatic.project(result)).toThrow(
          'timed out',
        );
        expect(shellTool.programmatic.acceptsErrorResult?.(result)).toBe(false);
        const completed = convertToolResultToCompletedToolCall(
          {
            request: {
              callId: 'timeout',
              name: SHELL_TOOL_NAME,
              args,
              prompt_id: 'test',
            },
            tool: shellTool,
            invocation,
            result,
            error: undefined,
            cancelled: false,
            durationMs: 100,
          },
          'root',
          undefined,
        );
        expect(completedToolCallToResult(completed)).toMatchObject({
          is_error: true,
          content: result.llmContent,
          toolUseResult: result.toolUseResult,
        });
      },
    );

    it('keeps user cancellation distinct from limit termination', async () => {
      const controller = new AbortController();
      const promise = shellTool
        .build({ command: 'sleep 30' })
        .execute(controller.signal);
      controller.abort();
      resolveShellExecution({ aborted: true, output: 'partial output' });
      const result = await promise;
      expect(result.isError).toBeUndefined();
      expect(result.toolUseResult).toMatchObject({
        kind: 'cancelled',
        timedOut: false,
      });
      expect(result.llmContent).toContain('cancelled by user');
      expect(result.llmContent).not.toContain('timed out');
    });

    it('starts the command without an in-tool tracking barrier', async () => {
      const invocation = shellTool.build({ command: 'git commit -m test' });
      const execution = invocation.executeWithContext!({
        signal: mockAbortSignal,
        sessionId: 'tracking-session',
        config: mockConfig,
      });

      await vi.waitFor(() =>
        expect(mockShellExecutionService).toHaveBeenCalled(),
      );
      resolveShellExecution();
      await execution;
    });

    it('routes pty=true executions to the Bash PTY path', async () => {
      process.env[ENV_ENABLE_BASH_PTY_TOOLS] = '1';
      const invocation = shellTool.build({
        command: 'qwen',
        pty: true,
        cols: 120,
        rows: 30,
        wait_ms: 5000,
        idle_ms: 500,
      });

      const result = await invocation.execute(mockAbortSignal);

      expect(mockExecuteBashPtyCommand).toHaveBeenCalledWith(
        expect.objectContaining({ config: mockConfig }),
        {
          command: 'qwen',
          cols: 120,
          rows: 30,
          wait_ms: 5000,
          idle_ms: 500,
          dir_path: undefined,
        },
        mockAbortSignal,
        expect.objectContaining({
          shellExecutionConfig: expect.any(Object),
        }),
        undefined,
      );
      expect(mockShellExecutionService).not.toHaveBeenCalled();
      expect(result.toolUseResult).toMatchObject({
        kind: 'bash_pty',
        pty: true,
      });
    });

    it('passes workflow ownership into the Bash PTY path', async () => {
      process.env[ENV_ENABLE_BASH_PTY_TOOLS] = '1';
      const invocation = shellTool.build({
        command: 'qwen',
        pty: true,
      });

      await invocation.executeWithContext!({
        signal: mockAbortSignal,
        internalExecutionOwner: {
          kind: 'workflow-agent',
          suppressMainSessionNotification: true,
          disableShellAutoBackground: true,
        },
      });

      expect(mockExecuteBashPtyCommand).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ command: 'qwen' }),
        mockAbortSignal,
        expect.objectContaining({
          shellExecutionConfig: expect.any(Object),
        }),
        expect.objectContaining({
          kind: 'workflow-agent',
          suppressMainSessionNotification: true,
        }),
      );
    });

    it('rejects pty=true executions when Bash PTY tools are disabled', async () => {
      delete process.env[ENV_ENABLE_BASH_PTY_TOOLS];
      const invocation = shellTool.build({
        command: 'qwen',
        pty: true,
      });

      const result = await invocation.execute(mockAbortSignal);

      expect(mockExecuteBashPtyCommand).not.toHaveBeenCalled();
      expect(result.llmContent).toContain(`${ENV_ENABLE_BASH_PTY_TOOLS}=1`);
      expect(result.error?.type).toBe(ToolErrorType.EXECUTION_FAILED);
    });

    it('should pass command directly without wrapping', async () => {
      const invocation = shellTool.build({ command: 'my-command &' });
      const promise = invocation.execute(mockAbortSignal);
      resolveShellExecution({ pid: 54321 });

      const result = await promise;

      expect(mockShellExecutionService).toHaveBeenCalledWith(
        'my-command &',
        tempRootDir,
        expect.any(Function),
        expect.any(AbortSignal),
        expect.objectContaining({
          pager: 'cat',
          sanitizationConfig: {},
        }),
      );
      expect(result.llmContent).not.toContain('Background PIDs');
    });

    it('should use the provided absolute directory as cwd', async () => {
      const subdir = path.join(tempRootDir, 'subdir');
      const invocation = shellTool.build({
        command: 'ls',
        dir_path: subdir,
      });
      const promise = invocation.execute(mockAbortSignal);
      resolveShellExecution();
      await promise;

      expect(mockShellExecutionService).toHaveBeenCalledWith(
        'ls',
        subdir,
        expect.any(Function),
        expect.any(AbortSignal),
        expect.objectContaining({
          pager: 'cat',
          sanitizationConfig: {},
        }),
      );
    });

    it('should use the provided relative directory as cwd', async () => {
      const invocation = shellTool.build({
        command: 'ls',
        dir_path: 'subdir',
      });
      const promise = invocation.execute(mockAbortSignal);
      resolveShellExecution();
      await promise;

      expect(mockShellExecutionService).toHaveBeenCalledWith(
        'ls',
        path.join(tempRootDir, 'subdir'),
        expect.any(Function),
        expect.any(AbortSignal),
        expect.objectContaining({
          pager: 'cat',
          sanitizationConfig: {},
        }),
      );
    });

    it('fails an invalid dir_path without invoking the shell service', async () => {
      const missing = path.join(tempRootDir, 'missing');
      const invocation = shellTool.build({
        command: 'pwd',
        dir_path: missing,
      });

      const result = await invocation.execute(mockAbortSignal);

      expect(mockShellExecutionService).not.toHaveBeenCalled();
      expect(result.error?.type).toBe(ToolErrorType.EXECUTION_FAILED);
      expect(result.llmContent).toContain(missing);
    });

    it('fails closed when an isolated agent loses its working directory', async () => {
      const missing = path.join(tempRootDir, 'missing-agent-cwd');
      setCwd(missing);
      const invocation = shellTool.build({ command: 'pwd' });

      const result = await invocation.executeWithContext!({
        signal: mockAbortSignal,
        options: {
          shellExecutionConfig: {
            preventCwdChanges: true,
            pager: 'cat',
            sanitizationConfig: {},
          },
        },
      } as ToolUseContext);

      expect(mockShellExecutionService).not.toHaveBeenCalled();
      expect(result.error?.type).toBe(ToolErrorType.EXECUTION_FAILED);
      expect(result.llmContent).toContain(missing);
    });

    it('recovers only to the owning session root and reports the new directory', async () => {
      const sessionRoot = path.join(tempRootDir, 'subdir');
      await runWithCwdOverride(sessionRoot, async () => {
        const missing = path.join(sessionRoot, 'deleted');
        setCwd(missing);
        const execution = shellTool
          .build({ command: 'pwd' })
          .execute(mockAbortSignal);
        await vi.waitFor(() =>
          expect(mockShellExecutionService).toHaveBeenCalled(),
        );
        expect(mockShellExecutionService.mock.calls[0][1]).toBe(sessionRoot);
        resolveShellExecution();
        const result = await execution;
        expect(result.llmContent).toContain(
          `Shell cwd was recovered from ${missing} to ${sessionRoot}`,
        );
        expect(result.returnDisplay).toContain(sessionRoot);
        expect(getCwd()).toBe(realpathSync(sessionRoot));
      });
      expect(getCwd()).toBe(tempRootDir);
    });

    it('does not recover to project root or Home when the session root is gone', async () => {
      const missing = path.join(tempRootDir, 'deleted-session');
      await runWithCwdOverride(missing, async () => {
        const result = await shellTool
          .build({ command: 'pwd' })
          .execute(mockAbortSignal);
        expect(result.error?.type).toBe(ToolErrorType.EXECUTION_FAILED);
        expect(mockShellExecutionService).not.toHaveBeenCalled();
        expect(getCwd()).toBe(missing);
      });
    });

    it('recovers a missing main-session CWD to the project root', async () => {
      setCwd(path.join(tempRootDir, 'missing-main-cwd'));
      const invocation = shellTool.build({ command: 'pwd' });
      const execution = invocation.execute(mockAbortSignal);

      await vi.waitFor(() =>
        expect(mockShellExecutionService).toHaveBeenCalled(),
      );
      expect(mockShellExecutionService.mock.calls[0][1]).toBe(tempRootDir);
      expect(getCwd()).toBe(realpathSync(tempRootDir));

      resolveShellExecution();
      await execution;
    });

    it('should enable timeout auto-background for eligible foreground commands', async () => {
      const invocation = shellTool.build({ command: 'npm test' });
      const promise = invocation.execute(mockAbortSignal);
      resolveShellExecution();
      await promise;

      expect(mockShellExecutionService.mock.calls[0][4]).toEqual(
        expect.objectContaining({
          autoBackgroundOnTimeout: true,
        }),
      );
    });

    it('should not enable timeout auto-background for sleep commands', async () => {
      const invocation = shellTool.build({ command: 'sleep 10' });
      const promise = invocation.execute(mockAbortSignal);
      resolveShellExecution();
      await promise;

      expect(mockShellExecutionService.mock.calls[0][4]).toEqual(
        expect.objectContaining({
          autoBackgroundOnTimeout: false,
        }),
      );
    });

    it('should not enable timeout auto-background for explicit background commands', async () => {
      const invocation = shellTool.build({
        command: 'npm test',
        run_in_background: true,
      });
      await invocation.execute(mockAbortSignal);

      expect(mockShellExecutionService.mock.calls[0][4]).toEqual(
        expect.objectContaining({
          autoBackgroundOnTimeout: false,
          preventCwdChanges: true,
          startInBackground: { reason: 'model' },
        }),
      );
    });

    it('keeps dir_path execution local to the invocation', async () => {
      const invocation = shellTool.build({
        command: 'pwd',
        dir_path: 'subdir',
      });
      const execution = invocation.execute(mockAbortSignal);

      await vi.waitFor(() =>
        expect(mockShellExecutionService).toHaveBeenCalled(),
      );
      expect(mockShellExecutionService.mock.calls[0][4]).toEqual(
        expect.objectContaining({ preventCwdChanges: true }),
      );

      resolveShellExecution();
      await execution;
    });

    it('should keep workflow-owned commands foreground and silent', async () => {
      vi.useFakeTimers();
      const invocation = shellTool.build({
        command: 'npm test',
        run_in_background: true,
      });
      const promise = invocation.executeWithContext!({
        signal: mockAbortSignal,
        internalExecutionOwner: {
          kind: 'workflow-agent',
          suppressMainSessionNotification: true,
          disableShellAutoBackground: true,
        },
      });

      await vi.advanceTimersByTimeAsync(250);
      expect(mockShellBackground).not.toHaveBeenCalled();
      expect(mockShellExecutionService.mock.calls[0][4]).toEqual(
        expect.objectContaining({
          autoBackgroundOnTimeout: false,
          completionBehavior: 'silent',
        }),
      );

      resolveShellExecution();
      await promise;
    });

    it('should request immediate background registration for run_in_background', async () => {
      const invocation = shellTool.build({
        command: 'sleep 10',
        run_in_background: true,
      });
      const result = await invocation.execute(mockAbortSignal);

      expect(mockShellExecutionService.mock.calls[0][4]).toEqual(
        expect.objectContaining({
          startInBackground: { reason: 'model' },
        }),
      );
      expect(result.toolUseResult).toEqual(
        expect.objectContaining({
          kind: 'backgrounded',
          taskId: expect.stringMatching(/^b[a-z0-9]{8}$/),
          command: 'sleep 10',
          stdout: expect.stringMatching(
            /^Background process started with ID b[a-z0-9]{8}\.$/,
          ),
          initialOutput: '',
          pid: 12345,
          backgroundReason: 'model',
        }),
      );
    });

    it('passes the turn customContext into the background execution config', async () => {
      const customContext = Object.freeze({ tenant: 'alpha' });
      const invocation = shellTool.build({
        command: 'sleep 10',
        run_in_background: true,
      });
      await invocation.executeWithContext!({
        signal: mockAbortSignal,
        sessionId: 'context-session',
        config: mockConfig,
        customContext,
      });

      expect(mockShellExecutionService.mock.calls[0][4]).toEqual(
        expect.objectContaining({ customContext }),
      );
    });

    it('should tell the model when a command was manually backgrounded by the user', async () => {
      const invocation = shellTool.build({ command: 'sleep 10' });
      const promise = invocation.execute(mockAbortSignal);

      resolveShellExecution({
        output: 'running...',
        backgrounded: true,
        backgroundReason: 'user',
      });

      const result = await promise;

      expect(result.llmContent).toContain(
        'Command was manually moved to background by the user (ID:',
      );
      expect(result.llmContent).not.toContain('PID: 12345');
      expect(result.llmContent).toContain('Use /tasks to view.');
      expect(result.llmContent).not.toContain('timeout');
      expect(result.toolUseResult).toMatchObject({
        pid: 12345,
        command: 'sleep 10',
        initialOutput: 'running...',
        backgroundReason: 'user',
      });
    });

    it.each([false, true])(
      'reports output-cap termination as failure (aborted=%s)',
      async (aborted) => {
        const invocation = shellTool.build({ command: 'noisy-command' });
        const promise = invocation.execute(mockAbortSignal);

        resolveShellExecution({
          output: 'partial output',
          exitCode: 143,
          signal: 15,
          aborted,
          outputLimitExceeded: true,
        });

        const result = await promise;

        expect(result.llmContent).toContain(
          'Command killed: output file exceeded 5GB.',
        );
        expect(result.llmContent).not.toContain('cancelled by user');
        expect(result.isError).toBe(true);
        expect(result.toolUseResult).toMatchObject({
          kind: 'cancelled',
          outputLimitExceeded: true,
          timedOut: false,
          isError: true,
        });
      },
    );

    it('uses the execution handle PID when a background result omits it', async () => {
      const invocation = shellTool.build({ command: 'sleep 10' });
      const promise = invocation.execute(mockAbortSignal);

      resolveShellExecution({
        output: 'running...',
        backgrounded: true,
        backgroundReason: 'user',
        pid: undefined,
      });

      const result = await promise;

      expect(result.toolUseResult).toMatchObject({
        kind: 'backgrounded',
        pid: 12345,
        command: 'sleep 10',
        initialOutput: 'running...',
        backgroundReason: 'user',
      });
    });

    it('should include progress metadata when a streamed command is moved to background', async () => {
      const invocation = shellTool.build({
        command: 'while true; do echo test; sleep 1; done',
      });
      const promise = invocation.execute(mockAbortSignal);

      await vi.waitFor(() =>
        expect(mockShellExecutionService).toHaveBeenCalled(),
      );
      mockShellOutputCallback({
        type: 'data',
        chunk: 'test\n'.repeat(100),
        totalLines: 101,
        totalBytes: 505,
      });
      resolveShellExecution({
        output: 'test\n'.repeat(100),
        backgrounded: true,
        backgroundReason: 'timeout',
      });

      const result = await promise;

      expect(result.toolUseResult).toMatchObject({
        pid: 12345,
        command: 'while true; do echo test; sleep 1; done',
        initialOutput: 'test\n'.repeat(100),
        backgroundReason: 'timeout',
        totalLines: 101,
        totalBytes: 505,
      });
      expect(result.isError).toBeUndefined();
      expect(result.error).toBeUndefined();
    });

    it('keeps explicit background semantics when the command fails immediately', async () => {
      const invocation = shellTool.build({
        command: 'python -c "print(1)"',
        run_in_background: true,
      });
      const promise = invocation.execute(mockAbortSignal);

      resolveShellExecution({
        pid: 12345,
        exitCode: 127,
        output: 'python: command not found',
      });

      const result = await promise;

      expect(mockShellExecutionService.mock.calls[0][4]).toEqual(
        expect.objectContaining({
          startInBackground: { reason: 'model' },
        }),
      );
      expect(result.toolUseResult).toMatchObject({
        kind: 'backgrounded',
        taskId: expect.stringMatching(/^b[a-z0-9]{8}$/),
        pid: 12345,
        backgroundReason: 'model',
      });
    });

    itWindowsOnly(
      'should not wrap command on windows',
      async () => {
        mockPlatform.mockReturnValue('win32');
        const invocation = shellTool.build({ command: 'dir' });
        const promise = invocation.execute(mockAbortSignal);
        resolveShellExecution({
          rawOutput: Buffer.from(''),
          output: '',
          exitCode: 0,
          signal: null,
          error: null,
          aborted: false,
          pid: 12345,
          executionMethod: 'child_process',
        });
        await promise;
        expect(mockShellExecutionService).toHaveBeenCalledWith(
          'dir',
          tempRootDir,
          expect.any(Function),
          expect.any(AbortSignal),
          expect.objectContaining({
            pager: 'cat',
            sanitizationConfig: {},
          }),
        );
      },
      20000,
    );

    it('should format error messages correctly', async () => {
      const error = new Error('wrapped command failed');
      const invocation = shellTool.build({ command: 'user-command' });
      const promise = invocation.execute(mockAbortSignal);
      resolveShellExecution({
        error,
        exitCode: 1,
        output: 'err',
        rawOutput: Buffer.from('err'),
        signal: null,
        aborted: false,
        pid: 12345,
        executionMethod: 'child_process',
      });

      const result = await promise;
      expect(result.llmContent).toContain('wrapped command failed');
      expect(result.llmContent).not.toContain('Error:');
      expect(result.llmContent).not.toContain('pgrep');
    });

    it('should return a SHELL_EXECUTE_ERROR for a command failure', async () => {
      const error = new Error('command failed');
      const invocation = shellTool.build({ command: 'user-command' });
      const promise = invocation.execute(mockAbortSignal);
      resolveShellExecution({
        error,
        exitCode: 1,
      });

      const result = await promise;

      expect(result.error).toBeDefined();
      expect(result.error?.type).toBe(ToolErrorType.SHELL_EXECUTE_ERROR);
      expect(result.error?.message).toBe('command failed');
    });

    it('should throw an error for invalid parameters', () => {
      expect(() => shellTool.build({ command: '' })).toThrow(
        'Command cannot be empty.',
      );
    });

    it('should summarize output when configured', async () => {
      (mockConfig.getSummarizeToolOutputConfig as Mock).mockReturnValue({
        [SHELL_TOOL_NAME]: { tokenBudget: 1000 },
      });
      vi.mocked(summarizer.summarizeToolOutput).mockResolvedValue(
        'summarized output',
      );

      const invocation = shellTool.build({ command: 'ls' });
      const promise = invocation.execute(mockAbortSignal);
      resolveExecutionPromise({
        output: 'long output',
        rawOutput: Buffer.from('long output'),
        exitCode: 0,
        signal: null,
        error: null,
        aborted: false,
        pid: 12345,
        executionMethod: 'child_process',
      });

      const result = await promise;

      expect(summarizer.summarizeToolOutput).toHaveBeenCalledWith(
        mockConfig,
        expect.any(String),
        mockAbortSignal,
      );
      expect(result.llmContent).toBe('summarized output');
      expect(result.returnDisplay).toBe('long output');
    });

    it('should restore a failed exit status after summarization', async () => {
      (mockConfig.getSummarizeToolOutputConfig as Mock).mockReturnValue({
        [SHELL_TOOL_NAME]: { tokenBudget: 1000 },
      });
      vi.mocked(summarizer.summarizeToolOutput).mockResolvedValue(
        'summarized failure output',
      );

      const invocation = shellTool.build({ command: './missing-script.sh' });
      const promise = invocation.execute(mockAbortSignal);
      resolveExecutionPromise({
        output: 'missing-script.sh: No such file or directory',
        rawOutput: Buffer.from('missing-script.sh: No such file or directory'),
        exitCode: 127,
        signal: null,
        error: null,
        aborted: false,
        pid: 12345,
        executionMethod: 'child_process',
      });

      const result = await promise;

      expect(result.llmContent).toBe(
        'Exit code 127\nsummarized failure output',
      );
      expect(result.isError).toBe(true);
    });

    it.each([
      {
        timedOut: true,
        reason: 'Command timed out after 1s and was terminated.',
      },
      {
        outputLimitExceeded: true,
        reason: 'Command killed: output file exceeded 5GB.',
      },
    ])(
      'preserves the termination reason after summarization: $reason',
      async ({ reason, ...termination }) => {
        vi.mocked(mockConfig.getSummarizeToolOutputConfig).mockReturnValue({
          Bash: { tokenBudget: 100 },
        });
        vi.mocked(summarizer.summarizeToolOutput).mockResolvedValue(
          'partial output summary',
        );
        const promise = shellTool
          .build({ command: 'sleep 30', timeout: 1000 })
          .execute(mockAbortSignal);
        resolveShellExecution({
          ...termination,
          output: 'partial output',
          exitCode: 143,
        });
        const result = await promise;
        expect(result.llmContent).toBe(`${reason}\npartial output summary`);
        expect(result.isError).toBe(true);
      },
    );

    it('should not summarize user-initiated shell mode output', async () => {
      (mockConfig.getSummarizeToolOutputConfig as Mock).mockReturnValue({
        [SHELL_TOOL_NAME]: { tokenBudget: 1000 },
      });
      const invocation = shellTool.build({ command: 'ls' });
      const promise = invocation.executeWithContext!({
        signal: mockAbortSignal,
        invocationOrigin: 'user-shell',
      });
      resolveExecutionPromise({
        output: 'deterministic output',
        rawOutput: Buffer.from('deterministic output'),
        exitCode: 0,
        signal: null,
        error: null,
        aborted: false,
        pid: 12345,
        executionMethod: 'child_process',
      });

      const result = await promise;

      expect(summarizer.summarizeToolOutput).not.toHaveBeenCalled();
      expect(result.llmContent).toContain('deterministic output');
    });

    it.each([
      [0, false, false],
      [1, false, false],
      [0, true, false],
      [143, false, true],
    ] as const)(
      'preserves a readable spill path through the result pipeline (exit %s, blank middle %s, timeout %s)',
      async (exitCode, blankMiddle, timedOut) => {
        const sourcePath = path.join(tempRootDir, 'large-task.output');
        const rawContent = Buffer.concat([
          Buffer.from('HEADER\n'),
          Buffer.from([0, 255, 254]),
          Buffer.from(
            (blankMiddle ? '\n'.repeat(40_000) : '汉'.repeat(15_000) + '😀') +
              '\n{"ok":true}',
          ),
        ]);
        const content = rawContent.toString('utf8');
        fs.writeFileSync(sourcePath, rawContent);
        (
          mockConfig.storage.getProjectTempDir as unknown as Mock
        ).mockReturnValue(tempRootDir);
        const invocation = shellTool.build({ command: 'large-output' });
        Object.assign(mockConfig, {
          getShellExecutionConfig: () => ({}),
          getFileHistoryManager: () => undefined,
          getHookSystem: () => undefined,
          getActiveModel: () => 'test-model',
        });
        const request = {
          callId: 'large-output-call',
          name: SHELL_TOOL_NAME,
          args: { command: 'large-output' },
          prompt_id: 'prompt-123',
        };
        const promise = new LocalToolCallExecutor(mockConfig).execute({
          call: {
            status: CoreToolCallStatus.Scheduled,
            request,
            tool: shellTool,
            invocation,
          },
          signal: mockAbortSignal,
          sessionId: 'session-123',
          onUpdateToolCall: vi.fn(),
        });
        resolveExecutionPromise({
          output: rawContent.subarray(0, 30_000).toString('utf8').trimEnd(),
          rawOutput: Buffer.alloc(0),
          outputFilePath: sourcePath,
          outputFileSize: rawContent.length,
          timedOut,
          exitCode,
          signal: null,
          error: null,
          aborted: false,
          pid: 12345,
          executionMethod: 'child_process',
        });

        const { result, outputFile } = await promise;

        expect(result.data).toMatchObject({
          kind: timedOut ? 'cancelled' : 'completed',
          persistedOutput: {
            originalSizeBytes: rawContent.length,
            truncated: false,
          },
        });
        const persistedPath = (
          result.data?.['persistedOutput'] as { path: string }
        ).path;
        expect(fs.readFileSync(persistedPath, 'utf8')).toBe(content);
        expect(result.returnDisplay).toContain('Full output saved to:');
        expect(result.returnDisplay).toContain(
          'Preview (head and tail, up to 2000 characters):',
        );
        // Bash already reduced its output; the generic truncator does not run.
        expect(outputFile).toBeUndefined();
        const completed = convertToolResultToCompletedToolCall(
          {
            request,
            tool: shellTool,
            invocation,
            result,
            error: undefined,
            cancelled: false,
            durationMs: 1,
          },
          'root',
          undefined,
        );
        const modelResult = completedToolCallToResult(completed);
        expect(modelResult.content).toBe(result.llmContent);
        expect(modelResult.content).toContain('Full output saved to:');
        expect(modelResult.content).toContain(persistedPath);
        expect(modelResult.content).toContain(
          'Preview (head and tail, up to 2000 characters):',
        );
        expect(modelResult.content).toContain('HEADER\n\0��');
        expect(modelResult.content).toContain('{"ok":true}');
        expect(modelResult.content).toContain('\0');
        expect(modelResult.content).not.toContain('\\x00');
        expect(JSON.parse(JSON.stringify(modelResult)).content).toBe(
          modelResult.content,
        );
        expect(fs.readFileSync(persistedPath)).toEqual(rawContent);
        expect(modelResult.content).not.toContain('binary output');
        expect(modelResult.is_error).toBe(exitCode !== 0);
        if (timedOut) {
          expect(modelResult.content).toContain('Command timed out after');
        }
        expect(modelResult.content).not.toContain('汉'.repeat(2000));
      },
    );

    it('should NOT start a timeout if timeoutMs is <= 0', async () => {
      // Mock the timeout config to be 0
      (mockConfig.getShellToolInactivityTimeout as Mock).mockReturnValue(0);

      vi.useFakeTimers();

      const invocation = shellTool.build({ command: 'sleep 10' });
      const promise = invocation.execute(mockAbortSignal);

      // Verify no timeout logic is triggered even after a long time
      resolveShellExecution({
        output: 'finished',
        exitCode: 0,
      });

      await promise;
      // If we got here without aborting/timing out logic interfering, we're good.
      // We can also verify that setTimeout was NOT called for the inactivity timeout.
      // However, since we don't have direct access to the internal `resetTimeout`,
      // we can infer success by the fact it didn't abort.
    });

    describe('Streaming to `updateOutput`', () => {
      let updateOutputMock: Mock;
      beforeEach(() => {
        vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
        updateOutputMock = vi.fn();
      });
      afterEach(() => {
        vi.useRealTimers();
      });

      it('should update output with progress snapshot data events', async () => {
        const invocation = shellTool.build({ command: 'cat file' });
        const promise = invocation.execute(mockAbortSignal, updateOutputMock);

        // Progress updates are gated behind SHELL_PROGRESS_THRESHOLD_MS (2000ms)
        await vi.advanceTimersByTimeAsync(2000);

        mockShellOutputCallback({ type: 'data', chunk: 'line1\n' });
        expect(updateOutputMock).toHaveBeenCalledExactlyOnceWith('line1\n');

        mockShellOutputCallback({ type: 'data', chunk: 'line1\nline2\n' });
        expect(updateOutputMock).toHaveBeenCalledTimes(2);
        expect(updateOutputMock).toHaveBeenLastCalledWith('line1\nline2\n');

        resolveExecutionPromise({
          rawOutput: Buffer.from(''),
          output: 'line1\nline2\n',
          exitCode: 0,
          signal: null,
          error: null,
          aborted: false,
          pid: 12345,
          executionMethod: 'child_process',
        });
        await promise;
      });

      it('should include shell progress metadata in live output updates', async () => {
        const invocation = shellTool.build({ command: 'cat file' });
        const promise = invocation.execute(mockAbortSignal, updateOutputMock);

        // Progress updates are gated behind SHELL_PROGRESS_THRESHOLD_MS (2000ms)
        await vi.advanceTimersByTimeAsync(2000);

        mockShellOutputCallback({
          type: 'data',
          chunk: 'test\n'.repeat(100),
          totalLines: 100,
          totalBytes: 500,
        });
        expect(updateOutputMock).toHaveBeenCalledExactlyOnceWith({
          isShellLiveOutput: true,
          output: 'test\n'.repeat(100),
          totalLines: 100,
          totalBytes: 500,
        });

        mockShellOutputCallback({
          type: 'data',
          chunk: 'test\n'.repeat(100),
          totalLines: 101,
          totalBytes: 505,
        });
        expect(updateOutputMock).toHaveBeenCalledTimes(2);
        expect(updateOutputMock).toHaveBeenLastCalledWith({
          isShellLiveOutput: true,
          output: 'test\n'.repeat(100),
          totalLines: 101,
          totalBytes: 505,
        });

        mockShellOutputCallback({
          type: 'data',
          chunk: 'tail',
          totalBytes: 10_000_000,
        });
        expect(updateOutputMock).toHaveBeenLastCalledWith({
          isShellLiveOutput: true,
          output: 'tail',
          totalLines: undefined,
          totalBytes: 10_000_000,
        });

        resolveExecutionPromise({
          rawOutput: Buffer.from(''),
          output: 'test\n'.repeat(101),
          exitCode: 0,
          signal: null,
          error: null,
          aborted: false,
          pid: 12345,
          executionMethod: 'child_process',
        });
        await promise;
      });

      it('should NOT call updateOutput if the command is backgrounded', async () => {
        const invocation = shellTool.build({
          command: 'sleep 10',
          run_in_background: true,
        });
        const promise = invocation.execute(mockAbortSignal, updateOutputMock);

        mockShellOutputCallback({ type: 'data', chunk: 'some output' });
        expect(updateOutputMock).not.toHaveBeenCalled();

        await promise;
        expect(mockShellExecutionService.mock.calls[0][4]).toEqual(
          expect.objectContaining({
            startInBackground: { reason: 'model' },
          }),
        );
      });
    });
  });

  describe('CWD reset on drift', () => {
    const mockAbortSignal = new AbortController().signal;

    const resolveShellExecution = (
      result: Partial<ShellExecutionResult> = {},
    ) => {
      const fullResult: ShellExecutionResult = {
        rawOutput: Buffer.from(result.output || ''),
        output: 'Success',
        exitCode: 0,
        signal: null,
        error: null,
        aborted: false,
        pid: 12345,
        executionMethod: 'child_process',
        ...result,
      };
      resolveExecutionPromise(fullResult);
    };

    let outsideDir: string;

    beforeEach(() => {
      outsideDir = realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), 'shell-drift-')),
      );
    });

    afterEach(() => {
      if (fs.existsSync(outsideDir)) {
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it('resets CWD and appends notice when command leaves workspace', async () => {
      // Simulate the shell having drifted outside the workspace before
      // the next command runs.
      setCwd(outsideDir);
      expect(getCwd()).toBe(outsideDir);

      const invocation = shellTool.build({ command: 'true' });
      const promise = invocation.execute(mockAbortSignal);
      resolveShellExecution();
      const result = await promise;

      // CWD must be back inside the workspace.
      // setCwd realpaths its input, so getCwd() may have a /private prefix
      // on macOS while getOriginalCwd() does not. Compare resolved paths.
      expect(getCwd()).toBe(realpathSync(getOriginalCwd()));

      const data = result.data as { stderr: string };
      expect(data.stderr).toContain(
        `Shell cwd was reset to ${getOriginalCwd()}`,
      );
      expect(result.returnDisplay as string).toContain(
        `Shell cwd was reset to ${getOriginalCwd()}`,
      );
    });

    it('does NOT reset or annotate when preventCwdChanges is set (subagent path)', async () => {
      setCwd(outsideDir);

      const invocation = shellTool.build({ command: 'true' });
      const promise = invocation.execute(mockAbortSignal, undefined, {
        shellExecutionConfig: {
          preventCwdChanges: true,
        } as unknown as import('../services/shellExecutionService.js').ShellExecutionConfig,
      });
      resolveShellExecution();
      const result = await promise;

      // CWD must NOT be reset
      expect(getCwd()).toBe(outsideDir);

      const data = result.data as { stderr: string };
      expect(data.stderr ?? '').not.toContain('Shell cwd was reset');
      expect((result.returnDisplay as string) ?? '').not.toContain(
        'Shell cwd was reset',
      );
    });

    it('no-ops when CWD has not drifted', async () => {
      const invocation = shellTool.build({ command: 'true' });
      const promise = invocation.execute(mockAbortSignal);
      resolveShellExecution();
      const result = await promise;

      const data = result.data as { stderr: string };
      expect(data.stderr ?? '').not.toContain('Shell cwd was reset');
      expect((result.returnDisplay as string) ?? '').not.toContain(
        'Shell cwd was reset',
      );
    });
  });

  describe('getDescription', () => {
    it('should include the Git Bash description on windows', () => {
      mockPlatform.mockReturnValue('win32');
      const shellTool = new ShellTool(mockConfig);
      expect(shellTool.description).toContain(
        'This tool runs Git Bash (POSIX sh), not cmd.exe or PowerShell.',
      );
      expect(shellTool.description).toMatchSnapshot();
    });

    it('should omit the Git Bash description when not on windows', () => {
      mockPlatform.mockReturnValue('linux');
      const shellTool = new ShellTool(mockConfig);
      expect(shellTool.description).not.toContain(
        'This tool runs Git Bash (POSIX sh), not cmd.exe or PowerShell.',
      );
      expect(shellTool.description).toMatchSnapshot();
    });

    it('should use the full Bash-first description', () => {
      mockPlatform.mockReturnValue('linux');
      const shellTool = new ShellTool(mockConfig);

      expect(shellTool.description).not.toContain('Efficiency Guidelines:');
      expect(shellTool.description).not.toContain(
        'When issuing multiple commands:',
      );
      expect(shellTool.description).not.toContain(
        'Avoid using this tool to run `find`, `grep`',
      );
      expect(shellTool.description).toContain(
        'When running `find`, search from `.`',
      );
      expect(shellTool.description).toContain(
        'never prepend `cd <current-directory>` to a `git` command',
      );
    });
  });

  describe('getDisplayTitle and getExplanation', () => {
    it('should return only the command for getDisplayTitle', () => {
      const invocation = shellTool.build({
        command: 'echo hello',
        description: 'prints hello',
        dir_path: 'foo/bar',
        run_in_background: true,
      });
      expect(invocation.getDisplayTitle?.()).toBe('echo hello');
    });

    it('should return the context for getExplanation', () => {
      const invocation = shellTool.build({
        command: 'echo hello',
        description: 'prints hello',
        dir_path: 'foo/bar',
        run_in_background: true,
      });
      expect(invocation.getExplanation?.()).toBe(
        '[in foo/bar] (prints hello) [background]',
      );
    });

    it('should construct explanation without optional parameters', () => {
      const invocation = shellTool.build({
        command: 'echo hello',
      });
      expect(invocation.getExplanation?.()).toBe(
        `[current working directory ${tempRootDir}]`,
      );
    });
  });

  describe('invocation getDescription', () => {
    it('should return the description if it is present and not empty whitespace', () => {
      const invocation = shellTool.build({
        command: 'echo hello',
        description: 'prints hello',
      });
      expect(invocation.getDescription()).toBe('prints hello');
    });

    it('should return the raw command if description is an empty string', () => {
      const invocation = shellTool.build({
        command: 'echo hello',
        description: '',
      });
      expect(invocation.getDescription()).toBe('echo hello');
    });

    it('should return the raw command if description is just whitespace', () => {
      const invocation = shellTool.build({
        command: 'echo hello',
        description: '   ',
      });
      expect(invocation.getDescription()).toBe('echo hello');
    });
  });

  describe('llmContent output format', () => {
    const mockAbortSignal = new AbortController().signal;

    const resolveShellExecution = (
      result: Partial<ShellExecutionResult> = {},
    ) => {
      const fullResult: ShellExecutionResult = {
        rawOutput: Buffer.from(result.output || ''),
        output: 'Success',
        exitCode: 0,
        signal: null,
        error: null,
        aborted: false,
        pid: 12345,
        executionMethod: 'child_process',
        ...result,
      };
      resolveExecutionPromise(fullResult);
    };

    it('should not include Command in output', async () => {
      const invocation = shellTool.build({ command: 'echo hello' });
      const promise = invocation.execute(mockAbortSignal);
      resolveShellExecution({ output: 'hello', exitCode: 0 });

      const result = await promise;
      expect(result.llmContent).not.toContain('Command:');
    });

    it('should not include Directory in output', async () => {
      const invocation = shellTool.build({ command: 'ls', dir_path: 'subdir' });
      const promise = invocation.execute(mockAbortSignal);
      resolveShellExecution({ output: 'file.txt', exitCode: 0 });

      const result = await promise;
      expect(result.llmContent).not.toContain('Directory:');
    });

    it('should not include Exit Code when command succeeds (exit code 0)', async () => {
      const invocation = shellTool.build({ command: 'echo hello' });
      const promise = invocation.execute(mockAbortSignal);
      resolveShellExecution({ output: 'hello', exitCode: 0 });

      const result = await promise;
      expect(result.llmContent).not.toContain('Exit Code:');
    });

    it('should prefix the exit code and mark a failed command as a semantic error', async () => {
      const invocation = shellTool.build({ command: 'false' });
      const promise = invocation.execute(mockAbortSignal);
      resolveShellExecution({ output: '', exitCode: 1 });

      const result = await promise;
      expect(result.llmContent).toBe('Exit code 1');
      expect(result.isError).toBe(true);
      expect(result.data).toMatchObject({
        stdout: '',
        exitCode: 1,
        isError: true,
      });
    });

    it('treats an expected non-zero status as a successful result', async () => {
      const invocation = shellTool.build({ command: 'rg missing-pattern' });
      const promise = invocation.execute(mockAbortSignal);
      resolveShellExecution({ output: '', exitCode: 1 });

      const result = await promise;
      expect(result.isError).toBeUndefined();
      expect(result.llmContent).toContain('No matches found');
      expect(result.llmContent).not.toContain('Exit code 1');
      expect(result.data).toMatchObject({
        stdout: '',
        exitCode: 1,
        returnCodeInterpretation: 'No matches found',
      });
      expect(result.data).not.toHaveProperty('isError');
    });

    it('should not include Error when there is no process error', async () => {
      const invocation = shellTool.build({ command: 'echo hello' });
      const promise = invocation.execute(mockAbortSignal);
      resolveShellExecution({ output: 'hello', exitCode: 0, error: null });

      const result = await promise;
      expect(result.llmContent).not.toContain('Error:');
    });

    it('should include Error when there is a process error', async () => {
      const invocation = shellTool.build({ command: 'bad-command' });
      const promise = invocation.execute(mockAbortSignal);
      resolveShellExecution({
        output: '',
        exitCode: 1,
        error: new Error('spawn ENOENT'),
      });

      const result = await promise;
      expect(result.llmContent).toContain('spawn ENOENT');
      expect(result.llmContent).not.toContain('Error:');
    });

    it('should not include Signal when there is no signal', async () => {
      const invocation = shellTool.build({ command: 'echo hello' });
      const promise = invocation.execute(mockAbortSignal);
      resolveShellExecution({ output: 'hello', exitCode: 0, signal: null });

      const result = await promise;
      expect(result.llmContent).not.toContain('Signal:');
    });

    it('should include Signal when process was killed by signal', async () => {
      const invocation = shellTool.build({ command: 'sleep 100' });
      const promise = invocation.execute(mockAbortSignal);
      resolveShellExecution({
        output: '',
        exitCode: null,
        signal: 9, // SIGKILL
      });

      const result = await promise;
      expect(result.llmContent).toBe('Signal: 9');
      expect(result.isError).toBe(true);
    });

    it('should not include Process Group PGID when pid is not set', async () => {
      const invocation = shellTool.build({ command: 'echo hello' });
      const promise = invocation.execute(mockAbortSignal);
      resolveShellExecution({ output: 'hello', exitCode: 0, pid: undefined });

      const result = await promise;
      expect(result.llmContent).not.toContain('Process Group PGID:');
    });

    it('should have minimal output for successful command', async () => {
      const invocation = shellTool.build({ command: 'echo hello' });
      const promise = invocation.execute(mockAbortSignal);
      resolveShellExecution({ output: 'hello', exitCode: 0, pid: undefined });

      const result = await promise;
      expect(result.llmContent).toBe('hello');
    });
  });

  describe('buildConfirmationDetails', () => {
    it('should annotate sub-commands with redirection correctly', async () => {
      const shellTool = new ShellTool(mockConfig);
      const command = 'mkdir -p baz && echo "hello" > baz/test.md && ls';

      const details = await buildConfirmationDetails(
        shellTool,
        { command },
        undefined,
      );

      expect(details).not.toBe(false);
      if (details && details.type === 'exec') {
        expect(details.rootCommand).toBe('mkdir, echo, ls');
      }
    });

    it('should annotate all redirected sub-commands', async () => {
      const shellTool = new ShellTool(mockConfig);
      const command = 'cat < input.txt && grep "foo" > output.txt';

      const details = await buildConfirmationDetails(
        shellTool,
        { command },
        undefined,
      );

      expect(details).not.toBe(false);
      if (details && details.type === 'exec') {
        expect(details.rootCommand).toBe('cat, grep');
      }
    });

    it('should annotate sub-commands with pipes correctly', async () => {
      const shellTool = new ShellTool(mockConfig);
      const command = 'ls | grep "baz"';

      const details = await buildConfirmationDetails(
        shellTool,
        { command },
        undefined,
      );

      expect(details).not.toBe(false);
      if (details && details.type === 'exec') {
        expect(details.rootCommand).toBe('ls, grep');
      }
    });
  });

  describe('getSchema', () => {
    it('should return the base schema when no modelId is provided', () => {
      const schema = shellTool.getSchema();
      expect(schema.name).toBe(SHELL_TOOL_NAME);
      expect(schema.description).toMatchSnapshot();
    });

    it('should return the schema when modelId is provided', () => {
      const modelId = 'gemini-2.0-flash';
      const schema = shellTool.getSchema(modelId);
      expect(schema.name).toBe(SHELL_TOOL_NAME);
      expect(schema.description).toMatchSnapshot();
    });

    it('should return the compact Bash description for Lean models', () => {
      vi.stubEnv(SIMPLE_SYSTEM_PROMPT_ENV, '1');

      const description = shellTool.getSchema('lean-model').description ?? '';

      expect(description).toContain('Command output is displayed to you');
      expect(description).toContain('# Git');
      expect(description).not.toContain('# Instructions');
      expect(description).not.toContain('# Committing changes with git');
    });

    it('should hide PTY parameters and guidance when Bash PTY tools are disabled', () => {
      delete process.env[ENV_ENABLE_BASH_PTY_TOOLS];
      const schema = shellTool.getSchema();
      const properties =
        (
          schema.parametersJsonSchema as {
            properties?: Record<string, unknown>;
          }
        )?.properties ?? {};

      expect(properties).not.toHaveProperty('pty');
      expect(properties).not.toHaveProperty('cols');
      expect(properties).not.toHaveProperty('rows');
      expect(schema.description).not.toContain('BashInput');
      expect(schema.description).not.toContain('BashOutput');
      expect(schema.description).not.toContain('BashResize');
    });

    it('should expose PTY parameters and guidance when Bash PTY tools are enabled', () => {
      process.env[ENV_ENABLE_BASH_PTY_TOOLS] = '1';
      const schema = shellTool.getSchema();
      const properties =
        (
          schema.parametersJsonSchema as {
            properties?: Record<string, unknown>;
          }
        )?.properties ?? {};

      expect(properties).toHaveProperty('pty');
      expect(properties).toHaveProperty('cols');
      expect(properties).toHaveProperty('rows');
      expect(schema.description).toContain('BashInput');
      expect(schema.description).toContain('BashOutput');
      expect(schema.description).toContain('BashResize');
    });
  });
});
