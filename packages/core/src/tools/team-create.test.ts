/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
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
