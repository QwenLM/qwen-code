/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { REVIEW_BUILTIN_SUBAGENT_TYPE } from '@qwen-code/qwen-code-core';
import {
  buildReviewWorkflowScript,
  FAN_OUT_BODY,
  type WorkflowAgentSpec,
} from './workflow-script.js';

// The generated script is executed here, not merely parsed — which is the
// reason the logic is a fixed constant and only the roster is spliced in.
// Every case below runs the REAL output of `buildReviewWorkflowScript`, so a
// roster that serialized wrong would fail these as surely as a broken loop.
//
// The harness is an analogue of the sandbox, not the sandbox itself:
// `createWorkflowSandbox` is not exported from the core package, and importing
// it would make this a cross-package change for no gain in what is being
// checked — this script's own behaviour. The one assumption is the documented
// one: `export const meta = {...}` is stripped and the rest runs as an async
// function body. The real runtime executes it end-to-end when the skill is
// wired to it.
async function runScript(
  script: string,
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

  const body = script.replace('export const meta =', 'const meta =');
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  const fn = new AsyncFunction('agent', 'parallel', 'phase', 'log', body);
  const result = await fn(
    agent,
    parallel,
    (t: string) => phases.push(t),
    (m: string) => logs.push(m),
  );
  return { result, dispatched, logs, phases };
}

const AGENTS: WorkflowAgentSpec[] = [
  { key: '1a', prompt: 'PROMPT-1a' },
  { key: '2', prompt: 'PROMPT-2' },
  { key: '7', prompt: 'PROMPT-7' },
];

