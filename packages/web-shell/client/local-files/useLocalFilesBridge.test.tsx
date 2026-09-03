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
import type { WebSocketHandlers, WebSocketLike } from './bridge-client.js';
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
      locks: null,
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
