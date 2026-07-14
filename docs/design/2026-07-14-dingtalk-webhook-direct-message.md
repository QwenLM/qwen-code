# 钉钉 Webhook 单聊投递设计

## 状态

已实现并完成单聊真实链路验证。对应 Issue：
[QwenLM/qwen-code#6883](https://github.com/QwenLM/qwen-code/issues/6883)。

## 背景

由 daemon 托管的 channel 可以接收经过鉴权的外部 Webhook 事件，以无人值守任务的方式运行 agent，并将最终结果主动投递到预先配置的聊天目标。目前钉钉只支持投递到群聊：目标必须设置 `isGroup: true`，adapter 通过群消息 API 发送 Markdown。

这使得 CI 系统、监控告警等 Webhook 来源无法直接通知某个负责的钉钉用户，只能投递到群聊。

## 目标

- 将 daemon Webhook 任务结果投递到钉钉单聊目标。
- 保持现有钉钉群聊 Webhook 投递行为不变。
- 复用现有的目标配置结构、Token 缓存、Markdown 格式化、消息分片、重试和投递错误处理。
- 实现范围限定在现有钉钉 adapter 内，不新增 channel。

## 非目标

- 钉钉原生 Card 或 Card 回调。
- Card 流式更新、按钮、反馈或从钉钉取消任务。
- 单个目标配置多个接收人。
- 钉钉话题投递。
- 新增 channel 类型或修改 daemon Webhook 协议。

## 目标配置

无需新增配置字段。现有 Webhook 目标字段在钉钉 channel 中的含义如下：

| `isGroup` | `chatId` 含义                 | 投递 API                      |
| --------- | ----------------------------- | ----------------------------- |
| `true`    | 钉钉群聊 `openConversationId` | `robot/groupMessages/send`    |
| `false`   | 钉钉用户 ID                   | `robot/oToMessages/batchSend` |

`senderId` 仍然是用于将 Webhook 任务路由到 agent session 的虚拟身份，不是钉钉接收人 ID。

配置示例：

```json
{
  "webhooks": {
    "sources": {
      "github-ci": {
        "secretEnv": "QWEN_CHANNEL_GITHUB_CI_SECRET",
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
      }
    }
  }
}
```

目标必须显式设置 `isGroup`。以下目标继续被 adapter 拒绝：`chatId` 为空、设置了 `threadId`、缺少 `isGroup`，或者使用 Webhook URL 代替稳定的目标 ID。

## 投递链路

daemon 路由、worker IPC 和共享 channel runtime 均保持不变：

```text
POST /channels/:channelName/webhooks/:source
  -> daemon 对事件进行鉴权和校验
  -> channel worker 运行无人值守 agent 任务
  -> ChannelBase 调用 DingtalkChannel.pushProactive()
  -> adapter 根据 target.isGroup 选择钉钉 API
  -> 钉钉接收 Markdown
```

群聊目标继续使用现有请求体：

```json
{
  "robotCode": "CLIENT_ID",
  "openConversationId": "OPEN_CONVERSATION_ID",
  "msgKey": "sampleMarkdown",
  "msgParam": "{...}"
}
```

单聊目标通过一对一消息 API 发送相同的 Markdown 模板：

```json
{
  "robotCode": "CLIENT_ID",
  "userIds": ["DINGTALK_USER_ID"],
  "msgKey": "sampleMarkdown",
  "msgParam": "{...}"
}
```

两条路径共用现有的 access token 缓存，在 Token 到期前一分钟刷新；遇到 HTTP 401 时重试一次；同时使用相同的 Markdown 规范化和分片限制。多分片投递在首个分片失败后停止。

## 错误处理

- 无效目标在 agent 运行前即无法通过 Webhook 任务校验。
- 获取 Token 失败仍作为投递失败处理，并在不暴露凭据的前提下记录日志。
- HTTP 401 会清除缓存的 Token，并对当前分片重试一次。
- 其他非成功 HTTP 响应会中止投递，并在 channel worker 日志中输出脱敏后的 API 错误详情。
- daemon 返回 `202 {"accepted": true}` 仍然只表示 worker 已接收任务，不代表钉钉投递成功。

本期范围内仅支持 Markdown，因此无需设计 Markdown 降级策略。

## 测试

### 单元测试

- 接受显式配置的群聊和单聊主动投递目标。
- 拒绝缺少 `isGroup`、ID 为空、使用 Webhook URL 和设置 `threadId` 的目标。
- 保持现有群聊 endpoint 和包含 `openConversationId` 的请求体不变。
- 单聊使用一对一消息 endpoint 和包含 `userIds` 的请求体。
- 群聊和单聊发送共用缓存的 Token。
- HTTP 401 后刷新 Token，并仅重试一次。
- 单聊投递同样遵循消息分片和首个失败即中止的规则。

### 本地端到端验证

在 `.qwen/e2e-tests/` 下编写测试计划，并先使用全局安装的 `qwen` CLI，记录当前单聊 Webhook 目标被拒绝的基线行为。实现完成后：

1. 分别配置一个单聊目标和一个群聊目标。
2. 启用钉钉 channel 并启动 `qwen serve`。
3. 使用 `curl` 分别向两个 `targetRef` 提交一条事件。
4. 确认两个请求均返回 `202`。
5. 确认 channel worker 完成两个任务。
6. 确认目标钉钉用户和群聊都收到预期的 Markdown 消息。

如果本地没有可用的钉钉凭据或接收目标，则以单元测试作为自动化投递验证，并明确说明缺少的在线验证步骤。

## 文档

更新 channel Webhook 文档，展示钉钉单聊和群聊两种目标配置，并说明单聊目标的 `chatId` 填写钉钉用户 ID。

## 兼容性

本次为增量变更。现有群聊目标的配置、校验、endpoint、请求体、格式化和重试行为均不变，无需迁移配置。
