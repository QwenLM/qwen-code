# Design — add-session-forking

## Context

`add-remote-control` defines a session as a daemon-owned entity:
the daemon spawns a `qwen --acp` child, mediates prompts via FIFO,
emits SSE events, mirrors to WAL, and persists a canonical
transcript at `~/.qwen/projects/<cwd>/chats/<sessionId>.jsonl`.
There is no relationship between sessions other than "they share a
workspace." Each session is a leaf.

A fork makes sessions into a forest: one session can declare a
parent, with a specific event id within the parent as the divergence
point. The fork inherits a transcript prefix (or a summary, or
nothing) and then runs independently. From the daemon's perspective,
once a fork exists, it's a regular session — same lifecycle, same
WAL, same SSE plumbing, same scope checks. Lineage is a metadata
overlay, not a runtime coupling.

The motivation is operator UX, not agent capability. Forking does
not introduce any new agent reasoning — the agent simply gets a
shorter prompt history when run in the fork. The interesting work
is on the daemon and the clients.

## Goals / Non-Goals

**Goals:**

- A single HTTP call creates a fork.
- The fork is a normal session afterwards (no special-case routes,
  no special-case clients).
- Parent is unaffected: no shared state, no event coupling, no
  cleanup-on-fork.
- Three transcript modes cover the practical use cases.
- Lineage is queryable: `GET /workspace/.../sessions` surfaces it,
  and there's an explicit `GET /session/:id/lineage` that returns
  the chain to root.
- JSONL transcripts remain readable by upstream
  `qwen --resume <sessionId>` without modification (the header line
  is well-formed JSONL; upstream tooling just ignores the
  `type: "fork"` field).
- Cycles impossible by construction: a fork's parent must already
  exist; you can't fork into the future.
- Audit captures every fork.

**Non-Goals:**

- Merging forks. A future change might add a "merge" that copies a
  range of events from one session into another; not in scope here.
- Cross-workspace forking.
- Mid-prompt forking (parent's `fromEventId` must point to a
  completed event).
- A visual tree-diff UI. The listing renders a flat tree-formatted
  table; rich visualisation is out of scope.
- Reverse-resolution: looking up forks of a specific event
  _anywhere across workspaces_. Listing is per-workspace.
- Storage deduplication between parent and `include`-mode fork.
  Each fork has its own JSONL file. Disk usage is the cost of the
  feature; bounded by transcript size.

## Architecture

```
   Parent session   S_parent
   - JSONL: ~/.qwen/projects/<cwd>/chats/S_parent.jsonl
       line  1: { type: "session_start", model, ... }
       line  2: { type: "user", text: "do X" }
       line  3: { type: "assistant", text: "ok" }
       line  4: { type: "tool_call", name: "edit_file", ... }
       line  5: { type: "tool_result", outcome: "ok" }
       line  6: { type: "user", text: "do Y" }
       line  7: { type: "assistant", text: "actually let me ..." }
       line  8: { type: "user", text: "wait, back up" }    ← fromEventId points here
       ...

   POST /session/S_parent/fork
   { fromEventId: 8, transcript: "include", name: "back-up-and-retry" }

   ──────►   daemon allocates new sessionId S_fork
              creates JSONL ~/.qwen/projects/<cwd>/chats/S_fork.jsonl:
                line  1: { type: "fork", parentSessionId: S_parent,
                           parentEventId: 8, forkedAt: <ISO>,
                           transcriptMode: "include", forkedBy: tokenId }
                line  2..N: copy of S_parent lines 1..8
                            (verbatim; eventIds preserved as
                             `originalEventId` in metadata sidecar
                             but new eventIds assigned by the WAL)
              spawns a new agent child for S_fork
                with --resume flag to read the JSONL transcript
              creates a fresh WAL at ~/.qwen/rc/wal/S_fork.log:
                first event: { type: "session_forked",
                               parentSessionId, parentEventId, ... }
              emits SSE: `session_forked` to S_parent's subscribers
                (informational; parent stays alive)
              emits SSE: live event stream to S_fork's subscribers
                (starts with `session_forked` then normal events)

   ◄──────   200 { sessionId: S_fork, parentSessionId: S_parent,
                  parentEventId: 8, forkedAt }
```

After this, `S_fork` is a regular session. Every existing route
(`/session/S_fork/prompt`, `/session/S_fork/events`,
`/session/S_fork/end`, etc.) works on it identically. The parent
`S_parent` continues to run; its FIFO is independent.

