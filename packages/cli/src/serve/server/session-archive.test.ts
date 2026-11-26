/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SessionIdCaseConflictError,
  SessionService,
  SessionStorageEntryError,
  SessionWriterConflictError,
  SessionWriterLostError,
  GitWorktreeService,
  readWorktreeSnapshotMeta,
  restoreWorktreeSnapshot,
  type SessionWriterLease,
  Storage,
  getCronFilePath,
  getSessionWriterLockPath,
  readSessionPrs,
  readCronTasks,
  updateCronTasks,
  writeSessionPrs,
} from '@qwen-code/qwen-code-core';
import { openManagedSession } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import {
  danglingInFlightPromptIds,
  readPromptLedgerRecords,
} from '@qwen-code/acp-bridge/promptLedger';
import {
  BridgeTimeoutError,
  SessionArchivedError,
  SessionArchivingError,
  SessionConflictError,
  SessionNotArchivedError,
  SessionNotFoundError,
  SessionBusyError,
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
import { expectWithinLatencyBudget } from '../../test-utils/latency-budget.js';
import {
  makeRetainedSession,
  makeRetentionRepo,
  type RetentionTestRuntime,
} from '../../test-utils/worktree-session-retention-fixtures.js';
import {
  acquireWorktreeCleanupLock,
  executeWorktreeCleanup,
  preclassifyWorktreeCleanup,
  verifyWorktreeCleanupOwnership,
} from './worktree-orphan-cleanup.js';
import * as worktreeOwnership from './worktree-ownership-op.js';
import { restoreWorktreeFromSessionSnapshot } from './session-worktree-restore.js';
import { moveWorktreeSnapshotsWithSession } from './worktree-snapshot-pairs.js';
import {
  buildWorktreeSnapshotMeta,
  captureWorktreeSnapshot,
  readWorktreeSessionStrict,
  selectWorktreeSnapshot,
  writeWorktreeSession,
} from '@qwen-code/qwen-code-core';

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

  it('keeps a busy session active when idle is required', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440102';
    writeSessionFile(workspaceDir, sessionId, 'active');
    const service = new SessionService(workspaceDir);
    const closeSession = vi
      .fn()
      .mockRejectedValue(new SessionBusyError(sessionId));

    const result = await archiveDaemonSessions({
      sessionIds: [sessionId],
      service,
      bridge: { closeSession },
      coordinator: new SessionArchiveCoordinator(),
      requireIdle: true,
    });

    expect(result.archived).toEqual([]);
    expect(result.errors).toEqual([
      { sessionId, error: expect.any(SessionBusyError) },
    ]);
    expect(closeSession).toHaveBeenCalledWith(sessionId, undefined, {
      requireAgentClose: true,
      requireIdle: true,
    });
    expect(fs.existsSync(sessionPath(workspaceDir, sessionId, 'active'))).toBe(
      true,
    );
  });

  it('keeps a closing session active instead of bypassing the idle guard', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440103';
    writeSessionFile(workspaceDir, sessionId, 'active');
    const service = new SessionService(workspaceDir);
    const closingError = new SessionNotFoundError(
      sessionId,
      'The session is already closing',
      'session_closing',
    );

    const result = await archiveDaemonSessions({
      sessionIds: [sessionId],
      service,
      bridge: { closeSession: vi.fn().mockRejectedValue(closingError) },
      coordinator: new SessionArchiveCoordinator(),
      requireIdle: true,
    });

    expect(result.archived).toEqual([]);
    expect(result.errors).toEqual([{ sessionId, error: closingError }]);
    expect(fs.existsSync(sessionPath(workspaceDir, sessionId, 'active'))).toBe(
      true,
    );
  });

  it('archives a sealed Managed session through the sealed-writer fallback', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440202';
    const transcriptPath = path.join(
      new Storage(workspaceDir, runtimeDir).getProjectDir(),
      'chats',
      `${sessionId}.jsonl`,
    );
    fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
    const session = await openManagedSession({
      runtimeBaseDir: runtimeDir,
      sessionId,
      transcriptPath,
      sessionKey: {
        tenantId: 't1',
        workspaceId: 'w1',
        sessionId,
      },
      cwd: workspaceDir,
      version: 'test',
      workerId: 'archive-test',
      activationLeaseDurationMs: 60_000,
      create: {
        definitionRef: {
          resourceId: 'def-1',
          kind: 'managed-definition',
          schemaVersion: 1,
          byteLength: 2,
          digest: 'a'.repeat(64),
        },
        rootSnapshotRef: {
          resourceId: 'root-1',
          kind: 'managed-root',
          schemaVersion: 1,
          byteLength: 2,
          digest: 'b'.repeat(64),
        },
        createdBy: 'test',
      },
    });
    // Sealed schema-3 lock: a legacy maintenance lease cannot take it, so the
    // route only works when the sealed-Managed fallback arm runs first.
    await session.close();

    const service = new SessionService(workspaceDir);
    await expect(
      service.getMaintainableSessionLocation(sessionId),
    ).resolves.toBe('active');

    const lockPath = getSessionWriterLockPath(runtimeDir, sessionId);
    const lockBefore = fs.readFileSync(lockPath);

    const result = await archiveDaemonSessions({
      sessionIds: [sessionId],
      service,
      bridge: { closeSession: vi.fn().mockResolvedValue(undefined) },
      coordinator: new SessionArchiveCoordinator(),
    });

    // With the sealed-Managed arm removed the route reports mutationApplied:
    // false for exactly the sessions the design requires to succeed.
    expect(result.errors).toEqual([]);
    expect(result).toEqual({
      archived: [sessionId],
      alreadyArchived: [],
      resolvedConflicts: [],
      notFound: [],
      errors: [],
    });
    expect(
      fs.existsSync(sessionPath(workspaceDir, sessionId, 'archived')),
    ).toBe(true);
    expect(fs.readFileSync(lockPath)).toEqual(lockBefore);
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

  it('acquires a writer lease for already archived ids but not missing ids', async () => {
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
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(closeSession).toHaveBeenCalledTimes(2);
  });

  it('reconciles stranded sidecars before returning already archived', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440103';
    writeSessionFile(workspaceDir, sessionId, 'archived');
    fs.writeFileSync(sessionPath(workspaceDir, sessionId, 'archived'), '');
    const service = new SessionService(workspaceDir);
    const sidecars = await writeLifecycleSidecars(service, sessionId, 'active');

    const result = await archiveDaemonSessions({
      sessionIds: [sessionId],
      service,
      bridge: { closeSession: vi.fn().mockResolvedValue(undefined) },
      coordinator: new SessionArchiveCoordinator(),
    });

    expect(result).toMatchObject({
      alreadyArchived: [sessionId],
      errors: [],
    });
    await expectLifecycleSidecarsMoved(sidecars, 'archived');
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
        expectWithinLatencyBudget(Date.now() - startedAt, 400);
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

  it('deduplicates ids and locks already active ids for reconciliation', async () => {
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
    expect(acquire).toHaveBeenCalledTimes(2);
    expect(fs.existsSync(sessionPath(workspaceDir, archivedId, 'active'))).toBe(
      true,
    );
    expect(
      fs.existsSync(sessionPath(workspaceDir, archivedId, 'archived')),
    ).toBe(false);
  });

  it('reconciles stranded sidecars before returning already active', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440113';
    writeSessionFile(workspaceDir, sessionId, 'active');
    fs.writeFileSync(
      sessionPath(workspaceDir, sessionId, 'active'),
      '{"uuid":"torn-head"',
    );
    const service = new SessionService(workspaceDir);
    const sidecars = await writeLifecycleSidecars(
      service,
      sessionId,
      'archived',
    );

    const result = await unarchiveDaemonSessions({
      sessionIds: [sessionId],
      service,
      coordinator: new SessionArchiveCoordinator(),
    });

    expect(result).toMatchObject({
      alreadyActive: [sessionId],
      errors: [],
    });
    await expectLifecycleSidecarsMoved(sidecars, 'active');
  });

  it('keeps archived ledger records before newer active records during reconciliation', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440114';
    writeSessionFile(workspaceDir, sessionId, 'active');
    const service = new SessionService(workspaceDir);
    const activeLedger = service.getPromptLedgerPath(sessionId);
    const archivedPr = service.getPrSessionPathForArchiveState(
      sessionId,
      'archived',
    );
    const archivedLedger = path.join(
      path.dirname(archivedPr),
      `${sessionId}.ledger.jsonl`,
    );
    fs.mkdirSync(path.dirname(activeLedger), { recursive: true });
    fs.mkdirSync(path.dirname(archivedLedger), { recursive: true });
    fs.writeFileSync(
      archivedLedger,
      '{"v":1,"promptId":"p1","state":"in_flight","at":1}\n',
    );
    fs.writeFileSync(
      activeLedger,
      '{"v":1,"promptId":"p1","terminal":"completed","at":2}\n',
    );

    const result = await unarchiveDaemonSessions({
      sessionIds: [sessionId],
      service,
      coordinator: new SessionArchiveCoordinator(),
    });

    expect(result).toMatchObject({
      alreadyActive: [sessionId],
      errors: [],
    });
    const records = readPromptLedgerRecords(activeLedger);
    expect(records.map((record) => record.at)).toEqual([1, 2]);
    expect(danglingInFlightPromptIds(records)).toEqual([]);
    expect(fs.existsSync(archivedLedger)).toBe(false);
  });

  it('preserves both ledger halves when reconciliation cannot commit the merge', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440115';
    writeSessionFile(workspaceDir, sessionId, 'active');
    const warnings: string[] = [];
    const service = new SessionService(workspaceDir, {
      onWarning: (message) => warnings.push(message),
    });
    const activeLedger = service.getPromptLedgerPath(sessionId);
    const archivedPr = service.getPrSessionPathForArchiveState(
      sessionId,
      'archived',
    );
    const archivedLedger = path.join(
      path.dirname(archivedPr),
      `${sessionId}.ledger.jsonl`,
    );
    const activeContents =
      '{"v":1,"promptId":"p1","terminal":"completed","at":2}\n';
    fs.mkdirSync(path.dirname(activeLedger), { recursive: true });
    fs.mkdirSync(path.dirname(archivedLedger), { recursive: true });
    fs.writeFileSync(
      archivedLedger,
      '{"v":1,"promptId":"p1","state":"in_flight","at":1}\n',
    );
    fs.writeFileSync(activeLedger, activeContents, { mode: 0o600 });

    const writeFileSync = fs.writeFileSync.bind(fs);
    const writeSpy = vi
      .spyOn(fs, 'writeFileSync')
      .mockImplementation((file, data, options) => {
        const filePath = file.toString();
        if (
          filePath === activeLedger ||
          (filePath.startsWith(`${activeLedger}.`) && filePath.endsWith('.tmp'))
        ) {
          writeFileSync(file, String(data).slice(0, 32), options);
          const error = new Error('ENOSPC: injected ledger write failure');
          (error as NodeJS.ErrnoException).code = 'ENOSPC';
          throw error;
        }
        return writeFileSync(file, data, options);
      });
    syncBuiltinESMExports();

    let result: Awaited<ReturnType<typeof unarchiveDaemonSessions>>;
    try {
      result = await unarchiveDaemonSessions({
        sessionIds: [sessionId],
        service,
        coordinator: new SessionArchiveCoordinator(),
      });
    } finally {
      writeSpy.mockRestore();
      syncBuiltinESMExports();
    }

    expect(result).toMatchObject({
      alreadyActive: [sessionId],
      errors: [],
    });
    expect(fs.readFileSync(activeLedger, 'utf8')).toBe(activeContents);
    expect(fs.existsSync(archivedLedger)).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('failed to move prompt ledger');
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
    const deleteSessionAttachments = vi.fn().mockResolvedValue(undefined);

    await expect(
      deleteDaemonSessionIfOrphan({
        sessionId,
        service,
        bridge: {
          killSession: vi.fn().mockResolvedValue(false),
          getSessionSummary: vi.fn(() => ({
            sessionId,
            workspaceCwd: workspaceDir,
            createdAt: new Date().toISOString(),
            clientCount: 1,
            hasActivePrompt: false,
          })),
          markSessionCatalogChanged: vi.fn(),
          deleteSessionAttachments,
        },
        coordinator: new SessionArchiveCoordinator(),
      }),
    ).resolves.toBe(false);
    expect(acquire).not.toHaveBeenCalled();
    expect(deleteSessionAttachments).not.toHaveBeenCalled();
    expect(fs.existsSync(sessionPath(workspaceDir, sessionId, 'active'))).toBe(
      true,
    );
  });

  it('deletes a persisted orphan when the live session is already gone', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440087';
    writeSessionFile(workspaceDir, sessionId, 'active');
    const service = new SessionService(workspaceDir);
    const markSessionCatalogChanged = vi.fn();
    const deleteSessionAttachments = vi.fn().mockResolvedValue(undefined);

    await expect(
      deleteDaemonSessionIfOrphan({
        sessionId,
        service,
        bridge: {
          killSession: vi.fn().mockResolvedValue(false),
          getSessionSummary: vi.fn(() => {
            throw new SessionNotFoundError(sessionId);
          }),
          markSessionCatalogChanged,
          deleteSessionAttachments,
        },
        coordinator: new SessionArchiveCoordinator(),
      }),
    ).resolves.toBe(true);
    expect(fs.existsSync(sessionPath(workspaceDir, sessionId, 'active'))).toBe(
      false,
    );
    expect(markSessionCatalogChanged).toHaveBeenCalledTimes(1);
    expect(deleteSessionAttachments).toHaveBeenCalledWith(sessionId);
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
    const deleteSessionAttachments = vi.fn().mockResolvedValue(undefined);

    await expect(
      deleteDaemonSessionIfOrphan({
        sessionId,
        service,
        bridge: {
          killSession: vi.fn().mockResolvedValue(true),
          getSessionSummary: vi.fn(),
          markSessionCatalogChanged,
          deleteSessionAttachments,
        },
        coordinator: new SessionArchiveCoordinator(),
      }),
    ).resolves.toBe(true);
    expect(fs.existsSync(sessionPath(workspaceDir, sessionId, 'active'))).toBe(
      false,
    );
    expect(markSessionCatalogChanged).toHaveBeenCalledTimes(1);
    // The reaped orphan is never looked up again; its attachment bytes must
    // go with the persisted row.
    expect(deleteSessionAttachments).toHaveBeenCalledTimes(1);
    expect(deleteSessionAttachments).toHaveBeenCalledWith(sessionId);
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
          getSessionSummary: vi.fn(),
          markSessionCatalogChanged,
          deleteSessionAttachments: vi.fn().mockResolvedValue(undefined),
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
          getSessionSummary: vi.fn(),
          markSessionCatalogChanged,
          deleteSessionAttachments: vi.fn().mockResolvedValue(undefined),
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
          getSessionSummary: vi.fn(),
          markSessionCatalogChanged: vi.fn(),
          deleteSessionAttachments: vi.fn().mockResolvedValue(undefined),
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

describe('deleteDaemonSessions worktree cleanup', () => {
  let runtimeDir: string;
  let workspaceDir: string;
  let stderr: ReturnType<typeof spyOnStderr>;

  function spyOnStderr() {
    return vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  }

  beforeEach(() => {
    runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-archive-test-'));
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-workspace-'));
    Storage.setRuntimeBaseDir(runtimeDir);
    stderr = spyOnStderr();
    initGitRepo(workspaceDir);
  });

  afterEach(() => {
    Storage.setRuntimeBaseDir(null);
    fs.rmSync(runtimeDir, { recursive: true, force: true });
    fs.rmSync(workspaceDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const cleanupBridge = (liveSessionIds: string[] = []) => ({
    closeSession: vi.fn().mockResolvedValue(undefined),
    deleteSessionAttachments: vi.fn().mockResolvedValue(undefined),
    getSessionSummary: vi.fn((id: string) => {
      if (liveSessionIds.includes(id)) return {} as never;
      throw new SessionNotFoundError(id);
    }),
  });

  function setupWorktreeSession(
    sessionId: string,
    options: {
      record?: boolean;
      sidecarOverrides?: Record<string, unknown>;
      markerSessionId?: string;
    } = {},
  ): { service: SessionService; slug: string; worktreePath: string } {
    const slug = `task-${sessionId.slice(-4)}`;
    const worktreePath = gitAddWorktree(workspaceDir, slug);
    if (options.record !== false) {
      writeSessionFile(workspaceDir, sessionId, 'active');
    }
    const service = new SessionService(workspaceDir);
    const sidecarPath = service.getWorktreeSessionPath(sessionId);
    fs.mkdirSync(path.dirname(sidecarPath), { recursive: true });
    fs.writeFileSync(
      sidecarPath,
      JSON.stringify({
        slug,
        worktreePath,
        worktreeBranch: `worktree-${slug}`,
        originalCwd: workspaceDir,
        workspaceCwd: workspaceDir,
        originalBranch: 'main',
        originalHeadCommit: execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: workspaceDir,
          encoding: 'utf8',
        }).trim(),
        ...options.sidecarOverrides,
      }),
    );
    writeWorktreeMarker(worktreePath, options.markerSessionId ?? sessionId);
    return { service, slug, worktreePath };
  }

  function warnings(): string {
    return stderr.mock.calls.map((call) => String(call[0])).join('');
  }

  // P6 U3: pin the archive-and-delete arm, then prove the actual user bytes
  // are readable from that archive — surviving the checkout cannot satisfy it.
  async function expectWorkArchived(
    service: SessionService,
    sessionId: string,
    worktreePath: string,
    relativeFile: string,
    expected: string,
    archiveState: 'active' | 'archived' = 'active',
  ): Promise<void> {
    expect(fs.existsSync(worktreePath)).toBe(false);
    const dir = path.dirname(
      service.getWorktreeSessionPathForArchiveState(sessionId, archiveState),
    );
    const archive = fs
      .readdirSync(dir)
      .find(
        (name) =>
          name.startsWith(`${sessionId}.`) &&
          name.endsWith('.worktree-snapshot.tar.gz'),
      );
    expect(archive).toBeDefined();
    const base = archive!.replace(/\.tar\.gz$/, '.json');
    const meta = await readWorktreeSnapshotMeta(path.join(dir, base));
    const restored = fs.mkdtempSync(
      path.join(os.tmpdir(), 'qwen-work-archive-restore-'),
    );
    try {
      await restoreWorktreeSnapshot(path.join(dir, archive!), restored, meta);
      expect(fs.readFileSync(path.join(restored, relativeFile), 'utf8')).toBe(
        expected,
      );
    } finally {
      fs.rmSync(restored, { recursive: true, force: true });
    }
  }

  it('removes the owned checkout and branch on a confirmed delete', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440090';
    const { service, slug, worktreePath } = setupWorktreeSession(sessionId);

    const result = await deleteDaemonSessions({
      sessionIds: [sessionId],
      service,
      bridge: cleanupBridge(),
      coordinator: new SessionArchiveCoordinator(),
    });

    expect(result.removed).toEqual([sessionId]);
    expect(fs.existsSync(worktreePath)).toBe(false);
    expect(branchExists(workspaceDir, `worktree-${slug}`)).toBe(false);
    expect(
      execFileSync('git', ['worktree', 'list', '--porcelain'], {
        cwd: workspaceDir,
        encoding: 'utf8',
      }),
    ).not.toContain(worktreePath);
  });

  it('preserves a checkout referenced by another archived session', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-4466554400bd';
    const siblingId = '550e8400-e29b-41d4-a716-4466554400be';
    const { service, worktreePath } = setupWorktreeSession(sessionId);
    writeSessionFile(workspaceDir, siblingId, 'archived');
    fs.copyFileSync(
      service.getWorktreeSessionPath(sessionId),
      service.getWorktreeSessionPathForArchiveState(siblingId, 'archived'),
    );

    const result = await deleteDaemonSessions({
      sessionIds: [sessionId],
      service,
      bridge: cleanupBridge(),
      coordinator: new SessionArchiveCoordinator(),
    });
    expect(result.removed).toEqual([sessionId]);
    expect(fs.existsSync(worktreePath)).toBe(true);
    expect(warnings()).toContain('checkout shared with');
  });

  it('preserves the synchronous coordinator prefix for delete without a sidecar', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440088';
    writeSessionFile(workspaceDir, sessionId, 'active');
    const service = new SessionService(workspaceDir);
    const coordinator = new SessionArchiveCoordinator();

    const pending = deleteDaemonSessions({
      sessionIds: [sessionId],
      service,
      bridge: cleanupBridge(),
      coordinator,
    });

    expect(() => coordinator.assertNotTransitioning(sessionId)).toThrow(
      SessionArchivingError,
    );
    await expect(pending).resolves.toMatchObject({ removed: [sessionId] });
  });

  it('preserves the synchronous coordinator prefix for archive without a sidecar', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440090';
    writeSessionFile(workspaceDir, sessionId, 'active');
    const coordinator = new SessionArchiveCoordinator();

    const pending = archiveDaemonSessions({
      sessionIds: [sessionId],
      service: new SessionService(workspaceDir),
      bridge: cleanupBridge(),
      coordinator,
    });

    expect(() => coordinator.assertNotTransitioning(sessionId)).toThrow(
      SessionArchivingError,
    );
    await expect(pending).resolves.toMatchObject({ archived: [sessionId] });
  });

  it('preserves the synchronous coordinator prefix for unarchive without a sidecar', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440091';
    writeSessionFile(workspaceDir, sessionId, 'archived');
    const coordinator = new SessionArchiveCoordinator();

    const pending = unarchiveDaemonSessions({
      sessionIds: [sessionId],
      service: new SessionService(workspaceDir),
      coordinator,
    });

    expect(() => coordinator.assertNotTransitioning(sessionId)).toThrow(
      SessionArchivingError,
    );
    await expect(pending).resolves.toMatchObject({ unarchived: [sessionId] });
  });

  it('keeps worktree content and binding across archive and unarchive', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440089';
    const { service, worktreePath } = setupWorktreeSession(sessionId);
    fs.writeFileSync(path.join(worktreePath, 'file.txt'), 'archive-me\n');
    fs.writeFileSync(path.join(worktreePath, 'draft.txt'), 'not-in-head\n');
    const coordinator = new SessionArchiveCoordinator();
    const archivedSidecar = service.getWorktreeSessionPathForArchiveState(
      sessionId,
      'archived',
    );

    const archived = await archiveDaemonSessions({
      sessionIds: [sessionId],
      service,
      bridge: cleanupBridge(),
      coordinator,
    });

    expect(archived.archived).toEqual([sessionId]);
    expect(fs.existsSync(archivedSidecar)).toBe(true);
    expect(fs.statSync(worktreePath).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(worktreePath, 'file.txt'), 'utf8')).toBe(
      'archive-me\n',
    );
    expect(fs.readFileSync(path.join(worktreePath, 'draft.txt'), 'utf8')).toBe(
      'not-in-head\n',
    );
    expect(
      fs
        .readdirSync(path.dirname(archivedSidecar))
        .filter((name) => name.endsWith('.worktree-snapshot.tar.gz')),
    ).toEqual([]);
    expect(
      fs
        .readdirSync(path.dirname(service.getWorktreeSessionPath(sessionId)))
        .filter((name) => name.endsWith('.worktree-snapshot.tar.gz')),
    ).toEqual([]);

    const unarchived = await unarchiveDaemonSessions({
      sessionIds: [sessionId],
      service,
      coordinator,
    });

    expect(unarchived.unarchived).toEqual([sessionId]);
    expect(fs.existsSync(archivedSidecar)).toBe(false);
    const activeSidecar = service.getWorktreeSessionPath(sessionId);
    expect(fs.existsSync(activeSidecar)).toBe(true);
    expect(JSON.parse(fs.readFileSync(activeSidecar, 'utf8'))).toMatchObject({
      worktreePath,
    });
    expect(fs.readFileSync(path.join(worktreePath, 'draft.txt'), 'utf8')).toBe(
      'not-in-head\n',
    );
  });

  it('snapshots dirty content when deleting an already archived chat', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440094';
    const { service, worktreePath } = setupWorktreeSession(sessionId);
    const coordinator = new SessionArchiveCoordinator();
    fs.writeFileSync(path.join(worktreePath, 'file.txt'), 'archived-tracked\n');
    fs.writeFileSync(path.join(worktreePath, 'draft.txt'), 'archived-draft\n');

    const archived = await archiveDaemonSessions({
      sessionIds: [sessionId],
      service,
      bridge: cleanupBridge(),
      coordinator,
    });

    expect(archived.archived).toEqual([sessionId]);
    expect(fs.statSync(worktreePath).isDirectory()).toBe(true);
    const archivedSidecar = service.getWorktreeSessionPathForArchiveState(
      sessionId,
      'archived',
    );
    expect(fs.existsSync(archivedSidecar)).toBe(true);
    expect(
      fs
        .readdirSync(path.dirname(archivedSidecar))
        .filter((name) => name.endsWith('.worktree-snapshot.tar.gz')),
    ).toEqual([]);
    expect(
      fs
        .readdirSync(path.dirname(service.getWorktreeSessionPath(sessionId)))
        .filter((name) => name.endsWith('.worktree-snapshot.tar.gz')),
    ).toEqual([]);

    const removed = await deleteDaemonSessions({
      sessionIds: [sessionId],
      service,
      bridge: cleanupBridge(),
      coordinator,
    });

    expect(removed.removed).toEqual([sessionId]);
    await expectWorkArchived(
      service,
      sessionId,
      worktreePath,
      'file.txt',
      'archived-tracked\n',
      'archived',
    );
    await expectWorkArchived(
      service,
      sessionId,
      worktreePath,
      'draft.txt',
      'archived-draft\n',
      'archived',
    );
    const archiveFile = fs
      .readdirSync(path.dirname(archivedSidecar))
      .find((name) => name.endsWith('.worktree-snapshot.tar.gz'));
    expect(archiveFile).toBeDefined();
    const archiveMeta = await readWorktreeSnapshotMeta(
      path.join(
        path.dirname(archivedSidecar),
        archiveFile!.replace(/\.tar\.gz$/, '.json'),
      ),
    );
    expect(archiveMeta.dirty).toEqual({
      tracked: 1,
      untracked: 1,
      deleted: [],
    });
  });

  it('keeps the checkout when the session record was never there', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440091';
    const { service, worktreePath } = setupWorktreeSession(sessionId, {
      record: false,
    });

    const result = await deleteDaemonSessions({
      sessionIds: [sessionId],
      service,
      bridge: cleanupBridge(),
      coordinator: new SessionArchiveCoordinator(),
    });

    expect(result.notFound).toEqual([sessionId]);
    expect(fs.existsSync(worktreePath)).toBe(true);
  });

  it('skips a superseded sidecar silently', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440092';
    const { service, worktreePath } = setupWorktreeSession(sessionId, {
      sidecarOverrides: { supersededBy: 'replacement-session' },
    });

    const result = await deleteDaemonSessions({
      sessionIds: [sessionId],
      service,
      bridge: cleanupBridge(),
      coordinator: new SessionArchiveCoordinator(),
    });

    expect(result.removed).toEqual([sessionId]);
    expect(fs.existsSync(worktreePath)).toBe(true);
    expect(warnings()).not.toContain('worktree cleanup preserved checkout');
  });

  it('keeps a legacy tool worktree whose sidecar has no workspace', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440093';
    const { service, worktreePath } = setupWorktreeSession(sessionId, {
      sidecarOverrides: { workspaceCwd: undefined },
    });

    const result = await deleteDaemonSessions({
      sessionIds: [sessionId],
      service,
      bridge: cleanupBridge(),
      coordinator: new SessionArchiveCoordinator(),
    });

    expect(result.removed).toEqual([sessionId]);
    expect(fs.existsSync(worktreePath)).toBe(true);
  });

  it('keeps the checkout and warns on an unreadable sidecar', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440094';
    const { service, worktreePath } = setupWorktreeSession(sessionId);
    fs.writeFileSync(service.getWorktreeSessionPath(sessionId), '{bad');

    const result = await deleteDaemonSessions({
      sessionIds: [sessionId],
      service,
      bridge: cleanupBridge(),
      coordinator: new SessionArchiveCoordinator(),
    });

    expect(result.removed).toEqual([sessionId]);
    expect(fs.existsSync(worktreePath)).toBe(true);
    expect(warnings()).toContain('worktree cleanup preserved checkout');
  });

  it('keeps the checkout and warns when the marker names another session', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440095';
    const { service, worktreePath } = setupWorktreeSession(sessionId, {
      markerSessionId: 'someone-else',
    });

    const result = await deleteDaemonSessions({
      sessionIds: [sessionId],
      service,
      bridge: cleanupBridge(),
      coordinator: new SessionArchiveCoordinator(),
    });

    expect(result.removed).toEqual([sessionId]);
    expect(fs.existsSync(worktreePath)).toBe(true);
    expect(warnings()).toContain('marker names another session');
  });

  it('keeps the checkout and warns when the marker is missing', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440096';
    const { service, worktreePath } = setupWorktreeSession(sessionId);
    fs.rmSync(path.join(worktreePath, '.qwen-session'));

    const result = await deleteDaemonSessions({
      sessionIds: [sessionId],
      service,
      bridge: cleanupBridge(),
      coordinator: new SessionArchiveCoordinator(),
    });

    expect(result.removed).toEqual([sessionId]);
    expect(fs.existsSync(worktreePath)).toBe(true);
    expect(warnings()).toContain('marker missing');
  });

  it('keeps a checkout shared with another session', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440097';
    const otherId = '550e8400-e29b-41d4-a716-446655440098';
    const { service, worktreePath } = setupWorktreeSession(sessionId);
    // A second session's sidecar naming the same checkout (the shape a
    // freshly transferred replacement leaves during the heal window).
    const otherSidecarPath = service.getWorktreeSessionPath(otherId);
    fs.copyFileSync(
      service.getWorktreeSessionPath(sessionId),
      otherSidecarPath,
    );

    const result = await deleteDaemonSessions({
      sessionIds: [sessionId],
      service,
      bridge: cleanupBridge(),
      coordinator: new SessionArchiveCoordinator(),
    });

    expect(result.removed).toEqual([sessionId]);
    expect(fs.existsSync(worktreePath)).toBe(true);
    expect(warnings()).toContain('checkout shared with');
  });

  it('cleans a post-reset replacement next to its tombstone predecessor', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-4466554400a0';
    const oldId = '550e8400-e29b-41d4-a716-4466554400a1';
    // The replacement took the checkout in a worktree reset: its sidecar
    // carries `supersedes`, and the superseded session's tombstone
    // sidecar (supersededBy === replacement) still names the same path.
    const { service, slug, worktreePath } = setupWorktreeSession(sessionId, {
      sidecarOverrides: { supersedes: oldId },
    });
    const oldSidecarPath = service.getWorktreeSessionPath(oldId);
    const own = JSON.parse(
      fs.readFileSync(service.getWorktreeSessionPath(sessionId), 'utf8'),
    ) as Record<string, unknown>;
    delete own['supersedes'];
    fs.writeFileSync(
      oldSidecarPath,
      JSON.stringify({ ...own, supersededBy: sessionId }),
    );

    const result = await deleteDaemonSessions({
      sessionIds: [sessionId],
      service,
      bridge: cleanupBridge(),
      coordinator: new SessionArchiveCoordinator(),
    });

    expect(result.removed).toEqual([sessionId]);
    expect(fs.existsSync(worktreePath)).toBe(false);
    expect(branchExists(workspaceDir, `worktree-${slug}`)).toBe(false);
  });

  it('cleans a replacement whose checkout went through two resets', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-4466554400a4';
    const middleId = '550e8400-e29b-41d4-a716-4466554400a5';
    const firstId = '550e8400-e29b-41d4-a716-4466554400a6';
    // Two worktree resets, first → middle → this session. Each reset
    // rewrites only the pair it transfers between, so the first session's
    // tombstone still names the middle one.
    const { service, slug, worktreePath } = setupWorktreeSession(sessionId, {
      sidecarOverrides: { supersedes: middleId },
    });
    const own = JSON.parse(
      fs.readFileSync(service.getWorktreeSessionPath(sessionId), 'utf8'),
    ) as Record<string, unknown>;
    delete own['supersedes'];
    fs.writeFileSync(
      service.getWorktreeSessionPath(middleId),
      JSON.stringify({ ...own, supersedes: firstId, supersededBy: sessionId }),
    );
    fs.writeFileSync(
      service.getWorktreeSessionPath(firstId),
      JSON.stringify({ ...own, supersededBy: middleId }),
    );

    const result = await deleteDaemonSessions({
      sessionIds: [sessionId],
      service,
      bridge: cleanupBridge(),
      coordinator: new SessionArchiveCoordinator(),
    });

    expect(result.removed).toEqual([sessionId]);
    expect(warnings()).not.toContain('checkout shared with');
    expect(fs.existsSync(worktreePath)).toBe(false);
    expect(branchExists(workspaceDir, `worktree-${slug}`)).toBe(false);
  });

  it.each([
    { shape: 'three resets', deleteMiddle: false, resets: 3 },
    { shape: 'a deleted middle session', deleteMiddle: true, resets: 2 },
  ])(
    'cleans a replacement next to the tombstones of $shape',
    async ({ deleteMiddle, resets }) => {
      // Session ids in reset order; the last one is the current owner.
      const ids = [
        '550e8400-e29b-41d4-a716-4466554400a7',
        '550e8400-e29b-41d4-a716-4466554400a8',
        '550e8400-e29b-41d4-a716-4466554400a9',
        '550e8400-e29b-41d4-a716-4466554400aa',
      ].slice(0, resets + 1);
      const sessionId = ids[resets];
      const { service, slug, worktreePath } = setupWorktreeSession(sessionId, {
        sidecarOverrides: { supersedes: ids[resets - 1] },
      });
      const own = JSON.parse(
        fs.readFileSync(service.getWorktreeSessionPath(sessionId), 'utf8'),
      ) as Record<string, unknown>;
      delete own['supersedes'];
      for (let i = 0; i < resets; i++) {
        if (deleteMiddle && i === 1) continue;
        fs.writeFileSync(
          service.getWorktreeSessionPath(ids[i]),
          JSON.stringify({
            ...own,
            ...(i > 0 ? { supersedes: ids[i - 1] } : {}),
            supersededBy: ids[i + 1],
          }),
        );
      }

      const result = await deleteDaemonSessions({
        sessionIds: [sessionId],
        service,
        bridge: cleanupBridge(),
        coordinator: new SessionArchiveCoordinator(),
      });

      expect(result.removed).toEqual([sessionId]);
      expect(warnings()).not.toContain('checkout shared with');
      expect(fs.existsSync(worktreePath)).toBe(false);
      expect(branchExists(workspaceDir, `worktree-${slug}`)).toBe(false);
    },
  );

  // Two resets, first -> middle -> this session: the middle session is the
  // direct predecessor, the first one an older tombstone.
  function setupTwoResetChain(
    ids: { sessionId: string; middleId: string; firstId: string },
    options: { upperCaseFirst?: boolean } = {},
  ) {
    const setup = setupWorktreeSession(ids.sessionId, {
      sidecarOverrides: { supersedes: ids.middleId },
    });
    const own = JSON.parse(
      fs.readFileSync(
        setup.service.getWorktreeSessionPath(ids.sessionId),
        'utf8',
      ),
    ) as Record<string, unknown>;
    delete own['supersedes'];
    const firstPath = setup.service.getWorktreeSessionPath(ids.firstId);
    fs.writeFileSync(
      options.upperCaseFirst
        ? path.join(
            path.dirname(firstPath),
            `${ids.firstId.toUpperCase()}.worktree.json`,
          )
        : firstPath,
      JSON.stringify({ ...own, supersededBy: ids.middleId }),
    );
    fs.writeFileSync(
      setup.service.getWorktreeSessionPath(ids.middleId),
      JSON.stringify({
        ...own,
        supersedes: ids.firstId,
        supersededBy: ids.sessionId,
      }),
    );
    return setup;
  }

  type LivenessBridge = {
    getSessionSummary?: ReturnType<typeof vi.fn>;
  };
  it.each<{ answer: string; bridge: (firstId: string) => LivenessBridge }>([
    {
      answer: 'reports it',
      bridge: (firstId) => ({
        getSessionSummary: vi.fn((id: string) => {
          if (id === firstId) return {} as never;
          throw new SessionNotFoundError(id);
        }),
      }),
    },
    {
      answer: 'says it is closing',
      bridge: () => ({
        getSessionSummary: vi.fn((id: string) => {
          throw new SessionNotFoundError(
            id,
            'The session is already closing',
            'session_closing',
          );
        }),
      }),
    },
    {
      answer: 'fails unexpectedly',
      bridge: () => ({
        getSessionSummary: vi.fn(() => {
          throw new Error('bridge unavailable');
        }),
      }),
    },
    {
      answer: 'cannot be asked',
      bridge: () => ({ getSessionSummary: undefined }),
    },
  ])(
    'keeps a checkout next to an older tombstone whose session the bridge $answer',
    async ({ bridge }) => {
      const ids = {
        sessionId: '550e8400-e29b-41d4-a716-4466554400ad',
        middleId: '550e8400-e29b-41d4-a716-4466554400ae',
        firstId: '550e8400-e29b-41d4-a716-4466554400af',
      };
      const { service, worktreePath } = setupTwoResetChain(ids);

      // A reset whose sever did not finish leaves the superseded session
      // running; only a genuine not-found shows it is gone.
      const result = await deleteDaemonSessions({
        sessionIds: [ids.sessionId],
        service,
        bridge: { ...cleanupBridge(), ...bridge(ids.firstId) },
        coordinator: new SessionArchiveCoordinator(),
      });

      expect(result.removed).toEqual([ids.sessionId]);
      expect(fs.existsSync(worktreePath)).toBe(true);
      expect(warnings()).toMatch(/superseded session \S+ is still live/);
    },
  );

  it('finds an older tombstone live whatever the case of its sidecar name', async () => {
    const ids = {
      sessionId: '550e8400-e29b-41d4-a716-44665544a0d0',
      middleId: '550e8400-e29b-41d4-a716-44665544a0d1',
      firstId: '550e8400-e29b-41d4-a716-44665544a0d5',
    };
    const { service, worktreePath } = setupTwoResetChain(ids, {
      upperCaseFirst: true,
    });

    const result = await deleteDaemonSessions({
      sessionIds: [ids.sessionId],
      service,
      bridge: cleanupBridge([ids.firstId]),
      coordinator: new SessionArchiveCoordinator(),
    });

    expect(result.removed).toEqual([ids.sessionId]);
    expect(fs.existsSync(worktreePath)).toBe(true);
    expect(warnings()).toContain('is still live');
  });

  it('preserves the checkout when only the owner was archived and an older predecessor is live', async () => {
    const ids = {
      sessionId: '550e8400-e29b-41d4-a716-44665544a0ea',
      middleId: '550e8400-e29b-41d4-a716-44665544a0eb',
      firstId: '550e8400-e29b-41d4-a716-44665544a0ec',
    };
    const { service, worktreePath } = setupTwoResetChain(ids);
    expect(await service.archiveSessions([ids.sessionId])).toMatchObject({
      archived: [ids.sessionId],
    });

    const result = await deleteDaemonSessions({
      sessionIds: [ids.sessionId],
      service,
      bridge: cleanupBridge([ids.firstId]),
      coordinator: new SessionArchiveCoordinator(),
    });

    expect(result.removed).toEqual([ids.sessionId]);
    expect(fs.existsSync(worktreePath)).toBe(true);
    expect(warnings()).toContain(
      `superseded session ${ids.firstId} is still live`,
    );
  });

  it.each(['archive', 'unarchive'] as const)(
    'serializes %s of an older predecessor with checkout cleanup',
    async (action) => {
      const ids = {
        sessionId: '550e8400-e29b-41d4-a716-4466554400e0',
        middleId: '550e8400-e29b-41d4-a716-4466554400e1',
        firstId: '550e8400-e29b-41d4-a716-4466554400e2',
      };
      const { service } = setupTwoResetChain(ids);
      writeSessionFile(workspaceDir, ids.firstId, 'active');
      const from = action === 'archive' ? 'active' : 'archived';
      const to = action === 'archive' ? 'archived' : 'active';
      if (from === 'archived') {
        expect(await service.archiveSessions([ids.firstId])).toMatchObject({
          archived: [ids.firstId],
        });
      }
      const plan = await preclassifyWorktreeCleanup(service, ids.sessionId);
      expect(plan).toBeDefined();
      const release = await acquireWorktreeCleanupLock(plan!);
      const acquire = vi.spyOn(worktreeOwnership, 'acquireWorktreeOwnershipOp');
      const params = {
        sessionIds: [ids.firstId],
        service,
        coordinator: new SessionArchiveCoordinator(),
        bridge: cleanupBridge(),
      };
      const move =
        action === 'archive'
          ? archiveDaemonSessions(params)
          : unarchiveDaemonSessions(params);
      try {
        await expect.poll(() => acquire.mock.calls.length).toBe(1);
        expect(acquire).toHaveBeenCalledWith(plan!.lockKey);
        expect(
          fs.existsSync(
            service.getWorktreeSessionPathForArchiveState(ids.firstId, from),
          ),
        ).toBe(true);
        await expect(
          verifyWorktreeCleanupOwnership(plan!, (id) => id === ids.middleId),
        ).resolves.toEqual({
          ok: false,
          reason: `superseded session ${ids.middleId} is still live`,
        });
      } finally {
        release();
        await move;
        acquire.mockRestore();
      }
      expect(await move).toMatchObject({
        [to === 'archived' ? 'archived' : 'unarchived']: [ids.firstId],
        errors: [],
      });
      expect(
        fs.existsSync(
          service.getWorktreeSessionPathForArchiveState(ids.firstId, to),
        ),
      ).toBe(true);
    },
  );

  it('keeps a checkout while its direct predecessor is live behind older tombstones', async () => {
    const ids = {
      sessionId: '550e8400-e29b-41d4-a716-44665544a0d6',
      middleId: '550e8400-e29b-41d4-a716-44665544a0d7',
      firstId: '550e8400-e29b-41d4-a716-44665544a0d8',
    };
    const { service, worktreePath } = setupTwoResetChain(ids);

    // The second reset's sever did not finish: the middle session still
    // runs, possibly in the checkout.
    const result = await deleteDaemonSessions({
      sessionIds: [ids.sessionId],
      service,
      bridge: cleanupBridge([ids.middleId]),
      coordinator: new SessionArchiveCoordinator(),
    });

    expect(result.removed).toEqual([ids.sessionId]);
    expect(fs.existsSync(worktreePath)).toBe(true);
    expect(warnings()).toContain(
      `superseded session ${ids.middleId} is still live`,
    );
  });

  it('still cleans next to a live direct predecessor after one reset', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-44665544a0d9';
    const oldId = '550e8400-e29b-41d4-a716-44665544a0da';
    const { service, slug, worktreePath } = setupWorktreeSession(sessionId, {
      sidecarOverrides: { supersedes: oldId },
    });
    const own = JSON.parse(
      fs.readFileSync(service.getWorktreeSessionPath(sessionId), 'utf8'),
    ) as Record<string, unknown>;
    delete own['supersedes'];
    fs.writeFileSync(
      service.getWorktreeSessionPath(oldId),
      JSON.stringify({ ...own, supersededBy: sessionId }),
    );

    // The bridge may have reopened the predecessor at the workspace root
    // (keepalive, ACP load); the one-reset rule discounts it regardless.
    const result = await deleteDaemonSessions({
      sessionIds: [sessionId],
      service,
      bridge: cleanupBridge([oldId]),
      coordinator: new SessionArchiveCoordinator(),
    });

    expect(result.removed).toEqual([sessionId]);
    expect(warnings()).not.toContain('still live');
    expect(fs.existsSync(worktreePath)).toBe(false);
    expect(branchExists(workspaceDir, `worktree-${slug}`)).toBe(false);
  });

  it.each([
    { state: 'is still live', live: true },
    { state: 'is gone', live: false },
  ])(
    'judges an archived replacement by an active tombstone that $state',
    async ({ live }) => {
      const sessionId = '550e8400-e29b-41d4-a716-44665544a0db';
      const middleId = '550e8400-e29b-41d4-a716-44665544a0dc';
      const firstId = '550e8400-e29b-41d4-a716-44665544a0dd';
      const activeId = '550e8400-e29b-41d4-a716-44665544a0de';
      const slug = `task-${sessionId.slice(-4)}`;
      const worktreePath = gitAddWorktree(workspaceDir, slug);
      writeSessionFile(workspaceDir, sessionId, 'archived');
      const service = new SessionService(workspaceDir);
      const base = {
        slug,
        worktreePath,
        worktreeBranch: `worktree-${slug}`,
        originalCwd: workspaceDir,
        workspaceCwd: workspaceDir,
        originalBranch: 'main',
        originalHeadCommit: execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: workspaceDir,
          encoding: 'utf8',
        }).trim(),
      };
      const archived = (id: string) =>
        service.getWorktreeSessionPathForArchiveState(id, 'archived');
      fs.mkdirSync(path.dirname(archived(sessionId)), { recursive: true });
      // Three resets: active -> first -> middle -> this session. All but
      // the first session are archived along with this one; the first one
      // still runs where its reset's sever did not finish.
      fs.writeFileSync(
        archived(sessionId),
        JSON.stringify({ ...base, supersedes: middleId }),
      );
      fs.writeFileSync(
        archived(middleId),
        JSON.stringify({
          ...base,
          supersedes: firstId,
          supersededBy: sessionId,
        }),
      );
      fs.writeFileSync(
        archived(firstId),
        JSON.stringify({
          ...base,
          supersedes: activeId,
          supersededBy: middleId,
        }),
      );
      fs.writeFileSync(
        service.getWorktreeSessionPath(activeId),
        JSON.stringify({ ...base, supersededBy: firstId }),
      );
      writeWorktreeMarker(worktreePath, sessionId);

      const result = await deleteDaemonSessions({
        sessionIds: [sessionId],
        service,
        bridge: cleanupBridge(live ? [activeId] : []),
        coordinator: new SessionArchiveCoordinator(),
      });

      expect(result.removed).toEqual([sessionId]);
      expect(fs.existsSync(worktreePath)).toBe(live);
      if (live) {
        expect(warnings()).toContain(
          `superseded session ${activeId} is still live`,
        );
      }
    },
  );

  it('keeps a checkout a session shares next to a tombstone', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-44665544a0d2';
    const oldId = '550e8400-e29b-41d4-a716-44665544a0d3';
    const sharerId = '550e8400-e29b-41d4-a716-44665544a0d4';
    const { service, worktreePath } = setupWorktreeSession(sessionId, {
      sidecarOverrides: { supersedes: oldId },
    });
    const own = JSON.parse(
      fs.readFileSync(service.getWorktreeSessionPath(sessionId), 'utf8'),
    ) as Record<string, unknown>;
    delete own['supersedes'];
    // Discounting the tombstone must not end the scan: the other sibling
    // names the checkout without `supersededBy`.
    fs.writeFileSync(
      service.getWorktreeSessionPath(oldId),
      JSON.stringify({ ...own, supersededBy: sessionId }),
    );
    fs.writeFileSync(
      service.getWorktreeSessionPath(sharerId),
      JSON.stringify(own),
    );

    const result = await deleteDaemonSessions({
      sessionIds: [sessionId],
      service,
      bridge: cleanupBridge(),
      coordinator: new SessionArchiveCoordinator(),
    });

    expect(result.removed).toEqual([sessionId]);
    expect(fs.existsSync(worktreePath)).toBe(true);
    expect(warnings()).toContain('checkout shared with');
  });

  it('keeps a checkout next to an unreadable sibling sidecar', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-4466554400ab';
    const otherId = '550e8400-e29b-41d4-a716-4466554400ac';
    const { service, worktreePath } = setupWorktreeSession(sessionId);
    // A sibling that cannot be read might name the same checkout.
    fs.writeFileSync(service.getWorktreeSessionPath(otherId), '{"slug":');

    const result = await deleteDaemonSessions({
      sessionIds: [sessionId],
      service,
      bridge: cleanupBridge(),
      coordinator: new SessionArchiveCoordinator(),
    });

    expect(result.removed).toEqual([sessionId]);
    expect(fs.existsSync(worktreePath)).toBe(true);
    expect(warnings()).toContain('unreadable sibling sidecar');
  });

  it('keeps a replacement whose checkout a live third session names', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-4466554400a2';
    const otherId = '550e8400-e29b-41d4-a716-4466554400a3';
    const { service, worktreePath } = setupWorktreeSession(sessionId, {
      sidecarOverrides: { supersedes: 'some-predecessor' },
    });
    // A sibling naming the same checkout without carrying `supersededBy`
    // is genuine sharing, not a tombstone.
    fs.copyFileSync(
      service.getWorktreeSessionPath(sessionId),
      service.getWorktreeSessionPath(otherId),
    );

    const result = await deleteDaemonSessions({
      sessionIds: [sessionId],
      service,
      bridge: cleanupBridge(),
      coordinator: new SessionArchiveCoordinator(),
    });

    expect(result.removed).toEqual([sessionId]);
    expect(fs.existsSync(worktreePath)).toBe(true);
    expect(warnings()).toContain('checkout shared with');
  });

  it('keeps a checkout outside the workspace worktree roots', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440099';
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-outside-'));
    try {
      const { service, worktreePath } = setupWorktreeSession(sessionId, {
        sidecarOverrides: { worktreePath: outside },
      });
      expect(worktreePath).not.toBe(outside);
      writeWorktreeMarker(outside, sessionId);

      const result = await deleteDaemonSessions({
        sessionIds: [sessionId],
        service,
        bridge: cleanupBridge(),
        coordinator: new SessionArchiveCoordinator(),
      });

      expect(result.removed).toEqual([sessionId]);
      expect(fs.existsSync(outside)).toBe(true);
      expect(warnings()).toContain('outside workspace worktree roots');
      // The in-repo worktree the fixture created is untouched either way.
      expect(fs.existsSync(worktreePath)).toBe(true);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('preserves the work of a checkout with tracked changes (P6 U3 snapshot or keep)', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-44665544009a';
    const { service, worktreePath } = setupWorktreeSession(sessionId);
    fs.writeFileSync(path.join(worktreePath, 'file.txt'), 'modified\n');

    const result = await deleteDaemonSessions({
      sessionIds: [sessionId],
      service,
      bridge: cleanupBridge(),
      coordinator: new SessionArchiveCoordinator(),
    });

    expect(result.removed).toEqual([sessionId]);
    await expectWorkArchived(
      service,
      sessionId,
      worktreePath,
      'file.txt',
      'modified\n',
    );
  });

  it('preserves the work of a checkout with never-committed agent files (P6 U3 snapshot or keep)', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-44665544009e';
    const { service, worktreePath } = setupWorktreeSession(sessionId);
    fs.writeFileSync(path.join(worktreePath, 'draft.ts'), 'export {}\n');

    const result = await deleteDaemonSessions({
      sessionIds: [sessionId],
      service,
      bridge: cleanupBridge(),
      coordinator: new SessionArchiveCoordinator(),
    });

    expect(result.removed).toEqual([sessionId]);
    await expectWorkArchived(
      service,
      sessionId,
      worktreePath,
      'draft.ts',
      'export {}\n',
    );
  });

  it('keeps the checkout and warns on an invalid marker', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-44665544009f';
    const { service, worktreePath } = setupWorktreeSession(sessionId);
    // A symlink marker fails the strict read (unsafe file type).
    fs.rmSync(path.join(worktreePath, '.qwen-session'));
    fs.symlinkSync(
      path.join(workspaceDir, 'file.txt'),
      path.join(worktreePath, '.qwen-session'),
    );

    const result = await deleteDaemonSessions({
      sessionIds: [sessionId],
      service,
      bridge: cleanupBridge(),
      coordinator: new SessionArchiveCoordinator(),
    });

    expect(result.removed).toEqual([sessionId]);
    expect(fs.existsSync(worktreePath)).toBe(true);
    expect(warnings()).toContain('marker invalid');
  });

  it('removes the checkout but keeps a branch with unmerged commits', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-44665544009b';
    const { service, slug, worktreePath } = setupWorktreeSession(sessionId);
    fs.writeFileSync(path.join(worktreePath, 'work.txt'), 'work\n');
    execFileSync('git', ['add', '.'], { cwd: worktreePath });
    execFileSync('git', ['commit', '-m', 'worktree work'], {
      cwd: worktreePath,
      stdio: 'ignore',
    });

    const result = await deleteDaemonSessions({
      sessionIds: [sessionId],
      service,
      bridge: cleanupBridge(),
      coordinator: new SessionArchiveCoordinator(),
    });

    expect(result.removed).toEqual([sessionId]);
    expect(fs.existsSync(worktreePath)).toBe(false);
    expect(branchExists(workspaceDir, `worktree-${slug}`)).toBe(true);
    expect(warnings()).toContain('removed checkout but kept branch');
  });

  it('removes the owned checkout for an archived session too', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-44665544009d';
    const slug = `task-${sessionId.slice(-4)}`;
    const worktreePath = gitAddWorktree(workspaceDir, slug);
    writeSessionFile(workspaceDir, sessionId, 'archived');
    const service = new SessionService(workspaceDir);
    const sidecarPath = service.getWorktreeSessionPathForArchiveState(
      sessionId,
      'archived',
    );
    fs.mkdirSync(path.dirname(sidecarPath), { recursive: true });
    fs.writeFileSync(
      sidecarPath,
      JSON.stringify({
        slug,
        worktreePath,
        worktreeBranch: `worktree-${slug}`,
        originalCwd: workspaceDir,
        workspaceCwd: workspaceDir,
        originalBranch: 'main',
        originalHeadCommit: execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: workspaceDir,
          encoding: 'utf8',
        }).trim(),
      }),
    );
    writeWorktreeMarker(worktreePath, sessionId);

    const result = await deleteDaemonSessions({
      sessionIds: [sessionId],
      service,
      bridge: cleanupBridge(),
      coordinator: new SessionArchiveCoordinator(),
    });

    expect(result.removed).toEqual([sessionId]);
    expect(fs.existsSync(worktreePath)).toBe(false);
    expect(branchExists(workspaceDir, `worktree-${slug}`)).toBe(false);
  });

  it('skips cleanup entirely when the caller holds the batch lock', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-44665544009c';
    const { service, worktreePath } = setupWorktreeSession(sessionId);

    const result = await deleteDaemonSessions({
      sessionIds: [sessionId],
      service,
      bridge: cleanupBridge(),
      coordinator: new SessionArchiveCoordinator(),
      coordinatorLockHeld: true,
    });

    expect(result.removed).toEqual([sessionId]);
    expect(fs.existsSync(worktreePath)).toBe(true);
  });

  it('keeps both checkouts when the sidecar slug names a different worktree', async () => {
    // The removal call re-derives its target from originalCwd + slug;
    // the equality guard must refuse when that derived target is not
    // the checkout every guard verified.
    const sessionId = '550e8400-e29b-41d4-a716-4466554400b0';
    const otherPath = gitAddWorktree(workspaceDir, 'task-other-b0');
    const { service, worktreePath } = setupWorktreeSession(sessionId, {
      sidecarOverrides: { slug: 'task-other-b0' },
    });

    const result = await deleteDaemonSessions({
      sessionIds: [sessionId],
      service,
      bridge: cleanupBridge(),
      coordinator: new SessionArchiveCoordinator(),
    });

    expect(result.removed).toEqual([sessionId]);
    expect(fs.existsSync(worktreePath)).toBe(true);
    expect(fs.existsSync(otherPath)).toBe(true);
    expect(warnings()).toContain(
      'slug does not resolve to the verified checkout',
    );
  });

  it('keeps the checkout when the sidecar slug escapes the worktree root', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-4466554400b1';
    const { service, worktreePath } = setupWorktreeSession(sessionId, {
      sidecarOverrides: { slug: '../..' },
    });

    const result = await deleteDaemonSessions({
      sessionIds: [sessionId],
      service,
      bridge: cleanupBridge(),
      coordinator: new SessionArchiveCoordinator(),
    });

    expect(result.removed).toEqual([sessionId]);
    expect(fs.existsSync(worktreePath)).toBe(true);
    expect(warnings()).toContain(
      'slug does not resolve to the verified checkout',
    );
  });

  it('preserves the work of a checkout whose only work sits under a git-ignored path (P6 U3 snapshot or keep)', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-4466554400b2';
    const { service, worktreePath } = setupWorktreeSession(sessionId);
    fs.writeFileSync(path.join(worktreePath, '.gitignore'), '.qwen/\n');
    execFileSync('git', ['add', '.gitignore'], { cwd: worktreePath });
    execFileSync('git', ['commit', '-m', 'ignore agent artifacts'], {
      cwd: worktreePath,
      stdio: 'ignore',
    });
    const draft = path.join(worktreePath, '.qwen', 'pr-drafts', 'draft.md');
    fs.mkdirSync(path.dirname(draft), { recursive: true });
    fs.writeFileSync(draft, '# draft\n');

    const result = await deleteDaemonSessions({
      sessionIds: [sessionId],
      service,
      bridge: cleanupBridge(),
      coordinator: new SessionArchiveCoordinator(),
    });

    expect(result.removed).toEqual([sessionId]);
    await expectWorkArchived(
      service,
      sessionId,
      worktreePath,
      '.qwen/pr-drafts/draft.md',
      '# draft\n',
    );
  });

  it('preserves the work of a checkout with untracked work when the repo hides untracked files (P6 U3 snapshot or keep)', async () => {
    // `status.showUntrackedFiles=no` set on the main repo is shared by
    // every linked worktree; the gate pins its own mode so ambient
    // config cannot make a dirty checkout read clean.
    const sessionId = '550e8400-e29b-41d4-a716-4466554400b3';
    const { service, worktreePath } = setupWorktreeSession(sessionId);
    execFileSync('git', ['config', 'status.showUntrackedFiles', 'no'], {
      cwd: workspaceDir,
    });
    const draft = path.join(worktreePath, 'draft.ts');
    fs.writeFileSync(draft, 'export {}\n');

    const result = await deleteDaemonSessions({
      sessionIds: [sessionId],
      service,
      bridge: cleanupBridge(),
      coordinator: new SessionArchiveCoordinator(),
    });

    expect(result.removed).toEqual([sessionId]);
    await expectWorkArchived(
      service,
      sessionId,
      worktreePath,
      'draft.ts',
      'export {}\n',
    );
  });

  it('cleans a checkout whose only ignored content is disposable build output', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-4466554400b4';
    // The ignore rules live on main so the worktree branch carries no
    // unmerged commits of its own.
    fs.writeFileSync(
      path.join(workspaceDir, '.gitignore'),
      'node_modules/\ndist/\ncoverage/\n',
    );
    execFileSync('git', ['add', '.gitignore'], { cwd: workspaceDir });
    execFileSync('git', ['commit', '-m', 'ignore build output'], {
      cwd: workspaceDir,
      stdio: 'ignore',
    });
    const { service, slug, worktreePath } = setupWorktreeSession(sessionId);
    fs.mkdirSync(path.join(worktreePath, 'node_modules', 'pkg'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(worktreePath, 'node_modules', 'pkg', 'index.js'),
      'module.exports = {}\n',
    );
    fs.mkdirSync(path.join(worktreePath, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(worktreePath, 'dist', 'bundle.js'), '//\n');

    const result = await deleteDaemonSessions({
      sessionIds: [sessionId],
      service,
      bridge: cleanupBridge(),
      coordinator: new SessionArchiveCoordinator(),
    });

    expect(result.removed).toEqual([sessionId]);
    expect(fs.existsSync(worktreePath)).toBe(false);
    expect(branchExists(workspaceDir, `worktree-${slug}`)).toBe(false);
  });

  it('refuses to fold the record when close reports the session is already closing', async () => {
    // A bridge-internal auto-close (last-detach, idle reaper) holds the
    // session without the coordinator; the child may still hold the
    // checkout as its cwd, so the delete must error instead of folding
    // the record and arming the destructive cleanup.
    const sessionId = '550e8400-e29b-41d4-a716-4466554400b5';
    const { service, worktreePath } = setupWorktreeSession(sessionId);

    const result = await deleteDaemonSessions({
      sessionIds: [sessionId],
      service,
      bridge: {
        closeSession: vi
          .fn()
          .mockRejectedValue(
            new SessionNotFoundError(
              sessionId,
              'The session is already closing',
              'session_closing',
            ),
          ),
        deleteSessionAttachments: vi.fn().mockResolvedValue(undefined),
      },
      coordinator: new SessionArchiveCoordinator(),
    });

    expect(result.removed).toEqual([]);
    expect(result.errors).toEqual([
      { sessionId, error: expect.stringContaining('already closing') },
    ]);
    expect(fs.existsSync(sessionPath(workspaceDir, sessionId, 'active'))).toBe(
      true,
    );
    expect(fs.existsSync(worktreePath)).toBe(true);
  });

  it('preserves the transcript and attachments if the deletion close times out', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-4466554400bf';
    const { service, worktreePath } = setupWorktreeSession(sessionId);
    const closeSession = vi
      .fn()
      .mockRejectedValue(new BridgeTimeoutError('closeSession', 10));
    const deleteSessionAttachments = vi.fn();

    const result = await deleteDaemonSessions({
      sessionIds: [sessionId],
      service,
      bridge: { closeSession, deleteSessionAttachments },
      coordinator: new SessionArchiveCoordinator(),
    });

    expect(result.removed).toEqual([]);
    expect(result.errors).toEqual([
      { sessionId, error: expect.stringContaining('timed out') },
    ]);
    expect(closeSession).toHaveBeenCalledWith(sessionId, undefined, {
      forDeletion: true,
    });
    expect(deleteSessionAttachments).not.toHaveBeenCalled();
    expect(fs.existsSync(sessionPath(workspaceDir, sessionId, 'active'))).toBe(
      true,
    );
    expect(fs.existsSync(worktreePath)).toBe(true);
  });

  it('still folds the record on a genuine not-found close', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-4466554400b6';
    const { service, slug, worktreePath } = setupWorktreeSession(sessionId);

    const result = await deleteDaemonSessions({
      sessionIds: [sessionId],
      service,
      bridge: {
        closeSession: vi
          .fn()
          .mockRejectedValue(new SessionNotFoundError(sessionId)),
        deleteSessionAttachments: vi.fn().mockResolvedValue(undefined),
      },
      coordinator: new SessionArchiveCoordinator(),
    });

    expect(result.removed).toEqual([sessionId]);
    expect(fs.existsSync(worktreePath)).toBe(false);
    expect(branchExists(workspaceDir, `worktree-${slug}`)).toBe(false);
  });

  it('preserves the checkout when the workspace generation closes mid-delete', async () => {
    // The destructive step is the only mutation that ran without
    // consulting the workspace-runtime generation guard; it must
    // re-assert before running.
    const sessionId = '550e8400-e29b-41d4-a716-4466554400b7';
    const { service, slug, worktreePath } = setupWorktreeSession(sessionId);
    let generationClosed = false;

    const result = await deleteDaemonSessions({
      sessionIds: [sessionId],
      service,
      bridge: {
        closeSession: vi.fn().mockResolvedValue(undefined),
        deleteSessionAttachments: vi.fn(async () => {
          generationClosed = true;
        }),
      },
      coordinator: new SessionArchiveCoordinator(),
      assertCanMutate: () => {
        if (generationClosed) {
          throw new Error('workspace_generation_closed');
        }
      },
    });

    expect(result.removed).toEqual([sessionId]);
    expect(fs.existsSync(worktreePath)).toBe(true);
    expect(branchExists(workspaceDir, `worktree-${slug}`)).toBe(true);
    expect(warnings()).toContain(
      'cleanup execution failed: workspace_generation_closed',
    );
  });

  it('does not certify preservation when the checkout may be partially deleted', async () => {
    // Simulate a removal that deletes the checkout before reporting failure:
    // the failure log must not claim the checkout was preserved.
    const sessionId = '550e8400-e29b-41d4-a716-4466554400b8';
    const { service, worktreePath } = setupWorktreeSession(sessionId);
    vi.spyOn(
      GitWorktreeService.prototype,
      'removeUserWorktree',
    ).mockImplementation(async () => {
      fs.rmSync(worktreePath, { recursive: true, force: true });
      return { success: false, error: 'injected removal failure' };
    });
    const result = await deleteDaemonSessions({
      sessionIds: [sessionId],
      service,
      bridge: cleanupBridge(),
      coordinator: new SessionArchiveCoordinator(),
    });

    expect(result.removed).toEqual([sessionId]);
    expect(warnings()).toContain('may be partially deleted');
    expect(warnings()).not.toContain('preserved checkout');
  });

  it('keeps the checkout and warns when a sidecar base is not absolute', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-4466554400b9';
    const { service, worktreePath } = setupWorktreeSession(sessionId, {
      sidecarOverrides: { workspaceCwd: '', originalCwd: '' },
    });

    const result = await deleteDaemonSessions({
      sessionIds: [sessionId],
      service,
      bridge: cleanupBridge(),
      coordinator: new SessionArchiveCoordinator(),
    });

    expect(result.removed).toEqual([sessionId]);
    expect(fs.existsSync(worktreePath)).toBe(true);
    expect(warnings()).toContain('sidecar base is not an absolute path');
  });

  it('keeps the checkout when the sidecar belongs to another workspace', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-4466554400ba';
    const { service, worktreePath } = setupWorktreeSession(sessionId, {
      sidecarOverrides: { workspaceCwd: runtimeDir },
    });

    const result = await deleteDaemonSessions({
      sessionIds: [sessionId],
      service,
      bridge: cleanupBridge(),
      coordinator: new SessionArchiveCoordinator(),
      runtimeWorkspaceCwd: workspaceDir,
    });

    expect(result.removed).toEqual([sessionId]);
    expect(fs.existsSync(worktreePath)).toBe(true);
    expect(warnings()).toContain('sidecar belongs to another workspace');
  });

  it('keeps the checkout when the sidecar original cwd is foreign', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-4466554400bb';
    const { service, worktreePath } = setupWorktreeSession(sessionId, {
      sidecarOverrides: { originalCwd: runtimeDir },
    });

    const result = await deleteDaemonSessions({
      sessionIds: [sessionId],
      service,
      bridge: cleanupBridge(),
      coordinator: new SessionArchiveCoordinator(),
      runtimeWorkspaceCwd: workspaceDir,
    });

    expect(result.removed).toEqual([sessionId]);
    expect(fs.existsSync(worktreePath)).toBe(true);
    expect(warnings()).toContain(
      'sidecar original cwd is outside the accepted roots',
    );
  });

  it('cleans an owned checkout when the runtime workspace is threaded', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-4466554400bc';
    const { service, slug, worktreePath } = setupWorktreeSession(sessionId);

    const result = await deleteDaemonSessions({
      sessionIds: [sessionId],
      service,
      bridge: cleanupBridge(),
      coordinator: new SessionArchiveCoordinator(),
      runtimeWorkspaceCwd: workspaceDir,
    });

    expect(result.removed).toEqual([sessionId]);
    expect(fs.existsSync(worktreePath)).toBe(false);
    expect(branchExists(workspaceDir, `worktree-${slug}`)).toBe(false);
  });
});

