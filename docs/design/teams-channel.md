# Microsoft Teams channel

[English](teams-channel.md) | [简体中文](teams-channel.zh-CN.md)

Status: implementation and host-contract validation, 2026-10-26.

## Problem and current state

Qwen Code can load channel plugins through an extension manifest and run them
with either a standalone or daemon bridge. There is no Microsoft Teams adapter
at the implementation baseline `816d04181b`. A reusable adapter should also
work inside an application that owns HTTP ingress, durable processing and
execution identities, without requiring that application to duplicate the
Microsoft protocol implementation.

## Scope

Support private text messages, explicit bot mentions in group chats and team
channels, thread-correct replies and bounded text chunks. Start with a single
Microsoft commercial-cloud tenant per bot. Graph history, attachments, cards,
scheduled messages, shared channels and cross-tenant chats are out of scope.
Real tenant installation and successful delivery remain separate acceptance
steps from automated protocol tests.

## Components

| Component              | Responsibility                                                                                     |
| ---------------------- | -------------------------------------------------------------------------------------------------- |
| Microsoft SDK adapter  | Authentication, incoming activity handling and proactive text delivery                             |
| Activity normalization | Trusted actor, canonical conversation, root thread, mention and reply target                       |
| TeamsChannel           | Existing ChannelBase routing, bridge execution, commands and final text output                     |
| Reference store        | Replaceable conversation-reference persistence with a local standalone implementation              |
| Host hooks             | Awaited acceptance before ACK, trusted persisted dispatch, admission and guarded delivery receipts |
| Extension manifest     | Install the same plugin without changing the built-in provider registry                            |

Use the Microsoft SDK's authentication rather than implementing JWT validation.
Check the configured tenant and intended bot before accepting message content.
AAD object IDs, scoped by tenant, identify actors; display names never identify
an execution principal. Canonicalize a channel conversation separately from its
thread suffix. Keep the original SDK reference for its specific reply target.
Ignore non-mention group messages and bot self-messages.

The plugin owns no application-specific user binding or database schema.
Applications select their own execution identity through the existing bridge
and router. Shared groups use the existing `chat_thread` scope; operators remain
distinct from members allowed to send prompts. No new session-scope enumeration
or inference-core change is required. The current base has an explicit
`operators` configuration whose empty value grants no shared command rights.

## Host contract

Standalone mode owns a local webhook listener. Hosted mode exposes the same
authenticated handler without opening a listener. A successful HTTP response
waits for the host acceptance callback; a failed durable write must be visible
as a failed request, not a successful ACK. Acceptance does not wait for the
agent's final answer. Binding commands can be consumed by the host before an
ordinary prompt is dispatched.

Only trusted application code can dispatch a persisted event. There is no HTTP
parameter to skip authentication. This event retains immutable source, actor
and destination facts so the host can check the original configuration and
binding generation again. Every actual outgoing chunk passes a host guard and
reports the platform receipt. A later message must not replace the destination
or identity associated with an earlier running turn. Guard rejection prevents
the external send. Ambiguous send errors do not trigger blind retries.

The plugin awaits `beforePrompt` before bridge submission and
`onPromptSettled` before completing the bridge call. Actual delivery text is
fixed by `beforeSend.fullText`, which can include the base's source label.
A host may resume a known-unsent suffix with `sendEventText`'s
`startChunkIndex`; original chunk indices and full text remain unchanged.

Only prompts use the existing session queue. A cancellation must be admitted
while its target prompt is still running. Host persistence must not introduce
a second queue that waits for an entire `handleInbound` call before admitting
control messages. A host can enforce stricter command permissions without
changing the plugin's ordinary standalone behavior.

## Persistence and failure boundaries

The default reference store is for one local process. It does not claim a
distributed lease, durable execution queue or exactly-once delivery. Hosts
replace storage and acceptance when they need restart recovery and fencing.
Persisted references alone do not prove that an agent result can be recovered.
Hosts must distinguish an unsubmitted event, a known prompt, and an uncertain
submission, and must not re-execute tools merely because a response was lost.

## Files and packaging

Add `packages/channels/msteams/`, its extension manifest, tests and README, plus
the existing root workspace declarations and lockfile. Keep protocol code in
that package and depend on ChannelAgentBridge. Do not add a database driver or
an application gateway dependency. The package name and official inclusion
remain subject to maintainer review. An immutable package artifact is required
before an external host can treat it as a deployable dependency.

## Validation

Automated checks cover SDK authentication rejection, tenant/bot validation,
mentions, canonical conversations, separate threads, duplicate events, awaited
acceptance and failures, host replay, response correlation, guarded chunks,
shutdown and a cancellation while a long prompt runs. The host-contract suite
uses a real local HTTP listener and the SDK where possible; mocked Microsoft
delivery is labelled as such and is not evidence of real Teams delivery.

The validated peer versions are exactly 0.23.0 and 0.26.1. Version 0.23.0 is
hosted-only: the host must authorize every control before dispatch. It lacks
the current shared-session operators and queued-stop guard, so standalone
construction fails explicitly. Version 0.26.1 supports both modes. Intermediate
versions are not declared compatible. The plugin uses the host's single base
instance through a peer dependency.

The plugin has 30 focused unit tests. Independent compiled-artifact checks
passed 18 applicable cases on 0.26.1 and 16 hosted cases on 0.23.0, using real
Fastify and Microsoft SDK JWT processing with temporary RSA/JWKS fixtures and
a recorded cloud connector. Consumer type checking and single-base identity
passed; strict checking of third-party declarations has the same pre-existing
ACP SDK diagnostics as a base-only consumer.

Validate the current ChannelBase and the host's pinned version separately.
Only change shared interfaces if a contract test establishes a concrete gap.
The E2E plan in `.qwen/e2e-tests/teams-channel.md` records baseline, commands and
remaining tenant-dependent checks. Feature submission follows the upstream
proposal and review process; local implementation does not imply approval.

## Open verification points

- Real Teams tenant installation, mention activities and reply delivery.
- A reproducible immutable plugin artifact for downstream deployment.
