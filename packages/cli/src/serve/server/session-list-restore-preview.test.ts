/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  buildWorktreeSnapshotMeta,
  captureWorktreeSnapshot,
  writeWorktreeSession,
  readWorktreeSession,
  GitWorktreeService,
  WorktreeSessionReadInconclusiveError,
} from '@qwen-code/qwen-code-core';
import type {
  AcpSessionBridge,
  BridgeSessionSummary,
} from '../acp-session-bridge.js';
import { runWithWorkspaceRuntimeStorage } from '../workspace-runtime-storage.js';
import {
  executeWorktreeCleanup,
  preclassifyWorktreeCleanup,
} from './worktree-orphan-cleanup.js';
import {
  makeRetainedSession,
  makeRetentionRepo,
  type RetentionTestRuntime,
} from '../../test-utils/worktree-session-retention-fixtures.js';
import {
  enrichWorktreeSidecars,
  listWorkspaceSessionsForResponse,
} from './session-list.js';

const coreMocks = vi.hoisted(() => ({
  realRead: undefined as
    | typeof import('@qwen-code/qwen-code-core').readWorktreeSession
    | undefined,
  read: vi.fn(),
}));

vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/qwen-code-core')>();
  coreMocks.realRead = actual.readWorktreeSession;
  coreMocks.read.mockImplementation(actual.readWorktreeSession);
  return { ...actual, readWorktreeSession: coreMocks.read };
});

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-restore-preview-'));
  coreMocks.read.mockReset();
  coreMocks.read.mockImplementation(coreMocks.realRead!);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

function summaries(target: RetentionTestRuntime, sessionId: string) {
  return new Map<string, BridgeSessionSummary>([
    [
      sessionId,
      {
        sessionId,
        workspaceCwd: target.repo,
      } as unknown as BridgeSessionSummary,
    ],
  ]);
}

async function removedRecord(
  target: RetentionTestRuntime,
  options: { slug?: string } = {},
) {
  const session = await makeRetainedSession(target, {
    slug: options.slug ?? 'preview-removed',
    dirty: true,
  });
  const plan = await preclassifyWorktreeCleanup(
    target.service,
    session.id,
    target.repo,
  );
  if (!plan) throw new Error('Missing owned fixture binding');
  const result = await executeWorktreeCleanup(plan, {
    requireSnapshot: true,
  });
  if (!result.removed || !result.snapshot) {
    throw new Error('Fixture did not remove after capture');
  }
  const archiveKey = path.basename(result.snapshot.snapshotPath);
  await writeWorktreeSession(session.sidecarPath, {
    ...session.sidecar,
    worktreeRemoved: { archiveKey },
  });
  return { ...session, archiveKey };
}

