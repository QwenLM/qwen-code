# Web Shell git checkout with a dirty working tree

[English](2026-11-15-web-shell-git-checkout-dirty-worktree.md) | [简体中文](2026-11-15-web-shell-git-checkout-dirty-worktree.zh-CN.md)

## Goal

Let the Web Shell branch picker's checkout succeed when the workspace has
uncommitted changes, instead of dead-ending at a `dirty_working_tree` error
that forces users back to a terminal. This mirrors the resolution the pull
path already offers ([Git pull with a dirty working tree](git-pull-dirty-worktree.md)).

## Problem

The workspace git checkout path (branch picker popover → SDK
`workspaceGitCheckout` → `POST /workspace(s)/git/checkout` → core
`gitCheckout`) runs a plain `git checkout <ref> --`. When local
modifications or untracked files would be overwritten by the switch, git
refuses. The route already classifies both refusal shapes as
`409 dirty_working_tree` (the classifier matches
`dirty|uncommitted|would be overwritten`, which covers git's "Your local
changes … would be overwritten by checkout" and "The following untracked
working tree files would be overwritten by checkout"), but the popover
only renders the error string in its footer — nothing actionable surfaces.

The typical cause is residue from earlier work: edits left by a previous
session, or new files a build produced, block checking out a different
branch. The pull path already answers the same refusal with a stash or
discard resolution; checkout has none.

## Behavior

`POST /workspace/git/checkout` and `POST /workspaces/:workspace/git/checkout`
accept two new boolean options (both default false, mutually exclusive —
sending both is a `400 invalid_stash_force`; a non-boolean value is a 400).
They are the two things a user would do in a terminal, and nothing more:

- `stash`: refuse a parked operation, `git stash push --include-untracked`
  (the entry identified by provenance and labelled
  `qwen-code: auto-stash before checkout`), then run the same checkout as
  the plain path. If the checkout fails, the entry is restored (apply by
  SHA, checked drop) and the response is `409 checkout_failed` carrying
  git's message and the entry's whereabouts — also when there was nothing
  to stash, so the client shows git's reason instead of re-offering the
  same resolution. If git refuses the stash itself (an intent-to-add
  entry, a wedged index lock), nothing has been touched and the refusal is
  `409 checkout_failed` as well. On success the entry is **kept**:
  switching branches is deliberate, and restoring the old branch's
  changes onto the new one is not what a switch means. The response
  carries `stashSha`, and the popover shows a sticky warning naming the
  entry so the changes are never silently orphaned.
- `force`: refuse a parked operation, refuse when the workspace cwd is
  below the repository root (`409 force_unsupported`, because a forced
  checkout acts on the whole repository and would erase changes outside
  the workspace), refuse a parked operation again, then run the same
  checkout as the plain path **with `-f`**, and finally `git clean -fd`
  for the untracked residue the forced checkout leaves behind (ignored
  files are kept). There is deliberately no hand-written ref preflight:
  `git checkout -f` validates the ref and discards tracked changes in one
  atomic step, reading the real remote config, refspecs and DWIM rules,
  so a switch git refuses — an unresolvable ref, an ambiguous DWIM name,
  a branch occupied by another linked worktree, a skip-worktree conflict,
  DWIM disabled by `checkout.guess` — leaves the tree untouched and is
  `409 checkout_failed` ("cannot discard and switch") with nothing
  discarded. Untracked files in the way are overwritten by the forced
  checkout itself. The clean runs after the switch, so the target
  branch's ignore rules decide what is kept; a clean that fails after a
  successful switch is `409 checkout_failed` ("switched, but removing
  untracked files failed").

Both options are refused (`409 operation_in_progress`) while a merge,
cherry-pick, revert, rebase or am is parked in the worktree: `git stash
push` and a forced checkout both clear that state. The probe runs
immediately before the destructive command, and the states are read
through `git rev-parse --git-path`, so linked worktrees resolve correctly
— the same guard the pull flows use.

A plain checkout — no option — runs the exact git invocation it always
has. The response-level changes are the optional `stashSha` field on a
successful stash checkout, and the same field on a `checkout_failed`
response whose auto-stash could not be restored (see below).

Failures are classified by what the core did, not by matching git's text:
a new `GitCheckoutFailure` carries the stable codes
`operation_in_progress`, `force_unsupported` and `checkout_failed`, and
the route maps it to a 409 with a path-redacted message, exactly as it
already does for `GitPullFailure`. The shared helpers
(`refuseOperationInProgress`, `pushAutoStash`) gain an action-word
parameter defaulting to the pull wording; `restoreStash` is reused
unchanged because its notices are action-agnostic. The pre-existing regex
classification is unchanged and still covers the plain checkout.

## UI

When the plain checkout fails with `409 dirty_working_tree`, the branch
picker footer switches from the status line to the same resolution panel
the pull refusal uses, with checkout wording:

- **Stash Changes and Switch** — checks out with `stash: true`.
- **Discard Changes and Switch…** — destructive, so it takes a second
  click: the panel swaps to the existing discard warning (all uncommitted
  changes including untracked files, cannot be undone) plus a confirm
  button that checks out with `force: true`.
- **Cancel** — dismisses the panel.

The panel is one mechanism shared with pull: a discriminator remembers
which action was blocked (and, for checkout, the target ref), and the
buttons dispatch to the matching handler. The lifecycle is the pull
panel's: reset whenever the popover is reopened, dismissed by any
competing action that actually runs, spinner on the clicked button while
its request is in flight. A `force_unsupported` refusal keeps the panel up
with the daemon's explanation in place of the blocked line, because the
tree is still dirty and stashing is still available. Every other refusal
renders the daemon's `message` and closes the panel. A success carrying
`stashSha` renders as a sticky warning naming the entry and the ref the
user clicked; it survives the reopen reset, since the checkout may settle
while the popover is closed and it is the only signal the user gets. A
`checkout_failed` response carrying `stashSha` (the auto-stash could not
be restored) renders the same way — a standing warning, not a dismissible
error — because the kept entry is then the only record of the changes.
Like the pull flow, a failed resolution re-reads the listing and status
without awaiting them.

The SDK's `workspaceGitCheckout` (both the legacy and the
workspace-qualified method) takes the options plus an optional per-call
timeout so the popover can outsize the client's default fetch budget: the
stash flow's failure path chains up to ~14 git commands, each with its own
30s limit, so the popover allows 600s, mirroring the pull ceiling.

## Ownership

Both routes keep their existing scoping: the legacy route is
legacy-primary-workspace scoped; the qualified route resolves the trusted
runtime and contained `cwd` exactly as before. The new options only change
which git commands run inside the resolved workspace and add no new trust
surface. Typed failures go through the same path redaction as every other
git response.

## Non-goals (deliberate)

These are the boundaries of the feature; each is a decision, not an
omission:

- **No auto-restore after a successful switch.** The stash entry is kept
  and named; restoring it onto the new branch is the user's call
  (`git stash apply`), not a side effect of switching.
- **Ignored files are kept, as in the pull force flow.** `clean -fd`
  removes untracked files but not ignored ones; no `-x` option is offered
  (it would delete `.env`, local configuration, dependency trees). Ignored
  build artifacts usually do not block a checkout; when the target branch
  tracks such a path, git's own refusal surfaces.
- **No hand-written ref or collision preflight.** The forced checkout
  lets git itself decide whether the switch can happen, atomically with
  the discard; a preflight that re-implements git's ref resolution
  (remote config, refspecs, DWIM, worktree occupancy) diverges from it in
  the corners and can discard for a switch git then refuses. This is
  stronger than the pull design's "no collision preflight" decision: no
  ref validation is re-implemented at all.
- **Stash from a subdirectory is not refused, as in the pull flow.**
  `git stash push` from below the root captures repository-wide changes,
  and the switch moves the whole repository — but nothing is destroyed:
  the entry is kept and named, so the changes are recoverable. The pull
  design guards only its destructive option for the same reason; adding
  a stash refusal here would also leave the panel offering an option
  that always fails in subdirectory workspaces.
- **No cross-request serialization.** Concurrent git operations fail
  loudly on git's own `index.lock`; the provenance-based capture and
  identity-based restore fail closed (entry kept) rather than applying or
  dropping someone else's entry.
- **The session-creation dirty gate and Git Mode are unchanged.** The
  "create a branch for a new session" gate in the session route and the
  agent-driven Git Mode popover keep their current behavior.
- **No standalone discard button.** The resolution is offered where the
  refusal happens; a general "discard local changes" action is a possible
  follow-up, not part of this change.

## Risks

- The force flow is destructive by design. Mitigations: the two-click
  confirmation, git's atomic validate-and-discard (a refused switch
  discards nothing), the parked-operation refusal, the subdirectory
  refusal, and ignored files being kept under the target branch's rules.
