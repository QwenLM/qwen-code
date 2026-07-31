/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { TeamCreateTool } from './team-create.js';

vi.mock('../config/storage.js', () => {
  let mockDir = '/tmp/test';
  return {
    QWEN_DIR: '.qwen',
    Storage: {
      getGlobalQwenDir: () => mockDir,
    },
    __setMockGlobalDir: (d: string) => {
      mockDir = d;
    },
  };
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { __setMockGlobalDir } = (await import('../config/storage.js')) as any;

let tmpDir: string;

function makeConfig(overrides?: {
  arenaManager?: unknown;
  teamManager?: unknown;
}) {
  return {
    getArenaManager: () => overrides?.arenaManager ?? null,
    getTeamManager: () => overrides?.teamManager ?? null,
    getSubagentManager: () => null,
    getAgentsSettings: () => ({}),
    getSessionId: () => 'test-session-id',
    setTeamManager: vi.fn(),
    setTeamContext: vi.fn(),
  } as unknown as import('../config/config.js').Config;
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'team-create-test-'));
  __setMockGlobalDir(tmpDir);
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('TeamCreateTool', () => {
  it('has the correct name', () => {
    const tool = new TeamCreateTool(makeConfig());
    expect(tool.name).toBe('team_create');
  });

  it('creates a team and sets manager on config', async () => {
    const config = makeConfig();
    const tool = new TeamCreateTool(config);
    const invocation = tool.build({ team_name: 'my-team' });
    const result = await invocation.execute(new AbortController().signal);

    expect(result.error).toBeUndefined();
    expect(result.llmContent).toContain('my-team');
    expect(result.llmContent).toContain('created');
    expect(config.setTeamManager).toHaveBeenCalled();
    expect(config.setTeamContext).toHaveBeenCalled();
  });

  it('includes description when provided', async () => {
    const tool = new TeamCreateTool(makeConfig());
    const invocation = tool.build({
      team_name: 'dev-team',
      description: 'A dev team',
    });
    const result = await invocation.execute(new AbortController().signal);
    expect(result.error).toBeUndefined();
    expect(result.llmContent).toContain('A dev team');
  });

  it('returns error for empty team name', async () => {
    const tool = new TeamCreateTool(makeConfig());
    const invocation = tool.build({ team_name: '!!!' });
    const result = await invocation.execute(new AbortController().signal);
    expect(result.error).toBeDefined();
    expect(result.llmContent).toContain('required');
  });

  it('returns error when arena is active', async () => {
    const tool = new TeamCreateTool(makeConfig({ arenaManager: {} }));
    const invocation = tool.build({ team_name: 'test' });
    const result = await invocation.execute(new AbortController().signal);
    expect(result.error).toBeDefined();
    expect(result.llmContent).toContain('Arena');
  });

  it('returns error when a team already exists', async () => {
    const tool = new TeamCreateTool(makeConfig({ teamManager: {} }));
    const invocation = tool.build({ team_name: 'test' });
    const result = await invocation.execute(new AbortController().signal);
    expect(result.error).toBeDefined();
    expect(result.llmContent).toContain('already active');
  });

  it('writes team file to disk', async () => {
    const tool = new TeamCreateTool(makeConfig());
    await tool
      .build({ team_name: 'file-team' })
      .execute(new AbortController().signal);

    const teamDir = path.join(tmpDir, 'teams', 'file-team');
    const configFile = path.join(teamDir, 'config.json');
    const raw = await fs.readFile(configFile, 'utf-8');
    const teamFile = JSON.parse(raw);
    expect(teamFile.name).toBe('file-team');
    expect(teamFile.leadAgentId).toContain('leader');
    // Owner identity is what lets a later team_create distinguish a
    // live owner from a stranded leftover.
    expect(teamFile.leadPid).toBe(process.pid);
    expect(teamFile.leadSessionId).toBe('test-session-id');
  });

  it('reclaims a team stranded by a dead session', async () => {
    // Simulate a prior session that exited without team_delete: its
    // team file is on disk and its recorded lead process is gone.
    const child = spawnSync(process.execPath, ['-e', '']);
    const teamDir = path.join(tmpDir, 'teams', 'stranded');
    await fs.mkdir(teamDir, { recursive: true });
    await fs.writeFile(
      path.join(teamDir, 'config.json'),
      JSON.stringify({
        name: 'stranded',
        createdAt: 0,
        leadAgentId: 'leader@stranded',
        leadPid: child.pid,
        members: [],
      }),
      'utf-8',
    );

    const tool = new TeamCreateTool(makeConfig());
    const result = await tool
      .build({ team_name: 'stranded' })
      .execute(new AbortController().signal);

    expect(result.error).toBeUndefined();
    expect(result.llmContent).toContain('created');
  });

  it('refuses a name owned by a live session', async () => {
    const teamDir = path.join(tmpDir, 'teams', 'occupied');
    await fs.mkdir(teamDir, { recursive: true });
    await fs.writeFile(
      path.join(teamDir, 'config.json'),
      JSON.stringify({
        name: 'occupied',
        createdAt: 0,
        leadAgentId: 'leader@occupied',
        // The test runner's parent is alive for the test's duration
        // and is not this process.
        leadPid: process.ppid,
        members: [],
      }),
      'utf-8',
    );

    const tool = new TeamCreateTool(makeConfig());
    const result = await tool
      .build({ team_name: 'occupied' })
      .execute(new AbortController().signal);

    expect(result.error).toBeDefined();
    expect(result.llmContent).toContain('live');
  });

  it('returns TeamResultDisplay', async () => {
    const tool = new TeamCreateTool(makeConfig());
    const result = await tool
      .build({ team_name: 'display-team' })
      .execute(new AbortController().signal);

    const display = result.returnDisplay as {
      type: string;
      action: string;
    };
    expect(display.type).toBe('team_result');
    expect(display.action).toBe('created');
  });

  it('validates required params', () => {
    const tool = new TeamCreateTool(makeConfig());
    expect(() => tool.build({} as never)).toThrow();
  });
});
