# API-backed model modalities

## Problem

Qwen Code currently derives missing input modalities from model-id regular
expressions. That works for known model families, but new models and provider
aliases remain text-only until the table is updated manually.

## Design

Load the models.dev catalog during CLI configuration and keep it in memory for
the session. The catalog is cached at `~/.qwen/models-dev.json`. A disk cache is
used immediately; when it is older than one hour, it is refreshed in the
background. A cold start without a cache performs one bounded network request.
Failures are non-fatal and preserve the existing heuristic behavior.

Model modality resolution uses this precedence:

1. Explicit `generationConfig.modalities` from settings or a provider entry.
2. Exact model metadata from the models.dev provider catalog.
3. The existing model-id heuristic.
4. Text-only for an unknown model.

Existing provider-specific canonical overrides, such as MiniMax M3 metadata
normalization, remain unchanged.

Provider identity is resolved from the configured provider when possible and
otherwise from its endpoint or credential environment key. The catalog lookup
is exact and case-insensitive; it does not guess across similarly named models.

The loaded catalog is passed to `ModelsConfig` and `ModelRegistry`. This covers
initial resolution, provider-backed models, runtime model switches, and model
provider hot reloads without persisting remotely supplied metadata into user
settings.

## Boundaries

- This change reads input modalities only. It does not import pricing, token
  limits, reasoning flags, or the remote model list.
- It does not call provider-specific `/models` endpoints because their schemas
  are not portable. Those endpoints can be added later as a higher-priority
  source without changing the catalog interface.
- Unit tests disable the automatic network load and exercise the loader with
  injected cache paths and fetch functions.
