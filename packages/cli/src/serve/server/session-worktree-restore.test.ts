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
  readWorktreeSessionStrict,
  writeWorktreeSession,
} from '@qwen-code/qwen-code-core';
import {
  makeRetainedSession,
  makeRetentionRepo,
  configureRetention,
  type RetentionTestRuntime,
} from '../../test-utils/worktree-session-retention-fixtures.js';
import { WorktreeMarkerCommittedError } from '@qwen-code/qwen-code-core/services/gitWorktreeService.js';
import * as snapshotVerification from '@qwen-code/qwen-code-core/services/worktree-snapshot-service.js';
import {
  preclassifyWorktreeCleanup,
  executeWorktreeCleanup,
} from './worktree-orphan-cleanup.js';
import {
  restoreWorktreeFromSessionSnapshot,
  WorktreeRestoreUnavailableError,
} from './session-worktree-restore.js';
import { SessionArchiveCoordinator } from './session-archive.js';
import { runWithWorkspaceRuntimeStorage } from '../workspace-runtime-storage.js';

const markerFaults = vi.hoisted(() => ({
  postCommit: false,
  otherOwner: undefined as string | undefined,
}));

vi.mock(
  '@qwen-code/qwen-code-core/services/gitWorktreeService.js',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('@qwen-code/qwen-code-core/services/gitWorktreeService.js')
      >();
    return {
      ...actual,
      createWorktreeSessionMarkerExclusive: vi.fn(
        async (worktreePath: string, sessionId: string) => {
          if (
            markerFaults.otherOwner !== undefined &&
            markerFaults.otherOwner !== sessionId
          ) {
            await actual.createWorktreeSessionMarkerExclusive(
              worktreePath,
              markerFaults.otherOwner,
            );
          }
          await actual.createWorktreeSessionMarkerExclusive(
            worktreePath,
            sessionId,
          );
          if (markerFaults.postCommit) {
            throw new actual.WorktreeMarkerCommittedError(sessionId);
          }
        },
      ),
    };
  },
);

const coreMocks = vi.hoisted(() => ({
  realWrite: undefined as
    | undefined
    | typeof import('@qwen-code/qwen-code-core').writeWorktreeSession,
  write: vi.fn(),
}));

vi.mock(
  '@qwen-code/qwen-code-core/services/worktreeSessionService.js',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('@qwen-code/qwen-code-core/services/worktreeSessionService.js')
      >();
    coreMocks.realWrite = actual.writeWorktreeSession;
    coreMocks.write.mockImplementation(actual.writeWorktreeSession);
    return { ...actual, writeWorktreeSession: coreMocks.write };
  },
);

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-worktree-restore-'));
  markerFaults.postCommit = false;
  markerFaults.otherOwner = undefined;
  coreMocks.write.mockImplementation(coreMocks.realWrite!);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

function git(
  target: RetentionTestRuntime,
  cwd: string,
  ...args: string[]
): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      PATH: process.env['PATH'],
      HOME: target.home,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
    },
  }).trim();
}

async function snapshotAndRemove(
  target: RetentionTestRuntime,
  output: Awaited<ReturnType<typeof makeRetainedSession>>,
) {
  const plan = await preclassifyWorktreeCleanup(
    target.service,
    output.id,
    target.repo,
  );
  if (!plan) throw new Error('Fixture does not have an owned sidecar');
  const result = await executeWorktreeCleanup(plan, { requireSnapshot: true });
  if (!result.removed || !result.snapshot) {
    throw new Error('Fixture snapshot removal was not completed');
  }
  const archiveKey = path.basename(result.snapshot.snapshotPath);
  await writeWorktreeSession(output.sidecarPath, {
    ...output.sidecar,
    worktreeRemoved: { archiveKey },
  });
  expect(fs.existsSync(output.worktreePath)).toBe(false);
  return { ...output, archiveKey };
}

async function restore(
  target: RetentionTestRuntime,
  sessionId: string,
  explicitWorkspaceCwd = true,
  assertRuntimeGenerationOpen?: () => void,
) {
  return runWithWorkspaceRuntimeStorage(target.runtime, () =>
    restoreWorktreeFromSessionSnapshot({
      runtime: target.runtime,
      sessionId,
      archiveCoordinator: new SessionArchiveCoordinator(),
      explicitWorkspaceCwd,
      assertRuntimeGenerationOpen,
    }),
  );
}

