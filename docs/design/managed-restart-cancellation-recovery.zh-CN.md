# Managed 重启取消恢复

[English](managed-restart-cancellation-recovery.md) | [简体中文](managed-restart-cancellation-recovery.zh-CN.md)

## 问题与范围

进程验收发现三个相连缺口：瞬态 HTTP 续租重试耗尽后后台调度停止；writer 过期后未收到接纳回复的请求无法取消；恢复被终态拒绝时仍只调用普通取消，未接管 parked Turn。公共失败没有结算原生输入，因此现有关闭检查正确地继续阻断。

本次修复这些路径，不启用 Full Access、不重放 Shell、不恢复过期 writer、不绕过空闲日志检查，也不添加公共 API 字段。完整写租约停机后的自动续聊仍不在范围内。

## 决策

1. 保持健康续租频率。传输错误或可重试 5xx 耗尽单次请求预算后，仅在原 grant 仍有效时以一秒间隔重排。过期、明确拒绝或开始 seal 后停止，包括关闭与在途续租竞态。不隐式获取替代 grant。activation 心跳事务耗尽三次请求后，可在提交开始时的原 writer 租约内继续原样重试，保留相同事务身份、字节及摘要；普通事务仍最多尝试三次。租户锁争用保留共享请求预算，不允许经 activation 重试重新开启预算。提交回复保留并发 writer 续租取得的较晚期限。不可恢复的日志追加失败后停止后台 writer 保活；已知可回滚的非提交拒绝除外。不清除 authority 的写失败锁存。
2. 缺少接纳 epoch 不代表未接纳。只有仍持有效调度 claim 的 owner，在锁定 Session 与原 head，证明 writer 已 seal 或过期，且作用域匹配、未压缩的完整日志空闲后，才可取消不明确请求。是否已接受该 prompt 必须复用同一份经过 head 验证的扫描，使用 Session 自身协议并要求 cleanup 已确认，不另做快照读来决定。在同一事务撤销提交标记并取消。缺失、外来或不完整证据继续阻断；已接纳的原生输入不能走此捷径。
3. 对 Workspace 执行，在写公共恢复失败终态前，走取消接管并使用原 checkpoint/activation/prompt。Workspace 失败清理使用独立内部授权：必须匹配已接纳的具体 RUNNING Turn、有效 dispatch owner 和已记录的接纳 epoch，再核验原 Session 结构；不依赖公共取消命令，也不授予新的执行权限。普通取消仍要求已持久化的 CANCELLING 意图。Workspace 清理失败保持可重试。无 Workspace 的旧版 Session 在不支持接管时，保留尽力取消后写入失败终态的行为；这不构成原生清理或安全关闭的证明。恢复失败的终态写入是原子的，不能覆盖并发到达的用户取消。
4. `await_runtime` 中结果未知的快照可以尝试取消原 execution 身份。该能力不允许继续运行或重试执行。Runtime 取消仍须观察到终态结果，或保留既有 abandoned/unobserved 区分，才能写入结算。结果未知的 agent/command 等待仍不具备取消条件。
5. Harness 本地 Shell 发布器可能先于原 Worker 消失。只有明确的发布器连接拒绝才构成丢失证据；HTTP 拒绝、超时或格式错误的响应仍不确定。此后发布失败时，只有明确取消的前台 capture，同时具有自身真实的 aborted 进程结果、有效原始启动 PID，以及 POSIX 原进程组已消失的正向证据，才可保留 cancelled 结果。child-process API 在原 handle 上提供 PID，完成结果不含 PID；其他执行方式和显式结果 PID 必须匹配。已转后台、结果缺失、进程组仍活跃或权限拒绝，以及 Windows 均保持未知。finalize 丢失时，保留结果明确标记 capture unavailable、producer lost、无 manifest、delivery blocked；finalize 已完成而 accept 丢失时，保留原有效 manifest，仅将 delivery 标为 blocked。仅同一 sink 的原结果对象及同样的物理停止证据可获得本地四字段 ACK，克隆或伪造的 envelope 不能绕过原发布器；该 ACK 不声称持久化 native outcome，也不伪造 outcomeRef。成功执行或任意发布失败都不能变成已见证的取消。
6. 原 Broker 提供原生 blocked-cancellation 结果时，在解除恢复中的前台 Shell 等待前，由当前持有写权限的 writer 记录其回执。只读原 Broker 的已结算结果，不启动工作；验证原 checkpoint、intent、参数及 Runtime 调用映射，复用 Shell admission 的 manifest、流封存和摘要检查。Broker 按原 Harness Session、Runtime Session 和 execution 限定读取范围，以返回的 binding generation 为身份权威，不获取或比较替换后的 Runtime 租约。确定性 not-found、无 capture 的有效 legacy 结果，以及不属于 blocked-cancellation 族的原生结果，使用现有普通历史结果结算，不生成原生回执。旧 intent 属于 checkpoint 的 activation，不要求属于替换后的 writer；恢复检查持久化 seal，而非已消失 producer 的内存 prefix。已有回执和 manifest 保留原 outcome 引用。丢失 capture 时记录 blocked 回执，resultRef 为空且不关联产物资源；完整 capture 必须通过完整校验才可接纳。真实日志事务生成结果投影及其 sequence/revision。保持关闭校验不变：物理停止和普通历史结果不能替代该回执。

## 约束与风险

保留租户、actor、Workspace、调度 owner、writer 代际及 Runtime 身份检查。不削弱 `requireIdleJournal`，不凭 HTTP202、超时或租约过期认定已停止。永久不可达 Runtime 仍可能阻塞清理；重试必须保留不确定性。跨包 SDK、Harness 与 Java 消费者须一起验证。

## 验证与验收

- 分开保留失败基线测试和前次真实 Linux 证据。
- 覆盖 writer 与 activation 续租预算耗尽、原样重试、并发续租期限不回退、不可恢复追加后停止保活、可回滚拒绝、明确拒绝/过期、seal 竞态及健康频率不变。
- 覆盖有效/过期/sealed writer、已接纳原生输入、压缩/缺失 head、丢失调度 claim。
- 覆盖 parked 取消接管、瞬态清理拒绝、未知 Runtime 取得停止证据与仍未知两种结果、不重放 execute 及公共终态唯一。
- 验证不支持接管的旧版 Session 无论是否收到接纳回复，都进入失败终态；取消未收敛的 Workspace 则保留持有 claim 的重试，且不记录终态失败日志。
- 使用真实前台父子进程复现原发布器丢失；只有原进程组停止后才允许 cancelled 执行和 unavailable capture。验证精确 dispatch claim 授权、外来/过期/未接纳 claim 拒绝，以及用户取消赢得终态竞争。
- 验证恢复取消提交唯一原生回执，并在写入/解除等待之间崩溃后复用；保留完整 manifest，验证空流 seal，拒绝外来身份、损坏资源或已被 fencing 的 writer。确认真实日志投影使现有物理关闭检查正常完成。
- 构建、类型检查并测试受影响 TypeScript 消费者；运行 SDK/server 校验、独立 MySQL 和对应 Hosted 恢复 profile。
- 独立重复真实 Linux/MySQL Java/Harness 替换，核对原 Worker 身份、文件/marker 精确字节、取消/关闭及物理释放。保持原演示不动并恢复测试资源。
