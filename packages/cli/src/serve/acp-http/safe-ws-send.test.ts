/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { safeWsSend } from './safe-ws-send.js';

// Minimal WebSocket stand-in: just the readyState + send() the guard touches,
// plus the per-instance OPEN constant it compares against.
function fakeWs(readyState: number) {
  const send = vi.fn();
  return {
    ws: { readyState, OPEN: 1, send } as unknown as WebSocket,
    send,
  };
}

describe('safeWsSend', () => {
  it('sends when the socket is OPEN', () => {
    const { ws, send } = fakeWs(1); // OPEN
    safeWsSend(ws, 'hello');
    expect(send).toHaveBeenCalledWith('hello');
  });

  it('does not throw when OPEN send fails', () => {
    const { ws, send } = fakeWs(1); // OPEN
    send.mockImplementationOnce(() => {
      throw new Error('socket write failed');
    });
    expect(() => safeWsSend(ws, 'hello', 'CDP')).not.toThrow();
  });

  it('drops (no send, no throw) when the socket is CLOSING', () => {
    const { ws, send } = fakeWs(2); // CLOSING
    expect(() => safeWsSend(ws, 'late', 'CDP')).not.toThrow();
    expect(send).not.toHaveBeenCalled();
  });

  it('drops (no send, no throw) when the socket is CLOSED', () => {
    const { ws, send } = fakeWs(3); // CLOSED
    expect(() => safeWsSend(ws, 'late')).not.toThrow();
    expect(send).not.toHaveBeenCalled();
  });
});
