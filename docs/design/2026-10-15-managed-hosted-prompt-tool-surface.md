# Managed Hosted prompt tool surface

[English](2026-10-15-managed-hosted-prompt-tool-surface.md) | [简体中文](2026-10-15-managed-hosted-prompt-tool-surface.zh-CN.md)

## Status

Implemented in this change for the Hosted model turn. Validation results belong in the E2E report, not in this design.

## Problem and current behavior

Core builds tool-specific guidance and worked examples from `Config.getPromptToolSnapshot()`. An undefined snapshot preserves the full default text; an empty set explicitly declares no tools. Core also keeps Agent delegation guidance when `getPromptAgentReachable()` says the deferred-tool bridge can reach Agent.

The Hosted Harness initializes Core with a local registry, then removes local tools and installs the Session's remote function declarations directly on the chat. This changes the outgoing tools without updating the prompt snapshot. A five-tool Workspace Session can therefore retain instructions for unavailable search or Agent tools, while a no-tool Session can retain file and Shell instructions.

## Goals and scope

- Use each fresh Hosted model request's actual function declarations for the existing Core tool-guidance and example filters.
- Support empty tool sets and tools added or removed between model rounds.
- Preserve core policy, Agent instructions, Workspace context, and caller-owned prompt text.
- Preserve the exact request recorded for model-attempt recovery.

This change does not expand tool admission, alter Runtime execution, rewrite every tool reference in the default prompt, or filter instructions authored by users, Agent definitions, or Workspace files. It introduces no new public API, schema, setting, or prompt template.

## Ownership

Java continues to pin the Agent definition and publish its instructions. Runtime and Broker continue to provide Workspace context and admitted tool operations. The Hosted Harness owns the Session's remote declarations and synchronizes their names into Core's existing prompt inputs. Core remains responsible for rendering the prompt.

## Proposed solution

Before a fresh model request, resolve remote declarations once, or use an empty list for a no-tool turn. Install that same list on the chat and derive its nonempty names into a set. Set the prompt tool snapshot to this set, including when it is empty. Agent is reachable only when `agent` is actually declared: Hosted does not expose the local registry's deferred-tool bridge.

Rebuild the system instruction before inference when the declared name set changes or when Workspace context changes. Compare sets by membership, not declaration order; schema and description changes still reach the tools block on every round without forcing a prompt rebuild. Combine a context change and a tool-set change into one rebuild. Keep Agent instructions ahead of project context using the existing context assembly.

Reuse the existing `setPromptToolSnapshot`, `setPromptAgentReachable`, and `refreshSystemInstruction` operations. Keep synchronization inside the Hosted model loop rather than changing the normal interactive/headless registry lifecycle.

## Recovery and failure behavior

A prepared model request already contains its original system instruction and tools. Replay that recorded request without replacing its prompt with current declarations or context. When replay yields another fresh model round, synchronize that round normally.

Declaration resolution and prompt refresh must finish before a fresh request starts. If either fails, do not send an inference request with a partially synchronized surface. Existing turn failure handling remains authoritative. Automatic in-chat compaction retains the current chat configuration; manual interactive `/compress` is outside this Hosted turn path.

## Validation plan

Attempt the baseline with global `qwen`; inspect actual requests to a local mock OpenAI provider where the Hosted route is available. Use the real Hosted Harness model integration boundary when the global route requires unavailable SQL/Broker infrastructure.

Cover no tools, the five-tool profile (`read_file`, `write_file`, `edit`, `run_shell_command`, `monitor`), search/Agent additions and removals, unchanged reordered names, and recorded model-request replay followed by a fresh round. Assert both request tool schemas and generated tool guidance/examples. Also verify core policy and the order of Agent instructions and Workspace context.

Run the focused Hosted model tests and the existing Core prompt tests, build and bundle the CLI, typecheck, format/lint changed files, and perform independent post-fix verification and code review.

## Acceptance criteria

1. Fresh Hosted requests use the same declared name set for tool schemas and Core's generated tool guidance/examples.
2. A no-tool request uses an explicit empty snapshot; the five-tool profile keeps matching guidance and omits unavailable search and Agent recommendations in the gated sections.
3. Changes in names update guidance before the next fresh request, while an unchanged set does not cause repeated tool-driven prompt refreshes.
4. Agent instructions and Workspace context keep their content and order.
5. Recorded recovery requests retain their saved prompt and tools; subsequent fresh requests use the current surface.

## Risks and open questions

The main risk is changing cached prompt text more often than necessary or accidentally re-rendering a recorded recovery request. Name-set comparison and explicit replay coverage address these risks. Core's existing filters intentionally cover generated tool guidance and examples, not every static mention of a tool. No product decision remains open for this fix.
