/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

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

  // P2 (PR #4732): parallel() runs end-to-end through the full stack
  // (WorkflowTool → orchestrator counter+limiter+parallelImpl → sandbox
  // in-realm revival → script return → safeStringifyResult).
  it('execute() runs parallel() end-to-end and returns the revived array', async () => {
    const tool = new WorkflowTool(fakeConfig(), {
      dispatch: async (prompt) => `T:${prompt}`,
    });
    const invocation = tool.build({
      script: `return await parallel([() => agent("a"), () => agent("b")]);`,
    });
    const result = await invocation.execute(new AbortController().signal);
    expect(result.error).toBeUndefined();
    const llmText = (result.llmContent as Array<{ text: string }>)[0].text;
    expect(JSON.parse(llmText)).toEqual(['T:a', 'T:b']);
  });

  // P3 (PR #5xxx): schema mode end-to-end through WorkflowTool. The
  // dispatch returns the validated structured payload as an object; the
  // sandbox revives it per-call into the vm realm; the script reads it
  // as a vm-realm object; safeStringifyResult JSON-stringifies it for the
  // LLM. A regression in any layer of that chain would surface here.
  it('execute() runs agent({schema}) end-to-end and returns the revived object', async () => {
    const tool = new WorkflowTool(fakeConfig(), {
      dispatch: async (prompt, opts) => {
        if (opts.schema !== undefined) {
          return { extracted: prompt.toUpperCase(), confidence: 0.9 };
        }
        return prompt;
      },
    });
    const invocation = tool.build({
      script:
        'const r = await agent("hello", { schema: { type: "object", properties: { extracted: { type: "string" } } } }); return r;',
    });
    const result = await invocation.execute(new AbortController().signal);
    expect(result.error).toBeUndefined();
    const llmText = (result.llmContent as Array<{ text: string }>)[0].text;
    expect(JSON.parse(llmText)).toEqual({
      extracted: 'HELLO',
      confidence: 0.9,
    });
  });

  // PR #4947 R2 T8 (qwen-code-ci-bot): pipeline() through WorkflowTool
  // exercises a vm wrapper path that is structurally distinct from parallel's
  // single-argument call — pipeline uses `callPipeline.apply(null, arguments)`
  // and `[items].concat(stages)` to spread the variadic stage list
  // (workflow-sandbox.ts pipeline wrapper). A regression in the vm-to-host
  // stage forwarding would not be caught by the parallel E2E test above.
  it('execute() runs pipeline() end-to-end and returns the revived array', async () => {
    const tool = new WorkflowTool(fakeConfig(), {
      dispatch: async () => 'unused',
    });
    const invocation = tool.build({
      script: `return await pipeline([1, 2], (x) => x * 10, (x) => x + 1);`,
    });
    const result = await invocation.execute(new AbortController().signal);
    expect(result.error).toBeUndefined();
    const llmText = (result.llmContent as Array<{ text: string }>)[0].text;
    expect(JSON.parse(llmText)).toEqual([11, 21]);
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
    // T4 (PR #4732 R1): assert the machine-readable error type so a
    // refactor removing the field doesn't go uncaught.
    expect(result.error!.type).toBe('execution_failed');
  });

  // T19 (PR #4732 R1): phases / logs accumulated before a script failure
  // must be included in the user-visible display so debugging is possible.
  it('execute() includes phases + logs in returnDisplay when script fails', async () => {
    const tool = new WorkflowTool(fakeConfig(), {
      dispatch: async () => 'unused',
    });
    const invocation = tool.build({
      script: `
        phase("plan");
        log("computing");
        phase("execute");
        log("about to fail");
        throw new Error("boom");
      `,
    });
    const result = await invocation.execute(new AbortController().signal);
    expect(result.error).toBeDefined();
    const display = String(result.returnDisplay);
    expect(display).toContain('Workflow failed: boom');
    expect(display).toContain('plan');
    expect(display).toContain('execute');
    expect(display).toContain('computing');
    expect(display).toContain('about to fail');
  });

  // T12 / T18 (PR #4732 R1): a script that returns a BigInt or a circular
  // value must not be reported as a workflow failure — the script ran fine,
  // only the post-processing JSON.stringify hit a limitation.
  it('execute() degrades gracefully on BigInt return values (success, not failure)', async () => {
    const tool = new WorkflowTool(fakeConfig(), {
      dispatch: async () => 'unused',
    });
    const invocation = tool.build({
      script: 'return 1n + 2n;',
    });
    const result = await invocation.execute(new AbortController().signal);
    expect(result.error).toBeUndefined();
    const llmText = (result.llmContent as Array<{ text: string }>)[0]!.text;
    expect(llmText).toMatch(/non-JSON-serializable value of type bigint/);
  });

  it('execute() degrades gracefully on circular return values', async () => {
    const tool = new WorkflowTool(fakeConfig(), {
      dispatch: async () => 'unused',
    });
    const invocation = tool.build({
      script: 'const a = {}; a.self = a; return a;',
    });
    const result = await invocation.execute(new AbortController().signal);
    expect(result.error).toBeUndefined();
    const llmText = (result.llmContent as Array<{ text: string }>)[0]!.text;
    expect(llmText).toMatch(/non-JSON-serializable value of type object/);
  });

  // T30 (PR #4732 R3): sibling drift of the R1 T12/T18 fix. llmContent
  // already degrades per-field on non-serializable result, but the
  // returnDisplay payload (runId + phases + logs + result) used to be
  // wrapped in a single JSON.stringify — one bad `result` collapsed the
  // entire display to "(display payload not JSON-serializable)", losing
  // the runId, the phases, AND the logs. safeStringifyDisplayPayload now
  // degrades per-field on the failure path so always-serializable
  // metadata survives regardless of which field went bad.
  it('execute() preserves runId/phases/logs in returnDisplay when result is non-JSON-serializable', async () => {
    const tool = new WorkflowTool(fakeConfig(), {
      dispatch: async () => 'unused',
    });
    const invocation = tool.build({
      script: 'phase("compute"); const a = {}; a.self = a; return a;',
    });
    const result = await invocation.execute(new AbortController().signal);
    expect(result.error).toBeUndefined();
    const display = String(result.returnDisplay);
    // runId, the phase, and a result placeholder must all survive.
    expect(display).toMatch(/wf_[0-9a-f]{16}/);
    expect(display).toContain('compute');
    expect(display).toContain('non-JSON-serializable');
    // The atomic-failure fallback must NOT appear — that would mean the
    // whole display payload had thrown.
    expect(display).not.toContain('display payload not JSON-serializable');
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

  // FIX-C9 (TST-M2): scripts without an explicit `return` resolve to
  // undefined. WorkflowTool surfaces a clear placeholder rather than the
  // literal string "undefined".
  // FIX-G (Round 4 test Minor): args threading through WorkflowTool.build()
  // → orchestrator.run() → sandbox. A regression where args is dropped
  // (e.g. forgetting to pass `args: this.params.args` to orchestrator.run)
  // would go uncaught.
  it('execute() threads params.args through to the sandbox args global', async () => {
    const tool = new WorkflowTool(fakeConfig(), {
      dispatch: async () => 'unused',
    });
    const invocation = tool.build({
      script: 'return args.who',
      args: { who: 'world' },
    });
    const result = await invocation.execute(new AbortController().signal);
    expect(result.error).toBeUndefined();
    const llmText = (result.llmContent as Array<{ text: string }>)[0]!.text;
    expect(llmText).toBe('world');
  });

  it('execute() handles scripts that return undefined (no explicit return)', async () => {
    const tool = new WorkflowTool(fakeConfig(), {
      dispatch: async () => 'ignored',
    });
    const invocation = tool.build({
      script: 'phase("noop"); /* no return */',
    });
    const result = await invocation.execute(new AbortController().signal);
    expect(result.error).toBeUndefined();
    const llmText = (result.llmContent as Array<{ text: string }>)[0]!.text;
    expect(llmText).toBe('(workflow returned no value)');
  });
});
