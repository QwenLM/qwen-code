/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import lockfile from 'proper-lockfile';
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

it('re-enrolls a same-cwd saved Host for explicit replacement and protects its new credential from old revocation', async () => {
  const workspaceCwd = await fs.mkdtemp(
    path.join(os.tmpdir(), 'host-replacement-'),
  );
  const serverUrl = 'http://127.0.0.1:18584';
  const workspaceId = 'ws-replacement';
  const key = createHash('sha256')
    .update(`${serverUrl}\0${workspaceId}\0${workspaceCwd}`)
    .digest('hex');
  const file = path.join(workspaceCwd, 'agent-hosts', `${key}.json`);
  const currentFile = path.join(workspaceCwd, 'agent-hosts', `${key}.v2.json`);
  await fs.mkdir(path.dirname(file));
  await fs.writeFile(
    file,
    JSON.stringify({
      schemaVersion: 1,
      serverUrl,
      workspaceId,
      hostId: 'old',
      secret: 'old-secret',
    }),
  );
  const bridge = {
    listWorkspaceSessions: () => [],
  } as unknown as AcpSessionBridge;
  let replacementEnrolled = false;
  let newerWritten = false;
  let cleanupDone = false;
  const lock = lockfile.lock;
  const lockSpy = vi
    .spyOn(lockfile, 'lock')
    .mockImplementation(async (filePath, options) => {
      const release = await lock(filePath, options);
      return async () => {
        await release();
        if (newerWritten) cleanupDone = true;
      };
    });
  vi.stubEnv('QWEN_HOME', workspaceCwd);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const input = init?.body
        ? (JSON.parse(init.body as string) as {
            enrollmentToken?: string;
            token?: string;
          })
        : {};
      if (url.endsWith('/old/heartbeat') && input.enrollmentToken) {
        return Response.json(
          { error: 'Agent Host replacement requires enrollment.' },
          { status: 409 },
        );
      }
      if (url.endsWith('/enroll')) {
        expect(input.token).toBe('replacement-token');
        replacementEnrolled = true;
        return Response.json({
          host: { id: 'replacement' },
          secret: 'replacement-secret',
        });
      }
      if (url.endsWith('/pickup')) {
        await fs.writeFile(
          currentFile,
          JSON.stringify({
            schemaVersion: 1,
            serverUrl,
            workspaceId,
            hostId: 'newer',
            secret: 'newer-secret',
          }),
        );
        newerWritten = true;
        return Response.json(
          { error: 'Invalid Agent Host credential.' },
          { status: 401 },
        );
      }
      // Simulate the legacy client's unconditional deletion after revocation.
      await fs.rm(file, { force: true });
      return Response.json({ host: { id: 'replacement' } });
    }),
  );
  try {
    await startAgentHostConnection({
      bridge,
      serverUrl,
      workspaceId,
      workspaceCwd,
      enrollmentToken: 'replacement-token',
    });
    await vi.waitFor(() => expect(newerWritten).toBe(true));
    await vi.waitFor(() => expect(cleanupDone).toBe(true));
    expect(await fs.readdir(path.dirname(file))).toEqual([`${key}.v2.json`]);
    expect(replacementEnrolled).toBe(true);
    expect(JSON.parse(await fs.readFile(currentFile, 'utf8'))).toMatchObject({
      hostId: 'newer',
      secret: 'newer-secret',
    });
  } finally {
    lockSpy.mockRestore();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await fs.rm(workspaceCwd, { recursive: true, force: true });
  }
});

it.each(['legacy', 'v2'])(
  'preserves a replacement credential when a stale %s startup resumes',
  async (version) => {
    const workspaceCwd = await fs.mkdtemp(
      path.join(os.tmpdir(), 'host-stale-startup-'),
    );
    const serverUrl = 'http://127.0.0.1:18585';
    const workspaceId = 'ws-stale';
    const key = createHash('sha256')
      .update(`${serverUrl}\0${workspaceId}\0${workspaceCwd}`)
      .digest('hex');
    const directory = path.join(workspaceCwd, 'agent-hosts');
    await fs.mkdir(directory);
    const currentFile = path.join(directory, `${key}.v2.json`);
    const old = {
      schemaVersion: 1,
      serverUrl,
      workspaceId,
      hostId: 'old',
      secret: 'old-secret',
    };
    const replacement = {
      ...old,
      hostId: 'replacement',
      secret: 'replacement-secret',
    };
    await fs.writeFile(
      version === 'v2' ? currentFile : path.join(directory, `${key}.json`),
      JSON.stringify(old),
    );
    const lock = lockfile.lock;
    const lockSpy = vi
      .spyOn(lockfile, 'lock')
      .mockImplementationOnce(async (file, options) => {
        // The other process finishes replacement after this startup's read.
        await fs.writeFile(currentFile, JSON.stringify(replacement));
        return lock(file, options);
      });
    vi.stubEnv('QWEN_HOME', workspaceCwd);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          { error: 'Invalid Agent Host credential.' },
          { status: 401 },
        ),
      ),
    );
    try {
      await expect(
        startAgentHostConnection({
          bridge: {} as AcpSessionBridge,
          serverUrl,
          workspaceId,
          workspaceCwd,
        }),
      ).rejects.toThrow();
      expect(JSON.parse(await fs.readFile(currentFile, 'utf8'))).toEqual(
        replacement,
      );
    } finally {
      lockSpy.mockRestore();
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      await fs.rm(workspaceCwd, { recursive: true, force: true });
    }
  },
);

it.each(['write', 'remove'] as const)(
  'preserves the saved credential when the %s lock is compromised',
  async (operation) => {
    const workspaceCwd = await fs.mkdtemp(
      path.join(os.tmpdir(), 'host-compromised-lock-'),
    );
    const serverUrl = 'http://127.0.0.1:18586';
    const workspaceId = 'ws-compromised';
    const key = createHash('sha256')
      .update(`${serverUrl}\0${workspaceId}\0${workspaceCwd}`)
      .digest('hex');
    const directory = path.join(workspaceCwd, 'agent-hosts');
    await fs.mkdir(directory);
    const file = path.join(
      directory,
      `${key}${operation === 'write' ? '' : '.v2'}.json`,
    );
    const credential = JSON.stringify({
      schemaVersion: 1,
      serverUrl,
      workspaceId,
      hostId: 'saved',
      secret: 'saved-secret',
    });
    await fs.writeFile(file, credential);
    const compromised = new Error('Credential lock ownership was lost.');
    const release = vi.fn().mockRejectedValue(new Error('ERELEASED'));
    const lockSpy = vi
      .spyOn(lockfile, 'lock')
      .mockImplementation(async (_file, options) => {
        options?.onCompromised?.(compromised);
        return release;
      });
    vi.stubEnv('QWEN_HOME', workspaceCwd);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          { error: 'Invalid Agent Host credential.' },
          { status: 401 },
        ),
      ),
    );
    try {
      await expect(
        startAgentHostConnection({
          bridge: {} as AcpSessionBridge,
          serverUrl,
          workspaceId,
          workspaceCwd,
          ...(operation === 'remove' ? { enrollmentToken: 'token' } : {}),
        }),
      ).rejects.toBe(compromised);
      expect(await fs.readFile(file, 'utf8')).toBe(credential);
      expect(await fs.readdir(directory)).toEqual([path.basename(file)]);
      expect(release).not.toHaveBeenCalled();
    } finally {
      lockSpy.mockRestore();
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      await fs.rm(workspaceCwd, { recursive: true, force: true });
    }
  },
);
