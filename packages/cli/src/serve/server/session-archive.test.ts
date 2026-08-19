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
  deleteDaemonSessionIfOrphan,
  deleteDaemonSessions,
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
    const getLocation = service.getSessionLocation.bind(service);
    const failure = new Error('classification failed');
    vi.spyOn(service, 'getSessionLocation').mockImplementation((sessionId) =>
      sessionId === failedId ? Promise.reject(failure) : getLocation(sessionId),
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
    const originalGetLocation = service.getSessionLocation.bind(service);
    let classifications = 0;
    vi.spyOn(service, 'getSessionLocation').mockImplementation(async (id) => {
      classifications++;
      if (classifications === 2) {
        fs.mkdirSync(path.dirname(sessionPath(workspaceDir, id, 'archived')), {
          recursive: true,
        });
        fs.renameSync(
          sessionPath(workspaceDir, id, 'active'),
          sessionPath(workspaceDir, id, 'archived'),
        );
      }
      return originalGetLocation(id);
    });

    const result = await archiveDaemonSessions({
      sessionIds: [sessionId],
      service,
      bridge: { closeSession: vi.fn().mockResolvedValue(undefined) },
      coordinator: new SessionArchiveCoordinator(),
    });

    expect(result).toEqual({
      archived: [],
      alreadyArchived: [sessionId],
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
    const getLocation = service.getSessionLocation.bind(service);
    const failure = new Error('classification failed');
    vi.spyOn(service, 'getSessionLocation').mockImplementation((sessionId) =>
      sessionId === failedId ? Promise.reject(failure) : getLocation(sessionId),
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
    const getLocation = service.getSessionLocation.bind(service);
    const coordinator = new SessionArchiveCoordinator();
    let releaseBlocked!: () => void;
    const blocked = new Promise<void>((resolve) => {
      releaseBlocked = resolve;
    });
    let competingMaintenance: Promise<void> | undefined;
    vi.spyOn(service, 'getSessionLocation').mockImplementation((sessionId) => {
      if (sessionId === unarchivedId && !competingMaintenance) {
        competingMaintenance = coordinator.runExclusiveMany(
          [blockedId],
          () => blocked,
        );
      }
      return getLocation(sessionId);
    });

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
      bridge: { closeSession: vi.fn().mockResolvedValue(undefined) },
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
        bridge: { closeSession: vi.fn().mockResolvedValue(undefined) },
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
