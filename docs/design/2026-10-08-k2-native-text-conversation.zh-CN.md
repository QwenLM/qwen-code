# K2 原生原文本对话

[English](2026-10-08-k2-native-text-conversation.md) | [简体中文](2026-10-08-k2-native-text-conversation.zh-CN.md)

## 1. 状态与目标

本设计是 Draft PR #13526 已提交 `810744e` 私有 CSI 基础的后续实现；
tracker #13395 与 proposal #12380 保持开放。它规定完整 K2 的下一个原对话
前置，不声明 K2 完成，也不启用公开选择、原生工具、物理退休或安全卷复用。

首个有界目标是实际原文本 producer：CREATE 前发布私有 definition，原
input/wake、user 消息、model attempt 开始/终态、成功时的 assistant，以及
原子 turn-settled/下一 checkpoint 对。普通成功和工具请求拒绝后的下一 turn
都必须工作。fresh 准入和完整历史回放使用同一 transition，不接受 fixture 专用路径。

## 2. 已复现 baseline 缺口与权威观察

baseline `810744e` 的 `CsiNativeActivationProof.advance` 接受原 input/wake
与一次性初始 checkpoint。
`JdbcCsiActivationAdmission` 在 fresh commit 和每个历史事务调用它，同时检查
原父锁、writer、activation、资源 revision 关联与完整 head 相等。
已接受初始前缀后的消息在该 baseline 拒绝。新增 shared fold 按下述有界合同
检查原文本消息、attempt 与原子结算。

未修改的旧普通 Parts 采集展示真实 producer 形状，但 definition 缺少
`toolProfile`，不能证明私有 genesis。新的独立采集必须在原 CREATE 前发布
仅含 `engine`、`sessionId` 和保留私有 `toolProfile` 的 definition。
不能给原 raw resource 补字段或制造 native event 后冒充原私有 producer。
公开 Hosted whitelist 保持关闭。

实际内部 assembly、activation controller、text model runner 与 sink 可以通过
自有 loopback provider/响应 collector 调用。诊断 caller 按既有 Hosted caller
形状组合 ChatRecord 输入；这一明确披露的 seam 不启动私有 worker，也不授予
真实部署资格。原 sink 产生消息与原子结算；此路径没有 `turn.started` 或
`wake.consumed`。

此 caller 没有调用未导出的 `executeHostedTurn`。实际 Hosted caller 会因
private profile 启用 text-delta stream 和已结算 prompt 的 history 过滤；
这些路径仍需独立原生验收。baseline 先注册 SQL owner 再进行 native CREATE，
使两部分保留同一原 Session 身份，不改写 raw record。

## 3. 状态与 transition 合同

只保留已接受完整前缀派生的状态：当前原 input ID 与文本、最新 checkpoint
ref/ID、全局最后消息 UUID、当前原 model attempt route/ID/stage，以及其
assistant 是否提交。不新增 SQL 权威或平行 recording 投影。renew 保留状态。
只有后续有效原子结算清除当前 input/attempt；单独消息、terminal 或 checkpoint
不能清除。
既有 native caller 可以在首次 input 之前或之后创建初始 checkpoint，
因此两个顺序都应保留。

| 原 operation              | 必要关系                                                                              | 结果                                         |
| ------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------- |
| `submitInput`             | 没有未结算 input；保留原 prompt/admission、wake 与 revision 关联                      | pin 当前 input；保留全局消息/checkpoint 状态 |
| 初始 `commitCheckpoint`   | 既有一次性空 Harness 合同；无重复或后续独立 checkpoint                                | pin 最新完整 checkpoint                      |
| User `commitMessage`      | 原 prompt ID/文本；record/envelope scope；唯一 UUID 与精确全局 parent；model 开始前   | 推进原消息链                                 |
| `hostedModelAttempt` 开始 | 同一当前 input；原 route/budget snapshot 与最新完整 checkpoint 在本 revision 重新关联 | pin 原 attempt 与 route                      |
| Attempt 终态              | 同一 ID/route/checkpoint；一次开始后一个已观察终态；原 usage resource                 | pin 终态；保留当前 input                     |
| Assistant `commitMessage` | output-committed attempt；精确 model/当前 input/parent；完整有序 text/thought Parts   | 推进消息链，仅一次                           |
| `settleTurn`              | 精确有序 settled+checkpoint event；匹配 turn result 与完整下一 checkpoint             | 原子结束 turn 并保留新 checkpoint/最后消息   |

