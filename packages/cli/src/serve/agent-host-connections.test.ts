/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AcpSessionBridge } from './acp-session-bridge.js';
import { createWorkspaceGenerationGuard } from './workspace-registry.js';
import {
  type AgentHostRestoreRuntime,
  agentHostConnectionsPath,
  readAgentHostConnections,
  removeAgentHostConnection,
  restoreAgentHostConnections,
  saveAgentHostConnection,
} from './agent-host-connections.js';

const { hasCredential, startConnection, isRunning } = vi.hoisted(() => ({
  hasCredential: vi.fn<(...args: unknown[]) => Promise<boolean | undefined>>(),
  startConnection: vi.fn<(...args: unknown[]) => Promise<void>>(),
  isRunning: vi.fn<(...args: unknown[]) => boolean>(),
}));
vi.mock('./agent-host-client.js', () => ({
  hasAgentHostCredential: hasCredential,
  isAgentHostConnectionRunning: isRunning,
  startAgentHostConnection: startConnection,
}));
vi.mock('../utils/stdioHelpers.js', () => ({ writeStderrLine: vi.fn() }));

let home: string;
const record = {
  serverUrl: 'https://hub.example',
  workspaceId: 'ws_1',
  workspaceCwd: '/work',
  allowHttp: false,
};

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'host-connections-'));
  vi.stubEnv('QWEN_HOME', home);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
  await fs.rm(home, { recursive: true, force: true });
});

it('saves one record per connection, privately, and removes it', async () => {
  await saveAgentHostConnection(record);
  await saveAgentHostConnection({ ...record, allowHttp: true });
  await saveAgentHostConnection({ ...record, workspaceId: 'ws_2' });

  expect(await readAgentHostConnections()).toEqual([
    { ...record, allowHttp: true },
    { ...record, workspaceId: 'ws_2' },
  ]);
  if (process.platform !== 'win32') {
    expect((await fs.stat(agentHostConnectionsPath())).mode & 0o777).toBe(
      0o600,
    );
  }

  expect(await removeAgentHostConnection(record)).toBe(true);
  expect(await removeAgentHostConnection(record)).toBe(false);
  expect(await readAgentHostConnections()).toEqual([
    { ...record, workspaceId: 'ws_2' },
  ]);
});

function runtime(workspaceCwd: string) {
  return {
    bridge: { workspaceCwd } as unknown as AcpSessionBridge,
    workspaceCwd,
    generationGuard: createWorkspaceGenerationGuard(),
  };
}

/** Runs a restore and stops its loops afterwards. */
async function restoring(
  runtimeFor: (workspaceCwd: string) => AgentHostRestoreRuntime | undefined,
  body: () => Promise<void>,
) {
  const stop = new AbortController();
  try {
    await restoreAgentHostConnections({
      runtimeFor,
      signal: stop.signal,
      retryMs: 10,
      watchMs: 10,
    });
    await body();
  } finally {
    stop.abort();
  }
}

it('restores the connections of every trusted workspace and prunes one without a credential', async () => {
  await saveAgentHostConnection(record);
  await saveAgentHostConnection({ ...record, workspaceId: 'ws_revoked' });
  await saveAgentHostConnection({ ...record, workspaceCwd: '/elsewhere' });
  await saveAgentHostConnection({ ...record, workspaceCwd: '/untrusted' });
  hasCredential.mockImplementation(
    async (target) =>
      (target as { workspaceId: string }).workspaceId !== 'ws_revoked',
  );
  startConnection.mockResolvedValue(undefined);
  isRunning.mockReturnValue(true);
  const work = runtime('/work');
  const elsewhere = runtime('/elsewhere');

  await restoring(
    (cwd) =>
      cwd === '/work' ? work : cwd === '/elsewhere' ? elsewhere : undefined,
    async () => {
      await vi.waitFor(() => expect(startConnection).toHaveBeenCalledTimes(2));
      expect(startConnection).toHaveBeenCalledWith({
        ...record,
        bridge: work.bridge,
        generationGuard: work.generationGuard,
      });
      expect(startConnection).toHaveBeenCalledWith({
        ...record,
        workspaceCwd: '/elsewhere',
        bridge: elsewhere.bridge,
        generationGuard: elsewhere.generationGuard,
      });
      await vi.waitFor(async () =>
        expect(
          (await readAgentHostConnections()).map((entry) => entry.workspaceId),
        ).not.toContain('ws_revoked'),
      );
      // Still waiting for the untrusted one; never connected.
      expect(
        startConnection.mock.calls.some(
          ([target]) =>
            (target as { workspaceCwd: string }).workspaceCwd === '/untrusted',
        ),
      ).toBe(false);
    },
  );
});

