/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { createContext, Script } from 'node:vm';
import { REVIEW_STEP_3A_WORKFLOW_SCRIPT } from './workflow-script.js';

// The script is a fixed constant, so it can be RUN rather than merely parsed —
// which is the whole reason it is a constant and not generated source. These
// cases execute it against a stub dispatch and assert what it did.
//
// The harness below is an analogue of the sandbox, not the sandbox itself:
// `createWorkflowSandbox` is not exported from the core package, and importing
// it would make this a cross-package change for no gain in what is actually
// being checked here — the script's own logic. The one assumption made is the
// documented one: the sandbox strips the `export` from `export const meta` and
// runs the rest as an async function body. Everything downstream of that (the
// roster loop, verbatim prompt passing, null handling, the return shape) is
// this script's behaviour and is exercised for real. The sandbox's own
// constraints are asserted separately, and the real runtime executes this
// end-to-end when the skill is wired to it.
async function runScript(
  args: unknown,
  dispatch: (prompt: string, opts: unknown) => Promise<unknown>,
): Promise<{
  result: unknown;
  dispatched: Array<{ prompt: string; opts: unknown }>;
  logs: string[];
  phases: string[];
}> {
  const dispatched: Array<{ prompt: string; opts: unknown }> = [];
  const logs: string[] = [];
  const phases: string[] = [];

  const agent = async (prompt: string, opts: unknown) => {
    dispatched.push({ prompt, opts });
    return dispatch(prompt, opts);
  };
  // Mirrors the runtime's errors-as-data contract: a thunk that rejects
  // becomes a `null` element, and the call itself never rejects.
  const parallel = async (thunks: Array<() => Promise<unknown>>) =>
    Promise.all(thunks.map((t) => t().catch(() => null)));

  const body = REVIEW_STEP_3A_WORKFLOW_SCRIPT.replace(
    'export const meta =',
    'const meta =',
  );
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  const fn = new AsyncFunction(
    'args',
    'agent',
    'parallel',
    'phase',
    'log',
    body,
  );
  const result = await fn(
    args,
    agent,
    parallel,
    (t: string) => phases.push(t),
    (m: string) => logs.push(m),
  );
  return { result, dispatched, logs, phases };
}

const AGENTS = [
  { key: '1a', label: 'Line-by-line correctness', prompt: 'PROMPT-1a' },
  { key: '2', label: 'Security', prompt: 'PROMPT-2' },
  { key: '7', label: 'Build & Test', prompt: 'PROMPT-7' },
];

// The payload shape `emit-workflow` writes: version pinned to what this
// script reads, agents under their roster keys.
const ARGS = { version: 1, agents: AGENTS };

