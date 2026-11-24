/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SessionOrganizationService,
  GROUP_COLOR_OPTIONS,
} from '@qwen-code/qwen-code-core/services/session-organization-service.js';
import { Storage } from '@qwen-code/qwen-code-core/config/storage.js';
import { SESSION_TRANSCRIPT_MAX_INDEX_BYTES } from '@qwen-code/qwen-code-core/services/session-transcript-reader.js';
import { SessionService } from '@qwen-code/qwen-code-core/services/sessionService.js';
import { createWorktreeSessionMarkerExclusive } from '@qwen-code/qwen-code-core/services/gitWorktreeService.js';
import { writeWorktreeSession } from '@qwen-code/qwen-code-core/services/worktreeSessionService.js';
import type {
  AcpSessionBridge,
  BridgeSessionSummary,
} from '../acp-session-bridge.js';
import {
  InvalidCursorError,
  listWorkspaceSessionsForResponse,
  searchWorkspaceSessionsForResponse,
} from './session-list.js';

// Mid-scan abort harness: the wrapper aborts the caller's signal as the
// second async sidecar read starts, deterministically landing the abort
// inside the enrichment loop (no timer race against fast local reads).
const abortHarness = vi.hoisted(() => ({
  controller: undefined as AbortController | undefined,
  reads: 0,
  beforeRead: undefined as (() => Promise<void>) | undefined,
}));

vi.mock(
  '@qwen-code/qwen-code-core/services/session-artifact-summary-sidecar.js',
  async (importOriginal) => {
    const mod =
      await importOriginal<
        typeof import('@qwen-code/qwen-code-core/services/session-artifact-summary-sidecar.js')
      >();
    return {
      ...mod,
      readSessionArtifactSummarySidecarAsync: async (
        filePath: string,
        options?: { signal?: AbortSignal },
      ) => {
        abortHarness.reads += 1;
        if (abortHarness.reads === 2) abortHarness.controller?.abort();
        await abortHarness.beforeRead?.();
        return mod.readSessionArtifactSummarySidecarAsync(filePath, options);
      },
    };
  },
);

