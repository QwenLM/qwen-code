# Autofix-PR: worktree-rooted watch storage for linked-worktree daemon sessions

[English](2026-10-29-autofix-pr-worktree-rooted-storage.md) | [简体中文](2026-10-29-autofix-pr-worktree-rooted-storage.zh-CN.md)

Status: proposal (2026-10-29). Amends
[2026-10-21-autofix-pr-command.md](2026-10-21-autofix-pr-command.md) Section 6
(storage), 6.1 step 7 (daemon refusal), 6.10 (status) and 6.15 (watch
listing).

## Problem

`/autofix-pr` cannot be prepared from a daemon session whose working directory
is a **linked worktree** of a multi-worktree clone. Session
`b1887512-645c-46a2-a4e1-97d17390c674` (cwd `…/git/qwen-code-x2`) invoked
`/autofix-pr` for PR #15816; `prepare` refused:

```
…/git/qwen-code/.qwen/tmp/autofix-pr-15816 is outside this session's working
directory (…/git/qwen-code-x2): the daemon runs the fix agent's commands only
there … Prepare the PR from …/git/qwen-code …
```

`qwen-code-x2` is a linked worktree of the clone whose main worktree is
`…/git/qwen-code` (`git rev-parse --git-common-dir` → `…/qwen-code/.git`).
This is the maintainer's normal layout (`x1`…`x9`), so the refusal makes
`/autofix-pr` unusable from almost every session they work in, even for a PR
whose branch is checked out in that very worktree.

## Current state

Two deliberate decisions collide:

1. **Clone-rooted storage.** `repoRoot()`
   (`packages/cli/src/commands/review/lib/git.ts`) returns the clone's **main
   worktree** (first entry of `git worktree list --porcelain`).
   `autofixPrPaths(root, pr)` (`packages/cli/src/commands/autofix-pr/state.ts`)
   places the worktree and every state file under `<main>/.qwen/tmp/`. The
   design rationale: branches are shared by every worktree of a clone, so a
   watch belongs to the clone and every helper finds it from any worktree.
2. **Daemon containment.** The daemon shell guard
   (`packages/cli/src/serve/daemon-git-worktree-guard.ts`) admits a command
   only inside the session's effective working directory or a worktree that
   session owns (`GitWorktreeService.getWorktreesDir(sessionId)`).
   `assertSessionCanRunWorktree` (`prepare.ts`) re-checks this boundary before
   creating anything and fails closed.

A linked-worktree session's cwd is neither the main worktree nor a
session-owned isolation worktree, so the clone-rooted artifacts are permanently
out of reach. The daemon watch listing is clone-rooted too:
`cloneRootOf()` / `listAutofixPrWatches()`
(`packages/cli/src/serve/routes/autofix-pr-watches.ts`) scan the main
worktree's `.qwen/tmp` so "two workspaces of one clone list the same watches".

## Goals

- A daemon session in any worktree of a clone can `prepare`, run and `resume`
  a watch whose artifacts live inside that session's working directory.
- No weakening of the daemon shell guard or the worktree trust checks.
- The Web Shell continues to list every watch of the clone from any of its
  workspaces.
- No regression to plain-CLI (non-daemon) flows, including cross-worktree
  operation of a clone-rooted watch.

## Non-goals / scope boundaries

- Do not change the daemon shell guard's containment rule. Widening it to
  "any worktree of the same clone" would let one session execute in sibling
  worktrees and the main checkout, defeating sibling isolation — a security
  regression. Rejected.
- Do not change branch naming, the PR-keyed state model, or the trust checks'
  semantics.
- The separate "autofix worktree has no `node_modules`" problem is out of scope.

## Proposed solution

### 1. Environment-aware watch root, discovered across the clone

`watchRoot()` (in `packages/cli/src/commands/autofix-pr/state.ts`) is where a
**fresh** watch roots:

- Daemon session (`QWEN_CODE_SERVE === '1'`): the **current worktree's
  toplevel** (`git rev-parse --show-toplevel` from cwd) — the session's
  containment boundary, so artifacts are reachable.
