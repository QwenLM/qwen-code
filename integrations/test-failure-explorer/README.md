# Test Failure Explorer

Private Qwen Code extension for importing and exploring an existing Vitest 3.2 JSON report. Text and structured queries work in any MCP host; a fixed interactive MCP App adds filtering, pagination and diagnostic details in compatible graphical hosts.

## Build and configure

Requires Node.js 22 or newer. From the repository root:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm --filter @qwen-code/test-failure-explorer run build
```

Use Qwen Code's extension install/link command with this directory (check your installed CLI's `extensions --help`). The manifest binds both stdio cwd and `QWEN_TEST_EXPLORER_WORKSPACE_ROOT` to `${workspacePath}`. The server requires an existing, expanded absolute root and does not fall back to cwd. A running server remains bound to its startup root; changing workspace requires a newly configured transport.

For another MCP host, use an explicit absolute root in both fields:

```json
{
  "command": "node",
  "args": ["/absolute/extension/dist/main.js"],
  "cwd": "/absolute/workspace",
  "env": { "QWEN_TEST_EXPLORER_WORKSPACE_ROOT": "/absolute/workspace" }
}
```

The package is private and is not automatically published. Its package version follows the repository; the extension manifest has its independent version `1.0.0`.

## Obtain a report

Run from the relevant test package with its normal build prerequisites. Choose an absolute output path because Vitest resolves relative outputs against its config root:

```sh
corepack pnpm exec vitest run src/example.test.ts --coverage.enabled=false --reporter=default --reporter=json --outputFile.json=/absolute/workspace/.qwen/test-reports/example.json
```

Record the command and actual process exit code separately. The extension does not execute this command or capture its exit code. The adapter is verified with Vitest **3.2.7** JSON reporter output. Coverage JSON, JUnit and other runners are not supported; a conforming JSON shape is not proof of its producer version.

## Tools

- `test_report_import({ relativePath: ".qwen/test-reports/example.json" })`: validate the report, persist an immutable workspace snapshot, return its reportId, source hash, summary and a small first failure page. This writes only the extension cache.
- `test_report_show({ reportId })`: open the fixed explorer for an already imported snapshot, with a summary and small first failure page. Text-only hosts receive the same evidence and reportId.
- `test_report_query({ reportId, query: { kind: "summary" } })`: distinguish reported counters from computed file/assertion counts.
- `test_report_query({ reportId, query: { kind: "list", collection: "failures", text: "timeout", offset: 0, limit: 25 } })`: literal whole-snapshot search; collections also include `assertions` and `file-errors`. Optional status filtering preserves individual assertion statuses.
- `test_report_query({ reportId, query: { kind: "detail", itemId, field: "diagnostics", offset: 0 } })`: read a bounded diagnostic chunk; `path` and `title` are separately pageable. Follow `nextOffset` until null.

Import and show are model-visible only. Query is also App-visible and does not create another card. Normal MCP permissions still apply. The App can only query this dedicated server; importing a new path is a separate model tool action.

## Interactive explorer

The card starts with failed assertions and file errors. Switch collections, submit a case-sensitive literal search over the whole snapshot, and page through the matches. Open an entry to read diagnostics, the full title or the full path in separate chunks. Reported suite counts and computed file/assertion counts remain distinct; the source path, hash, import time and report-only provenance identify the evidence.

Select up to 20 failed entries across pages to prepare a short analysis request. Manually copy the text into the conversation; the card does not send messages, execute tests or apply fixes. Report strings are rendered as plain text without automatic links.

The self-contained HTML resource is `ui://test-failure-explorer/v1/index.html`. It contains no report data and requests no external CSP domains. Data arrives through the show result and standard App tool calls; there are no external assets or separate network data requests. Refresh resets filters, pages and selection to the initial card result. If a host offers no tool callback, the saved summary and first page remain readable with query controls disabled. Query failures retain that saved evidence and display an error. If historical HTML has been evicted, use the text fallback or call show again with the saved reportId.

## Evidence and recovery

`report.success` is only a reported value. Vitest's JSON reporter does not report process exit, unhandled errors, cancellation, run completeness, project/shard identity, or the tested Git commit. Those remain unknown/unavailable, including when there are no failed assertions. Nested suite counts are not file counts. File-level failure with zero assertions remains visible; duplicate titles do not collide.

Sources and diagnostic strings are data, never executable instructions. Report-internal paths are not opened. Output text removes terminal controls. Search and detail offsets address this terminal-safe representation (identified by `textRepresentation`); snapshot strings retain the original evidence. Title detail includes the suite ancestors through Vitest’s full name. Import rejects traversal, symlink escape, non-regular files and detectable changes during reading; cache directories must be real directories. This is a local trusted-filesystem tool, not an OS security sandbox against hostile concurrent mutations by another local process.

Snapshots live in `.qwen/test-failure-explorer/reports/` under the bound workspace, use exclusive atomic publication, and have integrity checks. Same source path/bytes/root returns the same reportId and first importedAt. Source overwrite/deletion does not change imported evidence; server restart preserves queries. IDs are scoped to the workspace and one report, not cross-run test identities or session-private capabilities.

Missing/corrupt snapshots return `REPORT_UNAVAILABLE`. Corrupt existing IDs are never silently overwritten. After inspecting the cache, remove the specific damaged snapshot and reimport the source. No automatic cleanup or total quota is provided: cache disk use grows with imports. Inspect that directory and remove only snapshots you no longer need; historical details then become unavailable.

## Fixed bounds

Sources: 10 MiB, 2,000 file entries, 20,000 assertions. Snapshots: 20 MiB. Exceeding these rejects import, without partial data. A complete serialized MCP tool result is at most 24,000 JavaScript characters, including escaping and text/structured duplication. Lists default to 25 and allow at most 50, but may return fewer to meet that budget. Detail chunks are at most 8,000 characters and can shrink for escaping. Truncation/page metadata is explicit and the complete snapshot remains unchanged. The App resource is limited to 1 MiB of UTF-8 HTML at build time. The card uses at most one list and one detail request, cancelling superseded requests and ignoring late replies.

Tests run from this integration directory:

```sh
npm run test
npm run typecheck
```
