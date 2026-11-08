# Observed Channel Contacts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Expose a fresh, workspace-scoped graph of dynamically observed direct users, groups, topics, and their observed users with complete platform identifiers.

**Architecture:** `ChannelBase` normalizes accepted inbound envelopes into relationship observations. The daemon worker writes them to a bounded workspace-partitioned JSON registry. Authenticated read-only routes derive a fresh graph for the exact workspace runtime. Webhook behavior remains unchanged.

## Constraints

- Persist under `$QWEN_HOME/channels/daemon/<workspaceHash>/observed-contacts.json`.
- Record after inbound preflight and before command or Agent handling.
- Record each Envelope once; never record rejected input, bot output, proactive sends, or webhook traffic.
- Return complete IDs and sanitized/fallback labels.
- Top-level `users` contains direct-message users only.
- `groups[].users` and `groups[].topics[].users` are observed relationships, not authoritative membership.
- Default freshness is seven days; accept `freshWithinSeconds` from 1 second through 365 days.
- Keep at most 500 most-recent relationship observations.
- Preserve exact workspace ownership and never fall back on qualified routes.
- Do not change webhook configuration, requests, or delivery.

## Task 1: Base observation contract

**Files:** `packages/channels/base/src/types.ts`, `ChannelBase.ts`, `ChannelBase.test.ts`, `index.ts`

- [x] Add identity, observation, graph, group, topic, and related-user types.
- [x] Add `observedContacts.observe` to `ChannelBaseOptions`.
- [x] Normalize `senderId`, `senderName`, `chatId`, and `threadId` after successful preflight.
- [x] Deduplicate the same Envelope object and keep persistence failures non-blocking.
- [x] Cover direct, group, topic, rejection, pairing, duplicate Envelope, and failure cases.

## Task 2: Workspace relationship store

**Files:** `packages/cli/src/commands/channel/observed-contact-store.ts`, `observed-contact-store.test.ts`, `daemon-worker.ts`, `daemon-worker.test.ts`

- [x] Persist version 1 relationship observations with atomic mode-`0600` writes.
- [x] Deduplicate by channel, user, group, and topic; refresh labels and timestamps.
- [x] Derive direct users separately from group and topic relationships.
- [x] Filter stale observations and expose independent relationship timestamps.
- [x] Enforce validation and the 500-observation bound.
- [x] Wire daemon-managed channels to the workspace-partitioned store.

## Task 3: Authenticated dynamic-observation API

**Files:** `packages/cli/src/serve/routes/workspace-channel-observed-contacts.ts`, its test, `server.ts`, `server.test.ts`, `capabilities.ts`

- [x] Add singular and qualified `/channel/observed-contacts` GET routes.
- [x] Parse `freshWithinSeconds`, default to seven days, and reject invalid values.
- [x] Return `{users, groups}` with nested group/topic users and complete IDs.
- [x] Add `Cache-Control: no-store` and sanitized failure responses.
- [x] Require exact trusted workspace resolution on qualified routes.
- [x] Advertise `workspace_channel_observed_contacts`.
- [x] Run the focused server authentication and capability tests.

## Task 4: Remove prototype webhook integration

**Files:** `ChannelWebhookTask.ts`, `ChannelBase.ts`, channel config parsing/tests, channel overview documentation

- [x] Remove observed-reference webhook config and resolution.
- [x] Restore concrete webhook behavior to `origin/main`.
- [x] Verify webhook production files have no diff from `origin/main`.
- [x] Replace prototype documentation with the observed-contacts API.

## Task 5: Verify and publish

- [x] Run Prettier on changed files.
- [x] Run focused base, CLI store, daemon-worker, route, server, runtime, and webhook tests.
- [x] Run `npm run build && npm run typecheck`.
- [x] Audit the full diff twice, including untracked files.
- [x] Commit, push `feat/channel-observed-targets`, and update Draft PR #7109.
