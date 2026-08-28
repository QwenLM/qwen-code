# DingTalk Workspace (DWS)

The DWS channel uses an account already authenticated by the DingTalk Workspace CLI. It receives direct and group messages, recognizes DingTalk document-mention notification cards, and publishes the agent's response back to the originating message or document comment.

This is separate from the [DingTalk bot channel](./dingtalk). Keep using `type: "dingtalk"` for a dedicated application bot; use `type: "dws"` when Qwen Code should act through an existing DWS login.

## Prerequisites

Install DWS CLI 1.0.57 or newer on the host that runs Qwen Code, and ensure `dws` resolves from that process's `PATH`:

```bash
dws version --format json
```

Authenticate on the same host:

```bash
dws auth login
dws profile list --format json
dws auth status --format json
```

On a headless server, use `dws auth login --device`. A channel pins exactly one existing profile at startup. Set `profile` to an exact profile name or corpId, or omit it to pin the entry marked `isCurrent`. The channel treats every DWS login the same and does not depend on `user_id` metadata.

## Configuration

Add a channel to `~/.qwen/settings.json`:

```json
{
  "channels": {
    "dws-work": {
      "type": "dws",
      "profile": "profile-name-or-corp-id",
      "senderPolicy": "pairing",
      "groupPolicy": "pairing",
      "watchTodos": true,
      "groups": {
        "*": { "requireMention": true }
      },
      "sessionScope": "chat_thread",
      "cwd": "/path/to/your/project"
    }
  }
}
```

YOLO approval mode is available for answer bots that should run tool calls
without interactive confirmations:

```json
{
  "channels": {
    "dws-answers": {
      "type": "dws",
      "senderPolicy": "pairing",
      "groupPolicy": "pairing",
      "approvalMode": "yolo",
      "cwd": "/path/to/answer-bot"
    }
  }
}
```

YOLO mode auto-approves every tool call. Use it only for a trusted bot account
and workspace.

`senderPolicy` and `groupPolicy` default to `pairing` for a newly managed DWS channel. Approve a user or group with the code returned by the channel:

```bash
qwen channel pairing approve dws-work CODE
```

`senderPolicy` controls direct-message senders, document-notification authors, native-todo creators, and senders in `open` or `allowlist` groups. `groupPolicy` controls group conversations. An approved pairing group follows the shared channel behavior and authorizes its members; open and allowlist groups must also pass `senderPolicy`.

`groups` controls mention behavior. A concrete group ID overrides `"*"`. With `requireMention: true`, only an @ message wakes the channel. With `requireMention: false`, ordinary messages are also received after the group and sender policies pass.

Group mentions use the real-time personal event stream first. The channel also checks recent `@` message history every five seconds, so mentions from external groups are recovered when DingTalk omits them from the personal event stream. Messages are deduplicated by conversation and message ID across both paths.

Ordinary direct messages are recovered the same way: a five-second history check re-drives any direct message the real-time stream omitted, deduplicated by conversation and message ID across both paths.

When a message quotes another DingTalk message, the quoted text is included as reply context for the agent on both the real-time and history fallback paths.

## Document Mentions

There is no document or knowledge-base watch list. To start a document task:

1. Add a DingTalk document comment that @mentions the authenticated account.
2. Enable the option that sends a DingTalk notification to that account.
3. DWS delivers the notification card through the account's direct-message history.

The channel extracts the document ID, comment key, and request from that notification. It reads the referenced document for context, adds DingTalk's `暗中观察` eyes reaction while the task runs, and replies to the original document comment. The real-time DWS event stream is used when it contains the card; a five-second incremental history check covers cards omitted by the current event stream.

Comments that do not generate a notification are ignored by design. Duplicate notification messages for the same document comment execute only once. Document tasks follow `senderPolicy` and support `approvalMode` `default`, `plan`, or `yolo`; `default` is used when omitted.

## Native Todo Changes

Set `watchTodos: true` to poll the selected DWS profile's pending native todos where the account is an executor. The option defaults to `false` so adding a DWS channel never executes existing todos implicitly.

The first successful scan establishes a baseline and does not start historical todos. Later scans run a task when a todo is newly assigned, reopened, or its actionable fields change, including its title, priority, deadline, or assignees. The final response is added as a comment on the originating todo. Comment-only metadata and modification timestamps are excluded from change detection so the channel's own response cannot trigger a loop. Completion or removal drops the todo from the pending set; reopening it creates a new trigger.

Native todos follow `senderPolicy` using the todo creator identity. Under `pairing`, the channel adds one pairing-code comment and keeps the todo pending; after the creator is approved locally, a later poll can process the unchanged todo. Polling runs every 30 seconds and remains scoped to the pinned profile's current organization.

## Starting and Verifying

Run the channel directly:

```bash
qwen channel start dws-work
```

Or let the daemon own it:

```bash
qwen serve --workspace /path/to/your/project --channel dws-work
```

Do not run both forms at once because they share the channel-service lease.

For local verification, send a direct message from another account, approve pairing if required, and verify the eyes reaction appears while the task runs. Then add a document comment with @mention notification enabled. The channel should react to the notification message, read the document, and post the final answer under the original comment. A comment with notification disabled should produce no task.

The channel ignores events from sender IDs that DWS identifies as the authenticated account, preventing reply and pairing loops without inferring identity from message text. Starting the IM sources requires that authoritative self-identity: if the authenticated account exposes no openDingTalkId and no earlier session under the same profile recorded one, the channel refuses to connect. A reconnect that temporarily loses the ID keeps filtering on the previously recorded self sender IDs.
