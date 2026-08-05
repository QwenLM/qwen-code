// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { act } from 'react';
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
    expect(protocols.some((p) => p?.startsWith('qwen-bearer.'))).toBe(true);
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
});
