// @vitest-environment jsdom
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fetch as nodeFetch } from 'undici';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const fakeHandle = { name: 'my-dir' } as unknown as FileSystemDirectoryHandle;

vi.mock('./capabilities.js', () => ({
  detectLocalFilesCapability: () => ({ blocker: null }),
}));
vi.mock('./pick-directory.js', () => ({
  pickDirectoryHandle: vi.fn(async () => ({
    kind: 'picked',
    handle: fakeHandle,
  })),
  ensureReadwritePermission: vi.fn(async () => ({
    state: 'prompt',
    requested: false,
  })),
}));
vi.mock('./directory-handle-store.js', () => ({
  createDirectoryHandleStore: () => ({
    save: vi.fn(async () => true),
    load: vi.fn(async () => undefined),
    clear: vi.fn(async () => true),
  }),
}));
vi.mock('./local-directory.js', () => ({
  LocalDirectory: class {
    get name() {
      return 'my-dir';
    }
  },
}));

import { useManagedLocalFilesBridge } from './useManagedLocalFilesBridge.js';
import type { ManagedFetch } from './managed-client-files-bridge.js';

const peerFetch = ((url: string, init?: RequestInit) =>
  nodeFetch(url, init)) as unknown as ManagedFetch;

function startPeer(): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const path = req.url ?? '';
      if (path.endsWith('/client-files/register')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({ registered: true, generation: 1, toolCount: 2 }),
        );
        return;
      }
      if (path.endsWith('/client-files/requests/stream')) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(': open\n\n');
        return;
      }
      if (path.endsWith('/client-files/unregister')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ registered: false }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${port}/api/agent/web-shell/v1`,
      });
    });
  });
}

describe('useManagedLocalFilesBridge', () => {
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
            server.closeAllConnections();
          }),
      ),
    );
    vi.clearAllMocks();
  });

  it('connects through the picker and reports the tool count', async () => {
    const peer = await startPeer();
    servers.push(peer.server);
    const fakeWin = {
      location: { origin: 'http://localhost' },
    } as unknown as Window;
    const { result } = renderHook(() =>
      useManagedLocalFilesBridge({
        sessionId: 'session-1',
        baseUrl: peer.baseUrl,
        fetch: peerFetch,
        win: fakeWin,
      }),
    );
    act(() => {
      void result.current.connect();
    });
    await waitFor(() => expect(result.current.status.phase).toBe('connected'));
    expect(result.current.status.toolCount).toBe(2);
    expect(result.current.status.rootName).toBe('my-dir');
    await act(async () => {
      await result.current.disconnect();
    });
    expect(result.current.status.phase).toBe('idle');
  });

  it('does not connect without a session', async () => {
    const peer = await startPeer();
    servers.push(peer.server);
    const fakeWin = {
      location: { origin: 'http://localhost' },
    } as unknown as Window;
    const { result } = renderHook(() =>
      useManagedLocalFilesBridge({
        sessionId: undefined,
        baseUrl: peer.baseUrl,
        fetch: peerFetch,
        win: fakeWin,
      }),
    );
    await act(async () => {
      await result.current.connect();
    });
    expect(result.current.status.phase).not.toBe('connected');
  });
});
