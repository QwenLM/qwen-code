# Feishu observed-contact label enrichment

## Goal

Populate Feishu observed-contact labels with the sender name and group name
without delaying inbound message processing. Keep the current ID labels when
lookup is unavailable.

## Design

`ChannelBase` continues to persist the ID-based observation immediately after
inbound preflight succeeds. It then invokes a synchronous, protected
post-observation hook. The default hook does nothing and its return value is
not awaited, so other channel implementations are unchanged.

`FeishuChannel` overrides the hook and starts background lookups for IDs that
have not been attempted during the current channel instance lifetime:

- `POST /open-apis/contact/v3/users/basic_batch` resolves the sender name.
- `GET /open-apis/im/v1/chats/:chat_id` resolves the group name.

User and group lookups have separate process-local caches. Concurrent requests
for the same ID share one promise. A successful name is reused on later
envelopes; a failed attempt is retained until the daemon restarts. Lookup HTTP,
API, parsing, and timeout failures produce no log output.

When either lookup succeeds, Feishu writes a second observation through the
existing `ChannelBase` persistence method. The observation has the same
channel, user, group, and topic IDs, so `ObservedChannelContactStore` replaces
the ID labels without requiring a storage-format change. An unsuccessful
lookup leaves the first ID-based observation intact.

## Ordering and access control

Enrichment starts only after the existing inbound preflight and initial
observation succeed. Duplicate events, empty messages rejected by the adapter,
and messages rejected by sender or group policy do not trigger lookups. The
background lookup is not awaited by `handleInbound` or the agent prompt path.

## Permissions

Sender-name enrichment uses the least-privilege
`contact:user.basic_profile:readonly` scope. Group-name enrichment uses
`im:chat:readonly`. IDs remain application-scoped, so cross-application IDs and
external users may remain unresolved.

## Testing

Channel-base tests verify that the post-observation hook runs after preflight
and is not awaited. Feishu adapter tests verify successful enrichment,
process-local de-duplication, cached labels on later envelopes, and silent
failure while the original ID-based observation and inbound processing remain
available.
