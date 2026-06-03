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
      orchestratorOverrides: {
        dispatch: async (prompt) => `T:${prompt}`,
      },
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
    expect(text).toMatch(/wf_[0-9a-f]{16}/);
  });
});
