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
import { OUTPUT_UPDATE_INTERVAL_MS } from './shell.js';
import { createMockWorkspaceContext } from '../test-utils/mockWorkspaceContext.js';
import { PermissionManager } from '../permissions/permission-manager.js';

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
      getGitCoAuthor: vi.fn().mockReturnValue({
        enabled: true,
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
        {},
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
        {},
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

      it('should not add co-author when disabled in config', async () => {
        // Mock config with disabled co-author
        (mockConfig.getGitCoAuthor as Mock).mockReturnValue({
          enabled: false,
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
          enabled: true,
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

      it('should add co-author when git commit is prefixed with cd command', async () => {
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
        {},
      );
    });
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
    // standalone foreground sleeps and must not bypass the guard.
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
