/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import express, { type Response } from 'express';
import request from 'supertest';
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  SessionService,
  WORKTREE_SESSION_FILE,
  createWorktreeSessionMarkerExclusive,
  readWorktreeSessionMarkerStrict,
  readWorktreeSessionStrict,
  writeWorktreeSession,
  WorktreeMarkerCommittedError,
  type ChatRecord,
  type WorktreeSession,
} from '@qwen-code/qwen-code-core';
import {
  SessionNotFoundError,
  type AcpSessionBridge,
} from '../acp-session-bridge.js';
import { sendBridgeError } from '../server/error-response.js';
import {
  createWorkspaceRegistry,
  type WorkspaceRuntime,
} from '../workspace-registry.js';

const archiveMocks = vi.hoisted(() => ({
  deleteDaemonSessionIfOrphan: vi.fn(),
}));

vi.mock('../server/session-archive.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../server/session-archive.js')>()),
  deleteDaemonSessionIfOrphan: archiveMocks.deleteDaemonSessionIfOrphan,
}));

// The transfer's crash windows sit between durable writes, so the cases that
// pin them observe the core primitives directly. Each spy delegates to the
// real implementation and is re-installed in `beforeEach`; individual cases
// override one call to park or fail the transfer at a chosen step.
type CoreTransferFns = Pick<
  typeof import('@qwen-code/qwen-code-core'),
  | 'writeWorktreeSession'
  | 'readWorktreeSessionStrict'
  | 'transferWorktreeSessionMarkerOwner'
>;
const coreMocks = vi.hoisted(() => ({
  real: {} as CoreTransferFns,
  writeWorktreeSession: vi.fn(),
  readWorktreeSessionStrict: vi.fn(),
  transferWorktreeSessionMarkerOwner: vi.fn(),
}));

vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/qwen-code-core')>();
  coreMocks.real = {
    writeWorktreeSession: actual.writeWorktreeSession,
    readWorktreeSessionStrict: actual.readWorktreeSessionStrict,
    transferWorktreeSessionMarkerOwner:
      actual.transferWorktreeSessionMarkerOwner,
  };
  return {
    ...actual,
    writeWorktreeSession: coreMocks.writeWorktreeSession,
    readWorktreeSessionStrict: coreMocks.readWorktreeSessionStrict,
    transferWorktreeSessionMarkerOwner:
      coreMocks.transferWorktreeSessionMarkerOwner,
  };
});

import { registerSessionRoutes } from './session.js';

const tmpRoot = mkdtempSync(path.join(tmpdir(), 'session-worktree-reset-'));
afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

type CreationMetadata = Awaited<
  ReturnType<SessionService['readCreationMetadata']>
>;
const CHANNEL_METADATA: CreationMetadata = {
  sourceType: 'channel',
  sourceId: 'telegram',
};

