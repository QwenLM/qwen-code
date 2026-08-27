/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolDispatcher } from './dispatcher.js';
import type { ToolContext, ToolHandler } from './dispatcher.js';

function makeContext(
  transcript: ToolContext['activeTranscript'] = [],
): ToolContext {
  return { activeTranscript: transcript };
}

function makeDispatcher(
  handlers: Record<string, ToolHandler>,
  timeoutMs?: number,
): ToolDispatcher {
  return new ToolDispatcher({
    handlers: new Map(Object.entries(handlers)),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('ToolDispatcher', () => {
  it('answers an unregistered tool with an error receipt instead of stalling', async () => {
    const dispatcher = makeDispatcher({});

    const result = await dispatcher.dispatch('mystery', '{}', makeContext());

    expect(result.ok).toBe(false);
    const receipt = JSON.parse(result.receipt) as {
      status: string;
      note: string;
    };
    expect(receipt.status).toBe('error');
    expect(receipt.note).toContain('No handler');
    expect(receipt.note).toContain('mystery');
  });

  it.each([
    ['invalid JSON', '{not json'],
    ['empty string', ''],
    ['whitespace only', '   '],
    ['a JSON array', '[1, 2, 3]'],
    ['a JSON scalar', '"hello"'],
  ])('degrades %s arguments to an empty object', async (_label, raw) => {
    const seen: Array<Record<string, unknown>> = [];
    const dispatcher = makeDispatcher({
      echo: (args) => {
        seen.push(args);
        return { status: 'ok' };
      },
    });

    const result = await dispatcher.dispatch('echo', raw, makeContext());

    expect(result.ok).toBe(true);
    expect(seen).toEqual([{}]);
  });

  it('passes well-formed JSON object arguments through to the handler', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const dispatcher = makeDispatcher({
      echo: (args) => {
        seen.push(args);
        return { status: 'ok' };
      },
    });

    await dispatcher.dispatch(
      'echo',
      '{"sessionHandle":"session_1","count":2}',
      makeContext(),
    );

    expect(seen).toEqual([{ sessionHandle: 'session_1', count: 2 }]);
  });

  it('serializes a successful handler result as the JSON receipt', async () => {
    const outcome = { status: 'accepted', jobHandle: 'job_1', queued: false };
    const dispatcher = makeDispatcher({
      start_job: () => outcome,
    });

    const result = await dispatcher.dispatch('start_job', '{}', makeContext());

    expect(result.ok).toBe(true);
    expect(result.receipt).toBe(JSON.stringify(outcome));
  });

  it('awaits async handlers before building the receipt', async () => {
    const dispatcher = makeDispatcher({
      async_tool: async () => ({ status: 'done' }),
    });

    const result = await dispatcher.dispatch('async_tool', '{}', makeContext());

    expect(result.ok).toBe(true);
    expect(JSON.parse(result.receipt)).toEqual({ status: 'done' });
  });

  it('turns a thrown handler error into an error receipt with the message truncated to 300 chars', async () => {
    const longMessage = 'x'.repeat(400);
    const dispatcher = makeDispatcher({
      boom: () => {
        throw new Error(longMessage);
      },
    });

    const result = await dispatcher.dispatch('boom', '{}', makeContext());

    expect(result.ok).toBe(false);
    const receipt = JSON.parse(result.receipt) as {
      status: string;
      note: string;
    };
    expect(receipt.status).toBe('error');
    expect(receipt.note).toBe(longMessage.slice(0, 300));
    expect(receipt.note).toHaveLength(300);
  });

  it('falls back to a generic note for non-Error and empty-message throws', async () => {
    const dispatcher = makeDispatcher({
      raw_throw: () => {
        // A non-Error throw (object, not string — the lint bans literals).
        throw { reason: 'not an error object' };
      },
      empty_message: () => {
        throw new Error('');
      },
    });

    for (const name of ['raw_throw', 'empty_message']) {
      const result = await dispatcher.dispatch(name, '{}', makeContext());
      expect(result.ok).toBe(false);
      expect(JSON.parse(result.receipt)).toEqual({
        status: 'error',
        note: 'the tool failed',
      });
    }
  });

  it('times out a hung handler and returns the timeout receipt', async () => {
    vi.useFakeTimers();
    const dispatcher = makeDispatcher(
      {
        hang: () => new Promise<Record<string, unknown>>(() => {}),
      },
      50,
    );

    const pending = dispatcher.dispatch('hang', '{}', makeContext());
    await vi.advanceTimersByTimeAsync(50);
    const result = await pending;

    expect(result.ok).toBe(false);
    expect(JSON.parse(result.receipt)).toEqual({
      status: 'error',
      note: 'tool handler timed out',
    });
  });

  it('does not time out a handler that resolves before the deadline', async () => {
    vi.useFakeTimers();
    const dispatcher = makeDispatcher(
      {
        quick: () => ({ status: 'ok' }),
      },
      50,
    );

    const result = await dispatcher.dispatch('quick', '{}', makeContext());

    expect(result.ok).toBe(true);
    expect(JSON.parse(result.receipt)).toEqual({ status: 'ok' });
  });

  it('threads ctx.activeTranscript through to the handler untouched', async () => {
    const transcript = [
      { role: 'user' as const, text: 'run the tests' },
      { role: 'assistant' as const, text: 'Starting them now.' },
    ];
    let received: ToolContext | undefined;
    const dispatcher = makeDispatcher({
      capture: (_args, ctx) => {
        received = ctx;
        return { status: 'ok' };
      },
    });

    await dispatcher.dispatch('capture', '{}', makeContext(transcript));

    expect(received?.activeTranscript).toBe(transcript);
  });
});
