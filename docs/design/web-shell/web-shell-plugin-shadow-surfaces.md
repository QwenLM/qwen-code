# Web Shell Plugin Shadow Surfaces

## Goal

Make `shadowDom={{ plugins: true }}` isolate every plugin-management page,
regardless of whether it was opened from the unified Plugins navigation or a
slash-command compatibility route.

## Surfaces

The plugin Shadow DOM boundary applies to these inline panel IDs:

- `plugins`
- `extensions`
- `mcp`
- `skills`
- `agents`

`agents` is included for compatibility with the `AgentsManagerPage` and
`AgentCreatePage` introduced by PR #7572. The create page is rendered inside
the agents manager, so both pages share the same boundary.

Settings, daemon status, and session overview remain in the Light DOM.
Portal-based UI remains controlled independently by `shadowDom.portals`.

## Implementation

Use one boundary around the inline panel body and enable it only for the
plugin-management panel IDs. This preserves a single rendering path and keeps
the legacy slash routes consistent with the unified Plugins page.
