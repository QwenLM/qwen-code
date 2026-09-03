import { describe, expect, it } from 'vitest';
import {
  LOCAL_FILES_CLIENT_NAME,
  LOCAL_FILES_LOCK_NAME,
  LocalFilesBridge,
  bearerSubprotocols,
  buildAcpWsUrl,
  type LocalFilesBridgeOptions,
  type LocalFilesBridgeState,
  type LocalFilesRpcServer,
  type LockManagerLike,
  type WebSocketHandlers,
  type WebSocketLike,
} from './bridge-client.js';
import type { JsonRpcRequest, JsonRpcResponse } from './mcp-server.js';
import { LocalFilesMcpServer } from './mcp-server.js';

/** A socket that only does what the test tells it to. */
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
    // A real socket answers close() with a close event; the bridge must not
    // treat its own teardown as a dropped connection.
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

  emitRaw(data: string): void {
    this.handlers?.message(data);
  }

  emitClose(code = 1006, reason = ''): void {
    this.handlers?.close(code, reason);
  }
}

class FakeLocks implements LockManagerLike {
  held = false;
  requests = 0;
  constructor(private readonly contended = false) {}
  async request(
    name: string,
    _options: { ifAvailable: boolean },
    callback: (lock: unknown) => Promise<void>,
  ): Promise<unknown> {
    this.requests += 1;
    expect(name).toBe(LOCAL_FILES_LOCK_NAME);
    if (this.contended || this.held) return undefined;
    this.held = true;
    try {
      await callback({});
    } finally {
      this.held = false;
    }
    return undefined;
  }
}

