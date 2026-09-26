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

Explicit model configuration remains above inferred catalog defaults. For inferred context windows, client-owned corrections take precedence over the selected catalog; existing regex tables and generic defaults supply missing fields. For output limits, existing regex matches take precedence over the catalog, preserving endpoint-specific request ceilings. The catalog supplies output limits only where the table has no match. Modalities are the union of catalog and regex capabilities, preserving existing support. Explicit configured modalities remain authoritative.

The runtime cache replaces the bundled snapshot only when its ISO `fetchedAt` timestamp is newer. Filesystem modification times do not determine freshness. Refreshing the cache does not rewrite an already resolved session configuration; later resolutions see refreshed data.

Sonnet 4.5 is corrected to 200,000 context tokens even when cached data advertises its retired 1M beta. Sonnet 4.6 and Sonnet 5 retain their catalog limits. See [Anthropic's context-window reference](https://platform.claude.com/docs/en/build-with-claude/context-windows).

## Projection and endpoint ambiguity

Only the supported first-party provider allowlist feeds the default catalog. Entries must support tool calls and text output. Only positive safe-integer token limits and boolean input modalities are accepted.

Model identifiers use the existing normalization rules. All entries that normalize to one key must agree, including dated and provider-qualified variants. If any disagree, omit the entire key and preserve the existing regex/default behavior. A bare identifier must not erase conflicting endpoint evidence. This is deliberately conservative: it does not certify every possible private gateway or correct endpoint-specific limitations already present in the regex tables.

Provider-aware lookup would require changing the model-resolution contract and its callers. It is deferred rather than approximated by first-provider precedence. Regeneration and runtime refresh use the same projection.

The draft-only `model.customCatalog` option was removed: it loaded too late for the first session and introduced process-global state that leaked across Config instances. Private/offline model overrides use the existing `modelProviders` generation settings. No new custom-cache file is read.

## Storage and refresh

A trimmed JSON snapshot ships with the CLI and has a 200 KiB generation budget. Refresh starts in the background after proxy initialization, uses a ten-second timeout and a 24-hour cache interval, revalidates with ETag, and atomically writes the cache under `Storage.getGlobalQwenDir()`. Concurrent refreshes share an in-flight request. Failure leaves the previous data usable and is logged only at debug level.

`QWEN_CODE_MODELS_DEV=off` restores regex-only behavior. `QWEN_CODE_MODELS_DEV_REFRESH=off` disables upstream refresh. `QWEN_CODE_MODELS_DEV_URL` selects a mirror with the same provider filtering. No request-time network lookup, cross-process lock, scheduled regeneration service, or new dependency is introduced.

## Validation and acceptance

Focused tests cover cache selection, malformed entries, conflict rejection, alias normalization, per-field fallback, corrections, refresh throttling and failure. Real-source smoke checks must additionally cover the bundled on/off behavior and a live models.dev refresh; a mocked fetch cannot validate upstream facts.

[DashScope's PDF reference](https://www.alibabacloud.com/help/en/model-studio/pdf-understanding) documents qwen3.8-max PDF support through Chat Completions in Beijing and Singapore using `file_data` plus `filename`. It explicitly excludes Responses API PDF delivery. The catalog therefore does not automatically enable PDF for qwen3.8-max. A lookup correction applies to both bundled and refreshed data; users can explicitly configure `generationConfig.modalities.pdf` for a verified endpoint. The image/video capabilities and other models remain unchanged. Enabling automatic PDF inference is deferred until lookup can account for the endpoint and protocol, with a live recognition test.

The [verification record](../verification/models-dev-catalog/README.md) owns commands, results, and remaining delivery gates. Required checks must pass on the final head, and explicit PDF opt-in must remain distinguishable from catalog defaults in the PR description.
