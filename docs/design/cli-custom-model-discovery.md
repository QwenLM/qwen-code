# CLI custom-provider model discovery

[English](cli-custom-model-discovery.md) | [简体中文](cli-custom-model-discovery.zh-CN.md)

## Problem and scope

The CLI already discovers models for selected built-in presets, but custom
providers require manually entered IDs. Extend the existing wizard rather than
introduce another configuration command. This local implementation covers new
connections and reconnecting through `/auth`; it does not add background polling
or a saved-provider bulk refresh command.

## Reference study

OpenCode was cloned to `~/github/opencode` at
`367d24b70aec58e7827f04c47dadf2a9f6802053`. Its TUI
`packages/tui/src/component/dialog-integration.tsx` supports selectable form
options, custom answers, explicit Continue and cancellation. Its
`dialog-model.tsx` reads the shared catalog, filters by provider, searches and
selects using provider/model identity. Catalog availability is distinct from
upstream discovery: `core/src/plugin/models-dev.ts` supplies catalog models,
while `core/src/plugin/provider/modal.ts` and `core/src/modal/models.ts` perform
provider-specific authenticated discovery with a timeout and connection-aware
cache. These are useful precedents, not evidence of a universal custom-endpoint
discovery API. Detailed source tracing is recorded in the local investigation.

Its local-provider plugins share `core/src/plugin/provider/local.ts`: endpoint
and credential-aware caching, per-endpoint locks, 30-second background refresh
and a 15-second request timeout. vLLM checks `/health` then `/v1/models`, Ollama
uses `/api/tags` and `/api/show`, and LM Studio uses `/api/v1/models`. These
protocol-specific adapters confirm why generic discovery must remain best-effort.

Borrow explicit confirmation, manual fallback and separation of candidates from
active selection. Retain Qwen's existing keyboard conventions and persistence
instead of importing OpenCode's plugin/cache architecture.

## Design

Reuse core `providers/model-discovery.ts` for bounded network requests, parsing,
ID validation, deduplication and curated-model preservation. Add an optional
protocol with the existing OpenAI behavior as default. Chat Completions appends
`/models`; Responses and Anthropic normalize a trailing `/v1` before appending
`/v1/models`. Anthropic sends its version header and matches runtime authentication:
native Anthropic hosts use `x-api-key`, while proxies use Bearer authentication.
Unavailable custom listings show a manual-entry notice in both renderers. Accept standard
`data` lists and gateway `models` maps. Keep the five-second/one-MiB limits and
failure-to-null contract for existing preset consumers.

Reuse `DiscoveringModelIdsStep` and `ModelIdsStep`. Supported custom protocols
enter a cancellable loading state after URL/key entry. The resulting snapshot
supports search, keyboard multiselect and manual IDs; Enter confirms, Esc goes
back and aborts the request. Gemini retains manual entry. Existing install
identity and advanced configuration remain authoritative. Discovery does not
persist credentials or models until the existing review/save flow completes.

Both renderers use this contract. OpenTUI's `dialogs-auth.tsx` calls the same
core helper and feeds the completed snapshot into its existing region-aware
model picker. Loading mounts no editor; leaving aborts and discards late
results. Discovery edits remain local until Enter, preserving confirmed IDs
when revisiting the step and keeping unlisted manual IDs editable. Built-in
presets retain their discovery flag, curated models and redirect defaults;
custom requests disable redirects. Existing non-discovery provider flows keep
their current behavior. The dynamic provider/fallback heading and key hints are
included in the terminal-height budget.

The Web Shell prototype has its own daemon adapter and settings reconciliation;
those have different trust and ownership requirements. This CLI change reuses
the core and wizard layers without calling daemon routes or moving their
credential-resolution logic into the TUI. Consolidating the daemon adapter is
separate work; it must preserve its public-network policy.

## Acceptance and risks

Verify all three protocol URL/header conventions, gateway parsing, manual
fallback, cancellation and late-result isolation. Existing preset discovery,
curated metadata and ID validation must remain covered. Test keyboard selection
and actual save against a controlled local endpoint with synthetic credentials.
Run build, typecheck, bundle, focused package tests and source review.

OpenTUI component tests cover the three protocols, Gemini manual entry,
loading/cancellation, late completion, search, selection restoration and
deselection, discarding unconfirmed drafts, final save, and built-in preset
success/fallback. Verify the actual native renderer with Bun and
`QWEN_TUI_RENDERER=opentui QWEN_TUI_RENDERER_STRICT=1` against an isolated local
endpoint; strict selection prevents an Ink fallback from masking a failure.

Local HTTP endpoints remain supported by the interactive CLI's existing fetch
policy. No daemon SSRF policy is relaxed. Discovered metadata is not newly
persisted; model IDs use the existing install defaults or explicit advanced
settings. No settings migration or automatic model switch.
