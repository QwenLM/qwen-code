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
import type { SessionListItem } from '@qwen-code/qwen-code-core/services/sessionService.js';
import {
  SessionNotFoundError,
  type BridgeSessionSummary,
} from '../acp-session-bridge.js';
import type { WorkspaceRuntime } from '../workspace-registry.js';
import {
  readPersistedWorkspaceArtifactLibrary,
  readPersistedWorkspaceSessionMetadata,
} from './session-artifact-library.js';
import { WorkspaceArtifactCache } from './workspace-artifact-cache.js';

vi.mock('./session-artifact-library.js', () => ({
  readPersistedWorkspaceArtifactLibrary: vi.fn(),
  readPersistedWorkspaceSessionMetadata: vi.fn(),
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
  session: {
    createdAt: '2026-10-20T00:00:00Z',
    archiveState: 'active' as const,
    sourceType: 'default',
  },
});

function liveSummary(
  overrides: Partial<BridgeSessionSummary> = {},
): BridgeSessionSummary {
  return {
    sessionId: id,
    workspaceCwd: root,
    createdAt: '2026-10-26T00:00:00Z',
    displayName: 'Live title',
    clientCount: 0,
    hasActivePrompt: false,
    ...overrides,
  };
}

function metadata(overrides: Partial<SessionListItem> = {}): SessionListItem {
  return {
    sessionId: id,
    cwd: root,
    startTime: '2026-10-20T00:00:00Z',
    mtime: 0,
    prompt: 'First prompt',
    customTitle: 'Persisted title',
    filePath: file,
    ...overrides,
  };
}

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
  vi.mocked(readPersistedWorkspaceSessionMetadata)
    .mockReset()
    .mockResolvedValue(metadata());
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
    vi.mocked(runtime.bridge.getSessionSummary).mockReturnValue(liveSummary());
    await cache.read(id);
    await cache.read(id);
    expect(runtime.bridge.getSessionArtifacts).toHaveBeenCalledTimes(2);
    expect(readPersistedWorkspaceArtifactLibrary).toHaveBeenCalledOnce();
    expect(readPersistedWorkspaceSessionMetadata).toHaveBeenCalledOnce();
    vi.mocked(runtime.bridge.getSessionSummary).mockImplementation(() => {
      throw new SessionNotFoundError(id);
    });
    await cache.read(id);
    expect(readPersistedWorkspaceArtifactLibrary).toHaveBeenCalledTimes(2);
    vi.mocked(runtime.bridge.getSessionSummary).mockReturnValue(liveSummary());
    await cache.read(id);
    expect(readPersistedWorkspaceSessionMetadata).toHaveBeenCalledTimes(2);
  });

  it('caches persisted live identity while reading live titles and artifacts every time', async () => {
    vi.mocked(runtime.bridge.getSessionSummary).mockReturnValue(
      liveSummary({
        sourceType: 'live_source',
        sourceId: 'live-id',
      }),
    );
    vi.mocked(readPersistedWorkspaceSessionMetadata).mockResolvedValue(
      metadata({
        sourceType: 'resource_inspection',
        sourceId: 'resource-123',
      }),
    );
    const initial = await cache.read(id);
    expect(initial.session).toEqual({
      displayName: 'Live title',
      createdAt: '2026-10-20T00:00:00Z',
      archiveState: 'active',
      sourceType: 'resource_inspection',
      sourceId: 'resource-123',
    });
    vi.mocked(runtime.bridge.getSessionSummary).mockReturnValue(
      liveSummary({
        displayName: 'Renamed before transcript persistence',
      }),
    );
    vi.mocked(runtime.bridge.getSessionArtifacts).mockResolvedValue({
      ...envelope(),
      generatedAt: '2026-10-26T01:00:00Z',
    });
    const renamed = await cache.read(id);
    expect(renamed.session).toEqual({
      ...initial.session,
      displayName: 'Renamed before transcript persistence',
    });
    expect(renamed.generatedAt).toBe('2026-10-26T01:00:00Z');
    expect(readPersistedWorkspaceSessionMetadata).toHaveBeenCalledOnce();
    expect(runtime.bridge.getSessionSummary).toHaveBeenCalledTimes(2);
    expect(runtime.bridge.getSessionArtifacts).toHaveBeenCalledTimes(2);
    expect(readPersistedWorkspaceArtifactLibrary).not.toHaveBeenCalled();
  });

  it('keeps creator type and ID paired and falls back to live creator only when persisted attribution is absent', async () => {
    vi.mocked(runtime.bridge.getSessionSummary).mockReturnValue(
      liveSummary({
        displayName: undefined,
        sourceType: 'qwen-live',
        sourceId: 'live-id',
      }),
    );
    vi.mocked(readPersistedWorkspaceSessionMetadata).mockResolvedValue(
      metadata({
        sourceType: 'resource_inspection',
      }),
    );
    expect((await cache.read(id)).session).toEqual({
      displayName: 'Persisted title',
      createdAt: '2026-10-20T00:00:00Z',
      archiveState: 'active',
      sourceType: 'resource_inspection',
    });
    await fs.appendFile(file, 'metadata change');
    vi.mocked(readPersistedWorkspaceSessionMetadata).mockResolvedValue(
      metadata(),
    );
    expect((await cache.read(id)).session).toMatchObject({
      sourceType: 'qwen-live',
      sourceId: 'live-id',
    });
  });

  it('caches absent persisted metadata across discovery and falls back to a new live session', async () => {
    await fs.unlink(file);
    vi.mocked(runtime.bridge.getSessionSummary).mockReturnValue(
      liveSummary({
        displayName: undefined,
      }),
    );
    vi.mocked(runtime.bridge.listWorkspaceSessions).mockReturnValue([
      liveSummary(),
    ]);
    vi.mocked(readPersistedWorkspaceSessionMetadata).mockResolvedValue(
      undefined,
    );
    for (let count = 0; count < 2; count++) {
      expect(await cache.sessionIds()).toEqual([id]);
      expect((await cache.read(id)).session).toEqual({
        createdAt: '2026-10-26T00:00:00Z',
        archiveState: 'active',
        sourceType: 'default',
      });
    }
    expect(readPersistedWorkspaceSessionMetadata).toHaveBeenCalledOnce();
    await fs.writeFile(file, 'first persisted record');
    vi.mocked(readPersistedWorkspaceSessionMetadata).mockResolvedValue(
      metadata(),
    );
    expect((await cache.read(id)).session.createdAt).toBe(
      '2026-10-20T00:00:00Z',
    );
    expect(readPersistedWorkspaceSessionMetadata).toHaveBeenCalledTimes(2);
  });

  it('shares concurrent live metadata loads without sharing live artifact responses', async () => {
    vi.mocked(runtime.bridge.getSessionSummary).mockReturnValue(liveSummary());
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    vi.mocked(readPersistedWorkspaceSessionMetadata).mockImplementation(
      async () => {
        await pending;
        return metadata();
      },
    );
    const requests = [cache.read(id), cache.read(id), cache.read(id)];
    try {
      await vi.waitFor(() =>
        expect(readPersistedWorkspaceSessionMetadata).toHaveBeenCalledOnce(),
      );
    } finally {
      finish();
    }
    const results = await Promise.all(requests);
    expect(
      results.every(
        (result) => result.session.createdAt === metadata().startTime,
      ),
    ).toBe(true);
    expect(runtime.bridge.getSessionArtifacts).toHaveBeenCalledTimes(3);
    expect(readPersistedWorkspaceSessionMetadata).toHaveBeenCalledOnce();
  });

  it('does not retain live metadata changed while loading or failed reads', async () => {
    vi.mocked(runtime.bridge.getSessionSummary).mockReturnValue(liveSummary());
    vi.mocked(readPersistedWorkspaceSessionMetadata)
      .mockImplementationOnce(async () => {
        await fs.appendFile(file, 'changed during read');
        return metadata();
      })
      .mockRejectedValueOnce(new Error('metadata unavailable'));
    await cache.read(id);
    await expect(cache.read(id)).rejects.toThrow('metadata unavailable');
    await cache.read(id);
    await cache.read(id);
    expect(readPersistedWorkspaceSessionMetadata).toHaveBeenCalledTimes(3);
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

  it('refreshes discovery with unchanged directory fingerprints without replaying cached artifacts', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const archive = path.join(chats, 'archive');
    await fs.mkdir(archive);
    const identities = new Map([
      [chats, await fs.lstat(chats)],
      [archive, await fs.lstat(archive)],
    ]);
    const lstat = fs.lstat.bind(fs);
    vi.spyOn(fs, 'lstat').mockImplementation(
      async (entry) =>
        (identities.get(String(entry)) ?? (await lstat(entry))) as never,
    );
    const scan = vi.spyOn(fs, 'readdir');
    expect(await cache.sessionIds()).toEqual([id]);
    const initial = await cache.read(id);
    await fs.writeFile(path.join(archive, `${other}.jsonl`), 'archived');
    vi.setSystemTime(Date.now() + 1_999);
    expect(await cache.sessionIds()).toEqual([id]);
    expect(scan).toHaveBeenCalledTimes(2);
    vi.setSystemTime(Date.now() + 1);
    expect(await cache.sessionIds()).toEqual([id, other]);
    expect(scan).toHaveBeenCalledTimes(4);
    expect(await cache.read(id)).toBe(initial);
    expect(readPersistedWorkspaceArtifactLibrary).toHaveBeenCalledOnce();
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

  it('shares the byte budget between live metadata and cold envelopes and releases invalidated bytes', async () => {
    const large = 'x'.repeat(17 * 1024 * 1024);
    vi.mocked(runtime.bridge.getSessionSummary).mockImplementation(
      (sessionId) => {
        if (sessionId !== id) throw new SessionNotFoundError(sessionId);
        return liveSummary();
      },
    );
    vi.mocked(readPersistedWorkspaceSessionMetadata).mockResolvedValue(
      metadata({
        customTitle: large,
      }),
    );
    vi.mocked(readPersistedWorkspaceArtifactLibrary).mockResolvedValue({
      ...envelope(other),
      warnings: [large],
    });
    await fs.writeFile(path.join(chats, `${other}.jsonl`), 'other');
    await cache.read(id);
    await cache.read(other);
    await cache.read(id);
    await cache.read(other);
    expect(readPersistedWorkspaceSessionMetadata).toHaveBeenCalledOnce();
    expect(readPersistedWorkspaceArtifactLibrary).toHaveBeenCalledTimes(2);
    cache.invalidate(id);
    await cache.read(other);
    await cache.read(other);
    expect(readPersistedWorkspaceArtifactLibrary).toHaveBeenCalledTimes(3);
    await cache.read(id);
    await cache.read(id);
    expect(readPersistedWorkspaceSessionMetadata).toHaveBeenCalledTimes(3);
  });

  it('does not join non-file live session IDs into storage paths', async () => {
    vi.mocked(runtime.bridge.getSessionSummary).mockReturnValue(
      liveSummary({
        sessionId: '../outside',
      }),
    );
    const stat = vi.spyOn(fs, 'lstat');
    expect((await cache.read('../outside')).session.createdAt).toBe(
      liveSummary().createdAt,
    );
    expect(stat).not.toHaveBeenCalled();
    expect(readPersistedWorkspaceSessionMetadata).not.toHaveBeenCalled();
    expect(readPersistedWorkspaceArtifactLibrary).not.toHaveBeenCalled();
    expect(runtime.bridge.getSessionArtifacts).toHaveBeenCalledWith(
      '../outside',
    );
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
