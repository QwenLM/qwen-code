# Web Shell agent workflow

## Goal

Show the complete persisted subagent hierarchy in a restorable right-panel tab while retaining the existing low-cost live agent inventory.

## Data flow

- `GET /session/:id/agent-trace` is a live-session-owner read. It scans at most 2,000 metadata sidecars asynchronously, validates their session identity, and returns parent/root relationships plus lineage health.
- `GET /session/:id/agents` remains the bounded live inventory and polling source.
- The Workflow tab uses the trace as topology and overlays matching live agents by ID for current status and timing.

The trace is requested only after transcript loading completes and only while a Workflow tab is open. Agent inventory activity changes trigger a trace refresh; there is no second fixed polling loop.

## Persistence

Local storage contains only the Workflow tab ID, title, kind, and session ID. Trace content is fetched after load. The first fetch shows a skeleton; later refreshes retain the prior graph.

## Compatibility

The route is advertised by the dedicated `session_agent_trace` capability. Older daemons continue to expose the existing agent inventory without the Workflow entry.
