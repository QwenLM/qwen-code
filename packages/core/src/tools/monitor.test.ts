/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { Readable } from 'node:stream';
import type { ChildProcess } from 'node:child_process';

// Mock child_process.spawn
const mockSpawn = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();

  return {
    ...actual,
    spawn: mockSpawn,
  };
});

// Mock shell-utils
function isEnvAssignmentToken(token: string): boolean {
  const equalsIndex = token.indexOf('=');
  if (equalsIndex <= 0) return false;

  const name = token.slice(0, equalsIndex);
  const firstChar = name.charCodeAt(0);
  const isAlpha =
    (firstChar >= 65 && firstChar <= 90) ||
    (firstChar >= 97 && firstChar <= 122);
  if (!isAlpha && name[0] !== '_') return false;

  for (let i = 1; i < name.length; i++) {
    const code = name.charCodeAt(i);
    const isAlphaNumeric =
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57);
    if (!isAlphaNumeric && name[i] !== '_') return false;
  }

  return true;
}

function takeLeadingShellToken(command: string): {
  token: string;
  rest: string;
} | null {
  const trimmed = command.trimStart();
  if (!trimmed) return null;

  let quote: '"' | "'" | '' = '';
  let escaped = false;
  let idx = 0;
  for (; idx < trimmed.length; idx++) {
    const char = trimmed[idx]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) break;
  }

  return {
    token: trimmed.slice(0, idx),
    rest: trimmed.slice(idx),
  };
}

function stripLeadingEnvAssignments(command: string): string {
  let rest = command.trimStart();
  while (true) {
    const token = takeLeadingShellToken(rest);
    if (!token || !isEnvAssignmentToken(token.token)) {
      return rest;
    }
    rest = token.rest.trimStart();
  }
}

