# First-class Agent navigation in WebShell

## Problem

WebShell already has a complete Agent definition manager for workspace and global Agents, including prompts, models, tools, MCP servers, and permissions. It is reachable through `/agents` and as a nested Plugins tab, but it has no primary-sidebar entry. Users therefore cannot discover Agent management or see that Agent definitions can participate in Agent Team collaboration.

## Design

- Add `Agents` to the existing configurable primary-sidebar navigation and open the existing Agent manager. Do not create a second manager or route.
- Keep the entry workspace-scoped, matching the manager's daemon API and the existing Plugins, Channels, Workflows, and Goals entries.
- Add one persistent sentence under the Agent manager title explaining that specialized Agents can be coordinated in an Agent Team.
- Preserve host customization: embedders can omit `agents` from `primaryNav.items`, and callers that use the sidebar component directly are not forced to provide an Agent callback.

## Scope

Included: discoverable sidebar navigation, accessible collapsed label, existing manager routing, and collaboration-oriented copy.

Excluded: a second Agent definition UI, durable Team Run history, remote Agent hosts, a Team creation form, or changes to Agent Team runtime behavior. Live Team execution remains owned by the parent PR.

## Affected areas

- WebShell sidebar navigation and App routing.
- Agent manager title copy and English/Chinese localization.
- Focused navigation and browser acceptance coverage.

## Open questions

None for this slice. A future Team Runs page should be added only after the daemon has persistent Run identity rather than presenting current-session state as durable management.
