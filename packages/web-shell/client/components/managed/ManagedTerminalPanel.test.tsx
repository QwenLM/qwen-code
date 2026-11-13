// @vitest-environment jsdom
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fit = vi.hoisted(() => vi.fn());
const terminalMock = vi.hoisted(() => ({
  options: {} as Record<string, unknown>,
  cols: 80,
  rows: 24,
  loadAddon: vi.fn(),
  open: vi.fn(),
  resize: vi.fn(),
  write: vi.fn((_text: string, callback?: () => void) => callback?.()),
  writeln: vi.fn(),
  focus: vi.fn(),
  blur: vi.fn(),
  refresh: vi.fn(),
  dispose: vi.fn(),
  onData: vi.fn((_listener: (data: string) => void) => ({
    dispose: vi.fn(),
  })),
  parser: {
    registerCsiHandler: vi.fn(
      (_id: { final: string }, _handler: () => boolean) => ({
        dispose: vi.fn(),
      }),
    ),
  },
}));

vi.mock('@xterm/xterm', () => ({
  Terminal: vi.fn(() => terminalMock),
}));
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: vi.fn(() => ({ fit })),
}));
vi.mock('../../i18n', () => ({
  useI18n: () => ({
    t: (key: string, values?: Record<string, string>) =>
      ({
        'terminal.title': 'Terminal',
        'terminal.notice.exited': `Process exited with code ${values?.['exitCode'] ?? '?'}`,
        'terminal.notice.error': `Error: ${values?.['message'] ?? ''}`,
        'terminal.notice.unknownError': 'Unknown error',
        'terminal.notice.reconnecting': 'Connection lost — reconnecting…',
        'terminal.notice.lost': 'This terminal is no longer available.',
        'terminal.notice.protocolMismatch': 'Terminal protocol changed',
      })[key] ?? key,
  }),
}));

import { ManagedTerminalPanel } from './ManagedTerminalPanel';

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static readonly instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  binaryType: BinaryType = 'blob';
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  readonly send = vi.fn();
  readonly close = vi.fn((_code?: number, _reason?: string) => {
    this.readyState = FakeWebSocket.CLOSED;
  });

  constructor(
    readonly url: string,
    readonly protocols?: string | string[],
  ) {
    FakeWebSocket.instances.push(this);
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  closeWith(code: number): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code } as CloseEvent);
  }
}

