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

  afterEach(() => {
    if (root) {
      const current = root;
      act(() => current.unmount());
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
});
