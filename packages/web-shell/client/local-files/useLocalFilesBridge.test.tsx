/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LocalFilesWindowLike } from './capabilities.js';
import type { DirectoryHandleStore } from './directory-handle-store.js';
import type {
  LockManagerLike,
  WebSocketHandlers,
  WebSocketLike,
} from './bridge-client.js';
import {
  useLocalFilesBridge,
  type UseLocalFilesBridgeOptions,
} from './useLocalFilesBridge.js';

class FakeSocket implements WebSocketLike {
  readonly sent: Array<Record<string, unknown>> = [];
  closeCount = 0;
  private handlers: WebSocketHandlers | undefined;

  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {}

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close(): void {
    this.closeCount += 1;
    this.handlers?.close(1006, 'closed');
  }
  setHandlers(handlers: WebSocketHandlers): void {
    this.handlers = handlers;
  }
  framesOfType(type: string): Array<Record<string, unknown>> {
    return this.sent.filter((frame) => frame['type'] === type);
  }
  emitOpen(): void {
    this.handlers?.open();
  }
  emit(frame: unknown): void {
    this.handlers?.message(JSON.stringify(frame));
  }
}

function fakeHandle(
  name: string,
  permissions: { query?: PermissionState; request?: PermissionState } = {},
): FileSystemDirectoryHandle {
  const handle = {
    kind: 'directory',
    name,
    queryPermission: vi.fn(async () => permissions.query ?? 'prompt'),
    requestPermission: vi.fn(async () => permissions.request ?? 'granted'),
    getDirectoryHandle: vi.fn(async () => {
      throw Object.assign(new Error('no such dir'), { name: 'NotFoundError' });
    }),
    getFileHandle: vi.fn(async () => {
      throw Object.assign(new Error('no such file'), { name: 'NotFoundError' });
    }),
    values: vi.fn(() => ({
      async next() {
        return { value: undefined, done: true as const };
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    })),
    // Entry identity per handle object: a different fakeHandle is a
    // different directory; only this very object is the same entry.
    isSameEntry: vi.fn(async (other: unknown) => other === handle),
  } as unknown as FileSystemDirectoryHandle;
  return handle;
}

function fakeStore(
  initial?: FileSystemDirectoryHandle,
): DirectoryHandleStore & {
  saves: FileSystemDirectoryHandle[];
  clears: number;
} {
  let stored = initial;
  const saves: FileSystemDirectoryHandle[] = [];
  let clears = 0;
  return {
    saves,
    get clears() {
      return clears;
    },
    async save(handle) {
      saves.push(handle);
      stored = handle;
      return true;
    },
    async load() {
      return stored;
    },
    async clear() {
      clears += 1;
      stored = undefined;
      return true;
    },
  };
}

function secureWindow(
  pick?: (options?: unknown) => Promise<FileSystemDirectoryHandle>,
): LocalFilesWindowLike {
  const self = {};
  return {
    isSecureContext: true,
    showDirectoryPicker: pick,
    self,
    top: self,
  };
}

/**
 * Exclusive owner lock: `ifAvailable` declines while held, and the holder
 * releases in a `finally`, so an unmount or stop frees it. Shared by every
 * two-tab case so a change to the bridge's lock acquisition cannot leave
 * one fake simulating stale semantics.
 */
function exclusiveLocks(): LockManagerLike {
  const lock = { held: false };
  return {
    request: async (_name, options, callback) => {
      // A conformant manager declines an ifAvailable request by invoking
      // the callback with null (Web Locks 4.1), not by skipping it.
      if (lock.held && options.ifAvailable) return callback(null);
      lock.held = true;
      try {
        await callback({});
      } finally {
        lock.held = false;
      }
    },
  };
}

/**
 * Owner lock whose decline cause can be a still-settling release: an
 * `ifAvailable` request declines while a peer holds the lock or while the
 * settling counter lasts, so an arbitration's first attempt can be declined
 * with the lock itself already free.
 */
function settlingLocks(lock: { held: boolean; settling: number }) {
  const locks: LockManagerLike = {
    request: async (_name, options, callback) => {
      if (options.ifAvailable && (lock.held || lock.settling > 0)) {
        if (!lock.held) lock.settling -= 1;
        return callback(null);
      }
      lock.held = true;
      try {
        await callback({});
      } finally {
        lock.held = false;
      }
      return undefined;
    },
  };
  return locks;
}

interface Harness {
  get(): ReturnType<typeof useLocalFilesBridge>;
  unmount(): void;
  rerender(next: Partial<UseLocalFilesBridgeOptions>): void;
  sockets: FakeSocket[];
  flush(): Promise<void>;
}

let activeRoot: Root | undefined;
let activeContainer: HTMLDivElement | undefined;

function render(options: UseLocalFilesBridgeOptions): Harness {
  const sockets: FakeSocket[] = [];
  let current: UseLocalFilesBridgeOptions = options;
  let api!: ReturnType<typeof useLocalFilesBridge>;
  function Probe() {
    api = useLocalFilesBridge({
      ...current,
      openSocket: (url, protocols) => {
        const socket = new FakeSocket(url, protocols);
        sockets.push(socket);
        return socket;
      },
      locks: current.locks === undefined ? null : current.locks,
    });
    return null;
  }
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<Probe />);
  });
  activeRoot = root;
  activeContainer = container;
  return {
    get: () => api,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
    rerender: (next) => {
      current = { ...current, ...next };
      act(() => {
        root.render(<Probe />);
      });
    },
    sockets,
    flush: async () => {
      await act(async () => {
        await Promise.resolve();
      });
    },
  };
}

afterEach(() => {
  if (activeRoot && activeContainer) {
    act(() => {
      activeRoot?.unmount();
    });
    activeContainer.remove();
  }
  activeRoot = undefined;
  activeContainer = undefined;
});

describe('useLocalFilesBridge context gating', () => {
  it('reports an insecure origin without offering a connect path', async () => {
    const h = render({
      sessionId: 'session-1',
      baseUrl: 'http://10.0.0.5:4170',
      win: {
        isSecureContext: false,
        showDirectoryPicker: () => Promise.resolve(fakeHandle('x')),
        self: {},
        top: {},
      },
      store: fakeStore(),
    });
    await h.flush();
    expect(h.get().status).toEqual({
      phase: 'unavailable',
      blocker: 'insecure-context',
    });

    await act(async () => {
      await h.get().connect();
    });
    expect(h.sockets).toHaveLength(0);
    h.unmount();
  });

  it('reports a cross-origin frame — the extension side panel shape', async () => {
    const top = {};
    Object.defineProperty(top, 'location', {
      get() {
        throw new DOMException('Blocked', 'SecurityError');
      },
    });
    const h = render({
      sessionId: 'session-1',
      baseUrl: 'https://daemon.example/',
      win: {
        isSecureContext: true,
        showDirectoryPicker: () => Promise.resolve(fakeHandle('x')),
        self: {},
        top,
      },
      store: fakeStore(),
    });
    await h.flush();
    expect(h.get().status.blocker).toBe('cross-origin-frame');
    h.unmount();
  });
});

describe('useLocalFilesBridge connect', () => {
  it('picks, persists, and registers against the session', async () => {
    const handle = fakeHandle('ai_coding', { query: 'granted' });
    const pick = vi.fn(async () => handle);
    const store = fakeStore();
    const h = render({
      sessionId: 'session-1',
      baseUrl: 'https://daemon.example/',
      win: secureWindow(pick),
      store,
    });
    await h.flush();
    expect(h.get().status.phase).toBe('idle');

    await act(async () => {
      await h.get().connect();
    });
    await h.flush();

    expect(pick).toHaveBeenCalledOnce();
    expect(store.saves).toEqual([handle]);
    expect(h.sockets).toHaveLength(1);
    const socket = h.sockets[0]!;
    expect(socket.url).toBe('wss://daemon.example/acp');

    socket.emitOpen();
    socket.emit({
      jsonrpc: '2.0',
      id: 'local-files-acp-initialize',
      result: {},
    });
    await h.flush();
    expect(socket.framesOfType('mcp_register')).toEqual([
      {
        type: 'mcp_register',
        server: 'local-files',
        sessionId: 'session-1',
      },
    ]);

    socket.emit({
      type: 'mcp_registered',
      server: 'local-files',
      toolCount: 4,
    });
    await h.flush();
    expect(h.get().status).toEqual({
      phase: 'connected',
      blocker: null,
      rootName: 'ai_coding',
      toolCount: 4,
    });
    h.unmount();
  });

  it('keeps the grant when no session exists yet and starts once one appears', async () => {
    const handle = fakeHandle('ai_coding', { query: 'granted' });
    const store = fakeStore();
    const h = render({
      sessionId: undefined,
      baseUrl: 'https://daemon.example/',
      win: secureWindow(async () => handle),
      store,
    });
    await h.flush();

    await act(async () => {
      await h.get().connect();
    });
    await h.flush();
    expect(h.get().status.phase).toBe('needs-session');
    expect(h.sockets).toHaveLength(0);
    // The handle must survive: without it the rebind below has nothing to start.
    expect(store.saves).toEqual([handle]);

    h.rerender({ sessionId: 'session-9' });
    await h.flush();
    expect(h.sockets).toHaveLength(1);
    h.sockets[0]!.emitOpen();
    h.sockets[0]!.emit({
      jsonrpc: '2.0',
      id: 'local-files-acp-initialize',
      result: {},
    });
    await h.flush();
    expect(h.sockets[0]!.framesOfType('mcp_register')).toEqual([
      { type: 'mcp_register', server: 'local-files', sessionId: 'session-9' },
    ]);
    h.unmount();
  });

  it('does not report a dismissed picker as a failure', async () => {
    const pick = vi.fn(async () => {
      throw new DOMException('aborted', 'AbortError');
    });
    const h = render({
      sessionId: 'session-1',
      baseUrl: 'https://daemon.example/',
      win: secureWindow(pick),
      store: fakeStore(),
    });
    await h.flush();
    await act(async () => {
      await h.get().connect();
    });
    await h.flush();
    expect(h.get().status.phase).toBe('idle');
    expect(h.sockets).toHaveLength(0);
    h.unmount();
  });
});

