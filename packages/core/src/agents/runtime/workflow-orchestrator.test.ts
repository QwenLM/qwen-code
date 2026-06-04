/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

// T7 (PR #4732 R1): the `vi as vitest` alias diverges from every other
// test file in the repo. Use `vi` directly.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  WorkflowOrchestrator,
  WorkflowExecutionError,
  createProductionDispatch,
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
