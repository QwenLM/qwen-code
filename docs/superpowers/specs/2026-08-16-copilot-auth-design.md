# Copilot Auth — Current Design

**Date:** 2026-08-16
**Status:** Implemented scope, refreshed after final review

## Goal

Provide GitHub Copilot authentication in Qwen Code without a user-supplied API
key. The flow should reuse an existing Copilot credential when possible and
otherwise complete GitHub's device authorization flow in the terminal.

## Supported behavior

- `/auth` exposes **GitHub Copilot** as a fourth top-level choice alongside
  Alibaba ModelStudio, Third-party Providers, and Custom Provider.
- Selecting it starts the existing provider setup flow without an API-key step.
  It starts from the built-in static Copilot model preset; users select the
  models they want during setup.
- The auth hook first looks for a `ghu_` or `gho_` credential in a valid
  `GITHUB_TOKEN` value or in supported local GitHub Copilot and VS Code
  credential stores.
- If discovery finds no credential, Qwen Code shows a verification URL and
  device code. The user completes that authorization in a browser while the
  terminal polls for completion. Cancelling the operation aborts the request
  flow and prevents the credential from being installed.
- A successful device flow persists its credential to
  `~/.config/github-copilot/hosts.json`. The token manager exchanges `ghu_`
  credentials for a short-lived Copilot bearer, or uses a discovered `gho_`
  credential directly, and keeps its cached bearer and endpoint together.
- Copilot requests reuse the existing Anthropic and OpenAI generators. The
  request wrapper replaces its internal endpoint placeholder, adds the required
  Copilot authentication headers, refreshes once after a `401`, and reports a
  `429` retry hint.
- Model-family routing is static: `claude-*` uses the messages wire,
  `gpt-5*` uses the responses wire, and other model ids use the chat wire with
  a warning.

## Supported configuration boundary

The provider setup writes its ordinary provider selection and models through
the existing installation path. It does not provide a Copilot-specific
`security.auth` settings block, custom GitHub host, or live-model-discovery
option. Alternate GitHub-host and custom endpoint setup are not documented as
supported user configuration.

Qwen Code does not query a live Copilot model list, enable models through a
policy endpoint, or attach headers for such requests. The static provider
preset and model-family router are the supported surface.

## Verification focus

The relevant tests cover credential discovery, device-flow polling and
cancellation, persistence and cache locking, request-header injection and
refresh, static routing, provider installation, and the `/auth` and `/model`
UI handoff. Documentation should describe only those implemented paths.