function initGitRepo(dir: string): void {
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], {
    cwd: dir,
  });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'file.txt'), 'initial\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'initial'], {
    cwd: dir,
    stdio: 'ignore',
  });
}

function gitAddWorktree(repoDir: string, slug: string): string {
  const worktreePath = path.join(repoDir, '.qwen', 'worktrees', slug);
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  execFileSync(
    'git',
    ['worktree', 'add', worktreePath, '-b', `worktree-${slug}`],
    {
      cwd: repoDir,
      stdio: 'ignore',
    },
  );
  return worktreePath;
}

function writeWorktreeMarker(worktreePath: string, sessionId: string): void {
  fs.writeFileSync(path.join(worktreePath, '.qwen-session'), sessionId);
}

function branchExists(repoDir: string, branch: string): boolean {
  return (
    execFileSync('git', ['branch', '--list', branch], {
      cwd: repoDir,
      encoding: 'utf8',
    }).trim().length > 0
  );
}

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

async function writeLifecycleSidecars(
  service: SessionService,
  sessionId: string,
  sourceState: 'active' | 'archived',
): Promise<{
  sessionId: string;
  service: SessionService;
  sourceState: 'active' | 'archived';
  pr: { number: number; url: string; createdAt: string };
}> {
  const worktreePath = service.getWorktreeSessionPathForArchiveState(
    sessionId,
    sourceState,
  );
  const prPath = service.getPrSessionPathForArchiveState(
    sessionId,
    sourceState,
  );
  const ledgerPath = path.join(
    path.dirname(prPath),
    `${sessionId}.ledger.jsonl`,
  );
  const pr = {
    number: 10300,
    url: 'https://github.com/QwenLM/qwen-code/pull/10300',
    createdAt: '2026-08-28T00:00:00.000Z',
  };
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  fs.writeFileSync(worktreePath, '{}');
  await writeSessionPrs(prPath, [pr]);
  fs.writeFileSync(ledgerPath, '{"promptId":"p1"}\n');
  return { sessionId, service, sourceState, pr };
}

