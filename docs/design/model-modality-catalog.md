# API-backed model modalities

## Problem

Qwen Code currently derives missing input modalities from model-id regular
expressions. That works for known model families, but new models and provider
aliases remain text-only until the table is updated manually.

## Design

Ship a compact snapshot containing only provider identity and input modalities,
generated from models.dev with `npm run generate:model-modalities`. Load it
during CLI configuration and cache the full live catalog at
`~/.qwen/models-dev.json`.

A valid disk cache is used immediately. When no cache exists, startup uses the
built-in snapshot immediately. Network access is always a background refresh,
so a cold start never waits for models.dev. The default loader refreshes stale
data after one hour and continues refreshing hourly while the process remains
alive. Refresh failures are non-fatal and retain the last usable disk cache or
built-in snapshot.

A successful refresh replaces the process-wide current catalog. Configurations
created after that point use the new metadata, including later sessions in a
long-running daemon. Existing sessions retain the catalog they were created
with so their capabilities do not change midway through a conversation.

Model modality resolution uses this precedence:

1. Explicit `generationConfig.modalities` from settings or a provider entry.
2. Exact model metadata from the models.dev provider catalog.
3. The existing model-id heuristic.
4. Text-only for an unknown model.

Model-id rules, including MiniMax M3 defaults, are fallback behavior only and
never override an explicit user value.

Built-in `/auth` templates omit modalities and let the catalog resolve them.
Modalities selected explicitly in the advanced setup flow continue to take
precedence. Existing saved configurations are not migrated or rewritten.
Their modalities remain explicit and take precedence over catalog metadata.

Provider identity is resolved from the configured provider when possible and
otherwise from its endpoint or credential environment key. The catalog lookup
is exact and case-insensitive; it does not guess across similarly named models.
An SDK protocol such as `openai` is not treated as provider identity when an
unknown custom endpoint or credential key is present.

Exact provider endpoints take precedence over local provider aliases so the
China and international Alibaba catalogs remain distinct. A missing endpoint
uses the local provider's default region, while an endpoint that models.dev
does not list falls back to the model-id heuristic instead of borrowing another
region's metadata. Idealab's `Qwen*-DogFooding` models and its listed
`bailian/` aliases resolve by model family to the corresponding Alibaba China,
DeepSeek, Moonshot, or MiniMax model IDs.

Every resolved provider first uses its exact catalog entry. When that catalog
does not list a recognized DeepSeek, Kimi, MiniMax, or GLM model, lookup falls
back to the model family's original provider catalog. This applies to Alibaba
and other gateways, while exact metadata from the current provider always
takes precedence. Lookup never scans arbitrary providers for the first matching
model ID; unrecognized families remain on the local fallback path.

OpenRouter model variants first use an exact catalog entry. When models.dev
does not list the variant, the recognized OpenRouter suffixes `:free`,
`:extended`, `:thinking`, `:online`, `:nitro`, `:floor`, and `:exacto` fall
back to the base model. Unknown suffixes remain unmatched.

The loaded catalog is passed to `ModelsConfig` and `ModelRegistry`. This covers
initial resolution, provider-backed models installed through `/auth`, manually
edited model providers, runtime model switches, and model-provider hot reloads
without persisting remotely supplied metadata into user settings.
The daemon workspace-provider status path uses the same catalog so model lists
shown before a session starts match the configuration used by live sessions.

## Boundaries

- This change reads input modalities only. It does not import pricing, token
  limits, reasoning flags, or the remote model list.
- It does not call provider-specific `/models` endpoints because their schemas
  are not portable. Those endpoints can be added later as a higher-priority
  source without changing the catalog interface.
- Unit tests disable the automatic network load and exercise the loader with
  injected cache paths and fetch functions.
