/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Config } from '../../config/config.js';
import { Storage } from '../../config/storage.js';
import type { TeamFile } from './types.js';
import { TeamManager } from './TeamManager.js';
import {
  getTeamFilePath,
  getInboxesDir,
  getTasksDir,
  readTeamFile,
  writeTeamFile,
} from './teamHelpers.js';
import { createTask, listTasks, updateTask } from './tasks.js';
import { reattachTeamForSession } from './reattach-team.js';

vi.mock('../../config/storage.js', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../../config/storage.js')>();
  let mockGlobalDir = '';
  return {
    ...original,
    Storage: {
      ...original.Storage,
      getGlobalQwenDir: () => mockGlobalDir,
      __setMockGlobalDir: (dir: string) => {
        mockGlobalDir = dir;
      },
    },
  };
});

const fsHooks = vi.hoisted(() => ({
  readdir: undefined as (() => void) | undefined,
  readFile: undefined as ((p: string) => Promise<void>) | undefined,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  const wrapped = {
    ...original,
    readdir: (...args: Parameters<typeof original.readdir>) => {
      fsHooks.readdir?.();
      return original.readdir(...args);
    },
    readFile: async (...args: Parameters<typeof original.readFile>) => {
      const result = await original.readFile(...args);
      await fsHooks.readFile?.(String(args[0]));
      return result;
    },
  };
  return { ...wrapped, default: wrapped };
});

function deadPid(): number {
  return spawnSync(process.execPath, ['-e', '']).pid!;
}

function makeTeam(overrides: Partial<TeamFile> = {}): TeamFile {
  return {
    name: 'crew',
    createdAt: 1,
    leadAgentId: 'leader@crew',
    leadSessionId: 'session-1',
    leadPid: deadPid(),
    members: [
      {
        agentId: 'worker@crew',
        name: 'worker',
        joinedAt: 1,
        cwd: '/tmp',
        tmuxPaneId: '',
        subscriptions: [],
      },
    ],
    ...overrides,
  };
}

function makeConfig(over: Partial<Record<string, unknown>> = {}) {
  const state: { manager: TeamManager | null; ctx: unknown } = {
    manager: null,
    ctx: null,
  };
  const config = {
    isAgentTeamEnabled: vi.fn(() => true),
    getTeamManager: vi.fn(() => state.manager),
    setTeamManager: vi.fn((m: TeamManager | null) => {
      state.manager = m;
    }),
    setTeamContext: vi.fn((c: unknown) => {
      state.ctx = c;
    }),
    getSessionId: vi.fn(() => 'session-1'),
    getSubagentManager: vi.fn(() => undefined),
    getAgentsSettings: vi.fn(() => ({})),
    ...over,
  };
  return { config: config as unknown as Config, mocks: config, state };
}

describe('reattachTeamForSession', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'reattach-'));
    (
      Storage as unknown as { __setMockGlobalDir: (d: string) => void }
    ).__setMockGlobalDir(tmp);
  });

  afterEach(async () => {
    fsHooks.readdir = undefined;
    fsHooks.readFile = undefined;
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('does no I/O when the feature is off or a manager is already bound', async () => {
    const readdir = vi.fn();
    fsHooks.readdir = readdir;
    const off = makeConfig({ isAgentTeamEnabled: vi.fn(() => false) });
    expect(await reattachTeamForSession(off.config)).toBeNull();

    const bound = makeConfig();
    bound.state.manager = {} as TeamManager;
    expect(await reattachTeamForSession(bound.config)).toBeNull();

    expect(readdir).not.toHaveBeenCalled();
  });

  it('returns null when no team belongs to the session', async () => {
    await writeTeamFile('crew', makeTeam({ leadSessionId: 'other' }));
    const { config, mocks } = makeConfig();

    expect(await reattachTeamForSession(config)).toBeNull();
    expect(mocks.setTeamManager).not.toHaveBeenCalled();
  });

  it('leaves a team alone while another live process leads it', async () => {
    await writeTeamFile('crew', makeTeam({ leadPid: process.ppid }));
    const { config, mocks } = makeConfig();

    expect(await reattachTeamForSession(config)).toEqual({
      status: 'owned_elsewhere',
      teamName: 'crew',
    });
    expect(mocks.setTeamManager).not.toHaveBeenCalled();
    expect((await readTeamFile('crew'))!.members).toHaveLength(1);
  });

  it('takes over a dead leader: empties members, frees tasks, binds a manager, keeps unread mail', async () => {
    await writeTeamFile('crew', makeTeam());
    await createTask('crew', { subject: 's', description: 'd' });
    await updateTask('crew', '1', { status: 'in_progress', owner: 'worker' });
    await fs.mkdir(getInboxesDir('crew'), { recursive: true });
    const inbox = path.join(getInboxesDir('crew'), 'leader.json');
    const unread = [
      { from: 'worker', text: 'done', timestamp: 't', read: false },
    ];
    await fs.writeFile(inbox, JSON.stringify(unread));
    const workerInbox = path.join(getInboxesDir('crew'), 'worker.json');
    await fs.writeFile(
      workerInbox,
      JSON.stringify([
        { from: 'leader', text: 'stale', timestamp: 't', read: false },
      ]),
    );
    const { config, mocks, state } = makeConfig();

    const result = await reattachTeamForSession(config);

    expect(result).toEqual({
      status: 'reattached',
      teamName: 'crew',
      deadMembers: ['worker'],
      unassignedTaskCount: 1,
    });
    const file = (await readTeamFile('crew'))!;
    expect(file.leadPid).toBe(process.pid);
    expect(file.members).toEqual([]);
    expect((await listTasks('crew'))[0]).toMatchObject({ status: 'pending' });
    expect(state.manager).toBeInstanceOf(TeamManager);
    expect(mocks.setTeamContext).toHaveBeenCalledWith({
      teamName: 'crew',
      leadAgentId: 'leader@crew',
      teammates: {},
    });
    expect(JSON.parse(await fs.readFile(inbox, 'utf-8'))).toEqual(unread);
    await expect(fs.access(workerInbox)).rejects.toThrow();
  });

  it('preserves dead members for retry when task cleanup fails', async () => {
    const team = makeTeam();
    await writeTeamFile('crew', team);
    await createTask('crew', { subject: 's', description: 'd' });
    await updateTask('crew', '1', { status: 'in_progress', owner: 'worker' });
    const tasksDir = getTasksDir('crew');
    await fs.rename(tasksDir, `${tasksDir}-unavailable`);
    await fs.writeFile(tasksDir, 'unavailable');
    const { config, mocks } = makeConfig();

    await expect(reattachTeamForSession(config)).rejects.toMatchObject({
      code: 'ENOTDIR',
    });
    expect(await readTeamFile('crew')).toEqual(team);
    expect(mocks.setTeamManager).not.toHaveBeenCalled();

    await fs.unlink(tasksDir);
    await fs.rename(`${tasksDir}-unavailable`, tasksDir);

    expect(await reattachTeamForSession(config)).toEqual({
      status: 'reattached',
      teamName: 'crew',
      deadMembers: ['worker'],
      unassignedTaskCount: 1,
    });
    expect((await readTeamFile('crew'))!.members).toEqual([]);
    const [task] = await listTasks('crew');
    expect(task).toMatchObject({ status: 'pending' });
    expect(task).not.toHaveProperty('owner');
  });

  it('takes over a team recorded with this process pid', async () => {
    await writeTeamFile('crew', makeTeam({ leadPid: process.pid }));
    const { config } = makeConfig();

    expect(await reattachTeamForSession(config)).toMatchObject({
      status: 'reattached',
    });
  });

  it('backs off when the config changes between inspection and rewrite', async () => {
    await writeTeamFile('crew', makeTeam());
    let configReads = 0;
    fsHooks.readFile = async (p) => {
      if (p === getTeamFilePath('crew') && ++configReads === 1) {
        await writeTeamFile('crew', makeTeam({ description: 'raced' }));
      }
    };
    const { config, mocks } = makeConfig();

    expect(await reattachTeamForSession(config)).toBeNull();
    expect(mocks.setTeamManager).not.toHaveBeenCalled();
    expect((await readTeamFile('crew'))!.description).toBe('raced');
    expect((await readTeamFile('crew'))!.members).toHaveLength(1);
  });

  it('picks the newest valid team when multiple stale dirs match the session and skips unverifiable leadPid', async () => {
    await writeTeamFile('alpha', makeTeam({ name: 'alpha', createdAt: 10 }));
    await writeTeamFile('beta', makeTeam({ name: 'beta', createdAt: 50 }));
    await writeTeamFile(
      'gamma',
      makeTeam({ name: 'gamma', createdAt: 99, leadPid: 0 }),
    );
    const { config } = makeConfig();

    const result = await reattachTeamForSession(config);

    expect(result).toMatchObject({
      status: 'reattached',
      teamName: 'beta',
    });
  });

  it('backs off when a competing takeover wins on the guard read', async () => {
    await writeTeamFile('crew', makeTeam());
    let configReads = 0;
    fsHooks.readFile = async (p) => {
      if (p === getTeamFilePath('crew') && ++configReads === 2) {
        await writeTeamFile(
          'crew',
          makeTeam({
            leadPid: process.ppid,
            members: [],
            description: 'competitor',
          }),
        );
      }
    };
    const { config, mocks } = makeConfig();

    expect(await reattachTeamForSession(config)).toBeNull();
    expect(mocks.setTeamManager).not.toHaveBeenCalled();
    expect((await readTeamFile('crew'))!.description).toBe('competitor');
  });

  it('allows at most one winner when two resumers race concurrently', async () => {
    await writeTeamFile('crew', makeTeam());
    const first = makeConfig();
    const second = makeConfig();

    const results = await Promise.all([
      reattachTeamForSession(first.config),
      reattachTeamForSession(second.config),
    ]);

    expect(results.filter((r) => r?.status === 'reattached')).toHaveLength(1);
    expect(results.filter((r) => r === null)).toHaveLength(1);
  });

  it('skips unsanitized or empty member names when clearing dead teammate inboxes', async () => {
    const sentinel = path.join(tmp, 'settings.json');
    await fs.writeFile(sentinel, '{"safe":true}');
    await fs.mkdir(getInboxesDir('crew'), { recursive: true });
    const workerInbox = path.join(getInboxesDir('crew'), 'worker.json');
    const dotJsonSentinel = path.join(getInboxesDir('crew'), '.json');
    await fs.writeFile(workerInbox, '[]');
    await fs.writeFile(dotJsonSentinel, '{"dot":true}');
    await writeTeamFile(
      'crew',
      makeTeam({
        members: [
          {
            agentId: 'worker@crew',
            name: 'worker',
            joinedAt: 1,
            cwd: '/tmp',
            tmuxPaneId: '',
            subscriptions: [],
          },
          {
            agentId: 'bad@crew',
            name: '../../../settings',
            joinedAt: 2,
            cwd: '/tmp',
            tmuxPaneId: '',
            subscriptions: [],
          },
          {
            agentId: 'blank@crew',
            name: '',
            joinedAt: 3,
            cwd: '/tmp',
            tmuxPaneId: '',
            subscriptions: [],
          },
        ],
      }),
    );
    const { config } = makeConfig();

    const result = await reattachTeamForSession(config);

    expect(result?.status).toBe('reattached');
    expect(await fs.readFile(sentinel, 'utf-8')).toBe('{"safe":true}');
    expect(await fs.readFile(dotJsonSentinel, 'utf-8')).toBe('{"dot":true}');
    await expect(fs.access(workerInbox)).rejects.toThrow();
  });
});