async function expectLifecycleSidecarsMoved(
  fixture: Awaited<ReturnType<typeof writeLifecycleSidecars>>,
  destinationState: 'active' | 'archived',
): Promise<void> {
  const { sessionId, service, sourceState, pr } = fixture;
  const sourceWorktree = service.getWorktreeSessionPathForArchiveState(
    sessionId,
    sourceState,
  );
  const destinationWorktree = service.getWorktreeSessionPathForArchiveState(
    sessionId,
    destinationState,
  );
  const sourcePr = service.getPrSessionPathForArchiveState(
    sessionId,
    sourceState,
  );
  const destinationPr = service.getPrSessionPathForArchiveState(
    sessionId,
    destinationState,
  );
  const sourceLedger = path.join(
    path.dirname(sourcePr),
    `${sessionId}.ledger.jsonl`,
  );
  const destinationLedger = path.join(
    path.dirname(destinationPr),
    `${sessionId}.ledger.jsonl`,
  );
  expect(fs.existsSync(sourceWorktree)).toBe(false);
  expect(fs.existsSync(destinationWorktree)).toBe(true);
  expect(fs.existsSync(sourcePr)).toBe(false);
  await expect(readSessionPrs(destinationPr)).resolves.toEqual([pr]);
  expect(fs.existsSync(sourceLedger)).toBe(false);
  expect(fs.readFileSync(destinationLedger, 'utf8')).toContain(
    '"promptId":"p1"',
  );
}

