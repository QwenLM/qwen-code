/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, beforeEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { resolveGitRepositoryLayout } from '../utils/gitUtils.js';
import {
  claimWorktreeOwnership,
  inspectWorktreeOwnership,
  isWorktreeOwnedBySession,
  releaseWorktreeOwnershipForHandoff,
  releaseWorktreeOwnership,
  readWorktreeOwnerState,
} from './worktree-owner-state.js';

vi.mock('node:fs/promises');
vi.mock('../utils/gitUtils.js', () => ({
  resolveGitRepositoryLayout: vi.fn(),
}));

const worktreePath = '/repo/.qwen/worktrees/feature';
const ownerPath = '/repo/.git/worktrees/feature/qwen-worktree.json';

function mockOwnerPath() {
  vi.mocked(resolveGitRepositoryLayout).mockResolvedValue({
    worktreeRoot: worktreePath,
    gitDir: '/repo/.git/worktrees/feature',
    commonDir: '/repo/.git',
    isWorktree: true,
  });
}

describe('worktree owner state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOwnerPath();
    vi.mocked(fs.realpath).mockImplementation(async (input) => String(input));
    vi.mocked(fs.lstat).mockImplementation(async (input) => {
      if (String(input).endsWith('/.git')) {
        return {} as Awaited<ReturnType<typeof fs.lstat>>;
      }
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    });
    vi.mocked(fs.stat).mockResolvedValue({
      isDirectory: () => true,
    } as Awaited<ReturnType<typeof fs.stat>>);
  });

  it('claims a new owner atomically and writes private metadata', async () => {
    const writeFile = vi.fn().mockResolvedValue(undefined);
    const sync = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn().mockResolvedValue(undefined);
    vi.mocked(fs.mkdir).mockResolvedValue(undefined);
    vi.mocked(fs.open).mockResolvedValue({
      writeFile,
      sync,
      close,
    } as never);

    await expect(claimWorktreeOwnership(worktreePath, 'session-a')).resolves.toBe(
      'owned',
    );
    expect(fs.open).toHaveBeenCalledWith(ownerPath, 'wx', 0o600);
    expect(writeFile).toHaveBeenCalledWith(
      expect.stringContaining('"ownerSessionId": "session-a"'),
      'utf8',
    );
    expect(sync).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it('treats pre-existing matching metadata as the same owner', async () => {
    vi.mocked(fs.mkdir).mockResolvedValue(undefined);
    const exists = Object.assign(new Error('exists'), { code: 'EEXIST' });
    vi.mocked(fs.open).mockRejectedValue(exists);
    vi.mocked(fs.readFile).mockResolvedValue(
      '{"version":1,"ownerSessionId":"session-a"}',
    );

    await expect(claimWorktreeOwnership(worktreePath, 'session-a')).resolves.toBe(
      'owned',
    );
  });

  it('never steals metadata owned by another session', async () => {
    vi.mocked(fs.mkdir).mockResolvedValue(undefined);
    const exists = Object.assign(new Error('exists'), { code: 'EEXIST' });
    vi.mocked(fs.open).mockRejectedValue(exists);
    vi.mocked(fs.readFile).mockResolvedValue(
      '{"version":1,"ownerSessionId":"session-b"}',
    );

    await expect(claimWorktreeOwnership(worktreePath, 'session-a')).resolves.toBe(
      'owned-by-another-session',
    );
  });

  it('fails closed for malformed or unreadable metadata', async () => {
    vi.mocked(fs.readFile).mockResolvedValue('{not-json');
    await expect(readWorktreeOwnerState(worktreePath)).resolves.toBeNull();
    await expect(isWorktreeOwnedBySession(worktreePath, 'session-a')).resolves.toBe(
      false,
    );
  });

  it('does not mistake malformed owner metadata for another session', async () => {
    vi.mocked(fs.open).mockRejectedValue(
      Object.assign(new Error('exists'), { code: 'EEXIST' }),
    );
    vi.mocked(fs.readFile).mockResolvedValue('{not-json');
    await expect(
      claimWorktreeOwnership(worktreePath, 'session-a'),
    ).resolves.toBe('unavailable');
    expect(fs.unlink).not.toHaveBeenCalled();
  });

  it('reports an inaccessible hook source without creating ownership metadata', async () => {
    vi.mocked(fs.realpath).mockImplementation(async (input) => {
      if (String(input) === '/missing-source') {
        throw Object.assign(new Error('missing source'), { code: 'ENOENT' });
      }
      return String(input);
    });
    await expect(
      claimWorktreeOwnership(worktreePath, 'session-a', '/missing-source'),
    ).resolves.toBe('unavailable');
    expect(fs.open).not.toHaveBeenCalled();
  });

  it('returns unavailable when the git private path cannot be resolved', async () => {
    vi.mocked(resolveGitRepositoryLayout).mockResolvedValue(null);

    await expect(claimWorktreeOwnership(worktreePath, 'session-a')).resolves.toBe(
      'unavailable',
    );
    await expect(isWorktreeOwnedBySession(worktreePath, 'session-a')).resolves.toBe(
      false,
    );
  });

  it('does not write ownership metadata into a primary checkout', async () => {
    vi.mocked(resolveGitRepositoryLayout).mockResolvedValue({
      worktreeRoot: '/repo',
      gitDir: '/repo/.git',
      commonDir: '/repo/.git',
      isWorktree: false,
    });

    await expect(claimWorktreeOwnership('/repo', 'session-a')).resolves.toBe(
      'unavailable',
    );
    expect(fs.open).not.toHaveBeenCalled();
  });

  it('releases matching ownership without touching another owner', async () => {
    vi.mocked(fs.readFile).mockResolvedValue(
      '{"version":1,"ownerSessionId":"session-a"}',
    );

    await expect(
      releaseWorktreeOwnership(worktreePath, 'session-a'),
    ).resolves.toBe(true);
    expect(fs.unlink).toHaveBeenCalledWith(ownerPath);

    vi.clearAllMocks();
    mockOwnerPath();
    vi.mocked(fs.readFile).mockResolvedValue(
      '{"version":1,"ownerSessionId":"session-b"}',
    );

    await expect(
      releaseWorktreeOwnership(worktreePath, 'session-a'),
    ).resolves.toBe(false);
    expect(fs.unlink).not.toHaveBeenCalled();
  });

  it('treats a missing owner file as an already completed handoff', async () => {
    vi.mocked(fs.readFile).mockRejectedValue(
      Object.assign(new Error('missing'), { code: 'ENOENT' }),
    );

    await expect(
      releaseWorktreeOwnershipForHandoff(worktreePath, 'session-a'),
    ).resolves.toBe('already-released');
    expect(fs.unlink).not.toHaveBeenCalled();
  });

  it('does not report another process owner as a completed handoff', async () => {
    vi.mocked(fs.readFile).mockResolvedValue(
      JSON.stringify({
        version: 1,
        ownerSessionId: 'session-b',
        ownerPid: process.pid,
      }),
    );
    await expect(
      releaseWorktreeOwnershipForHandoff(worktreePath, 'session-a'),
    ).resolves.toBe('owned-by-another-session');
    expect(fs.unlink).not.toHaveBeenCalled();
  });

  it.each([
    [
      'the matching session',
      '{"version":1,"ownerSessionId":"session-a"}',
      'owned-by-session',
    ],
    [
      'a missing owner file',
      Object.assign(new Error('missing'), { code: 'ENOENT' }),
      'not-owned',
    ],
    [
      'another session',
      '{"version":1,"ownerSessionId":"session-b"}',
      'owned-by-another-session',
    ],
  ] as const)(
    'reports %s as a verifiable ownership result',
    async (_description, ownerMetadata, expected) => {
      if (typeof ownerMetadata === 'string') {
        vi.mocked(fs.readFile).mockResolvedValue(ownerMetadata);
      } else {
        vi.mocked(fs.readFile).mockRejectedValue(ownerMetadata);
      }

      await expect(
        inspectWorktreeOwnership(worktreePath, 'session-a'),
      ).resolves.toBe(expected);
    },
  );

  it.each([
    Object.assign(new Error('access denied'), { code: 'EACCES' }),
    Object.assign(new Error('temporary I/O failure'), { code: 'EIO' }),
  ])('does not treat unreadable owner metadata as not-owned', async (error) => {
    vi.mocked(fs.readFile).mockRejectedValue(error);

    await expect(
      inspectWorktreeOwnership(worktreePath, 'session-a'),
    ).resolves.toBe('unavailable');
  });

  it('does not treat an existing non-worktree directory as released', async () => {
    vi.mocked(resolveGitRepositoryLayout).mockResolvedValue(null);

    await expect(
      releaseWorktreeOwnershipForHandoff(worktreePath, 'session-a'),
    ).resolves.toBe('unavailable');
  });

  it.each(['ENOENT', 'ENOTDIR'])(
    'treats a manually deleted previous worktree (%s) as an already completed handoff',
    async (code) => {
      vi.mocked(fs.stat).mockRejectedValue(
        Object.assign(new Error('missing'), { code }),
      );

      await expect(
        releaseWorktreeOwnershipForHandoff(worktreePath, 'session-a'),
      ).resolves.toBe('already-released');
      expect(fs.readFile).not.toHaveBeenCalled();
      expect(fs.unlink).not.toHaveBeenCalled();
    },
  );

  it('fails closed when a handoff cannot read the owner metadata', async () => {
    vi.mocked(fs.readFile).mockRejectedValue(
      Object.assign(new Error('access denied'), { code: 'EACCES' }),
    );

    await expect(
      releaseWorktreeOwnershipForHandoff(worktreePath, 'session-a'),
    ).resolves.toBe('unavailable');
    expect(fs.unlink).not.toHaveBeenCalled();
  });

  it('does not remove an owner record belonging to another session during a handoff', async () => {
    vi.mocked(fs.readFile).mockResolvedValue(
      '{"version":1,"ownerSessionId":"session-b"}',
    );

    await expect(
      releaseWorktreeOwnershipForHandoff(worktreePath, 'session-a'),
    ).resolves.toBe('owned-by-another-session');
    expect(fs.unlink).not.toHaveBeenCalled();
  });

  it('treats an owner file removed during a handoff as already released', async () => {
    vi.mocked(fs.readFile).mockResolvedValue(
      '{"version":1,"ownerSessionId":"session-a"}',
    );
    vi.mocked(fs.unlink).mockRejectedValue(
      Object.assign(new Error('missing'), { code: 'ENOENT' }),
    );

    await expect(
      releaseWorktreeOwnershipForHandoff(worktreePath, 'session-a'),
    ).resolves.toBe('already-released');
  });
});
