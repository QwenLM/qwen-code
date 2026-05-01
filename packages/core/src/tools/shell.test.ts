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
import { ShellTool } from './shell.js';
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

    shellTool = new ShellTool(mockConfig);

    vi.mocked(os.platform).mockReturnValue('linux');
    vi.mocked(os.tmpdir).mockReturnValue('/tmp');
    (vi.mocked(crypto.randomBytes) as Mock).mockReturnValue(
      Buffer.from('abcdef', 'hex'),
    );

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
        {},
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
        {},
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
        {},
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
        {},
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
        {},
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
        {},
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
        {},
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
        {},
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
        {},
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
        vi.useFakeTimers({ toFake: ['Date'] });
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
          {},
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
          {},
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
          {},
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
          {},
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
          {},
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
          {},
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
          {},
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
          {},
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
          {},
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
          {},
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
          {},
        );
      });

      // `git -C <path> commit` runs in <path>, not our cwd — same risk
      // as the cd case, so the rewrite should be skipped.
      it('should NOT add co-author for git -C <path> commit', async () => {
        const command = 'git -C /tmp/other commit -m "Other repo"';
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
          {},
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
          {},
        );
      });

      // Bash's apostrophe-via-`'\''` form needs to be left alone — a
      // naive single-quote rewrite would mid-insert the trailer and
      // break the command's quoting.
      it("should leave -m 'don'\\''t' (apostrophe-escape form) unrewritten", async () => {
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
        // The original command must be passed through unchanged.
        expect(observed).toContain("'don'\\''t'");
        // No trailer was injected mid-quote.
        expect(observed).not.toContain('Co-authored-by:');
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
          {},
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
          {},
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
          {},
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
          {},
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

    it('should throw an error if validation fails', async () => {
      expect(() =>
        shellTool.build({ command: '', is_background: false }),
      ).toThrow();
    });
  });

  describe('getDescription', () => {
    it('should return the windows description when on windows', async () => {
      vi.mocked(os.platform).mockReturnValue('win32');
      const shellTool = new ShellTool(mockConfig);
      expect(shellTool.description).toMatchSnapshot();
    });

    it('should return the non-windows description when not on windows', async () => {
      vi.mocked(os.platform).mockReturnValue('linux');
      const shellTool = new ShellTool(mockConfig);
      expect(shellTool.description).toMatchSnapshot();
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
        {},
      );

      // The signal passed should be different from the original signal
      const calledSignal = mockShellExecutionService.mock.calls[0][3];
      expect(calledSignal).not.toBe(mockAbortSignal);
    });

    it('should handle timeout vs user cancellation correctly', async () => {
      const userAbortController = new AbortController();
      const invocation = shellTool.build({
        command: 'sleep 10',
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
        {},
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
