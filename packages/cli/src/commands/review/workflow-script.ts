/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The Step 3A fan-out, as a workflow script.
//
// This constant is the whole of the script. It is not a template, and nothing
// interpolates into it: every value that varies between reviews — which agents
// run, and the exact prompt each one gets — arrives through `args`, which
// `emit-workflow` writes. The script's only job is to dispatch what it is
// given and to account for what came back.
//
// Why a fixed constant rather than generated source: a generated script can
// only be checked by parsing it, whereas a fixed one can be *executed* against
// a stub dispatch and asserted on — which is what `workflow-script.test.ts`
// does. It is also the point at which "the orchestrator must not author the
// fan-out" stops being a convention and becomes a fact about the binary. The
// model does not write this and cannot edit it; it makes one tool call, and
// what the fan-out dispatches is what the CLI built.
//
// Sandbox constraints this must respect (workflow-sandbox.ts):
//   - `meta` must be a pure literal — no variables, calls, or interpolation.
//   - `Date.now()` / `Math.random()` throw; workflow scripts are deterministic
//     so a resume can replay them.
//   - `parallel()` takes THUNKS, and degrades a failed dispatch to a `null`
//     element rather than rejecting.
//
// No template literals anywhere below: this file stores the script inside a
// host template literal, so a backtick would end it and a `${` would splice
// host state into the script. String concatenation instead, deliberately.
export const REVIEW_STEP_3A_WORKFLOW_SCRIPT = `export const meta = {
  name: 'review-step-3a',
  description: 'Review Step 3A: launch every agent the plan requires, in one fan-out',
  phases: [{ title: 'Review', detail: 'one agent per required role' }],
};

// Fail closed on a payload this script cannot dispatch — BEFORE phase()
// advances the run's state, so a corrupt args file never leaves a Review
// phase that dispatched nothing. Without these guards a missing, stale or
// mis-bound args file would die inside the vm as a bare TypeError that names
// nothing about emit-workflow or the args file.
if (!args || !Array.isArray(args.agents)) {
  throw new Error('review-step-3a: args.agents is missing or not an array - args must be the PARSED CONTENTS of the args.json that qwen review emit-workflow wrote: read that file and pass its JSON value inline (the sandbox has no filesystem, and the Workflow tool has no path form of args)');
}
if (args.version !== 1) {
  throw new Error('review-step-3a: args version ' + args.version + ' does not match this script - re-run qwen review emit-workflow to regenerate both files together');
}
const agents = args.agents;
// An empty roster is a corrupted or truncated args file: a Step 3A review
// always requires several agents, and parallel([]) would otherwise settle
// into a zero-agent result shaped exactly like a completed review.
if (agents.length === 0) {
  throw new Error('review-step-3a: args.agents is empty - a Step 3A review always requires several agents; re-run qwen review emit-workflow to rewrite the args file');
}
// Validate the elements before dispatching any of them: a null or truncated
// entry otherwise dies mid-fan-out, after earlier agents already ran, as a
// bare vm TypeError.
for (let i = 0; i < agents.length; i++) {
  const a = agents[i];
  if (a === null || typeof a !== 'object' || typeof a.key !== 'string' || typeof a.label !== 'string' || typeof a.prompt !== 'string' || a.prompt.length === 0) {
    throw new Error('review-step-3a: args.agents[' + i + '] is not a dispatchable agent entry (needs string key, label and a non-empty prompt) - re-run qwen review emit-workflow to rewrite the args file');
  }
}

phase('Review');
log(agents.length + ' agents required by the plan');

// One thunk per required agent, dispatched together. The roster is data the
// CLI computed; this loop cannot shorten it, and there is no branch in which
// an agent is skipped. The label is the human-readable roster identity the
// args carry — the runtime's progress display consumes it.
const returns = await parallel(
  agents.map((a) => () => agent(a.prompt, { label: a.label, phase: 'Review' })),
);

// parallel() reports a failed dispatch as a null element rather than
// throwing, and an agent can also terminate with no visible text at all.
// Either way there is nothing to show for the dimension, so all of
// null/undefined/non-string/blank count as missing: a role silently absent
// from the fan-out is the one regression this path must not introduce, and
// the coverage gate needs it named to fail closed on it.
const delivered = [];
const missingRoles = [];
for (let i = 0; i < agents.length; i++) {
  const value = returns[i];
  if (typeof value === 'string' && value.trim().length > 0) {
    delivered.push({ key: agents[i].key, text: value });
  } else {
    missingRoles.push(agents[i].key);
  }
}

if (missingRoles.length > 0) {
  log(missingRoles.length + ' agent(s) returned nothing: ' + missingRoles.join(', '));
}

// A fan-out where NO agent returned anything is a failed dispatch, not a
// completed review that reviewed nothing. Throw so the run is reported as
// failed instead of returning a result whose shape reads "complete".
if (delivered.length === 0) {
  throw new Error('review-step-3a: none of the ' + agents.length + ' dispatched agents returned anything - the fan-out delivered nothing. Re-run the workflow; if it fails again, fall back to qwen review agent-prompt --roster');
}

return {
  rosterSize: agents.length,
  delivered: delivered,
  missingRoles: missingRoles,
};
`;
