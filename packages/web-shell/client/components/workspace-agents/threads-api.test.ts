/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, expect, it, vi } from 'vitest';
import { DaemonClient } from '@qwen-code/sdk/daemon';
import { createThreadsHttpApi } from './threads-api';

afterEach(() => {
  vi.restoreAllMocks();
});

it("leaves remote-connect's deadline to the caller so it outlasts the server's two legs", async () => {
  const timeout = vi.spyOn(AbortSignal, 'timeout');
  const client = new DaemonClient({ baseUrl: 'https://daemon' });
  const requestRest = vi
    .spyOn(client, 'requestRest')
    .mockResolvedValue(Response.json({ ok: true }));
  const api = createThreadsHttpApi(
    'https://daemon',
    undefined,
    '/repo a',
    client,
  );
  try {
    await api.connectRemoteHost!({
      remoteUrl: 'https://remote.example',
      remoteToken: 'remote-secret',
      remoteCwd: '/remote/repo',
      serverUrl: 'https://daemon',
      allowHttp: false,
    });
    expect(requestRest).toHaveBeenCalledWith(
      '/workspaces/%2Frepo%20a/agent/hosts/remote-connect',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
      0,
    );
    // Longer than the coordinator's 20 s and 90 s remote legs together.
    expect(timeout).toHaveBeenCalledWith(120_000);
  } finally {
    client.dispose();
  }
});

it("leaves a join's deadline to the caller so it outlasts enrollment and the save", async () => {
  const timeout = vi.spyOn(AbortSignal, 'timeout');
  const client = new DaemonClient({ baseUrl: 'https://daemon' });
  const requestRest = vi
    .spyOn(client, 'requestRest')
    .mockResolvedValue(Response.json({ connected: true }));
  const api = createThreadsHttpApi(
    'https://daemon',
    undefined,
    '/repo a',
    client,
  );
  try {
    await api.joinCoordinator!({
      serverUrl: 'https://coordinator.example',
      workspaceId: 'ws_1',
      enrollmentToken: 'join-secret',
      allowHttp: false,
    });
    expect(requestRest).toHaveBeenCalledWith(
      '/workspaces/%2Frepo%20a/agent/hosts/connect',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
      0,
    );
    // Longer than the probes, enrollment, the heartbeats and the save.
    expect(timeout).toHaveBeenCalledWith(90_000);
  } finally {
    client.dispose();
  }
});
