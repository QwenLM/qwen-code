/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import yargs from 'yargs';
import { AgentViewSupervisorClientError } from '../agent-view/supervisor-client.js';
import {
  attachCommand,
  killCommand,
  logsCommand,
  respawnCommand,
  rmCommand,
  stopCommand,
} from './agent-session.js';

const mockWriteStdoutLine = vi.hoisted(() => vi.fn());
const mockWriteStderrLineSafe = vi.hoisted(() => vi.fn());
const mockSupervisor = vi.hoisted(() => ({
  attach: vi.fn(async (id: string) => ({ command: 'attach', id })),
  logs: vi.fn(async (id: string) => ({
    command: 'logs',
    id,
    output: 'hello from worker\n',
  })),
  stop: vi.fn(async (id: string) => ({ command: 'stop', id })),
  kill: vi.fn(async (id: string) => ({ command: 'kill', id })),
  respawn: vi.fn(
    async (target?: string): Promise<Record<string, unknown>> => ({
      command: 'respawn',
      target: target ?? 'all',
    }),
  ),
  remove: vi.fn(async (id: string) => ({ command: 'rm', id })),
}));
const mockEnsureAgentViewSupervisor = vi.hoisted(() =>
  vi.fn(async () => mockSupervisor),
);
const mockRequireAgentViewEnabled = vi.hoisted(() => vi.fn());

vi.mock('../utils/stdioHelpers.js', () => ({
  writeStderrLineSafe: mockWriteStderrLineSafe,
  writeStdoutLine: mockWriteStdoutLine,
}));

vi.mock('../agent-view/supervisor-runner.js', () => ({
  ensureAgentViewSupervisor: mockEnsureAgentViewSupervisor,
}));

vi.mock('../agent-view/feature.js', () => ({
  requireAgentViewEnabled: mockRequireAgentViewEnabled,
}));

const jsonSessionCommands = [
  { module: stopCommand, command: 'stop <id>', method: mockSupervisor.stop },
  { module: killCommand, command: 'kill <id>', method: mockSupervisor.kill },
  { module: rmCommand, command: 'rm <id>', method: mockSupervisor.remove },
] as const;

async function parseCommand(commandLine: string): Promise<void> {
  await yargs(commandLine.split(' '))
    .scriptName('qwen')
    .command(attachCommand)
    .command(logsCommand)
    .command(stopCommand)
    .command(killCommand)
    .command(respawnCommand)
    .command(rmCommand)
    .exitProcess(false)
    .fail((message, error) => {
      throw error ?? new Error(message);
    })
    .parseAsync();
}

function firstJsonOutput(): unknown {
  return JSON.parse(String(mockWriteStdoutLine.mock.calls[0]?.[0]));
}

