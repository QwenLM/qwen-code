# Agent Plugins v1 Native Support

## Context

Qwen Code currently loads `qwen-extension.json` packages directly and converts
Gemini, Claude, and Qoder packages before loading them. Agent Plugins v1 is a
portable format with a root `plugin.json`, direct-child skills under `skills/`,
and an optional root `mcp.json`. Converting it would change the package format
and its runtime semantics.

This design matches the portable runtime capabilities implemented by Codex at
`646f7c0a91b8e327d263335da68ae8ef212895ce`: skills, stdio MCP, and Streamable
HTTP MCP. Agent Plugin commands, agents, hooks, context, settings, channels,
apps, client-extension namespaces, and legacy SSE MCP are not activated.

## Design

Agent Plugins v1 is a native extension package format, not another converter.
A format-aware manifest loader recognizes only the canonical v1 schema, maps
portable metadata into the existing in-memory `ExtensionConfig`, and leaves all
standard files unchanged. Existing install sources and the install metadata
sidecar remain unchanged.

The Agent Plugin loader discovers only immediate `skills/*/SKILL.md` files and
validates their portable Agent Skills metadata. Invalid skills are skipped
independently. The optional `allowed-tools` field is validated but does not
grant Qwen permissions. Other Qwen-specific skill fields are ignored.

The root `mcp.json` is validated in two stages. A top-level error disables MCP
for the plugin; an invalid server disables only that entry. Stdio servers use a
stable data directory outside the package and receive client-controlled
`PLUGIN_ROOT` and `PLUGIN_DATA` values. Streamable HTTP servers receive the
portable URL and literal-header checks and stop redirects when a configured or
authorization header is present. Legacy SSE entries are reported and skipped.

## Package boundary

Every discovered, read, or executed package path is checked after resolving
symlinks and existing path prefixes. A plugin manifest escape rejects the
plugin, a component-directory escape disables that component, and a skill or
MCP-entry escape skips only that entry. Copied Agent Plugin installs do not
follow symlinks; linked installs apply the same checks at load time.

## Compatibility

A root `plugin.json` whose schema belongs to Agent Plugins takes precedence
over other extension manifests. Unsupported Agent Plugins schema versions fail
explicitly; unrelated root `plugin.json` files do not affect existing format
detection. Missing or blank portable versions use the internal version
`1.0.0`.

The shared origin union gains `AgentPlugins`. Native Agent Plugins still use
the normal extension security consent, but they do not show the converted
third-party-format compatibility warning. Existing Qwen, Gemini, Claude, and
Qoder behavior remains unchanged.
