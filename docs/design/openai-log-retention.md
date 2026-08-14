# OpenAI Log Retention

## Context

When OpenAI-compatible API logging is enabled, Qwen Code writes one JSON file per request and response. Heavy use can create hundreds of thousands of files and consume tens of gigabytes because the log directory has no retention policy.

Historical files have one in-tree reader, which searches only recent logs for the current session. Removing sufficiently old writer-owned files does not affect session restore or active requests.

## Design

Interactive sessions register an OpenAI log cleaner in the existing background housekeeping pipeline. Non-interactive CLI, stream-json SDK, and ACP sessions register the same cleaner through a process-local queue. A completed cleaner runs at most once per resolved log directory per day and uses a dedicated retention setting with a seven-day default. A zero value uses the housekeeping minimum of approximately one hour.

Deletion is restricted to the exact filename shape emitted by `OpenAILogger`: a UTC timestamp, an eight-character hexadecimal ID, and an optional sanitized diagnostic suffix. Prefix-only lookalikes are never deleted. The cleaner streams directory entries and processes at most 20 files concurrently so the first sweep of a very large directory does not retain the full listing in memory.

The UTC date in a valid filename avoids one `stat` call per file. Files on the cutoff day use mtime for sub-day precision. A missing directory is a successful no-op; a root scan failure aborts the throttled task so it does not write a success marker. Individual file failures are counted and do not stop later batches, while a file that disappears during deletion is benign.

The first-pass scheduler checks both the global file-history marker and the marker for the resolved OpenAI log directory. A missing or stale OpenAI marker selects the one-minute catch-up delay even when file-history cleanup ran recently.

One-shot and stream-json cleanup starts immediately before model-capable execution, while ACP registers a target after each workspace session config initializes successfully. Cleanup never blocks startup or session creation. One directory is scanned at a time per process, while the existing cross-process marker and lock prevent duplicate work between interactive, headless, SDK, and ACP processes. A long-lived process retries completed work daily, a fresh marker when its remaining interval expires, lock contention after one minute, and failures after ten minutes.

On exit, the non-interactive queue rejects new targets, discards queued work, and aborts the active scan. Cancellation is checked for every directory entry and between bounded file batches. The process waits up to 250 milliseconds for the current filesystem operation to settle and release its lock; abrupt termination falls back to the existing one-hour stale-lock recovery.

## Configuration ownership

The default log directory is relative to the workspace, so its merged workspace retention setting and its directory have the same owner.

A custom log directory can be shared by multiple workspaces, but its flat files do not record workspace ownership. Applying different workspace retention values would make deletion depend on which workspace starts first. Custom directories therefore use only user- or system-scoped retention. If a trusted workspace supplies the effective retention value and no system override owns the policy, cleanup is skipped instead of choosing a destructive policy silently.

## Scope

The CLI lifecycle covers interactive sessions, one-shot headless invocations, the TypeScript, Python, and Java stream-json SDK transports, and ACP children used by IDE and daemon clients. ACP resolves a cleanup target for each initialized workspace session rather than its bootstrap working directory. Direct core embeddings and in-memory channels that bypass the CLI lifecycle remain outside this design.

Short processes provide best-effort progress: the flat directory layout has no portable persistent iteration cursor, so an interrupted process may revisit the same directory prefix next time. Long-lived stream-json and ACP processes keep their iterator alive through EOF. Moving cleanup onto the write path or changing to a sharded/indexed log layout remains out of scope because either would change core logging behavior and compatibility.

## Alternatives considered

- Reusing the 30-day file-history setting would retain too much high-volume API data.
- Matching every `openai-*.json` file is unsafe in project-local and user-selected directories.
- A per-workspace marker for one shared directory still lets the shortest policy delete files owned by another workspace.
- Adding workspace identity to filenames or file contents would require a core logging format migration and would not establish ownership for existing logs.

## Verification

Focused tests cover writer-format recognition, preservation of lookalikes, cutoff boundaries, cancellation, custom-directory policy ownership, default and zero retention, oversized retention values, per-directory throttling, settings fallback, root scan failures, and catch-up delay selection. Non-interactive scheduler tests cover directory deduplication, FIFO serialization, retry timing, graceful stop, and the CLI/ACP lifecycle hooks. The streaming loop is inspected directly to confirm that only one bounded batch is retained.
