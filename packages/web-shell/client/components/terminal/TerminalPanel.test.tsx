// @vitest-environment jsdom
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const workspace = vi.hoisted(() => ({ baseUrl: 'http://localhost' }));
const fit = vi.hoisted(() => vi.fn());
const { terminal, terminalInstances, createMockTerminal } = vi.hoisted(() => {
  const createMockTerminal = () => ({
    options: {} as Record<string, unknown>,
    cols: 80,
    rows: 24,
    loadAddon: vi.fn(),
    open: vi.fn(),
    resize: vi.fn(),
    write: vi.fn<(text: string, callback?: () => void) => void>(),
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
  });
  return {
    terminal: createMockTerminal(),
    terminalInstances: [] as Array<ReturnType<typeof createMockTerminal>>,
    createMockTerminal,
  };
});

vi.mock('@xterm/xterm', () => ({
  Terminal: vi.fn((options: Record<string, unknown>) => {
    const instance = terminalInstances.length ? createMockTerminal() : terminal;
    instance.options = options;
    terminalInstances.push(instance);
    return instance;
  }),
}));
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: vi.fn(() => ({ fit })),
}));
vi.mock('../../themeContext', () => ({ useTheme: () => 'light' }));
vi.mock('../../config/daemon', () => ({ getDaemonToken: () => '' }));
vi.mock('@qwen-code/web-shell/daemon-react-sdk', () => ({
  useWorkspace: () => workspace,
}));
vi.mock('../../i18n', () => ({
  useI18n: () => ({
    t: (key: string, values?: Record<string, string>) =>
      ({
        'terminal.notice.exited': `Process exited with code ${values?.['exitCode'] ?? '?'}`,
        'terminal.notice.error': `Error: ${values?.['message'] ?? ''}`,
        'terminal.notice.unknownError': 'Unknown error',
        'terminal.notice.reconnecting': 'Connection lost — reconnecting…',
      })[key] ?? key,
  }),
}));

