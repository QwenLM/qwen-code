/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, expect, it, vi } from 'vitest';
import { DaemonClient } from '../../src/daemon/DaemonClient.js';
import type { DaemonEvent } from '../../src/daemon/types.js';
import { agentTools } from '../../src/daemon-mcp/serve-bridge/tools/agent.js';
import {
  interruptPromptCollector,
  startEventStream,
  stopEventStream,
} from '../../src/daemon-mcp/serve-bridge/sse.js';
import type { BridgeState } from '../../src/daemon-mcp/serve-bridge/types.js';

afterEach(() => vi.restoreAllMocks());

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function textFrame(text: string, meta?: Record<string, unknown>): DaemonEvent {
  return {
    v: 1,
    type: 'session_update',
    promptId: 'own-prompt',
    data: {
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text },
        ...(meta ? { _meta: meta } : {}),
      },
    },
  };
}

function terminal(promptId = 'own-prompt'): DaemonEvent {
  return {
    v: 1,
    type: 'turn_complete',
    promptId,
    data: { promptId, stopReason: 'end_turn' },
  };
}

function start(
  options: {
    foreignTerminal?: boolean;
    acceptAfterTerminal?: boolean;
    endAfterTerminal?: boolean;
    endBeforeTerminal?: boolean;
    turnError?: boolean;
    holdConnection?: boolean;
    maxPendingPromptsPerSession?: number;
  } = {},
) {
  const middle = deferred();
  const tail = deferred();
  const terminalEmitted = deferred();
  const connection = deferred();
  const fetch = vi.fn(async () => {
    if (options.acceptAfterTerminal) {
      await terminalEmitted.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    return new Response(
      JSON.stringify({ promptId: 'own-prompt', lastEventId: 0 }),
      { status: 202, headers: { 'content-type': 'application/json' } },
    );
  });
  const client = new DaemonClient({
    baseUrl: 'http://127.0.0.1:4170',
    fetch,
    maxPendingPromptsPerSession: options.maxPendingPromptsPerSession,
  });
  const state: BridgeState = {
    client,
    daemonUrl: 'http://127.0.0.1:4170',
    token: undefined,
    defaultSessionId: 'session',
    workspaceCwd: undefined,
    eventStreams: new Map(),
    allowGlobalScope: false,
  };
  vi.spyOn(client, 'subscribeEvents').mockImplementation(
    async function* (_sessionId, opts) {
      if (opts?.lastEventId !== undefined) {
        // DaemonClient.prompt's temporary subscription can outrun the persistent one.
        await middle.promise;
        yield terminal();
        return;
      }
      if (options.holdConnection) await connection.promise;
      if (opts?.signal?.aborted) return;
      opts?.onSseStreamAccepted?.('stream');
      while (!state.eventStreams.get('session')?.activeCollector) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      if (options.foreignTerminal) {
        yield terminal('other-prompt');
        yield { ...textFrame('other answer'), promptId: 'other-prompt' };
      }
      yield textFrame('round one');
      yield textFrame('', { usage: { input: 1, output: 2 } });
      middle.resolve();
      await tail.promise;
      if (options.endBeforeTerminal) {
        terminalEmitted.resolve();
        return;
      }
      yield textFrame('final answer');
      yield options.turnError
        ? {
            v: 1,
            type: 'turn_error',
            data: {
              promptId: 'own-prompt',
              message: 'controlled turn failure',
            },
          }
        : terminal();
      terminalEmitted.resolve();
      if (options.endAfterTerminal) return;
      await new Promise<void>((resolve) => {
        if (opts?.signal?.aborted) resolve();
        else
          opts?.signal?.addEventListener('abort', () => resolve(), {
            once: true,
          });
      });
    },
  );
  startEventStream(state, 'session');
  let settled = false;
  const result = agentTools(state)
    .find((entry) => entry.name === 'prompt')!
    .handler({ prompt: 'test' }, undefined)
    .then((value: unknown) => {
      settled = true;
      return value as { content: Array<{ text: string }>; isError?: boolean };
    });
  return {
    state,
    middle,
    tail,
    connection,
    fetch,
    result,
    settled: () => settled,
  };
}

it.each([false, true])(
  'waits for its persistent stream terminal after intermediate metadata (foreign terminal: %s)',
  async (foreignTerminal) => {
    const run = start({ foreignTerminal });
    try {
      await run.middle.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(run.settled()).toBe(false);
      run.tail.resolve();
      const result = await run.result;
      expect(result.isError).not.toBe(true);
      expect(JSON.parse(result.content[0]!.text)).toMatchObject({
        response: 'round onefinal answer',
        stop_reason: 'end_turn',
      });
    } finally {
      run.tail.resolve();
      await run.result;
      stopEventStream(run.state, 'session');
    }
  },
);

it('keeps a matching terminal received before the 202 response', async () => {
  const run = start({ acceptAfterTerminal: true });
  try {
    await run.middle.promise;
    run.tail.resolve();
    const result = await run.result;
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({
      response: 'round onefinal answer',
      stop_reason: 'end_turn',
    });
  } finally {
    run.tail.resolve();
    await run.result;
    stopEventStream(run.state, 'session');
  }
});

it.each([false, true])(
  'preserves stream closure ordering before the 202 response (completed: %s)',
  async (completed) => {
    const run = start({
      acceptAfterTerminal: true,
      endAfterTerminal: completed,
      endBeforeTerminal: !completed,
    });
    try {
      await run.middle.promise;
      run.tail.resolve();
      const result = await run.result;
      const payload = JSON.parse(result.content[0]!.text);
      if (completed) {
        expect(result.isError).not.toBe(true);
        expect(payload).toMatchObject({
          response: 'round onefinal answer',
          stop_reason: 'end_turn',
        });
      } else {
        expect(result.isError).toBe(true);
        expect(payload).toMatchObject({
          response: 'round one',
          stop_reason: 'interrupted',
        });
      }
    } finally {
      run.tail.resolve();
      await run.result;
      stopEventStream(run.state, 'session');
    }
  },
);

it('reports the matching turn error after intermediate usage', async () => {
  const run = start({ turnError: true });
  try {
    await run.middle.promise;
    run.tail.resolve();
    const result = await run.result;
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('controlled turn failure');
  } finally {
    run.tail.resolve();
    await run.result;
    stopEventStream(run.state, 'session');
  }
});

it('waits for the persistent subscription to be accepted before admitting a prompt', async () => {
  const run = start({ holdConnection: true });
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(run.fetch).not.toHaveBeenCalled();
    run.connection.resolve();
    await run.middle.promise;
    run.tail.resolve();
    expect((await run.result).isError).not.toBe(true);
  } finally {
    run.connection.resolve();
    run.tail.resolve();
    await run.result;
    stopEventStream(run.state, 'session');
  }
});

