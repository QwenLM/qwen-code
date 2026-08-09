# Native Multi-Agent Coordination

## Product decision

Qwen Code supports one bounded, homogeneous coordination product with two execution paths:

- `/coordinate` uses one to three foreground Qwen investigators when the work only needs parallel evidence. The current session is the Leader and remains the only writer.
- Agent View provides durable managed sessions when a task needs background execution, crash recovery, reassignment, or one isolated writer.

Both paths use the current Qwen configuration. They do not create a heterogeneous, continuously running Agent Team. Model mixing, autonomous team topology, and cross-vendor delegation remain future work.

## Why Agent View is the native runtime

The original Agent View work already provides the Qwen-specific process and terminal lifecycle: a supervisor, PTY hosts, a roster, attach/detach, hibernation, respawn, and structured worker sideband events. Native coordination reuses that runtime, then adds immutable task bytes, lineage, bounded admission, exact tool inventories, input snapshots, terminal result envelopes, reassignment, and writer receipts. Ordinary interactive Agent View sessions keep their existing attach and hands-up flow; managed coordination attempts are deliberately one-shot.

Herdr solves a different layer. It is an outer process control plane for multiple CLI products and is stronger when a user needs cross-CLI launch, reconnection, and worktree operations without changing those CLIs. It observes more state from terminals and hooks, while Agent View can receive Qwen-native prompt, tool-confirmation, and result events. Herdr does not automatically place one CLI agent's transcript into another agent's context; a Leader or script still reads one result and explicitly forwards the useful evidence.

| Concern                      | Native Agent View coordination    | Herdr-style outer runtime                       |
| ---------------------------- | --------------------------------- | ----------------------------------------------- |
| Qwen prompt/result identity  | Structured and generation-checked | Usually inferred from process or terminal state |
| Qwen TUI attach and hands-up | Native                            | Terminal-level                                  |
| Cross-vendor agents          | Out of scope                      | Primary strength                                |
| Tool inventory enforcement   | Inside Qwen before invocation     | Depends on the child CLI                        |
| Workspace isolation          | Qwen-owned worktree receipt       | Outer runtime-owned worktree                    |
| Dependency for this feature  | Yes, existing in-tree runtime     | No                                              |

Herdr can become an optional outer adapter later. It is not embedded as the security or state authority for native coordination.

## The three state planes

The design keeps three independent planes. Combining them is the main source of stale results and ownership bugs.

### Coordination plane

The supervisor owns immutable task bytes, lineage, input snapshots, budgets, and terminal result envelopes. A task is identified by `coordinationId`, `taskId`, and `attemptId`; a replacement attempt keeps the first two and receives a new attempt, session, and prompt ID.

Dispatch returns an acknowledgement only after durable records and the worker host are ready. Collection uses the full coordination ID and returns every attempt in deterministic order. A worker result is accepted only when its session, generation, prompt, and attempt all match the current records.

### Session plane

Agent View owns process state independently from task outcome. Session, process, and attachment states are persisted separately. Worker events carry a generation and strictly increasing sequence. Interactive-session control events remain queued until the worker acknowledges their sequence, so a transient sideband failure causes replay rather than loss.

Managed coordination attempts run one headless prompt and return `completed`, `handback`, or `failed`. They reject `send`, `answer`, `attach`, and generic `respawn` instead of acknowledging work that no headless consumer can receive. The Leader inspects them with `peek` or `logs`; a `handback`, failure, or stale result is continued with `reassign`, which preserves the earlier attempt.

### Workspace plane

Read-only workers operate against the source checkout. The supervisor hashes the Git HEAD, index, worktree diff, and bounded untracked-file content before launch. Git-ignored, Qwen-ignored, and Git metadata paths are unavailable to managed tools. Repositories containing Git submodules fail closed because nested worktree bytes are not part of the version-1 snapshot.

Collection snapshots before and after reading terminal results. If the checkout changes, it retries once; if the checkout keeps changing, every terminal result is marked `checkout_changed` and is not accepted as current evidence.

The single optional writer receives a supervisor-owned Git worktree created from a clean source checkout. It has no shell tool and can only read, edit, or write inside that worktree. A pristine worktree with no reported artifacts is removed only after confirmed worker exit, using Git's non-force removal so a last-moment edit is preserved. A dirty worktree, a branch with unmerged commits, or a worktree referenced by an artifact is returned as an ownership receipt containing its path, branch, and base commit.

