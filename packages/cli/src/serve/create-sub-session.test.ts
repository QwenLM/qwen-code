/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AcpSessionBridge } from '@qwen-code/acp-bridge/bridgeTypes';

/** Captures the launcher's operator-facing stderr output. */
const { stderrLines } = vi.hoisted(() => ({ stderrLines: [] as string[] }));
vi.mock('../utils/stdioHelpers.js', () => ({
  writeStderrLine: (line: string) => stderrLines.push(line),
}));

const {
  createSubSessionLauncher,
  MAX_CONCURRENT_SUB_SESSIONS_PER_CALLER,
  MAX_CONCURRENT_SUB_SESSIONS_TOTAL,
} = await import('./create-sub-session.js');

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
  /** How the orphan-cleanup `closeSession` fails, if at all. A real bridge can
   * throw synchronously (e.g. an unknown session id hits an assertion before
   * the first await), which must not clobber the launch error. */
  closeSessionFails?: 'sync' | 'async';
}) {
  const spawns: Array<{
    workspaceCwd: string;
    sessionScope?: string;
    modelServiceId?: string;
  }> = [];
  const prompts: Array<{ sessionId: string; promptId?: string; text: string }> =
    [];
  const names: Array<{ sessionId: string; displayName?: string }> = [];
  const closes: string[] = [];
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
    closeSession: (sessionId: string) => {
      closes.push(sessionId);
      if (opts?.closeSessionFails === 'sync') {
        throw new Error('closeSession exploded');
      }
      if (opts?.closeSessionFails === 'async') {
        return Promise.reject(new Error('closeSession rejected'));
      }
      return Promise.resolve();
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
    closes,
    subscribeCalls: () => subscribeCalls,
  };
}

