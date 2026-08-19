/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import yargs, { type Argv } from 'yargs';
import * as path from 'node:path';
import {
  agentsCommand,
  agentsInteractiveSession,
  agentsListCommand,
  handleAgentViewBackgroundPrompt,
  runAgentsInteractiveSession,
} from './agents.js';

const mockWriteStdoutLine = vi.hoisted(() => vi.fn());
const mockLoadSettings = vi.hoisted(() =>
  vi.fn(() => ({
    merged: {
      security: { auth: { selectedType: 'openai' } },
      model: { name: 'settings-model' },
      modelProviders: {
        idealab: [{ id: 'settings-model' }],
      },
      env: {},
    },
  })),
);
const mockGetCliVersion = vi.hoisted(() => vi.fn(async () => 'test-version'));
const mockShowResumeSessionPickerItem = vi.hoisted(() =>
  vi.fn(
    async () =>
      undefined as
        | {
            sessionId: string;
            cwd: string;
            startTime: string;
            mtime: number;
            prompt: string;
            filePath: string;
          }
        | undefined,
  ),
);
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
        activeCwd: '/tmp/workspace/.qwen/worktrees/fix-tests',
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
        waitingFor: 'permission',
        queuedPromptCount: 2,
        lastActivityAt: '2026-07-17T09:00:00.000Z',
        capabilities: [],
      },
      worker: {
        schemaVersion: 1,
        protocolVersion: 1,
        platform: 'darwin',
        recentOutputBytes: 0,
        lastHeartbeatAt: '2026-07-17T09:00:00.000Z',
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
      sessionId: 'session-attached',
      state: {
        schemaVersion: 1,
        sessionId: 'session-attached',
        ownership: 'managed',
        sessionState: 'idle',
        processState: 'alive',
        attachState: 'attached',
        projectCwd: '/tmp/workspace',
        originalCwd: '/tmp/workspace',
        activeCwd: '/tmp/other-project',
        createdAt: '2026-07-17T08:30:00.000Z',
        updatedAt: '2026-07-17T08:30:00.000Z',
        worktree: { mode: 'none' },
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
  subscribe: vi.fn(() => ({ dispose: vi.fn() })),
  dispatch: vi.fn(async () => ({ sessionId: 'session-2', state: 'created' })),
  adopt: vi.fn(async () => ({ sessionId: 'session-resume', adopted: true })),
  attach: vi.fn(async () => ({ attached: true })),
  peek: vi.fn(async () => ({
    sessionId: 'session-1',
    state: {
      schemaVersion: 1,
      sessionId: 'session-1',
      ownership: 'managed',
      sessionState: 'needs_input',
      processState: 'alive',
      attachState: 'detached',
      projectCwd: '/tmp/workspace',
      originalCwd: '/tmp/workspace',
      activeCwd: '/tmp/workspace',
      createdAt: '2026-07-17T09:00:00.000Z',
      updatedAt: '2026-07-17T09:00:00.000Z',
      worktree: { mode: 'none' },
    },
    activity: {
      schemaVersion: 1,
      waitingFor: 'permission',
      summary: 'write tests',
      lastActivityAt: '2026-07-17T09:00:00.000Z',
      capabilities: [],
    },
    worker: {
      schemaVersion: 1,
      protocolVersion: 1,
      platform: 'darwin',
      recentOutputBytes: 0,
      workerPid: 123,
    },
    live: true,
  })),
  send: vi.fn(async () => ({ sent: true })),
  answer: vi.fn(async () => ({ answered: true })),
  pin: vi.fn(async () => ({ pinned: true })),
  rename: vi.fn(async () => ({ displayName: 'Build Fix' })),
  stop: vi.fn(async () => ({ stopped: true })),
  remove: vi.fn(async () => ({ removed: true })),
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

vi.mock('../config/settings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config/settings.js')>();
  return {
    ...actual,
    loadSettings: mockLoadSettings,
  };
});

vi.mock('../utils/version.js', () => ({
  getCliVersion: mockGetCliVersion,
}));

vi.mock('../ui/components/StandaloneSessionPicker.js', () => ({
  showResumeSessionPickerItem: mockShowResumeSessionPickerItem,
}));