import { Terminal } from '@xterm/xterm';
import {
  releaseDetachedWebTerminal,
  releaseWebTerminal,
  TerminalPanel,
} from './TerminalPanel';

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
    terminalInstances.length = 0;
    workspace.baseUrl = 'http://localhost';
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

  function render(active = true): FakeWebSocket {
    act(() => {
      root.render(
        <TerminalPanel
          terminalId="terminal:one"
          cwd="/workspace"
          active={active}
        />,
      );
    });
    return FakeWebSocket.instances[0]!;
  }

  it('keeps binary PTY output distinct from text control frames', async () => {
    const ws = render();
    act(() => ws.open());
    act(() => {
      ws.message(
        '\x00{"type":"snapshot","replay":true,"handlesPrimaryDa":false}',
      );
      ws.message(new ArrayBuffer(0));
      terminalInstances[1]!.write.mock.calls[0]?.[1]?.();
    });
    const restored = terminalInstances[1]!;

    await act(async () => {
      ws.message(
        new TextEncoder().encode('\x00{"type":"exit","exitCode":0}').buffer,
      );
      ws.message('\x00{"type":"error","message":"denied"}');
      await Promise.resolve();
    });

    expect(restored.write).toHaveBeenCalledWith(
      '\x00{"type":"exit","exitCode":0}',
    );
    expect(restored.writeln).toHaveBeenCalledWith(
      expect.stringContaining('[Error: denied]'),
    );

    const handleInput = restored.onData.mock.calls.at(-1)?.[0];
    ws.send.mockClear();
    act(() => handleInput?.('\x00{"type":"release"}'));
    const sent = ws.send.mock.calls[0]?.[0];
    expect(ArrayBuffer.isView(sent)).toBe(true);
    expect(new TextDecoder().decode(sent as Uint8Array)).toBe(
      '\x00{"type":"release"}',
    );
  });

  it.each([4000, 4001, 4002, 4004])(
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

  it('keeps the old terminal interactive until reconnect replay finishes', async () => {
    const ws = render();
    act(() => ws.open());
    act(() => ws.closeWith(1006));

    expect(terminal.writeln).toHaveBeenCalledWith(
      expect.stringContaining('Connection lost'),
    );
    expect(terminal.dispose).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(FakeWebSocket.instances).toHaveLength(2);
    act(() => FakeWebSocket.instances[1]!.open());
    const reconnected = FakeWebSocket.instances[1]!;
    act(() => {
      reconnected.message(
        '\x00{"type":"snapshot","replay":true,"handlesPrimaryDa":true}',
      );
      reconnected.message(
        new TextEncoder().encode('history\x1b]11;?\x07').buffer,
      );
      reconnected.message(new TextEncoder().encode('live\x1b]11;?\x07').buffer);
    });
    const restored = terminalInstances[1]!;
    expect(restored.write.mock.calls.map(([text]) => text)).toEqual([
      'history\x1b]11;?\x07',
      'live\x1b]11;?\x07',
    ]);
    expect(restored.onData).not.toHaveBeenCalled();
    const oldInput = terminal.onData.mock.calls[0]![0];
    reconnected.send.mockClear();
    act(() => oldInput('k'));
    expect(new TextDecoder().decode(reconnected.send.mock.calls[0]![0])).toBe(
      'k',
    );
    expect(terminal.dispose).not.toHaveBeenCalled();

    act(() => restored.write.mock.calls[0]![1]!());
    expect(terminal.dispose).toHaveBeenCalledOnce();
    expect(restored.onData).toHaveBeenCalledOnce();
    expect(restored.parser.registerCsiHandler.mock.calls[0]![1]()).toBe(true);
    act(() => restored.onData.mock.calls[0]![0]('live reply'));
    expect(
      new TextDecoder().decode(reconnected.send.mock.calls.at(-1)![0]),
    ).toBe('live reply');
  });

  it('allows first-connection queries and leaves DA to the browser without a server responder', () => {
    const ws = render();
    act(() => {
      ws.open();
      ws.message(
        '\x00{"type":"snapshot","replay":false,"handlesPrimaryDa":false}',
      );
      ws.message(new TextEncoder().encode('\x1b[c').buffer);
    });
    const next = terminalInstances[1]!;
    expect(next.onData).toHaveBeenCalledOnce();
    expect(next.parser.registerCsiHandler.mock.calls[0]![1]()).toBe(false);
    act(() => next.onData.mock.calls[0]![0]('\x1b[?1;2c'));
    expect(new TextDecoder().decode(ws.send.mock.calls.at(-1)![0])).toBe(
      '\x1b[?1;2c',
    );
  });

  it('disposes an interrupted replay and ignores its late write callback', () => {
    const ws = render();
    act(() => {
      ws.open();
      ws.message(
        '\x00{"type":"snapshot","replay":true,"handlesPrimaryDa":true}',
      );
      ws.message(new TextEncoder().encode('history').buffer);
      ws.closeWith(1006);
    });
    const next = terminalInstances[1]!;
    expect(next.dispose).toHaveBeenCalledOnce();
    act(() => next.write.mock.calls[0]![1]!());
    expect(terminal.dispose).not.toHaveBeenCalled();
    expect(next.onData).not.toHaveBeenCalled();
  });

  it('rejects an old server that does not mark the snapshot boundary', () => {
    const ws = render();
    act(() => {
      ws.open();
      ws.message(new TextEncoder().encode('unmarked history').buffer);
    });
    expect(ws.send).toHaveBeenCalledWith('\x00{"type":"release"}');
    expect(ws.send.mock.invocationCallOrder.at(-1)).toBeLessThan(
      ws.close.mock.invocationCallOrder[0]!,
    );
    expect(ws.close).toHaveBeenCalledWith(4002, 'Terminal protocol mismatch');
    const sent = ws.send.mock.calls.length;
    act(() => releaseWebTerminal('terminal:one'));
    expect(ws.send).toHaveBeenCalledTimes(sent);
    expect(terminal.write).not.toHaveBeenCalled();
  });

  it('sends an explicit release control when the tab is closed', () => {
    const ws = render();
    act(() => ws.open());

    act(() => releaseWebTerminal('terminal:one'));

    expect(ws.send).toHaveBeenCalledWith('\x00{"type":"release"}');
  });

  it('releases a detached terminal through a release-only socket', () => {
    releaseDetachedWebTerminal(
      'http://localhost/base',
      'terminal:detached',
      '/workspace',
    );

    expect(FakeWebSocket.instances[0]?.url).toBe(
      'ws://localhost/base/terminal?terminalId=terminal%3Adetached&replay=1&cwd=%2Fworkspace&release=1',
    );
  });

  it('does not connect a restored inactive terminal until it is enabled', () => {
    act(() => {
      root.render(
        <TerminalPanel
          terminalId="terminal:one"
          cwd="/workspace"
          active={false}
          enabled={false}
        />,
      );
    });

    expect(FakeWebSocket.instances).toHaveLength(0);
    act(() => {
      root.render(
        <TerminalPanel
          terminalId="terminal:one"
          cwd="/workspace"
          active
          enabled
        />,
      );
    });
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(
      new URL(FakeWebSocket.instances[0]!.url).searchParams.has('release'),
    ).toBe(false);
  });

  it('releases a restored terminal that was never enabled', () => {
    act(() => {
      root.render(
        <TerminalPanel
          terminalId="terminal:one"
          cwd="/workspace"
          active={false}
          enabled={false}
        />,
      );
    });

    act(() => releaseWebTerminal('terminal:one'));
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(
      new URL(FakeWebSocket.instances[0]!.url).searchParams.get('release'),
    ).toBe('1');
  });

  it('releases an exited session through a release handshake', async () => {
    const ws = render();
    act(() => ws.open());
    act(() => ws.closeWith(4000));

    act(() => releaseWebTerminal('terminal:one'));

    const releaseSocket = FakeWebSocket.instances[1]!;
    expect(new URL(releaseSocket.url).searchParams.get('release')).toBe('1');
    act(() => releaseSocket.open());
    expect(releaseSocket.send).toHaveBeenCalledWith('\x00{"type":"release"}');
    act(() => releaseSocket.closeWith(4004));
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it('retries a failed release handshake a bounded number of times', async () => {
    const ws = render();
    act(() => ws.open());
    act(() => ws.closeWith(4000));
    act(() => releaseWebTerminal('terminal:one'));

    act(() => FakeWebSocket.instances[1]!.closeWith(1006));
    await act(async () => vi.advanceTimersByTimeAsync(500));

    expect(FakeWebSocket.instances).toHaveLength(3);
    expect(
      new URL(FakeWebSocket.instances[2]!.url).searchParams.get('release'),
    ).toBe('1');
  });

  it('sends the connection contract and initial terminal size', () => {
    const ws = render();

    expect(ws.binaryType).toBe('arraybuffer');
    const url = new URL(ws.url);
    expect(url.pathname).toBe('/terminal');
    expect(url.searchParams.get('terminalId')).toBe('terminal:one');
    expect(url.searchParams.get('cwd')).toBe('/workspace');
    expect(url.searchParams.get('replay')).toBe('1');

    act(() => ws.open());
    expect(ws.send).toHaveBeenCalledWith(
      '\x00{"type":"resize","cols":80,"rows":24}',
    );
  });

  it('uses the configured daemon origin and base path', () => {
    workspace.baseUrl = 'https://daemon.example/qwen/';
    const ws = render();
    const url = new URL(ws.url);

    expect(url.origin).toBe('wss://daemon.example');
    expect(url.pathname).toBe('/qwen/terminal');
  });

  it('does not reconnect after an exit control frame', async () => {
    const ws = render();
    act(() => ws.open());

    act(() => ws.message('\x00{"type":"exit","exitCode":0}'));
    act(() => ws.closeWith(1006));
    await act(async () => vi.advanceTimersByTimeAsync(30_000));

    expect(terminal.writeln).toHaveBeenCalledWith(
      expect.stringContaining('Process exited with code 0'),
    );
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('restores focus when its terminal tab becomes active', () => {
    const ws = render(false);
    act(() => ws.open());
    terminal.focus.mockClear();
    terminal.refresh.mockClear();
    fit.mockClear();
    ws.send.mockClear();

    act(() => {
      root.render(
        <TerminalPanel terminalId="terminal:one" cwd="/workspace" active />,
      );
    });

    expect(terminal.focus).toHaveBeenCalledOnce();
    expect(terminal.refresh).toHaveBeenCalledWith(0, 23);
    expect(fit).toHaveBeenCalledOnce();
    expect(ws.send).toHaveBeenCalledWith(
      '\x00{"type":"resize","cols":80,"rows":24}',
    );
  });

  it('blurs and suppresses input while its terminal tab is inactive', () => {
    const ws = render();
    act(() => ws.open());
    const handleInput = terminal.onData.mock.calls.at(-1)?.[0];

    act(() => {
      root.render(
        <TerminalPanel
          terminalId="terminal:one"
          cwd="/workspace"
          active={false}
        />,
      );
    });
    ws.send.mockClear();
    act(() => handleInput?.('hidden input'));

    expect(terminal.blur).toHaveBeenCalledOnce();
    expect(ws.send).not.toHaveBeenCalled();
  });

  it('passes a visible selection background to xterm in the light theme', () => {
    // xterm falls back to white rgba(255,255,255,0.3) for an unset
    // selectionBackground, which blends into the white terminal background
    // and leaves text selection invisible in the light theme.
    render();

    expect(Terminal).toHaveBeenCalledWith(
      expect.objectContaining({
        theme: expect.objectContaining({ selectionBackground: '#bdd8fe' }),
      }),
    );
  });
});
