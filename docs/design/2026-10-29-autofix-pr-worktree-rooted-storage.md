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

### 1. Environment-aware watch root

Add `watchRoot()` in `packages/cli/src/commands/autofix-pr/state.ts`:

- Daemon session (`QWEN_CODE_SERVE === '1'`): the **current worktree's
  toplevel** (`git rev-parse --show-toplevel` from cwd) — the session's
  containment boundary, so artifacts are reachable.
- Otherwise: `repoRoot()` (the clone's main worktree), exactly as today.

Every helper resolves `autofixPrPaths(watchRoot(), pr)` instead of
`autofixPrPaths(repoRoot(), pr)`: `prepare`, `snapshot`, `sync`, `push`,
`reply`, `rerun`, `ci-log`, `schedule`, `fix`, `cleanup`, and `status`'s
default root. `repoRoot()` itself is unchanged (the `review` command and the
listing's display root still use it).

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
watches and `status` would execute the replacement's `core.fsmonitor`. The
listing therefore anchors every trust check (and `unsavedWork`) to
`repoRoot()`, the genuine clone's main worktree, whose `.git` is a real
directory a sibling cannot rewrite. A watch rooted in a linked worktree is
still validated against the genuine clone's worktree entries, so legitimate
watches stay trusted.

### 3. Clone-wide watch listing

`status` (default, no explicit root) and the daemon `listAutofixPrWatches`
enumerate `git worktree list --porcelain` and scan each worktree's
`.qwen/tmp`, merging watches. Dedupe by PR number: git forbids the same branch
checked out in two worktrees, so a PR's watch worktree exists in at most one
worktree and merges never double-count an active watch. The daemon view keeps
reporting the clone's main worktree as `root` for display; the scan covers all
worktrees, preserving "two workspaces of one clone list the same watches".
A programmatic single `root` passed to `runStatus` (tests, internal callers)
still scans just that worktree; the CLI exposes no `--root` flag. Each
worktree's directory scan is isolated: a sibling whose `.qwen/tmp` is a
regular file or inaccessible (ENOTDIR/EACCES) is skipped, not allowed to
abort the listing of every other worktree's watches — which through the
daemon would be a 500 for the whole clone.

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
  worktree. A linked-worktree session computes paths under its own worktree
  and will not find a main-rooted state file; `prepare` there attempts a new
  watch and hits the branch-in-use refusal. Documented remedy: run `cleanup`
  from the worktree that owns the watch (the main worktree for a legacy watch
  — `cleanup` from the linked session roots there and would not find it), then
  re-`prepare` in the target worktree. `cleanup` keeps a worktree that holds
  work; no silent data loss. `prepare` imports the PR's history from the old
  owning worktree when the new root has none, so handled comments, posted
  replies and CI rerun records survive the relocation instead of being
  answered again.
- **Cross-environment operation.** A watch prepared under the daemon in a
  linked worktree lives there; operate it from that worktree. Plain-CLI
  `status` still discovers it via the clone-wide scan.
- **Listing cost.** Scanning N worktrees instead of one; bounded by the
  worktree count and the existing git timeout. Acceptable for the Web Shell.

## Validation plan

- Unit: `watchRoot()` env split (daemon linked / daemon main / plain CLI);
  each helper roots at `watchRoot()`; clone-wide `status` merge + dedupe;
  daemon listing across multiple worktrees; trust checks unchanged when root
  is a linked worktree.
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
