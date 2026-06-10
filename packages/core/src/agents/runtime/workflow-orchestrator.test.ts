/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

// T7 (PR #4732 R1): the `vi as vitest` alias diverges from every other
// test file in the repo. Use `vi` directly.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as os from 'node:os';
import {
  WorkflowOrchestrator,
  WorkflowExecutionError,
  createProductionDispatch,
  MAX_AGENTS_PER_RUN,
} from './workflow-orchestrator.js';
import type { Config } from '../../config/config.js';

// FIX-C3 (TST-2-C1): use vi.hoisted so `created` is initialised before the
// vi.mock factory runs AND remains accessible inside tests for assertion +
// reset between cases. Without this, the module-level `created` array
// accumulated across tests, so a later test could pass by coincidence.
//
// FIX-C8 (TST-2-I2): record the full 9-arg signature of AgentHeadless.create
// and the (ctx, signal?) shape of execute so any drift between the production
// call site and the real AgentHeadless surface becomes a test failure.
const { created, nextTerminateMode } = vi.hoisted(() => ({
  created: [] as Array<{
    name: string;
    prompt: string;
    signal?: AbortSignal;
    promptConfigSystemPrompt?: string;
    runConfig?: { max_turns?: number; max_time_minutes?: number };
    toolConfig?: { tools?: string[]; disallowedTools?: string[] };
  }>,
  // T10 (PR #4732 R1): the production dispatch checks getTerminateMode() and
  // throws on non-GOAL. Tests set `nextTerminateMode.value` to simulate
  // CANCELLED / MAX_TURNS / TIMEOUT outcomes.
  nextTerminateMode: { value: 'GOAL' as string },
}));

vi.mock('./agent-headless.js', () => ({
  AgentHeadless: {
    create: async (
      name: string,
      _runtimeContext: unknown,
      promptConfig: { systemPrompt?: string },
      _modelConfig: unknown,
      runConfig: { max_turns?: number; max_time_minutes?: number },
      toolConfig?: { tools?: string[]; disallowedTools?: string[] },
      // The next three optional params reflect the real AgentHeadless.create
      // signature (eventEmitter?, hooks?, runtimeView?). Accepting them as
      // `unknown` lets the mock detect if the production call site ever adds
      // a positional argument that the mock would silently drop.
      _eventEmitter?: unknown,
      _hooks?: unknown,
      _runtimeView?: unknown,
    ) => ({
      execute: async (
        ctx: { get: (k: string) => unknown },
        signal?: AbortSignal,
      ) => {
        created.push({
          name,
          prompt: ctx.get('task_prompt') as string,
          signal,
          promptConfigSystemPrompt: promptConfig.systemPrompt,
          runConfig,
          toolConfig,
        });
        if (
          !promptConfig.systemPrompt?.includes('subagent spawned by a workflow')
        ) {
          throw new Error(
            'orchestrator did not pass workflow subagent system prompt',
          );
        }
      },
      getFinalText: () =>
        `headless-said:${created[created.length - 1]!.prompt}`,
      getTerminateMode: () => nextTerminateMode.value,
    }),
  },
  ContextState: class ContextState {
    private state: Record<string, unknown> = {};
    get(key: string): unknown {
      return this.state[key];
    }
    set(key: string, value: unknown): void {
      this.state[key] = value;
    }
  },
}));

function fakeConfig(): Config {
  // createProductionDispatch uses Config only when constructing a real subagent.
  // In tests we either inject a mock dispatch or test createProductionDispatch
  // directly against the vi.mock above. An empty object cast is safe.
  return {} as unknown as Config;
}

