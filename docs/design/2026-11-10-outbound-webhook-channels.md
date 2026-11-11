# Outbound webhook Channels

[English](2026-11-10-outbound-webhook-channels.md) | [简体中文](2026-11-10-outbound-webhook-channels.zh-CN.md)

## Problem and scope

Issues #16751, #16752 and #16753 propose a lower-setup way to post results to a
group robot. Existing DingTalk application bots require application credentials
and a user or conversation ID. A custom robot instead has a configured group
webhook URL, optionally protected by a signing secret.

The first milestone adds DingTalk webhook Markdown sending and shared Web Shell
configuration and Scheduled Tasks selection. Notify, explicit prompt results
and persistent scheduled results continue to use the existing Channel delivery
path. This design implements a bounded logical destination rather than
introducing a new wire target kind.

Implementation is split into a backend PR for #16752 and a dependent Web PR for
#16753. The Web behavior below describes that dependent change; the backend can
be used directly through configuration and the existing delivery APIs.

## Existing behavior

Delivery accepts `user` or `chat` plus an ID across persistence, daemon, ACP,
worker IPC and SDK. ChannelBase validates ownership and then calls the adapter's
proactive delivery hook. This path does not create an agent session. Management
already supports secret fields, environment references, workspace ownership,
reload and runtime status. Scheduled Tasks already has a Channel selector.

Observed contacts describe inbound observations, with age and capacity limits.
They are not a catalog of permanent destinations. Worker readiness already marks
an adapter connected when its `connect()` succeeds; no socket is required.

## Target and management contract

Add optional `outboundOnly` and `defaultDeliveryTarget` metadata to ChannelPlugin
and the sanitized Channel type catalog. The latter describes a `user` or `chat`
target ID and optional label, without credentials. Metadata is validated before
publication. Existing plugins omit it and keep their current behavior.

Catalog validation checks metadata structure and length and rejects `scheme://`
IDs; it is not a general credential detector. Plugin authors must keep public
IDs and labels credential-free. Otherwise, IDs retain the existing opaque
`user`/`chat` semantics rather than introducing an ASCII-only grammar.

The new `dingtalk-webhook` plugin declares `outboundOnly: true` and the fixed
`chat/default` destination. One named Channel binds one configured endpoint.
Changing its URL changes future deliveries through that named Channel.

The adapter accepts only that exact target and no thread. It rejects arbitrary
IDs, general loop targets and inbound webhook task targets. The ID is a documented
adapter-owned logical address, never a URL and never an observed contact. The
existing authorization tuple remains channel name, type and ID.

Management omits receive-policy and agent-session controls for outbound-only
plugins. Web discovers the default destination from the catalog metadata, not
from a plugin-name convention or a fabricated contact. An older daemon does not
publish this metadata; the existing manual target behavior remains available.
Existing clients can still read the unchanged delivery target shape. Older
daemons may not load the new plugin, but the new task does not introduce an
unknown target kind that makes the entire cron file unreadable.

## DingTalk adapter

Export a separate webhook plugin from the existing DingTalk package. It requires
a secret `webhookUrl` and permits an optional secret `signingSecret`, using the
existing environment-reference and secret-edit mechanisms. Existing application
bot configuration remains unchanged.

