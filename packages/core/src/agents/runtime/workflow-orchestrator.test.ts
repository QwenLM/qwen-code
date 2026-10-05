/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

// T7 (PR #4732 R1): `vi` directly, like every other test file in the repo.
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
  type WorkflowAgentDispatch,
  type WorkflowRunRequest,
} from './workflow-orchestrator.js';
import type {
  ApprovalMode,
  Config,
  SessionWorkflowPlanRevision,
} from '../../config/config.js';
import { AgentEventType, type AgentEventEmitter } from './agent-events.js';
import { ToolConfirmationOutcome } from '../../tools/tools.js';
import { WorkflowRunRegistry } from '../workflow-run-registry.js';
import { WorkflowRunner } from './workflow-runner.js';
import { WorkflowDispatchScheduler } from './workflow-dispatch-scheduler.js';
import {
  isWorkflowAgentFailedError,
  WorkflowAgentCapExceededError,
  WorkflowAgentFailedError,
} from './workflow-agent-failure.js';
import { WorkflowBudgetImpl } from './workflow-budget.js';
import {
  buildReplay,
  deriveAgentKey,
  deriveArgsSeed,
  DISPATCH_AFFECTING_AGENT_OPTS,
  type JournalEntry,
  type WorkflowJournal,
} from './workflow-journal.js';
import { resolveBuiltinToolName } from '../../tools/tool-names.js';
import { fnCall, fnResponse } from '../../test-utils/model-fixtures.js';
import { SyntheticOutputTool } from '../../tools/syntheticOutput.js';
import { SchemaValidator } from '../../utils/schemaValidator.js';
import type { WorkflowOrchestratorEmitter } from './workflow-sandbox.js';

// FIX-C3 (TST-2-C1): hoisted, so `created` exists for the vi.mock factory and
// resets per case (accumulating, it let later tests pass by coincidence).
// FIX-C8 (TST-2-I2): the full create/execute signatures, so drift fails.
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
    taskName?: string;
    subagentId?: string;
    executeOptions?: { enforceTimeLimitDuringRetryWait?: boolean };
  }>,
  nextFinalText: { value: undefined as string | undefined },
  // T10 (PR #4732 R1): simulates non-GOAL modes, on which the dispatch throws.
  nextTerminateMode: { value: 'GOAL' as string },
  // R1 (#1 + #3): getExecutionSummary().outputTokens, observed via onTokens.
  nextOutputTokens: { value: 0 as number },
  // R3 (wenshao #6): makes execute() throw, as the real one does on
  // reasoning-loop failure after setting ERROR; returning with ERROR is only
  // the rare `createChat` early-return path.
  nextExecuteThrow: { value: null as Error | null },
  nextExecuteHook: {
    value: undefined as
      | ((emitter: AgentEventEmitter, signal?: AbortSignal) => Promise<void>)
      | undefined,
  },
}));

// P3 R2 self-review (P3-T6 gap): isolation:'worktree' tests override single
// methods; by default all succeeds and the clean worktree is removed.
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

