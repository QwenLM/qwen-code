# Daemon Scheduled Channel Delivery Design

## Summary

Daemon-managed scheduled tasks may optionally deliver a successful final Agent
answer through a Channel owned by the same workspace. Delivery is explicit,
durable, and code-driven: the Agent produces the answer, while the daemon and
Channel adapter select the destination and perform the send.

The public target contract supports exactly two destination kinds:

- `user`: a platform-native user identifier for a direct message.
- `chat`: a platform-native conversation identifier for a group or room.

Topics and user mentions are out of scope. A task without `delivery` keeps the
existing scheduling and result behavior unchanged.

## Goals

- Let a daemon scheduled task optionally send its successful final answer to a
  specific Channel user or chat.
- Keep task execution, outbox storage, and Channel Worker routing isolated by
  workspace.
- Use a clear, structurally validated target contract instead of overloading a
  `chatId` field with user identifiers.
- Keep destination discovery optional. Observed contacts may populate a picker,
  but are not an authorization requirement for task creation or update.
- Persist delivery work so a transient Channel failure does not rerun the Agent.
- Preserve all behavior for tasks that omit `delivery`.

## Non-goals

- Topic or thread delivery.
- Mentioning a user inside a group message.
- Cross-workspace delivery. A task in workspace B cannot use a Channel Worker
  owned by workspace A.
- Adding a Channel destination picker to Web Shell in this change.
- Extending ordinary CLI `/loop` syntax.
- Changing the standalone `qwen channel start` loop scheduler.
- Using an LLM prompt or tool call to decide whether or where to send.

## API contract

The optional scheduled-task field is:

```ts
interface CronTaskDelivery {
  kind: 'channel';
  channelName: string;
  target: ChannelDeliveryTarget;
}

type ChannelDeliveryTarget =
  | { type: 'user'; id: string }
  | { type: 'chat'; id: string };
```

`channelName` identifies a Channel configured for the task's workspace.
`target.id` is platform-native and its meaning is fixed by `target.type`:

- `user`: DingTalk `userId`, Feishu `open_id`, WeCom `userid`, Telegram user
  numeric ID, or the equivalent identity accepted by another adapter.
- `chat`: DingTalk `openConversationId`, Feishu `chat_id`, WeCom `chatid`,
  Telegram group numeric ID, or the equivalent conversation identity accepted
  by another adapter.

The daemon does not translate identities between Channel providers.

### Chat delivery example

```json
{
  "name": "daily inspection",
  "cron": "0 9 * * *",
  "prompt": "Inspect the service and summarize any problems.",
  "recurring": true,
  "enabled": true,
  "delivery": {
    "kind": "channel",
    "channelName": "dingtalk",
    "target": {
      "type": "chat",
      "id": "cid_xxx"
    }
  }
}
```

### User delivery example

```json
{
  "name": "personal inspection",
  "cron": "0 9 * * *",
  "prompt": "Inspect the service and summarize any problems.",
  "recurring": true,
  "enabled": true,
  "delivery": {
    "kind": "channel",
    "channelName": "dingtalk",
    "target": {
      "type": "user",
      "id": "user_xxx"
    }
  }
}
```

Both the primary scheduled-task routes and the workspace-qualified routes use
this contract. The selected task workspace continues to come from the route:

- Primary: `POST /scheduled-tasks`
- Explicit workspace: `POST /workspaces/:workspace/scheduled-tasks`

Create and update perform structural validation only. They do not require the
target to be present in the observed-contact graph. An empty ID, unknown target
type, topic/thread field, or obsolete `isGroup` shape is rejected as an invalid
delivery request.

## Workspace ownership

Scheduled delivery inherits the scheduled task's workspace; the request does
not carry a second workspace selector.

For a task stored in workspace B:

1. Agent execution uses workspace B's scheduled-task runtime.
2. The delivery record is written to workspace B's outbox.
3. The daemon dispatcher passes workspace B to the Channel Worker manager.
4. The manager selects only a workspace B worker that owns `channelName`.
5. A same-named worker in workspace A is not eligible.

Global or user-scope settings are configuration sources, not daemon-global
Channel ownership. Existing Channel workspace resolution rules decide which
workspace owns the worker. Ambiguous global configuration remains an explicit
Channel startup/configuration error.

