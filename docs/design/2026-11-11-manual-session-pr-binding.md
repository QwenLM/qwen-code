# Manual Session PR Binding

[English](2026-11-11-manual-session-pr-binding.md) | [简体中文](2026-11-11-manual-session-pr-binding.zh-CN.md)

Date: 2026-11-11
Status: Proposed

## Problem

A session's GitHub PR binding (the sidecar `<chatsDir>/<sessionId>.pr.json`,
rendered as the sidebar badge and matched by session search) is written by
three automatic paths: the Web Shell Git dialog after it creates a PR, the
shell tool's `gh pr create` post-hook, and the on-demand backfill sweep
(`/review` mentions and the `pr-<N>` worktree convention). All three are
deliberately narrow — the backfill refuses transcript text as a source
because printed URLs cannot be attributed to gh's own execution (see
[Web Shell session PR binding](2026-08-20-webshell-session-pr-binding.md)).

When none of them fires, the binding is missed. Real recurring cases:

- `cd <worktree> && gh pr create` without the shell tool's `directory`
  parameter: the post-hook resolves the launch directory's branch, not the
  worktree's, and declines; a bare `git worktree add` worktree has no
  daemon worktree sidecar, so the `pr-<N>` convention cannot recover it.
- A session takes over an existing PR (review-fix, autofix) without ever
  running `/review <N>` in command position.
- A background or promoted `gh pr create` run, which the post-hook
  deliberately does not bind.

Today the only recovery is a manual REST call:
`PATCH /session/:id/metadata` with a bearer token, the session id, and a
complete `{number, url, state}` body. That is out of reach for a user in the
TUI or the Web Shell, and in practice the agent has to be reminded to run it.

## Current state

| Surface                                                        | State                                                                                                                                 |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| REST `PATCH /session/:id/metadata` (and workspace-scoped twin) | Accepts `pr`; persists the sidecar with `source: 'create'`. Requires token + session id + full body.                                  |
| ACP `qwen/session/update_metadata`                             | Accepts `metadata.pr`; same persistence and reconciliation (`acp-http/dispatch.ts`).                                                  |
| SDK `DaemonSessionClient.updateMetadata`                       | Already typed `{displayName?, pr?}`; the Web Shell Git dialog already sends `pr` through the workspace REST twin after creating a PR. |
| Web Shell UI                                                   | No entry for binding an arbitrary existing PR; `updateMetadata` is only used for renames and the Git dialog's post-create write.      |
| Slash commands                                                 | No PR-binding command exists.                                                                                                         |
| Backfill `POST /sessions/backfill-prs`                         | Trusted sources only; cannot recover an arbitrary missed number.                                                                      |

The daemon, bridge, and SDK plumbing for a client-initiated binding is
therefore complete. What is missing is a user-facing entry in the session
itself (TUI + Web Shell) and in the Web Shell session overview.

## Goals

- A user can bind a PR to the current session by typing `/pr <number|url>`
  in the TUI, headless CLI, or a daemon (Web Shell) session — no token, no
  session-id lookup.
- A user can bind a PR to any session from the Web Shell session overview
  panel or the sidebar session menu through a small dialog.
- Both entries reuse the existing persistence, provenance, cap, and refresh
  machinery; the daemon and SDK gain no new routes or types.

## Scope boundaries (explicitly not doing)

- No unbind/clear semantics (the original binding design provides none).
- No relaxation of the automatic attribution gates; transcript text stays a
  non-source. Manual binding is explicit user intent, the same authority
  level as the existing REST PATCH, not a new automatic source.
- No new daemon route, bridge change, or SDK type change.
- GitHub only. Aone workspaces keep the existing REST/backfill paths; the
  command's `gh` resolution and the dialog's PR list are GitHub-specific.
- No repo-identity gate on manual binding: the user names the PR, so `gh` is
  used to resolve the canonical URL/state, not to prove attribution (unlike
  the shell post-hook, which must prove the session created the PR).

## Proposed solution

### A. `/pr` slash command

New built-in command `packages/cli/src/ui/commands/pr-command.ts`,
registered in `BuiltinCommandLoader`, with
`supportedModes: ['interactive', 'non_interactive', 'acp']` and
`argumentHint: '<number | url>'`. Daemon sessions execute built-in actions
in the session child process through `handleSlashCommand`, the same path
`/forget` and `/rename` use; the child process writes the same sidecar the
shell post-hook writes, so no token or daemon round-trip is needed.

