# Scheduled Task Channel Delivery in Web Shell

[English](2026-11-07-scheduled-task-channel-delivery.md) | [简体中文](2026-11-07-scheduled-task-channel-delivery.zh-CN.md)

## Problem and scope

Issue #16516 exposes an existing daemon capability: delivering the final response of a successful persistent scheduled run through a configured Channel. The Web Shell currently neither shows saved delivery nor lets users manage it. This change is limited to Web Shell types, actions, task forms/cards, translations, tests, and user documentation. It does not change daemon routes, authorization, storage, or delivery guarantees. Webhooks, durable retries, failure alerts, and per-run delivery remain out of scope.

## Design

Reuse the SDK `DaemonChannelDelivery` contract on task reads and create/update requests. An omitted update preserves delivery; `null` explicitly clears it. Only actual user changes send the field, matching the existing gate field. Configuring a Channel never enables task delivery automatically. Destination IDs remain opaque: the form warns about leading or trailing whitespace and offers an explicit action to remove it, without changing IDs automatically.

The form offers delivery off or a Channel instance with a user/chat target ID. Observed contacts supply optional suggestions and load only when a delivery target is selected; labels are accompanied by Channel name, target type, and raw ID to distinguish similar names. Manual IDs remain possible because discovery is not authorization. Cards show the saved Channel, type, and ID even when discovery fails or the daemon no longer advertises delivery. Cards without a saved target omit the delivery line.

Configured Channels come from the existing workspace-aware Channel hook. Add a Web Shell action for the existing observed-contacts route, scoped with the same explicit workspace ID as task mutations. Only top-level users and groups become suggestions; threads/topics are not delivery target types.

Selecting another workspace in the form clears the draft delivery target and model/session-group choices, invalidates old discovery results, and preserves the name, prompt, and schedule. Editing stays pinned to the task's workspace. If the externally supplied locked workspace or primary workspace identity changes, close the form and discard the entire draft to prevent saving it to the wrong workspace.

Fully initialized daemon capabilities include the primary entry in `workspaces`, even for a single project. A separately hosted WebShellWithProviders can receive bootstrap capabilities with `workspaceCwd` but no `workspaces` array. Pass that explicit primary cwd to the form as a fallback for the primary target only. Missing or untrusted secondary workspaces cannot fall back to the primary workspace.

Gate editing on `channel_delivery` and discovery on `workspace_channel_observed_contacts`. Preserve saved values across capability loss, missing Channels, stale contacts, and request failures. Show understandable loading, failure, empty, and unavailable states. Only a successfully loaded Channel list establishes that a saved Channel is missing; an initial, loading, or failed request does not. A changed draft cannot be silently ignored after capability loss. The user can discard the unsaved delivery change, restoring the original target (or no target when creating a task), and save other form changes without sending a delivery update.

Delivery requires `persistent`, including the current-session option. Selecting `per_run` never silently clears delivery or switches the chosen mode. Explain the restriction and reject submission until the user explicitly clears delivery or chooses a persistent mode. An unchanged existing destination can be saved without rediscovery.

## Affected surfaces and risks

The main surfaces are the Web Shell workspace action/types, `ScheduledTasksDialog`, its application capability wiring, and English/Chinese strings. The principal risks are cross-workspace stale responses and accidental clearing on unrelated edits. Keep discovery state associated with its workspace and keep the saved value independent of discovered candidates. Channel destination support is ultimately validated by the existing daemon/provider; the catalog does not advertise per-type outbound capabilities.

## Validation and acceptance

Focused action tests verify route scoping and error handling. Form and browser coverage verify create, edit, clear, saved-target round-trip, same-name identity display, candidate isolation between Channels, manual IDs, missing contacts/Channels, failures, workspace switches and stale responses, primary-only bootstrap capabilities, capability gating, and the per-run restriction. Tasks without delivery keep their existing payload behavior and omit the delivery row. Run formatting, lint, build, typecheck, and focused unit/browser tests. Record actual results and environment limits in the local E2E report and PR draft; do not claim provider receipt based on mocked browser tests.

## Open questions and follow-up

There are no blocking implementation questions. Delivery guarantees, durable retries, and failure alerts remain separate work.

## Browser evidence

Verified with the repository Playwright harness and intercepted daemon responses: [before](assets/scheduled-task-channel-delivery/before.png), [delivery form](assets/scheduled-task-channel-delivery/after-details.png), [saved task](assets/scheduled-task-channel-delivery/after-card.png), and [mobile restriction and long ID](assets/scheduled-task-channel-delivery/mobile.png). These screenshots demonstrate the UI, not real provider receipt.

Browser verification against the built CLI also covered [explicit whitespace removal](assets/scheduled-task-channel-delivery/after-whitespace.png) and [a card after delivery is cleared](assets/scheduled-task-channel-delivery/after-cleared-card.png).
