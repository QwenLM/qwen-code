# Project auto-memory ownership for task worktrees

[English](worktree-memory-ownership.md) | [简体中文](worktree-memory-ownership.zh-CN.md)

## Storage and session ownership

Starting a task in a worktree should preserve the project knowledge of the
workspace from which the task started. Resolve private project auto-memory at
`<memoryBaseDir>/projects/<encoded absolute owner path>/memory/` using the
existing path encoding. A session owns the directory it was launched from or
its registered daemon workspace. A session that starts directly in a linked
worktree owns that directory. The runtime directory and memory base overrides
continue to apply. Existing stores stay in place.

Capture the launch path before `--worktree` changes cwd and pass the registered
workspace to daemon sessions. Memory readers and writers use the owner from
the session config. Child agents inherit it. Standalone worktree entry, exit
and resume keep the existing working-directory behavior and chat lookup
sequence. In a standalone `--worktree` launch, `/cd` within the task checkout
keeps the launch owner. Leaving the checkout restores ordinary directory-based
ownership and refreshes the memory context. Team and local memory follow
their existing directory rules.

Before a daemon workspace starts, check registered workspaces for the same
encoded key under the same resolved memory base. Reject a distinct workspace
with a colliding key and explain how to choose a separate runtime directory or
rename the path. The guard compares registered runtimes. Legacy stores use
the existing encoded locator and have no recorded workspace identity.

## Writes, recovery and recall

Serialize project topic changes with a short commit lock keyed by the actual
store, using a FIFO within each process and a shared lock across processes.
Compare the topic version seen by the operation with the current version
under the lock. Record an index rebuild marker on disk before mutating any
topic and clear it only after the generated index is successfully published.
Attempt one repair per dirty-index read. The runtime generates project
`MEMORY.md` from topics and rejects attempts to edit the generated file.
If repair fails, reads can still use the last published trusted index.
Startup and Remember omit a project index that fails the trust checks.
An unavailable topic keeps the rebuild pending and prevents publication of a
partial index.
Dream may hold its separate consolidation lock outside a commit. Legacy
manual `/dream` runs as a regular conversation turn. Model calls and approval
waits run outside the commit lock.

Queue extraction by store within each process, coalescing pending work for
the same session and retaining other sessions' requests in arrival order.
Independent processes serialize the publication step. Keep a bounded table of
session offsets and preserve an existing single-session offset on upgrade.
Merge cursor and metadata updates under the commit lock, retaining pending
index repair and monotonic update times. Use the same version check for
ordinary writes, forget, Dream deletions, metadata upgrades and migration.
During cursor recovery, preserve the original file alongside the replacement
and write the pending marker under the commit lock. Reset invalid offsets to
zero and preserve valid session progress. A regular cursor owned by the
current user can also be recovered if its owner read bit was removed.

The generated index and standard prompt budget are 200 lines and 25,000
UTF-16 code units. When the active context window is below 128K, limit the
loaded project index to 100 lines and 12,500 code units. Preserve all topics
for on-demand reads, structured search and Dream consolidation.

## Explicit migration

`/memory migrate-worktree <old path>` accepts one explicitly selected
checkout path or memory directory. The runtime maps checkout paths using the
same encoding, rejects paths outside the selected memory base and unsafe
links, and fixes the target to the invoking session's project store. An
invocation without a source asks for a specific path.

An isolated model request reads the source and destination snapshots and
chooses additions and updates, including how to handle duplicates and
conflicts. The snapshots must fit in one request within 512 KiB and the
active model's context window. The proposal has an upper limit of 8,192
output tokens, subject to the model's own limits. The model returns it
without executable tools. The request and its output stay out of the main
conversation and extraction. The existing consent flow shows the source,
destination, changes and conflicts. A cancellation discards the proposal.
An approval applies only the displayed plan after rechecking the target and
relevant versions under the commit lock. Each topic is published atomically.
The source remains read-only. Startup leaves migration to the explicit
command. The existing Codex import command manages its own imported library.

Batching the source alone would resend the target and can miss conflicts
between batches. A read-only tool loop could let the model inspect selected
topics from large libraries. It would need to bound the tool results and
preserve consistent versions across calls, and large proposals would still
need an output budget. This command uses an explicit one-request capacity
check so it can compare the full snapshots it presents to the model.

## Verification

Check launch from a repo root, subdirectory and independent linked checkout,
task startup and resume by ID/title, worktree entry/exit, task subagents,
and directory changes within and outside a worktree. In the daemon, verify
workspace separation through task creation and restart and reject a colliding
registration. Exercise concurrent writes to equal and distinct topics,
three queued extraction sessions, legacy offsets, interrupted index rebuild,
and loaded budgets plus recall beyond 200 topics. Use a controlled model in
an isolated runtime to verify that cancellation leaves both stores intact,
stale confirmed edits fail, and only approved topics appear in the target.
