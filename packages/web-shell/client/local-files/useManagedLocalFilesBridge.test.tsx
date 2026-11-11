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
const storeSpies = vi.hoisted(() => ({
  save: vi.fn(async () => true),
  load: vi.fn(async () => undefined as unknown as FileSystemDirectoryHandle),
  clear: vi.fn(async () => true),
}));
vi.mock('./directory-handle-store.js', () => ({
  createDirectoryHandleStore: () => storeSpies,
}));
vi.mock('./local-directory.js', () => ({
  LocalDirectory: class {
    get name() {
      return 'my-dir';
    }
  },
}));

import { useManagedLocalFilesBridge } from './useManagedLocalFilesBridge.js';
import { pickDirectoryHandle } from './pick-directory.js';
import type { ManagedFetch } from './managed-client-files-bridge.js';

const peerFetch = ((url: string, init?: RequestInit) =>
  nodeFetch(url, init)) as unknown as ManagedFetch;

function startPeer(): Promise<{ server: Server; baseUrl: string }> {
  // Like the real control plane: register blocks on the discovery the
  // browser drain answers; the stream pushes tools/list on open.
  let binding:
    | { generation: number; state: string; connectionId?: string }
    | undefined;
  let resolveRegister: (() => void) | undefined;
  const registerDone = new Promise<void>((resolve) => {
    resolveRegister = resolve;
  });
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', async () => {
      const path = req.url ?? '';
      if (path.endsWith('/client-files/register')) {
        const parsed = body
          ? (JSON.parse(body) as Record<string, unknown>)
          : {};
        binding = {
          generation: 1,
          state: 'active',
          connectionId: parsed.connectionId as string | undefined,
        };
        await registerDone;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            generation: 1,
            toolCount: 2,
            connectionId: parsed.connectionId,
          }),
        );
        return;
      }
      if (path.endsWith('/client-files/status')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(binding ? JSON.stringify(binding) : '');
        return;
      }
      if (path.endsWith('/client-files/requests/stream')) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(': open\n\n');
        res.write(
          `event: request\ndata: ${JSON.stringify({
            requestId: 'd1',
            payloadJson: JSON.stringify({
              jsonrpc: '2.0',
              id: 'd1',
              method: 'tools/list',
            }),
          })}\n\n`,
        );
        return;
      }
      if (path.endsWith('/client-files/responses')) {
        resolveRegister?.();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ settled: true }));
        return;
      }
      if (path.endsWith('/client-files/unregister')) {
        if (binding) binding.state = 'closed';
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

  it('disconnect releases the grant so the picker is reached again', async () => {
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
    expect(vi.mocked(pickDirectoryHandle)).toHaveBeenCalledTimes(1);
    await act(async () => {
      await result.current.disconnect();
    });
    expect(storeSpies.clear).toHaveBeenCalled();
    act(() => {
      void result.current.connect();
    });
    await waitFor(() => expect(result.current.status.phase).toBe('connected'));
    expect(vi.mocked(pickDirectoryHandle)).toHaveBeenCalledTimes(2);
    await act(async () => {
      await result.current.disconnect();
    });
  });

  it('unregisters the binding on pagehide', async () => {
    const peer = await startPeer();
    servers.push(peer.server);
    const listeners = new Map<string, () => void>();
    const fakeWin = {
      location: { origin: 'http://localhost' },
      addEventListener: (event: string, handler: () => void) =>
        listeners.set(event, handler),
      removeEventListener: (event: string) => listeners.delete(event),
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
    expect(listeners.has('pagehide')).toBe(true);
    await act(async () => {
      listeners.get('pagehide')?.();
    });
    await waitFor(() => expect(result.current.status.phase).toBe('idle'));
  });

  it('does not register when unmounted while the picker is open', async () => {
    const peer = await startPeer();
    servers.push(peer.server);
    let registerCalls = 0;
    const countingFetch = ((url: string, init?: RequestInit) => {
      if (String(url).endsWith('/client-files/register')) registerCalls += 1;
      return nodeFetch(url, init);
    }) as unknown as ManagedFetch;
    let releasePicker!: (value: {
      kind: 'picked';
      handle: FileSystemDirectoryHandle;
    }) => void;
    const pickerGate = new Promise<{
      kind: 'picked';
      handle: FileSystemDirectoryHandle;
    }>((resolve) => {
      releasePicker = resolve;
    });
    vi.mocked(pickDirectoryHandle).mockImplementationOnce(
      () => pickerGate as ReturnType<typeof pickDirectoryHandle>,
    );
    const fakeWin = {
      location: { origin: 'http://localhost' },
    } as unknown as Window;
    const { result, unmount } = renderHook(() =>
      useManagedLocalFilesBridge({
        sessionId: 'session-1',
        baseUrl: peer.baseUrl,
        fetch: countingFetch,
        win: fakeWin,
      }),
    );
    act(() => {
      void result.current.connect();
    });
    // The picker is still open; unmounting bumps the generation so the parked
    // connect() must bail before saving a grant or registering a bridge.
    unmount();
    releasePicker({ kind: 'picked', handle: fakeHandle });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(registerCalls).toBe(0);
    expect(storeSpies.save).not.toHaveBeenCalled();
  });
});