describe('the Step 3A workflow script', () => {
  it('declares a meta block the sandbox can evaluate in a bare context', () => {
    // `meta` must be the first statement, and the runtime evaluates it in a
    // bare vm context — a null-prototyped globalThis with no bridge globals —
    // before executing anything. A variable reference or call inside the
    // literal therefore dies before any agent launches. Do exactly that
    // evaluation instead of pattern-matching the shapes a regex can see.
    expect(
      REVIEW_STEP_3A_WORKFLOW_SCRIPT.startsWith('export const meta = {'),
    ).toBe(true);
    expect(REVIEW_STEP_3A_WORKFLOW_SCRIPT).toMatch(
      /^export const meta = \{[^]*?\n\};/,
    );
    const metaBlock = REVIEW_STEP_3A_WORKFLOW_SCRIPT.slice(
      0,
      REVIEW_STEP_3A_WORKFLOW_SCRIPT.indexOf('\n};') + 3,
    );
    const metaSource = metaBlock.slice(
      metaBlock.indexOf('{'),
      metaBlock.lastIndexOf('}') + 1,
    );
    const meta = new Script('(' + metaSource + ')').runInContext(
      createContext(Object.create(null)),
    ) as {
      name: string;
      description: string;
      phases: Array<{ title: string; detail: string }>;
    };
    expect(meta.name).toBe('review-step-3a');
    expect(meta.description).toBe(
      'Review Step 3A: launch every agent the plan requires, in one fan-out',
    );
    expect(meta.phases.map((p) => p.title)).toEqual(['Review']);
  });

  it('uses no non-deterministic builtin — the sandbox throws on them', () => {
    // Both would break resume, which replays the same call sequence.
    expect(REVIEW_STEP_3A_WORKFLOW_SCRIPT).not.toContain('Date.now');
    expect(REVIEW_STEP_3A_WORKFLOW_SCRIPT).not.toContain('Math.random');
    expect(REVIEW_STEP_3A_WORKFLOW_SCRIPT).not.toContain('new Date');
  });

  it('refuses a payload without an agents array, naming the args file', async () => {
    // A missing args, a path string passed where the object belongs, and an
    // object without agents must all fail with the emit-workflow hint — not
    // as a bare vm TypeError naming nothing about where args come from.
    for (const bad of [undefined, '/tmp/out/args.json', { version: 1 }]) {
      await expect(runScript(bad, async () => 'x')).rejects.toThrow(
        'args.agents is missing or not an array',
      );
    }
  });

  it('refuses an args version this script does not read', async () => {
    await expect(
      runScript({ version: 2, agents: AGENTS }, async () => 'x'),
    ).rejects.toThrow('args version 2 does not match this script');
  });

  it('dispatches every agent in the roster, once each', async () => {
    const { result, dispatched, phases } = await runScript(
      ARGS,
      async (prompt) => `said:${prompt}`,
    );
    expect(dispatched).toHaveLength(3);
    expect(phases).toEqual(['Review']);
    expect(
      (result as { rosterSize: number; missingRoles: string[] }).rosterSize,
    ).toBe(3);
    expect((result as { missingRoles: string[] }).missingRoles).toEqual([]);
  });

  it('passes each prompt through untouched and labels the agent with its roster label', async () => {
    // The prompts are values the CLI computed. The script's contract is that
    // it does not read, trim, wrap or annotate them — which is the property
    // the whole migration exists to make structural. The label is the
    // human-readable identity the args carry, for the run's progress display.
    const { dispatched } = await runScript(
      ARGS,
      async (prompt) => `said:${prompt}`,
    );
    expect(dispatched.map((d) => d.prompt)).toEqual([
      'PROMPT-1a',
      'PROMPT-2',
      'PROMPT-7',
    ]);
    expect(dispatched.map((d) => (d.opts as { label: string }).label)).toEqual([
      'Line-by-line correctness',
      'Security',
      'Build & Test',
    ]);
  });

  it('names the agents that returned nothing instead of dropping them', async () => {
    // parallel() reports a dead dispatch as a null element rather than
    // throwing. A script that ignored that would return a short findings list
    // and no indication a dimension went unreviewed — the one regression this
    // path must not introduce.
    const { result } = await runScript(ARGS, async (prompt) => {
      if (prompt === 'PROMPT-2') throw new Error('agent died');
      return `said:${prompt}`;
    });
    const r = result as {
      rosterSize: number;
      delivered: Array<{ key: string; text: string }>;
      missingRoles: string[];
    };
    expect(r.missingRoles).toEqual(['2']);
    expect(r.rosterSize).toBe(3);
    expect(r.delivered.map((d) => d.key)).toEqual(['1a', '7']);
  });

  it('treats an undefined return as missing, not as an empty finding set', async () => {
    const { result } = await runScript(ARGS, async (prompt) =>
      prompt === 'PROMPT-7' ? undefined : `said:${prompt}`,
    );
    expect((result as { missingRoles: string[] }).missingRoles).toEqual(['7']);
  });

  it('carries each agent return back under its roster key', async () => {
    const { result } = await runScript(
      ARGS,
      async (prompt) => `said:${prompt}`,
    );
    expect(
      (result as { delivered: Array<{ key: string; text: string }> }).delivered,
    ).toEqual([
      { key: '1a', text: 'said:PROMPT-1a' },
      { key: '2', text: 'said:PROMPT-2' },
      { key: '7', text: 'said:PROMPT-7' },
    ]);
  });
});
