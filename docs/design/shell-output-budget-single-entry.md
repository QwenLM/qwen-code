# Shell Output Budget: One Decision Per Body

## Problem

Shell output crosses two independent size policies before it reaches the model,
and with the default configuration they disagree.

The tool itself truncates at its declared budget — 30,000 characters by default,
or an explicitly configured `truncateToolOutputThreshold` when set — and returns
a head-and-tail preview of roughly 4,000 characters so the trailing exit and
error summary survives.

The scheduler then runs a generic persistence gate keyed off the _global_
threshold: `getTruncateToolOutputThreshold()` (25,000 by default) plus 3,000
characters of headroom, so about 28,000. That gate keeps only a short head.

Because the generic gate sits _below_ the tool's own budget, output between them
is decided by the gate rather than by the producer:

| Formatted body    | Model-facing result       |
| ----------------- | ------------------------- |
| up to ~28,000     | whole output              |
| ~28,000 to 30,000 | short head only           |
| above 30,000      | ~4,000 char head and tail |

Crossing 28,000 characters therefore _loses_ the trailing exit code and error
summary that crossing 30,000 preserves. The window only exists for the default
configuration: an explicit threshold makes the gate `T + 3000`, which is always
above the producer budget `T`.

The same window applies on the failure paths. A non-zero exit reports the
processed body as `error.message`, and the timeout path passes the processed body
as its detail, so both are re-bounded by a gate that keeps a different part of
the text.

## Invariants

1. One body is sized by exactly one policy. A producer that already applied its
   own declared budget is not re-bounded by the generic gate.
2. The marker records that the size decision was made, not that anything was
   cut. Output that fits the budget carries it too — that is the case the window
   was hiding.
3. The marker is set only on paths that actually ran the check, never inferred
   from tool identity or from text found in the output.
4. Persistence state stays separate. `persistedOutputFiles` keeps its three-state
   meaning (`undefined` no decision, `[]` decided with no reusable file, a
   non-empty array reusable paths) so aggregate finalization can still persist a
   body the producer left in memory.
5. The marker bounds nothing on its own. The per-tool budget, the combined pass
   over appended metadata, the aggregate batch budget, and the no-I/O cap at the
   send boundary all still apply.
6. A failure message is only exempt while it _is_ the marked body.

## Design

### Producer marker

`ToolResult` carries an internal `outputBudgetApplied?: boolean`. It is runtime
state consumed by the scheduler; it is not serialized to hooks, ACP payloads,
JSON output, telemetry, or persisted UI metadata, and it is not copied onto
`ToolCallResponseInfo`.

Shell sets it at the end of its foreground truncation block, unconditionally
within that block — including when the output fit and nothing was cut. Paths that
return earlier never reach it, so an explicit background launch reports no
marker and keeps the generic gate.

### Scheduler

The generic gate stands down for a marked body:

- Success path — the gate receives the marker. The per-tool pass immediately
  below is unchanged and becomes the single authority, using the tool's own
  threshold and keep direction.
- Timeout path — the gate receives the marker for the detail body, while the
  timeout summary and error type are untouched.
- Ordinary failure path — the gate is skipped only while `error.message` is
  still byte-for-byte the marked `llmContent`. Producers that build
  `error.message` separately, such as spawn and setup failures, and any
  failure-hook context appended beforehand both change the string, so those
  retain the gate.

Nothing else about the ordering changes. Hook context and skill or rule
reminders are still appended after the body is bounded, the combined pass still
bounds the assembled string against the doubled budget, and aggregate batch
finalization still runs afterwards.

### Metadata appended outside the budget

Shell appends process metadata — the long-running advisory and the AI attribution
warning — after truncation, deliberately outside the truncation envelope. The
failure paths have no per-tool pass, so the generic gate was the only thing
bounding that text. Each appended string therefore has to be bounded on its own.
The advisory is a fixed template, and the attribution warning's exception branch
now caps the exception text at 120 characters, matching the sibling branches in
the same function. The full text stays in the debug log.

### Result

For the default configuration, output up to the Shell budget reaches the model
whole, and output above it keeps the existing head-and-tail preview with its
persisted file reference. The head-only window disappears.

## Non-goals

Exit codes, signals, and timeout state remain embedded in the formatted body
rather than travelling as separate fields, so a later aggregate reduction can
still cut them. Separating that status metadata from the log text is the next
step and is not attempted here.

This change also does not add per-call size or token telemetry, does not touch
the aggregate allocation algorithm, and does not revisit the same window for
other tools that declare a budget below the generic gate.