## Runtime data flow

```text
workspace scheduler fires task prompt
  -> Agent runs normally and produces finalAnswer
  -> Session checks successful completion and optional delivery
  -> Session appends target + finalAnswer to workspace outbox
  -> daemon dispatcher claims pending outbox record
  -> Channel Worker manager routes by task workspace + channelName
  -> workspace Channel Worker calls deliverProactive(target, text)
  -> adapter maps user/chat target to the platform API
  -> dispatcher records delivered, retryable, or failed
```

The destination is never injected into the Agent prompt. The Agent cannot
silently change it, and a prompt-injection response cannot redirect delivery.

The durable delivery identity is derived from the task ID and fire timestamp so
the same scheduled fire cannot enqueue conflicting duplicate work. Delivery
failure never reruns the Agent; only the persisted final answer is retried.

## Adapter boundary

The public task contract keeps `channelName` beside `target`. The dispatcher
and IPC request preserve those fields separately. After the Channel Worker
selects the named adapter, it constructs the internal proactive target:

```ts
type ChannelProactiveTarget = ChannelDeliveryTarget & {
  channelName: string;
};
```

`ChannelBase` validates that the selected adapter owns this `channelName`, then
delegates the typed `id` to the adapter. This is an internal transport boundary,
not a second public task representation.

Each proactive adapter maps the target explicitly:

| Adapter  | `user`                                  | `chat`                                 |
| -------- | --------------------------------------- | -------------------------------------- |
| DingTalk | direct-message API `userIds`            | group-message API `openConversationId` |
| Feishu   | message API with a user receive-ID type | message API with `chat_id`             |
| WeCom    | SDK send target `userid`                | SDK send target `chatid`               |
| Telegram | private chat user ID                    | group chat ID                          |

An adapter that cannot deliver a supported contract target rejects it as a
permanent invalid-target error. It must not reinterpret a `user` ID as a chat
ID or report success without sending.

## Failure behavior

- Invalid contract or adapter-unsupported target: permanent delivery failure.
- Missing, stopped, or temporarily unhealthy workspace Channel Worker:
  retryable delivery failure.
- Platform timeout, rate limit, or transient API error: retryable delivery
  failure, subject to the dispatcher's bounded exponential backoff.
- Platform rejection of the ID or credentials: classified by the adapter;
  permanent errors stop retrying, transient errors retry.
- Outbox persistence failure: the task run remains complete, the failure is
  logged, and the Agent is not rerun.

Delivery status is independent of the scheduled Agent run status. A successful
Agent run can therefore have a failed post-run delivery.

## Compatibility and scope trimming

- A task with no `delivery` does not write to the outbox and does not require a
  running Channel Worker.
- Existing task CRUD, run history, catch-up, recurring, and one-shot semantics
  remain unchanged.
- The earlier draft-only `chatId`/`threadId`/`isGroup` delivery shape is not a
  released public contract and is replaced rather than retained as a second
  representation.
- Existing observed-contact storage and read APIs remain available for future
  discovery UI, but scheduled-task mutation no longer depends on graph
  freshness or membership.
- Web Shell destination UI already added on the feature branch is removed from
  this minimal change and can be proposed separately against the final API.

## Verification

The implementation plan must cover:

1. Core serialization and validation for both target variants, including
   rejection of empty IDs, unknown types, topic fields, and obsolete shapes.
2. Primary and workspace-qualified REST create/update/list behavior without an
   observed-contact admission provider.
3. No-delivery compatibility: no outbox record and no Channel dependency.
4. Successful Agent final-answer enqueue, durable delivery identity, and no
   enqueue on abort, Agent error, or empty final answer.
5. Dispatcher delivered/retry/permanent-failure behavior without rerunning the
   task.
6. Exact workspace routing, including rejection when only another workspace
   owns the selected Channel.
7. Adapter unit tests for `user` and `chat` mapping on each adapter that claims
   proactive support.
8. Real DingTalk daemon E2E for one group and one direct user, because DingTalk
   is the currently exercised production path.
9. Fast-path bundle and existing scheduled-task regression checks so the daemon
   delivery implementation does not load heavyweight runtime modules into
   unrelated CLI startup paths.