describe('WorkflowOrchestrator', () => {
  it('runs a script with injected mock dispatch and returns the script value', async () => {
    const orchestrator = new WorkflowOrchestrator(
      async (prompt) => `mock:${prompt}`,
    );
    const outcome = await orchestrator.run({
      script: `phase("plan");
               const x = await agent("hi", { label: "a" });
               return x;`,
      args: undefined,
    });
    expect(outcome.result).toBe('mock:hi');
    expect(outcome.runId).toMatch(/^wf_[0-9a-f]{16}$/);
    expect(outcome.phases).toEqual(['plan']);
  });

  it('passes args through to the script', async () => {
    const orchestrator = new WorkflowOrchestrator(async () => 'unused');
    const outcome = await orchestrator.run({
      script: `return args.who`,
      args: { who: 'world' },
    });
    expect(outcome.result).toBe('world');
  });

  it('surfaces a thrown error from the script', async () => {
    const orchestrator = new WorkflowOrchestrator(async () => 'unused');
    await expect(
      orchestrator.run({
        script: `throw new Error("boom")`,
        args: undefined,
      }),
    ).rejects.toThrow(/boom/);
  });

  it('runId is stable for the lifetime of a single run call', async () => {
    const captured: string[] = [];
    const orchestrator = new WorkflowOrchestrator(async (prompt) => {
      captured.push(prompt);
      return 'ok';
    });
    const outcome = await orchestrator.run({
      script: `await agent("first"); await agent("second"); return 0;`,
      args: undefined,
    });
    expect(captured).toEqual(['first', 'second']);
    expect(outcome.runId).toMatch(/^wf_[0-9a-f]{16}$/);
  });

  // TST-C1: concurrent runs must produce distinct runIds.
  it('runId is unique across concurrent runs', async () => {
    const orchestrator = new WorkflowOrchestrator(async () => 'ok');
    const [a, b, c] = await Promise.all([
      orchestrator.run({ script: 'return 1', args: undefined }),
      orchestrator.run({ script: 'return 2', args: undefined }),
      orchestrator.run({ script: 'return 3', args: undefined }),
    ]);
    expect(a.runId).not.toBe(b.runId);
    expect(b.runId).not.toBe(c.runId);
    expect(a.runId).not.toBe(c.runId);
  });

  // TST-C2: a dispatch rejection must propagate out through the sandbox.
  it('propagates dispatch rejection through the script', async () => {
    const orchestrator = new WorkflowOrchestrator(async () => {
      throw new Error('agent-crashed');
    });
    await expect(
      orchestrator.run({
        script: 'await agent("x"); return 0;',
        args: undefined,
      }),
    ).rejects.toThrow(/agent-crashed/);
  });
});

describe('createProductionDispatch', () => {
  // FIX-C3: reset the shared mock-state array between tests so each case
  // observes its own subagent.execute call only. Also reset the simulated
  // terminate mode back to 'goal' (success).
  beforeEach(() => {
    created.length = 0;
    nextTerminateMode.value = 'GOAL';
  });

  it('routes calls through AgentHeadless and returns getFinalText', async () => {
    const dispatch = createProductionDispatch(fakeConfig());
    const result = await dispatch('hello', { label: 'h1' });
    expect(result).toBe('headless-said:hello');
    expect(created.length).toBe(1);
    expect(created[0]!.name).toBe('h1');
    expect(created[0]!.prompt).toBe('hello');
  });

  // FIX-C4 (TST-2-C2): the previous test only asserted no-crash. This one
  // actually captures the signal in the mock and asserts identity, so a
  // regression that drops the second arg of subagent.execute() would fail.
  it('threads abort signal through to subagent.execute', async () => {
    const controller = new AbortController();
    const dispatch = createProductionDispatch(fakeConfig(), controller.signal);
    await dispatch('hello', { label: 'h1' });
    expect(created.length).toBe(1);
    expect(created[0]!.signal).toBe(controller.signal);
  });

  it('passes undefined signal when none provided', async () => {
    const dispatch = createProductionDispatch(fakeConfig());
    await dispatch('hello', { label: 'h1' });
    expect(created.length).toBe(1);
    expect(created[0]!.signal).toBeUndefined();
  });

  // FIX-C2 (UP-2-C1): the subagent system prompt must include the binary's
  // §XmO bullets. We assert the JSON-format instruction is present because
  // its absence causes JSON-returning subagents to wrap output in code fences.
  it('passes the binary §XmO verbatim system prompt to subagent', async () => {
    const dispatch = createProductionDispatch(fakeConfig());
    await dispatch('hello', { label: 'h1' });
    const sp = created[0]!.promptConfigSystemPrompt ?? '';
    expect(sp).toContain('subagent spawned by a workflow');
    expect(sp).toContain('return ONLY the raw JSON');
    expect(sp).toContain('no code fences');
    expect(sp).toContain('SendUserMessage');
  });

  // T11 (PR #4732 R1): subagents must be bounded so a single agent() call
  // cannot loop the model indefinitely.
  it('passes bounded runConfig (max_turns + max_time_minutes)', async () => {
    const dispatch = createProductionDispatch(fakeConfig());
    await dispatch('hello', { label: 'h1' });
    expect(created[0]!.runConfig).toEqual({
      max_turns: 50,
      max_time_minutes: 10,
    });
  });

  // T11: disallow SendMessage / ExitPlanMode to mirror upstream Tg8.
  it('disallows SendMessage and ExitPlanMode for workflow subagents', async () => {
    const dispatch = createProductionDispatch(fakeConfig());
    await dispatch('hello', { label: 'h1' });
    expect(created[0]!.toolConfig?.tools).toEqual(['*']);
    expect(created[0]!.toolConfig?.disallowedTools).toEqual([
      'send_message',
      'exit_plan_mode',
    ]);
  });

  // T10 (PR #4732 R1): the production dispatch must throw when the
  // subagent terminates with a non-GOAL mode. Without this, `await agent(...)`
  // would resolve to '' on user cancel and the script would keep running.
  it.each([
    ['CANCELLED', /terminate mode: CANCELLED/],
    ['MAX_TURNS', /terminate mode: MAX_TURNS/],
    ['TIMEOUT', /terminate mode: TIMEOUT/],
    ['ERROR', /terminate mode: ERROR/],
  ])(
    'throws when subagent terminate mode is %s',
    async (mode, expectedMessage) => {
      nextTerminateMode.value = mode;
      const dispatch = createProductionDispatch(fakeConfig());
      await expect(dispatch('hello', { label: 'h1' })).rejects.toThrow(
        expectedMessage,
      );
    },
  );
});

