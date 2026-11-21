/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  GitWorktreeService,
  readWorktreeSnapshotMeta,
  readWorktreeSessionStrict,
} from '@qwen-code/qwen-code-core';
import { SessionOrganizationService } from '@qwen-code/qwen-code-core/services/session-organization-service.js';
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

let root: string;
let coordinator: SessionArchiveCoordinator;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-worktree-retention-'));
  coordinator = new SessionArchiveCoordinator();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

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