describe('merged session catalog pagination', () => {
  let directory: string;
  let workspaceCwd: string;
  let runtimeBaseDir: string;

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'session-catalog-'));
    workspaceCwd = path.join(directory, 'workspace');
    runtimeBaseDir = path.join(directory, 'runtime');
    await fs.mkdir(workspaceCwd);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    abortHarness.controller = undefined;
    abortHarness.beforeRead = undefined;
    await fs.rm(directory, { recursive: true, force: true });
  });

  function summary(index: number): BridgeSessionSummary {
    return {
      sessionId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      workspaceCwd,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
      clientCount: 1,
      hasActivePrompt: false,
    };
  }

  async function persist(
    session: BridgeSessionSummary,
    promptTime = session.createdAt,
    archived = false,
  ): Promise<void> {
    const chats = path.join(
      new Storage(workspaceCwd, runtimeBaseDir).getProjectDir(),
      'chats',
      ...(archived ? ['archive'] : []),
    );
    await fs.mkdir(chats, { recursive: true });
    const file = path.join(chats, `${session.sessionId}.jsonl`);
    await fs.writeFile(
      file,
      `${JSON.stringify({
        uuid: `${session.sessionId}-user`,
        parentUuid: null,
        sessionId: session.sessionId,
        timestamp: promptTime,
        type: 'user',
        message: { role: 'user', parts: [{ text: 'stored prompt' }] },
        cwd: workspaceCwd,
      })}\n`,
    );
    const time = new Date(session.createdAt);
    await fs.utimes(file, time, time);
  }

  function bridgeFor(sessions: BridgeSessionSummary[]) {
    const list = vi.fn(() => sessions);
    return {
      list,
      bridge: { listWorkspaceSessions: list } as unknown as AcpSessionBridge,
    };
  }

  it.each([undefined, 'organized'] as const)(
    'reads sidecars only for the selected page (%s)',
    async (view) => {
      const first = summary(2);
      const second = summary(1);
      const live = summary(0);
      await persist(first);
      await persist(second);
      const { bridge } = bridgeFor([live]);
      const options = { size: 1, ...(view ? { view } : {}) };
      const readOptions = { runtimeBaseDir, paginateMerged: true };
      const worktree = vi.spyOn(
        SessionService.prototype,
        'getWorktreeSessionPathForArchiveState',
      );
      const pr = vi.spyOn(
        SessionService.prototype,
        'getPrSessionPathForArchiveState',
      );
      const artifact = vi.spyOn(
        SessionService.prototype,
        'getArtifactSummaryPathForArchiveState',
      );
      const goal = vi.spyOn(
        SessionService.prototype,
        'getGoalSessionPathForArchiveState',
      );

      const firstPage = await listWorkspaceSessionsForResponse(
        bridge,
        workspaceCwd,
        options,
        readOptions,
      );
      expect(firstPage.sessions.map((row) => row.sessionId)).toEqual([
        first.sessionId,
      ]);
      for (const reader of [worktree, pr, artifact, goal]) {
        expect(reader.mock.calls).toEqual([[first.sessionId, 'active']]);
      }

      const secondPage = await listWorkspaceSessionsForResponse(
        bridge,
        workspaceCwd,
        { ...options, cursor: firstPage.nextCursor },
        readOptions,
      );
      const lastPage = await listWorkspaceSessionsForResponse(
        bridge,
        workspaceCwd,
        { ...options, cursor: secondPage.nextCursor },
        readOptions,
      );
      expect(secondPage.sessions.map((row) => row.sessionId)).toEqual([
        second.sessionId,
      ]);
      expect(lastPage.sessions.map((row) => row.sessionId)).toEqual([
        live.sessionId,
      ]);
      expect(lastPage.nextCursor).toBeUndefined();
      const persistedReads = [
        [first.sessionId, 'active'],
        [second.sessionId, 'active'],
      ];
      expect(worktree.mock.calls).toEqual([
        ...persistedReads,
        // Revalidate the selected current worktree on the cache-hit page.
        [second.sessionId, 'active'],
      ]);
      expect(artifact.mock.calls).toEqual(persistedReads);
      expect(goal.mock.calls).toEqual(persistedReads);
      expect(pr.mock.calls).toEqual([
        ...persistedReads,
        [live.sessionId, 'active'],
      ]);
    },
  );

  it.each([undefined, 'organized'] as const)(
    'sorts the complete set by question time before paging (%s)',
    async (view) => {
      for (let index = 0; index < 4; index++) await persist(summary(index));
      const { bridge } = bridgeFor([
        { ...summary(0), updatedAt: summary(20).createdAt },
      ]);
      const options = {
        size: 2,
        sortBy: 'lastUserPromptAt' as const,
        ...(view ? { view } : {}),
      };
      const first = await listWorkspaceSessionsForResponse(
        bridge,
        workspaceCwd,
        options,
        { runtimeBaseDir, paginateMerged: true },
      );
      expect(first.sessions.map((row) => row.sessionId)).toEqual([
        summary(3).sessionId,
        summary(2).sessionId,
      ]);
      const next = await listWorkspaceSessionsForResponse(
        bridge,
        workspaceCwd,
        { ...options, cursor: first.nextCursor },
        { runtimeBaseDir, paginateMerged: true },
      );
      expect(next.sessions.map((row) => row.sessionId)).toEqual([
        summary(1).sessionId,
        summary(0).sessionId,
      ]);
      await expect(
        listWorkspaceSessionsForResponse(
          bridge,
          workspaceCwd,
          {
            ...options,
            sortBy: 'updatedAt',
            cursor: first.nextCursor,
          },
          { runtimeBaseDir, paginateMerged: true },
        ),
      ).rejects.toThrow();
    },
  );

  it('sorts archived sessions by their archived question time, not activity', async () => {
    const sessions = [summary(0), summary(1), summary(2)];
    await persist(sessions[0]!, '2026-01-01T00:02:00.000Z', true);
    await persist(sessions[1]!, '2026-01-01T00:03:00.000Z', true);
    await persist(sessions[2]!, '2026-01-01T00:01:00.000Z', true);
    const { bridge } = bridgeFor([]);
    const page = await listWorkspaceSessionsForResponse(
      bridge,
      workspaceCwd,
      {
        size: 10,
        sortBy: 'lastUserPromptAt' as const,
        archiveState: 'archived' as const,
      },
      { runtimeBaseDir },
    );
    expect(page.sessions.map((row) => row.sessionId)).toEqual([
      sessions[1]!.sessionId,
      sessions[0]!.sessionId,
      sessions[2]!.sessionId,
    ]);
    expect(page.sessions.map((row) => row.lastUserPromptAt)).toEqual([
      '2026-01-01T00:03:00.000Z',
      '2026-01-01T00:02:00.000Z',
      '2026-01-01T00:01:00.000Z',
    ]);
  });

  it('places unknown question times last with stable ties and preserves organized pins', async () => {
    const { bridge } = bridgeFor([summary(0), summary(1), summary(2)]);
    vi.spyOn(
      SessionService.prototype,
      'getLastUserPromptAt',
    ).mockImplementation(async (id) =>
      id === summary(0).sessionId ? undefined : summary(1).createdAt,
    );
    const options = { size: 10, sortBy: 'lastUserPromptAt' as const };
    const page = await listWorkspaceSessionsForResponse(
      bridge,
      workspaceCwd,
      options,
      { runtimeBaseDir },
    );
    expect(page.sessions.map((row) => row.sessionId)).toEqual([
      summary(1).sessionId,
      summary(2).sessionId,
      summary(0).sessionId,
    ]);
    await Storage.runWithResolvedRuntimeBaseDir(runtimeBaseDir, () =>
      new SessionOrganizationService(workspaceCwd).updateSessionOrganization(
        summary(0).sessionId,
        { isPinned: true },
      ),
    );
    const pinned = await listWorkspaceSessionsForResponse(
      bridge,
      workspaceCwd,
      { ...options, view: 'organized' },
      { runtimeBaseDir },
    );
    expect(pinned.sessions[0]?.sessionId).toBe(summary(0).sessionId);
  });

  it('enriches only returned rows with the recorded user time, independent of live activity', async () => {
    await persist(summary(0));
    await persist(summary(1));
    const { bridge } = bridgeFor([
      { ...summary(0), updatedAt: summary(10).createdAt },
    ]);
    const read = vi.spyOn(SessionService.prototype, 'getLastUserPromptAt');
    const page = await listWorkspaceSessionsForResponse(
      bridge,
      workspaceCwd,
      { size: 1 },
      { runtimeBaseDir, paginateMerged: true },
    );
    expect(page.sessions).toHaveLength(1);
    expect(page.sessions[0]?.sessionId).toBe(summary(0).sessionId);
    expect(page.sessions[0]?.lastUserPromptAt).toBe(summary(0).createdAt);
    expect(page.sessions[0]?.updatedAt).toBe(summary(10).createdAt);
    expect(read.mock.calls).toEqual([[summary(0).sessionId, 'active']]);
  });

  it('rejects a cross-sort cursor before reading any transcript', async () => {
    const { bridge } = bridgeFor([summary(0), summary(1), summary(2)]);
    const first = await listWorkspaceSessionsForResponse(
      bridge,
      workspaceCwd,
      { size: 1 },
      { runtimeBaseDir, paginateMerged: true },
    );
    expect(first.nextCursor).toBeDefined();
    const read = vi.spyOn(SessionService.prototype, 'getLastUserPromptAt');
    await expect(
      listWorkspaceSessionsForResponse(
        bridge,
        workspaceCwd,
        { size: 1, sortBy: 'lastUserPromptAt', cursor: first.nextCursor },
        { runtimeBaseDir, paginateMerged: true },
      ),
    ).rejects.toThrow(InvalidCursorError);
    expect(read).not.toHaveBeenCalled();
  });

  it('keeps the whole page when one transcript cannot be read', async () => {
    const { bridge } = bridgeFor([summary(0), summary(1)]);
    vi.spyOn(
      SessionService.prototype,
      'getLastUserPromptAt',
    ).mockImplementation(async (id) => {
      if (id === summary(0).sessionId)
        throw new Error('transcript replaced during read');
      return summary(1).createdAt;
    });
    const page = await listWorkspaceSessionsForResponse(
      bridge,
      workspaceCwd,
      { size: 2 },
      { runtimeBaseDir, paginateMerged: true },
    );
    expect(page.sessions.map((row) => row.sessionId).sort()).toEqual([
      summary(0).sessionId,
      summary(1).sessionId,
    ]);
    const rows = new Map(
      page.sessions.map((row) => [row.sessionId, row.lastUserPromptAt]),
    );
    expect(rows.get(summary(0).sessionId)).toBeUndefined();
    expect(rows.get(summary(1).sessionId)).toBe(summary(1).createdAt);
  });

  it('keeps an oversized historical row visible without inventing its question time', async () => {
    const item = summary(0);
    await persist(item);
    const file = path.join(
      new Storage(workspaceCwd, runtimeBaseDir).getProjectDir(),
      'chats',
      `${item.sessionId}.jsonl`,
    );
    const assistants = Array.from(
      { length: 12 },
      (_, index) =>
        JSON.stringify({
          uuid: `assistant-${index}`,
          parentUuid: index
            ? `assistant-${index - 1}`
            : `${item.sessionId}-user`,
          sessionId: item.sessionId,
          timestamp: item.createdAt,
          type: 'assistant',
          message: { role: 'model', parts: [{ text: 'output' }] },
          cwd: workspaceCwd,
        }) + '\n',
    ).join('');
    await fs.appendFile(file, assistants);
    await fs.truncate(file, SESSION_TRANSCRIPT_MAX_INDEX_BYTES + 1);
    const { bridge } = bridgeFor([]);
    const page = await listWorkspaceSessionsForResponse(
      bridge,
      workspaceCwd,
      { size: 1 },
      { runtimeBaseDir, paginateMerged: true },
    );
    expect(page.sessions.map((row) => row.sessionId)).toEqual([item.sessionId]);
    expect(page.sessions[0]?.lastUserPromptAt).toBeUndefined();
  });

  it('bounds timestamp reads to two and aborts the waiter without starting later rows', async () => {
    const { bridge } = bridgeFor([
      summary(1),
      summary(2),
      summary(3),
      summary(4),
    ]);
    const pending: Array<(value: string | undefined) => void> = [];
    const read = vi
      .spyOn(SessionService.prototype, 'getLastUserPromptAt')
      .mockImplementation(
        () => new Promise((resolve) => pending.push(resolve)),
      );
    const controller = new AbortController();
    const request = listWorkspaceSessionsForResponse(
      bridge,
      workspaceCwd,
      { size: 4 },
      { runtimeBaseDir, paginateMerged: true, signal: controller.signal },
    );
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    const reason = new Error('test stopped');
    controller.abort(reason);
    await expect(request).rejects.toBe(reason);
    pending.forEach((resolve) => resolve(undefined));
    await Promise.resolve();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('paginates persisted and live-only rows without dropping or duplicating merged rows', async () => {
    await persist(summary(0));
    await persist(summary(2));
    const live = [1, 2, 3, 4, 5].map(summary);
    live[1] = { ...live[1]!, updatedAt: summary(6).createdAt };
    const { bridge } = bridgeFor(live);
    const readOptions = { runtimeBaseDir, paginateMerged: true };

    const first = await listWorkspaceSessionsForResponse(
      bridge,
      workspaceCwd,
      { size: 2 },
      readOptions,
    );
    expect(first.sessions.map((session) => session.sessionId)).toEqual(
      [2, 5].map((index) => summary(index).sessionId),
    );
    expect(first.sessions[0]?.clientCount).toBe(1);
    expect(first.nextCursor).toEqual(expect.any(String));

    const second = await listWorkspaceSessionsForResponse(
      bridge,
      workspaceCwd,
      { size: 2, cursor: first.nextCursor },
      readOptions,
    );
    expect(second.sessions.map((session) => session.sessionId)).toEqual(
      [4, 3].map((index) => summary(index).sessionId),
    );
    expect(second.nextCursor).toEqual(expect.any(String));

    const last = await listWorkspaceSessionsForResponse(
      bridge,
      workspaceCwd,
      { size: 2, cursor: second.nextCursor },
      readOptions,
    );
    expect(last.sessions.map((session) => session.sessionId)).toEqual(
      [1, 0].map((index) => summary(index).sessionId),
    );
    expect(last.nextCursor).toBeUndefined();
  });

  it.each([
    { options: undefined, expectedSize: 20 },
    { options: { size: 1_000 }, expectedSize: 100 },
  ])(
    'bounds live-only pages to $expectedSize rows',
    async ({ options, expectedSize }) => {
      const { bridge } = bridgeFor(
        Array.from({ length: 101 }, (_, i) => summary(i)),
      );

      const result = await listWorkspaceSessionsForResponse(
        bridge,
        workspaceCwd,
        options,
        { runtimeBaseDir, paginateMerged: true },
      );

      expect(result.sessions).toHaveLength(expectedSize);
      expect(result.nextCursor).toEqual(expect.any(String));
    },
  );

  it('continues live-only organized pages when merged pagination is enabled', async () => {
    const { bridge } = bridgeFor([summary(0), summary(1), summary(2)]);
    const options = { size: 1, view: 'organized' as const, group: 'all' };
    const readOptions = { runtimeBaseDir, paginateMerged: true };
    const seen: string[] = [];
    let cursor: string | undefined;

    for (let page = 0; page < 3; page++) {
      const result = await listWorkspaceSessionsForResponse(
        bridge,
        workspaceCwd,
        { ...options, cursor },
        readOptions,
      );
      expect(result.sessions).toHaveLength(1);
      seen.push(result.sessions[0]!.sessionId);
      cursor = result.nextCursor;
      if (page < 2) expect(cursor).toEqual(expect.any(String));
    }

    expect(seen).toEqual([2, 1, 0].map((index) => summary(index).sessionId));
    expect(cursor).toBeUndefined();
  });

  it('keeps legacy organized live-only rows on the first page only', async () => {
    const { bridge } = bridgeFor([summary(0), summary(1), summary(2)]);
    const options = { size: 1, view: 'organized' as const, group: 'all' };
    const first = await listWorkspaceSessionsForResponse(
      bridge,
      workspaceCwd,
      options,
      { runtimeBaseDir },
    );
    expect(first.sessions.map((row) => row.sessionId)).toEqual([
      summary(2).sessionId,
    ]);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await listWorkspaceSessionsForResponse(
      bridge,
      workspaceCwd,
      { ...options, cursor: first.nextCursor },
      { runtimeBaseDir },
    );
    expect(second.sessions).toEqual([]);
    expect(second.nextCursor).toBeUndefined();
  });

  it('keeps a live-only row reachable on later organized pages under question sort', async () => {
    for (let index = 0; index < 4; index++) await persist(summary(index));
    const { bridge } = bridgeFor([
      { ...summary(9), updatedAt: summary(20).createdAt },
    ]);
    const options = {
      size: 2,
      view: 'organized' as const,
      group: 'all',
      sortBy: 'lastUserPromptAt' as const,
    };
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 3; page++) {
      const result = await listWorkspaceSessionsForResponse(
        bridge,
        workspaceCwd,
        { ...options, cursor },
        { runtimeBaseDir },
      );
      seen.push(...result.sessions.map((row) => row.sessionId));
      cursor = result.nextCursor;
      if (cursor === undefined) break;
    }
    expect(seen).toEqual(
      [3, 2, 1, 0, 9].map((index) => summary(index).sessionId),
    );
  });

  it('binds a metadata page cursor to the question ordering', async () => {
    // Prompt order (0,1,2,3) is the reverse of the file mtimes (3,2,1,0), so
    // a cursor keyed by activity time sends page 2 back to page 1.
    for (let index = 0; index < 4; index++) {
      await persist(
        summary(index),
        new Date(Date.UTC(2026, 0, 1, 0, 9 - index)).toISOString(),
      );
    }
    const { bridge } = bridgeFor([]);
    const options = { size: 2, sortBy: 'lastUserPromptAt' as const };
    const first = await listWorkspaceSessionsForResponse(
      bridge,
      workspaceCwd,
      options,
      { runtimeBaseDir },
    );
    expect(first.sessions.map((row) => row.sessionId)).toEqual([
      summary(0).sessionId,
      summary(1).sessionId,
    ]);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await listWorkspaceSessionsForResponse(
      bridge,
      workspaceCwd,
      { ...options, cursor: first.nextCursor },
      { runtimeBaseDir },
    );
    expect(second.sessions.map((row) => row.sessionId)).toEqual([
      summary(2).sessionId,
      summary(3).sessionId,
    ]);
  });

  it('rejects an unfiltered legacy cursor as a metadata cursor', async () => {
    const { bridge } = bridgeFor([]);
    await expect(
      listWorkspaceSessionsForResponse(
        bridge,
        workspaceCwd,
        { cursor: '40' },
        { runtimeBaseDir, paginateMerged: true },
      ),
    ).rejects.toThrow('not a valid metadata cursor');
  });

  it('rejects an organized cursor when switching to activity ordering', async () => {
    await Promise.all([0, 1, 2].map((index) => persist(summary(index))));
    vi.spyOn(
      SessionOrganizationService.prototype,
      'readSnapshot',
    ).mockResolvedValue({
      groups: [],
      sessions: new Map([
        [
          summary(0).sessionId,
          {
            groupId: null,
            color: null,
            isPinned: true,
            updatedAt: summary(0).createdAt,
          },
        ],
      ]),
    });
    const { bridge } = bridgeFor([]);
    const readOptions = { runtimeBaseDir, paginateMerged: true };
    const first = await listWorkspaceSessionsForResponse(
      bridge,
      workspaceCwd,
      { size: 1, view: 'organized' },
      readOptions,
    );
    expect(first.sessions.map((row) => row.sessionId)).toEqual([
      summary(0).sessionId,
    ]);
    expect(first.nextCursor).toEqual(expect.any(String));
    await expect(
      listWorkspaceSessionsForResponse(
        bridge,
        workspaceCwd,
        { size: 1, cursor: first.nextCursor },
        readOptions,
      ),
    ).rejects.toThrow('not a valid metadata cursor');
  });

  describe.each(['organized', 'metadata'] as const)(
    '%s cursor context',
    (kind) => {
      it.each([true, false])(
        'rejects a change from paginateMerged=%s',
        async (paginateMerged) => {
          const { bridge } = bridgeFor([summary(0), summary(1), summary(2)]);
          const options =
            kind === 'organized'
              ? { size: 1, view: 'organized' as const }
              : { size: 1, sourceType: 'default' };
          const first = await listWorkspaceSessionsForResponse(
            bridge,
            workspaceCwd,
            options,
            { runtimeBaseDir, paginateMerged },
          );
          expect(first.nextCursor).toEqual(expect.any(String));
          await expect(
            listWorkspaceSessionsForResponse(
              bridge,
              workspaceCwd,
              { ...options, cursor: first.nextCursor },
              { runtimeBaseDir, paginateMerged: !paginateMerged },
            ),
          ).rejects.toThrow(`not a valid ${kind} cursor`);
        },
      );

      it('rejects a foreign family marker even when the cursor structure matches', async () => {
        const { bridge } = bridgeFor([summary(0), summary(1)]);
        const options =
          kind === 'organized'
            ? { size: 1, view: 'organized' as const }
            : { size: 1 };
        const readOptions = { runtimeBaseDir, paginateMerged: true };
        const first = await listWorkspaceSessionsForResponse(
          bridge,
          workspaceCwd,
          options,
          readOptions,
        );
        expect(first.nextCursor).toEqual(expect.any(String));
        const payload = JSON.parse(
          Buffer.from(first.nextCursor!, 'base64url').toString('utf8'),
        );
        payload.catalogKind = kind === 'organized' ? 'metadata' : 'organized';
        const cursor = Buffer.from(JSON.stringify(payload)).toString(
          'base64url',
        );
        await expect(
          listWorkspaceSessionsForResponse(
            bridge,
            workspaceCwd,
            { ...options, cursor },
            readOptions,
          ),
        ).rejects.toThrow(`not a valid ${kind} cursor`);
      });

      it.each([true, false])(
        'accepts marker-free pre-upgrade cursors with paginateMerged=%s',
        async (paginateMerged) => {
          await Promise.all([0, 1, 2].map((index) => persist(summary(index))));
          const { bridge } = bridgeFor([]);
          const options =
            kind === 'organized'
              ? { size: 1, view: 'organized' as const }
              : { size: 1, sourceType: 'default' };
          const readOptions = { runtimeBaseDir, paginateMerged };
          const first = await listWorkspaceSessionsForResponse(
            bridge,
            workspaceCwd,
            options,
            readOptions,
          );
          expect(first.nextCursor).toEqual(expect.any(String));
          const payload = JSON.parse(
            Buffer.from(first.nextCursor!, 'base64url').toString('utf8'),
          );
          delete payload.catalogKind;
          delete payload.paginateMerged;
          const cursor = Buffer.from(JSON.stringify(payload)).toString(
            'base64url',
          );
          const second = await listWorkspaceSessionsForResponse(
            bridge,
            workspaceCwd,
            { ...options, cursor },
            readOptions,
          );
          expect(second.sessions.map((row) => row.sessionId)).toEqual([
            summary(1).sessionId,
          ]);
          expect(second.nextCursor).toEqual(expect.any(String));
        },
      );
    },
  );

  it('returns groups from the same snapshot used to organize rows', async () => {
    await persist(summary(0));
    const { bridge } = bridgeFor([]);
    const groups = [
      {
        id: 'group-1',
        name: 'Group',
        color: 'blue' as const,
        order: 0,
        createdAt: summary(0).createdAt,
        updatedAt: summary(0).createdAt,
      },
    ];
    const snapshot = vi
      .spyOn(SessionOrganizationService.prototype, 'readSnapshot')
      .mockResolvedValue({
        groups,
        sessions: new Map([
          [
            summary(0).sessionId,
            {
              groupId: 'group-1',
              color: null,
              isPinned: false,
              updatedAt: summary(0).createdAt,
            },
          ],
        ]),
      });
    const result = await listWorkspaceSessionsForResponse(
      bridge,
      workspaceCwd,
      { view: 'organized' },
      { runtimeBaseDir, paginateMerged: true, includeGroups: true },
    );
    expect(snapshot).toHaveBeenCalledOnce();
    expect(result.sessions[0]?.groupId).toBe('group-1');
    expect(result.groups).toEqual({
      groups,
      colorOptions: [...GROUP_COLOR_OPTIONS],
    });
  });

  it('honors persisted-only reads without querying the live bridge', async () => {
    await persist(summary(0));
    await persist(summary(2));
    const { bridge, list } = bridgeFor([summary(3)]);

    const result = await listWorkspaceSessionsForResponse(
      bridge,
      workspaceCwd,
      { size: 1 },
      { runtimeBaseDir, paginateMerged: true, mergeLive: false },
    );

    expect(result.sessions.map((session) => session.sessionId)).toEqual([
      summary(2).sessionId,
    ]);
    expect(result.sessions[0]?.clientCount).toBe(0);
    expect(result.nextCursor).toEqual(expect.any(String));
    expect(list).not.toHaveBeenCalled();
  });

  it('preserves the legacy first-page live overlay unless explicitly enabled', async () => {
    await persist(summary(0));
    const { bridge } = bridgeFor([summary(1), summary(2)]);

    const result = await listWorkspaceSessionsForResponse(
      bridge,
      workspaceCwd,
      { size: 1 },
      { runtimeBaseDir },
    );

    expect(result.sessions.map((session) => session.sessionId)).toEqual(
      [2, 1, 0].map((index) => summary(index).sessionId),
    );
    expect(result.nextCursor).toBeUndefined();
  });

  describe('PR sidecar read failures (R2-3)', () => {
    async function writePrSidecar(
      session: BridgeSessionSummary,
      content: string,
    ): Promise<void> {
      const chats = path.join(
        new Storage(workspaceCwd, runtimeBaseDir).getProjectDir(),
        'chats',
      );
      await fs.mkdir(chats, { recursive: true });
      await fs.writeFile(
        path.join(chats, `${session.sessionId}.pr.json`),
        content,
      );
    }

    // Both corruption forms must read as UNKNOWN bindings: broken JSON and
    // a shape-check failure. A well-formed empty list is NOT corruption —
    // it is an authoritative clear and must keep reading as prs: [].
    it.each(['{not json', '{"prs":[{"number":1}]}'])(
      'leaves prs unset for a corrupt persisted PR sidecar instead of an authoritative clear: %s',
      async (content) => {
        const corrupt = summary(0);
        const cleared = summary(1);
        const unbound = summary(2);
        await Promise.all([
          persist(corrupt),
          persist(cleared),
          persist(unbound),
        ]);
        await writePrSidecar(corrupt, content);
        await writePrSidecar(cleared, JSON.stringify({ prs: [] }));
        const { bridge } = bridgeFor([]);

        const result = await listWorkspaceSessionsForResponse(
          bridge,
          workspaceCwd,
          {},
          { runtimeBaseDir },
        );

        const byId = new Map(
          result.sessions.map((session) => [session.sessionId, session]),
        );
        // A corrupt sidecar must not emit an authoritative tombstone
        // (prs: []): that would read as an unbind — nor drop the row.
        expect(byId.has(corrupt.sessionId)).toBe(true);
        expect(byId.get(corrupt.sessionId)?.prs).toBeUndefined();
        expect(byId.get(cleared.sessionId)?.prs).toEqual([]);
        expect(byId.get(unbound.sessionId)?.prs).toBeUndefined();
      },
    );

    it.each(['{not json', '{"prs":[{"number":1}]}'])(
      'leaves prs unset for a corrupt PR sidecar on a live-only session: %s',
      async (content) => {
        const live = summary(7);
        await writePrSidecar(live, content);
        const { bridge } = bridgeFor([live]);

        const result = await listWorkspaceSessionsForResponse(
          bridge,
          workspaceCwd,
          {},
          { runtimeBaseDir },
        );

        expect(result.sessions).toHaveLength(1);
        expect(result.sessions[0]?.sessionId).toBe(live.sessionId);
        expect(result.sessions[0]?.prs).toBeUndefined();
      },
    );
  });

  describe('artifact summary sidecar enrichment', () => {
    async function writeArtifactSummarySidecar(
      session: BridgeSessionSummary,
      content: string,
      archived = false,
    ): Promise<void> {
      const chats = path.join(
        new Storage(workspaceCwd, runtimeBaseDir).getProjectDir(),
        'chats',
        ...(archived ? ['archive'] : []),
      );
      await fs.mkdir(chats, { recursive: true });
      await fs.writeFile(
        path.join(chats, `${session.sessionId}.artifacts.json`),
        content,
      );
    }

    const sidecarBody = (artifactCount: number) =>
      JSON.stringify({
        version: 1,
        artifactCount,
        updatedAt: '2026-11-17T00:00:00.000Z',
      });

    it.each([undefined, 'organized'] as const)(
      'preserves sidecar values and live precedence across deferred pages (%s)',
      async (view) => {
        const sessions = [summary(2), summary(1)];
        for (const session of sessions) {
          await persist(session);
          await writeArtifactSummarySidecar(session, sidecarBody(99));
        }
        const { bridge } = bridgeFor(
          sessions.map((session) => ({ ...session, artifactCount: 3 })),
        );
        const options = { size: 1, ...(view ? { view } : {}) };
        const readOptions = { runtimeBaseDir, paginateMerged: true };
        const first = await listWorkspaceSessionsForResponse(
          bridge,
          workspaceCwd,
          options,
          readOptions,
        );
        expect(first.sessions).toEqual([
          expect.objectContaining({
            sessionId: sessions[0]!.sessionId,
            artifactCount: 3,
          }),
        ]);
        expect(first.nextCursor).toEqual(expect.any(String));
        const second = await listWorkspaceSessionsForResponse(
          bridge,
          workspaceCwd,
          { ...options, cursor: first.nextCursor },
          readOptions,
        );
        expect(second.sessions).toEqual([
          expect.objectContaining({
            sessionId: sessions[1]!.sessionId,
            artifactCount: 3,
          }),
        ]);
        expect(second.nextCursor).toBeUndefined();
      },
    );

    it.each([undefined, 'organized'] as const)(
      'reads all deferred sidecar values from the archive directory (%s)',
      async (view) => {
        const archived = summary(0);
        await persist(archived, archived.createdAt, true);
        await writeArtifactSummarySidecar(archived, sidecarBody(5), true);
        const chats = path.join(
          new Storage(workspaceCwd, runtimeBaseDir).getProjectDir(),
          'chats',
          'archive',
        );
        const worktreePath = path.join(directory, 'archived-worktree');
        await fs.mkdir(worktreePath);
        await createWorktreeSessionMarkerExclusive(
          worktreePath,
          archived.sessionId,
        );
        await writeWorktreeSession(
          path.join(chats, `${archived.sessionId}.worktree.json`),
          {
            slug: 'archived-worktree',
            worktreePath,
            worktreeBranch: 'topic',
            originalCwd: workspaceCwd,
            workspaceCwd,
            originalBranch: 'main',
            originalHeadCommit: 'source-sha',
            worktreeBase: 'base-sha',
          },
        );
        const pr = {
          number: 17738,
          url: 'https://github.com/QwenLM/qwen-code/pull/17738',
          createdAt: archived.createdAt,
          state: 'merged',
        };
        await fs.writeFile(
          path.join(chats, `${archived.sessionId}.pr.json`),
          JSON.stringify({ prs: [pr] }),
        );
        const { bridge } = bridgeFor([]);
        const result = await listWorkspaceSessionsForResponse(
          bridge,
          workspaceCwd,
          { archiveState: 'archived', ...(view ? { view } : {}) },
          { runtimeBaseDir, paginateMerged: true },
        );
        expect(result.sessions).toEqual([
          expect.objectContaining({
            sessionId: archived.sessionId,
            artifactCount: 5,
            worktree: {
              slug: 'archived-worktree',
              path: worktreePath,
              branch: 'topic',
              baseCommit: 'base-sha',
              baseBranch: 'main',
            },
            prs: [
              expect.objectContaining({
                number: pr.number,
                url: pr.url,
                state: 'merged',
              }),
            ],
          }),
        ]);
      },
    );

    it.each([undefined, 'organized'] as const)(
      'isolates cancellation while sharing a deferred sidecar read (%s)',
      async (view) => {
        const session = summary(0);
        await persist(session);
        await writeArtifactSummarySidecar(session, sidecarBody(7));
        const { bridge, list } = bridgeFor([]);
        function deferred() {
          let resolve!: () => void;
          const promise = new Promise<void>((done) => {
            resolve = done;
          });
          return { promise, resolve };
        }
        const started = deferred();
        const release = deferred();
        const joined = deferred();
        const controller = new AbortController();
        const healthyController = new AbortController();
        const addListener = healthyController.signal.addEventListener.bind(
          healthyController.signal,
        );
        vi.spyOn(
          healthyController.signal,
          'addEventListener',
        ).mockImplementation((...args) => {
          addListener(...args);
          // The first request is already blocked in enrichment. After the
          // second live overlay, its next abort listener belongs to the
          // shared sidecar wait, rather than the earlier catalog scan.
          if (args[0] === 'abort' && list.mock.calls.length === 2)
            joined.resolve();
        });
        abortHarness.reads = 0;
        abortHarness.beforeRead = async () => {
          started.resolve();
          await release.promise;
        };
        const options = { size: 1, ...(view ? { view } : {}) };
        const readOptions = { runtimeBaseDir, paginateMerged: true };
        const cancelled = listWorkspaceSessionsForResponse(
          bridge,
          workspaceCwd,
          options,
          { ...readOptions, signal: controller.signal },
        );
        const cancelledOutcome = cancelled.then(
          () => {
            throw new Error('Expected the cancelled request to reject');
          },
          (error: unknown) => error,
        );
        await started.promise;
        const healthy = listWorkspaceSessionsForResponse(
          bridge,
          workspaceCwd,
          options,
          { ...readOptions, signal: healthyController.signal },
        );
        try {
          await joined.promise;
          controller.abort();
          expect(await cancelledOutcome).toMatchObject({ name: 'AbortError' });
        } finally {
          release.resolve();
        }
        expect((await healthy).sessions[0]?.artifactCount).toBe(7);
        expect(abortHarness.reads).toBe(1);
      },
    );

    it('enriches a cold session with the restorable count from the sidecar', async () => {
      const cold = summary(0);
      await persist(cold);
      await writeArtifactSummarySidecar(cold, sidecarBody(3));
      const { bridge } = bridgeFor([]);

      const result = await listWorkspaceSessionsForResponse(
        bridge,
        workspaceCwd,
        {},
        { runtimeBaseDir },
      );

      expect(result.sessions[0]?.artifactCount).toBe(3);
    });

    it.each(['missing', '{not json', '{"version":1,"artifactCount":-1}'])(
      'leaves artifactCount unset for a missing or corrupt sidecar: %s',
      async (content) => {
        const cold = summary(0);
        await persist(cold);
        if (content !== 'missing') {
          await writeArtifactSummarySidecar(cold, content);
        }
        const { bridge } = bridgeFor([]);

        const result = await listWorkspaceSessionsForResponse(
          bridge,
          workspaceCwd,
          {},
          { runtimeBaseDir },
        );

        expect(result.sessions[0]?.artifactCount).toBeUndefined();
      },
    );

    it('keeps the list page resolving when a sidecar read throws (EISDIR)', async () => {
      const cold = summary(0);
      const healthy = summary(1);
      await persist(cold);
      await persist(healthy);
      const chats = path.join(
        new Storage(workspaceCwd, runtimeBaseDir).getProjectDir(),
        'chats',
      );
      // A directory at the sidecar path makes the async reader throw
      // EISDIR (not ENOENT); the enricher's catch must contain it so one
      // unreadable sidecar cannot reject the whole page.
      await fs.mkdir(path.join(chats, `${cold.sessionId}.artifacts.json`), {
        recursive: true,
      });
      await writeArtifactSummarySidecar(healthy, sidecarBody(4));
      const { bridge } = bridgeFor([]);

      const result = await listWorkspaceSessionsForResponse(
        bridge,
        workspaceCwd,
        { view: 'organized' },
        { runtimeBaseDir },
      );

      const byId = new Map(
        result.sessions.map((session) => [session.sessionId, session]),
      );
      expect(byId.get(cold.sessionId)?.artifactCount).toBeUndefined();
      expect(byId.get(healthy.sessionId)?.artifactCount).toBe(4);
    });

    it('lets the live count supersede a stale sidecar count', async () => {
      const session = summary(0);
      await persist(session);
      await writeArtifactSummarySidecar(session, sidecarBody(99));
      const { bridge } = bridgeFor([{ ...session, artifactCount: 3 }]);

      const result = await listWorkspaceSessionsForResponse(
        bridge,
        workspaceCwd,
        {},
        { runtimeBaseDir },
      );

      expect(result.sessions[0]?.artifactCount).toBe(3);
    });

    it('drops the stale sidecar count when the live entry reports none', async () => {
      const session = summary(0);
      await persist(session);
      await writeArtifactSummarySidecar(session, sidecarBody(99));
      // A live entry without artifactCount has zero artifacts; the sidecar's
      // 99 must not survive the merge.
      const { bridge } = bridgeFor([session]);

      const result = await listWorkspaceSessionsForResponse(
        bridge,
        workspaceCwd,
        {},
        { runtimeBaseDir },
      );

      expect(result.sessions[0]?.artifactCount).toBeUndefined();
    });

    it('keeps the sidecar count while the live entry marks its restore pending', async () => {
      const session = summary(0);
      await persist(session);
      await writeArtifactSummarySidecar(session, sidecarBody(3));
      // A restoring entry is live but not hydrated: the omitted count is
      // unknown, not zero, so the sidecar-enriched count must survive.
      const { bridge } = bridgeFor([
        { ...session, artifactCountPending: true },
      ]);

      const result = await listWorkspaceSessionsForResponse(
        bridge,
        workspaceCwd,
        {},
        { runtimeBaseDir },
      );

      expect(result.sessions[0]?.artifactCount).toBe(3);
    });

    it('enriches the organized view from the same sidecar', async () => {
      const cold = summary(0);
      await persist(cold);
      await writeArtifactSummarySidecar(cold, sidecarBody(2));
      const { bridge } = bridgeFor([]);

      const result = await listWorkspaceSessionsForResponse(
        bridge,
        workspaceCwd,
        { view: 'organized' },
        { runtimeBaseDir },
      );

      expect(result.sessions[0]?.artifactCount).toBe(2);
    });

    it('enriches archived sessions from the archive chats dir', async () => {
      const archived = summary(0);
      await persist(archived, archived.createdAt, true);
      await writeArtifactSummarySidecar(archived, sidecarBody(5), true);
      const { bridge } = bridgeFor([]);

      const result = await listWorkspaceSessionsForResponse(
        bridge,
        workspaceCwd,
        { archiveState: 'archived' },
        { runtimeBaseDir },
      );

      expect(result.sessions[0]?.artifactCount).toBe(5);
    });

    it('enriches search hits with the sidecar count', async () => {
      const cold = summary(0);
      await persist(cold);
      await writeArtifactSummarySidecar(cold, sidecarBody(3));

      const result = await searchWorkspaceSessionsForResponse(
        workspaceCwd,
        'stored prompt',
        {},
        { runtimeBaseDir },
      );

      const hit = result.results.find(
        (r) => r.session.sessionId === cold.sessionId,
      );
      expect(hit?.session.artifactCount).toBe(3);
    });

    it('rejects when the signal aborts during page enrichment', async () => {
      const first = summary(0);
      const second = summary(1);
      const third = summary(2);
      await persist(first);
      await persist(second);
      await persist(third);
      await writeArtifactSummarySidecar(first, sidecarBody(3));
      await writeArtifactSummarySidecar(second, sidecarBody(4));
      await writeArtifactSummarySidecar(third, sidecarBody(5));
      const { bridge } = bridgeFor([]);
      abortHarness.controller = new AbortController();
      abortHarness.reads = 0;

      await expect(
        listWorkspaceSessionsForResponse(
          bridge,
          workspaceCwd,
          { view: 'organized' },
          { runtimeBaseDir, signal: abortHarness.controller.signal },
        ),
      ).rejects.toMatchObject({ name: 'AbortError' });
      // The request stops at the interrupted row.
      expect(abortHarness.reads).toBe(2);

      // The first row's sidecars completed before cancellation. Keep that
      // result and read the interrupted and unvisited rows on retry.
      const retry = await listWorkspaceSessionsForResponse(
        bridge,
        workspaceCwd,
        { view: 'organized' },
        { runtimeBaseDir },
      );
      expect(abortHarness.reads).toBe(4);
      expect(
        retry.sessions.map((session) => session.artifactCount).sort(),
      ).toEqual([3, 4, 5]);
      abortHarness.controller = undefined;
    });
  });

  describe('goal sidecar projection', () => {
    async function writeGoalSidecar(
      session: BridgeSessionSummary,
      content: string,
      archived = false,
    ): Promise<void> {
      const chats = path.join(
        new Storage(workspaceCwd, runtimeBaseDir).getProjectDir(),
        'chats',
        ...(archived ? ['archive'] : []),
      );
      await fs.mkdir(chats, { recursive: true });
      await fs.writeFile(
        path.join(chats, `${session.sessionId}.goal.json`),
        content,
      );
    }

    const projection = {
      v: 1,
      goalId: 'goal-1',
      status: 'paused',
      objective: 'ship it',
      updatedAt: 1_700_000_000_000,
    };

    it('projects the goal sidecar onto a persisted summary', async () => {
      const session = summary(0);
      await persist(session);
      await writeGoalSidecar(session, JSON.stringify(projection));
      const { bridge } = bridgeFor([]);

      const result = await listWorkspaceSessionsForResponse(
        bridge,
        workspaceCwd,
        {},
        { runtimeBaseDir },
      );

      expect(result.sessions[0]?.goal).toEqual({
        status: 'paused',
        objective: 'ship it',
        updatedAt: new Date(1_700_000_000_000).toISOString(),
      });
    });

    it.each([undefined, 'organized'] as const)(
      'projects the goal sidecar of an archived session (%s)',
      async (view) => {
        const session = summary(0);
        await persist(session, session.createdAt, true);
        await writeGoalSidecar(session, JSON.stringify(projection), true);
        const { bridge } = bridgeFor([]);

        const result = await listWorkspaceSessionsForResponse(
          bridge,
          workspaceCwd,
          { archiveState: 'archived', view },
          { runtimeBaseDir },
        );

        expect(result.sessions[0]?.goal?.status).toBe('paused');
      },
    );

    it.each([undefined, 'organized'] as const)(
      'leaves goal unset for a corrupt or absent sidecar (%s)',
      async (view) => {
        const corrupt = summary(0);
        const invalid = summary(2);
        const absent = summary(1);
        await Promise.all([
          persist(corrupt),
          persist(invalid),
          persist(absent),
        ]);
        await writeGoalSidecar(corrupt, '{not json');
        await writeGoalSidecar(invalid, '{"v":1}');
        const { bridge } = bridgeFor([]);

        const result = await listWorkspaceSessionsForResponse(
          bridge,
          workspaceCwd,
          { view },
          { runtimeBaseDir },
        );

        expect(result.sessions).toHaveLength(3);
        for (const session of result.sessions) {
          expect(session.goal).toBeUndefined();
        }
      },
    );

    it('keeps the goal projection through the live overlay merge', async () => {
      // A goal-bearing session always has a transcript: the journal hook
      // appends the goal_state record before writing the sidecar, so the
      // persisted list (transcript-driven) always sees it. The live bridge
      // summary carries no goal field; the overlay must not drop the
      // sidecar projection enriched onto the persisted entry.
      const session = summary(0);
      await persist(session);
      await writeGoalSidecar(session, JSON.stringify(projection));
      const { bridge } = bridgeFor([
        { ...session, clientCount: 2, hasActivePrompt: true },
      ]);

      const result = await listWorkspaceSessionsForResponse(
        bridge,
        workspaceCwd,
        {},
        { runtimeBaseDir },
      );

      expect(result.sessions[0]?.goal?.objective).toBe('ship it');
      expect(result.sessions[0]?.clientCount).toBe(2);
    });

    it.each([undefined, 'organized'] as const)(
      'preserves persisted and live Goal precedence across deferred pages (%s)',
      async (view) => {
        const first = summary(1);
        const second = summary(0);
        for (const session of [first, second]) {
          await persist(session);
          await writeGoalSidecar(session, JSON.stringify(projection));
        }
        const persistedGoal = {
          status: 'paused',
          objective: 'ship it',
          updatedAt: new Date(projection.updatedAt).toISOString(),
        } as const;
        const liveGoal = {
          ...persistedGoal,
          status: 'active',
          objective: 'live goal',
        } as const;
        const { bridge } = bridgeFor([
          { ...first, goal: liveGoal },
          { ...second, clientCount: 2 },
        ]);
        const options = { size: 1, view };
        const readOptions = { runtimeBaseDir, paginateMerged: true };

        const firstPage = await listWorkspaceSessionsForResponse(
          bridge,
          workspaceCwd,
          options,
          readOptions,
        );
        expect(firstPage.sessions).toEqual([
          expect.objectContaining({
            sessionId: first.sessionId,
            goal: liveGoal,
          }),
        ]);
        expect(firstPage.nextCursor).toEqual(expect.any(String));

        const secondPage = await listWorkspaceSessionsForResponse(
          bridge,
          workspaceCwd,
          { ...options, cursor: firstPage.nextCursor },
          readOptions,
        );
        expect(secondPage.sessions).toEqual([
          expect.objectContaining({
            sessionId: second.sessionId,
            goal: persistedGoal,
            clientCount: 2,
          }),
        ]);
        expect(secondPage.nextCursor).toBeUndefined();
      },
    );

    it('projects the goal sidecar onto search results', async () => {
      const session = summary(0);
      await persist(session);
      await writeGoalSidecar(session, JSON.stringify(projection));

      const result = await searchWorkspaceSessionsForResponse(
        workspaceCwd,
        'stored',
        {},
        { runtimeBaseDir },
      );

      const hit = result.results.find(
        (item) => item.session.sessionId === session.sessionId,
      );
      expect(hit).toBeDefined();
      expect(hit?.session.goal).toEqual({
        status: 'paused',
        objective: 'ship it',
        updatedAt: new Date(1_700_000_000_000).toISOString(),
      });
    });
  });
  describe('prompt-ledger continuation enrichment', () => {
    const inFlight = { v: 1, promptId: 'p1', state: 'in_flight', at: 1 };
    const terminal = (
      value: string,
      extra: Record<string, unknown> = {},
    ): Record<string, unknown> => ({
      v: 1,
      promptId: 'p1',
      terminal: value,
      at: 2,
      ...extra,
    });

    async function writeLedger(
      session: BridgeSessionSummary,
      records: Array<Record<string, unknown>>,
      archived = false,
    ): Promise<void> {
      const chats = path.join(
        new Storage(workspaceCwd, runtimeBaseDir).getProjectDir(),
        'chats',
        ...(archived ? ['archive'] : []),
      );
      await fs.mkdir(chats, { recursive: true });
      await fs.writeFile(
        path.join(chats, `${session.sessionId}.ledger.jsonl`),
        records.map((record) => JSON.stringify(record)).join('\n') + '\n',
      );
    }

    async function listSessions(
      live: BridgeSessionSummary[] = [],
      options: Parameters<typeof listWorkspaceSessionsForResponse>[2] = {},
    ) {
      const { bridge } = bridgeFor(live);
      return listWorkspaceSessionsForResponse(bridge, workspaceCwd, options, {
        runtimeBaseDir,
      });
    }

    it.each([
      ['dangling admission', [inFlight]],
      ['reconciled interruption', [inFlight, terminal('interrupted')]],
      [
        'daemon shutdown flush',
        [inFlight, terminal('error', { code: 'daemon_shutdown' })],
      ],
      [
        'channel exit flush',
        [inFlight, terminal('error', { code: 'channel_closed' })],
      ],
      [
        'session close flush',
        [inFlight, terminal('error', { code: 'session_closed' })],
      ],
      [
        'session kill flush',
        [inFlight, terminal('error', { code: 'session_killed' })],
      ],
    ] as const)('flags a cut-off last record: %s', async (_label, records) => {
      const session = summary(0);
      await persist(session);
      await writeLedger(session, [...records]);
      const result = await listSessions();
      expect(result.sessions[0]?.needsContinuation).toBe(true);
    });

    it.each([
      ['completed', [inFlight, terminal('completed')]],
      ['cancelled', [inFlight, terminal('cancelled')]],
      ['model error', [inFlight, terminal('error', { code: 'model_error' })]],
      [
        'deadline exceeded',
        [inFlight, terminal('error', { code: 'prompt_deadline_exceeded' })],
      ],
      [
        'superseded interruption',
        [
          inFlight,
          terminal('interrupted'),
          { v: 1, promptId: 'p2', state: 'in_flight', at: 3 },
          { v: 1, promptId: 'p2', terminal: 'completed', at: 4 },
        ],
      ],
    ] as const)('leaves the field absent: %s', async (_label, records) => {
      const session = summary(0);
      await persist(session);
      await writeLedger(session, [...records]);
      const result = await listSessions();
      expect(result.sessions[0]?.needsContinuation).toBeUndefined();
    });

    it('leaves the field absent for an unreadable ledger', async () => {
      const session = summary(0);
      await persist(session);
      const chats = path.join(
        new Storage(workspaceCwd, runtimeBaseDir).getProjectDir(),
        'chats',
      );
      // A directory at the ledger path makes the read throw (EISDIR).
      await fs.mkdir(path.join(chats, `${session.sessionId}.ledger.jsonl`));
      const result = await listSessions();
      expect(result.sessions[0]?.needsContinuation).toBeUndefined();
    });

    it('does not enrich archived listings', async () => {
      const session = summary(0);
      await persist(session, session.createdAt, true);
      await writeLedger(session, [inFlight], true);
      const result = await listSessions([], { archiveState: 'archived' });
      expect(result.sessions[0]?.needsContinuation).toBeUndefined();
    });

    it.each([
      ['active prompt', { hasActivePrompt: true }],
      ['active work', { activeWorkState: 'active' as const }],
      ['running background tasks', { hasRunningBackgroundTasks: true }],
      [
        'background turn',
        {
          backgroundTurn: {
            turnId: 't1',
            taskId: 'task1',
            kind: 'shell' as const,
            startedAt: 1,
          },
        },
      ],
    ] as const)(
      'drops the persisted flag when live state shows %s',
      async (_label, liveExtra) => {
        const session = summary(0);
        await persist(session);
        await writeLedger(session, [inFlight]);
        const result = await listSessions([
          { ...session, clientCount: 1, ...liveExtra },
        ]);
        expect(result.sessions[0]?.needsContinuation).toBeUndefined();
      },
    );

    it('keeps the flag when the live session is idle', async () => {
      const session = summary(0);
      await persist(session);
      await writeLedger(session, [inFlight]);
      const result = await listSessions([
        { ...session, clientCount: 1, hasActivePrompt: false },
      ]);
      expect(result.sessions[0]?.needsContinuation).toBe(true);
    });

    it.each([
      ['organized', { view: 'organized' as const }],
      ['metadata-filtered', { sourceType: 'default' }],
    ] as const)('enriches the %s list path', async (_label, options) => {
      const session = summary(0);
      await persist(session);
      await writeLedger(session, [inFlight]);
      const result = await listSessions([], options);
      expect(result.sessions[0]?.needsContinuation).toBe(true);
    });
  });
});