interface AgentsArgs {
  cwd?: string;
  json?: boolean;
  all?: boolean;
}

function buildParser(): Argv<AgentsArgs> {
  const builder = agentsListCommand.builder;
  if (typeof builder !== 'function') {
    throw new Error('agents list command builder must be a function');
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

  it('has the Phase 1 command definition', () => {
    expect(agentsCommand.command).toBe('agents');
    expect(agentsCommand.describe).toBe('Manage Agent View background agents');
    expect(typeof agentsCommand.builder).toBe('function');
    expect(typeof agentsCommand.handler).toBe('function');
  });

  it.each([
    ['routes bare `agents` to the list handler', ''],
    ['routes `agents --json` to the list handler', '--json'],
  ])('%s', async (_label, flags) => {
    const builder = agentsCommand.builder;
    if (typeof builder !== 'function') {
      throw new Error('agents command builder must be a function');
    }
    const parser = await Promise.resolve(
      builder(
        yargs([])
          .exitProcess(false)
          .fail((message, error) => {
            throw error ?? new Error(message);
          })
          .locale('en'),
      ),
    );

    await parser.parseAsync(`agents ${flags}`.trim());

    expect(mockSupervisor.list).toHaveBeenCalled();
    expect(mockWriteStdoutLine).toHaveBeenCalled();
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

  it('prints all managed agents as a JSON array without entering interactive helper', async () => {
    const runSpy = vi.spyOn(agentsInteractiveSession, 'run');
    const handler = agentsListCommand.handler;
    if (!handler) throw new Error('agents list command handler missing');

    await handler(
      buildParser().parseSync(
        '--cwd /tmp/workspace --json --all',
      ) as Parameters<typeof handler>[0],
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
        activeCwd: '/tmp/workspace/.qwen/worktrees/fix-tests',
        attached: false,
        pinned: true,
        createdAt: '2026-07-17T09:00:00.000Z',
        updatedAt: '2026-07-17T09:00:00.000Z',
        summary: 'write tests',
        waitingFor: 'permission',
        queuedPromptCount: 2,
      }),
      expect.objectContaining({
        sessionId: 'session-attached',
        state: 'idle',
        processState: 'alive',
        projectCwd: '/tmp/workspace',
        activeCwd: '/tmp/other-project',
        attached: true,
        pinned: false,
      }),
      expect.objectContaining({
        sessionId: 'session-done',
        state: 'completed',
        processState: 'exited',
        pinned: false,
        attached: false,
      }),
    ]);
    expect(mockSupervisor.list).toHaveBeenCalledWith(
      path.resolve('/tmp/workspace'),
    );
    expect(runSpy).not.toHaveBeenCalled();
  });

  it('omits completed agents from JSON unless --all is set', async () => {
    const handler = agentsListCommand.handler;
    if (!handler) throw new Error('agents list command handler missing');

    await handler(
      buildParser().parseSync('--json') as Parameters<typeof handler>[0],
    );

    const payload = JSON.parse(
      String(mockWriteStdoutLine.mock.calls[0]?.[0]),
    ) as Array<{ sessionId: string }>;
    expect(payload.map((session) => session.sessionId)).toEqual([
      'session-1',
      'session-attached',
    ]);
  });

  it('lists all projects by default for JSON output', async () => {
    const handler = agentsListCommand.handler;
    if (!handler) throw new Error('agents list command handler missing');

    await handler(
      buildParser().parseSync('--json') as Parameters<typeof handler>[0],
    );

    expect(mockSupervisor.list).toHaveBeenCalledWith(undefined);
  });

  it('runs the interactive helper when --json is not set', async () => {
    const runSpy = vi
      .spyOn(agentsInteractiveSession, 'run')
      .mockResolvedValue(undefined);
    const handler = agentsListCommand.handler;
    if (!handler) throw new Error('agents list command handler missing');

    await handler(
      buildParser().parseSync('--cwd /tmp/workspace') as Parameters<
        typeof handler
      >[0],
    );

    expect(runSpy).toHaveBeenCalledOnce();
    expect(runSpy.mock.calls[0]?.[0]).toEqual({
      cwd: path.resolve('/tmp/workspace'),
      listCwd: path.resolve('/tmp/workspace'),
      supervisor: mockSupervisor,
      renderRoster: expect.any(Function),
      header: expect.objectContaining({
        version: 'test-version',
        cwd: path.resolve('/tmp/workspace'),
        model: 'settings-model',
        providerLabel: 'Idealab',
      }),
    });
    expect(mockSupervisor.list).not.toHaveBeenCalled();
  });

  it('prints a text roster when --json is not set and stdout is not a TTY', async () => {
    const snapshots = structuredClone(await mockSupervisor.list());
    mockSupervisor.list.mockClear();
    snapshots[0]!.state.activeCwd = '\u001b]0;spoof\u0007/tmp/work\nspace';
    snapshots[0]!.activity!.summary = 'write\nmore tests';
    mockSupervisor.list.mockResolvedValueOnce(snapshots);
    const handler = agentsListCommand.handler;
    if (!handler) throw new Error('agents list command handler missing');

    await handler(
      buildParser().parseSync('--cwd /tmp/workspace') as Parameters<
        typeof handler
      >[0],
    );

    const output = String(mockWriteStdoutLine.mock.calls[0]?.[0]);
    const lines = output.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(
      /^session-1 Working alive \/tmp\/work space \S+ write more tests$/,
    );
    expect(
      lines.some((line) => line.startsWith('session-attached Idle alive ')),
    ).toBe(true);
    expect(
      lines.some((line) => line.startsWith('session-done Completed offline ')),
    ).toBe(true);
    expect(output).not.toContain('spoof');
  });

  it('prints a placeholder when the non-TTY roster is empty', async () => {
    vi.mocked(mockSupervisor.list).mockResolvedValueOnce([]);
    const handler = agentsListCommand.handler;
    if (!handler) throw new Error('agents list command handler missing');

    await handler(
      buildParser().parseSync('--cwd /tmp/workspace') as Parameters<
        typeof handler
      >[0],
    );

    expect(mockWriteStdoutLine).toHaveBeenCalledWith('No background agents.');
  });

  it('builds rows for the roster renderer', async () => {
    const renderRoster = vi.fn();

    await runAgentsInteractiveSession({
      cwd: '/tmp/workspace',
      supervisor: mockSupervisor,
      renderRoster,
    });

    expect(mockSupervisor.list).toHaveBeenCalledWith(undefined);
    expect(renderRoster).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          sessionId: 'session-1',
          displayName: 'Write Tests',
          pinned: true,
          stateLabel: 'Working',
          cwd: '/tmp/workspace/.qwen/worktrees/fix-tests',
          summary: 'write tests',
        }),
      ]),
      expect.objectContaining({
        dispatchPrompt: expect.any(Function),
        peekSelected: expect.any(Function),
        sendToSession: expect.any(Function),
        answerSession: expect.any(Function),
        pinSession: expect.any(Function),
        renameSession: expect.any(Function),
        stopSession: expect.any(Function),
        removeSession: expect.any(Function),
        loadRows: expect.any(Function),
        subscribeToChanges: expect.any(Function),
      }),
      undefined,
      undefined,
    );
  });

  it('filters roster rows when listCwd is provided', async () => {
    await runAgentsInteractiveSession({
      cwd: '/tmp/workspace',
      listCwd: '/tmp/workspace',
      supervisor: mockSupervisor,
      renderRoster: vi.fn(),
    });

    expect(mockSupervisor.list).toHaveBeenCalledWith('/tmp/workspace');
  });

  it('dispatches without attaching inside roster actions', async () => {
    const calls: string[] = [];
    const supervisor = {
      list: vi.fn(async () => []),
      subscribe: vi.fn(() => ({ dispose: vi.fn() })),
      dispatch: vi.fn(async () => {
        calls.push('dispatch');
        return { sessionId: 'new-session' };
      }),
      adopt: vi.fn(),
      attach: vi.fn(async () => {
        calls.push('attach');
      }),
      peek: vi.fn(),
      send: vi.fn(),
      answer: vi.fn(),
      pin: vi.fn(),
      rename: vi.fn(),
      stop: vi.fn(),
      remove: vi.fn(),
    };

    await runAgentsInteractiveSession({
      cwd: '/tmp/workspace',
      supervisor,
      renderRoster: async (_rows, actions) => {
        await actions.dispatchPrompt('  write tests  ', true);
      },
    });

    expect(supervisor.dispatch).toHaveBeenCalledWith(
      'write tests',
      '/tmp/workspace',
    );
    expect(supervisor.attach).not.toHaveBeenCalled();
    expect(calls).toEqual(['dispatch']);
  });

  it('attaches after the roster returns an attach intent', async () => {
    const calls: string[] = [];
    let renderCount = 0;
    const supervisor = {
      list: vi.fn(async () => []),
      subscribe: vi.fn(() => ({ dispose: vi.fn() })),
      dispatch: vi.fn(async () => {
        calls.push('dispatch');
        return { sessionId: 'new-session' };
      }),
      adopt: vi.fn(),
      attach: vi.fn(async () => {
        calls.push('attach');
      }),
      peek: vi.fn(),
      send: vi.fn(),
      answer: vi.fn(),
      pin: vi.fn(),
      rename: vi.fn(),
      stop: vi.fn(),
      remove: vi.fn(),
    };

    await runAgentsInteractiveSession({
      cwd: '/tmp/workspace',
      supervisor,
      renderRoster: async (_rows, actions) => {
        renderCount += 1;
        if (renderCount > 1) {
          return { type: 'exit' };
        }
        const result = await actions.dispatchPrompt('write tests', true);
        expect(result).toEqual({ sessionId: 'new-session' });
        return { type: 'attach', sessionId: 'new-session' };
      },
    });

    expect(supervisor.attach).toHaveBeenCalledWith('new-session');
    expect(calls).toEqual(['dispatch', 'attach']);
  });

  it('keeps a foreground subscription alive while attaching', async () => {
    const calls: string[] = [];
    let renderCount = 0;
    const dispose = vi.fn(() => {
      calls.push('dispose');
    });
    const supervisor = {
      list: vi.fn(async () => []),
      subscribe: vi.fn(() => {
        calls.push('subscribe');
        return { dispose };
      }),
      dispatch: vi.fn(),
      adopt: vi.fn(),
      attach: vi.fn(async () => {
        calls.push('attach');
        expect(dispose).not.toHaveBeenCalled();
      }),
      peek: vi.fn(),
      send: vi.fn(),
      answer: vi.fn(),
      pin: vi.fn(),
      rename: vi.fn(),
      stop: vi.fn(),
      remove: vi.fn(),
    };

    await runAgentsInteractiveSession({
      cwd: '/tmp/workspace',
      supervisor,
      renderRoster: async () => {
        renderCount += 1;
        return renderCount === 1
          ? { type: 'attach', sessionId: 'session-1' }
          : { type: 'exit' };
      },
    });

    expect(calls).toEqual(['subscribe', 'attach', 'dispose']);
  });

  it('reopens the roster with an error panel when attach fails', async () => {
    let renderCount = 0;
    const supervisor = {
      list: vi.fn(async () => []),
      subscribe: vi.fn(() => ({ dispose: vi.fn() })),
      dispatch: vi.fn(),
      adopt: vi.fn(),
      attach: vi.fn(async () => {
        throw new Error('stale PTY host');
      }),
      peek: vi.fn(),
      send: vi.fn(),
      answer: vi.fn(),
      pin: vi.fn(),
      rename: vi.fn(),
      stop: vi.fn(),
      remove: vi.fn(),
    };

    await runAgentsInteractiveSession({
      cwd: '/tmp/workspace',
      supervisor,
      renderRoster: async (_rows, _actions, initialPeekPanel) => {
        renderCount += 1;
        if (renderCount === 1) {
          expect(initialPeekPanel).toBeUndefined();
          return { type: 'attach', sessionId: 'session-1' };
        }
        expect(initialPeekPanel).toEqual({
          title: 'session-1',
          lines: ['stale PTY host'],
          error: true,
        });
        return { type: 'exit' };
      },
    });

    expect(supervisor.attach).toHaveBeenCalledWith('session-1');
    expect(renderCount).toBe(2);
  });

  it('renders an error panel when the initial roster load fails', async () => {
    const supervisor = {
      ...mockSupervisor,
      list: vi.fn(async () => {
        throw new Error('supervisor unavailable');
      }),
    };

    await expect(
      runAgentsInteractiveSession({
        cwd: '/tmp/workspace',
        supervisor,
        renderRoster: async (rows, _actions, initialPeekPanel) => {
          expect(rows).toEqual([]);
          expect(initialPeekPanel).toEqual({
            title: 'Agent View',
            lines: ['supervisor unavailable'],
            error: true,
          });
          return { type: 'exit' };
        },
      }),
    ).resolves.toBeUndefined();
  });

  it('adopts a picked history session when the roster requests resume', async () => {
    let renderCount = 0;
    const supervisor = {
      list: vi.fn(async () => []),
      subscribe: vi.fn(() => ({ dispose: vi.fn() })),
      dispatch: vi.fn(),
      adopt: vi.fn(async () => ({
        sessionId: '123e4567-e89b-12d3-a456-426614174000',
        adopted: true,
      })),
      attach: vi.fn(),
      peek: vi.fn(async () => {
        throw new Error('not managed');
      }),
      send: vi.fn(),
      answer: vi.fn(),
      pin: vi.fn(),
      rename: vi.fn(),
      stop: vi.fn(),
      remove: vi.fn(),
    };
    mockShowResumeSessionPickerItem.mockResolvedValueOnce({
      sessionId: '123e4567-e89b-12d3-a456-426614174000',
      cwd: '/tmp/history-workspace',
      startTime: '2026-07-17T08:00:00.000Z',
      mtime: Date.parse('2026-07-17T08:00:00.000Z'),
      prompt: 'historical prompt',
      filePath: '/tmp/history-workspace/.qwen/chats/session.jsonl',
    });

    await runAgentsInteractiveSession({
      cwd: '/tmp/workspace',
      supervisor,
      renderRoster: async (_rows, _actions, initialPeekPanel) => {
        renderCount += 1;
        if (renderCount === 1) {
          return { type: 'resume' };
        }
        expect(initialPeekPanel).toEqual({
          title: '123e4567-e89b-12d3-a456-426614174000',
          lines: ['Session added to Agent View.'],
        });
        return { type: 'exit' };
      },
    });

    expect(mockShowResumeSessionPickerItem).toHaveBeenCalledWith(
      '/tmp/workspace',
      undefined,
      {
        includeAgentViewSessions: false,
        allowManagedAgentViewSelection: true,
      },
    );
    expect(supervisor.dispatch).not.toHaveBeenCalled();
    expect(supervisor.adopt).toHaveBeenCalledWith({
      sessionId: '123e4567-e89b-12d3-a456-426614174000',
      projectCwd: path.resolve('/tmp/history-workspace'),
      activeCwd: path.resolve('/tmp/history-workspace'),
      terminal: {
        columns: expect.any(Number),
        rows: expect.any(Number),
      },
    });
  });

  it('does not re-adopt a history session that is already managed', async () => {
    mockShowResumeSessionPickerItem.mockResolvedValueOnce({
      sessionId: 'managed-session',
      cwd: '/tmp/history-workspace',
      startTime: '2026-07-17T08:00:00.000Z',
      mtime: Date.parse('2026-07-17T08:00:00.000Z'),
      prompt: 'historical prompt',
      filePath: '/tmp/history-workspace/.qwen/chats/session.jsonl',
    });
    let renderCount = 0;

    await runAgentsInteractiveSession({
      cwd: '/tmp/workspace',
      supervisor: mockSupervisor,
      renderRoster: async (_rows, _actions, initialPeekPanel) => {
        renderCount += 1;
        if (renderCount === 1) return { type: 'resume' };
        expect(initialPeekPanel).toEqual({
          title: 'managed-session',
          lines: ['Session is already managed by Agent View.'],
        });
        return { type: 'exit' };
      },
    });

    expect(mockSupervisor.adopt).not.toHaveBeenCalled();
  });

  it('shows adoption failures in a persistent error panel', async () => {
    mockShowResumeSessionPickerItem.mockResolvedValueOnce({
      sessionId: 'history-session',
      cwd: '/tmp/history-workspace',
      startTime: '2026-07-17T08:00:00.000Z',
      mtime: Date.parse('2026-07-17T08:00:00.000Z'),
      prompt: 'historical prompt',
      filePath: '/tmp/history-workspace/.qwen/chats/session.jsonl',
    });
    mockSupervisor.peek.mockRejectedValueOnce(new Error('not managed'));
    mockSupervisor.adopt.mockRejectedValueOnce(new Error('adopt failed'));
    let renderCount = 0;

    await runAgentsInteractiveSession({
      cwd: '/tmp/workspace',
      supervisor: mockSupervisor,
      renderRoster: async (_rows, _actions, initialPeekPanel) => {
        renderCount += 1;
        if (renderCount === 1) return { type: 'resume' };
        expect(initialPeekPanel).toEqual({
          title: 'history-session',
          lines: ['adopt failed'],
          error: true,
        });
        return { type: 'exit' };
      },
    });
  });

  it('shows picker failures in a persistent error panel', async () => {
    mockShowResumeSessionPickerItem.mockRejectedValueOnce(
      new Error('cannot read session history'),
    );
    let renderCount = 0;

    await runAgentsInteractiveSession({
      cwd: '/tmp/workspace',
      supervisor: mockSupervisor,
      renderRoster: async (_rows, _actions, initialPeekPanel) => {
        renderCount += 1;
        if (renderCount === 1) return { type: 'resume' };
        expect(initialPeekPanel).toEqual({
          title: 'Resume',
          lines: ['cannot read session history'],
          error: true,
        });
        return { type: 'exit' };
      },
    });

    expect(renderCount).toBe(2);
  });

  it('sends and answers selected sessions through the supervisor', async () => {
    await runAgentsInteractiveSession({
      cwd: '/tmp/workspace',
      supervisor: mockSupervisor,
      renderRoster: async (_rows, actions) => {
        await actions.sendToSession('idle-session', 'next');
        await actions.answerSession('needs-input-session', 'yes');
      },
    });

    expect(mockSupervisor.send).toHaveBeenCalledWith('idle-session', 'next');
    expect(mockSupervisor.answer).toHaveBeenCalledWith(
      'needs-input-session',
      'yes',
    );
  });

  it('pins and renames selected sessions through the supervisor', async () => {
    await runAgentsInteractiveSession({
      cwd: '/tmp/workspace',
      supervisor: mockSupervisor,
      renderRoster: async (_rows, actions) => {
        await actions.pinSession('session-1');
        await actions.renameSession('session-1', 'Build Fix');
      },
    });

    expect(mockSupervisor.pin).toHaveBeenCalledWith('session-1');
    expect(mockSupervisor.rename).toHaveBeenCalledWith(
      'session-1',
      'Build Fix',
    );
  });

  it('stops and removes selected sessions through the supervisor', async () => {
    await runAgentsInteractiveSession({
      cwd: '/tmp/workspace',
      supervisor: mockSupervisor,
      renderRoster: async (_rows, actions) => {
        await actions.stopSession('session-1');
        await actions.removeSession('session-1');
      },
    });

    expect(mockSupervisor.stop).toHaveBeenCalledWith('session-1');
    expect(mockSupervisor.remove).toHaveBeenCalledWith('session-1');
  });

  it('peeks selected session details through the supervisor', async () => {
    let panel;

    await runAgentsInteractiveSession({
      cwd: '/tmp/workspace',
      supervisor: mockSupervisor,
      renderRoster: async (_rows, actions) => {
        panel = await actions.peekSelected('session-1');
      },
    });

    expect(mockSupervisor.peek).toHaveBeenCalledWith('session-1');
    expect(panel).toEqual({
      title: 'session-1',
      lines: ['Waiting: permission', 'Summary: write tests'],
    });
  });

  it('rejects blank prompts', async () => {
    await expect(
      runAgentsInteractiveSession({
        cwd: '/tmp/workspace',
        supervisor: mockSupervisor,
        renderRoster: async (_rows, actions) => {
          await actions.dispatchPrompt('   ', false);
        },
      }),
    ).rejects.toThrow('Prompt cannot be empty.');

    expect(mockSupervisor.dispatch).not.toHaveBeenCalled();
    expect(mockSupervisor.attach).not.toHaveBeenCalled();
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
      'Attach with qwen agents attach session-2.',
      'View logs with qwen agents logs session-2.',
    ]);
  });
});
