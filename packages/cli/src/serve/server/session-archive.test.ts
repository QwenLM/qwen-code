/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SessionService,
  Storage,
  readCronTasks,
  updateCronTasks,
} from '@qwen-code/qwen-code-core';
import {
  SessionArchivedError,
  SessionArchivingError,
  SessionConflictError,
  SessionNotArchivedError,
  SessionNotFoundError,
} from '../acp-session-bridge.js';
import {
  archiveDaemonSessions,
  assertSessionArchived,
  assertSessionLoadable,
  deleteDaemonSessions,
  SessionArchiveCoordinator,
  unarchiveDaemonSessions,
} from './session-archive.js';

describe('assertSessionLoadable', () => {
  let runtimeDir: string;
  let workspaceDir: string;

  beforeEach(() => {
    runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-archive-test-'));
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-workspace-'));
    Storage.setRuntimeBaseDir(runtimeDir);
  });

  afterEach(() => {
    Storage.setRuntimeBaseDir(null);
    fs.rmSync(runtimeDir, { recursive: true, force: true });
    fs.rmSync(workspaceDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('rejects archived sessions using project-aware JSONL heads', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440000';
    writeSessionFile(workspaceDir, sessionId, 'archived');
    const getLocationSpy = vi.spyOn(
      SessionService.prototype,
      'getSessionLocation',
    );

    await expect(
      assertSessionLoadable(workspaceDir, sessionId),
    ).rejects.toThrow(SessionArchivedError);
    expect(getLocationSpy).toHaveBeenCalledWith(sessionId);
  });

  it('rejects active/archive conflicts using project-aware JSONL heads', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440001';
    writeSessionFile(workspaceDir, sessionId, 'active');
    writeSessionFile(workspaceDir, sessionId, 'archived');
    const getLocationSpy = vi.spyOn(
      SessionService.prototype,
      'getSessionLocation',
    );

    await expect(
      assertSessionLoadable(workspaceDir, sessionId),
    ).rejects.toThrow(SessionConflictError);
    expect(getLocationSpy).toHaveBeenCalledWith(sessionId);
  });

  it('ignores archived files that do not belong to this project', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440010';
    const otherWorkspace = fs.mkdtempSync(
      path.join(os.tmpdir(), 'qwen-other-workspace-'),
    );
    try {
      writeSessionFile(workspaceDir, sessionId, 'archived', otherWorkspace);

      await expect(
        assertSessionLoadable(workspaceDir, sessionId),
      ).resolves.toBeUndefined();
    } finally {
      fs.rmSync(otherWorkspace, { recursive: true, force: true });
    }
  });
});

describe('assertSessionArchived', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ['active', 'active', SessionNotArchivedError],
    ['conflicting', 'conflict', SessionConflictError],
    ['missing', undefined, SessionNotFoundError],
  ] as const)('rejects %s sessions', async (_name, location, ErrorType) => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440070';
    vi.spyOn(SessionService.prototype, 'getSessionLocation').mockResolvedValue(
      location,
    );

    await expect(
      assertSessionArchived('/workspace', sessionId),
    ).rejects.toThrow(ErrorType);
  });

  it('accepts archived sessions', async () => {
    vi.spyOn(SessionService.prototype, 'getSessionLocation').mockResolvedValue(
      'archived',
    );

    await expect(
      assertSessionArchived(
        '/workspace',
        '550e8400-e29b-41d4-a716-446655440071',
      ),
    ).resolves.toBeUndefined();
  });
});

