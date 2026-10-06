# Stable managed-memory policy and request-tail catalogs

[English](managed-memory-cache-prefix.md) | [简体中文](managed-memory-cache-prefix.zh-CN.md)

Status: implementation proposal for #11550 within the #2653/#8277 prompt and cache architecture track. The broader reminder architecture and original backend cache measurements remain separate acceptance work.

## Problem and outcome

Legacy managed memory puts its MEMORY.md indexes in the system instruction. Every successful memory refresh can therefore change an early request prefix, before the conversation. The first memory also switches condensed guidance to full guidance. Moving only the indexes leaves that second source of invalidation.

The intended outcome is that saving, updating or deleting managed memories with unchanged scopes preserves the system instruction, tools and stored conversation. The next request still receives the current catalog. This is client request-prefix stability; it does not establish server KV retention, prefill latency or net cost savings.

## Design and tradeoff

Keep the existing full memory policy in the system instruction, independent of index contents. Session callers select `forceFullProtocol: true` and `includeIndexes: false`; maintenance writers keep the existing default combined prompt. The complete policy preserves access, type and scope rules, including TEAM privacy and credential restrictions. The policy explicitly identifies request-tail catalog entries as data and pointers, rather than instructions.

Build the catalog separately with the existing per-scope headers, empty placeholders and truncation. Append one text part after the current request's conversation and tool responses. Copy the tail Content container and its parts array; never persist this part in history, mutate caller input or append a new history event on refresh. An unchanged refresh produces identical catalog text. A later request replaces the prior request-only catalog rather than accumulating old revisions.

Always using full policy increases startup input for an empty corpus relative to the former condensed path. This is a deliberate correctness tradeoff to prevent first-save policy changes and preserve complete guidance. It requires quality and complete-cost assessment under #12333; this change alone is not a claim of lower billed tokens.

## Execution and ownership

`Config` stores policy and catalog separately. Legacy refresh constructs both after all index reads succeed and installs them synchronously. A thrown read or hierarchical refresh leaves the last successful pair intact. Disabled memory, safe mode and workspace relocation clear both. Scope or trust changes are legitimate prompt changes, and cache stability must not retain obsolete access or another workspace's data. Existing index readers' null/empty outcomes remain authoritative; this change does not alter filesystem failure semantics.

Main LlmChat, ordinary AgentCore runs, rendered forks and in-process Arena runs share request assembly in LlmChat. They receive the current catalog for their runtime Config at that boundary. Custom and one-off generation use the same append helper after modality slimming. The catalog follows tool responses; provider converters retain their existing tool ordering and cache behavior.

Structured recall remains opt-in and receives no legacy catalog. Its tree/body delivery is unchanged. The catalog getter gates on legacy mode and a nonempty policy getter. This also respects maintenance-agent derived configs that suppress session memory by overriding the policy getter. The private legacy catalog is retained while a prepared structured transition commits, so rollback can expose the original catalog without expanding the transition payload. Workspace resets clear that retained data.

## Accounting and display

Request snapshots attribute only the exact final catalog text part of the final user Content to memory. They remove that one part from message estimation, without modifying the request or counting earlier identical user text as memory. The policy remains attributed from the system string. `/context`, memory display and memory-size warnings include both policy and catalog. Provider usage remains authoritative for billed totals.

## Verification and acceptance

The automated regression covers first-save, update, no-op refresh, deletion, thrown refresh failure, scoped suppression, structured commit/rollback, workspace reset, request-tail nonpersistence, tool pairing and accounting. The actual streaming send boundary must show the current catalog once, stable prior history and no old catalog in later history. Custom generation must preserve its caller's contents.

A bounded controlled CLI/provider check should capture requests around a successful managed write and verify both latest-memory visibility and prefix equality. Real-model selection/reading quality, original llama.cpp warm-cache counters, representative complete cost and P95 remain unverified until their respective environments are available. No proxy service is required by this implementation.

## Scope and follow-up

This proposal fixes the managed legacy index placement in #11550. It does not migrate every dynamic system-reminder producer in #2653, implement the entire dynamic-content architecture in #8277, enable structured recall by default, or replace the inaccessible external benchmark runner. Maintainer review should assess the policy/data split and full-policy startup tradeoff together with those tracks.
