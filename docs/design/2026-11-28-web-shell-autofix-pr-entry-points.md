# Web Shell `/autofix-pr` Entry Points

[English](2026-11-28-web-shell-autofix-pr-entry-points.md) | [简体中文](2026-11-28-web-shell-autofix-pr-entry-points.zh-CN.md)

**Status:** Implemented (Batch 1 + Batch 2)

## Problem Statement

Web Shell already exposes `/autofix-pr` watch state (`GET /autofix-pr/watches`, `AutofixPrWatchesDialog`, and watch cards inside `ScheduledTasksDialog`), and displays pull requests in multiple places (`SessionDetailsTooltip`, `GitHubPrsDialog`). However, every PR surface is currently read-only: users must remember the `/autofix-pr` slash command, switch to a chat session, and type `/autofix-pr <PR>` or `/autofix-pr resume <n>` manually. Even the PR watches page empty state and ownerless cards only display command hints instead of actionable controls.

## Goals

1. Let users start, resume, or jump to an `/autofix-pr` watch directly from existing PR surfaces in Web Shell without typing slash commands.
2. Keep all PR surfaces consistent with live watch state so an actively watched PR shows its current phase (`Watching`, `Fixing`, `Retrying`, or `Needs you (N)`) instead of offering a duplicate start button.
3. Preserve `/autofix-pr`'s existing confirmation, trust, and session-binding guarantees without introducing new daemon endpoints.

## Non-Goals

- Inline chat header PR watch pill (optional future polish; chat header hover already surfaces PR actions through `SessionDetailsTooltip`).
- Dynamic welcome-screen suggestions for failing PRs.

## Proposed Solution

### 1. Shared Watch Index & Context (`AutofixPrContext`)

`App.tsx` polls `useAutofixPrWatches` once across operable workspaces whenever `autofix_pr_watches` and workspace project features are available (and not in managed mode). Watches are indexed in `indexAutofixPrWatches` by canonical PR URL key (`host/owner/repo#number`, case-insensitive) and exposed through `AutofixPrContext` alongside:

- `canStartInWorkspace(workspaceCwd)` — enforces workspace trust and `lockedWorkspaceCwd`.
- `isWatchStateReady(workspaceCwd)` — requires watch state to be loaded without error (and present for the target workspace) before showing unwatched `Autofix` start triggers.
- `startInNewSession({ prompt, workspaceCwd, sessionTitle })` — creates a dedicated session in the target workspace, submits the `/autofix-pr` prompt once the cleared draft commits, and disarms `pendingManualTitleRef` on every drop, timeout, supersede, or unmount path.
- `openWatch(entry)` — resolves the watch's owning scheduled task across operable workspaces and opens that Web Shell session directly, falling back to the PR watches page when the watch is owned by an external CLI session.

`indexAutofixPrWatches` deduplicates linked checkouts sharing a clone `root` while accumulating `needsHumanCount` and `activeCloneCount` across independent clones of the same repository. `AutofixPrWatchesDialog` consumes this shared watch state when mounted inside `AutofixPrContext` (triggering an immediate `reload()` on open) and retains its local `useAutofixPrWatches` fallback when rendered standalone.

### 2. State-Aware PR Row Action (`AutofixPrActionButton`)

A single reusable action pill handles every PR state:

- `merged` / `closed` PRs (or open PRs whose live watch phase is already `merged` / `closed`): renders nothing.
- Actively watched PR (`watching` / `fixing` / `abandonedFix`): shows `Needs you (N)` (highest priority when `entry.needsHumanCount > 0`), `Fixing`, `Retrying`, or `Watching`; clicking opens the owning session or PR watches page.
- Idle watch (`idle`): shows `Resume`, launching `/autofix-pr resume <n>` in a new session of the watch's own clone (`entry.workspaceCwd` taking precedence over the surface workspace).
- Unwatched, `ended`, or `unscheduled` open PR: shows `Autofix`, launching `/autofix-pr <prUrl>` (or `/autofix-pr <prUrl> --in-place --watch` when restarting an existing `inPlace: true` watch) in a new session of the target workspace (gated on watch-state readiness when unwatched).

### 3. Integrated Surfaces

