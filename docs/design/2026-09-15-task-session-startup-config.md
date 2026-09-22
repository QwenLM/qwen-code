# Model and reasoning selection at session creation

[English](2026-09-15-task-session-startup-config.md) | [简体中文](2026-09-15-task-session-startup-config.zh-CN.md)

Tracking: [#11944](https://github.com/QwenLM/qwen-code/issues/11944), independent PR 4.
Status: implemented on this branch; not yet merged. Baseline: `39b22efb6f` (2026-09-20).

## Goal

An external caller can start a new session with the same model and reasoning
selection as a user selecting them in the composer before sending a prompt.
Creation applies the selection only to that session, without saving shared
defaults. Subsequent prompts, manual changes, reload, fallback, skills and
restoration retain ordinary session behavior. The selection is not automatically
cleared after the first turn.

## Contract

Ordinary and standalone creation accept optional
`startupConfig: { modelServiceId, reasoningEffort? }`. `modelServiceId` is required;
`reasoningEffort` is optional. Omission selects only the model, without calling the
reasoning setter or substituting `default`, so models without reasoning controls
are supported. Explicit reasoning uses the existing `ReasoningSelection` values, including
`default` and `none`, with the composer's existing validation and application
semantics. Unknown properties, a simultaneous legacy `modelServiceId`, and explicit
`sessionScope: 'single'` are rejected. Ordinary startup configuration implies
`sessionScope: 'thread'`. Omission preserves the legacy API unchanged.

The daemon advertises `session_startup_config`. The TypeScript SDK checks this
capability and supports REST and daemon ACP HTTP/WS mappings. Direct child ACP,
load/resume and the `create_sub_session` tool schema are outside this PR.

Success returns `modelApplied: true` and `startupConfigApplied`, describing the
canonical current model selector, requested reasoning selection and effective
reasoning state when reasoning was explicitly requested. Model-only requests
return only the confirmed model selector in `startupConfigApplied`; they do not
claim to have applied a reasoning choice. This acknowledges preparation, not an
immutable lifetime policy.
Malformed requests are rejected before workspace mutations. Invalid selections
fail creation rather than running the initial prompt with a different selection.
Existing authentication, ownership, timeout and uncertain-outcome errors retain
their semantics.

## Implementation

The current UI prepares an ordinary session by creating and attaching it, setting
the model, setting reasoning, and then submitting the prompt. Reuse these existing
setters with model persistence disabled and reasoning `persist: false`.

Ordinary bridge creation applies and confirms both selections before returning.
Standalone preparation happens after managed binding commit (which authenticates
the deferred workspace) and before release or initial-prompt admission. A failed
preparation follows existing owned-session cleanup without killing siblings in
the shared child. A definite standalone selection rejection removes the owned
recording so the same id can be retried, with best-effort empty-directory cleanup.
Timeouts and channel failures retain the existing uncertain-outcome recovery;
cleanup whose outcome cannot be confirmed enters existing containment. SDK
confirmation mismatch after a readable success response is reported directly,
without recovery/adoption.
Startup selection emits session state changes, not a shared
`settings_changed` event.

Use the existing model route parser and config-option result for confirmation.
Do not add a second provider reasoning model. All daemon routes continue to use
their resolved workspace runtime and owner.

## Scope decisions

This supersedes the earlier lifetime-isolation proposal attached to issue #11944.
There is no `startupPinned`, persistent policy record, recording schema change,
strict restore protocol, fallback restriction, mutation gate or UI modification.
There is no promise to select the route before `Config.initialize` or initial
authentication: preparation follows the existing UI ordering. Shared defaults
remain unchanged by this startup operation; later manual operations retain their
existing persistence semantics. The other three PRs are not dependencies.

## Acceptance

- Compare actual provider requests from composer-equivalent preparation and the
  new creation API, including tool-loop continuation requests.
- Cover model-only creation on models without reasoning controls, explicit tiers,
  `default`, `none`, unsupported choices and shared `none`
  with requested `high`.
- Confirm standalone commit → selection → release → prompt ordering; preparation
  failures admit zero prompts.
- Verify unchanged user/workspace settings and siblings, no default-change event,
  ordinary second-turn/manual-change behavior and legacy creation compatibility.
- Cover unsupported daemons, invalid requests, workspace ownership, disconnects
  and cleanup failures.
- Run build, typecheck, bundle, focused package tests and E2E; distinguish
  controlled-provider evidence from real external-provider validation. Finish two
  consecutive clean full-diff self-audit passes.
