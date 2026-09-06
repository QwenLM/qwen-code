/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionIdCaseConflictError } from '@qwen-code/qwen-code-core';
import type { AcpSessionBridge } from './acp-session-bridge.js';
import { SessionNotFoundError } from './acp-session-bridge.js';
import { SessionArchiveCoordinator } from './server/session-archive.js';
import {
  createRequestedSessionIdAdmission,
  RequestedSessionIdAdmissionError,
} from './session-id-admission.js';

const sessionServiceMock = vi.hoisted(() => ({
  exists:
    vi.fn<
      (
        cwd: string,
        runtimeBaseDir: string,
        sessionId: string,
      ) => Promise<boolean>
    >(),
  sidecarPath:
    vi.fn<
      (
        cwd: string,
        runtimeBaseDir: string,
        sessionId: string,
        state: 'active' | 'archived',
      ) => string
    >(),
}));

vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/qwen-code-core')>();
  return {
    ...actual,
    SessionService: class {
      constructor(
        private readonly cwd: string,
        private readonly options: { runtimeBaseDir: string },
      ) {}

      async findSessionIdIgnoringCase(
        sessionId: string,
      ): Promise<string | undefined> {
        return (await sessionServiceMock.exists(
          this.cwd,
          this.options.runtimeBaseDir,
          sessionId,
        ))
          ? sessionId
          : undefined;
      }

      getWorktreeSessionPathForArchiveState(
        sessionId: string,
        state: 'active' | 'archived',
      ): string {
        return sessionServiceMock.sidecarPath(
          this.cwd,
          this.options.runtimeBaseDir,
          sessionId,
          state,
        );
      }
    },
  };
});

const SESSION_ID = '550e8400-e29b-41d4-a716-446655440000';
const tempDirs: string[] = [];

