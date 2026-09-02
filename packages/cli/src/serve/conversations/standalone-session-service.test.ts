/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  SessionNotFoundError,
  StandaloneSessionSpawnError,
} from '@qwen-code/acp-bridge/bridgeErrors';
import type {
  AcpSessionBridge,
  BridgeSessionSummary,
} from '@qwen-code/acp-bridge/bridgeTypes';
import {
  ApprovalMode,
  SessionIdCaseConflictError,
  SessionService,
  SessionStorageEntryError,
  SessionTranscriptDurabilityError,
  SessionWriterLostError,
  writeSessionPrs,
} from '@qwen-code/qwen-code-core';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceRuntime } from '../workspace-registry.js';
import { SessionArchiveCoordinator } from '../server/session-archive.js';
import { ConversationRuntimeOwnershipError } from './conversation-runtime-errors.js';
import {
  StandaloneSessionService,
  type StandaloneSessionServiceOptions,
} from './standalone-session-service.js';
import type {
  StandaloneDeletionJournal,
  StandaloneDeletionJournalEntry,
  StandaloneDeletionRecordV2,
} from './standalone-deletion-journal.js';

const { listWorkspaceSessionsForResponse } = vi.hoisted(() => ({
  listWorkspaceSessionsForResponse: vi.fn(),
}));

vi.mock('../server/session-list.js', () => ({
  listWorkspaceSessionsForResponse,
}));

const sessionId = '11111111-1111-4111-8111-111111111111';
const root = {
  configuredRoot: '/conversations',
  canonicalRoot: '/conversations',
  device: 1,
  inode: 2,
  inodeVerifiable: true,
};
const identity = {
  root,
  storageSessionId: sessionId,
  name: 'conversation-child',
  canonicalPath: '/conversations/conversation-child',
  device: 1,
  inode: 3,
};

interface Harness {
  service: StandaloneSessionService;
  runtime: WorkspaceRuntime;
  bridge: {
    [K in keyof Pick<
      AcpSessionBridge,
      | 'spawnStandaloneSession'
      | 'restoreStandaloneSession'
      | 'getSessionSummary'
      | 'getSessionCurrentCwd'
      | 'changeSessionCwd'
      | 'commitManagedConversationBinding'
      | 'releaseManagedConversationBinding'
      | 'getSessionEventEpoch'
      | 'getSessionLastEventId'
      | 'sendPrompt'
      | 'updateSessionMetadata'
      | 'killSession'
      | 'detachClient'
      | 'deleteSessionAttachments'
      | 'markSessionCatalogChanged'
    >]: ReturnType<typeof vi.fn>;
  };
  reservation: { release: ReturnType<typeof vi.fn> };
  restoreReservation: { release: ReturnType<typeof vi.fn> };
  ensureRuntime: ReturnType<typeof vi.fn>;
  inspectStandaloneDirectory: ReturnType<typeof vi.fn>;
  ensureStandaloneDirectory: ReturnType<typeof vi.fn>;
  lifecycle: SessionArchiveCoordinator;
  quarantineRuntime: ReturnType<typeof vi.fn>;
  hasForeignSessionOwner: ReturnType<typeof vi.fn>;
  invalidateSessionListCache: ReturnType<typeof vi.fn>;
  deletionJournal: {
    [K in keyof Pick<
      StandaloneDeletionJournal,
      | 'listSessionIds'
      | 'hasRecord'
      | 'read'
      | 'writePrepared'
      | 'writeStaged'
      | 'clear'
    >]: ReturnType<typeof vi.fn>;
  };
  inspectStandaloneDeletionPaths: ReturnType<typeof vi.fn>;
  stageStandaloneDirectory: ReturnType<typeof vi.fn>;
  restoreStagedStandaloneDirectory: ReturnType<typeof vi.fn>;
  removeStagedStandaloneDirectory: ReturnType<typeof vi.fn>;
  confirmStandaloneRootDurability: ReturnType<typeof vi.fn>;
  getWorkspaceProvidersStatus: ReturnType<typeof vi.fn>;
  assertExactRoot: ReturnType<typeof vi.fn>;
}

function createHarness(): Harness {
  let restoredSummary: BridgeSessionSummary | undefined;
  const bridge = {
    spawnStandaloneSession: vi.fn(async () => ({
      sessionId,
      workspaceCwd: root.canonicalRoot,
      attached: false,
      sourceType: 'standalone',
      sourcePersisted: true,
    })),
    getSessionSummary: vi.fn(() => {
      if (restoredSummary) return restoredSummary;
      throw new SessionNotFoundError(sessionId);
    }),
    getSessionCurrentCwd: vi.fn(() => identity.canonicalPath),
    restoreStandaloneSession: vi.fn(async (_action, request) => {
      restoredSummary = {
        sessionId,
        workspaceCwd: root.canonicalRoot,
        createdAt: '2026-08-24T00:00:00.000Z',
        sourceType: 'standalone',
        clientCount: 0,
        hasActivePrompt: false,
      };
      return {
        sessionId,
        workspaceCwd: root.canonicalRoot,
        currentCwd: root.canonicalRoot,
        attached: false,
        ...(request.clientId !== undefined
          ? { clientId: request.clientId }
          : {}),
        sourceType: 'standalone',
        state: {},
      };
    }),
    changeSessionCwd: vi.fn(async () => ({
      previousCwd: root.canonicalRoot,
      newCwd: identity.canonicalPath,
      warnings: [],
    })),
    commitManagedConversationBinding: vi.fn(async () => undefined),
    releaseManagedConversationBinding: vi.fn(async () => undefined),
    getSessionEventEpoch: vi.fn(() => 'epoch-1'),
    getSessionLastEventId: vi.fn(() => 7),
    sendPrompt: vi.fn((_id, _request, _signal, context) => {
      context?.onPromptAdmitted?.();
      return Promise.resolve({ stopReason: 'end_turn' });
    }),
    updateSessionMetadata: vi.fn((_id, metadata) => metadata),
    killSession: vi.fn(async () => true),
    detachClient: vi.fn(async () => undefined),
    deleteSessionAttachments: vi.fn(async () => undefined),
    markSessionCatalogChanged: vi.fn(),
  };
  const getWorkspaceProvidersStatus = vi.fn(async () => ({
    v: 1 as const,
    workspaceCwd: root.canonicalRoot,
    initialized: true,
    acpChannelLive: false,
    current: { authType: 'openai', modelId: 'qwen-test' },
    approvalMode: 'default' as const,
    providers: [],
  }));
  const runtime = {
    workspaceId: 'conversations',
    workspaceCwd: root.canonicalRoot,
    sessionRuntimeBaseDir: '/runtime',
    primary: false,
    provenance: 'live-conversation',
    trusted: true,
    removable: false,
    bridge: bridge as unknown as AcpSessionBridge,
    workspaceService: { getWorkspaceProvidersStatus },
  } as unknown as WorkspaceRuntime;
  const reservation = { release: vi.fn() };
  const restoreReservation = { release: vi.fn() };
  let runtimeQuarantined = false;
  const quarantineRuntime = vi.fn(async (candidate: WorkspaceRuntime) => {
    runtimeQuarantined = true;
    service.freezeForTerminalQuarantine(candidate);
  });
  const invalidateSessionListCache = vi.fn();
  const hasForeignSessionOwner = vi.fn(async () => false);
  const ensureRuntime = vi.fn(async () => runtime);
  const inspectStandaloneDirectory = vi.fn(async () => ({
    status: 'ready' as const,
    identity,
  }));
  const ensureStandaloneDirectory = vi.fn(async () => ({
    status: 'recreated' as const,
    identity,
  }));
  const deletionJournal = {
    listSessionIds: vi.fn(async () => []),
    hasRecord: vi.fn(async () => false),
    read: vi.fn(async () => undefined),
    writePrepared: vi.fn(async () => undefined),
    writeStaged: vi.fn(async () => undefined),
    clear: vi.fn(async () => undefined),
  };
  const inspectStandaloneDeletionPaths = vi.fn(async () => ({
    status: 'normal' as const,
    identity,
  }));
  const stageStandaloneDirectory = vi.fn(async () => ({
    ...identity,
    name: `${identity.name}.deleting`,
    canonicalPath: `${identity.canonicalPath}.deleting`,
  }));
  const restoreStagedStandaloneDirectory = vi.fn(async () => identity);
  const removeStagedStandaloneDirectory = vi.fn(async () => undefined);
  const confirmStandaloneRootDurability = vi.fn(async () => undefined);
  const assertExactRoot = vi.fn(async () => root);
  const lifecycle = new SessionArchiveCoordinator();
  const options: StandaloneSessionServiceOptions = {
    ensureRuntime,
    assertRuntimeCurrent: vi.fn(() => {
      if (runtimeQuarantined) {
        throw Object.assign(new Error('Conversation runtime unavailable'), {
          code: 'conversation_runtime_unavailable',
        });
      }
    }),
    quarantineRuntime,
    runRuntimeActivity: async (_runtime, operation) => operation(),
    workspace: {
      assertExactRoot,
      prepareStandaloneDirectory: vi.fn(async () => ({
        identity,
        created: true,
      })),
      inspectStandaloneDirectory,
      ensureStandaloneDirectory,
      inspectStandaloneDeletionPaths,
      createStandaloneDeletionExpectation: vi.fn(async () => identity),
      stageStandaloneDirectory,
      restoreStagedStandaloneDirectory,
      removeStagedStandaloneDirectory,
      confirmStandaloneRootDurability,
    },
    deletionJournal: deletionJournal as unknown as StandaloneDeletionJournal,
    lifecycle,
    requestedSessionIdAdmission: {
      reserveCreate: vi.fn(async () => reservation),
      reserveRestore: vi.fn(() => restoreReservation),
    },
    hasForeignSessionOwner,
    invalidateSessionListCache,
  };
  const service = new StandaloneSessionService(options);
  return {
    service,
    runtime,
    bridge,
    reservation,
    restoreReservation,
    ensureRuntime,
    inspectStandaloneDirectory,
    ensureStandaloneDirectory,
    lifecycle,
    quarantineRuntime,
    hasForeignSessionOwner,
    invalidateSessionListCache,
    deletionJournal,
    inspectStandaloneDeletionPaths,
    stageStandaloneDirectory,
    restoreStagedStandaloneDirectory,
    removeStagedStandaloneDirectory,
    confirmStandaloneRootDurability,
    getWorkspaceProvidersStatus,
    assertExactRoot,
  };
}

function mockDurableStandalone(): void {
  vi.spyOn(SessionService.prototype, 'findSessionIdIgnoringCase')
    .mockResolvedValueOnce(undefined)
    .mockResolvedValue(sessionId);
  vi.spyOn(SessionService.prototype, 'getSessionLocation').mockResolvedValue(
    'active',
  );
  vi.spyOn(
    SessionService.prototype,
    'readCreationMetadataIfReadable',
  ).mockResolvedValue({ sourceType: 'standalone' });
}

function mockActiveStandalone(storageSessionId = sessionId): void {
  vi.spyOn(
    SessionService.prototype,
    'findSessionIdIgnoringCase',
  ).mockResolvedValue(storageSessionId);
  vi.spyOn(SessionService.prototype, 'getSessionLocation').mockResolvedValue(
    'active',
  );
  vi.spyOn(
    SessionService.prototype,
    'readCreationMetadataIfReadable',
  ).mockResolvedValue({ sourceType: 'standalone' });
}

function mockActiveLegacyStandalone(storageSessionId = sessionId): void {
  vi.spyOn(
    SessionService.prototype,
    'findSessionIdIgnoringCase',
  ).mockResolvedValue(storageSessionId);
  vi.spyOn(SessionService.prototype, 'getSessionLocation').mockResolvedValue(
    'active',
  );
  vi.spyOn(
    SessionService.prototype,
    'readCreationMetadataIfReadable',
  ).mockResolvedValue({ sourceType: 'default' });
}

function mockArchivedStandalone(storageSessionId = sessionId): void {
  vi.spyOn(
    SessionService.prototype,
    'findSessionIdIgnoringCase',
  ).mockResolvedValue(storageSessionId);
  vi.spyOn(SessionService.prototype, 'getSessionLocation').mockResolvedValue(
    'archived',
  );
  vi.spyOn(
    SessionService.prototype,
    'readCreationMetadataIfReadable',
  ).mockResolvedValue({ sourceType: 'standalone' });
}

function mockWriterLease(): {
  assertOwnedAndUnchanged: ReturnType<typeof vi.fn>;
  assertCleanupOwned: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
  isReleased: boolean;
  isReleaseDurabilityPending: boolean;
} {
  const lease = {
    assertOwnedAndUnchanged: vi.fn(async () => undefined),
    assertCleanupOwned: vi.fn(),
    release: vi.fn(async () => undefined),
    isReleased: false,
    isReleaseDurabilityPending: false,
  };
  vi.spyOn(
    SessionService.prototype,
    'acquireSessionWriterLease',
  ).mockResolvedValue(lease as never);
  vi.spyOn(
    SessionService.prototype,
    'acquireSessionMaintenanceLease',
  ).mockResolvedValue(lease as never);
  vi.spyOn(
    SessionService.prototype,
    'confirmSessionTranscriptDeletionForLifecycle',
  ).mockResolvedValue();
  vi.spyOn(
    SessionService.prototype,
    'getSessionTranscriptParentIdentityForLifecycle',
  ).mockResolvedValue({ device: 11, inode: 12, inodeVerifiable: true });
  vi.spyOn(
    SessionService.prototype,
    'getSessionTranscriptLocationForLifecycle',
  ).mockResolvedValue(undefined);
  return lease;
}

