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
import { deleteTeamDirs } from '../agents/team/teamHelpers.js';

// Mock at the tool boundary so cleanup-failure paths can be injected
// without relying on real-fs permissions (which root bypasses). Keep the
// rest of the module real: disposeInboxLocks (mailbox.ts) resolves
// getInboxesDir through it.
vi.mock('../agents/team/teamHelpers.js', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../agents/team/teamHelpers.js')>();
  return {
    ...original,
    deleteTeamDirs: vi.fn().mockResolvedValue(undefined),
  };
});

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
  vi.mocked(deleteTeamDirs).mockReset();
  vi.mocked(deleteTeamDirs).mockResolvedValue(undefined);
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

  it('resets team state and surfaces failure when directory deletion fails', async () => {
    // Issue #10210's invariant at the tool boundary: a non-benign
    // cleanup failure must NOT be converted into complete success,
    // and it must NOT wedge the session ("team active" forever).
    const eacces = Object.assign(new Error('EACCES: permission denied'), {
      code: 'EACCES',
    });
    vi.mocked(deleteTeamDirs).mockRejectedValue(eacces);

    const config = makeConfig({ hasManager: true });
    const result = await new TeamDeleteTool(config)
      .build({})
      .execute(new AbortController().signal);

    // The state-reset tail still ran...
    expect(config.setTeamManager).toHaveBeenCalledWith(null);
    expect(config.setTeamContext).toHaveBeenCalledWith(null);
    // ...and the result reports failure instead of complete deletion.
    expect(result.error).toBeDefined();
    expect(String(result.llmContent)).toContain('cleanup failed');
    expect(String(result.llmContent)).toContain('EACCES: permission denied');
    expect(String(result.llmContent)).not.toContain('deleted.');
    expect(result.error?.message).toContain('cleanup failed');
    expect(result.error?.message).toContain('EACCES: permission denied');
  });

  it('runs the delayed second sweep even when the first sweep fails', async () => {
    // The second sweep exists to catch the straggler-writeMessage
    // race; a first-sweep throw must not cancel it. A retry that
    // succeeds means the directories are genuinely gone.
    vi.mocked(deleteTeamDirs)
      .mockRejectedValueOnce(
        Object.assign(new Error('ENOTEMPTY: directory not empty'), {
          code: 'ENOTEMPTY',
        }),
      )
      .mockResolvedValueOnce(undefined);

    const config = makeConfig({ hasManager: true });
    const result = await new TeamDeleteTool(config)
      .build({})
      .execute(new AbortController().signal);

    expect(deleteTeamDirs).toHaveBeenCalledTimes(2);
    expect(result.error).toBeUndefined();
    expect(result.llmContent).toContain('deleted');
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
