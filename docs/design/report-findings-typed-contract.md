# Report Findings Typed Contract

## Context

`/review` already canonicalizes its findings as data twice: `qwen review
findings` writes the typed artifact under `.qwen/tmp/`, and Step 8's
`save-artifact` + `record_artifact` publish a durable copy the Web Shell
renders (`CodeReviewArtifactDetail`). But both are files registered after the
fact. Every client rendering the session live — the terminal UI, the Web Shell
transcript, ACP hosts, the daemon TUI — receives only the Markdown
restatement of the same list, and after `--fix` (or a later `fix these
issues`) nothing in-band tells a client which findings are now closed.

## Design

A new core tool, `report_findings`, is the in-band half of the contract: one
call with `{level, findings[]}`, rendered by host UIs as a per-finding list.
Field names and enum spellings match the findings artifact exactly (`id`,
`severity`, `confidence`, `source`, `file`/`line`, `summary`, `shortSummary`,
`failureScenario`, `category`, `outcome`, `outcomeNote`), so the model copies
values out of the artifact instead of translating them. The tool sorts by
severity → confidence → location, derives and compresses `shortSummary` to 60
characters, rejects control characters and duplicate ids, and — mirroring
`review findings --outcomes` — refuses a call where some findings carry an
`outcome` and others do not. It persists nothing and decides no verdict; the
result is a `findings_list` structured `returnDisplay`.

The finding enums now live in core (`tools/report-findings.ts`);
`packages/cli/src/commands/review/findings.ts` re-exports them under its historical
names. The Web Shell renderer keeps its deliberate browser-side copy.

The `/review` skill calls the tool once after writing the findings artifact
(Step 6; low effort reports its unverified list with `level: "low"`), and
again after `--fix` with every finding carrying its outcome — a rule that
outlives Step 6B: any later in-session disposition change records outcomes
into the artifact and re-issues the call. The call is UI delivery: a failure
is disclosed and never alters artifacts or the verdict.

Rendering: the TUI gets a `FindingsDisplay` row list (severity color, id,
`file:line`, short summary, confidence marker, outcome badge); the daemon TUI
adapter passes `findings_list` through; history/recording compaction truncates
the free-text fields and applies an aggregate retained-display budget across
the list, keeping the most severe prefix and counting the evicted tail
(`omittedFindings`).

"Later calls replace the list" is rendered, not just validated: every
transcript surface — live history, restored history, recording/resume, and
the daemon projection — keeps only the last delivered `findings_list` and
collapses each earlier one to a one-line replacement marker, so an initial
report and its outcome re-report never show two checklists at once.

The outcome identity gate (`activeReportIds`) is a live-process contract:
the tool instance is cached by the registry for the session, but a cold
session resume constructs a fresh instance with no active identity, and an
outcome call is then validated on its own terms (all-or-nothing outcomes)
instead of against the pre-restart report. Persisting the identity across
restarts is deliberately out of scope; the transcript-side replacement above
does not depend on it.

The findings command's `--input` also accepts a saved review artifact or a
prior `--out` report (any object carrying the array as `findings`), because
Step 9 cleanup deletes the `findings-in.json` side file a later-session
outcome path would otherwise need.

## Verification

- Core tool unit tests: sorting, shortSummary derivation/compression, empty
  list, outcome counting, partial-outcome refusal, duplicate ids, control
  characters, schema violations, trimming.
- Compaction test: free-text fields truncate, typed fields survive.
- `FindingsDisplay` ink render tests: rows, outcomes with skip reason, empty
  state.
- Existing `findings.ts`, `save-artifact`, ToolMessage, daemon adapter,
  config-registration, SKILL parity and review-digest suites stay green.
