/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
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

describe('the Step 3A workflow script', () => {
  it('declares a meta block the sandbox will accept as a pure literal', () => {
    // `meta` must be the first statement and must contain no variables, calls
    // or interpolation — the runtime reads it before executing anything.
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
    expect(metaBlock).not.toMatch(/\$\{|\bfunction\b|\(\s*\)|\.\.\./);
  });

  it('uses no non-deterministic builtin — the sandbox throws on them', () => {
    // Both would break resume, which replays the same call sequence.
    expect(REVIEW_STEP_3A_WORKFLOW_SCRIPT).not.toContain('Date.now');
    expect(REVIEW_STEP_3A_WORKFLOW_SCRIPT).not.toContain('Math.random');
    expect(REVIEW_STEP_3A_WORKFLOW_SCRIPT).not.toContain('new Date');
  });

  it('dispatches every agent in the roster, once each', async () => {
    const { result, dispatched, phases } = await runScript(
      { agents: AGENTS },
      async (prompt) => `said:${prompt}`,
    );
    expect(dispatched).toHaveLength(3);
    expect(phases).toEqual(['Review']);
    expect(
      (result as { rosterSize: number; missingRoles: string[] }).rosterSize,
    ).toBe(3);
    expect((result as { missingRoles: string[] }).missingRoles).toEqual([]);
  });

  it('passes each prompt through untouched and labels the agent by roster key', async () => {
    // The prompts are values the CLI computed. The script's contract is that
    // it does not read, trim, wrap or annotate them — which is the property
    // the whole migration exists to make structural.
    const { dispatched } = await runScript(
      { agents: AGENTS },
      async (prompt) => `said:${prompt}`,
    );
    expect(dispatched.map((d) => d.prompt)).toEqual([
      'PROMPT-1a',
      'PROMPT-2',
      'PROMPT-7',
    ]);
    expect(dispatched.map((d) => (d.opts as { label: string }).label)).toEqual([
      '1a',
      '2',
      '7',
    ]);
  });

  it('names the agents that returned nothing instead of dropping them', async () => {
    // parallel() reports a dead dispatch as a null element rather than
    // throwing. A script that ignored that would return a short findings list
    // and no indication a dimension went unreviewed — the one regression this
    // path must not introduce.
    const { result } = await runScript({ agents: AGENTS }, async (prompt) => {
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
    const { result } = await runScript({ agents: AGENTS }, async (prompt) =>
      prompt === 'PROMPT-7' ? undefined : `said:${prompt}`,
    );
    expect((result as { missingRoles: string[] }).missingRoles).toEqual(['7']);
  });

  it('carries each agent return back under its roster key', async () => {
    const { result } = await runScript(
      { agents: AGENTS },
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
