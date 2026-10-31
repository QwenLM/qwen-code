# Microsoft Teams channel

This package connects Microsoft Teams to a Qwen Code `ChannelAgentBridge`.
It supports commercial-cloud, single-tenant bots, personal messages, explicit
bot mentions in group chats, and channel posts with thread replies. It sends
final plain text, split into ordered UTF-8 chunks. Attachments, Graph history,
cards, national clouds, and scheduled or proactive tasks are outside this release.

## Supported channel-base versions

Use one host-provided copy of `@qwen-code/channel-base`. The peer dependency is
limited to the verified versions below; 0.24.x and 0.25.x are not claimed as
compatible.

| Version  | Supported mode       | Access-control contract                                                                                                                           |
| -------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0.26.1` | Standalone or hosted | Standalone uses `privatePolicy` and explicit `operators`; hosted callers also authorize controls before dispatch.                                 |
| `0.23.0` | Hosted only          | Configure the legacy `senderPolicy` and `dmPolicy`; the host authorizes every control before dispatch. This version does not enforce `operators`. |

Construction without a host fails on the older base because it lacks the lifecycle
guard needed to stop queued standalone turns. Do not install a second newer base
inside this plugin to work around the host's version. Hosted mode uses its awaited
prompt hooks and send guards to revalidate ownership before external effects.

## Standalone extension

Build the workspace package and install this directory as a local Qwen Code
extension. `qwen-extension.json` declares the `msteams` channel provider; no
built-in CLI registry change is required. Use the existing channel configuration
workflow with these provider fields:

| Field          | Meaning                                                                         |
| -------------- | ------------------------------------------------------------------------------- |
| `appId`        | The Microsoft Entra application ID registered with Azure Bot Service            |
| `appPassword`  | The application client secret, supplied through the host's secret configuration |
| `tenantId`     | The one Microsoft tenant admitted by this bot                                   |
| `approvalMode` | Explicit Qwen approval mode, such as `default`                                  |
| `webhookPort`  | Loopback HTTP port, default `3978`                                              |
| `webhookPath`  | Callback path, default `/api/messages`                                          |

Configure the Azure Bot messaging endpoint as the public HTTPS URL forwarded to
this listener. Enable the Microsoft Teams channel on the Azure Bot and install a
Teams app whose bot scopes include `personal`, `groupChat`, and `team`. The bot ID
in the app manifest must equal `appId`. Keep HTTPS termination and request-size
limits at the ingress. Never expose the local listener without authentication;
the plugin always invokes the Microsoft SDK JWT middleware.

Use the standard `privatePolicy`, `groupPolicy`, `groups`, `allowedUsers`, and
`operators` fields to control access. `chat_thread` shares the conversation within
a group or channel post. Actor IDs have the form `msteams:<tenant-id>:<aad-user-id>`;
chat IDs also contain the tenant and an encoded conversation ID. Shared-session
operators are explicitly configured; permitting ordinary group messages does not
grant permission to cancel, clear, or approve. This adapter uses `followup`
queuing so normal messages do not implicitly cancel another user's turn.

The default reference store uses atomic files beneath the channel state directory
with private filesystem permissions. It is intended for **one process**. Input
deduplication is in memory (up to 1,000 events for ten minutes); process restart can
therefore repeat a callback. Standalone mode acknowledges a message after storing
its reply reference and scheduling it in memory. It does **not** guarantee durable
execution, prompt recovery, or delivery after a crash. Use a host for those needs.

## Hosted mode

For an HTTP gateway that only accepts messages, use
`createTeamsIngress(name, credentials, acceptInbound)` from this package. Pass
`appId`, `appPassword` and `tenantId` as credentials; the async callback receives
the authenticated, immutable `TeamsInboundEvent`. The returned object's
`handleWebhook(input)` accepts parsed `headers` and `body` and returns status,
headers and an optional body for the application's POST route to write unchanged.
It needs no channel configuration, approval mode, bridge, router, reference store
or connect/disconnect calls. The host owns the object's lifetime and recreates it
when the channel name or credentials change. The plugin constructs a fresh SDK
request and authenticates it itself, ignoring caller-supplied identities.

Acceptance is awaited before the response. A rejected callback returns 503;
authentication failure returns 401 and normalization rejections return 400.
SDK processing failures return 503. Ignored activities do not invoke the callback;
SDK invoke responses retain
their status, headers and body. The ingress does not queue, deduplicate, execute
or send messages. Persist or consume an event before resolving the callback and
schedule execution separately. Retries and concurrent duplicate callbacks remain
the host's responsibility.

For hosted execution, construct `TeamsChannel` with `TeamsChannelOptions.host`
and a `TeamsReferenceStore`. `connect()` opens no port. Its `handleWebhook()`
uses the same SDK authentication and normalization path as the independent
ingress; gateways need not construct a channel merely to accept messages.

The host contract deliberately has five operations:

1. `acceptInbound(event)` durably stores or consumes a verified event before
   resolving. A rejected promise produces a non-success HTTP response. Do not wait
   for an agent prompt here. This hook runs before Qwen pairing, so a host can
   consume first-time binding commands without prior execution authorization.
2. `beforePrompt(event, sessionId)` rechecks execution authorization and persists
   submission intent. It is awaited immediately before the underlying bridge
   prompt. A host must handle an uncertain submission without automatically
   resubmitting it.
3. `onPromptSettled(event, sessionId, outcome)` persists bridge success or failure.
   This is execution settlement, not delivery success. A host's bridge can also
   persist its native prompt ID when the underlying execution service accepts it.
4. `beforeSend(context)` rechecks authorization immediately before each actual
   platform send. It receives the original event and immutable reply target, text,
   whole reply, chunk index/count, and `response` or `system` kind. Throw to stop
   sending. Sends without an originating event must be explicitly authorized by
   the host, or rejected.
5. `onSendReceipt(receipt)` persists the platform message ID for a confirmed send.
   Failure before a send attempt is `known_failed`; a timeout, missing receipt, or
   receipt persistence failure after the send attempt is `unknown`. The plugin
   does not retry uncertain sends.

After acceptance, the host loads its own stored record, revalidates its ownership
and current binding, and calls `dispatchPersisted(event)`. This is a **trusted
in-process API**, not an HTTP endpoint or a JWT bypass switch. Never populate its
argument from an unauthenticated request. Dispatch each accepted event once; the
host owns durable deduplication, leases, fencing, recovery, and binding generations.
Before every `dispatchPersisted()` or `cancelEvent()` call, the host must authorize
the current actor for that specific action. This includes built-in commands such
as `/cancel`, `/clear`, `/reset`, `/new`, permission responses and commands that
expose shared-session details. `beforePrompt` protects bridge submissions only;
commands can execute without calling it. On base `0.23.0`, an empty `allowedUsers`
list grants shared commands to everyone and `operators` is ignored. Hosts should
consume their supported controls directly and reject other slash commands unless
explicitly authorized. Merely implementing `beforePrompt` is insufficient. Do not
change global allowlists or operators temporarily for individual messages.

Keep the event immutable, including its original reply reference. Reference
storage is keyed by normalized conversation and thread; a later post cannot
redirect an earlier response.

`sendEventText(event, text, kind)` sends binding guidance or recovered final text
through the same per-send guard. Use `kind: 'response'` only for an actual final
agent result. `cancelEvent(sessionId, expectedEventId)` cancels only the matching
active event, using ChannelBase's cancellation state machine. Authorize the actor
in the host first. Dispatch control events promptly rather than placing them
behind an awaited long-running `dispatchPersisted()` call; ChannelBase already
queues ordinary prompts. Do not change the shared `operators` list for individual
messages.

When the host has durable receipts for a consecutive sent prefix, it can call
`sendEventText(event, fullText, kind, { startChunkIndex })` to resume from the first
unsent chunk. Pass the unchanged full text and original event. Guards and receipts
retain the original chunk indexes, total chunk count and full text. The index must
be a nonnegative integer identifying an existing chunk; empty text permits only
zero. Out-of-range values fail before sending. The host decides whether recovery
is safe and never advances past an uncertain send. This option does not add an
automatic retry or deduplicate messages by itself.

Replies are capped at 64 KiB and split into at most 12 KiB plain-text chunks.
Blank or oversized completed prompt results become a short completion notice
through the normal response path, so cancellation and send guards still apply.
`onPromptSettled` receives the original result text. Direct `sendEventText` calls
with oversized replies fail before sending. Ingress JSON is capped at 1 MiB and normalized
message text at 64 KiB. Configure database retention, encryption, capacity, and
rate limits in the host. Do not log input text, secrets, or conversation references.

## Validation boundary

Unit tests cover normalization, immutable target correlation, durable ACK timing,
per-send guards, receipts, prompt hooks, cancellation matching, and file reference
persistence. They do not establish Microsoft tenant installation, real JWT key
retrieval, real Bot Connector delivery, or agent tool execution. Validate those
with a real tenant and the exact installed Qwen version before production use.
