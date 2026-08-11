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
// The harness below is an analogue of the sandbox for the script's own logic —
// the roster loop, verbatim prompt passing, missing-role accounting, the
// return shape. The ways the real sandbox differs from a host-realm function
// (meta stripped outright, async-IIFE wrap, null-prototype globalThis with no
// host handles) are covered separately by the bare-vm test at the bottom.
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

/**
 * The runtime strips the whole leading `export const meta = {...};`
 * declaration before executing. Mirrored for the bare-vm test: on this
 * script's shape the declaration is the leading statement and ends at the
 * first line-closing `};`.
 */
function stripMeta(source: string): string {
  const marker = '\n};';
  const end = source.indexOf(marker);
  return source.slice(end + marker.length);
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

  it('keeps the executed body free of host-realm handles', () => {
    // The sandbox runs on a null-prototype globalThis with no `process` and
    // no `require`, and strips the meta declaration outright — so the body
    // that executes may reference neither, nor `meta` itself. A script that
    // does passes every host-realm test and dies at dispatch.
    const body = stripMeta(REVIEW_STEP_3A_WORKFLOW_SCRIPT);
    expect(body).not.toMatch(/\bprocess\b/);
    expect(body).not.toMatch(/\brequire\s*\(/);
    expect(body).not.toMatch(/\bmeta\b/);
  });

  it('refuses a payload without an agents array, naming the remediation', async () => {
    // A missing args, a path string passed where the object belongs, and an
    // object without agents must all fail with the emit-workflow hint — not
    // as a bare vm TypeError naming nothing about where args come from. The
    // hint must name the REAL remediation (pass the file's parsed contents
    // inline), because passing the path is exactly what the emitted stdout
    // used to instruct and the tool cannot honor.
    for (const bad of [undefined, '/tmp/out/args.json', { version: 1 }]) {
      await expect(runScript(bad, async () => 'x')).rejects.toThrow(
        'args.agents is missing or not an array',
      );
      await expect(runScript(bad, async () => 'x')).rejects.toThrow(
        'PARSED CONTENTS',
      );
    }
  });

  it('refuses an empty agents array instead of settling as a zero-agent complete review', async () => {
    // parallel([]) resolves cleanly, so without this guard a truncated or
    // hand-edited args file returns the exact shape of a completed review
    // in which no agent ran.
    await expect(
      runScript({ version: 1, agents: [] }, async () => 'x'),
    ).rejects.toThrow('args.agents is empty');
  });

  it('refuses a malformed agent entry before dispatching any of them', async () => {
    // A null or truncated element otherwise dies mid-fan-out — after earlier
    // agents already ran — as a bare TypeError.
    const valid = AGENTS[0];
    for (const bad of [
      { version: 1, agents: [valid, null] },
      { version: 1, agents: [{ key: '1a', label: 'x' }] },
      { version: 1, agents: [{ key: '1a', label: 'x', prompt: '' }] },
    ]) {
      const run = runScript(bad, async () => 'x');
      await expect(run).rejects.toThrow('is not a dispatchable agent entry');
      // The guard fires before any dispatch happens.
      await expect(
        runScript(bad, async () => {
          throw new Error('must not dispatch');
        }),
      ).rejects.toThrow('is not a dispatchable agent entry');
    }
  });

  it('refuses an args version this script does not read', async () => {
    await expect(
      runScript({ version: 2, agents: AGENTS }, async () => 'x'),
    ).rejects.toThrow('args version 2 does not match this script');
  });

  it('fails closed before any phase transition', async () => {
    // A corrupt payload must not advance the run's phase state: the error
    // record of a run that dispatched nothing may not show a Review phase.
    const phases: string[] = [];
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
    await expect(
      fn(
        { version: 1 },
        async () => 'x',
        async () => [],
        (t: string) => phases.push(t),
        () => {},
      ),
    ).rejects.toThrow('args.agents is missing or not an array');
    expect(phases).toEqual([]);
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

  it('treats an empty or non-string return as missing, not as delivered', async () => {
    // An agent that terminates with no visible text has nothing to show for
    // its dimension; counting it as delivered yields the exact shape the
    // script exists to prevent — a completed review that reviewed nothing.
    const { result } = await runScript(ARGS, async (prompt) => {
      if (prompt === 'PROMPT-1a') return '';
      if (prompt === 'PROMPT-2') return '   \n  ';
      return `said:${prompt}`;
    });
    const r = result as {
      delivered: Array<{ key: string; text: string }>;
      missingRoles: string[];
    };
    expect(r.missingRoles).toEqual(['1a', '2']);
    expect(r.delivered).toEqual([{ key: '7', text: 'said:PROMPT-7' }]);
  });

  it('throws when no agent returned anything, instead of returning a clean shape', async () => {
    // A fully failed fan-out must read as a failure, not as
    // {rosterSize: N, delivered: [], missingRoles: [...]} — which a
    // consumer that trusts "the workflow returned" would log and move on.
    await expect(
      runScript(ARGS, async () => {
        throw new Error('provider overloaded');
      }),
    ).rejects.toThrow('delivered nothing');
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

  it('runs unchanged in a bare vm realm with only the documented globals', async () => {
    // The real sandbox strips the meta declaration, wraps the body in an
    // async IIFE, and runs it on a null-prototype globalThis with no host
    // handles. Do exactly that here, so a future edit that leans on a
    // host-only global fails in a unit test instead of at dispatch.
    const dispatched: Array<{ prompt: string; label: string }> = [];
    const logs: string[] = [];
    const phases: string[] = [];
    const sandboxGlobals = Object.assign(Object.create(null), {
      args: undefined as unknown,
      agent: async (prompt: string, opts: { label: string }) => {
        dispatched.push({ prompt, label: opts.label });
        return `said:${prompt}`;
      },
      parallel: async (thunks: Array<() => Promise<unknown>>) =>
        Promise.all(thunks.map((t) => t().catch(() => null))),
      phase: (t: string) => {
        phases.push(t);
      },
      log: (m: string) => {
        logs.push(m);
      },
    });
    const ctx = createContext(sandboxGlobals);
    // args crosses the runtime boundary as a JSON string parsed inside the
    // vm realm; mirror that rather than handing the object across.
    sandboxGlobals.args = new Script('JSON.parse').runInContext(ctx)(
      JSON.stringify(ARGS),
    );
    const wrapped = `(async () => {\n${stripMeta(
      REVIEW_STEP_3A_WORKFLOW_SCRIPT,
    )}\n})()`;
    const result = (await new Script(wrapped).runInContext(ctx)) as {
      rosterSize: number;
      delivered: Array<{ key: string; text: string }>;
      missingRoles: string[];
    };
    expect(phases).toEqual(['Review']);
    expect(logs).toContain('3 agents required by the plan');
    expect(dispatched.map((d) => d.prompt)).toEqual([
      'PROMPT-1a',
      'PROMPT-2',
      'PROMPT-7',
    ]);
    expect(result.rosterSize).toBe(3);
    expect(result.missingRoles).toEqual([]);
    expect(result.delivered.map((d) => d.key)).toEqual(['1a', '2', '7']);
  });
});
