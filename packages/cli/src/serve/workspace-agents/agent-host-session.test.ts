/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Storage } from '@qwen-code/qwen-code-core';
import type { AcpSessionBridge } from '../acp-session-bridge.js';
import {
  getWorkspaceSessionInfoForResponse,
  listLiveWorkspaceSessionsForResponse,
  listWorkspaceSessionsForResponse,
  searchWorkspaceSessionsForResponse,
} from '../server/session-list.js';

async function writeStoredSession(
  workspace: string,
  sessionId: string,
  sourceType: string,
  mtime: Date,
): Promise<void> {
  const chatsDir = path.join(new Storage(workspace).getProjectDir(), 'chats');
  await fs.mkdir(chatsDir, { recursive: true });
  const filePath = path.join(chatsDir, `${sessionId}.jsonl`);
  const records = [
    {
      uuid: `${sessionId}-user`,
      parentUuid: null,
      sessionId,
      timestamp: mtime.toISOString(),
      type: 'user',
      message: { role: 'user', parts: [{ text: sessionId }] },
      cwd: workspace,
    },
    {
      uuid: `${sessionId}-source`,
      parentUuid: `${sessionId}-user`,
      sessionId,
      timestamp: mtime.toISOString(),
      type: 'system',
      subtype: 'session_source',
      systemPayload: { sourceType },
      cwd: workspace,
    },
  ];
  await fs.writeFile(
    filePath,
    `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
  );
  await fs.utimes(filePath, mtime, mtime);
}

describe('agent host session owner', () => {
  let scratch: string;
  let workspace: string;

  beforeEach(async () => {
    scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-host-test-'));
    workspace = path.join(scratch, 'workspace');
    await fs.mkdir(workspace);
    Storage.setRuntimeBaseDir(scratch);
  });

  afterEach(async () => {
    Storage.setRuntimeBaseDir(null);
    await fs.rm(scratch, { recursive: true, force: true });
  });

  // Machine-owned sessions: the host, and each agent's task sessions.
  it.each(['agent-host', 'agent'])(
    'is excluded from the unfiltered session catalog (%s)',
    async (hiddenType) => {
      const bridge = {
        listWorkspaceSessions: () => [
          {
            sessionId: 'default-session',
            cwd: workspace,
            sourceType: 'default',
          },
          {
            sessionId: 'hidden-session',
            cwd: workspace,
            sourceType: hiddenType,
          },
        ],
      } as unknown as AcpSessionBridge;

      const result = await listWorkspaceSessionsForResponse(
        bridge,
        workspace,
        undefined,
        { runtimeBaseDir: scratch },
      );
      expect(result.sessions.map((session) => session.sessionId)).toEqual([
        'default-session',
      ]);
      const liveResult = await listLiveWorkspaceSessionsForResponse(
        bridge,
        workspace,
        undefined,
        { runtimeBaseDir: scratch },
      );
      expect(liveResult.sessions.map((session) => session.sessionId)).toEqual([
        'default-session',
      ]);
      const organized = await listWorkspaceSessionsForResponse(
        bridge,
        workspace,
        { view: 'organized', group: 'all' },
        { runtimeBaseDir: scratch },
      );
      expect(organized.sessions.map((session) => session.sessionId)).toEqual([
        'default-session',
      ]);
      const explicit = await listWorkspaceSessionsForResponse(
        bridge,
        workspace,
        { sourceType: hiddenType },
        { runtimeBaseDir: scratch },
      );
      expect(explicit.sessions).toEqual([]);
      await expect(
        getWorkspaceSessionInfoForResponse(bridge, workspace),
      ).resolves.toMatchObject({ active: 0, total: 0, live: 1 });
    },
  );

  it.each(['agent-host', 'agent'])(
    'filters persisted %s sessions before paginating public catalogs',
    async (hiddenType) => {
      const visibleId = '00000000-0000-4000-8000-000000000001';
      const hiddenId = '00000000-0000-4000-8000-000000000002';
      await writeStoredSession(
        workspace,
        visibleId,
        'default',
        new Date('2026-09-06T00:00:00.000Z'),
      );
      await writeStoredSession(
        workspace,
        hiddenId,
        hiddenType,
        new Date('2026-09-06T00:01:00.000Z'),
      );
      const bridge = {
        listWorkspaceSessions: () => [],
      } as unknown as AcpSessionBridge;

      const page = await listWorkspaceSessionsForResponse(
        bridge,
        workspace,
        { size: 1 },
        { runtimeBaseDir: scratch, mergeLive: false },
      );
      expect(page.sessions.map((session) => session.sessionId)).toEqual([
        visibleId,
      ]);
      expect(page.nextCursor).toBeUndefined();

      const organized = await listWorkspaceSessionsForResponse(
        bridge,
        workspace,
        { size: 1, view: 'organized' },
        { runtimeBaseDir: scratch, mergeLive: false },
      );
      expect(organized.sessions.map((session) => session.sessionId)).toEqual([
        visibleId,
      ]);

      const explicitHost = await listWorkspaceSessionsForResponse(
        bridge,
        workspace,
        { sourceType: hiddenType },
        { runtimeBaseDir: scratch, mergeLive: false },
      );
      expect(explicitHost.sessions).toEqual([]);

      await expect(
        searchWorkspaceSessionsForResponse(
          workspace,
          hiddenId,
          {},
          {
            runtimeBaseDir: scratch,
          },
        ),
      ).resolves.toEqual({ results: [] });

      await expect(
        getWorkspaceSessionInfoForResponse(bridge, workspace),
      ).resolves.toMatchObject({ active: 1, archived: 0, total: 1, live: 0 });
    },
  );
});
