# Cycle 57 — Fork-tree session-list web UI (`/rc/sessions` consumer)

Proposal: `add-session-forking` (the proposal's "UI can render a tree"
goal for task 1.3). The browser consumer of cycle-50's `GET /rc/sessions`
flat fork-lineage listing — renders it as an indented tree so an operator
can see the fork topology at a glance.

## What it adds

A self-contained "Sessions" section in `public/index.html`: a "List
sessions" button that fetches `GET /rc/sessions` (OWNER-scoped) and
renders the flat `{sessions:[{sessionId, parentSessionId?, forks:[...]}],
truncated}` as an indented text tree in `<pre id="sessions">`.

## Tree build (the only real logic)

The server returns a FLAT list with a forward `forks[]` index per node.
Client builds the tree:

- A node is a CHILD if it appears in some node's `forks[]`; everything
  else (true roots + orphans whose parent isn't listed) is a top-level
  node.
- Recurse top-level → `forks[]` → children, indenting per depth.
- **A `visited` set guards against a hand-crafted cycle** even though the
  server's lineage walk is acyclic by construction (truncate-on-cycle) —
  the renderer must never infinite-loop.
- An orphan (has `parentSessionId` but the parent isn't in the listing)
  renders at top level with a "forked from <id> (not listed)" note.
- `truncated:true` appends a "list truncated (cap hit)" line.

Rendered via `textContent` (XSS-safe; session ids are server hex).

## Feasibility / harness

`GET /rc/sessions` resolves the workspace via `daemon.capabilities()`
then scans the on-disk chats dir. The cycle-54 `/tmp` harness used a
`{}` stub daemon (no capabilities) → the route would 502. So the harness
(in `/tmp`, not committed) is enhanced for this cycle: the stub daemon
returns `capabilities: async () => ({ workspaceCwd })`, `QWEN_RUNTIME_DIR`
is pointed at a temp dir, and a parent + fork transcript (the fork
stamped `forkedFrom:{sessionId:parent}`) are written into the derived
chats dir — so `/rc/sessions` returns a real `{parent forks:[fork]}` +
`{fork parentSessionId:parent}` tree to render. No product code depends
on the harness.

## Decisions

1. Self-contained section + handler (new ids `list-sessions`/`sessions`),
   touches no existing handler; `textContent`-only.
2. Indented `<pre>` text tree (not nested DOM) — simplest, XSS-safe,
   matches the events/audit UIs' style.
3. Read-only; no new route/audit (consumes cycle-50's OWNER route).

## Verification

Playwright in-session against the enhanced harness: pair OWNER → List
sessions → assert the tree shows the parent at top level with the fork
indented beneath it (parent id then an indented child line containing the
fork id). lint/build/test unchanged, e2e 45/45.

## Deferred

Collapse/expand, per-node name/forkedAt (the gateway fork writer stores
neither — cycle 50 deferred), click-to-watch a session, lineage-depth
badges — later.