describe('useLocalFilesBridge restore', () => {
  it('reconnects silently after a reload when the permission is still granted', async () => {
    const handle = fakeHandle('ai_coding', { query: 'granted' });
    const pick = vi.fn(async () => handle);
    const h = render({
      sessionId: 'session-1',
      baseUrl: 'https://daemon.example/',
      win: secureWindow(pick),
      store: fakeStore(handle),
    });
    await h.flush();
    await h.flush();

    // No picker run and no gesture: this is the reload path.
    expect(pick).not.toHaveBeenCalled();
    expect(handle.requestPermission).not.toHaveBeenCalled();
    expect(h.sockets).toHaveLength(1);
    h.unmount();
  });

  it('waits for a real click when the stored permission came back as prompt', async () => {
    const handle = fakeHandle('ai_coding', {
      query: 'prompt',
      request: 'granted',
    });
    const h = render({
      sessionId: 'session-1',
      baseUrl: 'https://daemon.example/',
      win: secureWindow(async () => handle),
      store: fakeStore(handle),
    });
    await h.flush();
    await h.flush();
    expect(h.get().status.phase).toBe('needs-gesture');
    expect(h.sockets).toHaveLength(0);
    expect(handle.requestPermission).not.toHaveBeenCalled();

    // The click supplies the activation requestPermission() consumes.
    await act(async () => {
      await h.get().connect();
    });
    await h.flush();
    expect(handle.requestPermission).toHaveBeenCalledWith({
      mode: 'readwrite',
    });
    expect(h.sockets).toHaveLength(1);
    h.unmount();
  });

  it('asks for another click when a denied request consumed the gesture', async () => {
    const handle = fakeHandle('ai_coding', {
      query: 'prompt',
      request: 'denied',
    });
    const pick = vi.fn(async () => handle);
    const h = render({
      sessionId: 'session-1',
      baseUrl: 'https://daemon.example/',
      win: secureWindow(pick),
      store: fakeStore(handle),
    });
    await h.flush();
    await h.flush();
    expect(h.get().status.phase).toBe('needs-gesture');

    await act(async () => {
      await h.get().connect();
    });
    await h.flush();
    // requestPermission consumed the click's activation: a gesture-less
    // picker would reject SecurityError, so connect stops here.
    expect(pick).not.toHaveBeenCalled();
    expect(h.get().status.phase).toBe('needs-gesture');
    expect(h.sockets).toHaveLength(0);

    // The ungranted handle must not leak into handleRef: a session switch
    // would otherwise start a bridge whose every call the browser rejects.
    h.rerender({ sessionId: 'session-2' });
    await h.flush();
    expect(h.sockets).toHaveLength(0);
    expect(h.get().status.phase).toBe('needs-gesture');
    h.unmount();
  });

  it('rebinds onto the qualified mount when the selector resolves late', async () => {
    const handle = fakeHandle('ai_coding', { query: 'granted' });
    const h = render({
      sessionId: 'session-1',
      baseUrl: 'https://daemon.example/',
      win: secureWindow(async () => handle),
      store: fakeStore(handle),
    });
    await h.flush();
    await h.flush();
    expect(h.sockets).toHaveLength(1);
    expect(h.sockets[0]!.url).toBe('wss://daemon.example/acp');

    // Capabilities arrive after the bridge started (reload against a
    // multi-workspace daemon): the rebind must follow the selector onto the
    // mount that owns the session.
    h.rerender({
      sessionId: 'session-1',
      workspaceSelector: { kind: 'id', value: 'ws-2' },
    });
    await h.flush();
    expect(h.sockets).toHaveLength(2);
    // The replaced socket must be closed: close is the daemon's
    // server-removal signal, so a leaked one keeps a stale registration.
    expect(h.sockets[0]!.closeCount).toBe(1);
    expect(h.sockets[1]!.url).toBe('wss://daemon.example/workspaces/ws-2/acp');
    h.unmount();
  });

  it('re-queries permission before rebinding onto a new session', async () => {
    const perms: { query?: PermissionState; request?: PermissionState } = {
      query: 'granted',
    };
    const handle = fakeHandle('ai_coding', perms);
    const h = render({
      sessionId: 'session-1',
      baseUrl: 'https://daemon.example/',
      win: secureWindow(async () => handle),
      store: fakeStore(handle),
    });
    await h.flush();
    await h.flush();
    expect(h.sockets).toHaveLength(1);

    // The grant lapses after the original connect (revoked in site settings):
    // the rebind must not re-register a bridge whose calls all reject.
    perms.query = 'prompt';
    h.rerender({ sessionId: 'session-2' });
    await h.flush();
    await h.flush();
    expect(h.sockets).toHaveLength(1);
    expect(h.get().status.phase).toBe('needs-gesture');
    // The lapsed session's bridge must be stopped: close is the daemon's
    // server-removal signal, so a leaked socket keeps a live registration.
    expect(h.sockets[0]!.closeCount).toBe(1);
    h.unmount();
  });

  it('does not resurrect the bridge when disconnect lands during the rebind query', async () => {
    const handle = fakeHandle('ai_coding', { query: 'granted' });
    const h = render({
      sessionId: 'session-1',
      baseUrl: 'https://daemon.example/',
      win: secureWindow(async () => handle),
      store: fakeStore(handle),
    });
    await h.flush();
    await h.flush();
    expect(h.sockets).toHaveLength(1);

    // The rebind query is in flight when the user disconnects: the
    // continuation must not start a bridge behind the disconnect.
    h.rerender({ sessionId: 'session-2' });
    await act(async () => {
      await h.get().disconnect();
    });
    await h.flush();
    await h.flush();
    expect(h.sockets).toHaveLength(1);
    expect(h.get().status.phase).toBe('idle');
    h.unmount();
  });

  it('does not revive a peer-disconnected grant on session switch', async () => {
    const handle = fakeHandle('ai_coding', { query: 'granted' });
    const store = fakeStore(handle);
    const locks = exclusiveLocks();
    const common = {
      baseUrl: 'https://daemon.example/',
      win: secureWindow(async () => handle),
      store,
      locks,
      // The lock-retry loop would otherwise wait real 100ms delays.
      delay: async () => {},
    };
    const hA = render({ ...common, sessionId: 'session-A' });
    await hA.flush();
    await hA.flush();
    expect(hA.sockets).toHaveLength(1);

    // Tab B restores the same grant and parks behind tab A's lock.
    const hB = render({ ...common, sessionId: 'session-B' });
    await hB.flush();
    await hB.flush();
    expect(hB.get().status.phase).toBe('held-elsewhere');
    expect(hB.sockets).toHaveLength(0);

    // Tab A disconnects: the store is cleared with no signal reaching B.
    await act(async () => {
      await hA.get().disconnect();
    });
    await hB.flush();

    // B's rebind must consult the store: the grant is gone, so no bridge.
    hB.rerender({ ...common, sessionId: 'session-C' });
    await hB.flush();
    await hB.flush();
    expect(hB.sockets).toHaveLength(0);
    expect(hB.get().status.phase).toBe('idle');
    hA.unmount();
    hB.unmount();
  });

  it('clears a latched unavailable status when the blocker clears', async () => {
    const handle = fakeHandle('ai_coding', { query: 'granted' });
    const common = {
      baseUrl: 'https://daemon.example/',
      win: secureWindow(async () => handle),
      store: fakeStore(),
    };
    const h = render({
      ...common,
      sessionId: 'session-1',
      withheldBlocker: 'workspace-ineligible',
    });
    await h.flush();
    expect(h.get().status).toEqual({
      phase: 'unavailable',
      blocker: 'workspace-ineligible',
    });

    // Without an unavailable -> idle edge the panel would render no Connect
    // affordance for the life of the mount once the blocker clears.
    h.rerender({
      ...common,
      sessionId: 'session-1',
      withheldBlocker: undefined,
    });
    await h.flush();
    await h.flush();
    expect(h.get().status).toEqual({ phase: 'idle', blocker: null });
    h.unmount();
  });

  it('registers nothing when a blocker lands while restore is parked', async () => {
    const handle = fakeHandle('ai_coding', { query: 'granted' });
    let resolveLoad:
      | ((value: FileSystemDirectoryHandle | undefined) => void)
      | undefined;
    const store = {
      save: async () => true,
      load: () =>
        new Promise<FileSystemDirectoryHandle | undefined>((resolve) => {
          resolveLoad = resolve;
        }),
      clear: async () => true,
    };
    const common = {
      baseUrl: 'https://daemon.example/',
      win: secureWindow(async () => handle),
      store,
    };
    const h = render({ ...common, sessionId: 'session-1' });
    await h.flush();

    // restore() is parked in store.load(); the blocker lands meanwhile and
    // the parked continuation must fail closed when it resumes.
    h.rerender({
      ...common,
      sessionId: 'session-1',
      withheldBlocker: 'workspace-ineligible',
    });
    await h.flush();
    resolveLoad!(handle);
    await h.flush();
    await h.flush();
    expect(h.sockets).toHaveLength(0);
    // The stored grant is named under the blocker so the panel's Disconnect
    // (the only revoke path) stays reachable.
    expect(h.get().status).toEqual({
      phase: 'unavailable',
      blocker: 'workspace-ineligible',
      rootName: 'ai_coding',
    });
    h.unmount();
  });

  it('holds while resolving and restores once the blocker clears', async () => {
    const handle = fakeHandle('ai_coding', { query: 'granted' });
    const common = {
      baseUrl: 'https://daemon.example/',
      win: secureWindow(async () => handle),
      store: fakeStore(handle),
    };
    const h = render({
      ...common,
      sessionId: 'session-1',
      withheldBlocker: 'workspace-resolving',
    });
    await h.flush();
    await h.flush();
    // Pending judgement must not start a bridge (fail-open onto the primary
    // mount is the trust-gate hole this closes).
    expect(h.sockets).toHaveLength(0);

    h.rerender({
      ...common,
      sessionId: 'session-1',
      withheldBlocker: undefined,
    });
    await h.flush();
    await h.flush();
    expect(h.sockets).toHaveLength(1);
    h.unmount();
  });

  it('a bystander tab disconnecting does not wipe the owner grant', async () => {
    const handle = fakeHandle('ai_coding', { query: 'granted' });
    const store = fakeStore(handle);
    const locks = exclusiveLocks();
    const common = {
      baseUrl: 'https://daemon.example/',
      win: secureWindow(async () => handle),
      store,
      locks,
      delay: async () => {},
    };
    const hA = render({ ...common, sessionId: 'session-A' });
    await hA.flush();
    await hA.flush();
    expect(hA.sockets).toHaveLength(1);

    const hB = render({ ...common, sessionId: 'session-B' });
    await hB.flush();
    await hB.flush();
    expect(hB.get().status.phase).toBe('held-elsewhere');

    await act(async () => {
      await hB.get().disconnect();
    });
    await hB.flush();
    // The bystander never persisted anything: the origin-global record is
    // the OWNER's and must survive its disconnect.
    expect(store.clears).toBe(0);
    expect(await store.load()).toBe(handle);
    hA.unmount();
    hB.unmount();
  });

  it('does not re-attach on a blocker flip after a declined disconnect', async () => {
    const handle = fakeHandle('ai_coding', { query: 'granted' });
    const store = fakeStore(handle);
    const locks = exclusiveLocks();
    const common = {
      baseUrl: 'https://daemon.example/',
      win: secureWindow(async () => handle),
      store,
      locks,
      delay: async () => {},
    };
    const hA = render({ ...common, sessionId: 'session-A' });
    await hA.flush();
    await hA.flush();
    expect(hA.sockets).toHaveLength(1);

    const hB = render({ ...common, sessionId: 'session-B' });
    await hB.flush();
    await hB.flush();
    expect(hB.get().status.phase).toBe('held-elsewhere');

    await act(async () => {
      await hB.get().disconnect();
    });
    // Declined: the record survives by design, and this mount detached on
    // purpose. The owner then leaves with the lock.
    expect(store.clears).toBe(0);
    hA.unmount();

    // A blocker flip re-runs restore(): it must not re-attach a bridge from
    // the surviving record behind the user's disconnect.
    hB.rerender({ withheldBlocker: 'workspace-resolving' });
    await hB.flush();
    hB.rerender({ withheldBlocker: undefined });
    await hB.flush();
    await hB.flush();
    expect(hB.sockets).toHaveLength(0);
    expect(hB.get().status).toEqual({
      phase: 'idle',
      blocker: null,
      rootName: 'ai_coding',
    });
    hB.unmount();
  });

  it('does not re-attach when a declined disconnect is followed by a swallowed connect', async () => {
    const perms = { query: 'granted' as PermissionState };
    const handle = fakeHandle('ai_coding', perms);
    let releaseRequest!: (state: PermissionState) => void;
    const requestGate = new Promise<PermissionState>((resolve) => {
      releaseRequest = resolve;
    });
    vi.mocked(handle.requestPermission).mockImplementation(() => requestGate);
    const store = fakeStore(handle);
    const locks = exclusiveLocks();
    const common = {
      baseUrl: 'https://daemon.example/',
      win: secureWindow(async () => handle),
      store,
      locks,
      delay: async () => {},
    };
    const hA = render({ ...common, sessionId: 'session-A' });
    await hA.flush();
    await hA.flush();
    expect(hA.sockets).toHaveLength(1);

    // B restores the same record into needs-gesture: its reconnect parks in
    // the permission re-ask and keeps connectInFlightRef latched (the
    // Chrome prompt does not block page input).
    perms.query = 'prompt';
    const hB = render({ ...common, sessionId: 'session-B' });
    await hB.flush();
    await hB.flush();
    expect(hB.get().status.phase).toBe('needs-gesture');

    // The connect is not wrapped in act: its open scope would hold back
    // this mount's own effects and status commits while it stays parked.
    const parkedConnect = hB.get().connect();
    await hB.flush();
    // The owner holds the lock, so the arbitration declines and the record
    // survives; the panel falls back to the named grant over idle.
    await act(async () => {
      await hB.get().disconnect();
    });
    expect(store.clears).toBe(0);
    expect(hB.get().status).toEqual({
      phase: 'idle',
      blocker: null,
      rootName: 'ai_coding',
    });

    // A second Connect click is swallowed by the one-picker guard while the
    // first connect is still parked: it must not clear the detach latch.
    await act(async () => {
      await hB.get().connect();
    });
    hA.unmount();
    await hB.flush();

    // A blocker flip re-runs restore(): with the latch intact it must not
    // re-attach a bridge from the surviving record behind the user's click.
    hB.rerender({ withheldBlocker: 'workspace-resolving' });
    await hB.flush();
    perms.query = 'granted';
    hB.rerender({ withheldBlocker: undefined });
    await hB.flush();
    await hB.flush();
    expect(hB.sockets).toHaveLength(0);
    expect(hB.get().status).toEqual({
      phase: 'idle',
      blocker: null,
      rootName: 'ai_coding',
    });

    releaseRequest('prompt');
    await act(async () => {
      await parkedConnect;
    });
    hB.unmount();
  });

  it('does not re-attach when a declined disconnect is followed by a dismissed picker', async () => {
    const perms = { query: 'granted' as PermissionState };
    const handle = fakeHandle('ai_coding', perms);
    let rejectPicker!: (reason: unknown) => void;
    const pickerGate = new Promise<FileSystemDirectoryHandle>(
      (_resolve, reject) => {
        rejectPicker = reject;
      },
    );
    const store = fakeStore(handle);
    const locks = exclusiveLocks();
    const common = {
      baseUrl: 'https://daemon.example/',
      win: secureWindow(async () => pickerGate),
      store,
      locks,
      delay: async () => {},
    };
    const hA = render({ ...common, sessionId: 'session-A' });
    await hA.flush();
    await hA.flush();
    expect(hA.sockets).toHaveLength(1);

    const hB = render({ ...common, sessionId: 'session-B' });
    await hB.flush();
    await hB.flush();
    expect(hB.get().status.phase).toBe('held-elsewhere');

    // Declined: the record survives by design and this mount detaches.
    await act(async () => {
      await hB.get().disconnect();
    });
    expect(store.clears).toBe(0);

    // A Connect whose picker the user dismisses binds nothing, so it must
    // leave the detach latch set. The connect is not wrapped in act: its
    // open scope would hold back this mount's own status commits.
    perms.query = 'denied';
    const connecting = hB.get().connect();
    await hB.flush();
    rejectPicker(new DOMException('user cancelled', 'AbortError'));
    await act(async () => {
      await connecting;
    });
    hA.unmount();
    await hB.flush();

    // A blocker flip re-runs restore(): with the latch intact it must not
    // re-attach a bridge from the surviving record behind the user's click.
    hB.rerender({ withheldBlocker: 'workspace-resolving' });
    await hB.flush();
    perms.query = 'granted';
    hB.rerender({ withheldBlocker: undefined });
    await hB.flush();
    await hB.flush();
    expect(hB.sockets).toHaveLength(0);
    expect(hB.get().status).toEqual({
      phase: 'idle',
      blocker: null,
      rootName: 'ai_coding',
    });
    expect(await store.load()).toBe(handle);
    hB.unmount();
  });

  it('revokes once the owner that parked this tab is gone', async () => {
    const handle = fakeHandle('ai_coding', { query: 'granted' });
    const store = fakeStore(handle);
    const locks = exclusiveLocks();
    const common = {
      baseUrl: 'https://daemon.example/',
      win: secureWindow(async () => handle),
      store,
      locks,
      // The lock-retry loop would otherwise wait real 100ms delays.
      delay: async () => {},
    };
    const hA = render({ ...common, sessionId: 'session-A' });
    await hA.flush();
    await hA.flush();
    expect(hA.sockets).toHaveLength(1);

    const hB = render({ ...common, sessionId: 'session-B' });
    await hB.flush();
    await hB.flush();
    expect(hB.get().status.phase).toBe('held-elsewhere');

    // The owner closes: held-elsewhere is sticky, so from here on B's phase
    // lies about who holds the lock.
    hA.unmount();
    await hB.flush();

    await act(async () => {
      await hB.get().disconnect();
    });
    await hB.flush();
    // The lock is free, so the record is nobody's live grant: an explicit
    // disconnect must revoke it instead of reporting success over it.
    expect(store.clears).toBe(1);
    expect(await store.load()).toBeUndefined();
    expect(hB.get().status).toEqual({ phase: 'idle', blocker: null });
    hB.unmount();
  });

  it('keeps the owner record when a session-less tab disconnects', async () => {
    const handle = fakeHandle('ai_coding', { query: 'granted' });
    const store = fakeStore(handle);
    const locks = exclusiveLocks();
    const common = {
      baseUrl: 'https://daemon.example/',
      win: secureWindow(async () => handle),
      store,
      locks,
      delay: async () => {},
    };
    const hA = render({ ...common, sessionId: 'session-A' });
    await hA.flush();
    await hA.flush();
    expect(hA.sockets).toHaveLength(1);

    // No session: restore loads the grant but startBridge parks before any
    // bridge (or lock) exists, while the panel still offers Disconnect.
    const hB = render({ ...common, sessionId: undefined });
    await hB.flush();
    await hB.flush();
    expect(hB.get().status.phase).toBe('needs-session');

    await act(async () => {
      await hB.get().disconnect();
    });
    await hB.flush();
    // Tab A's live bridge depends on the single origin-global record.
    expect(store.clears).toBe(0);
    expect(await store.load()).toBe(handle);
    hA.unmount();
    hB.unmount();
  });

  it('does not let a stale owner latch skip arbitration after its run ended', async () => {
    const handle = fakeHandle('ai_coding', { query: 'granted' });
    const store = fakeStore(handle);
    const common = {
      baseUrl: 'https://daemon.example/',
      win: secureWindow(async () => handle),
      store,
      locks: exclusiveLocks(),
      delay: async () => {},
    };
    const hA = render({ ...common, sessionId: 'session-A' });
    await hA.flush();
    await hA.flush();
    expect(hA.sockets).toHaveLength(1);

    // The session goes away: startBridge parks in needs-session and the run
    // (with it the lock) ends, while the panel still offers Disconnect.
    hA.rerender({ ...common, sessionId: undefined });
    await hA.flush();
    expect(hA.get().status.phase).toBe('needs-session');

    // Tab B picks the freed lock up and runs a live bridge on the record.
    const hB = render({ ...common, sessionId: 'session-B' });
    await hB.flush();
    await hB.flush();
    expect(hB.sockets).toHaveLength(1);

    await act(async () => {
      await hA.get().disconnect();
    });
    await hB.flush();
    // A owns nothing any more: the arbitration must see B's lock and keep
    // the record B's bridge depends on.
    expect(store.clears).toBe(0);
    expect(await store.load()).toBe(handle);
    hA.unmount();
    hB.unmount();
  });

  it('does not let a terminally failed run skip arbitration either', async () => {
    const handle = fakeHandle('ai_coding', { query: 'granted' });
    const store = fakeStore(handle);
    const common = {
      baseUrl: 'https://daemon.example/',
      win: secureWindow(async () => handle),
      store,
      locks: exclusiveLocks(),
      delay: async () => {},
    };
    const hA = render({ ...common, sessionId: 'session-A' });
    await hA.flush();
    await hA.flush();
    expect(hA.sockets).toHaveLength(1);

    // Exhaust the register budget: fail() tears down and releases the lock
    // without this mount asking.
    for (let i = 0; i < 12 && hA.get().status.phase !== 'failed'; i++) {
      hA.sockets[0]!.emit({
        type: 'mcp_error',
        code: 'register_failed',
        message: 'No live ACP channel',
      });
      await hA.flush();
    }
    expect(hA.get().status.phase).toBe('failed');

    const hB = render({ ...common, sessionId: 'session-B' });
    await hB.flush();
    await hB.flush();
    expect(hB.sockets).toHaveLength(1);

    await act(async () => {
      await hA.get().disconnect();
    });
    await hB.flush();
    expect(store.clears).toBe(0);
    expect(await store.load()).toBe(handle);
    hA.unmount();
    hB.unmount();
  });

  it('retries the arbitration past a decline caused only by a settling release', async () => {
    const handle = fakeHandle('ai_coding', { query: 'granted' });
    const store = fakeStore(handle);
    // The decline discriminator is the settling counter ALONE: held is false
    // at every arbitration attempt, so a retry regression that only breaks
    // the settling path cannot hide behind the held-lock case.
    const attempts: boolean[] = [];
    const lock = { held: false, settling: 0 };
    const locks: LockManagerLike = {
      request: async (_name, options, callback) => {
        if (options.ifAvailable && !lock.held && lock.settling > 0) {
          lock.settling -= 1;
          attempts.push(true);
          return callback(null);
        }
        attempts.push(false);
        lock.held = true;
        try {
          await callback({});
        } finally {
          lock.held = false;
        }
        return undefined;
      },
    };
    const common = {
      baseUrl: 'https://daemon.example/',
      win: secureWindow(async () => handle),
      store,
      locks,
      delay: async () => {},
    };
    const hA = render({ ...common, sessionId: 'session-A' });
    await hA.flush();
    await hA.flush();
    expect(hA.sockets).toHaveLength(1);

    // B has no session: it restores the grant but never owns the lock, so
    // its disconnect must arbitrate.
    const hB = render({ ...common, sessionId: undefined });
    await hB.flush();
    await hB.flush();
    expect(hB.get().status.phase).toBe('needs-session');

    // A releases; its release is still "settling" when B disconnects.
    lock.settling = 1;
    hA.unmount();
    // Let the owner's lock-release finally settle, or attempt 0 declines on
    // the stale held flag instead of the settling counter.
    await hB.flush();
    attempts.length = 0;
    await act(async () => {
      await hB.get().disconnect();
    });
    // First arbitration attempt declined by the settling release alone, and
    // the bounded retry still reached the freed lock.
    expect(attempts).toEqual([true, false]);
    expect(store.clears).toBe(1);
    expect(await store.load()).toBeUndefined();
    hB.unmount();
  });

  it('keeps a record a connect writes during the arbitration window', async () => {
    const handle = fakeHandle('ai_coding', { query: 'granted' });
    const store = fakeStore(handle);
    const lock = { held: false, settling: 0 };
    let releaseDelay!: () => void;
    const delayGate = new Promise<void>((resolve) => {
      releaseDelay = resolve;
    });
    const locks: LockManagerLike = settlingLocks(lock);
    const common = {
      baseUrl: 'https://daemon.example/',
      win: secureWindow(async () => handle),
      store,
      locks,
      delay: () => delayGate,
    };
    const hA = render({ ...common, sessionId: 'session-A' });
    await hA.flush();
    await hA.flush();
    expect(hA.sockets).toHaveLength(1);

    // B has no session: it holds the grant in needs-session without ever
    // requesting the lock, so its disconnect is the arbitration path.
    const hB = render({ ...common, sessionId: undefined });
    await hB.flush();
    await hB.flush();
    expect(hB.get().status.phase).toBe('needs-session');

    // A goes away; B's disconnect declines attempt 0 on the settling release
    // and then waits in the inter-attempt delay, where the user connects:
    // the stored handle needs no picker, so the connect saves and parks in
    // needs-session before attempt 1 grants the arbitration.
    lock.settling = 1;
    hA.unmount();
    const disconnecting = act(async () => {
      await hB.get().disconnect();
    });
    await hB.flush();
    await act(async () => {
      await hB.get().connect();
    });
    releaseDelay();
    await disconnecting;
    await hB.flush();
    // The record is the connect's own grant: the vetoed revoke must not wipe
    // it, and the connect's own write is the authoritative status — the
    // reconcile must not downgrade it to a bare idle.
    expect(store.clears).toBe(0);
    expect(await store.load()).toBe(handle);
    expect(hB.get().status).toEqual({
      phase: 'needs-session',
      blocker: null,
      rootName: 'ai_coding',
    });
    hB.unmount();
  });

  it('does not reconcile over a connect-started bridge that won the lock', async () => {
    const handle = fakeHandle('ai_coding', { query: 'granted' });
    const store = fakeStore(handle);
    const lock = { held: false, settling: 0 };
    const delayResolvers: Array<() => void> = [];
    const locks: LockManagerLike = settlingLocks(lock);
    const common = {
      baseUrl: 'https://daemon.example/',
      win: secureWindow(async () => handle),
      store,
      locks,
      delay: () =>
        new Promise<void>((resolve) => {
          delayResolvers.push(resolve);
        }),
    };
    const hA = render({ ...common, sessionId: 'session-A' });
    await hA.flush();
    await hA.flush();
    expect(hA.sockets).toHaveLength(1);

    // B parks behind A's lock: every start attempt declines.
    const hB = render({ ...common, sessionId: 'session-B' });
    await hB.flush();
    for (let i = 0; i < 8 && hB.get().status.phase !== 'held-elsewhere'; i++) {
      delayResolvers.shift()?.();
      await hB.flush();
    }
    expect(hB.get().status.phase).toBe('held-elsewhere');

    // A goes away with its release still settling: attempt 0 declines and
    // the arbitration parks in the inter-attempt delay.
    lock.settling = 1;
    hA.unmount();
    await hB.flush();
    const disconnecting = act(async () => {
      await hB.get().disconnect();
    });
    await hB.flush();
    // The user connects inside the window: the stored handle needs no
    // picker, so the connect saves and its own bridge wins the freed lock.
    const connecting = act(async () => {
      await hB.get().connect();
    });
    await hB.flush();
    await hB.flush();
    expect(hB.sockets).toHaveLength(1);
    // The remaining arbitration attempts decline on B's own bridge.
    for (let i = 0; i < 8 && delayResolvers.length > 0; i++) {
      delayResolvers.shift()?.();
      await hB.flush();
    }
    await connecting;
    await disconnecting;
    await hB.flush();
    expect(store.clears).toBe(0);
    expect(await store.load()).toBe(handle);
    // The bridge's own status must stand: restoring the pre-click
    // held-elsewhere would report another tab owning the directory this
    // tab's bridge is actually serving.
    expect(hB.get().status).toEqual({
      phase: 'connecting',
      blocker: null,
      rootName: 'ai_coding',
    });
    hB.unmount();
  });

  it('restores the parked panel when a post-disconnect connect writes nothing', async () => {
    const perms = { query: 'granted' as PermissionState };
    const handle = fakeHandle('ai_coding', perms);
    const store = fakeStore(handle);
    const delayResolvers: Array<() => void> = [];
    let rejectPicker!: (reason: unknown) => void;
    const pickerGate = new Promise<FileSystemDirectoryHandle>(
      (_resolve, reject) => {
        rejectPicker = reject;
      },
    );
    const common = {
      baseUrl: 'https://daemon.example/',
      win: secureWindow(async () => pickerGate),
      store,
      locks: exclusiveLocks(),
      delay: () =>
        new Promise<void>((resolve) => {
          delayResolvers.push(resolve);
        }),
    };
    const hA = render({ ...common, sessionId: 'session-A' });
    await hA.flush();
    await hA.flush();
    expect(hA.sockets).toHaveLength(1);

    const hB = render({ ...common, sessionId: 'session-B' });
    await hB.flush();
    for (let i = 0; i < 8 && hB.get().status.phase !== 'held-elsewhere'; i++) {
      delayResolvers.shift()?.();
      await hB.flush();
    }
    expect(hB.get().status.phase).toBe('held-elsewhere');

    const disconnecting = hB.get().disconnect();
    await hB.flush();
    // The user connects inside the arbitration window, but the stored grant
    // now reads denied without a request, so the connect parks in the
    // picker — and a dismissed picker is the one connect exit that commits
    // no status of its own.
    perms.query = 'denied';
    const connecting = hB.get().connect();
    await hB.flush();
    await hB.flush();
    // A holds the lock throughout: every remaining attempt declines, so the
    // reconcile must be handed to the connect's finally, not skipped on the
    // connect's generation.
    for (let i = 0; i < 8 && delayResolvers.length > 0; i++) {
      delayResolvers.shift()?.();
      await hB.flush();
    }
    await act(async () => {
      await disconnecting;
    });
    rejectPicker(new DOMException('user cancelled', 'AbortError'));
    await act(async () => {
      await connecting;
    });
    await hB.flush();
    expect(store.clears).toBe(0);
    expect(await store.load()).toBe(handle);
    expect(hB.get().status).toEqual({
      phase: 'held-elsewhere',
      blocker: null,
      rootName: 'ai_coding',
    });
    hA.unmount();
    hB.unmount();
  });

  it("keeps the connect's needs-gesture write when a declined revoke's reconcile runs from its finally", async () => {
    const perms = { query: 'granted' as PermissionState };
    const handle = fakeHandle('ai_coding', perms);
    const store = fakeStore(handle);
    const delayResolvers: Array<() => void> = [];
    let releaseRequest!: (state: PermissionState) => void;
    const requestGate = new Promise<PermissionState>((resolve) => {
      releaseRequest = resolve;
    });
    const common = {
      baseUrl: 'https://daemon.example/',
      win: secureWindow(async () => handle),
      store,
      locks: exclusiveLocks(),
      delay: () =>
        new Promise<void>((resolve) => {
          delayResolvers.push(resolve);
        }),
    };
    const hA = render({ ...common, sessionId: 'session-A' });
    await hA.flush();
    await hA.flush();
    expect(hA.sockets).toHaveLength(1);

    const hB = render({ ...common, sessionId: 'session-B' });
    await hB.flush();
    for (let i = 0; i < 8 && hB.get().status.phase !== 'held-elsewhere'; i++) {
      delayResolvers.shift()?.();
      await hB.flush();
    }
    expect(hB.get().status.phase).toBe('held-elsewhere');

    const disconnecting = hB.get().disconnect();
    await hB.flush();
    // A holds the lock throughout: every attempt declines. The user
    // reconnects inside the arbitration window and the permission re-ask
    // keeps the connect in flight when the arbitration settles, so the
    // reconcile is handed to the connect's finally.
    perms.query = 'prompt';
    vi.mocked(handle.requestPermission).mockImplementation(() => requestGate);
    const connecting = hB.get().connect();
    await hB.flush();
    await hB.flush();
    for (let i = 0; i < 8 && delayResolvers.length > 0; i++) {
      delayResolvers.shift()?.();
      await hB.flush();
    }
    await act(async () => {
      await disconnecting;
    });
    // The re-ask consumed the click's activation and answered prompt: the
    // connect commits needs-gesture itself, and the parked reconcile must
    // leave that write — the panel's only reconnect affordance — alone.
    releaseRequest('prompt');
    await act(async () => {
      await connecting;
    });
    await hB.flush();
    expect(store.clears).toBe(0);
    expect(await store.load()).toBe(handle);
    expect(hB.get().status).toEqual({
      phase: 'needs-gesture',
      blocker: null,
      rootName: 'ai_coding',
    });
    hA.unmount();
    hB.unmount();
  });

  it("keeps the connect's needs-gesture write when a declined revoke reconciles after the connect settled", async () => {
    const handle = fakeHandle('ai_coding', {
      query: 'prompt',
      request: 'prompt',
    });
    const store = fakeStore(handle);
    const lock = { held: false, settling: 10 };
    const delayResolvers: Array<() => void> = [];
    const locks: LockManagerLike = settlingLocks(lock);
    const h = render({
      sessionId: 'session-1',
      baseUrl: 'https://daemon.example/',
      win: secureWindow(async () => handle),
      store,
      locks,
      delay: () =>
        new Promise<void>((resolve) => {
          delayResolvers.push(resolve);
        }),
    });
    await h.flush();
    await h.flush();
    expect(h.get().status.phase).toBe('needs-gesture');

    const disconnecting = h.get().disconnect();
    await h.flush();
    // The settling release declines every attempt; the reconnect runs to
    // completion inside the inter-attempt delay, so its needs-gesture
    // write is the last authoritative status before the tail reconciles.
    await act(async () => {
      await h.get().connect();
    });
    expect(h.get().status).toEqual({
      phase: 'needs-gesture',
      blocker: null,
      rootName: 'ai_coding',
    });
    for (let i = 0; i < 8 && delayResolvers.length > 0; i++) {
      delayResolvers.shift()?.();
      await h.flush();
    }
    await act(async () => {
      await disconnecting;
    });
    await h.flush();
    expect(store.clears).toBe(0);
    expect(await store.load()).toBe(handle);
    expect(h.get().status).toEqual({
      phase: 'needs-gesture',
      blocker: null,
      rootName: 'ai_coding',
    });
    h.unmount();
  });

  it("keeps the reconnect's needs-session write when a declined revoke's reconcile runs from its finally", async () => {
    const handle = fakeHandle('ai_coding', { query: 'denied' });
    const store = fakeStore(handle);
    // The re-save fails soft and writes nothing (the store's own contract),
    // so the connect leaves without saving — but it did commit a status.
    store.save = async () => false;
    const lock = { held: false, settling: 10 };
    const delayResolvers: Array<() => void> = [];
    const locks: LockManagerLike = settlingLocks(lock);
    const h = render({
      sessionId: undefined,
      baseUrl: 'https://daemon.example/',
      win: secureWindow(async () => handle),
      store,
      locks,
      delay: () =>
        new Promise<void>((resolve) => {
          delayResolvers.push(resolve);
        }),
    });
    await h.flush();
    await h.flush();
    expect(h.get().status.phase).toBe('needs-gesture');

    const disconnecting = h.get().disconnect();
    await h.flush();
    // The permission re-query keeps the connect in flight when every
    // arbitration attempt has declined, so the reconcile parks on its
    // finally.
    let releaseQuery!: (state: PermissionState) => void;
    const queryGate = new Promise<PermissionState>((resolve) => {
      releaseQuery = resolve;
    });
    vi.mocked(handle.queryPermission).mockImplementation(() => queryGate);
    const connecting = h.get().connect();
    await h.flush();
    await h.flush();
    for (let i = 0; i < 8 && delayResolvers.length > 0; i++) {
      delayResolvers.shift()?.();
      await h.flush();
    }
    await act(async () => {
      await disconnecting;
    });
    // The re-query answers granted: with no session the connect parks the
    // handle and commits needs-session, and the reconcile must not restore
    // the pre-click idle over it.
    releaseQuery('granted');
    await act(async () => {
      await connecting;
    });
    await h.flush();
    expect(store.clears).toBe(0);
    expect(await store.load()).toBe(handle);
    expect(h.get().status).toEqual({
      phase: 'needs-session',
      blocker: null,
      rootName: 'ai_coding',
    });
    h.unmount();
  });

  it("keeps the picked grant's needs-session write when a declined revoke's reconcile runs from its finally", async () => {
    const store = fakeStore();
    store.save = async () => false;
    const lock = { held: false, settling: 10 };
    const delayResolvers: Array<() => void> = [];
    const locks: LockManagerLike = settlingLocks(lock);
    let resolvePicker!: (value: FileSystemDirectoryHandle) => void;
    const pickerGate = new Promise<FileSystemDirectoryHandle>((resolve) => {
      resolvePicker = resolve;
    });
    const h = render({
      sessionId: undefined,
      baseUrl: 'https://daemon.example/',
      win: secureWindow(async () => pickerGate),
      store,
      locks,
      delay: () =>
        new Promise<void>((resolve) => {
          delayResolvers.push(resolve);
        }),
    });
    await h.flush();
    await h.flush();
    expect(h.get().status.phase).toBe('idle');

    const disconnecting = h.get().disconnect();
    await h.flush();
    // The picker keeps the connect in flight when every arbitration
    // attempt has declined, so the reconcile parks on its finally.
    const connecting = h.get().connect();
    await h.flush();
    for (let i = 0; i < 8 && delayResolvers.length > 0; i++) {
      delayResolvers.shift()?.();
      await h.flush();
    }
    await act(async () => {
      await disconnecting;
    });
    // The pick lands but the save fails soft: the connect still commits
    // needs-session for its own grant, and the reconcile must not flatten
    // it to the pre-click idle.
    resolvePicker(fakeHandle('new_dir', { query: 'granted' }));
    await act(async () => {
      await connecting;
    });
    await h.flush();
    expect(store.clears).toBe(0);
    expect(h.get().status).toEqual({
      phase: 'needs-session',
      blocker: null,
      rootName: 'new_dir',
    });
    h.unmount();
  });

  it("keeps the connect's picker-failure write when a declined revoke's reconcile runs from its finally", async () => {
    const handle = fakeHandle('ai_coding', { query: 'denied' });
    const store = fakeStore(handle);
    const lock = { held: false, settling: 10 };
    const delayResolvers: Array<() => void> = [];
    const locks: LockManagerLike = settlingLocks(lock);
    const h = render({
      sessionId: undefined,
      baseUrl: 'https://daemon.example/',
      win: secureWindow(async () => {
        throw new DOMException('Blocked by policy', 'SecurityError');
      }),
      store,
      locks,
      delay: () =>
        new Promise<void>((resolve) => {
          delayResolvers.push(resolve);
        }),
    });
    await h.flush();
    await h.flush();
    expect(h.get().status.phase).toBe('needs-gesture');

    const disconnecting = h.get().disconnect();
    await h.flush();
    // The permission re-query keeps the connect in flight when every
    // arbitration attempt has declined, so the reconcile parks on its
    // finally.
    let releaseQuery!: (state: PermissionState) => void;
    const queryGate = new Promise<PermissionState>((resolve) => {
      releaseQuery = resolve;
    });
    vi.mocked(handle.queryPermission).mockImplementation(() => queryGate);
    const connecting = h.get().connect();
    await h.flush();
    await h.flush();
    for (let i = 0; i < 8 && delayResolvers.length > 0; i++) {
      delayResolvers.shift()?.();
      await h.flush();
    }
    await act(async () => {
      await disconnecting;
    });
    // The denied re-query falls through to the picker, which fails: the
    // connect commits the failure itself, and the reconcile must not
    // restore the pre-click idle over it.
    releaseQuery('denied');
    await act(async () => {
      await connecting;
    });
    await h.flush();
    expect(store.clears).toBe(0);
    expect(await store.load()).toBe(handle);
    expect(h.get().status).toMatchObject({
      phase: 'failed',
      blocker: null,
      rootName: 'ai_coding',
    });
    h.unmount();
  });

  it("keeps the connect's picker-unavailable write when a declined revoke's reconcile runs from its finally", async () => {
    const handle = fakeHandle('ai_coding', { query: 'denied' });
    const store = fakeStore(handle);
    const lock = { held: false, settling: 10 };
    const delayResolvers: Array<() => void> = [];
    const locks: LockManagerLike = settlingLocks(lock);
    const win = secureWindow(async () => handle);
    const h = render({
      sessionId: undefined,
      baseUrl: 'https://daemon.example/',
      win,
      store,
      locks,
      delay: () =>
        new Promise<void>((resolve) => {
          delayResolvers.push(resolve);
        }),
    });
    await h.flush();
    await h.flush();
    expect(h.get().status.phase).toBe('needs-gesture');

    const disconnecting = h.get().disconnect();
    await h.flush();
    // The picker vanishes after the mount's probe: the connect's own
    // re-detection reports unavailable. The re-query keeps the connect in
    // flight when every arbitration attempt has declined, so the
    // reconcile parks on its finally.
    win.showDirectoryPicker = undefined;
    let releaseQuery!: (state: PermissionState) => void;
    const queryGate = new Promise<PermissionState>((resolve) => {
      releaseQuery = resolve;
    });
    vi.mocked(handle.queryPermission).mockImplementation(() => queryGate);
    const connecting = h.get().connect();
    await h.flush();
    await h.flush();
    for (let i = 0; i < 8 && delayResolvers.length > 0; i++) {
      delayResolvers.shift()?.();
      await h.flush();
    }
    await act(async () => {
      await disconnecting;
    });
    releaseQuery('denied');
    await act(async () => {
      await connecting;
    });
    await h.flush();
    expect(store.clears).toBe(0);
    expect(await store.load()).toBe(handle);
    expect(h.get().status).toEqual({
      phase: 'unavailable',
      blocker: 'unsupported-browser',
      rootName: 'ai_coding',
    });
    h.unmount();
  });

  it('revokes when a post-disconnect connect leaves without saving', async () => {
    // Empty store: a connect with nothing stored falls through to the
    // native picker, the only connect path that can leave without saving.
    const store = fakeStore();
    const lock = { held: false, settling: 0 };
    let releaseDelay!: () => void;
    const delayGate = new Promise<void>((resolve) => {
      releaseDelay = resolve;
    });
    let rejectPicker!: (reason: unknown) => void;
    const pickerGate = new Promise<FileSystemDirectoryHandle>(
      (_resolve, reject) => {
        rejectPicker = reject;
      },
    );
    const locks: LockManagerLike = settlingLocks(lock);
    const common = {
      baseUrl: 'https://daemon.example/',
      win: secureWindow(async () => pickerGate),
      store,
      locks,
      delay: () => delayGate,
    };
    const hA = render({ ...common, sessionId: 'session-A' });
    await hA.flush();
    await hA.flush();
    expect(hA.sockets).toHaveLength(0);

    // B restores nothing (empty store) and owns nothing: its disconnect is
    // the arbitration path, and its connect parks in the picker.
    const hB = render({ ...common, sessionId: 'session-B' });
    await hB.flush();
    await hB.flush();
    expect(hB.get().status.phase).toBe('idle');

    lock.settling = 1;
    hA.unmount();
    await hB.flush();
    const disconnecting = act(async () => {
      await hB.get().disconnect();
    });
    await hB.flush();
    // The connect parks in the picker while the arbitration waits in its
    // inter-attempt delay; the veto defers the revoke to the connect's
    // finally, and a cancelled picker saves nothing, so it must run there.
    const connecting = act(async () => {
      await hB.get().connect();
    });
    await hB.flush();
    releaseDelay();
    await hB.flush();
    // Attempt 1 granted while the connect was in flight, so the revoke must
    // be deferred, not run: nothing may have cleared at this point.
    expect(store.clears).toBe(0);
    rejectPicker(new DOMException('user cancelled', 'AbortError'));
    await connecting;
    await disconnecting;
    await hB.flush();
    expect(store.clears).toBe(1);
    hB.unmount();
  });

  it("keeps the connect's failure write when a deferred full revoke declines", async () => {
    const handle = fakeHandle('ai_coding', { query: 'denied' });
    const store = fakeStore(handle);
    const lock = { held: false, settling: 1 };
    let releaseDelay!: () => void;
    const delayGate = new Promise<void>((resolve) => {
      releaseDelay = resolve;
    });
    let rejectPicker!: (reason: unknown) => void;
    const pickerGate = new Promise<FileSystemDirectoryHandle>(
      (_resolve, reject) => {
        rejectPicker = reject;
      },
    );
    const locks: LockManagerLike = settlingLocks(lock);
    const h = render({
      sessionId: 'session-1',
      baseUrl: 'https://daemon.example/',
      win: secureWindow(async () => pickerGate),
      store,
      locks,
      delay: () => delayGate,
    });
    await h.flush();
    await h.flush();
    // needs-gesture: the stored grant is denied, so the panel names it; no
    // run was ever owned, so the disconnect arbitrates.
    expect(h.get().status.phase).toBe('needs-gesture');

    const disconnectPromise = h.get().disconnect();
    await h.flush();
    // Attempt 0 declined on the settling release; the user connects inside
    // the inter-attempt delay and the denied grant falls through to the
    // picker, so attempt 1 defers the FULL revoke to the connect's finally.
    // Neither promise is wrapped in act: their open scopes would hold back
    // this mount's own status commits.
    const connectPromise = h.get().connect();
    await h.flush();
    releaseDelay();
    await act(async () => {
      await disconnectPromise;
    });
    // A peer takes the owner lock before the deferred re-arbitration, so it
    // declines — and the picker rejects non-AbortError, a status the
    // connect committed itself. The reconcile must not restore the
    // pre-click panel over it.
    lock.settling = 10;
    rejectPicker(new DOMException('Blocked by policy', 'SecurityError'));
    await act(async () => {
      await connectPromise;
    });
    await h.flush();
    expect(store.clears).toBe(0);
    expect(await store.load()).toBe(handle);
    expect(h.get().status).toMatchObject({
      phase: 'failed',
      blocker: null,
      rootName: 'ai_coding',
    });
    h.unmount();
  });

  it('does not clear a grant a peer took over while the revoke was deferred', async () => {
    const perms = { query: 'denied' as PermissionState };
    const handle = fakeHandle('ai_coding', perms);
    const store = fakeStore(handle);
    const lock = { held: false, settling: 0 };
    let releaseDelay!: () => void;
    const delayGate = new Promise<void>((resolve) => {
      releaseDelay = resolve;
    });
    let rejectPicker!: (reason: unknown) => void;
    const pickerGate = new Promise<FileSystemDirectoryHandle>(
      (_resolve, reject) => {
        rejectPicker = reject;
      },
    );
    const locks: LockManagerLike = settlingLocks(lock);
    const common = {
      baseUrl: 'https://daemon.example/',
      win: secureWindow(async () => pickerGate),
      store,
      locks,
      delay: () => delayGate,
    };
    // B restores the denied grant into needs-gesture; it owns nothing, so
    // its disconnect arbitrates.
    const hB = render({ ...common, sessionId: 'session-B' });
    await hB.flush();
    await hB.flush();
    expect(hB.get().status.phase).toBe('needs-gesture');

    lock.settling = 1;
    const disconnectPromise = hB.get().disconnect();
    await hB.flush();
    // Attempt 0 declined on the settling release; the user connects inside
    // the inter-attempt delay and the connect parks in the picker, so
    // attempt 1 defers the revoke — and the arbitration releases the lock
    // with the decision still open. The connect is not wrapped in act: its
    // open scope would hold back the peer mount's effects below.
    const connectPromise = hB.get().connect();
    await hB.flush();
    releaseDelay();
    await act(async () => {
      await disconnectPromise;
    });
    // A peer mount restores the same record, takes the freed lock and runs
    // a live bridge on it.
    perms.query = 'granted';
    const hA = render({ ...common, sessionId: 'session-A' });
    await hA.flush();
    await hA.flush();
    expect(hA.sockets).toHaveLength(1);
    // The picker is cancelled: the deferred revoke must re-arbitrate, see
    // the peer's lock, and keep the record the peer's bridge depends on.
    rejectPicker(new DOMException('user cancelled', 'AbortError'));
    await act(async () => {
      await connectPromise;
    });
    await hB.flush();
    expect(store.clears).toBe(0);
    expect(await store.load()).toBe(handle);
    hA.unmount();
    hB.unmount();
  });

  it('does not clear a record a peer renamed while the revoke was deferred', async () => {
    const handle = fakeHandle('ai_coding', { query: 'denied' });
    const store = fakeStore(handle);
    const lock = { held: false, settling: 1 };
    let releaseDelay!: () => void;
    const delayGate = new Promise<void>((resolve) => {
      releaseDelay = resolve;
    });
    let rejectPicker!: (reason: unknown) => void;
    const pickerGate = new Promise<FileSystemDirectoryHandle>(
      (_resolve, reject) => {
        rejectPicker = reject;
      },
    );
    const locks: LockManagerLike = settlingLocks(lock);
    const h = render({
      sessionId: 'session-B',
      baseUrl: 'https://daemon.example/',
      win: secureWindow(async () => pickerGate),
      store,
      locks,
      delay: () => delayGate,
    });
    await h.flush();
    await h.flush();
    expect(h.get().status.phase).toBe('needs-gesture');

    const disconnectPromise = h.get().disconnect();
    await h.flush();
    // Attempt 0 declined on the settling release; the user connects inside
    // the inter-attempt delay and the connect parks in the picker, so
    // attempt 1 defers the revoke to the connect's finally.
    const connectPromise = h.get().connect();
    await h.flush();
    releaseDelay();
    await act(async () => {
      await disconnectPromise;
    });
    // A peer takes the freed slot over with a DIFFERENT directory before the
    // deferred revoke re-asks: the delete must aim at the grant the user
    // revoked, not at whatever the single origin-global slot now holds.
    const other = fakeHandle('peer_dir', { query: 'granted' });
    await store.save(other);
    rejectPicker(new DOMException('user cancelled', 'AbortError'));
    await act(async () => {
      await connectPromise;
    });
    await h.flush();
    expect(store.clears).toBe(0);
    expect(await store.load()).toBe(other);
    // The surviving record is a peer's: this mount must stop naming it, or
    // the panel offers a Disconnect that provably never clears anything.
    expect(h.get().status).toEqual({ phase: 'idle', blocker: null });
    h.unmount();
  });

  it('does not name a record a peer renamed before a direct revoke', async () => {
    // No deferral at all: the panel names the stored grant from the
    // click-time snapshot, but the origin-global slot now holds a peer's
    // different directory, so the revoke refuses it outright.
    const handle = fakeHandle('ai_coding', { query: 'denied' });
    const store = fakeStore(handle);
    const h = render({
      sessionId: 'session-1',
      baseUrl: 'https://daemon.example/',
      win: secureWindow(async () => handle),
      store,
      locks: null,
    });
    await h.flush();
    await h.flush();
    expect(h.get().status.phase).toBe('needs-gesture');

    const other = fakeHandle('peer_dir', { query: 'granted' });
    await store.save(other);
    await act(async () => {
      await h.get().disconnect();
    });
    await h.flush();
    expect(store.clears).toBe(0);
    expect(await store.load()).toBe(other);
    expect(h.get().status).toEqual({ phase: 'idle', blocker: null });

    // The foreign fact survives into the next click: with no name of its
    // own left, the guard would otherwise fall through and blind-clear the
    // peer's directory.
    await act(async () => {
      await h.get().disconnect();
    });
    await h.flush();
    expect(store.clears).toBe(0);
    expect(await store.load()).toBe(other);

    // An explicit connect persists this mount's own grant: the latch must
    // not veto revoking THAT record.
    await act(async () => {
      await h.get().connect();
    });
    await h.flush();
    expect(h.sockets).toHaveLength(1);
    await act(async () => {
      await h.get().disconnect();
    });
    await h.flush();
    expect(store.clears).toBe(1);
    expect(await store.load()).toBeUndefined();
    h.unmount();
  });

  it('keeps the foreign latch when a connect is invalidated before it binds', async () => {
    const handle = fakeHandle('ai_coding', { query: 'denied' });
    const store = fakeStore(handle);
    const h = render({
      sessionId: 'session-1',
      baseUrl: 'https://daemon.example/',
      win: secureWindow(async () => handle),
      store,
      locks: null,
    });
    await h.flush();
    await h.flush();
    expect(h.get().status.phase).toBe('needs-gesture');

    // A peer renames the origin-global record; the direct revoke refuses it
    // and latches the record as foreign.
    const other = fakeHandle('peer_dir', {
      query: 'prompt',
      request: 'granted',
    });
    await store.save(other);
    await act(async () => {
      await h.get().disconnect();
    });
    await h.flush();
    expect(store.clears).toBe(0);
    expect(h.get().status).toEqual({ phase: 'idle', blocker: null });

    // Gate the store: the reconnect parks inside save(), and the next
    // disconnect's revoke parks inside load() behind it.
    let releaseSave!: (ok: boolean) => void;
    const saveGate = new Promise<boolean>((resolve) => {
      releaseSave = resolve;
    });
    let releaseLoad!: () => void;
    const loadGate = new Promise<void>((resolve) => {
      releaseLoad = resolve;
    });
    let gateLoads = false;
    const realLoad = store.load;
    store.load = async () => {
      if (gateLoads) await loadGate;
      return realLoad();
    };
    store.save = async () => saveGate;

    // The connect is not wrapped in act: its open scope would hold back
    // this mount's own status commits while it stays parked.
    const connecting = h.get().connect();
    await h.flush();
    await h.flush();
    gateLoads = true;
    const disconnecting = h.get().disconnect();
    await h.flush();
    // The save resolves after the disconnect invalidated the connect: the
    // connect goes stale and binds nothing, so it must not clear the latch
    // the revoke is about to read.
    releaseSave(true);
    await h.flush();
    releaseLoad();
    await act(async () => {
      await connecting;
      await disconnecting;
    });
    await h.flush();
    expect(store.clears).toBe(0);
    expect(await store.load()).toBe(other);
    h.unmount();
  });

  it('does not name a foreign record while a blocker is live', async () => {
    const handle = fakeHandle('ai_coding', { query: 'granted' });
    const store = fakeStore(handle);
    const common = {
      sessionId: 'session-1' as string | undefined,
      baseUrl: 'https://daemon.example/',
      win: secureWindow(async () => handle),
      store,
      locks: null,
    };
    const h = render({ ...common, withheldBlocker: 'workspace-ineligible' });
    await h.flush();
    await h.flush();
    // The withheld entry names the stored grant so the panel's Disconnect —
    // the only revoke path — stays reachable over it.
    expect(h.get().status).toEqual({
      phase: 'unavailable',
      blocker: 'workspace-ineligible',
      rootName: 'ai_coding',
    });

    // A peer renames the origin-global record: the revoke refuses it, and
    // no arm may keep naming a record this mount can never clear.
    const other = fakeHandle('peer_dir', { query: 'granted' });
    await store.save(other);
    await act(async () => {
      await h.get().disconnect();
    });
    await h.flush();
    expect(store.clears).toBe(0);
    expect(await store.load()).toBe(other);
    expect(h.get().status).toEqual({
      phase: 'unavailable',
      blocker: 'workspace-ineligible',
    });

    // A blocker flip re-runs restore(): the foreign name must not return.
    h.rerender({ ...common, withheldBlocker: undefined });
    await h.flush();
    await h.flush();
    expect(h.get().status).toEqual({ phase: 'idle', blocker: null });
    h.rerender({ ...common, withheldBlocker: 'workspace-ineligible' });
    await h.flush();
    await h.flush();
    expect(h.get().status).toEqual({
      phase: 'unavailable',
      blocker: 'workspace-ineligible',
    });
    expect(h.sockets).toHaveLength(0);
    h.unmount();
  });

  it('does not name a foreign record when a connect fails after the latch', async () => {
    const handle = fakeHandle('ai_coding', { query: 'denied' });
    const store = fakeStore(handle);
    let rejectPicker!: (reason: unknown) => void;
    const pickerGate = new Promise<FileSystemDirectoryHandle>(
      (_resolve, reject) => {
        rejectPicker = reject;
      },
    );
    const h = render({
      sessionId: 'session-1',
      baseUrl: 'https://daemon.example/',
      win: secureWindow(async () => pickerGate),
      store,
      locks: null,
    });
    await h.flush();
    await h.flush();
    expect(h.get().status.phase).toBe('needs-gesture');

    const other = fakeHandle('peer_dir', { query: 'denied' });
    await store.save(other);
    await act(async () => {
      await h.get().disconnect();
    });
    await h.flush();
    expect(store.clears).toBe(0);

    // The picker fails with a real error: the failure write must not name
    // the foreign record either.
    const connecting = act(async () => {
      await h.get().connect();
    });
    await h.flush();
    rejectPicker(new Error('picker broke'));
    await connecting;
    await h.flush();
    expect(h.get().status).toEqual({
      phase: 'failed',
      blocker: null,
      message: 'picker broke',
    });
    h.unmount();
  });

  it('revokes the record this mount re-bound after the latch was set', async () => {
    const handle = fakeHandle('ai_coding', { query: 'granted' });
    const store = fakeStore(handle);
    const h = render({
      sessionId: 'session-1',
      baseUrl: 'https://daemon.example/',
      win: secureWindow(async () => handle),
      store,
      locks: null,
    });
    await h.flush();
    await h.flush();
    expect(h.sockets).toHaveLength(1);

    // A peer renames the origin-global record; the direct revoke refuses it
    // and latches the record as foreign.
    const other = fakeHandle('peer_dir', { query: 'granted' });
    await store.save(other);
    await act(async () => {
      await h.get().disconnect();
    });
    await h.flush();
    expect(store.clears).toBe(0);
    expect(h.get().status).toEqual({ phase: 'idle', blocker: null });

    // The user reconnects: the re-save fails soft, but the connect still
    // binds the record's own handle — this mount now owns and serves that
    // grant, so the latch must not veto its name-matching release.
    store.save = async () => false;
    await act(async () => {
      await h.get().connect();
    });
    await h.flush();
    expect(h.sockets).toHaveLength(2);
    expect(h.get().status).toMatchObject({
      phase: 'connecting',
      rootName: 'peer_dir',
    });

    await act(async () => {
      await h.get().disconnect();
    });
    await h.flush();
    expect(store.clears).toBe(1);
    expect(await store.load()).toBeUndefined();
    h.unmount();
  });

  it('names the surviving grant when a deferred revoke fails soft', async () => {
    const handle = fakeHandle('ai_coding', { query: 'denied' });
    const store = fakeStore(handle);
    let clearCalls = 0;
    store.clear = async () => {
      clearCalls += 1;
      return false;
    };
    const lock = { held: false, settling: 1 };
    let releaseDelay!: () => void;
    const delayGate = new Promise<void>((resolve) => {
      releaseDelay = resolve;
    });
    let rejectPicker!: (reason: unknown) => void;
    const pickerGate = new Promise<FileSystemDirectoryHandle>(
      (_resolve, reject) => {
        rejectPicker = reject;
      },
    );
    const locks: LockManagerLike = settlingLocks(lock);
    const h = render({
      sessionId: 'session-1',
      baseUrl: 'https://daemon.example/',
      win: secureWindow(async () => pickerGate),
      store,
      locks,
      delay: () => delayGate,
    });
    await h.flush();
    await h.flush();
    // needs-gesture: the stored grant is denied, so the panel names it and
    // offers Disconnect; no run was ever owned, so the revoke arbitrates.
    expect(h.get().status.phase).toBe('needs-gesture');

    const disconnectPromise = h.get().disconnect();
    await h.flush();
    // Attempt 0 declined on the settling release; the user connects inside
    // the inter-attempt delay, so attempt 1 defers the revoke to the
    // connect's finally.
    const connecting = act(async () => {
      await h.get().connect();
    });
    await h.flush();
    releaseDelay();
    await act(async () => {
      await disconnectPromise;
    });
    rejectPicker(new DOMException('user cancelled', 'AbortError'));
    await connecting;
    await h.flush();
    // The deferred revoke reached the store but the delete failed soft: the
    // record survives, so the panel must keep naming it — otherwise
    // Disconnect (the only store.clear() caller) never renders again.
    expect(clearCalls).toBe(1);
    expect(await store.load()).toBe(handle);
    expect(h.get().status).toEqual({
      phase: 'idle',
      blocker: null,
      rootName: 'ai_coding',
    });
    h.unmount();
  });

  it('drops the name when a deferred revoke clears behind a re-ask', async () => {
    const handle = fakeHandle('ai_coding', {
      query: 'prompt',
      request: 'prompt',
    });
    let releaseRequest!: (state: PermissionState) => void;
    const requestGate = new Promise<PermissionState>((resolve) => {
      releaseRequest = resolve;
    });
    vi.mocked(handle.requestPermission).mockImplementation(() => requestGate);
    const store = fakeStore(handle);
    const lock = { held: false, settling: 1 };
    let releaseDelay!: () => void;
    const delayGate = new Promise<void>((resolve) => {
      releaseDelay = resolve;
    });
    const locks: LockManagerLike = settlingLocks(lock);
    const h = render({
      sessionId: 'session-1',
      baseUrl: 'https://daemon.example/',
      win: secureWindow(async () => handle),
      store,
      locks,
      delay: () => delayGate,
    });
    await h.flush();
    await h.flush();
    expect(h.get().status.phase).toBe('needs-gesture');

    const disconnectPromise = h.get().disconnect();
    await h.flush();
    // Attempt 0 declined on the settling release; the user reconnects
    // inside the window and the permission re-ask keeps the connect in
    // flight when attempt 1 lands, so the revoke defers.
    const connecting = act(async () => {
      await h.get().connect();
    });
    await h.flush();
    releaseDelay();
    await act(async () => {
      await disconnectPromise;
    });
    // The re-ask came back still prompt: the connect re-arms needs-gesture
    // (naming the grant), and its finally runs the deferred revoke — which
    // clears, so the panel must stop naming a record that no longer exists.
    releaseRequest('prompt');
    await connecting;
    await h.flush();
    expect(store.clears).toBe(1);
    expect(await store.load()).toBeUndefined();
    expect(h.get().status).toEqual({ phase: 'idle', blocker: null });
    h.unmount();
  });

  it('revokes when the deferred connect only attempted to save', async () => {
    const handle = fakeHandle('ai_coding', { query: 'denied' });
    const store = fakeStore(handle);
    // The save fails soft and writes nothing (the store's own contract):
    // the record still holds the ORIGINAL directory, so the connect must
    // not stamp the saved flag that vetoes the pending revoke.
    store.save = async () => false;
    const lock = { held: false, settling: 1 };
    let releaseDelay!: () => void;
    const delayGate = new Promise<void>((resolve) => {
      releaseDelay = resolve;
    });
    let resolvePicker!: (value: FileSystemDirectoryHandle) => void;
    const pickerGate = new Promise<FileSystemDirectoryHandle>((resolve) => {
      resolvePicker = resolve;
    });
    const locks: LockManagerLike = settlingLocks(lock);
    const h = render({
      sessionId: undefined,
      baseUrl: 'https://daemon.example/',
      win: secureWindow(async () => pickerGate),
      store,
      locks,
      delay: () => delayGate,
    });
    await h.flush();
    await h.flush();
    expect(h.get().status.phase).toBe('needs-gesture');

    const disconnectPromise = h.get().disconnect();
    await h.flush();
    // Attempt 0 declined on the settling release; the user connects inside
    // the window, the denied stored grant falls through to the picker, and
    // attempt 1 defers the revoke.
    const connecting = act(async () => {
      await h.get().connect();
    });
    await h.flush();
    releaseDelay();
    await act(async () => {
      await disconnectPromise;
    });
    resolvePicker(fakeHandle('new_dir', { query: 'granted' }));
    await connecting;
    await h.flush();
    // The soft-failed save left the original record in place, and the
    // deferred revoke reaches it.
    expect(store.clears).toBe(1);
    expect(await store.load()).toBeUndefined();
    h.unmount();
  });

  it('keeps the record when the deferred reconnect re-saved nothing but bound a bridge', async () => {
    const perms = { query: 'denied' as PermissionState };
    const handle = fakeHandle('ai_coding', perms);
    const store = fakeStore(handle);
    // The re-save fails soft and writes nothing (the store's own contract),
    // so connectSavedRef stays false — but the stored-handle arm still binds
    // a bridge to the record's own handle, and the deferred revoke must not
    // delete that record out from under the live bridge.
    store.save = async () => false;
    const lock = { held: false, settling: 1 };
    let releaseDelay!: () => void;
    const delayGate = new Promise<void>((resolve) => {
      releaseDelay = resolve;
    });
    const locks: LockManagerLike = settlingLocks(lock);
    const h = render({
      sessionId: 'session-1',
      baseUrl: 'https://daemon.example/',
      win: secureWindow(async () => handle),
      store,
      locks,
      delay: () => delayGate,
    });
    await h.flush();
    await h.flush();
    expect(h.get().status.phase).toBe('needs-gesture');

    const disconnectPromise = h.get().disconnect();
    await h.flush();
    // Attempt 0 declined on the settling release; the user reconnects
    // inside the window and the permission re-query keeps the connect in
    // flight when attempt 1 lands, so the revoke defers.
    let releaseQuery!: (state: PermissionState) => void;
    const queryGate = new Promise<PermissionState>((resolve) => {
      releaseQuery = resolve;
    });
    vi.mocked(handle.queryPermission).mockImplementation(() => queryGate);
    const connecting = h.get().connect();
    await h.flush();
    await h.flush();
    releaseDelay();
    await act(async () => {
      await disconnectPromise;
    });
    // The re-query answers granted: the reconnect binds a live bridge to
    // the record's own handle, so the record is this connect's own grant
    // and the deferred revoke must leave it standing.
    releaseQuery('granted');
    await act(async () => {
      await connecting;
    });
    await h.flush();
    expect(store.clears).toBe(0);
    expect(await store.load()).toBe(handle);
    expect(h.sockets).toHaveLength(1);
    expect(h.get().status).toEqual({
      phase: 'connecting',
      blocker: null,
      rootName: 'ai_coding',
    });
    h.unmount();
  });

  it('revokes when the deferred connect bound a live bridge in this mount', async () => {
    const handle = fakeHandle('ai_coding', { query: 'denied' });
    const store = fakeStore(handle);
    // The save fails soft and writes nothing (the store's own contract), so
    // the record is not the connect's own grant — but with a session live
    // the connect still starts a bridge, and the deferred revoke must not
    // be declined by this mount's OWN lock.
    store.save = async () => false;
    const lock = { held: false, settling: 1 };
    let releaseDelay!: () => void;
    const delayGate = new Promise<void>((resolve) => {
      releaseDelay = resolve;
    });
    let resolvePicker!: (value: FileSystemDirectoryHandle) => void;
    const pickerGate = new Promise<FileSystemDirectoryHandle>((resolve) => {
      resolvePicker = resolve;
    });
    const locks: LockManagerLike = settlingLocks(lock);
    const h = render({
      sessionId: 'session-1',
      baseUrl: 'https://daemon.example/',
      win: secureWindow(async () => pickerGate),
      store,
      locks,
      delay: () => delayGate,
    });
    await h.flush();
    await h.flush();
    expect(h.get().status.phase).toBe('needs-gesture');

    const disconnectPromise = h.get().disconnect();
    await h.flush();
    const connecting = act(async () => {
      await h.get().connect();
    });
    await h.flush();
    releaseDelay();
    await act(async () => {
      await disconnectPromise;
    });
    // The deferred revoke is reached from the connect's finally, after the
    // soft-failed save left the original record in place.
    resolvePicker(fakeHandle('new_dir', { query: 'granted' }));
    await connecting;
    await h.flush();
    expect(store.clears).toBe(1);
    expect(await store.load()).toBeUndefined();
    h.unmount();
  });

  it('keeps the live bridge status when a deferred revoke settles behind a soft-failed save', async () => {
    const handle = fakeHandle('ai_coding', { query: 'denied' });
    const store = fakeStore(handle);
    store.save = async () => false;
    const lock = { held: false, settling: 1 };
    let releaseDelay!: () => void;
    const delayGate = new Promise<void>((resolve) => {
      releaseDelay = resolve;
    });
    let resolvePicker!: (value: FileSystemDirectoryHandle) => void;
    const pickerGate = new Promise<FileSystemDirectoryHandle>((resolve) => {
      resolvePicker = resolve;
    });
    const locks: LockManagerLike = settlingLocks(lock);
    const h = render({
      sessionId: 'session-1',
      baseUrl: 'https://daemon.example/',
      win: secureWindow(async () => pickerGate),
      store,
      locks,
      delay: () => delayGate,
    });
    await h.flush();
    await h.flush();
    expect(h.get().status.phase).toBe('needs-gesture');

    const disconnectPromise = h.get().disconnect();
    await h.flush();
    const connecting = act(async () => {
      await h.get().connect();
    });
    await h.flush();
    releaseDelay();
    await act(async () => {
      await disconnectPromise;
    });
    resolvePicker(fakeHandle('new_dir', { query: 'granted' }));
    await connecting;
    await h.flush();
    // The connect bound a handle and a live bridge despite the soft-failed
    // save: the deferred revoke's clear stands, but its status branch must
    // not overwrite the bridge's own write with the pre-click panel.
    expect(h.sockets).toHaveLength(1);
    expect(h.get().status).toEqual({
      phase: 'connecting',
      blocker: null,
      rootName: 'new_dir',
    });
    h.unmount();
  });

  it('still revokes when the view unmounts inside the arbitration backoff', async () => {
    const handle = fakeHandle('ai_coding', { query: 'granted' });
    const store = fakeStore(handle);
    const lock = { held: false, settling: 0 };
    let releaseDelay!: () => void;
    const delayGate = new Promise<void>((resolve) => {
      releaseDelay = resolve;
    });
    const locks: LockManagerLike = settlingLocks(lock);
    const common = {
      baseUrl: 'https://daemon.example/',
      win: secureWindow(async () => handle),
      store,
      locks,
      delay: () => delayGate,
    };
    const hA = render({ ...common, sessionId: 'session-A' });
    await hA.flush();
    await hA.flush();
    expect(hA.sockets).toHaveLength(1);

    // No session: B restores the grant but never owns the lock.
    const hB = render({ ...common, sessionId: undefined });
    await hB.flush();
    await hB.flush();
    expect(hB.get().status.phase).toBe('needs-session');

    // A goes away with its release still settling: attempt 0 declines and
    // the arbitration parks in the inter-attempt delay.
    lock.settling = 1;
    hA.unmount();
    await hB.flush();
    const disconnecting = act(async () => {
      await hB.get().disconnect();
    });
    await hB.flush();
    // The view unmounts inside the backoff. Losing the UI must not cancel
    // the revoke the user asked for — only a newer disconnect may.
    hB.unmount();
    releaseDelay();
    await disconnecting;
    expect(store.clears).toBe(1);
    expect(await store.load()).toBeUndefined();
  });

  it('restores the panel state when every arbitration attempt is declined', async () => {
    const handle = fakeHandle('ai_coding', { query: 'granted' });
    const store = fakeStore(handle);
    const common = {
      baseUrl: 'https://daemon.example/',
      win: secureWindow(async () => handle),
      store,
      locks: exclusiveLocks(),
      delay: async () => {},
    };
    const hA = render({ ...common, sessionId: 'session-A' });
    await hA.flush();
    await hA.flush();
    expect(hA.sockets).toHaveLength(1);

    const hB = render({ ...common, sessionId: 'session-B' });
    await hB.flush();
    await hB.flush();
    expect(hB.get().status.phase).toBe('held-elsewhere');

    // The owner stays alive: all three attempts decline, nothing is revoked,
    // and the optimistic terminal status must not stand - the record and
    // B's parked bridge are both still there.
    await act(async () => {
      await hB.get().disconnect();
    });
    expect(store.clears).toBe(0);
    expect(await store.load()).toBe(handle);
    expect(hB.get().status).toEqual({
      phase: 'held-elsewhere',
      blocker: null,
      rootName: 'ai_coding',
    });

    // A second declined click must restore the same state: the parked
    // bridge settled start() terminally and stopBridge() dropped the ref,
    // so the pre-click phase now lives only in the rendered status.
    await act(async () => {
      await hB.get().disconnect();
    });
    expect(store.clears).toBe(0);
    expect(await store.load()).toBe(handle);
    expect(hB.get().status).toEqual({
      phase: 'held-elsewhere',
      blocker: null,
      rootName: 'ai_coding',
    });
    hA.unmount();
    hB.unmount();
  });

  it('reports idle, not held-elsewhere, when a granted revoke fails soft', async () => {
    const handle = fakeHandle('ai_coding', { query: 'granted' });
    const store = fakeStore(handle);
    let clearCalls = 0;
    store.clear = async () => {
      clearCalls += 1;
      return false;
    };
    const common = {
      baseUrl: 'https://daemon.example/',
      win: secureWindow(async () => handle),
      store,
      locks: exclusiveLocks(),
      delay: async () => {},
    };
    const hA = render({ ...common, sessionId: 'session-A' });
    await hA.flush();
    await hA.flush();
    expect(hA.sockets).toHaveLength(1);

    const hB = render({ ...common, sessionId: 'session-B' });
    await hB.flush();
    await hB.flush();
    expect(hB.get().status.phase).toBe('held-elsewhere');

    // The first click is genuinely declined: the parked restore is pinned.
    await act(async () => {
      await hB.get().disconnect();
    });
    expect(hB.get().status.phase).toBe('held-elsewhere');

    // The owner leaves, so the second click is GRANTED the lock, but the
    // delete itself fails soft: no peer holds anything, so the panel must
    // not claim another tab owns the directory.
    hA.unmount();
    await act(async () => {
      await hB.get().disconnect();
    });
    expect(clearCalls).toBe(1);
    expect(await store.load()).toBe(handle);
    expect(hB.get().status).toEqual({
      phase: 'idle',
      blocker: null,
      rootName: 'ai_coding',
    });
    hB.unmount();
  });

  it('keeps the withhold when a declined revoke runs under a blocker', async () => {
    const handle = fakeHandle('ai_coding', { query: 'granted' });
    const store = fakeStore(handle);
    const locks = exclusiveLocks();
    const common = {
      baseUrl: 'https://daemon.example/',
      win: secureWindow(async () => handle),
      store,
      locks,
      delay: async () => {},
    };
    // A trusted peer owns the lock with a live bridge.
    const hA = render({ ...common, sessionId: 'session-A' });
    await hA.flush();
    await hA.flush();
    expect(hA.sockets).toHaveLength(1);

    // B's workspace is withheld: restore names the stored grant so the
    // panel's Disconnect (the only revoke path) renders over it.
    const hB = render({
      ...common,
      sessionId: 'session-B',
      withheldBlocker: 'workspace-ineligible',
    });
    await hB.flush();
    await hB.flush();
    expect(hB.get().status).toEqual({
      phase: 'unavailable',
      blocker: 'workspace-ineligible',
      rootName: 'ai_coding',
    });

    // Every arbitration attempt declines on A's lock: nothing was revoked,
    // so the reconcile must restore the withhold, not a connectable idle.
    await act(async () => {
      await hB.get().disconnect();
    });
    expect(store.clears).toBe(0);
    expect(await store.load()).toBe(handle);
    expect(hB.get().status).toEqual({
      phase: 'unavailable',
      blocker: 'workspace-ineligible',
      rootName: 'ai_coding',
    });
    hA.unmount();
    hB.unmount();
  });

  it('reads the live blocker when a declined revoke settles after it cleared', async () => {
    const handle = fakeHandle('ai_coding', { query: 'granted' });
    const store = fakeStore(handle);
    const locks = exclusiveLocks();
    let releaseDelay!: () => void;
    const delayGate = new Promise<void>((resolve) => {
      releaseDelay = resolve;
    });
    const common = {
      baseUrl: 'https://daemon.example/',
      win: secureWindow(async () => handle),
      store,
      locks,
      delay: () => delayGate,
    };
    const hA = render({ ...common, sessionId: 'session-A' });
    await hA.flush();
    await hA.flush();
    expect(hA.sockets).toHaveLength(1);

    // B starts withheld: restore names the stored grant so Disconnect
    // renders, and its click arbitrates against A's lock.
    const hB = render({
      ...common,
      sessionId: 'session-B',
      withheldBlocker: 'workspace-resolving',
    });
    await hB.flush();
    await hB.flush();
    expect(hB.get().status).toEqual({
      phase: 'unavailable',
      blocker: 'workspace-resolving',
      rootName: 'ai_coding',
    });

    const disconnecting = hB.get().disconnect();
    await hB.flush();
    // Attempt 0 declined on A's lock; while the arbitration waits in the
    // inter-attempt delay the capabilities snapshot lands and the withhold
    // clears.
    hB.rerender({ withheldBlocker: undefined });
    await hB.flush();
    releaseDelay();
    await act(async () => {
      await disconnecting;
    });
    await hB.flush();
    // Every attempt declined, so the record survives — but the reconcile
    // must read the LIVE blocker, not re-assert the one from click time.
    expect(store.clears).toBe(0);
    expect(hB.get().status).toEqual({
      phase: 'idle',
      blocker: null,
      rootName: 'ai_coding',
    });
    hA.unmount();
    hB.unmount();
  });

  it('lets the newer disconnect own the status when two clicks overlap', async () => {
    const handle = fakeHandle('ai_coding', { query: 'granted' });
    const store = fakeStore(handle);
    const locks = exclusiveLocks();
    const delayResolvers: Array<() => void> = [];
    const common = {
      baseUrl: 'https://daemon.example/',
      win: secureWindow(async () => handle),
      store,
      locks,
      delay: () =>
        new Promise<void>((resolve) => {
          delayResolvers.push(resolve);
        }),
    };
    const hA = render({ ...common, sessionId: 'session-A' });
    await hA.flush();
    await hA.flush();
    expect(hA.sockets).toHaveLength(1);

    const hB = render({ ...common, sessionId: 'session-B' });
    await hB.flush();
    for (let i = 0; i < 8 && hB.get().status.phase !== 'held-elsewhere'; i++) {
      delayResolvers.shift()?.();
      await hB.flush();
    }
    expect(hB.get().status.phase).toBe('held-elsewhere');

    // Click #1 parks in the inter-attempt delay; a blocker flip in that
    // window is what re-renders Disconnect for click #2.
    const first = hB.get().disconnect();
    await hB.flush();
    hB.rerender({ withheldBlocker: 'workspace-ineligible' });
    await hB.flush();
    // The peer releases and click #2 acquires the freed lock and clears.
    hA.unmount();
    // Let the owner's lock-release finally settle, or click #2's attempt 0
    // declines on the stale held flag and parks next to click #1.
    await hB.flush();
    await act(async () => {
      await hB.get().disconnect();
    });
    expect(store.clears).toBe(1);
    // Click #1's arbitration then settles, superseded: its captured restore
    // must not overwrite the newer disconnect's withhold.
    for (let i = 0; i < 8 && delayResolvers.length > 0; i++) {
      delayResolvers.shift()?.();
      await hB.flush();
    }
    await act(async () => {
      await first;
    });
    expect(hB.get().status).toEqual({
      phase: 'unavailable',
      blocker: 'workspace-ineligible',
    });
    hB.unmount();
  });

  it('lets the newer disconnect own the status when a deferred revoke settles late', async () => {
    const handle = fakeHandle('ai_coding', { query: 'prompt' });
    const store = fakeStore(handle);
    const lock = { held: false, settling: 0 };
    let releaseDelay!: () => void;
    const delayGate = new Promise<void>((resolve) => {
      releaseDelay = resolve;
    });
    let denyPermission!: (value: PermissionState) => void;
    const permissionGate = new Promise<PermissionState>((resolve) => {
      denyPermission = resolve;
    });
    vi.mocked(handle.requestPermission).mockImplementation(
      () => permissionGate,
    );
    const common = {
      baseUrl: 'https://daemon.example/',
      win: secureWindow(async () => handle),
      store,
      locks: settlingLocks(lock),
      delay: () => delayGate,
    };
    const hB = render({ ...common, sessionId: undefined });
    await hB.flush();
    await hB.flush();
    expect(hB.get().status.phase).toBe('needs-gesture');
    lock.settling = 1;
    const first = act(async () => {
      await hB.get().disconnect();
    });
    await hB.flush();
    const connecting = act(async () => {
      await hB.get().connect();
    });
    await hB.flush();
    // Attempt 1 grants while the connect is in flight: the revoke defers.
    releaseDelay();
    await first;
    // A newer disconnect clears the record and writes the withheld status.
    hB.rerender({
      ...common,
      sessionId: undefined,
      withheldBlocker: 'workspace-ineligible',
    });
    await hB.flush();
    await act(async () => {
      await hB.get().disconnect();
    });
    expect(store.clears).toBe(1);
    // The stale deferred revoke settles after the newer disconnect's write
    // and must leave that status alone.
    await act(async () => {
      denyPermission('denied');
      await connecting;
    });
    await hB.flush();
    expect(hB.get().status).toEqual({
      phase: 'unavailable',
      blocker: 'workspace-ineligible',
    });
    hB.unmount();
  });

  it('reconciles the status when the delete itself fails soft', async () => {
    const handle = fakeHandle('ai_coding', { query: 'granted' });
    const store = fakeStore(handle);
    let clearCalls = 0;
    store.clear = async () => {
      clearCalls += 1;
      return false;
    };
    const h = render({
      sessionId: 'session-1',
      baseUrl: 'https://daemon.example/',
      win: secureWindow(async () => handle),
      store,
    });
    await h.flush();
    await h.flush();
    expect(h.sockets).toHaveLength(1);

    await act(async () => {
      await h.get().disconnect();
    });
    // The record survived the failed delete: the panel must keep naming it
    // and offering the revoke, not report a disconnect that did not happen.
    expect(clearCalls).toBe(1);
    expect(h.get().status).toMatchObject({
      phase: 'idle',
      blocker: null,
      rootName: 'ai_coding',
    });
    h.unmount();
  });

  it('names the stored grant when the picker fails under a denied permission', async () => {
    const handle = fakeHandle('ai_coding', { query: 'denied' });
    const store = fakeStore(handle);
    const h = render({
      sessionId: 'session-1',
      baseUrl: 'https://daemon.example/',
      win: secureWindow(async () => {
        throw new DOMException('Blocked by policy', 'SecurityError');
      }),
      store,
    });
    await h.flush();
    await h.flush();
    expect(h.get().status).toMatchObject({
      phase: 'needs-gesture',
      rootName: 'ai_coding',
    });

    await act(async () => {
      await h.get().connect();
    });
    // The failure write must not hide the revoke affordance over a record
    // the store still holds.
    expect(h.get().status).toMatchObject({
      phase: 'failed',
      rootName: 'ai_coding',
    });
    expect(await store.load()).toBe(handle);
    h.unmount();
  });

  it("keeps the disconnect's idle write when the picker-failure name read settles behind it", async () => {
    const handle = fakeHandle('ai_coding', { query: 'denied' });
    const store = fakeStore(handle);
    let releaseLoad!: () => void;
    const loadGate = new Promise<void>((resolve) => {
      releaseLoad = resolve;
    });
    // Gate only the failure branch's name read: load 1 is restore's, load
    // 2 the connect's stored-handle read, load 3 the failure branch's.
    const baseLoad = store.load;
    let loads = 0;
    store.load = async () => {
      loads += 1;
      if (loads === 3) await loadGate;
      return baseLoad();
    };
    const h = render({
      sessionId: 'session-1',
      baseUrl: 'https://daemon.example/',
      win: secureWindow(async () => {
        throw new DOMException('Blocked by policy', 'SecurityError');
      }),
      store,
    });
    await h.flush();
    await h.flush();
    expect(h.get().status).toMatchObject({
      phase: 'needs-gesture',
      rootName: 'ai_coding',
    });

    const connecting = h.get().connect();
    await h.flush();
    await h.flush();
    // The picker failed and the connect parked on the gated name read; a
    // disconnect landing in that window completes and must own the panel.
    await act(async () => {
      await h.get().disconnect();
    });
    expect(store.clears).toBe(1);
    expect(await store.load()).toBeUndefined();
    releaseLoad();
    await act(async () => {
      await connecting;
    });
    await h.flush();
    expect(h.get().status).toEqual({ phase: 'idle', blocker: null });
    h.unmount();
  });

  it("keeps the disconnect's idle write when the picker-unavailable name read settles behind it", async () => {
    const handle = fakeHandle('ai_coding', { query: 'denied' });
    const store = fakeStore(handle);
    let releaseLoad!: () => void;
    const loadGate = new Promise<void>((resolve) => {
      releaseLoad = resolve;
    });
    // Gate only the unavailable branch's name read: load 1 is restore's,
    // load 2 the connect's stored-handle read, load 3 the branch's.
    const baseLoad = store.load;
    let loads = 0;
    store.load = async () => {
      loads += 1;
      if (loads === 3) await loadGate;
      return baseLoad();
    };
    const win = secureWindow(async () => handle);
    const h = render({
      sessionId: 'session-1',
      baseUrl: 'https://daemon.example/',
      win,
      store,
    });
    await h.flush();
    await h.flush();
    expect(h.get().status).toMatchObject({
      phase: 'needs-gesture',
      rootName: 'ai_coding',
    });

    // The picker vanishes after the mount's probe: the connect's own
    // re-detection reports unavailable and parks on the gated name read.
    win.showDirectoryPicker = undefined;
    const connecting = h.get().connect();
    await h.flush();
    await h.flush();
    await act(async () => {
      await h.get().disconnect();
    });
    expect(store.clears).toBe(1);
    expect(await store.load()).toBeUndefined();
    releaseLoad();
    await act(async () => {
      await connecting;
    });
    await h.flush();
    expect(h.get().status).toEqual({ phase: 'idle', blocker: null });
    h.unmount();
  });

  it('revokes on the owner side even when its release outlasts the budget', async () => {
    const handle = fakeHandle('ai_coding', { query: 'granted' });
    const store = fakeStore(handle);
    // The release never settles inside the attempt budget: only the owned
    // run latch can keep this disconnect from arbitrating against the tab's
    // own still-settling lock.
    const lock = { held: false, settling: 0 };
    const locks: LockManagerLike = settlingLocks(lock);
    const h = render({
      sessionId: 'session-1',
      baseUrl: 'https://daemon.example/',
      win: secureWindow(async () => handle),
      store,
      locks,
      delay: async () => {},
    });
    await h.flush();
    await h.flush();
    expect(h.sockets).toHaveLength(1);

    lock.settling = 10;
    await act(async () => {
      await h.get().disconnect();
    });
    expect(store.clears).toBe(1);
    expect(await store.load()).toBeUndefined();
    h.unmount();
  });

  it('revokes over a connect the disconnect already invalidated', async () => {
    const handle = fakeHandle('ai_coding', { query: 'prompt' });
    let releaseRequest!: (state: PermissionState) => void;
    const gate = new Promise<PermissionState>((resolve) => {
      releaseRequest = resolve;
    });
    vi.mocked(handle.requestPermission).mockImplementation(() => gate);
    const store = fakeStore(handle);
    const h = render({
      sessionId: 'session-1',
      baseUrl: 'https://daemon.example/',
      win: secureWindow(async () => handle),
      store,
    });
    await h.flush();
    // needs-gesture: both Reconnect and Disconnect render, and the Chrome
    // permission prompt does not block page input.
    expect(h.get().status.phase).toBe('needs-gesture');

    // Reconnect parks inside requestPermission; Disconnect lands while up.
    const parkedConnect = act(async () => {
      await h.get().connect();
    });
    await h.flush();
    await act(async () => {
      await h.get().disconnect();
    });
    // The parked connect was invalidated by this disconnect and saves
    // nothing, so it must not veto the revoke.
    expect(store.clears).toBe(1);
    expect(await store.load()).toBeUndefined();
    releaseRequest('granted');
    await h.flush();
    // Balance the act scope the parked connect opened before the test ends,
    // or the next render inherits an acting React root.
    await parkedConnect;
    expect(store.saves).toHaveLength(0);
    h.unmount();
  });

  it('keeps the record a connect started after the disconnect writes', async () => {
    const handle = fakeHandle('ai_coding', { query: 'granted' });
    const store = fakeStore();
    const h = render({
      sessionId: 'session-1',
      baseUrl: 'https://daemon.example/',
      win: secureWindow(async () => handle),
      store,
    });
    await h.flush();
    await act(async () => {
      await h.get().disconnect();
    });
    expect(store.clears).toBe(1);
    await act(async () => {
      await h.get().connect();
    });
    await h.flush();
    // A connect at or after the disconnect's generation still writes the
    // record, and its save must survive the revoke guard.
    expect(store.saves).toHaveLength(1);
    expect(await store.load()).toBe(handle);
    h.unmount();
  });

  it('keeps the stored grant named when the session changes under a blocker', async () => {
    const handle = fakeHandle('ai_coding', { query: 'granted' });
    const store = fakeStore(handle);
    const common = {
      baseUrl: 'https://daemon.example/',
      win: secureWindow(async () => handle),
      store,
    };
    const h = render({
      ...common,
      sessionId: 'session-1',
      withheldBlocker: 'unsupported-daemon',
    });
    await h.flush();
    await h.flush();
    expect(h.get().status.rootName).toBe('ai_coding');

    h.rerender({
      ...common,
      sessionId: 'session-2',
      withheldBlocker: 'unsupported-daemon',
    });
    await h.flush();
    await h.flush();
    // The rebind effect's blocker write must not drop the name, or the
    // panel loses its only revoke affordance over a stored grant.
    expect(h.get().status).toMatchObject({
      phase: 'unavailable',
      blocker: 'unsupported-daemon',
      rootName: 'ai_coding',
    });
    h.unmount();
  });

  it('names a grant made while a blocker flips in mid-picker', async () => {
    let release!: (value: FileSystemDirectoryHandle) => void;
    const gate = new Promise<FileSystemDirectoryHandle>((resolve) => {
      release = resolve;
    });
    const handle = fakeHandle('ai_coding', { query: 'granted' });
    const store = fakeStore();
    const common = {
      baseUrl: 'https://daemon.example/',
      win: secureWindow(async () => gate),
      store,
    };
    const h = render({ ...common, sessionId: 'session-1' });
    await h.flush();
    // Not wrapped in act: an open async act scope would defer the rerender's
    // commit below until the connect settles, racing the capability update.
    const pending = h.get().connect();
    await h.flush();
    // Capabilities resolve the workspace ineligible while the picker is up.
    h.rerender({
      ...common,
      sessionId: 'session-1',
      withheldBlocker: 'workspace-ineligible',
    });
    await act(async () => {
      release(handle);
      await pending;
    });
    await h.flush();
    // The pick persisted under the blocker; startBridge's blocker return
    // must name it so the revoke path stays reachable.
    expect(store.saves).toHaveLength(1);
    expect(h.get().status).toMatchObject({
      phase: 'unavailable',
      blocker: 'workspace-ineligible',
      rootName: 'ai_coding',
    });
    expect(h.sockets).toHaveLength(0);
    h.unmount();
  });

  it('names the stored grant under a withheld blocker so revoke stays reachable', async () => {
    const handle = fakeHandle('ai_coding', { query: 'granted' });
    const store = fakeStore(handle);
    const h = render({
      sessionId: 'session-1',
      baseUrl: 'https://daemon.example/',
      win: secureWindow(async () => handle),
      store,
      withheldBlocker: 'unsupported-daemon',
    });
    await h.flush();
    await h.flush();
    expect(h.get().status).toMatchObject({
      phase: 'unavailable',
      blocker: 'unsupported-daemon',
      rootName: 'ai_coding',
    });
    expect(h.sockets).toHaveLength(0);

    await act(async () => {
      await h.get().disconnect();
    });
    await h.flush();
    expect(store.clears).toBe(1);
    h.unmount();
  });

  it('lets the browser probe outrank a withheld reason', async () => {
    const top = {};
    Object.defineProperty(top, 'location', {
      get() {
        throw new DOMException('Blocked', 'SecurityError');
      },
    });
    const h = render({
      sessionId: 'session-1',
      baseUrl: 'https://daemon.example/',
      win: {
        isSecureContext: true,
        showDirectoryPicker: () => Promise.resolve(fakeHandle('x')),
        self: {},
        top,
      },
      store: fakeStore(),
      withheldBlocker: 'workspace-resolving',
    });
    await h.flush();
    // The probe's copy carries the only recovery affordance (open in a new
    // tab); a transient withheld reason must not mask it on first paint.
    expect(h.get().status.blocker).toBe('cross-origin-frame');
    h.unmount();
  });

  it('reports start_failed when the lock request rejects outright', async () => {
    const handle = fakeHandle('ai_coding', { query: 'granted' });
    const h = render({
      sessionId: 'session-1',
      baseUrl: 'https://daemon.example/',
      win: secureWindow(async () => handle),
      store: fakeStore(handle),
      locks: {
        request: async () => {
          throw new DOMException('blocked by policy', 'SecurityError');
        },
      },
    });
    await h.flush();
    await h.flush();
    expect(h.get().status).toMatchObject({ phase: 'failed' });
    h.unmount();
  });

  it('tears down a socket opened before a late start() rejection', async () => {
    const handle = fakeHandle('ai_coding', { query: 'granted' });
    const h = render({
      sessionId: 'session-1',
      baseUrl: 'https://daemon.example/',
      win: secureWindow(async () => handle),
      store: fakeStore(handle),
      locks: {
        request: async (_name, _options, callback) => {
          const run = callback({});
          // Let run() open its socket before the rejection escapes.
          await Promise.resolve();
          await Promise.resolve();
          void run.catch(() => {});
          throw new DOMException('blocked by policy', 'SecurityError');
        },
      },
    });
    await h.flush();
    await h.flush();
    // fail() runs teardown(): a socket opened before the rejection must be
    // closed, not left dangling behind the failed status.
    expect(h.sockets).toHaveLength(1);
    expect(h.sockets[0]!.closeCount).toBe(1);
    expect(h.get().status).toMatchObject({ phase: 'failed' });
    h.unmount();
  });

  it('stops the running bridge when a blocker activates late', async () => {
    const handle = fakeHandle('ai_coding', { query: 'granted' });
    const common = {
      baseUrl: 'https://daemon.example/',
      win: secureWindow(async () => handle),
      store: fakeStore(handle),
    };
    const h = render({ ...common, sessionId: 'session-1' });
    await h.flush();
    await h.flush();
    expect(h.sockets).toHaveLength(1);

    // Capabilities resolve the session's workspace as ineligible after the
    // bridge started: the running bridge must stop and the panel withhold.
    h.rerender({
      ...common,
      sessionId: 'session-1',
      withheldBlocker: 'workspace-ineligible',
    });
    await h.flush();
    await h.flush();
    expect(h.sockets[0]!.closeCount).toBe(1);
    expect(h.get().status).toEqual({
      phase: 'unavailable',
      blocker: 'workspace-ineligible',
      rootName: 'ai_coding',
    });
    h.unmount();
  });

  it('keeps a live bridge when a transient resolving verdict lands mid-session', async () => {
    const handle = fakeHandle('ai_coding', { query: 'granted' });
    const common = {
      baseUrl: 'https://daemon.example/',
      win: secureWindow(async () => handle),
      store: fakeStore(handle),
    };
    const h = render({ ...common, sessionId: 'session-1' });
    await h.flush();
    await h.flush();
    expect(h.sockets).toHaveLength(1);
    const socket = h.sockets[0]!;
    socket.emitOpen();
    socket.emit({
      jsonrpc: '2.0',
      id: 'local-files-acp-initialize',
      result: {},
    });
    await h.flush();
    socket.emit({
      type: 'mcp_registered',
      server: 'local-files',
      toolCount: 4,
    });
    await h.flush();
    expect(h.get().status).toEqual({
      phase: 'connected',
      blocker: null,
      rootName: 'ai_coding',
      toolCount: 4,
    });

    // A registry/snapshot blip resolves to the transient pending verdict:
    // the bridge still bound to this session must not be torn down mid-turn.
    h.rerender({
      ...common,
      sessionId: 'session-1',
      withheldBlocker: 'workspace-resolving',
    });
    await h.flush();
    await h.flush();
    expect(socket.closeCount).toBe(0);
    expect(h.get().status.phase).toBe('connected');

    // When the verdict clears, restore and the rebind effect re-run: the
    // live, correctly-routed bridge must survive that too, not just the
    // verdict itself.
    h.rerender({
      ...common,
      sessionId: 'session-1',
      withheldBlocker: undefined,
    });
    await h.flush();
    await h.flush();
    expect(socket.closeCount).toBe(0);
    expect(h.sockets).toHaveLength(1);
    expect(h.get().status).toEqual({
      phase: 'connected',
      blocker: null,
      rootName: 'ai_coding',
      toolCount: 4,
    });

    // A hard verdict still stops the same bridge.
    h.rerender({
      ...common,
      sessionId: 'session-1',
      withheldBlocker: 'workspace-ineligible',
    });
    await h.flush();
    await h.flush();
    expect(socket.closeCount).toBe(1);
    expect(h.get().status).toEqual({
      phase: 'unavailable',
      blocker: 'workspace-ineligible',
      rootName: 'ai_coding',
    });
    h.unmount();
  });

  it('treats a same-named foreign record as foreign while a bridge is live', async () => {
    const mine = fakeHandle('project', { query: 'granted' });
    const store = fakeStore(mine);
    const common = {
      baseUrl: 'https://daemon.example/',
      win: secureWindow(async () => mine),
      store,
    };
    const h = render({ ...common, sessionId: 'session-1' });
    await h.flush();
    await h.flush();
    expect(h.sockets).toHaveLength(1);
    const socket = h.sockets[0]!;
    socket.emitOpen();
    socket.emit({
      jsonrpc: '2.0',
      id: 'local-files-acp-initialize',
      result: {},
    });
    await h.flush();
    socket.emit({
      type: 'mcp_registered',
      server: 'local-files',
      toolCount: 4,
    });
    await h.flush();
    expect(h.get().status.phase).toBe('connected');

    // A peer tab saves a different directory with the same basename into the
    // single origin-global slot; a capabilities blip re-runs restore().
    const foreign = fakeHandle('project', { query: 'granted' });
    await store.save(foreign);
    h.rerender({
      ...common,
      sessionId: 'session-1',
      withheldBlocker: 'workspace-resolving',
    });
    await h.flush();
    h.rerender({
      ...common,
      sessionId: 'session-1',
      withheldBlocker: undefined,
    });
    await h.flush();
    await h.flush();
    // The live bridge keeps serving its own directory and the foreign record
    // must not become this mount's grant.
    expect(h.sockets).toHaveLength(1);
    expect(socket.closeCount).toBe(0);

    // Disconnect must not delete the peer's record.
    await act(async () => {
      await h.get().disconnect();
    });
    expect(store.clears).toBe(0);
    expect(await store.load()).toBe(foreign);
    h.unmount();
  });

  it('keeps the live bridge when a differently-named foreign record lands mid-session', async () => {
    const mine = fakeHandle('project', { query: 'granted' });
    const store = fakeStore(mine);
    const common = {
      baseUrl: 'https://daemon.example/',
      win: secureWindow(async () => mine),
      store,
    };
    const h = render({ ...common, sessionId: 'session-1' });
    await h.flush();
    await h.flush();
    const socket = h.sockets[0]!;
    socket.emitOpen();
    socket.emit({
      jsonrpc: '2.0',
      id: 'local-files-acp-initialize',
      result: {},
    });
    await h.flush();
    socket.emit({
      type: 'mcp_registered',
      server: 'local-files',
      toolCount: 4,
    });
    await h.flush();
    expect(h.get().status.phase).toBe('connected');

    // A peer tab overwrites the single record slot with a different
    // directory; a capabilities blip then re-runs restore() over it. The
    // transient verdict must not rebuild the live bridge onto the peer's
    // handle: same session and selector, but a directory this mount never
    // granted and is not serving.
    const foreign = fakeHandle('peer-dir', { query: 'granted' });
    await store.save(foreign);
    h.rerender({
      ...common,
      sessionId: 'session-1',
      withheldBlocker: 'workspace-resolving',
    });
    await h.flush();
    h.rerender({
      ...common,
      sessionId: 'session-1',
      withheldBlocker: undefined,
    });
    await h.flush();
    await h.flush();
    expect(h.sockets).toHaveLength(1);
    expect(socket.closeCount).toBe(0);

    // Disconnect must not delete the peer's record either.
    await act(async () => {
      await h.get().disconnect();
    });
    expect(store.clears).toBe(0);
    expect(await store.load()).toBe(foreign);
    h.unmount();
  });

  it('re-arms naming when a reconnect overwrites a foreign record', async () => {
    const mine = fakeHandle('project', { query: 'granted' });
    const store = fakeStore(mine);
    const common = {
      baseUrl: 'https://daemon.example/',
      win: secureWindow(async () => mine),
      store,
    };
    const h = render({ ...common, sessionId: 'session-1' });
    await h.flush();
    await h.flush();
    const socket = h.sockets[0]!;
    socket.emitOpen();
    socket.emit({
      jsonrpc: '2.0',
      id: 'local-files-acp-initialize',
      result: {},
    });
    await h.flush();
    socket.emit({
      type: 'mcp_registered',
      server: 'local-files',
      toolCount: 4,
    });
    await h.flush();
    expect(h.get().status.phase).toBe('connected');

    // A peer's record latches foreign while the bridge is live; a Reconnect
    // then writes this mount's own handle back over the record slot.
    const foreign = fakeHandle('peer-dir', { query: 'granted' });
    await store.save(foreign);
    h.rerender({
      ...common,
      sessionId: 'session-1',
      withheldBlocker: 'workspace-resolving',
    });
    await h.flush();
    h.rerender({
      ...common,
      sessionId: 'session-1',
      withheldBlocker: undefined,
    });
    await h.flush();
    await h.flush();
    await act(async () => {
      await h.get().connect();
    });
    await h.flush();
    expect(await store.load()).toBe(mine);

    // The record is this mount's grant again: Disconnect must clear it.
    await act(async () => {
      await h.get().disconnect();
    });
    expect(store.clears).toBe(1);
    expect(await store.load()).toBeUndefined();
    h.unmount();
  });

  it('keeps a foreign record guarded when a re-save soft-fails', async () => {
    const mine = fakeHandle('project', { query: 'granted' });
    const store = fakeStore(mine);
    const common = {
      baseUrl: 'https://daemon.example/',
      win: secureWindow(async () => mine),
      store,
    };
    const h = render({ ...common, sessionId: 'session-1' });
    await h.flush();
    await h.flush();
    const socket = h.sockets[0]!;
    socket.emitOpen();
    socket.emit({
      jsonrpc: '2.0',
      id: 'local-files-acp-initialize',
      result: {},
    });
    await h.flush();
    socket.emit({
      type: 'mcp_registered',
      server: 'local-files',
      toolCount: 4,
    });
    await h.flush();
    expect(h.get().status.phase).toBe('connected');

    // A peer's same-named record latches foreign while the bridge is live;
    // from here on every save soft-fails, so a Reconnect cannot write this
    // mount's handle back over the record.
    const foreign = fakeHandle('project', { query: 'granted' });
    await store.save(foreign);
    h.rerender({
      ...common,
      sessionId: 'session-1',
      withheldBlocker: 'workspace-resolving',
    });
    await h.flush();
    h.rerender({
      ...common,
      sessionId: 'session-1',
      withheldBlocker: undefined,
    });
    await h.flush();
    await h.flush();
    store.save = async () => false;
    await act(async () => {
      await h.get().connect();
    });
    await h.flush();
    expect(await store.load()).toBe(foreign);

    // The re-save wrote nothing: the record is still the peer's, and the
    // soft failure must not disarm the guard that protects it.
    await act(async () => {
      await h.get().disconnect();
    });
    expect(store.clears).toBe(0);
    expect(await store.load()).toBe(foreign);
    h.unmount();
  });

  it('refuses to clear a same-named peer record in steady state', async () => {
    const mine = fakeHandle('project', { query: 'granted' });
    const store = fakeStore(mine);
    const common = {
      baseUrl: 'https://daemon.example/',
      win: secureWindow(async () => mine),
      store,
    };
    const h = render({ ...common, sessionId: 'session-1' });
    await h.flush();
    await h.flush();
    const socket = h.sockets[0]!;
    socket.emitOpen();
    socket.emit({
      jsonrpc: '2.0',
      id: 'local-files-acp-initialize',
      result: {},
    });
    await h.flush();
    socket.emit({
      type: 'mcp_registered',
      server: 'local-files',
      toolCount: 4,
    });
    await h.flush();
    expect(h.get().status.phase).toBe('connected');

    // No blip, no session switch: nothing re-runs restore() or the rebind
    // effect, so no latch arms. The revoke must still refuse on entry
    // identity alone — basename equality certified the peer's record as
    // this mount's own before.
    const foreign = fakeHandle('project', { query: 'granted' });
    await store.save(foreign);
    await act(async () => {
      await h.get().disconnect();
    });
    expect(store.clears).toBe(0);
    expect(await store.load()).toBe(foreign);
    h.unmount();
  });

  it('refuses to clear a same-named peer record over a connect-bound grant', async () => {
    const mine = fakeHandle('project', { query: 'granted' });
    const store = fakeStore();
    const h = render({
      sessionId: 'session-1',
      baseUrl: 'https://daemon.example/',
      win: secureWindow(async () => mine),
      store,
    });
    await h.flush();
    await act(async () => {
      await h.get().connect();
    });
    await h.flush();
    expect(h.sockets).toHaveLength(1);
    const socket = h.sockets[0]!;
    socket.emitOpen();
    socket.emit({
      jsonrpc: '2.0',
      id: 'local-files-acp-initialize',
      result: {},
    });
    await h.flush();
    socket.emit({
      type: 'mcp_registered',
      server: 'local-files',
      toolCount: 4,
    });
    await h.flush();
    expect(h.get().status.phase).toBe('connected');

    // The connect stamped its saved handle; a peer's same-basename
    // overwrite must fail the identity check against that stamp, or the
    // ownWrite exclusion certifies the peer's record as this mount's write.
    const foreign = fakeHandle('project', { query: 'granted' });
    await store.save(foreign);
    await act(async () => {
      await h.get().disconnect();
    });
    expect(store.clears).toBe(0);
    expect(await store.load()).toBe(foreign);
    h.unmount();
  });

  it('refuses to clear a swapped same-named record the panel only named', async () => {
    // The panel names the stored grant but never binds it (a prompt-state
    // permission needs a real click), so no handle object is retained in
    // handleRef and no bridge exists.
    const original = fakeHandle('project', { query: 'prompt' });
    const store = fakeStore(original);
    const h = render({
      sessionId: 'session-1',
      baseUrl: 'https://daemon.example/',
      win: secureWindow(async () => original),
      store,
    });
    await h.flush();
    await h.flush();
    expect(h.get().status).toEqual({
      phase: 'needs-gesture',
      blocker: null,
      rootName: 'project',
    });

    // A peer swaps the origin-global slot for a different directory with the
    // same basename. The name the panel shows was read back out of that very
    // record, so a name comparison could never catch the swap; the revoke
    // must decide against the handle the naming write loaded.
    const swapped = fakeHandle('project', { query: 'prompt' });
    await store.save(swapped);
    await act(async () => {
      await h.get().disconnect();
    });
    expect(store.clears).toBe(0);
    expect(await store.load()).toBe(swapped);
    h.unmount();
  });

  it('refuses to clear a record it never bound nor named', async () => {
    // No record at mount: the panel shows bare idle and never names
    // anything, so no ownership evidence exists at all.
    const store = fakeStore();
    const h = render({
      sessionId: 'session-1',
      baseUrl: 'https://daemon.example/',
      win: secureWindow(async () => fakeHandle('unused')),
      store,
    });
    await h.flush();
    await h.flush();
    expect(h.get().status).toEqual({ phase: 'idle', blocker: null });

    // A peer's grant lands with no naming write in this mount: clearing it
    // would be the bystander wipe, so the revoke must fail closed.
    const peer = fakeHandle('peer', { query: 'granted' });
    await store.save(peer);
    await act(async () => {
      await h.get().disconnect();
    });
    expect(store.clears).toBe(0);
    expect(await store.load()).toBe(peer);
    h.unmount();
  });

  it('clears a newly named record after an earlier grant was released', async () => {
    const alpha = fakeHandle('alpha', { query: 'granted' });
    const store = fakeStore();
    const h = render({
      sessionId: 'session-1',
      baseUrl: 'https://daemon.example/',
      win: secureWindow(async () => alpha),
      store,
    });
    await h.flush();
    await act(async () => {
      await h.get().connect();
    });
    await h.flush();
    const socket = h.sockets[0]!;
    socket.emitOpen();
    socket.emit({
      jsonrpc: '2.0',
      id: 'local-files-acp-initialize',
      result: {},
    });
    await h.flush();
    socket.emit({
      type: 'mcp_registered',
      server: 'local-files',
      toolCount: 4,
    });
    await h.flush();
    expect(h.get().status.phase).toBe('connected');

    // The first release clears the record and detaches this mount.
    await act(async () => {
      await h.get().disconnect();
    });
    expect(store.clears).toBe(1);

    // A peer grants a different directory, and this mount's reconnect names
    // it without binding (the permission re-ask is dismissed). The released
    // grant's stale bridge stamp must not decide the next revoke: the record
    // the panel names is the one the user is asking to release.
    const beta = fakeHandle('beta', { query: 'prompt', request: 'prompt' });
    await store.save(beta);
    await act(async () => {
      await h.get().connect();
    });
    expect(h.get().status).toEqual({
      phase: 'needs-gesture',
      blocker: null,
      rootName: 'beta',
    });
    await act(async () => {
      await h.get().disconnect();
    });
    expect(store.clears).toBe(2);
    expect(await store.load()).toBeUndefined();
    h.unmount();
  });

  it('clears its own record once the peer puts the same entry back', async () => {
    const mine = fakeHandle('project', { query: 'granted' });
    const store = fakeStore(mine);
    const common = {
      baseUrl: 'https://daemon.example/',
      win: secureWindow(async () => mine),
      store,
    };
    const h = render({ ...common, sessionId: 'session-1' });
    await h.flush();
    await h.flush();
    const socket = h.sockets[0]!;
    socket.emitOpen();
    socket.emit({
      jsonrpc: '2.0',
      id: 'local-files-acp-initialize',
      result: {},
    });
    await h.flush();
    socket.emit({
      type: 'mcp_registered',
      server: 'local-files',
      toolCount: 4,
    });
    await h.flush();
    expect(h.get().status.phase).toBe('connected');

    // A peer's different directory arms the latch across a session switch...
    const foreign = fakeHandle('project', { query: 'granted' });
    await store.save(foreign);
    h.rerender({ ...common, sessionId: 'session-2' });
    await h.flush();
    await h.flush();
    expect(h.sockets).toHaveLength(2);

    // ...and the peer re-grants this mount's very directory: the record is
    // the bound entry again, so the identity-proven re-bind must clear the
    // latch or the grant outlives every Disconnect and the panel loses the
    // only button that could ever clear it.
    await store.save(mine);
    h.rerender({
      ...common,
      sessionId: 'session-2',
      withheldBlocker: 'workspace-resolving',
    });
    await h.flush();
    h.rerender({
      ...common,
      sessionId: 'session-2',
      withheldBlocker: undefined,
    });
    await h.flush();
    await h.flush();
    expect(h.get().status.rootName).toBe('project');
    await act(async () => {
      await h.get().disconnect();
    });
    expect(store.clears).toBe(1);
    expect(await store.load()).toBeUndefined();
    h.unmount();
  });

  it('keeps the latch over a peer record a soft-failed rebuild did not write', async () => {
    const mine = fakeHandle('project', { query: 'granted' });
    const store = fakeStore(mine);
    const common = {
      baseUrl: 'https://daemon.example/',
      win: secureWindow(async () => mine),
      store,
    };
    const h = render({ ...common, sessionId: 'session-1' });
    await h.flush();
    await h.flush();
    const socket = h.sockets[0]!;
    socket.emitOpen();
    socket.emit({
      jsonrpc: '2.0',
      id: 'local-files-acp-initialize',
      result: {},
    });
    await h.flush();
    socket.emit({
      type: 'mcp_registered',
      server: 'local-files',
      toolCount: 4,
    });
    await h.flush();
    expect(h.get().status.phase).toBe('connected');

    const foreign = fakeHandle('project', { query: 'granted' });
    await store.save(foreign);
    h.rerender({
      ...common,
      sessionId: 'session-1',
      withheldBlocker: 'workspace-resolving',
    });
    await h.flush();
    h.rerender({
      ...common,
      sessionId: 'session-1',
      withheldBlocker: undefined,
    });
    await h.flush();
    await h.flush();

    // The bridge dies, so the reconnect takes the forced-rebuild path with
    // an in-memory handle and a save that writes nothing: the record stays
    // the peer's and the latch must survive the rebuild.
    socket.close();
    await h.flush();
    store.save = async () => false;
    await act(async () => {
      await h.get().connect();
    });
    await h.flush();
    await act(async () => {
      await h.get().disconnect();
    });
    expect(store.clears).toBe(0);
    expect(await store.load()).toBe(foreign);
    // The panel must not name a record this mount never held: the latch
    // blanks the name, so no dead Disconnect renders over the peer's grant.
    expect(h.get().status.rootName).toBeUndefined();
    h.unmount();
  });

  it('drops a restore continuation a disconnect parked inside the identity await', async () => {
    const mine = fakeHandle('project', { query: 'granted' });
    const store = fakeStore(mine);
    const common = {
      baseUrl: 'https://daemon.example/',
      win: secureWindow(async () => mine),
      store,
    };
    const h = render({ ...common, sessionId: 'session-1' });
    await h.flush();
    await h.flush();
    const socket = h.sockets[0]!;
    socket.emitOpen();
    socket.emit({
      jsonrpc: '2.0',
      id: 'local-files-acp-initialize',
      result: {},
    });
    await h.flush();
    socket.emit({
      type: 'mcp_registered',
      server: 'local-files',
      toolCount: 4,
    });
    await h.flush();
    expect(h.get().status.phase).toBe('connected');

    // Park restore() (and the rebind effect) inside the identity await.
    let releaseSame!: (value: boolean) => void;
    const sameGate = new Promise<boolean>((resolve) => {
      releaseSame = resolve;
    });
    mine.isSameEntry = vi.fn(
      () => sameGate,
    ) as unknown as typeof mine.isSameEntry;
    const foreign = fakeHandle('project', { query: 'granted' });
    await store.save(foreign);
    h.rerender({
      ...common,
      sessionId: 'session-1',
      withheldBlocker: 'workspace-resolving',
    });
    await h.flush();
    h.rerender({
      ...common,
      sessionId: 'session-1',
      withheldBlocker: undefined,
    });
    await h.flush();

    // The disconnect lands while both continuations are parked; its revoke
    // refuses on identity, so the record deliberately survives.
    await act(async () => {
      await h.get().disconnect();
    });
    expect(h.sockets[0]!.closeCount).toBe(1);
    await act(async () => {
      releaseSame(true);
      await Promise.resolve();
    });
    await h.flush();

    // The parked restore must not re-bind the grant behind the click, or
    // the next session switch re-registers the directory the user released.
    h.rerender({ ...common, sessionId: 'session-2' });
    await h.flush();
    await h.flush();
    expect(h.sockets).toHaveLength(1);
    h.unmount();
  });

  it('drops a connect continuation a disconnect parked inside the identity await', async () => {
    const mine = fakeHandle('project', { query: 'granted' });
    const store = fakeStore(mine);
    const common = {
      baseUrl: 'https://daemon.example/',
      win: secureWindow(async () => mine),
      store,
    };
    const h = render({ ...common, sessionId: 'session-1' });
    await h.flush();
    await h.flush();
    const socket = h.sockets[0]!;
    socket.emitOpen();
    socket.emit({
      jsonrpc: '2.0',
      id: 'local-files-acp-initialize',
      result: {},
    });
    await h.flush();
    socket.emit({
      type: 'mcp_registered',
      server: 'local-files',
      toolCount: 4,
    });
    await h.flush();
    expect(h.get().status.phase).toBe('connected');

    let releaseSame!: (value: boolean) => void;
    const sameGate = new Promise<boolean>((resolve) => {
      releaseSame = resolve;
    });
    mine.isSameEntry = vi.fn(
      () => sameGate,
    ) as unknown as typeof mine.isSameEntry;

    // The reconnect parks in the identity await after committing its
    // re-save; the disconnect lands in that window. Resolving the identity
    // check as "different entry" sends the un-guarded continuation down the
    // forced-rebuild path, which must not start a bridge behind the click.
    const pendingConnect = act(async () => {
      await h.get().connect();
    });
    await h.flush();
    // The revoke parks on the same gated identity check, so the disconnect
    // act stays open until the gate resolves.
    const pendingDisconnect = act(async () => {
      await h.get().disconnect();
    });
    await h.flush();
    expect(h.sockets[0]!.closeCount).toBe(1);
    await act(async () => {
      releaseSame(false);
      await Promise.resolve();
    });
    await pendingDisconnect;
    await pendingConnect;
    await h.flush();

    // No bridge may start behind the disconnect.
    expect(h.sockets).toHaveLength(1);
    expect(h.get().status.phase).toBe('idle');
    h.unmount();
  });

  it('drops a restore continuation whose identity check answers false late', async () => {
    const mine = fakeHandle('project', { query: 'granted' });
    const store = fakeStore(mine);
    const common = {
      baseUrl: 'https://daemon.example/',
      win: secureWindow(async () => mine),
      store,
    };
    const h = render({ ...common, sessionId: 'session-1' });
    await h.flush();
    await h.flush();
    const socket = h.sockets[0]!;
    socket.emitOpen();
    socket.emit({
      jsonrpc: '2.0',
      id: 'local-files-acp-initialize',
      result: {},
    });
    await h.flush();
    socket.emit({
      type: 'mcp_registered',
      server: 'local-files',
      toolCount: 4,
    });
    await h.flush();
    expect(h.get().status.phase).toBe('connected');

    // The false answer lands after a disconnect: the fall-through exit must
    // not rebuild the bridge over the peer's record behind the click.
    let releaseSame!: (value: boolean) => void;
    const sameGate = new Promise<boolean>((resolve) => {
      releaseSame = resolve;
    });
    mine.isSameEntry = vi.fn(
      () => sameGate,
    ) as unknown as typeof mine.isSameEntry;
    const foreign = fakeHandle('project', { query: 'granted' });
    await store.save(foreign);
    h.rerender({
      ...common,
      sessionId: 'session-1',
      withheldBlocker: 'workspace-resolving',
    });
    await h.flush();
    h.rerender({
      ...common,
      sessionId: 'session-1',
      withheldBlocker: undefined,
    });
    await h.flush();
    await act(async () => {
      await h.get().disconnect();
    });
    expect(h.sockets[0]!.closeCount).toBe(1);
    await act(async () => {
      releaseSame(false);
      await Promise.resolve();
    });
    await h.flush();
    expect(h.sockets).toHaveLength(1);
    expect(h.get().status.phase).toBe('idle');
    h.unmount();
  });

  it('clears its own record when the permission lapses over a stale latch', async () => {
    const perms = { query: 'granted' as PermissionState };
    const mine = fakeHandle('project', perms);
    const store = fakeStore(mine);
    const common = {
      baseUrl: 'https://daemon.example/',
      win: secureWindow(async () => mine),
      store,
    };
    const h = render({ ...common, sessionId: 'session-1' });
    await h.flush();
    await h.flush();
    const socket = h.sockets[0]!;
    socket.emitOpen();
    socket.emit({
      jsonrpc: '2.0',
      id: 'local-files-acp-initialize',
      result: {},
    });
    await h.flush();
    socket.emit({
      type: 'mcp_registered',
      server: 'local-files',
      toolCount: 4,
    });
    await h.flush();
    expect(h.get().status.phase).toBe('connected');

    // A peer record latches foreign; the peer then puts this mount's own
    // entry back, and the browser permission lapses before the next blip —
    // the rebind's identity proof must clear the latch on the needs-gesture
    // exit, or the user's own grant can never be released.
    const foreign = fakeHandle('peer-dir', { query: 'granted' });
    await store.save(foreign);
    h.rerender({
      ...common,
      sessionId: 'session-1',
      withheldBlocker: 'workspace-resolving',
    });
    await h.flush();
    h.rerender({
      ...common,
      sessionId: 'session-1',
      withheldBlocker: undefined,
    });
    await h.flush();
    await h.flush();
    await store.save(mine);
    perms.query = 'prompt';
    h.rerender({
      ...common,
      sessionId: 'session-1',
      withheldBlocker: 'workspace-resolving',
    });
    await h.flush();
    h.rerender({
      ...common,
      sessionId: 'session-1',
      withheldBlocker: undefined,
    });
    await h.flush();
    await h.flush();
    expect(h.get().status).toMatchObject({
      phase: 'needs-gesture',
      rootName: 'project',
    });

    await act(async () => {
      await h.get().disconnect();
    });
    expect(store.clears).toBe(1);
    expect(await store.load()).toBeUndefined();
    h.unmount();
  });

  it('drops a restore continuation a concurrent reconnect superseded', async () => {
    const perms = { query: 'granted' as PermissionState };
    const mine = fakeHandle('project', perms);
    const store = fakeStore(mine);
    const common = {
      baseUrl: 'https://daemon.example/',
      win: secureWindow(async () => mine),
      store,
    };
    const h = render({ ...common, sessionId: 'session-1' });
    await h.flush();
    await h.flush();
    const socket = h.sockets[0]!;
    socket.emitOpen();
    socket.emit({
      jsonrpc: '2.0',
      id: 'local-files-acp-initialize',
      result: {},
    });
    await h.flush();
    socket.emit({
      type: 'mcp_registered',
      server: 'local-files',
      toolCount: 4,
    });
    await h.flush();
    expect(h.get().status.phase).toBe('connected');

    // restore() parks on the identity await over a peer's same-basename
    // record (call 2: the rebind effect's shorter chain consumes call 1);
    // inside the window a reconnect picks a new directory, saves it and
    // rebuilds, superseding the parked load.
    let calls = 0;
    let releaseSame!: (value: boolean) => void;
    const sameGate = new Promise<boolean>((resolve) => {
      releaseSame = resolve;
    });
    mine.isSameEntry = vi.fn((other: unknown) => {
      calls += 1;
      if (calls === 2) return sameGate;
      return Promise.resolve(other === mine);
    }) as unknown as typeof mine.isSameEntry;
    const foreign = fakeHandle('project', { query: 'granted' });
    await store.save(foreign);
    h.rerender({
      ...common,
      sessionId: 'session-1',
      withheldBlocker: 'workspace-resolving',
    });
    await h.flush();
    h.rerender({
      ...common,
      sessionId: 'session-1',
      withheldBlocker: undefined,
    });
    await h.flush();
    perms.query = 'denied';
    const picked = fakeHandle('gamma', { query: 'granted' });
    h.rerender({
      ...common,
      sessionId: 'session-1',
      win: secureWindow(async () => picked),
    });
    await act(async () => {
      await h.get().connect();
    });
    await h.flush();
    expect(h.sockets).toHaveLength(2);
    await act(async () => {
      releaseSame(false);
      await Promise.resolve();
    });
    await h.flush();

    // The superseded continuation must neither latch nor bind: the record is
    // this mount's own committed save, so Disconnect clears it.
    expect(h.get().status.rootName).toBe('gamma');
    await act(async () => {
      await h.get().disconnect();
    });
    expect(store.clears).toBe(1);
    expect(await store.load()).toBeUndefined();
    h.unmount();
  });

  it('drops a restore continuation a concurrent same-entry reconnect superseded', async () => {
    const mine = fakeHandle('project', { query: 'granted' });
    const store = fakeStore(mine);
    const common = {
      baseUrl: 'https://daemon.example/',
      win: secureWindow(async () => mine),
      store,
    };
    const h = render({ ...common, sessionId: 'session-1' });
    await h.flush();
    await h.flush();
    const socket = h.sockets[0]!;
    socket.emitOpen();
    socket.emit({
      jsonrpc: '2.0',
      id: 'local-files-acp-initialize',
      result: {},
    });
    await h.flush();
    socket.emit({
      type: 'mcp_registered',
      server: 'local-files',
      toolCount: 4,
    });
    await h.flush();
    expect(h.get().status.phase).toBe('connected');

    // Same shape, but the reconnect takes the same-entry early return: no
    // bridge build, only the committed save supersedes the parked load.
    // Call 2 is restore()'s identity await; call 1 belongs to the rebind
    // effect's shorter chain.
    let calls = 0;
    let releaseSame!: (value: boolean) => void;
    const sameGate = new Promise<boolean>((resolve) => {
      releaseSame = resolve;
    });
    mine.isSameEntry = vi.fn((other: unknown) => {
      calls += 1;
      if (calls === 2) return sameGate;
      return Promise.resolve(other === mine);
    }) as unknown as typeof mine.isSameEntry;
    const foreign = fakeHandle('project', { query: 'granted' });
    await store.save(foreign);
    h.rerender({
      ...common,
      sessionId: 'session-1',
      withheldBlocker: 'workspace-resolving',
    });
    await h.flush();
    h.rerender({
      ...common,
      sessionId: 'session-1',
      withheldBlocker: undefined,
    });
    await h.flush();
    await act(async () => {
      await h.get().connect();
    });
    await h.flush();
    expect(h.sockets).toHaveLength(1);
    await act(async () => {
      releaseSame(false);
      await Promise.resolve();
    });
    await h.flush();

    expect(h.get().status.rootName).toBe('project');
    await act(async () => {
      await h.get().disconnect();
    });
    expect(store.clears).toBe(1);
    expect(await store.load()).toBeUndefined();
    h.unmount();
  });

  it('drops a rebind continuation a concurrent same-entry reconnect superseded', async () => {
    const mine = fakeHandle('project', { query: 'granted' });
    const store = fakeStore(mine);
    const common = {
      baseUrl: 'https://daemon.example/',
      win: secureWindow(async () => mine),
      store,
    };
    const h = render({ ...common, sessionId: 'session-1' });
    await h.flush();
    await h.flush();
    const socket = h.sockets[0]!;
    socket.emitOpen();
    socket.emit({
      jsonrpc: '2.0',
      id: 'local-files-acp-initialize',
      result: {},
    });
    await h.flush();
    socket.emit({
      type: 'mcp_registered',
      server: 'local-files',
      toolCount: 4,
    });
    await h.flush();
    expect(h.get().status.phase).toBe('connected');

    // Twin of the restore-side supersede case, but the gate parks the
    // REBIND effect's identity check (call 1; restore's longer chain is
    // call 2). The reconnect takes the same-entry early return — a committed
    // save but no bridge build — so only the save epoch can invalidate the
    // parked continuation before it re-latches the record foreign.
    let calls = 0;
    let releaseSame!: (value: boolean) => void;
    const sameGate = new Promise<boolean>((resolve) => {
      releaseSame = resolve;
    });
    mine.isSameEntry = vi.fn((other: unknown) => {
      calls += 1;
      if (calls === 1) return sameGate;
      return Promise.resolve(other === mine);
    }) as unknown as typeof mine.isSameEntry;
    const foreign = fakeHandle('project', { query: 'granted' });
    await store.save(foreign);
    h.rerender({
      ...common,
      sessionId: 'session-1',
      withheldBlocker: 'workspace-resolving',
    });
    await h.flush();
    h.rerender({
      ...common,
      sessionId: 'session-1',
      withheldBlocker: undefined,
    });
    await h.flush();
    await act(async () => {
      await h.get().connect();
    });
    await h.flush();
    expect(h.sockets).toHaveLength(1);
    await act(async () => {
      releaseSame(false);
      await Promise.resolve();
    });
    await h.flush();

    expect(h.get().status.rootName).toBe('project');
    await act(async () => {
      await h.get().disconnect();
    });
    expect(store.clears).toBe(1);
    expect(await store.load()).toBeUndefined();
    h.unmount();
  });

  it('reconciles the panel when a deferred revoke is declined with its connect still in flight', async () => {
    const mine = fakeHandle('ai_coding', { query: 'denied' });
    const store = fakeStore(mine);
    // Attempt 0 declines on the settling release so the user can click
    // Connect inside the window; the granted attempt 1 then defers the
    // revoke onto that connect. Once the deferred closure re-asks, the peer
    // holds the lock and every attempt declines.
    const lock = { held: false, settling: 1 };
    const locks: LockManagerLike = settlingLocks(lock);
    let delayStep = 0;
    let releaseDelayA!: () => void;
    const delayGateA = new Promise<void>((resolve) => {
      releaseDelayA = resolve;
    });
    let releaseDelayB!: () => void;
    const delayGateB = new Promise<void>((resolve) => {
      releaseDelayB = resolve;
    });
    // Step 0 is the first disconnect's backoff (the window for C2); steps 1+
    // are the deferred closure's retries, parked until C3 is in flight.
    const delay = async () => {
      const step = delayStep++;
      if (step === 0) {
        await delayGateA;
        return;
      }
      await delayGateB;
    };
    let dismissC2!: (err: Error) => void;
    const pickerC2 = new Promise<FileSystemDirectoryHandle>((_r, reject) => {
      dismissC2 = reject;
    });
    let dismissC3!: (err: Error) => void;
    const pickerC3 = new Promise<FileSystemDirectoryHandle>((_r, reject) => {
      dismissC3 = reject;
    });
    let pickCalls = 0;
    const h = render({
      sessionId: 'session-1',
      baseUrl: 'https://daemon.example/',
      win: secureWindow(async () => {
        pickCalls += 1;
        if (pickCalls === 1) return pickerC2;
        return pickerC3;
      }),
      store,
      locks,
      delay,
    });
    await h.flush();
    await h.flush();
    expect(h.get().status).toMatchObject({
      phase: 'needs-gesture',
      rootName: 'ai_coding',
    });

    // D1 declines once, then defers its revoke onto C2, which clicked inside
    // the backoff window.
    const disconnectPromise = h.get().disconnect();
    await h.flush();
    const connectingC2 = act(async () => {
      await h.get().connect();
    });
    await h.flush();
    releaseDelayA();
    await act(async () => {
      await disconnectPromise;
    });
    expect(h.get().status.rootName).toBeUndefined();
    // The peer tab takes the owner lock while C2's picker stays open.
    lock.held = true;

    // C2 is dismissed without saving; its finally runs the deferred closure,
    // whose re-arbitration parks on the peer-held lock. C2's finally resets
    // the in-flight flag before awaiting the closure, so a third click now
    // really starts a connect — and it is still in flight when the closure's
    // guard runs, which is the fact the guard must not trust.
    await act(async () => {
      dismissC2(Object.assign(new Error('dismissed'), { name: 'AbortError' }));
    });
    await h.flush();
    const connectingC3 = h.get().connect();
    await h.flush();

    // Release the closure's retry: every attempt declines (peer holds the
    // lock), so no successor is parked and the closure must reconcile the
    // panel itself.
    await act(async () => {
      releaseDelayB();
      await Promise.resolve();
    });
    await connectingC2;
    await h.flush();

    // The declined re-arbitration parked no successor, so the closure must
    // reconcile the panel itself: the named grant keeps Disconnect reachable.
    expect(h.get().status.rootName).toBe('ai_coding');
    expect(store.clears).toBe(0);

    await act(async () => {
      dismissC3(Object.assign(new Error('dismissed'), { name: 'AbortError' }));
    });
    await connectingC3;
    await h.flush();
    h.unmount();
  });

  it('keeps a connect that binds a new grant while a rebind is parked', async () => {
    const alpha = fakeHandle('alpha', { query: 'granted' });
    const perms = { query: 'granted' as PermissionState };
    alpha.queryPermission = vi.fn(async () => perms.query);
    const store = fakeStore(alpha);
    const gamma = fakeHandle('gamma', { query: 'granted' });
    const h = render({
      sessionId: 'session-1',
      baseUrl: 'https://daemon.example/',
      win: secureWindow(async () => gamma),
      store,
    });
    await h.flush();
    await h.flush();
    const socket = h.sockets[0]!;
    socket.emitOpen();
    socket.emit({
      jsonrpc: '2.0',
      id: 'local-files-acp-initialize',
      result: {},
    });
    await h.flush();
    socket.emit({
      type: 'mcp_registered',
      server: 'local-files',
      toolCount: 4,
    });
    await h.flush();
    expect(h.get().status.phase).toBe('connected');

    // Park the session-switch rebind on its first store read.
    const realLoad = store.load.bind(store);
    let releaseLoad!: () => void;
    const loadGate = new Promise<void>((resolve) => {
      releaseLoad = resolve;
    });
    let gated = false;
    store.load = () => {
      if (!gated) {
        gated = true;
        return loadGate.then(() => realLoad());
      }
      return realLoad();
    };
    perms.query = 'denied';
    h.rerender({ sessionId: 'session-2' });
    await h.flush();

    // Inside that window the user reconnects and picks a new directory.
    await act(async () => {
      await h.get().connect();
    });
    await h.flush();
    expect(h.sockets).toHaveLength(2);
    expect(h.get().status.rootName).toBe('gamma');

    // The parked continuation must not roll the new grant back, or its
    // latch refuses every later revoke of the record it never named.
    await act(async () => {
      releaseLoad();
      await Promise.resolve();
    });
    await h.flush();
    await h.flush();
    expect(h.sockets).toHaveLength(2);
    expect(h.get().status.rootName).toBe('gamma');
    await act(async () => {
      await h.get().disconnect();
    });
    expect(store.clears).toBe(1);
    expect(await store.load()).toBeUndefined();
    h.unmount();
  });

  it('invalidates a parked rebind when restore binds the record without a session', async () => {
    const mine = fakeHandle('mine', { query: 'granted' });
    const store = fakeStore(mine);
    const h = render({
      sessionId: undefined,
      baseUrl: 'https://daemon.example/',
      win: secureWindow(async () => mine),
      store,
    });
    await h.flush();
    await h.flush();
    // The record bound, but with no session nothing built a bridge.
    expect(h.get().status).toEqual({
      phase: 'needs-session',
      blocker: null,
      rootName: 'mine',
    });
    expect(h.sockets).toHaveLength(0);

    // A peer's different-entry record lands; park the rebind effect on the
    // permission re-check of the in-memory handle.
    const peer = fakeHandle('peer', { query: 'granted' });
    await store.save(peer);
    let releaseQuery!: (state: PermissionState) => void;
    const queryGate = new Promise<PermissionState>((resolve) => {
      releaseQuery = resolve;
    });
    mine.queryPermission = vi.fn(() => queryGate);
    h.rerender({ withheldBlocker: 'workspace-resolving' });
    await h.flush();
    h.rerender({ withheldBlocker: undefined });
    await h.flush();
    await h.flush();

    // restore() re-binds the record's own handle; with no session the bind
    // stops at needs-session and never reaches a bridge build, but it must
    // still invalidate the parked continuation.
    expect(h.get().status).toEqual({
      phase: 'needs-session',
      blocker: null,
      rootName: 'peer',
    });

    // Resuming the parked rebind must not roll the bind — and the panel —
    // back to the replaced in-memory handle.
    await act(async () => {
      releaseQuery('granted');
      await Promise.resolve();
    });
    await h.flush();
    await h.flush();
    expect(h.get().status).toEqual({
      phase: 'needs-session',
      blocker: null,
      rootName: 'peer',
    });
    await act(async () => {
      await h.get().disconnect();
    });
    expect(store.clears).toBe(1);
    expect(await store.load()).toBeUndefined();
    h.unmount();
  });

  it('keeps the bound name when a hard verdict lands over a peer record', async () => {
    const mine = fakeHandle('ai_coding', { query: 'granted' });
    const store = fakeStore(mine);
    const common = {
      baseUrl: 'https://daemon.example/',
      win: secureWindow(async () => mine),
      store,
    };
    const h = render({ ...common, sessionId: 'session-1' });
    await h.flush();
    await h.flush();
    expect(h.get().status.rootName).toBe('ai_coding');

    // A peer overwrites the single record slot; a hard verdict then withholds
    // the entry. The panel keeps the name this mount actually bound — the
    // record's name is a directory this tab never picked nor served.
    const foreign = fakeHandle('peer_dir', { query: 'granted' });
    await store.save(foreign);
    h.rerender({
      ...common,
      sessionId: 'session-1',
      withheldBlocker: 'workspace-ineligible',
    });
    await h.flush();
    await h.flush();
    expect(h.get().status).toEqual({
      phase: 'unavailable',
      blocker: 'workspace-ineligible',
      rootName: 'ai_coding',
    });
    h.unmount();
  });

  it('latches a same-named foreign record across a session switch', async () => {
    const mine = fakeHandle('project', { query: 'granted' });
    const store = fakeStore(mine);
    const common = {
      baseUrl: 'https://daemon.example/',
      win: secureWindow(async () => mine),
      store,
    };
    const h = render({ ...common, sessionId: 'session-1' });
    await h.flush();
    await h.flush();
    const socket = h.sockets[0]!;
    socket.emitOpen();
    socket.emit({
      jsonrpc: '2.0',
      id: 'local-files-acp-initialize',
      result: {},
    });
    await h.flush();
    socket.emit({
      type: 'mcp_registered',
      server: 'local-files',
      toolCount: 4,
    });
    await h.flush();
    expect(h.get().status.phase).toBe('connected');

    // A peer overwrites the single record slot with its own directory of the
    // same basename: only entry identity can tell them apart, and a session
    // switch re-runs the rebind effect without re-running restore(), so the
    // latch has to be set there.
    const foreign = fakeHandle('project', { query: 'granted' });
    await store.save(foreign);
    h.rerender({ ...common, sessionId: 'session-2' });
    await h.flush();
    await h.flush();
    expect(h.sockets).toHaveLength(2);

    await act(async () => {
      await h.get().disconnect();
    });
    expect(store.clears).toBe(0);
    expect(await store.load()).toBe(foreign);
    h.unmount();
  });

  it('clears a record the picker arm committed while disconnect landed', async () => {
    const docs = fakeHandle('docs', { query: 'denied' });
    const photos = fakeHandle('photos', { query: 'granted' });
    const store = fakeStore(docs);
    // Real IndexedDB serializes transactions: a load() that begins while a
    // save is in flight resolves only after that save commits. The fake must
    // too, or the revoke would read the pre-pick record and the window this
    // pins never opens. The commit itself lands when the save is called;
    // only its acknowledgement waits for the gate, so a disconnect can land
    // after the commit and before the connect stamps anything.
    let commitSave!: () => void;
    let inFlight: Promise<unknown> = Promise.resolve();
    const realSave = store.save.bind(store);
    const realLoad = store.load.bind(store);
    store.save = (handle) => {
      void realSave(handle);
      const gate = new Promise<void>((resolve) => {
        commitSave = resolve;
      });
      inFlight = inFlight.then(() => gate);
      return inFlight.then(() => true);
    };
    store.load = () => inFlight.then(() => realLoad());
    const h = render({
      sessionId: 'session-1',
      baseUrl: 'https://daemon.example/',
      win: secureWindow(async () => photos),
      store,
    });
    await h.flush();
    await h.flush();
    expect(h.get().status).toMatchObject({
      phase: 'needs-gesture',
      rootName: 'docs',
    });
    // The picker closes and connect() parks inside the in-flight save; the
    // Disconnect click lands in that window, while the mount's named grant
    // is still the pre-pick record and the bind has stamped nothing yet.
    const pendingConnect = act(async () => {
      await h.get().connect();
    });
    for (let i = 0; i < 8 && typeof commitSave !== 'function'; i += 1) {
      await h.flush();
    }
    expect(typeof commitSave).toBe('function');
    const pendingDisconnect = act(async () => {
      await h.get().disconnect();
    });
    await h.flush();
    await act(async () => {
      commitSave();
      await Promise.resolve();
      await Promise.resolve();
    });
    await pendingDisconnect;
    await pendingConnect;
    await h.flush();
    // The record is this mount's own committed pick, not a peer's: the
    // revoke must clear it instead of latching it foreign over the stale
    // pre-click name.
    expect(store.clears).toBe(1);
    expect(await store.load()).toBeUndefined();
    h.unmount();
  });

  it('does not start a bridge from an ungranted handle on session switch', async () => {
    const handle = fakeHandle('ai_coding', {
      query: 'prompt',
      request: 'granted',
    });
    const h = render({
      sessionId: 'session-1',
      baseUrl: 'https://daemon.example/',
      win: secureWindow(async () => handle),
      store: fakeStore(handle),
    });
    await h.flush();
    await h.flush();
    expect(h.get().status.phase).toBe('needs-gesture');

    // Rebinding must not promote a handle the browser has not granted: the
    // registration would succeed and every tool call would then fail.
    h.rerender({ sessionId: 'session-2' });
    await h.flush();
    expect(h.get().status.phase).toBe('needs-gesture');
    expect(h.sockets).toHaveLength(0);

    // The gesture path still binds to the session active at click time.
    await act(async () => {
      await h.get().connect();
    });
    await h.flush();
    expect(h.sockets).toHaveLength(1);
    h.sockets[0]!.emitOpen();
    h.sockets[0]!.emit({
      jsonrpc: '2.0',
      id: 'local-files-acp-initialize',
      result: {},
    });
    await h.flush();
    expect(h.sockets[0]!.framesOfType('mcp_register')).toEqual([
      { type: 'mcp_register', server: 'local-files', sessionId: 'session-2' },
    ]);
    h.unmount();
  });

  it('leaves a denied grant alone and asks for a fresh pick', async () => {
    const stored = fakeHandle('old', { query: 'denied' });
    const fresh = fakeHandle('new', { query: 'granted' });
    const pick = vi.fn(async () => fresh);
    const store = fakeStore(stored);
    const h = render({
      sessionId: 'session-1',
      baseUrl: 'https://daemon.example/',
      win: secureWindow(pick),
      store,
    });
    await h.flush();
    await h.flush();
    expect(h.get().status.phase).toBe('needs-gesture');

    await act(async () => {
      await h.get().connect();
    });
    await h.flush();
    expect(pick).toHaveBeenCalledOnce();
    expect(store.saves).toEqual([fresh]);
    h.unmount();
  });
});

