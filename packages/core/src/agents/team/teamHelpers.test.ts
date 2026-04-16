/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
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
  readTeamFile,
  writeTeamFile,
  deleteTeamDirs,
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

  it('returns undefined for unknown name', () => {
    expect(findMemberByName([], 'nope')).toBeUndefined();
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
  });
});
