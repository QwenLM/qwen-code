/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { DaemonClient } from '../../src/daemon/DaemonClient.js';
import type { DaemonEvent } from '../../src/daemon/types.js';
import type { BridgeState } from '../../src/daemon-mcp/serve-bridge/types.js';
import {
  createPromptCollector,
  startEventStream,
  stopEventStream,
} from '../../src/daemon-mcp/serve-bridge/sse.js';

afterEach(() => vi.restoreAllMocks());

function frame(text: string, meta?: Record<string, unknown>): DaemonEvent {
  return {
    v: 1,
    type: 'session_update',
    data: {
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text },
        ...(meta ? { _meta: meta } : {}),
      },
    },
  };
}

async function collect(frames: DaemonEvent[]) {
  const state: BridgeState = {
    client: new DaemonClient({ baseUrl: 'http://127.0.0.1:4170' }),
    daemonUrl: 'http://127.0.0.1:4170',
    token: undefined,
    defaultSessionId: 'session',
    workspaceCwd: undefined,
    eventStreams: new Map(),
    allowGlobalScope: false,
  };
  let begin!: () => void;
  const ready = new Promise<void>((resolve) => {
    begin = resolve;
  });
  let drained!: () => void;
  const allFrames = new Promise<void>((resolve) => {
    drained = resolve;
  });
  vi.spyOn(state.client, 'subscribeEvents').mockImplementation(
    async function* (_sessionId, options) {
      await ready;
      for (const event of frames) yield event;
      drained();
      await new Promise<void>((resolve) => {
        options?.signal?.addEventListener('abort', () => resolve(), {
          once: true,
        });
      });
    },
  );
  startEventStream(state, 'session');
  const collector = createPromptCollector();
  state.eventStreams.get('session')!.activeCollector = collector;
  begin();
  await allFrames;
  return { state, collector };
}

// These controls pin legacy collectors without a promptId; nonblocking prompt
// completion and pre-ack events are covered in serve-bridge.prompt-order.test.ts.
describe('serve-bridge legacy output without prompt IDs', () => {
  it.each([
    { usage: { input: 1, output: 2 }, durationMs: 1 },
    { stopHookLoop: { phase: 'started' } },
    { goalStatus: { active: true } },
    { goalState: { status: 'active' } },
  ])('retains text following intermediate metadata %j', async (meta) => {
    const { state, collector } = await collect([
      frame('round one'),
      frame('', meta),
      frame('final answer'),
    ]);
    try {
      expect(collector.texts.join('')).toBe('round onefinal answer');
    } finally {
      stopEventStream(state, 'session');
    }
  });

  it('reports a stream stopped after intermediate usage as interrupted', async () => {
    const { state, collector } = await collect([
      frame('round one'),
      frame('', { usage: { input: 1, output: 2 } }),
    ]);
    stopEventStream(state, 'session');
    expect(collector.interrupted).toBe(true);
    expect(collector.texts).toEqual(['round one']);
  });

  it('reports a stop before any metadata as interrupted', async () => {
    const { state, collector } = await collect([frame('partial')]);
    stopEventStream(state, 'session');
    expect(collector.resolved).toBe(true);
    expect(collector.interrupted).toBe(true);
  });
});
