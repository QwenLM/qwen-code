/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkflowTool } from './workflow.js';
import type { Config } from '../../config/config.js';
import { ToolNames, ToolDisplayNames } from '../tool-names.js';
import { WorkflowRunRegistry } from '../../agents/workflow-run-registry.js';
import { Storage } from '../../config/storage.js';

function fakeConfig(): Config {
  return {} as unknown as Config;
}

/**
 * P4b Round 5 (wenshao): the registry integration path inside
 * `WorkflowTool.execute()` (register → emitter → complete/fail/cancel)
 * is not exercised by `fakeConfig()` because optional chaining short-
 * circuits the missing `getWorkflowRunRegistry()` method. This helper
 * builds a config with a real `WorkflowRunRegistry` and returns the
 * registry handle so tests can inspect post-run state.
 */
function configWithRegistry(): {
  config: Config;
  registry: WorkflowRunRegistry;
} {
  const registry = new WorkflowRunRegistry();
  const config = {
    getWorkflowRunRegistry: () => registry,
  } as unknown as Config;
  return { config, registry };
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

  // ── P7b-A1: saved-workflow scriptPath path ──────────────────────────────

  it('rejects build() when both script and scriptPath are given', () => {
    const tool = new WorkflowTool(fakeConfig());
    expect(() =>
      tool.build({ script: 'return 1', scriptPath: '/x/y.js' }),
    ).toThrow(/exactly one/);
  });

  it('rejects build() when resumeFromRunId is not a wf_<hex> id (path-traversal guard)', () => {
    const tool = new WorkflowTool(fakeConfig());
    expect(() =>
      tool.build({ script: 'return 1', resumeFromRunId: '../../etc/evil' }),
    ).toThrow(/resumeFromRunId/);
    // A well-formed generated id is accepted.
    expect(() =>
      tool.build({ script: 'return 1', resumeFromRunId: 'wf_1a2b3c4d5e6f7081' }),
    ).not.toThrow();
  });

  it('build() accepts a scriptPath without inline script', () => {
    const tool = new WorkflowTool(fakeConfig());
    const invocation = tool.build({
      scriptPath: '/abs/deep-research.js',
    });
    expect(invocation.params.scriptPath).toBe('/abs/deep-research.js');
    // Description reflects the saved-workflow filename, not a char count.
    expect(invocation.getDescription()).toContain('deep-research.js');
  });

  it('execute() loads a saved-workflow scriptPath and records its provenance', async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-tool-'));
    try {
      const registry = new WorkflowRunRegistry();
      const config = {
        getWorkflowRunRegistry: () => registry,
        storage: new Storage(projectDir),
      } as unknown as Config;
      // The scriptPath MUST live under a saved-workflow dir (the resolver
      // refuses paths outside it — the #2 path-traversal / symlink guard).
      const dir = new Storage(projectDir).getProjectWorkflowsDir();
      await fs.mkdir(dir, { recursive: true });
      const scriptPath = path.join(dir, 'greet.js');
      await fs.writeFile(scriptPath, 'return await agent("hi");', 'utf8');
      const tool = new WorkflowTool(config, {
        dispatch: async (prompt) => `T:${prompt}`,
      });
      const invocation = tool.build({ scriptPath });
      const result = await invocation.execute(new AbortController().signal);
      expect(result.error).toBeUndefined();
      expect(JSON.stringify(result.llmContent)).toContain('T:hi');
      // The registry entry carries the resolved absolute path (run provenance
      // for the snapshot writer).
      const entries = registry.list();
      expect(entries).toHaveLength(1);
      expect(entries[0].scriptPath).toBe(scriptPath);
    } finally {
      await fs.rm(projectDir, { recursive: true, force: true });
    }
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

  // P4: execute() surfaces the extracted `export const meta = {...}` in
  // the returnDisplay payload so the user (and a future /workflows
  // listing) can see the workflow's name / description / phases.
  it('execute() surfaces meta in returnDisplay when the script declares it', async () => {
    const tool = new WorkflowTool(fakeConfig(), {
      dispatch: async () => 'ignored',
    });
    const invocation = tool.build({
      script: `export const meta = { name: 'demo', description: 'demo workflow', phases: [{ title: 'plan' }] }
               return 1;`,
    });
    const result = await invocation.execute(new AbortController().signal);
    expect(result.error).toBeUndefined();
    const display = String(result.returnDisplay);
    expect(display).toContain('"meta"');
    expect(display).toContain('demo workflow');
    expect(display).toContain('"phases"');
  });

  it('execute() omits meta key from returnDisplay when the script has no declaration', async () => {
    const tool = new WorkflowTool(fakeConfig(), {
      dispatch: async () => 'ignored',
    });
    const invocation = tool.build({
      script: 'return 1;',
    });
    const result = await invocation.execute(new AbortController().signal);
    const display = String(result.returnDisplay);
    expect(display).not.toContain('"meta"');
  });

  // P4: when the script body throws AFTER meta parsed, the meta is still
  // visible on the failure display via the WorkflowExecutionError.meta
  // field that the tool's catch block surfaces.
  it('execute() includes meta in failure returnDisplay when body throws', async () => {
    const tool = new WorkflowTool(fakeConfig(), {
      dispatch: async () => 'ignored',
    });
    const invocation = tool.build({
      script: `export const meta = { name: 'fails', description: 'will throw' }
               throw new Error("body boom")`,
    });
    const result = await invocation.execute(new AbortController().signal);
    expect(result.error).toBeDefined();
    const display = String(result.returnDisplay);
    expect(display).toContain('Workflow failed');
    expect(display).toContain('"fails"');
    expect(display).toContain('will throw');
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

  // P4a adversarial review (MEDIUM): if a script's return value happens to
  // have the same shape as a WorkflowMeta declaration (`{ name, description,
  // phases }`), the safeStringifyDisplayPayload spread must NOT clobber the
  // top-level `meta` key with the result. Both must appear distinctly in
  // the display so the user can see the declared meta independently of
  // whatever the script happened to return.
  it('execute() display surfaces meta + meta-shaped result distinctly', async () => {
    const tool = new WorkflowTool(fakeConfig(), {
      dispatch: async () => 'unused',
    });
    const invocation = tool.build({
      script: `
        export const meta = { name: 'declared', description: 'the declared meta' }
        return { name: 'returned', description: 'looks like meta but is the script result', phases: [{ title: 'X' }] }
      `,
    });
    const result = await invocation.execute(new AbortController().signal);
    expect(result.error).toBeUndefined();
    const display = result.returnDisplay as string;
    const jsonText = display.replace(/^```json\n/, '').replace(/\n```$/, '');
    const parsed = JSON.parse(jsonText) as {
      meta: { name: string; description: string };
      result: { name: string; description: string; phases: object[] };
    };
    expect(parsed.meta).toEqual({
      name: 'declared',
      description: 'the declared meta',
    });
    expect(parsed.result).toEqual({
      name: 'returned',
      description: 'looks like meta but is the script result',
      phases: [{ title: 'X' }],
    });
    // Defensive: the literal text appearance of both names must be
    // distinct — a regression that merged them would still satisfy a
    // single-side toEqual on a shared object, so check the rendered
    // display contains both string literals at separate offsets.
    expect(display.indexOf('"declared"')).toBeGreaterThan(-1);
    expect(display.indexOf('"returned"')).toBeGreaterThan(-1);
    expect(display.indexOf('"declared"')).not.toBe(
      display.indexOf('"returned"'),
    );
  });

  // P4b Round 5 (wenshao): the registry integration seam — register on
  // execute() start, emitter wires the live state, complete on success,
  // fail on caught exception, cancel on signal.aborted — was completely
  // unexercised by tests using fakeConfig() (optional chaining short-
  // circuited the missing getWorkflowRunRegistry method, so every call
  // site resolved to undefined). These three tests pin the contract
  // against the actual WorkflowRunRegistry instance.

  it('execute() success path registers the run + mirrors meta/phases/result + transitions to completed', async () => {
    const { config, registry } = configWithRegistry();
    const tool = new WorkflowTool(config, {
      dispatch: async () => 'mock-answer',
    });
    const invocation = tool.build({
      script: `
        export const meta = { name: 'demo', description: 'desc' }
        phase('Plan')
        phase('Build')
        const a = await agent('q1')
        return { a }
      `,
    });
    const result = await invocation.execute(new AbortController().signal);
    expect(result.error).toBeUndefined();

    const entries = registry.list();
    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    expect(entry.status).toBe('completed');
    expect(entry.runId).toMatch(/^wf_[a-f0-9]{16}$/);
    // The tool fast-tracks meta.name → entry.description when the
    // synthesized default (runId) was used at register time.
    expect(entry.description).toBe('demo');
    expect(entry.meta).toEqual({ name: 'demo', description: 'desc' });
    expect(entry.phases).toEqual(['Plan', 'Build']);
    expect(entry.currentPhase).toBe('Build');
    expect(entry.agentsDispatched).toBe(1);
    expect(entry.agentsCompleted).toBe(1);
    expect(entry.result).toEqual({ a: 'mock-answer' });
    expect(entry.error).toBeUndefined();
    expect(entry.endTime).toBeDefined();
  });

  it('execute() failure path records the error message + transitions to failed', async () => {
    const { config, registry } = configWithRegistry();
    const tool = new WorkflowTool(config, {
      dispatch: async () => 'unused',
    });
    const invocation = tool.build({
      script: `
        phase('Plan')
        throw new Error('intentional script body failure')
      `,
    });
    const result = await invocation.execute(new AbortController().signal);
    expect(result.error).toBeDefined();

    const entries = registry.list();
    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    expect(entry.status).toBe('failed');
    expect(entry.error).toMatch(/intentional script body failure/);
    expect(entry.phases).toEqual(['Plan']);
    expect(entry.endTime).toBeDefined();
  });

  it('execute() pre-aborted signal transitions the entry to cancelled (not failed)', async () => {
    const { config, registry } = configWithRegistry();
    // Pre-abort so dispatch sees the cancellation immediately. The catch
    // arm distinguishes user-intent (signal.aborted) from script bugs.
    const aborter = new AbortController();
    aborter.abort();
    const tool = new WorkflowTool(config, {
      dispatch: async () => {
        throw new Error('aborted-by-signal');
      },
    });
    const invocation = tool.build({
      script: `
        phase('Plan')
        await agent('q1')
        return 1
      `,
    });
    const result = await invocation.execute(aborter.signal);
    expect(result.error).toBeDefined();

    const entries = registry.list();
    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    // The fail-vs-cancel branching at workflow.ts catch arm: when
    // signal.aborted is true at the moment of catch, the registry
    // records 'cancelled' so the dialog distinguishes user-initiated
    // stops from script bugs.
    expect(entry.status).toBe('cancelled');
    expect(entry.endTime).toBeDefined();
  });

  // P4 Round 7 (wenshao): end-to-end simulation of the dialog-cancel
  // race. The dialog's `cancelSelected` calls `registry.cancel()` which
  // flips status to 'cancelled' + aborts the registry entry's
  // controller (the same `dispatchController` the tool's catch arm
  // sees). Then the in-flight dispatch rejects, the catch arm runs,
  // and `setRecentLogs(runId, logs)` is called — pre-fix this was
  // rejected by the `status === 'running'` guard, so the cancelled
  // dialog row always showed an empty Logs section. Post-fix the
  // guard allows 'cancelled' too and the script's `log()` output
  // survives.
  //
  // This drives the EXACT production flow: real WorkflowTool +
  // real WorkflowRunRegistry + real sandbox emitting through the
  // real emitter wiring. The dialog itself isn't reachable in the
  // current TUI build (pre-existing pill-focus infra gap that
  // wenshao R7 noted is out of P4 scope), so this test stands in
  // for what a tmux dialog-cancel would assert.
  it('R7: dialog-cancel race during run — logs accumulated before cancel survive', async () => {
    const { config, registry } = configWithRegistry();
    // Controllable dispatch: hangs until the in-flight reject is
    // triggered externally (simulating the dialog cancel's abort
    // cascading through dispatchController into the dispatch).
    let dispatchInflight:
      | { reject: (err: Error) => void; prompt: string }
      | undefined;
    const dispatch = async (prompt: string): Promise<string> =>
      new Promise<string>((_resolve, reject) => {
        dispatchInflight = { reject, prompt };
      });

    const tool = new WorkflowTool(config, { dispatch });
    const invocation = tool.build({
      script: `
        phase('Plan');
        log('before agent dispatch');
        const a = await agent('q1');
        log('after agent: ' + a);
        return { a };
      `,
    });

    const outerSignal = new AbortController().signal;
    const executePromise = invocation.execute(outerSignal);

    // Wait for execute() to register the run and queue the dispatch.
    for (let i = 0; i < 200; i++) {
      if (registry.list().length > 0 && dispatchInflight) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(registry.list()).toHaveLength(1);
    const runId = registry.list()[0]!.runId;

    // Simulate the dialog cancel: flip status to 'cancelled' AND abort
    // the registry entry's controller. The dispatchController IS this
    // controller, so aborting it causes the dispatch to be cascaded.
    registry.cancel(runId, Date.now());
    expect(registry.get(runId)!.status).toBe('cancelled');

    // Cause the in-flight dispatch to reject (the production path: the
    // dispatchController abort propagates through the orchestrator's
    // limiter / countedDispatch to the test dispatch).
    dispatchInflight!.reject(new Error('aborted by dialog cancel'));

    // Tool's catch arm runs. With R7 fix the setRecentLogs call lands;
    // before R7 it was silently dropped because the guard rejected
    // 'cancelled'.
    const result = await executePromise;
    expect(result.error).toBeDefined();

    const final = registry.get(runId)!;
    expect(final.status).toBe('cancelled');
    // R7 fix verification: logs accumulated BEFORE the cancel are
    // preserved on the registry entry so the dialog's Logs section
    // is non-empty.
    expect(final.recentLogs.length).toBeGreaterThan(0);
    expect(
      final.recentLogs.some((l) => l.includes('before agent dispatch')),
    ).toBe(true);
  });

  // ── P5 T7: one-time usage warning banner ──────────────────────────────

  it('P5 T7: prepends the usage banner on the first run only', async () => {
    const { config, registry } = configWithRegistry();
    const tool = new WorkflowTool(config, {
      dispatch: async () => 'ok',
    });

    const first = await tool
      .build({ script: 'return 1' })
      .execute(new AbortController().signal);
    expect(typeof first.returnDisplay).toBe('string');
    expect(first.returnDisplay as string).toMatch(
      /Workflows have no per-run token cap|Workflow token cap is/,
    );
    expect(first.returnDisplay as string).toMatch(
      /skipWorkflowUsageWarning/,
    );
    // Second invocation: latch already flipped on the registry.
    const second = await tool
      .build({ script: 'return 2' })
      .execute(new AbortController().signal);
    expect(second.returnDisplay as string).not.toMatch(
      /skipWorkflowUsageWarning/,
    );

    // Sanity: the registry exposes both runs.
    expect(registry.list().length).toBe(2);
  });

  it('P5 T7: suppressed by skipWorkflowUsageWarning setting', async () => {
    const registry = new WorkflowRunRegistry();
    const config = {
      getWorkflowRunRegistry: () => registry,
      getSkipWorkflowUsageWarning: () => true,
    } as unknown as Config;
    const tool = new WorkflowTool(config, { dispatch: async () => 'ok' });
    const result = await tool
      .build({ script: 'return 1' })
      .execute(new AbortController().signal);
    expect(result.returnDisplay as string).not.toMatch(
      /skipWorkflowUsageWarning/,
    );
    // The latch SHOULD remain unflipped — settings suppression
    // bypasses the call so a later session that re-enables the
    // setting still gets its banner.
    expect(registry.shouldShowUsageWarning()).toBe(true);
  });

  // ── P5 T7 R1: failure-path latch + status='failed' contract ─────────

  it('P5 T7 R1: failure path does NOT emit banner or consume the latch', async () => {
    // Reason: coreToolScheduler overrides `returnDisplay` with
    // `error.message` whenever `result.error` is set. Emitting the
    // banner on the failure path would be invisible AND would
    // silently flip the latch — the next successful run would miss
    // the banner. The contract is: latch flips only when the banner
    // is actually rendered to the user (success path).
    const { config, registry } = configWithRegistry();
    const tool = new WorkflowTool(config, { dispatch: async () => 'ok' });
    const failed = await tool
      .build({ script: 'throw new Error("script-boom");' })
      .execute(new AbortController().signal);
    expect(failed.returnDisplay as string).not.toMatch(
      /skipWorkflowUsageWarning/,
    );
    expect(failed.returnDisplay as string).toMatch(/Workflow failed: /);
    // Latch unconsumed: a later successful run still gets the banner.
    expect(registry.shouldShowUsageWarning()).toBe(true);
    // Registry status contract: failed → 'failed', error preserved.
    expect(registry.list()).toHaveLength(1);
    expect(registry.list()[0]!.status).toBe('failed');
    expect(registry.list()[0]!.error).toMatch(/script-boom/);
  });

  it('P5 T7 R1: failed-then-succeeded → banner appears on the SUCCESS run', async () => {
    const { config, registry } = configWithRegistry();
    const tool = new WorkflowTool(config, { dispatch: async () => 'ok' });
    await tool
      .build({ script: 'throw new Error("first-fail");' })
      .execute(new AbortController().signal);
    const success = await tool
      .build({ script: 'return 1' })
      .execute(new AbortController().signal);
    expect(success.returnDisplay as string).toMatch(
      /skipWorkflowUsageWarning/,
    );
    expect(registry.list()).toHaveLength(2);
    expect(registry.list()[0]!.status).toBe('failed');
    expect(registry.list()[1]!.status).toBe('completed');
  });

  it('P5 R1 #10: capped banner shape (`total !== null`) — was untested', async () => {
    const { config } = configWithRegistry();
    const originalEnv = process.env['QWEN_CODE_MAX_TOKENS_PER_WORKFLOW'];
    process.env['QWEN_CODE_MAX_TOKENS_PER_WORKFLOW'] = '50000';
    try {
      const tool = new WorkflowTool(config, { dispatch: async () => 'ok' });
      const result = await tool
        .build({ script: 'return 1' })
        .execute(new AbortController().signal);
      const display = result.returnDisplay as string;
      // Capped banner has "Workflow token cap is <total>" copy.
      expect(display).toMatch(/Workflow token cap is 50000/);
      expect(display).toMatch(/skipWorkflowUsageWarning/);
      // Capped banner must NOT carry the uncapped "have no per-run" copy.
      expect(display).not.toMatch(/Workflows have no per-run token cap/);
    } finally {
      if (originalEnv === undefined) {
        delete process.env['QWEN_CODE_MAX_TOKENS_PER_WORKFLOW'];
      } else {
        process.env['QWEN_CODE_MAX_TOKENS_PER_WORKFLOW'] = originalEnv;
      }
    }
  });
});