describe('worktree restoration preview metadata', () => {
  it('surfaces an owned removed record even though its marker is absent', async () => {
    const target = makeRetentionRepo(root, 'primary');
    const record = await removedRecord(target);
    const map = summaries(target, record.id);
    await enrichWorktreeSidecars(map, target.service, 'active');
    expect(await readWorktreeSession(record.sidecarPath)).toEqual(
      expect.objectContaining({
        workspaceCwd: target.repo,
        worktreeRemoved: { archiveKey: record.archiveKey },
      }),
    );
    const worktree = map.get(record.id)!.worktree;
    expect(worktree?.branch).toBe('');
    expect(worktree?.worktreeRemoved?.archiveKey).toBe(record.archiveKey);
    expect(worktree?.canRestore).toBe(true);
  });

  it('refuses availability when the owned archive pair no longer exists', async () => {
    const target = makeRetentionRepo(root, 'primary');
    const record = await removedRecord(target);
    fs.rmSync(path.join(path.dirname(record.sidecarPath), record.archiveKey));
    const map = summaries(target, record.id);
    await enrichWorktreeSidecars(map, target.service, 'active');
    expect(map.get(record.id)!.worktree?.worktreeRemoved).toEqual({
      archiveKey: record.archiveKey,
    });
    expect(map.get(record.id)!.worktree?.canRestore).toBe(false);
  });

  it('rejects a sidecar whose workspace does not match the selected runtime', async () => {
    const target = makeRetentionRepo(root, 'primary');
    const other = makeRetentionRepo(root, 'secondary');
    const record = await removedRecord(target);
    await writeWorktreeSession(record.sidecarPath, {
      ...record.sidecar,
      workspaceCwd: other.repo,
      worktreeRemoved: { archiveKey: record.archiveKey },
    });
    const map = summaries(target, record.id);
    await enrichWorktreeSidecars(map, target.service, 'active');
    expect(map.get(record.id)!.worktree?.canRestore).toBe(false);
  });

  it('refuses availability when the original cwd is outside the selected runtime roots', async () => {
    const target = makeRetentionRepo(root, 'primary');
    const other = makeRetentionRepo(root, 'secondary');
    const record = await removedRecord(target);
    await writeWorktreeSession(record.sidecarPath, {
      ...record.sidecar,
      originalCwd: other.repo,
      worktreeRemoved: { archiveKey: record.archiveKey },
    });
    const map = summaries(target, record.id);
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    await enrichWorktreeSidecars(map, target.service, 'active');
    expect(map.get(record.id)!.worktree?.canRestore).toBe(false);
    expect(
      stderr.mock.calls.filter((call) =>
        String(call[0]).includes('action=delete'),
      ),
    ).toEqual([]);
  });

  it('refuses availability when the checkout belongs to a replacement session', async () => {
    const target = makeRetentionRepo(root, 'primary');
    const record = await removedRecord(target);
    await writeWorktreeSession(record.sidecarPath, {
      ...record.sidecar,
      supersededBy: 'replacement-session',
      worktreeRemoved: { archiveKey: record.archiveKey },
    });
    const map = summaries(target, record.id);
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    await enrichWorktreeSidecars(map, target.service, 'active');
    expect(map.get(record.id)!.worktree?.canRestore).toBe(false);
    expect(
      stderr.mock.calls.filter((call) =>
        String(call[0]).includes('action=delete'),
      ),
    ).toEqual([]);
  });

  it('preserves a normal marker-owned worktree without adopting an orphan archive', async () => {
    const target = makeRetentionRepo(root, 'primary');
    const session = await makeRetainedSession(target, {
      slug: 'ordinary-live',
      dirty: true,
    });
    const meta = await buildWorktreeSnapshotMeta(session.worktreePath, {
      sessionId: session.id,
      slug: session.sidecar.slug,
      baseCommit: target.head,
    });
    await captureWorktreeSnapshot({
      worktreePath: session.worktreePath,
      snapshotDir: path.dirname(session.sidecarPath),
      meta,
    });
    const map = summaries(target, session.id);
    await enrichWorktreeSidecars(map, target.service, 'active');
    const worktree = map.get(session.id)!.worktree;
    expect(worktree?.slug).toBe('ordinary-live');
    expect(worktree?.branch).toBe('');
    expect(worktree).not.toHaveProperty('worktreeRemoved');
    expect(worktree).not.toHaveProperty('canRestore');
  });

  it.each([undefined, 'organized'] as const)(
    'uses current snapshot lifecycle fields instead of stale live fields (%s)',
    async (view) => {
      const target = makeRetentionRepo(root, 'primary');
      const record = await removedRecord(target);
      const live = summaries(target, record.id).get(record.id)!;
      live.worktree = {
        slug: record.sidecar.slug,
        path: record.worktreePath,
        branch: 'current-live-branch',
        worktreeRemoved: {
          archiveKey: 'obsolete.worktree-snapshot.tar.gz',
        },
        canRestore: false,
      };
      const bridge = {
        listWorkspaceSessions: () => [live],
      } as unknown as AcpSessionBridge;
      const load = async () => {
        const result = await runWithWorkspaceRuntimeStorage(
          target.runtime,
          () =>
            listWorkspaceSessionsForResponse(
              bridge,
              target.repo,
              { size: 100, ...(view ? { view } : {}) },
              { runtimeBaseDir: target.runtime.sessionRuntimeBaseDir },
            ),
        );
        expect(
          result.sessions.filter((row) => row.sessionId === record.id),
        ).toHaveLength(1);
        return result.sessions.find((row) => row.sessionId === record.id)!;
      };

      const retained = await load();
      expect(retained.worktree?.worktreeRemoved?.archiveKey).toBe(
        record.archiveKey,
      );
      expect(retained.worktree?.canRestore).toBe(true);
      expect(retained.worktree?.branch).toBe('current-live-branch');

      await writeWorktreeSession(record.sidecarPath, record.sidecar);
      fs.mkdirSync(record.worktreePath, { recursive: true });
      fs.writeFileSync(
        path.join(record.worktreePath, '.qwen-session'),
        record.id,
      );
      const reopened = await load();
      expect(reopened.worktree?.worktreeRemoved).toBeUndefined();
      expect(reopened.worktree?.canRestore).toBeUndefined();
      expect(reopened.worktree?.branch).toBe('current-live-branch');
    },
  );

  it('keeps a cached removed record disabled when revalidation is inconclusive', async () => {
    const target = makeRetentionRepo(root, 'primary');
    const record = await removedRecord(target);
    const bridge = {
      listWorkspaceSessions: () => [],
    } as unknown as AcpSessionBridge;
    const load = async () => {
      const result = await runWithWorkspaceRuntimeStorage(target.runtime, () =>
        listWorkspaceSessionsForResponse(
          bridge,
          target.repo,
          { size: 100, view: 'organized' },
          { runtimeBaseDir: target.runtime.sessionRuntimeBaseDir },
        ),
      );
      return result.sessions.find((row) => row.sessionId === record.id)!;
    };

    expect((await load()).worktree?.canRestore).toBe(true);
    coreMocks.read.mockImplementationOnce(async () => {
      throw new WorktreeSessionReadInconclusiveError(record.sidecarPath);
    });

    const retained = await load();
    expect(retained.worktree?.path).toBe(record.worktreePath);
    expect(retained.worktree?.worktreeRemoved?.archiveKey).toBe(
      record.archiveKey,
    );
    expect(retained.worktree?.canRestore).toBe(false);
  });

  it('preserves an invalid removed binding but clears it for genuine absence', async () => {
    const target = makeRetentionRepo(root, 'primary');
    const record = await removedRecord(target);
    const bridge = {
      listWorkspaceSessions: () => [],
    } as unknown as AcpSessionBridge;
    const load = async () => {
      const result = await runWithWorkspaceRuntimeStorage(target.runtime, () =>
        listWorkspaceSessionsForResponse(
          bridge,
          target.repo,
          { size: 100, view: 'organized' },
          { runtimeBaseDir: target.runtime.sessionRuntimeBaseDir },
        ),
      );
      return result.sessions.find((row) => row.sessionId === record.id)!;
    };

    expect((await load()).worktree?.canRestore).toBe(true);
    fs.writeFileSync(record.sidecarPath, '{truncated');
    const invalid = await load();
    expect(invalid.worktree?.worktreeRemoved).toEqual({
      archiveKey: record.archiveKey,
    });
    expect(invalid.worktree?.canRestore).toBe(false);

    fs.rmSync(record.sidecarPath);
    expect((await load()).worktree?.worktreeRemoved).toBeUndefined();
  });

  it('attests the selected runtime root once for multiple preview records', async () => {
    const target = makeRetentionRepo(root, 'primary');
    const first = await removedRecord(target);
    const second = await removedRecord(target, { slug: 'preview-removed-2' });
    const map = summaries(target, first.id);
    map.set(second.id, summaries(target, second.id).get(second.id)!);
    const rootLookup = vi.spyOn(
      GitWorktreeService.prototype,
      'getRepoTopLevel',
    );

    await enrichWorktreeSidecars(map, target.service, 'active');

    expect(rootLookup).toHaveBeenCalledTimes(1);
    expect(map.get(first.id)!.worktree?.canRestore).toBe(true);
    expect(map.get(second.id)!.worktree?.canRestore).toBe(true);
  });

  it('removes a cached projection when its current marker has a new owner', async () => {
    const target = makeRetentionRepo(root, 'primary');
    const session = await makeRetainedSession(target, {
      slug: 'owned-before-reclaim',
      dirty: true,
    });
    const bridge = {
      listWorkspaceSessions: () => [],
    } as unknown as AcpSessionBridge;
    const load = async () => {
      const result = await runWithWorkspaceRuntimeStorage(target.runtime, () =>
        listWorkspaceSessionsForResponse(
          bridge,
          target.repo,
          { size: 100, view: 'organized' },
          { runtimeBaseDir: target.runtime.sessionRuntimeBaseDir },
        ),
      );
      return result.sessions.find((row) => row.sessionId === session.id)!;
    };
    expect((await load()).worktree?.slug).toBe('owned-before-reclaim');

    fs.writeFileSync(
      path.join(session.worktreePath, '.qwen-session'),
      'another-session',
    );
    expect((await load()).worktree).toBeUndefined();
  });
});
