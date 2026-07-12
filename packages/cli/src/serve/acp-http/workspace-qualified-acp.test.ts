/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { promises as fsp } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import WebSocket from 'ws';
import type { HttpAcpBridge } from '@qwen-code/acp-bridge/bridgeTypes';
import { Storage } from '@qwen-code/qwen-code-core';
import { type AcpHttpHandle, mountAcpHttp } from './index.js';
import { DeviceFlowRegistry } from '../auth/device-flow.js';
import { CdpTunnelRegistry } from '../cdp-tunnel/cdp-tunnel-registry.js';
import {
  createWorkspaceRegistry,
  type WorkspaceRuntime,
  type WorkspaceRuntimeEnvMetadata,
} from '../workspace-registry.js';
import { ClientMcpSenderRegistry } from './client-mcp-sender-registry.js';
import { WorkspaceRememberTaskLane } from '../workspace-remember.js';
import type { WorkspaceFileSystemFactory } from '../fs/index.js';
import type { DaemonWorkspaceService } from '../workspace-service/types.js';
import { writeStderrLine } from '../../utils/stdioHelpers.js';
import { createSessionOrganizationService } from '../session-organization-helpers.js';

vi.mock('../../utils/stdioHelpers.js', () => ({ writeStderrLine: vi.fn() }));

const PARENT_ENV: WorkspaceRuntimeEnvMetadata = {
  mode: 'parent-process',
  overlayKeys: [],
};

function makeBridge(): HttpAcpBridge {
  return {
    detachClient: vi.fn(async () => {}),
    isWorkspaceMemoryRememberAvailable: vi.fn(async () => true),
    runWorkspaceMemoryRemember: vi.fn(async () => ({
      filesTouched: [],
      touchedScopes: [],
    })),
    publishWorkspaceEvent: vi.fn(),
  } as unknown as HttpAcpBridge;
}

function makeRuntime(input: {
  id: string;
  cwd: string;
  primary: boolean;
  trusted: boolean;
  bridge: HttpAcpBridge;
}): WorkspaceRuntime {
  return {
    workspaceId: input.id,
    workspaceCwd: input.cwd,
    primary: input.primary,
    trusted: input.trusted,
    env: PARENT_ENV,
    bridge: input.bridge,
    workspaceService: {} as unknown as DaemonWorkspaceService,
    routeFileSystemFactory: {
      forRequest: () => ({}),
    } as unknown as WorkspaceFileSystemFactory,
    clientMcpSenderRegistry: new ClientMcpSenderRegistry(),
  };
}

const INITIALIZE = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
});

async function writeStoredSession(sessionId: string, cwd: string) {
  const chatsDir = path.join(new Storage(cwd).getProjectDir(), 'chats');
  await fsp.mkdir(chatsDir, { recursive: true });
  await fsp.writeFile(
    path.join(chatsDir, `${sessionId}.jsonl`),
    `${JSON.stringify({
      uuid: `${sessionId}-user-1`,
      parentUuid: null,
      sessionId,
      timestamp: '2026-07-11T00:00:00.000Z',
      type: 'user',
      message: { role: 'user', parts: [{ text: 'secondary session' }] },
      cwd,
    })}\n`,
    'utf8',
  );
}

async function withRuntimeDir<T>(fn: () => Promise<T>): Promise<T> {
  const previousRuntimeDir = process.env['QWEN_RUNTIME_DIR'];
  const runtimeDir = await fsp.mkdtemp(
    path.join(os.tmpdir(), 'qwen-workspace-qualified-acp-'),
  );
  process.env['QWEN_RUNTIME_DIR'] = runtimeDir;
  try {
    return await fn();
  } finally {
    if (previousRuntimeDir === undefined) {
      delete process.env['QWEN_RUNTIME_DIR'];
    } else {
      process.env['QWEN_RUNTIME_DIR'] = previousRuntimeDir;
    }
    await fsp.rm(runtimeDir, { recursive: true, force: true });
  }
}