- Otherwise: `repoRoot()` (the clone's main worktree), exactly as today.

A watch lives wherever it was prepared, and a helper cannot re-derive that
from its own cwd: the session may have moved, and `cleanup` must reach a watch
in any worktree to end it. So an **existing** watch is discovered, not guessed.
`findWatchRoot(pr)` scans the clone's worktrees for
`autofix-pr-<pr>-state.json` (a live watch worktree wins over a stale state
file), and `resolveWatchRoot(pr) = findWatchRoot(pr) ?? watchRoot()`. `prepare`
resumes the discovered watch — still refused outside the session boundary by
`assertSessionCanRunWorktree` — or creates a fresh one at `watchRoot()`;
`snapshot`, `sync`, `push`, `reply`, `rerun`, `ci-log`, `schedule`, `fix` and
`cleanup` resolve via `resolveWatchRoot`.

The listing (`status` by default, and the daemon route) does not pick one
root: it scans **every** worktree of the clone (`cloneWorktreeRoots()`), so a
watch is found whichever worktree holds it. Enumeration is NUL-safe
(`git worktree list --porcelain -z`, `parseWorktreePaths`): a path holding a
newline stays one record and cannot fabricate an extra root the scan would
read outside the clone. git before 2.36 has no `-z`, and the line form cannot
represent such a path safely, so the fallback scans the main worktree alone
(always the first record) rather than risk a fabricated root. `repoRoot()`
itself is unchanged — the `review` command and its reviewer cursor still root
at the main worktree.

For a main-worktree session `watchRoot() === repoRoot()`, so existing
main-rooted watches and main-clone sessions behave identically. The only
behavior change is for linked-worktree daemon sessions, which today are dead
zones.

### 2. Trust stays anchored to the genuine clone

The trust-check functions (`untrustedGitfile` / `untrustedSubmodules` in
`packages/cli/src/commands/autofix-pr/worktree.ts`) are unchanged: they
resolve a clone's common git dir with `git -C <root> rev-parse
--git-common-dir` and verify the worktree's gitfile points at
`<common>/worktrees/<name>` and back. What matters is which `root` they are
given. The clone-wide listing discovers watches in sibling worktrees, but a
sibling checkout's `.git` is a gitfile that code running inside it can
rewrite to point at a replacement repository — so a discovered worktree must
never be passed as the trust root, or it would vouch for its own nested
watches and `status` would execute the replacement's `core.fsmonitor`.

The anchor must not rest on a single source either. `repoRoot()` runs git
from the helper's cwd, so a cwd whose `.git` was repointed at a replacement
repository skews it; and the state file is **not** beyond the round's reach —
`working_dir` is a cwd pin, not a filesystem sandbox, and a command in the fix
worktree can write the sibling `../autofix-pr-<n>-state.json`, so a recorded
`trustRoot` alone is tamperable too. `prepare` records the genuine clone in
`state.trustRoot` while the session cwd is trusted (a resume populates it for a
legacy watch), but `trustAnchor(state)` requires the recorded root and the
cwd-derived `repoRoot()` to **agree** — compared by realpath, with no git
command run in a possibly hostile anchor. A disagreement means one source was
tampered with and fails closed rather than trusting either; a legacy watch
with no recorded root falls back to the cwd-derived clone. The listing anchors
each watch's trust check (and `unsavedWork`) to `trustAnchor(state)`; the write
path's `requireWorktree` takes a separate `trustRoot` distinct from its `root`
(the watch root, which stays the stop of the symlink walk), and `push`/`sync`
pass `trustAnchor(state)`. No single round-writable source is the anchor.

### 3. Clone-wide watch listing

`status` (default, no explicit root) and the daemon `listAutofixPrWatches`
enumerate the clone's worktrees NUL-safely (`cloneWorktreeRoots`) and scan
each one's `.qwen/tmp`, merging watches. Dedupe by PR number: git forbids the
same branch checked out in two worktrees, so a PR's watch worktree exists in
at most one worktree and merges never double-count an active watch; a live
watch worktree wins over a stale state file in another root. The daemon view
keeps reporting the clone's main worktree as `root` for display; the scan
covers all worktrees, preserving "two workspaces of one clone list the same
watches". A programmatic single `root` passed to `runStatus` (tests, internal
callers) still scans just that worktree; the CLI exposes no `--root` flag.

Before reading, `vouchedScanRoots` filters the enumerated roots (file reads
only, no git command, so the daemon stays within its one git call): it drops
watch worktrees nested in another root's `.qwen/tmp` (a state file force-added
there would forge a watch), and vouches each remaining root against the
genuine clone's worktree entries — a stale entry an unrelated repository now
occupies, or a sibling whose `.git` was rewritten, is not read as this clone's
watch. The genuine common dir is resolved for both layouts: a non-bare main
worktree's `.git` directory, or a bare clone's main entry, which _is_ the git
dir (no `.git` child). An anchor that cannot be resolved is **not** validation
success: the scan then trusts only the primary root, never failing open to
unvouched siblings. Each worktree's directory scan is isolated: a sibling
whose `.qwen/tmp` is a regular file or inaccessible (ENOTDIR/EACCES) is
skipped, not allowed to abort the listing of every other worktree's watches (a
500 for the whole clone via the daemon). The **primary** root's read failure
is surfaced (thrown), not swallowed into an empty listing — an unreadable main
`.qwen/tmp` is a real diagnostic. The same per-root isolation applies to watch
discovery (`findWatchRoot`), so a malformed sibling cannot stop a helper from
finding and ending a healthy watch elsewhere. The daemon view redacts sibling
absolute paths and state-file names from `unreadable[].error` (the CLI keeps
the full path).

### 4. prepare refusal stays as a safety net

`assertSessionCanRunWorktree` is unchanged. With worktree-rooted storage it
now passes for linked-worktree daemon sessions (worktree inside cwd). It still
refuses when the worktree would fall outside the session's working directory
(e.g. the session sits in a subdirectory of the worktree), naming the directory
to prepare from.

## Design decisions and rationale

- **Environment-aware root, not always worktree-rooted.** Always rooting at
  `--show-toplevel` is simpler but regresses plain-CLI cross-worktree
  operation: today a watch prepared in the main worktree can be operated from
  a linked worktree (no guard outside the daemon). The env split confines the
  change to the exact broken case (daemon + linked worktree) and preserves
  every currently-working flow. The extra branch is regression avoidance, not
  speculative flexibility.
- **Clone-wide listing rather than per-worktree listing.** Keeps the Web
  Shell's clone-level contract intact while storage becomes worktree-aware.
- **Guard untouched.** The containment boundary is a security property; the
  fix moves the artifacts inside it instead of moving the boundary.

## Constraints

- ESM, strict TS, no `any`; kebab-case files; collocated `*.test.ts`.
- Security checks must remain fail-closed; no helper writes outside the
  watch's `.qwen/tmp`.
- The daemon listing runs on its own thread and must not hang: keep the
  per-worktree git timeout and non-blocking file reads.

## Risks and migration

- **Existing main-rooted watches.** A main-clone session still finds them
  (`watchRoot === repoRoot`); the clone-wide listing shows them from any
  worktree. Helpers discover the watch wherever it lives (`findWatchRoot`), so
  a linked-worktree session can `cleanup` a main-rooted watch directly — no
  need to change directory to the owning worktree. To move a watch to another
  worktree, `cleanup` it (adding `--take-over` when it belongs to another
  session, which `assertOwnedBySession` otherwise refuses) and re-`prepare` in
  the target. On a fresh prepare, `reconcileHistory` merges the PR's history
  across the clone's worktrees **including the destination's own copy**, so a
  return hop to a former root does not lose what a later hop settled. The
  settled lists (handled comments, posted replies, spent checks/reruns) are
  unioned; the pending lists (rerun holds, deferred runs, announced posts) are
  settlement state, taken from the most recently written copy with any hold
  whose floor was already spent dropped — a relocation never resurrects a hold
  a later watch spent (which would re-run an already-settled check). The
  handled-conflict marker is a scalar settlement, so the most recent copy wins
  too: a stale main-root marker cannot override a newer linked-root settlement
  and re-fix a conflict already left to a human. `cleanup` keeps a worktree
  that holds work; no silent data loss.
- **Cross-environment operation.** A watch prepared under the daemon in a
  linked worktree lives there; operate it from that worktree. Plain-CLI
  `status` still discovers it via the clone-wide scan.
- **Listing cost.** Scanning N worktrees instead of one; bounded by the
  worktree count and the existing git timeout. Acceptable for the Web Shell.

## Validation plan

- Unit: `parseWorktreePaths` NUL-safety (a newline-bearing path fabricates no
  root); `watchRoot()` env split and `resolveWatchRoot`/`findWatchRoot`
  discovery — `cleanup` ends a main-rooted watch from a daemon session in a
  linked worktree, and `prepare` relocates and merges history across two hops;
  clone-wide `status` merge + live-worktree dedupe (discriminating both
  orderings); `vouchedScanRoots` (a nested watch worktree and a foreign stale
  entry are not read); the primary root's read failure is surfaced; trust
  anchored to the genuine clone on both the listing and the write path
  (`requireWorktree`/`unsavedWork`), a rewritten sibling gitfile never
  executing its config; the daemon listing across worktrees with `unreadable`
  paths redacted.
- Regression pin: a daemon session in a linked worktree prepares a watch
  whose worktree is inside the session cwd and `assertSessionCanRunWorktree`
  passes (the exact b1887512 failure).
- E2E (`.qwen/e2e-tests/`): from a linked-worktree daemon session,
  `/autofix-pr <n>` prepares, runs a round and pushes; the Web Shell watch
  list shows the watch from a sibling workspace of the same clone.
- `npm run build && npm run typecheck` plus the changed packages' unit tests.

## Acceptance criteria

- A linked-worktree daemon session can prepare/run/resume a watch end to end.
- The daemon shell guard and worktree trust checks are byte-for-byte unchanged
  in behavior; no sibling-worktree execution is admitted.
- The Web Shell lists every watch of the clone from any workspace.
- Plain-CLI flows, including cross-worktree operation of a main-rooted watch,
  are unchanged.
- SKILL.md and the 2026-10-21 design doc (both languages) reflect the new
  storage root and listing scope.

## Open questions

- The programmatic `root` arg stays single-root and the CLI exposes no
  `--root`; only the default and the daemon scan clone-wide. (Decided: no CLI
  flag added.)
- Do we want a one-time migration that relocates an existing main-rooted watch
  into the session's worktree on `resume`, or keep the manual
  `cleanup` + re-`prepare` remedy? (Proposal: manual, no silent relocation.)