describe('agent session commands', () => {
  beforeEach(() => {
    process.exitCode = undefined;
    vi.clearAllMocks();
  });

  it('exports the Agent View session command modules', () => {
    expect(attachCommand.command).toBe('attach <id>');
    expect(logsCommand.command).toBe('logs <id>');
    expect(jsonSessionCommands.map((entry) => entry.module.command)).toEqual([
      'stop <id>',
      'kill <id>',
      'rm <id>',
    ]);
    expect(respawnCommand.command).toBe('respawn [id]');
    expect(typeof respawnCommand.builder).toBe('function');
    expect(typeof respawnCommand.handler).toBe('function');
  });

  it('routes attach <id> to the supervisor without printing JSON', async () => {
    await parseCommand('attach session-1');

    expect(mockEnsureAgentViewSupervisor).toHaveBeenCalledOnce();
    expect(mockSupervisor.attach).toHaveBeenCalledWith('session-1');
    expect(mockWriteStdoutLine).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it('prints attach failures without throwing a stack trace', async () => {
    mockSupervisor.attach.mockRejectedValueOnce(new Error('not found'));

    await parseCommand('attach missing-session');

    expect(mockWriteStderrLineSafe).toHaveBeenCalledWith('not found');
    expect(process.exitCode).toBe(1);
  });

  it('routes logs <id> to the supervisor and prints raw output', async () => {
    await parseCommand('logs session-1');

    expect(mockEnsureAgentViewSupervisor).toHaveBeenCalledOnce();
    expect(mockSupervisor.logs).toHaveBeenCalledWith('session-1');
    expect(mockWriteStdoutLine).toHaveBeenCalledWith('hello from worker\n');
  });

  it.each(['logs', 'stop', 'kill', 'rm'])(
    'does not start the supervisor when %s is feature-gated',
    async (command) => {
      mockRequireAgentViewEnabled.mockImplementationOnce(() => {
        throw new Error('Agent View is disabled.');
      });

      await expect(parseCommand(`${command} session-1`)).rejects.toThrow(
        'Agent View is disabled.',
      );

      expect(mockEnsureAgentViewSupervisor).not.toHaveBeenCalled();
    },
  );

  it.each(jsonSessionCommands)(
    'routes $command to the supervisor and prints JSON',
    async ({ command, method }) => {
      const name = command.split(' ')[0];

      await parseCommand(`${name} session-1`);

      expect(mockEnsureAgentViewSupervisor).toHaveBeenCalledOnce();
      expect(method).toHaveBeenCalledWith('session-1');
      expect(firstJsonOutput()).toEqual({
        command: name,
        id: 'session-1',
      });
    },
  );

  it('routes respawn <id> to the supervisor and prints JSON', async () => {
    await parseCommand('respawn session-1');

    expect(mockSupervisor.respawn).toHaveBeenCalledWith('session-1');
    expect(firstJsonOutput()).toEqual({
      command: 'respawn',
      target: 'session-1',
    });
  });

  it('rejects respawn with both <id> and --all', async () => {
    await expect(parseCommand('respawn --all session-1')).rejects.toThrow(
      'qwen agents respawn accepts <id> or --all, not both.',
    );

    expect(mockSupervisor.respawn).not.toHaveBeenCalled();
  });

  it('rejects respawn with neither <id> nor --all', async () => {
    await expect(parseCommand('respawn')).rejects.toThrow(
      'qwen agents respawn requires <id> or --all.',
    );

    // The rejection must surface at the yargs check layer, before the
    // handler ensures (and may start) the daemon supervisor.
    expect(mockEnsureAgentViewSupervisor).not.toHaveBeenCalled();
    expect(mockSupervisor.respawn).not.toHaveBeenCalled();
  });

  it('rejects respawn with an empty <id>', async () => {
    await expect(parseCommand('respawn ')).rejects.toThrow();

    expect(mockSupervisor.respawn).not.toHaveBeenCalled();
  });

  it('keeps all-digit session ids as strings', async () => {
    await parseCommand('stop 12345678');

    expect(mockSupervisor.stop).toHaveBeenCalledWith('12345678');

    mockSupervisor.respawn.mockClear();
    await parseCommand('respawn 87654321');

    expect(mockSupervisor.respawn).toHaveBeenCalledWith('87654321');

    mockSupervisor.remove.mockClear();
    await parseCommand('rm 12345678');

    expect(mockSupervisor.remove).toHaveBeenCalledWith('12345678');

    mockSupervisor.attach.mockClear();
    await parseCommand('attach 12345678');

    expect(mockSupervisor.attach).toHaveBeenCalledWith('12345678');
  });

  it('routes respawn --all to the supervisor and prints JSON', async () => {
    await parseCommand('respawn --all');

    expect(mockSupervisor.respawn).toHaveBeenCalledWith();
    expect(firstJsonOutput()).toEqual({
      command: 'respawn',
      target: 'all',
    });
  });

  it('treats a respawn --all timeout as still in flight', async () => {
    mockSupervisor.respawn.mockRejectedValueOnce(
      new AgentViewSupervisorClientError(
        'Timed out waiting for Agent View supervisor response.',
        'timeout',
      ),
    );

    await parseCommand('respawn --all');

    expect(mockWriteStderrLineSafe).toHaveBeenCalledWith(
      'Respawn is still running in the supervisor. Check `qwen agents` for session status.',
    );
    expect(process.exitCode).toBeUndefined();
  });

  it('rethrows non-timeout respawn --all failures', async () => {
    mockSupervisor.respawn.mockRejectedValueOnce(
      new AgentViewSupervisorClientError('daemon gone', 'unavailable'),
    );

    await expect(parseCommand('respawn --all')).rejects.toThrow('daemon gone');
  });

  it('fails respawn --all when every session was skipped', async () => {
    mockSupervisor.respawn.mockResolvedValueOnce({
      all: true,
      results: [
        { id: 'session-1', skipped: true, reason: 'state is not exited' },
        { id: 'session-2', skipped: true, reason: 'state is not exited' },
      ],
    });

    await parseCommand('respawn --all');

    expect(process.exitCode).toBe(1);
  });

  it('succeeds respawn --all when at least one session respawned', async () => {
    mockSupervisor.respawn.mockResolvedValueOnce({
      all: true,
      results: [
        { id: 'session-1', skipped: true, reason: 'state is not exited' },
        { id: 'session-2', respawned: true },
      ],
    });

    await parseCommand('respawn --all');

    expect(process.exitCode).toBeUndefined();
  });
});
