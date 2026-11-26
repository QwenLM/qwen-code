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
  isBridgeSessionRetirementFenced,
  listWorkspaceSessionsForResponse,
  searchWorkspaceSessionsForResponse,
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
  options: { sessionId?: string; slug?: string; writeBinding?: boolean } = {},
) {
  const session = await makeRetainedSession(target, {
    sessionId: options.sessionId,
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
  if (options.writeBinding !== false) {
    await writeWorktreeSession(session.sidecarPath, {
      ...session.sidecar,
      worktreeRemoved: { archiveKey },
    });
  }
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

  it('does not advertise restoration while the session has an archived twin', async () => {
    const target = makeRetentionRepo(root, 'primary');
    const record = await removedRecord(target);
    const archiveDir = path.join(
      path.dirname(record.transcriptPath),
      'archive',
    );
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.copyFileSync(
      record.transcriptPath,
      path.join(archiveDir, path.basename(record.transcriptPath)),
    );
    const map = summaries(target, record.id);

    await enrichWorktreeSidecars(map, target.service, 'active');

    const worktree = map.get(record.id)!.worktree;
    expect(worktree?.worktreeRemoved).toEqual({
      archiveKey: record.archiveKey,
    });
    expect(worktree?.canRestore).toBe(false);
  });

  it('offers restoration after a historical removal omitted its binding without writing the record', async () => {
    const target = makeRetentionRepo(root, 'primary');
    const record = await removedRecord(target, { writeBinding: false });
    const map = summaries(target, record.id);

    await enrichWorktreeSidecars(map, target.service, 'active');

    expect(map.get(record.id)!.worktree?.canRestore).toBe(true);
    expect(map.get(record.id)!.worktree?.worktreeRemoved).toEqual({
      archiveKey: record.archiveKey,
    });
    expect(await readWorktreeSession(record.sidecarPath)).toEqual(
      expect.objectContaining({ workspaceCwd: target.repo }),
    );
    expect(
      (await readWorktreeSession(record.sidecarPath))?.worktreeRemoved,
    ).toBeUndefined();
  });

  it.each([
    'another-workspace',
    'occupied-directory',
    'coordinate-mismatch',
  ] as const)('does not adopt an unbound snapshot for %s', async (scenario) => {
    const target = makeRetentionRepo(root, 'primary');
    const record = await removedRecord(target, { writeBinding: false });
    if (scenario === 'another-workspace') {
      const other = makeRetentionRepo(root, 'secondary');
      await writeWorktreeSession(record.sidecarPath, {
        ...record.sidecar,
        workspaceCwd: other.repo,
      });
    } else if (scenario === 'occupied-directory') {
      fs.mkdirSync(record.worktreePath, { recursive: true });
    } else {
      await writeWorktreeSession(record.sidecarPath, {
        ...record.sidecar,
        worktreePath: path.join(
          path.dirname(record.worktreePath),
          'unexpected-coordinate',
        ),
      });
    }
    const map = summaries(target, record.id);

    await enrichWorktreeSidecars(map, target.service, 'active');

    expect(map.get(record.id)!.worktree).toBeUndefined();
    expect(
      (await readWorktreeSession(record.sidecarPath))?.worktreeRemoved,
    ).toBeUndefined();
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
    expect((await load()).worktree).toBeUndefined();
  });

  it('preserves a non-removed scan snapshot across concurrent sidecar writes while refreshing a restored entry', async () => {
    const target = makeRetentionRepo(root, 'primary');

    // 1. A non-removed scan snapshot must not be torn by a concurrent sidecar write.
    const live = await makeRetainedSession(target, {
      slug: 'before-sidecar-write',
    });
    const liveMap = summaries(target, live.id);
    const liveRow = liveMap.get(live.id)!;
    liveMap.set(live.id, {
      ...liveRow,
      worktree: {
        slug: 'before-sidecar-write',
        path: live.worktreePath,
        branch: 'qwen/before-sidecar-write',
      },
    });
    await writeWorktreeSession(live.sidecarPath, {
      ...live.sidecar,
      slug: 'after-sidecar-write',
      worktreeBranch: 'qwen/after-sidecar-write',
    });
    await enrichWorktreeSidecars(liveMap, target.service, 'active');
    expect(liveMap.get(live.id)!.worktree?.slug).toBe('before-sidecar-write');
    expect(liveMap.get(live.id)!.worktree?.branch).toBe(
      'qwen/before-sidecar-write',
    );

    // 2. A cached removed entry that has just been restored to detached HEAD refreshes branch and clears removal fields.
    const restored = await makeRetainedSession(target, {
      slug: 'restored-detached-refresh',
    });
    const restoredMap = summaries(target, restored.id);
    restoredMap.set(restored.id, {
      ...restoredMap.get(restored.id)!,
      worktree: {
        slug: restored.sidecar.slug,
        path: restored.worktreePath,
        branch: 'qwen/old-branch',
        worktreeRemoved: {
          archiveKey: `${restored.id}.1.1.worktree-snapshot.tar.gz`,
        },
        canRestore: true,
      },
    });
    await writeWorktreeSession(restored.sidecarPath, {
      ...restored.sidecar,
      worktreeBranch: '',
    });
    await enrichWorktreeSidecars(restoredMap, target.service, 'active');
    expect(restoredMap.get(restored.id)!.worktree?.branch).toBe('');
    expect(
      restoredMap.get(restored.id)!.worktree?.worktreeRemoved,
    ).toBeUndefined();
    expect(restoredMap.get(restored.id)!.worktree?.canRestore).toBeUndefined();
  });

  it('sets canRestore to false when a retained session is fenced for retirement', async () => {
    const target = makeRetentionRepo(root, 'primary');
    const record = await removedRecord(target, { slug: 'retired-preview' });
    const map = summaries(target, record.id);

    await enrichWorktreeSidecars(
      map,
      target.service,
      'active',
      undefined,
      (id) => id === record.id,
    );

    expect(map.get(record.id)!.worktree?.worktreeRemoved).toEqual({
      archiveKey: record.archiveKey,
    });
    expect(map.get(record.id)!.worktree?.canRestore).toBe(false);
  });

  it('keeps canRestore true for an interrupted unarchive twin (nlink === 2) and fails closed on corrupt retirement ledger in list/search', async () => {
    const target = makeRetentionRepo(root, 'primary');
    const record = await removedRecord(target, {
      slug: 'interrupted-twin-preview',
    });
    const activeDir = path.dirname(record.sidecarPath);
    const archivedDir = path.dirname(
      target.service.getWorktreeSessionPathForArchiveState(
        record.id,
        'archived',
      ),
    );
    fs.mkdirSync(archivedDir, { recursive: true });
    const metaName = `${record.archiveKey.slice(0, -'.tar.gz'.length)}.json`;
    fs.linkSync(
      path.join(activeDir, record.archiveKey),
      path.join(archivedDir, record.archiveKey),
    );
    fs.linkSync(
      path.join(activeDir, metaName),
      path.join(archivedDir, metaName),
    );

    const openBridge = {
      listSessions: () => [],
      getSessionRetirement: () => undefined,
    } as unknown as AcpSessionBridge;
    const openListed = await runWithWorkspaceRuntimeStorage(
      target.runtime,
      () =>
        listWorkspaceSessionsForResponse(
          openBridge,
          target.repo,
          { size: 20 },
          {
            mergeLive: false,
            runtimeBaseDir: target.runtime.sessionRuntimeBaseDir,
          },
        ),
    );
    const openRow = openListed.sessions.find((s) => s.sessionId === record.id);
    expect(openRow?.worktree?.canRestore).toBe(true);
    // Preview must remain strictly read-only (twins untouched on disk).
    expect(fs.existsSync(path.join(archivedDir, record.archiveKey))).toBe(true);

    const corruptLedgerBridge = {
      listSessions: () => [],
      getSessionRetirement: () => {
        throw new Error('corrupt retirement ledger');
      },
    } as unknown as AcpSessionBridge;
    const fencedListed = await runWithWorkspaceRuntimeStorage(
      target.runtime,
      () =>
        listWorkspaceSessionsForResponse(
          corruptLedgerBridge,
          target.repo,
          { size: 20 },
          {
            mergeLive: false,
            runtimeBaseDir: target.runtime.sessionRuntimeBaseDir,
          },
        ),
    );
    expect(
      fencedListed.sessions.find((s) => s.sessionId === record.id)?.worktree
        ?.canRestore,
    ).toBe(false);

    fs.writeFileSync(
      record.transcriptPath,
      JSON.stringify({
        uuid: 'u-1',
        parentUuid: null,
        sessionId: record.id,
        timestamp: new Date().toISOString(),
        type: 'user',
        cwd: record.worktreePath,
        version: '0.28.3',
        message: {
          role: 'user',
          parts: [{ text: 'searchable retired twin prompt' }],
        },
      }) + '\n',
    );
    const searchResult = await runWithWorkspaceRuntimeStorage(
      target.runtime,
      () =>
        searchWorkspaceSessionsForResponse(
          target.repo,
          'searchable retired twin prompt',
          { maxResults: 10 },
          {
            runtimeBaseDir: target.runtime.sessionRuntimeBaseDir,
            isSessionRetirementFenced: (id) =>
              isBridgeSessionRetirementFenced(corruptLedgerBridge, id),
          },
        ),
    );
    const searchRow = searchResult.results.find(
      (r) => r.session.sessionId === record.id,
    );
    expect(searchRow).toBeDefined();
    expect(searchRow?.session.worktree?.canRestore).toBe(false);
  });

  it('fences an uppercase legacy UUID session in list preview when retirement lookup only matches lowercase', async () => {
    const target = makeRetentionRepo(root, 'primary');
    const upperId = '550E8400-E29B-41D4-A716-446655440901';
    const record = await removedRecord(target, {
      sessionId: upperId,
      slug: 'upper-fenced-preview',
    });

    const openBridge = {
      listSessions: () => [],
      getSessionRetirement: () => undefined,
    } as unknown as AcpSessionBridge;
    const openListed = await runWithWorkspaceRuntimeStorage(
      target.runtime,
      () =>
        listWorkspaceSessionsForResponse(
          openBridge,
          target.repo,
          { size: 20 },
          {
            mergeLive: false,
            runtimeBaseDir: target.runtime.sessionRuntimeBaseDir,
          },
        ),
    );
    expect(
      openListed.sessions.find((s) => s.sessionId === record.id)?.worktree
        ?.canRestore,
    ).toBe(true);

    // Bridge answers ONLY the normalized lowercase key, never the raw uppercase key.
    const lowercaseOnlyBridge = {
      listSessions: () => [],
      getSessionRetirement: (candidateId: string) =>
        candidateId === upperId.toLowerCase()
          ? {
              sessionId: upperId.toLowerCase(),
              operationId: 'op-upper-fenced',
              eventEpoch: 'epoch-1',
              state: 'retired',
            }
          : undefined,
    } as unknown as AcpSessionBridge;
    const fencedListed = await runWithWorkspaceRuntimeStorage(
      target.runtime,
      () =>
        listWorkspaceSessionsForResponse(
          lowercaseOnlyBridge,
          target.repo,
          { size: 20 },
          {
            mergeLive: false,
            runtimeBaseDir: target.runtime.sessionRuntimeBaseDir,
          },
        ),
    );
    expect(
      fencedListed.sessions.find((s) => s.sessionId === record.id)?.worktree
        ?.canRestore,
    ).toBe(false);
  });

  it('rejects an interrupted unarchive twin in list preview when snapshot metadata slug does not match', async () => {
    const target = makeRetentionRepo(root, 'primary');
    const record = await removedRecord(target, {
      slug: 'expected-twin-slug',
    });
    const activeDir = path.dirname(record.sidecarPath);
    const archivedDir = path.dirname(
      target.service.getWorktreeSessionPathForArchiveState(
        record.id,
        'archived',
      ),
    );
    fs.mkdirSync(archivedDir, { recursive: true });
    const metaName = `${record.archiveKey.slice(0, -'.tar.gz'.length)}.json`;
    const activeMetaPath = path.join(activeDir, metaName);
    const parsedMeta = JSON.parse(fs.readFileSync(activeMetaPath, 'utf8'));
    fs.writeFileSync(
      activeMetaPath,
      JSON.stringify({ ...parsedMeta, slug: 'mismatched-twin-slug' }),
    );
    fs.linkSync(
      path.join(activeDir, record.archiveKey),
      path.join(archivedDir, record.archiveKey),
    );
    fs.linkSync(activeMetaPath, path.join(archivedDir, metaName));

    const openBridge = {
      listSessions: () => [],
      getSessionRetirement: () => undefined,
    } as unknown as AcpSessionBridge;
    const listed = await runWithWorkspaceRuntimeStorage(target.runtime, () =>
      listWorkspaceSessionsForResponse(
        openBridge,
        target.repo,
        { size: 20 },
        {
          mergeLive: false,
          runtimeBaseDir: target.runtime.sessionRuntimeBaseDir,
        },
      ),
    );
    expect(
      listed.sessions.find((s) => s.sessionId === record.id)?.worktree
        ?.canRestore,
    ).toBe(false);
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

  it('does not advertise canRestore for archived sessions or mismatched coordinates', async () => {
    const target = makeRetentionRepo(root, 'primary');
    const record = await removedRecord(target);

    // Mismatched managed coordinates with an existing binding must not be restorable.
    await writeWorktreeSession(record.sidecarPath, {
      ...record.sidecar,
      worktreePath: path.join(
        path.dirname(record.worktreePath),
        'different-slug-dir',
      ),
      worktreeRemoved: { archiveKey: record.archiveKey },
    });
    const mismatchedMap = summaries(target, record.id);
    await enrichWorktreeSidecars(mismatchedMap, target.service, 'active');
    expect(mismatchedMap.get(record.id)!.worktree?.canRestore).toBe(false);

    // Archived sessions require unarchiving before restoration.
    await writeWorktreeSession(record.sidecarPath, {
      ...record.sidecar,
      worktreeRemoved: { archiveKey: record.archiveKey },
    });
    const archivedSidecar =
      target.service.getWorktreeSessionPathForArchiveState(
        record.id,
        'archived',
      );
    fs.mkdirSync(path.dirname(archivedSidecar), { recursive: true });
    fs.renameSync(record.sidecarPath, archivedSidecar);
    for (const file of fs.readdirSync(path.dirname(record.sidecarPath))) {
      if (
        file.startsWith(`${record.id}.`) &&
        file.includes('.worktree-snapshot.')
      ) {
        fs.renameSync(
          path.join(path.dirname(record.sidecarPath), file),
          path.join(path.dirname(archivedSidecar), file),
        );
      }
    }
    const archivedMap = summaries(target, record.id);
    await enrichWorktreeSidecars(archivedMap, target.service, 'archived');
    expect(archivedMap.get(record.id)!.worktree?.worktreeRemoved).toEqual({
      archiveKey: record.archiveKey,
    });
    expect(archivedMap.get(record.id)!.worktree?.canRestore).toBe(false);
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
