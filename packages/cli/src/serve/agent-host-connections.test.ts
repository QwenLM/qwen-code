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
import {
  agentHostConnectionsPath,
  readAgentHostConnections,
  removeAgentHostConnection,
  restoreAgentHostConnections,
  saveAgentHostConnection,
} from './agent-host-connections.js';

const { hasCredential, startConnection } = vi.hoisted(() => ({
  hasCredential: vi.fn<(...args: unknown[]) => Promise<boolean>>(),
  startConnection: vi.fn<(...args: unknown[]) => Promise<void>>(),
}));
vi.mock('./agent-host-client.js', () => ({
  hasAgentHostCredential: hasCredential,
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

it('restores this workspace’s connections and prunes one without a credential', async () => {
  await saveAgentHostConnection(record);
  await saveAgentHostConnection({ ...record, workspaceId: 'ws_revoked' });
  await saveAgentHostConnection({ ...record, workspaceCwd: '/elsewhere' });
  hasCredential.mockImplementation(
    async (target) =>
      (target as { workspaceId: string }).workspaceId !== 'ws_revoked',
  );
  startConnection.mockResolvedValue(undefined);
  const bridge = {} as AcpSessionBridge;

  await restoreAgentHostConnections({ bridge, workspaceCwd: '/work' });

  await vi.waitFor(() => expect(startConnection).toHaveBeenCalledOnce());
  expect(startConnection).toHaveBeenCalledWith({ ...record, bridge });
  await vi.waitFor(async () =>
    expect(
      (await readAgentHostConnections()).map((entry) => entry.workspaceId),
    ).not.toContain('ws_revoked'),
  );
});

it('retries a coordinator that is down at boot', async () => {
  await saveAgentHostConnection(record);
  hasCredential.mockResolvedValue(true);
  startConnection
    .mockRejectedValueOnce(new Error('ECONNREFUSED'))
    .mockResolvedValue(undefined);

  await restoreAgentHostConnections(
    { bridge: {} as AcpSessionBridge, workspaceCwd: '/work' },
    10,
  );

  await vi.waitFor(() => expect(startConnection).toHaveBeenCalledTimes(2));
});