describe('the generated Step 3A fan-out script', () => {
  it('opens with a meta block the sandbox will accept as a pure literal', () => {
    const script = buildReviewWorkflowScript(AGENTS);
    expect(script.startsWith('export const meta = {')).toBe(true);
    const metaBlock = script.slice(0, script.indexOf('\n};') + 3);
    // `meta` is read before anything executes, so it may hold no variable,
    // call, spread or interpolation.
    expect(metaBlock).not.toMatch(/\$\{|\bfunction\b|\.\.\./);
  });

  it('uses no non-deterministic builtin — the sandbox throws on them', () => {
    const script = buildReviewWorkflowScript(AGENTS);
    expect(script).not.toContain('Date.now');
    expect(script).not.toContain('Math.random');
    expect(script).not.toContain('new Date');
  });

  it('dispatches every agent in the roster, once each, in one phase', async () => {
    const { result, dispatched, phases } = await runScript(
      buildReviewWorkflowScript(AGENTS),
      async (prompt) => `said:${prompt}`,
    );
    expect(dispatched).toHaveLength(3);
    expect(phases).toEqual(['Review']);
    expect((result as { rosterSize: number }).rosterSize).toBe(3);
    expect((result as { missingRoles: string[] }).missingRoles).toEqual([]);
  });

  it('passes each prompt through untouched, having survived serialization', async () => {
    // The prompts are values the CLI computed and this file carries. The
    // script's contract is that it does not read, trim, wrap or annotate
    // them — the property the whole change exists to make structural. The
    // awkward characters are here because the roster reaches the script
    // through JSON embedded in JavaScript source, where a stray backtick,
    // backslash or `${` would previously have ended the literal.
    const tricky: WorkflowAgentSpec[] = [
      {
        key: 'x',
        prompt: 'back`tick ${notInterpolated} \\ "quote" \n newline',
      },
      { key: 'y', prompt: "</script> and 'single' quotes" },
    ];
    const { dispatched } = await runScript(
      buildReviewWorkflowScript(tricky),
      async (prompt) => `said:${prompt}`,
    );
    expect(dispatched.map((d) => d.prompt)).toEqual([
      'back`tick ${notInterpolated} \\ "quote" \n newline',
      "</script> and 'single' quotes",
    ]);
  });

  it('asks for the same subagent type the hand-launched path requires', async () => {
    // The hand-launched path is mandated to set `subagent_type:
    // "review-agent"` (SKILL.md, TYPE_NOTE, and the registry's explicit tool
    // list). Dispatching any other type — including the inherit-everything
    // `general-purpose` default — runs a different agent over identical
    // prompts and makes the A/B between the two paths unreadable. Both
    // dispatch branches are exercised: the worktree-pinned shape and the
    // shape a review without a worktree takes.
    for (const script of [
      buildReviewWorkflowScript(AGENTS),
      buildReviewWorkflowScript(AGENTS, '/tmp/review-pr-42'),
    ]) {
      const { dispatched } = await runScript(
        script,
        async (prompt) => `said:${prompt}`,
      );
      for (const d of dispatched) {
        expect((d.opts as { agentType: string }).agentType).toBe(
          REVIEW_BUILTIN_SUBAGENT_TYPE,
        );
      }
      expect(
        dispatched.map((d) => (d.opts as { label: string }).label),
      ).toEqual(['1a', '2', '7']);
    }
  });

  // The pin is the whole reason a worktree review may take this path at all.
  // Without it every dispatched agent reads the user's main checkout and
  // reports findings that describe the wrong tree — plausibly, and at length.
  it('pins every agent to the review worktree when the plan has one', async () => {
    const { dispatched } = await runScript(
      buildReviewWorkflowScript(AGENTS, '/tmp/review-pr-42'),
      async (prompt) => `said:${prompt}`,
    );
    expect(dispatched).toHaveLength(3);
    for (const d of dispatched) {
      expect((d.opts as { workingDir?: string }).workingDir).toBe(
        '/tmp/review-pr-42',
      );
      // Mutually exclusive with the pin; passing both fails every dispatch.
      expect((d.opts as { isolation?: unknown }).isolation).toBeUndefined();
    }
  });

  // `agent({workingDir})` refuses an empty string rather than reading it as
  // "no pin", so a review with no worktree must omit the key entirely — not
  // pass null, '' or undefined under it.
  it('omits the pin entirely for a review with no worktree', async () => {
    for (const absent of [undefined, '']) {
      const { dispatched } = await runScript(
        buildReviewWorkflowScript(AGENTS, absent),
        async (prompt) => `said:${prompt}`,
      );
      for (const d of dispatched) {
        expect('workingDir' in (d.opts as object)).toBe(false);
      }
    }
  });

  it('names the agents that returned nothing instead of dropping them', async () => {
    // parallel() reports a dead dispatch as a null element rather than
    // throwing. A script that ignored that would return a short findings list
    // with no sign a dimension went unreviewed.
    const { result } = await runScript(
      buildReviewWorkflowScript(AGENTS),
      async (prompt) => {
        if (prompt === 'PROMPT-2') throw new Error('agent died');
        return `said:${prompt}`;
      },
    );
    const r = result as {
      delivered: Array<{ key: string }>;
      missingRoles: string[];
    };
    expect(r.missingRoles).toEqual(['2']);
    expect(r.delivered.map((d) => d.key)).toEqual(['1a', '7']);
  });

  it('treats an undefined return as missing, not as an empty finding set', async () => {
    const { result } = await runScript(
      buildReviewWorkflowScript(AGENTS),
      async (prompt) => (prompt === 'PROMPT-7' ? undefined : `said:${prompt}`),
    );
    expect((result as { missingRoles: string[] }).missingRoles).toEqual(['7']);
  });

  it('counts a result that strips to empty as missing, not delivered', async () => {
    // A GOAL-mode dispatch can finish with visible text that strips to
    // nothing — a scratchpad-only final message, or a cutoff mid-analysis.
    // It fulfilled, so the null check passes it; counting it delivered would
    // assert a complete fan-out while one dimension contributed nothing, and
    // Step 3D cannot catch it — the agent was launched, so a transcript
    // exists.
    for (const empty of ['', '   ']) {
      const { result } = await runScript(
        buildReviewWorkflowScript(AGENTS),
        async (prompt) => (prompt === 'PROMPT-2' ? empty : `said:${prompt}`),
      );
      const r = result as {
        delivered: Array<{ key: string }>;
        missingRoles: string[];
      };
      expect(r.missingRoles).toEqual(['2']);
      expect(r.delivered.map((d) => d.key)).toEqual(['1a', '7']);
    }
  });

  it('carries each agent return back under its roster key', async () => {
    const { result } = await runScript(
      buildReviewWorkflowScript(AGENTS),
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

  // A fan-out where nothing came back is a failed step, not a step with an
  // empty result. Returned as a value, it would let the caller aggregate over
  // a diff no agent read — the outcome the coverage gate exists to prevent,
  // reached without the gate being consulted.
  it('throws when every agent failed rather than returning an empty result', async () => {
    await expect(
      runScript(buildReviewWorkflowScript(AGENTS), async () => {
        throw new Error('all dead');
      }),
    ).rejects.toThrow(/all 3 agents failed to deliver/);
  });

  it('throws on an empty roster rather than reporting a clean review', async () => {
    // `buildReviewWorkflowScript([])` is not reachable from the command
    // today, but the guard is what makes "nobody ran" impossible to read as
    // "nothing to report" if it ever becomes reachable.
    await expect(
      runScript(buildReviewWorkflowScript([]), async () => 'unused'),
    ).rejects.toThrow(/roster is empty/);
  });

  it('splices the subagent type as a literal rather than spelling it', () => {
    // The literal comes from the same constant the hand-launched path's
    // TYPE_NOTE reads, so a rename of the builtin agent moves both.
    const script = buildReviewWorkflowScript(AGENTS);
    expect(script).toContain(
      `const AGENT_TYPE = ${JSON.stringify(REVIEW_BUILTIN_SUBAGENT_TYPE)};`,
    );
  });

  it('keeps the dispatch logic out of the generated half', () => {
    // Only the roster literal varies between reviews. If generation ever
    // starts emitting logic, this fails — and the executable guarantee above
    // stops covering what actually ships.
    const script = buildReviewWorkflowScript(AGENTS);
    expect(script.endsWith(FAN_OUT_BODY)).toBe(true);
    const generated = script.slice(0, script.length - FAN_OUT_BODY.length);
    expect(generated).not.toContain('parallel(');
    expect(generated).not.toContain('agent(');
  });
});
