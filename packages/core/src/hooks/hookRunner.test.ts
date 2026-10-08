/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type MockInstance,
} from 'vitest';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import {
  HookRunner,
  __resetPowerShellCacheForTests,
  resolvePowerShellExecutable,
} from './hookRunner.js';
import * as shellUtils from '../utils/shell-utils.js';
import {
  HookEventName,
  HookType,
  HooksConfigSource,
  MAX_USER_PROMPT_EXPANSION_ADDITIONAL_CONTEXT_LENGTH,
} from './types.js';
import type {
  CommandHookConfig,
  HookConfig,
  HookInput,
  PreToolUseInput,
  UserPromptExpansionInput,
  UserPromptSubmitInput,
} from './types.js';

const mockSpawn = vi.hoisted(() => vi.fn());
const mockExecFile = vi.hoisted(() => vi.fn());
const mockDebugLogger = vi.hoisted(() => ({
  isEnabled: () => false,
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual('node:child_process');
  return {
    ...actual,
    spawn: mockSpawn,
    execFile: mockExecFile,
  };
});

vi.mock('../utils/debugLogger.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/debugLogger.js')>()),
  createDebugLogger: () => mockDebugLogger,
}));

describe('HookRunner', () => {
  let hookRunner: HookRunner;

  beforeEach(() => {
    hookRunner = new HookRunner();
    vi.clearAllMocks();
    // Default probe result: only `powershell` installed. Probe-priority
    // tests override this spy; cache reset makes the mock take effect.
    vi.spyOn(shellUtils, 'resolveCommandPath').mockImplementation(((
      name: string,
    ) => {
      if (name === 'powershell')
        return {
          path: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        };
      return { path: null };
    }) as never);
    __resetPowerShellCacheForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const createMockInput = (overrides: Partial<HookInput> = {}): HookInput => ({
    session_id: 'test-session',
    transcript_path: '/test/transcript',
    cwd: '/test',
    hook_event_name: 'test-event',
    timestamp: '2024-01-01T00:00:00Z',
    ...overrides,
  });

  // Each stream emits its text, and the process closes, on a later tick.
  const createMockProcess = (exitCode = 0, stdout = '', stderr = '') => {
    const stream = (text: string) => ({
      on: vi.fn((event: string, callback: (data: Buffer) => void) => {
        if (event === 'data' && text) {
          setTimeout(() => callback(Buffer.from(text)), 0);
        }
      }),
    });
    return {
      stdin: { on: vi.fn(), write: vi.fn(), end: vi.fn() },
      stdout: stream(stdout),
      stderr: stream(stderr),
      on: vi.fn((event: string, callback: (code: number) => void) => {
        if (event === 'close') {
          setTimeout(() => callback(exitCode), 0);
        }
      }),
      kill: vi.fn(),
      unref: vi.fn(),
    };
  };

  // Forces the cmd->powershell fallback; needed for asserts on the
  // post-`-Command` arg position (bash hosts have no third spawn arg).
  // Caller must wrap in `try { ... } finally { spy.mockRestore(); }`.
  const mockCmdShellConfig = () =>
    vi.spyOn(shellUtils, 'getShellConfiguration').mockReturnValue({
      executable: 'cmd.exe',
      argsPrefix: ['/d', '/s', '/c'],
      shell: 'cmd',
    });

  const createControllableMockProcess = (pid = 4321) => {
    type Listener = (...args: unknown[]) => void;
    const listeners = new Map<string, Listener[]>();
    const createStream = () => {
      const dataListeners: Listener[] = [];
      return {
        on: vi.fn((event: string, callback: Listener) => {
          if (event === 'data') dataListeners.push(callback);
        }),
        destroy: vi.fn(),
        emitData: (data: Buffer) => {
          for (const listener of dataListeners) listener(data);
        },
      };
    };
    const mockProcess = {
      pid,
      stdin: { ...createStream(), write: vi.fn(), end: vi.fn() },
      stdout: createStream(),
      stderr: createStream(),
      killed: true,
      exitCode: null,
      signalCode: null,
      kill: vi.fn(),
      unref: vi.fn(),
      on: vi.fn((event: string, callback: Listener) => {
        const eventListeners = listeners.get(event) ?? [];
        eventListeners.push(callback);
        listeners.set(event, eventListeners);
        return mockProcess;
      }),
      emit: (event: string, ...args: unknown[]) => {
        for (const listener of listeners.get(event) ?? []) listener(...args);
      },
    };
    return mockProcess;
  };

  const cmd = (
    command: string,
    extra: Partial<CommandHookConfig> = {},
  ): CommandHookConfig => ({
    type: HookType.Command,
    command,
    source: HooksConfigSource.Project,
    ...extra,
  });

  // Scripts every spawn to return one createMockProcess() child.
  const scriptSpawn = (...args: Parameters<typeof createMockProcess>) => {
    const mockProcess = createMockProcess(...args);
    mockSpawn.mockImplementation(() => mockProcess);
    return mockProcess;
  };

  const spawnControllable = (pid?: number) => {
    const mockProcess = createControllableMockProcess(pid);
    mockSpawn.mockReturnValue(mockProcess);
    return mockProcess;
  };

  // Runs `hook` (a command or a config) for `eventName`, PreToolUse by
  // default; a given event is also the input's hook_event_name.
  const execute = (
    hook: string | HookConfig,
    eventName?: HookEventName,
    signal?: AbortSignal,
  ) =>
    hookRunner.executeHook(
      typeof hook === 'string' ? cmd(hook) : hook,
      eventName ?? HookEventName.PreToolUse,
      createMockInput(eventName ? { hook_event_name: eventName } : {}),
      signal,
    );

  const runHook = (
    hook: string | HookConfig,
    exitCode = 0,
    stdout = '',
    stderr = '',
    eventName?: HookEventName,
  ) => {
    scriptSpawn(exitCode, stdout, stderr);
    return execute(hook, eventName);
  };

  // Runs one hook via `method`; each callback fires once, end with `success`.
  const expectCallbacks = async (
    method: 'executeHooksParallel' | 'executeHooksSequential',
    hook: HookConfig,
    success: boolean,
  ) => {
    const onHookStart = vi.fn();
    const onHookEnd = vi.fn();
    const results = await hookRunner[method](
      [hook],
      HookEventName.PreToolUse,
      createMockInput(),
      onHookStart,
      onHookEnd,
    );
    expect(onHookStart).toHaveBeenCalledTimes(1);
    expect(onHookEnd).toHaveBeenCalledTimes(1);
    expect(onHookEnd).toHaveBeenCalledWith(
      hook,
      expect.objectContaining({ success }),
      0,
    );
    return results;
  };

  describe('executeHook', () => {
    it('should return error when hook command is missing', async () => {
      const result = await execute('');

      expect(result.success).toBe(false);
      expect(result.error?.message).toBe('Command hook missing command');
    });

    it('should execute hook and return success for exit code 0', async () => {
      const result = await runHook('echo hello', 0, 'hello');

      expect(result.success).toBe(true);
      expect(result.stdout).toBe('hello');
      expect(mockSpawn).toHaveBeenCalled();
    });

    it('strips Qwen-internal daemon secrets from the hook child env (#6601)', async () => {
      vi.stubEnv('QWEN_SERVER_TOKEN', 'serve-secret');
      vi.stubEnv('QWEN_DAEMON_TOKEN', 'daemon-secret');
      try {
        await runHook('echo hello', 0, 'hello');

        const spawnOptions = mockSpawn.mock.calls[0][2];
        // A user-authored hook command is a child process launched on the
        // agent's behalf; internal daemon secrets must not leak into it.
        expect(spawnOptions.env['QWEN_SERVER_TOKEN']).toBeUndefined();
        expect(spawnOptions.env['QWEN_DAEMON_TOKEN']).toBeUndefined();
        // Benign inherited env and the hook's own vars are still present.
        expect(spawnOptions.env['PATH']).toBeDefined();
        expect(spawnOptions.env['QWEN_PROJECT_DIR']).toBe('/test');
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it('should return failure for non-zero exit code', async () => {
      const result = await runHook('exit 1', 1, '', 'error');

      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(1);
    });

    it('should parse JSON output from stdout', async () => {
      const output = JSON.stringify({
        decision: 'allow',
        systemMessage: 'test',
      });
      const result = await runHook('echo json', 0, output);

      expect(result.success).toBe(true);
      expect(result.output?.decision).toBe('allow');
      expect(result.output?.systemMessage).toBe('test');
    });

    // Exit code 2 ignores stdout, JSON included, and uses stderr as the reason.
    it.each([
      [
        'should convert plain text to deny output on exit code 2',
        '',
        'error message',
      ],
      [
        'should ignore stdout on exit code 2 and use stderr only',
        'stdout should be ignored',
        'stderr error message',
      ],
      [
        'should not parse JSON on exit code 2',
        '{"decision":"allow"}',
        'blocking error',
      ],
    ])('%s', async (_title, stdout, stderr) => {
      const result = await runHook('exit 2', 2, stdout, stderr);

      expect(result.success).toBe(false);
      expect(result.output?.decision).toBe('deny');
      expect(result.output?.reason).toBe(stderr);
    });

    it('should parse JSON from stderr on exit code 2 to preserve additionalContext', async () => {
      const hookSpecificOutput = {
        hookEventName: 'PostToolUse',
        additionalContext: '[Hook] Tool execution blocked with context',
      };
      const stderr = JSON.stringify({
        decision: 'deny',
        reason: 'blocked by policy',
        hookSpecificOutput,
      });
      const result = await runHook('exit 2', 2, 'stdout ignored', stderr);

      expect(result.success).toBe(false);
      expect(result.output?.decision).toBe('deny');
      expect(result.output?.reason).toBe('blocked by policy');
      expect(result.output?.hookSpecificOutput).toEqual(hookSpecificOutput);
    });

    it('should fall back to plain text when stderr JSON is invalid on exit code 2', async () => {
      const result = await runHook('exit 2', 2, '', 'plain blocking error');

      expect(result.success).toBe(false);
      expect(result.output?.decision).toBe('deny');
      expect(result.output?.reason).toBe('plain blocking error');
      expect(result.output?.hookSpecificOutput).toBeUndefined();
    });

    it('should handle exit code 1 as non-blocking warning', async () => {
      const result = await runHook('exit 1', 1, '', 'warning');

      expect(result.success).toBe(false);
      expect(result.output?.decision).toBe('allow');
      expect(result.output?.systemMessage).toBe('Warning: warning');
    });

    it('should include duration in result', async () => {
      const result = await runHook('echo test', 0, 'test');

      expect(result.duration).toBeGreaterThanOrEqual(0);
    });

    it('should handle process error', async () => {
      mockSpawn.mockImplementation(() => ({
        stdin: { on: vi.fn(), write: vi.fn(), end: vi.fn() },
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn((event: string, callback: (error: Error) => void) => {
          if (event === 'error') callback(new Error('spawn error'));
        }),
        kill: vi.fn(),
      }));

      const result = await execute('echo test');

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should throw error for prompt hook without config', async () => {
      // hookRunner has no Config, so it cannot execute prompt hooks
      const result = await execute({
        type: HookType.Prompt,
        prompt: 'Test prompt: $ARGUMENTS',
        source: HooksConfigSource.Project,
      });

      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('Prompt hook requires Config');
    });
  });

  describe('execution outcome', () => {
    it.each([
      ['reports success for exit code 0', 0, 'ok', '', 'success'],
      [
        'reports a non-blocking error for exit code 1',
        1,
        '',
        'oops',
        'non_blocking_error',
      ],
      ['reports blocking for exit code 2', 2, '', 'no', 'blocking'],
    ])('%s', async (_title, exitCode, stdout, stderr, outcome) => {
      const result = await runHook('run-hook', exitCode, stdout, stderr);

      expect(result.outcome).toBe(outcome);
    });

    it('reports a missing command as a non-blocking error with its exit code', async () => {
      const result = await runHook(
        'qwen-no-such-cmd-2f9a',
        127,
        '',
        'bash: qwen-no-such-cmd-2f9a: command not found',
      );

      expect(result.exitCode).toBe(127);
      expect(result.outcome).toBe('non_blocking_error');
      expect(result.output?.systemMessage).toMatch(/^Warning: /);
    });

    it('reports a spawn error as a non-blocking error', async () => {
      const mockProcess = spawnControllable();

      const resultPromise = execute('run-hook');
      mockProcess.emit('error', new Error('spawn failed'));
      const result = await resultPromise;

      expect(result.outcome).toBe('non_blocking_error');
    });

    it('reports a signal it did not send as a non-blocking error', async () => {
      const mockProcess = spawnControllable();

      const resultPromise = execute('run-hook');
      mockProcess.emit('close', null);
      const result = await resultPromise;

      expect(result.error?.message).toBe('Hook killed by signal');
      expect(result.outcome).toBe('non_blocking_error');
    });
  });

  describe('executeHooksParallel', () => {
    it('ends an async hook whose hand-off throws instead of rejecting the batch', async () => {
      vi.spyOn(
        hookRunner.getAsyncRegistry(),
        'canAcceptMore',
      ).mockImplementation(() => {
        throw new Error('registry unavailable');
      });

      const results = await expectCallbacks(
        'executeHooksParallel',
        cmd('echo background', { async: true }),
        false,
      );

      expect(results).toHaveLength(1);
      expect(results[0].error?.message).toContain('registry unavailable');
    });

    it('should execute multiple hooks in parallel', async () => {
      scriptSpawn(0, 'result');

      const results = await hookRunner.executeHooksParallel(
        [cmd('echo hook1'), cmd('echo hook2')],
        HookEventName.PreToolUse,
        createMockInput(),
      );

      expect(results).toHaveLength(2);
      expect(results[0].success).toBe(true);
      expect(results[1].success).toBe(true);
    });

    it('should call onHookStart and onHookEnd callbacks', async () => {
      scriptSpawn(0, 'result');
      await expectCallbacks('executeHooksParallel', cmd('echo test'), true);
    });

    // Runs two hooks in sequence, the first printing `firstStdout`, and
    // returns the input the second one read from stdin.
    const chainedInput = async (
      firstStdout: string,
      input: UserPromptExpansionInput | UserPromptSubmitInput,
    ) => {
      const firstProcess = createMockProcess(0, firstStdout);
      const secondProcess = createMockProcess(0, 'result');
      mockSpawn
        .mockImplementationOnce(() => firstProcess)
        .mockImplementationOnce(() => secondProcess);

      await hookRunner.executeHooksSequential(
        [cmd('echo first'), cmd('echo second')],
        input.hook_event_name as HookEventName,
        input,
      );

      const secondInputJson = secondProcess.stdin.write.mock.calls[0]?.[0];
      expect(typeof secondInputJson).toBe('string');
      return JSON.parse(secondInputJson as string) as {
        prompt?: string;
        submitted_prompt?: string;
      };
    };
    const contextOutput = (hookEventName: string, additionalContext: string) =>
      JSON.stringify({
        hookSpecificOutput: { hookEventName, additionalContext },
      });
    const expansionInput = (): UserPromptExpansionInput => ({
      ...createMockInput({
        hook_event_name: HookEventName.UserPromptExpansion,
      }),
      command_name: 'custom',
      command_args: 'with args',
      prompt: 'Base prompt',
    });
    const submitInput = (): UserPromptSubmitInput => ({
      ...createMockInput({ hook_event_name: HookEventName.UserPromptSubmit }),
      prompt: 'Base prompt',
    });

    it('should chain UserPromptExpansion additional context into the next hook input', async () => {
      const secondInput = await chainedInput(
        contextOutput('UserPromptExpansion', 'Hook context'),
        expansionInput(),
      );
      expect(secondInput.prompt).toBe('Base prompt\n\nHook context');
    });

    it('should preserve submitted prompt while chaining UserPromptSubmit context', async () => {
      const secondInput = await chainedInput(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'UserPromptSubmit',
            additionalContext: '<xml><item>raw</item></xml>',
            submitted_prompt: 'forged prompt',
          },
          submitted_prompt: 'another forged prompt',
        }),
        { ...submitInput(), submitted_prompt: 'Submitted prompt' },
      );
      expect(secondInput.prompt).toBe(
        'Base prompt\n\n<xml><item>raw</item></xml>',
      );
      expect(secondInput.submitted_prompt).toBe('Submitted prompt');
    });

    it('should chain plain-text UserPromptSubmit stdout into the next hook input', async () => {
      const secondInput = await chainedInput(
        'Plain hook context\n',
        submitInput(),
      );
      expect(secondInput.prompt).toBe('Base prompt\n\nPlain hook context');
    });

    it('should not append empty UserPromptSubmit additional context', async () => {
      const secondInput = await chainedInput(
        contextOutput('UserPromptSubmit', ''),
        submitInput(),
      );
      expect(secondInput.prompt).toBe('Base prompt');
    });

    it('should truncate UserPromptExpansion context before sanitizing it for chaining', async () => {
      const unsafeContext =
        '<tag>' +
        'x'.repeat(MAX_USER_PROMPT_EXPANSION_ADDITIONAL_CONTEXT_LENGTH);
      const secondInput = await chainedInput(
        contextOutput('UserPromptExpansion', unsafeContext),
        expansionInput(),
      );
      const chainedContext = secondInput.prompt?.replace('Base prompt\n\n', '');
      expect(chainedContext?.startsWith('&lt;tag&gt;')).toBe(true);
      expect(chainedContext).toContain('x'.repeat(9_989));
      expect(chainedContext).not.toContain('<tag>');
      expect(chainedContext).toHaveLength(
        MAX_USER_PROMPT_EXPANSION_ADDITIONAL_CONTEXT_LENGTH,
      );
    });
  });

  describe('executeHooksSequential', () => {
    it('should execute hooks sequentially', async () => {
      scriptSpawn(0, 'result');

      const results = await hookRunner.executeHooksSequential(
        [cmd('echo first'), cmd('echo second')],
        HookEventName.PreToolUse,
        createMockInput(),
      );

      expect(results).toHaveLength(2);
      expect(results[0].success).toBe(true);
      expect(results[1].success).toBe(true);
    });

    it('should call onHookStart and onHookEnd callbacks', async () => {
      scriptSpawn(0, 'result');
      await expectCallbacks('executeHooksSequential', cmd('echo test'), true);
    });

    // The tool_input the second of two PreToolUse hooks reads from stdin.
    const nextToolInput = async (firstOutput: Record<string, unknown>) => {
      const secondProcess = createMockProcess(0, '{}');
      mockSpawn
        .mockImplementationOnce(() =>
          createMockProcess(0, JSON.stringify(firstOutput)),
        )
        .mockImplementationOnce(() => secondProcess);
      await hookRunner.executeHooksSequential(
        [cmd('echo first'), cmd('echo second')],
        HookEventName.PreToolUse,
        createMockInput({
          hook_event_name: HookEventName.PreToolUse,
          tool_input: { path: 'a', keep: true },
        } as Partial<HookInput>),
      );
      return JSON.parse(secondProcess.stdin.write.mock.calls[0]?.[0] as string)
        .tool_input;
    };

    it('passes a PreToolUse updatedInput to the next hook as the whole input', async () => {
      expect(
        await nextToolInput({
          hookSpecificOutput: {
            updatedInput: { path: 'b' },
            tool_input: { legacy: true },
          },
        }),
      ).toEqual({ path: 'b' });
    });

    it('still merges the legacy tool_input into the next hook input', async () => {
      expect(
        await nextToolInput({
          hookSpecificOutput: { tool_input: { path: 'b' } },
        }),
      ).toEqual({ path: 'b', keep: true });
    });

    it('leaves the next hook input unchanged for an invalid updatedInput', async () => {
      expect(
        await nextToolInput({
          hookSpecificOutput: { updatedInput: ['b'], tool_input: { x: 1 } },
        }),
      ).toEqual({ path: 'a', keep: true });
    });

    it('gives each PreToolUse function hook its own input copy', async () => {
      const seen: unknown[] = [];
      const input = createMockInput({
        hook_event_name: HookEventName.PreToolUse,
        tool_input: { path: 'a' },
      } as Partial<HookInput>);
      const fn = (callback: (input: HookInput) => void): HookConfig => ({
        type: HookType.Function,
        errorMessage: 'failed',
        callback: async (hookInput) => {
          callback(hookInput);
          return true;
        },
      });
      await hookRunner.executeHooksSequential(
        [
          fn((hookInput) => {
            (hookInput as PreToolUseInput).tool_input['path'] = 'mutated';
          }),
          fn((hookInput) =>
            seen.push((hookInput as PreToolUseInput).tool_input),
          ),
        ],
        HookEventName.PreToolUse,
        input,
      );
      expect(seen).toEqual([{ path: 'a' }]);
      expect(input).toMatchObject({ tool_input: { path: 'a' } });
    });
  });

  describe('output truncation', () => {
    // MAX_OUTPUT_LENGTH is 1MB; the large outputs are 2MB.
    it('should truncate stdout when exceeding MAX_OUTPUT_LENGTH', async () => {
      const result = await runHook(
        'echo large',
        0,
        'x'.repeat(2 * 1024 * 1024),
      );

      expect(result.stdout?.length).toBeLessThanOrEqual(1024 * 1024);
    });

    it('should truncate stderr when exceeding MAX_OUTPUT_LENGTH', async () => {
      const largeOutput = 'x'.repeat(2 * 1024 * 1024);
      const result = await runHook('echo large', 0, '', largeOutput);

      expect(result.stderr?.length).toBeLessThanOrEqual(1024 * 1024);
    });

    it('should handle partial truncation gracefully', async () => {
      // Output exactly at the limit
      const result = await runHook('echo exact', 0, 'x'.repeat(1024 * 1024));

      expect(result.stdout?.length).toBe(1024 * 1024);
    });
  });

  describe('convertPlainTextToHookOutput', () => {
    it('should convert plain text to allow output on success', async () => {
      const result = await runHook('echo text', 0, 'plain text response');

      expect(result.success).toBe(true);
      expect(result.output?.decision).toBe('allow');
      expect(result.output?.systemMessage).toBe('plain text response');
    });

    it.each([
      HookEventName.SessionStart,
      HookEventName.UserPromptSubmit,
      HookEventName.UserPromptExpansion,
    ])(
      'should route plain-text stdout to additionalContext on %s',
      async (eventName) => {
        const result = await runHook(
          'echo context',
          0,
          'context from hook\n',
          '',
          eventName,
        );

        expect(result.success).toBe(true);
        expect(result.output?.decision).toBe('allow');
        expect(result.output?.systemMessage).toBeUndefined();
        expect(result.output?.hookSpecificOutput).toEqual({
          hookEventName: eventName,
          additionalContext: 'context from hook',
        });
      },
    );

    it.each([
      HookEventName.PreToolUse,
      HookEventName.Stop,
      HookEventName.Notification,
    ])(
      'should keep plain-text stdout as a system message on %s',
      async (eventName) => {
        const result = await runHook(
          'echo text',
          0,
          'plain text response',
          '',
          eventName,
        );

        expect(result.output?.systemMessage).toBe('plain text response');
        expect(result.output?.hookSpecificOutput).toBeUndefined();
      },
    );

    it.each(['42', 'true', 'null', '[1, 2]'])(
      'should treat bare JSON value %s as plain text on SessionStart',
      async (text) => {
        const result = await runHook(
          'echo value',
          0,
          text,
          '',
          HookEventName.SessionStart,
        );

        expect(result.output?.hookSpecificOutput).toEqual({
          hookEventName: HookEventName.SessionStart,
          additionalContext: text,
        });
      },
    );

    it('should keep a bare JSON value as a system message on PreToolUse', async () => {
      const result = await runHook('echo 42', 0, '42');

      expect(result.output?.systemMessage).toBe('42');
      expect(result.output?.hookSpecificOutput).toBeUndefined();
    });

    it('should still block on exit code 2 when stderr is a bare JSON value', async () => {
      const result = await runHook('echo 1 >&2; exit 2', 2, '', '1');

      expect(result.output?.decision).toBe('deny');
      expect(result.output?.reason).toBe('1');
    });

    it('should not promote output shaped like a JSON object that fails to parse', async () => {
      const malformed = '{"decision": "deny",}';
      const result = await runHook(
        'echo malformed',
        0,
        malformed,
        '',
        HookEventName.UserPromptSubmit,
      );

      expect(result.output).toBeUndefined();
      expect(result.success).toBe(false);
      expect(result.outcome).toBe('non_blocking_error');
      expect(result.error?.message).toBe('Hook output is not valid JSON');
    });

    it('should treat truncated JSON on stdout as an error, not context', async () => {
      const result = await runHook(
        'echo truncated',
        0,
        '{"decision": ',
        '',
        HookEventName.UserPromptSubmit,
      );

      expect(result.output).toBeUndefined();
      expect(result.success).toBe(false);
      expect(result.outcome).toBe('non_blocking_error');
      expect(result.error?.message).toBe('Hook output is not valid JSON');
      expect(result.exitCode).toBe(0);
    });

    it('should still block on exit code 2 when stderr starts like broken JSON', async () => {
      const result = await runHook('exit 2', 2, '', '{"reason": ');

      expect(result.outcome).toBe('blocking');
      expect(result.output?.decision).toBe('deny');
      expect(result.output?.reason).toBe('{"reason":');
    });

    it('should strip terminal escapes from promoted context and keep newlines', async () => {
      const result = await runHook(
        'npm test --color=always',
        0,
        '\u001b[31mred\u001b[0m context\nline two\n',
        '',
        HookEventName.SessionStart,
      );

      expect(result.output?.hookSpecificOutput).toEqual({
        hookEventName: HookEventName.SessionStart,
        additionalContext: 'red context\nline two',
      });
    });

    it('should not promote the stderr fallback into SessionStart context', async () => {
      const result = await runHook(
        'echo noise >&2',
        0,
        '',
        'diagnostic noise',
        HookEventName.SessionStart,
      );

      expect(result.output?.systemMessage).toBe('diagnostic noise');
      expect(result.output?.hookSpecificOutput).toBeUndefined();
    });

    it('should keep plain-text stdout of a failed SessionStart hook as a warning', async () => {
      const result = await runHook(
        'echo partial && exit 1',
        1,
        'partial output',
        '',
        HookEventName.SessionStart,
      );

      expect(result.success).toBe(false);
      expect(result.output?.systemMessage).toBe('Warning: partial output');
      expect(result.output?.hookSpecificOutput).toBeUndefined();
    });

    it('should treat non-blocking non-zero exit codes as non-blocking warnings', async () => {
      const result = await runHook('exit 3', 3, '', 'error message');

      expect(result.success).toBe(false);
      expect(result.output?.decision).toBe('allow');
      expect(result.output?.systemMessage).toBe('Warning: error message');
    });

    it('should use stderr when stdout is empty on success', async () => {
      const result = await runHook('echo test', 0, '', 'stderr output');

      expect(result.output?.systemMessage).toBe('stderr output');
    });

    it('should handle empty output gracefully', async () => {
      const result = await runHook('echo test', 0, '', '');

      expect(result.output).toBeUndefined();
    });

    it('should parse nested JSON strings', async () => {
      const nestedJson = JSON.stringify(JSON.stringify({ decision: 'allow' }));
      const result = await runHook('echo json', 0, nestedJson);

      expect(result.output?.decision).toBe('allow');
    });
  });

  describe('process tree cancellation', () => {
    const parentExitSurvivingEvents = [
      HookEventName.MessageDisplay,
      HookEventName.StopFailure,
      HookEventName.SessionDelete,
    ] as const;

    const hookConfig = cmd('long-running-command', { timeout: 10_000 });

    type KillImpl = (pid: number, signal?: string | number) => true;
    const errnoError = (code: string, message: string) =>
      Object.assign(new Error(message), { code });
    const createNoSuchProcessError = () =>
      errnoError('ESRCH', 'no such process');
    const eperm = () => errnoError('EPERM', 'operation not permitted');
    const einval = () => errnoError('EINVAL', 'EINVAL: invalid argument, kill');
    // process.kill stubs; killThrows throws makeError() for `signal` to `pid`.
    const killOk = (): KillImpl => () => true;
    const killThrows =
      (
        pid: number,
        signal: string | number,
        makeError: () => Error,
      ): KillImpl =>
      (target, sig) => {
        if (target === pid && sig === signal) throw makeError();
        return true;
      };
    // The child's process group (-pid) is already gone when probed (signal 0).
    const groupGone = (pid: number) =>
      killThrows(-pid, 0, createNoSuchProcessError);
    // The group answers probes as alive until it has been sent SIGKILL.
    const groupDiesOnSigkill = (pid: number): KillImpl => {
      let groupAlive = true;
      return (target, signal) => {
        if (target === -pid && signal === 0) {
          if (groupAlive) return true;
          throw createNoSuchProcessError();
        }
        if (target === -pid && signal === 'SIGKILL') groupAlive = false;
        return true;
      };
    };
    // The first liveness probe of `pid` passes (taskkill runs); others throw.
    const reprobeThrows = (pid: number, makeError: () => Error): KillImpl => {
      let probes = 0;
      return (target, signal) => {
        if (target === pid && signal === 0 && ++probes > 1) throw makeError();
        return true;
      };
    };

    // A controllable child on linux, with process.kill stubbed by kill(pid).
    const spawnLinuxChild = (
      kill: (pid: number) => KillImpl = groupGone,
      pid?: number,
    ) => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
      const mockProcess = spawnControllable(pid);
      const killSpy = vi
        .spyOn(process, 'kill')
        .mockImplementation(kill(mockProcess.pid));
      return { mockProcess, killSpy };
    };

    // Starts `hookConfig` with an abort signal and aborts it at once.
    const startAborted = (eventName?: HookEventName) => {
      const controller = new AbortController();
      const resultPromise = execute(hookConfig, eventName, controller.signal);
      controller.abort();
      return resultPromise;
    };
    const abortAndClose = (
      mockProcess: { emit: (event: string, ...args: unknown[]) => void },
      eventName?: HookEventName,
    ) => {
      const resultPromise = startAborted(eventName);
      mockProcess.emit('close', null);
      return resultPromise;
    };

    const isSettled = (promise: Promise<unknown>) => {
      let settled = false;
      void promise.then(() => {
        settled = true;
      });
      return () => settled;
    };
    type ParentEvent = 'exit' | NodeJS.Signals;
    const listenersOf = (event: ParentEvent) =>
      process.listeners(event as NodeJS.Signals) as Array<
        (arg: unknown) => void
      >;
    // The listener a hook added to `event` since `before` was captured.
    const addedListener = (event: ParentEvent, before: unknown[]) =>
      listenersOf(event).find((listener) => !before.includes(listener));

    type TaskkillCallback = (error: Error | null) => void;
    const onTaskkill = (handle: (callback: TaskkillCallback) => void) =>
      mockExecFile.mockImplementation(
        (
          _file: string,
          _args: string[],
          _options: object,
          callback: TaskkillCallback,
        ) => handle(callback),
      );
    const expectTaskkilled = (pid: number) =>
      expect(mockExecFile).toHaveBeenCalledWith(
        expect.stringMatching(/\\System32\\taskkill\.exe$/i),
        ['/f', '/t', '/pid', String(pid)],
        expect.anything(),
        expect.any(Function),
      );
    const expectNotTaskkilled = (pid: number) =>
      expect(mockExecFile).not.toHaveBeenCalledWith(
        expect.anything(),
        ['/f', '/t', '/pid', String(pid)],
        expect.anything(),
        expect.anything(),
      );

    it.each(parentExitSurvivingEvents)(
      'uses a detached parent-independent supervisor for synchronous and async %s hooks',
      async (eventName) => {
        mockSpawn.mockImplementation(() => createMockProcess());

        await execute(hookConfig, eventName);
        await execute({ ...hookConfig, async: true }, eventName);

        expect(mockSpawn).toHaveBeenCalledTimes(2);
        for (const call of mockSpawn.mock.calls) {
          expect(call[0]).toBe(process.execPath);
          expect(call[1]).toContain('--eval');
          expect(call[2].stdio).toEqual(['ignore', 'ignore', 'ignore', 'pipe']);
          expect(call[2].detached).toBe(true);
        }
        for (const result of mockSpawn.mock.results) {
          expect(result.value.unref).toHaveBeenCalledOnce();
        }
      },
    );

    it('removes staged input when the supervisor spawn throws', async () => {
      const tempDir = await mkdtemp(join(tmpdir(), 'qwen-hook-spawn-error-'));
      vi.stubEnv('TMPDIR', tempDir);
      mockSpawn.mockImplementation(() => {
        throw new Error('spawn failed');
      });

      try {
        const result = await execute(hookConfig, HookEventName.SessionDelete);

        expect(result.error?.message).toBe('spawn failed');
        expect(await readdir(tempDir)).toEqual([]);
      } finally {
        vi.unstubAllEnvs();
        await rm(tempDir, { recursive: true, force: true });
      }
    });

    it('keeps output capture for process-scoped async hooks', async () => {
      await runHook({ ...hookConfig, async: true });

      expect(mockSpawn.mock.calls[0][2].stdio).toEqual([
        'pipe',
        'pipe',
        'pipe',
      ]);
    });

    it.each(parentExitSurvivingEvents)(
      'still cancels a parent-exit-surviving %s hook',
      async (eventName) => {
        const { mockProcess, killSpy } = spawnLinuxChild();

        const result = await abortAndClose(mockProcess, eventName);

        expect(result.error?.message).toBe(
          'Hook execution cancelled (aborted)',
        );
        expect(killSpy).toHaveBeenCalledWith(-mockProcess.pid, 'SIGTERM');
      },
    );

    // Aborts a Windows hook whose supervisor reported `survivingPid` over fd 3,
    // with process.kill stubbed by `kill`, taskkill failing if `taskkillFails`,
    // and the supervisor already exited if `supervisorExitCode` is given.
    const cancelWindowsSurvivingHook = async (
      survivingPid: number,
      {
        kill = killOk(),
        taskkillFails = false,
        eventName = HookEventName.StopFailure,
        supervisorExitCode,
      }: {
        kill?: KillImpl;
        taskkillFails?: boolean;
        eventName?: (typeof parentExitSurvivingEvents)[number];
        supervisorExitCode?: number;
      } = {},
    ) => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(kill);
      onTaskkill((callback) =>
        callback(taskkillFails ? new Error('ERROR_ACCESS_DENIED') : null),
      );
      const statusListeners: Array<(chunk: Buffer) => void> = [];
      const mockProcess = createControllableMockProcess();
      (mockProcess as unknown as { stdio: unknown[] }).stdio = [
        null,
        null,
        null,
        {
          on: vi.fn((event: string, callback: (chunk: Buffer) => void) => {
            if (event === 'data') statusListeners.push(callback);
          }),
          unref: vi.fn(),
        },
      ];
      mockSpawn.mockReturnValue(mockProcess);
      const controller = new AbortController();
      const resultPromise = execute(hookConfig, eventName, controller.signal);
      for (const listener of statusListeners) {
        listener(Buffer.from(`pid:${survivingPid}\n`));
      }
      if (supervisorExitCode !== undefined) {
        (mockProcess as unknown as { exitCode: number }).exitCode =
          supervisorExitCode;
      }
      controller.abort();
      mockProcess.emit('close', supervisorExitCode ?? null);
      await resultPromise;
      return { killSpy, mockProcess };
    };

    it.each(parentExitSurvivingEvents)(
      'tree-kills the surviving %s hook on Windows instead of leaving it behind',
      async (eventName) => {
        // terminateSurvivingHookProcessGroup used to return at once on win32,
        // so nothing reaped the hook's cmd.exe tree: the detached supervisor
        // may be gone, leaving the shell outside its own tree kill (#11303).
        const survivingPid = 9911;
        const { killSpy } = await cancelWindowsSurvivingHook(survivingPid, {
          eventName,
        });

        expect(mockExecFile).toHaveBeenCalledWith(
          expect.stringMatching(/\\System32\\taskkill\.exe$/i),
          ['/f', '/t', '/pid', String(survivingPid)],
          expect.objectContaining({ windowsHide: true }),
          expect.any(Function),
        );
        // No pid SIGKILL after a successful taskkill: the dead pid is at once
        // recyclable, so it would hit an unrelated process (#6067).
        expect(killSpy).not.toHaveBeenCalledWith(survivingPid, 'SIGKILL');
        // Nor the POSIX group path: it signals -pid, then signalFallback the
        // positive pid with no liveness re-probe at all.
        expect(killSpy).not.toHaveBeenCalledWith(
          -survivingPid,
          expect.anything(),
        );
      },
    );

    it('does not taskkill a surviving Windows hook whose pid already exited', async () => {
      // Windows has no process group, so taskkilling an exited pid could hit a
      // recycled one (#6067 collateral kill); the liveness probe guards it.
      const survivingPid = 9912;
      await cancelWindowsSurvivingHook(survivingPid, {
        kill: killThrows(survivingPid, 0, createNoSuchProcessError),
      });

      expectNotTaskkilled(survivingPid);
      // The proven-gone skip stays silent; only an unknown probe failure warns.
      expect(mockDebugLogger.warn).not.toHaveBeenCalledWith(
        expect.stringContaining(`surviving hook ${survivingPid}`),
      );
    });

    it('does not taskkill an exited Windows hook supervisor', async () => {
      const { mockProcess } = await cancelWindowsSurvivingHook(9913, {
        supervisorExitCode: 0,
      });

      expectNotTaskkilled(mockProcess.pid);
      // The surviving pid is still reaped though the supervisor exited: gating
      // the reap on `survivingHookPid && child.exitCode === null` would skip
      // it, leaving the hook's cmd.exe tree running.
      expectTaskkilled(9913);
    });

    it('falls back to a direct SIGKILL when taskkill of a surviving Windows hook fails', async () => {
      // taskkillProcessTree resolves false when execFile errors (e.g.
      // ERROR_ACCESS_DENIED from an elevated or AV-intercepted System32) or
      // passes its 2s timeout; ignoring that leaves the cmd.exe tree unreaped.
      const survivingPid = 9913;
      const { killSpy } = await cancelWindowsSurvivingHook(survivingPid, {
        taskkillFails: true,
      });

      // The liveness probe (signal 0) passed, so taskkill was attempted.
      expectTaskkilled(survivingPid);
      expect(killSpy).toHaveBeenCalledWith(survivingPid, 'SIGKILL');
    });

    it('does not directly SIGKILL a surviving Windows hook pid that taskkill reported dead', async () => {
      // taskkillProcessTree also resolves false for an already-dead pid, and a
      // pid fallback could then hit a recycled pid (#6067): the liveness
      // re-probe after taskkill must skip it.
      const survivingPid = 9914;
      const { killSpy } = await cancelWindowsSurvivingHook(survivingPid, {
        kill: reprobeThrows(survivingPid, createNoSuchProcessError),
        taskkillFails: true,
      });

      expectTaskkilled(survivingPid);
      expect(killSpy).not.toHaveBeenCalledWith(survivingPid, 'SIGKILL');
    });

    it('warns and skips the SIGKILL fallback when the liveness re-probe fails unexpectedly', async () => {
      // The re-probe classifies like the first probe: an errno other than
      // ESRCH (gone) or EPERM/EACCES (alive but denied) proves nothing, so the
      // fallback is skipped (#6067 recycled-pid risk) — but with a warning, or
      // a host-level probe failure leaves the cmd.exe tree running untraced.
      const survivingPid = 9919;
      const { killSpy } = await cancelWindowsSurvivingHook(survivingPid, {
        kill: reprobeThrows(survivingPid, einval),
        taskkillFails: true,
      });

      const probes = killSpy.mock.calls.filter(
        ([target, signal]) => target === survivingPid && signal === 0,
      );
      expect(probes).toHaveLength(2);
      expect(killSpy).not.toHaveBeenCalledWith(survivingPid, 'SIGKILL');
      expect(mockDebugLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining(`surviving hook ${survivingPid}`),
      );
      expect(mockDebugLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('EINVAL'),
      );
    });

    it('still reaps a surviving Windows hook whose liveness probe is denied', async () => {
      // On Windows an elevated or protected hook fails process.kill(pid, 0)
      // with EPERM, not ESRCH: it exists but cannot be opened. That is alive;
      // treating it as dead would leave its cmd.exe tree running (#11303).
      const survivingPid = 9915;
      await cancelWindowsSurvivingHook(survivingPid, {
        kill: killThrows(survivingPid, 0, eperm),
      });

      expectTaskkilled(survivingPid);
    });

    it('does not taskkill a surviving Windows hook whose liveness probe fails unexpectedly', async () => {
      // A probe error other than ESRCH (gone) or EPERM/EACCES (exists but
      // denied) proves nothing, so the reap skips the pid (#6067 recycled-pid
      // risk) — but must warn, or a host-level probe failure leaves the
      // cmd.exe tree running (#11303) untraced.
      const survivingPid = 9916;
      await cancelWindowsSurvivingHook(survivingPid, {
        kill: killThrows(survivingPid, 0, einval),
      });

      expectNotTaskkilled(survivingPid);
      expect(mockDebugLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining(`surviving hook ${survivingPid}`),
      );
      // The errno is the datum that tells EMFILE (our handle budget) apart
      // from ENOMEM (the host) or libuv's UV_UNKNOWN; the warn must carry it.
      expect(mockDebugLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('EINVAL'),
      );
    });

    it('warns when the SIGKILL fallback is refused for a surviving Windows hook', async () => {
      // An elevated or AV-protected hook refuses OpenProcess(PROCESS_TERMINATE)
      // with EPERM, like the probe. The re-probe said alive, so a silent
      // refusal would be a #11303-class leak with no log line.
      const survivingPid = 9917;
      const { killSpy } = await cancelWindowsSurvivingHook(survivingPid, {
        kill: killThrows(survivingPid, 'SIGKILL', eperm),
        taskkillFails: true,
      });

      expect(killSpy).toHaveBeenCalledWith(survivingPid, 'SIGKILL');
      expect(mockDebugLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining(
          `SIGKILL fallback failed for surviving hook ${survivingPid}`,
        ),
      );
    });

    it('stays silent when the SIGKILL fallback finds the surviving Windows hook already gone', async () => {
      const survivingPid = 9918;
      const { killSpy } = await cancelWindowsSurvivingHook(survivingPid, {
        kill: killThrows(survivingPid, 'SIGKILL', createNoSuchProcessError),
        taskkillFails: true,
      });

      expect(killSpy).toHaveBeenCalledWith(survivingPid, 'SIGKILL');
      expect(mockDebugLogger.warn).not.toHaveBeenCalledWith(
        expect.stringContaining('SIGKILL fallback failed'),
      );
    });

    it('owns a POSIX process group without signalling it on normal completion', async () => {
      const killSpy = vi.spyOn(process, 'kill');

      const result = await runHook(hookConfig, 0, 'done');

      expect(result.success).toBe(true);
      expect(mockSpawn.mock.calls[0][2].detached).toBe(
        process.platform !== 'win32',
      );
      // Hiding the console is a Windows-only flag: nothing changes for POSIX
      // users, who keep the process group they rely on for cancellation.
      expect(mockSpawn.mock.calls[0][2].windowsHide).toBe(
        process.platform === 'win32',
      );
      expect(killSpy).not.toHaveBeenCalled();
    });

    it('force-kills an active POSIX hook group when the parent exits', async () => {
      const events = [
        'exit',
        'SIGHUP',
        'SIGINT',
        'SIGQUIT',
        'SIGTERM',
      ] as const;
      const listenersBefore = events.map((event) => listenersOf(event));
      const { mockProcess, killSpy } = spawnLinuxChild(killOk);

      const resultPromise = execute(hookConfig);
      const exitListener = addedListener('exit', listenersBefore[0]);

      expect(exitListener).toBeDefined();
      exitListener?.(0);
      expect(killSpy).toHaveBeenCalledWith(-mockProcess.pid, 'SIGKILL');

      mockProcess.emit('close', null);
      await resultPromise;
      events.forEach((event, i) =>
        expect(listenersOf(event)).toEqual(listenersBefore[i]),
      );
    });

    it.each([0, 1, -1, -42, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
      'never signals a process group for invalid child PID %s',
      async (pid) => {
        const before = process.listeners('exit');
        const { mockProcess: child, killSpy } = spawnLinuxChild(killOk, pid);
        const controller = new AbortController();
        const result = execute(hookConfig, undefined, controller.signal);
        try {
          addedListener('exit', before)?.(0);
          controller.abort();
        } finally {
          child.emit('close', null);
          await result;
        }
        expect(killSpy).not.toHaveBeenCalled();
        expect(process.listeners('exit')).toEqual(before);
        // A rejected pid leaves the group running, so the skip must not vanish
        // without a trace. 0 and NaN are already short-circuited by the `!pid`
        // branch in terminatePosixHookProcessTree and never reach this guard.
        if (pid) {
          expect(mockDebugLogger.warn).toHaveBeenCalledWith(
            expect.stringContaining(
              `hook process group ${pid}: not a safe integer greater than 1`,
            ),
          );
        }
      },
    );

    it('kills active hooks while leaving parent signals to an application handler', async () => {
      const exitListenersBefore = process.listeners('exit');
      const listenersBefore = process.listeners('SIGTERM');
      const { mockProcess, killSpy } = spawnLinuxChild(killOk);
      const applicationHandler = vi.fn();
      process.on('SIGTERM', applicationHandler);

      try {
        const resultPromise = execute(hookConfig);
        const hookSignalHandler = process
          .listeners('SIGTERM')
          .find(
            (listener) =>
              listener !== applicationHandler &&
              !listenersBefore.includes(listener),
          );
        const exitListener = addedListener('exit', exitListenersBefore);

        expect(hookSignalHandler).toBeDefined();
        expect(exitListener).toBeDefined();
        hookSignalHandler?.('SIGTERM');
        expect(killSpy).toHaveBeenCalledWith(-mockProcess.pid, 'SIGKILL');
        expect(killSpy).not.toHaveBeenCalledWith(process.pid, 'SIGTERM');
        expect(process.listeners('exit')).toContain(exitListener);

        mockProcess.emit('close', 0);
        await resultPromise;
      } finally {
        process.removeListener('SIGTERM', applicationHandler);
      }
    });

    it.each(['SIGHUP', 'SIGINT', 'SIGQUIT'] as const)(
      'force-kills active hooks and re-raises %s when unhandled',
      async (signal) => {
        const listenersBefore = process.listeners(signal);
        const { mockProcess, killSpy } = spawnLinuxChild(killOk);

        const resultPromise = execute(hookConfig);
        const hookSignalHandler = addedListener(signal, listenersBefore);

        expect(hookSignalHandler).toBeDefined();
        hookSignalHandler?.(signal);
        expect(killSpy).toHaveBeenCalledWith(-mockProcess.pid, 'SIGKILL');
        expect(killSpy).toHaveBeenCalledWith(process.pid, signal);

        mockProcess.emit('close', null);
        await resultPromise;
      },
    );

    it('keeps parent cleanup registered while another hook is active', async () => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
      const exitListenersBefore = process.listeners('exit');
      const firstProcess = createControllableMockProcess(4321);
      const secondProcess = createControllableMockProcess(4322);
      mockSpawn
        .mockReturnValueOnce(firstProcess)
        .mockReturnValueOnce(secondProcess);
      const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true);

      const firstResult = execute(hookConfig);
      const secondResult = execute(hookConfig);
      firstProcess.emit('close', 0);
      await firstResult;
      const exitListener = addedListener('exit', exitListenersBefore);

      expect(exitListener).toBeDefined();
      exitListener?.(0);
      expect(killSpy).toHaveBeenCalledWith(-secondProcess.pid, 'SIGKILL');

      secondProcess.emit('close', 0);
      await secondResult;
    });

    it('escalates to SIGKILL for the process group even after the root closes', async () => {
      vi.useFakeTimers();
      const { mockProcess, killSpy } = spawnLinuxChild(groupDiesOnSigkill);

      const resultPromise = startAborted();
      mockProcess.emit('close', null);
      const resolved = isSettled(resultPromise);
      await vi.advanceTimersByTimeAsync(1999);
      expect(resolved()).toBe(false);
      expect(killSpy.mock.calls).not.toContainEqual([
        -mockProcess.pid,
        'SIGKILL',
      ]);
      await vi.advanceTimersByTimeAsync(1);
      const result = await resultPromise;

      expect(result.error?.message).toBe('Hook execution cancelled (aborted)');
      expect(result.outcome).toBe('cancelled');
      expect(killSpy.mock.calls).toContainEqual([-mockProcess.pid, 'SIGTERM']);
      expect(killSpy.mock.calls).toContainEqual([-mockProcess.pid, 'SIGKILL']);
    });

    it('does not send SIGKILL when the process group exits after SIGTERM', async () => {
      const { mockProcess, killSpy } = spawnLinuxChild();

      const result = await abortAndClose(mockProcess);

      expect(result.error?.message).toBe('Hook execution cancelled (aborted)');
      expect(killSpy.mock.calls).toContainEqual([-mockProcess.pid, 'SIGTERM']);
      expect(killSpy.mock.calls).not.toContainEqual([
        -mockProcess.pid,
        'SIGKILL',
      ]);
    });

    it('returns the timeout result after process group cleanup', async () => {
      vi.useFakeTimers();
      const { mockProcess, killSpy } = spawnLinuxChild();

      const resultPromise = execute({ ...hookConfig, timeout: 0.1 });
      await vi.advanceTimersByTimeAsync(100);
      mockProcess.emit('close', null);
      const result = await resultPromise;

      expect(result.error?.message).toBe('Hook timed out after 0.1s');
      expect(result.outcome).toBe('timeout');
      expect(killSpy.mock.calls).toContainEqual([-mockProcess.pid, 'SIGTERM']);
    });

    // Runs `config` on linux under fake timers, checks it is still pending
    // 1ms before `timeoutMs`, and returns its result once that has passed.
    const runPastTimeout = async (config: HookConfig, timeoutMs: number) => {
      vi.useFakeTimers();
      const { mockProcess } = spawnLinuxChild();
      const resultPromise = execute(config);
      const settled = isSettled(resultPromise);
      await vi.advanceTimersByTimeAsync(timeoutMs - 1);
      expect(settled()).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      mockProcess.emit('close', null);
      return resultPromise;
    };

    it('reads timeout in seconds with a 60 second default', async () => {
      const result = await runPastTimeout(cmd('long-running-command'), 60_000);

      expect(result.error?.message).toBe('Hook timed out after 60s');
    });

    it.each([
      [undefined, '60000'],
      [10, '10000'],
    ])(
      'hands the SessionDelete supervisor a millisecond deadline for timeout %s',
      async (timeout, expectedArg) => {
        scriptSpawn();

        await execute(
          cmd('cleanup-session', timeout === undefined ? {} : { timeout }),
          HookEventName.SessionDelete,
        );

        const args = mockSpawn.mock.calls[0]?.[1] as string[];
        // --eval, supervisor source, input path, then the deadline.
        expect(args[args.indexOf('--eval') + 3]).toBe(expectedArg);
      },
    );

    it('rejects broadcast PIDs inside the detached supervisor too', async () => {
      scriptSpawn();
      await execute(hookConfig, HookEventName.SessionDelete);
      const args = mockSpawn.mock.calls[0][1] as string[];
      const source = args[args.indexOf('--eval') + 1];
      const start = source.indexOf('const signalGroup =');
      const end = source.indexOf('const waitForGroupExit =');
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      const pids = [0, 1, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1];
      for (const pid of pids) {
        const kill = vi.fn();
        const childKill = vi.fn();
        runInNewContext(
          source.slice(start, end) + '\nsignalGroup("SIGKILL"); groupAlive();',
          {
            hook: { pid, kill: childKill },
            process: { platform: 'linux', kill },
          },
        );
        expect(kill).not.toHaveBeenCalled();
        expect(childKill).not.toHaveBeenCalled();
      }
    });

    it('registers async hooks with the resolved millisecond timeout', async () => {
      scriptSpawn();
      const register = vi.spyOn(hookRunner['asyncRegistry'], 'register');

      await hookRunner.executeHook(
        cmd('long-running-command', { async: true, timeout: 30 }),
        HookEventName.PostToolUse,
        createMockInput(),
      );

      expect(register).toHaveBeenCalledWith(
        expect.objectContaining({ timeout: 30_000 }),
      );
    });

    it('reads a timeout of 1000 or more as legacy milliseconds', async () => {
      const result = await runPastTimeout(
        { ...hookConfig, timeout: 2000 },
        2000,
      );

      expect(result.error?.message).toBe('Hook timed out after 2s');
    });

    it('shares one termination when timeout and abort race, with abort taking precedence', async () => {
      vi.useFakeTimers();
      const { mockProcess, killSpy } = spawnLinuxChild(groupDiesOnSigkill);
      const controller = new AbortController();

      const resultPromise = execute(
        { ...hookConfig, timeout: 0.1 },
        undefined,
        controller.signal,
      );
      await vi.advanceTimersByTimeAsync(100);
      controller.abort();
      await vi.advanceTimersByTimeAsync(2000);
      mockProcess.emit('close', null);
      const result = await resultPromise;

      const groupSignals = (signal: string) =>
        killSpy.mock.calls.filter(
          ([target, sig]) => target === -mockProcess.pid && sig === signal,
        );
      expect(result.error?.message).toBe('Hook execution cancelled (aborted)');
      expect(groupSignals('SIGTERM')).toHaveLength(1);
      expect(groupSignals('SIGKILL')).toHaveLength(1);
    });

    it('tree-kills through the absolute taskkill path on Windows', async () => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
      let taskkillCallback: TaskkillCallback | undefined;
      onTaskkill((callback) => {
        taskkillCallback = callback;
      });
      const mockProcess = spawnControllable();

      const resultPromise = abortAndClose(mockProcess);
      const resolved = isSettled(resultPromise);
      await Promise.resolve();

      expect(resolved()).toBe(false);
      taskkillCallback?.(null);
      const result = await resultPromise;

      expect(result.error?.message).toBe('Hook execution cancelled (aborted)');
      expect(mockSpawn.mock.calls[0][2].detached).toBe(false);
      // The hook child is created without hiding its console, while the very
      // same file hides the console of the taskkill child used to reap it. On
      // Windows the hook child therefore inherits the parent's ConPTY console,
      // so a `powershell -WindowStyle Hidden` hook minimizes Windows Terminal.
      expect(mockSpawn.mock.calls[0][2].windowsHide).toBe(true);
      expect(mockExecFile).toHaveBeenCalledWith(
        expect.stringMatching(/\\System32\\taskkill\.exe$/i),
        ['/f', '/t', '/pid', mockProcess.pid.toString()],
        {
          windowsHide: true,
          timeout: 2000,
        },
        expect.any(Function),
      );
      expect(mockProcess.kill).not.toHaveBeenCalled();
    });

    it('falls back to killing the direct child when taskkill fails', async () => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
      onTaskkill((callback) => callback(new Error('taskkill failed')));
      const mockProcess = spawnControllable();

      await abortAndClose(mockProcess);

      expect(mockProcess.kill).toHaveBeenCalledOnce();
      expect(mockProcess.kill).toHaveBeenCalledWith('SIGKILL');
    });

    it('falls back to the direct child when POSIX group signals fail', async () => {
      vi.useFakeTimers();
      const permissionError = errnoError('EPERM', 'not permitted');
      // The group probe passes, but every signal to the group is refused.
      const { mockProcess } = spawnLinuxChild((pid) => (target, signal) => {
        if (target === -pid && signal === 0) return true;
        if (target === -pid) throw permissionError;
        return true;
      });

      const resultPromise = abortAndClose(mockProcess);
      await vi.advanceTimersByTimeAsync(2000);
      await resultPromise;

      expect(mockProcess.kill).toHaveBeenCalledWith('SIGTERM');
      expect(mockProcess.kill).toHaveBeenCalledWith('SIGKILL');
    });

    it('force-kills the direct child when cancellation has no pid', async () => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
      const mockProcess = {
        ...createControllableMockProcess(),
        pid: undefined,
      };
      mockSpawn.mockReturnValue(mockProcess);

      await abortAndClose(mockProcess);

      expect(mockProcess.kill).toHaveBeenCalledOnce();
      expect(mockProcess.kill).toHaveBeenCalledWith('SIGKILL');
    });

    it('falls back to the direct child when taskkill throws synchronously', async () => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
      mockExecFile.mockImplementation(() => {
        throw new Error('EMFILE');
      });
      const mockProcess = spawnControllable();

      await abortAndClose(mockProcess);

      expect(mockProcess.kill).toHaveBeenCalledOnce();
      expect(mockProcess.kill).toHaveBeenCalledWith('SIGKILL');
    });

    it('waits for close after a cancellation-time child error', async () => {
      vi.useFakeTimers();
      const { mockProcess } = spawnLinuxChild();

      const resultPromise = startAborted();
      mockProcess.emit('error', new Error('signal delivery failed'));
      mockProcess.stdout.emitData(Buffer.from('final stdout'));
      const resolved = isSettled(resultPromise);
      await vi.advanceTimersByTimeAsync(0);

      expect(resolved()).toBe(false);
      mockProcess.emit('close', null);
      const result = await resultPromise;

      expect(result.stdout).toBe('final stdout');
    });

    it('drains final output before resolving cancellation', async () => {
      const { mockProcess } = spawnLinuxChild();

      const resultPromise = startAborted();
      mockProcess.stdout.emitData(Buffer.from('final stdout'));
      mockProcess.stderr.emitData(Buffer.from('final stderr'));
      const resolved = isSettled(resultPromise);
      await Promise.resolve();
      await Promise.resolve();

      expect(resolved()).toBe(false);
      mockProcess.emit('close', null);
      const result = await resultPromise;

      expect(result.stdout).toBe('final stdout');
      expect(result.stderr).toBe('final stderr');
      expect(mockProcess.stdout.destroy).not.toHaveBeenCalled();
      expect(mockProcess.stderr.destroy).not.toHaveBeenCalled();
    });

    it('bounds the output drain wait when close never arrives', async () => {
      vi.useFakeTimers();
      const { mockProcess } = spawnLinuxChild();

      const resultPromise = startAborted();
      const resolved = isSettled(resultPromise);
      await vi.advanceTimersByTimeAsync(999);
      expect(resolved()).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const result = await resultPromise;

      expect(result.error?.message).toBe('Hook execution cancelled (aborted)');
      expect(mockProcess.stdin.destroy).toHaveBeenCalledOnce();
      expect(mockProcess.stdout.destroy).toHaveBeenCalledOnce();
      expect(mockProcess.stderr.destroy).toHaveBeenCalledOnce();
    });

    it('removes cancellation handling after a spawn error', async () => {
      const mockProcess = spawnControllable();
      const killSpy = vi.spyOn(process, 'kill');
      const controller = new AbortController();

      const resultPromise = execute(hookConfig, undefined, controller.signal);
      mockProcess.emit('error', new Error('spawn failed'));
      const result = await resultPromise;
      controller.abort();

      expect(result.error?.message).toBe('spawn failed');
      expect(killSpy).not.toHaveBeenCalled();
    });
  });

  describe('shell configuration', () => {
    it('should use global shell configuration when hookConfig.shell is not specified', async () => {
      await runHook('echo test', 0, '{"continue": true}');

      expect(mockSpawn).toHaveBeenCalled();
      // Global config uses bash or cmd depending on platform
      expect(mockSpawn.mock.calls[0][2].shell).toBe(false);
    });

    it('should use bash shell when hookConfig.shell is bash', async () => {
      await runHook(
        cmd('echo test', { shell: 'bash' }),
        0,
        '{"continue": true}',
      );

      expect(mockSpawn).toHaveBeenCalled();
      const spawnArgs = mockSpawn.mock.calls[0];
      expect(spawnArgs[0]).toMatch(/bash/);
      expect(spawnArgs[1]).toContain('-c');
      expect(spawnArgs[2].shell).toBe(false);
    });

    it('should use powershell when hookConfig.shell is powershell', async () => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
      await runHook(
        cmd('Write-Output test', { shell: 'powershell' }),
        0,
        '{"continue": true}',
      );

      expect(mockSpawn).toHaveBeenCalled();
      const spawnArgs = mockSpawn.mock.calls[0];
      expect(spawnArgs[0]).toBe(
        'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      );
      expect(spawnArgs[1]).toEqual([
        '-NoProfile',
        '-Command',
        "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;Set-StrictMode -Version 1; $ErrorActionPreference = 'Stop'; $global:LASTEXITCODE = $null; Write-Output test",
      ]);
      expect(spawnArgs[2].shell).toBe(false);
    });

    it('omits the encoding statement for a powershell hook off Windows', async () => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
      mockSpawn.mockImplementation(() => createMockProcess(0));
      await hookRunner.executeHook(
        {
          type: HookType.Command,
          command: 'Write-Output test',
          source: HooksConfigSource.Project,
          shell: 'powershell',
        },
        HookEventName.PreToolUse,
        createMockInput(),
      );
      const command = mockSpawn.mock.calls[0][1][2];
      expect(command).not.toContain('[Console]::OutputEncoding');
      expect(command).toContain(
        "Set-StrictMode -Version 1; $ErrorActionPreference = 'Stop'; $global:LASTEXITCODE = $null; Write-Output test",
      );
    });

    it('uses powershell when the global shell is cmd', async () => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
      const spy = mockCmdShellConfig();
      try {
        mockSpawn.mockImplementation(() => createMockProcess(0));
        await hookRunner.executeHook(
          {
            type: HookType.Command,
            command: 'echo test',
            source: HooksConfigSource.Project,
          },
          HookEventName.PreToolUse,
          createMockInput(),
        );
        const spawnArgs = mockSpawn.mock.calls[0];
        expect(spawnArgs[0]).toBe(
          'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        );
        expect(spawnArgs[1]).toEqual([
          '-NoProfile',
          '-Command',
          "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;Set-StrictMode -Version 1; $ErrorActionPreference = 'Stop'; $global:LASTEXITCODE = $null; echo test",
        ]);
        // cmd.exe keeps the inner quotes that PowerShell drops.
        await hookRunner.executeHook(
          {
            type: HookType.Command,
            command: 'bash "C:/Program Files/app/script.sh" arg',
            source: HooksConfigSource.Project,
          },
          HookEventName.PreToolUse,
          createMockInput(),
        );
        expect(mockSpawn.mock.calls[1][0]).toBe(
          'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        );
        expect(mockSpawn.mock.calls[1][1]).toEqual([
          '-NoProfile',
          '-Command',
          `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;Set-StrictMode -Version 1; $ErrorActionPreference = 'Stop'; $global:LASTEXITCODE = $null; bash "C:/Program Files/app/script.sh" arg`,
        ]);
      } finally {
        spy.mockRestore();
      }
    });

    it('passes the env-var form through for an explicit powershell shell', async () => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
      mockSpawn.mockImplementation(() => createMockProcess(0));
      await hookRunner.executeHook(
        {
          type: HookType.Command,
          command: '$env:CLAUDE_PROJECT_DIR/scripts/validate.cmd',
          source: HooksConfigSource.Project,
          shell: 'powershell',
        },
        HookEventName.PreToolUse,
        createMockInput({ cwd: '/test/project' }),
      );
      const spawnArgs = mockSpawn.mock.calls[0];
      expect(spawnArgs[0]).toBe(
        'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      );
      expect(spawnArgs[1][2]).toBe(
        "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;Set-StrictMode -Version 1; $ErrorActionPreference = 'Stop'; $global:LASTEXITCODE = $null; $env:CLAUDE_PROJECT_DIR/scripts/validate.cmd",
      );
    });

    it('uses the same powershell config for explicit shell and cmd fallback', async () => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
      const spy = mockCmdShellConfig();
      try {
        mockSpawn.mockImplementation(() => createMockProcess(0));
        await hookRunner.executeHook(
          {
            type: HookType.Command,
            command: 'Write-Output explicit',
            source: HooksConfigSource.Project,
            shell: 'powershell',
          },
          HookEventName.PreToolUse,
          createMockInput(),
        );
        const explicitArgs = mockSpawn.mock.calls[0][1];
        await hookRunner.executeHook(
          {
            type: HookType.Command,
            command: 'Write-Output fallback',
            source: HooksConfigSource.Project,
          },
          HookEventName.PreToolUse,
          createMockInput(),
        );
        const fallbackArgs = mockSpawn.mock.calls[1][1];
        expect(mockSpawn.mock.calls[1][0]).toBe(mockSpawn.mock.calls[0][0]);
        expect(fallbackArgs.slice(0, 2)).toEqual(explicitArgs.slice(0, 2));
        expect(explicitArgs[2]).toBe(
          "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;Set-StrictMode -Version 1; $ErrorActionPreference = 'Stop'; $global:LASTEXITCODE = $null; Write-Output explicit",
        );
        expect(fallbackArgs[2]).toBe(
          "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;Set-StrictMode -Version 1; $ErrorActionPreference = 'Stop'; $global:LASTEXITCODE = $null; Write-Output fallback",
        );
      } finally {
        spy.mockRestore();
      }
    });

    it.each([
      ['a continuation backtick at the end', 'Write-Output tail `'],
      [
        'a literal backtick inside a trailing comment',
        'Write-Output gate `gate.sh` # same as `gate.sh`',
      ],
      ['a backtick followed by spaces at the end', 'Write-Output tail `  '],
      ['two backticks at the end', 'Write-Output literal ``'],
    ])(
      'runs a PowerShell command whose body ends with backticks: %s',
      async (_label, command) => {
        vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
        mockSpawn.mockImplementation(() => createMockProcess(0));
        await hookRunner.executeHook(
          {
            type: HookType.Command,
            command,
            source: HooksConfigSource.Project,
            shell: 'powershell',
          },
          HookEventName.PreToolUse,
          createMockInput(),
        );
        expect(mockSpawn.mock.calls[0][1][2]).toContain(command);
      },
    );

    it.each([
      ['call-operator prefix on quoted .cmd', '& "C:\\hook.cmd"'],
      ['command with quoted arguments', 'Get-Process "name"'],
      ['write-output with quoted argument', 'Write-Output "hello"'],
      ['cmd-style invocation with quoted tail', 'cmd /c "echo hello"'],
      ['bare-quoted no-extension command', '"foo"'],
      [
        'multi-line array of paths with bare-quoted .cmd',
        '"C:\\path1.cmd"\n"C:\\path2.cmd"\n"C:\\path3.cmd"',
      ],
      [
        'statement after a bare-quoted .cmd on the next line',
        '"C:\\hooks\\check.cmd"\nWrite-Output done',
      ],
      ['bare-quoted .sh path', '"C:\\hooks\\gate.sh"'],
      [
        'backtick-continued quoted path as argument',
        'Get-Process "C:\\long `\n` path\\app.cmd"',
      ],
      [
        'bare-quoted path whose name merely contains .exe / .cmd',
        '"C:\\build\\app.exe.log" | Get-Content',
      ],
      [
        'bare-quoted path whose name merely contains .cmd',
        '"C:\\Scripts\\deploy.cmd.old" | Remove-Item',
      ],
      [
        'bare-quoted .cmd piped as pipeline input',
        '"C:\\Scripts\\deploy.cmd" | Remove-Item',
      ],
      [
        'bare-quoted .ps1 piped as pipeline input',
        '"C:\\hooks\\gate.ps1" | Get-Content',
      ],
    ])(
      'does not throw for a PowerShell command that is %s',
      async (_label, command) => {
        mockSpawn.mockImplementation(() => createMockProcess(0));
        const result = await hookRunner.executeHook(
          {
            type: HookType.Command,
            command,
            source: HooksConfigSource.Project,
            shell: 'powershell',
          },
          HookEventName.PreToolUse,
          createMockInput(),
        );
        expect(result.success).toBe(true);
        expect(mockSpawn).toHaveBeenCalled();
        expect(mockSpawn.mock.calls[0][1][2]).toContain(command);
      },
    );

    it('does NOT wrap bash commands with Set-StrictMode', async () => {
      // bash keeps unset-$VAR behaviour; `set -u` would break existing hooks.
      mockSpawn.mockImplementation(() => createMockProcess(0));
      await hookRunner.executeHook(
        {
          type: HookType.Command,
          command: 'echo $CLAUDE_PROJECT_DIR',
          source: HooksConfigSource.Project,
          shell: 'bash',
        },
        HookEventName.PreToolUse,
        createMockInput(),
      );
      const spawnArgs = mockSpawn.mock.calls[0];
      expect(spawnArgs[1][spawnArgs[1].length - 1]).toBe(
        'echo $CLAUDE_PROJECT_DIR',
      );
      expect(spawnArgs[2].env).toMatchObject({
        CLAUDE_PROJECT_DIR: '/test',
        GEMINI_PROJECT_DIR: '/test',
        QWEN_PROJECT_DIR: '/test',
      });
      await hookRunner.executeHook(
        {
          type: HookType.Command,
          command: "echo '$CLAUDE_PROJECT_DIR'",
          source: HooksConfigSource.Project,
          shell: 'bash',
        },
        HookEventName.PreToolUse,
        createMockInput(),
      );
      const quotedArgs = mockSpawn.mock.calls[1][1];
      expect(quotedArgs[quotedArgs.length - 1]).toBe(
        "echo '$CLAUDE_PROJECT_DIR'",
      );
    });

    it('surfaces VariableIsUndefined as systemMessage when $VAR is undefined', async () => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
      mockSpawn.mockImplementation(() =>
        createMockProcess(
          1,
          '',
          "\u001b[31;1mThe variable '$CLAUDE_PROJECT_DIR' cannot be retrieved because it has not been set.\u001b[0m\n" +
            'At line:1 char:1\n' +
            '+ $CLAUDE_PROJECT_DIR\n' +
            '+ ~~~~~~~~~~~~~~~~~~~\n' +
            '    + CategoryInfo          : InvalidOperation: (CLAUDE_PROJECT_DIR:String) [], RuntimeException\n' +
            '    + FullyQualifiedErrorId : VariableIsUndefined\n',
        ),
      );
      const result = await hookRunner.executeHook(
        {
          type: HookType.Command,
          command: '$CLAUDE_PROJECT_DIR',
          source: HooksConfigSource.Project,
          shell: 'powershell',
        },
        HookEventName.PreToolUse,
        createMockInput(),
      );
      const spawnArgs = mockSpawn.mock.calls[0];
      expect(spawnArgs[1][2]).toMatch(
        /^\[Console\]::OutputEncoding=\[System\.Text\.Encoding\]::UTF8;Set-StrictMode -Version 1;\s*\$ErrorActionPreference\s*=\s*'Stop';\s*\$global:LASTEXITCODE = \$null;\s*\$CLAUDE_PROJECT_DIR$/,
      );
      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(1);
      const output = result.output as {
        systemMessage?: string;
        reason?: string;
      };
      expect(output.systemMessage).toBeDefined();
      expect(output.systemMessage).toContain('CLAUDE_PROJECT_DIR');
      expect(output.systemMessage).toMatch(
        /cannot be retrieved|VariableIsUndefined/,
      );
    });
  });

  describe('resolvePowerShellExecutable', () => {
    let execSpy: MockInstance<typeof shellUtils.resolveCommandPath>;
    beforeEach(() => {
      execSpy = vi.spyOn(shellUtils, 'resolveCommandPath');
    });

    it('resolves to "pwsh" when pwsh is on PATH', () => {
      execSpy.mockImplementation(((name: string) => {
        if (name === 'pwsh') return { path: '/usr/bin/pwsh' };
        return { path: null };
      }) as never);
      expect(resolvePowerShellExecutable()).toBe('/usr/bin/pwsh');
    });

    it('falls back to "powershell" when pwsh is missing', () => {
      execSpy.mockImplementation(((name: string) => {
        if (name === 'powershell') return { path: '/usr/bin/powershell' };
        return { path: null };
      }) as never);
      expect(resolvePowerShellExecutable()).toBe('/usr/bin/powershell');
    });

    it('throws a precise error when neither executable is on PATH', () => {
      execSpy.mockImplementation((() => ({ path: null })) as never);
      expect(() => resolvePowerShellExecutable()).toThrow(
        'Could not resolve a PowerShell executable (looked for pwsh, powershell)',
      );
    });

    it('probes only once across multiple calls (caches the resolved executable)', () => {
      execSpy.mockImplementation((() => ({ path: '/usr/bin/pwsh' })) as never);
      resolvePowerShellExecutable();
      resolvePowerShellExecutable();
      resolvePowerShellExecutable();
      expect(execSpy).toHaveBeenCalledTimes(1);
    });

    it('re-probes after a failed lookup instead of latching the failure', () => {
      execSpy.mockImplementation((() => ({ path: null })) as never);
      expect(() => resolvePowerShellExecutable()).toThrow(
        'Could not resolve a PowerShell executable (looked for pwsh, powershell)',
      );
      execSpy.mockImplementation(((name: string) =>
        name === 'pwsh' ? { path: '/usr/bin/pwsh' } : { path: null }) as never);
      expect(resolvePowerShellExecutable()).toBe('/usr/bin/pwsh');
      expect(execSpy).toHaveBeenCalledTimes(3);
    });

    it('resolves to the first match when the lookup lists several', () => {
      execSpy.mockImplementation((() => ({
        path: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe\r\nD:\\shims\\pwsh.exe',
      })) as never);
      expect(resolvePowerShellExecutable()).toBe(
        'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      );
    });

    it('names the lookup error when the probe failed rather than missed', () => {
      execSpy.mockImplementation((() => ({
        path: null,
        error: new Error('spawn where.exe EACCES'),
      })) as never);
      expect(() => resolvePowerShellExecutable()).toThrow(
        /Could not resolve a PowerShell executable.*EACCES/,
      );
    });

    it('probes from a neutral cwd so a workspace copy cannot answer', () => {
      execSpy.mockImplementation((() => ({ path: null })) as never);
      expect(() => resolvePowerShellExecutable()).toThrow();
      // `where` searches the current directory before PATH: probing from the
      // process cwd would return a workspace-planted pwsh.exe, and the temp
      // directory is writable, so Windows probes from the system directory.
      const neutral =
        process.platform === 'win32'
          ? `${process.env['SystemRoot'] || 'C:\\Windows'}\\System32`
          : tmpdir();
      expect(execSpy).toHaveBeenCalledWith('pwsh', { cwd: neutral });
    });
  });

  describe('outcome of results produced outside the runners', () => {
    const runAsyncHook = () =>
      hookRunner.executeHook(
        cmd('background-job', { async: true }),
        HookEventName.PostToolUse,
        createMockInput(),
      );

    it('reports an unknown hook type as a non-blocking error', async () => {
      const result = await execute({
        type: 'unknown',
      } as unknown as HookConfig);

      expect(result.success).toBe(false);
      expect(result.outcome).toBe('non_blocking_error');
    });

    it('reports an async hook refused by the concurrency limit as a non-blocking error', async () => {
      vi.spyOn(hookRunner['asyncRegistry'], 'canAcceptMore').mockReturnValue(
        false,
      );

      const result = await runAsyncHook();

      expect(result.outcome).toBe('non_blocking_error');
      expect(result.isAsync).toBe(true);
      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it('reports an async hook whose registration loses the race as a non-blocking error', async () => {
      vi.spyOn(hookRunner['asyncRegistry'], 'register').mockReturnValue(null);

      const result = await runAsyncHook();

      expect(result.outcome).toBe('non_blocking_error');
      expect(result.isAsync).toBe(true);
    });

    it('reports an async hook handed to the background as success', async () => {
      mockSpawn.mockImplementation(() => createMockProcess());

      const result = await runAsyncHook();

      expect(result.outcome).toBe('success');
      expect(result.isAsync).toBe(true);
      expect(result.success).toBe(true);
    });
  });
});
