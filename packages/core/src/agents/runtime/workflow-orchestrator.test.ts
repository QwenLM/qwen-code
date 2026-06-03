import { describe, it, expect, vi as vitest } from 'vitest';
import { WorkflowOrchestrator } from './workflow-orchestrator.js';
import type { Config } from '../../config/config.js';

const created: Array<{ name: string; prompt: string }> = [];

vitest.mock('./agent-headless.js', () => ({
    AgentHeadless: {
      create: async (
        name: string,
        _runtimeContext: unknown,
        promptConfig: { systemPrompt?: string },
        _modelConfig: unknown,
        _runConfig: unknown,
        _toolConfig?: unknown,
      ) => ({
        execute: async (ctx: { get: (k: string) => unknown }) => {
          created.push({ name, prompt: ctx.get('task_prompt') as string });
          if (
            !promptConfig.systemPrompt?.includes(
              'subagent spawned by a workflow',
            )
          ) {
            throw new Error(
              'orchestrator did not pass workflow subagent system prompt',
            );
          }
        },
        getFinalText: () =>
          `headless-said:${created[created.length - 1]!.prompt}`,
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
    __getCreated: () => created,
  }));

function fakeConfig(): Config {
  // Orchestrator uses Config only when constructing the real dispatch. In
  // tests we always inject a mock dispatch, so an empty object cast is safe.
  return {} as unknown as Config;
}

describe('WorkflowOrchestrator', () => {
  it('runs a script with injected mock dispatch and returns the script value', async () => {
    const orchestrator = new WorkflowOrchestrator(fakeConfig(), {
      dispatch: async (prompt) => `mock:${prompt}`,
    });
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
    const orchestrator = new WorkflowOrchestrator(fakeConfig(), {
      dispatch: async () => 'unused',
    });
    const outcome = await orchestrator.run({
      script: `return args.who`,
      args: { who: 'world' },
    });
    expect(outcome.result).toBe('world');
  });

  it('surfaces a thrown error from the script', async () => {
    const orchestrator = new WorkflowOrchestrator(fakeConfig(), {
      dispatch: async () => 'unused',
    });
    await expect(
      orchestrator.run({
        script: `throw new Error("boom")`,
        args: undefined,
      }),
    ).rejects.toThrow(/boom/);
  });

  it('runId is stable for the lifetime of a single run call', async () => {
    const captured: string[] = [];
    const orchestrator = new WorkflowOrchestrator(fakeConfig(), {
      dispatch: async (prompt) => {
        captured.push(prompt);
        return 'ok';
      },
    });
    const outcome = await orchestrator.run({
      script: `await agent("first"); await agent("second"); return 0;`,
      args: undefined,
    });
    expect(captured).toEqual(['first', 'second']);
    expect(outcome.runId).toMatch(/^wf_[0-9a-f]{16}$/);
  });
});

describe('WorkflowOrchestrator production dispatch', () => {
  it('routes agent() calls through AgentHeadless and returns getFinalText', async () => {
    const orchestrator = new WorkflowOrchestrator(fakeConfig());
    const outcome = await orchestrator.run({
      script: `const r = await agent("hello", { label: "h1" });
               return r;`,
      args: undefined,
    });
    expect(outcome.result).toBe('headless-said:hello');
  });
});