describe('retained snapshot archive lifecycle', () => {
  let root: string;
  let coordinator: SessionArchiveCoordinator;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-snapshot-archive-'));
    coordinator = new SessionArchiveCoordinator();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function removedBinding(
    target: RetentionTestRuntime,
    options: { writeBinding?: boolean; slug?: string } = {},
  ) {
    const session = await makeRetainedSession(target, {
      slug: options.slug ?? 'archive-binding',
      dirty: true,
    });
    const plan = await preclassifyWorktreeCleanup(
      target.service,
      session.id,
      target.repo,
    );
    if (!plan) throw new Error('Fixture has no owned binding');
    const removal = await executeWorktreeCleanup(plan, {
      requireSnapshot: true,
    });
    if (!removal.removed || !removal.snapshot) {
      throw new Error('Fixture removal did not complete');
    }
    const archiveKey = path.basename(removal.snapshot.snapshotPath);
    if (options.writeBinding !== false) {
      await writeWorktreeSession(session.sidecarPath, {
        ...session.sidecar,
        worktreeRemoved: { archiveKey },
      });
    }
    return { ...session, archiveKey, service: target.service };
  }

  function snapshotFiles(directory: string, sessionId: string): string[] {
    if (!fs.existsSync(directory)) return [];
    return fs
      .readdirSync(directory)
      .filter(
        (file) =>
          file.startsWith(`${sessionId}.`) &&
          file.includes('.worktree-snapshot.'),
      )
      .sort();
  }

  function selectOwnedPair(
    state: Awaited<ReturnType<typeof removedBinding>>,
    archiveState: 'active' | 'archived',
  ) {
    return selectWorktreeSnapshot({
      directory: path.dirname(
        state.service.getWorktreeSessionPathForArchiveState(
          state.id,
          archiveState,
        ),
      ),
      sessionId: state.id,
      slug: state.sidecar.slug,
      archiveKey: state.archiveKey,
    });
  }

  async function expectOwnedPair(
    state: Awaited<ReturnType<typeof removedBinding>>,
    archiveState: 'active' | 'archived',
  ) {
    const selected = await selectOwnedPair(state, archiveState);
    expect(selected).toBeDefined();
    return selected!;
  }

  it('keeps a removed snapshot associated through archive/unarchive and restores it', async () => {
    const target = makeRetentionRepo(root, 'primary');
    const state = await removedBinding(target);
    const archive = await archiveDaemonSessions({
      sessionIds: [state.id],
      service: target.service,
      bridge: { closeSession: async () => {} },
      coordinator,
    });
    expect(archive.archived).toEqual([state.id]);
    expect(archive.errors).toEqual([]);
    const archivedSidecar =
      target.service.getWorktreeSessionPathForArchiveState(
        state.id,
        'archived',
      );
    expect(snapshotFiles(path.dirname(archivedSidecar), state.id)).toHaveLength(
      2,
    );
    expect(snapshotFiles(path.dirname(state.sidecarPath), state.id)).toEqual(
      [],
    );

    const again = await archiveDaemonSessions({
      sessionIds: [state.id],
      service: target.service,
      bridge: { closeSession: async () => {} },
      coordinator,
    });
    expect(again.alreadyArchived).toEqual([state.id]);
    expect(again.errors).toEqual([]);
    await expectOwnedPair(state, 'archived');
    await expect(selectOwnedPair(state, 'active')).resolves.toBeUndefined();
    expect(snapshotFiles(path.dirname(archivedSidecar), state.id)).toHaveLength(
      2,
    );
    const unarchive = await unarchiveDaemonSessions({
      sessionIds: [state.id],
      service: target.service,
      coordinator,
    });
    expect(unarchive.unarchived).toEqual([state.id]);
    expect(unarchive.errors).toEqual([]);
    expect(
      snapshotFiles(path.dirname(state.sidecarPath), state.id),
    ).toHaveLength(2);
    expect(snapshotFiles(path.dirname(archivedSidecar), state.id)).toEqual([]);
    expect(fs.existsSync(state.worktreePath)).toBe(false);

    const restored = await restoreWorktreeFromSessionSnapshot({
      runtime: target.runtime,
      sessionId: state.id,
      archiveCoordinator: new SessionArchiveCoordinator(),
    });
    expect(restored.reconstructed).toBe(true);
    expect(fs.existsSync(path.join(state.worktreePath, 'tracked.txt'))).toBe(
      true,
    );
    expect(
      fs.statSync(path.join(state.worktreePath, 'tracked.txt')).mode & 0o777,
    ).toBe(0o755);
  });

  it('reconciles a missing historical binding before an archive move and remains idempotent', async () => {
    const target = makeRetentionRepo(root, 'primary');
    const state = await removedBinding(target, { writeBinding: false });
    const archivedSidecar =
      target.service.getWorktreeSessionPathForArchiveState(
        state.id,
        'archived',
      );

    const archived = await archiveDaemonSessions({
      sessionIds: [state.id],
      service: target.service,
      bridge: { closeSession: async () => {} },
      coordinator,
    });

    expect(archived.archived).toEqual([state.id]);
    expect(archived.errors).toEqual([]);
    const record = await readWorktreeSessionStrict(archivedSidecar);
    expect(record.state).toBe('valid');
    if (record.state === 'valid') {
      expect(record.session.worktreeRemoved).toEqual({
        archiveKey: state.archiveKey,
      });
    }
    await expectOwnedPair(state, 'archived');
    await expect(selectOwnedPair(state, 'active')).resolves.toBeUndefined();

    const retried = await archiveDaemonSessions({
      sessionIds: [state.id],
      service: target.service,
      bridge: { closeSession: async () => {} },
      coordinator,
    });
    expect(retried.alreadyArchived).toEqual([state.id]);
    expect(retried.errors).toEqual([]);
    expect(snapshotFiles(path.dirname(archivedSidecar), state.id)).toHaveLength(
      2,
    );
    expect(snapshotFiles(path.dirname(state.sidecarPath), state.id)).toEqual(
      [],
    );

    const unarchived = await unarchiveDaemonSessions({
      sessionIds: [state.id],
      service: target.service,
      coordinator,
    });
    expect(unarchived.errors).toEqual([]);
    await expectOwnedPair(state, 'active');
    await expect(selectOwnedPair(state, 'archived')).resolves.toBeUndefined();
    const restored = await restoreWorktreeFromSessionSnapshot({
      runtime: target.runtime,
      sessionId: state.id,
      archiveCoordinator: coordinator,
    });
    expect(restored.reconstructed).toBe(true);
  });

  it('keeps the established newest-pair selection for multiple generations on one archive side', async () => {
    const target = makeRetentionRepo(root, 'primary');
    const state = await removedBinding(target, { writeBinding: false });
    const sourcePair = await expectOwnedPair(state, 'active');
    const olderSnapshot = path.join(
      path.dirname(sourcePair.snapshotPath),
      `${state.id}.older.worktree-snapshot.tar.gz`,
    );
    const olderMeta = olderSnapshot.replace(/\.tar\.gz$/, '.json');
    const latestMeta = await readWorktreeSnapshotMeta(sourcePair.metaPath);
    fs.copyFileSync(sourcePair.snapshotPath, olderSnapshot);
    fs.writeFileSync(
      olderMeta,
      JSON.stringify({ ...latestMeta, createdAt: latestMeta.createdAt - 1 }),
    );
    const olderKey = path.basename(olderSnapshot);
    expect(
      await selectWorktreeSnapshot({
        directory: path.dirname(sourcePair.snapshotPath),
        sessionId: state.id,
        slug: state.sidecar.slug,
        archiveKey: olderKey,
      }),
    ).toBeDefined();

    const result = await archiveDaemonSessions({
      sessionIds: [state.id],
      service: target.service,
      bridge: { closeSession: async () => {} },
      coordinator,
    });

    expect(result.errors).toEqual([]);
    const archivedSidecar =
      target.service.getWorktreeSessionPathForArchiveState(
        state.id,
        'archived',
      );
    const record = await readWorktreeSessionStrict(archivedSidecar);
    expect(record.state).toBe('valid');
    if (record.state === 'valid') {
      expect(record.session.worktreeRemoved).toEqual({
        archiveKey: state.archiveKey,
      });
    }
    await expectOwnedPair(state, 'archived');
    expect(snapshotFiles(path.dirname(archivedSidecar), state.id)).toHaveLength(
      2,
    );
    expect(
      await selectWorktreeSnapshot({
        directory: path.dirname(state.sidecarPath),
        sessionId: state.id,
        slug: state.sidecar.slug,
      }),
    ).toMatchObject({ snapshotPath: olderSnapshot });
  });

  it.each(['archive', 'unarchive'] as const)(
    'reconciles a secondary already-archived separation during %s',
    async (action) => {
      const target = makeRetentionRepo(root, 'secondary');
      const state = await removedBinding(target, { writeBinding: false });
      expect((await target.service.archiveSessions([state.id])).errors).toEqual(
        [],
      );
      const archivedSidecar =
        target.service.getWorktreeSessionPathForArchiveState(
          state.id,
          'archived',
        );
      expect(await selectOwnedPair(state, 'active')).toBeDefined();
      expect(await selectOwnedPair(state, 'archived')).toBeUndefined();

      const result =
        action === 'archive'
          ? await archiveDaemonSessions({
              sessionIds: [state.id],
              service: target.service,
              bridge: { closeSession: async () => {} },
              coordinator,
            })
          : await unarchiveDaemonSessions({
              sessionIds: [state.id],
              service: target.service,
              coordinator,
            });

      expect(result.errors).toEqual([]);
      const currentState = action === 'archive' ? 'archived' : 'active';
      const oppositeState = action === 'archive' ? 'active' : 'archived';
      const currentSidecar =
        target.service.getWorktreeSessionPathForArchiveState(
          state.id,
          currentState,
        );
      const record = await readWorktreeSessionStrict(currentSidecar);
      expect(record.state).toBe('valid');
      if (record.state === 'valid') {
        expect(record.session.worktreeRemoved).toEqual({
          archiveKey: state.archiveKey,
        });
      }
      await expectOwnedPair(state, currentState);
      await expect(
        selectOwnedPair(state, oppositeState),
      ).resolves.toBeUndefined();
      expect(fs.existsSync(archivedSidecar)).toBe(action === 'archive');
    },
  );

  it('acquires the worktree ownership lock during already-archived reconciliation', async () => {
    const target = makeRetentionRepo(root, 'primary');
    const state = await removedBinding(target, { writeBinding: false });
    expect((await target.service.archiveSessions([state.id])).errors).toEqual(
      [],
    );
    const lockSpy = vi.spyOn(worktreeOwnership, 'acquireWorktreeOwnershipOp');

    const result = await archiveDaemonSessions({
      sessionIds: [state.id],
      service: target.service,
      bridge: { closeSession: async () => {} },
      coordinator,
    });

    expect(result.alreadyArchived).toEqual([state.id]);
    expect(result.errors).toEqual([]);
    expect(lockSpy).toHaveBeenCalledWith(
      expect.stringContaining(path.basename(state.worktreePath)),
    );
    await expectOwnedPair(state, 'archived');
  });

  it('locks the surviving archived sidecar when the active sidecar is invalid during conflict archive', async () => {
    const target = makeRetentionRepo(root, 'primary');
    const state = await removedBinding(target, { writeBinding: false });
    expect((await target.service.archiveSessions([state.id])).errors).toEqual(
      [],
    );
    // Simulate a true active/archived conflict where active sidecar is corrupt
    // while the surviving archived sidecar is valid.
    fs.writeFileSync(
      state.transcriptPath,
      `${JSON.stringify({
        version: 1,
        sessionId: state.id,
        cwd: state.worktreePath,
        type: 'user',
        role: 'user',
        timestamp: '2026-01-01T00:00:00.000Z',
        content: 'conflict active copy',
      })}\n`,
    );
    fs.writeFileSync(state.sidecarPath, '{corrupt-active-sidecar');
    const lockSpy = vi.spyOn(worktreeOwnership, 'acquireWorktreeOwnershipOp');

    const result = await archiveDaemonSessions({
      sessionIds: [state.id],
      service: target.service,
      bridge: { closeSession: async () => {} },
      coordinator,
      resolveConflicts: true,
    });

    expect(result.resolvedConflicts).toEqual([state.id]);
    expect(result.errors).toEqual([]);
    expect(lockSpy).toHaveBeenCalledWith(
      expect.stringContaining(path.basename(state.worktreePath)),
    );
    await expectOwnedPair(state, 'archived');
  });

  it('fails closed instead of running lock-free when sidecar lock inspection hits an unsafe file type', async () => {
    const target = makeRetentionRepo(root, 'primary');
    const state = await removedBinding(target, { writeBinding: true });
    // A hardlinked sidecar (nlink === 2) fails strict inspection with a
    // non-corruption reason; archive must fail closed rather than skip locking.
    const extraLink = `${state.sidecarPath}.extra-link`;
    fs.linkSync(state.sidecarPath, extraLink);
    try {
      const result = await archiveDaemonSessions({
        sessionIds: [state.id],
        service: target.service,
        bridge: { closeSession: async () => {} },
        coordinator,
      });

      expect(result.archived).toEqual([]);
      expect(result.errors).toHaveLength(1);
      expect(String(result.errors[0]?.error)).toContain(
        'Could not read worktree sidecar for archive lock',
      );
      await expectOwnedPair(state, 'active');
    } finally {
      fs.rmSync(extraLink, { force: true });
    }
  });

  it('does not fail archive for an unbound missing checkout with no snapshot pair', async () => {
    const target = makeRetentionRepo(root, 'primary');
    const session = await makeRetainedSession(target, {
      slug: 'manually-removed-no-snapshot',
    });
    fs.rmSync(session.worktreePath, { recursive: true, force: true });
    // Corrupt sibling sidecar must not break archiving an unrelated session
    // that has no snapshot pair to reconcile.
    fs.writeFileSync(
      path.join(
        path.dirname(session.sidecarPath),
        'corrupt-sibling.worktree.json',
      ),
      '{not-json',
    );

    const result = await archiveDaemonSessions({
      sessionIds: [session.id],
      service: target.service,
      bridge: { closeSession: async () => {} },
      coordinator,
    });

    expect(result.archived).toEqual([session.id]);
    expect(result.errors).toEqual([]);
  });

  it('does not choose between historical pairs on both sides of an archive', async () => {
    const target = makeRetentionRepo(root, 'primary');
    const state = await removedBinding(target, { writeBinding: false });
    expect((await target.service.archiveSessions([state.id])).errors).toEqual(
      [],
    );
    const archivedSidecar =
      target.service.getWorktreeSessionPathForArchiveState(
        state.id,
        'archived',
      );
    const sourcePair = await expectOwnedPair(state, 'active');
    for (const file of [sourcePair.snapshotPath, sourcePair.metaPath]) {
      fs.copyFileSync(
        file,
        path.join(path.dirname(archivedSidecar), path.basename(file)),
      );
    }

    const result = await archiveDaemonSessions({
      sessionIds: [state.id],
      service: target.service,
      bridge: { closeSession: async () => {} },
      coordinator,
    });

    expect(result.errors).toHaveLength(1);
    expect(String(result.errors[0]?.error)).toContain(
      'ambiguous across archive states',
    );
    expect(
      snapshotFiles(path.dirname(state.sidecarPath), state.id),
    ).toHaveLength(2);
    expect(snapshotFiles(path.dirname(archivedSidecar), state.id)).toHaveLength(
      2,
    );
    const record = await readWorktreeSessionStrict(archivedSidecar);
    expect(record.state).toBe('valid');
    if (record.state === 'valid') {
      expect(record.session.worktreeRemoved).toBeUndefined();
    }
  });

  it('rejects a non-ENOENT error for the other archive directory without moving the pair', async () => {
    const target = makeRetentionRepo(root, 'primary');
    const state = await removedBinding(target, { writeBinding: false });
    expect((await target.service.archiveSessions([state.id])).errors).toEqual(
      [],
    );
    const archivedSidecar =
      target.service.getWorktreeSessionPathForArchiveState(
        state.id,
        'archived',
      );
    const otherDirectory = path.dirname(state.sidecarPath);
    const sourcePair = await expectOwnedPair(state, 'active');
    const originalBytes = [sourcePair.snapshotPath, sourcePair.metaPath].map(
      (file) => fs.readFileSync(file),
    );
    const failure = Object.assign(
      new Error('injected other archive directory read failure'),
      { code: 'EACCES' },
    );
    const lstat = fs.promises.lstat.bind(fs.promises);
    let injected = false;
    vi.spyOn(fs.promises, 'lstat').mockImplementation(
      async (candidate, options) => {
        if (String(candidate) === otherDirectory) {
          injected = true;
          throw failure;
        }
        return lstat(candidate, options);
      },
    );

    const result = await archiveDaemonSessions({
      sessionIds: [state.id],
      service: target.service,
      bridge: { closeSession: async () => {} },
      coordinator,
    });

    expect(injected).toBe(true);
    expect(result.errors).toHaveLength(1);
    expect(String(result.errors[0]?.error)).toContain(
      'injected other archive directory read failure',
    );
    const record = await readWorktreeSessionStrict(archivedSidecar);
    expect(record.state).toBe('valid');
    if (record.state === 'valid') {
      expect(record.session.worktreeRemoved).toBeUndefined();
    }
    expect(snapshotFiles(path.dirname(archivedSidecar), state.id)).toEqual([]);
    expect(
      snapshotFiles(path.dirname(state.sidecarPath), state.id),
    ).toHaveLength(2);
    expect(
      [sourcePair.snapshotPath, sourcePair.metaPath].map((file) =>
        fs.readFileSync(file),
      ),
    ).toEqual(originalBytes);
  });

  it('rolls back the first file when the second snapshot link fails and retries', async () => {
    const target = makeRetentionRepo(root, 'primary');
    const state = await removedBinding(target);
    const sourcePair = await expectOwnedPair(state, 'active');
    const archivedSidecar =
      target.service.getWorktreeSessionPathForArchiveState(
        state.id,
        'archived',
      );
    const targetMeta = path.join(
      path.dirname(archivedSidecar),
      path.basename(sourcePair.metaPath),
    );
    const originalBytes = fs.readFileSync(sourcePair.snapshotPath);
    await updateCronTasks(target.repo, () => [
      {
        id: 'snapshot-retry',
        cron: '0 9 * * *',
        prompt: 'p',
        recurring: true,
        createdAt: 1_700_000_000_000,
        lastFiredAt: null,
        sessionId: state.id,
      },
    ]);
    const failure = Object.assign(new Error('injected second link failure'), {
      code: 'EIO',
    });
    const link = fs.promises.link.bind(fs.promises);
    let injected = false;
    vi.spyOn(fs.promises, 'link').mockImplementation(
      async (source, destination) => {
        if (
          !injected &&
          String(source) === sourcePair.metaPath &&
          String(destination) === targetMeta
        ) {
          injected = true;
          throw failure;
        }
        return link(source, destination);
      },
    );

    const result = await archiveDaemonSessions({
      sessionIds: [state.id],
      service: target.service,
      bridge: { closeSession: async () => {} },
      coordinator,
    });

    expect(result.archived).toEqual([state.id]);
    expect(result.errors).toEqual([{ sessionId: state.id, error: failure }]);
    expect(injected).toBe(true);
    expect(fs.readFileSync(sourcePair.snapshotPath)).toEqual(originalBytes);
    await expectOwnedPair(state, 'active');
    await expect(selectOwnedPair(state, 'archived')).resolves.toBeUndefined();
    expect(
      (await readCronTasks(target.repo)).find(
        (task) => task.id === 'snapshot-retry',
      )?.enabled,
    ).toBe(false);

    const retry = await archiveDaemonSessions({
      sessionIds: [state.id],
      service: target.service,
      bridge: { closeSession: async () => {} },
      coordinator,
    });
    expect(retry).toMatchObject({
      archived: [],
      alreadyArchived: [state.id],
      errors: [],
    });
    await expect(selectOwnedPair(state, 'active')).resolves.toBeUndefined();
    await expectOwnedPair(state, 'archived');
  });

  it('refuses to unlink a replaced destination snapshot during rollback', async () => {
    const target = makeRetentionRepo(root, 'primary');
    const state = await removedBinding(target);
    const sourcePair = await expectOwnedPair(state, 'active');
    const archivedSidecar =
      target.service.getWorktreeSessionPathForArchiveState(
        state.id,
        'archived',
      );
    const destinationSnapshot = path.join(
      path.dirname(archivedSidecar),
      path.basename(sourcePair.snapshotPath),
    );
    const destinationMeta = path.join(
      path.dirname(archivedSidecar),
      path.basename(sourcePair.metaPath),
    );
    const record = await readWorktreeSessionStrict(state.sidecarPath);
    if (record.state !== 'valid') throw new Error('Missing owner record');
    await writeWorktreeSession(archivedSidecar, record.session);

    const replacementBytes = Buffer.from('replacement-owner-file');
    const link = fs.promises.link.bind(fs.promises);
    let swapped = false;
    vi.spyOn(fs.promises, 'link').mockImplementation(
      async (source, destination) => {
        if (String(destination) === destinationMeta) {
          fs.unlinkSync(destinationSnapshot);
          fs.writeFileSync(destinationSnapshot, replacementBytes);
          swapped = true;
          throw Object.assign(new Error('injected second link failure'), {
            code: 'EIO',
          });
        }
        await link(source, destination);
      },
    );

    const failure = await moveWorktreeSnapshotsWithSession(
      target.service,
      state.id,
      'archived',
    ).catch((error: unknown) => error);
    expect(swapped).toBe(true);
    expect(failure).toBeInstanceOf(AggregateError);
    if (failure instanceof AggregateError) {
      expect(failure.message).toBe(
        'Worktree snapshot move failed and rollback was incomplete',
      );
      expect(
        failure.errors.some(
          (cause) =>
            cause instanceof Error &&
            cause.message.includes(
              'Refusing to roll back a replaced snapshot link',
            ),
        ),
      ).toBe(true);
    }
    expect(fs.readFileSync(destinationSnapshot)).toEqual(replacementBytes);
    // Two-phase move keeps the source pair completely intact when phase-1 linking fails.
    expect(fs.existsSync(sourcePair.snapshotPath)).toBe(true);
    expect(fs.existsSync(sourcePair.metaPath)).toBe(true);
    expect(fs.existsSync(destinationMeta)).toBe(false);
    await expectOwnedPair(state, 'active');
  });

  it('completes interrupted two-phase snapshot moves across all crash boundaries and refuses foreign hardlinks', async () => {
    for (const boundary of [
      'phase1-mid',
      'between-phases',
      'phase2-mid',
    ] as const) {
      const target = makeRetentionRepo(root, `crash-${boundary}`);
      const state = await removedBinding(target);
      const sourcePair = await expectOwnedPair(state, 'active');
      const archivedSidecar =
        target.service.getWorktreeSessionPathForArchiveState(
          state.id,
          'archived',
        );
      const destinationDir = path.dirname(archivedSidecar);
      const destinationSnapshot = path.join(
        destinationDir,
        path.basename(sourcePair.snapshotPath),
      );
      const destinationMeta = path.join(
        destinationDir,
        path.basename(sourcePair.metaPath),
      );
      const expectedArchiveBytes = fs.readFileSync(sourcePair.snapshotPath);
      const expectedMetaBytes = fs.readFileSync(sourcePair.metaPath);
      const record = await readWorktreeSessionStrict(state.sidecarPath);
      if (record.state !== 'valid') throw new Error('Missing owner record');
      await writeWorktreeSession(archivedSidecar, record.session);
      fs.mkdirSync(destinationDir, { recursive: true });

      if (boundary === 'phase1-mid') {
        fs.linkSync(sourcePair.snapshotPath, destinationSnapshot);
      } else if (boundary === 'between-phases') {
        fs.linkSync(sourcePair.snapshotPath, destinationSnapshot);
        fs.linkSync(sourcePair.metaPath, destinationMeta);
      } else {
        fs.linkSync(sourcePair.snapshotPath, destinationSnapshot);
        fs.linkSync(sourcePair.metaPath, destinationMeta);
        fs.unlinkSync(sourcePair.snapshotPath);
      }

      await moveWorktreeSnapshotsWithSession(
        target.service,
        state.id,
        'archived',
      );

      expect(fs.existsSync(sourcePair.snapshotPath)).toBe(false);
      expect(fs.existsSync(sourcePair.metaPath)).toBe(false);
      expect(fs.lstatSync(destinationSnapshot, { bigint: true }).nlink).toBe(
        1n,
      );
      expect(fs.lstatSync(destinationMeta, { bigint: true }).nlink).toBe(1n);
      expect(fs.readFileSync(destinationSnapshot)).toEqual(
        expectedArchiveBytes,
      );
      expect(fs.readFileSync(destinationMeta)).toEqual(expectedMetaBytes);
      await expectOwnedPair(state, 'archived');
    }

    // Negative control 1: foreign hardlink outside source/destination stays fail-closed.
    const foreignTarget = makeRetentionRepo(root, 'crash-foreign-link');
    const foreignState = await removedBinding(foreignTarget);
    const foreignPair = await expectOwnedPair(foreignState, 'active');
    const foreignArchivedSidecar =
      foreignTarget.service.getWorktreeSessionPathForArchiveState(
        foreignState.id,
        'archived',
      );
    const foreignRecord = await readWorktreeSessionStrict(
      foreignState.sidecarPath,
    );
    if (foreignRecord.state !== 'valid') {
      throw new Error('Missing foreign owner record');
    }
    await writeWorktreeSession(foreignArchivedSidecar, foreignRecord.session);
    const thirdAlias = path.join(root, 'third-party-hardlink.tar.gz');
    fs.linkSync(foreignPair.snapshotPath, thirdAlias);
    await expect(
      moveWorktreeSnapshotsWithSession(
        foreignTarget.service,
        foreignState.id,
        'archived',
      ),
    ).rejects.toThrow(/not an owned regular file/i);
    expect(fs.existsSync(foreignPair.snapshotPath)).toBe(true);

    // Negative control 2: twin on one member + conflicting different-inode destination on the other.
    const conflictTarget = makeRetentionRepo(root, 'crash-conflict');
    const conflictState = await removedBinding(conflictTarget);
    const conflictPair = await expectOwnedPair(conflictState, 'active');
    const conflictArchivedSidecar =
      conflictTarget.service.getWorktreeSessionPathForArchiveState(
        conflictState.id,
        'archived',
      );
    const conflictRecord = await readWorktreeSessionStrict(
      conflictState.sidecarPath,
    );
    if (conflictRecord.state !== 'valid') {
      throw new Error('Missing conflict owner record');
    }
    await writeWorktreeSession(conflictArchivedSidecar, conflictRecord.session);
    const conflictDestDir = path.dirname(conflictArchivedSidecar);
    fs.mkdirSync(conflictDestDir, { recursive: true });
    const conflictDestSnapshot = path.join(
      conflictDestDir,
      path.basename(conflictPair.snapshotPath),
    );
    const conflictDestMeta = path.join(
      conflictDestDir,
      path.basename(conflictPair.metaPath),
    );
    fs.linkSync(conflictPair.snapshotPath, conflictDestSnapshot);
    fs.writeFileSync(conflictDestMeta, '{"foreign":true}');
    await expect(
      moveWorktreeSnapshotsWithSession(
        conflictTarget.service,
        conflictState.id,
        'archived',
      ),
    ).rejects.toThrow();
    expect(fs.readFileSync(conflictDestMeta, 'utf8')).toBe('{"foreign":true}');
  });

  it('safely unlinks its twin without poisoning the replacement when source is atomically replaced before link', async () => {
    const target = makeRetentionRepo(root, 'source-replaced-before-link');
    const state = await removedBinding(target);
    const sourcePair = await expectOwnedPair(state, 'active');
    const archivedSidecar =
      target.service.getWorktreeSessionPathForArchiveState(
        state.id,
        'archived',
      );
    const destinationSnapshot = path.join(
      path.dirname(archivedSidecar),
      path.basename(sourcePair.snapshotPath),
    );
    const record = await readWorktreeSessionStrict(state.sidecarPath);
    if (record.state !== 'valid') throw new Error('Missing owner record');
    await writeWorktreeSession(archivedSidecar, record.session);

    const replacementBytes = Buffer.from('atomically-replaced-source');
    const link = fs.promises.link.bind(fs.promises);
    let replaced = false;
    vi.spyOn(fs.promises, 'link').mockImplementation(
      async (source, destination) => {
        if (!replaced && String(source) === sourcePair.snapshotPath) {
          replaced = true;
          const tempPath = `${sourcePair.snapshotPath}.replacement`;
          fs.writeFileSync(tempPath, replacementBytes);
          fs.renameSync(tempPath, sourcePair.snapshotPath);
        }
        await link(source, destination);
      },
    );

    const failure = await moveWorktreeSnapshotsWithSession(
      target.service,
      state.id,
      'archived',
    ).catch((error: unknown) => error);
    expect(replaced).toBe(true);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(AggregateError);
    expect((failure as Error).message).toContain(
      'Snapshot source changed during move',
    );
    expect(fs.existsSync(destinationSnapshot)).toBe(false);
    expect(fs.readFileSync(sourcePair.snapshotPath)).toEqual(replacementBytes);
    expect(fs.lstatSync(sourcePair.snapshotPath, { bigint: true }).nlink).toBe(
      1n,
    );
  });

  it('does not split an interrupted move when phase-2 second unlink fails during recovery', async () => {
    const target = makeRetentionRepo(root, 'phase2-recovery-unlink-failure');
    const state = await removedBinding(target);
    const sourcePair = await expectOwnedPair(state, 'active');
    const archivedSidecar =
      target.service.getWorktreeSessionPathForArchiveState(
        state.id,
        'archived',
      );
    const destinationDir = path.dirname(archivedSidecar);
    const destinationSnapshot = path.join(
      destinationDir,
      path.basename(sourcePair.snapshotPath),
    );
    const destinationMeta = path.join(
      destinationDir,
      path.basename(sourcePair.metaPath),
    );
    const expectedArchiveBytes = fs.readFileSync(sourcePair.snapshotPath);
    const expectedMetaBytes = fs.readFileSync(sourcePair.metaPath);
    const record = await readWorktreeSessionStrict(state.sidecarPath);
    if (record.state !== 'valid') throw new Error('Missing owner record');
    await writeWorktreeSession(archivedSidecar, record.session);
    fs.mkdirSync(destinationDir, { recursive: true });
    // Phase 1 mid crash: tar is linked across source and destination, meta is sourceOnly.
    fs.linkSync(sourcePair.snapshotPath, destinationSnapshot);

    const unlink = fs.promises.unlink.bind(fs.promises);
    let injected = false;
    const unlinkSpy = vi
      .spyOn(fs.promises, 'unlink')
      .mockImplementation(async (targetPath) => {
        if (!injected && String(targetPath) === sourcePair.metaPath) {
          injected = true;
          throw Object.assign(new Error('injected second unlink EBUSY'), {
            code: 'EBUSY',
          });
        }
        await unlink(targetPath);
      });

    await expect(
      moveWorktreeSnapshotsWithSession(target.service, state.id, 'archived'),
    ).rejects.toThrow('injected second unlink EBUSY');
    expect(injected).toBe(true);
    // Destination must still hold both members so the pair is not split.
    expect(fs.existsSync(destinationSnapshot)).toBe(true);
    expect(fs.existsSync(destinationMeta)).toBe(true);
    expect(fs.existsSync(sourcePair.metaPath)).toBe(true);
    expect(fs.lstatSync(destinationMeta, { bigint: true }).nlink).toBe(2n);

    unlinkSpy.mockRestore();
    await moveWorktreeSnapshotsWithSession(
      target.service,
      state.id,
      'archived',
    );
    expect(fs.existsSync(sourcePair.snapshotPath)).toBe(false);
    expect(fs.existsSync(sourcePair.metaPath)).toBe(false);
    expect(fs.lstatSync(destinationSnapshot, { bigint: true }).nlink).toBe(1n);
    expect(fs.lstatSync(destinationMeta, { bigint: true }).nlink).toBe(1n);
    expect(fs.readFileSync(destinationSnapshot)).toEqual(expectedArchiveBytes);
    expect(fs.readFileSync(destinationMeta)).toEqual(expectedMetaBytes);
    await expectOwnedPair(state, 'archived');
  });

  it('keeps destination pair recoverable when phase-2 second unlink and source rollback both fail', async () => {
    const target = makeRetentionRepo(root, 'move-phase2-rollback-failure');
    const state = await removedBinding(target);
    const sourcePair = await expectOwnedPair(state, 'active');
    const archivedSidecar =
      target.service.getWorktreeSessionPathForArchiveState(
        state.id,
        'archived',
      );
    const destinationDir = path.dirname(archivedSidecar);
    const destinationSnapshot = path.join(
      destinationDir,
      path.basename(sourcePair.snapshotPath),
    );
    const destinationMeta = path.join(
      destinationDir,
      path.basename(sourcePair.metaPath),
    );
    const expectedArchiveBytes = fs.readFileSync(sourcePair.snapshotPath);
    const expectedMetaBytes = fs.readFileSync(sourcePair.metaPath);
    const record = await readWorktreeSessionStrict(state.sidecarPath);
    if (record.state !== 'valid') throw new Error('Missing owner record');
    await writeWorktreeSession(archivedSidecar, record.session);

    const unlink = fs.promises.unlink.bind(fs.promises);
    const link = fs.promises.link.bind(fs.promises);
    let sourceDirFaulted = false;
    const unlinkSpy = vi
      .spyOn(fs.promises, 'unlink')
      .mockImplementation(async (targetPath) => {
        if (String(targetPath) === sourcePair.metaPath) {
          sourceDirFaulted = true;
          throw Object.assign(new Error('source dir EACCES on second unlink'), {
            code: 'EACCES',
          });
        }
        await unlink(targetPath);
      });
    const linkSpy = vi
      .spyOn(fs.promises, 'link')
      .mockImplementation(async (existingPath, newPath) => {
        if (sourceDirFaulted && String(newPath) === sourcePair.snapshotPath) {
          throw Object.assign(new Error('source dir EACCES on rollback link'), {
            code: 'EACCES',
          });
        }
        await link(existingPath, newPath);
      });

    await expect(
      moveWorktreeSnapshotsWithSession(target.service, state.id, 'archived'),
    ).rejects.toBeInstanceOf(AggregateError);
    expect(sourceDirFaulted).toBe(true);
    // Pass-1 rollback failure must not unlink destinationMeta and split the pair.
    expect(fs.existsSync(destinationSnapshot)).toBe(true);
    expect(fs.existsSync(destinationMeta)).toBe(true);
    expect(fs.existsSync(sourcePair.metaPath)).toBe(true);
    expect(fs.lstatSync(destinationMeta, { bigint: true }).nlink).toBe(2n);

    unlinkSpy.mockRestore();
    linkSpy.mockRestore();
    await moveWorktreeSnapshotsWithSession(
      target.service,
      state.id,
      'archived',
    );
    expect(fs.existsSync(sourcePair.snapshotPath)).toBe(false);
    expect(fs.existsSync(sourcePair.metaPath)).toBe(false);
    expect(fs.lstatSync(destinationSnapshot, { bigint: true }).nlink).toBe(1n);
    expect(fs.lstatSync(destinationMeta, { bigint: true }).nlink).toBe(1n);
    expect(fs.readFileSync(destinationSnapshot)).toEqual(expectedArchiveBytes);
    expect(fs.readFileSync(destinationMeta)).toEqual(expectedMetaBytes);
    await expectOwnedPair(state, 'archived');
  });

  it('refuses to follow a symlinked destination directory during interrupted recovery or snapshot move', async () => {
    const target = makeRetentionRepo(root, 'symlink-dest-dir-boundary');
    const state = await removedBinding(target);
    const sourcePair = await expectOwnedPair(state, 'active');
    const archivedSidecar =
      target.service.getWorktreeSessionPathForArchiveState(
        state.id,
        'archived',
      );
    const archivedDir = path.dirname(archivedSidecar);
    const outsideDir = path.join(root, 'outside-archive-target');
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.rmSync(archivedDir, { recursive: true, force: true });
    fs.symlinkSync(outsideDir, archivedDir, 'dir');

    const record = await readWorktreeSessionStrict(state.sidecarPath);
    if (record.state !== 'valid') throw new Error('Missing owner record');
    await writeWorktreeSession(
      path.join(outsideDir, path.basename(archivedSidecar)),
      record.session,
    );
    // Even if a matching twin exists in the symlink target, recovery must not
    // follow the directory-level symlink or unlink source entries.
    const outsideSnapshot = path.join(
      outsideDir,
      path.basename(sourcePair.snapshotPath),
    );
    fs.linkSync(sourcePair.snapshotPath, outsideSnapshot);

    await expect(
      moveWorktreeSnapshotsWithSession(target.service, state.id, 'archived'),
    ).rejects.toThrow();
    expect(fs.existsSync(sourcePair.snapshotPath)).toBe(true);
    expect(fs.existsSync(sourcePair.metaPath)).toBe(true);
    expect(
      fs.existsSync(path.join(outsideDir, path.basename(sourcePair.metaPath))),
    ).toBe(false);
  });

  it('refuses to link a sourceOnly member during interrupted recovery if it gains a foreign hardlink before link', async () => {
    const target = makeRetentionRepo(root, 'interrupted-foreign-nlink-race');
    const state = await removedBinding(target);
    const sourcePair = await expectOwnedPair(state, 'active');
    const archivedSidecar =
      target.service.getWorktreeSessionPathForArchiveState(
        state.id,
        'archived',
      );
    const destinationDir = path.dirname(archivedSidecar);
    const destinationSnapshot = path.join(
      destinationDir,
      path.basename(sourcePair.snapshotPath),
    );
    const destinationMeta = path.join(
      destinationDir,
      path.basename(sourcePair.metaPath),
    );
    const record = await readWorktreeSessionStrict(state.sidecarPath);
    if (record.state !== 'valid') throw new Error('Missing owner record');
    await writeWorktreeSession(archivedSidecar, record.session);
    fs.mkdirSync(destinationDir, { recursive: true });
    // Phase 1 mid crash: tar is linked, meta is sourceOnly (nlink === 1).
    fs.linkSync(sourcePair.snapshotPath, destinationSnapshot);

    const foreignLink = path.join(root, 'concurrent-foreign-meta-link.json');
    const origLstat = fs.promises.lstat.bind(fs.promises);
    let metaLstatCount = 0;
    const lstatSpy = vi
      .spyOn(fs.promises, 'lstat')
      .mockImplementation(async (targetPath, options) => {
        if (String(targetPath) === sourcePair.metaPath) {
          metaLstatCount += 1;
          // 1st lstat is inside classifyInterruptedSnapshotMove (sees nlink === 1).
          // 2nd lstat is right before fs.link in finishInterruptedSnapshotMove:
          // add an external hardlink so nlink rises to 2 without replacing inode.
          if (metaLstatCount === 2) {
            fs.linkSync(sourcePair.metaPath, foreignLink);
          }
        }
        return origLstat(targetPath, options as never);
      });

    try {
      await expect(
        moveWorktreeSnapshotsWithSession(target.service, state.id, 'archived'),
      ).rejects.toThrow(/Snapshot source changed during move/);
    } finally {
      lstatSpy.mockRestore();
    }
    expect(metaLstatCount).toBeGreaterThanOrEqual(2);
    expect(fs.existsSync(destinationMeta)).toBe(false);
    expect(fs.existsSync(sourcePair.metaPath)).toBe(true);
  });

  it('rolls back safely when a sourceOnly member is replaced with a new inode between classify and link during interrupted recovery', async () => {
    const target = makeRetentionRepo(root, 'interrupted-source-inode-swap');
    const state = await removedBinding(target);
    const sourcePair = await expectOwnedPair(state, 'active');
    const archivedSidecar =
      target.service.getWorktreeSessionPathForArchiveState(
        state.id,
        'archived',
      );
    const destinationDir = path.dirname(archivedSidecar);
    const destinationSnapshot = path.join(
      destinationDir,
      path.basename(sourcePair.snapshotPath),
    );
    const destinationMeta = path.join(
      destinationDir,
      path.basename(sourcePair.metaPath),
    );
    const record = await readWorktreeSessionStrict(state.sidecarPath);
    if (record.state !== 'valid') throw new Error('Missing owner record');
    await writeWorktreeSession(archivedSidecar, record.session);
    fs.mkdirSync(destinationDir, { recursive: true });
    // Phase 1 mid crash: tar is linked, meta is sourceOnly (nlink === 1).
    fs.linkSync(sourcePair.snapshotPath, destinationSnapshot);

    const replacementBytes = Buffer.from('{"replaced":true}\n');
    const link = fs.promises.link.bind(fs.promises);
    let swapped = false;
    const linkSpy = vi
      .spyOn(fs.promises, 'link')
      .mockImplementation(async (existingPath, newPath) => {
        if (!swapped && String(newPath) === destinationMeta) {
          swapped = true;
          // Atomically replace the source with a NEW inode after its
          // identity was recorded but before the hardlink is created.
          const tempPath = `${sourcePair.metaPath}.replacement`;
          fs.writeFileSync(tempPath, replacementBytes);
          fs.renameSync(tempPath, sourcePair.metaPath);
        }
        await link(existingPath, newPath);
      });

    let failure: unknown;
    try {
      await moveWorktreeSnapshotsWithSession(
        target.service,
        state.id,
        'archived',
      ).catch((error: unknown) => {
        failure = error;
      });
    } finally {
      linkSpy.mockRestore();
    }
    expect(swapped).toBe(true);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(AggregateError);
    expect((failure as Error).message).toContain(
      'Snapshot source changed during move',
    );
    // The freshly created twin of the replacement inode must be unlinked so
    // the replacement source is left intact at nlink === 1.
    expect(fs.existsSync(destinationMeta)).toBe(false);
    expect(fs.readFileSync(sourcePair.metaPath)).toEqual(replacementBytes);
    expect(fs.lstatSync(sourcePair.metaPath, { bigint: true }).nlink).toBe(1n);
  });

  it('rolls back a post-link identity probe failure and retries', async () => {
    const target = makeRetentionRepo(root, 'primary');
    const state = await removedBinding(target);
    const sourcePair = await expectOwnedPair(state, 'active');
    const archivedSidecar =
      target.service.getWorktreeSessionPathForArchiveState(
        state.id,
        'archived',
      );
    const destinationSnapshot = path.join(
      path.dirname(archivedSidecar),
      path.basename(sourcePair.snapshotPath),
    );
    const record = await readWorktreeSessionStrict(state.sidecarPath);
    if (record.state !== 'valid') throw new Error('Missing owner record');
    await writeWorktreeSession(archivedSidecar, record.session);
    const failure = Object.assign(new Error('injected post-link lstat'), {
      code: 'EIO',
    });
    const link = fs.promises.link.bind(fs.promises);
    let linked = false;
    vi.spyOn(fs.promises, 'link').mockImplementation(
      async (source, destination) => {
        await link(source, destination);
        if (String(destination) === destinationSnapshot) linked = true;
      },
    );
    const lstat = fs.promises.lstat.bind(fs.promises);
    let injected = false;
    vi.spyOn(fs.promises, 'lstat').mockImplementation(
      async (candidate, options) => {
        if (linked && !injected && String(candidate) === destinationSnapshot) {
          injected = true;
          throw failure;
        }
        return lstat(candidate, options);
      },
    );

    await expect(
      moveWorktreeSnapshotsWithSession(target.service, state.id, 'archived'),
    ).rejects.toMatchObject({ message: 'injected post-link lstat' });
    expect(injected).toBe(true);
    expect(fs.statSync(sourcePair.snapshotPath, { bigint: true }).nlink).toBe(
      1n,
    );
    expect(fs.existsSync(destinationSnapshot)).toBe(false);
    await expectOwnedPair(state, 'active');
    await expect(selectOwnedPair(state, 'archived')).resolves.toBeUndefined();

    await expect(
      moveWorktreeSnapshotsWithSession(target.service, state.id, 'archived'),
    ).resolves.toBeUndefined();
    await expectOwnedPair(state, 'archived');
    await expect(selectOwnedPair(state, 'active')).resolves.toBeUndefined();
  });

  it('fails when the freshly moved pair is no longer complete', async () => {
    const target = makeRetentionRepo(root, 'primary');
    const state = await removedBinding(target);
    const sourcePair = await expectOwnedPair(state, 'active');
    const destinationSidecar =
      target.service.getWorktreeSessionPathForArchiveState(
        state.id,
        'archived',
      );
    const destinationMeta = path.join(
      path.dirname(destinationSidecar),
      path.basename(sourcePair.metaPath),
    );
    const record = await readWorktreeSessionStrict(state.sidecarPath);
    if (record.state !== 'valid') {
      throw new Error('The migration fixture has no valid owner record');
    }
    // Model the record mutation being durable while the source pair has not
    // yet moved. The directory and owner provenance remain real.
    await writeWorktreeSession(destinationSidecar, record.session);
    const unlink = fs.promises.unlink.bind(fs.promises);
    let discardedDestination = false;
    vi.spyOn(fs.promises, 'unlink').mockImplementation(async (file) => {
      if (String(file) === sourcePair.metaPath) {
        await unlink(destinationMeta);
        discardedDestination = true;
        return;
      }
      await unlink(file);
    });

    const failure = await moveWorktreeSnapshotsWithSession(
      target.service,
      state.id,
      'archived',
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    if (!(failure instanceof AggregateError)) {
      throw new Error('Expected the missing moved pair to fail');
    }
    expect(failure.errors[0]).toMatchObject({
      message: 'The moved snapshot pair is unavailable',
    });
    expect(discardedDestination).toBe(true);
    await expectOwnedPair(state, 'active');
  });

  it('rolls back an unlink failure, aggregates task failure, and retries both', async () => {
    const target = makeRetentionRepo(root, 'primary');
    const state = await removedBinding(target);
    const sourcePair = await expectOwnedPair(state, 'active');
    const originalBytes = fs.readFileSync(sourcePair.snapshotPath);
    await updateCronTasks(target.repo, () => [
      {
        id: 'double-maintenance-failure',
        cron: '0 9 * * *',
        prompt: 'p',
        recurring: true,
        createdAt: 1_700_000_000_000,
        lastFiredAt: null,
        sessionId: state.id,
      },
    ]);
    const cronFile = getCronFilePath(target.repo);
    const cronContents = fs.readFileSync(cronFile);
    fs.rmSync(cronFile);
    fs.mkdirSync(cronFile);
    const failure = Object.assign(new Error('injected first unlink failure'), {
      code: 'EIO',
    });
    const unlink = fs.promises.unlink.bind(fs.promises);
    let injected = false;
    vi.spyOn(fs.promises, 'unlink').mockImplementation(async (file) => {
      if (!injected && String(file) === sourcePair.snapshotPath) {
        injected = true;
        throw failure;
      }
      return unlink(file);
    });

    const result = await archiveDaemonSessions({
      sessionIds: [state.id],
      service: target.service,
      bridge: { closeSession: async () => {} },
      coordinator,
    });

    expect(result.archived).toEqual([state.id]);
    expect(result.errors).toHaveLength(1);
    const maintenanceError = result.errors[0]!.error;
    expect(maintenanceError).toBeInstanceOf(AggregateError);
    if (!(maintenanceError instanceof AggregateError)) {
      throw new Error('Expected both follow-up failures to be aggregated');
    }
    const failures = maintenanceError.errors as unknown[];
    expect(failures).toHaveLength(2);
    expect(failures[0]).toBe(failure);
    expect(failures[1]).toBeInstanceOf(Error);
    expect(maintenanceError.message).toContain(failure.message);
    const taskFailureMessage = (failures[1] as Error).message;
    expect(taskFailureMessage).not.toBe('');
    expect(maintenanceError.message).toContain(taskFailureMessage);
    expect(injected).toBe(true);
    expect(fs.readFileSync(sourcePair.snapshotPath)).toEqual(originalBytes);
    await expectOwnedPair(state, 'active');
    await expect(selectOwnedPair(state, 'archived')).resolves.toBeUndefined();

    fs.rmSync(cronFile, { recursive: true, force: true });
    fs.writeFileSync(cronFile, cronContents);
    const retry = await archiveDaemonSessions({
      sessionIds: [state.id],
      service: target.service,
      bridge: { closeSession: async () => {} },
      coordinator,
    });
    expect(retry).toMatchObject({
      archived: [],
      alreadyArchived: [state.id],
      errors: [],
    });
    await expect(selectOwnedPair(state, 'active')).resolves.toBeUndefined();
    await expectOwnedPair(state, 'archived');
    expect(
      (await readCronTasks(target.repo)).find(
        (task) => task.id === 'double-maintenance-failure',
      )?.enabled,
    ).toBe(false);
  });

  it('reports destination conflict without replacing its bytes and preserves the source', async () => {
    const target = makeRetentionRepo(root, 'primary');
    const state = await removedBinding(target);
    const conflict = path.join(
      path.dirname(
        target.service.getWorktreeSessionPathForArchiveState(
          state.id,
          'archived',
        ),
      ),
      state.archiveKey,
    );
    fs.mkdirSync(path.dirname(conflict), { recursive: true });
    fs.writeFileSync(conflict, 'keep-existing-archive\n');
    const oldBytes = fs.readFileSync(
      path.join(path.dirname(state.sidecarPath), state.archiveKey),
    );

    const result = await archiveDaemonSessions({
      sessionIds: [state.id],
      service: target.service,
      bridge: { closeSession: async () => {} },
      coordinator,
    });
    expect(result.archived).toEqual([state.id]);
    expect(result.errors).not.toHaveLength(0);
    expect(fs.readFileSync(conflict, 'utf8')).toBe('keep-existing-archive\n');
    expect(
      fs.readFileSync(
        path.join(path.dirname(state.sidecarPath), state.archiveKey),
      ),
    ).toEqual(oldBytes);
    const binding = await readWorktreeSessionStrict(
      target.service.getWorktreeSessionPathForArchiveState(
        state.id,
        'archived',
      ),
    );
    expect(binding.state).toBe('valid');
    await expectOwnedPair(state, 'active');
    await expect(selectOwnedPair(state, 'archived')).resolves.toBeUndefined();

    const retry = await archiveDaemonSessions({
      sessionIds: [state.id],
      service: target.service,
      bridge: { closeSession: async () => {} },
      coordinator,
    });
    expect(retry.archived).toEqual([]);
    expect(retry.alreadyArchived).toEqual([state.id]);
    expect(retry.errors).not.toHaveLength(0);
    expect(fs.readFileSync(conflict, 'utf8')).toBe('keep-existing-archive\n');
    expect(
      fs.readFileSync(
        path.join(path.dirname(state.sidecarPath), state.archiveKey),
      ),
    ).toEqual(oldBytes);
  });

  it('preserves a normal checkout and does not claim an unassociated archive', async () => {
    const target = makeRetentionRepo(root, 'primary');
    const session = await makeRetainedSession(target, {
      slug: 'ordinary-archive',
      dirty: true,
    });
    const meta = await buildWorktreeSnapshotMeta(session.worktreePath, {
      sessionId: session.id,
      slug: session.sidecar.slug,
      baseCommit: target.head,
    });
    const pair = await captureWorktreeSnapshot({
      worktreePath: session.worktreePath,
      snapshotDir: path.dirname(session.sidecarPath),
      meta,
    });
    await archiveDaemonSessions({
      sessionIds: [session.id],
      service: target.service,
      bridge: { closeSession: async () => {} },
      coordinator,
    });
    await unarchiveDaemonSessions({
      sessionIds: [session.id],
      service: target.service,
      coordinator,
    });
    expect(fs.existsSync(session.worktreePath)).toBe(true);
    expect(
      fs.readFileSync(path.join(session.worktreePath, '.qwen-session'), 'utf8'),
    ).toBe(session.id);
    expect(fs.existsSync(pair.snapshotPath)).toBe(true);
    expect(fs.existsSync(pair.metaPath)).toBe(true);
    const archivedSidecar =
      target.service.getWorktreeSessionPathForArchiveState(
        session.id,
        'archived',
      );
    expect(snapshotFiles(path.dirname(archivedSidecar), session.id)).toEqual(
      [],
    );
    const binding = await readWorktreeSessionStrict(session.sidecarPath);
    if (binding.state === 'valid') {
      expect(binding.session.worktreeRemoved).toBeUndefined();
    }
    expect(binding.state).toBe('valid');
  });
});
