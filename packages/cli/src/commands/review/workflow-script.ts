/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The Step 3A fan-out, as a workflow script.
//
// The script has two parts and only one of them varies. `FAN_OUT_BODY` is a
// fixed constant — the dispatch loop, the accounting, the fail-closed guards —
// and `buildReviewWorkflowScript` splices one JSON literal in front of it: the
// roster the CLI computed. No logic is generated, only data, so the part that
// can be wrong is the part a test can execute.
//
// Why the roster is baked in rather than passed as `args`, which is where the
// first version of this put it: the Workflow tool takes `args` as INLINE JSON
// (`WORKFLOW_PARAM_SCHEMA`: "Pass actual JSON, not a stringified value") and
// the vm sandbox has no filesystem — its globals are `agent`, `parallel`,
// `pipeline`, `phase`, `log`, `console`, `args`, `budget`, `workflow`, and
// nothing that opens a file. So an args-carried roster is a roster the model
// has to retype into its tool call, which is the failure this whole change
// exists to remove. Baked in, the model's call carries one path and no
// payload.
//
// Sandbox constraints this must respect (workflow-sandbox.ts):
//   - `meta` must be the first statement and a pure literal.
//   - `Date.now()` / `Math.random()` / `new Date()` throw — scripts are
//     deterministic so a resume can replay them.
//   - `parallel()` takes THUNKS and degrades a failed dispatch to a `null`
//     element rather than rejecting.
//
// No template literals below: this file stores script source inside host
// template literals, so a backtick would end one and a `${` would splice host
// state into the script. String concatenation instead, deliberately.

/** One agent, as the generated script's `AGENTS` literal carries it. */
export interface WorkflowAgentSpec {
  /** The roster key — `check-coverage` looks the agent up under this. */
  key: string;
  /** The launch prompt, verbatim from `buildLaunch`. Passed, never built. */
  prompt: string;
}

/**
 * The invariant half of the script: everything after the roster literal.
 *
 * Exported so its behaviour can be executed and asserted directly, rather
 * than inferred from the text of a generated file.
 */
export const FAN_OUT_BODY = `
if (!Array.isArray(AGENTS) || AGENTS.length === 0) {
  // An empty roster is not a clean review, it is a review that dispatched
  // nobody. Returning normally here would hand the caller zero findings and
  // zero missing roles, which reads as "nothing to report".
  throw new Error(
    'review fan-out: the generated roster is empty — no agent would run. ' +
      'Re-run \\'qwen review emit-workflow\\'.',
  );
}

phase('Review');
log(AGENTS.length + ' agents required by the plan');

// One thunk per required agent, dispatched together. The roster is data the
// CLI computed and wrote into this file; this loop cannot shorten it, and
// there is no branch in which an agent is skipped.
//
// agentType is 'general-purpose' for the same reason the hand-launched path
// sets subagent_type: workflow dispatch otherwise substitutes its own terse
// subagent persona, and the two paths would then be running different agents
// over identical prompts.
const returns = await parallel(
  AGENTS.map((a) => () =>
    agent(a.prompt, {
      label: a.key,
      phase: 'Review',
      agentType: 'general-purpose',
    }),
  ),
);

// parallel() reports a failed dispatch as a null element rather than throwing,
// so a role that died is indistinguishable from one that returned nothing
// unless the script looks. Collect them by name: an agent silently missing
// from the fan-out is the one regression this path must not introduce, and
// the coverage gate needs it named to fail closed on it.
const delivered = [];
const missingRoles = [];
for (let i = 0; i < AGENTS.length; i++) {
  const value = returns[i];
  if (value === null || value === undefined) {
    missingRoles.push(AGENTS[i].key);
  } else {
    delivered.push({ key: AGENTS[i].key, text: value });
  }
}

if (missingRoles.length > 0) {
  log(missingRoles.length + ' agent(s) returned nothing: ' + missingRoles.join(', '));
}

// A fan-out where nothing came back is a failed step, not a step with an empty
// result. Returning it as a value would let the caller proceed to aggregation
// over a diff no agent read — the exact outcome the coverage gate exists to
// prevent, arrived at without the gate ever being consulted.
if (delivered.length === 0) {
  throw new Error(
    'review fan-out: all ' + AGENTS.length + ' agents failed to deliver (' +
      missingRoles.join(', ') + '). Nothing was reviewed.',
  );
}

return {
  rosterSize: AGENTS.length,
  delivered: delivered,
  missingRoles: missingRoles,
};
`;

/**
 * The full script for one review: `meta`, the roster literal, and the body.
 *
 * `meta.phases` mirrors the skill's step names so the run's progress display
 * reads like the step it is executing.
 */
export function buildReviewWorkflowScript(
  agents: readonly WorkflowAgentSpec[],
): string {
  // Only the two fields the script reads are serialized. A field written here
  // and read nowhere would be a claim the file does not keep.
  const roster = agents.map((a) => ({ key: a.key, prompt: a.prompt }));
  return (
    `export const meta = {\n` +
    `  name: 'review-step-3a',\n` +
    `  description: 'Review Step 3A: launch every agent the plan requires, in one fan-out',\n` +
    `  phases: [{ title: 'Review', detail: 'one agent per required role' }],\n` +
    `};\n\n` +
    `// Written by \`qwen review emit-workflow\`. The roster below is the one\n` +
    `// \`check-coverage\` holds this run to; editing it makes the two disagree.\n` +
    `const AGENTS = ${JSON.stringify(roster, null, 2)};\n` +
    FAN_OUT_BODY
  );
}
