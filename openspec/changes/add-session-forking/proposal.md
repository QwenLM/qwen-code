# add-session-forking

## Why

A long agent conversation tends to accumulate dead ends: a wrong
turn down a refactor that should be backed out, an experiment that
should be tried "but keep the original alive," a debugging tangent
that should be branched off without losing the original context. In
upstream qwen-code there is no first-class branch primitive; the
user's options are:

- `/clear` and start over (loses the useful prior context).
- Manually copy-paste history into a new session (lossy, ad-hoc, no
  parent linkage).
- Live with the bloated transcript (token budget grows, attention
  drifts).

Adding a fork operation makes branching cheap, explicit, and
auditable. A fork:

- Creates a new session with a brand-new `sessionId`.
- Records its parent (`parentSessionId` and `parentEventId`).
- Copies, summarises, or empties prior context depending on caller
  intent.
- Runs independently from then on — both the parent and the fork
  evolve in parallel; the parent is unaffected by the fork's
  activity.

This is symmetric to `git branch`/`worktree` for code: the
underlying object (the parent) stays intact; a new pointer
diverges; the operator can compare or merge by hand if they wish.

## What Changes

- **New endpoint `POST /session/:id/fork`.** Body:
  `{ fromEventId, name?, transcript: "include" | "summary" | "empty" }`.
  Response: `{ sessionId, parentSessionId, parentEventId,
forkedAt }`. The new session is a regular daemon-hosted session
  thereafter — all existing session routes apply to it without
  modification.
- **JSONL transcript header for forks.** The new session's JSONL
  at `~/.qwen/projects/<cwd>/chats/<newSessionId>.jsonl` opens
  with a single header line of `type: "fork"`, then the copied or
  summarized context lines, then live messages. Upstream
  `qwen --resume` tools see it as a normal transcript with an
  extra-noted lineage row at the top.
- **WAL lineage.** The new session's WAL gets its own file; the
  daemon does not share WAL state with the parent. The first WAL
  entry is a `session_forked` event carrying parent metadata for
  reconnect-time replay.
- **Three transcript modes.** `include` copies all parent
  events up to and including `fromEventId` byte-for-byte. `summary`
  asks the agent to emit a single summary message of the prior
  context and uses only that as prior history. `empty` starts
  fresh — only the lineage header, no prior messages, useful for
  "same workspace, totally different task, but I want to record
  where I branched from."
- **Lineage in session listing.** `GET /workspace/:cwd/sessions`
  response items gain `parentSessionId` and `forkedAt` fields when
  applicable, plus a `forks: [<sessionId>...]` counter so a parent
  knows how many children it has. UI can render a tree.
- **"Fork from here" UX.** Web client and terminal client add an
  action on every message card that opens a small "fork" dialog
  (transcript mode + optional name).
- **Cycle prevention by construction.** A fork always points to a
  past event in another session; you cannot fork "into the future"
  and there is no merge primitive in this change.

## Capabilities

### New Capabilities

- `session-forking` — fork endpoint, lineage metadata, JSONL header
  format, transcript copy/summary/empty modes, listing extensions,
  client UX hooks, scope/audit semantics.

## User Stories

**F1. Back out of a refactor.** The agent spent twenty messages
refactoring the wrong module. The operator finds the message at
the start of the wrong turn and clicks "Fork from here". The fork
inherits everything up to that point but not the misdirected work.
The original session stays alive (a "what if I'd just let it
finish" reference); the fork is now the live one.

**F2. Try a parallel approach.** "Let me see what you'd do if I
asked for a Postgres backend instead of SQLite." Fork from the
last shared decision point; ask the new question in the fork; the
parent session is untouched, in case the SQLite path was the
right one.

**F3. Branch with summary only.** A long debugging session
finally found the root cause. The operator wants to start the
"actually fix it now" session without all the noise. They fork
with `transcript: "summary"`; the agent emits one summary message;
the new session opens with that summary as its only prior context.

**F4. Forks visible in listing.** `qwen rc sessions` (or the web
client's session list) renders a small tree:

```
session-alpha            (active, 2h)
  └─ fork-postgres       (forked 14m ago from event #245)
session-beta             (idle, 3d)
```

**F5. Audit trail for forks.** The audit log records every
`session.fork` action with `parentSessionId`, `parentEventId`,
`transcriptMode`, and the originating tokenId. Useful for
attribution and for understanding why a workspace has eight
sessions.

## Impact

- **qwen-code repo**: new route handler in
  `packages/cli/src/serve/remoteControl/forkRoutes.ts`; updates to
  the session manager to support creation-with-parent semantics;
  small change to the JSONL writer to emit the header line. New
  CLI: `qwen rc fork <sessionId> --from-event <id> [--mode include|
summary|empty] [--name <name>]`. Web/TUI clients gain the "Fork
  from here" affordance.
- **Storage**: no schema changes; lineage lives in the JSONL header
  and in a small in-memory adjacency map rebuilt from JSONL on
  startup. Re-derivation from disk is cheap; no SQLite table needed.
- **Independent from share, search, multi-workspace**: this change
  is a self-contained extension of `add-remote-control`'s session
  lifecycle.
- **Out of scope** (deliberately):
  - Merging two sessions back together. Symmetric to git, this
    would be a follow-up if there's demand.
  - Forking across workspaces. A daemon hosts one workspace
    (`add-remote-control` D6); cross-workspace forking is not a
    thing in this model.
  - Mid-prompt fork (the agent is mid-stream on `fromEventId+1`).
    `fromEventId` must point to an event that already has a
    final stop reason in the parent's history; otherwise the
    endpoint returns 409.
  - Automatic agent-side memory transplant. The fork inherits
    the JSONL transcript and the daemon's view; whether the
    agent's own context window is rebuilt from JSONL depends on
    qwen-code's existing resume behaviour. This change does not
    extend the agent's memory model.
  - Visualisation beyond a flat parent/child list. A full tree
    diff UI is out of scope; a simple tree-formatted listing is
    in.
