# Channels 设计

[English](channels-design.md) | [简体中文](channels-design.zh-CN.md)

> Qwen Code 的外部消息集成——通过 Telegram、微信等平台与 agent 交互。
>
> 用户文档：[Channels 概览](../../users/features/channels/overview.md)。

## 概览

**Channel** 将外部消息平台连接到 Qwen Code agent。它在 `settings.json` 中配置，通过 `qwen channel` 子命令管理，并支持多用户（每位用户都有隔离的 ACP 会话）。

## 架构

```
┌──────────┐                        ┌─────────────────────────────────────┐
│ Telegram │    Platform API        │        Channel Service              │
│ User A   │◄──────────────────────►│                                     │
├──────────┤  (WebSocket/polling)   │  ┌───────────┐    ┌──────────────┐  │
│ WeChat   │◄──────────────────────►│  │ Platform   │    │  ACP Bridge  │  │
│ User B   │                        │  │ Adapter    │    │  (shared)    │  │
└──────────┘                        │  │            │    │              │  │
                                    │  │ - connect  │    │  - spawns    │  │
                                    │  │ - receive  │    │    qwen-code │  │
                                    │  │ - send     │    │  - manages   │  │
                                    │  │            │    │    sessions  │  │
                                    │  └─────┬──────┘    └──────┬───────┘  │
                                    │        │                  │          │
                                    │        ▼                  ▼          │
                                    │  ┌─────────────────────────────────┐ │
                                    │  │  SenderGate · GroupGate         │ │
                                    │  │  SessionRouter · ChannelBase    │ │
                                    │  └─────────────────────────────────┘ │
                                    └─────────────────────────────────────┘
                                                     │
                                                     │ stdio (ACP ndjson)
                                                     ▼
                                    ┌─────────────────────────────────────┐
                                    │        qwen-code --acp              │
                                    │   Session A (user alice, id: "abc") │
                                    │   Session B (user bob,   id: "def") │
                                    └─────────────────────────────────────┘
```

**平台适配器**——连接外部 API，并在平台消息与 Envelope 之间转换。**ACP Bridge**——启动 `qwen-code --acp`、管理会话，并发出 `textChunk`/`toolCall`/`disconnected` 事件。**Session Router**——通过带命名空间的键（`<channel>:<sender>`）将发送者映射到 ACP 会话。**Sender Gate** / **Group Gate**——访问控制（白名单 / 配对 / 开放）和 mention 门控。**Channel Base**——采用模板方法模式的抽象基类；插件覆写 `connect`、`sendMessage`、`disconnect`。**Channel Registry**——带冲突检测的 `Map<string, ChannelPlugin>`。

### Envelope

所有平台都会转换为以下规范化消息格式：

- **身份**：`senderId`、`senderName`、`chatId`、`channelName`
- **内容**：`text`，可选 `imageBase64`/`imageMimeType`、`referencedText`
- **上下文**：`isGroup`、`isMentioned`、`isReplyToBot`，可选 `threadId`

插件职责：`senderId` 必须稳定且唯一；`chatId` 必须能区分私聊和群聊；布尔标志必须准确，以供门控逻辑使用；`text` 是唯一一份适配器规范化消息，同时用于行首锚定的本地控制、确定性 channel-memory 短语、memory 相关性评分和 agent prompt。mention 的规范化由平台决定；系统不会另建隐藏的去 mention 控制文本或召回投影。保留开头的 mention 会使斜杠命令、直接 `!` 执行和完全锚定的 memory 短语无法在消息行首匹配；但群聊 / 共享会话的安全门仍会拒绝“保留 mention 后紧跟 `!`”的形态，且不会提取或执行命令。全文分类器和相关性评分器也会看到该 mention，因此结果可能与不带 mention 的文本不同。

### 消息流

```
入站：用户消息 → Adapter → GroupGate → SenderGate → Slash commands → SessionRouter → AcpBridge → Agent
出站：Agent 响应 → AcpBridge → SessionRouter → Adapter → 用户
```

斜杠命令（`/clear`、`/help`、`/status`）在到达 agent 之前由 ChannelBase 处理。

### 会话

一个 `qwen-code --acp` 进程承载多个 ACP 会话。每个 channel 的作用域可为：**`user`**（默认）、**`thread`** 或 **`single`**。路由键使用 `<channelName>:<key>` 命名空间。

### 错误处理

- **连接失败**——记录日志；只要至少有一个 channel 连接成功，服务就继续运行
- **Bridge 崩溃**——指数退避（最多重试 3 次），在所有 channel 上调用 `setBridge()`，并恢复会话
- **会话串行化**——每个会话使用独立的 Promise 链，防止并发 prompt 冲突

## 插件系统

该架构可扩展——可以在不修改核心代码的情况下添加新适配器（包括第三方适配器）。内置 channel 使用相同的插件接口（dogfooding）。

### 插件契约

`ChannelPlugin` 声明 `channelType`、`displayName`、`requiredConfigFields` 和 `createChannel()` 工厂。插件实现三个方法：

