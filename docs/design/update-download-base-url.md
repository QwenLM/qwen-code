# Configurable standalone update downloads

Issue: #11149

## Problem and current behavior

The standalone updater uses fixed release download sources. The installer has its own base URL option, but it selects a final version directory; reusing that variable in the updater would introduce different path semantics. All standalone update entrypoints share performStandaloneUpdate, including qwen update, /update, background updates, and update-and-relaunch.

## Proposed behavior

Introduce QWEN_UPDATE_BASE_URL as an optional absolute HTTPS release root. The updater appends the normalized v-prefixed version and platform archive name. The same root supplies SHA256SUMS and its optional signature. For example, https://downloads.example.com/qwen-code resolves version 0.23.0 beneath /qwen-code/v0.23.0/.

Resolve and validate the value once per update before creating directories or a lock. Treat an empty or whitespace-only value as unset and normalize trailing slashes. Reject non-HTTPS URLs, credentials, query strings, and fragments without echoing the rejected value.

With no override, preserve existing source order and fallback behavior. With an override, use only the configured source and report download failure without trying the built-in sources. Keep TLS verification, checksum checking, signature policy, extraction checks, smoke testing, rollback, and cleanup unchanged.

## Configuration trust

The update source controls executable downloads. Add the variable to the existing project-environment hardcoded exclusions. The launching shell and initial user-level dotenv loading may supply it; project dotenv files and the top-level settings.env section at every scope must not set or override it. User-level dotenv changes require a restart. Reuse the shared filter so initial loading, reload, and explicit runtime environments agree.

## Affected areas

- Shared standalone updater: one-time source resolution and download propagation.
- Existing environment exclusion list: protect the new variable from project configuration.
- Collocated updater and environment tests: custom/default source behavior, failures, integrity, and trust boundaries.
- User configuration documentation: variable syntax, path rules, fallback, trusted scopes, and separate npm registry lookup.

## Validation

Use temporary standalone fixtures, controlled HTTPS download responses, and isolated CLI configuration. Check the global CLI baseline without modifying its installation, then exercise the built local CLI and shared downloader. Cover full archive/verification URL selection, absent optional signatures, required-signature/checksum failures, invalid configuration before mutation, no fallback for a custom source, existing defaults, and environment filtering. No model call or live deployment is required.

## Scope and open decisions

This does not change installer semantics, npm version discovery, authentication, update scheduling, or verification policy. The configuration name and custom-source fallback choice remain reviewable proposals for maintainers; this PR chooses a distinct updater variable and no implicit fallback when it is set.