describe('WorkflowOrchestrator failure-context preservation', () => {
  // T19 (PR #4732 R1): phases / logs accumulated before a script failure
  // must be preserved on the thrown error so the tool layer can display
  // them. Previously the sandbox instance was discarded with the error.
  it('throws WorkflowExecutionError carrying phases and logs on script failure', async () => {
    const orchestrator = new WorkflowOrchestrator(async () => 'ok');
    let caught: unknown;
    try {
      await orchestrator.run({
        script: `
          phase("plan");
          log("starting");
          phase("execute");
          log("about to fail");
          throw new Error("scripted failure");
        `,
        args: undefined,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(WorkflowExecutionError);
    const wfErr = caught as WorkflowExecutionError;
    expect(wfErr.message).toContain('scripted failure');
    expect(wfErr.phases).toEqual(['plan', 'execute']);
    expect(wfErr.logs).toEqual(['starting', 'about to fail']);
  });
});

describe('WorkflowOrchestrator P2 — parallel() / pipeline() / caps', () => {
  describe('parallel()', () => {
    it('resolves all thunks to a position-aligned array', async () => {
      const orchestrator = new WorkflowOrchestrator(
        async (prompt) => `r:${prompt}`,
      );
      const outcome = await orchestrator.run({
        script: `return await parallel([
          () => agent("a"),
          () => agent("b"),
          () => agent("c"),
        ]);`,
        args: undefined,
      });
      expect(outcome.result).toEqual(['r:a', 'r:b', 'r:c']);
    });

    it('errors-as-data: a thunk that throws becomes null at its index, others unaffected', async () => {
      const orchestrator = new WorkflowOrchestrator(
        async (prompt) => `r:${prompt}`,
      );
      const outcome = await orchestrator.run({
        script: `return await parallel([
          () => agent("a"),
          () => { throw new Error("boom"); },
          () => agent("c"),
        ]);`,
        args: undefined,
      });
      expect(outcome.result).toEqual(['r:a', null, 'r:c']);
    });

    it('rejects on a non-function element (eager promise instead of thunk)', async () => {
      const orchestrator = new WorkflowOrchestrator(async () => 'unused');
      await expect(
        orchestrator.run({
          script: `return await parallel([agent("a")]);`,
          args: undefined,
        }),
      ).rejects.toThrow(/array of functions/);
    });

    // EAD-1 (P2 self-review): a thunk that resolves to a non-JSON-serializable
    // value (BigInt / circular) must become null at its index — NOT crash the
    // whole batch. The in-realm revival is per-element, so one bad slot cannot
    // destroy its siblings (errors-as-data holds for return values too).
    it('a thunk returning a non-serializable value becomes null without crashing siblings', async () => {
      const orchestrator = new WorkflowOrchestrator(async () => 'unused');
      const outcome = await orchestrator.run({
        script: `return await parallel([
          () => "a",
          () => 1n,
          () => "c",
          () => { const o = {}; o.self = o; return o; },
        ]);`,
        args: undefined,
      });
      expect(outcome.result).toEqual(['a', null, 'c', null]);
    });

    it('caps concurrent agents within a fan-out to the shared per-run window', async () => {
      let inFlight = 0;
      let peak = 0;
      const orchestrator = new WorkflowOrchestrator(async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return 'ok';
      });
      await orchestrator.run({
        script: `return await parallel(
          Array.from({ length: 50 }, () => () => agent("x"))
        );`,
        args: undefined,
      });
      // 50 thunks >> window, so the window fully fills: peak === cap.
      const cap = Math.max(1, Math.min(16, os.cpus().length - 2));
      expect(peak).toBe(cap);
    });
  });

  describe('pipeline()', () => {
    it('runs each item through the stages; first stage receives (item, item, idx)', async () => {
      const orchestrator = new WorkflowOrchestrator(async () => 'unused');
      const outcome = await orchestrator.run({
        script: `return await pipeline([10, 20],
          (prev, item, idx) => prev + "|" + item + "|" + idx,
          (prev) => "S2(" + prev + ")",
        );`,
        args: undefined,
      });
      expect(outcome.result).toEqual(['S2(10|10|0)', 'S2(20|20|1)']);
    });

    it('a stage returning null drops that item to null and skips remaining stages', async () => {
      const orchestrator = new WorkflowOrchestrator(async () => 'unused');
      const outcome = await orchestrator.run({
        script: `return await pipeline([1, 2, 3],
          (x) => (x === 2 ? null : x),
          (x) => x * 100,
        );`,
        args: undefined,
      });
      expect(outcome.result).toEqual([100, null, 300]);
    });

    it('a stage that throws drops that item to null (errors-as-data), others unaffected', async () => {
      const orchestrator = new WorkflowOrchestrator(async () => 'unused');
      const outcome = await orchestrator.run({
        script: `return await pipeline([1, 2, 3],
          (x) => { if (x === 2) throw new Error("bad"); return x; },
          (x) => x * 100,
        );`,
        args: undefined,
      });
      expect(outcome.result).toEqual([100, null, 300]);
    });

    it('rejects when a stage is not a function', async () => {
      const orchestrator = new WorkflowOrchestrator(async () => 'unused');
      await expect(
        orchestrator.run({
          script: `return await pipeline([1, 2], "not a function");`,
          args: undefined,
        }),
      ).rejects.toThrow(/stages must be functions/);
    });

    // TST-1 (P2 self-review): pipeline must share the SAME per-run window as
    // parallel — a pipeline impl that gave itself a separate (or no) limiter
    // would let concurrency exceed the cap. Drive 50 item-chains, each calling
    // one agent per stage, and assert peak in-flight === cap.
    it('caps concurrent agents across a pipeline fan-out (shares the run window)', async () => {
      let inFlight = 0;
      let peak = 0;
      const orchestrator = new WorkflowOrchestrator(async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return 'ok';
      });
      await orchestrator.run({
        script: `return await pipeline(
          Array.from({ length: 50 }, (_, i) => i),
          (x) => agent("s1-" + x),
        );`,
        args: undefined,
      });
      const cap = Math.max(1, Math.min(16, os.cpus().length - 2));
      expect(peak).toBe(cap);
    });

    // TST-2 (P2 self-review): pipeline is parallel-of-chains — STAGGERED, with
    // NO inter-stage barrier. Item 0's chain (fast) must reach stage 2 long
    // before item 1's slow stage 1 finishes. A barrier impl (all items clear
    // stage 1 before any enters stage 2) would delay s2-0 until ~120ms; the
    // staggered impl reaches it in ~a few ms. The 50ms threshold cleanly
    // separates the two regardless of machine speed.
    it('is staggered with no inter-stage barrier (item A reaches stage 2 before item B finishes stage 1)', async () => {
      const log: Array<{ p: string; t: number }> = [];
      const t0 = Date.now();
      const orchestrator = new WorkflowOrchestrator(async (prompt) => {
        log.push({ p: prompt, t: Date.now() - t0 });
        // Only item 1's first stage is slow.
        await new Promise((r) => setTimeout(r, prompt === 's1-1' ? 120 : 2));
        return 'ok';
      });
      // Stage 2's first arg is the PREVIOUS stage's result; use the `item`
      // arg (2nd) to label by the original item.
      await orchestrator.run({
        script: `return await pipeline([0, 1],
          (prev, item) => agent("s1-" + item),
          (prev, item) => agent("s2-" + item),
        );`,
        args: undefined,
      });
      const s2of0 = log.find((e) => e.p === 's2-0');
      expect(s2of0).toBeDefined();
      // Item 0 entered stage 2 well before item 1's 120ms stage 1 completed.
      expect(s2of0!.t).toBeLessThan(50);
    }, 10_000);
  });

  describe('1000-agent cap', () => {
    it('the 1001st sequential agent() call throws the cap error', async () => {
      const orchestrator = new WorkflowOrchestrator(async () => 'ok');
      await expect(
        orchestrator.run({
          script: `for (let i = 0; i < ${MAX_AGENTS_PER_RUN + 1}; i++) {
            await agent("x");
          }
          return "done";`,
          args: undefined,
        }),
      ).rejects.toThrow(
        new RegExp(`${MAX_AGENTS_PER_RUN} agent\\(\\) calls per run`),
      );
    });

    it('the cap counts agents launched via parallel() — a fan-out cannot bypass it', async () => {
      const orchestrator = new WorkflowOrchestrator(async () => 'ok');
      const outcome = await orchestrator.run({
        script: `return await parallel(
          Array.from({ length: ${MAX_AGENTS_PER_RUN + 1} }, () => () => agent("x"))
        );`,
        args: undefined,
      });
      const arr = outcome.result as Array<string | null>;
      // Exactly 1000 dispatches succeed; the one over the cap becomes null.
      expect(arr.filter((v) => v === 'ok')).toHaveLength(MAX_AGENTS_PER_RUN);
      expect(arr.filter((v) => v === null)).toHaveLength(1);
    });
  });

  describe('abort', () => {
    it('parallel() rejects (not silent nulls) when the run is aborted', async () => {
      const ac = new AbortController();
      ac.abort();
      const orchestrator = new WorkflowOrchestrator(async () => 'ok');
      await expect(
        orchestrator.run({
          script: `return await parallel([() => agent("a"), () => agent("b")]);`,
          args: undefined,
          abortOnTimeout: ac,
        }),
      ).rejects.toThrow(/abort/i);
    });

    // TST-3 (P2 self-review): the pre-aborted case above only exercises the
    // fast-path. Abort MID-FLIGHT — after dispatches have already started —
    // and confirm parallel() rejects rather than resolving with a silent array
    // of nulls (which would let an aborted/timed-out workflow continue).
    it('parallel() rejects when aborted MID-FLIGHT (after dispatches started)', async () => {
      const ac = new AbortController();
      let dispatched = 0;
      const orchestrator = new WorkflowOrchestrator(async () => {
        dispatched++;
        await new Promise((r) => setTimeout(r, 40));
        return 'ok';
      });
      const p = orchestrator.run({
        script: `return await parallel(
          Array.from({ length: 6 }, () => () => agent("x"))
        );`,
        args: undefined,
        abortOnTimeout: ac,
      });
      // Abort once at least one dispatch is in flight.
      setTimeout(() => ac.abort(), 10);
      await expect(p).rejects.toThrow(/abort/i);
      expect(dispatched).toBeGreaterThan(0);
    }, 10_000);
  });
});
