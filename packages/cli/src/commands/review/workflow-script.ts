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
// model does not write this, cannot edit it, and never sees a prompt: it makes
// one tool call naming a path.
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

phase('Review');

const agents = args.agents;
log(agents.length + ' agents required by the plan');

// One thunk per required agent, dispatched together. The roster is data the
// CLI computed; this loop cannot shorten it, and there is no branch in which
// an agent is skipped.
const returns = await parallel(
  agents.map((a) => () => agent(a.prompt, { label: a.key, phase: 'Review' })),
);

// parallel() reports a failed dispatch as a null element rather than throwing,
// so a role that died is indistinguishable from one that returned nothing
// unless the script looks. Collect them by name: an agent silently missing
// from the fan-out is the one regression this path must not introduce, and the
// coverage gate needs it named to fail closed on it.
const delivered = [];
const missingRoles = [];
for (let i = 0; i < agents.length; i++) {
  const value = returns[i];
  if (value === null || value === undefined) {
    missingRoles.push(agents[i].key);
  } else {
    delivered.push({ key: agents[i].key, text: value });
  }
}

if (missingRoles.length > 0) {
  log(missingRoles.length + ' agent(s) returned nothing: ' + missingRoles.join(', '));
}

return {
  rosterSize: agents.length,
  delivered: delivered,
  missingRoles: missingRoles,
};
`;
