# Daemon Scheduled Channel Delivery E2E

## Scope

This E2E covers the minimal daemon-owned contract:

```json
{
  "kind": "channel",
  "channelName": "e2e-dingtalk",
  "target": { "type": "chat", "id": "<chat-id>" }
}
```

`target.type` is either `chat` or `user`. The target is explicit and is not
admitted through the observed-contact graph. Topic/thread targets, mentions,
the Web Shell picker, and standalone `qwen channel start` behavior are outside
this change.

## Real DingTalk result — 2026-07-19 (Asia/Shanghai)

An isolated `QWEN_HOME` and runtime directory were used. `qwen serve` started
one daemon-managed `e2e-dingtalk` worker for the repository workspace. The
daemon advertised `scheduled_task_channel_delivery`, the worker connected over
DingTalk Stream mode, and the temporary configuration was deleted after the
run.

### Chat target

- Task: `ngh4wqzr`
- Delivery: `ngh4wqzr:1784391780000`
- Marker: `QWEN-SCHED-E2E-20260719-0023-CHAT`
- Target type: `chat`
- Result: `delivered`, `attempts=1`

The one-shot task fired at its scheduled minute, disappeared from the task
list, produced only the requested final marker, persisted that marker in the
workspace outbox, and received a successful DingTalk group-send acknowledgement.

### User target

- Task: `dz1vu8i2`
- Delivery: `dz1vu8i2:1784391900000`
- Marker: `QWEN-SCHED-E2E-20260719-0025-USER`
- Target: `{ "type": "user", "id": "406850" }`
- Result: `delivered`, `attempts=1`

The direct send used the stable DingTalk staff ID, not the inbound conversation
ID. The adapter accepted the platform response only after checking that the
recipient was absent from DingTalk's invalid and rate-limited user lists.

## Verified boundaries

- The daemon owns the timer, task store, final-answer capture, outbox, retries,
  and Channel Worker dispatch.
- The task's immutable workspace owns both its outbox and its Channel Worker;
  a later session `/cd` cannot move delivery to another workspace.
- Omitting `delivery` preserves the existing scheduled-task behavior.
- Only a clean, non-empty terminal model answer is enqueued. Thoughts, tool
  output, interrupted turns, errors, and Todo Stop Guard drafts are excluded.
- Delivery retries reuse the persisted final answer and do not rerun the Agent.
- Outbox directories/files use owner-only POSIX permissions.
- Standalone loop target validation and Feishu direct proactive mapping remain
  unchanged; daemon delivery uses dedicated validation/mapping hooks.

## Automated regression evidence

- Core scheduler/task/outbox: 194 tests passed.
- ChannelBase: 495 tests passed.
- DingTalk: 72 tests passed; Feishu: 76; WeCom: 135; Telegram: 15.
- Session final-answer capture: 368 tests passed.
- Focused CLI scheduled-delivery routes/IPC/worker/controller: 177 tests passed.
- CLI daemon/worker/server regression group: 1,104 tests passed.
- CLI typecheck and serve fast-path bundle closure check passed.
