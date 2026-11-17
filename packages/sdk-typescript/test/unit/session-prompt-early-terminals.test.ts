/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { DaemonClient } from '../../src/daemon/DaemonClient.js';
import { DaemonSessionClient } from '../../src/daemon/DaemonSessionClient.js';
import { DaemonHttpError } from '../../src/daemon/DaemonHttpError.js';
import type { DaemonEvent } from '../../src/daemon/types.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function setup(limit = 1) {
  const requests: Array<ReturnType<typeof deferred<Response>>> = [];
  const callers: AbortController[] = [];
  const outcomes: Array<Promise<unknown>> = [];
  const observed = new Map<number, () => void>();
  const ready = deferred<void>();
  const subscription = new AbortController();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let nextEventId = 0;
  const client = new DaemonClient({
    baseUrl: 'https://daemon.example',
    maxPendingPromptsPerSession: limit,
    fetch: async (url, init = {}) => {
      if (String(url).includes('/events')) {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(streamController) {
              controller = streamController;
              ready.resolve();
            },
          }),
          { headers: { 'Content-Type': 'text/event-stream' } },
        );
      }
      if (String(url).endsWith('/prompt')) {
        const response = deferred<Response>();
        requests.push(response);
        const signal = init.signal;
        const onAbort = () => response.reject(signal!.reason);
        signal?.addEventListener('abort', onAbort, { once: true });
        try {
          signal?.throwIfAborted();
          return await response.promise;
        } finally {
          signal?.removeEventListener('abort', onAbort);
        }
      }
      if (String(url).endsWith('/cancel')) {
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected request: ${url}`);
    },
  });
  const session = new DaemonSessionClient({
    client,
    session: {
      sessionId: 'session-a',
      workspaceCwd: '/workspace',
      attached: true,
    },
  });
  const reading = (async () => {
    for await (const event of session.events({ signal: subscription.signal })) {
      if (event.id !== undefined) observed.get(event.id)?.();
    }
  })();
  await ready.promise;

  return {
    session,
    requests,
    admissions: () =>
      (
        session as unknown as {
          pendingPromptAdmissions: Set<{ events: Map<string, DaemonEvent> }>;
        }
      ).pendingPromptAdmissions,
    async prompt() {
      const caller = new AbortController();
      callers.push(caller);
      const pending = session.prompt(
        { prompt: [{ type: 'text', text: 'hello' }] },
        caller.signal,
      );
      const outcome = pending.catch((error: unknown) => error);
      outcomes.push(outcome);
      // Admission can dispatch synchronously before this helper resumes.
      await vi.waitFor(() => expect(requests.length).toBe(callers.length));
      return { pending, outcome, caller };
    },
    accept(index: number, promptId: string) {
      requests[index]!.resolve(
        Response.json({ promptId, lastEventId: 0 }, { status: 202 }),
      );
    },
    async waitForAcknowledgement(promptId: string) {
      await vi.waitFor(() =>
        expect(
          (
            session as unknown as { _pendingPrompts: Map<string, unknown> }
          )._pendingPrompts.has(promptId),
        ).toBe(true),
      );
    },
    async send(
      promptId: string,
      type: 'turn_complete' | 'turn_error' = 'turn_complete',
    ) {
      const id = ++nextEventId;
      const consumed = new Promise<void>((resolve) =>
        observed.set(id, resolve),
      );
      const event: DaemonEvent = {
        v: 1,
        id,
        type,
        data: { promptId, stopReason: 'end_turn', message: 'provider failed' },
      };
      controller.enqueue(
        new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`),
      );
      await consumed;
      observed.delete(id);
    },
    async endStream() {
      controller.close();
      await reading;
    },
    async close() {
      for (const caller of callers) caller.abort();
      subscription.abort();
      await Promise.all(outcomes);
      await reading;
      client.transport.dispose();
    },
  };
}

