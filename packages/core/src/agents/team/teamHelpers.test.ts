/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { TeamFile, TeamMember } from './types.js';
import {
  sanitizeName,
  formatAgentId,
  generateUniqueTeammateName,
  assignTeammateColor,
  clearTeammateColors,
  setMemberActive,
  findMemberById,
  findMemberByName,
  classifyShutdownResponse,
  readTeamFile,
  writeTeamFile,
  deleteTeamDirs,
  tryReclaimStaleTeam,
  getTeamDir,
  getTeamFilePath,
  getInboxesDir,
  getTasksDir,
} from './teamHelpers.js';
import { TEAMMATE_COLORS } from './types.js';
import { Storage } from '../../config/storage.js';

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

// Mock node:fs/promises to allow per-test override of fs.rm.
// All other functions pass through to the real implementation.
let rmMockOverride:
  | ((...args: Parameters<typeof fs.rm>) => Promise<unknown>)
  | null = null;
// Optional readFile hook for simulating mid-reclaim I/O failures.
// While a hook is installed and returns a value, that value is used;
// otherwise the real readFile runs.
vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  type ReadFileHook = (
    ...args: Parameters<typeof original.readFile>
  ) => unknown;
  let readFileHook: ReadFileHook | undefined;
  return {
    ...original,
    default: original,
    __setReadFileHook: (fn: ReadFileHook | undefined) => {
      readFileHook = fn;
    },
    rm: (...args: Parameters<typeof fs.rm>) => {
      if (rmMockOverride) return rmMockOverride(...args);
      return original.rm(...args);
    },
    readFile: (...args: Parameters<typeof original.readFile>) => {
      const hooked = readFileHook?.(...args);
      if (hooked !== undefined) {
        return hooked;
      }
      return original.readFile(...args);
    },
  };
});

function setFsRmMock(
  fn: ((...args: Parameters<typeof fs.rm>) => Promise<unknown>) | null,
) {
  rmMockOverride = fn;
}
const { __setReadFileHook } = (await import('node:fs/promises')) as unknown as {
  __setReadFileHook: (fn?: unknown) => void;
};

// ─── Fixtures ─────────────────────────────────────────────────

function makeMember(
  overrides: Partial<TeamMember> & { name: string },
): TeamMember {
  const { name, ...rest } = overrides;
  return {
    agentId: `${name}@test-team`,
    name,
    joinedAt: Date.now(),
    cwd: '/tmp',
    tmuxPaneId: '',
    subscriptions: [],
    ...rest,
  };
}