## Lineage model

```
   GET /workspace/<cwd>/sessions

   {
     "sessions": [
       {
         "sessionId": "S_parent",
         "name": "main",
         "createdAt": "...",
         "lastActivityAt": "...",
         "state": "active",
         "parentSessionId": null,
         "parentEventId":   null,
         "forks": ["S_fork_a", "S_fork_b"]
       },
       {
         "sessionId": "S_fork_a",
         "name": "back-up-and-retry",
         "createdAt": "...",
         "lastActivityAt": "...",
         "state": "active",
         "parentSessionId": "S_parent",
         "parentEventId": 8,
         "forkedAt": "...",
         "transcriptMode": "include",
         "forks": []
       },
       ...
     ]
   }
```

A separate `GET /session/:id/lineage` returns the chain to root:

```
   {
     "sessionId": "S_fork_a",
     "chain": [
       { "sessionId": "S_fork_a", "name": "back-up-and-retry" },
       { "sessionId": "S_parent",  "name": "main", "forkedAtEvent": 8 }
     ]
   }
```

This is small and easy to render; it's purely metadata.

### Lineage source of truth

Daemon scans `<cwd>/chats/*.jsonl` on startup. For each file, it
reads ONLY the first line; if it's `type: "fork"`, the file's
parent metadata is extracted. The daemon builds an in-memory
parent-child map indexed by both directions. New forks update the
map atomically. Cost: O(sessions in workspace) on startup, one
fopen+fread+fclose per file — negligible for any realistic
workspace.

No SQLite or sidecar metadata file. The JSONL header is the source
of truth; if the file is deleted, its lineage edges are deleted with
it (the orphaned child becomes a root, which is fine).

## Transcript modes

### `include`

Copy parent JSONL lines `1..fromEventId` byte-for-byte into the
fork, preceded by the fork header line. Pros: full fidelity, agent
sees identical history. Cons: disk cost (`O(parent size)`); deep
fork chains can balloon storage.

When the agent child starts with `--resume <S_fork>`, it loads the
copied transcript; nothing in the agent's behaviour changes.

### `summary`

Before allocating the new session, the daemon sends a one-shot
prompt to the parent's agent (out-of-band; not via the FIFO — a
direct ACP call) requesting a brief summary of conversation up to
event `fromEventId`. The summary text is captured and written into
the fork's JSONL as a single `type: "assistant"` line with a
`meta: { kind: "fork_summary" }` annotation. The fork header
records `summaryEventId` pointing to the line.