## Security boundaries

The canonical read-only inventory is defined once and reused everywhere:

- `read_file`
- `grep_search`
- `glob`
- `list_directory`

The isolated writer inventory extends that same constant with only `edit` and `write_file`. It does not include shell, Agent, MCP, web, skills, memory, cron, sub-session, or team tools.

Managed workers additionally:

- skip MCP discovery, hooks, skills, checkpointing, extension/LSP watchers, sandbox relaunch, startup worktree handling, and stale-worktree maintenance;
- reject nested/background/resume/fork/ACP inputs and caller-supplied prompts or schemas;
- read the task only from a supervisor-owned regular file capped at 64 KiB;
- enforce path arguments against the resolved active workspace, including symlink escapes;
- force the built-in ripgrep path and enforce Git, Qwen, and configured custom ignore files for direct and recursive access;
- reject repositories containing Git submodules until recursive snapshots are supported;
- run with fixed limits of 12 turns, 10 minutes, and 60 tool calls;
- return a strict JSON value through the canonical headless result adapter, never by scraping ANSI terminal output;
- cap persisted results at 256 KiB and keep the sideband token out of child tool environments.

`structured_output` is deliberately not added to the read-only inventory. The exact-four repository boundary remains literal; the worker validates the final JSON result outside the tool registry.

## User and machine interfaces

Foreground evidence gathering remains the simplest path:

```text
/coordinate compare the retry paths, identify the safest fix, and implement it
```

The durable machine interface accepts task files rather than prompt text in process arguments:

```bash
qwen agent-view dispatch --task /tmp/api.md --task /tmp/tests.md --json
qwen agent-view dispatch --task /tmp/investigate.md --writer /tmp/implement.md --json
qwen agent-view collect <full-coordination-id> --json
qwen agent-view peek <session-id>
qwen agent-view logs <session-id>
qwen agent-view reassign <full-coordination-id> <full-task-id> --task /tmp/retry.md --json
```

Agent View management lives only under `qwen agent-view ...`; ordinary words such as `agents`, `attach`, or `stop` remain valid prompts.

## Admission, failure, and cleanup

- At most three managed coordination workers may be live at once.
- At most one isolated writer may be live.
- A multi-task dispatch is all-or-nothing. Failure confirms launched hosts have exited before removing session data or a pristine worktree; anything that cannot be stopped or safely removed is retained with recovery IDs.
- An empty supervisor exits after its grace period; removed sessions lose their whole session directory.
- PID reuse is treated as stale unless the process identity matches.
- Result replay, old generations, non-increasing sequences, and mismatched prompt or attempt IDs fail closed.
- Collection is idempotent. It never force-removes a writer worktree and preserves dirty, unmerged, artifact-bearing, or concurrently changed work.

## Rollout and compatibility

The feature is explicit: ordinary prompts do not fan out automatically. Existing foreground Agent calls, MCP discovery, hooks, skills, worktrees, and interactive startup retain their current behavior unless a managed coordination environment is present.

Agent View adds lazy command imports so ordinary CLI startup does not load its TUI or supervisor implementation. Worker polling is bounded to one request per second per live TUI worker. Historical sessions are read from persisted records rather than represented by one timer per session.

The initial release is documented as experimental while the command and persisted-file schemas remain at protocol version 1. Incompatible state is rejected instead of migrated silently.

## Verification gates

The implementation is ready only after all of the following pass together:

1. Focused unit tests for protocol validation, exact inventories, lifecycle serialization, generation/sequence/prompt correlation, atomic dispatch rollback, snapshots, writer preservation, collection, and reassignment.
2. Build, typecheck, lint, and the relevant CLI/core test suites.
3. A fake-provider end-to-end run proving two investigators execute concurrently and the Leader sees both canonical results.
4. A real Qwen Code dogfood run covering parallel dispatch, roster inspection, handback/reassign, writer receipts, collect, and confirmed stop/remove.
5. TUI evidence that coordination attempts appear in the roster, plus a compatibility run of the existing roster-to-attach-to-roster and needs-input interaction for an ordinary Agent View session.
6. Startup, idle CPU, store-scan, and heap measurements against the pre-change baseline, plus an equivalent Agent View versus Herdr process-level comparison.
7. Two clean self-review passes and repository review with every Critical resolved.