it('rejects a prompt stopped before its held stream connection is accepted', async () => {
  const run = start({ holdConnection: true });
  const stream = run.state.eventStreams.get('session')!;
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(run.fetch).not.toHaveBeenCalled();
    stopEventStream(run.state, 'session');
    run.connection.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(run.fetch).not.toHaveBeenCalled();
    expect(run.settled()).toBe(true);
    const result = await run.result;
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain(
      'SSE stream closed before the prompt could start.',
    );
  } finally {
    run.connection.resolve();
    run.tail.resolve();
    if (stream.activeCollector)
      interruptPromptCollector(stream.activeCollector);
    await run.result;
    stopEventStream(run.state, 'session');
  }
});

it.each([false, true])(
  'releases the prompt slot before another turn on the same session (failed: %s)',
  async (turnError) => {
    const run = start({ turnError, maxPendingPromptsPerSession: 1 });
    try {
      await run.middle.promise;
      run.tail.resolve();
      const first = await run.result;
      expect(first.isError === true).toBe(turnError);
      const nextPrompt = vi
        .spyOn(run.state.client, 'promptNonBlocking')
        .mockRejectedValueOnce(new Error('second prompt reached the daemon'));
      const second = await agentTools(run.state)
        .find((entry) => entry.name === 'prompt')!
        .handler({ prompt: 'second turn' }, undefined);
      expect(nextPrompt).toHaveBeenCalledOnce();
      expect(second.isError).toBe(true);
      expect(second.content[0]!.text).toContain(
        'second prompt reached the daemon',
      );
    } finally {
      run.tail.resolve();
      await run.result;
      stopEventStream(run.state, 'session');
    }
  },
);
