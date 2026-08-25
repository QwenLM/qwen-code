/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

// T7 (PR #4732 R1): the `vi as vitest` alias diverges from every other
// test file in the repo. Use `vi` directly.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  WorkflowOrchestrator,
  WorkflowExecutionError,
  createProductionDispatch,
  DEFAULT_MAX_AGENTS_PER_RUN,
  resolveMaxAgentsPerRun,
  resolveConcurrencyLimit,
  resolveSubagentMaxTurns,
  resolveSubagentMaxTimeMinutes,
  DEFAULT_WORKFLOW_SUBAGENT_MAX_TURNS,
  DEFAULT_WORKFLOW_SUBAGENT_MAX_TIME_MINUTES,
} from './workflow-orchestrator.js';
import type { Config } from '../../config/config.js';
import { AgentEventType, type AgentEventEmitter } from './agent-events.js';
import { ToolConfirmationOutcome } from '../../tools/tools.js';
import { WorkflowRunRegistry } from '../workflow-run-registry.js';
import { WorkflowRunner } from './workflow-runner.js';
import { WorkflowDispatchScheduler } from './workflow-dispatch-scheduler.js';

// FIX-C3 (TST-2-C1): use vi.hoisted so `created` is initialised before the
// vi.mock factory runs AND remains accessible inside tests for assertion +
// reset between cases. Without this, the module-level `created` array
// accumulated across tests, so a later test could pass by coincidence.
//
// FIX-C8 (TST-2-I2): record the full 9-arg signature of AgentHeadless.create
// and the (ctx, signal?) shape of execute so any drift between the production
// call site and the real AgentHeadless surface becomes a test failure.
const {
  created,
  nextFinalText,
  nextTerminateMode,
  nextOutputTokens,
  nextExecuteThrow,
  nextExecuteHook,
} = vi.hoisted(() => ({
  created: [] as Array<{
    name: string;
    prompt: string;
    signal?: AbortSignal;
    promptConfigSystemPrompt?: string;
    promptConfigInitialMessages?: unknown[];
    runConfig?: { max_turns?: number; max_time_minutes?: number };
    toolConfig?: { tools?: string[]; disallowedTools?: string[] };
    agentId?: string | null;
  }>,
  nextFinalText: { value: undefined as string | undefined },
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
  nextExecuteHook: {
    value: undefined as
      | ((emitter: AgentEventEmitter, signal?: AbortSignal) => Promise<void>)
      | undefined,
  },
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

// `workingDir` resolution (shared with AgentTool's `working_dir`) is unit
// tested in `agents/worktree-pin.test.ts` against a mocked GitWorktreeService.
// Here it is a seam: these tests assert what the ORCHESTRATOR does with the
// resolver's verdict — routes off the fast path, rebinds the runtime context,
// surfaces the refusal — not whether git considers a directory registered.
const pinStub = vi.hoisted(() => ({
  resolve: {
    value: undefined as ((workingDir: string) => Promise<unknown>) | undefined,
  },
  seenLabels: [] as string[],
}));

vi.mock('../worktree-pin.js', () => ({
  resolveExternalWorktreeDir: async (
    _config: unknown,
    workingDir: string,
    label = 'working_dir',
  ) => {
    pinStub.seenLabels.push(label);
    return (
      (await pinStub.resolve.value?.(workingDir)) ?? {
        path: `/fake/repo/${workingDir}`,
        branch: 'pr-7',
        slug: workingDir,
        repoRoot: '/fake/repo',
      }
    );
  },
}));

vi.mock('./agent-headless.js', () => ({
  AgentHeadless: {
    create: async (
      name: string,
      _runtimeContext: unknown,
      promptConfig: { systemPrompt?: string; initialMessages?: unknown[] },
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
        const { getCurrentAgentId } = await import('./agent-context.js');
        created.push({
          name,
          prompt: ctx.get('task_prompt') as string,
          signal,
          promptConfigSystemPrompt: promptConfig.systemPrompt,
          promptConfigInitialMessages: promptConfig.initialMessages,
          runConfig,
          toolConfig,
          agentId: getCurrentAgentId(),
        });
        if (
          !promptConfig.systemPrompt?.includes('subagent spawned by a workflow')
        ) {
          throw new Error(
            'orchestrator did not pass workflow subagent system prompt',
          );
        }
        await nextExecuteHook.value?.(
          _eventEmitter as AgentEventEmitter,
          signal,
        );
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
        nextFinalText.value ??
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

  it('records dependency tails across sequential, parallel, and pipeline dispatches', async () => {
    const orchestrator = new WorkflowOrchestrator(
      async (prompt) => `mock:${prompt}`,
    );
    const queued: Array<{
      id: string;
      label?: string;
      dependsOn: string[];
    }> = [];

    await orchestrator.run({
      script: `
        phase('Inspect');
        await agent('inspect', { label: 'inspect' });
        phase('Review');
        await parallel([
          () => agent('correctness', { label: 'correctness' }),
          () => agent('architecture', { label: 'architecture' }),
        ]);
        phase('Fix');
        await pipeline(
          ['a', 'b'],
          (_prev, item) => agent('verify ' + item, { label: 'verify-' + item }),
          (_prev, item) => agent('fix ' + item, { label: 'fix-' + item }),
        );
      `,
      args: undefined,
      emitter: {
        dispatchQueued: (event) => queued.push(event),
      },
    });

    const ids = new Map(queued.map((event) => [event.label, event.id]));
    const dependencies = (label: string) =>
      queued
        .find((event) => event.label === label)!
        .dependsOn.map((id) => queued.find((event) => event.id === id)!.label);

    expect(dependencies('inspect')).toEqual([]);
    expect(dependencies('correctness')).toEqual(['inspect']);
    expect(dependencies('architecture')).toEqual(['inspect']);
    expect(dependencies('verify-a')).toEqual(['correctness', 'architecture']);
    expect(dependencies('verify-b')).toEqual(['correctness', 'architecture']);
    expect(dependencies('fix-a')).toEqual(['verify-a']);
    expect(dependencies('fix-b')).toEqual(['verify-b']);
    expect(new Set(ids.values()).size).toBe(7);
  });

  it.each(['parallel', 'pipeline'] as const)(
    'preserves newer parent dependencies when an un-awaited %s settles',
    async (kind) => {
      const queued: Array<{
        id: string;
        label?: string;
        dependsOn: string[];
      }> = [];
      const orchestrator = new WorkflowOrchestrator(
        async (prompt) => `${prompt}-done`,
      );
      const fanout =
        kind === 'parallel'
          ? `parallel([() => agent('fanout', { label: 'fanout' })])`
          : `pipeline([0], () => agent('fanout', { label: 'fanout' }))`;

      await orchestrator.run({
        script: `
          const pending = ${fanout};
          await agent('parent', { label: 'parent' });
          await pending;
          await agent('joined', { label: 'joined' });
        `,
        args: undefined,
        scheduler: new WorkflowDispatchScheduler(2),
        emitter: {
          dispatchQueued: (event) => queued.push(event),
        },
      });

      const labelsById = new Map(
        queued.map((event) => [event.id, event.label]),
      );
      const joined = queued.find((event) => event.label === 'joined');
      expect(joined?.dependsOn.map((id) => labelsById.get(id)).sort()).toEqual([
        'fanout',
        'parent',
      ]);
    },
  );

  it('emits queued, started, and settled lifecycle events for one dispatch', async () => {
    const orchestrator = new WorkflowOrchestrator(async () => 'done');
    const events: string[] = [];

    await orchestrator.run({
      script: `await agent('inspect', { label: 'scope' });`,
      args: undefined,
      emitter: {
        dispatchQueued: ({ id, label }) => events.push(`queued:${id}:${label}`),
        dispatchStarted: (id) => events.push(`started:${id}`),
        dispatchSettled: (id, error) =>
          events.push(`settled:${id}:${error ?? 'ok'}`),
      },
    });

    expect(events).toHaveLength(3);
    const dispatchId = events[0]!.split(':')[1];
    expect(events).toEqual([
      `queued:${dispatchId}:scope`,
      `started:${dispatchId}`,
      `settled:${dispatchId}:ok`,
    ]);
  });

  it('passes the recorded dispatch id into the production dispatch boundary', async () => {
    const receivedIds: Array<string | undefined> = [];
    const orchestrator = new WorkflowOrchestrator(
      async (_prompt, _opts, dispatchId) => {
        receivedIds.push(dispatchId);
        return 'done';
      },
    );

    await orchestrator.run({
      script: `await agent('inspect', { label: 'scope' });`,
      args: undefined,
    });

    expect(receivedIds).toEqual(['dispatch-1']);
  });

  it('preserves the dependency tail across empty parallel helpers', async () => {
    const orchestrator = new WorkflowOrchestrator(async () => 'done');
    const queued: Array<{
      id: string;
      label?: string;
      dependsOn: string[];
    }> = [];

    await orchestrator.run({
      script: `
        await agent('before', { label: 'before' });
        await parallel([]);
        await agent('after parallel', { label: 'after-parallel' });
        await pipeline([], () => agent('unused'));
        await agent('after pipeline', { label: 'after-pipeline' });
      `,
      args: undefined,
      emitter: {
        dispatchQueued: (event) => queued.push(event),
      },
    });

    const labelById = new Map(
      queued.map((event) => [event.id, event.label ?? event.id]),
    );
    const dependsOn = (label: string) =>
      queued
        .find((event) => event.label === label)!
        .dependsOn.map((id) => labelById.get(id));

    expect(dependsOn('after-parallel')).toEqual(['before']);
    expect(dependsOn('after-pipeline')).toEqual(['after-parallel']);
  });

  it('does not re-inject inherited tails from a fan-out branch that never dispatches', async () => {
    const orchestrator = new WorkflowOrchestrator(
      async (prompt) => `${prompt}`,
    );
    const queued: Array<{
      id: string;
      label?: string;
      dependsOn: string[];
    }> = [];

    await orchestrator.run({
      script: `
        await agent('a', { label: 'a' });
        const pending = parallel([
          () => agent('b', { label: 'b' }),
          () => 42,
        ]);
        await agent('m', { label: 'm' });
        await pending;
        await agent('z', { label: 'z' });
      `,
      args: undefined,
      scheduler: new WorkflowDispatchScheduler(2),
      emitter: {
        dispatchQueued: (event) => queued.push(event),
      },
    });

    const labelsById = new Map(queued.map((event) => [event.id, event.label]));
    const dependsOn = (label: string) =>
      queued
        .find((event) => event.label === label)!
        .dependsOn.map((id) => labelsById.get(id))
        .sort();

    expect(dependsOn('b')).toEqual(['a']);
    expect(dependsOn('m')).toEqual(['a']);
    // The no-dispatch branch must not re-inject the ancestor 'a' edge.
    expect(dependsOn('z')).toEqual(['b', 'm']);
  });

  it('keeps inherited tails when no fan-out branch issues a dispatch', async () => {
    const orchestrator = new WorkflowOrchestrator(async () => 'done');
    const queued: Array<{
      id: string;
      label?: string;
      dependsOn: string[];
    }> = [];

    await orchestrator.run({
      script: `
        await agent('before', { label: 'before' });
        await parallel([() => 1, () => 2]);
        await agent('after', { label: 'after' });
      `,
      args: undefined,
      emitter: {
        dispatchQueued: (event) => queued.push(event),
      },
    });

    const labelById = new Map(
      queued.map((event) => [event.id, event.label ?? event.id]),
    );
    const after = queued.find((event) => event.label === 'after');
    expect(after?.dependsOn.map((id) => labelById.get(id))).toEqual(['before']);
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
      dispatchQueued: () => {
        throw new Error('queued-subscriber-boom');
      },
      dispatchStarted: () => {
        throw new Error('started-subscriber-boom');
      },
      dispatchSettled: () => {
        throw new Error('settled-subscriber-boom');
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
    // gate short-circuits before scheduler.run.
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

  it('P5 R1 #2: parallel-batch overshoot is bounded by the in-scheduler re-check', async () => {
    // R1 Critical #2 — without the slot-acquire gate, a parallel() of N
    // thunks queues them all in one microtask burst with spent=0, so the
    // entry gate passes for every queued dispatch and the budget
    // overshoots by up to `(N-1) × per_dispatch_tokens`.
    //
    // With the slot-acquire re-check, the gate observes budget mutations
    // from already-completed in-flight dispatches at slot-acquire time, so
    // queued thunks that arrive AFTER the budget is busted are refused
    // (the parallel() batch collapses them to `null`).
    const { WorkflowBudgetImpl } = await import('./workflow-budget.js');
    const budget = new WorkflowBudgetImpl(100);
    const scheduler = new WorkflowDispatchScheduler(1);
    let dispatchCalls = 0;
    let dispatched = 0;
    let completed = 0;
    const orchestrator = new WorkflowOrchestrator(async () => {
      dispatchCalls += 1;
      budget.recordSpent(40); // 3 successful dispatches saturate the cap
      return 'ok';
    });
    // 10 thunks — far more than the budget (100 / 40 ≈ 3 successful).
    // The slot-acquire gate must reject the rest BEFORE this.dispatch
    // runs, so `dispatchCalls` is exactly 3, NOT 10.
    const outcome = await orchestrator.run({
      script: `const results = await parallel(Array.from({length: 10}, () => () => agent('q'))); return results;`,
      args: undefined,
      budget,
      scheduler,
      emitter: {
        agentDispatched: () => dispatched++,
        agentCompleted: () => completed++,
      },
    });
    // parallel() treats budget rejections as errors-as-data → null per slot.
    expect(Array.isArray(outcome.result)).toBe(true);
    const results = outcome.result as unknown[];
    expect(results).toHaveLength(10);
    const successes = results.filter((r) => r === 'ok').length;
    const nulls = results.filter((r) => r === null).length;
    expect(successes + nulls).toBe(10);
    // ASSERT it doesn't reach 10 (the without-fix overshoot value):
    // with the scheduler pinned to limit 1, slot-acquire re-checks are
    // serialized, so exactly 3 dispatches pass (spent 0/40/80 at acquire;
    // cap 100).
    expect(dispatchCalls).toBe(3);
    expect(successes).toBe(3);
    expect(dispatched).toBe(10);
    expect(completed).toBe(dispatched);
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
      return {
        script: `return 'nested-' + (await agent('inner'));`,
        name: 'child',
      };
    };
    const outcome = await orchestrator.run({
      script: `const r = await workflow('child'); return 'parent:' + r;`,
      args: undefined,
      resolveSavedWorkflow,
    });
    expect(outcome.result).toBe('parent:nested-agent:inner');
  });

  it('merges nested workflow logs into the parent run logs', async () => {
    // R11-22: nested logs (here the unconsumed-rejection mirror) reach
    // no production surface on the nested sandbox's own buffer — the
    // orchestrator reads getLogs() only on the top-level sandbox. The
    // merge must surface a failed nested dispatch in the parent run.
    const orchestrator = new WorkflowOrchestrator(() =>
      Promise.reject(new Error('nested-boom')),
    );
    const appendedLogs: string[] = [];
    const outcome = await orchestrator.run({
      script: `return 'parent:' + (await workflow('child'));`,
      args: undefined,
      emitter: {
        logAppended: (line) => appendedLogs.push(line),
      },
      resolveSavedWorkflow: async () => ({
        // The fire-and-forget dispatch fails but the nested script
        // still completes — the only trace of the failure is the
        // nested mirror line, which the merge must carry upward.
        script: `agent('x'); return 'child-done';`,
      }),
    });
    expect(outcome.result).toBe('parent:child-done');
    expect(outcome.logs).toContain(
      'dispatch failed (result not consumed): nested-boom',
    );
    expect(appendedLogs).toEqual([
      'dispatch failed (result not consumed): nested-boom',
    ]);
  });

  it('keeps a nested agent result behind the shared pause gate', async () => {
    let finishDispatch: ((value: string) => void) | undefined;
    const scheduler = new WorkflowDispatchScheduler(1);
    const orchestrator = new WorkflowOrchestrator(
      () =>
        new Promise<string>((resolve) => {
          finishDispatch = resolve;
        }),
    );
    const run = orchestrator.run({
      script: `return await workflow('child');`,
      args: undefined,
      scheduler,
      resolveSavedWorkflow: async () => ({
        script: `return await agent('inner');`,
      }),
    });
    await vi.waitFor(() => expect(finishDispatch).toBeDefined());

    scheduler.pause();
    finishDispatch?.('nested result');
    await vi.waitFor(() => expect(scheduler.snapshot().state).toBe('paused'));
    let settled = false;
    // Two arms: under a rejection-shaped gate regression the promise
    // rejects, and a fulfillment-only attach would escape as an
    // unhandledRejection instead of failing the intended assertion.
    void run.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    // Flush all microtasks + a timer tick so the negative check
    // distinguishes the pause gate from a gate-less resolve
    // (which settles in a few microtasks without one).
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);

    scheduler.resume();
    await expect(run).resolves.toMatchObject({ result: 'nested result' });
  });

  // R12 (doudouOUC): the budget gate and agent cap used to return bare
  // Promise.reject, bypassing the pause gate — a paused run whose script
  // caught the rejection kept executing. Entry-gate rejections must
  // settle through the same gate as every other settlement path.
  it('holds a budget-gate rejection behind the pause gate until resume', async () => {
    const { WorkflowBudgetImpl } = await import('./workflow-budget.js');
    const budget = new WorkflowBudgetImpl(100);
    budget.recordSpent(100); // already over cap at entry
    const scheduler = new WorkflowDispatchScheduler(1);
    scheduler.pause();
    expect(scheduler.snapshot().state).toBe('paused');

    let dispatchCalls = 0;
    const orchestrator = new WorkflowOrchestrator(async () => {
      dispatchCalls += 1;
      return 'unused';
    });
    const run = orchestrator.run({
      script: `
        let msg = 'none';
        try { await agent('over-budget'); } catch (e) { msg = e.message; }
        return msg;
      `,
      args: undefined,
      budget,
      scheduler,
    });

    let settled = false;
    void run.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    // Flush microtasks + a timer tick: without the gate the rejection
    // settles in a few microtasks, so a still-pending run after a tick
    // proves the pause gate held it.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);

    scheduler.resume();
    await expect(run).resolves.toMatchObject({
      result: expect.stringContaining('exceeded the token budget'),
    });
    expect(dispatchCalls).toBe(0);
  });

  it('holds an agent-cap rejection behind the pause gate until resume', async () => {
    const prev = process.env['QWEN_CODE_MAX_WORKFLOW_AGENTS'];
    process.env['QWEN_CODE_MAX_WORKFLOW_AGENTS'] = '1';
    try {
      const scheduler = new WorkflowDispatchScheduler(1);
      scheduler.pause();
      expect(scheduler.snapshot().state).toBe('paused');

      let dispatchCalls = 0;
      const orchestrator = new WorkflowOrchestrator(async () => {
        dispatchCalls += 1;
        return 'ok';
      });
      const run = orchestrator.run({
        script: `
          const p = agent('first');
          let msg = 'none';
          try { await agent('second'); } catch (e) { msg = e.message; }
          return msg;
        `,
        args: undefined,
        scheduler,
      });

      let settled = false;
      void run.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(settled).toBe(false);

      scheduler.resume();
      await expect(run).resolves.toMatchObject({
        result: expect.stringMatching(/exceeded the maximum of 1 agent/),
      });
      // 'first' passed the cap and dispatched on resume; 'second' never did.
      await vi.waitFor(() => expect(dispatchCalls).toBe(1));
    } finally {
      if (prev === undefined)
        delete process.env['QWEN_CODE_MAX_WORKFLOW_AGENTS'];
      else process.env['QWEN_CODE_MAX_WORKFLOW_AGENTS'] = prev;
    }
  });

  it('preserves an entry-gate rejection when cancellation aborts its pause gate', async () => {
    // Mirrors the dispatch-error variant: abort rejects the gate waiter,
    // and the reject arm must still surface the real entry-gate error.
    const { WorkflowBudgetImpl } = await import('./workflow-budget.js');
    const budget = new WorkflowBudgetImpl(100);
    budget.recordSpent(100);
    const controller = new AbortController();
    const scheduler = new WorkflowDispatchScheduler(1, controller.signal);
    scheduler.pause();
    expect(scheduler.snapshot().state).toBe('paused');

    const orchestrator = new WorkflowOrchestrator(async () => 'unused');
    const run = orchestrator.run({
      script: `
        let msg = 'none';
        try { await agent('over-budget'); } catch (e) { msg = e.message; }
        return msg;
      `,
      args: undefined,
      budget,
      scheduler,
    });

    // Mirror the sibling hold tests: a bare Promise.reject regression
    // settles the run during this wait, and abort() then finds no
    // waiters — the unsettled assertion is what pins the gate.
    let settled = false;
    void run.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    controller.abort();

    await expect(run).resolves.toMatchObject({
      result: expect.stringContaining('exceeded the token budget'),
    });
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
      if (prev === undefined)
        delete process.env['QWEN_CODE_MAX_WORKFLOW_AGENTS'];
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

  // The boundary check runs before deriveAgentKey: hash.update() throws an
  // opaque ERR_INVALID_ARG_TYPE for a non-string prompt, which would
  // preempt the dispatch's descriptive error on the journaled path.
  it('P6: rejects an invalid prompt before journal key derivation', async () => {
    const entries: Array<import('./workflow-journal.js').JournalEntry> = [];
    const journal = {
      append: (e: import('./workflow-journal.js').JournalEntry) => {
        entries.push(e);
        return Promise.resolve();
      },
    } as unknown as import('./workflow-journal.js').WorkflowJournal;
    const orchestrator = new WorkflowOrchestrator(
      async (prompt) => `r:${prompt}`,
    );
    await expect(
      orchestrator.run({
        script: `return await agent(42);`,
        args: undefined,
        journal,
      }),
    ).rejects.toThrow(/non-empty string prompt/);
    // The mis-call consumes nothing: no started marker, no result line.
    expect(entries).toHaveLength(0);
  });

  it('assigns journal ids before paused parallel dispatches can dequeue', async () => {
    const entries: Array<import('./workflow-journal.js').JournalEntry> = [];
    const journal = {
      append: (entry: import('./workflow-journal.js').JournalEntry) => {
        entries.push(entry);
        return Promise.resolve();
      },
    } as unknown as import('./workflow-journal.js').WorkflowJournal;
    const scheduler = new WorkflowDispatchScheduler(1);
    scheduler.pause();
    let dispatchCalls = 0;
    const orchestrator = new WorkflowOrchestrator(async (prompt) => {
      dispatchCalls++;
      return prompt;
    });

    const run = orchestrator.run({
      script: `return await parallel([
        () => agent('a'),
        () => agent('b'),
        () => agent('c'),
      ]);`,
      args: undefined,
      journal,
      scheduler,
    });
    await vi.waitFor(() =>
      expect(entries.filter((entry) => entry.type === 'started')).toHaveLength(
        3,
      ),
    );
    const started = entries.filter((entry) => entry.type === 'started');
    expect(started.map((entry) => entry.agentId)).toEqual(['1', '2', '3']);
    expect(new Set(started.map((entry) => entry.key)).size).toBe(3);
    expect(dispatchCalls).toBe(0);

    scheduler.resume();
    await expect(run).resolves.toMatchObject({ result: ['a', 'b', 'c'] });
  });

  it('appends an in-flight result before the paused result gate opens', async () => {
    const entries: Array<import('./workflow-journal.js').JournalEntry> = [];
    const journal = {
      append: (entry: import('./workflow-journal.js').JournalEntry) => {
        entries.push(entry);
        return Promise.resolve();
      },
    } as unknown as import('./workflow-journal.js').WorkflowJournal;
    const scheduler = new WorkflowDispatchScheduler(1);
    let finish: ((value: string) => void) | undefined;
    const orchestrator = new WorkflowOrchestrator(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );

    const run = orchestrator.run({
      script: `return await agent('a');`,
      args: undefined,
      journal,
      scheduler,
    });
    await vi.waitFor(() => expect(finish).toBeDefined());
    scheduler.pause();
    finish?.('done');
    await vi.waitFor(() => expect(scheduler.snapshot().state).toBe('paused'));
    expect(entries.filter((entry) => entry.type === 'result')).toHaveLength(1);
    let settled = false;
    // Two arms: under a rejection-shaped gate regression the promise
    // rejects, and a fulfillment-only attach would escape as an
    // unhandledRejection instead of failing the intended assertion.
    void run.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    // Flush all microtasks + a timer tick so the negative check
    // distinguishes the pause gate from a gate-less resolve
    // (which settles in a few microtasks without one).
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);

    scheduler.resume();
    await expect(run).resolves.toMatchObject({ result: 'done' });
  });

  it('preserves a dispatch error when cancellation aborts its pause gate', async () => {
    const controller = new AbortController();
    const scheduler = new WorkflowDispatchScheduler(1, controller.signal);
    let rejectDispatch: ((error: Error) => void) | undefined;
    const orchestrator = new WorkflowOrchestrator(
      () =>
        new Promise<string>((_resolve, reject) => {
          rejectDispatch = reject;
        }),
    );

    const run = orchestrator.run({
      script: `return await agent('a');`,
      args: undefined,
      scheduler,
    });
    await vi.waitFor(() => expect(rejectDispatch).toBeDefined());
    scheduler.pause();
    rejectDispatch?.(new Error('dispatch-boom'));
    await vi.waitFor(() => expect(scheduler.snapshot().state).toBe('paused'));

    controller.abort();

    await expect(run).rejects.toThrow('dispatch-boom');
  });

  it('delivers a successful dispatch result when cancellation aborts its pause gate', async () => {
    // A dispatch that succeeded before the run was cancelled must resolve
    // with its result even though abort rejects the pause-gate waiter:
    // the success arm resolves held results on abort, so this AWAITING
    // script (two-arm .then + `await p`) observes the completed work
    // instead of an AbortError. The unhandledRejection rationale for the
    // resolve-on-abort arm belongs to the next test, whose fixture is
    // genuinely fire-and-forget.
    const controller = new AbortController();
    const scheduler = new WorkflowDispatchScheduler(1, controller.signal);
    let finishDispatch: ((value: string) => void) | undefined;
    const orchestrator = new WorkflowOrchestrator(
      () =>
        new Promise<string>((resolve) => {
          finishDispatch = resolve;
        }),
    );

    const run = orchestrator.run({
      script: `
        let saw = 'none';
        const p = agent('a').then(
          (v) => { saw = 'resolved:' + v; },
          (e) => { saw = 'rejected:' + e.message; }
        );
        try { await agent('keep'); } catch (e) {}
        await p;
        return saw;
      `,
      args: undefined,
      scheduler,
    });
    await vi.waitFor(() => expect(finishDispatch).toBeDefined());
    scheduler.pause();
    finishDispatch?.('A');
    await vi.waitFor(() => expect(scheduler.snapshot().state).toBe('paused'));

    controller.abort();

    await expect(run).resolves.toMatchObject({ result: 'resolved:A' });
  });

  it('raises no unhandledRejection for an un-awaited successful dispatch on cancel', async () => {
    // The reviewer-reported alarm: a fire-and-forget agent() call whose
    // dispatch succeeded before the cancel must not surface a
    // process-level unhandledRejection ("CRITICAL: Unhandled Promise
    // Rejection") for a correctly-cancelled run.
    const controller = new AbortController();
    const scheduler = new WorkflowDispatchScheduler(1, controller.signal);
    let finishDispatch: ((value: string) => void) | undefined;
    const orchestrator = new WorkflowOrchestrator(
      () =>
        new Promise<string>((resolve) => {
          finishDispatch = resolve;
        }),
    );

    let unhandled = 0;
    const onUnhandled = () => {
      unhandled += 1;
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const run = orchestrator.run({
        script: `
          agent('notify');
          try { await agent('keep'); } catch (e) {}
          return 'done';
        `,
        args: undefined,
        scheduler,
      });
      await vi.waitFor(() => expect(finishDispatch).toBeDefined());
      scheduler.pause();
      finishDispatch?.('A');
      await vi.waitFor(() => expect(scheduler.snapshot().state).toBe('paused'));

      controller.abort();

      await expect(run).resolves.toMatchObject({ result: 'done' });
      // Let any pending unhandledRejection events fire before asserting.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toBe(0);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('raises no unhandledRejection for an un-awaited queued dispatch on cancel', async () => {
    // Error-arm counterpart of the success-path test above: a
    // fire-and-forget dispatch still QUEUED when the run is cancelled is
    // rejected with AbortError by abortPending(). The rethrow must still
    // reach awaiting callers, but the unobserved rejection must not
    // surface as a process-level unhandledRejection alarm on a
    // correctly-cancelled run.
    const controller = new AbortController();
    const scheduler = new WorkflowDispatchScheduler(1, controller.signal);
    let finishDispatch: ((value: string) => void) | undefined;
    const orchestrator = new WorkflowOrchestrator(
      () =>
        new Promise<string>((resolve) => {
          finishDispatch = resolve;
        }),
    );

    let unhandled = 0;
    const onUnhandled = () => {
      unhandled += 1;
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const run = orchestrator.run({
        script: `
          agent('inflight');
          agent('notify');
          try { await agent('keep'); } catch (e) {}
          return 'done';
        `,
        args: undefined,
        scheduler,
      });
      await vi.waitFor(() => expect(finishDispatch).toBeDefined());
      scheduler.pause();
      finishDispatch?.('A');
      await vi.waitFor(() => expect(scheduler.snapshot().state).toBe('paused'));

      controller.abort();

      await expect(run).resolves.toMatchObject({ result: 'done' });
      // Let any pending unhandledRejection events fire before asserting.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toBe(0);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('delivers a cached dispatch result when cancellation aborts its pause gate', async () => {
    const { buildReplay } = await import('./workflow-journal.js');
    const entries: Array<import('./workflow-journal.js').JournalEntry> = [];
    const journal1 = {
      append: (e: import('./workflow-journal.js').JournalEntry) => {
        entries.push(e);
        return Promise.resolve();
      },
    } as unknown as import('./workflow-journal.js').WorkflowJournal;
    const orch1 = new WorkflowOrchestrator(async (prompt) => `r:${prompt}`);
    await orch1.run({
      script: `await agent('a'); await agent('keep'); return 'done';`,
      args: undefined,
      journal: journal1,
    });

    const controller = new AbortController();
    const scheduler = new WorkflowDispatchScheduler(1, controller.signal);
    scheduler.pause();
    let completed = 0;
    const emitter = {
      agentCompleted: () => {
        completed += 1;
      },
    };
    const orch2 = new WorkflowOrchestrator(async () => 'LIVE');
    const run = orch2.run({
      script: `
        let saw = 'none';
        const p = agent('a').then(
          (v) => { saw = 'resolved:' + v; },
          (e) => { saw = 'rejected:' + e.message; }
        );
        try { await agent('keep'); } catch (e) {}
        await p;
        return saw;
      `,
      args: undefined,
      journal: { append: () => Promise.resolve() } as never,
      resumeReplay: buildReplay(entries),
      scheduler,
      emitter,
    });
    // Both dispatches are cached; their results park behind the gate.
    await vi.waitFor(() => expect(completed).toBe(2));

    controller.abort();

    await expect(run).resolves.toMatchObject({ result: 'resolved:r:a' });
  });

  it('keeps a paused run alive past the wall-clock budget and completes it after resume', async () => {
    // The wall clock is a hang backstop armed at sandbox.run start; a
    // run paused mid-flight executes nothing, so the watchdog must
    // suspend on pause and re-arm on resume instead of killing the run
    // mid-pause (after which resume is impossible).
    const prev = process.env['QWEN_CODE_MAX_WORKFLOW_SECONDS'];
    process.env['QWEN_CODE_MAX_WORKFLOW_SECONDS'] = '0.4';
    try {
      const scheduler = new WorkflowDispatchScheduler(1);
      let finishDispatch: ((value: string) => void) | undefined;
      const orchestrator = new WorkflowOrchestrator(
        () =>
          new Promise<string>((resolve) => {
            finishDispatch = resolve;
          }),
      );
      const run = orchestrator.run({
        script: `return await agent('a');`,
        args: undefined,
        scheduler,
      });
      await vi.waitFor(() => expect(finishDispatch).toBeDefined());
      scheduler.pause();
      finishDispatch?.('done');
      await vi.waitFor(() => expect(scheduler.snapshot().state).toBe('paused'));
      // Sleep past the 400 ms budget while paused.
      await new Promise((resolve) => setTimeout(resolve, 500));
      let settled = false;
      void run.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(settled).toBe(false);

      scheduler.resume();
      await expect(run).resolves.toMatchObject({ result: 'done' });
    } finally {
      if (prev === undefined)
        delete process.env['QWEN_CODE_MAX_WORKFLOW_SECONDS'];
      else process.env['QWEN_CODE_MAX_WORKFLOW_SECONDS'] = prev;
    }
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
    const scheduler = new WorkflowDispatchScheduler(1);
    scheduler.pause();
    const run = orch2.run({
      script: `const a = await agent('a'); const b = await agent('b'); return a + '|' + b;`,
      args: undefined,
      journal: journal2,
      resumeReplay: buildReplay(entries),
      scheduler,
    });
    let settled = false;
    // Two arms: under a rejection-shaped gate regression the promise
    // rejects, and a fulfillment-only attach would escape as an
    // unhandledRejection instead of failing the intended assertion.
    void run.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    // Flush all microtasks + a timer tick so the negative check
    // distinguishes the pause gate from a gate-less cached resolve
    // (which settles in ~4 microtasks without one).
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    expect(dispatchCalls).toBe(0);
    scheduler.resume();
    const outcome = await run;
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
      if (prev === undefined)
        delete process.env['QWEN_CODE_MAX_WORKFLOW_AGENTS'];
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
    nextFinalText.value = undefined;
    nextTerminateMode.value = 'GOAL';
    nextExecuteHook.value = undefined;
  });

  it('routes calls through AgentHeadless and returns getFinalText', async () => {
    const dispatch = createProductionDispatch(fakeConfig());
    const result = await dispatch('hello', { label: 'h1' });
    expect(result).toBe('headless-said:hello');
    expect(created.length).toBe(1);
    expect(created[0]!.name).toBe('h1');
    expect(created[0]!.prompt).toBe('hello');
    expect(created[0]!.agentId).toMatch(/^workflow-agent-[0-9a-f]{16}$/);
  });

  it('does not suppress env bootstrap with an empty initial history', async () => {
    const dispatch = createProductionDispatch(fakeConfig());
    await dispatch('hello', { label: 'h1' });
    expect(created[0]!.promptConfigInitialMessages).toBeUndefined();
  });

  it('strips internal tags from fast-path final text', async () => {
    nextFinalText.value =
      '<analysis>scratch</analysis><summary>clean result</summary>';
    const dispatch = createProductionDispatch(fakeConfig());

    await expect(dispatch('hello', { label: 'h1' })).resolves.toBe(
      'clean result',
    );
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

  it('installs and cleans up the approval bridge for every stalled attempt', async () => {
    let attempt = 0;
    nextExecuteHook.value = async (emitter, signal) => {
      attempt += 1;
      if (attempt > 1) {
        nextTerminateMode.value = 'GOAL';
        return;
      }
      nextTerminateMode.value = 'CANCELLED';
      emitter.emit(AgentEventType.ROUND_START, {
        subagentId: 'workflow-agent',
        round: 1,
        promptId: 'prompt-1',
        timestamp: Date.now(),
      });
      await new Promise<void>((resolve) => {
        if (signal?.aborted) return resolve();
        signal?.addEventListener('abort', () => resolve(), { once: true });
      });
    };
    const installed: Array<{
      emitter: AgentEventEmitter;
      dispatchId?: string;
    }> = [];
    const cleaned: AgentEventEmitter[] = [];
    const dispatch = createProductionDispatch(
      fakeConfig(),
      undefined,
      undefined,
      (emitter, dispatchId) => {
        installed.push({ emitter, dispatchId });
        return () => cleaned.push(emitter);
      },
    );

    await expect(
      dispatch('hello', { label: 'h1', stallMs: 5 }, 'dispatch-1'),
    ).resolves.toBe('headless-said:hello');
    expect(installed).toHaveLength(2);
    expect(installed[0]?.emitter).not.toBe(installed[1]?.emitter);
    expect(installed.map(({ dispatchId }) => dispatchId)).toEqual([
      'dispatch-1',
      'dispatch-1',
    ]);
    expect(cleaned).toEqual(installed.map(({ emitter }) => emitter));
  });

  it('bubbles a production subagent approval through the run registry and resumes after ProceedOnce', async () => {
    const registry = new WorkflowRunRegistry();
    registry.setApprovalChangeCallback(() => {});
    const config = {
      getWorkflowRunRegistry: () => registry,
    } as unknown as Config;
    let releaseApproval!: () => void;
    const approvalResolved = new Promise<void>((resolve) => {
      releaseApproval = resolve;
    });
    const respond = vi.fn(async (outcome: ToolConfirmationOutcome) => {
      expect(outcome).toBe(ToolConfirmationOutcome.ProceedOnce);
      releaseApproval();
    });
    nextExecuteHook.value = async (emitter) => {
      emitter.emit(AgentEventType.TOOL_WAITING_APPROVAL, {
        subagentId: 'workflow-agent-approval',
        round: 1,
        callId: 'call-approval',
        name: 'Shell',
        description: 'Run git status',
        args: { command: 'git status' },
        confirmationDetails: {
          type: 'exec',
          title: 'Run command?',
          command: 'git status',
          rootCommand: 'git status',
        },
        respond,
        timestamp: Date.now(),
      });
      await approvalResolved;
    };

    const handle = await WorkflowRunner.start({
      config,
      signal: new AbortController().signal,
      script: `return await agent('approval-required')`,
      args: undefined,
    });

    await vi.waitFor(() => {
      expect(registry.get(handle.runId)?.pendingApprovals).toHaveLength(1);
    });
    expect(respond).not.toHaveBeenCalled();
    const approval = registry.get(handle.runId)!.pendingApprovals[0];

    await expect(
      registry.resolvePendingApproval(
        handle.runId,
        approval.approvalId,
        ToolConfirmationOutcome.ProceedOnce,
      ),
    ).resolves.toBe(true);

    await expect(handle.completion).resolves.toMatchObject({
      ok: true,
      outcome: { result: 'headless-said:approval-required' },
    });
    expect(respond).toHaveBeenCalledOnce();
    expect(registry.get(handle.runId)?.pendingApprovals).toEqual([]);
    expect(registry.get(handle.runId)?.status).toBe('completed');
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
  // cannot loop the model indefinitely. The dispatch site resolves both
  // bounds from process.env, so delete the two knobs for this test — an
  // operator shell exporting them must not flip this hermetic assertion.
  it('passes bounded runConfig (max_turns + max_time_minutes)', async () => {
    const prevTurns = process.env['QWEN_CODE_WORKFLOW_AGENT_MAX_TURNS'];
    const prevMinutes = process.env['QWEN_CODE_WORKFLOW_AGENT_MAX_MINUTES'];
    delete process.env['QWEN_CODE_WORKFLOW_AGENT_MAX_TURNS'];
    delete process.env['QWEN_CODE_WORKFLOW_AGENT_MAX_MINUTES'];
    try {
      const dispatch = createProductionDispatch(fakeConfig());
      await dispatch('hello', { label: 'h1' });
      // Literal anchors, not the DEFAULT_* constants: an edit of the
      // constant must fail this assertion, not move it along.
      expect(created[0]!.runConfig).toEqual({
        max_turns: 50,
        max_time_minutes: 10,
      });
    } finally {
      if (prevTurns === undefined)
        delete process.env['QWEN_CODE_WORKFLOW_AGENT_MAX_TURNS'];
      else process.env['QWEN_CODE_WORKFLOW_AGENT_MAX_TURNS'] = prevTurns;
      if (prevMinutes === undefined)
        delete process.env['QWEN_CODE_WORKFLOW_AGENT_MAX_MINUTES'];
      else process.env['QWEN_CODE_WORKFLOW_AGENT_MAX_MINUTES'] = prevMinutes;
    }
  });

  // Resolver-level tests cannot catch a revert at the dispatch site: in a
  // clean env the DEFAULT_* constants and the resolvers produce identical
  // numbers, so the wiring test above stays green either way. Stub the env
  // so the dispatched runConfig itself proves the resolver is wired in.
  it('fast-path dispatch honors the env-tunable subagent bounds', async () => {
    const prevTurns = process.env['QWEN_CODE_WORKFLOW_AGENT_MAX_TURNS'];
    const prevMinutes = process.env['QWEN_CODE_WORKFLOW_AGENT_MAX_MINUTES'];
    process.env['QWEN_CODE_WORKFLOW_AGENT_MAX_TURNS'] = '120';
    process.env['QWEN_CODE_WORKFLOW_AGENT_MAX_MINUTES'] = '45';
    try {
      const dispatch = createProductionDispatch(fakeConfig());
      await dispatch('hello', { label: 'h1' });
      expect(created[0]!.runConfig).toEqual({
        max_turns: 120,
        max_time_minutes: 45,
      });
    } finally {
      if (prevTurns === undefined)
        delete process.env['QWEN_CODE_WORKFLOW_AGENT_MAX_TURNS'];
      else process.env['QWEN_CODE_WORKFLOW_AGENT_MAX_TURNS'] = prevTurns;
      if (prevMinutes === undefined)
        delete process.env['QWEN_CODE_WORKFLOW_AGENT_MAX_MINUTES'];
      else process.env['QWEN_CODE_WORKFLOW_AGENT_MAX_MINUTES'] = prevMinutes;
    }
  });

  // T11: disallow SendMessage plus tools that break workflow return/cleanup
  // contracts.
  it('disallows workflow-only floor tools for workflow subagents', async () => {
    const dispatch = createProductionDispatch(fakeConfig());
    await dispatch('hello', { label: 'h1' });
    expect(created[0]!.toolConfig?.tools).toEqual(['*']);
    expect(created[0]!.toolConfig?.disallowedTools).toEqual([
      'ask_user_question',
      'send_message',
      'monitor',
      'enter_plan_mode',
      'exit_plan_mode',
      'agent',
    ]);
  });

  // T10 (PR #4732 R1): the production dispatch must throw when the
  // subagent terminates with a non-GOAL mode. Without this, `await agent(...)`
  // would resolve to '' on user cancel and the script would keep running.
  it.each([['CANCELLED'], ['MAX_TURNS'], ['TIMEOUT'], ['ERROR']])(
    'throws when subagent terminate mode is %s',
    async (mode) => {
      nextTerminateMode.value = mode;
      const dispatch = createProductionDispatch(fakeConfig());
      await expect(dispatch('hello', { label: 'h1' })).rejects.toThrow(
        new RegExp(
          `workflow-agent-[0-9a-f]{16} did not complete \\(terminate mode: ${mode}\\)\\.`,
        ),
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

    it('resolveMaxAgentsPerRun rejects hex / scientific / non-decimal-integer overrides', () => {
      // Number('0x10')=16, Number('1e3')=1000, Number('1.0')=1 pass
      // Number.isInteger; only plain decimal integers should override the cap.
      for (const raw of ['0x10', '1e3', '1.0']) {
        expect(
          resolveMaxAgentsPerRun({ QWEN_CODE_MAX_WORKFLOW_AGENTS: raw }),
        ).toBe(DEFAULT_MAX_AGENTS_PER_RUN);
      }
    });

    it('resolveConcurrencyLimit treats hex / scientific overrides as invalid (cpu default)', () => {
      // An invalid override falls back to the cpu-derived default in [1,16];
      // 0x10/1e2 must be rejected too, not parsed as 16/100.
      const cpuDefault = resolveConcurrencyLimit({
        QWEN_CODE_MAX_WORKFLOW_CONCURRENCY: '-1',
      });
      for (const raw of ['0x10', '1e2']) {
        expect(
          resolveConcurrencyLimit({ QWEN_CODE_MAX_WORKFLOW_CONCURRENCY: raw }),
        ).toBe(cpuDefault);
      }
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

    // A build-and-test agent, or an analysis of a 2 000-line file, exceeds
    // 50 turns / 10 minutes routinely — and under GOAL-terminal semantics
    // being cut off shows up as a `null` element, i.e. an agent that
    // silently went missing. Both bounds are operator-tunable, on the same
    // contract as the agent cap.
    it('per-subagent bounds default, honor an override, and clamp', () => {
      expect(resolveSubagentMaxTurns({})).toBe(
        DEFAULT_WORKFLOW_SUBAGENT_MAX_TURNS,
      );
      expect(resolveSubagentMaxTimeMinutes({})).toBe(
        DEFAULT_WORKFLOW_SUBAGENT_MAX_TIME_MINUTES,
      );
      expect(
        resolveSubagentMaxTurns({ QWEN_CODE_WORKFLOW_AGENT_MAX_TURNS: '120' }),
      ).toBe(120);
      expect(
        resolveSubagentMaxTimeMinutes({
          QWEN_CODE_WORKFLOW_AGENT_MAX_MINUTES: '45',
        }),
      ).toBe(45);
      // Literal anchors for the hard ceilings — comparing against the
      // HARD_* constants would assert them against themselves.
      expect(
        resolveSubagentMaxTurns({
          QWEN_CODE_WORKFLOW_AGENT_MAX_TURNS: '999999',
        }),
      ).toBe(500);
      expect(
        resolveSubagentMaxTimeMinutes({
          QWEN_CODE_WORKFLOW_AGENT_MAX_MINUTES: '999999',
        }),
      ).toBe(100);
    });

    it('per-subagent bounds reject non-decimal-integer overrides', () => {
      for (const raw of ['0', 'abc', '2.5', '0x10', '1e3']) {
        expect(
          resolveSubagentMaxTurns({ QWEN_CODE_WORKFLOW_AGENT_MAX_TURNS: raw }),
        ).toBe(DEFAULT_WORKFLOW_SUBAGENT_MAX_TURNS);
        expect(
          resolveSubagentMaxTimeMinutes({
            QWEN_CODE_WORKFLOW_AGENT_MAX_MINUTES: raw,
          }),
        ).toBe(DEFAULT_WORKFLOW_SUBAGENT_MAX_TIME_MINUTES);
      }
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
    pinStub.resolve.value = undefined;
    pinStub.seenLabels.length = 0;
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
    /** What the subagent's Config answers for "where am I?". */
    runtimeTargetDir?: string;
    runtimeIgnoreFiles?: string;
    options?: { runConfigOverrides?: unknown };
    eventEmitterAttached: boolean;
    executeAgentId?: string | null;
  };

  function fakeConfigWithMgr(opts: {
    transcriptDir?: string;
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
      runWithEmitter?: (
        emitter: { emit(event: string, payload: unknown): void },
        signal?: AbortSignal,
      ) => void | Promise<void>;
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
      getFileFilteringOptions: () => ({
        respectGitIgnore: true,
        respectQwenIgnore: true,
        customIgnoreFiles: ['.cursorignore'],
      }),
      getSessionId: () => 'sess_fake_test_id',
      getProjectRoot: () => opts.transcriptDir ?? '/fake/repo',
      getCliVersion: () => '9.9.9',
      storage: opts.transcriptDir
        ? { getProjectDir: () => opts.transcriptDir }
        : undefined,
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
            runtimeTargetDir: runtimeContext.getTargetDir(),
            runtimeIgnoreFiles: runtimeContext
              .getFileService?.()
              .getQwenIgnoreFileNamesDisplay(),
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
                const { getCurrentAgentId } = await import(
                  './agent-context.js'
                );
                call.executeAgentId = getCurrentAgentId();
                if (outcome.runWithEmitter && options?.eventEmitter) {
                  await outcome.runWithEmitter(
                    options.eventEmitter as {
                      emit(event: string, payload: unknown): void;
                    },
                    signal,
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
    const result = await dispatch('find foo', {
      agentType: 'Explore',
      label: 'explore-1',
    });
    expect(result).toBe('explore-output');
    expect(calls).toHaveLength(1);
    expect(calls[0].config.name).toBe('Explore');
    expect(calls[0].executeAgentId).toMatch(/^workflow-agent-[0-9a-f]{16}$/);
    // Workflow floor [AskUserQuestion, SendMessage, Monitor, EnterPlanMode,
    // ExitPlanMode, Agent] must be unioned in.
    expect(calls[0].config.disallowedTools).toEqual(
      expect.arrayContaining([
        'ask_user_question',
        'send_message',
        'monitor',
        'enter_plan_mode',
        'exit_plan_mode',
        'agent',
      ]),
    );
  });

  it('records override-path events in the workflow transcript', async () => {
    const transcriptDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'wf-override-transcript-'),
    );
    try {
      const { config, calls } = fakeConfigWithMgr({
        transcriptDir,
        onCreate: async () => ({
          finalText: 'override-output',
          terminateMode: 'GOAL',
          runWithEmitter: (emitter) => {
            emitter.emit(AgentEventType.ROUND_TEXT, {
              subagentId: 'sub',
              round: 1,
              text: 'override transcript output',
              thoughtText: '',
              timestamp: 1,
            });
          },
        }),
      });

      await createProductionDispatch(config)('override prompt', {
        model: 'override-model',
      });

      const sessionDir = path.join(
        transcriptDir,
        'subagents',
        'sess_fake_test_id',
      );
      const names = fs
        .readdirSync(sessionDir)
        .filter((name) => name.endsWith('.jsonl'));
      expect(names).toHaveLength(1);
      const records = fs
        .readFileSync(path.join(sessionDir, names[0]!), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(records).toHaveLength(2);
      expect(records[1]!['parentUuid']).toBe(records[0]!['uuid']);
      expect(records[1]!['agentId']).toBe(records[0]!['agentId']);
      expect(calls[0]!.executeAgentId).toBe(records[0]!['agentId']);
    } finally {
      fs.rmSync(transcriptDir, { recursive: true, force: true });
    }
  });

  // An unlabeled override-path dispatch runs the runtime agent under the
  // agentType's resolved canonical name; the transcript must record that
  // same identity — not the generic default and not the raw spelling the
  // script happened to pass (the SubagentManager lookup is
  // case-insensitive). agentName is the only human-readable agent identity
  // a workflow dispatch leaves on disk.
  it('records the agentType name in the transcript for an unlabeled override dispatch', async () => {
    const transcriptDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'wf-override-transcript-'),
    );
    try {
      const { config, calls } = fakeConfigWithMgr({
        transcriptDir,
        // Case-insensitive like the real SubagentManager lookup.
        findSubagentByName: async (name) =>
          name.toLowerCase() === 'code-reviewer'
            ? {
                name: 'code-reviewer',
                description: 'reviews chunks',
                systemPrompt: 'You review code.',
                level: 'session',
              }
            : null,
        onCreate: async () => ({
          finalText: 'review-output',
          terminateMode: 'GOAL',
        }),
      });

      await createProductionDispatch(config)('review chunk 1 of 3', {
        agentType: 'Code-Reviewer',
      });

      expect(calls[0]!.config.name).toBe('code-reviewer');
      const sessionDir = path.join(
        transcriptDir,
        'subagents',
        'sess_fake_test_id',
      );
      const names = fs
        .readdirSync(sessionDir)
        .filter((name) => name.endsWith('.jsonl'));
      expect(names).toHaveLength(1);
      const first = JSON.parse(
        fs
          .readFileSync(path.join(sessionDir, names[0]!), 'utf8')
          .split('\n')[0]!,
      ) as Record<string, unknown>;
      expect(first['agentName']).toBe('code-reviewer');
    } finally {
      fs.rmSync(transcriptDir, { recursive: true, force: true });
    }
  });

  // With BOTH label and agentType set the transcript must stamp the same
  // identity the runtime agent runs under — the resolved agentType's
  // canonical name. A label cannot rename a resolved agentType: a fan-out
  // that labels each chunk would otherwise attribute every on-disk record
  // to the label while the agent that ran is the agentType, and consumers
  // aggregating by agentName could not correlate those dispatches with
  // AgentTool launches of the same agentType.
  it('stamps the resolved agentType name in the transcript when a label is also set', async () => {
    const transcriptDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'wf-override-transcript-'),
    );
    try {
      const { config, calls } = fakeConfigWithMgr({
        transcriptDir,
        findSubagentByName: async (name) =>
          name.toLowerCase() === 'code-reviewer'
            ? {
                name: 'code-reviewer',
                description: 'reviews chunks',
                systemPrompt: 'You review code.',
                level: 'session',
              }
            : null,
        onCreate: async () => ({
          finalText: 'review-output',
          terminateMode: 'GOAL',
        }),
      });

      await createProductionDispatch(config)('review chunk 1 of 3', {
        agentType: 'Code-Reviewer',
        label: 'chunk-1',
      });

      expect(calls[0]!.config.name).toBe('code-reviewer');
      const sessionDir = path.join(
        transcriptDir,
        'subagents',
        'sess_fake_test_id',
      );
      const names = fs
        .readdirSync(sessionDir)
        .filter((name) => name.endsWith('.jsonl'));
      expect(names).toHaveLength(1);
      const first = JSON.parse(
        fs
          .readFileSync(path.join(sessionDir, names[0]!), 'utf8')
          .split('\n')[0]!,
      ) as Record<string, unknown>;
      expect(first['agentName']).toBe(calls[0]!.config.name);
    } finally {
      fs.rmSync(transcriptDir, { recursive: true, force: true });
    }
  });

  // The agentType definition is resolved exactly once per dispatch:
  // resolveWorkflowAgentIdentity hands the resolved config to the override
  // path instead of letting it re-run findSubagentByName — an uncached
  // directory read + frontmatter parse per non-session level, paid on the
  // dispatch hot path and again per stall-retry attempt.
  it('resolves the agentType once per dispatch instead of per path', async () => {
    let lookups = 0;
    const { config } = fakeConfigWithMgr({
      findSubagentByName: async (name) => {
        lookups += 1;
        return name === 'Explore'
          ? {
              name: 'Explore',
              description: 'fast read-only',
              systemPrompt: 'You are Explore.',
              level: 'builtin',
            }
          : null;
      },
      onCreate: async () => ({ finalText: 'done', terminateMode: 'GOAL' }),
    });

    await createProductionDispatch(config)('find foo', {
      agentType: 'Explore',
    });

    expect(lookups).toBe(1);
  });

  // The identity invariant's third leg: an ephemeral override (model /
  // isolation / schema only, no agentType) runs the runtime agent under the
  // resolved display name and the transcript records that same name — a
  // labeled model-only dispatch must not diverge into an unlabeled runtime
  // agent.
  it('runs a labeled model-only override under the label and records it in the transcript', async () => {
    const transcriptDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'wf-override-transcript-'),
    );
    try {
      const { config, calls } = fakeConfigWithMgr({
        transcriptDir,
        onCreate: async () => ({
          finalText: 'model-output',
          terminateMode: 'GOAL',
        }),
      });

      await createProductionDispatch(config)('probe task', {
        label: 'labeled-model',
        model: 'm',
      });

      expect(calls[0]!.config.name).toBe('labeled-model');
      const sessionDir = path.join(
        transcriptDir,
        'subagents',
        'sess_fake_test_id',
      );
      const names = fs
        .readdirSync(sessionDir)
        .filter((name) => name.endsWith('.jsonl'));
      expect(names).toHaveLength(1);
      const first = JSON.parse(
        fs
          .readFileSync(path.join(sessionDir, names[0]!), 'utf8')
          .split('\n')[0]!,
      ) as Record<string, unknown>;
      expect(first['agentName']).toBe('labeled-model');
    } finally {
      fs.rmSync(transcriptDir, { recursive: true, force: true });
    }
  });

  // resolveWorkflowAgentIdentity's truthy check keeps `agentType: ''` from
  // naming the agent '' — the dispatch still throws "agent type '' not
  // found", but the transcript seeded before that throw records the shared
  // default, not a blank identity.
  it('never records a blank identity for an empty agentType', async () => {
    const transcriptDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'wf-override-transcript-'),
    );
    try {
      const { config } = fakeConfigWithMgr({
        transcriptDir,
        findSubagentByName: async () => null,
        onCreate: async () => ({
          finalText: '',
          terminateMode: 'GOAL',
        }),
      });

      await expect(
        createProductionDispatch(config)('task', { agentType: '' }),
      ).rejects.toThrow(/agent type '' not found/);

      const sessionDir = path.join(
        transcriptDir,
        'subagents',
        'sess_fake_test_id',
      );
      const names = fs
        .readdirSync(sessionDir)
        .filter((name) => name.endsWith('.jsonl'));
      expect(names).toHaveLength(1);
      const first = JSON.parse(
        fs
          .readFileSync(path.join(sessionDir, names[0]!), 'utf8')
          .split('\n')[0]!,
      ) as Record<string, unknown>;
      expect(first['agentName']).toBe('workflow-agent');
    } finally {
      fs.rmSync(transcriptDir, { recursive: true, force: true });
    }
  });

  // The stall wrapper's abandoned error interpolates the dispatch's display
  // name; when that name comes from a model-authored agentType definition
  // (validateName charset-checks the TRIMMED name, so a definition named
  // 'rev\n' registers with the raw name), control characters must not
  // fragment the single-line error.
  it('sanitizes control characters out of the agentType stall error', async () => {
    const { config } = fakeConfigWithMgr({
      findSubagentByName: async (name) =>
        name === 'rev\n'
          ? {
              name: 'rev\n',
              description: 'newline-named reviewer',
              systemPrompt: 'You review code.',
              level: 'session',
            }
          : null,
      onCreate: async () => ({
        finalText: '',
        terminateMode: 'CANCELLED',
        runWithEmitter: async (emitter, signal) => {
          emitter.emit(AgentEventType.ROUND_START, {
            subagentId: 'sub',
            round: 1,
            promptId: 'p1',
            timestamp: Date.now(),
          });
          await new Promise<void>((resolve) => {
            if (signal?.aborted) return resolve();
            signal?.addEventListener('abort', () => resolve(), { once: true });
          });
        },
      }),
    });

    const dispatch = createProductionDispatch(config);
    const error: unknown = await dispatch('doomed', {
      agentType: 'rev\n',
      stallMs: 5,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain('\n');
    expect((error as Error).message).toContain(
      'agent "rev" stalled on all 3 attempts',
    );
  });

  it('strips internal tags from override-path final text', async () => {
    const { config } = fakeConfigWithMgr({
      findSubagentByName: async () => ({
        name: 'Explore',
        description: 'fast read-only',
        systemPrompt: 'You are Explore.',
        level: 'builtin',
      }),
      onCreate: async () => ({
        finalText:
          '<analysis>scratch</analysis><summary>clean result</summary>',
        terminateMode: 'GOAL',
      }),
    });
    const dispatch = createProductionDispatch(config);

    await expect(dispatch('find foo', { agentType: 'Explore' })).resolves.toBe(
      'clean result',
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

  // Same wiring guard as the fast-path sibling above, for the override
  // dispatch site: with a clean env the resolvers and the DEFAULT_*
  // constants are indistinguishable, so only a stubbed env proves the
  // runConfigOverrides handed to createAgentHeadless come from the
  // resolvers.
  it('override-path dispatch honors the env-tunable subagent bounds', async () => {
    const prevTurns = process.env['QWEN_CODE_WORKFLOW_AGENT_MAX_TURNS'];
    const prevMinutes = process.env['QWEN_CODE_WORKFLOW_AGENT_MAX_MINUTES'];
    process.env['QWEN_CODE_WORKFLOW_AGENT_MAX_TURNS'] = '120';
    process.env['QWEN_CODE_WORKFLOW_AGENT_MAX_MINUTES'] = '45';
    try {
      const helper = fakeConfigWithMgr({
        onCreate: async () => ({ finalText: 'ok', terminateMode: 'GOAL' }),
      });
      await createProductionDispatch(helper.config)('hi', {
        model: 'qwen3-max',
      });
      expect(helper.calls[0]!.options?.runConfigOverrides).toEqual({
        max_turns: 120,
        max_time_minutes: 45,
      });
    } finally {
      if (prevTurns === undefined)
        delete process.env['QWEN_CODE_WORKFLOW_AGENT_MAX_TURNS'];
      else process.env['QWEN_CODE_WORKFLOW_AGENT_MAX_TURNS'] = prevTurns;
      if (prevMinutes === undefined)
        delete process.env['QWEN_CODE_WORKFLOW_AGENT_MAX_MINUTES'];
      else process.env['QWEN_CODE_WORKFLOW_AGENT_MAX_MINUTES'] = prevMinutes;
    }
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
    // Union: Foo (from agentType) + workflow-only floor.
    expect(disallowed).toEqual(
      expect.arrayContaining([
        'Foo',
        'ask_user_question',
        'send_message',
        'monitor',
        'enter_plan_mode',
        'exit_plan_mode',
        'agent',
      ]),
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
      expect.arrayContaining([
        'Foo',
        'ask_user_question',
        'send_message',
        'monitor',
        'enter_plan_mode',
        'exit_plan_mode',
        'agent',
      ]),
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
    // The thrown message must NOT contain raw newlines / NULs.
    let error: unknown;
    try {
      await dispatch('hi', { agentType: evil });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(Error);
    const msg = (error as Error).message;
    // eslint-disable-next-line no-control-regex
    expect(msg).not.toMatch(/[\n\r\u0000\u007f]/);
    expect(msg).toContain('not found');
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

  // ─── workingDir: pin to a caller-owned worktree ─────────────────

  // The fast path hands `config` to AgentHeadless untouched and has no way
  // to rebind a directory, so a `workingDir` that reached it would be
  // silently dropped and the agent would run in the parent working tree —
  // the exact failure the option exists to prevent.
  it('workingDir forces the override path even with no agentType/model/schema', async () => {
    const helper = fakeConfigWithMgr({
      onCreate: async () => ({ finalText: 'pinned', terminateMode: 'GOAL' }),
    });
    created.length = 0;

    await expect(
      createProductionDispatch(helper.config)('hi', {
        workingDir: '.qwen/tmp/review-pr-7',
      }),
    ).resolves.toBe('pinned');

    // Went through SubagentManager, not the fast path's AgentHeadless.create.
    expect(helper.calls).toHaveLength(1);
    expect(created).toHaveLength(0);
  });

  it('workingDir rebinds the subagent runtime context to the pinned directory', async () => {
    const helper = fakeConfigWithMgr({
      onCreate: async () => ({ finalText: 'pinned', terminateMode: 'GOAL' }),
    });
    await createProductionDispatch(helper.config)('hi', {
      workingDir: '.qwen/tmp/review-pr-7',
    });

    // The subagent's Config answers with the pinned directory, not the
    // parent's '/fake/repo' — that rebind is what makes its file, shell and
    // search tools resolve inside the worktree.
    expect(helper.calls[0]!.runtimeTargetDir).toBe(
      '/fake/repo/.qwen/tmp/review-pr-7',
    );
    expect(helper.calls[0]!.runtimeContextSame).toBe(false);
    expect(helper.calls[0]!.runtimeIgnoreFiles).toContain('.cursorignore');
  });

  it('workingDir rejects invalid values before dispatch', async () => {
    const helper = fakeConfigWithMgr({
      onCreate: async () => ({ finalText: 'unused', terminateMode: 'GOAL' }),
    });

    await expect(
      createProductionDispatch(helper.config)('hi', { workingDir: '' }),
    ).rejects.toThrow(/workingDir.*non-empty string/);
    expect(helper.calls).toHaveLength(0);
  });

  it('workingDir rejects whitespace-only values at the entrance', async () => {
    const helper = fakeConfigWithMgr({
      onCreate: async () => ({ finalText: 'unused', terminateMode: 'GOAL' }),
    });

    await expect(
      createProductionDispatch(helper.config)('hi', { workingDir: '  ' }),
    ).rejects.toThrow(/workingDir.*non-empty string/);
    expect(helper.calls).toHaveLength(0);
  });

  // The sandbox gate names this contradiction too, but it reads the raw opts
  // BEFORE the JSON revival — an enumerable getter can withhold `isolation`
  // during validation and surface it at stringify time. The orchestrator sees
  // the revived plain object, so its refusal is the one that cannot be
  // evaded; without it, isolation would silently win and workingDir would be
  // dropped — the opposite of AgentTool's documented working_dir-wins rule.
  it('workingDir + isolation throws instead of letting one silently win', async () => {
    const helper = fakeConfigWithMgr({
      onCreate: async () => ({ finalText: 'unused', terminateMode: 'GOAL' }),
    });

    await expect(
      createProductionDispatch(helper.config)('hi', {
        workingDir: '.qwen/tmp/review-pr-7',
        isolation: 'worktree',
      }),
    ).rejects.toThrow(/incompatible options/);
    expect(helper.calls).toHaveLength(0);
    expect(worktreeStubs.instances).toHaveLength(0);
  });

  // A refused pin must abort the dispatch, not fall through to an agent
  // running in the parent tree — the failure mode the pin exists to prevent.
  it('workingDir surfaces the resolver refusal and dispatches nothing', async () => {
    const helper = fakeConfigWithMgr({
      onCreate: async () => ({ finalText: 'unused', terminateMode: 'GOAL' }),
    });
    pinStub.resolve.value = async () => ({
      error: 'workingDir "x" is not a registered linked worktree.',
    });

    await expect(
      createProductionDispatch(helper.config)('hi', {
        workingDir: 'not-a-worktree',
      }),
    ).rejects.toThrow(
      /agent\(\{workingDir: "not-a-worktree"\}\).*not a registered linked worktree/,
    );
    expect(helper.calls).toHaveLength(0);
  });

  it('workingDir scrubs control characters from resolver errors', async () => {
    const helper = fakeConfigWithMgr({
      onCreate: async () => ({ finalText: 'unused', terminateMode: 'GOAL' }),
    });
    pinStub.resolve.value = async () => ({
      error: 'refused\r\nforged\u0000line',
    });

    let error: unknown;
    try {
      await createProductionDispatch(helper.config)('hi', {
        workingDir: 'not-a-worktree',
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain('\r');
    expect((error as Error).message).not.toContain('\n');
    expect((error as Error).message).not.toContain('\u0000');
    expect(helper.calls).toHaveLength(0);
  });

  // Same threat on the other interpolated half: the refusal echoes the
  // model-authored `workingDir` itself, and `JSON.stringify` escapes only
  // C0 (U+0000-U+001F), so DEL and the C1 range (incl. NEL U+0085) reach
  // the message raw unless the echo is sanitized too.
  it('workingDir refusal scrubs control characters from the echoed workingDir', async () => {
    const helper = fakeConfigWithMgr({
      onCreate: async () => ({ finalText: 'unused', terminateMode: 'GOAL' }),
    });
    pinStub.resolve.value = async () => ({
      error: 'not a registered linked worktree.',
    });

    let error: unknown;
    try {
      await createProductionDispatch(helper.config)('hi', {
        workingDir: 'x\u0085forged\u007fline',
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain('\u0085');
    expect((error as Error).message).not.toContain('\u007f');
    expect(helper.calls).toHaveLength(0);
  });

  // The resolver names the offending parameter in its errors; a workflow
  // script never wrote `working_dir`, so it must be told the opt's own name.
  it('names the workflow opt, not the tool parameter, when resolving', async () => {
    const helper = fakeConfigWithMgr({
      onCreate: async () => ({ finalText: 'ok', terminateMode: 'GOAL' }),
    });
    await createProductionDispatch(helper.config)('hi', { workingDir: 'wt' });
    expect(pinStub.seenLabels).toEqual(['workingDir']);
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
        new RegExp(
          `workflow-agent-[0-9a-f]{16} did not complete \\(terminate mode: ${mode}\\)\\.`,
        ),
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

// Every workflow `agent()` dispatch leaves the same per-agent JSONL
// transcript AgentTool writes, in the same session-scoped directory. Before
// this, a finished workflow run left only the journal — which stores a hash
// of the prompt, not the prompt, and no `result` line at all for a dispatch
// that threw.
describe('createProductionDispatch — subagent transcripts', () => {
  let projectDir: string;

  beforeEach(() => {
    created.length = 0;
    nextFinalText.value = undefined;
    nextTerminateMode.value = 'GOAL';
    nextExecuteHook.value = undefined;
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-transcript-'));
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  function transcriptConfig(): Config {
    return {
      getSessionId: () => 'sess-1',
      getProjectRoot: () => projectDir,
      getCliVersion: () => '9.9.9',
      storage: { getProjectDir: () => projectDir },
    } as unknown as Config;
  }

  const sessionDir = () => path.join(projectDir, 'subagents', 'sess-1');

  function transcriptNames(): string[] {
    if (!fs.existsSync(sessionDir())) return [];
    return fs.readdirSync(sessionDir()).filter((n) => n.endsWith('.jsonl'));
  }

  function recordsIn(name: string): Array<Record<string, unknown>> {
    return fs
      .readFileSync(path.join(sessionDir(), name), 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  const partsOf = (rec: Record<string, unknown>): unknown[] =>
    ((rec['message'] as { parts?: unknown[] } | undefined)?.parts ??
      []) as unknown[];

  it('writes one transcript per dispatch, seeded with the dispatched prompt', async () => {
    const dispatch = createProductionDispatch(transcriptConfig());
    await dispatch('review chunk 3 of 7', { label: 'chunk-3' });

    const names = transcriptNames();
    expect(names).toHaveLength(1);
    const recs = recordsIn(names[0]!);
    // The launch prompt is the first `user` record — the shape every
    // transcript reader already recovers a launch prompt from.
    expect(recs[0]!['type']).toBe('user');
    expect(partsOf(recs[0]!)).toEqual([{ text: 'review chunk 3 of 7' }]);
    expect(recs[0]!['agentId']).toMatch(/^workflow-agent-[0-9a-f]{16}$/);
    expect(recs[0]!['agentName']).toBe('chunk-3');
    expect(recs[0]!['sessionId']).toBe('sess-1');
    // Launch metadata flows through buildAgentTranscriptAttach — pin it
    // here so a dropped builder wiring line fails the suite.
    expect(recs[0]!['version']).toBe('9.9.9');
    expect(recs[0]!['cwd']).toBe(projectDir);
    expect(names[0]).toBe(`agent-${recs[0]!['agentId'] as string}.jsonl`);
  });

  // An empty prompt seeds no user record, so the transcript would give no
  // evidence of what the agent was asked — the dispatch is rejected at the
  // boundary instead, before any transcript is started.
  it('rejects an empty or non-string prompt before attaching a transcript', async () => {
    const dispatch = createProductionDispatch(transcriptConfig());
    await expect(dispatch('', { label: 'empty' })).rejects.toThrow(
      /non-empty string prompt/,
    );
    await expect(
      dispatch(42 as unknown as string, { label: 'bad' }),
    ).rejects.toThrow(/non-empty string prompt/);
    expect(transcriptNames()).toHaveLength(0);
  });

  // The display name is resolved once and handed to both the runtime agent
  // and the transcript, so an empty label cannot diverge into a runtime
  // agent named '' whose transcript says 'workflow-agent'.
  it('keeps the runtime agent name and the transcript aligned for an empty label', async () => {
    const dispatch = createProductionDispatch(transcriptConfig());
    await dispatch('task', { label: '' });

    expect(created).toHaveLength(1);
    expect(created[0]!.name).toBe('workflow-agent');
    const recs = recordsIn(transcriptNames()[0]!);
    expect(recs[0]!['agentName']).toBe('workflow-agent');
  });

  it("records the subagent's tool calls and their results", async () => {
    nextExecuteHook.value = async (emitter) => {
      emitter.emit(AgentEventType.TOOL_CALL, {
        subagentId: 'sub',
        round: 1,
        callId: 'c1',
        name: 'read_file',
        args: { absolute_path: '/tmp/diff.txt', offset: 0, limit: 40 },
        description: 'read the diff',
        timestamp: 1,
      });
      emitter.emit(AgentEventType.TOOL_RESPONSES_FINALIZED, {
        subagentId: 'sub',
        round: 1,
        responses: [
          {
            callId: 'c1',
            responseParts: [
              {
                functionResponse: {
                  id: 'c1',
                  name: 'read_file',
                  response: { output: 'diff text' },
                },
              },
            ],
          },
        ],
        timestamp: 2,
      });
    };

    const dispatch = createProductionDispatch(transcriptConfig());
    await dispatch('read it', { label: 'reader' });

    const recs = recordsIn(transcriptNames()[0]!);
    expect(partsOf(recs[1]!)).toEqual([
      {
        functionCall: {
          id: 'c1',
          name: 'read_file',
          args: { absolute_path: '/tmp/diff.txt', offset: 0, limit: 40 },
        },
      },
    ]);
    expect(recs[2]!['type']).toBe('tool_result');
    expect(recs[2]!['toolCallResult']).toEqual({ callId: 'c1' });
  });

  // A stall-retried dispatch is ONE `agent()` call. Minting the agent id per
  // attempt would present it to every transcript reader as two agents — one
  // of them with almost no tool calls, which is exactly the shape a coverage
  // gate reads as an agent that did nothing.
  it('appends a stall retry to the first attempt transcript', async () => {
    let attempt = 0;
    nextExecuteHook.value = async (emitter, signal) => {
      attempt += 1;
      if (attempt > 1) {
        nextTerminateMode.value = 'GOAL';
        emitter.emit(AgentEventType.ROUND_TEXT, {
          subagentId: 'workflow-agent',
          round: 2,
          text: 'retry completed',
          thoughtText: '',
          timestamp: Date.now(),
        });
        return;
      }
      nextTerminateMode.value = 'CANCELLED';
      emitter.emit(AgentEventType.ROUND_START, {
        subagentId: 'workflow-agent',
        round: 1,
        promptId: 'prompt-1',
        timestamp: Date.now(),
      });
      await new Promise<void>((resolve) => {
        if (signal?.aborted) return resolve();
        signal?.addEventListener('abort', () => resolve(), { once: true });
      });
    };

    const dispatch = createProductionDispatch(transcriptConfig());
    await expect(dispatch('flaky', { label: 'f1', stallMs: 5 })).resolves.toBe(
      'headless-said:flaky',
    );

    expect(attempt).toBe(2);
    const names = transcriptNames();
    expect(names).toHaveLength(1);
    // One launch record, not one per attempt.
    const records = recordsIn(names[0]!);
    const users = records.filter((r) => r['type'] === 'user');
    expect(users).toHaveLength(1);
    // The retry seam is visible on disk: attempt 2 seeded an agent_retry
    // system marker before its own records.
    expect(records[1]!['type']).toBe('system');
    expect(records[1]!['subtype']).toBe('agent_retry');
    expect(records[1]!['systemPayload']).toEqual({ attempt: 2 });
    // Attempt 2's own records follow the marker — a retried agent that did
    // nothing would end the file at the marker, exactly the shape the
    // comment above warns about.
    expect(records.map((r) => r['type'])).toEqual([
      'user',
      'system',
      'assistant',
    ]);
    expect(partsOf(records[2]!)).toEqual([{ text: 'retry completed' }]);
    for (let i = 1; i < records.length; i++) {
      expect(records[i]!['parentUuid']).toBe(records[i - 1]!['uuid']);
      expect(records[i]!['agentId']).toBe(records[0]!['agentId']);
    }
    expect(created).toHaveLength(2);
    expect(created.map((call) => call.agentId)).toEqual([
      records[0]!['agentId'],
      records[0]!['agentId'],
    ]);
  });

  // The journal writes no `result` line for a dispatch that throws, so a
  // failed agent is invisible there. The transcript is what keeps it
  // visible — the run left evidence of what it was asked and how far it got.
  it('leaves a transcript for a dispatch that ends on a non-GOAL terminal', async () => {
    nextTerminateMode.value = 'MAX_TURNS';
    const dispatch = createProductionDispatch(transcriptConfig());

    await expect(dispatch('doomed', { label: 'd1' })).rejects.toThrow(
      /did not complete \(terminate mode: MAX_TURNS\)/,
    );

    const names = transcriptNames();
    expect(names).toHaveLength(1);
    expect(partsOf(recordsIn(names[0]!)[0]!)).toEqual([{ text: 'doomed' }]);
  });

  it('is best-effort: a config that cannot supply the paths still dispatches', async () => {
    const dispatch = createProductionDispatch(fakeConfig());
    await expect(dispatch('hello', { label: 'h1' })).resolves.toBe(
      'headless-said:hello',
    );
    expect(transcriptNames()).toHaveLength(0);
  });
});
