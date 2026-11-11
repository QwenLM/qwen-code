/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { ENV_SECURITY_SCAN_RULES_FILE } from "../config/brand.js";

import '../test-utils/mock-undici-fetch-with-global.js';

import { withSessionSelection } from '../test-utils/request-model.js';

import type { ModelSelection } from '../provider/model/modelSelection.js';
import {
  businessInfoContext,
  customContextContext,
  requestSetIdContext,
} from '../utils/sessionIdContext.js';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  testRequestConfig,
  testProviderModel,
} from '../test-utils/model-resolution.js';
import type { QueryParams } from '../core/agent-loop.js';
import type { ModelSelectContext } from '../provider/model/modelSelectContext.js';
import type { ModelStreamRequest } from '../provider/modelStreamRequest.js';
import { createModelStreamResponse } from '../provider/modelStreamResponseFactory.js';
import { CustomModelSelector } from '../provider/impl/customModelSelector.js';
import { CustomProviderConfig } from '../provider/impl/customProviderConfig.js';
import { OPENAI_CHAT_COMPLETIONS } from '../provider/transport/modelProtocol.js';
import { ModelNotFoundError } from '../utils/httpErrors.js';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { HookRunner } from './hookRunner.js';
import { registerSensitiveEnvironmentVariables } from '../config/sensitiveEnvironment.js';
import {
  HookEventName,
  HookType,
  ConfigSource,
  type HookConfig,
  type CommandHookConfig,
  type PromptHookConfig,
  type AgentHookConfig,
  type HookInput,
} from './types.js';
import type { Readable, Writable } from 'node:stream';
import type { Config } from '../config/config.js';
import {
  createAssistantMessage,
  createToolResultMessage,
} from '../protocol/transcript/conversions.js';
import { cloneUsage } from '../protocol/provider/empty-usage.js';
import {
  prepareDetachedProcessGuard,
  guardDetachedProcess,
} from '../services/detachedProcessGuard.js';

vi.mock('../services/detachedProcessGuard.js', () => ({
  prepareDetachedProcessGuard: vi.fn(),
  guardDetachedProcess: vi.fn(),
}));

// Mock type for the child_process spawn
type MockChildProcessWithoutNullStreams = ChildProcessWithoutNullStreams & {
  mockStdoutOn: ReturnType<typeof vi.fn>;
  mockStderrOn: ReturnType<typeof vi.fn>;
  mockProcessOn: ReturnType<typeof vi.fn>;
};

// Mock child_process with importOriginal for partial mocking
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as object),
    spawn: vi.fn(),
  };
});

// Mock runLogger using vi.hoisted
const mockRunLogger = vi.hoisted(() => ({
  log: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('../utils/runLogger.js', () => ({
  runLogger: mockRunLogger,
}));

const mockResolveShellPrefix = vi.hoisted(() => vi.fn());
const mockWrapPosixShellCommand = vi.hoisted(() => vi.fn());
const mockFindGitBashPath = vi.hoisted(() => vi.fn());

vi.mock('../utils/shell/shellPrefix.js', () => ({
  resolveShellPrefix: mockResolveShellPrefix,
  wrapPosixShellCommand: mockWrapPosixShellCommand,
}));

vi.mock('../utils/windowsPaths.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../utils/windowsPaths.js')>();
  return {
    ...actual,
    findGitBashPath: mockFindGitBashPath,
  };
});

// Mock console methods
const mockConsole = {
  log: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

vi.stubGlobal('console', mockConsole);

// Mock for prompt hook model output
const mockGenerateJson = vi.fn();

// Mock for query (agent hook execution)
const mockRunLoop = vi.hoisted(() => vi.fn());
vi.mock('../core/agent-loop.js', () => ({
  query: (...args: unknown[]) => mockRunLoop(...args),
}));

// Mocks for Scheduler pipeline (agent hook execution)
const mockResultHolder = vi.hoisted(() => ({
  result: null as { ok: boolean; reason?: string } | null,
}));
const MockStructuredOutputResultHolder = vi.hoisted(() => vi.fn());
const MockStructuredOutputDeclarativeTool = vi.hoisted(() => vi.fn());
const MockToolRegistryCtor = vi.hoisted(() => vi.fn());
const mockScopedRegisterTool = vi.hoisted(() => vi.fn());
const mockCreateHookAgentLoopContext = vi.hoisted(() => vi.fn());

vi.mock('./structuredOutputTool.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as object),
    StructuredOutputResultHolder: MockStructuredOutputResultHolder,
    StructuredOutputDeclarativeTool: MockStructuredOutputDeclarativeTool,
  };
});

vi.mock('../tools/tool-registry.js', () => ({
  ToolRegistry: MockToolRegistryCtor,
}));

vi.mock('./hookAgentLoopContext.js', () => ({
  createHookAgentLoopContext: mockCreateHookAgentLoopContext,
}));

const mockGetPluginDataDir = vi.hoisted(() =>
  vi.fn().mockReturnValue('/mock/plugin/data'),
);
vi.mock('../plugins/pluginDirectories.js', () => ({
  getPluginDataDir: mockGetPluginDataDir,
}));

const mockFsStat = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ isDirectory: () => true }),
);
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual =
    (await importOriginal<typeof import('node:fs/promises')>()) ?? {};
  return {
    ...actual,
    stat: mockFsStat,
  };
});

const mockTreeKill = vi.fn();
vi.mock('tree-kill', () => ({
  default: (...args: unknown[]) => mockTreeKill(...args),
}));

// POSIX hook teardown now calls process.kill(-pid, …); this fn backs a spy so
// tests can assert/drive it without firing real signals (installed per beforeEach).
const mockProcessKill = vi.fn();

const TOKEN_ENV = 'PRODUCT_SENSITIVE_TOKEN';
/** 任意环境变量；这些用例只验证 hook env 的覆盖语义，与产品无关。 */
const ENV_UNDER_TEST = 'CLI_HOOK_ENV_UNDER_TEST';

// Core 不内置任何产品敏感变量名，这里模拟产品入口的注册。
registerSensitiveEnvironmentVariables([TOKEN_ENV]);

