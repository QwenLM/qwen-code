# Web Shell collapsed thinking performance

## Problem

Pure assistant and thought tail appends wake the top-level `App`, even though
only the transcript row needs the new text. Compact activity summaries also
keep their complete tool and thought subtree mounted while collapsed, so hidden
rows continue reconciling streamed thought props.

## Design

The top-level app consumes a structural transcript snapshot. A store change
summary proves when an update is only an append to the active assistant or
thought block; those app-level notifications are ignored. Stores without a
change summary retain the existing behavior.

The message list separately consumes the live throttled snapshot and applies
the existing streaming-tail projector against the app's latest structural
messages. This updates only the visible tail without starting a second
background-agent reconciliation loop. Structural changes still flow through
the app and replace the baseline immediately. Insight protocol markers use a
full projection while retaining the unchanged message prefix.

Compact tool summaries mount their detail subtree only while expanded, except
for MCP Apps whose iframe state must survive a collapse. The summary button
remains live while collapsed; expanding reconstructs the current tool and
thought rows from props. Collapse and expansion are immediate and unanimated.

## Compatibility

Tool, permission, terminal, reset, history, and session changes remain
structural. Transcript callbacks continue receiving live snapshots from the
message-list boundary. Collapsing a compact group no longer preserves local
expanded state inside its hidden detail rows.

## Verification

- Prove structural snapshots ignore pure tail appends and resume on the next
  structural change.
- Prove a collapsed compact group has no detail subtree and restores current
  details when expanded.
- Run the deterministic folded-thought performance scenario and targeted unit
  tests.