describe('useLocalFilesBridge teardown', () => {
  it('disconnect closes the socket and forgets the stored grant', async () => {
    const handle = fakeHandle('ai_coding', { query: 'granted' });
    const store = fakeStore(handle);
    const h = render({
      sessionId: 'session-1',
      baseUrl: 'https://daemon.example/',
      win: secureWindow(async () => handle),
      store,
    });
    await h.flush();
    await h.flush();
    expect(h.sockets).toHaveLength(1);

    await act(async () => {
      await h.get().disconnect();
    });
    await h.flush();
    expect(h.sockets[0]!.closeCount).toBe(1);
    expect(store.clears).toBe(1);
    expect(h.get().status.phase).toBe('idle');
    h.unmount();
  });

  it('opens one picker when connect is clicked twice', async () => {
    let release!: (handle: FileSystemDirectoryHandle) => void;
    const gate = new Promise<FileSystemDirectoryHandle>((resolve) => {
      release = resolve;
    });
    const pick = vi.fn(async () => gate);
    const h = render({
      sessionId: 'session-1',
      baseUrl: 'https://daemon.example/',
      win: secureWindow(pick),
      store: fakeStore(),
    });
    await h.flush();

    const first = act(async () => {
      await h.get().connect();
    });
    await act(async () => {
      await h.get().connect();
    });
    // A double click must not open two native dialogs and race two bridges.
    expect(pick).toHaveBeenCalledOnce();

    release(fakeHandle('ai_coding', { query: 'granted' }));
    await first;
    await h.flush();
    expect(h.sockets).toHaveLength(1);
    h.unmount();
  });

  it('never starts a bridge for a connect that outlives the view', async () => {
    let release!: (handle: FileSystemDirectoryHandle) => void;
    const gate = new Promise<FileSystemDirectoryHandle>((resolve) => {
      release = resolve;
    });
    const pick = vi.fn(async () => gate);
    const h = render({
      sessionId: 'session-1',
      baseUrl: 'https://daemon.example/',
      win: secureWindow(pick),
      store: fakeStore(),
    });
    await h.flush();

    const pending = act(async () => {
      await h.get().connect();
    });
    // The user navigates away while the native picker is still open.
    h.unmount();
    release(fakeHandle('ai_coding', { query: 'granted' }));
    await pending;

    // Without the generation guard this opened a socket nobody could close,
    // holding the directory grant after the view was gone.
    expect(h.sockets).toHaveLength(0);
  });

  it('drops a connect that races a disconnect', async () => {
    let release!: (handle: FileSystemDirectoryHandle) => void;
    const gate = new Promise<FileSystemDirectoryHandle>((resolve) => {
      release = resolve;
    });
    const pick = vi.fn(async () => gate);
    const h = render({
      sessionId: 'session-1',
      baseUrl: 'https://daemon.example/',
      win: secureWindow(pick),
      store: fakeStore(),
    });
    await h.flush();

    const pending = act(async () => {
      await h.get().connect();
    });
    await act(async () => {
      await h.get().disconnect();
    });
    release(fakeHandle('ai_coding', { query: 'granted' }));
    await pending;
    await h.flush();

    expect(h.sockets).toHaveLength(0);
    expect(h.get().status.phase).toBe('idle');
    h.unmount();
  });

  it('stops the bridge on unmount so no socket outlives the view', async () => {
    const handle = fakeHandle('ai_coding', { query: 'granted' });
    const h = render({
      sessionId: 'session-1',
      baseUrl: 'https://daemon.example/',
      win: secureWindow(async () => handle),
      store: fakeStore(handle),
    });
    await h.flush();
    await h.flush();
    expect(h.sockets).toHaveLength(1);
    h.unmount();
    expect(h.sockets[0]!.closeCount).toBe(1);
  });
});
