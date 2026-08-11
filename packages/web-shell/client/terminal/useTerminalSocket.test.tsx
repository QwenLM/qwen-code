// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { StrictMode, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toTerminalWebSocketUrl, useTerminalSocket } from './useTerminalSocket';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static OPEN = 1;
  readonly OPEN = 1;
  url: string;
  protocols?: string | string[];
  binaryType = '';
  // Treat the fake as already open; tests drive message events directly.
  readyState = 1; // OPEN
  sent: Array<string | Uint8Array> = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onopen: (() => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string, protocols?: string | string[]) {
    this.url = url;
    this.protocols = protocols;
    FakeWebSocket.instances.push(this);
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  send(data: string | Uint8Array | ArrayBuffer): void {
    if (data instanceof ArrayBuffer) {
      this.sent.push(new Uint8Array(data));
    } else {
      this.sent.push(data);
    }
  }

  close(code = 1000, reason = ''): void {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }

  emitMessage(data: unknown): void {
    this.onmessage?.({ data });
  }

  sentText(): string[] {
    return this.sent.filter((d): d is string => typeof d === 'string');
  }
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

interface HookResult {
  status: string;
  errorMessage: string | undefined;
  sendInput: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  reconnect: () => void;
}

function renderHook(opts: {
  sessionId: string;
  taskId: string;
  token?: string;
  enabled?: boolean;
  onOutput: (chunk: Uint8Array) => void;
}): { current: HookResult } {
  const captured: { current: HookResult | null } = { current: null };
  function Probe() {
    const value = useTerminalSocket({
      baseUrl: 'http://127.0.0.1:7899',
      sessionId: opts.sessionId,
      taskId: opts.taskId,
      ...(opts.token !== undefined ? { token: opts.token } : {}),
      ...(opts.enabled !== undefined ? { enabled: opts.enabled } : {}),
      onOutput: opts.onOutput,
    });
    captured.current = value;
    return null;
  }
  container = document.createElement('div');
  root = createRoot(container);
  act(() => {
    root!.render(<Probe />);
  });
  return captured as unknown as { current: HookResult };
}

const flush = async (): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

describe('toTerminalWebSocketUrl', () => {
  it('builds a ws url with sessionId and taskId query params', () => {
    const url = toTerminalWebSocketUrl(
      'http://127.0.0.1:7899',
      'sess-1',
      'bg_abc123',
    );
    expect(url).toBe(
      'ws://127.0.0.1:7899/terminal?sessionId=sess-1&taskId=bg_abc123',
    );
  });

  it('upgrades https to wss', () => {
    const url = toTerminalWebSocketUrl('https://daemon.example.com', 's', 't');
    expect(url.startsWith('wss://daemon.example.com/terminal?')).toBe(true);
  });

  it('keeps a workspace base path instead of dropping to the origin root', () => {
    const url = toTerminalWebSocketUrl(
      'http://127.0.0.1:7899/workspaces/abc',
      'sess-1',
      'bg_abc123',
    );
    expect(url).toBe(
      'ws://127.0.0.1:7899/workspaces/abc/terminal?sessionId=sess-1&taskId=bg_abc123',
    );
  });
});

describe('useTerminalSocket', () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (root) {
      act(() => {
        root!.unmount();
      });
      root = null;
    }
    container?.remove();
    container = null;
  });

  const makeHook = () =>
    renderHook({
      sessionId: 'sess-1',
      taskId: 'bg_abc123',
      token: 'test-token',
      onOutput: () => {},
    });

  it('connects with bearer subprotocol and sends hello on ready', async () => {
    const hook = makeHook();
    await flush();
    const ws = FakeWebSocket.instances[0]!;
    expect(ws.url).toContain('/terminal?sessionId=sess-1&taskId=bg_abc123');
    const protocols = Array.isArray(ws.protocols)
      ? ws.protocols
      : [ws.protocols];
    expect(protocols).toContain('qwen-ws');
    const bearer = protocols.find((p) => p?.startsWith('qwen-bearer.'));
    expect(bearer).toBeDefined();
    // The subprotocol must round-trip the exact token bytes.
    const b64 = bearer!.slice('qwen-bearer.'.length);
    const decoded = new TextDecoder().decode(
      Uint8Array.from(atob(b64.replace(/-/g, '+').replace(/_/g, '/')), (c) =>
        c.charCodeAt(0),
      ),
    );
    expect(decoded).toBe('test-token');
    expect(ws.binaryType).toBe('arraybuffer');
    expect(hook.current.status).toBe('connecting');

    act(() => ws.emitMessage('{"type":"ready"}'));
    expect(hook.current.status).toBe('ready');
    const hello = JSON.parse(ws.sentText().at(-1)!) as {
      type: string;
      cols: number;
      rows: number;
    };
    expect(hello).toMatchObject({ type: 'hello', cols: 80, rows: 24 });
  });

  it('forwards binary output to onOutput', async () => {
    const chunks: string[] = [];
    const hook = renderHook({
      sessionId: 'sess-1',
      taskId: 'bg_abc123',
      token: 't',
      onOutput: (c) => chunks.push(new TextDecoder().decode(c)),
    });
    await flush();
    const ws = FakeWebSocket.instances[0]!;
    act(() => ws.emitMessage('{"type":"ready"}'));
    act(() => ws.emitMessage(new TextEncoder().encode('ECHO:HI').buffer));
    expect(chunks).toEqual(['ECHO:HI']);
    expect(hook.current.status).toBe('ready');
  });

  it('buffers input before ready and flushes after', async () => {
    const hook = makeHook();
    await flush();
    const ws = FakeWebSocket.instances[0]!;
    act(() => hook.current.sendInput('hello'));
    expect(ws.sent.length).toBe(0); // buffered, not ready
    act(() => ws.emitMessage('{"type":"ready"}'));
    // ready sends the hello control frame, then flushes buffered input as
    // a binary frame. Use ArrayBuffer.isView (realm-safe) rather than
    // `instanceof Uint8Array`, which can fail across jsdom realms.
    expect(ws.sentText().at(-1)).toContain('"type":"hello"');
    const binary = ws.sent.filter((d): d is Uint8Array =>
      ArrayBuffer.isView(d),
    );
    expect(binary.length).toBeGreaterThan(0);
    expect(new TextDecoder().decode(binary[0]!)).toBe('hello');
  });

  it('sends resize only when ready', async () => {
    const hook = makeHook();
    await flush();
    const ws = FakeWebSocket.instances[0]!;
    act(() => hook.current.resize(120, 40));
    expect(ws.sentText().some((t) => t.includes('"resize"'))).toBe(false);
    act(() => ws.emitMessage('{"type":"ready"}'));
    act(() => hook.current.resize(120, 40));
    const resize = ws
      .sentText()
      .map((t) => {
        try {
          return JSON.parse(t) as { type?: string; cols?: number };
        } catch {
          return {};
        }
      })
      .find((m) => m.type === 'resize');
    expect(resize).toMatchObject({ type: 'resize', cols: 120 });
  });

  it('surfaces error frames and recovers on reconnect', async () => {
    const hook = makeHook();
    await flush();
    const ws = FakeWebSocket.instances[0]!;
    act(() => ws.emitMessage('{"type":"error","message":"nope"}'));
    expect(hook.current.status).toBe('error');
    expect(hook.current.errorMessage).toBe('nope');

    act(() => hook.current.reconnect());
    await flush();
    expect(FakeWebSocket.instances.length).toBe(2);
    expect(hook.current.status).toBe('connecting');
  });

  it('marks closed when the socket closes with 1000', async () => {
    const hook = makeHook();
    await flush();
    const ws = FakeWebSocket.instances[0]!;
    act(() => ws.emitMessage('{"type":"ready"}'));
    act(() => ws.close(1000, 'terminal exited'));
    expect(hook.current.status).toBe('closed');
  });

  it('does not connect when enabled is false', async () => {
    renderHook({
      sessionId: 'sess-1',
      taskId: 'bg_abc123',
      token: 't',
      enabled: false,
      onOutput: () => {},
    });
    await flush();
    expect(FakeWebSocket.instances.length).toBe(0);
  });

  it('sends input immediately once ready', async () => {
    const hook = makeHook();
    await flush();
    const ws = FakeWebSocket.instances[0]!;
    act(() => ws.emitMessage('{"type":"ready"}'));
    act(() => hook.current.sendInput('direct'));
    const binary = ws.sent.filter((d): d is Uint8Array =>
      ArrayBuffer.isView(d),
    );
    expect(binary).toHaveLength(1);
    expect(new TextDecoder().decode(binary[0]!)).toBe('direct');
  });

  it('sends hello before buffered input on ready', async () => {
    const hook = makeHook();
    await flush();
    const ws = FakeWebSocket.instances[0]!;
    act(() => hook.current.sendInput('queued'));
    act(() => ws.emitMessage('{"type":"ready"}'));
    const helloIndex = ws.sent.findIndex(
      (d) => typeof d === 'string' && d.includes('"type":"hello"'),
    );
    const inputIndex = ws.sent.findIndex(
      (d) => ArrayBuffer.isView(d) && new TextDecoder().decode(d) === 'queued',
    );
    expect(helloIndex).toBeGreaterThanOrEqual(0);
    expect(inputIndex).toBeGreaterThan(helloIndex);
  });

  it('reports the remembered dimensions in hello', async () => {
    const hook = makeHook();
    await flush();
    const ws = FakeWebSocket.instances[0]!;
    act(() => hook.current.resize(100, 30));
    act(() => ws.emitMessage('{"type":"ready"}'));
    const hello = JSON.parse(ws.sentText().at(-1)!) as {
      cols: number;
      rows: number;
    };
    expect(hello).toMatchObject({ cols: 100, rows: 30 });
  });

  it('clears the error message and closes the old socket on reconnect', async () => {
    const hook = makeHook();
    await flush();
    const ws = FakeWebSocket.instances[0]!;
    act(() => ws.emitMessage('{"type":"error","message":"nope"}'));
    expect(hook.current.errorMessage).toBe('nope');

    act(() => hook.current.reconnect());
    await flush();
    expect(hook.current.errorMessage).toBeUndefined();
    expect(ws.readyState).toBe(3); // the first socket was closed
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it('keeps buffered input across a reconnect to the same terminal', async () => {
    const hook = makeHook();
    await flush();
    const ws = FakeWebSocket.instances[0]!;
    act(() => ws.emitMessage('{"type":"error","message":"gone"}'));
    // Input typed while disconnected must survive the reconnect.
    act(() => hook.current.sendInput('still-here'));
    act(() => hook.current.reconnect());
    await flush();
    const next = FakeWebSocket.instances[1]!;
    act(() => next.emitMessage('{"type":"ready"}'));
    const binary = next.sent.filter((d): d is Uint8Array =>
      ArrayBuffer.isView(d),
    );
    expect(binary.length).toBeGreaterThan(0);
    expect(new TextDecoder().decode(binary[0]!)).toBe('still-here');
  });

  it('drops buffered input when switching to a different terminal', async () => {
    const hook = makeHook();
    await flush();
    act(() => hook.current.sendInput('stale'));

    // Re-render with a different taskId: the target identity changed.
    const captured: { current: HookResult | null } = { current: null };
    function Probe({ taskId }: { taskId: string }) {
      const value = useTerminalSocket({
        baseUrl: 'http://127.0.0.1:7899',
        sessionId: 'sess-1',
        taskId,
        token: 'test-token',
        onOutput: () => {},
      });
      captured.current = value;
      return null;
    }
    act(() => {
      root!.render(<Probe taskId="bg_other" />);
    });
    await flush();
    const next = FakeWebSocket.instances.at(-1)!;
    act(() => next.emitMessage('{"type":"ready"}'));
    const binary = next.sent.filter((d): d is Uint8Array =>
      ArrayBuffer.isView(d),
    );
    expect(binary).toHaveLength(0);
    expect(captured.current).not.toBeNull();
  });

  it('survives a socket that throws while sending hello', async () => {
    const hook = makeHook();
    await flush();
    const ws = FakeWebSocket.instances[0]!;
    const originalSend = ws.send.bind(ws);
    let first = true;
    ws.send = (data: string | Uint8Array | ArrayBuffer) => {
      if (first && typeof data === 'string' && data.includes('hello')) {
        first = false;
        throw new Error('socket closed mid-handshake');
      }
      return originalSend(data);
    };
    expect(() => act(() => ws.emitMessage('{"type":"ready"}'))).not.toThrow();
    expect(hook.current.status).toBe('ready');
  });

  it('keeps stable callback identities across re-renders', async () => {
    const hook = makeHook();
    await flush();
    const { sendInput, resize, reconnect } = hook.current;
    const ws = FakeWebSocket.instances[0]!;
    act(() => ws.emitMessage('{"type":"ready"}'));
    expect(hook.current.sendInput).toBe(sendInput);
    expect(hook.current.resize).toBe(resize);
    expect(hook.current.reconnect).toBe(reconnect);
  });

  it('keeps the error state when the socket closes after an error frame', async () => {
    const hook = makeHook();
    await flush();
    const ws = FakeWebSocket.instances[0]!;
    act(() => ws.emitMessage('{"type":"error","message":"fatal"}'));
    expect(hook.current.status).toBe('error');
    // The daemon closes the socket right after the fatal error frame; that
    // close must not downgrade the terminal state to 'closed'.
    act(() => ws.close(1011, 'server error'));
    expect(hook.current.status).toBe('error');
    expect(hook.current.errorMessage).toBe('fatal');
  });

  it('reports an abnormal close with the code and reason', async () => {
    const hook = makeHook();
    await flush();
    const ws = FakeWebSocket.instances[0]!;
    act(() => ws.emitMessage('{"type":"ready"}'));
    act(() => ws.close(1006, 'network reset'));
    expect(hook.current.status).toBe('closed');
    expect(hook.current.errorMessage).toContain('1006');
    expect(hook.current.errorMessage).toContain('network reset');
  });

  it('survives React StrictMode double-mount with one live socket', async () => {
    function StrictProbe() {
      useTerminalSocket({
        baseUrl: 'http://127.0.0.1:7899',
        sessionId: 'sess-1',
        taskId: 'bg_abc123',
        token: 'test-token',
        onOutput: () => {},
      });
      return null;
    }
    const strictContainer = document.createElement('div');
    document.body.appendChild(strictContainer);
    const strictRoot = createRoot(strictContainer);
    act(() => {
      strictRoot.render(
        <StrictMode>
          <StrictProbe />
        </StrictMode>,
      );
    });
    await flush();
    // StrictMode mounts effects twice; cleanup must close the first socket
    // so exactly one connection stays live.
    const open = FakeWebSocket.instances.filter(
      (instance) => instance.readyState === 1,
    );
    expect(open).toHaveLength(1);
    act(() => {
      strictRoot.unmount();
    });
    strictContainer.remove();
  });

  it('errors out a stalled handshake after the connect timeout', async () => {
    vi.useFakeTimers();
    try {
      const hook = renderHook({
        sessionId: 'sess-1',
        taskId: 'bg_abc123',
        token: 't',
        onOutput: () => {},
      });
      await act(async () => {});
      const ws = FakeWebSocket.instances[0]!;
      await act(async () => {
        vi.advanceTimersByTime(10_000);
      });
      expect(hook.current.status).toBe('error');
      expect(hook.current.errorMessage).toMatch(/timed out/i);
      expect(ws.readyState).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
