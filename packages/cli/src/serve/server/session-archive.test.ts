/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SessionIdCaseConflictError,
  SessionService,
  SessionStorageEntryError,
  SessionWriterConflictError,
  SessionWriterLostError,
  type SessionWriterLease,
  Storage,
  getCronFilePath,
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
  assertSessionRestorable,
  deleteDaemonSessionIfOrphan,
  deleteDaemonSessions,
  resolveSessionIdForRestore,
  SessionArchiveCoordinator,
  unarchiveDaemonSessions,
  DaemonDrainingError,
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

  it('reads the active copy after restore selected an exact conflict', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440001';
    writeSessionFile(workspaceDir, sessionId, 'active');
    writeSessionFile(workspaceDir, sessionId, 'archived');

    await expect(
      assertSessionLoadable(workspaceDir, sessionId, undefined, {
        allowActiveConflict: true,
      }),
    ).resolves.toBe('active');
  });

  it('does not read a differently spelled active/archive conflict', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440001';
    const storageSessionId = sessionId.toUpperCase();
    vi.spyOn(SessionService.prototype, 'getSessionLocation').mockResolvedValue(
      'conflict',
    );
    vi.spyOn(
      SessionService.prototype,
      'findSessionIdIgnoringCase',
    ).mockRejectedValue(
      new SessionIdCaseConflictError(sessionId, storageSessionId),
    );

    await expect(
      assertSessionLoadable(workspaceDir, sessionId, undefined, {
        allowActiveConflict: true,
      }),
    ).rejects.toThrow(SessionConflictError);
  });

  it('resolves an exact active/archive conflict only for restore', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440001';
    writeSessionFile(workspaceDir, sessionId, 'active');
    writeSessionFile(workspaceDir, sessionId, 'archived');
    const service = new SessionService(workspaceDir);

    await expect(resolveSessionIdForRestore(service, sessionId)).resolves.toBe(
      sessionId,
    );
    await expect(
      assertSessionRestorable(workspaceDir, sessionId, sessionId),
    ).resolves.toBe('active');
  });

  it('does not restore a differently spelled active/archive conflict', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440001';
    const storageSessionId = sessionId.toUpperCase();
    vi.spyOn(SessionService.prototype, 'getSessionLocation').mockResolvedValue(
      'conflict',
    );

    await expect(
      assertSessionRestorable(workspaceDir, storageSessionId, sessionId),
    ).rejects.toThrow(SessionConflictError);
  });

  it('maps a differently spelled active/archive conflict without another read', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440001';
    const candidateSessionId = sessionId.toUpperCase();
    const service = new SessionService(workspaceDir);
    const conflict = new SessionIdCaseConflictError(
      sessionId,
      candidateSessionId,
    );
    vi.spyOn(service, 'findSessionIdIgnoringCase').mockRejectedValue(conflict);
    const getLocation = vi
      .spyOn(service, 'getSessionLocation')
      .mockRejectedValue(
        Object.assign(new Error('catalog failed'), { code: 'EIO' }),
      );

    await expect(
      resolveSessionIdForRestore(service, sessionId),
    ).rejects.toThrow(SessionConflictError);
    expect(getLocation).not.toHaveBeenCalled();
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

  it('collapses case-variant spellings of a caller session id to one lock key', async () => {
    const coordinator = new SessionArchiveCoordinator();
    const sessionId = '550e8400-e29b-41d4-a716-446655440024';
    const upper = sessionId.toUpperCase();

    // Batch delete/archive/unarchive lock raw caller spellings while
    // restore locks the request spelling; on a case-insensitive filesystem
    // both reach the same transcript, so the two spellings must contend.
    await coordinator.runSharedMany([sessionId], async () => {
      await expect(
        coordinator.runExclusiveMany([upper], async () => 'exclusive'),
      ).rejects.toThrow(SessionArchivingError);
    });

    await coordinator.runExclusiveMany([sessionId], async () => {
      await expect(
        coordinator.runSharedMany([upper], async () => 'shared'),
      ).rejects.toThrow(SessionArchivingError);
      expect(() => coordinator.assertNotTransitioning(upper)).toThrow(
        SessionArchivingError,
      );
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

  it('publishes an exclusive waiter before draining existing shared access', async () => {
    const coordinator = new SessionArchiveCoordinator();
    const sessionId = '550e8400-e29b-41d4-a716-446655440025';
    let releaseShared!: () => void;
    const sharedGate = new Promise<void>((resolve) => {
      releaseShared = resolve;
    });
    const shared = coordinator.runSharedMany([sessionId], () => sharedGate);
    let exclusiveEntered = false;
    const exclusive = coordinator.runExclusiveAfterShared(
      sessionId.toUpperCase(),
      async () => {
        exclusiveEntered = true;
        return 'exclusive';
      },
    );

    await Promise.resolve();
    expect(exclusiveEntered).toBe(false);
    await expect(
      coordinator.runSharedMany([sessionId], async () => 'late shared'),
    ).rejects.toThrow(SessionArchivingError);
    await expect(
      coordinator.runExclusiveAfterShared(sessionId, async () => 'second'),
    ).rejects.toThrow(SessionArchivingError);

    releaseShared();
    await shared;
    await expect(exclusive).resolves.toBe('exclusive');
    expect(exclusiveEntered).toBe(true);
  });

  it('releases a wait-after-shared exclusive when its callback throws', async () => {
    const coordinator = new SessionArchiveCoordinator();
    const sessionId = '550e8400-e29b-41d4-a716-446655440026';

    await expect(
      coordinator.runExclusiveAfterShared(sessionId, async () => {
        throw new Error('waiter failed');
      }),
    ).rejects.toThrow('waiter failed');
    await expect(
      coordinator.runSharedMany([sessionId], async () => 'shared'),
    ).resolves.toBe('shared');
  });

  it('maintenance drain includes an exclusive waiting for shared access', async () => {
    const coordinator = new SessionArchiveCoordinator();
    const sessionId = '550e8400-e29b-41d4-a716-446655440027';
    let releaseShared!: () => void;
    const shared = coordinator.runSharedMany(
      [sessionId],
      () =>
        new Promise<void>((resolve) => {
          releaseShared = resolve;
        }),
    );
    let releaseExclusive!: () => void;
    const exclusive = coordinator.runExclusiveAfterShared(
      sessionId,
      () =>
        new Promise<void>((resolve) => {
          releaseExclusive = resolve;
        }),
    );
    const drain = coordinator.sealMaintenanceAndWait();

    releaseShared();
    await shared;
    await vi.waitFor(() => expect(releaseExclusive).toBeTypeOf('function'));
    let drained = false;
    void drain.then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);

    releaseExclusive();
    await exclusive;
    await drain;
    expect(drained).toBe(true);
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

  it('seals new maintenance and waits only for admitted exclusive work', async () => {
    const coordinator = new SessionArchiveCoordinator();
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const maintenance = coordinator.runExclusiveMany(['session-a'], () => gate);
    const drain = coordinator.sealMaintenanceAndWait();

    await expect(
      coordinator.runExclusiveMany(['session-b'], async () => undefined),
    ).rejects.toMatchObject({ code: 'daemon_draining' });
    let drained = false;
    void drain.then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);

    finish();
    await maintenance;
    await drain;
    expect(drained).toBe(true);
  });

  it('seals new shared maintenance and waits for admitted reads', async () => {
    const coordinator = new SessionArchiveCoordinator();
    let finish!: () => void;
    const shared = coordinator.runSharedMany(
      ['session-a'],
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );

    const drain = coordinator.sealMaintenanceAndWait();
    await expect(
      coordinator.runSharedMany(['session-b'], async () => undefined),
    ).rejects.toMatchObject({ code: 'daemon_draining' });
    let drained = false;
    void drain.then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);

    finish();
    await shared;
    await drain;
    expect(drained).toBe(true);
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
      resolvedConflicts: [],
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

  it('collapses case-variant spellings in one batch to a single archive', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440102';
    writeSessionFile(workspaceDir, sessionId, 'active');
    const closeSession = vi.fn().mockResolvedValue(undefined);

    const result = await archiveDaemonSessions({
      sessionIds: [sessionId.toUpperCase(), sessionId],
      service: new SessionService(workspaceDir),
      bridge: { closeSession },
      coordinator: new SessionArchiveCoordinator(),
    });

    expect(result).toEqual({
      archived: [sessionId],
      alreadyArchived: [],
      resolvedConflicts: [],
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

  it('reports task maintenance failure after archiving the transcript', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440051';
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
    ]);
    const cronFile = getCronFilePath(workspaceDir);
    fs.rmSync(cronFile);
    fs.mkdirSync(cronFile);

    const result = await archiveDaemonSessions({
      sessionIds: [sessionId],
      service: new SessionService(workspaceDir),
      bridge: { closeSession: vi.fn().mockResolvedValue(undefined) },
      coordinator: new SessionArchiveCoordinator(),
    });

    expect(result.archived).toEqual([sessionId]);
    expect(result.errors).toEqual([{ sessionId, error: expect.any(Error) }]);
  });

  it('does not acquire writer leases for ids already archived or missing', async () => {
    const archivedId = '550e8400-e29b-41d4-a716-446655440003';
    const missingId = '550e8400-e29b-41d4-a716-446655440004';
    writeSessionFile(workspaceDir, archivedId, 'archived');
    const service = new SessionService(workspaceDir);
    const closeSession = vi.fn().mockResolvedValue(undefined);
    const acquire = vi.spyOn(service, 'acquireSessionWriterLease');

    const result = await archiveDaemonSessions({
      sessionIds: [archivedId, missingId],
      service,
      bridge: { closeSession },
      coordinator: new SessionArchiveCoordinator(),
    });

    expect(result).toEqual({
      archived: [],
      alreadyArchived: [archivedId],
      resolvedConflicts: [],
      notFound: [missingId],
      errors: [],
    });
    expect(acquire).not.toHaveBeenCalled();
    expect(closeSession).toHaveBeenCalledTimes(2);
  });

  it('does not archive while another writer holds the lease', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440005';
    writeSessionFile(workspaceDir, sessionId, 'active');
    const service = new SessionService(workspaceDir);
    const lease = await service.acquireSessionWriterLease(sessionId, {
      processKind: 'daemon',
      reclaimPolicy: 'never',
    });

    const blocked = await archiveDaemonSessions({
      sessionIds: [sessionId],
      service,
      bridge: { closeSession: vi.fn().mockResolvedValue(undefined) },
      coordinator: new SessionArchiveCoordinator(),
    });
    expect(blocked.archived).toEqual([]);
    expect(blocked.errors[0]?.error).toBeInstanceOf(SessionWriterConflictError);
    expect(fs.existsSync(sessionPath(workspaceDir, sessionId, 'active'))).toBe(
      true,
    );

    await lease.release();
    const retried = await archiveDaemonSessions({
      sessionIds: [sessionId],
      service,
      bridge: { closeSession: vi.fn().mockResolvedValue(undefined) },
      coordinator: new SessionArchiveCoordinator(),
    });
    expect(retried.archived).toEqual([sessionId]);
  });

  it('takes over a sealed empty transcript before maintenance', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440006';
    const activePath = sessionPath(workspaceDir, sessionId, 'active');
    fs.mkdirSync(path.dirname(activePath), { recursive: true });
    fs.writeFileSync(activePath, '');
    const service = new SessionService(workspaceDir);
    const previous = await service.acquireSessionWriterLease(sessionId, {
      processKind: 'daemon',
      reclaimPolicy: 'never',
    });
    await previous.sealForHandoff();

    const result = await archiveDaemonSessions({
      sessionIds: [sessionId],
      service,
      bridge: { closeSession: vi.fn().mockResolvedValue(undefined) },
      coordinator: new SessionArchiveCoordinator(),
    });

    expect(result).toMatchObject({
      archived: [sessionId],
      errors: [],
    });
    expect(fs.existsSync(activePath)).toBe(false);
    expect(
      fs.existsSync(sessionPath(workspaceDir, sessionId, 'archived')),
    ).toBe(true);
  });

  it.runIf(process.platform !== 'win32')(
    'rejects a transcript FIFO without waiting for a writer',
    async () => {
      const sessionId = '550e8400-e29b-41d4-a716-446655440106';
      const activePath = sessionPath(workspaceDir, sessionId, 'active');
      fs.mkdirSync(path.dirname(activePath), { recursive: true });
      execFileSync('mkfifo', [activePath]);
      let writer: number | undefined;
      const unblock = setTimeout(() => {
        writer = fs.openSync(
          activePath,
          fs.constants.O_WRONLY | (fs.constants.O_NONBLOCK ?? 0),
        );
      }, 500);
      const startedAt = Date.now();

      try {
        const result = await archiveDaemonSessions({
          sessionIds: [sessionId],
          service: new SessionService(workspaceDir),
          bridge: { closeSession: vi.fn().mockResolvedValue(undefined) },
          coordinator: new SessionArchiveCoordinator(),
        });

        expect(result.errors[0]?.error).toBeInstanceOf(
          SessionStorageEntryError,
        );
        expect(Date.now() - startedAt).toBeLessThan(400);
      } finally {
        clearTimeout(unblock);
        if (writer !== undefined) fs.closeSync(writer);
      }
    },
  );

  it('keeps independent batch sessions moving when one writer conflicts', async () => {
    const blockedId = '550e8400-e29b-41d4-a716-446655440008';
    const availableId = '550e8400-e29b-41d4-a716-446655440009';
    writeSessionFile(workspaceDir, blockedId, 'active');
    writeSessionFile(workspaceDir, availableId, 'active');
    const service = new SessionService(workspaceDir);
    const lease = await service.acquireSessionWriterLease(blockedId, {
      processKind: 'daemon',
      reclaimPolicy: 'never',
    });

    const result = await archiveDaemonSessions({
      sessionIds: [blockedId, availableId],
      service,
      bridge: { closeSession: vi.fn().mockResolvedValue(undefined) },
      coordinator: new SessionArchiveCoordinator(),
    });

    expect(result.archived).toEqual([availableId]);
    expect(result.errors[0]?.sessionId).toBe(blockedId);
    expect(result.errors[0]?.error).toBeInstanceOf(SessionWriterConflictError);
    await lease.release();
  });

  it('reports a gate race per session after another batch item was archived', async () => {
    const archivedId = '550e8400-e29b-41d4-a716-446655440023';
    const blockedId = '550e8400-e29b-41d4-a716-446655440024';
    writeSessionFile(workspaceDir, archivedId, 'active');
    writeSessionFile(workspaceDir, blockedId, 'active');
    const coordinator = new SessionArchiveCoordinator();
    let releaseBlocked!: () => void;
    const blocked = new Promise<void>((resolve) => {
      releaseBlocked = resolve;
    });
    let competingMaintenance: Promise<void> | undefined;

    const result = await archiveDaemonSessions({
      sessionIds: [archivedId, blockedId],
      service: new SessionService(workspaceDir),
      bridge: {
        closeSession: vi.fn(async (sessionId) => {
          if (sessionId === archivedId) {
            competingMaintenance = coordinator.runExclusiveMany(
              [blockedId],
              () => blocked,
            );
          }
        }),
      },
      coordinator,
    });

    try {
      expect(result.archived).toEqual([archivedId]);
      expect(result.errors).toEqual([
        {
          sessionId: blockedId,
          error: expect.any(SessionArchivingError),
        },
      ]);
    } finally {
      releaseBlocked();
      await competingMaintenance;
    }
  });

  it('keeps independent batch sessions moving when one classification fails', async () => {
    const failedId = '550e8400-e29b-41d4-a716-446655440019';
    const availableId = '550e8400-e29b-41d4-a716-446655440020';
    writeSessionFile(workspaceDir, availableId, 'active');
    const service = new SessionService(workspaceDir);
    const getLocation = service.getMaintainableSessionLocation.bind(service);
    const failure = new Error('classification failed');
    vi.spyOn(service, 'getMaintainableSessionLocation').mockImplementation(
      (sessionId) =>
        sessionId === failedId
          ? Promise.reject(failure)
          : getLocation(sessionId),
    );

    const result = await archiveDaemonSessions({
      sessionIds: [failedId, availableId],
      service,
      bridge: { closeSession: vi.fn().mockResolvedValue(undefined) },
      coordinator: new SessionArchiveCoordinator(),
    });

    expect(result.archived).toEqual([availableId]);
    expect(result.errors).toEqual([{ sessionId: failedId, error: failure }]);
  });

  it('does not acquire a lease or mutate when closing the owner fails', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440017';
    writeSessionFile(workspaceDir, sessionId, 'active');
    const service = new SessionService(workspaceDir);
    const acquire = vi.spyOn(service, 'acquireSessionWriterLease');
    const closeError = new Error('agent flush failed');

    const result = await archiveDaemonSessions({
      sessionIds: [sessionId],
      service,
      bridge: { closeSession: vi.fn().mockRejectedValue(closeError) },
      coordinator: new SessionArchiveCoordinator(),
    });

    expect(result.archived).toEqual([]);
    expect(result.errors).toEqual([{ sessionId, error: closeError }]);
    expect(acquire).not.toHaveBeenCalled();
    expect(fs.existsSync(sessionPath(workspaceDir, sessionId, 'active'))).toBe(
      true,
    );
  });

  it('uses the classification made after acquiring the lease', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440010';
    writeSessionFile(workspaceDir, sessionId, 'active');
    const service = new SessionService(workspaceDir);
    const originalGetLocation =
      service.getMaintainableSessionLocation.bind(service);
    let classifications = 0;
    vi.spyOn(service, 'getMaintainableSessionLocation').mockImplementation(
      async (id) => {
        classifications++;
        if (classifications === 2) {
          fs.mkdirSync(
            path.dirname(sessionPath(workspaceDir, id, 'archived')),
            { recursive: true },
          );
          fs.renameSync(
            sessionPath(workspaceDir, id, 'active'),
            sessionPath(workspaceDir, id, 'archived'),
          );
        }
        return originalGetLocation(id);
      },
    );

    const result = await archiveDaemonSessions({
      sessionIds: [sessionId],
      service,
      bridge: { closeSession: vi.fn().mockResolvedValue(undefined) },
      coordinator: new SessionArchiveCoordinator(),
    });

    expect(result).toEqual({
      archived: [],
      alreadyArchived: [sessionId],
      resolvedConflicts: [],
      notFound: [],
      errors: [],
    });
    const reacquired = await service.acquireSessionWriterLease(sessionId, {
      processKind: 'daemon',
      reclaimPolicy: 'never',
    });
    await reacquired.release();
  });

  it('does not lock an active/archive conflict', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440016';
    writeSessionFile(workspaceDir, sessionId, 'active');
    writeSessionFile(workspaceDir, sessionId, 'archived');
    const service = new SessionService(workspaceDir);
    const acquire = vi.spyOn(service, 'acquireSessionWriterLease');

    const result = await archiveDaemonSessions({
      sessionIds: [sessionId],
      service,
      bridge: { closeSession: vi.fn().mockResolvedValue(undefined) },
      coordinator: new SessionArchiveCoordinator(),
    });

    expect(result.archived).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(acquire).not.toHaveBeenCalled();
  });

  it('repairs an active/archive conflict by keeping the archived copy', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440116';
    writeSessionFile(workspaceDir, sessionId, 'active');
    writeSessionFile(workspaceDir, sessionId, 'archived');
    const archivedPath = sessionPath(workspaceDir, sessionId, 'archived');
    const archivedBytes = fs.readFileSync(archivedPath);

    const result = await archiveDaemonSessions({
      sessionIds: [sessionId],
      service: new SessionService(workspaceDir),
      bridge: { closeSession: vi.fn().mockResolvedValue(undefined) },
      coordinator: new SessionArchiveCoordinator(),
      resolveConflicts: true,
    });

    expect(result).toMatchObject({
      archived: [sessionId],
      resolvedConflicts: [sessionId],
      errors: [],
    });
    expect(fs.existsSync(sessionPath(workspaceDir, sessionId, 'active'))).toBe(
      false,
    );
    expect(fs.readFileSync(archivedPath)).toEqual(archivedBytes);
  });

  it('does not report success after release fails but reconciles the task to the applied archive', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440006';
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
    ]);
    const service = new SessionService(workspaceDir);
    const release = vi.fn(async () => {
      expect((await readCronTasks(workspaceDir))[0]?.enabled).toBe(false);
      throw new SessionWriterLostError();
    });
    vi.spyOn(service, 'acquireSessionWriterLease').mockResolvedValue({
      assertOwnedAndUnchanged: vi.fn().mockResolvedValue(undefined),
      assertCleanupOwned: vi.fn(),
      release,
    } as unknown as SessionWriterLease);

    const result = await archiveDaemonSessions({
      sessionIds: [sessionId],
      service,
      bridge: { closeSession: vi.fn().mockResolvedValue(undefined) },
      coordinator: new SessionArchiveCoordinator(),
    });

    expect(result.archived).toEqual([]);
    expect(result.errors[0]?.error).toBeInstanceOf(SessionWriterLostError);
    expect(
      fs.existsSync(sessionPath(workspaceDir, sessionId, 'archived')),
    ).toBe(true);
    expect((await readCronTasks(workspaceDir))[0]?.enabled).toBe(false);
    expect(release).toHaveBeenCalledOnce();
  });

  it('releases the lease when scheduled-task reconciliation fails', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440018';
    writeSessionFile(workspaceDir, sessionId, 'active');
    fs.mkdirSync(getCronFilePath(workspaceDir), { recursive: true });
    const service = new SessionService(workspaceDir);

    const result = await archiveDaemonSessions({
      sessionIds: [sessionId],
      service,
      bridge: { closeSession: vi.fn().mockResolvedValue(undefined) },
      coordinator: new SessionArchiveCoordinator(),
    });

    expect(result.archived).toEqual([sessionId]);
    const reacquired = await service.acquireSessionWriterLease(sessionId, {
      processKind: 'daemon',
      reclaimPolicy: 'never',
    });
    await reacquired.release();
  });

  it('checks only the selected runtime root for transcripts and locks', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440007';
    const primaryRuntime = path.join(runtimeDir, 'primary');
    const secondaryRuntime = path.join(runtimeDir, 'secondary');
    writeSessionFile(
      workspaceDir,
      sessionId,
      'active',
      workspaceDir,
      secondaryRuntime,
    );
    const primaryService = new SessionService(workspaceDir, {
      runtimeBaseDir: primaryRuntime,
    });
    const primaryLease = await primaryService.acquireSessionWriterLease(
      sessionId,
      {
        processKind: 'daemon',
        reclaimPolicy: 'never',
      },
    );

    const result = await archiveDaemonSessions({
      sessionIds: [sessionId],
      service: new SessionService(workspaceDir, {
        runtimeBaseDir: secondaryRuntime,
      }),
      bridge: { closeSession: vi.fn().mockResolvedValue(undefined) },
      coordinator: new SessionArchiveCoordinator(),
    });

    expect(result.archived).toEqual([sessionId]);
    expect(
      fs.existsSync(
        sessionPath(workspaceDir, sessionId, 'archived', secondaryRuntime),
      ),
    ).toBe(true);
    expect(
      fs.existsSync(
        sessionPath(workspaceDir, sessionId, 'active', primaryRuntime),
      ),
    ).toBe(false);
    await primaryLease.release();
  });

  it('rejects with DaemonDrainingError after the coordinator is sealed', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440080';
    writeSessionFile(workspaceDir, sessionId, 'active');
    const coordinator = new SessionArchiveCoordinator();
    await coordinator.sealMaintenanceAndWait();

    await expect(
      archiveDaemonSessions({
        sessionIds: [sessionId],
        service: new SessionService(workspaceDir),
        bridge: { closeSession: vi.fn().mockResolvedValue(undefined) },
        coordinator,
      }),
    ).rejects.toThrow(DaemonDrainingError);
    expect(fs.existsSync(sessionPath(workspaceDir, sessionId, 'active'))).toBe(
      true,
    );
  });

  it('recovers an enabled task whose session is already archived', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440063';
    writeSessionFile(workspaceDir, sessionId, 'archived');
    await updateCronTasks(workspaceDir, () => [
      {
        id: 'stranded',
        cron: '0 9 * * *',
        prompt: 'p',
        recurring: true,
        createdAt: 1_700_000_000_000,
        lastFiredAt: null,
        sessionId,
      },
    ]);

    const result = await archiveDaemonSessions({
      sessionIds: [sessionId],
      service: new SessionService(workspaceDir),
      bridge: { closeSession: vi.fn().mockResolvedValue(undefined) },
      coordinator: new SessionArchiveCoordinator(),
    });

    expect(result.alreadyArchived).toEqual([sessionId]);
    const stranded = (await readCronTasks(workspaceDir)).find(
      (task) => task.id === 'stranded',
    );
    expect(stranded!.enabled).toBe(false);
    expect(stranded!.disabledByArchive).toBe(true);
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
    const acquire = vi.spyOn(service, 'acquireSessionWriterLease');
    const result = await unarchiveDaemonSessions({
      sessionIds: [archivedId, activeId, missingId, archivedId],
      service,
      coordinator: new SessionArchiveCoordinator(),
    });
    expect(result).toEqual({
      unarchived: [archivedId],
      alreadyActive: [activeId],
      resolvedConflicts: [],
      notFound: [missingId],
      errors: [],
    });
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(sessionPath(workspaceDir, archivedId, 'active'))).toBe(
      true,
    );
    expect(
      fs.existsSync(sessionPath(workspaceDir, archivedId, 'archived')),
    ).toBe(false);
  });

  it('collapses case-variant spellings in one batch to a single unarchive', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440111';
    writeSessionFile(workspaceDir, sessionId, 'archived');

    const result = await unarchiveDaemonSessions({
      sessionIds: [sessionId.toUpperCase(), sessionId],
      service: new SessionService(workspaceDir),
      coordinator: new SessionArchiveCoordinator(),
    });

    expect(result).toEqual({
      unarchived: [sessionId],
      alreadyActive: [],
      resolvedConflicts: [],
      notFound: [],
      errors: [],
    });
    expect(fs.existsSync(sessionPath(workspaceDir, sessionId, 'active'))).toBe(
      true,
    );
    expect(
      fs.existsSync(sessionPath(workspaceDir, sessionId, 'archived')),
    ).toBe(false);
  });

  it('repairs an active/archive conflict by keeping the active copy', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440117';
    writeSessionFile(workspaceDir, sessionId, 'active');
    writeSessionFile(workspaceDir, sessionId, 'archived');
    const activePath = sessionPath(workspaceDir, sessionId, 'active');
    const activeBytes = fs.readFileSync(activePath);

    const result = await unarchiveDaemonSessions({
      sessionIds: [sessionId],
      service: new SessionService(workspaceDir),
      coordinator: new SessionArchiveCoordinator(),
      resolveConflicts: true,
    });

    expect(result).toMatchObject({
      unarchived: [sessionId],
      resolvedConflicts: [sessionId],
      errors: [],
    });
    expect(fs.readFileSync(activePath)).toEqual(activeBytes);
    expect(
      fs.existsSync(sessionPath(workspaceDir, sessionId, 'archived')),
    ).toBe(false);
  });

  it('does not unarchive while another writer holds the lease', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440015';
    writeSessionFile(workspaceDir, sessionId, 'archived');
    const service = new SessionService(workspaceDir);
    const lease = await service.acquireSessionWriterLease(sessionId, {
      processKind: 'daemon',
      reclaimPolicy: 'never',
    });

    const result = await unarchiveDaemonSessions({
      sessionIds: [sessionId],
      service,
      coordinator: new SessionArchiveCoordinator(),
    });
    expect(result.unarchived).toEqual([]);
    expect(result.errors[0]?.error).toBeInstanceOf(SessionWriterConflictError);
    expect(
      fs.existsSync(sessionPath(workspaceDir, sessionId, 'archived')),
    ).toBe(true);

    await lease.release();
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
      resolvedConflicts: [],
      notFound: [],
      errors: [{ sessionId: archivedId, error: failure }],
    });
    const reacquired = await service.acquireSessionWriterLease(archivedId, {
      processKind: 'daemon',
      reclaimPolicy: 'never',
    });
    await reacquired.release();
  });

  it('keeps independent unarchive sessions moving when one classification fails', async () => {
    const failedId = '550e8400-e29b-41d4-a716-446655440021';
    const availableId = '550e8400-e29b-41d4-a716-446655440022';
    writeSessionFile(workspaceDir, availableId, 'archived');
    const service = new SessionService(workspaceDir);
    const getLocation = service.getMaintainableSessionLocation.bind(service);
    const failure = new Error('classification failed');
    vi.spyOn(service, 'getMaintainableSessionLocation').mockImplementation(
      (sessionId) =>
        sessionId === failedId
          ? Promise.reject(failure)
          : getLocation(sessionId),
    );

    const result = await unarchiveDaemonSessions({
      sessionIds: [failedId, availableId],
      service,
      coordinator: new SessionArchiveCoordinator(),
    });

    expect(result.unarchived).toEqual([availableId]);
    expect(result.errors).toEqual([{ sessionId: failedId, error: failure }]);
  });

  it('reports a gate race per session after another batch item was unarchived', async () => {
    const unarchivedId = '550e8400-e29b-41d4-a716-446655440025';
    const blockedId = '550e8400-e29b-41d4-a716-446655440026';
    writeSessionFile(workspaceDir, unarchivedId, 'archived');
    writeSessionFile(workspaceDir, blockedId, 'archived');
    const service = new SessionService(workspaceDir);
    const getLocation = service.getMaintainableSessionLocation.bind(service);
    const coordinator = new SessionArchiveCoordinator();
    let releaseBlocked!: () => void;
    const blocked = new Promise<void>((resolve) => {
      releaseBlocked = resolve;
    });
    let competingMaintenance: Promise<void> | undefined;
    vi.spyOn(service, 'getMaintainableSessionLocation').mockImplementation(
      (sessionId) => {
        if (sessionId === unarchivedId && !competingMaintenance) {
          competingMaintenance = coordinator.runExclusiveMany(
            [blockedId],
            () => blocked,
          );
        }
        return getLocation(sessionId);
      },
    );

    const result = await unarchiveDaemonSessions({
      sessionIds: [unarchivedId, blockedId],
      service,
      coordinator,
    });

    try {
      expect(result.unarchived).toEqual([unarchivedId]);
      expect(result.errors).toEqual([
        {
          sessionId: blockedId,
          error: expect.any(SessionArchivingError),
        },
      ]);
    } finally {
      releaseBlocked();
      await competingMaintenance;
    }
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

  it('rejects with DaemonDrainingError after the coordinator is sealed', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440081';
    writeSessionFile(workspaceDir, sessionId, 'archived');
    const coordinator = new SessionArchiveCoordinator();
    await coordinator.sealMaintenanceAndWait();

    await expect(
      unarchiveDaemonSessions({
        sessionIds: [sessionId],
        service: new SessionService(workspaceDir),
        coordinator,
      }),
    ).rejects.toThrow(DaemonDrainingError);
    expect(
      fs.existsSync(sessionPath(workspaceDir, sessionId, 'archived')),
    ).toBe(true);
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

  it('deletes both copies of an exact active/archive conflict', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440069';
    writeSessionFile(workspaceDir, sessionId, 'active');
    writeSessionFile(workspaceDir, sessionId, 'archived');
    const service = new SessionService(workspaceDir);
    const acquire = vi.spyOn(service, 'acquireSessionWriterLease');

    const result = await deleteDaemonSessions({
      sessionIds: [sessionId],
      service,
      bridge: {
        closeSession: vi.fn().mockResolvedValue(undefined),
        deleteSessionAttachments: vi.fn().mockResolvedValue(undefined),
      },
      coordinator: new SessionArchiveCoordinator(),
    });

    expect(result).toEqual({
      removed: [sessionId],
      notFound: [],
      errors: [],
    });
    expect(acquire).toHaveBeenCalledOnce();
    expect(fs.existsSync(sessionPath(workspaceDir, sessionId, 'active'))).toBe(
      false,
    );
    expect(
      fs.existsSync(sessionPath(workspaceDir, sessionId, 'archived')),
    ).toBe(false);
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

    const deleteSessionAttachments = vi.fn().mockResolvedValue(undefined);
    const result = await deleteDaemonSessions({
      sessionIds: [sessionId],
      service: new SessionService(workspaceDir),
      bridge: {
        closeSession: vi.fn().mockResolvedValue(undefined),
        deleteSessionAttachments,
      },
      coordinator: new SessionArchiveCoordinator(),
    });
    expect(result.removed).toEqual([sessionId]);
    expect(deleteSessionAttachments).toHaveBeenCalledWith(sessionId);

    const ids = (await readCronTasks(workspaceDir)).map((t) => t.id).sort();
    expect(ids).toEqual(['other']); // bound task deleted, unbound survives
  });

  it('repairs task maintenance on retry after deleting the transcript', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440171';
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
    ]);
    const cronFile = getCronFilePath(workspaceDir);
    const cronContents = fs.readFileSync(cronFile);
    fs.rmSync(cronFile);
    fs.mkdirSync(cronFile);
    const deleteSessionAttachments = vi.fn().mockResolvedValue(undefined);

    const result = await deleteDaemonSessions({
      sessionIds: [sessionId],
      service: new SessionService(workspaceDir),
      bridge: {
        closeSession: vi.fn().mockResolvedValue(undefined),
        deleteSessionAttachments,
      },
      coordinator: new SessionArchiveCoordinator(),
    });

    expect(result.removed).toEqual([sessionId]);
    expect(result.errors).toEqual([
      {
        sessionId,
        error: 'Scheduled task lifecycle update failed.',
      },
    ]);
    expect(deleteSessionAttachments).toHaveBeenCalledWith(sessionId);

    fs.rmSync(cronFile, { recursive: true, force: true });
    fs.writeFileSync(cronFile, cronContents);

    const retry = await deleteDaemonSessions({
      sessionIds: [sessionId],
      service: new SessionService(workspaceDir),
      bridge: {
        closeSession: vi.fn().mockResolvedValue(undefined),
        deleteSessionAttachments,
      },
      coordinator: new SessionArchiveCoordinator(),
    });

    expect(retry).toEqual({
      removed: [],
      notFound: [sessionId],
      errors: [],
    });
    expect(await readCronTasks(workspaceDir)).toEqual([]);
  });

  it('collapses case-variant spellings in one batch to a single delete', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440170';
    writeSessionFile(workspaceDir, sessionId, 'active');
    const closeSession = vi.fn().mockResolvedValue(undefined);

    const result = await deleteDaemonSessions({
      sessionIds: [sessionId.toUpperCase(), sessionId],
      service: new SessionService(workspaceDir),
      bridge: {
        closeSession,
        deleteSessionAttachments: vi.fn().mockResolvedValue(undefined),
      },
      coordinator: new SessionArchiveCoordinator(),
    });

    expect(result).toEqual({
      removed: [sessionId],
      notFound: [],
      errors: [],
    });
    expect(closeSession).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(sessionPath(workspaceDir, sessionId, 'active'))).toBe(
      false,
    );
  });

  it('does not delete while another writer holds the lease', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440071';
    writeSessionFile(workspaceDir, sessionId, 'active');
    const service = new SessionService(workspaceDir);
    const lease = await service.acquireSessionWriterLease(sessionId, {
      processKind: 'daemon',
      reclaimPolicy: 'never',
    });

    const result = await deleteDaemonSessions({
      sessionIds: [sessionId],
      service,
      bridge: {
        closeSession: vi.fn().mockResolvedValue(undefined),
        deleteSessionAttachments: vi.fn().mockResolvedValue(undefined),
      },
      coordinator: new SessionArchiveCoordinator(),
    });
    expect(result.removed).toEqual([]);
    expect(result.errors).toEqual([
      {
        sessionId,
        error: 'This session is already open in another Qwen process.',
      },
    ]);
    expect(fs.existsSync(sessionPath(workspaceDir, sessionId, 'active'))).toBe(
      true,
    );

    await lease.release();
  });

  it('reports attachment cleanup failures and allows an idempotent retry', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440075';
    writeSessionFile(workspaceDir, sessionId, 'active');
    const deleteSessionAttachments = vi
      .fn()
      .mockRejectedValueOnce(new Error('cleanup failed'))
      .mockResolvedValue(undefined);
    const params = {
      sessionIds: [sessionId],
      service: new SessionService(workspaceDir),
      bridge: {
        closeSession: vi.fn().mockResolvedValue(undefined),
        deleteSessionAttachments,
      },
      coordinator: new SessionArchiveCoordinator(),
    };

    await expect(deleteDaemonSessions(params)).resolves.toEqual({
      removed: [],
      notFound: [],
      errors: [{ sessionId, error: 'cleanup failed' }],
    });
    await expect(deleteDaemonSessions(params)).resolves.toEqual({
      removed: [],
      notFound: [sessionId],
      errors: [],
    });
    expect(deleteSessionAttachments).toHaveBeenCalledTimes(2);
  });

  it('reports a gate race per session after another batch item was deleted', async () => {
    const removedId = '550e8400-e29b-41d4-a716-446655440073';
    const blockedId = '550e8400-e29b-41d4-a716-446655440074';
    writeSessionFile(workspaceDir, removedId, 'active');
    writeSessionFile(workspaceDir, blockedId, 'active');
    const coordinator = new SessionArchiveCoordinator();
    let releaseBlocked!: () => void;
    const blocked = new Promise<void>((resolve) => {
      releaseBlocked = resolve;
    });
    let competingMaintenance: Promise<void> | undefined;

    try {
      const result = await deleteDaemonSessions({
        sessionIds: [removedId, blockedId],
        service: new SessionService(workspaceDir),
        bridge: {
          closeSession: vi.fn(async (sessionId) => {
            if (sessionId === removedId) {
              competingMaintenance = coordinator.runExclusiveMany(
                [blockedId],
                () => blocked,
              );
            }
          }),
          deleteSessionAttachments: vi.fn().mockResolvedValue(undefined),
        },
        coordinator,
      });

      expect(result.removed).toEqual([removedId]);
      expect(result.errors).toEqual([
        {
          sessionId: blockedId,
          error: expect.stringContaining('is being archived or unarchived'),
        },
      ]);
      expect(
        fs.existsSync(sessionPath(workspaceDir, removedId, 'active')),
      ).toBe(false);
      expect(
        fs.existsSync(sessionPath(workspaceDir, blockedId, 'active')),
      ).toBe(true);
    } finally {
      releaseBlocked();
      await competingMaintenance;
    }
  });

  it('skips orphan deletion when a new owner attached', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440072';
    writeSessionFile(workspaceDir, sessionId, 'active');
    const service = new SessionService(workspaceDir);
    const acquire = vi.spyOn(service, 'acquireSessionWriterLease');

    await expect(
      deleteDaemonSessionIfOrphan({
        sessionId,
        service,
        bridge: {
          killSession: vi.fn().mockResolvedValue(false),
          markSessionCatalogChanged: vi.fn(),
        },
        coordinator: new SessionArchiveCoordinator(),
      }),
    ).resolves.toBe(false);
    expect(acquire).not.toHaveBeenCalled();
    expect(fs.existsSync(sessionPath(workspaceDir, sessionId, 'active'))).toBe(
      true,
    );
  });

  it('rejects with DaemonDrainingError after the coordinator is sealed', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440082';
    writeSessionFile(workspaceDir, sessionId, 'active');
    const coordinator = new SessionArchiveCoordinator();
    await coordinator.sealMaintenanceAndWait();

    await expect(
      deleteDaemonSessions({
        sessionIds: [sessionId],
        service: new SessionService(workspaceDir),
        bridge: {
          closeSession: vi.fn().mockResolvedValue(undefined),
          deleteSessionAttachments: vi.fn().mockResolvedValue(undefined),
        },
        coordinator,
      }),
    ).rejects.toThrow(DaemonDrainingError);
    expect(fs.existsSync(sessionPath(workspaceDir, sessionId, 'active'))).toBe(
      true,
    );
  });

  it('deletes the transcript when killSession resolves true', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440083';
    writeSessionFile(workspaceDir, sessionId, 'active');
    const service = new SessionService(workspaceDir);
    const markSessionCatalogChanged = vi.fn();

    await expect(
      deleteDaemonSessionIfOrphan({
        sessionId,
        service,
        bridge: {
          killSession: vi.fn().mockResolvedValue(true),
          markSessionCatalogChanged,
        },
        coordinator: new SessionArchiveCoordinator(),
      }),
    ).resolves.toBe(true);
    expect(fs.existsSync(sessionPath(workspaceDir, sessionId, 'active'))).toBe(
      false,
    );
    expect(markSessionCatalogChanged).toHaveBeenCalledTimes(1);
  });

  it('returns true when task maintenance fails after orphan deletion', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440086';
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
    ]);
    const cronFile = getCronFilePath(workspaceDir);
    fs.rmSync(cronFile);
    fs.mkdirSync(cronFile);
    const markSessionCatalogChanged = vi.fn();

    await expect(
      deleteDaemonSessionIfOrphan({
        sessionId,
        service: new SessionService(workspaceDir),
        bridge: {
          killSession: vi.fn().mockResolvedValue(true),
          markSessionCatalogChanged,
        },
        coordinator: new SessionArchiveCoordinator(),
      }),
    ).resolves.toBe(true);
    expect(fs.existsSync(sessionPath(workspaceDir, sessionId, 'active'))).toBe(
      false,
    );
    expect(markSessionCatalogChanged).toHaveBeenCalledTimes(1);
  });

  it('deletes the transcript when killSession throws SessionNotFoundError', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440084';
    writeSessionFile(workspaceDir, sessionId, 'active');
    const service = new SessionService(workspaceDir);
    const markSessionCatalogChanged = vi.fn();

    await expect(
      deleteDaemonSessionIfOrphan({
        sessionId,
        service,
        bridge: {
          killSession: vi
            .fn()
            .mockRejectedValue(new SessionNotFoundError(sessionId)),
          markSessionCatalogChanged,
        },
        coordinator: new SessionArchiveCoordinator(),
      }),
    ).resolves.toBe(true);
    expect(fs.existsSync(sessionPath(workspaceDir, sessionId, 'active'))).toBe(
      false,
    );
    // Never-live orphan: no lifecycle choke point can fire, so the explicit
    // mark is the only catalog-version signal for this removal.
    expect(markSessionCatalogChanged).toHaveBeenCalledTimes(1);
  });

  it('throws when the lease is held by another writer', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440085';
    writeSessionFile(workspaceDir, sessionId, 'active');
    const service = new SessionService(workspaceDir);
    const lease = await service.acquireSessionWriterLease(sessionId, {
      processKind: 'daemon',
      reclaimPolicy: 'never',
    });

    await expect(
      deleteDaemonSessionIfOrphan({
        sessionId,
        service,
        bridge: {
          killSession: vi.fn().mockResolvedValue(true),
          markSessionCatalogChanged: vi.fn(),
        },
        coordinator: new SessionArchiveCoordinator(),
      }),
    ).rejects.toThrow(SessionWriterConflictError);
    expect(fs.existsSync(sessionPath(workspaceDir, sessionId, 'active'))).toBe(
      true,
    );

    await lease.release();
  });
});

function writeSessionFile(
  workspaceDir: string,
  sessionId: string,
  state: 'active' | 'archived',
  recordCwd = workspaceDir,
  runtimeBaseDir?: string,
): void {
  const chatsDir = path.join(
    new Storage(workspaceDir, runtimeBaseDir).getProjectDir(),
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
  runtimeBaseDir?: string,
): string {
  const chatsDir = path.join(
    new Storage(workspaceDir, runtimeBaseDir).getProjectDir(),
    'chats',
  );
  return path.join(
    state === 'archived' ? path.join(chatsDir, 'archive') : chatsDir,
    `${sessionId}.jsonl`,
  );
}
