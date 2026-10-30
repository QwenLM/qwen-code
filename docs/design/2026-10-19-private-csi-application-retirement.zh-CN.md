# 私有 CSI 原始 owner 的应用退役

[English](2026-10-19-private-csi-application-retirement.md) | [简体中文](2026-10-19-private-csi-application-retirement.zh-CN.md)

## 状态与范围

实现从 #13526 的 `1a6529b73c007044d9d04e0614fbc30ebe13c0ac` 提取，独立基于 main `11a6346aa92b5e2f473464174e6043d053bf8010`。验证结果只属于提取后的候选；累计分支的历史测试不能证明本候选合格。

首个支持场景是已完全 settled、仍存活的原始私有 Hosted 文件 owner：runtime generation 1、writer generation 1、activation epoch 1、原 worker，以及未压缩的内联 Read/Write/Edit 历史。未完成的模型/工具工作、取消、UNKNOWN 执行、未解决的读取/PUT、不支持的次级活动和替代 owner 均阻断退役。新增冷恢复、节点证据、物理停止、CSI unpublish、binding/holder 释放、复用和公开 CSI 选择入口不在本变更内。

## 问题与当前行为

私有文件通道可以完成 turn，但通用 activation 释放和 Runtime Session 释放明确拒绝 CSI。SQL 接纳和 worker 文件描述符还没有共同的持久应用切点。租约到期或本地 Promise 集合为空，并不能证明原应用已经停止修改保留的文件与历史。

main 已有的完整回执恢复继续只接受 active 历史。本变更新增独立的原 owner 终止消费者；不允许普通 commit、replay、restore 或执行接纳接受 released 历史。

## 持久应用 authority

在现有规范 `ma_operation` 的 CSI_RETIREMENT 行上存储可空进度：`qwen-csi-application-retirement/1`，阶段 SETTLING → FROZEN → CUT → DRAINED，对应版本 1–4。保留精确的 DRAINING intent 字节、DRAINING 的 binding/holder，以及被原 runtime 占用的 slot。DRAINED 仅在验证原 worker 的精确 finalization receipt 后释放原逻辑 Runtime Session。

begin 在原 binding seal 和 holder 转移的同一事务内写入 SETTLING，以及经过溢出检查的数据库 `startedAt + 300000` 毫秒结算期限。重试不能重置期限。旧 NULL、不完整或未知进度拒绝。不可变 sealed binding version、当前 binding control version 和应用 progress version 分别保留。holder revision 从保留的 reservation 推进，不等于 runtime generation。

每个修改消费者接收经过验证的原 Connection。CUT 前在等待锁后、最终写入前重新检查数据库时间；等于租约/期限视为过期。finalization 消费不可变的持久 CUT，不要求或延长存活租约。SETTLING 只允许已经接纳的原始续作在原 authority 和固定期限内完成。FROZEN 关闭续租与所有普通修改。有效期限不能复活已过期租约。

## 现有 owner 屏障与精确准备

经过认证的 primary listener 路由 `/session/:id/internal-csi/retire` 限定于现有存活 owner 及其 tenant、workspace、binding 和 retirement 身份。它不 attach、resolve 或 acquire 替代 runtime。在首次 await 前同步锁存，关闭新的 attach/text/history 工作，停止调度续租并等待已接纳任务。任务退出 Set 后仍保留失败。retirement Promise 不属于它等待的 Set；精确重试共享准备和完成过程，不同 retirement 冲突。

等待真实的原始 activation renewal 和 HTTP writer renewal 结果，不发起新续租。不存在续租时使用当前原 authority；存在但结果为 no-op/undefined 或 rejected 时阻断。不能在等待前调用 stopLocal，它会禁用验证成功在途续租所需的 grant。

在 authority 的原串行边界内关闭普通接纳，使用现有 record/marker 编码器和暂存资源准备唯一 activation release。两条 record 和一个 `managed-activation-boundary` 资源保留精确 ID、父链接、时间、原 activation expiry 和前序 sequence/UUID。准备过程不发 HTTP 或持久 append；丢失持久化响应后仍缓存相同字节。共享 commit-body 构建器供普通 append 与本准备使用；普通 append 仍先确保 writer，退役使用已等待的原 grant。

## Freeze、cut 与 finalization

现有 operator 认证的 Session Store 前缀暴露私有 status 和 freeze/cut/finalize 命令，始终限定 workspace 与 retirement ID。输入采用封闭、有界 JSON 和规范 base64，不包含裸 bearer token。Spring 与私有测试/runtime 组合使用同一生产应用 store。

freeze 首先在有界事务内验证完整原 SQL 库存和拟议终止后缀，不写入。事务外请求原 worker 锁存接纳、等待工作并返回绑定 retirement 与精确 prepared commit body SHA-256 的 pre-cut 库存。第二个全新事务重新验证当前 authority、完整成员、期限、终止证明和 worker 观察，然后持久化 FROZEN 与完整不可变 envelope。envelope 包含精确 commit body 字节/摘要、独立推导的原身份/token hash/pins、typed baseline，以及精确 worker 观察字节/摘要。frozen envelope 摘要与 prepared commit 摘要分别保存。

cut 只消费该持久 envelope。它验证 active 前序和唯一原 release 后缀，插入精确 resource/ref/transaction，保留 checkpoint 身份，并原子持久化 CUT 和 SEALED head。声明的终止 delta 使用当前 schema 精确的 BIGINT epoch-millisecond 时间单元格。保留原数据库毫秒值，不经 DATETIME/时区转换；该值不作为租约 authority。native live history 继续只接受 active。

