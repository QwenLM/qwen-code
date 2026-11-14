// @vitest-environment jsdom
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fetch as nodeFetch } from 'undici';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const fakeHandle = {
  name: 'my-dir',
  isSameEntry: async (other: unknown) => other === fakeHandle,
} as unknown as FileSystemDirectoryHandle;

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
import {
  ensureReadwritePermission,
  pickDirectoryHandle,
} from './pick-directory.js';
import type { ManagedFetch } from './managed-client-files-bridge.js';

const peerFetch = ((url: string, init?: RequestInit) =>
  nodeFetch(url, init)) as unknown as ManagedFetch;

function startPeer(unregisterGate?: Promise<void>): Promise<{
  server: Server;
  baseUrl: string;
  unregistered: Array<{ connectionId?: string }>;
  registeredConnectionId: () => string | undefined;
}> {
  // Like the real control plane: register blocks on the discovery the
  // browser drain answers; the stream pushes tools/list on open.
  let binding:
    | { generation: number; state: string; connectionId?: string }
    | undefined;
  const unregistered: Array<{ connectionId?: string }> = [];
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
        if (!binding) {
          res.end('');
          return;
        }
        // Mirror the server's ownership gate: the generation/identity is echoed
        // only to a caller that proves it knows the registration identity.
        const parsed = body
          ? (JSON.parse(body) as Record<string, unknown>)
          : {};
        const owned =
          parsed.connectionId !== undefined &&
          parsed.connectionId === binding.connectionId;
        res.end(
          JSON.stringify(
            owned
              ? { ...binding, owned: true }
              : { state: binding.state, owned: false },
          ),
        );
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
        const parsed = body
          ? (JSON.parse(body) as Record<string, unknown>)
          : {};
        unregistered.push({
          connectionId: parsed.connectionId as string | undefined,
        });
        if (unregisterGate) await unregisterGate;
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
        unregistered,
        registeredConnectionId: () => binding?.connectionId,
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

  it('resets the local-files status when switching Sessions', async () => {
    const peer = await startPeer();
    servers.push(peer.server);
    const fakeWin = {
      location: { origin: 'http://localhost' },
    } as unknown as Window;
    const { result, rerender } = renderHook(
      ({ sessionId }) =>
        useManagedLocalFilesBridge({
          sessionId,
          baseUrl: peer.baseUrl,
          fetch: peerFetch,
          win: fakeWin,
        }),
      { initialProps: { sessionId: 'session-A' } },
    );
    act(() => {
      void result.current.connect();
    });
    await waitFor(() => expect(result.current.status.phase).toBe('connected'));
    // The control is reused across Sessions without a key: switching must not
    // keep Session A's connected state, which would hide Connect for Session B.
    rerender({ sessionId: 'session-B' });
    await waitFor(() => expect(result.current.status.phase).toBe('idle'));
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
    // The origin-scoped slot still holds this mount's own directory, so
    // Disconnect may release it.
    storeSpies.load.mockResolvedValue(fakeHandle);
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

  it('disconnect leaves a peer tab’s different-directory grant in the shared slot', async () => {
    // The grant slot is origin-scoped (one record for every tab). A peer tab
    // re-granted a DIFFERENT directory into it; this tab's Disconnect must not
    // delete that peer's grant. A blind store.clear() (the pre-fix behavior)
    // turns this red.
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
    // A peer tab overwrote the shared slot with a different directory entry.
    const peerHandle = {
      name: 'peer-dir',
      isSameEntry: async (other: unknown) => other === peerHandle,
    } as unknown as FileSystemDirectoryHandle;
    storeSpies.load.mockResolvedValue(peerHandle);
    await act(async () => {
      await result.current.disconnect();
    });
    expect(result.current.status.phase).toBe('idle');
    expect(storeSpies.clear).not.toHaveBeenCalled();
  });

  it('a superseded bridge’s late stopped does not overwrite the live status', async () => {
    let releaseUnregister!: () => void;
    const unregisterGate = new Promise<void>((resolve) => {
      releaseUnregister = resolve;
    });
    const peer = await startPeer(unregisterGate);
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
    // Retry while the old bridge's unregister is held: its disconnect() emits
    // `stopped` only after that awaited POST, which must not clobber the new
    // bridge's status once the retry reaches connected.
    act(() => {
      void result.current.connect();
    });
    await waitFor(() => expect(result.current.status.phase).toBe('connected'));
    releaseUnregister();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(result.current.status.phase).toBe('connected');
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
    expect(peer.unregistered).toHaveLength(0);
    await act(async () => {
      listeners.get('pagehide')?.();
    });
    await waitFor(() => expect(result.current.status.phase).toBe('idle'));
    // The title's contract is that a closed tab releases the control-plane
    // binding, not merely that the local panel resets: observe the actual
    // unregister POST carrying the owned registration identity.
    await waitFor(() => expect(peer.unregistered).toHaveLength(1));
    expect(peer.unregistered[0].connectionId).toBe(
      peer.registeredConnectionId(),
    );
    expect(peer.unregistered[0].connectionId).toBeTruthy();
  });

  it('ignores a re-entrant connect while one is already in flight', async () => {
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
    // Two rapid Connect clicks: the second must be a no-op while the first is
    // in flight, not a second picker/registration racing the bridge ref.
    act(() => {
      void result.current.connect();
      void result.current.connect();
    });
    await waitFor(() => expect(result.current.status.phase).toBe('connected'));
    expect(vi.mocked(pickDirectoryHandle)).toHaveBeenCalledTimes(1);
    await act(async () => {
      await result.current.disconnect();
    });
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

  it('does not register when pagehide fires while the picker is open', async () => {
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
        fetch: countingFetch,
        win: fakeWin,
      }),
    );
    act(() => {
      void result.current.connect();
    });
    // The picker is still open; closing the tab must bump the generation (like
    // disconnect and the session cleanup) so the parked connect() bails before
    // saving a grant or registering a binding the pagehide tried to release.
    act(() => {
      listeners.get('pagehide')?.();
    });
    releasePicker({ kind: 'picked', handle: fakeHandle });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(registerCalls).toBe(0);
    expect(storeSpies.save).not.toHaveBeenCalled();
  });

  it('reaches the picker when a peer tab disconnected the stored grant', async () => {
    const peer = await startPeer();
    servers.push(peer.server);
    vi.mocked(ensureReadwritePermission).mockResolvedValue({
      state: 'granted',
      requested: false,
    });
    storeSpies.load.mockResolvedValue(fakeHandle);
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
    // Let the restore retain the granted handle.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(vi.mocked(pickDirectoryHandle)).not.toHaveBeenCalled();
    // A peer tab disconnects: the store no longer holds the grant, so Connect
    // must drop the retained handle and reach the picker instead of re-registering.
    storeSpies.load.mockResolvedValue(
      undefined as unknown as FileSystemDirectoryHandle,
    );
    act(() => {
      void result.current.connect();
    });
    await waitFor(() =>
      expect(vi.mocked(pickDirectoryHandle)).toHaveBeenCalled(),
    );
    await act(async () => {
      await result.current.disconnect();
    });
  });

  it('reaches the picker in the same click when a retained handle’s permission lapsed', async () => {
    const peer = await startPeer();
    servers.push(peer.server);
    vi.mocked(ensureReadwritePermission).mockResolvedValue({
      state: 'granted',
      requested: false,
    });
    storeSpies.load.mockResolvedValue(fakeHandle);
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
    // Restore retains the granted handle without opening the picker.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(vi.mocked(pickDirectoryHandle)).not.toHaveBeenCalled();
    // The grant lapses while the tab stays open.
    vi.mocked(ensureReadwritePermission).mockResolvedValue({
      state: 'prompt',
      requested: false,
    });
    act(() => {
      void result.current.connect();
    });
    // The same Connect click must drop the lapsed handle and reach the picker,
    // not silently return and only pick on a second click. Returning early on
    // the lapse (the pre-fix no-op) turns this red.
    await waitFor(() =>
      expect(vi.mocked(pickDirectoryHandle)).toHaveBeenCalled(),
    );
    await act(async () => {
      await result.current.disconnect();
    });
  });

  it('a plain connect reuses the retained grant without the picker', async () => {
    const peer = await startPeer();
    servers.push(peer.server);
    vi.mocked(ensureReadwritePermission).mockResolvedValue({
      state: 'granted',
      requested: false,
    });
    storeSpies.load.mockResolvedValue(fakeHandle);
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
    // Restore retains the granted handle without opening the picker.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(vi.mocked(pickDirectoryHandle)).not.toHaveBeenCalled();
    act(() => {
      void result.current.connect();
    });
    await waitFor(() => expect(result.current.status.phase).toBe('connected'));
    expect(vi.mocked(pickDirectoryHandle)).not.toHaveBeenCalled();
    await act(async () => {
      await result.current.disconnect();
    });
  });

  it('forcePicker opens the picker even with a retained grant', async () => {
    const peer = await startPeer();
    servers.push(peer.server);
    vi.mocked(ensureReadwritePermission).mockResolvedValue({
      state: 'granted',
      requested: false,
    });
    storeSpies.load.mockResolvedValue(fakeHandle);
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
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(vi.mocked(pickDirectoryHandle)).not.toHaveBeenCalled();
    // Change directory must open the picker despite the retained grant. Assert
    // the picker run itself, not a second full connection (the disposable
    // peer's single binding races across reconnects).
    act(() => {
      void result.current.connect({ forcePicker: true });
    });
    await waitFor(() =>
      expect(vi.mocked(pickDirectoryHandle)).toHaveBeenCalled(),
    );
    // A successful change must never clear the grant it just persisted.
    expect(storeSpies.clear).not.toHaveBeenCalled();
    await act(async () => {
      await result.current.disconnect();
    });
  });

  it('Change directory from the connected phase opens the picker again', async () => {
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
    // Self-contained setup: the first connect goes through the picker (no
    // stored grant), then the retained-grant reuse preconditions are made
    // explicit so the second connect discriminates on forcePicker alone —
    // not on mock implementations leaked from neighbouring tests.
    storeSpies.load.mockResolvedValue(
      undefined as unknown as FileSystemDirectoryHandle,
    );
    act(() => {
      void result.current.connect();
    });
    await waitFor(() => expect(result.current.status.phase).toBe('connected'));
    expect(vi.mocked(pickDirectoryHandle)).toHaveBeenCalledTimes(1);
    vi.mocked(ensureReadwritePermission).mockResolvedValue({
      state: 'granted',
      requested: false,
    });
    storeSpies.load.mockResolvedValue(fakeHandle);
    // The affordance only renders while connected. The re-entrancy guard must
    // be scoped to grant acquisition, not held for the bridge's connected
    // lifetime, or this click is a silent no-op (R1-1). Restoring the awaited
    // bridge.connect() makes this go red.
    act(() => {
      void result.current.connect({ forcePicker: true });
    });
    await waitFor(() =>
      expect(vi.mocked(pickDirectoryHandle)).toHaveBeenCalledTimes(2),
    );
    await act(async () => {
      await result.current.disconnect();
    });
  });

  it('a soft-failed save on Change directory keeps the live bridge and reports repick-failed', async () => {
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
    storeSpies.load.mockResolvedValue(
      undefined as unknown as FileSystemDirectoryHandle,
    );
    act(() => {
      void result.current.connect();
    });
    await waitFor(() => expect(result.current.status.phase).toBe('connected'));
    const firstId = peer.registeredConnectionId();
    storeSpies.load.mockResolvedValue(fakeHandle);
    storeSpies.save.mockResolvedValueOnce(false);
    const newHandle = {
      name: 'new-dir',
      isSameEntry: async (other: unknown) => other === newHandle,
    } as unknown as FileSystemDirectoryHandle;
    vi.mocked(pickDirectoryHandle).mockImplementationOnce(async () => ({
      kind: 'picked',
      handle: newHandle,
    }));
    let outcome: { kind: 'repick-failed' } | undefined;
    await act(async () => {
      outcome = await result.current.connect({ forcePicker: true });
    });
    // The change is rejected wholesale: the live bridge keeps serving the old
    // directory, the record keeps holding it, and the handler gets the toast
    // discriminant. Persisting the new handle must have been attempted.
    expect(outcome).toEqual({ kind: 'repick-failed' });
    expect(storeSpies.save).toHaveBeenCalledWith(newHandle);
    expect(storeSpies.clear).not.toHaveBeenCalled();
    expect(peer.unregistered).toEqual([]);
    expect(peer.registeredConnectionId()).toBe(firstId);
    expect(result.current.status.phase).toBe('connected');
    expect(result.current.status.rootName).toBe('my-dir');
    // The retained handle was rolled back: a plain connect reuses the OLD
    // directory without opening the picker. Dropping the rollback would
    // reuse the rejected new handle here instead.
    vi.mocked(ensureReadwritePermission).mockResolvedValue({
      state: 'granted',
      requested: false,
    });
    vi.mocked(pickDirectoryHandle).mockClear();
    await act(async () => {
      await result.current.connect();
    });
    expect(vi.mocked(pickDirectoryHandle)).not.toHaveBeenCalled();
    expect(result.current.status.rootName).toBe('my-dir');
    await act(async () => {
      await result.current.disconnect();
    });
  });

  it('re-confirming the bound entry re-persists a lost grant without re-registering', async () => {
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
    storeSpies.load.mockResolvedValue(
      undefined as unknown as FileSystemDirectoryHandle,
    );
    act(() => {
      void result.current.connect();
    });
    await waitFor(() => expect(result.current.status.phase).toBe('connected'));
    const firstId = peer.registeredConnectionId();
    // A peer tab's Disconnect cleared the origin-scoped record. The default
    // picker returns the already-bound handle (fixed PICKER_ID reopens the
    // last choice): confirming without navigating must re-persist the grant
    // (daemon order: save first) yet never tear down the live registration.
    storeSpies.load.mockResolvedValue(
      undefined as unknown as FileSystemDirectoryHandle,
    );
    storeSpies.save.mockClear();
    let outcome: { kind: 'repick-failed' } | undefined = {
      kind: 'repick-failed',
    };
    await act(async () => {
      outcome = await result.current.connect({ forcePicker: true });
    });
    expect(outcome).toBeUndefined();
    expect(storeSpies.save).toHaveBeenCalledWith(fakeHandle);
    expect(storeSpies.clear).not.toHaveBeenCalled();
    expect(peer.unregistered).toEqual([]);
    expect(peer.registeredConnectionId()).toBe(firstId);
    expect(result.current.status.phase).toBe('connected');
    await act(async () => {
      await result.current.disconnect();
    });
  });

  it('a throwing isSameEntry fails closed and rebuilds onto the picked entry', async () => {
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
    const throwingHandle = {
      name: 'throw-dir',
      isSameEntry: async () => {
        throw new Error('identity unavailable');
      },
    } as unknown as FileSystemDirectoryHandle;
    storeSpies.load.mockResolvedValue(
      undefined as unknown as FileSystemDirectoryHandle,
    );
    vi.mocked(pickDirectoryHandle).mockImplementationOnce(async () => ({
      kind: 'picked',
      handle: throwingHandle,
    }));
    act(() => {
      void result.current.connect();
    });
    await waitFor(() => expect(result.current.status.phase).toBe('connected'));
    storeSpies.load.mockResolvedValue(throwingHandle);
    const newHandle = {
      name: 'new-dir',
      isSameEntry: async (other: unknown) => other === newHandle,
    } as unknown as FileSystemDirectoryHandle;
    vi.mocked(pickDirectoryHandle).mockImplementationOnce(async () => ({
      kind: 'picked',
      handle: newHandle,
    }));
    let outcome: { kind: 'repick-failed' } | undefined = {
      kind: 'repick-failed',
    };
    await act(async () => {
      outcome = await result.current.connect({ forcePicker: true });
    });
    // Identity that cannot be proven is not "same": the change proceeds
    // instead of rejecting (or throwing out of connect).
    expect(outcome).toBeUndefined();
    await waitFor(() => expect(result.current.status.rootName).toBe('new-dir'));
    await act(async () => {
      await result.current.disconnect();
    });
  });

  it('a successful Change directory save persists the picked handle and never clears', async () => {
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
    storeSpies.load.mockResolvedValue(
      undefined as unknown as FileSystemDirectoryHandle,
    );
    act(() => {
      void result.current.connect();
    });
    await waitFor(() => expect(result.current.status.phase).toBe('connected'));
    storeSpies.load.mockResolvedValue(fakeHandle);
    const newHandle = {
      name: 'new-dir',
      isSameEntry: async (other: unknown) => other === newHandle,
    } as unknown as FileSystemDirectoryHandle;
    vi.mocked(pickDirectoryHandle).mockImplementationOnce(async () => ({
      kind: 'picked',
      handle: newHandle,
    }));
    let outcome: { kind: 'repick-failed' } | undefined = {
      kind: 'repick-failed',
    };
    await act(async () => {
      outcome = await result.current.connect({ forcePicker: true });
    });
    expect(outcome).toBeUndefined();
    // WHICH handle was persisted is the contract: the picked one, not the
    // retained one; and a committed save is never followed by a clear.
    expect(storeSpies.save).toHaveBeenCalledWith(newHandle);
    expect(storeSpies.clear).not.toHaveBeenCalled();
    await waitFor(() => expect(result.current.status.rootName).toBe('new-dir'));
    // A real change releases the superseded registration; dropping the
    // teardown would leave the old binding active on the control plane.
    await waitFor(() => expect(peer.unregistered.length).toBe(1));
    await act(async () => {
      await result.current.disconnect();
    });
  });

  it('a failed forcePicker re-pick keeps the running bridge connected', async () => {
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
    vi.mocked(pickDirectoryHandle).mockResolvedValueOnce({
      kind: 'failed',
      message: 'boom',
    });
    let outcome: { kind: 'repick-failed' } | undefined;
    await act(async () => {
      outcome = await result.current.connect({ forcePicker: true });
    });
    // The re-pick must actually have run (guard not held), and its failure must
    // not misreport the still-running bridge. The return contract is what
    // makes the failure non-silent: the control toasts on this discriminant.
    expect(vi.mocked(pickDirectoryHandle)).toHaveBeenCalledTimes(2);
    expect(outcome).toEqual({ kind: 'repick-failed' });
    expect(result.current.status.phase).toBe('connected');
    await act(async () => {
      await result.current.disconnect();
    });
  });

  it('a cancelled forcePicker re-pick stays silent and keeps the bridge', async () => {
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
    // The module-mocked picker reports cancellation the way the real
    // pickDirectoryHandle translates an AbortError.
    vi.mocked(pickDirectoryHandle).mockResolvedValueOnce({ kind: 'cancelled' });
    let outcome: { kind: 'repick-failed' } | undefined = {
      kind: 'repick-failed',
    };
    await act(async () => {
      outcome = await result.current.connect({ forcePicker: true });
    });
    // A dismissed picker is not a failure: the handler must stay silent.
    expect(outcome).toBeUndefined();
    expect(result.current.status.phase).toBe('connected');
    await act(async () => {
      await result.current.disconnect();
    });
  });
});
