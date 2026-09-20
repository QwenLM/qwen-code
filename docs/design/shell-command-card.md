# Shell command card

[English](shell-command-card.md) | [简体中文](shell-command-card.zh-CN.md)

Running cards share the same layout, with a spinning status icon and elapsed time. Only recognized structured rawOutput ANSI snapshots render as styled text; ordinary JSON stdout stays verbatim and unknown live structures fall back to full JSON. Structured results distinguish empty output from literal `(empty)` without inspecting text; line/byte counts and supplied timeout stay in execution details. Copy uses displayed plain text. Heartbeat-only ACP events are already ignored by the SDK, preserving output even across card collapse; unknown text stays intact. Output follows updates only while the reader stays near the bottom. Active shell input previews are not output. Current ACP drops ordinary streaming chunks and the SDK filters heartbeat metadata, so a real command may display Waiting for output until completion; frontend elapsed time uses the tool start timestamp, not backend heartbeat metrics.

## Problem and scope

The Web Shell repeats the tool name, description and command, then renders a model-facing result envelope as one muted block. The initial presentation change is extended by [structured Shell results](structured-shell-results.md). Preserve model-facing output, approval UI and other tools.

## Design

Reuse the existing semantic summary and card styles. The expanded Shell card retains its localized tool title and execution status. The sections are ordered Command, Output, Execution details. Command and Output are expanded by default, with readable ANSI-aware output. Command, Output and Execution details use the same subtle theme-aware background with small rounded corners and no border. Stronger category headings and 16px section spacing establish hierarchy. Each content region has a 200px maximum height with internal scrolling; category headings and Copy stay above and outside its scroll area. Collapsed categories show only their headings. Document exports remain unbounded. Command and Output each have an icon-only copy button in their heading row; content uses the full card width. Command copy preserves the exact command; output copy copies the displayed text without ANSI styling. Each button independently switches to a check temporarily after successful copying, following the existing copy feedback. Success and failure have matching icons. Put directory, exit code and PGID in native details. Foreground commands also show the explicit timeout in milliseconds, even while running; absent values are labeled Use default without inferring the backend configuration. Background commands omit the foreground timeout. Execution failures and termination signals stay visible outside details; non-error exit codes remain available in details.

Completed foreground results use versioned structured rawOutput fields for output, outcome and execution metadata. No envelope regex parsing remains. Historical text and unknown versions retain their original fallback text without guessing metadata. Unknown exit status is Completed, never Success. Running and cancelled states retain their lifecycle meaning. Exported document mode opens disclosures so content remains available.

## Files and decisions

Update ToolGroup, add a focused ShellToolOutput component and its tests, and reuse ToolChrome CSS, shared Button, clipboard helper and copied feedback hook. Add English/Chinese labels and a browser regression in the existing mock-daemon harness. No new dependencies. The structured-result companion design covers producer and transport changes.

## Validation and acceptance

Verify successful output is separated from metadata and commands appear once in the expanded body. Verify nonzero exit, errors, signals, multiline commands, raw fallback, empty output, ANSI, copy and document rendering. Use a global CLI baseline plus browser tests with a mocked daemon; these browser tests validate presentation, not real command execution. Run build, typecheck, focused tests and two clean self-audit passes.

## Risks and open questions

Historical records have no structured metadata and remain verbatim. This may retain clutter but avoids inventing fields from command output. No open product decisions.

Shell outcome follows the existing exit-error policy: exit 1 from grep/rg/diff/test is a completed negative result, not an execution failure. Web Shell trusts the structured outcome and retains the numeric exit code in details. PostToolUse and PostToolBatch hooks keep string display fields through shared normalization; UI/history retain structured data. Running elapsed time is visible beside the status.

When an exported document has only legacy text, render the command and complete fallback text without category disclosures or inferred execution metadata. Structured directory values are resolved execution paths. Hide exit codes for cancelled, timed-out or signal-terminated commands; keep their outcome and signal visible.