describe('session prompt terminals received before acknowledgement', () => {
  it.each(['turn_complete', 'turn_error'] as const)(
    'settles an early %s and releases the prompt admission slot',
    async (type) => {
      const harness = await setup();
      try {
        const first = await harness.prompt();
        await harness.send('prompt-a', type);
        harness.accept(0, 'prompt-a');
        let outcome: unknown;
        void first.outcome.then((value) => {
          outcome = value;
        });
        await vi.waitFor(() => expect(outcome).toBeDefined(), { timeout: 200 });
        if (type === 'turn_complete') {
          expect(outcome).toEqual({ stopReason: 'end_turn' });
        } else {
          expect(outcome).toBeInstanceOf(DaemonHttpError);
          expect(outcome).toHaveProperty('message', 'provider failed');
        }
        const next = await harness.prompt();
        harness.accept(1, 'prompt-b');
        await harness.waitForAcknowledgement('prompt-b');
        await harness.send('prompt-b');
        expect(await next.outcome).toEqual({ stopReason: 'end_turn' });
      } finally {
        await harness.close();
      }
    },
  );

  it('ignores unrelated early terminals and waits for the accepted id', async () => {
    const harness = await setup();
    try {
      const prompt = await harness.prompt();
      await harness.send('another-client');
      harness.accept(0, 'prompt-a');
      await harness.waitForAcknowledgement('prompt-a');
      await harness.send('prompt-a');
      expect(await prompt.outcome).toEqual({ stopReason: 'end_turn' });
    } finally {
      await harness.close();
    }
  });

  it('correlates concurrent admissions acknowledged in reverse order', async () => {
    const harness = await setup(2);
    try {
      const first = await harness.prompt();
      const second = await harness.prompt();
      await harness.send('prompt-a');
      await harness.send('prompt-b', 'turn_error');
      harness.accept(1, 'prompt-b');
      harness.accept(0, 'prompt-a');
      let settled = 0;
      void first.outcome.then(() => settled++);
      void second.outcome.then(() => settled++);
      await vi.waitFor(() => expect(settled).toBe(2), { timeout: 200 });
      expect(await first.outcome).toEqual({ stopReason: 'end_turn' });
      expect(await second.outcome).toBeInstanceOf(DaemonHttpError);
    } finally {
      await harness.close();
    }
  });

  it('preserves a received terminal when the stream ends before acknowledgement', async () => {
    const harness = await setup();
    try {
      const prompt = await harness.prompt();
      await harness.send('prompt-a');
      await harness.endStream();
      harness.accept(0, 'prompt-a');
      expect(await prompt.outcome).toEqual({ stopReason: 'end_turn' });
    } finally {
      await harness.close();
    }
  });

  it('keeps caller cancellation when a terminal preceded the cancelled acknowledgement', async () => {
    const harness = await setup();
    try {
      const prompt = await harness.prompt();
      await harness.send('prompt-a');
      const reason = new Error('caller stopped');
      prompt.caller.abort(reason);
      expect(await prompt.outcome).toBe(reason);
      expect(harness.admissions().size).toBe(0);
      const next = await harness.prompt();
      harness.accept(1, 'prompt-b');
      await harness.waitForAcknowledgement('prompt-b');
      await harness.send('prompt-b');
      expect(await next.outcome).toEqual({ stopReason: 'end_turn' });
    } finally {
      await harness.close();
    }
  });

  it('preserves an admission error and releases its local prompt slot', async () => {
    const harness = await setup();
    try {
      const prompt = await harness.prompt();
      await harness.send('unrelated');
      harness.requests[0]!.resolve(
        Response.json({ error: 'unavailable' }, { status: 503 }),
      );
      expect(await prompt.outcome).toHaveProperty('status', 503);
      expect(harness.admissions().size).toBe(0);
      const next = await harness.prompt();
      harness.accept(1, 'prompt-b');
      await harness.waitForAcknowledgement('prompt-b');
      await harness.send('prompt-b');
      expect(await next.outcome).toEqual({ stopReason: 'end_turn' });
    } finally {
      await harness.close();
    }
  });

  it('bounds unmatched terminal retention and reports overflow instead of hanging', async () => {
    const harness = await setup();
    try {
      const prompt = await harness.prompt();
      for (let index = 0; index < 257; index++) {
        await harness.send(`unrelated-${index}`);
      }
      expect([...harness.admissions()][0]!.events.size).toBe(256);
      harness.accept(0, 'prompt-a');
      expect(await prompt.outcome).toHaveProperty(
        'message',
        'Too many prompt terminals before acknowledgement',
      );
      expect(harness.admissions().size).toBe(0);
    } finally {
      await harness.close();
    }
  });

  it('drops the acknowledgement buffer before waiting for a later terminal', async () => {
    const harness = await setup();
    try {
      const prompt = await harness.prompt();
      await harness.send('unrelated-before');
      const admission = [...harness.admissions()][0]!;
      harness.accept(0, 'prompt-a');
      await harness.waitForAcknowledgement('prompt-a');
      expect(harness.admissions().size).toBe(0);
      expect(admission.events.size).toBe(0);
      await harness.send('unrelated-after');
      expect(harness.admissions().size).toBe(0);
      await harness.send('prompt-a');
      expect(await prompt.outcome).toEqual({ stopReason: 'end_turn' });
    } finally {
      await harness.close();
    }
  });
});
