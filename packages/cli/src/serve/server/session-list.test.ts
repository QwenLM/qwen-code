/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Storage } from '@qwen-code/qwen-code-core/config/storage.js';
import type {
  AcpSessionBridge,
  BridgeSessionSummary,
} from '../acp-session-bridge.js';
import { listWorkspaceSessionsForResponse } from './session-list.js';

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

  async function persist(session: BridgeSessionSummary): Promise<void> {
    const chats = path.join(
      new Storage(workspaceCwd, runtimeBaseDir).getProjectDir(),
      'chats',
    );
    await fs.mkdir(chats, { recursive: true });
    const file = path.join(chats, `${session.sessionId}.jsonl`);
    await fs.writeFile(
      file,
      `${JSON.stringify({
        uuid: `${session.sessionId}-user`,
        parentUuid: null,
        sessionId: session.sessionId,
        timestamp: session.createdAt,
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
});
