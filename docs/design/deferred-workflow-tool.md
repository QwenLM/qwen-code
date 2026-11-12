# Deferred Workflow tool

[English](deferred-workflow-tool.md) | [简体中文](deferred-workflow-tool.zh-CN.md)

## Problem

By default, when workflows are enabled, Direct-mode requests carry the complete
Workflow description and parameter schema, even when the user never runs a
workflow. The existing deferred-tool bridge already supports discovering a
tool's schema with `tool_search` and invoking it with `tool_call` without
changing the request's standing function declarations.

## Decision

Make Workflow deferred by default with `shouldDefer=true`. Keep its full
description, parameter schema, registration gates, authoring reference and
execution behavior unchanged. The startup catalog retains the existing short
description. Explicit workflow intent and persistent Workflow mode still use
on-demand discovery; neither automatically reveals the schema.

The per-turn `isToolHiddenBehindToolSearch` helper must recognize native
deferred tools through the registry's `isDeferredAndHidden` result. Retain its
permission-deferred lazy-factory fallback, because a factory need not have a
tool instance yet. Preserve the CodeModeOnly exclusion: that mode invokes
discovered tools through `exec`, not the Direct-mode `tool_call` bridge. Do not
change the separate construction-time Skill reference decision.

## Compatibility and scope

- `tools.visible` can still expose Workflow directly. `tools.eager` does not
  override a tool's native deferral, consistent with other deferred tools.
- The existing schema-budget preload and incomplete-bridge fallback still
  apply. An explicit permission deferral remains distinct from native deferral.
  A nonzero preload budget remains all-or-nothing: Workflow now contributes to
  the candidate total and can push the entire deferred set over budget. The
  default zero budget does not preload tools.
  Normal LLM initialization runs `startChat` and resolves the incomplete-bridge
  fallback before Config marks Workflow mode ready or applies its initial mode,
  so mode activation does not wait for the first model request.
- Old histories containing direct Workflow calls can reveal the tool during
  replay; `/clear` retains its existing reset behavior.
- Named workflows, name-only sessions, host-owned runs and `/review` activation
  keep their existing registration and execution paths. Deferred calls retain
  target-tool approval, hooks and subagent restrictions.
- No public API, settings, parameter or persistence changes are required. Other
  tools, context-usage accounting and deployment are outside this change.

## Verification and acceptance

Use a real Workflow tool in registry and discovery tests. A default request with
workflows enabled must omit its full declaration and retain a short catalog
entry. Exact and keyword search must return the unchanged schema; reviewing it
must not expand the standing declarations. A reviewed call must execute through
the existing bridge, and unreviewed or policy-forbidden calls must remain
blocked.

Check native-deferred workflow intent and mode reminders, visible/revealed
tools, CodeModeOnly, permission-deferred lazy factories, schema-budget preload,
disabled workflows, missing bridge halves, name-only schemas, history replay,
`/clear` and mid-session `/review` activation. Run focused package tests, build,
typecheck and bundle.

Dry-run the headless E2E procedure with the global CLI, then compare actual
requests from the exact unmodified base and changed build with identical input
and configuration. Report token estimates with a fixed tokenizer separately
from provider usage. Mock-provider usage is synthetic and cannot establish
billed savings. The acceptance criterion is request-content reduction and a
working discovery/invocation path, not a fixed token-saving threshold.