1. **`SessionDetailsTooltip`** (covers sidebar session hover, chat header hover, and Sessions Overview details): renders a compact `AutofixPrActionButton` on the right of each open PR row, closes the popover without restoring focus to the anchor row when triggered, pins click-opened focus onto Copy Session ID, and hides actions on `readOnly` (untrusted workspace) rows.
2. **`GitHubPrsDialog`** (`GitDialog` PRs tab): splits each row into the existing GitHub link (`<a>`) and a right-aligned `AutofixPrActionButton`, highlighting PRs with `checks === 'failing'` or `reviewDecision === 'changes_requested'`, and closes `GitDialog` on click.
3. **`GitDialog` Commit & Create PR follow-up**: renders a prominent `AutofixPrActionButton` directly inside the post-creation success banner once a PR is created, letting users hand a brand-new PR to `/autofix-pr` in one click and closing `GitDialog`.
4. **`AutofixPrWatchesDialog` + `StartAutofixPrDialog`**: adds a **Watch a PR** button in the page header and empty state whenever at least one operable trusted workspace exists, opening a modal dialog (`dismissible={!submitting}`) with workspace selection (resetting PR input on workspace switch), open-PR picker (marking already-watched PRs), PR URL / `#number` input (stripping GitHub PR sub-paths such as `/files` or `/checks`), mode (`watch` vs `--once`), CLI-validated check interval (`--every` restricted to `1, 2, 5, 10, 15, 30, 60` minutes), reply toggle (`--no-reply`), and optional instructions. Adds one-click **Resume watch**, **Restart watch** (preserving `--in-place --watch` for `inPlace: true` watches), and **Clean up** buttons on cards with global in-flight action disabling across cards, while preserving the `outsideDaemon` notice for watches actively running in an external CLI session.
5. **Sidebar navigation badge, `SessionPrBadge` indicator, and session overflow (`...`) menu**:
   - The `PR watches` sidebar nav item shows an attention count pill (or corner dot when collapsed / in rail layout) whenever any non-ended watch has pending `needsHuman` items, and an active watch count pill/dot otherwise.
   - `SessionPrBadge` displays a subtle status dot (green `watching`, pulsing blue `--status-running-fg` `fixing`, amber `retrying` / `needsHuman`) alongside its accessible `aria-label` / `title` status suffix for open bound PRs without altering the compact pill text.
   - The session `...` overflow menu exposes state-aware items (`Autofix PR #<n>`, `Resume autofix PR #<n>`, or `PR #<n> watch (<status>)`) for each open bound PR so touch, mobile, and keyboard users do not depend on hover.

## Design Decisions & Rationale

1. **Dedicated new session by default**: Each daemon session carries at most one durable scheduled task (`session_already_bound`), and a development session may be busy or bound to multiple PRs. Starting `/autofix-pr` in a fresh session titled `Autofix PR #<n>` avoids collisions, keeps watch history isolated, and keeps the skill's own confirmation prompt (`ask_user_question`) intact.
2. **One-click on compact surfaces, modal options on the PR watches page**: Hover tooltips (`SessionDetailsTooltip`) cannot safely nest portaled dropdown menus without hover-dismiss races, and PR list rows benefit from one-click launch. Users who want `--once`, custom `--every`, `--no-reply`, or extra instructions can configure them in `StartAutofixPrDialog`.
3. **Render-committed draft latch for new-session prompt dispatch**: `clearSession()` updates React state asynchronously; `pendingNewSessionRunRef` waits until `connection.sessionId === undefined && !sessionWriteBlocked` with invocation and workspace staleness guards so a fast clear never sends `/autofix-pr` into the previously attached session.

## Constraints & Risks

- Requires daemon capability `autofix_pr_watches` and an operable trusted workspace; untrusted and out-of-scope (`lockedWorkspaceCwd`) workspaces are rejected at both render time and dispatch time.
- Watches actively running in an external CLI session (`checkedRecently` or active `fixing` without a Web Shell scheduled task) remain non-hijackable from the UI (`outsideDaemon` hint) and navigate to the PR watches page instead of failing session load.

## Validation Plan & Acceptance Criteria

- Unit tests cover command builders, PR URL canonicalization, watch indexing and summaries (`autofixPrWatches.test.ts`), action button state transitions (`AutofixPrActionButton.test.tsx`), modal validation and submission (`StartAutofixPrDialog.test.tsx`), tooltip integration (`SessionDetailsTooltip.test.tsx`), GitHub PR list and post-create follow-up (`GitHubPrsDialog.test.tsx`, `GitDialog.test.tsx`), PR badge watch indicators (`SessionPrBadge.test.tsx`), sidebar nav badge and session overflow menu (`WebShellSidebar.bind-pr.test.tsx`), PR watches page actions (`AutofixPrWatchesDialog.test.tsx`), and `App`-level new-session dispatch & trust enforcement (`App.test.tsx`).
- `packages/web-shell` passes `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run build`, and targeted unit tests.
