# Herdr TUI Reporter

## Context

Herdr can identify Qwen Code and persist its session through the integration
added in herdrdev/herdr#2743, but screen matching can miss localized working and
approval states. Qwen Code already owns the exact TUI state, so the interactive
client should report it directly when Herdr launches the pane.

## Design

The interactive UI creates one fail-open reporter only when Herdr's pane,
socket, and binary environment variables are present. It reports session IDs
through the existing `herdr:qwen` source and TUI lifecycle through the
`qwen-code:tui` source. This requires Herdr to treat those exact sources as one
Qwen owner while keeping their sequence numbers and release behavior
independent. That paired ownership contract is tracked in
[herdrdev/herdr#2757](https://github.com/herdrdev/herdr/discussions/2757).

The reported state is `blocked` for authentication or an active tool,
integration, or skill confirmation, `working` while the model, tools, or a
slash command are running, and `idle` otherwise. Reports are serialized and
deduplicated. A newer pending state replaces one that has not started. Command
failures and timeouts never affect the UI.

Graceful exit drains the active report and releases only `qwen-code:tui`.
Herdr then falls back to screen detection while retaining the official session
identity. Process detection remains the crash fallback.

## Boundaries

This is TUI status integration, not an orchestration API. It does not change
core, ACP, headless mode, Agent Team, or how Qwen delegates to Codex, Pi, and
other CLIs through Herdr.

## Verification

Focused tests cover environment gating, report ordering and deduplication,
session changes, monotonic sequences, failures, and release. A live Herdr pane
must exercise idle, working, approval-blocked, session switch, and graceful
exit states.
