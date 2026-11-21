/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { DaemonClient } from '../../src/daemon/DaemonClient.js';
import type { DaemonEvent } from '../../src/daemon/types.js';
import { agentTools } from '../../src/daemon-mcp/serve-bridge/tools/agent.js';
import {
  createPromptCollector,
  startEventStream,
  stopEventStream,
} from '../../src/daemon-mcp/serve-bridge/sse.js';
import type { BridgeState } from '../../src/daemon-mcp/serve-bridge/types.js';

const finalChunk: DaemonEvent = {
  v: 1,
  type: 'session_update',
  data: {
    update: {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'completed answer' },
      _meta: {},
    },
  },
};

async function start(events: DaemonEvent[], end = false) {
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const client = {
    async *subscribeEvents() {
      yield* events;
      if (!end) await pending;
    },
    async cancel() {},
  } as unknown as DaemonClient;
  const state: BridgeState = {
    client,
    daemonUrl: 'http://daemon',
    token: undefined,
    defaultSessionId: 'session',
    workspaceCwd: undefined,
    eventStreams: new Map(),
    allowGlobalScope: false,
  };
  startEventStream(state, 'session');
  const stream = state.eventStreams.get('session')!;
  const collector = createPromptCollector();
  stream.activeCollector = collector;
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  return { state, collector, finish };
}

describe('completed serve bridge prompt collectors', () => {
  it('ignores text after the terminal chunk', async () => {
    const { collector, finish } = await start([
      finalChunk,
      {
        v: 1,
        type: 'session_update',
        data: {
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'next turn' },
          },
        },
      },
    ]);
    try {
      expect(collector.texts).toEqual(['completed answer']);
    } finally {
      finish();
    }
  });

  it('keeps successful completion when the stream ends after its final chunk', async () => {
    const { collector } = await start([finalChunk], true);
    expect(collector.resolved).toBe(true);
    expect(collector.interrupted).toBeUndefined();
  });

  it('keeps successful completion when a later event reports an error', async () => {
    const { collector, finish } = await start([
      finalChunk,
      {
        v: 1,
        type: 'session_update',
        data: { update: { sessionUpdate: 'error' } },
      },
    ]);
    try {
      expect(collector.interrupted).toBeUndefined();
    } finally {
      finish();
    }
  });

  it('does not turn a completed prompt into an interruption during stream cleanup', async () => {
    const { state, collector, finish } = await start([finalChunk]);
    try {
      stopEventStream(state, 'session');
      expect(collector.interrupted).toBeUndefined();
    } finally {
      finish();
    }
  });

  it('does not overwrite a completed collector when a late cancel arrives', async () => {
    const { state, collector, finish } = await start([finalChunk]);
    try {
      const cancel = agentTools(state).find(
        (entry) => entry.name === 'prompt_cancel',
      )!;
      await cancel.handler({}, undefined);
      expect(collector.interrupted).toBeUndefined();
    } finally {
      finish();
    }
  });

  it('still interrupts an unfinished collector when its stream ends', async () => {
    const { collector } = await start([], true);
    expect(collector.resolved).toBe(true);
    expect(collector.interrupted).toBe(true);
  });
});