describe('worktree sidecar enrichment (R3-1)', () => {
  let directory: string;
  let workspaceCwd: string;
  let runtimeBaseDir: string;

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'session-wt-enrich-'));
    workspaceCwd = path.join(directory, 'workspace');
    runtimeBaseDir = path.join(directory, 'runtime');
    await fs.mkdir(workspaceCwd);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('reads worktree.baseCommit from worktreeBase, not originalHeadCommit, for restart survivors', async () => {
    // enrichWorktreeSidecars is the sole producer of worktree meta for sessions
    // listed after a daemon restart. worktreeBase is the worktree's own base;
    // originalHeadCommit is the source checkout's HEAD (differs for a worktree
    // created from a sibling managed worktree). The precedence must prefer
    // worktreeBase, and baseBranch comes from originalBranch.
    const sessionId = '00000000-0000-4000-8000-000000000001';
    const chats = path.join(
      new Storage(workspaceCwd, runtimeBaseDir).getProjectDir(),
      'chats',
    );
    await fs.mkdir(chats, { recursive: true });
    await fs.writeFile(
      path.join(chats, `${sessionId}.jsonl`),
      `${JSON.stringify({
        uuid: `${sessionId}-user`,
        parentUuid: null,
        sessionId,
        timestamp: new Date(Date.UTC(2026, 0, 1)).toISOString(),
        type: 'user',
        message: { role: 'user', parts: [{ text: 'stored prompt' }] },
        cwd: workspaceCwd,
      })}\n`,
    );
    const worktreeDir = path.join(
      workspaceCwd,
      '.qwen',
      'worktrees',
      'my-task',
    );
    await fs.mkdir(worktreeDir, { recursive: true });
    await createWorktreeSessionMarkerExclusive(worktreeDir, sessionId);
    await writeWorktreeSession(path.join(chats, `${sessionId}.worktree.json`), {
      slug: 'my-task',
      worktreePath: worktreeDir,
      worktreeBranch: 'worktree-my-task',
      originalCwd: workspaceCwd,
      workspaceCwd,
      originalBranch: 'main',
      originalHeadCommit: 'source-sha',
      worktreeBase: 'base-sha',
    });
    const bridge = {
      listWorkspaceSessions: vi.fn(() => []),
    } as unknown as AcpSessionBridge;

    const result = await listWorkspaceSessionsForResponse(
      bridge,
      workspaceCwd,
      {},
      { runtimeBaseDir },
    );

    const row = result.sessions.find((s) => s.sessionId === sessionId);
    expect(row?.worktree).toMatchObject({
      baseCommit: 'base-sha',
      baseBranch: 'main',
    });
  });

  it('falls back to originalHeadCommit for a legacy sidecar with no worktreeBase', async () => {
    // Every released daemon writes originalHeadCommit (required) and no
    // worktreeBase (optional). The sibling above sets both, so it cannot see
    // the legacy fallback arm: dropping `|| sidecar.originalHeadCommit` from
    // the enrichment would leave it green. This sidecar omits worktreeBase
    // entirely, so baseCommit must come from originalHeadCommit.
    const sessionId = '00000000-0000-4000-8000-000000000002';
    const chats = path.join(
      new Storage(workspaceCwd, runtimeBaseDir).getProjectDir(),
      'chats',
    );
    await fs.mkdir(chats, { recursive: true });
    await fs.writeFile(
      path.join(chats, `${sessionId}.jsonl`),
      `${JSON.stringify({
        uuid: `${sessionId}-user`,
        parentUuid: null,
        sessionId,
        timestamp: new Date(Date.UTC(2026, 0, 1)).toISOString(),
        type: 'user',
        message: { role: 'user', parts: [{ text: 'stored prompt' }] },
        cwd: workspaceCwd,
      })}\n`,
    );
    const worktreeDir = path.join(
      workspaceCwd,
      '.qwen',
      'worktrees',
      'legacy-task',
    );
    await fs.mkdir(worktreeDir, { recursive: true });
    await createWorktreeSessionMarkerExclusive(worktreeDir, sessionId);
    await writeWorktreeSession(path.join(chats, `${sessionId}.worktree.json`), {
      slug: 'legacy-task',
      worktreePath: worktreeDir,
      worktreeBranch: 'worktree-legacy-task',
      originalCwd: workspaceCwd,
      workspaceCwd,
      originalBranch: 'main',
      originalHeadCommit: 'legacy-sha',
    });
    const bridge = {
      listWorkspaceSessions: vi.fn(() => []),
    } as unknown as AcpSessionBridge;

    const result = await listWorkspaceSessionsForResponse(
      bridge,
      workspaceCwd,
      {},
      { runtimeBaseDir },
    );

    const row = result.sessions.find((s) => s.sessionId === sessionId);
    expect(row?.worktree).toMatchObject({
      baseCommit: 'legacy-sha',
      baseBranch: 'main',
    });
  });
});
