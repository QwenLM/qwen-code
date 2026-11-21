# Operator-controlled models.dev catalog refresh

[English](2026-11-01-model-catalog-refresh-setting.md) | [简体中文](2026-11-01-model-catalog-refresh-setting.zh-CN.md)

## Problem

Every session initializes the model catalog refresh, which may contact `models.dev` once every 24 hours. The only current disable switches are process environment variables. Managed installations cannot reliably set those variables across terminal, desktop, and service launch paths, and workspace environment values are deliberately rejected.

## Decision

Add `model.catalogRefresh`, a boolean with default `true`, to the existing `model` settings section. Honor it only from User, System, and SystemDefaults scopes by adding it to `WORKSPACE_RESTRICTED_SETTINGS`. Resolve that operator value before constructing the session `Config`, including in bare mode.

The CLI passes the setting to core as `modelCatalogRefreshEnabled`. Core starts the background refresh only when the setting is not `false` and the resolved usage-statistics setting is enabled. The env-only refresh gate remains unchanged, so `QWEN_CODE_MODELS_DEV_REFRESH=off` still wins. The bundled and previously downloaded catalog remain available; this switch controls network refresh, not local catalog reads.

Treat `privacy.usageStatisticsEnabled: false` as an opt-out from this background third-party request. Unlike the dedicated setting, that privacy choice is already preserved across operator scopes and bare mode. Document both controls so neither appears to promise traffic suppression while another path sends it.

## Scope and risks

Do not expose the setting in the settings dialog, introduce a three-state mode, or allow workspace settings to re-enable refresh. Do not change catalog lookup or the separate `QWEN_CODE_MODELS_DEV=off` behavior. The main compatibility risk is operators expecting a privacy opt-out to suppress only telemetry; the setting is documented explicitly to avoid that ambiguity.

## Verification

Test that the schema requires restart and defaults on, workspace values are stripped, all operator scopes resolve with normal precedence, bare mode preserves the choice, and CLI construction forwards only a boolean. Test that core skips the refresh for either the settings switch or the usage-statistics opt-out and that the environment-variable gate remains intact. Synchronize the generated settings schema and both language versions of the design.
