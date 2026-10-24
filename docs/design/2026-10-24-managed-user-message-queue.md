# Managed user message queue

[English](2026-10-24-managed-user-message-queue.md) | [简体中文](2026-10-24-managed-user-message-queue.zh-CN.md)

## Problem

Managed Turn admission rejects a second active Turn. Browser pending input is an admission retry, not a durable queue. Users need to add guidance during execution without interrupting tools.

## Behavior

Accept text and existing file references, at most 32 outstanding messages per Session. Preserve FIFO and separate message identities. Allow versioned edit/withdraw only before claim. Consume before model requests after complete tool results and before final settlement. Do not bypass approval. Normal completion carries remaining messages into one follow-up Turn. Stop/failure pauses work until explicit resume. Images remain idle-only.

## Ownership and recovery

The Java control plane persists queue admission and dispatch. The original fenced Harness writes consumed user history through the Managed journal. Admission is not consumption. Reconcile uncertain delivery against original durable evidence, never replay on another Runtime. Queue consumption and user history evidence must be atomic. Recovered requests use their original snapshots before newer guidance. Context and file references retain their admission binding. Closing terminates queued work.

## Interfaces

Public routes use `/v1/agents/sessions/{sessionId}/user-messages`; the WebShell adapter uses `/user-messages/query` and `/user-messages/command` under its existing prefix. The command action is submit, edit, withdraw or resume. Writes persist an actor-scoped idempotency receipt and return its outcome snapshot; clients query the current snapshot after mutations. Queue admission/edit/withdraw and pause state refresh through a non-overlapping one-second poll. Consumed inputs also appear in the existing durable Session event stream and transcript.

Session-scoped user-message submit/query/edit/withdraw/resume operations use existing authentication and idempotency conventions. Expose an explicit capability. The browser renders the server snapshot. Public OpenAPI and generated WebShell types evolve together. Existing Turn submission semantics remain unchanged.

## Validation

See `.qwen/e2e-tests/managed-user-message-queue.md`. Cover FIFO, hooks, tool/approval boundaries, capacity, permissions, lifecycle, lost replies, restarts and writer takeover. SQL concurrency requires MySQL evidence; fixture tests do not establish real-provider acceptance.

## Status

Implementation added locally. TypeScript verification and a bundled Harness capability smoke are recorded in the E2E report. Java/MySQL concurrency, interrupted-Turn recovery and real-provider acceptance remain pending. A consumed user record alone does not prove a model completed processing it; an unprovable interrupted delivery remains blocked. No production or full fault-matrix acceptance is claimed.