describe('sub-session launcher', () => {
  const WS = '/tmp/ws';

  beforeEach(() => {
    stderrLines.length = 0;
  });

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
      launcher.launch({
        prompt: 'x',
        completion: 'sent',
        callerSessionId: 'c',
      }),
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
      launcher.launch({
        prompt: 'x',
        completion: 'sent',
        callerSessionId: 'c',
      }),
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
    // The session was already spawned when the dispatch failed — close it so it
    // doesn't linger in the bridge's pool while launch() reports failure.
    expect(fake.closes).toEqual(['sub-1']);
  });

  it('first-turn: a throwing closeSession does not mask the launch error', async () => {
    // Orphan cleanup runs inside the launcher's catch block. A synchronous
    // throw there would escape and replace the real failure ('API 429') with
    // the cleanup failure — the caller would be told the wrong thing.
    for (const closeSessionFails of ['sync', 'async'] as const) {
      const fake = makeFakeBridge({
        sendPromptRejects: 'API 429 rate limit',
        events: () => [],
        blockAfterEvents: true,
        closeSessionFails,
      });
      const launcher = createSubSessionLauncher({
        getBridge: () => fake.bridge,
        boundWorkspace: WS,
        firstTurnTimeoutMs: 60_000,
      });
      await expect(
        launcher.launch({
          prompt: 'x',
          completion: 'first-turn',
          callerSessionId: 'c',
        }),
      ).rejects.toThrow(/dispatch failed.*API 429/i);
      expect(fake.closes).toEqual(['sub-1']);
    }
  });

  it('sent mode: holds the concurrency slot while the drain is still running', async () => {
    // No turn_complete and a stream that blocks: every drain stays in flight,
    // so every slot stays held. Releasing at drain *start* instead of drain
    // *end* would silently admit the overflow launch below — that is exactly
    // the "cap is a no-op for sent mode" bug this guards.
    const fake = makeFakeBridge({ events: () => [], blockAfterEvents: true });
    const launcher = createSubSessionLauncher({
      getBridge: () => fake.bridge,
      boundWorkspace: WS,
    });
    for (let i = 0; i < MAX_CONCURRENT_SUB_SESSIONS_PER_CALLER; i++) {
      await launcher.launch({
        prompt: `p${i}`,
        completion: 'sent',
        callerSessionId: 'same-caller',
      });
    }
    await expect(
      launcher.launch({
        prompt: 'overflow',
        completion: 'sent',
        callerSessionId: 'same-caller',
      }),
    ).rejects.toThrow(/cap/i);
    // Rejected before spawning — exactly cap sessions exist.
    expect(fake.spawns).toHaveLength(MAX_CONCURRENT_SUB_SESSIONS_PER_CALLER);
    launcher.stop(); // unblock the drains so the test leaves nothing pending
  });

  it('sent mode: releases the slot once the drain sees turn_complete', async () => {
    // blockAfterEvents keeps the stream open past the scripted events, so the
    // ONLY way a drain can end is by matching its own turn_complete promptId.
    const fake = makeFakeBridge({
      events: (pid) => [turnComplete(pid)],
      blockAfterEvents: true,
    });
    const launcher = createSubSessionLauncher({
      getBridge: () => fake.bridge,
      boundWorkspace: WS,
    });
    for (let i = 0; i < MAX_CONCURRENT_SUB_SESSIONS_PER_CALLER; i++) {
      await launcher.launch({
        prompt: `p${i}`,
        completion: 'sent',
        callerSessionId: 'same-caller',
      });
    }
    // Drains are fire-and-forget; let them observe turn_complete and release.
    await vi.waitFor(() =>
      expect(fake.subscribeCalls()).toBe(
        MAX_CONCURRENT_SUB_SESSIONS_PER_CALLER,
      ),
    );
    await new Promise((r) => setTimeout(r, 10));
    // All slots freed — a launch beyond the cap now succeeds.
    const fresh = await launcher.launch({
      prompt: 'after-drain',
      completion: 'sent',
      callerSessionId: 'same-caller',
    });
    expect(fresh.sessionId).toBeTruthy();
    launcher.stop();
  });

  it('first-turn: reports "incomplete" when the stream ends before the turn does', async () => {
    // Bridge teardown / WS drop: the subscription ends with no turn_complete and
    // no deadline passed. Reading `ac.signal.aborted` here would always say
    // "timeout" — the cleanup `finally` aborts that controller unconditionally.
    const fake = makeFakeBridge({
      events: () => [chunk('partial')],
      blockAfterEvents: false, // stream ends on its own
    });
    const launcher = createSubSessionLauncher({
      getBridge: () => fake.bridge,
      boundWorkspace: WS,
      firstTurnTimeoutMs: 60_000, // nowhere near firing
    });
    const res = await launcher.launch({
      prompt: 'x',
      completion: 'first-turn',
      callerSessionId: 'c',
    });
    expect(res.stopReason).toBe('incomplete');
    expect(res.result).toContain('partial');
  });

  it('sent mode: a drain timeout reaches stderr before the slot is released', async () => {
    // 30 min of model compute and a bridge session went nowhere. `log.debug` is
    // a no-op unless a debug log session is active, so without this the hang
    // leaves no trace anywhere.
    const fake = makeFakeBridge({ events: () => [], blockAfterEvents: true });
    const launcher = createSubSessionLauncher({
      getBridge: () => fake.bridge,
      boundWorkspace: WS,
      sentModeDrainTimeoutMs: 20,
    });
    await launcher.launch({
      prompt: 'x',
      completion: 'sent',
      callerSessionId: 'c',
    });
    await vi.waitFor(() =>
      expect(stderrLines.some((l) => /drain timed out/i.test(l))).toBe(true),
    );
    const line = stderrLines.find((l) => /drain timed out/i.test(l))!;
    expect(line).toContain('sub-1');
    expect(line).toMatch(/may still be running/i);
    // The slot is freed, so a fresh launch from the same caller succeeds.
    await launcher.launch({
      prompt: 'y',
      completion: 'sent',
      callerSessionId: 'c',
    });
    launcher.stop();
  });

  it('caps concurrent sub-sessions workspace-wide, even across rotated caller ids', async () => {
    // The per-caller cap trusts `callerSessionId`, which the bridge can only
    // authenticate as "a session on this channel" — all of a workspace's
    // sessions share one child process. A caller rotating ids never trips the
    // per-caller bucket; this backstop does not depend on the id being honest.
    const fake = makeFakeBridge({ events: () => [], blockAfterEvents: true });
    const launcher = createSubSessionLauncher({
      getBridge: () => fake.bridge,
      boundWorkspace: WS,
    });
    for (let i = 0; i < MAX_CONCURRENT_SUB_SESSIONS_TOTAL; i++) {
      await launcher.launch({
        prompt: `p${i}`,
        completion: 'sent',
        callerSessionId: `rotated-${i}`, // a fresh bucket every time
      });
    }
    await expect(
      launcher.launch({
        prompt: 'overflow',
        completion: 'sent',
        callerSessionId: 'rotated-fresh',
      }),
    ).rejects.toThrow(/workspace/i);
    expect(fake.spawns).toHaveLength(MAX_CONCURRENT_SUB_SESSIONS_TOTAL);
    launcher.stop();
  });

  it('refuses to spawn from a session it already spawned (depth-1 gate)', async () => {
    // Every daemon session wires a spawner, sub-sessions included, and each
    // gets its own cap-sized bucket. Without this gate one prompt fans out 5ⁿ.
    const fake = makeFakeBridge({ events: (pid) => [turnComplete(pid)] });
    const launcher = createSubSessionLauncher({
      getBridge: () => fake.bridge,
      boundWorkspace: WS,
    });

    const first = await launcher.launch({
      prompt: 'top level',
      completion: 'sent',
      callerSessionId: 'anchor',
    });
    expect(first.sessionId).toBe('sub-1');

    // 'sub-1' is now a known sub-session — it may not spawn further ones.
    await expect(
      launcher.launch({
        prompt: 'nested',
        completion: 'sent',
        callerSessionId: first.sessionId,
      }),
    ).rejects.toThrow(/nesting/i);
    // Rejected before spawning: still exactly one session.
    expect(fake.spawns).toHaveLength(1);

    // A sibling top-level caller is unaffected.
    const sibling = await launcher.launch({
      prompt: 'other top level',
      completion: 'sent',
      callerSessionId: 'anchor-2',
    });
    expect(sibling.sessionId).toBe('sub-2');
    launcher.stop();
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
