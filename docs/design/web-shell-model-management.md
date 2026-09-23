# WebShell model management controls

[English](web-shell-model-management.md) | [简体中文](web-shell-model-management.zh-CN.md)

## Problem and scope

Embedded hosts may provision models externally while retaining native model selection. Settings visibility does not prevent accidental add/delete actions through other WebShell surfaces. Issue #12335 proposes optional instance-wide interaction controls; this is not authorization. Daemon APIs, SDK, CLI, file writes, and external provisioning remain unchanged.

## Design

Expose `modelManagement?: WebShellModelManagementOptions` with independent `allowAdd?` and `allowDelete?`, both defaulting to true. Export the type from the public entry. Normalize defaults and recognize setup commands in a small shared helper matching daemon tokenization and resolved command identity.

App hides add/delete UI, consumes a disabled `/auth` (or its `connect`/`login` aliases) after the host slash-command callback declines and before hidden-command forwarding, keyed on the resolved session command once its builtin-marked snapshot is available. Before that, the bare setup names are conservatively refused with the add-disabled notice. Project/user commands shadowing daemon-routed names remain runnable after metadata loads; App still owns the local `/auth` dialog route and gates that action directly. Host callback precedence applies to composer submissions, not inline edits or side-task initial prompts. The same refusal covers the inline message-edit path before any rewind, and the `/btw side` router checks the extracted question before provisioning a side-task session. App filters suggestions, closes an open setup dialog on restriction, and checks the latest policy in add/delete callbacks. AuthMessage checks again before installation. ModelManagementSection clears stale delete confirmation. SplitView and side-task panels forward the policy to ChatPane, which has its own command router and menu. Side tasks also check their initial prompt before sending it. A setup-like initial prompt waits for command metadata while additions are disabled, preserving the text; after five seconds a warning explains the delay. A late snapshot resumes classification, and a definite refusal clears both the live tab and its per-session mirror. Ordinary initial prompts do not wait. Queued browser dispatch checks a caller-supplied synchronous `getPromptDispatchError` callback at the submit/enqueue boundary, including after attachment preparation. The queue knows neither model policy nor `/auth`; its private rejection type distinguishes deliberate refusal from failed transmission. Refused queue items are removed without merging into a new composer draft, while attachment compensation still runs. Ordinary failures retain their existing draft recovery. The internal SettingsMessage data/handler bag is named `modelManagementSectionProps`, distinct from the public `modelManagement` policy. No generic SDK behavior changes.

Dynamic restrictions affect future browser requests. Already dispatched operations and daemon-owned queued prompts cannot be revoked by these props. Re-enabling a capability does not reopen a stale dialog. Model lists, current badges, switching, `/model`, context-window editing, and session `/delete` keep existing behavior. Settings exclusions compose independently.

## Why a single router guard is insufficient

| Boundary                        | Responsibility                                                                                                      |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| App composer                    | Handles main/welcome input after the host callback declines and before hidden-command forwarding.                   |
| ChatPane composer               | Owns split/side-task submission; its host callback is not App's complete command router.                            |
| Prepared prompt / retry         | Rechecks the actual outgoing text after async preparation/session allocation; also covers `/plan` and retry paths.  |
| Inline message edit             | Rewinds and resends directly, without a composer submission.                                                        |
| Side-task initial prompt        | Calls `actions.sendPrompt` directly, without a composer submission.                                                 |
| Browser queue dispatch          | Rechecks after holding a prompt or preparing attachments, when the policy may have changed.                         |
| Setup/save and delete callbacks | Covers settings actions and callbacks retained across a policy update; does not revoke already-dispatched requests. |

These are entry/dispatch checks for one UI policy over `/auth` and its `connect`/`login` aliases, not six independent permission systems. Public options remain unchanged; internal naming and queue layering are implementation details.

## Validation

Test omitted/empty options and all four combinations; public forwarding; settings and command entry points; welcome and split panes; host callback and hidden-command precedence; dynamic dialogs and retained callbacks; queue dispatch with latest policy. Assert no forbidden install/delete request and retain selection/parameter-editing regressions. Use existing DOM tests and a browser harness with mocked daemon routes for UI evidence. Run affected tests, build/typecheck/bundle and preflight; report baseline failures and unavailable checks explicitly.

![Model management before restriction](assets/web-shell-model-management-before.png)

![Model management with add/delete disabled](assets/web-shell-model-management-after.png)

## Open questions

The public API remains subject to upstream review. Implementation is proceeding at the contributor's request while issue discussion remains open. No backend permission design is included.
