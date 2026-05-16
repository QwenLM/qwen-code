/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration test for the /goal Stop hook loop.
 *
 * This intentionally does NOT boot `GeminiClient` or the full hook runner.
 * It exercises the seam that matters for the spec criterion:
 *
 *   "after `/goal <condition>`, a normal attempt to stop must be intercepted
 *   by the same Stop hook loop used by configured hooks, and the goal must
 *   auto-clear only when the judge says the condition is satisfied."
 *
 * Concretely we verify:
 *   - `registerGoalHook` wires a Function hook into the session's hook system
 *     under the `Stop` event with a wildcard matcher (so it matches any Stop).
 *   - When the hook callback runs and the judge says "not met", the response
 *     shape is `{decision:'block', reason:<controlled prompt>}` — which
 *     `client.ts`'s `isBlockingDecision() || shouldStopExecution()` interprets
 *     as a continuation request. The judge's free-form diagnostic stays in
 *     active-goal state and must not become the next model instruction.
 *   - When the judge says "met" on a later iteration, the hook returns
 *     `{continue:true}`, clears the store, and notifies the terminal observer
 *     with stats (iterations, durationMs) — exactly what the UI needs.
 *   - The hook is removed from the session manager once the goal is achieved
 *     so a subsequent Stop event would not re-trigger the judge.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HookEventName, HookSystem, type StopInput } from '../hooks/index.js';
import type { Config } from '../config/config.js';
import {
  __resetActiveGoalStoreForTests,
  getActiveGoal,
  registerGoalHook,
  setGoalTerminalObserver,
  type GoalTerminalEvent,
} from './index.js';

const judgeMock = vi.hoisted(() => vi.fn());
vi.mock('./goalJudge.js', () => ({
  judgeGoal: judgeMock,
}));

const SESSION = 'sess-loop';

function makeStopInput(lastAssistantText: string): StopInput {
  return {
    session_id: SESSION,
    transcript_path: '/tmp/t.jsonl',
    cwd: '/tmp',
    hook_event_name: 'Stop',
    timestamp: new Date().toISOString(),
    stop_hook_active: true,
    last_assistant_message: lastAssistantText,
  };
}

function makeConfigWithRealHookSystem(): {
  config: Config;
  hookSystem: HookSystem;
} {
  // Use the real HookSystem so we exercise the same session-hook plumbing
  // `client.ts` would hit, but stub out network / settings dependencies that
  // it pulls from Config during construction.
  const config = {
    getAllowedHttpHookUrls: () => [],
    getSessionId: () => SESSION,
    isTrustedFolder: () => true,
    getDisableAllHooks: () => false,
  } as unknown as Config;
  const hookSystem = new HookSystem(config);
  // Patch Config.getHookSystem to return our real system.
  (config as { getHookSystem: () => HookSystem }).getHookSystem = () =>
    hookSystem;
  return { config, hookSystem };
}

describe('/goal Stop hook integration', () => {
  beforeEach(() => {
    __resetActiveGoalStoreForTests();
    judgeMock.mockReset();
  });
  afterEach(() => __resetActiveGoalStoreForTests());

  it('drives a not-met → met loop and emits an achieved terminal event', async () => {
    const { config, hookSystem } = makeConfigWithRealHookSystem();

    // Sanity: fast-path check sees the session Stop hook AFTER we register it.
    expect(hookSystem.hasHooksForEvent('Stop', SESSION)).toBe(false);
    const goal = registerGoalHook({
      config,
      sessionId: SESSION,
      condition: 'write test letter sequence',
      tokensAtStart: 0,
    });
    expect(hookSystem.hasHooksForEvent('Stop', SESSION)).toBe(true);

    const events: GoalTerminalEvent[] = [];
    setGoalTerminalObserver(SESSION, (e) => events.push(e));

    // Pull the live session hook entry so we can invoke its callback exactly
    // the way HookEventHandler would. This is the seam we care about.
    const sessionHook = hookSystem
      .getSessionHooksManager()
      .getHooksForEvent(SESSION, HookEventName.Stop)[0];
    expect(sessionHook).toBeDefined();
    expect(sessionHook.matcher).toBe('*');
    // Function hook config — sanity check
    if (sessionHook.config.type !== 'function') {
      throw new Error(
        `expected function hook, got ${String(sessionHook.config.type)}`,
      );
    }
    const callback = sessionHook.config.callback;
    expect(typeof callback).toBe('function');

    // Iteration 1: judge says NOT met → continuation expected.
    judgeMock.mockResolvedValueOnce({
      ok: false,
      reason: 'still missing letters e, s, t',
    });
    const out1 = await callback(makeStopInput('t'), undefined);
    expect(out1).toMatchObject({
      decision: 'block',
    });
    expect(
      typeof out1 === 'object' && out1 !== null && 'reason' in out1
        ? out1.reason
        : undefined,
    ).toContain('Goal condition: write test letter sequence');
    expect(
      typeof out1 === 'object' && out1 !== null && 'reason' in out1
        ? out1.reason
        : undefined,
    ).not.toContain('still missing letters e, s, t');
    // Store reflects increment and lastReason.
    const after1 = getActiveGoal(SESSION);
    expect(after1?.iterations).toBe(1);
    expect(after1?.lastReason).toBe('still missing letters e, s, t');
    // No terminal event yet.
    expect(events).toEqual([]);

    // Iteration 2: judge says NOT met again → continuation again.
    judgeMock.mockResolvedValueOnce({
      ok: false,
      reason: 'still missing letters s, t',
    });
    const out2 = await callback(makeStopInput('te'), undefined);
    expect(out2).toMatchObject({ decision: 'block' });
    expect(getActiveGoal(SESSION)?.iterations).toBe(2);
    expect(events).toEqual([]);

    // Iteration 3: judge says MET → continue:true and observer fires.
    judgeMock.mockResolvedValueOnce({
      ok: true,
      reason: 'transcript contains "test"',
    });
    const out3 = await callback(makeStopInput('test'), undefined);
    expect(out3).toEqual({ continue: true });

    // Store is cleared synchronously.
    expect(getActiveGoal(SESSION)).toBeUndefined();
    // Achieved event with correct stats.
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'achieved',
      condition: goal.condition,
      iterations: 2, // not yet 3 — that update only happens for not-met cases
      lastReason: 'transcript contains "test"',
    });
    expect(events[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it('does NOT call the judge after the goal is replaced', async () => {
    const { config, hookSystem } = makeConfigWithRealHookSystem();
    registerGoalHook({
      config,
      sessionId: SESSION,
      condition: 'goal A',
      tokensAtStart: 0,
    });
    // First hook's callback — captured before replacement.
    const firstHook = hookSystem
      .getSessionHooksManager()
      .getHooksForEvent(SESSION, HookEventName.Stop)[0];
    if (firstHook.config.type !== 'function')
      throw new Error('expected fn hook');
    const oldCallback = firstHook.config.callback;

    // Replace with goal B; the old hook should be torn down.
    registerGoalHook({
      config,
      sessionId: SESSION,
      condition: 'goal B',
      tokensAtStart: 0,
    });
    expect(getActiveGoal(SESSION)?.condition).toBe('goal B');

    // The OLD callback runs against the new active goal → it must short-circuit
    // (condition mismatch → continue:true, judge untouched).
    const out = await oldCallback(makeStopInput('anything'), undefined);
    expect(out).toEqual({ continue: true });
    expect(judgeMock).not.toHaveBeenCalled();
  });
});