describe('SessionArchiveCoordinator', () => {
  it('rejects shared access while an exclusive lock is held', async () => {
    const coordinator = new SessionArchiveCoordinator();
    const sessionId = '550e8400-e29b-41d4-a716-446655440020';

    await coordinator.runExclusiveMany([sessionId], async () => {
      await expect(
        coordinator.runSharedMany([sessionId], async () => 'shared'),
      ).rejects.toThrow(SessionArchivingError);
    });
  });

  it('allows concurrent shared access and reference-counts release', async () => {
    const coordinator = new SessionArchiveCoordinator();
    const sessionId = '550e8400-e29b-41d4-a716-446655440021';
    let releaseFirst!: () => void;
    const firstReleased = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = coordinator.runSharedMany([sessionId], async () => {
      await firstReleased;
      return 'first';
    });

    await expect(
      coordinator.runSharedMany([sessionId], async () => 'second'),
    ).resolves.toBe('second');
    await expect(
      coordinator.runExclusiveMany([sessionId], async () => 'exclusive'),
    ).rejects.toThrow(SessionArchivingError);
    releaseFirst();
    await expect(first).resolves.toBe('first');
    await expect(
      coordinator.runExclusiveMany([sessionId], async () => 'exclusive'),
    ).resolves.toBe('exclusive');
  });

  it('assertNotTransitioning throws during exclusive access', async () => {
    const coordinator = new SessionArchiveCoordinator();
    const sessionId = '550e8400-e29b-41d4-a716-446655440022';

    await coordinator.runExclusiveMany([sessionId], async () => {
      expect(() => coordinator.assertNotTransitioning(sessionId)).toThrow(
        SessionArchivingError,
      );
    });
  });

  it('releases exclusive locks when the callback throws', async () => {
    const coordinator = new SessionArchiveCoordinator();
    const sessionId = '550e8400-e29b-41d4-a716-446655440023';

    await expect(
      coordinator.runExclusiveMany([sessionId], async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await expect(
      coordinator.runExclusiveMany([sessionId], async () => 'ok'),
    ).resolves.toBe('ok');
  });
});

describe('archiveDaemonSessions', () => {
  let runtimeDir: string;
  let workspaceDir: string;

  beforeEach(() => {
    runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-archive-test-'));
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-workspace-'));
    Storage.setRuntimeBaseDir(runtimeDir);
  });

  afterEach(() => {
    Storage.setRuntimeBaseDir(null);
    fs.rmSync(runtimeDir, { recursive: true, force: true });
    fs.rmSync(workspaceDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('deduplicates ids and archives one active session', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440002';
    writeSessionFile(workspaceDir, sessionId, 'active');
    const service = new SessionService(workspaceDir);
    const closeSession = vi.fn().mockResolvedValue(undefined);

    const result = await archiveDaemonSessions({
      sessionIds: [sessionId, sessionId],
      service,
      bridge: { closeSession },
      coordinator: new SessionArchiveCoordinator(),
    });

    expect(result).toEqual({
      archived: [sessionId],
      alreadyArchived: [],
      notFound: [],
      errors: [],
    });
    expect(closeSession).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(sessionPath(workspaceDir, sessionId, 'active'))).toBe(
      false,
    );
    expect(
      fs.existsSync(sessionPath(workspaceDir, sessionId, 'archived')),
    ).toBe(true);
  });

  it('disables a scheduled task bound to the archived session', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440050';
    writeSessionFile(workspaceDir, sessionId, 'active');
    await updateCronTasks(workspaceDir, () => [
      {
        id: 'bound',
        cron: '0 9 * * *',
        prompt: 'p',
        recurring: true,
        createdAt: 1_700_000_000_000,
        lastFiredAt: null,
        sessionId,
      },
      {
        id: 'other',
        cron: '0 9 * * *',
        prompt: 'p',
        recurring: true,
        createdAt: 1_700_000_000_000,
        lastFiredAt: null,
      },
    ]);

    const result = await archiveDaemonSessions({
      sessionIds: [sessionId],
      service: new SessionService(workspaceDir),
      bridge: { closeSession: vi.fn().mockResolvedValue(undefined) },
      coordinator: new SessionArchiveCoordinator(),
    });
    expect(result.archived).toEqual([sessionId]);

    const byId = Object.fromEntries(
      (await readCronTasks(workspaceDir)).map((t) => [t.id, t]),
    );
    expect(byId['bound']!.enabled).toBe(false); // paused with its session
    expect(byId['other']!.enabled).toBeUndefined(); // unrelated — untouched
  });

  it('does not lock ids that are already archived or missing', async () => {
    const archivedId = '550e8400-e29b-41d4-a716-446655440003';
    const missingId = '550e8400-e29b-41d4-a716-446655440004';
    writeSessionFile(workspaceDir, archivedId, 'archived');
    const service = new SessionService(workspaceDir);
    const closeSession = vi.fn().mockResolvedValue(undefined);
    const coordinator = new SessionArchiveCoordinator();

    await coordinator.runSharedMany([archivedId, missingId], async () => {
      const result = await archiveDaemonSessions({
        sessionIds: [archivedId, missingId],
        service,
        bridge: { closeSession },
        coordinator,
      });

      expect(result).toEqual({
        archived: [],
        alreadyArchived: [archivedId],
        notFound: [missingId],
        errors: [],
      });
    });
    expect(closeSession).not.toHaveBeenCalled();
  });
});

describe('unarchiveDaemonSessions', () => {
  let runtimeDir: string;
  let workspaceDir: string;

  beforeEach(() => {
    runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-archive-test-'));
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-workspace-'));
    Storage.setRuntimeBaseDir(runtimeDir);
  });

  afterEach(() => {
    Storage.setRuntimeBaseDir(null);
    fs.rmSync(runtimeDir, { recursive: true, force: true });
    fs.rmSync(workspaceDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('deduplicates ids and does not lock already active or missing ids', async () => {
    const archivedId = '550e8400-e29b-41d4-a716-446655440011';
    const activeId = '550e8400-e29b-41d4-a716-446655440012';
    const missingId = '550e8400-e29b-41d4-a716-446655440013';
    writeSessionFile(workspaceDir, archivedId, 'archived');
    writeSessionFile(workspaceDir, activeId, 'active');
    const service = new SessionService(workspaceDir);
    const coordinator = new SessionArchiveCoordinator();

    await coordinator.runSharedMany([activeId, missingId], async () => {
      const result = await unarchiveDaemonSessions({
        sessionIds: [archivedId, activeId, missingId, archivedId],
        service,
        coordinator,
      });

      expect(result).toEqual({
        unarchived: [archivedId],
        alreadyActive: [activeId],
        notFound: [missingId],
        errors: [],
      });
    });
    expect(fs.existsSync(sessionPath(workspaceDir, archivedId, 'active'))).toBe(
      true,
    );
    expect(
      fs.existsSync(sessionPath(workspaceDir, archivedId, 'archived')),
    ).toBe(false);
  });

  it('reports a single error per archived id when unarchive batch fails', async () => {
    const archivedId = '550e8400-e29b-41d4-a716-446655440014';
    writeSessionFile(workspaceDir, archivedId, 'archived');
    const service = new SessionService(workspaceDir);
    const failure = new Error('unarchive failed');
    vi.spyOn(service, 'unarchiveSessions').mockRejectedValue(failure);

    const result = await unarchiveDaemonSessions({
      sessionIds: [archivedId, archivedId],
      service,
      coordinator: new SessionArchiveCoordinator(),
    });

    expect(result).toEqual({
      unarchived: [],
      alreadyActive: [],
      notFound: [],
      errors: [{ sessionId: archivedId, error: failure }],
    });
  });

  it('re-enables an archive-disabled task bound to the unarchived session', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440060';
    writeSessionFile(workspaceDir, sessionId, 'archived');
    await updateCronTasks(workspaceDir, () => [
      {
        id: 'bound',
        cron: '0 9 * * *',
        prompt: 'p',
        recurring: true,
        createdAt: 1_700_000_000_000,
        lastFiredAt: 1000,
        sessionId,
        enabled: false,
        disabledByArchive: true, // paused when the session was archived
      },
    ]);

    const result = await unarchiveDaemonSessions({
      sessionIds: [sessionId],
      service: new SessionService(workspaceDir),
      coordinator: new SessionArchiveCoordinator(),
    });
    expect(result.unarchived).toEqual([sessionId]);

    const bound = (await readCronTasks(workspaceDir)).find(
      (t) => t.id === 'bound',
    );
    expect(bound!.enabled).toBe(true); // resumed with its session
    expect(bound!.disabledByArchive).toBeUndefined(); // flag cleared
  });

  it('recovers a stranded task on an ALREADY-active session', async () => {
    // A task left `{enabled:false, disabledByArchive:true}` by a prior FAILED
    // enable, whose session is already active, is otherwise unrecoverable
    // (PATCH-enable 409s, keepalive skips it). Re-unarchiving the active session
    // must reconcile it, since enableTasksForSessions also runs for alreadyActive.
    const sessionId = '550e8400-e29b-41d4-a716-446655440062';
    writeSessionFile(workspaceDir, sessionId, 'active'); // NOT archived
    await updateCronTasks(workspaceDir, () => [
      {
        id: 'stranded',
        cron: '0 9 * * *',
        prompt: 'p',
        recurring: true,
        createdAt: 1_700_000_000_000,
        lastFiredAt: 1000,
        sessionId,
        enabled: false,
        disabledByArchive: true,
      },
    ]);

    const result = await unarchiveDaemonSessions({
      sessionIds: [sessionId],
      service: new SessionService(workspaceDir),
      coordinator: new SessionArchiveCoordinator(),
    });
    expect(result.alreadyActive).toEqual([sessionId]); // was already active

    const stranded = (await readCronTasks(workspaceDir)).find(
      (t) => t.id === 'stranded',
    );
    expect(stranded!.enabled).toBe(true); // recovered
    expect(stranded!.disabledByArchive).toBeUndefined();
  });
});

describe('deleteDaemonSessions', () => {
  let runtimeDir: string;
  let workspaceDir: string;

  beforeEach(() => {
    runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-archive-test-'));
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-workspace-'));
    Storage.setRuntimeBaseDir(runtimeDir);
  });

  afterEach(() => {
    Storage.setRuntimeBaseDir(null);
    fs.rmSync(runtimeDir, { recursive: true, force: true });
    fs.rmSync(workspaceDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('removes a scheduled task bound to the deleted session', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440070';
    writeSessionFile(workspaceDir, sessionId, 'active');
    await updateCronTasks(workspaceDir, () => [
      {
        id: 'bound',
        cron: '0 9 * * *',
        prompt: 'p',
        recurring: true,
        createdAt: 1_700_000_000_000,
        lastFiredAt: null,
        sessionId,
      },
      {
        id: 'other',
        cron: '0 9 * * *',
        prompt: 'p',
        recurring: true,
        createdAt: 1_700_000_000_000,
        lastFiredAt: null,
      },
    ]);

    const result = await deleteDaemonSessions({
      sessionIds: [sessionId],
      service: new SessionService(workspaceDir),
      bridge: { closeSession: vi.fn().mockResolvedValue(undefined) },
      coordinator: new SessionArchiveCoordinator(),
    });
    expect(result.removed).toEqual([sessionId]);

    const ids = (await readCronTasks(workspaceDir)).map((t) => t.id).sort();
    expect(ids).toEqual(['other']); // bound task deleted, unbound survives
  });
});

function writeSessionFile(
  workspaceDir: string,
  sessionId: string,
  state: 'active' | 'archived',
  recordCwd = workspaceDir,
): void {
  const chatsDir = path.join(
    new Storage(workspaceDir).getProjectDir(),
    'chats',
  );
  const targetDir =
    state === 'archived' ? path.join(chatsDir, 'archive') : chatsDir;
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(
    path.join(targetDir, `${sessionId}.jsonl`),
    `${JSON.stringify({
      uuid: 'record-1',
      parentUuid: null,
      sessionId,
      timestamp: '2024-01-01T00:00:00.000Z',
      type: 'user',
      message: { role: 'user', parts: [{ text: 'hello' }] },
      cwd: recordCwd,
      version: '1.0.0',
    })}\n`,
  );
}

function sessionPath(
  workspaceDir: string,
  sessionId: string,
  state: 'active' | 'archived',
): string {
  const chatsDir = path.join(
    new Storage(workspaceDir).getProjectDir(),
    'chats',
  );
  return path.join(
    state === 'archived' ? path.join(chatsDir, 'archive') : chatsDir,
    `${sessionId}.jsonl`,
  );
}