function makeTeamFile(overrides?: Partial<TeamFile>): TeamFile {
  return {
    name: 'test-team',
    createdAt: Date.now(),
    leadAgentId: 'leader@test-team',
    members: [],
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────

describe('sanitizeName', () => {
  it('lowercases and replaces special characters', () => {
    expect(sanitizeName('My Team!')).toBe('my-team');
  });

  it('collapses consecutive hyphens', () => {
    expect(sanitizeName('a---b')).toBe('a-b');
  });

  it('trims leading and trailing hyphens', () => {
    expect(sanitizeName('-hello-')).toBe('hello');
  });

  it('handles spaces and mixed case', () => {
    expect(sanitizeName('Hello World 123')).toBe('hello-world-123');
  });

  it('preserves already clean names', () => {
    expect(sanitizeName('my-agent')).toBe('my-agent');
  });

  it('handles empty string', () => {
    expect(sanitizeName('')).toBe('');
  });
});

describe('formatAgentId', () => {
  it('creates name@team format', () => {
    expect(formatAgentId('Worker', 'My Team')).toBe('worker@my-team');
  });

  it('sanitizes both parts', () => {
    expect(formatAgentId('Bob!', 'Team #1')).toBe('bob@team-1');
  });
});

describe('generateUniqueTeammateName', () => {
  it('returns sanitized name when no conflict', () => {
    expect(generateUniqueTeammateName('Worker', [])).toBe('worker');
  });

  it('throws on duplicate name', () => {
    const members = [makeMember({ name: 'worker' })];
    expect(() => generateUniqueTeammateName('Worker', members)).toThrow(
      'A teammate named "worker" already exists',
    );
  });

  it('throws on duplicate even with multiple members', () => {
    const members = [
      makeMember({ name: 'worker' }),
      makeMember({ name: 'designer' }),
    ];
    expect(() => generateUniqueTeammateName('Worker', members)).toThrow(
      'already exists',
    );
  });

  it('allows different names', () => {
    const members = [makeMember({ name: 'worker' })];
    expect(generateUniqueTeammateName('Designer', members)).toBe('designer');
  });

  it('rejects names that sanitize to empty string', () => {
    expect(() => generateUniqueTeammateName('@@@', [])).toThrow(
      'sanitizes to an empty string',
    );
    expect(() => generateUniqueTeammateName('', [])).toThrow(
      'sanitizes to an empty string',
    );
  });

  it('rejects the reserved leader name', () => {
    expect(() => generateUniqueTeammateName('leader', [])).toThrow(
      'reserved for the team leader',
    );
    expect(() => generateUniqueTeammateName('LEADER', [])).toThrow(
      'reserved for the team leader',
    );
  });
});

describe('assignTeammateColor', () => {
  it('assigns first color when no members', () => {
    expect(assignTeammateColor([])).toBe(TEAMMATE_COLORS[0]);
  });

  it('skips already used colors', () => {
    const members = [makeMember({ name: 'a', color: TEAMMATE_COLORS[0] })];
    expect(assignTeammateColor(members)).toBe(TEAMMATE_COLORS[1]);
  });

  it('wraps around when all colors taken', () => {
    const members = TEAMMATE_COLORS.map((color, i) =>
      makeMember({ name: `m${i}`, color }),
    );
    // 10 members using all 10 colors → wraps to index 0
    expect(assignTeammateColor(members)).toBe(TEAMMATE_COLORS[0]);
  });
});

describe('clearTeammateColors', () => {
  it('removes color from all members', () => {
    const members = [
      makeMember({ name: 'a', color: '#FF0000' }),
      makeMember({ name: 'b', color: '#00FF00' }),
    ];
    const cleared = clearTeammateColors(members);

    expect(cleared[0]!.color).toBeUndefined();
    expect(cleared[1]!.color).toBeUndefined();
  });

  it('does not mutate input', () => {
    const members = [makeMember({ name: 'a', color: '#FF0000' })];
    clearTeammateColors(members);
    expect(members[0]!.color).toBe('#FF0000');
  });

  it('preserves other fields', () => {
    const members = [makeMember({ name: 'a', color: '#FF0000' })];
    const cleared = clearTeammateColors(members);
    expect(cleared[0]!.name).toBe('a');
    expect(cleared[0]!.agentId).toBe('a@test-team');
  });
});

describe('setMemberActive', () => {
  it('sets isActive for matching member', () => {
    const members = [makeMember({ name: 'a' }), makeMember({ name: 'b' })];
    const updated = setMemberActive(members, 'a@test-team', false);

    expect(updated[0]!.isActive).toBe(false);
    expect(updated[1]!.isActive).toBeUndefined();
  });

  it('does not mutate input', () => {
    const members = [makeMember({ name: 'a' })];
    setMemberActive(members, 'a@test-team', false);
    expect(members[0]!.isActive).toBeUndefined();
  });
});

describe('findMemberById', () => {
  it('finds member by agentId', () => {
    const members = [makeMember({ name: 'a' }), makeMember({ name: 'b' })];
    expect(findMemberById(members, 'b@test-team')?.name).toBe('b');
  });

  it('returns undefined for unknown ID', () => {
    expect(findMemberById([], 'nope')).toBeUndefined();
  });
});

describe('findMemberByName', () => {
  it('finds member by name (case-insensitive)', () => {
    const members = [makeMember({ name: 'worker' })];
    expect(findMemberByName(members, 'Worker')?.agentId).toBe(
      'worker@test-team',
    );
  });

  it('finds member when lookup uses unsanitized human name', () => {
    // Stored names are sanitized (e.g. spawning "QA Tester" stores
    // "qa-tester"). Lookups should match the sanitized form too.
    const members = [makeMember({ name: 'qa-tester' })];
    expect(findMemberByName(members, 'QA Tester')?.agentId).toBe(
      'qa-tester@test-team',
    );
  });

  it('returns undefined for unknown name', () => {
    expect(findMemberByName([], 'nope')).toBeUndefined();
  });
});

describe('classifyShutdownResponse', () => {
  it('classifies a reply that leads with the approve token', () => {
    expect(classifyShutdownResponse('shutdown_approved')).toBe(
      'shutdown_approved',
    );
    // Verbose lead-in form an exact-string match would miss.
    expect(classifyShutdownResponse('shutdown_approved, work finished')).toBe(
      'shutdown_approved',
    );
    expect(classifyShutdownResponse('  shutdown_approved\nbye')).toBe(
      'shutdown_approved',
    );
  });

  it('classifies a reply that leads with the reject token', () => {
    expect(classifyShutdownResponse('shutdown_rejected: still mid-task')).toBe(
      'shutdown_rejected',
    );
  });

  it('does not classify a mid-prose mention of the token', () => {
    // The false-abort bug: a token mentioned mid-report is not a
    // response.
    expect(
      classifyShutdownResponse(
        'I reviewed the shutdown_approved handler and it looks correct.',
      ),
    ).toBeUndefined();
    expect(
      classifyShutdownResponse('I will send shutdown_approved when done.'),
    ).toBeUndefined();
  });

  it('returns undefined for an unrelated message', () => {
    expect(classifyShutdownResponse('task complete')).toBeUndefined();
    expect(classifyShutdownResponse('')).toBeUndefined();
  });
});

// ─── File I/O tests ─────────────────────────────────────────

describe('file I/O', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'team-helpers-test-'));
    (
      Storage as unknown as {
        __setMockGlobalDir: (dir: string) => void;
      }
    ).__setMockGlobalDir(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('path helpers', () => {
    it('getTeamDir returns correct path', () => {
      expect(getTeamDir('my-team')).toBe(path.join(tmpDir, 'teams', 'my-team'));
    });

    it('getTeamFilePath returns correct path', () => {
      expect(getTeamFilePath('my-team')).toBe(
        path.join(tmpDir, 'teams', 'my-team', 'config.json'),
      );
    });

    it('getInboxesDir returns correct path', () => {
      expect(getInboxesDir('my-team')).toBe(
        path.join(tmpDir, 'teams', 'my-team', 'inboxes'),
      );
    });

    it('getTasksDir returns correct path', () => {
      expect(getTasksDir('my-team')).toBe(
        path.join(tmpDir, 'tasks', 'my-team'),
      );
    });
  });

  describe('writeTeamFile + readTeamFile', () => {
    it('round-trips a team file', async () => {
      const teamFile = makeTeamFile({
        name: 'my-team',
        description: 'Test team',
        members: [makeMember({ name: 'worker' })],
      });

      await writeTeamFile('my-team', teamFile);
      const read = await readTeamFile('my-team');

      expect(read).toEqual(teamFile);
    });

    it('creates parent directories', async () => {
      await writeTeamFile('new-team', makeTeamFile());
      const read = await readTeamFile('new-team');
      expect(read).toBeDefined();
    });

    it('readTeamFile returns undefined for missing file', async () => {
      const result = await readTeamFile('nonexistent');
      expect(result).toBeUndefined();
    });
  });

  describe('deleteTeamDirs', () => {
    afterEach(() => {
      setFsRmMock(null);
      vi.restoreAllMocks();
    });

    it('deletes team and task directories', async () => {
      await writeTeamFile('doomed', makeTeamFile());
      const tasksDir = getTasksDir('doomed');
      await fs.mkdir(tasksDir, { recursive: true });
      await fs.writeFile(path.join(tasksDir, 'task-1.json'), '{}');

      await deleteTeamDirs('doomed');

      expect(await readTeamFile('doomed')).toBeUndefined();
      await expect(fs.access(tasksDir)).rejects.toThrow();
    });

    it('does not throw for missing directories', async () => {
      await expect(deleteTeamDirs('nonexistent')).resolves.not.toThrow();
    });

    it('throws AggregateError when both rm calls fail (e.g. EACCES)', async () => {
      const eaccesError = Object.assign(new Error('permission denied'), {
        code: 'EACCES',
      });
      setFsRmMock(() => Promise.reject(eaccesError));

      const err: unknown = await deleteTeamDirs('any-team').then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(AggregateError);
      expect((err as AggregateError).errors).toHaveLength(2);
      // Member errno/path detail must survive in the wrapper message —
      // serializers reading only `.message`/`.stack` never see `.errors`.
      expect((err as AggregateError).message).toContain('permission denied');
    });

    it('throws AggregateError when both rm calls fail (EIO)', async () => {
      const eioError = Object.assign(new Error('I/O error'), { code: 'EIO' });
      setFsRmMock(() => Promise.reject(eioError));

      await expect(deleteTeamDirs('any-team')).rejects.toThrow(AggregateError);
    });

    it('throws the single error when only the second rm call fails', async () => {
      const eaccesError = Object.assign(new Error('permission denied'), {
        code: 'EACCES',
      });
      let callCount = 0;
      setFsRmMock(() => {
        callCount++;
        if (callCount === 1) return Promise.resolve();
        return Promise.reject(eaccesError);
      });

      await expect(deleteTeamDirs('any-team')).rejects.toThrow(
        'permission denied',
      );
    });
  });

  describe('tryReclaimStaleTeam', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    /** PID of a process that has already exited. */
    function deadPid(): number {
      const child = spawnSync(process.execPath, ['-e', '']);
      return child.pid!;
    }

    it('reclaims a team whose lead process is dead', async () => {
      await writeTeamFile('stale', makeTeamFile({ leadPid: deadPid() }));

      await expect(tryReclaimStaleTeam('stale')).resolves.toBe(true);
      expect(await readTeamFile('stale')).toBeUndefined();
    });

    it('reclaims a team owned by this process', async () => {
      // The caller can only be creating a new team because it no
      // longer holds a manager for the old one — its own leftover
      // is stale by definition.
      await writeTeamFile('own', makeTeamFile({ leadPid: process.pid }));

      await expect(tryReclaimStaleTeam('own')).resolves.toBe(true);
      expect(await readTeamFile('own')).toBeUndefined();
    });

    it('does not reclaim a team whose lead process is alive', async () => {
      // The test runner's parent process is alive for the duration.
      await writeTeamFile('live', makeTeamFile({ leadPid: process.ppid }));

      await expect(tryReclaimStaleTeam('live')).resolves.toBe(false);
      expect(await readTeamFile('live')).toBeDefined();
    });

    it('does not reclaim a pre-leadPid team file', async () => {
      await writeTeamFile('legacy', makeTeamFile());

      await expect(tryReclaimStaleTeam('legacy')).resolves.toBe(false);
      expect(await readTeamFile('legacy')).toBeDefined();
    });

    it('cleans up when the team file is already gone', async () => {
      const tasksDir = getTasksDir('ghost');
      await fs.mkdir(tasksDir, { recursive: true });

      await expect(tryReclaimStaleTeam('ghost')).resolves.toBe(true);
      await expect(fs.access(tasksDir)).rejects.toThrow();
    });

    it('does not reclaim when the lead PID is alive but owned by another user', async () => {
      // Pins teamHelpers to the shared isPidAlive: EACCES (Windows'
      // other-user errno, alongside EPERM) means the process exists —
      // the duplicate local copy this replaced treated it as dead and
      // would have reclaimed a live team.
      vi.spyOn(process, 'kill').mockImplementation(() => {
        throw Object.assign(new Error('access denied'), {
          code: 'EACCES',
        });
      });
      await writeTeamFile('other-user', makeTeamFile({ leadPid: 424242 }));

      await expect(tryReclaimStaleTeam('other-user')).resolves.toBe(false);
      expect(await readTeamFile('other-user')).toBeDefined();
    });

    it('aborts when the config content is the JSON literal null', async () => {
      // A config whose entire content is the valid-JSON literal `null`
      // parses without entering the JSON.parse catch, so the shape
      // guard must reject it instead of throwing on
      // `existing.leadPid`. Like any unreadable/corrupt file, it
      // can't prove its owner is gone — leave it for manual recovery.
      await writeTeamFile('nullcfg', makeTeamFile({ leadPid: deadPid() }));
      const tasksDir = getTasksDir('nullcfg');
      await fs.mkdir(tasksDir, { recursive: true });
      await fs.writeFile(path.join(tasksDir, 'marker.json'), '{}');
      await fs.writeFile(getTeamFilePath('nullcfg'), 'null');

      await expect(tryReclaimStaleTeam('nullcfg')).resolves.toBe(false);
      expect(await fs.readFile(getTeamFilePath('nullcfg'), 'utf-8')).toBe(
        'null',
      );
      await expect(fs.access(tasksDir)).resolves.toBeUndefined();
    });

    it('aborts when the config is unparseable at inspection', async () => {
      // Corrupt/torn config: ownership liveness cannot be proven, so
      // the dirs must be left for manual recovery instead of deleted.
      await writeTeamFile('corrupt', makeTeamFile({ leadPid: deadPid() }));
      const tasksDir = getTasksDir('corrupt');
      await fs.mkdir(tasksDir, { recursive: true });
      await fs.writeFile(path.join(tasksDir, 'marker.json'), '{}');
      await fs.writeFile(getTeamFilePath('corrupt'), '{ "name": ');

      await expect(tryReclaimStaleTeam('corrupt')).resolves.toBe(false);
      expect(await fs.readFile(getTeamFilePath('corrupt'), 'utf-8')).toBe(
        '{ "name": ',
      );
      await expect(fs.access(tasksDir)).resolves.toBeUndefined();
    });

    it('aborts when the config vanishes before the delete', async () => {
      // If the config disappears between the staleness inspection and
      // the byte-equality re-read, a by-name delete could hit a
      // generation this reclaim never inspected — abort and leave the
      // dirs intact.
      await writeTeamFile('flaky', makeTeamFile({ leadPid: deadPid() }));
      const tasksDir = getTasksDir('flaky');
      await fs.mkdir(tasksDir, { recursive: true });
      await fs.writeFile(path.join(tasksDir, 'marker.json'), '{}');

      let readCount = 0;
      __setReadFileHook(() => {
        readCount += 1;
        if (readCount === 2) {
          // The re-read before the delete fails with ENOENT.
          return Promise.reject(
            Object.assign(new Error('ENOENT: no such file or directory'), {
              code: 'ENOENT',
            }),
          );
        }
        return undefined;
      });
      try {
        await expect(tryReclaimStaleTeam('flaky')).resolves.toBe(false);
      } finally {
        __setReadFileHook(undefined);
      }
      await expect(fs.access(tasksDir)).resolves.toBeUndefined();
      await expect(
        fs.access(getTeamFilePath('flaky')),
      ).resolves.toBeUndefined();
    });
  });
});
