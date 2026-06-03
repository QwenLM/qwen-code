import { describe, it, expect } from 'vitest';
import { WorkflowTool } from './workflow.js';
import type { Config } from '../../config/config.js';
import { ToolNames, ToolDisplayNames } from '../tool-names.js';

function fakeConfig(): Config {
  return {} as unknown as Config;
}

describe('WorkflowTool', () => {
  it('has the registered name and display name', () => {
    const tool = new WorkflowTool(fakeConfig());
    expect(tool.name).toBe(ToolNames.WORKFLOW);
    expect(tool.displayName).toBe(ToolDisplayNames.WORKFLOW);
  });

  it('rejects build() when script is missing', () => {
    const tool = new WorkflowTool(fakeConfig());
    expect(() => tool.build({} as never)).toThrow(/script/);
  });

  it('rejects build() when script is empty string', () => {
    const tool = new WorkflowTool(fakeConfig());
    expect(() => tool.build({ script: '' })).toThrow(/script/);
  });

  it('build() returns an invocation that exposes the script as description', () => {
    const tool = new WorkflowTool(fakeConfig());
    const invocation = tool.build({
      script: 'return 1',
    });
    expect(invocation.params.script).toBe('return 1');
    expect(invocation.getDescription()).toContain('workflow');
  });

  it('getDefaultPermission returns "ask"', async () => {
    const tool = new WorkflowTool(fakeConfig());
    const invocation = tool.build({ script: 'return 1' });
    expect(await invocation.getDefaultPermission()).toBe('ask');
  });

  it('execute() runs the script via WorkflowOrchestrator with injected dispatch and returns a ToolResult', async () => {
    const tool = new WorkflowTool(fakeConfig(), {
      dispatch: async (prompt) => `T:${prompt}`,
    });
    const invocation = tool.build({
      script: `phase("plan");
               const r = await agent("write hello", { label: "h1" });
               return r;`,
    });
    const result = await invocation.execute(new AbortController().signal);
    expect(result.error).toBeUndefined();
    const text = JSON.stringify(result.llmContent);
    expect(text).toContain('T:write hello');
    // FIX-7: llmContent now contains just the result, not the full JSON wrapper.
    // The runId should NOT appear in llmContent when the result is a plain string.
    // (It does appear in returnDisplay, which we don't test here.)
    expect(JSON.stringify(result.returnDisplay)).toMatch(/wf_[0-9a-f]{16}/);
  });

  // TST-C3: execute() should return an error result (not throw) when the script throws.
  it('execute() returns an error result when the script throws', async () => {
    const tool = new WorkflowTool(fakeConfig(), {
      dispatch: async () => 'unused',
    });
    const invocation = tool.build({
      script: 'throw new Error("scripted failure")',
    });
    const result = await invocation.execute(new AbortController().signal);
    expect(result.error).toBeDefined();
    expect(result.error!.message).toContain('scripted failure');
    expect(JSON.stringify(result.llmContent)).toContain('Workflow failed');
  });

  // TST-C3: llmContent must be the unwrapped script return value (FIX-7).
  it('execute() strips the JSON wrapper from llmContent (script return is verbatim)', async () => {
    const tool = new WorkflowTool(fakeConfig(), {
      dispatch: async () => 'ignored',
    });
    const invocation = tool.build({
      script: 'return { kind: "report", body: "hello" };',
    });
    const result = await invocation.execute(new AbortController().signal);
    const llmText = (result.llmContent as Array<{ text: string }>)[0].text;
    // The llmText should be the JSON of just the script's return value,
    // NOT a wrapper with {runId, result, phases, logs}.
    expect(JSON.parse(llmText)).toEqual({ kind: 'report', body: 'hello' });
  });
});
