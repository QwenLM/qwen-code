# Generated UI 持久视图状态

[English](generated-ui-view-state.md) | [简体中文](generated-ui-view-state.zh-CN.md)

状态：提案。第 1 步（存储和 daemon 路由）由加入本文档的 PR 实现；第 2、3 步尚未实现。

## 问题

Generated UI 卡片的状态只存在于运行中的 Worker 里。刷新页面、重开对话或点击 Reset，都会从工具结果里记录的那份不可变文档重新启动一次 activation，清单的条目、勾选状态和撤销历史随之丢失。#14019 的验收评测里，这是唯一一个参考文档和 gating 模型都失败的缺口；在一次 live 试验中，模型还因此放弃了卡片，改写了一个独立的 HTML 页面。

浏览器存储补不上这个缺口：App 沙箱每次挂载都会得到一个新的 `<uuid>.localhost` 源。页面内保留（[generated-ui-retention.zh-CN.md](generated-ui-retention.zh-CN.md)）能让一个活的 activation 在同一页面内跨重新挂载保留下来，但不持久化任何东西。

## 目标与非目标

目标：

- 卡片可以保存一个小的 JSON 值，并在刷新后、重开对话后以及对话的 fork 里读回。
- 状态属于一个会话的某个分支：其他会话永远看不到；回退到某次保存之前，这次保存就不再生效。
- 每次保存都有明确的回执结果，卡片可以据此显示已保存、因过期被拒、过大或未保存。

非目标：

- 模型看不到保存的状态。把对模型可见的部分接入上下文是后续一步（阶梯 L7）。
- 把状态和这一轮的补丁作为一个事务一起保存是后续一步（阶梯 L6b）。
- 普通 MCP App 不使用这套存储；它只服务内置的 Generated UI App。

## 卡片身份

状态以 `cardId` 为键。Generated UI 服务端在构建 `generated_ui_show` 结果时生成这个 id，并写进 `_meta['qwen/generated-ui']`。它不参与 `documentId` 内容哈希。由于它随结果一起记录、原样回放，live 页面和冷回放看到的是同一个 id。

现有的标识都不能当键。`documentId` 是内容哈希，两张相同的卡片会共用它。工具调用 id 在冷回放中可能改变：同一会话里记录的 id 重复时，回放会把后面的改名为 `id:2`、`id:3`，而 live 路径保留原 id。

卡片 id 必须匹配 `^gc_[A-Za-z0-9_-]{16,64}$`。其他 id 在到达 agent 之前就被 daemon 拒绝。

## 存储

每次保存是会话转录里的一条 `generated_ui_state` 系统记录，payload 为 `{ version: 1, cardId, revision, value }`。它作为旁路记录写入：父记录是保存时的活动末端，写入后不移动末端。转录的各个登记表把它当作非对话、中性的记录，所以它不会成为叶子，不会给分支命名，也不会阻断 artifact 旁路记录。

一次保存挂靠的对话记录在活动分支上时，这次保存就属于活动分支；两者之间的非对话记录会被跳过。活动分支上每张卡片最后一次保存的值，就是这张卡片的状态。由此得到：

- **刷新与重开：** 状态从转录里读回，两种情况都能保留。
- **回退：** 回退会放弃锚点之后的记录。挂在被放弃记录上的保存不再生效，更早的保存保留；回退之后的保存挂在回退记录上，也会保留。
- **Fork：** fork 复制活动分支，并像对 artifact 记录那样，让每条旁路记录继续挂在被保留的父记录上，所以 fork 里的卡片从保存的状态开始。被放弃分支上的保存不会被复制。
- **删除消息：** 删除消息不会丢掉活动分支上的保存。父记录被删除时，保存会挂到最近保留的祖先上。如果没有保留的祖先，则挂到剩余对话之前新增的根标记上。保存保持原有顺序。保存不计入消息组快照，所以保存不会让进行中的删除失败。
- **隔离：** 状态存在各自会话的转录里。

保存需要一条可挂靠的对话记录。第一轮之前没有这样的记录，保存会以 `state_unavailable` 被拒绝；反正卡片也不可能在第一轮之前出现。

agent 为每个会话持有一个 `GeneratedUiStateService`。它在首次使用时先 flush，再从转录读取状态并缓存。记录器提供一个分支代号，活动分支被替换时（回退、恢复工具分支、恢复或删除后重建）代号就会改变；服务发现加载时的代号与当前不同就重新加载。记录器在写入时校验代号，包括写入已排队的保存。同一会话的写入串行执行。

回退会恢复保留的值及其原修订号。每次保存变更后的值都使用大于该会话转录中所有已保存修订号的新编号，包括已放弃分支上的修订号。即使重开会话，延迟写入也不会因修订号被复用而覆盖新值。

## 接口约定

两个路由都要求会话绑定的 `X-Qwen-Client-Id`（否则返回 403），以及合法的卡片 id（否则返回 400 `invalid_card_id`）。

`GET /session/:id/generated-ui/state/:cardId` 返回 `{ cardId, revision, value }`。从未保存过的卡片返回 `revision: 0` 和 `value: null`。

`PUT /session/:id/generated-ui/state/:cardId` 接收 `{ baseRevision, value }`。`baseRevision` 是写入方上次读到或保存时的修订号；`value` 可以是任意 JSON 值。结果带有 `outcome`：

