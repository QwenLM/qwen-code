# MCP Tool Name Provider Compatibility

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
- Continue matching legacy MCP permission and disabled-tool entries by carrying the exact pre-normalization alias derived from the raw server and tool names. This also preserves names truncated by the previous middle-truncation algorithm without broadening wildcard matches.

No provider-specific alias table is introduced. Legal existing names remain byte-for-byte unchanged, so Gemini behavior and normal built-in tools are unaffected.

Restored names produced by the previous middle-truncation algorithm are already provider-safe and remain unchanged in historical messages. Their removed middle cannot be reconstructed reliably, so converters do not guess a new hash-based name; exact permission and disabled-tool compatibility instead uses the raw-name alias available during MCP registration.

## Verification

- Unit tests for valid, invalid, colliding, long, stable, and idempotent names.
- MCP tool tests for registration, permission rules, reconnect lookup, and disabled tools.
- OpenAI and Anthropic converter tests for restored history containing dotted MCP names.
- Core package build and typecheck.
