# Managed 工具发布过期恢复

[English](2026-09-30-managed-tool-publication-expiry-recovery.md) | [简体中文](2026-09-30-managed-tool-publication-expiry-recovery.zh-CN.md)

## 1. 状态与问题

本文是 #13019 / R15-1 的修复设计，基于包含 O2 #12894 的 main
`3b18cfe5e4ab7ea72f1a92736186dacf753bf727`。实现与验收结果另行记录。
O2 继续默认关闭。

O2 已能在发布应答丢失时，通过原操作上的显式新围栏尝试恢复。
但执行中的安装与扫描检查在操作期限或更短的 claim 过期时，返回普通
invalid request。worker 即使查到原操作为 EXPIRED 或 RETRYABLE，也把
这个响应当成最终拒绝；有效捕获可能一直停在 CANDIDATE 或 FINISHING。

seal 与 finish 还使用单次上传的期限来约束随捕获长度增长的校验。
当正常扫描耗时超过每次尝试的期限时，反复从头扫描无法收敛。
维护者已用真实私有 OSS 复现两类问题；该报告是既有证据，不是本修复验收。

## 2. 范围与不变量

本修复修改私有发布错误分类、worker 观察和首次／恢复校验预算。
不增加执行路由、公开 API、对象替换、Workspace 释放、GC 或功能启用。

- 保留原 operation ID、请求摘要、slot、key、资源引用、字节、终态 envelope、
  首次期限及已计费配额。
- 只有当前获授权的 claim epoch 能安装回执。迟到的旧 claim 不能修补或覆盖数据。
- complete-required 捕获与 Session 接纳保留既有校验。
  修复发布不能重复物理执行。
- 确定性的校验、所有权、认证、隔离或摘要拒绝仍为终态。
  EXPIRED 状态不能覆盖这些拒绝。
- GET status 不开始扫描、不续期。显式恢复仍限于 worker 原始 30 分钟观察窗口内
  最多三次；历史 prefix 查询仍不能恢复。

## 3. 执行中响应与观察

每次安装、扫描完成和 heartbeat 先核对操作行及当前 epoch，再检查期限与 claim。
使用明确的 HTTP 409 错误码：

| 条件                                     | 错误码                                       | 生产端动作                                   |
| ---------------------------------------- | -------------------------------------------- | -------------------------------------------- |
| 原有效操作期限已过                       | `managed_tool_publication_operation_expired` | 观察原操作；在既有次数上限内显式恢复 EXPIRED |
| 当前 epoch 的 claim 已过期，但操作仍有效 | `managed_tool_publication_claim_expired`     | 观察；只有状态允许时才重试原请求             |
| 其他 epoch 或活跃操作已隔离本次尝试      | `managed_tool_publication_claim_lost`        | 观察原操作；旧尝试不得安装                   |
| 另一有效操作占用 publication             | `managed_tool_publication_busy`              | 有界观察或重试；不增加持久队列               |

SUCCEEDED 返回原回执；PENDING 只观察；RETRYABLE 用新 claim 重发完全相同的
请求字节；EXPIRED 进入显式恢复。其他 4xx（包括 invalid_request）不会仅因
状态恰好是 EXPIRED 或 RETRYABLE 而改成可恢复。

明确的 busy 拒绝（publication 竞争的 409 或入口竞争的 429）没有开始恢复尝试；
等待后再观察，不消耗三次恢复额度。无法确定是否送达的传输故障仍消耗该额度。

所有受影响路由继续属于原 capture，使用原 publication token。
安装前仍执行原认证和冻结阶段约束。不增加 Session writer 或替代 Runtime 授权。

## 4. 固定的按字节校验窗口

采用按字节确定的窗口，不增加可移植 SHA-256 checkpoint 格式。
Java 标准摘要接口没有可移植的续算状态；此有界修复不需要另造哈希协议。

部署须显式配置：

- `qwen.managed-agent.tool-publication.verification-bytes-per-second`：正数，
  是对该部署中对象打开、读回、摘要计算及元数据遍历测得的保守吞吐下限。
- `qwen.managed-agent.tool-publication.max-verification-timeout`：显式时间上限，
  不小于基础操作期限，最多 25 分钟，为现有 30 分钟 worker 观察窗口留出时间。
  两项均没有生产默认值。

扫描开始前只计算一次：

```text
window = operationTimeout + ceil(catalogWorkBytes / verificationBytesPerSecond) seconds
deadline = databaseNow + window
```