| 状态码 | 响应体                                                       | 含义                               |
| ------ | ------------------------------------------------------------ | ---------------------------------- |
| 200    | `{ outcome: 'saved', cardId, revision }`                     | 已保存；`revision` 是新的修订号    |
| 409    | `{ outcome: 'stale', cardId, revision, value }`              | 另一个写入方先保存了；附带当前状态 |
| 413    | `{ outcome: 'too_large', cardId, limitBytes }`               | 序列化后的值超过 16 KiB            |
| 400    | `{ code: 'invalid_state' }` 或 `{ code: 'invalid_card_id' }` | 请求格式错误                       |
| 409    | `{ code: 'state_card_limit' }`                               | 本会话已有 128 张卡片保存过状态    |
| 503    | `{ code: 'state_unavailable' }`                              | 转录无法读取或写入                 |

再次保存当前值时返回 `saved` 和当前修订号，不追加任何记录。转录无法完整读取时，读写都不会退回到空状态，而是报告 `state_unavailable`。

会话持久化可用时，daemon 声明 `generated_ui_state` capability。SDK 提供 `getGeneratedUiState` 和 `setGeneratedUiState`；后者对 `stale` 和 `too_large` 返回结果而不是抛出异常。

### 路由归属

两个路由都属于 live-session-owner 路由。读取使用 `withOwnerReadSession`，因此刚加载的会话也能用；写入使用 `withOwnerMutableSession`，带严格的变更检查和 `cwdBound: 'always'`。bridge 会拒绝未知或正在关闭的会话、待处理的会话重置，并校验客户端 id 已绑定到该会话。未知、不属于自己或归属不明确的会话，按共享的归属路由错误失败，绝不回退到主运行时。与 App 工具调用不同，状态读写不等待会话空闲，也不写对话记录，所以卡片可以在轮次进行中保存。

## 限制

- 单张卡片序列化后的值：16 KiB（UTF-8）。
- 每个会话中保存过状态的卡片数：128。
- 写入频率由 App（第 2 步）限制，它会先合并保存再发送；daemon 不做限流。

## 推进步骤

1. **存储和路由**（本 PR）：转录记录、分支选择、fork 携带、agent 服务和 ext 方法、bridge、daemon 路由、SDK 客户端、capability。
2. **运行时和宿主：** 生成 `cardId`；Worker 的 `init` 消息加入 `state`；增加 `ui.state.get()` / `ui.state.set(value)`（同步，每轮最多一次写入，最后一次为准）；App 在 `init` 之前载入状态，载入失败时显示出来而不是从空状态开始；合并并保存每一轮的状态；在宿主自有的界面上显示保存结果，并带一个验收 harness 能读取的 `data-` 属性；即使被取代的轮次丢弃了补丁，也保存 Worker 的状态。
3. **Skill 和评测：** 在 Generated UI skill 里教模型使用 `ui.state`，不再说卡片不能持久化；更新参考清单文档；有意翻转验收评测中持久化和隔离的固定项；用观测保存结果的方式恢复 `checklist.save-acknowledged` 检查。

## 风险

- **转录增长：** 每次值有变化的保存最多追加 16 KiB。第 2 步必须合并保存；值不变时不追加。
- **降级：** 旧版本不认识这个 subtype，会把它报告为未知记录，并可能把位于末尾的保存当作对话叶子。保存过状态的会话不应先由旧版本恢复、再由新版本恢复。
- **托管会话：** 托管记录接收端不接受这个 subtype，所以托管会话里的保存以 `state_unavailable` 失败；capability 对等表也写明托管模式没有对应能力。
- **并发视图：** 同一张卡片的两个标签页会在 `baseRevision` 上竞争；较慢的一方收到带当前值的 `stale`，需要重新加载或合并。

## 验证

第 1 步：

- 服务测试：从未保存的读取、修订号、过期写入、值不变、大小和卡片数限制、非法输入、无法读取的转录、保存失败后以及分支变化后的重新加载。
- 记录器测试：通过真实的 `ChatRecordingService` 写入，再通过读取方使用的转录预处理读回。空闲末端、轮次进行中、旁路记录之间的保存都能读回；回退会丢弃被放弃的保存，保留回退之后的保存；删除某次保存之前的消息不会丢掉这次保存；没有任何对话时的保存会被拒绝；穿插保存记录时 artifact 选择不变。
- Fork 测试：复制分支上的保存会被携带，被放弃分支上的保存不会；无法读取的转录报告 `unavailable`。
- 路由测试：客户端 id 和卡片 id 检查、请求校验、各结果的状态码和错误映射。SDK 测试：每种写入结果，以及没有结果时的错误。
- daemon 集成测试（无浏览器、无需凭证）：轮次进行中的保存；过期写入；保存之后登记的 artifact 在重新加载后仍能列出；保存是最后一条记录时，会话恢复、再接收一个提示，第二次重新加载后仍能读到状态；另一个会话看不到；未知会话返回 404。通过 daemon 的回退只由记录器测试覆盖。

第 2、3 步补充浏览器层面的覆盖（刷新、重开、两个标签页、两个会话、过大的值、被拒绝的写入）以及验收固定项。

## 验收标准

- replay 中 `checklist.persists-after-reload`、`checklist.persists-after-reopen`、`checklist.isolated-across-sessions` 通过，恢复后的 `checklist.save-acknowledged` 通过；其余固定项不变。
- 使用 gating 模型的 live 运行中，清单用例调用 `generated_ui_show`，持久化和隔离检查通过。
