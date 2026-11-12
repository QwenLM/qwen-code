/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  SendMessageType,
  type LlmClient,
  type ServerLlmStreamEvent,
} from '@qwen-code/qwen-code-core';
import { sharedModelRound } from './shared-model-round.js';

const call = (callId: string) => ({
  type: 'tool_call_request',
  value: { callId, name: 'read_file', args: {} },
});

/** A client whose one stream yields `events`, noting how far it got. */
function fakeClient(events: Array<Record<string, unknown> | Error>) {
  const progress = { pulled: 0, closed: false };
  const sendMessageStream = vi.fn(async function* () {
    try {
      for (const event of events) {
        progress.pulled++;
        if (event instanceof Error) throw event;
        yield event;
      }
    } finally {
      progress.closed = true;
    }
  });
  return {
    client: { sendMessageStream } as unknown as LlmClient,
    sendMessageStream,
    progress,
  };
}

const round = {
  parts: [{ text: 'hi' }],
  promptId: 'p1',
  options: { type: SendMessageType.UserQuery },
};

describe('sharedModelRound', () => {
  it('sends the round as given and hands over its events in order', async () => {
    const { client, sendMessageStream } = fakeClient([
      { type: 'content', value: 'a' },
      call('c1'),
      { type: 'finished', value: {} },
    ]);
    const signal = new AbortController().signal;
    const shared = sharedModelRound(client, round, signal);
    const seen: ServerLlmStreamEvent[] = [];
    for await (const event of shared.events) seen.push(event);
    expect(sendMessageStream).toHaveBeenCalledExactlyOnceWith(
      round.parts,
      signal,
      'p1',
      round.options,
    );
    expect(seen.map((event) => event.type)).toEqual([
      'content',
      'tool_call_request',
      'finished',
    ]);
    expect(shared.result()).toEqual({ calls: [call('c1').value] });
  });

  it('reads the next event only once the turn took the one before', async () => {
    const { client, progress } = fakeClient([
      { type: 'content', value: 'a' },
      { type: 'content', value: 'b' },
    ]);
    const events = sharedModelRound(
      client,
      round,
      new AbortController().signal,
    ).events[Symbol.asyncIterator]();
    await events.next();
    // Give the round every chance to read ahead.
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(progress.pulled).toBe(1);
    await events.next();
    expect(progress.pulled).toBe(2);
  });

  it('keeps only the calls of the attempt a retry replaced them with', async () => {
    const { client } = fakeClient([
      call('stale'),
      { type: 'retry' },
      call('fresh'),
    ]);
    const shared = sharedModelRound(
      client,
      round,
      new AbortController().signal,
    );
    for await (const _ of shared.events) {
      // drain
    }
    expect(shared.result()?.calls.map((c) => c.callId)).toEqual(['fresh']);
  });

  it('reports the stop reason of a round that detected a loop', async () => {
    const { client } = fakeClient([call('c1'), { type: 'loop_detected' }]);
    const shared = sharedModelRound(
      client,
      round,
      new AbortController().signal,
    );
    for await (const _ of shared.events) {
      // drain
    }
    expect(shared.result()).toEqual({
      calls: [call('c1').value],
      stop: 'loop_detected',
    });
  });

  it("closes the client's stream when the turn stops reading", async () => {
    const { client, progress } = fakeClient([
      { type: 'content', value: 'a' },
      { type: 'content', value: 'b' },
    ]);
    const shared = sharedModelRound(
      client,
      round,
      new AbortController().signal,
    );
    for await (const _ of shared.events) break;
    expect(progress.closed).toBe(true);
    expect(progress.pulled).toBe(1);
    expect(shared.result()).toBeUndefined();
  });

  it("rethrows the client's error", async () => {
    const { client } = fakeClient([
      { type: 'content', value: 'a' },
      new Error('provider failed'),
    ]);
    const shared = sharedModelRound(
      client,
      round,
      new AbortController().signal,
    );
    const seen: string[] = [];
    await expect(
      (async () => {
        for await (const event of shared.events) seen.push(event.type);
      })(),
    ).rejects.toThrow('provider failed');
    expect(seen).toEqual(['content']);
    expect(shared.result()).toBeUndefined();
  });
});
