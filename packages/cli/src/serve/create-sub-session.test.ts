/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { AcpSessionBridge } from '@qwen-code/acp-bridge/bridgeTypes';
import {
  createSubSessionLauncher,
  MAX_CONCURRENT_SUB_SESSIONS_PER_CALLER,
} from './create-sub-session.js';

type FakeEvent = { type: string; data: unknown };

const chunk = (text: string): FakeEvent => ({
  type: 'session_update',
  data: { update: { sessionUpdate: 'agent_message_chunk', content: { text } } },
});
const turnComplete = (
  promptId: string,
  stopReason = 'end_turn',
): FakeEvent => ({
  type: 'turn_complete',
  data: { sessionId: '', stopReason, promptId },
});
const turnError = (promptId: string, message: string): FakeEvent => ({
  type: 'turn_error',
  data: { sessionId: '', message, promptId },
});

/** A fake bridge whose `subscribeEvents` yields a scripted stream (built from
 * the captured promptId) and can optionally block until the abort signal fires
 * — used to exercise the timeout and concurrency-cap paths. */
function makeFakeBridge(opts?: {
  events?: (promptId: string) => FakeEvent[];
  blockAfterEvents?: boolean;
  sendPromptRejects?: string;
}) {
  const spawns: Array<{
    workspaceCwd: string;
    sessionScope?: string;
    modelServiceId?: string;
  }> = [];
  const prompts: Array<{ sessionId: string; promptId?: string; text: string }> =
    [];
  const names: Array<{ sessionId: string; displayName?: string }> = [];
  let subscribeCalls = 0;
  let capturedPromptId = '';
  let n = 0;

  const bridge = {
    spawnOrAttach: async (req: {
      workspaceCwd: string;
      sessionScope?: 'single' | 'thread';
      modelServiceId?: string;
    }) => {
      spawns.push(req);
      return { sessionId: `sub-${++n}` };
    },
    updateSessionMetadata: (
      sessionId: string,
      metadata: { displayName?: string },
    ) => {
      names.push({ sessionId, displayName: metadata.displayName });
      return metadata;
    },
    getSessionLastEventId: () => 0,
    sendPrompt: (
      sessionId: string,
      req: { prompt: Array<{ type: string; text?: string }> },
      _signal: unknown,
      ctx?: { promptId?: string },
    ) => {
      capturedPromptId = ctx?.promptId ?? '';
      prompts.push({
        sessionId,
        promptId: capturedPromptId,
        text: req.prompt.map((p) => p.text ?? '').join(''),
      });
      if (opts?.sendPromptRejects) {
        return Promise.reject(new Error(opts.sendPromptRejects));
      }
      // Never resolves — the first-turn result comes from the event stream.
      return new Promise(() => {});
    },
    async *subscribeEvents(_sessionId: string, o?: { signal?: AbortSignal }) {
      subscribeCalls++;
      const evs = opts?.events ? opts.events(capturedPromptId) : [];
      for (const e of evs) {
        if (o?.signal?.aborted) return;
        yield e;
      }
      if (opts?.blockAfterEvents) {
        await new Promise<void>((resolve) => {
          if (o?.signal) {
            o.signal.addEventListener('abort', () => resolve(), { once: true });
          }
        });
      }
    },
  };
  return {
    bridge: bridge as unknown as AcpSessionBridge,
    spawns,
    prompts,
    names,
    subscribeCalls: () => subscribeCalls,
  };
}

