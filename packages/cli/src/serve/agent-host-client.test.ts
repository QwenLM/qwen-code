/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { HostRunResult } from '@qwen-code/qwen-code-core';
import type { AcpSessionBridge } from './acp-session-bridge.js';
import { isRevocation, startAgentHostConnection } from './agent-host-client.js';

describe('isRevocation', () => {
  // The transport error carries the route's body text as its message.
  const withStatus = (status: number, message: string) =>
    Object.assign(new Error(message), { status });

  it('matches the route 401 credential rejection', () => {
    expect(
      isRevocation(withStatus(401, 'Invalid Agent Host credential.')),
    ).toBe(true);
  });

  it('does not match the bearer gate 401 seen during a coordinator restart', () => {
    expect(isRevocation(withStatus(401, 'Unauthorized'))).toBe(false);
  });

  it('does not match a 401 with any other body', () => {
    expect(isRevocation(withStatus(401, 'Invalid Host header'))).toBe(false);
  });

  it('does not match non-401 statuses', () => {
    expect(
      isRevocation(withStatus(403, 'Invalid Agent Host credential.')),
    ).toBe(false);
    expect(isRevocation(withStatus(503, 'Agent Host store busy.'))).toBe(false);
  });

  it('does not match plain network failures', () => {
    expect(isRevocation(new TypeError('fetch failed'))).toBe(false);
    expect(isRevocation(undefined)).toBe(false);
  });
});

it('returns the provider detail when sendPrompt rejects with a JSON-RPC error', async () => {
  const workspaceCwd = await fs.mkdtemp(path.join(os.tmpdir(), 'pr12582-f7-'));
  let result: HostRunResult | undefined;
  let pickups = 0;
  const bridge = {
    listWorkspaceSessions: () => [],
    spawnOrAttach: vi.fn().mockResolvedValue({}),
    async *subscribeEvents() {},
    getSessionStatsStatus: vi.fn().mockResolvedValue({ models: {} }),
    sendPrompt: vi.fn().mockRejectedValue({
      code: -32603,
      message: 'Internal error',
      data: { details: '400 PR12582_PROVIDER_400_READABLE_CAUSE' },
    }),
    closeSession: vi.fn().mockResolvedValue({}),
  } as unknown as AcpSessionBridge;
  vi.stubEnv('QWEN_HOME', workspaceCwd);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/enroll')) {
        return Response.json({ host: { id: 'host-test' }, secret: 'secret' });
      }
      if (url.endsWith('/pickup')) {
        if (++pickups > 1) {
          return Response.json(
            { error: 'Invalid Agent Host credential.' },
            { status: 401 },
          );
        }
        return Response.json({
          assignment: {
            agent: { id: 'agent-test', name: 'test' },
            threadId: 'thread-test',
            runId: 'run-test',
            attempt: 1,
            lease: { leaseId: 'lease-test' },
            prompt: 'Read the fixture.',
          },
        });
      }
      if (url.endsWith('/result')) {
        result = JSON.parse(init?.body as string) as HostRunResult;
      }
      if (url.endsWith('/heartbeat')) {
        return Response.json({ lease: { leaseId: 'lease-test' } });
      }
      return Response.json({ ok: true });
    }),
  );
  try {
    await startAgentHostConnection({
      bridge,
      serverUrl: 'http://127.0.0.1:18583',
      workspaceId: 'ws-test',
      workspaceCwd,
      enrollmentToken: 'test-token',
    });
    await vi.waitFor(() => expect(pickups).toBe(2));
    expect(result).toMatchObject({
      status: 'failed',
      error: '400 PR12582_PROVIDER_400_READABLE_CAUSE',
    });
    expect(bridge.sendPrompt).toHaveBeenCalledOnce();
    expect(bridge.closeSession).toHaveBeenCalledOnce();
    await vi.waitFor(async () => {
      expect(await fs.readdir(path.join(workspaceCwd, 'agent-hosts'))).toEqual(
        [],
      );
    });
  } finally {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await fs.rm(workspaceCwd, { recursive: true, force: true });
  }
});

it('retains a saved credential when rejoining sees only bare bearer 401s', async () => {
  const qwenDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pr12582-f1-'));
  const serverUrl = 'http://127.0.0.1:18582';
  const workspaceId = 'ws-test';
  const workspaceCwd = '/pr12582-test';
  const key = createHash('sha256')
    .update(`${serverUrl}\0${workspaceId}\0${workspaceCwd}`)
    .digest('hex');
  const file = path.join(qwenDir, 'agent-hosts', `${key}.json`);
  const credential = JSON.stringify({
    schemaVersion: 1,
    serverUrl,
    workspaceId,
    hostId: 'host-saved',
    secret: 'saved-test-secret',
  });
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, credential);
  const fetchMock = vi.fn(async () =>
    Response.json({ error: 'Unauthorized' }, { status: 401 }),
  );
  vi.stubEnv('QWEN_HOME', qwenDir);
  vi.stubGlobal('fetch', fetchMock);
  try {
    await expect(
      startAgentHostConnection({
        bridge: {} as AcpSessionBridge,
        serverUrl,
        workspaceId,
        workspaceCwd,
        enrollmentToken: 'the-original-ui-join-token',
      }),
    ).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalled();
    await expect(fs.readFile(file, 'utf8')).resolves.toBe(credential);
  } finally {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await fs.rm(qwenDir, { recursive: true, force: true });
  }
});
