// @vitest-environment jsdom
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const terminal = vi.hoisted(() => ({
  options: {} as Record<string, unknown>,
  cols: 80,
  rows: 24,
  loadAddon: vi.fn(),
  open: vi.fn(),
  reset: vi.fn(),
  write: vi.fn(),
  writeln: vi.fn(),
  focus: vi.fn(),
  dispose: vi.fn(),
  onData: vi.fn((_listener: (data: string) => void) => ({ dispose: vi.fn() })),
}));

vi.mock('@xterm/xterm', () => ({ Terminal: vi.fn(() => terminal) }));
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: vi.fn(() => ({ fit: vi.fn() })),
}));
vi.mock('../../themeContext', () => ({ useTheme: () => 'light' }));
vi.mock('../../config/daemon', () => ({ getDaemonToken: () => '' }));

import { releaseWebTerminal, TerminalPanel } from './TerminalPanel';

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static readonly instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  binaryType: BinaryType = 'blob';
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  readonly send = vi.fn();
  readonly close = vi.fn(() => {
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

  message(data: string | Blob | ArrayBuffer): void {
    this.onmessage?.({ data } as MessageEvent);
  }

  closeWith(code: number): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code } as CloseEvent);
  }
}

describe('TerminalPanel', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
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
      callback(0);
      return 1;
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function render(): FakeWebSocket {
    act(() => {
      root.render(<TerminalPanel terminalId="terminal:one" cwd="/workspace" />);
    });
    return FakeWebSocket.instances[0]!;
  }

  it('keeps binary PTY output distinct from text control frames', async () => {
    const ws = render();
    act(() => ws.open());

    await act(async () => {
      ws.message(
        new TextEncoder().encode('\x00{"type":"exit","exitCode":0}').buffer,
      );
      ws.message('\x00{"type":"error","message":"denied"}');
      await Promise.resolve();
    });

    expect(terminal.write).toHaveBeenCalledWith(
      '\x00{"type":"exit","exitCode":0}',
    );
    expect(terminal.writeln).toHaveBeenCalledWith(
      expect.stringContaining('[Error: denied]'),
    );

    const handleInput = terminal.onData.mock.calls.at(-1)?.[0];
    ws.send.mockClear();
    act(() => handleInput?.('\x00{"type":"release"}'));
    const sent = ws.send.mock.calls[0]?.[0];
    expect(ArrayBuffer.isView(sent)).toBe(true);
    expect(new TextDecoder().decode(sent as Uint8Array)).toBe(
      '\x00{"type":"release"}',
    );
  });

  it.each([4000, 4001, 4002, 4003, 4004])(
    'does not reconnect after non-retryable close code %s',
    async (code) => {
      const ws = render();
      act(() => ws.open());
      act(() => ws.closeWith(code));
      await act(async () => vi.advanceTimersByTimeAsync(30_000));
      expect(FakeWebSocket.instances).toHaveLength(1);
    },
  );

  it('releases a connecting socket without reconnecting afterward', async () => {
    const ws = render();
    act(() => releaseWebTerminal('terminal:one'));

    act(() => ws.open());
    expect(ws.send).toHaveBeenCalledWith('\x00{"type":"release"}');
    act(() => ws.closeWith(1000));
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('reconnects transient failures without clearing the notice early', async () => {
    const ws = render();
    act(() => ws.open());
    terminal.reset.mockClear();
    act(() => ws.closeWith(1006));

    expect(terminal.writeln).toHaveBeenCalledWith(
      expect.stringContaining('Connection lost'),
    );
    expect(terminal.reset).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(FakeWebSocket.instances).toHaveLength(2);
    act(() => FakeWebSocket.instances[1]!.open());
    expect(terminal.reset).toHaveBeenCalledOnce();
  });

  it('sends an explicit release control when the tab is closed', () => {
    const ws = render();
    act(() => ws.open());

    act(() => releaseWebTerminal('terminal:one'));

    expect(ws.send).toHaveBeenCalledWith('\x00{"type":"release"}');
  });
});