describe('ManagedTerminalPanel', () => {
  let container: HTMLDivElement;
  let root: Root | undefined;
  const onClose = vi.fn();
  const restoreFocus = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    terminalMock.options = {};
    FakeWebSocket.instances.length = 0;
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(16);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    if (root) {
      const current = root;
      act(() => current.unmount());
      // Unmount can start the post-unmount release fallback (an async ticket
      // request plus bounded retry timers). Drain it under the fake clock
      // before restoring real timers, or its continuation lands in the next
      // test and pushes a stray FakeWebSocket into that test's reset array.
      await act(async () => {
        await vi.runAllTimersAsync();
      });
    }
    root = undefined;
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function flush() {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  async function render(ticketFn: ReturnType<typeof vi.fn>) {
    const terminal = {
      ticket: ticketFn,
      webSocketUrl: vi.fn(
        (sessionId: string, terminalId: string) =>
          `wss://managed.example/sessions/${sessionId}/terminal?terminalId=${terminalId}`,
      ),
    };
    await act(async () => {
      root!.render(
        <ManagedTerminalPanel
          terminal={terminal}
          sessionId="s1"
          terminalId="t1"
          clientId="c1"
          onClose={onClose}
          restoreFocus={restoreFocus}
        />,
      );
    });
    await flush();
    return terminal;
  }

  it('offers the minted ticket verbatim on the terminal WebSocket', async () => {
    const ticket = 'eyJ_abc-123';
    const ticketFn = vi
      .fn()
      .mockResolvedValue({ ticket, expiresInSeconds: 30 });
    const terminal = await render(ticketFn);
    expect(terminal.ticket).toHaveBeenCalledWith(
      's1',
      't1',
      expect.objectContaining({ clientId: 'c1' }),
    );
    expect(terminal.webSocketUrl).toHaveBeenCalledWith('s1', 't1');
    expect(FakeWebSocket.instances).toHaveLength(1);
    const ws = FakeWebSocket.instances[0]!;
    expect(ws.protocols).toEqual(['qwen-ws', `qwen-bearer.${ticket}`]);
  });

  it('mints a fresh ticket when reconnecting', async () => {
    const ticketFn = vi
      .fn()
      .mockResolvedValueOnce({ ticket: 'ticket-one', expiresInSeconds: 30 })
      .mockResolvedValueOnce({ ticket: 'ticket-two', expiresInSeconds: 30 });
    await render(ticketFn);
    const first = FakeWebSocket.instances[0]!;
    first.open();
    first.closeWith(1006);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(ticketFn).toHaveBeenCalledTimes(2);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(FakeWebSocket.instances[1]!.protocols).toEqual([
      'qwen-ws',
      'qwen-bearer.ticket-two',
    ]);
  });

  it('stops with a lost notice on the relay terminal-lost close code (4003)', async () => {
    // 4003 is the Managed relay's synthesized worker-lost code; it is in
    // NON_RETRYABLE_CLOSE_CODES, so the panel must end, not reconnect forever.
    const ticketFn = vi
      .fn()
      .mockResolvedValue({ ticket: 'ticket-one', expiresInSeconds: 30 });
    await render(ticketFn);
    const ws = FakeWebSocket.instances[0]!;
    ws.open();
    ws.closeWith(4003);
    expect(terminalMock.writeln).toHaveBeenCalledWith(
      expect.stringContaining('This terminal is no longer available.'),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(ticketFn).toHaveBeenCalledTimes(1);
  });

  it('stops with a lost notice when ticket admission is refused', async () => {
    const ticketFn = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('refused'), { status: 403 }));
    await render(ticketFn);
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(terminalMock.writeln).toHaveBeenCalledWith(
      expect.stringContaining('This terminal is no longer available.'),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(ticketFn).toHaveBeenCalledTimes(1);
  });

  it('retries a transient workspace_unavailable instead of ending', async () => {
    const ticketFn = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error('bootstrapping'), {
          status: 409,
          code: 'workspace_unavailable',
        }),
      )
      .mockResolvedValueOnce({ ticket: 'ticket-two', expiresInSeconds: 30 });
    await render(ticketFn);
    expect(FakeWebSocket.instances).toHaveLength(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(ticketFn).toHaveBeenCalledTimes(2);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('retries an expired credential (401) instead of going terminal', async () => {
    // The ticket POST re-derives its headers per attempt, so a 401 during a
    // token refresh admits on the next try — it must never end the surface.
    const ticketFn = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error('expired'), { status: 401 }),
      )
      .mockResolvedValueOnce({ ticket: 'ticket-two', expiresInSeconds: 30 });
    await render(ticketFn);
    expect(FakeWebSocket.instances).toHaveLength(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(ticketFn).toHaveBeenCalledTimes(2);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(terminalMock.writeln).not.toHaveBeenCalledWith(
      expect.stringContaining('This terminal is no longer available.'),
    );
  });

  it('ends on a permanent 409 that is not workspace_unavailable', async () => {
    // A closed Session answers 409 session_operation_active: a permanent
    // answer, not a bootstrapping hiccup, so it must not retry forever.
    const ticketFn = vi.fn().mockRejectedValue(
      Object.assign(new Error('closed'), {
        status: 409,
        code: 'session_operation_active',
      }),
    );
    await render(ticketFn);
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(terminalMock.writeln).toHaveBeenCalledWith(
      expect.stringContaining('This terminal is no longer available.'),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(ticketFn).toHaveBeenCalledTimes(1);
  });

  it('shows the lost notice even after a reconnect notice', async () => {
    const ticketFn = vi
      .fn()
      .mockResolvedValueOnce({ ticket: 'ticket-one', expiresInSeconds: 30 })
      .mockRejectedValue(Object.assign(new Error('refused'), { status: 403 }));
    await render(ticketFn);
    const first = FakeWebSocket.instances[0]!;
    first.open();
    first.closeWith(1006);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(terminalMock.writeln).toHaveBeenCalledWith(
      expect.stringContaining('This terminal is no longer available.'),
    );
  });

  it('keeps the dialog open on a backdrop pointer-down', async () => {
    const ticketFn = vi
      .fn()
      .mockResolvedValue({ ticket: 'ticket-one', expiresInSeconds: 30 });
    await render(ticketFn);
    const ws = FakeWebSocket.instances[0]!;
    ws.open();
    await act(async () => {
      document.body.dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true, cancelable: true }),
      );
    });
    await flush();
    expect(onClose).not.toHaveBeenCalled();
    expect(ws.send).not.toHaveBeenCalledWith('\x00{"type":"release"}');
  });

  it('restores the snapshot replay and re-arms input', async () => {
    const ticketFn = vi
      .fn()
      .mockResolvedValue({ ticket: 'ticket-one', expiresInSeconds: 30 });
    await render(ticketFn);
    const ws = FakeWebSocket.instances[0]!;
    ws.open();
    // The snapshot control frame arms the restore; the following binary frame
    // is the replayed scrollback.
    act(() => {
      ws.onmessage?.({
        data: '\x00{"type":"snapshot","replay":false,"handlesPrimaryDa":false}',
      } as MessageEvent);
    });
    act(() => {
      ws.onmessage?.({
        data: new TextEncoder().encode('replayed-scrollback').buffer,
      } as MessageEvent);
    });
    await flush();
    expect(terminalMock.write).toHaveBeenCalledWith(
      'replayed-scrollback',
      expect.any(Function),
    );
    // Input is re-armed on the restored terminal (initial arm + restore arm).
    expect(terminalMock.onData.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('releases the terminal and disposes xterm on unmount', async () => {
    const ticketFn = vi
      .fn()
      .mockResolvedValue({ ticket: 'ticket-one', expiresInSeconds: 30 });
    await render(ticketFn);
    const ws = FakeWebSocket.instances[0]!;
    ws.open();
    const current = root;
    act(() => current!.unmount());
    root = undefined;
    expect(ws.send).toHaveBeenCalledWith('\x00{"type":"release"}');
    expect(ws.close).toHaveBeenCalled();
    expect(terminalMock.dispose).toHaveBeenCalled();
  });

  it('keeps the dialog open when Escape reaches the terminal', async () => {
    const ticketFn = vi
      .fn()
      .mockResolvedValue({ ticket: 'ticket-one', expiresInSeconds: 30 });
    await render(ticketFn);
    const ws = FakeWebSocket.instances[0]!;
    ws.open();
    // Escape belongs to the terminal application (e.g. leaving Vim insert
    // mode); it must be prevented so Radix does not dismiss the dialog and
    // release the PTY out from under the running shell.
    const escape = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    await act(async () => {
      document.dispatchEvent(escape);
    });
    await flush();
    expect(escape.defaultPrevented).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
    expect(ws.send).not.toHaveBeenCalledWith('\x00{"type":"release"}');
  });

  it('delivers the release through the handshake when unmounted while CONNECTING', async () => {
    // Closing the dialog mid-handshake must not abort the socket: the
    // worker only releases the PTY on an explicit release frame, so the
    // completed handshake delivers it instead of leaking the shell.
    const ticketFn = vi
      .fn()
      .mockResolvedValue({ ticket: 'ticket-one', expiresInSeconds: 30 });
    await render(ticketFn);
    const ws = FakeWebSocket.instances[0]!;
    expect(ws.readyState).toBe(FakeWebSocket.CONNECTING);
    const current = root;
    act(() => current!.unmount());
    root = undefined;
    expect(ws.close).not.toHaveBeenCalled();
    act(() => ws.open());
    expect(ws.send).toHaveBeenCalledWith('\x00{"type":"release"}');
    expect(ws.close).toHaveBeenCalled();
  });

  it('releases through a dedicated connection when unmounted during reconnect backoff', async () => {
    // In backoff there is no live socket to carry the release frame; a
    // plain unmount would leave the PTY and its durable hold alive.
    const ticketFn = vi
      .fn()
      .mockResolvedValueOnce({ ticket: 'ticket-one', expiresInSeconds: 30 })
      .mockResolvedValueOnce({
        ticket: 'release-ticket',
        expiresInSeconds: 30,
      });
    await render(ticketFn);
    const first = FakeWebSocket.instances[0]!;
    first.open();
    first.closeWith(1006);
    const current = root;
    act(() => current!.unmount());
    root = undefined;
    await flush();
    expect(FakeWebSocket.instances).toHaveLength(2);
    const release = FakeWebSocket.instances[1]!;
    expect(release.protocols).toEqual([
      'qwen-ws',
      'qwen-bearer.release-ticket',
    ]);
    act(() => release.open());
    expect(release.send).toHaveBeenCalledWith('\x00{"type":"release"}');
    // 4004 is the worker's release confirmation: no further attempts.
    act(() => release.closeWith(4004));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(ticketFn).toHaveBeenCalledTimes(2);
  });

  it('releases through a dedicated connection when unmounted before the first socket exists', async () => {
    let resolveFirst:
      | ((value: { ticket: string; expiresInSeconds: number }) => void)
      | undefined;
    const ticketFn = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce({
        ticket: 'release-ticket',
        expiresInSeconds: 30,
      });
    await render(ticketFn);
    expect(FakeWebSocket.instances).toHaveLength(0);
    const current = root;
    act(() => current!.unmount());
    root = undefined;
    await flush();
    // The in-flight ticket was aborted; the fallback minted its own.
    resolveFirst?.({ ticket: 'stale-ticket', expiresInSeconds: 30 });
    await flush();
    expect(FakeWebSocket.instances).toHaveLength(1);
    const release = FakeWebSocket.instances[0]!;
    expect(release.protocols).toEqual([
      'qwen-ws',
      'qwen-bearer.release-ticket',
    ]);
    act(() => release.open());
    expect(release.send).toHaveBeenCalledWith('\x00{"type":"release"}');
  });

  it('retries the dedicated release until the worker confirms 4004', async () => {
    const ticketFn = vi
      .fn()
      .mockResolvedValueOnce({ ticket: 'ticket-one', expiresInSeconds: 30 })
      .mockResolvedValueOnce({ ticket: 'release-1', expiresInSeconds: 30 })
      .mockResolvedValueOnce({ ticket: 'release-2', expiresInSeconds: 30 });
    await render(ticketFn);
    const first = FakeWebSocket.instances[0]!;
    first.open();
    first.closeWith(1006);
    const current = root;
    act(() => current!.unmount());
    root = undefined;
    await flush();
    const attempt1 = FakeWebSocket.instances[1]!;
    act(() => attempt1.open());
    expect(attempt1.send).toHaveBeenCalledWith('\x00{"type":"release"}');
    // A non-confirmation close means the frame may not have landed.
    act(() => attempt1.closeWith(1006));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(FakeWebSocket.instances).toHaveLength(3);
    const attempt2 = FakeWebSocket.instances[2]!;
    expect(attempt2.protocols).toEqual(['qwen-ws', 'qwen-bearer.release-2']);
    act(() => attempt2.open());
    act(() => attempt2.closeWith(4004));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(ticketFn).toHaveBeenCalledTimes(3);
  });

  it('stops the dedicated release after three failed attempts', async () => {
    // The retry chain is bounded: three non-confirmation closes must not
    // spawn a fourth connection (an unbounded loop would leak sockets and
    // tickets for a worker that never confirms).
    const ticketFn = vi
      .fn()
      .mockResolvedValueOnce({ ticket: 'ticket-one', expiresInSeconds: 30 })
      .mockResolvedValueOnce({ ticket: 'release-1', expiresInSeconds: 30 })
      .mockResolvedValueOnce({ ticket: 'release-2', expiresInSeconds: 30 })
      .mockResolvedValueOnce({ ticket: 'release-3', expiresInSeconds: 30 });
    await render(ticketFn);
    const first = FakeWebSocket.instances[0]!;
    first.open();
    first.closeWith(1006);
    const current = root;
    act(() => current!.unmount());
    root = undefined;
    await flush();
    for (const index of [1, 2, 3]) {
      const attempt = FakeWebSocket.instances[index]!;
      act(() => attempt.open());
      expect(attempt.send).toHaveBeenCalledWith('\x00{"type":"release"}');
      act(() => attempt.closeWith(1006));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });
    }
    // Three release attempts (instances 1-3) plus the original; no fourth.
    expect(FakeWebSocket.instances).toHaveLength(4);
    expect(FakeWebSocket.instances[3]!.protocols).toEqual([
      'qwen-ws',
      'qwen-bearer.release-3',
    ]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(FakeWebSocket.instances).toHaveLength(4);
    expect(ticketFn).toHaveBeenCalledTimes(4);
  });

  it('keeps the replayed screen and exit notice when the worker closes right after the replay', async () => {
    // xterm defers the write callback to a later macrotask. The worker's
    // normal post-replay sequence (exit frame, then 4000 close) lands
    // first and nulls wsRef; the swap must still mount the replayed
    // screen instead of leaving it on a detached terminal.
    const syncWrite = terminalMock.write.getMockImplementation()!;
    terminalMock.write.mockImplementation((_text: string, cb?: () => void) => {
      if (cb) setTimeout(cb, 0);
    });
    try {
      const ticketFn = vi
        .fn()
        .mockResolvedValue({ ticket: 'ticket-one', expiresInSeconds: 30 });
      await render(ticketFn);
      const ws = FakeWebSocket.instances[0]!;
      ws.open();
      act(() => {
        ws.onmessage?.({
          data: '\x00{"type":"snapshot","replay":true,"handlesPrimaryDa":false}',
        } as MessageEvent);
      });
      act(() => {
        ws.onmessage?.({
          data: new TextEncoder().encode('replayed-scrollback').buffer,
        } as MessageEvent);
      });
      act(() => {
        ws.onmessage?.({
          data: '\x00{"type":"exit","exitCode":0}',
        } as MessageEvent);
      });
      act(() => ws.closeWith(4000));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      const surface = document.querySelector('[data-managed-terminal]')!;
      const secondHost = terminalMock.open.mock.calls[1]![0];
      expect(surface.firstElementChild).toBe(secondHost);
      expect(terminalMock.dispose).toHaveBeenCalledTimes(1);
      expect(terminalMock.writeln).toHaveBeenCalledWith(
        expect.stringContaining('Process exited with code 0'),
      );
    } finally {
      terminalMock.write.mockImplementation(syncWrite);
    }
  });
});