Pros: short, focused starting context; agent's attention isn't
diluted by long tool-call chains. Cons: depends on the agent's
ability to produce a good summary; not free (one API call to the
parent's model).

If the summary call fails or times out (default 30 s), the daemon
returns `502 Bad Gateway` with code `fork_summary_failed`. The
caller can retry or fall back to `include`.

### `empty`

Only the fork header is written. The new session's agent child
starts fresh with no prior context. Useful for "I want lineage for
audit but a clean slate for prompts."

```
   ┌─────────┐   include   ┌─────────┐
   │ parent  │────────────►│ fork    │  size ~ parent up to event N
   │ 1..N    │             │ 1..N+1  │
   └─────────┘             └─────────┘
                summary    ┌─────────┐
                ──────────►│ fork    │  size ~ 2 lines (header + summary)
                           │ 2 lines │
                           └─────────┘
                empty      ┌─────────┐
                ──────────►│ fork    │  size ~ 1 line (header only)
                           │ 1 line  │
                           └─────────┘
```

## SSE events

Two new event types:

- `session_forked` — emitted on the **fork's** SSE stream as the
  first live event after subscribers attach. Carries
  `parentSessionId`, `parentEventId`, `transcriptMode`,
  `forkedAt`. Idempotent for replay.
- `child_forked` — emitted on the **parent's** SSE stream when a
  new fork branches off, carrying the child's `sessionId`,
  `name?`, `fromEventId`, `forkedAt`. Informational only — the
  parent continues running normally.

Both are subject to standard scope checks and audit mirroring.

## Decisions

### D1 — JSONL header line as the source of truth for lineage

**Choice**: Lineage is stored in the first line of the fork's
JSONL file as `{ type: "fork", parentSessionId, parentEventId,
forkedAt, transcriptMode }`. No SQLite table, no sidecar metadata
file.

**Alternative considered**: A `sessions` SQLite table tracking
lineage. Faster random-access queries; but adds schema, migration
load, and another consistency layer.

**Why**: Forks are infrequent (humans branch occasionally; not 100x
a second). Reading one line from each JSONL on startup is trivial.
Putting lineage in the JSONL keeps everything self-describing — a
single file fully encodes its own provenance. Backup/restore is
just file copy.

**Cost**: Listing requires touching one file per session at
startup. Acceptable for realistic workspaces (hundreds of sessions
max).

### D2 — Three transcript modes (no "shallow copy" / "pointer" mode)

**Choice**: `include` / `summary` / `empty`. No "the fork
_references_ the parent's transcript and doesn't copy."

**Alternative considered**: A symlink-style "reference" mode where
the fork's JSONL is just a pointer to a byte range of the parent's
JSONL.

**Why**: A reference mode couples fork lifetime to parent file
integrity. If parent is rotated, compressed, or deleted, fork
breaks. Disk is cheap; correctness is not. Copy-by-default keeps
each session independent of every other session — the same property
that makes the system simple in the first place.

**Cost**: Disk usage doubles when forking from the middle of a
long parent. Mitigated by the option to use `summary` or `empty`.

### D3 — Forking requires `write` scope

**Choice**: `POST /session/:id/fork` requires `write` scope on the
parent session. Reading is not enough — forking _creates state_
(a new session, new JSONL, possibly an out-of-band summary call to
the parent's model that consumes API budget).

**Alternative considered**: `read` scope. Forking does not mutate
the parent; one could argue it's read-only-ish.

**Why**: The summary mode runs a model call against the parent's
agent, which is a write-ish side-effect. The `include` and `empty`
modes don't, but draining writability is a budget concern (a third
party with `read` shouldn't be able to silently start spawning
sessions). The audit log makes the rule visible regardless of
which mode.

**Cost**: A read-only viewer can't fork "as a bookmark." If
that turns out to be a real use case, a `read-fork` sub-permission
could be added later.

### D4 — Forks of forks are flat in lineage chain

**Choice**: A fork of a fork records the immediate parent only.
The lineage chain endpoint walks up by following parents.

**Alternative considered**: Record the full chain in the header.

**Why**: Headers stay small; the chain is derived at query time.
This also means if a mid-chain JSONL is deleted, lineage walks
truncate naturally rather than presenting stale data.

**Cost**: Walking the chain is O(depth). Depth is bounded by
reality (people don't fork a hundred deep).

### D5 — `fromEventId` must be a completed event in parent

**Choice**: The endpoint rejects with `409 Conflict` and code
`fork_mid_prompt` if `fromEventId` refers to an event that is
mid-stream (no `stopReason` or terminal frame yet). The operator
must wait for the in-flight prompt to complete (or cancel) before
forking from inside it.

**Alternative considered**: Allow mid-prompt forking; the fork
starts from the partial state.

**Why**: Partial events are not committed. A fork that thinks it
starts from the middle of a tool call has no defined behaviour for
"what was the result of that tool call?" Either the parent
eventually emits one (and the fork doesn't know it) or it never
does (and the fork is misleading). Waiting until events are
terminal is a small UX cost for a much simpler model.

**Cost**: User has to wait for an in-flight to finish. The CLI
can show "fork pending, waiting for prompt to complete" if needed.

### D6 — Parent is not notified synchronously of fork

**Choice**: The `session_forked` event is emitted to the fork's
subscribers. The parent's subscribers get a `child_forked` event,
but it's informational; the parent's FIFO is not paused, its agent
child is not informed, nothing about the parent's runtime state
changes.

**Alternative considered**: Notify the parent's agent so it could
"know" it has been forked.

**Why**: Agent isolation is the whole point of forking. The fork is
a copy; the parent is the parent. Making the parent's agent aware
introduces cross-session leakage (the parent now knows the user
"abandoned" or "duplicated" this branch) that complicates the
mental model and the prompt semantics.

**Cost**: Operator gains no agent-side acknowledgement of fork.
Documentation states this clearly.

### D7 — Default mode is `include` (not `summary`)

**Choice**: When the caller omits `transcript`, the default is
`include`.

**Alternative considered**: Default `summary`.

**Why**: `include` is the "git branch" mental model — same history,
diverge from here. It's exact and lossless. `summary` is a UX
optimisation that costs an API call and trusts the model to
summarise well. Defaulting to the safer choice keeps surprises
low; the operator opts in to `summary` when they want the speed
and brevity.

**Cost**: Disk usage on default. Acceptable.

## Persistence

| Artifact                                         | Format | Notes                                                                      |
| ------------------------------------------------ | ------ | -------------------------------------------------------------------------- |
| `~/.qwen/projects/<cwd>/chats/<sessionId>.jsonl` | JSONL  | First line is `type: "fork"` for forks; otherwise normal start line.       |
| `~/.qwen/rc/wal/<sessionId>.log`                 | Binary | New WAL per session as before. First entry for a fork is `session_forked`. |
| In-memory lineage map                            | RAM    | Rebuilt on startup by reading first line of each JSONL in the workspace.   |

No new SQLite tables.

## Threat model

| Attacker                                  | Capability                                                                                               | Mitigation                                                                                                         |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Write-scope token forks repeatedly        | Disk exhaustion via many `include` forks                                                                 | Operator's choice; rate limit per token at the daemon's existing per-token bucket. Audit shows the storm.          |
| `summary` mode used to exfil parent state | Each summary is a model call that returns text the caller could log; same as just reading the transcript | Already authorised; not an escalation. Audit records the fork action and mode.                                     |
| Parent deletion while fork exists         | Lineage chain breaks                                                                                     | Fork is independent; chain just truncates at the deleted parent. Documented behaviour.                             |
| Fork from non-existent event id           | Confusing error / 500                                                                                    | Validate `fromEventId` is within the parent's JSONL range before allocating any new state; 400 if not.             |
| Deep fork chain → walk DoS                | `lineage` endpoint slow                                                                                  | Hard cap on chain walk (default 100 levels); beyond returns first 100 plus a `truncated: true` flag.               |
| Fork name collisions / injection          | Misleading display strings                                                                               | Names are stored as opaque strings; validated to printable ASCII length ≤ 64. No injection into structured fields. |
| Read-scope token tries to fork            | Spawns sessions / runs summary call                                                                      | Scope check (D3); 403.                                                                                             |

## Risks / Trade-offs

| Risk                                             | Likelihood | Impact | Mitigation                                                                                        |
| ------------------------------------------------ | ---------- | ------ | ------------------------------------------------------------------------------------------------- |
| Forks pile up; UI tree gets cluttered            | M          | L      | `forks` array bounded by reality; listing renders only direct children; lineage view explicit.    |
| Summary mode produces poor context               | M          | M      | `summary` is opt-in; documented to be lossy. CLI prints the summary so user can verify.           |
| Agent-side memory differs from JSONL replay      | L          | M      | This change does not touch agent's memory model. Upstream `--resume` is the contract.             |
| Forking into a session that's already ended      | L          | L      | Parent doesn't have to be active to be forked from; only `fromEventId` validity matters.          |
| WAL eviction in parent before fork command       | L          | L      | Forking reads from the JSONL, not the WAL; WAL retention doesn't affect fork feasibility.         |
| Pollution of `<cwd>/chats/` with abandoned forks | M          | L      | Standard GC (`add-remote-control` `gcAfterSec`) applies; orphaned forks GC just like any session. |

## Open questions

1. **Should `name` be unique within a workspace?** Probably yes for
   UX (otherwise "main" everywhere). Implementation: refuse name
   collision at fork time; user picks a different name.

2. **Should the fork endpoint accept `auto-end-parent: true` for
   the "replace, don't branch" use case?** Tempting, but it's
   compound and breaks the "fork is read-only on parent" property.
   Leaning no; user can `qwen rc end <parent>` separately.

3. **Summary mode: should we expose `summarySystemPrompt` or
   `summaryLength` knobs?** v1: hardcoded; revisit if users complain
   about summary quality.

4. **Lineage in upstream qwen-code's `qwen --resume` UX.** Should
   `qwen --resume` print "this session is a fork of <parent>" when
   loading? Out of scope here (upstream change), but worth noting
   that the JSONL header makes this trivially possible.

5. **Naming conventions.** Should `name` be auto-generated when
   omitted (e.g., adjective-animal)? Currently null is allowed and
   the UI shows `(unnamed fork from event 245)`. Acceptable.

6. **Concurrent forks from the same `fromEventId`?** Two operators
   fork from event 245 at the same time. Both succeed; both get
   their own session ids; both record the same `parentEventId`.
   The lineage tree shows two children. No conflict.
