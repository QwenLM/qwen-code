# Bind a PR When a `/review` or `/verify-pr` Prompt Is Admitted

[English](2026-10-22-review-prompt-pr-binding.md) | [简体中文](2026-10-22-review-prompt-pr-binding.zh-CN.md)

Date: 2026-10-22
Status: Implemented
Updated: 2026-10-26 — `/verify-pr` joins the same command grammar and gate.

## Problem

The Web Shell shows a PR badge from the session PR sidecar. A user can type
`/review 15172` or `/verify-pr 15172 --publish` in a Web Shell session. The
command runs, but the session gets no PR binding at that moment. See
[the session PR binding design (in Chinese)](2026-08-20-webshell-session-pr-binding.md)
for the binding model and the sidecar format.

The on-demand sweep (`POST /sessions/backfill-prs`) can derive the binding from
the typed command. It reports `repoDeclined` per declined claim — a number or a
url form the `--repo` gate refused — so a policy decline is distinguishable
from an empty run even when another source still binds that number. It reads the transcript. That design has two gaps:

1. The normal Web Shell flow does not trigger the sweep.
2. A new session can bind before its transcript file exists. A sweep cannot
   read a command that is not on disk.

## Decision

Bind the PR when the daemon admits a `/review` or `/verify-pr` prompt.

- The hook is in the daemon prompt route (`POST /session/:id/prompt`). The Web
  Shell client does not own session persistence.
- The hook sends the command to the existing backfill pipeline. One parser, one
  URL resolver, one sidecar writer.
- The live path scans only the target session. It does not sweep the workspace.
- The hook is asynchronous and best-effort. It never delays or fails the turn.

## Guardrails

- **Explicit command only.** The shared grammar reads `/review` and
  `/verify-pr`, each with `<N|#N|PR URL>`, at command position. Assistant prose
  and tool output cannot create a binding. The command name must be followed by
  a space or tab, so `/verify-pr-watch` and `/review77` are other commands; the
  filename-character closure applies to the number — `/verify-pr
001_init.sql` is a file, not PR 1.
- **`--repo` scope.** `/verify-pr` accepts `--repo <owner>/<repo>` (gh's
  `[HOST/]OWNER/REPO` form). A number qualified with a repository that is not
  this workspace's own — or the page's confirmed fork parent — is another
  repository's PR and binds nothing; the workspace's same-numbered PR is a
  different PR. The qualifier is read off any prompt command, so a stray
  `--repo a/b` on a pre-existing `/review <N>` also fails closed instead of
  binding this workspace's N, and matching needs the workspace repository key:
  a workspace whose `origin` cannot be resolved declines a qualified number
  even when the qualifier is correct. A number named only through `--repo`
  binds only when the resolved PR belongs to the repository the qualifier
  named — the other side of a fork hosts a different PR with the same number —
  so an unresolvable match declines rather than substitutes.
- **Source.** Only the local user's typed prompt binds. A channel-relayed turn
  is skipped on its raw channel marker, so an external sender cannot write a
  PR binding into the local session.
- **Bounded input.** The grammar scans at most 16 KiB. The lazy URL
  alternative backtracks quadratically, and the live hook runs the match on
  the synchronous prefix of every admitted prompt; the bound covers the sweep
  too.
- **Repository identity.** GitHub numbers resolve through the gh page and the
  workspace repository key. A fork parent is accepted only after confirmation.
  The remote URL is the fallback.
- **Aone.** An Aone number resolves through `mr view`. The code never assembles
  an `<origin>/pull/<N>` link.
- **Provenance.** The binding uses `source: 'review'` for both commands: the
  session merely looked at that PR, and no new sidecar value is introduced.
  The `create` and `worktree` sources outrank it. The existing cap keeps
  stronger bindings.
- **Cap.** A live review joins the existing cap plan. Older `review` bindings
  are evictable; `create`, `worktree`, and pre-provenance entries keep their
  slots. A full session therefore replaces its oldest review instead of
  freezing the badge.
- **Archive state.** Under the archive lane the hook re-resolves the session
  location and writes the matching sidecar. An archived session gets the
  archived sidecar; a deleted session is skipped.
- **Missing transcript.** Only a session the bridge still owns may bind
  without a transcript — a brand-new turn whose transcript is not on disk
  yet. An unknown location fails closed.
- **Publication.** A live write drops the session-list cache and marks the
  catalog changed. The badge appears on the normal live-state refetch.
- **Idempotency.** A repeat `/review` for the same number does not reorder or
  refresh the binding.

## Not registered

- `record_source` is not used. A PR under review is an action target, not a
  reference that the assistant used.
- No binding for a local review: no argument, a file path, a local diff, or PR 0.
- No binding in an untrusted workspace.

## Verification

- The backfill tests cover a live binding without a transcript, the archive
  and URL forms, single-session scope, the catalog mark, file-target
  rejection, the untrusted gate, the oversized-prompt bound, cap eviction
  (including create protection and a repeat review at the cap), the conflict
  branch, the trusted-wrapper target-only and non-review cases, and the
  archive/delete/location-failure lifecycle races.
- The prompt-route tests cover the hand-off of the first text block, the
  rejection of a later block, the untrusted workspace, channel-relayed
  prompts, binder rejection/hang, and the coordinator hand-off.
- `/verify-pr` coverage: the live accept/decline pair (a `--repo` naming this
  workspace binds; one naming another repository declines and reports
  `repoDeclined`), the `-R` spellings — bare, attached, quoted, URL-shaped, or
  with the value on the next line — whose value this grammar cannot read, the
  `--repo=` form, `--assets-repo` left alone, a later
  qualified claim on this workspace's repo winning over an earlier foreign one,
  an unqualified `/review` claim clearing the qualifier, the divergent-page
  binding to the repo the number was qualified to, the transcript
  `slash_command` sweep, and the separator that rejects `/verify-pr-watch` and
  `/review77`.
- `packages/cli` typecheck, ESLint, and Prettier pass.

## Acceptance criteria

- `/review 15172` in a Web Shell session adds PR #15172 to the session badge
  and search after the normal catalog refresh.
- `/verify-pr 15172` binds PR #15172 exactly as `/review 15172` does, live and
  from the transcript sweep.
- A `/verify-pr <N>` carrying no qualifier, or one naming this workspace's
  repository (or the page's confirmed fork parent), binds PR `<N>`, and the PR
  it resolves to must belong to that repository: when the resolved PR is the
  other side of a fork, or cannot be resolved there, the number stays unbound.
  A number whose qualifiers all name another repository binds nothing, unless a
  url form or the worktree convention supplies the number.
- A `/verify-pr` number qualified to another repository binds nothing, writes
  no sidecar and marks no catalog change; the decline is counted in
  `repoDeclined` and reaches the live hook's warning.
- A prompt that is not an explicit PR review creates no binding and no platform
  query.