// `workingDir` resolution is tested in `agents/worktree-pin.test.ts`; here
// it is a seam for what the ORCHESTRATOR does with the resolver's verdict.
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
      taskName?: string,
      subagentId?: string,
    ) => ({
      execute: async (
        ctx: { get: (k: string) => unknown },
        signal?: AbortSignal,
        executeOptions?: { enforceTimeLimitDuringRetryWait?: boolean },
      ) => {
        const { getCurrentAgentId } = await import('./agent-context.js');
        created.push({
          executeOptions,
          name,
          prompt: ctx.get('task_prompt') as string,
          signal,
          promptConfigSystemPrompt: promptConfig.systemPrompt,
          promptConfigInitialMessages: promptConfig.initialMessages,
          runConfig,
          toolConfig,
          agentId: getCurrentAgentId(),
          taskName,
          subagentId,
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

// Config is read only to build a real subagent (mocked above): empty is safe.
function fakeConfig(): Config {
  return {} as unknown as Config;
}

type RunInput = Partial<WorkflowRunRequest> & {
  script: string;
  dispatch?: WorkflowAgentDispatch;
};

/** `new WorkflowOrchestrator(dispatch).run(...)`, `args` undefined unless given. */
function runWf({ dispatch = async () => 'unused', ...request }: RunInput) {
  return new WorkflowOrchestrator(dispatch).run({
    args: undefined,
    ...request,
  });
}

/** A dispatch answering `${tag}${prompt}`. */
const answers =
  (tag: string): WorkflowAgentDispatch =>
  async (prompt) =>
    `${tag}${prompt}`;

/** What `promise` rejects with, or undefined when it resolves. */
const rejectionOf = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => undefined,
    (error: unknown) => error,
  );

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Asserts `run` is unsettled after `ms`. Two arms, since a rejection-shaped
 * gate regression would escape a fulfillment-only attach as an
 * unhandledRejection; the timer tick outlasts a gate-less settle.
 */
async function expectPending(run: Promise<unknown>, ms = 0) {
  let settled = false;
  const settle = () => {
    settled = true;
  };
  void run.then(settle, settle);
  await sleep(ms);
  expect(settled).toBe(false);
}

type EnvVars = Record<string, string | undefined>;
const setEnv = (vars: EnvVars) => {
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
};

/** Runs `fn` with `vars` set (undefined deletes one), then restores them. */
async function withEnv<T>(vars: EnvVars, fn: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(
    Object.keys(vars).map((key) => [key, process.env[key]]),
  );
  setEnv(vars);
  try {
    return await fn();
  } finally {
    setEnv(saved);
  }
}

/** A dispatch that burns `tokens` of `budget`, then answers 'ok'. */
const burning = (budget: WorkflowBudgetImpl, tokens: number) => async () => {
  budget.recordSpent(tokens);
  return 'ok';
};

/** A budget of `total` output tokens with `spent` already burned. */
function budgetOf(total: number | null, spent = 0) {
  const budget = new WorkflowBudgetImpl(total);
  if (spent > 0) budget.recordSpent(spent);
  return budget;
}

/** An in-memory journal; the orchestrator only ever calls `append`. */
function memoryJournal() {
  const entries: JournalEntry[] = [];
  const journal = {
    path: 'mem',
    retainReplayPrefix: async (keys: ReadonlySet<string>) => {
      const kept = entries.filter(
        (entry) => entry.type !== 'result' || keys.has(entry.key),
      );
      entries.splice(0, entries.length, ...kept);
    },
    append: async (e: JournalEntry) => {
      entries.push(e);
    },
    drain: () => Promise.resolve(),
  } as unknown as WorkflowJournal;
  return { journal, entries };
}

/** Runs `script` against a fresh journal; returns the replay a resume loads. */
async function journaledReplay(
  script: string,
  dispatch: WorkflowAgentDispatch = answers('r:'),
) {
  const { journal, entries } = memoryJournal();
  await runWf({ dispatch, script, journal });
  return buildReplay(entries);
}

/** Journal entries of one type. */
const ofType = <T extends JournalEntry['type']>(
  entries: JournalEntry[],
  type: T,
) =>
  entries.filter(
    (entry): entry is Extract<JournalEntry, { type: T }> => entry.type === type,
  );

/** Runs `script`; `dependsOn(label)` names a dispatch's dependencies. */
async function queuedDeps(
  script: string,
  extra: Partial<WorkflowRunRequest> = {},
) {
  const queued: Array<{ id: string; label?: string; dependsOn: string[] }> = [];
  await runWf({
    script,
    ...extra,
    emitter: { dispatchQueued: (event) => queued.push(event) },
  });
  const labelById = new Map(queued.map((event) => [event.id, event.label]));
  const dependsOn = (label: string) =>
    queued
      .find((event) => event.label === label)!
      .dependsOn.map((id) => labelById.get(id));
  return { queued, dependsOn };
}

/**
 * Starts `script` with a parking dispatch; once it is in flight, pauses
 * `scheduler`, settles it (an Error rejects) and waits for the pause.
 */
async function settleWhilePaused(
  scheduler: WorkflowDispatchScheduler,
  outcome: string | Error,
  request: Partial<WorkflowRunRequest> & { script: string },
) {
  let resolveDispatch: ((value: string) => void) | undefined;
  let rejectDispatch: ((error: Error) => void) | undefined;
  const run = runWf({
    dispatch: () =>
      new Promise<string>((resolve, reject) => {
        resolveDispatch = resolve;
        rejectDispatch = reject;
      }),
    scheduler,
    ...request,
  });
  await vi.waitFor(() => expect(resolveDispatch).toBeDefined());
  scheduler.pause();
  if (outcome instanceof Error) rejectDispatch?.(outcome);
  else resolveDispatch?.(outcome);
  await vi.waitFor(() => expect(scheduler.snapshot().state).toBe('paused'));
  return { run };
}

type Emits = { emit(event: string, payload: unknown): void };

/** Starts round 1, then parks until `signal` aborts: a stalled attempt. */
async function stallUntilAborted(
  emitter: Emits,
  signal: AbortSignal | undefined,
  subagentId: string,
  promptId: string,
) {
  emitter.emit(AgentEventType.ROUND_START, {
    subagentId,
    round: 1,
    promptId,
    timestamp: Date.now(),
  });
  await new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    signal?.addEventListener('abort', () => resolve(), { once: true });
  });
}

/** The fast-path dispatch most createProductionDispatch cases make. */
const dispatchHello = () =>
  createProductionDispatch(fakeConfig())('hello', { label: 'h1' });

/** Clears the AgentHeadless mock's per-case state. */
function resetHeadlessMock() {
  created.length = 0;
  nextFinalText.value = undefined;
  nextTerminateMode.value = 'GOAL';
  nextExecuteHook.value = undefined;
}

describe('WorkflowOrchestrator', () => {
  const throwing =
    (message: string): WorkflowAgentDispatch =>
    async () => {
      throw new Error(message);
    };
  type BudgetUpdate = { spent: number; total: number | null };
  /** Runs `request` as a resume of `prior` entries, collecting respawns. */
  const resumeFrom = (prior: JournalEntry[], request: RunInput) => {
    const respawns: string[] = [];
    const run = runWf({
      journal: memoryJournal().journal,
      resumeReplay: buildReplay(prior),
      emitter: { resumeRespawn: (line) => respawns.push(line) },
      ...request,
    });
    return { run, respawns };
  };

  it('runs a script with injected mock dispatch and returns the script value', async () => {
    const outcome = await runWf({
      dispatch: answers('mock:'),
      script: `phase("plan");
               const x = await agent("hi", { label: "a" });
               return x;`,
    });
    expect(outcome.result).toBe('mock:hi');
    expect(outcome.runId).toMatch(/^wf_[0-9a-f]{16}$/);
    expect(outcome.phases).toEqual(['plan']);
  });

  it('passes args through to the script', async () => {
    const outcome = await runWf({
      script: `return args.who`,
      args: { who: 'world' },
    });
    expect(outcome.result).toBe('world');
  });

  // P4: outcome.meta surfaces the extracted `export const meta = {...}`
  // declaration; null when the script omits it.
  it('outcome.meta is null when the script has no meta declaration', async () => {
    expect((await runWf({ script: `return 1` })).meta).toBeNull();
  });

  it('outcome.meta is the parsed meta when the script declares one', async () => {
    const outcome = await runWf({
      script: `export const meta = { name: 'demo', description: 'demo workflow', phases: [{ title: 'plan' }] }
               return 1`,
    });
    expect(outcome.meta).toEqual({
      name: 'demo',
      description: 'demo workflow',
      phases: [{ title: 'plan' }],
    });
    expect(outcome.result).toBe(1);
  });

  // P4: a body that throws still surfaces the meta on the wrapped error, so
  // the display can identify which workflow ran before the body failed.
  it('WorkflowExecutionError carries meta when the body throws AFTER meta parsed', async () => {
    const caught = await rejectionOf(
      runWf({
        script: `export const meta = { name: 'fails', description: 'will throw' }
                 throw new Error("body boom")`,
      }),
    );
    expect(caught).toBeInstanceOf(WorkflowExecutionError);
    expect((caught as WorkflowExecutionError).meta).toEqual({
      name: 'fails',
      description: 'will throw',
    });
  });

  it('surfaces a thrown error from the script', async () => {
    await expect(runWf({ script: `throw new Error("boom")` })).rejects.toThrow(
      /boom/,
    );
  });

  it('runId is stable for the lifetime of a single run call', async () => {
    const captured: string[] = [];
    const outcome = await runWf({
      dispatch: async (prompt) => {
        captured.push(prompt);
        return 'ok';
      },
      script: `await agent("first"); await agent("second"); return 0;`,
    });
    expect(captured).toEqual(['first', 'second']);
    expect(outcome.runId).toMatch(/^wf_[0-9a-f]{16}$/);
  });

  // TST-C1: concurrent runs must produce distinct runIds.
  it('runId is unique across concurrent runs', async () => {
    const orchestrator = new WorkflowOrchestrator(async () => 'ok');
    const [a, b, c] = await Promise.all(
      ['return 1', 'return 2', 'return 3'].map((script) =>
        orchestrator.run({ script, args: undefined }),
      ),
    );
    expect(a.runId).not.toBe(b.runId);
    expect(b.runId).not.toBe(c.runId);
    expect(a.runId).not.toBe(c.runId);
  });

  it('settles an unclassified dispatch rejection to null', async () => {
    await expect(
      runWf({
        dispatch: throwing('agent-crashed'),
        script: 'const value = await agent("x"); return value;',
      }),
    ).resolves.toMatchObject({ result: null });
  });

  // P4b Round 5 (wenshao): these emitter callbacks (safePhase, safeLog,
  // countedDispatch before + after, and the try/catch around agentCompleted
  // on rejection) alone keep the registry record in sync with the live run;
  // dropping one would leave the UI stale. These three tests pin them.
  it('emitter callbacks fire in expected order with expected args', async () => {
    const events: Array<{ kind: string; payload: unknown }> = [];
    const outcome = await runWf({
      dispatch: answers('mock:'),
      script: `
        phase('Plan');
        log('starting');
        await agent('q1', { label: 'first' });
        phase('Build');
        await agent('q2', { label: 'second' });
        return 'ok';
      `,
      emitter: {
        phaseStarted: (title) => events.push({ kind: 'phase', payload: title }),
        agentDispatched: (label) =>
          events.push({ kind: 'dispatched', payload: label }),
        agentCompleted: (label, error) =>
          events.push({ kind: 'completed', payload: { label, error } }),
        logAppended: (line) => events.push({ kind: 'log', payload: line }),
      },
    });
    expect(outcome.result).toBe('ok');
    expect(outcome.phases).toEqual(['Plan', 'Build']);
    // Relative ordering only: no barrier between phase/log and dispatch emits.
    const expected: Array<[string, unknown]> = [
      ['phase', 'Plan'],
      ['log', 'starting'],
      ['dispatched', 'first'],
      ['completed', { label: 'first', error: undefined }],
      ['phase', 'Build'],
      ['dispatched', 'second'],
      ['completed', { label: 'second', error: undefined }],
    ];
    expect(events.map((e) => e.kind)).toEqual(expected.map(([kind]) => kind));
    expected.forEach(([, payload], i) => {
      expect(events[i]!.payload).toEqual(payload);
    });
  });

  it('agentCompleted carries the error message on dispatch rejection', async () => {
    const completions: Array<{ label?: string; error?: string }> = [];
    await expect(
      runWf({
        dispatch: throwing('dispatch-boom'),
        script: `await agent("x", { label: "doomed" }); return 0;`,
        emitter: {
          agentCompleted: (label, error) => completions.push({ label, error }),
        },
      }),
    ).resolves.toMatchObject({ result: 0 });
    expect(completions).toHaveLength(1);
    expect(completions[0]).toEqual({ label: 'doomed', error: 'dispatch-boom' });
  });

  it('records dependency tails across sequential, parallel, and pipeline dispatches', async () => {
    const { queued, dependsOn } = await queuedDeps(`
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
      `);
    const ids = new Map(queued.map((event) => [event.label, event.id]));
    expect(dependsOn('inspect')).toEqual([]);
    expect(dependsOn('correctness')).toEqual(['inspect']);
    expect(dependsOn('architecture')).toEqual(['inspect']);
    expect(dependsOn('verify-a')).toEqual(['correctness', 'architecture']);
    expect(dependsOn('verify-b')).toEqual(['correctness', 'architecture']);
    expect(dependsOn('fix-a')).toEqual(['verify-a']);
    expect(dependsOn('fix-b')).toEqual(['verify-b']);
    expect(new Set(ids.values()).size).toBe(7);
  });

  it.each(['parallel', 'pipeline'] as const)(
    'preserves newer parent dependencies when an un-awaited %s settles',
    async (kind) => {
      const fanout =
        kind === 'parallel'
          ? `parallel([() => agent('fanout', { label: 'fanout' })])`
          : `pipeline([0], () => agent('fanout', { label: 'fanout' }))`;
      const { dependsOn } = await queuedDeps(
        `
          const pending = ${fanout};
          await agent('parent', { label: 'parent' });
          await pending;
          await agent('joined', { label: 'joined' });
        `,
        { scheduler: new WorkflowDispatchScheduler(2) },
      );
      expect(dependsOn('joined').sort()).toEqual(['fanout', 'parent']);
    },
  );

  it('emits queued, started, and settled lifecycle events for one dispatch', async () => {
    const events: string[] = [];
    await runWf({
      script: `await agent('inspect', { label: 'scope' });`,
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
    await runWf({
      dispatch: async (_prompt, _opts, dispatchId) => {
        receivedIds.push(dispatchId);
        return 'done';
      },
      script: `await agent('inspect', { label: 'scope' });`,
    });
    expect(receivedIds).toEqual(['dispatch-1']);
  });

  it('preserves the dependency tail across empty parallel helpers', async () => {
    const { dependsOn } = await queuedDeps(`
        await agent('before', { label: 'before' });
        await parallel([]);
        await agent('after parallel', { label: 'after-parallel' });
        await pipeline([], () => agent('unused'));
        await agent('after pipeline', { label: 'after-pipeline' });
      `);
    expect(dependsOn('after-parallel')).toEqual(['before']);
    expect(dependsOn('after-pipeline')).toEqual(['after-parallel']);
  });

  it('does not re-inject inherited tails from a fan-out branch that never dispatches', async () => {
    const { dependsOn } = await queuedDeps(
      `
        await agent('a', { label: 'a' });
        const pending = parallel([
          () => agent('b', { label: 'b' }),
          () => 42,
        ]);
        await agent('m', { label: 'm' });
        await pending;
        await agent('z', { label: 'z' });
      `,
      { scheduler: new WorkflowDispatchScheduler(2) },
    );
    expect(dependsOn('b').sort()).toEqual(['a']);
    expect(dependsOn('m').sort()).toEqual(['a']);
    // The no-dispatch branch must not re-inject the ancestor 'a' edge.
    expect(dependsOn('z').sort()).toEqual(['b', 'm']);
  });

  it('keeps inherited tails when no fan-out branch issues a dispatch', async () => {
    const { dependsOn } = await queuedDeps(`
        await agent('before', { label: 'before' });
        await parallel([() => 1, () => 2]);
        await agent('after', { label: 'after' });
      `);
    expect(dependsOn('after')).toEqual(['before']);
  });

  it('emitter subscriber errors do not break the run (defensive try/catch)', async () => {
    // Every callback throws; without each emit site's try/catch the first
    // subscriber error would fail a sound run.
    const boom = (name: string) => () => {
      throw new Error(`${name}-subscriber-boom`);
    };
    const outcome = await runWf({
      dispatch: answers('mock:'),
      script: `
        phase('Plan');
        log('hello');
        const a = await agent('q1');
        return a;
      `,
      emitter: {
        phaseStarted: boom('phase'),
        agentDispatched: boom('dispatched'),
        agentCompleted: boom('completed'),
        logAppended: boom('log'),
        dispatchQueued: boom('queued'),
        dispatchStarted: boom('started'),
        dispatchSettled: boom('settled'),
      },
    });
    expect(outcome.result).toBe('mock:q1');
    expect(outcome.phases).toEqual(['Plan']);
  });

  // ── P5: budget gate via WorkflowRunRequest.budget ─────────────────────

  it('P5: budget gate refuses to dispatch once budget is exhausted', async () => {
    // Pre-burned, so the first agent() call lands over-cap.
    const dispatch = vi.fn(async () => 'never reached');
    const caught = await rejectionOf(
      runWf({
        dispatch,
        script: `await agent('q1'); return 0;`,
        budget: budgetOf(1000, 1000),
      }),
    );
    expect(caught).toBeInstanceOf(Error);
    // Cross-realm: the sandbox rewraps the host error in a vm-realm Error
    // (T1/T8/T14). The gate short-circuits before scheduler.run.
    expect(String(caught)).toContain('token budget exceeded');
    expect(String(caught)).toContain('1000');
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('P5: budget gate stops further dispatches mid-run on overshoot', async () => {
    const budget = budgetOf(100);
    // Each dispatch burns 60 tokens; the budget runs out after 2.
    const dispatch = vi.fn(burning(budget, 60));
    const caught = await rejectionOf(
      runWf({
        dispatch,
        script: `await agent('q1'); await agent('q2'); await agent('q3'); return 'done';`,
        budget,
      }),
    );
    // q1 = 60/100, q2 = 120/100 (overshoot), q3 = gate refuses
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(String(caught)).toContain('token budget exceeded');
    expect(budget.spent()).toBe(120);
  });

  it('P5: budget.total === null (no cap) — gate never fires', async () => {
    const budget = budgetOf(null);
    const dispatch = vi.fn(burning(budget, 1_000_000)); // 1M per agent
    const outcome = await runWf({
      dispatch,
      script: `await agent('q1'); await agent('q2'); await agent('q3'); return 'done';`,
      budget,
    });
    expect(outcome.result).toBe('done');
    expect(dispatch).toHaveBeenCalledTimes(3);
    expect(budget.spent()).toBe(3_000_000);
    expect(budget.remaining()).toBe(Infinity);
  });

  it('P5: no budget passed (legacy callers) — gate never fires', async () => {
    const dispatch = vi.fn(async () => 'ok');
    const outcome = await runWf({
      dispatch,
      script: `await agent('q1'); await agent('q2'); return 'done';`,
    });
    expect(outcome.result).toBe('done');
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it('P5 R1 #2: parallel-batch overshoot is bounded by the in-scheduler re-check', async () => {
    // R1 Critical #2: a parallel() of N thunks queues all of them at spent=0,
    // so the entry gate alone overshoots by up to (N-1) × per-dispatch
    // tokens. The slot-acquire re-check sees finished dispatches' spend and
    // refuses thunks arriving after the bust; the run-level limit rejects.
    const budget = budgetOf(100);
    // 3 successful dispatches saturate the cap.
    const dispatch = vi.fn(burning(budget, 40));
    let dispatched = 0;
    let completed = 0;
    // 10 thunks, far more than the budget allows (100 / 40 ≈ 3).
    await expect(
      runWf({
        dispatch,
        script: `const results = await parallel(Array.from({length: 10}, () => () => agent('q'))); return results;`,
        budget,
        scheduler: new WorkflowDispatchScheduler(1),
        emitter: {
          agentDispatched: () => dispatched++,
          agentCompleted: () => completed++,
        },
      }),
    ).rejects.toThrow(/token budget exceeded/);
    // Not the without-fix 10: at width 1 the re-checks serialize, so exactly
    // 3 pass (spent 0/40/80 at acquire; cap 100).
    expect(dispatch).toHaveBeenCalledTimes(3);
    expect(dispatched).toBe(10);
    expect(completed).toBe(dispatched);
  });

  it('reports respawns only after the slot-acquire budget gate admits them', async () => {
    const budget = budgetOf(100);
    const dispatch = vi.fn(burning(budget, 40));
    let key = deriveArgsSeed(undefined);
    const priorEntries: JournalEntry[] = [];
    for (let i = 0; i < 10; i++) {
      key = deriveAgentKey(key, 'q', {});
      priorEntries.push({ type: 'started', key, agentId: String(i + 1) });
    }
    const { journal, entries } = memoryJournal();
    const { run, respawns } = resumeFrom(priorEntries, {
      dispatch,
      script: `return await parallel(Array.from({length: 10}, () => () => agent('q')));`,
      budget,
      scheduler: new WorkflowDispatchScheduler(1),
      journal,
    });
    await expect(run).rejects.toThrow(/token budget exceeded/);
    expect(dispatch).toHaveBeenCalledTimes(3);
    expect(ofType(entries, 'started')).toHaveLength(3);
    expect(respawns).toHaveLength(3);
  });

  it('does not invent prior attempts across repeated budget-limited resumes', async () => {
    const { journal, entries } = memoryJournal();
    const script = `return await parallel(Array.from({length: 10}, (_, i) => () => agent('slot' + i)));`;
    for (let round = 0; round < 4; round++) {
      const budget = budgetOf(100);
      const dispatched: string[] = [];
      const { run, respawns } = resumeFrom(entries, {
        dispatch: async (prompt) => {
          dispatched.push(prompt);
          budget.recordSpent(40);
          return prompt;
        },
        script,
        budget,
        scheduler: new WorkflowDispatchScheduler(1),
        journal,
      });
      if (round < 3) {
        await expect(run).rejects.toThrow(/token budget exceeded/);
      } else {
        await expect(run).resolves.toMatchObject({
          result: Array.from({ length: 10 }, (_, i) => `slot${i}`),
        });
      }
      expect(dispatched).toEqual(
        Array.from(
          { length: Math.min(3, 10 - round * 3) },
          (_, i) => `slot${round * 3 + i}`,
        ),
      );
      expect(respawns).toEqual([]);
      const starts = ofType(entries, 'started');
      expect(starts).toHaveLength(Math.min(10, (round + 1) * 3));
      expect(ofType(entries, 'result')).toHaveLength(starts.length);
      expect(ofType(entries, 'failed')).toEqual([]);
    }
  });

  // R1 #4 (debugLogger.warn at both gate sites) has no test: a spy would be
  // brittle. Verify with DEBUG=WORKFLOW=1 and a budget-exhausted dispatch.

  // A turn target gates on the whole turn's spend (main loop and other runs
  // included), while the registry mirrors this run alone: its own spend, and
  // no cap, since the target is not this run's.
  it('gates a turn target on the turn spend and reports only the run to the registry', async () => {
    let turnSpent = 499_999;
    const budget = new WorkflowBudgetImpl(500_000, {
      source: 'directive',
      turnSpent: () => turnSpent,
    });
    const dispatch = vi.fn(async () => {
      turnSpent += 10; // tokens spent elsewhere in the turn while this ran
      return 'ok';
    });
    const budgetUpdates: BudgetUpdate[] = [];
    const caught = await runWf({
      dispatch,
      script: `await agent('q1'); await agent('q2'); return 'done';`,
      budget,
      emitter: {
        budgetUpdated: (spent, total) => budgetUpdates.push({ spent, total }),
      },
    }).catch((e: unknown) => e);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(String(caught)).toContain(
      'token budget exceeded (500009 / 500000 output tokens)',
    );
    expect(budget.runSpent()).toBe(0);
    expect(budgetUpdates).toEqual([{ spent: 0, total: null }]);
  });

  // ── P5 T4: budgetUpdated emitter event ─────────────────────────────────

  it('P5 T4: budgetUpdated fires after each successful completion with cumulative spent + total', async () => {
    const budget = budgetOf(1000);
    const budgetUpdates: BudgetUpdate[] = [];
    await runWf({
      dispatch: async (prompt) => {
        // As production onTokens does, before the then() re-snapshot.
        budget.recordSpent(prompt === 'q1' ? 150 : 250);
        return 'ok';
      },
      script: `await agent('q1'); await agent('q2'); return 'done';`,
      budget,
      emitter: {
        budgetUpdated: (spent, total) => budgetUpdates.push({ spent, total }),
      },
    });
    expect(budgetUpdates).toEqual([
      { spent: 150, total: 1000 },
      { spent: 400, total: 1000 },
    ]);
  });

  it('P5 T4: budgetUpdated does NOT fire when no budget is passed', async () => {
    const budgetUpdates: number[] = [];
    await runWf({
      script: `await agent('q1'); return 'done';`,
      emitter: { budgetUpdated: (spent) => budgetUpdates.push(spent) },
      // budget intentionally omitted
    });
    expect(budgetUpdates).toEqual([]);
  });

  it('P5 R3 #1: budgetUpdated DOES fire on dispatch rejection (so UI/registry see the burn-then-fail spend)', async () => {
    // R3 #1 (bot): reportTokens runs in a `finally` (R3 #6), so spend advances
    // even when execute() throws. Without budgetUpdated on the error arm the
    // registry's tokensSpent/perPhaseTokens diverge from budget.spent(), and
    // (budgetUpdated being the sole UI driver since R2 #12) nothing re-renders.
    const budget = budgetOf(1000);
    const budgetUpdates: BudgetUpdate[] = [];
    const completions: Array<{ label?: string; error?: string }> = [];
    await expect(
      runWf({
        dispatch: async () => {
          // Production records tokens BEFORE the throw (reportTokens in finally).
          budget.recordSpent(150);
          throw new Error('dispatch-boom');
        },
        script: `await agent('q1'); return 'done';`,
        budget,
        emitter: {
          budgetUpdated: (spent, total) => budgetUpdates.push({ spent, total }),
          agentCompleted: (label, error) => completions.push({ label, error }),
        },
      }),
    ).resolves.toMatchObject({ result: 'done' });
    expect(completions).toHaveLength(1);
    expect(completions[0]?.error).toBe('dispatch-boom');
    // The error arm reports the cumulative spend at throw time.
    expect(budgetUpdates).toEqual([{ spent: 150, total: 1000 }]);
  });

  it('P5 R3 #7: budget rejection does NOT consume agent-cap slots (correct terminal error after exhaustion)', async () => {
    // wenshao R3 #7: counting agents before the budget gate made rejected
    // calls trip the agent cap, blaming the cap for budget exhaustion. With a
    // pre-busted budget the script swallows every rejection across more calls
    // than the cap, so the run completes; a cap error would fail it.
    const dispatch = vi.fn(async () => 'never');
    const caught = await rejectionOf(
      runWf({
        dispatch,
        script: `
          let lastErr = null;
          for (let i = 0; i < 1100; i++) {
            try { await agent('q' + i); } catch (e) { lastErr = e.message; }
          }
          return lastErr;
        `,
        budget: budgetOf(100, 100),
      }),
    );
    expect(dispatch).not.toHaveBeenCalled();
    expect(caught).toBeUndefined();
  });

  it('P5 R3 #1: budgetUpdated does NOT fire when no budget passed AND dispatch rejects', async () => {
    // The `if (budget)` gate covers both arms.
    const budgetUpdates: number[] = [];
    await expect(
      runWf({
        dispatch: throwing('boom'),
        script: `await agent('q1'); return 'done';`,
        emitter: { budgetUpdated: (spent) => budgetUpdates.push(spent) },
        // budget intentionally omitted
      }),
    ).resolves.toMatchObject({ result: 'done' });
    expect(budgetUpdates).toEqual([]);
  });

  it('P5 T4: budgetUpdated subscriber error does not break the run', async () => {
    const budget = budgetOf(1000);
    const outcome = await runWf({
      dispatch: burning(budget, 100),
      script: `await agent('q1'); return 'done';`,
      budget,
      emitter: {
        budgetUpdated: () => {
          throw new Error('budget-subscriber-boom');
        },
      },
    });
    expect(outcome.result).toBe('done');
  });

  // ── P-nested: workflow() global ───────────────────────────────────────

  it('P-nested: workflow(name) resolves via injected resolver and returns nested result', async () => {
    const outcome = await runWf({
      dispatch: answers('agent:'),
      script: `const r = await workflow('child'); return 'parent:' + r;`,
      resolveSavedWorkflow: async (ref) => {
        expect(ref).toBe('child');
        return {
          script: `return 'nested-' + (await agent('inner'));`,
          name: 'child',
        };
      },
    });
    expect(outcome.result).toBe('parent:nested-agent:inner');
  });

  it('refuses a nested script with a dynamic import before its body runs', async () => {
    const dispatch = vi.fn(async (prompt: string) => `agent:${prompt}`);
    const outcome = await new WorkflowOrchestrator(dispatch).run({
      script: `const before = await agent('parent-first');
        try { await workflow('child'); return 'resolved'; }
        catch (e) { return [before, e.message]; }`,
      args: undefined,
      resolveSavedWorkflow: async () => ({
        script: `await agent('child-must-not-run');\nawait import('node:fs');`,
        name: 'child',
      }),
    });
    const [before, message] = outcome.result as [string, string];
    expect(before).toBe('agent:parent-first');
    expect(message).toMatch(/line 2: dynamic import\(\) is not supported/);
    expect(dispatch.mock.calls.map(([prompt]) => prompt)).toEqual([
      'parent-first',
    ]);
  });

  it('does not mirror an unconsumed agent failure after it settles to null', async () => {
    const appendedLogs: string[] = [];
    const outcome = await runWf({
      dispatch: () => Promise.reject(new Error('nested-boom')),
      script: `return 'parent:' + (await workflow('child'));`,
      emitter: { logAppended: (line) => appendedLogs.push(line) },
      resolveSavedWorkflow: async () => ({
        // The trace and failures list carry it; the agent promise resolves
        // to null, so it is no unhandled rejection.
        script: `agent('x'); return 'child-done';`,
      }),
    });
    expect(outcome.result).toBe('parent:child-done');
    expect(outcome.logs).toEqual([]);
    expect(appendedLogs).toEqual([]);
  });

  it('keeps a nested agent result behind the shared pause gate', async () => {
    const scheduler = new WorkflowDispatchScheduler(1);
    const { run } = await settleWhilePaused(scheduler, 'nested result', {
      script: `return await workflow('child');`,
      resolveSavedWorkflow: async () => ({
        script: `return await agent('inner');`,
      }),
    });
    await expectPending(run);
    scheduler.resume();
    await expect(run).resolves.toMatchObject({ result: 'nested result' });
  });

  const pausedScheduler = (signal?: AbortSignal) => {
    const scheduler = new WorkflowDispatchScheduler(1, signal);
    scheduler.pause();
    expect(scheduler.snapshot().state).toBe('paused');
    return scheduler;
  };
  const OVER_BUDGET = `
        let msg = 'none';
        try { await agent('over-budget'); } catch (e) { msg = e.message; }
        return msg;
      `;

  // R12 (doudouOUC): the budget gate and agent cap returned a bare
  // Promise.reject past the pause gate, so a paused run catching it kept
  // executing. Entry-gate rejections settle through the same gate.
  it('holds a budget-gate rejection behind the pause gate until resume', async () => {
    const scheduler = pausedScheduler();
    const dispatch = vi.fn(async () => 'unused');
    // Already over cap at entry.
    const run = runWf({
      dispatch,
      script: OVER_BUDGET,
      budget: budgetOf(100, 100),
      scheduler,
    });
    // Without the gate the rejection settles within a few microtasks.
    await expectPending(run, 20);
    scheduler.resume();
    await expect(run).resolves.toMatchObject({
      result: expect.stringContaining('token budget exceeded'),
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('holds an agent-cap rejection behind the pause gate until resume', async () => {
    await withEnv({ QWEN_CODE_MAX_WORKFLOW_AGENTS: '1' }, async () => {
      const scheduler = pausedScheduler();
      const dispatch = vi.fn(async () => 'ok');
      const run = runWf({
        dispatch,
        script: `
          const p = agent('first');
          let msg = 'none';
          try { await agent('second'); } catch (e) { msg = e.message; }
          return msg;
        `,
        scheduler,
      });
      await expectPending(run, 20);
      scheduler.resume();
      await expect(run).resolves.toMatchObject({
        result: expect.stringMatching(/exceeded the maximum of 1 agent/),
      });
      // 'first' passed the cap and dispatched on resume; 'second' never did.
      await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
    });
  });

  it('preserves an entry-gate rejection when cancellation aborts its pause gate', async () => {
    // As for dispatch errors: abort rejects the gate waiter, and the reject
    // arm must still surface the real entry-gate error.
    const controller = new AbortController();
    const scheduler = pausedScheduler(controller.signal);
    const run = runWf({
      script: OVER_BUDGET,
      budget: budgetOf(100, 100),
      scheduler,
    });
    // A bare Promise.reject regression settles during this wait.
    await expectPending(run, 20);
    controller.abort();
    await expect(run).resolves.toMatchObject({
      result: expect.stringContaining('token budget exceeded'),
    });
  });

  it('P-nested: nested args are passed to the child script', async () => {
    const outcome = await runWf({
      script: `return await workflow('child', { x: 21 });`,
      resolveSavedWorkflow: async () => ({ script: `return args.x * 2;` }),
    });
    expect(outcome.result).toBe(42);
  });

  const TWO_NESTED = async () => ({
    script: `await agent('n1'); await agent('n2'); return 'done';`,
  });

  it('P-nested: nested agents share the parent agent-count cap', async () => {
    // The cap is read from env; with 2, parent(1) + nested(2) trips it.
    await withEnv({ QWEN_CODE_MAX_WORKFLOW_AGENTS: '2' }, async () => {
      const dispatch = vi.fn(async () => 'ok');
      const caught = await rejectionOf(
        runWf({
          dispatch,
          script: `await agent('p1'); return await workflow('child');`,
          resolveSavedWorkflow: TWO_NESTED,
        }),
      );
      // p1 (1) + n1 (2) pass; n2 (3) trips the cap.
      expect(dispatch).toHaveBeenCalledTimes(2);
      expect(String(caught)).toMatch(/exceeded the maximum of 2 agent/);
    });
  });

  it('P-nested: nested agents share the parent token budget', async () => {
    const budget = budgetOf(100);
    const caught = await rejectionOf(
      runWf({
        dispatch: burning(budget, 60), // 2 agents = 120 > 100
        script: `await agent('p1'); return await workflow('child');`,
        budget,
        resolveSavedWorkflow: TWO_NESTED,
      }),
    );
    // p1 spends 60; n1 spends 60 (total 120); n2 is gated.
    expect(String(caught)).toMatch(/token budget exceeded/);
    expect(budget.spent()).toBe(120);
  });

  it('P-nested: single-level limit — a nested workflow() call throws', async () => {
    const caught = await rejectionOf(
      runWf({
        script: `return await workflow('child');`,
        // The nested script tries to nest again.
        resolveSavedWorkflow: async () => ({
          script: `return await workflow('grandchild');`,
        }),
      }),
    );
    expect(String(caught)).toMatch(/workflow\(\) is unavailable here/);
    expect(String(caught)).toMatch(/single level/);
  });

  it('P-nested: workflow() throws when no resolver is wired', async () => {
    // resolveSavedWorkflow omitted
    const caught = await rejectionOf(
      runWf({ script: `return await workflow('child');` }),
    );
    expect(String(caught)).toMatch(/workflow\(\) is unavailable here/);
  });

  it('P-nested: resolver rejection (workflow not found) surfaces to the parent script', async () => {
    const outcome = await runWf({
      script: `try { await workflow('child'); return 'no-throw'; }
               catch (e) { return 'caught:' + e.message; }`,
      resolveSavedWorkflow: async () => {
        throw new Error(`workflow('child'): no workflow with that name.`);
      },
    });
    expect(outcome.result).toMatch(/caught:.*no workflow with that name/);
  });

  // ── P6: resume journal ────────────────────────────────────────────────

  it('P6: a normal run journals a started+result per agent() call', async () => {
    const { journal, entries } = memoryJournal();
    await runWf({
      dispatch: answers('r:'),
      script: `await agent('a'); await agent('b'); return 'done';`,
      journal,
    });
    // 2 agents → 2 started + 2 result.
    expect(ofType(entries, 'started')).toHaveLength(2);
    const results = ofType(entries, 'result');
    expect(results).toHaveLength(2);
    expect((results[0] as { result: unknown }).result).toBe('r:a');
    expect((results[1] as { result: unknown }).result).toBe('r:b');
  });

  // Checked before deriveAgentKey, whose hash.update() would throw an opaque
  // ERR_INVALID_ARG_TYPE ahead of the dispatch's descriptive error.
  it('P6: rejects an invalid prompt before journal key derivation', async () => {
    const { journal, entries } = memoryJournal();
    await expect(
      runWf({
        dispatch: answers('r:'),
        script: `return await agent(42);`,
        journal,
      }),
    ).rejects.toThrow(/non-empty string prompt/);
    // The mis-call consumes nothing: no started marker, no result line.
    expect(entries).toHaveLength(0);
  });

  // ── Agent-level failures settle to null ───────────────────────────────
  // A sequential `await agent()` used to throw where a `parallel()` slot got
  // `null`: one broken agent ended a sequential script but only dented a
  // fan-out. These pin one contract, and the journal records, for both.

  it.each([
    ['direct', `agent('a')`],
    ['parallel', `parallel([() => agent('a'), () => agent('b')])`],
    ['pipeline', `pipeline(['a', 'b'], (_previous, prompt) => agent(prompt))`],
    [
      'nested',
      `parallel([() => pipeline(['a', 'b'], (_previous, prompt) => agent(prompt))])`,
    ],
  ])(
    'rejects the %s workflow when container policy refuses dispatch',
    async (_kind, expression) => {
      const config = {
        getAgentExecutionBackend: () => 'container' as const,
      } as Config;
      const { journal, entries } = memoryJournal();
      const createdBefore = created.length;
      const worktreesBefore = worktreeStubs.instances.length;

      await expect(
        runWf({
          dispatch: createProductionDispatch(config),
          script: `return await ${expression};`,
          journal,
        }),
      ).rejects.toThrow('workflow agents are unsupported');

      expect(entries.some((entry) => entry.type === 'started')).toBe(true);
      expect(
        entries.some(
          (entry) => entry.type === 'failed' || entry.type === 'result',
        ),
      ).toBe(false);
      expect(created).toHaveLength(createdBefore);
      expect(worktreeStubs.instances).toHaveLength(worktreesBefore);
    },
  );

  // effort and disallowedTools are normalized before the resume key: another
  // spelling of a request replays, a different request does not.
  it('derives one resume key for equivalent effort and disallowedTools spellings', async () => {
    const keyFor = async (
      effort: string,
      denied: string[],
    ): Promise<string> => {
      const { journal, entries } = memoryJournal();
      await runWf({
        dispatch: async () => 'ok',
        script: `return await agent('scan', { effort: '${effort}', disallowedTools: ${JSON.stringify(denied)} });`,
        journal,
      });
      return ofType(entries, 'started')[0]!.key;
    };
    const medium = await keyFor('medium', ['write_file', 'edit']);
    expect(await keyFor('MED', ['edit', 'write_file', 'edit'])).toBe(medium);
    expect(await keyFor('high', ['edit', 'write_file'])).not.toBe(medium);
    expect(await keyFor('medium', ['edit'])).not.toBe(medium);
    // A built-in tool named by its display name is the same deny.
    expect(await keyFor('medium', ['WriteFile', 'Edit'])).toBe(medium);
  });

  it('settles a sequential agent() to null when the agent itself failed', async () => {
    const { journal, entries } = memoryJournal();
    const outcome = await runWf({
      dispatch: async () => {
        throw new WorkflowAgentFailedError(
          'did not complete (terminate mode: MAX_TURNS).',
          'max_turns',
          'MAX_TURNS',
        );
      },
      script: `const a = await agent('x'); return a === null ? 'saw null' : 'saw ' + a;`,
      journal,
    });
    expect(outcome.result).toBe('saw null');
    // started, then failed — never a result.
    expect(entries.map((e) => e.type)).toEqual(['started', 'failed']);
    const started = entries[0] as { key: string; agentId: string };
    const failed = entries[1] as { key: string; agentId: string };
    expect(failed.key).toBe(started.key);
    expect(failed.agentId).toBe(started.agentId);
  });

  it('gives a parallel() slot the same null, and journals it the same way', async () => {
    const { journal, entries } = memoryJournal();
    const outcome = await runWf({
      dispatch: async (prompt) => {
        if (prompt === 'bad') {
          throw new Error('model errored before classification');
        }
        return `r:${prompt}`;
      },
      script: `return await parallel([() => agent('good'), () => agent('bad')]);`,
      journal,
    });
    expect(outcome.result).toEqual(['r:good', null]);
    expect(ofType(entries, 'failed')).toHaveLength(1);
    expect(ofType(entries, 'result')).toHaveLength(1);
  });

  // A run-level failure (budget or cap) still ends the run, and the journal
  // must not call the admitted agent itself failed.
  it('propagates a run-level dispatch failure without a failed record', async () => {
    const { journal, entries } = memoryJournal();
    await expect(
      runWf({
        dispatch: async () => {
          throw new WorkflowAgentCapExceededError(1000);
        },
        script: `return await agent('x');`,
        journal,
      }),
    ).rejects.toThrow(/maximum of 1000 agent\(\) calls/);
    expect(entries.map((e) => e.type)).toEqual(['started']);
  });

  // Keys open at a user cancel were merely interrupted; marking them failed
  // would tell the next resume that sound agents are broken.
  it('writes no failed record when the run itself was aborted', async () => {
    const { journal, entries } = memoryJournal();
    const controller = new AbortController();
    await expect(
      runWf({
        dispatch: async () => {
          controller.abort();
          throw new Error(
            'Workflow subagent did not complete (terminate mode: CANCELLED).',
          );
        },
        script: `return await agent('x');`,
        journal,
        abortOnTimeout: controller,
      }),
    ).rejects.toThrow();
    expect(ofType(entries, 'failed')).toHaveLength(0);
    expect(ofType(entries, 'started')).toHaveLength(1);
  });

  // ── Resume says why a call is running live again ──────────────────────

  it.each([
    [true, 'failed in the previous run'],
    [false, 'was interrupted'],
  ])('reports a respawn with wasFailed=%s', async (wasFailed, _description) => {
    const key = deriveAgentKey(deriveArgsSeed(undefined), 'x', {});
    const priorEntries: JournalEntry[] = [
      { type: 'started', key, agentId: '1' },
      ...(wasFailed
        ? ([{ type: 'failed', key, agentId: '1' }] as JournalEntry[])
        : []),
    ];
    const { run, respawns } = resumeFrom(priorEntries, {
      dispatch: async () => 'live',
      script: `return await agent('x');`,
    });
    const outcome = await run;

    const expected = wasFailed
      ? '[resume] re-running an agent: it failed in the previous run'
      : '[resume] respawning an agent: interrupted in a previous run (1 prior attempt)';
    expect(respawns).toEqual([expected]);
    expect(outcome.logs).toContain(expected);
  });

  // An interrupted fan-out: one agent in flight, its sibling finished. The
  // unfinished one is a respawn; the finished one re-runs only because the
  // prefix invariant sends everything after a miss live.
  it('does not report a respawn for a completed call dragged live by the invariant', async () => {
    const keyA = deriveAgentKey(deriveArgsSeed(undefined), 'a', {});
    const keyB = deriveAgentKey(keyA, 'b', {});
    const dispatched: string[] = [];
    const { run, respawns } = resumeFrom(
      [
        // 'a' was in flight when the run stopped: started, never resulted.
        { type: 'started', key: keyA, agentId: '1' },
        // 'b' had already come back.
        { type: 'started', key: keyB, agentId: '2' },
        { type: 'result', key: keyB, agentId: '2', result: 'from the journal' },
      ],
      {
        dispatch: async (prompt) => {
          dispatched.push(prompt);
          return `live:${prompt}`;
        },
        script: `await agent('a', { label: 'inflight' }); return await agent('b', { label: 'finished' });`,
      },
    );
    const outcome = await run;
    // Both run live: the existing invariant, unchanged.
    expect(dispatched).toEqual(['a', 'b']);
    expect(outcome.result).toBe('live:b');
    // Only the one that never finished is a respawn.
    expect(respawns).toEqual([
      '[resume] respawning "inflight": interrupted in a previous run (1 prior attempt)',
    ]);
  });

  it('reports no respawn when the journal had a result to replay', async () => {
    const key = deriveAgentKey(deriveArgsSeed(undefined), 'x', {});
    const dispatch = vi.fn(async () => 'live');
    const { run, respawns } = resumeFrom(
      [
        { type: 'started', key, agentId: '1' },
        { type: 'result', key, agentId: '1', result: 'cached' },
      ],
      { dispatch, script: `return await agent('x');` },
    );
    const outcome = await run;
    expect(outcome.result).toBe('cached');
    expect(dispatch).not.toHaveBeenCalled();
    expect(respawns).toHaveLength(0);
  });

  it('does not journal or report a respawn when the budget gate refuses it', async () => {
    const key = deriveAgentKey(deriveArgsSeed(undefined), 'x', {});
    const { journal, entries } = memoryJournal();
    const dispatch = vi.fn(async () => 'unused');
    const { run, respawns } = resumeFrom(
      [{ type: 'started', key, agentId: 'prior' }],
      {
        dispatch,
        script: `try { await agent('x'); } catch (error) { return error.message; }`,
        budget: budgetOf(1, 1),
        journal,
      },
    );
    await run;
    expect(dispatch).not.toHaveBeenCalled();
    expect(entries).toEqual([]);
    expect(respawns).toEqual([]);
  });

  it('does not journal or report a respawn when the agent cap refuses it', async () => {
    await withEnv({ QWEN_CODE_MAX_WORKFLOW_AGENTS: '1' }, async () => {
      const keyA = deriveAgentKey(deriveArgsSeed(undefined), 'a', {});
      const keyB = deriveAgentKey(keyA, 'b', {});
      const { journal, entries } = memoryJournal();
      const dispatch = vi.fn(async (prompt: string) => prompt);
      const { run, respawns } = resumeFrom(
        [{ type: 'started', key: keyB, agentId: 'prior' }],
        {
          dispatch,
          script: `await agent('a'); try { await agent('b'); } catch (error) { return error.message; }`,
          journal,
        },
      );
      await run;
      expect(dispatch).toHaveBeenCalledOnce();
      expect(entries.map((entry) => entry.type)).toEqual(['started', 'result']);
      expect(
        entries.some((entry) => 'key' in entry && entry.key === keyB),
      ).toBe(false);
      expect(respawns).toEqual([]);
    });
  });

  it('preserves call-order journal ids without recording paused calls as started', async () => {
    const { journal, entries } = memoryJournal();
    const scheduler = new WorkflowDispatchScheduler(1);
    scheduler.pause();
    const dispatch = vi.fn(async (prompt: string) => prompt);
    let queued = 0;
    const run = runWf({
      dispatch,
      script: `return await parallel([
        () => agent('a'),
        () => agent('b'),
        () => agent('c'),
      ]);`,
      journal,
      scheduler,
      emitter: { dispatchQueued: () => queued++ },
    });
    await vi.waitFor(() => expect(queued).toBe(3));
    expect(entries).toEqual([]);
    expect(dispatch).not.toHaveBeenCalled();
    scheduler.resume();
    await expect(run).resolves.toMatchObject({ result: ['a', 'b', 'c'] });
    const started = ofType(entries, 'started');
    expect(started.map((entry) => entry.agentId)).toEqual(['1', '2', '3']);
    expect(new Set(started.map((entry) => entry.key)).size).toBe(3);
    expect(ofType(entries, 'result')).toEqual(
      started.map((entry, i) => ({
        ...entry,
        type: 'result',
        result: ['a', 'b', 'c'][i],
      })),
    );
  });

  it('appends an in-flight result before the paused result gate opens', async () => {
    const { journal, entries } = memoryJournal();
    const scheduler = new WorkflowDispatchScheduler(1);
    const { run } = await settleWhilePaused(scheduler, 'done', {
      script: `return await agent('a');`,
      journal,
    });
    expect(ofType(entries, 'result')).toHaveLength(1);
    await expectPending(run);
    scheduler.resume();
    await expect(run).resolves.toMatchObject({ result: 'done' });
  });

  it('preserves a dispatch error when cancellation aborts its pause gate', async () => {
    const controller = new AbortController();
    const scheduler = new WorkflowDispatchScheduler(1, controller.signal);
    const { run } = await settleWhilePaused(
      scheduler,
      new Error('dispatch-boom'),
      { script: `return await agent('a');` },
    );
    controller.abort();
    await expect(run).resolves.toMatchObject({ result: null });
  });

  // Awaits agent('a') through a two-arm .then while agent('keep') runs.
  const SAW_A = `
        let saw = 'none';
        const p = agent('a').then(
          (v) => { saw = 'resolved:' + v; },
          (e) => { saw = 'rejected:' + e.message; }
        );
        try { await agent('keep'); } catch (e) {}
        await p;
        return saw;
      `;

  it('delivers a successful dispatch result when cancellation aborts its pause gate', async () => {
    // The success arm resolves held results on abort, so this AWAITING
    // script sees the finished work, not an AbortError. (The
    // unhandledRejection rationale belongs to the fire-and-forget tests below.)
    const controller = new AbortController();
    const scheduler = new WorkflowDispatchScheduler(1, controller.signal);
    const { run } = await settleWhilePaused(scheduler, 'A', { script: SAW_A });
    controller.abort();
    await expect(run).resolves.toMatchObject({ result: 'resolved:A' });
  });

  // A cancelled run's fire-and-forget agent() must raise no process-level
  // unhandledRejection, whether its dispatch had succeeded (the reviewer's
  // "CRITICAL: Unhandled Promise Rejection" alarm) or was QUEUED and rejected
  // by abortPending(), a rethrow that must reach only awaiting callers.
  it.each([
    [
      'raises no unhandledRejection for an un-awaited successful dispatch on cancel',
      `agent('notify');`,
    ],
    [
      'raises no unhandledRejection for an un-awaited queued dispatch on cancel',
      `agent('inflight'); agent('notify');`,
    ],
  ])('%s', async (_title, unawaited) => {
    const controller = new AbortController();
    const scheduler = new WorkflowDispatchScheduler(1, controller.signal);
    let unhandled = 0;
    const onUnhandled = () => {
      unhandled += 1;
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const { run } = await settleWhilePaused(scheduler, 'A', {
        script: `
          ${unawaited}
          try { await agent('keep'); } catch (e) {}
          return 'done';
        `,
      });

      controller.abort();

      await expect(run).resolves.toMatchObject({ result: 'done' });
      // Let any pending unhandledRejection events fire before asserting.
      await sleep(20);
      expect(unhandled).toBe(0);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('delivers a cached dispatch result when cancellation aborts its pause gate', async () => {
    const resumeReplay = await journaledReplay(
      `await agent('a'); await agent('keep'); return 'done';`,
    );
    const controller = new AbortController();
    const scheduler = new WorkflowDispatchScheduler(1, controller.signal);
    scheduler.pause();
    let completed = 0;
    const run = runWf({
      dispatch: async () => 'LIVE',
      script: SAW_A,
      journal: memoryJournal().journal,
      resumeReplay,
      scheduler,
      emitter: {
        agentCompleted: () => {
          completed += 1;
        },
      },
    });
    // Both dispatches are cached; their results park behind the gate.
    await vi.waitFor(() => expect(completed).toBe(2));
    controller.abort();
    await expect(run).resolves.toMatchObject({ result: 'resolved:r:a' });
  });

  it('keeps a paused run alive past the wall-clock budget and completes it after resume', async () => {
    // The wall-clock hang backstop must suspend on pause and re-arm on
    // resume; killing a paused run would make resume impossible.
    await withEnv({ QWEN_CODE_MAX_WORKFLOW_SECONDS: '0.4' }, async () => {
      const scheduler = new WorkflowDispatchScheduler(1);
      const { run } = await settleWhilePaused(scheduler, 'done', {
        script: `return await agent('a');`,
      });
      await sleep(500); // past the 400 ms budget while paused
      await expectPending(run);
      scheduler.resume();
      await expect(run).resolves.toMatchObject({ result: 'done' });
    });
  });

  it('P6: resume serves the cached prefix without re-dispatching', async () => {
    // Run 2 resumes run 1's agents, both cached: no dispatch at all.
    const resumeReplay = await journaledReplay(
      `await agent('a'); await agent('b'); return 'done';`,
    );
    const dispatch = vi.fn(async (prompt: string) => `LIVE:${prompt}`);
    const scheduler = new WorkflowDispatchScheduler(1);
    scheduler.pause();
    const run = runWf({
      dispatch,
      script: `const a = await agent('a'); const b = await agent('b'); return a + '|' + b;`,
      journal: memoryJournal().journal,
      resumeReplay,
      scheduler,
    });
    // A gate-less cached resolve settles in ~4 microtasks.
    await expectPending(run);
    expect(dispatch).not.toHaveBeenCalled();
    scheduler.resume();
    const outcome = await run;
    expect(dispatch).not.toHaveBeenCalled(); // fully cached
    expect(outcome.result).toBe('r:a|r:b'); // cached values, not LIVE
  });

  it('P6: first miss runs live and the suffix goes live (first-miss invalidates suffix)', async () => {
    // Run 2 changes #2's prompt ('b' → 'B'): 'a' is cached, 'B' misses, and
    // journaled 'c' runs live too (first-miss invalidates the suffix, and the
    // prefix-hash chain changes #3's key anyway).
    const resumeReplay = await journaledReplay(
      `await agent('a'); await agent('b'); await agent('c'); return 1;`,
    );
    const dispatched: string[] = [];
    const outcome = await runWf({
      dispatch: async (prompt) => {
        dispatched.push(prompt);
        return `LIVE:${prompt}`;
      },
      script: `const a = await agent('a');
               const b = await agent('B');
               const c = await agent('c');
               return [a, b, c].join('|');`,
      journal: memoryJournal().journal,
      resumeReplay,
    });
    // 'a' cached; 'B' and 'c' live.
    expect(dispatched).toEqual(['B', 'c']);
    expect(outcome.result).toBe('r:a|LIVE:B|LIVE:c');
  });

  it('P6: cache hit advances the registry counters (agentDispatched + agentCompleted)', async () => {
    const resumeReplay = await journaledReplay(
      `await agent('a'); return 1;`,
      async () => 'cached',
    );
    const events: string[] = [];
    await runWf({
      dispatch: async () => 'LIVE',
      script: `await agent('a'); return 1;`,
      journal: memoryJournal().journal,
      resumeReplay,
      emitter: {
        agentDispatched: () => events.push('dispatched'),
        agentCompleted: () => events.push('completed'),
      },
    });
    expect(events).toEqual(['dispatched', 'completed']);
  });

  it('P6: cached dispatches do NOT consume the agent-count cap', async () => {
    // Run 2 resumes 3 cached agents under cap=2: the cap counts only LIVE
    // dispatches, so it never trips.
    await withEnv({ QWEN_CODE_MAX_WORKFLOW_AGENTS: '10' }, async () => {
      const resumeReplay = await journaledReplay(
        `await agent('a'); await agent('b'); await agent('c'); return 1;`,
      );
      process.env['QWEN_CODE_MAX_WORKFLOW_AGENTS'] = '2';
      const outcome = await runWf({
        dispatch: async () => 'LIVE',
        script: `await agent('a'); await agent('b'); await agent('c'); return 'ok';`,
        journal: memoryJournal().journal,
        resumeReplay,
      });
      expect(outcome.result).toBe('ok'); // no cap error despite 3 > 2
    });
  });
});

describe('createProductionDispatch', () => {
  // FIX-C3: each case observes only its own execute call, mode back to GOAL.
  beforeEach(resetHeadlessMock);

  it.each([
    {},
    { model: 'other-model' },
    { schema: { type: 'object' } },
    { isolation: 'worktree' as const },
  ])(
    'refuses an operator container requirement before dispatch: %j',
    async (options) => {
      const config = {
        getAgentExecutionBackend: () => 'container' as const,
      } as Config;
      const worktreesBefore = worktreeStubs.instances.length;

      await expect(
        createProductionDispatch(config)('do work', options),
      ).rejects.toThrow('workflow agents are unsupported');

      expect(created).toHaveLength(0);
      expect(worktreeStubs.instances).toHaveLength(worktreesBefore);
    },
  );

  it('routes calls through AgentHeadless and returns getFinalText', async () => {
    expect(await dispatchHello()).toBe('headless-said:hello');
    expect(created.length).toBe(1);
    expect(created[0]!.name).toBe('h1');
    expect(created[0]!.prompt).toBe('hello');
    expect(created[0]!.agentId).toMatch(/^workflow-agent-[0-9a-f]{16}$/);
    expect(created[0]!.taskName).toBe('hello');
    expect(created[0]!.subagentId).toBe(created[0]!.agentId);
    expect(created[0]!.executeOptions).toEqual({
      enforceTimeLimitDuringRetryWait: true,
    });
  });

  it('does not suppress env bootstrap with an empty initial history', async () => {
    await dispatchHello();
    expect(created[0]!.promptConfigInitialMessages).toBeUndefined();
  });

  it('strips internal tags from fast-path final text', async () => {
    nextFinalText.value =
      '<analysis>scratch</analysis><summary>clean result</summary>';
    await expect(dispatchHello()).resolves.toBe('clean result');
  });

  // FIX-C4 (TST-2-C2): assert the captured signal, so dropping execute()'s
  // second arg fails. P-stall: the stall wrapper hands the subagent a
  // per-attempt signal chained to the parent, not the caller's object;
  // propagation is tested in workflow-stall.test.ts, where timing is
  // controllable. Here the subagent must always get a live signal.
  it('threads a per-attempt abort signal through to subagent.execute', async () => {
    const signal = new AbortController().signal;
    await createProductionDispatch(fakeConfig(), signal)('hello', {
      label: 'h1',
    });
    expect(created.length).toBe(1);
    expect(created[0]!.signal).toBeDefined();
  });

  it('provides a per-attempt signal even when no caller signal is given', async () => {
    await dispatchHello();
    expect(created.length).toBe(1);
    // Always supplied (the watchdog aborts it), just chained to no parent.
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
      await stallUntilAborted(emitter, signal, 'workflow-agent', 'prompt-1');
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
    const record = () => registry.get(handle.runId);
    await vi.waitFor(() => {
      expect(record()?.pendingApprovals).toHaveLength(1);
    });
    expect(respond).not.toHaveBeenCalled();
    const approval = record()!.pendingApprovals[0];
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
    expect(record()?.pendingApprovals).toEqual([]);
    expect(record()?.status).toBe('completed');
  });

  // FIX-C2 (UP-2-C1): the binary's §XmO bullets; without the JSON-format
  // instruction, JSON-returning subagents wrap output in code fences.
  it('passes the binary §XmO verbatim system prompt to subagent', async () => {
    await dispatchHello();
    const sp = created[0]!.promptConfigSystemPrompt ?? '';
    expect(sp).toContain('subagent spawned by a workflow');
    expect(sp).toContain('return ONLY the raw JSON');
    expect(sp).toContain('no code fences');
    expect(sp).toContain('SendUserMessage');
  });

  // T11 (PR #4732 R1): bounded, so one agent() cannot loop forever. The env
  // knobs are cleared so an operator's exported values cannot flip this.
  it('passes bounded runConfig (max_turns + max_time_minutes)', async () => {
    await withEnv(
      {
        QWEN_CODE_WORKFLOW_AGENT_MAX_TURNS: undefined,
        QWEN_CODE_WORKFLOW_AGENT_MAX_MINUTES: undefined,
      },
      async () => {
        await dispatchHello();
        // Literal anchors: editing a DEFAULT_* constant must fail this.
        expect(created[0]!.runConfig).toEqual({
          max_turns: 50,
          max_time_minutes: 10,
        });
      },
    );
  });

  // In a clean env the DEFAULT_* constants and the resolvers agree, so only a
  // stubbed env proves the dispatch site uses the resolvers.
  it('fast-path dispatch honors the env-tunable subagent bounds', async () => {
    await withEnv(
      {
        QWEN_CODE_WORKFLOW_AGENT_MAX_TURNS: '120',
        QWEN_CODE_WORKFLOW_AGENT_MAX_MINUTES: '45',
      },
      async () => {
        await dispatchHello();
        expect(created[0]!.runConfig).toEqual({
          max_turns: 120,
          max_time_minutes: 45,
        });
      },
    );
  });

  it('fast-path dispatch carries host review bounds into the agent', async () => {
    await createProductionDispatch(
      fakeConfig(),
      undefined,
      undefined,
      undefined,
      { max_turns: 500, max_time_minutes: 100 },
    )('review', {});
    expect(created[0]!.runConfig).toEqual({
      max_turns: 500,
      max_time_minutes: 100,
    });
  });

  // T11: SendMessage plus tools breaking workflow return/cleanup contracts.
  it('disallows workflow-only floor tools for workflow subagents', async () => {
    await dispatchHello();
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

  // T10 (PR #4732 R1): a non-GOAL terminate mode must throw; otherwise
  // `await agent(...)` resolves to '' on user cancel and the script runs on.
  it.each([['CANCELLED'], ['MAX_TURNS'], ['TIMEOUT'], ['ERROR']])(
    'throws when subagent terminate mode is %s',
    async (mode) => {
      nextTerminateMode.value = mode;
      await expect(dispatchHello()).rejects.toThrow(
        new RegExp(
          `workflow-agent-[0-9a-f]{16} did not complete \\(terminate mode: ${mode}\\)\\.`,
        ),
      );
    },
  );

  // The CLASS decides whether the script sees `null` or the run ends. Burned
  // turns or an error are the agent's own failure; CANCELLED (a stall, a user
  // skip or a run abort) stays a plain Error for the stall wrapper.
  it.each([
    ['MAX_TURNS', 'max_turns'],
    ['TIMEOUT', 'timeout'],
    ['ERROR', 'error'],
  ])('classifies %s as an agent-level failure', async (mode, kind) => {
    nextTerminateMode.value = mode;
    const caught = await dispatchHello().catch((e) => e);
    expect(isWorkflowAgentFailedError(caught)).toBe(true);
    expect((caught as WorkflowAgentFailedError).kind).toBe(kind);
    expect((caught as WorkflowAgentFailedError).terminateMode).toBe(mode);
  });

  it('leaves CANCELLED unclassified for the stall wrapper', async () => {
    nextTerminateMode.value = 'CANCELLED';
    const caught = await dispatchHello().catch((e) => e);
    expect(caught).toBeInstanceOf(Error);
    expect(isWorkflowAgentFailedError(caught)).toBe(false);
  });

  // ── R1 (#1 + #3): token reporting across all terminate modes ──────────

  beforeEach(() => {
    nextOutputTokens.value = 0;
  });

  /** A fast-path dispatch whose onTokens reports land in `reports`. */
  const reporting = () => {
    const reports: number[] = [];
    const dispatch = createProductionDispatch(
      fakeConfig(),
      undefined,
      (tokens) => reports.push(tokens),
    );
    return { reports, dispatch };
  };

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
      const { reports, dispatch } = reporting();
      await expect(dispatch('q1', { label: 'doomed' })).rejects.toThrow(
        new RegExp(`terminate mode: ${mode}`),
      );
      // R1: recorded BEFORE the throw, or failed dispatches escape the budget.
      expect(reports).toEqual([777]);
    },
  );

  it('R1 #1 + #3: onTokens is undefined ⇒ no crash', async () => {
    nextTerminateMode.value = 'GOAL';
    nextOutputTokens.value = 99;
    await expect(
      createProductionDispatch(fakeConfig())('q1', { label: 'x' }),
    ).resolves.toBe('headless-said:q1');
  });

  // ── R3 (wenshao #6): tokens MUST also be recorded when execute() THROWS ──

  it('R3 #6: records tokens when subagent.execute() THROWS (the real production ERROR path)', async () => {
    // R1 #3 covered execute() RETURNING with ERROR (the rare `createChat`
    // early return). The production path RE-THROWS from agent-headless.ts's
    // catch arm, and reportTokens sat after the await, not in a `finally`,
    // so it leaked tokens (wenshao's R3 repro).
    nextExecuteThrow.value = new Error('reasoning-loop boom');
    nextOutputTokens.value = 4242;
    const { reports, dispatch } = reporting();
    await expect(dispatch('q1', { label: 'thrown' })).rejects.toThrow(
      /reasoning-loop boom/,
    );
    // Exactly once, whether execute() or the mode gate (R1 #3) threw.
    expect(reports).toEqual([4242]);
  });

  afterEach(() => {
    nextExecuteThrow.value = null;
  });
});

describe('WorkflowOrchestrator failure-context preservation', () => {
  // T19 (PR #4732 R1): phases and logs survive on the thrown error for the
  // tool layer; the sandbox instance used to be discarded with it.
  it('throws WorkflowExecutionError carrying phases and logs on script failure', async () => {
    const caught = await rejectionOf(
      runWf({
        dispatch: async () => 'ok',
        script: `
          phase("plan");
          log("starting");
          phase("execute");
          log("about to fail");
          throw new Error("scripted failure");
        `,
      }),
    );
    expect(caught).toBeInstanceOf(WorkflowExecutionError);
    const wfErr = caught as WorkflowExecutionError;
    expect(wfErr.message).toContain('scripted failure');
    expect(wfErr.phases).toEqual(['plan', 'execute']);
    expect(wfErr.logs).toEqual(['starting', 'about to fail']);
  });
});

describe('WorkflowOrchestrator schema preflight', () => {
  const bad = `{ type: 42 }`;
  const good = `{ type: 'object', required: ['ok'] }`;

  function run(script: string, emitter?: WorkflowOrchestratorEmitter) {
    const dispatch = vi.fn(async (prompt: string) => ({ ok: prompt }));
    const outcome = new WorkflowOrchestrator(dispatch).run({
      script,
      args: undefined,
      resolveSavedWorkflow: async () => ({
        script: `return [await agent('nested-bad', { schema: ${bad} }), await agent('nested-good', { schema: ${good} })];`,
      }),
      ...(emitter ? { emitter } : {}),
    });
    return { dispatch, outcome };
  }

  it.each([
    [
      'sequential',
      `return [await agent('bad', { schema: ${bad} }), await agent('good', { schema: ${good} })];`,
      [null, { ok: 'good' }],
      ['good'],
    ],
    [
      'parallel',
      `return await parallel([() => agent('bad', { schema: ${bad} }), () => agent('good', { schema: ${good} })]);`,
      [null, { ok: 'good' }],
      ['good'],
    ],
    [
      'pipeline',
      `return await pipeline(['bad', 'good'], (_prev, item) => agent(item, { schema: item === 'bad' ? ${bad} : ${good} }), (prev) => agent('after ' + JSON.stringify(prev)));`,
      [null, { ok: 'after {"ok":"good"}' }],
      ['good', 'after {"ok":"good"}'],
    ],
    [
      'nested',
      `return await workflow('child');`,
      [null, { ok: 'nested-good' }],
      ['nested-good'],
    ],
  ])(
    'settles a refused schema to null without dispatching it (%s)',
    async (_shape, script, result, dispatched) => {
      const { dispatch, outcome } = run(script);
      await expect(outcome).resolves.toMatchObject({ result });
      expect(dispatch.mock.calls.map((call) => call[0])).toEqual(dispatched);
    },
  );

  it('records why the refused agent failed', async () => {
    const completed: Array<[string | undefined, string | undefined]> = [];
    const { outcome } = run(
      `return await agent('bad', { label: 'bad', schema: ${bad} });`,
      { agentCompleted: (label, error) => completed.push([label, error]) },
    );
    await expect(outcome).resolves.toMatchObject({ result: null });
    expect(completed).toEqual([
      [
        'bad',
        expect.stringMatching(
          /^agent\(\{schema\}\): is not a valid JSON Schema: /,
        ),
      ],
    ]);
  });

  it.each([
    [
      `try { return await agent('bad', { schema: ${bad} }); } catch (e) { return 'threw'; }`,
      null,
    ],
    [
      `const settled = await Promise.allSettled([agent('bad', { schema: ${bad} })]); return settled.map((s) => s.status + ':' + JSON.stringify(s.value));`,
      ['fulfilled:null'],
    ],
    [`agent('bad', { schema: ${bad} }); return 'unawaited';`, 'unawaited'],
  ])(
    'keeps the refusal inside the script contract without an unhandled rejection: %s',
    async (script, result) => {
      let unhandled = 0;
      const onUnhandled = () => {
        unhandled += 1;
      };
      process.on('unhandledRejection', onUnhandled);
      try {
        const { dispatch, outcome } = run(script);
        await expect(outcome).resolves.toMatchObject({ result });
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(dispatch).not.toHaveBeenCalled();
      } finally {
        process.off('unhandledRejection', onUnhandled);
      }
      expect(unhandled).toBe(0);
    },
  );

  it('still lets run-level limits win over a refused schema', async () => {
    vi.stubEnv('QWEN_CODE_MAX_WORKFLOW_AGENTS', '1');
    try {
      const { dispatch, outcome } = run(
        `await agent('good', { schema: ${good} }); return await agent('bad', { schema: ${bad} });`,
      );
      await expect(outcome).rejects.toThrow('maximum of 1 agent() calls');
      expect(dispatch.mock.calls.map((call) => call[0])).toEqual(['good']);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('WorkflowOrchestrator P2 — parallel() / pipeline() / caps', () => {
  /** A 5 ms dispatch tracking its peak in-flight count. */
  const peakTracker = () => {
    const state = { inFlight: 0, peak: 0 };
    const dispatch = async () => {
      state.inFlight++;
      state.peak = Math.max(state.peak, state.inFlight);
      await sleep(5);
      state.inFlight--;
      return 'ok';
    };
    return { state, dispatch };
  };
  const cpuCap = () => Math.max(2, Math.min(16, os.availableParallelism() - 2));

  describe('parallel()', () => {
    // EAD-1 (P2 self-review): a non-JSON-serializable value (BigInt /
    // circular) becomes null at its index; revival is per element, so
    // errors-as-data holds for return values too.
    it.each([
      [
        'resolves all thunks to a position-aligned array',
        `() => agent("a"), () => agent("b"), () => agent("c")`,
        ['r:a', 'r:b', 'r:c'],
      ],
      [
        'errors-as-data: a thunk that throws becomes null at its index, others unaffected',
        `() => agent("a"), () => { throw new Error("boom"); }, () => agent("c")`,
        ['r:a', null, 'r:c'],
      ],
      [
        'a thunk returning a non-serializable value becomes null without crashing siblings',
        `() => "a", () => 1n, () => "c", () => { const o = {}; o.self = o; return o; }`,
        ['a', null, 'c', null],
      ],
    ])('%s', async (_title, thunks, expected) => {
      const outcome = await runWf({
        dispatch: answers('r:'),
        script: `return await parallel([${thunks}]);`,
      });
      expect(outcome.result).toEqual(expected);
    });

    it('rejects on a non-function element (eager promise instead of thunk)', async () => {
      await expect(
        runWf({ script: `return await parallel([agent("a")]);` }),
      ).rejects.toThrow(/array of functions/);
    });

    it('caps concurrent agents within a fan-out to the shared per-run window', async () => {
      const { state, dispatch } = peakTracker();
      await runWf({
        dispatch,
        script: `return await parallel(
          Array.from({ length: 50 }, () => () => agent("x"))
        );`,
      });
      // 50 thunks >> window, so the window fully fills: peak === cap.
      expect(state.peak).toBe(cpuCap());
    });

    it('propagates run-level failures wrapped by Promise.any', async () => {
      await expect(
        runWf({
          script: `return await parallel([() => Promise.any([Promise.any([agent('x')])])]);`,
          budget: budgetOf(1, 1),
        }),
      ).rejects.toThrow(/token budget exceeded/);
      await expect(
        runWf({
          dispatch: async () => {
            throw new WorkflowAgentCapExceededError(1000);
          },
          script: `return await parallel([() => Promise.any([agent('x')])]);`,
        }),
      ).rejects.toThrow(/maximum of 1000 agent\(\) calls/);
    });
  });

  describe('pipeline()', () => {
    it.each([
      [
        'runs each item through the stages; first stage receives (item, item, idx)',
        `[10, 20], (prev, item, idx) => prev + "|" + item + "|" + idx, (prev) => "S2(" + prev + ")"`,
        ['S2(10|10|0)', 'S2(20|20|1)'],
      ],
      [
        'a stage returning null drops that item to null and skips remaining stages',
        `[1, 2, 3], (x) => (x === 2 ? null : x), (x) => x * 100`,
        [100, null, 300],
      ],
      [
        'a stage that throws drops that item to null (errors-as-data), others unaffected',
        `[1, 2, 3], (x) => { if (x === 2) throw new Error("bad"); return x; }, (x) => x * 100`,
        [100, null, 300],
      ],
    ])('%s', async (_title, args, expected) => {
      const outcome = await runWf({
        script: `return await pipeline(${args});`,
      });
      expect(outcome.result).toEqual(expected);
    });

    it('rejects when a stage is not a function', async () => {
      await expect(
        runWf({ script: `return await pipeline([1, 2], "not a function");` }),
      ).rejects.toThrow(/stages must be functions/);
    });

    // TST-1 (P2 self-review): pipeline shares parallel's per-run window; a
    // separate (or no) limiter would let concurrency exceed the cap.
    it('caps concurrent agents across a pipeline fan-out (shares the run window)', async () => {
      const { state, dispatch } = peakTracker();
      await runWf({
        dispatch,
        script: `return await pipeline(
          Array.from({ length: 50 }, (_, i) => i),
          (x) => agent("s1-" + x),
        );`,
      });
      expect(state.peak).toBe(cpuCap());
    });

    // TST-2 (P2 self-review): STAGGERED chains, NO inter-stage barrier: item
    // 1's stage 1 blocks until item 0 reaches stage 2, a circular wait (test
    // timeout) under a barrier impl. PR #4947 R2 T6 (DragonnZhang): an
    // elapsed-time threshold failed on a 3-core macOS-14 runner (cpu limit 1,
    // FIFO); force the limit to 2 and use this timing-free gate.
    it('is staggered with no inter-stage barrier (item A reaches stage 2 while item B is still in stage 1)', async () => {
      await withEnv({ QWEN_CODE_MAX_WORKFLOW_CONCURRENCY: '2' }, async () => {
        let releaseItem1Stage1: () => void = () => {};
        const item1Stage1Gate = new Promise<void>((resolve) => {
          releaseItem1Stage1 = resolve;
        });
        let item0ReachedStage2 = false;
        await runWf({
          dispatch: async (prompt) => {
            if (prompt === 's1-0') return 'ok'; // item 0's stage 1: fast
            if (prompt === 's1-1') {
              // Blocks until item 0 reaches stage 2.
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
          },
          script: `return await pipeline([0, 1],
            (prev, item) => agent("s1-" + item),
            (prev, item) => agent("s2-" + item),
          );`,
        });
        expect(item0ReachedStage2).toBe(true);
      });
    }, 10_000);
  });

  describe('batch limit', () => {
    const run = (script: string, dispatch = vi.fn(async () => 'ok')) =>
      new WorkflowOrchestrator(dispatch).run({ script, args: undefined });

    it.each([0, 1, 4096])('parallel() accepts %i thunks', async (n) => {
      const outcome = await run(`
        const r = await parallel(Array.from({ length: ${n} }, (_, i) => () => i));
        return [r.length, r[0], r[r.length - 1]];`);
      expect(outcome.result).toEqual(
        n === 0 ? [0, undefined, undefined] : [n, 0, n - 1],
      );
    });

    it('parallel() refuses 4097 thunks without running any of them', async () => {
      const dispatch = vi.fn(async () => 'ok');
      const outcome = await run(
        `let ran = 0;
        const thunks = Array.from({ length: 4097 }, (_, i) =>
          () => { ran++; return i === 0 ? agent('x') : i; });
        try { await parallel(thunks); return 'resolved'; }
        catch (e) { return [ran, e.message]; }`,
        dispatch,
      );
      const [ran, message] = outcome.result as [number, string];
      expect(ran).toBe(0);
      expect(message).toContain('parallel() thunks: 4097 entries');
      expect(message).toContain('limit of 4096 per call');
      expect(dispatch).not.toHaveBeenCalled();
    });

    it.each([0, 1, 4096])('pipeline() accepts %i items', async (n) => {
      const outcome = await run(`
        const r = await pipeline(Array.from({ length: ${n} }, (_, i) => i), (x) => x * 2);
        return [r.length, r[r.length - 1]];`);
      expect(outcome.result).toEqual(
        n === 0 ? [0, undefined] : [n, (n - 1) * 2],
      );
    });

    it('pipeline() refuses 4097 items without running a stage', async () => {
      const outcome = await run(`
        let ran = 0;
        try {
          await pipeline(Array.from({ length: 4097 }, (_, i) => i), (x) => { ran++; return x; });
          return 'resolved';
        } catch (e) { return [ran, e.message]; }`);
      const [ran, message] = outcome.result as [number, string];
      expect(ran).toBe(0);
      expect(message).toContain('pipeline() items: 4097 entries');
    });

    it.each([0, 1, 4096])('pipeline() accepts %i stages', async (n) => {
      const outcome = await run(`
        const stages = Array.from({ length: ${n} }, () => (x) => x + 1);
        return await pipeline([0], ...stages);`);
      expect(outcome.result).toEqual([n]);
    });

    it.each([
      ['with an item', '[0]'],
      ['with no items', '[]'],
    ])(
      'pipeline() refuses 4097 stages %s without running one',
      async (_name, items) => {
        const outcome = await run(`
        let ran = 0;
        const stages = Array.from({ length: 4097 }, () => (x) => { ran++; return x; });
        try { await pipeline(${items}, ...stages); return 'resolved'; }
        catch (e) { return [ran, e.message]; }`);
        const [ran, message] = outcome.result as [number, string];
        expect(ran).toBe(0);
        expect(message).toContain('pipeline() stages: 4097 entries');
      },
    );

    it('counts a sparse list by its length', async () => {
      const outcome = await run(`
        const thunks = []; thunks[5000] = () => 1;
        const items = []; items[5000] = 1;
        const out = [];
        try { await parallel(thunks); } catch (e) { out.push(e.message); }
        try { await pipeline(items, (x) => x); } catch (e) { out.push(e.message); }
        return out;`);
      const [p, q] = outcome.result as string[];
      expect(p).toContain('parallel() thunks: 5001 entries');
      expect(q).toContain('pipeline() items: 5001 entries');
    });

    it('keeps the existing handling of short sparse lists', async () => {
      const outcome = await run(`
        const out = [];
        try { await parallel([() => 1, , () => 3]); }
        catch (e) { out.push(e.message); }
        out.push(await pipeline([1, , 3], (x) => x * 10));
        return out;`);
      const [p, q] = outcome.result as [string, unknown[]];
      expect(p).toMatch(/array of functions/);
      expect(q).toEqual([10, null, 30]);
    });

    it('reports a non-function thunk only after the length passes', async () => {
      const outcome = await run(`
        try { await parallel(Array.from({ length: 4097 }, () => 1)); }
        catch (e) { return e.message; }`);
      expect(outcome.result).toContain('parallel() thunks: 4097 entries');
    });

    it('uses one bounded copy, not the input iterator, map or a later length', async () => {
      const outcome = await run(`
        let ran = 0;
        const thunks = [() => { ran++; return 1; }, () => { ran++; return 2; }];
        thunks[Symbol.iterator] = function* () { for (let i = 0; i < 5000; i++) yield () => i; };
        thunks.map = () => { throw new Error('map was used'); };
        const a = await parallel(thunks);

        let reads = 0;
        const growing = new Proxy([() => 1], {
          get(target, key) {
            if (key === 'length') return reads++ === 0 ? 1 : 5000;
            return target[key];
          },
        });
        const b = await parallel(growing);

        const bad = [];
        for (const len of [-1, 1.5, 2 ** 53, 'x']) {
          const p = new Proxy([], { get: (t, k) => (k === 'length' ? len : t[k]) });
          try { await parallel(p); } catch (e) { bad.push(e.message); }
        }
        const throwing = new Proxy([], {
          get(t, k) { if (k === 'length') throw new Error('boom'); return t[k]; },
        });
        try { await pipeline(throwing, (x) => x); } catch (e) { bad.push(e.message); }
        return { a, b, ran, bad };`);
      const { a, b, ran, bad } = outcome.result as {
        a: unknown[];
        b: unknown[];
        ran: number;
        bad: string[];
      };
      expect(a).toEqual([1, 2]);
      expect(ran).toBe(2);
      expect(b).toEqual([1]);
      expect(bad).toHaveLength(5);
      expect(bad.slice(0, 4)).toEqual(
        Array(4).fill(
          'parallel() thunks must be an array with a readable length.',
        ),
      );
      expect(bad[4]).toBe(
        'pipeline() items must be an array with a readable length.',
      );
    });

    it('does not limit the total across calls', async () => {
      const outcome = await run(`
        const first = await parallel(Array.from({ length: 4096 }, (_, i) => () => i));
        const second = await pipeline(Array.from({ length: 4096 }, (_, i) => 4096 + i), (x) => x);
        const all = first.concat(second);
        return [all.length, all[0], all[4095], all[4096], all[8191]];`);
      expect(outcome.result).toEqual([8192, 0, 4095, 4096, 8191]);
    });

    it('is an ordinary rejection: an outer parallel() maps it to null', async () => {
      const dispatch = vi.fn(async () => 'ok');
      const outcome = await run(
        `let inner = 0;
        return await parallel([
          () => agent('sibling'),
          () => parallel(Array.from({ length: 4097 }, () => () => { inner++; return agent('x'); })),
          () => pipeline([1], ...Array.from({ length: 4097 }, () => (x) => { inner++; return x; })),
          () => inner,
        ]);`,
        dispatch,
      );
      expect(outcome.result).toEqual(['ok', null, null, 0]);
      expect(dispatch).toHaveBeenCalledTimes(1);
    });

    it('does not stop a run-level failure from propagating', async () => {
      const { WorkflowBudgetImpl } = await import('./workflow-budget.js');
      const budget = new WorkflowBudgetImpl(1);
      budget.recordSpent(1);
      await expect(
        new WorkflowOrchestrator(async () => 'unused').run({
          script: `return await parallel([
            () => parallel(Array.from({ length: 4097 }, () => () => 1)),
            () => agent('x'),
          ]);`,
          args: undefined,
          budget,
        }),
      ).rejects.toThrow(/token budget exceeded/);
    });
  });

  describe('1000-agent cap', () => {
    const capError = new RegExp(
      `${DEFAULT_MAX_AGENTS_PER_RUN} agent\\(\\) calls per run`,
    );

    it.each([
      [
        'the 1001st sequential agent() call throws the cap error',
        `for (let i = 0; i < ${DEFAULT_MAX_AGENTS_PER_RUN + 1}; i++) {
            await agent("x");
          }
          return "done";`,
      ],
      [
        'the cap counts agents launched via parallel() — a fan-out cannot bypass it',
        `return await parallel(
            Array.from({ length: ${DEFAULT_MAX_AGENTS_PER_RUN + 1} }, () => () => agent("x"))
          );`,
      ],
    ])('%s', async (_title, script) => {
      await expect(
        runWf({ dispatch: async () => 'ok', script }),
      ).rejects.toThrow(capError);
    });

    it('rejects a pipeline when an agent hits the run-level cap', async () => {
      await withEnv({ QWEN_CODE_MAX_WORKFLOW_AGENTS: '1' }, async () => {
        await expect(
          runWf({
            dispatch: async () => 'ok',
            script: `return await pipeline(['a', 'b'], (_prev, item) => agent(item));`,
          }),
        ).rejects.toThrow(/maximum of 1 agent\(\) call/);
      });
    });

    it('preserves a run-level cap rejection through nested fan-out', async () => {
      await withEnv({ QWEN_CODE_MAX_WORKFLOW_AGENTS: '1' }, async () => {
        await expect(
          runWf({
            dispatch: async () => 'ok',
            script: `return await parallel([
              () => parallel([() => agent('a'), () => agent('b')])
            ]);`,
          }),
        ).rejects.toThrow(/maximum of 1 agent\(\) call/);
      });
    });
  });

  describe('abort', () => {
    it('parallel() rejects (not silent nulls) when the run is aborted', async () => {
      const ac = new AbortController();
      ac.abort();
      await expect(
        runWf({
          dispatch: async () => 'ok',
          script: `return await parallel([() => agent("a"), () => agent("b")]);`,
          abortOnTimeout: ac,
        }),
      ).rejects.toThrow(/abort/i);
    });

    // TST-3 (P2 self-review): beyond the pre-aborted fast path, a MID-FLIGHT
    // abort must reject, not resolve silent nulls that let the run continue.
    it('parallel() rejects when aborted MID-FLIGHT (after dispatches started)', async () => {
      const ac = new AbortController();
      const dispatch = vi.fn(async () => {
        await sleep(40);
        return 'ok';
      });
      const p = runWf({
        dispatch,
        script: `return await parallel(
          Array.from({ length: 6 }, () => () => agent("x"))
        );`,
        abortOnTimeout: ac,
      });
      // Abort once at least one dispatch is in flight.
      setTimeout(() => ac.abort(), 10);
      await expect(p).rejects.toThrow(/abort/i);
      expect(dispatch.mock.calls.length).toBeGreaterThan(0);
    }, 10_000);
  });

  describe('nested fan-out (shared-window re-entrancy)', () => {
    // F1 (P2 review round 1): the limiter throttles AGENT DISPATCHES, not
    // thunks. With `pipeline(items, item => parallel(...))` (upstream
    // /deep-research), a thunk-level limiter lets outer chains hold every slot
    // while inner agents wait: a silent hang until the 30-min wall clock. A
    // window of 1 makes that worst case deterministic.
    it.each([
      [
        'a parallel() inside a pipeline() stage does not deadlock at concurrency=1',
        `pipeline([0, 1, 2], (prev, item) => parallel([() => agent("a" + item)]))`,
        [['r:a0'], ['r:a1'], ['r:a2']],
      ],
      [
        'parallel() of parallel() does not deadlock at concurrency=1',
        `parallel([
            () => parallel([() => agent("x")]),
            () => parallel([() => agent("y")]),
          ])`,
        [['r:x'], ['r:y']],
      ],
    ])(
      '%s',
      async (_title, expression, expected) => {
        await withEnv({ QWEN_CODE_MAX_WORKFLOW_CONCURRENCY: '1' }, async () => {
          const outcome = await runWf({
            dispatch: answers('r:'),
            script: `return await ${expression};`,
          });
          expect(outcome.result).toEqual(expected);
        });
      },
      15_000,
    );
  });

  describe('env-overridable caps', () => {
    const agentCap = (raw: string) =>
      resolveMaxAgentsPerRun({ QWEN_CODE_MAX_WORKFLOW_AGENTS: raw });
    const concurrency = (raw: string) =>
      resolveConcurrencyLimit({ QWEN_CODE_MAX_WORKFLOW_CONCURRENCY: raw });
    const maxTurns = (raw: string) =>
      resolveSubagentMaxTurns({ QWEN_CODE_WORKFLOW_AGENT_MAX_TURNS: raw });
    const maxMinutes = (raw: string) =>
      resolveSubagentMaxTimeMinutes({
        QWEN_CODE_WORKFLOW_AGENT_MAX_MINUTES: raw,
      });

    it('resolveMaxAgentsPerRun defaults to 1000 and honors a valid override', () => {
      expect(resolveMaxAgentsPerRun({})).toBe(DEFAULT_MAX_AGENTS_PER_RUN);
      expect(agentCap('50')).toBe(50);
    });

    it('resolveMaxAgentsPerRun rejects a non-integer / <1 override and falls back', () => {
      expect(agentCap('0')).toBe(DEFAULT_MAX_AGENTS_PER_RUN);
      expect(agentCap('abc')).toBe(DEFAULT_MAX_AGENTS_PER_RUN);
      expect(agentCap('2.5')).toBe(DEFAULT_MAX_AGENTS_PER_RUN);
    });

    it('resolveMaxAgentsPerRun rejects hex / scientific / non-decimal-integer overrides', () => {
      // All pass Number.isInteger; only plain decimal integers may override.
      for (const raw of ['0x10', '1e3', '1.0']) {
        expect(agentCap(raw)).toBe(DEFAULT_MAX_AGENTS_PER_RUN);
      }
    });

    it('resolveConcurrencyLimit treats hex / scientific overrides as invalid (cpu default)', () => {
      // Rejected (cpu default), not parsed as 16 / 100.
      const cpuDefault = concurrency('-1');
      for (const raw of ['0x10', '1e2']) {
        expect(concurrency(raw)).toBe(cpuDefault);
      }
    });

    // PR #4947 R1 T4 (wenshao): clamped, so a fat-fingered override cannot
    // silently uncap the run.
    it('resolveMaxAgentsPerRun clamps an over-ceiling override to the hard maximum', () => {
      expect(agentCap('999999999')).toBe(10_000);
      // Just under the ceiling is preserved.
      expect(agentCap('9999')).toBe(9999);
    });

    // Build-and-test agents routinely exceed 50 turns / 10 minutes, and a cut
    // off agent shows up as a silent `null`; so both bounds are tunable, on
    // the agent cap's contract.
    it('per-subagent bounds default, honor an override, and clamp', () => {
      expect(resolveSubagentMaxTurns({})).toBe(
        DEFAULT_WORKFLOW_SUBAGENT_MAX_TURNS,
      );
      expect(resolveSubagentMaxTimeMinutes({})).toBe(
        DEFAULT_WORKFLOW_SUBAGENT_MAX_TIME_MINUTES,
      );
      expect(maxTurns('120')).toBe(120);
      expect(maxMinutes('45')).toBe(45);
      // Literal ceilings; HARD_* would assert against themselves.
      expect(maxTurns('999999')).toBe(500);
      expect(maxMinutes('999999')).toBe(100);
    });

    it('per-subagent bounds reject non-decimal-integer overrides', () => {
      for (const raw of ['0', 'abc', '2.5', '0x10', '1e3']) {
        expect(maxTurns(raw)).toBe(DEFAULT_WORKFLOW_SUBAGENT_MAX_TURNS);
        expect(maxMinutes(raw)).toBe(
          DEFAULT_WORKFLOW_SUBAGENT_MAX_TIME_MINUTES,
        );
      }
    });

    it('resolveConcurrencyLimit honors a valid override and clamps the cpu default to [2,16]', () => {
      expect(concurrency('4')).toBe(4);
      // invalid → cpu-derived default, always within [2, 16]
      const fallback = concurrency('-1');
      expect(fallback).toBeGreaterThanOrEqual(2);
      expect(fallback).toBeLessThanOrEqual(16);
    });

    // `availableParallelism()` honours affinity and container limits, where
    // `os.cpus()` reports the host or nothing. The floor is 2: a window of 1
    // would serialize every `parallel()` on a small machine.
    it('resolveConcurrencyLimit derives the default from availableParallelism, floored at 2', () => {
      const at = (parallelism: number) =>
        resolveConcurrencyLimit({}, () => parallelism);
      expect(at(0)).toBe(2);
      expect(at(1)).toBe(2);
      expect(at(3)).toBe(2);
      expect(at(6)).toBe(4);
      expect(at(18)).toBe(16);
      expect(at(64)).toBe(16);
    });

    // PR #4947 R1 T4 (wenshao): 999999 concurrent LLM calls would OOM.
    it('resolveConcurrencyLimit clamps an over-ceiling override to the hard maximum', () => {
      expect(concurrency('999999')).toBe(64);
      // Just under the ceiling is preserved.
      expect(concurrency('63')).toBe(63);
    });

    it('QWEN_CODE_MAX_WORKFLOW_AGENTS actually lowers the cap at run time', async () => {
      await withEnv({ QWEN_CODE_MAX_WORKFLOW_AGENTS: '3' }, async () => {
        await expect(
          runWf({
            dispatch: async () => 'ok',
            script: `return await parallel(
              Array.from({ length: 4 }, () => () => agent("x"))
            );`,
          }),
        ).rejects.toThrow(/maximum of 3 agent\(\) calls per run/);
      });
    });
  });
});

// ─── P3 (PR #5xxx): agentType + model + isolation + schema ──────────
// The override path (the fast path is covered above) goes through
// SubagentManager.createAgentHeadless, so each test wires a fake Config whose
// `getSubagentManager()` stub has just enough surface for the path under test.
describe('WorkflowOrchestrator P3 — agentType / model / isolation / schema', () => {
  // mockImplementation persists: reset it so no test's override bleeds over.
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
    config: {
      name?: string;
      model?: string;
      disallowedTools?: string[];
      tools?: string[];
    };
    runtimeContextSame: boolean;
    /** The exact Config the dispatch handed to the runtime agent. */
    runtimeContext: Config;
    /** What the subagent's Config answers for "where am I?". */
    runtimeTargetDir?: string;
    runtimeIgnoreFiles?: string;
    options?: {
      runConfigOverrides?: unknown;
      modelConfigOverrides?: unknown;
      taskName?: string;
      subagentId?: string;
    };
    eventEmitterAttached: boolean;
    executeAgentId?: string | null;
    executeOptions?: { enforceTimeLimitDuringRetryWait?: boolean };
  };

  /** The minimal surface read after createAgentHeadless returns. */
  type SubagentOutcome = {
    finalText: string;
    terminateMode: string;
    // Drives the attached AgentEventEmitter (schema mode listens on it for
    // `structured_output` calls) to simulate the model.
    runWithEmitter?: (
      emitter: Emits,
      signal?: AbortSignal,
    ) => void | Promise<void>;
  };

  /** onCreate for a subagent that ends with `finalText` under `terminateMode`. */
  const ends =
    (finalText: string, terminateMode = 'GOAL') =>
    async (): Promise<SubagentOutcome> => ({ finalText, terminateMode });
  const ok = ends('ok');

  function fakeConfigWithMgr(opts: {
    transcriptDir?: string;
    /** Registry tools beyond the built-ins (always known), e.g. MCP tools. */
    registeredTools?: Array<{ name: string; displayName?: string }>;
    /** Tools MCP discovery registers once `waitForMcpReady` settles. */
    discoveredTools?: Array<{ name: string; displayName?: string }>;
    /** The manager's findSubagentByName. */
    lookup?: (name: string) => Promise<{
      name: string;
      description: string;
      systemPrompt: string;
      level: string;
      tools?: string[];
      disallowedTools?: string[];
      model?: string;
      mcpServers?: Record<string, unknown>;
    } | null>;
    /** Defaults to a subagent that ends GOAL with 'ok'. */
    onCreate?: (call: StubSubagentCall) => Promise<SubagentOutcome>;
  }) {
    const calls: StubSubagentCall[] = [];
    const registeredToolInstances: unknown[] = [];
    let disposed = 0;
    // Schema mode's rebuildToolRegistryOnOverride creates a registry and
    // copies tools into it; the stub only has to not crash.
    const registered = [...(opts.registeredTools ?? [])];
    const fakeRegistry = {
      copyDiscoveredToolsFrom: () => {},
      registerTool: (tool: unknown) => {
        registeredToolInstances.push(tool);
      },
    };
    const cfg = {
      createToolRegistry: async () => fakeRegistry,
      getToolRegistry: () => fakeRegistry,
      waitForMcpReady: vi.fn(async () => {
        registered.push(...(opts.discoveredTools ?? []));
      }),
      // Plan-revision state shaped like Config's: an own field set through
      // `this`, so on an un-shimmed Object.create wrapper the write lands as
      // a shadowing OWN property; the write-through tests assert it doesn't.
      sessionWorkflowPlanRevision: 'approved-revision' as unknown,
      setSessionWorkflowPlanRevision(
        this: Record<string, unknown>,
        revision: unknown,
      ) {
        this['sessionWorkflowPlanRevision'] = revision;
      },
      clearSessionWorkflowPlanRevision(this: Record<string, unknown>) {
        this['sessionWorkflowPlanRevision'] = undefined;
      },
      // Snapshotted by the approval profile layered over derived contexts.
      getApprovalMode: () => 'default' as ApprovalMode,
      isTrustedFolder: () => true,
      // P3 R2 self-review: read by isolation:'worktree' provisioning.
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
        findSubagentByName: opts.lookup ?? (async () => null),
        // Like the real manager over built-ins + `registeredTools`: MCP names
        // are exempt unless checkMcpNames, built-ins match, anything else
        // needs a registered name or display name. (The schema-deny refusal
        // resolves names itself.)
        findUnmatchedToolNames: async (
          names: string[],
          options: { checkMcpNames?: boolean } = {},
        ) =>
          names.filter(
            (name) =>
              (options.checkMcpNames === true || !name.startsWith('mcp__')) &&
              resolveBuiltinToolName(name) === undefined &&
              !registered.some(
                (tool) => tool.name === name || tool.displayName === name,
              ),
          ),
        // Registered or built-in spellings become tool names; others pass.
        resolveToolNames: async (names: string[]) =>
          names.map(
            (name) =>
              registered.find(
                (tool) => tool.name === name || tool.displayName === name,
              )?.name ??
              resolveBuiltinToolName(name) ??
              name,
          ),
        createAgentHeadless: async (
          subagentConfig: {
            name?: string;
            model?: string;
            disallowedTools?: string[];
          },
          runtimeContext: Config,
          options?: {
            eventEmitter?: unknown;
            runConfigOverrides?: unknown;
            modelConfigOverrides?: unknown;
            taskName?: string;
            subagentId?: string;
          },
        ) => {
          const call: StubSubagentCall = {
            config: subagentConfig,
            runtimeContextSame: runtimeContext === cfg,
            runtimeContext,
            runtimeTargetDir: runtimeContext.getTargetDir(),
            runtimeIgnoreFiles: runtimeContext
              .getFileService?.()
              .getQwenIgnoreFileNamesDisplay(),
            options: {
              runConfigOverrides: options?.runConfigOverrides,
              modelConfigOverrides: options?.modelConfigOverrides,
              taskName: options?.taskName,
              subagentId: options?.subagentId,
            },
            eventEmitterAttached: options?.eventEmitter !== undefined,
          };
          calls.push(call);
          const outcome = await (opts.onCreate ?? ok)(call);
          return {
            subagent: {
              execute: async (
                _ctx: unknown,
                signal?: AbortSignal,
                executeOptions?: { enforceTimeLimitDuringRetryWait?: boolean },
              ): Promise<void> => {
                const { getCurrentAgentId } = await import(
                  './agent-context.js'
                );
                call.executeAgentId = getCurrentAgentId();
                call.executeOptions = executeOptions;
                if (outcome.runWithEmitter && options?.eventEmitter) {
                  await outcome.runWithEmitter(
                    options.eventEmitter as Emits,
                    signal,
                  );
                }
                // R3 (wenshao #6): the real execute() throw, on this path too.
                if (nextExecuteThrow.value) throw nextExecuteThrow.value;
              },
              getFinalText: () => outcome.finalText,
              getTerminateMode: () => outcome.terminateMode,
              // R1 (#1): reportTokens reads it in every mode, including the
              // schema early return (Critical #1) and failures (Critical #3).
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
      registeredToolInstances,
      get disposed() {
        return disposed;
      },
    };
  }

  type MgrOpts = Parameters<typeof fakeConfigWithMgr>[0];
  type AgentOpts = Parameters<WorkflowAgentDispatch>[1];
  type DispatchArgs =
    Parameters<typeof createProductionDispatch> extends [Config, ...infer R]
      ? R
      : never;

  /** Builds a manager-backed config and dispatches `prompt` once through it. */
  function dispatchVia(
    mgrOpts: MgrOpts,
    prompt: string,
    opts: AgentOpts,
    ...args: DispatchArgs
  ) {
    const mgr = fakeConfigWithMgr(mgrOpts);
    return Object.assign(mgr, {
      result: createProductionDispatch(mgr.config, ...args)(prompt, opts),
    });
  }

  /** dispatchVia, settled: `value` is what the dispatch resolved to. */
  async function dispatched(
    mgrOpts: MgrOpts,
    prompt: string,
    opts: AgentOpts,
    ...args: DispatchArgs
  ) {
    const mgr = dispatchVia(mgrOpts, prompt, opts, ...args);
    return Object.assign(mgr, { value: await mgr.result });
  }

  /** dispatchVia, refused with `message` before any subagent is created. */
  async function expectRefused(
    mgrOpts: MgrOpts,
    prompt: string,
    opts: AgentOpts,
    message: RegExp | string,
  ) {
    const mgr = dispatchVia(mgrOpts, prompt, opts);
    await expect(mgr.result).rejects.toThrow(message);
    expect(mgr.calls).toHaveLength(0);
    return mgr;
  }

  /** A findSubagentByName resolving every name to this definition. */
  const defines =
    (
      name: string,
      description: string,
      systemPrompt: string,
      level: string,
      extra: {
        tools?: string[];
        disallowedTools?: string[];
        mcpServers?: Record<string, unknown>;
        executor?: unknown;
        executionBackend?: 'container';
      } = {},
    ) =>
    async () => ({ name, description, systemPrompt, level, ...extra });

  /** Emits a structured_output call in `round` and its result. */
  function emitStructuredOutput(
    emitter: Emits,
    round: number,
    args: Record<string, unknown>,
    success = true,
    resultAt = round,
  ) {
    const call = {
      subagentId: 'sub',
      round,
      callId: `c${round}`,
      name: 'structured_output',
    };
    emitter.emit('tool_call', {
      ...call,
      args,
      description: '',
      isOutputMarkdown: false,
      timestamp: round,
    });
    emitter.emit('tool_result', {
      ...call,
      success,
      ...(success ? {} : { error: 'validation failed' }),
      responseParts: [],
      resultDisplay: '',
      durationMs: 1,
      timestamp: resultAt,
    });
  }

  /**
   * onCreate for a schema agent: one structured_output call per round
   * ([args, success = true, result timestamp = round]), then CANCELLED, as a
   * schema dispatch ends once it captures a result or gives up.
   */
  const answersSchema =
    (...rounds: Array<[Record<string, unknown>, boolean?, number?]>) =>
    async () => ({
      finalText: '',
      terminateMode: 'CANCELLED',
      runWithEmitter: (emitter: Emits) =>
        rounds.forEach(([args, success, resultAt], i) =>
          emitStructuredOutput(emitter, i + 1, args, success, resultAt),
        ),
    });

  const FLOOR = [
    'ask_user_question',
    'send_message',
    'monitor',
    'enter_plan_mode',
    'exit_plan_mode',
    'agent',
  ];

  it.each([
    `agent('review work', args)`,
    `parallel([() => agent('review work', args)])`,
    `pipeline(['review work'], (_previous, prompt) => agent(prompt, args))`,
  ])(
    'refuses a container definition before workflow worktree or runtime creation: %s',
    async (expression) => {
      const onCreate = vi.fn(ends('host execution must not start'));
      const lookup = vi.fn(
        defines(
          'contained-reviewer',
          'Container reviewer',
          'Review the work.',
          'user',
          { executionBackend: 'container' },
        ),
      );
      const { config, calls } = fakeConfigWithMgr({
        lookup,
        onCreate,
      });
      const createRegistry = vi.spyOn(config, 'createToolRegistry');

      await expect(
        runWf({
          dispatch: createProductionDispatch(config),
          script: `return await ${expression};`,
          args: {
            agentType: 'contained-reviewer',
            isolation: 'worktree',
            schema: { type: 'object' },
          },
        }),
      ).rejects.toThrow('workflow agents are unsupported');

      expect(lookup).toHaveBeenCalledOnce();
      expect(calls).toHaveLength(0);
      expect(onCreate).not.toHaveBeenCalled();
      expect(createRegistry).not.toHaveBeenCalled();
      expect(worktreeStubs.instances).toHaveLength(0);
    },
  );

  it.each([
    { label: 'plain', options: {}, tokenLimit: null },
    { label: 'budgeted', options: {}, tokenLimit: 100 },
    {
      label: 'schema',
      options: { schema: { type: 'object' } },
      tokenLimit: null,
    },
    {
      label: 'budgeted schema',
      options: { schema: { type: 'object' } },
      tokenLimit: 100,
    },
    {
      label: 'worktree',
      options: { isolation: 'worktree' as const },
      tokenLimit: null,
    },
    {
      label: 'pinned worktree',
      options: { workingDir: '/fake/repo/worktree' },
      tokenLimit: null,
    },
  ])(
    'rejects $label external workflow dispatch before agent creation',
    async ({ options, tokenLimit }) => {
      const budget = budgetOf(tokenLimit);
      const onTokens = vi.fn((tokens: number) => budget.recordSpent(tokens));
      const onCreate = vi.fn(ends('external output'));
      const { config, calls } = fakeConfigWithMgr({
        lookup: defines(
          'external-agent',
          'External agent',
          'Complete the task.',
          'session',
          { executor: { kind: 'acp', command: 'external-agent' } },
        ),
        onCreate,
      });
      const createRegistry = vi.spyOn(config, 'createToolRegistry');
      const dispatch = createProductionDispatch(config, undefined, onTokens);

      await expect(
        dispatch('do work', { agentType: 'external-agent', ...options }),
      ).rejects.toThrow(
        'Workflow agent() does not support external-executor agents: ' +
          'token budgets, schema output, and workflow tool restrictions ' +
          'cannot be enforced. Use an in-process agent definition instead.',
      );

      // The manager owns external factory/process creation; never enter it.
      expect(calls).toEqual([]);
      expect(onCreate).not.toHaveBeenCalled();
      expect(createRegistry).not.toHaveBeenCalled();
      expect(worktreeStubs.instances).toHaveLength(0);
      expect(pinStub.seenLabels).toEqual([]);
      expect(onTokens).not.toHaveBeenCalled();
    },
  );

  it('continues to account tokens for an in-process workflow agent', async () => {
    const budget = budgetOf(100);
    const previousTokens = nextOutputTokens.value;
    nextOutputTokens.value = 25;
    try {
      const { calls, result } = dispatchVia(
        {
          lookup: defines(
            'ordinary-agent',
            'In-process agent',
            'Complete the task.',
            'session',
          ),
          onCreate: ends('done'),
        },
        'do work',
        { agentType: 'ordinary-agent' },
        undefined,
        (tokens) => budget.recordSpent(tokens),
      );
      await expect(result).resolves.toBe('done');
      expect(calls).toHaveLength(1);
      expect(budget.remaining()).toBe(75);
    } finally {
      nextOutputTokens.value = previousTokens;
    }
  });

  it('agentType resolves SubagentConfig and routes through createAgentHeadless', async () => {
    const { calls, value } = await dispatched(
      {
        lookup: defines(
          'Explore',
          'fast read-only',
          'You are Explore.',
          'builtin',
          { tools: ['Read', 'Grep'], disallowedTools: [] },
        ),
        onCreate: ends('explore-output'),
      },
      'find foo',
      { agentType: 'Explore', label: 'explore-1' },
    );
    expect(value).toBe('explore-output');
    expect(calls).toHaveLength(1);
    expect(calls[0].config.name).toBe('Explore');
    expect(calls[0].executeAgentId).toMatch(/^workflow-agent-[0-9a-f]{16}$/);
    expect(calls[0].options?.taskName).toBe('find foo');
    expect(calls[0].options?.subagentId).toBe(calls[0].executeAgentId);
    expect(calls[0].executeOptions).toEqual({
      enforceTimeLimitDuringRetryWait: true,
    });
    // The workflow floor must be unioned in.
    expect(calls[0].config.disallowedTools).toEqual(
      expect.arrayContaining(FLOOR),
    );
  });

  /**
   * dispatchVia with transcripts in a temp dir: returns the calls and the
   * records of the one transcript left. `settle` observes the dispatch.
   */
  async function transcriptOf(
    mgrOpts: MgrOpts,
    prompt: string,
    opts: AgentOpts,
    settle: (result: Promise<unknown>) => Promise<unknown> = (r) => r,
  ) {
    const transcriptDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'wf-override-transcript-'),
    );
    try {
      const { calls, result } = dispatchVia(
        { transcriptDir, ...mgrOpts },
        prompt,
        opts,
      );
      await settle(result);
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
      return { calls, records };
    } finally {
      fs.rmSync(transcriptDir, { recursive: true, force: true });
    }
  }

  it('records override-path events in the workflow transcript', async () => {
    const { calls, records } = await transcriptOf(
      {
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
      },
      'override prompt',
      { model: 'override-model' },
    );
    expect(records).toHaveLength(2);
    expect(records[1]!['parentUuid']).toBe(records[0]!['uuid']);
    expect(records[1]!['agentId']).toBe(records[0]!['agentId']);
    expect(calls[0]!.executeAgentId).toBe(records[0]!['agentId']);
  });

  // Case-insensitive, like the real SubagentManager lookup.
  const codeReviewer = async (name: string) =>
    name.toLowerCase() === 'code-reviewer'
      ? {
          name: 'code-reviewer',
          description: 'reviews chunks',
          systemPrompt: 'You review code.',
          level: 'session',
        }
      : null;

  // agentName, the only human-readable identity left on disk, is the resolved
  // canonical name the agent runs under: not the default, not the script's
  // raw spelling (the lookup is case-insensitive).
  it('records the agentType name in the transcript for an unlabeled override dispatch', async () => {
    const { calls, records } = await transcriptOf(
      { lookup: codeReviewer, onCreate: ends('review-output') },
      'review chunk 1 of 3',
      { agentType: 'Code-Reviewer' },
    );
    expect(calls[0]!.config.name).toBe('code-reviewer');
    expect(records[0]!['agentName']).toBe('code-reviewer');
  });

  // A label cannot rename a resolved agentType, or a labeled fan-out's
  // records could not be correlated by agentName with AgentTool launches of
  // the same agentType.
  it('stamps the resolved agentType name in the transcript when a label is also set', async () => {
    const { calls, records } = await transcriptOf(
      { lookup: codeReviewer, onCreate: ends('review-output') },
      'review chunk 1 of 3',
      { agentType: 'Code-Reviewer', label: 'chunk-1' },
    );
    expect(calls[0]!.config.name).toBe('code-reviewer');
    expect(records[0]!['agentName']).toBe(calls[0]!.config.name);
  });

  // resolveWorkflowAgentIdentity hands its result to the override path; a
  // second findSubagentByName is an uncached directory read + frontmatter
  // parse on the hot path, again per stall retry.
  it('resolves the agentType once per dispatch instead of per path', async () => {
    const lookup = vi.fn(async (name: string) =>
      name === 'Explore'
        ? {
            name: 'Explore',
            description: 'fast read-only',
            systemPrompt: 'You are Explore.',
            level: 'builtin',
          }
        : null,
    );
    await dispatched({ lookup, onCreate: ends('done') }, 'find foo', {
      agentType: 'Explore',
    });
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  // The identity invariant's third leg: an ephemeral override runs, and is
  // recorded, under its display name, not as an unlabeled runtime agent.
  it('runs a labeled model-only override under the label and records it in the transcript', async () => {
    const { calls, records } = await transcriptOf(
      { onCreate: ends('model-output') },
      'probe task',
      { label: 'labeled-model', model: 'm' },
    );
    expect(calls[0]!.config.name).toBe('labeled-model');
    expect(records[0]!['agentName']).toBe('labeled-model');
  });

  // resolveWorkflowAgentIdentity's truthy check: the dispatch still throws,
  // but the transcript seeded first records the default, not ''.
  it('never records a blank identity for an empty agentType', async () => {
    const { records } = await transcriptOf(
      { lookup: async () => null, onCreate: ends('') },
      'task',
      { agentType: '' },
      (result) => expect(result).rejects.toThrow(/agent type '' not found/),
    );
    expect(records[0]!['agentName']).toBe('workflow-agent');
  });

  // The stall error interpolates the display name; a model-authored
  // definition can register 'rev\n' raw (validateName checks the TRIMMED
  // name), and must not fragment the single-line error.
  it('sanitizes control characters out of the agentType stall error', async () => {
    const { result } = dispatchVia(
      {
        lookup: async (name) =>
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
          runWithEmitter: (emitter, signal) =>
            stallUntilAborted(emitter, signal, 'sub', 'p1'),
        }),
      },
      'doomed',
      { agentType: 'rev\n', stallMs: 5 },
    );
    const error: unknown = await result.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain('\n');
    expect((error as Error).message).toContain(
      'agent "rev" stalled on all 3 attempts',
    );
  });

  it('strips internal tags from override-path final text', async () => {
    const { result } = dispatchVia(
      {
        lookup: defines(
          'Explore',
          'fast read-only',
          'You are Explore.',
          'builtin',
        ),
        onCreate: ends(
          '<analysis>scratch</analysis><summary>clean result</summary>',
        ),
      },
      'find foo',
      { agentType: 'Explore' },
    );
    await expect(result).resolves.toBe('clean result');
  });

  it('agentType not found throws upstream-aligned error', async () => {
    const { result } = dispatchVia({ lookup: async () => null }, 'whatever', {
      agentType: 'NotARealAgent',
    });
    await expect(result).rejects.toThrow(
      /^agent\(\{agentType\}\): agent type 'NotARealAgent' not found\.$/,
    );
  });

  it('opts.model is threaded into SubagentConfig.model for provider routing', async () => {
    const { calls } = await dispatched({}, 'hi', { model: 'qwen3-max' });
    // No agentType → ephemeral default config built, then opts.model applied.
    expect(calls[0].config.model).toBe('qwen3-max');
  });

  // The fast-path sibling's wiring guard, for the override dispatch site.
  it('override-path dispatch honors the env-tunable subagent bounds', async () => {
    await withEnv(
      {
        QWEN_CODE_WORKFLOW_AGENT_MAX_TURNS: '120',
        QWEN_CODE_WORKFLOW_AGENT_MAX_MINUTES: '45',
      },
      async () => {
        const helper = await dispatched({}, 'hi', { model: 'qwen3-max' });
        expect(helper.calls[0]!.options?.runConfigOverrides).toEqual({
          max_turns: 120,
          max_time_minutes: 45,
        });
      },
    );
  });

  it('override dispatch carries host review bounds into the agent', async () => {
    const helper = await dispatched(
      {},
      'review',
      { model: 'qwen3-max' },
      undefined,
      undefined,
      undefined,
      { max_turns: 500, max_time_minutes: 100 },
    );
    expect(helper.calls[0]!.options?.runConfigOverrides).toEqual({
      max_turns: 500,
      max_time_minutes: 100,
    });
  });

  it("isolation:'remote' throws upstream-aligned 'not available' error", async () => {
    await expect(
      dispatchVia({}, 'hi', { isolation: 'remote' }).result,
    ).rejects.toThrow(
      /agent\(\{isolation:'remote'\}\) is not available in this build\./,
    );
  });

  it('floor disallowedTools always unioned (agentType cannot re-enable them)', async () => {
    // An agentType cannot re-enable what workflow forbids.
    const { calls } = await dispatched(
      {
        lookup: defines(
          'Permissive',
          'tries to override floor',
          'permissive prompt',
          'project',
          { disallowedTools: ['Foo'] },
        ),
      },
      'hi',
      { agentType: 'Permissive' },
    );
    // Union: Foo (from agentType) + workflow-only floor.
    expect(calls[0].config.disallowedTools ?? []).toEqual(
      expect.arrayContaining(['Foo', ...FLOOR]),
    );
  });

  // effort needs the agent's own content-generator config (override path
  // only), as a per-agent override, never a session change.
  it('routes effort through the override path as a per-agent model override', async () => {
    const { calls, value } = await dispatched(
      { onCreate: ends('done') },
      'hi',
      { effort: 'low' },
    );
    expect(value).toBe('done');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.options?.modelConfigOverrides).toEqual({
      reasoningEffort: 'low',
    });
    expect(calls[0]!.config.model).toBeUndefined();
  });

  it('sends no model-config override when effort is omitted', async () => {
    const { calls } = await dispatched({}, 'hi', { model: 'qwen3-max' });
    expect(calls[0]!.options?.modelConfigOverrides).toBeUndefined();
  });

  // A host caller dispatching directly gets the sandbox's normalization.
  it('normalizes a host-supplied effort alias and refuses an unknown tier', async () => {
    const { config, calls } = fakeConfigWithMgr({});
    const dispatch = createProductionDispatch(config);
    await dispatch('hi', { effort: 'X-High' as unknown as 'xhigh' });
    expect(calls[0]!.options?.modelConfigOverrides).toEqual({
      reasoningEffort: 'xhigh',
    });
    await expect(
      dispatch('hi', { effort: 'turbo' as unknown as 'low' }),
    ).rejects.toThrow(/agent\(\{effort\}\): unknown effort tier "turbo"/);
    expect(calls).toHaveLength(1);
  });

  it('unions per-call disallowedTools with the agentType denies and the floor', async () => {
    const { calls } = await dispatched(
      {
        lookup: defines('Scanner', 'read-only scan', 'scan prompt', 'project', {
          disallowedTools: ['Foo'],
        }),
      },
      'scan',
      { agentType: 'Scanner', disallowedTools: ['Shell', 'write_file'] },
    );
    const disallowed = calls[0]!.config.disallowedTools ?? [];
    // The built-in display name arrives as its tool name.
    expect(disallowed).toEqual(
      expect.arrayContaining([
        'Foo',
        'run_shell_command',
        'write_file',
        ...FLOOR,
      ]),
    );
    expect(new Set(disallowed).size).toBe(disallowed.length);
  });

  it('routes disallowedTools alone through the override path', async () => {
    const { calls } = await dispatched({}, 'scan', {
      disallowedTools: ['edit'],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.config.disallowedTools).toEqual(
      expect.arrayContaining(['edit', 'agent', 'ask_user_question']),
    );
  });

  // A schema agent answers only through structured_output: denying it, by
  // either name and without the registry's help, is refused before spawning.
  it.each([['structured_output'], ['StructuredOutput']])(
    'refuses a schema agent that denies %s before spawning',
    async (name) => {
      await expectRefused(
        {},
        'extract',
        { schema: { type: 'object' }, disallowedTools: [name] },
        /schema mode needs the structured_output tool, but disallowedTools deny it/,
      );
    },
  );

  it('refuses a schema agent whose agent type denies structured_output', async () => {
    await expectRefused(
      {
        lookup: defines('Scanner', 'scan', 'scan prompt', 'project', {
          disallowedTools: ['StructuredOutput'],
        }),
      },
      'extract',
      { agentType: 'Scanner', schema: { type: 'object' } },
      /schema mode needs the structured_output tool/,
    );
  });

  // A deny matching nothing would leave the tool the script meant to remove.
  it('refuses a deny entry that matches no tool before spawning', async () => {
    await expectRefused(
      {},
      'scan',
      { disallowedTools: ['Bash', 'edit'] },
      /"Bash" matches no tool/,
    );
  });

  it('accepts MCP deny patterns', async () => {
    const { calls } = await dispatched({}, 'scan', {
      disallowedTools: ['mcp__github', 'mcp__slack__*'],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.config.disallowedTools).toEqual(
      expect.arrayContaining(['mcp__github', 'mcp__slack__*']),
    );
  });

  // Re-checked for callers bypassing the sandbox: a bare string would spread
  // into characters, a padded name deny nothing.
  it.each([
    ['a bare string', 'write_file'],
    ['a padded name', [' edit']],
  ])(
    'refuses a host-supplied deny list that is %s before spawning',
    async (_label, disallowedTools) => {
      await expectRefused(
        {},
        'scan',
        { disallowedTools: disallowedTools as unknown as string[] },
        /must be an array of non-empty tool-name strings/,
      );
    },
  );

  describe('tools allowlist', () => {
    const warehouse = [
      {
        name: 'mcp__warehouse__query',
        displayName: 'query (warehouse MCP Server)',
      },
    ];
    const db = defines('Db', 'db agent', 'db', 'project', {
      mcpServers: { agentdb: { command: 'agentdb' } },
    });

    it('narrows the agent to the named tools and leaves execution to its declarations', async () => {
      const { calls } = await dispatched({}, 'scan', {
        tools: ['run_shell_command', 'ReadFile'],
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.config.tools).toEqual([
        'run_shell_command',
        'read_file',
      ]);
      expect(calls[0]!.config).not.toHaveProperty('executionAllowedTools');
    });

    // Denies apply after the allowlist, so a floor tool stays out.
    it('never brings back a floor tool', async () => {
      const { calls } = await dispatched({}, 'scan', {
        tools: ['agent', 'ask_user_question', 'read_file'],
      });
      expect(calls[0]!.config.tools).toEqual(['read_file']);
      expect(calls[0]!.config.disallowedTools).toEqual(
        expect.arrayContaining(['agent', 'ask_user_question']),
      );
    });

    it.each([
      [
        'bounds the list by the agent type allowlist, each side named by display name',
        {
          registeredTools: warehouse,
          lookup: defines('Analyst', 'analysis', 'analyse', 'project', {
            tools: ['ReadFile', 'query (warehouse MCP Server)'],
          }),
        },
        'analyse',
        {
          agentType: 'Analyst',
          tools: ['read_file', 'Shell', 'mcp__warehouse__query'],
        },
        ['read_file', 'mcp__warehouse__query'],
      ],
      [
        'accepts an MCP tool by display name and hands the agent its tool name',
        { registeredTools: warehouse },
        'analyse',
        { tools: ['query (warehouse MCP Server)'] },
        ['mcp__warehouse__query'],
      ],
      [
        // Those tools exist only in the registry built for the agent.
        'leaves mcp__ names to the agent when its type brings its own MCP servers',
        { lookup: db },
        'query',
        { agentType: 'Db', tools: ['mcp__agentdb__query'] },
        ['mcp__agentdb__query'],
      ],
      [
        // Denies resolve as in the agent's own config, display names included.
        'removes a tool the agent type denies by display name',
        {
          registeredTools: warehouse,
          lookup: defines('Analyst', 'analysis', 'analyse', 'project', {
            disallowedTools: ['query (warehouse MCP Server)'],
          }),
        },
        'analyse',
        { agentType: 'Analyst', tools: ['mcp__warehouse__query', 'read_file'] },
        ['read_file'],
      ],
    ])('%s', async (_title, mgrOpts, prompt, opts, tools) => {
      const { calls } = await dispatched(mgrOpts, prompt, opts);
      expect(calls[0]!.config.tools).toEqual(tools);
    });

    // No tools or '*' means every tool: no bound.
    it.each([
      ['no allowlist', undefined],
      ['an empty allowlist', []],
      ['a wildcard allowlist', ['*']],
    ])(
      'does not bound the list by an agent type with %s',
      async (_label, agentTypeTools) => {
        const { calls } = await dispatched(
          {
            lookup: defines(
              'Open',
              'inherits',
              'open',
              'project',
              agentTypeTools !== undefined ? { tools: agentTypeTools } : {},
            ),
          },
          'scan',
          { agentType: 'Open', tools: ['read_file'] },
        );

        expect(calls[0]!.config.tools).toEqual(['read_file']);
      },
    );

    // The agent type's list is definition-authored and echoed in the refusal.
    it('strips control characters from the lists a refusal echoes', async () => {
      const { result } = dispatchVia(
        {
          lookup: defines('Reader', 'read-only', 'read', 'project', {
            tools: ['Read\u0085File'],
          }),
        },
        'scan',
        { agentType: 'Reader', tools: ['run_shell_command'] },
      );
      const error = (await result.catch((e: unknown) => e)) as Error;
      expect(error.message).toContain('("ReadFile")');
      expect(error.message).not.toMatch(/[\u007f-\u009f]/);
    });

    // Discovery runs in the background; a dispatch racing it must not refuse.
    it.each([['mcp__warehouse__query'], ['query (warehouse MCP Server)']])(
      'waits for MCP discovery before judging %s',
      async (name) => {
        const { config, calls } = await dispatched(
          { discoveredTools: warehouse },
          'analyse',
          { tools: [name] },
        );
        expect(config.waitForMcpReady).toHaveBeenCalledOnce();
        expect(calls[0]!.config.tools).toEqual(['mcp__warehouse__query']);
      },
    );

    it('refuses an MCP name discovery did not register, after waiting for it', async () => {
      const { config } = await expectRefused(
        {},
        'analyse',
        { tools: ['mcp__warehouse__query'] },
        /"mcp__warehouse__query" names no tool/,
      );
      expect(config.waitForMcpReady).toHaveBeenCalledOnce();
    });

    it('does not wait for discovery when every entry is a built-in tool', async () => {
      const { config, calls } = await dispatched({}, 'scan', {
        tools: ['Shell', 'read_file'],
      });
      expect(config.waitForMcpReady).not.toHaveBeenCalled();
      expect(calls).toHaveLength(1);
    });

    // Its own servers' names are judged by its own registry.
    it('does not wait for discovery for names its agent type serves itself', async () => {
      const { config } = await dispatched({ lookup: db }, 'query', {
        agentType: 'Db',
        tools: ['mcp__agentdb__query'],
      });
      expect(config.waitForMcpReady).not.toHaveBeenCalled();
    });

    it('refuses a list that shares no tool with the agent type, naming both as written', async () => {
      await expectRefused(
        {
          lookup: defines('Reader', 'read-only', 'read', 'project', {
            tools: ['ReadFile'],
          }),
        },
        'scan',
        { agentType: 'Reader', tools: ['run_shell_command'] },
        'agent({tools, agentType}): none of "run_shell_command" is among the tools the agent type allows ("ReadFile").',
      );
    });

    it.each([
      ['a name no tool has', ['Bash', 'read_file'], /"Bash" names no tool/],
      [
        'an MCP tool this session does not register',
        ['mcp__warehouse__drop'],
        /"mcp__warehouse__drop" names no tool/,
      ],
    ])('refuses %s before spawning', async (_label, tools, message) => {
      await expectRefused(
        { registeredTools: warehouse },
        'scan',
        { tools },
        message,
      );
    });

    it('refuses a list whose every tool is denied', async () => {
      await expectRefused(
        {},
        'scan',
        { tools: ['WriteFile'], disallowedTools: ['write_file'] },
        /every tool in "write_file" is denied for this agent/,
      );
    });

    it('gives a schema agent structured_output', async () => {
      const { calls, result } = dispatchVia(
        { onCreate: ends('', 'CANCELLED') },
        'extract',
        { schema: { type: 'object' }, tools: ['read_file'] },
      );
      await result.catch(() => undefined);
      expect(calls[0]!.config.tools).toEqual([
        'read_file',
        'structured_output',
      ]);
    });

    // Re-checked for a caller that reaches the dispatch directly.
    it.each([
      [
        'a bare string',
        'read_file',
        /must be a non-empty array of tool-name strings/,
      ],
      ['an empty list', [], /must be a non-empty array of tool-name strings/],
      ['a wildcard', ['*'], /"\*" is a pattern/],
      ['an MCP server', ['mcp__warehouse'], /names a whole MCP server/],
      ['exec', ['exec'], /is the code-mode surface/],
    ])(
      'refuses a host-supplied allowlist that is %s before spawning',
      async (_label, tools, message) => {
        await expectRefused(
          {},
          'scan',
          { tools: tools as unknown as string[] },
          message,
        );
      },
    );

    // Name refusals are decided before any worktree is provisioned.
    it.each([
      ['an unknown name', { tools: ['Bash'] }],
      ['a fully denied list', { tools: ['edit'], disallowedTools: ['edit'] }],
    ])('refuses %s before provisioning a worktree', async (_label, extra) => {
      await expectRefused(
        {},
        'scan',
        { isolation: 'worktree', ...extra },
        /agent\(\{tools\}\)/,
      );
      expect(worktreeStubs.instances).toHaveLength(0);
    });
  });

  // Every option the resume key projects keeps a dispatch off the fast path;
  // sharing the list means a new option cannot be silently ignored there.
  it.each(DISPATCH_AFFECTING_AGENT_OPTS.map((key) => [key]))(
    'keeps a dispatch that sets only %s off the fast path',
    async (key) => {
      const samples: Record<string, unknown> = {
        schema: { type: 'object' },
        model: 'qwen3-max',
        effort: 'low',
        isolation: 'worktree',
        agentType: 'Scanner',
        workingDir: '/nonexistent/worktree',
        disallowedTools: ['edit'],
        tools: ['read_file'],
      };
      expect(samples).toHaveProperty(key);
      const fastPathAgentsBefore = created.length;
      await dispatchVia(
        {
          lookup: defines('Scanner', 'scan', 'scan prompt', 'project'),
        },
        'probe',
        { [key]: samples[key] },
      ).result.catch(() => undefined);
      expect(created.length).toBe(fastPathAgentsBefore);
    },
  );

  // R7-1: the schema wrapper is the second un-shimmed Object.create builder;
  // its revision writes must reach the base, not shadow session state.
  it('schema-mode override writes Session Workflow revision mutations through to the base Config', async () => {
    const { config, calls } = await dispatched(
      { onCreate: answersSchema([{ ok: true }, true, 2]) },
      'extract',
      { schema: { type: 'object', properties: { ok: { type: 'boolean' } } } },
    );
    const runtime = calls[0]!.runtimeContext;
    expect(runtime).not.toBe(config);
    runtime.clearSessionWorkflowPlanRevision();
    expect(Object.hasOwn(runtime, 'sessionWorkflowPlanRevision')).toBe(false);
    expect(
      (config as unknown as Record<string, unknown>)[
        'sessionWorkflowPlanRevision'
      ],
    ).toBeUndefined();
  });

  it('R1 #1: schema-mode SUCCESS records tokens via onTokens (was missing before fix)', async () => {
    nextOutputTokens.value = 555;
    const reports: number[] = [];
    // Schema mode's success path ends in an abort (CANCELLED).
    const { value } = await dispatched(
      { onCreate: answersSchema([{ ok: true, value: 42 }, true, 2]) },
      'extract',
      { schema: { type: 'object', properties: { ok: { type: 'boolean' } } } },
      undefined,
      (tokens) => reports.push(tokens),
    );
    expect(value).toEqual({ ok: true, value: 42 });
    // R1 #1: recorded BEFORE the schema branching, so this path reports too.
    expect(reports).toEqual([555]);
  });

  it('R3 #6: override-path records tokens when execute() THROWS (sibling of fast path)', async () => {
    // wenshao's R3 #6 at the override site (fast path: see above): both wrap
    // execute() in try/finally so tokens survive the ERROR-via-throw path.
    nextExecuteThrow.value = new Error('override-path boom');
    nextOutputTokens.value = 9999;
    const reports: number[] = [];
    const { result } = dispatchVia(
      {
        onCreate: async () => ({
          finalText: '',
          terminateMode: 'GOAL', // execute() throws BEFORE the mode check
          runWithEmitter: () => {},
        }),
      },
      'q1',
      { label: 'thrown', schema: { type: 'object' } },
      undefined,
      (tokens) => reports.push(tokens),
    );
    await expect(result).rejects.toThrow(/override-path boom/);
    expect(reports).toEqual([9999]);
    nextExecuteThrow.value = null;
  });

  it('schema-mode: 3 failed structured_output calls → upstream-aligned terminal error', async () => {
    // The third failed structured_output submission stops the agent.
    const { result } = dispatchVia(
      {
        onCreate: answersSchema(
          [{ bad: 'shape' }, false],
          [{ bad: 'shape' }, false],
          [{ bad: 'shape' }, false],
        ),
      },
      'extract',
      { schema: { type: 'object' } },
    );
    const caught = await result.catch((error) => error);
    expect(isWorkflowAgentFailedError(caught)).toBe(true);
    expect((caught as WorkflowAgentFailedError).kind).toBe(
      'no_structured_output',
    );
    expect(String(caught)).toContain(
      'subagent stopped after 3 failed structured_output submissions without a valid result. Last error: validation failed',
    );
  });

  // R3 review (wenshao T6 [M2]): a plain-text answer (no attempt counted)
  // gets "no validation attempt", NOT the failed-submission wording, which
  // describes a different failure mode.
  it('schema-mode: subagent never calls structured_output → "no validation attempt" terminal', async () => {
    const { result } = dispatchVia(
      { onCreate: ends('plain-text answer the script will discard') },
      'extract',
      { schema: { type: 'object' } },
    );
    await expect(result).rejects.toThrow(
      /subagent completed without calling structured_output \(no validation attempt — model produced plain-text content\)\./,
    );
  });

  it('schema-mode attaches an event emitter to the subagent', async () => {
    const { calls } = await dispatched(
      { onCreate: answersSchema([{ ok: true }, true, 2]) },
      'extract',
      { schema: { type: 'object' } },
    );
    expect(calls[0].eventEmitterAttached).toBe(true);
  });

  // R1 self-review (P3-T6 gap): the `state.result === null` guard lets the
  // model RECOVER. Only 0 and 3+ failures were tested; inverting the guard,
  // or pendingArgs cleanup dropping recovered args, would slip past.
  it.each([
    [
      'schema-mode: subagent calls structured_output successfully → returns validated args',
      answersSchema([{ ok: true, value: 42 }, true, 2]),
      { type: 'object', properties: { ok: { type: 'boolean' } } },
      { ok: true, value: 42 },
    ],
    [
      // Round 2's corrected args are the result, not round 1's.
      'schema-mode: success on 2nd attempt (1 failure then valid) captures round-2 args',
      answersSchema([{ bad: 'shape' }, false], [{ ok: true, attempt: 2 }]),
      { type: 'object' },
      { ok: true, attempt: 2 },
    ],
    [
      'schema-mode: success on 3rd attempt (2 failures then valid) captures round-3 args',
      answersSchema(
        [{ bad: 1 }, false],
        [{ bad: 2 }, false],
        [{ ok: true, attempt: 3 }],
      ),
      { type: 'object' },
      { ok: true, attempt: 3 },
    ],
  ])('%s', async (_title, onCreate, schema, expected) => {
    const { value } = await dispatched({ onCreate }, 'extract', { schema });
    expect(value).toEqual(expected);
  });

  // R1 self-review (P3-T6 gap): composed, since a floor made conditional on
  // schema (the union inside `if (opts.schema === undefined)`) would pass
  // the separate tests.
  it('schema-mode + agentType: floor disallowedTools still unioned', async () => {
    const { calls } = await dispatched(
      {
        lookup: defines(
          'Permissive',
          'allows SendMessage explicitly',
          'permissive',
          'project',
          { disallowedTools: ['Foo'] },
        ),
        onCreate: answersSchema([{ ok: true }]),
      },
      'extract',
      { agentType: 'Permissive', schema: { type: 'object' } },
    );
    expect(calls[0].config.disallowedTools ?? []).toEqual(
      expect.arrayContaining(['Foo', ...FLOOR]),
    );
  });

  // R1 self-review (P3-T6 gap): the `if (signal?.aborted)` check keeps
  // user-cancelled schema runs from reading as schema failures.
  it('schema-mode: caller abort takes priority over terminal "no structured_output" error', async () => {
    const externalAbort = new AbortController();
    const { result } = dispatchVia(
      {
        onCreate: async () => ({
          finalText: '',
          terminateMode: 'CANCELLED',
          // Aborted with state.result still null: AbortError must win.
          runWithEmitter: () => {
            externalAbort.abort();
          },
        }),
      },
      'extract',
      { schema: { type: 'object' } },
      externalAbort.signal,
    );
    await expect(result).rejects.toThrow(/aborted/i);
  });

  // R1 self-review (P3-T6 gap): dispose() runs in a finally so per-agent MCP
  // processes / hooks never leak, whether the dispatch succeeds or not.
  it('override path always calls dispose() on the success path', async () => {
    // Model-only: no agentType resolution, still createAgentHeadless.
    const helper = await dispatched({ onCreate: ends('done') }, 'hi', {
      model: 'qwen3-max',
    });
    expect(helper.disposed).toBeGreaterThanOrEqual(1);
  });

  it('override path always calls dispose() even when terminateMode is non-GOAL', async () => {
    // non-GOAL → the dispatch throws after execute
    const helper = dispatchVia({ onCreate: ends('', 'ERROR') }, 'hi', {
      model: 'qwen3-max',
    });
    await expect(helper.result).rejects.toThrow(/terminate mode: ERROR/);
    expect(helper.disposed).toBeGreaterThanOrEqual(1);
  });

  // R2 self-review (sec-2): a model-authored agentType must not fragment a
  // single-line error across log records.
  it('agentType not found: control chars in name are scrubbed from the error message', async () => {
    // newline + nul + del: control codes < 0x20 or == 0x7f.
    const evil = 'Explore\n\rEvil\x00\x7f';
    const error = await rejectionOf(
      dispatchVia({ lookup: async () => null }, 'hi', {
        agentType: evil,
      }).result,
    );
    expect(error).toBeInstanceOf(Error);
    const msg = (error as Error).message;
    // The message must NOT contain raw newlines / NULs.
    // eslint-disable-next-line no-control-regex
    expect(msg).not.toMatch(/[\n\r\u0000\u007f]/);
    expect(msg).toContain('not found');
  });

  // R2 self-review (test-5): the thrown-from-execute branch (schema-mode
  // failure path), which the non-GOAL case above does not reach.
  it('override path: dispose() still runs in finally when execute throws', async () => {
    const helper = dispatchVia(
      {
        onCreate: async () => ({
          finalText: '',
          terminateMode: 'GOAL', // not reached
          runWithEmitter: () => {
            throw new Error('simulated subagent failure');
          },
        }),
      },
      'extract',
      { schema: { type: 'object' } },
    );
    await expect(helper.result).rejects.toThrow(/simulated subagent failure/);
    expect(helper.disposed).toBeGreaterThanOrEqual(1);
  });

  // ─── workingDir: pin to a caller-owned worktree ─────────────────

  const PINNED = { workingDir: '.qwen/tmp/review-pr-7' };

  // The fast path cannot rebind a directory: `workingDir` would be dropped
  // and the agent run in the parent tree, the failure it exists to prevent.
  it('workingDir forces the override path even with no agentType/model/schema', async () => {
    created.length = 0;
    const helper = dispatchVia({ onCreate: ends('pinned') }, 'hi', PINNED);
    await expect(helper.result).resolves.toBe('pinned');
    // Went through SubagentManager, not the fast path's AgentHeadless.create.
    expect(helper.calls).toHaveLength(1);
    expect(created).toHaveLength(0);
  });

  it('workingDir rebinds the subagent runtime context to the pinned directory', async () => {
    const helper = await dispatched({ onCreate: ends('pinned') }, 'hi', PINNED);
    // Not the parent's '/fake/repo': its tools resolve inside the worktree.
    expect(helper.calls[0]!.runtimeTargetDir).toBe(
      '/fake/repo/.qwen/tmp/review-pr-7',
    );
    expect(helper.calls[0]!.runtimeContextSame).toBe(false);
    expect(helper.calls[0]!.runtimeIgnoreFiles).toContain('.cursorignore');
  });

  /** Revision mutations reach `base`, with no own shadow on the wrapper. */
  function expectRevisionWriteThrough(
    base: Config,
    runtime: Config,
    sentinel: SessionWorkflowPlanRevision,
  ) {
    expect(runtime).not.toBe(base);
    runtime.setSessionWorkflowPlanRevision(sentinel);
    runtime.clearSessionWorkflowPlanRevision();
    expect(Object.hasOwn(runtime, 'sessionWorkflowPlanRevision')).toBe(false);
    const state = base as unknown as Record<string, unknown>;
    expect(state['sessionWorkflowPlanRevision']).toBeUndefined();
    runtime.setSessionWorkflowPlanRevision(sentinel);
    expect(state['sessionWorkflowPlanRevision']).toBe(sentinel);
    expect(Object.hasOwn(runtime, 'sessionWorkflowPlanRevision')).toBe(false);
  }

  // R7-1: todo_write is allowed, and a divergent one clears the revision on
  // the wrapper. Unshimmed, that lands as an OWN property and the root keeps
  // rejecting top-level Agent launches against a plan that no longer exists.
  it('workingDir override writes Session Workflow revision mutations through to the base Config', async () => {
    const helper = await dispatched({ onCreate: ends('pinned') }, 'hi', PINNED);
    expectRevisionWriteThrough(helper.config, helper.calls[0]!.runtimeContext, {
      planId: 'plan-1',
      sourceCallId: 'call-1',
      todoIds: ['t1'],
    });
  });

  // R7-1 sibling: the same contract for the isolation-worktree wrapper.
  it("isolation:'worktree' override writes Session Workflow revision mutations through to the base Config", async () => {
    const helper = await dispatched({ onCreate: ends('isolated') }, 'hi', {
      isolation: 'worktree',
    });
    expectRevisionWriteThrough(helper.config, helper.calls[0]!.runtimeContext, {
      planId: 'plan-isolated',
      sourceCallId: 'call-isolated',
      todoIds: ['t1'],
    });
  });

  it.each([
    ['workingDir rejects invalid values before dispatch', ''],
    ['workingDir rejects whitespace-only values at the entrance', '  '],
  ])('%s', async (_title, workingDir) => {
    await expectRefused(
      {},
      'hi',
      { workingDir },
      /workingDir.*non-empty string/,
    );
  });

  // The sandbox gate reads raw opts before JSON revival, which a getter can
  // evade; this refusal sees the revived object. Otherwise isolation would
  // silently win, against AgentTool's working_dir-wins rule.
  it('workingDir + isolation throws instead of letting one silently win', async () => {
    await expectRefused(
      {},
      'hi',
      { ...PINNED, isolation: 'worktree' },
      /incompatible options/,
    );
    expect(worktreeStubs.instances).toHaveLength(0);
  });

  // A refused pin must not fall through to an agent in the parent tree.
  it('workingDir surfaces the resolver refusal and dispatches nothing', async () => {
    pinStub.resolve.value = async () => ({
      error: 'workingDir "x" is not a registered linked worktree.',
    });
    await expectRefused(
      {},
      'hi',
      { workingDir: 'not-a-worktree' },
      /agent\(\{workingDir: "not-a-worktree"\}\).*not a registered linked worktree/,
    );
  });

  // Both interpolated halves: the resolver's error, and the echoed
  // `workingDir`, where JSON.stringify escapes only C0, not DEL or C1 (NEL).
  it.each([
    [
      'workingDir scrubs control characters from resolver errors',
      'refused\r\nforged\u0000line',
      'not-a-worktree',
      ['\r', '\n', '\u0000'],
    ],
    [
      'workingDir refusal scrubs control characters from the echoed workingDir',
      'not a registered linked worktree.',
      'x\u0085forged\u007fline',
      ['\u0085', '\u007f'],
    ],
  ])('%s', async (_title, error, workingDir, forbidden) => {
    pinStub.resolve.value = async () => ({ error });
    const helper = dispatchVia({}, 'hi', { workingDir });
    const caught = await rejectionOf(helper.result);
    expect(caught).toBeInstanceOf(Error);
    for (const char of forbidden) {
      expect((caught as Error).message).not.toContain(char);
    }
    expect(helper.calls).toHaveLength(0);
  });

  // A workflow script never wrote `working_dir`; errors name its own opt.
  it('names the workflow opt, not the tool parameter, when resolving', async () => {
    await dispatched({}, 'hi', { workingDir: 'wt' });
    expect(pinStub.seenLabels).toEqual(['workingDir']);
  });

  // ─── isolation:'worktree' provision error branches ──────────────
  // R2 self-review (test-1, [critical]): these branches were covered only by
  // the E2E S7 happy path; each test stubs the method controlling one.

  /** Gives each new GitWorktreeService stub `overrides()` over the defaults. */
  async function stubWorktree(overrides: () => Record<string, unknown>) {
    const { GitWorktreeService } = await import(
      '../../services/gitWorktreeService.js'
    );
    vi.mocked(GitWorktreeService).mockImplementation(
      () =>
        ({
          ...worktreeStubs.makeStub(),
          ...overrides(),
        }) as unknown as InstanceType<typeof GitWorktreeService>,
    );
  }
  const isolated = (mgrOpts: MgrOpts = {}) =>
    dispatchVia(mgrOpts, 'hi', { isolation: 'worktree' });

  it("isolation:'worktree' refuses when parent cwd is already inside a worktree", async () => {
    const { config } = fakeConfigWithMgr({});
    // A target dir that looks nested-worktree-ish.
    (config as unknown as { getTargetDir: () => string }).getTargetDir = () =>
      '/some/repo/.qwen/worktrees/agent-existing/inner';
    await expect(
      createProductionDispatch(config)('hi', { isolation: 'worktree' }),
    ).rejects.toThrow(/already inside a worktree/);
  });

  it.each([
    [
      "isolation:'worktree' refuses when git is not available",
      () => ({
        checkGitAvailable: vi.fn(async () => ({
          available: false,
          error: 'git binary missing',
        })),
      }),
      /git binary missing/,
    ],
    [
      "isolation:'worktree' refuses when cwd is not a git repository",
      () => ({ isGitRepository: vi.fn(async () => false) }),
      /not a git repository/,
    ],
    [
      "isolation:'worktree' refuses when parent working tree is dirty",
      () => ({ hasWorktreeChanges: vi.fn(async () => true) }),
      /uncommitted changes/,
    ],
    [
      "isolation:'worktree' surfaces createUserWorktree failure",
      () => ({
        createUserWorktree: vi.fn(async () => ({
          success: false,
          error: 'simulated worktree create failure',
        })),
      }),
      /simulated worktree create failure/,
    ],
  ])('%s', async (_title, overrides, message) => {
    await stubWorktree(overrides);
    await expect(isolated().result).rejects.toThrow(message);
  });

  // ─── isolation:'worktree' cleanup error branches ────────────────
  // R2 self-review (test-2, [major]): each removeUserWorktree outcome yields
  // its own preserved suffix, and none was tested.

  it.each([
    [
      "isolation:'worktree' cleanup: removeUserWorktree failure preserves path+branch",
      () => ({
        // Clean on both checks, so cleanup reaches the failing remove.
        hasWorktreeChanges: vi
          .fn(async () => false)
          .mockImplementation(async () => false),
        removeUserWorktree: vi.fn(async () => ({
          success: false,
          error: 'simulated remove failure',
        })),
      }),
      [/\[worktree preserved:.*\(branch worktree-agent-deadbe1\)\]/],
    ],
    [
      // AgentTool's suffix verbatim, with the recover hint.
      "isolation:'worktree' cleanup: branchPreserved race yields branch-only suffix",
      () => ({
        removeUserWorktree: vi.fn(async () => ({
          success: true,
          branchPreserved: true, // race: commits landed between checks and delete
        })),
      }),
      [/worktree directory removed/, /git worktree add/],
    ],
    [
      "isolation:'worktree' cleanup: thrown removeUserWorktree preserves path+branch",
      () => ({
        removeUserWorktree: vi.fn(async () => {
          throw new Error('simulated git crash during remove');
        }),
      }),
      [/\[worktree preserved:.*\(branch worktree-agent-deadbe1\)\]/],
    ],
  ])('%s', async (_title, overrides, suffixes) => {
    await stubWorktree(overrides);
    const result = await isolated({ onCreate: ends('done') }).result;
    for (const suffix of suffixes) expect(String(result)).toMatch(suffix);
  });

  // ─── isolation:'worktree' option combinations ───────────────────
  // R2 self-review (test-3/4): single-option tests miss interactions.

  it("model + isolation:'worktree': model threaded through AND worktree provisioned", async () => {
    const { config, calls, value } = await dispatched(
      { onCreate: ends('done') },
      'hi',
      { model: 'qwen3-max', isolation: 'worktree' },
    );
    const worktree = '/fake/repo/.qwen/worktrees/agent-deadbe1';
    const runtime = calls[0].runtimeContext;
    expect(calls[0].config.model).toBe('qwen3-max');
    // The default-clean stub auto-removes; no suffix expected.
    expect(String(value)).not.toMatch(/worktree preserved/);
    expect(calls[0].runtimeContextSame).toBe(false);
    expect(runtime.getTargetDir()).toBe(worktree);
    expect(runtime.getCwd()).toBe(worktree);
    expect(runtime.getWorkingDir()).toBe(worktree);
    expect(runtime.getProjectRoot()).toBe(worktree);
    // Inherited through the approval profile's prototype chain; the fake
    // path is not on disk, so assert presence, not resolved directories.
    expect(runtime.getWorkspaceContext()).toBeDefined();
    expect(runtime.getFileService().getQwenIgnoreFileNamesDisplay()).toBe(
      '.qwenignore, .cursorignore',
    );
    expect(config.getTargetDir()).toBe('/fake/repo');
  });

  it("schema + isolation:'worktree': structured payload returned, worktree info logged", async () => {
    const { value } = await dispatched(
      { onCreate: answersSchema([{ ok: true, in_worktree: true }]) },
      'extract from worktree',
      { schema: { type: 'object' }, isolation: 'worktree' },
    );
    // Verbatim, no suffix: operator info goes to debugLogger (see
    // runOverridePath's "schema-mode... payload is returned verbatim").
    expect(value).toEqual({ ok: true, in_worktree: true });
  });

  // ─── R3 review (wenshao Round 2) ────────────────────────────────

  // T0 [Critical]: the outer try used to open AFTER schema setup, so a
  // setup throw after provisioning orphaned the worktree on disk.
  it("isolation:'worktree' + schema setup throws → worktree is still cleaned up", async () => {
    const removeCalls: string[] = [];
    await stubWorktree(() => ({
      removeUserWorktree: vi.fn(async (slug: string) => {
        removeCalls.push(slug);
        return { success: true };
      }),
    }));
    const { config } = fakeConfigWithMgr({ onCreate: ends('unused') });
    // Make createSchemaConfigOverride's rebuildToolRegistryOnOverride throw.
    (
      config as unknown as { createToolRegistry: () => Promise<unknown> }
    ).createToolRegistry = async () => {
      throw new Error('simulated registry rebuild failure');
    };
    await expect(
      createProductionDispatch(config)('hi', {
        isolation: 'worktree',
        schema: { type: 'object' },
      }),
    ).rejects.toThrow(/simulated registry rebuild failure/);
    // Cleanup must have called removeUserWorktree even though setup threw.
    expect(removeCalls).toContain('agent-deadbe1');
  });

  // T1 + T4 [Critical/H1]: otherwise prepareTools filters it out, leaving the
  // model a silent structured-output dead-end.
  it('schema-mode + agentType restricted tools: structured_output appended to allowlist', async () => {
    const { calls } = await dispatched(
      {
        lookup: defines(
          'Explore',
          'fast read-only',
          'You are Explore. Read-only. Be fast.',
          'builtin',
          { tools: ['Read', 'Grep', 'Glob'], disallowedTools: [] },
        ),
        onCreate: answersSchema([{ ok: true }]),
      },
      'extract',
      { agentType: 'Explore', schema: { type: 'object' } },
    );
    const tools = (calls[0].config as { tools?: string[] }).tools ?? [];
    expect(tools).toContain('structured_output');
    // The original agentType tools survive, not replaced.
    expect(tools).toEqual(
      expect.arrayContaining(['Read', 'Grep', 'Glob', 'structured_output']),
    );
  });

  // T1 + T4 [Critical/H1] companion: appended, not replacing the persona.
  it('schema-mode + agentType: systemPrompt appends schema instructions (persona preserved)', async () => {
    const personaPrompt = 'You are Explore. Read-only. Be fast.';
    const { calls } = await dispatched(
      {
        lookup: defines('Explore', 'fast read-only', personaPrompt, 'builtin'),
        onCreate: answersSchema([{ ok: true }]),
      },
      'extract',
      { agentType: 'Explore', schema: { type: 'object' } },
    );
    const sp =
      (calls[0].config as { systemPrompt?: string }).systemPrompt ?? '';
    expect(sp).toContain(personaPrompt);
    expect(sp).toContain('structured_output');
  });

  // T2 + T5 [M1]: `{ once: true }` removed only on a real parent abort, so N
  // schema calls leaked N listeners + child controllers; the outer finally
  // now removes it however the dispatch ends.
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
      onCreate: answersSchema([{ ok: true }]),
    });
    const dispatch = createProductionDispatch(config, sharedSignal);
    // Run 5 schema-mode dispatches against the same parent signal.
    for (let i = 0; i < 5; i++) {
      await dispatch('extract', { schema: { type: 'object' } });
    }
    expect(liveListeners).toBe(0);
  });

  // T6 [M2]: TIMEOUT / MAX_TURNS / ERROR without a call are not content
  // failures, which the old path reported for every non-result outcome.
  it.each(['TIMEOUT', 'MAX_TURNS', 'ERROR'])(
    'schema-mode + terminateMode=%s → "did not complete" terminal, not a structured-output failure',
    async (mode) => {
      const { result } = dispatchVia({ onCreate: ends('', mode) }, 'extract', {
        schema: { type: 'object' },
      });
      await expect(result).rejects.toThrow(
        new RegExp(
          `workflow-agent-[0-9a-f]{16} did not complete \\(terminate mode: ${mode}\\)\\.`,
        ),
      );
    },
  );

  // T6 [M2] companion: the real 3-failure path names the count and the last
  // error.
  it('schema-mode: 3 failed structured_output calls → stopped after 3 failed submissions', async () => {
    // The dispatch aborts (CANCELLED) on the 3rd failure.
    const { result } = dispatchVia(
      {
        onCreate: answersSchema(
          [{ bad: 1 }, false],
          [{ bad: 2 }, false],
          [{ bad: 3 }, false],
        ),
      },
      'extract',
      { schema: { type: 'object' } },
    );
    await expect(result).rejects.toThrow(
      'subagent stopped after 3 failed structured_output submissions without a valid result. Last error: validation failed',
    );
  });

  describe('schema preflight and structured output diagnostics', () => {
    type Submission = {
      args?: Record<string, unknown>;
      success: boolean;
      error?: string;
      paired?: boolean;
    };

    function emitSubmissions(
      emitter: { emit(event: string, payload: unknown): void },
      submissions: Submission[],
    ): void {
      submissions.forEach((submission, index) => {
        const callId = `c${index + 1}`;
        if (submission.paired !== false) {
          emitter.emit('tool_call', {
            subagentId: 'sub',
            round: index + 1,
            callId,
            name: 'structured_output',
            args: submission.args ?? {},
            description: '',
            isOutputMarkdown: false,
            timestamp: index + 1,
          });
        }
        emitter.emit('tool_result', {
          subagentId: 'sub',
          round: index + 1,
          callId,
          name: 'structured_output',
          success: submission.success,
          ...(submission.error !== undefined
            ? { error: submission.error }
            : {}),
          responseParts: [],
          resultDisplay: '',
          durationMs: 1,
          timestamp: index + 1,
        });
      });
    }

    function dispatchWith(submissions: Submission[], terminateMode = 'GOAL') {
      const setup = fakeConfigWithMgr({
        onCreate: async () => ({
          finalText: 'plain text the script discards',
          terminateMode,
          runWithEmitter: (emitter) => emitSubmissions(emitter, submissions),
        }),
      });
      return { ...setup, dispatch: createProductionDispatch(setup.config) };
    }

    it.each([
      ['a non-string type', { type: 42 }],
      ['null', null],
      ['an array', []],
      ['a boolean', true],
      ['an unknown keyword', { type: 'object', propertees: {} }],
      ['an unresolvable $ref', { $ref: '#/$defs/Missing' }],
      ['an async schema', { $async: true, type: 'object' }],
      [
        'a contradiction',
        { type: 'object', required: ['x'], additionalProperties: false },
      ],
    ])(
      'refuses %s before provisioning a worktree or creating the subagent',
      async (_name, schema) => {
        const { GitWorktreeService } = await import(
          '../../services/gitWorktreeService.js'
        );
        const worktreesBefore = vi.mocked(GitWorktreeService).mock.calls.length;
        const onCreate = vi.fn(async () => ({
          finalText: 'must not run',
          terminateMode: 'GOAL',
        }));
        const { config, calls, registeredToolInstances } = fakeConfigWithMgr({
          onCreate,
        });
        const dispatch = createProductionDispatch(config);
        await expect(
          dispatch('extract', {
            schema: schema as object,
            isolation: 'worktree',
          }),
        ).rejects.toThrow(/^agent\(\{schema\}\): /);
        expect(onCreate).not.toHaveBeenCalled();
        expect(calls).toHaveLength(0);
        expect(registeredToolInstances).toHaveLength(0);
        expect(vi.mocked(GitWorktreeService).mock.calls.length).toBe(
          worktreesBefore,
        );
      },
    );

    it('dispatches a schema whose properties also match patternProperties', async () => {
      const { dispatch, calls } = dispatchWith(
        [{ success: true, args: { foo: 'ok' } }],
        'CANCELLED',
      );
      await expect(
        dispatch('extract', {
          schema: {
            type: 'object',
            properties: { foo: { type: 'string' } },
            patternProperties: { '^f': { minLength: 1 } },
            required: ['foo'],
          },
        }),
      ).resolves.toEqual({ foo: 'ok' });
      expect(calls).toHaveLength(1);
    });

    it('gives the structured_output tool this call validator, not the shared one', async () => {
      const id = 'https://example.com/schemas/workflow-tool-shared-id.json';
      // The shared validator now holds this $id for another shape.
      SchemaValidator.validate(
        { $id: id, type: 'object', required: ['a'] },
        {},
      );
      const { config, registeredToolInstances } = fakeConfigWithMgr({
        onCreate: async () => ({ finalText: '', terminateMode: 'GOAL' }),
      });
      await createProductionDispatch(config)('extract', {
        schema: { $id: id, type: 'object', required: ['b'] },
      }).catch(() => undefined);
      const tool = registeredToolInstances.find(
        (candidate) => candidate instanceof SyntheticOutputTool,
      ) as SyntheticOutputTool | undefined;
      expect(tool).toBeDefined();
      expect(() => tool!.build({})).toThrow(/required property 'b'/);
      expect(() => tool!.build({ b: 1 })).not.toThrow();
    });

    it.each([
      [
        [{ success: false, error: 'first error' }],
        'subagent completed after 1 failed structured_output submission without a valid result. Last error: first error',
      ],
      [
        [
          { success: false, error: 'first error' },
          { success: false, error: 'second error' },
        ],
        'subagent completed after 2 failed structured_output submissions without a valid result. Last error: second error',
      ],
      [
        [{ success: false, error: 'first error' }, { success: false }],
        'subagent completed after 2 failed structured_output submissions without a valid result. Submission 2 reported no error detail; the last error (submission 1): first error',
      ],
      [
        [{ success: false }],
        'subagent completed after 1 failed structured_output submission without a valid result. The failed submissions reported no error detail.',
      ],
    ] as Array<[Submission[], string]>)(
      'reports the failed submissions of an agent that then answered in plain text (%#)',
      async (submissions, message) => {
        const { dispatch } = dispatchWith(submissions);
        const caught = await dispatch('extract', {
          schema: { type: 'object' },
        }).catch((error: unknown) => error);
        expect(isWorkflowAgentFailedError(caught)).toBe(true);
        expect((caught as WorkflowAgentFailedError).kind).toBe(
          'no_structured_output',
        );
        expect((caught as Error).message).toBe(message);
      },
    );

    it('stops the agent at the third failed submission and names its error', async () => {
      const seen: boolean[] = [];
      const { config } = fakeConfigWithMgr({
        onCreate: async () => ({
          finalText: '',
          terminateMode: 'CANCELLED',
          runWithEmitter: (emitter, signal) => {
            for (let i = 1; i <= 3; i++) {
              emitSubmissions(emitter, [
                { success: false, error: `error ${i}` },
              ]);
              seen.push(signal?.aborted ?? false);
            }
          },
        }),
      });
      await expect(
        createProductionDispatch(config)('extract', {
          schema: { type: 'object' },
        }),
      ).rejects.toThrow(
        'subagent stopped after 3 failed structured_output submissions without a valid result. Last error: error 3',
      );
      expect(seen).toEqual([false, false, true]);
    });

    it('keeps the last error single-line and bounded', async () => {
      const { dispatch } = dispatchWith([
        { success: false, error: `bad\u001b[31m\nvalue ${'x'.repeat(2000)}` },
      ]);
      const caught = (await dispatch('extract', {
        schema: { type: 'object' },
      }).catch((error: unknown) => error)) as Error;
      // eslint-disable-next-line no-control-regex
      expect(caught.message).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
      expect(caught.message.length).toBeLessThan(800);
      expect(caught.message).toContain('Last error: badvalue x');
    });

    it('returns the object its validator accepted, with coercion applied', async () => {
      const args = { n: '5' };
      const { dispatch } = dispatchWith([{ success: true, args }], 'CANCELLED');
      const result = await dispatch('extract', {
        schema: {
          type: 'object',
          properties: { n: { type: 'number' } },
          required: ['n'],
        },
      });
      expect(result).toEqual({ n: 5 });
      expect(args).toEqual({ n: '5' });
    });

    it('counts a reported success whose arguments do not pass as a failed submission', async () => {
      const { dispatch } = dispatchWith([{ success: true, args: {} }]);
      await expect(
        dispatch('extract', {
          schema: { type: 'object', required: ['answer'] },
        }),
      ).rejects.toThrow(
        /after 1 failed structured_output submission without a valid result\. Last error: structured_output arguments did not pass validation: .*required property 'answer'/,
      );
    });

    it('counts a reported success without an observed call as a failed submission', async () => {
      const { dispatch } = dispatchWith([{ success: true, paired: false }]);
      await expect(
        dispatch('extract', { schema: { type: 'object' } }),
      ).rejects.toThrow(
        /after 1 failed structured_output submission without a valid result\. Last error: structured_output reported success for a call whose arguments were not observed\./,
      );
    });

    it.each(['serially', 'concurrently'])(
      'validates each schema sharing an $id against itself, %s',
      async (mode) => {
        const id = `https://example.com/schemas/workflow-shared-${mode}.json`;
        const schemaA = { $id: id, type: 'object', required: ['a'] };
        const schemaB = { $id: id, type: 'object', required: ['b'] };
        const { config } = fakeConfigWithMgr({
          onCreate: async (call) => ({
            finalText: '',
            terminateMode: 'GOAL',
            runWithEmitter: (emitter) =>
              emitSubmissions(
                emitter,
                call.options?.taskName === 'for-a'
                  ? [{ success: true, args: { a: 1 } }]
                  : [
                      // As if the tool had let the other shape through.
                      { success: true, args: { a: 1 } },
                      { success: true, args: { b: 2 } },
                    ],
              ),
          }),
        });
        const dispatch = createProductionDispatch(config);
        const results =
          mode === 'serially'
            ? [
                await dispatch('for-a', { schema: schemaA }),
                await dispatch('for-b', { schema: schemaB }),
              ]
            : await Promise.all([
                dispatch('for-a', { schema: schemaA }),
                dispatch('for-b', { schema: schemaB }),
              ]);
        expect(results).toEqual([{ a: 1 }, { b: 2 }]);
      },
    );
  });
});

// Every `agent()` dispatch leaves AgentTool's per-agent JSONL transcript;
// before, a run left only the journal (a prompt hash, no `result` line for
// a dispatch that threw).
describe('createProductionDispatch — subagent transcripts', () => {
  let projectDir: string;

  beforeEach(() => {
    resetHeadlessMock();
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
    // The launch prompt as the first `user` record, as readers expect.
    expect(recs[0]!['type']).toBe('user');
    expect(partsOf(recs[0]!)).toEqual([{ text: 'review chunk 3 of 7' }]);
    expect(recs[0]!['agentId']).toMatch(/^workflow-agent-[0-9a-f]{16}$/);
    expect(recs[0]!['agentName']).toBe('chunk-3');
    expect(recs[0]!['sessionId']).toBe('sess-1');
    // Pins buildAgentTranscriptAttach's launch metadata wiring.
    expect(recs[0]!['version']).toBe('9.9.9');
    expect(recs[0]!['cwd']).toBe(projectDir);
    expect(names[0]).toBe(`agent-${recs[0]!['agentId'] as string}.jsonl`);
  });

  // An empty prompt seeds no user record, so it is refused before any
  // transcript starts.
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

  // One resolved display name for both, so '' cannot diverge.
  it('keeps the runtime agent name and the transcript aligned for an empty label', async () => {
    await createProductionDispatch(transcriptConfig())('task', { label: '' });
    expect(created).toHaveLength(1);
    expect(created[0]!.name).toBe('workflow-agent');
    const recs = recordsIn(transcriptNames()[0]!);
    expect(recs[0]!['agentName']).toBe('workflow-agent');
  });

  it("records the subagent's tool calls and their results", async () => {
    const args = { absolute_path: '/tmp/diff.txt', offset: 0, limit: 40 };
    nextExecuteHook.value = async (emitter) => {
      emitter.emit(AgentEventType.TOOL_CALL, {
        subagentId: 'sub',
        round: 1,
        callId: 'c1',
        name: 'read_file',
        args,
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
              fnResponse('read_file', { output: 'diff text' }, 'c1'),
            ],
          },
        ],
        timestamp: 2,
      });
    };
    await createProductionDispatch(transcriptConfig())('read it', {
      label: 'reader',
    });
    const recs = recordsIn(transcriptNames()[0]!);
    expect(partsOf(recs[1]!)).toEqual([fnCall('read_file', args, 'c1')]);
    expect(recs[2]!['type']).toBe('tool_result');
    expect(recs[2]!['toolCallResult']).toEqual({ callId: 'c1' });
  });

  // A stall retry is ONE `agent()` call; an id per attempt would show two
  // agents, one with almost no tool calls, which a coverage gate reads as an
  // agent that did nothing.
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
      await stallUntilAborted(emitter, signal, 'workflow-agent', 'prompt-1');
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
    expect(records.filter((r) => r['type'] === 'user')).toHaveLength(1);
    // Attempt 2 seeded an agent_retry marker before its own records.
    expect(records[1]!['type']).toBe('system');
    expect(records[1]!['subtype']).toBe('agent_retry');
    expect(records[1]!['systemPayload']).toEqual({ attempt: 2 });
    // A retry that did nothing would end the file at the marker.
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

  // The journal has no `result` line for a thrown dispatch; the transcript
  // keeps what the agent was asked and how far it got.
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
    await expect(dispatchHello()).resolves.toBe('headless-said:hello');
    expect(transcriptNames()).toHaveLength(0);
  });
});
