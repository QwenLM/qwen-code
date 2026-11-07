# Managed Session MCP menu

[English](2026-10-20-managed-mcp-menu.md) | [简体中文](2026-10-20-managed-mcp-menu.zh-CN.md)

## Problem and current state

Managed Sessions can pin MCP servers and the Runtime can execute their tools.
The public Session catalog already projects sanitized, committed tools,
resources, prompts and discovery states. Managed WebShell has no catalog adapter,
so its MCP composer menu is unavailable. Hosted tools use opaque names without
server ownership in their descriptions, so a server reference alone cannot
identify the corresponding tools reliably.

## Proposed change

Add a read-only WebShell POST adapter at
`/api/agent/web-shell/v1/session-mcp/query`, accepting the existing Session
request and returning the existing public MCP catalog. Reuse the catalog service
and its tenant, actor and Workspace read checks. This route is persisted-Workspace
scoped through the selected Session; it performs no Runtime discovery or execution.

Expose the typed query through the Java client and Managed provider. A Managed
composer hook lazily loads the selected Session catalog through the existing
MCP menu actions. Combine these actions with Workspace file-reference actions
without enabling daemon features. Requests are aborted on provider, client or
Session changes; late responses cannot populate the new scope. Reopening the
menu reads a new committed snapshot, and a failed query remains retryable.

Reuse the existing composer server-reference menu. Show each server's
capability counts and tools/resources/prompts discovery states as a catalog
snapshot, including partial, failed and stale states. Selection inserts the
existing escaped `@mcp:server` reference. It expresses a service preference,
does not grant permission, and does not promise availability. The Hosted model
tool description includes the server ID and original tool name, allowing the
model to associate a reference with its already-admitted tools, including
identically named tools from different servers.

Constrain submenu width to the space Radix computes beside the parent menu,
so snapshot text wraps inside narrow viewports instead of being clipped.

## Decisions and scope

- Keep connection recipes, endpoints and credentials in the Runtime. No config
  editor, automatic installation, profile enabling or new execution route.
- Reuse the existing catalog schema rather than duplicate it for WebShell.
- Resource and prompt counts describe the catalog. Their content is not read
  or attached by this change; the public API has no such execution surface.
- Retain failed/stale catalog entries as referenceable service intent, visibly
  labeled by discovery state. Runtime admission remains authoritative.
- Do not rewrite existing Session pins or change tool identities and grants.
- Existing Skills, file references and plain text submission remain supported.

Affected areas are the catalog controller and API contracts, WebShell Managed
client/provider/composer hook, shared translations, and Hosted tool descriptions.

## Validation and acceptance

Run the global CLI baseline attempt, targeted Java authorization/contract tests,
WebShell provider/hook/composer tests, and Hosted MCP tool-advertisement tests.
Browser tests cover desktop and narrow-viewport selection and submitted input, empty and
failed catalogs, and reopening. Hook tests cover late responses across Session
and provider changes. Run the
repository build, typecheck and bundle plus the Java module verification.

Acceptance requires an enabled menu for an existing Managed Session, accurate
snapshot states, a submitted server reference with visible Hosted tool ownership,
no stale cross-Session results, and preserved file/Skill behavior. Browser API
fixtures validate the UI contract; they do not establish a live deployment's MCP
transport, upstream-model behavior, SSH support or production acceptance.

## Open questions

None for this scope. Resource/prompt execution and Runtime-specific deployment
acceptance remain separate work.
