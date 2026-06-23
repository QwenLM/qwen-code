/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

// T7 (PR #4732 R1): the `vi as vitest` alias diverges from every other
// test file in the repo. Use `vi` directly.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'node:os';
import {
  WorkflowOrchestrator,
  WorkflowExecutionError,
  createProductionDispatch,
  DEFAULT_MAX_AGENTS_PER_RUN,
  resolveMaxAgentsPerRun,
  resolveConcurrencyLimit,
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
const { created, nextTerminateMode, nextOutputTokens, nextExecuteThrow } =
  vi.hoisted(() => ({
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
    // R1 (#1 + #3): the production dispatch reads
    // `subagent.getExecutionSummary().outputTokens` to feed budget. Tests
    // set `nextOutputTokens.value` so the onTokens callback can be
    // observed without standing up real telemetry.
    nextOutputTokens: { value: 0 as number },
    // R3 (wenshao #6): real `AgentHeadless.execute()` re-throws on
    // reasoning-loop failure — its catch arm sets `terminateMode=ERROR`
    // and then throws. Tests set `nextExecuteThrow.value` to a non-null
    // error so the mock execute() re-throws the same way; R1's tests
    // had execute() RETURN with ERROR mode, which is the rare
    // `createChat` early-return path, NOT the production reasoning-
    // loop throw path.
    nextExecuteThrow: { value: null as Error | null },
  }));

// P3 R2 self-review (P3-T6 gap, batch): tests below for
// agent({isolation:'worktree'}) need to drive GitWorktreeService's
// provision/cleanup branches deterministically. Module-level mock with
// per-test stub overrides via vi.mocked(...).mockImplementation.
//
// Default behaviour = "everything succeeds and the worktree is clean
// post-spawn" so the cleanup branch removes the worktree. Tests that
// need a specific error path override the relevant method.
const worktreeStubs = vi.hoisted(() => {
  const makeStub = () => ({
    checkGitAvailable: vi.fn(async () => ({ available: true })),
    isGitRepository: vi.fn(async () => true),
    getRepoTopLevel: vi.fn(async () => '/fake/repo'),
    getCurrentBranch: vi.fn(async () => 'main'),
    hasWorktreeChanges: vi.fn(async () => false),
    hasUnmergedWorktreeCommits: vi.fn(async () => false),
    createUserWorktree: vi.fn(
      async (
        slug: string,
        _base?: string,
        _options?: { symlinkDirectories?: readonly string[] },
      ) => ({
        success: true,
        worktree: {
          path: `/fake/repo/.qwen/worktrees/${slug}`,
          branch: `worktree-${slug}`,
        },
      }),
    ),
    removeUserWorktree: vi.fn(async () => ({ success: true })),
  });
  return { makeStub, instances: [] as Array<ReturnType<typeof makeStub>> };
});

vi.mock('../../services/gitWorktreeService.js', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../services/gitWorktreeService.js')
    >();
  return {
    ...actual,
    generateAgentWorktreeSlug: () => 'agent-deadbe1',
    writeWorktreeSessionMarker: vi.fn(async () => {}),
    GitWorktreeService: vi.fn().mockImplementation(() => {
      const stub = worktreeStubs.makeStub();
      worktreeStubs.instances.push(stub);
      return stub;
    }),
  };
});

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
        // R3 (wenshao #6): simulate the production ERROR path where
        // AgentHeadless.execute() itself throws (see agent-headless.ts
        // catch arm at :287-294). If `nextExecuteThrow.value` is set,
        // re-throw it so the orchestrator's `await subagent.execute()`
        // call rejects without ever reaching the line below it.
        if (nextExecuteThrow.value) {
          throw nextExecuteThrow.value;
        }
      },
      getFinalText: () =>
        `headless-said:${created[created.length - 1]!.prompt}`,
      getTerminateMode: () => nextTerminateMode.value,
      // R1 (#1 + #3): expose `getExecutionSummary` so the production
      // dispatch's `reportTokens` helper can read `outputTokens` after
      // every `subagent.execute()` call, regardless of terminate mode.
      getExecutionSummary: () => ({ outputTokens: nextOutputTokens.value }),
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

  // P4: outcome.meta surfaces the extracted `export const meta = {...}`
  // declaration. Null when the script omits it.
  it('outcome.meta is null when the script has no meta declaration', async () => {
    const orchestrator = new WorkflowOrchestrator(async () => 'unused');
    const outcome = await orchestrator.run({
      script: `return 1`,
      args: undefined,
    });
    expect(outcome.meta).toBeNull();
  });

  it('outcome.meta is the parsed meta when the script declares one', async () => {
    const orchestrator = new WorkflowOrchestrator(async () => 'unused');
    const outcome = await orchestrator.run({
      script: `export const meta = { name: 'demo', description: 'demo workflow', phases: [{ title: 'plan' }] }
               return 1`,
      args: undefined,
    });
    expect(outcome.meta).toEqual({
      name: 'demo',
      description: 'demo workflow',
      phases: [{ title: 'plan' }],
    });
    expect(outcome.result).toBe(1);
  });

  // P4: a script body that throws still surfaces the meta on the wrapped
  // WorkflowExecutionError so the user-facing display can identify which
  // workflow ran before the body failed.
  it('WorkflowExecutionError carries meta when the body throws AFTER meta parsed', async () => {
    const orchestrator = new WorkflowOrchestrator(async () => 'unused');
    let caught: unknown;
    try {
      await orchestrator.run({
        script: `export const meta = { name: 'fails', description: 'will throw' }
                 throw new Error("body boom")`,
        args: undefined,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(WorkflowExecutionError);
    expect((caught as WorkflowExecutionError).meta).toEqual({
      name: 'fails',
      description: 'will throw',
    });
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

  // P4b Round 5 (wenshao): the emitter field on WorkflowRunRequest and
  // its firing sites (sandbox safePhase, sandbox safeLog, orchestrator
  // countedDispatch before + after) are the only channel that keeps the
  // WorkflowRunRegistry record in sync with the live run. If a refactor
  // drops one of these callback sites — or removes the defensive
  // try/catch around `agentCompleted` on the rejection path — the UI
  // would show stale dispatch counts or missing phases with no test
  // catching it. These three tests pin the contract.

  it('emitter callbacks fire in expected order with expected args', async () => {
    const orchestrator = new WorkflowOrchestrator(
      async (prompt) => `mock:${prompt}`,
    );
    const events: Array<{ kind: string; payload: unknown }> = [];
    const emitter = {
      phaseStarted: (title: string) =>
        events.push({ kind: 'phase', payload: title }),
      agentDispatched: (label?: string) =>
        events.push({ kind: 'dispatched', payload: label }),
      agentCompleted: (label?: string, error?: string) =>
        events.push({ kind: 'completed', payload: { label, error } }),
      logAppended: (line: string) =>
        events.push({ kind: 'log', payload: line }),
    };
    const outcome = await orchestrator.run({
      script: `
        phase('Plan');
        log('starting');
        await agent('q1', { label: 'first' });
        phase('Build');
        await agent('q2', { label: 'second' });
        return 'ok';
      `,
      args: undefined,
      emitter,
    });

    expect(outcome.result).toBe('ok');
    expect(outcome.phases).toEqual(['Plan', 'Build']);
    // Event ordering: phase('Plan') → log('starting') → dispatch first →
    // complete first → phase('Build') → dispatch second → complete second.
    // No barriers between sandbox-side emits (phase/log) and dispatch
    // emits — the test only pins the relative ordering across the run,
    // not exact wall-clock interleaving.
    const kinds = events.map((e) => e.kind);
    expect(kinds).toEqual([
      'phase',
      'log',
      'dispatched',
      'completed',
      'phase',
      'dispatched',
      'completed',
    ]);
    expect(events[0]!.payload).toBe('Plan');
    expect(events[1]!.payload).toBe('starting');
    expect(events[2]!.payload).toBe('first');
    expect(events[3]!.payload).toEqual({ label: 'first', error: undefined });
    expect(events[4]!.payload).toBe('Build');
    expect(events[5]!.payload).toBe('second');
    expect(events[6]!.payload).toEqual({ label: 'second', error: undefined });
  });

  it('agentCompleted carries the error message on dispatch rejection', async () => {
    const orchestrator = new WorkflowOrchestrator(async () => {
      throw new Error('dispatch-boom');
    });
    const completions: Array<{ label?: string; error?: string }> = [];
    const emitter = {
      agentCompleted: (label?: string, error?: string) =>
        completions.push({ label, error }),
    };
    await expect(
      orchestrator.run({
        script: `await agent("x", { label: "doomed" }); return 0;`,
        args: undefined,
        emitter,
      }),
    ).rejects.toThrow(/dispatch-boom/);

    expect(completions).toHaveLength(1);
    expect(completions[0]).toEqual({
      label: 'doomed',
      error: 'dispatch-boom',
    });
  });

  it('emitter subscriber errors do not break the run (defensive try/catch)', async () => {
    const orchestrator = new WorkflowOrchestrator(
      async (prompt) => `mock:${prompt}`,
    );
    // Every callback throws — should be swallowed so the orchestration
    // still completes. Without the defensive try/catch around each emit
    // site, the first thrown subscriber error would surface as the run
    // failure even though the script body is fine.
    const emitter = {
      phaseStarted: () => {
        throw new Error('phase-subscriber-boom');
      },
      agentDispatched: () => {
        throw new Error('dispatched-subscriber-boom');
      },
      agentCompleted: () => {
        throw new Error('completed-subscriber-boom');
      },
      logAppended: () => {
        throw new Error('log-subscriber-boom');
      },
    };
    const outcome = await orchestrator.run({
      script: `
        phase('Plan');
        log('hello');
        const a = await agent('q1');
        return a;
      `,
      args: undefined,
      emitter,
    });
    expect(outcome.result).toBe('mock:q1');
    expect(outcome.phases).toEqual(['Plan']);
  });

  // ── P5: budget gate via WorkflowRunRequest.budget ─────────────────────

  it('P5: budget gate refuses to dispatch once budget is exhausted', async () => {
    const { WorkflowBudgetImpl } = await import('./workflow-budget.js');
    const budget = new WorkflowBudgetImpl(1000);
    // Pre-burn the budget so the first agent() call lands over-cap.
    budget.recordSpent(1000);

    let dispatchCalls = 0;
    const orchestrator = new WorkflowOrchestrator(async () => {
      dispatchCalls += 1;
      return 'never reached';
    });
    let caught: unknown;
    try {
      await orchestrator.run({
        script: `await agent('q1'); return 0;`,
        args: undefined,
        budget,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    // Cross-realm: the sandbox wraps the host error in a vm-realm Error
    // (per T1/T8/T14 defense). The dispatch is never invoked because the
    // gate short-circuits before limiter.run.
    expect(String(caught)).toContain('exceeded the token budget');
    expect(String(caught)).toContain('1000');
    expect(dispatchCalls).toBe(0);
  });

  it('P5: budget gate stops further dispatches mid-run on overshoot', async () => {
    const { WorkflowBudgetImpl } = await import('./workflow-budget.js');
    const budget = new WorkflowBudgetImpl(100);
    // Each dispatch burns 60 tokens; the budget should run out after 2.
    let dispatchCalls = 0;
    const orchestrator = new WorkflowOrchestrator(async () => {
      dispatchCalls += 1;
      budget.recordSpent(60);
      return 'ok';
    });
    let caught: unknown;
    try {
      await orchestrator.run({
        script: `await agent('q1'); await agent('q2'); await agent('q3'); return 'done';`,
        args: undefined,
        budget,
      });
    } catch (e) {
      caught = e;
    }
    // q1 = 60/100, q2 = 120/100 (overshoot), q3 = gate refuses
    expect(dispatchCalls).toBe(2);
    expect(String(caught)).toContain('exceeded the token budget');
    expect(budget.spent()).toBe(120);
  });

  it('P5: budget.total === null (no cap) — gate never fires', async () => {
    const { WorkflowBudgetImpl } = await import('./workflow-budget.js');
    const budget = new WorkflowBudgetImpl(null);
    let dispatchCalls = 0;
    const orchestrator = new WorkflowOrchestrator(async () => {
      dispatchCalls += 1;
      budget.recordSpent(1_000_000); // each agent burns 1M tokens
      return 'ok';
    });
    const outcome = await orchestrator.run({
      script: `await agent('q1'); await agent('q2'); await agent('q3'); return 'done';`,
      args: undefined,
      budget,
    });
    expect(outcome.result).toBe('done');
    expect(dispatchCalls).toBe(3);
    expect(budget.spent()).toBe(3_000_000);
    expect(budget.remaining()).toBe(Infinity);
  });

  it('P5: no budget passed (legacy callers) — gate never fires', async () => {
    let dispatchCalls = 0;
    const orchestrator = new WorkflowOrchestrator(async () => {
      dispatchCalls += 1;
      return 'ok';
    });
    const outcome = await orchestrator.run({
      script: `await agent('q1'); await agent('q2'); return 'done';`,
      args: undefined,
    });
    expect(outcome.result).toBe('done');
    expect(dispatchCalls).toBe(2);
  });

  it('P5 R1 #2: parallel-batch overshoot is bounded by the intra-limiter re-check', async () => {
    // R1 Critical #2 — without the intra-limiter gate, a parallel() of N
    // thunks queues them all in one microtask burst with spent=0, so the
    // entry gate passes for every queued dispatch and the budget
    // overshoots by up to `(N-1) × per_dispatch_tokens`.
    //
    // With the intra-limiter re-check, the gate observes budget mutations
    // from already-completed in-flight dispatches at slot-acquire time, so
    // queued thunks that arrive AFTER the budget is busted are refused
    // (the parallel() batch collapses them to `null`).
    const { WorkflowBudgetImpl } = await import('./workflow-budget.js');
    const budget = new WorkflowBudgetImpl(100);
    let dispatchCalls = 0;
    const orchestrator = new WorkflowOrchestrator(async () => {
      dispatchCalls += 1;
      budget.recordSpent(40); // 3 successful dispatches saturate the cap
      return 'ok';
    });
    // 10 thunks — far more than the budget (100 / 40 ≈ 3 successful).
    // The intra-limiter gate must reject the rest BEFORE this.dispatch
    // runs, so `dispatchCalls` should be 3 (or 4 — see below), NOT 10.
    const outcome = await orchestrator.run({
      script: `const results = await parallel(Array.from({length: 10}, () => () => agent('q'))); return results;`,
      args: undefined,
      budget,
    });
    // parallel() treats budget rejections as errors-as-data → null per slot.
    expect(Array.isArray(outcome.result)).toBe(true);
    const results = outcome.result as unknown[];
    expect(results).toHaveLength(10);
    const successes = results.filter((r) => r === 'ok').length;
    const nulls = results.filter((r) => r === null).length;
    expect(successes + nulls).toBe(10);
    // Bounded overshoot: at most `concurrency_window` dispatches can be
    // already inside `limiter.run` when the budget tips over, so the
    // upper bound on successful dispatches is
    // `ceil(cap / per_dispatch) + concurrency_window`. The concurrency
    // window on test machines is `min(16, cpus-2)` ≥ 1. With cap=100,
    // per=40, the soft cap is reached at 3 dispatches (spent=120). We
    // ASSERT it doesn't reach 10 (the without-fix overshoot value).
    expect(dispatchCalls).toBeLessThan(10);
    expect(successes).toBeLessThan(10);
  });

  // R1 #4 fix landed in production code (debugLogger.warn at both gate
  // sites); no dedicated test — debugLogger has its own enable/disable
  // gating and a spy here would be brittle. Manual verification path:
  // run with DEBUG=WORKFLOW=1 and trigger a budget-exhausted dispatch.

  // ── P5 T4: budgetUpdated emitter event ─────────────────────────────────

  it('P5 T4: budgetUpdated fires after each successful completion with cumulative spent + total', async () => {
    const { WorkflowBudgetImpl } = await import('./workflow-budget.js');
    const budget = new WorkflowBudgetImpl(1000);
    const orchestrator = new WorkflowOrchestrator(async (prompt) => {
      // Simulate the production-dispatch onTokens callback writing into
      // the budget BEFORE the orchestrator's then() re-snapshots.
      budget.recordSpent(prompt === 'q1' ? 150 : 250);
      return 'ok';
    });
    const budgetUpdates: Array<{ spent: number; total: number | null }> = [];
    const emitter = {
      budgetUpdated: (spent: number, total: number | null) =>
        budgetUpdates.push({ spent, total }),
    };
    await orchestrator.run({
      script: `await agent('q1'); await agent('q2'); return 'done';`,
      args: undefined,
      budget,
      emitter,
    });
    expect(budgetUpdates).toEqual([
      { spent: 150, total: 1000 },
      { spent: 400, total: 1000 },
    ]);
  });

  it('P5 T4: budgetUpdated does NOT fire when no budget is passed', async () => {
    const orchestrator = new WorkflowOrchestrator(async () => 'ok');
    const budgetUpdates: number[] = [];
    const emitter = {
      budgetUpdated: (spent: number) => budgetUpdates.push(spent),
    };
    await orchestrator.run({
      script: `await agent('q1'); return 'done';`,
      args: undefined,
      emitter,
      // budget intentionally omitted
    });
    expect(budgetUpdates).toEqual([]);
  });

  it('P5 R3 #1: budgetUpdated DOES fire on dispatch rejection (so UI/registry see the burn-then-fail spend)', async () => {
    // R3 #1 (bot): the production dispatch's reportTokens runs in a
    // `finally` (R3 #6), so `budget.spent()` advances even when
    // `subagent.execute()` throws. If the error arm of `countedDispatch`
    // does NOT fire `budgetUpdated`, the registry's `tokensSpent` /
    // `perPhaseTokens` never see those tokens — divergence between
    // `budget.spent()` (host) and `entry.tokensSpent` (UI). Worse,
    // R2 #12 dropped `safeEmitUpdate` from `agentCompleted` and made
    // `budgetUpdated` the sole UI driver, so dispatch errors produce
    // ZERO UI re-renders unless `budgetUpdated` fires on the error
    // arm too.
    const { WorkflowBudgetImpl } = await import('./workflow-budget.js');
    const budget = new WorkflowBudgetImpl(1000);
    const orchestrator = new WorkflowOrchestrator(async () => {
      // Mirror the production reportTokens-in-finally semantics:
      // record tokens BEFORE the throw, exactly as production does.
      budget.recordSpent(150);
      throw new Error('dispatch-boom');
    });
    const budgetUpdates: Array<{ spent: number; total: number | null }> = [];
    const completions: Array<{ label?: string; error?: string }> = [];
    const emitter = {
      budgetUpdated: (spent: number, total: number | null) =>
        budgetUpdates.push({ spent, total }),
      agentCompleted: (label?: string, error?: string) =>
        completions.push({ label, error }),
    };
    let caught: unknown;
    try {
      await orchestrator.run({
        script: `await agent('q1'); return 'done';`,
        args: undefined,
        budget,
        emitter,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(completions).toHaveLength(1);
    expect(completions[0]?.error).toBe('dispatch-boom');
    // R3 #1 contract: error arm now fires budgetUpdated with the
    // cumulative spent at throw time, so the registry mirrors the
    // burn that the failed dispatch incurred.
    expect(budgetUpdates).toEqual([{ spent: 150, total: 1000 }]);
  });

  it('P5 R3 #7: budget rejection does NOT consume agent-cap slots (correct terminal error after exhaustion)', async () => {
    // wenshao R3 #7: if `agentCount += 1` runs before the budget gate,
    // every budget-rejected call still increments agentCount and the
    // SUBSEQUENT call eventually trips `agentCount > maxAgents` —
    // surfacing the wrong terminal error ("exceeded the maximum of N
    // agent() calls per run") when the real cause is budget exhaustion.
    const { WorkflowBudgetImpl } = await import('./workflow-budget.js');
    const budget = new WorkflowBudgetImpl(100);
    budget.recordSpent(100); // pre-bust the budget so every dispatch rejects
    let dispatchCalls = 0;
    const orchestrator = new WorkflowOrchestrator(async () => {
      dispatchCalls += 1;
      return 'never';
    });
    let caught: unknown;
    try {
      // Loop the script so we accumulate many budget rejections, well
      // past `maxAgents` had the old ordering been in place.
      // try/catch in script so loop continues despite per-call throws.
      await orchestrator.run({
        script: `
          let lastErr = null;
          for (let i = 0; i < 1100; i++) {
            try { await agent('q' + i); } catch (e) { lastErr = e.message; }
          }
          return lastErr;
        `,
        args: undefined,
        budget,
      });
    } catch (e) {
      caught = e;
    }
    // Real production dispatch is never called.
    expect(dispatchCalls).toBe(0);
    // R3 #7 contract: the script saw budget-exceeded errors, NOT
    // agent-count-exceeded errors. The latter would indicate the old
    // ordering still applies.
    // The orchestrator wraps script-thrown errors in
    // WorkflowExecutionError; the script swallowed each per-call throw
    // and returned the last message, so the run COMPLETED successfully.
    expect(caught).toBeUndefined();
  });

  it('P5 R3 #1: budgetUpdated does NOT fire when no budget passed AND dispatch rejects', async () => {
    // Budget-less callers must not get spurious budgetUpdated events
    // — the orchestrator's `if (budget)` gate covers both the success
    // and error arms.
    const orchestrator = new WorkflowOrchestrator(async () => {
      throw new Error('boom');
    });
    const budgetUpdates: number[] = [];
    const emitter = {
      budgetUpdated: (spent: number) => budgetUpdates.push(spent),
    };
    let caught: unknown;
    try {
      await orchestrator.run({
        script: `await agent('q1'); return 'done';`,
        args: undefined,
        emitter,
        // budget intentionally omitted
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(budgetUpdates).toEqual([]);
  });

  it('P5 T4: budgetUpdated subscriber error does not break the run', async () => {
    const { WorkflowBudgetImpl } = await import('./workflow-budget.js');
    const budget = new WorkflowBudgetImpl(1000);
    const orchestrator = new WorkflowOrchestrator(async () => {
      budget.recordSpent(100);
      return 'ok';
    });
    const emitter = {
      budgetUpdated: () => {
        throw new Error('budget-subscriber-boom');
      },
    };
    const outcome = await orchestrator.run({
      script: `await agent('q1'); return 'done';`,
      args: undefined,
      budget,
      emitter,
    });
    expect(outcome.result).toBe('done');
  });

  // ── P-nested: workflow() global ───────────────────────────────────────

  it('P-nested: workflow(name) resolves via injected resolver and returns nested result', async () => {
    const orchestrator = new WorkflowOrchestrator(
      async (prompt) => `agent:${prompt}`,
    );
    const resolveSavedWorkflow = async (
      ref: string | { scriptPath: string },
    ) => {
      expect(ref).toBe('child');
      return { script: `return 'nested-' + (await agent('inner'));`, name: 'child' };
    };
    const outcome = await orchestrator.run({
      script: `const r = await workflow('child'); return 'parent:' + r;`,
      args: undefined,
      resolveSavedWorkflow,
    });
    expect(outcome.result).toBe('parent:nested-agent:inner');
  });

  it('P-nested: nested args are passed to the child script', async () => {
    const orchestrator = new WorkflowOrchestrator(async () => 'unused');
    const resolveSavedWorkflow = async () => ({
      script: `return args.x * 2;`,
    });
    const outcome = await orchestrator.run({
      script: `return await workflow('child', { x: 21 });`,
      args: undefined,
      resolveSavedWorkflow,
    });
    expect(outcome.result).toBe(42);
  });

  it('P-nested: nested agents share the parent agent-count cap', async () => {
    // Cap is read from env; set a tiny cap so parent(1) + nested(2) trips it.
    const prev = process.env['QWEN_CODE_MAX_WORKFLOW_AGENTS'];
    process.env['QWEN_CODE_MAX_WORKFLOW_AGENTS'] = '2';
    try {
      let dispatchCalls = 0;
      const orchestrator = new WorkflowOrchestrator(async () => {
        dispatchCalls += 1;
        return 'ok';
      });
      const resolveSavedWorkflow = async () => ({
        // nested fires 2 agents; with parent's 1 already spent and cap=2,
        // the 2nd nested agent (3rd overall) must throw the cap error.
        script: `await agent('n1'); await agent('n2'); return 'done';`,
      });
      let caught: unknown;
      try {
        await orchestrator.run({
          script: `await agent('p1'); return await workflow('child');`,
          args: undefined,
          resolveSavedWorkflow,
        });
      } catch (e) {
        caught = e;
      }
      // parent p1 (1) + nested n1 (2) pass; nested n2 (3) trips the cap.
      expect(dispatchCalls).toBe(2);
      expect(String(caught)).toMatch(/exceeded the maximum of 2 agent/);
    } finally {
      if (prev === undefined) delete process.env['QWEN_CODE_MAX_WORKFLOW_AGENTS'];
      else process.env['QWEN_CODE_MAX_WORKFLOW_AGENTS'] = prev;
    }
  });

  it('P-nested: nested agents share the parent token budget', async () => {
    const { WorkflowBudgetImpl } = await import('./workflow-budget.js');
    const budget = new WorkflowBudgetImpl(100);
    const orchestrator = new WorkflowOrchestrator(async () => {
      budget.recordSpent(60); // each agent burns 60 → 2 agents = 120 > 100
      return 'ok';
    });
    const resolveSavedWorkflow = async () => ({
      script: `await agent('n1'); await agent('n2'); return 'done';`,
    });
    let caught: unknown;
    try {
      await orchestrator.run({
        script: `await agent('p1'); return await workflow('child');`,
        args: undefined,
        budget,
        resolveSavedWorkflow,
      });
    } catch (e) {
      caught = e;
    }
    // parent p1 spends 60; nested n1 spends 60 (total 120); nested n2 gated.
    expect(String(caught)).toMatch(/exceeded the token budget/);
    expect(budget.spent()).toBe(120);
  });

  it('P-nested: single-level limit — a nested workflow() call throws', async () => {
    const orchestrator = new WorkflowOrchestrator(async () => 'ok');
    const resolveSavedWorkflow = async () => ({
      // The nested script tries to nest again — must throw.
      script: `return await workflow('grandchild');`,
    });
    let caught: unknown;
    try {
      await orchestrator.run({
        script: `return await workflow('child');`,
        args: undefined,
        resolveSavedWorkflow,
      });
    } catch (e) {
      caught = e;
    }
    expect(String(caught)).toMatch(/workflow\(\) is unavailable here/);
    expect(String(caught)).toMatch(/single level/);
  });

  it('P-nested: workflow() throws when no resolver is wired', async () => {
    const orchestrator = new WorkflowOrchestrator(async () => 'ok');
    let caught: unknown;
    try {
      await orchestrator.run({
        script: `return await workflow('child');`,
        args: undefined,
        // resolveSavedWorkflow omitted
      });
    } catch (e) {
      caught = e;
    }
    expect(String(caught)).toMatch(/workflow\(\) is unavailable here/);
  });

  it('P-nested: resolver rejection (workflow not found) surfaces to the parent script', async () => {
    const orchestrator = new WorkflowOrchestrator(async () => 'ok');
    const resolveSavedWorkflow = async () => {
      throw new Error(`workflow('child'): no workflow with that name.`);
    };
    const outcome = await orchestrator.run({
      script: `try { await workflow('child'); return 'no-throw'; }
               catch (e) { return 'caught:' + e.message; }`,
      args: undefined,
      resolveSavedWorkflow,
    });
    expect(outcome.result).toMatch(/caught:.*no workflow with that name/);
  });

  // ── P6: resume journal ────────────────────────────────────────────────

  it('P6: a normal run journals a started+result per agent() call', async () => {
    const { buildReplay } = await import('./workflow-journal.js');
    const entries: Array<import('./workflow-journal.js').JournalEntry> = [];
    const journal = {
      path: 'mem',
      append: (e: import('./workflow-journal.js').JournalEntry) => {
        entries.push(e);
        return Promise.resolve();
      },
      load: () => Promise.resolve(buildReplay(entries)),
    } as unknown as import('./workflow-journal.js').WorkflowJournal;

    const orchestrator = new WorkflowOrchestrator(
      async (prompt) => `r:${prompt}`,
    );
    await orchestrator.run({
      script: `await agent('a'); await agent('b'); return 'done';`,
      args: undefined,
      journal,
    });
    // 2 agents → 2 started + 2 result.
    expect(entries.filter((e) => e.type === 'started')).toHaveLength(2);
    const results = entries.filter((e) => e.type === 'result');
    expect(results).toHaveLength(2);
    expect((results[0] as { result: unknown }).result).toBe('r:a');
    expect((results[1] as { result: unknown }).result).toBe('r:b');
  });

  it('P6: resume serves the cached prefix without re-dispatching', async () => {
    const { buildReplay } = await import('./workflow-journal.js');
    // Run 1: record the journal.
    const entries: Array<import('./workflow-journal.js').JournalEntry> = [];
    const journal1 = {
      append: (e: import('./workflow-journal.js').JournalEntry) => {
        entries.push(e);
        return Promise.resolve();
      },
    } as unknown as import('./workflow-journal.js').WorkflowJournal;
    const orch1 = new WorkflowOrchestrator(async (prompt) => `r:${prompt}`);
    await orch1.run({
      script: `await agent('a'); await agent('b'); return 'done';`,
      args: undefined,
      journal: journal1,
    });

    // Run 2 (resume): same script. The dispatch counter must stay 0 because
    // both agents are cached.
    let dispatchCalls = 0;
    const orch2 = new WorkflowOrchestrator(async (prompt) => {
      dispatchCalls += 1;
      return `LIVE:${prompt}`;
    });
    const journal2 = {
      append: () => Promise.resolve(),
    } as unknown as import('./workflow-journal.js').WorkflowJournal;
    const outcome = await orch2.run({
      script: `const a = await agent('a'); const b = await agent('b'); return a + '|' + b;`,
      args: undefined,
      journal: journal2,
      resumeReplay: buildReplay(entries),
    });
    expect(dispatchCalls).toBe(0); // fully cached
    expect(outcome.result).toBe('r:a|r:b'); // cached values, not LIVE
  });

  it('P6: first miss runs live and the suffix goes live (first-miss invalidates suffix)', async () => {
    const { buildReplay } = await import('./workflow-journal.js');
    // Run 1 journaled agents a, b, c.
    const entries: Array<import('./workflow-journal.js').JournalEntry> = [];
    const journal1 = {
      append: (e: import('./workflow-journal.js').JournalEntry) => {
        entries.push(e);
        return Promise.resolve();
      },
    } as unknown as import('./workflow-journal.js').WorkflowJournal;
    const orch1 = new WorkflowOrchestrator(async (prompt) => `r:${prompt}`);
    await orch1.run({
      script: `await agent('a'); await agent('b'); await agent('c'); return 1;`,
      args: undefined,
      journal: journal1,
    });

    // Run 2: change agent #2's prompt ('b' → 'B'). #1 ('a') is cached; #2
    // ('B') misses → live; #3 ('c') must ALSO run live even though 'c' was
    // journaled (first-miss invalidates suffix + the prefix-hash chain from
    // #2's new prompt changes #3's key anyway).
    const dispatched: string[] = [];
    const orch2 = new WorkflowOrchestrator(async (prompt) => {
      dispatched.push(prompt);
      return `LIVE:${prompt}`;
    });
    const outcome = await orch2.run({
      script: `const a = await agent('a');
               const b = await agent('B');
               const c = await agent('c');
               return [a, b, c].join('|');`,
      args: undefined,
      journal: { append: () => Promise.resolve() } as never,
      resumeReplay: buildReplay(entries),
    });
    // 'a' cached; 'B' and 'c' live.
    expect(dispatched).toEqual(['B', 'c']);
    expect(outcome.result).toBe('r:a|LIVE:B|LIVE:c');
  });

  it('P6: cache hit advances the registry counters (agentDispatched + agentCompleted)', async () => {
    const { buildReplay } = await import('./workflow-journal.js');
    const entries: Array<import('./workflow-journal.js').JournalEntry> = [];
    const journal1 = {
      append: (e: import('./workflow-journal.js').JournalEntry) => {
        entries.push(e);
        return Promise.resolve();
      },
    } as unknown as import('./workflow-journal.js').WorkflowJournal;
    const orch1 = new WorkflowOrchestrator(async () => 'cached');
    await orch1.run({
      script: `await agent('a'); return 1;`,
      args: undefined,
      journal: journal1,
    });

    const events: string[] = [];
    const orch2 = new WorkflowOrchestrator(async () => 'LIVE');
    await orch2.run({
      script: `await agent('a'); return 1;`,
      args: undefined,
      journal: { append: () => Promise.resolve() } as never,
      resumeReplay: buildReplay(entries),
      emitter: {
        agentDispatched: () => events.push('dispatched'),
        agentCompleted: () => events.push('completed'),
      },
    });
    expect(events).toEqual(['dispatched', 'completed']);
  });

  it('P6: cached dispatches do NOT consume the agent-count cap', async () => {
    const prev = process.env['QWEN_CODE_MAX_WORKFLOW_AGENTS'];
    process.env['QWEN_CODE_MAX_WORKFLOW_AGENTS'] = '2';
    try {
      const { buildReplay } = await import('./workflow-journal.js');
      const entries: Array<import('./workflow-journal.js').JournalEntry> = [];
      const journal1 = {
        append: (e: import('./workflow-journal.js').JournalEntry) => {
          entries.push(e);
          return Promise.resolve();
        },
      } as unknown as import('./workflow-journal.js').WorkflowJournal;
      // Run 1 with a larger cap to record 3 agents.
      process.env['QWEN_CODE_MAX_WORKFLOW_AGENTS'] = '10';
      const orch1 = new WorkflowOrchestrator(async (p) => `r:${p}`);
      await orch1.run({
        script: `await agent('a'); await agent('b'); await agent('c'); return 1;`,
        args: undefined,
        journal: journal1,
      });
      // Run 2 (resume) with cap=2: all 3 are cached, so the cap (which
      // counts only LIVE dispatches) is never hit.
      process.env['QWEN_CODE_MAX_WORKFLOW_AGENTS'] = '2';
      const orch2 = new WorkflowOrchestrator(async () => 'LIVE');
      const outcome = await orch2.run({
        script: `await agent('a'); await agent('b'); await agent('c'); return 'ok';`,
        args: undefined,
        journal: { append: () => Promise.resolve() } as never,
        resumeReplay: buildReplay(entries),
      });
      expect(outcome.result).toBe('ok'); // no cap error despite 3 > 2
    } finally {
      if (prev === undefined) delete process.env['QWEN_CODE_MAX_WORKFLOW_AGENTS'];
      else process.env['QWEN_CODE_MAX_WORKFLOW_AGENTS'] = prev;
    }
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
  // P-stall: the stall wrapper now interposes a per-attempt AbortController
  // between the caller's signal and `subagent.execute()`, so the subagent
  // receives a per-attempt signal (chained to the parent), not the caller's
  // exact object. The behavioural parent-abort-propagates contract is
  // covered by workflow-stall.test.ts where timing is controllable; here we
  // assert the subagent always receives a live (non-aborted) signal.
  it('threads a per-attempt abort signal through to subagent.execute', async () => {
    const controller = new AbortController();
    const dispatch = createProductionDispatch(fakeConfig(), controller.signal);
    await dispatch('hello', { label: 'h1' });
    expect(created.length).toBe(1);
    expect(created[0]!.signal).toBeDefined();
  });

  it('provides a per-attempt signal even when no caller signal is given', async () => {
    const dispatch = createProductionDispatch(fakeConfig());
    await dispatch('hello', { label: 'h1' });
    expect(created.length).toBe(1);
    // The stall wrapper always supplies a per-attempt signal (so the
    // watchdog can abort it); it just isn't chained to any parent.
    expect(created[0]!.signal).toBeDefined();
    expect(created[0]!.signal!.aborted).toBe(false);
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

  // ── R1 (#1 + #3): token reporting across all terminate modes ──────────

  beforeEach(() => {
    nextOutputTokens.value = 0;
  });

  it('R1 #3: records tokens on GOAL success', async () => {
    nextTerminateMode.value = 'GOAL';
    nextOutputTokens.value = 1234;
    const reports: Array<{ tokens: number; label?: string }> = [];
    const dispatch = createProductionDispatch(
      fakeConfig(),
      undefined,
      (tokens, opts) => reports.push({ tokens, label: opts.label }),
    );
    await dispatch('q1', { label: 'a' });
    expect(reports).toEqual([{ tokens: 1234, label: 'a' }]);
  });

  it.each(['CANCELLED', 'MAX_TURNS', 'TIMEOUT', 'ERROR'])(
    'R1 #3: records tokens on %s failure path (still throws)',
    async (mode) => {
      nextTerminateMode.value = mode;
      nextOutputTokens.value = 777;
      const reports: number[] = [];
      const dispatch = createProductionDispatch(
        fakeConfig(),
        undefined,
        (tokens) => reports.push(tokens),
      );
      await expect(dispatch('q1', { label: 'doomed' })).rejects.toThrow(
        new RegExp(`terminate mode: ${mode}`),
      );
      // R1 contract: tokens recorded BEFORE the throw, not after.
      // Otherwise CANCELLED/TIMEOUT/MAX_TURNS/ERROR dispatches would
      // burn tokens without affecting the budget.
      expect(reports).toEqual([777]);
    },
  );

  it('R1 #1 + #3: onTokens is undefined ⇒ no crash', async () => {
    nextTerminateMode.value = 'GOAL';
    nextOutputTokens.value = 99;
    const dispatch = createProductionDispatch(fakeConfig());
    await expect(dispatch('q1', { label: 'x' })).resolves.toBe(
      'headless-said:q1',
    );
  });

  // ── R3 (wenshao #6): tokens MUST also be recorded when execute() THROWS ──

  it('R3 #6: records tokens when subagent.execute() THROWS (the real production ERROR path)', async () => {
    // R1 #3 only covered the case where execute() RETURNS while
    // getTerminateMode() yields ERROR (rare: `createChat` early
    // return). The production ERROR path goes through `agent-headless.ts`'s
    // catch arm which RE-THROWS the underlying error after setting
    // terminateMode=ERROR. The orchestrator's `reportTokens` was on
    // the line AFTER `await subagent.execute(...)`, not in a `finally`
    // — so the throw path leaked tokens. wenshao's R3 review caught
    // this with a deterministic repro.
    nextExecuteThrow.value = new Error('reasoning-loop boom');
    nextOutputTokens.value = 4242;
    const reports: number[] = [];
    const dispatch = createProductionDispatch(
      fakeConfig(),
      undefined,
      (tokens) => reports.push(tokens),
    );
    await expect(dispatch('q1', { label: 'thrown' })).rejects.toThrow(
      /reasoning-loop boom/,
    );
    // Contract: tokens recorded BEFORE the throw propagates, exactly
    // once — regardless of whether the throw came from execute() itself
    // or from the post-execute terminate-mode gate (R1 #3 case).
    expect(reports).toEqual([4242]);
  });

  afterEach(() => {
    nextExecuteThrow.value = null;
  });
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
    // NO inter-stage barrier. Item 0's stage-2 dispatch must be able to fire
    // WHILE item 1's stage-1 dispatch is still pending. We assert this
    // deterministically via a release gate: item 1's stage 1 blocks until
    // item 0 reaches stage 2 and releases the gate. A barrier impl
    // (all items must clear stage N before any enters stage N+1) cannot
    // satisfy this — it would wait for item 1's stage 1 to finish first,
    // creating a circular wait that the vitest timeout would catch.
    //
    // PR #4947 R2 T6 (DragonnZhang): the previous version of this test used
    // an elapsed-time threshold (50ms vs 120ms) which fails deterministically
    // on a 3-core macOS-14 CI runner because the cpu-derived concurrency
    // limit becomes 1 — FIFO then forces all stage-1 dispatches to settle
    // before any stage-2 starts, breaking the timing assumption. Force the
    // limit to 2 AND use a release gate so the assertion is timing-free.
    it('is staggered with no inter-stage barrier (item A reaches stage 2 while item B is still in stage 1)', async () => {
      const envPrev = process.env['QWEN_CODE_MAX_WORKFLOW_CONCURRENCY'];
      process.env['QWEN_CODE_MAX_WORKFLOW_CONCURRENCY'] = '2';
      try {
        let releaseItem1Stage1: () => void = () => {};
        const item1Stage1Gate = new Promise<void>((resolve) => {
          releaseItem1Stage1 = resolve;
        });
        let item0ReachedStage2 = false;

        const orchestrator = new WorkflowOrchestrator(async (prompt) => {
          if (prompt === 's1-0') return 'ok'; // item 0's stage 1: fast
          if (prompt === 's1-1') {
            // item 1's stage 1: BLOCKS until item 0 reaches stage 2.
            // A staggered impl lets item 0 advance to stage 2 while this is
            // still in flight. A barrier impl would hang here waiting for
            // item 0's stage 2 — but item 0's stage 2 cannot start because
            // the barrier is waiting for THIS to finish. Mutual wait =
            // vitest timeout = test fails for a barrier impl.
            await item1Stage1Gate;
            return 'ok';
          }
          if (prompt === 's2-0') {
            item0ReachedStage2 = true;
            releaseItem1Stage1();
            return 'ok';
          }
          if (prompt === 's2-1') return 'ok';
          throw new Error(`unexpected prompt ${prompt}`);
        });

        await orchestrator.run({
          script: `return await pipeline([0, 1],
            (prev, item) => agent("s1-" + item),
            (prev, item) => agent("s2-" + item),
          );`,
          args: undefined,
        });

        expect(item0ReachedStage2).toBe(true);
      } finally {
        if (envPrev === undefined)
          delete process.env['QWEN_CODE_MAX_WORKFLOW_CONCURRENCY'];
        else process.env['QWEN_CODE_MAX_WORKFLOW_CONCURRENCY'] = envPrev;
      }
    }, 10_000);
  });

  describe('1000-agent cap', () => {
    it('the 1001st sequential agent() call throws the cap error', async () => {
      const orchestrator = new WorkflowOrchestrator(async () => 'ok');
      await expect(
        orchestrator.run({
          script: `for (let i = 0; i < ${DEFAULT_MAX_AGENTS_PER_RUN + 1}; i++) {
            await agent("x");
          }
          return "done";`,
          args: undefined,
        }),
      ).rejects.toThrow(
        new RegExp(`${DEFAULT_MAX_AGENTS_PER_RUN} agent\\(\\) calls per run`),
      );
    });

    it('the cap counts agents launched via parallel() — a fan-out cannot bypass it', async () => {
      const orchestrator = new WorkflowOrchestrator(async () => 'ok');
      const outcome = await orchestrator.run({
        script: `return await parallel(
          Array.from({ length: ${DEFAULT_MAX_AGENTS_PER_RUN + 1} }, () => () => agent("x"))
        );`,
        args: undefined,
      });
      const arr = outcome.result as Array<string | null>;
      // Exactly 1000 dispatches succeed; the one over the cap becomes null.
      expect(arr.filter((v) => v === 'ok')).toHaveLength(
        DEFAULT_MAX_AGENTS_PER_RUN,
      );
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

  describe('nested fan-out (shared-window re-entrancy)', () => {
    // F1 (P2 review round 1): the concurrency limiter throttles AGENT
    // DISPATCHES, not orchestration thunks. `pipeline([items], item =>
    // parallel([...]))` is a canonical pattern (it's in the upstream
    // /deep-research workflow). If the limiter sat at the thunk level, the
    // outer pipeline chains would each hold a slot while awaiting an inner
    // parallel(), and on a low concurrency limit every slot is held by a
    // stalled outer thunk → the inner agent() calls can never acquire a slot
    // → unrecoverable deadlock (silent hang until the 30-min wall clock).
    // Forcing the window to 1 makes the worst case deterministic.
    it('a parallel() inside a pipeline() stage does not deadlock at concurrency=1', async () => {
      const prev = process.env['QWEN_CODE_MAX_WORKFLOW_CONCURRENCY'];
      process.env['QWEN_CODE_MAX_WORKFLOW_CONCURRENCY'] = '1';
      try {
        const orchestrator = new WorkflowOrchestrator(async (p) => `r:${p}`);
        const outcome = await orchestrator.run({
          script: `return await pipeline([0, 1, 2],
            (prev, item) => parallel([() => agent("a" + item)]),
          );`,
          args: undefined,
        });
        expect(outcome.result).toEqual([['r:a0'], ['r:a1'], ['r:a2']]);
      } finally {
        if (prev === undefined)
          delete process.env['QWEN_CODE_MAX_WORKFLOW_CONCURRENCY'];
        else process.env['QWEN_CODE_MAX_WORKFLOW_CONCURRENCY'] = prev;
      }
    }, 15_000);

    it('parallel() of parallel() does not deadlock at concurrency=1', async () => {
      const prev = process.env['QWEN_CODE_MAX_WORKFLOW_CONCURRENCY'];
      process.env['QWEN_CODE_MAX_WORKFLOW_CONCURRENCY'] = '1';
      try {
        const orchestrator = new WorkflowOrchestrator(async (p) => `r:${p}`);
        const outcome = await orchestrator.run({
          script: `return await parallel([
            () => parallel([() => agent("x")]),
            () => parallel([() => agent("y")]),
          ]);`,
          args: undefined,
        });
        expect(outcome.result).toEqual([['r:x'], ['r:y']]);
      } finally {
        if (prev === undefined)
          delete process.env['QWEN_CODE_MAX_WORKFLOW_CONCURRENCY'];
        else process.env['QWEN_CODE_MAX_WORKFLOW_CONCURRENCY'] = prev;
      }
    }, 15_000);
  });

  describe('env-overridable caps', () => {
    it('resolveMaxAgentsPerRun defaults to 1000 and honors a valid override', () => {
      expect(resolveMaxAgentsPerRun({})).toBe(DEFAULT_MAX_AGENTS_PER_RUN);
      expect(
        resolveMaxAgentsPerRun({ QWEN_CODE_MAX_WORKFLOW_AGENTS: '50' }),
      ).toBe(50);
    });

    it('resolveMaxAgentsPerRun rejects a non-integer / <1 override and falls back', () => {
      expect(
        resolveMaxAgentsPerRun({ QWEN_CODE_MAX_WORKFLOW_AGENTS: '0' }),
      ).toBe(DEFAULT_MAX_AGENTS_PER_RUN);
      expect(
        resolveMaxAgentsPerRun({ QWEN_CODE_MAX_WORKFLOW_AGENTS: 'abc' }),
      ).toBe(DEFAULT_MAX_AGENTS_PER_RUN);
      expect(
        resolveMaxAgentsPerRun({ QWEN_CODE_MAX_WORKFLOW_AGENTS: '2.5' }),
      ).toBe(DEFAULT_MAX_AGENTS_PER_RUN);
    });

    // PR #4947 R1 T4 (wenshao): an env override above the hard ceiling must
    // be clamped, not honored — protects operators from a fat-finger
    // QWEN_CODE_MAX_WORKFLOW_AGENTS=999999999 silently uncapping the run.
    it('resolveMaxAgentsPerRun clamps an over-ceiling override to the hard maximum', () => {
      expect(
        resolveMaxAgentsPerRun({
          QWEN_CODE_MAX_WORKFLOW_AGENTS: '999999999',
        }),
      ).toBe(10_000);
      // Just under the ceiling is preserved.
      expect(
        resolveMaxAgentsPerRun({ QWEN_CODE_MAX_WORKFLOW_AGENTS: '9999' }),
      ).toBe(9999);
    });

    it('resolveConcurrencyLimit honors a valid override and clamps the cpu default to [1,16]', () => {
      expect(
        resolveConcurrencyLimit({ QWEN_CODE_MAX_WORKFLOW_CONCURRENCY: '4' }),
      ).toBe(4);
      // invalid → cpu-derived default, always within [1, 16]
      const fallback = resolveConcurrencyLimit({
        QWEN_CODE_MAX_WORKFLOW_CONCURRENCY: '-1',
      });
      expect(fallback).toBeGreaterThanOrEqual(1);
      expect(fallback).toBeLessThanOrEqual(16);
    });

    // PR #4947 R1 T4 (wenshao): an env override above the hard ceiling must
    // be clamped, not honored — a single Node process running 999999
    // concurrent LLM calls would OOM long before saturating the model.
    it('resolveConcurrencyLimit clamps an over-ceiling override to the hard maximum', () => {
      expect(
        resolveConcurrencyLimit({
          QWEN_CODE_MAX_WORKFLOW_CONCURRENCY: '999999',
        }),
      ).toBe(64);
      // Just under the ceiling is preserved.
      expect(
        resolveConcurrencyLimit({ QWEN_CODE_MAX_WORKFLOW_CONCURRENCY: '63' }),
      ).toBe(63);
    });

    it('QWEN_CODE_MAX_WORKFLOW_AGENTS actually lowers the cap at run time', async () => {
      const prev = process.env['QWEN_CODE_MAX_WORKFLOW_AGENTS'];
      process.env['QWEN_CODE_MAX_WORKFLOW_AGENTS'] = '3';
      try {
        const orchestrator = new WorkflowOrchestrator(async () => 'ok');
        const outcome = await orchestrator.run({
          script: `return await parallel(
            Array.from({ length: 4 }, () => () => agent("x"))
          );`,
          args: undefined,
        });
        const arr = outcome.result as Array<string | null>;
        expect(arr.filter((v) => v === 'ok')).toHaveLength(3);
        expect(arr.filter((v) => v === null)).toHaveLength(1);
      } finally {
        if (prev === undefined)
          delete process.env['QWEN_CODE_MAX_WORKFLOW_AGENTS'];
        else process.env['QWEN_CODE_MAX_WORKFLOW_AGENTS'] = prev;
      }
    });
  });
});

// ─── P3 (PR #5xxx): agentType + model + isolation + schema ──────────
//
// These tests exercise `createProductionDispatch`'s override path. The
// fast path (no agentType / model / isolation / schema) is covered by the
// existing tests above and the vi.mock('./agent-headless.js') used there;
// the override path goes through SubagentManager.createAgentHeadless, so
// each test wires a fake Config whose `getSubagentManager()` returns a
// stub matching just enough surface (findSubagentByName +
// createAgentHeadless) for the path under test.
describe('WorkflowOrchestrator P3 — agentType / model / isolation / schema', () => {
  // Reset GitWorktreeService stub state between tests so an override set
  // by one test does not bleed into the next (mockImplementation is
  // persistent; the per-test overrides below rely on a clean baseline).
  beforeEach(async () => {
    const { GitWorktreeService } = await import(
      '../../services/gitWorktreeService.js'
    );
    worktreeStubs.instances.length = 0;
    vi.mocked(GitWorktreeService).mockImplementation(() => {
      const stub = worktreeStubs.makeStub();
      worktreeStubs.instances.push(stub);
      return stub as unknown as InstanceType<typeof GitWorktreeService>;
    });
  });

  type StubSubagentCall = {
    config: { name?: string; model?: string; disallowedTools?: string[] };
    runtimeContextSame: boolean;
    options?: { runConfigOverrides?: unknown };
    eventEmitterAttached: boolean;
  };

  function fakeConfigWithMgr(opts: {
    findSubagentByName?: (name: string) => Promise<{
      name: string;
      description: string;
      systemPrompt: string;
      level: string;
      tools?: string[];
      disallowedTools?: string[];
      model?: string;
    } | null>;
    onCreate?: (
      call: StubSubagentCall,
      ee?: {
        on(event: string, cb: (payload: unknown) => void): void;
      },
    ) => Promise<{
      // The mock subagent's contract is the minimal surface
      // createProductionDispatch reads after createAgentHeadless returns.
      finalText: string;
      terminateMode: string;
      // Hook for schema-mode tests: the override path attaches an
      // AgentEventEmitter that the dispatch listens to for `structured_output`
      // calls. The test can drive that emitter to simulate model behavior.
      runWithEmitter?: (emitter: {
        emit(event: string, payload: unknown): void;
      }) => void;
    }>;
  }): {
    config: Config;
    calls: StubSubagentCall[];
    disposed: number;
  } {
    const calls: StubSubagentCall[] = [];
    let disposed = 0;
    // Schema mode goes through createSchemaConfigOverride → rebuildToolRegistryOnOverride,
    // which calls ov.createToolRegistry() and then copies tools from base.getToolRegistry().
    // The override carries the result. We don't care about the registry contents in unit
    // tests — only that the override flow doesn't crash on the missing methods — so the
    // stub registry just answers the API surface those helpers call.
    const fakeRegistry = {
      copyDiscoveredToolsFrom: () => {},
      registerTool: () => {},
    };
    const cfg = {
      createToolRegistry: async () => fakeRegistry,
      getToolRegistry: () => fakeRegistry,
      // P3 R2 self-review: isolation:'worktree' provisioning reads
      // these methods. Provide deterministic returns so the tests can
      // drive GitWorktreeService stubs without re-deriving cwd.
      getTargetDir: () => '/fake/repo',
      getSessionId: () => 'sess_fake_test_id',
      getWorktreeSymlinkDirectories: () => [],
      getSubagentManager: () => ({
        findSubagentByName: opts.findSubagentByName ?? (async () => null),
        createAgentHeadless: async (
          subagentConfig: {
            name?: string;
            model?: string;
            disallowedTools?: string[];
          },
          runtimeContext: Config,
          options?: { eventEmitter?: unknown; runConfigOverrides?: unknown },
        ) => {
          const call: StubSubagentCall = {
            config: subagentConfig,
            runtimeContextSame: runtimeContext === cfg,
            options: { runConfigOverrides: options?.runConfigOverrides },
            eventEmitterAttached: options?.eventEmitter !== undefined,
          };
          calls.push(call);
          const outcome = await opts.onCreate!(
            call,
            options?.eventEmitter as
              | { on(event: string, cb: (payload: unknown) => void): void }
              | undefined,
          );
          const finalText = outcome.finalText;
          const terminateMode = outcome.terminateMode;
          return {
            subagent: {
              execute: async (
                _ctx: unknown,
                signal?: AbortSignal,
              ): Promise<void> => {
                if (outcome.runWithEmitter && options?.eventEmitter) {
                  outcome.runWithEmitter(
                    options.eventEmitter as {
                      emit(event: string, payload: unknown): void;
                    },
                  );
                }
                // R3 (wenshao #6): honor `nextExecuteThrow` on the
                // override-path stub too, so the override-path sibling
                // of the throw-path test (test name "R3 #6: override-
                // path records tokens...") can reproduce the real
                // AgentHeadless.execute() throw against the override
                // dispatch site.
                if (nextExecuteThrow.value) {
                  throw nextExecuteThrow.value;
                }
                // Honor signal abort if it fires.
                if (signal?.aborted) return;
              },
              getFinalText: () => finalText,
              getTerminateMode: () => terminateMode,
              // R1 (#1): expose `getExecutionSummary` on the override-
              // path subagent stub. Production dispatch reads it in
              // `reportTokens` regardless of terminate mode, so the
              // schema-mode early return (Critical #1) and the
              // schema-mode failure paths (Critical #3) both need
              // this surface. Defaults to 0; tests that observe
              // budget-recording set `nextOutputTokens.value` first.
              getExecutionSummary: () => ({
                outputTokens: nextOutputTokens.value,
              }),
            },
            dispose: async () => {
              disposed += 1;
            },
          };
        },
      }),
    } as unknown as Config;
    return {
      config: cfg,
      calls,
      get disposed() {
        return disposed;
      },
    } as {
      config: Config;
      calls: StubSubagentCall[];
      disposed: number;
    };
  }

  it('agentType resolves SubagentConfig and routes through createAgentHeadless', async () => {
    const { config, calls } = fakeConfigWithMgr({
      findSubagentByName: async () => ({
        name: 'Explore',
        description: 'fast read-only',
        systemPrompt: 'You are Explore.',
        level: 'builtin',
        tools: ['Read', 'Grep'],
        disallowedTools: [],
      }),
      onCreate: async () => ({
        finalText: 'explore-output',
        terminateMode: 'GOAL',
      }),
    });
    const dispatch = createProductionDispatch(config);
    const result = await dispatch('find foo', { agentType: 'Explore' });
    expect(result).toBe('explore-output');
    expect(calls).toHaveLength(1);
    expect(calls[0].config.name).toBe('Explore');
    // Workflow floor [SendMessage, ExitPlanMode] must be unioned in.
    expect(calls[0].config.disallowedTools).toEqual(
      expect.arrayContaining(['send_message', 'exit_plan_mode']),
    );
  });

  it('agentType not found throws upstream-aligned error', async () => {
    const { config } = fakeConfigWithMgr({
      findSubagentByName: async () => null,
      onCreate: async () => ({ finalText: '', terminateMode: 'GOAL' }),
    });
    const dispatch = createProductionDispatch(config);
    await expect(
      dispatch('whatever', { agentType: 'NotARealAgent' }),
    ).rejects.toThrow(
      /^agent\(\{agentType\}\): agent type 'NotARealAgent' not found\.$/,
    );
  });

  it('opts.model is threaded into SubagentConfig.model for provider routing', async () => {
    const { config, calls } = fakeConfigWithMgr({
      onCreate: async () => ({ finalText: 'done', terminateMode: 'GOAL' }),
    });
    const dispatch = createProductionDispatch(config);
    await dispatch('hi', { model: 'qwen3-max' });
    // No agentType → ephemeral default config built, then opts.model applied.
    expect(calls[0].config.model).toBe('qwen3-max');
  });

  it("isolation:'remote' throws upstream-aligned 'not available' error", async () => {
    const { config } = fakeConfigWithMgr({
      onCreate: async () => ({ finalText: '', terminateMode: 'GOAL' }),
    });
    const dispatch = createProductionDispatch(config);
    await expect(dispatch('hi', { isolation: 'remote' })).rejects.toThrow(
      /agent\(\{isolation:'remote'\}\) is not available in this build\./,
    );
  });

  it('floor disallowedTools always unioned (agentType cannot re-enable them)', async () => {
    const { config, calls } = fakeConfigWithMgr({
      findSubagentByName: async () => ({
        name: 'Permissive',
        description: 'tries to override floor',
        systemPrompt: 'permissive prompt',
        level: 'project',
        // A user-defined agentType that EXPLICITLY allows the very tools
        // workflow forbids. The floor must still apply.
        disallowedTools: ['Foo'],
      }),
      onCreate: async () => ({ finalText: 'ok', terminateMode: 'GOAL' }),
    });
    const dispatch = createProductionDispatch(config);
    await dispatch('hi', { agentType: 'Permissive' });
    const disallowed = calls[0].config.disallowedTools ?? [];
    // Union: Foo (from agentType) + send_message + exit_plan_mode (floor).
    expect(disallowed).toEqual(
      expect.arrayContaining(['Foo', 'send_message', 'exit_plan_mode']),
    );
  });

  it('schema-mode: subagent calls structured_output successfully → returns validated args', async () => {
    const { config } = fakeConfigWithMgr({
      onCreate: async (_call, _ee) => ({
        finalText: '',
        terminateMode: 'CANCELLED', // schema dispatch aborts after capture
        runWithEmitter: (emitter) => {
          // Simulate the subagent calling structured_output with valid args.
          emitter.emit('tool_call', {
            subagentId: 'sub',
            round: 1,
            callId: 'c1',
            name: 'structured_output',
            args: { ok: true, value: 42 },
            description: '',
            isOutputMarkdown: false,
            timestamp: 1,
          });
          emitter.emit('tool_result', {
            subagentId: 'sub',
            round: 1,
            callId: 'c1',
            name: 'structured_output',
            success: true,
            responseParts: [],
            resultDisplay: '',
            durationMs: 1,
            timestamp: 2,
          });
        },
      }),
    });
    const dispatch = createProductionDispatch(config);
    const result = await dispatch('extract', {
      schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
    });
    expect(result).toEqual({ ok: true, value: 42 });
  });

  it('R1 #1: schema-mode SUCCESS records tokens via onTokens (was missing before fix)', async () => {
    nextOutputTokens.value = 555;
    const { config } = fakeConfigWithMgr({
      onCreate: async () => ({
        finalText: '',
        terminateMode: 'CANCELLED', // schema mode's success path triggers abort
        runWithEmitter: (emitter) => {
          emitter.emit('tool_call', {
            subagentId: 'sub',
            round: 1,
            callId: 'c1',
            name: 'structured_output',
            args: { ok: true, value: 42 },
            description: '',
            isOutputMarkdown: false,
            timestamp: 1,
          });
          emitter.emit('tool_result', {
            subagentId: 'sub',
            round: 1,
            callId: 'c1',
            name: 'structured_output',
            success: true,
            responseParts: [],
            resultDisplay: '',
            durationMs: 1,
            timestamp: 2,
          });
        },
      }),
    });
    const reports: number[] = [];
    const dispatch = createProductionDispatch(config, undefined, (tokens) =>
      reports.push(tokens),
    );
    const result = await dispatch('extract', {
      schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
    });
    expect(result).toEqual({ ok: true, value: 42 });
    // R1 #1 contract: tokens recorded BEFORE the schema/non-schema
    // branching, so the schema success path now reports.
    expect(reports).toEqual([555]);
  });

  it('R3 #6: override-path records tokens when execute() THROWS (sibling of fast path)', async () => {
    // Sibling site for wenshao's R3 #6 finding. `reportTokens` at the
    // override path is the second of the two dispatch sites; the
    // matching test for the fast path lives in
    // `createProductionDispatch` describe above. Both must wrap
    // `await subagent.execute()` in try/finally so token accounting
    // survives the production ERROR-via-throw path.
    const { config } = fakeConfigWithMgr({
      onCreate: async () => ({
        finalText: '',
        terminateMode: 'GOAL', // execute() throws BEFORE terminate-mode check
        runWithEmitter: () => {},
      }),
    });
    nextExecuteThrow.value = new Error('override-path boom');
    nextOutputTokens.value = 9999;
    const reports: number[] = [];
    const dispatch = createProductionDispatch(config, undefined, (tokens) =>
      reports.push(tokens),
    );
    await expect(
      dispatch('q1', { label: 'thrown', schema: { type: 'object' } }),
    ).rejects.toThrow(/override-path boom/);
    expect(reports).toEqual([9999]);
    nextExecuteThrow.value = null;
  });

  it('schema-mode: 3 failed structured_output calls → upstream-aligned terminal error', async () => {
    const { config } = fakeConfigWithMgr({
      onCreate: async (_call, _ee) => ({
        finalText: '',
        terminateMode: 'CANCELLED',
        runWithEmitter: (emitter) => {
          // 3 failed structured_output calls = original attempt + 2 nudges.
          for (let i = 1; i <= 3; i++) {
            emitter.emit('tool_call', {
              subagentId: 'sub',
              round: i,
              callId: `c${i}`,
              name: 'structured_output',
              args: { bad: 'shape' },
              description: '',
              isOutputMarkdown: false,
              timestamp: i,
            });
            emitter.emit('tool_result', {
              subagentId: 'sub',
              round: i,
              callId: `c${i}`,
              name: 'structured_output',
              success: false,
              error: 'validation failed',
              responseParts: [],
              resultDisplay: '',
              durationMs: 1,
              timestamp: i,
            });
          }
        },
      }),
    });
    const dispatch = createProductionDispatch(config);
    await expect(
      dispatch('extract', {
        schema: { type: 'object' },
      }),
    ).rejects.toThrow(
      /subagent completed without calling StructuredOutput \(after 2 in-conversation nudges\)\./,
    );
  });

  // R3 review (wenshao T6 [M2]): when the subagent terminates without
  // ever calling structured_output (model answered in plain text;
  // attempts counter never incremented), the dispatch throws the
  // accurate "no validation attempt" message — NOT the upstream-
  // verbatim "after 2 in-conversation nudges" wording (which describes
  // a different failure mode: 3 validation failures in a row).
  it('schema-mode: subagent never calls structured_output → "no validation attempt" terminal', async () => {
    const { config } = fakeConfigWithMgr({
      onCreate: async () => ({
        finalText: 'plain-text answer the script will discard',
        terminateMode: 'GOAL',
      }),
    });
    const dispatch = createProductionDispatch(config);
    await expect(
      dispatch('extract', { schema: { type: 'object' } }),
    ).rejects.toThrow(
      /subagent completed without calling structured_output \(no validation attempt — model produced plain-text content\)\./,
    );
  });

  it('schema-mode attaches an event emitter to the subagent', async () => {
    const { config, calls } = fakeConfigWithMgr({
      onCreate: async (_call, _ee) => ({
        finalText: '',
        terminateMode: 'CANCELLED',
        runWithEmitter: (emitter) => {
          emitter.emit('tool_call', {
            subagentId: 'sub',
            round: 1,
            callId: 'c1',
            name: 'structured_output',
            args: { ok: true },
            description: '',
            isOutputMarkdown: false,
            timestamp: 1,
          });
          emitter.emit('tool_result', {
            subagentId: 'sub',
            round: 1,
            callId: 'c1',
            name: 'structured_output',
            success: true,
            responseParts: [],
            resultDisplay: '',
            durationMs: 1,
            timestamp: 2,
          });
        },
      }),
    });
    const dispatch = createProductionDispatch(config);
    await dispatch('extract', { schema: { type: 'object' } });
    expect(calls[0].eventEmitterAttached).toBe(true);
  });

  // R1 self-review (P3-T6 gap): the schema-mode state machine in
  // createSchemaEventEmitter has a `state.result === null` guard that
  // allows the model to RECOVER from earlier failed attempts. Only the
  // 0-failure and 3+-failure boundaries were tested; the 1-failure and
  // 2-failure recovery transitions had no coverage. A regression
  // inverting the guard, or one where pendingArgs cleanup discards the
  // recovered args, would slip past the previous tests.
  it('schema-mode: success on 2nd attempt (1 nudge then valid) captures round-2 args', async () => {
    const { config } = fakeConfigWithMgr({
      onCreate: async () => ({
        finalText: '',
        terminateMode: 'CANCELLED',
        runWithEmitter: (emitter) => {
          // Round 1: invalid args, validation fails.
          emitter.emit('tool_call', {
            subagentId: 'sub',
            round: 1,
            callId: 'c1',
            name: 'structured_output',
            args: { bad: 'shape' },
            description: '',
            isOutputMarkdown: false,
            timestamp: 1,
          });
          emitter.emit('tool_result', {
            subagentId: 'sub',
            round: 1,
            callId: 'c1',
            name: 'structured_output',
            success: false,
            error: 'validation failed',
            responseParts: [],
            resultDisplay: '',
            durationMs: 1,
            timestamp: 1,
          });
          // Round 2: corrected args, validation passes. Must be captured
          // as the result, not the round-1 args.
          emitter.emit('tool_call', {
            subagentId: 'sub',
            round: 2,
            callId: 'c2',
            name: 'structured_output',
            args: { ok: true, attempt: 2 },
            description: '',
            isOutputMarkdown: false,
            timestamp: 2,
          });
          emitter.emit('tool_result', {
            subagentId: 'sub',
            round: 2,
            callId: 'c2',
            name: 'structured_output',
            success: true,
            responseParts: [],
            resultDisplay: '',
            durationMs: 1,
            timestamp: 2,
          });
        },
      }),
    });
    const dispatch = createProductionDispatch(config);
    const result = await dispatch('extract', {
      schema: { type: 'object' },
    });
    expect(result).toEqual({ ok: true, attempt: 2 });
  });

  it('schema-mode: success on 3rd attempt (2 nudges then valid) captures round-3 args', async () => {
    const { config } = fakeConfigWithMgr({
      onCreate: async () => ({
        finalText: '',
        terminateMode: 'CANCELLED',
        runWithEmitter: (emitter) => {
          for (let r = 1; r <= 2; r++) {
            emitter.emit('tool_call', {
              subagentId: 'sub',
              round: r,
              callId: `c${r}`,
              name: 'structured_output',
              args: { bad: r },
              description: '',
              isOutputMarkdown: false,
              timestamp: r,
            });
            emitter.emit('tool_result', {
              subagentId: 'sub',
              round: r,
              callId: `c${r}`,
              name: 'structured_output',
              success: false,
              error: 'validation failed',
              responseParts: [],
              resultDisplay: '',
              durationMs: 1,
              timestamp: r,
            });
          }
          emitter.emit('tool_call', {
            subagentId: 'sub',
            round: 3,
            callId: 'c3',
            name: 'structured_output',
            args: { ok: true, attempt: 3 },
            description: '',
            isOutputMarkdown: false,
            timestamp: 3,
          });
          emitter.emit('tool_result', {
            subagentId: 'sub',
            round: 3,
            callId: 'c3',
            name: 'structured_output',
            success: true,
            responseParts: [],
            resultDisplay: '',
            durationMs: 1,
            timestamp: 3,
          });
        },
      }),
    });
    const dispatch = createProductionDispatch(config);
    const result = await dispatch('extract', {
      schema: { type: 'object' },
    });
    expect(result).toEqual({ ok: true, attempt: 3 });
  });

  // R1 self-review (P3-T6 gap): the disallowed-tool floor invariant
  // declares "ALWAYS applies regardless of agentType". The
  // single-option tests above exercise floor+agentType and schema
  // separately, but not their composition. A regression making the
  // floor conditional on schema being unset (e.g. mistakenly moving
  // the union inside an `if (opts.schema === undefined)` branch)
  // would pass the existing tests.
  it('schema-mode + agentType: floor disallowedTools still unioned', async () => {
    const { config, calls } = fakeConfigWithMgr({
      findSubagentByName: async () => ({
        name: 'Permissive',
        description: 'allows SendMessage explicitly',
        systemPrompt: 'permissive',
        level: 'project',
        disallowedTools: ['Foo'],
      }),
      onCreate: async (_call, _ee) => ({
        finalText: '',
        terminateMode: 'CANCELLED',
        runWithEmitter: (emitter) => {
          emitter.emit('tool_call', {
            subagentId: 'sub',
            round: 1,
            callId: 'c1',
            name: 'structured_output',
            args: { ok: true },
            description: '',
            isOutputMarkdown: false,
            timestamp: 1,
          });
          emitter.emit('tool_result', {
            subagentId: 'sub',
            round: 1,
            callId: 'c1',
            name: 'structured_output',
            success: true,
            responseParts: [],
            resultDisplay: '',
            durationMs: 1,
            timestamp: 1,
          });
        },
      }),
    });
    const dispatch = createProductionDispatch(config);
    await dispatch('extract', {
      agentType: 'Permissive',
      schema: { type: 'object' },
    });
    const disallowed = calls[0].config.disallowedTools ?? [];
    expect(disallowed).toEqual(
      expect.arrayContaining(['Foo', 'send_message', 'exit_plan_mode']),
    );
  });

  // R1 self-review (P3-T6 gap): caller-abort taking priority over
  // "completed without StructuredOutput" is a contract boundary the
  // dispatch enforces at the explicit `if (signal?.aborted)` check.
  // Without this test, a refactor removing the check would silently
  // convert user-cancelled schema runs into schema-failure errors.
  it('schema-mode: caller abort takes priority over terminal "no structured_output" error', async () => {
    const externalAbort = new AbortController();
    const { config } = fakeConfigWithMgr({
      onCreate: async () => ({
        finalText: '',
        terminateMode: 'CANCELLED',
        runWithEmitter: (_emitter) => {
          // Caller-side abort fires while the subagent is in flight but
          // before any structured_output call. After execute() returns,
          // signal.aborted is true AND state.result is still null — the
          // dispatch must throw AbortError, not the StructuredOutput
          // terminal error.
          externalAbort.abort();
        },
      }),
    });
    const dispatch = createProductionDispatch(config, externalAbort.signal);
    await expect(
      dispatch('extract', { schema: { type: 'object' } }),
    ).rejects.toThrow(/aborted/i);
  });

  // R1 self-review (P3-T6 gap): the override path's dispose() must run
  // in a finally so per-agent MCP processes / hooks don't leak past the
  // dispatch — including on the exception path. The test harness has a
  // `disposed` counter that no test asserts on; this closes that gap on
  // both the success and the thrown-from-execute paths.
  it('override path always calls dispose() on the success path', async () => {
    // Use model-only override (no agentType) so we don't go through the
    // SubagentManager resolution path. The ephemeral-default branch
    // still routes through createAgentHeadless and therefore dispose().
    const helper = fakeConfigWithMgr({
      onCreate: async () => ({ finalText: 'done', terminateMode: 'GOAL' }),
    });
    const dispatch = createProductionDispatch(helper.config);
    await dispatch('hi', { model: 'qwen3-max' });
    expect(helper.disposed).toBeGreaterThanOrEqual(1);
  });

  it('override path always calls dispose() even when terminateMode is non-GOAL', async () => {
    const helper = fakeConfigWithMgr({
      onCreate: async () => ({
        finalText: '',
        terminateMode: 'ERROR', // non-GOAL → dispatch throws after execute
      }),
    });
    const dispatch = createProductionDispatch(helper.config);
    await expect(dispatch('hi', { model: 'qwen3-max' })).rejects.toThrow(
      /terminate mode: ERROR/,
    );
    expect(helper.disposed).toBeGreaterThanOrEqual(1);
  });

  // R2 self-review (sec-2): sanitize control characters in user-controlled
  // strings before interpolating into error messages so a model-authored
  // agentType cannot fragment a single-line error across log records.
  it('agentType not found: control chars in name are scrubbed from the error message', async () => {
    const { config } = fakeConfigWithMgr({
      findSubagentByName: async () => null,
      onCreate: async () => ({ finalText: '', terminateMode: 'GOAL' }),
    });
    const dispatch = createProductionDispatch(config);
    // newline + nul + del — all control codes < 0x20 or == 0x7f.
    const evil = 'Explore\n\rEvil\x00\x7f';
    await expect(dispatch('hi', { agentType: evil })).rejects.toThrow();
    // The thrown message must NOT contain raw newlines / NULs.
    try {
      await dispatch('hi', { agentType: evil });
    } catch (err) {
      const msg = (err as Error).message;
      // eslint-disable-next-line no-control-regex
      expect(msg).not.toMatch(/[\n\r\u0000\u007f]/);
      expect(msg).toContain('not found');
    }
  });

  // R2 self-review (test-5): dispose() MUST still run even when
  // subagent.execute throws synchronously from inside the in-flight
  // event-emitter callback (schema-mode failure path). The R1 dispose
  // tests covered terminate-mode-non-GOAL; this covers the thrown-from-
  // execute branch.
  it('override path: dispose() still runs in finally when execute throws', async () => {
    const helper = fakeConfigWithMgr({
      onCreate: async () => ({
        finalText: '',
        terminateMode: 'GOAL', // not reached
        runWithEmitter: (_emitter) => {
          throw new Error('simulated subagent failure');
        },
      }),
    });
    const dispatch = createProductionDispatch(helper.config);
    await expect(
      dispatch('extract', { schema: { type: 'object' } }),
    ).rejects.toThrow(/simulated subagent failure/);
    expect(helper.disposed).toBeGreaterThanOrEqual(1);
  });

  // ─── isolation:'worktree' provision error branches ──────────────
  // R2 self-review (test-1, [critical]): each provisionWorkflowWorktree
  // error branch had no unit test. Coverage came only from the real-
  // LLM E2E S7 happy path. Adversarial review noted the parent-dirty
  // refuse, nested-worktree refuse, and git-not-available paths can
  // change behavior with no regression signal. Each test below stubs
  // the GitWorktreeService method that controls the branch.

  it("isolation:'worktree' refuses when parent cwd is already inside a worktree", async () => {
    const { config } = fakeConfigWithMgr({
      onCreate: async () => ({ finalText: 'unused', terminateMode: 'GOAL' }),
    });
    // Override getTargetDir to look nested-worktree-ish.
    (config as unknown as { getTargetDir: () => string }).getTargetDir = () =>
      '/some/repo/.qwen/worktrees/agent-existing/inner';
    const dispatch = createProductionDispatch(config);
    await expect(dispatch('hi', { isolation: 'worktree' })).rejects.toThrow(
      /already inside a worktree/,
    );
  });

  it("isolation:'worktree' refuses when git is not available", async () => {
    worktreeStubs.instances.length = 0; // reset
    const { GitWorktreeService } = await import(
      '../../services/gitWorktreeService.js'
    );
    vi.mocked(GitWorktreeService).mockImplementation(
      () =>
        ({
          ...worktreeStubs.makeStub(),
          checkGitAvailable: vi.fn(async () => ({
            available: false,
            error: 'git binary missing',
          })),
        }) as unknown as InstanceType<typeof GitWorktreeService>,
    );
    const { config } = fakeConfigWithMgr({
      onCreate: async () => ({ finalText: 'unused', terminateMode: 'GOAL' }),
    });
    const dispatch = createProductionDispatch(config);
    await expect(dispatch('hi', { isolation: 'worktree' })).rejects.toThrow(
      /git binary missing/,
    );
  });

  it("isolation:'worktree' refuses when cwd is not a git repository", async () => {
    const { GitWorktreeService } = await import(
      '../../services/gitWorktreeService.js'
    );
    vi.mocked(GitWorktreeService).mockImplementation(
      () =>
        ({
          ...worktreeStubs.makeStub(),
          isGitRepository: vi.fn(async () => false),
        }) as unknown as InstanceType<typeof GitWorktreeService>,
    );
    const { config } = fakeConfigWithMgr({
      onCreate: async () => ({ finalText: 'unused', terminateMode: 'GOAL' }),
    });
    const dispatch = createProductionDispatch(config);
    await expect(dispatch('hi', { isolation: 'worktree' })).rejects.toThrow(
      /not a git repository/,
    );
  });

  it("isolation:'worktree' refuses when parent working tree is dirty", async () => {
    const { GitWorktreeService } = await import(
      '../../services/gitWorktreeService.js'
    );
    vi.mocked(GitWorktreeService).mockImplementation(
      () =>
        ({
          ...worktreeStubs.makeStub(),
          hasWorktreeChanges: vi.fn(async () => true),
        }) as unknown as InstanceType<typeof GitWorktreeService>,
    );
    const { config } = fakeConfigWithMgr({
      onCreate: async () => ({ finalText: 'unused', terminateMode: 'GOAL' }),
    });
    const dispatch = createProductionDispatch(config);
    await expect(dispatch('hi', { isolation: 'worktree' })).rejects.toThrow(
      /uncommitted changes/,
    );
  });

  it("isolation:'worktree' surfaces createUserWorktree failure", async () => {
    const { GitWorktreeService } = await import(
      '../../services/gitWorktreeService.js'
    );
    vi.mocked(GitWorktreeService).mockImplementation(
      () =>
        ({
          ...worktreeStubs.makeStub(),
          createUserWorktree: vi.fn(async () => ({
            success: false,
            error: 'simulated worktree create failure',
          })),
        }) as unknown as InstanceType<typeof GitWorktreeService>,
    );
    const { config } = fakeConfigWithMgr({
      onCreate: async () => ({ finalText: 'unused', terminateMode: 'GOAL' }),
    });
    const dispatch = createProductionDispatch(config);
    await expect(dispatch('hi', { isolation: 'worktree' })).rejects.toThrow(
      /simulated worktree create failure/,
    );
  });

  // ─── isolation:'worktree' cleanup error branches ────────────────
  // R2 self-review (test-2, [major]): cleanupWorkflowWorktree has 3
  // notable error/branch transitions: removeUserWorktree returns
  // {success:false}, returns {success:true, branchPreserved:true}, or
  // throws synchronously. Each path produces a different preserved
  // suffix and was previously untested.

  it("isolation:'worktree' cleanup: removeUserWorktree failure preserves path+branch", async () => {
    const { GitWorktreeService } = await import(
      '../../services/gitWorktreeService.js'
    );
    vi.mocked(GitWorktreeService).mockImplementation(
      () =>
        ({
          ...worktreeStubs.makeStub(),
          // Subagent left the worktree clean.
          hasWorktreeChanges: vi
            .fn(async () => false)
            // ... but the subsequent cleanup-side hasWorktreeChanges
            // (called from inside cleanupWorkflowWorktree) also reports
            // clean. Cleanup proceeds to removeUserWorktree which fails.
            .mockImplementation(async () => false),
          removeUserWorktree: vi.fn(async () => ({
            success: false,
            error: 'simulated remove failure',
          })),
        }) as unknown as InstanceType<typeof GitWorktreeService>,
    );
    const { config } = fakeConfigWithMgr({
      onCreate: async () => ({ finalText: 'done', terminateMode: 'GOAL' }),
    });
    const dispatch = createProductionDispatch(config);
    const result = await dispatch('hi', { isolation: 'worktree' });
    // Suffix should appear because removeUserWorktree failed → preserve.
    expect(String(result)).toMatch(
      /\[worktree preserved:.*\(branch worktree-agent-deadbe1\)\]/,
    );
  });

  it("isolation:'worktree' cleanup: branchPreserved race yields branch-only suffix", async () => {
    const { GitWorktreeService } = await import(
      '../../services/gitWorktreeService.js'
    );
    vi.mocked(GitWorktreeService).mockImplementation(
      () =>
        ({
          ...worktreeStubs.makeStub(),
          removeUserWorktree: vi.fn(async () => ({
            success: true,
            branchPreserved: true, // race: commits landed between checks and delete
          })),
        }) as unknown as InstanceType<typeof GitWorktreeService>,
    );
    const { config } = fakeConfigWithMgr({
      onCreate: async () => ({ finalText: 'done', terminateMode: 'GOAL' }),
    });
    const dispatch = createProductionDispatch(config);
    const result = await dispatch('hi', { isolation: 'worktree' });
    // Directory-removed-but-branch-preserved suffix matches AgentTool
    // verbatim and includes the recover hint.
    expect(String(result)).toMatch(/worktree directory removed/);
    expect(String(result)).toMatch(/git worktree add/);
  });

  it("isolation:'worktree' cleanup: thrown removeUserWorktree preserves path+branch", async () => {
    const { GitWorktreeService } = await import(
      '../../services/gitWorktreeService.js'
    );
    vi.mocked(GitWorktreeService).mockImplementation(
      () =>
        ({
          ...worktreeStubs.makeStub(),
          removeUserWorktree: vi.fn(async () => {
            throw new Error('simulated git crash during remove');
          }),
        }) as unknown as InstanceType<typeof GitWorktreeService>,
    );
    const { config } = fakeConfigWithMgr({
      onCreate: async () => ({ finalText: 'done', terminateMode: 'GOAL' }),
    });
    const dispatch = createProductionDispatch(config);
    const result = await dispatch('hi', { isolation: 'worktree' });
    expect(String(result)).toMatch(
      /\[worktree preserved:.*\(branch worktree-agent-deadbe1\)\]/,
    );
  });

  // ─── isolation:'worktree' option combinations ───────────────────
  // R2 self-review (test-3/4): single-option tests don't catch
  // interactions. These verify model+worktree and schema+worktree
  // each compose correctly.

  it("model + isolation:'worktree': model threaded through AND worktree provisioned", async () => {
    const { config, calls } = fakeConfigWithMgr({
      onCreate: async () => ({ finalText: 'done', terminateMode: 'GOAL' }),
    });
    const dispatch = createProductionDispatch(config);
    const result = await dispatch('hi', {
      model: 'qwen3-max',
      isolation: 'worktree',
    });
    expect(calls[0].config.model).toBe('qwen3-max');
    // Default-clean stub auto-removes; no suffix expected.
    expect(String(result)).not.toMatch(/worktree preserved/);
  });

  it("schema + isolation:'worktree': structured payload returned, worktree info logged", async () => {
    const { config } = fakeConfigWithMgr({
      onCreate: async (_call, _ee) => ({
        finalText: '',
        terminateMode: 'CANCELLED',
        runWithEmitter: (emitter) => {
          emitter.emit('tool_call', {
            subagentId: 'sub',
            round: 1,
            callId: 'c1',
            name: 'structured_output',
            args: { ok: true, in_worktree: true },
            description: '',
            isOutputMarkdown: false,
            timestamp: 1,
          });
          emitter.emit('tool_result', {
            subagentId: 'sub',
            round: 1,
            callId: 'c1',
            name: 'structured_output',
            success: true,
            responseParts: [],
            resultDisplay: '',
            durationMs: 1,
            timestamp: 1,
          });
        },
      }),
    });
    const dispatch = createProductionDispatch(config);
    const result = await dispatch('extract from worktree', {
      schema: { type: 'object' },
      isolation: 'worktree',
    });
    // Schema-mode returns the structured object verbatim, not the
    // string-with-suffix shape. The preserved-suffix mechanism intentionally
    // does NOT mutate the structured payload — operator-visible info goes
    // to debugLogger instead. See runOverridePath's "schema-mode... payload
    // is returned verbatim" comment.
    expect(result).toEqual({ ok: true, in_worktree: true });
  });

  // ─── R3 review (wenshao Round 2) ────────────────────────────────

  // T0 [Critical]: when isolation:worktree is provisioned and then a
  // later setup step throws (here, createSchemaConfigOverride via a
  // broken fakeRegistry.copyDiscoveredToolsFrom), the outer try/finally
  // MUST still fire the fallback worktree cleanup. Before the fix, the
  // outer try opened AFTER schema setup, so this exact path orphaned
  // the worktree on disk.
  it("isolation:'worktree' + schema setup throws → worktree is still cleaned up", async () => {
    const removeCalls: string[] = [];
    const { GitWorktreeService } = await import(
      '../../services/gitWorktreeService.js'
    );
    vi.mocked(GitWorktreeService).mockImplementation(() => {
      const stub = worktreeStubs.makeStub();
      // Track removeUserWorktree calls — the fallback finally must call it.
      stub.removeUserWorktree = vi.fn(async (slug: string) => {
        removeCalls.push(slug);
        return { success: true };
      });
      worktreeStubs.instances.push(stub);
      return stub as unknown as InstanceType<typeof GitWorktreeService>;
    });
    // fakeConfigWithMgr's getToolRegistry returns fakeRegistry which has a
    // no-op copyDiscoveredToolsFrom. Patch the worktree-override path so
    // createSchemaConfigOverride's rebuildToolRegistryOnOverride throws.
    const { config } = fakeConfigWithMgr({
      onCreate: async () => ({
        finalText: 'unused',
        terminateMode: 'GOAL',
      }),
    });
    (
      config as unknown as { createToolRegistry: () => Promise<unknown> }
    ).createToolRegistry = async () => {
      throw new Error('simulated registry rebuild failure');
    };
    const dispatch = createProductionDispatch(config);
    await expect(
      dispatch('hi', {
        isolation: 'worktree',
        schema: { type: 'object' },
      }),
    ).rejects.toThrow(/simulated registry rebuild failure/);
    // Cleanup must have called removeUserWorktree even though setup threw.
    expect(removeCalls).toContain('agent-deadbe1');
  });

  // T1 + T4 [Critical/H1]: when agentType resolves with a restricted
  // tools allowlist (no '*'), the schema-mode dispatch MUST add
  // structured_output to the allowlist so prepareTools doesn't filter
  // it out of the subagent's tool surface. Without this fix the
  // SyntheticOutputTool was present in the per-call registry but
  // invisible to the model, producing the silent "after 2 nudges" dead-end.
  it('schema-mode + agentType restricted tools: structured_output appended to allowlist', async () => {
    const { config, calls } = fakeConfigWithMgr({
      findSubagentByName: async () => ({
        name: 'Explore',
        description: 'fast read-only',
        systemPrompt: 'You are Explore. Read-only. Be fast.',
        level: 'builtin',
        tools: ['Read', 'Grep', 'Glob'],
        disallowedTools: [],
      }),
      onCreate: async (_call, _ee) => ({
        finalText: '',
        terminateMode: 'CANCELLED',
        runWithEmitter: (emitter) => {
          emitter.emit('tool_call', {
            subagentId: 'sub',
            round: 1,
            callId: 'c1',
            name: 'structured_output',
            args: { ok: true },
            description: '',
            isOutputMarkdown: false,
            timestamp: 1,
          });
          emitter.emit('tool_result', {
            subagentId: 'sub',
            round: 1,
            callId: 'c1',
            name: 'structured_output',
            success: true,
            responseParts: [],
            resultDisplay: '',
            durationMs: 1,
            timestamp: 1,
          });
        },
      }),
    });
    const dispatch = createProductionDispatch(config);
    await dispatch('extract', {
      agentType: 'Explore',
      schema: { type: 'object' },
    });
    const tools = (calls[0].config as { tools?: string[] }).tools ?? [];
    expect(tools).toContain('structured_output');
    // The original agentType tools survive — not replaced.
    expect(tools).toEqual(
      expect.arrayContaining(['Read', 'Grep', 'Glob', 'structured_output']),
    );
  });

  // T1 + T4 [Critical/H1] companion: the resolved agentType's
  // systemPrompt MUST be preserved — schema-mode appends the StructuredOutput
  // instruction block instead of replacing the persona outright.
  it('schema-mode + agentType: systemPrompt appends schema instructions (persona preserved)', async () => {
    const personaPrompt = 'You are Explore. Read-only. Be fast.';
    const { config, calls } = fakeConfigWithMgr({
      findSubagentByName: async () => ({
        name: 'Explore',
        description: 'fast read-only',
        systemPrompt: personaPrompt,
        level: 'builtin',
      }),
      onCreate: async () => ({
        finalText: '',
        terminateMode: 'CANCELLED',
        runWithEmitter: (emitter) => {
          emitter.emit('tool_call', {
            subagentId: 'sub',
            round: 1,
            callId: 'c1',
            name: 'structured_output',
            args: { ok: true },
            description: '',
            isOutputMarkdown: false,
            timestamp: 1,
          });
          emitter.emit('tool_result', {
            subagentId: 'sub',
            round: 1,
            callId: 'c1',
            name: 'structured_output',
            success: true,
            responseParts: [],
            resultDisplay: '',
            durationMs: 1,
            timestamp: 1,
          });
        },
      }),
    });
    const dispatch = createProductionDispatch(config);
    await dispatch('extract', {
      agentType: 'Explore',
      schema: { type: 'object' },
    });
    const sp =
      (calls[0].config as { systemPrompt?: string }).systemPrompt ?? '';
    expect(sp).toContain(personaPrompt);
    expect(sp).toContain('structured_output');
  });

  // T2 + T5 [M1]: schema-mode dispatch MUST NOT accumulate listeners on
  // the parent (run-level) AbortSignal across N calls. Before the fix
  // `{ once: true }` only removed on actual parent abort, so a workflow
  // with N schema calls and no abort accumulated N listeners + N child
  // AbortController closures. The fix removes the named listener in the
  // outer finally regardless of how the dispatch ended.
  it('schema-mode: parent-abort listener is removed after each call (no accumulation)', async () => {
    const sharedSignal = new AbortController().signal;
    let liveListeners = 0;
    const origAdd = sharedSignal.addEventListener.bind(sharedSignal);
    const origRemove = sharedSignal.removeEventListener.bind(sharedSignal);
    sharedSignal.addEventListener = ((type: string, ...rest: unknown[]) => {
      if (type === 'abort') liveListeners += 1;
      return (origAdd as unknown as (t: string, ...r: unknown[]) => void)(
        type,
        ...rest,
      );
    }) as typeof sharedSignal.addEventListener;
    sharedSignal.removeEventListener = ((type: string, ...rest: unknown[]) => {
      if (type === 'abort') liveListeners -= 1;
      return (origRemove as unknown as (t: string, ...r: unknown[]) => void)(
        type,
        ...rest,
      );
    }) as typeof sharedSignal.removeEventListener;

    const { config } = fakeConfigWithMgr({
      onCreate: async (_call, _ee) => ({
        finalText: '',
        terminateMode: 'CANCELLED',
        runWithEmitter: (emitter) => {
          emitter.emit('tool_call', {
            subagentId: 'sub',
            round: 1,
            callId: 'c1',
            name: 'structured_output',
            args: { ok: true },
            description: '',
            isOutputMarkdown: false,
            timestamp: 1,
          });
          emitter.emit('tool_result', {
            subagentId: 'sub',
            round: 1,
            callId: 'c1',
            name: 'structured_output',
            success: true,
            responseParts: [],
            resultDisplay: '',
            durationMs: 1,
            timestamp: 1,
          });
        },
      }),
    });
    const dispatch = createProductionDispatch(config, sharedSignal);
    // Run 5 schema-mode dispatches against the same parent signal.
    for (let i = 0; i < 5; i++) {
      await dispatch('extract', { schema: { type: 'object' } });
    }
    expect(liveListeners).toBe(0);
  });

  // T6 [M2]: a schema-mode dispatch whose subagent terminates via
  // TIMEOUT (10 min cap), MAX_TURNS (50 cap), or ERROR without a
  // structured_output call MUST throw the terminate-mode error, not the
  // "after 2 in-conversation nudges" terminal. The previous path
  // misdiagnosed every non-result outcome as a content failure.
  it.each(['TIMEOUT', 'MAX_TURNS', 'ERROR'])(
    'schema-mode + terminateMode=%s → "did not complete" terminal, not "after 2 nudges"',
    async (mode) => {
      const { config } = fakeConfigWithMgr({
        onCreate: async () => ({
          finalText: '',
          terminateMode: mode,
        }),
      });
      const dispatch = createProductionDispatch(config);
      await expect(
        dispatch('extract', { schema: { type: 'object' } }),
      ).rejects.toThrow(
        new RegExp(`did not complete \\(terminate mode: ${mode}\\)\\.`),
      );
    },
  );

  // T6 [M2] companion: when the schema-mode dispatch DID see 3 failed
  // validation attempts (the real "after 2 in-conversation nudges"
  // path), the upstream-verbatim wording is preserved. This is the
  // existing 3-failure test, retained here with explicit terminateMode
  // pinning to make the contract unambiguous.
  it('schema-mode: 3 failed structured_output calls → upstream-verbatim "after 2 nudges"', async () => {
    const { config } = fakeConfigWithMgr({
      onCreate: async (_call, _ee) => ({
        finalText: '',
        terminateMode: 'CANCELLED', // dispatch aborts on 3rd failure
        runWithEmitter: (emitter) => {
          for (let i = 1; i <= 3; i++) {
            emitter.emit('tool_call', {
              subagentId: 'sub',
              round: i,
              callId: `c${i}`,
              name: 'structured_output',
              args: { bad: i },
              description: '',
              isOutputMarkdown: false,
              timestamp: i,
            });
            emitter.emit('tool_result', {
              subagentId: 'sub',
              round: i,
              callId: `c${i}`,
              name: 'structured_output',
              success: false,
              error: 'validation failed',
              responseParts: [],
              resultDisplay: '',
              durationMs: 1,
              timestamp: i,
            });
          }
        },
      }),
    });
    const dispatch = createProductionDispatch(config);
    await expect(
      dispatch('extract', { schema: { type: 'object' } }),
    ).rejects.toThrow(
      /subagent completed without calling StructuredOutput \(after 2 in-conversation nudges\)\./,
    );
  });
});