结果必须落在配置上限内。最大 capture 分配加 producer 预留仍无法在窗口内
校验的配置，在启动时拒绝；不能把过大预算截成上限后宣称能够完成。

工作字节来自获授权的 catalog，而非调用方声称的长度：seal 和 prefix 统计
指定流已保留、已验证的分段；finish 统计所有已保留的 producer/capture
资源，包括待完成的 predecessor 与固定的 terminal candidate。计入未使用的保留资源是在已准入分配内
保守高估工作量。元数据查询不做对象 I/O，遵守现有事务锁顺序。

初始计算结果写入现有操作行的 deadline。有效期内的重试、heartbeat、status 和
重复 recovery 都不移动它。原操作过期并被显式恢复时，为其不可变 slot 计算新的
有界窗口，仅写入既有 recovery_deadline；增加 epoch，保留首次 deadline。
普通分段和资源发布继续使用基础单次上传期限。不需要 schema 迁移或公开 grant 字段。

保证以声明的吞吐下限和有界停顿为条件。永久 I/O 故障或低于该下限的吞吐仍可能
耗尽预算并阻断。启用 profile 前须在真实 OSS 上验证这一假设。
不承诺在任意慢存储下推进，也不增加自动修补。

## 5. 恢复、兼容与资源边界

只有 claim 过期时，在既有操作窗口内重试原请求；不调用 recovery，不延长期限。
操作期限过期时，沿用显式 recovery 和原 candidate。
FINISHING 保持冻结，不能接收新段或新 envelope。
修改部署配置不会改变有效尝试已持久化的期限。

历史行保留首次期限，下一次显式恢复可采用新校验策略。
prefix 不能借 recovery 升级成新查询。启用 O2 却缺少显式预算配置时保持拒绝；
默认关闭的部署不受影响。启用前须同时升级 Java 服务和 worker。

扫描仍用 64 KiB 缓冲，校验每个对象与整体摘要，不缓存完整流。
page／segment 元数据遍历也检查并续期既有 claim，防止多个短数据库调用累计
使 claim 在字节扫描前失效。
worker 捕获保留原有有界分段及串行操作队列。
不增加无限并发 capture 的全局内存承诺。

Session 的阻断与 Workspace 租约是独立状态。
发布恢复不能证明未知写入者已经停止，也不授权释放 Workspace。
既有审计式运维恢复与通用执行接管继续独立推进。

## 6. 验证与验收

1. 复现原挂起请求的实际响应，而非只看第二实例的 status：
   延迟分段 PUT 与 finish 读回应返回明确过期码。
2. 覆盖只有 claim 过期、旧 epoch 迟到安装、初始／恢复应答丢失、busy 观察，
   以及最多三次恢复。即使伴随 EXPIRED 状态，确定性 4xx 仍须是终态。
3. 断言原 key/ref/digest/首次期限/envelope 及配额相同；原 Shell 副作用次数保持一。
4. 用增量生成的慢 100 MiB 输出，使扫描超过基础期限但落在按字节窗口内。
   seal、finish、独立摘要及 store 替换后的尾部读取均通过。
   在不构造完整输出 Buffer 的条件下重复 1 GiB，并把工作集观测与 JVM 堆上限区分。
5. 验证首次／恢复窗口边界、有效期限不变、部署容量拒绝、损坏隔离和空流。
6. 在真实 MySQL 上运行双实例场景。分别记录对象存储夹具、真实 OSS、真实 Shell
   进程与跨宿主证据。缺少凭据属于验证缺口，不能算作 OSS 通过。
7. 独立 PR 前运行定向 Java/CLI/core 回归、build/typecheck/bundle、Checkstyle，
   并完成连续两轮无新问题的开放式完整 diff 自审。

## 7. 风险与后续

吞吐下限是显式运维假设；过于乐观的值仍可能阻断大捕获。
长校验占用一个入口并继续进行有界授权／claim 检查。
status 轮询不接管其工作。若实测部署无法满足有界窗口，可后续设计更复杂的可恢复校验。

吞吐下限须以 O2 Shell 生产端的 1 MiB 分段、末尾短段以及元数据／对象打开成本
实测。任意碎片化的合法流可能具有更低的有效字节吞吐并继续阻断；
本修复不改变 O1a 的分段大小，也不承诺每一种合法碎片化都能推进。

O3/O4 集成保留在既有 PR。本修复继续为不确定数据计费，不放宽回收准入。
完成必要的真实环境验收与维护者评审之前，O2 保持关闭。