function recordingRpc(reply?: JsonRpcResponse): {
  server: LocalFilesRpcServer;
  calls: JsonRpcRequest[];
} {
  const calls: JsonRpcRequest[] = [];
  return {
    calls,
    server: {
      handle: async (message) => {
        calls.push(message);
        return reply;
      },
    },
  };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

interface Harness {
  bridge: LocalFilesBridge;
  sockets: FakeSocket[];
  states: LocalFilesBridgeState[];
  rewarmCalls: number;
  delays: number[];
  rpc: ReturnType<typeof recordingRpc>;
  locks: FakeLocks;
  running: Promise<void>;
}

function harness(overrides: Partial<LocalFilesBridgeOptions> = {}): Harness {
  const sockets: FakeSocket[] = [];
  const states: LocalFilesBridgeState[] = [];
  const delays: number[] = [];
  let rewarmCalls = 0;
  const rpc = recordingRpc();
  const locks = new FakeLocks();
  const bridge = new LocalFilesBridge({
    baseUrl: 'https://daemon.example/',
    sessionId: 'session-1',
    server: rpc.server,
    openSocket: (url, protocols) => {
      const socket = new FakeSocket(url, protocols);
      sockets.push(socket);
      return socket;
    },
    rewarm: async () => {
      rewarmCalls += 1;
    },
    delay: async (ms) => {
      delays.push(ms);
    },
    locks,
    onState: (state) => states.push(state),
    ...overrides,
  });
  const running = bridge.start();
  return {
    bridge,
    sockets,
    states,
    get rewarmCalls() {
      return rewarmCalls;
    },
    delays,
    rpc,
    locks,
    running,
  } as Harness;
}

/** Drive the handshake through to a connected bridge. */
async function connect(h: Harness, toolCount = 4): Promise<FakeSocket> {
  await flush();
  const socket = h.sockets[h.sockets.length - 1]!;
  socket.emitOpen();
  await flush();
  socket.emit({ jsonrpc: '2.0', id: 'local-files-acp-initialize', result: {} });
  await flush();
  socket.emit({ type: 'mcp_registered', server: 'local-files', toolCount });
  await flush();
  return socket;
}

function lastPhase(h: Harness): LocalFilesBridgeState['phase'] {
  return h.states[h.states.length - 1]!.phase;
}

describe('buildAcpWsUrl', () => {
  it('swaps the scheme and keeps a base path', () => {
    expect(buildAcpWsUrl('https://daemon.example/')).toBe(
      'wss://daemon.example/acp',
    );
    expect(buildAcpWsUrl('http://127.0.0.1:4170')).toBe(
      'ws://127.0.0.1:4170/acp',
    );
    expect(buildAcpWsUrl('https://daemon.example/qwen/')).toBe(
      'wss://daemon.example/qwen/acp',
    );
  });
});

describe('bearerSubprotocols', () => {
  it('offers nothing when the daemon has no token', () => {
    expect(bearerSubprotocols(undefined)).toEqual([]);
  });

  it('offers the marker plus a base64url bearer the daemon can decode', () => {
    const protocols = bearerSubprotocols('sek+ret/token=');
    expect(protocols[0]).toBe('qwen-ws');
    const encoded = protocols[1]!.slice('qwen-bearer.'.length);
    expect(encoded).not.toMatch(/[+/=]/);
    const padded = encoded.replace(/-/g, '+').replace(/_/g, '/');
    expect(atob(padded)).toBe('sek+ret/token=');
  });
});

describe('LocalFilesBridge handshake', () => {
  it('connects, initializes as a non-extension client and registers against the session', async () => {
    const h = harness({ token: 'abc123' });
    const socket = await connect(h);

    expect(socket.url).toBe('wss://daemon.example/acp');
    expect(socket.protocols[0]).toBe('qwen-ws');
    expect(socket.protocols).toHaveLength(2);

    const initialize = socket.sent[0]!;
    expect(initialize['method']).toBe('initialize');
    expect(initialize['params']).toEqual({
      clientInfo: { name: LOCAL_FILES_CLIENT_NAME, version: '1.0.0' },
    });

    // The sessionId is what keeps these tools out of sibling sessions.
    expect(socket.framesOfType('mcp_register')).toEqual([
      { type: 'mcp_register', server: 'local-files', sessionId: 'session-1' },
    ]);
    expect(lastPhase(h)).toBe('connected');
    expect(h.states.at(-1)).toEqual({ phase: 'connected', toolCount: 4 });

    h.bridge.stop();
    await h.running;
  });

  it('ignores a registration ack for some other server', async () => {
    const h = harness();
    await flush();
    const socket = h.sockets[0]!;
    socket.emitOpen();
    socket.emit({
      jsonrpc: '2.0',
      id: 'local-files-acp-initialize',
      result: {},
    });
    await flush();
    socket.emit({
      type: 'mcp_registered',
      server: 'chrome-tools',
      toolCount: 9,
    });
    await flush();
    expect(lastPhase(h)).toBe('registering');
    h.bridge.stop();
    await h.running;
  });

  it('fails with a reason when the ACP initialize is refused', async () => {
    const h = harness();
    await flush();
    const socket = h.sockets[0]!;
    socket.emitOpen();
    socket.emit({
      jsonrpc: '2.0',
      id: 'local-files-acp-initialize',
      error: { message: 'unsupported protocol' },
    });
    await flush();
    expect(h.states.at(-1)).toEqual({
      phase: 'failed',
      code: 'acp_initialize_failed',
      message: 'unsupported protocol',
    });
    expect(socket.closeCount).toBe(1);
    await h.running;
  });

  it('reconnects when the initialize never answers', async () => {
    const h = harness({ initializeTimeoutMs: 0, reconnectBaseDelayMs: 10 });
    await flush();
    h.sockets[0]!.emitOpen();
    await flush();
    await flush();
    expect(h.sockets).toHaveLength(2);
    expect(h.delays[0]).toBe(10);
    h.bridge.stop();
    await h.running;
  });

  it('closes the socket it gives up on instead of leaking it under the replacement', async () => {
    const h = harness({ initializeTimeoutMs: 0, reconnectBaseDelayMs: 10 });
    await flush();
    const first = h.sockets[0]!;
    first.emitOpen();
    await flush();
    await flush();

    expect(h.sockets).toHaveLength(2);
    // The regression this pins: the timed-out socket stayed open while the
    // bridge moved on to a replacement.
    expect(first.closeCount).toBe(1);
    // Its close event must not also be handled as a second drop.
    expect(h.delays).toEqual([10]);
    h.bridge.stop();
    await h.running;
  });

  it('fails without opening a socket when the socket factory throws', async () => {
    const h = harness({
      openSocket: () => {
        throw new Error('blocked by policy');
      },
    });
    await flush();
    expect(h.sockets).toHaveLength(0);
    expect(h.states.at(-1)).toEqual({
      phase: 'failed',
      code: 'socket_open_failed',
      message: 'blocked by policy',
    });
    await h.running;
  });
});

describe('LocalFilesBridge registration retries', () => {
  it('re-warms the ACP child and retries a register_failed', async () => {
    const h = harness();
    await flush();
    const socket = h.sockets[0]!;
    socket.emitOpen();
    socket.emit({
      jsonrpc: '2.0',
      id: 'local-files-acp-initialize',
      result: {},
    });
    await flush();
    expect(socket.framesOfType('mcp_register')).toHaveLength(1);

    // The daemon answers this when the ACP child is cold or was reaped.
    socket.emit({
      type: 'mcp_error',
      code: 'register_failed',
      message: 'No live ACP channel for runtime MCP add: local-files',
    });
    await flush();

    expect(h.rewarmCalls).toBe(1);
    expect(socket.framesOfType('mcp_register')).toHaveLength(2);

    socket.emit({
      type: 'mcp_registered',
      server: 'local-files',
      toolCount: 4,
    });
    await flush();
    expect(lastPhase(h)).toBe('connected');
    h.bridge.stop();
    await h.running;
  });

  it('gives up after the attempt budget and keeps the failure as the final state', async () => {
    const h = harness({ maxRegisterAttempts: 2 });
    await flush();
    const socket = h.sockets[0]!;
    socket.emitOpen();
    socket.emit({
      jsonrpc: '2.0',
      id: 'local-files-acp-initialize',
      result: {},
    });
    await flush();
    for (let i = 0; i < 2; i++) {
      socket.emit({
        type: 'mcp_error',
        code: 'register_failed',
        message: 'No live ACP channel',
      });
      await flush();
    }

    // The regression this pins: teardown must not overwrite the reason with
    // 'stopped', or the UI shows "disconnected" instead of why.
    expect(h.states.at(-1)).toEqual({
      phase: 'failed',
      code: 'register_failed',
      message: 'No live ACP channel after 2 attempt(s)',
    });
    expect(h.bridge.getState().phase).toBe('failed');
    expect(socket.closeCount).toBe(1);
    expect(h.sockets).toHaveLength(1);
    await h.running;
  });

  it('fails immediately on a non-retryable mcp_error', async () => {
    const h = harness();
    await flush();
    const socket = h.sockets[0]!;
    socket.emitOpen();
    socket.emit({
      jsonrpc: '2.0',
      id: 'local-files-acp-initialize',
      result: {},
    });
    await flush();
    socket.emit({
      type: 'mcp_error',
      code: 'invalid_session_id',
      message: '`sessionId` must be a non-empty string when provided',
    });
    await flush();
    expect(h.states.at(-1)).toMatchObject({
      phase: 'failed',
      code: 'invalid_session_id',
    });
    expect(h.rewarmCalls).toBe(0);
    await h.running;
  });
});

describe('LocalFilesBridge RPC routing', () => {
  it('answers a daemon tools/list through the MCP server and correlates the frame id', async () => {
    const directory = {
      name: 'ai_coding',
      list: async () => ({ entries: [], truncated: false, limit: 500 }),
      read: async (path: string) => ({
        path,
        content: '',
        totalLines: 0,
        returnedLines: 0,
        truncated: false,
      }),
      write: async (path: string, content: string) => ({
        path,
        bytes: content.length,
        created: true,
      }),
      search: async (pattern: string) => ({
        pattern,
        hits: [],
        filesScanned: 0,
        bytesScanned: 0,
        filesSkipped: 0,
        truncated: false,
        truncatedBy: null,
      }),
    };
    const h = harness({ server: new LocalFilesMcpServer(directory) });
    const socket = await connect(h);

    socket.emit({
      type: 'mcp_message',
      id: 'cmcp-5',
      server: 'local-files',
      payload: { jsonrpc: '2.0', id: 5, method: 'tools/list' },
    });
    await flush();

    const replies = socket.framesOfType('mcp_message');
    expect(replies).toHaveLength(1);
    expect(replies[0]!['id']).toBe('cmcp-5');
    expect(replies[0]!['server']).toBe('local-files');
    const payload = replies[0]!['payload'] as JsonRpcResponse;
    expect(payload.id).toBe(5);
    const tools = (payload.result as { tools: Array<{ name: string }> }).tools;
    expect(tools.map((tool) => tool.name)).toEqual([
      'list_directory',
      'read_file',
      'write_file',
      'search_files',
    ]);

    h.bridge.stop();
    await h.running;
  });

  it('never replies to a notification', async () => {
    const h = harness();
    const socket = await connect(h);
    socket.emit({
      type: 'mcp_message',
      id: 'cmcp-2',
      server: 'local-files',
      payload: { jsonrpc: '2.0', method: 'notifications/initialized' },
    });
    await flush();
    expect(socket.framesOfType('mcp_message')).toHaveLength(0);
    h.bridge.stop();
    await h.running;
  });

  it('ignores an RPC frame addressed to a server it does not host', async () => {
    const h = harness();
    const socket = await connect(h);
    socket.emit({
      type: 'mcp_message',
      id: 'cmcp-3',
      server: 'some-other-client-server',
      payload: { jsonrpc: '2.0', id: 3, method: 'tools/list' },
    });
    await flush();
    expect(socket.framesOfType('mcp_message')).toHaveLength(0);
    expect(h.rpc.calls).toHaveLength(0);
    h.bridge.stop();
    await h.running;
  });

  it('turns a throwing RPC server into a JSON-RPC error instead of dropping the frame', async () => {
    const h = harness({
      server: {
        handle: async () => {
          throw new Error('server exploded');
        },
      },
    });
    const socket = await connect(h);
    socket.emit({
      type: 'mcp_message',
      id: 'cmcp-9',
      server: 'local-files',
      payload: { jsonrpc: '2.0', id: 9, method: 'tools/list' },
    });
    await flush();
    const replies = socket.framesOfType('mcp_message');
    expect(replies).toHaveLength(1);
    expect((replies[0]!['payload'] as JsonRpcResponse).error?.code).toBe(
      -32603,
    );
    h.bridge.stop();
    await h.running;
  });

  it('ignores malformed frames and unrelated ACP traffic', async () => {
    const h = harness();
    const socket = await connect(h);
    socket.emitRaw('not json at all');
    socket.emit({ jsonrpc: '2.0', method: 'session/update', params: {} });
    socket.emit({ type: 'mcp_message', server: 'local-files' }); // no id
    await flush();
    expect(lastPhase(h)).toBe('connected');
    expect(socket.framesOfType('mcp_message')).toHaveLength(0);
    h.bridge.stop();
    await h.running;
  });
});

describe('LocalFilesBridge reconnection', () => {
  it('reconnects with backoff and registers again on the new socket', async () => {
    const h = harness({ reconnectBaseDelayMs: 500 });
    const first = await connect(h);

    first.emitClose(1006, 'daemon restarted');
    await flush();

    expect(h.delays[0]).toBe(500);
    expect(h.sockets).toHaveLength(2);
    const second = h.sockets[1]!;
    expect(second.framesOfType('mcp_register')).toHaveLength(0);

    second.emitOpen();
    await flush();
    // The daemon dropped the server when the old socket closed, so the new one
    // must run the whole handshake again — including the session binding.
    expect(second.sent[0]!['method']).toBe('initialize');
    second.emit({
      jsonrpc: '2.0',
      id: 'local-files-acp-initialize',
      result: {},
    });
    await flush();
    expect(second.framesOfType('mcp_register')).toEqual([
      { type: 'mcp_register', server: 'local-files', sessionId: 'session-1' },
    ]);

    second.emitClose(1006, '');
    await flush();
    expect(h.delays[1]).toBe(1000);

    h.bridge.stop();
    await h.running;
  });

  it('stops retrying once the reconnect budget is spent', async () => {
    const h = harness({ maxReconnectAttempts: 1, reconnectBaseDelayMs: 1 });
    await flush();
    h.sockets[0]!.emitOpen();
    h.sockets[0]!.emitClose(1006, 'gone');
    await flush();
    expect(h.sockets).toHaveLength(2);
    h.sockets[1]!.emitClose(1006, 'gone again');
    await flush();

    expect(h.states.at(-1)).toMatchObject({
      phase: 'failed',
      code: 'disconnected',
    });
    expect(String(h.states.at(-1)!.phase)).toBe('failed');
    expect(h.sockets).toHaveLength(2);
    await h.running;
  });

  it('escalates and gives up on a daemon that accepts sockets but never registers', async () => {
    // The flapping case: `open` alone must NOT reset the streak, or this loop
    // would retry at the base delay forever and never reach the budget.
    const h = harness({ maxReconnectAttempts: 2, reconnectBaseDelayMs: 100 });
    for (let i = 0; i < 3; i++) {
      await flush();
      const socket = h.sockets[i]!;
      socket.emitOpen();
      socket.emitClose(1006, 'flapping');
      await flush();
    }
    expect(h.delays).toEqual([100, 200]);
    expect(h.states.at(-1)).toMatchObject({
      phase: 'failed',
      code: 'disconnected',
    });
    expect(h.sockets).toHaveLength(3);
    await h.running;
  });

  it('re-registers when the daemon removes the server under us', async () => {
    const h = harness();
    const socket = await connect(h);
    socket.emit({ type: 'mcp_unregistered', server: 'local-files' });
    await flush();
    expect(h.rewarmCalls).toBe(1);
    expect(socket.framesOfType('mcp_register')).toHaveLength(2);
    h.bridge.stop();
    await h.running;
  });
});

describe('LocalFilesBridge stop', () => {
  it('closes the socket and does not treat its own teardown as a drop', async () => {
    const h = harness();
    await connect(h);
    h.bridge.stop();
    await h.running;

    expect(h.sockets[0]!.closeCount).toBe(1);
    expect(h.sockets).toHaveLength(1);
    expect(h.states.at(-1)).toEqual({ phase: 'stopped' });
  });

  it('is idempotent', async () => {
    const h = harness();
    await connect(h);
    h.bridge.stop();
    h.bridge.stop();
    await h.running;
    expect(h.sockets[0]!.closeCount).toBe(1);
  });

  it('ignores a second start() instead of running two loops', async () => {
    const h = harness();
    // What a re-run React effect would do: a second loop would overwrite
    // releaseRun and orphan the first promise.
    const second = h.bridge.start();
    await connect(h);
    expect(h.sockets).toHaveLength(1);

    h.bridge.stop();
    await Promise.all([h.running, second]);
    expect(h.sockets).toHaveLength(1);
    expect(h.states.at(-1)).toEqual({ phase: 'stopped' });
  });

  it('releases the cross-tab lock so another tab can take over', async () => {
    const h = harness();
    await connect(h);
    expect(h.locks.held).toBe(true);
    h.bridge.stop();
    await h.running;
    expect(h.locks.held).toBe(false);
  });
});

describe('LocalFilesBridge cross-tab ownership', () => {
  it('does not open a socket when another tab holds the bridge', async () => {
    const locks = new FakeLocks(true);
    const states: LocalFilesBridgeState[] = [];
    const rpc = recordingRpc();
    const sockets: FakeSocket[] = [];
    const bridge = new LocalFilesBridge({
      baseUrl: 'https://daemon.example/',
      sessionId: 'session-1',
      server: rpc.server,
      locks,
      openSocket: (url, protocols) => {
        const socket = new FakeSocket(url, protocols);
        sockets.push(socket);
        return socket;
      },
      onState: (state) => states.push(state),
    });

    await bridge.start();

    expect(sockets).toHaveLength(0);
    expect(states.at(-1)).toEqual({ phase: 'held-elsewhere' });
    expect(locks.requests).toBe(1);
  });

  it('runs without a lock manager at all', async () => {
    const h = harness({ locks: null });
    const socket = await connect(h);
    expect(lastPhase(h)).toBe('connected');
    expect(socket.framesOfType('mcp_register')).toHaveLength(1);
    h.bridge.stop();
    await h.running;
  });
});

describe('LocalFilesBridge registration payload', () => {
  it('honours a custom server name and client identity', async () => {
    const h = harness({
      serverName: 'my-files',
      clientInfo: { name: 'custom-client', version: '9.9' },
    });
    await flush();
    const socket = h.sockets[0]!;
    socket.emitOpen();
    await flush();
    expect(socket.sent[0]!['params']).toEqual({
      clientInfo: { name: 'custom-client', version: '9.9' },
    });
    socket.emit({
      jsonrpc: '2.0',
      id: 'local-files-acp-initialize',
      result: {},
    });
    await flush();
    expect(socket.framesOfType('mcp_register')).toEqual([
      { type: 'mcp_register', server: 'my-files', sessionId: 'session-1' },
    ]);
    socket.emit({ type: 'mcp_registered', server: 'my-files', toolCount: 4 });
    await flush();
    expect(lastPhase(h)).toBe('connected');
    h.bridge.stop();
    await h.running;
  });

  it('reports every phase it passes through', async () => {
    const h = harness();
    await connect(h);
    const phases = h.states.map((state) => state.phase);
    expect(phases).toEqual(['connecting', 'registering', 'connected']);
    h.bridge.stop();
    await h.running;
  });
});
