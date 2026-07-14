# DingTalk Webhook Direct-Message Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 daemon 接收外部 Webhook 后，既能把 Markdown 结果投递到钉钉群聊，也能投递到钉钉单聊。

**Architecture:** 沿用现有 `DingtalkChannel` 和 Webhook 目标结构。adapter 根据 `SessionTarget.isGroup` 在群聊 API 与单聊 API 之间选择 endpoint 和请求体，其他 Token、Markdown 分片、401 重试及错误处理逻辑保持共用。

**Tech Stack:** TypeScript、Vitest、DingTalk OpenAPI、Express daemon Webhook route、curl

## Global Constraints

- 首版只支持 Markdown，不支持原生 Card、Card 回调或流式更新。
- 不新增 channel 类型或配置字段。
- 群聊目标使用 `isGroup: true` 与 `openConversationId`；单聊目标使用 `isGroup: false` 与钉钉用户 ID。
- 目标必须显式设置 `isGroup`，且不支持 `threadId` 和 Webhook URL。
- 保持群聊 endpoint、请求体、Token 缓存、401 单次重试、分片和首个失败即停止的行为不变。
- 不修改或提交用户现有的 `package-lock.json` 改动。

---

### Task 1: 为单聊目标补充失败测试并实现最小投递分支

**Files:**

- Modify: `packages/channels/dingtalk/src/DingtalkAdapter.test.ts`
- Modify: `packages/channels/dingtalk/src/DingtalkAdapter.ts`

**Interfaces:**

- Consumes: `SessionTarget.isGroup`, `SessionTarget.chatId`, `DingtalkChannel.pushProactive()`
- Produces: 群聊调用 `robot/groupMessages/send`，单聊调用 `robot/oToMessages/batchSend`

- [ ] **Step 1: 写单聊目标和请求体失败测试**

在主动投递测试中新增单聊目标：

```ts
const directTarget: SessionTarget = {
  channelName: 'test-dingtalk',
  senderId: 'webhook:github-ci',
  chatId: 'manager-user-id',
  isGroup: false,
};
```

将目标校验断言改为允许群聊和单聊，但继续拒绝缺少 `isGroup`、空 ID、Webhook URL 和 `threadId`。新增单聊请求测试：

```ts
it('sends proactive direct messages through the one-to-one robot API', async () => {
  const channel = proactive(createChannel());
  const { directSendCalls, tokenCalls } = stubProactiveFetch();

  await channel.pushProactive(directTarget, '# Result\nloop output');

  expect(tokenCalls()).toHaveLength(1);
  const sends = directSendCalls();
  expect(sends).toHaveLength(1);
  const init = sends[0]![1] as RequestInit;
  const body = JSON.parse(String(init.body));
  expect(body).toMatchObject({
    robotCode: 'client-id',
    userIds: [directTarget.chatId],
    msgKey: 'sampleMarkdown',
  });
  expect(body.openConversationId).toBeUndefined();
});
```

- [ ] **Step 2: 运行测试并确认因功能缺失而失败**

Run:

```bash
cd packages/channels/dingtalk && npx vitest run src/DingtalkAdapter.test.ts
```

Expected: 单聊目标断言或单聊发送测试失败，因为当前实现只接受 `isGroup: true`，且只调用群消息 API。

- [ ] **Step 3: 实现最小单聊分支**

在 adapter 中加入单聊 endpoint：

```ts
const DIRECT_MSG_API =
  'https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend';
```

目标校验必须要求 `isGroup` 是布尔值、`threadId` 未设置、`chatId` 是稳定 ID：

```ts
return (
  typeof target.isGroup === 'boolean' &&
  target.threadId === undefined &&
  this.isConversationId(target.chatId)
);
```

把完整 `SessionTarget` 传给分片发送方法，并仅在该方法中选择 endpoint 和目标字段：

```ts
const targetBody = target.isGroup
  ? { openConversationId: target.chatId }
  : { userIds: [target.chatId] };

resp = await fetch(target.isGroup ? GROUP_MSG_API : DIRECT_MSG_API, {
  method: 'POST',
  headers: {
    'x-acs-dingtalk-access-token': token,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    robotCode: this.config.clientId!,
    ...targetBody,
    msgKey: GROUP_MSG_KEY,
    msgParam: JSON.stringify({ title, text }),
  }),
  signal: AbortSignal.timeout(PROACTIVE_FETCH_TIMEOUT_MS),
});
```

