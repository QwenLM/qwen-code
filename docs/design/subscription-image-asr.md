# Subscription image generation and ASR

[English](subscription-image-asr.md) | [简体中文](subscription-image-asr.zh-CN.md)

## Scope and current gap

Qwen Account chat already uses device credentials. Image generation requires an
API-key environment variable and voice selection only supports API-key models
with bare identifiers. Implement account-backed image generation and recorded
ASR using the gateway contract, without automatic model selection or provider
fallback. Reference-image editing and realtime ASR are outside this change.

## Design

Fetch `/models` on each main model selection and `/models/scenes` on each scene
selection, including direct selectors. Only fetch account catalogs when signed
in. Persist scene catalogs with the existing account credentials, isolated by
account revision and OAuth environment/client. Restore cached catalogs at
startup without fetching missing scene catalogs; only entering model selection
refreshes the catalogs. Retain successful cached data after transient discovery
failures and report the fallback. Successful empty catalogs replace stale entries. Logout
removes credentials/catalogs but preserves explicit model settings.

Keep chat and scene eligibility separate. Scene image/voice models never become
main chat candidates. API-key candidates continue to come from local providers.
Keep imageModel and voiceModel as qualified selectors including an endpoint when
needed; accept unambiguous legacy bare IDs. No selection means disabled. Switching
the main model never changes these settings.

Use device access tokens obtained at request time, including the existing refresh
mechanism. Never persist tokens in model settings or send them to a configured
third-party endpoint. Image requests use the fixed gateway `/api/v1/services/aigc/
multimodal-generation/generation` synchronous endpoint. Recorded ASR uses
`/compatible-mode/v1/chat/completions` with `stream: false`, audio format and a
base64 data URI. Validate the encoded request against the gateway 8 MiB limit.
Both advertised ASR model families use this protocol; the gateway adapts native
upstream formats. Preserve existing API-key JSON and realtime implementations.

Membership, charging and quota decisions belong to the gateway. Auxiliary calls
must not require activation of a subscription chat model. Surface existing auth
and request errors; never silently switch billing routes. Use returned model
names, falling back to IDs. Do not display subscription model descriptions.

Read optional `thinking_strength` from both catalogs and retain it in the account
cache. Its valid levels and order drive reasoning selection; prefer medium as
the default when available, otherwise the first advertised level. Missing or
empty metadata retains the existing client defaults for compatibility. Display
the returned `budget_tokens` as metadata only, as required by protocol section
2.3; preserve the existing route-specific request parameter and budget mapping.
Refresh the live reasoning snapshot with each catalog update so selection and
subsequent requests use the new levels without restarting. Keep explicit thinking
off and API-key reasoning behavior unchanged.

For model IDs shared by the main and scene catalogs, the latest successfully
fetched thinking metadata takes effect, including after restart. A cached main
entry must not hide newer scene metadata, and refreshing main models must also
replace older scene thinking metadata. Keep model eligibility per catalog.

Web Shell requests scene discovery explicitly when opening the voice picker or
selecting a voice model directly with `/model --voice <id>`.
Routine voice status polling continues to read the cache without discovery.
Legacy-primary and workspace-qualified routes retain their ownership and
generation checks across the asynchronous refresh.

## Affected components

Account catalog schemas/session storage, model registry and configuration,
model command/dialog, image configuration/tool/service, voice selection,
transcriber and Serve voice consumers. Share route resolution across consumers.

## Validation and acceptance

Check repeated discovery, cache fallback and empty replacement, account changes,
main/scene separation, qualified and legacy selectors, request-time token refresh,
correct endpoints and payloads, explicit selection, cancellation, oversized audio,
and API-key regressions. Run focused package tests, build, typecheck and bundle;
exercise the CLI baseline and local artifact with isolated settings. Distinguish
mock protocol validation from live gateway acceptance.

## Open integration points

Verify nonstream ASR returns choices[0].message.content in gateway integration.
Native ASR hotword vocabulary mapping is not specified completely; do not invent
it. Existing text hotword hints may not apply to native ASR. Live paid image
acceptance requires a usable gateway/account and is reported separately.