describe('session worktree snapshot restore', () => {
  vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

  it('preserves a committed marker and completes it on retry', async () => {
    const target = makeRetentionRepo(root, 'primary');
    configureRetention(target, 0);
    const state = await snapshotAndRemove(
      target,
      await makeRetainedSession(target, {
        slug: 'committed-marker',
        dirty: true,
      }),
    );
    markerFaults.postCommit = true;

    await expect(restore(target, state.id)).rejects.toBeInstanceOf(
      WorktreeMarkerCommittedError,
    );
    expect(fs.existsSync(state.worktreePath)).toBe(true);
    expect(
      fs.readFileSync(path.join(state.worktreePath, '.qwen-session'), 'utf8'),
    ).toBe(state.id);
    expect(
      fs.readFileSync(path.join(state.worktreePath, 'tracked.txt'), 'utf8'),
    ).toBe('dirty-committed-marker\n');
    const preserved = await readWorktreeSessionStrict(state.sidecarPath);
    expect(preserved.state).toBe('valid');
    if (preserved.state === 'valid') {
      expect(preserved.session.worktreeRemoved).toEqual({
        archiveKey: state.archiveKey,
      });
    }

    const retried = await restore(target, state.id);
    expect(retried.reconstructed).toBe(false);
    expect(
      fs.readFileSync(path.join(state.worktreePath, '.qwen-session'), 'utf8'),
    ).toBe(state.id);
    const completed = await readWorktreeSessionStrict(state.sidecarPath);
    expect(completed.state).toBe('valid');
    if (completed.state === 'valid') {
      expect(completed.session.worktreeRemoved).toBeUndefined();
    }
  });

  it('rechecks marker ownership before discarding the recovery binding', async () => {
    const target = makeRetentionRepo(root, 'primary');
    configureRetention(target, 0);
    const state = await snapshotAndRemove(
      target,
      await makeRetainedSession(target, {
        slug: 'marker-after-verification',
        dirty: true,
      }),
    );
    const archivePath = path.join(
      path.dirname(state.sidecarPath),
      state.archiveKey,
    );
    const archiveBytes = fs.readFileSync(archivePath);
    const verify = snapshotVerification.verifyRestoredWorktreeSnapshot;
    let comparisons = 0;
    vi.spyOn(
      snapshotVerification,
      'verifyRestoredWorktreeSnapshot',
    ).mockImplementation(async (options) => {
      const matches = await verify(options);
      comparisons += 1;
      if (comparisons === 2) {
        expect(matches).toBe(true);
        fs.renameSync(
          path.join(state.worktreePath, '.qwen-session'),
          path.join(root, `moved-marker-${state.id}`),
        );
      }
      return matches;
    });

    await expect(restore(target, state.id)).rejects.toMatchObject({
      name: 'WorktreeRestoreUnavailableError',
      message: expect.stringContaining('exclusive session marker'),
    });
    expect(comparisons).toBe(2);
    expect(fs.existsSync(state.worktreePath)).toBe(true);
    expect(fs.existsSync(path.join(state.worktreePath, '.qwen-session'))).toBe(
      false,
    );
    expect(
      fs.readFileSync(path.join(root, `moved-marker-${state.id}`), 'utf8'),
    ).toBe(state.id);
    expect(fs.readFileSync(archivePath)).toEqual(archiveBytes);
    const preserved = await readWorktreeSessionStrict(state.sidecarPath);
    expect(preserved.state).toBe('valid');
    if (preserved.state === 'valid') {
      expect(preserved.session.worktreeRemoved).toEqual({
        archiveKey: state.archiveKey,
      });
    }
  });

  it('preserves a concurrent foreign marker and its checkout', async () => {
    const target = makeRetentionRepo(root, 'primary');
    configureRetention(target, 0);
    const state = await snapshotAndRemove(
      target,
      await makeRetainedSession(target, {
        slug: 'concurrent-marker',
        dirty: true,
      }),
    );
    const foreign = '22222222-2222-4222-8222-222222222222';
    markerFaults.otherOwner = foreign;

    await expect(restore(target, state.id)).rejects.toMatchObject({
      code: 'EEXIST',
    });
    expect(fs.existsSync(state.worktreePath)).toBe(true);
    expect(
      fs.readFileSync(path.join(state.worktreePath, '.qwen-session'), 'utf8'),
    ).toBe(foreign);
    await expect(restore(target, state.id)).rejects.toBeInstanceOf(
      WorktreeRestoreUnavailableError,
    );
    expect(
      fs.readFileSync(path.join(state.worktreePath, '.qwen-session'), 'utf8'),
    ).toBe(foreign);
    const preserved = await readWorktreeSessionStrict(state.sidecarPath);
    expect(preserved.state).toBe('valid');
    if (preserved.state === 'valid') {
      expect(preserved.session.worktreeRemoved).toEqual({
        archiveKey: state.archiveKey,
      });
    }
  });

  it('refuses a second owner but accepts a direct reset tombstone', async () => {
    const target = makeRetentionRepo(root, 'primary');
    configureRetention(target, 0);
    const state = await snapshotAndRemove(
      target,
      await makeRetainedSession(target, {
        slug: 'owner-conflict',
        dirty: true,
      }),
    );
    const other = await makeRetainedSession(target, {
      slug: 'other-owner-tombstone',
    });
    const otherRecord = {
      ...other.sidecar,
      worktreePath: state.worktreePath,
      slug: state.sidecar.slug,
    };
    await writeWorktreeSession(other.sidecarPath, otherRecord);

    await expect(restore(target, state.id)).rejects.toBeInstanceOf(
      WorktreeRestoreUnavailableError,
    );
    expect(fs.existsSync(state.worktreePath)).toBe(false);
    const preserved = await readWorktreeSessionStrict(state.sidecarPath);
    expect(preserved.state).toBe('valid');
    if (preserved.state === 'valid') {
      expect(preserved.session.worktreeRemoved).toEqual({
        archiveKey: state.archiveKey,
      });
    }

    await writeWorktreeSession(other.sidecarPath, {
      ...otherRecord,
      supersededBy: state.id,
    });
    const restored = await restore(target, state.id);
    expect(restored.reconstructed).toBe(true);
    expect(
      fs.readFileSync(path.join(state.worktreePath, '.qwen-session'), 'utf8'),
    ).toBe(state.id);
  });

  it('defers archived restoration until the records are active again', async () => {
    const target = makeRetentionRepo(root, 'primary');
    configureRetention(target, 0);
    const state = await snapshotAndRemove(
      target,
      await makeRetainedSession(target, {
        slug: 'archived-restore',
        dirty: true,
      }),
    );
    const snapshotPath = path.join(
      path.dirname(state.sidecarPath),
      state.archiveKey,
    );
    const moved = [
      state.transcriptPath,
      state.sidecarPath,
      snapshotPath,
      snapshotPath.replace(/\.tar\.gz$/, '.json'),
    ];
    const archiveDirectory = path.dirname(
      target.service.getWorktreeSessionPathForArchiveState(
        state.id,
        'archived',
      ),
    );
    fs.mkdirSync(archiveDirectory, { recursive: true });
    for (const file of moved) {
      fs.renameSync(file, path.join(archiveDirectory, path.basename(file)));
    }

    await expect(restore(target, state.id)).rejects.toMatchObject({
      name: 'WorktreeRestoreUnavailableError',
      message: 'Unarchive this session before restoring its worktree',
    });
    expect(fs.existsSync(state.worktreePath)).toBe(false);
    const archivedPath = path.join(
      archiveDirectory,
      path.basename(state.sidecarPath),
    );
    const archived = await readWorktreeSessionStrict(archivedPath);
    expect(archived.state).toBe('valid');
    if (archived.state === 'valid') {
      expect(archived.session.worktreeRemoved).toEqual({
        archiveKey: state.archiveKey,
      });
    }
    for (const file of moved) {
      expect(
        fs.existsSync(path.join(archiveDirectory, path.basename(file))),
      ).toBe(true);
    }

    for (const file of moved) {
      fs.renameSync(path.join(archiveDirectory, path.basename(file)), file);
    }
    const restored = await restore(target, state.id);
    expect(restored.reconstructed).toBe(true);
  });

  it('reconstructs a detached checkout and verifies content, marker, and binding', async () => {
    const target = makeRetentionRepo(root, 'primary');
    configureRetention(target, 0);
    const state = await snapshotAndRemove(
      target,
      await makeRetainedSession(target, {
        slug: 'detached',
        dirty: true,
      }),
    );
    const result = await restore(target, state.id);
    expect(result.reconstructed).toBe(true);
    expect(result.branch).toBe('');
    expect(git(target, state.worktreePath, 'rev-parse', 'HEAD')).toBe(
      target.head,
    );
    expect(
      fs.readFileSync(path.join(state.worktreePath, 'tracked.txt'), 'utf8'),
    ).toBe('dirty-detached\n');
    if (process.platform !== 'win32') {
      expect(
        fs.statSync(path.join(state.worktreePath, 'tracked.txt')).mode & 0o777,
      ).toBe(0o755);
    }
    expect(
      fs.readFileSync(path.join(state.worktreePath, 'untracked.bin')),
    ).toEqual(Buffer.from([0, 1, 2, 255]));
    expect(fs.existsSync(path.join(state.worktreePath, 'delete-me.txt'))).toBe(
      false,
    );
    expect(
      fs.readFileSync(path.join(state.worktreePath, '.qwen-session'), 'utf8'),
    ).toBe(state.id);
    const binding = await readWorktreeSessionStrict(state.sidecarPath);
    expect(binding.state).toBe('valid');
    if (binding.state === 'valid') {
      expect(binding.session.worktreeRemoved).toBeUndefined();
      expect(binding.session.worktreeBranch).toBe('');
    }
  });

  it('attaches a named ref only while it still resolves to the captured head', async () => {
    const target = makeRetentionRepo(root, 'primary');
    configureRetention(target, 0);
    const state = await snapshotAndRemove(
      target,
      await makeRetainedSession(target, {
        slug: 'named',
        branch: 'feature-snapshot',
        dirty: true,
      }),
    );
    const result = await restore(target, state.id);
    expect(result.branch).toBe('feature-snapshot');
    expect(git(target, state.worktreePath, 'branch', '--show-current')).toBe(
      'feature-snapshot',
    );
    expect(git(target, target.repo, 'rev-parse', 'feature-snapshot')).toBe(
      target.head,
    );
  });

  it('restores detached when the named ref has moved, leaving that ref untouched', async () => {
    const target = makeRetentionRepo(root, 'primary');
    configureRetention(target, 0);
    const state = await snapshotAndRemove(
      target,
      await makeRetainedSession(target, {
        slug: 'moved-ref',
        branch: 'feature-forward',
        dirty: true,
      }),
    );
    git(target, target.repo, 'checkout', 'feature-forward');
    fs.writeFileSync(path.join(target.repo, 'ahead.txt'), 'not in snapshot\n');
    git(target, target.repo, 'add', 'ahead.txt');
    git(target, target.repo, 'commit', '-qm', 'advance ref', '--no-verify');
    const advanced = git(target, target.repo, 'rev-parse', 'feature-forward');
    expect(advanced).not.toBe(target.head);

    const result = await restore(target, state.id);
    expect(result.branch).toBe('');
    expect(git(target, state.worktreePath, 'rev-parse', 'HEAD')).toBe(
      target.head,
    );
    expect(git(target, target.repo, 'rev-parse', 'feature-forward')).toBe(
      advanced,
    );
    expect(git(target, state.worktreePath, 'branch', '--show-current')).toBe(
      '',
    );
  });

  it('refuses malformed or unavailable full commits before creating a checkout', async () => {
    const target = makeRetentionRepo(root, 'primary');
    configureRetention(target, 0);
    const state = await snapshotAndRemove(
      target,
      await makeRetainedSession(target, {
        slug: 'missing-commit',
        dirty: true,
      }),
    );
    const metaPath = path.join(
      path.dirname(state.sidecarPath),
      state.archiveKey.replace(/\.tar\.gz$/, '.json'),
    );
    const originalHeader = fs.readFileSync(metaPath, 'utf8');
    const parsed = JSON.parse(originalHeader) as Record<string, unknown>;
    const originalHead = parsed['headCommit'];
    if (typeof originalHead !== 'string') {
      throw new Error('Fixture does not contain a full head commit');
    }
    const invalidIds = [
      { field: 'headCommit', value: 'HEAD' },
      { field: 'headCommit', value: originalHead.slice(0, 39) },
      { field: 'headCommit', value: 'g'.repeat(40) },
      { field: 'baseCommit', value: 'HEAD' },
    ] as const;
    for (const { field, value } of invalidIds) {
      fs.writeFileSync(metaPath, JSON.stringify({ ...parsed, [field]: value }));
      await expect(restore(target, state.id)).rejects.toThrow(
        'invalid commit ids',
      );
      expect(fs.existsSync(state.worktreePath)).toBe(false);
      const unchanged = await readWorktreeSessionStrict(state.sidecarPath);
      expect(unchanged.state).toBe('valid');
      if (unchanged.state === 'valid') {
        expect(unchanged.session.worktreeRemoved).toEqual({
          archiveKey: state.archiveKey,
        });
      }
    }

    fs.writeFileSync(
      metaPath,
      JSON.stringify({ ...parsed, headCommit: '0'.repeat(40) }),
    );
    await expect(restore(target, state.id)).rejects.not.toThrow(
      'invalid commit ids',
    );
    expect(fs.existsSync(state.worktreePath)).toBe(false);

    fs.writeFileSync(metaPath, originalHeader);
    expect((await restore(target, state.id)).reconstructed).toBe(true);
    expect(
      fs.readFileSync(path.join(state.worktreePath, 'tracked.txt'), 'utf8'),
    ).toBe('dirty-missing-commit\n');
  });

  it('cleans its newly created target after an extraction failure and permits a later repair and retry', async () => {
    const target = makeRetentionRepo(root, 'primary');
    configureRetention(target, 0);
    const state = await snapshotAndRemove(
      target,
      await makeRetainedSession(target, {
        slug: 'bad-archive-retry',
        dirty: true,
      }),
    );
    const archive = path.join(
      path.dirname(state.sidecarPath),
      state.archiveKey,
    );
    const originalBytes = fs.readFileSync(archive);
    fs.writeFileSync(archive, Buffer.from('not a gzip archive'));

    await expect(restore(target, state.id)).rejects.toMatchObject({
      code: 'TAR_BAD_ARCHIVE',
    });
    expect(fs.existsSync(state.worktreePath)).toBe(false);
    expect(fs.existsSync(path.join(state.worktreePath, '.qwen-session'))).toBe(
      false,
    );

    // A second failure must reach the archive again, not be blocked by an
    // abandoned marker-less checkout from the first attempt.
    await expect(restore(target, state.id)).rejects.toMatchObject({
      code: 'TAR_BAD_ARCHIVE',
    });
    expect(fs.existsSync(state.worktreePath)).toBe(false);

    fs.writeFileSync(archive, originalBytes);
    expect(fs.readFileSync(archive)).toEqual(originalBytes);
    const result = await restore(target, state.id);
    expect(result.reconstructed).toBe(true);
    expect(result.branch).toBe('');
    expect(
      fs.readFileSync(path.join(state.worktreePath, 'tracked.txt'), 'utf8'),
    ).toBe('dirty-bad-archive-retry\n');
    expect(
      fs.readFileSync(path.join(state.worktreePath, '.qwen-session'), 'utf8'),
    ).toBe(state.id);
    const binding = await readWorktreeSessionStrict(state.sidecarPath);
    expect(binding.state).toBe('valid');
    if (binding.state === 'valid') {
      expect(binding.session.worktreeRemoved).toBeUndefined();
    }
  });

  it('could finalise a fully matching partial restore without reconstructing it again', async () => {
    const target = makeRetentionRepo(root, 'primary');
    configureRetention(target, 0);
    const state = await snapshotAndRemove(
      target,
      await makeRetainedSession(target, { slug: 'bind-only', dirty: true }),
    );
    const create = vi.spyOn(GitWorktreeService.prototype, 'createUserWorktree');
    coreMocks.write.mockClear();
    coreMocks.write.mockImplementationOnce(async () => {
      throw new Error('injected binding write failure');
    });
    await expect(restore(target, state.id)).rejects.toThrow(
      'injected binding write failure',
    );
    expect(coreMocks.write).toHaveBeenCalledTimes(1);
    expect(
      fs.readFileSync(path.join(state.worktreePath, '.qwen-session'), 'utf8'),
    ).toBe(state.id);

    const result = await restore(target, state.id);
    expect(result.reconstructed).toBe(false);
    expect(create).toHaveBeenCalledTimes(1);
    const binding = await readWorktreeSessionStrict(state.sidecarPath);
    expect(binding.state).toBe('valid');
    if (binding.state === 'valid') {
      expect(binding.session.worktreeRemoved).toBeUndefined();
    }
  });

  it('preserves late changes and the removed flag when binding verification fails', async () => {
    const target = makeRetentionRepo(root, 'primary');
    configureRetention(target, 0);
    const state = await snapshotAndRemove(
      target,
      await makeRetainedSession(target, { slug: 'late-change', dirty: true }),
    );
    coreMocks.write.mockClear();
    coreMocks.write.mockImplementationOnce(async () => {
      throw new Error('injected binding write failure');
    });
    await expect(restore(target, state.id)).rejects.toThrow();
    expect(coreMocks.write).toHaveBeenCalledTimes(1);
    const changed = path.join(state.worktreePath, 'tracked.txt');
    fs.writeFileSync(changed, 'human-late-change\n');

    await expect(restore(target, state.id)).rejects.toThrow(
      'does not match the selected snapshot',
    );
    expect(fs.readFileSync(changed, 'utf8')).toBe('human-late-change\n');
    const preserved = await readWorktreeSessionStrict(state.sidecarPath);
    expect(preserved.state).toBe('valid');
    if (preserved.state === 'valid') {
      expect(preserved.session.worktreeRemoved).toEqual({
        archiveKey: state.archiveKey,
      });
    }
  });

  it('discards only its new markerless checkout after generation closes', async () => {
    const target = makeRetentionRepo(root, 'primary');
    configureRetention(target, 0);
    const state = await snapshotAndRemove(
      target,
      await makeRetainedSession(target, {
        slug: 'generation-close',
        dirty: true,
      }),
    );
    const assertion = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('runtime generation closed');
      })
      .mockImplementation(() => {});

    await expect(restore(target, state.id, true, assertion)).rejects.toThrow(
      'runtime generation closed',
    );
    expect(fs.existsSync(state.worktreePath)).toBe(false);
    expect(fs.existsSync(path.join(state.worktreePath, '.qwen-session'))).toBe(
      false,
    );
    const preserved = await readWorktreeSessionStrict(state.sidecarPath);
    expect(preserved.state).toBe('valid');
    if (preserved.state === 'valid') {
      expect(preserved.session.worktreeRemoved).toEqual({
        archiveKey: state.archiveKey,
      });
    }

    const retried = await restore(target, state.id, true, assertion);
    expect(retried.reconstructed).toBe(true);
    // The closed attempt calls once. The successful retry checks snapshot
    // creation and both comparisons, then again before binding.
    expect(assertion).toHaveBeenCalledTimes(4);
    expect(git(target, state.worktreePath, 'rev-parse', 'HEAD')).toBe(
      target.head,
    );
    expect(
      fs.readFileSync(path.join(state.worktreePath, 'tracked.txt'), 'utf8'),
    ).toBe('dirty-generation-close\n');
    expect(
      fs.readFileSync(path.join(state.worktreePath, '.qwen-session'), 'utf8'),
    ).toBe(state.id);
  });

  it('requires explicit owner evidence for a secondary restore', async () => {
    const target = makeRetentionRepo(root, 'secondary');
    configureRetention(target, 0);
    const state = await snapshotAndRemove(
      target,
      await makeRetainedSession(target, { slug: 'missing-owner', dirty: true }),
    );
    const before = fs.readdirSync(path.dirname(state.sidecarPath)).sort();

    await expect(restore(target, state.id, false)).rejects.toBeInstanceOf(
      WorktreeRestoreUnavailableError,
    );

    expect(fs.readdirSync(path.dirname(state.sidecarPath)).sort()).toEqual(
      before,
    );
    expect(fs.existsSync(state.worktreePath)).toBe(false);
    await expect(readWorktreeSessionStrict(state.sidecarPath)).resolves.toEqual(
      {
        state: 'valid',
        session: {
          ...state.sidecar,
          worktreeRemoved: { archiveKey: state.archiveKey },
        },
      },
    );
  });

  it('restores consistently and hands off a matching lock key through a symlinked worktrees parent', async () => {
    const target = makeRetentionRepo(root, 'primary');
    configureRetention(target, 0);
    const externalWorktrees = path.join(root, 'real-worktrees-dir');
    fs.mkdirSync(externalWorktrees, { recursive: true });
    fs.mkdirSync(path.join(target.repo, '.qwen'), { recursive: true });
    fs.symlinkSync(
      externalWorktrees,
      path.join(target.repo, '.qwen', 'worktrees'),
      'dir',
    );
    const state = await snapshotAndRemove(
      target,
      await makeRetainedSession(target, {
        slug: 'symlink-parent-restore',
        dirty: true,
      }),
    );

    let handedOff: { worktreeKey: string; release: () => void } | undefined;
    try {
      const restored = await restoreWorktreeFromSessionSnapshot({
        runtime: target.runtime,
        sessionId: state.id,
        archiveCoordinator: new SessionArchiveCoordinator(),
        handoffWorktreeOwnership: (handoff) => {
          handedOff = handoff;
        },
      });
      expect(restored.reconstructed).toBe(true);
      expect(handedOff?.worktreeKey).toBe(fs.realpathSync(state.worktreePath));
      expect(
        fs.readFileSync(path.join(state.worktreePath, 'tracked.txt'), 'utf8'),
      ).toBe('dirty-symlink-parent-restore\n');
    } finally {
      handedOff?.release();
    }
  });

  it('refuses restoration when the session has an active/archived conflict', async () => {
    const target = makeRetentionRepo(root, 'primary');
    configureRetention(target, 0);
    const state = await snapshotAndRemove(
      target,
      await makeRetainedSession(target, {
        slug: 'conflict-state',
        dirty: true,
      }),
    );
    const archivedTranscript = path.join(
      path.dirname(
        target.service.getWorktreeSessionPathForArchiveState(
          state.id,
          'archived',
        ),
      ),
      `${state.id}.jsonl`,
    );
    fs.mkdirSync(path.dirname(archivedTranscript), { recursive: true });
    fs.copyFileSync(state.transcriptPath, archivedTranscript);

    await expect(restore(target, state.id, true)).rejects.toThrow(/conflicts/i);
    expect(fs.existsSync(state.worktreePath)).toBe(false);
  });

  it('refuses restoration when an active transcript only has a stranded archived sidecar', async () => {
    const target = makeRetentionRepo(root, 'primary');
    configureRetention(target, 0);
    const state = await snapshotAndRemove(
      target,
      await makeRetainedSession(target, {
        slug: 'stranded-archived-sidecar',
        dirty: true,
      }),
    );
    const archivedSidecar =
      target.service.getWorktreeSessionPathForArchiveState(
        state.id,
        'archived',
      );
    fs.mkdirSync(path.dirname(archivedSidecar), { recursive: true });
    fs.renameSync(state.sidecarPath, archivedSidecar);
    const beforeArchived = fs.readFileSync(archivedSidecar, 'utf8');

    await expect(restore(target, state.id, true)).rejects.toBeInstanceOf(
      WorktreeRestoreUnavailableError,
    );
    expect(fs.existsSync(state.worktreePath)).toBe(false);
    expect(fs.readFileSync(archivedSidecar, 'utf8')).toBe(beforeArchived);
  });
});
