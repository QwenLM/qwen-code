# MCP Tool Name Provider Compatibility

[English](mcp-tool-name-provider-compatibility.md) | [简体中文](mcp-tool-name-provider-compatibility.zh-CN.md)

## Problem

Qwen Code currently accepts MCP tool names using Gemini's character set. Names such as `literature.search_pubmed` become `mcp__server__literature.search_pubmed`, which Gemini accepts but stricter OpenAI-compatible and Anthropic-compatible endpoints may reject before the tool can run.

The same raw name is reconstructed independently for registration, permission persistence, reconnect lookup, output truncation, and restored history. Changing only the provider request would therefore make the model-visible name differ from the registry key.

## Design

Use one deterministic provider-safe normalization rule for MCP tool names:

- Preserve names already matching `^[A-Za-z][A-Za-z0-9_-]*$` and at most 63 characters.
- Replace unsupported characters, ensure an alphabetic first character, and append a stable short hash whenever normalization or truncation is required.
- Keep the final name at 63 characters or fewer, which is accepted by Gemini and stricter OpenAI-compatible and Anthropic-compatible providers.
- Use the registered name throughout an MCP invocation instead of rebuilding it from raw server and tool names.
- Normalize MCP names in restored OpenAI and Anthropic request history so sessions created before the change remain sendable.
- Continue matching legacy MCP permission and disabled-tool entries by carrying the exact pre-normalization identity derived from the raw server and tool names. This also preserves names truncated by the previous middle-truncation algorithm without broadening wildcard matches.

No provider-specific alias table is introduced. Legal existing names remain byte-for-byte unchanged, so Gemini behavior and normal built-in tools are unaffected.

Restored names produced by the previous middle-truncation algorithm are already provider-safe and remain unchanged in historical messages. Their removed middle cannot be reconstructed reliably, so converters do not guess a new hash-based name; exact permission and disabled-tool compatibility instead uses the raw-name alias available during MCP registration.

## Rule matching

Permission rules and `disallowedTools` blocklists may be written in a legacy spelling (`mcp__foo.bar__tool`) that no longer equals the registered provider-safe name. Matching works as follows (`packages/core/src/permissions/rule-parser.ts`):

- Each `DiscoveredMCPTool` advertises `permissionAliases`: the **exact raw identity** `mcp__<server>__<tool>` first, then the legacy `generateLegacyMcpToolName` reduction when it differs. A verbatim provider-safe registration lost nothing and advertises no alias. Both the registry (`ToolRegistry.getPermissionAliases`, for L1/L2 gates) and the invocation (`permissionFlow.ts`, for the L4 call-time check) read this same array.
- An alias is accepted as the tool's raw identity only when its own normalization **is** the registered name, so a different server's tool can never supply the identity a rule is matched against. The raw prefix comes from the user's configured server key, not from the server.
- Exact, server-level, and wildcard patterns are then compared **literally** against the registered name and the raw identity. Nothing is reconstructed and nothing is hashed in this matcher: a registered name whose tail merely imitates a normalization hash proves nothing. An earlier design reconstructed candidate raw names and verified them against the unkeyed FNV-1a name hash; that proved only an existential (some raw name under the rule's prefix normalizes to this registered name) and was forgeable, so it was deleted rather than gated (#10199).
- `disabledTools` never reaches `rule-parser.ts`. `ToolRegistry.isToolDisabled` matches it separately: it reads this same `permissionAliases` array by exact set membership, and additionally still compares `normalizeMcpToolName(entry)` against the registered name, so a legacy-spelled entry can also disable a colliding server's tool. That normalization arm predates #10199 and fails closed — do not read the bullet above as covering it, and do not delete it on this document's authority without a behaviour decision.
- The legacy `sanitizeToolNameForProvider` reduction was deliberately removed from matching: it made `mcp__foo.bar` rules reach the differently-registered server `foo_bar`. Do not reintroduce it. In the other direction, a rule written provider-safe (`mcp__foo_bar`) still literally matches any server whose name sanitizes under that prefix — an accepted residual.
- A bare `*` is not an MCP pattern and matches no MCP tool; `mcp__*` and `mcp__server__*` keep their documented meanings.
- Asymmetry: a lost match is fail-closed on `allow` (the tool falls back to `ask`) but fail-open on `deny`/`ask` rules and `disallowedTools` blocklists, which is why every reachable caller must thread the alias channel.

## Verification

- Unit tests for valid, invalid, colliding, long, stable, and idempotent names.
- MCP tool tests for registration, permission rules, reconnect lookup, and disabled tools.
- Collision tests (`mcp-server-rule-collision.test.ts`): cross-server forgery witnesses (exact, server-level, and wildcard shapes), middle-truncation over-match, legacy-spelled deny coverage at every raw length, and the no-alias posture.
- OpenAI and Anthropic converter tests for restored history containing dotted MCP names.
- Core package build and typecheck.
