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
  let deviceFlowRegistry: DeviceFlowRegistry | undefined;
  let cdpRegistry: CdpTunnelRegistry;

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

    deviceFlowRegistry = new DeviceFlowRegistry({
      events: { publish: () => {} },
      resolveProvider: () => undefined,
      scheduleInterval: () => 0 as unknown as ReturnType<typeof setInterval>,
      clearScheduledInterval: () => {},
    });
    cdpRegistry = new CdpTunnelRegistry();

    const app = express();
    app.use(express.json());
    handle = mountAcpHttp(app, primaryBridge, {
      boundWorkspace: '/ws',
      workspace: {} as unknown as DaemonWorkspaceService,
      enabled: true,
      workspaceRegistry: registry,
      deviceFlowRegistry,
      cdpTunnelOverWs: true,
      cdpTunnelRegistry: cdpRegistry,
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

  it('does not expose qualified HTTP or WS routes with one runtime', async () => {
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
      expect(qualified.status).toBe(404);

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
      expect(upgradeStatus).not.toBe(101);

      const legacy = await fetch(`http://127.0.0.1:${singlePort}/acp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: INITIALIZE,
      });
      expect(legacy.status).toBe(200);
    } finally {
      singleHandle.dispose();
      singleServer.closeAllConnections?.();
      await new Promise<void>((resolve) => singleServer.close(() => resolve()));
    }
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

  it('aggregates a connection snapshot across primary + trusted secondary mounts', () => {
    const snap = handle!.getSnapshot();
    // primary (workspaceId null) + the trusted secondary only; untrusted
    // workspaces get no mount, so they never appear in the aggregate snapshot.
    expect(snap.mounts).toHaveLength(2);
    expect(snap.mounts.find((m) => m.primary)?.workspaceId).toBeNull();
    const ids = snap.mounts.map((m) => m.workspaceId);
    expect(ids).toContain('secondary-id');
    expect(ids).not.toContain('untrusted-id');
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
