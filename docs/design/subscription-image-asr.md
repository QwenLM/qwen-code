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
in. Restore the last successful directory from the existing account credential
file, bound to the login revision and OAuth environment/client. Do not fetch at
startup. Opening a picker immediately displays that directory and refreshes it
in the background on every opening. An unchanged directory keeps the same layout
and highlighted route; changed responses replace the directory, adding and removing
entries. Keep the existing list or empty state visible and interactive during
discovery, including when no directory is cached; do not add a loading UI.
Transient failures retain the directory with the existing cached-data warning;
authentication and permission errors do not fall back. Within a process, only the
newest request may write each cached directory. Successful empty scene catalogs
replace old entries.

Persist selected model configurations under `modelProviders.qwen-subscription`
in the same settings scope as their selectors, using the existing API-key settings
writer. Save no tokens or environment-key credentials there, and require the fixed
subscription gateway. Startup restores selected configurations and cached directories
without discovery. Logout removes credentials and their directories but preserves
selected settings; invocation still requires login.

Reuse the API-key settings adapter and placeholder serializer for selected model
writes. Merge the target scope's own or lower-priority provider entries, preserve
raw environment references, and reject a conflicting higher-priority definition
before changing runtime selection. Voice and account activation use the same
provider-bucket builder. Persist a session-only selected model definition without
changing the default model or authentication preference. Resolve bare fast and
compaction selectors to their actual route when saving definitions; cover direct
advisor selection as well as pickers.

Each catalog has a request revision and shares an account identity epoch. Only
the latest request may publish or invalidate that catalog; logout and account
changes invalidate pending requests. A subscription discovery failure produces
an independent warning while successful API-key settings reloads remain usable.

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

Read optional `thinking_strength` from both catalogs and retain it in memory and
in selected model configurations and the account directory cache. Its valid levels and order drive reasoning
selection; prefer medium as
the default when available, otherwise the first advertised level. Missing or
empty metadata retains the existing client defaults for compatibility. Display
the returned `budget_tokens` as metadata only, as required by protocol section
2.3; preserve the existing route-specific request parameter and budget mapping.
Refresh the live reasoning snapshot with each catalog update so selection and
subsequent requests use the new levels without restarting. Keep explicit thinking
off and API-key reasoning behavior unchanged.

For model IDs shared by the main and scene catalogs, the latest successfully
fetched thinking metadata takes effect in the live runtime. Selecting a model
persists its latest metadata for restart; directory refresh also updates the account cache.
Main metadata must not hide newer scene metadata, and refreshing main models must
also replace older scene thinking metadata. Keep model eligibility per catalog.

Web Shell main selection marks its provider reload with `refreshModels: true`;
ordinary settings reloads do not discover models. Keep refreshed directories in
the owning workspace/runtime and copy primary metadata to its live sessions in
memory, with account and generation checks. Preserve daemon-local API-key provider
status when displaying the subscription directory, including before a session exists.

Web Shell requests scene discovery explicitly when opening the voice picker or
selecting a voice model directly with `/model --voice <id>`.
Routine voice status polling continues to read runtime memory or selected settings without discovery.
Legacy-primary and workspace-qualified routes retain their ownership and
generation checks across the asynchronous refresh.

## Affected components

Account catalog schemas/session storage, model registry and configuration,
model command/dialog, image configuration/tool/service, voice selection,
transcriber and Serve voice consumers. Share route resolution across consumers.

## Validation and acceptance

Check repeated background discovery, cache-hit layout and highlighted-route stability,
transient fallback and authentication errors, empty replacement, restart without
discovery, latest-response cache writes, and account/environment isolation,
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
