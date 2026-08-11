# OpenAI Log Retention

## Context

When OpenAI-compatible API logging is enabled, Qwen Code writes one JSON file per request and response. Heavy use can create hundreds of thousands of files and consume tens of gigabytes because the log directory has no retention policy.

Historical files have one in-tree reader, which searches only recent logs for the current session. Removing sufficiently old writer-owned files does not affect session restore or active requests.

## Design

Interactive sessions register an OpenAI log cleaner in the existing background housekeeping pipeline. The cleaner runs at most once per resolved log directory per day and uses a dedicated retention setting with a seven-day default. A zero value uses the housekeeping minimum of approximately one hour.

Deletion is restricted to the exact filename shape emitted by `OpenAILogger`: a UTC timestamp, an eight-character hexadecimal ID, and an optional sanitized diagnostic suffix. Prefix-only lookalikes are never deleted. The cleaner streams directory entries and processes at most 20 files concurrently so the first sweep of a very large directory does not retain the full listing in memory.

The UTC date in a valid filename avoids one `stat` call per file. Files on the cutoff day use mtime for sub-day precision. A missing directory is a successful no-op; a root scan failure aborts the throttled task so it does not write a success marker. Individual file failures are counted and do not stop later batches, while a file that disappears during deletion is benign.

The first-pass scheduler checks both the global file-history marker and the marker for the resolved OpenAI log directory. A missing or stale OpenAI marker selects the one-minute catch-up delay even when file-history cleanup ran recently.

## Configuration ownership

The default log directory is relative to the workspace, so its merged workspace retention setting and its directory have the same owner.

A custom log directory can be shared by multiple workspaces, but its flat files do not record workspace ownership. Applying different workspace retention values would make deletion depend on which workspace starts first. Custom directories therefore use only user- or system-scoped retention. If a trusted workspace supplies the effective retention value and no system override owns the policy, cleanup is skipped instead of choosing a destructive policy silently.

## Scope

The housekeeping scheduler starts only for interactive sessions. Headless CLI and SDK-only processes can still write logs without starting a sweep; the setting documentation states this limitation. Moving cleanup onto the write path remains a separate follow-up because it changes core logging behavior and process coordination.

## Alternatives considered

- Reusing the 30-day file-history setting would retain too much high-volume API data.
- Matching every `openai-*.json` file is unsafe in project-local and user-selected directories.
- A per-workspace marker for one shared directory still lets the shortest policy delete files owned by another workspace.
- Adding workspace identity to filenames or file contents would require a core logging format migration and would not establish ownership for existing logs.

## Verification

Focused tests cover writer-format recognition, preservation of lookalikes, cutoff boundaries, custom-directory policy ownership, default and zero retention, oversized retention values, per-directory throttling, settings fallback, root scan failures, and catch-up delay selection. The streaming loop is inspected directly to confirm that only one bounded batch is retained.