beforeEach(() => {
  vi.clearAllMocks();
  archiveMocks.deleteDaemonSessionIfOrphan.mockResolvedValue(true);
  coreMocks.writeWorktreeSession.mockImplementation(
    coreMocks.real.writeWorktreeSession,
  );
  coreMocks.readWorktreeSessionStrict.mockImplementation(
    coreMocks.real.readWorktreeSessionStrict,
  );
  coreMocks.transferWorktreeSessionMarkerOwner.mockImplementation(
    coreMocks.real.transferWorktreeSessionMarkerOwner,
  );
  vi.spyOn(SessionService.prototype, 'readCreationMetadata').mockResolvedValue(
    CHANNEL_METADATA,
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

interface SessionSummaryStub {
  hasActivePrompt: boolean;
  pendingInteractionCount?: number;
}

interface FakeBridge {
  bridge: AcpSessionBridge;
  spawnedIds: string[];
  getSessionSummary: ReturnType<typeof vi.fn>;
  spawnOrAttach: ReturnType<typeof vi.fn>;
  changeSessionCwd: ReturnType<typeof vi.fn>;
  setSessionWorktree: ReturnType<typeof vi.fn>;
  clearSessionWorktree: ReturnType<typeof vi.fn>;
  severSessionClients: ReturnType<typeof vi.fn>;
  setSessionResetPending: ReturnType<typeof vi.fn>;
  clearSessionResetPending: ReturnType<typeof vi.fn>;
  loadSession: ReturnType<typeof vi.fn>;
  killSession: ReturnType<typeof vi.fn>;
  detachClient: ReturnType<typeof vi.fn>;
  setSummary(sessionId: string, summary: SessionSummaryStub): void;
}

function makeBridge(options: { resetSupport?: boolean } = {}): FakeBridge {
  const summaries = new Map<string, SessionSummaryStub>();
  const spawnedIds: string[] = [];
  const getSessionSummary = vi.fn((sessionId: string) => {
    const summary = summaries.get(sessionId);
    if (!summary) throw new SessionNotFoundError(sessionId);
    return summary;
  });
  const spawnOrAttach = vi.fn(async () => {
    const sessionId = randomUUID();
    spawnedIds.push(sessionId);
    return { sessionId, attached: false };
  });
  const changeSessionCwd = vi.fn(
    async (sessionId: string, req: { path: string }) => ({
      sessionId,
      previousCwd: '',
      newCwd: realpathSync(req.path),
      warnings: [],
    }),
  );
  const setSessionWorktree = vi.fn();
  const clearSessionWorktree = vi.fn();
  // The bridge reports whether the superseded entry is gone after its drain
  // loop; a child holding background work refuses the idle close and it
  // survives. Tests override this per case with mockResolvedValueOnce(false).
  const severSessionClients = vi.fn(async () => true);
  const setSessionResetPending = vi.fn(() => true);
  const clearSessionResetPending = vi.fn();
  const loadSession = vi.fn(
    async (req: { sessionId: string; workspaceCwd: string }) => ({
      sessionId: req.sessionId,
      workspaceCwd: req.workspaceCwd,
      currentCwd: req.workspaceCwd,
      attached: false,
      clientId: undefined,
      hasActivePrompt: false,
    }),
  );
  const killSession = vi.fn(async () => true);
  const detachClient = vi.fn(async () => {});
  const bridge = {
    getSessionSummary,
    spawnOrAttach,
    changeSessionCwd,
    setSessionWorktree,
    loadSession,
    resumeSession: loadSession,
    killSession,
    detachClient,
    markSessionCatalogChanged: vi.fn(),
    deleteSessionAttachments: vi.fn(async () => {}),
    ...(options.resetSupport === false
      ? {}
      : {
          clearSessionWorktree,
          severSessionClients,
          setSessionResetPending,
          clearSessionResetPending,
        }),
  } as unknown as AcpSessionBridge;
  return {
    bridge,
    spawnedIds,
    getSessionSummary,
    spawnOrAttach,
    changeSessionCwd,
    setSessionWorktree,
    clearSessionWorktree,
    severSessionClients,
    setSessionResetPending,
    clearSessionResetPending,
    loadSession,
    killSession,
    detachClient,
    setSummary: (sessionId, summary) => {
      summaries.set(sessionId, summary);
    },
  };
}

function makeFixture(
  options: {
    resetSupport?: boolean;
    onResponse?: (res: Response) => void;
  } = {},
) {
  const workspaceDir = path.join(tmpRoot, randomUUID());
  const slug = 'task';
  const worktreeDir = path.join(workspaceDir, '.qwen', 'worktrees', slug);
  mkdirSync(worktreeDir, { recursive: true });
  const runtimeBaseDir = path.join(tmpRoot, randomUUID());
  const sessionService = new SessionService(workspaceDir, { runtimeBaseDir });
  const fake = makeBridge(options);
  const runtime = {
    workspaceId: randomUUID(),
    workspaceCwd: workspaceDir,
    sessionRuntimeBaseDir: runtimeBaseDir,
    primary: true,
    trusted: true,
    bridge: fake.bridge,
  } as WorkspaceRuntime;
  const app = express();
  app.use(express.json());
  // Registered before the routes so a case can hold the live response and
  // destroy its socket mid-transfer, the way an aborted caller does.
  if (options.onResponse) {
    const onResponse = options.onResponse;
    app.use((_req, res, next) => {
      onResponse(res);
      next();
    });
  }
  const registry = createWorkspaceRegistry([runtime]);
  registerSessionRoutes(app, {
    boundWorkspace: workspaceDir,
    bridge: fake.bridge,
    workspaceRegistry: registry,
    archiveCoordinator: {
      runSharedMany: async (_sessionIds, fn) => await fn(),
    } as Parameters<typeof registerSessionRoutes>[1]['archiveCoordinator'],
    mutate: () => (_req, _res, next) => next(),
    sendBridgeError,
    sessionShellCommandEnabled: true,
    languageCodes: ['en'],
  });
  const worktreeBranch = `worktree-${slug}`;
  const realTarget = realpathSync(worktreeDir);
  const candidateRoots = [
    path.join(realpathSync(workspaceDir), '.qwen', 'worktrees'),
  ];
  return {
    workspaceDir,
    slug,
    worktreeDir,
    worktreeBranch,
    realTarget,
    candidateRoots,
    sessionService,
    fake,
    app,
    async writeSidecar(
      sessionId: string,
      overrides: Partial<WorktreeSession> = {},
    ): Promise<void> {
      await writeWorktreeSession(
        sessionService.getWorktreeSessionPath(sessionId),
        {
          slug,
          worktreePath: worktreeDir,
          worktreeBranch,
          originalCwd: workspaceDir,
          workspaceCwd: workspaceDir,
          originalBranch: 'main',
          originalHeadCommit: 'abc123',
          ...overrides,
        },
      );
    },
    // The reset route resolves the session record through the transcript
    // store (resolveSessionIdForRestore): one head record whose cwd belongs
    // to the fixture workspace is enough to make the id resolvable.
    writeTranscript(sessionId: string): void {
      const record: ChatRecord = {
        uuid: 'u1',
        parentUuid: null,
        sessionId,
        timestamp: new Date(Date.UTC(2026, 0, 1)).toISOString(),
        type: 'user',
        provenance: 'real_user',
        cwd: workspaceDir,
        version: '1.0.0',
        message: { role: 'user', parts: [{ text: 'hello' }] },
      };
      const transcriptPath = sessionService.getSessionTranscriptPath(sessionId);
      mkdirSync(path.dirname(transcriptPath), { recursive: true });
      writeFileSync(transcriptPath, `${JSON.stringify(record)}\n`, 'utf8');
    },
    readSidecar(sessionId: string) {
      return readWorktreeSessionStrict(
        sessionService.getWorktreeSessionPath(sessionId),
      );
    },
    readMarker() {
      return readWorktreeSessionMarkerStrict(worktreeDir);
    },
    createMarker(sessionId: string) {
      return createWorktreeSessionMarkerExclusive(worktreeDir, sessionId);
    },
    // The marker is git-excluded, so a task-local `git clean -xdf` removes it
    // from a checkout whose transfer already committed.
    removeMarker(): void {
      rmSync(path.join(worktreeDir, WORKTREE_SESSION_FILE), { force: true });
    },
  };
}

type Fixture = ReturnType<typeof makeFixture>;

async function expectSidecar(
  fixture: Fixture,
  sessionId: string,
): Promise<WorktreeSession | undefined> {
  const read = await fixture.readSidecar(sessionId);
  expect(read.state).not.toBe('invalid');
  return read.state === 'valid' ? read.session : undefined;
}

async function expectMarkerOwner(
  fixture: Fixture,
  sessionId: string,
): Promise<void> {
  const marker = await fixture.readMarker();
  expect(marker.state).toBe('valid');
  if (marker.state === 'valid') {
    expect(marker.sessionId).toBe(sessionId);
  }
}

describe('POST /session/:id/worktree-reset', () => {
  it('transfers worktree ownership to a fresh replacement session', async () => {
    const fixture = makeFixture();
    const oldId = randomUUID();
    fixture.writeTranscript(oldId);
    await fixture.writeSidecar(oldId);
    await fixture.createMarker(oldId);

    const res = await request(fixture.app)
      .post(`/session/${oldId}/worktree-reset`)
      .send({});

    expect(res.status).toBe(200);
    const newId = res.body.sessionId;
    expect(typeof newId).toBe('string');
    expect(newId).not.toBe(oldId);
    expect(res.body.currentCwd).toBe(fixture.realTarget);
    expect(res.body.worktree).toEqual({
      slug: fixture.slug,
      path: fixture.realTarget,
      branch: fixture.worktreeBranch,
    });
    expect(res.body.worktreeState).toBe('persisted-v1');

    expect(fixture.fake.spawnOrAttach).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceCwd: fixture.workspaceDir,
        sessionScope: 'thread',
      }),
    );
    expect(fixture.fake.changeSessionCwd).toHaveBeenCalledWith(
      newId,
      expect.objectContaining({ path: fixture.realTarget }),
    );
    expect(fixture.fake.setSessionWorktree).toHaveBeenCalledWith(newId, {
      slug: fixture.slug,
      path: fixture.realTarget,
      branch: fixture.worktreeBranch,
    });
    expect(fixture.fake.clearSessionWorktree).toHaveBeenCalledWith(oldId);
    expect(fixture.fake.severSessionClients).toHaveBeenCalledWith(oldId);
    expect(fixture.fake.setSessionResetPending).toHaveBeenCalledWith(oldId);
    expect(fixture.fake.clearSessionResetPending).toHaveBeenCalledWith(oldId);

    const oldSidecar = await expectSidecar(fixture, oldId);
    expect(oldSidecar?.supersededBy).toBe(newId);
    const newSidecar = await expectSidecar(fixture, newId);
    expect(newSidecar?.supersedes).toBe(oldId);
    expect(newSidecar?.supersededBy).toBeUndefined();
    await expectMarkerOwner(fixture, newId);
    expect(archiveMocks.deleteDaemonSessionIfOrphan).not.toHaveBeenCalled();
  });

  it('rejects with 409 when the session has no worktree sidecar', async () => {
    const fixture = makeFixture();
    const sessionId = randomUUID();
    fixture.writeTranscript(sessionId);

    const res = await request(fixture.app)
      .post(`/session/${sessionId}/worktree-reset`)
      .send({});

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('worktree_reset_unsupported');
    expect(res.body.sessionId).toBe(sessionId);
    expect(fixture.fake.spawnOrAttach).not.toHaveBeenCalled();
  });

  it('rejects with 409 for a legacy sidecar without workspaceCwd', async () => {
    const fixture = makeFixture();
    const sessionId = randomUUID();
    fixture.writeTranscript(sessionId);
    await fixture.writeSidecar(sessionId, { workspaceCwd: undefined });
    await fixture.createMarker(sessionId);

    const res = await request(fixture.app)
      .post(`/session/${sessionId}/worktree-reset`)
      .send({});

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('worktree_reset_unsupported');
    expect(fixture.fake.spawnOrAttach).not.toHaveBeenCalled();
  });

  it('rejects with 409 while the old session has an active prompt', async () => {
    const fixture = makeFixture();
    const oldId = randomUUID();
    fixture.writeTranscript(oldId);
    await fixture.writeSidecar(oldId);
    await fixture.createMarker(oldId);
    fixture.fake.setSummary(oldId, {
      hasActivePrompt: true,
      pendingInteractionCount: 0,
    });

    const res = await request(fixture.app)
      .post(`/session/${oldId}/worktree-reset`)
      .send({});

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('worktree_reset_active');
    expect(res.body.sessionId).toBe(oldId);
    expect(fixture.fake.spawnOrAttach).not.toHaveBeenCalled();
    const oldSidecar = await expectSidecar(fixture, oldId);
    expect(oldSidecar?.supersededBy).toBeUndefined();
    await expectMarkerOwner(fixture, oldId);
    expect(fixture.fake.clearSessionResetPending).toHaveBeenCalledWith(oldId);
  });

  it('releases the ownership lock after a refused transfer so the checkout stays usable', async () => {
    const fixture = makeFixture();
    const oldId = randomUUID();
    fixture.writeTranscript(oldId);
    await fixture.writeSidecar(oldId);
    await fixture.createMarker(oldId);
    // A refusal from inside the lock: the busy check runs after the transfer
    // acquired it, so this is the path where a leaked key would wedge every
    // later operation on the same checkout.
    fixture.fake.setSummary(oldId, {
      hasActivePrompt: true,
      pendingInteractionCount: 0,
    });

    const refused = await request(fixture.app)
      .post(`/session/${oldId}/worktree-reset`)
      .send({});

    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('worktree_reset_active');
    expect(fixture.fake.spawnOrAttach).not.toHaveBeenCalled();

    fixture.fake.setSummary(oldId, {
      hasActivePrompt: false,
      pendingInteractionCount: 0,
    });
    // Both take the same worktree-keyed lock. Awaited directly on purpose: a
    // refusal that leaked the key would hang here until the test times out.
    const load = await request(fixture.app)
      .post(`/session/${oldId}/load`)
      .send({});

    expect(load.status).toBe(200);
    expect(load.body.worktreeState).toBe('persisted-v1');

    const retry = await request(fixture.app)
      .post(`/session/${oldId}/worktree-reset`)
      .send({});

    expect(retry.status).toBe(200);
    expect(retry.body.sessionId).not.toBe(oldId);
    await expectMarkerOwner(fixture, retry.body.sessionId);
  });

  it('rejects with 404 when the session record is missing', async () => {
    const fixture = makeFixture();
    const sessionId = randomUUID();
    // A valid worktree sidecar and marker must not rescue the request:
    // without a persisted transcript the resolver reports the id missing.
    await fixture.writeSidecar(sessionId);
    await fixture.createMarker(sessionId);

    const res = await request(fixture.app)
      .post(`/session/${sessionId}/worktree-reset`)
      .send({});

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('session_not_found');
    expect(res.body.sessionId).toBe(sessionId);
    expect(fixture.fake.spawnOrAttach).not.toHaveBeenCalled();
  });

  it('fails with 500 when the bridge lacks worktree reset support', async () => {
    const fixture = makeFixture({ resetSupport: false });
    const sessionId = randomUUID();
    fixture.writeTranscript(sessionId);

    const res = await request(fixture.app)
      .post(`/session/${sessionId}/worktree-reset`)
      .send({});

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Bridge does not support worktree reset');
  });

  it('rolls back an interrupted pre-commit transfer and runs a fresh one', async () => {
    const fixture = makeFixture();
    const oldId = randomUUID();
    const crashedId = randomUUID();
    fixture.writeTranscript(oldId);
    fixture.writeTranscript(crashedId);
    await fixture.writeSidecar(oldId, { supersededBy: crashedId });
    await fixture.writeSidecar(crashedId, { supersedes: oldId });
    await fixture.createMarker(oldId);

    const res = await request(fixture.app)
      .post(`/session/${oldId}/worktree-reset`)
      .send({});

    expect(res.status).toBe(200);
    const newId = res.body.sessionId;
    expect(newId).not.toBe(crashedId);
    expect(newId).toBe(fixture.fake.spawnedIds[0]);
    expect(res.body.worktreeState).toBe('persisted-v1');

    expect(archiveMocks.deleteDaemonSessionIfOrphan).toHaveBeenCalledTimes(1);
    expect(archiveMocks.deleteDaemonSessionIfOrphan).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: crashedId }),
    );
    expect(await fixture.readSidecar(crashedId)).toEqual({
      state: 'missing',
    });

    const oldSidecar = await expectSidecar(fixture, oldId);
    expect(oldSidecar?.supersededBy).toBe(newId);
    const newSidecar = await expectSidecar(fixture, newId);
    expect(newSidecar?.supersedes).toBe(oldId);
    await expectMarkerOwner(fixture, newId);
  });

  it('resumes a committed transfer idempotently without respawning', async () => {
    const fixture = makeFixture();
    const oldId = randomUUID();
    const replacementId = randomUUID();
    fixture.writeTranscript(oldId);
    fixture.writeTranscript(replacementId);
    await fixture.writeSidecar(oldId, { supersededBy: replacementId });
    await fixture.writeSidecar(replacementId, { supersedes: oldId });
    await fixture.createMarker(replacementId);

    const res = await request(fixture.app)
      .post(`/session/${oldId}/worktree-reset`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.sessionId).toBe(replacementId);
    expect(res.body.currentCwd).toBe(fixture.realTarget);
    expect(res.body.worktree).toEqual({
      slug: fixture.slug,
      path: fixture.realTarget,
      branch: fixture.worktreeBranch,
    });
    expect(res.body.worktreeState).toBe('persisted-v1');
    expect(res.body.attached).toBe(false);

    expect(fixture.fake.spawnOrAttach).not.toHaveBeenCalled();
    expect(fixture.fake.clearSessionWorktree).toHaveBeenCalledWith(oldId);
    expect(fixture.fake.severSessionClients).toHaveBeenCalledWith(oldId);
    expect(archiveMocks.deleteDaemonSessionIfOrphan).not.toHaveBeenCalled();

    const oldSidecar = await expectSidecar(fixture, oldId);
    expect(oldSidecar?.supersededBy).toBe(replacementId);
    await expectMarkerOwner(fixture, replacementId);
  });

  it('rolls back an interrupted pre-commit transfer whose replacement has no transcript record', async () => {
    const fixture = makeFixture();
    const oldId = randomUUID();
    const crashedId = randomUUID();
    fixture.writeTranscript(oldId);
    // The crash left the sidecar pair linked before the replacement ever
    // persisted a record: the marker, not the record, decides the rollback.
    await fixture.writeSidecar(oldId, { supersededBy: crashedId });
    await fixture.writeSidecar(crashedId, { supersedes: oldId });
    await fixture.createMarker(oldId);

    const res = await request(fixture.app)
      .post(`/session/${oldId}/worktree-reset`)
      .send({});

    expect(res.status).toBe(200);
    const newId = res.body.sessionId;
    expect(newId).not.toBe(crashedId);
    expect(res.body.worktreeState).toBe('persisted-v1');

    expect(archiveMocks.deleteDaemonSessionIfOrphan).toHaveBeenCalledTimes(1);
    expect(archiveMocks.deleteDaemonSessionIfOrphan).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: crashedId }),
    );
    expect(await fixture.readSidecar(crashedId)).toEqual({ state: 'missing' });
    await expectMarkerOwner(fixture, newId);
  });

  it('refuses a pre-commit rollback whose interrupted replacement survives', async () => {
    const fixture = makeFixture();
    const oldId = randomUUID();
    const crashedId = randomUUID();
    fixture.writeTranscript(oldId);
    await fixture.writeSidecar(oldId, { supersededBy: crashedId });
    await fixture.writeSidecar(crashedId, { supersedes: oldId });
    await fixture.createMarker(oldId);
    // `false` is a documented outcome, not an error: a client attached to the
    // interrupted replacement, so `requireZeroAttaches` bailed and it is still
    // live inside the checkout.
    archiveMocks.deleteDaemonSessionIfOrphan.mockResolvedValueOnce(false);

    const res = await request(fixture.app)
      .post(`/session/${oldId}/worktree-reset`)
      .send({});

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('worktree_reset_invalid_state');
    // Fail closed before the destructive writes: the survivor keeps both links
    // that name it, so nothing is dismantled and no second writer is spawned
    // into the same checkout beside it.
    expect(fixture.fake.spawnOrAttach).not.toHaveBeenCalled();
    const oldSidecar = await expectSidecar(fixture, oldId);
    expect(oldSidecar?.supersededBy).toBe(crashedId);
    const crashedSidecar = await expectSidecar(fixture, crashedId);
    expect(crashedSidecar?.supersedes).toBe(oldId);
    await expectMarkerOwner(fixture, oldId);
    expect(fixture.fake.clearSessionWorktree).not.toHaveBeenCalled();
    expect(fixture.fake.severSessionClients).not.toHaveBeenCalled();
    // Nothing committed, so releasing the barrier is still this request's.
    expect(fixture.fake.clearSessionResetPending).toHaveBeenCalledWith(oldId);
  });

  it('leaves the backward link alone when the pre-commit rollback fails halfway', async () => {
    const fixture = makeFixture();
    const oldId = randomUUID();
    const crashedId = randomUUID();
    fixture.writeTranscript(oldId);
    await fixture.writeSidecar(oldId, { supersededBy: crashedId });
    await fixture.writeSidecar(crashedId, { supersedes: oldId });
    await fixture.createMarker(oldId);
    // The rollback's second write is the one that drops the backward link, so
    // an ENOSPC or a crash between the two leaves the residue this pins.
    coreMocks.writeWorktreeSession.mockImplementationOnce(async () => {
      throw Object.assign(new Error('no space left on device'), {
        code: 'ENOSPC',
      });
    });

    const res = await request(fixture.app)
      .post(`/session/${oldId}/worktree-reset`)
      .send({});

    expect(res.status).toBe(500);
    // The forward link went first, so the residue is the backward link alone:
    // the replacement's sidecar is gone while `S_old` still names it.
    expect(await fixture.readSidecar(crashedId)).toEqual({ state: 'missing' });
    const oldSidecar = await expectSidecar(fixture, oldId);
    expect(oldSidecar?.supersededBy).toBe(crashedId);
    await expectMarkerOwner(fixture, oldId);

    // A retry refuses that disagreeing pair for repair instead of taking the
    // fresh path and spawning a second replacement beside the first.
    const retry = await request(fixture.app)
      .post(`/session/${oldId}/worktree-reset`)
      .send({});

    expect(retry.status).toBe(409);
    expect(retry.body.code).toBe('worktree_reset_invalid_state');
    expect(fixture.fake.spawnOrAttach).not.toHaveBeenCalled();
  });

  it('resumes a committed transfer idempotently when the replacement has no transcript record', async () => {
    const fixture = makeFixture();
    const oldId = randomUUID();
    const replacementId = randomUUID();
    fixture.writeTranscript(oldId);
    await fixture.writeSidecar(oldId, { supersededBy: replacementId });
    await fixture.writeSidecar(replacementId, { supersedes: oldId });
    await fixture.createMarker(replacementId);

    const res = await request(fixture.app)
      .post(`/session/${oldId}/worktree-reset`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.sessionId).toBe(replacementId);
    expect(res.body.worktreeState).toBe('persisted-v1');
    expect(fixture.fake.spawnOrAttach).not.toHaveBeenCalled();
    expect(fixture.fake.clearSessionWorktree).toHaveBeenCalledWith(oldId);
    expect(fixture.fake.severSessionClients).toHaveBeenCalledWith(oldId);
    expect(archiveMocks.deleteDaemonSessionIfOrphan).not.toHaveBeenCalled();
    await expectMarkerOwner(fixture, replacementId);
  });

  it('refuses a marker-cleaned committed transfer while the replacement is live', async () => {
    const fixture = makeFixture();
    const oldId = randomUUID();
    fixture.writeTranscript(oldId);
    await fixture.writeSidecar(oldId);
    await fixture.createMarker(oldId);

    const committed = await request(fixture.app)
      .post(`/session/${oldId}/worktree-reset`)
      .send({});
    expect(committed.status).toBe(200);
    const replacementId = committed.body.sessionId;
    fixture.writeTranscript(replacementId);
    // The committed transfer cleared and severed the old session itself;
    // only the retry's bridge calls are under test from here on.
    vi.clearAllMocks();
    // A `git clean -xdf` in the checkout removes the excluded marker, and the
    // committed replacement is still live on this daemon: the marker-missing
    // shape now reads exactly like the pre-commit crash shape.
    fixture.removeMarker();
    expect((await fixture.readMarker()).state).toBe('missing');
    fixture.fake.setSummary(replacementId, {
      hasActivePrompt: false,
      pendingInteractionCount: 0,
    });

    const retry = await request(fixture.app)
      .post(`/session/${oldId}/worktree-reset`)
      .send({});

    expect(retry.status).toBe(409);
    expect(retry.body.code).toBe('worktree_reset_invalid_state');
    // Nothing destructive ran and no second writer was spawned.
    expect(archiveMocks.deleteDaemonSessionIfOrphan).not.toHaveBeenCalled();
    expect(fixture.fake.clearSessionWorktree).not.toHaveBeenCalled();
    expect(fixture.fake.severSessionClients).not.toHaveBeenCalled();
    expect(fixture.fake.spawnOrAttach).not.toHaveBeenCalled();
    const replacementSidecar = await expectSidecar(fixture, replacementId);
    expect(replacementSidecar?.supersedes).toBe(oldId);
    const oldSidecar = await expectSidecar(fixture, oldId);
    expect(oldSidecar?.supersededBy).toBe(replacementId);
    expect(
      existsSync(
        fixture.sessionService.getSessionTranscriptPath(replacementId),
      ),
    ).toBe(true);
    expect((await fixture.readMarker()).state).toBe('missing');
    expect(fixture.fake.clearSessionResetPending).toHaveBeenCalledWith(oldId);
  });

  it('refuses a pre-commit resume whose replacement sidecar is missing', async () => {
    const fixture = makeFixture();
    const oldId = randomUUID();
    const replacementId = randomUUID();
    fixture.writeTranscript(oldId);
    await fixture.writeSidecar(oldId, { supersededBy: replacementId });
    // The crash left the backward link but never persisted the forward one,
    // so the pair disagrees and the rollback the marker would authorize has
    // nothing to agree with. The transfer writes the backward link first
    // precisely so this is the shape such a crash leaves — a visible refusal
    // rather than a forward link no retry ever looks for.
    await fixture.createMarker(oldId);

    const res = await request(fixture.app)
      .post(`/session/${oldId}/worktree-reset`)
      .send({});

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('worktree_reset_invalid_state');
    expect(res.body.sessionId).toBe(oldId);
    // Fail-closed: the interrupted state survives untouched for repair.
    expect(fixture.fake.spawnOrAttach).not.toHaveBeenCalled();
    expect(archiveMocks.deleteDaemonSessionIfOrphan).not.toHaveBeenCalled();
    expect(fixture.fake.clearSessionWorktree).not.toHaveBeenCalled();
    expect(fixture.fake.severSessionClients).not.toHaveBeenCalled();
    const oldSidecar = await expectSidecar(fixture, oldId);
    expect(oldSidecar?.supersededBy).toBe(replacementId);
    expect(await fixture.readSidecar(replacementId)).toEqual({
      state: 'missing',
    });
    await expectMarkerOwner(fixture, oldId);
    expect(fixture.fake.clearSessionResetPending).toHaveBeenCalledWith(oldId);
  });

  it('writes the backward supersede link before the forward one', async () => {
    const fixture = makeFixture();
    const oldId = randomUUID();
    fixture.writeTranscript(oldId);
    await fixture.writeSidecar(oldId);
    await fixture.createMarker(oldId);
    const writesBefore = coreMocks.writeWorktreeSession.mock.calls.length;

    const res = await request(fixture.app)
      .post(`/session/${oldId}/worktree-reset`)
      .send({});

    expect(res.status).toBe(200);
    const newId = res.body.sessionId;
    const oldSidecarPath = fixture.sessionService.getWorktreeSessionPath(oldId);
    const newSidecarPath = fixture.sessionService.getWorktreeSessionPath(newId);
    const transferWrites =
      coreMocks.writeWorktreeSession.mock.calls.slice(writesBefore);
    // The backward link is the only door into the resume classification, so
    // it has to be durable first: a crash between the two writes then leaves
    // the shape the case above refuses for repair, instead of a dangling
    // forward link that no retry ever sees (it would spawn a second
    // replacement and strand the first under an untyped 500 forever).
    expect(transferWrites.map((call) => call[0])).toEqual([
      oldSidecarPath,
      newSidecarPath,
    ]);
    expect(transferWrites[0]?.[1]).toMatchObject({ supersededBy: newId });
    expect(transferWrites[1]?.[1]).toMatchObject({ supersedes: oldId });
  });

  it('refuses a committed resume whose replacement links to another session', async () => {
    const fixture = makeFixture();
    const oldId = randomUUID();
    const replacementId = randomUUID();
    const unrelatedId = randomUUID();
    fixture.writeTranscript(oldId);
    await fixture.writeSidecar(oldId, { supersededBy: replacementId });
    await fixture.writeSidecar(replacementId, { supersedes: unrelatedId });
    await fixture.createMarker(replacementId);

    const res = await request(fixture.app)
      .post(`/session/${oldId}/worktree-reset`)
      .send({});

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('worktree_reset_invalid_state');
    expect(res.body.sessionId).toBe(oldId);
    // The marker committed ownership, so the idempotent finish must not
    // sever the old session against a replacement that disowns it.
    expect(fixture.fake.spawnOrAttach).not.toHaveBeenCalled();
    expect(fixture.fake.clearSessionWorktree).not.toHaveBeenCalled();
    expect(fixture.fake.severSessionClients).not.toHaveBeenCalled();
    expect(archiveMocks.deleteDaemonSessionIfOrphan).not.toHaveBeenCalled();
    const oldSidecar = await expectSidecar(fixture, oldId);
    expect(oldSidecar?.supersededBy).toBe(replacementId);
    const replacementSidecar = await expectSidecar(fixture, replacementId);
    expect(replacementSidecar?.supersedes).toBe(unrelatedId);
    await expectMarkerOwner(fixture, replacementId);
    // The marker committed ownership, so this refusal is post-commit: the
    // superseded entry stays fenced for operator repair instead of being
    // re-admitted as a writer into a checkout the marker has handed over.
    expect(fixture.fake.clearSessionResetPending).not.toHaveBeenCalled();
  });

  it('keeps the barrier armed when a committed resume finds the replacement busy', async () => {
    const fixture = makeFixture();
    const oldId = randomUUID();
    const replacementId = randomUUID();
    fixture.writeTranscript(oldId);
    await fixture.writeSidecar(oldId, { supersededBy: replacementId });
    await fixture.writeSidecar(replacementId, { supersedes: oldId });
    await fixture.createMarker(replacementId);
    // The replacement is a session in use — reached through the superseded
    // redirect and prompted by another client — so the idempotent finish
    // refuses instead of severing underneath it.
    fixture.fake.setSummary(replacementId, {
      hasActivePrompt: true,
      pendingInteractionCount: 0,
    });

    const res = await request(fixture.app)
      .post(`/session/${oldId}/worktree-reset`)
      .send({});

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('worktree_reset_active');
    expect(res.body.sessionId).toBe(replacementId);
    expect(fixture.fake.spawnOrAttach).not.toHaveBeenCalled();
    expect(fixture.fake.severSessionClients).not.toHaveBeenCalled();
    // This refusal is post-commit too — the marker named the replacement
    // before the request started — so the superseded entry stays fenced
    // rather than being re-admitted into a checkout it no longer owns.
    expect(fixture.fake.clearSessionResetPending).not.toHaveBeenCalled();

    // The protocol's answer to `worktree_reset_active` is "retry once it
    // settles", so the fence must not be stranded: the settled retry finishes
    // the severance and drops it.
    fixture.fake.setSummary(replacementId, {
      hasActivePrompt: false,
      pendingInteractionCount: 0,
    });
    const retry = await request(fixture.app)
      .post(`/session/${oldId}/worktree-reset`)
      .send({});

    expect(retry.status).toBe(200);
    expect(retry.body.sessionId).toBe(replacementId);
    expect(fixture.fake.spawnOrAttach).not.toHaveBeenCalled();
    expect(fixture.fake.clearSessionResetPending).toHaveBeenCalledWith(oldId);
  });

  it('rolls back sidecars and the orphan replacement when the marker flip fails', async () => {
    const fixture = makeFixture();
    const oldId = randomUUID();
    const thirdPartyId = randomUUID();
    fixture.writeTranscript(oldId);
    await fixture.writeSidecar(oldId);
    await fixture.createMarker(thirdPartyId);

    const res = await request(fixture.app)
      .post(`/session/${oldId}/worktree-reset`)
      .send({});

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('worktree_reset_invalid_state');

    expect(fixture.fake.spawnOrAttach).toHaveBeenCalledTimes(1);
    const spawnedId = fixture.fake.spawnedIds[0]!;
    expect(archiveMocks.deleteDaemonSessionIfOrphan).toHaveBeenCalledTimes(1);
    expect(archiveMocks.deleteDaemonSessionIfOrphan).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: spawnedId }),
    );
    expect(await fixture.readSidecar(spawnedId)).toEqual({
      state: 'missing',
    });

    const oldSidecar = await expectSidecar(fixture, oldId);
    expect(oldSidecar?.supersededBy).toBeUndefined();
    await expectMarkerOwner(fixture, thirdPartyId);
    expect(fixture.fake.clearSessionWorktree).not.toHaveBeenCalled();
    expect(fixture.fake.severSessionClients).not.toHaveBeenCalled();
    expect(fixture.fake.clearSessionResetPending).toHaveBeenCalledWith(oldId);
  });

  it('keeps the linked pair when the fresh rollback cannot reap its spawn', async () => {
    const fixture = makeFixture();
    const oldId = randomUUID();
    const thirdPartyId = randomUUID();
    fixture.writeTranscript(oldId);
    await fixture.writeSidecar(oldId);
    await fixture.createMarker(thirdPartyId);
    // The flip fails and the spawned replacement cannot be removed: a client
    // attached to it in the meantime, so it is still live in the checkout.
    archiveMocks.deleteDaemonSessionIfOrphan.mockResolvedValueOnce(false);

    const res = await request(fixture.app)
      .post(`/session/${oldId}/worktree-reset`)
      .send({});

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('worktree_reset_invalid_state');
    const spawnedId = fixture.fake.spawnedIds[0]!;
    expect(archiveMocks.deleteDaemonSessionIfOrphan).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: spawnedId }),
    );
    // The compensation stops before unwriting the links, so the survivor stays
    // named on disk and a retry classifies it there instead of spawning a
    // second writer into the same checkout.
    const oldSidecar = await expectSidecar(fixture, oldId);
    expect(oldSidecar?.supersededBy).toBe(spawnedId);
    const spawnedSidecar = await expectSidecar(fixture, spawnedId);
    expect(spawnedSidecar?.supersedes).toBe(oldId);
    await expectMarkerOwner(fixture, thirdPartyId);
    expect(fixture.fake.severSessionClients).not.toHaveBeenCalled();

    const retry = await request(fixture.app)
      .post(`/session/${oldId}/worktree-reset`)
      .send({});

    expect(retry.status).toBe(409);
    expect(retry.body.code).toBe('worktree_reset_invalid_state');
    expect(fixture.fake.spawnOrAttach).toHaveBeenCalledTimes(1);
  });

  it('reaps the spawned replacement when the caller disconnects before the flip', async () => {
    let liveResponse: Response | undefined;
    const fixture = makeFixture({
      onResponse: (res) => {
        liveResponse = res;
      },
    });
    const oldId = randomUUID();
    const spawnedId = randomUUID();
    fixture.writeTranscript(oldId);
    await fixture.writeSidecar(oldId);
    await fixture.createMarker(oldId);
    const oldSidecarPath = fixture.sessionService.getWorktreeSessionPath(oldId);

    // Park the transfer at the spawn so the socket can go away while the
    // handover is still running, before the marker flip commits it.
    let releaseSpawn!: () => void;
    const spawnGate = new Promise<void>((resolve) => {
      releaseSpawn = resolve;
    });
    let resetAtSpawn!: () => void;
    const resetSpawned = new Promise<void>((resolve) => {
      resetAtSpawn = resolve;
    });
    fixture.fake.spawnOrAttach.mockImplementationOnce(async () => {
      resetAtSpawn();
      await spawnGate;
      return { sessionId: spawnedId, attached: false };
    });
    // The dead socket settles the caller's promise at once while the route
    // runs on, so the rollback signals its own progress: the reap is its first
    // act, and its last is restoring the old sidecar — whose payload has no
    // `supersededBy`, unlike the transfer's own write to that same path.
    let reaped!: () => void;
    const reapCalled = new Promise<void>((resolve) => {
      reaped = resolve;
    });
    archiveMocks.deleteDaemonSessionIfOrphan.mockImplementationOnce(
      async () => {
        reaped();
        return true;
      },
    );
    let rollbackDone!: () => void;
    const rollbackFinished = new Promise<void>((resolve) => {
      rollbackDone = resolve;
    });
    const realWrite = coreMocks.real.writeWorktreeSession;
    coreMocks.writeWorktreeSession.mockImplementation(
      async (...args: Parameters<typeof realWrite>) => {
        const written = await realWrite(...args);
        if (args[0] === oldSidecarPath && args[1].supersededBy === undefined) {
          rollbackDone();
        }
        return written;
      },
    );

    const inFlight = request(fixture.app)
      .post(`/session/${oldId}/worktree-reset`)
      .send({})
      .then(
        (response) => response.status,
        () => undefined,
      );
    await resetSpawned;
    // The caller's budget expired: `fetchWithTimeout` aborts and the socket
    // goes away mid-transfer.
    liveResponse?.destroy();
    expect(liveResponse?.destroyed).toBe(true);
    releaseSpawn();
    // Without the disconnect guard neither signal ever arrives and this hangs
    // until the test times out.
    await reapCalled;
    await rollbackFinished;
    await inFlight;

    // The handover never committed and the replacement this request minted is
    // reaped instead of being left live in the checkout, holding a
    // registration whose id no caller ever received.
    expect(archiveMocks.deleteDaemonSessionIfOrphan).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: spawnedId }),
    );
    await expectMarkerOwner(fixture, oldId);
    expect(await fixture.readSidecar(spawnedId)).toEqual({ state: 'missing' });
    const oldSidecar = await expectSidecar(fixture, oldId);
    expect(oldSidecar?.supersededBy).toBeUndefined();
    expect(fixture.fake.severSessionClients).not.toHaveBeenCalled();
    expect(fixture.fake.clearSessionWorktree).not.toHaveBeenCalled();
  });

  it('never compensates backwards when a step after the marker flip fails', async () => {
    const fixture = makeFixture();
    const oldId = randomUUID();
    fixture.writeTranscript(oldId);
    await fixture.writeSidecar(oldId);
    await fixture.createMarker(oldId);
    // Severing the superseded session's attaches is the last awaited step of
    // the transfer and runs after the flip already committed ownership.
    fixture.fake.severSessionClients.mockRejectedValueOnce(
      new Error('client teardown failed'),
    );

    const res = await request(fixture.app)
      .post(`/session/${oldId}/worktree-reset`)
      .send({});

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('client teardown failed');
    expect(fixture.fake.spawnOrAttach).toHaveBeenCalledTimes(1);
    const newId = fixture.fake.spawnedIds[0]!;
    // The failure is genuinely post-flip: the replacement was attested first.
    expect(fixture.fake.setSessionWorktree).toHaveBeenCalledWith(newId, {
      slug: fixture.slug,
      path: fixture.realTarget,
      branch: fixture.worktreeBranch,
    });
    // The checkout belongs to the replacement now, so the sidecar links stay
    // and the replacement is neither orphan-reaped nor replaced again.
    await expectMarkerOwner(fixture, newId);
    const oldSidecarAfter = await expectSidecar(fixture, oldId);
    expect(oldSidecarAfter?.supersededBy).toBe(newId);
    const newSidecar = await expectSidecar(fixture, newId);
    expect(newSidecar?.supersedes).toBe(oldId);
    expect(archiveMocks.deleteDaemonSessionIfOrphan).not.toHaveBeenCalled();
    // The failure is post-commit, so releasing the barrier is not this
    // request's to do: the superseded entry stays fenced instead of being
    // re-admitted as a writer into the checkout the marker just handed over.
    expect(fixture.fake.clearSessionResetPending).not.toHaveBeenCalled();

    // The fence is not stranded: the retry resumes the committed transfer,
    // the severance completes, and the barrier is dropped there.
    const retry = await request(fixture.app)
      .post(`/session/${oldId}/worktree-reset`)
      .send({});

    expect(retry.status).toBe(200);
    expect(retry.body.sessionId).toBe(newId);
    expect(fixture.fake.spawnOrAttach).toHaveBeenCalledTimes(1);
    expect(fixture.fake.severSessionClients).toHaveBeenCalledTimes(2);
    expect(fixture.fake.clearSessionResetPending).toHaveBeenCalledWith(oldId);
  });

  it('never rolls back a marker flip whose post-commit tail failed', async () => {
    const fixture = makeFixture();
    const oldId = randomUUID();
    fixture.writeTranscript(oldId);
    await fixture.writeSidecar(oldId);
    await fixture.createMarker(oldId);
    const realTransfer = coreMocks.real.transferWorktreeSessionMarkerOwner;
    // Commit the flip for real, then fail the way the primitive's own
    // post-commit tail does: the marker handle's close runs after the marker
    // is durable and propagates with the marker intact.
    coreMocks.transferWorktreeSessionMarkerOwner.mockImplementationOnce(
      async (...args: Parameters<typeof realTransfer>) => {
        await realTransfer(...args);
        throw new WorktreeMarkerCommittedError(args[2], {
          cause: Object.assign(new Error('i/o error, close'), {
            code: 'EIO',
          }),
        });
      },
    );

    const res = await request(fixture.app)
      .post(`/session/${oldId}/worktree-reset`)
      .send({});

    const newId = fixture.fake.spawnedIds[0]!;
    expect(archiveMocks.deleteDaemonSessionIfOrphan).not.toHaveBeenCalled();
    // Not the invalid-state 409, whose contract is that this request made no
    // destructive change: the marker already names the replacement.
    expect(res.status).toBe(500);
    expect(res.body.code).toBeUndefined();
    expect(res.body.error).not.toMatch(/ownership state is invalid/);
    // The pre-flip rollback did not run: both sidecars and the replacement's
    // record survive, and the marker stays on the committed owner.
    const oldSidecar = await expectSidecar(fixture, oldId);
    expect(oldSidecar?.supersededBy).toBe(newId);
    const newSidecar = await expectSidecar(fixture, newId);
    expect(newSidecar?.supersedes).toBe(oldId);
    await expectMarkerOwner(fixture, newId);
    // The primitive's tail failed with ownership already moved, so the barrier
    // stays armed on the superseded entry rather than being released back into
    // a checkout the marker has handed to the replacement.
    expect(fixture.fake.clearSessionResetPending).not.toHaveBeenCalled();

    // The response tells the caller to retry; the retry resumes the committed
    // transfer instead of spawning a second replacement.
    const retry = await request(fixture.app)
      .post(`/session/${oldId}/worktree-reset`)
      .send({});

    expect(retry.status).toBe(200);
    expect(retry.body.sessionId).toBe(newId);
    expect(fixture.fake.spawnOrAttach).toHaveBeenCalledTimes(1);
    // The resumed severance completes, and that is what drops the fence.
    expect(fixture.fake.clearSessionResetPending).toHaveBeenCalledWith(oldId);
  });

  it('keeps the barrier armed and reports a superseded session that survives sever', async () => {
    const fixture = makeFixture();
    const oldId = randomUUID();
    fixture.writeTranscript(oldId);
    await fixture.writeSidecar(oldId);
    await fixture.createMarker(oldId);
    // The child holds background work, so the last detach's idle close is
    // refused and the superseded entry survives inside the checkout whose
    // ownership just moved.
    fixture.fake.severSessionClients.mockResolvedValueOnce(false);

    const res = await request(fixture.app)
      .post(`/session/${oldId}/worktree-reset`)
      .send({});

    expect(res.status).toBe(200);
    const newId = res.body.sessionId;
    await expectMarkerOwner(fixture, newId);
    // The survivor stays fenced: the barrier is armed and never cleared.
    expect(fixture.fake.setSessionResetPending).toHaveBeenCalledWith(oldId);
    expect(fixture.fake.clearSessionResetPending).not.toHaveBeenCalled();
    // Never escalate: killSession turns a close error into a channel kill,
    // and the replacement was spawned onto that same workspace-bound bridge.
    expect(fixture.fake.killSession).not.toHaveBeenCalled();
    // And the 200 reports the hold instead of certifying a severance that did
    // not happen.
    expect(res.body.supersededSessionLive).toBe(true);

    // A retry while the child still holds takes the committed resume path and
    // must report the same hold rather than clear the barrier.
    fixture.fake.severSessionClients.mockResolvedValueOnce(false);
    const retry = await request(fixture.app)
      .post(`/session/${oldId}/worktree-reset`)
      .send({});

    expect(retry.status).toBe(200);
    expect(retry.body.sessionId).toBe(newId);
    expect(retry.body.supersededSessionLive).toBe(true);
    expect(fixture.fake.spawnOrAttach).toHaveBeenCalledTimes(1);
    expect(fixture.fake.clearSessionResetPending).not.toHaveBeenCalled();

    // Once the child releases its holds the resumed severance completes and
    // the barrier is finally dropped.
    const settled = await request(fixture.app)
      .post(`/session/${oldId}/worktree-reset`)
      .send({});

    expect(settled.status).toBe(200);
    expect(settled.body.sessionId).toBe(newId);
    expect(settled.body.supersededSessionLive).toBeUndefined();
    expect(fixture.fake.spawnOrAttach).toHaveBeenCalledTimes(1);
    expect(fixture.fake.clearSessionResetPending).toHaveBeenCalledWith(oldId);
  });
});

