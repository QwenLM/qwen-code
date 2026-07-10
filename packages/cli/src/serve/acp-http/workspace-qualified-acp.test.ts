/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import type { HttpAcpBridge } from '@qwen-code/acp-bridge/bridgeTypes';
import { type AcpHttpHandle, mountAcpHttp } from './index.js';
import {
  createWorkspaceRegistry,
  type WorkspaceRuntime,
  type WorkspaceRuntimeEnvMetadata,
} from '../workspace-registry.js';
import { ClientMcpSenderRegistry } from './client-mcp-sender-registry.js';
import { WorkspaceRememberTaskLane } from '../workspace-remember.js';
import type { WorkspaceFileSystemFactory } from '../fs/index.js';
import type { DaemonWorkspaceService } from '../workspace-service/types.js';

vi.mock('../../utils/stdioHelpers.js', () => ({ writeStderrLine: vi.fn() }));

const PARENT_ENV: WorkspaceRuntimeEnvMetadata = {
  mode: 'parent-process',
  overlayKeys: [],
};

function makeBridge(): HttpAcpBridge {
  // `initialize` is pure (AcpDispatcher.buildInitializeResult), and connection
  // teardown only calls `detachClient`, so a minimal stub is enough to exercise
  // the plural mount routing without a real ACP child.
  return {
    detachClient: async () => {},
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

describe('workspace-qualified ACP (/workspaces/:workspace/acp)', () => {
  let server: Server;
  let base: string;
  let port: number;
  let handle: AcpHttpHandle | undefined;

  beforeEach(async () => {
    const primaryBridge = makeBridge();
    const secondaryBridge = makeBridge();
    const untrustedBridge = makeBridge();

    const registry = createWorkspaceRegistry([
      makeRuntime({
        id: 'primary-id',
        cwd: '/ws',
        primary: true,
        trusted: true,
        bridge: primaryBridge,
      }),
      makeRuntime({
        id: 'secondary-id',
        cwd: '/ws-b',
        primary: false,
        trusted: true,
        bridge: secondaryBridge,
      }),
      makeRuntime({
        id: 'untrusted-id',
        cwd: '/ws-c',
        primary: false,
        trusted: false,
        bridge: untrustedBridge,
      }),
    ]);

    const app = express();
    app.use(express.json());
    handle = mountAcpHttp(app, primaryBridge, {
      boundWorkspace: '/ws',
      workspace: {} as unknown as DaemonWorkspaceService,
      enabled: true,
      workspaceRegistry: registry,
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

  it('routes initialize to a trusted secondary workspace by id', async () => {
    const res = await postInitialize('/workspaces/secondary-id/acp');
    expect(res.status).toBe(200);
    expect(res.headers.get('acp-connection-id')).toBeTruthy();
  });

  it('routes initialize to a trusted secondary workspace by encoded cwd', async () => {
    const res = await postInitialize(
      `/workspaces/${encodeURIComponent('/ws-b')}/acp`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('acp-connection-id')).toBeTruthy();
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

  it('routes a WS upgrade + initialize to a trusted secondary workspace', async () => {
    const result = await new Promise<{ result?: { protocolVersion?: number } }>(
      (resolve, reject) => {
        const ws = new WebSocket(
          `ws://127.0.0.1:${port}/workspaces/secondary-id/acp`,
          { handshakeTimeout: 2000 },
        );
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
      },
    );
    expect(result.result?.protocolVersion).toBeGreaterThanOrEqual(1);
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

  it('aggregates a connection snapshot across primary + secondary mounts', () => {
    const snap = handle!.getSnapshot();
    // primary (workspaceId null) + the two non-primary mounts.
    expect(snap.mounts).toHaveLength(3);
    expect(snap.mounts.find((m) => m.primary)?.workspaceId).toBeNull();
    const ids = snap.mounts.map((m) => m.workspaceId);
    expect(ids).toContain('secondary-id');
    expect(ids).toContain('untrusted-id');
    expect(snap.connectionCount).toBe(0);
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
});
