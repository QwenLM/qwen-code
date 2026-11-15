# Test Failure Explorer

Private Qwen Code extension for importing and exploring an existing Vitest 3.2 JSON report. Text and structured queries work in any MCP host; an interactive MCP App adds filtering, pagination and diagnostic details in compatible graphical hosts. Fixed views are the default, with optional bounded model-generated layouts for evidence grouping and investigation order.

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
- `test_report_show({ reportId, view? })`: open the fixed explorer for an already imported snapshot, or supply a ViewSpec v1 for a generated layout. Text-only hosts receive the same evidence and reportId.
- `test_report_query({ reportId, query: { kind: "summary" } })`: distinguish reported counters from computed file/assertion counts.
- `test_report_query({ reportId, query: { kind: "list", collection: "failures", text: "timeout", offset: 0, limit: 25 } })`: literal whole-snapshot search; collections also include `assertions` and `file-errors`. Optional status filtering preserves individual assertion statuses. Optional `failureIds` accepts 1–128 unique, verified failed IDs and intersects the other filters without changing snapshot order.
- `test_report_query({ reportId, query: { kind: "detail", itemId, field: "diagnostics", offset: 0 } })`: read a bounded diagnostic chunk; `path` and `title` are separately pageable. Follow `nextOffset` until null.

Import and show are model-visible only. Query is also App-visible and does not create another card. Normal MCP permissions still apply. The App can only query this dedicated server; importing a new path is a separate model tool action.

## Interactive explorer

The card starts with failed assertions and file errors. Switch collections, submit a case-sensitive literal search over the whole snapshot, and page through the matches. Open an entry to read diagnostics, the full title or the full path in separate chunks. Reported suite counts and computed file/assertion counts remain distinct; the source path, hash, import time and report-only provenance identify the evidence.

Select up to 20 failed entries across pages to prepare a short analysis request. Hosts with MCP App text messaging offer **Review selected failures**. In Qwen Code, this opens a host dialog showing the full request, its server/resource and its original session; only explicit confirmation submits it. Qwen Code preserves the composer draft and reports acceptance only after the daemon returns a prompt receipt; acceptance does not mean analysis has completed. Other messaging hosts apply their own confirmation and acceptance policy. Hosts without messaging retain the selectable text for manual copy into the conversation.

Qwen Code refuses known-busy sessions without queueing this request. Before dispatch, cancellation or a changed session/client invalidates the review; request a new review after recovery. If acceptance is unknown, check the host review and original conversation before sending again. Requests are never resent automatically, and closing the card does not cancel an accepted turn. The generated request asks for read-only analysis; the card itself does not execute tests or apply fixes, and downstream tools retain the host's normal permission checks. It sends one user text block through standard `ui/message`; Qwen Code accepts at most 16 KiB of UTF-8 text. Report strings are rendered as plain text without automatic links.

The self-contained HTML resource is `ui://test-failure-explorer/v1/index.html`. It contains no report data and requests no external CSP domains. Data arrives through the show result and standard App tool calls; there are no external assets or separate network data requests. Refresh resets filters, pages and selection to the initial card result. If a host offers no tool callback, the saved summary and first page remain readable with query controls disabled. Query failures retain that saved evidence and display an error. If historical HTML has been evicted, use the text fallback or call show again with the saved reportId.

## Optional generated layouts

The conversation model can supply a ViewSpec v1 to arrange a small catalog: summary, assertion status counts, failure list, evidence, and hypothesis groups. The [extension skill](skills/test-failure-explorer/SKILL.md) documents the exact fields. The failure list is required; each section can appear at most once. The model can choose list columns, page-local file grouping, an initial literal filter and verified initial evidence. It cannot replace report facts or supply executable content, arbitrary styles, network resources or host actions.

The server verifies the schema and every failure reference against the same immutable report. Hypothesis text is clearly marked as a model suggestion; overlapping references count once toward coverage. Source/provenance, integrity warnings and **All failures** remain available independently of the model's layout. Group filtering does not select failures for sending; the existing 20-item limit and host review still apply.

A valid result saves the effective view and its canonical SHA-256 digest for replay. Invalid object candidates return the fixed explorer with a bounded `viewResolution.reason`; malformed outer parameters and unavailable reports remain tool errors. Optional initial evidence and the first page can be omitted to fit the result budget. Unsupported saved layouts fall back to fixed report evidence and require a fresh query for a correctly labelled list. Without query capability, the App shows only available saved evidence and explicitly disables unavailable controls.

Each show is an independent completed result. In-card queries update that card's local display, not another card. This does not implement streaming layouts, cross-turn card updates, persistent interaction state or a generic UI-code runtime. Generated layouts remain optional; model validity and automated task results do not establish human productivity gains.

## Evidence and recovery

`report.success` is only a reported value. Vitest's JSON reporter does not report process exit, unhandled errors, cancellation, run completeness, project/shard identity, or the tested Git commit. Those remain unknown/unavailable, including when there are no failed assertions. Nested suite counts are not file counts. File-level failure with zero assertions remains visible; duplicate titles do not collide.

Sources and diagnostic strings are data, never executable instructions. Report-internal paths are not opened. Output text removes terminal controls. Search and detail offsets address this terminal-safe representation (identified by `textRepresentation`); snapshot strings retain the original evidence. Title detail includes the suite ancestors through Vitest’s full name. Import rejects traversal, symlink escape, non-regular files and detectable changes during reading; cache directories must be real directories. This is a local trusted-filesystem tool, not an OS security sandbox against hostile concurrent mutations by another local process.

Snapshots live in `.qwen/test-failure-explorer/reports/` under the bound workspace, use exclusive atomic publication, and have integrity checks. Same source path/bytes/root returns the same reportId and first importedAt. Source overwrite/deletion does not change imported evidence; server restart preserves queries. IDs are scoped to the workspace and one report, not cross-run test identities or session-private capabilities.

Missing/corrupt snapshots return `REPORT_UNAVAILABLE`. Corrupt existing IDs are never silently overwritten. After inspecting the cache, remove the specific damaged snapshot and reimport the source. No automatic cleanup or total quota is provided: cache disk use grows with imports. Inspect that directory and remove only snapshots you no longer need; historical details then become unavailable.

## Fixed bounds

Sources: 10 MiB, 2,000 file entries, 20,000 assertions. Snapshots: 20 MiB. Exceeding these rejects import, without partial data. A complete serialized MCP tool result is at most 24,000 JavaScript characters, including escaping and text/structured duplication. Lists default to 25 and allow at most 50, but may return fewer to meet that budget. Detail chunks are at most 8,000 characters and can shrink for escaping. Truncation/page metadata is explicit and the complete snapshot remains unchanged. The App resource is limited to 1 MiB of UTF-8 HTML at build time. The card uses at most one list and one detail request, cancelling superseded requests and ignoring late replies.

ViewSpec: 8,000 serialized JavaScript characters, five sections, eight hypothesis groups, 128 total group references, 120 characters per group label, 400 per hypothesis and 512 per initial filter. Group references must be nonempty and unique within each group. The whole-result budget still applies after view validation; a view that cannot fit falls back to fixed. At most one model correction is recommended before continuing with fixed exploration.

Tests run from this integration directory:

```sh
npm run test
npm run typecheck
```
