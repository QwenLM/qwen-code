# OpenAI Tool Schema Grammar Compatibility

## Problem

Some OpenAI-compatible runtimes compile every function schema in a request into one grammar. Older llama.cpp builds reject empty `properties` maps and large string or array repetition limits, so one valid but unsupported schema prevents the entire request from starting. Qwen Code ships tools with both shapes and can also receive them from MCP servers.

Disabling all tools avoids grammar construction but also removes the functionality the user asked the agent to use. It is therefore a diagnostic fallback, not the primary fix.

## Design

Keep the registered tool set unchanged. Before an OpenAI-compatible request is sent, recursively relax only the wire copy of each schema:

- omit empty `properties` maps and `additionalProperties: false` on object-capable schemas with zero declared properties;
- omit `minLength`, `maxLength`, `minItems`, and `maxItems` values at or above 1999, the lowest failing boundary measured across the four keywords;
- preserve smaller limits and all other supported constraints.

Apply these grammar-specific relaxations only when the source schema passes the existing isolated strict compilation for its selected dialect and contains no `$id`. Schemas containing `$id` keep their constraints because runtime validation uses a shared schema registry where duplicate IDs can prevent enforcement. If local validation cannot enforce the complete schema, keep its grammar constraints on the wire rather than broadening both enforcement layers.

The original schema remains attached to the tool and continues to drive client-side parameter validation. The provider receives a schema it can compile, while Qwen Code still rejects tool calls that violate the original limits.

## Compatibility

This applies to both built-in tools and MCP-provided schemas because they share the same OpenAI conversion boundary. Native Gemini requests are unchanged. Providers that accept the original constraints receive a slightly relaxed wire schema, but local validation preserves their behavior.

## Verification

Unit coverage exercises recursive empty objects, the 1998/1999 boundary, the actual OpenAI tool converter, and source-schema immutability. A live LM Studio smoke remains useful when that runtime is available, but the regression test pins the exact request shapes that caused grammar initialization to fail.
