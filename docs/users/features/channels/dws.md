# DingTalk Workspace (DWS)

The DWS channel uses a locally authenticated DingTalk Workspace CLI account. It can receive direct messages and group messages, watch comments on selected DingTalk documents, recursively discover documents in selected knowledge bases, and publish the agent's final response back to the originating message or comment.

This is separate from the [DingTalk bot channel](./dingtalk). Keep using `type: "dingtalk"` for a dedicated DingTalk application bot; use `type: "dws"` when Qwen Code should act as a signed-in DWS user.

## Prerequisites

Install DWS CLI 1.0.57 or newer on the host that runs Qwen Code, and make sure `dws` resolves from that process's `PATH`:

```bash
dws version --format json
```

Authenticate the account on the same host:

```bash
dws auth login
dws profile list --format json
dws auth status --format json
```

On a headless server, use the device flow:

```bash
dws auth login --device
```

DWS stores and refreshes the login independently of Qwen Code. A DWS channel pins exactly one `corpId:userId` account when it starts. Set `profile` to the entry's `profile` value when present, or combine its `corpId` and `userId` as `corpId:userId`. Omit it to pin the one entry marked `isCurrent`. Comma-separated or ambiguous selectors are rejected.

## Configuration

Add a channel to `~/.qwen/settings.json`:

```json
{
  "channels": {
    "dws-work": {
      "type": "dws",
      "profile": "corp-id:user-id",
      "senderPolicy": "pairing",
      "groupPolicy": "pairing",
      "pairingMaxPending": 50,
      "groups": {
        "*": { "requireMention": true }
      },
      "documentIds": ["document-id"],
      "wikiSpaceIds": ["knowledge-base-id"],
      "documents": {
        "*": { "requireMention": true },
        "document-id": { "requireMention": false }
      },
      "pollInterval": 60000,
      "wikiDiscoveryInterval": 300000,
      "sessionScope": "chat_thread",
      "cwd": "/path/to/your/project"
    }
  }
}
```

`senderPolicy` and `groupPolicy` default to `pairing` for a newly managed DWS channel. Approve a user or group with the code returned by the channel:

```bash
qwen channel pairing approve dws-work CODE
```

The default pending-pairing limit is 50. Set `pairingMaxPending` to another positive integer when needed.

## Message Access

`senderPolicy` controls direct-message senders, document-comment authors, and
senders in `open` or `allowlist` groups:

- `pairing` requires unknown users to be approved.
- `allowlist` accepts only `allowedUsers`.
- `open` accepts any user visible to the authenticated DWS account.

`groupPolicy` controls group conversations independently:

- `pairing` requires each group to be approved.
- `allowlist` accepts group IDs present in `groups`.
- `open` accepts any group visible to the authenticated account.
- `disabled` rejects group traffic.

An approved `pairing` group follows the shared channel behavior: group approval
authorizes its members, so `senderPolicy` is not checked again for that group.
For `open` and `allowlist` groups, both the group and sender policies must pass.

`groups` controls mention behavior. A concrete group ID overrides `"*"`. With `requireMention: true`, only an @ message wakes the channel. With `requireMention: false`, ordinary messages are also received after the group and sender policies pass. In `allowlist` mode, list every permitted group ID explicitly; the wildcard supplies defaults but does not add all groups to the allowlist.

## Document Comments and Knowledge Bases

`documentIds` selects individual documents. `wikiSpaceIds` accepts knowledge-base IDs or standard DingTalk knowledge-base URLs and recursively discovers supported documents. Discovery refreshes while the channel runs, so documents added later are watched automatically. Existing comments are baselined on the first scan; a comment added to a newly discovered document is treated as new work.

`documents` controls comment triggers only within the selected documents and knowledge bases. It does not add new documents to the watch scope. A concrete document ID overrides `"*"`:

- `requireMention: true` requires the comment to mention the authenticated DWS user.
- `requireMention: false` accepts an ordinary new comment after `senderPolicy` passes.
- The configured `trigger` prefix, `/qwen` by default, is always an explicit trigger.

Document-triggered sessions force `approvalMode` to `default` when omitted and reject unattended approval modes. `pollInterval` must be at least 5000 milliseconds. `wikiDiscoveryInterval` defaults to 300000 milliseconds; `0` discovers on every poll.

The Web channel editor preserves `documents`, but it does not render this nested map yet. Edit that field directly in `settings.json`.

## Starting the Channel

Run it as a standalone channel:

```bash
qwen channel start dws-work
```

Or let `qwen serve` own it:

```bash
qwen serve --workspace /path/to/your/project --channel dws-work
```

Do not run both forms at once. They share the channel-service lease, so stop the existing `qwen channel start` process before starting daemon-managed channels.

If `dws` is not on the daemon's `PATH`, set an absolute `dwsPath`. Normally this option should be omitted.

## Local Verification

1. Start the channel and confirm it reports that the DWS channel is running.
2. Send a direct message from a different DingTalk account. In pairing mode, approve the returned code, then send another message and verify the final reply.
3. In an approved group, @ the authenticated DWS user. If that group has `requireMention: false`, also verify an ordinary message.
4. Add a comment that @mentions the authenticated user in a watched document and verify the response appears under the same root comment.
5. Add a document to a watched knowledge base, then add a new matching comment and verify it is discovered without restarting the channel.

The channel ignores events authored by its own authenticated identity to prevent reply and pairing loops.