Behavior:

1. **No argument** — read the session's sidecar (`readSessionPrsDetailed`)
   and list the bound PRs (number + state), followed by the usage line.
   This gives the TUI a way to verify a binding, which it otherwise lacks.
   A failed or corrupt read reports its own error message — it is not an
   authoritative "no bindings".
2. **Argument parsing** — accept a bare number (`[1-9]\d{0,8}`, mirroring
   the backfill's bound), `#N`, or a full PR URL. `#N` and URL forms reuse
   `GitWorktreeService.parsePRReference`; anything else is a usage error.
3. **Resolution** — a new core helper
   `fetchPullRequestByReference(cwd, ref)` in `utils/github-prs.ts` runs
   `gh pr view <ref> --json number,url,state` (ref is the number or the
   URL), reusing `resolveGhBinary`, `ghEnv`, and the existing timeout.
   - gh resolves → bind gh's `{number, url, state}` (gh is canonical, also
     for URLs with `/files` subpaths, queries, or enterprise hosts).
   - gh fails and the input was a full URL → bind `{number, url}` without
     state, normalized to the canonical `/pull/<N>` spelling via
     `pullRequestViewUrl` so a later re-bind matches the same sidecar key.
     The URL must pass `isValidSessionPrUrl`. The daemon's refresh sweep
     fills the state later for same-repository URLs (see Constraints).
   - gh fails and the input was a bare number → error. The helper
     classifies the failure (`unavailable` for a missing gh binary,
     `timeout` for a killed child, `failed` otherwise); environmental
     failures get their own message instead of a PR-specific remedy.
4. **Persistence** — mirrors the shell post-hook: best-effort
   `getSessionLocation` (re-resolved after the gh round trip) →
   `getPrSessionPathForArchiveState` →
   `upsertSessionPrs([{number, url, state?, source: 'create'}])` →
   `emitSessionPrBound` when the number was newly added. The notification
   is best-effort in its own catch: the binding is already persisted, so a
   catalog-mark failure must not read as a bind failure. The ACP host
   already wires that callback to `qwen/notify/session/pr-binding`, so the
   daemon marks the session catalog and live-state clients refetch the
   badge (~2s), identical to the automatic create binding.
5. **Result messages** — success (`Bound PR #N to this session.`),
   already-bound (same URL keeps position and `createdAt`; an explicit
   gh-resolved state repairs a stateless entry in place), or a
   resolution/usage error.

`source: 'create'` matches what the existing manual REST/ACP paths stamp;
`upsertSessionPrs` never downgrades a stronger persisted provenance
(`worktree`) for the same number at the same canonical URL, so a
convention binding survives a manual re-bind. (A same number at a
DIFFERENT canonical URL is another PR and replaces the entry — the
documented per-PR replacement semantics.)

i18n: the description and every user-facing string go into all nine built-in
locales; `zh` and `zh-TW` are strict-parity locales whose test suite fails
on any untranslated built-in command description.

### B. Web Shell bind-PR dialog

New component
`packages/web-shell/client/components/dialogs/BindSessionPrDialog.tsx`,
modeled on `SessionRenameDialog` (`DialogShell size="sm"` + `Input` +
error row + Cancel/Bind). The input accepts a PR number, `#N`, or URL:

- **URL** — parse `/pull/<N>` client-side, validate http(s), submit
  `{number, url}` without state, normalized to the canonical `/pull/<N>`
  spelling (the refresh sweep resolves it for same-repository URLs).
- **Number / #N** — fetch the workspace PR list through the existing
  `workspaceGitHubPullRequests()` SDK call (the `GitHubPrsContent` fetch
  pattern) and match by number → `{number, url, state: 'open'}`. The list
  only carries open/draft PRs; a number absent from it produces an error
  asking for the full URL (merged/closed PRs bind by URL). A non-git
  workspace (`available: false`) and a cwd-less legacy session get a
  "paste the URL" message instead of a bogus lookup.