it('keeps a connection whose credential cannot be read', async () => {
  await saveAgentHostConnection({ ...record, workspaceId: 'ws_unreadable' });
  hasCredential.mockResolvedValue(undefined);
  const work = runtime('/work');

  await restoring(
    (cwd) => (cwd === '/work' ? work : undefined),
    async () => {
      await vi.waitFor(() => expect(hasCredential).toHaveBeenCalled());
      expect(
        (await readAgentHostConnections()).map((entry) => entry.workspaceId),
      ).toContain('ws_unreadable');
      expect(startConnection).not.toHaveBeenCalled();
    },
  );
});

it('retries a coordinator that is down at boot', async () => {
  await saveAgentHostConnection(record);
  hasCredential.mockResolvedValue(true);
  isRunning.mockReturnValue(true);
  startConnection
    .mockRejectedValueOnce(new Error('ECONNREFUSED'))
    .mockResolvedValue(undefined);
  const work = runtime('/work');

  await restoring(
    () => work,
    async () => {
      await vi.waitFor(() => expect(startConnection).toHaveBeenCalledTimes(2));
    },
  );
});

it('connects a workspace that becomes available after boot', async () => {
  await saveAgentHostConnection(record);
  hasCredential.mockResolvedValue(true);
  isRunning.mockReturnValue(true);
  startConnection.mockResolvedValue(undefined);
  let available: AgentHostRestoreRuntime | undefined;

  await restoring(
    () => available,
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(startConnection).not.toHaveBeenCalled();
      available = runtime('/work');
      await vi.waitFor(() => expect(startConnection).toHaveBeenCalledOnce());
    },
  );
});

it('supervises a connection saved after boot', async () => {
  hasCredential.mockResolvedValue(true);
  isRunning.mockReturnValue(true);
  startConnection.mockResolvedValue(undefined);
  const work = runtime('/work');

  await restoring(
    () => work,
    async () => {
      // `qwen agents join` against the running daemon saves the record later.
      await saveAgentHostConnection(record);
      await vi.waitFor(() =>
        expect(startConnection).toHaveBeenCalledWith({
          ...record,
          bridge: work.bridge,
          generationGuard: work.generationGuard,
        }),
      );
    },
  );
});

it('reconnects on the new runtime when the old one is replaced, and lets a removed record go', async () => {
  await saveAgentHostConnection(record);
  hasCredential.mockResolvedValue(true);
  isRunning.mockReturnValue(true);
  startConnection.mockResolvedValue(undefined);
  let current = runtime('/work');
  const first = current;

  await restoring(
    () => current,
    async () => {
      await vi.waitFor(() => expect(startConnection).toHaveBeenCalledOnce());
      current = runtime('/work');
      first.generationGuard.close();
      await vi.waitFor(() => expect(startConnection).toHaveBeenCalledTimes(2));
      expect(startConnection).toHaveBeenLastCalledWith(
        expect.objectContaining({ bridge: current.bridge }),
      );

      // `DELETE hosts/connect` forgets it; a stopped connection stays down.
      await removeAgentHostConnection(record);
      isRunning.mockReturnValue(false);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(startConnection).toHaveBeenCalledTimes(2);
    },
  );
});