成功要求 output-committed attempt 和 assistant。已观察无工具拒绝要求
abandoned attempt、没有 assistant 和匹配 error result。error 后下一 user 的
parent 是前一原 user UUID。拒绝工具 SSE 后不能制造 tool intent 或成功文件 outcome。

每个 operation 检查闭合 native event/payload/resource 形状、UUID、当前 input、
scope/cwd、activation/epoch、sequence、command/event 身份、record/content
摘要、严格 UTF-8 和既有限额。原 raw resource 必须属于同一原 Session/workspace
的精确 journal revision；其他 revision 上 digest 有效的 ref 不足以授予资格。

消息超过 64 KiB inline 限额时，检查原 `managed-message-chunks` manifest
及同 revision 上每个有序 `managed-message-part` ref。producer 按 60 KiB
切分 raw byte；必须先拼接已校验的 part byte，再做严格 UTF-8/ChatRecord
解析，字符可能跨 part 边界。event ref 保留原 manifest digest。

Model route 保留实际 version/turn/model/budget 身份。Usage 是原 telemetry，
不是 grant 权威：先调查真实 native 数值及累计形状，再确定约束；不能假设 provider
数值都是整数结构计数。sequence/revision/epoch 规则保持不变。未观察的 retry、
多 attempt、非空 budget 与 cancellation 语义仍是待完成的完整 K2 要求。

## 4. Checkpoint 与 history 合同

结算是一个事务，依次包含 `turn.settled` 与 `checkpoint.committed`；不完整或
拆分的 pair 必须在持久写入前拒绝。新 checkpoint 覆盖此前已接受前缀，不含这两个
新结算 event，并引用前一 checkpoint ID。metadata 指向同一新 state ref；原
turn-result resource 提供 content digest。检查完整 checkpoint 而非仅 identity：
identity、resume/recording、continuation、attempt、tools、runtime、approval、
output 与 follow-up 都符合真实原合同。
result timestamp、独立生成的 `endedAt`、settlement event time 和 checkpoint
event time 不一定相等；各字段按原合同校验，不引入相等或单调递增要求。

baseline 的文本 assembly 将 recording/API-history 与其他可选组留空。必须用新
私有 definition 重采集这一精确合同，不能因此剥离更丰富生产状态。未支持字段或
phase 在原 producer/consumer 关系验收前仍拒绝。保留 definition/root ref 与
实际 identity input digest，不能替换为推断的 prompt digest。

fresh 与 history 路径语义一致。完整 replay 重建 pending input、原消息 ancestry、
attempt 和最后 checkpoint；后续 turn 之后的旧 command 精确重放只读，包括
DRAINING。新的对话修改要求原 READY 准入和有效 activation。损坏的旧消息/route/
checkpoint 必须令当前 history read 失败，不能仅在 fresh 解析时失败。
保留既有 history 限额和 placement 锁序。

## 5. 实现与消费者

实现扩展既有 shared proof 与派生 prefix，保留 genesis、activation/renewal
与初始 checkpoint 消费者。JDBC fold 从空派生 prefix 开始；相邻 proof 测试
和真实私有 CREATE/SQL 测试使用原 producer fixture 验证新增 transition。
既有 HTTP adapter 按当前 main 合同关联 nested message-chunk resource。

不新增 public route、whitelist 条目、worker constructor、daemon 归属 scope、
SQL migration、generic release 豁免或持久 fallback。当前 collector 只接受实际
观察 route 并保留 raw request/response；未知 route 失败，不返回制造的成功。

## 6. 验证与验收

实现前，独立 test-engineer 记录 global CLI 能力，再使用明确披露的内部
测试脚本回退。生成新的原私有记录，证明实际 Java SQL 在首个尚未支持的消息处
拒绝，同时保留此前已接受前缀。采集成功 turn、真实无工具 SSE 拒绝、下一 turn
恢复，以及当前 SDK 实际携带的 fractional telemetry。保留全部 raw 字节、
实际 imported module/JAR 来源、source/binary pin 与自有资源清理。
增加第五个成功 turn，使用 65,300 个 ASCII 字符的 prompt：先验证 input
JSON 不超过 64 KiB，而原 ChatRecord 超过 inline 限额，再采集实际 manifest、
有序 part 和 resource read。

