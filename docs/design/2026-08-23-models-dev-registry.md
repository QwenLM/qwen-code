---
title: 'Data-Driven Model Metadata Registry (models.dev)'
date: '2026-08-23'
status: 'implemented in PR #11959'
---

# Data-Driven Model Metadata Registry

[English](2026-08-23-models-dev-registry.md) | [简体中文](2026-08-23-models-dev-registry.zh-CN.md)

## Problem and scope

Model context windows, output limits, and input modalities currently require a CLI release to update hard-coded tables. PR #11959 adds a bundled models.dev snapshot and a background refresh. This document incorporates the useful constraints from the earlier design-only PR #9851; the implementation and its verification now belong to one PR.

Reasoning-effort tiers, reasoning wire fields, pricing, provider detection, and the OAuth model list remain outside this change. The earlier proposal to migrate effort metadata is deferred; its provider-specific claims need fresh verification before implementation.

## Resolution and precedence

Explicit model configuration remains above inferred catalog defaults. For inferred context windows, client-owned corrections take precedence over the selected catalog; existing regex tables and generic defaults supply missing fields. For output limits, existing regex matches take precedence over the catalog, preserving endpoint-specific request ceilings. A table match may come from the other spelling of the same version, and a value found that way does cap explicit request and environment budgets. The catalog supplies default output limits only where the table has no match; those catalog-only values do not cap explicit request or environment budgets. Existing curated output caps and the context-window clamp still apply. Trusted catalog image, audio, and video capabilities extend the regex defaults. PDF remains explicit because it selects an endpoint- and protocol-dependent file path. Explicit configured modalities remain authoritative.

The runtime cache replaces the bundled snapshot only when its ISO `fetchedAt` timestamp is newer. Incomplete responses are rejected before they can replace a complete snapshot or cache. Filesystem modification times do not determine freshness. The selected catalog stays fixed for the lifetime of a process, so context and output defaults use the same metadata. A background refresh writes the cache for the next process start.

Sonnet 4.5 is corrected to 200,000 context tokens even when cached data advertises its retired 1M beta. Sonnet 4.6 and Sonnet 5 retain their catalog limits. See [Anthropic's context-window reference](https://platform.claude.com/docs/en/build-with-claude/context-windows).

Preset or explicitly configured context windows remain authoritative for that configuration. Automatic detection uses the catalog and can differ from a preset for the same model id. We retain this precedence to deliver verified metadata updates; endpoint-specific overrides use existing model settings. Likewise, trusted modality additions are retained because they enable verified image support on DashScope. Provider-aware reconciliation remains a follow-up, rather than treating every empty family fallback as a capability veto.

## Projection and endpoint ambiguity

Only the supported first-party provider allowlist feeds the default catalog's token limits and modalities. The `thinkingmachines` first-party bucket is an explicit modality-only exception for issue #8558's Inkling image support; reseller and router claims do not widen another provider's capabilities. Entries must support tool calls and text output. Only positive safe-integer token limits and boolean input modalities are accepted.

Model identifiers use the existing normalization rules. A projected key must be a fixed point of the normalizer and must not be a numeric tag, an `@` alias, a generic router label, or an otherwise ambiguous short key. The same rule filters caches written by older versions. All token limits that normalize to one key must agree, including dated and provider-qualified variants. If any disagree, omit the limits and preserve the existing regex/default behavior. A bare identifier must not erase conflicting endpoint evidence. This is deliberately conservative: it does not certify every possible private gateway or correct endpoint-specific limitations already present in the regex tables.

Each entry is additionally committed under the other spelling of its version, because models.dev publishes one spelling per provider while vendors and the proxies in front of them accept either (`qwen2-5-72b-instruct` and `qwen2.5-72b-instruct` are one model). This extends the agreement rule above rather than relaxing it: the two spellings normalize to different keys, so they are not limits disagreeing under one key. An alias is skipped when the projection already considered that key — whether it wrote it or dropped it because its allowlisted providers disagreed on limits — when the alias is not itself a normalization fixed point, or when two spellings claim one alias with different values. Only a digit run short enough to be a minor version is respelled, and a key ending in a release date is never respelled at all, so a size suffix and a release date get no alias. Key-specific adjustments — the client-owned context corrections, the curated output pins in `tokenLimits.ts`, and the DashScope pdf carve-out — must walk both spellings, or the twin keeps serving the unadjusted numbers.

Provider-aware lookup would require changing the model-resolution contract and its callers. It is deferred rather than approximated by first-provider precedence. Regeneration and runtime refresh use the same projection.

The draft-only `model.customCatalog` option was removed: it loaded too late for the first session and introduced process-global state that leaked across Config instances. Private/offline model overrides use the existing `modelProviders` generation settings. No new custom-cache file is read.

## Storage and refresh

A trimmed JSON snapshot ships with the CLI and has a 200 KiB generation budget. The full upstream download has a separate 16 MiB limit. Refresh starts in the background after proxy initialization, uses a ten-second timeout and a 24-hour cache interval, revalidates with ETag, and atomically writes the cache under `Storage.getGlobalQwenDir()`. Cache reads and ETag reuse require the current projection version and a reachable model key. Older or unstamped caches require a full download and re-projection; bump `MODEL_CATALOG_PROJECTION_VERSION` when projection rules change. Projection 2 is the dual-spelling keying above, so a projection-1 cache must not keep winning over the bundled snapshot and silently drop the aliases. Concurrent refreshes share an in-flight request. Failure leaves the previous data usable and is logged only at debug level.

`QWEN_CODE_MODELS_DEV=off` restores regex-only behavior. `QWEN_CODE_MODELS_DEV_REFRESH=off` disables upstream refresh. `QWEN_CODE_MODELS_DEV_URL` selects a mirror with the same provider filtering. No request-time network lookup, cross-process lock, scheduled regeneration service, or new dependency is introduced.

## Validation and acceptance

Focused tests cover cache selection, malformed entries, conflict rejection, alias normalization, per-field fallback, corrections, refresh throttling and failure. Real-source smoke checks must additionally cover the bundled on/off behavior and a live models.dev refresh; a mocked fetch cannot validate upstream facts.

[DashScope's PDF reference](https://www.alibabacloud.com/help/en/model-studio/pdf-understanding) documents qwen3.8-max PDF support through Chat Completions in Beijing and Singapore using `file_data` plus `filename`. It explicitly excludes Responses API PDF delivery. The catalog therefore does not automatically enable PDF for any model; users can explicitly configure `generationConfig.modalities.pdf` for a verified endpoint. This does not remove catalog image, audio, or video capabilities. Enabling automatic PDF inference is deferred until lookup can account for the endpoint and protocol, with a live recognition test.

The [verification record](../verification/models-dev-catalog/README.md) owns commands, results, and remaining delivery gates. Required checks must pass on the final head, and explicit PDF opt-in must remain distinguishable from catalog defaults in the PR description.
