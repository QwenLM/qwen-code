/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  GitWorktreeService,
  SessionService,
  readWorktreeSnapshotMeta,
  readWorktreeSessionStrict,
  WORKTREE_SESSION_FILE,
  writeWorktreeSession,
  writeWorktreeSessionMarker,
} from '@qwen-code/qwen-code-core';
import { SessionOrganizationService } from '@qwen-code/qwen-code-core/services/session-organization-service.js';
import {
  getCronFilePath,
  type DurableCronTask,
} from '@qwen-code/qwen-code-core/services/cronTasksFile.js';
import { worktreeHasPopulatedGitlink } from '@qwen-code/qwen-code-core/services/gitWorktreeService.js';
import {
  selectWorktreeSnapshot,
  verifyRestoredWorktreeSnapshot,
} from '@qwen-code/qwen-code-core/services/worktree-snapshot-service.js';
import { writeRuntimeStatus } from '@qwen-code/qwen-code-core/utils/runtimeStatus.js';
import { Storage } from '@qwen-code/qwen-code-core/config/storage.js';

function git(cwd: string, home: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      PATH: process.env['PATH'],
      HOME: home,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
    },
    stdio: 'pipe',
  }).trim();
}
import {
  createWorkspaceGenerationGuard,
  createWorkspaceRegistry,
} from '../workspace-registry.js';
import {
  createWorkspaceRuntimeSessionService,
  runWithWorkspaceRuntimeStorage,
} from '../workspace-runtime-storage.js';
import type { AcpSessionBridge } from '../acp-session-bridge.js';
import { SessionArchiveCoordinator } from './session-archive.js';
import * as sessionListModule from './session-list.js';
import { listWorkspaceSessionsForResponse } from './session-list.js';
import {
  executeWorktreeCleanup,
  preclassifyWorktreeCleanup,
  verifyWorktreeCleanupOwnership,
} from './worktree-orphan-cleanup.js';
import * as worktreeOwnership from './worktree-ownership-op.js';
import {
  startWorktreeRetention,
  sweepWorktreeRetentionOnce,
} from './worktree-retention.js';
import {
  configureRetention,
  makeRetainedSession,
  makeRetentionRepo,
  type RetentionTestRuntime,
} from '../../test-utils/worktree-session-retention-fixtures.js';

const failedJsonWrite = vi.hoisted(() => ({
  filePath: undefined as string | undefined,
  failAfterWrite: false,
  threwAfterWrite: false,
}));
const captureGate = vi.hoisted(() => ({
  barrier: undefined as
    | { captured: () => void; release: Promise<void> }
    | undefined,
}));
const appearingDirectory = vi.hoisted(() => ({
  worktreePath: undefined as string | undefined,
}));
vi.mock(
  '@qwen-code/qwen-code-core/utils/atomicFileWrite.js',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('@qwen-code/qwen-code-core/utils/atomicFileWrite.js')
      >();
    return {
      ...actual,
      atomicWriteJSON: vi.fn(
        async (
          filePath: string,
          data: unknown,
          options?: Parameters<typeof actual.atomicWriteJSON>[2],
        ) => {
          if (filePath === failedJsonWrite.filePath) {
            if (failedJsonWrite.failAfterWrite) {
              failedJsonWrite.filePath = undefined;
              failedJsonWrite.failAfterWrite = false;
              failedJsonWrite.threwAfterWrite = true;
              await actual.atomicWriteJSON(filePath, data, options);
              throw new Error('injected post-write persistence failure');
            }
            throw new Error('injected binding persistence failure');
          }
          return actual.atomicWriteJSON(filePath, data, options);
        },
      ),
    };
  },
);

const captureInit = vi.hoisted(() => ({
  worktreePath: undefined as string | undefined,
  home: undefined as string | undefined,
  sourceRepo: undefined as string | undefined,
  objectStore: undefined as string | undefined,
  sidecarPath: undefined as string | undefined,
  initializeAfterBinding: false,
  initialized: false,
}));
vi.mock(
  '@qwen-code/qwen-code-core/services/worktree-snapshot-service.js',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('@qwen-code/qwen-code-core/services/worktree-snapshot-service.js')
      >();
    const capture = actual.captureWorktreeSnapshot;
    return {
      ...actual,
      captureWorktreeSnapshot: vi.fn(
        async (
          options: Parameters<typeof actual.captureWorktreeSnapshot>[0],
        ) => {
          const result = await capture(options);
          if (captureGate.barrier) {
            captureGate.barrier.captured();
            await captureGate.barrier.release;
          }
          return result;
        },
      ),
      selectWorktreeSnapshot: vi.fn(
        async (
          options: Parameters<typeof actual.selectWorktreeSnapshot>[0],
        ) => {
          const result = await actual.selectWorktreeSnapshot(options);
          if (result && appearingDirectory.worktreePath) {
            fs.mkdirSync(appearingDirectory.worktreePath, { recursive: true });
            appearingDirectory.worktreePath = undefined;
          }
          return result;
        },
      ),
      verifyRestoredWorktreeSnapshot: vi.fn(
        async (
          options: Parameters<typeof actual.verifyRestoredWorktreeSnapshot>[0],
        ) => {
          const matches = await actual.verifyRestoredWorktreeSnapshot(options);
          if (matches && captureInit.initializeAfterBinding) {
            expect(captureInit.sidecarPath).toBeDefined();
            const record = await readWorktreeSessionStrict(
              captureInit.sidecarPath!,
            );
            if (
              record.state !== 'valid' ||
              record.session.worktreeRemoved === undefined
            ) {
              return matches;
            }
          }
          if (
            matches &&
            captureInit.worktreePath !== undefined &&
            !captureInit.initialized &&
            path.resolve(options.worktreePath) ===
              path.resolve(captureInit.worktreePath)
          ) {
            expect(captureInit.home).toBeDefined();
            expect(captureInit.sourceRepo).toBeDefined();
            expect(captureInit.objectStore).toBeDefined();
            git(
              options.worktreePath,
              captureInit.home!,
              'clone',
              '--bare',
              captureInit.sourceRepo!,
              captureInit.objectStore!,
            );
            captureInit.initialized = true;
          }
          return matches;
        },
      ),
    };
  },
);

let root: string;
let coordinator: SessionArchiveCoordinator;

