/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Storage } from '@qwen-code/qwen-code-core/config/storage.js';
import { SessionService } from '@qwen-code/qwen-code-core/services/sessionService.js';
import {
  SessionConflictError,
  SessionNotFoundError,
} from '../acp-session-bridge.js';
import type { WorkspaceRuntime } from '../workspace-registry.js';
import {
  readPersistedWorkspaceArtifactLibrary,
  readPersistedWorkspaceSessionMetadata,
} from './session-artifact-library.js';
import { WorkspaceArtifactCache } from './workspace-artifact-cache.js';

const id = '550e8400-e29b-41d4-a716-446655440000';
const createdAt = '2026-10-20T00:00:00Z';
let root: string;
let runtime: WorkspaceRuntime;
let chats: string;
let file: string;

function record(uuid: string, fields: Record<string, unknown>) {
  return (
    JSON.stringify({
      uuid,
      parentUuid: null,
      sessionId: id,
      cwd: root,
      timestamp: createdAt,
      version: '0.26.1',
      ...fields,
    }) + '\n'
  );
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-artifact-metadata-'));
  runtime = {
    workspaceCwd: root,
    sessionRuntimeBaseDir: path.join(root, 'runtime'),
    bridge: {
      getSessionSummary: vi.fn(() => {
        throw new SessionNotFoundError(id);
      }),
      listWorkspaceSessions: vi.fn(() => []),
    },
  } as unknown as WorkspaceRuntime;
  const storage = new Storage(root, runtime.sessionRuntimeBaseDir);
  chats = path.join(storage.getProjectDir(), 'chats');
  await fs.mkdir(chats, { recursive: true });
  file = path.join(chats, `${id}.jsonl`);
  await fs.writeFile(
    file,
    record('first-prompt', {
      type: 'user',
      message: { role: 'user', parts: [{ text: 'First prompt' }] },
    }),
  );
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

describe('artifact library session metadata', () => {
  it('reads original creation, prompt fallback and default source from a cold transcript', async () => {
    const result = await readPersistedWorkspaceArtifactLibrary(runtime, id);
    expect(result.session).toEqual({
      displayName: 'First prompt',
      createdAt,
      archiveState: 'active',
      sourceType: 'default',
    });
    expect(result.artifacts).toEqual([]);
  });

  it('retains resource_inspection attribution and refreshes metadata after rename and archive without replaying cache hits', async () => {
    await fs.appendFile(
      file,
      record('source', {
        type: 'system',
        subtype: 'session_source',
        systemPayload: {
          sourceType: 'resource_inspection',
          sourceId: 'resource-123',
        },
      }),
    );
    const metadataRead = vi.spyOn(
      SessionService.prototype,
      'getSessionListItem',
    );
    const snapshotRead = vi.spyOn(
      SessionService.prototype,
      'readSessionArtifactSnapshot',
    );
    const cache = new WorkspaceArtifactCache(runtime);
    const initial = await cache.read(id);
    expect(initial.session).toMatchObject({
      sourceType: 'resource_inspection',
      sourceId: 'resource-123',
      createdAt,
    });
    expect(await cache.read(id)).toBe(initial);
    expect(metadataRead).toHaveBeenCalledOnce();
    expect(snapshotRead).toHaveBeenCalledOnce();

    const service = new SessionService(root, {
      runtimeBaseDir: runtime.sessionRuntimeBaseDir,
    });
    expect(await service.renameSession(id, 'Renamed task')).toBe(true);
    const renamed = await cache.read(id);
    expect(renamed.session).toEqual({
      ...initial.session,
      displayName: 'Renamed task',
    });
    expect(await cache.read(id)).toBe(renamed);
    expect(metadataRead).toHaveBeenCalledTimes(2);

    await fs.mkdir(path.join(chats, 'archive'));
    await fs.rename(file, path.join(chats, 'archive', `${id}.jsonl`));
    const archived = await cache.read(id);
    expect(archived.session).toEqual({
      ...renamed.session,
      archiveState: 'archived',
    });
    expect(await cache.read(id)).toBe(archived);
    expect(metadataRead).toHaveBeenCalledTimes(3);
    expect(metadataRead).toHaveBeenLastCalledWith(id, 'archived');
    expect(snapshotRead).toHaveBeenCalledTimes(3);
  });

  it('includes an unnamed artifact-only journal with its original creation time', async () => {
    await fs.writeFile(
      file,
      record('artifacts', {
        type: 'system',
        subtype: 'session_artifact_snapshot',
        systemPayload: {
          v: 2,
          sessionId: id,
          sequence: 0,
          recordedAt: createdAt,
          artifacts: [],
          tombstonedIds: [],
          stickyEphemeralIds: [],
        },
      }),
    );
    expect(
      (await readPersistedWorkspaceArtifactLibrary(runtime, id)).session,
    ).toEqual({
      createdAt,
      archiveState: 'active',
      sourceType: 'default',
    });
  });

  it('returns absent live persistence without inventing metadata and rejects ambiguous or symlink storage', async () => {
    await fs.unlink(file);
    expect(
      await readPersistedWorkspaceSessionMetadata(runtime, id),
    ).toBeUndefined();
    await fs.writeFile(
      file,
      record('prompt', {
        type: 'user',
        message: { role: 'user', parts: [{ text: 'Prompt' }] },
      }),
    );
    await fs.mkdir(path.join(chats, 'archive'));
    const archived = path.join(chats, 'archive', `${id}.jsonl`);
    await fs.copyFile(file, archived);
    await expect(
      readPersistedWorkspaceSessionMetadata(runtime, id),
    ).rejects.toThrow(SessionConflictError);
    await fs.unlink(file);
    await fs.symlink(path.join(root, 'missing.jsonl'), file);
    await expect(
      readPersistedWorkspaceSessionMetadata(runtime, id),
    ).rejects.toMatchObject({
      reason: 'non_regular',
    });
  });
});
