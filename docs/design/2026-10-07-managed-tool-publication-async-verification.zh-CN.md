# 工具输出发布异步校验

[English](2026-10-07-managed-tool-publication-async-verification.md) | [简体中文](2026-10-07-managed-tool-publication-async-verification.zh-CN.md)

状态：实现 issue [#13242](https://github.com/QwenLM/qwen-code/issues/13242)。

## 问题与范围

发布上传会在 HTTP 线程读回存储字节；seal、prefix、finish 也在该线程扫描捕获流。
现有 operation 日志具有租约和幂等凭据，但进程重启后无法重建 seal 请求或 inline
terminal。worker HTTP adapter 已支持轮询；上层仍须等待验证后的凭据，才能声明
流已封存或执行已 settled。

将 producer publish、resource publish、seal、prefix、finish 的校验移入持久化、
有并发上限的 verifier。保留 writer finished/admission prepare、receipt 校验、
ACK 校验及实际内容读取的完整性检查。不增加通用任务系统，不改变 Shell 执行和恢复。

## 契约与兼容

新客户端发送 `X-Qwen-Tool-Publication-Async: 1`。只有该请求头和服务端
`qwen.managed-agent.tool-publication.async-verification-enabled=true` 同时成立
才接收新的异步 operation；开关默认 false。首次创建时保存执行模式，重放和恢复
沿用该模式，关闭接收开关也不改变已有任务。旧客户端保留同步响应。请求头不参与
请求摘要，不改变 binding、grant 或 installation schema。

仅在全部输入与 verification-ready 记录提交后，返回 HTTP 202、`state: PENDING`。
完成结果使用 HTTP 200。

| 状态      | 含义                                         |
| --------- | -------------------------------------------- |
| PENDING   | 已接受，等待、运行或重试校验；客户端只轮询。 |
| SUCCEEDED | 历史校验成功凭据，位于 `receipt`。           |
| FAILED    | 永久结果，位于 `error: {status, code}`。     |
| RETRYABLE | 上传不完整或旧同步 claim 需要相同请求重试。  |
| EXPIRED   | 原有效 deadline 已到，需要显式恢复。         |

成功和失败优先于期限判断。FAILED 不得重新领取或恢复。adapter 在网络重试处理之外
解析 FAILED，包括配额状态 507 和存储拒绝；保留串行队列、250ms 轮询、30 分钟
观察期限和三次显式恢复。prefix 到期后仍不可恢复。

异步精确成功重放返回历史凭据，不读取对象，但继续检查身份、请求摘要和已知隔离。
SUCCEEDED 证明完成时验证成功，不证明存储之后从未改变。finish、实际读取、receipt
校验和 ACK 继续检查当前字节。同一已验证 slot 的相同内容可直接返回成功，不必为
新的幂等 ID 创建 operation。

## 持久化与执行

增量 migration 为现有 operation 表添加执行模式、校验输入、就绪标记、下次尝试
时间及安全失败信息，并添加待执行索引。旧行默认同步模式。seal 保存 count、byte
length、digest；terminal 和 inline resource 原始字节在校验前保存。对象 PUT 和
就绪事务完成后才能返回 202。未知 PUT 结果仍可重试，且继续占用配额。

独立执行器默认两个校验线程，由 `verification-concurrency` 控制。提交后立即唤醒，
持续处理任务；每秒数据库扫描兜底处理丢失唤醒和重启。不得占用 GC/retention 调度器。
worker 先无锁选择有界候选页，再按现有 parent/publication/operation 锁顺序领取。
对象读取与散列在 SQL 事务外执行。

worker 使用仅供已接受 operation 的内部授权入口，不存明文 token。领取、心跳和
提交继续通过 journal-head authorization 检查 binding、writer、activation、
runtime 与 CSI。开启异步接收要求已开启 journal-head authorization。状态查询
仍为只读 scope/token 检查，不启动任务、不续期。

复用 claim epoch、租约和按字节计算的 deadline。排队时间计入原 deadline。已就绪
而无有效租约的任务为 PENDING，不是 RETRYABLE。临时 I/O 失败仅清除租约，一秒后
重试，整个有效尝试期间保留 active_operation_id，也保证 prefix 输入稳定。到期
停止执行；恢复以新有界 recovery deadline 和 epoch 调度原输入，不改变原 deadline、
资源身份或配额。

保留现有 segment 与聚合 SHA-256、ordinal/count、manifest closure、terminal
检查。只有受执行权保护的短事务可以安装 VERIFIED 对象、seal、FINISHED 和成功凭据。
待校验资源不能进入 admission 或 settlement。finish 保留已冻结前驱；前驱永久失败
时明确失败，不无限等待。

永久 validation/storage-denial/fencing 失败仅保存安全 status/code，不保存原始
存储异常或凭据。已接受任务的原始 CSI binding 被释放或 CSI 授权失效时，永久失败并
退出队列。副本凭据密钥或 SQL 错误仍可重试，不能误判为运行时身份失效。
候选的输入或授权错误逐项隔离：未领取任务在原 epoch 下失败、延后一秒或到期，
然后扫描继续处理后面的候选；SQL 状态更新失败则退出本轮扫描。期限内失去租约的
尝试只能在同一 epoch 下重新排期，不能提交失败或隔离状态；重试时间不超过操作期限。
完整性隔离和所有成功/失败写入都要求当前有效 epoch；旧 worker
不能覆盖接管者结果。保留 read lease、retirement、未知 PUT、候选/隔离对象保护和
GC 配额核算。

## 发布与可观测性

1. 应用增量 migration，升级全部服务端，保持异步接收关闭。
2. 升级客户端，继续兼容旧服务端的直接凭据。
3. 全部 writer 维护 journal head 列后开启 journal-head authorization，再开启异步
   接收；长寿命旧客户端仍走同步模式。
4. 回退先关闭新的异步接收，已有任务继续处理。完成或妥善处理任务后再降级服务端
   二进制；处理期间保持 journal-head authorization 开启。

通过安全结构化日志记录排队等待、校验耗时、重试、失败和到期。吞吐预算和并发是
运维限制，不承诺全部操作的端到端耗时都会缩短。排队时间使用数据库时间戳，校验
耗时使用进程单调时钟；重试日志仅记录 scope、operation 和异常类名。

## 验证与验收

阻塞对象读取，证明异步 HTTP 响应先于校验；阻塞 PUT，证明持久化前不会 accepted。
不重传输入而重启 verifier，覆盖 seal 与 inline/object terminal。验证双 worker
竞争、租约接管、迟到成功/失败、前驱失败、prefix 重试稳定性，以及到期/恢复身份配额。

覆盖缺段/多段、摘要变化、非法 manifest、临时 I/O、owner 失效、retirement、FAILED
稳定性和错误分类。验证新旧客户端/服务端组合、关闭接收后任务继续处理、历史成功
重放后实际读取仍发现损坏，以及健康 head 下心跳/状态轮询不读取 journal 正文。
运行定向 Java/CLI 测试、真实 MySQL 恢复/竞争测试、build、typecheck、bundle 和完整
diff 自审。E2E 计划与结果存放在 `.qwen/e2e-tests/`。

## 涉及组件与决策

协调修改 Java publication catalog、producer controller、授权 store、配置和
migration，以及 CLI publication HTTP adapter 和定向测试。没有未决产品问题。
持久化任务、有界执行、严格成功边界、滚动兼容、历史凭据重放为选定默认行为。