finalization 读取不可变 cut，在 SQL 外调用原 worker，然后验证精确原响应和未改变的完整库存，再持久化 DRAINED 并释放唯一逻辑 Runtime Session。worker 双向比较 execution、grant、result、receipt、history、保留 backup/preimage 和当前文件，关闭接纳与原描述符，返回精确清理事实。cut/receipt 重试对 live authority 只读，不 acquire、renew、execute、发布 ACK 或创建新 worker。

## 完整库存与插入屏障

显式规范 typed 库存覆盖本次增量迁移后的全部 32 表、736 列：原始身份、创建 receipt、workspace/config/request pin、registration/holder/intent/slot/binding/control、逻辑 runtime session、所有 native execution/grant/result/receipt/history、journal/resource/ref、publication/read/output 状态及不支持的次级 ledger。它用跨全部状态的独立 OR 发现，对间接关联载体进行有界全表发现，引用扩展至固定点，并使用完整排序主键。未知关联、格式错误/孤儿行及 schema drift 均阻断，不能用父 join 或 live 状态过滤隐藏候选。

预算为每个完整事务十秒、4096 个唯一行、32 MiB 聚合 typed 证据。重复相同观察共享计数，冲突字节拒绝。每个支持为空的集合都有真实 producer 屏障。通用修改和收集在原 tenant/session 锁下排除私有 session；native 路径消费同 Connection 进度。binding control 遵循 placement → retention → 完整排序原 slot/binding → 私有 pin/context → registration → holder → intent/progress → native head/history/resource → session/execution → publication/read/次级库存。原始 owner 在同一 Connection 上遵循该父锁顺序；RPC 与文件系统工作留在 cut 事务外。其他 owner 的归属检查仍可能在扫描其子行后取得它的父锁。

保留的 native file history 沿真实 journal/resource/嵌入投影链验证。其他 owner 的 snapshot manifest/page/旧 body revision 与 agent instructions/skills 使用真实 producer schema、完整归属和引用验证，不能做字节子串匹配或虚构空集合。这不新增历史物理释放 authority。

历史 status 与 retry 的只读固定主键镜像保留原 DRAINING holder；不存在无 holder 或 released-history 资格。保留 main 真实的 `hosted_context_usage/latest` producer。唯一的封闭 typed Session record 必须与首次和最新已提交 native `model.attempt/output_committed` 事件完全相符，包括 scope、key、usage resource、sequence 和事件时间单元格；其余单元格保持 NULL。只允许该最新投影的精确 `SESSION_RECORD` 引用与 native JOURNAL 引用并存。该引用的 SQL 创建时间单独限制在对应 journal 的数据库取时与固定结算期限之间，不能当作事件时间。缺失、重复、陈旧、伪造或未知投影及引用均拒绝。native proof 重放继续只消费独立验证的 JOURNAL resource 成员关系。

已安装 JournalEventTransport 时不支持私有 CREATE/request 解析/live authority 和退役，包括配置 flag 为 false 时安装的自定义 port。普通 main transport 保持支持。关闭曾经安装的 transport 不能证明旧远端工作已经消失。

## Main 兼容与文件

保留 main 已发布的 V11 wake migration，新增只包含十一项 `ma_operation` 进度/唯一 target 字段的 V12。不添加 node-source/physical 表，不改变 32 表 contract。库存保留四项 wake 字段，包括生成的 scan 谓词。精确 terminal head 更新遵守 main 的 wake-revision producer contract；验证生成单元格而不忽略。保留严格 UTF-8 VARBINARY 身份解码、opaque actor 字节、非 Managed broker 兼容，以及当前 main 的未知 commit 对账和查询预算行为。

变更涉及 Hosted CSI owner、core HTTP/authority 准备、worker finalization/协议/backend/mount 观察、Java application store/inventory/image/proof/progress、原 SQL 修改屏障和私有 controller/组合。新增 finalizer boot 6/resource handle 4 显式接线，保留 boot 4/5 兼容。排除 node source、安装字节策略、physical coordinator、stop intent 和公开 selector。

## 验证与验收

全局 CLI 基线为 `qwen 0.25.2`：attach/text/retire 路由均返回 404。这只证明能力不可达，不是 SQL 协议复现。

运行根目录 build/typecheck/bundle；core 与 CLI 的准备/屏障/finalizer/恢复定向回归；JDK21 受影响测试后完整 Maven verify，包括两项 Checkstyle 和 SpotBugs。一次性 MySQL8.4 真实验收必须覆盖原 SQL/worker 退役、精确重试/丢失响应/期限拒绝、完整库存与回滚、RC/RR writer/control/read/snapshot 竞争，以及保留 snapshot/agent 兼容。实际私有 Hosted attach→已 settled 文件 turn→begin→现有 owner retire→DRAINED 探针必须补充 mocked barrier 测试。

验收要求原 worker/binding/file/history/execution 身份不变，无新增 execution 或 writer acquire，DRAINED version4、sealed head、worker 描述符关闭，逻辑 session RELEASED，同时 binding/holder 仍 DRAINING 且 slot 被占用。恢复 owner 无修改地拒绝。明确报告未执行检查与环境限制；这些测试不能证明 Linux 物理 stop/unpublish/reuse。验证后进行两轮完整干净 diff 自审与评审。

## 待明确事项

OTHER owner 的归属验证保留在有界全表子行扫描后取得 foreign parent 锁的路径。与该 owner 的普通写入竞争可能产生 deadlock 或 timeout；有界事务回滚，调用者需要重试。跨 tenant race 尚未验证。维护者必须在生产资格验收前明确评审此锁顺序问题；本次提取不自行发明跨 tenant 锁协议。

不能把新架构选择交给 runtime 默认值。source 候选与当前 main 的不可变 history/schema/producer contract 有任何不一致，必须先理解真实消费者，才继续提取。物理退役和恢复后退役的资格验收继续单独推进。