- [ ] **Step 4: 运行钉钉单测并确认通过**

Run:

```bash
cd packages/channels/dingtalk && npx vitest run src/DingtalkAdapter.test.ts
```

Expected: 全部测试通过，群聊原有断言与新增单聊断言同时为绿色。

### Task 2: 更新用户文档和本地 E2E 测试说明

**Files:**

- Modify: `docs/users/features/channels/overview.md`
- Modify: `docs/users/features/channels/dingtalk.md`
- Create: `.qwen/e2e-tests/2026-07-14-dingtalk-webhook-direct-message.md`

**Interfaces:**

- Consumes: 现有 `webhooks.sources.<source>.targets.<targetRef>` 配置
- Produces: 可复制的单聊/群聊配置和 `curl` 验证步骤

- [ ] **Step 1: 文档化两种目标配置**

在 Webhook 示例中保留群聊目标并加入单聊目标：

```json
"targets": {
  "operator": {
    "chatId": "DINGTALK_USER_ID",
    "senderId": "webhook:github-ci",
    "isGroup": false
  },
  "team": {
    "chatId": "OPEN_CONVERSATION_ID",
    "senderId": "webhook:github-ci",
    "isGroup": true
  }
}
```

明确说明单聊 `chatId` 是钉钉用户 ID，群聊 `chatId` 是 `openConversationId`，二者都必须显式设置 `isGroup`。

- [ ] **Step 2: 写直接 curl 的 E2E 计划**

E2E 计划应使用隔离的 `HOME` 和真实凭据启动本地 daemon，然后分别执行：

```bash
curl -i -X POST 'http://127.0.0.1:4170/channels/dingtalk-main/webhooks/manual-test' \
  -H "x-qwen-webhook-secret: $QWEN_CHANNEL_DINGTALK_TEST_SECRET" \
  -H 'Content-Type: application/json' \
  -d '{"eventType":"manual_test","targetRef":"operator","title":"DingTalk DM self-test","payload":{"source":"curl"}}'
```

以及将 `targetRef` 改为 `team` 的群聊兼容性请求。预期 HTTP 均返回 `202 {"accepted":true}`，worker 日志显示任务完成，钉钉目标收到 Markdown。

### Task 3: 完整验证和自审

**Files:**

- Verify: `packages/channels/dingtalk/src/DingtalkAdapter.ts`
- Verify: `packages/channels/dingtalk/src/DingtalkAdapter.test.ts`
- Verify: `docs/users/features/channels/overview.md`
- Verify: `docs/users/features/channels/dingtalk.md`

**Interfaces:**

- Consumes: Task 1 与 Task 2 的实现和文档
- Produces: 可提交的本地实现与验证证据

- [ ] **Step 1: 运行定向单测、构建和类型检查**

Run:

```bash
cd packages/channels/dingtalk && npx vitest run src/DingtalkAdapter.test.ts
cd /Users/ben/workspace/qwen-code && npm run build && npm run typecheck
```

Expected: 所有命令退出码为 0。

- [ ] **Step 2: 使用真实凭据执行 curl 验证**

从隔离配置启动 `qwen serve --channel dingtalk-main`，对单聊和群聊 `targetRef` 各执行一次 curl。记录 HTTP 状态、daemon/worker 日志和钉钉实际收件结果；若缺少某个目标 ID，明确标记对应在线步骤未验证。

- [ ] **Step 3: 自审完整 diff**

Run:

```bash
git diff --check
git diff -- packages/channels/dingtalk/src/DingtalkAdapter.ts packages/channels/dingtalk/src/DingtalkAdapter.test.ts docs/users/features/channels/overview.md docs/users/features/channels/dingtalk.md docs/plans/2026-07-14-dingtalk-webhook-direct-message.md
git status --short
```

Expected: 无空白错误，diff 仅包含本功能文件，`package-lock.json` 保持为未暂存的用户改动。