beforeEach(() => {
  captureGate.barrier = undefined;
  appearingDirectory.worktreePath = undefined;
  captureInit.worktreePath = undefined;
  captureInit.home = undefined;
  captureInit.sourceRepo = undefined;
  captureInit.objectStore = undefined;
  captureInit.sidecarPath = undefined;
  captureInit.initializeAfterBinding = false;
  captureInit.initialized = false;
  failedJsonWrite.filePath = undefined;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-worktree-retention-'));
  coordinator = new SessionArchiveCoordinator();
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

function snapshotFiles(directory: string, sessionId: string): string[] {
  return fs
    .readdirSync(directory)
    .filter(
      (file) =>
        file.startsWith(`${sessionId}.`) &&
        file.includes('.worktree-snapshot.'),
    )
    .sort();
}

async function sweep(
  runtime: RetentionTestRuntime,
  registry = createWorkspaceRegistry([runtime.runtime]),
) {
  return runWithWorkspaceRuntimeStorage(runtime.runtime, () =>
    sweepWorktreeRetentionOnce(runtime.runtime, registry, coordinator),
  );
}

async function writeOwnerRuntimeStatus(
  target: RetentionTestRuntime,
  sessionId: string,
  worktreePath: string,
  pid?: number,
): Promise<void> {
  await writeRuntimeStatus(
    path.join(
      target.runtime.sessionRuntimeBaseDir,
      'projects',
      'owner-probe',
      'chats',
      `${sessionId}.runtime.json`,
    ),
    {
      sessionId,
      workDir: worktreePath,
      qwenVersion: null,
      ...(pid === undefined ? {} : { pid }),
    },
  );
}

function writeUnverifiableOwnerRecord(
  target: RetentionTestRuntime,
  sessionId: string,
  worktreePath: string,
  statusPath = new Storage(
    worktreePath,
    target.runtime.sessionRuntimeBaseDir,
  ).getRuntimeStatusPath(sessionId),
): void {
  fs.mkdirSync(path.dirname(statusPath), { recursive: true });
  fs.writeFileSync(
    statusPath,
    JSON.stringify({
      schema_version: 1,
      pid: process.pid,
      proc_start: null,
      pid_ns: null,
      session_id: sessionId,
      work_dir: worktreePath,
      hostname: 'unverifiable-owner.invalid',
      started_at: Date.now() / 1000,
      qwen_version: null,
    }),
  );
}

async function writeScheduledTaskFile(
  target: RetentionTestRuntime,
  contents: readonly DurableCronTask[] | string,
): Promise<string> {
  return runWithWorkspaceRuntimeStorage(target.runtime, () => {
    const filePath = getCronFilePath(target.repo);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      filePath,
      typeof contents === 'string' ? contents : JSON.stringify(contents),
    );
    return filePath;
  });
}

function persistentTask(
  sessionId: string | undefined,
  enabled = true,
): DurableCronTask {
  return {
    id: `retention-${sessionId ?? 'unbound'}`,
    cron: '0 0 * * *',
    prompt: 'retention fixture; do not execute',
    recurring: true,
    createdAt: 0,
    lastFiredAt: null,
    enabled,
    sessionMode: 'persistent',
    ...(sessionId === undefined ? {} : { sessionId }),
  };
}

async function expectRetainedSnapshot(
  target: RetentionTestRuntime,
  session: Awaited<ReturnType<typeof makeRetainedSession>>,
): Promise<void> {
  expect(fs.existsSync(session.worktreePath)).toBe(false);
  const read = await readWorktreeSessionStrict(session.sidecarPath);
  expect(read.state).toBe('valid');
  if (read.state !== 'valid') return;
  const key = read.session.worktreeRemoved?.archiveKey;
  expect(key).toBeDefined();
  expect(key).not.toContain('/');
  const archive = path.join(path.dirname(session.sidecarPath), key!);
  const header = await readWorktreeSnapshotMeta(
    archive.replace(/\.tar\.gz$/, '.json'),
  );
  await expect(fs.promises.lstat(archive)).resolves.toBeDefined();
  expect(header.version).toBe(2);
  expect(header.sessionId).toBe(session.id);
  expect(header.slug).toBe(session.sidecar.slug);
  expect(header.headCommit).toBe(target.head);
  expect(fs.existsSync(session.transcriptPath)).toBe(true);
}

async function historicalRemovalWithoutBinding(
  target: RetentionTestRuntime,
  slug: string,
) {
  const session = await makeRetainedSession(target, {
    slug,
    dirty: true,
    activity: '2026-01-01T00:00:00.000Z',
  });
  const plan = await preclassifyWorktreeCleanup(
    target.service,
    session.id,
    target.repo,
  );
  if (!plan) throw new Error('Missing historical fixture ownership');
  const outcome = await executeWorktreeCleanup(plan, {
    requireSnapshot: true,
  });
  if (!outcome.removed || !outcome.snapshot) {
    throw new Error('Historical fixture did not complete capture and removal');
  }
  const archiveKey = path.basename(outcome.snapshot.snapshotPath);
  expect(
    await selectWorktreeSnapshot({
      directory: path.dirname(session.sidecarPath),
      sessionId: session.id,
      slug: session.sidecar.slug,
      archiveKey,
    }),
  ).toBeDefined();
  return { session, archiveKey };
}

describe('worktree retention with real repositories', () => {
  vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

  it('sweeps primary and secondary roots independently and snapshots a pristine checkout', async () => {
    const primary = makeRetentionRepo(root, 'primary');
    const secondary = makeRetentionRepo(root, 'secondary');
    configureRetention(primary, 1);
    configureRetention(secondary, 1);
    const registry = createWorkspaceRegistry([
      primary.runtime,
      secondary.runtime,
    ]);
    const primaryOld = await makeRetainedSession(primary, {
      slug: 'old-pristine',
      activity: '2026-01-01T00:00:00.000Z',
    });
    const primaryNew = await makeRetainedSession(primary, {
      slug: 'new-dirty',
      dirty: true,
      activity: '2026-01-02T00:00:00.000Z',
    });
    const secondaryOld = await makeRetainedSession(secondary, {
      slug: 'secondary-old',
      dirty: true,
      activity: '2026-01-01T00:00:00.000Z',
    });
    const secondaryNew = await makeRetainedSession(secondary, {
      slug: 'secondary-new',
      activity: '2026-01-02T00:00:00.000Z',
    });

    expect((await sweep(primary, registry)).removed).toEqual([primaryOld.id]);
    expect((await sweep(secondary, registry)).removed).toEqual([
      secondaryOld.id,
    ]);

    await expectRetainedSnapshot(primary, primaryOld);
    await expectRetainedSnapshot(secondary, secondaryOld);
    expect(fs.existsSync(primaryNew.worktreePath)).toBe(true);
    expect(fs.existsSync(secondaryNew.worktreePath)).toBe(true);
    for (const session of [primaryNew, secondaryNew]) {
      const read = await readWorktreeSessionStrict(session.sidecarPath);
      expect(read.state).toBe('valid');
      if (read.state === 'valid') {
        expect(read.session.worktreeRemoved).toBeUndefined();
      }
    }
  });

  it('reconciles an exact retained pair after a historical record-write failure', async () => {
    const target = makeRetentionRepo(root, 'primary');
    configureRetention(target, 1);
    const { session, archiveKey } = await historicalRemovalWithoutBinding(
      target,
      'historical-missing-binding',
    );
    const pair = snapshotFiles(path.dirname(session.sidecarPath), session.id);
    const originalPairBytes = pair.map((file) =>
      fs.readFileSync(path.join(path.dirname(session.sidecarPath), file)),
    );

    failedJsonWrite.filePath = session.sidecarPath;
    await sweep(target);
    const beforeRecovery = await readWorktreeSessionStrict(session.sidecarPath);
    expect(beforeRecovery.state).toBe('valid');
    if (beforeRecovery.state === 'valid') {
      expect(beforeRecovery.session.worktreeRemoved).toBeUndefined();
    }
    expect(
      snapshotFiles(path.dirname(session.sidecarPath), session.id),
    ).toEqual(pair);
    expect(fs.existsSync(session.worktreePath)).toBe(false);

    failedJsonWrite.filePath = undefined;
    const reconciled = await sweep(target);
    expect(reconciled.skipped).toContain(
      `worktree removal record reconciled from snapshot: ${session.id}`,
    );

    let current = await readWorktreeSessionStrict(session.sidecarPath);
    expect(current.state).toBe('valid');
    if (current.state === 'valid') {
      expect(current.session.worktreeRemoved).toEqual({ archiveKey });
    }
    expect(
      snapshotFiles(path.dirname(session.sidecarPath), session.id),
    ).toEqual(pair);
    expect(fs.existsSync(session.worktreePath)).toBe(false);

    const repeated = await sweep(target);
    expect(repeated.skipped).not.toContain(
      `worktree removal record reconciled from snapshot: ${session.id}`,
    );
    current = await readWorktreeSessionStrict(session.sidecarPath);
    expect(current.state).toBe('valid');
    if (current.state === 'valid') {
      expect(current.session.worktreeRemoved).toEqual({ archiveKey });
    }
    expect(
      snapshotFiles(path.dirname(session.sidecarPath), session.id),
    ).toEqual(pair);
    expect(
      pair.map((file) =>
        fs.readFileSync(path.join(path.dirname(session.sidecarPath), file)),
      ),
    ).toEqual(originalPairBytes);
  });

  it('does not bind a target that appears during snapshot selection', async () => {
    const target = makeRetentionRepo(root, 'primary');
    configureRetention(target, 1);
    const { session } = await historicalRemovalWithoutBinding(
      target,
      'target-appears-during-selection',
    );
    const pair = snapshotFiles(path.dirname(session.sidecarPath), session.id);
    appearingDirectory.worktreePath = session.worktreePath;

    const report = await sweep(target);

    expect(appearingDirectory.worktreePath).toBeUndefined();
    expect(fs.statSync(session.worktreePath).isDirectory()).toBe(true);
    expect(report.skipped).not.toContain(
      `worktree removal record reconciled from snapshot: ${session.id}`,
    );
    const current = await readWorktreeSessionStrict(session.sidecarPath);
    expect(current.state).toBe('valid');
    if (current.state === 'valid') {
      expect(current.session.worktreeRemoved).toBeUndefined();
    }
    expect(
      snapshotFiles(path.dirname(session.sidecarPath), session.id),
    ).toEqual(pair);
  });

  it.each([
    'another-workspace',
    'occupied-directory',
    'coordinate-mismatch',
    'corrupt-pair',
    'conflicting-owner',
  ] as const)(
    'does not reconcile a retained pair after %s',
    async (scenario) => {
      const target = makeRetentionRepo(root, 'primary');
      configureRetention(target, 1);
      const { session, archiveKey } = await historicalRemovalWithoutBinding(
        target,
        `historical-${scenario}`,
      );
      let registry = createWorkspaceRegistry([target.runtime]);
      if (scenario === 'another-workspace') {
        const other = makeRetentionRepo(root, 'secondary');
        registry = createWorkspaceRegistry([target.runtime, other.runtime]);
        await writeWorktreeSession(session.sidecarPath, {
          ...session.sidecar,
          workspaceCwd: other.repo,
        });
      } else if (scenario === 'occupied-directory') {
        fs.mkdirSync(session.worktreePath, { recursive: true });
      } else if (scenario === 'coordinate-mismatch') {
        await writeWorktreeSession(session.sidecarPath, {
          ...session.sidecar,
          worktreePath: path.join(
            path.dirname(session.worktreePath),
            'unexpected-coordinate',
          ),
        });
      } else if (scenario === 'corrupt-pair') {
        fs.writeFileSync(
          path.join(
            path.dirname(session.sidecarPath),
            `${archiveKey.slice(0, -'.tar.gz'.length)}.json`,
          ),
          '{corrupt',
        );
      } else {
        const other = await makeRetainedSession(target, {
          slug: 'other-owner-control',
        });
        await writeWorktreeSession(other.sidecarPath, {
          ...other.sidecar,
          worktreePath: session.worktreePath,
        });
      }
      const pair = snapshotFiles(path.dirname(session.sidecarPath), session.id);

      await sweep(target, registry);

      const current = await readWorktreeSessionStrict(session.sidecarPath);
      expect(current.state).toBe('valid');
      if (current.state === 'valid') {
        expect(current.session.worktreeRemoved).toBeUndefined();
      }
      expect(
        snapshotFiles(path.dirname(session.sidecarPath), session.id),
      ).toEqual(pair);
      if (scenario === 'corrupt-pair') {
        expect(
          fs.readFileSync(
            path.join(
              path.dirname(session.sidecarPath),
              `${archiveKey.slice(0, -'.tar.gz'.length)}.json`,
            ),
            'utf8',
          ),
        ).toBe('{corrupt');
      }
    },
  );

  it('sweeps the oldest excess checkouts before newer excess checkouts', async () => {
    const target = makeRetentionRepo(root, 'primary');
    configureRetention(target, 1);
    const oldest = await makeRetainedSession(target, {
      slug: 'oldest',
      activity: '2026-01-01T00:00:00.000Z',
    });
    const middle = await makeRetainedSession(target, {
      slug: 'middle',
      activity: '2026-01-02T00:00:00.000Z',
    });
    const newest = await makeRetainedSession(target, {
      slug: 'newest',
      activity: '2026-01-03T00:00:00.000Z',
    });

    expect((await sweep(target)).removed).toEqual([oldest.id, middle.id]);
    for (const session of [oldest, middle]) {
      await expectRetainedSnapshot(target, session);
    }
    expect(fs.existsSync(newest.worktreePath)).toBe(true);
  });

  it.each(['another-session', 'missing'] as const)(
    'does not let a newest checkout whose marker is %s displace a healthy retained checkout',
    async (markerState) => {
      const target = makeRetentionRepo(root, 'primary');
      configureRetention(target, 1);
      const evicted = await makeRetainedSession(target, {
        slug: 'older-evicted',
        activity: '2026-01-01T00:00:00.000Z',
      });
      const retained = await makeRetainedSession(target, {
        slug: 'healthy-retained',
        activity: '2026-01-02T00:00:00.000Z',
      });
      const invalidNewest = await makeRetainedSession(target, {
        slug: 'invalid-newest',
        activity: '2026-01-03T00:00:00.000Z',
      });
      const marker = path.join(
        invalidNewest.worktreePath,
        WORKTREE_SESSION_FILE,
      );
      if (markerState === 'missing') {
        fs.rmSync(marker);
      } else {
        fs.rmSync(marker);
        await writeWorktreeSessionMarker(
          invalidNewest.worktreePath,
          'another-session',
        );
      }

      expect((await sweep(target)).removed).toEqual([evicted.id]);

      await expectRetainedSnapshot(target, evicted);
      expect(fs.existsSync(retained.worktreePath)).toBe(true);
      expect(fs.existsSync(invalidNewest.worktreePath)).toBe(true);
      const read = await readWorktreeSessionStrict(retained.sidecarPath);
      expect(read.state).toBe('valid');
      if (read.state === 'valid') {
        expect(read.session.worktreeRemoved).toBeUndefined();
      }
    },
  );

  it('preserves a checkout whose owning session is live in another process', async () => {
    const target = makeRetentionRepo(root, 'primary');
    configureRetention(target, 1);
    const external = await makeRetainedSession(target, {
      slug: 'external-live',
      dirty: true,
      activity: '2026-01-01T00:00:00.000Z',
    });
    const evicted = await makeRetainedSession(target, {
      slug: 'plain-eligible',
      activity: '2026-01-02T00:00:00.000Z',
    });
    const newest = await makeRetainedSession(target, {
      slug: 'newest',
      activity: '2026-01-03T00:00:00.000Z',
    });
    await writeOwnerRuntimeStatus(target, external.id, external.worktreePath);

    expect((await sweep(target)).removed).toEqual([evicted.id]);
    expect(fs.existsSync(external.worktreePath)).toBe(true);
    const read = await readWorktreeSessionStrict(external.sidecarPath);
    expect(read.state).toBe('valid');
    if (read.state === 'valid') {
      expect(read.session.worktreeRemoved).toBeUndefined();
    }
    await expectRetainedSnapshot(target, evicted);
    expect(fs.existsSync(newest.worktreePath)).toBe(true);
  });

  it('ignores a runtime record whose owning process is gone', async () => {
    const target = makeRetentionRepo(root, 'primary');
    configureRetention(target, 1);
    const stale = await makeRetainedSession(target, {
      slug: 'stale-record',
      activity: '2026-01-01T00:00:00.000Z',
    });
    const newest = await makeRetainedSession(target, {
      slug: 'newest',
      activity: '2026-01-02T00:00:00.000Z',
    });
    await writeOwnerRuntimeStatus(
      target,
      stale.id,
      stale.worktreePath,
      2_147_483_646,
    );

    expect((await sweep(target)).removed).toEqual([stale.id]);
    await expectRetainedSnapshot(target, stale);
    expect(fs.existsSync(newest.worktreePath)).toBe(true);
  });

  it('preserves a checkout whose owner record cannot be verified here', async () => {
    const target = makeRetentionRepo(root, 'primary');
    configureRetention(target, 1);
    const foreign = await makeRetainedSession(target, {
      slug: 'foreign-owner',
      dirty: true,
      activity: '2026-01-01T00:00:00.000Z',
    });
    const evicted = await makeRetainedSession(target, {
      slug: 'plain-eligible',
      activity: '2026-01-02T00:00:00.000Z',
    });
    const newest = await makeRetainedSession(target, {
      slug: 'newest',
      activity: '2026-01-03T00:00:00.000Z',
    });
    writeUnverifiableOwnerRecord(target, foreign.id, foreign.worktreePath);

    expect((await sweep(target)).removed).toEqual([evicted.id]);
    expect(fs.existsSync(foreign.worktreePath)).toBe(true);
    const read = await readWorktreeSessionStrict(foreign.sidecarPath);
    expect(read.state).toBe('valid');
    if (read.state === 'valid') {
      expect(read.session.worktreeRemoved).toBeUndefined();
    }
    await expectRetainedSnapshot(target, evicted);
    expect(fs.existsSync(newest.worktreePath)).toBe(true);
  });

  it('preserves a checkout whose unverifiable owner record lives under another project directory', async () => {
    const target = makeRetentionRepo(root, 'primary');
    configureRetention(target, 1);
    const foreign = await makeRetainedSession(target, {
      slug: 'foreign-subdir-owner',
      dirty: true,
      activity: '2026-01-01T00:00:00.000Z',
    });
    const evicted = await makeRetainedSession(target, {
      slug: 'plain-eligible',
      activity: '2026-01-02T00:00:00.000Z',
    });
    const newest = await makeRetainedSession(target, {
      slug: 'newest',
      activity: '2026-01-03T00:00:00.000Z',
    });
    const otherProjectStatusPath = path.join(
      target.runtime.sessionRuntimeBaseDir,
      'projects',
      'resumed-from-worktree-subdir',
      'chats',
      `${foreign.id}.runtime.json`,
    );
    writeUnverifiableOwnerRecord(
      target,
      foreign.id,
      foreign.worktreePath,
      otherProjectStatusPath,
    );

    expect((await sweep(target)).removed).toEqual([evicted.id]);
    expect(fs.existsSync(foreign.worktreePath)).toBe(true);
    const read = await readWorktreeSessionStrict(foreign.sidecarPath);
    expect(read.state).toBe('valid');
    if (read.state === 'valid') {
      expect(read.session.worktreeRemoved).toBeUndefined();
    }
    await expectRetainedSnapshot(target, evicted);
    expect(fs.existsSync(newest.worktreePath)).toBe(true);
  });

  it('preserves a checkout whose unverifiable owner record lives in a candidate runtime base', async () => {
    const target = makeRetentionRepo(root, 'primary');
    const nestedRuntimeBase = path.join(target.repo, '.qwen-nested-runtime');
    target.runtime = {
      ...target.runtime,
      sessionRuntimeBaseDir: nestedRuntimeBase,
      env: {
        ...target.runtime.env,
        effectiveEnv: {
          ...target.runtime.env.effectiveEnv,
          QWEN_RUNTIME_DIR: nestedRuntimeBase,
        },
      },
    };
    target.service = new SessionService(target.repo, {
      runtimeBaseDir: nestedRuntimeBase,
    });
    configureRetention(target, 1);
    const foreign = await makeRetainedSession(target, {
      slug: 'foreign-candidate-base',
      dirty: true,
      activity: '2026-01-01T00:00:00.000Z',
    });
    const evicted = await makeRetainedSession(target, {
      slug: 'plain-eligible',
      activity: '2026-01-02T00:00:00.000Z',
    });
    const newest = await makeRetainedSession(target, {
      slug: 'newest',
      activity: '2026-01-03T00:00:00.000Z',
    });
    const candidateStatusPath = path.join(
      foreign.worktreePath,
      '.qwen-nested-runtime',
      'projects',
      'candidate-base-project',
      'chats',
      `${foreign.id}.runtime.json`,
    );
    writeUnverifiableOwnerRecord(
      target,
      foreign.id,
      foreign.worktreePath,
      candidateStatusPath,
    );

    expect((await sweep(target)).removed).toEqual([evicted.id]);
    expect(fs.existsSync(foreign.worktreePath)).toBe(true);
    const read = await readWorktreeSessionStrict(foreign.sidecarPath);
    expect(read.state).toBe('valid');
    if (read.state === 'valid') {
      expect(read.session.worktreeRemoved).toBeUndefined();
    }
    await expectRetainedSnapshot(target, evicted);
    expect(fs.existsSync(newest.worktreePath)).toBe(true);
  });

  it('preserves a checkout when the owner runtime record is corrupt or uses a newer schema version', async () => {
    const target = makeRetentionRepo(root, 'primary');
    configureRetention(target, 1);
    const corrupt = await makeRetainedSession(target, {
      slug: 'corrupt-owner-record',
      dirty: true,
      activity: '2026-01-01T00:00:00.000Z',
    });
    const newerSchema = await makeRetainedSession(target, {
      slug: 'newer-schema-record',
      dirty: true,
      activity: '2026-01-02T00:00:00.000Z',
    });
    const evicted = await makeRetainedSession(target, {
      slug: 'plain-eligible',
      activity: '2026-01-03T00:00:00.000Z',
    });
    const newest = await makeRetainedSession(target, {
      slug: 'newest',
      activity: '2026-01-04T00:00:00.000Z',
    });

    const corruptPath = new Storage(
      corrupt.worktreePath,
      target.runtime.sessionRuntimeBaseDir,
    ).getRuntimeStatusPath(corrupt.id);
    fs.mkdirSync(path.dirname(corruptPath), { recursive: true });
    fs.writeFileSync(corruptPath, '{half-written');

    const newerPath = new Storage(
      newerSchema.worktreePath,
      target.runtime.sessionRuntimeBaseDir,
    ).getRuntimeStatusPath(newerSchema.id);
    fs.mkdirSync(path.dirname(newerPath), { recursive: true });
    fs.writeFileSync(
      newerPath,
      JSON.stringify({
        schema_version: 99,
        pid: process.pid,
        session_id: newerSchema.id,
        work_dir: newerSchema.worktreePath,
        hostname: os.hostname(),
        started_at: Date.now() / 1000,
      }),
    );

    expect((await sweep(target)).removed).toEqual([evicted.id]);
    expect(fs.existsSync(corrupt.worktreePath)).toBe(true);
    expect(fs.existsSync(newerSchema.worktreePath)).toBe(true);
    await expectRetainedSnapshot(target, evicted);
    expect(fs.existsSync(newest.worktreePath)).toBe(true);
  });

  it('preserves a checkout that contains another registered workspace', async () => {
    const target = makeRetentionRepo(root, 'primary');
    configureRetention(target, 1);
    const hosted = await makeRetainedSession(target, {
      slug: 'registered-nested-ws',
      dirty: true,
      activity: '2026-01-01T00:00:00.000Z',
    });
    const evicted = await makeRetainedSession(target, {
      slug: 'plain-eligible',
      activity: '2026-01-02T00:00:00.000Z',
    });
    const newest = await makeRetainedSession(target, {
      slug: 'newest',
      activity: '2026-01-03T00:00:00.000Z',
    });
    const nestedWorkspaceSubdir = path.join(hosted.worktreePath, 'packages');
    fs.mkdirSync(nestedWorkspaceSubdir, { recursive: true });
    const nestedRuntime = {
      ...target.runtime,
      workspaceId: 'nested-worktree-ws',
      workspaceCwd: nestedWorkspaceSubdir,
      primary: false,
      generationGuard: createWorkspaceGenerationGuard(),
    };
    const registry = createWorkspaceRegistry([target.runtime, nestedRuntime]);

    const report = await runWithWorkspaceRuntimeStorage(target.runtime, () =>
      sweepWorktreeRetentionOnce(target.runtime, registry, coordinator),
    );
    expect(report.removed).toEqual([evicted.id]);
    expect(fs.existsSync(hosted.worktreePath)).toBe(true);
    const read = await readWorktreeSessionStrict(hosted.sidecarPath);
    expect(read.state).toBe('valid');
    if (read.state === 'valid') {
      expect(read.session.worktreeRemoved).toBeUndefined();
    }
    await expectRetainedSnapshot(target, evicted);
    expect(fs.existsSync(newest.worktreePath)).toBe(true);
  });

  it('preserves a monorepo subdir workspace checkout with a live process in a pinned worktree-local runtime base', async () => {
    const target = makeRetentionRepo(root, 'primary');
    const subdir = path.join(target.repo, 'packages', 'app');
    fs.mkdirSync(subdir, { recursive: true });
    const relativeRuntimeBase = path.join(subdir, '.qwen-local-rt');
    const subRuntime = {
      ...target.runtime,
      workspaceCwd: subdir,
      sessionRuntimeBaseDir: relativeRuntimeBase,
      env: {
        ...target.runtime.env,
        effectiveEnv: {
          ...target.runtime.env.effectiveEnv,
          QWEN_RUNTIME_DIR: relativeRuntimeBase,
        },
      },
    };
    const subTarget: RetentionTestRuntime = {
      ...target,
      repo: subdir,
      runtime: subRuntime,
      service: new SessionService(subdir, {
        runtimeBaseDir: relativeRuntimeBase,
      }),
      git: new GitWorktreeService(subdir),
    };
    configureRetention(subTarget, 1);

    const activeOwner = await makeRetainedSession(subTarget, {
      slug: 'subdir-live-owner',
      dirty: true,
      activity: '2026-01-01T00:00:00.000Z',
    });
    // Record originalCwd at repo root while workspaceCwd remains subdir,
    // pinning that ownerProcessActive inspects sidecar.workspaceCwd too.
    await writeWorktreeSession(activeOwner.sidecarPath, {
      ...activeOwner.sidecar,
      originalCwd: target.repo,
      workspaceCwd: subdir,
    });
    const evicted = await makeRetainedSession(subTarget, {
      slug: 'subdir-evicted',
      activity: '2026-01-02T00:00:00.000Z',
    });
    const newest = await makeRetainedSession(subTarget, {
      slug: 'subdir-newest',
      activity: '2026-01-03T00:00:00.000Z',
    });

    const worktreeLocalBase = path.join(
      activeOwner.worktreePath,
      '.qwen-local-rt',
    );
    const statusPath = new Storage(
      activeOwner.worktreePath,
      worktreeLocalBase,
    ).getRuntimeStatusPath(activeOwner.id);
    await writeRuntimeStatus(statusPath, {
      sessionId: activeOwner.id,
      workDir: activeOwner.worktreePath,
      pid: process.pid,
    });

    const outcome = await sweep(subTarget);
    expect(outcome.removed).toEqual([evicted.id]);
    expect(fs.existsSync(activeOwner.worktreePath)).toBe(true);
    await expectRetainedSnapshot(subTarget, evicted);
    expect(fs.existsSync(newest.worktreePath)).toBe(true);
  });

  it('preserves a checkout under a symlinked worktrees root when a registered nested workspace uses the symlink alias', async () => {
    const target = makeRetentionRepo(root, 'primary');
    const externalWorktrees = path.join(root, 'external-worktrees-store');
    fs.mkdirSync(externalWorktrees, { recursive: true });
    fs.mkdirSync(path.join(target.repo, '.qwen'), { recursive: true });
    fs.symlinkSync(
      externalWorktrees,
      path.join(target.repo, '.qwen', 'worktrees'),
    );
    configureRetention(target, 1);

    const hosted = await makeRetainedSession(target, {
      slug: 'hosted-symlink-leaf',
      dirty: true,
      activity: '2026-01-01T00:00:00.000Z',
    });
    const evicted = await makeRetainedSession(target, {
      slug: 'evicted-symlink-leaf',
      activity: '2026-01-02T00:00:00.000Z',
    });
    const newest = await makeRetainedSession(target, {
      slug: 'newest-symlink-leaf',
      activity: '2026-01-03T00:00:00.000Z',
    });

    const nestedWorkspaceViaSymlink = path.join(
      target.repo,
      '.qwen',
      'worktrees',
      'hosted-symlink-leaf',
      'packages',
    );
    fs.mkdirSync(nestedWorkspaceViaSymlink, { recursive: true });
    const nestedRuntime = {
      ...target.runtime,
      workspaceId: 'nested-symlink-alias-ws',
      workspaceCwd: nestedWorkspaceViaSymlink,
      primary: false,
      generationGuard: createWorkspaceGenerationGuard(),
    };
    const registry = createWorkspaceRegistry([target.runtime, nestedRuntime]);

    const report = await runWithWorkspaceRuntimeStorage(target.runtime, () =>
      sweepWorktreeRetentionOnce(target.runtime, registry, coordinator),
    );
    expect(report.removed).toEqual([evicted.id]);
    expect(fs.existsSync(hosted.worktreePath)).toBe(true);
    await expectRetainedSnapshot(target, evicted);
    expect(fs.existsSync(newest.worktreePath)).toBe(true);
  });

  it('protects uppercase legacy UUID sessions pinned or bound to cron tasks under normalized lowercase keys', async () => {
    const target = makeRetentionRepo(root, 'primary');
    configureRetention(target, 1);
    const pinnedUpperId = '550E8400-E29B-41D4-A716-446655440101';
    const boundUpperId = '550E8400-E29B-41D4-A716-446655440102';
    const pinnedSession = await makeRetainedSession(target, {
      sessionId: pinnedUpperId,
      slug: 'legacy-upper-pinned',
      dirty: true,
      activity: '2026-01-01T00:00:00.000Z',
    });
    const boundSession = await makeRetainedSession(target, {
      sessionId: boundUpperId,
      slug: 'legacy-upper-bound',
      dirty: true,
      activity: '2026-01-02T00:00:00.000Z',
    });
    const evicted = await makeRetainedSession(target, {
      slug: 'plain-evicted-control',
      activity: '2026-01-03T00:00:00.000Z',
    });
    const newest = await makeRetainedSession(target, {
      slug: 'newest-control',
      activity: '2026-01-04T00:00:00.000Z',
    });

    await runWithWorkspaceRuntimeStorage(target.runtime, async () => {
      const org = new SessionOrganizationService(target.repo);
      await org.updateSessionOrganization(pinnedUpperId.toLowerCase(), {
        isPinned: true,
      });
    });

    await writeScheduledTaskFile(target, [
      persistentTask(boundUpperId.toLowerCase()),
    ]);

    const outcome = await sweep(target);
    expect(outcome.issues).toEqual([]);
    expect(outcome.removed).toEqual([evicted.id]);
    expect(fs.existsSync(pinnedSession.worktreePath)).toBe(true);
    expect(fs.existsSync(boundSession.worktreePath)).toBe(true);
    await expectRetainedSnapshot(target, evicted);
    expect(fs.existsSync(newest.worktreePath)).toBe(true);
  });

  it('protects an uppercase legacy UUID session that is live on bridge under its original casing', async () => {
    const target = makeRetentionRepo(root, 'primary');
    configureRetention(target, 1);
    const liveUpperId = '550E8400-E29B-41D4-A716-446655440201';
    const liveSession = await makeRetainedSession(target, {
      sessionId: liveUpperId,
      slug: 'legacy-upper-live-bridge',
      dirty: true,
      activity: '2026-01-01T00:00:00.000Z',
    });
    const evicted = await makeRetainedSession(target, {
      slug: 'plain-evicted-live-control',
      activity: '2026-01-02T00:00:00.000Z',
    });
    const newest = await makeRetainedSession(target, {
      slug: 'newest-live-control',
      activity: '2026-01-03T00:00:00.000Z',
    });

    const getSessionSummary = target.runtime.bridge.getSessionSummary.bind(
      target.runtime.bridge,
    );
    vi.spyOn(target.runtime.bridge, 'getSessionSummary').mockImplementation(
      (id: string) => {
        if (id === liveUpperId) {
          return {
            sessionId: liveUpperId,
            hasActivePrompt: false,
            pendingPromptCount: 0,
            pendingInteractionCount: 0,
          } as ReturnType<typeof getSessionSummary>;
        }
        return getSessionSummary(id);
      },
    );

    const outcome = await sweep(target);
    expect(outcome.issues).toEqual([]);
    expect(outcome.removed).toEqual([evicted.id]);
    expect(fs.existsSync(liveSession.worktreePath)).toBe(true);
    await expectRetainedSnapshot(target, evicted);
    expect(fs.existsSync(newest.worktreePath)).toBe(true);
  });

  it('protects uppercase legacy UUID sessions matched via normalized lowercase bridge lookup or pending registration', async () => {
    const target = makeRetentionRepo(root, 'primary');
    configureRetention(target, 1);
    const liveLowerKeyId = '550E8400-E29B-41D4-A716-446655440202';
    const pendingRegId = '550E8400-E29B-41D4-A716-446655440203';
    const liveLowerSession = await makeRetainedSession(target, {
      sessionId: liveLowerKeyId,
      slug: 'legacy-upper-normalized-bridge',
      dirty: true,
      activity: '2026-01-01T00:00:00.000Z',
    });
    const pendingSession = await makeRetainedSession(target, {
      sessionId: pendingRegId,
      slug: 'legacy-upper-pending-registration',
      dirty: true,
      activity: '2026-01-02T00:00:00.000Z',
    });
    const evicted = await makeRetainedSession(target, {
      slug: 'plain-evicted-norm-control',
      activity: '2026-01-03T00:00:00.000Z',
    });
    const newest = await makeRetainedSession(target, {
      slug: 'newest-norm-control',
      activity: '2026-01-04T00:00:00.000Z',
    });

    const getSessionSummary = target.runtime.bridge.getSessionSummary.bind(
      target.runtime.bridge,
    );
    vi.spyOn(target.runtime.bridge, 'getSessionSummary').mockImplementation(
      (id: string) => {
        // Answer ONLY the normalized lowercase id (not the raw uppercase id)
        // so both the normalization loop and the pending-registration probe are pinned.
        if (id === liveLowerKeyId.toLowerCase()) {
          return {
            sessionId: liveLowerKeyId.toLowerCase(),
            hasActivePrompt: false,
            pendingPromptCount: 0,
            pendingInteractionCount: 0,
          } as ReturnType<typeof getSessionSummary>;
        }
        return getSessionSummary(id);
      },
    );
    const bridgeWithPending = target.runtime.bridge as unknown as {
      hasSessionOrPendingRegistration?: (id: string) => boolean;
    };
    bridgeWithPending.hasSessionOrPendingRegistration = (id: string) =>
      id.toLowerCase() === pendingRegId.toLowerCase();

    const outcome = await sweep(target);
    expect(outcome.issues).toEqual([]);
    expect(outcome.removed).toEqual([evicted.id]);
    expect(fs.existsSync(liveLowerSession.worktreePath)).toBe(true);
    expect(fs.existsSync(pendingSession.worktreePath)).toBe(true);
    await expectRetainedSnapshot(target, evicted);
    expect(fs.existsSync(newest.worktreePath)).toBe(true);
  });

  it('preserves retirement-fenced sessions (retired, result_unknown, and corrupt ledger) and marks catalog changed on sweep', async () => {
    const target = makeRetentionRepo(root, 'primary');
    configureRetention(target, 1);
    const retired = await makeRetainedSession(target, {
      slug: 'retired-fenced-session',
      dirty: true,
      activity: '2026-01-01T00:00:00.000Z',
    });
    const unknownState = await makeRetainedSession(target, {
      slug: 'result-unknown-fenced-session',
      dirty: true,
      activity: '2026-01-02T00:00:00.000Z',
    });
    const corruptLedger = await makeRetainedSession(target, {
      slug: 'corrupt-ledger-fenced-session',
      dirty: true,
      activity: '2026-01-03T00:00:00.000Z',
    });
    const evicted = await makeRetainedSession(target, {
      slug: 'evicted-open-control',
      activity: '2026-01-04T00:00:00.000Z',
    });
    const newest = await makeRetainedSession(target, {
      slug: 'newest-open-control',
      activity: '2026-01-05T00:00:00.000Z',
    });

    const markCatalogChanged = vi.fn();
    (
      target.runtime.bridge as unknown as {
        markSessionCatalogChanged?: () => void;
        getSessionRetirement?: (sessionId: string) => unknown;
      }
    ).markSessionCatalogChanged = markCatalogChanged;
    (
      target.runtime.bridge as unknown as {
        getSessionRetirement?: (sessionId: string) => unknown;
      }
    ).getSessionRetirement = (candidateId: string) => {
      const lower = candidateId.toLowerCase();
      if (lower === retired.id.toLowerCase()) {
        return {
          sessionId: retired.id,
          operationId: 'op-retired',
          eventEpoch: 'epoch-1',
          state: 'retired',
        };
      }
      if (lower === unknownState.id.toLowerCase()) {
        return {
          sessionId: unknownState.id,
          operationId: 'op-unknown',
          eventEpoch: 'epoch-1',
          state: 'result_unknown',
        };
      }
      if (lower === corruptLedger.id.toLowerCase()) {
        throw new Error('corrupt retirement ledger');
      }
      return undefined;
    };

    const retiredBefore = fs.readFileSync(retired.sidecarPath, 'utf8');
    const unknownBefore = fs.readFileSync(unknownState.sidecarPath, 'utf8');
    const corruptBefore = fs.readFileSync(corruptLedger.sidecarPath, 'utf8');

    const outcome = await sweep(target);
    expect(outcome.issues).toEqual([]);
    expect(outcome.removed).toEqual([evicted.id]);
    expect(markCatalogChanged).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(retired.worktreePath)).toBe(true);
    expect(fs.existsSync(unknownState.worktreePath)).toBe(true);
    expect(fs.existsSync(corruptLedger.worktreePath)).toBe(true);
    expect(fs.readFileSync(retired.sidecarPath, 'utf8')).toBe(retiredBefore);
    expect(fs.readFileSync(unknownState.sidecarPath, 'utf8')).toBe(
      unknownBefore,
    );
    expect(fs.readFileSync(corruptLedger.sidecarPath, 'utf8')).toBe(
      corruptBefore,
    );
    await expectRetainedSnapshot(target, evicted);
    expect(fs.existsSync(newest.worktreePath)).toBe(true);
  });

  it('invalidates the persisted session list cache after sweeping a checkout so a subsequent paginated read scans fresh', async () => {
    const target = makeRetentionRepo(root, 'primary');
    configureRetention(target, 1);
    const evicted = await makeRetainedSession(target, {
      slug: 'evicted-cache-bust',
      activity: '2026-01-01T00:00:00.000Z',
    });
    const newest = await makeRetainedSession(target, {
      slug: 'newest-cache-bust',
      activity: '2026-01-02T00:00:00.000Z',
    });

    const listBridge = {
      listSessions: () => [],
      getSessionRetirement: () => undefined,
    } as unknown as AcpSessionBridge;
    const warm = await runWithWorkspaceRuntimeStorage(target.runtime, () =>
      listWorkspaceSessionsForResponse(
        listBridge,
        target.repo,
        { size: 20 },
        {
          paginateMerged: true,
          mergeLive: false,
          runtimeBaseDir: target.runtime.sessionRuntimeBaseDir,
        },
      ),
    );
    expect(warm.sessions.map((s) => s.sessionId).sort()).toEqual(
      [evicted.id, newest.id].sort(),
    );

    // Add a third session directly on disk within the 2s list cache TTL.
    // Without sweep invalidating persistedSessionListCache, the next paginated
    // read inside the TTL serves the cached 2-row snapshot and misses extraId.
    const extraId = randomUUID();
    const extraTranscript = path.join(
      path.dirname(evicted.transcriptPath),
      `${extraId}.jsonl`,
    );
    fs.writeFileSync(
      extraTranscript,
      JSON.stringify({
        uuid: 'u-extra',
        parentUuid: null,
        sessionId: extraId,
        timestamp: '2026-01-03T00:00:00.000Z',
        type: 'user',
        cwd: target.repo,
        version: '0.28.3',
        message: { role: 'user', parts: [{ text: 'added before sweep' }] },
      }) + '\n',
    );

    // Pin the sweep's cache invalidation directly rather than relying on the
    // 2s persisted-list TTL, so this never depends on wall-clock speed.
    const invalidateSpy = vi.spyOn(
      sessionListModule,
      'invalidateWorkspaceSessionListCache',
    );
    try {
      const outcome = await sweep(target);
      expect(outcome.removed).toEqual([evicted.id]);
      expect(invalidateSpy).toHaveBeenCalledWith({
        runtimeBaseDir: target.runtime.sessionRuntimeBaseDir,
        workspaceCwd: target.runtime.workspaceCwd,
        archiveStates: ['active', 'archived'],
      });
    } finally {
      invalidateSpy.mockRestore();
    }

    const after = await runWithWorkspaceRuntimeStorage(target.runtime, () =>
      listWorkspaceSessionsForResponse(
        listBridge,
        target.repo,
        { size: 20 },
        {
          paginateMerged: true,
          mergeLive: false,
          runtimeBaseDir: target.runtime.sessionRuntimeBaseDir,
        },
      ),
    );
    expect(after.sessions.map((s) => s.sessionId)).toContain(extraId);
    const evictedRow = after.sessions.find((s) => s.sessionId === evicted.id);
    expect(evictedRow?.worktree?.worktreeRemoved).toBeDefined();
    expect(evictedRow?.worktree?.canRestore).toBe(true);
  });

  it('skips a session with a case-variant duplicate in the other archive state', async () => {
    const target = makeRetentionRepo(root, 'primary');
    configureRetention(target, 1);
    const upperId = '550E8400-E29B-41D4-A716-446655440301';
    const conflicting = await makeRetainedSession(target, {
      sessionId: upperId,
      slug: 'legacy-upper-cross-state-conflict',
      dirty: true,
      activity: '2026-01-01T00:00:00.000Z',
    });
    const evicted = await makeRetainedSession(target, {
      slug: 'plain-evicted-conflict-control',
      activity: '2026-01-02T00:00:00.000Z',
    });
    const newest = await makeRetainedSession(target, {
      slug: 'newest-conflict-control',
      activity: '2026-01-03T00:00:00.000Z',
    });

    const archivedLowerTranscript = path.join(
      path.dirname(
        target.service.getWorktreeSessionPathForArchiveState(
          upperId.toLowerCase(),
          'archived',
        ),
      ),
      `${upperId.toLowerCase()}.jsonl`,
    );
    fs.mkdirSync(path.dirname(archivedLowerTranscript), { recursive: true });
    fs.copyFileSync(conflicting.transcriptPath, archivedLowerTranscript);

    const outcome = await sweep(target);
    expect(outcome.skipped).toContain(
      `session archive location is not unique: ${upperId}`,
    );
    expect(outcome.removed).toEqual([evicted.id]);
    expect(fs.existsSync(conflicting.worktreePath)).toBe(true);
    await expectRetainedSnapshot(target, evicted);
    expect(fs.existsSync(newest.worktreePath)).toBe(true);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'sweeps excess checkouts even when the repository contains an unreadable unrelated subdirectory',
    async () => {
      const target = makeRetentionRepo(root, 'primary');
      configureRetention(target, 1);
      const evicted = await makeRetainedSession(target, {
        slug: 'evicted-with-unreadable-repo-dir',
        activity: '2026-01-01T00:00:00.000Z',
      });
      const newest = await makeRetainedSession(target, {
        slug: 'newest',
        activity: '2026-01-02T00:00:00.000Z',
      });
      const lockedDir = path.join(target.repo, 'unreadable-unrelated-dir');
      fs.mkdirSync(lockedDir, { recursive: true });
      fs.chmodSync(lockedDir, 0o000);
      try {
        expect((await sweep(target)).removed).toEqual([evicted.id]);
        await expectRetainedSnapshot(target, evicted);
        expect(fs.existsSync(newest.worktreePath)).toBe(true);
      } finally {
        fs.chmodSync(lockedDir, 0o755);
      }
    },
  );

  it('discards only a failed attempt snapshot after proving the checkout intact', async () => {
    const target = makeRetentionRepo(root, 'primary');
    configureRetention(target, 1);
    const old = await makeRetainedSession(target, {
      slug: 'retained-after-refusal',
      dirty: true,
      activity: '2026-01-01T00:00:00.000Z',
    });
    await makeRetainedSession(target, {
      slug: 'newest',
      activity: '2026-01-02T00:00:00.000Z',
    });
    const unrelated = path.join(
      path.dirname(old.sidecarPath),
      'unrelated.1.1.worktree-snapshot.tar.gz',
    );
    fs.writeFileSync(unrelated, 'unrelated-orphan');
    const refusal = vi
      .spyOn(GitWorktreeService.prototype, 'removeUserWorktree')
      .mockResolvedValue({ success: false, error: 'injected refusal' });

    expect((await sweep(target)).removed).toEqual([]);
    expect(fs.existsSync(old.worktreePath)).toBe(true);
    expect(
      fs
        .readdirSync(path.dirname(old.sidecarPath))
        .filter(
          (entry) =>
            entry.startsWith(`${old.id}.`) &&
            entry.includes('.worktree-snapshot.'),
        ),
    ).toEqual([]);
    expect(fs.readFileSync(unrelated, 'utf8')).toBe('unrelated-orphan');
    const binding = await readWorktreeSessionStrict(old.sidecarPath);
    expect(binding.state).toBe('valid');
    if (binding.state === 'valid') {
      expect(binding.session.worktreeRemoved).toBeUndefined();
    }

    refusal.mockRestore();
    expect((await sweep(target)).removed).toEqual([old.id]);
    await expectRetainedSnapshot(target, old);
    expect(fs.readFileSync(unrelated, 'utf8')).toBe('unrelated-orphan');
  });

  it('resolves equal recency by canonical checkout path', async () => {
    const target = makeRetentionRepo(root, 'primary');
    configureRetention(target, 1);
    const retained = await makeRetainedSession(target, {
      slug: 'aa-path',
      sessionId: '00000000-0000-4000-8000-000000000002',
      activity: '2026-01-01T00:00:00.000Z',
    });
    const evicted = await makeRetainedSession(target, {
      slug: 'zz-path',
      sessionId: '00000000-0000-4000-8000-000000000001',
      activity: '2026-01-01T00:00:00.000Z',
    });

    expect((await sweep(target)).removed).toEqual([evicted.id]);
    expect(fs.existsSync(retained.worktreePath)).toBe(true);
    await expectRetainedSnapshot(target, evicted);
  });

  it('retains the snapshot when the checkout may have been partly removed', async () => {
    const target = makeRetentionRepo(root, 'primary');
    configureRetention(target, 1);
    const old = await makeRetainedSession(target, {
      slug: 'partial-removal',
      dirty: true,
      activity: '2026-01-01T00:00:00.000Z',
    });
    await makeRetainedSession(target, {
      slug: 'newest',
      activity: '2026-01-02T00:00:00.000Z',
    });
    vi.spyOn(
      GitWorktreeService.prototype,
      'removeUserWorktree',
    ).mockImplementation(async () => {
      fs.rmSync(path.join(old.worktreePath, 'tracked.txt'), { force: true });
      return { success: false, error: 'injected partial removal' };
    });

    expect((await sweep(target)).removed).toEqual([]);
    expect(fs.existsSync(old.worktreePath)).toBe(true);
    expect(
      fs
        .readdirSync(path.dirname(old.sidecarPath))
        .some((entry) => entry.endsWith('.worktree-snapshot.tar.gz')),
    ).toBe(true);
  });

  it('persists the recovery binding before physical removal', async () => {
    const target = makeRetentionRepo(root, 'primary');
    configureRetention(target, 1);
    const old = await makeRetainedSession(target, {
      slug: 'binding-before-removal',
      dirty: true,
      activity: '2026-01-01T00:00:00.000Z',
    });
    await makeRetainedSession(target, {
      slug: 'newest',
      activity: '2026-01-02T00:00:00.000Z',
    });
    const removeUserWorktree = GitWorktreeService.prototype.removeUserWorktree;
    const removal = vi
      .spyOn(GitWorktreeService.prototype, 'removeUserWorktree')
      .mockImplementation(async function (
        this: GitWorktreeService,
        ...args: Parameters<GitWorktreeService['removeUserWorktree']>
      ) {
        const current = await readWorktreeSessionStrict(old.sidecarPath);
        expect(current.state).toBe('valid');
        if (current.state !== 'valid')
          throw new Error('invalid binding record');
        const archiveKey = current.session.worktreeRemoved?.archiveKey;
        expect(archiveKey).toBeDefined();
        const archive = path.join(path.dirname(old.sidecarPath), archiveKey!);
        await expect(fs.promises.lstat(archive)).resolves.toMatchObject({
          nlink: 1,
        });
        await expect(
          fs.promises.lstat(`${archive.slice(0, -'.tar.gz'.length)}.json`),
        ).resolves.toMatchObject({
          nlink: 1,
        });
        return removeUserWorktree.apply(this, args);
      });

    expect((await sweep(target)).removed).toEqual([old.id]);
    expect(removal).toHaveBeenCalledOnce();
    await expectRetainedSnapshot(target, old);
  });

  it('refuses physical removal when the recovery binding cannot be persisted', async () => {
    const target = makeRetentionRepo(root, 'primary');
    configureRetention(target, 1);
    const old = await makeRetainedSession(target, {
      slug: 'binding-write-refused',
      dirty: true,
      activity: '2026-01-01T00:00:00.000Z',
    });
    await makeRetainedSession(target, {
      slug: 'newest',
      activity: '2026-01-02T00:00:00.000Z',
    });
    const removal = vi.spyOn(
      GitWorktreeService.prototype,
      'removeUserWorktree',
    );
    failedJsonWrite.filePath = old.sidecarPath;

    const outcome = await sweep(target);
    expect(outcome.removed).toEqual([]);
    expect(
      outcome.issues.some((message) =>
        message.includes('injected binding persistence failure'),
      ),
    ).toBe(true);
    expect(removal).not.toHaveBeenCalled();
    expect(fs.existsSync(old.worktreePath)).toBe(true);
    const current = await readWorktreeSessionStrict(old.sidecarPath);
    expect(current.state).toBe('valid');
    if (current.state === 'valid') {
      expect(current.session.worktreeRemoved).toBeUndefined();
    }
  });

  it('persists the snapshot binding when removal fails after deleting the checkout', async () => {
    const target = makeRetentionRepo(root, 'primary');
    configureRetention(target, 1);
    const old = await makeRetainedSession(target, {
      slug: 'removed-before-prune-error',
      dirty: true,
      activity: '2026-01-01T00:00:00.000Z',
    });
    await makeRetainedSession(target, {
      slug: 'newest',
      activity: '2026-01-02T00:00:00.000Z',
    });
    const removeUserWorktree = GitWorktreeService.prototype.removeUserWorktree;
    vi.spyOn(
      GitWorktreeService.prototype,
      'removeUserWorktree',
    ).mockImplementation(async function (
      this: GitWorktreeService,
      ...args: Parameters<GitWorktreeService['removeUserWorktree']>
    ) {
      const actual = await removeUserWorktree.apply(this, args);
      return {
        ...actual,
        success: false,
        error: 'injected post-removal prune failure',
      };
    });

    expect((await sweep(target)).removed).toEqual([old.id]);

    await expectRetainedSnapshot(target, old);
  });

  it('retains an attempt pair when a populated gitlink appears during removal cleanup', async () => {
    const target = makeRetentionRepo(root, 'primary');
    configureRetention(target, 1);
    const old = await makeRetainedSession(target, {
      slug: 'populated-gitlink',
      activity: '2026-01-01T00:00:00.000Z',
    });
    await makeRetainedSession(target, {
      slug: 'newest',
      activity: '2026-01-02T00:00:00.000Z',
    });
    const archiveDir = path.dirname(old.sidecarPath);
    expect(snapshotFiles(archiveDir, old.id)).toEqual([]);
    const emptyChild = path.join(root, 'empty-submodule');
    fs.mkdirSync(emptyChild);
    git(emptyChild, target.home, 'init', '-q');
    git(emptyChild, target.home, 'symbolic-ref', 'HEAD', 'refs/heads/main');
    git(
      emptyChild,
      target.home,
      '-c',
      'user.name=Retention Test',
      '-c',
      'user.email=retention@example.invalid',
      'commit',
      '--allow-empty',
      '-qm',
      'Empty child',
    );
    // An empty child keeps archive content unchanged while the submodule
    // object-store and populated state change independently.
    git(
      old.worktreePath,
      target.home,
      '-c',
      'protocol.file.allow=always',
      'submodule',
      'add',
      '--force',
      emptyChild,
      'vendor',
    );
    git(
      old.worktreePath,
      target.home,
      '-c',
      'user.name=Retention Test',
      '-c',
      'user.email=retention@example.invalid',
      'commit',
      '-qm',
      'Record submodule',
    );
    git(old.worktreePath, target.home, 'submodule', 'deinit', '-f', 'vendor');
    const commonGitDir = git(
      old.worktreePath,
      target.home,
      'rev-parse',
      '--git-dir',
    );
    const objectStore = path.resolve(
      old.worktreePath,
      commonGitDir,
      'modules',
      'vendor',
    );
    expect(objectStore.startsWith(root + path.sep)).toBe(true);
    fs.rmSync(objectStore, { recursive: true, force: true });
    await expect(worktreeHasPopulatedGitlink(old.worktreePath)).resolves.toBe(
      false,
    );
    captureInit.worktreePath = old.worktreePath;
    captureInit.home = target.home;
    captureInit.sourceRepo = emptyChild;
    captureInit.objectStore = objectStore;
    captureInit.sidecarPath = old.sidecarPath;
    captureInit.initializeAfterBinding = true;
    const refusal = vi
      .spyOn(GitWorktreeService.prototype, 'removeUserWorktree')
      .mockResolvedValue({ success: false, error: 'injected refusal' });

    expect((await sweep(target)).removed).toEqual([]);
    expect(refusal).toHaveBeenCalledOnce();
    expect(captureInit.initialized).toBe(true);
    await expect(worktreeHasPopulatedGitlink(old.worktreePath)).resolves.toBe(
      true,
    );
    const snapshotNames = snapshotFiles(archiveDir, old.id);
    expect(snapshotNames).toHaveLength(2);
    const snapshotPath = snapshotNames.find((name) =>
      name.endsWith('.worktree-snapshot.tar.gz'),
    );
    expect(snapshotPath).toBeDefined();
    const selected = await selectWorktreeSnapshot({
      directory: archiveDir,
      sessionId: old.id,
      slug: old.sidecar.slug,
      archiveKey: path.basename(snapshotPath!),
    });
    expect(selected).toBeDefined();
    await expect(
      verifyRestoredWorktreeSnapshot({
        worktreePath: old.worktreePath,
        snapshotPath: selected!.snapshotPath,
        meta: selected!.meta,
      }),
    ).resolves.toBe(true);
    expect(fs.existsSync(old.worktreePath)).toBe(true);
  });

  it('does not accumulate snapshots for an already pending Git operation', async () => {
    const target = makeRetentionRepo(root, 'primary');
    configureRetention(target, 1);
    const old = await makeRetainedSession(target, {
      slug: 'already-pending',
      activity: '2026-01-01T00:00:00.000Z',
    });
    await makeRetainedSession(target, {
      slug: 'newest',
      activity: '2026-01-02T00:00:00.000Z',
    });
    execFileSync('git', ['bisect', 'start'], {
      cwd: old.worktreePath,
      stdio: 'pipe',
    });

    expect((await sweep(target)).removed).toEqual([]);
    expect((await sweep(target)).removed).toEqual([]);

    expect(fs.existsSync(old.worktreePath)).toBe(true);
    expect(
      fs
        .readdirSync(path.dirname(old.sidecarPath))
        .some(
          (entry) =>
            entry.startsWith(`${old.id}.`) &&
            entry.includes('.worktree-snapshot.'),
        ),
    ).toBe(false);
  });

  it('protects live and pinned chats outside the eligible quota', async () => {
    const target = makeRetentionRepo(root, 'primary');
    configureRetention(target, 1);
    const pinned = await makeRetainedSession(target, {
      slug: 'old-pinned',
      activity: '2026-01-01T00:00:00.000Z',
    });
    const deleted = await makeRetainedSession(target, {
      slug: 'eligible-old',
      activity: '2026-01-02T00:00:00.000Z',
    });
    const newest = await makeRetainedSession(target, {
      slug: 'newest',
      activity: '2026-01-03T00:00:00.000Z',
    });
    const live = await makeRetainedSession(target, {
      slug: 'live-extra',
      activity: '2026-01-04T00:00:00.000Z',
    });
    await runWithWorkspaceRuntimeStorage(target.runtime, () =>
      new SessionOrganizationService(target.repo).updateSessionOrganization(
        pinned.id,
        { isPinned: true },
      ),
    );
    Object.assign(target.runtime.bridge, {
      getSessionSummary: (id: string) => {
        if (id === live.id) return { hasActivePrompt: true };
        throw Object.assign(new Error('not found'), {
          name: 'SessionNotFoundError',
          code: 'session_not_found',
        });
      },
    });

    expect((await sweep(target)).removed).toEqual([deleted.id]);
    await expectRetainedSnapshot(target, deleted);
    for (const session of [pinned, newest, live]) {
      expect(fs.existsSync(session.worktreePath)).toBe(true);
    }
  });

  it.each([0, 1])(
    'refuses a shared root when the other limit is %s',
    async (otherLimit) => {
      const primary = makeRetentionRepo(root, 'primary');
      const sibling = makeRetentionRepo(root, 'secondary');
      const nested = path.join(primary.repo, 'nested');
      fs.mkdirSync(nested);
      const siblingScope = {
        ...sibling.runtime,
        workspaceCwd: nested,
      };
      const registry = createWorkspaceRegistry([primary.runtime, siblingScope]);
      configureRetention(primary, 1);
      configureRetention({ ...sibling, repo: nested }, otherLimit);
      const session = await makeRetainedSession(primary, {
        slug: 'must-survive',
      });
      const result = await sweep(primary, registry);
      expect(result.removed).toEqual([]);
      expect(result.skipped).toContain('management root is shared');
      expect(fs.existsSync(session.worktreePath)).toBe(true);
      expect(
        fs
          .readdirSync(path.dirname(session.sidecarPath))
          .some((file) => file.includes('.worktree-snapshot.')),
      ).toBe(false);
    },
  );

  it('keeps untrusted shared roots in the ownership collision proof', async () => {
    const target = makeRetentionRepo(root, 'primary');
    configureRetention(target, 1);
    const oldest = await makeRetainedSession(target, {
      slug: 'trusted-target',
      dirty: true,
      activity: '2026-01-01T00:00:00.000Z',
    });
    await makeRetainedSession(target, {
      slug: 'trusted-newer-control',
      activity: '2026-01-02T00:00:00.000Z',
    });
    const sibling = makeRetentionRepo(root, 'untrusted-sibling');
    const nested = path.join(target.repo, 'untrusted-nested');
    fs.mkdirSync(nested);
    const untrusted = {
      ...sibling.runtime,
      workspaceCwd: nested,
      workspaceId: 'untrusted-shared-root',
      trusted: false,
    };
    const otherId = '00000000-0000-4000-8000-0000000000b1';
    const otherSidecar =
      createWorkspaceRuntimeSessionService(untrusted).getWorktreeSessionPath(
        otherId,
      );
    const current = await readWorktreeSessionStrict(oldest.sidecarPath);
    expect(current.state).toBe('valid');
    if (current.state !== 'valid') {
      throw new Error('The ownership fixture must have a valid sidecar');
    }
    await writeWorktreeSession(otherSidecar, {
      ...current.session,
      workspaceCwd: nested,
    });

    const shared = await sweep(
      target,
      createWorkspaceRegistry([target.runtime, untrusted]),
    );
    expect(shared.removed).toEqual([]);
    expect(shared.skipped).toContain('management root is shared');
    expect(fs.existsSync(oldest.worktreePath)).toBe(true);
    expect(snapshotFiles(path.dirname(oldest.sidecarPath), oldest.id)).toEqual(
      [],
    );

    const independent = await sweep(
      target,
      createWorkspaceRegistry([
        target.runtime,
        { ...untrusted, workspaceCwd: sibling.repo },
      ]),
    );
    expect(independent.removed).toEqual([oldest.id]);
    await expectRetainedSnapshot(target, oldest);
    expect(fs.existsSync(otherSidecar)).toBe(true);
  });

  it.each([-1, 1.5, '15', null])(
    'pauses for invalid maxRetained %j instead of coercing the quota',
    async (value) => {
      const target = makeRetentionRepo(root, 'primary');
      configureRetention(target, value);
      const session = await makeRetainedSession(target, {
        slug: 'invalid-limit',
        dirty: true,
      });

      await expect(sweep(target)).rejects.toThrow(
        'worktree.maxRetained must be a nonnegative safe integer; retention is paused',
      );
      expect(fs.existsSync(session.worktreePath)).toBe(true);
      expect(fs.existsSync(session.transcriptPath)).toBe(true);
      expect(
        snapshotFiles(path.dirname(session.sidecarPath), session.id),
      ).toEqual([]);
    },
  );

  it('vetoes a real pin made during capture without accumulating attempt pairs', async () => {
    const target = makeRetentionRepo(root, 'primary');
    configureRetention(target, 1);
    const session = await makeRetainedSession(target, {
      slug: 'pin-during-capture',
      dirty: true,
      activity: '2026-01-01T00:00:00.000Z',
    });
    await makeRetainedSession(target, {
      slug: 'pin-capture-newer-control',
      activity: '2026-01-02T00:00:00.000Z',
    });
    let resumeCapture = () => {};
    let markCaptured = () => {};
    const captured = new Promise<void>((resolve) => {
      markCaptured = resolve;
    });
    captureGate.barrier = {
      captured: markCaptured,
      release: new Promise<void>((resolve) => {
        resumeCapture = resolve;
      }),
    };

    const sweeping = sweep(target);
    try {
      await captured;
      await runWithWorkspaceRuntimeStorage(target.runtime, () =>
        new SessionOrganizationService(target.repo).updateSessionOrganization(
          session.id,
          { isPinned: true },
        ),
      );
    } finally {
      resumeCapture();
    }

    expect((await sweeping).removed).toEqual([]);
    expect(fs.existsSync(session.worktreePath)).toBe(true);
    expect(
      fs.readFileSync(path.join(session.worktreePath, 'tracked.txt'), 'utf8'),
    ).toBe('dirty-pin-during-capture\n');
    const attempts = snapshotFiles(
      path.dirname(session.sidecarPath),
      session.id,
    );
    expect(attempts).toEqual([]);
    const binding = await readWorktreeSessionStrict(session.sidecarPath);
    expect(binding.state).toBe('valid');
    if (binding.state === 'valid') {
      expect(binding.session.worktreeRemoved).toBeUndefined();
    }
    expect((await sweep(target)).removed).toEqual([]);
    expect(
      snapshotFiles(path.dirname(session.sidecarPath), session.id),
    ).toEqual(attempts);
  });

  it('preserves an empty directory created after capture', async () => {
    const target = makeRetentionRepo(root, 'primary');
    configureRetention(target, 1);
    const session = await makeRetainedSession(target, {
      slug: 'late-empty-directory',
      dirty: true,
      activity: '2026-01-01T00:00:00.000Z',
    });
    await makeRetainedSession(target, {
      slug: 'empty-directory-newer-control',
      activity: '2026-01-02T00:00:00.000Z',
    });
    let resumeCapture = () => {};
    let markCaptured = () => {};
    const captured = new Promise<void>((resolve) => {
      markCaptured = resolve;
    });
    captureGate.barrier = {
      captured: markCaptured,
      release: new Promise<void>((resolve) => {
        resumeCapture = resolve;
      }),
    };
    const lateEmpty = path.join(session.worktreePath, 'late-empty');

    const sweeping = sweep(target);
    try {
      await captured;
      await fs.promises.mkdir(lateEmpty);
    } finally {
      resumeCapture();
    }

    expect((await sweeping).removed).toEqual([]);
    expect(fs.existsSync(session.worktreePath)).toBe(true);
    expect(fs.existsSync(lateEmpty)).toBe(true);
    expect(
      snapshotFiles(path.dirname(session.sidecarPath), session.id),
    ).toHaveLength(2);
    const preserved = await readWorktreeSessionStrict(session.sidecarPath);
    expect(preserved.state).toBe('valid');
    if (preserved.state === 'valid') {
      expect(preserved.session.worktreeRemoved).toBeUndefined();
    }

    await fs.promises.rmdir(lateEmpty);
    expect((await sweep(target)).removed).toEqual([session.id]);
    await expectRetainedSnapshot(target, session);
  });

  it('rejects a same-root runtime registered during capture and allows a later control sweep', async () => {
    const target = makeRetentionRepo(root, 'primary');
    configureRetention(target, 1);
    const session = await makeRetainedSession(target, {
      slug: 'late-shared-root',
      dirty: true,
      activity: '2026-01-01T00:00:00.000Z',
    });
    await makeRetainedSession(target, {
      slug: 'late-root-newer-control',
      activity: '2026-01-02T00:00:00.000Z',
    });
    const sibling = makeRetentionRepo(root, 'late-sibling');
    const nested = path.join(target.repo, 'late-nested');
    fs.mkdirSync(nested);
    const lateRuntime = {
      ...sibling.runtime,
      workspaceId: 'late-shared-root',
      workspaceCwd: nested,
      trusted: false,
    };
    const registry = createWorkspaceRegistry([target.runtime]);
    let resumeCapture = () => {};
    let markCaptured = () => {};
    const captured = new Promise<void>((resolve) => {
      markCaptured = resolve;
    });
    captureGate.barrier = {
      captured: markCaptured,
      release: new Promise<void>((resolve) => {
        resumeCapture = resolve;
      }),
    };

    const sweeping = sweep(target, registry);
    try {
      await captured;
      registry.add(lateRuntime);
    } finally {
      resumeCapture();
    }

    const rejected = await sweeping;
    expect(rejected.removed).toEqual([]);
    expect(rejected.skipped).toContain(session.id);
    expect(fs.existsSync(session.worktreePath)).toBe(true);
    expect(
      snapshotFiles(path.dirname(session.sidecarPath), session.id),
    ).toEqual([]);
    const preserved = await readWorktreeSessionStrict(session.sidecarPath);
    expect(preserved.state).toBe('valid');
    if (preserved.state === 'valid') {
      expect(preserved.session.worktreeRemoved).toBeUndefined();
    }

    expect(
      (await sweep(target, createWorkspaceRegistry([target.runtime]))).removed,
    ).toEqual([session.id]);
    await expectRetainedSnapshot(target, session);
  });

  it('contains malformed sibling settings without weakening shared-root refusal', async () => {
    const target = makeRetentionRepo(root, 'primary');
    configureRetention(target, 1);
    const session = await makeRetainedSession(target, {
      slug: 'healthy-with-invalid-sibling',
      dirty: true,
      activity: '2026-01-01T00:00:00.000Z',
    });
    const newest = await makeRetainedSession(target, {
      slug: 'newest-with-invalid-sibling',
      activity: '2026-01-02T00:00:00.000Z',
    });
    const sibling = makeRetentionRepo(root, 'sibling');
    configureRetention(sibling, 'raw');
    const registry = createWorkspaceRegistry([target.runtime, sibling.runtime]);
    expect((await sweep(target, registry)).removed).toEqual([session.id]);
    await expectRetainedSnapshot(target, session);
    expect(fs.existsSync(newest.worktreePath)).toBe(true);

    const sharedCandidate = await makeRetainedSession(target, {
      slug: 'protected-by-invalid-shared-settings',
      activity: '2026-01-03T00:00:00.000Z',
    });
    const shared = makeRetentionRepo(root, 'shared');
    const nested = path.join(target.repo, 'nested');
    fs.mkdirSync(nested);
    configureRetention({ ...shared, repo: nested }, 'raw');
    const sharedRegistry = createWorkspaceRegistry([
      target.runtime,
      { ...shared.runtime, workspaceCwd: nested },
    ]);
    const sharedReport = await sweep(target, sharedRegistry);
    expect(sharedReport.skipped).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          'retention settings cannot be read for this root:',
        ),
      ]),
    );
    expect(fs.existsSync(newest.worktreePath)).toBe(true);
    expect(fs.existsSync(sharedCandidate.worktreePath)).toBe(true);
    expect(snapshotFiles(path.dirname(newest.sidecarPath), newest.id)).toEqual(
      [],
    );
  });

  it('drains real retention filesystem work before stop resolves', async () => {
    const target = makeRetentionRepo(root, 'primary');
    configureRetention(target, 1);
    const session = await makeRetainedSession(target, {
      slug: 'stop-drain',
      dirty: true,
      activity: '2026-01-01T00:00:00.000Z',
    });
    await makeRetainedSession(target, {
      slug: 'stop-drain-newer-control',
      activity: '2026-01-02T00:00:00.000Z',
    });
    let resumeCapture = () => {};
    let markCaptured = () => {};
    const captured = new Promise<void>((resolve) => {
      markCaptured = resolve;
    });
    captureGate.barrier = {
      captured: markCaptured,
      release: new Promise<void>((resolve) => {
        resumeCapture = resolve;
      }),
    };
    const registry = createWorkspaceRegistry([target.runtime]);
    const controller = startWorktreeRetention(
      target.runtime,
      registry,
      coordinator,
    );
    await captured;
    let stopped = false;
    const stopping = controller.stop().then(() => {
      stopped = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(stopped).toBe(false);
    expect(controller.activeWork).toBe(true);
    expect(fs.existsSync(session.worktreePath)).toBe(true);

    resumeCapture();
    await stopping;

    expect(controller.activeWork).toBe(false);
    expect(fs.existsSync(session.worktreePath)).toBe(true);
    expect(
      snapshotFiles(path.dirname(session.sidecarPath), session.id),
    ).toHaveLength(2);
    const binding = await readWorktreeSessionStrict(session.sidecarPath);
    expect(binding.state).toBe('valid');
    if (binding.state === 'valid') {
      expect(binding.session.worktreeRemoved).toBeUndefined();
    }
  });

  it('waits out a stop initiated during the last scope validation', async () => {
    const target = makeRetentionRepo(root, 'primary');
    configureRetention(target, 1);
    const session = await makeRetainedSession(target, {
      slug: 'stop-after-binding',
      dirty: true,
      activity: '2026-01-01T00:00:00.000Z',
    });
    await makeRetainedSession(target, {
      slug: 'stop-after-binding-newer-control',
      activity: '2026-01-02T00:00:00.000Z',
    });
    const registry = createWorkspaceRegistry([target.runtime]);
    const getRepoTopLevel = GitWorktreeService.prototype.getRepoTopLevel;
    let gateReached = false;
    let scopeStopped: Promise<void> | undefined;
    let notifyGate!: () => void;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      notifyGate = resolve;
    });
    const resume = new Promise<void>((resolve) => {
      release = resolve;
    });
    const controller = startWorktreeRetention(
      target.runtime,
      registry,
      coordinator,
    );
    vi.spyOn(
      GitWorktreeService.prototype,
      'getRepoTopLevel',
    ).mockImplementation(async function (this: GitWorktreeService) {
      const root = await getRepoTopLevel.call(this);
      if (!gateReached) {
        const state = await readWorktreeSessionStrict(session.sidecarPath);
        if (
          state.state === 'valid' &&
          state.session.worktreeRemoved !== undefined
        ) {
          gateReached = true;
          scopeStopped = controller.stop();
          notifyGate();
          await resume;
        }
      }
      return root;
    });

    await gate;
    let stopped = false;
    const stopping = scopeStopped!.then(() => {
      stopped = true;
    });
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(stopped).toBe(false);
      expect(controller.activeWork).toBe(true);
      expect(fs.existsSync(session.worktreePath)).toBe(true);
    } finally {
      release();
      await stopping;
    }

    expect(gateReached).toBe(true);
    expect(controller.activeWork).toBe(false);
    expect(fs.existsSync(session.worktreePath)).toBe(true);
    expect(
      snapshotFiles(path.dirname(session.sidecarPath), session.id),
    ).toHaveLength(2);
    const binding = await readWorktreeSessionStrict(session.sidecarPath);
    expect(binding.state).toBe('valid');
    if (binding.state === 'valid') {
      expect(binding.session.worktreeRemoved).toBeUndefined();
    }
    expect((await sweep(target, registry)).removed).toEqual([session.id]);
    await expectRetainedSnapshot(target, session);
  });

  it.each([
    ['enabled', true, true, false],
    ['disabled', false, true, true],
    ['unbound', true, false, true],
  ] as const)(
    'handles scheduled-task binding %s without globally disabling retention',
    async (_name, enabled, bound, shouldRemove) => {
      const target = makeRetentionRepo(root, 'primary');
      configureRetention(target, 1);
      const session = await makeRetainedSession(target, {
        slug: 'scheduled-binding',
        dirty: true,
        activity: '2026-01-01T00:00:00.000Z',
      });
      await makeRetainedSession(target, {
        slug: 'scheduled-newer-control',
        activity: '2026-01-02T00:00:00.000Z',
      });
      await writeScheduledTaskFile(target, [
        persistentTask(bound ? session.id : undefined, enabled),
      ]);

      const result = await sweep(target);

      expect(result.removed).toEqual(shouldRemove ? [session.id] : []);
      expect(fs.existsSync(session.worktreePath)).toBe(!shouldRemove);
      if (shouldRemove) {
        await expectRetainedSnapshot(target, session);
      } else {
        expect(
          snapshotFiles(path.dirname(session.sidecarPath), session.id),
        ).toEqual([]);
      }
    },
  );

  it('pauses for an unreadable task store and treats confirmed deletion as empty', async () => {
    const target = makeRetentionRepo(root, 'primary');
    configureRetention(target, 1);
    const session = await makeRetainedSession(target, {
      slug: 'unreadable-task-store',
      dirty: true,
      activity: '2026-01-01T00:00:00.000Z',
    });
    await makeRetainedSession(target, {
      slug: 'newer-readable-control',
      activity: '2026-01-02T00:00:00.000Z',
    });
    const taskFile = await writeScheduledTaskFile(target, '{bad-json');

    const paused = await sweep(target);
    expect(paused.removed).toEqual([]);
    expect(paused.issues.join('\n')).toContain('Malformed JSON');
    expect(fs.existsSync(session.worktreePath)).toBe(true);
    expect(
      snapshotFiles(path.dirname(session.sidecarPath), session.id),
    ).toEqual([]);

    fs.unlinkSync(taskFile);
    expect((await sweep(target)).removed).toEqual([session.id]);
    await expectRetainedSnapshot(target, session);
  });

  it('vetoes a task enabled during capture and removes the redundant pair', async () => {
    const target = makeRetentionRepo(root, 'primary');
    configureRetention(target, 1);
    const session = await makeRetainedSession(target, {
      slug: 'task-enabled-during-capture',
      dirty: true,
      activity: '2026-01-01T00:00:00.000Z',
    });
    await makeRetainedSession(target, {
      slug: 'task-enabled-newer-control',
      activity: '2026-01-02T00:00:00.000Z',
    });
    let resumeCapture = () => {};
    let markCaptured = () => {};
    const captured = new Promise<void>((resolve) => {
      markCaptured = resolve;
    });
    captureGate.barrier = {
      captured: markCaptured,
      release: new Promise<void>((resolve) => {
        resumeCapture = resolve;
      }),
    };

    const sweeping = sweep(target);
    try {
      await captured;
      await writeScheduledTaskFile(target, [persistentTask(session.id)]);
    } finally {
      resumeCapture();
    }

    expect((await sweeping).removed).toEqual([]);
    expect(fs.existsSync(session.worktreePath)).toBe(true);
    expect(
      snapshotFiles(path.dirname(session.sidecarPath), session.id),
    ).toEqual([]);
    expect((await sweep(target)).removed).toEqual([]);
    expect(
      snapshotFiles(path.dirname(session.sidecarPath), session.id),
    ).toEqual([]);
  });

  it('vetoes a pin made after the removal binding is persisted', async () => {
    const target = makeRetentionRepo(root, 'primary');
    configureRetention(target, 1);
    const session = await makeRetainedSession(target, {
      slug: 'late-pin-after-binding',
      dirty: true,
      activity: '2026-01-01T00:00:00.000Z',
    });
    await makeRetainedSession(target, {
      slug: 'late-pin-newer-control',
      activity: '2026-01-02T00:00:00.000Z',
    });
    const isPinned = SessionOrganizationService.prototype.isSessionPinnedStrict;
    let becamePinned = false;
    vi.spyOn(
      SessionOrganizationService.prototype,
      'isSessionPinnedStrict',
    ).mockImplementation(async function (
      this: SessionOrganizationService,
      sessionId: string,
    ) {
      const current = await isPinned.call(this, sessionId);
      if (!becamePinned && sessionId === session.id) {
        const state = await readWorktreeSessionStrict(session.sidecarPath);
        if (
          state.state === 'valid' &&
          state.session.worktreeRemoved !== undefined
        ) {
          becamePinned = true;
          await runWithWorkspaceRuntimeStorage(target.runtime, () =>
            new SessionOrganizationService(
              target.repo,
            ).updateSessionOrganization(session.id, { isPinned: true }),
          );
          return isPinned.call(this, sessionId);
        }
      }
      return current;
    });

    expect((await sweep(target)).removed).toEqual([]);
    expect(becamePinned).toBe(true);
    expect(fs.existsSync(session.worktreePath)).toBe(true);

    await runWithWorkspaceRuntimeStorage(target.runtime, () =>
      new SessionOrganizationService(target.repo).updateSessionOrganization(
        session.id,
        { isPinned: false },
      ),
    );
    expect((await sweep(target)).removed).toEqual([session.id]);
    await expectRetainedSnapshot(target, session);
  });

  it('vetoes a task enabled after the removal binding is persisted', async () => {
    const target = makeRetentionRepo(root, 'primary');
    configureRetention(target, 1);
    const session = await makeRetainedSession(target, {
      slug: 'late-task-after-binding',
      dirty: true,
      activity: '2026-01-01T00:00:00.000Z',
    });
    await makeRetainedSession(target, {
      slug: 'late-task-newer-control',
      activity: '2026-01-02T00:00:00.000Z',
    });
    const cronTasks = await import(
      '@qwen-code/qwen-code-core/services/cronTasksFile.js'
    );
    const readTasks = cronTasks.readCronTasks;
    let enabledLate = false;
    const reader = vi
      .spyOn(cronTasks, 'readCronTasks')
      .mockImplementation(async (workspaceCwd: string) => {
        const before = await readTasks(workspaceCwd);
        if (!enabledLate) {
          const state = await readWorktreeSessionStrict(session.sidecarPath);
          if (
            state.state === 'valid' &&
            state.session.worktreeRemoved !== undefined
          ) {
            enabledLate = true;
            await writeScheduledTaskFile(target, [persistentTask(session.id)]);
            return readTasks(workspaceCwd);
          }
        }
        return before;
      });

    expect((await sweep(target)).removed).toEqual([]);
    expect(enabledLate).toBe(true);
    expect(reader).toHaveBeenCalled();
    expect(fs.existsSync(session.worktreePath)).toBe(true);

    await writeScheduledTaskFile(target, []);
    expect((await sweep(target)).removed).toEqual([session.id]);
    await expectRetainedSnapshot(target, session);
  });

  it('reads scheduled-task protection only from the selected runtime storage', async () => {
    const primary = makeRetentionRepo(root, 'primary');
    const secondary = makeRetentionRepo(root, 'secondary');
    configureRetention(primary, 1);
    configureRetention(secondary, 1);
    const sessionId = randomUUID();
    const primarySession = await makeRetainedSession(primary, {
      sessionId,
      slug: 'primary-scheduled-binding',
      dirty: true,
      activity: '2026-01-01T00:00:00.000Z',
    });
    await makeRetainedSession(primary, {
      slug: 'primary-newer-control',
      activity: '2026-01-02T00:00:00.000Z',
    });
    const secondarySession = await makeRetainedSession(secondary, {
      sessionId,
      slug: 'secondary-same-session-id',
      dirty: true,
      activity: '2026-01-01T00:00:00.000Z',
    });
    await makeRetainedSession(secondary, {
      slug: 'secondary-newer-control',
      activity: '2026-01-02T00:00:00.000Z',
    });
    await writeScheduledTaskFile(primary, [persistentTask(sessionId)]);
    const registry = createWorkspaceRegistry([
      primary.runtime,
      secondary.runtime,
    ]);

    expect((await sweep(primary, registry)).removed).toEqual([]);
    expect(fs.existsSync(primarySession.worktreePath)).toBe(true);
    expect((await sweep(secondary, registry)).removed).toEqual([sessionId]);
    await expectRetainedSnapshot(secondary, secondarySession);
  });

  it.each([
    {
      currentState: 'active',
      otherState: 'archived',
      malformed: false,
    },
    {
      currentState: 'archived',
      otherState: 'active',
      malformed: false,
    },
    {
      currentState: 'active',
      otherState: 'archived',
      malformed: true,
    },
    {
      currentState: 'archived',
      otherState: 'active',
      malformed: true,
    },
  ] as const)(
    'refuses a $otherState competing or unreadable owner for a $currentState removal',
    async ({ currentState, otherState, malformed }) => {
      const target = makeRetentionRepo(root, 'primary');
      configureRetention(target, 1);
      const session = await makeRetainedSession(target, {
        slug: 'cross-archive-owner',
        dirty: true,
        archiveState: currentState,
        activity: '2026-01-01T00:00:00.000Z',
      });
      await makeRetainedSession(target, {
        slug: 'cross-archive-newer-control',
        activity: '2026-01-02T00:00:00.000Z',
      });
      const otherId = randomUUID();
      const otherSidecar = target.service.getWorktreeSessionPathForArchiveState(
        otherId,
        otherState,
      );
      if (malformed) {
        fs.mkdirSync(path.dirname(otherSidecar), { recursive: true });
        fs.writeFileSync(otherSidecar, '{truncated');
      } else {
        await writeWorktreeSession(otherSidecar, { ...session.sidecar });
      }

      const plan = await preclassifyWorktreeCleanup(
        target.service,
        session.id,
        target.repo,
      );
      expect(plan).toBeDefined();
      const ownership = await verifyWorktreeCleanupOwnership(
        plan!,
        () => false,
      );
      expect(ownership).toEqual({
        ok: false,
        reason: malformed
          ? `unreadable sibling sidecar ${path.relative(
              path.dirname(path.dirname(session.sidecarPath)),
              otherSidecar,
            )}`
          : `checkout shared with ${otherId}.worktree.json`,
      });
      expect((await sweep(target)).removed).toEqual([]);
      expect(fs.existsSync(session.worktreePath)).toBe(true);
      expect(
        fs.readFileSync(path.join(session.worktreePath, 'untracked.bin')),
      ).toEqual(Buffer.from([0, 1, 2, 255]));
      const binding = await readWorktreeSessionStrict(session.sidecarPath);
      expect(binding.state).toBe('valid');
      if (binding.state === 'valid') {
        expect(binding.session.worktreeRemoved).toBeUndefined();
      }
      expect(
        snapshotFiles(path.dirname(session.sidecarPath), session.id),
      ).toEqual([]);
    },
  );

  it('allows a direct reset tombstone in the other archive state', async () => {
    const target = makeRetentionRepo(root, 'primary');
    configureRetention(target, 1);
    const session = await makeRetainedSession(target, {
      slug: 'cross-archive-reset',
      dirty: true,
      activity: '2026-01-01T00:00:00.000Z',
    });
    await makeRetainedSession(target, {
      slug: 'cross-archive-reset-newer-control',
      activity: '2026-01-02T00:00:00.000Z',
    });
    const tombstone = target.service.getWorktreeSessionPathForArchiveState(
      randomUUID(),
      'archived',
    );
    await writeWorktreeSession(tombstone, {
      ...session.sidecar,
      supersededBy: session.id,
    });

    expect((await sweep(target)).removed).toEqual([session.id]);
    await expectRetainedSnapshot(target, session);
  });

  it('preserves duplicate active/archived session state instead of choosing a copy', async () => {
    const target = makeRetentionRepo(root, 'primary');
    configureRetention(target, 1);
    const session = await makeRetainedSession(target, {
      slug: 'ambiguous-locations',
      dirty: true,
      activity: '2026-01-01T00:00:00.000Z',
    });
    const newest = await makeRetainedSession(target, {
      slug: 'unique-newer-location',
      activity: '2026-01-02T00:00:00.000Z',
    });
    const service = createWorkspaceRuntimeSessionService(target.runtime);
    const archivedSidecar = service.getWorktreeSessionPathForArchiveState(
      session.id,
      'archived',
    );
    const archivedTranscript = path.join(
      path.dirname(archivedSidecar),
      `${session.id}.jsonl`,
    );
    fs.mkdirSync(path.dirname(archivedTranscript), { recursive: true });
    fs.copyFileSync(session.transcriptPath, archivedTranscript);
    fs.copyFileSync(session.sidecarPath, archivedSidecar);

    expect((await sweep(target)).skipped).toContain(
      `session archive location is not unique: ${session.id}`,
    );
    expect(fs.existsSync(session.worktreePath)).toBe(true);
    expect(fs.existsSync(newest.worktreePath)).toBe(true);
    expect(
      snapshotFiles(path.dirname(session.sidecarPath), session.id),
    ).toEqual([]);

    fs.unlinkSync(archivedTranscript);
    expect((await sweep(target)).skipped).toContain(
      `session archive location is not unique: ${session.id}`,
    );
    expect(fs.existsSync(session.worktreePath)).toBe(true);
    expect(
      snapshotFiles(path.dirname(session.sidecarPath), session.id),
    ).toEqual([]);
  });

  it('does not let a plain non-Git workspace block an independent runtime', async () => {
    const target = makeRetentionRepo(root, 'primary');
    configureRetention(target, 1);
    const session = await makeRetainedSession(target, {
      slug: 'independent-plain-workspace',
      dirty: true,
      activity: '2026-01-01T00:00:00.000Z',
    });
    const newest = await makeRetainedSession(target, {
      slug: 'newer-plain-workspace-control',
      activity: '2026-01-02T00:00:00.000Z',
    });
    const secondary = makeRetentionRepo(root, 'secondary');
    const plain = path.join(root, 'plain-workspace');
    fs.mkdirSync(plain);
    const registry = createWorkspaceRegistry([
      target.runtime,
      {
        ...secondary.runtime,
        workspaceId: 'plain',
        workspaceCwd: plain,
      },
    ]);

    expect((await sweep(target, registry)).removed).toEqual([session.id]);
    await expectRetainedSnapshot(target, session);
    expect(fs.existsSync(newest.worktreePath)).toBe(true);
  });

  it('preserves other roots when a candidate Git root is unreadable', async () => {
    const target = makeRetentionRepo(root, 'primary');
    configureRetention(target, 1);
    const session = await makeRetainedSession(target, {
      slug: 'unreadable-secondary-root',
      dirty: true,
    });
    const secondary = makeRetentionRepo(root, 'secondary');
    fs.rmSync(path.join(secondary.repo, '.git'), {
      recursive: true,
      force: true,
    });
    fs.mkdirSync(path.join(secondary.repo, '.git'));
    const registry = createWorkspaceRegistry([
      target.runtime,
      secondary.runtime,
    ]);

    await expect(sweep(target, registry)).rejects.toThrow(
      'Git metadata exists but the repository root is unavailable',
    );
    expect(fs.existsSync(session.worktreePath)).toBe(true);
    expect(
      snapshotFiles(path.dirname(session.sidecarPath), session.id),
    ).toEqual([]);
  });

  it('disables zero before any Git root discovery', async () => {
    const target = makeRetentionRepo(root, 'primary');
    configureRetention(target, 0);
    await makeRetainedSession(target, { slug: 'must-survive' });
    const probe = vi.spyOn(GitWorktreeService.prototype, 'getRepoTopLevel');
    const result = await sweep(target);
    expect(result).toEqual({ removed: [], skipped: [], issues: [] });
    expect(probe).not.toHaveBeenCalled();
  });

  it('preserves checkouts when the pin store is unreadable and settings are corrupt', async () => {
    const target = makeRetentionRepo(root, 'primary');
    configureRetention(target, 1);
    const old = await makeRetainedSession(target, {
      slug: 'old-eligible',
      activity: '2026-01-01T00:00:00.000Z',
    });
    await makeRetainedSession(target, {
      slug: 'newer',
      activity: '2026-01-02T00:00:00.000Z',
    });
    const storePath = await runWithWorkspaceRuntimeStorage(target.runtime, () =>
      new SessionOrganizationService(target.repo).getStorePath(),
    );
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(storePath, '{bad-json');
    const invalidPin = await sweep(target);
    expect(invalidPin.removed).toEqual([]);
    expect(invalidPin.issues.length).toBeGreaterThan(0);
    expect(fs.existsSync(old.worktreePath)).toBe(true);

    configureRetention(target, 'raw');
    await expect(sweep(target)).rejects.toThrow();
    const settings = path.join(target.repo, '.qwen', 'settings.json');
    expect(fs.readFileSync(settings, 'utf8')).toBe('{not-json');
    expect(fs.existsSync(old.worktreePath)).toBe(true);
  });

  it('sweeps a standalone monorepo subdirectory workspace without aborting on root mismatch', async () => {
    const primary = makeRetentionRepo(root, 'primary');
    const subdir = path.join(primary.repo, 'packages', 'app');
    fs.mkdirSync(subdir, { recursive: true });
    const subRuntime = {
      ...primary.runtime,
      workspaceCwd: subdir,
    };
    const subTarget: RetentionTestRuntime = {
      ...primary,
      repo: subdir,
      runtime: subRuntime,
      service: createWorkspaceRuntimeSessionService(subRuntime),
      git: new GitWorktreeService(subdir),
    };
    configureRetention(subTarget, 1);
    const oldest = await makeRetainedSession(subTarget, {
      slug: 'subdir-oldest',
      dirty: true,
      activity: '2026-01-01T00:00:00.000Z',
    });
    const newest = await makeRetainedSession(subTarget, {
      slug: 'subdir-newest',
      activity: '2026-01-02T00:00:00.000Z',
    });

    const outcome = await sweep(subTarget);

    expect(outcome.issues).toEqual([]);
    expect(outcome.removed).toEqual([oldest.id]);
    expect(fs.existsSync(oldest.worktreePath)).toBe(false);
    expect(fs.existsSync(newest.worktreePath)).toBe(true);
    await expectRetainedSnapshot(subTarget, oldest);
  });

  it('clears the persisted attempt binding when a post-binding guard throws before physical removal', async () => {
    const target = makeRetentionRepo(root, 'primary');
    configureRetention(target, 1);
    const session = await makeRetainedSession(target, {
      slug: 'post-binding-guard-throw',
      dirty: true,
      activity: '2026-01-01T00:00:00.000Z',
    });
    await makeRetainedSession(target, {
      slug: 'post-binding-guard-throw-newer',
      activity: '2026-01-02T00:00:00.000Z',
    });
    const isPinned = SessionOrganizationService.prototype.isSessionPinnedStrict;
    const removeSpy = vi.spyOn(
      GitWorktreeService.prototype,
      'removeUserWorktree',
    );
    let threwAfterBinding = false;
    vi.spyOn(
      SessionOrganizationService.prototype,
      'isSessionPinnedStrict',
    ).mockImplementation(async function (
      this: SessionOrganizationService,
      sessionId: string,
    ) {
      if (!threwAfterBinding && sessionId === session.id) {
        const state = await readWorktreeSessionStrict(session.sidecarPath);
        if (
          state.state === 'valid' &&
          state.session.worktreeRemoved !== undefined
        ) {
          threwAfterBinding = true;
          throw new Error('injected post-binding guard exception');
        }
      }
      return isPinned.call(this, sessionId);
    });

    const outcome = await sweep(target);

    expect(threwAfterBinding).toBe(true);
    expect(outcome.removed).toEqual([]);
    expect(removeSpy).not.toHaveBeenCalled();
    expect(fs.existsSync(session.worktreePath)).toBe(true);
    const after = await readWorktreeSessionStrict(session.sidecarPath);
    expect(after.state).toBe('valid');
    if (after.state === 'valid') {
      expect(after.session.worktreeRemoved).toBeUndefined();
    }
  });

  it('clears a persisted attempt binding when post-write verification throws inside beforeRemoval', async () => {
    const target = makeRetentionRepo(root, 'primary');
    configureRetention(target, 1);
    const session = await makeRetainedSession(target, {
      slug: 'post-write-verify-throw',
      dirty: true,
      activity: '2026-01-01T00:00:00.000Z',
    });
    await makeRetainedSession(target, {
      slug: 'post-write-verify-throw-newer',
      activity: '2026-01-02T00:00:00.000Z',
    });
    const removeSpy = vi.spyOn(
      GitWorktreeService.prototype,
      'removeUserWorktree',
    );
    failedJsonWrite.filePath = session.sidecarPath;
    failedJsonWrite.failAfterWrite = true;
    failedJsonWrite.threwAfterWrite = false;

    const outcome = await sweep(target);

    expect(failedJsonWrite.threwAfterWrite).toBe(true);
    expect(outcome.removed).toEqual([]);
    expect(removeSpy).not.toHaveBeenCalled();
    expect(fs.existsSync(session.worktreePath)).toBe(true);
    const after = await readWorktreeSessionStrict(session.sidecarPath);
    expect(after.state).toBe('valid');
    if (after.state === 'valid') {
      expect(after.session.worktreeRemoved).toBeUndefined();
    }
  });

  it.each(['draining', 'transitioning', 'blocked'] as const)(
    'refuses a shared root while a sibling workspace is %s',
    async (siblingState) => {
      const primary = makeRetentionRepo(root, 'primary');
      const sibling = makeRetentionRepo(root, 'secondary');
      configureRetention(primary, 1);
      const nestedDir = path.join(primary.repo, 'nested');
      fs.mkdirSync(nestedDir, { recursive: true });
      const siblingRuntime = {
        ...sibling.runtime,
        workspaceCwd: nestedDir,
      };
      const registry = createWorkspaceRegistry([
        primary.runtime,
        siblingRuntime,
      ]);
      const siblingEntry = registry.getManagedEntryByWorkspaceId(
        siblingRuntime.workspaceId,
      )!;
      if (siblingState === 'draining') {
        expect(registry.beginDrain(siblingRuntime)).toBe(true);
      } else if (siblingState === 'transitioning') {
        expect(registry.beginReplacement(siblingEntry, 'rev-2')).toBe(true);
      } else {
        expect(registry.beginReplacement(siblingEntry, 'rev-2')).toBe(true);
        registry.blockReplacement(siblingEntry, 'injected blocked state');
      }

      const old = await makeRetainedSession(primary, {
        slug: `shared-${siblingState}-old`,
        activity: '2026-01-01T00:00:00.000Z',
      });
      await makeRetainedSession(primary, {
        slug: `shared-${siblingState}-new`,
        activity: '2026-01-02T00:00:00.000Z',
      });

      const report = await sweep(primary, registry);

      expect(report.removed).toEqual([]);
      expect(report.skipped).toContain('management root is shared');
      expect(fs.existsSync(old.worktreePath)).toBe(true);
    },
  );

  it('stops an in-flight sweep when maxRetained becomes 0 instead of capturing every remaining candidate', async () => {
    const primary = makeRetentionRepo(root, 'primary');
    configureRetention(primary, 1);
    const oldest = await makeRetainedSession(primary, {
      slug: 'disabled-mid-sweep-oldest',
      dirty: true,
      activity: '2026-01-01T00:00:00.000Z',
    });
    const middle = await makeRetainedSession(primary, {
      slug: 'disabled-mid-sweep-middle',
      dirty: true,
      activity: '2026-01-02T00:00:00.000Z',
    });
    await makeRetainedSession(primary, {
      slug: 'disabled-mid-sweep-newest',
      activity: '2026-01-03T00:00:00.000Z',
    });
    // Disabling retention is the reported emergency mitigation. It must take
    // effect before the NEXT candidate's capture: on a large checkout each
    // capture is minutes of compression and hashing, and the sweep used to
    // run it only to refuse removal afterwards in beforePhysicalRemoval.
    const snapshotService = await import(
      '@qwen-code/qwen-code-core/services/worktree-snapshot-service.js'
    );
    let captures = 0;
    const spy = vi
      .spyOn(snapshotService, 'captureWorktreeSnapshot')
      .mockImplementation(async () => {
        captures += 1;
        if (captures >= 1) configureRetention(primary, 0);
        return {
          snapshotPath: path.join(root, `injected-${captures}.tar.gz`),
          metaPath: path.join(root, `injected-${captures}.json`),
          checkoutMatchesCapture: true,
        };
      });

    try {
      const report = await sweep(primary);

      expect(captures).toBe(1);
      expect(report.removed).toEqual([]);
      expect(report.skipped).toContain('retention disabled during sweep');
      expect(fs.existsSync(oldest.worktreePath)).toBe(true);
      expect(fs.existsSync(middle.worktreePath)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('stops an in-flight sweep when maxRetained is raised instead of deleting remaining candidates against a stale plan (R1-2)', async () => {
    const primary = makeRetentionRepo(root, 'primary');
    configureRetention(primary, 1);
    const oldest = await makeRetainedSession(primary, {
      slug: 'raised-mid-sweep-oldest',
      dirty: true,
      activity: '2026-01-01T00:00:00.000Z',
    });
    const middle = await makeRetainedSession(primary, {
      slug: 'raised-mid-sweep-middle',
      dirty: true,
      activity: '2026-01-02T00:00:00.000Z',
    });
    const newest = await makeRetainedSession(primary, {
      slug: 'raised-mid-sweep-newest',
      activity: '2026-01-03T00:00:00.000Z',
    });

    const snapshotService = await import(
      '@qwen-code/qwen-code-core/services/worktree-snapshot-service.js'
    );
    const actualSnapshotService = await vi.importActual<
      typeof import('@qwen-code/qwen-code-core/services/worktree-snapshot-service.js')
    >('@qwen-code/qwen-code-core/services/worktree-snapshot-service.js');
    let captures = 0;
    const spy = vi
      .spyOn(snapshotService, 'captureWorktreeSnapshot')
      .mockImplementation(async (...args) => {
        captures += 1;
        const result = await actualSnapshotService.captureWorktreeSnapshot(
          ...args,
        );
        if (captures >= 1) configureRetention(primary, 5);
        return result;
      });
    try {
      const report = await sweep(primary);
      expect(captures).toBe(1);
      expect(report.removed).toEqual([oldest.id]);
      expect(report.skipped).toContain('retention limit changed during sweep');
      expect(fs.existsSync(oldest.worktreePath)).toBe(false);
      expect(fs.existsSync(middle.worktreePath)).toBe(true);
      expect(fs.existsSync(newest.worktreePath)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it.each([
    { nextLimit: 0, reason: 'retention disabled during sweep' },
    { nextLimit: 5, reason: 'retention limit changed during sweep' },
  ] as const)(
    'aborts before capturing when maxRetained changes to $nextLimit while waiting on the cleanup lock',
    async ({ nextLimit, reason }) => {
      const primary = makeRetentionRepo(root, 'primary');
      configureRetention(primary, 1);
      const oldest = await makeRetainedSession(primary, {
        slug: `lock-wait-limit-${nextLimit}-oldest`,
        dirty: true,
        activity: '2026-01-01T00:00:00.000Z',
      });
      const middle = await makeRetainedSession(primary, {
        slug: `lock-wait-limit-${nextLimit}-middle`,
        dirty: true,
        activity: '2026-01-02T00:00:00.000Z',
      });
      const newest = await makeRetainedSession(primary, {
        slug: `lock-wait-limit-${nextLimit}-newest`,
        activity: '2026-01-03T00:00:00.000Z',
      });

      const plan = await preclassifyWorktreeCleanup(primary.service, oldest.id);
      expect(plan).toBeDefined();

      const snapshotService = await import(
        '@qwen-code/qwen-code-core/services/worktree-snapshot-service.js'
      );
      let captures = 0;
      const captureSpy = vi
        .spyOn(snapshotService, 'captureWorktreeSnapshot')
        .mockImplementation(async () => {
          captures += 1;
          return {
            snapshotPath: path.join(root, `unexpected-${captures}.tar.gz`),
            metaPath: path.join(root, `unexpected-${captures}.json`),
            checkoutMatchesCapture: true,
          };
        });

      const origAcquire = worktreeOwnership.acquireWorktreeOwnershipOp;
      let callsForOldest = 0;
      let blockerPromise: Promise<() => void> | undefined;
      let releaseBlocker: (() => void) | undefined;
      let notifyQueued!: () => void;
      const queuedOnRemovalLock = new Promise<void>((resolve) => {
        notifyQueued = resolve;
      });
      const acquireSpy = vi
        .spyOn(worktreeOwnership, 'acquireWorktreeOwnershipOp')
        .mockImplementation(async (key) => {
          if (key === plan!.lockKey) {
            callsForOldest += 1;
            if (callsForOldest === 1) {
              // Call #1 happens during `collectEligible`. As soon as it
              // releases, take the real ownership lock so `removeRetainedCheckout`
              // (call #2, after the pre-lock `sweepLimit` check) genuinely waits
              // in the lock queue.
              const releaseCollect = await origAcquire(key);
              return () => {
                blockerPromise = origAcquire(key);
                releaseCollect();
              };
            }
            if (callsForOldest === 2) {
              const queued = origAcquire(key);
              notifyQueued();
              return queued;
            }
          }
          return origAcquire(key);
        });

      let released = false;
      const sweepPromise = sweep(primary);
      try {
        await queuedOnRemovalLock;
        releaseBlocker = await blockerPromise!;
        configureRetention(primary, nextLimit);
        releaseBlocker();
        released = true;

        const report = await sweepPromise;
        expect(captures).toBe(0);
        expect(report.removed).toEqual([]);
        expect(report.issues).toEqual([]);
        expect(report.skipped).toContain(reason);
        expect(fs.existsSync(oldest.worktreePath)).toBe(true);
        expect(fs.existsSync(middle.worktreePath)).toBe(true);
        expect(fs.existsSync(newest.worktreePath)).toBe(true);
        const archives = fs
          .readdirSync(path.dirname(oldest.sidecarPath))
          .filter((f) => f.endsWith('.worktree-snapshot.tar.gz'));
        expect(archives).toHaveLength(0);
      } finally {
        if (!released && blockerPromise) {
          (await blockerPromise)();
        }
        await sweepPromise.catch(() => undefined);
        captureSpy.mockRestore();
        acquireSpy.mockRestore();
      }
    },
  );

  it.each([false, null, 'off', []] as const)(
    'pauses retention instead of falling back to default when worktree settings is %j',
    async (invalidSection) => {
      const target = makeRetentionRepo(root, 'primary');
      const userSettings = path.join(target.home, '.qwen', 'settings.json');
      fs.mkdirSync(path.dirname(userSettings), { recursive: true });
      fs.writeFileSync(
        userSettings,
        JSON.stringify({ worktree: { maxRetained: 0 } }),
      );
      const workspaceSettings = path.join(
        target.repo,
        '.qwen',
        'settings.json',
      );
      fs.mkdirSync(path.dirname(workspaceSettings), { recursive: true });
      fs.writeFileSync(
        workspaceSettings,
        JSON.stringify({ worktree: invalidSection }),
      );
      const old = await makeRetainedSession(target, {
        slug: `invalid-section-${String(invalidSection)}`,
        dirty: true,
        activity: '2026-01-01T00:00:00.000Z',
      });

      await expect(sweep(target)).rejects.toThrow(
        'worktree settings must be an object; retention is paused',
      );
      expect(fs.existsSync(old.worktreePath)).toBe(true);
    },
  );
});