| 方法                        | 职责                     |
| --------------------------- | ------------------------ |
| `connect()`                 | 连接平台并注册消息处理器 |
| `sendMessage(chatId, text)` | 格式化并发送 agent 响应  |
| `disconnect()`              | 关闭时清理资源           |

收到入站消息后，插件构建 `Envelope` 并调用 `this.handleInbound(envelope)`——基类负责其余工作：访问控制、群聊门控、配对、会话路由、prompt 串行化、斜杠命令、指令注入、引用上下文和崩溃恢复。

### 扩展点

- 通过 `registerCommand()` 注册自定义斜杠命令
- 包装 `handleInbound()` 以显示输入状态或 reaction 等工作指示器
- 通过 `onToolCall()` 接入工具调用 hook
- 在调用 `handleInbound()` 前向 Envelope 附加媒体

### 发现与加载

外部插件是由 `ExtensionManager` 管理的 **extension**，并在 `qwen-extension.json` 中声明：

```json
{
  "name": "my-channel-extension",
  "version": "1.0.0",
  "channels": {
    "my-platform": {
      "entry": "dist/index.js",
      "displayName": "My Platform Channel"
    }
  }
}
```

执行 `qwen channel start` 时的加载顺序：读取 settings → 注册内置插件 → 扫描 extension → 动态导入并校验 → 注册（拒绝冲突）→ 校验配置 → `createChannel()` → `connect()`。

插件在进程内运行（无沙箱），信任模型与 npm 依赖相同。

## 配置

```jsonc
{
  "channels": {
    "my-telegram": {
      "type": "telegram",
      "token": "$TELEGRAM_BOT_TOKEN", // 环境变量引用
      "senderPolicy": "allowlist", // allowlist | pairing | open
      "allowedUsers": ["123456"],
      "sessionScope": "user", // user | thread | single
      "cwd": "/path/to/project",
      "model": "qwen3.5-plus",
      "instructions": "Keep responses short.",
      "groupPolicy": "disabled", // disabled | allowlist | open
      "dmPolicy": "open", // open | disabled
      "groups": { "*": { "requireMention": true } },
    },
  },
}
```

认证方式由插件决定：静态 token（Telegram）、应用凭据（DingTalk）、扫码登录（微信）、代理 token（TMCP）。

## CLI 命令

```bash
# Channels
qwen channel start [name]                     # 启动全部或指定 channel
qwen channel stop                             # 停止运行中的服务
qwen channel status                           # 显示 channel、会话与运行时长
qwen channel pairing list <ch>                # 列出待处理的配对请求
qwen channel pairing approve <ch> <code>      # 批准配对请求

# Extensions
qwen extensions install <path-or-package>     # 安装
qwen extensions link <local-path>             # 为开发创建符号链接
qwen extensions list                          # 列出已安装 extension
qwen extensions remove <name>                 # 卸载
```

## 包结构

```
packages/channels/
├── base/                    # @qwen-code/channel-base
│   └── src/
│       ├── AcpBridge.ts     # ACP 进程生命周期与会话管理
│       ├── SessionRouter.ts # 发送者 ↔ 会话映射与持久化
│       ├── SenderGate.ts    # 白名单 / 配对 / 开放
│       ├── GroupGate.ts     # 群聊策略与 mention 门控
│       ├── PairingStore.ts  # 配对码生成与批准
│       ├── ChannelBase.ts   # 抽象基类：路由与斜杠命令
│       └── types.ts         # Envelope、ChannelConfig 等
├── telegram/                # @qwen-code/channel-telegram
├── weixin/                  # @qwen-code/channel-weixin
└── dingtalk/                # @qwen-code/channel-dingtalk
```

## 后续工作

### 安全与群聊

- **按群限制工具**——通过每个群的 `tools`/`toolsBySender` deny/allow 列表限制工具
- **群聊上下文历史**——保存最近跳过消息的环形缓冲区，并在 @mention 时添加到 prompt 前
- **正则 mention 模式**——针对不可靠的 @mention 元数据提供 `mentionPatterns` 回退
- **按群指令**——在 `GroupConfig` 中提供 `instructions` 字段，以配置每个群的角色
- **`/activation` 命令**——运行时切换 `requireMention` 并持久化到磁盘

### 运维工具

- **`qwen channel doctor`**——配置、环境变量、bot token 与网络检查
- **`qwen channel status --probe`**——检查各 channel 的真实连通性

### 平台扩展

- **Discord**——Bot API + Gateway，支持服务器/channel/私聊/thread
- **Slack**——Bolt SDK、Socket Mode、workspace/channel/私聊/thread

### 多 Agent

- **多 agent 路由**——为每个 channel/群/用户绑定多个 agent
- **广播群**——多个 agent 响应同一条消息

### 插件生态

- **社区插件模板**——`create-qwen-channel` 脚手架工具
- **插件注册表/发现**——`qwen extensions search` 与版本兼容性
