# Fork Profiles

## Summary

Add a project-level named profile layer on top of the fork execution allowlist
introduced by #8066. A caller can pass `fork_profile: "<name>"` instead of
repeating `fork_tools`; the runtime resolves
`.qwen/fork-profiles/<name>.md` once at launch and feeds the resulting tool
list into the existing execution gate.

This phase adds no new authorization mechanism. The resolved profile must
behave exactly like the equivalent inline `fork_tools` call.

## File Format

Profiles live under the active project root:

```text
.qwen/fork-profiles/<name>.md
```

Each file contains YAML frontmatter:

```markdown
---
name: ro-research
tools:
  - read_file
  - grep_search
  - glob
  - mcp__search__*
promptHint: |
  Work read-only. Prefer targeted searches and report evidence.
---
```

`name` and `tools` are required. `promptHint` is optional and limited to 200
characters. The requested name, the filename, and the frontmatter name must
match. Names are 2–50 characters and contain only letters, numbers, hyphens,
or underscores, without a leading or trailing separator. Profile files are
frontmatter-only; a non-blank Markdown body is rejected so guidance cannot be
silently discarded. A profile must resolve to a regular file inside the
project profile directory and cannot exceed 64 KiB.

The `tools` field uses the exact `fork_tools` contract. An empty list remains
deny-all, bare `*` is invalid, and MCP wildcard syntax is unchanged.

Project scope is the only lookup scope in this phase. User-level profiles,
scope precedence, built-in profiles, profile listing, and management UI are
deferred. Safe mode and bare mode reject project profiles because they are
local customizations. AUTO mode treats writes under `.qwen/fork-profiles/` as
self-modification, so they cannot use the normal in-workspace edit fast path.

## Launch Resolution

`fork_profile` is valid only with `subagent_type: "fork"` and cannot be
combined with `fork_tools` or a named teammate. The Agent invocation resolves
the profile before constructing the fork runtime:

1. Validate the requested logical name before building a filesystem path.
2. Read the matching project profile and strictly parse its YAML frontmatter.
3. Validate the file name/frontmatter identity and tool allowlist.
4. Bind the parsed profile to one launch snapshot and expose its effective
   tools and prompt hint to AUTO-mode classification.
5. Pass a cloned tool list as `ToolConfig.executionAllowedTools`.
6. Append `promptHint`, when present, to the fork task directive after the
   parent-derived cacheable prefix. The project-controlled text is escaped and
   framed as guidance after the directive, while the authoritative execution
   restriction remains last.

Missing or invalid profiles fail the launch before the agent runtime, hooks,
background registry entry, or transcript sidecar is created.

## Runtime and Revival

The existing execution gate remains authoritative. Profile resolution neither
changes model-visible declarations nor bypasses normal permissions for an
allowed tool.

The resolved tool list, not the profile name or path, is launch-time policy.
The existing `AgentMeta.executionAllowedTools` sidecar stores it, including an
empty deny-all list. Cold revival reapplies that snapshot to the current live
tool surface and does not reread a profile that may have changed since launch.

The launch task prompt is already part of the fork transcript, so the resolved
prompt hint follows the existing transcript/revival path without a second
profile lookup.

## Boundaries

This phase does not add shell argument patterns, overlay filesystems,
`/btw` integration, automatic reflection/swarm orchestration, user-level
profiles, or profile CRUD UI.

Fork profiles are a caller convenience and project-controlled prompt layer,
not an administrator-enforced sandbox. They can only narrow the executable
surface inherited from the parent.
