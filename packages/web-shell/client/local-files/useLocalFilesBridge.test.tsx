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
  return {
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
  } as unknown as FileSystemDirectoryHandle;
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
    // it, and the panel must still name it.
    expect(store.clears).toBe(0);
    expect(await store.load()).toBe(handle);
    expect(hB.get().status.rootName).toBe('ai_coding');
    hB.unmount();
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
    rejectPicker(new DOMException('user cancelled', 'AbortError'));
    await connecting;
    await disconnecting;
    await hB.flush();
    expect(store.clears).toBe(1);
    hB.unmount();
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
    hA.unmount();
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

  it('revokes on the owner side even when its release outlasts the budget', async () => {
    const handle = fakeHandle('ai_coding', { query: 'granted' });
    const store = fakeStore(handle);
    // The release never settles inside the attempt budget: only the owned
    // run latch can keep this disconnect from arbitrating against the tab's
    // own still-settling lock.
    const lock = { held: false, settling: 0 };
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
