# Scheduled Task Channel Delivery in Web Shell

[English](2026-11-07-scheduled-task-channel-delivery.md) | [简体中文](2026-11-07-scheduled-task-channel-delivery.zh-CN.md)

## Problem and scope

Issue #16516 exposes an existing daemon capability: delivering the final response of a successful persistent scheduled run through a configured Channel. The Web Shell currently neither shows saved delivery nor lets users manage it. This change is limited to Web Shell types, actions, task forms/cards, translations, tests, and user documentation. It does not change daemon routes, authorization, storage, or delivery guarantees. Webhooks, durable retries, failure alerts, and per-run delivery remain out of scope.

## Design

Reuse the SDK `DaemonChannelDelivery` contract on task reads and create/update requests. An omitted update preserves delivery; `null` explicitly clears it. Only actual user changes send the field, matching the existing gate field. Configuring a Channel never enables task delivery automatically.

The form offers delivery off or a Channel instance with a user/chat target ID. Observed contacts supply optional suggestions; labels are accompanied by Channel name, target type, and raw ID to distinguish similar names. Manual IDs remain possible because discovery is not authorization. Cards show the saved Channel, type, and ID even when discovery fails or the daemon no longer advertises delivery.

Configured Channels come from the existing workspace-aware Channel hook. Add a Web Shell action for the existing observed-contacts route, scoped with the same explicit workspace ID as task mutations. Only top-level users and groups become suggestions; threads/topics are not delivery target types. A form workspace change clears its draft destination and invalidates old discovery results. Editing stays pinned to the task's workspace. Missing or untrusted workspaces cannot silently fall back to another workspace.

Gate editing on `channel_delivery` and discovery on `workspace_channel_observed_contacts`. Preserve saved values across capability loss, missing Channels, stale contacts, and request failures. Show understandable loading, failure, empty, and unavailable states. A changed draft cannot be silently ignored after capability loss.

Delivery requires `persistent`, including the current-session option. Selecting `per_run` never silently clears delivery or switches the chosen mode. Explain the restriction and reject submission until the user explicitly clears delivery or chooses a persistent mode. An unchanged existing destination can be saved without rediscovery.

## Affected surfaces and risks

The main surfaces are the Web Shell workspace action/types, `ScheduledTasksDialog`, its application capability wiring, and English/Chinese strings. The principal risks are cross-workspace stale responses and accidental clearing on unrelated edits. Keep discovery state associated with its workspace and keep the saved value independent of discovered candidates. Channel destination support is ultimately validated by the existing daemon/provider; the catalog does not advertise per-type outbound capabilities.

## Validation and acceptance

Focused action tests verify route scoping and error handling. Form and browser coverage verify create, edit, clear, saved-target round-trip, same-name identity display, manual IDs, missing contacts/Channels, failures, workspace switches and stale responses, capability gating, and the per-run restriction. Tasks without delivery keep their existing payload behavior. Run formatting, lint, build, typecheck, and focused unit/browser tests. Record actual results and environment limits in the local E2E report and PR draft; do not claim provider receipt based on mocked browser tests.

## Open questions and follow-up

There are no blocking implementation questions. Raw IDs are displayed to resolve the identity ambiguity raised in triage. Maintainer issue housekeeping and actual Channel delivery/retry enhancements are separate work. Stop before publishing the prepared PR as requested.