新 baseline 产生 33 个原事务与 46 个资源：32 个 active conversation 前缀
结束于 sequence 41；最后 sequence 42 的 `releaseActivation` 来自原 collector
清理。保留此事务，单独验证既有私有退休 guard 拒绝且不改变持久数据。
collector close 不能证明 retirement-close。fresh SQL 接受前四个事务，在下一条
原 user 消息处返回 `409 csi_original_activation_unavailable`，53 张表完整值、
ownership 和首次 activation pin 均不变。第一诊断窗口取消且缺少完整 provider
日志；第二窗口记录了测试分类器误拒 SDK 附加日期提醒的 text Part，并触发
500 重试。两次失败记录与本次修正窗口分开保留。

实现后，让同一未修改的 active producer 前缀经过真实私有 CREATE、完整 fresh SQL 准入、
当前 history replay 和只读旧 command replay。分别验证正向及拒绝/故障：错
prompt/model/parent/order、改变 route/attempt/checkpoint、重复 start/assistant、
不完整结算 pair、checkpoint 错含结算而非前缀、错 predecessor/完整 recording/
input digest、交叉/缺失 revision 关联、byte/hash/length/UTF-8 不符、READY/
DRAINING 和旧 history 损坏。拒绝时断言完整前后表值，不只异常。验证 error 到
下一 turn 继续与完整 Parts 保留。

工作树组件的独立实现后验证于 `2026-10-08T06:35:40Z` 完成：五个原场景与
14 项 native 数据谓词、主 SQL/数据 128 项、补充 10 项及修正 split 结算的
三项谓词。它们与 JUnit/此前套件分开计数。全部 32 个未修改 active 事务接纳至
sequence 41，原 pin 保持 2，旧结算/完整 history replay 只读，原 release42
拒绝。新采集的长 user record 为 65,748 bytes，原 part 为 61,440 + 4,308；
不能沿用 baseline 字节长度。

主派生负例包含 19 项 CSI 409 拒绝（含非法 UTF-8），53 张表完整值、ownership
与 pin 均不变。首个 split 派生例命中既有 API record-count 边界；另一次原单
turn 采集使用正确签名/record-count，验证实际 split 拒绝，随后未修改的原子 pair
接纳并只读 replay。独立真实 CREATE 控制验证 duplicate start/assistant 拒绝；
同一未修改原 input 先在 READY 下于显式回滚诊断事务内接纳，后在已持久 DRAINING
下拒绝。精确 revision ref 缺失和旧 bytes 损坏也阻断当前 history，持久数据不变。

首验证窗口错误期待有限负数 usage 拒绝，而生产实际接纳该 telemetry；失败断言、
receipt 与表变化保持独立，不回填为成功窗口。首 split 的 API 边界观察和初 audit
猜测 JAR locator 的错误也保留。修正审计记录 5,878 个未变化执行输入、168 个
未变化所选 baseline 文件、122 个隔离依赖 JAR 与 2,287 个实际 Node 来源。
13 个自有进程组、八个端口、四个 H2 与 156 个临时文件已清理。冻结报告绑定该
提交前组件，不暗改为后续已提交 HEAD 或物理 CSI 验收。

本地验证包含当前 build/typecheck/bundle、相关 Java/Core HTTP 测试与显式 Java
静态检查。首 full lint 发现新测试 caller 的两个 Node global 未声明；显式
`node:url` 导入和 `globalThis.AbortSignal` 访问修复这些规则。该 test-only
变更后的四项 fresh generator/SQL 测试与 full lint 已通过。初次 build 顺序 setup
失败和 lint 失败保持保留。最终已提交检查与两轮完整贡献自审仍为提交要求。

合法原生 review 已捕获全部九个变更文件（包括每个新文件），并载入当前仓库规则。
由于此环境没有 Qwen 会话导出的 `QWEN_CODE_PROJECT_DIR`，workflow 生成停止；
没有运行 review wave 或批准 verdict。仓库 review skill 要求报告限制后停止，不能
调个人 agent 替代。该 review 保持未完成，PR 保持 Draft，等待合法维护者评审。

## 7. 剩余完整 K2 工作

此 transition 是前置，不能替代原子全员 batch/冷恢复、原 history/schema2
preparation、保留 composer/原生执行/outcome/Hosted 消费、完整 lifecycle/异步
writer cut、聚合 DRAINED、原 writer/子进程终止、逐个 NodeUnpublish、原子
RELEASED/同卷安全交接、公开选择与全新完整集群验收。Deadline、retry/budget 和
更丰富 Parts/checkpoint 语义必须在原生产拓扑验收。维护者退休、保留与 LOST 工作
决策仍开放，不推断权威。
