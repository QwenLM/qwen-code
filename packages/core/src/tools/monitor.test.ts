/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';

// Mock child_process.spawn
const mockSpawn = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({
  spawn: mockSpawn,
}));

// Mock shell-utils
vi.mock('../utils/shell-utils.js', () => ({
  getShellConfiguration: () => ({
    executable: '/bin/bash',
    argsPrefix: ['-c'],
    shell: 'bash',
  }),
  getCommandRoot: (cmd: string) => cmd.split(/\s+/)[0],
  stripShellWrapper: (cmd: string) => cmd,
}));

import { MonitorTool } from './monitor.js';
import type { Config } from '../config/config.js';
import { MonitorRegistry } from '../services/monitorRegistry.js';

/**
 * Create a mock child process with controllable stdout/stderr/events.
 */
function createMockChild(): ChildProcess & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  _emitExit: (code: number | null, signal?: string | null) => void;
  _emitError: (err: Error) => void;
} {
  const child = new EventEmitter() as ChildProcess & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    _emitExit: (code: number | null, signal?: string | null) => void;
    _emitError: (err: Error) => void;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 12345;

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

  beforeEach(() => {
    vi.clearAllMocks();

    monitorRegistry = new MonitorRegistry();

    mockConfig = {
      getTargetDir: vi.fn().mockReturnValue('/test/dir'),
      getMonitorRegistry: vi.fn().mockReturnValue(monitorRegistry),
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
          execute: (
            s: AbortSignal,
          ) => Promise<{ llmContent: string; returnDisplay: string }>;
        };
      }
    ).createInvocation(params);

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
  });
});