The dialog guards the in-flight resolution: a liveness ref checked after
every await prevents a parent-unmounted dialog from submitting a binding
the user cancelled, and `dismissible={!resolving}` blocks dismissal while
the list request is pending. A double submit while resolving is absorbed
by the pending flag (one fetch, one write). Local validation errors
outrank the host's stale daemon error and clear on input change.

The dialog's non-redundant value over `/pr` is binding a session the user
is NOT currently in: the command can only ever bind "this session", while
the dialog binds any row in the overview panel or sidebar.

Entry points: a `GitPullRequestIcon` ghost button in the
`SessionOverviewPanel` actions column, next to Rename, gated by the same
`canRenameCard` capability (metadata mutation); and a Bind PR item in the
sidebar session dropdown (`WebShellSidebar`), gated by `showRename` plus
the host's `sessionActionItems` whitelist (`bindPr` item) and hidden for
standalone sessions (their metadata route only accepts `displayName`). A
`bindPrTarget` / `bindPrCandidate` state drives the same dialog from
either surface.

Submit routing mirrors `saveRename`'s three branches:

- current session → a new `bindSessionPr(pr)` action in
  `daemon/session/actions.ts` (same `withActionTimeout` +
  `dispatchActionError` wrapper as `renameSession`), signed in
  `daemon/session/types.ts`;
- other session with a workspace cwd →
  `workspace.client.workspaceByCwd(cwd).updateSessionMetadata(id, {pr})`;
- otherwise → `workspace.client.updateSessionMetadata(id, {pr})`.

On success: `sessionCatalogController.refreshWorkspace(ownerCwd)` +
`reloadData()` (the same refresh path renames use; the badge reads `prs`
from the session list, not from the pr-only `session_metadata_updated`
event, whose mapper semantics stay untouched). On failure: the panel's
`setActionError` row.

