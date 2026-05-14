/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import type { AnyMessage } from '@agentclientprotocol/sdk';
import { createInMemoryChannel } from './inMemoryChannel.js';

/**
 * Push one JSON-RPC notification onto a `Stream.writable`. The SDK's
 * `ndJsonStream` encodes the message + appends `\n` so the matching
 * decoder on the other side can frame it.
 */
async function send(
  writable: WritableStream<AnyMessage>,
  msg: AnyMessage,
): Promise<void> {
  const writer = writable.getWriter();
  try {
    await writer.write(msg);
  } finally {
    writer.releaseLock();
  }
}

/** Read the next single message off a `Stream.readable`. */
async function recvOne(
  readable: ReadableStream<AnyMessage>,
): Promise<AnyMessage> {
  const reader = readable.getReader();
  try {
    const { value, done } = await reader.read();
    if (done || !value) {
      throw new Error('stream closed before a frame arrived');
    }
    return value;
  } finally {
    reader.releaseLock();
  }
}

describe('createInMemoryChannel', () => {
  it('round-trips a frame from client to agent', async () => {
    const { clientStream, agentStream } = createInMemoryChannel();
    const sent: AnyMessage = {
      jsonrpc: '2.0',
      method: 'ping',
      params: { n: 1 },
    };
    await send(clientStream.writable, sent);
    const received = await recvOne(agentStream.readable);
    expect(received).toEqual(sent);
  });

  it('round-trips a frame from agent to client', async () => {
    const { clientStream, agentStream } = createInMemoryChannel();
    const sent: AnyMessage = {
      jsonrpc: '2.0',
      method: 'pong',
      params: { reply: true },
    };
    await send(agentStream.writable, sent);
    const received = await recvOne(clientStream.readable);
    expect(received).toEqual(sent);
  });

  it('preserves order across multiple frames in one direction', async () => {
    const { clientStream, agentStream } = createInMemoryChannel();
    const writer = clientStream.writable.getWriter();
    for (let i = 1; i <= 3; i++) {
      await writer.write({
        jsonrpc: '2.0',
        method: 'tick',
        params: { i },
      });
    }
    writer.releaseLock();

    const reader = agentStream.readable.getReader();
    const out: AnyMessage[] = [];
    for (let i = 0; i < 3; i++) {
      const { value, done } = await reader.read();
      if (done || !value) throw new Error('unexpected close');
      out.push(value);
    }
    reader.releaseLock();

    expect(out.map((m) => (m as { params: { i: number } }).params.i)).toEqual([
      1, 2, 3,
    ]);
  });

  it('isolates client→agent direction (client write does not echo to client.readable)', async () => {
    // Sanity check that the channel is truly paired. A buggy
    // implementation that aliased `ab` to both ends would still pass
    // the round-trip tests above for one frame but echo the writer's
    // own messages back on its own readable.
    const { clientStream, agentStream } = createInMemoryChannel();
    await send(clientStream.writable, {
      jsonrpc: '2.0',
      method: 'client-only',
    });

    const onAgent = await recvOne(agentStream.readable);
    expect((onAgent as { method: string }).method).toBe('client-only');

    // Client's own readable must NOT see it. Race a fresh read against
    // a short timeout — if the channel is correctly paired the read
    // never resolves on its own.
    //
    // The read promise stays pending while the timeout wins; releasing
    // the reader's lock in `finally` then causes that pending read to
    // reject per Web Streams spec. Attach a rejection handler so the
    // post-`releaseLock` rejection doesn't surface as an unhandled
    // rejection / flaky test signal — the rejection itself isn't a
    // failure here, it's just the cleanup path settling.
    const reader = clientStream.readable.getReader();
    try {
      const winner = await Promise.race([
        reader.read().then(
          () => 'leaked' as const,
          () => null,
        ),
        new Promise<'isolated'>((res) => setTimeout(() => res('isolated'), 50)),
      ]);
      expect(winner).toBe('isolated');
    } finally {
      reader.releaseLock();
    }
  });

  it('isolates agent→client direction (agent write does not echo to agent.readable)', async () => {
    // Symmetric counterpart of the previous test — closes the obvious
    // "wired one direction correctly but not the other" failure mode.
    // Same `releaseLock`-causes-pending-read-to-reject handling as the
    // previous test; see comment there.
    const { clientStream, agentStream } = createInMemoryChannel();
    await send(agentStream.writable, {
      jsonrpc: '2.0',
      method: 'agent-only',
    });

    const onClient = await recvOne(clientStream.readable);
    expect((onClient as { method: string }).method).toBe('agent-only');

    const reader = agentStream.readable.getReader();
    try {
      const winner = await Promise.race([
        reader.read().then(
          () => 'leaked' as const,
          () => null,
        ),
        new Promise<'isolated'>((res) => setTimeout(() => res('isolated'), 50)),
      ]);
      expect(winner).toBe('isolated');
    } finally {
      reader.releaseLock();
    }
  });
});