- A concurrent session or terminal in the same checkout can lose
  uncommitted work when the user confirms a discard. This is the same
  exposure the existing pull force flow has; the explicit confirmation is
  the gate. Whether to add an active-session warning is an open question
  below, not part of this change.
- A failing `post-checkout` hook can refuse after HEAD already moved. The
  stash flow restores (or keeps) the entry and reports `checkout_failed`
  with the kept entry's SHA; the force flow detects the moved HEAD by
  state comparison and reports that the switch completed. Both match the
  plain path's existing hook behavior.

## Validation plan

- Core unit tests against real temporary repositories: stash success keeps
  the entry and reports its SHA; a failed checkout restores the entry, and
  a failed restore keeps it and reports its SHA; an intent-to-add entry
  types the stash refusal; force discards tracked modifications and
  untracked files (including directories) but keeps ignored ones; force
  refuses without discarding for an unresolvable ref, an ambiguous DWIM
  name, a tracking ref git cannot resolve (no configured remote), DWIM
  disabled by `checkout.guess`, a branch occupied by another worktree, and
  a skip-worktree conflict; force accepts the DWIM shapes git accepts
  (bare and slash names, remote-tracking refs); a refusing post-checkout
  hook is reported as a completed switch; the subdirectory and
  parked-operation refusals.
- Route tests: option validation (400s), typed 409 mapping, redaction,
  `stashSha` forwarding on a failed restore.
- SDK tests: request bodies carry the options; the timeout is forwarded.
- Component tests: the panel appears on a dirty checkout refusal,
  dispatches the right options, arms the confirm step, keeps the panel on
  `force_unsupported`, shows the in-flight spinner, dismisses the panel
  when a competing action starts, and renders the kept-stash warning
  (success and failed restore) across a reopen.
- E2E (mock daemon, Playwright): the full panel flow for both resolutions.

## Acceptance criteria

- A checkout refused for local changes offers stash and discard
  resolutions, and both complete the switch end to end.
- The plain checkout invocation and response are unchanged.
- Every guard listed above has a test that fails without it.
- The design exists in both languages; lint, typecheck, build and the
  focused unit suites pass.

## Open questions

- Whether a discard should warn when another session is active in the
  same checkout (follow-up; the pull force flow has the same gap today).
- Whether a standalone "discard local changes" action is wanted later
  (follow-up).
