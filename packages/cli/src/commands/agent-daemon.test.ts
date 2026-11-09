/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import yargs from 'yargs';
import { agentDaemonCommand } from './agent-daemon.js';

const mockWriteStdoutLine = vi.hoisted(() => vi.fn());
const mockSupervisor = vi.hoisted(() => ({
  status: vi.fn(async () => ({
    running: true,
    pid: 123,
    socketPath: '/tmp/qwen.sock',
  })),
  list: vi.fn(async () => [
    {
      state: {
        sessionState: 'working',
        processState: 'alive',
      },
    },
    {
      state: {
        sessionState: 'completed',
        processState: 'exited',
      },
    },
  ]),
  shutdown: vi.fn(
    async (): Promise<Record<string, unknown>> => ({ shuttingDown: true }),
  ),
}));
const mockEnsureAgentViewSupervisor = vi.hoisted(() =>
  vi.fn(async () => mockSupervisor),
);
const mockConnectExistingAgentViewSupervisor = vi.hoisted(() =>
  vi.fn(async (): Promise<unknown> => mockSupervisor),
);

vi.mock('../utils/stdioHelpers.js', () => ({
  writeStdoutLine: mockWriteStdoutLine,
}));

vi.mock('../agent-view/supervisor-runner.js', () => ({
  ensureAgentViewSupervisor: mockEnsureAgentViewSupervisor,
  connectExistingAgentViewSupervisor: mockConnectExistingAgentViewSupervisor,
}));

describe('agent daemon command', () => {
  it('registers the daemon subcommands', () => {
    const mockYargs = {
      command: vi.fn().mockReturnThis(),
      demandCommand: vi.fn().mockReturnThis(),
      version: vi.fn().mockReturnThis(),
    };
    const builder = agentDaemonCommand.builder;
    if (typeof builder !== 'function') {
      throw new Error('daemon command builder must be a function');
    }

    builder(mockYargs as never);

    expect(agentDaemonCommand.command).toBe('daemon');
    expect(mockYargs.command).toHaveBeenCalledTimes(2);
    expect(mockYargs.command.mock.calls.map((call) => call[0].command)).toEqual(
      ['status', 'stop'],
    );
    expect(mockYargs.demandCommand).toHaveBeenCalledWith(
      1,
      'You need at least one command before continuing.',
    );
  });

  it('prints daemon status', async () => {
    mockWriteStdoutLine.mockClear();
    mockSupervisor.status.mockClear();
    mockSupervisor.list.mockClear();

    await yargs('daemon status'.split(' '))
      .scriptName('qwen')
      .command(agentDaemonCommand)
      .exitProcess(false)
      .fail((message, error) => {
        throw error ?? new Error(message);
      })
      .parseAsync();

    expect(mockSupervisor.status).toHaveBeenCalledOnce();
    expect(mockSupervisor.list).toHaveBeenCalledOnce();
    expect(mockEnsureAgentViewSupervisor).not.toHaveBeenCalled();
    expect(JSON.parse(String(mockWriteStdoutLine.mock.calls[0]?.[0]))).toEqual({
      status: { running: true, pid: 123, socketPath: '/tmp/qwen.sock' },
      sessions: { total: 2, active: 1 },
    });
  });

  it('prints offline daemon status without starting a supervisor', async () => {
    mockWriteStdoutLine.mockClear();
    mockConnectExistingAgentViewSupervisor.mockResolvedValueOnce(undefined);

    await yargs('daemon status'.split(' '))
      .scriptName('qwen')
      .command(agentDaemonCommand)
      .exitProcess(false)
      .fail((message, error) => {
        throw error ?? new Error(message);
      })
      .parseAsync();

    expect(mockEnsureAgentViewSupervisor).not.toHaveBeenCalled();
    expect(JSON.parse(String(mockWriteStdoutLine.mock.calls[0]?.[0]))).toEqual({
      status: { running: false },
      sessions: { total: 0, active: 0 },
    });
  });

  it('requires --any for daemon stop', async () => {
    await expect(async () => {
      await yargs('daemon stop'.split(' '))
        .scriptName('qwen')
        .command(agentDaemonCommand)
        .exitProcess(false)
        .fail((message, error) => {
          if (error instanceof Error) throw error;
          throw new Error(message ?? String(error));
        })
        .parseAsync();
    }).rejects.toThrow('qwen agents daemon stop requires --any.');
  });

  it('accepts daemon stop --any --keep-workers', async () => {
    mockWriteStdoutLine.mockClear();
    mockSupervisor.shutdown.mockClear();

    await yargs('daemon stop --any --keep-workers'.split(' '))
      .scriptName('qwen')
      .command(agentDaemonCommand)
      .exitProcess(false)
      .fail((message, error) => {
        throw error ?? new Error(message);
      })
      .parseAsync();

    expect(mockSupervisor.shutdown).toHaveBeenCalledWith(true);
    expect(mockEnsureAgentViewSupervisor).not.toHaveBeenCalled();
    expect(JSON.parse(String(mockWriteStdoutLine.mock.calls[0]?.[0]))).toEqual({
      shuttingDown: true,
    });
  });

  it('does not start a supervisor for daemon stop when none is running', async () => {
    mockWriteStdoutLine.mockClear();
    mockConnectExistingAgentViewSupervisor.mockResolvedValueOnce(undefined);

    await yargs('daemon stop --any'.split(' '))
      .scriptName('qwen')
      .command(agentDaemonCommand)
      .exitProcess(false)
      .fail((message, error) => {
        throw error ?? new Error(message);
      })
      .parseAsync();

    expect(mockEnsureAgentViewSupervisor).not.toHaveBeenCalled();
    expect(JSON.parse(String(mockWriteStdoutLine.mock.calls[0]?.[0]))).toEqual({
      shuttingDown: false,
      reason: 'not_running',
    });
  });

  it('sets a failing exit code when worker shutdowns fail', async () => {
    process.exitCode = undefined;
    mockWriteStdoutLine.mockClear();
    mockSupervisor.shutdown.mockResolvedValueOnce({
      shuttingDown: true,
      workersStopped: 1,
      workersFailed: [{ sessionId: 'session-2', error: 'shutdown failed' }],
    });

    await yargs('daemon stop --any'.split(' '))
      .scriptName('qwen')
      .command(agentDaemonCommand)
      .exitProcess(false)
      .fail((message, error) => {
        throw error ?? new Error(message);
      })
      .parseAsync();

    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
  });
});
