/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  GitWorktreeService,
  readWorktreeSnapshotMeta,
  readWorktreeSessionStrict,
  WORKTREE_SESSION_FILE,
  writeWorktreeSessionMarker,
} from '@qwen-code/qwen-code-core';
import { SessionOrganizationService } from '@qwen-code/qwen-code-core/services/session-organization-service.js';
import { worktreeHasPopulatedGitlink } from '@qwen-code/qwen-code-core/services/gitWorktreeService.js';
import {
  selectWorktreeSnapshot,
  verifyRestoredWorktreeSnapshot,
} from '@qwen-code/qwen-code-core/services/worktree-snapshot-service.js';

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
import { createWorkspaceRegistry } from '../workspace-registry.js';
import { runWithWorkspaceRuntimeStorage } from '../workspace-runtime-storage.js';
import { SessionArchiveCoordinator } from './session-archive.js';
import { sweepWorktreeRetentionOnce } from './worktree-retention.js';
import {
  configureRetention,
  makeRetainedSession,
  makeRetentionRepo,
  type RetentionTestRuntime,
} from '../../test-utils/worktree-session-retention-fixtures.js';

const failedJsonWrite = vi.hoisted(() => ({
  filePath: undefined as string | undefined,
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
  initialized: false,
}));
vi.mock(
  '@qwen-code/qwen-code-core/services/worktree-snapshot-service.js',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('@qwen-code/qwen-code-core/services/worktree-snapshot-service.js')
      >();
    return {
      ...actual,
      verifyRestoredWorktreeSnapshot: vi.fn(
        async (
          options: Parameters<typeof actual.verifyRestoredWorktreeSnapshot>[0],
        ) => {
          const matches = await actual.verifyRestoredWorktreeSnapshot(options);
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
  captureInit.worktreePath = undefined;
  captureInit.home = undefined;
  captureInit.sourceRepo = undefined;
  captureInit.objectStore = undefined;
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
});
