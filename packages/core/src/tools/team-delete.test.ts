/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { TeamDeleteTool } from './team-delete.js';

vi.mock('../config/storage.js', () => {
  let mockDir = '/tmp/test';
  return {
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

function makeConfig(opts?: { hasManager?: boolean }) {
  const teamManager = opts?.hasManager
    ? {
        getTeamFile: () => ({ name: 'my-team', members: [] }),
        cleanup: vi.fn().mockResolvedValue(undefined),
      }
    : null;

  return {
    getTeamManager: () => teamManager,
    setTeamManager: vi.fn(),
    setTeamContext: vi.fn(),
  } as unknown as import('../config/config.js').Config;
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'team-delete-test-'));
  __setMockGlobalDir(tmpDir);
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('TeamDeleteTool', () => {
  it('has the correct name', () => {
    const tool = new TeamDeleteTool(makeConfig());
    expect(tool.name).toBe('team_delete');
  });

  it('deletes an active team', async () => {
    const config = makeConfig({ hasManager: true });
    const tool = new TeamDeleteTool(config);
    const invocation = tool.build({});
    const result = await invocation.execute(new AbortController().signal);
    expect(result.error).toBeUndefined();
    expect(result.llmContent).toContain('deleted');
    expect(config.setTeamManager).toHaveBeenCalledWith(null);
    expect(config.setTeamContext).toHaveBeenCalledWith(null);
  });

  it('returns error when no team is active', async () => {
    const tool = new TeamDeleteTool(makeConfig());
    const invocation = tool.build({});
    const result = await invocation.execute(new AbortController().signal);
    expect(result.error).toBeDefined();
    expect(result.llmContent).toContain('No active team');
  });

  it('returns TeamResultDisplay', async () => {
    const tool = new TeamDeleteTool(makeConfig({ hasManager: true }));
    const result = await tool.build({}).execute(new AbortController().signal);

    const display = result.returnDisplay as {
      type: string;
      action: string;
    };
    expect(display.type).toBe('team_result');
    expect(display.action).toBe('deleted');
  });

  it('accepts empty params', () => {
    const tool = new TeamDeleteTool(makeConfig());
    expect(() => tool.build({})).not.toThrow();
  });
});
