# 回放投影水位

[English](replay-projection-watermark.md) | [简体中文](replay-projection-watermark.zh-CN.md)

## 问题与范围

full Load 读取会话事件总线保留的事件，无法撤销事件进入总线之前发生的 summary
投影。被过滤的事件不消耗事件 ID，因此两个快照可能游标相同、来源历史不同。
缓存回放在 seed 时重新分配 ID，也会隐藏原来的投影边界。序列化或保留准备失败
导致的发布拒绝，目前同样不会将快照标记为 degraded。

本变更新增来源投影观测元数据，不实现历史拼接、不承诺完整回放、不改变事件 ID，
不增加路由或功能开关，也不改变 full/summary 投影本身。

## 契约

`replayProjectionWatermark` 是可选的非负事件 ID 边界 W，属于响应的 `eventEpoch`。
对于 full 内存回放快照，它与回放数组和 `lastEventId` C 同步取得。缺失表示响应
不提供这项观测，消费者不能以零代替。零表示边界位于首个已发布事件之前，不表示
从未使用过 summary 模式。

| 操作                                | 边界更新                                |
| ----------------------------------- | --------------------------------------- |
| summary 模式成功发布 ID 为 N 的事件 | W = max(W, N)，即使这条事件本身未被修改 |
| summary 过滤事件、不分配 ID         | W = max(W, nextId - 1)                  |
| seed 回放                           | W 推进到本批最后一个新分配的 ID         |
| 切换到 full 或重置保留的回放        | 保留 W                                  |
| 新总线 epoch                        | 从零开始；seed 的事件仍推进新边界       |

所有 seed 均保守视为来源未验证，包括完整持久化历史，因为通用事件总线没有来源
证明。因此，旧 seed 用户组不能仅因取得较大的新 ID 就被认定未经投影；之后新增的
full 用户组可以越过边界。空 seed 不改变边界。

消费者在考虑使用后缀之前，可以要求完整用户组的首个原生事件 ID 严格大于 W。
这只排除后缀内的发布期 summary 投影及未验证 seed。消费者仍须校验完整用户组、
持久化历史边界、epoch、partial/degraded 标记、截断及内容降级标记。可用命令
快照和正常的工具、文本压缩保持原有语义；此字段不证明原始事件逐项保真。

序列化或保留准备失败会设置既有的持久 `replayDegraded` 状态，不消耗 ID、不抛出
异常。既有诊断回调继续 best effort，首次降级只调用一次。关闭后的总线继续正常
忽略发布。

## 传递与兼容

总线仅在 full 快照中返回 W。原生 Load 将捕获的值与对应数组、epoch 一起返回。
summary 读取省略此字段；再次读取 full 不会清除此前的来源投影。成功的有界持久化
分页刷新也省略该字段，因为其事件不是带有原生 ID 的总线快照。刷新稳定性检查
除 epoch、游标外还比较 W，因此异步读取期间推进 W 的过滤会导致重试或回退。
W 不是活动计数器：当 W 已等于 C 时，再次过滤事件不会改变这两个边界。
不返回回放数组的 Resume 不提供此快照观测。

TypeScript REST 类型和 `DaemonSessionClient` 保留这项可选 Load 元数据，包括
零值。既有调用方、Web Shell 渲染、SSE 归属、权限处理及游标行为不变。REST 路由
和 standalone 恢复已直接转发 bridge 结果；Java SDK 保留原始 JSON，没有专门的
回放字段模型。

## 实现边界

- `packages/acp-bridge/src/eventBus.ts`：边界、原子快照与降级。
- `packages/acp-bridge/src/session-control-plane.ts` 和 `bridgeTypes.ts`：Load
  传递、summary 省略和刷新稳定性。
- TypeScript daemon 响应类型与会话客户端：保留观测值。
- 同目录总线、bridge、SDK 测试，以及本双语设计。

不修改应用专用适配或私有下游仓库。字段描述 C 时刻的快照，不承诺未来的写入方
继续以 full 模式发布。

## 验证与验收

实现前，使用真实事件总线和 compactor 的确定性脚本已证明：干净快照与过滤后的
快照相同，序列化拒绝未被标记，投影内容重新 seed 后仍无标记。已安装 CLI 与
源码脚本的基线在本地 E2E 计划中分别记录。

测试覆盖零值与字段缺失、summary 成功发布、游标不变的过滤、下一个 full 用户
边界、full/reset 保持水位、同 epoch 和新 epoch seed、序列化及保留准备拒绝、
full 和 summary Load，以及仅 W 改变的刷新竞态。SDK 测试验证 workspace 与
standalone Load 工厂保留零值和缺失状态。根 build、typecheck、bundle、包级
定向测试和独立确定性验证须通过。不声称真实模型或下游应用验收通过。

## 状态与开放问题

实现候选。统一保守处理所有 seed 是有意的决定，本变更不提供可信 seed 绕过。
未来若需要更强的完整性契约，必须独立提供来源证明并评审。
