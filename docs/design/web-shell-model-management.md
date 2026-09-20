# WebShell model management controls

[English](web-shell-model-management.md) | [简体中文](web-shell-model-management.zh-CN.md)

## Problem and scope

Embedded hosts may provision models externally while retaining native model selection. Settings visibility does not prevent accidental add/delete actions through other WebShell surfaces. Issue #12335 proposes optional instance-wide interaction controls; this is not authorization. Daemon APIs, SDK, CLI, file writes, and external provisioning remain unchanged.

## Design

Expose `modelManagement?: WebShellModelManagementOptions` with independent `allowAdd?` and `allowDelete?`, both defaulting to true. Export the type from the public entry. Normalize defaults and recognize setup commands in a small shared helper using the existing slash parser.

App hides add/delete UI, consumes disabled `/auth` before host callbacks or hidden-command forwarding, filters suggestions, closes an open setup dialog on restriction, and checks the latest policy in add/delete callbacks. AuthMessage checks again before installation. ModelManagementSection clears stale delete confirmation. SplitView and side-task panels forward the policy to ChatPane, which has its own command router and menu. Side tasks also check their initial prompt before sending it. Queued browser dispatch checks the latest policy at the submit/enqueue boundary, including after attachment preparation. No generic SDK behavior changes.

Dynamic restrictions affect future browser requests. Already dispatched operations and daemon-owned queued prompts cannot be revoked by these props. Re-enabling a capability does not reopen a stale dialog. Model lists, current badges, switching, `/model`, context-window editing, and session `/delete` keep existing behavior. Settings exclusions compose independently.

## Validation

Test omitted/empty options and all four combinations; public forwarding; settings and command entry points; welcome and split panes; host callback and hidden-command precedence; dynamic dialogs and retained callbacks; queue dispatch with latest policy. Assert no forbidden install/delete request and retain selection/parameter-editing regressions. Use existing DOM tests and a browser harness with mocked daemon routes for UI evidence. Run affected tests, build/typecheck/bundle and preflight; report baseline failures and unavailable checks explicitly.

## Open questions

The public API remains subject to upstream review. Implementation is proceeding at the contributor's request while issue discussion remains open. No backend permission design is included.
