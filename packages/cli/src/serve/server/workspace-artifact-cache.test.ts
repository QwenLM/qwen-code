/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Storage } from '@qwen-code/qwen-code-core/config/storage.js';
import { SessionNotFoundError } from '../acp-session-bridge.js';
import type { WorkspaceRuntime } from '../workspace-registry.js';
import { readPersistedWorkspaceArtifactLibrary } from './session-artifact-library.js';
import { WorkspaceArtifactCache } from './workspace-artifact-cache.js';

vi.mock('./session-artifact-library.js', () => ({
  readPersistedWorkspaceArtifactLibrary: vi.fn(),
}));

const id = '550e8400-e29b-41d4-a716-446655440000';
const other = '550e8400-e29b-41d4-a716-446655440001';
let root: string;
let storage: Storage;
let runtime: WorkspaceRuntime;
let cache: WorkspaceArtifactCache;
let chats: string;
let file: string;
const envelope = (sessionId = id) => ({
  v: 1 as const,
  sessionId,
  artifacts: [],
  generatedAt: '2026-10-26T00:00:00Z',
  limits: { maxArtifacts: 200 },
});

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-artifact-cache-'));
  runtime = {
    workspaceCwd: root,
    sessionRuntimeBaseDir: path.join(root, 'runtime'),
    bridge: {
      getSessionSummary: vi.fn(() => {
        throw new SessionNotFoundError(id);
      }),
      getSessionArtifacts: vi.fn(async () => envelope()),
      listWorkspaceSessions: vi.fn(() => []),
    },
  } as unknown as WorkspaceRuntime;
  storage = new Storage(root, runtime.sessionRuntimeBaseDir);
  chats = path.join(storage.getProjectDir(), 'chats');
  await fs.mkdir(chats, { recursive: true });
  file = path.join(chats, `${id}.jsonl`);
  await fs.writeFile(file, 'initial');
  vi.mocked(readPersistedWorkspaceArtifactLibrary)
    .mockReset()
    .mockImplementation(async (_runtime, sessionId) => envelope(sessionId));
  cache = new WorkspaceArtifactCache(runtime);
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