describe('sub-session launcher', () => {
  const WS = '/tmp/ws';

  it('sent: spawns a thread-scoped session, dispatches, returns the id (background subscribe holds slot)', async () => {
    const fake = makeFakeBridge();
    const launcher = createSubSessionLauncher({
      getBridge: () => fake.bridge,
      boundWorkspace: WS,
    });

    const res = await launcher.launch({
      prompt: 'do the thing',
      completion: 'sent',
      name: 'my task',
      callerSessionId: 'caller-1',
    });

    expect(res).toEqual({ sessionId: 'sub-1' });
    expect(fake.spawns).toEqual([{ workspaceCwd: WS, sessionScope: 'thread' }]);
    expect(fake.prompts[0]!.text).toBe('do the thing');
    expect(fake.names[0]!.displayName).toContain('my task');
    // 'sent' returns immediately but starts a background subscription to hold
    // the concurrency slot until the sub-session's turn finishes (so the cap
    // stays meaningful). The subscription is fire-and-forget — the launch
    // result is already returned before any events are consumed.
    expect(fake.subscribeCalls()).toBe(1);
  });

  it('first-turn: accumulates chunk text until turn_complete and returns it', async () => {
    const fake = makeFakeBridge({
      events: (pid) => [chunk('Hello '), chunk('world'), turnComplete(pid)],
    });
    const launcher = createSubSessionLauncher({
      getBridge: () => fake.bridge,
      boundWorkspace: WS,
    });

    const res = await launcher.launch({
      prompt: 'greet',
      completion: 'first-turn',
      model: 'model-x',
      callerSessionId: 'caller-1',
    });

    expect(res).toEqual({
      sessionId: 'sub-1',
      result: 'Hello world',
      stopReason: 'end_turn',
    });
    // model flows through as modelServiceId on the spawn.
    expect(fake.spawns[0]).toEqual({
      workspaceCwd: WS,
      sessionScope: 'thread',
      modelServiceId: 'model-x',
    });
    expect(fake.subscribeCalls()).toBe(1);
  });

  it('first-turn: reports turn_error with the partial text and error stopReason', async () => {
    const fake = makeFakeBridge({
      events: (pid) => [chunk('partial'), turnError(pid, 'model exploded')],
    });
    const launcher = createSubSessionLauncher({
      getBridge: () => fake.bridge,
      boundWorkspace: WS,
    });
    const res = await launcher.launch({
      prompt: 'x',
      completion: 'first-turn',
      callerSessionId: 'c',
    });
    expect(res.sessionId).toBe('sub-1');
    expect(res.stopReason).toBe('error');
    expect(res.result).toContain('partial');
    expect(res.result).toContain('model exploded');
  });

  it('first-turn: truncates an over-long result', async () => {
    const fake = makeFakeBridge({
      events: (pid) => [chunk('x'.repeat(40_000)), turnComplete(pid)],
    });
    const launcher = createSubSessionLauncher({
      getBridge: () => fake.bridge,
      boundWorkspace: WS,
    });
    const res = await launcher.launch({
      prompt: 'x',
      completion: 'first-turn',
      callerSessionId: 'c',
    });
    expect(res.result!.length).toBeLessThan(40_000);
    expect(res.result).toContain('truncated');
  });

  it('first-turn: times out (returns partial text + timeout stopReason)', async () => {
    const fake = makeFakeBridge({
      events: () => [chunk('slow...')],
      blockAfterEvents: true,
    });
    const launcher = createSubSessionLauncher({
      getBridge: () => fake.bridge,
      boundWorkspace: WS,
      firstTurnTimeoutMs: 60,
    });
    const res = await launcher.launch({
      prompt: 'x',
      completion: 'first-turn',
      callerSessionId: 'c',
    });
    expect(res.stopReason).toBe('timeout');
    expect(res.result).toContain('slow...');
  });

  it('caps concurrent first-turn runs per caller, rejecting the overflow without spawning', async () => {
    const fake = makeFakeBridge({ blockAfterEvents: true });
    const launcher = createSubSessionLauncher({
      getBridge: () => fake.bridge,
      boundWorkspace: WS,
      firstTurnTimeoutMs: 80, // held runs settle via timeout so the test ends
    });

    const promises = [];
    for (let i = 0; i < MAX_CONCURRENT_SUB_SESSIONS_PER_CALLER + 1; i++) {
      promises.push(
        launcher.launch({
          prompt: `p${i}`,
          completion: 'first-turn',
          callerSessionId: 'same-caller',
        }),
      );
    }
    const settled = await Promise.allSettled(promises);
    const rejected = settled.filter((s) => s.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason.message).toMatch(
      /cap/i,
    );
    // The overflow was rejected BEFORE spawning — exactly cap sessions spawned.
    expect(fake.spawns).toHaveLength(MAX_CONCURRENT_SUB_SESSIONS_PER_CALLER);
  });

  it('rejects when the bridge is unavailable', async () => {
    const launcher = createSubSessionLauncher({
      getBridge: () => undefined,
      boundWorkspace: WS,
    });
    await expect(
      launcher.launch({ prompt: 'x', completion: 'sent' }),
    ).rejects.toThrow();
  });

  it('rejects new launches after stop()', async () => {
    const fake = makeFakeBridge();
    const launcher = createSubSessionLauncher({
      getBridge: () => fake.bridge,
      boundWorkspace: WS,
    });
    launcher.stop();
    await expect(
      launcher.launch({ prompt: 'x', completion: 'sent' }),
    ).rejects.toThrow(/shutting down/i);
    expect(fake.spawns).toHaveLength(0);
  });

  it('first-turn: sendPrompt rejection fails fast (not after timeout)', async () => {
    // blockAfterEvents keeps the subscription alive so the turnError race
    // is the only way to settle — proving the rejection short-circuits the
    // 5-min timeout instead of silently timing out.
    const fake = makeFakeBridge({
      sendPromptRejects: 'API 429 rate limit',
      events: () => [],
      blockAfterEvents: true,
    });
    const launcher = createSubSessionLauncher({
      getBridge: () => fake.bridge,
      boundWorkspace: WS,
      firstTurnTimeoutMs: 60_000, // would wait 1 min without the race
    });
    await expect(
      launcher.launch({
        prompt: 'x',
        completion: 'first-turn',
        callerSessionId: 'c',
      }),
    ).rejects.toThrow(/dispatch failed.*API 429/i);
  });

  it('sent mode: holds concurrency slots until drain completes', async () => {
    const fake = makeFakeBridge({
      events: (pid) => [turnComplete(pid)],
      blockAfterEvents: false, // events emit immediately
    });
    const launcher = createSubSessionLauncher({
      getBridge: () => fake.bridge,
      boundWorkspace: WS,
    });
    // Launch cap-count sent runs — they should succeed and release slots.
    const results = await Promise.all(
      Array.from({ length: MAX_CONCURRENT_SUB_SESSIONS_PER_CALLER }, (_, i) =>
        launcher.launch({
          prompt: `p${i}`,
          completion: 'sent',
          callerSessionId: 'same-caller',
        }),
      ),
    );
    expect(results).toHaveLength(MAX_CONCURRENT_SUB_SESSIONS_PER_CALLER);
    // Drain runs are fire-and-forget; let microtasks flush.
    await new Promise((r) => setTimeout(r, 0));
    // After drains complete, a fresh launch should succeed (slots released).
    const fresh = await launcher.launch({
      prompt: 'after-drain',
      completion: 'sent',
      callerSessionId: 'same-caller',
    });
    expect(fresh.sessionId).toBeTruthy();
  });

  it('stop() mid-first-turn returns stopReason "shutdown"', async () => {
    const fake = makeFakeBridge({
      events: () => [chunk('partial')],
      blockAfterEvents: true, // holds until signal aborts
    });
    const launcher = createSubSessionLauncher({
      getBridge: () => fake.bridge,
      boundWorkspace: WS,
      firstTurnTimeoutMs: 60_000,
    });
    const promise = launcher.launch({
      prompt: 'x',
      completion: 'first-turn',
      callerSessionId: 'c',
    });
    // Let the launch start and subscribe, then stop.
    await new Promise((r) => setTimeout(r, 10));
    launcher.stop();
    const res = await promise;
    expect(res.stopReason).toBe('shutdown');
    expect(res.result).toContain('partial');
  });
});
