/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * P4a real-LLM E2E — drives WorkflowOrchestrator with a dispatch that hits
 * qwen3-coder-plus via DashScope. Skipped by default; runs only when
 * `DASHSCOPE_API_KEY` is set in the environment.
 *
 * Verifies end-to-end:
 *  - extractAndStripMeta correctly parses `export const meta = {...}` from a
 *    script that ALSO contains real agent() calls (the meta strip does not
 *    confuse the brace walker when followed by an executable body)
 *  - the script body runs successfully after the meta block is stripped
 *    (agent() returns a real LLM response)
 *  - outcome.meta surfaces on the resolved WorkflowRunOutcome
 *  - WorkflowExecutionError.meta is carried through on a body-throw path
 *    (failure path of safeStringifyDisplayPayload in WorkflowTool)
 *  - a missing required field on the meta literal throws BEFORE any agent
 *    call (no LLM budget burnt on a malformed meta)
 *
 * Why this is in addition to the unit tests: the unit tests exercise
 * extractAndStripMeta and the orchestrator with a fake dispatch. This
 * test wires the same code through a real LLM call so we know the P3
 * dispatch surface and the P4a meta surface coexist without interference
 * in the live path.
 */

import { describe, it, expect } from 'vitest';
import {
  WorkflowOrchestrator,
  WorkflowExecutionError,
  type WorkflowAgentDispatch,
} from './workflow-orchestrator.js';
import type { WorkflowAgentOpts } from './workflow-sandbox.js';

const apiKey = process.env['DASHSCOPE_API_KEY'];
const baseUrl =
  process.env['DASHSCOPE_BASE_URL'] ||
  'https://dashscope.aliyuncs.com/compatible-mode/v1';
const MODEL = 'qwen3-coder-plus';

// Inferred return type is Promise<string> so callers can assign directly to
// `string`. `WorkflowAgentDispatch` widens the return to
// `string | object` (the schema-mode object shape), which is fine for
// orchestrator interop because string is a subtype — but `lastText: string`
// downstream would not accept the wider type.
const liveDispatch = async (
  prompt: string,
  _opts: WorkflowAgentOpts,
): Promise<string> => {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        {
          role: 'system',
          content:
            'You are a workflow subagent. Return the final answer as plain text only — no preamble, no markdown, no quotes. Keep the answer terse (≤ 1 sentence).',
        },
        { role: 'user', content: prompt },
      ],
      temperature: 0,
      max_tokens: 80,
    }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`DashScope ${res.status}: ${txt.slice(0, 200)}`);
  }
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return (data.choices?.[0]?.message?.content ?? '').trim();
};

// Mirrors WorkflowTool.safeStringifyDisplayPayload — same conditional
// inclusion of `meta` only when set, same key ordering.
function formatDisplay(outcome: {
  runId: string;
  meta?: unknown;
  phases: unknown;
  logs: unknown;
  result: unknown;
}): string {
  const payload: Record<string, unknown> = {
    runId: outcome.runId,
    ...(outcome.meta ? { meta: outcome.meta } : {}),
    phases: outcome.phases,
    logs: outcome.logs,
    result: outcome.result,
  };
  return JSON.stringify(payload, null, 2);
}

const describeOrSkip = apiKey ? describe : describe.skip;

