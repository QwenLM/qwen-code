# Auth Provider Registry Motivation

The auth module used to model each setup path as a separate flow: API key,
OAuth, subscription plans, and custom providers. In practice, all of these paths
produce the same kind of output: updates to the user's provider configuration in
`~/.qwen/settings.json`.

This refactor makes provider setup the shared abstraction. A provider describes
how it is shown, how credentials are collected, which models it installs, and
which settings patch should be applied. API keys, OAuth, coding plans, token
plans, and custom wizards are setup methods for a provider, not separate auth
architectures.

## Goals

- Keep `/auth` user-facing flows easy to understand:
  - Alibaba ModelStudio for first-party Qwen setup.
  - Third-party providers for common built-in integrations such as DeepSeek,
    MiniMax, and Z.AI.
  - OAuth providers such as OpenRouter.
  - Custom providers for local servers, proxies, or providers that are not built
    in.
- Move provider-specific data into small declarative provider configs.
- Make third-party provider contributions simple: adding a common provider
  should usually mean adding one provider config plus tests.
- Centralize settings writes through `ProviderInstallPlan` and
  `applyProviderInstallPlan`.
- Keep UI grouping separate from install behavior. Groups help users navigate
  `/auth`; they should not drive settings logic.
- Preserve a path for model list ownership and provider metadata so provider
  model updates can be detected and applied safely.

## Architecture

The new structure separates provider definitions, install logic, and UI state:

```text
packages/cli/src/auth/
├── allProviders.ts
├── providerConfig.ts
├── types.ts
├── install/
│   └── applyProviderInstallPlan.ts
└── providers/
    ├── alibaba/
    ├── custom/
    ├── oauth/
    └── thirdParty/
```

`ProviderConfig` is the declarative contract for built-in providers. It contains
the provider label, protocol, base URL options, environment key, model list,
model metadata, UI grouping, and setup behavior.

`buildInstallPlan` converts a provider config and collected setup inputs into a
`ProviderInstallPlan`. The install plan is the only object the settings writer
needs to understand.

`applyProviderInstallPlan` applies that plan by updating environment settings,
`modelProviders`, selected auth type, optional model selection, and provider
metadata. This keeps settings persistence independent from the UI flow that
collected the inputs.

## User flows

`/auth` can still present different entry points, but they should all converge on
the same provider install path:

1. **Alibaba ModelStudio**
   - Coding Plan
   - Token Plan
   - Standard API key

2. **Third-party Providers**
   - Common providers with built-in defaults.
   - Each provider should own its base URL, env key, default models, and model
     metadata.
   - Z.AI must use the setup-specific base URL:
     - Coding Plan: `https://api.z.ai/api/coding/paas/v4`
     - Standard API key: `https://api.z.ai/api/paas/v4`

3. **OAuth**
   - Browser-based authorization for routing platforms such as OpenRouter.
   - OAuth-specific mechanics can live in the provider implementation, but the
     final result should still be a provider install plan.

4. **Custom Provider**
   - Manual setup for local servers, proxies, or unsupported providers.
   - The wizard collects protocol, base URL, API key, model IDs, and advanced
     model options such as thinking, multimodal input, context window, and max
     tokens.

## Model ownership and updates

Static built-in providers can persist provider metadata under
`providerMetadata.<providerId>`, including the model list version and base URL.
This lets Qwen Code detect when a provider's built-in model list changes and
prompt the user to update owned models without overwriting unrelated custom
models.

Custom providers are different: their model list is user-authored and should not
be treated as an auto-updatable built-in model list.

## Non-goals

- Do not make API key, OAuth, coding plan, or token plan the top-level settings
  architecture.
- Do not couple settings writes to React components or CLI command handlers.
- Do not make UI groups a business-logic axis.
- Do not require contributors to understand the full auth UI to add a simple
  third-party provider.
