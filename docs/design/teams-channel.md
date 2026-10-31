# Microsoft Teams channel

[English](teams-channel.md) | [简体中文](teams-channel.zh-CN.md)

Status: implemented with automated host-contract validation, 2026-10-27.

## Problem and current state

Qwen Code can load channel plugins through an extension manifest and run them
with either a standalone or daemon bridge. There is no Microsoft Teams adapter
at the implementation baseline `816d04181b`. A reusable adapter should also
work inside an application that owns HTTP ingress, durable processing and
execution identities, without requiring that application to duplicate the
Microsoft protocol implementation.

The initial implementation exposes ingress only through `TeamsChannel`. A
gateway that only accepts events must therefore construct a channel, bridge,
router and execution hooks it never uses. Separate the authenticated HTTP
entrypoint from channel execution, while retaining one SDK processing path.

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
| Teams ingress          | Independent authenticated HTTP entrypoint with one awaited acceptance callback                     |
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

Configure an explicit single SDK connection and route for this bot. A host's
`Connections__*` registry must not replace its audience, tenant or required
issuer validation. Both ingress modes use this isolated configuration.

The plugin owns no application-specific user binding or database schema.
Applications select their own execution identity through the existing bridge
and router. Shared groups use the existing `chat_thread` scope; operators remain
distinct from members allowed to send prompts. No new session-scope enumeration
or inference-core change is required. The current base has an explicit
`operators` configuration whose empty value grants no shared command rights.

## Host contract

`createTeamsIngress(name, credentials, acceptInbound)` returns an object with
`handleWebhook(input)`. `TeamsCredentials` contains only `appId`, `appPassword`
and `tenantId`; the callback receives a `TeamsInboundEvent` and returns
`Promise<void>`. Construction does not start a listener, create a bridge or
router, access a reference store, or require an approval mode. There is no
connect/disconnect lifecycle. The host owns HTTP routing, the ingress object's
lifetime, durable deduplication and subsequent execution. Recreate the object
when its bot credentials or channel name change.

Standalone mode owns a local webhook listener. Hosted execution still uses
`TeamsChannel`; its webhook method and the independent ingress use the same
SDK adapter construction, authentication and normalization implementation.
The independent ingress does not instantiate ChannelBase. A successful HTTP
response waits for the host acceptance callback; a failed durable write must be visible
as a failed request, not a successful ACK. Acceptance does not wait for the
agent's final answer. Binding commands can be consumed by the host before an
ordinary prompt is dispatched.

Both entrypoints enforce the same body limit and authenticate a fresh SDK
request without trusting caller-supplied identity. They preserve SDK invoke
status, headers and response body. Rejected authentication returns 401,
normalization rejections return 400, and acceptance or SDK processing
failure returns 503. Ignored activities do not call the host. The ingress API
does not add queues, deduplication, retries, recovery or application bindings.

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

When a prompt completes with blank text or more than 64 KiB of UTF-8 text,
return a short completion notice through the normal ChannelBase response path.
The host settlement hook still receives the original result. Both standalone
and hosted execution apply this rule; cancellation checks, send guards and
receipts remain in their normal order. The settlement hook must not send this
notice itself, since that would bypass the base's cancellation check. This
handles a known result within its current call, without storing or recovering it.

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

Release versioning advances the extension manifest, current exact channel-base
peer and development dependency together, while retaining the explicitly supported legacy peer. A
release must not install a second base or leave its own base version excluded.

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

The plugin has 51 passing focused unit tests. Independent compiled-artifact
checks passed 18 applicable channel cases on 0.26.1 and 16 hosted channel cases
on 0.23.0, using real
Fastify and Microsoft SDK JWT processing with temporary RSA/JWKS fixtures and
a recorded cloud connector. Consumer type checking and single-base identity
passed; strict checking of third-party declarations has the same pre-existing
ACP SDK diagnostics as a base-only consumer.

The independent ingress passed 12 compiled public-API cases on each supported
base version without constructing a channel, bridge or router. They cover real
SDK JWT validation, host connection-registry isolation, callback completion and
failure, unchanged invoke responses, ignored activities and concurrent calls.
SDK-rejected malformed activities may return 503 before normalization; they
never reach acceptance. Two release-script regression cases pass, including a
prerelease. A separate 0.26.2 release fixture packs the actual plugin and base
outputs, installs them together and verifies that the public ingress loads
with one physical base copy. These checks do not claim real tenant acceptance.

Completed-result and cancellation checks pass 11 cases on 0.26.1 and 8 hosted
cases on 0.23.0. They verify blank and oversized notices, the exact 64 KiB
boundary, raw host settlement, normal send guards and receipts, and no notice
after cancellation during settlement. Revocation prevents delivery, and a
later turn still completes normally.

Validate the current ChannelBase and the host's pinned version separately.
Only change shared interfaces if a contract test establishes a concrete gap.
The E2E plans in `.qwen/e2e-tests/teams-channel.md` and
`.qwen/e2e-tests/teams-minimal-ingress-v4.md` record baseline, commands and
remaining tenant-dependent checks. Feature submission follows the upstream
proposal and review process; local implementation does not imply approval.

## Open verification points

- Real Teams tenant installation, mention activities and reply delivery.
- A reproducible immutable plugin artifact for downstream deployment.