function fakeBridge(liveSessionIds: string[] = []): AcpSessionBridge {
  const live = new Set(liveSessionIds);
  return {
    getSessionSummary(sessionId: string) {
      if (!live.has(sessionId)) throw new SessionNotFoundError(sessionId);
      return { sessionId, workspaceCwd: '/live' };
    },
  } as unknown as AcpSessionBridge;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('RequestedSessionIdAdmission', () => {
  beforeEach(() => {
    sessionServiceMock.exists.mockReset();
    sessionServiceMock.exists.mockResolvedValue(false);
    sessionServiceMock.sidecarPath.mockReset();
    sessionServiceMock.sidecarPath.mockReturnValue(
      path.join(os.tmpdir(), `missing-${crypto.randomUUID()}`),
    );
  });

  afterEach(async () => {
    await Promise.all(
      tempDirs
        .splice(0)
        .map((dir) => fsp.rm(dir, { recursive: true, force: true })),
    );
  });

  it('claims synchronously before the persisted scan finishes', async () => {
    const scan = deferred<boolean>();
    sessionServiceMock.exists.mockReturnValue(scan.promise);
    const bridge = fakeBridge();
    const admission = createRequestedSessionIdAdmission({
      archiveCoordinator: new SessionArchiveCoordinator(),
      getBridges: () => [bridge],
      getPersistenceTargets: () => [
        { workspaceCwd: '/one', runtimeBaseDir: '/runtime-one' },
      ],
    });

    const first = admission.reserveCreate(SESSION_ID, {
      bridge,
      workspaceCwd: '/one',
    });
    await expect(
      admission.reserveCreate(SESSION_ID, {
        bridge,
        workspaceCwd: '/one',
      }),
    ).rejects.toMatchObject({ code: 'session_id_conflict' });

    scan.resolve(false);
    (await first).release();
  });

  it('checks every live bridge and every registered persistence target', async () => {
    const current = fakeBridge();
    const draining = fakeBridge([SESSION_ID]);
    const admission = createRequestedSessionIdAdmission({
      archiveCoordinator: new SessionArchiveCoordinator(),
      getBridges: () => [current, draining],
      getPersistenceTargets: () => [],
    });

    await expect(
      admission.reserveCreate(SESSION_ID, {
        bridge: current,
        workspaceCwd: '/current',
      }),
    ).rejects.toMatchObject({
      code: 'session_id_conflict',
      details: { conflict: 'live', liveWorkspaceCwd: '/live' },
    });

    const diskAdmission = createRequestedSessionIdAdmission({
      archiveCoordinator: new SessionArchiveCoordinator(),
      getBridges: () => [current],
      getPersistenceTargets: () => [
        { workspaceCwd: '/one', runtimeBaseDir: '/runtime-one' },
        { workspaceCwd: '/two', runtimeBaseDir: '/runtime-two' },
      ],
    });
    sessionServiceMock.exists.mockImplementation(async (cwd) => cwd === '/two');
    await expect(
      diskAdmission.reserveCreate(SESSION_ID, {
        bridge: current,
        workspaceCwd: '/one',
      }),
    ).rejects.toMatchObject({
      code: 'session_id_conflict',
      details: { conflict: 'persisted', liveWorkspaceCwd: '/two' },
    });
    expect(sessionServiceMock.exists).toHaveBeenCalledWith(
      '/two',
      '/runtime-two',
      SESSION_ID,
    );
  });

  it.each(['active', 'archived'] as const)(
    'treats an %s worktree sidecar as persisted history',
    async (persistedState) => {
      const bridge = fakeBridge();
      const admission = createRequestedSessionIdAdmission({
        archiveCoordinator: new SessionArchiveCoordinator(),
        getBridges: () => [bridge],
        getPersistenceTargets: () => [
          { workspaceCwd: '/one', runtimeBaseDir: '/runtime-one' },
        ],
      });
      const tempDir = await fsp.mkdtemp(
        path.join(os.tmpdir(), 'requested-session-id-'),
      );
      tempDirs.push(tempDir);
      const persistedSidecar = path.join(
        tempDir,
        `${persistedState}.worktree.json`,
      );
      await fsp.writeFile(persistedSidecar, '{}');
      sessionServiceMock.sidecarPath.mockImplementation(
        (_cwd, _runtimeBaseDir, _sessionId, state) =>
          state === persistedState
            ? persistedSidecar
            : path.join(tempDir, `${state}.missing.json`),
      );

      await expect(
        admission.reserveCreate(SESSION_ID, {
          bridge,
          workspaceCwd: '/one',
        }),
      ).rejects.toMatchObject({
        code: 'session_id_conflict',
        details: { conflict: 'persisted' },
      });
    },
  );

  it('treats a case-only transcript conflict as persisted occupancy', async () => {
    const bridge = fakeBridge();
    const admission = createRequestedSessionIdAdmission({
      archiveCoordinator: new SessionArchiveCoordinator(),
      getBridges: () => [bridge],
      getPersistenceTargets: () => [
        { workspaceCwd: '/one', runtimeBaseDir: '/runtime-one' },
      ],
    });
    sessionServiceMock.exists.mockRejectedValueOnce(
      new SessionIdCaseConflictError(SESSION_ID),
    );

    await expect(
      admission.reserveCreate(SESSION_ID, {
        bridge,
        workspaceCwd: '/one',
      }),
    ).rejects.toMatchObject({
      code: 'session_id_conflict',
      details: { conflict: 'persisted' },
    });
  });

  it('shares restore claims only on the same bridge generation', () => {
    const firstBridge = fakeBridge();
    const secondBridge = fakeBridge();
    const admission = createRequestedSessionIdAdmission({
      archiveCoordinator: new SessionArchiveCoordinator(),
      getBridges: () => [firstBridge, secondBridge],
      getPersistenceTargets: () => [],
    });
    const first = admission.reserveRestore(SESSION_ID, {
      bridge: firstBridge,
      workspaceCwd: '/one',
    });
    const second = admission.reserveRestore(SESSION_ID, {
      bridge: firstBridge,
      workspaceCwd: '/alias-for-one',
      workspaceId: 'same-generation',
    });
    expect(() =>
      admission.reserveRestore(SESSION_ID, {
        bridge: secondBridge,
        workspaceCwd: '/two',
      }),
    ).toThrowError(RequestedSessionIdAdmissionError);
    first.release();
    expect(() =>
      admission.reserveRestore(SESSION_ID, {
        bridge: secondBridge,
        workspaceCwd: '/two',
      }),
    ).toThrowError(RequestedSessionIdAdmissionError);
    second.release();
    admission
      .reserveRestore(SESSION_ID, {
        bridge: secondBridge,
        workspaceCwd: '/two',
      })
      .release();
  });

  it('treats mixed-case caller UUIDs as the same restore claim', () => {
    const firstBridge = fakeBridge();
    const secondBridge = fakeBridge();
    const admission = createRequestedSessionIdAdmission({
      archiveCoordinator: new SessionArchiveCoordinator(),
      getBridges: () => [firstBridge, secondBridge],
      getPersistenceTargets: () => [],
    });
    const first = admission.reserveRestore(SESSION_ID, {
      bridge: firstBridge,
      workspaceCwd: '/one',
    });

    expect(() =>
      admission.reserveRestore(SESSION_ID.toUpperCase(), {
        bridge: secondBridge,
        workspaceCwd: '/two',
      }),
    ).toThrowError(RequestedSessionIdAdmissionError);

    first.release();
  });

  it('accepts an equivalent workspace spelling on the same live bridge', () => {
    const bridge = fakeBridge([SESSION_ID]);
    const admission = createRequestedSessionIdAdmission({
      archiveCoordinator: new SessionArchiveCoordinator(),
      getBridges: () => [bridge],
      getPersistenceTargets: () => [],
    });

    admission
      .reserveRestore(SESSION_ID, {
        bridge,
        workspaceCwd: '/alias-for-live',
      })
      .release();
  });

  it('names the live foreign owner workspace id on restore conflicts', () => {
    const liveBridge = fakeBridge([SESSION_ID]);
    const foreignBridge = fakeBridge();
    const admission = createRequestedSessionIdAdmission({
      archiveCoordinator: new SessionArchiveCoordinator(),
      getBridges: () => [liveBridge, foreignBridge],
      getPersistenceTargets: () => [],
      getBridgeWorkspaceId: (bridge) =>
        bridge === liveBridge ? 'live-workspace' : undefined,
    });

    let error: unknown;
    try {
      admission.reserveRestore(SESSION_ID, {
        bridge: foreignBridge,
        workspaceCwd: '/two',
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(RequestedSessionIdAdmissionError);
    expect((error as RequestedSessionIdAdmissionError).details).toMatchObject({
      conflict: 'live',
      liveWorkspaceCwd: '/live',
      liveWorkspaceId: 'live-workspace',
    });
  });

  it('does not let a stale release remove a newer claim', async () => {
    const bridge = fakeBridge();
    const admission = createRequestedSessionIdAdmission({
      archiveCoordinator: new SessionArchiveCoordinator(),
      getBridges: () => [bridge],
      getPersistenceTargets: () => [],
    });
    const stale = admission.reserveRestore(SESSION_ID, {
      bridge,
      workspaceCwd: '/one',
    });
    stale.release();
    const current = await admission.reserveCreate(SESSION_ID, {
      bridge,
      workspaceCwd: '/one',
    });
    stale.release();

    await expect(
      admission.reserveCreate(SESSION_ID, {
        bridge,
        workspaceCwd: '/one',
      }),
    ).rejects.toMatchObject({ code: 'session_id_conflict' });
    current.release();
  });

  it('returns retryable unavailable and releases when a scan fails', async () => {
    const bridge = fakeBridge();
    const admission = createRequestedSessionIdAdmission({
      archiveCoordinator: new SessionArchiveCoordinator(),
      getBridges: () => [bridge],
      getPersistenceTargets: () => [
        { workspaceCwd: '/one', runtimeBaseDir: '/runtime-one' },
      ],
    });
    sessionServiceMock.exists.mockRejectedValueOnce(new Error('scan failed'));

    await expect(
      admission.reserveCreate(SESSION_ID, {
        bridge,
        workspaceCwd: '/one',
      }),
    ).rejects.toMatchObject({
      code: 'session_id_admission_unavailable',
      details: { retryable: true },
    });

    const retry = await admission.reserveCreate(SESSION_ID, {
      bridge,
      workspaceCwd: '/one',
    });
    retry.release();
  });

  it('returns retryable unavailable for a non-ENOENT sidecar error', async () => {
    const bridge = fakeBridge();
    const admission = createRequestedSessionIdAdmission({
      archiveCoordinator: new SessionArchiveCoordinator(),
      getBridges: () => [bridge],
      getPersistenceTargets: () => [
        { workspaceCwd: '/one', runtimeBaseDir: '/runtime-one' },
      ],
    });
    const tempDir = await fsp.mkdtemp(
      path.join(os.tmpdir(), 'requested-session-id-error-'),
    );
    tempDirs.push(tempDir);
    const nonDirectory = path.join(tempDir, 'not-a-directory');
    await fsp.writeFile(nonDirectory, 'file');
    // Traversing a regular file raises ENOTDIR only on POSIX; Windows reports
    // ENOENT, which the admission legitimately reads as "no persisted
    // session". A NUL byte makes fs.access reject with ERR_INVALID_ARG_VALUE
    // on every platform, keeping the non-ENOENT contract under test.
    sessionServiceMock.sidecarPath.mockReturnValue(
      path.join(nonDirectory, 'sidecar\0.json'),
    );

    await expect(
      admission.reserveCreate(SESSION_ID, {
        bridge,
        workspaceCwd: '/one',
      }),
    ).rejects.toMatchObject({
      code: 'session_id_admission_unavailable',
      details: { retryable: true },
    });
  });

  it('fails closed when a bridge cannot be inspected', async () => {
    const bridge = {
      getSessionSummary() {
        throw new Error('bridge unavailable');
      },
    } as unknown as AcpSessionBridge;
    const admission = createRequestedSessionIdAdmission({
      archiveCoordinator: new SessionArchiveCoordinator(),
      getBridges: () => [bridge],
      getPersistenceTargets: () => [],
    });

    await expect(
      admission.reserveCreate(SESSION_ID, {
        bridge,
        workspaceCwd: '/one',
      }),
    ).rejects.toMatchObject({
      code: 'session_id_admission_unavailable',
      details: { retryable: true },
    });
  });

  it('fails closed when live bridges cannot be enumerated', async () => {
    const bridge = fakeBridge();
    const admission = createRequestedSessionIdAdmission({
      archiveCoordinator: new SessionArchiveCoordinator(),
      getBridges: () => {
        throw new Error('registry unavailable');
      },
      getPersistenceTargets: () => [],
    });

    await expect(
      admission.reserveCreate(SESSION_ID, {
        bridge,
        workspaceCwd: '/one',
      }),
    ).rejects.toMatchObject({
      code: 'session_id_admission_unavailable',
      details: { retryable: true },
    });
  });
});
