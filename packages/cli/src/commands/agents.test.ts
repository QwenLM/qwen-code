/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import yargs, { type Argv } from 'yargs';
import { agentsCommand, handleAgentViewBackgroundPrompt } from './agents.js';

const mockWriteStdoutLine = vi.hoisted(() => vi.fn());
const mockSupervisor = vi.hoisted(() => ({
  list: vi.fn(async () => [
    {
      sessionId: 'session-1',
      state: {
        schemaVersion: 1,
        sessionId: 'session-1',
        ownership: 'managed',
        sessionState: 'working',
        processState: 'alive',
        attachState: 'detached',
        projectCwd: '/tmp/workspace',
        originalCwd: '/tmp/workspace',
        activeCwd: '/tmp/workspace',
        createdAt: '2026-07-17T09:00:00.000Z',
        updatedAt: '2026-07-17T09:00:00.000Z',
        worktree: {
          mode: 'shared-unisolated',
          warning: 'Non-Git directory; sessions share one cwd.',
        },
      },
      activity: {
        schemaVersion: 1,
        summary: 'write tests',
        lastActivityAt: '2026-07-17T09:00:00.000Z',
        capabilities: [],
      },
      rosterEntry: {
        sessionId: 'session-1',
        projectCwd: '/tmp/workspace',
        activeCwd: '/tmp/workspace',
        displayName: 'Write Tests',
        pinned: true,
        createdAt: '2026-07-17T09:00:00.000Z',
        updatedAt: '2026-07-17T09:00:00.000Z',
      },
    },
    {
      sessionId: 'session-done',
      state: {
        schemaVersion: 1,
        sessionId: 'session-done',
        ownership: 'managed',
        sessionState: 'completed',
        processState: 'exited',
        attachState: 'detached',
        projectCwd: '/tmp/workspace',
        originalCwd: '/tmp/workspace',
        activeCwd: '/tmp/workspace',
        createdAt: '2026-07-17T08:00:00.000Z',
        updatedAt: '2026-07-17T08:00:00.000Z',
        worktree: { mode: 'none' },
      },
    },
  ]),
  dispatch: vi.fn(async () => ({ sessionId: 'session-2', state: 'created' })),
}));
const mockEnsureAgentViewSupervisor = vi.hoisted(() =>
  vi.fn(async () => mockSupervisor),
);

vi.mock('../utils/stdioHelpers.js', () => ({
  writeStdoutLine: mockWriteStdoutLine,
}));

vi.mock('../agent-view/supervisor-runner.js', () => ({
  ensureAgentViewSupervisor: mockEnsureAgentViewSupervisor,
}));

interface AgentsArgs {
  cwd?: string;
  json?: boolean;
  all?: boolean;
}

function buildParser(): Argv<AgentsArgs> {
  const builder = agentsCommand.builder;
  if (typeof builder !== 'function') {
    throw new Error('agents command builder must be a function');
  }
  return builder(
    yargs([]).exitProcess(false).fail(false).locale('en'),
  ) as Argv<AgentsArgs>;
}

describe('agents command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('has the command definition', () => {
    expect(agentsCommand.command).toBe('agents');
    expect(agentsCommand.describe).toBe('List background agents');
    expect(typeof agentsCommand.builder).toBe('function');
    expect(typeof agentsCommand.handler).toBe('function');
  });

  it('registers --cwd, --json, and --all options', () => {
    const options = (
      buildParser() as Argv & {
        getOptions(): { key: Record<string, boolean> };
      }
    ).getOptions();

    expect(options.key['cwd']).toBe(true);
    expect(options.key['json']).toBe(true);
    expect(options.key['all']).toBe(true);
  });

  it('prints active agents as a JSON array', async () => {
    const handler = agentsCommand.handler;
    if (!handler) throw new Error('agents command handler missing');

    await handler(
      buildParser().parseSync('--cwd /tmp/workspace --json') as Parameters<
        typeof handler
      >[0],
    );

    const payload = JSON.parse(
      String(mockWriteStdoutLine.mock.calls[0]?.[0]),
    ) as unknown[];
    expect(payload).toEqual([
      expect.objectContaining({
        sessionId: 'session-1',
        name: 'Write Tests',
        state: 'working',
        processState: 'alive',
        projectCwd: '/tmp/workspace',
        activeCwd: '/tmp/workspace',
        attached: false,
        pinned: true,
        createdAt: '2026-07-17T09:00:00.000Z',
        updatedAt: '2026-07-17T09:00:00.000Z',
        summary: 'write tests',
      }),
    ]);
    expect(mockSupervisor.list).toHaveBeenCalledWith('/tmp/workspace');
  });

  it('lists all projects by default for JSON output', async () => {
    const handler = agentsCommand.handler;
    if (!handler) throw new Error('agents command handler missing');

    await handler(
      buildParser().parseSync('--json') as Parameters<typeof handler>[0],
    );

    expect(mockSupervisor.list).toHaveBeenCalledWith(undefined);
  });

  it('includes completed agents in JSON output with --all', async () => {
    const handler = agentsCommand.handler;
    if (!handler) throw new Error('agents command handler missing');

    await handler(
      buildParser().parseSync(
        '--cwd /tmp/workspace --json --all',
      ) as Parameters<typeof handler>[0],
    );

    const payload = JSON.parse(
      String(mockWriteStdoutLine.mock.calls[0]?.[0]),
    ) as Array<{ sessionId: string; state: string }>;
    expect(payload.map((agent) => agent.sessionId)).toEqual([
      'session-1',
      'session-done',
    ]);
    expect(payload[1]).toMatchObject({
      sessionId: 'session-done',
      state: 'completed',
      processState: 'exited',
      pinned: false,
      attached: false,
    });
  });

  it('rejects --all without --json', async () => {
    expect(() => buildParser().parseSync('--all')).toThrow(
      'qwen agents --all requires --json.',
    );
  });

  it('prints a text list when --json is not set', async () => {
    const handler = agentsCommand.handler;
    if (!handler) throw new Error('agents command handler missing');

    await handler(
      buildParser().parseSync('--cwd /tmp/workspace') as Parameters<
        typeof handler
      >[0],
    );

    expect(mockWriteStdoutLine).toHaveBeenCalledWith(
      'session-1 working alive /tmp/workspace Write Tests write tests',
    );
    expect(mockSupervisor.list).toHaveBeenCalledWith('/tmp/workspace');
  });

  it('dispatches a background prompt through the supervisor', async () => {
    await handleAgentViewBackgroundPrompt('write tests');

    expect(mockSupervisor.dispatch).toHaveBeenCalledWith(
      'write tests',
      process.cwd(),
    );
    expect(mockWriteStdoutLine.mock.calls.map((call) => call[0])).toEqual([
      'Started background agent session-2.',
      'Open with qwen agents.',
      'Attach with qwen attach session-2.',
      'View logs with qwen logs session-2.',
    ]);
  });
});
