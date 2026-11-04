# Sessionless welcome settings

[English](sessionless-welcome-settings.md) | [简体中文](sessionless-welcome-settings.zh-CN.md)

## Problem

Web Shell welcomes users before creating a conversation. Its model preview can
publish a saved model absent from the catalog, while authentication later falls
back to a configured primary model. UI language changes currently send a slash
prompt, creating a conversation and reapplying the stale model. Even users with
no configured connection must be able to change UI language.

## Decision

Keep the existing Core authentication fallback and persistence policies. For a
missing catalog model, resolve the welcome preview through the same Core sync
without authentication, network requests, or settings writes. Preserve explicit
manual connections and existing endpoint selection for registered models.

Send UI language changes through sessionless APIs. Reuse the process-global
user language route. Add a trusted, selected-workspace language route that
persists only that workspace and synchronizes only its already-live runtime
channels. A cold runtime is not started; it reads the persisted setting later.
Both paths preserve output language and model selection. Keep generation and
client ownership guards. No unresolved workspace may fall back to the primary.

For SSH workspaces, settings and agent runtime remain local to the registered
workspace anchor, as with the existing workspace settings route. Permit the
language route through the SSH boundary; do not write remote project files.

The Web Shell settings picker and local `/language ui` command share this path.
Preserve user/workspace scope, host language authority and error rollback.
Refresh session command metadata only when a session already exists.

## Acceptance

- With a missing saved model and a preview-only catalog, welcome and the first
  conversation select the same model without rewriting `model.name`.
- A registered selection and its endpoint remain unchanged; manually configured
  runtime connections are not replaced with an unrelated catalog entry.
- UI language changes succeed with no models or sessions and do not create a
  conversation, select a model, invoke a model API, or alter output language.
- User writes affect user settings; workspace writes affect only the resolved,
  trusted workspace, including secondary workspaces. Invalid or removed
  workspaces fail without mutating primary or user settings.
- The shared behavior covers Desktop and the current VS Code Web Shell host.
  Native packaged-client acceptance is reported separately from fixture tests.
