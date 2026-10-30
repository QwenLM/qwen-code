# Managed 增量消息投影

[English](managed-incremental-message-projection.md)

## 问题

当前 `ManagedSessionsPage` 每次事件列表变化都会从完整的 Managed 会话事件
重新构建所有展示消息。实时会话每追加一个事件都要重新折叠保留的历史，尽管
事件合并路径已经能够区分严格递增的追加和快照、重叠输入。

## 当前状态

`managedEventsToMessages(events, truncatedLabel)` 是 Managed WebShell 及其测试
使用的无状态投影 API。`mergeManagedEvents` 返回新的排序去重数组，并针对严格
递增的新尾部提供快速追加路径。投影折叠包含 Turn 边界、迟到的工具结果、运行
时失败、取消和权威结果版本等行为，这些行为必须保持不变。

## 目标

- 保留现有无状态 API 及其逐事件折叠语义。
- 增加由页面持有的 projector，只折叠已证明属于追加链的新后缀。
- 保证返回的消息快照不会被 projector 后续状态修改。
- 当事件链、截断标签或保留快照无法继续证明兼容时完整重建。

## 范围边界

本次修改仅限于：

- `packages/web-shell/client/components/managed/managed-session-messages.ts`
- `packages/web-shell/client/components/managed/ManagedSessionsPage.tsx`
- 现有 `managed-session-messages.test.ts` 的回归覆盖
- 本英文和中文设计文档

本次不增加包依赖、公开 wire 字段、配置、服务端行为或 Core 行为。存储压缩
与配额策略、action 扫描以及坏行处理仍属于 #13184 的独立后续工作。

## 方案

`mergeManagedEvents` 通过模块内的 `WeakMap` 为每个返回数组记录一个不透明的
epoch token。严格递增追加（包括空 incoming 的复制）只允许第一个子数组沿用
当前 epoch。父数组的元数据会被这个子数组消费，因此同一个父数组的第二个兄弟
追加会获得新的 epoch 并重建，不会复用第一个分支。快照、重叠、替换、排序和旧页
前置等路径生成新的 epoch。元数据只保存 token，不保存前一个数组或事件祖先链。

新增的 `createManagedMessageProjector()` 持有与无状态函数相同的折叠状态。它
比较输入数组的 epoch、已经处理的事件数量和 `truncatedLabel`。三者匹配时只
折叠新的后缀；任何不匹配都会基于完整事件列表重新构建。折叠逻辑保留在一个
内部 helper 中，使无状态 API 与 projector 不会出现语义分叉。

每次返回都是消息快照：消息对象浅拷贝，`tool_group` 中的每个 tool 也浅拷贝。
嵌套 payload 可以共享，因为折叠过程是替换字段，而不是原地修改这些嵌套值。

`ManagedSessionsPage` 按 provider/session 对创建一个 projector，并根据 projector、
当前 detail 事件和翻译后的截断标签对结果做 memo。每次无关的 render 不会重新调用
projector，也不会重新创建 projector。

## 设计决策与理由

### 使用 epoch，而不是比较边界

首尾事件 ID、数组长度或单个边界对象的 identity 都不能证明快照保留了原前缀。
快照可能保留相同的首尾 ID、复用最后一个事件对象，却替换中间或前缀，随后再
追加新事件。epoch 传播会把这种替换视为新链并强制完整重建。消费父 token 还会让
兄弟追加分支彼此独立：只有第一个子数组可以继承父数组的 epoch。

### 只保留一份折叠实现

现有折叠逻辑移动到一个小的追加 helper 后面。无状态 API 创建新状态并处理全部
事件；页面 projector 在重建时处理全部事件，在确认追加时只处理后缀。这样会保留
跨 Turn 边界、迟到的 `tool_result_updated`、`runtime_failed` 与取消 booking、
以及权威投影版本的特殊处理。

### 有界的快照拷贝

复制顶层消息和 tool group 中的 tools，可以防止后续追加改变已经返回的 assistant
或 tool 快照。通用的 copy-on-write 框架不会为本折叠逻辑使用的其他字段提供额外
保护，反而会增加复杂度。

## 约束与风险

完整的历史事件仍保存在 WebShell 状态中。建立有效追加链后，projector 只折叠
新增事件，但仍保留现有的逐事件扫描成本：boundary 事件可能通过 `settle` 和
`stopStreaming` 扫描当前消息，终结事件可能遍历当前 tools，每次返回还要复制当前
展示消息和 tools 的快照。因此，包含 `k` 个这类事件的批次仍可能因为当前消息和
工具状态 `M` 而产生 `O(k*M)` 成本，另加快照复制成本；不能将其理解为
`O(k+M)` 或整体 `O(1)` 的保证。本改动也不解决存储增长问题。

epoch map 是进程内元数据。没有经过合并 helper 的原始数组无法证明追加来源，
因此会按设计重建。翻译后的截断标签变化也会触发重建，以保证此前显示的截断文本
正确。

## 验证计划

保留现有无状态投影测试，并增加针对以下行为的集中覆盖：

1. 严格递增追加只读取新事件 payload；
2. 后续追加不会修改此前的 assistant 和 tool 结果快照；
3. 替换、重叠、旧页前置以及替换后追加都会失效并重建；
4. 截断标签变化的结果与全新的无状态投影一致。

WebShell 包现有测试和类型检查命令仍是最终验证门槛，本实现 worktree 中尚未执行。

## 验收标准

- `managedEventsToMessages` 对所有现有 fixture 保持当前输出。
- 只有 merge epoch、已处理长度和标签都匹配时，projector 才折叠后缀。
- 父数组的追加 epoch 最多只能被一个子数组继承；兄弟分支会独立重建。
- 快照、重叠、替换、旧页前置和标签变化都会重建，并与无状态结果一致。
- 后续追加后，先前返回的 assistant 和 tool 消息保持不变。
- 页面为每个 provider/session 对持有稳定 projector。
- 页面根据事件列表和翻译后的标签对 projector 输出做 memo。
- 不引入服务端、Core、wire、配置、依赖或其他 #13184 行为变化。

## 开放问题

item 5 没有开放问题。事件保留压缩与配额、action 扫描和坏行策略需要独立的设计
与验收决定。
