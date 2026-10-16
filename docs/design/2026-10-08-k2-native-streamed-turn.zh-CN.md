# K2：原生流式 Hosted turn 前置能力

[English](2026-10-08-k2-native-streamed-turn.md) | [简体中文](2026-10-08-k2-native-streamed-turn.zh-CN.md)

状态：已实现并于 2026-10-08 完成本地有界行为验证，仍保持 Draft 和维护者评审。
基线：`fff718e71de0b80c3095152ea6b14335863c07f0`。
在 [Draft PR #13526](https://github.com/QwenLM/qwen-code/pull/13526) 中继续
[原生文本准入](2026-10-08-k2-native-text-conversation.zh-CN.md) 和
[完整文件链设计](2026-10-07-k2-native-file-execution.zh-CN.md)。
这项前置能力不代表 K2 整体目标完成。

## 1. 当前缺口与进程拓扑

本前置能力实现前，SQL fold 支持没有流式输出的原始有限文本 turn。
真实 Hosted caller 对工具 profile 启用 `HostedTextDeltaStream` 和已结算 prompt
历史过滤；先前诊断 producer 自己组合 ChatRecord，没有覆盖这两个分支。
基线 SQL 拒绝第一个 `assistantDelta`。provider 返回成功或手工组合最终消息，
都不能验证这些原生消费者。

Hosted daemon 持有模型、原 Harness 和 Session Store 连接。Boot4 CSI worker
持有挂载并执行 context 操作；当前四条路由不运行模型，也不构造原生文件工具组合。
本次不给 worker 增加模型、store 或 Broker 启动字段。公开 Hosted 和 Spring CSI 选择保持关闭。私有内部 attachment、
原 CSI context 安装、retained bind 和真实文件 RPC 是同一整体目标的后续步骤。

基线 no-AK CI 暴露了保留原生无工具 Parts 后的回归：旧 `answered` 谓词把只有
thought 的文本当成可见回答。独立复现已确认该问题；现在该谓词排除 thought
Parts，同时仍把完整 Parts 保存在持久消息中。现有打包进程中只有 thought、
失败和取消 turn 的历史测试保持不变。

## 2. 共享原始 Hosted 执行

把现有完整 turn runner 提取到 `hosted-harness-turn.ts`，由原 `executeHostedTurn`
适配层调用。原 ChatRecord 创建逻辑也放在该生产模块，其他路由记录继续复用。
诊断 producer 调用真实共享 runner，不再自行写 user、assistant 和 turn-result。
该生产代码由现有路由实际消费，不是为了测试导出原本私有的函数。

保留原模型槽位归属、Harness checkpoint 授权、全局消息父链、user 提交、模型
attempt、流式消息 ID 消费、原子结算、可恢复错误分类、回调、工具 finish 和异步
cleanup。适配层传入原 workspace context、hooks 和工具 turn 构造器，不把
acquire 提前。依据现有实际 profile 决策显式选择全部历史或已结算历史。
已结算历史保留已结算 prompt 的完整 Parts，排除未结算 prompt；仅在原工具结果
resume 分支纳入当前 prompt。

共享 runner 的原生无工具诊断仍拒绝真实工具 SSE，不提供私有文件声明、bind、
prepare 或 dispatch 授权。执行该共享函数不代表私有 HTTP attachment 路由已实现。

## 3. 原始 stream fold

给现有派生 `Prefix` 增加当前 stream 的消息 UUID、首个 sequence、下一 ordinal
和累计可见文本。撤回和结算后仍保留已用 ID；不新增 SQL 投影或权威。

`assistantDelta` 必须恰好包含一个 activation 归属的 `message.delta`，payload
为 `messageId`、`turnId`、`role`、`text`。要求当前原 input/user、started 模型
attempt、尚未提交 assistant、精确 owner/activation，且不能修改 checkpoint。
command/event ID 都是 `assistant-delta:<turnId>:<messageId>:<ordinal>`。
首个 ordinal 为零，后续 ordinal 必须在同一个原 stream 中连续。digest 是原
文本 UTF-8 字节的 SHA-256，不是规范化 payload hash。每个非空 chunk 至多
3,072 UTF-8 字节，非法 Unicode 拒绝。

`assistantRetract` 必须恰好包含一个 `message.retracted`，payload 为
`messageId`、`turnId`、`fromSequence`。必须关联当前 stream 和其首个原始
sequence。command/event ID 是 `assistant-retract:<turnId>:<messageId>`；
digest 是 `<messageId>:<fromSequence>` 的 SHA-256。清空当前 stream，但保留
其已用 UUID。替换 stream 必须使用新 UUID，从 ordinal 零开始。原 provider
retry/fallback 顺序需实际观察后再验证；仅凭事件不能放行任意额外模型 attempt。

最终 assistant 必须使用当前 stream UUID，非 thought 文本 Parts 拼接必须精确
匹配流式文本。保留全部原 thought/text Parts。消费预留 UUID 时不能再次登记，
不能替换成已撤回或无关 UUID。先前已验证的非流式消息仍有效。provider 失败后的
原始 error 结算必须实际观察；不能抹掉已发布前缀、伪造撤回或把前缀当已提交
assistant。有效原子结算随 input/attempt 清空当前 stream，保留消息父链和已用 ID。

新提交和完整冷 replay 使用同一 fold。当前 revision 资源、原 digest 和
checkpoint 覆盖规则不变。原命令精确 replay 只读，包括 DRAINING；新流式变更
要求 READY。未知形状、ordinal 缺口、文本/UUID/turn/activation 不匹配和非法
原始历史，在无持久变更的前提下拒绝。

## 4. 影响的消费者与验证

生产消费者包括现有 Hosted prompt、resume、wake 和结算投影 caller，原 SSE/
transcript delta 去重和撤回，Java 原生新提交和完整历史准入，以及原 checkpoint
replay。涉及共享 runner、适配层、`CsiNativeActivationProof`、同目录测试、
原 generator/helper 和这对完整双语设计。本前置能力不改变 daemon 路由归属或
SQL schema。

生产代码变更前，由独立 test-engineer 记录全局 CLI 能力，再以明确披露的生产
模块 test-script fallback 和真实注册的私有 CREATE/Spring/JDBC 事务验证。
采集实际 stream 字节、provider 请求、完整表值和预期的首个 delta 拒绝。保留
基线失败及源码、依赖和实际 origin pin，仅清理自有资源。

变更后调用真实共享生产 runner，把未修改的原事务交给 Java 准入。覆盖成功、
真实无工具错误及下一 turn、多段 Unicode 和 3,072 字节边界、thought Parts、
下一真实 provider 请求中的已结算历史，以及可复现的部分输出 retry/撤回和失败。
结构合法的拒绝对照需签名并匹配通用 digest，确保到达语义 gate。原结构解析器
和 head-CAS 的前置拒绝单独记录，不作为 stream 语义验收。验证原 replay、完整当前
历史、损坏、DRAINING 和完整 SQL 前后值相等。执行 build/typecheck/bundle、
针对性 Java/CLI 测试、必需静态检查、独立验证、两次干净 diff 审计和真实原生 review。

## 5. 验收与剩余整体 K2

只对实际观察到的原始共享 runner 和 SQL stream 行为验收，新的证据必须绑定
实际执行输入。通过针对性回归测试保持普通 Hosted 行为，明确报告缺失的场景。

独立有界验证实际观察五个原共享 runner turn 和七次 provider 请求，接纳 42 个
active 原事务并对全部 42 个只读 replay。保留两次真实 retry 撤回、最终部分输出
error、无工具 SSE error、完整 thought Parts 和下一 turn 的已结算历史；最终原
activation release 仍拒绝。持久 stream 损坏和原下一 input 的 ACTIVE/DRAINING
对照保留 53 表完整值与 ownership。初始三个被 head-CAS 阻断的对照保留原结果；
独立补窗按当前 head 正确签名，before-user/after-terminal/after-assistant 实际
到达 CSI409。空 delta 被原 TypeScript 结构解析器拒绝的边界单独披露。三个未修改
打包历史用例 retry0 通过；实际 bundle 请求采集确认原 thought 持久保留、未回答
A 被排除、已完成 B/C 历史保留。这些是生产模块/自有 collector/直接
Spring-JDBC-H2 和合成 Pod 元数据诊断，不验收私有 HTTP、worker/CSI 或云路径。

生产私有 Broker composition 同样尚未连接：现有 Embedded resolver/provisioner
与公开 Hosted create/load 不能授权这个 profile。私有 operator composition
必须把原 registration、CSI provisioning/reservation、当前 SQL 回读和事务后
context installation 接到认证内部 Hosted attachment。安装 RPC 后需重查当前
权威，SQL 锁不能跨 RPC；receipt、恢复后的 journal head 或资源字节不能单独授权 bind。

私有内部 Hosted attachment、CSI install/holder/bind 信任、完整原 batch
reservation 和 schema2 preparation、原生文件执行/结果/consumption、全部异步
writer 闭合、聚合 DRAINED、原 writer/子进程物理终止、每个 NodeUnpublish、
原子 RELEASED 和安全重复卷交接、公开选择以及新的完整集群验收仍是 K2 必需工作。
本地 fixture、CI 绿灯或旧云上运行都不能代替这些验收。维护者 retirement、retention、
LOST 决策及真实评审仍保持开放。