describe('workspace-qualified ACP (/workspaces/:workspace/acp)', () => {
  let server: Server;
  let base: string;
  let port: number;
  let handle: AcpHttpHandle | undefined;
  let deviceFlowRegistry: DeviceFlowRegistry | undefined;
  let cdpRegistry: CdpTunnelRegistry;
  let checkRate: ReturnType<typeof vi.fn>;
  let primaryBridge: HttpAcpBridge;
  let secondaryBridge: HttpAcpBridge;
  let workspaceRegistry: ReturnType<typeof createWorkspaceRegistry>;
  let secondaryRuntime: WorkspaceRuntime;

  beforeEach(async () => {
    primaryBridge = makeBridge();
    secondaryBridge = makeBridge();
    const untrustedBridge = makeBridge();

    secondaryRuntime = makeRuntime({
      id: 'secondary-id',
      cwd: '/ws-b',
      primary: false,
      trusted: true,
      bridge: secondaryBridge,
    });
    workspaceRegistry = createWorkspaceRegistry([
      makeRuntime({
        id: 'primary-id',
        cwd: '/ws',
        primary: true,
        trusted: true,
        bridge: primaryBridge,
      }),
      secondaryRuntime,
      makeRuntime({
        id: 'untrusted-id',
        cwd: '/ws-c',
        primary: false,
        trusted: false,
        bridge: untrustedBridge,
      }),
    ]);

    deviceFlowRegistry = new DeviceFlowRegistry({
      events: { publish: () => {} },
      resolveProvider: () => undefined,
      scheduleInterval: () => 0 as unknown as ReturnType<typeof setInterval>,
      clearScheduledInterval: () => {},
    });
    cdpRegistry = new CdpTunnelRegistry();
    checkRate = vi.fn().mockReturnValue(true);

    const app = express();
    app.use(express.json());
    handle = mountAcpHttp(app, primaryBridge, {
      boundWorkspace: '/ws',
      workspace: {} as unknown as DaemonWorkspaceService,
      enabled: true,
      workspaceRegistry,
      deviceFlowRegistry,
      cdpTunnelOverWs: true,
      cdpTunnelRegistry: cdpRegistry,
      checkRate,
      workspaceRememberLane: new WorkspaceRememberTaskLane(primaryBridge),
    });

    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        port = (server.address() as AddressInfo).port;
        handle?.attachServer(server);
        resolve();
      });
    });
    base = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    handle?.dispose();
    deviceFlowRegistry?.dispose();
    server.closeAllConnections?.();
    await new Promise<void>((r) => server.close(() => r()));
  });

  async function postInitialize(pathname: string): Promise<Response> {
    return fetch(`${base}${pathname}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: INITIALIZE,
    });
  }

  async function postMessage(
    pathname: string,
    connectionId: string,
    id: number,
  ): Promise<Response> {
    return fetch(`${base}${pathname}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'acp-connection-id': connectionId,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'unknown/mutation',
      }),
    });
  }

  async function sendWsRequest(
    pathname: string,
    request: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}${pathname}`, {
        handshakeTimeout: 2000,
      });
      ws.on('open', () => ws.send(INITIALIZE));
      ws.on('message', (data: WebSocket.RawData) => {
        try {
          const message = JSON.parse(data.toString()) as Record<
            string,
            unknown
          >;
          if (message['id'] === 1) {
            ws.send(JSON.stringify(request));
            return;
          }
          if (message['id'] === request['id']) {
            ws.close();
            resolve(message);
          }
        } catch (err) {
          ws.terminate();
          reject(err as Error);
        }
      });
      ws.on('error', reject);
    });
  }

  async function initializeWs(pathname: string): Promise<{
    result?: {
      protocolVersion?: number;
      agentCapabilities?: {
        _meta?: { qwen?: { workspaceCwd?: string } };
      };
    };
    error?: {
      data?: { code?: string; workspaceCwd?: string };
    };
  }> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}${pathname}`, {
        handshakeTimeout: 2000,
      });
      ws.on('open', () => ws.send(INITIALIZE));
      ws.on('message', (data: WebSocket.RawData) => {
        try {
          resolve(JSON.parse(data.toString()));
        } catch (err) {
          reject(err as Error);
        } finally {
          ws.close();
        }
      });
      ws.on('error', reject);
    });
  }

  it('routes initialize to a trusted secondary workspace by id', async () => {
    vi.mocked(writeStderrLine).mockClear();
    const res = await postInitialize('/workspaces/secondary-id/acp');
    expect(res.status).toBe(200);
    expect(res.headers.get('acp-connection-id')).toBeTruthy();
    expect(writeStderrLine).toHaveBeenCalledWith(
      expect.stringContaining(
        '/workspaces/secondary-id/acp connection established',
      ),
    );
  });

  it('routes initialize to a trusted secondary workspace by encoded cwd', async () => {
    const res = await postInitialize(
      `/workspaces/${encodeURIComponent('/ws-b')}/acp`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('acp-connection-id')).toBeTruthy();
  });

  it('meters HTTP requests independently across workspace mounts', async () => {
    const primary = await postInitialize('/acp');
    const secondary = await postInitialize('/workspaces/secondary-id/acp');
    const primaryId = primary.headers.get('acp-connection-id');
    const secondaryId = secondary.headers.get('acp-connection-id');
    expect(primaryId).toBeTruthy();
    expect(secondaryId).toBeTruthy();
    checkRate.mockClear();

    await postMessage('/acp', primaryId!, 2);
    await postMessage('/workspaces/secondary-id/acp', secondaryId!, 3);

    expect(checkRate).toHaveBeenCalledTimes(2);
    const keys = checkRate.mock.calls.map(([key]) => key as string);
    expect(new Set(keys).size).toBe(2);
  });

  it('meters WS requests independently across workspace mounts', async () => {
    checkRate.mockClear();
    await sendWsRequest('/acp', {
      jsonrpc: '2.0',
      id: 2,
      method: 'unknown/mutation',
    });
    await sendWsRequest('/workspaces/secondary-id/acp', {
      jsonrpc: '2.0',
      id: 3,
      method: 'unknown/mutation',
    });

    expect(checkRate).toHaveBeenCalledTimes(2);
    const keys = checkRate.mock.calls.map(([key]) => key as string);
    expect(new Set(keys).size).toBe(2);
  });

  it('opens and deletes a connection through qualified GET and DELETE', async () => {
    const initialized = await postInitialize('/workspaces/secondary-id/acp');
    const connectionId = initialized.headers.get('acp-connection-id');
    expect(connectionId).toBeTruthy();

    const stream = await fetch(`${base}/workspaces/secondary-id/acp`, {
      headers: {
        accept: 'text/event-stream',
        'acp-connection-id': connectionId!,
      },
    });
    expect(stream.status).toBe(200);
    expect(stream.headers.get('content-type')).toContain('text/event-stream');
    await stream.body?.cancel();

    const deleted = await fetch(`${base}/workspaces/secondary-id/acp`, {
      method: 'DELETE',
      headers: { 'acp-connection-id': connectionId! },
    });
    expect(deleted.status).toBe(202);
    expect(handle!.getSnapshot().connectionCount).toBe(0);
  });

  it('does not resolve a secondary connection on the primary mount', async () => {
    const initialized = await postInitialize('/workspaces/secondary-id/acp');
    const connectionId = initialized.headers.get('acp-connection-id');
    expect(connectionId).toBeTruthy();

    const primary = await fetch(`${base}/acp`, {
      headers: {
        accept: 'text/event-stream',
        'acp-connection-id': connectionId!,
      },
    });
    expect(primary.status).toBe(404);
  });

  it('rejects a body workspaceCwd that differs from the selected mount', async () => {
    const response = await sendWsRequest('/workspaces/secondary-id/acp', {
      jsonrpc: '2.0',
      id: 2,
      method: 'session/list',
      params: { workspaceCwd: '/ws' },
    });

    expect(response['error']).toMatchObject({ code: -32602 });
  });

  it('updates persisted organization in the selected workspace only', async () => {
    await withRuntimeDir(async () => {
      const sessionId = '550e8400-e29b-41d4-a716-446655440180';
      await writeStoredSession(sessionId, '/ws-b');

      const response = await sendWsRequest('/workspaces/secondary-id/acp', {
        jsonrpc: '2.0',
        id: 2,
        method: '_qwen/session/update_organization',
        params: { sessionId, isPinned: true },
      });

      expect(response['result']).toMatchObject({ sessionId, isPinned: true });
      const listed = await sendWsRequest('/workspaces/secondary-id/acp', {
        jsonrpc: '2.0',
        id: 3,
        method: 'session/list',
        params: { view: 'organized', group: 'pinned' },
      });
      expect(listed['result']).toMatchObject({
        sessions: [expect.objectContaining({ sessionId, isPinned: true })],
      });

      const legacy = await sendWsRequest('/acp', {
        jsonrpc: '2.0',
        id: 4,
        method: '_qwen/session/update_organization',
        params: { sessionId, isPinned: false },
      });
      expect(legacy['error']).toMatchObject({ code: -32602 });

      const secondarySnapshot =
        await createSessionOrganizationService('/ws-b').readSnapshot();
      const primarySnapshot =
        await createSessionOrganizationService('/ws').readSnapshot();
      expect(secondarySnapshot.sessions.get(sessionId)).toMatchObject({
        isPinned: true,
      });
      expect(primarySnapshot.sessions.has(sessionId)).toBe(false);
    });
  });

  it('rejects an untrusted workspace with 403 untrusted_workspace', async () => {
    const res = await postInitialize('/workspaces/untrusted-id/acp');
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe('untrusted_workspace');
  });

  it('rejects an unknown workspace selector with 400 workspace_mismatch', async () => {
    const res = await postInitialize(
      `/workspaces/${encodeURIComponent('/does-not-exist')}/acp`,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe('workspace_mismatch');
  });

  it('routes the primary selector to the primary mount', async () => {
    const res = await postInitialize('/workspaces/primary-id/acp');
    expect(res.status).toBe(200);
  });

  it('keeps legacy /acp working', async () => {
    const res = await postInitialize('/acp');
    expect(res.status).toBe(200);
  });

  it('forwards unexpected legacy POST failures to Express', async () => {
    vi.spyOn(handle!.registry, 'create').mockImplementationOnce(() => {
      throw new Error('unexpected registry failure');
    });

    const res = await fetch(`${base}/acp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: INITIALIZE,
    });

    expect(res.status).toBe(500);
  });

  it('exposes qualified HTTP and WS routes with one runtime', async () => {
    const primaryBridge = makeBridge();
    const registry = createWorkspaceRegistry([
      makeRuntime({
        id: 'primary-id',
        cwd: '/ws',
        primary: true,
        trusted: true,
        bridge: primaryBridge,
      }),
    ]);
    const app = express();
    app.use(express.json());
    const singleHandle = mountAcpHttp(app, primaryBridge, {
      boundWorkspace: '/ws',
      workspace: {} as DaemonWorkspaceService,
      enabled: true,
      workspaceRegistry: registry,
      workspaceRememberLane: new WorkspaceRememberTaskLane(primaryBridge),
    })!;
    const singleServer = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    singleHandle.attachServer(singleServer);
    const singlePort = (singleServer.address() as AddressInfo).port;

    try {
      const qualified = await fetch(
        `http://127.0.0.1:${singlePort}/workspaces/primary-id/acp`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: INITIALIZE,
        },
      );
      expect(qualified.status).toBe(200);

      const upgradeStatus = await new Promise<number>((resolve) => {
        const ws = new WebSocket(
          `ws://127.0.0.1:${singlePort}/workspaces/primary-id/acp`,
        );
        ws.on('open', () => {
          ws.close();
          resolve(101);
        });
        ws.on('unexpected-response', (_req, res) => {
          ws.terminate();
          resolve(res.statusCode ?? 0);
        });
        ws.on('error', () => resolve(0));
      });
      expect(upgradeStatus).toBe(101);

      const legacy = await fetch(`http://127.0.0.1:${singlePort}/acp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: INITIALIZE,
      });
      expect(legacy.status).toBe(200);

      registry.add(
        makeRuntime({
          id: 'dynamic-id',
          cwd: '/dynamic',
          primary: false,
          trusted: true,
          bridge: makeBridge(),
        }),
      );
      singleHandle.beginWorkspaceDrain('dynamic-id');
      const drainingDynamic = await fetch(
        `http://127.0.0.1:${singlePort}/workspaces/dynamic-id/acp`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: INITIALIZE,
        },
      );
      expect(drainingDynamic.status).toBe(503);
      await expect(drainingDynamic.json()).resolves.toMatchObject({
        code: 'workspace_draining',
      });

      singleHandle.cancelWorkspaceDrain('dynamic-id');
      const dynamic = await fetch(
        `http://127.0.0.1:${singlePort}/workspaces/dynamic-id/acp`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: INITIALIZE,
        },
      );
      expect(dynamic.status).toBe(200);
    } finally {
      singleHandle.dispose();
      singleServer.closeAllConnections?.();
      await new Promise<void>((resolve) => singleServer.close(() => resolve()));
    }
  });

  it('routes a WS upgrade + initialize to a trusted secondary workspace', async () => {
    const result = await initializeWs('/workspaces/secondary-id/acp');
    expect(result.result?.protocolVersion).toBeGreaterThanOrEqual(1);
    expect(result.result?.agentCapabilities?._meta?.qwen?.workspaceCwd).toBe(
      '/ws-b',
    );
  });

  it('routes a WS upgrade by encoded workspace cwd', async () => {
    const result = await initializeWs(
      `/workspaces/${encodeURIComponent('/ws-b')}/acp`,
    );
    expect(result.result?.agentCapabilities?._meta?.qwen?.workspaceCwd).toBe(
      '/ws-b',
    );
  });

  it('rejects a WS upgrade to an untrusted workspace', async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(
        `ws://127.0.0.1:${port}/workspaces/untrusted-id/acp`,
        { handshakeTimeout: 2000 },
      );
      ws.on('unexpected-response', (_req, res) => {
        resolve(res.statusCode ?? 0);
        ws.terminate();
      });
      ws.on('open', () => {
        ws.close();
        reject(new Error('untrusted WS upgrade should not open'));
      });
      // Some ws versions surface a rejected upgrade as an error rather than
      // `unexpected-response`; treat that as the expected 403.
      ws.on('error', () => resolve(403));
    });
    expect(status).toBe(403);
  });

  it('returns 503 server_disposed after dispose()', async () => {
    handle?.dispose();
    const res = await postInitialize('/workspaces/secondary-id/acp');
    expect(res.status).toBe(503);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe('server_disposed');
  });

  it('closes a WS upgraded before dispose without allowing initialize', async () => {
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/workspaces/secondary-id/acp`,
      { handshakeTimeout: 2000 },
    );
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });

    const closed = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('WebSocket stayed open after ACP disposal')),
        2000,
      );
      ws.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });

    handle!.dispose();
    try {
      await closed;
      expect(handle!.getSnapshot().connectionCount).toBe(0);
    } finally {
      ws.terminate();
    }
  });

  it('counts and closes an uninitialized workspace WebSocket on removal', async () => {
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/workspaces/secondary-id/acp`,
      { handshakeTimeout: 2000 },
    );
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    expect(handle!.getWorkspaceActivity('secondary-id').acpConnections).toBe(1);

    const closed = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(new Error('Workspace WebSocket stayed open after removal')),
        2000,
      );
      ws.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    handle!.beginWorkspaceDrain('secondary-id');
    handle!.commitWorkspaceRemoval('secondary-id');
    handle!.disposeWorkspace('secondary-id');
    await closed;

    expect(handle!.getWorkspaceActivity('secondary-id').acpConnections).toBe(0);
    await expect(initializeWs('/acp')).resolves.toMatchObject({
      result: {
        agentCapabilities: { _meta: { qwen: { workspaceCwd: '/ws' } } },
      },
    });
  });

  it('disposes only the target live WebSocket and allows a fresh mount', async () => {
    const connect = (pathname: string) =>
      new Promise<WebSocket>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}${pathname}`, {
          handshakeTimeout: 2000,
        });
        ws.on('open', () => ws.send(INITIALIZE));
        ws.on('message', (data: WebSocket.RawData) => {
          const message = JSON.parse(data.toString()) as { id?: number };
          if (message.id === 1) resolve(ws);
        });
        ws.on('error', reject);
      });
    const primaryWs = await connect('/acp');
    const secondaryWs = await connect('/workspaces/secondary-id/acp');
    const secondaryClosed = new Promise<void>((resolve) => {
      secondaryWs.once('close', () => resolve());
    });

    expect(workspaceRegistry.beginDrain(secondaryRuntime)).toBe(true);
    handle!.beginWorkspaceDrain('secondary-id');
    handle!.commitWorkspaceRemoval('secondary-id');
    handle!.disposeWorkspace('secondary-id');
    workspaceRegistry.completeDrain(secondaryRuntime);
    await secondaryClosed;

    const primaryReply = new Promise<Record<string, unknown>>(
      (resolve, reject) => {
        primaryWs.once('message', (data: WebSocket.RawData) => {
          try {
            resolve(JSON.parse(data.toString()) as Record<string, unknown>);
          } catch (err) {
            reject(err as Error);
          }
        });
      },
    );
    primaryWs.send(
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'unknown/mutation' }),
    );
    expect(await primaryReply).toMatchObject({ id: 2 });
    primaryWs.close();

    workspaceRegistry.add(
      makeRuntime({
        id: 'secondary-id',
        cwd: '/ws-b',
        primary: false,
        trusted: true,
        bridge: makeBridge(),
      }),
    );
    await expect(
      initializeWs('/workspaces/secondary-id/acp'),
    ).resolves.toMatchObject({
      result: {
        agentCapabilities: { _meta: { qwen: { workspaceCwd: '/ws-b' } } },
      },
    });
  });

  it('rejects an upgrade whose listener starts after disposal', async () => {
    server.prependOnceListener('upgrade', () => handle!.dispose());

    const outcome = await new Promise<'opened' | 'rejected'>((resolve) => {
      const ws = new WebSocket(
        `ws://127.0.0.1:${port}/workspaces/secondary-id/acp`,
        { handshakeTimeout: 2000 },
      );
      ws.once('open', () => {
        ws.terminate();
        resolve('opened');
      });
      ws.once('unexpected-response', () => {
        ws.terminate();
        resolve('rejected');
      });
      ws.once('error', () => resolve('rejected'));
    });

    expect(outcome).toBe('rejected');
    expect(handle!.getSnapshot().connectionCount).toBe(0);
  });

  it('does not reattach a WebSocket listener after disposal', () => {
    handle!.dispose();
    const listenerCount = server.listenerCount('upgrade');

    handle!.attachServer(server);

    expect(server.listenerCount('upgrade')).toBe(listenerCount);
  });

  it('aggregates a connection snapshot across primary + trusted secondary mounts', async () => {
    const res = await postInitialize('/workspaces/secondary-id/acp');
    expect(res.status).toBe(200);

    const snap = handle!.getSnapshot();
    // primary (workspaceId null) + the trusted secondary only; untrusted
    // workspaces get no mount, so they never appear in the aggregate snapshot.
    expect(snap.mounts).toHaveLength(2);
    expect(snap.mounts.find((m) => m.primary)?.workspaceId).toBeNull();
    const ids = snap.mounts.map((m) => m.workspaceId);
    expect(ids).toContain('secondary-id');
    expect(ids).not.toContain('untrusted-id');
    expect(snap.connectionCount).toBe(1);
    expect(snap.connections).toEqual([
      expect.objectContaining({
        workspaceId: 'secondary-id',
        workspaceCwd: '/ws-b',
        primary: false,
      }),
    ]);
  });

  it('drains, rolls back, disposes, and recreates a secondary mount', async () => {
    const initialized = await postInitialize('/workspaces/secondary-id/acp');
    expect(initialized.status).toBe(200);
    expect(handle!.getWorkspaceActivity('secondary-id')).toEqual({
      acpConnections: 1,
      memoryTasks: 0,
    });

    handle!.beginWorkspaceDrain('secondary-id');
    const draining = await postInitialize('/workspaces/secondary-id/acp');
    expect(draining.status).toBe(503);
    expect(draining.headers.get('retry-after')).toBe('5');
    await expect(draining.json()).resolves.toMatchObject({
      code: 'workspace_draining',
    });

    handle!.cancelWorkspaceDrain('secondary-id');
    expect((await postInitialize('/workspaces/secondary-id/acp')).status).toBe(
      200,
    );

    expect(workspaceRegistry.beginDrain(secondaryRuntime)).toBe(true);
    handle!.beginWorkspaceDrain('secondary-id');
    const registryDraining = await postInitialize(
      '/workspaces/secondary-id/acp',
    );
    expect(registryDraining.status).toBe(503);
    await expect(registryDraining.json()).resolves.toMatchObject({
      code: 'workspace_draining',
    });
    handle!.commitWorkspaceRemoval('secondary-id');
    handle!.disposeWorkspace('secondary-id');
    workspaceRegistry.completeDrain(secondaryRuntime);
    expect(handle!.getWorkspaceActivity('secondary-id')).toEqual({
      acpConnections: 0,
      memoryTasks: 0,
    });
    expect(
      handle!
        .getSnapshot()
        .mounts.some((mount) => mount.workspaceId === 'secondary-id'),
    ).toBe(false);

    const replacementBridge = makeBridge();
    workspaceRegistry.add(
      makeRuntime({
        id: 'secondary-id',
        cwd: '/ws-b',
        primary: false,
        trusted: true,
        bridge: replacementBridge,
      }),
    );
    expect((await postInitialize('/workspaces/secondary-id/acp')).status).toBe(
      200,
    );
    expect(handle!.getWorkspaceActivity('secondary-id').acpConnections).toBe(1);
  });

  it('returns a structured workspace_draining error on an existing WebSocket', async () => {
    const reply = await new Promise<Record<string, unknown>>(
      (resolve, reject) => {
        const ws = new WebSocket(
          `ws://127.0.0.1:${port}/workspaces/secondary-id/acp`,
          { handshakeTimeout: 2000 },
        );
        ws.on('open', () => ws.send(INITIALIZE));
        ws.on('message', (data: WebSocket.RawData) => {
          const message = JSON.parse(data.toString()) as Record<
            string,
            unknown
          >;
          if (message['id'] === 1) {
            handle!.beginWorkspaceDrain('secondary-id');
            ws.send(
              JSON.stringify({
                jsonrpc: '2.0',
                id: 2,
                method: 'unknown/mutation',
              }),
            );
            return;
          }
          if (message['id'] === 2) {
            ws.close();
            resolve(message);
          }
        });
        ws.on('error', reject);
      },
    );

    expect(reply).toMatchObject({
      error: {
        data: {
          code: 'workspace_draining',
          workspaceCwd: '/ws-b',
        },
      },
    });
  });

  it('rejects a new WebSocket upgrade while its workspace is draining', async () => {
    expect(workspaceRegistry.beginDrain(secondaryRuntime)).toBe(true);
    handle!.beginWorkspaceDrain('secondary-id');

    await expect(initializeWs('/workspaces/secondary-id/acp')).rejects.toThrow(
      'Unexpected server response: 503',
    );
  });

  it('accepts correlation replies while rejecting new work during drain', async () => {
    const reply = await new Promise<Record<string, unknown>>(
      (resolve, reject) => {
        const ws = new WebSocket(
          `ws://127.0.0.1:${port}/workspaces/secondary-id/acp`,
          { handshakeTimeout: 2000 },
        );
        ws.on('open', () => ws.send(INITIALIZE));
        ws.on('message', (data: WebSocket.RawData) => {
          const message = JSON.parse(data.toString()) as Record<
            string,
            unknown
          >;
          if (message['id'] === 1) {
            handle!.beginWorkspaceDrain('secondary-id');
            ws.send(JSON.stringify({ jsonrpc: '2.0', id: 99, result: {} }));
            ws.send(
              JSON.stringify({
                jsonrpc: '2.0',
                id: 2,
                method: 'unknown/mutation',
              }),
            );
            return;
          }
          if (message['id'] === 2) {
            ws.close();
            resolve(message);
          }
        });
        ws.on('error', reject);
      },
    );

    expect(reply).toMatchObject({
      error: { data: { code: 'workspace_draining' } },
    });
  });

  it('rejects a raw WS upgrade whose selector is a dot-segment (%2e%2e)', async () => {
    // `ws` normalizes the client URL (/workspaces/%2e%2e/acp -> /acp), so the
    // real attack surface — a raw, non-normalized request-target — must be
    // exercised with a bare socket. The daemon parses the raw request-target
    // (not `new URL().pathname`) and destroys the socket before any mount.
    const { createConnection } = await import('node:net');
    const outcome = await new Promise<'closed' | 'upgraded'>(
      (resolve, reject) => {
        const socket = createConnection(port, '127.0.0.1', () => {
          socket.write(
            'GET /workspaces/%2e%2e/acp HTTP/1.1\r\n' +
              `Host: 127.0.0.1:${port}\r\n` +
              'Upgrade: websocket\r\n' +
              'Connection: Upgrade\r\n' +
              'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
              'Sec-WebSocket-Version: 13\r\n\r\n',
          );
        });
        let buf = '';
        socket.setTimeout(2000, () => {
          socket.destroy();
          reject(new Error('timeout waiting for raw upgrade outcome'));
        });
        socket.on('data', (d) => {
          buf += d.toString();
        });
        socket.on('close', () =>
          resolve(buf.includes('101') ? 'upgraded' : 'closed'),
        );
        socket.on('error', () => resolve('closed'));
      },
    );
    expect(outcome).toBe('closed');
  });

  it('serves device-flow on a trusted secondary workspace via the shared registry', async () => {
    // Regression for the reviewer Critical: an earlier per-runtime device-flow
    // registry left secondary mounts unauthenticated ("Device flow not
    // configured"). With the daemon-global registry shared into every mount, the
    // request reaches provider resolution instead — an unsupported-provider
    // error here — which proves the registry is wired (never "not configured").
    const reply = await new Promise<{
      error?: { message?: string; data?: { errorKind?: string } };
    }>((resolve, reject) => {
      const ws = new WebSocket(
        `ws://127.0.0.1:${port}/workspaces/secondary-id/acp`,
        { handshakeTimeout: 2000 },
      );
      ws.on('open', () => ws.send(INITIALIZE));
      ws.on('message', (data: WebSocket.RawData) => {
        try {
          const msg = JSON.parse(data.toString()) as { id?: number };
          if (msg.id === 1) {
            ws.send(
              JSON.stringify({
                jsonrpc: '2.0',
                id: 2,
                method: '_qwen/workspace/auth/device_flow/start',
                params: { providerId: 'qwen' },
              }),
            );
            return;
          }
          if (msg.id === 2) {
            ws.close();
            resolve(
              msg as {
                error?: { message?: string; data?: { errorKind?: string } };
              },
            );
          }
        } catch (err) {
          reject(err as Error);
        }
      });
      ws.on('error', reject);
    });
    expect(reply.error?.message ?? '').not.toContain('not configured');
    expect(reply.error?.data?.errorKind).toBe('unsupported_provider');
  });

  it('runs secondary workspace remember tasks on the secondary bridge', async () => {
    await sendWsRequest('/workspaces/secondary-id/acp', {
      jsonrpc: '2.0',
      id: 2,
      method: '_qwen/workspace/memory/remember',
      params: { content: 'secondary-only memory' },
    });

    await vi.waitFor(() => {
      expect(secondaryBridge.runWorkspaceMemoryRemember).toHaveBeenCalledWith({
        content: 'secondary-only memory',
        contextMode: 'workspace',
      });
    });
    expect(primaryBridge.runWorkspaceMemoryRemember).not.toHaveBeenCalled();
  });

  it('rejects a WS upgrade to an unknown workspace selector', async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(
        `ws://127.0.0.1:${port}/workspaces/does-not-exist/acp`,
        { handshakeTimeout: 2000 },
      );
      ws.on('unexpected-response', (_req, res) => {
        resolve(res.statusCode ?? 0);
        ws.terminate();
      });
      ws.on('open', () => {
        ws.close();
        reject(new Error('unknown-selector WS upgrade should not open'));
      });
      ws.on('error', () => resolve(400));
    });
    expect(status).toBe(400);
  });

  it('sanitizes decoded selectors before logging WS rejection', async () => {
    vi.mocked(writeStderrLine).mockClear();
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(
        `ws://127.0.0.1:${port}/workspaces/evil%0AFORGED/acp`,
        { handshakeTimeout: 2000 },
      );
      ws.on('unexpected-response', () => {
        ws.terminate();
        resolve();
      });
      ws.on('open', () => {
        ws.close();
        reject(new Error('unknown workspace selector should not upgrade'));
      });
      ws.on('error', () => resolve());
    });

    expect(writeStderrLine).toHaveBeenCalledWith(
      expect.stringContaining('workspace-mismatch evil FORGED'),
    );
    for (const [message] of vi.mocked(writeStderrLine).mock.calls) {
      // eslint-disable-next-line no-control-regex
      expect(message).not.toMatch(/[\r\n\u001b]/u);
    }
  });

  it('does not let a secondary workspace claim the CDP tunnel', async () => {
    // The CDP-bridge claim is gated on activeMount.primary, so a secondary
    // workspace sending the CDP client name must NOT register the process-wide
    // tunnel (which would hijack browser automation from the primary).
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(
        `ws://127.0.0.1:${port}/workspaces/secondary-id/acp`,
        { handshakeTimeout: 2000 },
      );
      ws.on('open', () =>
        ws.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: { clientInfo: { name: 'qwen-cdp-bridge' } },
          }),
        ),
      );
      ws.on('message', () => {
        ws.close();
        resolve();
      });
      ws.on('error', reject);
    });
    expect(cdpRegistry.hasActive()).toBe(false);
  });
});
