# Copilot Auth Implementation Plan

**Date:** 2026-08-16
**Status:** Re-scoped to the implemented surface after final review

## Goal

Add GitHub Copilot as a native `/auth` choice while keeping its authentication
and model behavior within the capabilities verified by this repository.

## Implemented plan

1. **Expose the provider in the auth UI.** Add GitHub Copilot as the fourth
   top-level `/auth` choice and reuse the existing provider setup transaction.
   The Copilot provider has no API-key step and begins with its built-in static
   model preset.
2. **Reuse or acquire a credential.** Before provider installation, look for a
   valid `ghu_` or `gho_` credential in `GITHUB_TOKEN` and supported local
   Copilot or VS Code stores. If none is available, run GitHub's device flow,
   display the verification URL and code, and persist the resulting credential
   to `~/.config/github-copilot/hosts.json`.
3. **Make the flow cancellable and cache-safe.** Thread cancellation through
   the device-code request and polling loop so a cancelled operation cannot
   persist credentials or install the provider. Keep token cache reads,
   refreshes, and writes coordinated so a bearer and its endpoint are observed
   as one snapshot.
4. **Route requests through the established generators.** Use a wrapped fetch
   to inject the current Copilot bearer and endpoint, retry once after a `401`,
   and retain the rate-limit breadcrumb. Route `claude-*` to messages,
   `gpt-5*` to responses, and other ids to chat.
5. **Persist ordinary provider state only.** Use the existing provider install
   plan to save the selected Copilot models and active auth type. Keep the
   no-credential `/model` handoff inside the auth dialog.

## Explicitly out of scope

- A Copilot-specific settings schema.
- Alternate GitHub-host, custom GitHub-domain, or custom endpoint setup.
- Live model discovery, model policy changes, or model-list-specific request
  handling.
- Model-list endpoint version behavior or tests for it.
- Extra Copilot configuration switches that are not part of the shipped UI.

## Verification

Run focused core tests for token discovery, device flow, token caching, fetch
wrapping, and model routing; run focused CLI tests for `/auth` and `/model`;
then run the repository typecheck, lint, and build. Review the final diff for
unsupported configuration or live-model-discovery claims before publishing
user-facing documentation.