vi.mock('../utils/shell-utils.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../utils/shell-utils.js')>();

  return {
    ...actual,
    getShellConfiguration: () => ({
      executable: '/bin/bash',
      argsPrefix: ['-c'],
      shell: 'bash',
    }),
    getCommandRoot: (cmd: string) =>
      stripLeadingEnvAssignments(cmd).split(/\s+/)[0],
    splitCommands: (cmd: string) =>
      cmd
        .split(/\s*&&\s*/)
        .map((part) => part.trim())
        .filter(Boolean),
    detectCommandSubstitution: (command: string) =>
      /\$\(|`|<\(|>\(/.test(command),
  };
});

const mockIsShellCommandReadOnlyAST = vi.hoisted(() => vi.fn());
const mockExtractCommandRules = vi.hoisted(() => vi.fn());
vi.mock('../utils/shellAstParser.js', () => ({
  isShellCommandReadOnlyAST: mockIsShellCommandReadOnlyAST,
  extractCommandRules: mockExtractCommandRules,
}));

import { MonitorTool } from './monitor.js';
import type { Config } from '../config/config.js';
import { MonitorRegistry } from '../services/monitorRegistry.js';
import type { ToolCallConfirmationDetails } from './tools.js';

/**
 * Create a mock child process with controllable stdout/stderr/events.
 */
function createMockChild(): ChildProcess & {
  stdout: Readable;
  stderr: Readable;
  _emitExit: (code: number | null, signal?: string | null) => void;
  _emitError: (err: Error) => void;
} {
  const child = new EventEmitter() as unknown as ChildProcess & {
    stdout: Readable;
    stderr: Readable;
    _emitExit: (code: number | null, signal?: string | null) => void;
    _emitError: (err: Error) => void;
  };
  // Use Object.defineProperty to bypass readonly on the mock
  Object.defineProperty(child, 'stdout', {
    value: new EventEmitter(),
    writable: true,
  });
  Object.defineProperty(child, 'stderr', {
    value: new EventEmitter(),
    writable: true,
  });
  Object.defineProperty(child, 'pid', { value: 12345, writable: true });

  child._emitExit = (code, signal = null) => {
    child.emit('exit', code, signal);
  };
  child._emitError = (err) => {
    child.emit('error', err);
  };

  return child;
}

describe('MonitorTool', () => {
  let monitorTool: MonitorTool;
  let mockConfig: Config;
  let monitorRegistry: MonitorRegistry;
  let mockChild: ReturnType<typeof createMockChild>;
  let mockIsPathWithinWorkspace: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();

    monitorRegistry = new MonitorRegistry();
    mockIsPathWithinWorkspace = vi.fn().mockReturnValue(true);
    mockIsShellCommandReadOnlyAST.mockResolvedValue(false);
    mockExtractCommandRules.mockImplementation(async (command: string) => {
      const normalized = stripLeadingEnvAssignments(command);
      return [`${normalized.split(/\s+/).slice(0, 2).join(' ')} *`];
    });

    mockConfig = {
      getTargetDir: vi.fn().mockReturnValue('/test/dir'),
      getMonitorRegistry: vi.fn().mockReturnValue(monitorRegistry),
      getPermissionManager: vi.fn().mockReturnValue(undefined),
      getWorkspaceContext: vi.fn().mockReturnValue({
        isPathWithinWorkspace: mockIsPathWithinWorkspace,
      }),
      storage: {
        getUserSkillsDirs: vi
          .fn()
          .mockReturnValue(['/home/user/.claude/skills']),
      },
    } as unknown as Config;

    monitorTool = new MonitorTool(mockConfig);

    mockChild = createMockChild();
    mockSpawn.mockReturnValue(mockChild);
  });

  afterEach(() => {
    monitorRegistry.abortAll();
  });

  // Helper to access protected validateToolParamValues
  const validate = (params: Record<string, unknown>) =>
    (
      monitorTool as unknown as {
        validateToolParamValues: (p: Record<string, unknown>) => string | null;
      }
    ).validateToolParamValues(params);

  // Helper to create an invocation
  const createInvocation = (params: Record<string, unknown>) =>
    (
      monitorTool as unknown as {
        createInvocation: (p: Record<string, unknown>) => {
          getDescription: () => string;
          getDefaultPermission: () => Promise<string>;
          getConfirmationDetails: (
            s: AbortSignal,
          ) => Promise<ToolCallConfirmationDetails>;
          execute: (
            s: AbortSignal,
          ) => Promise<{ llmContent: string; returnDisplay: string }>;
        };
      }
    ).createInvocation(params);

  describe('confirmation details', () => {
    it('includes command-scoped permission rules for monitor commands', async () => {
      const invocation = createInvocation({
        command: 'tail -f /tmp/app.log',
      });

      const details = (await invocation.getConfirmationDetails(
        new AbortController().signal,
      )) as ToolCallConfirmationDetails & {
        permissionRules?: string[];
      };

      expect(details.type).toBe('exec');
      expect(details.permissionRules).toEqual(['Monitor(tail -f *)']);
    });

    it('strips a trailing bare ampersand before building confirmation details', async () => {
      const invocation = createInvocation({
        command: 'tail -f /tmp/app.log &',
      });

      const details = (await invocation.getConfirmationDetails(
        new AbortController().signal,
      )) as ToolCallConfirmationDetails & {
        command: string;
        permissionRules?: string[];
      };

      expect(details.command).toBe('tail -f /tmp/app.log');
      expect(details.permissionRules).toEqual(['Monitor(tail -f *)']);
    });

    it('preserves explicit shell wrappers while analyzing the wrapped command', async () => {
      const invocation = createInvocation({
        command: `/bin/bash -c 'tail -f /tmp/app.log &'`,
      });

      const details = (await invocation.getConfirmationDetails(
        new AbortController().signal,
      )) as ToolCallConfirmationDetails & {
        command: string;
        rootCommand: string;
        permissionRules?: string[];
      };

      expect(details.command).toBe(`/bin/bash -c 'tail -f /tmp/app.log'`);
      expect(details.rootCommand).toBe('tail');
      expect(details.permissionRules).toEqual(['Monitor(tail -f *)']);
    });

    it('unwraps quoted env-prefixed shell wrappers for confirmation analysis', async () => {
      const invocation = createInvocation({
        command: `FOO="bar baz" /bin/bash -c 'tail -f /tmp/app.log &'`,
      });

      const details = (await invocation.getConfirmationDetails(
        new AbortController().signal,
      )) as ToolCallConfirmationDetails & {
        command: string;
        rootCommand: string;
        permissionRules?: string[];
      };

      expect(details.command).toBe(
        `FOO="bar baz" /bin/bash -c 'tail -f /tmp/app.log'`,
      );
      expect(details.rootCommand).toBe('tail');
      expect(details.permissionRules).toEqual(['Monitor(tail -f *)']);
    });

    it('does not strip non-trailing or non-bare ampersands in confirmation details', async () => {
      const commands = ['sleep 5 & echo done', 'echo hi &&', 'echo hi \\&'];

      for (const command of commands) {
        const invocation = createInvocation({ command });
        const details = (await invocation.getConfirmationDetails(
          new AbortController().signal,
        )) as ToolCallConfirmationDetails & {
          command: string;
        };

        expect(details.command).toBe(command);
      }
    });

    it('does not consult Bash permission rules for monitor commands', async () => {
      // Monitor should NOT use pm.isCommandAllowed() because that evaluates
      // under 'run_shell_command' context, mixing permission boundaries.
      const pm = {
        isCommandAllowed: vi.fn().mockResolvedValue('allow'),
      };
      mockConfig.getPermissionManager = vi.fn().mockReturnValue(pm);

      // Neither subcommand is read-only
      mockIsShellCommandReadOnlyAST.mockResolvedValue(false);
      mockExtractCommandRules
        .mockResolvedValueOnce(['git add *'])
        .mockResolvedValueOnce(['git commit *']);

      const invocation = createInvocation({
        command: 'git add file && git commit -m "msg"',
      });

      const details = (await invocation.getConfirmationDetails(
        new AbortController().signal,
      )) as ToolCallConfirmationDetails & {
        permissionRules?: string[];
      };

      // pm.isCommandAllowed must NOT be called — monitor maintains its own
      // permission boundary separate from run_shell_command
      expect(pm.isCommandAllowed).not.toHaveBeenCalled();
      // Both subcommands remain in confirmation scope
      expect(details.permissionRules).toEqual([
        'Monitor(git add *)',
        'Monitor(git commit *)',
      ]);
    });

    it('includes wrapper suffix commands in confirmation analysis', async () => {
      const invocation = createInvocation({
        command: `/bin/bash -c 'tail -f /tmp/app.log' && rm -rf /tmp/owned`,
      });

      const details = (await invocation.getConfirmationDetails(
        new AbortController().signal,
      )) as ToolCallConfirmationDetails & {
        rootCommand: string;
        permissionRules?: string[];
      };

      expect(details.rootCommand).toBe('tail, rm');
      expect(details.permissionRules).toEqual([
        'Monitor(tail -f *)',
        'Monitor(rm -rf *)',
      ]);
    });

    it('falls back to a canonical Monitor rule if command extraction fails', async () => {
      mockExtractCommandRules.mockRejectedValueOnce(new Error('parse failed'));

      const invocation = createInvocation({
        command: `/bin/bash --noprofile -c 'tail -f /tmp/app.log &'`,
      });

      const details = (await invocation.getConfirmationDetails(
        new AbortController().signal,
      )) as ToolCallConfirmationDetails & {
        permissionRules?: string[];
      };

      expect(details.permissionRules).toEqual([
        'Monitor(tail -f /tmp/app.log)',
      ]);
    });
  });

  describe('getDefaultPermission', () => {
    it('denies command substitution before confirmation', async () => {
      const invocation = createInvocation({
        command: 'echo $(cat secret.txt)',
      });

      await expect(invocation.getDefaultPermission()).resolves.toBe('deny');
    });

    it('denies command substitution inside explicit shell wrappers', async () => {
      const invocation = createInvocation({
        command: `/bin/bash -c 'echo $(cat secret.txt)'`,
      });

      await expect(invocation.getDefaultPermission()).resolves.toBe('deny');
    });

    it('denies command substitution inside wrapped scripts with argv suffixes', async () => {
      const invocation = createInvocation({
        command: `/bin/bash -c 'echo $(cat secret.txt)' ignored`,
      });

      await expect(invocation.getDefaultPermission()).resolves.toBe('deny');
    });

    it('denies command substitution inside quoted env-prefixed wrappers', async () => {
      const invocation = createInvocation({
        command: `FOO="bar baz" /bin/bash -c 'echo $(cat secret.txt)'`,
      });

      await expect(invocation.getDefaultPermission()).resolves.toBe('deny');
    });

    it('denies command substitution inside env-prefix assignments', async () => {
      const invocation = createInvocation({
        command: `FOO=$(cat secret.txt) /bin/bash -c 'echo ok'`,
      });

      await expect(invocation.getDefaultPermission()).resolves.toBe('deny');
    });

    it('allows read-only monitor commands by default', async () => {
      mockIsShellCommandReadOnlyAST.mockResolvedValueOnce(true);
      const invocation = createInvocation({
        command: 'tail -f /tmp/app.log',
      });

      await expect(invocation.getDefaultPermission()).resolves.toBe('allow');
    });
  });

  describe('validation', () => {
    it('rejects empty command', () => {
      expect(validate({ command: '  ' })).toBe('Command cannot be empty.');
    });

    it('rejects invalid max_events (negative)', () => {
      expect(validate({ command: 'tail -f log', max_events: -1 })).toBe(
        'max_events must be a positive integer.',
      );
    });

    it('rejects max_events of zero', () => {
      expect(validate({ command: 'tail -f log', max_events: 0 })).toBe(
        'max_events must be a positive integer.',
      );
    });

    it('rejects max_events over limit', () => {
      expect(validate({ command: 'tail -f log', max_events: 20000 })).toBe(
        'max_events cannot exceed 10000.',
      );
    });

    it('rejects invalid idle_timeout_ms', () => {
      expect(validate({ command: 'tail -f log', idle_timeout_ms: -100 })).toBe(
        'idle_timeout_ms must be a positive integer.',
      );
    });

    it('rejects idle_timeout_ms over limit', () => {
      expect(
        validate({ command: 'tail -f log', idle_timeout_ms: 700_000 }),
      ).toContain('cannot exceed');
    });

    it('accepts valid params', () => {
      expect(
        validate({
          command: 'tail -f log',
          max_events: 500,
          idle_timeout_ms: 60000,
        }),
      ).toBeNull();
    });

    it('rejects non-string command without throwing', () => {
      // Schema normally blocks this, but SDK/direct callers can bypass it.
      // The validator must return a structured error instead of throwing.
      expect(() => validate({ command: undefined })).not.toThrow();
      expect(validate({ command: undefined })).toBe('Command cannot be empty.');
      expect(validate({ command: 123 })).toBe('Command cannot be empty.');
      expect(validate({ command: null })).toBe('Command cannot be empty.');
    });

    it('rejects commands that normalize to empty after stripping trailing &', () => {
      expect(validate({ command: '&' })).toBe('Command cannot be empty.');
      expect(validate({ command: '  &  ' })).toBe('Command cannot be empty.');
    });

    it('rejects non-absolute directory', () => {
      expect(
        validate({ command: 'tail -f log', directory: 'relative/path' }),
      ).toBe('Directory must be an absolute path.');
    });

    it('rejects directory within user skills directory', () => {
      const result = validate({
        command: 'tail -f log',
        directory: '/home/user/.claude/skills/my-skill',
      });
      expect(result).toContain('user skills directory is not allowed');
    });

    it('rejects directory outside workspace (delegates to WorkspaceContext)', () => {
      mockIsPathWithinWorkspace.mockReturnValueOnce(false);
      const result = validate({
        command: 'tail -f log',
        directory: '/tmp/project-a-evil/x',
      });
      expect(result).toContain('not within any of the registered workspace');
      expect(mockIsPathWithinWorkspace).toHaveBeenCalledWith(
        '/tmp/project-a-evil/x',
      );
    });

    it('rejects directory with parent-reference traversal', () => {
      mockIsPathWithinWorkspace.mockReturnValueOnce(false);
      const result = validate({
        command: 'tail -f log',
        directory: '/tmp/project-a/../etc',
      });
      expect(result).toContain('not within any of the registered workspace');
    });

    it('accepts directory within workspace', () => {
      mockIsPathWithinWorkspace.mockReturnValueOnce(true);
      expect(
        validate({
          command: 'tail -f log',
          directory: '/test/dir/sub',
        }),
      ).toBeNull();
    });
  });

  describe('execute', () => {
    it('spawns a process and returns monitor ID', async () => {
      const invocation = createInvocation({
        command: 'tail -f /var/log/app.log',
        description: 'watch app logs',
      });

      const signal = new AbortController().signal;
      const result = await invocation.execute(signal);

      expect(mockSpawn).toHaveBeenCalledOnce();
      expect(mockSpawn).toHaveBeenCalledWith(
        '/bin/bash',
        ['-c', 'tail -f /var/log/app.log'],
        expect.objectContaining({
          cwd: '/test/dir',
          detached: true,
        }),
      );
      expect(result.llmContent).toContain('Monitor started');
      expect(result.llmContent).toContain('mon_');
      expect(result.returnDisplay).toContain('watch app logs');
    });

    it('does not spawn when the turn signal is already aborted', async () => {
      const invocation = createInvocation({
        command: 'tail -f /var/log/app.log',
      });
      const ac = new AbortController();
      ac.abort();

      const result = await invocation.execute(ac.signal);

      expect(mockSpawn).not.toHaveBeenCalled();
      expect(monitorRegistry.getAll()).toHaveLength(0);
      expect(result.llmContent).toContain(
        'Monitor was cancelled before it could start.',
      );
    });

    it('truncates long monitor descriptions in display surfaces', async () => {
      const longDescription = 'x'.repeat(120);
      const invocation = createInvocation({
        command: 'tail -f /var/log/app.log',
        description: longDescription,
      });

      const result = await invocation.execute(new AbortController().signal);

      expect(invocation.getDescription()).toBe(`Monitor: ${'x'.repeat(79)}…`);
      expect(result.returnDisplay).toContain(`${'x'.repeat(79)}…`);
      expect(result.returnDisplay).not.toContain(longDescription);
      expect(result.llmContent).toContain(`description: ${longDescription}`);
    });

    it('strips a trailing bare ampersand before spawning', async () => {
      const invocation = createInvocation({
        command: 'tail -f /var/log/app.log &',
      });

      await invocation.execute(new AbortController().signal);

      expect(mockSpawn).toHaveBeenCalledWith(
        '/bin/bash',
        ['-c', 'tail -f /var/log/app.log'],
        expect.objectContaining({
          cwd: '/test/dir',
          detached: true,
        }),
      );
      expect(monitorRegistry.getRunning()[0]?.command).toBe(
        'tail -f /var/log/app.log',
      );
    });

    it('preserves explicit shell wrappers on the spawn path', async () => {
      const invocation = createInvocation({
        command: `/bin/bash -c 'tail -f /var/log/app.log &'`,
      });

      await invocation.execute(new AbortController().signal);

      expect(mockSpawn).toHaveBeenCalledWith(
        '/bin/bash',
        ['-c', `/bin/bash -c 'tail -f /var/log/app.log'`],
        expect.objectContaining({
          cwd: '/test/dir',
          detached: true,
        }),
      );
      expect(monitorRegistry.getRunning()[0]?.command).toBe(
        `/bin/bash -c 'tail -f /var/log/app.log'`,
      );
    });

    it('preserves wrapper flags while stripping trailing ampersands', async () => {
      const invocation = createInvocation({
        command: `/bin/bash --noprofile -c 'tail -f /var/log/app.log &'`,
      });

      await invocation.execute(new AbortController().signal);

      expect(mockSpawn).toHaveBeenCalledWith(
        '/bin/bash',
        ['-c', `/bin/bash --noprofile -c 'tail -f /var/log/app.log'`],
        expect.objectContaining({
          cwd: '/test/dir',
          detached: true,
        }),
      );
      expect(monitorRegistry.getRunning()[0]?.command).toBe(
        `/bin/bash --noprofile -c 'tail -f /var/log/app.log'`,
      );
    });

    it('preserves wrapper argv while stripping trailing ampersands from the script', async () => {
      const invocation = createInvocation({
        command: `/bin/bash -c 'tail -f /var/log/app.log &' ignored`,
      });

      await invocation.execute(new AbortController().signal);

      expect(mockSpawn).toHaveBeenCalledWith(
        '/bin/bash',
        ['-c', `/bin/bash -c 'tail -f /var/log/app.log' ignored`],
        expect.objectContaining({
          cwd: '/test/dir',
          detached: true,
        }),
      );
      expect(monitorRegistry.getRunning()[0]?.command).toBe(
        `/bin/bash -c 'tail -f /var/log/app.log' ignored`,
      );
    });

    it('registers entry in MonitorRegistry', async () => {
      const invocation = createInvocation({
        command: 'tail -f log',
      });

      await invocation.execute(new AbortController().signal);

      const running = monitorRegistry.getRunning();
      expect(running).toHaveLength(1);
      expect(running[0].command).toBe('tail -f log');
      expect(running[0].pid).toBe(12345);
    });

    it('kills the spawned child if registry registration fails', async () => {
      const invocation = createInvocation({
        command: 'tail -f log',
      });
      const killSpy = vi
        .spyOn(process, 'kill')
        .mockImplementation(() => true as never);
      const registerSpy = vi
        .spyOn(monitorRegistry, 'register')
        .mockImplementation(() => {
          throw new Error('limit reached');
        });

      try {
        const result = await invocation.execute(new AbortController().signal);

        expect(result.llmContent).toContain('Monitor failed to start');
        expect(result.returnDisplay).toContain('limit reached');
        if (process.platform === 'win32') {
          expect(mockSpawn).toHaveBeenCalledWith('taskkill', [
            '/pid',
            '12345',
            '/f',
            '/t',
          ]);
        } else {
          expect(killSpy).toHaveBeenCalledWith(-12345, 'SIGTERM');
        }
        expect(monitorRegistry.getAll()).toHaveLength(0);
      } finally {
        killSpy.mockRestore();
        registerSpy.mockRestore();
      }
    });

    it('uses SIGKILL fallback if registry registration fails after spawn', async () => {
      vi.useFakeTimers();
      const invocation = createInvocation({
        command: 'tail -f log',
      });
      const killSpy = vi
        .spyOn(process, 'kill')
        .mockImplementation(() => true as never);
      const registerSpy = vi
        .spyOn(monitorRegistry, 'register')
        .mockImplementation(() => {
          throw new Error('limit reached');
        });

      try {
        await invocation.execute(new AbortController().signal);

        if (process.platform === 'win32') {
          expect(mockSpawn).toHaveBeenCalledWith('taskkill', [
            '/pid',
            '12345',
            '/f',
            '/t',
          ]);
        } else {
          expect(killSpy).toHaveBeenCalledWith(-12345, 'SIGTERM');
          await vi.advanceTimersByTimeAsync(200);
          expect(killSpy).toHaveBeenCalledWith(-12345, 'SIGKILL');
        }
      } finally {
        killSpy.mockRestore();
        registerSpy.mockRestore();
        vi.useRealTimers();
      }
    });

    it('installs the abort handler before registering the monitor', async () => {
      const invocation = createInvocation({
        command: 'tail -f log',
      });
      const killSpy = vi
        .spyOn(process, 'kill')
        .mockImplementation(() => true as never);
      const registerSpy = vi
        .spyOn(monitorRegistry, 'register')
        .mockImplementation((entry) => {
          entry.abortController.abort();
          MonitorRegistry.prototype.register.call(monitorRegistry, entry);
        });

      try {
        await invocation.execute(new AbortController().signal);

        if (process.platform === 'win32') {
          expect(mockSpawn).toHaveBeenCalledWith('taskkill', [
            '/pid',
            '12345',
            '/f',
            '/t',
          ]);
        } else {
          expect(killSpy).toHaveBeenCalledWith(-12345, 'SIGTERM');
        }
      } finally {
        killSpy.mockRestore();
        registerSpy.mockRestore();
      }
    });

    it('preserves the original spawn error when startup fails synchronously', async () => {
      const invocation = createInvocation({
        command: 'tail -f log',
      });
      const registerCallback = vi.fn();
      monitorRegistry.setRegisterCallback(registerCallback);
      mockSpawn.mockImplementation(() => {
        throw new Error('spawn failed');
      });
      const registerSpy = vi
        .spyOn(monitorRegistry, 'register')
        .mockImplementation(() => {
          throw new Error('limit reached');
        });

      try {
        const result = await invocation.execute(new AbortController().signal);

        expect(result.llmContent).toContain('Monitor failed to start');
        expect(result.llmContent).toContain('spawn failed');
        expect(result.returnDisplay).toContain('spawn failed');
        expect(registerSpy).not.toHaveBeenCalled();
        expect(registerCallback).not.toHaveBeenCalled();
        expect(monitorRegistry.getAll()).toHaveLength(0);
      } finally {
        registerSpy.mockRestore();
      }
    });

    it('emits events on stdout lines', async () => {
      const callback = vi.fn();
      monitorRegistry.setNotificationCallback(callback);

      const invocation = createInvocation({
        command: 'echo hello',
      });

      await invocation.execute(new AbortController().signal);

      // Simulate stdout data
      mockChild.stdout.emit('data', Buffer.from('line one\nline two\n'));

      expect(callback).toHaveBeenCalledTimes(2);
    });

    it('buffers partial lines across chunks', async () => {
      const callback = vi.fn();
      monitorRegistry.setNotificationCallback(callback);

      const invocation = createInvocation({
        command: 'echo hello',
      });

      await invocation.execute(new AbortController().signal);

      // Send partial line
      mockChild.stdout.emit('data', Buffer.from('partial'));
      expect(callback).not.toHaveBeenCalled();

      // Complete the line
      mockChild.stdout.emit('data', Buffer.from(' complete\n'));
      expect(callback).toHaveBeenCalledOnce();
    });

    it('settles registry on process exit', async () => {
      const invocation = createInvocation({
        command: 'echo done',
      });

      await invocation.execute(new AbortController().signal);
      mockChild._emitExit(0);

      const entry = monitorRegistry.getRunning();
      expect(entry).toHaveLength(0);
      const all = monitorRegistry.getAll();
      expect(all[0].status).toBe('completed');
    });

    it('settles as failed on non-zero exit', async () => {
      const invocation = createInvocation({
        command: 'false',
      });

      await invocation.execute(new AbortController().signal);
      mockChild._emitExit(1);

      const all = monitorRegistry.getAll();
      expect(all[0].status).toBe('failed');
    });

    it('settles as failed on spawn error', async () => {
      const invocation = createInvocation({
        command: 'nonexistent',
      });

      await invocation.execute(new AbortController().signal);
      mockChild._emitError(new Error('spawn ENOENT'));

      const all = monitorRegistry.getAll();
      expect(all[0].status).toBe('failed');
    });

    it('settles as failed when killed by signal', async () => {
      const invocation = createInvocation({
        command: 'tail -f log',
      });

      await invocation.execute(new AbortController().signal);
      mockChild._emitExit(null, 'SIGTERM');

      const all = monitorRegistry.getAll();
      expect(all[0].status).toBe('failed');
    });

    it('does not kill monitor on turn signal abort', async () => {
      const turnAc = new AbortController();
      const invocation = createInvocation({
        command: 'tail -f log',
      });

      await invocation.execute(turnAc.signal);

      // Abort the turn signal (simulating Ctrl+C)
      turnAc.abort();

      // Monitor should still be running
      const running = monitorRegistry.getRunning();
      expect(running).toHaveLength(1);
    });

    it('processes stderr data same as stdout', async () => {
      const callback = vi.fn();
      monitorRegistry.setNotificationCallback(callback);

      const invocation = createInvocation({
        command: 'some-cmd',
      });

      await invocation.execute(new AbortController().signal);

      mockChild.stderr.emit('data', Buffer.from('stderr line\n'));

      expect(callback).toHaveBeenCalledOnce();
    });

    it('filters out empty lines', async () => {
      const callback = vi.fn();
      monitorRegistry.setNotificationCallback(callback);

      const invocation = createInvocation({
        command: 'echo hello',
      });

      await invocation.execute(new AbortController().signal);

      mockChild.stdout.emit('data', Buffer.from('line one\n\n\nline two\n'));

      // Only 2 non-empty lines
      expect(callback).toHaveBeenCalledTimes(2);
    });

    it('uses separate buffers for stdout and stderr', async () => {
      const callback = vi.fn();
      monitorRegistry.setNotificationCallback(callback);

      const invocation = createInvocation({
        command: 'some-cmd',
      });

      await invocation.execute(new AbortController().signal);

      // Send partial line on stdout
      mockChild.stdout.emit('data', Buffer.from('partial'));
      // Send complete line on stderr — should not mix with stdout buffer
      mockChild.stderr.emit('data', Buffer.from('err line\n'));
      // Complete stdout line
      mockChild.stdout.emit('data', Buffer.from(' complete\n'));

      expect(callback).toHaveBeenCalledTimes(2);
      // stderr line comes first (completed first)
      const [, modelText1] = callback.mock.calls[0] as [string, string];
      expect(modelText1).toContain('err line');
      // stdout line is intact (not mixed with stderr)
      const [, modelText2] = callback.mock.calls[1] as [string, string];
      expect(modelText2).toContain('partial complete');
    });

    it('returns failure when spawn throws', async () => {
      mockSpawn.mockImplementation(() => {
        throw new Error('spawn failed');
      });

      const invocation = createInvocation({
        command: 'bad-command',
      });

      const result = await invocation.execute(new AbortController().signal);
      expect(result.llmContent).toContain('failed to start');
    });

    it('caps unbounded partial-line accumulation (no newlines)', async () => {
      const callback = vi.fn();
      monitorRegistry.setNotificationCallback(callback);

      const invocation = createInvocation({
        command: 'tight-loop --no-newlines',
      });

      await invocation.execute(new AbortController().signal);

      // MAX_LINE_LENGTH is 4096; send five 1000-byte chunks with no newline.
      // Total accumulated bytes = 5000, which exceeds 4096 — the guard must
      // force-emit a single truncated event and reset the buffer instead of
      // growing without bound.
      const chunk = 'A'.repeat(1000);
      for (let i = 0; i < 5; i++) {
        mockChild.stdout.emit('data', Buffer.from(chunk));
      }

      // Exactly one forced emit should have happened (first chunk that
      // pushes the buffer past MAX_LINE_LENGTH).
      expect(callback).toHaveBeenCalledTimes(1);
      // Callback signature: (displayText, modelText, meta). The modelText is
      // an XML envelope; we assert on bounded total length and the presence
      // of our 'A' payload rather than exact string contents.
      const [, modelText] = callback.mock.calls[0] as [string, string];
      // Bounded: should be well under the 5000 bytes we streamed. Accepts the
      // XML envelope plus MAX_LINE_LENGTH (4096) plus truncation markers.
      expect(modelText.length).toBeLessThan(5000);
      expect(modelText).toContain('A'.repeat(100));

      // Buffer must have been reset: continuing to stream still produces
      // further forced emits (i.e. no runaway growth).
      for (let i = 0; i < 5; i++) {
        mockChild.stdout.emit('data', Buffer.from(chunk));
      }
      expect(callback).toHaveBeenCalledTimes(2);
    });
  });
});