describeOrSkip('P4a real-LLM E2E (DashScope qwen3-coder-plus)', () => {
  it('A: meta declaration parsed + agent call returns real LLM text', async () => {
    let agentCalls = 0;
    let lastText = '';
    const tap: WorkflowAgentDispatch = async (prompt, opts) => {
      agentCalls++;
      lastText = await liveDispatch(prompt, opts);
      return lastText;
    };
    const orch = new WorkflowOrchestrator(tap);
    const outcome = await orch.run({
      args: undefined,
      script: `
          export const meta = {
            name: 'capitals',
            description: 'Look up capitals via a single agent call',
            whenToUse: 'demo only',
            phases: [{ title: 'Lookup', detail: 'one agent call' }],
          }
          phase('Lookup')
          const answer = await agent('What is the capital of France? Reply with the single city name only.')
          return { answer }
        `,
    });
    const display = formatDisplay(outcome);
    console.log('[A] display:', display);
    console.log('[A] llm text:', lastText);

    expect(outcome.meta).toEqual({
      name: 'capitals',
      description: 'Look up capitals via a single agent call',
      whenToUse: 'demo only',
      phases: [{ title: 'Lookup', detail: 'one agent call' }],
    });
    expect(display).toContain('"meta":');
    expect(display).toContain('"name": "capitals"');
    expect(display).toContain('"whenToUse": "demo only"');
    // Adversarial review (HIGH × 3 lenses): toEqual is structural and does
    // NOT check prototype identity. A regression that returns the vm-realm
    // `raw` value directly (skipping the host-realm copy at workflow-
    // sandbox.ts:283-294) would re-open the T1/T8/T14 realm escape via
    // `outcome.meta.constructor.constructor('return process')()`. Verify the
    // returned object AND its nested phases array AND phase entries are all
    // host-realm — the toEqual above doesn't catch any of these.
    expect(Object.getPrototypeOf(outcome.meta)).toBe(Object.prototype);
    const metaPhases = (outcome.meta as { phases: object[] }).phases;
    expect(Object.getPrototypeOf(metaPhases)).toBe(Array.prototype);
    expect(Object.getPrototypeOf(metaPhases[0])).toBe(Object.prototype);
    expect(agentCalls).toBe(1);
    expect(lastText.toLowerCase()).toMatch(/paris/);
    expect((outcome.result as { answer: string }).answer.toLowerCase()).toMatch(
      /paris/,
    );
  }, 60_000);

  it('B: script with NO meta — outcome.meta is null and display omits meta', async () => {
    let agentCalls = 0;
    let lastText = '';
    const tap: WorkflowAgentDispatch = async (prompt, opts) => {
      agentCalls++;
      lastText = await liveDispatch(prompt, opts);
      return lastText;
    };
    const orch = new WorkflowOrchestrator(tap);
    const outcome = await orch.run({
      args: undefined,
      script: `
          phase('Lookup')
          const answer = await agent('What is the capital of Japan? Reply with the single city name only.')
          return { answer }
        `,
    });
    const display = formatDisplay(outcome);
    console.log('[B] display:', display);
    console.log('[B] llm text:', lastText);

    expect(outcome.meta).toBeNull();
    const parsed = JSON.parse(display) as Record<string, unknown>;
    expect('meta' in parsed).toBe(false);
    expect(agentCalls).toBe(1);
    expect(lastText.toLowerCase()).toMatch(/tokyo/);
  }, 60_000);

  it('C: malformed meta (missing name) — throws before any agent call', async () => {
    let agentCalls = 0;
    const tap: WorkflowAgentDispatch = async (prompt, opts) => {
      agentCalls++;
      return liveDispatch(prompt, opts);
    };
    const orch = new WorkflowOrchestrator(tap);
    await expect(
      orch.run({
        args: undefined,
        script: `
            export const meta = { description: 'missing name field' }
            phase('Lookup')
            const answer = await agent('Should not be called')
            return { answer }
          `,
      }),
    ).rejects.toThrow(/meta\.name/i);
    expect(agentCalls).toBe(0);
  }, 20_000);

  it('D: meta survives on WorkflowExecutionError when body throws', async () => {
    let agentCalls = 0;
    let lastText = '';
    const tap: WorkflowAgentDispatch = async (prompt, opts) => {
      agentCalls++;
      lastText = await liveDispatch(prompt, opts);
      return lastText;
    };
    const orch = new WorkflowOrchestrator(tap);
    let caught: unknown;
    try {
      await orch.run({
        args: undefined,
        script: `
            export const meta = {
              name: 'throws-after-agent',
              description: 'agent runs then body throws',
            }
            phase('Lookup')
            const answer = await agent('What is the capital of Italy? Reply with the single city name only.')
            throw new Error('intentional script body failure')
          `,
      });
    } catch (e) {
      caught = e;
    }
    console.log('[D] caught:', String(caught));
    console.log('[D] llm text:', lastText);
    expect(caught).toBeInstanceOf(WorkflowExecutionError);
    const err = caught as WorkflowExecutionError;
    expect(err.meta).toEqual({
      name: 'throws-after-agent',
      description: 'agent runs then body throws',
    });
    expect(err.message).toMatch(/intentional script body failure/);
    expect(agentCalls).toBe(1);
    expect(lastText.toLowerCase()).toMatch(/rome/);
  }, 60_000);

  it('E: real-world parallel() fan-out — meta.phases titles match executed phases', async () => {
    const seen: string[] = [];
    const tap: WorkflowAgentDispatch = async (prompt, opts) => {
      const out = await liveDispatch(prompt, opts);
      seen.push(out);
      return out;
    };
    const orch = new WorkflowOrchestrator(tap);
    const outcome = await orch.run({
      args: undefined,
      script: `
          export const meta = {
            name: 'multi-lens-review',
            description: 'Fan out 3 reviewers in parallel, return the verdicts',
            phases: [
              { title: 'Review', detail: '3 lenses in parallel' },
            ],
          }
          phase('Review')
          const verdicts = await parallel([
            () => agent('Return the single word RED.'),
            () => agent('Return the single word GREEN.'),
            () => agent('Return the single word BLUE.'),
          ])
          return { verdicts }
        `,
    });
    console.log('[E] meta:', JSON.stringify(outcome.meta));
    console.log('[E] phases:', JSON.stringify(outcome.phases));
    console.log('[E] result:', JSON.stringify(outcome.result));
    console.log('[E] seen verdicts:', JSON.stringify(seen));

    expect(outcome.meta).toEqual({
      name: 'multi-lens-review',
      description: 'Fan out 3 reviewers in parallel, return the verdicts',
      phases: [{ title: 'Review', detail: '3 lenses in parallel' }],
    });
    expect(outcome.phases).toEqual(['Review']);
    // meta.phases[].title must match what actually ran — this catches a
    // future regression where the meta declaration drifts from the script
    // body or where extractAndStripMeta returns a stale/leaked binding.
    const declaredTitles = (
      outcome.meta as { phases: Array<{ title: string }> }
    ).phases.map((p) => p.title);
    expect(declaredTitles).toEqual(outcome.phases);

    const verdicts = (outcome.result as { verdicts: string[] }).verdicts;
    expect(verdicts).toHaveLength(3);
    // Position-aligned to the parallel() input order.
    expect(verdicts[0].toUpperCase()).toContain('RED');
    expect(verdicts[1].toUpperCase()).toContain('GREEN');
    expect(verdicts[2].toUpperCase()).toContain('BLUE');
    expect(seen).toHaveLength(3);
  }, 90_000);

  it('F: real-world pipeline() multi-stage — meta.phases declares both, both run', async () => {
    let translateCalls = 0;
    let upperCalls = 0;
    const tap: WorkflowAgentDispatch = async (prompt, opts) => {
      if (prompt.includes('Translate')) translateCalls++;
      else if (prompt.includes('uppercase')) upperCalls++;
      return liveDispatch(prompt, opts);
    };
    const orch = new WorkflowOrchestrator(tap);
    const outcome = await orch.run({
      args: undefined,
      script: `
          export const meta = {
            name: 'translate-then-shout',
            description: 'Pipeline two stages per item: translate, then uppercase',
            phases: [
              { title: 'Translate', detail: 'EN -> FR' },
              { title: 'Shout', detail: 'uppercase' },
            ],
          }
          const inputs = ['cat', 'dog']
          const results = await pipeline(
            inputs,
            (word) => agent(\`Translate the English word "\${word}" to French. Reply with the single French word only.\`, { phase: 'Translate' }),
            (frenchWord) => agent(\`Return "\${frenchWord}" in uppercase. Reply with just the uppercase letters.\`, { phase: 'Shout' }),
          )
          return { results }
        `,
    });
    console.log('[F] meta:', JSON.stringify(outcome.meta));
    console.log('[F] phases:', JSON.stringify(outcome.phases));
    console.log('[F] result:', JSON.stringify(outcome.result));
    console.log('[F] dispatch counts:', { translateCalls, upperCalls });

    expect(outcome.meta).toEqual({
      name: 'translate-then-shout',
      description: 'Pipeline two stages per item: translate, then uppercase',
      phases: [
        { title: 'Translate', detail: 'EN -> FR' },
        { title: 'Shout', detail: 'uppercase' },
      ],
    });
    // Both declared phases were actually exercised in this run.
    const phaseSet = new Set(outcome.phases);
    expect(phaseSet.has('Translate')).toBe(true);
    expect(phaseSet.has('Shout')).toBe(true);

    const results = (outcome.result as { results: string[] }).results;
    expect(results).toHaveLength(2);
    // Each item flowed through BOTH stages — uppercase final.
    for (const r of results) {
      expect(r).toBe(r.toUpperCase());
      expect(r.length).toBeGreaterThan(0);
    }
    // Each input visited each stage exactly once.
    expect(translateCalls).toBe(2);
    expect(upperCalls).toBe(2);
  }, 120_000);
});
