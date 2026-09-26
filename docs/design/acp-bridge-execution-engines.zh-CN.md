# ACP Bridge 执行引擎

[English](./acp-bridge-execution-engines.md) | [简体中文](./acp-bridge-execution-engines.zh-CN.md)

## 状态

#12380 的 Stage B Bridge 切片实施方案，基于上游 `790bd83c2b`。本切片提供
显式启用的 Bridge 构造 API。普通 serve factory 和 Hosted 模型/工具闭环另行接线。

## 问题与当前行为

Bridge 目前持有一个可复用 ACP channel 和一个启动 promise。Session 已保存自己的
channel 与 connection，但回调通过共享 ID 表查找 Session 时，尚未始终核对发送通道。
加入第二个引擎必须保留共享准入、ID 占用、回放与物理清理，不能复制会话控制面。

## 范围

在同一 Bridge 中支持 Legacy/Managed 通道、固定会话归属、引擎回执、按通道隔离的
回调和完整生命周期记账。保持现有 `channelFactory` 调用方兼容。

本变更不实现 Managed Harness、不写 owner 记录、不选择兼容部署配置、不接线普通
serve factory、不改变公共 REST API，也不实现 Stage G 接管。Managed 分支暂不可用。
工作区控制与预热仍使用 Legacy 通道。

## 方案

### 构造与归属契约

`executionEngines` 包含 `legacy`、`managed` factory 和服务端 `select` 回调，
与 `channelFactory` 互斥。选择器收到已验证的 spawn/load/resume 请求快照，包含
canonical workspace 和已确认的 standalone 用途，只能返回 `legacy` 或 `managed`。
客户端 metadata 不能覆盖选择。

先进行共享容量和 ID 占用，将操作登记到 shutdown 可见的在途集合，再执行选择。
冷 load/resume 要求调用方选择器读取已验证的持久 owner；历史含糊或不可读必须拒绝。
热 attach 使用已有 entry，不重新调用选择器。

配对通道要求实际 ACP new/load/resume 响应携带
`_meta['qwen.session.executionEngine']`，且匹配所选引擎。该 key 与冻结设计和参考
实现一致。Host 必须先持久化或验证归属，再返回回执，并且该过程要早于初始化副作用。
回执是受信 host 的声明，不代表 Bridge 自己验证过文件持久化。普通单 factory API
不要求此回执。

Owner 持久化留在包外。#12693 正在引入 reader/writer 基础；最小依赖以及
`session_execution_engine` 与 `managed_session_header_v1` 的关系仍需在 issue
中对齐。本切片不新建格式，也不要求整个 Stage G 完成。生产启用需要完成 host 接线。

### 通道与准入

保留唯一的 `byId`、默认 attach entry、ID 占用表、准入预算、runtime epoch 来源和
物理通道集合。按引擎划分可复用通道与启动 promise，同引擎合并启动，不同引擎可独立
启动。正在退出的代数持续记账到物理退出。通道隔离只阻止该引擎的新会话。

空闲定时器归实际通道所有。恢复操作绑定通道及最终结算时都重新检查空闲通道，包括
选择器尚未绑定归属期间已触发并消耗定时器的通道。无关的空闲通道不应等待所选引擎的
恢复 RPC 或清理结束。重新检查只补缺失的定时器，不延长另一通道已有的空闲期限。
旧代迟到的退出不能取消另一通道的定时器。
运行时操作占用仅保护所属引擎的通道；工作区活动与停止检查仍汇总两个引擎的占用。
Shutdown 等待所有引擎启动、选择、会话操作和物理通道，强制退出覆盖全部已登记子进程。失败路径
绝不切换到另一 factory。

### 注册与清理

注册前核验实际引擎回执和返回的 Session ID。缺失、非法或冲突回执拒绝注册。可安全
寻址的未注册 Session 在原 connection 上关闭；ID 无法安全寻址时隔离原通道，等待
其他会话排空，并保持准入到物理退出。不能因异常响应返回了其他 Session 的 ID 就关闭它。

ACP 恢复成功后发生的校验失败，仍按原通道清理。对外超时不代表物理操作完成。
原操作结算且清理完成前保留占用。清理围栏同时覆盖回执拒绝与超时；重试提示是退避
策略，不是清理完成时间的估计。

### 活跃路由与工作区操作

Prompt、取消、审批、模型变更和关闭使用 entry 绑定的 connection。入站 Session
查找、恢复回放、后台准入与 generation 事件也必须匹配发送的 channel/connection。
活跃会话的 transcript、turn-index 读取和 flush 同样走 owner；仅不存在活跃 entry
的持久历史读取使用 Legacy 工作区回退。

工作区 MCP、配置/状态控制与预热使用 Legacy。整体存活与活动状态检查两个引擎；
空闲回收按实际 candidate ID 找到通道。预热 keepalive 只延长 Legacy 的空闲期限；
Managed 的会话和在途工作仍会阻止其通道被回收，本切片不提供独立的 Managed 预热
keepalive。子进程资源采样与用户语言下发也仍只覆盖 Legacy。生产启用前，#12380
需结合 host 接线确定按引擎聚合资源与传播语言的行为。

现有工作区 stop 回执只表示一个物理通道，因此多个通道存活时明确拒绝 stop，直到
回执扩展；只有一个通道时仍可停止。
Managed branch/side-task 在修改历史前拒绝。

## 文件与消费者

| 区域     | 文件 / 消费者                                                               |
| -------- | --------------------------------------------------------------------------- |
| 公共构造 | `bridgeOptions.ts`、包 `index.ts`；daemon、Channels、SDK/嵌入 Bridge 构造方 |
| 通道归属 | `channel-lifecycle.ts`、`channel-startup.ts`、`channel-harness.ts`          |
| 会话路由 | `session-control-plane.ts`、`BridgeClient` 回调                             |
| 验证     | 同目录 Bridge/lifecycle 测试与隔离进程脚本                                  |

现有 daemon、Channels 与嵌入构造方保持单 factory 路径，不增加 daemon route。
工作区控制归工作区，所有会话操作归活跃 Session owner。Managed owner 缺失或失败
时绝不回退到 Legacy 或 primary runtime。

## 验证与验收标准

1. 两种引擎共存，按引擎合并启动，共享 Session/ID 限额。
2. 修改默认选择不能改变已 attach 或持久归属的 Session。选择器和 Managed 失败时，
   另一引擎的 dispatch 次数为零。
3. 匹配回执允许注册；缺失/冲突回执及非法/冲突 ID 拒绝，物理资源继续正确记账。
4. Prompt、取消、权限、回放与关闭保持归属，另一通道不能注入事件或代答。
5. 空闲清理、隔离、延迟启动、迟到响应和 shutdown 覆盖两个引擎，并保留替代代数。
6. 现有单 factory 测试通过；运行 build、typecheck、bundle、定向单测和隔离进程验证。
   测试替身仅证明 Bridge 契约，不证明 host 持久化或 Hosted 推理已经完成。

## 风险与待定项

主要风险是清理完成前释放准入，或把一个引擎的 current channel 当作整个工作区。
测试必须观察真实 factory/connection 调用和未完成清理，而不只检查最终 Session 数量。
Owner 持久化依赖与生产 host 回执实现仍是 #12380 中待对齐的接线问题；在此期间可通过
Bridge 注入接口验证契约。