Validate the HTTPS DingTalk robot endpoint and required access token. Each send
uses `msgtype: markdown`, derives `markdown.title` with the existing DingTalk
`extractTitle` helper and preserves the supplied body in `markdown.text`. Plain
text is also valid message content. The public Channel delivery contract remains
a text string; no message-format setting or Markdown conversion is introduced.
DingTalk documents a [Markdown subset](https://open.dingtalk.com/document/orgapp/custom-bot-send-message-type).
The adapter preserves table syntax and other Markdown as supplied; rendering is
handled by the DingTalk client. It does not convert tables or promise full
GitHub-flavored Markdown rendering.

When signing is configured, generate a fresh millisecond timestamp and
HMAC-SHA256 signature using the documented DingTalk algorithm. Do not cache a
signed URL. Transport errors, invalid responses, non-success HTTP status and
nonzero business error codes reject with a bounded, sanitized reason in line
with #7521. Never expose the credential URL, signature, secret or message body
through an error. There is no implicit retry.

HTTP 408, 425, 429 and 5xx responses are classified as transient using the
package's shared DingTalk policy. For business responses, the official
[custom robot error table](https://open.dingtalk.com/document/development/custom-robots-send-group-messages)
identifies `-1` as system busy and `410100` as rate limiting; these are transient.
Other business codes remain permanent unless endpoint-specific evidence supports
a different classification. Generic transport failures do not establish whether
delivery was accepted, so their sanitized error retains that uncertainty.

Connect validates local configuration and initializes sending resources; it does
not send a message or authenticate a long connection. Connected means locally
ready to send, not that remote credentials were verified. Requests have a bounded
timeout; disconnect cancels in-flight requests, and shutdown drains them.

The first-phase long-message policy is to keep the existing shared 100,000-length
delivery protection and submit its result as one message. This is a local safety
bound, not a guarantee that DingTalk accepts messages of that size. The adapter
does not truncate again or split messages. If DingTalk rejects an oversized
message, delivery fails with a sanitized error; no shortened copy or automatic
retry is sent. This platform-rejection policy is an explicit first-phase tradeoff.

The official [sending API](https://open.dingtalk.com/document/orgapp/custom-robots-send-group-messages)
and message-type documentation checked on 2026-11-10 do not specify an exact
Markdown size limit or its unit. The platform threshold remains unverified;
establishing it requires authoritative protocol evidence or a recorded real-robot
boundary probe. Local protocol tests and successful live Markdown rendering do
not establish that threshold.

## Web behavior

Group DingTalk application-bot and webhook methods under DingTalk in the platform
entry. Keep backend plugin types distinct. Sending-only editors show endpoint
credentials and lifecycle controls, without receive policies, pairing or agent
session settings. Required URL removal cannot save an invalid configuration.

Selecting a configured destination in Scheduled Tasks fills the declared logical
target without asking for a user/chat ID. Preserve existing manual targets,
unavailable saved targets and create/edit/clear round trips. Do not silently
rewrite a saved unsupported ID to the default. Persistent/per-run restrictions
continue to apply.

Shared components provide the same behavior in qwen serve and
WebShellWithProviders with the relevant navigation and daemon workspace enabled.

## Affected components

| Component                      | Change                                                                         |
| ------------------------------ | ------------------------------------------------------------------------------ |
| Channel base types and exports | Optional management metadata; existing runtime hooks retained                  |
| CLI registry and management    | Register webhook plugin, validate/project metadata, omit inbound-only controls |
| TypeScript SDK catalog         | Mirror optional metadata; delivery wire types unchanged                        |
| DingTalk package               | Webhook adapter, plugin and protocol/lifecycle tests                           |
| Web Shell                      | Platform method choice, editor, configured task target and tests               |
| User and design documentation  | Configuration, logical target, behavior and validation limits                  |

## Alternatives and boundaries

A new ID-less configured kind is semantically direct, but requires coordinated
parser, IPC, authorization, SDK and cron-file changes. Existing readers reject an
unknown kind for the entire task file; a new writer cannot change old readers.
The bounded logical address meets this milestone without that migration cost.

Injecting fake observed contacts would introduce expiry and false observation
semantics. Reusing inbound `targetRef` would mix agent execution into direct
delivery. Neither is part of this design. No second notification router or worker
is introduced.

Feishu and other platform adapters, generic webhook JSON contracts, task lifecycle
events, cards, attachments, durable retries, notification history and per-run
delivery remain outside this milestone. No general-purpose HTTP abstraction is
required before a second adapter demonstrates shared behavior.

## Validation and acceptance

Verify strict target ownership and rejection, Markdown payload/title generation,
body preservation for plain and Markdown content, signature generation,
HTTP-success/business-failure responses, malformed responses, timeout, shutdown
cancellation and error sanitization. Verify catalog compatibility, secret editing,
default selection without contacts, saved target round trips, older-daemon
fallback and workspace-scoped configuration and delivery. Include regression
coverage for existing application-bot and manual user/chat targets.

Build, typecheck, bundle and run focused tests. Run a local HTTP fixture through
the delivery path without model credentials, plus the shared Web Shell browser
flow. Record precisely which transport is simulated. If no test-robot credentials
are available, mark the live platform smoke test pending rather than claiming it
passed. The detailed E2E plan and results live in
`.qwen/e2e-tests/outbound-webhook-channels.md`.
