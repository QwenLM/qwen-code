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
) {
  return runWithWorkspaceRuntimeStorage(target.runtime, () =>
    restoreWorktreeFromSessionSnapshot({
      runtime: target.runtime,
      sessionId,
      archiveCoordinator: new SessionArchiveCoordinator(),
      explicitWorkspaceCwd,
    }),
  );
}

describe('session worktree snapshot restore', () => {
  vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

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

  it('refuses bad metadata or an unavailable full head object before creating a checkout', async () => {
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
    const parsed = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    parsed.headCommit = '0'.repeat(40);
    fs.writeFileSync(metaPath, JSON.stringify(parsed));
    await expect(restore(target, state.id)).rejects.toThrow();
    expect(fs.existsSync(state.worktreePath)).toBe(false);
    const unchanged = await readWorktreeSessionStrict(state.sidecarPath);
    expect(unchanged.state).toBe('valid');
    if (unchanged.state === 'valid') {
      expect(unchanged.session.worktreeRemoved).toEqual({
        archiveKey: state.archiveKey,
      });
    }
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
});