describe('POST /session/:id/load worktree classifications', () => {
  it('redirects a superseded session restore to the replacement', async () => {
    const fixture = makeFixture();
    const oldId = randomUUID();
    const replacementId = randomUUID();
    await fixture.writeSidecar(oldId, { supersededBy: replacementId });
    await fixture.createMarker(replacementId);

    const res = await request(fixture.app)
      .post(`/session/${oldId}/load`)
      .send({});

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('worktree_session_superseded');
    expect(res.body.sessionId).toBe(oldId);
    expect(res.body.replacementSessionId).toBe(replacementId);
    expect(fixture.fake.loadSession).not.toHaveBeenCalled();
  });

  it('decides the superseded redirect under the ownership lock, not before it', async () => {
    const fixture = makeFixture();
    const oldId = randomUUID();
    fixture.writeTranscript(oldId);
    await fixture.writeSidecar(oldId);
    await fixture.createMarker(oldId);
    const oldSidecarPath = fixture.sessionService.getWorktreeSessionPath(oldId);

    // Park the transfer at the marker flip: both sidecar links are durably on
    // disk and the reset holds the worktree-keyed ownership lock.
    let reachedFlip!: () => void;
    const atFlip = new Promise<void>((resolve) => {
      reachedFlip = resolve;
    });
    let releaseFlip!: () => void;
    const flipGate = new Promise<void>((resolve) => {
      releaseFlip = resolve;
    });
    coreMocks.transferWorktreeSessionMarkerOwner.mockImplementationOnce(
      async () => {
        reachedFlip();
        await flipGate;
        // Fail the flip, so the pre-commit rollback clears the very link the
        // contending load is about to observe.
        throw new Error('Worktree marker owner does not match the expectation');
      },
    );
    // Signal once the load has read the old sidecar, so the rollback cannot
    // race ahead of the observation this case is about.
    let loadIssued = false;
    let preReadDone!: () => void;
    const loadPreRead = new Promise<void>((resolve) => {
      preReadDone = resolve;
    });
    const realRead = coreMocks.real.readWorktreeSessionStrict;
    coreMocks.readWorktreeSessionStrict.mockImplementation(
      async (...args: Parameters<typeof realRead>) => {
        const read = await realRead(...args);
        if (loadIssued && args[0] === oldSidecarPath) preReadDone();
        return read;
      },
    );

    // Supertest dispatches on the first `then`, so both requests are chained.
    const resetInFlight = request(fixture.app)
      .post(`/session/${oldId}/worktree-reset`)
      .send({})
      .then((response) => response);
    await atFlip;
    // The transient shape a pre-lock decision would act on: the backward link
    // names a replacement this daemon is about to delete.
    const midTransfer = await fixture.readSidecar(oldId);
    expect(midTransfer.state).toBe('valid');
    if (midTransfer.state === 'valid') {
      expect(midTransfer.session.supersededBy).toBe(fixture.fake.spawnedIds[0]);
    }

    loadIssued = true;
    const loadInFlight = request(fixture.app)
      .post(`/session/${oldId}/load`)
      .send({})
      .then((response) => response);
    await loadPreRead;

    releaseFlip();
    const [resetResponse, loadResponse] = await Promise.all([
      resetInFlight,
      loadInFlight,
    ]);

    expect(resetResponse.status).toBe(409);
    expect(resetResponse.body.code).toBe('worktree_reset_invalid_state');
    // The rollback cleared the link while the load waited for the lock, so the
    // locked re-read restores the session that still owns the checkout
    // instead of redirecting to a replacement that no longer exists.
    expect(loadResponse.status).toBe(200);
    expect(loadResponse.body.code).toBeUndefined();
    expect(loadResponse.body.replacementSessionId).toBeUndefined();
    expect(loadResponse.body.worktreeState).toBe('persisted-v1');
    const oldSidecar = await expectSidecar(fixture, oldId);
    expect(oldSidecar?.supersededBy).toBeUndefined();
    await expectMarkerOwner(fixture, oldId);
  });

  it('rejects a Part4A restore when the ownership marker is missing', async () => {
    const fixture = makeFixture();
    const sessionId = randomUUID();
    await fixture.writeSidecar(sessionId);

    const res = await request(fixture.app)
      .post(`/session/${sessionId}/load`)
      .send({});

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('worktree_marker_missing');
    expect(res.body.sessionId).toBe(sessionId);
    expect(fixture.fake.loadSession).toHaveBeenCalledTimes(1);
    expect(fixture.fake.killSession).toHaveBeenCalledWith(sessionId, {
      requireZeroAttaches: true,
    });
  });

  it('rejects a replacement restore whose marker still names the old session', async () => {
    const fixture = makeFixture();
    const oldId = randomUUID();
    const replacementId = randomUUID();
    await fixture.writeSidecar(replacementId, { supersedes: oldId });
    await fixture.writeSidecar(oldId, { supersededBy: replacementId });
    await fixture.createMarker(oldId);

    const res = await request(fixture.app)
      .post(`/session/${replacementId}/load`)
      .send({});

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('worktree_reset_interrupted');
    expect(res.body.sessionId).toBe(replacementId);
    // The interrupted handoff's other side is the SUPERSEDED session, so it
    // must not ride the wire under the key that tells a caller which id to
    // load instead: the restore target already is the replacement.
    expect(res.body.replacementSessionId).toBeUndefined();
    expect(fixture.fake.killSession).toHaveBeenCalledWith(replacementId, {
      requireZeroAttaches: true,
    });
  });

  it('serializes a source-less restore behind an in-flight reset', async () => {
    const fixture = makeFixture();
    const oldId = randomUUID();
    const replacementId = randomUUID();
    fixture.writeTranscript(oldId);
    await fixture.writeSidecar(oldId);
    await fixture.createMarker(oldId);

    // Hold the transfer mid-flight: the reset owns the worktree-keyed lock
    // for its whole duration, including while the replacement spawns.
    let releaseSpawn!: () => void;
    const spawnGate = new Promise<void>((resolve) => {
      releaseSpawn = resolve;
    });
    let resetHoldsLock!: () => void;
    const resetAtSpawn = new Promise<void>((resolve) => {
      resetHoldsLock = resolve;
    });
    fixture.fake.spawnOrAttach.mockImplementationOnce(async () => {
      // Reached only after the ownership lock was acquired.
      resetHoldsLock();
      await spawnGate;
      return { sessionId: replacementId, attached: false };
    });
    // The contending restore is source-less: no source in the request and no
    // persisted source on the session, so it is not a Channel restore.
    let metadataRead!: () => void;
    const metadataGate = new Promise<void>((resolve) => {
      metadataRead = resolve;
    });
    vi.spyOn(
      SessionService.prototype,
      'readCreationMetadata',
    ).mockImplementation(async () => {
      metadataRead();
      return {};
    });

    // Supertest dispatches on the first `then`, so both requests are chained
    // here: the reset must already be in flight before the restore starts.
    const resetInFlight = request(fixture.app)
      .post(`/session/${oldId}/worktree-reset`)
      .send({})
      .then((response) => response);
    await resetAtSpawn;

    let restoreSettled = false;
    const restoreInFlight = request(fixture.app)
      .post(`/session/${oldId}/load`)
      .send({})
      .then((response) => {
        restoreSettled = true;
        return response;
      });
    // The restore reaches the ownership gate right after its metadata read;
    // from there it waits instead of attesting ownership mid-transfer. Poll
    // so an ungated restore is caught however slowly the box runs.
    await metadataGate;
    const deadline = Date.now() + 500;
    while (!restoreSettled && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(restoreSettled).toBe(false);
    expect(fixture.fake.loadSession).not.toHaveBeenCalled();

    releaseSpawn();
    const [resetResponse, restoreResponse] = await Promise.all([
      resetInFlight,
      restoreInFlight,
    ]);

    expect(resetResponse.status).toBe(200);
    expect(resetResponse.body.sessionId).toBe(replacementId);
    // Released state: the restore observes the completed transfer and
    // redirects to the replacement instead of attesting the superseded
    // session it asked for.
    expect(restoreResponse.status).toBe(409);
    expect(restoreResponse.body.code).toBe('worktree_session_superseded');
    expect(restoreResponse.body.sessionId).toBe(oldId);
    expect(restoreResponse.body.replacementSessionId).toBe(replacementId);
    expect(fixture.fake.setSessionWorktree).toHaveBeenCalledTimes(1);
    expect(fixture.fake.setSessionWorktree).toHaveBeenCalledWith(
      replacementId,
      expect.objectContaining({ path: fixture.realTarget }),
    );
    expect(fixture.fake.changeSessionCwd).not.toHaveBeenCalledWith(
      oldId,
      expect.anything(),
    );
  });

  it('keeps a legacy sidecar restore lock-free while a reset holds the worktree', async () => {
    const fixture = makeFixture();
    const ownerId = randomUUID();
    const legacyId = randomUUID();
    fixture.writeTranscript(ownerId);
    fixture.writeTranscript(legacyId);
    await fixture.writeSidecar(ownerId);
    // A legacy sidecar records no workspace: its restore validates on the
    // legacy path and must never contend on the worktree-keyed lock.
    await fixture.writeSidecar(legacyId, { workspaceCwd: undefined });
    await fixture.createMarker(ownerId);

    let releaseSpawn!: () => void;
    const spawnGate = new Promise<void>((resolve) => {
      releaseSpawn = resolve;
    });
    let resetHoldsLock!: () => void;
    const resetAtSpawn = new Promise<void>((resolve) => {
      resetHoldsLock = resolve;
    });
    fixture.fake.spawnOrAttach.mockImplementationOnce(async () => {
      resetHoldsLock();
      await spawnGate;
      return { sessionId: randomUUID(), attached: false };
    });
    vi.spyOn(
      SessionService.prototype,
      'readCreationMetadata',
    ).mockResolvedValue({});

    const resetInFlight = request(fixture.app)
      .post(`/session/${ownerId}/worktree-reset`)
      .send({})
      .then((response) => response);
    await resetAtSpawn;

    // Awaited directly on purpose: a legacy restore that wrongly took the
    // lock would hang here until the reset was released, failing the test.
    const legacyResponse = await request(fixture.app)
      .post(`/session/${legacyId}/load`)
      .send({});

    expect(legacyResponse.status).toBe(200);
    expect(legacyResponse.body.worktree).toEqual(
      expect.objectContaining({ path: fixture.realTarget }),
    );

    releaseSpawn();
    expect((await resetInFlight).status).toBe(200);
  });

  it('attests persisted-v1 when the marker proves ownership', async () => {
    const fixture = makeFixture();
    const sessionId = randomUUID();
    await fixture.writeSidecar(sessionId);
    await fixture.createMarker(sessionId);

    const res = await request(fixture.app)
      .post(`/session/${sessionId}/load`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.worktree).toEqual({
      slug: fixture.slug,
      path: fixture.realTarget,
      branch: fixture.worktreeBranch,
    });
    expect(res.body.worktreeState).toBe('persisted-v1');
    expect(res.body.currentCwd).toBe(fixture.realTarget);
    expect(fixture.fake.changeSessionCwd).toHaveBeenCalledWith(
      sessionId,
      expect.objectContaining({ path: fixture.realTarget }),
    );
    expect(fixture.fake.setSessionWorktree).toHaveBeenCalledWith(sessionId, {
      slug: fixture.slug,
      path: fixture.realTarget,
      branch: fixture.worktreeBranch,
    });
    expect(fixture.fake.killSession).not.toHaveBeenCalled();
  });
});