describe('HookRunner', () => {
  let hookRunner: HookRunner;
  let mockSpawn: MockChildProcessWithoutNullStreams;
  let mockConfig: Config;

  const mockInput: HookInput = {
    session_id: 'test-session',
    transcript_path: '/path/to/transcript',
    cwd: '/test/project',
    hook_event_name: 'PreToolUse',
    permission_mode: 'default',
  };

  beforeEach(() => {
    vi.resetAllMocks();
    // SAFETY: POSIX hook teardown calls process.kill(-pid, …). A bare spyOn
    // calls through and would fire REAL signals at the test runner's process
    // group, so install a no-op impl. Must be re-established AFTER
    // resetAllMocks() (which wipes it); the afterEach restoreAllMocks() restores
    // the real process.kill.
    mockProcessKill.mockReturnValue(true);
    vi.spyOn(process, 'kill').mockImplementation(((...args: unknown[]) =>
      mockProcessKill(...args)) as unknown as typeof process.kill);
    mockFsStat.mockResolvedValue({ isDirectory: () => true });
    mockResolveShellPrefix.mockReturnValue(undefined);
    mockWrapPosixShellCommand.mockImplementation(
      (command: string, prefix: string) => `${prefix}::${command}`,
    );
    mockFindGitBashPath.mockResolvedValue(
      'C:\\Program Files\\Git\\bin\\bash.exe',
    );

    mockConfig = {
      ...testRequestConfig(),
      getProjectRoot: vi.fn().mockReturnValue('/test/project'),
      getSessionArtifactProjectRoot: vi.fn().mockReturnValue('/test/project'),
      isTrustedFolder: vi.fn().mockReturnValue(true),
      isInteractive: vi.fn().mockReturnValue(true),
      sanitizationConfig: {
        enableEnvironmentVariableRedaction: true,
      },
      getToolRegistry: vi.fn().mockReturnValue({
        getFunctionDeclarations: vi.fn().mockReturnValue([]),
        getTool: vi.fn(),
      }),
      getModel: vi.fn().mockReturnValue('gemini-2.0-flash'),
      getSessionId: vi.fn().mockReturnValue('test-session'),
      getAllowedHttpHookUrls: vi.fn().mockReturnValue(undefined),
    } as unknown as Config;

    hookRunner = new HookRunner(mockConfig);

    // Mock spawn with accessible mock functions
    const mockStdoutOn = vi.fn();
    const mockStderrOn = vi.fn();
    const mockProcessOn = vi.fn();

    mockSpawn = {
      pid: 12345,
      stdin: {
        write: vi.fn(),
        end: vi.fn(),
        on: vi.fn(),
      } as unknown as Writable,
      stdout: {
        on: mockStdoutOn,
      } as unknown as Readable,
      stderr: {
        on: mockStderrOn,
      } as unknown as Readable,
      on: mockProcessOn,
      kill: vi.fn(),
      killed: false,
      mockStdoutOn,
      mockStderrOn,
      mockProcessOn,
    } as unknown as MockChildProcessWithoutNullStreams;

    vi.mocked(spawn).mockReturnValue(mockSpawn);
  });

  describe('project directory and execution cwd', () => {
    beforeEach(() => {
      mockSpawn.mockProcessOn.mockImplementation(
        (event: string, callback: (code: number) => void) => {
          if (event === 'exit') setImmediate(() => callback(0));
        },
      );
    });

    it('does not supply product metadata to a project command hook', async () => {
      vi.stubEnv('QODER_SITE', undefined);
      vi.stubEnv('QODER_HOOK_SOURCE', undefined);
      vi.stubEnv('QODER_HOOK_VERSION', undefined);
      try {
        const result = await hookRunner.executeHook(
          {
            type: HookType.Command,
            source: ConfigSource.Project,
            command: 'echo test',
          },
          HookEventName.PreToolUse,
          mockInput,
        );

        expect(result.success).toBe(true);
        const env = vi.mocked(spawn).mock.calls[0][2].env;
        expect(env).not.toHaveProperty('QODER_SITE');
        expect(env).not.toHaveProperty('QODER_HOOK_SOURCE');
        expect(env).not.toHaveProperty('QODER_HOOK_VERSION');
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it('merges product defaults into a local command hook before its env overrides', async () => {
      class ProductHookRunner extends HookRunner {
        protected override async prepareEnv(projectDir: string) {
          return {
            ...(await super.prepareEnv(projectDir)),
            PRODUCT_DEFAULT: 'default',
            PRODUCT_OVERRIDDEN: 'default',
            [TOKEN_ENV]: 'product-token',
          };
        }
      }
      hookRunner = new ProductHookRunner(mockConfig);
      const result = await hookRunner.executeHook(
        {
          type: HookType.Command,
          source: ConfigSource.Local,
          command: 'echo test',
          env: { PRODUCT_OVERRIDDEN: 'explicit' },
        },
        HookEventName.PreToolUse,
        mockInput,
      );

      expect(result.success).toBe(true);
      const env = vi.mocked(spawn).mock.calls[0][2].env;
      expect(env).toMatchObject({
        PRODUCT_DEFAULT: 'default',
        PRODUCT_OVERRIDDEN: 'explicit',
      });
      expect(env).not.toHaveProperty(TOKEN_ENV);
    });

    describe.each([
      HookEventName.PreCompact,
      HookEventName.PostCompact,
      HookEventName.CwdChanged,
      HookEventName.FileChanged,
    ])('%s', (eventName) => {
      it.each(['bash', 'powershell', 'exec'] as const)(
        'keeps project paths rooted while running %s in the event cwd',
        async (mode) => {
          vi.mocked(mockConfig.getProjectRoot).mockReturnValue(
            '/test/worktree',
          );
          const input: HookInput = {
            ...mockInput,
            hook_event_name: eventName,
            cwd: '/test/worktree/src',
          };
          const command = 'echo "${QWEN_PROJECT_DIR}" "${CLAUDE_PROJECT_DIR}"';
          const hook: CommandHookConfig =
            mode === 'exec'
              ? {
                  type: HookType.Command,
                  command: '${QWEN_PROJECT_DIR}/hooks/check',
                  args: ['${CLAUDE_PROJECT_DIR}/config.json'],
                }
              : { type: HookType.Command, shell: mode, command };

          const result = await hookRunner.executeHook(hook, eventName, input);

          expect(result.success).toBe(true);
          if (process.platform !== 'win32') {
            expect(prepareDetachedProcessGuard).toHaveBeenCalledOnce();
            expect(
              vi.mocked(prepareDetachedProcessGuard).mock
                .invocationCallOrder[0],
            ).toBeLessThan(vi.mocked(spawn).mock.invocationCallOrder[0]);
          }
          expect(guardDetachedProcess).toHaveBeenCalledWith(mockSpawn);
          expect(
            vi.mocked(guardDetachedProcess).mock.invocationCallOrder[0],
          ).toBeGreaterThan(vi.mocked(spawn).mock.invocationCallOrder[0]);
          const [executable, args, options] = vi.mocked(spawn).mock.calls[0];
          expect(options.cwd).toBe(input.cwd);
          expect(options.env?.['QWEN_PROJECT_DIR']).toBe('/test/project');
          expect(options.env?.['CLAUDE_PROJECT_DIR']).toBe('/test/project');
          expect(mockSpawn.stdin.write).toHaveBeenCalledWith(
            JSON.stringify(input),
          );
          if (mode === 'exec') {
            expect(executable).toBe('/test/project/hooks/check');
            expect(args).toEqual(['/test/project/config.json']);
          } else {
            expect(args.join(' ')).toContain(
              mode === 'bash'
                ? command
                : 'echo "/test/project" "/test/project"',
            );
          }
        },
      );
    });

    it('keeps project resources in the original project after switching worktrees', async () => {
      const hook: CommandHookConfig = {
        type: HookType.Command,
        command: '${QWEN_PROJECT_DIR}/hooks/check',
        args: ['${CLAUDE_PROJECT_DIR}'],
      };
      await hookRunner.executeHook(hook, HookEventName.PreToolUse, mockInput);
      vi.mocked(mockConfig.getProjectRoot).mockReturnValue('/test/worktree');
      await hookRunner.executeHook(hook, HookEventName.PreToolUse, {
        ...mockInput,
        cwd: '/test/worktree/src',
      });

      const [executable, args, options] = vi.mocked(spawn).mock.calls[1];
      expect(executable).toBe('/test/project/hooks/check');
      expect(args).toEqual(['/test/project']);
      expect(options.cwd).toBe('/test/worktree/src');
      expect(options.env?.['QWEN_PROJECT_DIR']).toBe('/test/project');
      expect(options.env?.['CLAUDE_PROJECT_DIR']).toBe('/test/project');
    });
  });

  describe('shell prefix', () => {
    beforeEach(() => {
      mockSpawn.mockProcessOn.mockImplementation(
        (event: string, callback: (code: number) => void) => {
          if (event === 'exit') {
            setImmediate(() => callback(0));
          }
        },
      );
      mockResolveShellPrefix.mockReturnValue('/opt/tools/shell logger');
    });

    it.each([
      ['the default POSIX shell', undefined],
      ['an explicit bash shell', 'bash' as const],
    ])('should wrap shell-form hooks using %s', async (_name, shell) => {
      const hookConfig: CommandHookConfig = {
        type: HookType.Command,
        command: 'printf "%s" "$QWEN_PROJECT_DIR"',
        ...(shell ? { shell } : {}),
      };

      await hookRunner.executeHook(
        hookConfig,
        HookEventName.PreToolUse,
        mockInput,
      );

      expect(mockResolveShellPrefix).toHaveBeenCalledTimes(1);
      expect(mockWrapPosixShellCommand).toHaveBeenCalledWith(
        'printf "%s" "$QWEN_PROJECT_DIR"',
        '/opt/tools/shell logger',
      );
      const [, args] = vi.mocked(spawn).mock.calls[0];
      expect(args.at(-1)).toBe(
        '/opt/tools/shell logger::printf "%s" "$QWEN_PROJECT_DIR"',
      );
      expect(mockSpawn.stdin.write).toHaveBeenCalledWith(
        JSON.stringify(mockInput),
      );
      expect(mockSpawn.stdin.end).toHaveBeenCalledOnce();
    });

    it('should not wrap PowerShell shell-form hooks', async () => {
      await hookRunner.executeHook(
        {
          type: HookType.Command,
          command: 'Write-Output "hello"',
          shell: 'powershell',
        },
        HookEventName.PreToolUse,
        mockInput,
      );

      expect(mockResolveShellPrefix).not.toHaveBeenCalled();
      expect(mockWrapPosixShellCommand).not.toHaveBeenCalled();
      const [executable, args] = vi.mocked(spawn).mock.calls[0];
      expect(executable).toMatch(/pwsh|powershell/);
      expect(args.at(-1)).toBe(
        'Write-Output "hello"; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }',
      );
    });

    it.each([
      ['non-empty args', ['hello']],
      ['an empty args array', []],
    ])('should not wrap exec-form hooks with %s', async (_name, args) => {
      await hookRunner.executeHook(
        {
          type: HookType.Command,
          command: '/bin/echo',
          args,
        },
        HookEventName.PreToolUse,
        mockInput,
      );

      expect(mockResolveShellPrefix).not.toHaveBeenCalled();
      expect(mockWrapPosixShellCommand).not.toHaveBeenCalled();
      expect(spawn).toHaveBeenCalledWith(
        '/bin/echo',
        args,
        expect.objectContaining({ shell: false }),
      );
    });

    it('prepends the Windows Bash directory to a case-insensitive Path key', async () => {
      const platformSpy = vi
        .spyOn(process, 'platform', 'get')
        .mockReturnValue('win32');
      const originalPath = process.env['PATH'];
      const originalMixedCasePath = process.env['Path'];

      try {
        delete process.env['PATH'];
        process.env['Path'] = 'C:\\Windows\\System32';

        await hookRunner.executeHook(
          {
            type: HookType.Command,
            command: 'status.sh',
            shell: 'bash',
          },
          HookEventName.PreToolUse,
          mockInput,
        );

        expect(mockWrapPosixShellCommand).toHaveBeenCalledWith(
          'bash status.sh',
          '/opt/tools/shell logger',
        );
        const [, , options] = vi.mocked(spawn).mock.calls[0];
        expect(options?.env).toEqual(
          expect.objectContaining({
            Path: 'C:\\Program Files\\Git\\bin;C:\\Windows\\System32',
          }),
        );
      } finally {
        platformSpy.mockRestore();
        if (originalPath === undefined) delete process.env['PATH'];
        else process.env['PATH'] = originalPath;
        if (originalMixedCasePath === undefined) delete process.env['Path'];
        else process.env['Path'] = originalMixedCasePath;
      }
    });

    it.each([false, true])(
      'keeps the hook PATH override when inherited Path uses different casing (dynamic=%s)',
      async (dynamic) => {
        const platformSpy = vi
          .spyOn(process, 'platform', 'get')
          .mockReturnValue('win32');
        const originalPath = process.env['PATH'];
        const originalMixedCasePath = process.env['Path'];

        try {
          delete process.env['PATH'];
          process.env['Path'] = 'C:\\Windows\\System32';

          await hookRunner.executeHook(
            {
              type: HookType.Command,
              command: 'status.sh',
              shell: 'bash',
              env: dynamic
                ? () => ({ PATH: 'D:\\Hook\\bin' })
                : { PATH: 'D:\\Hook\\bin' },
              ...(dynamic
                ? { source: ConfigSource.System, builtinPlugin: true }
                : {}),
            },
            HookEventName.PreToolUse,
            mockInput,
          );

          const [, , options] = vi.mocked(spawn).mock.calls[0];
          const pathKeys = Object.keys(options?.env ?? {}).filter(
            (key) => key.toUpperCase() === 'PATH',
          );
          expect(pathKeys).toEqual(['PATH']);
          expect(options?.env?.['PATH']).toBe(
            'C:\\Program Files\\Git\\bin;D:\\Hook\\bin',
          );
        } finally {
          platformSpy.mockRestore();
          if (originalPath === undefined) delete process.env['PATH'];
          else process.env['PATH'] = originalPath;
          if (originalMixedCasePath === undefined) delete process.env['Path'];
          else process.env['Path'] = originalMixedCasePath;
        }
      },
    );
  });

  it('keeps Windows Bash .sh normalization and PATH setup without a shell prefix', async () => {
    mockSpawn.mockProcessOn.mockImplementation(
      (event: string, callback: (code: number) => void) => {
        if (event === 'exit') {
          setImmediate(() => callback(0));
        }
      },
    );
    const platformSpy = vi
      .spyOn(process, 'platform', 'get')
      .mockReturnValue('win32');
    const originalPath = process.env['PATH'];
    const originalMixedCasePath = process.env['Path'];

    try {
      delete process.env['PATH'];
      process.env['Path'] = 'C:\\Windows\\System32';

      await hookRunner.executeHook(
        {
          type: HookType.Command,
          command: 'status.sh --compact',
          shell: 'bash',
        },
        HookEventName.PreToolUse,
        mockInput,
      );

      expect(mockResolveShellPrefix).toHaveBeenCalledOnce();
      expect(mockWrapPosixShellCommand).not.toHaveBeenCalled();
      const [, args, options] = vi.mocked(spawn).mock.calls[0];
      expect(args.at(-1)).toBe('bash status.sh --compact');
      expect(options?.env?.['Path']).toBe(
        'C:\\Program Files\\Git\\bin;C:\\Windows\\System32',
      );
    } finally {
      platformSpy.mockRestore();
      if (originalPath === undefined) delete process.env['PATH'];
      else process.env['PATH'] = originalPath;
      if (originalMixedCasePath === undefined) delete process.env['Path'];
      else process.env['Path'] = originalMixedCasePath;
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('executeHook', () => {
    describe('security checks', () => {
      it('should block project hooks in untrusted folders', async () => {
        vi.mocked(mockConfig.isTrustedFolder).mockReturnValue(false);

        const projectHookConfig: HookConfig = {
          type: HookType.Command,
          command: './hooks/test.sh',
          source: ConfigSource.Project,
        };

        const result = await hookRunner.executeHook(
          projectHookConfig,
          HookEventName.PreToolUse,
          mockInput,
        );

        expect(result.success).toBe(false);
        expect(result.error?.message).toContain(
          'Security: Blocked execution of hook (project) in untrusted folder',
        );
        expect(mockRunLogger.warn).toHaveBeenCalledWith(
          expect.stringContaining('Security: Blocked execution'),
        );
        expect(spawn).not.toHaveBeenCalled();
      });

      it('should allow project hooks in trusted folders', async () => {
        vi.mocked(mockConfig.isTrustedFolder).mockReturnValue(true);

        const projectHookConfig: HookConfig = {
          type: HookType.Command,
          command: './hooks/test.sh',
          source: ConfigSource.Project,
        };

        // Mock successful execution
        mockSpawn.mockProcessOn.mockImplementation(
          (event: string, callback: (code: number) => void) => {
            if (event === 'exit') {
              setTimeout(() => callback(0), 10);
            }
          },
        );

        const result = await hookRunner.executeHook(
          projectHookConfig,
          HookEventName.PreToolUse,
          mockInput,
        );

        expect(result.success).toBe(true);
        expect(spawn).toHaveBeenCalled();
      });

      it('should block non-project hooks in untrusted interactive sessions', async () => {
        vi.mocked(mockConfig.isTrustedFolder).mockReturnValue(false);
        vi.mocked(mockConfig.isInteractive).mockReturnValue(true);

        const systemHookConfig: HookConfig = {
          type: HookType.Command,
          command: './hooks/test.sh',
          source: ConfigSource.System,
        };

        const result = await hookRunner.executeHook(
          systemHookConfig,
          HookEventName.PreToolUse,
          mockInput,
        );

        expect(result.success).toBe(false);
        expect(result.error?.message).toContain(
          'Security: Blocked execution of hook (system) in untrusted folder',
        );
        expect(spawn).not.toHaveBeenCalled();
      });

      it('should allow user hooks in untrusted non-interactive sessions (headless implicit trust)', async () => {
        vi.mocked(mockConfig.isTrustedFolder).mockReturnValue(false);
        vi.mocked(mockConfig.isInteractive).mockReturnValue(false);

        const userHookConfig: HookConfig = {
          type: HookType.Command,
          command: './hooks/test.sh',
          source: ConfigSource.User,
        };

        mockSpawn.mockProcessOn.mockImplementation(
          (event: string, callback: (code: number) => void) => {
            if (event === 'exit') {
              setTimeout(() => callback(0), 10);
            }
          },
        );

        const result = await hookRunner.executeHook(
          userHookConfig,
          HookEventName.PreToolUse,
          mockInput,
        );

        expect(result.success).toBe(true);
        expect(spawn).toHaveBeenCalled();
      });
    });

    describe('command hooks', () => {
      const commandConfig: HookConfig = {
        type: HookType.Command,
        command: './hooks/test.sh',
        timeout: 5,
      };

      it('should execute command hook successfully', async () => {
        const mockOutput = {
          decision: 'approve',
          reason: 'All good',
        };

        // Mock successful execution
        mockSpawn.mockStdoutOn.mockImplementation(
          (event: string, callback: (data: Buffer) => void) => {
            if (event === 'data') {
              setImmediate(() =>
                callback(Buffer.from(JSON.stringify(mockOutput))),
              );
            }
          },
        );

        mockSpawn.mockProcessOn.mockImplementation(
          (event: string, callback: (code: number) => void) => {
            if (event === 'exit') {
              setImmediate(() => callback(0));
            }
          },
        );

        const result = await hookRunner.executeHook(
          commandConfig,
          HookEventName.PreToolUse,
          mockInput,
        );

        expect(result.success).toBe(true);
        // External 'approve' is mapped to internal 'allow'
        expect(result.output).toEqual({
          decision: 'allow',
          reason: 'All good',
          hookName: './hooks/test.sh',
          hookCommand: './hooks/test.sh',
        });
        expect(result.exitCode).toBe(0);
        expect(mockSpawn.stdin.write).toHaveBeenCalledWith(
          JSON.stringify(mockInput),
        );
      });

      it('should handle command hook failure', async () => {
        const errorMessage = 'Command failed';

        mockSpawn.mockStderrOn.mockImplementation(
          (event: string, callback: (data: Buffer) => void) => {
            if (event === 'data') {
              setImmediate(() => callback(Buffer.from(errorMessage)));
            }
          },
        );

        mockSpawn.mockProcessOn.mockImplementation(
          (event: string, callback: (code: number) => void) => {
            if (event === 'exit') {
              setImmediate(() => callback(1));
            }
          },
        );

        const result = await hookRunner.executeHook(
          commandConfig,
          HookEventName.PreToolUse,
          mockInput,
        );

        expect(result.success).toBe(false);
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toBe(errorMessage);
      });

      it('should use hook name in error messages if available', async () => {
        const namedConfig: HookConfig = {
          type: HookType.Command,
          command: './hooks/fail.sh',
          statusMessage: 'my-friendly-hook',
        };

        // Mock error during spawn
        vi.mocked(spawn).mockImplementationOnce(() => {
          throw new Error('Spawn error');
        });

        await hookRunner.executeHook(
          namedConfig,
          HookEventName.PreToolUse,
          mockInput,
        );

        expect(mockRunLogger.warn).toHaveBeenCalledWith(
          expect.stringContaining(
            '(hook: my-friendly-hook): Error: Spawn error',
          ),
        );
      });

      it('should handle command hook timeout', async () => {
        const shortTimeoutConfig: HookConfig = {
          type: HookType.Command,
          command: './hooks/slow.sh',
          timeout: 0.05, // Very short timeout for testing
        };

        let closeCallback: ((code: number) => void) | undefined;

        // Mock a hanging process that registers the exit handler but doesn't call it initially
        mockSpawn.mockProcessOn.mockImplementation(
          (event: string, callback: (code: number) => void) => {
            if (event === 'exit') {
              closeCallback = callback; // Store the callback but don't call it yet
            }
          },
        );

        // Simulate the group-kill triggering the child's exit event.
        mockProcessKill.mockImplementation(
          (_pid: number, _signal: string | number) => {
            if (closeCallback) {
              setImmediate(() => {
                closeCallback!(128); // 128 = killed by signal
              });
            }
            return true;
          },
        );

        const result = await hookRunner.executeHook(
          shortTimeoutConfig,
          HookEventName.PreToolUse,
          mockInput,
        );

        expect(result.success).toBe(false);
        expect(mockProcessKill).toHaveBeenCalledWith(-12345, 'SIGKILL');
        expect(result.error?.message).toContain('timed out');
      });

      describe('hard timeout / abort settle (hotfix)', () => {
        it('settles via inner timeout when the child never emits exit', async () => {
          const config: HookConfig = {
            type: HookType.Command,
            command: './hooks/wedged.sh',
            timeout: 0.05,
          };

          // Wedged child: registers exit/error but never fires them.
          mockSpawn.mockProcessOn.mockImplementation(() => {});
          // treeKill does NOT trigger exit (simulates a child that ignores
          // signals or whose reap never delivers an exit event).
          mockProcessKill.mockImplementation(() => true);

          const result = await hookRunner.executeHook(
            config,
            HookEventName.PreToolUse,
            mockInput,
          );

          expect(result.success).toBe(false);
          expect(result.error?.message).toContain('timed out');
          expect(mockProcessKill).toHaveBeenCalledWith(-12345, 'SIGKILL');
        });

        it('ignores a late exit after the timeout already settled', async () => {
          const config: HookConfig = {
            type: HookType.Command,
            command: './hooks/wedged.sh',
            timeout: 0.05,
          };

          let exitCb: ((code: number) => void) | undefined;
          mockSpawn.mockProcessOn.mockImplementation(
            (event: string, cb: (code: number) => void) => {
              if (event === 'exit') exitCb = cb;
            },
          );
          mockProcessKill.mockImplementation(() => true);

          const result = await hookRunner.executeHook(
            config,
            HookEventName.PreToolUse,
            mockInput,
          );
          expect(result.error?.message).toContain('timed out');

          // Late exit must be a no-op (no throw, result already settled).
          expect(() => exitCb?.(0)).not.toThrow();
          expect(result.success).toBe(false);
        });

        it('settles immediately as cancelled on abort and sends SIGTERM', async () => {
          const config: HookConfig = {
            type: HookType.Command,
            command: './hooks/wedged.sh',
          };

          // Wedged child: never exits on its own.
          mockSpawn.mockProcessOn.mockImplementation(() => {});
          mockProcessKill.mockImplementation(() => true);

          const controller = new AbortController();
          const p = hookRunner.executeHook(
            config,
            HookEventName.PreToolUse,
            mockInput,
            controller.signal,
          );
          // Abort synchronously; by the time the promise body runs its
          // signal.aborted check, it will take the onAbort path.
          controller.abort();

          const result = await p;
          expect(result.success).toBe(false);
          expect(result.error?.message).toContain('cancelled');
          expect(mockProcessKill).toHaveBeenCalledWith(-12345, 'SIGTERM');
        });

        it('escalates to SIGKILL after the grace period if not exited', async () => {
          vi.useFakeTimers();
          try {
            const config: HookConfig = {
              type: HookType.Command,
              command: './hooks/wedged.sh',
            };

            mockSpawn.mockProcessOn.mockImplementation(() => {});
            mockProcessKill.mockImplementation(() => true);

            const controller = new AbortController();
            const p = hookRunner.executeHook(
              config,
              HookEventName.PreToolUse,
              mockInput,
              controller.signal,
            );
            controller.abort();

            const result = await p;
            expect(result.error?.message).toContain('cancelled');
            // SIGTERM sent immediately on abort.
            expect(mockProcessKill).toHaveBeenCalledWith(-12345, 'SIGTERM');

            mockProcessKill.mockClear();
            // Child still hasn't exited; grace timer escalates to SIGKILL.
            await vi.advanceTimersByTimeAsync(2000);
            expect(mockProcessKill).toHaveBeenCalledWith(-12345, 'SIGKILL');
          } finally {
            vi.useRealTimers();
          }
        });

        it('signals the process group without forking treeKill on POSIX', async () => {
          const config: HookConfig = {
            type: HookType.Command,
            command: './hooks/wedged.sh',
          };
          mockSpawn.mockProcessOn.mockImplementation(() => {});
          const controller = new AbortController();
          const p = hookRunner.executeHook(
            config,
            HookEventName.PreToolUse,
            mockInput,
            controller.signal,
          );
          controller.abort();
          await p;
          // POSIX teardown must use process.kill(-pid), never fork tree-kill.
          expect(mockProcessKill).toHaveBeenCalledWith(-12345, 'SIGTERM');
          expect(mockTreeKill).not.toHaveBeenCalled();
        });

        it('spawns the hook detached on POSIX so -pid addresses the group', async () => {
          const config: HookConfig = {
            type: HookType.Command,
            command: 'echo hi',
          };
          mockSpawn.mockProcessOn.mockImplementation(
            (event: string, cb: (code: number) => void) => {
              if (event === 'exit') setImmediate(() => cb(0));
            },
          );
          await hookRunner.executeHook(
            config,
            HookEventName.PreToolUse,
            mockInput,
          );
          expect(spawn).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            expect.objectContaining({ detached: true }),
          );
        });

        it('swallows ESRCH from the group kill (no throw, still settles)', async () => {
          const config: HookConfig = {
            type: HookType.Command,
            command: './hooks/wedged.sh',
          };
          mockSpawn.mockProcessOn.mockImplementation(() => {});
          mockProcessKill.mockImplementation(() => {
            const err = new Error('no such process') as NodeJS.ErrnoException;
            err.code = 'ESRCH';
            throw err;
          });
          const controller = new AbortController();
          const p = hookRunner.executeHook(
            config,
            HookEventName.PreToolUse,
            mockInput,
            controller.signal,
          );
          controller.abort();
          const result = await p;
          expect(result.success).toBe(false);
          expect(result.error?.message).toContain('cancelled');
        });

        it('refuses to signal a process group for a non-real pid (<= 1)', async () => {
          const config: HookConfig = {
            type: HookType.Command,
            command: './hooks/wedged.sh',
          };
          // pid 1 ⇒ process.kill(-1, …) would hit every process the user owns.
          (mockSpawn as unknown as { pid: number }).pid = 1;
          mockSpawn.mockProcessOn.mockImplementation(() => {});
          const controller = new AbortController();
          const p = hookRunner.executeHook(
            config,
            HookEventName.PreToolUse,
            mockInput,
            controller.signal,
          );
          controller.abort();
          await p;
          expect(mockProcessKill).not.toHaveBeenCalled();
        });

        it('uses treeKill (not process.kill) on Windows', async () => {
          const platformSpy = vi
            .spyOn(process, 'platform', 'get')
            .mockReturnValue('win32');
          try {
            const config: HookConfig = {
              type: HookType.Command,
              command: './hooks/wedged.sh',
            };
            mockSpawn.mockProcessOn.mockImplementation(() => {});
            const controller = new AbortController();
            const p = hookRunner.executeHook(
              config,
              HookEventName.PreToolUse,
              mockInput,
              controller.signal,
            );
            controller.abort();
            await p;
            expect(mockTreeKill).toHaveBeenCalledWith(
              12345,
              'SIGTERM',
              expect.any(Function),
            );
            expect(mockProcessKill).not.toHaveBeenCalledWith(-12345, 'SIGTERM');
          } finally {
            platformSpy.mockRestore();
          }
        });

        it('does not let one wedged hook block the others in parallel', async () => {
          const wedged: HookConfig = {
            type: HookType.Command,
            command: './hooks/wedged.sh',
            timeout: 0.05,
          };
          const fast: HookConfig = {
            type: HookType.Command,
            command: './hooks/fast.sh',
          };

          // Per-call spawn behavior keyed by command.
          mockProcessKill.mockImplementation(() => true);
          // wedged command gets a never-firing child; others exit 0.
          vi.mocked(spawn).mockImplementation(((
            _exe: string,
            args: string[],
          ) => {
            const isWedged = args.some((a) => a.includes('wedged.sh'));
            const onImpl = vi.fn(
              (event: string, cb: (code: number) => void) => {
                if (event === 'exit' && !isWedged) {
                  setImmediate(() => cb(0));
                }
              },
            );
            return {
              pid: 999,
              stdin: { write: vi.fn(), end: vi.fn(), on: vi.fn() },
              stdout: { on: vi.fn() },
              stderr: { on: vi.fn() },
              on: onImpl,
              kill: vi.fn(),
              killed: false,
            } as unknown as MockChildProcessWithoutNullStreams;
          }) as unknown as typeof spawn);

          const results = await hookRunner.executeHooksParallel(
            [wedged, fast, fast],
            HookEventName.PreToolUse,
            mockInput,
          );

          expect(results).toHaveLength(3);
          // Wedged hook failed via its inner timeout (not outer), others ok.
          expect(results[0].success).toBe(false);
          expect(results[0].error?.message).toContain('timed out');
          expect(results[1].success).toBe(true);
          expect(results[2].success).toBe(true);
        });

        it('outer defensive timeout aborts the inner signal', async () => {
          vi.useFakeTimers();
          try {
            const config: HookConfig = {
              type: HookType.Command,
              command: './hooks/never.sh',
            };

            // Spy executeHook to never settle, capturing the inner signal.
            let innerSignal: AbortSignal | undefined;
            const spy = vi
              .spyOn(hookRunner, 'executeHook')
              .mockImplementation(
                (
                  _config: HookConfig,
                  _event: HookEventName,
                  _input: HookInput,
                  sig?: AbortSignal,
                ) => {
                  innerSignal = sig;
                  return new Promise(() => {}); // never settles
                },
              );

            const resultsPromise = hookRunner.executeHooksParallel(
              [config],
              HookEventName.PreToolUse,
              mockInput,
            );

            // command inner default 600s + 5s slack = 605s.
            await vi.advanceTimersByTimeAsync(605_000);
            const results = await resultsPromise;

            expect(results[0].success).toBe(false);
            expect(results[0].error?.message).toContain('outer timeout');
            expect(innerSignal?.aborted).toBe(true);
            spy.mockRestore();
          } finally {
            vi.useRealTimers();
          }
        });
      });

      it('should expose QWEN_PROJECT_DIR as an env var (not inline-substituted)', async () => {
        const configWithEnvVar: HookConfig = {
          type: HookType.Command,
          command: '$QWEN_PROJECT_DIR/hooks/test.sh',
        };

        mockSpawn.mockProcessOn.mockImplementation(
          (event: string, callback: (code: number) => void) => {
            if (event === 'exit') {
              setImmediate(() => callback(0));
            }
          },
        );

        await hookRunner.executeHook(
          configWithEnvVar,
          HookEventName.PreToolUse,
          mockInput,
        );

        // Command is passed through verbatim; the shell expands the env var.
        expect(spawn).toHaveBeenCalledWith(
          expect.stringMatching(/bash|powershell/),
          expect.arrayContaining([
            expect.stringContaining('$QWEN_PROJECT_DIR/hooks/test.sh'),
          ]),
          expect.objectContaining({
            shell: false,
            env: expect.objectContaining({
              QWEN_PROJECT_DIR: '/test/project',
            }),
          }),
        );
      });

      it('should not allow command injection via QWEN_PROJECT_DIR', async () => {
        const maliciousCwd = '/test/project; echo "pwned" > /tmp/pwned';
        vi.mocked(mockConfig.getProjectRoot).mockReturnValue(maliciousCwd);
        vi.mocked(mockConfig.getSessionArtifactProjectRoot).mockReturnValue(
          maliciousCwd,
        );
        const mockMaliciousInput: HookInput = {
          ...mockInput,
          cwd: maliciousCwd,
        };

        const config: HookConfig = {
          type: HookType.Command,
          command: 'ls $QWEN_PROJECT_DIR',
        };

        // Mock the process closing immediately
        mockSpawn.mockProcessOn.mockImplementation(
          (event: string, callback: (code: number) => void) => {
            if (event === 'exit') {
              setImmediate(() => callback(0));
            }
          },
        );

        await hookRunner.executeHook(
          config,
          HookEventName.PreToolUse,
          mockMaliciousInput,
        );

        // Secure because cwd is never built into the command string — it is
        // only exposed as an env var. The malicious payload must NOT appear in
        // the command arg (the shell expands $QWEN_PROJECT_DIR at runtime, and
        // unquoted expansion does not re-parse metacharacters).
        const spawnCall = vi.mocked(spawn).mock.calls[0];
        const commandArg = (spawnCall[1] as string[]).join(' ');
        expect(commandArg).toContain('ls $QWEN_PROJECT_DIR');
        expect(commandArg).not.toContain('echo "pwned"');
        expect(spawnCall[2]).toEqual(
          expect.objectContaining({
            shell: false,
            env: expect.objectContaining({
              QWEN_PROJECT_DIR: maliciousCwd,
            }),
          }),
        );
      });
    });

    describe('http hooks', () => {
      it('should treat 2xx plain text response as stdout context', async () => {
        const fetchSpy = vi
          .spyOn(globalThis, 'fetch')
          .mockResolvedValue(
            new Response('plain context from hook', { status: 200 }),
          );
        const httpConfig: HookConfig = {
          type: HookType.Http,
          url: 'https://hooks.example.test/hook',
        };

        const result = await hookRunner.executeHook(
          httpConfig,
          HookEventName.PreToolUse,
          mockInput,
        );

        expect(fetchSpy).toHaveBeenCalledWith(
          'https://hooks.example.test/hook',
          expect.objectContaining({
            method: 'POST',
          }),
        );
        expect(result.success).toBe(true);
        expect(result.outputFormat).toBe('text');
        expect(result.output).toEqual({
          decision: 'allow',
          stdoutContent: 'plain context from hook',
          hookName: 'https://hooks.example.test/hook',
          hookCommand: 'https://hooks.example.test/hook',
        });
      });

      it('blocks a URL that does not match allowedHttpHookUrls', async () => {
        vi.mocked(mockConfig.getAllowedHttpHookUrls).mockReturnValue([
          'https://approved.example/*',
        ]);
        const fetchSpy = vi.spyOn(globalThis, 'fetch');

        const result = await hookRunner.executeHook(
          {
            type: HookType.Http,
            url: 'https://hooks.example.test/hook',
          },
          HookEventName.PreToolUse,
          mockInput,
        );

        expect(result.success).toBe(false);
        expect(result.error?.message).toContain('allowedHttpHookUrls');
        expect(fetchSpy).not.toHaveBeenCalled();
      });

      it('allows private-network targets by default', async () => {
        const fetchSpy = vi
          .spyOn(globalThis, 'fetch')
          .mockResolvedValue(new Response('', { status: 200 }));

        const result = await hookRunner.executeHook(
          {
            type: HookType.Http,
            url: 'http://10.0.0.8/hook',
          },
          HookEventName.PreToolUse,
          mockInput,
        );

        expect(result.success).toBe(true);
        expect(fetchSpy).toHaveBeenCalledWith(
          'http://10.0.0.8/hook',
          expect.objectContaining({
            method: 'POST',
          }),
        );
      });

      it('should treat malformed JSON-looking HTTP response as deny for PreToolUse', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
          new Response('{not-json', { status: 200 }),
        );
        const httpConfig: HookConfig = {
          type: HookType.Http,
          url: 'https://hooks.example.test/hook',
        };

        const result = await hookRunner.executeHook(
          httpConfig,
          HookEventName.PreToolUse,
          mockInput,
        );

        // PreToolUse: malformed JSON → fail-closed (deny)
        expect(result.success).toBe(true);
        expect(result.outputFormat).toBe('json');
        expect(result.output?.decision).toBe('deny');
        expect(result.output?.stdoutContent).toBe('{not-json');
      });
    });
  });

  describe('plugin variable expansion', () => {
    beforeEach(() => {
      mockGetPluginDataDir.mockReturnValue('/mock/plugin/data');
      mockSpawn.mockProcessOn.mockImplementation(
        (event: string, callback: (code: number) => void) => {
          if (event === 'exit') {
            setImmediate(() => callback(0));
          }
        },
      );
    });

    const runPluginHook = (config: CommandHookConfig) =>
      hookRunner.executeHook(config, HookEventName.PreToolUse, mockInput);

    it('should pass ${QWEN_PLUGIN_ROOT} to bash via env var, not JS substitution', async () => {
      await runPluginHook({
        type: HookType.Command,
        command: 'node "${QWEN_PLUGIN_ROOT}/bin/hook.js"',
        pluginRoot: '/plugins/my-plugin',
        pluginId: 'my-plugin@local',
      });

      expect(spawn).toHaveBeenCalledWith(
        expect.stringMatching(/bash|powershell/),
        expect.arrayContaining([
          expect.stringContaining('${QWEN_PLUGIN_ROOT}/bin/hook.js'),
        ]),
        expect.objectContaining({
          env: expect.objectContaining({
            QWEN_PLUGIN_ROOT: '/plugins/my-plugin',
          }),
        }),
      );
    });

    it('should keep ${QWEN_PLUGIN_ROOT} literal in unquoted bash template (env passthrough)', async () => {
      await runPluginHook({
        type: HookType.Command,
        command: 'node ${QWEN_PLUGIN_ROOT}/bin/hook.js',
        pluginRoot: "/plugins/it'works",
        pluginId: 'my-plugin@local',
      });

      expect(spawn).toHaveBeenCalledWith(
        expect.stringMatching(/bash|powershell/),
        expect.arrayContaining(['node ${QWEN_PLUGIN_ROOT}/bin/hook.js']),
        expect.objectContaining({
          env: expect.objectContaining({
            QWEN_PLUGIN_ROOT: "/plugins/it'works",
          }),
        }),
      );
    });

    it('should keep ${QWEN_PLUGIN_ROOT} literal inside author double quotes (env passthrough)', async () => {
      await runPluginHook({
        type: HookType.Command,
        command: 'node "${QWEN_PLUGIN_ROOT}/bin/hook.js"',
        pluginRoot: "/plugins/it'works",
        pluginId: 'my-plugin@local',
      });

      expect(spawn).toHaveBeenCalledWith(
        expect.stringMatching(/bash|powershell/),
        expect.arrayContaining(['node "${QWEN_PLUGIN_ROOT}/bin/hook.js"']),
        expect.objectContaining({
          env: expect.objectContaining({
            QWEN_PLUGIN_ROOT: "/plugins/it'works",
          }),
        }),
      );
    });

    it('should pass ${CLAUDE_PLUGIN_ROOT} via env var alias for backward compatibility', async () => {
      await runPluginHook({
        type: HookType.Command,
        command: 'node "${CLAUDE_PLUGIN_ROOT}/bin/hook.js"',
        pluginRoot: '/plugins/my-plugin',
        pluginId: 'my-plugin@local',
      });

      expect(spawn).toHaveBeenCalledWith(
        expect.stringMatching(/bash|powershell/),
        expect.arrayContaining([
          expect.stringContaining('${CLAUDE_PLUGIN_ROOT}/bin/hook.js'),
        ]),
        expect.objectContaining({
          env: expect.objectContaining({
            CLAUDE_PLUGIN_ROOT: '/plugins/my-plugin',
          }),
        }),
      );
    });

    it('should pass ${QWEN_PLUGIN_DATA} via env var (env passthrough)', async () => {
      mockGetPluginDataDir.mockReturnValue('/data/my-plugin');

      await runPluginHook({
        type: HookType.Command,
        command: 'cat "${QWEN_PLUGIN_DATA}/state.json"',
        pluginRoot: '/plugins/my-plugin',
        pluginId: 'my-plugin@local',
      });

      expect(spawn).toHaveBeenCalledWith(
        expect.stringMatching(/bash|powershell/),
        expect.arrayContaining([
          expect.stringContaining('${QWEN_PLUGIN_DATA}/state.json'),
        ]),
        expect.objectContaining({
          env: expect.objectContaining({
            QWEN_PLUGIN_DATA: '/data/my-plugin',
          }),
        }),
      );
    });

    it('should keep ${QWEN_PLUGIN_DATA} literal in unquoted bash template (env passthrough)', async () => {
      mockGetPluginDataDir.mockReturnValue("/data/it'works");

      await runPluginHook({
        type: HookType.Command,
        command: 'cat ${QWEN_PLUGIN_DATA}/state.json',
        pluginRoot: '/plugins/my-plugin',
        pluginId: 'my-plugin@local',
      });

      expect(spawn).toHaveBeenCalledWith(
        expect.stringMatching(/bash|powershell/),
        expect.arrayContaining(['cat ${QWEN_PLUGIN_DATA}/state.json']),
        expect.objectContaining({
          env: expect.objectContaining({
            QWEN_PLUGIN_DATA: "/data/it'works",
          }),
        }),
      );
    });

    it('should insert plugin paths raw for PowerShell hook commands', async () => {
      await runPluginHook({
        type: HookType.Command,
        shell: 'powershell',
        command: 'Write-Output "${QWEN_PLUGIN_ROOT}"',
        pluginRoot: "C:\\Users\\O'Neil\\plugin",
        pluginId: 'my-plugin@local',
      });

      expect(spawn).toHaveBeenCalledWith(
        expect.stringMatching(/pwsh|powershell/),
        expect.arrayContaining([
          expect.stringContaining(`Write-Output "C:\\Users\\O'Neil\\plugin"`),
        ]),
        expect.anything(),
      );
    });

    it('should inline ${QWEN_PROJECT_DIR} for PowerShell hook commands', async () => {
      await runPluginHook({
        type: HookType.Command,
        shell: 'powershell',
        command: 'Write-Host "${QWEN_PROJECT_DIR}"',
      });

      const spawnCall = vi.mocked(spawn).mock.calls[0];
      const argv = spawnCall[1];
      const commandStr = argv.find((a) => a.includes('Write-Host'));
      expect(commandStr).toBeDefined();
      expect(commandStr).not.toContain('${QWEN_PROJECT_DIR}');
      expect(commandStr).toContain(mockInput.cwd);
    });

    it('should NOT inline ${QWEN_PROJECT_DIR} for bash hook commands (env passthrough)', async () => {
      await runPluginHook({
        type: HookType.Command,
        command: 'echo "${QWEN_PROJECT_DIR}"',
      });

      const spawnCall = vi.mocked(spawn).mock.calls[0];
      const argv = spawnCall[1];
      const commandStr = argv.find((a) => a.includes('echo'));
      expect(commandStr).toBeDefined();
      expect(commandStr).toContain('${QWEN_PROJECT_DIR}');
    });

    it('should inject plugin env vars into subprocess', async () => {
      await runPluginHook({
        type: HookType.Command,
        command: 'echo test',
        pluginRoot: '/plugins/my-plugin',
        pluginId: 'my-plugin@local',
      });

      expect(spawn).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({
          env: expect.objectContaining({
            QWEN_PLUGIN_ROOT: '/plugins/my-plugin',
            CLAUDE_PLUGIN_ROOT: '/plugins/my-plugin',
            QWEN_PLUGIN_DATA: '/mock/plugin/data',
            CLAUDE_PLUGIN_DATA: '/mock/plugin/data',
          }),
        }),
      );
    });

    it('preserves static hook env while stripping credential values', async () => {
      await runPluginHook({
        type: HookType.Command,
        command: 'echo test',
        env: {
          HOOK_SETTING: 'static-value',
          [TOKEN_ENV]: 'static-token',
          [TOKEN_ENV.toLowerCase()]: 'mixed-case-token',
        },
      });

      const env = vi.mocked(spawn).mock.calls[0][2].env;
      expect(env?.['HOOK_SETTING']).toBe('static-value');
      expect(env?.[TOKEN_ENV]).toBeUndefined();
      expect(env?.[TOKEN_ENV.toLowerCase()]).toBeUndefined();
    });

    it('resolves the complete builtin hook env on every execution', async () => {
      let token = 'first-token';
      let hookEnvValue = 'first-value';
      const env = vi.fn(() => ({
        HOOK_SETTING: 'static-value',
        [TOKEN_ENV]: token,
        [ENV_UNDER_TEST]: hookEnvValue,
      }));
      const config: CommandHookConfig = {
        type: HookType.Command,
        command: 'echo test',
        source: ConfigSource.System,
        builtinPlugin: true,
        env,
      };
      await runPluginHook(config);
      const firstEnv = vi.mocked(spawn).mock.calls[0][2].env;
      expect(firstEnv).toEqual(
        expect.objectContaining({
          HOOK_SETTING: 'static-value',
          [TOKEN_ENV]: 'first-token',
          [ENV_UNDER_TEST]: 'first-value',
        }),
      );

      token = 'rotated-token';
      hookEnvValue = 'second-value';
      await runPluginHook(config);
      const secondEnv = vi.mocked(spawn).mock.calls[1][2].env;
      expect(secondEnv).toEqual(
        expect.objectContaining({
          HOOK_SETTING: 'static-value',
          [TOKEN_ENV]: 'rotated-token',
          [ENV_UNDER_TEST]: 'second-value',
        }),
      );
      expect(env.mock.calls).toEqual([[], []]);
      expect(config.env).toBe(env);
    });

    it.each([
      {
        name: 'the host builtin marker is missing',
        source: ConfigSource.System,
      },
      {
        name: 'the source is not System',
        source: ConfigSource.Plugins,
        builtinPlugin: true,
      },
    ])(
      'does not call an env function when $name',
      async ({ source, builtinPlugin }) => {
        const env = vi.fn(() => ({ [TOKEN_ENV]: 'resolved-token' }));
        await runPluginHook({
          type: HookType.Command,
          command: 'echo test',
          source,
          builtinPlugin,
          env,
        });
        expect(env).not.toHaveBeenCalled();
        expect(
          vi.mocked(spawn).mock.calls[0][2].env?.[TOKEN_ENV],
        ).toBeUndefined();
      },
    );

    it('replaces and unsets explicit env keys without clearing omitted variables', async () => {
      vi.stubEnv(TOKEN_ENV, 'inherited-token');
      vi.stubEnv(TOKEN_ENV.toLowerCase(), 'mixed-case-token');
      vi.stubEnv(ENV_UNDER_TEST, 'inherited-value');
      vi.stubEnv(ENV_UNDER_TEST.toLowerCase(), 'mixed-case-value');
      vi.stubEnv('HOOK_KEEP', 'inherited-value');
      mockConfig.sanitizationConfig.enableEnvironmentVariableRedaction = false;
      try {
        const config: CommandHookConfig = {
          type: HookType.Command,
          command: 'echo test',
          source: ConfigSource.System,
          builtinPlugin: true,
          env: () => ({ HOOK_SETTING: 'value' }),
        };
        await runPluginHook(config);
        const firstEnv = vi.mocked(spawn).mock.calls[0][2].env;
        expect(firstEnv?.[ENV_UNDER_TEST]).toBe('inherited-value');
        expect(firstEnv?.[TOKEN_ENV]).toBeUndefined();
        expect(firstEnv?.[TOKEN_ENV.toLowerCase()]).toBeUndefined();

        config.env = () => ({ [ENV_UNDER_TEST]: 'current-value' });
        await runPluginHook(config);
        const secondEnv = vi.mocked(spawn).mock.calls[1][2].env;
        expect(secondEnv?.[ENV_UNDER_TEST]).toBe('current-value');
        expect(secondEnv?.[ENV_UNDER_TEST.toLowerCase()]).toBeUndefined();

        config.env = () => ({
          [ENV_UNDER_TEST]: undefined,
          HOOK_SETTING: '',
        });
        await runPluginHook(config);
        const thirdEnv = vi.mocked(spawn).mock.calls[2][2].env;
        expect(thirdEnv).not.toHaveProperty(ENV_UNDER_TEST);
        expect(thirdEnv).not.toHaveProperty(ENV_UNDER_TEST.toLowerCase());
        expect(thirdEnv?.['HOOK_SETTING']).toBe('');
        expect(thirdEnv?.['HOOK_KEEP']).toBe('inherited-value');
        expect(process.env[ENV_UNDER_TEST]).toBe('inherited-value');
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it('continues without hook overrides when its env function throws', async () => {
      const result = await runPluginHook({
        type: HookType.Command,
        command: 'echo test',
        source: ConfigSource.System,
        builtinPlugin: true,
        env: () => {
          throw new Error('env unavailable');
        },
      });
      expect(result.success).toBe(true);
      expect(
        vi.mocked(spawn).mock.calls[0][2].env?.[TOKEN_ENV],
      ).toBeUndefined();
      expect(mockRunLogger.warn).toHaveBeenCalledWith(
        '[hooks] env function failed; continuing without its values:',
        expect.any(Error),
      );
    });

    it('should pass the managed custom-rules file to security scan hooks', async () => {
      const name = ENV_SECURITY_SCAN_RULES_FILE;
      const inherited = process.env[name];
      process.env[name] =
        '/home/user/.qwen/enterprise/org/user/security-scan-rules.json';
      try {
        await runPluginHook({
          type: HookType.Command,
          command: 'echo test',
          pluginRoot: '/plugins/demo-security',
          pluginId: 'security-scan',
          source: ConfigSource.System,
        });

        const opts = vi.mocked(spawn).mock.calls[0][2];
        expect(opts.env).toEqual(
          expect.objectContaining({
            [name]:
              '/home/user/.qwen/enterprise/org/user/security-scan-rules.json',
          }),
        );
      } finally {
        if (inherited === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = inherited;
        }
      }
    });

    it("should not JS-substitute placeholders under bash when pluginRoot contains a single quote (li'fei regression)", async () => {
      await runPluginHook({
        type: HookType.Command,
        command: '${QWEN_PLUGIN_ROOT}/x.exe',
        pluginRoot: "C:/Users/li'fei/plugin",
        pluginId: 'my-plugin@local',
      });

      const spawnCall = vi.mocked(spawn).mock.calls[0];
      const argv = spawnCall[1];
      const commandStr = argv.find((a) => a.includes('${QWEN_PLUGIN_ROOT}'));
      expect(commandStr).toBeDefined();
      expect(commandStr).not.toContain("li'fei");
      expect(spawnCall[2]).toEqual(
        expect.objectContaining({
          env: expect.objectContaining({
            QWEN_PLUGIN_ROOT: "C:/Users/li'fei/plugin",
          }),
        }),
      );
    });

    it('should inject CLAUDE_PROJECT_DIR env alias alongside QWEN_PROJECT_DIR', async () => {
      await runPluginHook({
        type: HookType.Command,
        command: 'echo test',
        pluginRoot: '/plugins/my-plugin',
        pluginId: 'my-plugin@local',
      });

      const spawnCall = vi.mocked(spawn).mock.calls[0];
      const opts = spawnCall[2] as { env: Record<string, string> };
      expect(opts.env['CLAUDE_PROJECT_DIR']).toBeDefined();
      expect(opts.env['CLAUDE_PROJECT_DIR']).toBe(
        opts.env['QWEN_PROJECT_DIR'],
      );
    });
  });

  describe('exec form', () => {
    beforeEach(() => {
      mockSpawn.mockProcessOn.mockImplementation(
        (event: string, callback: (code: number) => void) => {
          if (event === 'exit') {
            setImmediate(() => callback(0));
          }
        },
      );
    });

    it('should spawn command and args directly without shell when args is provided', async () => {
      await hookRunner.executeHook(
        {
          type: HookType.Command,
          command: '/bin/echo',
          args: ['a b', "li'fei", 'plain'],
        },
        HookEventName.PreToolUse,
        mockInput,
      );

      expect(spawn).toHaveBeenCalledWith(
        '/bin/echo',
        ['a b', "li'fei", 'plain'],
        expect.objectContaining({ shell: false }),
      );
    });

    it('should expand placeholders in args using native paths', async () => {
      mockGetPluginDataDir.mockReturnValueOnce('C:\\data\\foo');

      await hookRunner.executeHook(
        {
          type: HookType.Command,
          command: '${QWEN_PLUGIN_ROOT}/foo',
          args: ['${QWEN_PROJECT_DIR}', '${CLAUDE_PLUGIN_DATA}/x.json'],
          pluginRoot: 'C:\\plugins\\foo',
          pluginId: 'foo@local',
        },
        HookEventName.PreToolUse,
        mockInput,
      );

      const [executable, args] = vi.mocked(spawn).mock.calls[0];
      expect(executable).toBe('C:\\plugins\\foo/foo');
      expect(args).toEqual([mockInput.cwd, 'C:\\data\\foo/x.json']);
    });

    it('should ignore shell field when args is provided (exec form short-circuits)', async () => {
      await hookRunner.executeHook(
        {
          type: HookType.Command,
          command: '/bin/echo',
          shell: 'powershell',
          args: ['hi'],
        },
        HookEventName.PreToolUse,
        mockInput,
      );

      const [executable, , opts] = vi.mocked(spawn).mock.calls[0];
      expect(executable).toBe('/bin/echo');
      expect(opts).toMatchObject({ shell: false });
    });

    it('should warn when command has whitespace but no path separator in exec form', async () => {
      await hookRunner.executeHook(
        {
          type: HookType.Command,
          command: 'node script.js',
          args: [],
        },
        HookEventName.PreToolUse,
        mockInput,
      );

      expect(mockRunLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('has both "args" and whitespace'),
      );
    });

    it('should not warn when command is a path containing whitespace', async () => {
      await hookRunner.executeHook(
        {
          type: HookType.Command,
          command: '/usr/local/bin/foo bar',
          args: [],
        },
        HookEventName.PreToolUse,
        mockInput,
      );

      expect(mockRunLogger.warn).not.toHaveBeenCalledWith(
        expect.stringContaining('has both "args" and whitespace'),
      );
    });
  });

  describe('plugin preflight', () => {
    it('should fail non-blocking when placeholder appears in non-plugin hook', async () => {
      const result = await hookRunner.executeHook(
        {
          type: HookType.Command,
          command: '${QWEN_PLUGIN_ROOT}/foo',
        },
        HookEventName.PreToolUse,
        mockInput,
      );

      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('not associated with a plugin');
      expect(result.error).toBeInstanceOf(Error);
      expect(spawn).not.toHaveBeenCalled();
    });

    it('should fail non-blocking when plugin directory is missing (orphan GC race)', async () => {
      mockFsStat.mockRejectedValueOnce(
        Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
      );

      const result = await hookRunner.executeHook(
        {
          type: HookType.Command,
          command: 'python3 ${QWEN_PLUGIN_ROOT}/missing.py',
          pluginRoot: '/plugins/my-plugin',
          pluginId: 'my-plugin@local',
        },
        HookEventName.PreToolUse,
        mockInput,
      );

      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Plugin directory does not exist');
      expect(result.stderr).toContain('/plugins/my-plugin');
      expect(result.stderr).toContain('run /plugin to reinstall');
      expect(spawn).not.toHaveBeenCalled();
      // Preflight runs before getPluginDataDir (which would mkdirSync).
      expect(mockGetPluginDataDir).not.toHaveBeenCalled();
    });

    it('should fail non-blocking when pluginRoot exists but is not a directory', async () => {
      mockFsStat.mockResolvedValueOnce({ isDirectory: () => false });

      const result = await hookRunner.executeHook(
        {
          type: HookType.Command,
          command: '${QWEN_PLUGIN_ROOT}/foo',
          pluginRoot: '/plugins/my-plugin',
          pluginId: 'my-plugin@local',
        },
        HookEventName.PreToolUse,
        mockInput,
      );

      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Plugin directory does not exist');
    });

    it('should allow normal plugin hooks past preflight', async () => {
      mockSpawn.mockProcessOn.mockImplementation(
        (event: string, callback: (code: number) => void) => {
          if (event === 'exit') {
            setImmediate(() => callback(0));
          }
        },
      );

      const result = await hookRunner.executeHook(
        {
          type: HookType.Command,
          command: 'echo "${QWEN_PLUGIN_ROOT}"',
          pluginRoot: '/plugins/my-plugin',
          pluginId: 'my-plugin@local',
        },
        HookEventName.PreToolUse,
        mockInput,
      );

      expect(result.success).toBe(true);
      expect(spawn).toHaveBeenCalled();
    });
  });

  describe('executeHooksParallel', () => {
    it('should execute multiple hooks in parallel', async () => {
      const configs: HookConfig[] = [
        { type: HookType.Command, command: './hook1.sh' },
        { type: HookType.Command, command: './hook2.sh' },
      ];

      // Mock both commands to succeed
      mockSpawn.mockProcessOn.mockImplementation(
        (event: string, callback: (code: number) => void) => {
          if (event === 'exit') {
            setImmediate(() => callback(0));
          }
        },
      );

      const results = await hookRunner.executeHooksParallel(
        configs,
        HookEventName.PreToolUse,
        mockInput,
      );

      expect(results).toHaveLength(2);
      expect(results.every((r) => r.success)).toBe(true);
      expect(spawn).toHaveBeenCalledTimes(2);
    });

    it('should call onHookStart and onHookEnd callbacks', async () => {
      const configs: HookConfig[] = [
        { type: HookType.Command, command: './hook1.sh' },
      ];

      mockSpawn.mockProcessOn.mockImplementation(
        (event: string, callback: (code: number) => void) => {
          if (event === 'exit') {
            setImmediate(() => callback(0));
          }
        },
      );

      const onStart = vi.fn();
      const onEnd = vi.fn();

      await hookRunner.executeHooksParallel(
        configs,
        HookEventName.PreToolUse,
        mockInput,
        onStart,
        onEnd,
      );

      expect(onStart).toHaveBeenCalledWith(configs[0], 0);
      expect(onEnd).toHaveBeenCalledWith(
        configs[0],
        expect.objectContaining({ success: true }),
        0,
      );
    });

    it('should handle mixed success and failure', async () => {
      const configs: HookConfig[] = [
        { type: HookType.Command, command: './hook1.sh' },
        { type: HookType.Command, command: './hook2.sh' },
      ];

      let callCount = 0;
      mockSpawn.mockProcessOn.mockImplementation(
        (event: string, callback: (code: number) => void) => {
          if (event === 'exit') {
            const exitCode = callCount++ === 0 ? 0 : 1; // First succeeds, second fails
            setImmediate(() => callback(exitCode));
          }
        },
      );

      const results = await hookRunner.executeHooksParallel(
        configs,
        HookEventName.PreToolUse,
        mockInput,
      );

      expect(results).toHaveLength(2);
      expect(results[0].success).toBe(true);
      expect(results[1].success).toBe(false);
    });

    it('runs only explicitly opted-in completed writes after cancellation', async () => {
      const action = vi.fn(async (_input, options) => {
        expect(options?.signal.aborted).toBe(false);
      });
      const configs: HookConfig[] = [
        {
          type: HookType.Runtime,
          name: 'completed-write',
          action,
          runAfterCancellation: 'completed-file-write',
        },
        {
          type: HookType.Runtime,
          name: 'internal-only',
          internal: true,
          action: vi.fn(async () => undefined),
        },
      ];
      const controller = new AbortController();
      controller.abort();
      const input = {
        ...mockInput,
        hook_event_name: HookEventName.PostToolUse,
        tool_use_id: 'tool-1',
        tool_name: 'Write',
        tool_input: {},
        tool_response: {},
        file_write: {
          file_path: '/repo/file.ts',
          workspace_path: '/repo',
          original_content: '',
          proposed_content: 'after',
          written_content: 'after',
        },
      } as HookInput;

      const results = await hookRunner.executeHooksParallel(
        configs,
        HookEventName.PostToolUse,
        input,
        undefined,
        undefined,
        controller.signal,
      );

      expect(results.map((result) => result.success)).toEqual([true, false]);
      expect(action).toHaveBeenCalledOnce();
    });

    it('surfaces the real reason when the parent signal aborts for a non-user cause', async () => {
      const configs: HookConfig[] = [
        {
          type: HookType.Runtime,
          name: 'sdk-post',
          action: vi.fn(async () => undefined),
        },
      ];
      const controller = new AbortController();
      // Mirrors the headless output frame guard tripping on an oversized payload.
      controller.abort(
        new Error('SDK JSONL output exceeded the 16777216-byte frame limit'),
      );

      const results = await hookRunner.executeHooksParallel(
        configs,
        HookEventName.PostToolUse,
        {
          ...mockInput,
          hook_event_name: HookEventName.PostToolUse,
          tool_use_id: 'tool-1',
          tool_name: 'Edit',
          tool_input: {},
          tool_response: {},
        } as HookInput,
        undefined,
        undefined,
        controller.signal,
      );

      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(false);
      expect(results[0].error?.message).toBe(
        'Hook aborted: SDK JSONL output exceeded the 16777216-byte frame limit',
      );
      expect(results[0].error?.message).not.toContain('cancelled by user');
    });

    it('keeps the user-cancellation wording when the parent signal aborts without a system reason', async () => {
      const configs: HookConfig[] = [
        {
          type: HookType.Runtime,
          name: 'sdk-post',
          action: vi.fn(async () => undefined),
        },
      ];
      const controller = new AbortController();
      controller.abort();

      const results = await hookRunner.executeHooksParallel(
        configs,
        HookEventName.PostToolUse,
        {
          ...mockInput,
          hook_event_name: HookEventName.PostToolUse,
          tool_use_id: 'tool-1',
          tool_name: 'Edit',
          tool_input: {},
          tool_response: {},
        } as HookInput,
        undefined,
        undefined,
        controller.signal,
      );

      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(false);
      expect(results[0].error?.message).toBe('Hook cancelled by user');
    });
  });

  describe('executeHooksSequential', () => {
    it('should execute multiple hooks in sequence', async () => {
      const configs: HookConfig[] = [
        { type: HookType.Command, command: './hook1.sh' },
        { type: HookType.Command, command: './hook2.sh' },
      ];

      const executionOrder: string[] = [];

      // Mock both commands to succeed
      mockSpawn.mockProcessOn.mockImplementation(
        (event: string, callback: (code: number) => void) => {
          if (event === 'exit') {
            const args = vi.mocked(spawn).mock.calls[
              executionOrder.length
            ][1] as string[];
            let command = args[args.length - 1];
            // On Windows, the command is wrapped in PowerShell syntax
            if (command.includes('; if ($LASTEXITCODE -ne 0)')) {
              command = command.split(';')[0];
            }
            executionOrder.push(command);
            setImmediate(() => callback(0));
          }
        },
      );

      const results = await hookRunner.executeHooksSequential(
        configs,
        HookEventName.PreToolUse,
        mockInput,
      );

      expect(results).toHaveLength(2);
      expect(results.every((r) => r.success)).toBe(true);
      expect(spawn).toHaveBeenCalledTimes(2);
      // Verify they were called sequentially
      expect(executionOrder).toEqual(['./hook1.sh', './hook2.sh']);
    });

    it('preserves non-enumerable Runtime-only input after preceding output', async () => {
      const fileWrite = {
        file_path: '/workspace/file.ts',
        workspace_path: '/workspace',
        original_content: 'before',
        proposed_content: 'proposal',
        written_content: 'actual',
      };
      const input = { ...mockInput };
      Object.defineProperty(input, 'file_write', {
        value: fileWrite,
        enumerable: false,
      });
      let secondInput: HookInput | undefined;
      const configs: HookConfig[] = [
        {
          type: HookType.Runtime,
          name: 'first-runtime',
          action: async () => ({ systemMessage: 'first completed' }),
        },
        {
          type: HookType.Runtime,
          name: 'second-runtime',
          action: async (received) => {
            secondInput = received;
          },
        },
      ];

      const results = await hookRunner.executeHooksSequential(
        configs,
        HookEventName.PostToolUse,
        input,
      );

      expect(results.every((result) => result.success)).toBe(true);
      expect(
        (secondInput as unknown as Record<string, unknown>)['file_write'],
      ).toEqual(fileWrite);
      expect(Object.keys(secondInput!)).not.toContain('file_write');
      expect(JSON.stringify(secondInput)).not.toContain('original_content');
    });

    it('runs explicitly opted-in completed writes after cancellation', async () => {
      const action = vi.fn(async (_input, options) => {
        expect(options?.signal.aborted).toBe(false);
      });
      const configs: HookConfig[] = [
        {
          type: HookType.Runtime,
          name: 'completed-write',
          action,
          runAfterCancellation: 'completed-file-write',
        },
      ];
      const controller = new AbortController();
      controller.abort();
      const input = {
        ...mockInput,
        hook_event_name: HookEventName.PostToolUse,
        tool_use_id: 'tool-1',
        tool_name: 'Write',
        tool_input: {},
        tool_response: {},
        file_write: {
          file_path: '/repo/file.ts',
          workspace_path: '/repo',
          original_content: '',
          proposed_content: 'after',
          written_content: 'after',
        },
      } as HookInput;

      const results = await hookRunner.executeHooksSequential(
        configs,
        HookEventName.PostToolUse,
        input,
        undefined,
        undefined,
        controller.signal,
      );

      expect(results[0]?.success).toBe(true);
      expect(action).toHaveBeenCalledOnce();
    });

    it('should call onHookStart and onHookEnd callbacks sequentially', async () => {
      const configs: HookConfig[] = [
        { type: HookType.Command, command: './hook1.sh' },
        { type: HookType.Command, command: './hook2.sh' },
      ];

      mockSpawn.mockProcessOn.mockImplementation(
        (event: string, callback: (code: number) => void) => {
          if (event === 'exit') {
            setImmediate(() => callback(0));
          }
        },
      );

      const onStart = vi.fn();
      const onEnd = vi.fn();

      await hookRunner.executeHooksSequential(
        configs,
        HookEventName.PreToolUse,
        mockInput,
        onStart,
        onEnd,
      );

      expect(onStart).toHaveBeenCalledTimes(2);
      expect(onEnd).toHaveBeenCalledTimes(2);
      expect(onStart).toHaveBeenNthCalledWith(1, configs[0], 0);
      expect(onStart).toHaveBeenNthCalledWith(2, configs[1], 1);
      expect(onEnd).toHaveBeenNthCalledWith(
        1,
        configs[0],
        expect.anything(),
        0,
      );
      expect(onEnd).toHaveBeenNthCalledWith(
        2,
        configs[1],
        expect.anything(),
        1,
      );
    });

    it('should continue execution even if a hook fails', async () => {
      const configs: HookConfig[] = [
        { type: HookType.Command, command: './hook1.sh' },
        { type: HookType.Command, command: './hook2.sh' },
        { type: HookType.Command, command: './hook3.sh' },
      ];

      let callCount = 0;
      mockSpawn.mockStderrOn.mockImplementation(
        (event: string, callback: (data: Buffer) => void) => {
          if (event === 'data' && callCount === 1) {
            // Second hook fails
            setImmediate(() => callback(Buffer.from('Hook 2 failed')));
          }
        },
      );

      mockSpawn.mockProcessOn.mockImplementation(
        (event: string, callback: (code: number) => void) => {
          if (event === 'exit') {
            const exitCode = callCount++ === 1 ? 1 : 0; // Second fails, others succeed
            setImmediate(() => callback(exitCode));
          }
        },
      );

      const results = await hookRunner.executeHooksSequential(
        configs,
        HookEventName.PreToolUse,
        mockInput,
      );

      expect(results).toHaveLength(3);
      expect(results[0].success).toBe(true);
      expect(results[1].success).toBe(false);
      expect(results[2].success).toBe(true);
      expect(spawn).toHaveBeenCalledTimes(3);
    });

    it('should pass unmodified input from one hook to the next for SubagentStart', async () => {
      const configs: HookConfig[] = [
        { type: HookType.Command, command: './hook1.sh' },
        { type: HookType.Command, command: './hook2.sh' },
      ];

      const mockSubagentStartInput = {
        ...mockInput,
        agent_id: 'abc123',
        agent_type: 'code-review',
      };

      const mockOutput1 = {
        decision: 'approve' as const,
        hookSpecificOutput: {
          hookEventName: 'SubagentStart' as const,
          additionalContext: 'Context from hook 1',
        },
      };

      let hookCallCount = 0;
      mockSpawn.mockStdoutOn.mockImplementation(
        (event: string, callback: (data: Buffer) => void) => {
          if (event === 'data') {
            if (hookCallCount === 0) {
              setImmediate(() =>
                callback(Buffer.from(JSON.stringify(mockOutput1))),
              );
            }
          }
        },
      );

      mockSpawn.mockProcessOn.mockImplementation(
        (event: string, callback: (code: number) => void) => {
          if (event === 'exit') {
            hookCallCount++;
            setImmediate(() => callback(0));
          }
        },
      );

      const results = await hookRunner.executeHooksSequential(
        configs,
        HookEventName.SubagentStart,
        mockSubagentStartInput,
      );

      expect(results).toHaveLength(2);
      expect(results[0].success).toBe(true);
      // After approve→allow mapping, decision becomes 'allow'
      expect(results[0].output).toEqual({
        decision: 'allow',
        hookSpecificOutput: {
          hookEventName: 'SubagentStart',
          additionalContext: 'Context from hook 1',
        },
        hookName: './hook1.sh',
        hookCommand: './hook1.sh',
      });

      // SubagentStart no longer modifies input (no prompt field to chain)
      // Verify second hook still receives the original agent info
      const secondHookInput = JSON.parse(
        vi.mocked(mockSpawn.stdin.write).mock.calls[1][0],
      );
      expect(secondHookInput.agent_id).toBe('abc123');
      expect(secondHookInput.agent_type).toBe('code-review');
    });

    it('should not modify input if hook fails', async () => {
      const configs: HookConfig[] = [
        { type: HookType.Command, command: './hook1.sh' },
        { type: HookType.Command, command: './hook2.sh' },
      ];

      mockSpawn.mockStderrOn.mockImplementation(
        (event: string, callback: (data: Buffer) => void) => {
          if (event === 'data') {
            setImmediate(() => callback(Buffer.from('Hook failed')));
          }
        },
      );

      mockSpawn.mockProcessOn.mockImplementation(
        (event: string, callback: (code: number) => void) => {
          if (event === 'exit') {
            setImmediate(() => callback(1)); // All hooks fail
          }
        },
      );

      const results = await hookRunner.executeHooksSequential(
        configs,
        HookEventName.PreToolUse,
        mockInput,
      );

      expect(results).toHaveLength(2);
      expect(results.every((r) => !r.success)).toBe(true);

      // Verify that both hooks received the same original input
      const firstHookInput = JSON.parse(
        vi.mocked(mockSpawn.stdin.write).mock.calls[0][0],
      );
      const secondHookInput = JSON.parse(
        vi.mocked(mockSpawn.stdin.write).mock.calls[1][0],
      );
      expect(firstHookInput).toEqual(secondHookInput);
    });
  });

  describe('invalid JSON handling', () => {
    const commandConfig: HookConfig = {
      type: HookType.Command,
      command: './hooks/test.sh',
    };

    it('should handle invalid JSON output gracefully', async () => {
      const invalidJson = '{ "decision": "allow", incomplete';

      mockSpawn.mockStdoutOn.mockImplementation(
        (event: string, callback: (data: Buffer) => void) => {
          if (event === 'data') {
            setImmediate(() => callback(Buffer.from(invalidJson)));
          }
        },
      );

      mockSpawn.mockProcessOn.mockImplementation(
        (event: string, callback: (code: number) => void) => {
          if (event === 'exit') {
            setImmediate(() => callback(0));
          }
        },
      );

      const result = await hookRunner.executeHook(
        commandConfig,
        HookEventName.PreToolUse,
        mockInput,
      );

      expect(result.success).toBe(true);
      expect(result.exitCode).toBe(0);
      // PreToolUse: malformed JSON that starts with '{' → fail-closed (deny)
      expect(result.outputFormat).toBe('json');
      expect(result.output?.decision).toBe('deny');
      expect(result.output?.stdoutContent).toBe(invalidJson);
    });

    it('should handle malformed JSON with exit code 0', async () => {
      const malformedJson = 'not json at all';

      mockSpawn.mockStdoutOn.mockImplementation(
        (event: string, callback: (data: Buffer) => void) => {
          if (event === 'data') {
            setImmediate(() => callback(Buffer.from(malformedJson)));
          }
        },
      );

      mockSpawn.mockProcessOn.mockImplementation(
        (event: string, callback: (code: number) => void) => {
          if (event === 'exit') {
            setImmediate(() => callback(0));
          }
        },
      );

      const result = await hookRunner.executeHook(
        commandConfig,
        HookEventName.PreToolUse,
        mockInput,
      );

      expect(result.success).toBe(true);
      expect(result.outputFormat).toBe('text');
      expect(result.output).toEqual({
        decision: 'allow',
        stdoutContent: malformedJson,
        hookName: './hooks/test.sh',
        hookCommand: './hooks/test.sh',
      });
    });

    it('should handle invalid JSON with exit code 1 (non-blocking error)', async () => {
      const invalidJson = '{ broken json';

      mockSpawn.mockStderrOn.mockImplementation(
        (event: string, callback: (data: Buffer) => void) => {
          if (event === 'data') {
            setImmediate(() => callback(Buffer.from(invalidJson)));
          }
        },
      );

      mockSpawn.mockProcessOn.mockImplementation(
        (event: string, callback: (code: number) => void) => {
          if (event === 'exit') {
            setImmediate(() => callback(1));
          }
        },
      );

      const result = await hookRunner.executeHook(
        commandConfig,
        HookEventName.PreToolUse,
        mockInput,
      );

      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(1);
      // non-blocking error, no output parsed
      expect(result.output).toBeUndefined();
      expect(result.outputFormat).toBeUndefined();
    });

    it('should handle invalid JSON with exit code 2 (blocking error)', async () => {
      const invalidJson = '{ "error": incomplete';

      mockSpawn.mockStderrOn.mockImplementation(
        (event: string, callback: (data: Buffer) => void) => {
          if (event === 'data') {
            setImmediate(() => callback(Buffer.from(invalidJson)));
          }
        },
      );

      mockSpawn.mockProcessOn.mockImplementation(
        (event: string, callback: (code: number) => void) => {
          if (event === 'exit') {
            setImmediate(() => callback(2));
          }
        },
      );

      const result = await hookRunner.executeHook(
        commandConfig,
        HookEventName.PreToolUse,
        mockInput,
      );

      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(2);
      expect(result.outputFormat).toBe('text');
      expect(result.output).toEqual({
        decision: 'deny',
        reason: invalidJson,
        hookName: './hooks/test.sh',
        hookCommand: './hooks/test.sh',
      });
    });

    it('should handle empty JSON output', async () => {
      mockSpawn.mockStdoutOn.mockImplementation(
        (event: string, callback: (data: Buffer) => void) => {
          if (event === 'data') {
            setImmediate(() => callback(Buffer.from('')));
          }
        },
      );

      mockSpawn.mockProcessOn.mockImplementation(
        (event: string, callback: (code: number) => void) => {
          if (event === 'exit') {
            setImmediate(() => callback(0));
          }
        },
      );

      const result = await hookRunner.executeHook(
        commandConfig,
        HookEventName.PreToolUse,
        mockInput,
      );

      expect(result.success).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.output).toBeUndefined();
    });

    it('should handle double-encoded JSON string', async () => {
      const mockOutput = {
        decision: 'approve',
        reason: 'All good',
        format: 'json',
      };
      const doubleEncodedJson = JSON.stringify(JSON.stringify(mockOutput));

      mockSpawn.mockStdoutOn.mockImplementation(
        (event: string, callback: (data: Buffer) => void) => {
          if (event === 'data') {
            setImmediate(() => callback(Buffer.from(doubleEncodedJson)));
          }
        },
      );

      mockSpawn.mockProcessOn.mockImplementation(
        (event: string, callback: (code: number) => void) => {
          if (event === 'exit') {
            setImmediate(() => callback(0));
          }
        },
      );

      const result = await hookRunner.executeHook(
        commandConfig,
        HookEventName.PreToolUse,
        mockInput,
      );

      expect(result.success).toBe(true);
      // After approve→allow mapping, decision becomes 'allow'
      // Note: 'format' is not a schema field so it gets stripped by Zod
      expect(result.output).toEqual({
        decision: 'allow',
        reason: 'All good',
        hookName: './hooks/test.sh',
        hookCommand: './hooks/test.sh',
      });
    });
  });

  describe('stdout schema failure modes', () => {
    const commandConfig: HookConfig = {
      type: HookType.Command,
      command: './hooks/test.sh',
    };

    function setupHookProcess(stdoutChunk: string, exitCode = 0) {
      mockSpawn.mockStdoutOn.mockImplementation(
        (event: string, callback: (data: Buffer) => void) => {
          if (event === 'data') {
            setImmediate(() => callback(Buffer.from(stdoutChunk)));
          }
        },
      );
      mockSpawn.mockProcessOn.mockImplementation(
        (event: string, callback: (code: number) => void) => {
          if (event === 'exit') {
            setImmediate(() => callback(exitCode));
          }
        },
      );
    }

    it('rejects sync schema failure with failureKind="schema" and drops plain-text fallback', async () => {
      setupHookProcess('{"hookSpecificOutput":{"additionalContext":"x"}}', 0);

      // Use SessionStart (not PreToolUse which has its own fail-closed deny path).
      // Default schemaFailureMode is 'strict' for sync paths.
      const result = await hookRunner.executeHook(
        commandConfig,
        HookEventName.SessionStart,
        mockInput,
      );

      expect(result.success).toBe(false);
      expect(result.failureKind).toBe('schema');
      expect(result.outcome).toBe('non_blocking_error');
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        'hookSpecificOutput is missing required field "hookEventName"',
      );
      // Stdout MUST NOT be injected as plain-text context to the model.
      expect(result.output).toBeUndefined();
      expect(result.outputFormat).toBeUndefined();
    });

    it('falls back to plain text on schema failure when schemaFailureMode is "plain-text-fallback" (async path)', async () => {
      const json = '{"hookSpecificOutput":{"additionalContext":"x"}}';
      setupHookProcess(json, 0);

      // Use SessionStart (not PreToolUse which has its own fail-closed deny path).
      const result = await hookRunner.executeHook(
        commandConfig,
        HookEventName.SessionStart,
        mockInput,
        undefined,
        undefined,
        { schemaFailureMode: 'plain-text-fallback' },
      );

      // Async hooks must keep their long-standing pendingAsyncContexts
      // injection contract: schema-failed JSON falls back to plain text.
      expect(result.success).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.failureKind).toBeUndefined();
      expect(result.outputFormat).toBe('text');
      expect(result.output).toEqual({
        decision: 'allow',
        stdoutContent: json,
        hookName: './hooks/test.sh',
        hookCommand: './hooks/test.sh',
      });
    });

    it('still falls back to plain text for non-JSON stdout regardless of schemaFailureMode', async () => {
      setupHookProcess('hello world', 0);

      const result = await hookRunner.executeHook(
        commandConfig,
        HookEventName.PreToolUse,
        mockInput,
      );

      expect(result.success).toBe(true);
      expect(result.outputFormat).toBe('text');
      expect(result.output).toMatchObject({
        decision: 'allow',
        stdoutContent: 'hello world',
      });
    });
  });

  describe('prompt hooks', () => {
    const promptConfig: PromptHookConfig = {
      type: HookType.Prompt,
      prompt: 'Is this command safe to run?',
      statusMessage: 'safety-check',
    };

    const select = vi.fn();
    const inference = vi.fn();
    const model = {
      key: 'gemini-2.0-flash',
      source: 'qwen-provider',
      limits: { maxOutputTokens: 8192 },
    };

    beforeEach(() => {
      select.mockResolvedValue({
        model,
        config: { reasoning: { effort: 'medium' } },
      });
      inference.mockImplementation(async (request) => {
        const output = await mockGenerateJson(request);
        return {
          completed: Promise.resolve({
            blocks: [
              { type: 'thinking', thinking: 'private' },
              {
                type: 'text',
                text:
                  typeof output === 'string' ? output : JSON.stringify(output),
              },
            ],
            stopReason: 'end_turn',
          }),
        };
      });
      Object.assign(mockConfig, {
        getModelProviderManager: () => ({ select, inference }),
      });
    });
    afterEach(() => vi.useRealTimers());

    it('should execute prompt hook successfully with deny decision', async () => {
      mockGenerateJson.mockResolvedValue({
        ok: false,
        reason: 'This command is unsafe',
      });

      vi.mocked(mockConfig.getModel).mockReturnValue('gemini-2.0-flash');

      hookRunner = new HookRunner(mockConfig);

      const result = await hookRunner.executeHook(
        promptConfig,
        HookEventName.PreToolUse,
        mockInput,
      );

      expect(result.success).toBe(true);
      expect(result.output).toEqual({
        decision: 'deny',
        reason: 'This command is unsafe',
      });
      expect(result.outputFormat).toBe('json');
      expect(select).toHaveBeenCalledExactlyOnceWith({
        purpose: 'hook_prompt',
      });
      expect(select.mock.invocationCallOrder[0]).toBeLessThan(
        inference.mock.invocationCallOrder[0],
      );
      expect(inference).toHaveBeenCalledWith(
        expect.objectContaining({
          model,
          messages: [
            {
              role: 'user',
              content: expect.stringContaining(promptConfig.prompt),
            },
          ],
          systemPrompt: expect.stringContaining('hook evaluator'),
          reasoningEffort: 'medium',
          maxTokens: 8192,
          identity: { sessionId: 'test-session', requestSetId: undefined },
          taskRouting: { taskId: undefined, policyTaskId: undefined },
          business: undefined,
        }),
      );
    });

    it('should execute prompt hook successfully with allow decision', async () => {
      mockGenerateJson.mockResolvedValue({
        ok: true,
      });

      vi.mocked(mockConfig.getModel).mockReturnValue('gemini-2.0-flash');

      hookRunner = new HookRunner(mockConfig);

      const result = await hookRunner.executeHook(
        promptConfig,
        HookEventName.PreToolUse,
        mockInput,
      );

      expect(result.success).toBe(true);
      expect(result.output).toEqual({
        decision: 'allow',
      });
    });

    it('preserves SDK routing labels and fallback business across content retries', async () => {
      vi.useFakeTimers();
      mockGenerateJson
        .mockResolvedValueOnce('invalid JSON')
        .mockResolvedValue({ ok: true });
      const getModelPolicy = vi.fn().mockResolvedValue({
        model: 'gemini-2.0-flash',
        labels: { taskId: 'hook-task', subTask: 'pre-tool-use' },
      });
      Object.defineProperty(mockConfig, 'getModelPolicy', {
        configurable: true,
        value: getModelPolicy,
      });

      hookRunner = new HookRunner(mockConfig);
      const pending = hookRunner.executeHook(
        promptConfig,
        HookEventName.PreToolUse,
        mockInput,
      );
      await vi.runAllTimersAsync();
      expect((await pending).success).toBe(true);

      expect(getModelPolicy).toHaveBeenCalledWith(
        'hook_prompt',
        'test-session',
        0,
        undefined,
        expect.any(AbortSignal),
        expect.objectContaining({ resolvedModel: 'gemini-2.0-flash' }),
      );
      expect(inference).toHaveBeenCalledTimes(2);
      const request = inference.mock.calls[0][0];
      expect(request).toMatchObject({
        taskRouting: { policyTaskId: 'hook-task' },
        business: {
          id: expect.any(String),
          model_key: model.key,
          name: 'pre-tool-use',
          sub_task: 'pre-tool-use',
        },
      });
      expect(inference.mock.calls[1][0].business).toBe(request.business);
    });

    it('rejects an SDK model override before inference', async () => {
      const unavailableModel = 'cmcc/unavailable';
      mockGenerateJson.mockResolvedValue({ ok: true });
      Object.defineProperty(mockConfig, 'getModelPolicy', {
        configurable: true,
        value: vi.fn().mockResolvedValue({ model: unavailableModel }),
      });

      const result = await new HookRunner(mockConfig).executeHook(
        promptConfig,
        HookEventName.PreToolUse,
        mockInput,
      );

      expect(result.success).toBe(false);
      expect(result.error?.message).toBe(
        'Model overrides require provider selection support.',
      );
      expect(mockGenerateJson).not.toHaveBeenCalled();
    });

    it('should handle prompt hook failure when LLM call throws', async () => {
      mockGenerateJson.mockRejectedValue(new Error('LLM service unavailable'));

      vi.mocked(mockConfig.getModel).mockReturnValue('gemini-2.0-flash');

      hookRunner = new HookRunner(mockConfig);

      const result = await hookRunner.executeHook(
        promptConfig,
        HookEventName.PreToolUse,
        mockInput,
      );

      expect(result.success).toBe(false);
      expect(result.error?.message).toBe('LLM service unavailable');
      expect(mockRunLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining(
          'Prompt hook "safety-check" for PreToolUse failed',
        ),
      );
    });

    it('should handle prompt hook timeout', async () => {
      const slowPromptConfig: PromptHookConfig = {
        type: HookType.Prompt,
        prompt: 'Evaluate this',
        timeout: 0.05, // Very short timeout for testing
      };

      // LLM call that never resolves
      mockGenerateJson.mockReturnValue(new Promise(() => {}));

      vi.mocked(mockConfig.getModel).mockReturnValue('gemini-2.0-flash');

      hookRunner = new HookRunner(mockConfig);

      const result = await hookRunner.executeHook(
        slowPromptConfig,
        HookEventName.PreToolUse,
        mockInput,
      );

      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('timed out');
    });

    it('fails after five attempts when ok is missing', async () => {
      vi.useFakeTimers();
      mockGenerateJson.mockResolvedValue({
        reason: 'Some reason but no ok field',
      });

      vi.mocked(mockConfig.getModel).mockReturnValue('gemini-2.0-flash');

      hookRunner = new HookRunner(mockConfig);

      const pending = hookRunner.executeHook(
        promptConfig,
        HookEventName.PreToolUse,
        mockInput,
      );
      await vi.runAllTimersAsync();
      expect((await pending).success).toBe(false);
      expect(inference).toHaveBeenCalledTimes(5);
    });

    it('should include hook event data in the LLM request', async () => {
      mockGenerateJson.mockResolvedValue({ ok: true });

      vi.mocked(mockConfig.getModel).mockReturnValue('gemini-2.0-flash');

      hookRunner = new HookRunner(mockConfig);

      await hookRunner.executeHook(
        promptConfig,
        HookEventName.PreToolUse,
        mockInput,
      );

      const callArgs = inference.mock.calls[0][0];
      const userContent = callArgs.messages[0].content;
      expect(userContent).toContain('test-session');
      expect(userContent).toContain('PreToolUse');
      expect(userContent).toContain('/test/project');
    });

    it.each(['not JSON', '{"ok":"false"}', '{"ok":true,"reason":42}'])(
      'retries invalid content %s',
      async (content) => {
        vi.useFakeTimers();
        mockGenerateJson
          .mockResolvedValueOnce(content)
          .mockResolvedValue({ ok: true });
        const pending = hookRunner.executeHook(
          promptConfig,
          HookEventName.PreToolUse,
          mockInput,
        );
        await vi.runAllTimersAsync();
        expect((await pending).output).toEqual({ decision: 'allow' });
        expect(inference).toHaveBeenCalledTimes(2);
        expect(select).toHaveBeenCalledTimes(1);
      },
    );

    it('preserves the parent business ID and sec_scan task priority', async () => {
      mockGenerateJson.mockResolvedValue({ ok: true });
      const parent = {
        id: 'parent-id',
        model_key: 'original-model',
        version: 'test',
        type: 'sec_scan',
      };
      const result = await businessInfoContext.run(parent, () =>
        requestSetIdContext.run('parent-request-set', () =>
          hookRunner.executeHook(
            promptConfig,
            HookEventName.PreToolUse,
            mockInput,
          ),
        ),
      );
      expect(result.success).toBe(true);
      expect(inference.mock.calls[0][0]).toMatchObject({
        business: parent,
        identity: {
          sessionId: 'test-session',
          requestSetId: 'parent-request-set',
        },
        taskRouting: { taskId: 'sec_scan' },
      });
    });

    it.each([
      '429 Too Many Requests',
      '503 Service Unavailable',
      'fetch failed',
    ])('does not add retries for request errors (%s)', async (message) => {
      inference.mockRejectedValue(new Error(message));
      const result = await hookRunner.executeHook(
        promptConfig,
        HookEventName.PreToolUse,
        mockInput,
      );
      expect(result.error?.message).toBe(message);
      expect(inference).toHaveBeenCalledTimes(1);
    });

    it('rejects an incomplete stream', async () => {
      inference.mockResolvedValue({
        completed: Promise.resolve({
          blocks: [{ type: 'text', text: '{"ok":true}' }],
        }),
      });
      const result = await hookRunner.executeHook(
        promptConfig,
        HookEventName.PreToolUse,
        mockInput,
      );
      expect(result.success).toBe(false);
      expect(inference).toHaveBeenCalledTimes(1);
    });

    it('propagates caller cancellation to a stalled completion', async () => {
      const controller = new AbortController();
      inference.mockImplementation(async () => {
        controller.abort();
        return { completed: new Promise(() => {}) };
      });
      const result = await hookRunner.executeHook(
        promptConfig,
        HookEventName.PreToolUse,
        mockInput,
        controller.signal,
      );
      expect(result.success).toBe(false);
      expect(inference.mock.calls[0][0].signal.aborted).toBe(true);
      expect(inference).toHaveBeenCalledTimes(1);
    });
  });

  describe('agent hooks', () => {
    const agentConfig: AgentHookConfig = {
      type: HookType.Agent,
      prompt: 'Evaluate if this tool use is safe',
      tools: ['Read', 'Glob'],
      statusMessage: 'safety-agent',
    };

    // Mock tools returned by the main registry's getAllTools()
    const mockReadTool = { name: 'Read', exposureHints: {} };
    const mockGlobTool = { name: 'Glob', exposureHints: {} };
    const mockAgentTool = { name: 'Agent', exposureHints: {} };
    const mockEditTool = { name: 'Edit', exposureHints: {} };
    const select = vi.fn();
    const selectedModel = {
      ...testProviderModel('gemini-2.0-flash'),
      defaultModelConfig: {
        reasoning: { effort: 'medium' as const },
        context: { contextWindow: 128_000 },
      },
    };
    const inference = vi.fn(async (request: ModelStreamRequest) =>
      createModelStreamResponse(
        (async function* () {
          yield {
            type: 'message_start',
            message: {
              id: 'hook-message',
              role: 'assistant',
              model: request.resolution.model.key,
            },
          } as const;
          yield {
            type: 'content_block_start',
            index: 0,
            contentBlock: { type: 'text', text: '' },
          } as const;
          yield {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'Checked' },
          } as const;
          yield { type: 'content_block_stop', index: 0 } as const;
          yield {
            type: 'message_delta',
            delta: { stopReason: 'end_turn' },
          } as const;
          yield { type: 'message_stop' } as const;
        })(),
      ),
    );

    /**
     * Helper: create an async generator that yields events then returns.
     * Simulates query() behavior.
     */
    function createMockRunLoop(events: Array<{ type: string }>) {
      return async function* () {
        for (const event of events) {
          if (event.type === 'assistant') {
            yield createAssistantMessage({
              messageId: 'hook-assistant',

              blocks: [],

              model: 'test-model',
              stopReason: 'end_turn',

              usage: ((value) => ({
                inputTokens: value.input_tokens,
                outputTokens: value.output_tokens,
                cacheReadInputTokens: value.cache_read_input_tokens,
                cacheCreationInputTokens: value.cache_creation_input_tokens,
              }))(cloneUsage()),
            });
            continue;
          }
          if (event.type === 'tool_result') {
            yield createToolResultMessage(
              [
                {
                  type: 'tool_result',
                  tool_use_id: 'hook-tool',
                  content: 'ok',
                  is_error: false,
                },
              ],
              'hook-assistant',
            );
            continue;
          }
          yield event;
        }
      };
    }

    /**
     * Helper to set up the mockRunLoop so that during iteration,
     * the StructuredOutputResultHolder's result is set (simulating
     * the StructuredOutput tool being called by the agent).
     */
    function setupMockRunLoopWithResult(
      events: Array<{ type: string }>,
      result: { ok: boolean; reason?: string } | null,
    ) {
      mockRunLoop.mockImplementation(() => {
        // Set the result on the holder before first yield — simulates
        // StructuredOutput tool execution during the query() loop.
        // The resultHolder is checked after each yield in executeAgentHook.
        if (result) {
          mockResultHolder.result = result;
        }
        return createMockRunLoop(events)();
      });
    }

    beforeEach(() => {
      mockRunLoop.mockReset();
      mockResultHolder.result = null;
      const models = [
        selectedModel,
        ...['cmcc/qwen3.5-plus', 'sdk-model', 'gemini-2.0-flash-lite'].map(
          (key) => ({
            ...selectedModel,
            key,
          }),
        ),
      ];
      select.mockImplementation(
        async (
          input: ModelSelectContext & { overrideSelection?: ModelSelection },
        ) => ({
          model:
            models.find(
              ({ key }) => key === input.overrideSelection?.model.key,
            ) ?? selectedModel,
          config: {
            reasoning: { effort: 'medium' },
            context: { contextWindow: 128_000 },
          },
        }),
      );
      const manager = {
        select,
        inference,
        listModels: async () => models,
        getModel: async (key: string) =>
          models.find((model) => model.key === key),
      };
      const sessionManager = withSessionSelection(manager, mockConfig);
      Object.assign(mockConfig, {
        hasModelProviderManager: () => true,
        getModelProviderManager: () => sessionManager,
      });

      // StructuredOutputResultHolder mock → returns our shared mockResultHolder
      MockStructuredOutputResultHolder.mockImplementation(
        () => mockResultHolder,
      );

      // StructuredOutputDeclarativeTool mock → returns a stub
      MockStructuredOutputDeclarativeTool.mockImplementation(() => ({
        name: 'StructuredOutput',
      }));

      // ToolRegistry constructor mock → returns object with registerTool/getAllTools
      mockScopedRegisterTool.mockReset();
      MockToolRegistryCtor.mockImplementation(() => ({
        registerTool: mockScopedRegisterTool,
        getAllTools: vi.fn().mockReturnValue([]),
        getFunctionDeclarations: vi.fn().mockReturnValue([]),
        getModelFunctionDeclarations: vi.fn().mockReturnValue([]),
      }));

      // createHookAgentLoopContext mock → returns a minimal context
      mockCreateHookAgentLoopContext.mockReturnValue({
        config: mockConfig,
        promptId: 'test-prompt',
        toolRegistry: {
          getAllTools: vi.fn().mockReturnValue([]),
          getFunctionDeclarations: vi.fn().mockReturnValue([]),
        },
        promptRegistry: {},
        resourceRegistry: {},
        modelClient: {},
      });

      // Main registry mock needs getAllTools() for createScopedToolRegistry
      vi.mocked(mockConfig.getToolRegistry).mockReturnValue({
        getAllTools: vi
          .fn()
          .mockReturnValue([
            mockReadTool,
            mockGlobTool,
            mockAgentTool,
            mockEditTool,
          ]),
        getFunctionDeclarations: vi.fn().mockReturnValue([]),
        getTool: vi.fn(),
      } as never);
    });

    it('should execute agent hook with ok=true → outcome:success, decision:allow', async () => {
      setupMockRunLoopWithResult([{ type: 'assistant' }], { ok: true });

      hookRunner = new HookRunner(mockConfig);

      const result = await hookRunner.executeHook(
        agentConfig,
        HookEventName.PreToolUse,
        mockInput,
      );

      expect(result.success).toBe(true);
      expect(result.outcome).toBe('success');
      expect(result.output).toEqual({ decision: 'allow' });
      expect(result.outputFormat).toBe('json');
    });

    it('leaves default model selection to query without a synthetic parent', async () => {
      setupMockRunLoopWithResult([{ type: 'assistant' }], { ok: true });
      const result = await hookRunner.executeHook(
        agentConfig,
        HookEventName.PreToolUse,
        mockInput,
      );
      expect(result.success).toBe(true);
      expect(select).not.toHaveBeenCalled();
      const options = mockRunLoop.mock.calls[0][0] as QueryParams;
      expect(options.modelPurpose).toBe('hook_prompt');
      expect(options).not.toHaveProperty('modelOverride');
      expect(options).not.toHaveProperty('parentSelection');
      expect(options).not.toHaveProperty('modelResolution');
    });

    async function useRealQuery() {
      const { query } = await vi.importActual<
        typeof import('../core/agent-loop.js')
      >('../core/agent-loop.js');
      mockRunLoop.mockImplementation(query);
      const manager = mockConfig.getModelProviderManager();
      const selector = new CustomModelSelector(
        new CustomProviderConfig({
          providerId: selectedModel.source,
          baseUrl: 'https://unused.invalid',
          protocol: OPENAI_CHAT_COMPLETIONS,
          models: await manager.listModels(),
        }),
        { getModelConfig: () => undefined, setModelConfig: () => true },
      );
      select.mockImplementation(
        (input: ModelSelectContext & { overrideSelection?: ModelSelection }) =>
          selector.select({ ...input, mainModel: selectedModel }),
      );
    }

    it.each([
      { explicit: false, sdkOverride: false },
      { explicit: true, sdkOverride: false },
      { explicit: false, sdkOverride: true },
      { explicit: true, sdkOverride: true },
    ])(
      'selects only in query (explicit=$explicit, SDK override=$sdkOverride)',
      async ({ explicit, sdkOverride }) => {
        await useRealQuery();
        const policy = vi.fn(async () =>
          sdkOverride
            ? {
                model: 'sdk-model',
                parameters: { reasoningEffort: 'low' as const },
              }
            : undefined,
        );
        Object.assign(mockConfig, { getModelPolicy: policy });
        const result = await hookRunner.executeHook(
          {
            ...agentConfig,
            ...(explicit ? { model: 'gemini-2.0-flash-lite' } : {}),
          },
          HookEventName.PreToolUse,
          mockInput,
        );
        expect(result.success).toBe(true);
        expect(select).toHaveBeenCalledTimes(sdkOverride ? 2 : 1);
        expect(select.mock.calls[0][0]).toMatchObject({
          purpose: 'hook_prompt',
        });
        expect(select.mock.calls[0][0].parentSelection).toBeUndefined();
        expect(select.mock.calls[0][0].overrideSelection).toEqual(
          explicit
            ? {
                model: expect.objectContaining({
                  key: 'gemini-2.0-flash-lite',
                }),
                config: {},
              }
            : undefined,
        );
        expect(policy).toHaveBeenCalledOnce();
        expect(policy.mock.calls[0]?.slice(0, 1)).toEqual(['hook_prompt']);
        expect(inference).toHaveBeenCalledOnce();
        expect(inference.mock.calls[0][0].resolution).toMatchObject({
          model: {
            key: sdkOverride
              ? 'sdk-model'
              : explicit
                ? 'gemini-2.0-flash-lite'
                : selectedModel.key,
          },
          config: { reasoning: { effort: sdkOverride ? 'low' : 'medium' } },
        });
        if (sdkOverride) {
          expect(select.mock.calls[1][0].overrideSelection.config).toEqual({
            reasoning: { effort: 'low' },
          });
        }
      },
    );

    it('recovers a missing explicit model through the existing query SDK path', async () => {
      await useRealQuery();
      const getModel = vi.spyOn(
        mockConfig.getModelProviderManager(),
        'getModel',
      );
      getModel.mockResolvedValueOnce(undefined);
      const policy = vi.fn(async () => undefined);
      Object.assign(mockConfig, { getModelPolicy: policy });
      const result = await hookRunner.executeHook(
        { ...agentConfig, model: 'gemini-2.0-flash-lite' },
        HookEventName.PreToolUse,
        mockInput,
      );
      expect(result.success).toBe(true);
      expect(policy).toHaveBeenCalledOnce();
      expect(getModel.mock.calls.map(([key]) => key)).toEqual([
        'gemini-2.0-flash-lite',
        'gemini-2.0-flash-lite',
      ]);
      expect(select).toHaveBeenCalledOnce();
      expect(inference.mock.calls[0][0].resolution.model.key).toBe(
        'gemini-2.0-flash-lite',
      );
    });

    it('keeps an unknown explicit model as an error when SDK cannot recover it', async () => {
      await useRealQuery();
      const policy = vi.fn(async () => undefined);
      Object.assign(mockConfig, { getModelPolicy: policy });
      const result = await hookRunner.executeHook(
        { ...agentConfig, model: 'unknown-model' },
        HookEventName.PreToolUse,
        mockInput,
      );
      expect(policy).toHaveBeenCalledOnce();
      expect(result).toMatchObject({
        success: false,
        outcome: 'non_blocking_error',
      });
      expect(result.error).toBeInstanceOf(ModelNotFoundError);
      expect(inference).not.toHaveBeenCalled();
    });

    it('does not use SDK recovery for a disabled model', async () => {
      await useRealQuery();
      const error = new ModelNotFoundError('Model disabled', 403);
      select.mockRejectedValue(error);
      const policy = vi.fn();
      Object.assign(mockConfig, { getModelPolicy: policy });
      const result = await hookRunner.executeHook(
        agentConfig,
        HookEventName.PreToolUse,
        mockInput,
      );
      expect(result).toMatchObject({
        success: false,
        outcome: 'non_blocking_error',
        error,
      });
      expect(policy).not.toHaveBeenCalled();
      expect(inference).not.toHaveBeenCalled();
    });

    it('does not send inference when the SDK policy fails', async () => {
      await useRealQuery();
      const error = new Error('SDK policy failed');
      const policy = vi.fn().mockRejectedValue(error);
      Object.assign(mockConfig, { getModelPolicy: policy });
      const result = await hookRunner.executeHook(
        agentConfig,
        HookEventName.PreToolUse,
        mockInput,
      );
      expect(result).toMatchObject({
        success: false,
        outcome: 'non_blocking_error',
        error,
      });
      expect(select).toHaveBeenCalledOnce();
      expect(policy).toHaveBeenCalledOnce();
      expect(inference).not.toHaveBeenCalled();
    });

    it('does not fall back when Provider selection fails inside query', async () => {
      await useRealQuery();
      const error = new Error('Hook model selection failed');
      select.mockRejectedValue(error);
      const result = await hookRunner.executeHook(
        agentConfig,
        HookEventName.PreToolUse,
        mockInput,
      );
      expect(select).toHaveBeenCalledOnce();
      expect(result.success).toBe(false);
      expect(result.error).toBe(error);
    });

    it('cancels a stalled selection inside query', async () => {
      await useRealQuery();
      const controller = new AbortController();
      select.mockImplementation(() => {
        controller.abort();
        return new Promise(() => {});
      });
      const result = await hookRunner.executeHook(
        agentConfig,
        HookEventName.PreToolUse,
        mockInput,
        controller.signal,
      );
      expect(select).toHaveBeenCalledOnce();
      expect(result).toMatchObject({
        success: true,
        outcome: 'cancelled',
        output: { decision: 'defer' },
      });
    });

    it('applies the Hook timeout to a stalled Provider selection inside query', async () => {
      await useRealQuery();
      select.mockReturnValue(new Promise(() => {}));
      const result = await hookRunner.executeHook(
        { ...agentConfig, timeout: 0.05 },
        HookEventName.PreToolUse,
        mockInput,
      );
      expect(select).toHaveBeenCalledOnce();
      expect(result).toMatchObject({
        success: true,
        outcome: 'cancelled',
        output: { decision: 'defer' },
      });
    });

    it('inherits the triggering business and does not own its lifecycle', async () => {
      setupMockRunLoopWithResult([{ type: 'assistant' }], { ok: true });
      hookRunner = new HookRunner(mockConfig);
      const parent = Object.freeze({
        id: 'main-business',
        model_key: 'ultimate',
        version: '1.0.0',
        stage: 'processing',
      });
      await requestSetIdContext.run('main-task', () =>
        businessInfoContext.run(parent, () =>
          customContextContext.run({ tenant: 'hook-turn' }, () =>
            hookRunner.executeHook(
              agentConfig,
              HookEventName.PreToolUse,
              mockInput,
            ),
          ),
        ),
      );
      expect(mockRunLoop).toHaveBeenCalledWith(
        expect.objectContaining({
          isSubagent: true,
          agentType: 'hook-agent',
          parentRequestSetId: 'main-task',
          parentBusinessInfo: parent,
          customContext: { tenant: 'hook-turn' },
          sessionId: mockInput.session_id,
        }),
      );
      expect(parent).toEqual({
        id: 'main-business',
        model_key: 'ultimate',
        version: '1.0.0',
        stage: 'processing',
      });
    });

    it('routes agent-hook model requests through the SDK hook policy', async () => {
      setupMockRunLoopWithResult([{ type: 'assistant' }], { ok: true });
      const getModelPolicy = vi.fn().mockResolvedValue({
        model: 'cmcc/qwen3.5-plus',
      });
      Object.defineProperty(mockConfig, 'getModelPolicy', {
        configurable: true,
        value: getModelPolicy,
      });

      hookRunner = new HookRunner(mockConfig);
      await hookRunner.executeHook(
        agentConfig,
        HookEventName.PreToolUse,
        mockInput,
      );

      const queryOptions = mockRunLoop.mock.calls[0]?.[0] as QueryParams;
      expect(queryOptions.modelPurpose).toBe('hook_prompt');

      expect(queryOptions.config).toBe(mockConfig);
      expect(queryOptions).not.toHaveProperty('parentSelection');
      expect(select).not.toHaveBeenCalled();
      // agent hook 把 SDK 策略留给 query，不在 hook 内重复调用。
      expect(queryOptions.config?.getModelPolicy).toBe(getModelPolicy);
      expect(getModelPolicy).not.toHaveBeenCalled();
    });

    it.each([{ model: 'sdk-model' }])(
      'does not carry selected defaults into SDK override $model',
      async (policy) => {
        setupMockRunLoopWithResult([{ type: 'assistant' }], { ok: true });
        Object.defineProperty(mockConfig, 'getModelPolicy', {
          configurable: true,
          value: vi.fn().mockResolvedValue(policy),
        });

        await hookRunner.executeHook(
          agentConfig,
          HookEventName.PreToolUse,
          mockInput,
        );
        const options = mockRunLoop.mock.calls[0][0] as QueryParams;
        expect(options).not.toHaveProperty('parentSelection');
        expect(options).not.toHaveProperty('modelOverride');
        expect(options.config).toBe(mockConfig);
      },
    );

    it('should execute agent hook with ok=false → outcome:blocking, decision:deny', async () => {
      setupMockRunLoopWithResult([{ type: 'assistant' }], {
        ok: false,
        reason: 'File is sensitive',
      });

      hookRunner = new HookRunner(mockConfig);

      const result = await hookRunner.executeHook(
        agentConfig,
        HookEventName.PreToolUse,
        mockInput,
      );

      expect(result.success).toBe(true);
      expect(result.outcome).toBe('blocking');
      expect(result.output).toEqual({
        decision: 'deny',
        reason: 'File is sensitive',
      });
      expect(result.outputFormat).toBe('json');
    });

    it('should return outcome:cancelled when no StructuredOutput is called', async () => {
      // Agent completes without StructuredOutput being called
      setupMockRunLoopWithResult(
        [{ type: 'assistant' }, { type: 'tool_result' }, { type: 'assistant' }],
        null,
      );

      hookRunner = new HookRunner(mockConfig);

      const result = await hookRunner.executeHook(
        agentConfig,
        HookEventName.PreToolUse,
        mockInput,
      );

      expect(result.success).toBe(true);
      expect(result.outcome).toBe('cancelled');
      expect(result.output).toEqual({ decision: 'defer' });
    });

    it('should return outcome:non_blocking_error when ToolRegistry is unavailable', async () => {
      vi.mocked(mockConfig.getToolRegistry).mockReturnValue(null as never);

      hookRunner = new HookRunner(mockConfig);

      const result = await hookRunner.executeHook(
        agentConfig,
        HookEventName.PreToolUse,
        mockInput,
      );

      expect(result.success).toBe(false);
      expect(result.outcome).toBe('non_blocking_error');
      expect(result.error?.message).toBe(
        'ToolRegistry not available for agent hook execution',
      );
    });

    it.each([false, true])('keeps query errors (%s)', async (abort) => {
      const controller = new AbortController();
      mockRunLoop.mockImplementation(
        // eslint-disable-next-line require-yield
        async function* () {
          if (abort) controller.abort();
          throw new Error('Agent runtime crashed');
        },
      );

      hookRunner = new HookRunner(mockConfig);

      const result = await hookRunner.executeHook(
        agentConfig,
        HookEventName.PreToolUse,
        mockInput,
        controller.signal,
      );

      expect(result.success).toBe(false);
      expect(result.outcome).toBe('non_blocking_error');
      expect(result.error?.message).toBe('Agent runtime crashed');
      expect(mockRunLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining(
          'Agent hook "safety-agent" for PreToolUse failed',
        ),
      );
    });

    it('should support $ARGUMENTS placeholder in prompt', async () => {
      const configWithArgs: AgentHookConfig = {
        type: HookType.Agent,
        prompt: 'Check the following: $ARGUMENTS',
      };

      setupMockRunLoopWithResult([{ type: 'assistant' }], { ok: true });

      hookRunner = new HookRunner(mockConfig);

      await hookRunner.executeHook(
        configWithArgs,
        HookEventName.PreToolUse,
        mockInput,
      );

      // Verify query() was called with processed prompt containing the JSON input
      const runLoopCall = mockRunLoop.mock.calls[0][0];
      expect(runLoopCall.prompt).toContain('Check the following:');
      expect(runLoopCall.prompt).toContain('test-session');
      expect(runLoopCall.prompt).not.toContain('$ARGUMENTS');
    });

    it('should append hook event data when no $ARGUMENTS in prompt', async () => {
      const configNoArgs: AgentHookConfig = {
        type: HookType.Agent,
        prompt: 'Evaluate this tool use',
      };

      setupMockRunLoopWithResult([{ type: 'assistant' }], { ok: true });

      hookRunner = new HookRunner(mockConfig);

      await hookRunner.executeHook(
        configNoArgs,
        HookEventName.PreToolUse,
        mockInput,
      );

      const runLoopCall = mockRunLoop.mock.calls[0][0];
      expect(runLoopCall.prompt).toContain('Evaluate this tool use');
      expect(runLoopCall.prompt).toContain('Hook event: PreToolUse');
      expect(runLoopCall.prompt).toContain('Hook event data:');
    });

    it('should filter tools via scoped ToolRegistry with allowlist', async () => {
      setupMockRunLoopWithResult([{ type: 'assistant' }], { ok: true });

      hookRunner = new HookRunner(mockConfig);

      await hookRunner.executeHook(
        agentConfig, // has tools: ['Read', 'Glob']
        HookEventName.PreToolUse,
        mockInput,
      );

      // ToolRegistry constructor was called (for the scoped registry)
      expect(MockToolRegistryCtor).toHaveBeenCalledWith(mockConfig);

      // Only allowed tools + StructuredOutput should be registered
      const registeredTools = mockScopedRegisterTool.mock.calls.map(
        (call: unknown[]) => (call[0] as { name: string }).name,
      );
      expect(registeredTools).toContain('Read');
      expect(registeredTools).toContain('Glob');
      expect(registeredTools).not.toContain('Agent');
      expect(registeredTools).not.toContain('Edit');
      // StructuredOutput is registered via DeclarativeTool
      expect(MockStructuredOutputDeclarativeTool).toHaveBeenCalled();
    });

    it('should use denylist filtering when no tools specified', async () => {
      const configNoTools: AgentHookConfig = {
        type: HookType.Agent,
        prompt: 'Check this',
      };

      setupMockRunLoopWithResult([{ type: 'assistant' }], { ok: true });

      hookRunner = new HookRunner(mockConfig);

      await hookRunner.executeHook(
        configNoTools,
        HookEventName.PreToolUse,
        mockInput,
      );

      // Without explicit tools, all tools except disallowed ones are registered
      const registeredTools = mockScopedRegisterTool.mock.calls.map(
        (call: unknown[]) => (call[0] as { name: string }).name,
      );
      expect(registeredTools).toContain('Read');
      expect(registeredTools).toContain('Glob');
      expect(registeredTools).toContain('Edit');
      // 'Agent' is in the disallow list
      expect(registeredTools).not.toContain('Agent');
    });

    it('should give the hook agent a schema registry', async () => {
      setupMockRunLoopWithResult([{ type: 'assistant' }], { ok: true });

      hookRunner = new HookRunner(mockConfig);

      await hookRunner.executeHook(
        agentConfig,
        HookEventName.PreToolUse,
        mockInput,
      );

      const runLoopCall = mockRunLoop.mock.calls[0][0];
      expect(runLoopCall.toolRegistry).toBeDefined();
      expect(typeof runLoopCall.toolRegistry.getSchema).toBe('function');
    });

    it('should use custom maxTurns from config', async () => {
      const configWithTurns: AgentHookConfig = {
        type: HookType.Agent,
        prompt: 'Evaluate',
        maxTurns: 5,
      };

      setupMockRunLoopWithResult([{ type: 'assistant' }], { ok: true });

      hookRunner = new HookRunner(mockConfig);

      await hookRunner.executeHook(
        configWithTurns,
        HookEventName.PreToolUse,
        mockInput,
      );

      const runLoopCall = mockRunLoop.mock.calls[0][0];
      expect(runLoopCall.maxTurns).toBe(5);
    });

    it('should use default maxTurns=50 when not specified', async () => {
      const configNoTurns: AgentHookConfig = {
        type: HookType.Agent,
        prompt: 'Evaluate',
      };

      setupMockRunLoopWithResult([{ type: 'assistant' }], { ok: true });

      hookRunner = new HookRunner(mockConfig);

      await hookRunner.executeHook(
        configNoTurns,
        HookEventName.PreToolUse,
        mockInput,
      );

      const runLoopCall = mockRunLoop.mock.calls[0][0];
      expect(runLoopCall.maxTurns).toBe(50);
    });

    it('should use model override from hook config', async () => {
      const configWithModel: AgentHookConfig = {
        type: HookType.Agent,
        prompt: 'Evaluate',
        model: 'gemini-2.0-flash-lite',
      };

      setupMockRunLoopWithResult([{ type: 'assistant' }], { ok: true });

      hookRunner = new HookRunner(mockConfig);

      await hookRunner.executeHook(
        configWithModel,
        HookEventName.PreToolUse,
        mockInput,
      );

      const runLoopCall = mockRunLoop.mock.calls[0][0];
      expect(runLoopCall).not.toHaveProperty('model');
      expect(runLoopCall.modelPurpose).toBe('hook_prompt');
      expect(runLoopCall).not.toHaveProperty('parentSelection');
      expect(runLoopCall.querySelection).toEqual({
        key: 'gemini-2.0-flash-lite',
      });
      expect(select).not.toHaveBeenCalled();
      expect(runLoopCall.reasoningEffort).toBeUndefined();
      expect(runLoopCall.contextWindow).toBeUndefined();
      expect(runLoopCall.modelResolution).toBeUndefined();
    });

    it('should provide default reason when ok=false without reason', async () => {
      setupMockRunLoopWithResult([{ type: 'assistant' }], { ok: false });

      hookRunner = new HookRunner(mockConfig);

      const result = await hookRunner.executeHook(
        agentConfig,
        HookEventName.PreToolUse,
        mockInput,
      );

      expect(result.outcome).toBe('blocking');
      expect(result.output).toEqual({
        decision: 'deny',
        reason: 'Agent hook condition was not met',
      });
    });
  });
});