i18n: new `sessionsOverview.bindPr*` keys in both EN and ZH dictionaries of
`client/i18n.tsx`. The command is also registered in the Web Shell's two
built-in tables — `BUILT_IN_COMMANDS` (HelpDialog, so `/pr` lists under
Built-in, not Custom) and `BUILTIN_COMMAND_DESCRIPTION_KEYS`
(localCommands, `local.pr`, so the slash-menu description follows the UI
language instead of the daemon's process language).

## Key design decisions

- **Explicit user intent is the authority.** Both entries are deliberate
  user actions, equivalent to the existing REST PATCH. They do not widen
  the automatic attribution surface, so the anti-forgery boundary of the
  backfill design stays intact.
- **Reuse the shell post-hook's write path for the command.** The child
  process already writes the sidecar directly with cross-process locking
  and catalog notification; a command doing the same inherits all of that
  with no new daemon involvement.
- **`gh` resolves, never gates, for manual binding.** A failed `gh` lookup
  degrades to the user-supplied URL instead of refusing the binding; the
  refresh sweep repairs state later for same-repository URLs. Bare numbers
  cannot degrade (there is no URL to bind), so they error with a
  cause-classified message. Both manual write sites normalize the stored
  URL to the canonical `/pull/<N>` spelling so a re-bind matches the same
  sidecar key; entries persisted as-is by OTHER writers (REST PATCH, Git
  dialog) are still covered by the sweep's compensation layer:
  `session-pr-refresh` matches via `samePullRequest` (which tolerates
  subpaths/queries) and rewrites the fetched snapshot under the entry's own
  URL before the sidecar's canonical gate.
- **No state fabrication.** URL bindings omit `state` rather than guessing
  `open`; only a list match (open/draft) stamps `open`.
- **Dialog over inline input.** Binding needs a resolution step (number →
  URL) and an error surface; the overview panel's inline rename form has
  neither, while `DialogShell` templates are established.

## Files affected

| Layer       | Files                                                                                                                                                                                                                                                                                                |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| core        | `utils/github-prs.ts` (new `fetchPullRequestByReference`), `services/session-pr-service.ts` (same-URL state repair)                                                                                                                                                                                  |
| CLI command | `ui/commands/pr-command.ts` (new), `services/BuiltinCommandLoader.ts`, `ui/opentui/commands-registry.ts` (OpenTUI parity route — the registry gate asserts both-direction set equality with the loader)                                                                                              |
| CLI i18n    | `i18n/locales/*.js` (9 files), `i18n/mustTranslateKeys.ts` (the command's strings)                                                                                                                                                                                                                   |
| Web Shell   | `components/dialogs/BindSessionPrDialog.tsx` (new), `components/SessionOverviewPanel.tsx`, `components/sidebar/WebShellSidebar.tsx`, `components/dialogs/HelpDialog.tsx`, `constants/localCommands.ts`, `daemon/session/actions.ts`, `daemon/session/types.ts`, `i18n.tsx`, `test/sidebarHarness.ts` |
| Tests       | collocated unit tests for each of the above                                                                                                                                                                                                                                                          |

## Constraints and risks

- The command runs `gh` in the session's target directory; in a checkout
  whose origin gh cannot resolve, number resolution fails and the user
  must paste the URL. This is the documented degradation, not a bug.
- The sidecar cap (10) and provenance eviction apply unchanged; a manual
  bind can evict a weaker `review` entry, exactly like a REST PATCH today.
- The dialog's number lookup depends on the workspace PR list cache
  (open/draft only, capped); stale or absent entries degrade to the URL
  input path.
- Locale parity tests gate the command description; missing translations
  fail CI rather than shipping English fallbacks in zh/zh-TW.
- **No unbind path.** A mistyped manual bind (e.g. `/pr 431` meaning
  `#413`) creates a durable, actively refreshed wrong binding that no
  surface removes; recovery is hand-editing
  `<chatsDir>/<sessionId>.pr.json`. This is the original binding design's
  no-clear semantics, now reachable by free-form input — a removal path
  (`--clear` or a nullable `pr`) is deliberate follow-up scope, not this
  change.
- **The refresh sweep only heals same-repository URLs.**
  `session-pr-refresh` skips bindings whose repository is not the
  workspace's (`isForeign`), so a cross-repo URL bound without state stays
  stateless; the badge still renders and links correctly.
- **The two writers' re-bind semantics differ by design.** `/pr`
  (`upsertSessionPrs`) keeps position and `createdAt` on a same-URL
  re-bind; the dialog/REST path (`upsertSessionPr`) refreshes `createdAt`
  and moves the entry to the tail — the existing metadata-route semantics
  the Git dialog already uses. The acceptance criterion below scopes the
  keep-position guarantee to `/pr`.

## Validation plan

- Unit: command action tests (parsing, resolution branches, persistence,
  notification, messages) with a mock command context; `gh` helper tests
  with mocked `execFile`; dialog tests (number match, URL parse, error
  paths, submitted payload) and overview-panel tests (button gating,
  submit routing, refresh) in the existing jsdom + act style.
- E2E: headless `/pr` against the local bundle in a temp git repo with real
  `gh`; an isolated daemon session binding via `/pr` prompt with sidecar
  and session-list readback; a Playwright spec driving the dialog against
  the mock daemon (committed, `@smoke`-tagged).
- Baseline dry-run on the globally installed CLI first: `/pr` is an unknown
  command there, confirming the gap the feature fills.
- Verification record (2026-11-11, local): the headless and daemon E2E
  above were run manually against the local bundle with real gh
  (8/8 headless cells incl. degradation and error paths; 6/6 daemon cells
  incl. catalog propagation and idempotent re-bind); the Playwright spec
  ran 5/5 on chromium. The maintainer's independent A/B rig additionally
  verified the real-sidecar central claim against the merge-base control
  (87/87 assertions, 8/8 mutations killed). Logs:
  `.qwen/e2e-tests/manual-session-pr-binding.md`.

## Acceptance criteria

- `/pr <N>`, `/pr #N`, and `/pr <url>` bind the PR to the current session
  in TUI, headless, and daemon modes; the sidecar entry carries
  `source: 'create'` and gh-resolved state when available.
- `/pr` with no argument lists the session's bound PRs.
- Re-binding the same PR via `/pr` reports already-bound without moving
  its position or refreshing `createdAt` (the dialog/REST path keeps the
  existing metadata-route semantics; see Constraints).
- The Web Shell overview panel binds a PR to the current session and to
  another session; the badge appears after the catalog refresh; a number
  absent from the open list and an invalid input produce actionable errors.
- `npm run build`, `npm run typecheck`, the focused unit suites (including
  the i18n parity suite), and the E2E groups pass.

## Open questions

None.
