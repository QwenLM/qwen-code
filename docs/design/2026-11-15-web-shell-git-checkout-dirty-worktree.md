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
refuses. The route classifies the file-collision refusal shapes as
`409 dirty_working_tree` (the classifier matches
`dirty|uncommitted|would be overwritten`, covering git's "Your local
changes … would be overwritten by checkout" and "The following untracked
working tree files would be overwritten by checkout"), but the popover
only renders the error string in its footer — nothing actionable
surfaces. The directory-collision sibling — "Updating the following
directories would lose untracked files in them", an untracked directory
blocking a path the target tracks as a file — matches none of those
keywords and falls through to an unclassified 500, a dead-end of the
same kind.

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
  (the entry identified by provenance: its subject is
  `qwen-code: auto-stash before checkout` plus a per-request nonce, so a
  concurrent request's entry can never be adopted even when this
  request's own push was a no-op), then run the same checkout as the plain
  path. If the checkout fails **without moving HEAD**, the entry is
  restored (apply by SHA, checked drop) and the response is
  `409 checkout_failed` carrying git's message and the entry's whereabouts
  — also when there was nothing to stash, so the client shows git's reason
  instead of re-offering the same resolution. If a `post-checkout` hook
  refuses **after HEAD moved**, the switch completed: the entry is kept
  (restoring it would apply the old branch's changes onto the new branch),
  and the response is `409 checkout_failed` ("switched, but the checkout
  reported a failure") carrying the entry's SHA. The message names the
  entry ahead of git's detail because the route bounds the client-visible
  message length. A merge parked after the push succeeded (while the
  identity probe runs) is refused with `operation_in_progress` naming the
  kept entry in both the message and `stashSha`: the tree is already
  clean, so the entry is the only record of the changes.
  If git refuses the stash
  itself (an intent-to-add entry, a wedged index lock), nothing has been
  touched and the refusal is `409 checkout_failed` as well. On success the
  entry is **kept**: switching branches is deliberate, and restoring the
  old branch's changes onto the new one is not what a switch means. The
  response carries `stashSha`, and the popover stays open with a sticky
  warning naming the entry so the changes are never silently orphaned.
  `stashSha` rides a failure response whenever the entry's SHA is known —
  a failed apply, but also a successful restore whose listing or drop
  failed (a non-empty restore notice means the entry is still on the
  stack), and the parked-operation refusal after the push succeeded
  (including a raw guard-probe failure, which is typed there so the entry
  still reaches the client). When the push succeeded but the SHA was never learned (the
  post-push listing failed), no `stashSha` is sent; the message names the
  entry by its labelled subject instead.
- `force`: refuse when the workspace cwd is below the repository root
  (`409 force_unsupported`, because a forced checkout acts on the whole
  repository and would erase changes outside the workspace), read the
  completion probes (HEAD identity, tracked-tree dirtiness, and a
  tracked-diff snapshot), refuse a
  parked operation as the last statement before the destructive command,
  then run the same checkout as the plain path **with `-f`**, and finally
  `git clean -fd` for the untracked residue the forced checkout leaves
  behind (ignored files are kept under the target branch's ignore rules —
  a file ignored only on the source branch is untracked residue on the
  target and is removed; see Non-goals). There is deliberately no
  hand-written ref preflight: `git checkout -f` validates the ref and
  discards tracked changes in one atomic step, reading the real remote
  config, refspecs and DWIM rules, so a switch git refuses — an
  unresolvable ref, an ambiguous DWIM name, a branch occupied by another
  linked worktree, a skip-worktree conflict, DWIM disabled by
  `checkout.guess` — leaves the tree untouched and is `409 checkout_failed`
  ("cannot discard and switch") with nothing discarded. Untracked files
  in the way are overwritten by the forced checkout itself. A
  `post-checkout` hook can refuse after the switch completed; the flow
  attributes the completion to the requested target, not to tree state
  alone: HEAD must now sit where this checkout would have landed — the
  stripped local name for a remote-tracking ref (the plain path's remap),
  the branch itself for a local or DWIM-created name, the ref's commit
  for a detached target (tag, SHA, or a full ref such as `refs/heads/x` —
  git detaches HEAD for those), or exactly unmoved for `HEAD` itself.
  On top of that attribution, either HEAD's identity (name and commit)
  changed, or the tracked tree witnessed the reset: it went dirty→clean,
  or its diff against HEAD changed — forcing a target HEAD already sits
  on discards without changing the identity, and a refusing hook that
  re-dirties a tracked file turns the clean-tree read off but leaves the
  user's edit gone from the diff (blob ids included), so the in-place
  discard is still reported as completed and its residue cleaned. A
  pre-touch refusal leaves the diff byte-identical and never qualifies;
  only a hook restoring the user's exact edit bytes stays
  indistinguishable and is conservatively refused with the residue kept.
  Identity evidence is trusted only when both probes resolved a commit,
  and the diff witness only when both diff probes succeeded, so a failed
  probe cannot certify a switch. A concurrent actor moving HEAD
  elsewhere therefore never turns a pre-touch refusal into a claimed
  switch (an actor landing on exactly the requested target — or editing
  a tracked file during the failure window — is indistinguishable from
  this call's own discard, the same confirmed-discard exposure the
  concurrent-session risk below covers). The attribution is
  post-hoc only: git's own
  checkout remains the authority that performs the switch, so a
  resolution diverging from git's can under-report a completed switch
  but never discards for a refused one. The completed
  arm cleans the residue and reports `409 checkout_failed` ("switched,
  but the checkout reported a failure"). The clean runs after the switch,
  so the target branch's ignore rules decide what is kept. On the
  success path a clean that fails is `409 checkout_failed` ("switched,
  but removing untracked files failed"); in the completed-after-hook arm
  the residue clean is best-effort — its error is swallowed so the hook
  refusal stays the reported failure, and the residue may survive.

Residue inside a blocking untracked directory that a committed rule on
the current branch ignores is not preserved: git itself discards
ignored files in the way during the switch, under both resolutions
(probed), exactly as in the file-collision shape. Whether residue is
ignored is decided at stash time by the current branch's rules, not the
target's: residue the current branch does not ignore is plain untracked,
so the stash entry captures it and it survives the switch, recoverable
from the entry the response names — though on this shape the entry
cannot be applied onto the switched-to tree: `git stash apply` cannot
recreate the captured path under what is now a regular file, so extract
the path from the entry instead (`git show <sha>^3:d/blocker.txt`). The
kept-entry notice's apply guidance stays correct for the file-collision
shape. The force resolution still discards such residue — untracked
files in the way are overwritten by the forced checkout itself. When
the ignore rule is itself an uncommitted `.gitignore`
edit, the stash takes the rule away with it: the residue is plain
untracked at checkout time, the switch is refused with the
directory-collision message, and the entry is restored — nothing is
discarded and nothing is lost (probed). On a completed switch, "your
changes are kept" covers what the entry holds; files ignored by a rule
that survives the stash are not in it.

Both options are refused (`409 operation_in_progress`) while a merge,
cherry-pick, revert, rebase or am is parked in the worktree: the
destructive commands would absorb or disturb that state — a
resolved-but-uncommitted merge lives only in `MERGE_HEAD`. The probe runs
immediately before the destructive command (after the read-only
completion probes, so a state parked while they run is still refused),
and the states are read through `git rev-parse --git-path`, so linked
worktrees resolve correctly — the same guard the pull flows use. In the
stash flow the push has already happened by then, so that post-push
refusal names the kept entry (message and `stashSha`); the pre-push
guard stashes nothing.

A plain checkout — no option — runs the exact git invocation it always
has. The response-level changes are the optional `stashSha` field on a
successful stash checkout, the same field on a failure response whose
auto-stash entry survives with a known SHA — `checkout_failed` after a
kept restore, or `operation_in_progress` when a merge parks after the
push (see below) — and, for the directory-collision refusal, a
`409 dirty_working_tree` where the shared classifier previously answered
an unclassified 500, on plain checkout, branch creation, and plain pull
alike, when the refusal lands inside the client-message bound (see
below).

Failures are classified by what the core did, not by matching git's text:
a new `GitCheckoutFailure` carries the stable codes
`operation_in_progress`, `force_unsupported` and `checkout_failed`, and
the route maps it to a 409 with a path-redacted message, exactly as it
already does for `GitPullFailure`. The shared helpers
(`refuseOperationInProgress`, `pushAutoStash`) gain an action-word
parameter defaulting to the pull wording; `restoreStash` is reused
unchanged because its notices are action-agnostic. The classifier gained
the `would lose untracked` alternation for the directory-collision
refusal; its other branches are unchanged. The classifier is shared by
every workspace git route, so the alternation types that refusal shape
wherever git's raw error reaches it — plain checkout, branch creation
(`checkout -b`), and plain pull alike; the stash and force pull flows
type their update failures before the classifier, so their responses
are unchanged. The loose keyword branches read the bounded
512-character client slice, so a refusal pushed past that bound stays
an unclassified 500 — a plain pull's fetch summary can do that on a
many-ref update, the same corner the file-collision keywords have
always had.

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
user clicked, and **keeps the picker open** so the warning is painted
immediately — closing in the same update would hide the only record of
where the changes went (the pull flow stays open for the same reason;
plain checkouts keep the close-on-success contract). The warning also
survives the reopen reset. Any failure response carrying `stashSha`
(the auto-stash entry survives — a `checkout_failed` after a kept
restore, or an `operation_in_progress` when a merge parks after the
push) renders the same way — a standing warning, not a dismissible
error — because the kept entry is then the only record of the changes. Like the pull flow, a failed
resolution re-reads the listing and status without awaiting them. The
notice lives in component state, as the pull flow's does: a reload drops
it, and the entry remains recoverable from `git stash list` by its
labelled subject.

The SDK's `workspaceGitCheckout` (both the legacy and the
workspace-qualified method) takes the options plus an optional per-call
timeout so the popover can outsize the client's default fetch budget: the
stash flow's failure path chains up to ~18 git commands, each with its own
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
- **Ignored files are kept under the target branch's rules, not the
  source's.** `clean -fd` runs after the switch and removes untracked
  files but not ignored ones; no `-x` option is offered (it would delete
  `.env`, local configuration, dependency trees). A file ignored only on
  the source branch is untracked residue on the target and is removed —
  the confirmation text ("all uncommitted changes including untracked
  files") covers it, and cleaning before the switch is not an option:
  it would destroy untracked files for a switch git then refuses.
  Separately, when the target branch TRACKS a path that holds a locally
  ignored file, `git checkout` silently overwrites that file with the
  committed blob (git's default `--overwrite-ignore`); it does not
  refuse, and neither resolution preserves the ignored content — the
  stash (`--include-untracked`, never `--all`) does not capture ignored
  files. This is git's own plain-checkout behavior, inherited unchanged.
- **No hand-written ref or collision preflight.** The forced checkout
  lets git itself decide whether the switch can happen, atomically with
  the discard; a preflight that re-implements git's ref resolution
  (remote config, refspecs, DWIM, worktree occupancy) diverges from it in
  the corners and can discard for a switch git then refuses. The one
  mapping that does run is the plain path's existing remote-tracking
  remap in `runCheckout` (a clicked `origin/dev` resolves to the local
  `dev` when one exists, else a tracking branch is created): it is
  the established fork-layout contract, not a new validation. Under
  `force` the tracking branch is bound with `git branch --track` BEFORE
  the forced checkout of the new local branch — `checkout -f --track`
  would rewrite the tree first and only then fail a tracking bind git
  cannot set up (a stale remote-tracking ref), leaving a half-switched
  tree; the bind fails harmlessly before anything is discarded. The
  plain path keeps its exact historical invocation.
- **Stash from a subdirectory is not refused, as in the pull flow.**
  `git stash push` from below the root captures repository-wide changes,
  and the switch moves the whole repository — but nothing is destroyed:
  the entry is kept and named, so the changes are recoverable. The pull
  design guards only its destructive option for the same reason; adding
  a stash refusal here would also leave the panel offering an option
  that always fails in subdirectory workspaces.
- **No cross-request serialization.** Concurrent git operations —
  checkout and stash on git's own `index.lock`, branch creation on its
  ref and config locks — fail loudly; the residue `clean -fd` takes
  neither lock (probed), so a concurrent clean races on the files
  themselves — the same confirmed-discard exposure the concurrent-session
  risk covers. The stash capture carries a
  per-request nonce in the entry subject (the documented label stays as
  its prefix), so a request whose own push was a no-op — because a
  concurrent request stashed the tree first — adopts nothing and reports
  no entry; the identity-based restore never applies or drops someone
  else's entry. The pull flow shares the helper and the same guarantee.
- **Submodule working trees are left alone.** git's own checkout and
  stash do not recurse into submodules without `--recurse-submodules`,
  and neither resolution passes it: a dirty submodule survives a forced
  switch (and can leave the tree dirty after a completed switch — the
  completion witnesses handle that), and its changes are never stashed.
  The residue clean never removes submodule contents.
- **skip-worktree keeps git's own protection.** A forced checkout onto
  another branch refuses while a skip-worktree entry is edited (the
  pre-touch refusal witness covers it); an in-place forced checkout
  reports git's success with the protected file untouched — git's own
  `-f` honors skip-worktree in place, and the flow does not override it.
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
- A failing `post-checkout` hook can refuse after HEAD already moved.
  The stash flow detects the completed switch by HEAD's branch identity
  (name and commit), keeps the entry (never applies it onto the new
  branch), and reports `checkout_failed` naming the entry's SHA in both
  the message and the `stashSha` field. Any HEAD move keeps the entry:
  no destructive step hangs on attributing the move to this call, and
  restoring onto a moved HEAD is the hazard. The force flow gates its
  residue clean on attribution to the requested target (see Behavior),
  with the identity change or the tracked-tree reset (dirty→clean, or a
  changed diff against HEAD) as the completion witness — so forcing a
  target HEAD already sits on
  (identity unchanged) is still reported as a completed discard, while a
  concurrent actor moving HEAD elsewhere, or a failed identity probe,
  never turns a pre-touch refusal into a claimed switch. A hook that
  leaves dirt the forced checkout never resets does not demote a
  completed switch: an identity-changing move is witnessed by the
  identity, an in-place discard by the tracked-diff change (or
  dirty→clean); the residue clean still runs, and the hook's own edits
  stay (they are the hook's doing, not the user's uncommitted work).
  Only a hook restoring the user's exact edit bytes on an in-place
  discard stays conservatively refused (see Behavior).

## Validation plan

- Core unit tests against real temporary repositories: stash success keeps
  the entry and reports its SHA; a failed checkout restores the entry, and
  a failed restore keeps it and reports its SHA; a failed drop after a
  clean apply still reports the surviving entry's SHA; a refusing
  post-checkout hook keeps the entry and reports the completed switch
  (stash and force, including a target at the current commit; for force
  also the branch HEAD already sits on, and `HEAD` itself); a stash
  checkout on a clean tree whose hook refuses reports the completed
  switch without naming an entry; the completed-switch message names the
  entry; a merge parked after the push succeeded names the kept entry in
  the refusal (message and `stashSha`); a concurrent actor's HEAD move
  during a pre-touch refusal is not claimed as this call's switch —
  including an untracked-only tree, where the dirty→clean witness is
  unavailable; a failed before-probe certifies no switch, even when an
  actor lands on exactly the requested target; a concurrent actor moving
  HEAD during a refused `checkout -f HEAD` keeps the edit and the residue
  (the in-place target must not have moved at all); a refusing hook that
  rewrites a tracked file still reports the completed switch and cleans
  the residue; untracked-only dirt with a refusing hook completes via the
  identity witness; an in-place discard (current branch and `HEAD`)
  whose refusing hook re-dirties a tracked file still reports the
  completed discard and cleans the residue; a pre-touch refusal of the
  current branch keeps the edit and the residue (the dirty tree alone
  certifies nothing); a failed before-diff probe is not trusted, and
  when both diff probes fail but the hook leaves the tree clean the
  dirty→clean witness still carries the completed in-place discard; a
  detached target (tag) whose hook refuses reports
  the completed switch, as does a full ref (`refs/heads/x`, detached) and
  a remote-tracking ref (completed on the remapped local branch); a merge
  parked while the completion probes run is still refused; a concurrent request's labelled entry is
  never adopted when our own push is a no-op; an intent-to-add entry types
  the stash refusal; stash leaves ignored files on disk and out of the
  entry (`--include-untracked`, never `--all`); force discards tracked
  modifications and untracked files (including directories), keeps
  ignored files under the target branch's rules, and removes a file
  ignored only on the source branch; force reaches the remote remap's
  existing-local-branch arm with `-f`; a residue clean that fails after the
  switch is typed; force refuses without discarding for an unresolvable
  ref, an ambiguous DWIM name, a tracking ref git cannot resolve (no
  configured remote), DWIM disabled by `checkout.guess`, a branch
  occupied by another worktree, and a skip-worktree conflict; force
  accepts the DWIM shapes git accepts (bare and slash names,
  remote-tracking refs); a stale remote-tracking ref whose tracking bind
  git cannot set up refuses before anything is discarded (bind-before-
  discard); a multi-MB tracked diff still witnesses the in-place discard
  (streamed hash, no buffer bound); the after-side halves of the trust
  guards are witnessed (a failed after-status, after-diff, or
  after-identity probe certifies nothing); the completed arm's swallowed
  clean failure keeps the hook refusal as the reported failure; a no-op
  push's parked-operation refusal names no entry; a raw guard-probe
  failure after the push still names the kept entry; an in-place discard
  leaves a skip-worktree edit untouched (git's own protection); the
  subdirectory and parked-operation refusals.
- Route tests: option validation (400s), typed 409 mapping, path
  redaction witnessed by a linked-worktree refusal carrying an absolute
  path, `stashSha` forwarding when a post-checkout hook refuses after the
  switch.
- SDK tests: request bodies carry the options; the timeout is forwarded.
- Component tests: the panel appears on a dirty checkout refusal,
  dispatches the right options, arms the confirm step, keeps the panel on
  `force_unsupported`, shows the in-flight spinner, dismisses the panel
  when a competing action starts, keeps the picker open and paints the
  kept-stash warning immediately on a stash success, re-reads the listing
  and the tree status together after a stash success and after a failed
  resolution that kept the entry (each half witnessed separately: the
  hints stop reporting uncommitted changes, both RPC counts grow, and
  the rows follow a genuinely post-switch listing), notifies
  `onBranchChanged` on the stash success that keeps the picker open,
  closes the picker on a plain checkout success, keeps the confirm
  button busy with the discard spinner while its checkout is in flight,
  re-targets the standing panel to a second refused branch, drops a
  standing checkout panel on reopen, and keeps the warning (success and
  failed restore) across a reopen.
- E2E (mock daemon, Playwright, `@smoke` so PR CI runs them): the full
  panel flow for both resolutions, the kept-entry warning visible
  immediately and across a reopen, and the cancel path.

## Acceptance criteria

- A checkout refused for local changes offers stash and discard
  resolutions, and both complete the switch end to end.
- The plain checkout invocation is unchanged; the directory-collision
  refusal's response changes from an unclassified 500 to
  `409 dirty_working_tree` on every route whose raw git error reaches
  the shared classifier — plain checkout, branch creation, and plain
  pull — when the refusal lands inside the route's client-message
  bound.
- Every guard listed above has a test that fails without it.
- The design exists in both languages; lint, typecheck, build and the
  focused unit suites pass.

## Open questions

- Whether a discard should warn when another session is active in the
  same checkout (follow-up; the pull force flow has the same gap today).
- Whether a standalone "discard local changes" action is wanted later
  (follow-up).