function deletionEntry(phase: 'prepared' | 'staged' = 'staged'): {
  prepared: StandaloneDeletionRecordV2;
  staged?: StandaloneDeletionRecordV2;
} {
  const prepared = {
    version: 2 as const,
    phase: 'prepared' as const,
    sessionId,
    storageSessionId: sessionId,
    transcriptLocation: 'active' as const,
    transcriptParent: {
      device: 11,
      inode: 12,
      inodeVerifiable: true,
    },
    root: {
      canonicalPath: root.canonicalRoot,
      device: root.device,
      inode: root.inode,
      inodeVerifiable: root.inodeVerifiable,
    },
    directory: {
      kind: 'present' as const,
      normalName: identity.name,
      stagedName: `${identity.name}.deleting`,
      device: identity.device,
      inode: identity.inode,
      inodeVerifiable: true,
    },
  };
  return phase === 'prepared'
    ? { prepared }
    : { prepared, staged: { ...prepared, phase: 'staged' } };
}

function legacyDeletionEntry(): StandaloneDeletionJournalEntry {
  const current = deletionEntry().prepared;
  return {
    prepared: {
      version: 1,
      phase: 'prepared',
      sessionId: current.sessionId,
      storageSessionId: current.storageSessionId,
      transcriptLocation: current.transcriptLocation,
      root: current.root,
      directory: current.directory,
    },
    staged: {
      version: 1,
      phase: 'staged',
      sessionId: current.sessionId,
      storageSessionId: current.storageSessionId,
      transcriptLocation: current.transcriptLocation,
      root: current.root,
      directory: current.directory,
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('StandaloneSessionService', () => {
  it('reads options from the exact runtime without exposing its cwd', async () => {
    const harness = createHarness();

    const options = await harness.service.getOptions();

    expect(harness.ensureRuntime).toHaveBeenCalledOnce();
    expect(harness.assertExactRoot).toHaveBeenCalledWith(root.canonicalRoot);
    expect(harness.getWorkspaceProvidersStatus).toHaveBeenCalledWith({
      route: 'GET /standalone/session-options',
      workspaceCwd: root.canonicalRoot,
    });
    expect(options).toEqual({
      v: 1,
      initialized: true,
      current: { authType: 'openai', modelId: 'qwen-test' },
      approvalMode: 'default',
      providers: [],
    });
    expect(options).not.toHaveProperty('workspaceCwd');
    expect(options).not.toHaveProperty('acpChannelLive');
    expect(harness.bridge.spawnStandaloneSession).not.toHaveBeenCalled();
  });

  it('fails closed when provider status belongs to another runtime', async () => {
    const harness = createHarness();
    harness.getWorkspaceProvidersStatus.mockResolvedValueOnce({
      v: 1,
      workspaceCwd: '/other',
      initialized: true,
      providers: [],
    });

    await expect(harness.service.getOptions()).rejects.toMatchObject({
      code: 'conversation_runtime_ownership_compromised',
      retryable: false,
    });
  });

  it('fails closed when the runtime is quarantined during the read', async () => {
    const harness = createHarness();
    harness.getWorkspaceProvidersStatus.mockImplementationOnce(async () => {
      await harness.quarantineRuntime(harness.runtime);
      return {
        v: 1,
        workspaceCwd: root.canonicalRoot,
        initialized: true,
        providers: [],
      };
    });

    await expect(harness.service.getOptions()).rejects.toMatchObject({
      code: 'conversation_runtime_unavailable',
    });
  });

  it('creates a durable standalone session without admitting a prompt', async () => {
    mockDurableStandalone();
    const harness = createHarness();

    const created = await harness.service.create({ sessionId });

    expect(created).toMatchObject({
      session: {
        sessionId,
        sourceType: 'standalone',
        currentCwd: identity.canonicalPath,
      },
      projectlessOutputDirectory: identity.canonicalPath,
      workingDirectory: { state: 'ready' },
    });
    expect(harness.bridge.sendPrompt).not.toHaveBeenCalled();
    expect(harness.bridge.spawnStandaloneSession).toHaveBeenCalledOnce();
    expect(harness.reservation.release).toHaveBeenCalledOnce();
  });

  it('detaches a create response client from its origin runtime after rollover', async () => {
    mockDurableStandalone();
    const harness = createHarness();
    harness.bridge.spawnStandaloneSession.mockResolvedValueOnce({
      sessionId,
      clientId: 'response-client',
      workspaceCwd: root.canonicalRoot,
      attached: false,
      sourceType: 'standalone',
      sourcePersisted: true,
    });

    const created = await harness.service.create({ sessionId });
    await harness.quarantineRuntime(harness.runtime);
    await harness.service.cleanupDisconnectedCreate(created);

    expect(harness.bridge.detachClient).toHaveBeenCalledWith(
      sessionId,
      'response-client',
    );
  });

  it('retains the create origin when response cleanup must be retried', async () => {
    mockDurableStandalone();
    const harness = createHarness();
    harness.bridge.spawnStandaloneSession.mockResolvedValueOnce({
      sessionId,
      clientId: 'response-client',
      workspaceCwd: root.canonicalRoot,
      attached: false,
      sourceType: 'standalone',
      sourcePersisted: true,
    });
    harness.bridge.detachClient.mockRejectedValueOnce(new Error('transient'));

    const created = await harness.service.create({ sessionId });
    await expect(
      harness.service.cleanupDisconnectedCreate(created),
    ).rejects.toThrow('transient');
    await expect(
      harness.service.cleanupDisconnectedCreate(created),
    ).resolves.toBeUndefined();

    expect(harness.bridge.detachClient).toHaveBeenCalledTimes(2);
  });

  it('retries deletion reconciliation after a transient sweep failure', async () => {
    mockActiveStandalone();
    const harness = createHarness();
    harness.deletionJournal.listSessionIds
      .mockRejectedValueOnce(
        Object.assign(new Error('transient'), { code: 'EIO' }),
      )
      .mockResolvedValueOnce([]);
    harness.bridge.getSessionSummary.mockReturnValue({
      sessionId,
      workspaceCwd: root.canonicalRoot,
      sourceType: 'standalone',
      clientCount: 1,
      hasActivePrompt: false,
    });

    await expect(
      harness.service.rename(sessionId, 'First attempt'),
    ).rejects.toMatchObject({ code: 'EIO' });
    await expect(
      harness.service.rename(sessionId, 'Second attempt'),
    ).resolves.toEqual({ sessionId, displayName: 'Second attempt' });

    expect(harness.deletionJournal.listSessionIds).toHaveBeenCalledTimes(2);
    expect(harness.bridge.updateSessionMetadata).toHaveBeenCalledOnce();
  });

  it('repeats deletion reconciliation after a successful sweep', async () => {
    mockActiveStandalone();
    const harness = createHarness();
    harness.bridge.getSessionSummary.mockReturnValue({
      sessionId,
      workspaceCwd: root.canonicalRoot,
      sourceType: 'standalone',
      clientCount: 1,
      hasActivePrompt: false,
    });

    await harness.service.rename(sessionId, 'First name');
    await harness.service.rename(sessionId, 'Second name');

    expect(harness.deletionJournal.listSessionIds).toHaveBeenCalledTimes(2);
  });

  it('fails read-only exact lookup closed while deletion is journaled', async () => {
    mockActiveStandalone();
    vi.spyOn(SessionService.prototype, 'getSessionListItem').mockResolvedValue({
      sessionId,
      cwd: root.canonicalRoot,
      startTime: '2026-08-24T00:00:00.000Z',
      mtime: Date.parse('2026-08-24T00:00:00.000Z'),
      filePath: '/runtime/chats/session.jsonl',
      messageCount: 1,
      prompt: 'hello',
    });
    const harness = createHarness();
    harness.deletionJournal.hasRecord.mockResolvedValueOnce(true);

    await expect(harness.service.get(sessionId)).rejects.toMatchObject({
      code: 'standalone_session_conflict',
      retryable: true,
    });

    expect(harness.deletionJournal.read).not.toHaveBeenCalled();
  });

  it('renames a verified live standalone through the bridge', async () => {
    mockActiveStandalone();
    const harness = createHarness();
    harness.bridge.getSessionSummary.mockReturnValue({
      sessionId,
      workspaceCwd: root.canonicalRoot,
      sourceType: 'standalone',
      clientCount: 1,
      hasActivePrompt: false,
    });

    await expect(
      harness.service.rename(sessionId, 'Named session', 'client-1'),
    ).resolves.toEqual({ sessionId, displayName: 'Named session' });

    expect(harness.bridge.updateSessionMetadata).toHaveBeenCalledWith(
      sessionId,
      { displayName: 'Named session' },
      { clientId: 'client-1' },
    );
  });

  it('renames a cold standalone through the fenced lifecycle primitive', async () => {
    mockActiveStandalone();
    const harness = createHarness();
    const lease = mockWriterLease();
    const rename = vi
      .spyOn(SessionService.prototype, 'renameSessionForLifecycle')
      .mockImplementation(async (_id, _title, _source, _location, options) => {
        await options?.assertStorageUnchanged?.();
        options?.assertCanMutate?.();
        return true;
      });
    const ordinaryRename = vi.spyOn(SessionService.prototype, 'renameSession');

    await expect(
      harness.service.rename(sessionId, 'Named session'),
    ).resolves.toEqual({ sessionId, displayName: 'Named session' });

    expect(rename).toHaveBeenCalledWith(
      sessionId,
      'Named session',
      'manual',
      'active',
      expect.objectContaining({
        assertStorageUnchanged: expect.any(Function),
        assertCanMutate: expect.any(Function),
      }),
    );
    expect(lease.assertOwnedAndUnchanged).toHaveBeenCalledOnce();
    expect(ordinaryRename).not.toHaveBeenCalled();
  });

  it.each(['', '   ', 'bad\nname', 'x'.repeat(257)])(
    'rejects an invalid standalone display name before runtime work',
    async (displayName) => {
      const harness = createHarness();

      await expect(
        harness.service.rename(sessionId, displayName),
      ).rejects.toMatchObject({ code: 'invalid_request' });
      expect(harness.ensureRuntime).not.toHaveBeenCalled();
    },
  );

  it('archives and unarchives only top-level standalone transcripts', async () => {
    const archiveHarness = createHarness();
    mockActiveStandalone();
    const archiveLease = mockWriterLease();
    const archive = vi
      .spyOn(SessionService.prototype, 'archiveSessions')
      .mockResolvedValue({
        archived: [sessionId],
        alreadyArchived: [],
        resolvedConflicts: [],
        notFound: [],
        errors: [],
      });

    await expect(archiveHarness.service.archive([sessionId])).resolves.toEqual({
      archived: [sessionId],
      alreadyArchived: [],
      notFound: [],
      errors: [],
    });
    const archiveOptions = archive.mock.calls[0]?.[1];
    expect(archiveOptions).toEqual(
      expect.objectContaining({
        assertCanMutate: expect.any(Function),
        assertCleanupOwned: expect.any(Function),
      }),
    );
    archiveOptions?.assertCleanupOwned?.();
    expect(archiveLease.assertCleanupOwned).toHaveBeenCalledOnce();
    expect(archiveLease.release).toHaveBeenCalledOnce();

    vi.restoreAllMocks();
    const unarchiveHarness = createHarness();
    mockArchivedStandalone();
    const unarchiveLease = mockWriterLease();
    const unarchive = vi
      .spyOn(SessionService.prototype, 'unarchiveSessions')
      .mockResolvedValue({
        unarchived: [sessionId],
        alreadyActive: [],
        resolvedConflicts: [],
        notFound: [],
        errors: [],
      });

    await expect(
      unarchiveHarness.service.unarchive([sessionId]),
    ).resolves.toEqual({
      unarchived: [sessionId],
      alreadyActive: [],
      notFound: [],
      errors: [],
    });
    const unarchiveOptions = unarchive.mock.calls[0]?.[1];
    expect(unarchiveOptions).toEqual(
      expect.objectContaining({
        assertCanMutate: expect.any(Function),
        assertCleanupOwned: expect.any(Function),
      }),
    );
    unarchiveOptions?.assertCleanupOwned?.();
    expect(unarchiveLease.assertCleanupOwned).toHaveBeenCalledOnce();
    expect(unarchiveLease.release).toHaveBeenCalledOnce();
  });

  it('does not misreport an unexpected batch failure as a session conflict', async () => {
    mockActiveStandalone();
    const harness = createHarness();
    mockWriterLease();
    vi.spyOn(SessionService.prototype, 'archiveSessions').mockRejectedValue(
      new Error('storage unavailable'),
    );

    await expect(harness.service.archive([sessionId])).resolves.toMatchObject({
      archived: [],
      errors: [
        {
          sessionId,
          code: 'standalone_session_operation_failed',
        },
      ],
    });
  });

  it('invalidates the catalog when archive cleanup fails after the move', async () => {
    mockActiveStandalone();
    const harness = createHarness();
    mockWriterLease();
    vi.mocked(SessionService.prototype.getSessionLocation)
      .mockResolvedValueOnce('active')
      .mockResolvedValueOnce('active')
      .mockResolvedValue('archived');
    vi.spyOn(SessionService.prototype, 'archiveSessions').mockResolvedValue({
      archived: [],
      alreadyArchived: [],
      resolvedConflicts: [],
      notFound: [],
      errors: [{ sessionId, error: new SessionWriterLostError() }],
    });

    await expect(harness.service.archive([sessionId])).resolves.toMatchObject({
      archived: [],
      errors: [
        {
          sessionId,
          code: 'standalone_session_operation_failed',
        },
      ],
    });

    expect(harness.bridge.markSessionCatalogChanged).toHaveBeenCalledOnce();
    expect(harness.invalidateSessionListCache).toHaveBeenCalledWith(
      harness.runtime,
    );
  });

  it('invalidates the catalog when unarchive cleanup fails after the move', async () => {
    mockArchivedStandalone();
    const harness = createHarness();
    mockWriterLease();
    vi.mocked(SessionService.prototype.getSessionLocation)
      .mockResolvedValueOnce('archived')
      .mockResolvedValueOnce('archived')
      .mockResolvedValue('active');
    vi.spyOn(SessionService.prototype, 'unarchiveSessions').mockResolvedValue({
      unarchived: [],
      alreadyActive: [],
      resolvedConflicts: [],
      notFound: [],
      errors: [{ sessionId, error: new SessionWriterLostError() }],
    });

    await expect(harness.service.unarchive([sessionId])).resolves.toMatchObject(
      {
        unarchived: [],
        errors: [
          {
            sessionId,
            code: 'standalone_session_operation_failed',
          },
        ],
      },
    );

    expect(harness.bridge.markSessionCatalogChanged).toHaveBeenCalledOnce();
    expect(harness.invalidateSessionListCache).toHaveBeenCalledWith(
      harness.runtime,
    );
  });

  it('journals, stages, commits, and cleans a standalone deletion', async () => {
    mockActiveStandalone();
    const harness = createHarness();
    const lease = mockWriterLease();
    vi.spyOn(
      SessionService.prototype,
      'removeSessionTranscriptForLifecycle',
    ).mockResolvedValue(true);
    const cleanupRemovedState = vi
      .spyOn(SessionService.prototype, 'cleanupRemovedSessionStateForLifecycle')
      .mockResolvedValue();

    await expect(harness.service.delete([sessionId])).resolves.toEqual({
      removed: [sessionId],
      notFound: [],
      errors: [],
      fileCleanupPending: [],
    });

    expect(harness.deletionJournal.writePrepared).toHaveBeenCalledOnce();
    expect(harness.stageStandaloneDirectory).toHaveBeenCalledWith(
      sessionId,
      identity,
    );
    expect(harness.deletionJournal.writeStaged).toHaveBeenCalledOnce();
    expect(harness.removeStagedStandaloneDirectory).toHaveBeenCalledWith(
      sessionId,
      identity,
    );
    expect(harness.bridge.deleteSessionAttachments).toHaveBeenCalledWith(
      sessionId,
      { assertCanCommit: expect.any(Function) },
    );
    expect(harness.deletionJournal.clear).toHaveBeenCalledOnce();
    const cleanupOptions = cleanupRemovedState.mock.calls[0]?.[1];
    expect(cleanupOptions).toEqual({
      assertCanMutate: expect.any(Function),
      assertCleanupOwned: expect.any(Function),
    });
    cleanupOptions?.assertCleanupOwned?.();
    expect(lease.assertCleanupOwned).toHaveBeenCalledOnce();
    expect(lease.release).toHaveBeenCalledOnce();
  });

  it('does not begin deletion while another runtime owns the id', async () => {
    mockActiveStandalone();
    const harness = createHarness();
    harness.hasForeignSessionOwner.mockResolvedValueOnce(true);

    await expect(harness.service.delete([sessionId])).resolves.toMatchObject({
      removed: [],
      errors: [
        {
          sessionId,
          code: 'standalone_session_conflict',
        },
      ],
    });

    expect(harness.deletionJournal.writePrepared).not.toHaveBeenCalled();
    expect(harness.bridge.killSession).not.toHaveBeenCalled();
  });

  it('retains deletion evidence when post-commit cleanup fails', async () => {
    mockActiveStandalone();
    const harness = createHarness();
    mockWriterLease();
    vi.spyOn(
      SessionService.prototype,
      'removeSessionTranscriptForLifecycle',
    ).mockResolvedValue(true);
    vi.spyOn(
      SessionService.prototype,
      'cleanupRemovedSessionStateForLifecycle',
    ).mockRejectedValue(new Error('sidecar I/O failed'));

    await expect(harness.service.delete([sessionId])).resolves.toEqual({
      removed: [sessionId],
      notFound: [],
      errors: [],
      fileCleanupPending: [sessionId],
    });

    expect(harness.deletionJournal.clear).not.toHaveBeenCalled();
    expect(harness.removeStagedStandaloneDirectory).toHaveBeenCalledOnce();
  });

  it('stops destructive cleanup when deletion loses writer ownership', async () => {
    mockActiveStandalone();
    const harness = createHarness();
    mockWriterLease();
    vi.spyOn(
      SessionService.prototype,
      'removeSessionTranscriptForLifecycle',
    ).mockResolvedValue(true);
    vi.spyOn(
      SessionService.prototype,
      'cleanupRemovedSessionStateForLifecycle',
    ).mockRejectedValue(new SessionWriterLostError());

    await expect(harness.service.delete([sessionId])).resolves.toEqual({
      removed: [sessionId],
      notFound: [],
      errors: [],
      fileCleanupPending: [sessionId],
    });

    expect(harness.bridge.deleteSessionAttachments).not.toHaveBeenCalled();
    expect(harness.removeStagedStandaloneDirectory).not.toHaveBeenCalled();
    expect(harness.deletionJournal.clear).not.toHaveBeenCalled();
  });

  it('stops destructive cleanup when deletion loses runtime ownership', async () => {
    mockActiveStandalone();
    const harness = createHarness();
    mockWriterLease();
    vi.spyOn(
      SessionService.prototype,
      'removeSessionTranscriptForLifecycle',
    ).mockResolvedValue(true);
    vi.spyOn(
      SessionService.prototype,
      'cleanupRemovedSessionStateForLifecycle',
    ).mockRejectedValue(
      new ConversationRuntimeOwnershipError(
        'conversation_runtime_unavailable',
        true,
      ),
    );

    await expect(harness.service.delete([sessionId])).resolves.toEqual({
      removed: [sessionId],
      notFound: [],
      errors: [],
      fileCleanupPending: [sessionId],
    });

    expect(harness.bridge.deleteSessionAttachments).not.toHaveBeenCalled();
    expect(harness.removeStagedStandaloneDirectory).not.toHaveBeenCalled();
    expect(harness.deletionJournal.clear).not.toHaveBeenCalled();
  });

  it('retains deletion evidence when attachment cleanup fails', async () => {
    mockActiveStandalone();
    const harness = createHarness();
    mockWriterLease();
    vi.spyOn(
      SessionService.prototype,
      'removeSessionTranscriptForLifecycle',
    ).mockResolvedValue(true);
    vi.spyOn(
      SessionService.prototype,
      'cleanupRemovedSessionStateForLifecycle',
    ).mockResolvedValue();
    harness.bridge.deleteSessionAttachments.mockRejectedValueOnce(
      new Error('attachment I/O failed'),
    );

    await expect(harness.service.delete([sessionId])).resolves.toEqual({
      removed: [sessionId],
      notFound: [],
      errors: [],
      fileCleanupPending: [sessionId],
    });

    expect(harness.deletionJournal.clear).not.toHaveBeenCalled();
  });

  it('retries a durability-pending lease before exact deletion recovery', async () => {
    mockActiveStandalone();
    const harness = createHarness();
    const lease = mockWriterLease();
    lease.release
      .mockImplementationOnce(async () => {
        lease.isReleased = true;
        lease.isReleaseDurabilityPending = true;
        throw new Error('release I/O failed');
      })
      .mockRejectedValueOnce(new Error('release I/O failed'))
      .mockImplementation(async () => {
        lease.isReleaseDurabilityPending = false;
      });
    vi.spyOn(
      SessionService.prototype,
      'removeSessionTranscriptForLifecycle',
    ).mockResolvedValue(true);
    vi.spyOn(
      SessionService.prototype,
      'cleanupRemovedSessionStateForLifecycle',
    ).mockResolvedValue();

    await expect(harness.service.delete([sessionId])).resolves.toEqual({
      removed: [sessionId],
      notFound: [],
      errors: [],
      fileCleanupPending: [sessionId],
    });
    expect(harness.deletionJournal.clear).not.toHaveBeenCalled();

    vi.mocked(
      SessionService.prototype.findSessionIdIgnoringCase,
    ).mockResolvedValue(undefined);
    harness.deletionJournal.read.mockResolvedValueOnce(
      deletionEntry() as never,
    );
    harness.inspectStandaloneDeletionPaths.mockResolvedValueOnce({
      status: 'absent',
    });

    await expect(harness.service.delete([sessionId])).resolves.toEqual({
      removed: [sessionId],
      notFound: [],
      errors: [],
      fileCleanupPending: [],
    });

    expect(lease.release).toHaveBeenCalledTimes(4);
    expect(harness.deletionJournal.clear).toHaveBeenCalledOnce();
  });

  it('does not park a lost lease before exact deletion recovery', async () => {
    mockActiveStandalone();
    const harness = createHarness();
    const lostLease = mockWriterLease();
    lostLease.release.mockRejectedValue(new SessionWriterLostError());
    const nextLease = {
      assertOwnedAndUnchanged: vi.fn(async () => undefined),
      assertCleanupOwned: vi.fn(),
      release: vi.fn(async () => undefined),
      isReleased: false,
      isReleaseDurabilityPending: false,
    };
    vi.mocked(SessionService.prototype.acquireSessionWriterLease)
      .mockResolvedValueOnce(lostLease as never)
      .mockResolvedValueOnce(nextLease as never);
    vi.spyOn(
      SessionService.prototype,
      'removeSessionTranscriptForLifecycle',
    ).mockResolvedValue(true);
    vi.spyOn(
      SessionService.prototype,
      'cleanupRemovedSessionStateForLifecycle',
    ).mockResolvedValue();

    await expect(harness.service.delete([sessionId])).resolves.toEqual({
      removed: [sessionId],
      notFound: [],
      errors: [],
      fileCleanupPending: [sessionId],
    });

    vi.mocked(
      SessionService.prototype.findSessionIdIgnoringCase,
    ).mockResolvedValue(undefined);
    harness.deletionJournal.read.mockResolvedValueOnce(
      deletionEntry() as never,
    );
    harness.inspectStandaloneDeletionPaths.mockResolvedValueOnce({
      status: 'absent',
    });

    await expect(harness.service.delete([sessionId])).resolves.toEqual({
      removed: [sessionId],
      notFound: [],
      errors: [],
      fileCleanupPending: [],
    });

    expect(
      SessionService.prototype.acquireSessionWriterLease,
    ).toHaveBeenCalledTimes(2);
    expect(nextLease.release).toHaveBeenCalledOnce();
    expect(harness.deletionJournal.clear).toHaveBeenCalledOnce();
  });

  it('evicts a parked lost lease before exact deletion recovery', async () => {
    mockActiveStandalone();
    const harness = createHarness();
    const lostLease = mockWriterLease();
    lostLease.release
      .mockImplementationOnce(async () => {
        lostLease.isReleased = true;
        lostLease.isReleaseDurabilityPending = true;
        throw new Error('release I/O failed');
      })
      .mockRejectedValueOnce(new Error('release I/O failed'))
      .mockRejectedValueOnce(new SessionWriterLostError());
    const nextLease = {
      assertOwnedAndUnchanged: vi.fn(async () => undefined),
      assertCleanupOwned: vi.fn(),
      release: vi.fn(async () => undefined),
      isReleased: false,
      isReleaseDurabilityPending: false,
    };
    vi.mocked(SessionService.prototype.acquireSessionWriterLease)
      .mockResolvedValueOnce(lostLease as never)
      .mockResolvedValueOnce(nextLease as never);
    vi.spyOn(
      SessionService.prototype,
      'removeSessionTranscriptForLifecycle',
    ).mockResolvedValue(true);
    vi.spyOn(
      SessionService.prototype,
      'cleanupRemovedSessionStateForLifecycle',
    ).mockResolvedValue();

    await expect(harness.service.delete([sessionId])).resolves.toEqual({
      removed: [sessionId],
      notFound: [],
      errors: [],
      fileCleanupPending: [sessionId],
    });

    vi.mocked(
      SessionService.prototype.findSessionIdIgnoringCase,
    ).mockResolvedValue(undefined);
    harness.deletionJournal.read.mockResolvedValueOnce(
      deletionEntry() as never,
    );
    harness.inspectStandaloneDeletionPaths.mockResolvedValueOnce({
      status: 'absent',
    });

    await expect(harness.service.delete([sessionId])).resolves.toEqual({
      removed: [sessionId],
      notFound: [],
      errors: [],
      fileCleanupPending: [],
    });

    expect(lostLease.release).toHaveBeenCalledTimes(3);
    expect(
      SessionService.prototype.acquireSessionWriterLease,
    ).toHaveBeenCalledTimes(2);
    expect(nextLease.release).toHaveBeenCalledOnce();
    expect(harness.deletionJournal.clear).toHaveBeenCalledOnce();
  });

  it('rolls back a staged directory when recovery finds the transcript intact', async () => {
    mockActiveStandalone();
    const harness = createHarness();
    mockWriterLease();
    harness.deletionJournal.read.mockResolvedValueOnce(
      deletionEntry() as never,
    );
    harness.inspectStandaloneDeletionPaths.mockResolvedValueOnce({
      status: 'staged',
      identity: {
        ...identity,
        name: `${identity.name}.deleting`,
        canonicalPath: `${identity.canonicalPath}.deleting`,
      },
    });

    await expect(harness.service.create({ sessionId })).rejects.toMatchObject({
      code: 'standalone_session_conflict',
    });

    expect(harness.restoreStagedStandaloneDirectory).toHaveBeenCalledWith(
      sessionId,
      identity,
    );
    expect(harness.deletionJournal.clear).toHaveBeenCalledWith(sessionId, root);
  });

  it('finishes staged cleanup when recovery finds the transcript committed', async () => {
    vi.spyOn(
      SessionService.prototype,
      'findSessionIdIgnoringCase',
    ).mockResolvedValue(undefined);
    const cleanup = vi
      .spyOn(SessionService.prototype, 'cleanupRemovedSessionStateForLifecycle')
      .mockResolvedValue();
    const harness = createHarness();
    mockWriterLease();
    harness.deletionJournal.read.mockResolvedValueOnce(
      deletionEntry() as never,
    );
    harness.inspectStandaloneDeletionPaths.mockResolvedValueOnce({
      status: 'staged',
      identity: {
        ...identity,
        name: `${identity.name}.deleting`,
        canonicalPath: `${identity.canonicalPath}.deleting`,
      },
    });

    await expect(harness.service.delete([sessionId])).resolves.toEqual({
      removed: [sessionId],
      notFound: [],
      errors: [],
      fileCleanupPending: [],
    });

    expect(harness.removeStagedStandaloneDirectory).toHaveBeenCalledWith(
      sessionId,
      identity,
    );
    expect(cleanup).toHaveBeenCalledWith(
      sessionId,
      expect.objectContaining({ assertCanMutate: expect.any(Function) }),
    );
    expect(harness.bridge.deleteSessionAttachments).toHaveBeenCalledWith(
      sessionId,
      { assertCanCommit: expect.any(Function) },
    );
    expect(harness.deletionJournal.clear).toHaveBeenCalledWith(sessionId, root);
  });

  it('deletes an unreadable transcript before completing journal recovery', async () => {
    vi.spyOn(
      SessionService.prototype,
      'findSessionIdIgnoringCase',
    ).mockResolvedValue(undefined);
    const harness = createHarness();
    const lease = mockWriterLease();
    vi.spyOn(
      SessionService.prototype,
      'getSessionTranscriptLocationForLifecycle',
    )
      .mockResolvedValueOnce('active')
      .mockResolvedValue(undefined);
    const remove = vi
      .spyOn(SessionService.prototype, 'removeSessionTranscriptForLifecycle')
      .mockImplementation(async (_id, _location, _parent, options) => {
        await options?.assertStorageUnchanged?.();
        options?.assertCanMutate?.();
        return true;
      });
    harness.deletionJournal.read.mockResolvedValueOnce(
      deletionEntry() as never,
    );
    harness.inspectStandaloneDeletionPaths.mockResolvedValueOnce({
      status: 'staged',
      identity: {
        ...identity,
        name: `${identity.name}.deleting`,
        canonicalPath: `${identity.canonicalPath}.deleting`,
      },
    });

    await expect(harness.service.delete([sessionId])).resolves.toEqual({
      removed: [sessionId],
      notFound: [],
      errors: [],
      fileCleanupPending: [],
    });

    expect(remove).toHaveBeenCalledWith(
      sessionId,
      'active',
      deletionEntry().prepared.transcriptParent,
      expect.objectContaining({
        assertStorageUnchanged: expect.any(Function),
        assertCanMutate: expect.any(Function),
      }),
    );
    expect(
      SessionService.prototype.confirmSessionTranscriptDeletionForLifecycle,
    ).toHaveBeenCalledWith('active', deletionEntry().prepared.transcriptParent);
    expect(harness.deletionJournal.clear).toHaveBeenCalledOnce();
    expect(lease.assertOwnedAndUnchanged).toHaveBeenCalledTimes(2);
  });

  it('rolls back a legacy V1 journal while the transcript still exists', async () => {
    vi.spyOn(
      SessionService.prototype,
      'findSessionIdIgnoringCase',
    ).mockResolvedValue(undefined);
    const harness = createHarness();
    mockWriterLease();
    const remove = vi
      .spyOn(SessionService.prototype, 'removeSessionTranscriptForLifecycle')
      .mockResolvedValue(true);
    vi.mocked(
      SessionService.prototype.getSessionTranscriptLocationForLifecycle,
    ).mockResolvedValue('active');
    harness.deletionJournal.read.mockResolvedValueOnce(
      legacyDeletionEntry() as never,
    );
    harness.inspectStandaloneDeletionPaths.mockResolvedValueOnce({
      status: 'staged',
      identity: {
        ...identity,
        name: `${identity.name}.deleting`,
        canonicalPath: `${identity.canonicalPath}.deleting`,
      },
    });

    await expect(harness.service.delete([sessionId])).resolves.toEqual({
      removed: [],
      notFound: [sessionId],
      errors: [],
      fileCleanupPending: [],
    });

    expect(harness.restoreStagedStandaloneDirectory).toHaveBeenCalledOnce();
    expect(harness.deletionJournal.clear).toHaveBeenCalledOnce();
    expect(remove).not.toHaveBeenCalled();
  });

  it('keeps a legacy V1 journal when transcript deletion is already ambiguous', async () => {
    vi.spyOn(
      SessionService.prototype,
      'findSessionIdIgnoringCase',
    ).mockResolvedValue(undefined);
    const harness = createHarness();
    mockWriterLease();
    harness.deletionJournal.read.mockResolvedValueOnce(
      legacyDeletionEntry() as never,
    );
    harness.inspectStandaloneDeletionPaths.mockResolvedValueOnce({
      status: 'staged',
      identity: {
        ...identity,
        name: `${identity.name}.deleting`,
        canonicalPath: `${identity.canonicalPath}.deleting`,
      },
    });

    await expect(harness.service.delete([sessionId])).resolves.toMatchObject({
      removed: [],
      errors: [
        {
          sessionId,
          code: 'transcript_deletion_outcome_unknown',
        },
      ],
    });

    expect(harness.deletionJournal.clear).not.toHaveBeenCalled();
  });

  it('fails recovery closed for a foreign physical transcript', async () => {
    vi.spyOn(
      SessionService.prototype,
      'findSessionIdIgnoringCase',
    ).mockResolvedValue(undefined);
    const harness = createHarness();
    mockWriterLease();
    vi.spyOn(
      SessionService.prototype,
      'getSessionTranscriptLocationForLifecycle',
    ).mockRejectedValue(
      new SessionStorageEntryError(sessionId, 'foreign_project'),
    );
    harness.deletionJournal.read.mockResolvedValueOnce(
      deletionEntry() as never,
    );
    harness.inspectStandaloneDeletionPaths.mockResolvedValueOnce({
      status: 'staged',
      identity: {
        ...identity,
        name: `${identity.name}.deleting`,
        canonicalPath: `${identity.canonicalPath}.deleting`,
      },
    });

    await expect(harness.service.delete([sessionId])).resolves.toMatchObject({
      removed: [],
      errors: [{ code: 'deletion_recovery_compromised', sessionId }],
    });

    expect(harness.removeStagedStandaloneDirectory).not.toHaveBeenCalled();
    expect(harness.deletionJournal.clear).not.toHaveBeenCalled();
  });

  it('reports committed recovery cleanup failures as file cleanup pending', async () => {
    vi.spyOn(
      SessionService.prototype,
      'findSessionIdIgnoringCase',
    ).mockResolvedValue(undefined);
    vi.spyOn(
      SessionService.prototype,
      'cleanupRemovedSessionStateForLifecycle',
    ).mockRejectedValue(new Error('sidecar I/O failed'));
    const harness = createHarness();
    mockWriterLease();
    harness.deletionJournal.read.mockResolvedValueOnce(
      deletionEntry() as never,
    );
    harness.inspectStandaloneDeletionPaths.mockResolvedValueOnce({
      status: 'staged',
      identity: {
        ...identity,
        name: `${identity.name}.deleting`,
        canonicalPath: `${identity.canonicalPath}.deleting`,
      },
    });

    await expect(harness.service.delete([sessionId])).resolves.toEqual({
      removed: [sessionId],
      notFound: [],
      errors: [],
      fileCleanupPending: [sessionId],
    });

    expect(harness.deletionJournal.clear).not.toHaveBeenCalled();
  });

  it('stops attachment cleanup when recovery loses writer ownership', async () => {
    vi.spyOn(
      SessionService.prototype,
      'findSessionIdIgnoringCase',
    ).mockResolvedValue(undefined);
    vi.spyOn(
      SessionService.prototype,
      'cleanupRemovedSessionStateForLifecycle',
    ).mockRejectedValue(new SessionWriterLostError());
    const harness = createHarness();
    mockWriterLease();
    harness.deletionJournal.read.mockResolvedValueOnce(
      deletionEntry() as never,
    );
    harness.inspectStandaloneDeletionPaths.mockResolvedValueOnce({
      status: 'absent',
    });

    await expect(harness.service.delete([sessionId])).resolves.toEqual({
      removed: [sessionId],
      notFound: [],
      errors: [],
      fileCleanupPending: [sessionId],
    });

    expect(harness.bridge.deleteSessionAttachments).not.toHaveBeenCalled();
    expect(harness.deletionJournal.clear).not.toHaveBeenCalled();
  });

  it('stops attachment cleanup when recovery loses runtime ownership', async () => {
    vi.spyOn(
      SessionService.prototype,
      'findSessionIdIgnoringCase',
    ).mockResolvedValue(undefined);
    vi.spyOn(
      SessionService.prototype,
      'cleanupRemovedSessionStateForLifecycle',
    ).mockRejectedValue(
      new ConversationRuntimeOwnershipError(
        'conversation_runtime_unavailable',
        true,
      ),
    );
    const harness = createHarness();
    mockWriterLease();
    harness.deletionJournal.read.mockResolvedValueOnce(
      deletionEntry() as never,
    );
    harness.inspectStandaloneDeletionPaths.mockResolvedValueOnce({
      status: 'absent',
    });

    await expect(harness.service.delete([sessionId])).resolves.toEqual({
      removed: [sessionId],
      notFound: [],
      errors: [],
      fileCleanupPending: [sessionId],
    });

    expect(harness.bridge.deleteSessionAttachments).not.toHaveBeenCalled();
    expect(harness.deletionJournal.clear).not.toHaveBeenCalled();
  });

  it('reconfirms a restored normal directory before clearing recovery evidence', async () => {
    mockActiveStandalone();
    const harness = createHarness();
    mockWriterLease();
    harness.deletionJournal.read
      .mockResolvedValueOnce(deletionEntry() as never)
      .mockResolvedValueOnce(deletionEntry() as never);
    harness.inspectStandaloneDeletionPaths.mockResolvedValue({
      status: 'normal',
      identity,
    });
    harness.confirmStandaloneRootDurability
      .mockRejectedValueOnce(new Error('root fsync failed'))
      .mockResolvedValueOnce(undefined);

    await expect(harness.service.create({ sessionId })).rejects.toMatchObject({
      code: 'working_directory_recovery_failed',
    });
    expect(harness.deletionJournal.clear).not.toHaveBeenCalled();

    await expect(harness.service.create({ sessionId })).rejects.toMatchObject({
      code: 'standalone_session_conflict',
    });
    expect(harness.deletionJournal.clear).toHaveBeenCalledWith(sessionId, root);
  });

  it('reconfirms an absent staged directory before completing cleanup retry', async () => {
    vi.spyOn(
      SessionService.prototype,
      'findSessionIdIgnoringCase',
    ).mockResolvedValue(undefined);
    const cleanupRemovedState = vi
      .spyOn(SessionService.prototype, 'cleanupRemovedSessionStateForLifecycle')
      .mockResolvedValue();
    const harness = createHarness();
    const lease = mockWriterLease();
    harness.deletionJournal.read
      .mockResolvedValueOnce(deletionEntry() as never)
      .mockResolvedValueOnce(deletionEntry() as never);
    harness.inspectStandaloneDeletionPaths.mockResolvedValue({
      status: 'absent',
    });
    harness.confirmStandaloneRootDurability
      .mockRejectedValueOnce(new Error('root fsync failed'))
      .mockResolvedValueOnce(undefined);

    await expect(harness.service.delete([sessionId])).resolves.toEqual({
      removed: [sessionId],
      notFound: [],
      errors: [],
      fileCleanupPending: [sessionId],
    });
    expect(harness.deletionJournal.clear).not.toHaveBeenCalled();

    await expect(harness.service.delete([sessionId])).resolves.toEqual({
      removed: [sessionId],
      notFound: [],
      errors: [],
      fileCleanupPending: [],
    });
    expect(harness.deletionJournal.clear).toHaveBeenCalledWith(sessionId, root);
    const cleanupCalls = cleanupRemovedState.mock.calls;
    const cleanupOptions = cleanupCalls[cleanupCalls.length - 1]?.[1];
    expect(cleanupOptions).toEqual({
      assertCanMutate: expect.any(Function),
      assertCleanupOwned: expect.any(Function),
    });
    cleanupOptions?.assertCleanupOwned?.();
    expect(lease.assertCleanupOwned).toHaveBeenCalledOnce();
  });

  it('keeps deletion outcome unknown when transcript directory sync fails after unlink', async () => {
    const find = vi.spyOn(
      SessionService.prototype,
      'findSessionIdIgnoringCase',
    );
    find
      .mockResolvedValueOnce(sessionId)
      .mockResolvedValueOnce(sessionId)
      .mockResolvedValue(undefined);
    vi.spyOn(SessionService.prototype, 'getSessionLocation').mockResolvedValue(
      'active',
    );
    vi.spyOn(
      SessionService.prototype,
      'readCreationMetadataIfReadable',
    ).mockResolvedValue({ sourceType: 'standalone' });
    vi.spyOn(
      SessionService.prototype,
      'removeSessionTranscriptForLifecycle',
    ).mockRejectedValue(
      new SessionTranscriptDurabilityError({ cause: new Error('EIO') }),
    );
    const harness = createHarness();
    mockWriterLease();

    await expect(harness.service.delete([sessionId])).resolves.toMatchObject({
      removed: [],
      errors: [
        {
          sessionId,
          code: 'transcript_deletion_outcome_unknown',
        },
      ],
      fileCleanupPending: [],
    });

    expect(harness.deletionJournal.clear).not.toHaveBeenCalled();
  });

  it('fails recovery closed when another runtime owns the journaled id', async () => {
    const harness = createHarness();
    harness.deletionJournal.read.mockResolvedValueOnce(
      deletionEntry() as never,
    );
    harness.hasForeignSessionOwner.mockResolvedValueOnce(true);

    await expect(harness.service.delete([sessionId])).resolves.toMatchObject({
      removed: [],
      errors: [
        {
          sessionId,
          code: 'deletion_recovery_compromised',
        },
      ],
    });

    expect(harness.inspectStandaloneDeletionPaths).not.toHaveBeenCalled();
    expect(harness.deletionJournal.clear).not.toHaveBeenCalled();
  });

  it('fails closed when deletion recovery sees conflicting directory paths', async () => {
    mockActiveStandalone();
    const harness = createHarness();
    harness.deletionJournal.read.mockResolvedValueOnce(
      deletionEntry() as never,
    );
    harness.inspectStandaloneDeletionPaths.mockResolvedValueOnce({
      status: 'compromised',
    });

    await expect(harness.service.create({ sessionId })).rejects.toMatchObject({
      code: 'deletion_recovery_compromised',
      retryable: false,
    });

    expect(harness.restoreStagedStandaloneDirectory).not.toHaveBeenCalled();
    expect(harness.deletionJournal.clear).not.toHaveBeenCalled();
  });

  it('restores staged state when transcript deletion fails before commit', async () => {
    mockActiveStandalone();
    const harness = createHarness();
    mockWriterLease();
    vi.mocked(
      SessionService.prototype.getSessionTranscriptLocationForLifecycle,
    ).mockResolvedValue('active');
    vi.spyOn(
      SessionService.prototype,
      'removeSessionTranscriptForLifecycle',
    ).mockRejectedValue(new Error('unlink failed'));
    harness.inspectStandaloneDeletionPaths
      .mockResolvedValueOnce({ status: 'normal', identity })
      .mockResolvedValueOnce({
        status: 'staged',
        identity: {
          ...identity,
          name: `${identity.name}.deleting`,
          canonicalPath: `${identity.canonicalPath}.deleting`,
        },
      });

    await expect(harness.service.delete([sessionId])).resolves.toMatchObject({
      removed: [],
      errors: [
        {
          sessionId,
          code: 'transcript_deletion_failed',
        },
      ],
    });

    expect(harness.restoreStagedStandaloneDirectory).toHaveBeenCalledWith(
      sessionId,
      identity,
    );
    expect(harness.deletionJournal.clear).toHaveBeenCalledWith(sessionId, root);
  });

  it('creates a depth-1 child with explicit standalone source and durable parent lineage', async () => {
    const childSessionId = '22222222-2222-4222-8222-222222222222';
    const storageParentSessionId = sessionId.toUpperCase();
    vi.spyOn(SessionService.prototype, 'findSessionIdIgnoringCase')
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(sessionId)
      .mockResolvedValueOnce(storageParentSessionId)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValue(childSessionId);
    vi.spyOn(SessionService.prototype, 'getSessionLocation').mockResolvedValue(
      'active',
    );
    vi.spyOn(SessionService.prototype, 'readCreationMetadataIfReadable')
      .mockResolvedValueOnce({ sourceType: 'standalone' })
      .mockResolvedValueOnce({ sourceType: 'standalone' })
      .mockResolvedValue({
        sourceType: 'standalone',
        parentSessionId: storageParentSessionId,
      });
    const harness = createHarness();

    await harness.service.createWithInitialPrompt({ sessionId }, 'parent task');
    harness.bridge.getSessionSummary.mockReturnValue({
      sessionId,
      workspaceCwd: root.canonicalRoot,
      createdAt: '2026-08-24T00:00:00.000Z',
      sourceType: 'standalone',
      clientCount: 0,
      hasActivePrompt: false,
    });
    harness.bridge.spawnStandaloneSession.mockResolvedValueOnce({
      sessionId: childSessionId,
      workspaceCwd: root.canonicalRoot,
      attached: false,
      sourceType: 'standalone',
      sourcePersisted: true,
      parentSessionPersisted: true,
    });

    const child = await harness.service.createChildWithInitialPrompt(
      {
        sessionId: childSessionId,
        parentSessionId: sessionId,
        promptId: 'prompt-child',
      },
      'child task',
    );

    expect(harness.bridge.spawnStandaloneSession).toHaveBeenLastCalledWith({
      workspaceCwd: root.canonicalRoot,
      sessionId: childSessionId,
      parentSessionId: storageParentSessionId,
    });
    expect(child).toMatchObject({
      session: {
        sessionId: childSessionId,
        sourceType: 'standalone',
        parentSessionPersisted: true,
      },
      initialPrompt: { promptId: 'prompt-child', lastEventId: 7 },
    });
    expect(harness.bridge.sendPrompt).toHaveBeenLastCalledWith(
      childSessionId,
      expect.objectContaining({ sessionId: childSessionId }),
      undefined,
      expect.objectContaining({ promptId: 'prompt-child' }),
    );
  });

  it('returns an in-flight create without re-entering the runtime or storage', async () => {
    mockDurableStandalone();
    const getSessionListItem = vi
      .spyOn(SessionService.prototype, 'getSessionListItem')
      .mockResolvedValue(undefined);
    const harness = createHarness();
    let releaseSpawn!: () => void;
    const spawnStarted = new Promise<void>((resolve) => {
      harness.bridge.spawnStandaloneSession.mockImplementationOnce(
        () =>
          new Promise((spawnResolve) => {
            releaseSpawn = () => {
              spawnResolve({
                sessionId,
                workspaceCwd: root.canonicalRoot,
                attached: false,
                sourceType: 'standalone',
                sourcePersisted: true,
              });
            };
            resolve();
          }),
      );
    });
    const creating = harness.service.createWithInitialPrompt(
      { sessionId },
      'first task',
    );
    await spawnStarted;

    await expect(harness.service.get(sessionId.toUpperCase())).resolves.toEqual(
      { sessionId, state: 'creating' },
    );
    expect(harness.ensureRuntime).toHaveBeenCalledOnce();
    expect(getSessionListItem).not.toHaveBeenCalled();

    releaseSpawn();
    await creating;
  });

  it('does not expose an in-flight child as a top-level create', async () => {
    const childSessionId = '22222222-2222-4222-8222-222222222222';
    const storageParentSessionId = sessionId.toUpperCase();
    vi.spyOn(SessionService.prototype, 'findSessionIdIgnoringCase')
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(sessionId)
      .mockResolvedValueOnce(storageParentSessionId)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValue(childSessionId);
    vi.spyOn(SessionService.prototype, 'getSessionLocation').mockResolvedValue(
      'active',
    );
    vi.spyOn(SessionService.prototype, 'readCreationMetadataIfReadable')
      .mockResolvedValueOnce({ sourceType: 'standalone' })
      .mockResolvedValueOnce({ sourceType: 'standalone' })
      .mockResolvedValue({
        sourceType: 'standalone',
        parentSessionId: storageParentSessionId,
      });
    const harness = createHarness();
    await harness.service.createWithInitialPrompt({ sessionId }, 'parent task');
    harness.bridge.getSessionSummary.mockReturnValue({
      sessionId,
      workspaceCwd: root.canonicalRoot,
      createdAt: '2026-08-24T00:00:00.000Z',
      sourceType: 'standalone',
      clientCount: 0,
      hasActivePrompt: false,
    });
    let releaseSpawn!: () => void;
    const spawnStarted = new Promise<void>((resolve) => {
      harness.bridge.spawnStandaloneSession.mockImplementationOnce(
        () =>
          new Promise((spawnResolve) => {
            releaseSpawn = () => {
              spawnResolve({
                sessionId: childSessionId,
                workspaceCwd: root.canonicalRoot,
                attached: false,
                sourceType: 'standalone',
                sourcePersisted: true,
                parentSessionPersisted: true,
              });
            };
            resolve();
          }),
      );
    });
    const creating = harness.service.createChildWithInitialPrompt(
      {
        sessionId: childSessionId,
        parentSessionId: sessionId,
        promptId: 'prompt-child',
      },
      'child task',
    );
    await spawnStarted;

    await expect(harness.service.get(childSessionId)).rejects.toMatchObject({
      code: 'standalone_session_not_found',
      sessionId: childSessionId,
    });
    await expect(
      harness.service.getForInternalTask(childSessionId),
    ).resolves.toEqual({ sessionId: childSessionId, state: 'creating' });

    releaseSpawn();
    await creating;
  });

  it('returns a canonical archived summary for a mixed-case transcript', async () => {
    const storageSessionId = sessionId.toUpperCase();
    vi.spyOn(
      SessionService.prototype,
      'findSessionIdIgnoringCase',
    ).mockResolvedValue(storageSessionId);
    vi.spyOn(SessionService.prototype, 'getSessionLocation').mockResolvedValue(
      'archived',
    );
    vi.spyOn(
      SessionService.prototype,
      'readCreationMetadataIfReadable',
    ).mockResolvedValue({ sourceType: 'standalone' });
    vi.spyOn(SessionService.prototype, 'getSessionListItem').mockResolvedValue({
      sessionId: storageSessionId,
      cwd: root.canonicalRoot,
      startTime: '2026-08-24T00:00:00.000Z',
      mtime: Date.parse('2026-08-24T01:00:00.000Z'),
      prompt: 'archived task',
      filePath: '/transcripts/session.jsonl',
      sourceType: 'standalone',
      isArchived: true,
    });
    const harness = createHarness();

    await expect(harness.service.get(sessionId)).resolves.toMatchObject({
      sessionId,
      workspaceCwd: root.canonicalRoot,
      sourceType: 'standalone',
      context: { kind: 'standalone' },
      displayName: 'archived task',
      isArchived: true,
      clientCount: 0,
      hasActivePrompt: false,
    });
    expect(harness.bridge.getSessionSummary).not.toHaveBeenCalled();
  });

  it('does not reveal a foreign persisted source through exact lookup', async () => {
    vi.spyOn(
      SessionService.prototype,
      'findSessionIdIgnoringCase',
    ).mockResolvedValue(sessionId);
    vi.spyOn(SessionService.prototype, 'getSessionLocation').mockResolvedValue(
      'active',
    );
    vi.spyOn(
      SessionService.prototype,
      'readCreationMetadataIfReadable',
    ).mockResolvedValue({ sourceType: 'live' });
    const harness = createHarness();

    await expect(harness.service.get(sessionId)).rejects.toMatchObject({
      code: 'standalone_session_not_found',
      sessionId,
    });
    expect(harness.bridge.getSessionSummary).not.toHaveBeenCalled();
  });

  it('does not reveal a child transcript through exact top-level lookup', async () => {
    vi.spyOn(
      SessionService.prototype,
      'findSessionIdIgnoringCase',
    ).mockResolvedValue(sessionId);
    vi.spyOn(SessionService.prototype, 'getSessionLocation').mockResolvedValue(
      'active',
    );
    vi.spyOn(
      SessionService.prototype,
      'readCreationMetadataIfReadable',
    ).mockImplementation(async (targetSessionId) =>
      targetSessionId === sessionId
        ? {
            sourceType: 'standalone',
            parentSessionId: '22222222-2222-4222-8222-222222222222',
          }
        : { sourceType: 'standalone' },
    );
    vi.spyOn(SessionService.prototype, 'getSessionListItem').mockResolvedValue({
      sessionId,
      cwd: root.canonicalRoot,
      startTime: '2026-08-24T00:00:00.000Z',
      mtime: Date.parse('2026-08-24T01:00:00.000Z'),
      prompt: 'child task',
      filePath: '/transcripts/session.jsonl',
      sourceType: 'standalone',
      isArchived: false,
    });
    const harness = createHarness();

    await expect(harness.service.get(sessionId)).rejects.toMatchObject({
      code: 'standalone_session_not_found',
      sessionId,
    });
    expect(harness.bridge.getSessionSummary).not.toHaveBeenCalled();

    await expect(
      harness.service.getForInternalTask(sessionId),
    ).resolves.toMatchObject({
      sessionId,
      sourceType: 'standalone',
      parentSessionId: '22222222-2222-4222-8222-222222222222',
      context: { kind: 'standalone' },
    });
  });

  it('merges only volatile live state onto authoritative persisted identity', async () => {
    vi.spyOn(
      SessionService.prototype,
      'findSessionIdIgnoringCase',
    ).mockResolvedValue(sessionId);
    vi.spyOn(SessionService.prototype, 'getSessionLocation').mockResolvedValue(
      'active',
    );
    vi.spyOn(
      SessionService.prototype,
      'readCreationMetadataIfReadable',
    ).mockResolvedValue({ sourceType: 'standalone' });
    vi.spyOn(SessionService.prototype, 'getSessionListItem').mockResolvedValue({
      sessionId,
      cwd: root.canonicalRoot,
      startTime: '2026-08-24T00:00:00.000Z',
      mtime: Date.parse('2026-08-24T01:00:00.000Z'),
      prompt: 'persisted title',
      filePath: '/transcripts/session.jsonl',
      sourceType: 'standalone',
      isArchived: false,
    });
    const harness = createHarness();
    harness.bridge.getSessionSummary.mockReturnValue({
      sessionId,
      workspaceCwd: '/must-not-replace-owner-root',
      createdAt: '2099-01-01T00:00:00.000Z',
      updatedAt: '2026-08-24T02:00:00.000Z',
      displayName: 'live title',
      sourceType: 'standalone',
      clientCount: 2,
      hasActivePrompt: true,
      isWaitingForPermission: true,
    });

    await expect(harness.service.get(sessionId)).resolves.toMatchObject({
      sessionId,
      workspaceCwd: root.canonicalRoot,
      createdAt: '2026-08-24T00:00:00.000Z',
      updatedAt: '2026-08-24T02:00:00.000Z',
      displayName: 'live title',
      sourceType: 'standalone',
      context: { kind: 'standalone' },
      clientCount: 2,
      hasActivePrompt: true,
      isWaitingForPermission: true,
      isArchived: false,
    });
  });

  it('rejects a live worktree collision during exact lookup', async () => {
    vi.spyOn(
      SessionService.prototype,
      'findSessionIdIgnoringCase',
    ).mockResolvedValue(sessionId);
    vi.spyOn(SessionService.prototype, 'getSessionLocation').mockResolvedValue(
      'active',
    );
    vi.spyOn(
      SessionService.prototype,
      'readCreationMetadataIfReadable',
    ).mockResolvedValue({ sourceType: 'standalone' });
    vi.spyOn(SessionService.prototype, 'getSessionListItem').mockResolvedValue({
      sessionId,
      cwd: root.canonicalRoot,
      startTime: '2026-08-24T00:00:00.000Z',
      mtime: Date.parse('2026-08-24T01:00:00.000Z'),
      prompt: 'persisted title',
      filePath: '/transcripts/session.jsonl',
      sourceType: 'standalone',
      isArchived: false,
    });
    const harness = createHarness();
    harness.bridge.getSessionSummary.mockReturnValue({
      sessionId,
      workspaceCwd: root.canonicalRoot,
      createdAt: '2026-08-24T00:00:00.000Z',
      sourceType: 'standalone',
      clientCount: 0,
      hasActivePrompt: false,
      worktree: { slug: 'other', path: '/other', branch: 'other' },
    });

    await expect(harness.service.get(sessionId)).rejects.toMatchObject({
      code: 'standalone_session_conflict',
      sessionId,
    });
  });

  it('merges persisted PR bindings with live bindings by PR number', async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'standalone-prs-'));
    const sidecar = path.join(temp, `${sessionId}.pr.json`);
    await writeSessionPrs(sidecar, [
      {
        number: 7,
        url: 'https://example.com/persisted-only',
        createdAt: '2026-08-24T00:00:00.000Z',
      },
      {
        number: 8,
        url: 'https://example.com/persisted-stale',
        createdAt: '2026-08-24T00:01:00.000Z',
      },
    ]);
    vi.spyOn(
      SessionService.prototype,
      'findSessionIdIgnoringCase',
    ).mockResolvedValue(sessionId);
    vi.spyOn(SessionService.prototype, 'getSessionLocation').mockResolvedValue(
      'active',
    );
    vi.spyOn(
      SessionService.prototype,
      'readCreationMetadataIfReadable',
    ).mockResolvedValue({ sourceType: 'standalone' });
    vi.spyOn(SessionService.prototype, 'getSessionListItem').mockResolvedValue({
      sessionId,
      cwd: root.canonicalRoot,
      startTime: '2026-08-24T00:00:00.000Z',
      mtime: Date.parse('2026-08-24T01:00:00.000Z'),
      prompt: 'persisted title',
      filePath: '/transcripts/session.jsonl',
      sourceType: 'standalone',
      isArchived: false,
    });
    vi.spyOn(
      SessionService.prototype,
      'getPrSessionPathForArchiveState',
    ).mockReturnValue(sidecar);
    const harness = createHarness();
    harness.bridge.getSessionSummary.mockReturnValue({
      sessionId,
      workspaceCwd: root.canonicalRoot,
      createdAt: '2026-08-24T00:00:00.000Z',
      sourceType: 'standalone',
      clientCount: 1,
      hasActivePrompt: false,
      prs: [
        { number: 8, url: 'https://example.com/live-current' },
        { number: 9, url: 'https://example.com/live-only' },
      ],
    });

    try {
      await expect(harness.service.get(sessionId)).resolves.toMatchObject({
        prs: [
          { number: 7, url: 'https://example.com/persisted-only' },
          { number: 8, url: 'https://example.com/live-current' },
          { number: 9, url: 'https://example.com/live-only' },
        ],
      });
    } finally {
      await fs.rm(temp, { recursive: true, force: true });
    }
  });

  it('drops both spellings when the standalone catalog has a case conflict', async () => {
    const uniqueSessionId = '22222222-2222-4222-8222-222222222222';
    listWorkspaceSessionsForResponse.mockResolvedValueOnce({
      sessions: [
        {
          sessionId,
          workspaceCwd: root.canonicalRoot,
          createdAt: '2026-08-24T00:00:00.000Z',
          sourceType: 'standalone',
          clientCount: 0,
          hasActivePrompt: false,
        },
        {
          sessionId: sessionId.toUpperCase(),
          workspaceCwd: root.canonicalRoot,
          createdAt: '2026-08-24T00:00:00.000Z',
          sourceType: 'standalone',
          clientCount: 0,
          hasActivePrompt: false,
        },
        {
          sessionId: uniqueSessionId.toUpperCase(),
          workspaceCwd: '/untrusted-root',
          createdAt: '2026-08-24T01:00:00.000Z',
          sourceType: 'standalone',
          clientCount: 0,
          hasActivePrompt: false,
        },
      ],
    });
    vi.spyOn(
      SessionService.prototype,
      'findSessionIdIgnoringCase',
    ).mockResolvedValue(uniqueSessionId.toUpperCase());
    vi.spyOn(SessionService.prototype, 'getSessionLocation').mockResolvedValue(
      'active',
    );
    vi.spyOn(
      SessionService.prototype,
      'readCreationMetadataIfReadable',
    ).mockResolvedValue({ sourceType: 'standalone' });
    const harness = createHarness();

    await expect(harness.service.list()).resolves.toEqual({
      sessions: [
        {
          sessionId: uniqueSessionId,
          workspaceCwd: root.canonicalRoot,
          createdAt: '2026-08-24T01:00:00.000Z',
          sourceType: 'standalone',
          context: { kind: 'standalone' },
          clientCount: 0,
          hasActivePrompt: false,
        },
      ],
    });
    expect(listWorkspaceSessionsForResponse).toHaveBeenCalledWith(
      harness.bridge,
      root.canonicalRoot,
      { conversationKind: 'standalone-top-level' },
      { runtimeBaseDir: '/runtime' },
    );
  });

  it('omits a list row carrying foreign live isolation state', async () => {
    listWorkspaceSessionsForResponse.mockResolvedValueOnce({
      sessions: [
        {
          sessionId,
          workspaceCwd: root.canonicalRoot,
          createdAt: '2026-08-24T00:00:00.000Z',
          sourceType: 'standalone',
          clientCount: 0,
          hasActivePrompt: false,
          branch: { name: 'foreign', baseBranch: 'main' },
        },
      ],
    });
    const harness = createHarness();

    await expect(harness.service.list()).resolves.toEqual({ sessions: [] });
  });

  it('drops a catalog item deleted before its shared revalidation', async () => {
    listWorkspaceSessionsForResponse.mockResolvedValueOnce({
      sessions: [
        {
          sessionId,
          workspaceCwd: root.canonicalRoot,
          createdAt: '2026-08-24T00:00:00.000Z',
          sourceType: 'standalone',
          clientCount: 0,
          hasActivePrompt: false,
        },
      ],
    });
    vi.spyOn(
      SessionService.prototype,
      'findSessionIdIgnoringCase',
    ).mockResolvedValue(undefined);
    const harness = createHarness();

    await expect(harness.service.list()).resolves.toEqual({ sessions: [] });
  });

  it('omits a transitioning catalog row without hiding stable rows', async () => {
    const stableSessionId = '22222222-2222-4222-8222-222222222222';
    listWorkspaceSessionsForResponse.mockResolvedValueOnce({
      sessions: [
        {
          sessionId,
          workspaceCwd: root.canonicalRoot,
          createdAt: '2026-08-24T00:00:00.000Z',
          sourceType: 'standalone',
          clientCount: 0,
          hasActivePrompt: false,
        },
        {
          sessionId: stableSessionId,
          workspaceCwd: root.canonicalRoot,
          createdAt: '2026-08-24T01:00:00.000Z',
          sourceType: 'standalone',
          clientCount: 0,
          hasActivePrompt: false,
        },
      ],
    });
    vi.spyOn(
      SessionService.prototype,
      'findSessionIdIgnoringCase',
    ).mockImplementation(async (candidate) => candidate);
    vi.spyOn(SessionService.prototype, 'getSessionLocation').mockResolvedValue(
      'active',
    );
    vi.spyOn(
      SessionService.prototype,
      'readCreationMetadataIfReadable',
    ).mockResolvedValue({ sourceType: 'standalone' });
    const harness = createHarness();
    let releaseExclusive!: () => void;
    let markExclusiveEntered!: () => void;
    const exclusiveEntered = new Promise<void>((resolve) => {
      markExclusiveEntered = resolve;
    });
    const heldExclusive = harness.lifecycle.runExclusiveAfterShared(
      sessionId,
      async () => {
        markExclusiveEntered();
        await new Promise<void>((resolve) => {
          releaseExclusive = resolve;
        });
      },
    );
    await exclusiveEntered;

    try {
      await expect(harness.service.list()).resolves.toEqual({
        sessions: [
          {
            sessionId: stableSessionId,
            workspaceCwd: root.canonicalRoot,
            createdAt: '2026-08-24T01:00:00.000Z',
            sourceType: 'standalone',
            context: { kind: 'standalone' },
            clientCount: 0,
            hasActivePrompt: false,
          },
        ],
      });
    } finally {
      releaseExclusive();
      await heldExclusive;
    }
  });

  it('aborts while a catalog row is waiting for durable verification', async () => {
    listWorkspaceSessionsForResponse.mockResolvedValueOnce({
      sessions: [
        {
          sessionId,
          workspaceCwd: root.canonicalRoot,
          createdAt: '2026-08-24T00:00:00.000Z',
          sourceType: 'standalone',
          clientCount: 0,
          hasActivePrompt: false,
        },
      ],
    });
    const harness = createHarness();
    let releaseVerification!: () => void;
    const verificationStarted = new Promise<void>((resolve) => {
      harness.deletionJournal.hasRecord.mockImplementationOnce(
        () =>
          new Promise<boolean>((release) => {
            releaseVerification = () => release(false);
            resolve();
          }),
      );
    });
    const inspect = vi.spyOn(
      SessionService.prototype,
      'findSessionIdIgnoringCase',
    );
    const controller = new AbortController();

    const listing = harness.service.list({ signal: controller.signal });
    await verificationStarted;
    controller.abort(new DOMException('Request aborted', 'AbortError'));
    releaseVerification();

    await expect(listing).rejects.toMatchObject({ name: 'AbortError' });
    expect(inspect).not.toHaveBeenCalled();
  });

  it('maps case-only persisted ambiguity to a standalone conflict', async () => {
    vi.spyOn(
      SessionService.prototype,
      'findSessionIdIgnoringCase',
    ).mockRejectedValue(new SessionIdCaseConflictError(sessionId));
    const harness = createHarness();

    await expect(harness.service.get(sessionId)).rejects.toMatchObject({
      code: 'standalone_session_conflict',
      sessionId,
    });
    expect(harness.bridge.getSessionSummary).not.toHaveBeenCalled();
  });

  it('does not restore a child transcript through the top-level API', async () => {
    vi.spyOn(
      SessionService.prototype,
      'findSessionIdIgnoringCase',
    ).mockResolvedValue(sessionId);
    vi.spyOn(SessionService.prototype, 'getSessionLocation').mockResolvedValue(
      'active',
    );
    vi.spyOn(
      SessionService.prototype,
      'readCreationMetadataIfReadable',
    ).mockResolvedValue({
      sourceType: 'standalone',
      parentSessionId: '22222222-2222-4222-8222-222222222222',
    });
    const harness = createHarness();

    await expect(harness.service.load(sessionId)).rejects.toMatchObject({
      code: 'standalone_session_not_found',
      sessionId,
    });
    await expect(harness.service.resume(sessionId)).rejects.toMatchObject({
      code: 'standalone_session_not_found',
      sessionId,
    });
    expect(harness.bridge.restoreStandaloneSession).not.toHaveBeenCalled();
  });

  it('restores a child transcript for an internal task', async () => {
    const parentSessionId = '22222222-2222-4222-8222-222222222222';
    vi.spyOn(
      SessionService.prototype,
      'findSessionIdIgnoringCase',
    ).mockResolvedValue(sessionId);
    vi.spyOn(SessionService.prototype, 'getSessionLocation').mockResolvedValue(
      'active',
    );
    vi.spyOn(
      SessionService.prototype,
      'readCreationMetadataIfReadable',
    ).mockImplementation(async (targetSessionId) =>
      targetSessionId === sessionId
        ? {
            sourceType: 'standalone',
            parentSessionId,
          }
        : undefined,
    );
    const harness = createHarness();
    harness.bridge.restoreStandaloneSession.mockResolvedValueOnce({
      sessionId,
      workspaceCwd: root.canonicalRoot,
      sourceType: 'standalone',
      parentSessionId,
      attached: false,
      hasActivePrompt: false,
      clientCount: 0,
    });
    harness.bridge.getSessionSummary
      .mockImplementationOnce(() => {
        throw new SessionNotFoundError(sessionId);
      })
      .mockReturnValue({
        sessionId,
        workspaceCwd: root.canonicalRoot,
        createdAt: '2026-08-24T00:00:00.000Z',
        sourceType: 'standalone',
        parentSessionId,
        clientCount: 0,
        hasActivePrompt: false,
      });

    await expect(
      harness.service.resumeForInternalTask(sessionId),
    ).resolves.toMatchObject({
      sessionId,
      sourceType: 'standalone',
      parentSessionId,
      context: { kind: 'standalone' },
    });
    expect(harness.bridge.restoreStandaloneSession).toHaveBeenCalledWith(
      'resume',
      {
        sessionId,
        workspaceCwd: root.canonicalRoot,
        parentSessionId,
      },
    );
  });

  it('repairs through prompt-less resume and detaches its response client', async () => {
    mockActiveStandalone();
    const harness = createHarness();

    await expect(harness.service.repairDirectory(sessionId)).resolves.toEqual({
      sessionId,
      projectlessOutputDirectory: identity.canonicalPath,
      workingDirectory: { state: 'ready' },
    });

    expect(harness.bridge.restoreStandaloneSession).toHaveBeenCalledWith(
      'resume',
      expect.not.objectContaining({ historyReplay: expect.anything() }),
    );
    expect(harness.bridge.detachClient).toHaveBeenCalledWith(
      sessionId,
      expect.any(String),
    );
    expect(harness.bridge.sendPrompt).not.toHaveBeenCalled();
  });

  it('retries transient response cleanup during directory repair', async () => {
    mockActiveStandalone();
    const harness = createHarness();
    harness.bridge.detachClient.mockRejectedValueOnce(new Error('transient'));

    await expect(harness.service.repairDirectory(sessionId)).resolves.toEqual({
      sessionId,
      projectlessOutputDirectory: identity.canonicalPath,
      workingDirectory: { state: 'ready' },
    });

    expect(harness.bridge.detachClient).toHaveBeenCalledTimes(2);
  });

  it('preserves the data-loss warning when repair recreates a directory', async () => {
    mockActiveStandalone();
    const harness = createHarness();
    harness.inspectStandaloneDirectory.mockResolvedValueOnce({
      status: 'missing',
    });

    await expect(harness.service.repairDirectory(sessionId)).resolves.toEqual({
      sessionId,
      projectlessOutputDirectory: identity.canonicalPath,
      workingDirectory: {
        state: 'recreated',
        warnings: [expect.stringContaining('could not be recovered')],
      },
    });

    expect(harness.bridge.detachClient).toHaveBeenCalledWith(
      sessionId,
      expect.any(String),
    );
  });

  it('cold-loads, binds, and reports a recreated missing directory', async () => {
    mockActiveStandalone(sessionId.toUpperCase());
    const harness = createHarness();
    harness.inspectStandaloneDirectory.mockResolvedValueOnce({
      status: 'missing',
    });

    await expect(
      harness.service.load(sessionId.toUpperCase(), {
        clientId: 'client-1',
        historyPageSize: 20,
        liveReplayMode: 'summary',
        approvalMode: ApprovalMode.AUTO,
      }),
    ).resolves.toMatchObject({
      sessionId,
      currentCwd: identity.canonicalPath,
      sourceType: 'standalone',
      context: { kind: 'standalone' },
      projectlessOutputDirectory: identity.canonicalPath,
      workingDirectory: {
        state: 'recreated',
        warnings: [expect.stringContaining('could not be recovered')],
      },
    });

    expect(harness.ensureStandaloneDirectory).toHaveBeenCalledWith(
      sessionId,
      undefined,
    );
    expect(harness.bridge.restoreStandaloneSession).toHaveBeenCalledWith(
      'load',
      {
        sessionId,
        workspaceCwd: root.canonicalRoot,
        clientId: 'client-1',
        historyPageSize: 20,
        liveReplayMode: 'summary',
        approvalMode: ApprovalMode.AUTO,
        historyReplay: 'response',
      },
    );
    expect(harness.bridge.changeSessionCwd).toHaveBeenCalledOnce();
    expect(
      harness.bridge.commitManagedConversationBinding,
    ).toHaveBeenCalledOnce();
    expect(
      harness.bridge.releaseManagedConversationBinding,
    ).toHaveBeenCalledOnce();
    expect(harness.restoreReservation.release).toHaveBeenCalledOnce();
  });

  it('does not recreate a missing directory under an active live entry', async () => {
    mockActiveStandalone();
    const harness = createHarness();
    harness.inspectStandaloneDirectory.mockResolvedValueOnce({
      status: 'missing',
    });
    harness.bridge.getSessionSummary.mockReturnValue({
      sessionId,
      workspaceCwd: root.canonicalRoot,
      createdAt: '2026-08-24T00:00:00.000Z',
      sourceType: 'standalone',
      clientCount: 1,
      hasActivePrompt: true,
    });

    await expect(harness.service.load(sessionId)).rejects.toMatchObject({
      code: 'session_busy',
      sessionId,
      retryable: true,
    });

    expect(harness.ensureStandaloneDirectory).not.toHaveBeenCalled();
    expect(harness.bridge.killSession).not.toHaveBeenCalled();
    expect(harness.bridge.restoreStandaloneSession).not.toHaveBeenCalled();
  });

  it('does not recreate a missing directory until background work permits close', async () => {
    mockActiveStandalone();
    const harness = createHarness();
    harness.inspectStandaloneDirectory.mockResolvedValueOnce({
      status: 'missing',
    });
    harness.bridge.getSessionSummary.mockReturnValue({
      sessionId,
      workspaceCwd: root.canonicalRoot,
      createdAt: '2026-08-24T00:00:00.000Z',
      sourceType: 'standalone',
      clientCount: 0,
      hasActivePrompt: false,
    });
    harness.bridge.killSession.mockResolvedValueOnce(false);

    await expect(harness.service.resume(sessionId)).rejects.toMatchObject({
      code: 'session_busy',
      sessionId,
      retryable: true,
    });

    expect(harness.bridge.killSession).toHaveBeenCalledWith(sessionId, {
      requireZeroAttaches: true,
    });
    expect(harness.ensureStandaloneDirectory).not.toHaveBeenCalled();
    expect(harness.bridge.restoreStandaloneSession).not.toHaveBeenCalled();
  });

  it('resumes without enabling load history replay', async () => {
    mockActiveStandalone();
    const harness = createHarness();

    await expect(
      harness.service.resume(sessionId, { hideInheritedHistory: true }),
    ).resolves.toMatchObject({
      sessionId,
      workingDirectory: { state: 'ready' },
    });

    expect(harness.bridge.restoreStandaloneSession).toHaveBeenCalledWith(
      'resume',
      {
        sessionId,
        workspaceCwd: root.canonicalRoot,
        hideInheritedHistory: true,
      },
    );
    expect(harness.restoreReservation.release).toHaveBeenCalledOnce();
  });

  it('detaches the response client from a captured cold restore', async () => {
    mockActiveStandalone();
    const harness = createHarness();

    const restored = await harness.service.load(sessionId, {
      clientId: 'response-client',
    });
    await harness.quarantineRuntime(harness.runtime);
    await harness.service.cleanupDisconnectedRestore(restored);

    expect(harness.bridge.detachClient).toHaveBeenCalledWith(
      sessionId,
      'response-client',
    );
    expect(harness.bridge.killSession).not.toHaveBeenCalled();
  });

  it('retains the restore origin when response cleanup must be retried', async () => {
    mockActiveStandalone();
    const harness = createHarness();
    harness.bridge.detachClient.mockRejectedValueOnce(new Error('transient'));

    const restored = await harness.service.load(sessionId, {
      clientId: 'response-client',
    });
    await expect(
      harness.service.cleanupDisconnectedRestore(restored),
    ).rejects.toThrow('transient');
    await expect(
      harness.service.cleanupDisconnectedRestore(restored),
    ).resolves.toBeUndefined();

    expect(harness.bridge.detachClient).toHaveBeenCalledTimes(2);
  });

  it('detaches only the response client from a captured warm restore', async () => {
    mockDurableStandalone();
    const harness = createHarness();
    await harness.service.createWithInitialPrompt({ sessionId }, 'first task');
    harness.bridge.getSessionSummary.mockReturnValue({
      sessionId,
      workspaceCwd: root.canonicalRoot,
      createdAt: '2026-08-24T00:00:00.000Z',
      sourceType: 'standalone',
      clientCount: 1,
      hasActivePrompt: false,
    });
    harness.bridge.restoreStandaloneSession.mockResolvedValue({
      sessionId,
      workspaceCwd: root.canonicalRoot,
      currentCwd: identity.canonicalPath,
      attached: true,
      clientId: 'response-client',
      sourceType: 'standalone',
      state: {},
    });

    const restored = await harness.service.load(sessionId);
    await harness.service.cleanupDisconnectedRestore(restored);

    expect(harness.bridge.detachClient).toHaveBeenCalledWith(
      sessionId,
      'response-client',
    );
    expect(harness.bridge.killSession).not.toHaveBeenCalled();
  });

  it('normalizes only legacy standalone source through the compatibility restore', async () => {
    mockActiveLegacyStandalone();
    const harness = createHarness();

    await expect(
      harness.service.restoreLegacyForCompatibility('resume', sessionId),
    ).resolves.toMatchObject({
      sessionId,
      sourceType: 'standalone',
      context: { kind: 'standalone' },
    });
    expect(harness.bridge.restoreStandaloneSession).toHaveBeenCalledWith(
      'resume',
      {
        sessionId,
        workspaceCwd: root.canonicalRoot,
      },
    );
  });

  it('closes an idle legacy live entry before restoring it as standalone', async () => {
    mockActiveLegacyStandalone();
    const harness = createHarness();
    harness.bridge.getSessionSummary.mockReturnValueOnce({
      sessionId,
      workspaceCwd: root.canonicalRoot,
      createdAt: '2026-08-24T00:00:00.000Z',
      sourceType: 'default',
      clientCount: 0,
      hasActivePrompt: false,
    });

    await expect(
      harness.service.restoreLegacyForCompatibility('load', sessionId),
    ).resolves.toMatchObject({
      sessionId,
      attached: false,
      sourceType: 'standalone',
    });

    expect(harness.bridge.killSession).toHaveBeenCalledWith(sessionId, {
      requireZeroAttaches: true,
    });
    expect(harness.bridge.restoreStandaloneSession).toHaveBeenCalledOnce();
  });

  it('leaves an active legacy live entry untouched and reports it busy', async () => {
    mockActiveLegacyStandalone();
    const harness = createHarness();
    harness.bridge.getSessionSummary.mockReturnValueOnce({
      sessionId,
      workspaceCwd: root.canonicalRoot,
      createdAt: '2026-08-24T00:00:00.000Z',
      sourceType: 'default',
      clientCount: 1,
      hasActivePrompt: true,
    });

    await expect(
      harness.service.restoreLegacyForCompatibility('resume', sessionId),
    ).rejects.toMatchObject({
      code: 'session_busy',
      sessionId,
      retryable: true,
    });

    expect(harness.bridge.killSession).not.toHaveBeenCalled();
    expect(harness.bridge.restoreStandaloneSession).not.toHaveBeenCalled();
  });

  it('does not expose explicit standalone through the legacy compatibility restore', async () => {
    mockActiveStandalone();
    const harness = createHarness();

    await expect(
      harness.service.restoreLegacyForCompatibility('load', sessionId),
    ).rejects.toMatchObject({
      code: 'standalone_session_not_found',
      sessionId,
    });
    expect(harness.bridge.restoreStandaloneSession).not.toHaveBeenCalled();
  });

  it('rejects an archived standalone session before restore admission', async () => {
    vi.spyOn(
      SessionService.prototype,
      'findSessionIdIgnoringCase',
    ).mockResolvedValue(sessionId);
    vi.spyOn(SessionService.prototype, 'getSessionLocation').mockResolvedValue(
      'archived',
    );
    vi.spyOn(
      SessionService.prototype,
      'readCreationMetadataIfReadable',
    ).mockResolvedValue({ sourceType: 'standalone' });
    const harness = createHarness();

    await expect(harness.service.load(sessionId)).rejects.toMatchObject({
      code: 'session_archived',
      sessionId,
    });
    expect(harness.bridge.restoreStandaloneSession).not.toHaveBeenCalled();
    expect(harness.restoreReservation.release).toHaveBeenCalledOnce();
  });

  it('reuses an exact released binding when attaching to the live session', async () => {
    mockDurableStandalone();
    const harness = createHarness();
    await harness.service.createWithInitialPrompt({ sessionId }, 'first task');
    harness.bridge.getSessionSummary.mockReturnValue({
      sessionId,
      workspaceCwd: root.canonicalRoot,
      createdAt: '2026-08-24T00:00:00.000Z',
      sourceType: 'standalone',
      clientCount: 1,
      hasActivePrompt: false,
    });
    harness.bridge.restoreStandaloneSession.mockResolvedValue({
      sessionId,
      workspaceCwd: root.canonicalRoot,
      currentCwd: identity.canonicalPath,
      attached: true,
      clientId: 'attached-client',
      sourceType: 'standalone',
      state: {},
    });

    await expect(harness.service.load(sessionId)).resolves.toMatchObject({
      attached: true,
      currentCwd: identity.canonicalPath,
      workingDirectory: { state: 'ready' },
    });

    expect(harness.bridge.changeSessionCwd).toHaveBeenCalledOnce();
    expect(
      harness.bridge.commitManagedConversationBinding,
    ).toHaveBeenCalledOnce();
    expect(
      harness.bridge.releaseManagedConversationBinding,
    ).toHaveBeenCalledOnce();
    expect(harness.restoreReservation.release).toHaveBeenCalledOnce();
  });

  it('detaches a reused attach when its pinned directory changes during restore', async () => {
    mockDurableStandalone();
    const harness = createHarness();
    await harness.service.createWithInitialPrompt({ sessionId }, 'first task');
    harness.inspectStandaloneDirectory.mockClear();
    harness.inspectStandaloneDirectory
      .mockResolvedValueOnce({ status: 'ready', identity })
      .mockResolvedValueOnce({ status: 'compromised' });
    harness.bridge.getSessionSummary.mockReturnValue({
      sessionId,
      workspaceCwd: root.canonicalRoot,
      createdAt: '2026-08-24T00:00:00.000Z',
      sourceType: 'standalone',
      clientCount: 1,
      hasActivePrompt: false,
    });
    harness.bridge.restoreStandaloneSession.mockResolvedValue({
      sessionId,
      workspaceCwd: root.canonicalRoot,
      currentCwd: identity.canonicalPath,
      attached: true,
      clientId: 'attached-client',
      sourceType: 'standalone',
      state: {},
    });

    await expect(harness.service.load(sessionId)).rejects.toMatchObject({
      code: 'working_directory_compromised',
      sessionId,
    });
    expect(harness.bridge.detachClient).toHaveBeenCalledWith(
      sessionId,
      'attached-client',
    );
  });

  it('discards an unattached restore when the child reports a different cwd', async () => {
    mockActiveStandalone();
    const harness = createHarness();
    harness.bridge.changeSessionCwd.mockResolvedValueOnce({
      previousCwd: root.canonicalRoot,
      newCwd: '/unexpected/path',
      warnings: [],
    });

    await expect(harness.service.load(sessionId)).rejects.toMatchObject({
      code: 'working_directory_compromised',
      sessionId,
    });
    expect(harness.bridge.killSession).toHaveBeenCalledWith(sessionId, {
      requireZeroAttaches: true,
    });
    expect(harness.quarantineRuntime).not.toHaveBeenCalled();
    expect(
      harness.bridge.commitManagedConversationBinding,
    ).not.toHaveBeenCalled();
  });

  it('rejects cwd-bound work when the live entry moved away from its pin', async () => {
    mockDurableStandalone();
    const harness = createHarness();
    await harness.service.createWithInitialPrompt({ sessionId }, 'first task');
    harness.bridge.getSessionSummary.mockReturnValue({
      sessionId,
      workspaceCwd: root.canonicalRoot,
      createdAt: '2026-08-24T00:00:00.000Z',
      sourceType: 'standalone',
      clientCount: 1,
      hasActivePrompt: false,
    });
    harness.bridge.getSessionCurrentCwd.mockReturnValue('/unexpected/path');

    await expect(
      harness.service.assertCwdReadyUnderShared(harness.runtime, sessionId),
    ).rejects.toMatchObject({
      code: 'working_directory_compromised',
      sessionId,
    });
  });

  it('holds the lifecycle shared admission only until prompt admission', async () => {
    mockDurableStandalone();
    const harness = createHarness();
    await harness.service.createWithInitialPrompt({ sessionId }, 'first task');
    harness.bridge.getSessionSummary.mockReturnValue({
      sessionId,
      workspaceCwd: root.canonicalRoot,
      createdAt: '2026-08-24T00:00:00.000Z',
      sourceType: 'standalone',
      clientCount: 1,
      hasActivePrompt: false,
    });
    let admit!: () => void;
    let settleTurn!: (value: string) => void;
    let markDispatched!: () => void;
    const dispatched = new Promise<void>((resolve) => {
      markDispatched = resolve;
    });
    const prompt = harness.service.dispatchPrompt(
      sessionId.toUpperCase(),
      async (runtime, canonicalSessionId, onPromptAdmitted) => {
        expect(runtime).toBe(harness.runtime);
        expect(canonicalSessionId).toBe(sessionId);
        admit = onPromptAdmitted;
        markDispatched();
        return new Promise<string>((resolve) => {
          settleTurn = resolve;
        });
      },
    );
    await dispatched;
    let exclusiveEntered = false;
    const exclusive = harness.lifecycle.runExclusiveAfterShared(
      sessionId,
      async () => {
        exclusiveEntered = true;
      },
    );
    await Promise.resolve();
    expect(exclusiveEntered).toBe(false);

    admit();
    await exclusive;
    expect(exclusiveEntered).toBe(true);
    settleTurn('done');
    await expect(prompt).resolves.toBe('done');
  });

  it('creates, durably verifies, binds, releases, then admits the first prompt', async () => {
    mockDurableStandalone();
    const harness = createHarness();

    await expect(
      harness.service.createWithInitialPrompt(
        {
          sessionId: sessionId.toUpperCase(),
          modelServiceId: 'model-a',
          approvalMode: ApprovalMode.DEFAULT,
        },
        'do the task',
      ),
    ).resolves.toMatchObject({
      session: { sessionId, sourceType: 'standalone' },
      projectlessOutputDirectory: identity.canonicalPath,
      workingDirectory: { state: 'ready' },
    });

    expect(harness.bridge.spawnStandaloneSession).toHaveBeenCalledWith({
      workspaceCwd: root.canonicalRoot,
      sessionId,
      modelServiceId: 'model-a',
      approvalMode: 'default',
    });
    expect(harness.bridge.changeSessionCwd).toHaveBeenCalledWith(
      sessionId,
      expect.objectContaining({
        path: identity.canonicalPath,
        allowedRoots: [root.canonicalRoot],
        managedRelocation: 'live-conversation',
        conversationDirectoryExpectation: expect.objectContaining({
          canonicalSessionId: sessionId,
          root: expect.objectContaining({ inode: root.inode }),
          child: expect.objectContaining({ inode: identity.inode }),
        }),
      }),
    );
    expect(
      harness.bridge.commitManagedConversationBinding,
    ).toHaveBeenCalledOnce();
    expect(
      harness.bridge.releaseManagedConversationBinding,
    ).toHaveBeenCalledOnce();
    expect(harness.bridge.sendPrompt).toHaveBeenCalledOnce();
    expect(harness.reservation.release).toHaveBeenCalledOnce();
    expect(harness.quarantineRuntime).not.toHaveBeenCalled();
    expect(harness.invalidateSessionListCache).toHaveBeenCalledOnce();
  });

  it('returns creation after asynchronous admission without waiting for the first turn', async () => {
    mockDurableStandalone();
    const harness = createHarness();
    let admit!: () => void;
    let settleTurn!: () => void;
    const turn = new Promise<{ stopReason: 'end_turn' }>((resolve) => {
      settleTurn = () => resolve({ stopReason: 'end_turn' });
    });
    harness.bridge.sendPrompt.mockImplementationOnce(
      (_id, _request, _signal, context) => {
        admit = context?.onPromptAdmitted ?? (() => {});
        return turn;
      },
    );

    const creating = harness.service.createWithInitialPrompt(
      { sessionId },
      'long-running task',
    );
    await vi.waitFor(() => expect(admit).toBeTypeOf('function'));
    admit();

    const created = await creating;
    expect(created.session).toMatchObject({ sessionId });
    expect(harness.reservation.release).toHaveBeenCalledOnce();
    let turnSettled = false;
    void turn.then(() => {
      turnSettled = true;
    });
    await Promise.resolve();
    expect(turnSettled).toBe(false);

    settleTurn();
    await expect(turn).resolves.toEqual({
      stopReason: 'end_turn',
    });
  });

  it('rejects malformed UUIDs before runtime admission', async () => {
    const harness = createHarness();

    await expect(
      harness.service.createWithInitialPrompt(
        { sessionId: 'not-a-uuid' },
        'do the task',
      ),
    ).rejects.toMatchObject({ code: 'invalid_request' });

    expect(harness.bridge.spawnStandaloneSession).not.toHaveBeenCalled();
    expect(harness.reservation.release).not.toHaveBeenCalled();
  });

  it('rejects a concurrent create for the same canonical UUID before spawning', async () => {
    mockDurableStandalone();
    const harness = createHarness();
    let releaseSpawn!: () => void;
    const spawnStarted = new Promise<void>((resolve) => {
      harness.bridge.spawnStandaloneSession.mockImplementationOnce(
        () =>
          new Promise((spawnResolve) => {
            releaseSpawn = () => {
              spawnResolve({
                sessionId,
                workspaceCwd: root.canonicalRoot,
                attached: false,
                sourceType: 'standalone',
                sourcePersisted: true,
              });
            };
            resolve();
          }),
      );
    });
    const first = harness.service.createWithInitialPrompt(
      { sessionId },
      'first task',
    );
    await spawnStarted;

    await expect(
      harness.service.createWithInitialPrompt(
        { sessionId: sessionId.toUpperCase() },
        'second task',
      ),
    ).rejects.toMatchObject({
      code: 'standalone_session_conflict',
      retryable: true,
    });
    expect(harness.bridge.spawnStandaloneSession).toHaveBeenCalledOnce();

    releaseSpawn();
    await expect(first).resolves.toMatchObject({ session: { sessionId } });
    expect(harness.reservation.release).toHaveBeenCalledOnce();
  });

  it('cleanly rolls back a failure before newSession dispatch', async () => {
    vi.spyOn(
      SessionService.prototype,
      'findSessionIdIgnoringCase',
    ).mockResolvedValue(undefined);
    const harness = createHarness();
    harness.bridge.spawnStandaloneSession.mockRejectedValueOnce(
      new StandaloneSessionSpawnError(false, new Error('channel failed')),
    );

    await expect(
      harness.service.createWithInitialPrompt({ sessionId }, 'do the task'),
    ).rejects.toMatchObject({
      code: 'standalone_creation_rolled_back',
      retryable: true,
    });

    expect(harness.bridge.killSession).not.toHaveBeenCalled();
    expect(harness.quarantineRuntime).not.toHaveBeenCalled();
    expect(harness.reservation.release).toHaveBeenCalledOnce();
  });

  it('freezes the UUID and quarantines after dispatched spawn ambiguity', async () => {
    vi.spyOn(
      SessionService.prototype,
      'findSessionIdIgnoringCase',
    ).mockResolvedValue(undefined);
    const harness = createHarness();
    harness.bridge.spawnStandaloneSession.mockRejectedValueOnce(
      new StandaloneSessionSpawnError(true, new Error('response lost')),
    );

    await expect(
      harness.service.createWithInitialPrompt({ sessionId }, 'do the task'),
    ).rejects.toMatchObject({
      code: 'standalone_creation_outcome_unknown',
    });

    expect(harness.quarantineRuntime).toHaveBeenCalledWith(harness.runtime);
    expect(harness.reservation.release).not.toHaveBeenCalled();
  });

  it('closes and removes a fresh transcript when source persistence failed', async () => {
    vi.spyOn(SessionService.prototype, 'findSessionIdIgnoringCase')
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined);
    vi.spyOn(SessionService.prototype, 'removeSession').mockResolvedValue(true);
    const harness = createHarness();
    harness.bridge.spawnStandaloneSession.mockResolvedValueOnce({
      sessionId,
      workspaceCwd: root.canonicalRoot,
      attached: false,
      sourceType: 'standalone',
      sourcePersisted: false,
    });

    await expect(
      harness.service.createWithInitialPrompt({ sessionId }, 'do the task'),
    ).rejects.toMatchObject({
      code: 'standalone_creation_rolled_back',
      retryable: true,
    });

    expect(harness.bridge.killSession).toHaveBeenCalledWith(sessionId, {
      requireZeroAttaches: true,
    });
    expect(SessionService.prototype.removeSession).toHaveBeenCalledWith(
      sessionId,
    );
    expect(harness.bridge.markSessionCatalogChanged).toHaveBeenCalledOnce();
    expect(harness.quarantineRuntime).not.toHaveBeenCalled();
    expect(harness.reservation.release).toHaveBeenCalledOnce();
  });

  it('quarantines when rollback cannot prove the fresh transcript is absent', async () => {
    vi.spyOn(SessionService.prototype, 'findSessionIdIgnoringCase')
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(sessionId);
    vi.spyOn(SessionService.prototype, 'removeSession').mockResolvedValue(
      false,
    );
    const harness = createHarness();
    harness.bridge.spawnStandaloneSession.mockResolvedValueOnce({
      sessionId,
      workspaceCwd: root.canonicalRoot,
      attached: false,
      sourceType: 'standalone',
      sourcePersisted: false,
    });

    await expect(
      harness.service.createWithInitialPrompt({ sessionId }, 'do the task'),
    ).rejects.toMatchObject({ code: 'standalone_creation_outcome_unknown' });
    expect(harness.bridge.markSessionCatalogChanged).not.toHaveBeenCalled();
    expect(harness.quarantineRuntime).toHaveBeenCalledWith(harness.runtime);
    expect(harness.reservation.release).not.toHaveBeenCalled();
  });

  it('quarantines when binding commit remains unknown after one retry', async () => {
    mockDurableStandalone();
    const harness = createHarness();
    harness.bridge.commitManagedConversationBinding.mockRejectedValue(
      new Error('transport lost'),
    );

    await expect(
      harness.service.createWithInitialPrompt({ sessionId }, 'do the task'),
    ).rejects.toMatchObject({
      code: 'standalone_creation_outcome_unknown',
    });

    expect(
      harness.bridge.commitManagedConversationBinding,
    ).toHaveBeenCalledTimes(2);
    expect(
      harness.bridge.releaseManagedConversationBinding,
    ).not.toHaveBeenCalled();
    expect(harness.bridge.sendPrompt).not.toHaveBeenCalled();
    expect(harness.quarantineRuntime).toHaveBeenCalledWith(harness.runtime);
    expect(harness.reservation.release).not.toHaveBeenCalled();
  });

  it('closes only a wrong fresh returned session before quarantining', async () => {
    vi.spyOn(
      SessionService.prototype,
      'findSessionIdIgnoringCase',
    ).mockResolvedValue(undefined);
    const removeSession = vi.spyOn(SessionService.prototype, 'removeSession');
    const harness = createHarness();
    const returnedSessionId = '22222222-2222-4222-8222-222222222222';
    harness.bridge.spawnStandaloneSession.mockResolvedValueOnce({
      sessionId: returnedSessionId,
      workspaceCwd: root.canonicalRoot,
      attached: false,
      sourceType: 'standalone',
      sourcePersisted: true,
    });

    await expect(
      harness.service.createWithInitialPrompt({ sessionId }, 'do the task'),
    ).rejects.toMatchObject({
      code: 'standalone_creation_outcome_unknown',
    });

    expect(harness.bridge.killSession).toHaveBeenCalledWith(returnedSessionId, {
      requireZeroAttaches: true,
    });
    expect(harness.bridge.killSession).not.toHaveBeenCalledWith(
      sessionId,
      expect.anything(),
    );
    expect(removeSession).not.toHaveBeenCalled();
    expect(harness.quarantineRuntime).toHaveBeenCalledWith(harness.runtime);
    expect(harness.reservation.release).not.toHaveBeenCalled();
  });

  it('closes a fresh creation carrying foreign isolation state before quarantining', async () => {
    vi.spyOn(
      SessionService.prototype,
      'findSessionIdIgnoringCase',
    ).mockResolvedValue(undefined);
    const harness = createHarness();
    harness.bridge.spawnStandaloneSession.mockResolvedValueOnce({
      sessionId,
      workspaceCwd: root.canonicalRoot,
      attached: false,
      sourceType: 'standalone',
      sourcePersisted: true,
      worktree: { slug: 'foreign', path: '/foreign', branch: 'foreign' },
    });

    await expect(
      harness.service.createWithInitialPrompt({ sessionId }, 'do the task'),
    ).rejects.toMatchObject({
      code: 'standalone_creation_outcome_unknown',
    });

    expect(harness.bridge.killSession).toHaveBeenCalledWith(sessionId, {
      requireZeroAttaches: true,
    });
    expect(harness.quarantineRuntime).toHaveBeenCalledWith(harness.runtime);
    expect(harness.reservation.release).not.toHaveBeenCalled();
  });

  it('detaches an unexpected attach result before quarantining', async () => {
    vi.spyOn(
      SessionService.prototype,
      'findSessionIdIgnoringCase',
    ).mockResolvedValue(undefined);
    const harness = createHarness();
    harness.bridge.spawnStandaloneSession.mockResolvedValueOnce({
      sessionId,
      workspaceCwd: root.canonicalRoot,
      attached: true,
      clientId: 'unexpected-client',
      sourceType: 'standalone',
      sourcePersisted: true,
    });

    await expect(
      harness.service.createWithInitialPrompt({ sessionId }, 'do the task'),
    ).rejects.toMatchObject({
      code: 'standalone_creation_outcome_unknown',
    });

    expect(harness.bridge.detachClient).toHaveBeenCalledWith(
      sessionId,
      'unexpected-client',
    );
    expect(harness.bridge.killSession).not.toHaveBeenCalled();
    expect(harness.quarantineRuntime).toHaveBeenCalledWith(harness.runtime);
    expect(harness.reservation.release).not.toHaveBeenCalled();
  });
});
