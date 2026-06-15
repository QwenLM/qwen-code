# OpenRouter Auth and Model Management Design

This document captures the design intent behind the OpenRouter auth flow and the
model management changes introduced with it. It intentionally focuses on the
product and architectural choices, not implementation history.

## Goals

- Let users authenticate with OpenRouter from both CLI and `/auth`.
- Reuse the existing OpenAI-compatible provider path instead of adding a new auth
  type for OpenRouter.
- Make the first-run experience usable without asking users to manage hundreds of
  models immediately.
- Keep a clear path toward richer model management via `/manage-models`.

## OpenRouter Auth

OpenRouter is integrated as an OpenAI-compatible provider:

- auth type: `AuthType.USE_OPENAI`
- provider settings: `modelProviders.openai`
- API key env var: `OPENROUTER_API_KEY`
- base URL: `https://openrouter.ai/api/v1`

This avoids introducing an OpenRouter-specific `AuthType` when the runtime model
provider path is already OpenAI-compatible. It keeps auth status, model
resolution, provider selection, and settings schema aligned with the existing
provider abstraction.

The user-facing flows are:

- `/auth` → OpenRouter for the interactive TUI flow.
- Environment variables for automation or direct API-key setup:
  `OPENROUTER_API_KEY` plus `OPENAI_BASE_URL=https://openrouter.ai/api/v1`.
- `~/.qwen/settings.json` for scripted setup that needs explicit model provider
  entries.

Browser OAuth uses OpenRouter's PKCE flow and writes the exchanged API key into
settings before refreshing auth as `AuthType.USE_OPENAI`.

## Model Management

OpenRouter exposes a large dynamic model catalog. Writing every discovered model
into `modelProviders.openai` would make `/model` noisy and would turn a long-term
settings field into a cache of a remote catalog.

The key design split is:

- **Catalog**: the full set of models discovered from a source such as
  OpenRouter.
- **Enabled set**: the smaller set of models that should appear in `/model` and
  be persisted in user settings.

For the initial OpenRouter flow, auth should finish with a useful default enabled
set instead of interrupting the user with a large picker. The recommended set
should be small, stable, and biased toward models that let users try the product
successfully, including free models when available.

`/model` remains a fast model switcher. It should not become the place where
users browse and curate a full provider catalog.

## `/manage-models`

Richer model management belongs in a separate `/manage-models` entry point. That
flow should let users:

- browse discovered models;
- search by id, display name, provider prefix, and derived tags such as `free` or
  `vision`;
- see which models are currently enabled;
- enable or disable models in batches.

The source dimension must remain part of this design. OpenRouter is only the
first dynamic catalog source; future sources such as ModelScope and ModelStudio
should fit the same shape. UI complexity can be reduced, but the underlying
source abstraction should stay available as the extension point.

## Current Boundary

This change should do the minimum needed to make OpenRouter auth and model setup
pleasant:

- OAuth or key-based auth configures OpenRouter through the existing
  OpenAI-compatible provider path.
- The initial enabled model set is curated instead of dumping the full catalog
  into settings.
- Full catalog storage, browsing, filtering, and batch management are deferred to
  `/manage-models`.

The design principle is simple: authentication should get users to a working
state quickly, while model curation should live in a dedicated management flow.