describe('workspace artifact cache', () => {
  it('keeps unchanged empty projections across repeated requests and elapsed time', async () => {
    const initial = await cache.read(id);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 86_400_000);
    expect(await cache.read(id)).toBe(initial);
    expect(readPersistedWorkspaceArtifactLibrary).toHaveBeenCalledOnce();
  });

  it('shares concurrent cold loads', async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    vi.mocked(readPersistedWorkspaceArtifactLibrary).mockImplementation(
      async () => {
        await pending;
        return envelope();
      },
    );
    const requests = [cache.read(id), cache.read(id), cache.read(id)];
    try {
      await vi.waitFor(() =>
        expect(readPersistedWorkspaceArtifactLibrary).toHaveBeenCalledOnce(),
      );
    } finally {
      finish();
    }
    expect(await Promise.all(requests)).toEqual([
      envelope(),
      envelope(),
      envelope(),
    ]);
    expect(readPersistedWorkspaceArtifactLibrary).toHaveBeenCalledOnce();
  });

  it('reloads only the changed session', async () => {
    await fs.writeFile(path.join(chats, `${other}.jsonl`), 'other');
    await Promise.all([cache.read(id), cache.read(other)]);
    await fs.appendFile(file, 'changed');
    await Promise.all([cache.read(id), cache.read(other)]);
    expect(readPersistedWorkspaceArtifactLibrary).toHaveBeenCalledTimes(3);
    const calls = vi.mocked(readPersistedWorkspaceArtifactLibrary).mock.calls;
    expect(calls.filter((call) => call[1] === id)).toHaveLength(2);
    expect(calls.filter((call) => call[1] === other)).toHaveLength(1);
  });

  it('detects replacement files, archive moves and runtime ownership changes', async () => {
    await cache.read(id);
    await fs.writeFile(`${file}.new`, 'initial');
    await fs.rename(`${file}.new`, file);
    await cache.read(id);
    await fs.mkdir(path.join(chats, 'archive'));
    await fs.rename(file, path.join(chats, 'archive', `${id}.jsonl`));
    await cache.read(id);
    await fs.writeFile(storage.getRuntimeStatusPath(id), '{}');
    await cache.read(id);
    expect(readPersistedWorkspaceArtifactLibrary).toHaveBeenCalledTimes(4);
  });

  it('does not cache a projection whose files changed during loading', async () => {
    vi.mocked(readPersistedWorkspaceArtifactLibrary).mockImplementationOnce(
      async () => {
        await fs.appendFile(file, 'changed');
        return envelope();
      },
    );
    await cache.read(id);
    await cache.read(id);
    await cache.read(id);
    expect(readPersistedWorkspaceArtifactLibrary).toHaveBeenCalledTimes(2);
  });

  it('does not restore an invalidated in-flight result into the cache', async () => {
    vi.mocked(readPersistedWorkspaceArtifactLibrary).mockImplementationOnce(
      async () => {
        cache.invalidate(id);
        return envelope();
      },
    );
    await cache.read(id);
    await cache.read(id);
    expect(readPersistedWorkspaceArtifactLibrary).toHaveBeenCalledTimes(2);
  });

  it('always reads live data and rebuilds after unloading', async () => {
    await cache.read(id);
    vi.mocked(runtime.bridge.getSessionSummary).mockReturnValue({
      sessionId: id,
    } as never);
    await cache.read(id);
    await cache.read(id);
    expect(runtime.bridge.getSessionArtifacts).toHaveBeenCalledTimes(2);
    expect(readPersistedWorkspaceArtifactLibrary).toHaveBeenCalledOnce();
    vi.mocked(runtime.bridge.getSessionSummary).mockImplementation(() => {
      throw new SessionNotFoundError(id);
    });
    await cache.read(id);
    expect(readPersistedWorkspaceArtifactLibrary).toHaveBeenCalledTimes(2);
  });

  it('does not retain failed loads or stale success after removal', async () => {
    await cache.read(id);
    await fs.unlink(file);
    vi.mocked(readPersistedWorkspaceArtifactLibrary).mockRejectedValue(
      new SessionNotFoundError(id),
    );
    await expect(cache.read(id)).rejects.toThrow(SessionNotFoundError);
    await expect(cache.read(id)).rejects.toThrow(SessionNotFoundError);
    expect(readPersistedWorkspaceArtifactLibrary).toHaveBeenCalledTimes(3);
  });

  it('isolates runtime generations', async () => {
    await cache.read(id);
    await new WorkspaceArtifactCache({ ...runtime }).read(id);
    expect(readPersistedWorkspaceArtifactLibrary).toHaveBeenCalledTimes(2);
  });

  it('caches discovery, merges live sessions, and refreshes after directory changes', async () => {
    const scan = vi.spyOn(fs, 'readdir');
    expect(await cache.sessionIds()).toEqual([id]);
    expect(await cache.sessionIds()).toEqual([id]);
    expect(scan).toHaveBeenCalledTimes(2);
    vi.mocked(runtime.bridge.listWorkspaceSessions).mockReturnValue([
      { sessionId: other },
    ] as never);
    expect(await cache.sessionIds()).toEqual([id, other]);
    expect(scan).toHaveBeenCalledTimes(2);
    await fs.mkdir(path.join(chats, 'archive'));
    await fs.writeFile(
      path.join(chats, 'archive', `${other}.jsonl`),
      'archived',
    );
    expect(await cache.sessionIds()).toEqual([id, other]);
    expect(scan).toHaveBeenCalledTimes(4);
  });

  it('never joins unsafe session IDs into storage paths', async () => {
    await expect(cache.read('../outside')).rejects.toThrow(
      SessionNotFoundError,
    );
    expect(readPersistedWorkspaceArtifactLibrary).not.toHaveBeenCalled();
  });

  it('preserves cached entries during repeated scans exceeding the memory budget', async () => {
    const large = 'x'.repeat(17 * 1024 * 1024);
    vi.mocked(readPersistedWorkspaceArtifactLibrary).mockImplementation(
      async (_runtime, sessionId) => ({
        ...envelope(sessionId),
        warnings: [large],
      }),
    );
    await fs.writeFile(path.join(chats, `${other}.jsonl`), 'other');
    await cache.read(id);
    await cache.read(other);
    await cache.read(id);
    await cache.read(other);
    await cache.read(id);
    expect(readPersistedWorkspaceArtifactLibrary).toHaveBeenCalledTimes(3);
    const calls = vi.mocked(readPersistedWorkspaceArtifactLibrary).mock.calls;
    expect(calls.filter((call) => call[1] === id)).toHaveLength(1);
    expect(calls.filter((call) => call[1] === other)).toHaveLength(2);
  });

  it('invalidates cached ownership when a symlinked runtime status target changes', async () => {
    const target = path.join(root, 'status.json');
    await fs.writeFile(target, '{}');
    await fs.symlink(target, storage.getRuntimeStatusPath(id));
    await cache.read(id);
    await fs.writeFile(target, '{"workDir":"changed"}');
    await cache.read(id);
    expect(readPersistedWorkspaceArtifactLibrary).toHaveBeenCalledTimes(2);
  });

  it('invalidates archived data when a dangling active transcript symlink appears', async () => {
    await fs.mkdir(path.join(chats, 'archive'));
    await fs.rename(file, path.join(chats, 'archive', `${id}.jsonl`));
    await cache.read(id);
    await fs.symlink(path.join(root, 'missing.jsonl'), file);
    vi.mocked(readPersistedWorkspaceArtifactLibrary).mockRejectedValue(
      new Error('Session entry is not a regular file'),
    );
    await expect(cache.read(id)).rejects.toThrow(
      'Session entry is not a regular file',
    );
    expect(readPersistedWorkspaceArtifactLibrary).toHaveBeenCalledTimes(2);
  });
});
