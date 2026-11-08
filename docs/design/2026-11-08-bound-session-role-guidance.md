# Bound-Session Role Guidance Without Operator Templates

[English](2026-11-08-bound-session-role-guidance.md) | [简体中文](2026-11-08-bound-session-role-guidance.zh-CN.md)

Status: proposed (2026-11-08). Direction confirmed by the maintainer: surface the
binding role, make machine-authored watch summaries factual, and ship built-in
per-role guidance — while keeping the single-winner routing of the base design.
Builds on [GitHub Channel Events to PR-Bound Sessions](2026-11-02-github-channel-bound-session-events.md)
(PR #16117) and [GitHub Channel Bound-Session Action Templates](2026-11-04-github-channel-bound-session-action-templates.md)
(PR #16258).

## Problem statement

A session bound to a PR with `role: "verify"` receives an event prompt that tells
it to do fix-role work, and that never says which role it holds.

Observed on 2026-11-08 with a `/verify-pr` session bound to a PR whose channel had
`deliverToBoundSessions: true` and four `prWatchEvents`, but no
`boundSessionActions`:

- the `ci_failure` prompt ended with `Inspect the failed checks and fix or
attribute the failure.`;
- the `merge_conflict` prompt ended with `Rebase or merge the base branch and
resolve the conflicts.`;
- neither prompt carried a `Role:` line.

The session resolved the tension by guessing. It attributed the CI failure
correctly, then treated the conflict event as an assignment: it built a merge
commit on the PR branch and asked whether to push it. A verification session
should report that a conflict blocks verification and leave the branch to its
author.

Two independent causes produce this:

1. **The role is dropped.** With no `boundSessionActions`, delivery runs in
   legacy mode, which discards a role stamped on the binding. The session is
   told nothing about the hat it wears.
2. **The summaries assign work.** The watch summaries are role-blind imperatives
   naming a fix-role action (`fix`, `Rebase or merge`). They reach every role
   unchanged.

Either alone is survivable; together they instruct a verify-only session to
push.

## Current state

| Concern                 | Location                                                                         | Behavior today                                                                                                                                                                                           |
| ----------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prompt assembly         | `packages/channels/base/src/bound-session-prompt.ts`, `buildBoundEventPrompt`    | With no `instruction`, emits the generic line `Handle the event with your normal workflow, acting on <platform> only if that workflow calls for it.` Emits `Role: <role>` only when `parts.role` is set. |
| Legacy target selection | `packages/channels/github/src/GithubAdapter.ts`, `resolveBoundTargets`           | The legacy branch returns a bare `{ sessionId }`, dropping the follower's role.                                                                                                                          |
| Legacy gone-fallback    | `packages/channels/github/src/GithubAdapter.ts`, `resolveBoundDeliveryExcluding` | Attaches the role only under `this.boundRoleAware && best.role`, commented as a byte-compatibility requirement.                                                                                          |
| Role-aware switch       | `packages/channels/github/src/GithubAdapter.ts`, `boundRoleAware`                | True only when the operator template map is non-empty.                                                                                                                                                   |
| Watch summaries         | `packages/channels/github/src/GithubAdapter.ts`, watch transition detection      | `ci_failure`, `merge_conflict` and the merged branch of `state_change` end with an imperative.                                                                                                           |

The action-templates design decided that "with the field absent, every behavior
of the base design is unchanged", and two tests pin the generic prompt for
**untyped** bindings (`keeps the legacy prompt byte-compatible when no actions
are configured`, `legacy gone-fallback stays generic even when bindings carry
roles`). Both fixtures select an untyped winner, so the promise that untyped
delivery is byte-identical is not what this change breaks. What it breaks is the
accidental extension of that promise to bindings that DO carry a role: a role
stamped by a `/review` or `/verify-pr` backfill is currently indistinguishable
from no role at all.

The shared prompt module exists for a second producer — the daemon PR-state
watch of
[Daemon PR State Transitions](2026-11-04-daemon-pr-state-transitions.md) — whose
template validation has landed but whose delivery path has not. Guidance placed
in the shared module reaches both producers; guidance placed in the adapter
reaches only one.

## Goals

- A bound session learns its role from the prompt whenever the binding carries
  one, regardless of operator configuration.
- With no operator template, a role-carrying binding receives guidance scoped to
  that role instead of a role-blind instruction to act.
- Machine-authored event summaries state facts and never assign an action.
- Untyped bindings keep today's prompt byte-for-byte.
- Configured operator templates keep today's behavior byte-for-byte, including
  the per-role subscription semantics.

## Non-goals

- Routing does not change. With no template map there is still exactly one
  winner, chosen by the same recency rule; a role on a binding never enables
  fan-out.
- Built-in guidance is not configurable and introduces no new setting.
- No change to the comment lane's admission, mention exemption, or publication
  contract.
- The daemon watch producer is not implemented here.

## Proposed solution

### Shared prompt contract

`packages/channels/base/src/bound-session-prompt.ts` gains an exported table:

```ts
export const DEFAULT_BOUND_ROLE_GUIDANCE: Readonly<
  Record<PrBindingRole, string>
> = {
  review:
    'Act as the reviewer for this PR: inspect the change and report findings through your review workflow. Do not push commits or modify the PR branch.',
  verify:
    'Act as the verifier for this PR: verify the change and report the outcome through your verification workflow. Attribute CI failures rather than fixing them. Do not merge, rebase, resolve conflicts, or push to the PR branch.',
  fix: 'Act as the fixer for this PR: investigate and fix the problem through your fix workflow, which decides whether to push. Re-read the current PR head before acting; it may have moved since this event.',
};
```

`BoundEventPromptParts` gains one optional field, `roleGuidance?: string`. In the
no-`instruction` branch the builder uses it in place of the generic workflow
sentence. Everything else — header, untrusted notice, the
`Your reply stays in this session` sentence, data lines, `Role:` line, body cap —
keeps its current position and wording.

The three strings are the whole product surface. They are keyed by role only,
not by (role, event): the event body already carries the event-specific facts, so
a per-event matrix would multiply the text without adding information.

### Producer supplies the guidance, the builder decides

The adapter passes `DEFAULT_BOUND_ROLE_GUIDANCE[role]` whenever the target
carries a role, and nothing for an untyped target. The builder applies it only
in the branch where no operator `instruction` resolved, so:

- legacy mode, role-carrying winner → guidance replaces the generic sentence;
- legacy mode, untyped winner → generic sentence, byte-identical to today;
- role-aware mode → the operator block, because targets there are selected BY
  template match and therefore always carry an instruction.

An earlier draft had the adapter withhold guidance under `!boundRoleAware`.
Mutation testing showed that guard to be unobservable: removing it changed no
delivery, because role-aware targets cannot reach the no-instruction branch.
The per-role subscription is enforced where it is actually decidable — target
selection, which gives an unmatched role no target at all — so the guard was
dropped rather than kept as an unreachable branch.

### Role survives legacy routing

Three paths freeze a legacy target, and all three must carry the role:

| Path                                  | Serves                                                                            | Change                                                                     |
| ------------------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `resolveBoundDelivery`                | watch events (pending claim and drain re-resolve) and legacy target re-validation | read the role back through a new `boundRoleOf`                             |
| `resolveBoundTargets` (legacy branch) | comment-lane events                                                               | same read-back                                                             |
| `resolveBoundDeliveryExcluding`       | gone-fallback                                                                     | drop the `this.boundRoleAware &&` conjunct; `best.role` is already in hand |

`boundSessionByPr` holds only a `PrBindingSummary`, so the first two read the
role from the winner they already resolved. The per-entry match — the URL must
parse, agree with its own recorded number, and normalize to the PR key — is
extracted into `boundPrEntryFor` and shared with `boundFollowersOf`, so the two
paths cannot drift.

Reading the role through the whole follower list would have put a URL parse per
binding per session into `resolveBoundDelivery`, which was a single `Map` lookup
before and is reached two or three times per event. Taking the resolved winner
keeps the parse inside that one session's own entries.

None of this touches which session wins: the grouping, the recency comparison
and the single-winner shape are untouched.

### The gone-fallback must rebuild the prompt

Surfacing the role exposed a latent defect. The gone-fallback loop built the
prompt ONCE for the first target and reused that string for every subsequent
candidate. In legacy mode the loop scans every follower with no role filter, so
it can cross roles: a gone `review` session's `Role: review` line and reviewer
guidance were delivered to the `verify` session that took over. Before this
change legacy prompts carried no role, so the reuse was invisible.

The loop now rebuilds the prompt for each target from that target's own role.
Role-aware fallbacks stay inside their role group, where the deterministic
renderer produces the identical string, so their behavior is unchanged. This is
the same hazard the action-templates design already named for role-aware
delivery ("must not keep injecting the obsolete role's instruction into the
frozen session"); legacy routing now gets the equivalent protection.

### A retry must refresh the role, not just the session

Delivery-time re-validation compared only `current.sessionId !== delivery.sessionId`
before replacing the frozen target. Once the role travels with the target, that
is half an identity: a delivery deferred by a full queue, whose binding is
re-roled from `fix` to `verify` before the retry, revalidates to the SAME session
and kept the frozen `fix` role — so the prompt still said `Role: fix` and carried
the fixer's guidance into a session that is now a verifier. That is the reported
defect reintroduced through the retry path.

The comparison now covers the role as well. Role-aware targets are re-resolved
within their own role group, so `current.role` always equals `delivery.role`
there and the added half is inert; only legacy routing, which re-resolves the
winner outright, can observe a role change.

### Factual watch summaries

| Type                    | Before                                                                                                          | After                                                |
| ----------------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `ci_failure`            | `CI failed on head <sha>.<checks> Inspect the failed checks and fix or attribute the failure.`                  | `CI failed on head <sha>.<checks>`                   |
| `merge_conflict`        | `Merge conflicts detected (mergeable_state: dirty). Rebase or merge the base branch and resolve the conflicts.` | `Merge conflicts detected (mergeable_state: dirty).` |
| `state_change` (merged) | `The PR was merged. Wrap up any follow-up work.`                                                                | `The PR was merged.`                                 |
| `head_change`           | `New commits pushed: head moved from <a> to <b>.`                                                               | unchanged                                            |
| `state_change` (closed) | `The PR was closed without merging.`                                                                            | unchanged                                            |

The action now comes from exactly one place: the operator template when
configured, otherwise the built-in role guidance, otherwise the session's own
workflow. The event body stops competing with it.

## Key design decisions

1. **Built-in guidance replaces the generic sentence; it does not enter the
   operator block.** The generic line is already product-authored trusted text,
   so replacing it changes no trust boundary. Reusing
   `[Operator instruction — trusted]` for a built-in default would mislabel its
   provenance, and a second labelled block would add a tag that
   `sanitizePromptText`'s peel rule has to account for. Neither is worth it.
2. **Defaults never override an operator instruction, and never subscribe a
   role.** Precedence in the builder handles the first half. The second half is
   target selection's job: in role-aware mode an unmatched role gets no target,
   so it never reaches the builder. A producer must not "fix" an unmatched role
   by giving it a default target — that would convert "operator did not
   subscribe this role" into a delivery, the silently-active-key failure the key
   validator exists to prevent.
3. **The producer supplies the string; the builder owns precedence.** The
   builder does not import the table or look up a role, so a producer with
   different guidance can supply its own. One place decides between operator
   instruction and guidance, instead of two places agreeing about it.
4. **Summaries become factual for every role, not just verify.** A review session
   told to `Rebase or merge` is equally wrong. Removing the imperative fixes the
   class rather than the instance, and it also fixes the future daemon producer,
   which will emit its own summaries against the same contract.
5. **Untyped delivery stays byte-identical.** Both existing pins select untyped
   winners and keep passing unchanged. The compatibility promise is narrowed to
   what it was written for, not retired.

## Files affected

| Layer           | Path                                                      | Change                                                                                                                                    |
| --------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| shared contract | `packages/channels/base/src/bound-session-prompt.ts`      | `DEFAULT_BOUND_ROLE_GUIDANCE`; `roleGuidance` on `BoundEventPromptParts`; use it in the no-instruction branch                             |
| shared barrel   | `packages/channels/base/src/index.ts`                     | export the table                                                                                                                          |
| adapter         | `packages/channels/github/src/GithubAdapter.ts`           | `boundRoleOf`; role in all three legacy target paths; pass `roleGuidance`; rebuild the prompt per gone-fallback target; factual summaries |
| shared tests    | `packages/channels/base/src/bound-session-prompt.test.ts` | guidance substitution, untyped fallback, operator block precedence                                                                        |
| adapter tests   | `packages/channels/github/src/GithubAdapter.test.ts`      | role line and guidance in legacy mode; role-aware mode unchanged; summary text                                                            |
| user docs       | `docs/users/features/channels/github.md`                  | document built-in guidance and the factual summaries                                                                                      |
| design          | this pair                                                 | new design                                                                                                                                |

## Constraints and risks

- **Prompt text is a model-facing contract.** Sessions with older transcripts will
  see a new sentence. The change is additive for untyped bindings and replaces a
  role-blind imperative for role-carrying ones, which is the intent.
- **Guidance is not an authorization boundary.** It is instruction text, not
  enforcement; a session can still act outside it. Tool permissions remain the
  boundary. The strings are written as scope statements so a compliant session
  has an unambiguous answer.
- **A stale head is still possible.** The `fix` string tells the session to
  re-read the head, but nothing enforces it. Delivery-time head re-validation is
  out of scope.
- **Table growth.** Three strings keyed by a closed role vocabulary. Adding a
  role to `PR_BINDING_ROLES` becomes a type error here until guidance is supplied,
  which is the desired coupling.

## Validation plan

- Unit tests in `packages/channels/base` for the builder: guidance replaces the
  generic sentence; absence keeps it; an operator instruction wins over
  `roleGuidance`; the `Role:` line and the body cap are unaffected.
- Unit tests in `packages/channels/github` for delivery, covering BOTH target
  paths: the watch path (`resolveBoundDelivery`) and the comment path
  (`resolveBoundTargets`). A role-carrying legacy winner gets `Role:` and its
  guidance; an untyped legacy winner is byte-identical to today; the
  gone-fallback names the fallback session's own role; role-aware delivery is
  unchanged, including "no role matched → retire privately".
- A pin per edited summary asserting the imperative is gone, so a later edit
  cannot reintroduce an assignment into event data.
- Mutation testing: each source change is reverted in isolation and the named
  test must turn red. A mutation that survives means the test does not pin that
  change — either add the missing case or delete the unobservable code.
- `npm run build`, `npm run typecheck`, and the two packages' focused suites.
- E2E: drive a bound session against a local daemon with and without
  `boundSessionActions` and inspect the delivered prompt.

## Acceptance criteria

1. A `verify`-bound session receiving `merge_conflict` with no operator templates
   gets `Role: verify`, the verifier guidance, and a body that states the conflict
   without telling it to rebase or merge.
2. The same channel with `boundSessionActions` configured delivers byte-identical
   prompts to today for every matched role, and still skips unmatched roles.
3. An untyped binding's prompt is byte-identical to today in both modes.
4. No watch summary contains an imperative action.
5. A gone-fallback across roles delivers the taking-over session's own role and
   guidance, never the gone session's.
6. Every source change is witnessed by a mutation that turns a named test red.
7. Build, typecheck and the focused suites pass.

## Open questions

- Whether the daemon watch producer should reuse these strings verbatim or
  supply platform-neutral variants. Deferred until that producer is implemented;
  the table lives in the shared module so either choice stays cheap.
- Whether `fix` guidance should name the push-confirmation expectation. Left to
  the session's own workflow for now, since that expectation is a user
  preference rather than a product rule.
