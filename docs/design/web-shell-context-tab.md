# Web Shell context sidebar tab

## Problem

Token consumption can be inspected in a right-sidebar tab, but current context
composition is only displayed in transcript messages through `/context`.

## Design

Add an independent opt-in `contextUsage` chat-header action, enabled in the
standalone Web Shell, opening a session-owned `context_usage` artifact tab.
Mirror token-tab deduplication, persistence, restoration and pane/session cleanup.
Restored secondary-session tabs must bind `getContextUsage` to their saved session
through the workspace client, rather than reading the current main session.

A small `ContextUsagePanel` loads `getContextUsage({ detail: true })` on mount and
manual refresh. Reuse `ContextUsageMessage` for the breakdown and detail lists,
with scoped narrow-panel styling. Preserve estimated/no-provider wording.
Render loading, unavailable and retry states, reject mismatched session payloads,
and ignore stale asynchronous responses after ownership changes or unmount.
Only active tabs fetch. No polling is introduced because collecting detailed
context is more expensive than reading cumulative counters.

## Affected files

Web Shell client App and tests, ArtifactPanel, new ContextUsagePanel and tests,
ChatContextHeader, customization, standalone main, localization, and the context
message renderer only if needed for a scoped compact layout.

## Boundaries

No new endpoint, SDK/core changes, generic polling abstraction, raw prompt viewer,
or changes to `/context` transcript behavior. Existing context metadata includes
model/window usage, messages, system prompt, tools, memory and skills, not raw
prompt contents. Token consumption remains independent.

## Validation

Component and App regression tests cover loading, refresh, error recovery, stale
responses, owner validation, independent tab deduplication, lazy restoration,
secondary-session binding, opt-in actions and lifecycle cleanup. Browser checks
cover the new entry, rendered details, refresh without transcript insertion,
320px layout and coexistence with token usage. Build, typecheck, focused tests,
lint and self-audit precede completion.

## Open questions

None for this scope. Automatic refresh can be considered separately if requested.
