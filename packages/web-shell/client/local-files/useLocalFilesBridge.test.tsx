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
      h.get().disconnect();
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
    const lock = { held: false };
    const locks: LockManagerLike = {
      request: async (_name, options, callback) => {
        if (lock.held && options.ifAvailable) return undefined;
        lock.held = true;
        try {
          await callback({});
        } finally {
          lock.held = false;
        }
      },
    };
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
      hA.get().disconnect();
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
    expect(h.get().status).toEqual({
      phase: 'unavailable',
      blocker: 'workspace-ineligible',
    });
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
      h.get().disconnect();
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
      h.get().disconnect();
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
