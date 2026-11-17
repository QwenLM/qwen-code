# Embedded settings allowlists

[English](web-shell-settings-allowlists.md) | [简体中文](web-shell-settings-allowlists.zh-CN.md)

## Problem and scope

Issue #12320 follows the exclusions shipped in #11975. Hosts exposing a small settings surface must currently enumerate everything else, and upgrades expose new settings automatically. Add an optional presentation allowlist using the existing stable IDs. No daemon protocol, saved settings, underlying feature activation, capability checks, ordering, or independent command behavior changes.

## Design and decisions

Add `includeItems?: readonly WebShellSettingItemId[]` alongside `excludeItems`. Missing inclusion means the existing behavior; an empty inclusion list intentionally hides every native settings item and uses the existing empty state without a warning. Otherwise show only eligible included items, with exclusions winning on conflict. Both ordinary settings and builtin blocks follow the same policy in both scopes.

Retaining the shipped exclusion API avoids migration. A mode discriminator would either replace that API or introduce another overlapping shape. An empty host-generated allowlist must not unexpectedly expose everything. These are presentation filters, not access control: commands and daemon writes remain available and no saved values change.

Centralize policy in positive `isItemVisible` and `isSettingVisible` predicates. Unaliased schema keys remain visible without an allowlist for compatibility, but are hidden whenever an allowlist is configured. Unknown runtime IDs cannot enable unmapped settings. Existing hardcoded and capability filters run before presentation filtering.

Use the same predicates in category filtering, settings picker entry guards, pending voice-picker checks, and dynamic dialog closure. Empty categories disappear; selection falls back to a remaining category. Independently launched command dialogs remain available. The browser harness must distinguish an absent include parameter from an empty one.

## Files and compatibility

Change the web-shell settings helpers and their consumers in App and SettingsMessage, focused helper/DOM/App/wrapper tests, the existing settings browser harness/spec, and the embedding README. Public options already flow through the provider wrappers. No new package dependencies or parent submodule changes are needed.

## Verification and acceptance

Verify default and exclusion-only compatibility, empty allowlists, ordinary/builtin inclusion, exclusion precedence, unknown and inherited IDs, unaliased keys, capability filtering, both scopes, category fallback, and dynamic picker cleanup including pending voice requests. Run browser checks with real daemon descriptors at desktop/mobile widths, preserving the existing exclusion regression. Capture visible examples. Build, typecheck, bundle, run focused tests and full preflight before submitting a draft PR, recording any failures. Review the entire diff in two clean self-audit passes and an independent review.

## Status and open questions

2026-09-20: implemented on `d52b409dcd`, following the issue's automated review and the host author's explicit request to proceed. A draft PR will present executable behavior for review; maintainer confirmation of the public API remains pending. The original exclusions design records the earlier phase; this document describes its allowlist extension.

## Browser evidence

Real daemon settings descriptors were replayed through an isolated browser harness with synthetic session data. All six scenarios passed in both scopes: default, exclude-all, desktop allowlist, empty allowlist, conflict, and mobile allowlist. Screenshots below show the current implementation without an allowlist as a compatibility comparison, then language/chat-width inclusion at 1280×900 and 390×844, and the empty state. These checks do not claim real-provider model execution.

![Default presentation without an allowlist](assets/settings-allowlists/default.png)

![Desktop allowlist](assets/settings-allowlists/allowlist-desktop.png)

![Mobile allowlist](assets/settings-allowlists/allowlist-mobile.png)

![Empty allowlist](assets/settings-allowlists/empty-allowlist.png)
