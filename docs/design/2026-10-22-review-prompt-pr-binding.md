# Bind a PR When `/review` Is Admitted

[English](2026-10-22-review-prompt-pr-binding.md) | [简体中文](2026-10-22-review-prompt-pr-binding.zh-CN.md)

Date: 2026-10-22
Status: Implemented

## Problem

The Web Shell shows a PR badge from the session PR sidecar. A user can type
`/review 15172` in a Web Shell session. The command runs, but the session gets
no PR binding at that moment. See
[the session PR binding design (in Chinese)](2026-08-20-webshell-session-pr-binding.md)
for the binding model and the sidecar format.

The on-demand sweep (`POST /sessions/backfill-prs`) can derive the binding from
the typed command. It reads the transcript. That design has two gaps:

1. The normal Web Shell flow does not trigger the sweep.
2. A new session can bind before its transcript file exists. A sweep cannot
   read a command that is not on disk.

## Decision

Bind the PR when the daemon admits a `/review` prompt.

- The hook is in the daemon prompt route (`POST /session/:id/prompt`). The Web
  Shell client does not own session persistence.
- The hook sends the command to the existing backfill pipeline. One parser, one
  URL resolver, one sidecar writer.
- The live path scans only the target session. It does not sweep the workspace.
- The hook is asynchronous and best-effort. It never delays or fails the turn.

## Guardrails

- **Explicit command only.** The shared grammar reads `/review <N|#N|PR URL>`
  at command position. Assistant prose and tool output cannot create a binding.
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
- **Provenance.** The binding uses `source: 'review'`. The `create` and
  `worktree` sources outrank it. The existing cap keeps stronger bindings.
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
- `packages/cli` typecheck, ESLint, and Prettier pass.

## Acceptance criteria

- `/review 15172` in a Web Shell session adds PR #15172 to the session badge
  and search after the normal catalog refresh.
- A prompt that is not an explicit PR review creates no binding and no platform
  query.
